export const SUPERVISOR_CONFIG_FILE_KIND = 'wmux-ai-supervisor-config';
export const SUPERVISOR_CONFIG_FILE_VERSION = 1;

export interface SupervisorConfigFileData {
  taskDescription: string;
  preconditions: string;
  stopWhen: string;
  stopWhenKind: 'direction' | 'concrete';
  planFilePath: string;
  supervisorLaunchCmd: string;
  supervisorModel: string;
  supervisorReasoningEffort: string;
  maxAutoDecisions: number | null;
}

interface SupervisorConfigFile {
  kind: typeof SUPERVISOR_CONFIG_FILE_KIND;
  version: typeof SUPERVISOR_CONFIG_FILE_VERSION;
  config: SupervisorConfigFileData;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, 30_000) : fallback;
}

function maxAutoDecisions(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(20, parsed) : null;
}

/** Validate untrusted renderer/file data before it becomes a supervisor form preset. */
export function normalizeSupervisorConfig(value: unknown): SupervisorConfigFileData {
  const config = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    taskDescription: text(config.taskDescription),
    preconditions: text(config.preconditions),
    stopWhen: text(config.stopWhen),
    stopWhenKind: config.stopWhenKind === 'direction' ? 'direction' : 'concrete',
    planFilePath: text(config.planFilePath),
    supervisorLaunchCmd: text(config.supervisorLaunchCmd, 'codex'),
    supervisorModel: text(config.supervisorModel),
    supervisorReasoningEffort: text(config.supervisorReasoningEffort),
    maxAutoDecisions: maxAutoDecisions(config.maxAutoDecisions),
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
    const file = JSON.parse(content) as Partial<SupervisorConfigFile>;
    if (file.kind !== SUPERVISOR_CONFIG_FILE_KIND || file.version !== SUPERVISOR_CONFIG_FILE_VERSION) {
      return { error: '不是受支持的 AI 监督配置文件' };
    }
    return normalizeSupervisorConfig(file.config);
  } catch {
    return { error: '配置文件不是有效的 JSON' };
  }
}
