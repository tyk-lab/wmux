import type { SupervisorLane, SupervisorSession } from '../store/supervisor-slice';

const MAX_VALUE = 1_200;

function compact(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

/** Persist a small audit event without writing anything into a worker terminal. */
export function appendSupervisorRecord(
  session: SupervisorSession,
  lane: SupervisorLane,
  type: string,
  payload: Record<string, unknown> = {},
): void {
  if (!session.sessionId || !lane.projectDir) return;
  const api = (window as any).wmux?.supervisor;
  if (!api?.appendRecord) return;

  const compactPayload = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, compact(value)]),
  );
  void api.appendRecord({
    sessionId: session.sessionId,
    projectDir: lane.projectDir,
    type,
    terminal: {
      surfaceId: lane.surfaceId,
      paneId: lane.paneId,
      workspaceId: lane.workspaceId,
      workspaceTitle: lane.workspaceTitle,
      label: lane.label,
    },
    payload: compactPayload,
  }).catch((err: unknown) => console.warn('[supervisor] audit write failed', err));
}
