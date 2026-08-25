import fs from 'fs';
import path from 'path';
import { getAppDataDir } from '../shared/instance';
import {
  CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
  normalizeProjectManagerSession,
  normalizeProjectTaskComplexityAssessment,
  normalizeProjectTaskContextResetState,
  projectDirectoryIdentity,
  normalizeProjectOrientationState,
  normalizeProjectProgressSnapshot,
  normalizeProjectProgressSyncState,
  type ProjectManagerSession,
} from '../shared/project-manager';

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
const CONTINUATION_BOUNDARIES = new Set([
  'project-owned-decision', 'external-prerequisite', 'high-risk-boundary',
]);

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
      'destructive-action', 'production-action', 'internal-project-failure',
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
    && isStringArray(goal.doneWhen)
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
    && Number.isFinite(subgoal.createdAt) && Number.isFinite(subgoal.updatedAt)
    && (subgoal.completion === undefined || isProjectCompletionResult(subgoal.completion));
}

function isProjectCompletionResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const completion = value as Record<string, unknown>;
  return typeof completion.summary === 'string' && completion.summary.trim().length > 0
    && isStringArray(completion.validation)
    && (completion.evidence === undefined || typeof completion.evidence === 'string')
    && Number.isFinite(completion.completedAt);
}

function isProjectSafeExitState(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  if (
    !['saving', 'blocked', 'saved', 'restoring'].includes(String(state.status))
    || !Number.isFinite(state.requestedAt)
    || !Number.isFinite(state.updatedAt)
    || (state.completedAt !== undefined && !Number.isFinite(state.completedAt))
    || typeof state.reason !== 'string'
    || (state.progressFingerprint !== undefined && typeof state.progressFingerprint !== 'string')
    || !Array.isArray(state.terminalCheckpoints)
    || state.terminalCheckpoints.length > 100
    || (state.blockedTerminalIds !== undefined && !isStringArray(state.blockedTerminalIds))
    || (state.error !== undefined && typeof state.error !== 'string')
  ) return false;
  return state.terminalCheckpoints.every((checkpoint) => {
    if (!checkpoint || typeof checkpoint !== 'object') return false;
    const item = checkpoint as Record<string, unknown>;
    return typeof item.surfaceId === 'string'
      && ['project-ai', 'supervisor-ai', 'task-ai', 'auxiliary-task-ai'].includes(String(item.role))
      && typeof item.label === 'string'
      && (item.workItemId === undefined || typeof item.workItemId === 'string')
      && ['idle', 'working', 'blocked', 'unknown'].includes(String(item.activityState))
      && (item.activityUpdatedAt === undefined || Number.isFinite(item.activityUpdatedAt))
      && (item.inputState === undefined || ['empty', 'pending', 'unknown'].includes(String(item.inputState)))
      && (item.excerpt === undefined || typeof item.excerpt === 'string');
  });
}

function isProjectAgentConfig(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const config = value as Record<string, unknown>;
  const selectionsValid = ['manager', 'supervisor', 'task', 'auxiliary'].every((role) => {
    const selection = config[role];
    return !!selection && typeof selection === 'object'
      && typeof (selection as Record<string, unknown>).agent === 'string'
      && typeof (selection as Record<string, unknown>).model === 'string'
      && typeof (selection as Record<string, unknown>).reasoningEffort === 'string';
  });
  const auxiliary = config.auxiliary as Record<string, unknown> | undefined;
  return selectionsValid
    && typeof auxiliary?.enabled === 'boolean'
    && typeof auxiliary?.allowProjectMaintenance === 'boolean';
}

function isProjectAgentIssue(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const issue = value as Record<string, unknown>;
  return ['manager', 'supervisor', 'task', 'auxiliary'].includes(String(issue.role))
    && ['rate-limit', 'quota-limit'].includes(String(issue.category))
    && typeof issue.summary === 'string'
    && Number.isFinite(issue.detectedAt);
}

function isProjectAgentReconfiguration(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  const rolesValid = (roles: unknown) => Array.isArray(roles)
    && roles.every((role) => ['manager', 'supervisor', 'task', 'auxiliary'].includes(String(role)));
  return ['applying', 'pending-safe-point', 'failed'].includes(String(state.status))
    && Number.isFinite(state.requestedAt)
    && rolesValid(state.roles)
    && rolesValid(state.pendingRoles)
    && rolesValid(state.completedRoles)
    && (state.error === undefined || typeof state.error === 'string');
}

function isProjectManagerSession(value: unknown): value is ProjectManagerSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  if (
    typeof session.id !== 'string' || !SESSION_ID.test(session.id)
    || session.executionProtocolVersion !== CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION
    || typeof session.projectDir !== 'string' || !path.isAbsolute(session.projectDir)
    || (session.projectName !== undefined && typeof session.projectName !== 'string')
    || (session.projectScope !== undefined && typeof session.projectScope !== 'string')
    || (session.activeGoalId !== undefined && typeof session.activeGoalId !== 'string')
    || (session.goals !== undefined && (!Array.isArray(session.goals) || !session.goals.every(isProjectGoal)))
    || (session.subgoals !== undefined && (!Array.isArray(session.subgoals) || !session.subgoals.every(isProjectSubgoal)))
    || typeof session.goal !== 'string' || !isStringArray(session.doneWhen)
    || (session.preconditions !== undefined && !isStringArray(session.preconditions))
    || (session.supervisorNotes !== undefined && !isStringArray(session.supervisorNotes))
    || (session.planFiles !== undefined && (!Array.isArray(session.planFiles) || session.planFiles.length > 3 || !session.planFiles.every(isPlanFileSnapshot)))
    || (session.pendingUserQuestion !== undefined && !isPendingUserQuestion(session.pendingUserQuestion))
    || (session.agentConfig !== undefined && !isProjectAgentConfig(session.agentConfig))
    || (session.agentIssue !== undefined && !isProjectAgentIssue(session.agentIssue))
    || (session.agentReconfiguration !== undefined && !isProjectAgentReconfiguration(session.agentReconfiguration))
    || (session.pendingManagerDeliveries !== undefined && (
      !Array.isArray(session.pendingManagerDeliveries)
      || session.pendingManagerDeliveries.length > 100
      || session.pendingManagerDeliveries.some((delivery) => (
        !delivery || typeof delivery !== 'object'
        || typeof delivery.id !== 'string'
        || typeof delivery.text !== 'string'
        || !Number.isFinite(delivery.createdAt)
        || (delivery.transitionId !== undefined && typeof delivery.transitionId !== 'string')
        || (delivery.continuationKey !== undefined && typeof delivery.continuationKey !== 'string')
        || (delivery.stage !== undefined
          && !['pending', 'submitting', 'submitted', 'failed'].includes(String(delivery.stage)))
        || (delivery.submittedAt !== undefined && !Number.isFinite(delivery.submittedAt))
      ))
    ))
    || (session.pendingSupervisorTransitions !== undefined && (
      !Array.isArray(session.pendingSupervisorTransitions)
      || session.pendingSupervisorTransitions.length > 50
      || session.pendingSupervisorTransitions.some((transition) => (
        !transition || typeof transition !== 'object'
        || typeof transition.id !== 'string'
        || typeof transition.laneId !== 'string'
        || (transition.workItemId !== undefined && typeof transition.workItemId !== 'string')
        || !['stage-complete', 'direction-needed', 'decision-required', 'supervisor-unavailable', 'supervisor-idle', 'project-action-required']
          .includes(String(transition.kind))
        || typeof transition.eventType !== 'string' || !transition.eventType.trim()
        || typeof transition.summary !== 'string' || !transition.summary.trim()
        || (transition.evidence !== undefined && typeof transition.evidence !== 'string')
        || (transition.contextSummary !== undefined && typeof transition.contextSummary !== 'string')
        || !Number.isFinite(transition.createdAt)
        || !Number.isFinite(transition.notifiedAt)
        || !Number.isFinite(transition.notificationCount)
      ))
    ))
    || (session.requirementsVersion !== undefined && (!Number.isFinite(session.requirementsVersion) || Number(session.requirementsVersion) < 1))
    || (session.authorizationVersion !== undefined && (!Number.isFinite(session.authorizationVersion) || Number(session.authorizationVersion) < 1))
    || (session.acceptedRequirementsVersion !== undefined && (!Number.isFinite(session.acceptedRequirementsVersion) || Number(session.acceptedRequirementsVersion) < 0))
    || (session.executionProtocolVersion !== undefined && (
      !Number.isInteger(session.executionProtocolVersion) || Number(session.executionProtocolVersion) < 0
    ))
    || (session.progressSnapshot !== undefined && !normalizeProjectProgressSnapshot(session.progressSnapshot))
    || (session.progressSync !== undefined && !normalizeProjectProgressSyncState(session.progressSync))
    || (session.orientation !== undefined && !normalizeProjectOrientationState(session.orientation))
    || (session.safeExit !== undefined && !isProjectSafeExitState(session.safeExit))
    || typeof session.status !== 'string' || !SESSION_STATUSES.has(session.status)
    || (session.pausedByPortfolio !== undefined && typeof session.pausedByPortfolio !== 'boolean')
    || (session.taskTerminalSurfaceId !== undefined && typeof session.taskTerminalSurfaceId !== 'string')
    || (session.activeWorkItemId !== undefined && typeof session.activeWorkItemId !== 'string')
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
    return typeof item.id === 'string'
      && item.predecessorWorkItemId === undefined
      && item.supersededByWorkItemId === undefined
      && item.successionReason === undefined
      && (item.goalId === undefined || typeof item.goalId === 'string')
      && (item.subgoalId === undefined || typeof item.subgoalId === 'string')
      && (item.requirementsVersion === undefined || (Number.isFinite(item.requirementsVersion) && item.requirementsVersion >= 1))
      && (item.authorizationVersion === undefined || (Number.isFinite(item.authorizationVersion) && item.authorizationVersion >= 1))
      && item.executionProtocolVersion === CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION
      && !!normalizeProjectTaskComplexityAssessment(item.complexityAssessment)
      && (item.contextReset === undefined || !!normalizeProjectTaskContextResetState(item.contextReset))
      && item.baseline === undefined
      && item.supervisorPlan === undefined
      && item.supervisorPlanRequired === false
      && item.decisionsUsed === 0
      && (item.completion === undefined || isProjectCompletionResult(item.completion))
      && typeof item.title === 'string'
      && typeof item.status === 'string' && WORK_ITEM_STATUSES.has(item.status)
      && isStringArray(item.dependencies)
      && Array.isArray(item.executionHistory)
      && Number.isFinite(item.attempts) && Number.isFinite(item.decisionsUsed) && Number.isFinite(item.updatedAt)
      && typeof contract?.objective === 'string' && typeof contract?.description === 'string'
      && isStringArray(contract?.preconditions) && isStringArray(contract?.stopWhen) && isStringArray(contract?.validation)
      && (contract?.supervisorNotes === undefined || isStringArray(contract.supervisorNotes))
      && typeof scope?.root === 'string' && path.isAbsolute(scope.root)
      && scope.root.toLowerCase() === String(session.projectDir).toLowerCase()
      && isStringArray(scope?.allowPaths) && isStringArray(scope?.denyPaths) && isStringArray(scope?.forbiddenActions)
      && ['technicalChoices', 'lowRiskRetries', 'targetedTests', 'internalThreads']
        .every((key) => typeof authority?.[key] === 'boolean')
      && (authority?.routeAdjustments === undefined || typeof authority.routeAdjustments === 'boolean')
      && (authority?.continuousExecution === undefined || typeof authority.continuousExecution === 'boolean')
      && (authority?.permissionConfirm === undefined || typeof authority.permissionConfirm === 'boolean')
      && (authority?.continuationBoundary === undefined
        || CONTINUATION_BOUNDARIES.has(String(authority.continuationBoundary)))
      && !(authority?.continuousExecution === false && authority.continuationBoundary === undefined)
      && !(authority?.continuousExecution === true && authority.continuationBoundary !== undefined)
      && (authority?.allowedCommandPrefixes === undefined || isStringArray(authority.allowedCommandPrefixes))
      && (authority?.authorizedDevices === undefined || isStringArray(authority.authorizedDevices))
      && (authority?.authorizedEnvironments === undefined || isStringArray(authority.authorizedEnvironments))
      && (authority?.authorizedOperations === undefined || isStringArray(authority.authorizedOperations))
      && ['maxDecisions', 'maxContinuousMinutes', 'maxIdenticalFailures', 'maxNoProgressRounds',
        'maxTaskRetries', 'maxSameTestRuns', 'maxFullSuiteRunsPerVersion']
        .every((key) => Number.isFinite(budget?.[key]) && budget[key] >= 1)
      && (budget?.maxAggregateWorkerMinutes === undefined
        || (Number.isFinite(budget.maxAggregateWorkerMinutes) && budget.maxAggregateWorkerMinutes >= 1))
      && contract?.execution === undefined;
  });
  if (!workItemsValid) return false;
  const workItemsById = new Map(session.workItems.map((item) => [item.id, item]));
  if (workItemsById.size !== session.workItems.length || session.workItems.some((item) => {
    const predecessor = item.predecessorWorkItemId
      ? workItemsById.get(item.predecessorWorkItemId)
      : undefined;
    const successor = item.supersededByWorkItemId
      ? workItemsById.get(item.supersededByWorkItemId)
      : undefined;
    return item.predecessorWorkItemId === item.id
      || item.supersededByWorkItemId === item.id
      || (!!item.successionReason !== !!item.predecessorWorkItemId)
      || (!!item.predecessorWorkItemId && !predecessor)
      || (!!predecessor && predecessor.supersededByWorkItemId !== item.id)
      || (!!item.supersededByWorkItemId && (
        !successor || successor.predecessorWorkItemId !== item.id
      ));
  })) return false;
  for (const item of session.workItems) {
    const visited = new Set<string>();
    let current: typeof item | undefined = item;
    while (current?.supersededByWorkItemId) {
      if (visited.has(current.id)) return false;
      visited.add(current.id);
      current = workItemsById.get(current.supersededByWorkItemId);
    }
  }
  const goals = Array.isArray(session.goals) ? session.goals as Array<Record<string, unknown>> : [];
  const subgoals = Array.isArray(session.subgoals) ? session.subgoals as Array<Record<string, unknown>> : [];
  if (goals.some((goal) => goal.status === 'completed' && (goal.doneWhen as unknown[]).length === 0)) {
    return false;
  }
  if (session.status === 'completed' && (session.doneWhen as unknown[]).length === 0) return false;
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
                supervisorNotes: parsed.session.supervisorNotes || [],
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
  const normalized = normalizeProjectManagerSession({
    ...session,
    executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
  });
  validateIdentity(normalized.id, normalized.projectDir);
  if (!isProjectManagerSession(normalized)) throw new Error('invalid project manager session payload');
  const duplicate = ['active', 'paused', 'waiting'].includes(normalized.status)
    ? readProjectManagerSessions(appDataDir).find((candidate) => (
        candidate.id !== normalized.id
        && projectDirectoryIdentity(candidate.projectDir) === projectDirectoryIdentity(normalized.projectDir)
        && ['active', 'paused', 'waiting'].includes(candidate.status)
      ))
    : undefined;
  if (duplicate) {
    throw new Error(`该目录已存在项目 AI：${duplicate.id}`);
  }
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
  const seenDirectories = new Set<string>();
  return readProjectManagerSessions(appDataDir)
    .filter((session) => ['active', 'paused', 'waiting'].includes(session.status))
    .filter((session) => {
      const identity = projectDirectoryIdentity(session.projectDir);
      if (seenDirectories.has(identity)) return false;
      seenDirectories.add(identity);
      return true;
    });
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
