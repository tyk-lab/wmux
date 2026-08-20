import { describe, expect, it } from 'vitest';
import {
  CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
  DEFAULT_PROJECT_EXECUTION_BUDGET,
  type ProjectManagerSession,
  type ProjectWorkItem,
} from '../../src/shared/project-manager';
import {
  PROJECT_MANAGER_PROTOCOL_REVISION,
  projectManagerEventEnvelope,
  projectManagerRoleAnchor,
  projectManagerStartupInput,
  withProjectManagerEventEnvelope,
} from '../../src/shared/project-manager-terminal';
import {
  PROJECT_TASK_ROLE_ANCHOR,
  buildProjectTaskEventEnvelope,
  buildProjectTaskExecutionEnvelope,
  prepareProjectTaskDelivery,
} from '../../src/renderer/project-manager/engine';
import {
  ORDINARY_TASK_ROLE_ANCHOR,
  authorizeManagedRoleV2,
  buildOrdinaryTaskEventEnvelope,
  buildProjectAiRuntimeContext,
  buildTaskAiRuntimeContext,
} from '../../src/renderer/role-context';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';

function workItem(partial: Partial<ProjectWorkItem> = {}): ProjectWorkItem {
  return {
    id: 'work-a',
    goalId: 'goal-a',
    subgoalId: 'stage-a',
    requirementsVersion: 2,
    authorizationVersion: 3,
    executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
    baseline: {
      status: 'approved',
      requirementsVersion: 2,
      workspaceVersion: 'head:abc',
      evidence: '已审核工作区',
    },
    title: '实现认证',
    status: 'planned',
    dependencies: [],
    supervisorLaneId: 'lane-a',
    workerSurfaceId: 'task-a',
    attempts: 1,
    decisionsUsed: 2,
    updatedAt: 1,
    executionHistory: [],
    contract: {
      objective: '完成认证实现',
      description: '',
      preconditions: ['测试环境已准备'],
      scope: {
        root: 'E:\\repo',
        allowPaths: ['src/auth'],
        denyPaths: ['src/payments'],
        forbiddenActions: ['不得发布生产环境'],
      },
      authority: {
        technicalChoices: true,
        lowRiskRetries: true,
        targetedTests: true,
        internalThreads: false,
        continuousExecution: true,
        permissionConfirm: true,
        allowedCommandPrefixes: ['npm test -- auth'],
      },
      stopWhen: ['认证测试通过'],
      validation: ['运行认证单元测试'],
      budget: { ...DEFAULT_PROJECT_EXECUTION_BUDGET, maxDecisions: 12, maxTaskRetries: 3 },
    },
    ...partial,
  };
}

function project(item = workItem()): ProjectManagerSession {
  return {
    id: 'project-a',
    projectDir: 'E:\\repo',
    projectName: '认证项目',
    projectScope: '认证模块',
    activeGoalId: 'goal-a',
    goals: [{
      id: 'goal-a', sequence: 1, statement: '完成认证', doneWhen: ['认证测试通过'],
      status: 'active', requirementsVersion: 2, createdAt: 1, activatedAt: 1,
    }],
    subgoals: [{
      id: 'stage-a', goalId: 'goal-a', title: '完成认证实现', outcome: '认证可用',
      acceptance: ['认证测试通过'], dependencies: [], status: 'active', order: 1,
      createdAt: 1, updatedAt: 1,
    }],
    goal: '完成认证',
    preconditions: ['测试环境已准备'],
    planFiles: [],
    doneWhen: ['认证测试通过'],
    requirementsVersion: 2,
    authorizationVersion: 3,
    acceptedRequirementsVersion: 2,
    executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
    status: 'active',
    managerSurfaceId: 'manager-a',
    progressSnapshot: {
      version: 1, capturedAt: 1, mode: 'git', fingerprint: 'snapshot-a', entries: [], truncated: false,
    },
    progressSync: {
      status: 'ready', checkedAt: 1, snapshotFingerprint: 'snapshot-a', summary: '已同步', changeCount: 0,
    },
    orientation: {
      status: 'ready', requirementsVersion: 2, authorizationVersion: 3,
      snapshotFingerprint: 'snapshot-a', reason: '已建立认知', requestedAt: 1,
      summary: '已知当前项目', knownFacts: ['认证待实现'], unknowns: [],
      workItems: [{ workItemId: item.id, disposition: 'continue', basis: '当前任务', nextAction: '继续' }],
      acknowledgedAt: 1,
    },
    workItems: [item],
    events: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function lane(partial: Partial<SupervisorLane> = {}): SupervisorLane {
  return {
    id: 'lane-a',
    label: '认证任务',
    surfaceId: 'task-a' as any,
    supervisorSurfaceId: 'supervisor-a' as any,
    controlState: 'active',
    awaitingStopCheck: false,
    stopConfirmed: false,
    projectManagerProjectId: 'project-a',
    projectWorkItemId: 'work-a',
    ...partial,
  };
}

describe('unified managed AI role context', () => {
  it('reports project AI identity, gates, pending work, and currently usable commands', () => {
    const context = buildProjectAiRuntimeContext(project(), {
      pendingSupervisorApprovals: 1,
      runtime: { agent: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
    });

    expect(context.role).toBe('project-ai');
    expect(context.identity).toMatchObject({
      managerSurfaceId: 'manager-a', projectId: 'project-a', goalId: 'goal-a',
      requirementsVersion: 2, authorizationVersion: 3,
      agent: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high',
    });
    expect(context.state).toEqual({
      project: 'active', requirementsAlignment: 'accepted', orientation: 'ready', progressSync: 'ready',
      executionProtocol: 'current',
    });
    expect(context.commands.available).toContain('wmux context');
    expect(context.commands.conditional.find((item) => item.command.includes('project supervise')))
      .toMatchObject({ available: true });
    expect(context.commands.conditional.find((item) => item.command.includes('project decide')))
      .toMatchObject({ available: true });
  });

  it('requires old restored work to be re-contracted before advertising supervise', () => {
    const context = buildProjectAiRuntimeContext(project(workItem({ executionProtocolVersion: 1 })));

    expect(context.state.executionProtocol).toBe('migration-required');
    expect(context.pending.readyWorkItems).toBe(0);
    expect(context.commands.conditional.find((item) => item.command.includes('project supervise')))
      .toMatchObject({ available: false });
    expect(context.commands.conditional.find((item) => item.command.includes('task-update'))?.condition)
      .toContain('完整 contract');
  });

  it('distinguishes a recorded alignment decision from execution-version acceptance', () => {
    const pending = project();
    pending.status = 'waiting';
    pending.acceptedRequirementsVersion = 1;
    pending.events = [
      { id: 'required', sessionId: pending.id, ts: 1, kind: 'requirements-alignment-required', summary: '检查' },
      { id: 'confirmed', sessionId: pending.id, ts: 2, kind: 'requirements-alignment-confirmed', summary: '充分' },
    ];

    const context = buildProjectAiRuntimeContext(pending);
    expect(context.state.requirementsAlignment).toBe('confirmed-awaiting-plan-or-resume');
    expect(context.commands.conditional.find((item) => item.command.includes('alignment-confirm'))?.available)
      .toBe(false);
    expect(context.commands.conditional.find((item) => item.command.includes('goal-plan'))?.available)
      .toBe(true);
    expect(context.commands.conditional.find((item) => item.command.includes('project resume'))?.available)
      .toBe(true);
    expect(context.commands.conditional.find((item) => item.command.includes('task-create'))?.available)
      .toBe(false);
  });

  it('reports project task identity, contract bounds, native-tool distinction, and budget', () => {
    const item = workItem();
    const context = buildTaskAiRuntimeContext({
      callerSurfaceId: 'task-a',
      taskState: 'idle',
      lane: lane(),
      project: project(item),
      workItem: item,
    });

    expect(context.role).toBe('project-task');
    expect(context.identity).toMatchObject({
      taskSurfaceId: 'task-a', supervisorSurfaceId: 'supervisor-a',
      projectId: 'project-a', goalId: 'goal-a', workItemId: 'work-a',
      requirementsVersion: 2, authorizationVersion: 3,
    });
    expect(context.contract).toMatchObject({
      projectRoot: 'E:\\repo', allowPaths: ['src/auth'], denyPaths: ['src/payments'],
      supervisorConfirmableCommandPrefixes: ['npm test -- auth'],
    });
    expect(context.actions.available).toContain('运行合同要求的最小相关测试');
    expect(context.actions.nativeToolNotice).toContain('Agent 原生工具');
    expect(context.budget).toEqual({
      decisionsUsed: 2, decisionsRemaining: 10, attempts: 1, retriesRemaining: 2,
    });
  });

  it('limits an unapproved project task to the baseline investigation', () => {
    const item = workItem({ baseline: { status: 'required', requirementsVersion: 2 } });
    const context = buildTaskAiRuntimeContext({
      callerSurfaceId: 'task-a', lane: lane(), project: project(item), workItem: item,
    });

    expect(context.actions.available).toEqual([
      '仅执行监督 AI 下达的有界只读项目基线调查，并提交基线报告后停止',
    ]);
  });

  it('stops advertising execution when the task contract is stale', () => {
    const item = workItem({ requirementsVersion: 1 });
    const context = buildTaskAiRuntimeContext({
      callerSurfaceId: 'task-a', lane: lane(), project: project(item), workItem: item,
    });

    expect(context.state.contract).toBe('stale');
    expect(context.actions.available).toEqual([
      '当前项目状态或任务合同版本已经失效；停止执行并等待监督 AI/项目 AI 重新绑定合同',
    ]);
  });

  it('treats an old execution protocol as a stale task contract', () => {
    const item = workItem({ executionProtocolVersion: 1 });
    const context = buildTaskAiRuntimeContext({
      callerSurfaceId: 'task-a', lane: lane(), project: project(item), workItem: item,
    });

    expect(context.state.contract).toBe('stale');
    expect(context.actions.available).toEqual([
      '当前项目状态或任务合同版本已经失效；停止执行并等待监督 AI/项目 AI 重新绑定合同',
    ]);
  });

  it('stops advertising execution while the project task lane is paused or waiting', () => {
    const item = workItem();
    const paused = buildTaskAiRuntimeContext({
      callerSurfaceId: 'task-a', lane: lane({ controlState: 'paused' }),
      project: project(item), workItem: item,
    });
    const waiting = buildTaskAiRuntimeContext({
      callerSurfaceId: 'task-a', lane: lane({ controlState: 'waiting' }),
      project: project(item), workItem: item,
    });

    expect(paused.actions.available).toEqual([
      '当前监督通道未处于活动状态；停止执行并等待控制层恢复监督',
    ]);
    expect(paused.actions.conditional).toEqual([]);
    expect(waiting.actions.available).toEqual([
      '当前阶段已经进入待续；不得自行开始下一阶段，等待监督 AI/项目 AI 明确续接',
    ]);
    expect(waiting.actions.conditional).toEqual([]);
  });

  it('marks ended and dependency-blocked work item contracts inactive', () => {
    const completed = workItem({ status: 'completed' });
    const completedContext = buildTaskAiRuntimeContext({
      callerSurfaceId: 'task-a', lane: lane(), project: project(completed), workItem: completed,
    });
    expect(completedContext.state.contract).toBe('inactive');
    expect(completedContext.actions.available[0]).toContain('completed');

    const blocked = workItem({ dependencies: ['missing'] });
    const blockedContext = buildTaskAiRuntimeContext({
      callerSurfaceId: 'task-a', lane: lane(), project: project(blocked), workItem: blocked,
    });
    expect(blockedContext.state.contract).toBe('inactive');
    expect(blockedContext.actions.available[0]).toContain('依赖');
  });

  it('enforces the managed-role V2 method and target matrix', () => {
    const supervisor = {
      role: 'project-supervisor' as const,
      callerSurfaceId: 'supervisor-a',
      targetSurfaceId: 'task-a',
      projectId: 'project-a',
      workItemId: 'work-a',
    };
    expect(authorizeManagedRoleV2(supervisor, 'surface.read_text', { surfaceId: 'task-a' }).allowed)
      .toBe(true);
    expect(authorizeManagedRoleV2(supervisor, 'surface.close', { surfaceId: 'task-a' }).allowed)
      .toBe(false);
    expect(authorizeManagedRoleV2(supervisor, 'surface.read_text', { surfaceId: 'task-b' }).allowed)
      .toBe(false);
    expect(authorizeManagedRoleV2(supervisor, 'project.task-terminal.control', {
      projectId: 'project-a', task: 'work-a',
    }).allowed).toBe(true);
    expect(authorizeManagedRoleV2(supervisor, 'project.task-terminal.control', {
      projectId: 'project-b', task: 'work-a',
    }).allowed).toBe(false);

    const manager = { role: 'project-ai' as const, callerSurfaceId: 'manager-a', projectId: 'project-a' };
    expect(authorizeManagedRoleV2(manager, 'project.status', { projectId: 'project-a' }).allowed)
      .toBe(true);
    expect(authorizeManagedRoleV2(manager, 'project.status', { projectId: 'project-b' }).allowed)
      .toBe(false);
    expect(authorizeManagedRoleV2(manager, 'project.task-terminal.control', { projectId: 'project-a' }).allowed)
      .toBe(false);
  });

  it('keeps ordinary supervised tasks explicit about wmux versus native Agent authority', () => {
    const context = buildTaskAiRuntimeContext({
      callerSurfaceId: 'task-a',
      lane: lane({ projectManagerProjectId: undefined, projectWorkItemId: undefined }),
    });

    expect(context.role).toBe('task');
    expect(context.state.supervision).toBe('active');
    expect(context.commands.available).toContain('wmux context');
    expect(context.actions.nativeToolNotice).toContain('沙箱配置决定');
  });

  it('loads the full project role once and keeps routine events compact', () => {
    const startup = projectManagerStartupInput('codex', '', 'project-a');
    expect(projectManagerRoleAnchor('project-a')).toContain('wmux context');
    expect(startup).toContain('$manage-project');
    expect(startup).toContain(`项目管理协议版本：${PROJECT_MANAGER_PROTOCOL_REVISION}`);

    const event = withProjectManagerEventEnvelope('进度通知', 'project-a');
    expect(event).toContain(projectManagerEventEnvelope('project-a'));
    expect(event).toContain('无需重读技能或重新确认角色');
    expect(event).not.toContain('[项目 AI 角色锚点｜控制层]');
    expect(withProjectManagerEventEnvelope(event, 'project-a')).toBe(event);

    const legacyDelivery = [
      '[项目 AI 角色锚点｜控制层]',
      '你是项目 project-a 的专属项目 AI，只能管理这一个项目。',
      '先运行 wmux context 获取实时身份、状态、权限和命令；该结果由当前终端 capability 绑定，不接受手工指定项目身份。',
      '不得直接修改项目交付文件、执行实现/测试，或使用通用 send/send-key 控制监督 AI 与任务 AI。',
      '',
      '旧队列事件',
    ].join('\n');
    const hydrated = withProjectManagerEventEnvelope(legacyDelivery, 'project-a');
    expect(hydrated).toContain('旧队列事件');
    expect(hydrated).not.toContain('[项目 AI 角色锚点｜控制层]');
    expect(PROJECT_TASK_ROLE_ANCHOR).toContain('wmux context');
    expect(ORDINARY_TASK_ROLE_ANCHOR).toContain('wmux context');
    expect(PROJECT_TASK_ROLE_ANCHOR).toContain('[本轮结果]');
    expect(ORDINARY_TASK_ROLE_ANCHOR).toContain('[本轮结果]');
    expect(buildProjectTaskExecutionEnvelope(workItem().contract)).toContain(PROJECT_TASK_ROLE_ANCHOR);
    expect(buildProjectTaskExecutionEnvelope(workItem().contract)).toContain('长命令输出');
    const followUp = prepareProjectTaskDelivery(workItem().contract, '继续实现', false, {
      projectId: 'project-a', goalId: 'goal-a', workItemId: 'task-a',
      requirementsVersion: 2, authorizationVersion: 1,
    }).delivery;
    expect(followUp).toContain(buildProjectTaskEventEnvelope({
      projectId: 'project-a', goalId: 'goal-a', workItemId: 'task-a',
      requirementsVersion: 2, authorizationVersion: 1,
    }));
    expect(followUp).toContain('[本轮执行指令]\n继续实现');
    expect(followUp).not.toContain(PROJECT_TASK_ROLE_ANCHOR);
    expect(buildOrdinaryTaskEventEnvelope('worker-a')).toContain('无需重新运行 wmux context');
  });
});
