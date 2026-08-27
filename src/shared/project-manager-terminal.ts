export const PROJECT_MANAGER_TERMINAL_NAME = '项目 AI';
export const PROJECT_MANAGER_RUNTIME_PATH_SUFFIX = ['project-manager', 'runtime'] as const;

export type ProjectManagerRuntimeAgent = 'codex' | 'kimi' | 'grok';
export type ProjectSupervisorRuntimeAgent = ProjectManagerRuntimeAgent | 'pi';
export type ProjectTaskRuntimeAgent = ProjectManagerRuntimeAgent;

export interface ProjectAgentSelection<TAgent extends string> {
  agent: TAgent;
  model: string;
  reasoningEffort: string;
}

export interface ProjectManagementAgentConfig {
  manager: ProjectAgentSelection<ProjectManagerRuntimeAgent>;
  supervisor: ProjectAgentSelection<ProjectSupervisorRuntimeAgent>;
  task: ProjectAgentSelection<ProjectTaskRuntimeAgent>;
  auxiliary: ProjectAgentSelection<ProjectTaskRuntimeAgent> & {
    enabled: boolean;
    allowProjectMaintenance: boolean;
  };
}

export const DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG: ProjectManagementAgentConfig = {
  manager: { agent: 'codex', model: '', reasoningEffort: '' },
  supervisor: { agent: 'pi', model: '', reasoningEffort: 'medium' },
  task: { agent: 'codex', model: '', reasoningEffort: '' },
  auxiliary: {
    enabled: false,
    allowProjectMaintenance: false,
    agent: 'codex',
    model: '',
    reasoningEffort: '',
  },
};

export const PROJECT_MANAGER_TERMINAL_AGENT = DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG.manager.agent;

export function projectAgentDefaultReasoningEffort(agent: string): string {
  if (agent === 'codex' || agent === 'pi') return 'medium';
  return '';
}

export function normalizeProjectAgentReasoningEffort(agent: string, value: unknown, fallback?: string): string {
  if (typeof value !== 'string') return fallback ?? projectAgentDefaultReasoningEffort(agent);
  const effort = value.trim();
  if (!effort) return '';
  const allowed = agent === 'codex'
    ? ['low', 'medium', 'high', 'xhigh']
    : agent === 'pi'
      ? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'off']
      : agent === 'grok'
          ? ['low', 'medium', 'high']
        : [];
  return allowed.includes(effort) ? effort : projectAgentDefaultReasoningEffort(agent);
}

function normalizeProjectAgentModel(agent: string, value: unknown): string {
  const model = String(value || '').trim();
  if (agent === 'kimi' && /^(?:k3|k3-256k|kimi-for-coding(?:-highspeed)?)$/i.test(model)) {
    return `kimi-code/${model}`;
  }
  if (agent === 'codex' && model === 'gpt-5.4-codex-spark') return 'gpt-5.3-codex-spark';
  if (agent === 'grok' && model === 'grok-build') return 'grok-4.6';
  if (agent === 'pi' && model === 'xai/grok-build-0.1') return 'xai/grok-4.6';
  return model;
}

export function normalizeProjectManagementAgentConfig(
  value: Partial<ProjectManagementAgentConfig> | null | undefined,
): ProjectManagementAgentConfig {
  const managerAgent = value?.manager?.agent;
  const supervisorAgent = value?.supervisor?.agent;
  const taskAgent = value?.task?.agent;
  const auxiliaryAgent = value?.auxiliary?.agent;
  const normalizedManagerAgent = managerAgent === 'kimi' || managerAgent === 'grok' ? managerAgent : 'codex';
  const normalizedSupervisorAgent = supervisorAgent === 'codex' || supervisorAgent === 'kimi' || supervisorAgent === 'grok'
    ? supervisorAgent
    : 'pi';
  const normalizedTaskAgent = taskAgent === 'kimi' || taskAgent === 'grok' ? taskAgent : 'codex';
  const normalizedAuxiliaryAgent = auxiliaryAgent === 'kimi' || auxiliaryAgent === 'grok'
    ? auxiliaryAgent
    : 'codex';
  const auxiliaryEnabled = value?.auxiliary?.enabled === true;
  return {
    manager: {
      agent: normalizedManagerAgent,
      model: normalizeProjectAgentModel(normalizedManagerAgent, value?.manager?.model),
      reasoningEffort: normalizeProjectAgentReasoningEffort(normalizedManagerAgent, value?.manager?.reasoningEffort, ''),
    },
    supervisor: {
      agent: normalizedSupervisorAgent,
      model: normalizeProjectAgentModel(normalizedSupervisorAgent, value?.supervisor?.model),
      reasoningEffort: normalizeProjectAgentReasoningEffort(normalizedSupervisorAgent, value?.supervisor?.reasoningEffort),
    },
    task: {
      agent: normalizedTaskAgent,
      model: normalizeProjectAgentModel(normalizedTaskAgent, value?.task?.model),
      reasoningEffort: normalizeProjectAgentReasoningEffort(normalizedTaskAgent, value?.task?.reasoningEffort, ''),
    },
    auxiliary: {
      enabled: auxiliaryEnabled,
      allowProjectMaintenance: auxiliaryEnabled && value?.auxiliary?.allowProjectMaintenance === true,
      agent: normalizedAuxiliaryAgent,
      model: normalizeProjectAgentModel(normalizedAuxiliaryAgent, value?.auxiliary?.model),
      reasoningEffort: normalizeProjectAgentReasoningEffort(
        normalizedAuxiliaryAgent,
        value?.auxiliary?.reasoningEffort,
        '',
      ),
    },
  };
}

export const PROJECT_MANAGER_PROTOCOL_REVISION = '43';

export function projectManagerEventEnvelope(projectId: string): string {
  return [
    `[项目事件｜控制层｜project=${projectId}｜protocol=${PROJECT_MANAGER_PROTOCOL_REVISION}]`,
    '先运行 wmux context 刷新实时状态；协议版本一致时无需重读 AGENTS.md 或重新确认角色，版本变化时再重载协议。',
    '只处理主目标、任务拓扑、跨任务依赖、总计划缺口和硬安全边界；监督只编排阶段成果与检查点，任务 AI 自主决定具体执行。',
    '普通任务检查点由监督 AI 原地接受或返工；只有跨任务或总计划问题才唤醒项目 AI，不得轮询任务微步骤。',
  ].join('\n');
}

function stripLeadingProjectManagerControlEnvelope(text: string): string {
  if (!text.startsWith('[项目事件｜控制层｜')) {
    return text;
  }
  const separatorIndex = text.indexOf('\n\n');
  return separatorIndex >= 0 ? text.slice(separatorIndex + 2) : '';
}

export function withProjectManagerEventEnvelope(text: string, projectId: string): string {
  const envelope = projectManagerEventEnvelope(projectId);
  if (text === envelope || text.startsWith(`${envelope}\n\n`)) return text;
  const body = stripLeadingProjectManagerControlEnvelope(text);
  return body ? `${envelope}\n\n${body}` : envelope;
}

export function projectManagerStartupInput(projectId: string): string {
  return [
    '[项目 AI 启动｜控制层]',
    `当前 capability 预期绑定项目：${projectId}`,
    `角色协议：当前隔离目录 AGENTS.md（protocol=${PROJECT_MANAGER_PROTOCOL_REVISION}）`,
    'AGENTS.md 只含稳定角色规则；不要等待控制层重复发送协议正文。',
    '先运行 wmux context 获取实时项目身份、需求/授权版本、门禁状态和可用命令。',
    `随后运行 wmux role-ready --protocol ${PROJECT_MANAGER_PROTOCOL_REVISION}；成功前不得规划、提问、创建工作项或派发任务。`,
  ].join('\n');
}
