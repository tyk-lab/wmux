import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import {
  createProjectManagerSlice,
  type ProjectManagerSlice,
} from '../../src/renderer/store/project-manager-slice';
import {
  DEFAULT_PROJECT_EXECUTION_BUDGET,
  PROJECT_USER_ACCEPTANCE_REQUIRED_ERROR,
  normalizeProjectVerificationPolicies,
  projectGoalCompletionCriteriaError,
  type ProjectCompletionResult,
  type ProjectGoalRevision,
  type ProjectWorkItem,
} from '../../src/shared/project-manager';

function store() {
  return create<ProjectManagerSlice>()(createProjectManagerSlice);
}

function completion(
  criterion: string,
  overrides: Partial<NonNullable<ProjectCompletionResult['criteria']>[number]> = {},
): ProjectCompletionResult {
  return {
    summary: '已形成交付并记录当前验证结论',
    validation: [criterion],
    evidence: '项目内证据已由控制层读取',
    criteria: [{
      criterion,
      status: 'satisfied',
      result: 'passed',
      method: 'evidence-review',
      evidence: '项目内证据已由控制层读取',
      evidenceRefs: ['evidence/result.txt'],
      evidenceArtifacts: [{
        ref: 'evidence/result.txt', sizeBytes: 8, mtimeMs: 1, sha256: 'a'.repeat(64),
      }],
      ...overrides,
    }],
    completedAt: 10,
  };
}

function completedItem(id: string, criterion: string, result: ProjectCompletionResult): ProjectWorkItem {
  return {
    id,
    goalId: '',
    subgoalId: '',
    requirementsVersion: 1,
    authorizationVersion: 1,
    executionProtocolVersion: 10,
    complexityAssessment: {
      level: 'low', outcomeCount: 1, moduleCount: 1, dependencyDepth: 0,
      contextWeight: 'small', evidence: ['单一成果'], decidedTaskCount: 1, decidedAt: 1,
    },
    taskWorkMode: 'single-thread',
    title: id,
    status: 'completed',
    dependencies: [],
    attempts: 0,
    updatedAt: 10,
    completedAt: 10,
    completion: result,
    executionHistory: [],
    contract: {
      objective: id,
      description: '',
      preconditions: [],
      scope: { root: 'E:\\policy', allowPaths: [], denyPaths: [], forbiddenActions: [] },
      authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false },
      stopWhen: [criterion],
      validation: [criterion],
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
    },
  };
}

describe('project verification policy', () => {
  it('defaults unspecified criteria to required and refuses to relax protected acceptance', () => {
    expect(normalizeProjectVerificationPolicies(['功能可用'], undefined)).toEqual([
      { criterion: '功能可用', requirement: 'required', riskClass: 'protected' },
    ]);
    expect(normalizeProjectVerificationPolicies(['权限与数据完整性验收'], [{
      criterion: '权限与数据完整性验收', requirement: 'not-applicable',
    }])).toEqual([
      { criterion: '权限与数据完整性验收', requirement: 'required', riskClass: 'protected' },
    ]);
    expect(normalizeProjectVerificationPolicies(['Production deployment authorization is verified'], [{
      criterion: 'Production deployment authorization is verified', requirement: 'best-effort', riskClass: 'standard',
    }])).toEqual([
      { criterion: 'Production deployment authorization is verified', requirement: 'required', riskClass: 'protected' },
    ]);
    expect(normalizeProjectVerificationPolicies(['Release the build to the customer environment'], [{
      criterion: 'Release the build to the customer environment', requirement: 'not-applicable', riskClass: 'standard',
    }])).toEqual([
      { criterion: 'Release the build to the customer environment', requirement: 'required', riskClass: 'protected' },
    ]);
  });

  it('accepts honest best-effort and not-applicable records but never masks a known failure', () => {
    const bestEffortGoal: ProjectGoalRevision = {
      id: 'goal', sequence: 1, statement: '形成兼容性观察结果', doneWhen: ['兼容性结果已记录'],
      verificationPolicies: [{ criterion: '兼容性结果已记录', requirement: 'best-effort', riskClass: 'standard' }],
      status: 'active', requirementsVersion: 1, createdAt: 1,
    };
    expect(projectGoalCompletionCriteriaError(bestEffortGoal, completion('兼容性结果已记录', {
      status: 'unverified', result: 'inconclusive', method: 'evidence-review',
    }))).toBeNull();
    expect(projectGoalCompletionCriteriaError(bestEffortGoal, completion('兼容性结果已记录', {
      status: 'unsatisfied', result: 'failed', method: 'runtime-test',
    }))).toContain('存在已知失败');

    const notApplicableGoal: ProjectGoalRevision = {
      ...bestEffortGoal,
      verificationPolicies: [{ criterion: '兼容性结果已记录', requirement: 'not-applicable', riskClass: 'standard' }],
    };
    expect(projectGoalCompletionCriteriaError(notApplicableGoal, completion('兼容性结果已记录', {
      status: 'unverified', result: 'not-run', method: 'evidence-review',
    }))).toBeNull();
  });

  it('versions an in-flight switch and preserves historical results while invalidating open work', () => {
    const useStore = store();
    const session = useStore.getState().startProjectManager({
      projectDir: 'E:\\policy-switch', goal: '形成 GUI 原型', doneWhen: ['GUI 核心流程可使用'],
    });
    const openItem = completedItem('open-item', 'GUI 核心流程可使用', completion('GUI 核心流程可使用'));
    openItem.status = 'running';
    openItem.goalId = session.activeGoalId!;
    openItem.completion = undefined;
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: openItem }, session.id);

    expect(useStore.getState().applyProjectManagerAction({
      type: 'update-project-definition',
      goal: session.goal,
      preconditions: session.preconditions,
      planFiles: session.planFiles,
      doneWhen: session.doneWhen,
      userAcceptancePolicy: 'not-required',
      verificationPolicies: [{
        criterion: 'GUI 核心流程可使用', requirement: 'not-applicable', riskClass: 'standard', reason: '用户不再要求该项目进行 GUI 验收',
      }],
      source: 'user', mode: 'refine', reason: '用户在运行中切换验证策略',
    }, session.id)).toMatchObject({ ok: true });

    const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id)!;
    expect(updated).toMatchObject({
      status: 'waiting', requirementsVersion: 2, userAcceptancePolicy: 'not-required',
      workItems: [expect.objectContaining({ id: 'open-item', status: 'waiting-decision', requirementsVersion: 1 })],
    });
    expect(updated.goals?.[0].verificationPolicies).toEqual([
      expect.objectContaining({ criterion: 'GUI 核心流程可使用', requirement: 'not-applicable' }),
    ]);
  });

  it('requires final user acceptance only for always and auto-closes an evidenced not-required goal', () => {
    const useStore = store();
    const criterion = '交付说明已形成';
    const base = useStore.getState().startProjectManager({
      projectDir: 'E:\\policy-complete', goal: '形成说明', doneWhen: [criterion],
      userAcceptancePolicy: 'always',
    });
    const result = completion(criterion);
    const item = completedItem('deliverable', criterion, result);
    item.goalId = base.activeGoalId!;
    useStore.getState().restoreProjectManager({
      ...base,
      status: 'active',
      acceptedRequirementsVersion: 1,
      goals: base.goals?.map((goal) => ({ ...goal, status: 'active' })),
      workItems: [item],
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'complete-current-goal', evidence: result.evidence!, completion: result,
    }, base.id)).toMatchObject({ ok: false, error: PROJECT_USER_ACCEPTANCE_REQUIRED_ERROR });

    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === base.id)!;
    useStore.getState().restoreProjectManager({
      ...current,
      userAcceptancePolicy: 'not-required',
      verificationPolicies: [{ criterion, requirement: 'not-applicable', riskClass: 'standard' }],
      goals: current.goals?.map((goal) => ({
        ...goal,
        userAcceptancePolicy: 'not-required',
        verificationPolicies: [{ criterion, requirement: 'not-applicable', riskClass: 'standard' }],
      })),
      workItems: [{
        ...current.workItems[0],
        completion: completion(criterion, { status: 'unverified', result: 'not-run', method: 'evidence-review' }),
      }],
    });
    const notApplicableResult = completion(criterion, {
      status: 'unverified', result: 'not-run', method: 'evidence-review',
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'complete-current-goal', evidence: notApplicableResult.evidence!, completion: notApplicableResult,
    }, base.id)).toMatchObject({ ok: true, event: { kind: 'project-goal-completed' } });
  });
});
