interface TerminalBufferLineLike {
  isWrapped?: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

interface TerminalBufferLike {
  baseY?: number;
  cursorX?: number;
  cursorY?: number;
  length: number;
  getLine(index: number): TerminalBufferLineLike | undefined;
}

const MAX_INPUT_ROWS = 20;
const BOX_INPUT_LINE = /^\s*[│┃|]/;
const EMPTY_INPUT_CHROME = /^[\s│┃|>›❯»$#╭╮╰╯┌┐└┘─━═]+$/;
const INPUT_PROMPT_LINE = /^\s*(?:(?:[│┃|]\s*)?(?:>|›|❯|»)\s?|PS\s+[^>]*>\s*|[^\s@]+@[^:]+:[^$#]*[$#]\s*)/i;

function lineText(line: TerminalBufferLineLike | undefined, endColumn?: number): string {
  if (!line) return '';
  return typeof endColumn === 'number'
    ? line.translateToString(false, 0, Math.max(0, endColumn))
    : line.translateToString(false);
}

function inputContent(line: string): string {
  let content = line.trimEnd();
  content = content.replace(/^\s*[│┃|]\s?/, '').replace(/\s*[│┃|]\s*$/, '');
  content = content.replace(/^\s*(?:>|›|❯|»)\s?/, '');
  content = content.replace(/^\s*PS\s+[^>]*>\s*/i, '');
  content = content.replace(/^\s*[^\s@]+@[^:]+:[^$#]*[$#]\s*/, '');
  return content.trim();
}

/**
 * Detect text already entered at the active terminal cursor without depending
 * on a specific AI TUI. Only cursor-local and wrapped/boxed input rows are
 * inspected, so completed output elsewhere in the scrollback is ignored.
 */
export function hasPendingTerminalInput(buffer: TerminalBufferLike | null | undefined): boolean {
  if (!buffer || !Number.isFinite(buffer.cursorX) || !Number.isFinite(buffer.cursorY) || buffer.length <= 0) return false;
  const baseY = Number.isFinite(buffer.baseY) ? Math.max(0, Number(buffer.baseY)) : 0;
  const cursorY = Math.min(buffer.length - 1, baseY + Math.max(0, Number(buffer.cursorY)));
  const currentLine = buffer.getLine(cursorY);
  if (!currentLine) return false;

  const rows = [lineText(currentLine, Number(buffer.cursorX))];
  let row = cursorY;
  let boxedInput = BOX_INPUT_LINE.test(lineText(currentLine));
  while (row > 0 && rows.length < MAX_INPUT_ROWS) {
    const line = buffer.getLine(row);
    const previous = buffer.getLine(row - 1);
    const previousText = lineText(previous);
    const continuesWrappedInput = line?.isWrapped === true;
    const continuesBoxedInput = boxedInput && BOX_INPUT_LINE.test(previousText);
    if (!continuesWrappedInput && !continuesBoxedInput) break;
    rows.unshift(previousText);
    boxedInput = boxedInput || continuesBoxedInput;
    row -= 1;
  }

  // TUI redraws may temporarily leave the cursor on a completed output row.
  // Treat cursor-local text as a draft only when the wrapped/boxed region is
  // anchored by a known interactive prompt; otherwise a repaint can stop an
  // otherwise idle task terminal indefinitely.
  if (!rows.some((text) => INPUT_PROMPT_LINE.test(text))) return false;
  const combined = rows.map(inputContent).filter(Boolean).join('\n').trim();
  return combined.length > 0 && !EMPTY_INPUT_CHROME.test(combined);
}
