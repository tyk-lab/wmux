import type { ProjectManagerPendingDelivery } from '../../shared/project-manager';

const DEFAULT_PROJECT_MANAGER_MAILBOX_LIMIT = 100;

/** Keep the newest copy of each actionable transition and preserve priority across restore. */
export function compactProjectManagerPendingDeliveries(
  deliveries: readonly ProjectManagerPendingDelivery[] | undefined,
  validTransitionIds?: ReadonlySet<string>,
  limit = DEFAULT_PROJECT_MANAGER_MAILBOX_LIMIT,
): ProjectManagerPendingDelivery[] {
  const source = deliveries || [];
  const latestTransitionDelivery = new Map<string, ProjectManagerPendingDelivery>();
  for (const delivery of source) {
    if (!delivery.transitionId) continue;
    const previous = latestTransitionDelivery.get(delivery.transitionId);
    if (!previous || delivery.createdAt >= previous.createdAt) {
      latestTransitionDelivery.set(delivery.transitionId, delivery);
    }
  }
  const compacted = source.filter((delivery) => (
    !delivery.transitionId
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
