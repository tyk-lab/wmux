import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  clearTerminalRuntimeStatus,
  disposeTerminalRuntimeStatus,
  markTerminalRuntimeFailed,
  markTerminalRuntimeExited,
  markTerminalRuntimeReady,
  markTerminalRuntimeStarting,
  terminalRuntimeAttachAction,
  terminalRuntimeFailureRecoveryAction,
  terminalRuntimeStabilityDecision,
  terminalRuntimeValidationAction,
  terminalRuntimeStatus,
  terminalRuntimeInputError,
  waitForTerminalRuntimeReady,
} from '../../src/renderer/terminal-runtime-lifecycle';
import { isStartupTrustPromptReady } from '../../src/renderer/utils/terminal-input-delivery';

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

  it('does not resurrect failed or exited runtimes when a terminal pane remounts', () => {
    markTerminalRuntimeFailed('surface-failed', '启动失败');
    markTerminalRuntimeExited('surface-exited', 'Agent 已退出');

    expect(terminalRuntimeAttachAction(terminalRuntimeStatus('surface-failed'), true)).toBe('preserve');
    expect(terminalRuntimeAttachAction(terminalRuntimeStatus('surface-exited'), true)).toBe('preserve');
    expect(terminalRuntimeAttachAction(undefined, true)).toBe('validate-interactive');
    expect(terminalRuntimeAttachAction(undefined, false)).toBe('ready');
  });

  it('keeps automated runtimes starting until output exists and startup menus are cleared', () => {
    const codexTrustPrompt = [
      'Do you trust the contents of this directory?',
      '❯ 1. Yes, continue',
      '  2. No, quit',
    ].join('\n');

    expect(terminalRuntimeStabilityDecision(false, false, false)).toBe('wait');
    expect(terminalRuntimeStabilityDecision(
      true,
      isStartupTrustPromptReady('codex', codexTrustPrompt),
      false,
    )).toBe('wait');
    expect(terminalRuntimeStabilityDecision(true, false, false)).toBe('wait');
    expect(terminalRuntimeStabilityDecision(true, false, true)).toBe('ready');
  });

  it('rechecks unknown Agent output for a bounded number of stability windows', () => {
    expect(terminalRuntimeValidationAction('ready', false, 1, 15)).toBe('ready');
    expect(terminalRuntimeValidationAction('wait', true, 1, 15)).toBe('handle-interaction');
    expect(terminalRuntimeValidationAction('wait', false, 1, 15)).toBe('retry');
    expect(terminalRuntimeValidationAction('wait', false, 15, 15)).toBe('fail');
  });

  it('leaves project-managed startup recovery to the caller instead of recursing', () => {
    expect(terminalRuntimeFailureRecoveryAction(true, true)).toBe('caller-owned');
    expect(terminalRuntimeFailureRecoveryAction(true, false)).toBe('auto-recover');
    expect(terminalRuntimeFailureRecoveryAction(false, true)).toBe('auto-recover');
  });

  it('subscribes to a known surface before spawning its fast startup command', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
      'utf-8',
    );
    const marker = source.indexOf('// Subscribe before spawning.');
    const attach = source.indexOf('attachToPty(surfaceId!)', marker);
    const create = source.indexOf('window.wmux.pty.create', marker);

    expect(marker).toBeGreaterThan(0);
    expect(attach).toBeGreaterThan(marker);
    expect(create).toBeGreaterThan(attach);
  });
});
