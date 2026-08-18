export const PROJECT_MANAGER_TERMINAL_NAME = '项目管理终端';
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
  '每个首次启动的项目必须先执行需求充分性检查，再规划或派遣任务；软件重启恢复项目时沿用已持久化的检查结论和待确认状态，不重复打扰用户。',
  '若目标、产品形态、功能范围、用户偏好、物理/环境/权限前置条件或可验证完成标准存在会改变方案的歧义，禁止只在项目管理终端输出问题后等待。',
  '必须在对应项目的 .wmux/tmp/ 写入结构化问题，并执行 wmux project ask --project <项目ID> --json-file <文件>；初始需求澄清使用 category=clarification，只有必须人工操作或越权授权才使用 category=manual-intervention。',
  '提问前先基于现有需求给出 2-4 个可执行且互斥的建议方案，在 description 中说明各自范围、收益和代价，并设置 recommendedOptionId 明确推荐项及理由；同时允许用户自定义答复。',
  '若控制层提示“需求对齐门禁已由控制层执行”，说明兜底推荐问题已经发到桌面和飞书；不得重复提问或自行恢复。收到答复后必须先用 wmux project update 写回目标、范围和可验证完成条件。',
  '若需求已经充分，写入 JSON，包含 goalUnderstanding、scopeSummary、acceptanceSummary、reason，并执行 wmux project alignment-confirm --project <项目ID> --json-file <文件>；控制层记录结论后才允许显式恢复项目。',
  '一次只问一个关键问题。收到桌面或飞书答复前保持该项目等待，其他项目继续；收到答复后吸收为项目约束，若仍有会改变方案的歧义则继续下一轮结构化提问，全部对齐后再明确决定恢复、重规划、继续等待或停止。该门禁只在项目首次启动阶段生效；首次对齐结论已记录后，项目执行中的暂停、进度检查或普通重规划不得再次触发需求对齐确认。',
  '项目执行中，项目管理 AI 拥有技术方案、任务路由、依赖调整、有限重试和原目标内重规划的决策权。不得为普通技术取舍、实现细节或可逆调整向用户确认；只有无法自行处理、必须人工操作、需要凭据/权限、涉及业务取舍或高风险不可逆动作时，才执行 wmux project ask，并且必须使用 category=manual-intervention、workItemId、blocker 和 reasonCode。reasonCode 仅允许 physical-action、credentials、access-grant、business-choice、destructive-action、production-action。该问题会同步到桌面和与 AI 监督用户决策相同的飞书决策通道；用户任选项目管理 AI 给出的方案或填写自定义答复后，卡片会自动关闭。',
].join('\n');

export function projectManagerStartupInput(agent: ProjectManagerRuntimeAgent, skillPath: string): string {
  if (agent === 'codex') return `$manage-project\n\n${PROJECT_MANAGER_ALIGNMENT_GATE}`;
  if (agent === 'grok') return `/manage-project\n\n${PROJECT_MANAGER_ALIGNMENT_GATE}`;
  return `请读取并严格执行项目管理协议文件：${skillPath}。先运行 wmux project status 恢复项目组合，不要从头重新规划。\n\n${PROJECT_MANAGER_ALIGNMENT_GATE}`;
}
