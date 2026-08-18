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
  const current = pending || [];
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
