import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_EXECUTION_BUDGET,
  MAX_PROJECT_EXECUTION_BUDGET,
  normalizeProjectExecutionBudget,
  projectWorkItemReady,
  type ProjectWorkItem,
} from '../../src/shared/project-manager';
import {
  createProjectExecutionRecord,
  evaluateProjectExecutionGuard,
  type ProjectExecutionProposal,
} from '../../src/renderer/project-manager/anti-loop';

function proposal(partial: Partial<ProjectExecutionProposal> = {}): ProjectExecutionProposal {
  return {
    action: '运行登录测试',
    command: 'npm test -- auth',
    error: 'expected 200 received 500',
    workspaceVersion: 'diff-a',
    testCommand: 'npm test -- auth',
    testResult: 'failed',
    now: 1_000,
    ...partial,
  };
}

function workItem(id: string, status: ProjectWorkItem['status'], dependencies: string[] = []): ProjectWorkItem {
  return {
    id,
    title: id,
    status,
    dependencies,
    attempts: 0,
    decisionsUsed: 0,
    updatedAt: 1,
    executionHistory: [],
    contract: {
      objective: id,
      description: '',
      preconditions: [],
      scope: { root: 'E:\\repo', allowPaths: [], denyPaths: [], forbiddenActions: [] },
      authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: true },
      stopWhen: ['测试通过'],
      validation: ['npm test'],
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
    },
  };
}

describe('project-manager domain', () => {
  it('only schedules work after every dependency completes', () => {
    const dependency = workItem('base', 'running');
    const target = workItem('ui', 'waiting-dependencies', ['base']);
    expect(projectWorkItemReady(target, [dependency, target])).toBe(false);
    expect(projectWorkItemReady(target, [{ ...dependency, status: 'completed' }, target])).toBe(true);
  });

  it('normalizes invalid budgets to conservative defaults', () => {
    expect(normalizeProjectExecutionBudget({
      maxDecisions: 0,
      maxSameTestRuns: 3.8,
      maxContinuousMinutes: Number.MAX_SAFE_INTEGER,
      maxFullSuiteRunsPerVersion: 99,
    })).toMatchObject({
      maxDecisions: DEFAULT_PROJECT_EXECUTION_BUDGET.maxDecisions,
      maxSameTestRuns: 3,
      maxContinuousMinutes: MAX_PROJECT_EXECUTION_BUDGET.maxContinuousMinutes,
      maxFullSuiteRunsPerVersion: MAX_PROJECT_EXECUTION_BUDGET.maxFullSuiteRunsPerVersion,
    });
  });
});

describe('project execution anti-loop guard', () => {
  it('rejects a third identical failure without a changed work version', () => {
    const current = proposal({ now: 3_000 });
    const history = [
      createProjectExecutionRecord(proposal({ now: 1_000 })),
      createProjectExecutionRecord(proposal({ now: 2_000 })),
    ];
    expect(evaluateProjectExecutionGuard({
      history,
      proposal: current,
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      decisionsUsed: 2,
      startedAt: 500,
    })).toMatchObject({ decision: 'reject', reason: expect.stringContaining('相同动作和错误') });
  });

  it('allows the same command after the workspace version and changed-file evidence agree', () => {
    const history = [
      createProjectExecutionRecord(proposal({ now: 1_000 })),
      createProjectExecutionRecord(proposal({ now: 2_000 })),
    ];
    expect(evaluateProjectExecutionGuard({
      history,
      proposal: proposal({ workspaceVersion: 'diff-b', changedFiles: ['src/auth.ts'], now: 3_000 }),
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      decisionsUsed: 2,
      startedAt: 500,
    }).decision).toBe('allow');
  });

  it('rejects a changed self-reported version without material evidence', () => {
    const history = [
      createProjectExecutionRecord(proposal({ workspaceVersion: 'claimed-a', now: 1_000 })),
      createProjectExecutionRecord(proposal({ workspaceVersion: 'claimed-b', now: 2_000 })),
    ];
    expect(evaluateProjectExecutionGuard({
      history,
      proposal: proposal({ workspaceVersion: 'claimed-c', now: 3_000 }),
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      decisionsUsed: 2,
    })).toMatchObject({ decision: 'reject', reason: expect.stringContaining('相同动作和错误') });
  });

  it('prevents repeating a full suite for the same work version', () => {
    const fullSuite = proposal({ testCommand: 'npm test', command: 'npm test', fullSuite: true });
    const history = [createProjectExecutionRecord(fullSuite)];
    expect(evaluateProjectExecutionGuard({
      history,
      proposal: { ...fullSuite, now: 2_000 },
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      decisionsUsed: 1,
    })).toMatchObject({ decision: 'reject', reason: expect.stringContaining('全量测试') });
  });

  it('does not let an unsubstantiated version label bypass the full-suite limit', () => {
    const first = proposal({
      command: 'npm test', testCommand: 'npm test', fullSuite: true,
      workspaceVersion: 'claimed-a', changedFiles: [],
    });
    expect(evaluateProjectExecutionGuard({
      history: [createProjectExecutionRecord(first)],
      proposal: { ...first, workspaceVersion: 'claimed-b', now: 2_000 },
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      decisionsUsed: 1,
    })).toMatchObject({ decision: 'reject', reason: expect.stringContaining('全量测试') });
  });

  it('pauses when the autonomous decision budget is exhausted', () => {
    expect(evaluateProjectExecutionGuard({
      history: [],
      proposal: proposal(),
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      decisionsUsed: DEFAULT_PROJECT_EXECUTION_BUDGET.maxDecisions,
    })).toMatchObject({ decision: 'pause', reason: expect.stringContaining('决策上限') });
  });

  it('requires replanning after repeated no-progress evidence', () => {
    const unchanged = proposal({
      action: '检查状态',
      command: 'read-screen',
      error: undefined,
      testCommand: undefined,
      testResult: undefined,
    });
    const record = createProjectExecutionRecord(unchanged);
    expect(evaluateProjectExecutionGuard({
      history: [record, { ...record, ts: 2_000 }],
      proposal: { ...unchanged, now: 3_000 },
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      decisionsUsed: 2,
    })).toMatchObject({ decision: 'replan', reason: expect.stringContaining('没有产生新的') });
  });

  it('does not treat rewritten narrative evidence as real progress', () => {
    const base = proposal({
      action: '继续检查', command: 'read-screen', error: undefined,
      testCommand: undefined, testResult: undefined, evidence: '第一次说明',
    });
    const record = createProjectExecutionRecord(base);
    expect(evaluateProjectExecutionGuard({
      history: [record, { ...record, ts: 2_000 }],
      proposal: { ...base, evidence: '换一种说法但没有新证据', now: 3_000 },
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      decisionsUsed: 2,
    }).decision).toBe('replan');
  });

  it('does not treat a rewritten diff summary as independently verified progress', () => {
    const base = proposal({
      action: '继续检查', command: 'read-screen', error: undefined,
      testCommand: undefined, testResult: undefined, diffSummary: '第一次描述',
    });
    const record = createProjectExecutionRecord(base);
    expect(evaluateProjectExecutionGuard({
      history: [record, { ...record, ts: 2_000 }],
      proposal: { ...base, diffSummary: '换一种说法', now: 3_000 },
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      decisionsUsed: 2,
    }).decision).toBe('replan');
  });
});
