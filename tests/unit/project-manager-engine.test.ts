import { describe, expect, it } from 'vitest';
import {
  PROJECT_TASK_BASELINE_APPROVAL_MARKER,
  PROJECT_TASK_BASELINE_INVESTIGATION_MARKER,
  PROJECT_TASK_BASELINE_REPORT_MARKER,
  buildProjectTaskExecutionEnvelope,
  buildProjectSupervisorBriefing,
  prepareProjectTaskDelivery,
  projectPermissionAuthorizationError,
  projectProgressObligation,
  projectTaskBaselineViolation,
  projectContractViolation,
  projectCompletionState,
  projectDependencyError,
  projectWorkItemSubgoalDependencyError,
  readyProjectWorkItems,
} from '../../src/renderer/project-manager/engine';
import {
  DEFAULT_PROJECT_EXECUTION_BUDGET,
  normalizeProjectManagerSession,
  type ProjectManagerSession,
  type ProjectWorkItem,
} from '../../src/shared/project-manager';

function item(id: string, status: ProjectWorkItem['status'], dependencies: string[] = []): ProjectWorkItem {
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
      objective: `完成 ${id}`,
      description: '',
      preconditions: [],
      scope: { root: 'E:\\repo', allowPaths: ['src/auth'], denyPaths: ['src/payments'], forbiddenActions: ['git push'] },
      authority: {
        technicalChoices: true,
        lowRiskRetries: true,
        targetedTests: true,
        internalThreads: false,
        continuousExecution: true,
        permissionConfirm: true,
        allowedCommandPrefixes: ['npm test -- auth'],
        authorizedDevices: [],
        authorizedEnvironments: ['本地工作区'],
        authorizedOperations: ['实现认证接口', '运行认证测试'],
      },
      stopWhen: ['认证测试通过'],
      validation: ['npm test -- auth'],
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
    },
  };
}

function session(workItems: ProjectWorkItem[], status: ProjectManagerSession['status'] = 'active'): ProjectManagerSession {
  const normalized = normalizeProjectManagerSession({
    id: 'pm-1', projectDir: 'E:\\repo', goal: '完成项目', preconditions: ['环境已准备'], planFiles: [], doneWhen: ['全部测试通过'], status,
    requirementsVersion: 1, authorizationVersion: 1, acceptedRequirementsVersion: 1,
    workItems, events: [], createdAt: 1, updatedAt: 1,
  });
  return {
    ...normalized,
    progressSnapshot: {
      version: 1, capturedAt: 1, mode: 'git', fingerprint: 'test', entries: [], truncated: false,
    },
    progressSync: { status: 'ready', checkedAt: 1, snapshotFingerprint: 'test', changeCount: 0 },
    orientation: {
      status: 'ready', requirementsVersion: 1, authorizationVersion: 1,
      snapshotFingerprint: 'test', reason: '测试基线', requestedAt: 1,
      summary: '测试项目状态已知', knownFacts: ['测试事实'], unknowns: [], workItems: [], acknowledgedAt: 1,
    },
  };
}

describe('project-manager engine', () => {
  it('rejects missing and cyclic dependencies', () => {
    expect(projectDependencyError([item('a', 'planned', ['missing'])])).toContain('不存在');
    expect(projectDependencyError([item('a', 'planned', ['b']), item('b', 'planned', ['a'])])).toContain('循环');
  });

  it('returns independent ready work for parallel scheduling', () => {
    const base = item('base', 'completed');
    const ui = item('ui', 'waiting-dependencies', ['base']);
    const api = item('api', 'planned', ['base']);
    expect(readyProjectWorkItems(session([base, ui, api])).map((entry) => entry.id)).toEqual(['ui', 'api']);
  });

  it('does not dispatch work before its coarse stage dependencies finish', () => {
    const project = session([item('implementation', 'planned')]);
    const goalId = project.activeGoalId!;
    project.subgoals = [
      {
        id: 'design', goalId, title: '方案定稿', outcome: '形成可执行方案', acceptance: ['方案已确认'],
        dependencies: [], status: 'active', order: 1, createdAt: 1, updatedAt: 1,
      },
      {
        id: 'implementation', goalId, title: '实现完成', outcome: '完成实现', acceptance: ['实现可验证'],
        dependencies: ['design'], status: 'planned', order: 2, createdAt: 1, updatedAt: 1,
      },
    ];
    project.workItems[0] = { ...project.workItems[0], goalId, subgoalId: 'implementation' };

    expect(projectWorkItemSubgoalDependencyError(project, project.workItems[0])).toContain('design');
    expect(readyProjectWorkItems(project)).toEqual([]);

    project.subgoals[0] = { ...project.subgoals[0], status: 'achieved' };
    expect(projectWorkItemSubgoalDependencyError(project, project.workItems[0])).toBeNull();
    expect(readyProjectWorkItems(project).map((entry) => entry.id)).toEqual(['implementation']);
  });

  it('requires project-level validation after all work completes', () => {
    expect(projectCompletionState(session([item('a', 'completed')]))).toBe('ready-for-validation');
  });  it('keeps refine and pivot waiting states on deterministic internal gates', () => {
    const refine = session([item('stale-stage', 'planned')], 'waiting');
    refine.authorizationVersion = 2;
    refine.orientation = { ...refine.orientation!, authorizationVersion: 2 };
    expect(projectProgressObligation(refine)).toMatchObject({ kind: 'reconcile-stale-work' });

    const completedEvidence = session([item('completed-evidence', 'completed')], 'waiting');
    completedEvidence.requirementsVersion = 2;
    completedEvidence.acceptedRequirementsVersion = 2;
    completedEvidence.orientation = {
      ...completedEvidence.orientation!, requirementsVersion: 2, status: 'ready',
    };
    completedEvidence.subgoals = [{
      id: 'old-achieved-stage', goalId: completedEvidence.activeGoalId!, title: '旧阶段', outcome: '旧成果',
      acceptance: ['旧成果已验收'], dependencies: [], status: 'achieved', order: 1, createdAt: 1, updatedAt: 1,
    }];
    expect(projectProgressObligation(completedEvidence)).toMatchObject({ kind: 'plan-work' });

    const pivot = session([], 'waiting');
    pivot.acceptedRequirementsVersion = 0;
    pivot.events = [
      { id: 'alignment-required', sessionId: pivot.id, ts: 1, kind: 'requirements-alignment-required', summary: '重新对齐' },
      { id: 'alignment-confirmed', sessionId: pivot.id, ts: 2, kind: 'requirements-alignment-confirmed', summary: '已确认' },
    ];
    pivot.orientation = { ...pivot.orientation!, status: 'required' };
    expect(projectProgressObligation(pivot)).toMatchObject({ kind: 'orient-project' });

    pivot.orientation = { ...pivot.orientation, status: 'ready' };
    expect(projectProgressObligation(pivot)).toMatchObject({ kind: 'plan-work' });

    pivot.subgoals = [{
      id: 'new-goal-plan', goalId: pivot.activeGoalId!, title: '新目标阶段', outcome: '形成新目标成果',
      acceptance: ['成果可验收'], dependencies: [], status: 'planned', order: 1, createdAt: 1, updatedAt: 1,
    }];
    expect(projectProgressObligation(pivot)).toMatchObject({ kind: 'resume-project' });

    pivot.goals = pivot.goals.map((goal) => goal.id === pivot.activeGoalId ? { ...goal, status: 'achieved' as const } : goal);
    expect(projectProgressObligation(pivot)).toBeNull();
  });  it('keeps control-plane identity out of the task packet', () => {
    const contract = item('auth', 'planned').contract;
    const prepared = prepareProjectTaskDelivery(
      contract,
      '继续当前合同',
      true,
    );
    expect(prepared.delivery).toContain('[成果任务]');
    expect(prepared.delivery).toContain('继续当前合同');
    expect(prepared.delivery).not.toMatch(/项目 ID|工作项|需求版本|授权版本|监督 AI|普通监督链|裁决|lane/iu);
  });  it('injects the trusted contract while exposing only the executable action to guards', () => {
    const contract = item('auth', 'planned').contract;
    const envelope = buildProjectTaskExecutionEnvelope(contract);
    const prepared = prepareProjectTaskDelivery(contract, '检查认证实现并完成合同内验证', true);
    expect(prepared.action).toBe('检查认证实现并完成合同内验证');
    expect(prepared.delivery).toBe(`${envelope}\n\n[本轮执行指令]\n${prepared.action}`);
    expect(projectContractViolation(contract, { instruction: prepared.action })).toBeNull();

    const supervisedModeChange = prepareProjectTaskDelivery(
      contract,
      '继续完成当前成果',
      false,
      'multi-thread',
      true,
    );
    expect(supervisedModeChange.action).toBe('继续完成当前成果');
    expect(supervisedModeChange.delivery).toContain('[执行模式] 多线程');

    const legacy = prepareProjectTaskDelivery(
      contract,
      `${envelope}\n\n[本轮执行指令]\n检查认证实现`,
      true,
    );
    expect(legacy.action).toBe('检查认证实现');
    expect(legacy.delivery).toBe(`${envelope}\n\n[本轮执行指令]\n检查认证实现`);
  });});
