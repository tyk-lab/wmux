import {
  activeProjectGoal,
  activeProjectSubgoals,
  projectAuthorizationVersion,
  projectRequirementsVersion,
  projectTaskBaselineApproved,
  projectWorkItemReady,
  type ProjectManagerSession,
  type ProjectSupervisorContract,
  type ProjectTaskBaseline,
  type ProjectWorkItem,
} from '../../shared/project-manager';

export const PROJECT_TASK_EXECUTION_ENVELOPE_MARKER = '[项目任务连续执行契约]';
export const PROJECT_TASK_BASELINE_INVESTIGATION_MARKER = '[项目基线调查]';
export const PROJECT_TASK_BASELINE_REPORT_MARKER = '[项目基线报告]';
export const PROJECT_TASK_BASELINE_APPROVAL_MARKER = '[批准项目基线]';

export function isProjectTargetedTestCommand(command: string): boolean {
  return /^\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test(?::[^\s]+)?|vitest|jest)|npx\s+(?:vitest|jest)|python(?:\.exe)?\s+-m\s+pytest|pytest|vitest|jest|cargo\s+test|go\s+test|dotnet\s+test|ctest|mvn\s+test|(?:gradle|gradlew|\.\/gradlew)\s+test)\b/i.test(command);
}

function normalizedCommand(value: string): string {
  return value.trim().toLowerCase().replace(/["'`]/gu, '').replace(/\s+/gu, ' ');
}

export function commandMatchesAuthorizedPrefix(command: string, prefixes: readonly string[]): boolean {
  if (/[\r\n;&|<>`]/u.test(command) || command.includes('$(')) return false;
  const candidate = normalizedCommand(command);
  return prefixes.some((prefix) => {
    const allowed = normalizedCommand(prefix);
    return allowed.length >= 2 && (candidate === allowed || candidate.startsWith(`${allowed} `));
  });
}

/** Project permission confirmation is opt-in and command-scoped; project mode itself grants nothing. */
export function projectPermissionAuthorizationError(
  contract: ProjectSupervisorContract,
  command: string,
): string | null {
  if (!contract.authority.permissionConfirm) {
    return '任务契约未授权监督 AI 自动确认权限';
  }
  if (isProjectTargetedTestCommand(command)) {
    if (!contract.authority.targetedTests) return '任务契约未授权监督 AI 运行测试';
    const prefixes = contract.authority.allowedCommandPrefixes || [];
    return prefixes.length === 0 || commandMatchesAuthorizedPrefix(command, prefixes)
      ? null
      : '测试命令不在任务契约 allowedCommandPrefixes 授权范围内';
  }
  return commandMatchesAuthorizedPrefix(command, contract.authority.allowedCommandPrefixes || [])
    ? null
    : '权限命令不在任务契约 allowedCommandPrefixes 授权范围内';
}

/** Require a reviewed, current workspace baseline before any project task can write or finish. */
export function projectTaskBaselineViolation(
  item: Pick<ProjectWorkItem, 'requirementsVersion' | 'baseline'>,
  proposal: {
    outcome: SupervisorDecisionOutcome;
    instruction?: string;
    changedFiles?: string[];
    testCommand?: string;
    fullSuite?: boolean;
    retry?: boolean;
    permissionResponse?: string;
    evidence?: string;
    workspaceVersion?: string;
  },
): string | null {
  if (projectTaskBaselineApproved(item) || proposal.outcome === 'needs-human') return null;
  if (proposal.permissionResponse) return '项目基线尚未审核，不能自动确认权限或执行写操作';
  if (proposal.outcome === 'complete') return '项目基线尚未审核，不能把工作项判定为完成';

  const instruction = proposal.instruction?.trim() || '';
  const investigationRequested = instruction.startsWith(PROJECT_TASK_BASELINE_INVESTIGATION_MARKER);
  const approvalRequested = instruction.includes(PROJECT_TASK_BASELINE_APPROVAL_MARKER);
  if (investigationRequested && approvalRequested) {
    return '项目基线调查与批准必须分成两轮，不能在尚未收到报告时预先批准';
  }
  if (!investigationRequested && !approvalRequested) {
    return `项目基线尚未审核；只能先下达以 ${PROJECT_TASK_BASELINE_INVESTIGATION_MARKER} 开头的只读调查，或在审查报告后使用 ${PROJECT_TASK_BASELINE_APPROVAL_MARKER}`;
  }
  if ((proposal.changedFiles || []).length > 0
    || !!proposal.testCommand?.trim()
    || proposal.fullSuite === true
    || proposal.retry === true) {
    return '项目基线门禁阶段只允许只读调查，不能报告任务写入、运行测试、全量验证或重试';
  }
  if (approvalRequested && item.baseline?.status !== 'investigating') {
    return '项目基线尚未完成已投递的只读调查轮次，不能预先批准';
  }
  if (approvalRequested && (
    !proposal.evidence?.trim()
    || !proposal.workspaceVersion?.trim()
  )) {
    return `批准项目基线必须同时提供 --evidence 和 --workspace-version，以记录已审查报告及当前工作区快照`;
  }
  return null;
}

type SupervisorDecisionOutcome = 'continue' | 'rework' | 'complete' | 'needs-human';

export function buildProjectTaskExecutionEnvelope(contract: ProjectSupervisorContract): string {
  const authority = contract.authority;
  const execution = contract.execution;
  const authorizedDevices = authority.authorizedDevices || [];
  const authorizedEnvironments = authority.authorizedEnvironments || [];
  const authorizedOperations = authority.authorizedOperations || [];
  const allowedCommandPrefixes = authority.allowedCommandPrefixes || [];
  const executionModeLines = execution?.taskWorkMode === 'adaptive'
    ? [
        `任务 AI 工作模式：自适应线程；这是唯一会依据基线调查结果动态决定单/多线程的模式。理由：${execution.modeReason}`,
        `主线程职责：${execution.mainThreadResponsibility}`,
        `内部子线程上限：${execution.maxChildThreads || 1}`,
        `可并行候选：${execution.parallelizableOperations?.join('；') || '无'}`,
        `必须串行：${execution.serializedOperations?.join('；') || '所有操作'}`,
        '先进行一次有界、只读的结构探测。若无需拆分，直接由主线程继续；若值得拆分，先输出“[内部线程提案]”，列出理由、线程数、职责、文件/路径所有权、依赖、共享资源、汇总与验证方式。收到监督 AI 带有明确 childThreads 数字的批准标记前不得创建内部子线程。',
        '共享硬件、设备上电/重上电、固件烧录、共享测试环境变更、破坏性动作和最终集成验证一律由主线程串行执行。内部线程只是本任务 AI 的工作组织，不得新建 wmux 任务终端。',
      ]
    : execution?.taskWorkMode === 'multi-thread'
      ? [
          `任务 AI 工作模式：固定多线程；不会自行切换模式。理由：${execution.modeReason}`,
          `主线程职责：${execution.mainThreadResponsibility}`,
          ...execution.childThreadResponsibilities.map((responsibility, index) => (
            `子线程 ${index + 1} 职责：${responsibility}`
          )),
          '内部线程仅属于本任务 AI，不得新建额外 wmux 任务终端；共享资源操作与最终集成由主线程串行完成。',
        ]
      : [
          `任务 AI 工作模式：固定单线程；不会依据复杂度自行创建内部线程。职责：${execution?.mainThreadResponsibility || contract.objective}`,
          '不得自行创建内部子线程或额外 wmux 任务终端。',
        ];
  return [
    PROJECT_TASK_EXECUTION_ENVELOPE_MARKER,
    `目标：${contract.objective}`,
    `停止条件：${contract.stopWhen.join('；')}`,
    `验证要求：${contract.validation.join('；')}`,
    contract.preconditions.length > 0 ? `任务前置条件：${contract.preconditions.join('；')}` : '',
    authorizedDevices.length > 0 ? `授权设备：${authorizedDevices.join('；')}` : '',
    authorizedEnvironments.length > 0 ? `授权环境：${authorizedEnvironments.join('；')}` : '',
    authorizedOperations.length > 0 ? `授权连续操作：${authorizedOperations.join('；')}` : '',
    allowedCommandPrefixes.length > 0 ? `允许由监督确认的命令前缀：${allowedCommandPrefixes.join('；')}` : '',
    authority.continuousExecution
      ? '执行方式：项目基线获批后，把上述范围作为一个连续工作流推进到停止条件；注册、映射、DRY_RUN、聚焦测试、实测和证据整理等已授权内部步骤不得逐步停下来索要同一确认。基线报告必须停止等待审核；获批后的普通内部里程碑只记录，不结束回合。'
      : '执行方式：仅执行监督 AI 本轮明确下达的单步指令，完成后返回证据。',
    '项目基线门禁：无论线程模式如何，在任何写入、依赖安装、构建/测试、设备操作或权限确认前，先执行监督 AI 以“[项目基线调查]”下达的有界只读调查。调查至少覆盖当前 git/未提交状态、相关目录与入口/调用链、已有构建测试约定、当前错误或缺口、预期改动路径与共享资源边界。',
    '调查完成后以“[项目基线报告]”返回工作区快照、证据、建议执行模式及下一安全动作，然后停止等待监督审核。只有收到“[批准项目基线]”才可开始实现；固定单/多线程不得静默改换，自适应模式才可另附“[内部线程提案]”。',
    ...executionModeLines,
    '只有发现已确认条件发生变化的具体证据、命令或目标越出合同、出现不可逆/生产/凭据/权限变更风险，或预算护栏触发时才停止并报告。普通工具确认提示和同一前置条件的重复询问不是停止理由。',
  ].filter(Boolean).join('\n');
}

export interface PreparedProjectTaskDelivery {
  action: string;
  delivery: string;
}

/** Keep the persisted contract authoritative while exposing only the executable action to guards. */
export function prepareProjectTaskDelivery(
  contract: ProjectSupervisorContract,
  instruction: string,
  contractPending: boolean,
): PreparedProjectTaskDelivery {
  const requested = instruction.trim();
  if (!contractPending) return { action: requested, delivery: requested };

  const envelope = buildProjectTaskExecutionEnvelope(contract);
  const legacyPayload = requested.startsWith(envelope)
    ? requested.slice(envelope.length).trim().replace(/^\[本轮执行指令\]\s*/u, '').trim()
    : requested;
  return {
    action: legacyPayload,
    delivery: legacyPayload
      ? `${envelope}\n\n[本轮执行指令]\n${legacyPayload}`
      : envelope,
  };
}

export function projectDependencyError(items: readonly ProjectWorkItem[]): string | null {
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== items.length) return '任务 ID 不能重复';
  for (const item of items) {
    const missing = item.dependencies.find((dependency) => !byId.has(dependency));
    if (missing) return `任务 ${item.id} 依赖不存在的任务 ${missing}`;
    if (item.dependencies.includes(item.id)) return `任务 ${item.id} 不能依赖自身`;
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const item = byId.get(id);
    if (item?.dependencies.some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return items.some((item) => visit(item.id)) ? '任务依赖不能形成循环' : null;
}

export function readyProjectWorkItems(session: ProjectManagerSession): ProjectWorkItem[] {
  if (session.status !== 'active') return [];
  const activeGoalId = activeProjectGoal(session).id;
  return session.workItems.filter((item) => (
    item.goalId === activeGoalId
    && item.requirementsVersion === projectRequirementsVersion(session)
    && item.authorizationVersion === projectAuthorizationVersion(session)
    && !projectWorkItemSubgoalDependencyError(session, item)
    && projectWorkItemReady(item, session.workItems)
  ));
}

/** A task may run only after every coarse stage dependency has been closed. */
export function projectWorkItemSubgoalDependencyError(
  session: ProjectManagerSession,
  item: ProjectWorkItem,
): string | null {
  const subgoals = activeProjectSubgoals(session);
  const subgoal = subgoals.find((candidate) => candidate.id === item.subgoalId);
  if (!subgoal) return '任务没有有效的当前阶段目标';
  const byId = new Map(subgoals.map((candidate) => [candidate.id, candidate]));
  const incomplete = subgoal.dependencies.find((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return !dependency || !['achieved', 'obsolete'].includes(dependency.status);
  });
  return incomplete
    ? `阶段目标 ${subgoal.id} 依赖尚未完成：${incomplete}`
    : null;
}

export type ProjectCompletionState = 'in-progress' | 'blocked' | 'ready-for-validation' | 'completed';

function normalizedContractPath(value: string, root: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const normalizedRoot = root.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalized.startsWith(`${normalizedRoot}/`)
    ? normalized.slice(normalizedRoot.length + 1)
    : normalized;
}

function pathInside(candidate: string, boundary: string): boolean {
  return candidate === boundary || candidate.startsWith(`${boundary}/`);
}

/** Enforce the parts of a project contract that can be proven from a structured decision. */
export function projectContractViolation(
  contract: ProjectSupervisorContract,
  proposal: {
    instruction?: string;
    command?: string;
    changedFiles?: string[];
    testCommand?: string;
    retry?: boolean;
  },
): string | null {
  const instruction = `${proposal.instruction || ''}\n${proposal.command || ''}`.toLowerCase().replace(/\\/g, '/');
  const threadApprovalRequested = instruction.includes('[批准内部线程方案');
  if (threadApprovalRequested) {
    const approval = instruction.match(/\[批准内部线程方案\s+childthreads=(\d+)\]/u);
    const execution = contract.execution;
    if (execution?.taskWorkMode !== 'adaptive'
      || !contract.authority.internalThreads
      || execution.supervisorMayApproveThreads !== true) {
      return '任务契约未授权监督 AI 审批自适应内部线程方案';
    }
    if (!approval) return '内部线程审批必须使用 [批准内部线程方案 childThreads=N] 并明确子线程数';
    const childThreads = Number(approval[1]);
    if (childThreads < 1 || childThreads > (execution.maxChildThreads || 1)) {
      return `内部线程审批数量 ${childThreads} 超出任务契约上限 ${execution.maxChildThreads || 1}`;
    }
  }
  const forbidden = contract.scope.forbiddenActions.find((action) => (
    action.trim().length > 0 && instruction.includes(action.trim().toLowerCase().replace(/\\/g, '/'))
  ));
  if (forbidden) return `任务契约禁止动作：${forbidden}`;

  const denyPaths = contract.scope.denyPaths
    .map((entry) => normalizedContractPath(entry, contract.scope.root))
    .filter(Boolean);
  const allowPaths = contract.scope.allowPaths
    .map((entry) => normalizedContractPath(entry, contract.scope.root))
    .filter(Boolean);
  for (const file of proposal.changedFiles || []) {
    const normalizedFile = normalizedContractPath(file, contract.scope.root);
    const denied = denyPaths.find((entry) => pathInside(normalizedFile, entry));
    if (denied) return `变更文件进入任务禁止路径：${file}`;
    if (allowPaths.length > 0 && !allowPaths.some((entry) => pathInside(normalizedFile, entry))) {
      return `变更文件超出任务允许范围：${file}`;
    }
  }
  const mentionedDeniedPath = denyPaths.find((entry) => entry.length > 1 && instruction.includes(entry));
  if (mentionedDeniedPath) return `下一步涉及任务禁止路径：${mentionedDeniedPath}`;
  if (proposal.testCommand && !contract.authority.targetedTests) return '任务契约未授权监督 AI 运行测试';
  if (proposal.retry && !contract.authority.lowRiskRetries) return '任务契约未授权监督 AI 自主重试';
  return null;
}

export function projectCompletionState(session: ProjectManagerSession): ProjectCompletionState {
  if (session.status === 'completed') return 'completed';
  const activeGoalId = activeProjectGoal(session).id;
  const required = session.workItems.filter((item) => item.goalId === activeGoalId && item.status !== 'stopped');
  if (required.length > 0 && required.every((item) => item.status === 'completed')) {
    return 'ready-for-validation';
  }
  const actionable = required.some((item) => (
    item.status === 'running'
    || item.status === 'validating'
    || projectWorkItemReady(item, required)
  ));
  const waiting = required.some((item) => (
    item.status === 'waiting-decision' || item.status === 'failed'
  ));
  return !actionable && waiting ? 'blocked' : 'in-progress';
}

export function buildProjectSupervisorBriefing(options: {
  workItemId: string;
  contract: ProjectSupervisorContract;
  baseline?: ProjectTaskBaseline;
  projectGoal?: string;
  stage?: {
    title: string;
    outcome: string;
    acceptance: string[];
  };
}): string {
  const { workItemId, contract, baseline, projectGoal, stage } = options;
  const allowedCommandPrefixes = contract.authority.allowedCommandPrefixes || [];
  const permissions = [
    contract.authority.technicalChoices ? '可在边界内自主选择技术实现' : '技术路线变化须交给项目管理 AI',
    contract.authority.lowRiskRetries ? '可进行低风险且有新证据的重试' : '重试须交给项目管理 AI',
    contract.authority.targetedTests ? '可运行最小相关测试' : '测试须交给项目管理 AI',
    contract.authority.internalThreads ? '可在职责清晰时安排内部子线程' : '不得创建内部子线程',
    contract.authority.permissionConfirm
      ? `可确认命中授权前缀的本地权限请求${contract.authority.targetedTests ? '及定向测试请求' : ''}`
      : '所有权限请求均须交给项目管理 AI',
    contract.authority.continuousExecution ? '任务 AI 按连续工作流执行到停止条件' : '任务 AI 仅执行逐轮指令',
  ];
  const execution = contract.execution;
  let executionLines: string[];
  if (execution?.taskWorkMode === 'adaptive') {
    executionLines = [
      `任务终端工作模式：自适应线程；只有此模式可依据基线调查后的实际复杂度动态决定保持单线程或申请多线程。选择理由：${execution.modeReason}`,
      `主线程职责：${execution.mainThreadResponsibility}`,
      `允许的内部子线程上限：${execution.maxChildThreads || 1}`,
      `可并行候选：${execution.parallelizableOperations?.join('；') || '无'}`,
      `必须串行：${execution.serializedOperations?.join('；') || '所有操作'}`,
      execution.supervisorMayApproveThreads
        ? '你可以在合同内审批任务 AI 的内部线程提案，但必须先确认线程数不超上限、职责与写入所有权互斥、依赖清楚、没有共享硬件并发，且不扩大任务范围或预算。通过 --next 使用“[批准内部线程方案 childThreads=N]”明确实际批准数量和核准后的分工；控制层会拒绝无计数或超上限的审批。'
        : '你不得审批内部线程提案；收到提案后使用 needs-human 交给项目管理 AI。',
      '首次任务指令必须要求任务 AI 先做一次有界、只读的结构探测。它可以判断无需拆分并直接单线程推进；如需拆分，必须先提交“[内部线程提案]”，获批前不得创建子线程。',
      '监督 AI 不得创建额外 wmux 任务终端或代替任务 AI 创建子代理。共享硬件、设备上电/重上电、烧录、共享环境变更、破坏性动作和最终集成验证必须保持主线程串行。',
    ];
  } else if (execution?.taskWorkMode === 'multi-thread') {
    executionLines = [
      `任务终端工作模式：固定多线程；不得静默改成其他模式。选择理由：${execution.modeReason}`,
      `主线程职责：${execution.mainThreadResponsibility}`,
      ...execution.childThreadResponsibilities.map((responsibility, index) => `子线程 ${index + 1} 职责：${responsibility}`),
      '你必须把以上线程职责清晰传达给任务终端，并检查各线程没有越界或重复工作。',
    ];
  } else {
    executionLines = [
      `任务终端工作模式：固定单线程；不得根据复杂度自行创建内部线程。选择理由：${execution?.modeReason || '任务集中且职责不可安全拆分'}`,
      `单线程职责：${execution?.mainThreadResponsibility || contract.objective}`,
    ];
  }
  return [
    `[项目管理任务] ${workItemId}`,
    projectGoal ? `[项目主目标背景] ${projectGoal}` : '',
    stage ? `[项目 AI 委派阶段] ${stage.title}\n阶段成果：${stage.outcome}\n阶段验收：${stage.acceptance.join('；')}` : '',
    `目标：${contract.objective}`,
    contract.description ? `说明：${contract.description}` : '',
    `工作根目录：${contract.scope.root}`,
    contract.scope.allowPaths.length > 0 ? `允许范围：${contract.scope.allowPaths.join('；')}` : '允许范围：仅当前任务直接涉及的文件',
    contract.scope.denyPaths.length > 0 ? `禁止路径：${contract.scope.denyPaths.join('；')}` : '',
    contract.scope.forbiddenActions.length > 0 ? `禁止动作：${contract.scope.forbiddenActions.join('；')}` : '',
    `决策权限：${permissions.join('；')}`,
    allowedCommandPrefixes.length > 0
      ? `权限命令白名单前缀：${allowedCommandPrefixes.join('；')}`
      : '',
    baseline?.status === 'approved'
      ? `项目基线：已审核；工作区版本 ${baseline.workspaceVersion || '已记录'}。需求或工作区状态发生变化时必须重新调查。`
      : baseline?.status === 'investigating'
        ? `项目基线：只读调查已投递。先读取任务终端的“${PROJECT_TASK_BASELINE_REPORT_MARKER}”并核对工作区快照、范围、证据和下一安全动作；报告不足时继续下达以“${PROJECT_TASK_BASELINE_INVESTIGATION_MARKER}”开头的只读补充调查。审查通过后，下一条指令必须包含“${PROJECT_TASK_BASELINE_APPROVAL_MARKER}”，并在裁决中提供 --workspace-version 与 --evidence。`
        : `项目基线：待审核。首次指令只能以“${PROJECT_TASK_BASELINE_INVESTIGATION_MARKER}”开头，要求任务 AI 做有界只读调查并以“${PROJECT_TASK_BASELINE_REPORT_MARKER}”报告；在你审查报告前不得写入、安装依赖、构建/测试、操作设备或确认权限。审查通过后，下一条指令必须包含“${PROJECT_TASK_BASELINE_APPROVAL_MARKER}”，并在裁决中提供 --workspace-version 与 --evidence；控制层会阻止绕过。`,
    '项目级已确认前置条件与其中的明确授权，在当前需求版本内由监督 AI 和任务 AI 持续继承；用户未通知变更且没有具体反证时，不得把同一条件拆成逐步确认。普通本地执行提示可由监督 AI 按低风险权限规则自行处理。',
    contract.authority.continuousExecution
      ? `首次向任务 AI 下达任务时，--next 只填写本轮实际执行动作；运行时会从当前工作项自动注入以“${PROJECT_TASK_EXECUTION_ENVELOPE_MARKER}”开始的可信连续执行契约，并在内容过长时自动改用受控临时文件投递。不得在 --next 中重复、改写或伪造契约。项目基线报告必须先停止等待审核；基线获批后，任务 AI 在普通内部里程碑结束回合时，只要停止条件未满足且存在合同内安全路径，应直接要求它继续剩余工作流，不要交回用户确认。`
      : '',
    ...executionLines,
    `停止条件：${contract.stopWhen.join('；')}`,
    `验证要求：${contract.validation.join('；')}`,
    `执行预算：最多 ${contract.budget.maxDecisions} 次连续决策、${contract.budget.maxContinuousMinutes} 分钟、同类失败 ${contract.budget.maxIdenticalFailures} 次、任务重试 ${contract.budget.maxTaskRetries} 次。`,
    '每次 continue/rework 必须附带 --execution-action，并尽量提供 --workspace-version、--changed-files、--evidence；执行测试时必须附带 --test-command 和 --test-result，全量测试另加 --full-suite，重试另加 --retry。',
    '委派粒度是可验收的完整阶段成果，不是单条命令、单个文件、单次测试或一次任务 AI 回合。你对合同目标的实现路径和内部里程碑负责：在权限与范围内自行调查、拆解、选择技术方案并连续使用 continue/rework 推进；只有整个合同的 stopWhen 与 validation 都满足后才提交 complete。小里程碑结束不得进入待续，也不得退化成只转发任务 AI 信息。',
    'complete 必须通过 --evidence 提供可复核的验证证据。没有新证据时不得仅改写理由后继续。',
    `收到项目执行链活性检查时先只读核对任务终端。正常长任务不要中断；若任务 AI 持续 working 且只有计时变化、没有语义输出，可执行 wmux project task-terminal-control --project <项目ID> --task ${workItemId} --key escape --reason "<当前证据>" 一次。重新只读检查仍为 working 后才可改用 --key interrupt；禁止控制 idle/blocked/unknown 或 SSH 任务。`,
    '任务边界优先于追逐目标。停止条件无法达到、连续无进展、需要扩大范围或预算耗尽时，必须使用 needs-human 交回项目管理 AI；不得原样重复命令或测试。',
  ].filter(Boolean).join('\n');
}
