import type { SupervisorDelivery } from '../store/supervisor-slice';

export const SUPERVISOR_DELIVERY_READY_EVENT = 'wmux:supervisor-delivery-ready';

export function signalSupervisorDeliveryReady(): void {
  (globalThis as any).window?.dispatchEvent?.(new Event(SUPERVISOR_DELIVERY_READY_EVENT));
}

export function supervisorDeliveryLabel(kind: SupervisorDelivery['kind']): string {
  if (kind === 'task-start') return '任务开始';
  if (kind === 'task-end') return '任务结束';
  if (kind === 'task-interrupted') return '任务中断';
  if (kind === 'worker-status') return '任务状态更新';
  return '活性检查';
}

export type SupervisorWakeDeliveryKind = 'task-end' | 'task-interrupted';

/** Only terminal states that need a decision should wake the dedicated supervisor. */
export function supervisorWakeDeliveryKind(lifecycle: unknown): SupervisorWakeDeliveryKind | null {
  if (lifecycle === 'Stop' || lifecycle === 'StopFailure') return 'task-end';
  if (lifecycle === 'Interrupt') return 'task-interrupted';
  return null;
}

/** Keep one copy of an unconsumed lifecycle fact without merging different task turns. */
export function enqueueSupervisorDelivery(
  pending: SupervisorDelivery[] | undefined,
  delivery: SupervisorDelivery,
): SupervisorDelivery[] {
  const terminalLifecycle = delivery.kind === 'task-end' || delivery.kind === 'task-interrupted';
  const current = terminalLifecycle
    ? (pending || []).filter((candidate) => {
        const sameTurn = candidate.turnId !== undefined && delivery.turnId !== undefined
          ? candidate.turnId === delivery.turnId
          : candidate.task === delivery.task;
        const obsoleteProbe = candidate.kind === 'liveness-probe'
          || (candidate.kind === 'worker-status' && sameTurn);
        return candidate.stage === 'pasted' || !obsoleteProbe;
      })
    : pending || [];
  const previous = current[current.length - 1];
  const sameTurn = previous?.turnId !== undefined && delivery.turnId !== undefined
    ? previous.turnId === delivery.turnId
    : previous?.task === delivery.task;
  if (previous?.kind === delivery.kind && sameTurn) {
    if (delivery.kind === 'worker-status' && previous.stage !== 'pasted') {
      return [...current.slice(0, -1), delivery];
    }
    if (delivery.kind === 'worker-status') return [...current, delivery];
    return current;
  }
  return [...current, delivery];
}

/**
 * Pick the oldest currently deliverable fact instead of letting an idle-only
 * liveness probe block a later lifecycle event while state detection is stale.
 */
export function nextDeliverableSupervisorDelivery(
  pending: SupervisorDelivery[] | undefined,
  supervisorState: unknown,
): SupervisorDelivery | undefined {
  const queue = pending || [];
  const pasted = queue.find((delivery) => delivery.stage === 'pasted');
  if (pasted) {
    return pasted.kind === 'liveness-probe'
      ? supervisorState === 'idle' ? pasted : undefined
      : canDeliverToSupervisor(supervisorState) ? pasted : undefined;
  }
  return queue.find((delivery) => (
    delivery.kind === 'liveness-probe'
      ? supervisorState === 'idle'
      : canDeliverToSupervisor(supervisorState)
  ));
}

/** A busy or blocked supervisor must finish its current turn before receiving another command. */
export function canDeliverToSupervisor(state: unknown): boolean {
  return state !== 'working' && state !== 'blocked';
}

/** Detect a supervisor Agent turn that ended without publishing a state handoff. */
export function shouldReportUnacknowledgedSupervisorIdle(options: {
  lifecycle: unknown;
  projectManaged: boolean;
  controlState: unknown;
  awaitingReview: boolean;
  providerLimited: boolean;
  hasPendingDecision: boolean;
  pendingDeliveries: number;
}): boolean {
  return (options.lifecycle === 'Stop' || options.lifecycle === 'StopFailure')
    && options.projectManaged
    && options.controlState === 'active'
    && options.awaitingReview
    && !options.providerLimited
    && !options.hasPendingDecision
    && options.pendingDeliveries === 0;
}

export type UnacknowledgedSupervisorIdleAction = 'retry-local' | 'escalate-project' | 'ignore';

/** Retry one malformed supervisor turn locally before involving the project AI. */
export function unacknowledgedSupervisorIdleAction(recoveryAttempts: number | undefined): UnacknowledgedSupervisorIdleAction {
  const attempts = Math.max(0, Math.trunc(recoveryAttempts || 0));
  if (attempts === 0) return 'retry-local';
  if (attempts === 1) return 'escalate-project';
  return 'ignore';
}
