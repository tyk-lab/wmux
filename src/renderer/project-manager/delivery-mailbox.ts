import type { ProjectManagerPendingDelivery } from '../../shared/project-manager';
import { isAgentPromptReadyState } from '../agent-state-semantics';

const DEFAULT_PROJECT_MANAGER_MAILBOX_LIMIT = 100;
export const MAX_PROJECT_MANAGER_DELIVERY_RETRY_ATTEMPTS = 2;

/** Project AI control messages require an explicit Agent prompt-ready state. */
export function canDeliverProjectManagerMessage(agentState: unknown): boolean {
  return isAgentPromptReadyState(agentState);
}

export function nextProjectManagerDeliveryRetryAttempt(attempts: number): number | null {
  const current = Number.isFinite(attempts) ? Math.max(0, Math.trunc(attempts)) : 0;
  return current >= MAX_PROJECT_MANAGER_DELIVERY_RETRY_ATTEMPTS ? null : current + 1;
}

/** A replaced Agent cannot acknowledge a PTY submission made to the old runtime. */
export function resetProjectManagerDeliveryAcknowledgements(
  deliveries: readonly ProjectManagerPendingDelivery[] | undefined,
): ProjectManagerPendingDelivery[] {
  return (deliveries || []).map((delivery) => (
    delivery.stage === 'submitting' || delivery.stage === 'submitted'
      ? { ...delivery, stage: 'pending' as const, submittedAt: undefined }
      : delivery
  ));
}

/** Keep the newest copy of each actionable transition and preserve priority across restore. */
export function compactProjectManagerPendingDeliveries(
  deliveries: readonly ProjectManagerPendingDelivery[] | undefined,
  validTransitionIds?: ReadonlySet<string>,
  limit = DEFAULT_PROJECT_MANAGER_MAILBOX_LIMIT,
): ProjectManagerPendingDelivery[] {
  const source = deliveries || [];
  const latestTransitionDelivery = new Map<string, ProjectManagerPendingDelivery>();
  for (const delivery of source) {
    if (!delivery.transitionId || delivery.stage === 'submitting' || delivery.stage === 'submitted') continue;
    const previous = latestTransitionDelivery.get(delivery.transitionId);
    if (!previous || delivery.createdAt >= previous.createdAt) {
      latestTransitionDelivery.set(delivery.transitionId, delivery);
    }
  }
  const compacted = source.filter((delivery) => (
    delivery.stage === 'submitting'
    || delivery.stage === 'submitted'
    || !delivery.transitionId
    || ((!validTransitionIds || validTransitionIds.has(delivery.transitionId))
      && latestTransitionDelivery.get(delivery.transitionId) === delivery)
  ));
  const priority = compacted.filter((delivery) => delivery.priority);
  const ordinary = compacted.filter((delivery) => !delivery.priority);
  const bounded = priority.length >= limit
    ? priority
    : [...priority, ...ordinary.slice(-(limit - priority.length))];
  return bounded.length === source.length
    && bounded.every((delivery, index) => delivery === source[index])
    ? source as ProjectManagerPendingDelivery[]
    : bounded;
}
