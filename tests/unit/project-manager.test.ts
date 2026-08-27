import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_EXECUTION_BUDGET,
  MAX_PROJECT_EXECUTION_BUDGET,
  normalizeProjectExecutionBudget,
  projectCompletionCriteriaError,
  projectSubgoalCompletionResult,
  projectWorkItemCompletionResult,
  projectWorkItemDisplayTitle,
  projectWorkItemReady,
  type ProjectWorkItem,
} from '../../src/shared/project-manager';
import {
  createProjectExecutionRecord,
  evaluateProjectExecutionGuard,
  projectBudgetExhaustionSummary,
  projectRetryConsumesTaskBudget,
  projectRetryKindEvidenceError,
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
  it('uses the Chinese objective when the stored title is only the internal task id', () => {
    const internalTitle = workItem('task-stage-1-foundation-r3', 'planned');
    internalTitle.contract.objective = '核验阶段一原型并形成可复核证据';
    expect(projectWorkItemDisplayTitle(internalTitle)).toBe('核验阶段一原型并形成可复核证据');

    const explicitTitle = { ...internalTitle, title: '阶段一原型验收' };
    expect(projectWorkItemDisplayTitle(explicitTitle)).toBe('阶段一原型验收');

    const verboseLegacyTitle = {
      ...internalTitle,
      contract: {
        ...internalTitle.contract,
        objective: '仅核验并形成阶段一可编译并启动的当前协议证据，同时关联已有列表与忽略规则，不得重做实现',
      },
    };
    expect(projectWorkItemDisplayTitle(verboseLegacyTitle)).toBe('仅核验并形成阶段一可编译并启动的当前协议证据');
  });

  it('only schedules work after every dependency completes', () => {
    const dependency = workItem('base', 'running');
    const target = workItem('ui', 'waiting-dependencies', ['base']);
    expect(projectWorkItemReady(target, [dependency, target])).toBe(false);
    expect(projectWorkItemReady(target, [{ ...dependency, status: 'completed' }, target])).toBe(true);
  });

  it('does not derive completion from unstructured status text or evidence', () => {
    const completed = {
      ...workItem('unstructured-result', 'completed'),
      goalId: 'goal-1',
      subgoalId: 'validation-stage',
      latestContextSummary: '任务自报已经完成',
      latestEvidence: '只有自然语言证据',
      completedAt: 20,
    };

    expect(projectWorkItemCompletionResult(completed)).toBeUndefined();
    expect(projectSubgoalCompletionResult({
      id: 'validation-stage', goalId: 'goal-1', status: 'achieved', updatedAt: 21, completion: undefined,
    }, [completed])).toBeUndefined();
  });

  it('projects verified work-item evidence onto canonical stage acceptance only through an explicit mapping', () => {
    const stageCriterion = 'C GUI 原型可编译并启动';
    const verificationCriterion = '复核 C GUI 原型可编译并启动的既有证据';
    const completion = {
      summary: '既有证据复核完成',
      validation: [verificationCriterion],
      evidence: '构建与启动证据已核对',
      criteria: [{
        criterion: verificationCriterion,
        status: 'satisfied' as const,
        result: 'passed' as const,
        method: 'evidence-review' as const,
        evidence: '构建退出码和启动窗口均有记录',
        evidenceRefs: ['evidence/stage-1.md'],
        evidenceArtifacts: [{
          ref: 'evidence/stage-1.md', sizeBytes: 12, mtimeMs: 1, sha256: 'a'.repeat(64),
        }],
      }],
      completedAt: 20,
    };
    const legacy = {
      ...workItem('stage-result', 'completed'),
      goalId: 'goal-1',
      subgoalId: 'foundation',
      completedAt: 20,
      completion,
      contract: {
        ...workItem('stage-result', 'completed').contract,
        stopWhen: [verificationCriterion],
        validation: [],
      },
    };
    const legacyStageCompletion = projectSubgoalCompletionResult({
      id: 'foundation', goalId: 'goal-1', status: 'achieved', updatedAt: 21, completion: undefined,
    }, [legacy]);
    expect(projectCompletionCriteriaError([stageCriterion], legacyStageCompletion, '阶段 acceptance', {
      allowExtra: true, requireArtifacts: true,
    })).toContain('尚未核验');

    const mapped = {
      ...legacy,
      contract: {
        ...legacy.contract,
        stageAcceptanceCoverage: [{ stageCriterion, verificationCriterion }],
      },
    };
    expect(projectWorkItemCompletionResult(mapped)?.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({ criterion: stageCriterion, status: 'satisfied', result: 'passed' }),
    ]));
    const mappedStageCompletion = projectSubgoalCompletionResult({
      id: 'foundation', goalId: 'goal-1', status: 'achieved', updatedAt: 21, completion: undefined,
    }, [mapped]);
    expect(projectCompletionCriteriaError([stageCriterion], mappedStageCompletion, '阶段 acceptance', {
      allowExtra: true, requireArtifacts: true,
    })).toBeNull();
  });

  it('does not aggregate stage evidence from another goal or requirements version with the same subgoal id', () => {
    const makeCompleted = (
      id: string,
      goalId: string,
      requirementsVersion: number,
      stageCriterion: string,
      verificationCriterion: string,
    ): ProjectWorkItem => ({
      ...workItem(id, 'completed'),
      goalId,
      subgoalId: 'shared-stage',
      requirementsVersion,
      authorizationVersion: 1,
      completedAt: 20,
      contract: {
        ...workItem(id, 'completed').contract,
        stopWhen: [verificationCriterion],
        validation: [],
        stageAcceptanceCoverage: [{ stageCriterion, verificationCriterion }],
      },
      completion: {
        summary: `${stageCriterion} 已核验`, validation: [verificationCriterion], completedAt: 20,
        criteria: [{
          criterion: verificationCriterion,
          status: 'satisfied', result: 'passed', method: 'evidence-review',
          evidence: `${stageCriterion} 的证据`,
          evidenceRefs: [`evidence/${id}.md`],
          evidenceArtifacts: [{
            ref: `evidence/${id}.md`, sizeBytes: 12, mtimeMs: 1, sha256: 'e'.repeat(64),
          }],
        }],
      },
    });
    const currentA = makeCompleted('current-a', 'goal-new', 2, '验收 A', '核验 A');
    const oldGoalB = makeCompleted('old-goal-b', 'goal-old', 2, '验收 B', '核验 B');
    const oldVersionB = makeCompleted('old-version-b', 'goal-new', 1, '验收 B', '核验 B');
    const scoped = projectSubgoalCompletionResult({
      id: 'shared-stage', goalId: 'goal-new', status: 'achieved', updatedAt: 21, completion: undefined,
    }, [currentA, oldGoalB, oldVersionB], { requirementsVersion: 2, authorizationVersion: 1 });
    expect(projectCompletionCriteriaError(['验收 A', '验收 B'], scoped, '阶段 acceptance', {
      allowExtra: true, requireArtifacts: true,
    })).toContain('验收 B');

    const currentB = makeCompleted('current-b', 'goal-new', 2, '验收 B', '核验 B');
    const complete = projectSubgoalCompletionResult({
      id: 'shared-stage', goalId: 'goal-new', status: 'achieved', updatedAt: 21, completion: undefined,
    }, [currentA, oldGoalB, oldVersionB, currentB], { requirementsVersion: 2, authorizationVersion: 1 });
    expect(projectCompletionCriteriaError(['验收 A', '验收 B'], complete, '阶段 acceptance', {
      allowExtra: true, requireArtifacts: true,
    })).toBeNull();
  });
});

describe('project execution anti-loop guard', () => {  it('rejects a third identical failure without a changed work version', () => {
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
  });  it('does not treat rewritten narrative evidence as real progress', () => {
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
  });  it('does not treat a rewritten diff summary as independently verified progress', () => {
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
