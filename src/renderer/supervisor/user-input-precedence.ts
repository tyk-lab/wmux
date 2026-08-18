import { useStore } from '../store';
import type { SupervisorLane, SupervisorSession } from '../store/supervisor-slice';
import { dedicatedSupervisorSurfaceId, supervisorLaneControlState } from '../store/supervisor-slice';
import { appendSupervisorRecord } from './recording';

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
 */
export function handleSupervisorUserSubmit(surfaceId: string): boolean {
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

  const resumedFromWaiting = supervisorLaneControlState(lane) === 'waiting';
  const cancelledDeliveries = lane.pendingSupervisorDeliveries?.length || 0;
  const resolvedApproval = resolvePendingApprovalsForManualTask(session, lane, '');
  store.updateLane(lane.id, {
    awaitingReview: false,
    awaitingStopCheck: false,
    stopConfirmed: false,
    controlState: 'active',
    resumeAfterCancelledDecision: false,
    autoDecisionLimitReached: false,
    autoDecisionsUsed: 0,
    pendingSupervisorDeliveries: [],
    ...(resumedFromWaiting ? { awaitingDirectionAfterWaitingResume: true } : {}),
  });
  appendSupervisorRecord(session, lane, 'worker.user-submit', {
    resolvedApproval,
    cancelledDeliveries,
    resumedFromWaiting,
  });
  store.appendSupervisorLog(
    lane.id,
    resumedFromWaiting ? '待续恢复' : '用户输入优先',
    resumedFromWaiting
      ? '用户已向任务终端发送新方向；完成标记和自动裁决计数已重置，继续监督'
      : cancelledDeliveries > 0
        ? `用户已直接向任务终端发送内容；已取消 ${cancelledDeliveries} 条过期监督通知`
        : '用户已直接向任务终端发送内容；AI 裁决已让位',
  );
  return true;
}
