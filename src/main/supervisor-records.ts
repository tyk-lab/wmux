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

export interface SupervisorAuditEvent {
  version: number;
  ts: number;
  type: string;
  terminal: SupervisorRecord['terminal'];
  payload: Record<string, unknown>;
}

export interface SupervisorHistory {
  sessionId: string | null;
  events: SupervisorAuditEvent[];
}

export interface SupervisorAuditSession {
  sessionId: string;
  createdAt: number;
  events: SupervisorAuditEvent[];
}

export interface SupervisorAuditTrail {
  sessions: SupervisorAuditSession[];
}

const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const IGNORE_ENTRY = '.wmux/supervisor/';
const MAX_HISTORY_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_EVENTS = 200;
const MAX_HISTORY_SESSIONS = 50;
const RESTORABLE_EVENT_TYPES = new Set(['worker.task', 'worker.lifecycle', 'supervisor.decision']);

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

function emptyHistory(): SupervisorHistory {
  return { sessionId: null, events: [] };
}

function emptyAuditTrail(): SupervisorAuditTrail {
  return { sessions: [] };
}

function readSessionCreatedAt(directory: string): number {
  const sessionPath = path.join(directory, 'session.json');
  try {
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as { createdAt?: unknown };
    if (typeof session.createdAt === 'number' && Number.isFinite(session.createdAt)) return session.createdAt;
  } catch {
    // Older or interrupted audit sessions may not have a readable manifest.
  }
  try {
    return fs.statSync(directory).mtimeMs;
  } catch {
    return 0;
  }
}

function readEvents(recordPath: string): SupervisorAuditEvent[] {
  try {
    if (fs.statSync(recordPath).size > MAX_HISTORY_FILE_BYTES) return [];
    return fs.readFileSync(recordPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line) as Partial<SupervisorAuditEvent>;
          if (
            typeof event.ts !== 'number'
            || typeof event.type !== 'string'
            || !event.terminal
            || typeof event.terminal.surfaceId !== 'string'
            || typeof event.terminal.label !== 'string'
            || !event.payload
            || typeof event.payload !== 'object'
          ) {
            return [];
          }
          return [event as SupervisorAuditEvent];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function readAuditSessions(projectDir: string): Array<SupervisorAuditSession & { directory: string }> {
  if (!path.isAbsolute(projectDir)) return [];
  const root = path.join(projectDir, '.wmux', 'supervisor');
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SESSION_ID.test(entry.name))
      .map((entry) => {
        const directory = path.join(root, entry.name);
        return {
          sessionId: entry.name,
          directory,
          createdAt: readSessionCreatedAt(directory),
          events: readEvents(path.join(directory, 'events.ndjson')),
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_HISTORY_SESSIONS);
  } catch {
    return [];
  }
}

/**
 * Return all durable audit sessions belonging to exactly one terminal task.
 * Unlike context recovery, reset tombstones remain visible here so users can
 * audit why a fresh session started. A label fallback is allowed only when it
 * maps to one historical surface, preserving terminal-context isolation.
 */
export function readSupervisorAuditTrail(
  projectDir: string,
  terminal: Pick<SupervisorRecord['terminal'], 'surfaceId' | 'label'>,
): SupervisorAuditTrail {
  if (!path.isAbsolute(projectDir) || !terminal.surfaceId || !terminal.label.trim()) return emptyAuditTrail();
  const sessions = readAuditSessions(projectDir);

  const exactSessions = sessions.map((session) => ({
    ...session,
    events: session.events.filter((event) => event.terminal.surfaceId === terminal.surfaceId),
  })).filter((session) => session.events.length > 0);
  if (exactSessions.length > 0) {
    return {
      sessions: exactSessions.map(({ sessionId, createdAt, events }) => ({
        sessionId,
        createdAt,
        events: events.slice(-MAX_HISTORY_EVENTS),
      })),
    };
  }

  const labelSessions = sessions.map((session) => ({
    ...session,
    events: session.events.filter((event) => event.terminal.label === terminal.label),
  })).filter((session) => session.events.length > 0);
  const historicalSurfaceIds = new Set(
    labelSessions.flatMap((session) => session.events.map((event) => event.terminal.surfaceId)),
  );
  if (historicalSurfaceIds.size !== 1) return emptyAuditTrail();

  return {
    sessions: labelSessions.map(({ sessionId, createdAt, events }) => ({
      sessionId,
      createdAt,
      events: events.slice(-MAX_HISTORY_EVENTS),
    })),
  };
}

/**
 * Return the latest usable audit stream for exactly one terminal task.
 * A `session.abandoned` entry is a reset tombstone: it deliberately prevents
 * an older context from being restored after the user chooses "start over".
 */
export function readLatestSupervisorHistory(
  projectDir: string,
  terminal: Pick<SupervisorRecord['terminal'], 'surfaceId' | 'label'>,
): SupervisorHistory {
  if (!path.isAbsolute(projectDir) || !terminal.surfaceId || !terminal.label.trim()) return emptyHistory();
  const sessionEvents = readAuditSessions(projectDir);
  if (sessionEvents.length === 0) return emptyHistory();

  for (const session of sessionEvents) {
    const matching = session.events.filter((event) => event.terminal.surfaceId === terminal.surfaceId);
    if (matching.length === 0) continue;
    if (matching.some((event) => event.type === 'session.abandoned')) return emptyHistory();
    if (!matching.some((event) => RESTORABLE_EVENT_TYPES.has(event.type))) continue;
    return { sessionId: session.sessionId, events: matching.slice(-MAX_HISTORY_EVENTS) };
  }

  const labelMatches = sessionEvents.map((session) => ({
    ...session,
    events: session.events.filter((event) =>
      event.terminal.label === terminal.label
      && (RESTORABLE_EVENT_TYPES.has(event.type) || event.type === 'session.abandoned'),
    ),
  }));

  // A restored terminal can receive a new surfaceId. Only fall back to its
  // display label when that label identifies one and only one historical
  // surface in this project; duplicate labels must never mix task contexts.
  const historicalSurfaceIds = new Set(
    labelMatches.flatMap((session) => session.events.map((event) => event.terminal.surfaceId)),
  );
  if (historicalSurfaceIds.size !== 1) return emptyHistory();
  const latest = labelMatches.find((session) => session.events.some((event) => RESTORABLE_EVENT_TYPES.has(event.type)));
  if (!latest || latest.events.some((event) => event.type === 'session.abandoned')) return emptyHistory();
  return { sessionId: latest.sessionId, events: latest.events.slice(-MAX_HISTORY_EVENTS) };
}
