import { describe, expect, it } from 'vitest';
import {
  PROJECT_TASK_BASELINE_APPROVAL_MARKER,
  PROJECT_TASK_BASELINE_INVESTIGATION_MARKER,
  PROJECT_TASK_BASELINE_REPORT_MARKER,
  PROJECT_TASK_EXECUTION_ENVELOPE_MARKER,
  buildProjectExecutionIdentityBlock,
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
  });

  it('keeps paused work unfinished and derives one concrete progress obligation', () => {
    const paused = session([item('blocked-stage', 'paused')]);
    expect(projectCompletionState(paused)).toBe('blocked');
    expect(projectProgressObligation(paused)).toMatchObject({
      kind: 'resume-paused', workItemId: 'blocked-stage',
    });

    expect(projectProgressObligation(session([]))).toMatchObject({ kind: 'plan-work' });
    expect(projectProgressObligation(session([item('ready-stage', 'planned')]))).toMatchObject({
      kind: 'dispatch-work', workItemId: 'ready-stage',
    });
    const unaligned = session([]);
    unaligned.acceptedRequirementsVersion = 0;
    expect(projectProgressObligation(unaligned)).toMatchObject({ kind: 'align-requirements' });
    const unoriented = session([]);
    unoriented.orientation = { ...unoriented.orientation!, status: 'required' };
    expect(projectProgressObligation(unoriented)).toMatchObject({ kind: 'orient-project' });
    const stale = session([item('stale-stage', 'planned')]);
    stale.authorizationVersion = 2;
    stale.orientation = { ...stale.orientation!, authorizationVersion: 2 };
    expect(projectProgressObligation(stale)).toMatchObject({ kind: 'reconcile-stale-work' });

    const mixed = session([item('current-stage', 'completed'), item('old-stage', 'planned')]);
    mixed.authorizationVersion = 2;
    mixed.orientation = { ...mixed.orientation!, authorizationVersion: 2 };
    mixed.workItems[0].authorizationVersion = 2;
    expect(projectProgressObligation(mixed)).toMatchObject({ kind: 'reconcile-stale-work' });
  });

  it('builds a bounded supervisor briefing with anti-loop instructions', () => {
    const executionIdentity = {
      projectId: 'project-auth',
      goalId: 'goal-auth',
      workItemId: 'auth',
      requirementsVersion: 3,
      authorizationVersion: 2,
    };
    const text = buildProjectSupervisorBriefing({
      workItemId: 'auth',
      contract: item('auth', 'planned').contract,
      executionIdentity,
      projectGoal: '交付完整认证能力',
      stage: {
        title: '认证闭环',
        outcome: '认证实现、回归与边界证据形成闭环',
        acceptance: ['实现与回归测试一致', '边界证据可复核'],
      },
    });
    expect(text).toContain('允许范围：src/auth');
    expect(text).toContain('禁止动作：git push');
    expect(text).toContain('不得原样重复命令或测试');
    expect(text).toContain('最多 12 次连续决策');
    expect(text).toContain('[项目主目标背景] 交付完整认证能力');
    expect(text).toContain('阶段成果：认证实现、回归与边界证据形成闭环');
    expect(text).toContain('委派粒度是可验收的完整阶段成果');
    expect(text).toContain('小里程碑结束不得进入待续');
    expect(text).toContain('当前需求版本内由监督 AI 和任务 AI 持续继承');
    expect(text).toContain('不得把同一条件拆成逐步确认');
    expect(text).toContain(PROJECT_TASK_EXECUTION_ENVELOPE_MARKER);
    expect(text).toContain('--next 只填写本轮实际执行批次');
    expect(text).toContain('内容过长时自动改用受控临时文件投递');
    expect(text).toContain('项目基线：待审核');
    expect(text).toContain(PROJECT_TASK_BASELINE_INVESTIGATION_MARKER);
    expect(text).toContain(buildProjectExecutionIdentityBlock(executionIdentity));
    expect(text).toContain('暂缓当前工作项并推进不依赖项');
  });

  it('binds one revision-scoped execution identity into the task contract', () => {
    const contract = item('auth', 'planned').contract;
    const executionIdentity = {
      projectId: 'project-auth',
      goalId: 'goal-auth',
      workItemId: 'auth',
      requirementsVersion: 3,
      authorizationVersion: 2,
    };
    const prepared = prepareProjectTaskDelivery(
      contract,
      '继续当前合同',
      true,
      executionIdentity,
    );
    expect(prepared.delivery).toContain('[项目执行身份｜控制层已绑定]');
    expect(prepared.delivery).toContain('需求版本：R3');
    expect(prepared.delivery).toContain('授权版本：A2');
    expect(prepared.delivery).toContain('不得等待旧身份或自行恢复旧会话');
  });

  it('builds one continuous execution envelope instead of a micro-step', () => {
    const contract = item('auth', 'planned').contract;
    const text = buildProjectTaskExecutionEnvelope(contract);
    expect(text).toContain(PROJECT_TASK_EXECUTION_ENVELOPE_MARKER);
    expect(text).toContain('目标：完成 auth');
    expect(text).toContain('停止条件：认证测试通过');
    expect(text).toContain('验证要求：npm test -- auth');
    expect(text).toContain('每个回合连续完成一个有意义、可验证的执行批次');
    expect(text).toContain('不得在整个阶段内绕过监督检查点');
    expect(text).toContain(PROJECT_TASK_BASELINE_REPORT_MARKER);
    expect(text).toContain('任何写入');
  });

  it('enforces a two-round read-only project baseline before implementation', () => {
    const task = item('auth', 'running');
    task.requirementsVersion = 1;
    task.baseline = { status: 'required', requirementsVersion: 1 };

    expect(projectTaskBaselineViolation(task, {
      outcome: 'continue', instruction: '直接修改认证实现',
    })).toContain('只能先下达');
    expect(projectTaskBaselineViolation(task, {
      outcome: 'continue', instruction: `${PROJECT_TASK_BASELINE_APPROVAL_MARKER} 开始实现`,
      evidence: '已查看结构', workspaceVersion: 'head:abc',
    })).toContain('不能预先批准');
    expect(projectTaskBaselineViolation(task, {
      outcome: 'continue', instruction: `${PROJECT_TASK_BASELINE_INVESTIGATION_MARKER} 只读查看相关结构`,
      testCommand: 'npm test -- auth',
    })).toContain('只允许只读调查');
    expect(projectTaskBaselineViolation(task, {
      outcome: 'continue', instruction: `${PROJECT_TASK_BASELINE_INVESTIGATION_MARKER} 只读查看相关结构`,
    })).toBeNull();

    task.baseline = {
      status: 'investigating', requirementsVersion: 1, requestedAt: 2, investigationRounds: 1,
    };
    expect(buildProjectSupervisorBriefing({
      workItemId: task.id, contract: task.contract, baseline: task.baseline,
    })).toContain('只读调查已投递');
    expect(projectTaskBaselineViolation(task, {
      outcome: 'continue', instruction: `${PROJECT_TASK_BASELINE_APPROVAL_MARKER} 开始实现`,
    })).toContain('--evidence');
    expect(projectTaskBaselineViolation(task, {
      outcome: 'continue', instruction: `${PROJECT_TASK_BASELINE_APPROVAL_MARKER} 开始实现`,
      evidence: '已核对工作树、入口、测试约定和改动边界', workspaceVersion: 'head:abc,status:clean',
    })).toBeNull();
    expect(projectTaskBaselineViolation(task, {
      outcome: 'continue', instruction: `${PROJECT_TASK_BASELINE_APPROVAL_MARKER} 开始实现`,
      evidence: '已核对工作树、入口、测试约定和改动边界', workspaceVersion: 'head:abc,status:clean',
      changedFiles: ['src/auth.ts'], testCommand: 'npm test -- auth', testResult: 'passed',
    })).toContain('批准项目基线的原子裁决不得携带');
    expect(projectTaskBaselineViolation(task, {
      outcome: 'continue', instruction: `${PROJECT_TASK_BASELINE_INVESTIGATION_MARKER} 定向核对唯一缺失入口`,
    })).toBeNull();
    task.baseline.investigationRounds = 2;
    expect(projectTaskBaselineViolation(task, {
      outcome: 'continue', instruction: `${PROJECT_TASK_BASELINE_INVESTIGATION_MARKER} 再次调查`,
    })).toContain('不能继续重复调查');
    expect(projectTaskBaselineViolation(task, { outcome: 'complete' })).toContain('不能把工作项判定为完成');
  });

  it('injects the trusted contract while exposing only the executable action to guards', () => {
    const contract = item('auth', 'planned').contract;
    const envelope = buildProjectTaskExecutionEnvelope(contract);
    const prepared = prepareProjectTaskDelivery(contract, '检查认证实现并完成合同内验证', true);
    expect(prepared.action).toBe('检查认证实现并完成合同内验证');
    expect(prepared.delivery).toBe(`${envelope}\n\n[本轮执行指令]\n${prepared.action}`);
    expect(projectContractViolation(contract, { instruction: prepared.action })).toBeNull();

    const legacy = prepareProjectTaskDelivery(
      contract,
      `${envelope}\n\n[本轮执行指令]\n检查认证实现`,
      true,
    );
    expect(legacy.action).toBe('检查认证实现');
    expect(legacy.delivery).toBe(`${envelope}\n\n[本轮执行指令]\n检查认证实现`);
  });

  it('requires explicit permission grant and narrows tests with command prefixes', () => {
    const contract = item('auth', 'planned').contract;
    expect(projectPermissionAuthorizationError(contract, 'npm test -- auth')).toBeNull();
    expect(projectPermissionAuthorizationError(contract, 'npm test -- payments')).toContain('allowedCommandPrefixes');
    expect(projectPermissionAuthorizationError(
      contract,
      'npm test -- auth && npm publish',
    )).toContain('allowedCommandPrefixes');
    expect(projectPermissionAuthorizationError({
      ...contract,
      authority: { ...contract.authority, permissionConfirm: false },
    }, 'npm test -- auth')).toContain('未授权');
    const broadTestContract = {
      ...contract,
      authority: { ...contract.authority, allowedCommandPrefixes: [] },
    };
    expect(projectPermissionAuthorizationError(broadTestContract, 'npm test -- auth')).toBeNull();
    expect(projectPermissionAuthorizationError(
      broadTestContract,
      'echo unrelated-command && npm test -- auth',
    )).toContain('allowedCommandPrefixes');
  });

  it('passes a multi-thread plan and explicit thread responsibilities to the supervisor', () => {
    const contract = item('auth', 'planned').contract;
    contract.authority.internalThreads = true;
    contract.execution = {
      taskWorkMode: 'multi-thread',
      modeReason: 'UI 与协议验证可以独立取证',
      mainThreadResponsibility: '整合实现并负责最终验证',
      childThreadResponsibilities: ['检查 UI 状态', '检查协议和恢复行为'],
    };
    const text = buildProjectSupervisorBriefing({ workItemId: 'auth', contract });
    expect(text).toContain('任务终端工作模式：固定多线程');
    expect(text).toContain('主线程职责：整合实现并负责最终验证');
    expect(text).toContain('子线程 1 职责：检查 UI 状态');
    expect(text).toContain('必须把以上线程职责清晰传达给任务终端');
    expect(text).toContain('除批准项目基线的原子裁决外');
    expect(text).toContain('构建工具自动生成的二进制');
  });

  it('briefs adaptive tasks with bounded proposal approval and serialized hardware work', () => {
    const contract = item('auth', 'planned').contract;
    contract.authority.internalThreads = true;
    contract.execution = {
      taskWorkMode: 'adaptive',
      modeReason: '需要先确认实现与测试的写入边界',
      mainThreadResponsibility: '完成探测、集成和最终验证',
      childThreadResponsibilities: [],
      maxChildThreads: 2,
      supervisorMayApproveThreads: true,
      parallelizableOperations: ['只读分析实现', '只读分析测试'],
      serializedOperations: ['设备重上电', '最终集成验证'],
    };

    const briefing = buildProjectSupervisorBriefing({ workItemId: 'auth', contract });
    const envelope = buildProjectTaskExecutionEnvelope(contract);

    expect(briefing).toContain('任务终端工作模式：自适应线程');
    expect(briefing).toContain('允许的内部子线程上限：2');
    expect(briefing).toContain('[批准内部线程方案 childThreads=N]');
    expect(briefing).toContain('设备上电/重上电');
    expect(envelope).toContain('先进行一次有界、只读的结构探测');
    expect(envelope).toContain('带有明确 childThreads 数字的批准标记前不得创建内部子线程');
    expect(envelope).toContain('必须串行：设备重上电；最终集成验证');
    expect(envelope).toContain('不得新建 wmux 任务终端');
    expect(projectContractViolation(contract, {
      instruction: '[批准内部线程方案 childThreads=3] 并行处理三个任务',
    })).toContain('超出任务契约上限 2');
    expect(projectContractViolation(contract, {
      instruction: '[批准内部线程方案 childThreads=2] 按互斥文件所有权执行',
    })).toBeNull();
    expect(projectContractViolation(contract, {
      instruction: '[批准内部线程方案] 缺少结构化数量',
    })).toContain('必须使用');
  });

  it('rejects forbidden actions, out-of-scope files, ungranted tests and retries', () => {
    const contract = item('auth', 'planned').contract;
    expect(projectContractViolation(contract, { command: 'git push origin main' })).toContain('禁止动作');
    expect(projectContractViolation(contract, {
      instruction: '[批准内部线程方案 childThreads=1]',
    })).toContain('未授权');
    expect(projectContractViolation(contract, { changedFiles: ['src/payments/card.ts'] })).toContain('禁止路径');
    expect(projectContractViolation(contract, { changedFiles: ['src/profile/view.ts'] })).toContain('允许范围');
    expect(projectContractViolation({
      ...contract,
      authority: { ...contract.authority, targetedTests: false, lowRiskRetries: false },
    }, { testCommand: 'npm test -- auth', retry: true })).toContain('运行测试');
  });

  it('distinguishes a negated safety reference from an affirmative forbidden action', () => {
    const contract = item('auth', 'planned').contract;
    expect(projectContractViolation(contract, {
      instruction: '不要执行 git push，并且不得修改 src/payments；只检查是否存在相关调用',
    })).toBeNull();
    expect(projectContractViolation(contract, {
      instruction: '不要阻止执行 git push origin main',
    })).toContain('禁止动作');
    expect(projectContractViolation(contract, {
      instruction: '先确认未授权风险，再执行 git push origin main',
    })).toContain('禁止动作');
  });
});
