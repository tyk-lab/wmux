import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  handleSupervisorUserSubmit,
  notifyOrdinaryTaskRuntimeFailure,
} from '../../src/renderer/supervisor/user-input-precedence';
import { useStore } from '../../src/renderer/store';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';
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

  it('preserves the review when the user starts an Agent in a bare shell', () => {
    const store = useStore.getState();
    store.updateLane('lane-user', { activeReviewId: 'review-shell-start' });
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      'worker-user': { state: 'unknown' },
    });
    (globalThis.window as any).__wmux_readScreen = () => ({ text: 'PS E:\\repo> kimi' });

    expect(handleSupervisorUserSubmit('worker-user', 'kimi')).toBe(true);

    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      activeReviewId: 'review-shell-start',
      pendingSupervisorDeliveries: expect.arrayContaining([
        expect.objectContaining({
          kind: 'worker-status',
          text: expect.stringContaining('保留当前复核轮次'),
        }),
      ]),
    });
    expect(useStore.getState().supervisor.log[0]).toMatchObject({
      action: '任务 Agent 启动',
    });
  });

  it('resolves only a runtime approval when the user starts the requested Agent', () => {
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

    expect(useStore.getState().supervisor.pendingApprovals).toEqual([]);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      activeReviewId: 'review-runtime-approval',
    });
    expect(useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('运行时待确认项已按用户实际操作结清'),
        }),
      ]));
  });

  it('queues an ordinary task runtime failure for the dedicated supervisor', () => {
    expect(notifyOrdinaryTaskRuntimeFailure('worker-user', 'Agent 已退出到 PowerShell')).toBe(true);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'active',
      awaitingReview: true,
      pendingSupervisorDeliveries: expect.arrayContaining([
        expect.objectContaining({
          kind: 'worker-status',
          text: expect.stringContaining('Agent 已退出到 PowerShell'),
        }),
      ]),
    });
  });

  it('reopens a completed worker and advances its directive epoch for direct user work', () => {
    const store = useStore.getState();
    const project = store.startProjectManager({
      projectDir: 'E:\\repo', goal: '完成项目', doneWhen: ['完成'],
    });
    store.applyProjectManagerAction({
      type: 'create-work-item',
      workItem: {
        id: 'task-user',
        title: 'task-user',
        status: 'running',
        dependencies: [],
        attempts: 0,
        decisionsUsed: 0,
        executionHistory: [],
        updatedAt: 1,
        contract: {
          objective: '完成项目任务',
          description: '',
          preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: ['src', 'tests'], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false },
          stopWhen: ['完成'],
          validation: ['检查结果'],
          budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    }, project.id);
    const assignments: ProjectWorkerAssignment[] = [
      {
        workerId: 'worker-main', role: 'integrator', outcome: '集成', dependencies: ['worker-tests'],
        writeClaims: ['src'], resourceClaims: [], validation: ['检查'],
      },
      {
        workerId: 'worker-tests', role: 'worker', outcome: '测试', dependencies: [],
        writeClaims: ['tests'], resourceClaims: [], validation: ['测试'],
      },
    ];
    const decision = resolveProjectParallelismDecision({
      execution: {
        taskWorkMode: 'single-thread', parallelismSelection: 'worker-group', modeReason: '测试',
        mainThreadResponsibility: '集成', childThreadResponsibilities: [],
      },
      stagePlan: { workerAssignments: assignments },
      requirementsVersion: 1,
    });
    const group = createProjectWorkerGroup({ decision, assignments, now: 10 });
    group.workers = group.workers.map((worker) => ({
      ...worker,
      status: worker.workerId === 'worker-main' ? 'waiting-resource' : 'completed',
      resourceWait: worker.workerId === 'worker-main'
        ? {
            resourceId: 'device-main', mode: 'exclusive-write' as const,
            operationId: 'integrate-old', idempotent: false, requestedAt: 9,
          }
        : undefined,
      startedAt: undefined,
    }));
    store.applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: 'task-user',
      patch: { workerGroup: group, parallelismDecision: decision, finalApplyBlocked: false },
    }, project.id);
    store.setOrdinarySupervisorLanes([]);
    store.setProjectSupervisorLanes([{
      ...workerLane(),
      projectManagerProjectId: project.id,
      projectWorkItemId: 'task-user',
      projectWorkerId: 'worker-tests',
      projectWorkerRole: 'worker',
      projectWorkerExecutionEpoch: decision.executionEpoch,
    }]);
    store.startProjectSupervisor(['lane-user']);

    expect(handleSupervisorUserSubmit('worker-user', '补充新的测试')).toBe(true);

    const updated = useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)?.workItems[0];
    const worker = updated?.workerGroup?.workers.find((candidate) => candidate.workerId === 'worker-tests');
    expect(worker).toMatchObject({ status: 'running', directiveEpoch: 1 });
    expect(worker?.startedAt).toEqual(expect.any(Number));
    expect(updated?.finalApplyBlocked).toBe(true);
    expect(updated?.userDirectives?.[0]).toMatchObject({
      workerId: 'worker-tests', directiveEpoch: 1, reconciliationStatus: 'pending',
    });
    expect(updated?.workerGroup?.workers.find((candidate) => candidate.workerId === 'worker-main'))
      .toMatchObject({ status: 'planned', resourceWait: undefined });
    expect(useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries?.[0]?.text)
      .toContain('下游旧资源等待：device-main/integrate-old');

    store.applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: 'task-user',
      patch: {
        workerGroup: {
          ...updated!.workerGroup!,
          workers: updated!.workerGroup!.workers.map((candidate) => candidate.workerId === 'worker-tests'
            ? {
                ...candidate,
                status: 'waiting-resource' as const,
                resourceWait: {
                  resourceId: 'device-a', mode: 'exclusive-write' as const,
                  operationId: 'flash-old', idempotent: false, requestedAt: 20,
                },
              }
            : candidate),
        },
      },
    }, project.id);
    expect(handleSupervisorUserSubmit('worker-user', '改做新的安全检查')).toBe(true);
    const afterWaitCancelled = useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)?.workItems[0];
    expect(afterWaitCancelled?.workerGroup?.workers.find((candidate) => candidate.workerId === 'worker-tests'))
      .toMatchObject({ status: 'running', directiveEpoch: 2, resourceWait: undefined });
    expect(useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries?.[0]?.text)
      .toContain('旧资源等待 device-a/flash-old 已取消');

    store.updateLane('lane-user', { projectWorkerId: 'worker-main', projectWorkerRole: 'integrator' });
    expect(handleSupervisorUserSubmit('worker-user', '继续最终集成')).toBe(true);
    const afterBlockedDirect = useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)?.workItems[0];
    expect(afterBlockedDirect?.workerGroup?.workers.find((candidate) => candidate.workerId === 'worker-main'))
      .toMatchObject({ status: 'planned', directiveEpoch: 1, startedAt: undefined });
    expect(useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries?.[0]?.text)
      .toContain('当前依赖门禁');
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
