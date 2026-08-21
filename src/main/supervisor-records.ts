import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
  SUPERVISOR_EVIDENCE_MAX_CHARS,
  supervisorEvidencePage,
  supervisorEvidenceSuggestedRanges,
  type SupervisorEvidenceFileReference,
  type SupervisorEvidencePage,
  type SupervisorEvidenceSnapshot,
} from '../shared/supervisor-evidence';
import { isTerminalInputIsolationScope, type TerminalInputIsolationScope } from '../shared/types';

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

export interface SupervisorRestoreCandidate {
  surfaceId: string;
  label: string;
  sessionId: string;
  lastEventAt: number;
  currentTask: string;
  lastDecision: string;
}

const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const REVIEW_ID = /^[A-Za-z0-9_-]{1,200}$/;
const IGNORE_ENTRIES = ['.wmux/supervisor/', '.wmux/tmp/'] as const;
const MAX_HISTORY_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_EVENTS = 200;
const MAX_HISTORY_SESSIONS = 50;
const MAX_EVIDENCE_FILES_PER_SCOPE = 50;
const RESTORABLE_EVENT_TYPES = new Set(['worker.task', 'worker.lifecycle', 'supervisor.decision']);

function supervisorSessionDirectory(projectDir: string, sessionId: string, create = false): string {
  if (!path.isAbsolute(projectDir)) throw new Error('projectDir must be absolute');
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid supervisor session id');
  const realProjectDir = fs.realpathSync(projectDir);
  const directory = path.join(realProjectDir, '.wmux', 'supervisor', sessionId);
  if (create) fs.mkdirSync(directory, { recursive: true });
  const realDirectory = fs.realpathSync(directory);
  const relative = path.relative(realProjectDir, realDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('supervisor directory must stay inside the project');
  }
  return realDirectory;
}

function supervisorEvidenceDirectory(
  projectDir: string,
  sessionId: string,
  isolationScope: TerminalInputIsolationScope,
  create = false,
): string {
  if (!isTerminalInputIsolationScope(isolationScope)) {
    throw new Error('invalid supervisor evidence isolation scope');
  }
  const sessionDirectory = supervisorSessionDirectory(projectDir, sessionId, create);
  const evidenceDirectory = path.join(sessionDirectory, 'evidence', isolationScope);
  if (create) fs.mkdirSync(evidenceDirectory, { recursive: true });
  const realEvidenceDirectory = fs.realpathSync(evidenceDirectory);
  const relative = path.relative(sessionDirectory, realEvidenceDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('supervisor evidence directory must stay inside its session');
  }
  return realEvidenceDirectory;
}

function pruneSupervisorEvidence(evidenceDirectory: string): void {
  try {
    const entries = fs.readdirSync(evidenceDirectory, { withFileTypes: true });
    const files = entries
      .filter((entry) => (
        entry.isFile()
        && entry.name.endsWith('.json')
        && REVIEW_ID.test(entry.name.replace(/\.json$/u, ''))
      ))
      .map((entry) => {
        const filePath = path.join(evidenceDirectory, entry.name);
        return {
          filePath,
          reviewId: entry.name.replace(/\.json$/u, ''),
          mtimeMs: fs.statSync(filePath).mtimeMs,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const retainedReviewIds = new Set(
      files.slice(0, MAX_EVIDENCE_FILES_PER_SCOPE).map((file) => file.reviewId),
    );
    for (const stale of files.slice(MAX_EVIDENCE_FILES_PER_SCOPE)) {
      try { fs.unlinkSync(stale.filePath); } catch { /* Best-effort retention cleanup. */ }
    }
    for (const entry of entries) {
      const match = /^([A-Za-z0-9_-]{1,200})\.[a-f0-9]{16}\.txt$/u.exec(entry.name);
      if (!entry.isFile() || !match || retainedReviewIds.has(match[1])) continue;
      try { fs.unlinkSync(path.join(evidenceDirectory, entry.name)); } catch { /* Best effort. */ }
    }
  } catch {
    // Evidence persistence already succeeded; retention failure must not drop the review event.
  }
}

export function saveSupervisorEvidence(options: {
  projectDir: string;
  snapshot: SupervisorEvidenceSnapshot;
}): { path: string } {
  const { projectDir, snapshot } = options;
  if (!REVIEW_ID.test(snapshot.reviewId)) throw new Error('invalid supervisor review id');
  if (!isTerminalInputIsolationScope(snapshot.isolationScope)) {
    throw new Error('invalid supervisor evidence isolation scope');
  }
  if (!snapshot.surfaceId || !snapshot.laneId) throw new Error('evidence terminal binding is required');
  if (snapshot.version !== 1) throw new Error('unsupported supervisor evidence version');
  if (snapshot.text.length > SUPERVISOR_EVIDENCE_MAX_CHARS + 100) {
    throw new Error('supervisor evidence is too large');
  }
  const evidenceDirectory = supervisorEvidenceDirectory(
    projectDir,
    snapshot.sessionId,
    snapshot.isolationScope,
    true,
  );
  const evidencePath = path.join(evidenceDirectory, `${snapshot.reviewId}.json`);
  const serialized = `${JSON.stringify(snapshot)}\n`;
  try {
    fs.writeFileSync(evidencePath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  pruneSupervisorEvidence(evidenceDirectory);
  return { path: evidencePath };
}

export function readSupervisorEvidence(options: {
  projectDir: string;
  sessionId: string;
  reviewId: string;
  surfaceId: string;
  isolationScope: TerminalInputIsolationScope;
  page?: number;
  pageLines?: number;
}): SupervisorEvidencePage | { ok: false; error: string } {
  const loaded = loadSupervisorEvidence(options);
  if (loaded.ok === false) return loaded;
  return supervisorEvidencePage(loaded.snapshot, options.page, options.pageLines);
}

function loadSupervisorEvidence(options: {
  projectDir: string;
  sessionId: string;
  reviewId: string;
  surfaceId: string;
  isolationScope: TerminalInputIsolationScope;
}): {
  ok: true;
  snapshot: SupervisorEvidenceSnapshot;
  evidenceDirectory: string;
} | { ok: false; error: string } {
  if (!REVIEW_ID.test(options.reviewId)) return { ok: false, error: 'invalid supervisor review id' };
  if (!options.surfaceId) return { ok: false, error: 'surfaceId is required' };
  let evidencePath: string;
  let evidenceDirectory: string;
  try {
    evidenceDirectory = supervisorEvidenceDirectory(
      options.projectDir,
      options.sessionId,
      options.isolationScope,
    );
    evidencePath = path.join(evidenceDirectory, `${options.reviewId}.json`);
    const stat = fs.lstatSync(evidencePath);
    const realEvidencePath = fs.realpathSync(evidencePath);
    const relative = path.relative(evidenceDirectory, realEvidencePath);
    if (!stat.isFile() || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, error: 'supervisor evidence not found' };
    }
    evidencePath = realEvidencePath;
    if (stat.size > SUPERVISOR_EVIDENCE_MAX_CHARS + 64_000) {
      return { ok: false, error: 'supervisor evidence file is too large' };
    }
  } catch {
    return { ok: false, error: 'supervisor evidence not found' };
  }
  try {
    const snapshot = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as SupervisorEvidenceSnapshot;
    if (
      snapshot.version !== 1
      || snapshot.sessionId !== options.sessionId
      || snapshot.reviewId !== options.reviewId
      || snapshot.surfaceId !== options.surfaceId
      || snapshot.isolationScope !== options.isolationScope
      || typeof snapshot.text !== 'string'
    ) {
      return { ok: false, error: 'supervisor evidence binding mismatch' };
    }
    return { ok: true, snapshot, evidenceDirectory };
  } catch {
    return { ok: false, error: 'supervisor evidence is unreadable' };
  }
}

export function readSupervisorEvidenceFile(options: {
  projectDir: string;
  sessionId: string;
  reviewId: string;
  surfaceId: string;
  isolationScope: TerminalInputIsolationScope;
}): SupervisorEvidenceFileReference | { ok: false; error: string } {
  const loaded = loadSupervisorEvidence(options);
  if (loaded.ok === false) return loaded;
  const content = loaded.snapshot.text.endsWith('\n')
    ? loaded.snapshot.text
    : `${loaded.snapshot.text}\n`;
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const evidencePath = path.join(
    loaded.evidenceDirectory,
    `${options.reviewId}.${sha256.slice(0, 16)}.txt`,
  );
  try {
    if (!fs.existsSync(evidencePath)) {
      fs.writeFileSync(evidencePath, content, { encoding: 'utf8', flag: 'wx', mode: 0o400 });
      fs.chmodSync(evidencePath, 0o400);
    }
    const stat = fs.lstatSync(evidencePath);
    const realEvidencePath = fs.realpathSync(evidencePath);
    const relative = path.relative(loaded.evidenceDirectory, realEvidencePath);
    if (!stat.isFile() || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, error: 'supervisor evidence text file is unsafe' };
    }
    if (createHash('sha256').update(fs.readFileSync(realEvidencePath)).digest('hex') !== sha256) {
      return { ok: false, error: 'supervisor evidence text file hash mismatch' };
    }
    pruneSupervisorEvidence(loaded.evidenceDirectory);
    const totalLines = loaded.snapshot.text.replace(/\r\n?/gu, '\n').split('\n').length;
    return {
      ok: true,
      accessMode: 'file',
      sessionId: loaded.snapshot.sessionId,
      reviewId: loaded.snapshot.reviewId,
      surfaceId: loaded.snapshot.surfaceId,
      isolationScope: loaded.snapshot.isolationScope,
      task: loaded.snapshot.task,
      capturedAt: loaded.snapshot.capturedAt,
      bufferType: loaded.snapshot.bufferType,
      truncated: loaded.snapshot.truncated,
      summary: loaded.snapshot.summary,
      path: realEvidencePath,
      format: 'text/plain; charset=utf-8',
      sha256,
      totalLines,
      suggestedRanges: supervisorEvidenceSuggestedRanges(loaded.snapshot.text),
      fallbackCommand: `wmux supervisor evidence --review-id ${loaded.snapshot.reviewId} --page 1 --page-lines 200`,
    };
  } catch {
    return { ok: false, error: 'supervisor evidence text file is unavailable' };
  }
}

function ensureGitIgnore(projectDir: string): void {
  const gitIgnorePath = path.join(projectDir, '.gitignore');
  const current = fs.existsSync(gitIgnorePath) ? fs.readFileSync(gitIgnorePath, 'utf8') : '';
  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = IGNORE_ENTRIES.filter((entry) => !existing.has(entry));
  if (missing.length === 0) return;

  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitIgnorePath, `${current}${prefix}${missing.join('\n')}\n`, 'utf8');
}

/** Append a compact, line-delimited audit entry to the monitored project. */
export function appendSupervisorRecord(record: SupervisorRecord): { path: string } {
  if (!path.isAbsolute(record.projectDir)) throw new Error('projectDir must be absolute');
  if (!SESSION_ID.test(record.sessionId)) throw new Error('invalid supervisor session id');
  if (!record.terminal.surfaceId) throw new Error('surfaceId is required');

  ensureGitIgnore(record.projectDir);
  fs.mkdirSync(path.join(record.projectDir, '.wmux', 'tmp'), { recursive: true });
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

/** Keep only events recorded after the most recent explicit context reset. */
function eventsAfterLastAbandonment(events: SupervisorAuditEvent[]): SupervisorAuditEvent[] {
  let startIndex = 0;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].type === 'session.abandoned') startIndex = index + 1;
  }
  return events.slice(startIndex);
}

function latestRestorableHistory(
  sessions: Array<SupervisorAuditSession & { directory: string }>,
  matches: (event: SupervisorAuditEvent) => boolean,
): SupervisorHistory {
  for (const session of sessions) {
    const matching = session.events.filter(matches);
    if (matching.length === 0) continue;
    const usable = eventsAfterLastAbandonment(matching);
    if (usable.some((event) => RESTORABLE_EVENT_TYPES.has(event.type))) {
      return { sessionId: session.sessionId, events: usable.slice(-MAX_HISTORY_EVENTS) };
    }
    if (usable.length !== matching.length) return emptyHistory();
  }
  return emptyHistory();
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
 * List explicitly selectable restore sources in one project. The caller chooses
 * the source terminal, so no current-terminal surfaceId matching is involved.
 * A reset tombstone removes that terminal from the list to keep “start over” a
 * hard recovery boundary.
 */
export function listSupervisorRestoreCandidates(projectDir: string): SupervisorRestoreCandidate[] {
  const sessions = readAuditSessions(projectDir);
  const grouped = new Map<string, SupervisorAuditEvent[]>();
  for (const session of sessions.slice().reverse()) {
    for (const event of session.events) {
      const events = grouped.get(event.terminal.surfaceId) || [];
      events.push(event);
      grouped.set(event.terminal.surfaceId, events);
    }
  }
  return [...grouped.entries()].flatMap(([surfaceId, events]) => {
    const usable = eventsAfterLastAbandonment(events);
    const last = usable[usable.length - 1];
    if (!last || !usable.some((event) => RESTORABLE_EVENT_TYPES.has(event.type))) return [];
    let currentTask = '';
    let lastDecision = '';
    for (const event of usable) {
      if (event.type === 'worker.task' && typeof event.payload.task === 'string') currentTask = event.payload.task;
      if (event.type === 'supervisor.decision' && typeof event.payload.outcome === 'string') {
        lastDecision = event.payload.outcome;
      }
    }
    const session = sessions.find((item) => item.events.some((event) => event === last));
    return [{
      surfaceId,
      label: last.terminal.label,
      sessionId: session?.sessionId || '',
      lastEventAt: last.ts,
      currentTask,
      lastDecision,
    }];
  }).sort((a, b) => b.lastEventAt - a.lastEventAt);
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

  const exact = latestRestorableHistory(
    sessionEvents,
    (event) => event.terminal.surfaceId === terminal.surfaceId,
  );
  if (exact.sessionId) return exact;

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
  return latestRestorableHistory(labelMatches, () => true);
}
