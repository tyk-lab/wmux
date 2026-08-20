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
  const normalizedManagerAgent = managerAgent === 'kimi' || managerAgent === 'grok' ? managerAgent : 'codex';
  const normalizedSupervisorAgent = supervisorAgent === 'codex' || supervisorAgent === 'kimi' || supervisorAgent === 'grok'
    ? supervisorAgent
    : 'pi';
  const normalizedTaskAgent = taskAgent === 'kimi' || taskAgent === 'grok' ? taskAgent : 'codex';
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
  };
}

export function projectManagerSkillRelativePath(agent: ProjectManagerRuntimeAgent): string {
  if (agent === 'codex') return '.agents\\skills\\manage-project\\SKILL.md';
  if (agent === 'grok') return '.grok\\skills\\manage-project\\SKILL.md';
  return '.wmux\\project-manager\\manage-project\\SKILL.md';
}

export const PROJECT_MANAGER_PROTOCOL_REVISION = '3';

export const PROJECT_MANAGER_ALIGNMENT_GATE = [
  '每次启动、恢复或收到控制层事件时，先运行 wmux context 获取当前 capability 绑定的项目身份、需求/授权版本、门禁状态和可用命令；不得沿用旧会话记忆中的身份或授权。同一运行时收到相同协议版本的普通事件时，复用已加载协议，不得重复读取 manage-project 技能；仅新建/恢复运行时、显式调用技能或协议版本变化时重读。',
  '首次启动项目时只执行一次需求充分性检查；恢复时沿用持久化结论或待确认问题，不得重复对齐。',
  '存在会改变方案的实质歧义时，禁止只在项目管理终端输出问题后等待；必须执行 wmux project ask --project <项目ID>，使用 category=clarification，一次只问一个问题，提供 2-4 个互斥方案并设置 recommendedOptionId。',
  '需求充分时执行 wmux project alignment-confirm --project <项目ID>，JSON 包含 goalUnderstanding、scopeSummary、acceptanceSummary、reason；随后先用 wmux project goal-plan --project <项目ID> 保存当前主目标的 3-7 个阶段目标，再显式恢复。',
  '控制层已发送兜底问题时不得重复提问或恢复；答复到达后先用 wmux project update --project <项目ID> 写回约束。若仍有实质歧义，再进入下一轮结构化提问。',
  '执行阶段的技术方案、任务路由、依赖调整、有限重试和原目标内重规划由项目管理 AI 决定；只有确需人工操作或用户专属决定时才用 category=manual-intervention，并附 workItemId、blocker 及允许的 reasonCode。',
  '用户已写入项目的前置条件及其中明确授权，在当前需求版本内持续有效；用户未通知变化且没有具体反证时，不得让项目 AI、监督 AI 或任务 AI 逐步重复确认。任务 AI 自身再次询问不代表条件已变化。',
  '项目是稳定容器，当前主目标是可切换的版本：调整同一结果使用 mode=refine；同一项目切换新的最终结果使用 mode=pivot。项目范围变化应建议另建项目。旧 goalId 任务不得在新目标下复活。',
].join('\n');

export function projectManagerRoleAnchor(projectId: string): string {
  return [
    '[项目 AI 角色锚点｜控制层]',
    `你是项目 ${projectId} 的专属项目 AI，只能管理这一个项目。`,
    `项目管理协议版本：${PROJECT_MANAGER_PROTOCOL_REVISION}。本运行时加载一次；相同版本的普通事件不得重复读取 manage-project 技能。`,
    '先运行 wmux context 获取实时身份、状态、权限和命令；该结果由当前终端 capability 绑定，不接受手工指定项目身份。',
    '不得直接修改项目交付文件、执行实现/测试，或使用通用 send/send-key 控制监督 AI 与任务 AI。',
  ].join('\n');
}

export function withProjectManagerRoleAnchor(text: string, projectId: string): string {
  const anchor = projectManagerRoleAnchor(projectId);
  return text.startsWith(anchor) ? text : `${anchor}\n\n${text}`;
}

export function projectManagerEventEnvelope(projectId: string): string {
  return [
    `[项目事件｜控制层｜project=${projectId}｜protocol=${PROJECT_MANAGER_PROTOCOL_REVISION}]`,
    '先运行 wmux context 获取实时状态；协议版本未变化，继续使用本运行时已加载的协议，无需重读技能或重新确认角色。',
    '项目 AI 只处理主目标、可验收阶段、依赖和硬安全边界；监督 AI 在该边界内自行维护路线与内部里程碑，不要把任务 AI 的每个检查点拆成新工作项。',
  ].join('\n');
}

function stripLeadingProjectManagerControlEnvelope(text: string): string {
  if (!text.startsWith('[项目 AI 角色锚点｜控制层]\n')
    && !text.startsWith('[项目事件｜控制层｜')) {
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

export function projectManagerStartupInput(
  agent: ProjectManagerRuntimeAgent,
  skillPath: string,
  projectId: string,
): string {
  const projectAnchor = [
    projectManagerRoleAnchor(projectId),
    `启动后先运行 wmux project status --project ${projectId}；不得读取、比较、暂停、恢复或决定其他项目。`,
    '项目列表、批量暂停/恢复和运行时路由属于无决策权的项目中心，不属于你的职责。',
  ].join('\n');
  if (agent === 'codex') return `$manage-project\n\n${projectAnchor}\n\n${PROJECT_MANAGER_ALIGNMENT_GATE}`;
  if (agent === 'grok') return `/manage-project\n\n${projectAnchor}\n\n${PROJECT_MANAGER_ALIGNMENT_GATE}`;
  return `请读取并严格执行项目管理协议文件：${skillPath}。\n\n${projectAnchor}\n\n${PROJECT_MANAGER_ALIGNMENT_GATE}`;
}
