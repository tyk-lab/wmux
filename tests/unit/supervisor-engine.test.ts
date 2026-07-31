import { describe, it, expect } from 'vitest';
import {
  blankRuntime,
  getNextOpenStep,
  mayDispatch,
  tickLane,
} from '../../src/renderer/supervisor/supervisor-engine';
import {
  createDefaultSupervisorSession,
  type SupervisorLane,
  type SupervisorSession,
} from '../../src/renderer/store/supervisor-slice';
import { buildInjectedPrompt } from '../../src/renderer/supervisor/protocol';

function lane(partial?: Partial<SupervisorLane>): SupervisorLane {
  return {
    id: 'lane-a',
    label: 'Auth',
    surfaceId: 'surf-a' as any,
    enabled: true,
    maxAutoSteps: 5,
    autoStepsUsed: 0,
    awaitingStopCheck: false,
    stopConfirmed: false,
    steps: [
      { id: 's1', title: 'types', prompt: 'Do types only', status: 'pending' },
      { id: 's2', title: 'helper', prompt: 'Do helper', status: 'pending' },
    ],
    ...partial,
  };
}

function session(partial?: Partial<SupervisorSession>): SupervisorSession {
  return {
    ...createDefaultSupervisorSession(),
    mode: 'direct',
    idleStableMs: 1000,
    lanes: [lane()],
    ...partial,
  };
}

describe('supervisor-engine', () => {
  it('mayDispatch only idle (or unknown if allowed)', () => {
    expect(mayDispatch('idle', false)).toBe(true);
    expect(mayDispatch('working', false)).toBe(false);
    expect(mayDispatch('blocked', false)).toBe(false);
    expect(mayDispatch('unknown', false)).toBe(false);
    expect(mayDispatch('unknown', true)).toBe(true);
  });

  it('getNextOpenStep skips completed', () => {
    const l = lane({
      steps: [
        { id: 's1', prompt: 'a', status: 'completed' },
        { id: 's2', prompt: 'b', status: 'pending' },
      ],
    });
    expect(getNextOpenStep(l)?.step.id).toBe('s2');
  });

  it('direct mode injects verbatim with no frame', () => {
    const text = buildInjectedPrompt({
      session: session({ mode: 'direct', stopWhen: 'tests green' }),
      lane: lane(),
      step: { id: 's1', prompt: '只改 auth 模块' },
      stepIndex: 1,
      stepCount: 2,
    });
    expect(text).toBe('只改 auth 模块');
    expect(text).not.toContain('停止');
    expect(text).not.toContain('wmux-supervisor');
  });

  it('direct mode dispatches raw text on idle', () => {
    const { actions } = tickLane({
      session: session({ mode: 'direct' }),
      lane: lane(),
      surfaceState: { state: 'idle' },
      runtime: blankRuntime(),
      now: 10_000,
      hasPendingApproval: false,
    });
    const d = actions.find((a) => a.type === 'dispatch');
    expect(d && d.type === 'dispatch' && d.text).toBe('Do types only');
  });

  it('waits for the supervisor decision after a worker turn ends', () => {
    const { actions } = tickLane({
      session: session({ mode: 'direct' }),
      lane: lane({ awaitingReview: true }),
      surfaceState: { state: 'idle' },
      runtime: blankRuntime(),
      now: 10_000,
      hasPendingApproval: false,
    });
    expect(actions).toEqual([]);
  });

  it('blocked notifies user and does not dispatch', () => {
    const { actions, runtime } = tickLane({
      session: session({ mode: 'direct' }),
      lane: lane(),
      surfaceState: { state: 'blocked', blockedReason: 'permission' },
      runtime: blankRuntime(),
      now: 10_000,
      hasPendingApproval: false,
    });
    expect(actions.some((a) => a.type === 'dispatch')).toBe(false);
    expect(actions.some((a) => a.type === 'notify_user')).toBe(true);
    expect(runtime.humanNotified).toBe(true);
  });

  it('direct queue empty requests stop check instead of auto-stop', () => {
    const { actions } = tickLane({
      session: session({
        mode: 'direct',
        stopWhen: '单测通过',
        stopWhenKind: 'concrete',
      }),
      lane: lane({ steps: [] }),
      surfaceState: { state: 'idle' },
      runtime: blankRuntime(),
      now: 10_000,
      hasPendingApproval: false,
    });
    expect(actions.some((a) => a.type === 'request_stop_check')).toBe(true);
    expect(actions.some((a) => a.type === 'notify_supervisor')).toBe(true);
    const sup = actions.find((a) => a.type === 'notify_supervisor');
    expect(sup && sup.type === 'notify_supervisor' && sup.text).toContain('条件参考: 单测通过');
    expect(sup && sup.type === 'notify_supervisor' && sup.text).toContain('可收尾用 complete');
    const n = actions.find((a) => a.type === 'notify_user');
    expect(n && n.type === 'notify_user' && n.disableLane).toBe(false);
    expect(n && n.type === 'notify_user' && n.detail).toContain('单测通过');
    expect(actions.some((a) => a.type === 'dispatch')).toBe(false);
  });

  it('direct stop check keeps the direction reference compact', () => {
    const { actions } = tickLane({
      session: session({
        mode: 'direct',
        stopWhen: '登录可用',
        stopWhenKind: 'direction',
      }),
      lane: lane({ steps: [] }),
      surfaceState: { state: 'idle' },
      runtime: blankRuntime(),
      now: 10_000,
      hasPendingApproval: false,
    });
    const sup = actions.find((a) => a.type === 'notify_supervisor');
    expect(sup && sup.type === 'notify_supervisor' && sup.text).toContain('条件参考: 登录可用');
    expect(sup && sup.type === 'notify_supervisor' && sup.text).toContain('wmux supervisor decide');
  });

  it('direct awaiting stop check does not re-notify spam', () => {
    const { actions } = tickLane({
      session: session({ mode: 'direct', stopWhen: 'ok' }),
      lane: lane({ steps: [], awaitingStopCheck: true }),
      surfaceState: { state: 'idle' },
      runtime: blankRuntime(),
      now: 10_000,
      hasPendingApproval: false,
    });
    expect(actions.some((a) => a.type === 'request_stop_check')).toBe(false);
    expect(actions).toHaveLength(0);
  });

  it('goal-chase ensure_goal_step when no steps yet and budget left', () => {
    const { actions } = tickLane({
      session: session({
        mode: 'goal-chase',
        goal: 'ship auth',
        doneWhen: 'tests green',
        stopWhenKind: 'concrete',
      }),
      lane: lane({ steps: [], autoStepsUsed: 0, maxAutoSteps: 3 }),
      surfaceState: { state: 'idle' },
      runtime: blankRuntime(),
      now: 10_000,
      hasPendingApproval: false,
    });
    expect(actions.some((a) => a.type === 'ensure_goal_step')).toBe(true);
  });

  it('goal-chase after completed round requests doneWhen check', () => {
    const { actions } = tickLane({
      session: session({
        mode: 'goal-chase',
        goal: 'ship auth',
        doneWhen: '登录可用',
        stopWhenKind: 'direction',
      }),
      lane: lane({
        steps: [{ id: 'g1', prompt: '', status: 'completed' }],
        autoStepsUsed: 1,
        maxAutoSteps: 5,
      }),
      surfaceState: { state: 'idle' },
      runtime: blankRuntime(),
      now: 10_000,
      hasPendingApproval: false,
    });
    expect(actions.some((a) => a.type === 'request_stop_check')).toBe(true);
    const sup = actions.find((a) => a.type === 'notify_supervisor');
    expect(sup && sup.type === 'notify_supervisor' && sup.text).toContain('条件参考: 登录可用');
    expect(sup && sup.type === 'notify_supervisor' && sup.text).toContain('目标追逐');
  });

  it('goal-chase budget exhausted notifies user', () => {
    const { actions } = tickLane({
      session: session({ mode: 'goal-chase', doneWhen: 'PR ready' }),
      lane: lane({ steps: [], autoStepsUsed: 5, maxAutoSteps: 5 }),
      surfaceState: { state: 'idle' },
      runtime: blankRuntime(),
      now: 10_000,
      hasPendingApproval: false,
    });
    expect(actions.some((a) => a.type === 'notify_user')).toBe(true);
  });

  it('completes in_progress after idle stable + sawWorking', () => {
    const rt = blankRuntime();
    rt.inProgressSince = 0;
    rt.sawWorking = true;
    const { actions } = tickLane({
      session: session({ idleStableMs: 1000 }),
      lane: lane({
        steps: [{ id: 's1', prompt: 'x', status: 'in_progress' }],
      }),
      surfaceState: { state: 'idle' },
      runtime: rt,
      now: 5000,
      hasPendingApproval: false,
    });
    expect(actions.some((a) => a.type === 'complete_step' && a.stepId === 's1')).toBe(true);
  });
});
