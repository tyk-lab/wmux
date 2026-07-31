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

export interface SupervisorAuditTrailSession {
  sessionId: string;
  createdAt: number;
  events: AuditEvent[];
}

export interface SupervisorAuditTrail {
  sessions: SupervisorAuditTrailSession[];
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

function markdownText(value: string): string {
  return value.replace(/[\\`]/g, '\\$&').replace(/\r?\n/g, '  \n');
}

function eventMarkdown(event: AuditEvent): string | null {
  const payload = event.payload || {};
  const at = timestamp(event.ts);
  if (event.type === 'worker.task') {
    const task = payloadText(payload, 'task');
    return task ? `### ${at} · 任务\n\n${markdownText(task)}` : null;
  }
  if (event.type === 'worker.lifecycle') {
    const lifecycle = payloadText(payload, 'event') || '未知';
    const message = payloadText(payload, 'message');
    return `### ${at} · 终端事件：${markdownText(lifecycle)}${message ? `\n\n${markdownText(message)}` : ''}`;
  }
  if (event.type === 'supervisor.decision') {
    const outcome = payloadText(payload, 'outcome') || '未知';
    const reason = payloadText(payload, 'reason');
    const next = payloadText(payload, 'next');
    return [
      `### ${at} · 裁决：${markdownText(outcome)}`,
      reason ? `- 原因：${markdownText(reason)}` : '- 原因：未附说明',
      next ? `- 下一步：${markdownText(next)}` : '',
    ].filter(Boolean).join('\n');
  }
  if (event.type === 'session.abandoned') {
    const reason = payloadText(payload, 'reason') || '用户选择重头再来';
    return `### ${at} · 已废除旧上下文\n\n${markdownText(reason)}`;
  }
  if (event.type === 'session.started') {
    return `### ${at} · 监督会话启动`;
  }
  return null;
}

/** Render durable, terminal-isolated audit history into a pathless Markdown tab. */
export function formatSupervisorAuditTrail(lane: SupervisorLane, trail: SupervisorAuditTrail): string {
  const auditPath = lane.projectDir ? `${lane.projectDir}\\.wmux\\supervisor` : '（尚未获得终端工作目录）';
  const header = [
    `# 监督记录 · ${markdownText(lane.label)}`,
    '',
    `- 工作终端：\`${markdownText(lane.surfaceId)}\``,
    `- 审计目录：\`${markdownText(auditPath)}\``,
    `- 刷新时间：${timestamp(Date.now())}`,
    '',
    '> 此页只读入审计流；“重头再来”会保留旧记录，但不会恢复其监督上下文。',
  ];
  if (!trail.sessions.length) {
    return [...header, '', '> 尚未找到该终端的已落盘监督记录。'].join('\n');
  }

  const sessions = trail.sessions.flatMap((session) => {
    const events = session.events.map(eventMarkdown).filter((entry): entry is string => !!entry);
    return [
      '',
      `## 会话 \`${markdownText(session.sessionId)}\``,
      '',
      `开始：${timestamp(session.createdAt)}`,
      ...(events.length ? ['', ...events] : ['', '暂无可展示的事件。']),
    ];
  });
  return [...header, ...sessions].join('\n');
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

/** Read all durable records for one terminal; ambiguous same-name terminals stay isolated. */
export async function readSupervisorAuditTrail(lane: SupervisorLane): Promise<SupervisorAuditTrail> {
  if (!lane.projectDir) return { sessions: [] };
  const api = (window as any).wmux?.supervisor;
  if (!api?.readAuditTrail) return { sessions: [] };
  try {
    const trail = await api.readAuditTrail({
      projectDir: lane.projectDir,
      surfaceId: lane.surfaceId,
      terminalLabel: lane.label,
    }) as Partial<SupervisorAuditTrail>;
    return { sessions: Array.isArray(trail?.sessions) ? trail.sessions : [] };
  } catch (err) {
    console.warn('[supervisor] audit trail read failed', err);
    return { sessions: [] };
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
