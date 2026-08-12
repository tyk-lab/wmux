import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendToSurface } from '../../src/renderer/supervisor/supervisor-engine';
import { prepareForUserTerminalInput, resetTerminalUserInputTracking } from '../../src/renderer/utils/terminal-user-submit';

describe('supervisor surface input delivery', () => {
  afterEach(() => {
    resetTerminalUserInputTracking();
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
      ['worker-a', '\x03'],
    ]);
  });
});
