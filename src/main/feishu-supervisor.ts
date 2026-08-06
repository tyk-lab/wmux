import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';
import type { SupervisorRecord } from './supervisor-records';
import { getAppDataDir } from '../shared/instance';

export type FeishuSupervisorCommand =
  | { action: 'list' }
  | { action: 'create-task'; name: string; task: string; cwd?: string; displayPath?: string }
  | { action: 'start'; terminals: string[]; stopWhen: string; stopWhenKind: 'concrete' | 'direction'; taskGoal?: string; taskDescription?: string; preconditions?: string; planFile?: string; autonomous: boolean; supervisorLaunchCmd?: string; supervisorModel?: string; supervisorReasoningEffort?: string }
  | { action: 'send'; terminal: string; task: string; force?: boolean }
  | { action: 'pause-lane'; terminal: string }
  | { action: 'resume-lane'; terminal: string }
  | { action: 'stop-lane'; terminal: string }
  | { action: 'pause-all' }
  | { action: 'resume-all' }
  | { action: 'stop' }
  | { action: 'decide'; approvalId: string; decision: 'approve' | 'reject' | 'pause' | 'stop'; task?: string };

export interface FeishuSupervisorControl {
  (command: FeishuSupervisorCommand, actor: { openId: string; source: 'text' | 'card' }): Promise<unknown>;
}

interface FeishuConfig {
  appId: string;
  appSecret: string;
  chatId: string;
  controlChatId?: string;
  decisionChatId?: string;
  allowedOpenIds: Set<string>;
}

export function isFeishuSupervisorActorAllowed(
  config: Pick<FeishuConfig, 'controlChatId' | 'allowedOpenIds'>,
  chatId: string,
  openId: string,
  chatType: 'group' | 'p2p',
): boolean {
  if (!config.allowedOpenIds.has(openId)) return false;
  return chatType === 'p2p' || (chatType === 'group' && !!config.controlChatId && chatId === config.controlChatId);
}

interface ApprovalCard {
  messageId: string;
  approvalId: string;
  chatId: string;
}

type PendingDecisionMessage =
  | { kind: 'approval'; approvalId: string; record: SupervisorRecord }
  | { kind: 'text'; text: string };

export function isFeishuApprovalCardContext(
  card: Pick<ApprovalCard, 'messageId' | 'chatId'> | undefined,
  messageId: string,
  chatId: string,
): boolean {
  return !!card && card.messageId === messageId && card.chatId === chatId;
}

const COMMAND_PREFIX = 'WMUX SUPERVISOR ';
const MAX_COMMAND_VALUE_LENGTH = 4000;
const FEISHU_ENV_KEYS = ['WMUX_FEISHU_APP_ID', 'WMUX_FEISHU_APP_SECRET', 'WMUX_FEISHU_CHAT_ID', 'WMUX_FEISHU_CONTROL_CHAT_ID', 'WMUX_FEISHU_DECISION_CHAT_ID', 'WMUX_FEISHU_ALLOWED_OPEN_IDS'] as const;
const LEGACY_DOT_ENV_KEY_MAP: Record<string, FeishuEnvKey> = {
  FEISHU_APP_ID: 'WMUX_FEISHU_APP_ID',
  FEISHU_APP_SECRET: 'WMUX_FEISHU_APP_SECRET',
  FEISHU_CHAT_ID: 'WMUX_FEISHU_DECISION_CHAT_ID',
  FEISHU_GROUP_CHAT_ID: 'WMUX_FEISHU_CHAT_ID',
  FEISHU_USER_OPEN_ID: 'WMUX_FEISHU_ALLOWED_OPEN_IDS',
};

type FeishuEnvKey = typeof FEISHU_ENV_KEYS[number];

function applyFeishuEnv(target: NodeJS.ProcessEnv, values: Partial<Record<FeishuEnvKey, string>>): void {
  for (const key of FEISHU_ENV_KEYS) {
    if (!target[key]?.trim() && values[key]?.trim()) target[key] = values[key];
  }
}

export function parseFeishuDotEnv(content: string): Partial<Record<FeishuEnvKey, string>> & { WMUX_FEISHU_ENV_FILE?: string } {
  const values: Partial<Record<FeishuEnvKey, string>> & { WMUX_FEISHU_ENV_FILE?: string } = {};
  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*(WMUX_FEISHU_(?:APP_ID|APP_SECRET|CHAT_ID|CONTROL_CHAT_ID|DECISION_CHAT_ID|ALLOWED_OPEN_IDS|ENV_FILE)|FEISHU_(?:APP_ID|APP_SECRET|CHAT_ID|GROUP_CHAT_ID|USER_OPEN_ID))\s*=\s*(.*?)\s*$/.exec(rawLine);
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2').trim();
    const key = LEGACY_DOT_ENV_KEY_MAP[match[1]] || match[1] as FeishuEnvKey | 'WMUX_FEISHU_ENV_FILE';
    if (value) values[key] = value;
  }
  return values;
}

/** Supports the label/value scratch file used during the first Feishu setup. */
export function parseLegacyFeishuEnv(content: string): Partial<Record<FeishuEnvKey, string>> {
  const labels: Record<string, FeishuEnvKey> = {
    'App ID': 'WMUX_FEISHU_APP_ID',
    'App Secret': 'WMUX_FEISHU_APP_SECRET',
    '单聊会话 ID': 'WMUX_FEISHU_DECISION_CHAT_ID',
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
export function loadFeishuEnvironment(
  env = process.env,
  cwd = process.cwd(),
  executableDir = path.dirname(process.execPath),
  appDataDir = getAppDataDir(),
): void {
  const envPaths = [...new Set([
    path.join(cwd, '.env'),
    path.join(executableDir, '.env'),
    path.join(appDataDir, '.env'),
  ])];
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
  const controlChatId = env.WMUX_FEISHU_CONTROL_CHAT_ID?.trim();
  const decisionChatId = env.WMUX_FEISHU_DECISION_CHAT_ID?.trim();
  const allowedOpenIds = new Set((env.WMUX_FEISHU_ALLOWED_OPEN_IDS || '').split(',').map((item) => item.trim()).filter(Boolean));
  if (!appId || !appSecret || !chatId || allowedOpenIds.size === 0) return null;
  return { appId, appSecret, chatId, controlChatId, decisionChatId, allowedOpenIds };
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

/** Friendly control entrypoints for people who should not need to remember command syntax. */
export function isFeishuSupervisorHelp(input: string): boolean {
  return ['wmux帮助', 'wmux 帮助', 'wmux help', '帮助'].includes(input.trim().toLowerCase());
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
  if (verb === 'PAUSE' || verb === 'RESUME') {
    if (!hasOnlyFields(fields, ['terminal']) || !fields.terminal) {
      return { error: `${verb} 需要 terminal。` };
    }
    return { action: verb === 'PAUSE' ? 'pause-lane' : 'resume-lane', terminal: fields.terminal };
  }
  if (verb === 'STOP') {
    if (!hasOnlyFields(fields, ['session', 'terminal'])) return { error: 'STOP 仅支持 session 或 terminal。' };
    if (fields.terminal && !fields.session) return { action: 'stop-lane', terminal: fields.terminal };
    if (fields.session?.toLowerCase() === 'current' && !fields.terminal) return { action: 'stop' };
    return { error: 'STOP 需要 terminal: <终端 ID> 或 session: current。' };
  }
  if (verb === 'SEND') {
    if (!hasOnlyFields(fields, ['terminal', 'task'])) return { error: 'SEND 包含不支持的字段。' };
    if (!fields.terminal || !fields.task) return { error: 'SEND 需要 terminal 和 task。' };
    return { action: 'send', terminal: fields.terminal, task: fields.task };
  }
  if (verb === 'DECIDE') {
    if (!hasOnlyFields(fields, ['approval_id', 'action', 'task'])) return { error: 'DECIDE 包含不支持的字段。' };
    const decision = fields.action?.toLowerCase();
    if (!fields.approval_id || !['approve', 'reject', 'pause', 'stop'].includes(decision || '')) {
      return { error: 'DECIDE 需要 approval_id 和 action: approve|reject|pause|stop。' };
    }
    return { action: 'decide', approvalId: fields.approval_id, decision: decision as 'approve' | 'reject' | 'pause' | 'stop', task: fields.task || undefined };
  }
  if (verb !== 'START') return { error: '支持 LIST、START、SEND、PAUSE、RESUME、STOP、DECIDE。' };
  if (!hasOnlyFields(fields, ['terminals', 'stop_when', 'stop_when_kind', 'task_goal', 'task_description', 'preconditions', 'plan_file', 'autonomous', 'supervisor_launch_cmd', 'supervisor_model', 'supervisor_reasoning'])) {
    return { error: 'START 包含不支持的字段。' };
  }
  const terminals = (fields.terminals || '').split(',').map((item) => item.trim()).filter(Boolean);
  const stopWhenKind = fields.stop_when_kind === 'direction' ? 'direction' : 'concrete';
  if (terminals.length === 0 || !fields.stop_when) return { error: 'START 需要 terminals 和 stop_when。' };
  if (fields.stop_when_kind && !['concrete', 'direction'].includes(fields.stop_when_kind)) return { error: 'stop_when_kind 只能是 concrete 或 direction。' };
  if (fields.autonomous && !['on', 'off'].includes(fields.autonomous.toLowerCase())) return { error: 'autonomous 只能是 on 或 off。' };
  return {
    action: 'start', terminals, stopWhen: fields.stop_when, stopWhenKind,
    taskGoal: fields.task_goal || undefined,
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

function failedResult(value: unknown): boolean {
  return isObject(value) && (typeof value.error === 'string' || value.ok === false);
}

type FeishuTerminalActivityState = 'idle' | 'working' | 'blocked' | 'unknown';

interface FeishuListTerminal {
  surfaceId: string;
  label: string;
  workspace: string;
  supervised: boolean;
  restartable?: boolean;
  supervisionState?: 'active' | 'paused' | 'stopped' | 'none';
  managementSessionId?: string;
  autonomous?: boolean;
  autonomyPermissionCount?: number;
  forbiddenActionCount?: number;
  policyOverridden?: boolean;
  activityState?: FeishuTerminalActivityState;
  activityUpdatedAt?: number;
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
  paused: boolean;
  terminals: FeishuListTerminal[];
  session: FeishuListSession | null;
  pendingApprovals: FeishuListApproval[];
}

interface FeishuControlState {
  active: boolean;
  paused: boolean;
  totalTerminals: number;
  availableTerminals: number;
  supervisedTerminals: number;
  pendingApprovals: number;
}

function isStartableSupervisorTerminal(terminal: FeishuListTerminal): boolean {
  if (terminal.supervisionState === 'active' || terminal.supervisionState === 'paused') return false;
  if (terminal.supervisionState === 'stopped') return true;
  return !terminal.supervised;
}

const TERMINAL_ACTIVITY_LABELS: Record<FeishuTerminalActivityState, string> = {
  idle: '空闲',
  working: '执行中',
  blocked: '等待人工',
  unknown: '未知',
};

function relativeActivityTime(updatedAt?: number, now = Date.now()): string {
  if (!updatedAt || !Number.isFinite(updatedAt)) return '';
  const ageSeconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (ageSeconds < 10) return '刚刚';
  if (ageSeconds < 60) return `${ageSeconds}秒前`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes}分钟前`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}小时前`;
  return `${Math.floor(ageHours / 24)}天前`;
}

function terminalActivityText(terminal: FeishuListTerminal): string {
  const freshness = relativeActivityTime(terminal.activityUpdatedAt);
  return `${TERMINAL_ACTIVITY_LABELS[terminal.activityState || 'unknown']}${freshness ? ` · ${freshness}` : ''}`;
}

function terminalOptions(terminals: FeishuListTerminal[], showActivity = false): Array<{ text: { tag: 'plain_text'; content: string }; value: string }> {
  return terminals.map((terminal) => ({
    text: { tag: 'plain_text', content: `${showActivity ? `${terminalActivityText(terminal)} · ` : ''}${terminal.label} · ${terminal.workspace}${terminal.supervisionState === 'paused' ? '（已暂停）' : terminal.supervised ? '（监督中）' : terminal.restartable ? '（已停止，可重新监督）' : ''}`.slice(0, 100) },
    value: terminal.surfaceId,
  }));
}

let controlActionSequence = 0;

export const FEISHU_CONTROL_CARD_VERSION = '3';

function nextControlActionNonce(): string {
  controlActionSequence = (controlActionSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${controlActionSequence.toString(36)}`;
}

function cardButton(value: Record<string, string>, text: string, type: 'primary' | 'default' | 'danger' = 'default'): object {
  return {
    tag: 'button', text: { tag: 'plain_text', content: text }, type,
    value: { ...value, wmux_card_version: FEISHU_CONTROL_CARD_VERSION, nonce: nextControlActionNonce() },
  };
}

function formButton(
  name: string,
  text: string,
  type: 'primary' | 'default' | 'danger' = 'default',
  value?: Record<string, string>,
): object {
  return {
    tag: 'button', element_id: name, name,
    text: { tag: 'plain_text', content: text }, type, action_type: 'form_submit',
    ...(value ? { value: {
      ...value,
      ...(value.wmux_action === 'decide' ? {} : { wmux_card_version: FEISHU_CONTROL_CARD_VERSION }),
      nonce: nextControlActionNonce(),
    } } : {}),
  };
}

function buildFormCard(
  title: string,
  template: 'blue' | 'orange',
  description: string,
  formName: string,
  formElements: object[],
  footerElements: object[] = [],
): object {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: title }, template },
    body: {
      elements: [
        { tag: 'markdown', content: description },
        { tag: 'form', name: formName, elements: formElements },
        ...footerElements,
      ],
    },
  };
}

function controlHomeFooter(): object[] {
  return [{
    tag: 'column_set', flex_mode: 'none', columns: [{
      tag: 'column', width: 'auto',
      elements: [cardButton({ wmux_action: 'menu', flow: 'status' }, '返回控制首页')],
    }],
  }];
}

export function buildSupervisorResultCard(title: string, content: string, success: boolean): object {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: title }, template: success ? 'green' : 'grey' },
    body: { elements: [{ tag: 'markdown', content }] },
  };
}

interface ResolvedCardAction {
  wmux_action?: string;
  approval_id?: string;
  decision?: string;
  flow?: string;
  terminal?: string;
  nonce?: string;
  wmux_card_version?: string;
  confirmation_id?: string;
}

interface ControlNotice {
  text: string;
  success: boolean;
}

interface PendingBusyTaskConfirmation {
  messageId: string;
  chatId: string;
  terminal: FeishuListTerminal;
  task: string;
  expiresAt: number;
}

function isReusableControlAction(value: ResolvedCardAction): boolean {
  if (value.wmux_action === 'stop_lane_confirm') return true;
  return value.wmux_action === 'menu'
    && ['create-task', 'start', 'send', 'manage', 'status', 'stop-confirm'].includes(value.flow || '');
}

export function resolveFeishuCardAction(value: unknown, name?: string): ResolvedCardAction {
  const rawValue = isObject(value) ? value : {};
  if (name === 'wmux_form_create_task') return { ...rawValue, wmux_action: 'form_create_task' };
  if (name === 'wmux_form_start') return { ...rawValue, wmux_action: 'form_start' };
  if (name === 'wmux_form_send') return { ...rawValue, wmux_action: 'form_send' };
  if (name === 'wmux_form_lane_control') return { ...rawValue, wmux_action: 'form_lane_control' };
  const decision = /^wmux_decide_(approve|reject|pause|stop)$/.exec(name || '')?.[1];
  return decision ? { ...rawValue, wmux_action: 'decide', decision } : rawValue;
}

export function parseFeishuCardFormValues(raw: unknown): Record<string, string> {
  if (!isObject(raw)) return {};
  const rawAction = isObject(raw.action)
    ? raw.action
    : isObject(raw.event) && isObject(raw.event.action)
      ? raw.event.action
      : null;
  if (!rawAction || !isObject(rawAction.form_value)) return {};
  return Object.fromEntries(Object.entries(rawAction.form_value).flatMap(([name, value]) => {
    const selected = Array.isArray(value) ? value[0] : value;
    return typeof selected === 'string' ? [[name, selected.trim().slice(0, MAX_COMMAND_VALUE_LENGTH)]] : [];
  }));
}

/** The direct-chat entrypoint for all routine operations. */
export function buildSupervisorControlMenuCard(state?: FeishuControlState, notice?: ControlNotice): object {
  const sessionRunning = state?.active || state?.paused;
  const sessionStatus = state?.active ? '进行中' : state?.paused ? '已暂停（上下文已保留）' : '未启动';
  const summaryText = state
    ? `**监督状态：${sessionStatus}**\n监督通道 ${state.supervisedTerminals} 个 · 可添加终端 ${state.availableTerminals} 个 · 待审批 ${state.pendingApprovals} 项`
    : '**监督状态：读取中**\n点击刷新状态获取最新信息。';
  const operations = [
    cardButton({ wmux_action: 'menu', flow: 'create-task' }, '添加终端任务', 'primary'),
    ...(state?.paused
      ? [cardButton({ wmux_action: 'menu', flow: 'resume-all' }, '继续全部监督', 'primary')]
      : []),
    ...(state?.availableTerminals !== 0
      ? [cardButton({ wmux_action: 'menu', flow: 'start' }, sessionRunning ? '添加监督终端' : '启动监督', 'primary')]
      : []),
    ...(state?.totalTerminals !== 0
      ? [cardButton({ wmux_action: 'menu', flow: 'send' }, '发送任务')]
      : []),
    ...(sessionRunning || (state?.supervisedTerminals || 0) > 0
      ? [cardButton({ wmux_action: 'menu', flow: 'manage' }, '管理监督')]
      : []),
    cardButton({ wmux_action: 'menu', flow: 'status' }, '刷新状态'),
  ];
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'wmux · 任务与监督控制' }, template: 'blue' },
    body: {
      elements: [
        ...(notice ? [{
          tag: 'markdown',
          content: `${notice.success ? '✅' : '⚠️'} **${notice.success ? '操作成功' : '操作未完成'}**：${notice.text}`,
        }] : []),
        { tag: 'markdown', content: summaryText },
        {
          tag: 'column_set', flex_mode: 'none', columns: operations.map((button) => ({
            tag: 'column', width: 'auto', elements: [button],
          })),
        },
        {
          tag: 'div',
          text: {
            tag: 'plain_text',
            content: '可创建 Codex 直连终端、发送任务或添加 AI 监督；人工决策仍会私发给白名单用户。',
            text_size: 'notation',
            text_color: 'grey',
          },
        },
      ],
    },
  };
}

/** Form displayed after selecting “添加终端任务”. */
export function buildDirectTerminalTaskCard(): object {
  return buildFormCard(
    'wmux · 添加 Codex 终端任务',
    'blue',
    '将在桌面“wmux任务”目录中新建独立任务文件夹，打开一个 Codex 直连终端，并在终端就绪后自动发送首条任务。该终端默认不受监督，可稍后添加监督。',
    'wmux_create_task_form',
    [
      { tag: 'input', element_id: 'create_task_name', name: 'task_name', required: true, max_length: 100, label: { tag: 'plain_text', content: '任务名称' }, placeholder: { tag: 'plain_text', content: '例如：修复登录页问题' } },
      { tag: 'input', element_id: 'create_task_content', name: 'task', required: true, input_type: 'multiline_text', rows: 6, max_length: 1000, label: { tag: 'plain_text', content: '首条任务' }, placeholder: { tag: 'plain_text', content: '填写要直接发送给 Codex 的完整任务' } },
      formButton('wmux_form_create_task', '创建并发送', 'primary', { wmux_action: 'form_create_task' }),
    ],
    controlHomeFooter(),
  );
}

/** Form displayed after selecting “启动监督”; launcher/model options intentionally use existing wmux defaults. */
export function buildSupervisorStartCard(terminals: FeishuListTerminal[], adding = false): object {
  const candidates = terminals.filter(isStartableSupervisorTerminal);
  return buildFormCard(
    adding ? 'wmux · 添加 AI 监督终端' : 'wmux · 启动 AI 监督',
    'blue',
    adding
      ? '选择尚未监督的工作终端，为当前会话增加一条独立监督通道。现有监督与会话上下文不受影响。'
      : '选择一个已有工作终端，填写可核对的停止条件。不会创建终端，也不会向工作终端发送新任务。',
    'wmux_start_form',
    [
      { tag: 'markdown', content: '**工作终端**' },
      { tag: 'select_static', element_id: 'start_terminal', name: 'terminal', required: true, placeholder: { tag: 'plain_text', content: '选择要监督的终端' }, options: terminalOptions(candidates) },
      { tag: 'input', element_id: 'start_goal', name: 'task_goal', input_type: 'multiline_text', rows: 2, max_length: 1000, label: { tag: 'plain_text', content: '任务目标（可选）' }, placeholder: { tag: 'plain_text', content: '监督 AI 需要围绕什么目标观察和推进' } },
      { tag: 'input', element_id: 'start_stop', name: 'stop_when', required: true, input_type: 'multiline_text', rows: 2, max_length: 1000, label: { tag: 'plain_text', content: '停止条件' }, placeholder: { tag: 'plain_text', content: '例如：测试通过且计划验收项完成' } },
      { tag: 'markdown', content: '**停止条件类型**' },
      { tag: 'select_static', element_id: 'start_kind', name: 'stop_when_kind', placeholder: { tag: 'plain_text', content: '未选择时按具体可验证条件处理' }, options: [
        { text: { tag: 'plain_text', content: '具体可验证条件（推荐）' }, value: 'concrete' },
        { text: { tag: 'plain_text', content: '目标方向' }, value: 'direction' },
      ] },
      { tag: 'input', element_id: 'start_desc', name: 'task_description', input_type: 'multiline_text', rows: 2, max_length: 1000, label: { tag: 'plain_text', content: '停止条件补充说明（可选）' }, placeholder: { tag: 'plain_text', content: '帮助监督 AI 理解何时适合结束' } },
      { tag: 'input', element_id: 'start_pre', name: 'preconditions', input_type: 'multiline_text', rows: 2, max_length: 1000, label: { tag: 'plain_text', content: '已确认前置条件（可选）' }, placeholder: { tag: 'plain_text', content: '例如：测试环境已准备好' } },
      { tag: 'input', element_id: 'start_plan', name: 'plan_file', max_length: 1000, label: { tag: 'plain_text', content: '计划文件绝对路径（可选）' }, placeholder: { tag: 'plain_text', content: '例如：E:\\work\\project\\PLAN.md' } },
      { tag: 'markdown', content: '**全自动监督**' },
      { tag: 'select_static', element_id: 'start_auto', name: 'autonomous', placeholder: { tag: 'plain_text', content: '未选择时关闭' }, options: [
        { text: { tag: 'plain_text', content: '关闭（推荐）' }, value: 'off' },
        { text: { tag: 'plain_text', content: '开启（仍禁止高风险操作）' }, value: 'on' },
      ] },
      formButton('wmux_form_start', adding ? '添加监督终端' : '启动监督', 'primary', { wmux_action: 'form_start' }),
    ],
    controlHomeFooter(),
  );
}

/** Form displayed after selecting “发送任务”. */
export function buildSupervisorSendTaskCard(terminals: FeishuListTerminal[]): object {
  return buildFormCard(
    'wmux · 向终端发送任务',
    'blue',
    '选择已有工作终端并填写任务。终端状态在打开卡片时刷新；“执行中”需再次确认后才会发送。',
    'wmux_send_form',
    [
      { tag: 'markdown', content: '**目标终端**' },
      { tag: 'select_static', element_id: 'send_terminal', name: 'terminal', required: true, placeholder: { tag: 'plain_text', content: '选择终端' }, options: terminalOptions(terminals, true) },
      { tag: 'input', element_id: 'send_task', name: 'task', required: true, input_type: 'multiline_text', rows: 5, max_length: 1000, label: { tag: 'plain_text', content: '任务内容' }, placeholder: { tag: 'plain_text', content: '填写要发送给终端的完整任务' } },
      formButton('wmux_form_send', '发送任务', 'primary', { wmux_action: 'form_send' }),
    ],
    controlHomeFooter(),
  );
}

export function buildBusyTaskConfirmationCard(
  terminal: Pick<FeishuListTerminal, 'surfaceId' | 'label' | 'workspace' | 'activityState' | 'activityUpdatedAt'>,
  confirmationId: string,
  notice?: string,
): object {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: '确认向忙碌终端发送任务' }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown', content: `**${terminal.label}** · ${terminal.workspace}\n任务状态：**${terminalActivityText(terminal as FeishuListTerminal)}**\n\n该终端仍在执行任务。继续发送可能打断当前工作或进入终端输入队列。` },
        ...(notice ? [{ tag: 'markdown', content: `**上次发送未完成：** ${notice}` }] : []),
        {
          tag: 'column_set', flex_mode: 'none', columns: [
            { tag: 'column', width: 'auto', elements: [cardButton({
              wmux_action: 'confirm_busy_send', terminal: terminal.surfaceId, confirmation_id: confirmationId,
            }, '仍然发送', 'danger')] },
            { tag: 'column', width: 'auto', elements: [cardButton({ wmux_action: 'menu', flow: 'send' }, '取消并返回')] },
          ],
        },
      ],
    },
  };
}

/** Form displayed after selecting “控制单个监督”. */
export function buildSupervisorLaneControlCard(terminals: FeishuListTerminal[]): object {
  return buildFormCard(
    'wmux · 控制单个 AI 监督',
    'orange',
    '选择监督终端和操作。暂停会保留该 AI 的上下文，停止只结束该通道，其他监督不受影响。',
    'wmux_lane_control_form',
    [
      { tag: 'markdown', content: '**AI 监督终端**' },
      { tag: 'select_static', element_id: 'lane_terminal', name: 'terminal', required: true, placeholder: { tag: 'plain_text', content: '选择要控制的监督' }, options: terminalOptions(terminals) },
      { tag: 'markdown', content: '**操作**' },
      { tag: 'select_static', element_id: 'lane_action', name: 'lane_action', required: true, placeholder: { tag: 'plain_text', content: '选择操作' }, options: [
        { text: { tag: 'plain_text', content: '暂停（保留上下文）' }, value: 'pause-lane' },
        { text: { tag: 'plain_text', content: '继续' }, value: 'resume-lane' },
        { text: { tag: 'plain_text', content: '停止此监督' }, value: 'stop-lane' },
      ] },
      formButton('wmux_form_lane_control', '执行单通道控制', 'primary', { wmux_action: 'form_lane_control' }),
    ],
  );
}

export function buildSupervisorManagementCard(
  terminals: FeishuListTerminal[],
  state: Pick<FeishuControlState, 'active' | 'paused'>,
): object {
  const sessionStatus = state.active ? '进行中' : state.paused ? '已暂停（上下文已保留）' : '未启动';
  const laneControls = terminals.length > 0
    ? terminals.flatMap((terminal) => {
        const lanePaused = terminal.supervisionState === 'paused';
        const laneStatus = lanePaused
          ? '单通道已暂停'
          : state.paused ? '随会话暂停（继续全部后恢复）' : '监督中';
        return [
          { tag: 'markdown', content: `**${terminal.label}** · ${laneStatus}\n任务终端：**${terminalActivityText(terminal)}**` },
          {
            tag: 'column_set', flex_mode: 'none', columns: [
              ...(!state.paused ? [{ tag: 'column', width: 'auto', elements: [cardButton({
                wmux_action: 'lane_control', flow: lanePaused ? 'resume-lane' : 'pause-lane', terminal: terminal.surfaceId,
              }, lanePaused ? '继续此监督' : '暂停此监督', 'primary')] }] : []),
              { tag: 'column', width: 'auto', elements: [cardButton({
                wmux_action: 'stop_lane_confirm', flow: 'stop-lane', terminal: terminal.surfaceId,
              }, '停止此监督', 'danger')] },
            ],
          },
        ];
      })
    : [{ tag: 'markdown', content: '当前没有可管理的监督通道。' }];
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: 'wmux · 管理 AI 监督' }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown', content: `**会话状态：${sessionStatus}**\n${state.paused ? '当前所有监督均已暂停；点击“继续全部”恢复会话。' : '在这里管理全部监督或单个监督通道。'}` },
        {
          tag: 'column_set', flex_mode: 'none', columns: [
            ...(state.active || state.paused ? [{ tag: 'column', width: 'auto', elements: [cardButton({
              wmux_action: 'menu', flow: state.paused ? 'resume-all' : 'pause-all',
            }, state.paused ? '继续全部' : '暂停全部', 'primary')] }] : []),
            ...(state.active || state.paused ? [{ tag: 'column', width: 'auto', elements: [cardButton({ wmux_action: 'menu', flow: 'stop-confirm' }, '停止全部', 'danger')] }] : []),
            { tag: 'column', width: 'auto', elements: [cardButton({ wmux_action: 'menu', flow: 'status' }, '返回控制首页')] },
          ],
        },
        { tag: 'hr' },
        { tag: 'markdown', content: '**管理单个监督通道**' },
        ...laneControls,
      ],
    },
  };
}

export function buildSupervisorStopConfirmationCard(terminal?: { surfaceId: string; label: string }): object {
  const isLane = !!terminal;
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: isLane ? '确认停止此监督' : '确认停止全部监督' }, template: 'red' },
    body: {
      elements: [
        { tag: 'markdown', content: isLane
          ? `将停止 **${terminal.label}** 的监督通道。其他监督不受影响；该通道需重新添加才能再次监督。`
          : '将停止当前会话的全部监督通道。停止后不能直接继续，需要重新启动监督。' },
        {
          tag: 'column_set', flex_mode: 'none', columns: [
            { tag: 'column', width: 'auto', elements: [cardButton(
              isLane
                ? { wmux_action: 'confirm_stop_lane', terminal: terminal.surfaceId }
                : { wmux_action: 'menu', flow: 'stop' },
              isLane ? '确认停止此监督' : '确认停止全部',
              'danger',
            )] },
            { tag: 'column', width: 'auto', elements: [cardButton({ wmux_action: 'menu', flow: 'manage' }, '取消')] },
          ],
        },
      ],
    },
  };
}

function controlStateFromList(list: FeishuListResult): FeishuControlState {
  return {
    active: list.active,
    paused: list.paused,
    totalTerminals: list.terminals.length,
    availableTerminals: list.terminals.filter(isStartableSupervisorTerminal).length,
    supervisedTerminals: list.terminals.filter((terminal) => terminal.supervisionState === 'active' || terminal.supervisionState === 'paused').length,
    pendingApprovals: list.pendingApprovals.length,
  };
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
        restartable: terminal.restartable === true,
        supervisionState: ['active', 'paused', 'stopped', 'none'].includes(String(terminal.supervisionState))
          ? terminal.supervisionState as FeishuListTerminal['supervisionState']
          : undefined,
        managementSessionId: typeof terminal.managementSessionId === 'string' ? terminal.managementSessionId : undefined,
        autonomous: typeof terminal.autonomous === 'boolean' ? terminal.autonomous : undefined,
        autonomyPermissionCount: typeof terminal.autonomyPermissionCount === 'number' ? terminal.autonomyPermissionCount : undefined,
        forbiddenActionCount: typeof terminal.forbiddenActionCount === 'number' ? terminal.forbiddenActionCount : undefined,
        policyOverridden: terminal.policyOverridden === true,
        activityState: ['idle', 'working', 'blocked', 'unknown'].includes(String(terminal.activityState))
          ? terminal.activityState as FeishuListTerminal['activityState']
          : 'unknown',
        activityUpdatedAt: typeof terminal.activityUpdatedAt === 'number' && Number.isFinite(terminal.activityUpdatedAt)
          ? terminal.activityUpdatedAt
          : undefined,
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
    return { active: parsed.active === true, paused: parsed.paused === true, terminals, session, pendingApprovals };
  } catch {
    return null;
  }
}

function busyTerminalFromResult(value: unknown): FeishuListTerminal | null {
  if (!isObject(value) || value.code !== 'terminal_busy' || !isObject(value.terminal)) return null;
  const terminal = value.terminal;
  if (typeof terminal.surfaceId !== 'string') return null;
  return {
    surfaceId: terminal.surfaceId,
    label: asText(terminal.label),
    workspace: asText(terminal.workspace),
    supervised: false,
    activityState: terminal.activityState === 'working' ? 'working' : 'unknown',
    activityUpdatedAt: typeof terminal.activityUpdatedAt === 'number' && Number.isFinite(terminal.activityUpdatedAt)
      ? terminal.activityUpdatedAt
      : undefined,
  };
}

/** Render LIST as readable text while retaining IDs needed by START. */
export function formatFeishuSupervisorResponse(command: FeishuSupervisorCommand, value: unknown): string {
  if (command.action !== 'list') return summary(value);
  const result = parseListResult(value);
  if (!result) return summary(value);

  let sessionStatus = '未启动';
  if (result.active) sessionStatus = '进行中';
  else if (result.paused) sessionStatus = '已暂停（会话已保留）';
  const startableTerminalCount = result.terminals.filter(isStartableSupervisorTerminal).length;
  const lines = [
    'wmux · AI 监督状态',
    `监督会话：${sessionStatus}`,
    `可监督终端：${startableTerminalCount} 个`,
  ];
  if (result.session) {
    lines.push(`会话 ID：${result.session.sessionId}`);
    lines.push(`监督模式：${result.session.autonomous ? '全自动（高风险仍需人工）' : '有限自主（低风险权限与小范围调整自动处理）'}`);
    lines.push(`停止条件：${result.session.stopWhen}`);
  }
  lines.push('', '终端列表：');
  if (result.terminals.length === 0) lines.push('暂无可监督终端。');
  for (const [index, terminal] of result.terminals.entries()) {
    let terminalStatus = '未监督';
    if (terminal.supervisionState === 'active') terminalStatus = result.paused ? '全局暂停（通道保留）' : '监督中';
    else if (terminal.supervisionState === 'paused') terminalStatus = '单通道已暂停（上下文已保留）';
    else if (terminal.supervised) terminalStatus = result.paused ? '已暂停（会话已保留）' : '监督中';
    else if (terminal.restartable) terminalStatus = '已停止，可重新监督';
    lines.push(`${index + 1}. ${terminal.label} · ${terminal.workspace}`);
    lines.push(`   状态：${terminalStatus}`);
    lines.push(`   任务终端：${terminalActivityText(terminal)}`);
    lines.push(`   终端 ID：${terminal.surfaceId}`);
    if (terminal.managementSessionId) lines.push(`   管理会话 ID：${terminal.managementSessionId}`);
    if (typeof terminal.autonomous === 'boolean') {
      lines.push(`   权限：${terminal.autonomous ? '全自动' : '有限自主'} · 允许 ${terminal.autonomyPermissionCount ?? 0}/4 · 禁止 ${terminal.forbiddenActionCount ?? 0}${terminal.policyOverridden ? '（终端专用）' : '（会话默认）'}`);
    }
  }
  lines.push('', `待人工审批：${result.pendingApprovals.length ? `${result.pendingApprovals.length} 项` : '无'}`);
  for (const approval of result.pendingApprovals) {
    lines.push(`- ${approval.terminal}：${approval.reason}（${approval.id}）`);
  }
  lines.push('', '提示：发送“帮助”，点击“启动监督”或“发送任务”，即可从下拉列表选择终端。');
  return lines.join('\n');
}

const AUDIT_EVENT_TITLES: Record<string, string> = {
  'session.started': 'AI 监督已启动',
  'session.abandoned': 'AI 监督已重置',
  'worker.task': '工作终端任务更新',
  'worker.lifecycle': '工作终端生命周期',
  'supervisor.delivery.queued': '监督信息待投递',
  'supervisor.delivery.delivered': '监督信息已投递',
  'supervisor.delivery.failed': '监督信息投递失败',
  'supervisor.decision': 'AI 监督裁决',
  'supervisor.permission-approved': 'AI 监督自动授权',
  'supervisor.auto-approved': 'AI 监督自动批准',
  'supervisor.approval.requested': 'AI 监督等待人工决策',
  'supervisor.proposal.resolved': 'AI 监督人工决策已处理',
  'supervisor.auto-decision-limit.resolved': 'AI 监督人工复核完成',
  'supervisor.remote-command': '飞书远程监督命令',
  'supervisor.lane-control': 'AI 监督单通道控制',
  'supervisor.remote-decision': '飞书人工决策',
};

const SENSITIVE_AUDIT_KEY = /(?:secret|token|password|credential|api[_ -]?key)/i;
const LOCAL_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"']+/g;
const INLINE_SECRET = /\b(secret|token|password|api[_ -]?key)\s*[:=]\s*\S+/ig;
const KNOWN_TOKEN = /\b(?:sk-|ghp_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/g;

function auditValue(key: string, value: unknown): string {
  if (SENSITIVE_AUDIT_KEY.test(key)) return '已脱敏';
  if (key === 'cwd' || key === 'projectDir' || key === 'planFilePath') return '本地路径已隐藏';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '未提供';
  return text
    .replace(LOCAL_PATH, '本地路径已隐藏')
    .replace(INLINE_SECRET, '$1: 已脱敏')
    .replace(KNOWN_TOKEN, '已脱敏')
    .slice(0, 800);
}

/** Format a durable supervisor event for its redacted Feishu destination. */
export function formatFeishuSupervisorAuditEvent(record: SupervisorRecord): string {
  const title = AUDIT_EVENT_TITLES[record.type] || `AI 监督事件：${record.type}`;
  const details = Object.entries(record.payload || {})
    .map(([key, value]) => `${key}：${auditValue(key, value)}`)
    .slice(0, 12);
  return [title, `终端：${auditValue('terminal', record.terminal.label)}`, ...(details.length > 0 ? ['详情：', ...details] : [])].join('\n');
}

function decisionOptions(alternatives: string): Array<{ text: { tag: 'plain_text'; content: string }; value: string }> {
  const choices = [...new Set(alternatives.match(/方案\s*[A-Za-z0-9一二三四五六七八九十]+/g) || [])]
    .map((choice) => choice.replace(/\s+/g, ' ').trim())
    .slice(0, 6);
  return choices.map((choice) => ({ text: { tag: 'plain_text', content: `选择${choice}` }, value: choice }));
}

/** JSON 2.0 is required for form inputs; legacy cards silently drop these controls. */
export function buildApprovalCard(record: SupervisorRecord): object {
  const payload = record.payload || {};
  const reason = String(payload.reason || '需要人工决策').slice(0, 800);
  const impact = String(payload.impact || '未提供').slice(0, 500);
  const alternatives = String(payload.alternatives || '未提供').slice(0, 500);
  const choices = decisionOptions(alternatives);
  const formElements: object[] = [
    ...(choices.length > 0 ? [{
      tag: 'markdown', content: '**建议方案（可选）**',
    }, {
      tag: 'select_static', element_id: 'decision_choice', name: 'decision_choice',
      placeholder: { tag: 'plain_text', content: '选择建议方案' }, options: choices,
    }] : []),
    {
      tag: 'input', element_id: 'decision_task', name: 'follow_up_task', required: false,
      input_type: 'multiline_text', rows: 4, max_length: 1000,
      label: { tag: 'plain_text', content: '补充说明（调整时必填，批准时可选）' },
      placeholder: { tag: 'plain_text', content: '批准时可留空；需要调整时填写交给 AI 监督的具体意见' },
    },
    { tag: 'markdown', content: '**处理当前决策**' },
    {
      tag: 'column_set', flex_mode: 'none', columns: [
        { tag: 'column', width: 'auto', elements: [formButton('wmux_decide_approve', '批准并继续', 'primary', { wmux_action: 'decide', approval_id: String(payload.approvalId || ''), decision: 'approve' })] },
        { tag: 'column', width: 'auto', elements: [formButton('wmux_decide_reject', '按补充说明调整', 'default', { wmux_action: 'decide', approval_id: String(payload.approvalId || ''), decision: 'reject' })] },
      ],
    },
    { tag: 'markdown', content: '**监督控制**' },
    {
      tag: 'column_set', flex_mode: 'none', columns: [
        { tag: 'column', width: 'auto', elements: [formButton('wmux_decide_pause', '暂停此监督', 'default', { wmux_action: 'decide', approval_id: String(payload.approvalId || ''), decision: 'pause' })] },
        { tag: 'column', width: 'auto', elements: [formButton('wmux_decide_stop', '停止此监督', 'danger', { wmux_action: 'decide', approval_id: String(payload.approvalId || ''), decision: 'stop' })] },
      ],
    },
  ];
  return buildFormCard(
    'wmux AI 监督：待人工决策',
    'orange',
    `**终端**：${record.terminal.label}\n**原因**：${reason}\n**影响**：${impact}\n**备选**：${alternatives}`,
    'wmux_decision_form',
    formElements,
  );
}

export class FeishuSupervisorService {
  private readonly config = envConfig();
  private channel: Lark.LarkChannel | null = null;
  private readonly seen = new Set<string>();
  private readonly approvalCards = new Map<string, ApprovalCard>();
  /** Only cards sent to a control chat may open routine control forms. */
  private readonly controlCards = new Map<string, string>();
  private readonly busyTaskConfirmations = new Map<string, PendingBusyTaskConfirmation>();
  /** Configured decision DM, falling back to the most recent allowlisted DM. */
  private decisionChatId: string | undefined = this.config?.decisionChatId;
  private readonly pendingDecisionMessages: PendingDecisionMessage[] = [];
  private decisionQueue: Promise<void> = Promise.resolve();
  private auditQueue: Promise<void> = Promise.resolve();

  constructor(private readonly control: FeishuSupervisorControl) {}

  start(): void {
    if (!this.config || this.channel) return;
    this.channel = Lark.createLarkChannel({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      transport: 'websocket',
      policy: {
        // The audit group is output-only by default. An optional, separate
        // control group prevents commands and their replies from polluting it.
        groupAllowlist: this.config.controlChatId ? [this.config.controlChatId] : [],
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
    if (record.type === 'supervisor.approval.requested') {
      const operation = record.payload?.approvalId
        ? () => this.sendApproval(record)
        : () => this.sendDecisionText(formatFeishuSupervisorAuditEvent(record));
      void this.enqueueDecisionOperation(operation);
      return;
    }
    if (record.type === 'supervisor.proposal.resolved') {
      const operation = record.payload?.approvalId
        ? () => this.resolveApproval(record)
        : () => this.sendDecisionText(formatFeishuSupervisorAuditEvent(record));
      void this.enqueueDecisionOperation(operation);
      return;
    }
    if (record.type === 'supervisor.remote-decision') {
      // The text command or card action already replies in the same allowlisted DM.
      return;
    }
    if (record.type === 'supervisor.auto-decision-limit.resolved') {
      void this.enqueueDecisionOperation(() => this.sendDecisionText(formatFeishuSupervisorAuditEvent(record)));
      return;
    }
    this.enqueueAuditText(formatFeishuSupervisorAuditEvent(record));
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
    if (!allowed) return;
    if (chatType === 'p2p') {
      this.decisionChatId = chatId;
      await this.enqueueDecisionOperation(() => this.flushPendingDecisionMessages());
    }
    if (this.seen.has(messageId)) return;
    this.remember(messageId);
    if (isFeishuSupervisorHelp(content)) {
      await this.sendCurrentControlMenu(chatId, openId, 'text');
      return;
    }
    const command = parseFeishuSupervisorCommand(content);
    if ('error' in command) {
      console.info('[feishu] supervisor command rejected: invalid format');
      return void this.sendText(command.error, chatId);
    }
    if (command.action === 'decide' && chatType !== 'p2p') {
      await this.sendText('人工决策仅支持白名单用户单聊。', chatId);
      return;
    }
    console.info(`[feishu] supervisor command accepted: ${command.action}`);
    const result = await this.control(command, { openId, source: 'text' }).catch((err) => ({ error: String(err?.message || err) }));
    await this.sendText(formatFeishuSupervisorResponse(command, result), chatId);
  }

  private async handleCardAction(event: Lark.CardActionEvent): Promise<void> {
    if (!this.config?.allowedOpenIds.has(event.operator.openId)) return;
    const value = resolveFeishuCardAction(event.action.value, event.action.name);
    if (value?.wmux_action === 'menu' || value?.wmux_action === 'form_create_task' || value?.wmux_action === 'form_start' || value?.wmux_action === 'form_send' || value?.wmux_action === 'form_lane_control' || value?.wmux_action === 'lane_control' || value?.wmux_action === 'stop_lane_confirm' || value?.wmux_action === 'confirm_stop_lane' || value?.wmux_action === 'confirm_busy_send') {
      if (value.wmux_card_version !== FEISHU_CONTROL_CARD_VERSION) {
        console.info(`[feishu] obsolete control card ignored: version=${value.wmux_card_version || 'missing'}`);
        return;
      }
      if (this.controlCards.get(event.messageId) !== event.chatId) return;
      const startedAt = Date.now();
      const dedupeKey = `${event.messageId}:${value.wmux_action}:${value.flow || ''}:${value.terminal || ''}:${value.nonce || ''}`;
      if (this.seen.has(dedupeKey)) return;
      this.remember(dedupeKey);
      let accepted = false;
      try {
        accepted = await this.handleControlCardAction(event, value);
      } finally {
        // Navigation buttons remain reusable after completion, while the key
        // stays present during execution to suppress rapid duplicate clicks.
        if (!accepted || isReusableControlAction(value)) this.seen.delete(dedupeKey);
        console.info(`[feishu] control action completed: action=${value.wmux_action}, flow=${value.flow || '-'}, elapsedMs=${Date.now() - startedAt}`);
      }
      return;
    }
    if (value.wmux_action === 'decide' && !value.approval_id) value.approval_id = this.approvalIdForMessage(event.messageId);
    const card = value?.approval_id ? this.approvalCards.get(value.approval_id) : undefined;
    if (
      value?.wmux_action !== 'decide'
      || !value.approval_id
      || !['approve', 'reject', 'pause', 'stop'].includes(value.decision || '')
      || !isFeishuApprovalCardContext(card, event.messageId, event.chatId)
    ) return;
    this.decisionChatId = event.chatId;
    const dedupeKey = `${event.messageId}:${value.decision}`;
    if (this.seen.has(dedupeKey)) return;
    this.remember(dedupeKey);
    const result = await this.control({
      action: 'decide', approvalId: value.approval_id, decision: value.decision as 'approve' | 'reject' | 'pause' | 'stop', task: this.cardFollowUpTask(event),
    }, { openId: event.operator.openId, source: 'card' }).catch((err) => ({ error: String(err?.message || err) }));
    const failed = !!(result && typeof result === 'object' && (result as { error?: string }).error);
    if (failed) {
      // A missing/invalid follow-up task is correctable in the same card.
      // Do not let the click dedupe prevent the user from submitting again.
      this.seen.delete(dedupeKey);
      await this.sendText(`人工决策未执行：${summary(result)}`, event.chatId);
      return;
    }
    if (value.decision === 'pause') {
      await this.sendText(summary(result), event.chatId);
      return;
    }
    if (card && this.channel) {
      await this.channel.updateCard(card.messageId, buildSupervisorResultCard(
        'wmux AI 监督：人工决策已处理',
        `${value.decision}：${summary(result)}`,
        true,
      )).catch(() => undefined);
    }
  }

  private async handleControlCardAction(
    event: Lark.CardActionEvent,
    value: { wmux_action?: string; flow?: string; terminal?: string; nonce?: string; wmux_card_version?: string; confirmation_id?: string },
  ): Promise<boolean> {
    if (value.wmux_action === 'menu') {
      this.clearBusyTaskConfirmationsForMessage(event.messageId);
      await this.handleControlMenu(event, value.flow || '');
      return true;
    }
    if (value.wmux_action === 'confirm_busy_send') {
      return this.confirmBusyTaskSend(event, value.confirmation_id || '', value.terminal || '');
    }
    if (value.wmux_action === 'stop_lane_confirm') {
      return this.sendLaneStopConfirmation(event, value.terminal || '');
    }
    if (value.wmux_action === 'lane_control') {
      if (!value.terminal || !['pause-lane', 'resume-lane'].includes(value.flow || '')) {
        await this.sendText('缺少有效的监督终端或操作，请刷新管理页后重试。', event.chatId);
        return false;
      }
      const result = await this.control({ action: value.flow, terminal: value.terminal } as FeishuSupervisorCommand, {
        openId: event.operator.openId,
        source: 'card',
      }).catch((err) => ({ error: String(err?.message || err) }));
      await this.replaceWithCurrentControlMenu(event, {
        text: summary(result), success: !failedResult(result),
      });
      return !failedResult(result);
    }
    const form = this.cardFormValues(event);
    if (value.wmux_action === 'form_create_task') {
      const name = form.task_name || '';
      const task = form.task || '';
      if (!name || !task) {
        await this.sendText('请填写任务名称和首条任务。', event.chatId);
        return false;
      }
      const result = await this.control({ action: 'create-task', name, task }, {
        openId: event.operator.openId,
        source: 'card',
      }).catch((err) => ({ error: String(err?.message || err) }));
      await this.replaceWithCurrentControlMenu(event, {
        text: summary(result), success: !failedResult(result),
      });
      return !failedResult(result);
    }
    if (value.wmux_action === 'form_start') {
      const terminal = form.terminal || '';
      const stopWhen = form.stop_when || '';
      if (!terminal || !stopWhen) {
        await this.sendText('请先选择工作终端并填写停止条件。', event.chatId);
        return false;
      }
      const result = await this.control({
        action: 'start', terminals: [terminal], stopWhen,
        stopWhenKind: form.stop_when_kind === 'direction' ? 'direction' : 'concrete',
        taskGoal: form.task_goal || undefined,
        taskDescription: form.task_description || undefined,
        preconditions: form.preconditions || undefined,
        planFile: form.plan_file || undefined,
        autonomous: form.autonomous === 'on',
      }, { openId: event.operator.openId, source: 'card' }).catch((err) => ({ error: String(err?.message || err) }));
      await this.replaceWithCurrentControlMenu(event, {
        text: summary(result), success: !failedResult(result),
      });
      return !failedResult(result);
    }
    if (value.wmux_action === 'form_send') {
      const terminal = form.terminal || '';
      const task = form.task || '';
      if (!terminal || !task) {
        await this.sendText('请先选择目标终端并填写任务内容。', event.chatId);
        return false;
      }
      const result = await this.control({ action: 'send', terminal, task }, { openId: event.operator.openId, source: 'card' })
        .catch((err) => ({ error: String(err?.message || err) }));
      const busyTerminal = busyTerminalFromResult(result);
      if (busyTerminal) {
        const confirmationId = nextControlActionNonce();
        this.clearBusyTaskConfirmationsForMessage(event.messageId);
        const pendingConfirmation: PendingBusyTaskConfirmation = {
          messageId: event.messageId,
          chatId: event.chatId,
          terminal: busyTerminal,
          task,
          expiresAt: Date.now() + 5 * 60 * 1000,
        };
        this.busyTaskConfirmations.set(confirmationId, pendingConfirmation);
        const expiryTimer = setTimeout(() => {
          if (this.busyTaskConfirmations.get(confirmationId) === pendingConfirmation) {
            this.busyTaskConfirmations.delete(confirmationId);
          }
        }, 5 * 60 * 1000);
        expiryTimer.unref?.();
        if (this.busyTaskConfirmations.size > 50) {
          this.busyTaskConfirmations.delete(this.busyTaskConfirmations.keys().next().value as string);
        }
        const confirmationMessageId = await this.replaceControlCard(
          event,
          buildBusyTaskConfirmationCard(busyTerminal, confirmationId),
        );
        if (!confirmationMessageId) {
          this.busyTaskConfirmations.delete(confirmationId);
          return false;
        }
        pendingConfirmation.messageId = confirmationMessageId;
        return true;
      }
      await this.replaceWithCurrentControlMenu(event, {
        text: summary(result), success: !failedResult(result),
      });
      return !failedResult(result);
    }
    if (value.wmux_action === 'form_lane_control') {
      const terminal = form.terminal || '';
      const action = form.lane_action || '';
      if (!terminal || !['pause-lane', 'resume-lane', 'stop-lane'].includes(action)) {
        await this.sendText('请先选择 AI 监督终端和有效操作。', event.chatId);
        return false;
      }
      if (action === 'stop-lane') {
        return this.sendLaneStopConfirmation(event, terminal);
      }
      const result = await this.control({ action, terminal } as FeishuSupervisorCommand, {
        openId: event.operator.openId,
        source: 'card',
      }).catch((err) => ({ error: String(err?.message || err) }));
      await this.replaceWithCurrentControlMenu(event, {
        text: summary(result), success: !failedResult(result),
      });
      return !failedResult(result);
    }
    if (value.wmux_action === 'confirm_stop_lane') {
      if (!value.terminal) {
        await this.sendText('缺少要停止的监督终端，请返回管理页重试。', event.chatId);
        return false;
      }
      const result = await this.control({ action: 'stop-lane', terminal: value.terminal }, {
        openId: event.operator.openId,
        source: 'card',
      }).catch((err) => ({ error: String(err?.message || err) }));
      await this.replaceWithCurrentControlMenu(event, {
        text: summary(result), success: !failedResult(result),
      });
      return !failedResult(result);
    }
    return false;
  }

  private async confirmBusyTaskSend(
    event: Lark.CardActionEvent,
    confirmationId: string,
    terminalId: string,
  ): Promise<boolean> {
    const pending = this.busyTaskConfirmations.get(confirmationId);
    if (
      !pending
      || pending.messageId !== event.messageId
      || pending.chatId !== event.chatId
      || pending.terminal.surfaceId !== terminalId
      || pending.expiresAt <= Date.now()
    ) {
      if (confirmationId) this.busyTaskConfirmations.delete(confirmationId);
      await this.sendText('本次忙碌终端确认已失效，请重新打开“发送任务”。', event.chatId);
      return false;
    }
    const result = await this.control({
      action: 'send', terminal: pending.terminal.surfaceId, task: pending.task, force: true,
    }, { openId: event.operator.openId, source: 'card' }).catch((err) => ({ error: String(err?.message || err) }));
    if (failedResult(result)) {
      const confirmationMessageId = await this.replaceControlCard(event, buildBusyTaskConfirmationCard(
        pending.terminal,
        confirmationId,
        summary(result),
      ));
      if (!confirmationMessageId) this.busyTaskConfirmations.delete(confirmationId);
      else pending.messageId = confirmationMessageId;
      return false;
    }
    this.busyTaskConfirmations.delete(confirmationId);
    await this.replaceWithCurrentControlMenu(event, { text: summary(result), success: true });
    return true;
  }

  private clearBusyTaskConfirmationsForMessage(messageId: string): void {
    for (const [confirmationId, pending] of this.busyTaskConfirmations) {
      if (pending.messageId === messageId) this.busyTaskConfirmations.delete(confirmationId);
    }
  }

  private async sendLaneStopConfirmation(event: Lark.CardActionEvent, terminal: string): Promise<boolean> {
    const listResult = await this.control({ action: 'list' }, { openId: event.operator.openId, source: 'card' })
      .catch(() => null);
    const terminalInfo = parseListResult(listResult)?.terminals.find((item) => item.surfaceId === terminal);
    if (!terminalInfo || !['active', 'paused'].includes(terminalInfo.supervisionState || '')) {
      await this.replaceWithCurrentControlMenu(event, {
        text: '该监督通道已不存在或不可停止，请刷新状态后重试。', success: false,
      });
      return false;
    }
    await this.replaceControlCard(event, buildSupervisorStopConfirmationCard({
      surfaceId: terminalInfo.surfaceId,
      label: terminalInfo.label,
    }));
    return true;
  }

  private async handleControlMenu(event: Lark.CardActionEvent, flow: string): Promise<void> {
    if (flow === 'create-task') {
      await this.replaceControlCard(event, buildDirectTerminalTaskCard());
      return;
    }
    if (flow === 'pause-all' || flow === 'resume-all') {
      const action = flow;
      const result = await this.control({ action }, { openId: event.operator.openId, source: 'card' })
        .catch((err) => ({ error: String(err?.message || err) }));
      await this.replaceWithCurrentControlMenu(event, {
        text: summary(result), success: !failedResult(result),
      });
      return;
    }
    if (flow === 'stop-confirm') {
      await this.replaceControlCard(event, buildSupervisorStopConfirmationCard());
      return;
    }
    if (flow === 'stop') {
      const result = await this.control({ action: 'stop' }, { openId: event.operator.openId, source: 'card' })
        .catch((err) => ({ error: String(err?.message || err) }));
      await this.replaceWithCurrentControlMenu(event, {
        text: summary(result), success: !failedResult(result),
      });
      return;
    }
    const result = await this.control({ action: 'list' }, { openId: event.operator.openId, source: 'card' })
      .catch((err) => ({ error: String(err?.message || err) }));
    const list = parseListResult(result);
    if (!list) {
      await this.replaceControlCard(event, buildSupervisorControlMenuCard(undefined, {
        text: summary(result), success: false,
      }));
      return;
    }
    if (flow === 'start') {
      const candidates = list.terminals.filter(isStartableSupervisorTerminal);
      if (candidates.length === 0) {
        await this.replaceControlCard(event, buildSupervisorControlMenuCard(controlStateFromList(list), {
          text: '暂无可启动监督的终端。请先在 wmux 中创建工作终端，或先停止当前监督。', success: false,
        }));
        return;
      }
      await this.replaceControlCard(event, buildSupervisorStartCard(candidates, list.active || list.paused));
      return;
    }
    if (flow === 'send') {
      if (list.terminals.length === 0) {
        await this.replaceControlCard(event, buildSupervisorControlMenuCard(controlStateFromList(list), {
          text: '暂无可发送任务的终端。请先在 wmux 中创建工作终端。', success: false,
        }));
        return;
      }
      await this.replaceControlCard(event, buildSupervisorSendTaskCard(list.terminals));
      return;
    }
    if (flow === 'manage') {
      const candidates = list.terminals.filter((terminal) => terminal.supervisionState === 'active' || terminal.supervisionState === 'paused');
      if (candidates.length === 0 && !list.active && !list.paused) {
        await this.replaceControlCard(event, buildSupervisorControlMenuCard(controlStateFromList(list), {
          text: '暂无可单独控制的 AI 监督通道。', success: false,
        }));
        return;
      }
      await this.replaceControlCard(event, buildSupervisorManagementCard(candidates, list));
      return;
    }
    await this.replaceControlCard(event, buildSupervisorControlMenuCard(controlStateFromList(list)));
  }

  private async replaceWithCurrentControlMenu(event: Lark.CardActionEvent, notice: ControlNotice): Promise<void> {
    const result = await this.control({ action: 'list' }, { openId: event.operator.openId, source: 'card' })
      .catch(() => null);
    const list = parseListResult(result);
    await this.replaceControlCard(event, buildSupervisorControlMenuCard(
      list ? controlStateFromList(list) : undefined,
      notice,
    ));
  }

  private async sendCurrentControlMenu(chatId: string, openId: string, source: 'text' | 'card' = 'card'): Promise<void> {
    const result = await this.control({ action: 'list' }, { openId, source })
      .catch(() => null);
    const list = parseListResult(result);
    await this.sendControlCard(buildSupervisorControlMenuCard(list ? controlStateFromList(list) : undefined), chatId);
  }

  private cardFormValues(event: Lark.CardActionEvent): Record<string, string> {
    return parseFeishuCardFormValues(event.raw);
  }

  private cardFollowUpTask(event: Lark.CardActionEvent): string | undefined {
    const form = this.cardFormValues(event);
    const task = form.follow_up_task || '';
    const selected = form.decision_choice ? `用户选择${form.decision_choice}` : '';
    const combined = [selected, task].filter(Boolean).join('\n');
    return combined ? combined.slice(0, MAX_COMMAND_VALUE_LENGTH) : undefined;
  }

  private approvalIdForMessage(messageId: string): string | undefined {
    for (const [approvalId, card] of this.approvalCards) {
      if (card.messageId === messageId) return approvalId;
    }
    return undefined;
  }

  private async sendApproval(record: SupervisorRecord): Promise<void> {
    if (!this.channel) return;
    const approvalId = String(record.payload?.approvalId || '');
    const chatId = this.decisionChatId;
    if (!chatId) {
      this.queuePendingDecision({ kind: 'approval', approvalId, record });
      return;
    }
    try {
      const sent = await this.channel.send(chatId, { card: buildApprovalCard(record) });
      this.approvalCards.set(approvalId, { approvalId, messageId: sent.messageId, chatId });
      if (this.approvalCards.size > 100) this.approvalCards.delete(this.approvalCards.keys().next().value as string);
    } catch (err) {
      console.warn('[feishu] send approval card failed', err);
      this.queuePendingDecision({ kind: 'approval', approvalId, record });
    }
  }

  private async resolveApproval(record: SupervisorRecord): Promise<void> {
    const approvalId = String(record.payload?.approvalId || '');
    this.removePendingApproval(approvalId);
    const updated = await this.updateApproval(approvalId, String(record.payload?.resolution || '已处理'));
    if (!updated) await this.sendDecisionText(formatFeishuSupervisorAuditEvent(record));
  }

  private enqueueDecisionOperation(operation: () => Promise<void>): Promise<void> {
    const next = this.decisionQueue
      .catch(() => undefined)
      .then(operation)
      .catch((err) => console.warn('[feishu] decision delivery failed', err));
    this.decisionQueue = next;
    return next;
  }

  private queuePendingDecision(message: PendingDecisionMessage): void {
    if (message.kind === 'approval') this.removePendingApproval(message.approvalId);
    this.pendingDecisionMessages.push(message);
    if (this.pendingDecisionMessages.length > 100) this.pendingDecisionMessages.shift();
  }

  private removePendingApproval(approvalId: string): void {
    for (let index = this.pendingDecisionMessages.length - 1; index >= 0; index -= 1) {
      const message = this.pendingDecisionMessages[index];
      if (message.kind === 'approval' && message.approvalId === approvalId) {
        this.pendingDecisionMessages.splice(index, 1);
      }
    }
  }

  private async flushPendingDecisionMessages(): Promise<void> {
    if (!this.decisionChatId || this.pendingDecisionMessages.length === 0) return;
    const pending = this.pendingDecisionMessages.splice(0);
    for (const message of pending) {
      if (message.kind === 'approval') await this.sendApproval(message.record);
      else await this.sendDecisionText(message.text);
    }
  }

  private async sendDecisionText(text: string): Promise<void> {
    const chatId = this.decisionChatId;
    if (!this.channel || !chatId) {
      this.queuePendingDecision({ kind: 'text', text });
      return;
    }
    try {
      await this.channel.send(chatId, { text: text.slice(0, 1800) });
    } catch (err) {
      console.warn('[feishu] send decision text failed', err);
      this.queuePendingDecision({ kind: 'text', text });
    }
  }

  private enqueueAuditText(text: string): void {
    this.auditQueue = this.auditQueue
      .catch(() => undefined)
      .then(async () => {
        await this.sendText(text);
        // Keep detailed events ordered and below one group's bot message limit.
        await new Promise<void>((resolve) => setTimeout(resolve, 220));
      });
  }

  private async sendControlCard(card: object, chatId: string): Promise<string | null> {
    if (!this.channel) return null;
    try {
      const sent = await this.channel.send(chatId, { card });
      this.controlCards.set(sent.messageId, chatId);
      if (this.controlCards.size > 100) this.controlCards.delete(this.controlCards.keys().next().value as string);
      return sent.messageId;
    } catch (err) {
      console.warn('[feishu] send control card failed', err);
      await this.sendText('控制卡片发送失败，请稍后发送“帮助”重试。', chatId);
      return null;
    }
  }

  /** Prefer an in-place card refresh; fall back to a new card if Feishu rejects the update. */
  private async replaceControlCard(event: Lark.CardActionEvent, card: object): Promise<string | null> {
    if (!this.channel) return null;
    try {
      await this.channel.updateCard(event.messageId, card);
      this.controlCards.set(event.messageId, event.chatId);
      return event.messageId;
    } catch (err) {
      console.warn('[feishu] update control card failed; sending a replacement', err);
      const replacementMessageId = await this.sendControlCard(card, event.chatId);
      if (replacementMessageId) this.controlCards.delete(event.messageId);
      return replacementMessageId;
    }
  }

  private async updateApproval(approvalId: string, resolution: string): Promise<boolean> {
    const card = this.approvalCards.get(approvalId);
    if (!card || !this.channel) return false;
    try {
      await this.channel.updateCard(card.messageId, buildSupervisorResultCard(
        'wmux AI 监督：人工决策已处理',
        `结果：${resolution}`,
        resolution === 'approved' || resolution === 'handled-manually',
      ));
      return true;
    } catch {
      return false;
    }
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
