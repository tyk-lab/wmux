import type {
  ProjectEscalationBoundary,
  ProjectExecutionBudget,
  ProjectExecutionRecord,
  ProjectRetryKind,
} from '../../shared/project-manager';

export type ProjectExecutionGuardDecision = 'allow' | 'pause' | 'replan' | 'reject';

export interface ProjectExecutionProposal {
  action: string;
  command?: string;
  error?: string;
  changedFiles?: string[];
  diffSummary?: string;
  evidence?: string;
  workspaceVersion?: string;
  testCommand?: string;
  testResult?: string;
  fullSuite?: boolean;
  planProgressSignature?: string;
  retryKind?: ProjectRetryKind;
  allowWindowRenewal?: boolean;
  escalationBoundary?: ProjectEscalationBoundary;
  now: number;
}

export interface ProjectExecutionGuardResult {
  decision: ProjectExecutionGuardDecision;
  reason?: string;
  record: ProjectExecutionRecord;
  renewWindow?: 'decision-limit' | 'time-limit' | 'decision-and-time';
}

function normalizeText(value: string | undefined): string {
  return (value || '').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function signature(parts: readonly string[]): string {
  const text = parts.map(normalizeText).join('\u001f');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createProjectExecutionRecord(
  proposal: ProjectExecutionProposal,
): ProjectExecutionRecord {
  const changedFiles = [...(proposal.changedFiles || [])].map(normalizeText).sort();
  const workspaceVersion = normalizeText(proposal.workspaceVersion) || 'unknown';
  const testResult = normalizeText(proposal.testResult).slice(0, 2_000);
  const diffSummary = normalizeText(proposal.diffSummary).slice(0, 4_000);
  const evidenceSummary = normalizeText(proposal.evidence).slice(0, 4_000);
  const materialWorkspaceVersion = changedFiles.length > 0 || testResult
    ? workspaceVersion
    : 'no-material-change';
  return {
    ts: proposal.now,
    actionSignature: signature([proposal.action, proposal.command || '']),
    commandSignature: signature([proposal.command || proposal.action]),
    errorSignature: proposal.error ? signature([proposal.error]) : '',
    progressSignature: signature([
      materialWorkspaceVersion,
      changedFiles.join('|'),
      testResult,
      proposal.error || '',
      proposal.planProgressSignature || '',
    ]),
    workspaceVersion,
    testCommand: proposal.testCommand ? normalizeText(proposal.testCommand) : undefined,
    fullSuite: proposal.fullSuite === true,
    ...(changedFiles.length > 0 ? { changedFiles: changedFiles.slice(0, 100) } : {}),
    ...(testResult ? { testResult } : {}),
    ...(diffSummary ? { diffSummary } : {}),
    ...(evidenceSummary ? { evidenceSummary } : {}),
    ...(proposal.planProgressSignature
      ? { planProgressSignature: normalizeText(proposal.planProgressSignature).slice(0, 2_000) }
      : {}),
    ...(proposal.retryKind ? { retryKind: proposal.retryKind } : {}),
    ...(proposal.escalationBoundary ? { escalationBoundary: proposal.escalationBoundary } : {}),
  };
}

export function projectRetryConsumesTaskBudget(retryKind: ProjectRetryKind | undefined): boolean {
  return retryKind === 'task-failure';
}

export function projectRetryKindEvidenceError(options: {
  retryKind: ProjectRetryKind;
  outcome: string;
  changedFiles: string[];
  testCommand: string;
  testResult: string;
  executionError: string;
}): string | null {
  if (options.retryKind === 'task-failure') {
    if (options.outcome !== 'rework') return 'task-failure 必须使用 rework，并提供真实失败证据';
    const failureEvidence = `${options.executionError}\n${options.testResult}`;
    if (!/(?:\bfail(?:ed|ure)?\b|\berror\b|\bexception\b|\btimeout\b|\btimed out\b|\bnon-zero\b|\bexit code\s*[1-9]\d*\b|失败|未通过|错误|异常|超时|退出码\s*[1-9]\d*)/iu.test(failureEvidence)) {
      return 'task-failure 必须通过 --error 或 --test-result 提供明确的真实实现/验证失败证据';
    }
    return null;
  }
  if (options.retryKind === 'execution-window' && (
    options.changedFiles.length > 0
    || options.testCommand
    || options.testResult
    || options.executionError
  )) {
    return 'execution-window 仅用于任务 AI 执行窗口不足且本轮零写入、零测试、无执行错误的续接';
  }
  if (options.retryKind === 'runtime-recovery' && (
    options.changedFiles.length > 0
    || options.testCommand
    || options.testResult
  )) {
    return 'runtime-recovery 仅用于 PTY、Agent、投递或运行时恢复，不得携带交付文件或测试执行结果';
  }
  return null;
}

export function projectBudgetExhaustionSummary(options: {
  budget: ProjectExecutionBudget;
  attempts: number;
  decisionsUsed: number;
  startedAt?: number;
  aggregateWorkerMinutes?: number;
  now?: number;
}): string {
  const now = options.now ?? Date.now();
  const exhausted: string[] = [];
  if (options.attempts >= options.budget.maxTaskRetries) {
    exhausted.push(`真实任务失败重试 ${options.attempts}/${options.budget.maxTaskRetries}`);
  }
  if (options.decisionsUsed >= options.budget.maxDecisions) {
    exhausted.push(`监督自治健康窗口 ${options.decisionsUsed}/${options.budget.maxDecisions}`);
  }
  if (options.startedAt !== undefined) {
    const elapsedMinutes = Math.max(0, Math.floor((now - options.startedAt) / 60_000));
    if (elapsedMinutes >= options.budget.maxContinuousMinutes) {
      exhausted.push(`连续运行窗口 ${elapsedMinutes}/${options.budget.maxContinuousMinutes} 分钟`);
    }
  }
  const aggregateWorkerMinutes = Math.max(0, options.aggregateWorkerMinutes || 0);
  if (aggregateWorkerMinutes >= options.budget.maxAggregateWorkerMinutes) {
    exhausted.push(
      `任务 AI 聚合执行窗口 ${Math.floor(aggregateWorkerMinutes)}/${options.budget.maxAggregateWorkerMinutes} 分钟`,
    );
  }
  if (exhausted.length > 0) return `执行预算已耗尽：${exhausted.join('；')}`;
  return [
    '执行预算触发后继，但没有单项达到硬上限',
    `监督自治健康窗口 ${options.decisionsUsed}/${options.budget.maxDecisions}`,
    `真实任务失败重试 ${options.attempts}/${options.budget.maxTaskRetries}`,
  ].join('；');
}

function consecutiveCount(
  history: readonly ProjectExecutionRecord[],
  matches: (record: ProjectExecutionRecord) => boolean,
): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (!matches(history[index])) break;
    count += 1;
  }
  return count;
}

function sameMaterialWorkVersion(
  left: ProjectExecutionRecord,
  right: ProjectExecutionRecord,
): boolean {
  return left.workspaceVersion === right.workspaceVersion
    || ((left.changedFiles?.length || 0) === 0 && (right.changedFiles?.length || 0) === 0);
}

function hasFreshVerifiedProgress(
  history: readonly ProjectExecutionRecord[],
  record: ProjectExecutionRecord,
): boolean {
  const previous = history[history.length - 1];
  if (!previous || record.errorSignature || record.progressSignature === previous.progressSignature) return false;
  const workspaceProgress = record.workspaceVersion !== 'unknown'
    && (record.changedFiles?.length || 0) > 0;
  const testProgress = !!record.testCommand && !!record.testResult;
  const planProgress = !!record.planProgressSignature
    && record.planProgressSignature !== previous.planProgressSignature;
  return workspaceProgress || testProgress || planProgress;
}

export function evaluateProjectExecutionGuard(options: {
  history: readonly ProjectExecutionRecord[];
  proposal: ProjectExecutionProposal;
  budget: ProjectExecutionBudget;
  decisionsUsed: number;
  startedAt?: number;
}): ProjectExecutionGuardResult {
  const { history, proposal, budget } = options;
  const record = createProjectExecutionRecord(proposal);

  if (record.errorSignature) {
    const identicalFailures = consecutiveCount(history, (entry) => (
      entry.actionSignature === record.actionSignature
      && entry.errorSignature === record.errorSignature
      && sameMaterialWorkVersion(entry, record)
    ));
    if (identicalFailures >= budget.maxIdenticalFailures) {
      return {
        decision: 'reject',
        reason: `相同动作和错误已连续出现 ${identicalFailures} 次，必须改变假设、输入或执行路径`,
        record,
      };
    }
  }

  if (record.testCommand) {
    const sameTestRuns = history.filter((entry) => (
      entry.testCommand === record.testCommand
      && sameMaterialWorkVersion(entry, record)
    )).length;
    if (sameTestRuns >= budget.maxSameTestRuns) {
      return {
        decision: 'reject',
        reason: `代码和环境未变化时，相同测试最多运行 ${budget.maxSameTestRuns} 次`,
        record,
      };
    }
    if (record.fullSuite) {
      const fullSuiteRuns = history.filter((entry) => (
        entry.fullSuite === true && sameMaterialWorkVersion(entry, record)
      )).length;
      if (fullSuiteRuns >= budget.maxFullSuiteRunsPerVersion) {
        return {
          decision: 'reject',
          reason: `同一工作版本的全量测试最多运行 ${budget.maxFullSuiteRunsPerVersion} 次`,
          record,
        };
      }
    }
  }

  const noProgressRounds = consecutiveCount(history, (entry) => (
    entry.progressSignature === record.progressSignature
  ));
  if (noProgressRounds >= budget.maxNoProgressRounds) {
    return {
      decision: 'replan',
      reason: `连续 ${noProgressRounds} 轮没有产生新的代码、测试或错误证据`,
      record,
    };
  }
  const decisionLimitReached = options.decisionsUsed >= budget.maxDecisions;
  const timeLimitReached = options.startedAt !== undefined
    && proposal.now - options.startedAt >= budget.maxContinuousMinutes * 60_000;
  if (decisionLimitReached || timeLimitReached) {
    if (proposal.allowWindowRenewal === true && hasFreshVerifiedProgress(history, record)) {
      return {
        decision: 'allow',
        renewWindow: decisionLimitReached && timeLimitReached
          ? 'decision-and-time'
          : decisionLimitReached
            ? 'decision-limit'
            : 'time-limit',
        record,
      };
    }
    return {
      decision: 'pause',
      reason: decisionLimitReached
        ? `已达到连续自主决策健康窗口 ${budget.maxDecisions} 次，且本轮没有可核验的新进展`
        : `已达到连续运行健康窗口 ${budget.maxContinuousMinutes} 分钟，且本轮没有可核验的新进展`,
      record,
    };
  }
  return { decision: 'allow', record };
}
