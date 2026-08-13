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

/**
 * User Enter is authoritative immediately; do not wait for an agent hook that
 * may be delayed, unsupported, or dropped. This runs before the bytes reach
 * the PTY, so a simultaneous supervisor decision observes awaitingReview=false.
 */
export function handleSupervisorUserSubmit(surfaceId: string): boolean {
  const store = useStore.getState();
  const session = store.supervisor;
  if (!session.active || !surfaceId) return false;

  const lane = session.lanes.find((item) => (
    item.surfaceId === surfaceId
    && (supervisorLaneControlState(item) === 'active'
      || supervisorLaneControlState(item) === 'waiting')
    && !!dedicatedSupervisorSurfaceId(item)
  ));
  if (!lane) return false;

  const resumedFromWaiting = supervisorLaneControlState(lane) === 'waiting';
  const cancelledDeliveries = lane.pendingSupervisorDeliveries?.length || 0;
  const resolvedApproval = resolvePendingApprovalsForManualTask(session, lane, '');
  store.updateLane(lane.id, {
    awaitingReview: false,
    awaitingStopCheck: false,
    stopConfirmed: false,
    enabled: true,
    controlState: 'active',
    resumeAfterCancelledDecision: false,
    autoDecisionLimitReached: false,
    autoDecisionsUsed: 0,
    pendingSupervisorDeliveries: [],
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
