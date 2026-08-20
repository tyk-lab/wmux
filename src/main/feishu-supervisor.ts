import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';
import { loadSettings } from './settings-store';
import type { SupervisorRecord } from './supervisor-records';
import type { ProjectManagerRecord } from './project-manager-records';
import { getAppDataDir } from '../shared/instance';
import { projectManagerEventNeedsUserAttention } from '../shared/project-manager';
import {
  SUPERVISOR_NO_DECISION_OPTION,
  supervisorDecisionOptions,
} from '../shared/supervisor-decision-options';
import {
  USER_RECORDS_TERMINAL_AGENT,
  USER_RECORDS_TERMINAL_DIRECTORY,
  USER_RECORDS_TERMINAL_NAME,
  USER_RECORDS_TERMINAL_SKILL_NAME,
  USER_RECORDS_TERMINAL_STARTUP_INPUT,
} from '../shared/user-records-terminal';

export type FeishuSupervisorCommand =
  | { action: 'list' }
  | { action: 'logs' }
  | { action: 'terminal-list'; mode: 'ordinary' | 'project' }
  | { action: 'terminal-screen'; terminal: string; lines?: number; mode?: 'ordinary' | 'project' }
  | { action: 'supervisor-screen'; terminal: string; lines?: number }
  | { action: 'decision-context'; approvalId: string; terminal: string; lines?: number }
  | { action: 'create-task'; name: string; task: string; agent?: 'codex' | 'kimi' | 'grok'; preset?: 'user-records'; cwd?: string; displayPath?: string; anchorWorkspace?: string; anchorTerminal?: string }
  | { action: 'start'; terminals: string[]; stopWhen: string; stopWhenKind: 'concrete' | 'direction'; taskGoal?: string; taskDescription?: string; preconditions?: string; planFile?: string; autonomous: boolean; supervisorLaunchCmd?: string; supervisorModel?: string; supervisorReasoningEffort?: string }
  | { action: 'send'; terminal: string; task: string; force?: boolean; mode?: 'project' }
  | { action: 'terminal-escape'; terminal: string; mode?: 'project' }
  | { action: 'terminal-interrupt'; terminal: string; mode?: 'project' }
  | { action: 'close-terminal'; terminal: string }
  | { action: 'send-supervisor-message'; terminal: string; message: string }
  | { action: 'waiting-decision'; terminal: string; decision: 'keep' | 'resume' | 'submit' | 'stop'; message?: string }
  | { action: 'pause-lane'; terminal: string }
  | { action: 'resume-lane'; terminal: string }
  | { action: 'stop-lane'; terminal: string }
  | { action: 'pause-all' }
  | { action: 'resume-all' }
  | { action: 'stop' }
  | { action: 'decide'; approvalId: string; decision: 'approve' | 'direct' | 'pause' | 'stop'; selection?: string; task?: string }
  | { action: 'project-status'; projectId?: string }
  | { action: 'project-message'; projectId?: string; message: string; messageId: string; chatId: string }
  | { action: 'project-answer'; projectId?: string; questionId: string; optionId?: string; answer: string }
  | { action: 'project-logs'; projectId?: string }
  | { action: 'project-pause'; projectId?: string; reason?: string }
  | { action: 'project-resume'; projectId?: string; reason?: string }
  | { action: 'project-pause-all'; reason?: string }
  | { action: 'project-resume-all'; reason?: string }
  | { action: 'project-stop'; projectId?: string; reason?: string; emergency: boolean };

export interface FeishuSupervisorControl {
  (command: FeishuSupervisorCommand, actor: { openId: string; source: 'text' | 'card' | 'system' }): Promise<unknown>;
}

interface FeishuConfig {
  appId: string;
  appSecret: string;
  chatId: string;
  controlChatId?: string;
  decisionChatId?: string;
  projectManagerChatId?: string;
  allowedOpenIds: Set<string>;
}

export function isFeishuSupervisorActorAllowed(
  config: Pick<FeishuConfig, 'controlChatId' | 'projectManagerChatId' | 'allowedOpenIds'>,
  chatId: string,
  openId: string,
  chatType: 'group' | 'p2p',
): boolean {
  if (!config.allowedOpenIds.has(openId)) return false;
  return chatType === 'p2p' || (chatType === 'group' && (
    (!!config.controlChatId && chatId === config.controlChatId)
    || (!!config.projectManagerChatId && chatId === config.projectManagerChatId)
  ));
}

interface ApprovalCard {
  messageId: string;
  approvalId: string;
  chatId: string;
  record: SupervisorRecord;
}

interface ApprovalCardFeedback {
  error?: string;
  decisionInput?: string;
}

interface WaitingDecisionCard {
  messageId: string;
  chatId: string;
  terminal: string;
}

type PendingDecisionMessage =
  | { kind: 'approval'; approvalId: string; record: SupervisorRecord }
  | { kind: 'waiting'; record: SupervisorRecord }
  | { kind: 'text'; text: string }
  | { kind: 'project-clarification'; projectId: string; question: FeishuProjectClarification };

export function isFeishuApprovalCardContext(
  card: Pick<ApprovalCard, 'messageId' | 'chatId'> | undefined,
  messageId: string,
  chatId: string,
): boolean {
  return !!card && card.messageId === messageId && card.chatId === chatId;
}

const COMMAND_PREFIX = 'WMUX SUPERVISOR ';
const MAX_COMMAND_VALUE_LENGTH = 4000;
const FEISHU_ENV_KEYS = ['WMUX_FEISHU_APP_ID', 'WMUX_FEISHU_APP_SECRET', 'WMUX_FEISHU_CHAT_ID', 'WMUX_FEISHU_CONTROL_CHAT_ID', 'WMUX_FEISHU_DECISION_CHAT_ID', 'WMUX_FEISHU_PROJECT_MANAGER_CHAT_ID', 'WMUX_FEISHU_ALLOWED_OPEN_IDS'] as const;
const LEGACY_DOT_ENV_KEY_MAP: Record<string, FeishuEnvKey> = {
  FEISHU_APP_ID: 'WMUX_FEISHU_APP_ID',
  FEISHU_APP_SECRET: 'WMUX_FEISHU_APP_SECRET',
  FEISHU_CHAT_ID: 'WMUX_FEISHU_DECISION_CHAT_ID',
  FEISHU_GROUP_CHAT_ID: 'WMUX_FEISHU_CHAT_ID',
  FEISHU_USER_OPEN_ID: 'WMUX_FEISHU_ALLOWED_OPEN_IDS',
};

type FeishuEnvKey = typeof FEISHU_ENV_KEYS[number];
type FeishuEnvFilePointer = { WMUX_ENV_FILE?: string; WMUX_FEISHU_ENV_FILE?: string };
export type FeishuDotEnvValues = Partial<Record<FeishuEnvKey, string>> & FeishuEnvFilePointer;

function applyFeishuEnv(target: NodeJS.ProcessEnv, values: Partial<Record<FeishuEnvKey, string>>): void {
  for (const key of FEISHU_ENV_KEYS) {
    if (!target[key]?.trim() && values[key]?.trim()) target[key] = values[key];
  }
}

export function resolveFeishuEnvFilePointer(
  values: FeishuEnvFilePointer = {},
  env: NodeJS.ProcessEnv = {},
): string | undefined {
  return env.WMUX_ENV_FILE?.trim()
    || env.WMUX_FEISHU_ENV_FILE?.trim()
    || values.WMUX_ENV_FILE?.trim()
    || values.WMUX_FEISHU_ENV_FILE?.trim()
    || undefined;
}

export function parseFeishuDotEnv(content: string): FeishuDotEnvValues {
  const values: FeishuDotEnvValues = {};
  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*(WMUX_ENV_FILE|WMUX_FEISHU_(?:APP_ID|APP_SECRET|CHAT_ID|CONTROL_CHAT_ID|DECISION_CHAT_ID|PROJECT_MANAGER_CHAT_ID|ALLOWED_OPEN_IDS|ENV_FILE)|FEISHU_(?:APP_ID|APP_SECRET|CHAT_ID|GROUP_CHAT_ID|USER_OPEN_ID))\s*=\s*(.*?)\s*$/.exec(rawLine);
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2').trim();
    const key = LEGACY_DOT_ENV_KEY_MAP[match[1]] || match[1] as FeishuEnvKey | keyof FeishuEnvFilePointer;
    if (value) values[key] = value;
  }
  return values;
}

/** Load a pointed-to profile: standard dotenv first, then the label/value scratch format. */
export function parseReferencedFeishuEnv(content: string): Partial<Record<FeishuEnvKey, string>> {
  const dotenv = parseFeishuDotEnv(content);
  const values: Partial<Record<FeishuEnvKey, string>> = {};
  for (const key of FEISHU_ENV_KEYS) {
    if (dotenv[key]) values[key] = dotenv[key];
  }
  return Object.keys(values).length > 0 ? values : parseLegacyFeishuEnv(content);
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
  let referencedFile = resolveFeishuEnvFilePointer({}, env);
  let referencedBaseDir = cwd;
  for (const envPath of envPaths) {
    const content = readText(envPath);
    if (!content) continue;
    const values = parseFeishuDotEnv(content);
    applyFeishuEnv(env, values);
    if (!referencedFile) {
      referencedFile = resolveFeishuEnvFilePointer(values);
      if (referencedFile) referencedBaseDir = path.dirname(envPath);
    }
  }
  if (!referencedFile) return;
  const referencedPath = path.isAbsolute(referencedFile)
    ? referencedFile
    : path.resolve(referencedBaseDir, referencedFile);
  const referencedContent = readText(referencedPath);
  if (referencedContent) applyFeishuEnv(env, parseReferencedFeishuEnv(referencedContent));
}

function envConfig(env = process.env): FeishuConfig | null {
  loadFeishuEnvironment(env);
  const appId = env.WMUX_FEISHU_APP_ID?.trim();
  const appSecret = env.WMUX_FEISHU_APP_SECRET?.trim();
  const chatId = env.WMUX_FEISHU_CHAT_ID?.trim();
  const controlChatId = env.WMUX_FEISHU_CONTROL_CHAT_ID?.trim();
  const decisionChatId = env.WMUX_FEISHU_DECISION_CHAT_ID?.trim();
  const projectManagerChatId = env.WMUX_FEISHU_PROJECT_MANAGER_CHAT_ID?.trim();
  const allowedOpenIds = new Set((env.WMUX_FEISHU_ALLOWED_OPEN_IDS || '').split(',').map((item) => item.trim()).filter(Boolean));
  if (!appId || !appSecret || !chatId || allowedOpenIds.size === 0) return null;
  return { appId, appSecret, chatId, controlChatId, decisionChatId, projectManagerChatId, allowedOpenIds };
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
    if (!hasOnlyFields(fields, ['approval_id', 'action', 'selection', 'task'])) return { error: 'DECIDE 包含不支持的字段。' };
    const decision = fields.action?.toLowerCase();
    if (!fields.approval_id || !['approve', 'direct', 'pause', 'stop'].includes(decision || '')) {
      return { error: 'DECIDE 需要 approval_id 和 action: approve|direct|pause|stop。' };
    }
    if (decision === 'direct' && !fields.task) return { error: 'DECIDE 的 action: direct 需要 task。' };
    if (decision !== 'direct' && fields.task) return { error: 'DECIDE 的 task 仅支持 action: direct。' };
    if (decision !== 'approve' && fields.selection) return { error: 'DECIDE 的 selection 仅支持 action: approve。' };
    return {
      action: 'decide',
      approvalId: fields.approval_id,
      decision: decision as 'approve' | 'direct' | 'pause' | 'stop',
      selection: fields.selection || undefined,
      task: fields.task || undefined,
    };
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
type FeishuTerminalControlMode = 'ordinary' | 'project';
type FeishuTerminalAgentRole = 'project-ai' | 'supervisor-ai' | 'task-ai';

interface FeishuListTerminal {
  surfaceId: string;
  label: string;
  workspaceId?: string;
  workspace: string;
  cwd?: string;
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
  terminalMode?: FeishuTerminalControlMode;
  agentRole?: FeishuTerminalAgentRole;
  projectId?: string;
  projectName?: string;
  workItemId?: string;
  workItemTitle?: string;
  runtimeState?: 'starting' | 'ready' | 'failed' | 'exited';
  runtimeDetail?: string;
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

interface FeishuTerminalScreenResult {
  terminal: Pick<FeishuListTerminal,
  'surfaceId' | 'label' | 'workspace' | 'cwd' | 'activityState' | 'activityUpdatedAt'
  | 'terminalMode' | 'agentRole' | 'projectId' | 'projectName' | 'workItemId' | 'workItemTitle'
  | 'runtimeState' | 'runtimeDetail'>;
  text: string;
  question?: string;
  answer?: string;
  answerPending?: boolean;
  lines: number;
  capturedAt: number;
}

const FEISHU_TERMINAL_QUESTION_MAX_CHARS = 1_000;
const FEISHU_TERMINAL_ANSWER_MAX_CHARS = 4_000;
const FEISHU_TERMINAL_COLLAPSED_ANSWER_MAX_CHARS = 1_500;
const FEISHU_TERMINAL_CAPTURE_LINES = 100;

interface FeishuControlState {
  active: boolean;
  paused: boolean;
  totalTerminals: number;
  availableTerminals: number;
  supervisedTerminals: number;
  pendingApprovals: number;
}

interface FeishuSupervisorLogEntry {
  ts: number;
  laneLabel: string;
  action: string;
  detail: string;
}

interface FeishuSupervisorLogResult {
  active: boolean;
  paused: boolean;
  sessionId: string;
  entries: FeishuSupervisorLogEntry[];
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
  const labelCounts = new Map<string, number>();
  for (const terminal of terminals) {
    const key = `${terminal.workspace}\0${terminal.label}`;
    labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
  }
  const labelOrdinals = new Map<string, number>();

  return terminals.map((terminal) => {
    const key = `${terminal.workspace}\0${terminal.label}`;
    const ordinal = (labelOrdinals.get(key) || 0) + 1;
    labelOrdinals.set(key, ordinal);
    const duplicateSuffix = (labelCounts.get(key) || 0) > 1 ? ` #${ordinal}` : '';
    const supervisorContext = terminal.supervisionState === 'paused'
      ? '（AI管家已暂停）'
      : terminal.supervised
        ? '（AI管家监督中）'
        : terminal.restartable ? '（AI管家已停止，可重新监督）' : '';
    const workspaceSuffix = terminal.workspace
      && !terminal.label.toLocaleLowerCase().endsWith(` · ${terminal.workspace}`.toLocaleLowerCase())
      ? ` · ${terminal.workspace}`
      : '';
    return {
      text: {
        tag: 'plain_text',
        content: `${terminal.label}${duplicateSuffix}${supervisorContext}${workspaceSuffix}${showActivity ? ` · ${terminalActivityText(terminal)}` : ''}`.slice(0, 100),
      },
      value: terminal.surfaceId,
    };
  });
}

interface SavedTerminalPath {
  id: string;
  name: string;
  cwd: string;
}

function compactTerminalPath(cwd: string): string {
  if (cwd.length <= 32) return cwd;
  const parsed = path.win32.parse(cwd);
  const uncServer = /^\\\\([^\\]+)\\/u.exec(parsed.root)?.[1];
  const root = uncServer ? `\\\\${uncServer}\\` : parsed.root;
  const leaf = path.win32.basename(cwd);
  const compactLeaf = leaf.length > 24 ? `${leaf.slice(0, 11)}…${leaf.slice(-12)}` : leaf;
  return `${root}…\\${compactLeaf}`;
}

function compactTerminalControlPath(cwd: string): string {
  const maxLength = 48;
  const raw = cwd.trim();
  if (raw.length <= maxLength) return raw;
  const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(raw);
  const pathApi = windowsPath ? path.win32 : path.posix;
  const normalized = pathApi.normalize(windowsPath ? raw.replace(/\//gu, '\\') : raw);
  const parsed = pathApi.parse(normalized);
  const separator = windowsPath ? '\\' : '/';
  const segments = normalized.slice(parsed.root.length).split(separator).filter(Boolean);
  const tail = segments.slice(-2).join(separator);
  const candidate = `${parsed.root}…${separator}${tail}`;
  if (candidate.length <= maxLength) return candidate;
  const leaf = pathApi.basename(normalized);
  const availableLeafLength = Math.max(12, maxLength - parsed.root.length - 2);
  const compactLeaf = leaf.length > availableLeafLength
    ? `${leaf.slice(0, Math.floor((availableLeafLength - 1) / 2))}…${leaf.slice(-Math.ceil((availableLeafLength - 1) / 2))}`
    : leaf;
  return `${parsed.root}…${separator}${compactLeaf}`;
}

function savedTerminalPaths(): SavedTerminalPath[] {
  const raw = loadSettings()['wmux-quick-launch-profiles'];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((value) => {
    if (!isObject(value) || value.type !== 'terminal'
      || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.cwd !== 'string') return [];
    const cwd = value.cwd.trim();
    if (!cwd || !path.win32.isAbsolute(cwd) || seen.has(value.id)) return [];
    seen.add(value.id);
    return [{ id: value.id, name: value.name.trim() || compactTerminalPath(cwd), cwd }];
  });
}

function savedTerminalPath(id: string): string | undefined {
  return savedTerminalPaths().find((item) => item.id === id)?.cwd;
}

function terminalPathOptions(terminals: FeishuListTerminal[]): Array<{ text: { tag: 'plain_text'; content: string }; value: string }> {
  const saved = savedTerminalPaths().map((item) => ({
    text: { tag: 'plain_text' as const, content: `${item.name} · ${compactTerminalPath(item.cwd)}`.slice(0, 100) },
    value: `saved:${item.id}`,
  }));
  const seen = new Set<string>();
  const candidates = terminals.flatMap((terminal) => {
    const rawCwd = terminal.cwd?.trim();
    if (!rawCwd || !path.win32.isAbsolute(rawCwd)) return [];
    let cwd = path.win32.normalize(rawCwd);
    if (cwd.length > path.win32.parse(cwd).root.length) cwd = cwd.replace(/\\+$/u, '');
    const key = cwd.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ label: compactTerminalPath(cwd), value: terminal.surfaceId }];
  });
  const labelCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = candidate.label.toLowerCase();
    labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
  }
  const labelIndexes = new Map<string, number>();
  return [...saved, ...candidates.map((candidate) => {
    const key = candidate.label.toLowerCase();
    const index = (labelIndexes.get(key) || 0) + 1;
    labelIndexes.set(key, index);
    const label = labelCounts.get(key) === 1 ? candidate.label : `${candidate.label} (${index})`;
    return { text: { tag: 'plain_text' as const, content: label }, value: candidate.value };
  })];
}

function existingTerminalSessionOptions(terminals: FeishuListTerminal[]): Array<{ text: { tag: 'plain_text'; content: string }; value: string }> {
  const seen = new Set<string>();
  const sessions = terminals.flatMap((terminal) => {
    const key = terminal.workspaceId || terminal.workspace;
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [{
      label: terminal.workspace || terminal.label,
      value: terminal.workspaceId ? `workspace:${terminal.workspaceId}` : `terminal:${terminal.surfaceId}`,
    }];
  });
  const labelCounts = new Map<string, number>();
  for (const session of sessions) {
    const key = session.label.toLocaleLowerCase();
    labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
  }
  const labelOrdinals = new Map<string, number>();
  return sessions.map((session) => {
    const key = session.label.toLocaleLowerCase();
    const ordinal = (labelOrdinals.get(key) || 0) + 1;
    labelOrdinals.set(key, ordinal);
    const suffix = (labelCounts.get(key) || 0) > 1 ? ` #${ordinal}` : '';
    return {
      text: { tag: 'plain_text' as const, content: `${session.label}${suffix}`.slice(0, 100) },
      value: session.value,
    };
  });
}

function terminalSessionOptions(terminals: FeishuListTerminal[]): Array<{ text: { tag: 'plain_text'; content: string }; value: string }> {
  return [
    { text: { tag: 'plain_text', content: '新建独立会话（默认）' }, value: 'new' },
    ...existingTerminalSessionOptions(terminals).map((session) => ({
      text: { tag: 'plain_text' as const, content: `已有会话：${session.text.content}`.slice(0, 100) },
      value: session.value,
    })),
  ];
}

function supervisorTerminalOptions(terminals: FeishuListTerminal[]): Array<{ text: { tag: 'plain_text'; content: string }; value: string }> {
  return terminals.map((terminal) => ({
    text: {
      tag: 'plain_text',
      content: `AI监督终端（管家） · 负责：${terminal.label} · ${terminalSupervisionStatusText(terminal, false)} · 任务端：${terminalActivityText(terminal)}`.slice(0, 100),
    },
    value: terminal.surfaceId,
  }));
}

let controlActionSequence = 0;

export const FEISHU_CONTROL_CARD_VERSION = '18';

function nextControlActionNonce(): string {
  controlActionSequence = (controlActionSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${controlActionSequence.toString(36)}`;
}

function nextControlElementIdentity(prefix: string): { elementId: string; nonce: string } {
  const nonce = nextControlActionNonce();
  return {
    // Card JSON 2.0 requires a card-unique identifier of at most 20 characters,
    // containing only letters, digits, and underscores, starting with a letter.
    elementId: `${prefix}_${nonce.replace(/[^a-z0-9]/giu, '_')}`.slice(0, 20),
    nonce,
  };
}

function cardButton(value: Record<string, string>, text: string, type: 'primary' | 'default' | 'danger' = 'default'): object {
  const identity = nextControlElementIdentity('btn');
  return {
    tag: 'button', element_id: identity.elementId,
    text: { tag: 'plain_text', content: text }, type,
    value: { ...value, wmux_card_version: FEISHU_CONTROL_CARD_VERSION, nonce: identity.nonce },
  };
}

/** Keep action labels readable on both narrow mobile cards and wide desktop cards. */
function responsiveButtonRows(buttons: object[], columnsPerRow = 2): object[] {
  const rows: object[] = [];
  for (let index = 0; index < buttons.length; index += columnsPerRow) {
    rows.push({
      tag: 'column_set',
      flex_mode: 'none',
      columns: buttons.slice(index, index + columnsPerRow).map((button) => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [button],
      })),
    });
  }
  return rows;
}

function formButton(
  name: string,
  text: string,
  type: 'primary' | 'default' | 'danger' = 'default',
  value?: Record<string, string>,
): object {
  const identity = nextControlElementIdentity('btn');
  return {
    tag: 'button', element_id: identity.elementId, name,
    text: { tag: 'plain_text', content: text }, type, action_type: 'form_submit',
    ...(value ? { value: {
      ...value,
      ...(value.wmux_action === 'decide' ? {} : { wmux_card_version: FEISHU_CONTROL_CARD_VERSION }),
      nonce: identity.nonce,
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
  beforeFormElements: object[] = [],
): object {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: title }, template },
    body: {
      elements: [
        { tag: 'markdown', content: description },
        ...beforeFormElements,
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
  projectId?: string;
  questionId?: string;
  optionId?: string;
  answer?: string;
  approval_id?: string;
  decision?: string;
  flow?: string;
  view?: string;
  terminal?: string;
  terminal_mode?: string;
  session_target?: string;
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
  mode?: 'project';
  expiresAt: number;
}

function isReusableControlAction(value: ResolvedCardAction): boolean {
  if (value.wmux_action === 'stop_lane_confirm' || value.wmux_action === 'terminal_screen') return true;
  return value.wmux_action === 'menu'
    && ['create-task', 'special-terminal', 'start', 'send', 'send-supervisor', 'terminal-screen', 'terminal-control', 'ordinary-terminal-control', 'project-terminal-control', 'close-terminal', 'manage', 'status', 'detail-status', 'logs', 'stop-confirm'].includes(value.flow || '');
}

const TERMINAL_AGENT_ROLE_LABELS: Record<FeishuTerminalAgentRole, string> = {
  'project-ai': '项目 AI',
  'supervisor-ai': '专属监督 AI',
  'task-ai': '任务 AI',
};

function projectTerminalRuntimeText(terminal: FeishuListTerminal): string {
  if (terminal.runtimeState === 'failed') return `运行失败${terminal.runtimeDetail ? ` · ${terminal.runtimeDetail}` : ''}`;
  if (terminal.runtimeState === 'exited') return `已退出${terminal.runtimeDetail ? ` · ${terminal.runtimeDetail}` : ''}`;
  if (terminal.runtimeState === 'starting') return '启动中';
  return terminalActivityText(terminal);
}

function projectTerminalOptions(terminals: FeishuListTerminal[]): Array<{ text: { tag: 'plain_text'; content: string }; value: string }> {
  return terminals.map((terminal) => {
    const role = terminal.agentRole ? TERMINAL_AGENT_ROLE_LABELS[terminal.agentRole] : '项目终端';
    const task = terminal.workItemTitle ? ` · ${terminal.workItemTitle}` : '';
    return {
      text: {
        tag: 'plain_text',
        content: `${terminal.projectName || terminal.projectId || '未知项目'} · ${role}${task} · ${projectTerminalRuntimeText(terminal)}`.slice(0, 100),
      },
      value: terminal.surfaceId,
    };
  });
}

function ordinaryMonitoringTerminalOptions(terminals: FeishuListTerminal[]): Array<{ text: { tag: 'plain_text'; content: string }; value: string }> {
  const baseOptions = terminalOptions(terminals);
  return terminals.map((terminal, index) => ({
    text: {
      tag: 'plain_text',
      content: `${terminal.agentRole === 'supervisor-ai' ? '普通监督 AI' : '普通任务 AI'} · ${baseOptions[index].text.content} · ${projectTerminalRuntimeText(terminal)}`.slice(0, 100),
    },
    value: terminal.surfaceId,
  }));
}

export function resolveFeishuCardAction(value: unknown, name?: string): ResolvedCardAction {
  const rawValue = isObject(value) ? value : {};
  if (name === 'wmux_form_project_ai_message') return { ...rawValue, wmux_action: 'form_project_ai_message' };
  if (name === 'wmux_form_project_clarification') return { ...rawValue, wmux_action: 'form_project_clarification' };
  if (name === 'wmux_form_create_task') return { ...rawValue, wmux_action: 'form_create_task' };
  if (name === 'wmux_form_create_user_records_terminal') return { ...rawValue, wmux_action: 'form_create_user_records_terminal' };
  if (name === 'wmux_form_start') return { ...rawValue, wmux_action: 'form_start' };
  if (name === 'wmux_form_send') return { ...rawValue, wmux_action: 'form_send' };
  if (name === 'wmux_form_send_supervisor') return { ...rawValue, wmux_action: 'form_send_supervisor' };
  if (name === 'wmux_form_supervisor_screen') return { ...rawValue, wmux_action: 'form_supervisor_screen' };
  if (name === 'wmux_form_supervisor_refresh') return { ...rawValue, wmux_action: 'form_supervisor_refresh' };
  if (name === 'wmux_form_supervisor_expand') return { ...rawValue, wmux_action: 'form_supervisor_expand' };
  if (name === 'wmux_form_supervisor_collapse') return { ...rawValue, wmux_action: 'form_supervisor_collapse' };
  if (name === 'wmux_form_supervisor_send') return { ...rawValue, wmux_action: 'form_supervisor_send' };
  if (name === 'wmux_form_terminal_screen') return { ...rawValue, wmux_action: 'form_terminal_screen' };
  if (name === 'wmux_form_terminal_control') return { ...rawValue, wmux_action: 'form_terminal_control' };
  if (name === 'wmux_form_terminal_refresh') return { ...rawValue, wmux_action: 'form_terminal_refresh' };
  if (name === 'wmux_form_terminal_expand') return { ...rawValue, wmux_action: 'form_terminal_expand' };
  if (name === 'wmux_form_terminal_collapse') return { ...rawValue, wmux_action: 'form_terminal_collapse' };
  if (name === 'wmux_form_terminal_send') return { ...rawValue, wmux_action: 'form_terminal_send' };
  if (name === 'wmux_form_terminal_escape') return { ...rawValue, wmux_action: 'form_terminal_escape' };
  if (name === 'wmux_form_terminal_interrupt') return { ...rawValue, wmux_action: 'form_terminal_interrupt' };
  if (name === 'wmux_form_project_terminal_refresh') return { ...rawValue, wmux_action: 'form_project_terminal_refresh' };
  if (name === 'wmux_form_project_terminal_expand') return { ...rawValue, wmux_action: 'form_project_terminal_expand' };
  if (name === 'wmux_form_project_terminal_collapse') return { ...rawValue, wmux_action: 'form_project_terminal_collapse' };
  if (name === 'wmux_form_project_terminal_send') return { ...rawValue, wmux_action: 'form_project_terminal_send' };
  if (name === 'wmux_form_project_terminal_escape') return { ...rawValue, wmux_action: 'form_project_terminal_escape' };
  if (name === 'wmux_form_project_terminal_interrupt') return { ...rawValue, wmux_action: 'form_project_terminal_interrupt' };
  if (name === 'wmux_form_close_terminal') return { ...rawValue, wmux_action: 'form_close_terminal' };
  if (name === 'wmux_form_lane_control') return { ...rawValue, wmux_action: 'form_lane_control' };
  const waitingDecision = /^wmux_waiting_(keep|resume|submit|stop)$/.exec(name || '')?.[1];
  if (waitingDecision) return { ...rawValue, wmux_action: 'waiting_decision', decision: waitingDecision };
  const decision = /^wmux_decide_(approve|direct|pause|stop)$/.exec(name || '')?.[1];
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
export function buildSupervisorControlMenuCard(
  state?: FeishuControlState,
  notice?: ControlNotice,
  allowTerminalScreen = true,
): object {
  const sessionRunning = state?.active || state?.paused;
  const sessionStatus = state?.active ? '进行中' : state?.paused ? '已暂停（上下文已保留）' : '未启动';
  const summaryText = state
    ? `**监督状态：${sessionStatus}**\n监督通道 ${state.supervisedTerminals} 个 · 可添加终端 ${state.availableTerminals} 个 · 待审批 ${state.pendingApprovals} 项`
    : '**监督状态：读取中**\n点击刷新状态获取最新信息。';
  const terminalOperations = [
    cardButton({ wmux_action: 'menu', flow: 'create-task' }, '添加终端任务', 'primary'),
    cardButton({ wmux_action: 'menu', flow: 'special-terminal' }, '创建特别终端'),
    ...(allowTerminalScreen
      ? [
          cardButton({ wmux_action: 'menu', flow: 'ordinary-terminal-control' }, '普通监督终端'),
          cardButton({ wmux_action: 'menu', flow: 'project-terminal-control' }, '项目 AI 模式终端'),
        ]
      : state?.totalTerminals !== 0
        ? [cardButton({ wmux_action: 'menu', flow: 'send' }, '发送任务')]
        : []),
    ...(state?.totalTerminals !== 0
      ? [
          cardButton({ wmux_action: 'menu', flow: 'close-terminal' }, '关闭终端', 'danger'),
        ]
      : []),
  ];
  const supervisorOperations = [
    ...(state?.paused
      ? [cardButton({ wmux_action: 'menu', flow: 'resume-all' }, '继续全部监督', 'primary')]
      : []),
    ...(state?.availableTerminals !== 0
      ? [cardButton({ wmux_action: 'menu', flow: 'start' }, sessionRunning ? '添加监督终端' : '启动监督', 'primary')]
      : []),
    ...(sessionRunning || (state?.supervisedTerminals || 0) > 0
      ? [
          ...(state?.active ? [cardButton({ wmux_action: 'menu', flow: 'send-supervisor' }, '发送监督信息', 'primary')] : []),
          cardButton({ wmux_action: 'menu', flow: 'manage' }, '管理监督'),
        ]
      : []),
  ];
  const projectManagerOperations = [
    cardButton({ wmux_action: 'menu', flow: 'project-manager' }, '进入项目中心', 'primary'),
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
        { tag: 'markdown', content: '**任务终端**' },
        ...responsiveButtonRows(terminalOperations),
        ...(supervisorOperations.length > 0 ? [
          { tag: 'markdown', content: '**AI 监督**' },
          ...responsiveButtonRows(supervisorOperations),
        ] : []),
        { tag: 'markdown', content: '**项目中心**' },
        ...responsiveButtonRows(projectManagerOperations),
        { tag: 'hr' },
        ...responsiveButtonRows([
          cardButton({ wmux_action: 'menu', flow: 'detail-status' }, '查看监督状态'),
          cardButton({ wmux_action: 'menu', flow: 'logs' }, '查看监督日志'),
        ]),
        {
          tag: 'div',
          text: {
            tag: 'plain_text',
            content: '普通 AI 监督直接管理普通任务终端；项目中心只负责项目入口与路由，进入项目后由该项目的专属项目 AI 负责决策和监督链调度；人工决策仍私发白名单用户。',
            text_size: 'notation',
            text_color: 'grey',
          },
        },
      ],
    },
  };
}

export interface FeishuProjectManagerView {
  projectId?: string;
  projectDir?: string;
  projectName?: string;
  projectScope?: string;
  activeGoalId?: string;
  status?: string;
  goal?: string;
  attentionKind?: string;
  attentionReason?: string;
  pauseReason?: string;
  pauseAttentionRequired?: boolean;
  goals?: Array<{ id?: string; sequence?: number; statement?: string; status?: string }>;
  subgoals?: Array<{ id?: string; goalId?: string; title?: string; outcome?: string; status?: string; order?: number }>;
  workItems?: Array<{
    goalId?: string;
    subgoalId?: string;
    status?: string;
    title?: string;
    latestEvidence?: string;
    latestContextSummary?: string;
    latestBlocker?: string;
    decisionsUsed?: number;
    attempts?: number;
    contract?: {
      execution?: { taskWorkMode?: string; modeReason?: string };
      budget?: { maxDecisions?: number; maxContinuousMinutes?: number; maxTaskRetries?: number };
    };
  }>;
  managedSupervisors?: Array<{ label?: string; status?: string; workerSurfaceId?: string; taskWorkMode?: string }>;
  projects?: Array<{
    id?: string;
    projectDir?: string;
    projectName?: string;
    activeGoalId?: string;
    goals?: Array<{ id?: string; sequence?: number }>;
    status?: string;
    goal?: string;
    pausedByPortfolio?: boolean;
    attentionKind?: string;
    attentionReason?: string;
    pauseReason?: string;
    pauseAttentionRequired?: boolean;
  }>;
  events?: Array<{ ts?: number; kind?: string; summary?: string; correlationId?: string }>;
  conversation?: Array<{ ts?: number; kind?: string; summary?: string; correlationId?: string }>;
  pendingUserQuestion?: FeishuProjectClarification;
}

interface FeishuProjectClarification {
  id: string;
  category?: 'clarification' | 'manual-intervention';
  workItemId?: string;
  blocker?: string;
  question: string;
  context?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  recommendedOptionId?: string;
}

export type ProjectManagerCardView = 'overview' | 'chat' | 'chat-expanded' | 'decisions' | 'decisions-expanded' | 'activity' | 'activity-expanded';

const FEISHU_PROJECT_RECENT_ITEM_LIMIT = 6;
const FEISHU_PROJECT_COLLAPSED_ITEM_LIMIT = 3;

/** Keep the Feishu projection in sync with the first-class project/goal model. */
export function projectManagerViewFromStatusResult(statusResult: unknown): FeishuProjectManagerView | null {
  const root = isObject(statusResult) ? statusResult : null;
  const rawSession = root && isObject(root.session)
    ? root.session
    : null;
  if (!rawSession) return null;
  return {
    projectId: typeof rawSession.id === 'string' ? rawSession.id : undefined,
    projectDir: typeof rawSession.projectDir === 'string' ? rawSession.projectDir : undefined,
    projectName: typeof rawSession.projectName === 'string' ? rawSession.projectName : undefined,
    projectScope: typeof rawSession.projectScope === 'string' ? rawSession.projectScope : undefined,
    activeGoalId: typeof rawSession.activeGoalId === 'string' ? rawSession.activeGoalId : undefined,
    status: typeof rawSession.status === 'string' ? rawSession.status : undefined,
    goal: typeof rawSession.goal === 'string' ? rawSession.goal : undefined,
    attentionKind: typeof rawSession.attentionKind === 'string' ? rawSession.attentionKind : undefined,
    attentionReason: typeof rawSession.attentionReason === 'string' ? rawSession.attentionReason : undefined,
    pauseReason: typeof rawSession.pauseReason === 'string' ? rawSession.pauseReason : undefined,
    pauseAttentionRequired: rawSession.pauseAttentionRequired === true,
    goals: Array.isArray(rawSession.goals) ? rawSession.goals as FeishuProjectManagerView['goals'] : [],
    subgoals: Array.isArray(rawSession.subgoals) ? rawSession.subgoals as FeishuProjectManagerView['subgoals'] : [],
    workItems: Array.isArray(rawSession.workItems) ? rawSession.workItems as FeishuProjectManagerView['workItems'] : [],
    managedSupervisors: Array.isArray(rawSession.managedSupervisors)
      ? rawSession.managedSupervisors as FeishuProjectManagerView['managedSupervisors']
      : [],
    pendingUserQuestion: isObject(rawSession.pendingUserQuestion)
      ? rawSession.pendingUserQuestion as unknown as FeishuProjectClarification
      : undefined,
    projects: Array.isArray(root?.projects)
      ? root.projects as FeishuProjectManagerView['projects']
      : [],
    conversation: Array.isArray(rawSession.events)
      ? (rawSession.events as FeishuProjectManagerView['conversation'])?.filter((event) => (
          event?.kind === 'user-message' || event?.kind === 'manager-reply'
        )).slice(-FEISHU_PROJECT_RECENT_ITEM_LIMIT)
      : [],
  };
}

function compactProjectCardText(value: unknown, maxLength: number): string {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n…（内容已截断，请在桌面端查看完整内容）`;
}

function projectManagerStatusLabel(status?: string): string {
  if (status === 'active') return '运行中';
  if (status === 'paused') return '已暂停';
  if (status === 'waiting') return '等待决策';
  if (status === 'waiting-decision') return '等待决策';
  if (status === 'waiting-dependencies') return '等待依赖';
  if (status === 'planned') return '待开始';
  if (status === 'running') return '执行中';
  if (status === 'validating') return '验证中';
  if (status === 'failed') return '失败';
  if (status === 'completed') return '已完成';
  if (status === 'stopped') return '已停止';
  return '尚未建立';
}

function projectManagerStatusMarker(status?: string): string {
  if (status === 'active') return '🟢';
  if (status === 'waiting') return '🟠';
  if (status === 'paused') return '⏸️';
  if (status === 'completed') return '✅';
  if (status === 'stopped') return '⏹️';
  return '⚪';
}

export function buildProjectClarificationCard(
  projectId: string,
  question: FeishuProjectClarification,
): object {
  const manualIntervention = question.category === 'manual-intervention';
  return buildFormCard(
    manualIntervention ? 'wmux · 项目阻塞，需要你的指示' : 'wmux · 项目需求需要与你对齐',
    'orange',
    [
      `项目 **${projectId}** 已暂停等待你的答复；其他项目继续运行。`,
      manualIntervention ? '该情况超出项目管理 AI 的决策权，答复后仍保持暂停，由项目管理 AI 决定恢复、改线或结束。' : '',
      !manualIntervention ? '项目管理 AI 已根据当前需求整理了可选方案和推荐项。你可以选择建议、补充边界或直接填写自己的方案；答复会回到该项目的连续对话。' : '',
      question.workItemId ? `工作项：${question.workItemId}` : '',
      question.blocker ? `阻塞原因：${question.blocker.slice(0, 1600)}` : '',
      `**${question.question.slice(0, 1800)}**`,
      question.context ? question.context.slice(0, 1800) : '',
    ].filter(Boolean).join('\n\n'),
    'wmux_project_clarification_form',
    [
      { tag: 'markdown', content: '**选择一个答复**' },
      ...responsiveButtonRows(question.options.map((option) => cardButton({
        wmux_action: 'project_clarification_option',
        projectId,
        questionId: question.id,
        optionId: option.id,
        answer: option.label,
      }, `${option.label}${option.id === question.recommendedOptionId ? '（推荐）' : ''}`, option.id === question.recommendedOptionId ? 'primary' : 'default'))),
      ...question.options.filter((option) => option.description).map((option) => ({
        tag: 'div',
        text: { tag: 'plain_text', content: `${option.label}：${option.description}` },
      })),
      { tag: 'hr' },
      {
        tag: 'input', element_id: 'project_clarification_answer', name: 'project_clarification_answer',
        input_type: 'multiline_text', rows: 4, max_length: 1000,
        label: { tag: 'plain_text', content: '自定义答复（可选）' },
        placeholder: { tag: 'plain_text', content: '不选上述选项时，可直接填写你的决定和必要边界。' },
      },
      formButton('wmux_form_project_clarification', '提交自定义答复', 'primary', {
        wmux_action: 'form_project_clarification', projectId, questionId: question.id,
      }),
    ],
  );
}

export function buildProjectRuntimeAlertCard(record: ProjectManagerRecord): object {
  const role = record.type === 'manager-runtime-failed'
    ? '项目管理 AI'
    : record.type === 'project-paused'
      ? '项目 AI 主动暂停'
      : record.type === 'supervisor-runtime-failed'
        ? '项目专属监督'
        : record.type === 'task-runtime-failed'
          ? '任务终端 AI'
          : record.type === 'requirements-quiesce-failed'
            ? '需求变更停机确认'
            : record.type === 'manager-delivery-failed'
              ? '项目管理消息投递'
              : record.type === 'guard-triggered'
                ? '项目执行护栏'
                : '项目执行异常';
  const detail = String(record.payload?.message || record.payload?.detail || '运行时或控制链路不可用').trim();
  const suggestion = record.type === 'manager-runtime-failed'
    ? '在 wmux 中重建项目管理 AI 运行时；恢复后会使用结构化项目记录继续。'
    : record.type === 'project-paused'
      ? '打开项目工作台查看暂停原因和当前阻塞；处理完成后再恢复项目，避免继续复用失效运行链。'
      : record.type === 'supervisor-runtime-failed'
        ? '打开该项目的专属监督，重建监督 AI 后再恢复项目。'
        : record.type === 'task-runtime-failed'
          ? '由项目管理 AI 重建任务终端和监督链，不要向普通终端直接补发任务。'
          : record.type === 'requirements-quiesce-failed'
            ? '先确认旧监督链与任务终端已停止，再保存需求变更并重新规划。'
            : record.type === 'manager-delivery-failed'
              ? '检查项目管理 AI 运行时与控制链路，确认消息已送达后再恢复。'
              : record.type === 'guard-triggered'
                ? '打开项目工作台查看预算与护栏原因；调整任务合同或恢复项目后再继续。'
                : '打开项目工作台查看异常详情，排除阻塞后再恢复自动推进。';
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'wmux · 项目需要处理' },
      subtitle: { tag: 'plain_text', content: role },
      template: 'red',
    },
    body: {
      elements: [
        { tag: 'markdown', content: `🔴 **项目自动推进需要处理**\n项目：\`${record.sessionId}\`\n异常环节：**${role}**` },
        { tag: 'markdown', content: `**告警详情**\n${compactProjectCardText(detail, 1200)}` },
        { tag: 'markdown', content: `**建议处理**\n${suggestion}\n\n该异常不会由普通 AI 监督接管；请在专属项目工作台处理。` },
        { tag: 'hr' },
        ...responsiveButtonRows([
          cardButton({ wmux_action: 'project_ai_workspace', projectId: record.sessionId }, '打开项目工作台', 'primary'),
          cardButton({ wmux_action: 'project_ai_portfolio' }, '查看项目中心'),
        ]),
      ],
    },
  };
}

export function buildProjectManagerPortfolioCard(
  session?: FeishuProjectManagerView | null,
  notice?: ControlNotice,
): object {
  const projects = Array.isArray(session?.projects) ? session.projects : [];
  const activeProjects = projects.filter((project) => !['completed', 'stopped'].includes(String(project.status || ''))).length
    || (session && !['completed', 'stopped'].includes(String(session.status || '')) ? 1 : 0);
  const canPausePortfolio = projects.some((project) => project.status === 'active' || project.status === 'waiting');
  const canResumePortfolio = projects.some((project) => project.status === 'paused' && project.pausedByPortfolio === true);
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'wmux · 项目中心' }, template: 'blue' },
    body: {
      elements: [
        ...(notice ? [{ tag: 'markdown', content: `${notice.success ? '✅' : '⚠️'} ${notice.text}` }] : []),
        { tag: 'markdown', content: `**${activeProjects} 个活动项目** · 项目中心只负责入口和状态路由；选择项目进入其独立会话，与专属项目 AI 对话。` },
        ...(projects.length > 0 ? projects.flatMap((project) => [
          {
            tag: 'markdown',
            content: [
              `${projectManagerStatusMarker(project.status)} **${String(project.projectName || '未命名项目').slice(0, 100)}**`,
              `当前主目标：G${project.goals?.find((goal) => goal.id === project.activeGoalId)?.sequence || 1} · ${String(project.goal || '待设置').slice(0, 160)}`,
              `状态：${projectManagerStatusLabel(project.status)}${project.id === session?.projectId ? ' · 当前项目' : ''}`,
              project.attentionReason
                ? `⚠️ 需要处理：${compactProjectCardText(project.attentionReason, 500)}`
                : project.status === 'paused' && project.pauseReason
                ? `${project.pauseAttentionRequired ? '⚠️ ' : ''}暂停原因：${compactProjectCardText(project.pauseReason, 500)}`
                : '',
              project.projectDir ? `目录：${String(project.projectDir).slice(0, 240)}` : '',
            ].filter(Boolean).join('\n'),
          },
          ...responsiveButtonRows([cardButton({ wmux_action: 'project_ai_workspace', projectId: project.id || '' }, project.id === session?.projectId ? '打开当前工作台' : '进入项目工作台', 'primary')]),
        ]) : [{ tag: 'markdown', content: '暂无活动项目。请先在桌面端或飞书项目入口添加项目。' }]),
        { tag: 'hr' },
        ...responsiveButtonRows([
          ...(canPausePortfolio ? [cardButton({ wmux_action: 'project_ai_pause_all' }, '暂停全部项目')] : []),
          ...(canResumePortfolio ? [cardButton({ wmux_action: 'project_ai_resume_all' }, '恢复全部项目', 'primary')] : []),
          cardButton({ wmux_action: 'menu', flow: 'home' }, '返回控制首页'),
        ]),
      ],
    },
  };
}

export function buildProjectManagerConversationCard(
  session?: FeishuProjectManagerView | null,
  notice?: ControlNotice,
  view: ProjectManagerCardView = 'overview',
): object {
  const allWorkItems = Array.isArray(session?.workItems) ? session.workItems : [];
  const workItems = allWorkItems.filter((item) => (
    !session?.activeGoalId || !item.goalId || item.goalId === session.activeGoalId
  ));
  const supervisors = Array.isArray(session?.managedSupervisors) ? session.managedSupervisors : [];
  const allConversation = Array.isArray(session?.conversation) ? session.conversation : [];
  const conversation = allConversation.slice(-FEISHU_PROJECT_RECENT_ITEM_LIMIT);
  const pendingQuestion = session?.pendingUserQuestion;
  const status = projectManagerStatusLabel(session?.status);
  const allLogs = Array.isArray(session?.events) ? session.events : [];
  const recentLogs = allLogs.slice(-FEISHU_PROJECT_RECENT_ITEM_LIMIT).reverse();
  const latestReply = [...conversation].reverse().find((event) => event.kind === 'manager-reply');
  const waiting = workItems.filter((item) => item?.status === 'waiting-decision').length;
  const chatView = view === 'chat' || view === 'chat-expanded';
  const chatHistoryExpanded = view === 'chat-expanded';
  const decisionView = view === 'decisions' || view === 'decisions-expanded';
  const decisionsExpanded = view === 'decisions-expanded';
  const activityView = view === 'activity' || view === 'activity-expanded';
  const activityExpanded = view === 'activity-expanded';
  const currentGoal = session?.goals?.find((goal) => goal.id === session.activeGoalId);
  const currentSubgoals = (session?.subgoals || [])
    .filter((subgoal) => subgoal.goalId === session?.activeGoalId && subgoal.status !== 'obsolete')
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
  let collapsedConversationStart = Math.max(0, conversation.length - 1);
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (conversation[index]?.kind !== 'user-message') continue;
    if (conversation.length - index <= 3) collapsedConversationStart = index;
    break;
  }
  const hiddenConversationCount = collapsedConversationStart;
  const visibleConversation = chatHistoryExpanded
    ? conversation
    : conversation.slice(collapsedConversationStart);
  const recentWorkItems = workItems.slice(-FEISHU_PROJECT_RECENT_ITEM_LIMIT).reverse();
  const visibleWorkItems = decisionsExpanded
    ? recentWorkItems
    : recentWorkItems.slice(0, FEISHU_PROJECT_COLLAPSED_ITEM_LIMIT);
  const visibleLogs = activityExpanded
    ? recentLogs
    : recentLogs.slice(0, FEISHU_PROJECT_COLLAPSED_ITEM_LIMIT);
  const nav = responsiveButtonRows([
    cardButton({ wmux_action: 'project_ai_view', projectId: session?.projectId || '', view: 'overview' }, '概览', view === 'overview' ? 'primary' : 'default'),
    cardButton({ wmux_action: 'project_ai_view', projectId: session?.projectId || '', view: 'chat' }, '与 AI 对话', chatView ? 'primary' : 'default'),
    cardButton({ wmux_action: 'project_ai_view', projectId: session?.projectId || '', view: 'decisions' }, `决策${pendingQuestion || waiting > 0 ? ' · 待处理' : ''}`, decisionView ? 'primary' : 'default'),
    cardButton({ wmux_action: 'project_ai_view', projectId: session?.projectId || '', view: 'activity' }, '处理日志', activityView ? 'primary' : 'default'),
  ]);
  const overviewElements: object[] = [
    { tag: 'markdown', content: `**${projectManagerStatusMarker(session?.status)} ${status}** · 工作项 ${workItems.length} · 监督 AI ${supervisors.length} · 待决 ${waiting}` },
    ...(session?.attentionReason ? [{
      tag: 'markdown',
      content: `⚠️ **项目需要处理**\n${compactProjectCardText(session.attentionReason, 1000)}`,
    }] : session?.status === 'paused' && session.pauseReason ? [{
      tag: 'markdown',
      content: `${session.pauseAttentionRequired ? '⚠️ **项目需要处理**' : '**暂停原因**'}\n${compactProjectCardText(session.pauseReason, 1000)}`,
    }] : []),
    ...(currentGoal?.status === 'achieved' ? [{ tag: 'markdown', content: '✅ 当前主目标已经完成。请向项目 AI 提出同一项目的下一主目标；新目标建立阶段计划后再恢复执行。' }] : []),
    ...(currentSubgoals.length > 0 ? [{ tag: 'markdown', content: compactProjectCardText(`**阶段计划**\n${currentSubgoals.map((subgoal) => `${projectManagerStatusMarker(subgoal.status)} S${subgoal.order || '-'} · ${subgoal.title || subgoal.id}\n${subgoal.outcome || ''}`).join('\n')}`, 1300) }] : [{ tag: 'markdown', content: '阶段计划尚未由项目 AI 建立；当前不会启动新的监督任务。' }]),
    ...(latestReply ? [{ tag: 'markdown', content: `**项目 AI 最新回复**\n${compactProjectCardText(latestReply.summary, 900)}` }] : [{ tag: 'markdown', content: '项目 AI 暂无回复。可进入“与 AI 对话”确认进度或补充要求。' }]),
    ...(pendingQuestion ? [{ tag: 'markdown', content: `⚠️ **等待你的决策**\n${compactProjectCardText(pendingQuestion.question, 800)}${pendingQuestion.recommendedOptionId ? '\n请在飞书决策卡或桌面项目对话中选择方案。' : ''}` }] : []),
    ...(workItems.length > 0 ? [{ tag: 'markdown', content: compactProjectCardText(`**当前执行**\n${workItems.slice(-3).map((item) => `${projectManagerStatusMarker(item.status)} ${item.title || '未命名工作项'} · ${projectManagerStatusLabel(item.status)}${item.latestBlocker ? `\n阻塞：${item.latestBlocker}` : ''}`).join('\n')}`, 1400) }] : []),
    ...(supervisors.length > 0 ? [{ tag: 'markdown', content: compactProjectCardText(`**监督链**\n${supervisors.map((lane) => `${lane.label || '监督 AI'} · ${projectManagerStatusLabel(lane.status)} · 任务端 ${lane.workerSurfaceId || '恢复中'}`).join('\n')}`, 1000) }] : []),
  ];
  const chatElements: object[] = [
    { tag: 'markdown', content: '**与项目 AI 对话**\n对话只进入当前项目；已确认的目标、范围和验收细节会写回项目配置。' },
    ...(hiddenConversationCount > 0 ? [
      {
        tag: 'markdown',
        content: chatHistoryExpanded
          ? `**已展开近期对话** · 最近 ${conversation.length} 条\n飞书最多展示最近 ${FEISHU_PROJECT_RECENT_ITEM_LIMIT} 条，完整对话请在桌面端查看。`
          : `**较早对话已折叠** · ${hiddenConversationCount} 条近期对话\n当前仅显示最近一轮；完整对话请在桌面端查看。`,
      },
      ...responsiveButtonRows([cardButton({
        wmux_action: 'project_ai_view',
        projectId: session?.projectId || '',
        view: chatHistoryExpanded ? 'chat' : 'chat-expanded',
      }, chatHistoryExpanded ? '收起近期对话' : `展开近期对话（${hiddenConversationCount}）`)]),
    ] : []),
    ...(visibleConversation.length > 0 ? visibleConversation.map((event) => ({
      tag: 'markdown', content: `${event.kind === 'user-message' ? '🔵 **你**' : '🟣 **项目 AI**'} · ${new Date(Number(event.ts) || Date.now()).toLocaleString('zh-CN', { hour12: false })}\n${compactProjectCardText(event.summary, 700)}`,
    })) : [{ tag: 'markdown', content: '暂无对话。可以询问进度、确认细节、调整优先级或说明新约束。' }]),
    {
      tag: 'form', name: 'wmux_project_ai_conversation_form', elements: [
        { tag: 'input', element_id: 'project_ai_message', name: 'project_ai_message', required: true, input_type: 'multiline_text', rows: 5, max_length: 1000, label: { tag: 'plain_text', content: '发送给项目 AI' }, placeholder: { tag: 'plain_text', content: '询问进度、确认细节、调整优先级或说明新约束。' } },
        formButton('wmux_form_project_ai_message', '发送并等待项目 AI 回复', 'primary', { wmux_action: 'form_project_ai_message', projectId: session?.projectId || '' }),
      ],
    },
  ];
  const decisionElements: object[] = [
    { tag: 'markdown', content: `**项目决策与执行依据**\n项目 AI 会自行处理技术方案和原目标内重规划；飞书最多展开最近 ${FEISHU_PROJECT_RECENT_ITEM_LIMIT} 个工作项，完整记录请在桌面端查看。` },
    ...(pendingQuestion ? [{ tag: 'markdown', content: compactProjectCardText([
      '⚠️ **当前等待你的决策**', pendingQuestion.question, pendingQuestion.context || '',
      pendingQuestion.options.map((option) => `${option.id === pendingQuestion.recommendedOptionId ? '推荐：' : ''}${option.label}${option.description ? ` · ${option.description}` : ''}`).join('\n'),
    ].filter(Boolean).join('\n'), 1500) }] : [{ tag: 'markdown', content: '✅ 当前没有待你确认的项目决策。' }]),
    ...(recentWorkItems.length > FEISHU_PROJECT_COLLAPSED_ITEM_LIMIT ? [
      { tag: 'markdown', content: decisionsExpanded
        ? `**已展开近期工作项** · 最近 ${recentWorkItems.length} 项${workItems.length > recentWorkItems.length ? `\n更早 ${workItems.length - recentWorkItems.length} 项请在桌面端查看。` : ''}`
        : `**较早工作项已折叠** · 当前显示最近 ${visibleWorkItems.length}/${recentWorkItems.length} 项` },
      ...responsiveButtonRows([cardButton({
        wmux_action: 'project_ai_view', projectId: session?.projectId || '',
        view: decisionsExpanded ? 'decisions' : 'decisions-expanded',
      }, decisionsExpanded ? '收起近期工作项' : `展开近期工作项（${recentWorkItems.length}）`)]),
    ] : []),
    ...(visibleWorkItems.length > 0 ? visibleWorkItems.map((item) => ({ tag: 'markdown', content: compactProjectCardText([
      `**${item.title || '未命名工作项'} · ${projectManagerStatusLabel(item.status)}**`,
      `阶段预算：裁决 ${item.decisionsUsed || 0}/${item.contract?.budget?.maxDecisions || '-'} · 连续窗口 ${item.contract?.budget?.maxContinuousMinutes || '-'} 分钟 · 任务重试 ${item.attempts || 0}/${item.contract?.budget?.maxTaskRetries || '-'}`,
      item.latestEvidence ? `证据：${compactProjectCardText(item.latestEvidence, 350)}` : '', item.latestBlocker ? `阻塞：${compactProjectCardText(item.latestBlocker, 350)}` : '',
    ].filter(Boolean).join('\n'), 900) })) : []),
  ];
  const activityElements: object[] = [
    { tag: 'markdown', content: `**处理日志** · 当前显示 ${visibleLogs.length}/${allLogs.length} 条\n飞书默认显示最近 ${FEISHU_PROJECT_COLLAPSED_ITEM_LIMIT} 条，最多展开最近 ${FEISHU_PROJECT_RECENT_ITEM_LIMIT} 条；完整日志请在桌面端查看。` },
    ...(recentLogs.length > FEISHU_PROJECT_COLLAPSED_ITEM_LIMIT ? [
      { tag: 'markdown', content: activityExpanded
        ? `**已展开近期日志** · 最近 ${recentLogs.length} 条${allLogs.length > recentLogs.length ? `\n更早 ${allLogs.length - recentLogs.length} 条请在桌面端查看。` : ''}`
        : `**较早日志已折叠** · ${recentLogs.length - visibleLogs.length} 条近期日志` },
      ...responsiveButtonRows([cardButton({
        wmux_action: 'project_ai_view', projectId: session?.projectId || '',
        view: activityExpanded ? 'activity' : 'activity-expanded',
      }, activityExpanded ? '收起近期日志' : `展开近期日志（${recentLogs.length}）`)]),
    ] : []),
    ...(visibleLogs.length > 0 ? visibleLogs.map((event) => ({ tag: 'markdown', content: `${new Date(Number(event.ts) || Date.now()).toLocaleString('zh-CN', { hour12: false })} · **${String(event.kind || 'event')}**\n${compactProjectCardText(event.summary, 500)}` })) : [{ tag: 'markdown', content: '暂无处理日志。' }]),
  ];
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `wmux · ${String(session?.projectName || session?.goal || '项目工作台').slice(0, 40)}` }, template: pendingQuestion ? 'orange' : 'blue' },
    body: {
      elements: [
        ...(notice ? [{ tag: 'markdown', content: `${notice.success ? '✅' : '⚠️'} ${notice.text}` }] : []),
        { tag: 'markdown', content: `**${session?.projectName || '未选择项目'}**\n当前主目标：G${currentGoal?.sequence || 1} · ${session?.goal || '待设置'}${session?.projectDir ? `\n${session.projectDir}` : ''}`.slice(0, 1200) },
        ...nav,
        { tag: 'hr' },
        ...(chatView ? chatElements : decisionView ? decisionElements : activityView ? activityElements : overviewElements),
        { tag: 'hr' },
        ...responsiveButtonRows([
          cardButton({ wmux_action: 'project_ai_workspace', projectId: session?.projectId || '' }, '刷新工作台'),
          ...(session?.status === 'active' || (session?.status === 'waiting' && currentGoal?.status !== 'achieved')
            ? [cardButton({ wmux_action: 'project_ai_pause', projectId: session?.projectId || '' }, '暂停项目')]
            : []),
          ...((session?.status === 'paused' || session?.status === 'waiting') && currentGoal?.status !== 'achieved'
            ? [cardButton({ wmux_action: 'project_ai_resume', projectId: session?.projectId || '' }, '恢复项目', 'primary')]
            : []),
          cardButton({ wmux_action: 'project_ai_portfolio' }, '返回项目中心'),
        ]),
      ],
    },
  };
}

/** Form displayed after selecting “添加终端任务”. */
export function buildDirectTerminalTaskCard(terminals: FeishuListTerminal[] = []): object {
  const pathOptions = terminalPathOptions(terminals);
  const sessionOptions = terminalSessionOptions(terminals);
  return buildFormCard(
    'wmux · 添加 AI 终端任务',
    'blue',
    '创建位置与任务目录相互独立；默认新建会话，并在桌面“wmux任务”中创建任务目录。',
    'wmux_create_task_form',
    [
      { tag: 'input', element_id: 'create_task_name', name: 'task_name', required: true, max_length: 100, label: { tag: 'plain_text', content: '任务名称' }, placeholder: { tag: 'plain_text', content: '例如：修复登录页问题' } },
      { tag: 'markdown', content: '**创建位置（默认新建会话）**' },
      {
        tag: 'select_static', element_id: 'create_task_session', name: 'session_target',
        placeholder: { tag: 'plain_text', content: '新建独立会话（默认）' }, options: sessionOptions,
      },
      { tag: 'markdown', content: '**终端路径（可选）**' },
      ...(pathOptions.length > 0 ? [{
        tag: 'select_static', element_id: 'create_task_path', name: 'path_terminal',
        placeholder: { tag: 'plain_text', content: '不选择：按原规则新建任务目录' }, options: pathOptions,
      }] : [{ tag: 'markdown', content: '当前没有已保存或可复用的终端路径；将按原规则新建任务目录。' }]),
      { tag: 'markdown', content: '**AI 终端类型（默认 Codex）**' },
      { tag: 'select_static', element_id: 'create_task_agent', name: 'agent', placeholder: { tag: 'plain_text', content: 'Codex（默认）' }, options: [
        { text: { tag: 'plain_text', content: 'Codex（默认）' }, value: 'codex' },
        { text: { tag: 'plain_text', content: 'Kimi' }, value: 'kimi' },
        { text: { tag: 'plain_text', content: 'Grok' }, value: 'grok' },
      ] },
      { tag: 'input', element_id: 'create_task_content', name: 'task', required: true, input_type: 'multiline_text', rows: 6, max_length: 1000, label: { tag: 'plain_text', content: '首条任务' }, placeholder: { tag: 'plain_text', content: '填写要直接发送给 AI 终端的完整任务' } },
      formButton('wmux_form_create_task', '创建任务终端', 'primary', { wmux_action: 'form_create_task' }),
    ],
    controlHomeFooter(),
    [{ tag: 'markdown', content: '**普通终端任务**' }],
  );
}

/** Confirmation card for fixed-purpose terminals that are not project-AI runtimes. */
export function buildSpecialTerminalCard(): object {
  return buildFormCard(
    'wmux · 创建特别终端',
    'blue',
    '特别终端使用固定名称、目录和启动技能，是独立的固定用途终端，不复用普通任务终端。',
    'wmux_special_terminal_form',
    [
      { tag: 'markdown', content: `**${USER_RECORDS_TERMINAL_NAME}**\n目录：${USER_RECORDS_TERMINAL_DIRECTORY}\nAgent：Codex\n默认技能：$${USER_RECORDS_TERMINAL_SKILL_NAME}` },
      formButton(
        'wmux_form_create_user_records_terminal',
        `创建${USER_RECORDS_TERMINAL_NAME}`,
        'primary',
        { wmux_action: 'form_create_user_records_terminal' },
      ),
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
      { tag: 'input', element_id: 'start_pre', name: 'preconditions', input_type: 'multiline_text', rows: 2, max_length: 1000, label: { tag: 'plain_text', content: '已确认条件与授权（可选）' }, placeholder: { tag: 'plain_text', content: '例如：硬件已上电，允许直接运行本项目测试；变化时再更新' } },
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

/** Form displayed after selecting “发送监督信息”; targets dedicated supervisor terminals only. */
export function buildSupervisorMessageCard(terminals: FeishuListTerminal[], allowTerminalScreen = true): object {
  return buildFormCard(
    'wmux · 向 AI 监督终端（管家）发送信息',
    'blue',
    '此信息只发送给所选通道的 AI 监督终端，用于补充重点、纠正方向或调整监督方式；不会作为新任务直接发送到工作终端。',
    'wmux_send_supervisor_form',
    [
      { tag: 'markdown', content: '**AI 监督终端（管家）**' },
      { tag: 'select_static', element_id: 'send_supervisor_terminal', name: 'terminal', required: true, placeholder: { tag: 'plain_text', content: '选择 AI 监督终端（管家）' }, options: supervisorTerminalOptions(terminals) },
      { tag: 'input', element_id: 'send_supervisor_message', name: 'message', input_type: 'multiline_text', rows: 5, max_length: 1000, label: { tag: 'plain_text', content: '监督方向信息（查看终端时可留空）' }, placeholder: { tag: 'plain_text', content: '例如：优先核对当前项目进度和已有证据，再决定是否继续发布任务' } },
      {
        tag: 'column_set', flex_mode: 'none', columns: [
          ...(allowTerminalScreen ? [{ tag: 'column', width: 'weighted', weight: 1, elements: [formButton('wmux_form_supervisor_screen', '查看终端信息', 'default', { wmux_action: 'form_supervisor_screen' })] }] : []),
          { tag: 'column', width: 'weighted', weight: 1, elements: [formButton('wmux_form_send_supervisor', '发送监督信息', 'primary', { wmux_action: 'form_send_supervisor' })] },
        ],
      },
    ],
    controlHomeFooter(),
  );
}

/** Private-chat form with explicit ordinary/project isolation. */
export function buildTerminalScreenSelectCard(
  terminals: FeishuListTerminal[],
  mode: FeishuTerminalControlMode = 'ordinary',
): object {
  const projectMode = mode === 'project';
  return buildFormCard(
    projectMode ? 'wmux · 项目 AI 模式终端' : 'wmux · 普通监督终端',
    'blue',
    projectMode
      ? '选择项目 AI、专属监督 AI 或任务 AI，查看核心输出，并可直接发送内容、Esc 或 Ctrl+C。界面内容可能包含敏感信息，因此只允许白名单用户在单聊中使用。'
      : '选择普通监督模式的任务 AI 或专属监督 AI，查看核心输出并按角色发送任务或监督信息。界面内容可能包含敏感信息，因此只允许白名单用户在单聊中使用。',
    'wmux_terminal_control_select_form',
    [
      { tag: 'markdown', content: projectMode ? '**项目 AI 模式终端**' : '**普通监督模式终端**' },
      { tag: 'select_static', element_id: 'control_terminal', name: 'terminal', required: true, placeholder: { tag: 'plain_text', content: projectMode ? '选择要控制的项目终端' : '选择要控制的普通终端' }, options: projectMode ? projectTerminalOptions(terminals) : ordinaryMonitoringTerminalOptions(terminals) },
      formButton('wmux_form_terminal_control', '打开终端控制', 'primary', { wmux_action: 'form_terminal_control', terminal_mode: mode }),
    ],
    controlHomeFooter(),
  );
}

function collapsedTerminalAnswer(answer: string): string {
  if (answer.length <= FEISHU_TERMINAL_COLLAPSED_ANSWER_MAX_CHARS) return answer;
  const headLength = Math.floor((FEISHU_TERMINAL_COLLAPSED_ANSWER_MAX_CHARS - 3) * 0.6);
  return `${answer.slice(0, headLength)}\n…\n${answer.slice(-(FEISHU_TERMINAL_COLLAPSED_ANSWER_MAX_CHARS - headLength - 3))}`;
}

function buildTerminalControlCard(
  result: FeishuTerminalScreenResult,
  draft: string,
  notice: string,
  expanded: boolean,
  target: 'task' | 'supervisor' | 'project',
  sourceMode?: FeishuTerminalControlMode,
): object {
  const supervisorTarget = target === 'supervisor';
  const projectTarget = target === 'project';
  const actionStem = supervisorTarget ? 'supervisor' : projectTarget ? 'project_terminal' : 'terminal';
  const actionMode = projectTarget ? 'project' : sourceMode;
  const inputName = supervisorTarget ? 'message' : 'task';
  const capturedAt = new Date(result.capturedAt).toLocaleString('zh-CN', { hour12: false });
  const taskInputId = nextControlElementIdentity('input').elementId;
  const answer = result.answer || (result.answerPending
    ? '（回复生成中，暂未识别到正文）'
    : '（尚未识别到 Agent 回复正文）');
  const answerCanExpand = !!result.answer && result.answer.length > FEISHU_TERMINAL_COLLAPSED_ANSWER_MAX_CHARS;
  const displayedAnswer = !expanded && result.answer ? collapsedTerminalAnswer(result.answer) : answer;
  const pathSummary = result.terminal.cwd?.trim()
    ? `\n路径：${compactTerminalControlPath(result.terminal.cwd)}`
    : '';
  const projectRole = result.terminal.agentRole
    ? TERMINAL_AGENT_ROLE_LABELS[result.terminal.agentRole]
    : '项目终端';
  const runtimeSummary = projectTarget
    ? projectTerminalRuntimeText(result.terminal as FeishuListTerminal)
    : terminalActivityText(result.terminal as FeishuListTerminal);
  const coreElements = [
    {
      tag: 'markdown',
      content: result.answerPending ? '**Agent 回复（生成中）**' : '**Agent 回复**',
    },
    { tag: 'div', text: { tag: 'plain_text', content: displayedAnswer } },
    ...(answerCanExpand ? responsiveButtonRows([
      formButton(
        expanded ? `wmux_form_${actionStem}_collapse` : `wmux_form_${actionStem}_expand`,
        expanded ? '收起回复' : '展开完整回复',
        'default',
        {
          wmux_action: expanded ? `form_${actionStem}_collapse` : `form_${actionStem}_expand`,
          terminal: result.terminal.surfaceId,
          ...(projectTarget ? { terminal_mode: 'project' } : sourceMode ? { terminal_mode: sourceMode } : {}),
        },
      ),
    ]) : []),
  ];
  return buildFormCard(
    supervisorTarget ? 'wmux · AI 监督终端（管家）' : projectTarget ? 'wmux · 项目 AI 模式终端' : 'wmux · 普通监督终端',
    'blue',
    `${notice ? `${notice}\n\n` : ''}${supervisorTarget
      ? `**AI监督终端（管家） · 负责：${result.terminal.label}**`
      : projectTarget
        ? `**${result.terminal.projectName || result.terminal.projectId || '未知项目'} · ${projectRole}${result.terminal.workItemTitle ? ` · ${result.terminal.workItemTitle}` : ''}**`
        : `**${result.terminal.label}**`}\n工作区：${result.terminal.workspace}${pathSummary}\n状态：${runtimeSummary}\n抓取时间：${capturedAt} · ${result.lines} 行`,
    supervisorTarget ? 'wmux_supervisor_terminal_control_form' : projectTarget ? 'wmux_project_terminal_control_form' : 'wmux_terminal_control_form',
    [
      ...coreElements,
      { tag: 'hr' },
      {
        tag: 'input', element_id: taskInputId, name: inputName, input_type: 'multiline_text', rows: 5, max_length: 1000,
        label: { tag: 'plain_text', content: supervisorTarget ? '监督方向信息（可选）' : '发送内容（可选）' },
        placeholder: { tag: 'plain_text', content: supervisorTarget
          ? '补充重点、纠正方向或调整监督方式'
          : projectTarget
            ? '填写要直接发送给所选项目终端的内容'
            : '填写要发送给终端的完整任务' },
        ...(draft ? { default_value: draft } : {}),
      },
      {
        tag: 'column_set', flex_mode: 'none', columns: [
          { tag: 'column', width: 'weighted', weight: 1, elements: [formButton(`wmux_form_${actionStem}_refresh`, '刷新界面', 'default', { wmux_action: `form_${actionStem}_refresh`, terminal: result.terminal.surfaceId, ...(actionMode ? { terminal_mode: actionMode } : {}) })] },
          { tag: 'column', width: 'weighted', weight: 1, elements: [formButton(`wmux_form_${actionStem}_send`, supervisorTarget ? '发送监督信息' : '发送内容', 'primary', { wmux_action: `form_${actionStem}_send`, terminal: result.terminal.surfaceId, ...(actionMode ? { terminal_mode: actionMode } : {}) })] },
        ],
      },
      ...(projectTarget ? [
        { tag: 'markdown', content: '这是直接终端控制：内容和中断键会写入当前所选终端。若要调整项目整体方向、需求或优先级，请使用项目工作台与项目 AI 对话。' },
        ...(result.terminal.projectId ? responsiveButtonRows([
          formButton('wmux_form_project_terminal_workspace', '打开项目工作台', 'default', {
            wmux_action: 'project_ai_workspace',
            projectId: result.terminal.projectId,
          }),
        ]) : []),
      ] : []),
      ...(!supervisorTarget ? responsiveButtonRows([
        formButton(`wmux_form_${actionStem}_escape`, '发送 Esc（中断输出）', 'danger', { wmux_action: `form_${actionStem}_escape`, terminal: result.terminal.surfaceId, ...(actionMode ? { terminal_mode: actionMode } : {}) }),
        formButton(`wmux_form_${actionStem}_interrupt`, '发送 Ctrl+C（中断进程）', 'danger', { wmux_action: `form_${actionStem}_interrupt`, terminal: result.terminal.surfaceId, ...(actionMode ? { terminal_mode: actionMode } : {}) }),
      ]) : []),
      ...responsiveButtonRows([
        formButton(`wmux_form_${actionStem}_other`, supervisorTarget ? '选择其他监督终端' : '选择其他终端', 'default', {
          wmux_action: 'menu',
          flow: supervisorTarget
            ? sourceMode === 'ordinary' ? 'ordinary-terminal-control' : 'send-supervisor'
            : projectTarget ? 'project-terminal-control' : 'ordinary-terminal-control',
        }),
        formButton(`wmux_form_${actionStem}_home`, '返回控制首页', 'default', { wmux_action: 'menu', flow: 'status' }),
      ]),
    ],
  );
}

/** Task-terminal snapshot, refresh, and send controls share one form. */
export function buildTerminalScreenCard(result: FeishuTerminalScreenResult, draft = '', notice = '', expanded = false): object {
  return buildTerminalControlCard(result, draft, notice, expanded, 'task');
}

/** Dedicated supervisor-terminal snapshot, refresh, and message controls share one form. */
export function buildSupervisorTerminalScreenCard(
  result: FeishuTerminalScreenResult,
  draft = '',
  notice = '',
  expanded = false,
  sourceMode?: FeishuTerminalControlMode,
): object {
  return buildTerminalControlCard(result, draft, notice, expanded, 'supervisor', sourceMode);
}

/** Project-mode terminals expose the same explicit manual controls as ordinary task terminals. */
export function buildProjectTerminalScreenCard(result: FeishuTerminalScreenResult, draft = '', notice = '', expanded = false): object {
  return buildTerminalControlCard(result, draft, notice, expanded, 'project');
}

export function buildCloseTerminalSelectCard(terminals: FeishuListTerminal[]): object {
  const visibleTerminals = terminals.slice(0, 10);
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: 'wmux · 关闭任务终端' }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown', content: '选择要关闭的任务终端。下一步会展示当前状态和影响，并要求二次确认。不会删除任务目录或历史审计记录。' },
        ...visibleTerminals.flatMap((terminal, index) => [
          {
            tag: 'div',
            text: {
              tag: 'plain_text',
              content: `${terminal.label}\n工作区：${terminal.workspace}\n状态：${terminalActivityText(terminal)}`,
            },
          },
          ...responsiveButtonRows([
            cardButton({ wmux_action: 'inspect_close_terminal', terminal: terminal.surfaceId }, '查看关闭影响', 'danger'),
          ]),
          ...(index < visibleTerminals.length - 1 ? [{ tag: 'hr' }] : []),
        ]),
        ...(terminals.length > visibleTerminals.length
          ? [{ tag: 'div', text: { tag: 'plain_text', content: `另有 ${terminals.length - visibleTerminals.length} 个终端，请先关闭部分终端后刷新。` } }]
          : []),
        { tag: 'hr' },
        ...controlHomeFooter(),
      ],
    },
  };
}

export function buildCloseTerminalConfirmationCard(terminal: FeishuListTerminal): object {
  const supervised = terminal.supervised;
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: 'wmux · 确认关闭任务终端' }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown', content: `即将关闭 **${terminal.label}**\n\n工作区：${terminal.workspace}\n状态：${terminalActivityText(terminal)}${supervised ? '\n\n⚠️ 该终端正在被监督，关闭时会同时停止对应监督通道并关闭专属监督 AI 终端。' : ''}\n\n任务目录和历史审计记录不会删除。` },
        ...responsiveButtonRows([
          cardButton({ wmux_action: 'confirm_close_terminal', terminal: terminal.surfaceId }, '确认关闭', 'danger'),
          cardButton({ wmux_action: 'menu', flow: 'close-terminal' }, '取消'),
        ]),
      ],
    },
  };
}

export function buildBusyTaskConfirmationCard(
  terminal: Pick<FeishuListTerminal, 'surfaceId' | 'label' | 'workspace' | 'activityState' | 'activityUpdatedAt'>,
  confirmationId: string,
  notice?: string,
  mode?: 'project',
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
              ...(mode ? { terminal_mode: mode } : {}),
            }, '仍然发送', 'danger')] },
            { tag: 'column', width: 'auto', elements: [cardButton({ wmux_action: 'menu', flow: mode === 'project' ? 'project-terminal-control' : 'send' }, '取消并返回')] },
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
      { tag: 'select_static', element_id: 'lane_terminal', name: 'terminal', required: true, placeholder: { tag: 'plain_text', content: '选择要控制的监督' }, options: supervisorTerminalOptions(terminals) },
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
          { tag: 'markdown', content: `**AI监督终端（管家） · 负责：${terminal.label}**\n监督状态：${laneStatus} · 任务终端：**${terminalActivityText(terminal)}**` },
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

function supervisionStatusText(result: Pick<FeishuListResult, 'active' | 'paused'>): string {
  if (result.active) return '进行中';
  if (result.paused) return '已暂停（上下文已保留）';
  return '未启动';
}

function terminalSupervisionStatusText(terminal: FeishuListTerminal, sessionPaused: boolean): string {
  if (terminal.supervisionState === 'active') return sessionPaused ? '随会话暂停' : '监督中';
  if (terminal.supervisionState === 'paused') return '单通道已暂停';
  if (terminal.supervisionState === 'stopped' || terminal.restartable) return '已停止，可重新监督';
  return terminal.supervised ? '监督中' : '未监督';
}

function cardAuditValue(key: string, value: unknown, maxLength: number): string {
  return auditValue(key, value).slice(0, maxLength);
}

/** Detailed, read-only status view kept separate from the compact control homepage. */
export function buildSupervisorStatusCard(result: FeishuListResult): object {
  const supervised = result.terminals.filter((terminal) => (
    terminal.supervised || terminal.restartable || terminal.supervisionState && terminal.supervisionState !== 'none'
  ));
  const visibleSupervised = supervised.slice(0, 10);
  const sessionLines = [
    `会话状态：${supervisionStatusText(result)}`,
    `监督通道：${supervised.filter((terminal) => ['active', 'paused'].includes(terminal.supervisionState || '')).length} 个`,
    `待人工审批：${result.pendingApprovals.length} 项`,
  ];
  if (result.session) {
    sessionLines.push(`会话 ID：${cardAuditValue('sessionId', result.session.sessionId, 100)}`);
    sessionLines.push(`监督模式：${result.session.autonomous ? '全自动（高风险仍需人工）' : '有限自主'}`);
    sessionLines.push(`停止条件：${cardAuditValue('stopWhen', result.session.stopWhen, 300)}`);
  }
  const laneElements = visibleSupervised.length > 0
    ? visibleSupervised.map((terminal) => ({
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: `AI监督终端（管家） · 负责：${cardAuditValue('terminalLabel', terminal.label, 100)}\n监督状态：${terminalSupervisionStatusText(terminal, result.paused)}\n任务终端：${terminalActivityText(terminal)}\n工作区：${cardAuditValue('workspace', terminal.workspace, 200)}`,
        },
      }))
    : [{ tag: 'div', text: { tag: 'plain_text', content: '当前没有 AI 监督通道。' } }];
  const approvalElements = result.pendingApprovals.length > 0
    ? result.pendingApprovals.slice(0, 5).map((approval) => ({
        tag: 'div',
        text: { tag: 'plain_text', content: `${cardAuditValue('terminalLabel', approval.terminal, 100)}：${cardAuditValue('reason', approval.reason, 300)}` },
      }))
    : [];
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'wmux · AI 监督状态' }, template: result.paused ? 'orange' : result.active ? 'blue' : 'grey' },
    body: {
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: sessionLines.join('\n') } },
        { tag: 'hr' },
        { tag: 'markdown', content: '**监督通道**' },
        ...laneElements,
        ...(supervised.length > visibleSupervised.length ? [{
          tag: 'div', text: { tag: 'plain_text', content: `另有 ${supervised.length - visibleSupervised.length} 个监督通道，请在桌面端查看。` },
        }] : []),
        ...(approvalElements.length > 0 ? [
          { tag: 'hr' },
          { tag: 'markdown', content: '**待人工审批**' },
          ...approvalElements,
        ] : []),
        { tag: 'hr' },
        ...responsiveButtonRows([
          cardButton({ wmux_action: 'menu', flow: 'detail-status' }, '刷新监督状态', 'primary'),
          cardButton({ wmux_action: 'menu', flow: 'logs' }, '查看监督日志'),
          cardButton({ wmux_action: 'menu', flow: 'status' }, '返回控制首页'),
        ]),
      ],
    },
  };
}

function formatSupervisorLogTime(ts: number): string {
  if (!Number.isFinite(ts)) return '未知时间';
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Recent in-memory supervision activity, intentionally capped for Feishu cards. */
export function buildSupervisorLogCard(result: FeishuSupervisorLogResult): object {
  const sessionStatus = supervisionStatusText(result);
  const entries = result.entries.slice(0, 12);
  const logElements = entries.length > 0
    ? entries.map((entry) => ({
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: `${formatSupervisorLogTime(entry.ts)} · ${cardAuditValue('laneLabel', entry.laneLabel, 100)} · ${cardAuditValue('action', entry.action, 100)}\n${cardAuditValue('detail', entry.detail, 400)}`,
        },
      }))
    : [{ tag: 'div', text: { tag: 'plain_text', content: '暂无 AI 监督日志。启动监督或执行控制操作后会在这里显示。' } }];
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'wmux · AI 监督日志' }, template: 'grey' },
    body: {
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: `会话状态：${sessionStatus}\n会话 ID：${cardAuditValue('sessionId', result.sessionId || '暂无', 100)}\n最近记录：${entries.length} 条` } },
        { tag: 'hr' },
        ...logElements,
        { tag: 'hr' },
        ...responsiveButtonRows([
          cardButton({ wmux_action: 'menu', flow: 'logs' }, '刷新监督日志', 'primary'),
          cardButton({ wmux_action: 'menu', flow: 'detail-status' }, '查看监督状态'),
          cardButton({ wmux_action: 'menu', flow: 'status' }, '返回控制首页'),
        ]),
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
    supervisedTerminals: list.terminals.filter((terminal) => terminal.supervised).length,
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
        workspaceId: typeof terminal.workspaceId === 'string' && terminal.workspaceId.trim()
          ? terminal.workspaceId.trim()
          : undefined,
        workspace: asText(terminal.workspace),
        cwd: typeof terminal.cwd === 'string' && terminal.cwd.trim() ? terminal.cwd.trim() : undefined,
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
        terminalMode: ['ordinary', 'project'].includes(String(terminal.terminalMode))
          ? terminal.terminalMode as FeishuTerminalControlMode
          : 'ordinary',
        agentRole: ['project-ai', 'supervisor-ai', 'task-ai'].includes(String(terminal.agentRole))
          ? terminal.agentRole as FeishuTerminalAgentRole
          : undefined,
        projectId: typeof terminal.projectId === 'string' ? terminal.projectId : undefined,
        projectName: typeof terminal.projectName === 'string' ? terminal.projectName : undefined,
        workItemId: typeof terminal.workItemId === 'string' ? terminal.workItemId : undefined,
        workItemTitle: typeof terminal.workItemTitle === 'string' ? terminal.workItemTitle : undefined,
        runtimeState: ['starting', 'ready', 'failed', 'exited'].includes(String(terminal.runtimeState))
          ? terminal.runtimeState as FeishuListTerminal['runtimeState']
          : undefined,
        runtimeDetail: typeof terminal.runtimeDetail === 'string' ? terminal.runtimeDetail : undefined,
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

function parseTerminalScreenResult(value: unknown): FeishuTerminalScreenResult | null {
  if (!isObject(value) || value.ok === false || !isObject(value.terminal)) return null;
  const terminal = value.terminal;
  if (
    typeof terminal.surfaceId !== 'string'
    || typeof value.text !== 'string'
    || typeof value.lines !== 'number'
    || !Number.isFinite(value.lines)
    || typeof value.capturedAt !== 'number'
    || !Number.isFinite(value.capturedAt)
  ) return null;
  return {
    terminal: {
      surfaceId: terminal.surfaceId,
      label: asText(terminal.label),
      workspace: asText(terminal.workspace),
      cwd: typeof terminal.cwd === 'string' && terminal.cwd.trim() ? terminal.cwd.trim() : undefined,
      activityState: ['idle', 'working', 'blocked', 'unknown'].includes(String(terminal.activityState))
        ? terminal.activityState as FeishuTerminalActivityState
        : 'unknown',
      activityUpdatedAt: typeof terminal.activityUpdatedAt === 'number' && Number.isFinite(terminal.activityUpdatedAt)
        ? terminal.activityUpdatedAt
        : undefined,
      terminalMode: ['ordinary', 'project'].includes(String(terminal.terminalMode))
        ? terminal.terminalMode as FeishuTerminalControlMode
        : 'ordinary',
      agentRole: ['project-ai', 'supervisor-ai', 'task-ai'].includes(String(terminal.agentRole))
        ? terminal.agentRole as FeishuTerminalAgentRole
        : undefined,
      projectId: typeof terminal.projectId === 'string' ? terminal.projectId : undefined,
      projectName: typeof terminal.projectName === 'string' ? terminal.projectName : undefined,
      workItemId: typeof terminal.workItemId === 'string' ? terminal.workItemId : undefined,
      workItemTitle: typeof terminal.workItemTitle === 'string' ? terminal.workItemTitle : undefined,
      runtimeState: ['starting', 'ready', 'failed', 'exited'].includes(String(terminal.runtimeState))
        ? terminal.runtimeState as FeishuListTerminal['runtimeState']
        : undefined,
      runtimeDetail: typeof terminal.runtimeDetail === 'string' ? terminal.runtimeDetail : undefined,
    },
    text: value.text.slice(0, 1_200),
    question: typeof value.question === 'string' && value.question.trim()
      ? value.question.slice(0, FEISHU_TERMINAL_QUESTION_MAX_CHARS)
      : undefined,
    answer: typeof value.answer === 'string' && value.answer.trim()
      ? value.answer.slice(0, FEISHU_TERMINAL_ANSWER_MAX_CHARS)
      : undefined,
    answerPending: value.answerPending === true,
    lines: Math.max(0, Math.floor(value.lines)),
    capturedAt: value.capturedAt,
  };
}

function parseSupervisorLogResult(value: unknown): FeishuSupervisorLogResult | null {
  if (!isObject(value) || typeof value.message !== 'string') return null;
  try {
    const parsed = JSON.parse(value.message) as unknown;
    if (!isObject(parsed) || !Array.isArray(parsed.entries)) return null;
    const entries = parsed.entries.flatMap((entry): FeishuSupervisorLogEntry[] => {
      if (!isObject(entry) || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) return [];
      return [{
        ts: entry.ts,
        laneLabel: asText(entry.laneLabel, '会话'),
        action: asText(entry.action, '状态更新'),
        detail: asText(entry.detail),
      }];
    });
    return {
      active: parsed.active === true,
      paused: parsed.paused === true,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
      entries,
    };
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
  'worker.blocked': '工作终端等待处理',
  'supervisor.delivery.queued': '监督信息待投递',
  'supervisor.delivery.delivered': '监督信息已投递',
  'supervisor.delivery.failed': '监督信息投递失败',
  'supervisor.decision': 'AI 监督裁决',
  'supervisor.permission-approved': 'AI 监督自动授权',
  'supervisor.auto-approved': 'AI 监督自动批准',
  'supervisor.approval.requested': 'AI 监督等待人工决策',
  'supervisor.proposal.resolved': 'AI 监督人工决策已处理',
  'supervisor.auto-decision-limit.resolved': 'AI 监督人工复核完成',
  'supervisor.waiting-for-direction': 'AI 监督通道待续',
  'supervisor.waiting-resumed': 'AI 监督待续已恢复',
  'supervisor.provider-limit': 'AI 监督模型请求受限',
  'supervisor.review.watchdog-failed': 'AI 监督裁决看门狗暂停通道',
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

export type FeishuAuditTaskState =
  | 'waiting'
  | 'working'
  | 'reviewing'
  | 'blocked'
  | 'awaiting-human'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'stopped';

export interface FeishuAuditTerminalStatus {
  sessionId: string;
  surfaceId: string;
  terminalLabel: string;
  workspaceTitle?: string;
  taskState: FeishuAuditTaskState;
  supervisionState: '监督中' | '已暂停' | '已停止';
  currentTask: string;
  latestResult: string;
  nextStep: string;
  pendingHuman: string;
  decisionRequest?: string;
  decisionReason?: string;
  updatedAt: number;
}

const AUDIT_TASK_STATE_TEXT: Record<FeishuAuditTaskState, string> = {
  waiting: '等待任务',
  working: '执行中',
  reviewing: '等待监督裁决',
  blocked: '终端阻塞',
  'awaiting-human': '等待人工处理',
  completed: '任务已完成',
  failed: '执行异常',
  paused: '监督已暂停',
  stopped: '监督已停止',
};

function auditPayloadText(record: SupervisorRecord, key: string, fallback = ''): string {
  const value = record.payload?.[key];
  if (value === undefined || value === null || value === '') return fallback;
  return auditValue(key, value);
}

function initialFeishuAuditTerminalStatus(record: SupervisorRecord): FeishuAuditTerminalStatus {
  return {
    sessionId: record.sessionId,
    surfaceId: record.terminal.surfaceId,
    terminalLabel: auditValue('terminal', record.terminal.label),
    workspaceTitle: record.terminal.workspaceTitle
      ? auditValue('workspace', record.terminal.workspaceTitle)
      : undefined,
    taskState: 'waiting',
    supervisionState: '监督中',
    currentTask: '尚未收到任务',
    latestResult: '监督状态已建立',
    nextStep: '等待任务终端上报',
    pendingHuman: '无',
    updatedAt: record.ts ?? Date.now(),
  };
}

/** Collapse the durable event stream into one human-readable current terminal state. */
export function reduceFeishuAuditTerminalStatus(
  previous: FeishuAuditTerminalStatus | undefined,
  record: SupervisorRecord,
): FeishuAuditTerminalStatus {
  const reset = !previous || previous.sessionId !== record.sessionId;
  const next: FeishuAuditTerminalStatus = {
    ...(reset ? initialFeishuAuditTerminalStatus(record) : previous),
    sessionId: record.sessionId,
    surfaceId: record.terminal.surfaceId,
    terminalLabel: auditValue('terminal', record.terminal.label),
    workspaceTitle: record.terminal.workspaceTitle
      ? auditValue('workspace', record.terminal.workspaceTitle)
      : reset ? undefined : previous?.workspaceTitle,
    updatedAt: record.ts ?? Date.now(),
  };
  const event = auditPayloadText(record, 'event', '未知');
  const task = auditPayloadText(record, 'task');
  const reason = auditPayloadText(record, 'reason');
  const action = auditPayloadText(record, 'action');

  if (record.type === 'session.started') {
    return { ...next, taskState: 'waiting', supervisionState: '监督中', latestResult: 'AI 监督已启动', nextStep: '等待工作终端接收任务', pendingHuman: '无' };
  }
  if (record.type === 'session.abandoned') {
    return { ...next, taskState: 'stopped', supervisionState: '已停止', latestResult: reason || '原监督上下文已结束', nextStep: '需要时重新启动监督', pendingHuman: '无' };
  }
  if (record.type === 'worker.task') {
    return { ...next, taskState: 'working', supervisionState: '监督中', currentTask: task || next.currentTask, latestResult: '任务已提交到工作终端', nextStep: '等待终端完成本轮任务', pendingHuman: '无' };
  }
  if (record.type === 'worker.blocked') {
    return { ...next, taskState: 'blocked', latestResult: reason || '终端正在等待输入或权限处理', nextStep: '等待监督 AI 核对；需要用户决定时会私发通知', pendingHuman: '尚未确认是否需要人工' };
  }
  if (record.type === 'worker.lifecycle') {
    if (event === 'StopFailure') return { ...next, taskState: 'failed', latestResult: auditPayloadText(record, 'message', '本轮任务执行失败'), nextStep: '等待监督 AI 分析并给出返工方案' };
    if (event === 'Interrupt') return { ...next, taskState: 'failed', latestResult: '本轮任务已中断', nextStep: '等待监督 AI 判断是否继续' };
    if (event === 'Stop') return { ...next, taskState: 'reviewing', latestResult: '工作终端已结束本轮任务', nextStep: '等待监督 AI 读取证据并裁决' };
    return { ...next, latestResult: `终端状态更新：${event}` };
  }
  if (record.type === 'supervisor.delivery.queued' || record.type === 'supervisor.delivery.delivered') {
    const deliveryKind = auditPayloadText(record, 'kind');
    const delivery = deliveryKind === 'task-start' ? '任务开始' : deliveryKind === 'task-end' ? '任务结束' : deliveryKind === 'task-interrupted' ? '任务中断' : '状态更新';
    const deliveryState = record.type === 'supervisor.delivery.queued' ? '等待通知监督 AI' : '已通知监督 AI';
    return { ...next, latestResult: `${deliveryState}：${delivery}` };
  }
  if (record.type === 'supervisor.delivery.failed') {
    return { ...next, taskState: 'failed', latestResult: auditPayloadText(record, 'error', '监督信息发送失败'), nextStep: '等待自动重试或人工检查终端连接' };
  }
  if (record.type === 'supervisor.provider-limit') {
    return {
      ...next,
      taskState: 'blocked',
      latestResult: `AI 监督模型请求受限：${auditPayloadText(record, 'summary', '服务返回限流或额度错误')}`,
      nextStep: '请检查模型额度或稍后重试；任务终端不会自动接收新的监督指令',
      pendingHuman: '需要用户处理模型额度或等待限流解除',
    };
  }
  if (record.type === 'supervisor.review.watchdog-failed') {
    const detail = auditPayloadText(record, 'reason', 'AI 监督连续两次未提交结构化裁决');
    return {
      ...next,
      taskState: 'failed',
      latestResult: detail,
      nextStep: '请在 wmux 中重新唤醒或重建该监督 AI；任务终端不会继续收到自动指令',
      pendingHuman: '需要用户恢复或重建监督运行时',
    };
  }
  if (record.type === 'supervisor.decision') {
    const outcome = auditPayloadText(record, 'outcome');
    const decisionNext = auditPayloadText(record, 'next');
    if (record.payload?.requiresHuman === true) {
      const result = outcome === 'complete'
        ? '监督 AI 认为任务已完成，等待人工复核'
        : '监督 AI 已给出下一步，但自动判断次数已达上限';
      return { ...next, taskState: 'awaiting-human', latestResult: result, nextStep: '请白名单用户检查终端结果', pendingHuman: '待复核；详细内容不在群内展示' };
    }
    if (outcome === 'complete') return { ...next, taskState: 'completed', latestResult: reason || '监督 AI 判定任务已完成', nextStep: '无需继续执行', pendingHuman: '无' };
    if (outcome === 'needs-human') return { ...next, taskState: 'awaiting-human', latestResult: '监督 AI 请求人工决策', nextStep: '等待白名单用户处理私聊决策卡', pendingHuman: '详细决策内容已私发白名单用户' };
    if (outcome === 'rework') return { ...next, taskState: 'working', latestResult: reason || '监督 AI 要求返工', nextStep: decisionNext || '等待工作终端返工', pendingHuman: '无' };
    if (outcome === 'continue') return { ...next, taskState: 'working', latestResult: reason || '监督 AI 决定继续推进', nextStep: decisionNext || '等待工作终端继续', pendingHuman: '无' };
  }
  if (record.type === 'supervisor.approval.requested') {
    const taskGoal = auditPayloadText(record, 'taskGoal');
    const decisionRequest = auditPayloadText(record, 'reason', '需要用户确认当前任务的处理方向');
    const decisionReason = auditPayloadText(
      record,
      'impact',
      '该事项涉及用户偏好、现场信息或专属授权，AI 无法代替用户确认',
    );
    return {
      ...next,
      taskState: 'awaiting-human',
      currentTask: taskGoal || next.currentTask,
      latestResult: '当前任务需要人工决策',
      nextStep: '请白名单用户在机器人单聊中查看方案并处理',
      pendingHuman: '方案选择、AI 推荐和决策操作仅在机器人单聊中提供',
      decisionRequest,
      decisionReason,
    };
  }
  if (record.type === 'supervisor.waiting-for-direction') {
    const taskGoal = auditPayloadText(record, 'taskGoal');
    return {
      ...next,
      taskState: 'awaiting-human',
      supervisionState: '监督中',
      currentTask: taskGoal || next.currentTask,
      latestResult: reason || '当前阶段已完成，监督通道进入待续',
      nextStep: '请白名单用户向对应 AI 监督终端说明新方案或下一步方向',
      pendingHuman: '等待用户提供新的监督方向后继续',
    };
  }
  if (record.type === 'supervisor.waiting-resumed') {
    return {
      ...next,
      taskState: 'reviewing',
      supervisionState: '监督中',
      latestResult: '用户已提供新的监督方向，待续状态已解除',
      nextStep: '监督 AI 正在处理新方向并继续推进',
      pendingHuman: '无',
    };
  }
  if (record.type === 'supervisor.remote-decision') {
    const decision = auditPayloadText(record, 'decision');
    if (decision === 'pause') return { ...next, taskState: 'paused', supervisionState: '已暂停', latestResult: '人工已暂停当前监督', nextStep: '等待继续监督' };
    if (decision === 'stop') return { ...next, taskState: 'stopped', supervisionState: '已停止', latestResult: '人工已停止当前监督', nextStep: '需要时重新启动监督', pendingHuman: '无', decisionRequest: undefined, decisionReason: undefined };
    if (decision === 'direct') return { ...next, taskState: 'working', latestResult: '用户决策已直接发送到任务终端', nextStep: '等待任务终端执行，AI 监督将继续观察', pendingHuman: '无', decisionRequest: undefined, decisionReason: undefined };
    return { ...next, taskState: 'working', latestResult: '人工决策已处理', nextStep: '监督 AI 将依据处理结果继续', pendingHuman: '无', decisionRequest: undefined, decisionReason: undefined };
  }
  if (record.type === 'supervisor.proposal.resolved') {
    return { ...next, taskState: 'working', latestResult: '人工决策已处理', nextStep: '监督 AI 将依据处理结果继续', pendingHuman: '无', decisionRequest: undefined, decisionReason: undefined };
  }
  if (record.type === 'supervisor.permission-approved') {
    return { ...next, taskState: 'working', latestResult: '低风险权限请求已由监督 AI 确认', nextStep: '等待工作终端继续执行', pendingHuman: '无' };
  }
  if (record.type === 'supervisor.auto-approved') {
    return { ...next, taskState: 'working', latestResult: reason || '低风险下一步已自动批准', nextStep: auditPayloadText(record, 'next', '等待工作终端继续执行'), pendingHuman: '无' };
  }
  if (record.type === 'supervisor.auto-decision-limit.resolved') {
    return { ...next, taskState: 'reviewing', latestResult: '人工复核已完成', nextStep: '监督 AI 可以继续裁决', pendingHuman: '无' };
  }
  if (record.type === 'supervisor.remote-command' || record.type === 'supervisor.lane-control') {
    if (action === 'pause' || action === 'pause-lane') return { ...next, taskState: 'paused', supervisionState: '已暂停', latestResult: '监督已暂停，现有上下文保留', nextStep: '等待继续监督' };
    if (action === 'stop' || action === 'stop-lane') return { ...next, taskState: 'stopped', supervisionState: '已停止', latestResult: '监督已停止', nextStep: '需要时重新启动监督', pendingHuman: '无' };
    if (action === 'resume' || action === 'resume-lane') return { ...next, supervisionState: '监督中', taskState: next.taskState === 'paused' ? 'reviewing' : next.taskState, latestResult: '监督已继续', nextStep: '监督 AI 正在读取最新终端状态' };
    if (action === 'send-task') return { ...next, taskState: 'working', currentTask: task || next.currentTask, latestResult: '已通过飞书向终端发送任务', nextStep: '等待终端执行', pendingHuman: '无' };
    if (action === 'start' || action === 'restart' || action === 'add') return { ...next, supervisionState: '监督中', latestResult: '飞书已启动或更新监督', nextStep: '等待监督 AI 读取终端状态' };
  }
  return next;
}

function statusCardTemplate(state: FeishuAuditTaskState): 'blue' | 'orange' | 'green' | 'red' | 'grey' {
  if (state === 'completed') return 'green';
  if (state === 'failed') return 'red';
  if (state === 'blocked' || state === 'awaiting-human' || state === 'paused' || state === 'reviewing') return 'orange';
  if (state === 'stopped') return 'grey';
  return 'blue';
}

function auditPlainTextBlock(title: string, content: string): object {
  return {
    tag: 'div',
    text: { tag: 'plain_text', content: `${title}\n${content || '无'}`.slice(0, 1000) },
  };
}

function auditStatusDetailBlocks(status: FeishuAuditTerminalStatus): object[] {
  const hasDecisionContext = status.taskState === 'awaiting-human'
    && !!(status.decisionRequest || status.decisionReason);
  return [
    auditPlainTextBlock(hasDecisionContext ? '当前任务目标' : '当前任务', status.currentTask),
    ...(hasDecisionContext && status.decisionRequest
      ? [auditPlainTextBlock('需要用户决定', status.decisionRequest)]
      : []),
    ...(hasDecisionContext && status.decisionReason
      ? [auditPlainTextBlock('为什么需要决定', status.decisionReason)]
      : []),
    auditPlainTextBlock('最近情况', status.latestResult),
    auditPlainTextBlock('下一步', status.nextStep),
    ...(status.pendingHuman !== '无' ? [auditPlainTextBlock('待人工事项', status.pendingHuman)] : []),
  ];
}

/** Build the single reusable group card representing one terminal's latest state. */
export function buildFeishuAuditStatusCard(status: FeishuAuditTerminalStatus): object {
  const location = status.workspaceTitle ? `${status.terminalLabel} · ${status.workspaceTitle}` : status.terminalLabel;
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `当前状态 · ${location}`.slice(0, 100) }, template: statusCardTemplate(status.taskState) },
    body: {
      elements: [
        { tag: 'markdown', content: `**任务状态：${AUDIT_TASK_STATE_TEXT[status.taskState]}**  ·  监督状态：${status.supervisionState}` },
        ...auditStatusDetailBlocks(status),
        { tag: 'div', text: { tag: 'plain_text', content: `更新时间：${new Date(status.updatedAt).toLocaleString('zh-CN', { hour12: false })}`, text_size: 'notation', text_color: 'grey' } },
      ],
    },
  };
}

/** Important state changes get a new group alert in addition to updating the status card. */
export function buildFeishuAuditAlertCard(
  record: SupervisorRecord,
  status: FeishuAuditTerminalStatus,
): object | null {
  let title = '';
  let template: 'orange' | 'green' | 'red' = 'orange';
  if (record.type === 'worker.blocked') title = '终端任务已阻塞';
  else if (record.type === 'worker.lifecycle' && auditPayloadText(record, 'event') === 'StopFailure') {
    title = '终端任务执行失败'; template = 'red';
  } else if (record.type === 'worker.lifecycle' && auditPayloadText(record, 'event') === 'Interrupt') title = '终端任务已中断';
  else if (record.type === 'supervisor.delivery.failed') {
    title = '监督信息发送失败'; template = 'red';
  } else if (record.type === 'supervisor.provider-limit') {
    title = 'AI 监督模型请求受限'; template = 'red';
  } else if (record.type === 'supervisor.review.watchdog-failed') {
    title = 'AI 监督未提交裁决，通道已暂停'; template = 'red';
  } else if (record.type === 'supervisor.approval.requested') title = '任务等待人工决策';
  else if (record.type === 'supervisor.waiting-for-direction') title = 'AI 监督通道待续';
  else if (record.type === 'supervisor.decision' && record.payload?.requiresHuman === true) title = '任务等待人工复核';
  else if (record.type === 'supervisor.decision'
    && auditPayloadText(record, 'outcome') === 'complete'
    && record.payload?.requiresHuman !== true) {
    title = '终端任务已完成'; template = 'green';
  }
  if (!title) return null;
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: title }, template },
    body: {
      elements: [
        auditPlainTextBlock('终端状态', `${status.terminalLabel} · ${AUDIT_TASK_STATE_TEXT[status.taskState]}`),
        ...auditStatusDetailBlocks(status),
      ],
    },
  };
}

/** Format a durable supervisor event for its redacted Feishu destination. */
export function formatFeishuSupervisorAuditEvent(record: SupervisorRecord): string {
  const title = AUDIT_EVENT_TITLES[record.type] || `AI 监督事件：${record.type}`;
  const details = Object.entries(record.payload || {})
    .map(([key, value]) => `${key}：${auditValue(key, value)}`)
    .slice(0, 12);
  return [title, `终端：${auditValue('terminal', record.terminal.label)}`, ...(details.length > 0 ? ['详情：', ...details] : [])].join('\n');
}

function decisionOptions(
  alternatives: string | undefined,
  recommendation: string,
): Array<{ text: { tag: 'plain_text'; content: string }; value: string }> {
  return supervisorDecisionOptions(alternatives, recommendation).map((option) => ({
    text: { tag: 'plain_text', content: `${option.title}：${option.detail}`.slice(0, 100) },
    value: option.value,
  }));
}

/** JSON 2.0 is required for form inputs; legacy cards silently drop these controls. */
export function buildApprovalCard(record: SupervisorRecord, feedback: ApprovalCardFeedback = {}): object {
  const payload = record.payload || {};
  const reason = String(payload.reason || '需要人工决策').slice(0, 800);
  const impact = String(payload.impact || '未提供').slice(0, 500);
  const rawAlternatives = String(payload.alternatives || '').slice(0, 500);
  const alternatives = rawAlternatives || '未提供';
  const recommendation = String(payload.recommendation || '未提供').slice(0, 1200);
  const isContextRecovery = payload.proposalKind === 'context-recovery';
  const rawTerminalScreen = String(payload.terminalScreen || '');
  const terminalScreenMaxLength = 1200;
  const terminalScreenSeparator = '\n…\n';
  const terminalScreenHeadLength = Math.floor((terminalScreenMaxLength - terminalScreenSeparator.length) * 0.6);
  const terminalScreen = rawTerminalScreen.length > terminalScreenMaxLength
    ? `${rawTerminalScreen.slice(0, terminalScreenHeadLength)}${terminalScreenSeparator}${rawTerminalScreen.slice(-(
      terminalScreenMaxLength - terminalScreenHeadLength - terminalScreenSeparator.length
    ))}`
    : rawTerminalScreen;
  const decisionChoices = isContextRecovery ? [] : decisionOptions(rawAlternatives, recommendation);
  const hasMultipleChoices = decisionChoices.length >= 2;
  const choices = hasMultipleChoices ? [{
    text: { tag: 'plain_text' as const, content: '无' },
    value: SUPERVISOR_NO_DECISION_OPTION,
    selected: true,
  }, ...decisionChoices] : decisionChoices;
  const formElements: object[] = [
    ...(feedback.error ? [{
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: `未提交：${feedback.error.slice(0, 500)} 请修改后再次点击处理按钮。`,
      },
    }] : []),
    { tag: 'markdown', content: isContextRecovery ? '**AI 监督拟定的任务恢复指令**' : '**AI 建议**' },
    { tag: 'div', text: { tag: 'plain_text', content: recommendation } },
    { tag: 'markdown', content: '**任务终端核心信息**' },
    { tag: 'div', text: { tag: 'plain_text', content: terminalScreen || '（暂未识别到任务终端的 Agent 核心信息）' } },
    ...(hasMultipleChoices ? [{
      tag: 'markdown', content: '**选择 AI 方案（也可选择“无”）**',
    }, {
      tag: 'select_static', element_id: 'decision_choice', name: 'decision_choice',
      placeholder: { tag: 'plain_text', content: '请选择一个 AI 方案' }, options: choices,
    }] : []),
    { tag: 'div', text: { tag: 'plain_text', content: isContextRecovery
      ? '确认后将把上述原文直接发送到任务终端；确认前不会改动任务终端。'
      : hasMultipleChoices
        ? '选择具体方案时，AI 监督会结合当前终端信息整理为完整指令；选择“无”时，请在下方填写用户决策或补充信息。'
        : '采用后，AI 监督会结合当前终端信息整理为完整指令，再发送到任务终端。' } },
    ...(!isContextRecovery ? [{
      tag: 'input', element_id: 'decision_input', name: 'decision_input', input_type: 'multiline_text',
      rows: 4, max_length: 1000,
      label: { tag: 'plain_text', content: '用户决策或补充信息（可选）' },
      placeholder: { tag: 'plain_text', content: '填写后可交给 AI 监督整理，或直接发送到任务终端' },
      ...(feedback.decisionInput ? { default_value: feedback.decisionInput.slice(0, 1000) } : {}),
    }, {
      tag: 'div', text: { tag: 'plain_text', content: '点击“采用 AI 方案”会把所选方案和这里的信息交给 AI 监督整理；选择“无”时必须填写这里的信息。点击“直接发送用户输入”则不经过 AI 监督整理，直接提交到任务终端。' },
    }] : []),
    { tag: 'markdown', content: '**处理当前决策**' },
    {
      tag: 'column_set', flex_mode: 'none', columns: [
        { tag: 'column', width: 'auto', elements: [formButton('wmux_decide_approve', isContextRecovery ? '确认并发送到任务终端' : hasMultipleChoices ? '确认并采用 AI 方案' : '采用 AI 当前方案', 'primary', { wmux_action: 'decide', approval_id: String(payload.approvalId || ''), decision: 'approve' })] },
        ...(!isContextRecovery ? [{ tag: 'column', width: 'auto', elements: [formButton('wmux_decide_direct', '直接发送用户输入', 'default', { wmux_action: 'decide', approval_id: String(payload.approvalId || ''), decision: 'direct' })] }] : []),
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
    isContextRecovery
      ? `**终端**：${record.terminal.label}\n**原因**：${reason}`
      : `**终端**：${record.terminal.label}\n**原因**：${reason}\n**影响**：${impact}\n**备选**：${alternatives}`,
    'wmux_decision_form',
    formElements,
  );
}

export function buildWaitingDecisionCard(record: SupervisorRecord, supervisorAnswer = ''): object {
  const payload = record.payload || {};
  const reason = String(payload.reason || '当前阶段已完成，等待你的下一步方向').slice(0, 800);
  const taskGoal = String(payload.taskGoal || '未提供').slice(0, 500);
  const stopWhen = String(payload.stopWhen || '未提供').slice(0, 500);
  const answerMaxLength = FEISHU_TERMINAL_COLLAPSED_ANSWER_MAX_CHARS;
  const separator = '\n…（核心信息已截断）…\n';
  const headLength = Math.floor((answerMaxLength - separator.length) * 0.65);
  const answer = supervisorAnswer.length > answerMaxLength
    ? `${supervisorAnswer.slice(0, headLength)}${separator}${supervisorAnswer.slice(-(
      answerMaxLength - headLength - separator.length
    ))}`
    : supervisorAnswer;
  const actionValue = { wmux_action: 'waiting_decision', terminal: record.terminal.surfaceId };
  return buildFormCard(
    'wmux AI 监督：通道待续',
    'orange',
    `**AI 监督终端（管家）**：负责 ${record.terminal.label}\n**状态**：${reason}\n**原任务目标**：${taskGoal}\n**停止条件**：${stopWhen}`,
    'wmux_waiting_decision_form',
    [
      { tag: 'markdown', content: '**AI 监督终端核心信息**' },
      { tag: 'div', text: { tag: 'plain_text', content: answer || '（暂未识别到 AI 监督终端的 Agent 核心信息）' } },
      {
        tag: 'input', element_id: 'waiting_direction', name: 'waiting_direction', input_type: 'multiline_text',
        rows: 4, max_length: 1000,
        label: { tag: 'plain_text', content: '新方案或下一步方向（提交新方案时必填）' },
        placeholder: { tag: 'plain_text', content: '填写后点击“提交新方案并继续”，内容将发送给 AI 监督终端' },
      },
      { tag: 'markdown', content: '**处理当前待续状态**' },
      ...responsiveButtonRows([
        formButton('wmux_waiting_keep', '保持待续', 'default', { ...actionValue, decision: 'keep' }),
        formButton('wmux_waiting_resume', '按原目标继续监督', 'default', { ...actionValue, decision: 'resume' }),
        formButton('wmux_waiting_submit', '提交新方案并继续', 'primary', { ...actionValue, decision: 'submit' }),
        formButton('wmux_waiting_stop', '停止此监督', 'danger', { ...actionValue, decision: 'stop' }),
      ]),
      { tag: 'div', text: { tag: 'plain_text', content: '“保持待续”不会改变通道状态，之后仍可在此卡片选择其他操作。' } },
    ],
  );
}

export class FeishuSupervisorService {
  private readonly config = envConfig();
  private channel: Lark.LarkChannel | null = null;
  private readonly seen = new Set<string>();
  private readonly approvalCards = new Map<string, ApprovalCard>();
  private readonly waitingDecisionCards = new Map<string, WaitingDecisionCard>();
  /** Only cards sent to a control chat may open routine control forms. */
  private readonly controlCards = new Map<string, string>();
  private readonly busyTaskConfirmations = new Map<string, PendingBusyTaskConfirmation>();
  private readonly auditTerminalStatuses = new Map<string, FeishuAuditTerminalStatus>();
  private readonly auditStatusCards = new Map<string, { messageId: string; chatId: string }>();
  /** Routes an asynchronous project-management AI reply back to the card/chat that sent the message. */
  private readonly projectReplyTargets = new Map<string, {
    chatId: string;
    openId?: string;
    cardMessageId?: string;
    projectId?: string;
  }>();
  private readonly projectQuestionCards = new Map<string, { messageId: string; chatId: string; resolving?: boolean }>();
  private readonly projectQuestionResolutions = new Map<string, string>();
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
    const projectWorkItemId = String(record.payload?.projectWorkItemId || '').trim();
    if (projectWorkItemId) {
      // Project-mode worker/supervisor traffic is private to the project manager.
      return;
    }
    if (record.type === 'supervisor.approval.requested') {
      const operation = record.payload?.approvalId
        ? () => this.sendApproval(record)
        : () => this.sendDecisionText(formatFeishuSupervisorAuditEvent(record));
      void this.enqueueDecisionOperation(operation);
      this.enqueueAuditRecord(record);
      return;
    }
    if (record.type === 'supervisor.proposal.resolved') {
      const operation = record.payload?.approvalId
        ? () => this.resolveApproval(record)
        : () => this.sendDecisionText(formatFeishuSupervisorAuditEvent(record));
      void this.enqueueDecisionOperation(operation);
      this.enqueueAuditRecord(record);
      return;
    }
    if (record.type === 'supervisor.remote-decision') {
      // The text command or card action already replies in the same allowlisted DM.
      this.enqueueAuditRecord(record);
      return;
    }
    if (record.type === 'supervisor.waiting-resumed') {
      void this.enqueueDecisionOperation(() => this.expireWaitingDecisionCards(
        record.terminal.surfaceId,
        '该监督通道已通过其他入口恢复；此待续卡不再可操作。',
        true,
      ));
      this.enqueueAuditRecord(record);
      return;
    }
    if (
      record.type === 'session.abandoned'
      || (record.type === 'supervisor.lane-control' && record.payload?.action === 'stop')
      || (record.type === 'supervisor.remote-command'
        && ['close-terminal', 'stop-lane', 'waiting-stop', 'stop'].includes(String(record.payload?.action || '')))
    ) {
      void this.enqueueDecisionOperation(() => this.expireWaitingDecisionCards(
        record.terminal.surfaceId,
        '该监督通道已停止或重置；此待续卡不再可操作。',
        false,
      ));
      this.enqueueAuditRecord(record);
      return;
    }
    if (record.type === 'supervisor.auto-decision-limit.resolved') {
      void this.enqueueDecisionOperation(() => this.sendDecisionText(formatFeishuSupervisorAuditEvent(record)));
      this.enqueueAuditRecord(record);
      return;
    }
    if (record.type === 'supervisor.waiting-for-direction') {
      void this.enqueueDecisionOperation(() => this.sendWaitingDecision(record));
      this.enqueueAuditRecord(record);
      return;
    }
    if (record.type === 'supervisor.provider-limit') {
      void this.enqueueDecisionOperation(() => this.sendDecisionText([
        'wmux AI 监督告警：模型请求受限',
        `终端：${auditValue('terminal', record.terminal.label)}`,
        `模型：${auditPayloadText(record, 'supervisorModel', 'Agent 默认模型')}`,
        `错误：${auditPayloadText(record, 'summary', '服务返回 429、限流或额度错误')}`,
        '建议：检查模型额度或稍后重试；当前任务终端不会自动收到新的监督指令。',
      ].join('\n')));
      this.enqueueAuditRecord(record);
      return;
    }
    if (record.type === 'supervisor.runtime-failed' || record.type === 'task.runtime-failed') {
      void this.enqueueDecisionOperation(() => this.sendDecisionText([
        'wmux AI 监督运行时告警',
        `终端：${auditValue('terminal', record.terminal.label)}`,
        `故障角色：${record.type === 'supervisor.runtime-failed' ? 'AI 监督' : '任务终端 AI'}`,
        `详情：${auditPayloadText(record, 'detail', '运行时已停止或启动失败')}`,
        '该监督通道已暂停，需在 wmux 中重新建立运行时后再继续。',
      ].join('\n')));
      this.enqueueAuditRecord(record);
      return;
    }
    if (record.type === 'supervisor.review.watchdog-failed') {
      void this.enqueueDecisionOperation(() => this.sendDecisionText([
        'wmux AI 监督告警：裁决看门狗已暂停通道',
        `终端：${auditValue('terminal', record.terminal.label)}`,
        `详情：${auditPayloadText(record, 'reason', 'AI 监督连续两次未提交结构化裁决')}`,
        '建议：在 wmux 中重新唤醒一次；若仍失败，请重建监督 AI 或更换模型。',
      ].join('\n')));
      this.enqueueAuditRecord(record);
      return;
    }
    this.enqueueAuditRecord(record);
  }

  onProjectManagerRecord(record: ProjectManagerRecord): void {
    if (!this.channel) return;
    if (projectManagerEventNeedsUserAttention({ kind: record.type, payload: record.payload })) {
      const targetChatId = this.config?.projectManagerChatId || this.decisionChatId;
      if (targetChatId) {
        void this.enqueueDecisionOperation(async () => {
          await this.sendControlCard(buildProjectRuntimeAlertCard(record), targetChatId);
        });
      }
      return;
    }
    if (record.type === 'user-clarification-requested') {
      const question = record.payload?.question;
      if (!question || typeof question !== 'object') return;
      const candidate = question as unknown as FeishuProjectClarification;
      if (!candidate.id || !candidate.question || !Array.isArray(candidate.options)) return;
      void this.enqueueDecisionOperation(() => this.sendProjectClarification(record.sessionId, candidate));
      return;
    }
    if (record.type === 'user-clarification-answered') {
      const questionId = String(record.payload?.questionId || record.payload?.correlationId || '').trim();
      if (!questionId) return;
      const resolution = String(record.payload?.answer || record.payload?.message || '用户已答复').trim();
      this.removePendingProjectClarification(questionId);
      this.projectQuestionResolutions.set(questionId, resolution);
      void this.resolveProjectClarification(questionId, resolution);
      return;
    }
    if (record.type !== 'manager-reply') return;
    const message = String(record.payload?.message || '').trim();
    if (!message) return;
    const correlationId = String(record.payload?.correlationId || '').trim();
    const target = correlationId ? this.projectReplyTargets.get(correlationId) : undefined;
    const targetChatId = target?.chatId || this.config?.projectManagerChatId;
    if (!targetChatId) return;
    if (correlationId) this.projectReplyTargets.delete(correlationId);
    if (target?.cardMessageId && target.openId) {
      void this.refreshProjectConversationCard({
        ...target,
        projectId: record.sessionId || target.projectId,
      }, message);
      return;
    }
    void this.sendText(message, targetChatId);
  }

  private async sendProjectClarification(
    projectId: string,
    question: FeishuProjectClarification,
  ): Promise<void> {
    const chatId = this.decisionChatId || this.config?.projectManagerChatId;
    if (!this.channel || !chatId) {
      this.queuePendingDecision({ kind: 'project-clarification', projectId, question });
      return;
    }
    const messageId = await this.sendControlCard(buildProjectClarificationCard(projectId, question), chatId);
    if (!messageId) {
      this.queuePendingDecision({ kind: 'project-clarification', projectId, question });
      return;
    }
    this.projectQuestionCards.set(question.id, { messageId, chatId });
    const resolved = this.projectQuestionResolutions.get(question.id);
    if (resolved) await this.resolveProjectClarification(question.id, resolved);
  }

  private async resolveProjectClarification(questionId: string, resolution: string): Promise<void> {
    const card = this.projectQuestionCards.get(questionId);
    if (!card || !this.channel || card.resolving) return;
    card.resolving = true;
    await this.channel.updateCard(card.messageId, buildSupervisorResultCard(
      'wmux · 项目确认已提交',
      `答复：${resolution}\n\n项目仍保持暂停，等待项目管理 AI 决定下一步。`,
      true,
    )).catch(() => undefined);
    this.projectQuestionCards.delete(questionId);
    this.projectQuestionResolutions.delete(questionId);
  }

  private allowed(chatId: string, openId: string, chatType: 'group' | 'p2p'): boolean {
    return !!this.config && isFeishuSupervisorActorAllowed(this.config, chatId, openId, chatType);
  }

  private allowsTerminalScreen(chatId: string): boolean {
    return chatId !== this.config?.controlChatId;
  }

  private buildControlMenuCard(chatId: string, state?: FeishuControlState, notice?: ControlNotice): object {
    return buildSupervisorControlMenuCard(state, notice, this.allowsTerminalScreen(chatId));
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
    if (chatId === this.config?.projectManagerChatId) {
      const normalized = content.trim();
      let projectCommand: FeishuSupervisorCommand;
      if (normalized === '/项目日志' || normalized === '查看项目日志') {
        projectCommand = { action: 'project-logs' };
      } else if (normalized === '/暂停项目') {
        projectCommand = { action: 'project-pause', reason: '用户通过飞书暂停项目' };
      } else if (normalized === '/恢复项目') {
        projectCommand = { action: 'project-resume', reason: '用户通过飞书恢复项目' };
      } else if (normalized === '/暂停全部项目') {
        projectCommand = { action: 'project-pause-all', reason: '用户通过飞书全局暂停项目组合' };
      } else if (normalized === '/恢复全部项目') {
        projectCommand = { action: 'project-resume-all', reason: '用户通过飞书全局恢复项目组合' };
      } else if (normalized === '/确认紧急停止') {
        projectCommand = { action: 'project-stop', reason: '用户通过飞书确认紧急停止', emergency: true };
      } else if (normalized === '/紧急停止') {
        await this.sendText('紧急停止会中断正在运行的任务。请发送“/确认紧急停止”执行，或发送“/暂停项目”仅停止新任务派发。', chatId);
        return;
      } else {
        projectCommand = { action: 'project-message', message: content, messageId, chatId };
      }
      if (projectCommand.action === 'project-message') this.rememberProjectReplyTarget(messageId, chatId);
      const result = await this.control(projectCommand, { openId, source: 'text' })
        .catch((err) => ({ error: String(err?.message || err) })) as any;
      if (projectCommand.action === 'project-message' && (result?.ok === false || result?.error)) {
        this.projectReplyTargets.delete(messageId);
      }
      if (projectCommand.action === 'project-message' && result?.ok !== false && !result?.error) return;
      if (projectCommand.action === 'project-logs' && Array.isArray(result?.events)) {
        const lines = result.events.slice(0, 20).map((event: any) => (
          `${new Date(Number(event.ts) || Date.now()).toLocaleString('zh-CN', { hour12: false })} · ${event.kind || 'event'} · ${event.summary || ''}`
        ));
        await this.sendText(lines.length > 0 ? `项目管理日志（最近 ${lines.length} 条）\n${lines.join('\n')}` : '暂无项目管理日志。', chatId);
        return;
      }
      await this.sendText(String(result?.message || result?.error || (result?.ok ? '操作成功。' : '操作失败。')), chatId);
      return;
    }
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
    if (value?.wmux_action === 'waiting_decision') {
      await this.handleWaitingDecisionCardAction(event, value);
      return;
    }
    if (value?.wmux_action === 'menu' || value?.wmux_action === 'form_project_ai_message' || value?.wmux_action === 'project_clarification_option' || value?.wmux_action === 'form_project_clarification' || value?.wmux_action === 'project_ai_select' || value?.wmux_action === 'project_ai_portfolio' || value?.wmux_action === 'project_ai_workspace' || value?.wmux_action === 'project_ai_view' || value?.wmux_action === 'project_ai_refresh' || value?.wmux_action === 'project_ai_logs' || value?.wmux_action === 'project_ai_pause' || value?.wmux_action === 'project_ai_resume' || value?.wmux_action === 'project_ai_pause_all' || value?.wmux_action === 'project_ai_resume_all' || value?.wmux_action === 'form_create_task' || value?.wmux_action === 'form_create_user_records_terminal' || value?.wmux_action === 'form_start' || value?.wmux_action === 'form_send' || value?.wmux_action === 'form_terminal_control' || value?.wmux_action === 'form_terminal_refresh' || value?.wmux_action === 'form_terminal_expand' || value?.wmux_action === 'form_terminal_collapse' || value?.wmux_action === 'form_terminal_send' || value?.wmux_action === 'form_terminal_escape' || value?.wmux_action === 'form_terminal_interrupt' || value?.wmux_action === 'form_project_terminal_refresh' || value?.wmux_action === 'form_project_terminal_expand' || value?.wmux_action === 'form_project_terminal_collapse' || value?.wmux_action === 'form_project_terminal_send' || value?.wmux_action === 'form_project_terminal_escape' || value?.wmux_action === 'form_project_terminal_interrupt' || value?.wmux_action === 'form_send_supervisor' || value?.wmux_action === 'form_supervisor_screen' || value?.wmux_action === 'form_supervisor_refresh' || value?.wmux_action === 'form_supervisor_expand' || value?.wmux_action === 'form_supervisor_collapse' || value?.wmux_action === 'form_supervisor_send' || value?.wmux_action === 'form_terminal_screen' || value?.wmux_action === 'terminal_screen' || value?.wmux_action === 'inspect_close_terminal' || value?.wmux_action === 'form_close_terminal' || value?.wmux_action === 'confirm_close_terminal' || value?.wmux_action === 'form_lane_control' || value?.wmux_action === 'lane_control' || value?.wmux_action === 'stop_lane_confirm' || value?.wmux_action === 'confirm_stop_lane' || value?.wmux_action === 'confirm_busy_send') {
      if (value.wmux_card_version !== FEISHU_CONTROL_CARD_VERSION) {
        console.info(`[feishu] obsolete control card replaced: version=${value.wmux_card_version || 'missing'}`);
        // Never execute an action from an old schema. Only issue a new control
        // card in a chat already known to this service; otherwise an allowlisted
        // user could forward an old card and bootstrap controls in another group.
        const knownControlChat = this.controlCards.get(event.messageId) === event.chatId
          || event.chatId === this.config.controlChatId
          || event.chatId === this.decisionChatId;
        if (knownControlChat) {
          await this.sendCurrentControlMenu(event.chatId, event.operator.openId, 'card');
        } else if (event.chatId !== this.config.chatId) {
          await this.sendText('该控制卡版本已过期，请在白名单单聊中发送“帮助”打开新版控制卡。', event.chatId);
        }
        return;
      }
      if (this.controlCards.get(event.messageId) !== event.chatId) return;
      const startedAt = Date.now();
      const dedupeKey = `${event.messageId}:${value.wmux_action}:${value.flow || ''}:${value.terminal || value.session_target || ''}:${value.nonce || ''}`;
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
      || !['approve', 'direct', 'pause', 'stop'].includes(value.decision || '')
      || !isFeishuApprovalCardContext(card, event.messageId, event.chatId)
    ) return;
    this.decisionChatId = event.chatId;
    const dedupeKey = `${event.messageId}:${value.decision}`;
    if (this.seen.has(dedupeKey)) return;
    this.remember(dedupeKey);
    const selection = value.decision === 'approve' ? this.cardDecisionSelection(event) : undefined;
    const decisionInput = ['approve', 'direct'].includes(value.decision || '')
      ? this.cardDecisionInput(event)
      : undefined;
    const result = await this.control({
      action: 'decide',
      approvalId: value.approval_id,
      decision: value.decision as 'approve' | 'direct' | 'pause' | 'stop',
      ...(selection ? { selection } : {}),
      ...(decisionInput ? { task: decisionInput } : {}),
    }, { openId: event.operator.openId, source: 'card' }).catch((err) => ({ error: String(err?.message || err) }));
    const failed = !!(result && typeof result === 'object' && (result as { error?: string }).error);
    if (failed) {
      // Invalid decision data is correctable in the same card.
      // Rebuild the form because Feishu may keep the submitted form disabled
      // even after the server-side dedupe key has been released.
      this.seen.delete(dedupeKey);
      const failureMessage = summary(result);
      if (card && this.channel) {
        await this.channel.updateCard(card.messageId, buildApprovalCard(card.record, {
          error: failureMessage,
          decisionInput,
        })).catch((err) => console.warn('[feishu] refresh rejected approval card failed', err));
      }
      await this.sendText(`人工决策未执行：${failureMessage}`, event.chatId);
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
    value: ResolvedCardAction,
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
    if (value.wmux_action === 'project_clarification_option' || value.wmux_action === 'form_project_clarification') {
      const answer = value.wmux_action === 'project_clarification_option'
        ? String(value.answer || '').trim()
        : String(form.project_clarification_answer || '').trim();
      if (!answer || !value.questionId) {
        await this.sendText('请选择一个选项，或填写自定义答复后再提交。', event.chatId);
        return false;
      }
      const result = await this.control({
        action: 'project-answer',
        projectId: value.projectId || undefined,
        questionId: value.questionId,
        optionId: value.optionId,
        answer,
      }, { openId: event.operator.openId, source: 'card' }).catch((err) => ({ error: String(err?.message || err) }));
      if (!failedResult(result)) {
        await this.resolveProjectClarification(value.questionId, answer);
      } else {
        await this.sendText(summary(result), event.chatId);
      }
      return !failedResult(result);
    }
    if (value.wmux_action === 'form_project_ai_message') {
      const message = form.project_ai_message?.trim() || '';
      if (!message) {
        await this.sendText('请先填写要发送给项目管理 AI 的消息。', event.chatId);
        return false;
      }
      const correlationId = `feishu-card:${event.messageId}:${value.nonce || nextControlActionNonce()}`;
      this.rememberProjectReplyTarget(
        correlationId,
        event.chatId,
        event.operator.openId,
        event.messageId,
        value.projectId,
      );
      const result = await this.control({
        action: 'project-message', projectId: value.projectId || undefined, message, messageId: correlationId, chatId: event.chatId,
      }, {
        openId: event.operator.openId,
        source: 'card',
      }).catch((err) => ({ error: String(err?.message || err) }));
      if (failedResult(result)) this.projectReplyTargets.delete(correlationId);
      const view = await this.loadProjectManagerView(event.operator.openId, false, value.projectId);
      await this.replaceControlCard(event, buildProjectManagerConversationCard(view, {
        text: failedResult(result) ? summary(result) : '消息已发送；项目管理 AI 会在当前飞书会话直接回复。',
        success: !failedResult(result),
      }, 'chat'));
      return !failedResult(result);
    }
    if (value.wmux_action === 'project_ai_portfolio') {
      const view = await this.loadProjectManagerView(event.operator.openId);
      await this.replaceControlCard(event, buildProjectManagerPortfolioCard(view));
      return true;
    }
    if (value.wmux_action === 'project_ai_select' || value.wmux_action === 'project_ai_workspace') {
      const view = await this.loadProjectManagerView(event.operator.openId, false, value.projectId);
      await this.replaceControlCard(event, buildProjectManagerConversationCard(view));
      return true;
    }
    if (value.wmux_action === 'project_ai_view' || value.wmux_action === 'project_ai_refresh' || value.wmux_action === 'project_ai_logs') {
      const requested = value.wmux_action === 'project_ai_view' ? value.view : value.wmux_action === 'project_ai_logs' ? 'activity' : 'overview';
      const cardView: ProjectManagerCardView = ['overview', 'chat', 'chat-expanded', 'decisions', 'decisions-expanded', 'activity', 'activity-expanded'].includes(String(requested))
        ? requested as ProjectManagerCardView
        : 'overview';
      const view = await this.loadProjectManagerView(event.operator.openId, cardView === 'activity' || cardView === 'activity-expanded', value.projectId);
      await this.replaceControlCard(event, buildProjectManagerConversationCard(view, undefined, cardView));
      return true;
    }
    if (value.wmux_action === 'project_ai_pause' || value.wmux_action === 'project_ai_resume') {
      const pause = value.wmux_action === 'project_ai_pause';
      const result = await this.control({
        action: pause ? 'project-pause' : 'project-resume',
        projectId: value.projectId || undefined,
        reason: pause ? '用户通过飞书项目管理 AI 对话暂停项目' : '用户通过飞书项目管理 AI 对话恢复项目',
      }, { openId: event.operator.openId, source: 'card' })
        .catch((err) => ({ error: String(err?.message || err) }));
      const view = await this.loadProjectManagerView(event.operator.openId, false, value.projectId);
      await this.replaceControlCard(event, buildProjectManagerConversationCard(view, {
        text: summary(result), success: !failedResult(result),
      }, 'overview'));
      return !failedResult(result);
    }
    if (value.wmux_action === 'project_ai_pause_all' || value.wmux_action === 'project_ai_resume_all') {
      const pause = value.wmux_action === 'project_ai_pause_all';
      const result = await this.control({
        action: pause ? 'project-pause-all' : 'project-resume-all',
        reason: pause ? '用户通过飞书全局暂停项目组合' : '用户通过飞书全局恢复项目组合',
      }, { openId: event.operator.openId, source: 'card' })
        .catch((err) => ({ error: String(err?.message || err) }));
      const view = await this.loadProjectManagerView(event.operator.openId, false, value.projectId);
      await this.replaceControlCard(event, buildProjectManagerPortfolioCard(view, {
        text: summary(result), success: !failedResult(result),
      }));
      return !failedResult(result);
    }
    if (value.wmux_action === 'terminal_screen') {
      return this.showTerminalScreen(event, value.terminal || '');
    }
    if (value.wmux_action === 'form_terminal_control') {
      return value.terminal_mode === 'project'
        ? this.showProjectTerminalScreen(event, form.terminal || '')
        : value.terminal_mode === 'ordinary'
          ? this.showOrdinaryMonitoringTerminal(event, form.terminal || '')
          : this.showTerminalScreen(event, form.terminal || '');
    }
    if (value.wmux_action === 'form_project_terminal_refresh') {
      return this.showProjectTerminalScreen(event, value.terminal || '', form.task || '');
    }
    if (value.wmux_action === 'form_project_terminal_expand') {
      return this.showProjectTerminalScreen(event, value.terminal || '', form.task || '', '', true);
    }
    if (value.wmux_action === 'form_project_terminal_collapse') {
      return this.showProjectTerminalScreen(event, value.terminal || '', form.task || '');
    }
    if (value.wmux_action === 'form_project_terminal_send') {
      return this.sendTaskFromControlCard(event, value.terminal || '', form.task || '', 'project');
    }
    if (value.wmux_action === 'form_project_terminal_escape') {
      return this.sendTerminalControlKeyFromCard(event, value.terminal || '', 'escape', 'project', form.task || '');
    }
    if (value.wmux_action === 'form_project_terminal_interrupt') {
      return this.sendTerminalControlKeyFromCard(event, value.terminal || '', 'interrupt', 'project', form.task || '');
    }
    if (value.wmux_action === 'form_terminal_refresh') {
      return this.showTerminalScreen(event, value.terminal || '', form.task || '');
    }
    if (value.wmux_action === 'form_terminal_expand') {
      return this.showTerminalScreen(event, value.terminal || '', form.task || '', '', true);
    }
    if (value.wmux_action === 'form_terminal_collapse') {
      return this.showTerminalScreen(event, value.terminal || '', form.task || '');
    }
    if (value.wmux_action === 'form_terminal_send') {
      return this.sendTaskFromControlCard(event, value.terminal || '', form.task || '');
    }
    if (value.wmux_action === 'form_terminal_escape') {
      return this.sendTerminalControlKeyFromCard(event, value.terminal || '', 'escape', undefined, form.task || '');
    }
    if (value.wmux_action === 'form_terminal_interrupt') {
      return this.sendTerminalControlKeyFromCard(event, value.terminal || '', 'interrupt', undefined, form.task || '');
    }
    if (value.wmux_action === 'form_supervisor_screen') {
      return this.showSupervisorScreen(event, form.terminal || '', form.message || '');
    }
    if (value.wmux_action === 'form_supervisor_refresh') {
      return this.showSupervisorScreen(event, value.terminal || '', form.message || '', '', false, value.terminal_mode === 'ordinary' ? 'ordinary' : undefined);
    }
    if (value.wmux_action === 'form_supervisor_expand') {
      return this.showSupervisorScreen(event, value.terminal || '', form.message || '', '', true, value.terminal_mode === 'ordinary' ? 'ordinary' : undefined);
    }
    if (value.wmux_action === 'form_supervisor_collapse') {
      return this.showSupervisorScreen(event, value.terminal || '', form.message || '', '', false, value.terminal_mode === 'ordinary' ? 'ordinary' : undefined);
    }
    if (value.wmux_action === 'form_supervisor_send') {
      return this.sendSupervisorMessageFromControlCard(event, value.terminal || '', form.message || '', value.terminal_mode === 'ordinary' ? 'ordinary' : undefined);
    }
    if (value.wmux_action === 'inspect_close_terminal' || value.wmux_action === 'form_close_terminal') {
      const terminal = value.terminal || form.terminal || '';
      const listResult = await this.control({ action: 'list' }, { openId: event.operator.openId, source: 'card' })
        .catch(() => null);
      const terminalInfo = parseListResult(listResult)?.terminals.find((item) => item.surfaceId === terminal);
      if (!terminalInfo) {
        await this.replaceWithCurrentControlMenu(event, {
          text: '该任务终端已不存在或不可关闭，请刷新后重试。', success: false,
        });
        return false;
      }
      await this.replaceControlCard(event, buildCloseTerminalConfirmationCard(terminalInfo));
      return true;
    }
    if (value.wmux_action === 'confirm_close_terminal') {
      if (!value.terminal) {
        await this.sendText('缺少要关闭的任务终端，请重新选择。', event.chatId);
        return false;
      }
      const result = await this.control({ action: 'close-terminal', terminal: value.terminal }, {
        openId: event.operator.openId,
        source: 'card',
      }).catch((err) => ({ error: String(err?.message || err) }));
      await this.replaceWithCurrentControlMenu(event, {
        text: summary(result), success: !failedResult(result),
      });
      return !failedResult(result);
    }
    if (value.wmux_action === 'form_create_user_records_terminal') {
      const result = await this.control({
        action: 'create-task',
        name: USER_RECORDS_TERMINAL_NAME,
        task: USER_RECORDS_TERMINAL_STARTUP_INPUT,
        agent: USER_RECORDS_TERMINAL_AGENT,
        preset: 'user-records',
      }, {
        openId: event.operator.openId,
        source: 'card',
      }).catch((err) => ({ error: String(err?.message || err) }));
      await this.replaceWithCurrentControlMenu(event, {
        text: summary(result), success: !failedResult(result),
      });
      return !failedResult(result);
    }
    if (value.wmux_action === 'form_create_task') {
      const name = form.task_name || '';
      const task = form.task || '';
      const agent = form.agent === 'kimi' || form.agent === 'grok' ? form.agent : 'codex';
      const sessionTarget = form.session_target || 'new';
      if (!name || !task) {
        await this.sendText('请填写任务名称和首条任务。', event.chatId);
        return false;
      }
      if (sessionTarget !== 'new' && !sessionTarget.startsWith('workspace:') && !sessionTarget.startsWith('terminal:')) {
        await this.sendText('创建位置无效，请刷新添加终端任务卡片后重试。', event.chatId);
        return false;
      }
      let cwd: string | undefined;
      let anchorWorkspace: string | undefined;
      let anchorTerminal: string | undefined;
      if (form.path_terminal || sessionTarget !== 'new') {
        const listResult = await this.control({ action: 'list' }, {
          openId: event.operator.openId,
          source: 'card',
        }).catch(() => null);
        const currentTerminals = parseListResult(listResult)?.terminals || [];
        if (form.path_terminal) {
          cwd = form.path_terminal.startsWith('saved:')
            ? savedTerminalPath(form.path_terminal.slice('saved:'.length))
            : currentTerminals.find((terminal) => terminal.surfaceId === form.path_terminal)?.cwd;
        }
        if (form.path_terminal && !cwd) {
          await this.sendText('所选终端已关闭或路径不可用（已保存路径可能已删除）；请刷新添加终端任务卡片后重试。', event.chatId);
          return false;
        }
        if (sessionTarget !== 'new') {
          if (sessionTarget.startsWith('workspace:')) {
            const selectedWorkspace = sessionTarget.slice('workspace:'.length);
            anchorWorkspace = currentTerminals.find((terminal) => terminal.workspaceId === selectedWorkspace)?.workspaceId;
          } else {
            const selectedAnchor = sessionTarget.slice('terminal:'.length);
            anchorTerminal = currentTerminals.find((terminal) => terminal.surfaceId === selectedAnchor)?.surfaceId;
          }
          if (!anchorWorkspace && !anchorTerminal) {
            await this.sendText('所选会话已关闭或不可用，请刷新添加终端任务卡片后重试。', event.chatId);
            return false;
          }
        }
      }
      const result = await this.control({
        action: 'create-task', name, task, agent,
        ...(cwd ? { cwd } : {}),
        ...(anchorWorkspace ? { anchorWorkspace } : {}),
        ...(anchorTerminal ? { anchorTerminal } : {}),
      }, {
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
      return this.sendTaskFromControlCard(event, terminal, task);
    }
    if (value.wmux_action === 'form_send_supervisor') {
      const terminal = form.terminal || '';
      const message = form.message || '';
      return this.sendSupervisorMessageFromControlCard(event, terminal, message);
    }
    if (value.wmux_action === 'form_terminal_screen') {
      return this.showTerminalScreen(event, form.terminal || '');
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
      await this.sendText('本次忙碌终端确认已失效，请重新打开终端控制。', event.chatId);
      return false;
    }
    const result = await this.control({
      action: 'send', terminal: pending.terminal.surfaceId, task: pending.task, force: true,
      ...(pending.mode ? { mode: pending.mode } : {}),
    }, { openId: event.operator.openId, source: 'card' }).catch((err) => ({ error: String(err?.message || err) }));
    if (failedResult(result)) {
      const confirmationMessageId = await this.replaceControlCard(event, buildBusyTaskConfirmationCard(
        pending.terminal,
        confirmationId,
        summary(result),
        pending.mode,
      ));
      if (!confirmationMessageId) this.busyTaskConfirmations.delete(confirmationId);
      else pending.messageId = confirmationMessageId;
      return false;
    }
    this.busyTaskConfirmations.delete(confirmationId);
    if (pending.mode === 'project') {
      return this.showProjectTerminalScreen(
        event,
        pending.terminal.surfaceId,
        '',
        `✅ ${summary(result)} AI 回复可能尚未生成，请稍后点击“刷新界面”。`,
      );
    }
    await this.replaceWithCurrentControlMenu(event, { text: summary(result), success: true });
    return true;
  }

  private async sendTaskFromControlCard(
    event: Lark.CardActionEvent,
    terminal: string,
    task: string,
    mode?: 'project',
  ): Promise<boolean> {
    if (!terminal || !task) {
      await this.sendText('请先选择目标终端并填写任务内容。', event.chatId);
      return false;
    }
    const result = await this.control({ action: 'send', terminal, task, ...(mode ? { mode } : {}) }, {
      openId: event.operator.openId,
      source: 'card',
    }).catch((err) => ({ error: String(err?.message || err) }));
    const busyTerminal = busyTerminalFromResult(result);
    if (busyTerminal) {
      const confirmationId = nextControlActionNonce();
      this.clearBusyTaskConfirmationsForMessage(event.messageId);
      const pendingConfirmation: PendingBusyTaskConfirmation = {
        messageId: event.messageId,
        chatId: event.chatId,
        terminal: busyTerminal,
        task,
        mode,
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
        buildBusyTaskConfirmationCard(busyTerminal, confirmationId, undefined, mode),
      );
      if (!confirmationMessageId) {
        this.busyTaskConfirmations.delete(confirmationId);
        return false;
      }
      pendingConfirmation.messageId = confirmationMessageId;
      return true;
    }
    if (failedResult(result)) {
      if (mode === 'project') {
        return this.showProjectTerminalScreen(event, terminal, task, `❌ ${summary(result)}`);
      }
      await this.replaceWithCurrentControlMenu(event, { text: summary(result), success: false });
      return false;
    }
    if (mode === 'project') {
      return this.showProjectTerminalScreen(
        event,
        terminal,
        '',
        `✅ ${summary(result)} AI 回复可能尚未生成，请稍后点击“刷新界面”。`,
      );
    }
    await this.showTerminalScreen(
      event,
      terminal,
      '',
      `✅ ${summary(result)} AI 回复可能尚未生成，请稍后点击“刷新界面”。`,
    );
    return true;
  }

  private async sendTerminalControlKeyFromCard(
    event: Lark.CardActionEvent,
    terminal: string,
    key: 'escape' | 'interrupt',
    mode?: 'project',
    draft = '',
  ): Promise<boolean> {
    const keyLabel = key === 'escape' ? 'Esc' : 'Ctrl+C';
    if (!terminal) {
      await this.sendText(`缺少要发送 ${keyLabel} 的终端，请重新打开终端控制。`, event.chatId);
      return false;
    }
    const result = await this.control({
      action: key === 'escape' ? 'terminal-escape' : 'terminal-interrupt',
      terminal,
      ...(mode ? { mode } : {}),
    }, {
      openId: event.operator.openId,
      source: 'card',
    }).catch((err) => ({ error: String(err?.message || err) }));
    if (failedResult(result)) {
      await this.sendText(`${keyLabel} 中断未发送：${summary(result)}`, event.chatId);
      return false;
    }
    const notice = `${key === 'escape' ? '⎋' : '^C'} ${summary(result)}`;
    return mode === 'project'
      ? this.showProjectTerminalScreen(event, terminal, draft, notice)
      : this.showTerminalScreen(event, terminal, draft, notice);
  }

  private async showTerminalScreen(event: Lark.CardActionEvent, terminal: string, draft = '', notice = '', expanded = false): Promise<boolean> {
    if (!this.allowsTerminalScreen(event.chatId)) {
      await this.sendText('任务终端界面可能包含敏感信息，仅支持白名单用户单聊查看。', event.chatId);
      return false;
    }
    if (!terminal) {
      await this.sendText('请先选择要查看的任务终端。', event.chatId);
      return false;
    }
    const result = await this.control({ action: 'terminal-screen', terminal, lines: FEISHU_TERMINAL_CAPTURE_LINES }, {
      openId: event.operator.openId,
      source: 'card',
    }).catch((err) => ({ error: String(err?.message || err) }));
    const screen = parseTerminalScreenResult(result);
    if (!screen) {
      await this.sendText(`终端界面读取失败：${summary(result)}`, event.chatId);
      return false;
    }
    return !!await this.replaceControlCard(event, buildTerminalScreenCard(screen, draft, notice, expanded));
  }

  private async showOrdinaryMonitoringTerminal(event: Lark.CardActionEvent, terminal: string): Promise<boolean> {
    if (!this.allowsTerminalScreen(event.chatId)) {
      await this.sendText('普通监督模式终端可能包含敏感信息，仅支持白名单用户单聊查看。', event.chatId);
      return false;
    }
    if (!terminal) {
      await this.sendText('请先选择要查看的普通监督模式终端。', event.chatId);
      return false;
    }
    const result = await this.control({
      action: 'terminal-screen', terminal, lines: FEISHU_TERMINAL_CAPTURE_LINES, mode: 'ordinary',
    }, {
      openId: event.operator.openId,
      source: 'card',
    }).catch((err) => ({ error: String(err?.message || err) }));
    const screen = parseTerminalScreenResult(result);
    if (!screen || screen.terminal.terminalMode !== 'ordinary') {
      await this.sendText(`普通监督模式终端读取失败：${summary(result)}`, event.chatId);
      return false;
    }
    return !!await this.replaceControlCard(event, screen.terminal.agentRole === 'supervisor-ai'
      ? buildSupervisorTerminalScreenCard(screen, '', '', false, 'ordinary')
      : buildTerminalScreenCard(screen));
  }

  private async showProjectTerminalScreen(
    event: Lark.CardActionEvent,
    terminal: string,
    draft = '',
    notice = '',
    expanded = false,
  ): Promise<boolean> {
    if (!this.allowsTerminalScreen(event.chatId)) {
      await this.sendText('项目 AI 模式终端可能包含敏感信息，仅支持白名单用户单聊查看。', event.chatId);
      return false;
    }
    if (!terminal) {
      await this.sendText('请先选择要监控的项目 AI 模式终端。', event.chatId);
      return false;
    }
    const result = await this.control({
      action: 'terminal-screen', terminal, lines: FEISHU_TERMINAL_CAPTURE_LINES, mode: 'project',
    }, {
      openId: event.operator.openId,
      source: 'card',
    }).catch((err) => ({ error: String(err?.message || err) }));
    const screen = parseTerminalScreenResult(result);
    if (!screen || screen.terminal.terminalMode !== 'project') {
      await this.sendText(`项目 AI 模式终端读取失败：${summary(result)}`, event.chatId);
      return false;
    }
    return !!await this.replaceControlCard(event, buildProjectTerminalScreenCard(screen, draft, notice, expanded));
  }

  private async handleWaitingDecisionCardAction(
    event: Lark.CardActionEvent,
    value: ResolvedCardAction,
  ): Promise<void> {
    const card = this.waitingDecisionCards.get(event.messageId);
    const decision = value.decision || '';
    if (!card) {
      if (event.chatId === this.decisionChatId) {
        await this.sendText('该待续卡已过期或 wmux 已重启，请使用最新待续卡，或从“发送监督信息”继续。', event.chatId);
      }
      return;
    }
    if (
      card.chatId !== event.chatId
      || card.terminal !== value.terminal
      || !['keep', 'resume', 'submit', 'stop'].includes(decision)
    ) return;
    this.decisionChatId = event.chatId;
    const dedupeKey = `${event.messageId}:waiting:${decision}:${value.nonce || ''}`;
    if (this.seen.has(dedupeKey)) return;
    this.remember(dedupeKey);
    const message = this.cardFormValues(event).waiting_direction?.trim().slice(0, MAX_COMMAND_VALUE_LENGTH) || '';
    if (decision === 'submit' && !message) {
      this.seen.delete(dedupeKey);
      await this.sendText('请先填写新方案或下一步方向，再点击“提交新方案并继续”。', event.chatId);
      return;
    }
    const consumesCard = decision !== 'keep';
    if (consumesCard) this.waitingDecisionCards.delete(event.messageId);
    const result = await this.control({
      action: 'waiting-decision',
      terminal: card.terminal,
      decision: decision as 'keep' | 'resume' | 'submit' | 'stop',
      ...(decision === 'submit' ? { message } : {}),
    }, { openId: event.operator.openId, source: 'card' }).catch((err) => ({ error: String(err?.message || err) }));
    if (failedResult(result)) {
      if (consumesCard) this.waitingDecisionCards.set(event.messageId, card);
      this.seen.delete(dedupeKey);
      await this.sendText(`待续操作未执行：${summary(result)}`, event.chatId);
      return;
    }
    if (decision === 'keep') {
      this.seen.delete(dedupeKey);
      await this.sendText(summary(result), event.chatId);
      return;
    }
    if (this.channel) {
      await this.channel.updateCard(event.messageId, buildSupervisorResultCard(
        'wmux AI 监督：待续状态已处理',
        summary(result),
        true,
      )).catch(() => undefined);
    }
  }

  private async showSupervisorScreen(
    event: Lark.CardActionEvent,
    terminal: string,
    draft = '',
    notice = '',
    expanded = false,
    sourceMode?: FeishuTerminalControlMode,
  ): Promise<boolean> {
    if (!this.allowsTerminalScreen(event.chatId)) {
      await this.sendText('AI 监督终端界面可能包含敏感信息，仅支持白名单用户单聊查看。', event.chatId);
      return false;
    }
    if (!terminal) {
      await this.sendText('请先选择要查看的 AI 监督终端（管家）。', event.chatId);
      return false;
    }
    const result = await this.control({ action: 'supervisor-screen', terminal, lines: FEISHU_TERMINAL_CAPTURE_LINES }, {
      openId: event.operator.openId,
      source: 'card',
    }).catch((err) => ({ error: String(err?.message || err) }));
    const screen = parseTerminalScreenResult(result);
    if (!screen) {
      await this.sendText(`AI 监督终端界面读取失败：${summary(result)}`, event.chatId);
      return false;
    }
    return !!await this.replaceControlCard(event, buildSupervisorTerminalScreenCard(screen, draft, notice, expanded, sourceMode));
  }

  private async sendSupervisorMessageFromControlCard(
    event: Lark.CardActionEvent,
    terminal: string,
    message: string,
    sourceMode?: FeishuTerminalControlMode,
  ): Promise<boolean> {
    if (!terminal || !message) {
      await this.sendText('请先选择 AI 监督终端（管家）并填写监督方向信息。', event.chatId);
      return false;
    }
    const result = await this.control({ action: 'send-supervisor-message', terminal, message }, {
      openId: event.operator.openId,
      source: 'card',
    }).catch((err) => ({ error: String(err?.message || err) }));
    if (failedResult(result)) {
      await this.replaceWithCurrentControlMenu(event, { text: summary(result), success: false });
      return false;
    }
    await this.showSupervisorScreen(
      event,
      terminal,
      '',
      `✅ ${summary(result)} AI 回复可能尚未生成，请稍后点击“刷新界面”。`,
      false,
      sourceMode,
    );
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

  private async loadProjectManagerView(
    openId: string,
    includeLogs = false,
    projectId?: string,
  ): Promise<FeishuProjectManagerView | null> {
    const statusResult = await this.control({ action: 'project-status', projectId: projectId || undefined }, { openId, source: 'card' })
      .catch(() => null);
    const view = projectManagerViewFromStatusResult(statusResult);
    if (!view) return null;
    if (!includeLogs) return view;
    const logsResult = await this.control({ action: 'project-logs', projectId: view.projectId }, { openId, source: 'card' })
      .catch(() => null);
    view.events = isObject(logsResult) && Array.isArray(logsResult.events)
      ? logsResult.events as Array<{ ts?: number; kind?: string; summary?: string }>
      : [];
    return view;
  }

  private async handleControlMenu(event: Lark.CardActionEvent, flow: string): Promise<void> {
    if (flow === 'project-manager') {
      const view = await this.loadProjectManagerView(event.operator.openId);
      await this.replaceControlCard(event, buildProjectManagerPortfolioCard(view));
      return;
    }
    if (flow === 'create-task') {
      const result = await this.control({ action: 'list' }, { openId: event.operator.openId, source: 'card' })
        .catch(() => null);
      const list = parseListResult(result);
      await this.replaceControlCard(event, buildDirectTerminalTaskCard(list?.terminals || []));
      return;
    }
    if (flow === 'special-terminal') {
      await this.replaceControlCard(event, buildSpecialTerminalCard());
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
    if (flow === 'logs') {
      const result = await this.control({ action: 'logs' }, { openId: event.operator.openId, source: 'card' })
        .catch((err) => ({ error: String(err?.message || err) }));
      const logs = parseSupervisorLogResult(result);
      await this.replaceControlCard(event, logs
        ? buildSupervisorLogCard(logs)
        : this.buildControlMenuCard(event.chatId, undefined, { text: summary(result), success: false }));
      return;
    }
    const terminalControlFlow = ['terminal-screen', 'terminal-control', 'ordinary-terminal-control', 'project-terminal-control'].includes(flow);
    if (terminalControlFlow && !this.allowsTerminalScreen(event.chatId)) {
      await this.sendText('任务终端界面可能包含敏感信息，仅支持白名单用户单聊查看。', event.chatId);
      return;
    }
    const result = await this.control(
      flow === 'project-terminal-control'
        ? { action: 'terminal-list', mode: 'project' }
        : flow === 'ordinary-terminal-control'
          ? { action: 'terminal-list', mode: 'ordinary' }
        : { action: 'list' },
      { openId: event.operator.openId, source: 'card' },
    )
      .catch((err) => ({ error: String(err?.message || err) }));
    const list = parseListResult(result);
    if (!list) {
      await this.replaceControlCard(event, this.buildControlMenuCard(event.chatId, undefined, {
        text: summary(result), success: false,
      }));
      return;
    }
    if (flow === 'start') {
      const candidates = list.terminals.filter(isStartableSupervisorTerminal);
      if (candidates.length === 0) {
        await this.replaceControlCard(event, this.buildControlMenuCard(event.chatId, controlStateFromList(list), {
          text: '暂无可启动监督的终端。请先在 wmux 中创建工作终端，或先停止当前监督。', success: false,
        }));
        return;
      }
      await this.replaceControlCard(event, buildSupervisorStartCard(candidates, list.active || list.paused));
      return;
    }
    if (flow === 'send') {
      if (list.terminals.length === 0) {
        await this.replaceControlCard(event, this.buildControlMenuCard(event.chatId, controlStateFromList(list), {
          text: '暂无可发送任务的终端。请先在 wmux 中创建工作终端。', success: false,
        }));
        return;
      }
      await this.replaceControlCard(event, buildSupervisorSendTaskCard(list.terminals));
      return;
    }
    if (flow === 'send-supervisor') {
      const candidates = list.terminals.filter((terminal) => terminal.supervisionState === 'active');
      if (!list.active || candidates.length === 0) {
        await this.replaceControlCard(event, this.buildControlMenuCard(event.chatId, controlStateFromList(list), {
          text: '暂无运行中的 AI 监督终端（管家）。请先启动或恢复监督。', success: false,
        }));
        return;
      }
      await this.replaceControlCard(event, buildSupervisorMessageCard(candidates, this.allowsTerminalScreen(event.chatId)));
      return;
    }
    if (terminalControlFlow) {
      if (list.terminals.length === 0) {
        await this.replaceControlCard(event, this.buildControlMenuCard(event.chatId, controlStateFromList(list), {
          text: flow === 'project-terminal-control'
            ? '暂无项目 AI 模式终端。请先在项目中心启动或恢复一个项目。'
            : '暂无普通监督模式终端。请先在 wmux 中创建工作终端。',
          success: false,
        }));
        return;
      }
      await this.replaceControlCard(event, buildTerminalScreenSelectCard(
        list.terminals,
        flow === 'project-terminal-control' ? 'project' : 'ordinary',
      ));
      return;
    }
    if (flow === 'close-terminal') {
      if (list.terminals.length === 0) {
        await this.replaceControlCard(event, this.buildControlMenuCard(event.chatId, controlStateFromList(list), {
          text: '暂无可关闭的任务终端。', success: false,
        }));
        return;
      }
      await this.replaceControlCard(event, buildCloseTerminalSelectCard(list.terminals));
      return;
    }
    if (flow === 'manage') {
      const candidates = list.terminals.filter((terminal) => terminal.supervisionState === 'active' || terminal.supervisionState === 'paused');
      if (candidates.length === 0 && !list.active && !list.paused) {
        await this.replaceControlCard(event, this.buildControlMenuCard(event.chatId, controlStateFromList(list), {
          text: '暂无可单独控制的 AI 监督通道。', success: false,
        }));
        return;
      }
      await this.replaceControlCard(event, buildSupervisorManagementCard(candidates, list));
      return;
    }
    if (flow === 'detail-status') {
      await this.replaceControlCard(event, buildSupervisorStatusCard(list));
      return;
    }
    await this.replaceControlCard(event, this.buildControlMenuCard(event.chatId, controlStateFromList(list)));
  }

  private async replaceWithCurrentControlMenu(event: Lark.CardActionEvent, notice: ControlNotice): Promise<void> {
    const result = await this.control({ action: 'list' }, { openId: event.operator.openId, source: 'card' })
      .catch(() => null);
    const list = parseListResult(result);
    await this.replaceControlCard(event, this.buildControlMenuCard(
      event.chatId,
      list ? controlStateFromList(list) : undefined,
      notice,
    ));
  }

  private async sendCurrentControlMenu(chatId: string, openId: string, source: 'text' | 'card' = 'card'): Promise<void> {
    const result = await this.control({ action: 'list' }, { openId, source })
      .catch(() => null);
    const list = parseListResult(result);
    await this.sendControlCard(this.buildControlMenuCard(chatId, list ? controlStateFromList(list) : undefined), chatId);
  }

  private cardFormValues(event: Lark.CardActionEvent): Record<string, string> {
    return parseFeishuCardFormValues(event.raw);
  }

  private rememberProjectReplyTarget(
    correlationId: string,
    chatId: string,
    openId?: string,
    cardMessageId?: string,
    projectId?: string,
  ): void {
    if (!correlationId || !chatId) return;
    this.projectReplyTargets.set(correlationId, { chatId, openId, cardMessageId, projectId });
    while (this.projectReplyTargets.size > 200) {
      this.projectReplyTargets.delete(this.projectReplyTargets.keys().next().value as string);
    }
  }

  private async refreshProjectConversationCard(
    target: { chatId: string; openId?: string; cardMessageId?: string; projectId?: string },
    reply: string,
  ): Promise<void> {
    if (!this.channel || !target.openId || !target.cardMessageId) return;
    const view = await this.loadProjectManagerView(target.openId, false, target.projectId);
    if (!view) {
      await this.sendText(reply, target.chatId);
      return;
    }
    const card = buildProjectManagerConversationCard(view, {
      text: '项目管理 AI 已回复，对话已保存到当前项目。',
      success: true,
    }, 'chat');
    try {
      await this.channel.updateCard(target.cardMessageId, card);
      this.controlCards.set(target.cardMessageId, target.chatId);
    } catch (error) {
      console.warn('[feishu] project conversation card refresh failed; sending a replacement', error);
      await this.sendControlCard(card, target.chatId);
    }
  }

  private cardDecisionSelection(event: Lark.CardActionEvent): string | undefined {
    const form = this.cardFormValues(event);
    const selected = form.decision_choice?.trim() || '';
    return selected ? selected.slice(0, MAX_COMMAND_VALUE_LENGTH) : undefined;
  }

  private cardDecisionInput(event: Lark.CardActionEvent): string | undefined {
    const form = this.cardFormValues(event);
    const input = form.decision_input?.trim() || '';
    return input ? input.slice(0, MAX_COMMAND_VALUE_LENGTH) : undefined;
  }

  private approvalIdForMessage(messageId: string): string | undefined {
    for (const [approvalId, card] of this.approvalCards) {
      if (card.messageId === messageId) return approvalId;
    }
    return undefined;
  }

  private async sendWaitingDecision(record: SupervisorRecord): Promise<void> {
    if (!this.channel) return;
    const chatId = this.decisionChatId;
    if (!chatId) {
      this.queuePendingDecision({ kind: 'waiting', record });
      return;
    }
    try {
      await this.expireWaitingDecisionCards(
        record.terminal.surfaceId,
        '该监督通道已进入新的待续阶段，请使用最新待续卡。',
        false,
      );
      const context = await this.control({
        action: 'supervisor-screen',
        terminal: record.terminal.surfaceId,
        lines: FEISHU_TERMINAL_CAPTURE_LINES,
      }, { openId: 'wmux-system', source: 'system' }).catch(() => null);
      const answer = isObject(context) && typeof context.answer === 'string' ? context.answer : '';
      const sent = await this.channel.send(chatId, { card: buildWaitingDecisionCard(record, answer) });
      this.waitingDecisionCards.set(sent.messageId, {
        messageId: sent.messageId,
        chatId,
        terminal: record.terminal.surfaceId,
      });
      if (this.waitingDecisionCards.size > 100) {
        this.waitingDecisionCards.delete(this.waitingDecisionCards.keys().next().value as string);
      }
    } catch (err) {
      console.warn('[feishu] send waiting decision card failed', err);
      this.queuePendingDecision({ kind: 'waiting', record });
    }
  }

  private async expireWaitingDecisionCards(
    terminal: string,
    message: string,
    success: boolean,
  ): Promise<void> {
    const cards = [...this.waitingDecisionCards.values()].filter((card) => card.terminal === terminal);
    for (const card of cards) {
      this.waitingDecisionCards.delete(card.messageId);
      if (!this.channel) continue;
      await this.channel.updateCard(card.messageId, buildSupervisorResultCard(
        'wmux AI 监督：待续卡已失效',
        message,
        success,
      )).catch(() => undefined);
    }
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
      const context = await this.control({
        action: 'decision-context',
        approvalId,
        terminal: record.terminal.surfaceId,
        lines: 100,
      }, { openId: 'wmux-system', source: 'system' }).catch(() => null);
      const details = context && typeof context === 'object'
        ? context as { recommendation?: unknown; terminalScreen?: unknown }
        : {};
      const displayRecord: SupervisorRecord = {
        ...record,
        payload: {
          ...(record.payload || {}),
          recommendation: typeof details.recommendation === 'string' ? details.recommendation : '',
          terminalScreen: typeof details.terminalScreen === 'string' ? details.terminalScreen : '',
        },
      };
      const sent = await this.channel.send(chatId, { card: buildApprovalCard(displayRecord) });
      this.approvalCards.set(approvalId, {
        approvalId,
        messageId: sent.messageId,
        chatId,
        record: displayRecord,
      });
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
    if (message.kind === 'project-clarification') this.removePendingProjectClarification(message.question.id);
    this.pendingDecisionMessages.push(message);
    if (this.pendingDecisionMessages.length > 100) this.pendingDecisionMessages.shift();
  }

  private removePendingProjectClarification(questionId: string): void {
    for (let index = this.pendingDecisionMessages.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingDecisionMessages[index];
      if (pending.kind === 'project-clarification' && pending.question.id === questionId) {
        this.pendingDecisionMessages.splice(index, 1);
      }
    }
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
      else if (message.kind === 'waiting') await this.sendWaitingDecision(message.record);
      else if (message.kind === 'project-clarification') await this.sendProjectClarification(message.projectId, message.question);
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

  private enqueueAuditRecord(record: SupervisorRecord): void {
    this.auditQueue = this.auditQueue
      .catch(() => undefined)
      .then(async () => {
        if (!this.channel || !this.config) return;
        const key = record.terminal.surfaceId;
        const status = reduceFeishuAuditTerminalStatus(this.auditTerminalStatuses.get(key), record);
        this.auditTerminalStatuses.set(key, status);
        try {
          const card = buildFeishuAuditStatusCard(status);
          const existing = this.auditStatusCards.get(key);
          let updated = false;
          if (existing) {
            try {
              await this.channel.updateCard(existing.messageId, card);
              updated = true;
            } catch (err) {
              console.warn('[feishu] update audit status card failed; sending a replacement', err);
            }
          }
          if (!updated) {
            const sent = await this.channel.send(this.config.chatId, { card });
            this.auditStatusCards.set(key, { messageId: sent.messageId, chatId: this.config.chatId });
            if (this.auditStatusCards.size > 100) {
              const oldest = this.auditStatusCards.keys().next().value as string;
              this.auditStatusCards.delete(oldest);
              this.auditTerminalStatuses.delete(oldest);
            }
          }
        } catch (err) {
          console.warn('[feishu] audit status card delivery failed', err);
        }
        const alert = buildFeishuAuditAlertCard(record, status);
        if (alert) {
          try {
            await this.channel.send(this.config.chatId, { card: alert });
          } catch (err) {
            console.warn('[feishu] audit alert delivery failed', err);
          }
        }
        // Keep card mutations ordered and below one group's bot message limit.
        await new Promise<void>((resolve) => setTimeout(resolve, 220));
      })
      .catch((err) => console.warn('[feishu] audit status delivery failed', err));
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
