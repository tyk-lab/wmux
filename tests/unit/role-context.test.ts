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
  projectManagerStartupInput,
  withProjectManagerEventEnvelope,
} from '../../src/shared/project-manager-terminal';
import {
  projectTaskInstructionDisclosureError,
  renderProjectTaskBatch,
} from '../../src/renderer/project-manager/engine';
import {
  authorizeManagedRoleV2,
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
    title: '实现认证',
    status: 'planned',
    dependencies: [],
    supervisorLaneId: 'lane-a',
    workerSurfaceId: 'task-a',
    attempts: 1,
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
      budget: { ...DEFAULT_PROJECT_EXECUTION_BUDGET, maxTaskRetries: 3 },
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
    expect(context.commands.conditional.find((item) => item.command.includes('project dispatch')))
      .toMatchObject({ available: true });
    expect(context.commands.conditional.find((item) => item.command.includes('project decide')))
      .toBeUndefined();
  });

  it('advertises dispatch when a current work item is waiting for project-level recovery', () => {
    const context = buildProjectAiRuntimeContext(project(workItem({ status: 'waiting-decision' })));

    expect(context.pending.readyWorkItems).toBe(1);
    expect(context.commands.conditional.find((item) => item.command.includes('project dispatch')))
      .toMatchObject({ available: true });
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

  it('keeps project orchestration identity and state invisible to the task AI', () => {
    const item = workItem({ requirementsVersion: 1, status: 'paused' });
    const context = buildTaskAiRuntimeContext({
      callerSurfaceId: 'task-a',
      lane: lane({
        controlState: 'paused',
        projectTaskBatch: {
          kind: 'task', coverage: 'bounded-batch', outcome: '形成认证接口行为',
          completionDefinition: ['成果形成并完成验证'],
          evidenceExpectations: ['接口结果可复核'], unmetCompletionItems: [],
          knownFacts: ['测试环境可用'],
          constraints: ['遵循项目规范'], nonGoals: ['不处理支付模块'],
        },
      }),
      project: project(item),
      workItem: item,
    });

    expect(context.role).toBe('task');
    expect(context.identity).toEqual({ taskSurfaceId: 'task-a' });
    expect(context.state).toEqual({ task: 'unknown' });
    expect(context.contract.objective).toBe('形成认证接口行为');
    expect(context.contract.validation).toEqual(['接口结果可复核']);
    expect(context.contract.stopWhen).toEqual(['成果形成并完成验证']);
    expect(context.actions.available).toContain('读取并遵循当前目录适用的 AGENTS、技能和项目规范');
    expect(context.actions.nativeToolNotice).not.toMatch(/项目 AI|监督 AI|内部编排|项目 ID|工作项 ID|lane/iu);
    expect(context.commands.forbidden.join('\n')).not.toMatch(/project|supervisor|项目 AI|监督 AI/iu);
    expect(JSON.stringify(context)).not.toMatch(/project-ai|supervisor|项目 AI|监督 AI|内部编排|控制层|laneId/iu);
    expect(context.identity).not.toHaveProperty('projectId');
    expect(context.identity).not.toHaveProperty('workItemId');
    expect(context.identity).not.toHaveProperty('laneId');
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
    }).allowed).toBe(false);
    expect(authorizeManagedRoleV2(supervisor, 'project.worker.resource.reconcile', {
      projectId: 'project-a', workItemId: 'work-a', workerId: 'worker-a',
    }).allowed).toBe(false);
    expect(authorizeManagedRoleV2(supervisor, 'project.worker.merge.reject', {
      projectId: 'project-a', workItemId: 'work-a', workerId: 'worker-a',
    }).allowed).toBe(false);
    expect(authorizeManagedRoleV2(supervisor, 'project.task-terminal.control', {
      projectId: 'project-b', task: 'work-a',
    }).allowed).toBe(false);
    expect(authorizeManagedRoleV2(supervisor, 'supervisor.evidence', {
      reviewId: 'review-current',
    }).allowed).toBe(true);
    expect(authorizeManagedRoleV2(supervisor, 'supervisor.completion.verify', {
      surfaceId: 'task-a', supervisorSurfaceId: 'supervisor-a', refs: ['evidence/result.json'],
    }).allowed).toBe(true);
    expect(authorizeManagedRoleV2(supervisor, 'supervisor.goal.draft', { surfaceId: 'task-a' }).allowed)
      .toBe(false);
    expect(authorizeManagedRoleV2(supervisor, 'role.ready').allowed).toBe(true);

    const ordinarySupervisor = {
      role: 'supervisor' as const,
      callerSurfaceId: 'ordinary-supervisor',
      targetSurfaceId: 'ordinary-task',
    };
    expect(authorizeManagedRoleV2(ordinarySupervisor, 'supervisor.goal.draft', { surfaceId: 'ordinary-task' }).allowed)
      .toBe(false);
    expect(authorizeManagedRoleV2(ordinarySupervisor, 'supervisor.reply', { surfaceId: 'ordinary-task' }).allowed)
      .toBe(false);
    expect(authorizeManagedRoleV2(ordinarySupervisor, 'supervisor.evidence', {
      reviewId: 'review-current',
    }).allowed).toBe(true);
    expect(authorizeManagedRoleV2(ordinarySupervisor, 'supervisor.completion.verify', {
      surfaceId: 'ordinary-task', supervisorSurfaceId: 'ordinary-supervisor', refs: ['result.json'],
    }).allowed).toBe(true);
    expect(authorizeManagedRoleV2(ordinarySupervisor, 'role.ready').allowed).toBe(true);

    const manager = { role: 'project-ai' as const, callerSurfaceId: 'manager-a', projectId: 'project-a' };
    expect(authorizeManagedRoleV2(manager, 'project.status', { projectId: 'project-a' }).allowed)
      .toBe(true);
    expect(authorizeManagedRoleV2(manager, 'project.directive.resolve', { projectId: 'project-a' }).allowed)
      .toBe(false);
    expect(authorizeManagedRoleV2(manager, 'project.execution.replan', { projectId: 'project-a' }).allowed)
      .toBe(false);
    expect(authorizeManagedRoleV2(manager, 'project.status', { projectId: 'project-b' }).allowed)
      .toBe(false);
    expect(authorizeManagedRoleV2(manager, 'project.supervisor.assign', {
      projectId: 'project-a', workItemId: 'work-a',
    }).allowed).toBe(true);
    expect(authorizeManagedRoleV2(manager, 'project.task.dispatch', {
      projectId: 'project-a', workItemId: 'work-a',
    }).allowed).toBe(false);
    expect(authorizeManagedRoleV2(supervisor, 'project.supervisor.assign', {
      projectId: 'project-a', workItemId: 'work-a',
    }).allowed).toBe(false);
    expect(authorizeManagedRoleV2(manager, 'project.task-terminal.control', { projectId: 'project-a' }).allowed)
      .toBe(false);
    expect(authorizeManagedRoleV2(manager, 'supervisor.evidence', { reviewId: 'review-current' }).allowed)
      .toBe(false);
    expect(authorizeManagedRoleV2(manager, 'supervisor.completion.verify', {
      surfaceId: 'task-a', refs: ['evidence/result.json'],
    }).allowed).toBe(false);
    expect(authorizeManagedRoleV2(manager, 'role.ready').allowed).toBe(true);

    const task = {
      role: 'project-task' as const,
      callerSurfaceId: 'task-a',
      projectId: 'project-a',
      workItemId: 'work-a',
    };
    expect(authorizeManagedRoleV2(task, 'supervisor.evidence', { reviewId: 'review-current' }).allowed)
      .toBe(false);
    expect(authorizeManagedRoleV2(task, 'supervisor.completion.verify', {
      surfaceId: 'task-a', refs: ['evidence/result.json'],
    }).allowed).toBe(false);
    expect(authorizeManagedRoleV2(task, 'role.ready').allowed).toBe(false);
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
    const startup = projectManagerStartupInput('project-a');
    expect(startup).toContain('当前隔离目录 AGENTS.md');
    expect(startup).toContain(`protocol=${PROJECT_MANAGER_PROTOCOL_REVISION}`);
    expect(startup).toContain('wmux role-ready');
    expect(startup).not.toContain('$manage-project');

    const event = withProjectManagerEventEnvelope('进度通知', 'project-a');
    expect(event).toContain(projectManagerEventEnvelope('project-a'));
    expect(event).toContain('无需重读 AGENTS.md 或重新确认角色');
    expect(event).toContain('普通任务检查点由监督 AI 原地接受或返工');
    expect(event).not.toContain('[项目 AI 角色锚点｜控制层]');
    expect(withProjectManagerEventEnvelope(event, 'project-a')).toBe(event);

    const taskDelivery = renderProjectTaskBatch(workItem().contract, {
      kind: 'task', coverage: 'bounded-batch', outcome: '继续形成认证成果',
      completionDefinition: ['认证行为形成'], evidenceExpectations: ['认证行为可复核'],
      unmetCompletionItems: [], knownFacts: [], constraints: [], nonGoals: [],
    });
    expect(taskDelivery).toContain('[成果任务]');
    expect(taskDelivery).toContain('读取并严格遵循当前目录层级适用的 AGENTS');
    expect(taskDelivery).not.toMatch(/项目 ID|工作项 ID|监督 AI|lane/iu);
    expect(taskDelivery).not.toMatch(/项目 AI|辅助任务 AI|内部规划|控制层/iu);
    expect(projectTaskInstructionDisclosureError('继续完成当前成果并返回验证证据')).toBeNull();
    expect(projectTaskInstructionDisclosureError('根据项目 AI 和监督 AI 的安排继续')).toContain('不能暴露');
    expect(projectTaskInstructionDisclosureError('专属监督要求继续当前工作项')).toContain('不能暴露');
  });
});
