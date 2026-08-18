import {
  projectWorkItemReady,
  type ProjectManagerSession,
  type ProjectSupervisorContract,
  type ProjectWorkItem,
} from '../../shared/project-manager';

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
  return session.workItems.filter((item) => projectWorkItemReady(item, session.workItems));
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
  const required = session.workItems.filter((item) => item.status !== 'stopped');
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
}): string {
  const { workItemId, contract } = options;
  const permissions = [
    contract.authority.technicalChoices ? '可在边界内自主选择技术实现' : '技术路线变化须交给项目管理 AI',
    contract.authority.lowRiskRetries ? '可进行低风险且有新证据的重试' : '重试须交给项目管理 AI',
    contract.authority.targetedTests ? '可运行最小相关测试' : '测试须交给项目管理 AI',
    contract.authority.internalThreads ? '可在职责清晰时安排内部子线程' : '不得创建内部子线程',
  ];
  const execution = contract.execution;
  const executionLines = execution?.taskWorkMode === 'multi-thread'
    ? [
        `任务终端工作模式：多线程；选择理由：${execution.modeReason}`,
        `主线程职责：${execution.mainThreadResponsibility}`,
        ...execution.childThreadResponsibilities.map((responsibility, index) => `子线程 ${index + 1} 职责：${responsibility}`),
        '你必须把以上线程职责清晰传达给任务终端，并检查各线程没有越界或重复工作。',
      ]
    : [
        `任务终端工作模式：单线程；选择理由：${execution?.modeReason || '任务集中且职责不可安全拆分'}`,
        `单线程职责：${execution?.mainThreadResponsibility || contract.objective}`,
      ];
  return [
    `[项目管理任务] ${workItemId}`,
    `目标：${contract.objective}`,
    contract.description ? `说明：${contract.description}` : '',
    `工作根目录：${contract.scope.root}`,
    contract.scope.allowPaths.length > 0 ? `允许范围：${contract.scope.allowPaths.join('；')}` : '允许范围：仅当前任务直接涉及的文件',
    contract.scope.denyPaths.length > 0 ? `禁止路径：${contract.scope.denyPaths.join('；')}` : '',
    contract.scope.forbiddenActions.length > 0 ? `禁止动作：${contract.scope.forbiddenActions.join('；')}` : '',
    `决策权限：${permissions.join('；')}`,
    '项目级已确认前置条件与其中的明确授权，在当前需求版本内由监督 AI 和任务 AI 持续继承；用户未通知变更且没有具体反证时，不得把同一条件拆成逐步确认。普通本地执行提示可由监督 AI 按低风险权限规则自行处理。',
    ...executionLines,
    `停止条件：${contract.stopWhen.join('；')}`,
    `验证要求：${contract.validation.join('；')}`,
    `执行预算：最多 ${contract.budget.maxDecisions} 次连续决策、${contract.budget.maxContinuousMinutes} 分钟、同类失败 ${contract.budget.maxIdenticalFailures} 次、任务重试 ${contract.budget.maxTaskRetries} 次。`,
    '每次 continue/rework 必须附带 --execution-action，并尽量提供 --workspace-version、--changed-files、--evidence；执行测试时必须附带 --test-command 和 --test-result，全量测试另加 --full-suite，重试另加 --retry。',
    'complete 必须通过 --evidence 提供可复核的验证证据。没有新证据时不得仅改写理由后继续。',
    '任务边界优先于追逐目标。停止条件无法达到、连续无进展、需要扩大范围或预算耗尽时，必须使用 needs-human 交回项目管理 AI；不得原样重复命令或测试。',
  ].filter(Boolean).join('\n');
}
