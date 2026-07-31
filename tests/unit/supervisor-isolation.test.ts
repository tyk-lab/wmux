import { create } from 'zustand';
import { describe, expect, it } from 'vitest';
import { isSupervisorDecisionAuthorised } from '../../src/renderer/pipe-bridge';
import {
  createDefaultSupervisorSession,
  createSupervisorSlice,
  type SupervisorLane,
  type SupervisorSlice,
} from '../../src/renderer/store/supervisor-slice';
import { buildSupervisorBriefing, supervisorTabTitle } from '../../src/renderer/supervisor/protocol';

function lane(partial: Partial<SupervisorLane> = {}): SupervisorLane {
  return {
    id: 'lane-a',
    label: 'Auth worker',
    surfaceId: 'worker-a' as any,
    supervisorSurfaceId: 'supervisor-a' as any,
    enabled: true,
    steps: [],
    maxAutoSteps: 8,
    autoStepsUsed: 0,
    awaitingStopCheck: false,
    stopConfirmed: false,
    ...partial,
  };
}

function makeStore() {
  return create<SupervisorSlice>()((...args) => createSupervisorSlice(...args));
}

describe('supervisor isolation', () => {
  it('briefs a dedicated supervisor about one worker only', () => {
    const session = createDefaultSupervisorSession();
    const text = buildSupervisorBriefing(session, { lane: lane(), state: 'idle' });

    expect(text).toContain('worker-a');
    expect(text).toContain('只监督此终端');
    expect(text).not.toContain('worker-b');
  });

  it('only accepts a decision from the lane dedicated supervisor terminal', () => {
    const monitored = lane();

    expect(isSupervisorDecisionAuthorised(monitored, 'supervisor-a')).toBe(true);
    expect(isSupervisorDecisionAuthorised(monitored, 'supervisor-b')).toBe(false);
    expect(isSupervisorDecisionAuthorised(monitored, '')).toBe(false);
  });

  it('clears lanes and in-memory decision history when restarting from scratch', () => {
    const store = makeStore();
    store.getState().setSupervisorLanes([
      lane({ currentTask: '修复登录', decisions: [{ ts: 1, task: '修复登录', outcome: 'continue', reason: '继续', next: '' }] }),
    ]);
    store.getState().startSupervisor();

    store.getState().resetSupervisorSession();

    expect(store.getState().supervisor).toMatchObject({
      active: false,
      sessionId: '',
      lanes: [],
      log: [],
    });
  });

  it('names each visible supervisor tab after its worker lane', () => {
    expect(supervisorTabTitle('Auth worker')).toBe('AI 监督 · Auth worker');
  });
});
