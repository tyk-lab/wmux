import { describe, expect, it } from 'vitest';
import { waitForPsmuxSessionReady } from '../../src/main/psmux-session-coordinator';

describe('waitForPsmuxSessionReady', () => {
  it('polls until the named session becomes addressable', async () => {
    let checks = 0;
    let elapsed = 0;

    const ready = await waitForPsmuxSessionReady('wmx-test', {
      isReady: () => {
        checks += 1;
        return checks === 3;
      },
      delay: async (ms) => {
        elapsed += ms;
      },
      now: () => elapsed,
      timeoutMs: 200,
      pollIntervalMs: 20,
    });

    expect(ready).toBe(true);
    expect(checks).toBe(3);
    expect(elapsed).toBe(40);
  });

  it('returns false when readiness does not arrive before the timeout', async () => {
    let elapsed = 0;

    const ready = await waitForPsmuxSessionReady('wmx-test', {
      isReady: () => false,
      delay: async (ms) => {
        elapsed += ms;
      },
      now: () => elapsed,
      timeoutMs: 50,
      pollIntervalMs: 20,
    });

    expect(ready).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});
