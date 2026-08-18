export type TerminalRuntimeState = 'starting' | 'ready' | 'failed' | 'exited';

export interface TerminalRuntimeStatus {
  state: TerminalRuntimeState;
  detail?: string;
  updatedAt: number;
}

export interface TerminalRuntimeReadyResult {
  ok: boolean;
  error?: string;
}

type RuntimeListener = (surfaceId: string, status: TerminalRuntimeStatus) => void;

const statuses = new Map<string, TerminalRuntimeStatus>();
const listeners = new Set<RuntimeListener>();

function updateStatus(surfaceId: string, state: TerminalRuntimeState, detail?: string): void {
  if (!surfaceId) return;
  const status = { state, detail, updatedAt: Date.now() } satisfies TerminalRuntimeStatus;
  statuses.set(surfaceId, status);
  for (const listener of listeners) listener(surfaceId, status);
}

export function markTerminalRuntimeStarting(surfaceId: string): void {
  updateStatus(surfaceId, 'starting');
}

export function markTerminalRuntimeReady(surfaceId: string): void {
  updateStatus(surfaceId, 'ready');
}

export function markTerminalRuntimeFailed(surfaceId: string, detail: string): void {
  updateStatus(surfaceId, 'failed', detail);
}

export function markTerminalRuntimeExited(surfaceId: string, detail: string): void {
  updateStatus(surfaceId, 'exited', detail);
}

export function terminalRuntimeStatus(surfaceId: string): TerminalRuntimeStatus | undefined {
  return statuses.get(surfaceId);
}

export function onTerminalRuntimeStatus(listener: RuntimeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Wait for the renderer to attach the PTY and finish its one-shot startup input. */
export async function waitForTerminalRuntimeReady(
  surfaceId: string,
  timeoutMs = 20_000,
): Promise<TerminalRuntimeReadyResult> {
  const current = statuses.get(surfaceId);
  if (current?.state === 'ready') return { ok: true };
  if (current?.state === 'failed' || current?.state === 'exited') {
    return { ok: false, error: current.detail || '终端运行时不可用' };
  }

  // Unit/non-Electron harnesses do not mount TerminalPane. Production preload
  // always exposes pty.has, so this branch cannot turn a real startup into a
  // false positive.
  if (!(globalThis as any).window?.wmux?.pty?.has) return { ok: true };

  return new Promise<TerminalRuntimeReadyResult>((resolve) => {
    let settled = false;
    const finish = (result: TerminalRuntimeReadyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };
    const unsubscribe = onTerminalRuntimeStatus((changedSurfaceId, status) => {
      if (changedSurfaceId !== surfaceId) return;
      if (status.state === 'ready') finish({ ok: true });
      else if (status.state === 'failed' || status.state === 'exited') {
        finish({ ok: false, error: status.detail || '终端运行时不可用' });
      }
    });
    const timer = globalThis.setTimeout(() => {
      finish({ ok: false, error: `终端在 ${Math.ceil(timeoutMs / 1000)} 秒内未完成启动` });
    }, timeoutMs);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  });
}

export function clearTerminalRuntimeStatus(surfaceId: string): void {
  statuses.delete(surfaceId);
}

/** Remove a closed surface without leaving readiness waiters until timeout. */
export function disposeTerminalRuntimeStatus(surfaceId: string, detail = '终端已关闭'): void {
  if (statuses.get(surfaceId)?.state === 'starting') updateStatus(surfaceId, 'exited', detail);
  statuses.delete(surfaceId);
}
