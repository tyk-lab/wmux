import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initPipeBridge } from '../../src/renderer/pipe-bridge';
import { useStore } from '../../src/renderer/store';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';

function lane(): SupervisorLane {
  return {
    id: 'lane-a',
    label: 'worker',
    surfaceId: 'worker-a' as any,
    supervisorSurfaceId: 'supervisor-a' as any,
    enabled: true,
    steps: [],
    maxAutoSteps: 0,
    autoStepsUsed: 0,
    awaitingStopCheck: false,
    stopConfirmed: false,
    awaitingReview: false,
    autoDecisionsUsed: 0,
    decisions: [],
  };
}

describe('supervisor decision bridge', () => {
  const writes = vi.fn();
  let agentState: { state: string; blockedReason: string | null; updatedAt: number };

  beforeEach(() => {
    writes.mockReset();
    agentState = { state: 'idle', blockedReason: null, updatedAt: 1 };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        wmux: {
          pty: { write: writes },
          notification: { fire: vi.fn() },
        },
        setTimeout: (callback: () => void) => {
          callback();
          return 1;
        },
        __wmux_getAgentStates: () => ({ 'worker-a': agentState }),
      },
    });
    const store = useStore.getState();
    store.resetSupervisorSession();
    store.setSupervisorLanes([lane()]);
    store.patchSupervisor({ mode: 'unified', autonomous: false, submitEnter: false });
    store.startSupervisor();
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(true);
    initPipeBridge();
  });

  afterEach(() => {
    useStore.getState().resetSupervisorSession();
    Reflect.deleteProperty(globalThis, 'window');
  });

  function decide(params: Record<string, unknown>): any {
    return (globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a',
      supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue',
      reason: '测试裁决',
      ...params,
    });
  }

  it('injects one safe next step from ordinary supervision', () => {
    expect(decide({ next: '运行相关单元测试' })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledWith('worker-a', '运行相关单元测试');
    expect(decide({ next: '重复发送下一步' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('allows a bounded route adjustment and rejects material or incomplete proposals', () => {
    expect(decide({ proposalKind: 'route-adjustment', next: '保留接口，改用已有适配器并运行本地测试' }))
      .toMatchObject({ ok: true });
    expect(decide({ proposalKind: 'route-adjustment', next: '' })).toMatchObject({ ok: false });
    expect(decide({ proposalKind: 'route-change', next: '更换框架' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('answers one low-risk technical choice while the worker is blocked', () => {
    agentState = { state: 'blocked', blockedReason: 'question: choose方案 A or方案 B', updatedAt: 2 };
    expect(decide({
      proposalKind: 'route-adjustment',
      next: '选择方案 A：保留现有接口，改用已有适配器并运行本地测试',
    })).toMatchObject({ ok: true });
    expect(writes).toHaveBeenCalledWith('worker-a', '选择方案 A：保留现有接口，改用已有适配器并运行本地测试');

    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({ next: '再次选择方案 A' })).toMatchObject({ ok: false });
    expect(decide({ next: '' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('keeps risky or permission-blocked input out of the technical-choice path', () => {
    agentState = { state: 'blocked', blockedReason: 'question: choose方案 A or方案 B', updatedAt: 2 };
    expect(decide({ next: '选择方案 A 后 git push origin main' })).toMatchObject({ ok: false });
    agentState = { state: 'blocked', blockedReason: 'permission: npm test', updatedAt: 3 };
    expect(decide({ next: 'y' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('blocks high-impact next work before it reaches the worker', () => {
    expect(decide({ next: 'git push origin main' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps the review window open when task delivery fails', () => {
    writes.mockImplementationOnce(() => { throw new Error('pty closed'); });

    expect(decide({ next: '运行相关单元测试' })).toMatchObject({ ok: false, error: expect.stringContaining('pty closed') });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      autoDecisionsUsed: 0,
      decisions: [],
    });
  });

  it('confirms a low-risk permission without consuming a judgment slot', () => {
    agentState = { state: 'blocked', blockedReason: 'permission: npm test', updatedAt: 2 };
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' }))
      .toMatchObject({ ok: true, autoAuthorized: true });
    expect(writes).toHaveBeenNthCalledWith(1, 'worker-a', 'y');
    expect(useStore.getState().supervisor.lanes[0].autoDecisionsUsed).toBe(0);
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it('rejects permission confirmation without a current permission block', () => {
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects unsafe or malformed permission confirmations', () => {
    agentState = { state: 'blocked', blockedReason: 'permission: command', updatedAt: 2 };
    expect(decide({ permissionCommand: 'git push origin main', permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'maybe' })).toMatchObject({ ok: false });
    expect(decide({ permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y', next: '继续任务' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([false, true])('always queues needs-human instead of auto-sending (autonomous=%s)', (autonomous) => {
    useStore.getState().patchSupervisor({ autonomous });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'route-change',
      next: '切换主要实现路线',
      impact: '影响外部接口',
      alternatives: '保留当前路线',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
  });
});
