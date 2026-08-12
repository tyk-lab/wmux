import { describe, expect, it } from 'vitest';
import {
  canDeliverToSupervisor,
  enqueueSupervisorDelivery,
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
});
