import { describe, expect, it } from 'vitest';
import {
  canDeliverProjectManagerMessage,
  compactProjectManagerPendingDeliveries,
  nextProjectManagerDeliveryRetryAttempt,
  resetProjectManagerDeliveryAcknowledgements,
} from '../../src/renderer/project-manager/delivery-mailbox';
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
  it('delivers only when the project Agent explicitly reports prompt-ready', () => {
    expect(canDeliverProjectManagerMessage({ state: 'idle' })).toBe(true);
    expect(canDeliverProjectManagerMessage({ state: 'blocked', blockedReason: '等待下一条指令。' })).toBe(true);
    expect(canDeliverProjectManagerMessage({ state: 'working', updatedAt: 1 })).toBe(false);
    expect(canDeliverProjectManagerMessage({ state: 'blocked', blockedReason: 'permission: npm test' })).toBe(false);
    expect(canDeliverProjectManagerMessage({ state: 'unknown' })).toBe(false);
    expect(canDeliverProjectManagerMessage(undefined)).toBe(false);
  });

  it('bounds transport retries instead of polling indefinitely', () => {
    expect(nextProjectManagerDeliveryRetryAttempt(0)).toBe(1);
    expect(nextProjectManagerDeliveryRetryAttempt(1)).toBe(2);
    expect(nextProjectManagerDeliveryRetryAttempt(2)).toBeNull();
    expect(nextProjectManagerDeliveryRetryAttempt(200)).toBeNull();
  });

  it('requeues unacknowledged PTY submissions after the Agent runtime is replaced', () => {
    const submitted = {
      ...delivery('submitted-1'),
      stage: 'submitted' as const,
      submittedAt: 123,
    };
    const pending = { ...delivery('pending-2'), stage: 'pending' as const };
    const failed = {
      ...delivery('failed-3'),
      stage: 'failed' as const,
      submittedAt: 456,
    };

    expect(resetProjectManagerDeliveryAcknowledgements([submitted, pending, failed])).toEqual([
      expect.objectContaining({ id: 'submitted-1', stage: 'pending', submittedAt: undefined }),
      pending,
      expect.objectContaining({ id: 'failed-3', stage: 'pending', submittedAt: undefined }),
    ]);
  });

  it('keeps only the newest delivery for an actionable transition', () => {
    const old = delivery('old-1', 'transition-a', true);
    const latest = delivery('latest-2', 'transition-a', true);
    expect(compactProjectManagerPendingDeliveries([old, latest])).toEqual([latest]);
    expect(compactProjectManagerPendingDeliveries([latest, old])).toEqual([latest]);
  });

  it('keeps only the newest runtime recovery notice per work item, including legacy records', () => {
    const old = {
      ...delivery('old-1'),
      text: '[项目运行链自动重建失败]\n项目：pm-a；任务：task-a',
    };
    const latest = {
      ...delivery('latest-2'),
      text: '[项目运行链自动重建失败]\n项目：pm-a；任务：task-a',
    };
    const otherTask = {
      ...delivery('other-3'),
      text: '[项目运行链自动重建失败]\n项目：pm-a；任务：task-b',
    };
    expect(compactProjectManagerPendingDeliveries([old, latest, otherTask]))
      .toEqual([latest, otherTask]);

    const keyedOld = { ...delivery('keyed-old-4'), dedupeKey: 'runtime-recovery:task-a' };
    const keyedLatest = { ...delivery('keyed-latest-5'), dedupeKey: 'runtime-recovery:task-a' };
    expect(compactProjectManagerPendingDeliveries([keyedOld, keyedLatest])).toEqual([keyedLatest]);
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

  it('never compacts an unacknowledged submitted transition into a newer copy', () => {
    const submitted = { ...delivery('submitted-1', 'transition-a', true), stage: 'submitted' as const };
    const latest = delivery('latest-2', 'transition-a', true);

    expect(compactProjectManagerPendingDeliveries([submitted, latest]).map((item) => item.id))
      .toEqual(['submitted-1', 'latest-2']);
  });

  it('preserves a failed delivery as a durable barrier until the manager runtime is replaced', () => {
    const failed = { ...delivery('failed-1', 'transition-a', true), stage: 'failed' as const };
    const latest = delivery('latest-2', 'transition-a', true);

    expect(compactProjectManagerPendingDeliveries([failed, latest]).map((item) => item.id))
      .toEqual(['failed-1', 'latest-2']);
    expect(resetProjectManagerDeliveryAcknowledgements([failed, latest]).map((item) => item.id))
      .toEqual(['latest-2']);
  });
});
