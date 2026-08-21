import type { TerminalInputIsolationScope } from './types';

export const SUPERVISOR_EVIDENCE_MAX_CHARS = 512_000;
export const SUPERVISOR_EVIDENCE_SUMMARY_MAX_CHARS = 1_200;
export const SUPERVISOR_EVIDENCE_DEFAULT_PAGE_LINES = 200;
export const SUPERVISOR_EVIDENCE_MAX_PAGE_LINES = 500;

export function compactSupervisorEvidenceSummary(
  value: string,
  maxChars = SUPERVISOR_EVIDENCE_SUMMARY_MAX_CHARS,
  marker = '\n…（摘要已压缩，完整内容见冻结证据）\n',
): string {
  const text = value.trim();
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return text;
  if (limit <= marker.length) return text.slice(0, limit);
  const available = limit - marker.length;
  const headLength = Math.floor(available * 0.6);
  return `${text.slice(0, headLength)}${marker}${text.slice(-(available - headLength))}`;
}

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

export interface SupervisorEvidenceSuggestedRange {
  startLine: number;
  endLine: number;
  reason: 'diagnostic' | 'validation' | 'tail';
}

export interface SupervisorEvidenceFileReference {
  ok: true;
  accessMode: 'file';
  sessionId: string;
  reviewId: string;
  surfaceId: string;
  isolationScope: TerminalInputIsolationScope;
  task: string;
  capturedAt: number;
  bufferType: SupervisorEvidenceSnapshot['bufferType'];
  truncated: boolean;
  summary: string;
  path: string;
  format: 'text/plain; charset=utf-8';
  sha256: string;
  totalLines: number;
  suggestedRanges: SupervisorEvidenceSuggestedRange[];
  fallbackCommand: string;
}

export function supervisorEvidenceSuggestedRanges(
  text: string,
): SupervisorEvidenceSuggestedRange[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const totalLines = Math.max(1, lines.length);
  const lastMatchingLine = (pattern: RegExp): number => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[index])) return index + 1;
    }
    return 0;
  };
  const around = (
    line: number,
    reason: SupervisorEvidenceSuggestedRange['reason'],
    radius = 6,
  ): SupervisorEvidenceSuggestedRange | undefined => line > 0
    ? {
        startLine: Math.max(1, line - radius),
        endLine: Math.min(totalLines, line + radius),
        reason,
      }
    : undefined;
  const diagnostic = around(lastMatchingLine(
    /(?:error|failed|failure|exception|traceback|exit\s*code|报错|错误|失败|异常|阻塞)/iu,
  ), 'diagnostic');
  const validation = around(lastMatchingLine(
    /(?:test|tests|passed|passing|build|lint|typecheck|验证|测试|通过|构建|编译|验收)/iu,
  ), 'validation');
  const tail: SupervisorEvidenceSuggestedRange = {
    startLine: Math.max(1, totalLines - 119),
    endLine: totalLines,
    reason: 'tail',
  };
  return [diagnostic, validation, tail].filter(
    (range): range is SupervisorEvidenceSuggestedRange => !!range,
  ).filter((range, index, ranges) => ranges.findIndex((candidate) => (
    candidate.startLine === range.startLine && candidate.endLine === range.endLine
  )) === index);
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
