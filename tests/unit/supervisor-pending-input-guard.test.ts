import { describe, expect, it } from 'vitest';
import { hasPendingTerminalInput } from '../../src/renderer/supervisor/pending-input-guard';

interface TestLine {
  text: string;
  isWrapped?: boolean;
}

function buffer(lines: TestLine[], cursorY: number, cursorX: number, baseY = 0) {
  return {
    baseY,
    cursorX,
    cursorY,
    length: lines.length,
    getLine: (index: number) => {
      const line = lines[index];
      return line ? {
        isWrapped: line.isWrapped,
        translateToString: (_trimRight?: boolean, start = 0, end?: number) => line.text.slice(start, end),
      } : undefined;
    },
  };
}

describe('supervisor pending terminal input guard', () => {
  it('detects a Grok draft inside its bordered composer', () => {
    const draft = '│ > 用户尚未提交的 Grok 草稿';
    expect(hasPendingTerminalInput(buffer([
      { text: '╭────────────────────────╮' },
      { text: draft },
      { text: '╰────────────────────────╯' },
    ], 1, draft.length))).toBe(true);
    expect(hasPendingTerminalInput(buffer([
      { text: '╭────────────────────────╮' },
      { text: '│ > ' },
      { text: '╰────────────────────────╯' },
    ], 1, 4))).toBe(false);
  });

  it('detects Codex and Kimi/Pi drafts without treating empty prompts as input', () => {
    expect(hasPendingTerminalInput(buffer([{ text: '› 请先检查现有测试' }], 0, 11))).toBe(true);
    expect(hasPendingTerminalInput(buffer([{ text: '› ' }], 0, 2))).toBe(false);
    expect(hasPendingTerminalInput(buffer([{ text: '> 根据计划继续分析' }], 0, 10))).toBe(true);
    expect(hasPendingTerminalInput(buffer([{ text: '' }], 0, 0))).toBe(false);
  });

  it('detects wrapped multi-line drafts and uses the scrollback-relative cursor row', () => {
    expect(hasPendingTerminalInput(buffer([
      { text: '旧输出' },
      { text: '› 第一行很长的输入' },
      { text: '第二行仍未提交', isWrapped: true },
    ], 1, 7, 1))).toBe(true);
  });

  it('ignores completed output away from an empty active composer', () => {
    expect(hasPendingTerminalInput(buffer([
      { text: '任务已经完成，输出内容很多' },
      { text: '› ' },
    ], 1, 2))).toBe(false);
  });
});

