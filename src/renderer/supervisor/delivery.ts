import type { SupervisorDelivery } from '../store/supervisor-slice';

/** Keep one copy of an unconsumed lifecycle fact without merging different task turns. */
export function enqueueSupervisorDelivery(
  pending: SupervisorDelivery[] | undefined,
  delivery: SupervisorDelivery,
): SupervisorDelivery[] {
  const current = pending || [];
  const previous = current[current.length - 1];
  if (previous?.kind === delivery.kind && previous.task === delivery.task) {
    return current;
  }
  return [...current, delivery];
}

/** A busy or blocked supervisor must finish its current turn before receiving another command. */
export function canDeliverToSupervisor(state: unknown): boolean {
  return state !== 'working' && state !== 'blocked';
}
