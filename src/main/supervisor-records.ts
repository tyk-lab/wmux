import fs from 'fs';
import path from 'path';

export interface SupervisorRecord {
  sessionId: string;
  projectDir: string;
  type: string;
  terminal: {
    surfaceId: string;
    paneId?: string;
    workspaceId?: string;
    workspaceTitle?: string;
    label: string;
  };
  payload?: Record<string, unknown>;
  ts?: number;
}

const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const IGNORE_ENTRY = '.wmux/supervisor/';

function ensureGitIgnore(projectDir: string): void {
  const gitIgnorePath = path.join(projectDir, '.gitignore');
  const current = fs.existsSync(gitIgnorePath) ? fs.readFileSync(gitIgnorePath, 'utf8') : '';
  if (current.split(/\r?\n/).some((line) => line.trim() === IGNORE_ENTRY)) return;

  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitIgnorePath, `${current}${prefix}${IGNORE_ENTRY}\n`, 'utf8');
}

/** Append a compact, line-delimited audit entry to the monitored project. */
export function appendSupervisorRecord(record: SupervisorRecord): { path: string } {
  if (!path.isAbsolute(record.projectDir)) throw new Error('projectDir must be absolute');
  if (!SESSION_ID.test(record.sessionId)) throw new Error('invalid supervisor session id');
  if (!record.terminal.surfaceId) throw new Error('surfaceId is required');

  ensureGitIgnore(record.projectDir);
  const directory = path.join(record.projectDir, '.wmux', 'supervisor', record.sessionId);
  fs.mkdirSync(directory, { recursive: true });

  const sessionPath = path.join(directory, 'session.json');
  if (!fs.existsSync(sessionPath)) {
    fs.writeFileSync(sessionPath, JSON.stringify({
      version: 1,
      sessionId: record.sessionId,
      projectDir: record.projectDir,
      createdAt: record.ts ?? Date.now(),
    }, null, 2) + '\n', 'utf8');
  }

  const event = {
    version: 1,
    ts: record.ts ?? Date.now(),
    type: record.type,
    terminal: record.terminal,
    payload: record.payload ?? {},
  };
  const recordPath = path.join(directory, 'events.ndjson');
  fs.appendFileSync(recordPath, `${JSON.stringify(event)}\n`, 'utf8');
  return { path: recordPath };
}
