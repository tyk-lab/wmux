import {
  normalizeSupervisorAutonomyPermissions,
  normalizeSupervisorForbiddenActions,
  normalizeSupervisorWorkScope,
  SUPERVISOR_FORBIDDEN_ACTION_VALUES,
  type SupervisorAutonomyPermission,
  type SupervisorForbiddenAction,
  type SupervisorWorkScope,
} from '../shared/supervisor-policy';

export const SUPERVISOR_CONFIG_FILE_KIND = 'wmux-ai-supervisor-config';
export const SUPERVISOR_CONFIG_FILE_VERSION = 2;

export interface SupervisorConfigFileData {
  taskGoal: string;
  taskDescription: string;
  preconditions: string;
  stopWhen: string;
  stopWhenKind: 'direction' | 'concrete';
  planFilePath: string;
  supervisorLaunchCmd: string;
  supervisorModel: string;
  supervisorReasoningEffort: string;
  maxAutoDecisions: number | null;
  autonomyPermissions: SupervisorAutonomyPermission[];
  workScope: SupervisorWorkScope;
  forbiddenActions: SupervisorForbiddenAction[];
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
    planFilePath: text(config.planFilePath),
    supervisorLaunchCmd: text(config.supervisorLaunchCmd, 'codex'),
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
  };
}

export function serializeSupervisorConfig(config: unknown): string {
  const file: SupervisorConfigFile = {
    kind: SUPERVISOR_CONFIG_FILE_KIND,
    version: SUPERVISOR_CONFIG_FILE_VERSION,
    config: normalizeSupervisorConfig(config),
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
    const supportedVersion = file.version === 1 || file.version === SUPERVISOR_CONFIG_FILE_VERSION;
    if (file.kind !== SUPERVISOR_CONFIG_FILE_KIND || !supportedVersion) {
      return { error: '不是受支持的 AI 监督配置文件' };
    }
    if (file.version === SUPERVISOR_CONFIG_FILE_VERSION && (!file.config || typeof file.config !== 'object')) {
      return { error: 'AI 监督配置缺少有效的 config 对象' };
    }
    return normalizeSupervisorConfig(file.config, file.version === 1);
  } catch {
    return { error: '配置文件不是有效的 JSON' };
  }
}
