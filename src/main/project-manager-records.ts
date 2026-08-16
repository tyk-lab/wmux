import fs from 'fs';
import path from 'path';
import { getAppDataDir } from '../shared/instance';
import {
  MAX_ACTIVE_PROJECTS,
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
const MAX_SESSION_FILES = 100;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
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

function isProjectManagerSession(value: unknown): value is ProjectManagerSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  if (
    typeof session.id !== 'string' || !SESSION_ID.test(session.id)
    || typeof session.projectDir !== 'string' || !path.isAbsolute(session.projectDir)
    || typeof session.goal !== 'string' || !isStringArray(session.doneWhen)
    || typeof session.status !== 'string' || !SESSION_STATUSES.has(session.status)
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
      .map((entry) => {
        try {
          const filePath = path.join(directory, entry.name);
          if (fs.statSync(filePath).size > MAX_RECORD_BYTES) return null;
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version?: unknown; session?: unknown };
          return parsed.version === 1 && isProjectManagerSession(parsed.session) ? parsed.session : null;
        } catch {
          return null;
        }
      })
      .filter((session): session is ProjectManagerSession => !!session)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSION_FILES);
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
    .filter((session) => ['active', 'paused', 'waiting'].includes(session.status))
    .slice(0, MAX_ACTIVE_PROJECTS);
}
