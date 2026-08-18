import { afterEach, describe, expect, it } from 'vitest';
import {
  clearTerminalRuntimeStatus,
  disposeTerminalRuntimeStatus,
  markTerminalRuntimeFailed,
  markTerminalRuntimeExited,
  markTerminalRuntimeReady,
  markTerminalRuntimeStarting,
  terminalRuntimeStatus,
  terminalRuntimeInputError,
  waitForTerminalRuntimeReady,
} from '../../src/renderer/terminal-runtime-lifecycle';

const surfaceIds = ['surface-ready', 'surface-failed', 'surface-exited', 'surface-closed'];

afterEach(() => {
  for (const surfaceId of surfaceIds) clearTerminalRuntimeStatus(surfaceId);
  delete (globalThis as Record<string, unknown>).window;
});

describe('terminal runtime lifecycle', () => {
  it('does not report a created terminal as ready before its renderer attaches', async () => {
    (globalThis as any).window = { wmux: { pty: { has: async () => true } } };
    markTerminalRuntimeStarting('surface-ready');

    const readiness = waitForTerminalRuntimeReady('surface-ready', 1_000);
    expect(terminalRuntimeStatus('surface-ready')?.state).toBe('starting');
    markTerminalRuntimeReady('surface-ready');

    await expect(readiness).resolves.toEqual({ ok: true });
  });

  it('propagates startup failures to callers waiting for readiness', async () => {
    (globalThis as any).window = { wmux: { pty: { has: async () => true } } };
    markTerminalRuntimeStarting('surface-failed');
    const readiness = waitForTerminalRuntimeReady('surface-failed', 1_000);

    markTerminalRuntimeFailed('surface-failed', 'AI 启动命令写入失败');

    await expect(readiness).resolves.toEqual({
      ok: false,
      error: 'AI 启动命令写入失败',
    });
  });

  it('releases readiness waiters immediately when the surface is closed', async () => {
    (globalThis as any).window = { wmux: { pty: { has: async () => true } } };
    markTerminalRuntimeStarting('surface-closed');
    const readiness = waitForTerminalRuntimeReady('surface-closed', 1_000);

    disposeTerminalRuntimeStatus('surface-closed', '启动期间已取消');

    await expect(readiness).resolves.toEqual({ ok: false, error: '启动期间已取消' });
    expect(terminalRuntimeStatus('surface-closed')).toBeUndefined();
  });

  it('blocks automated input after the nested Agent exits while the PTY survives', () => {
    markTerminalRuntimeReady('surface-exited');
    expect(terminalRuntimeInputError('surface-exited')).toBeNull();

    markTerminalRuntimeExited('surface-exited', 'Codex Agent 已退出');

    expect(terminalRuntimeInputError('surface-exited')).toBe('Codex Agent 已退出');
  });
});
