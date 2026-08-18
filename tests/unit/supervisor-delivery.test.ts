import { describe, expect, it } from 'vitest';
import {
  canDeliverToSupervisor,
  enqueueSupervisorDelivery,
  shouldReportUnacknowledgedSupervisorIdle,
  supervisorDeliveryLabel,
  supervisorWakeDeliveryKind,
} from '../../src/renderer/supervisor/delivery';

const event = (id: string, kind: 'task-start' | 'task-end', task: string, turnId?: number) => ({
  id,
  kind,
  task,
  text: task,
  createdAt: 1,
  turnId,
});

describe('supervisor delivery queue', () => {
  it('deduplicates an unconsumed lifecycle fact but preserves turn order', () => {
    const start = event('start', 'task-start', '运行测试', 1);
    const once = enqueueSupervisorDelivery([], start);
    const duplicate = enqueueSupervisorDelivery(once, { ...start, id: 'duplicate' });
    const complete = enqueueSupervisorDelivery(duplicate, event('end', 'task-end', '运行测试', 1));

    expect(duplicate).toBe(once);
    expect(complete.map((item) => item.id)).toEqual(['start', 'end']);
  });

  it('preserves repeated task text from different worker turns', () => {
    const first = event('end-1', 'task-end', '运行测试', 1);
    const second = event('end-2', 'task-end', '运行测试', 2);
    expect(enqueueSupervisorDelivery([first], second).map((item) => item.id))
      .toEqual(['end-1', 'end-2']);
  });

  it('coalesces queued worker status to the newest snapshot', () => {
    const first = {
      id: 'status-working', kind: 'worker-status' as const, task: '运行测试',
      text: '任务仍在运行', createdAt: 1, turnId: 1, stage: 'pending' as const,
    };
    const latest = { ...first, id: 'status-idle', text: '任务已经空闲', createdAt: 2 };
    const queued = enqueueSupervisorDelivery([first], latest);

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ id: 'status-idle', text: '任务已经空闲' });
  });

  it('preserves an in-flight worker status and queues the newest snapshot after it', () => {
    const pasted = {
      id: 'status-pasted', kind: 'worker-status' as const, task: '运行测试',
      text: '任务仍在运行', createdAt: 1, turnId: 1, stage: 'pasted' as const,
    };
    const latest = { ...pasted, id: 'status-latest', text: '任务已经空闲', createdAt: 2, stage: 'pending' as const };

    expect(enqueueSupervisorDelivery([pasted], latest).map((item) => item.id))
      .toEqual(['status-pasted', 'status-latest']);
  });

  it('waits while the dedicated supervisor is working or blocked', () => {
    expect(canDeliverToSupervisor('working')).toBe(false);
    expect(canDeliverToSupervisor('blocked')).toBe(false);
    expect(canDeliverToSupervisor('idle')).toBe(true);
    expect(canDeliverToSupervisor('unknown')).toBe(true);
  });

  it('wakes only for terminal states that require a supervisor decision', () => {
    expect(supervisorWakeDeliveryKind('UserPromptSubmit')).toBeNull();
    expect(supervisorWakeDeliveryKind('PostToolUse')).toBeNull();
    expect(supervisorWakeDeliveryKind('Stop')).toBe('task-end');
    expect(supervisorWakeDeliveryKind('StopFailure')).toBe('task-end');
    expect(supervisorWakeDeliveryKind('Interrupt')).toBe('task-interrupted');
  });

  it('labels liveness probes separately from task lifecycle notifications', () => {
    expect(supervisorDeliveryLabel('liveness-probe')).toBe('活性检查');
  });

  it('reports only a project supervisor turn that ended without a structured state handoff', () => {
    const base = {
      lifecycle: 'Stop', projectManaged: true, controlState: 'active',
      awaitingReview: true, providerLimited: false, hasPendingDecision: false,
      pendingDeliveries: 0,
    };
    expect(shouldReportUnacknowledgedSupervisorIdle(base)).toBe(true);
    expect(shouldReportUnacknowledgedSupervisorIdle({ ...base, projectManaged: false })).toBe(false);
    expect(shouldReportUnacknowledgedSupervisorIdle({ ...base, awaitingReview: false })).toBe(false);
    expect(shouldReportUnacknowledgedSupervisorIdle({ ...base, controlState: 'waiting' })).toBe(false);
    expect(shouldReportUnacknowledgedSupervisorIdle({ ...base, hasPendingDecision: true })).toBe(false);
    expect(shouldReportUnacknowledgedSupervisorIdle({ ...base, pendingDeliveries: 1 })).toBe(false);
    expect(shouldReportUnacknowledgedSupervisorIdle({ ...base, providerLimited: true })).toBe(false);
  });
});
