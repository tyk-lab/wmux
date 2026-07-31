import { describe, expect, it } from 'vitest';
import { canDeliverToSupervisor, enqueueSupervisorDelivery } from '../../src/renderer/supervisor/delivery';

const event = (id: string, kind: 'task-start' | 'task-end', task: string) => ({
  id,
  kind,
  task,
  text: task,
  createdAt: 1,
});

describe('supervisor delivery queue', () => {
  it('deduplicates an unconsumed lifecycle fact but preserves turn order', () => {
    const start = event('start', 'task-start', '运行测试');
    const once = enqueueSupervisorDelivery([], start);
    const duplicate = enqueueSupervisorDelivery(once, { ...start, id: 'duplicate' });
    const complete = enqueueSupervisorDelivery(duplicate, event('end', 'task-end', '运行测试'));

    expect(duplicate).toBe(once);
    expect(complete.map((item) => item.id)).toEqual(['start', 'end']);
  });

  it('waits while the dedicated supervisor is working or blocked', () => {
    expect(canDeliverToSupervisor('working')).toBe(false);
    expect(canDeliverToSupervisor('blocked')).toBe(false);
    expect(canDeliverToSupervisor('idle')).toBe(true);
    expect(canDeliverToSupervisor('unknown')).toBe(true);
  });
});
