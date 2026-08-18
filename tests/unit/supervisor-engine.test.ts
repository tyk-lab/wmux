import { describe, expect, it } from 'vitest';
import {
  blankRuntime,
  pasteSubmitDelayMs,
  SUPERVISOR_TUI_READY_DELAY_MS,
  tickLane,
} from '../../src/renderer/supervisor/supervisor-engine';
import {
  createDefaultSupervisorSession,
  type SupervisorLane,
  type SupervisorSession,
} from '../../src/renderer/store/supervisor-slice';

function lane(partial?: Partial<SupervisorLane>): SupervisorLane {
  return {
    id: 'lane-a',
    label: 'Auth',
    surfaceId: 'surf-a' as any,
    controlState: 'active',
    awaitingStopCheck: false,
    stopConfirmed: false,
    ...partial,
  };
}

function session(partial?: Partial<SupervisorSession>): SupervisorSession {
  return {
    ...createDefaultSupervisorSession(),
    active: true,
    lanes: [lane()],
    ...partial,
  };
}

describe('supervisor-engine', () => {
  it('never invents or dispatches work while a supervised terminal is idle', () => {
    const { actions } = tickLane({
      session: session(),
      lane: lane(),
      surfaceState: { state: 'idle' },
      runtime: blankRuntime(),
      now: 10_000,
    });
    expect(actions).toEqual([]);
  });

  it('waits for the dedicated supervisor decision after a worker turn ends', () => {
    const { actions } = tickLane({
      session: session(),
      lane: lane({ awaitingReview: true }),
      surfaceState: { state: 'idle' },
      runtime: blankRuntime(),
      now: 10_000,
    });
    expect(actions).toEqual([]);
  });

  it('notifies the user when a blocked lane has no dedicated supervisor', () => {
    const { actions, runtime } = tickLane({
      session: session(),
      lane: lane(),
      surfaceState: { state: 'blocked', blockedReason: 'permission' },
      runtime: blankRuntime(),
      now: 10_000,
    });
    expect(actions.some((action) => action.type === 'notify_user')).toBe(true);
    expect(runtime.humanNotified).toBe(true);
  });

  it('waits longer before submitting a large pasted supervisor briefing', () => {
    expect(pasteSubmitDelayMs('short')).toBe(304);
    expect(pasteSubmitDelayMs('x'.repeat(1_200))).toBe(1_200);
    expect(pasteSubmitDelayMs('x'.repeat(10_000))).toBe(3_000);
    expect(SUPERVISOR_TUI_READY_DELAY_MS).toBe(2_500);
  });

  it('routes an ordinary low-risk permission prompt to its dedicated supervisor', () => {
    const supervisedLane = lane({ supervisorSurfaceId: 'supervisor-a' as any });
    const first = tickLane({
      session: session({ autonomous: false }),
      lane: supervisedLane,
      surfaceState: { state: 'blocked', blockedReason: 'permission: npm test' },
      runtime: blankRuntime(),
      now: 10_000,
    });
    const supervisorNotice = first.actions.find((action) => action.type === 'notify_supervisor');

    expect(first.actions.some((action) => action.type === 'notify_user')).toBe(false);
    expect(supervisorNotice && supervisorNotice.type === 'notify_supervisor' && supervisorNotice.text)
      .toContain('--permission-command');
    expect(supervisorNotice && supervisorNotice.type === 'notify_supervisor' && supervisorNotice.opensReview).toBe(true);
    expect(supervisorNotice && supervisorNotice.type === 'notify_supervisor' && supervisorNotice.statusEvent).toBe('blocked');
    expect(supervisorNotice && supervisorNotice.type === 'notify_supervisor' && supervisorNotice.statusDetail).toBe('permission: npm test');
    expect(first.runtime.humanNotified).toBe(false);

    const repeated = tickLane({
      session: session({ autonomous: false }),
      lane: supervisedLane,
      surfaceState: { state: 'blocked', blockedReason: 'permission: npm test' },
      runtime: first.runtime,
      now: 30_000,
    });
    const repeatedNotice = repeated.actions.find((action) => action.type === 'notify_supervisor');
    expect(repeatedNotice && repeatedNotice.type === 'notify_supervisor' && repeatedNotice.statusEvent).toBeUndefined();
  });

  it('requires human confirmation for every SSH-controlled permission request', () => {
    const { actions } = tickLane({
      session: session({ autonomous: true }),
      lane: lane({ supervisorSurfaceId: 'supervisor-a' as any, remoteSshControl: true }),
      surfaceState: { state: 'blocked', blockedReason: 'permission: npm test' },
      runtime: blankRuntime(),
      now: 10_000,
    });
    const supervisorNotice = actions.find((action) => action.type === 'notify_supervisor');
    const text = supervisorNotice && supervisorNotice.type === 'notify_supervisor'
      ? supervisorNotice.text
      : '';

    expect(text).toContain('任何权限请求都必须使用 needs-human');
    expect(text).toContain('不得通过终端转发、脚本或其他间接方式绕过');
    expect(text).not.toContain('--permission-command');
  });

  it('reports disabled permission and technical-choice capabilities to the supervisor', () => {
    const { actions } = tickLane({
      session: session({ autonomyPermissions: [] }),
      lane: lane({ supervisorSurfaceId: 'supervisor-a' as any }),
      surfaceState: { state: 'blocked', blockedReason: 'question: choose A or B' },
      runtime: blankRuntime(),
      now: 10_000,
    });
    const supervisorNotice = actions.find((action) => action.type === 'notify_supervisor');
    const text = supervisorNotice && supervisorNotice.type === 'notify_supervisor'
      ? supervisorNotice.text
      : '';

    expect(text).toContain('未勾选“低风险权限确认”');
    expect(text).toContain('未勾选“技术方案选择”');
    expect(text).toContain('必须使用 needs-human');
  });
});
