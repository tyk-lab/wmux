import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';
import type { SupervisorRecord } from './supervisor-records';

export type FeishuSupervisorCommand =
  | { action: 'list' }
  | { action: 'start'; terminals: string[]; stopWhen: string; stopWhenKind: 'concrete' | 'direction'; taskDescription?: string; preconditions?: string; planFile?: string; autonomous: boolean; supervisorLaunchCmd?: string; supervisorModel?: string; supervisorReasoningEffort?: string }
  | { action: 'send'; terminal: string; task: string }
  | { action: 'stop' }
  | { action: 'decide'; approvalId: string; decision: 'approve' | 'reject' | 'stop'; task?: string };

export interface FeishuSupervisorControl {
  (command: FeishuSupervisorCommand, actor: { openId: string; source: 'text' | 'card' }): Promise<unknown>;
}

interface FeishuConfig {
  appId: string;
  appSecret: string;
  chatId: string;
  allowedOpenIds: Set<string>;
}

export function isFeishuSupervisorActorAllowed(
  config: Pick<FeishuConfig, 'chatId' | 'allowedOpenIds'>,
  chatId: string,
  openId: string,
  chatType: 'group' | 'p2p',
): boolean {
  if (!config.allowedOpenIds.has(openId)) return false;
  return chatType === 'p2p' || chatId === config.chatId;
}

interface ApprovalCard {
  messageId: string;
  approvalId: string;
}

const COMMAND_PREFIX = 'WMUX SUPERVISOR ';
const MAX_COMMAND_VALUE_LENGTH = 4000;
const FEISHU_ENV_KEYS = ['WMUX_FEISHU_APP_ID', 'WMUX_FEISHU_APP_SECRET', 'WMUX_FEISHU_CHAT_ID', 'WMUX_FEISHU_ALLOWED_OPEN_IDS'] as const;

type FeishuEnvKey = typeof FEISHU_ENV_KEYS[number];

function applyFeishuEnv(target: NodeJS.ProcessEnv, values: Partial<Record<FeishuEnvKey, string>>): void {
  for (const key of FEISHU_ENV_KEYS) {
    if (!target[key]?.trim() && values[key]?.trim()) target[key] = values[key];
  }
}

export function parseFeishuDotEnv(content: string): Partial<Record<FeishuEnvKey, string>> & { WMUX_FEISHU_ENV_FILE?: string } {
  const values: Partial<Record<FeishuEnvKey, string>> & { WMUX_FEISHU_ENV_FILE?: string } = {};
  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*(WMUX_FEISHU_(?:APP_ID|APP_SECRET|CHAT_ID|ALLOWED_OPEN_IDS|ENV_FILE))\s*=\s*(.*?)\s*$/.exec(rawLine);
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2').trim();
    if (value) values[match[1] as keyof typeof values] = value;
  }
  return values;
}

/** Supports the label/value scratch file used during the first Feishu setup. */
export function parseLegacyFeishuEnv(content: string): Partial<Record<FeishuEnvKey, string>> {
  const labels: Record<string, FeishuEnvKey> = {
    'App ID': 'WMUX_FEISHU_APP_ID',
    'App Secret': 'WMUX_FEISHU_APP_SECRET',
    '群聊会话 ID': 'WMUX_FEISHU_CHAT_ID',
    '用户 ID': 'WMUX_FEISHU_ALLOWED_OPEN_IDS',
  };
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim());
  const values: Partial<Record<FeishuEnvKey, string>> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const key = labels[lines[index]];
    if (!key) continue;
    let value: string | undefined;
    for (const candidate of lines.slice(index + 1)) {
      if (!candidate) continue;
      if (labels[candidate]) break;
      value = candidate;
      break;
    }
    if (value) values[key] = value;
  }
  return values;
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Load local Feishu configuration without overriding environment variables set by the launcher. */
export function loadFeishuEnvironment(env = process.env, cwd = process.cwd(), executableDir = path.dirname(process.execPath)): void {
  const envPaths = [...new Set([path.join(cwd, '.env'), path.join(executableDir, '.env')])];
  let legacyFile: string | undefined = env.WMUX_FEISHU_ENV_FILE?.trim();
  let legacyBaseDir = cwd;
  for (const envPath of envPaths) {
    const content = readText(envPath);
    if (!content) continue;
    const values = parseFeishuDotEnv(content);
    applyFeishuEnv(env, values);
    if (!legacyFile && values.WMUX_FEISHU_ENV_FILE) {
      legacyFile = values.WMUX_FEISHU_ENV_FILE;
      legacyBaseDir = path.dirname(envPath);
    }
  }
  if (!legacyFile) return;
  const legacyPath = path.isAbsolute(legacyFile) ? legacyFile : path.resolve(legacyBaseDir, legacyFile);
  const legacyContent = readText(legacyPath);
  if (legacyContent) applyFeishuEnv(env, parseLegacyFeishuEnv(legacyContent));
}

function envConfig(env = process.env): FeishuConfig | null {
  loadFeishuEnvironment(env);
  const appId = env.WMUX_FEISHU_APP_ID?.trim();
  const appSecret = env.WMUX_FEISHU_APP_SECRET?.trim();
  const chatId = env.WMUX_FEISHU_CHAT_ID?.trim();
  const allowedOpenIds = new Set((env.WMUX_FEISHU_ALLOWED_OPEN_IDS || '').split(',').map((item) => item.trim()).filter(Boolean));
  if (!appId || !appSecret || !chatId || allowedOpenIds.size === 0) return null;
  return { appId, appSecret, chatId, allowedOpenIds };
}

function fieldMap(lines: string[]): Record<string, string> {
  return Object.fromEntries(lines.map((line) => {
    const match = /^([a-z_]+)\s*:\s*(.*)$/i.exec(line.trim());
    return match ? [match[1].toLowerCase(), match[2].trim().slice(0, MAX_COMMAND_VALUE_LENGTH)] : [];
  }).filter((entry) => entry.length === 2));
}

function hasOnlyFields(fields: Record<string, string>, allowed: string[]): boolean {
  return Object.keys(fields).every((field) => allowed.includes(field));
}

/** Parse the intentionally small, non-shell Feishu command grammar. */
export function parseFeishuSupervisorCommand(input: string): FeishuSupervisorCommand | { error: string } {
  const lines = input.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const header = (lines.shift() || '').toUpperCase();
  if (!header.startsWith(COMMAND_PREFIX)) return { error: '命令须以 WMUX SUPERVISOR 开头。' };
  if (lines.some((line) => !/^[a-z_]+\s*:/i.test(line))) return { error: '命令字段须使用 key: value 格式。' };
  const verb = header.slice(COMMAND_PREFIX.length).trim();
  const fields = fieldMap(lines);
  if (verb === 'LIST') return { action: 'list' };
  if (verb === 'STOP') {
    if (!hasOnlyFields(fields, ['session']) || (fields.session && fields.session.toLowerCase() !== 'current')) return { error: 'STOP 仅支持 session: current。' };
    return { action: 'stop' };
  }
  if (verb === 'SEND') {
    if (!hasOnlyFields(fields, ['terminal', 'task'])) return { error: 'SEND 包含不支持的字段。' };
    if (!fields.terminal || !fields.task) return { error: 'SEND 需要 terminal 和 task。' };
    return { action: 'send', terminal: fields.terminal, task: fields.task };
  }
  if (verb === 'DECIDE') {
    if (!hasOnlyFields(fields, ['approval_id', 'action', 'task'])) return { error: 'DECIDE 包含不支持的字段。' };
    const decision = fields.action?.toLowerCase();
    if (!fields.approval_id || !['approve', 'reject', 'stop'].includes(decision || '')) {
      return { error: 'DECIDE 需要 approval_id 和 action: approve|reject|stop。' };
    }
    if (decision === 'approve' && !fields.task) return { error: '批准时需要 task，作为后续任务发送到被监督终端。' };
    return { action: 'decide', approvalId: fields.approval_id, decision: decision as 'approve' | 'reject' | 'stop', task: fields.task || undefined };
  }
  if (verb !== 'START') return { error: '支持 LIST、START、SEND、STOP、DECIDE。' };
  if (!hasOnlyFields(fields, ['terminals', 'stop_when', 'stop_when_kind', 'task_description', 'preconditions', 'plan_file', 'autonomous', 'supervisor_launch_cmd', 'supervisor_model', 'supervisor_reasoning'])) {
    return { error: 'START 包含不支持的字段。' };
  }
  const terminals = (fields.terminals || '').split(',').map((item) => item.trim()).filter(Boolean);
  const stopWhenKind = fields.stop_when_kind === 'direction' ? 'direction' : 'concrete';
  if (terminals.length === 0 || !fields.stop_when) return { error: 'START 需要 terminals 和 stop_when。' };
  if (fields.stop_when_kind && !['concrete', 'direction'].includes(fields.stop_when_kind)) return { error: 'stop_when_kind 只能是 concrete 或 direction。' };
  if (fields.autonomous && !['on', 'off'].includes(fields.autonomous.toLowerCase())) return { error: 'autonomous 只能是 on 或 off。' };
  return {
    action: 'start', terminals, stopWhen: fields.stop_when, stopWhenKind,
    taskDescription: fields.task_description || undefined, preconditions: fields.preconditions || undefined,
    planFile: fields.plan_file || undefined, autonomous: fields.autonomous?.toLowerCase() === 'on',
    supervisorLaunchCmd: fields.supervisor_launch_cmd || undefined,
    supervisorModel: fields.supervisor_model || undefined,
    supervisorReasoningEffort: fields.supervisor_reasoning || undefined,
  };
}

function summary(value: unknown): string {
  if (!value || typeof value !== 'object') return '已处理。';
  const result = value as { ok?: boolean; error?: string; message?: string };
  return result.error || result.message || (result.ok === false ? '操作未完成。' : '已处理。');
}

interface FeishuListTerminal {
  surfaceId: string;
  label: string;
  workspace: string;
  supervised: boolean;
}

interface FeishuListSession {
  sessionId: string;
  stopWhen: string;
  autonomous: boolean;
}

interface FeishuListApproval {
  id: string;
  terminal: string;
  reason: string;
}

interface FeishuListResult {
  active: boolean;
  terminals: FeishuListTerminal[];
  session: FeishuListSession | null;
  pendingApprovals: FeishuListApproval[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asText(value: unknown, fallback = '未提供'): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function parseListResult(value: unknown): FeishuListResult | null {
  if (!isObject(value) || typeof value.message !== 'string') return null;
  try {
    const parsed = JSON.parse(value.message) as unknown;
    if (!isObject(parsed) || !Array.isArray(parsed.terminals)) return null;
    const terminals = parsed.terminals.flatMap((terminal): FeishuListTerminal[] => {
      if (!isObject(terminal) || typeof terminal.surfaceId !== 'string') return [];
      return [{
        surfaceId: terminal.surfaceId,
        label: asText(terminal.label),
        workspace: asText(terminal.workspace),
        supervised: terminal.supervised === true,
      }];
    });
    const session = isObject(parsed.session) && typeof parsed.session.sessionId === 'string'
      ? { sessionId: parsed.session.sessionId, stopWhen: asText(parsed.session.stopWhen), autonomous: parsed.session.autonomous === true }
      : null;
    const pendingApprovals = Array.isArray(parsed.pendingApprovals)
      ? parsed.pendingApprovals.flatMap((approval): FeishuListApproval[] => isObject(approval) && typeof approval.id === 'string'
        ? [{ id: approval.id, terminal: asText(approval.terminal), reason: asText(approval.reason) }]
        : [])
      : [];
    return { active: parsed.active === true, terminals, session, pendingApprovals };
  } catch {
    return null;
  }
}

/** Render LIST as readable text while retaining IDs needed by START. */
export function formatFeishuSupervisorResponse(command: FeishuSupervisorCommand, value: unknown): string {
  if (command.action !== 'list') return summary(value);
  const result = parseListResult(value);
  if (!result) return summary(value);

  const lines = [
    'wmux · AI 监督状态',
    `监督会话：${result.active ? '进行中' : '未启动'}`,
    `可监督终端：${result.terminals.length} 个`,
  ];
  if (result.session) {
    lines.push(`会话 ID：${result.session.sessionId}`);
    lines.push(`AI 自主决策：${result.session.autonomous ? '开启' : '关闭'}`);
    lines.push(`停止条件：${result.session.stopWhen}`);
  }
  lines.push('', '终端列表：');
  if (result.terminals.length === 0) lines.push('暂无可监督终端。');
  for (const [index, terminal] of result.terminals.entries()) {
    lines.push(`${index + 1}. ${terminal.label} · ${terminal.workspace}`);
    lines.push(`   状态：${terminal.supervised ? '监督中' : '未监督'}`);
    lines.push(`   终端 ID：${terminal.surfaceId}`);
  }
  lines.push('', `待人工审批：${result.pendingApprovals.length ? `${result.pendingApprovals.length} 项` : '无'}`);
  for (const approval of result.pendingApprovals) {
    lines.push(`- ${approval.terminal}：${approval.reason}（${approval.id}）`);
  }
  lines.push('', '提示：复制“终端 ID”填写到 WMUX SUPERVISOR START 的 terminals 字段。');
  return lines.join('\n');
}

function eventSummary(record: SupervisorRecord): string | null {
  const titles: Record<string, string> = {
    'session.started': 'AI 监督已启动',
    'session.abandoned': 'AI 监督已重置',
    'supervisor.auto-approved': 'AI 监督已自动批准',
    'supervisor.permission-approved': 'AI 监督已自动授权',
    'supervisor.decision': 'AI 监督裁决',
    'supervisor.remote-command': '飞书远程命令',
    'supervisor.remote-decision': '飞书人工决策',
  };
  const title = titles[record.type];
  if (!title) return null;
  const detail = String(record.payload?.reason || record.payload?.outcome || record.payload?.resolution || '').slice(0, 500);
  return `${title}\n终端：${record.terminal.label}${detail ? `\n摘要：${detail}` : ''}`;
}

function approvalCard(record: SupervisorRecord): object {
  const payload = record.payload || {};
  const approvalId = String(payload.approvalId || '');
  const reason = String(payload.reason || '需要人工决策').slice(0, 800);
  const impact = String(payload.impact || '未提供').slice(0, 500);
  const alternatives = String(payload.alternatives || '未提供').slice(0, 500);
  const action = (decision: string, text: string, type: 'primary' | 'default' | 'danger' = 'default') => ({
    tag: 'button', text: { tag: 'plain_text', content: text }, type,
    action_type: 'form_submit', value: { wmux_action: 'decide', approval_id: approvalId, decision },
  });
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'wmux AI 监督：待人工决策' }, template: 'orange' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**终端**：${record.terminal.label}\n**原因**：${reason}\n**影响**：${impact}\n**备选**：${alternatives}` } },
      {
        tag: 'form', name: 'wmux_supervisor_decision', elements: [
          {
            tag: 'input', name: 'follow_up_task', required: false,
            label: { tag: 'plain_text', content: '后续任务（批准时必填）' },
            placeholder: { tag: 'plain_text', content: '填写要转发到被监督终端的后续任务或决策说明' },
          },
          { tag: 'action', actions: [action('approve', '批准并发送任务', 'primary'), action('reject', '拒绝'), action('stop', '停止监督', 'danger')] },
        ],
      },
    ],
  };
}

export class FeishuSupervisorService {
  private readonly config = envConfig();
  private channel: Lark.LarkChannel | null = null;
  private readonly seen = new Set<string>();
  private readonly approvalCards = new Map<string, ApprovalCard>();

  constructor(private readonly control: FeishuSupervisorControl) {}

  start(): void {
    if (!this.config || this.channel) return;
    this.channel = Lark.createLarkChannel({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      transport: 'websocket',
      policy: {
        groupAllowlist: [this.config.chatId],
        dmMode: 'allowlist',
        dmAllowlist: [...this.config.allowedOpenIds],
        requireMention: false,
      },
      // The normalized event omits form fields; retain raw callbacks for the
      // optional follow-up task entered in an approval card.
      includeRawEvent: true,
      source: 'wmux-supervisor',
    });
    this.channel.on({
      message: (message) => void this.handleText(
        message.chatId,
        message.senderId,
        message.messageId,
        message.content,
        message.chatType,
      ),
      reject: (event) => console.warn(`[feishu] message rejected by SDK policy: ${event.reason}`),
      cardAction: (event) => void this.handleCardAction(event),
      error: (err) => console.warn('[feishu] supervisor channel error', err.message),
      reconnected: () => void this.sendText('wmux 已重新连接飞书监督通道。'),
    });
    void this.channel.connect().catch((err) => console.warn('[feishu] supervisor channel unavailable', err));
  }

  onRecord(record: SupervisorRecord): void {
    if (!this.channel) return;
    if (record.type === 'supervisor.approval.requested' && record.payload?.approvalId) {
      void this.sendApproval(record);
      return;
    }
    if (record.type === 'supervisor.proposal.resolved' && record.payload?.approvalId) {
      void this.updateApproval(String(record.payload.approvalId), String(record.payload.resolution || '已处理'));
      return;
    }
    const text = eventSummary(record);
    if (text) void this.sendText(text);
  }

  private allowed(chatId: string, openId: string, chatType: 'group' | 'p2p'): boolean {
    return !!this.config && isFeishuSupervisorActorAllowed(this.config, chatId, openId, chatType);
  }

  private async handleText(
    chatId: string,
    openId: string,
    messageId: string,
    content: string,
    chatType: 'group' | 'p2p',
  ): Promise<void> {
    const allowed = this.allowed(chatId, openId, chatType);
    console.info(`[feishu] message received: type=${chatType}, group=${chatId === this.config?.chatId}, sender=${this.config?.allowedOpenIds.has(openId) === true}, duplicate=${this.seen.has(messageId)}`);
    if (!allowed || this.seen.has(messageId)) return;
    this.remember(messageId);
    const command = parseFeishuSupervisorCommand(content);
    if ('error' in command) {
      console.info('[feishu] supervisor command rejected: invalid format');
      return void this.sendText(command.error, chatId);
    }
    console.info(`[feishu] supervisor command accepted: ${command.action}`);
    const result = await this.control(command, { openId, source: 'text' }).catch((err) => ({ error: String(err?.message || err) }));
    await this.sendText(formatFeishuSupervisorResponse(command, result), chatId);
  }

  private async handleCardAction(event: Lark.CardActionEvent): Promise<void> {
    if (!this.config?.allowedOpenIds.has(event.operator.openId) || event.chatId !== this.config.chatId) return;
    const value = event.action.value as { wmux_action?: string; approval_id?: string; decision?: string };
    if (value?.wmux_action !== 'decide' || !value.approval_id || !['approve', 'reject', 'stop'].includes(value.decision || '')) return;
    const dedupeKey = `${event.messageId}:${value.decision}`;
    if (this.seen.has(dedupeKey)) return;
    this.remember(dedupeKey);
    const result = await this.control({
      action: 'decide', approvalId: value.approval_id, decision: value.decision as 'approve' | 'reject' | 'stop', task: this.cardFollowUpTask(event),
    }, { openId: event.operator.openId, source: 'card' }).catch((err) => ({ error: String(err?.message || err) }));
    const failed = !!(result && typeof result === 'object' && (result as { error?: string }).error);
    const card = this.approvalCards.get(value.approval_id);
    if (failed) {
      // A missing/invalid follow-up task is correctable in the same card.
      // Do not let the click dedupe prevent the user from submitting again.
      this.seen.delete(dedupeKey);
      await this.sendText(`人工决策未执行：${summary(result)}`, event.chatId);
      return;
    }
    if (card && this.channel) {
      await this.channel.updateCard(card.messageId, {
        header: { title: { tag: 'plain_text', content: 'wmux AI 监督：人工决策已处理' }, template: 'green' },
        elements: [{ tag: 'div', text: { tag: 'plain_text', content: `${value.decision}：${summary(result)}` } }],
      }).catch(() => undefined);
    }
  }

  private cardFollowUpTask(event: Lark.CardActionEvent): string | undefined {
    if (!isObject(event.raw) || !isObject(event.raw.action) || !isObject(event.raw.action.form_value)) return undefined;
    const task = event.raw.action.form_value.follow_up_task;
    return typeof task === 'string' && task.trim() ? task.trim().slice(0, MAX_COMMAND_VALUE_LENGTH) : undefined;
  }

  private async sendApproval(record: SupervisorRecord): Promise<void> {
    if (!this.channel) return;
    const approvalId = String(record.payload?.approvalId || '');
    const sent = await this.channel.send(this.config!.chatId, { card: approvalCard(record) });
    this.approvalCards.set(approvalId, { approvalId, messageId: sent.messageId });
  }

  private async updateApproval(approvalId: string, resolution: string): Promise<void> {
    const card = this.approvalCards.get(approvalId);
    if (!card || !this.channel) return;
    await this.channel.updateCard(card.messageId, {
      header: { title: { tag: 'plain_text', content: 'wmux AI 监督：人工决策已处理' }, template: resolution === 'approved' ? 'green' : 'grey' },
      elements: [{ tag: 'div', text: { tag: 'plain_text', content: `结果：${resolution}` } }],
    }).catch(() => undefined);
  }

  private async sendText(text: string, chatId = this.config?.chatId): Promise<void> {
    if (!this.channel || !chatId) return;
    await this.channel.send(chatId, { text: text.slice(0, 1800) }).catch((err) => console.warn('[feishu] send failed', err));
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value as string);
  }
}
