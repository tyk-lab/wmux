import fs from 'fs';
import path from 'path';
import { getAppDataDir } from '../shared/instance';
import {
  normalizeProjectManagerSession,
  type ProjectManagerSession,
} from '../shared/project-manager';
import {
  MAX_TASK_CHILD_THREADS,
  MAX_TASK_OPERATION_BOUNDARIES,
} from '../shared/supervisor-work-mode';

export interface ProjectManagerRecord {
  sessionId: string;
  projectDir: string;
  type: string;
  payload?: Record<string, unknown>;
  ts?: number;
}

const SESSION_ID = /^pm-[A-Za-z0-9_-]+$/;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
// Three 1 MB text snapshots can expand under JSON escaping; leave bounded room
// for work items and the 500-entry decision timeline without breaking recovery.
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const SESSION_STATUSES = new Set(['active', 'paused', 'waiting', 'completed', 'stopped']);
const WORK_ITEM_STATUSES = new Set([
  'planned', 'waiting-dependencies', 'running', 'validating', 'waiting-decision',
  'paused', 'completed', 'failed', 'stopped',
]);
const GOAL_STATUSES = new Set(['transitioning', 'active', 'achieved', 'superseded', 'abandoned']);
const SUBGOAL_STATUSES = new Set(['planned', 'active', 'blocked', 'achieved', 'obsolete']);

function recordsDirectory(appDataDir = getAppDataDir()): string {
  return path.join(appDataDir, 'project-manager');
}

function validateIdentity(sessionId: string, projectDir: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid project manager session id');
  if (!path.isAbsolute(projectDir)) throw new Error('projectDir must be absolute');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isProjectTaskExecutionPlan(value: unknown, internalThreads: boolean): boolean {
  if (!value || typeof value !== 'object') return false;
  const execution = value as Record<string, unknown>;
  const mode = String(execution.taskWorkMode);
  if (
    !['single-thread', 'multi-thread', 'adaptive'].includes(mode)
    || typeof execution.modeReason !== 'string'
    || execution.modeReason.trim().length === 0
    || typeof execution.mainThreadResponsibility !== 'string'
    || execution.mainThreadResponsibility.trim().length === 0
    || !isStringArray(execution.childThreadResponsibilities)
    || execution.childThreadResponsibilities.length > MAX_TASK_CHILD_THREADS
  ) return false;
  if (mode !== 'single-thread' && !internalThreads) return false;
  const maxChildThreads = execution.maxChildThreads;
  if (maxChildThreads !== undefined && (
    typeof maxChildThreads !== 'number'
    || !Number.isInteger(maxChildThreads)
    || maxChildThreads < 1
    || maxChildThreads > MAX_TASK_CHILD_THREADS
  )) return false;
  if (execution.supervisorMayApproveThreads !== undefined
    && typeof execution.supervisorMayApproveThreads !== 'boolean') return false;
  if (execution.parallelizableOperations !== undefined
    && (!isStringArray(execution.parallelizableOperations)
      || execution.parallelizableOperations.length > MAX_TASK_OPERATION_BOUNDARIES)) return false;
  if (execution.serializedOperations !== undefined
    && (!isStringArray(execution.serializedOperations)
      || execution.serializedOperations.length > MAX_TASK_OPERATION_BOUNDARIES)) return false;
  return mode !== 'adaptive' || (
    typeof maxChildThreads === 'number'
    && Number.isInteger(maxChildThreads)
    && execution.supervisorMayApproveThreads === true
    && isStringArray(execution.parallelizableOperations)
    && execution.parallelizableOperations.length > 0
    && isStringArray(execution.serializedOperations)
    && execution.serializedOperations.length > 0
    && execution.childThreadResponsibilities.length === 0
  );
}

function isPlanFileSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  return typeof file.path === 'string' && path.isAbsolute(file.path)
    && typeof file.name === 'string'
    && typeof file.content === 'string'
    && Buffer.byteLength(file.content, 'utf8') <= 1024 * 1024
    && Number.isFinite(file.sizeBytes) && Number(file.sizeBytes) >= 0 && Number(file.sizeBytes) <= 1024 * 1024
    && Number.isFinite(file.mtimeMs) && Number.isFinite(file.capturedAt);
}

function isPendingUserQuestion(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const question = value as Record<string, unknown>;
  const options = question.options;
  return typeof question.id === 'string'
    && (question.category === undefined || ['clarification', 'manual-intervention'].includes(String(question.category)))
    && (question.workItemId === undefined || typeof question.workItemId === 'string')
    && (question.blocker === undefined || typeof question.blocker === 'string')
    && (question.reasonCode === undefined || [
      'physical-action', 'credentials', 'access-grant', 'business-choice',
      'destructive-action', 'production-action',
    ].includes(String(question.reasonCode)))
    && typeof question.question === 'string'
    && typeof question.context === 'string'
    && typeof question.previousStatus === 'string' && SESSION_STATUSES.has(question.previousStatus)
    && Number.isFinite(question.createdAt)
    && Array.isArray(options) && options.length >= 2 && options.length <= 4
    && options.every((option) => {
      if (!option || typeof option !== 'object') return false;
      const candidate = option as Record<string, unknown>;
      return typeof candidate.id === 'string' && typeof candidate.label === 'string'
        && (candidate.description === undefined || typeof candidate.description === 'string');
    })
    && (question.recommendedOptionId === undefined || typeof question.recommendedOptionId === 'string');
}

function isProjectGoal(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const goal = value as Record<string, unknown>;
  return typeof goal.id === 'string' && goal.id.length > 0
    && Number.isInteger(goal.sequence) && Number(goal.sequence) >= 1
    && typeof goal.statement === 'string' && goal.statement.trim().length > 0
    && isStringArray(goal.doneWhen) && goal.doneWhen.length > 0
    && typeof goal.status === 'string' && GOAL_STATUSES.has(goal.status)
    && Number.isFinite(goal.requirementsVersion) && Number(goal.requirementsVersion) >= 1
    && (goal.supersedesGoalId === undefined || typeof goal.supersedesGoalId === 'string')
    && (goal.changeReason === undefined || typeof goal.changeReason === 'string')
    && Number.isFinite(goal.createdAt)
    && (goal.activatedAt === undefined || Number.isFinite(goal.activatedAt))
    && (goal.closedAt === undefined || Number.isFinite(goal.closedAt));
}

function isProjectSubgoal(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const subgoal = value as Record<string, unknown>;
  return typeof subgoal.id === 'string' && subgoal.id.length > 0
    && typeof subgoal.goalId === 'string' && subgoal.goalId.length > 0
    && typeof subgoal.title === 'string' && subgoal.title.trim().length > 0
    && typeof subgoal.outcome === 'string' && subgoal.outcome.trim().length > 0
    && isStringArray(subgoal.acceptance) && subgoal.acceptance.length > 0
    && isStringArray(subgoal.dependencies)
    && typeof subgoal.status === 'string' && SUBGOAL_STATUSES.has(subgoal.status)
    && Number.isInteger(subgoal.order) && Number(subgoal.order) >= 1
    && Number.isFinite(subgoal.createdAt) && Number.isFinite(subgoal.updatedAt);
}

function isProjectManagerSession(value: unknown): value is ProjectManagerSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  if (
    typeof session.id !== 'string' || !SESSION_ID.test(session.id)
    || typeof session.projectDir !== 'string' || !path.isAbsolute(session.projectDir)
    || (session.projectName !== undefined && typeof session.projectName !== 'string')
    || (session.projectScope !== undefined && typeof session.projectScope !== 'string')
    || (session.activeGoalId !== undefined && typeof session.activeGoalId !== 'string')
    || (session.goals !== undefined && (!Array.isArray(session.goals) || !session.goals.every(isProjectGoal)))
    || (session.subgoals !== undefined && (!Array.isArray(session.subgoals) || !session.subgoals.every(isProjectSubgoal)))
    || typeof session.goal !== 'string' || !isStringArray(session.doneWhen)
    || (session.preconditions !== undefined && !isStringArray(session.preconditions))
    || (session.planFiles !== undefined && (!Array.isArray(session.planFiles) || session.planFiles.length > 3 || !session.planFiles.every(isPlanFileSnapshot)))
    || (session.pendingUserQuestion !== undefined && !isPendingUserQuestion(session.pendingUserQuestion))
    || (session.pendingManagerDeliveries !== undefined && (
      !Array.isArray(session.pendingManagerDeliveries)
      || session.pendingManagerDeliveries.length > 100
      || session.pendingManagerDeliveries.some((delivery) => (
        !delivery || typeof delivery !== 'object'
        || typeof delivery.id !== 'string'
        || typeof delivery.text !== 'string'
        || !Number.isFinite(delivery.createdAt)
      ))
    ))
    || (session.requirementsVersion !== undefined && (!Number.isFinite(session.requirementsVersion) || Number(session.requirementsVersion) < 1))
    || (session.authorizationVersion !== undefined && (!Number.isFinite(session.authorizationVersion) || Number(session.authorizationVersion) < 1))
    || (session.acceptedRequirementsVersion !== undefined && (!Number.isFinite(session.acceptedRequirementsVersion) || Number(session.acceptedRequirementsVersion) < 0))
    || typeof session.status !== 'string' || !SESSION_STATUSES.has(session.status)
    || (session.pausedByPortfolio !== undefined && typeof session.pausedByPortfolio !== 'boolean')
    || (session.taskTerminalSurfaceId !== undefined && typeof session.taskTerminalSurfaceId !== 'string')
    || !Array.isArray(session.workItems) || !Array.isArray(session.events)
    || !Number.isFinite(session.createdAt) || !Number.isFinite(session.updatedAt)
  ) return false;
  const workItemsValid = session.workItems.every((value) => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, any>;
    const contract = item.contract;
    const scope = contract?.scope;
    const authority = contract?.authority;
    const budget = contract?.budget;
    const execution = contract?.execution;
    return typeof item.id === 'string'
      && (item.goalId === undefined || typeof item.goalId === 'string')
      && (item.subgoalId === undefined || typeof item.subgoalId === 'string')
      && (item.requirementsVersion === undefined || (Number.isFinite(item.requirementsVersion) && item.requirementsVersion >= 1))
      && (item.authorizationVersion === undefined || (Number.isFinite(item.authorizationVersion) && item.authorizationVersion >= 1))
      && typeof item.title === 'string'
      && typeof item.status === 'string' && WORK_ITEM_STATUSES.has(item.status)
      && isStringArray(item.dependencies)
      && Array.isArray(item.executionHistory)
      && Number.isFinite(item.attempts) && Number.isFinite(item.decisionsUsed) && Number.isFinite(item.updatedAt)
      && typeof contract?.objective === 'string' && typeof contract?.description === 'string'
      && isStringArray(contract?.preconditions) && isStringArray(contract?.stopWhen) && isStringArray(contract?.validation)
      && typeof scope?.root === 'string' && path.isAbsolute(scope.root)
      && scope.root.toLowerCase() === String(session.projectDir).toLowerCase()
      && isStringArray(scope?.allowPaths) && isStringArray(scope?.denyPaths) && isStringArray(scope?.forbiddenActions)
      && ['technicalChoices', 'lowRiskRetries', 'targetedTests', 'internalThreads']
        .every((key) => typeof authority?.[key] === 'boolean')
      && ['maxDecisions', 'maxContinuousMinutes', 'maxIdenticalFailures', 'maxNoProgressRounds',
        'maxTaskRetries', 'maxSameTestRuns', 'maxFullSuiteRunsPerVersion']
        .every((key) => Number.isFinite(budget?.[key]) && budget[key] >= 1)
      && (!execution || isProjectTaskExecutionPlan(execution, authority?.internalThreads === true));
  });
  if (!workItemsValid) return false;
  const goals = Array.isArray(session.goals) ? session.goals as Array<Record<string, unknown>> : [];
  const subgoals = Array.isArray(session.subgoals) ? session.subgoals as Array<Record<string, unknown>> : [];
  if (goals.length === 0) return session.activeGoalId === undefined && subgoals.length === 0;
  const goalIds = new Set(goals.map((goal) => String(goal.id)));
  const goalSequences = new Set(goals.map((goal) => Number(goal.sequence)));
  if (goalIds.size !== goals.length || goalSequences.size !== goals.length || !goalIds.has(String(session.activeGoalId))) {
    return false;
  }
  const openGoals = goals.filter((goal) => ['active', 'transitioning'].includes(String(goal.status)));
  if (openGoals.length > 1 || (openGoals.length === 1 && String(openGoals[0].id) !== String(session.activeGoalId))) {
    return false;
  }
  const subgoalKey = (goalId: unknown, subgoalId: unknown) => `${String(goalId)}\u0000${String(subgoalId)}`;
  const subgoalKeys = new Set(subgoals.map((subgoal) => subgoalKey(subgoal.goalId, subgoal.id)));
  if (subgoalKeys.size !== subgoals.length || subgoals.some((subgoal) => (
    !goalIds.has(String(subgoal.goalId))
    || (subgoal.dependencies as unknown[]).some((dependency) => (
      !subgoalKeys.has(subgoalKey(subgoal.goalId, dependency))
    ))
  ))) return false;
  const dependenciesBySubgoal = new Map(subgoals.map((subgoal) => [
    subgoalKey(subgoal.goalId, subgoal.id),
    (subgoal.dependencies as unknown[]).map((dependency) => subgoalKey(subgoal.goalId, dependency)),
  ]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dependencyGraphIsAcyclic = (subgoalId: string): boolean => {
    if (visited.has(subgoalId)) return true;
    if (visiting.has(subgoalId)) return false;
    visiting.add(subgoalId);
    for (const dependencyId of dependenciesBySubgoal.get(subgoalId) || []) {
      if (!dependencyGraphIsAcyclic(dependencyId)) return false;
    }
    visiting.delete(subgoalId);
    visited.add(subgoalId);
    return true;
  };
  if ([...subgoalKeys].some((subgoalId) => !dependencyGraphIsAcyclic(subgoalId))) return false;
  return session.workItems.every((rawItem) => {
    const item = rawItem as Record<string, unknown>;
    if (item.goalId === undefined && item.subgoalId === undefined) return true;
    if (!goalIds.has(String(item.goalId))) return false;
    if (item.subgoalId === undefined) return true;
    return subgoalKeys.has(subgoalKey(item.goalId, item.subgoalId));
  });
}

function readProjectManagerSessions(
  appDataDir = getAppDataDir(),
): ProjectManagerSession[] {
  const directory = recordsDirectory(appDataDir);
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_ID.test(path.basename(entry.name, '.json')) && entry.name.endsWith('.json'))
      .map<ProjectManagerSession | null>((entry) => {
        try {
          const filePath = path.join(directory, entry.name);
          if (fs.statSync(filePath).size > MAX_SESSION_BYTES) return null;
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version?: unknown; session?: unknown };
          return parsed.version === 1 && isProjectManagerSession(parsed.session)
            ? normalizeProjectManagerSession({
                ...parsed.session,
                preconditions: parsed.session.preconditions || [],
                planFiles: parsed.session.planFiles || [],
                pendingManagerDeliveries: parsed.session.pendingManagerDeliveries || [],
                requirementsVersion: parsed.session.requirementsVersion || 1,
                acceptedRequirementsVersion: parsed.session.acceptedRequirementsVersion ?? 0,
              } satisfies ProjectManagerSession)
            : null;
        } catch {
          return null;
        }
      })
      .filter((session): session is ProjectManagerSession => !!session)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveProjectManagerSession(
  session: ProjectManagerSession,
  appDataDir = getAppDataDir(),
): { path: string } {
  const normalized = normalizeProjectManagerSession(session);
  validateIdentity(normalized.id, normalized.projectDir);
  if (!isProjectManagerSession(normalized)) throw new Error('invalid project manager session payload');
  const directory = recordsDirectory(appDataDir);
  fs.mkdirSync(directory, { recursive: true });
  const sessionPath = path.join(directory, `${session.id}.json`);
  const temporaryPath = path.join(directory, `${session.id}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, session: normalized }, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temporaryPath, sessionPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') throw error;
    fs.rmSync(sessionPath, { force: true });
    fs.renameSync(temporaryPath, sessionPath);
  }
  return { path: sessionPath };
}

export function deleteProjectManagerSession(
  sessionId: string,
  appDataDir = getAppDataDir(),
): { deleted: boolean } {
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid project manager session id');
  const directory = recordsDirectory(appDataDir);
  let deleted = false;
  // Keep the restorable snapshot until last so an audit-file failure cannot
  // leave the UI session alive while its durable project state is already gone.
  for (const extension of ['.ndjson', '.json']) {
    const filePath = path.join(directory, `${sessionId}${extension}`);
    try {
      fs.unlinkSync(filePath);
      deleted = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { deleted };
}

export function appendProjectManagerRecord(
  record: ProjectManagerRecord,
  appDataDir = getAppDataDir(),
): { path: string } {
  validateIdentity(record.sessionId, record.projectDir);
  const directory = recordsDirectory(appDataDir);
  fs.mkdirSync(directory, { recursive: true });
  const recordPath = path.join(directory, `${record.sessionId}.ndjson`);
  try {
    if (fs.statSync(recordPath).size >= MAX_RECORD_BYTES) {
      throw new Error('project manager audit log reached its size limit');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fs.appendFileSync(recordPath, `${JSON.stringify({
    version: 1,
    ts: record.ts ?? Date.now(),
    type: record.type,
    projectDir: record.projectDir,
    payload: record.payload || {},
  })}\n`, 'utf8');
  return { path: recordPath };
}

export function readActiveProjectManagerSessions(
  appDataDir = getAppDataDir(),
): ProjectManagerSession[] {
  return readProjectManagerSessions(appDataDir)
    .filter((session) => ['active', 'paused', 'waiting'].includes(session.status));
}

/** Native Agent conversations are restart-unsafe even after their project was completed or stopped. */
export function readProjectManagerRuntimeSurfaceIds(
  appDataDir = getAppDataDir(),
): string[] {
  return [...new Set(readProjectManagerSessions(appDataDir).flatMap((session) => [
    session.taskTerminalSurfaceId,
    ...session.workItems.map((item) => item.workerSurfaceId),
  ]).filter((surfaceId): surfaceId is string => !!surfaceId))];
}
