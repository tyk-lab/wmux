import type { SupervisorDecision, SupervisorLane, SupervisorSession } from '../store/supervisor-slice';

const MAX_VALUE = 1_200;
const MAX_RESTORED_HISTORY_CHARS = 12_000;

interface AuditEvent {
  ts: number;
  type: string;
  payload: Record<string, unknown>;
}

interface HistoryResult {
  sessionId: string | null;
  events: AuditEvent[];
}

export interface RestoredLaneHistory {
  currentTask?: string;
  decisions: SupervisorDecision[];
  restoredHistory: string;
  restoredFromSessionId: string;
}

function compact(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

function payloadText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value.trim() : '';
}

function timestamp(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** Convert durable audit entries into the compact context a replacement supervisor needs. */
export function summarizeRestoredHistory(history: HistoryResult): RestoredLaneHistory | null {
  if (!history.sessionId || !Array.isArray(history.events) || history.events.length === 0) return null;

  let currentTask = '';
  const decisions: SupervisorDecision[] = [];
  const lines: string[] = [];
  for (const event of history.events) {
    if (!event || typeof event.ts !== 'number' || typeof event.type !== 'string') continue;
    const prefix = `[${timestamp(event.ts)}]`;
    if (event.type === 'worker.task') {
      const task = payloadText(event.payload || {}, 'task');
      if (!task) continue;
      currentTask = task;
      lines.push(`${prefix} 收到任务：${task}`);
      continue;
    }
    if (event.type === 'worker.lifecycle') {
      const lifecycle = payloadText(event.payload || {}, 'event');
      const message = payloadText(event.payload || {}, 'message');
      lines.push(`${prefix} 终端事件：${lifecycle || '未知'}${message ? `；${message}` : ''}`);
      continue;
    }
    if (event.type === 'supervisor.decision') {
      const outcome = payloadText(event.payload || {}, 'outcome');
      if (!['continue', 'rework', 'complete', 'needs-human'].includes(outcome)) continue;
      const reason = payloadText(event.payload || {}, 'reason');
      const next = payloadText(event.payload || {}, 'next');
      decisions.unshift({
        ts: event.ts,
        task: currentTask || '（任务未上报）',
        outcome: outcome as SupervisorDecision['outcome'],
        reason,
        next,
      });
      lines.push(`${prefix} 监督裁决：${outcome}${reason ? `；原因：${reason}` : ''}${next ? `；下一步：${next}` : ''}`);
    }
  }

  if (lines.length === 0) return null;
  const full = lines.join('\n');
  const restoredHistory = full.length > MAX_RESTORED_HISTORY_CHARS
    ? `（已截断为最近记录）\n${full.slice(-MAX_RESTORED_HISTORY_CHARS)}`
    : full;
  return {
    ...(currentTask ? { currentTask } : {}),
    decisions,
    restoredHistory,
    restoredFromSessionId: history.sessionId,
  };
}

/** Read isolated durable history for one lane. Ambiguous labels return no context. */
export async function restoreLatestLaneHistory(lane: SupervisorLane): Promise<RestoredLaneHistory | null> {
  if (!lane.projectDir) return null;
  const api = (window as any).wmux?.supervisor;
  if (!api?.readLatestHistory) return null;
  try {
    const history = await api.readLatestHistory({
      projectDir: lane.projectDir,
      surfaceId: lane.surfaceId,
      terminalLabel: lane.label,
    }) as HistoryResult;
    return summarizeRestoredHistory(history);
  } catch (err) {
    console.warn('[supervisor] audit restore failed', err);
    return null;
  }
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
