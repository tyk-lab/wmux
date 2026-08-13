import {
  normalizeSupervisorAutonomyPermissions,
  normalizeSupervisorForbiddenActions,
  normalizeSupervisorWorkScope,
  SUPERVISOR_FORBIDDEN_ACTION_VALUES,
  type SupervisorAutonomyPermission,
  type SupervisorForbiddenAction,
  type SupervisorWorkScope,
} from '../shared/supervisor-policy';
import {
  normalizeTaskChildThreadResponsibilities,
  normalizeTaskThreadResponsibility,
  normalizeTaskWorkMode,
  type TaskWorkMode,
} from '../shared/supervisor-work-mode';

export const SUPERVISOR_CONFIG_FILE_KIND = 'wmux-ai-supervisor-config';
export const SUPERVISOR_CONFIG_FILE_VERSION = 4;

export interface SupervisorTerminalConfigFileData {
  surfaceId: string;
  label: string;
  taskGoal: string;
  taskDescription: string;
  preconditions: string;
  stopWhen: string;
  stopWhenKind: 'direction' | 'concrete';
  waitForNextDirection: boolean;
  planFilePath: string;
  taskWorkMode: TaskWorkMode;
  mainThreadResponsibility: string;
  childThreadResponsibilities: string[];
  restoreTaskContext: boolean;
  autonomyPermissionsOverride?: SupervisorAutonomyPermission[];
  autonomousOverride?: boolean;
  forbiddenActionsOverride?: SupervisorForbiddenAction[];
}

export interface SupervisorConfigFileData {
  taskGoal: string;
  taskDescription: string;
  preconditions: string;
  stopWhen: string;
  stopWhenKind: 'direction' | 'concrete';
  waitForNextDirection: boolean;
  planFilePath: string;
  taskWorkMode: TaskWorkMode;
  mainThreadResponsibility: string;
  childThreadResponsibilities: string[];
  restoreTaskContext: boolean;
  supervisorLaunchCmd: string;
  supervisorModel: string;
  supervisorReasoningEffort: string;
  maxAutoDecisions: number | null;
  autonomyPermissions: SupervisorAutonomyPermission[];
  workScope: SupervisorWorkScope;
  forbiddenActions: SupervisorForbiddenAction[];
  terminals: SupervisorTerminalConfigFileData[];
}

interface SupervisorConfigFile {
  kind: typeof SUPERVISOR_CONFIG_FILE_KIND;
  version: typeof SUPERVISOR_CONFIG_FILE_VERSION;
  config: SupervisorConfigFileData;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, 30_000) : fallback;
}

function maxAutoDecisions(value: unknown, legacyDefaults: boolean): number | null {
  if (value === null) return null;
  if (value === undefined || value === '') return legacyDefaults ? null : 1;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.min(20, parsed)
    : legacyDefaults ? null : 1;
}

function terminalConfig(value: unknown): SupervisorTerminalConfigFileData | null {
  if (!value || typeof value !== 'object') return null;
  const config = value as Record<string, unknown>;
  const surfaceId = text(config.surfaceId).trim();
  if (!surfaceId) return null;
  const normalizedPermissions = Array.isArray(config.autonomyPermissionsOverride)
    ? normalizeSupervisorAutonomyPermissions(config.autonomyPermissionsOverride)
    : undefined;
  const normalizedForbiddenActions = Array.isArray(config.forbiddenActionsOverride)
    ? normalizeSupervisorForbiddenActions(config.forbiddenActionsOverride)
    : undefined;
  return {
    surfaceId,
    label: text(config.label),
    taskGoal: text(config.taskGoal),
    taskDescription: text(config.taskDescription),
    preconditions: text(config.preconditions),
    stopWhen: text(config.stopWhen),
    stopWhenKind: config.stopWhenKind === 'direction' ? 'direction' : 'concrete',
    waitForNextDirection: config.waitForNextDirection === true,
    planFilePath: text(config.planFilePath),
    taskWorkMode: normalizeTaskWorkMode(config.taskWorkMode),
    mainThreadResponsibility: normalizeTaskThreadResponsibility(config.mainThreadResponsibility),
    childThreadResponsibilities: normalizeTaskChildThreadResponsibilities(
      config.childThreadResponsibilities,
    ),
    restoreTaskContext: config.restoreTaskContext === true,
    ...(normalizedPermissions ? { autonomyPermissionsOverride: normalizedPermissions } : {}),
    ...(typeof config.autonomousOverride === 'boolean'
      ? { autonomousOverride: config.autonomousOverride }
      : {}),
    ...(normalizedForbiddenActions ? { forbiddenActionsOverride: normalizedForbiddenActions } : {}),
  };
}

function terminalConfigs(value: unknown): SupervisorTerminalConfigFileData[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const configs: SupervisorTerminalConfigFileData[] = [];
  for (const item of value) {
    const config = terminalConfig(item);
    if (!config || seen.has(config.surfaceId)) continue;
    seen.add(config.surfaceId);
    configs.push(config);
  }
  return configs;
}

/** Validate untrusted renderer/file data before it becomes a supervisor form preset. */
export function normalizeSupervisorConfig(
  value: unknown,
  legacyDefaults = false,
): SupervisorConfigFileData {
  const config = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    taskGoal: text(config.taskGoal),
    taskDescription: text(config.taskDescription),
    preconditions: text(config.preconditions),
    stopWhen: text(config.stopWhen),
    stopWhenKind: config.stopWhenKind === 'direction' ? 'direction' : 'concrete',
    waitForNextDirection: config.waitForNextDirection === true,
    planFilePath: text(config.planFilePath),
    taskWorkMode: normalizeTaskWorkMode(config.taskWorkMode),
    mainThreadResponsibility: normalizeTaskThreadResponsibility(config.mainThreadResponsibility),
    childThreadResponsibilities: normalizeTaskChildThreadResponsibilities(
      config.childThreadResponsibilities,
    ),
    restoreTaskContext: config.restoreTaskContext === true,
    supervisorLaunchCmd: text(config.supervisorLaunchCmd, 'pi'),
    supervisorModel: text(config.supervisorModel),
    supervisorReasoningEffort: text(config.supervisorReasoningEffort),
    maxAutoDecisions: maxAutoDecisions(config.maxAutoDecisions, legacyDefaults),
    autonomyPermissions: !legacyDefaults && config.autonomyPermissions === undefined
      ? []
      : normalizeSupervisorAutonomyPermissions(config.autonomyPermissions),
    workScope: !legacyDefaults && config.workScope === undefined
      ? 'task-files'
      : normalizeSupervisorWorkScope(config.workScope),
    forbiddenActions: !legacyDefaults && config.forbiddenActions === undefined
      ? [...SUPERVISOR_FORBIDDEN_ACTION_VALUES]
      : normalizeSupervisorForbiddenActions(config.forbiddenActions),
    terminals: terminalConfigs(config.terminals),
  };
}

export function serializeSupervisorConfig(config: unknown): string {
  const normalized = normalizeSupervisorConfig(config);
  if (normalized.terminals.length === 0) {
    throw new Error('AI 监督配置至少需要包含一个有效终端');
  }
  const file: SupervisorConfigFile = {
    kind: SUPERVISOR_CONFIG_FILE_KIND,
    version: SUPERVISOR_CONFIG_FILE_VERSION,
    config: normalized,
  };
  return JSON.stringify(file, null, 2) + '\n';
}

export function parseSupervisorConfig(content: string): SupervisorConfigFileData | { error: string } {
  try {
    const file = JSON.parse(content) as {
      kind?: string;
      version?: number;
      config?: unknown;
    };
    const supportedVersion = file.version === 1
      || file.version === 2
      || file.version === 3
      || file.version === SUPERVISOR_CONFIG_FILE_VERSION;
    if (file.kind !== SUPERVISOR_CONFIG_FILE_KIND || !supportedVersion) {
      return { error: '不是受支持的 AI 监督配置文件' };
    }
    if ((file.version === 2 || file.version === 3 || file.version === SUPERVISOR_CONFIG_FILE_VERSION)
      && (!file.config || typeof file.config !== 'object' || Array.isArray(file.config))) {
      return { error: 'AI 监督配置缺少有效的 config 对象' };
    }
    const config = normalizeSupervisorConfig(file.config, file.version === 1);
    if (file.version === SUPERVISOR_CONFIG_FILE_VERSION) {
      if (!Array.isArray((file.config as Record<string, unknown>).terminals)
        || config.terminals.length === 0) {
        return { error: 'AI 监督 V4 配置至少需要包含一个有效终端' };
      }
      return config;
    }
    return { ...config, terminals: [] };
  } catch {
    return { error: '配置文件不是有效的 JSON' };
  }
}
