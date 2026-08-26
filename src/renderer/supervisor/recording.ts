import type {
  SupervisorDelivery,
  SupervisorDecision,
  SupervisorLane,
  SupervisorRestoreSource,
  SupervisorSession,
} from '../store/supervisor-slice';
import type {
  SupervisedTerminalSnapshot,
  SupervisedTerminalSnapshotSummary,
} from '../../shared/supervisor-recovery';
import { supervisorDeliveryLabel } from './delivery';

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

export interface SupervisorRestoreCandidate extends SupervisorRestoreSource {
  snapshotId: string;
  lastEventAt: number;
  currentTask: string;
  lastDecision: string;
  supervisorAgent: string;
  supervisorModel: string;
  supervisorReasoningEffort: string;
  config: NonNullable<SupervisorLane['config']>;
  autonomous: boolean;
  autonomyPermissions: NonNullable<SupervisorLane['autonomyPermissionsOverride']>;
  forbiddenActions: NonNullable<SupervisorLane['forbiddenActionsOverride']>;
  workScope: NonNullable<SupervisorLane['workScopeOverride']>;
  controlState: 'active' | 'paused' | 'waiting';
}

export interface RestoredLaneHistory {
  currentTask?: string;
  decisions: SupervisorDecision[];
  restoredHistory: string;
  restoredFromSessionId: string;
  config?: SupervisorLane['config'];
  autonomousOverride?: boolean;
  autonomyPermissionsOverride?: SupervisorLane['autonomyPermissionsOverride'];
  forbiddenActionsOverride?: SupervisorLane['forbiddenActionsOverride'];
  workScopeOverride?: SupervisorLane['workScopeOverride'];
  ordinaryBlocker?: SupervisorLane['ordinaryBlocker'];
  ordinaryContextHealth?: SupervisorLane['ordinaryContextHealth'];
  ordinaryContextReset?: SupervisorLane['ordinaryContextReset'];
  ordinaryContextResetCount?: number;
  ordinaryContextResetPlanRevision?: number;
  goalVortex?: SupervisorLane['goalVortex'];
  latestSupervisorUserGuidance?: SupervisorLane['latestSupervisorUserGuidance'];
  standingUserDecision?: SupervisorLane['standingUserDecision'];
  standingUserDecisions?: SupervisorLane['standingUserDecisions'];
  workerTurnId?: number;
  recoverySnapshotId?: string;
  recoverySnapshotSavedAt?: number;
  supervisorLaunchCmdOverride?: string;
  supervisorModelOverride?: string;
  supervisorReasoningEffortOverride?: string;
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

function payloadObject(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = payload[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function timestamp(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function markdownText(value: string): string {
  return value.replace(/[\\`]/g, '\\$&').replace(/\r?\n/g, '  \n');
}

function proposalTitle(proposalKind: string): string {
  switch (proposalKind) {
    case 'route-adjustment': return '小范围路线调整';
    case 'route-change': return '路线变更';
    case 'important': return '重要建议';
    case 'context-recovery': return '上下文恢复指令';
    case 'direction-needed': return '待续方向不足';
    case 'clarification': return '需求对齐';
    default: return '';
  }
}

function outcomeTitle(outcome: string): string {
  switch (outcome) {
    case 'continue': return '继续推进';
    case 'rework': return '需要返工';
    case 'complete': return '已完成';
    case 'needs-human': return '需要人工决策';
    default: return outcome || '未知';
  }
}

function inlineMarkdownText(value: string): string {
  return markdownText(value.replace(/\r?\n/g, '；'));
}

function decisionEventMarkdown(event: AuditEvent): string | null {
  const payload = event.payload || {};
  const at = timestamp(event.ts);
  if (event.type === 'supervisor.decision') {
    const outcome = payloadText(payload, 'outcome') || '未知';
    const outcomeLabel = outcomeTitle(outcome);
    const proposalKind = payloadText(payload, 'proposalKind');
    const reason = payloadText(payload, 'reason');
    const next = payloadText(payload, 'next');
    const impact = payloadText(payload, 'impact');
    const alternatives = payloadText(payload, 'alternatives');
    const taskDispatch = payloadObject(payload, 'taskDispatch');
    const taskOutcome = taskDispatch ? payloadText(taskDispatch, 'outcome') : '';
    const constraints = stringArray(taskDispatch?.constraints);
    const acceptanceGap = stringArray(taskDispatch?.acceptanceGap);
    const evidenceContext = stringArray(taskDispatch?.evidenceContext);
    const goalVortex = payloadObject(payload, 'goalVortex');
    const decisionBasis = reason
      || evidenceContext.join('；')
      || (acceptanceGap.length > 0
        ? `当前成果仍有 ${acceptanceGap.length} 项验收缺口，需要继续推进`
        : `依据当前任务终端证据作出“${outcomeLabel}”裁决`);
    const proposal = proposalTitle(proposalKind);
    const proposalLabel = proposal ? ` · ${proposal}` : '';
    return [
      `#### 【AI 裁决】${markdownText(outcomeLabel)}${proposalLabel}`,
      '',
      `> **判断结果：${markdownText(outcomeLabel)}** · ${at}`,
      '',
      `- 判断依据：${markdownText(decisionBasis)}`,
      impact ? `- 影响：${markdownText(impact)}` : '',
      alternatives ? `- 备选：${markdownText(alternatives)}` : '',
      taskOutcome ? `- 下发成果：${markdownText(taskOutcome)}` : '',
      constraints.length > 0 ? `- 执行约束：${markdownText(constraints.join('；'))}` : '',
      acceptanceGap.length > 0 ? `- 验收缺口：${markdownText(acceptanceGap.join('；'))}` : '',
      evidenceContext.length > 0 ? `- 必要现状：${markdownText(evidenceContext.join('；'))}` : '',
      !taskOutcome && next ? `- 建议下一步：${markdownText(next)}` : '',
      goalVortex ? `- 推进性纠偏：${markdownText(payloadText(goalVortex, 'decisiveNextStep') || '已记录目标旋涡并要求改变推进路径')}` : '',
    ].filter(Boolean).join('\n');
  }
  if (event.type === 'supervisor.goal-vortex.detected'
    || event.type === 'supervisor.goal-vortex.replan-required'
    || event.type === 'supervisor.goal-vortex.rejected-repeat') {
    const rejected = event.type.endsWith('rejected-repeat');
    const forced = event.type.endsWith('replan-required');
    const conditions = stringArray(payload.experimentConditions);
    return [
      `#### 【目标旋涡】${rejected ? '重复纠偏被拒绝' : forced ? '连续空耗，强制重规划' : '发现空耗，立即纠偏'}`,
      '',
      `> **处理结果：${rejected ? '未投递重复任务，要求改变路径' : forced ? '禁止重复原路径' : '已下发纠偏任务'}** · ${at}`,
      '',
      `- 旋涡类型：${markdownText(payloadText(payload, 'kind') || '未分类')}`,
      `- 触发现象：${markdownText(payloadText(payload, 'signal') || '缺少事实信号')}`,
      `- 空耗细节：${markdownText(payloadText(payload, 'wastedEffort') || '缺少空耗说明')}`,
      `- 缺失的决定性证据：${markdownText(payloadText(payload, 'missingEvidence') || '未说明')}`,
      `- 应采取的推进动作：${markdownText(payloadText(payload, 'decisiveNextStep') || '未说明')}`,
      `- 授权边界：${markdownText(payloadText(payload, 'authorizationBoundary') || '未说明')}`,
      conditions.length > 0 ? `- 判别实验条件：${markdownText(conditions.join('；'))}` : '',
      rejected
        ? `- 上轮纠偏任务：${markdownText(payloadText(payload, 'previousCorrectionTask') || '未记录')}`
        : '',
      `- ${rejected ? '被拒绝的重复纠偏' : '已发布纠偏任务'}：${markdownText(payloadText(payload, 'correctionTask') || '等待扩大授权')}`,
      `- 连续出现次数：${Number(payload.occurrence) || 1}`,
    ].filter(Boolean).join('\n');
  }
  if (event.type === 'supervisor.proposal.resolved') {
    const resolutionValue = payloadText(payload, 'resolution');
    let resolution = '已拒绝';
    if (resolutionValue === 'approved') resolution = '已批准';
    else if (resolutionValue === 'cancelled') resolution = '已取消（用户已通过其他方式发送信息）';
    else if (resolutionValue === 'handled-manually') resolution = '已由用户自行处理';
    const proposalKind = payloadText(payload, 'proposalKind');
    const kind = proposalKind === 'route-change'
      ? '路线变更'
      : proposalKind === 'context-recovery'
        ? '上下文恢复指令'
        : proposalKind === 'clarification'
          ? '需求对齐'
          : '重要建议';
    const text = payloadText(payload, 'text');
    return [
      `#### 【人工裁决】${resolution} · ${kind}`,
      '',
      `> **最终结果：${resolution}** · ${at}`,
      text ? `\n- 裁决内容：${markdownText(text)}` : '',
    ].filter(Boolean).join('\n');
  }
  if (event.type === 'supervisor.auto-decision-limit.resolved') {
    return `#### 【人工复核】已确认继续监督\n\n> **复核结果：已审阅** · ${at}\n\n- 已重置该终端的自动判断计数。`;
  }
  if (event.type === 'supervisor.auto-approved') {
    const reason = payloadText(payload, 'reason') || '监督建议符合自动化安全策略';
    const next = payloadText(payload, 'next');
    return `#### 【AI 裁决】自动批准\n\n> **判断结果：已自动批准** · ${at}\n\n- 判断依据：${markdownText(reason)}${next ? `\n- 已发送：${markdownText(next)}` : ''}`;
  }
  if (event.type === 'supervisor.permission-approved') {
    const command = payloadText(payload, 'command') || '未附命令说明';
    const response = payloadText(payload, 'response') || 'y';
    return `#### 【AI 裁决】自动授权\n\n> **判断结果：已授权** · ${at}\n\n- 命令：${markdownText(command)}\n- 响应：${markdownText(response)}`;
  }
  return null;
}

function operationalEventMarkdown(event: AuditEvent): string | null {
  const payload = event.payload || {};
  const at = timestamp(event.ts);
  if (event.type === 'worker.task') {
    const task = payloadText(payload, 'task');
    return task ? `- ${at} · **任务输入**：${inlineMarkdownText(task)}` : null;
  }
  if (event.type === 'worker.lifecycle') {
    const lifecycle = payloadText(payload, 'event') || '未知';
    const message = payloadText(payload, 'message');
    return `- ${at} · **终端事件**：${inlineMarkdownText(lifecycle)}${message ? `；${inlineMarkdownText(message)}` : ''}`;
  }
  if (event.type === 'session.abandoned') {
    const reason = payloadText(payload, 'reason') || '用户选择重头再来';
    return `- ${at} · **旧上下文已废除**：${inlineMarkdownText(reason)}`;
  }
  if (event.type === 'supervisor.delivery.failed') {
    const kind = payloadText(payload, 'kind') === 'permission' ? '权限响应' : '下一步任务';
    const error = payloadText(payload, 'error') || '未知错误';
    return `- ${at} · **${kind}发送失败**：${inlineMarkdownText(error)}`;
  }
  if (
    event.type === 'supervisor.delivery.queued'
    || event.type === 'supervisor.delivery.submitted'
    || event.type === 'supervisor.delivery.delivered'
  ) {
    const kind = payloadText(payload, 'kind');
    const label = supervisorDeliveryLabel(kind as SupervisorDelivery['kind']);
    const status = event.type === 'supervisor.delivery.queued'
      ? '待投递'
      : event.type === 'supervisor.delivery.submitted'
        ? '已提交，等待 Agent 确认'
        : '已送达';
    return `- ${at} · 监督通知${status}：${label}`;
  }
  if (event.type === 'session.started') {
    return `- ${at} · 监督会话启动`;
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
    const decisions = session.events.map(decisionEventMarkdown).filter((entry): entry is string => !!entry);
    const operations = session.events.map(operationalEventMarkdown).filter((entry): entry is string => !!entry);
    return [
      '',
      `## 会话 \`${markdownText(session.sessionId)}\``,
      '',
      `开始：${timestamp(session.createdAt)}`,
      '',
      '### 关键裁决',
      '',
      ...(decisions.length ? decisions.flatMap((decision, index) => index === 0 ? [decision] : ['', '---', '', decision]) : ['> 本会话暂无 AI 裁决或人工决定。']),
      '',
      '### 运行轨迹（辅助信息）',
      '',
      '> 以下为任务、终端生命周期和通知投递记录，不代表裁决结论。',
      '',
      ...(operations.length ? operations : ['- 暂无运行事件。']),
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
      const proposalKind = payloadText(event.payload || {}, 'proposalKind');
      decisions.unshift({
        ts: event.ts,
        task: currentTask || '（任务未上报）',
        outcome: outcome as SupervisorDecision['outcome'],
        ...(proposalKind ? { proposalKind: proposalKind as SupervisorDecision['proposalKind'] } : {}),
        reason,
        next,
      });
      const proposal = proposalTitle(proposalKind);
      const proposalLabel = proposal ? `（${proposal}）` : '';
      lines.push(`${prefix} 监督裁决：${outcome}${proposalLabel}${reason ? `；原因：${reason}` : ''}${next ? `；下一步：${next}` : ''}`);
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

function snapshotRestoredHistory(snapshot: SupervisedTerminalSnapshot): RestoredLaneHistory {
  const decisions = Array.isArray(snapshot.supervisor.state.decisions)
    ? snapshot.supervisor.state.decisions.filter((value): value is SupervisorDecision => (
        !!value && typeof value === 'object' && ['continue', 'rework', 'complete', 'needs-human']
          .includes(String((value as SupervisorDecision).outcome || ''))
      ))
    : [];
  const lines = [
    `[终端快照] ${new Date(snapshot.savedAt).toLocaleString('zh-CN', { hour12: false })}`,
    `任务终端：${snapshot.terminal.label}`,
    `当前任务：${snapshot.supervisor.state.currentTask || '未记录'}`,
    `已验证证据：${snapshot.projectContext.verifiedEvidence.join('；') || '无'}`,
    `验收缺口：${snapshot.projectContext.acceptanceGaps.join('；') || '无'}`,
  ];
  return {
    ...(snapshot.supervisor.state.currentTask ? { currentTask: snapshot.supervisor.state.currentTask } : {}),
    decisions,
    restoredHistory: lines.join('\n'),
    restoredFromSessionId: snapshot.snapshotId,
    config: snapshot.supervisor.config,
    autonomousOverride: snapshot.supervisor.autonomous,
    autonomyPermissionsOverride: [...snapshot.supervisor.autonomyPermissions],
    forbiddenActionsOverride: [...snapshot.supervisor.forbiddenActions],
    workScopeOverride: snapshot.supervisor.workScope,
    ordinaryBlocker: snapshot.supervisor.state.ordinaryBlocker as SupervisorLane['ordinaryBlocker'],
    ordinaryContextHealth: snapshot.supervisor.state.ordinaryContextHealth as SupervisorLane['ordinaryContextHealth'],
    ordinaryContextReset: snapshot.supervisor.state.ordinaryContextReset as SupervisorLane['ordinaryContextReset'],
    ordinaryContextResetCount: snapshot.supervisor.state.ordinaryContextResetCount,
    ordinaryContextResetPlanRevision: snapshot.supervisor.state.ordinaryContextResetPlanRevision,
    goalVortex: snapshot.supervisor.state.goalVortex as SupervisorLane['goalVortex'],
    latestSupervisorUserGuidance: snapshot.supervisor.state.latestSupervisorUserGuidance as SupervisorLane['latestSupervisorUserGuidance'],
    standingUserDecision: snapshot.supervisor.state.standingUserDecision as SupervisorLane['standingUserDecision'],
    standingUserDecisions: snapshot.supervisor.state.standingUserDecisions as SupervisorLane['standingUserDecisions'],
    workerTurnId: snapshot.supervisor.state.workerTurnId,
    recoverySnapshotId: snapshot.snapshotId,
    recoverySnapshotSavedAt: snapshot.savedAt,
    supervisorLaunchCmdOverride: snapshot.supervisor.launchCmd,
    supervisorModelOverride: snapshot.supervisor.model,
    supervisorReasoningEffortOverride: snapshot.supervisor.reasoningEffort,
  };
}

/** Restore the complete terminal snapshot explicitly selected by the user. */
export async function restoreSelectedLaneHistory(
  lane: SupervisorLane,
  source: SupervisorRestoreSource,
): Promise<RestoredLaneHistory | null> {
  if (!lane.projectDir) return null;
  const api = (window as any).wmux?.supervisor;
  if (!api?.readRecoverySnapshot || !source.snapshotId) return null;
  try {
    const result = await api.readRecoverySnapshot({
      projectDir: lane.projectDir,
      snapshotId: source.snapshotId,
    }) as { ok?: boolean; snapshot?: SupervisedTerminalSnapshot; error?: string };
    return result.ok && result.snapshot ? snapshotRestoredHistory(result.snapshot) : null;
  } catch (err) {
    console.warn('[supervisor] selected terminal snapshot restore failed', err);
    return null;
  }
}

/** List user-saved terminal snapshots for a project. Audit history is not a restore source. */
export async function listSupervisorRestoreCandidates(projectDir: string): Promise<SupervisorRestoreCandidate[]> {
  if (!projectDir) return [];
  const api = (window as any).wmux?.supervisor;
  if (!api?.listRecoverySnapshots) return [];
  try {
    const candidates = await api.listRecoverySnapshots(projectDir) as SupervisedTerminalSnapshotSummary[];
    return Array.isArray(candidates) ? candidates.map((candidate) => ({
      snapshotId: candidate.snapshotId,
      surfaceId: candidate.surfaceId,
      label: candidate.label,
      sessionId: candidate.snapshotId,
      lastEventAt: candidate.savedAt,
      currentTask: candidate.currentTask,
      lastDecision: candidate.lastDecision,
      supervisorAgent: candidate.supervisorAgent,
      supervisorModel: candidate.supervisorModel,
      supervisorReasoningEffort: candidate.supervisorReasoningEffort,
      config: candidate.config,
      autonomous: candidate.autonomous,
      autonomyPermissions: candidate.autonomyPermissions,
      forbiddenActions: candidate.forbiddenActions,
      workScope: candidate.workScope,
      controlState: candidate.controlState,
    })) : [];
  } catch (err) {
    console.warn('[supervisor] restore candidate list failed', err);
    return [];
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
  const managementSessionId = lane.managementSessionId || session.sessionId;
  if (!managementSessionId || !lane.projectDir) return;
  const compactPayload = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, compact(value)]),
  );
  if (lane.projectWorkItemId) {
    compactPayload.projectWorkItemId = lane.projectWorkItemId;
    const event = String(compactPayload.event || compactPayload.outcome || '').trim();
    const detail = String(compactPayload.reason || compactPayload.message || compactPayload.error || '').trim();
    // Project AI receives state handoffs, not the supervisor's routine inner
    // loop. Worker lifecycle and continue/rework decisions stay within the
    // dedicated supervisor so the manager inbox cannot become a progress log.
    const important = type === 'supervisor.provider-limit'
      || type === 'supervisor.delivery.failed'
      || type === 'supervisor.waiting-for-direction'
      || type === 'supervisor.idle-unreported'
      || type === 'supervisor.goal-vortex.replan-required';
    if (important) {
      const notification = (window as any).__wmux_projectManagerRemoteControl?.({
        action: 'event',
        projectId: lane.projectManagerProjectId,
        laneId: lane.id,
        workItemId: lane.projectWorkItemId,
        eventType: type,
        summary: [event, detail].filter(Boolean).join('：').slice(0, 1200) || type,
        payload: compactPayload,
      });
      void Promise.resolve(notification).catch((err: unknown) => (
        console.warn('[project-manager] supervisor event delivery failed', err)
      ));
    }
  }
  const api = (window as any).wmux?.supervisor;
  if (!api?.appendRecord) return;
  void api.appendRecord({
    sessionId: managementSessionId,
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
