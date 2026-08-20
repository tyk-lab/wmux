import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import {
  createProjectManagerSlice,
  type ProjectManagerSlice,
} from '../../src/renderer/store/project-manager-slice';
import {
  DEFAULT_PROJECT_EXECUTION_BUDGET,
  type ProjectWorkItem,
} from '../../src/shared/project-manager';

function store() {
  return create<ProjectManagerSlice>()(createProjectManagerSlice);
}

function item(id: string, dependencies: string[] = []): ProjectWorkItem {
  return {
    id,
    title: id,
    status: 'planned',
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
      authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false },
      stopWhen: ['完成'],
      validation: ['检查结果'],
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
    },
  };
}

describe('project-manager slice', () => {
  it('keeps multiple projects independently selectable and mutates only the targeted project', () => {
    const useStore = store();
    const first = useStore.getState().startProjectManager({ projectDir: 'E:\\repo-a', goal: '项目 A', doneWhen: ['A 完成'] });
    const second = useStore.getState().startProjectManager({ projectDir: 'E:\\repo-b', goal: '项目 B', doneWhen: ['B 完成'] });

    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('task') }, first.id);
    expect(useStore.getState().projectManagers).toHaveLength(2);
    expect(useStore.getState().projectManagers.find((session) => session.id === first.id)?.workItems).toHaveLength(1);
    expect(useStore.getState().projectManagers.find((session) => session.id === second.id)?.workItems).toHaveLength(0);

    useStore.getState().selectProjectManager(first.id);
    expect(useStore.getState().projectManager?.projectDir).toBe('E:\\repo-a');
  });

  it('keeps user questions and manager replies in each project conversation', () => {
    const useStore = store();
    const first = useStore.getState().startProjectManager({ projectDir: 'E:\\repo-a', goal: '项目 A', doneWhen: ['A 完成'] });
    const second = useStore.getState().startProjectManager({ projectDir: 'E:\\repo-b', goal: '项目 B', doneWhen: ['B 完成'] });

    useStore.getState().appendProjectManagerEvent({
      kind: 'user-message', correlationId: 'message-a', summary: '询问项目 A',
    }, first.id);
    useStore.getState().applyProjectManagerAction({
      type: 'reply', correlationId: 'message-a', message: '回复项目 A',
    }, first.id);

    expect(useStore.getState().projectManagers.find((project) => project.id === first.id)?.events.map((event) => event.kind))
      .toEqual(['user-message', 'manager-reply']);
    expect(useStore.getState().projectManagers.find((project) => project.id === second.id)?.events).toEqual([]);
  });

  it('removes the selected project and selects the next remaining project', () => {
    const useStore = store();
    const first = useStore.getState().startProjectManager({ projectDir: 'E:\\repo-a', goal: '项目 A', doneWhen: ['A 完成'] });
    const second = useStore.getState().startProjectManager({ projectDir: 'E:\\repo-b', goal: '项目 B', doneWhen: ['B 完成'] });

    useStore.getState().removeProjectManager(second.id);
    expect(useStore.getState().projectManagers.map((project) => project.id)).toEqual([first.id]);
    expect(useStore.getState().projectManager?.id).toBe(first.id);
    expect(useStore.getState().selectedProjectManagerId).toBe(first.id);

    useStore.getState().removeProjectManager(first.id);
    expect(useStore.getState().projectManagers).toEqual([]);
    expect(useStore.getState().projectManager).toBeNull();
    expect(useStore.getState().selectedProjectManagerId).toBeNull();
  });

  it('records project actions in a bounded session timeline', () => {
    const useStore = store();
    useStore.getState().startProjectManager({ projectDir: 'E:\\repo', goal: '完成项目', doneWhen: ['验收通过'] });
    const result = useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('auth') });
    expect(result.ok).toBe(true);
    expect(useStore.getState().projectManager?.workItems).toHaveLength(1);
    expect(useStore.getState().projectManager?.events[0]).toMatchObject({ kind: 'work-item-created', workItemId: 'auth' });
  });

  it('requires a project orientation at creation and invalidates it when prerequisites change', () => {
    const useStore = store();
    const project = useStore.getState().startProjectManager({
      projectDir: 'E:\\repo', goal: '完成项目', preconditions: ['测试环境可用'], doneWhen: ['验收通过'],
    });
    expect(project.orientation).toMatchObject({
      status: 'required', requirementsVersion: 1, authorizationVersion: 1,
      snapshotFingerprint: 'capture-pending',
    });
    useStore.getState().restoreProjectManager({
      ...project,
      progressSnapshot: {
        version: 1, capturedAt: 1, mode: 'git', fingerprint: 'snapshot-1', entries: [], truncated: false,
      },
      orientation: {
        status: 'ready', requirementsVersion: 1, authorizationVersion: 1,
        snapshotFingerprint: 'snapshot-1', reason: '已复核', requestedAt: 1,
        summary: '项目状态已知', knownFacts: ['环境可用'], unknowns: [], workItems: [], acknowledgedAt: 2,
      },
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'update-project-preconditions', preconditions: ['设备已上电且允许测试'], reason: '用户更新条件',
    })).toMatchObject({ ok: true });
    expect(useStore.getState().projectManager?.orientation).toMatchObject({
      status: 'required', requirementsVersion: 2, authorizationVersion: 2,
      snapshotFingerprint: 'snapshot-1',
    });
  });

  it('keeps project baseline approval under control-plane ownership and resets it on contract changes', () => {
    const useStore = store();
    useStore.getState().startProjectManager({ projectDir: 'E:\\repo', goal: '完成项目', doneWhen: ['验收通过'] });
    const forged = {
      ...item('baseline-task'),
      baseline: {
        status: 'approved' as const,
        requirementsVersion: 1,
        workspaceVersion: 'forged',
        evidence: 'forged',
        approvedAt: 1,
      },
    };
    expect(useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: forged })).toMatchObject({ ok: true });
    expect(useStore.getState().projectManager?.workItems[0].baseline).toEqual({
      status: 'required', requirementsVersion: 1,
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'approve-work-item-baseline', workItemId: 'baseline-task',
      workspaceVersion: 'head:a', evidence: '已审核',
    })).toMatchObject({ ok: false, error: expect.stringContaining('不能预先批准') });

    expect(useStore.getState().applyProjectManagerAction({
      type: 'start-work-item-baseline', workItemId: 'baseline-task',
    })).toMatchObject({ ok: true, event: { kind: 'work-item-baseline-started' } });
    expect(useStore.getState().projectManager?.workItems[0].baseline).toMatchObject({
      status: 'investigating', investigationRounds: 1,
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'start-work-item-baseline', workItemId: 'baseline-task',
    })).toMatchObject({ ok: true, event: { kind: 'work-item-baseline-started' } });
    expect(useStore.getState().projectManager?.workItems[0].baseline).toMatchObject({
      status: 'investigating', investigationRounds: 2,
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'start-work-item-baseline', workItemId: 'baseline-task',
    })).toMatchObject({ ok: false, error: expect.stringContaining('不能继续重复调查') });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'approve-work-item-baseline', workItemId: 'baseline-task',
      workspaceVersion: 'head:a,status:clean', evidence: '已审核入口、工作树与测试约定',
    })).toMatchObject({ ok: true, event: { kind: 'work-item-baseline-approved' } });
    expect(useStore.getState().projectManager?.workItems[0].baseline?.status).toBe('approved');

    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'baseline-task',
      patch: {
        baseline: forged.baseline,
        contract: {
          ...forged.contract,
          description: '合同边界发生变化',
        },
      },
    });
    expect(useStore.getState().projectManager?.workItems[0].baseline).toEqual({
      status: 'required', requirementsVersion: 1,
    });
  });

  it('records a user work-item intervention and prevents AI from reviving the stopped item', () => {
    const useStore = store();
    useStore.getState().startProjectManager({ projectDir: 'E:\\repo', goal: '完成项目', doneWhen: ['验收通过'] });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('first') });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('middle') });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('last') });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: 'middle',
      patch: { status: 'running', supervisorLaneId: 'lane-middle', workerSurfaceId: 'worker-middle' },
    });

    expect(useStore.getState().applyProjectManagerAction({
      type: 'intervene-work-item',
      workItemId: 'middle',
      intervention: 'skip',
      reason: '已有等效证据，不再重复执行',
    })).toMatchObject({
      ok: true,
      event: {
        kind: 'user-work-item-intervention',
        workItemId: 'middle',
        payload: {
          intervention: 'skip',
          reason: '已有等效证据，不再重复执行',
          previousStatus: 'running',
        },
      },
    });
    expect(useStore.getState().projectManager?.workItems).toEqual([
      expect.objectContaining({ id: 'first', status: 'planned' }),
      expect.objectContaining({
        id: 'middle', status: 'stopped', supervisorLaneId: undefined, workerSurfaceId: undefined,
      }),
      expect.objectContaining({ id: 'last', status: 'planned' }),
    ]);
    expect(useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'middle', patch: { status: 'planned' },
    })).toMatchObject({ ok: false, error: expect.stringContaining('不能由 AI 恢复') });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'intervene-work-item', workItemId: 'last', intervention: 'close',
    })).toMatchObject({
      ok: true,
      event: { kind: 'user-work-item-intervention', payload: { intervention: 'close' } },
    });
  });

  it('updates user-owned project prerequisites during an active project', () => {
    const useStore = store();
    useStore.getState().startProjectManager({
      projectDir: 'E:\\repo', goal: '控制设备', preconditions: ['设备已断电'], doneWhen: ['验收通过'],
    });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('hardware-check') });

    expect(useStore.getState().applyProjectManagerAction({
      type: 'update-project-preconditions',
      preconditions: ['设备已接入受控电源', '安全限值已经人工确认'],
    })).toMatchObject({ ok: true, event: { kind: 'project-preconditions-updated' } });
    expect(useStore.getState().projectManager?.preconditions).toEqual([
      '设备已接入受控电源', '安全限值已经人工确认',
    ]);
    expect(useStore.getState().projectManager).toMatchObject({
      status: 'waiting',
      requirementsVersion: 2,
      acceptedRequirementsVersion: 0,
      workItems: [{
        id: 'hardware-check',
        status: 'waiting-decision',
        latestBlocker: expect.stringContaining('前置条件'),
      }],
    });
    useStore.getState().applyProjectManagerAction({
      type: 'resume-project', reason: '已按新条件重新规划', acceptRequirementsVersion: true,
    });
    expect(useStore.getState().projectManager).toMatchObject({
      status: 'active', requirementsVersion: 2, acceptedRequirementsVersion: 2,
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'update-project-preconditions', preconditions: [],
    })).toMatchObject({ ok: false, error: expect.stringContaining('不能为空') });
  });

  it('refines the active main goal and pauses current-goal work for explicit rebinding', () => {
    const useStore = store();
    useStore.getState().startProjectManager({
      projectDir: 'E:\\repo', goal: '旧目标', preconditions: ['旧前置条件'],
      supervisorNotes: ['旧阶段提醒'], doneWhen: ['旧验收'],
    });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('active-task') });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'active-task', patch: { status: 'running' },
    });

    const result = useStore.getState().applyProjectManagerAction({
      type: 'update-project-definition',
      goal: '调整后的目标',
      preconditions: ['新前置条件'],
      supervisorNotes: ['阶段完成后同步文档', '形成成果后创建本地提交'],
      planFiles: [{ path: 'E:\\repo\\PLAN.md', name: 'PLAN.md', content: '# 新计划' }],
      doneWhen: ['新验收'],
      source: 'user',
      mode: 'refine',
    });

    expect(result).toMatchObject({
      ok: true,
      event: {
        kind: 'project-definition-updated',
        payload: {
          mode: 'refine',
          previous: { goal: '旧目标', supervisorNotes: ['旧阶段提醒'] },
          next: {
            goal: '调整后的目标',
            supervisorNotes: ['阶段完成后同步文档', '形成成果后创建本地提交'],
          },
        },
      },
    });
    expect(useStore.getState().projectManager).toMatchObject({
      goal: '调整后的目标',
      preconditions: ['新前置条件'],
      supervisorNotes: ['阶段完成后同步文档', '形成成果后创建本地提交'],
      doneWhen: ['新验收'],
      status: 'waiting',
      workItems: [{ id: 'active-task', status: 'waiting-decision', latestBlocker: expect.stringContaining('重新绑定') }],
    });
  });

  it('creates a new main-goal record and stops unfinished old-goal work on pivot', () => {
    const useStore = store();
    useStore.getState().startProjectManager({
      projectDir: 'E:\\repo', goal: '开发旧产品', preconditions: ['旧设备可用'], doneWhen: ['旧产品验收'],
    });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('finished') });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'finished', patch: { status: 'completed', latestEvidence: '旧任务已验收' },
    });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('unfinished') });

    const result = useStore.getState().applyProjectManagerAction({
      type: 'update-project-definition',
      goal: '开发全新产品',
      preconditions: ['新设备可用'],
      planFiles: [],
      doneWhen: ['新产品验收'],
      reason: '用户明确清除旧目标',
      source: 'user',
      mode: 'pivot',
    });

    expect(result).toMatchObject({
      ok: true,
      event: {
        kind: 'project-definition-updated',
        summary: '用户明确清除旧目标',
        payload: { mode: 'pivot', previous: { goal: '开发旧产品' }, next: { goal: '开发全新产品' } },
      },
    });
    expect(useStore.getState().projectManager?.workItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'finished', status: 'completed' }),
      expect.objectContaining({ id: 'unfinished', status: 'stopped' }),
    ]));
    expect(useStore.getState().projectManager).toMatchObject({
      goal: '开发全新产品', preconditions: ['新设备可用'], doneWhen: ['新产品验收'], status: 'waiting',
    });
    expect(useStore.getState().projectManager?.goals).toEqual([
      expect.objectContaining({ statement: '开发旧产品', status: 'superseded' }),
      expect.objectContaining({ statement: '开发全新产品', status: 'transitioning' }),
    ]);
    expect(useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'unfinished', patch: { status: 'running' },
    })).toMatchObject({ ok: false, error: expect.stringContaining('旧主目标') });
  });

  it('stores a coarse subgoal plan under the active main goal', () => {
    const useStore = store();
    const project = useStore.getState().startProjectManager({
      projectDir: 'E:\\repo', projectName: '认证项目', projectScope: '只处理认证模块',
      goal: '交付可验收认证能力', doneWhen: ['认证验收通过'],
    });
    const goalId = project.activeGoalId || '';
    expect(useStore.getState().applyProjectManagerAction({
      type: 'set-project-subgoals',
      source: 'manager',
      reason: '建立首轮阶段计划',
      subgoals: [{
        id: 'auth_backend_ready', goalId, title: '认证后端可验收',
        outcome: '接口、约束和错误行为稳定', acceptance: ['认证定向测试通过'],
        dependencies: [], status: 'planned', order: 1, createdAt: 1, updatedAt: 1,
      }],
    })).toMatchObject({ ok: true, event: { kind: 'project-subgoals-updated' } });
    expect(useStore.getState().projectManager?.subgoals).toEqual([
      expect.objectContaining({ id: 'auth_backend_ready', goalId, status: 'planned' }),
    ]);
    useStore.getState().applyProjectManagerAction({
      type: 'create-work-item',
      workItem: { ...item('auth-api'), goalId, subgoalId: 'auth_backend_ready' },
    });
    expect(useStore.getState().projectManager?.workItems[0]).toMatchObject({
      goalId, subgoalId: 'auth_backend_ready', requirementsVersion: 1, authorizationVersion: 1,
    });
  });

  it('preserves repeated stage ids across main-goal history and protects live task ownership', () => {
    const useStore = store();
    const project = useStore.getState().startProjectManager({
      projectDir: 'E:\\repo', goal: '完成第一目标', preconditions: ['环境可用'], doneWhen: ['第一目标验收'],
    });
    const firstGoalId = project.activeGoalId || '';
    useStore.getState().applyProjectManagerAction({
      type: 'set-project-subgoals', source: 'manager', subgoals: [{
        id: 'implementation', goalId: firstGoalId, title: '实现阶段', outcome: '第一目标形成实现',
        acceptance: ['实现可验证'], dependencies: [], status: 'active', order: 1, createdAt: 1, updatedAt: 1,
      }],
    });
    useStore.getState().applyProjectManagerAction({
      type: 'create-work-item', workItem: { ...item('first-task'), goalId: firstGoalId, subgoalId: 'implementation' },
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'set-project-subgoals', source: 'manager', subgoals: [{
        id: 'replacement', goalId: firstGoalId, title: '替代阶段', outcome: '替代原阶段',
        acceptance: ['替代结果可验证'], dependencies: [], status: 'planned', order: 1, createdAt: 2, updatedAt: 2,
      }],
    })).toMatchObject({ ok: false, error: expect.stringContaining('first-task') });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'first-task', patch: { goalId: 'another-goal' },
    })).toMatchObject({ ok: false, error: expect.stringContaining('归属不可变') });
    useStore.getState().applyProjectManagerAction({
      type: 'update-project-definition', goal: '完成第二目标', preconditions: ['环境可用'], planFiles: [],
      doneWhen: ['第二目标验收'], source: 'user', mode: 'pivot',
    });
    const secondGoalId = useStore.getState().projectManager?.activeGoalId || '';
    expect(useStore.getState().applyProjectManagerAction({
      type: 'set-project-subgoals', source: 'manager', subgoals: [{
        id: 'implementation', goalId: secondGoalId, title: '实现阶段', outcome: '第二目标形成实现',
        acceptance: ['实现可验证'], dependencies: [], status: 'planned', order: 1, createdAt: 3, updatedAt: 3,
      }],
    })).toMatchObject({ ok: true });
    expect(useStore.getState().projectManager?.subgoals.filter((subgoal) => subgoal.id === 'implementation'))
      .toEqual([
        expect.objectContaining({ goalId: firstGoalId }),
        expect.objectContaining({ goalId: secondGoalId }),
      ]);
    expect(useStore.getState().applyProjectManagerAction({
      type: 'create-work-item',
      workItem: { ...item('second-task'), goalId: secondGoalId, subgoalId: 'implementation' },
    })).toMatchObject({ ok: true });
  });

  it('requires coarse stages to be accepted before completing the current main goal', () => {
    const useStore = store();
    const project = useStore.getState().startProjectManager({
      projectDir: 'E:\\repo', goal: '完成目标', preconditions: ['环境可用'], doneWhen: ['目标验收'],
    });
    const goalId = project.activeGoalId || '';
    const stage = {
      id: 'validation', goalId, title: '验收阶段', outcome: '目标得到验收', acceptance: ['证据完整'],
      dependencies: [], status: 'active' as const, order: 1, createdAt: 1, updatedAt: 1,
    };
    useStore.getState().applyProjectManagerAction({ type: 'set-project-subgoals', source: 'manager', subgoals: [stage] });
    useStore.getState().applyProjectManagerAction({
      type: 'create-work-item', workItem: { ...item('validate'), goalId, subgoalId: stage.id },
    });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'validate', patch: { status: 'completed', latestEvidence: '证据完整' },
    });
    useStore.getState().applyProjectManagerAction({
      type: 'resume-project', reason: '目标级复核', acceptRequirementsVersion: true,
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'complete-current-goal', evidence: '目标验收通过',
    })).toMatchObject({ ok: false, error: expect.stringContaining('阶段目标尚未验收') });
    useStore.getState().applyProjectManagerAction({
      type: 'set-project-subgoals', source: 'manager', subgoals: [{ ...stage, status: 'achieved' }],
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'set-project-subgoals', source: 'manager', subgoals: [{
        ...stage,
        outcome: '改写已经验收的历史结果',
        status: 'planned',
      }],
    })).toMatchObject({ ok: false, error: expect.stringContaining('不能撤销或改写') });
    expect(useStore.getState().projectManager?.subgoals?.[0]).toMatchObject({
      outcome: stage.outcome,
      status: 'achieved',
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'complete-current-goal', evidence: '目标验收通过',
    })).toMatchObject({ ok: true });
  });

  it('rejects a task update that introduces a dependency cycle', () => {
    const useStore = store();
    useStore.getState().startProjectManager({ projectDir: 'E:\\repo', goal: '完成项目', doneWhen: ['验收通过'] });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('a') });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('b', ['a']) });
    const result = useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'a', patch: { dependencies: ['b'] },
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('循环') });
  });

  it('soft pause and resume preserve work items', () => {
    const useStore = store();
    useStore.getState().startProjectManager({ projectDir: 'E:\\repo', goal: '完成项目', doneWhen: ['验收通过'] });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('auth') });
    const paused = useStore.getState().applyProjectManagerAction({
      type: 'pause-project', reason: '运行链无进展', source: 'manager', attentionRequired: true,
    });
    expect(paused).toMatchObject({
      ok: true,
      event: {
        kind: 'project-paused',
        payload: { source: 'manager', attentionRequired: true },
      },
    });
    expect(useStore.getState().projectManager?.status).toBe('paused');
    useStore.getState().applyProjectManagerAction({ type: 'resume-project', reason: '继续' });
    expect(useStore.getState().projectManager?.status).toBe('active');
    expect(useStore.getState().projectManager?.workItems[0].id).toBe('auth');
  });

  it('pauses one project without changing another and tracks portfolio pauses separately', () => {
    const useStore = store();
    const first = useStore.getState().startProjectManager({ projectDir: 'E:\\repo-a', goal: '项目 A', doneWhen: ['A 完成'] });
    const second = useStore.getState().startProjectManager({ projectDir: 'E:\\repo-b', goal: '项目 B', doneWhen: ['B 完成'] });

    useStore.getState().applyProjectManagerAction({ type: 'pause-project', reason: '只暂停 A' }, first.id);
    expect(useStore.getState().projectManagers.find((project) => project.id === first.id)).toMatchObject({
      status: 'paused', pausedByPortfolio: false,
    });
    expect(useStore.getState().projectManagers.find((project) => project.id === second.id)?.status).toBe('active');

    useStore.getState().applyProjectManagerAction({
      type: 'pause-project', reason: '全局暂停', source: 'portfolio',
    }, second.id);
    expect(useStore.getState().projectManagers.find((project) => project.id === second.id)).toMatchObject({
      status: 'paused', pausedByPortfolio: true,
    });
    useStore.getState().applyProjectManagerAction({
      type: 'resume-project', reason: '全局恢复', source: 'portfolio',
    }, second.id);
    expect(useStore.getState().projectManagers.find((project) => project.id === second.id)).toMatchObject({
      status: 'active', pausedByPortfolio: false,
    });
    expect(useStore.getState().projectManagers.find((project) => project.id === first.id)).toMatchObject({
      status: 'paused', pausedByPortfolio: false,
    });
  });

  it('pauses only the affected project for user clarification and accepts only the first answer', () => {
    const useStore = store();
    const first = useStore.getState().startProjectManager({ projectDir: 'E:\\repo-a', goal: '项目 A', doneWhen: ['A 完成'] });
    const second = useStore.getState().startProjectManager({ projectDir: 'E:\\repo-b', goal: '项目 B', doneWhen: ['B 完成'] });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('manual-check') }, first.id);
    const question = {
      id: 'question-1',
      category: 'manual-intervention' as const,
      workItemId: 'manual-check',
      blocker: '需要用户进入 BIOS 开启唤醒',
      question: '是否允许覆盖现有配置？',
      context: '现有配置与完成条件冲突。',
      options: [{ id: 'keep', label: '保留' }, { id: 'replace', label: '覆盖' }],
      recommendedOptionId: 'keep',
      previousStatus: 'active' as const,
      createdAt: Date.now(),
    };

    expect(useStore.getState().applyProjectManagerAction({
      type: 'request-user-clarification', question,
    }, first.id)).toMatchObject({ ok: true, event: { kind: 'user-clarification-requested' } });
    expect(useStore.getState().projectManagers.find((project) => project.id === first.id)).toMatchObject({
      status: 'waiting', pendingUserQuestion: { id: 'question-1', category: 'manual-intervention' },
      workItems: [{ id: 'manual-check', status: 'waiting-decision', latestBlocker: expect.stringContaining('BIOS') }],
    });
    expect(useStore.getState().projectManagers.find((project) => project.id === second.id)?.status).toBe('active');
    expect(useStore.getState().applyProjectManagerAction({
      type: 'request-user-clarification', question: { ...question, id: 'question-2' },
    }, first.id)).toMatchObject({ ok: false, error: expect.stringContaining('已有') });

    expect(useStore.getState().applyProjectManagerAction({
      type: 'answer-user-clarification', questionId: 'question-1', answer: '保留现有配置', optionId: 'keep', answeredBy: 'desktop',
    }, first.id)).toMatchObject({ ok: true, event: { kind: 'user-clarification-answered' } });
    expect(useStore.getState().projectManagers.find((project) => project.id === first.id)).toMatchObject({ status: 'waiting' });
    expect(useStore.getState().projectManagers.find((project) => project.id === first.id)?.pendingUserQuestion).toBeUndefined();
    useStore.getState().applyProjectManagerAction({ type: 'resume-project', reason: '项目管理 AI 核对答复后决定继续' }, first.id);
    expect(useStore.getState().projectManagers.find((project) => project.id === first.id)?.status).toBe('active');
    expect(useStore.getState().applyProjectManagerAction({
      type: 'answer-user-clarification', questionId: 'question-1', answer: '改为覆盖', optionId: 'replace', answeredBy: 'feishu',
    }, first.id)).toMatchObject({ ok: false, error: expect.stringContaining('已经处理') });
  });

  it('rejects execution records from a superseded main goal', () => {
    const useStore = store();
    const session = useStore.getState().startProjectManager({ projectDir: 'E:\\repo', goal: '旧目标', doneWhen: ['旧目标完成'] });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('old-task') }, session.id);
    useStore.getState().applyProjectManagerAction({
      type: 'update-project-definition', mode: 'pivot', source: 'user', reason: '切换新目标',
      goal: '新目标', preconditions: ['环境可用'], planFiles: [], doneWhen: ['新目标完成'],
    }, session.id);

    expect(useStore.getState().applyProjectManagerAction({
      type: 'record-execution', workItemId: 'old-task',
      record: { ts: Date.now(), action: '继续旧任务', decision: 'allow' },
    }, session.id)).toMatchObject({ ok: false, error: expect.stringContaining('旧主目标') });
  });

  it('keeps rejected execution attempts without consuming the decision budget', () => {
    const useStore = store();
    const session = useStore.getState().startProjectManager({ projectDir: 'E:\\repo', goal: '认证', doneWhen: ['通过'] });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('auth') }, session.id);
    const record = {
      ts: Date.now(), actionSignature: 'action', commandSignature: 'command', errorSignature: 'error',
      progressSignature: 'progress', workspaceVersion: 'head:test',
    };

    expect(useStore.getState().applyProjectManagerAction({
      type: 'record-execution', workItemId: 'auth', record, consumeDecision: false,
    }, session.id)).toMatchObject({ ok: true });
    expect(useStore.getState().projectManagers[0].workItems[0]).toMatchObject({
      decisionsUsed: 0,
      executionHistory: [record],
    });
  });

  it('requires completed work and project-level evidence before completion', () => {
    const useStore = store();
    useStore.getState().startProjectManager({ projectDir: 'E:\\repo', goal: '完成项目', doneWhen: ['验收通过'] });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('auth') });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'complete-current-goal', evidence: '单元测试通过',
    })).toMatchObject({ ok: false });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'auth',
      patch: { status: 'completed', latestEvidence: '认证测试通过', latestBlocker: '等待用户现场验收' },
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'complete-current-goal', evidence: '单元测试通过',
    })).toMatchObject({ ok: false, error: expect.stringContaining('未解决阻塞') });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'auth', patch: { latestBlocker: undefined },
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'complete-current-goal', evidence: '',
    })).toMatchObject({ ok: false, error: expect.stringContaining('证据') });
    useStore.getState().applyProjectManagerAction({
      type: 'resume-project', reason: '项目 AI 已完成目标级复核', acceptRequirementsVersion: true,
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'complete-current-goal', evidence: '目标级验收全部通过',
    })).toMatchObject({ ok: true });
    expect(useStore.getState().projectManager).toMatchObject({
      status: 'waiting', goals: [expect.objectContaining({ status: 'achieved' })],
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'update-project-definition',
      goal: '推进同一项目的下一主目标', preconditions: ['无额外物理前置条件'],
      planFiles: [], doneWhen: ['下一目标验收通过'], source: 'user', mode: 'pivot',
    })).toMatchObject({ ok: true });
    expect(useStore.getState().projectManager?.goals).toEqual([
      expect.objectContaining({ status: 'achieved' }),
      expect.objectContaining({ statement: '推进同一项目的下一主目标', status: 'transitioning' }),
    ]);
  });
});
