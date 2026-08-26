import { describe, expect, it } from 'vitest';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';
import {
  ordinaryWorkerWatchdogCandidate,
  ordinaryWorkerWatchdogPolicy,
} from '../../src/renderer/supervisor/ordinary-worker-watchdog';

function lane(partial: Partial<SupervisorLane> = {}): SupervisorLane {
  return {
    id: 'lane-a', label: '任务 AI', surfaceId: 'worker-a' as any,
    supervisorSurfaceId: 'supervisor-a' as any,
    controlState: 'active', awaitingStopCheck: false, stopConfirmed: false,
    ...partial,
  };
}

describe('ordinary worker watchdog isolation', () => {
  it('watches only an active ordinary task lane', () => {
    expect(ordinaryWorkerWatchdogCandidate(lane(), 'worker-a')).toBe(true);
    expect(ordinaryWorkerWatchdogCandidate(lane({ controlState: 'paused' }), 'worker-a')).toBe(false);
    expect(ordinaryWorkerWatchdogCandidate(lane({ supervisorSurfaceId: null }), 'worker-a')).toBe(false);
    expect(ordinaryWorkerWatchdogCandidate(lane({
      projectManagerProjectId: 'project-a', projectWorkItemId: 'work-a',
    }), 'worker-a')).toBe(false);
  });

  it('uses conservative task deadlines without project runtime recovery settings', () => {
    const policy = ordinaryWorkerWatchdogPolicy();
    expect(policy.softMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(policy.hardMs).toBeGreaterThan(policy.softMs);
    expect(policy.interruptGraceMs).toBeGreaterThan(0);
  });
});
