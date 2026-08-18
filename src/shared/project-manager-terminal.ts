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
}

export const DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG: ProjectManagementAgentConfig = {
  manager: { agent: 'codex', model: '', reasoningEffort: '' },
  supervisor: { agent: 'pi', model: '', reasoningEffort: 'medium' },
  task: { agent: 'codex', model: '', reasoningEffort: '' },
};

export const PROJECT_MANAGER_TERMINAL_AGENT = DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG.manager.agent;

export function projectAgentDefaultReasoningEffort(agent: string): string {
  if (agent === 'codex' || agent === 'pi') return 'medium';
  if (agent === 'kimi') return 'on';
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
      : agent === 'kimi'
        ? ['on']
        : [];
  return allowed.includes(effort) ? effort : projectAgentDefaultReasoningEffort(agent);
}

export function normalizeProjectManagementAgentConfig(
  value: Partial<ProjectManagementAgentConfig> | null | undefined,
): ProjectManagementAgentConfig {
  const managerAgent = value?.manager?.agent;
  const supervisorAgent = value?.supervisor?.agent;
  const taskAgent = value?.task?.agent;
  const normalizedManagerAgent = managerAgent === 'kimi' || managerAgent === 'grok' ? managerAgent : 'codex';
  const normalizedSupervisorAgent = supervisorAgent === 'codex' || supervisorAgent === 'kimi' || supervisorAgent === 'grok'
    ? supervisorAgent
    : 'pi';
  const normalizedTaskAgent = taskAgent === 'kimi' || taskAgent === 'grok' ? taskAgent : 'codex';
  return {
    manager: {
      agent: normalizedManagerAgent,
      model: String(value?.manager?.model || '').trim(),
      reasoningEffort: normalizeProjectAgentReasoningEffort(normalizedManagerAgent, value?.manager?.reasoningEffort, ''),
    },
    supervisor: {
      agent: normalizedSupervisorAgent,
      model: String(value?.supervisor?.model || '').trim(),
      reasoningEffort: normalizeProjectAgentReasoningEffort(normalizedSupervisorAgent, value?.supervisor?.reasoningEffort),
    },
    task: {
      agent: normalizedTaskAgent,
      model: String(value?.task?.model || '').trim(),
      reasoningEffort: normalizeProjectAgentReasoningEffort(normalizedTaskAgent, value?.task?.reasoningEffort, ''),
    },
  };
}

export function projectManagerSkillRelativePath(agent: ProjectManagerRuntimeAgent): string {
  if (agent === 'codex') return '.agents\\skills\\manage-project\\SKILL.md';
  if (agent === 'grok') return '.grok\\skills\\manage-project\\SKILL.md';
  return '.wmux\\project-manager\\manage-project\\SKILL.md';
}

export const PROJECT_MANAGER_ALIGNMENT_GATE = [
  '首次启动项目时只执行一次需求充分性检查；恢复时沿用持久化结论或待确认问题，不得重复对齐。',
  '存在会改变方案的实质歧义时，禁止只在项目管理终端输出问题后等待；必须执行 wmux project ask --project <项目ID>，使用 category=clarification，一次只问一个问题，提供 2-4 个互斥方案并设置 recommendedOptionId。',
  '需求充分时执行 wmux project alignment-confirm --project <项目ID>，JSON 包含 goalUnderstanding、scopeSummary、acceptanceSummary、reason；记录后再显式恢复。',
  '控制层已发送兜底问题时不得重复提问或恢复；答复到达后先用 wmux project update --project <项目ID> 写回约束。若仍有实质歧义，再进入下一轮结构化提问。',
  '执行阶段的技术方案、任务路由、依赖调整、有限重试和原目标内重规划由项目管理 AI 决定；只有确需人工操作或用户专属决定时才用 category=manual-intervention，并附 workItemId、blocker 及允许的 reasonCode。',
  '用户已写入项目的前置条件及其中明确授权，在当前需求版本内持续有效；用户未通知变化且没有具体反证时，不得让项目 AI、监督 AI 或任务 AI 逐步重复确认。任务 AI 自身再次询问不代表条件已变化。',
].join('\n');

export function projectManagerStartupInput(
  agent: ProjectManagerRuntimeAgent,
  skillPath: string,
  projectId: string,
): string {
  const projectAnchor = [
    `你是项目 ${projectId} 的专属项目 AI，只能管理这一个项目。`,
    `启动后先运行 wmux project status --project ${projectId}；不得读取、比较、暂停、恢复或决定其他项目。`,
    '项目列表、批量暂停/恢复和运行时路由属于无决策权的项目中心，不属于你的职责。',
  ].join('\n');
  if (agent === 'codex') return `$manage-project\n\n${projectAnchor}\n\n${PROJECT_MANAGER_ALIGNMENT_GATE}`;
  if (agent === 'grok') return `/manage-project\n\n${projectAnchor}\n\n${PROJECT_MANAGER_ALIGNMENT_GATE}`;
  return `请读取并严格执行项目管理协议文件：${skillPath}。\n\n${projectAnchor}\n\n${PROJECT_MANAGER_ALIGNMENT_GATE}`;
}
