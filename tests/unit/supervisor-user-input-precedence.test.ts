import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleSupervisorUserSubmit } from '../../src/renderer/supervisor/user-input-precedence';
import { useStore } from '../../src/renderer/store';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';

const workerLane = (): SupervisorLane => ({
  id: 'lane-user',
  label: 'worker',
  surfaceId: 'worker-user' as any,
  supervisorSurfaceId: 'supervisor-user' as any,
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
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().resetOrdinarySupervisorSession();
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
      controlState: 'waiting',
      stopConfirmed: true,
      awaitingReview: false,
      autoDecisionLimitReached: false,
      autoDecisionsUsed: 5,
    });

    expect(handleSupervisorUserSubmit('worker-user')).toBe(true);
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

    expect(useStore.getState().supervisor.pendingApprovals).toEqual([]);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      currentTask: '直接执行新的回归任务',
      awaitingReview: false,
      autoDecisionLimitReached: false,
      pendingSupervisorDeliveries: [expect.objectContaining({
        kind: 'user-task',
        task: '直接执行新的回归任务',
        stage: 'pending',
      })],
    });
    const delivery = useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries?.[0];
    expect(delivery?.text).toContain('[用户直发任务｜只同步，不审批、不拦截]');
    expect(delivery?.text).toContain('该输入已经先行生效，不需要也不等待监督 AI 批准');
    expect(delivery?.text).toContain('不得阻止、撤销、改写、要求用户重发');
    expect(delivery?.text).toContain('用户直发任务本身不扩大项目范围、合同权限或高风险授权');
    expect(useStore.getState().supervisor.log[0]).toMatchObject({
      action: '用户输入优先',
      detail: expect.stringContaining('并向专属监督同步'),
    });
  });

  it('tells the supervisor to read the task terminal when local input text is not copied', () => {
    const store = useStore.getState();
    store.setOrdinarySupervisorLanes([]);
    store.setProjectSupervisorLanes([{
      ...workerLane(),
      projectManagerProjectId: 'pm-user',
      projectWorkItemId: 'task-user',
    }]);
    store.startProjectSupervisor(['lane-user']);

    expect(handleSupervisorUserSubmit('worker-user')).toBe(true);

    const delivery = useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries?.[0];
    expect(delivery).toMatchObject({ kind: 'user-task', stage: 'pending' });
    expect(delivery?.text).toContain('本地终端输入原文不在控制层复制');
    expect(delivery?.text).toContain('请立即只读查看该任务终端了解内容和当前响应');
    expect(delivery?.text).toContain('本通知不要求提交 supervisor decide');
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
});
