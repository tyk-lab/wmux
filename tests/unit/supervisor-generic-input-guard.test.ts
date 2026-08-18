import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { withSurfaceCaller } from '../../src/cli/surface-caller';
import {
  notifySupervisorTerminalInput,
  supervisorGenericInputBlockReason,
} from '../../src/main/supervisor-input-guard';
import { evaluateSupervisorGenericInput } from '../../src/renderer/supervisor/generic-input-guard';
import type { SupervisorSession } from '../../src/renderer/store/supervisor-slice';

function session(overrides: Partial<SupervisorSession> = {}): SupervisorSession {
  return {
    active: true,
    lanes: [{
      id: 'lane-a',
      label: 'worker',
      surfaceId: 'worker-a',
      supervisorSurfaceId: 'supervisor-a',
      enabled: true,
    }],
    ...overrides,
  } as SupervisorSession;
}

describe('supervisor generic input guard', () => {
  it('marks send and send-key requests with their ambient caller surface', () => {
    expect(withSurfaceCaller('surface.send_text', { surfaceId: 'worker-a' }, 'supervisor-a'))
      .toMatchObject({ surfaceId: 'worker-a', callerSurfaceId: 'supervisor-a' });
    expect(withSurfaceCaller('surface.send_key', { key: 'enter' }, 'supervisor-a'))
      .toMatchObject({ key: 'enter', callerSurfaceId: 'supervisor-a' });
    expect(withSurfaceCaller('surface.read_text', { surfaceId: 'worker-a' }, 'supervisor-a'))
      .toEqual({ surfaceId: 'worker-a' });
    expect(withSurfaceCaller(
      'surface.send_text',
      { callerSurfaceId: 'explicit-user' },
      'supervisor-a',
    )).toEqual({ callerSurfaceId: 'explicit-user' });
  });

  it('blocks active dedicated supervisors from generic cross-surface input', () => {
    expect(evaluateSupervisorGenericInput(session(), 'supervisor-a', 'worker-a'))
      .toMatchObject({ supervisedCaller: true, blocked: true });
    expect(evaluateSupervisorGenericInput(session(), 'supervisor-a', 'worker-b'))
      .toMatchObject({ supervisedCaller: true, blocked: true });
  });

  it('blocks the project manager from bypassing the supervisor with generic input', () => {
    const managers = new Set(['project-manager-a']);
    expect(evaluateSupervisorGenericInput(session(), 'project-manager-a', 'worker-a', managers))
      .toMatchObject({ supervisedCaller: true, blocked: true, reason: expect.stringContaining('项目协议') });
    expect(evaluateSupervisorGenericInput(session(), 'project-manager-a', 'user-terminal', managers))
      .toMatchObject({ supervisedCaller: true, blocked: true });
    expect(evaluateSupervisorGenericInput(session(), 'project-manager-a', 'project-manager-a', managers))
      .toEqual({ supervisedCaller: true, blocked: false });
  });

  it('keeps a project task AI inside its own terminal', () => {
    const tasks = new Set(['project-task-a']);
    expect(evaluateSupervisorGenericInput(session(), 'project-task-a', 'worker-a', new Set(), tasks))
      .toMatchObject({ supervisedCaller: true, blocked: true, reason: expect.stringContaining('当前任务终端') });
    expect(evaluateSupervisorGenericInput(session(), 'project-task-a', 'project-task-a', new Set(), tasks))
      .toEqual({ supervisedCaller: true, blocked: false });
  });

  it('allows normal terminals and supervisor self-input', () => {
    expect(evaluateSupervisorGenericInput(session(), 'user-terminal', 'worker-a'))
      .toEqual({ supervisedCaller: false, blocked: false });
    expect(evaluateSupervisorGenericInput(session(), 'supervisor-a', 'supervisor-a'))
      .toEqual({ supervisedCaller: true, blocked: false });
  });

  it('keeps registered supervisors restricted after stop or lane disable', () => {
    expect(evaluateSupervisorGenericInput(session({ active: false }), 'supervisor-a', 'worker-a'))
      .toMatchObject({ supervisedCaller: true, blocked: true });
    const disabled = session();
    disabled.lanes[0].enabled = false;
    expect(evaluateSupervisorGenericInput(disabled, 'supervisor-a', 'worker-a'))
      .toMatchObject({ supervisedCaller: true, blocked: true });
  });

  it('returns a renderer-provided block reason before main writes the PTY', async () => {
    const executeJavaScript = vi.fn().mockResolvedValue({
      blocked: true,
      reason: 'must use supervisor.decide',
    });
    const reason = await supervisorGenericInputBlockReason('supervisor-a', 'worker-a', [{
      isDestroyed: () => false,
      webContents: { executeJavaScript },
    }]);

    expect(reason).toBe('must use supervisor.decide');
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('supervisor-a'));
  });

  it('keeps callerless integrations and ordinary renderer results compatible', async () => {
    const executeJavaScript = vi.fn().mockResolvedValue({ blocked: false });
    const windows = [{ isDestroyed: () => false, webContents: { executeJavaScript } }];

    expect(await supervisorGenericInputBlockReason('', 'worker-a', windows)).toBeNull();
    expect(await supervisorGenericInputBlockReason('user-terminal', 'worker-a', windows)).toBeNull();
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it('does not hang forever when a renderer window stops responding', async () => {
    vi.useFakeTimers();
    try {
      const windows = [{
        isDestroyed: () => false,
        webContents: { executeJavaScript: () => new Promise(() => undefined) },
      }];
      const result = supervisorGenericInputBlockReason('user-terminal', 'worker-a', windows);
      await vi.advanceTimersByTimeAsync(501);
      await expect(result).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifies the renderer before a trusted send-key Enter is written', async () => {
    const executeJavaScript = vi.fn().mockResolvedValue({ handled: true, clearAutomatedDraft: false });
    const handled = await notifySupervisorTerminalInput('worker-a', '\r', [{
      isDestroyed: () => false,
      webContents: { executeJavaScript },
    }]);

    expect(handled).toEqual({ handled: true, clearAutomatedDraft: false });
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('__wmux_handleTerminalUserInput'),
    );
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('worker-a'));
  });
});
