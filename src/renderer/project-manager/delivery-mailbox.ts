import type { ProjectManagerPendingDelivery } from '../../shared/project-manager';
import { isAgentPromptReadyState } from '../agent-state-semantics';

const DEFAULT_PROJECT_MANAGER_MAILBOX_LIMIT = 100;
export const MAX_PROJECT_MANAGER_DELIVERY_RETRY_ATTEMPTS = 2;

function projectManagerDeliveryDedupeKey(delivery: ProjectManagerPendingDelivery): string | undefined {
  if (delivery.dedupeKey?.trim()) return delivery.dedupeKey.trim();
  if (!delivery.text.includes('[项目运行链自动重建失败]')
    && !delivery.text.includes('[项目运行链自动重建异常]')) return undefined;
  const workItemId = delivery.text.match(/(?:^|[；\r\n])任务：([^；\r\n]+)/u)?.[1]?.trim();
  return `legacy-runtime-recovery:${workItemId || 'project'}`;
}

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
  const reset = (deliveries || []).map((delivery) => (
    delivery.stage === 'submitting' || delivery.stage === 'submitted' || delivery.stage === 'failed'
      ? { ...delivery, stage: 'pending' as const, submittedAt: undefined }
      : delivery
  ));
  return compactProjectManagerPendingDeliveries(reset);
}

/** Keep the newest copy of each actionable transition and preserve priority across restore. */
export function compactProjectManagerPendingDeliveries(
  deliveries: readonly ProjectManagerPendingDelivery[] | undefined,
  validTransitionIds?: ReadonlySet<string>,
  limit = DEFAULT_PROJECT_MANAGER_MAILBOX_LIMIT,
): ProjectManagerPendingDelivery[] {
  const source = deliveries || [];
  const latestTransitionDelivery = new Map<string, ProjectManagerPendingDelivery>();
  const latestDedupeDelivery = new Map<string, ProjectManagerPendingDelivery>();
  for (const delivery of source) {
    if (delivery.stage === 'submitting' || delivery.stage === 'submitted' || delivery.stage === 'failed') continue;
    if (delivery.transitionId) {
      const previous = latestTransitionDelivery.get(delivery.transitionId);
      if (!previous || delivery.createdAt >= previous.createdAt) {
        latestTransitionDelivery.set(delivery.transitionId, delivery);
      }
    }
    const dedupeKey = projectManagerDeliveryDedupeKey(delivery);
    if (dedupeKey) {
      const previous = latestDedupeDelivery.get(dedupeKey);
      if (!previous || delivery.createdAt >= previous.createdAt) {
        latestDedupeDelivery.set(dedupeKey, delivery);
      }
    }
  }
  const compacted = source.filter((delivery) => {
    if (delivery.stage === 'submitting' || delivery.stage === 'submitted' || delivery.stage === 'failed') return true;
    const transitionCurrent = !delivery.transitionId || (
      (!validTransitionIds || validTransitionIds.has(delivery.transitionId))
      && latestTransitionDelivery.get(delivery.transitionId) === delivery
    );
    const dedupeKey = projectManagerDeliveryDedupeKey(delivery);
    const dedupeCurrent = !dedupeKey || latestDedupeDelivery.get(dedupeKey) === delivery;
    return transitionCurrent && dedupeCurrent;
  });
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
