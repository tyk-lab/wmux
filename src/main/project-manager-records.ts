import fs from 'fs';
import path from 'path';
import { getAppDataDir } from '../shared/instance';
import {
  normalizedProjectDirectoryKey,
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

function isProjectManagerSession(value: unknown): value is ProjectManagerSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  if (
    typeof session.id !== 'string' || !SESSION_ID.test(session.id)
    || typeof session.projectDir !== 'string' || !path.isAbsolute(session.projectDir)
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
    || (session.acceptedRequirementsVersion !== undefined && (!Number.isFinite(session.acceptedRequirementsVersion) || Number(session.acceptedRequirementsVersion) < 0))
    || typeof session.status !== 'string' || !SESSION_STATUSES.has(session.status)
    || (session.pausedByPortfolio !== undefined && typeof session.pausedByPortfolio !== 'boolean')
    || (session.taskTerminalSurfaceId !== undefined && typeof session.taskTerminalSurfaceId !== 'string')
    || !Array.isArray(session.workItems) || !Array.isArray(session.events)
    || !Number.isFinite(session.createdAt) || !Number.isFinite(session.updatedAt)
  ) return false;
  return session.workItems.every((value) => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, any>;
    const contract = item.contract;
    const scope = contract?.scope;
    const authority = contract?.authority;
    const budget = contract?.budget;
    const execution = contract?.execution;
    return typeof item.id === 'string'
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
      && (!execution || (
        ['single-thread', 'multi-thread'].includes(String(execution.taskWorkMode))
        && typeof execution.modeReason === 'string'
        && typeof execution.mainThreadResponsibility === 'string'
        && isStringArray(execution.childThreadResponsibilities)
      ));
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
            ? {
                ...parsed.session,
                preconditions: parsed.session.preconditions || [],
                planFiles: parsed.session.planFiles || [],
                pendingManagerDeliveries: parsed.session.pendingManagerDeliveries || [],
                requirementsVersion: parsed.session.requirementsVersion || 1,
                acceptedRequirementsVersion: parsed.session.acceptedRequirementsVersion ?? 0,
              } satisfies ProjectManagerSession
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
  validateIdentity(session.id, session.projectDir);
  const directory = recordsDirectory(appDataDir);
  fs.mkdirSync(directory, { recursive: true });
  const sessionPath = path.join(directory, `${session.id}.json`);
  const temporaryPath = path.join(directory, `${session.id}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, session }, null, 2)}\n`, 'utf8');
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

export function readLatestProjectManagerSession(
  projectDir: string,
  appDataDir = getAppDataDir(),
): ProjectManagerSession | null {
  if (!path.isAbsolute(projectDir)) return null;
  const projectKey = normalizedProjectDirectoryKey(projectDir);
  return readProjectManagerSessions(appDataDir)
    .find((session) => normalizedProjectDirectoryKey(session.projectDir) === projectKey) || null;
}

export function readActiveProjectManagerSessions(
  appDataDir = getAppDataDir(),
): ProjectManagerSession[] {
  const directories = new Set<string>();
  return readProjectManagerSessions(appDataDir)
    .filter((session) => {
      const key = normalizedProjectDirectoryKey(session.projectDir);
      if (!key || directories.has(key)) return false;
      directories.add(key);
      return true;
    })
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
