import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initPipeBridge } from '../../src/renderer/pipe-bridge';
import { useStore } from '../../src/renderer/store';
import type { ProjectManagerSession } from '../../src/shared/project-manager';

function project(): ProjectManagerSession {
  return {
    id: 'pm-watchdog',
    projectDir: 'E:\\repo',
    goal: '验证事件驱动活性恢复',
    preconditions: ['测试环境已准备'],
    planFiles: [],
    doneWhen: ['活性恢复测试通过'],
    status: 'active',
    workItems: [],
    events: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('managed agent watchdog bridge', () => {
  const writeReliable = vi.fn(async () => true);
  let agentState: 'working' | 'idle' | 'blocked' = 'working';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00Z'));
    writeReliable.mockClear();
    agentState = 'working';
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        wmux: {
          pty: {
            has: vi.fn(async () => true),
            writeReliable,
            write: vi.fn(),
          },
          notification: { fire: vi.fn() },
          projectManager: { saveSession: vi.fn(async () => ({ ok: true })) },
        },
        setTimeout: globalThis.setTimeout,
        __wmux_getAgentStates: () => ({
          'manager-watchdog': {
            state: agentState,
            updatedAt: Date.now() - 60_000,
          },
        }),
      },
    });
    const session = project();
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().resetOrdinarySupervisorSession();
    useStore.getState().restoreProjectManager({ ...session, managerSurfaceId: 'manager-watchdog' as any });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-watchdog' as any,
      title: '项目活性恢复',
      cwd: session.projectDir,
      splitTree: {
        type: 'leaf',
        paneId: 'pane-watchdog' as any,
        activeSurfaceIndex: 0,
        surfaces: [{
          id: 'manager-watchdog' as any,
          type: 'terminal',
          projectManagerTerminal: true,
          projectManagerProjectId: session.id,
          projectManagerAgent: 'codex',
          projectManagerReasoningEffort: 'medium',
        }],
      },
    }]);
    initPipeBridge();
  });

  afterEach(() => {
    (globalThis.window as any).__wmux_clearManagedAgentWatchdog?.('manager-watchdog');
    useStore.getState().restoreProjectManager(null);
    useStore.getState().replaceAllWorkspaces([]);
    Reflect.deleteProperty(globalThis, 'window');
    vi.useRealTimers();
  });

  it('uses a one-shot soft deadline and never injects a liveness prompt', async () => {
    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: 'manager-watchdog',
      event: 'UserPromptSubmit',
      task: '继续当前项目',
    });

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(writeReliable).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(writeReliable).toHaveBeenCalledTimes(1);
    expect(writeReliable).toHaveBeenLastCalledWith('manager-watchdog', '\x1b');

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(writeReliable).toHaveBeenCalledTimes(2);
    expect(writeReliable).toHaveBeenLastCalledWith('manager-watchdog', '\x03');
  });

  it('protects live long thinking until the absolute hard deadline', async () => {
    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: 'manager-watchdog',
      event: 'UserPromptSubmit',
    });
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    (globalThis.window as any).__wmux_noteManagedAgentOutput('manager-watchdog', '⠋ Working (29m)');

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(writeReliable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writeReliable).toHaveBeenLastCalledWith('manager-watchdog', '\x1b');
  });

  it('pauses the deadline while the Agent waits for permission', async () => {
    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: 'manager-watchdog',
      event: 'UserPromptSubmit',
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    agentState = 'blocked';
    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: 'manager-watchdog',
      event: 'PermissionRequest',
    });
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(writeReliable).not.toHaveBeenCalled();

    agentState = 'working';
    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: 'manager-watchdog',
      event: 'PermissionResult',
    });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(writeReliable).not.toHaveBeenCalled();
  });
});
