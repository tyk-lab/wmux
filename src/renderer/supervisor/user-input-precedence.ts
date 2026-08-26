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
import { effectiveSupervisorLaneConfig } from './protocol';

/** Resolve human-gated proposals when the user acts directly in the worker terminal. */
export function resolvePendingApprovalsForManualTask(
  session: SupervisorSession,
  lane: SupervisorLane,
  task: string,
): boolean {
  const store = useStore.getState();
  const resolved = store.resolvePendingWithManualTask(lane.id, task);
  for (const item of resolved) {
    if (item.source === 'supervisor-route' || item.source === 'supervisor-important') {
      appendSupervisorRecord(session, lane, 'supervisor.proposal.resolved', {
        approvalId: item.id,
        resolution: 'handled-manually',
        proposalKind: item.proposalKind || 'important',
        text: task,
      });
    }
  }
  return resolved.length > 0;
}

/** Direct user text in the dedicated supervisor terminal is an owner decision. */
function resolvePendingApprovalsFromSupervisorInput(
  session: SupervisorSession,
  lane: SupervisorLane,
  guidance: string,
): string[] {
  const store = useStore.getState();
  const pending = session.pendingApprovals.filter((item) => item.laneId === lane.id);
  if (pending.length === 0) return [];
  for (const item of pending) {
    store.approvePending(item.id);
    appendSupervisorRecord(session, lane, 'supervisor.proposal.resolved', {
      approvalId: item.id,
      resolution: 'user-supervisor-input',
      proposalKind: item.proposalKind || 'important',
      text: guidance,
    });
  }
  return pending.map((item) => item.id);
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
        || (supervisorSurfaceId === surfaceId && (state === 'active' || state === 'waiting')));
  });
  if (!lane) return false;

  if (dedicatedSupervisorSurfaceId(lane) === surfaceId) {
    const directGuidance = task.trim().slice(0, 12_000);
    const resumedFromWaiting = supervisorLaneControlState(lane) === 'waiting';
    const resolvedApprovalIds = directGuidance
      ? resolvePendingApprovalsFromSupervisorInput(session, lane, directGuidance)
      : [];
    if (directGuidance) {
      const project = lane.projectManagerProjectId
        ? store.projectManagers.find((item) => item.id === lane.projectManagerProjectId)
        : undefined;
      store.updateLane(lane.id, {
        latestSupervisorUserGuidance: {
          text: directGuidance,
          updatedAt: Date.now(),
          planRevision: effectiveSupervisorLaneConfig(lane).planRevision || 1,
          requirementsVersion: project?.requirementsVersion,
        },
      });
      appendSupervisorRecord(session, lane, 'supervisor.user-guidance', {
        text: directGuidance,
      });
    }
    if (resumedFromWaiting) {
      resumeWaitingLaneFromSupervisorInput(session, lane, 'supervisor-terminal');
    }
    const resolvedApprovalIdSet = new Set(resolvedApprovalIds);
    const inFlightDeliveryIds = (lane.pendingSupervisorDeliveries || [])
      .filter((delivery) => delivery.stage === 'pasted' || delivery.stage === 'submitted')
      .map((delivery) => delivery.id);
    if (inFlightDeliveryIds.length > 0 || resolvedApprovalIds.length > 0) {
      const currentLane = useStore.getState().supervisor.lanes.find((item) => item.id === lane.id) || lane;
      store.updateLane(lane.id, {
        awaitingReview: true,
        awaitingStopCheck: false,
        stopConfirmed: false,
        resumeAfterCancelledDecision: false,
        autoDecisionLimitReached: false,
        autoDecisionsUsed: 0,
        pendingSupervisorDeliveries: (currentLane.pendingSupervisorDeliveries || [])
          .filter((delivery) => !inFlightDeliveryIds.includes(delivery.id))
          .filter((delivery) => delivery.kind !== 'owner-decision'
            || !delivery.correlationId
            || !resolvedApprovalIdSet.has(delivery.correlationId)),
      });
      if (inFlightDeliveryIds.length > 0) {
        appendSupervisorRecord(session, lane, 'supervisor.delivery.cancelled', {
          deliveryIds: inFlightDeliveryIds,
          reason: 'user-input-precedence',
        });
      }
      store.appendSupervisorLog(
        lane.id,
        resolvedApprovalIds.length > 0 ? '用户决策已生效' : '监督通知已让位',
        resolvedApprovalIds.length > 0
          ? '用户已直接在监督终端提供决策；待审批状态已解除，监督 AI 可按最新输入继续裁决'
          : '用户已在监督终端输入新内容；控制层取消未确认的自动投递，禁止随后补发 Enter',
      );
      signalSupervisorDeliveryReady();
      return true;
    }
    return !!directGuidance || resumedFromWaiting;
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
  if (projectManaged && directTask) {
    store.updateLane(lane.id, { currentTask: directTask });
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
