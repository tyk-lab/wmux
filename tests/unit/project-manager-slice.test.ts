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

  it('updates user-owned project prerequisites during an active project', () => {
    const useStore = store();
    useStore.getState().startProjectManager({
      projectDir: 'E:\\repo', goal: '控制设备', preconditions: ['设备已断电'], doneWhen: ['验收通过'],
    });

    expect(useStore.getState().applyProjectManagerAction({
      type: 'update-project-preconditions',
      preconditions: ['设备已接入受控电源', '安全限值已经人工确认'],
    })).toMatchObject({ ok: true, event: { kind: 'project-preconditions-updated' } });
    expect(useStore.getState().projectManager?.preconditions).toEqual([
      '设备已接入受控电源', '安全限值已经人工确认',
    ]);
    expect(useStore.getState().applyProjectManagerAction({
      type: 'update-project-preconditions', preconditions: [],
    })).toMatchObject({ ok: false, error: expect.stringContaining('不能为空') });
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
    useStore.getState().applyProjectManagerAction({ type: 'pause-project', reason: '讨论方案' });
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
    const question = {
      id: 'question-1',
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
      status: 'waiting', pendingUserQuestion: { id: 'question-1' },
    });
    expect(useStore.getState().projectManagers.find((project) => project.id === second.id)?.status).toBe('active');
    expect(useStore.getState().applyProjectManagerAction({
      type: 'request-user-clarification', question: { ...question, id: 'question-2' },
    }, first.id)).toMatchObject({ ok: false, error: expect.stringContaining('已有') });

    expect(useStore.getState().applyProjectManagerAction({
      type: 'answer-user-clarification', questionId: 'question-1', answer: '保留现有配置', optionId: 'keep', answeredBy: 'desktop',
    }, first.id)).toMatchObject({ ok: true, event: { kind: 'user-clarification-answered' } });
    expect(useStore.getState().projectManagers.find((project) => project.id === first.id)).toMatchObject({ status: 'active' });
    expect(useStore.getState().projectManagers.find((project) => project.id === first.id)?.pendingUserQuestion).toBeUndefined();
    expect(useStore.getState().applyProjectManagerAction({
      type: 'answer-user-clarification', questionId: 'question-1', answer: '改为覆盖', optionId: 'replace', answeredBy: 'feishu',
    }, first.id)).toMatchObject({ ok: false, error: expect.stringContaining('已经处理') });
  });

  it('requires completed work and project-level evidence before completion', () => {
    const useStore = store();
    useStore.getState().startProjectManager({ projectDir: 'E:\\repo', goal: '完成项目', doneWhen: ['验收通过'] });
    useStore.getState().applyProjectManagerAction({ type: 'create-work-item', workItem: item('auth') });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'complete-project', evidence: '单元测试通过',
    })).toMatchObject({ ok: false });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'auth', patch: { status: 'completed', latestEvidence: '认证测试通过' },
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'complete-project', evidence: '',
    })).toMatchObject({ ok: false, error: expect.stringContaining('证据') });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'complete-project', evidence: '项目级验收全部通过',
    })).toMatchObject({ ok: true });
    expect(useStore.getState().projectManager?.status).toBe('completed');
  });
});
