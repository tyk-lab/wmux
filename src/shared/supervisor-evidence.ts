import type { TerminalInputIsolationScope } from './types';

export const SUPERVISOR_EVIDENCE_MAX_CHARS = 512_000;
export const SUPERVISOR_EVIDENCE_DEFAULT_PAGE_LINES = 200;
export const SUPERVISOR_EVIDENCE_MAX_PAGE_LINES = 500;

export interface SupervisorEvidenceSnapshot {
  version: 1;
  sessionId: string;
  reviewId: string;
  laneId: string;
  surfaceId: string;
  isolationScope: TerminalInputIsolationScope;
  task: string;
  capturedAt: number;
  bufferType: 'normal' | 'alternate' | 'unknown';
  bufferLines: number;
  capturedLines: number;
  truncated: boolean;
  summary: string;
  text: string;
}

export interface SupervisorEvidencePage {
  ok: true;
  sessionId: string;
  reviewId: string;
  surfaceId: string;
  isolationScope: TerminalInputIsolationScope;
  task: string;
  capturedAt: number;
  bufferType: SupervisorEvidenceSnapshot['bufferType'];
  bufferLines: number;
  capturedLines: number;
  truncated: boolean;
  summary: string;
  page: number;
  pageLines: number;
  totalPages: number;
  totalLines: number;
  hasMore: boolean;
  nextPage?: number;
  text: string;
}

export function supervisorEvidencePage(
  snapshot: SupervisorEvidenceSnapshot,
  requestedPage = 1,
  requestedPageLines = SUPERVISOR_EVIDENCE_DEFAULT_PAGE_LINES,
): SupervisorEvidencePage {
  const pageLines = Math.min(
    Math.max(Math.floor(requestedPageLines) || SUPERVISOR_EVIDENCE_DEFAULT_PAGE_LINES, 1),
    SUPERVISOR_EVIDENCE_MAX_PAGE_LINES,
  );
  const lines = snapshot.text.replace(/\r\n?/gu, '\n').split('\n');
  const totalLines = lines.length;
  const totalPages = Math.max(1, Math.ceil(totalLines / pageLines));
  const page = Math.min(Math.max(Math.floor(requestedPage) || 1, 1), totalPages);
  const start = (page - 1) * pageLines;
  const hasMore = page < totalPages;
  return {
    ok: true,
    sessionId: snapshot.sessionId,
    reviewId: snapshot.reviewId,
    surfaceId: snapshot.surfaceId,
    isolationScope: snapshot.isolationScope,
    task: snapshot.task,
    capturedAt: snapshot.capturedAt,
    bufferType: snapshot.bufferType,
    bufferLines: snapshot.bufferLines,
    capturedLines: snapshot.capturedLines,
    truncated: snapshot.truncated,
    summary: page === 1 ? snapshot.summary : '',
    page,
    pageLines,
    totalPages,
    totalLines,
    hasMore,
    ...(hasMore ? { nextPage: page + 1 } : {}),
    text: lines.slice(start, start + pageLines).join('\n'),
  };
}
