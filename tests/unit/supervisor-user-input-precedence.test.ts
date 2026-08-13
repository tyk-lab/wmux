import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleSupervisorUserSubmit } from '../../src/renderer/supervisor/user-input-precedence';
import { useStore } from '../../src/renderer/store';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';

const workerLane = (): SupervisorLane => ({
  id: 'lane-user',
  label: 'worker',
  surfaceId: 'worker-user' as any,
  supervisorSurfaceId: 'supervisor-user' as any,
  enabled: true,
  steps: [],
  maxAutoSteps: 0,
  autoStepsUsed: 0,
  awaitingStopCheck: true,
  stopConfirmed: false,
  awaitingReview: true,
  autoDecisionLimitReached: true,
  autoDecisionsUsed: 3,
  pendingSupervisorDeliveries: [{
    id: 'delivery-old',
    kind: 'task-end',
    text: 'review old turn',
    task: 'old task',
    createdAt: 1,
    turnId: 1,
  }],
});

describe('supervisor user input precedence', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { wmux: {} },
    });
    const store = useStore.getState();
    store.resetSupervisorSession();
    store.setSupervisorLanes([workerLane()]);
    store.startSupervisor();
    store.enqueueApproval({
      laneId: 'lane-user',
      surfaceId: 'worker-user' as any,
      laneLabel: 'worker',
      text: 'AI proposal',
      source: 'supervisor-important',
      proposalKind: 'important',
      reason: 'review needed',
      task: 'old task',
    });
  });

  afterEach(() => {
    useStore.getState().resetSupervisorSession();
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('cancels stale AI review state before forwarding the user Enter', () => {
    expect(handleSupervisorUserSubmit('worker-user')).toBe(true);
    expect(useStore.getState().supervisor.pendingApprovals).toEqual([]);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: false,
      awaitingStopCheck: false,
      autoDecisionLimitReached: false,
      autoDecisionsUsed: 0,
      pendingSupervisorDeliveries: [],
    });
  });

  it('ignores unrelated terminals', () => {
    expect(handleSupervisorUserSubmit('other-worker')).toBe(false);
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
  });

  it('resumes a waiting lane and resets completion state when the user submits a new direction', () => {
    const store = useStore.getState();
    store.updateLane('lane-user', {
      enabled: true,
      controlState: 'waiting',
      stopConfirmed: true,
      awaitingReview: false,
      autoDecisionLimitReached: false,
      autoDecisionsUsed: 5,
    });

    expect(handleSupervisorUserSubmit('worker-user')).toBe(true);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      enabled: true,
      controlState: 'active',
      stopConfirmed: false,
      awaitingStopCheck: false,
      awaitingReview: false,
      autoDecisionsUsed: 0,
    });
    expect(useStore.getState().supervisor.log[0]).toMatchObject({ action: '待续恢复' });
  });
});
