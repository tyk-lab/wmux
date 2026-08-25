import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  confirmSupervisorUserSubmitFromHook,
  handleSupervisorUserSubmit,
  notifyOrdinaryTaskRuntimeFailure,
} from '../../src/renderer/supervisor/user-input-precedence';
import { useStore } from '../../src/renderer/store';
import {
  ORDINARY_SUPERVISION_PROTOCOL_VERSION,
  type SupervisorLane,
} from '../../src/renderer/store/supervisor-slice';
import {
  createProjectWorkerGroup,
  DEFAULT_PROJECT_EXECUTION_BUDGET,
  resolveProjectParallelismDecision,
  type ProjectWorkerAssignment,
} from '../../src/shared/project-manager';

const workerLane = (): SupervisorLane => ({
  id: 'lane-user',
  label: 'worker',
  surfaceId: 'worker-user' as any,
  supervisorSurfaceId: 'supervisor-user' as any,
  ordinaryProtocolVersion: ORDINARY_SUPERVISION_PROTOCOL_VERSION,
  controlState: 'active',
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
    store.setProjectSupervisorLanes([]);
    store.resetOrdinarySupervisorSession();
    store.setOrdinarySupervisorLanes([workerLane()]);
    store.startOrdinarySupervisor();
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
    const store = useStore.getState();
    store.setProjectSupervisorLanes([]);
    store.resetOrdinarySupervisorSession();
    for (const project of store.projectManagers) store.removeProjectManager(project.id);
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('waits for UserPromptSubmit before cancelling stale AI review state', () => {
    expect(handleSupervisorUserSubmit('worker-user')).toBe(true);
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
    expect(confirmSupervisorUserSubmitFromHook('worker-user', '用户确认的新任务')).toBe(true);
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
      controlState: 'waiting',
      stopConfirmed: true,
      awaitingReview: false,
      autoDecisionLimitReached: false,
      autoDecisionsUsed: 5,
    });

    expect(handleSupervisorUserSubmit('worker-user')).toBe(true);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'waiting',
      stopConfirmed: true,
      autoDecisionsUsed: 5,
    });
    expect(confirmSupervisorUserSubmitFromHook('worker-user', '继续执行')).toBe(true);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'active',
      stopConfirmed: false,
      awaitingStopCheck: false,
      awaitingReview: false,
      autoDecisionsUsed: 0,
    });
    expect(useStore.getState().supervisor.log[0]).toMatchObject({ action: '待续恢复' });
  });

  it('lets a project user task take effect first and only notifies the dedicated supervisor', () => {
    const store = useStore.getState();
    store.setOrdinarySupervisorLanes([]);
    store.setProjectSupervisorLanes([{
      ...workerLane(),
      projectManagerProjectId: 'pm-user',
      projectWorkItemId: 'task-user',
    }]);
    store.startProjectSupervisor(['lane-user']);

    expect(handleSupervisorUserSubmit('worker-user', '直接执行新的回归任务')).toBe(true);

    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
    expect(useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries?.[0]?.kind).toBe('task-end');
    expect(confirmSupervisorUserSubmitFromHook('worker-user', '直接执行新的回归任务')).toBe(true);

    expect(useStore.getState().supervisor.pendingApprovals).toEqual([]);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      currentTask: '直接执行新的回归任务',
      awaitingReview: false,
      autoDecisionLimitReached: false,
      pendingSupervisorDeliveries: [],
    });
    expect(useStore.getState().supervisor.log[0]).toMatchObject({
      action: '用户输入优先',
      detail: expect.stringContaining('并向专属监督同步'),
    });
  });  it('resolves only a runtime approval when the user starts the requested Agent', () => {
    const store = useStore.getState();
    store.updateLane('lane-user', { activeReviewId: 'review-runtime-approval' });
    store.enqueueApproval({
      laneId: 'lane-user',
      surfaceId: 'worker-user' as any,
      laneLabel: 'worker',
      text: '任务终端仍是普通 shell，请先启动 Kimi Agent',
      source: 'supervisor-important',
      proposalKind: 'important',
      reason: '任务运行时未就绪',
      task: '启动任务 Agent',
    });
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      'worker-user': { state: 'unknown' },
    });
    (globalThis.window as any).__wmux_readScreen = () => ({ text: 'PS E:\\repo> kimi' });

    expect(handleSupervisorUserSubmit('worker-user', 'kimi')).toBe(true);

    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      activeReviewId: 'review-runtime-approval',
    });
    expect(useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('保留当前 awaitingReview、activeReviewId 和待确认项'),
        }),
      ]));

    expect(handleSupervisorUserSubmit('worker-user')).toBe(true);
    expect(confirmSupervisorUserSubmitFromHook('worker-user', '继续原任务')).toBe(true);
    expect(useStore.getState().supervisor.pendingApprovals).toEqual([]);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: false,
      activeReviewId: undefined,
    });
  });  it('does not queue a duplicate user-task before App handles the authoritative UserPromptSubmit hook', () => {
    const store = useStore.getState();
    store.setOrdinarySupervisorLanes([]);
    store.setProjectSupervisorLanes([{
      ...workerLane(),
      projectManagerProjectId: 'pm-user',
      projectWorkItemId: 'task-user',
    }]);
    store.startProjectSupervisor(['lane-user']);

    expect(handleSupervisorUserSubmit('worker-user')).toBe(true);

    expect(useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries?.[0]?.kind).toBe('task-end');
    expect(confirmSupervisorUserSubmitFromHook('worker-user', '终端确认的新任务')).toBe(true);

    expect(useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries).toEqual([]);
  });

  it('resumes a waiting lane when the user submits a new direction in its AI supervisor terminal', () => {
    const store = useStore.getState();
    store.rejectPending(store.supervisor.pendingApprovals[0].id);
    store.updateLane('lane-user', {
      controlState: 'waiting',
      stopConfirmed: true,
      awaitingReview: false,
      autoDecisionsUsed: 5,
    });

    expect(handleSupervisorUserSubmit('supervisor-user')).toBe(true);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'active',
      stopConfirmed: false,
      awaitingStopCheck: false,
      awaitingReview: true,
      awaitingDirectionAfterWaitingResume: true,
      autoDecisionsUsed: 0,
    });
    expect(useStore.getState().supervisor.log[0]).toMatchObject({
      action: '待续恢复',
      detail: '用户已直接向 AI 监督终端提供新方向，继续监督',
    });
  });

  it('does not alter an active lane for ordinary input in its AI supervisor terminal', () => {
    const before = useStore.getState().supervisor.lanes[0];

    expect(handleSupervisorUserSubmit('supervisor-user')).toBe(false);
    expect(useStore.getState().supervisor.lanes[0]).toEqual(before);
  });

  it('lets supervisor-terminal user input cancel an unconfirmed automated draft', () => {
    const store = useStore.getState();
    store.updateLane('lane-user', {
      pendingSupervisorDeliveries: [{
        id: 'delivery-submitted',
        kind: 'control-message',
        text: '自动恢复说明',
        task: '恢复监督',
        createdAt: 1,
        stage: 'submitted',
        submittedAt: 2,
      }],
    });

    expect(handleSupervisorUserSubmit('supervisor-user')).toBe(true);
    expect(useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries).toEqual([]);
    expect(useStore.getState().supervisor.log[0]).toMatchObject({
      action: '监督通知已让位',
      detail: expect.stringContaining('取消未确认的自动投递'),
    });
  });
});
