import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sendPermissionResponseReliably,
  sendToSurface,
  stagedTerminalInputPrompt,
} from '../../src/renderer/supervisor/supervisor-engine';
import { prepareForUserTerminalInput, resetTerminalUserInputTracking } from '../../src/renderer/utils/terminal-user-submit';
import {
  clearTerminalRuntimeStatus,
  markTerminalRuntimeExited,
} from '../../src/renderer/terminal-runtime-lifecycle';

describe('supervisor surface input delivery', () => {
  afterEach(() => {
    resetTerminalUserInputTracking();
    clearTerminalRuntimeStatus('worker-a');
    clearTerminalRuntimeStatus('supervisor-a');
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('strips trailing newlines and submits exactly once with CR', () => {
    const write = vi.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        wmux: { pty: { write } },
        setTimeout: (callback: () => void) => {
          callback();
          return 1;
        },
      },
    });

    sendToSurface('supervisor-a', '审核当前结果\n\n', true);

    expect(write.mock.calls).toEqual([
      ['supervisor-a', '审核当前结果'],
      ['supervisor-a', '\r'],
    ]);
  });

  it('stages oversized text and writes only a short file-reference prompt', async () => {
    const write = vi.fn();
    const stageInputFile = vi.fn().mockResolvedValue({
      reference: '.wmux/tmp/terminal-input-1234-abcd1234.txt',
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        wmux: { pty: { write, stageInputFile } },
        setTimeout: (callback: () => void) => {
          callback();
          return 1;
        },
      },
    });

    const longText = 'x'.repeat(4_001);
    await sendToSurface('supervisor-a', longText, true);

    const prompt = stagedTerminalInputPrompt('.wmux/tmp/terminal-input-1234-abcd1234.txt');
    expect(stageInputFile).toHaveBeenCalledWith('supervisor-a', longText);
    expect(write.mock.calls).toEqual([
      ['supervisor-a', prompt.replace(/\n/gu, ' ')],
      ['supervisor-a', '\r'],
    ]);
    expect(write).not.toHaveBeenCalledWith('supervisor-a', longText);
  });

  it('cancels the delayed AI Enter and clears its draft when user text arrives', () => {
    const write = vi.fn();
    let submit: (() => void) | undefined;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        wmux: { pty: { write } },
        setTimeout: (callback: () => void) => {
          submit = callback;
          return 7;
        },
      },
    });

    sendToSurface('worker-a', 'AI 审核意见', true);
    expect(prepareForUserTerminalInput('worker-a', '用户意见').shouldSubmit).toBe(false);
    submit?.();

    expect(write.mock.calls).toEqual([
      ['worker-a', 'AI 审核意见'],
      ['worker-a', '\x15'],
    ]);
  });

  it('settles an awaited legacy delivery after user input cancels its Enter', async () => {
    const write = vi.fn();
    let submit: (() => void) | undefined;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        wmux: { pty: { write } },
        setTimeout: (callback: () => void) => {
          submit = callback;
          return 9;
        },
      },
    });

    const delivery = sendPermissionResponseReliably('worker-a', 'y');
    expect(prepareForUserTerminalInput('worker-a', '用户输入').clearAutomatedDraft).toBe(false);
    submit?.();

    await expect(delivery).rejects.toThrow('检测到用户输入');
    expect(write.mock.calls).toEqual([
      ['worker-a', 'y'],
      ['worker-a', '\x15'],
    ]);
  });

  it('does not deliver Agent text into the surviving outer shell after Codex exits', () => {
    const write = vi.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { wmux: { pty: { write } } },
    });
    markTerminalRuntimeExited('worker-a', 'Codex Agent 已退出');

    expect(() => sendToSurface('worker-a', '项目监督事件：请继续', true))
      .toThrow('终端 Agent 已不可用');
    expect(write).not.toHaveBeenCalled();
  });
});
