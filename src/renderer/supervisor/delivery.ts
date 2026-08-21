import type { SupervisorDelivery } from '../store/supervisor-slice';
import {
  isAgentPromptReadyState,
  isAwaitingNextPromptState,
} from '../agent-state-semantics';

export const SUPERVISOR_DELIVERY_READY_EVENT = 'wmux:supervisor-delivery-ready';

export function signalSupervisorDeliveryReady(): void {
  (globalThis as any).window?.dispatchEvent?.(new Event(SUPERVISOR_DELIVERY_READY_EVENT));
}

export function supervisorDeliveryLabel(kind: SupervisorDelivery['kind']): string {
  if (kind === 'task-start') return '任务开始';
  if (kind === 'task-end') return '任务结束';
  if (kind === 'task-interrupted') return '任务中断';
  if (kind === 'worker-status') return '任务状态更新';
  if (kind === 'agent-recovery') return 'Agent 恢复';
  if (kind === 'user-task') return '用户直发任务';
  return '活性检查';
}

export type SupervisorWakeDeliveryKind = 'task-end' | 'task-interrupted';

function supervisorDeliveryAgentState(agentState: unknown): unknown {
  return agentState && typeof agentState === 'object'
    ? (agentState as { state?: unknown }).state
    : agentState;
}

export const MAX_SUPERVISOR_DELIVERY_RETRY_ATTEMPTS = 2;

/** Bound transient delivery retries; later lifecycle events may start a fresh bounded attempt. */
export function nextSupervisorDeliveryRetryAttempt(attempts: number): number | null {
  const current = Number.isFinite(attempts) ? Math.max(0, Math.trunc(attempts)) : 0;
  return current >= MAX_SUPERVISOR_DELIVERY_RETRY_ATTEMPTS ? null : current + 1;
}

/** Only terminal states that need a decision should wake the dedicated supervisor. */
export function supervisorWakeDeliveryKind(lifecycle: unknown): SupervisorWakeDeliveryKind | null {
  if (lifecycle === 'Stop' || lifecycle === 'StopFailure') return 'task-end';
  if (lifecycle === 'Interrupt') return 'task-interrupted';
  return null;
}

function sameDeliveryTurn(left: SupervisorDelivery, right: SupervisorDelivery): boolean {
  return left.turnId !== undefined && right.turnId !== undefined
    ? left.turnId === right.turnId
    : left.task === right.task;
}

function deliveryPriority(delivery: SupervisorDelivery): number {
  if (delivery.reviewId || delivery.kind === 'task-end' || delivery.kind === 'task-interrupted') return 0;
  if (delivery.kind === 'user-task') return 1;
  if (delivery.kind === 'agent-recovery') return 2;
  if (delivery.kind === 'worker-status') return 3;
  if (delivery.kind === 'liveness-probe') return 4;
  return 5;
}

function appendCompactedSupervisorDelivery(
  pending: SupervisorDelivery[],
  delivery: SupervisorDelivery,
): SupervisorDelivery[] {
  if (delivery.kind === 'task-start' && delivery.stage !== 'pasted') return pending;

  const terminalLifecycle = delivery.kind === 'task-end' || delivery.kind === 'task-interrupted';
  const duplicatePasted = pending.some((candidate) => (
    candidate.stage === 'pasted'
    && candidate.kind === delivery.kind
    && (candidate.reviewId && delivery.reviewId
      ? candidate.reviewId === delivery.reviewId
      : sameDeliveryTurn(candidate, delivery))
  ));
  if (duplicatePasted && terminalLifecycle) return pending;

  const filtered = pending.filter((candidate) => {
    if (candidate.stage === 'pasted') return true;
    const sameTurn = sameDeliveryTurn(candidate, delivery);
    if (delivery.reviewId && candidate.reviewId === delivery.reviewId) return false;
    if (terminalLifecycle) {
      if (candidate.kind === 'liveness-probe' || candidate.kind === 'task-start') return false;
      if (sameTurn && ['worker-status', 'agent-recovery', 'user-task'].includes(candidate.kind)) return false;
      if (candidate.kind === delivery.kind) return !sameTurn;
      return true;
    }
    if (delivery.kind === 'user-task') {
      if (['task-start', 'user-task', 'liveness-probe', 'agent-recovery'].includes(candidate.kind)) return false;
      if (candidate.kind === 'worker-status' && !candidate.reviewId) return false;
      const olderTurn = candidate.turnId !== undefined && delivery.turnId !== undefined
        && candidate.turnId < delivery.turnId;
      if (olderTurn && (candidate.kind === 'task-end' || candidate.kind === 'task-interrupted')) return false;
      return true;
    }
    if (delivery.kind === 'worker-status') {
      if (candidate.kind === 'liveness-probe') return false;
      if (delivery.reviewId && sameTurn && candidate.kind === 'user-task') return false;
      if (candidate.kind !== 'worker-status') return true;
      if (delivery.reviewId || candidate.reviewId) return candidate.reviewId !== delivery.reviewId;
      return !sameTurn;
    }
    if (delivery.kind === 'agent-recovery') {
      return candidate.kind !== 'agent-recovery' || !sameTurn;
    }
    if (delivery.kind === 'liveness-probe') return candidate.kind !== 'liveness-probe';
    return true;
  });
  return [...filtered, delivery];
}

/** Reduce delayed lifecycle facts to the current actionable mailbox. */
export function compactSupervisorDeliveries(
  pending: SupervisorDelivery[] | undefined,
): SupervisorDelivery[] {
  const source = pending || [];
  let compacted: SupervisorDelivery[] = [];
  for (const delivery of source) compacted = appendCompactedSupervisorDelivery(compacted, delivery);
  return compacted.length === source.length
    && compacted.every((delivery, index) => delivery === source[index])
    ? source
    : compacted;
}

/** Keep only the actionable facts that remain after semantic supersession. */
export function enqueueSupervisorDelivery(
  pending: SupervisorDelivery[] | undefined,
  delivery: SupervisorDelivery,
): SupervisorDelivery[] {
  const source = compactSupervisorDeliveries(pending);
  return appendCompactedSupervisorDelivery(source, delivery);
}

/**
 * Pick the oldest currently deliverable fact instead of letting an idle-only
 * liveness probe block a later lifecycle event while state detection is stale.
 */
export function nextDeliverableSupervisorDelivery(
  pending: SupervisorDelivery[] | undefined,
  supervisorAgentState: unknown,
): SupervisorDelivery | undefined {
  const queue = compactSupervisorDeliveries(pending);
  const pasted = queue.find((delivery) => delivery.stage === 'pasted');
  if (pasted) {
    return pasted.kind === 'liveness-probe'
      ? isAgentPromptReadyState(supervisorAgentState) ? pasted : undefined
      : canDeliverToSupervisor(supervisorAgentState) ? pasted : undefined;
  }
  if (!canDeliverToSupervisor(supervisorAgentState)) return undefined;
  return [...queue]
    .sort((left, right) => deliveryPriority(left) - deliveryPriority(right) || left.createdAt - right.createdAt)
    .find((delivery) => delivery.kind !== 'liveness-probe' || isAgentPromptReadyState(supervisorAgentState));
}

/** A busy or genuinely blocked supervisor must finish its current turn before receiving another command. */
export function canDeliverToSupervisor(agentState: unknown): boolean {
  const state = supervisorDeliveryAgentState(agentState);
  return state !== 'working'
    && (state !== 'blocked' || isAwaitingNextPromptState(agentState));
}

/** Detect a supervisor Agent turn that ended without publishing a state handoff. */
export function shouldReportUnacknowledgedSupervisorIdle(options: {
  lifecycle: unknown;
  controlState: unknown;
  awaitingReview: boolean;
  providerLimited: boolean;
  hasPendingDecision: boolean;
  pendingDeliveries: number;
}): boolean {
  return (options.lifecycle === 'Stop' || options.lifecycle === 'StopFailure')
    && options.controlState === 'active'
    && options.awaitingReview
    && !options.providerLimited
    && !options.hasPendingDecision
    && options.pendingDeliveries === 0;
}

export type UnacknowledgedSupervisorIdleAction =
  | 'retry-local'
  | 'pause-ordinary'
  | 'escalate-project'
  | 'ignore';

/** Retry one malformed supervisor turn locally before involving the project AI. */
export function unacknowledgedSupervisorIdleAction(
  recoveryAttempts: number | undefined,
  projectManaged = true,
): UnacknowledgedSupervisorIdleAction {
  const attempts = Math.max(0, Math.trunc(recoveryAttempts || 0));
  if (attempts === 0) return 'retry-local';
  if (attempts === 1) return projectManaged ? 'escalate-project' : 'pause-ordinary';
  return 'ignore';
}
