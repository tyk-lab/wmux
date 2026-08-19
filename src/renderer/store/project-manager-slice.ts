import type { StateCreator } from 'zustand';
import { v4 as uuid } from 'uuid';
import {
  activeProjectGoal,
  normalizeProjectManagerSession,
  projectAcceptedRequirementsVersion,
  projectAuthorizationVersion,
  projectRequirementsVersion,
  requiredProjectTaskBaseline,
  type ProjectManagerAction,
  type ProjectManagerEvent,
  type ProjectManagerSession,
  type ProjectSubgoal,
  type ProjectWorkItem,
} from '../../shared/project-manager';
import { projectDependencyError } from '../project-manager/engine';

const MAX_PROJECT_EVENTS = 500;
const MAX_EXECUTION_HISTORY = 100;

export interface ProjectManagerMutationResult {
  ok: boolean;
  error?: string;
  event?: ProjectManagerEvent;
}

export interface ProjectManagerSlice {
  projectManager: ProjectManagerSession | null;
  projectManagers: ProjectManagerSession[];
  selectedProjectManagerId: string | null;
  projectManagerDialogOpen: boolean;
  openProjectManagerDialog: () => void;
  closeProjectManagerDialog: () => void;
  startProjectManager: (options: {
    projectDir: string;
    projectName?: string;
    projectScope?: string;
    goal: string;
    preconditions?: string[];
    planFiles?: ProjectManagerSession['planFiles'];
    doneWhen: string[];
    managerSurfaceId?: string;
    feishuChatId?: string;
  }) => ProjectManagerSession;
  restoreProjectManager: (session: ProjectManagerSession | null) => void;
  restoreProjectManagers: (sessions: ProjectManagerSession[], selectedId?: string) => void;
  selectProjectManager: (sessionId: string) => void;
  removeProjectManager: (sessionId: string) => void;
  applyProjectManagerAction: (action: ProjectManagerAction, sessionId?: string) => ProjectManagerMutationResult;
  appendProjectManagerEvent: (
    event: Omit<ProjectManagerEvent, 'id' | 'sessionId' | 'ts'> & { ts?: number },
    sessionId?: string,
  ) => ProjectManagerEvent | null;
}

function upsertProjectManagerSession(
  sessions: readonly ProjectManagerSession[],
  session: ProjectManagerSession,
): ProjectManagerSession[] {
  const index = sessions.findIndex((candidate) => candidate.id === session.id);
  if (index < 0) return [...sessions, session];
  return sessions.map((candidate) => candidate.id === session.id ? session : candidate);
}

function makeEvent(
  session: ProjectManagerSession,
  event: Omit<ProjectManagerEvent, 'id' | 'sessionId' | 'ts'> & { ts?: number },
): ProjectManagerEvent {
  return {
    ...event,
    id: `pm-event-${uuid()}`,
    sessionId: session.id,
    ts: event.ts ?? Date.now(),
  };
}

function withEvent(session: ProjectManagerSession, event: ProjectManagerEvent): ProjectManagerSession {
  return {
    ...session,
    updatedAt: event.ts,
    events: [...session.events, event].slice(-MAX_PROJECT_EVENTS),
  };
}

function updateWorkItem(
  session: ProjectManagerSession,
  workItemId: string,
  update: (item: ProjectWorkItem) => ProjectWorkItem,
): ProjectManagerSession | null {
  if (!session.workItems.some((item) => item.id === workItemId)) return null;
  return {
    ...session,
    workItems: session.workItems.map((item) => item.id === workItemId ? update(item) : item),
  };
}

function projectSubgoalDependencyError(subgoals: readonly ProjectSubgoal[]): string | null {
  const byId = new Map(subgoals.map((subgoal) => [subgoal.id, subgoal]));
  if (byId.size !== subgoals.length) return '阶段目标 ID 不能重复';
  for (const subgoal of subgoals) {
    const missing = subgoal.dependencies.find((dependency) => !byId.has(dependency));
    if (missing) return `阶段目标 ${subgoal.id} 依赖不存在的阶段目标 ${missing}`;
    if (subgoal.dependencies.includes(subgoal.id)) return `阶段目标 ${subgoal.id} 不能依赖自身`;
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if (byId.get(id)?.dependencies.some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return subgoals.some((subgoal) => visit(subgoal.id)) ? '阶段目标依赖不能形成循环' : null;
}

export const createProjectManagerSlice: StateCreator<ProjectManagerSlice> = (set, get) => ({
  projectManager: null,
  projectManagers: [],
  selectedProjectManagerId: null,
  projectManagerDialogOpen: false,
  openProjectManagerDialog() {
    set({ projectManagerDialogOpen: true });
  },
  closeProjectManagerDialog() {
    set({ projectManagerDialogOpen: false });
  },
  startProjectManager(options) {
    const now = Date.now();
    const id = `pm-${uuid()}`;
    const goalId = `${id}-goal-1`;
    const session: ProjectManagerSession = {
      id,
      projectDir: options.projectDir,
      projectName: options.projectName?.trim(),
      projectScope: options.projectScope?.trim(),
      activeGoalId: goalId,
      goals: [{
        id: goalId,
        sequence: 1,
        statement: options.goal,
        doneWhen: options.doneWhen,
        status: 'transitioning',
        requirementsVersion: 1,
        createdAt: now,
      }],
      subgoals: [],
      goal: options.goal,
      preconditions: options.preconditions || [],
      planFiles: options.planFiles || [],
      doneWhen: options.doneWhen,
      requirementsVersion: 1,
      authorizationVersion: 1,
      acceptedRequirementsVersion: 0,
      status: 'active',
      recoveryState: 'ready',
      managerSurfaceId: options.managerSurfaceId,
      feishuChatId: options.feishuChatId,
      workItems: [],
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    const normalized = normalizeProjectManagerSession(session);
    set((state) => ({
      projectManager: normalized,
      projectManagers: upsertProjectManagerSession(state.projectManagers, normalized),
      selectedProjectManagerId: normalized.id,
    }));
    return normalized;
  },
  restoreProjectManager(session) {
    if (!session) {
      set({ projectManager: null, projectManagers: [], selectedProjectManagerId: null });
      return;
    }
    const normalized = normalizeProjectManagerSession(session);
    set((state) => ({
      projectManager: normalized,
      projectManagers: upsertProjectManagerSession(state.projectManagers, normalized),
      selectedProjectManagerId: normalized.id,
    }));
  },
  restoreProjectManagers(sessions, selectedId) {
    const normalized = sessions.map(normalizeProjectManagerSession);
    const selected = normalized.find((session) => session.id === selectedId) || normalized[0] || null;
    set({
      projectManager: selected,
      projectManagers: normalized,
      selectedProjectManagerId: selected?.id || null,
    });
  },
  selectProjectManager(sessionId) {
    const selected = get().projectManagers.find((session) => session.id === sessionId);
    if (selected) set({ projectManager: selected, selectedProjectManagerId: selected.id });
  },
  removeProjectManager(sessionId) {
    set((state) => {
      const projectManagers = state.projectManagers.filter((session) => session.id !== sessionId);
      const selected = state.selectedProjectManagerId === sessionId
        ? projectManagers[0] || null
        : projectManagers.find((session) => session.id === state.selectedProjectManagerId)
          || projectManagers[0]
          || null;
      return {
        projectManagers,
        projectManager: selected,
        selectedProjectManagerId: selected?.id || null,
      };
    });
  },
  appendProjectManagerEvent(event, sessionId) {
    const state = get();
    const session = sessionId
      ? state.projectManagers.find((candidate) => candidate.id === sessionId) || null
      : state.projectManager;
    if (!session) return null;
    const created = makeEvent(session, event);
    const updated = withEvent(session, created);
    set((current) => ({
      projectManagers: upsertProjectManagerSession(current.projectManagers, updated),
      ...(current.projectManager?.id === updated.id ? { projectManager: updated } : {}),
    }));
    return created;
  },
  applyProjectManagerAction(action, sessionId) {
    const state = get();
    const rawSession = sessionId
      ? state.projectManagers.find((candidate) => candidate.id === sessionId) || null
      : state.projectManager;
    if (!rawSession) return { ok: false, error: '当前没有项目管理会话' };
    const session = normalizeProjectManagerSession(rawSession);
    const now = Date.now();
    let next = session;
    let eventInput: Omit<ProjectManagerEvent, 'id' | 'sessionId' | 'ts'>;

    if (action.type === 'require-requirements-alignment') {
      next = { ...session, status: 'waiting' };
      eventInput = {
        kind: 'requirements-alignment-required',
        summary: action.reason.trim() || '项目必须先完成需求充分性判定',
      };
    } else if (action.type === 'confirm-requirements-alignment') {
      const goalUnderstanding = action.goalUnderstanding.trim();
      const scopeSummary = action.scopeSummary.trim();
      const acceptanceSummary = action.acceptanceSummary.trim();
      const reason = action.reason.trim();
      if (!goalUnderstanding || !scopeSummary || !acceptanceSummary || !reason) {
        return { ok: false, error: '需求充分性确认必须包含目标理解、范围、验收标准和判定理由' };
      }
      next = { ...session, status: 'waiting' };
      eventInput = {
        kind: 'requirements-alignment-confirmed',
        summary: reason,
        payload: { goalUnderstanding, scopeSummary, acceptanceSummary },
      };
    } else if (action.type === 'update-project-definition') {
      const goal = action.goal.trim();
      const preconditions = action.preconditions.map((item) => item.trim()).filter(Boolean);
      const doneWhen = action.doneWhen.map((item) => item.trim()).filter(Boolean);
      if (!goal) return { ok: false, error: '项目目标不能为空' };
      if (preconditions.length === 0) {
        return { ok: false, error: '项目前置条件不能为空；没有额外条件时请明确填写“无额外物理前置条件”' };
      }
      if (doneWhen.length === 0) return { ok: false, error: '项目完成条件不能为空' };
      const previous = {
        goal: session.goal,
        goalId: session.activeGoalId,
        preconditions: session.preconditions,
        planFiles: session.planFiles.map((file) => ({ path: file.path, name: file.name })),
        doneWhen: session.doneWhen,
      };
      const activeGoal = activeProjectGoal(session);
      if (action.mode === 'refine' && ['achieved', 'superseded', 'abandoned'].includes(activeGoal.status)) {
        return { ok: false, error: '已结束的主目标不能继续调整，请切换新的主目标' };
      }
      const nextRequirementsVersion = projectRequirementsVersion(session) + 1;
      const authorizationChanged = JSON.stringify(preconditions) !== JSON.stringify(session.preconditions);
      const nextAuthorizationVersion = authorizationChanged
        ? projectAuthorizationVersion(session) + 1
        : projectAuthorizationVersion(session);
      const nextGoalId = action.mode === 'pivot'
        ? `${session.id}-goal-${Math.max(0, ...(session.goals || []).map((entry) => entry.sequence)) + 1}-${uuid()}`
        : activeGoal.id;
      const nextGoalSequence = action.mode === 'pivot'
        ? Math.max(0, ...(session.goals || []).map((entry) => entry.sequence)) + 1
        : activeGoal.sequence;
      const goals = action.mode === 'pivot'
        ? [
            ...(session.goals || []).map((entry) => entry.id === activeGoal.id ? {
              ...entry,
              status: entry.status === 'achieved' ? 'achieved' as const : 'superseded' as const,
              closedAt: entry.closedAt || now,
            } : entry),
            {
              id: nextGoalId,
              sequence: nextGoalSequence,
              statement: goal,
              doneWhen,
              status: 'transitioning' as const,
              requirementsVersion: nextRequirementsVersion,
              supersedesGoalId: activeGoal.id,
              changeReason: action.reason,
              createdAt: now,
            },
          ]
        : (session.goals || []).map((entry) => entry.id === activeGoal.id ? {
            ...entry,
            statement: goal,
            doneWhen,
            requirementsVersion: nextRequirementsVersion,
            changeReason: action.reason || entry.changeReason,
          } : entry);
      const workItems = session.workItems.map((item) => {
        if (item.goalId !== activeGoal.id || ['completed', 'stopped'].includes(item.status)) return item;
        if (action.mode === 'pivot') {
          return {
            ...item,
            status: 'stopped' as const,
            latestBlocker: undefined,
            updatedAt: now,
          };
        }
        return {
          ...item,
          status: 'waiting-decision' as const,
          baseline: requiredProjectTaskBaseline(item.requirementsVersion || projectRequirementsVersion(session)),
          latestBlocker: '当前主目标要求已调整，等待项目 AI 评估后显式重新绑定需求和授权版本',
          updatedAt: now,
        };
      });
      next = {
        ...session,
        activeGoalId: nextGoalId,
        goals,
        goal,
        preconditions,
        planFiles: action.planFiles,
        doneWhen,
        requirementsVersion: nextRequirementsVersion,
        authorizationVersion: nextAuthorizationVersion,
        workItems,
        status: 'waiting',
        pausedByPortfolio: false,
        pendingUserQuestion: undefined,
      };
      eventInput = {
        kind: 'project-definition-updated',
        summary: action.reason || `${action.source === 'user' ? '用户' : '项目 AI'}${action.mode === 'pivot' ? '切换新的主目标' : '调整当前主目标'}`,
        payload: {
          source: action.source,
          mode: action.mode,
          previousGoalId: activeGoal.id,
          activeGoalId: nextGoalId,
          requirementsVersion: nextRequirementsVersion,
          authorizationVersion: nextAuthorizationVersion,
          supersededQuestionId: session.pendingUserQuestion?.id,
          previous,
          next: {
            goal,
            goalId: nextGoalId,
            preconditions,
            planFiles: action.planFiles.map((file) => ({ path: file.path, name: file.name })),
            doneWhen,
          },
        },
      };
    } else if (action.type === 'set-project-subgoals') {
      const activeGoal = activeProjectGoal(session);
      if (['achieved', 'superseded', 'abandoned'].includes(activeGoal.status)) {
        return { ok: false, error: '当前主目标已经结束，不能再更新阶段目标' };
      }
      if (action.subgoals.length === 0 || action.subgoals.length > 20) {
        return { ok: false, error: '当前主目标必须包含 1-20 个阶段目标' };
      }
      if (action.subgoals.some((subgoal) => subgoal.goalId !== activeGoal.id)) {
        return { ok: false, error: '阶段目标只能归属于当前主目标' };
      }
      const dependencyError = projectSubgoalDependencyError(action.subgoals);
      if (dependencyError) return { ok: false, error: dependencyError };
      const existingCurrentSubgoals = new Map((session.subgoals || [])
        .filter((subgoal) => subgoal.goalId === activeGoal.id)
        .map((subgoal) => [subgoal.id, subgoal]));
      const changedAchievedSubgoal = action.subgoals.find((subgoal) => {
        const previous = existingCurrentSubgoals.get(subgoal.id);
        return previous?.status === 'achieved' && (
          subgoal.status !== 'achieved'
          || subgoal.title !== previous.title
          || subgoal.outcome !== previous.outcome
          || JSON.stringify(subgoal.acceptance) !== JSON.stringify(previous.acceptance)
          || JSON.stringify(subgoal.dependencies) !== JSON.stringify(previous.dependencies)
        );
      });
      if (changedAchievedSubgoal) {
        return {
          ok: false,
          error: `已验收阶段目标 ${changedAchievedSubgoal.id} 只能保留为历史，不能撤销或改写`,
        };
      }
      const incomingIds = new Set(action.subgoals.map((subgoal) => subgoal.id));
      const incomingById = new Map(action.subgoals.map((subgoal) => [subgoal.id, subgoal]));
      const invalidatedTask = session.workItems.find((item) => {
        if (item.goalId !== activeGoal.id || !item.subgoalId || ['completed', 'stopped'].includes(item.status)) return false;
        const nextSubgoal = incomingById.get(item.subgoalId);
        const previousSubgoal = existingCurrentSubgoals.get(item.subgoalId);
        return !nextSubgoal
          || ['achieved', 'obsolete'].includes(nextSubgoal.status)
          || (['running', 'validating'].includes(item.status)
            && JSON.stringify(nextSubgoal.dependencies) !== JSON.stringify(previousSubgoal?.dependencies || []));
      });
      if (invalidatedTask) {
        return {
          ok: false,
          error: `任务 ${invalidatedTask.id} 的运行阶段将被结束、移除或改变依赖；请先暂停/停止任务或保持当前阶段执行边界`,
        };
      }
      const retained = (session.subgoals || []).map((subgoal) => (
        subgoal.goalId === activeGoal.id && !incomingIds.has(subgoal.id) && subgoal.status !== 'achieved'
          ? { ...subgoal, status: 'obsolete' as const, updatedAt: now }
          : subgoal
      ));
      const subgoalKey = (subgoal: Pick<ProjectSubgoal, 'goalId' | 'id'>) => `${subgoal.goalId}\u0000${subgoal.id}`;
      const byId = new Map(retained.map((subgoal) => [subgoalKey(subgoal), subgoal]));
      for (const subgoal of action.subgoals) {
        const previous = existingCurrentSubgoals.get(subgoal.id);
        byId.set(subgoalKey(subgoal), previous?.status === 'achieved' ? previous : subgoal);
      }
      const validIds = new Set(action.subgoals.filter((subgoal) => subgoal.status !== 'obsolete').map((subgoal) => subgoal.id));
      const workItems = session.workItems.map((item) => (
        item.goalId === activeGoal.id
        && item.subgoalId
        && !validIds.has(item.subgoalId)
        && !['completed', 'stopped'].includes(item.status)
          ? {
              ...item,
              status: 'waiting-decision' as const,
              latestBlocker: '所属阶段目标已取消，等待项目 AI 重新规划或停止任务',
              updatedAt: now,
            }
          : item
      ));
      next = { ...session, subgoals: [...byId.values()], workItems };
      eventInput = {
        kind: 'project-subgoals-updated',
        summary: action.reason || `${action.source === 'user' ? '用户' : '项目 AI'}更新当前主目标的阶段计划`,
        payload: {
          goalId: activeGoal.id,
          subgoals: action.subgoals.map(({ id, title, outcome, status, order, dependencies }) => ({
            id, title, outcome, status, order, dependencies,
          })),
        },
      };
    } else if (action.type === 'update-project-preconditions') {
      const preconditions = action.preconditions.map((item) => item.trim()).filter(Boolean);
      if (preconditions.length === 0) {
        return { ok: false, error: '项目前置条件不能为空；没有额外条件时请明确填写“无额外物理前置条件”' };
      }
      const nextRequirementsVersion = projectRequirementsVersion(session) + 1;
      const nextAuthorizationVersion = projectAuthorizationVersion(session) + 1;
      const activeGoal = activeProjectGoal(session);
      const workItems = session.workItems.map((item) => (
        item.goalId !== activeGoal.id || ['completed', 'stopped'].includes(item.status)
          ? item
          : {
              ...item,
              status: 'waiting-decision' as const,
              baseline: requiredProjectTaskBaseline(item.requirementsVersion || projectRequirementsVersion(session)),
              latestBlocker: '项目前置条件已更新，等待项目管理 AI 按新条件重新核对任务安全性和可执行性',
              updatedAt: now,
            }
      ));
      next = {
        ...session,
        preconditions,
        requirementsVersion: nextRequirementsVersion,
        authorizationVersion: nextAuthorizationVersion,
        workItems,
        status: 'waiting',
        pausedByPortfolio: false,
        pendingUserQuestion: undefined,
      };
      eventInput = {
        kind: 'project-preconditions-updated',
        summary: action.reason || `更新项目前置条件：${preconditions.join('；')}`,
        payload: {
          preconditions,
          requirementsVersion: nextRequirementsVersion,
          authorizationVersion: nextAuthorizationVersion,
          supersededQuestionId: session.pendingUserQuestion?.id,
        },
      };
    } else if (action.type === 'request-user-clarification') {
      if (session.pendingUserQuestion) {
        return { ok: false, error: '该项目已有待用户确认的问题，不能重复提问' };
      }
      let workItems = session.workItems;
      if (action.question.workItemId) {
        const index = workItems.findIndex((item) => item.id === action.question.workItemId);
        if (index < 0) return { ok: false, error: `任务不存在：${action.question.workItemId}` };
        if (workItems[index].goalId !== activeProjectGoal(session).id) {
          return { ok: false, error: '旧主目标任务不能再触发新的用户确认' };
        }
        workItems = workItems.map((item, itemIndex) => itemIndex === index ? {
          ...item,
          status: 'waiting-decision',
          latestBlocker: action.question.blocker || action.question.context || action.question.question,
          updatedAt: now,
        } : item);
      }
      next = { ...session, workItems, status: 'waiting', pendingUserQuestion: action.question };
      eventInput = {
        kind: 'user-clarification-requested',
        summary: action.question.question,
        correlationId: action.question.id,
        payload: { question: action.question },
      };
    } else if (action.type === 'answer-user-clarification') {
      const pending = session.pendingUserQuestion;
      if (!pending || pending.id !== action.questionId) {
        return { ok: false, error: '该用户确认问题不存在或已经处理' };
      }
      const answer = action.answer.trim();
      if (!answer) return { ok: false, error: '用户答复不能为空' };
      // Keep the project waiting after a user answer. The answer belongs to the
      // project manager, which must explicitly choose resume/replan/stop before
      // any supervisor or task terminal is allowed to continue.
      next = { ...session, status: 'waiting', pendingUserQuestion: undefined };
      eventInput = {
        kind: 'user-clarification-answered',
        summary: `用户答复：${answer}`,
        correlationId: pending.id,
        payload: {
          questionId: pending.id,
          question: pending.question,
          answer,
          optionId: action.optionId,
          answeredBy: action.answeredBy,
        },
      };
    } else if (action.type === 'create-work-item') {
      if (session.workItems.some((item) => item.id === action.workItem.id)) {
        return { ok: false, error: `任务 ID 已存在：${action.workItem.id}` };
      }
      const activeGoal = activeProjectGoal(session);
      const workItem = {
        ...action.workItem,
        goalId: action.workItem.goalId || activeGoal.id,
        requirementsVersion: action.workItem.requirementsVersion || projectRequirementsVersion(session),
        authorizationVersion: action.workItem.authorizationVersion || projectAuthorizationVersion(session),
        baseline: requiredProjectTaskBaseline(
          action.workItem.requirementsVersion || projectRequirementsVersion(session),
        ),
      };
      if (workItem.goalId !== activeGoal.id) return { ok: false, error: '只能为当前主目标创建任务' };
      if (workItem.subgoalId) {
        const subgoal = (session.subgoals || []).find((candidate) => (
          candidate.goalId === activeGoal.id && candidate.id === workItem.subgoalId
        ));
        if (!subgoal || ['achieved', 'obsolete'].includes(subgoal.status)) {
          return { ok: false, error: `阶段目标不存在、已结束或不属于当前主目标：${workItem.subgoalId}` };
        }
      }
      const workItems = [...session.workItems, workItem];
      const dependencyError = projectDependencyError(workItems);
      if (dependencyError) return { ok: false, error: dependencyError };
      next = { ...session, workItems };
      eventInput = { kind: 'work-item-created', workItemId: workItem.id, summary: `创建任务：${workItem.title}` };
    } else if (action.type === 'update-work-item') {
      const existing = session.workItems.find((item) => item.id === action.workItemId);
      if (existing?.goalId && existing.goalId !== activeProjectGoal(session).id) {
        return { ok: false, error: '旧主目标任务已经失效，不能修改当前目标状态' };
      }
      if (!existing) return { ok: false, error: `任务不存在：${action.workItemId}` };
      const userIntervention = [...session.events].reverse().find((event) => (
        event.kind === 'user-work-item-intervention' && event.workItemId === existing.id
      ));
      if (
        existing.status === 'stopped'
        && userIntervention
        && action.patch.status !== undefined
        && action.patch.status !== 'stopped'
      ) {
        return { ok: false, error: '该工作项已被用户跳过或关闭，不能由 AI 恢复；如需继续请按用户最新决定创建新的工作项' };
      }
      if (action.patch.goalId !== undefined && action.patch.goalId !== existing.goalId) {
        return { ok: false, error: '任务的主目标归属不可变；切换主目标后必须创建新任务' };
      }
      if (action.patch.requirementsVersion !== undefined
        && action.patch.requirementsVersion !== existing.requirementsVersion
        && action.patch.requirementsVersion !== projectRequirementsVersion(session)) {
        return { ok: false, error: '任务只能保留原需求版本或显式重绑当前需求版本' };
      }
      if (action.patch.authorizationVersion !== undefined
        && action.patch.authorizationVersion !== existing.authorizationVersion
        && action.patch.authorizationVersion !== projectAuthorizationVersion(session)) {
        return { ok: false, error: '任务只能保留原授权版本或显式重绑当前授权版本' };
      }
      if (action.patch.subgoalId !== undefined && action.patch.subgoalId !== existing.subgoalId) {
        if (['running', 'validating'].includes(existing.status)) {
          return { ok: false, error: '运行中的任务不能直接更换阶段归属；请先暂停或停止对应执行链' };
        }
        const targetSubgoal = (session.subgoals || []).find((subgoal) => (
          subgoal.goalId === activeProjectGoal(session).id
          && subgoal.id === action.patch.subgoalId
          && !['achieved', 'obsolete'].includes(subgoal.status)
        ));
        if (!targetSubgoal) return { ok: false, error: '任务只能重分配到当前主目标下的有效阶段' };
      }
      const { baseline: _untrustedBaseline, ...safePatch } = action.patch;
      const updated = updateWorkItem(session, action.workItemId, (item) => {
        const nextRequirementsVersion = safePatch.requirementsVersion || item.requirementsVersion
          || projectRequirementsVersion(session);
        const resetBaseline = nextRequirementsVersion !== item.requirementsVersion
          || (safePatch.contract !== undefined
            && JSON.stringify(safePatch.contract) !== JSON.stringify(item.contract))
          || (safePatch.subgoalId !== undefined && safePatch.subgoalId !== item.subgoalId);
        return {
          ...item,
          ...safePatch,
          id: item.id,
          goalId: item.goalId,
          baseline: resetBaseline
            ? requiredProjectTaskBaseline(nextRequirementsVersion)
            : item.baseline || requiredProjectTaskBaseline(nextRequirementsVersion),
          updatedAt: now,
        };
      });
      if (!updated) return { ok: false, error: `任务不存在：${action.workItemId}` };
      const dependencyError = projectDependencyError(updated.workItems);
      if (dependencyError) return { ok: false, error: dependencyError };
      next = updated;
      eventInput = { kind: 'work-item-updated', workItemId: action.workItemId, summary: `更新任务：${action.workItemId}` };
    } else if (action.type === 'reset-work-item-baseline') {
      const existing = session.workItems.find((item) => item.id === action.workItemId);
      if (!existing) return { ok: false, error: `任务不存在：${action.workItemId}` };
      if (['completed', 'stopped'].includes(existing.status)) {
        return { ok: false, error: '已经结束的任务不能重置项目基线' };
      }
      const reason = action.reason.trim().slice(0, 1200);
      if (!reason) return { ok: false, error: '重置项目基线必须说明原因' };
      const updated = updateWorkItem(session, action.workItemId, (item) => ({
        ...item,
        baseline: requiredProjectTaskBaseline(
          item.requirementsVersion || projectRequirementsVersion(session),
        ),
        updatedAt: now,
      }));
      if (!updated) return { ok: false, error: `任务不存在：${action.workItemId}` };
      next = updated;
      eventInput = {
        kind: 'work-item-updated',
        workItemId: action.workItemId,
        summary: `重置任务工作区基线：${action.workItemId}；${reason}`,
        payload: { baselineReset: true, reason },
      };
    } else if (action.type === 'start-work-item-baseline') {
      const existing = session.workItems.find((item) => item.id === action.workItemId);
      if (!existing) return { ok: false, error: `任务不存在：${action.workItemId}` };
      if (['completed', 'stopped'].includes(existing.status)) {
        return { ok: false, error: '已经结束的任务不能再发起项目基线调查' };
      }
      if (existing.requirementsVersion !== projectRequirementsVersion(session)) {
        return { ok: false, error: '任务尚未绑定当前需求版本，不能发起项目基线调查' };
      }
      const previousInvestigationRounds = existing.baseline?.status === 'investigating'
        ? Math.max(1, Math.trunc(existing.baseline.investigationRounds || 1))
        : 0;
      if (previousInvestigationRounds >= 2) {
        return { ok: false, error: '项目基线已经完成初次调查和一次定向补查；必须基于现有报告批准、暂缓或上报明确阻塞，不能继续重复调查' };
      }
      const updated = updateWorkItem(session, action.workItemId, (item) => ({
        ...item,
        baseline: {
          status: 'investigating',
          requirementsVersion: item.requirementsVersion || projectRequirementsVersion(session),
          requestedAt: now,
          investigationRounds: previousInvestigationRounds + 1,
        },
        updatedAt: now,
      }));
      if (!updated) return { ok: false, error: `任务不存在：${action.workItemId}` };
      next = updated;
      eventInput = {
        kind: 'work-item-baseline-started',
        workItemId: action.workItemId,
        summary: `监督 AI 已发起只读项目基线调查：${action.workItemId}`,
      };
    } else if (action.type === 'approve-work-item-baseline') {
      const evidence = action.evidence.trim().slice(0, 12000);
      const workspaceVersion = action.workspaceVersion.trim().slice(0, 2000);
      if (!evidence || !workspaceVersion) {
        return { ok: false, error: '批准项目基线必须提供工作区版本和审核证据' };
      }
      const existing = session.workItems.find((item) => item.id === action.workItemId);
      if (!existing) return { ok: false, error: `任务不存在：${action.workItemId}` };
      if (['completed', 'stopped'].includes(existing.status)) {
        return { ok: false, error: '已经结束的任务不能再批准项目基线' };
      }
      if (existing.requirementsVersion !== projectRequirementsVersion(session)) {
        return { ok: false, error: '任务尚未绑定当前需求版本，不能批准项目基线' };
      }
      if (existing.baseline?.status !== 'investigating') {
        return { ok: false, error: '项目基线尚未完成调查轮次，不能预先批准' };
      }
      const updated = updateWorkItem(session, action.workItemId, (item) => ({
        ...item,
        baseline: {
          status: 'approved',
          requirementsVersion: item.requirementsVersion || projectRequirementsVersion(session),
          investigationRounds: item.baseline?.investigationRounds,
          workspaceVersion,
          evidence,
          approvedAt: now,
        },
        updatedAt: now,
      }));
      if (!updated) return { ok: false, error: `任务不存在：${action.workItemId}` };
      next = updated;
      eventInput = {
        kind: 'work-item-baseline-approved',
        workItemId: action.workItemId,
        summary: `监督 AI 已审核项目基线：${action.workItemId}`,
        payload: { workspaceVersion, evidence },
      };
    } else if (action.type === 'intervene-work-item') {
      if (['completed', 'stopped'].includes(session.status)) {
        return { ok: false, error: '已完成或停止的项目不能再干预工作项' };
      }
      const existing = session.workItems.find((item) => item.id === action.workItemId);
      if (!existing) return { ok: false, error: `任务不存在：${action.workItemId}` };
      if (existing.goalId && existing.goalId !== activeProjectGoal(session).id) {
        return { ok: false, error: '旧主目标工作项已经失效，不能作为当前目标的用户裁决' };
      }
      if (['completed', 'stopped'].includes(existing.status)) {
        return { ok: false, error: '该工作项已经结束，无需重复干预' };
      }
      const reason = action.reason?.trim().slice(0, 1200) || '';
      const interventionLabel = action.intervention === 'skip' ? '跳过' : '关闭';
      const updated = updateWorkItem(session, action.workItemId, (item) => ({
        ...item,
        status: 'stopped',
        supervisorLaneId: undefined,
        workerSurfaceId: undefined,
        updatedAt: now,
      }));
      if (!updated) return { ok: false, error: `任务不存在：${action.workItemId}` };
      next = updated;
      eventInput = {
        kind: 'user-work-item-intervention',
        workItemId: existing.id,
        summary: `用户${interventionLabel}工作项：${existing.title}${reason ? `；理由：${reason}` : ''}`,
        payload: {
          intervention: action.intervention,
          reason: reason || undefined,
          title: existing.title,
          previousStatus: existing.status,
        },
      };
    } else if (action.type === 'record-execution') {
      const existing = session.workItems.find((item) => item.id === action.workItemId);
      if (existing?.goalId && existing.goalId !== activeProjectGoal(session).id) {
        return { ok: false, error: '旧主目标任务已经失效，不能再追加执行记录' };
      }
      const updated = updateWorkItem(session, action.workItemId, (item) => ({
        ...item,
        decisionsUsed: item.decisionsUsed + 1,
        updatedAt: now,
        executionHistory: [...item.executionHistory, action.record].slice(-MAX_EXECUTION_HISTORY),
      }));
      if (!updated) return { ok: false, error: `任务不存在：${action.workItemId}` };
      next = updated;
      eventInput = { kind: 'supervisor-decision', workItemId: action.workItemId, summary: `记录监督决策：${action.workItemId}` };
    } else if (action.type === 'pause-project') {
      next = { ...session, status: 'paused', pausedByPortfolio: action.source === 'portfolio' };
      eventInput = {
        kind: 'project-paused',
        summary: action.reason || '项目已暂停',
        payload: {
          source: action.source || 'user',
          attentionRequired: action.attentionRequired === true,
        },
      };
    } else if (action.type === 'resume-project') {
      const activeGoal = activeProjectGoal(session);
      next = {
        ...session,
        status: 'active',
        goals: (session.goals || []).map((goal) => goal.id === activeGoal.id && goal.status === 'transitioning'
          ? { ...goal, status: 'active' as const, activatedAt: now }
          : goal),
        pausedByPortfolio: false,
        ...(action.acceptRequirementsVersion
          ? { acceptedRequirementsVersion: projectRequirementsVersion(session) }
          : {}),
      };
      eventInput = { kind: 'project-resumed', summary: action.reason || '项目已恢复' };
    } else if (action.type === 'complete-current-goal') {
      const activeGoal = activeProjectGoal(session);
      const required = session.workItems.filter((item) => item.goalId === activeGoal.id && item.status !== 'stopped');
      if (required.length === 0 || required.some((item) => item.status !== 'completed')) {
        return { ok: false, error: '当前主目标的所有未停止任务完成后才能完成主目标' };
      }
      const blocked = required.find((item) => !!item.latestBlocker?.trim());
      if (blocked) {
        return { ok: false, error: `任务仍有未解决阻塞，不能完成主目标：${blocked.title} · ${blocked.latestBlocker}` };
      }
      if (!action.evidence.trim()) return { ok: false, error: '完成主目标必须提供目标级验证证据' };
      if (session.status !== 'active') {
        return { ok: false, error: '项目必须处于运行中，完成复核后才能结束当前主目标' };
      }
      if (projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)) {
        return { ok: false, error: '最新主目标要求尚未由项目 AI 接受，不能完成主目标' };
      }
      const staleEvidence = required.find((item) => (
        item.requirementsVersion !== projectRequirementsVersion(session)
        || item.authorizationVersion !== projectAuthorizationVersion(session)
      ));
      if (staleEvidence) {
        return { ok: false, error: `任务 ${staleEvidence.id} 的证据属于旧需求或授权版本，必须先复核并显式重绑` };
      }
      const incompleteSubgoal = (session.subgoals || []).find((subgoal) => (
        subgoal.goalId === activeGoal.id
        && !subgoal.id.startsWith(`${session.id}-legacy-`)
        && !['achieved', 'obsolete'].includes(subgoal.status)
      ));
      if (incompleteSubgoal) {
        return { ok: false, error: `阶段目标尚未验收：${incompleteSubgoal.title}` };
      }
      next = {
        ...session,
        status: 'waiting',
        goals: (session.goals || []).map((goal) => goal.id === activeGoal.id ? {
          ...goal,
          status: 'achieved' as const,
          closedAt: now,
        } : goal),
        subgoals: (session.subgoals || []).map((subgoal) => (
          subgoal.goalId === activeGoal.id && subgoal.status !== 'obsolete'
            ? { ...subgoal, status: 'achieved' as const, updatedAt: now }
            : subgoal
        )),
      };
      eventInput = {
        kind: 'project-goal-completed',
        summary: `主目标 G${activeGoal.sequence} 已完成，项目等待下一目标`,
        payload: { goalId: activeGoal.id, evidence: action.evidence.trim() },
      };
    } else if (action.type === 'stop-project') {
      next = { ...session, status: 'stopped' };
      eventInput = { kind: 'project-stopped', summary: action.reason || '项目已停止', payload: { emergency: action.emergency === true } };
    } else {
      eventInput = { kind: 'manager-reply', summary: action.message, correlationId: action.correlationId };
    }
    const event = makeEvent(next, { ...eventInput, ts: now });
    const updated = withEvent(next, event);
    set((current) => ({
      projectManagers: upsertProjectManagerSession(current.projectManagers, updated),
      ...(current.projectManager?.id === updated.id ? { projectManager: updated } : {}),
    }));
    return { ok: true, event };
  },
});
