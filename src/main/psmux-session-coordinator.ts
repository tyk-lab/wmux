export interface PsmuxReadinessOptions {
  isReady: (sessionName: string) => boolean | Promise<boolean>;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until psmux can address a newly created detached session by name. */
export async function waitForPsmuxSessionReady(
  sessionName: string,
  options: PsmuxReadinessOptions,
): Promise<boolean> {
  const wait = options.delay ?? delay;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const deadline = now() + timeoutMs;

  while (true) {
    if (await options.isReady(sessionName)) return true;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return false;
    await wait(Math.min(pollIntervalMs, remainingMs));
  }
}
