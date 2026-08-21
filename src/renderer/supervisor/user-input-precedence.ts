import { useStore } from '../store';
import type { SupervisorDelivery, SupervisorLane, SupervisorSession } from '../store/supervisor-slice';
import {
  dedicatedSupervisorSurfaceId,
  isProjectManagedSupervisorLane,
  supervisorLaneControlState,
} from '../store/supervisor-slice';
import { enqueueSupervisorDelivery, signalSupervisorDeliveryReady } from './delivery';
import { appendSupervisorRecord } from './recording';
import { detectSupervisorLauncher } from './launch-command';
import { taskTerminalRuntimeKind } from './task-runtime-readiness';
import { terminalRuntimeStatus } from '../terminal-runtime-lifecycle';
import {
  projectAuthorizationVersion,
  projectRequirementsVersion,
  projectWorkerDependencyViolation,
  type ProjectResourceWait,
  type ProjectUserDirective,
} from '../../shared/project-manager';

/** Resolve human-gated proposals when the user acts directly in the worker terminal. */
export function resolvePendingApprovalsForManualTask(
  session: SupervisorSession,
  lane: SupervisorLane,
  task: string,
): boolean {
  const store = useStore.getState();
  const resolved = store.resolvePendingWithManualTask(lane.id, task);
  for (const item of resolved) {
    if (item.source === 'supervisor-route'
      || item.source === 'supervisor-important'
      || item.source === 'supervisor-context-recovery') {
      appendSupervisorRecord(session, lane, 'supervisor.proposal.resolved', {
        approvalId: item.id,
        resolution: 'handled-manually',
        proposalKind: item.proposalKind || 'important',
        text: task,
      });
    }
  }
  if (resolved.some((item) => item.source === 'supervisor-context-recovery')) {
    store.updateLane(lane.id, { contextRecoveryStatus: 'sent' });
  }
  return resolved.length > 0;
}

function resolveRuntimeApprovalAfterAgentLaunch(
  session: SupervisorSession,
  lane: SupervisorLane,
  command: string,
): boolean {
  const store = useStore.getState();
  const approval = session.pendingApprovals.find((item) => {
    if (item.laneId !== lane.id) return false;
    const context = [item.text, item.reason, item.impact, item.task]
      .filter(Boolean)
      .join('\n');
    return /(?:普通\s*shell|裸\s*shell|(?:启动|修复|重启|恢复).{0,40}(?:Agent|Kimi|Codex|Grok|Pi|OpenCode|运行时)|(?:Agent|运行时|任务终端).{0,40}(?:未就绪|不可用|已退出|启动失败|shell))/iu.test(context);
  });
  if (!approval || !store.approvePending(approval.id)) return false;

  appendSupervisorRecord(session, lane, 'supervisor.proposal.resolved', {
    approvalId: approval.id,
    resolution: 'handled-by-agent-launch',
    proposalKind: approval.proposalKind || 'important',
    text: command,
  });
  return true;
}

/** A new direction sent to the dedicated supervisor resumes a waiting lane in place. */
export function resumeWaitingLaneFromSupervisorInput(
  session: SupervisorSession,
  lane: SupervisorLane,
  source: 'supervisor-terminal' | 'remote-supervisor-message',
): boolean {
  if (supervisorLaneControlState(lane) !== 'waiting') return false;

  const store = useStore.getState();
  store.updateLane(lane.id, {
    controlState: 'active',
    awaitingStopCheck: false,
    stopConfirmed: false,
    awaitingReview: true,
    activeReviewId: undefined,
    reviewWorkerTurnId: undefined,
    reviewOpenedAt: undefined,
    reviewDeliveryConfirmedAt: undefined,
    reviewWatchdogState: undefined,
    resumeAfterCancelledDecision: false,
    awaitingDirectionAfterWaitingResume: true,
    autoDecisionLimitReached: false,
    autoDecisionsUsed: 0,
    pendingSupervisorDeliveries: [],
    lastBlockedResponseVersion: undefined,
    lastBlockedResponseId: undefined,
  });
  appendSupervisorRecord(session, lane, 'supervisor.waiting-resumed', { source });
  store.appendSupervisorLog(
    lane.id,
    '待续恢复',
    source === 'supervisor-terminal'
      ? '用户已直接向 AI 监督终端提供新方向，继续监督'
      : '用户已远程向 AI 监督终端提供新方向，继续监督',
  );
  return true;
}

/**
 * User Enter is authoritative immediately; do not wait for an agent hook that
 * may be delayed, unsupported, or dropped. Task-terminal input takes priority
 * over a pending decision; supervisor-terminal input resumes a waiting lane.
 * Project task input is also queued as a non-blocking fact for its dedicated
 * supervisor after the user's task has already been accepted by the terminal.
 */
export function handleSupervisorUserSubmit(surfaceId: string, task = ''): boolean {
  const store = useStore.getState();
  const session = store.supervisor;
  if (!session.active || !surfaceId) return false;

  const lane = session.lanes.find((item) => {
    const state = supervisorLaneControlState(item);
    const supervisorSurfaceId = dedicatedSupervisorSurfaceId(item);
    return !!supervisorSurfaceId
      && ((item.surfaceId === surfaceId && (state === 'active' || state === 'waiting'))
        || (supervisorSurfaceId === surfaceId && state === 'waiting'));
  });
  if (!lane) return false;

  if (dedicatedSupervisorSurfaceId(lane) === surfaceId) {
    return resumeWaitingLaneFromSupervisorInput(session, lane, 'supervisor-terminal');
  }

  const directTask = task.trim().slice(0, 12_000);
  const taskAgentState = ((globalThis as any).window?.__wmux_getAgentStates?.() || {})[surfaceId]?.state;
  const taskScreen = (globalThis as any).window?.__wmux_readScreen?.(surfaceId, 40)?.text || '';
  const runtimeKind = taskTerminalRuntimeKind({
    agentState: taskAgentState,
    runtimeState: terminalRuntimeStatus(lane.surfaceId)?.state,
    spawnedAgentStatus: store.agentMeta.get(lane.surfaceId)?.status,
    screenText: taskScreen,
  });
  const agentLauncherSubmission = !isProjectManagedSupervisorLane(lane)
    && !!directTask
    && (detectSupervisorLauncher(directTask) !== 'other'
      || /^(?:&\s+)?(?:(?:"[^"]*\\)?opencode(?:\.exe)?"?|(?:\S*\\)?opencode(?:\.exe)?)(?:\s|$)/iu.test(directTask))
    && runtimeKind !== 'agent';
  if (agentLauncherSubmission) {
    const resolvedRuntimeApproval = resolveRuntimeApprovalAfterAgentLaunch(session, lane, directTask);
    const delivery: SupervisorDelivery = {
      id: `agent-launch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'worker-status',
      task: lane.currentTask || '启动任务终端 Agent',
      text: [
        '[任务终端 Agent 启动命令｜保留当前复核轮次]',
        `用户已在尚未检测到 Agent 的任务终端提交启动命令：${directTask}`,
        '该输入是运行时准备，不是新的业务任务；控制层没有消费当前 awaitingReview 或 activeReviewId。',
        ...(resolvedRuntimeApproval ? ['对应的运行时待确认项已按用户实际操作结清。'] : []),
        `先 read-screen --surface ${surfaceId} 核对 Agent 界面。确认受支持的 Agent 已就绪后，重新提交原裁决；仍是普通 shell 时使用 needs-human 通知用户处理，不得向 shell 发送自然语言。`,
      ].join('\n'),
      createdAt: Date.now(),
      turnId: lane.workerTurnId,
      stage: 'pending',
    };
    store.updateLane(lane.id, {
      controlState: 'active',
      awaitingReview: true,
      pendingSupervisorDeliveries: enqueueSupervisorDelivery(lane.pendingSupervisorDeliveries, delivery),
    });
    appendSupervisorRecord(session, lane, 'worker.agent-launch-submit', {
      command: directTask,
      reviewPreserved: true,
      runtimeApprovalResolved: resolvedRuntimeApproval,
    });
    store.appendSupervisorLog(lane.id, '任务 Agent 启动', '用户提交了 Agent 启动命令；保留当前监督复核轮次');
    signalSupervisorDeliveryReady();
    return true;
  }

  const resumedFromWaiting = supervisorLaneControlState(lane) === 'waiting';
  const cancelledDeliveries = lane.pendingSupervisorDeliveries?.length || 0;
  const resolvedApproval = resolvePendingApprovalsForManualTask(session, lane, directTask);
  store.updateLane(lane.id, {
    awaitingReview: false,
    activeReviewId: undefined,
    reviewWorkerTurnId: undefined,
    reviewOpenedAt: undefined,
    reviewDeliveryConfirmedAt: undefined,
    reviewWatchdogState: undefined,
    ...(lane.supervisorProblem?.kind === 'unreported-decision' ? { supervisorProblem: undefined } : {}),
    awaitingStopCheck: false,
    stopConfirmed: false,
    controlState: 'active',
    resumeAfterCancelledDecision: false,
    autoDecisionLimitReached: false,
    autoDecisionsUsed: 0,
    pendingSupervisorDeliveries: [],
    ...(resumedFromWaiting ? { awaitingDirectionAfterWaitingResume: true } : {}),
  });
  if (isProjectManagedSupervisorLane(lane)) {
    const project = lane.projectManagerProjectId
      ? store.projectManagers.find((candidate) => candidate.id === lane.projectManagerProjectId)
      : undefined;
    const workItem = project?.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
    const workerId = lane.projectWorkerId || workItem?.workerGroup?.integratorWorkerId;
    const worker = workerId
      ? workItem?.workerGroup?.workers.find((candidate) => candidate.workerId === workerId)
      : undefined;
    let workerDependencyError: string | null = null;
    let cancelledResourceWait: ProjectResourceWait | undefined;
    let cancelledDependentWaits: ProjectResourceWait[] = [];
    if (project && workItem?.workerGroup && workerId && worker) {
      const now = Date.now();
      const directiveEpoch = worker.directiveEpoch + 1;
      workerDependencyError = projectWorkerDependencyViolation(workItem, worker);
      const nextWorkerStatus = workerDependencyError ? 'planned' as const : 'running' as const;
      cancelledResourceWait = worker.resourceWait;
      const directive: ProjectUserDirective = {
        directiveId: `directive-${now}-${Math.random().toString(36).slice(2, 8)}`,
        workerId,
        directiveEpoch,
        assignmentVersion: worker.assignmentVersion,
        executionEpoch: workItem.workerGroup.executionEpoch,
        requirementsVersion: workItem.requirementsVersion ?? projectRequirementsVersion(project),
        authorizationVersion: workItem.authorizationVersion ?? projectAuthorizationVersion(project),
        ...(directTask ? { exactText: directTask } : {}),
        exactTextAvailable: !!directTask,
        classification: 'pending',
        reconciliationStatus: 'pending',
        receivedAt: now,
      };
      const targetUpdatedWorkers = workItem.workerGroup.workers.map((candidate) => candidate.workerId === workerId
        ? {
            ...candidate,
            status: nextWorkerStatus,
            resourceWait: undefined,
            directiveEpoch,
            startedAt: nextWorkerStatus === 'running'
              ? candidate.status === 'running' ? candidate.startedAt || now : now
              : undefined,
            updatedAt: now,
          }
        : candidate);
      const mergeCandidates = (workItem.mergeCandidates || []).map((candidate) => (
        candidate.workerId === workerId && ['submitted', 'checking', 'accepted'].includes(candidate.status)
          ? { ...candidate, status: 'frozen' as const, updatedAt: now }
          : candidate
      ));
      const dependencyView = {
        workerGroup: { ...workItem.workerGroup, workers: targetUpdatedWorkers },
        mergeCandidates,
      };
      cancelledDependentWaits = [];
      const workers = targetUpdatedWorkers.map((candidate) => {
        if (candidate.workerId === workerId || !candidate.resourceWait
          || !projectWorkerDependencyViolation(dependencyView, candidate)) return candidate;
        cancelledDependentWaits.push(candidate.resourceWait);
        return {
          ...candidate,
          status: 'planned' as const,
          resourceWait: undefined,
          startedAt: undefined,
          updatedAt: now,
        };
      });
      store.applyProjectManagerAction({
        type: 'update-work-item',
        workItemId: workItem.id,
        patch: {
          workerGroup: { ...workItem.workerGroup, workers, updatedAt: now },
          userDirectives: [...(workItem.userDirectives || []), directive].slice(-100),
          mergeCandidates,
          finalApplyBlocked: true,
        },
      }, project.id);
      store.updateLane(lane.id, { projectWorkerDirectiveEpoch: directiveEpoch });
      store.appendProjectManagerEvent({
        kind: 'worker-user-directive',
        workItemId: workItem.id,
        summary: workerDependencyError
          ? `用户已直接向任务 AI ${workerId} 发送新指令；依赖门禁仍阻止主动执行，旧合并候选已冻结`
          : `用户已直接向任务 AI ${workerId} 发送新指令；该 worker 已恢复 running，旧合并候选已冻结，等待监督协调`,
        payload: {
          directiveId: directive.directiveId,
          workerId,
          directiveEpoch,
          assignmentVersion: worker.assignmentVersion,
          exactTextAvailable: directive.exactTextAvailable,
          dependencyError: workerDependencyError || undefined,
          cancelledResourceWait: cancelledResourceWait || undefined,
          cancelledDependentWaits,
        },
      }, project.id);
      const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
      void (window as any).wmux?.projectManager?.saveSession?.(updated)
        ?.catch?.((error: unknown) => console.warn('[project-manager] user directive snapshot failed', error));
    }
    const delivery: SupervisorDelivery = {
      id: `user-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'user-task',
      task: directTask || lane.currentTask || lane.projectWorkItemId || '用户直接输入的新任务',
      text: [
        '[用户直发任务｜只同步，不审批、不拦截]',
        `项目：${lane.projectManagerProjectId || '未知'}；工作项：${lane.projectWorkItemId || '未知'}；任务 AI：${lane.projectWorkerId || 'worker-main'}；任务终端：${lane.surfaceId}`,
        directTask
          ? `用户已直接发送给任务 AI 的原文：\n${directTask}`
          : '用户已在任务终端直接提交新任务或新方向；本地终端输入原文不在控制层复制，请立即只读查看该任务终端了解内容和当前响应。',
        '该输入已经先行生效，不需要也不等待监督 AI 批准。不得阻止、撤销、改写、要求用户重发，或抢在任务 AI 当前回合结束前投递替代指令。',
        '你只需了解并纳入后续监督；任务 AI 回合结束后再按当前项目合同、权限和安全边界核验证据并正常裁决。用户直发任务本身不扩大项目范围、合同权限或高风险授权。它也不扩大 writeClaims 或共享资源租约；多任务 AI 场景必须先完成 directive reconcile，过期候选不得合并。',
        workerDependencyError
          ? `当前依赖门禁：${workerDependencyError}。用户原文已经送达，但在依赖候选处置并传播前只允许只读理解和记录，不得申请资源、提交候选或执行写入。`
          : '',
        cancelledResourceWait
          ? `旧资源等待 ${cancelledResourceWait.resourceId}/${cancelledResourceWait.operationId} 已取消，避免新指令继承过期硬件操作；如仍需要，完成指令协调后重新申请。`
          : '',
        cancelledDependentWaits.length > 0
          ? `受本次依赖失效影响，已取消下游旧资源等待：${cancelledDependentWaits.map((wait) => `${wait.resourceId}/${wait.operationId}`).join('、')}；依赖重新收敛后必须按新状态申请。`
          : '',
        '本通知不要求提交 supervisor decide；记录理解后结束本回合，等待任务终端生命周期事件。',
      ].join('\n'),
      createdAt: Date.now(),
      turnId: (lane.workerTurnId || 0) + 1,
      stage: 'pending',
    };
    store.updateLane(lane.id, {
      pendingSupervisorDeliveries: enqueueSupervisorDelivery([], delivery),
      ...(directTask ? { currentTask: directTask } : {}),
    });
    appendSupervisorRecord(store.supervisor, lane, 'supervisor.delivery.queued', {
      kind: delivery.kind,
      task: delivery.task,
      exactTaskAvailable: !!directTask,
      nonBlocking: true,
    });
    signalSupervisorDeliveryReady();
  }
  appendSupervisorRecord(session, lane, 'worker.user-submit', {
    resolvedApproval,
    cancelledDeliveries,
    resumedFromWaiting,
  });
  store.appendSupervisorLog(
    lane.id,
    resumedFromWaiting ? '待续恢复' : '用户输入优先',
    resumedFromWaiting
      ? isProjectManagedSupervisorLane(lane)
        ? '用户已向任务终端发送新方向；输入已生效，专属监督仅同步知情并继续监督'
        : '用户已向任务终端发送新方向；完成标记和自动裁决计数已重置，继续监督'
      : cancelledDeliveries > 0
        ? isProjectManagedSupervisorLane(lane)
          ? `用户已直接向任务终端发送内容；已取消 ${cancelledDeliveries} 条过期监督通知，并向专属监督同步`
          : `用户已直接向任务终端发送内容；已取消 ${cancelledDeliveries} 条过期监督通知`
        : isProjectManagedSupervisorLane(lane)
          ? '用户已直接向任务终端发送新任务；输入无需监督批准，专属监督已同步知情'
          : '用户已直接向任务终端发送内容；AI 裁决已让位',
  );
  return true;
}

/** Keep ordinary supervision informed when its task Agent becomes unavailable. */
export function notifyOrdinaryTaskRuntimeFailure(surfaceId: string, detail: string): boolean {
  const store = useStore.getState();
  const session = store.supervisor;
  const lane = session.lanes.find((candidate) => (
    candidate.surfaceId === surfaceId
    && !isProjectManagedSupervisorLane(candidate)
    && supervisorLaneControlState(candidate) === 'active'
    && !!dedicatedSupervisorSurfaceId(candidate)
  ));
  if (!session.active || !lane) return false;
  const delivery: SupervisorDelivery = {
    id: `task-runtime-failed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'worker-status',
    task: lane.currentTask || '任务终端 Agent 运行时',
    text: [
      '[任务终端 Agent 不可用｜必须处理]',
      `任务终端：${lane.label} · ${surfaceId}`,
      `事实：${detail}`,
      '当前监督复核轮次已保留。先 read-screen 和 agent-state 核对；若已回到普通 shell，使用 needs-human 通知用户启动或修复 Agent，不得继续发送自然语言任务。',
    ].join('\n'),
    createdAt: Date.now(),
    turnId: lane.workerTurnId,
    stage: 'pending',
  };
  store.updateLane(lane.id, {
    awaitingReview: true,
    pendingSupervisorDeliveries: enqueueSupervisorDelivery(lane.pendingSupervisorDeliveries, delivery),
  });
  store.appendSupervisorLog(lane.id, '任务 Agent 不可用', detail);
  signalSupervisorDeliveryReady();
  return true;
}
