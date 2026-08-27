import { describe, expect, it } from 'vitest';
import {
  buildProjectSupervisorAssignment,
  buildProjectSupervisorBriefing,
  isCurrentProjectTaskBatch,
  normalizeProjectTaskBatch,
  projectTaskContractDisclosureError,
  projectTaskInstructionDisclosureError,
  projectPermissionAuthorizationError,
  projectProgressObligation,
  projectEffectiveWorkItemPreconditions,
  projectContractViolation,
  projectCompletionState,
  projectDependencyError,
  projectWorkItemSubgoalDependencyError,
  projectWorkItemVerificationDeferred,
  readyProjectWorkItems,
  renderProjectTaskBatch,
  PROJECT_TASK_EVIDENCE_ARTIFACT_POLICY,
  TASK_VALIDATION_REPORTING_POLICY,
} from '../../src/renderer/project-manager/engine';
import {
  DEFAULT_PROJECT_EXECUTION_BUDGET,
  normalizeProjectManagerSession,
  projectManagerQuestionSemanticFingerprint,
  projectPlanningConfirmationDigest,
  projectPlanningConfirmationError,
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
    executionProtocolVersion: 9,
    requirementsVersion: 1,
    authorizationVersion: 1,
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
    executionProtocolVersion: 9,
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
  it('keeps a pending supervisor transition as the next project-owned obligation', () => {
    const project = session([item('implementation', 'running')]);
    project.pendingSupervisorTransitions = [{
      id: 'transition-1',
      laneId: 'lane-1',
      workItemId: 'implementation',
      kind: 'project-action-required',
      eventType: 'supervisor_transition',
      summary: '监督结论等待项目 AI 处理',
      createdAt: 10,
      notifiedAt: 20,
      notificationCount: 1,
    }];

    expect(projectProgressObligation(project)).toMatchObject({
      kind: 'handle-supervisor-transition',
      workItemId: 'implementation',
      transitionId: 'transition-1',
    });
  });

  it('separates missing stage mappings from a stage that is ready to close', () => {
    const verificationCriterion = '复核 C GUI 原型可编译并启动的既有证据';
    const stageCriterion = 'C GUI 原型可编译并启动';
    const completed = {
      ...item('foundation-result', 'completed'),
      subgoalId: 'foundation',
      completedAt: 10,
      contract: {
        ...item('foundation-result', 'completed').contract,
        stopWhen: [verificationCriterion],
        validation: [],
      },
      completion: {
        summary: '阶段证据已复核', validation: [verificationCriterion], completedAt: 10,
        criteria: [{
          criterion: verificationCriterion,
          status: 'satisfied' as const,
          result: 'passed' as const,
          method: 'evidence-review' as const,
          evidence: '构建和启动记录均存在',
          evidenceRefs: ['evidence/stage-1.md'],
          evidenceArtifacts: [{
            ref: 'evidence/stage-1.md', sizeBytes: 12, mtimeMs: 1, sha256: 'b'.repeat(64),
          }],
        }],
      },
    };
    const next = { ...item('core-flow', 'planned'), subgoalId: 'core-flow' };
    const project = session([completed, next]);
    const goalId = project.activeGoalId!;
    project.workItems = project.workItems.map((workItem) => ({ ...workItem, goalId }));
    project.subgoals = [
      {
        id: 'foundation', goalId, title: '基础原型', outcome: '原型可运行',
        acceptance: [stageCriterion], dependencies: [], status: 'planned', order: 1, createdAt: 1, updatedAt: 1,
      },
      {
        id: 'core-flow', goalId, title: '核心流程', outcome: '核心流程可用',
        acceptance: ['核心流程完成'], dependencies: ['foundation'], status: 'planned', order: 2, createdAt: 1, updatedAt: 1,
      },
    ];
    project.workItems.splice(1, 0, {
      ...project.workItems[0],
      id: 'stopped-foundation-evidence',
      status: 'stopped',
      contract: {
        ...project.workItems[0].contract,
        stageAcceptanceCoverage: [{ stageCriterion, verificationCriterion }],
      },
    });

    expect(projectProgressObligation(project)).toMatchObject({
      kind: 'map-stage-acceptance',
      workItemId: 'foundation-result',
      missingCriteria: [stageCriterion],
    });

    project.workItems[0] = {
      ...project.workItems[0],
      contract: {
        ...project.workItems[0].contract,
        stageAcceptanceCoverage: [{ stageCriterion, verificationCriterion }],
      },
    };
    const verifiedArtifacts = project.workItems[0].completion!.criteria![0].evidenceArtifacts;
    project.workItems[0].completion!.criteria![0].evidenceArtifacts = undefined;
    expect(projectProgressObligation(project)).toMatchObject({
      kind: 'plan-work',
      summary: expect.stringContaining('证据方法或结论不足'),
    });
    project.workItems[0].completion!.criteria![0].evidenceArtifacts = verifiedArtifacts;
    expect(projectProgressObligation(project)).toMatchObject({
      kind: 'close-stage',
      workItemId: 'foundation-result',
    });

    project.subgoals[0] = { ...project.subgoals[0], status: 'achieved' };
    expect(projectProgressObligation(project)).toMatchObject({ kind: 'dispatch-work', workItemId: 'core-flow' });
  });

  it('does not close a stage when a mapped criterion uses evidence weaker than the stage requires', () => {
    const stageCriterion = '实际运行验证完成';
    const verificationCriterion = '复核现有说明文档';
    const completed = {
      ...item('weak-evidence', 'completed'),
      subgoalId: 'runtime-stage',
      completedAt: 10,
      contract: {
        ...item('weak-evidence', 'completed').contract,
        stopWhen: [verificationCriterion],
        validation: [],
        stageAcceptanceCoverage: [{ stageCriterion, verificationCriterion }],
      },
      completion: {
        summary: '只完成文档复核', validation: [verificationCriterion], completedAt: 10,
        criteria: [{
          criterion: verificationCriterion,
          status: 'satisfied' as const,
          result: 'passed' as const,
          method: 'evidence-review' as const,
          evidence: '说明文档存在',
          evidenceRefs: ['evidence/readme.md'],
          evidenceArtifacts: [{
            ref: 'evidence/readme.md', sizeBytes: 12, mtimeMs: 1, sha256: 'f'.repeat(64),
          }],
        }],
      },
    };
    const project = session([completed]);
    const goalId = project.activeGoalId!;
    project.workItems = project.workItems.map((workItem) => ({ ...workItem, goalId }));
    project.subgoals = [{
      id: 'runtime-stage', goalId, title: '运行验收', outcome: '运行结果形成',
      acceptance: [stageCriterion], dependencies: [], status: 'planned',
      order: 1, createdAt: 1, updatedAt: 1,
    }];

    expect(projectProgressObligation(project)).toMatchObject({
      kind: 'plan-work',
      workItemId: 'weak-evidence',
      summary: expect.stringContaining('证据方法或结论不足'),
    });
  });

  it('normalizes only complete durable execution responsibility leases', () => {
    const normalized = normalizeProjectManagerSession({
      id: 'pm-responsibility', projectDir: 'E:\\repo', goal: '完成项目',
      preconditions: [], planFiles: [], doneWhen: ['完成'], status: 'active',
      workItems: [], events: [], createdAt: 1, updatedAt: 1,
      executionResponsibility: {
        id: ' lease-1 ', owner: 'project-ai', action: ' handle-supervisor-transition ',
        state: 'awaiting-result', transitionId: ' transition-1 ', assignedAt: 2,
        lastProgressAt: 3, deadlineAt: 4, attempt: 1, incidentKey: ' incident-1 ',
      },
    });

    expect(normalized.executionResponsibility).toEqual({
      id: 'lease-1', owner: 'project-ai', action: 'handle-supervisor-transition',
      state: 'awaiting-result', transitionId: 'transition-1', assignedAt: 2,
      lastProgressAt: 3, deadlineAt: 4, attempt: 1, incidentKey: 'incident-1',
    });
    expect(normalizeProjectManagerSession({
      ...normalized,
      executionResponsibility: { ...normalized.executionResponsibility!, action: '   ' },
    }).executionResponsibility).toBeUndefined();
    expect(() => normalizeProjectManagerSession({
      ...normalized,
      executionResponsibility: {
        ...normalized.executionResponsibility!,
        workItemId: 123 as unknown as string,
        transitionId: false as unknown as string,
      },
    })).not.toThrow();
  });

  it('rejects missing and cyclic dependencies', () => {
    expect(projectDependencyError([item('a', 'planned', ['missing'])])).toContain('不存在');
    expect(projectDependencyError([item('a', 'planned', ['b']), item('b', 'planned', ['a'])])).toContain('循环');
  });

  it('returns independent ready work for parallel scheduling', () => {
    const base = item('base', 'completed');
    const ui = item('ui', 'waiting-dependencies', ['base']);
    const api = item('api', 'planned', ['base']);
    const project = session([base, ui, api]);
    project.subgoals = [{
      id: 'stage', goalId: project.activeGoalId!, title: '测试阶段', outcome: '完成测试工作项',
      acceptance: ['工作项完成'], dependencies: [], status: 'active', order: 1, createdAt: 1, updatedAt: 1,
    }];
    project.workItems = project.workItems.map((entry) => ({ ...entry, subgoalId: 'stage' }));
    expect(readyProjectWorkItems(project).map((entry) => entry.id)).toEqual(['ui', 'api']);
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

  it('keeps dependent stages blocked after an explicit verification deferral', () => {
    const blocked = item('gui-validation', 'paused');
    const downstream = item('persistence', 'planned');
    const project = session([blocked, downstream]);
    const goalId = project.activeGoalId!;
    project.subgoals = [
      {
        id: 'gui-stage', goalId, title: 'GUI 核心交互', outcome: '形成可交互界面', acceptance: ['交互已验证'],
        dependencies: [], status: 'active', order: 1, createdAt: 1, updatedAt: 1,
      },
      {
        id: 'persistence-stage', goalId, title: '数据保存', outcome: '数据可以保存', acceptance: ['保存逻辑完成'],
        dependencies: ['gui-stage'], status: 'planned', order: 2, createdAt: 1, updatedAt: 1,
      },
    ];
    project.workItems = [
      {
        ...project.workItems[0], goalId, subgoalId: 'gui-stage',
        verificationDecision: {
          action: 'defer-verification', questionId: 'question-1', reason: 'GUI 自动化不可用',
          answeredBy: 'desktop', requirementsVersion: 1, authorizationVersion: 1, decidedAt: 2,
        },
      },
      { ...project.workItems[1], goalId, subgoalId: 'persistence-stage' },
    ];

    expect(projectWorkItemVerificationDeferred(project, project.workItems[0])).toBe(true);
    expect(projectWorkItemSubgoalDependencyError(project, project.workItems[1])).toContain('gui-stage');
    expect(readyProjectWorkItems(project)).toEqual([]);

    project.workItems[0] = {
      ...project.workItems[0],
      status: 'stopped',
      verificationDecision: {
        ...project.workItems[0].verificationDecision!,
        action: 'skip-verification',
      },
    };
    expect(projectWorkItemVerificationDeferred(project, project.workItems[0])).toBe(true);
    expect(projectWorkItemSubgoalDependencyError(project, project.workItems[1])).toContain('gui-stage');
    project.subgoals[0] = { ...project.subgoals[0], status: 'obsolete' };
    expect(projectWorkItemSubgoalDependencyError(project, project.workItems[1])).toBeNull();
    expect(readyProjectWorkItems(project).map((entry) => entry.id)).toEqual(['persistence']);
    project.subgoals[0] = { ...project.subgoals[0], status: 'active' };

    const unfinishedSibling = {
      ...project.workItems[0], id: 'gui-unfinished-sibling', status: 'planned' as const,
      verificationDecision: undefined,
    };
    project.workItems.splice(1, 0, unfinishedSibling);
    expect(projectWorkItemSubgoalDependencyError(project, project.workItems[2])).toContain('gui-stage');
    project.workItems.splice(1, 1);

    project.authorizationVersion = 2;
    expect(projectWorkItemVerificationDeferred(project, project.workItems[0])).toBe(false);
    expect(projectWorkItemSubgoalDependencyError(project, project.workItems[1])).toContain('gui-stage');
  });

  it('requires project-level validation after all work completes', () => {
    expect(projectCompletionState(session([item('a', 'completed')]))).toBe('ready-for-validation');
  });  it('keeps implicit targeted-test permission inside a single safe command', () => {
    const contract = item('test-permission', 'planned').contract;
    contract.authority.allowedCommandPrefixes = [];
    expect(projectPermissionAuthorizationError(contract, 'npm test')).toBeNull();
    expect(projectPermissionAuthorizationError(contract, 'npm test && powershell -EncodedCommand ZQB2AGkAbAA='))
      .toContain('shell');
    expect(projectPermissionAuthorizationError(contract, 'npm test; Remove-Item important.txt'))
      .toContain('shell');
    expect(projectPermissionAuthorizationError(contract, 'npm test | powershell -Command Get-Content important.txt'))
      .toContain('shell');
    expect(projectPermissionAuthorizationError(contract, 'npm test powershell -EncodedCommand ZQB2AGkAbAA='))
      .toContain('解释器');
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
  });

  it('builds one canonical supervisor assignment and reuses its effective preconditions for tasks', () => {
    const project = session([item('auth', 'planned')]);
    const workItem = project.workItems[0];
    workItem.title = '认证成果';
    workItem.subgoalId = 'auth-stage';
    workItem.contract = {
      ...workItem.contract,
      description: '覆盖正常与异常认证行为',
      preconditions: ['认证测试环境可用'],
      stageAcceptanceCoverage: [{
        stageCriterion: '认证行为可验收',
        verificationCriterion: 'npm test -- auth',
      }],
    };
    project.subgoals = [{
      id: 'auth-stage', goalId: workItem.goalId!, title: '认证阶段', outcome: '形成认证能力',
      acceptance: ['认证行为可验收'], dependencies: [], status: 'active',
      order: 1, createdAt: 1, updatedAt: 1,
    }];

    const assignment = buildProjectSupervisorAssignment(project, workItem);
    expect(assignment.effectivePreconditions).toEqual(['环境已准备', '认证测试环境可用']);
    expect(assignment.stageAcceptanceCoverage).toEqual([{
      stageCriterion: '认证行为可验收', verificationCriterion: 'npm test -- auth',
    }]);
    const supervisorBriefing = buildProjectSupervisorBriefing(assignment);
    expect(supervisorBriefing).toContain('阶段验收：认证行为可验收');
    expect(supervisorBriefing).toContain('认证行为可验收 ← npm test -- auth');

    const taskBriefing = renderProjectTaskBatch(workItem.contract, {
      kind: 'task', coverage: 'bounded-batch', outcome: '形成认证行为',
      completionDefinition: ['认证行为形成'], evidenceExpectations: [],
      unmetCompletionItems: [], knownFacts: [], constraints: [], nonGoals: [],
    }, 'single-thread', {
      effectivePreconditions: projectEffectiveWorkItemPreconditions(project, workItem),
    });
    expect(taskBriefing).toContain('成果说明：覆盖正常与异常认证行为');
    expect(taskBriefing).toContain('- 环境已准备');
    expect(taskBriefing).toContain('- 认证测试环境可用');
  });

  it('allows a low atomic work item to remain one whole neutral batch', () => {
    const workItem = {
      ...item('auth', 'planned'),
      complexityAssessment: {
        complexity: 'low' as const,
        decision: 'single-task' as const,
        signals: ['只有一个独立可验收成果'],
        rationale: '无需为了形式拆小',
        assessedAt: 1,
      },
    };
    const normalized = normalizeProjectTaskBatch({
      kind: 'task',
      coverage: 'whole-item',
      outcome: workItem.contract.objective,
      completionDefinition: [...workItem.contract.stopWhen],
      evidenceExpectations: [...workItem.contract.validation],
      unmetCompletionItems: [],
      knownFacts: ['认证模块尚未形成验证证据'],
      constraints: ['遵循当前项目规则'],
      nonGoals: ['不处理支付模块'],
    }, workItem);
    expect(normalized.error).toBeUndefined();
    const delivery = renderProjectTaskBatch(workItem.contract, normalized.batch!);
    expect(delivery).toContain(`成果方向：${workItem.contract.objective}`);
    expect(delivery).toContain(`本批成果：${workItem.contract.objective}`);
    expect(delivery).toContain('读取并严格遵循当前目录层级适用的 AGENTS、项目技能和仓库规范');
    expect(delivery).toContain(PROJECT_TASK_EVIDENCE_ARTIFACT_POLICY);
    expect(delivery).toContain('验证要求（必须核对并如实报告成功、失败或无法取得）');
    expect(delivery).toContain('列出项目内相对路径');
    expect(delivery).toContain('不得只在最终回复中列出哈希');
    expect(delivery).toContain('[执行模式] 单线程');
    expect(delivery).toContain('不限制在同一轮内连续完成多个必要步骤');
    expect(delivery).not.toMatch(/项目 AI|监督 AI|项目 ID|工作项 ID|\blane\b|控制层/iu);

    const smallWithSeveralChecks = {
      ...workItem,
      contract: {
        ...workItem.contract,
        stopWhen: ['成果形成', '边界行为明确', '错误结果可复核', '没有剩余工作'],
        validation: ['相关检查完成', '证据可以复查'],
      },
    };
    expect(normalizeProjectTaskBatch({
      kind: 'task', coverage: 'whole-item', outcome: smallWithSeveralChecks.contract.objective,
      completionDefinition: [...smallWithSeveralChecks.contract.stopWhen],
      evidenceExpectations: [], unmetCompletionItems: [],
      knownFacts: [], constraints: [], nonGoals: [],
    }, smallWithSeveralChecks).error).toContain('全部 validation');
    expect(normalizeProjectTaskBatch({
      kind: 'task', coverage: 'whole-item', outcome: smallWithSeveralChecks.contract.objective,
      completionDefinition: [...smallWithSeveralChecks.contract.stopWhen],
      evidenceExpectations: [...smallWithSeveralChecks.contract.validation],
      unmetCompletionItems: [], knownFacts: [], constraints: [], nonGoals: [],
    }, smallWithSeveralChecks).batch?.coverage).toBe('whole-item');
  });

  it('requires a bounded batch for larger work and keeps each batch focused', () => {
    const workItem = {
      ...item('auth', 'planned'),
      complexityAssessment: {
        complexity: 'medium' as const,
        decision: 'single-task' as const,
        signals: ['一个成果需要多个顺序检查点'],
        rationale: '由同一任务上下文分批完成',
        assessedAt: 1,
      },
    };
    expect(normalizeProjectTaskBatch({
      kind: 'task', coverage: 'whole-item', outcome: workItem.contract.objective,
      completionDefinition: [...workItem.contract.stopWhen],
    }, workItem).error).toContain('bounded-batch');
    expect(normalizeProjectTaskBatch({
      kind: 'task', coverage: 'bounded-batch', outcome: '形成认证接口的可验证行为',
      completionDefinition: ['接口行为可复核', '错误路径明确', '边界结果清晰', '集成行为完整'],
    }, workItem).error).toContain('最多包含 3 个');
    const focused = normalizeProjectTaskBatch({
      kind: 'task', coverage: 'bounded-batch', outcome: '形成认证接口的可验证行为',
      completionDefinition: ['接口行为形成', '错误路径行为明确'],
      evidenceExpectations: [], unmetCompletionItems: [],
      knownFacts: [], constraints: ['遵循项目规范'], nonGoals: ['不处理支付流程'],
    }, workItem);
    expect(focused.batch).toMatchObject({
      coverage: 'bounded-batch',
      completionDefinition: ['接口行为形成', '错误路径行为明确'],
      evidenceExpectations: [],
      unmetCompletionItems: [],
    });
    const delivery = renderProjectTaskBatch(workItem.contract, focused.batch!, 'multi-thread');
    expect(delivery).toContain('[执行模式] 多线程');
    expect(delivery).toContain('本批成果使用主线程和必要的内部子线程或子代理并行处理');
    expect(delivery).toContain('不得超过 3 个');
    expect(delivery).toContain('具体拆分、线程职责和整合方式根据项目事实自行决定');
    expect(delivery).toContain('完成定义');
    expect(delivery).toContain(TASK_VALIDATION_REPORTING_POLICY);
    expect(delivery).toContain('可自主修正并重新验证');
    expect(delivery).toContain('允许返回失败或无法验证，不代表完成定义已经满足');
    expect(TASK_VALIDATION_REPORTING_POLICY).not.toMatch(/项目 AI|监督 AI|辅助 AI|控制层|\blane\b/iu);
    expect(delivery).toContain('本批不要求交付');
    expect(delivery).not.toContain('证据期望（如适用）');
    expect(delivery).not.toContain('本轮未通过项');
    expect(delivery).not.toMatch(/任务 AI|监督 AI|项目 AI|工作项|控制层/iu);

    const firstDispatchWithUnmet = normalizeProjectTaskBatch({
      kind: 'task', coverage: 'bounded-batch', outcome: '形成认证接口行为',
      completionDefinition: ['接口行为形成'],
      unmetCompletionItems: ['上一轮接口行为未形成'],
    }, workItem);
    expect(firstDispatchWithUnmet.error).toContain('首次派遣不能包含');

    const continuation = normalizeProjectTaskBatch({
      kind: 'task', coverage: 'bounded-batch', outcome: '继续形成认证接口行为',
      completionDefinition: ['接口行为形成'], evidenceExpectations: [],
      unmetCompletionItems: ['上一轮接口行为未形成'],
    }, workItem, { allowUnmetCompletionItems: true });
    expect(continuation.error).toBeUndefined();
    expect(renderProjectTaskBatch(workItem.contract, continuation.batch!)).toContain('本轮未通过项');
    expect(isCurrentProjectTaskBatch(continuation.batch)).toBe(true);
    expect(isCurrentProjectTaskBatch({
      kind: 'task', coverage: 'bounded-batch', outcome: '旧任务包',
      acceptanceGap: ['旧验收缺口'], knownFacts: [], constraints: [], nonGoals: [], returnWhen: [],
    })).toBe(false);
  });  it('rejects orchestration identity and prescribed implementation details in a project batch', () => {
    const workItem = {
      ...item('auth', 'planned'),
      complexityAssessment: {
        complexity: 'low' as const, decision: 'single-task' as const,
        signals: ['单一成果'], rationale: '原子任务', assessedAt: 1,
      },
    };
    expect(normalizeProjectTaskBatch({
      kind: 'task', coverage: 'bounded-batch', outcome: '按监督 AI 安排形成成果',
      completionDefinition: ['结果形成'],
    }, workItem).error).toContain('不能暴露');
    expect(normalizeProjectTaskBatch({
      kind: 'task', coverage: 'bounded-batch', outcome: '必须修改 src/auth.ts 形成成果',
      completionDefinition: ['结果形成'],
    }, workItem).error).toContain('不能指定文件');
  });  it('rejects English orchestration identities without blocking domain component names', () => {
    const disclosures = [
      "Follow the project manager's plan and finish the current outcome.",
      'Report back to your supervisor after validation.',
      'Wait for the control plane before continuing.',
      'Attach the work item ID to the result.',
      'Ask the auxiliary task AI to handle the tests.',
    ];

    for (const instruction of disclosures) {
      expect(projectTaskInstructionDisclosureError(instruction))
        .toContain('不能暴露内部编排身份或路由信息');
    }
    expect(projectTaskInstructionDisclosureError(
      'Update the SupervisorPanel component and project manager dialog labels.',
    )).toBeNull();
    expect(projectTaskInstructionDisclosureError('修改项目管理系统的对话框标签')).toBeNull();
  });  it('rejects orchestration identities hidden in task contract fields', () => {
    const contract = item('auth', 'planned').contract;
    expect(projectTaskContractDisclosureError({
      ...contract,
      objective: '按项目 AI 决定完成任务并向监督 AI 汇报，工作项 ID=task-a',
    })).toContain('任务合同 objective');
    expect(projectTaskContractDisclosureError(contract)).toBeNull();
  });  it('binds reusable decisions and planning confirmations to their visible semantic scope', () => {
    const base = {
      category: 'clarification' as const,
      reasonCode: undefined,
      question: '如何处理配置冲突？',
      context: '当前配置存在冲突。',
      options: [
        { id: 'keep', label: '保留配置', description: '保持兼容。' },
        { id: 'replace', label: '替换配置', description: '采用新配置。' },
      ],
      decisionScope: '配置冲突时是否保留兼容性设置',
      confirmationScope: [] as string[],
    };
    expect(projectManagerQuestionSemanticFingerprint(base)).toBe(projectManagerQuestionSemanticFingerprint({
      ...base,
      question: '同类配置冲突应如何处理？',
      context: '另一处配置发生相同冲突。',
    }));
    expect(projectManagerQuestionSemanticFingerprint(base)).not.toBe(projectManagerQuestionSemanticFingerprint({
      ...base,
      decisionScope: '是否删除历史项目数据',
    }));

    const project = session([]);
    const scope = ['goal: 新的用户目标'];
    project.events = [{
      id: 'confirmed-plan', sessionId: project.id, ts: 2,
      kind: 'user-clarification-answered', summary: '用户确认新目标',
      payload: { confirmationScope: scope, confirmationDigest: projectPlanningConfirmationDigest(scope) },
    }];
    expect(projectPlanningConfirmationError(project, {
      changesUserPlan: true, userConfirmationEventId: 'confirmed-plan', confirmationScope: scope,
    })).toBeNull();
    expect(projectPlanningConfirmationError(project, {
      changesUserPlan: true, userConfirmationEventId: 'confirmed-plan', confirmationScope: ['goal: 未确认目标'],
    })).toContain('未覆盖');

  });});
