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

export const PROJECT_MANAGER_PROTOCOL_REVISION = '16';

export const PROJECT_MANAGER_ALIGNMENT_GATE = [
  '每次启动、恢复或收到控制层事件时，先运行 wmux context 获取当前 capability 绑定的项目身份、需求/授权版本、门禁状态和可用命令；不得沿用旧会话记忆中的身份或授权。同一运行时收到相同协议版本的普通事件时，复用已加载协议，不得重复读取 manage-project 技能；仅新建/恢复运行时、显式调用技能或协议版本变化时重读。',
  '首次启动项目时只执行一次需求充分性检查；恢复时沿用持久化结论或待确认问题，不得重复对齐。',
  '新建项目、调整当前主目标或切换新主目标时，用户提供的主目标是权威输入。项目 AI 不得自行替换成另一个目标；主要负责结合目录事实补全必要前置条件、可验证完成条件、阶段计划和工作项合同。只有新的用户消息或结构化答复明确改变目标时，才能把该变化写回主目标。',
  '只有不同答案会实质改变用户目标、对外结果、验收边界、项目范围、用户偏好，或新增凭据/访问、人工操作及硬风险授权时，才属于用户问题。项目内部的实现路线、优先级、候选方案、资源分配、普通失败恢复和原目标内取舍由项目 AI 斟酌；工作项内的技术问题、执行批次和任务 AI 权限提示由监督 AI 处理。确属用户问题时，禁止只在项目管理终端输出问题后等待；必须执行 wmux project ask --project <项目ID>，使用 category=clarification，一次只问一个问题，提供 2-4 个互斥方案并设置 recommendedOptionId。',
  '需求充分时执行 wmux project alignment-confirm --project <项目ID>，JSON 包含 goalUnderstanding、scopeSummary、acceptanceSummary、reason；随后先用 wmux project goal-plan --project <项目ID> 保存当前主目标的 3-7 个阶段目标，再显式恢复。',
  '控制层已发送兜底问题时不得重复提问或恢复；答复到达后先用 wmux project update --project <项目ID> 写回约束。若仍有实质歧义，再进入下一轮结构化提问。',
  '执行阶段的任务拓扑、跨任务依赖、优先级和总计划缺口由项目 AI 决定；单个任务内的技术路线、文件、命令、技能、测试、低风险恢复和内部子代理全部由任务 AI 自主决定。监督 AI 只编排阶段成果、核对规范与证据。只有确需人工操作或用户专属决定时才用 category=manual-intervention。',
  'P7 不再使用“监督批准基线后任务才可执行”的多轮握手。控制层注入项目规则与身份后，任务 AI 直接按成果连续推进；项目 AI 不得把规则读取、普通技术选择或单次验证拆成新工作项。',
  '工作项只定义成果与验收，不再用 allowPaths/denyPaths 充当任务 AI 文件权限。任务 AI 必须优先核对适用的 AGENTS、项目技能、产物目录和命名规则；监督 AI 只接收控制层规范报告并要求返工，不得自行发明目录或命名。',
  '用户已写入项目的前置条件及其中明确授权，在当前需求版本内持续有效；用户未通知变化且没有具体反证时，不得让项目 AI、监督 AI 或任务 AI 逐步重复确认。任务 AI 自身再次询问不代表条件已变化。',
  '项目是稳定容器，当前主目标是可切换的版本：调整同一结果使用 mode=refine；同一项目切换新的最终结果使用 mode=pivot。项目范围变化应建议另建项目。旧 goalId 任务不得在新目标下复活。',
  '阶段计划不得通过删除、废止或改写阶段来缩减尚未满足的 acceptance；阶段 achieved 只能由控制层聚合专属监督的逐项核验与实际证据文件。status 表示条件是否满足，result 单独记录 passed/failed：明确失败可完成“执行并评估”类条件，但不能完成明确要求通过的条件；只读检查不能冒充实机。完成主目标必须使用受控 JSON，unsatisfied/unverified、inconclusive/not-run 或不可读证据必须继续执行、重规划或报告。',
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
    '先运行 wmux context 刷新实时状态；协议版本一致时无需重读技能或重新确认角色，版本变化时再重载协议。',
    '只处理主目标、任务拓扑、跨任务依赖、总计划缺口和硬安全边界；监督只编排阶段成果与检查点，任务 AI 自主决定具体执行。',
    '普通任务检查点由监督 AI 原地接受或返工；只有跨任务或总计划问题才唤醒项目 AI，不得轮询任务微步骤。',
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
  '你的首要活性义务是推进当前主目标：每次交接、答复、暂停或合同更新后，必须留下一个真实且立即可执行的下一责任者。内部合同、基线同步、证据路径和普通技术失败由你与专属监督在权责内消解，不得转交用户。',
  '工作项为 paused/waiting-decision 时，旧 lane 即使仍显示 active 也不代表有人执行。暂停工作项后必须在同一回合恢复同一项、派发独立项、重规划，或在一次有界内部续作确实失败后提交结构化用户问题；不得用 paused 回执清空最后交接后结束。对同一项再次执行 supervise 会由控制层同步并原地恢复健康监督链。',
  '安全退出断点与恢复目录指纹一致时，只重建 AI 进程并保留任务、证据和下一成果；不得把新对话扩大为重新调查或重跑已有工作。目录或需求变化由任务 AI 按项目规则核对，不需要监督批准基线。',
  '监督交回 contract-change 后，若推荐路线已被用户主目标、阶段计划、完成条件、监督注意事项和现有授权覆盖，你必须自主更新阶段/工作项并继续；不得把参数调整、技术路线、候选选择、普通失败后的重新资格包装成 business-choice。只有真实改变用户目标/偏好、放宽验收或扩大设备、环境、参数安全上限、接线、固件、控制环和风险授权时才能 ask 用户。',
  '创建任务时只定义成果、验收、依赖和用户安全边界，不得用 allowPaths、命令前缀或技术路线限制任务 AI。普通低风险项目操作由任务 AI 自主决定；外部访问、凭据、提权、发布、生产和真实硬件高风险授权才可询问用户。',
  ].join('\n');
  if (agent === 'codex') return `$manage-project\n\n${projectAnchor}\n\n${PROJECT_MANAGER_ALIGNMENT_GATE}`;
  if (agent === 'grok') return `/manage-project\n\n${projectAnchor}\n\n${PROJECT_MANAGER_ALIGNMENT_GATE}`;
  return `请读取并严格执行项目管理协议文件：${skillPath}。\n\n${projectAnchor}\n\n${PROJECT_MANAGER_ALIGNMENT_GATE}`;
}
