import { describe, expect, it } from 'vitest';
import { compactProjectManagerPendingDeliveries } from '../../src/renderer/project-manager/delivery-mailbox';
import type { ProjectManagerPendingDelivery } from '../../src/shared/project-manager';

const delivery = (
  id: string,
  transitionId?: string,
  priority = false,
): ProjectManagerPendingDelivery => ({
  id,
  text: id,
  createdAt: Number(id.replace(/\D/gu, '')) || 1,
  ...(transitionId ? { transitionId } : {}),
  ...(priority ? { priority: true } : {}),
});

describe('project manager delivery mailbox', () => {
  it('keeps only the newest delivery for an actionable transition', () => {
    const old = delivery('old-1', 'transition-a', true);
    const latest = delivery('latest-2', 'transition-a', true);
    expect(compactProjectManagerPendingDeliveries([old, latest])).toEqual([latest]);
    expect(compactProjectManagerPendingDeliveries([latest, old])).toEqual([latest]);
  });

  it('drops restored deliveries whose transition has already been resolved', () => {
    const resolved = delivery('resolved-1', 'transition-old', true);
    const active = delivery('active-2', 'transition-current', true);
    expect(compactProjectManagerPendingDeliveries(
      [resolved, active],
      new Set(['transition-current']),
    )).toEqual([active]);
  });

  it('restores actionable decisions ahead of informational messages', () => {
    const info = delivery('info-1');
    const decision = delivery('decision-2', 'transition-a', true);
    expect(compactProjectManagerPendingDeliveries([info, decision]).map((item) => item.id))
      .toEqual(['decision-2', 'info-1']);
  });
});
