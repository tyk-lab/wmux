import { useStore } from '../store';
import type { SupervisorDelivery, SupervisorLane, SupervisorSession } from '../store/supervisor-slice';
import {
  dedicatedSupervisorSurfaceId,
  isProjectManagedSupervisorLane,
  supervisorLaneControlState,
} from '../store/supervisor-slice';
import { enqueueSupervisorDelivery, signalSupervisorDeliveryReady } from './delivery';
import { appendSupervisorRecord } from './recording';
import { supportedAgentLauncherExecutable } from './launch-command';
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

interface PendingTaskUserSubmit {
  submittedAt: number;
  supervisionSessionId: string;
}

const pendingTaskUserSubmits = new Map<string, PendingTaskUserSubmit>();
const USER_SUBMIT_CONFIRM_MS = 30_000;

function consumePendingTaskUserSubmit(
  laneId: string,
  supervisionSessionId: string,
  now = Date.now(),
): boolean {
  const pending = pendingTaskUserSubmits.get(laneId);
  pendingTaskUserSubmits.delete(laneId);
  return pending !== undefined
    && pending.supervisionSessionId === supervisionSessionId
    && now - pending.submittedAt <= USER_SUBMIT_CONFIRM_MS;
}

/** Block stale supervisor output while a user submission awaits Agent acceptance. */
export function hasPendingTaskUserSubmit(
  laneId: string,
  supervisionSessionId: string,
  now = Date.now(),
): boolean {
  const pending = pendingTaskUserSubmits.get(laneId);
  if (pending === undefined) return false;
  if (pending.supervisionSessionId === supervisionSessionId
    && now - pending.submittedAt <= USER_SUBMIT_CONFIRM_MS) return true;
  pendingTaskUserSubmits.delete(laneId);
  return false;
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
 * A task-terminal Enter is only an attempted submission. State changes wait for
 * the Agent's authoritative UserPromptSubmit hook; supervisor-terminal input can
 * still resume a waiting supervisor immediately.
 */
export function handleSupervisorUserSubmit(
  surfaceId: string,
  task = '',
  confirmedByLifecycleHook = false,
): boolean {
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
  const projectManaged = isProjectManagedSupervisorLane(lane);
  const agentLauncher = directTask ? supportedAgentLauncherExecutable(directTask) : null;
  if (agentLauncher && runtimeKind !== 'agent') {
    const delivery: SupervisorDelivery = {
      id: `agent-launch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'worker-status',
      task: lane.currentTask || '启动任务终端 Agent',
      text: [
        '[任务终端 Agent 启动命令｜保留当前复核轮次]',
        `用户已在尚未检测到 Agent 的任务终端尝试启动：${agentLauncher}`,
        '该输入是运行时准备，不是新的业务任务；控制层保留当前 awaitingReview、activeReviewId 和待确认项，等待运行时证据。',
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
      command: agentLauncher,
      reviewPreserved: true,
      runtimeApprovalResolved: false,
    });
    store.appendSupervisorLog(lane.id, '任务 Agent 启动', '用户提交了 Agent 启动命令；保留当前监督复核轮次');
    signalSupervisorDeliveryReady();
    return true;
  }

  if (!confirmedByLifecycleHook) {
    pendingTaskUserSubmits.set(lane.id, {
      submittedAt: Date.now(),
      supervisionSessionId: session.sessionId,
    });
    appendSupervisorRecord(session, lane, 'worker.user-submit', {
      awaitingLifecycleConfirmation: true,
    });
    store.appendSupervisorLog(lane.id, '用户输入待确认', '输入已发送到任务终端；等待 UserPromptSubmit Hook 后更新项目状态');
    return true;
  }
  if (!consumePendingTaskUserSubmit(lane.id, session.sessionId)) return false;

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
  if (projectManaged) {
    const project = lane.projectManagerProjectId
      ? store.projectManagers.find((candidate) => candidate.id === lane.projectManagerProjectId)
      : undefined;
    const workItem = project?.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
    const workerId = lane.projectWorkerId || workItem?.workerGroup?.integratorWorkerId;
    const worker = workerId
      ? workItem?.workerGroup?.workers.find((candidate) => candidate.workerId === workerId)
      : undefined;
    if (project && workItem?.workerGroup && workerId && worker) {
      const now = Date.now();
      const directiveEpoch = worker.directiveEpoch + 1;
      const workerDependencyError = projectWorkerDependencyViolation(workItem, worker);
      const nextWorkerStatus = workerDependencyError ? 'planned' as const : 'running' as const;
      const cancelledResourceWait = worker.resourceWait;
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
      const cancelledDependentWaits: ProjectResourceWait[] = [];
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
    store.updateLane(lane.id, {
      ...(directTask ? { currentTask: directTask } : {}),
    });
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

/** Apply user-input precedence only after the Agent accepted the prompt. */
export function confirmSupervisorUserSubmitFromHook(surfaceId: string, task: string): boolean {
  return handleSupervisorUserSubmit(surfaceId, task, true);
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
