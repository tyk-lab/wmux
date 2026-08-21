import {
  compactSupervisorEvidenceSummary,
  SUPERVISOR_EVIDENCE_MAX_CHARS,
  supervisorEvidencePage,
  type SupervisorEvidenceFileReference,
  type SupervisorEvidencePage,
  type SupervisorEvidenceSnapshot,
} from '../../shared/supervisor-evidence';
import type { TerminalInputIsolationScope } from '../../shared/types';

const evidenceCache = new Map<string, SupervisorEvidenceSnapshot>();
const MAX_CACHED_EVIDENCE = 32;

function cacheKey(sessionId: string, reviewId: string): string {
  return `${sessionId}:${reviewId}`;
}

export interface CreateSupervisorEvidenceOptions {
  sessionId: string;
  reviewId: string;
  laneId: string;
  surfaceId: string;
  isolationScope: TerminalInputIsolationScope;
  task: string;
  capturedAt?: number;
  bufferType?: string;
  bufferLines?: number;
  capturedLines?: number;
  truncated?: boolean;
  summary: string;
  text: string;
}

export function createSupervisorEvidenceSnapshot(
  options: CreateSupervisorEvidenceOptions,
): SupervisorEvidenceSnapshot {
  const rawText = options.text.replace(/\r\n?/gu, '\n').trimEnd();
  const textWasTruncated = rawText.length > SUPERVISOR_EVIDENCE_MAX_CHARS;
  const text = textWasTruncated
    ? `…（证据快照超过 ${SUPERVISOR_EVIDENCE_MAX_CHARS} 字符，已保留末尾）\n${rawText.slice(-SUPERVISOR_EVIDENCE_MAX_CHARS)}`
    : rawText;
  const bufferType = options.bufferType === 'normal' || options.bufferType === 'alternate'
    ? options.bufferType
    : 'unknown';
  return {
    version: 1,
    sessionId: options.sessionId,
    reviewId: options.reviewId,
    laneId: options.laneId,
    surfaceId: options.surfaceId,
    isolationScope: options.isolationScope,
    task: options.task.trim(),
    capturedAt: options.capturedAt ?? Date.now(),
    bufferType,
    bufferLines: Math.max(0, Math.floor(options.bufferLines || 0)),
    capturedLines: Math.max(0, Math.floor(options.capturedLines || 0)),
    truncated: options.truncated === true || textWasTruncated || bufferType === 'alternate',
    summary: compactSupervisorEvidenceSummary(options.summary),
    text,
  };
}

export function registerSupervisorEvidence(snapshot: SupervisorEvidenceSnapshot): void {
  const key = cacheKey(snapshot.sessionId, snapshot.reviewId);
  evidenceCache.delete(key);
  evidenceCache.set(key, snapshot);
  while (evidenceCache.size > MAX_CACHED_EVIDENCE) {
    evidenceCache.delete(evidenceCache.keys().next().value as string);
  }
}

export function cachedSupervisorEvidencePage(
  sessionId: string,
  reviewId: string,
  surfaceId: string,
  isolationScope: TerminalInputIsolationScope,
  page?: number,
  pageLines?: number,
): SupervisorEvidencePage | undefined {
  const snapshot = cachedSupervisorEvidenceSnapshot(
    sessionId,
    reviewId,
    surfaceId,
    isolationScope,
  );
  if (!snapshot) return undefined;
  return supervisorEvidencePage(snapshot, page, pageLines);
}

export function cachedSupervisorEvidenceSnapshot(
  sessionId: string,
  reviewId: string,
  surfaceId: string,
  isolationScope: TerminalInputIsolationScope,
): SupervisorEvidenceSnapshot | undefined {
  const snapshot = evidenceCache.get(cacheKey(sessionId, reviewId));
  if (!snapshot
    || snapshot.surfaceId !== surfaceId
    || snapshot.isolationScope !== isolationScope) return undefined;
  return snapshot;
}

export async function persistSupervisorEvidence(
  projectDir: string,
  snapshot: SupervisorEvidenceSnapshot,
): Promise<void> {
  const api = (window as any).wmux?.supervisor;
  if (!api?.saveEvidence || !projectDir) return;
  await api.saveEvidence({ projectDir, snapshot });
}

export async function readPersistedSupervisorEvidencePage(options: {
  projectDir: string;
  sessionId: string;
  reviewId: string;
  surfaceId: string;
  isolationScope: TerminalInputIsolationScope;
  page?: number;
  pageLines?: number;
}): Promise<SupervisorEvidencePage | undefined> {
  const api = (window as any).wmux?.supervisor;
  if (!api?.readEvidence) return undefined;
  const result = await api.readEvidence(options);
  return result?.ok === true ? result as SupervisorEvidencePage : undefined;
}

export async function readPersistedSupervisorEvidenceFile(options: {
  projectDir: string;
  sessionId: string;
  reviewId: string;
  surfaceId: string;
  isolationScope: TerminalInputIsolationScope;
}): Promise<SupervisorEvidenceFileReference | undefined> {
  const api = (window as any).wmux?.supervisor;
  if (!api?.readEvidenceFile) return undefined;
  try {
    const result = await api.readEvidenceFile(options);
    return result?.ok === true && result?.accessMode === 'file'
      ? result as SupervisorEvidenceFileReference
      : undefined;
  } catch {
    return undefined;
  }
}

export function clearSupervisorEvidenceCache(): void {
  evidenceCache.clear();
}
