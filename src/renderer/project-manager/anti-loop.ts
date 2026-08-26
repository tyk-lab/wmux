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
  /** Stable signature of project files whose contents were read and hashed by the control plane. */
  evidenceProgressSignature?: string;
  retryKind?: ProjectRetryKind;
  /** A verified full-work-item closeout may be recorded without another execution delta. */
  completion?: boolean;
  escalationBoundary?: ProjectEscalationBoundary;
  now: number;
}

export interface ProjectExecutionGuardResult {
  decision: ProjectExecutionGuardDecision;
  reason?: string;
  record: ProjectExecutionRecord;
  replanTrigger?: 'decision-limit' | 'time-limit' | 'no-progress';
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
      proposal.testCommand || '',
      testResult,
      proposal.error || '',
      proposal.evidenceProgressSignature || '',
    ]),
    workspaceVersion,
    testCommand: proposal.testCommand ? normalizeText(proposal.testCommand) : undefined,
    fullSuite: proposal.fullSuite === true,
    ...(changedFiles.length > 0 ? { changedFiles: changedFiles.slice(0, 100) } : {}),
    ...(testResult ? { testResult } : {}),
    ...(diffSummary ? { diffSummary } : {}),
    ...(evidenceSummary ? { evidenceSummary } : {}),
    ...(proposal.evidenceProgressSignature
      ? { evidenceProgressSignature: normalizeText(proposal.evidenceProgressSignature).slice(0, 4_000) }
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
    if (/(?:return\s*code|returncode|exit\s*code|退出码)\s*[=:]?\s*0|(?:执行|动作|实机|安全门槛).{0,24}(?:成功|通过)/iu.test(failureEvidence)
      && /(?:账本|证据|记录|落盘|绑定|closure|ledger|manifest|sidecar).{0,40}(?:失败|缺失|未闭合|不一致|missing|fail|error)/iu.test(failureEvidence)) {
      return '底层动作已经成功、仅证据/账本闭合失败时必须使用 evidence-closure；不得消耗真实任务失败预算';
    }
    if (!/(?:\bfail(?:ed|ure)?\b|\berror\b|\bexception\b|\btimeout\b|\btimed out\b|\bnon-zero\b|\bexit code\s*[1-9]\d*\b|失败|未通过|错误|异常|超时|退出码\s*[1-9]\d*)/iu.test(failureEvidence)) {
      return 'task-failure 必须通过 --error 或 --test-result 提供明确的真实实现/验证失败证据';
    }
    return null;
  }
  if (options.retryKind === 'evidence-closure') {
    if (options.outcome !== 'rework') return 'evidence-closure 必须使用 rework，并保留已经成功的底层动作事实';
    const closureEvidence = `${options.executionError}\n${options.testResult}`;
    if (!/(?:账本|证据|记录|落盘|绑定|closure|ledger|manifest|sidecar)/iu.test(closureEvidence)
      || !/(?:失败|缺失|未闭合|不一致|missing|fail|error)/iu.test(closureEvidence)) {
      return 'evidence-closure 仅用于底层动作完成后的证据、账本、manifest、sidecar 或运行绑定闭合失败';
    }
    return null;
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
  startedAt?: number;
  aggregateWorkerMinutes?: number;
  now?: number;
}): string {
  const exhausted: string[] = [];
  if (options.attempts >= options.budget.maxTaskRetries) {
    exhausted.push(`真实任务失败重试 ${options.attempts}/${options.budget.maxTaskRetries}`);
  }
  const aggregateWorkerMinutes = Math.max(0, options.aggregateWorkerMinutes || 0);
  if (aggregateWorkerMinutes >= options.budget.maxAggregateWorkerMinutes) {
    exhausted.push(
      `任务 AI 聚合执行窗口 ${Math.floor(aggregateWorkerMinutes)}/${options.budget.maxAggregateWorkerMinutes} 分钟`,
    );
  }
  if (exhausted.length > 0) return `执行预算已耗尽：${exhausted.join('；')}`;
  return [
    '执行预算请求无有效边界，当前没有单项达到上限',
    'P9 不以裁决次数或连续运行时间中断有进展的任务',
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

export function evaluateProjectExecutionGuard(options: {
  history: readonly ProjectExecutionRecord[];
  proposal: ProjectExecutionProposal;
  budget: ProjectExecutionBudget;
  startedAt?: number;
}): ProjectExecutionGuardResult {
  const { history, proposal, budget } = options;
  const effectiveHistory = history.filter((entry) => entry.consumedDecision !== false);
  const record = createProjectExecutionRecord(proposal);

  if (proposal.completion === true) {
    return { decision: 'allow', record };
  }

  if (record.errorSignature) {
    const identicalFailures = consecutiveCount(effectiveHistory, (entry) => (
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
    const sameTestRuns = effectiveHistory.filter((entry) => (
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
      const fullSuiteRuns = effectiveHistory.filter((entry) => (
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

  const noProgressRounds = consecutiveCount(effectiveHistory, (entry) => (
    entry.progressSignature === record.progressSignature
  ));
  if (noProgressRounds >= budget.maxNoProgressRounds) {
    return {
      decision: 'replan',
      reason: `连续 ${noProgressRounds} 轮没有产生新的代码、测试、错误或已核验工件证据`,
      replanTrigger: 'no-progress',
      record,
    };
  }
  return { decision: 'allow', record };
}
