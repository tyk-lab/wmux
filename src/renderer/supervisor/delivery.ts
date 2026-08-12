import type { SupervisorDelivery } from '../store/supervisor-slice';

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
    return current;
  }
  return [...current, delivery];
}

/** A busy or blocked supervisor must finish its current turn before receiving another command. */
export function canDeliverToSupervisor(state: unknown): boolean {
  return state !== 'working' && state !== 'blocked';
}
