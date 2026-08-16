import type {
  ProjectExecutionBudget,
  ProjectExecutionRecord,
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
  now: number;
}

export interface ProjectExecutionGuardResult {
  decision: ProjectExecutionGuardDecision;
  reason?: string;
  record: ProjectExecutionRecord;
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
  return {
    ts: proposal.now,
    actionSignature: signature([proposal.action, proposal.command || '']),
    commandSignature: signature([proposal.command || proposal.action]),
    errorSignature: proposal.error ? signature([proposal.error]) : '',
    progressSignature: signature([
      workspaceVersion,
      changedFiles.join('|'),
      proposal.testResult || '',
      proposal.error || '',
    ]),
    workspaceVersion,
    testCommand: proposal.testCommand ? normalizeText(proposal.testCommand) : undefined,
    fullSuite: proposal.fullSuite === true,
  };
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

export function evaluateProjectExecutionGuard(options: {
  history: readonly ProjectExecutionRecord[];
  proposal: ProjectExecutionProposal;
  budget: ProjectExecutionBudget;
  decisionsUsed: number;
  startedAt?: number;
}): ProjectExecutionGuardResult {
  const { history, proposal, budget } = options;
  const record = createProjectExecutionRecord(proposal);

  if (options.decisionsUsed >= budget.maxDecisions) {
    return { decision: 'pause', reason: `已达到连续自主决策上限 ${budget.maxDecisions} 次`, record };
  }
  if (
    options.startedAt !== undefined
    && proposal.now - options.startedAt >= budget.maxContinuousMinutes * 60_000
  ) {
    return { decision: 'pause', reason: `已达到连续运行上限 ${budget.maxContinuousMinutes} 分钟`, record };
  }

  if (record.errorSignature) {
    const identicalFailures = consecutiveCount(history, (entry) => (
      entry.actionSignature === record.actionSignature
      && entry.errorSignature === record.errorSignature
      && entry.workspaceVersion === record.workspaceVersion
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
      && entry.workspaceVersion === record.workspaceVersion
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
        entry.fullSuite === true && entry.workspaceVersion === record.workspaceVersion
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
  return { decision: 'allow', record };
}
