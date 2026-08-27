import type { StateCreator } from 'zustand';
import { v4 as uuid } from 'uuid';
import {
  CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
  activeProjectGoal,
  normalizeProjectManagerSession,
  projectDirectoryIdentity,
  normalizeProjectCompletionResult,
  projectCompletionCriteriaError,
  projectCriterionIdentity,
  projectFinalAcceptanceEligibilityError,
  projectFinalAcceptanceScope,
  projectManagerGoalChangeHasUserBasis,
  projectManagerDestructiveDecisionScopeMatches,
  projectManagerQuestionAllowsReusableDecision,
  projectManagerQuestionDecisionKey,
  projectManagerQuestionConfirmationScope,
  projectManagerQuestionReusableDecisionScope,
  projectManagerQuestionSemanticFingerprint,
  projectPlanningConfirmationDigest,
  projectAcceptedRequirementsVersion,
  projectAuthorizationVersion,
  projectRequirementsVersion,
  projectSubgoalCompletionResult,
  requiredProjectOrientation,
  type ProjectManagerAction,
  type ProjectCompletionResult,
  type ProjectManagerEvent,
  type ProjectManagerSession,
  type ProjectSubgoal,
  type ProjectWorkItem,
} from '../../shared/project-manager';
import { projectDependencyError } from '../project-manager/engine';
import type { ProjectManagementAgentConfig } from '../../shared/project-manager-terminal';

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
  projectManagerDialogView: 'center' | 'create';
  openProjectManagerDialog: () => void;
  openProjectManagerCreationDialog: () => void;
  closeProjectManagerDialog: () => void;
  startProjectManager: (options: {
    projectDir: string;
    projectName?: string;
    projectScope?: string;
    goal: string;
    preconditions?: string[];
    supervisorNotes?: string[];
    planFiles?: ProjectManagerSession['planFiles'];
    doneWhen: string[];
    managerSurfaceId?: string;
    feishuChatId?: string;
    agentConfig?: ProjectManagementAgentConfig;
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
    workItems: session.workItems.map((item) => {
      if (item.id !== workItemId) return item;
      return update(item);
    }),
  };
}

function releaseProjectTaskTerminalBinding(
  session: ProjectManagerSession,
  workItemId: string,
  _workerSurfaceId: string | undefined,
): ProjectManagerSession {
  return session.activeWorkItemId === workItemId
    ? { ...session, activeWorkItemId: undefined }
    : session;
}

function isLiveProjectManagerSession(session: Pick<ProjectManagerSession, 'status'>): boolean {
  return ['active', 'paused', 'waiting'].includes(session.status);
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
  projectManagerDialogView: 'center',
  openProjectManagerDialog() {
    set({ projectManagerDialogOpen: true, projectManagerDialogView: 'center' });
  },
  openProjectManagerCreationDialog() {
    set({ projectManagerDialogOpen: true, projectManagerDialogView: 'create' });
  },
  closeProjectManagerDialog() {
    set({ projectManagerDialogOpen: false, projectManagerDialogView: 'center' });
  },
  startProjectManager(options) {
    const directoryIdentity = projectDirectoryIdentity(options.projectDir);
    const existing = get().projectManagers.find((session) => (
      isLiveProjectManagerSession(session)
      && projectDirectoryIdentity(session.projectDir) === directoryIdentity
    ));
    if (existing) {
      throw new Error(`该目录已绑定项目 AI“${existing.projectName || existing.goal}”（${existing.id}），请进入现有项目，不要重复创建。`);
    }
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
      supervisorNotes: options.supervisorNotes || [],
      planFiles: options.planFiles || [],
      doneWhen: options.doneWhen,
      requirementsVersion: 1,
      authorizationVersion: 1,
      acceptedRequirementsVersion: 0,
      executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
      status: 'active',
      repositoryBootstrapPending: true,
      recoveryState: 'ready',
      orientation: {
        status: 'required',
        requirementsVersion: 1,
        authorizationVersion: 1,
        snapshotFingerprint: 'capture-pending',
        reason: '项目首次创建，需要先建立项目认知基线',
        requestedAt: now,
      },
      managerSurfaceId: options.managerSurfaceId,
      feishuChatId: options.feishuChatId,
      agentConfig: options.agentConfig,
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
    if (session.executionProtocolVersion !== CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION) return;
    const normalized = normalizeProjectManagerSession(session);
    set((state) => {
      const directoryIdentity = projectDirectoryIdentity(normalized.projectDir);
      const existing = isLiveProjectManagerSession(normalized)
        ? state.projectManagers.find((candidate) => (
          candidate.id !== normalized.id
          && isLiveProjectManagerSession(candidate)
          && projectDirectoryIdentity(candidate.projectDir) === directoryIdentity
        ))
        : undefined;
      const selected = existing && existing.updatedAt >= normalized.updatedAt ? existing : normalized;
      const retained = state.projectManagers.filter((candidate) => (
        candidate.id !== normalized.id
        && !(isLiveProjectManagerSession(normalized)
          && isLiveProjectManagerSession(candidate)
          && projectDirectoryIdentity(candidate.projectDir) === directoryIdentity)
      ));
      return {
        projectManager: selected,
        projectManagers: upsertProjectManagerSession(retained, selected),
        selectedProjectManagerId: selected.id,
      };
    });
  },
  restoreProjectManagers(sessions, selectedId) {
    const normalized: ProjectManagerSession[] = [];
    const liveDirectoryIndexes = new Map<string, number>();
    for (const rawSession of sessions) {
      if (rawSession.executionProtocolVersion !== CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION) continue;
      const session = normalizeProjectManagerSession(rawSession);
      if (!isLiveProjectManagerSession(session)) {
        normalized.push(session);
        continue;
      }
      const identity = projectDirectoryIdentity(session.projectDir);
      const existingIndex = liveDirectoryIndexes.get(identity);
      if (existingIndex === undefined) {
        liveDirectoryIndexes.set(identity, normalized.length);
        normalized.push(session);
      } else if (session.updatedAt > normalized[existingIndex].updatedAt) {
        normalized[existingIndex] = session;
      }
    }
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
      next = {
        ...session,
        status: 'waiting',
        pendingSupervisorTransitions: [],
        pendingManagerDeliveries: (session.pendingManagerDeliveries || []).filter((delivery) => (
          !delivery.transitionId && !delivery.continuationKey
        )),
      };
      eventInput = {
        kind: 'requirements-alignment-required',
        summary: action.reason.trim() || '项目必须先完成需求充分性判定',
        ...(action.userConfirmationEventId?.trim() ? {
          payload: { userConfirmationEventId: action.userConfirmationEventId.trim() },
        } : {}),
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
        payload: {
          goalUnderstanding,
          scopeSummary,
          acceptanceSummary,
          ...(action.userConfirmationEventId?.trim()
            ? { userConfirmationEventId: action.userConfirmationEventId.trim() }
            : {}),
        },
      };
    } else if (action.type === 'update-project-definition') {
      const goal = action.goal.trim();
      const preconditions = action.preconditions.map((item) => item.trim()).filter(Boolean);
      const supervisorNotes = (action.supervisorNotes ?? session.supervisorNotes ?? [])
        .slice(0, 20).map((item) => item.trim().slice(0, 4000)).filter(Boolean);
      const doneWhen = action.doneWhen.map((item) => item.trim()).filter(Boolean);
      if (!goal) return { ok: false, error: '项目目标不能为空' };
      if (action.source === 'manager' && !projectManagerGoalChangeHasUserBasis(session, goal)) {
        return { ok: false, error: '当前主目标由用户提供；没有新的用户目标变更或澄清答复时，项目 AI 只能补全条件，不能改写主目标' };
      }
      const userGoalDraft = action.source === 'user'
        && (action.mode === 'pivot' || goal !== session.goal);
      if (doneWhen.length === 0 && !userGoalDraft) return { ok: false, error: '项目完成条件不能为空' };
      const previous = {
        goal: session.goal,
        goalId: session.activeGoalId,
        preconditions: session.preconditions,
        supervisorNotes: session.supervisorNotes || [],
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
      const sourceDecisionEvent = action.userConfirmationEventId?.trim()
        ? session.events.find((event) => event.id === action.userConfirmationEventId?.trim())
        : undefined;
      const sourceDecisionKey = typeof sourceDecisionEvent?.payload?.decisionKey === 'string'
        ? sourceDecisionEvent.payload.decisionKey
        : '';
      const sourceSemanticFingerprint = typeof sourceDecisionEvent?.payload?.semanticFingerprint === 'string'
        ? sourceDecisionEvent.payload.semanticFingerprint
        : '';
      const reusableUserDecisions = (session.reusableUserDecisions || []).map((decision) => (
        sourceDecisionKey
        && sourceSemanticFingerprint
        && decision.decisionKey === sourceDecisionKey
        && decision.semanticFingerprint === sourceSemanticFingerprint
          ? {
              ...decision,
              requirementsVersion: nextRequirementsVersion,
              authorizationVersion: nextAuthorizationVersion,
            }
          : decision
      ));
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
        supervisorNotes,
        planFiles: action.planFiles,
        doneWhen,
        requirementsVersion: nextRequirementsVersion,
        authorizationVersion: nextAuthorizationVersion,
        reusableUserDecisions,
        workItems,
        status: 'waiting',
        pausedByPortfolio: false,
        pendingUserQuestion: undefined,
        pendingSupervisorTransitions: [],
        pendingManagerDeliveries: (session.pendingManagerDeliveries || []).filter((delivery) => (
          !delivery.transitionId && !delivery.continuationKey
        )),
      };
      next = {
        ...next,
        orientation: requiredProjectOrientation(
          next,
          action.mode === 'pivot'
            ? '用户切换了项目主目标，需要按新目标重新建立项目认知基线'
            : '项目目标、范围或验收条件已变更，需要重新建立项目认知基线',
          now,
        ),
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
          ...(action.userConfirmationEventId?.trim()
            ? { userConfirmationEventId: action.userConfirmationEventId.trim() }
            : {}),
          supersededQuestionId: session.pendingUserQuestion?.id,
          previous,
          next: {
            goal,
            goalId: nextGoalId,
            preconditions,
            supervisorNotes,
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
      if (action.source === 'manager') {
        const incomingAcceptance = new Set(action.subgoals
          .filter((subgoal) => subgoal.status !== 'obsolete')
          .flatMap((subgoal) => subgoal.acceptance)
          .map(projectCriterionIdentity));
        const invalidGoalCoverage = activeGoal.doneWhen.map((criterion) => ({
          criterion,
          count: action.subgoals
            .filter((subgoal) => subgoal.status !== 'obsolete')
            .flatMap((subgoal) => subgoal.acceptance)
            .filter((acceptance) => projectCriterionIdentity(acceptance) === projectCriterionIdentity(criterion)).length,
        })).find((entry) => entry.count !== 1);
        if (invalidGoalCoverage) {
          return {
            ok: false,
            error: `主目标完成条件必须由且仅由一个非 obsolete 阶段 acceptance 原文覆盖：${invalidGoalCoverage.criterion}（当前 ${invalidGoalCoverage.count} 处）`,
          };
        }
        const narrowed = [...existingCurrentSubgoals.values()].flatMap((subgoal) => (
          ['achieved', 'obsolete'].includes(subgoal.status)
            ? []
            : subgoal.acceptance
              .filter((criterion) => !incomingAcceptance.has(projectCriterionIdentity(criterion)))
              .map((criterion) => ({ subgoal, criterion }))
        ))[0];
        if (narrowed) {
          return {
            ok: false,
            error: `不能通过废止或改写阶段缩减尚未满足的验收范围：${narrowed.subgoal.title} · ${narrowed.criterion}`,
          };
        }
      }
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
        const nextSubgoal = subgoal.status === 'achieved'
          ? {
              ...subgoal,
              completion: normalizeProjectCompletionResult(subgoal.completion)
                || projectSubgoalCompletionResult(subgoal, session.workItems),
            }
          : { ...subgoal, completion: undefined };
        if (nextSubgoal.status === 'achieved' && previous?.status !== 'achieved') {
          const completionError = projectCompletionCriteriaError(
            nextSubgoal.acceptance,
            nextSubgoal.completion,
            `阶段目标 ${nextSubgoal.title} 的 acceptance`,
            { allowExtra: true, requireArtifacts: true },
          );
          if (completionError) return { ok: false, error: completionError };
        }
        byId.set(subgoalKey(subgoal), previous?.status === 'achieved' ? previous : nextSubgoal);
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
          ...(action.userConfirmationEventId?.trim()
            ? { userConfirmationEventId: action.userConfirmationEventId.trim() }
            : {}),
          subgoals: action.subgoals.map(({ id, title, outcome, status, order, dependencies }) => ({
            id, title, outcome, status, order, dependencies,
          })),
        },
      };
    } else if (action.type === 'update-project-preconditions') {
      const preconditions = action.preconditions.map((item) => item.trim()).filter(Boolean);
      const nextRequirementsVersion = projectRequirementsVersion(session) + 1;
      const nextAuthorizationVersion = projectAuthorizationVersion(session) + 1;
      const activeGoal = activeProjectGoal(session);
      const workItems = session.workItems.map((item) => (
        item.goalId !== activeGoal.id || ['completed', 'stopped'].includes(item.status)
          ? item
          : {
              ...item,
              status: 'waiting-decision' as const,
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
        pendingSupervisorTransitions: [],
        pendingManagerDeliveries: (session.pendingManagerDeliveries || []).filter((delivery) => (
          !delivery.transitionId && !delivery.continuationKey
        )),
      };
      next = {
        ...next,
        orientation: requiredProjectOrientation(
          next,
          '项目前置条件和授权边界已变更，需要重新建立项目认知基线',
          now,
        ),
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
        payload: {
          question: action.question,
          ...(action.question.category === 'manual-intervention'
            ? {
                resolvedAttentionKinds: [
                  'project-paused',
                  'manager-runtime-failed',
                  'supervisor-runtime-failed',
                  'task-runtime-failed',
                ],
              }
            : {}),
        },
      };
    } else if (action.type === 'answer-user-clarification') {
      const pending = session.pendingUserQuestion;
      if (!pending || pending.id !== action.questionId) {
        return { ok: false, error: '该用户确认问题不存在或已经处理' };
      }
      const answer = action.answer.trim();
      if (!answer) return { ok: false, error: '用户答复不能为空' };
      const confirmationScope = projectManagerQuestionConfirmationScope(pending, action.optionId);
      if (action.reuseForSimilar
        && pending.reasonCode === 'destructive-action'
        && !projectManagerDestructiveDecisionScopeMatches(
          pending.decisionScope,
          session.id,
          pending.workItemId,
        )) {
        return { ok: false, error: '删除复用授权的 project/workItem 必须与当前项目和当前工作项完全一致' };
      }
      if (action.reuseForSimilar && !projectManagerQuestionAllowsReusableDecision(pending)) {
        return { ok: false, error: '当前问题不能授权自动复用；仅普通需求选择、明确范围的上机/访问授权和结构化单条测试记录清理可以复用，显式 decisionKey 必须同时提供 decisionScope' };
      }
      const reusableDecision = action.reuseForSimilar ? {
        id: `reusable-decision-${uuid()}`,
        decisionKey: projectManagerQuestionDecisionKey(pending),
        semanticFingerprint: projectManagerQuestionSemanticFingerprint(pending),
        decisionScope: projectManagerQuestionReusableDecisionScope(pending),
        ...(pending.reasonCode === 'destructive-action'
          ? { projectId: session.id, workItemId: pending.workItemId }
          : {}),
        category: pending.category || 'clarification' as const,
        ...(pending.reasonCode ? { reasonCode: pending.reasonCode } : {}),
        question: pending.question,
        answer,
        ...(action.optionId ? { optionId: action.optionId } : {}),
        requirementsVersion: projectRequirementsVersion(session),
        authorizationVersion: projectAuthorizationVersion(session),
        answeredBy: action.answeredBy,
        createdAt: now,
      } : undefined;
      const verificationAction = pending.reasonCode === 'verification-limited'
        && ['alternative-validation', 'defer-verification', 'skip-verification'].includes(action.optionId || '')
        ? action.optionId as 'alternative-validation' | 'defer-verification' | 'skip-verification'
        : undefined;
      const manualVerificationReported = pending.reasonCode === 'verification-limited'
        && action.optionId === 'manual-verify';
      const workItems = (verificationAction || manualVerificationReported) && pending.workItemId
        ? session.workItems.map((item) => item.id === pending.workItemId ? {
            ...item,
            ...(manualVerificationReported ? { verificationLimitation: undefined } : {}),
            ...(verificationAction ? {
              verificationDecision: {
                action: verificationAction,
                questionId: pending.id,
                reason: pending.blocker || pending.context || pending.question,
                answeredBy: action.answeredBy,
                requirementsVersion: projectRequirementsVersion(session),
                authorizationVersion: projectAuthorizationVersion(session),
                decidedAt: now,
              },
            } : {}),
            ...(verificationAction === 'defer-verification' ? {
              latestBlocker: '用户已明确授权暂缓当前验证并继续后续工作；该验收项仍未验证，不能据此完成阶段或项目。',
            } : verificationAction === 'skip-verification' ? {
              status: 'stopped' as const,
              supervisorLaneId: undefined,
              workerSurfaceId: undefined,
              latestBlocker: '用户已跳过当前验证工作项并要求后续新计划重新承接；该验收项仍未验证，不能据此完成阶段或项目。',
            } : {}),
            updatedAt: now,
          } : item)
        : session.workItems;
      // Keep the project waiting after a user answer. The answer belongs to the
      // project manager, which must explicitly choose resume/replan/stop before
      // any supervisor or task terminal is allowed to continue.
      const answeredSession: ProjectManagerSession = {
        ...session,
        status: session.status === 'paused' ? 'paused' : 'waiting',
        workItems,
        pendingUserQuestion: undefined,
        ...(reusableDecision ? {
          reusableUserDecisions: [
            ...(session.reusableUserDecisions || []).filter((decision) => (
              decision.decisionKey !== reusableDecision.decisionKey
              || decision.semanticFingerprint !== reusableDecision.semanticFingerprint
              || decision.requirementsVersion !== reusableDecision.requirementsVersion
              || decision.authorizationVersion !== reusableDecision.authorizationVersion
            )),
            reusableDecision,
          ].slice(-50),
          } : {}),
      };
      next = verificationAction === 'skip-verification' && pending.workItemId
        ? releaseProjectTaskTerminalBinding(
            answeredSession,
            pending.workItemId,
            session.workItems.find((item) => item.id === pending.workItemId)?.workerSurfaceId,
          )
        : answeredSession;
      eventInput = {
        kind: 'user-clarification-answered',
        workItemId: pending.workItemId,
        summary: `用户答复：${answer}`,
        correlationId: pending.id,
        payload: {
          questionId: pending.id,
          question: pending.question,
          answer,
          optionId: action.optionId,
          answeredBy: action.answeredBy,
          category: pending.category,
          reuseForSimilar: !!reusableDecision,
          ...(reusableDecision ? { decisionKey: reusableDecision.decisionKey } : {}),
          ...(reusableDecision ? { semanticFingerprint: reusableDecision.semanticFingerprint } : {}),
          ...(confirmationScope.length ? {
            confirmationScope,
            confirmationDigest: projectPlanningConfirmationDigest(confirmationScope),
          } : {}),
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
      const safePatch = action.patch.status === 'stopped'
        ? { ...action.patch, supervisorLaneId: undefined, workerSurfaceId: undefined }
        : action.patch;
      const updated = updateWorkItem(session, action.workItemId, (item) => {
        const nextStatus = safePatch.status || item.status;
        const completion = safePatch.completion !== undefined
          ? normalizeProjectCompletionResult(safePatch.completion)
          : ['validating', 'completed'].includes(nextStatus)
            ? item.completion
            : undefined;
        return {
          ...item,
          ...safePatch,
          id: item.id,
          goalId: item.goalId,
          completion,
          updatedAt: now,
        };
      });
      if (!updated) return { ok: false, error: `任务不存在：${action.workItemId}` };
      const dependencyError = projectDependencyError(updated.workItems);
      if (dependencyError) return { ok: false, error: dependencyError };
      next = safePatch.status === 'stopped' || safePatch.status === 'completed'
        ? releaseProjectTaskTerminalBinding(updated, action.workItemId, existing.workerSurfaceId)
        : updated;
      eventInput = { kind: 'work-item-updated', workItemId: action.workItemId, summary: `更新任务：${action.workItemId}` };
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
      next = releaseProjectTaskTerminalBinding(updated, action.workItemId, existing.workerSurfaceId);
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
        totalDecisionsUsed: (item.totalDecisionsUsed || 0)
          + (action.consumeDecision === false ? 0 : 1),
        updatedAt: now,
        executionHistory: [
          ...item.executionHistory,
          { ...action.record, consumedDecision: action.consumeDecision !== false },
        ].slice(-MAX_EXECUTION_HISTORY),
      }));
      if (!updated) return { ok: false, error: `任务不存在：${action.workItemId}` };
      next = updated;
      eventInput = {
        kind: 'supervisor-decision',
        workItemId: action.workItemId,
        summary: action.consumeDecision === false
          ? `记录未生效的监督尝试：${action.workItemId}`
          : `记录监督决策：${action.workItemId}`,
      };
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
        repositoryBootstrapPending: true,
        goals: (session.goals || []).map((goal) => goal.id === activeGoal.id && goal.status === 'transitioning'
          ? { ...goal, status: 'active' as const, activatedAt: now }
          : goal),
        pausedByPortfolio: false,
        safeExit: session.safeExit?.status === 'restoring' && session.recoveryState === 'checking'
          ? session.safeExit
          : undefined,
        ...(action.acceptRequirementsVersion
          ? { acceptedRequirementsVersion: projectRequirementsVersion(session) }
          : {}),
      };
      eventInput = { kind: 'project-resumed', summary: action.reason || '项目已恢复' };
    } else if (action.type === 'complete-current-goal') {
      const activeGoal = activeProjectGoal(session);
      const goalCompletion = normalizeProjectCompletionResult(action.completion);
      const userAcceptanceEvent = action.userAcceptanceEventId
        ? session.events.find((event) => event.id === action.userAcceptanceEventId)
        : undefined;
      const acceptanceQuestionId = String(userAcceptanceEvent?.payload?.questionId || '');
      const acceptanceRequest = acceptanceQuestionId
        ? session.events.find((event) => (
            event.kind === 'user-clarification-requested'
            && event.correlationId === acceptanceQuestionId
            && (event.payload?.question as { reasonCode?: string } | undefined)?.reasonCode === 'final-acceptance'
          ))
        : undefined;
      const acceptanceQuestion = acceptanceRequest?.payload?.question as { decisionScope?: string } | undefined;
      const confirmedScope = Array.isArray(userAcceptanceEvent?.payload?.confirmationScope)
        ? userAcceptanceEvent.payload.confirmationScope.map((entry) => String(entry || '').trim())
        : [];
      const currentFinalAcceptanceScope = projectFinalAcceptanceScope(session);
      const latestFinalAcceptanceAnswer = [...session.events].reverse().find((event) => {
        if (event.kind !== 'user-clarification-answered') return false;
        const questionId = String(event.payload?.questionId || '');
        const request = session.events.find((candidate) => (
          candidate.kind === 'user-clarification-requested'
          && candidate.correlationId === questionId
          && (candidate.payload?.question as { reasonCode?: string; decisionScope?: string } | undefined)?.reasonCode === 'final-acceptance'
        ));
        return (request?.payload?.question as { decisionScope?: string } | undefined)?.decisionScope
          === currentFinalAcceptanceScope;
      });
      const finalAccepted = !!action.userAcceptanceEventId
        && userAcceptanceEvent?.kind === 'user-clarification-answered'
        && userAcceptanceEvent.payload?.optionId === 'accept-current-result'
        && ['desktop', 'feishu'].includes(String(userAcceptanceEvent.payload?.answeredBy || ''))
        && !!acceptanceRequest
        && latestFinalAcceptanceAnswer?.id === userAcceptanceEvent.id
        && confirmedScope.includes('finalAcceptance')
        && userAcceptanceEvent.payload?.confirmationDigest === projectPlanningConfirmationDigest(confirmedScope)
        && acceptanceQuestion?.decisionScope === currentFinalAcceptanceScope;
      if (action.userAcceptanceEventId && !finalAccepted) {
        return { ok: false, error: '最终效果接受必须引用当前目标和需求版本下、由用户亲自选择“接受项目已完成”的结构化答复' };
      }
      if (finalAccepted) {
        const eligibilityError = projectFinalAcceptanceEligibilityError(session);
        if (eligibilityError) return { ok: false, error: eligibilityError };
      }
      const activeItems = session.workItems.filter((item) => item.goalId === activeGoal.id && item.status !== 'stopped');
      const staleOpenItem = activeItems.find((item) => (
        item.status !== 'completed'
        && (item.requirementsVersion !== projectRequirementsVersion(session)
          || item.authorizationVersion !== projectAuthorizationVersion(session))
      ));
      if (staleOpenItem) {
        return { ok: false, error: `任务 ${staleOpenItem.id} 仍属于旧需求或授权版本，必须先重绑或停止` };
      }
      const required = activeItems.filter((item) => (
        item.requirementsVersion === projectRequirementsVersion(session)
        && item.authorizationVersion === projectAuthorizationVersion(session)
      ));
      if (required.length === 0 || (!finalAccepted && required.some((item) => item.status !== 'completed'))) {
        return { ok: false, error: '当前版本必须至少有一项完成成果，且所有当前版本未停止任务完成后才能完成主目标' };
      }
      const blocked = required.find((item) => !!item.latestBlocker?.trim());
      if (blocked && !finalAccepted) {
        return { ok: false, error: `任务仍有未解决阻塞，不能完成主目标：${blocked.title} · ${blocked.latestBlocker}` };
      }
      if (!action.evidence.trim()) return { ok: false, error: '完成主目标必须提供目标级验证证据' };
      const goalCriteriaError = projectCompletionCriteriaError(
        activeGoal.doneWhen,
        goalCompletion,
        '主目标完成条件',
      );
      if (goalCriteriaError && !finalAccepted) return { ok: false, error: goalCriteriaError };
      const supervisorCriteriaByIdentity = new Map<string, NonNullable<ProjectCompletionResult['criteria']>[number]>();
      for (const criterion of required.flatMap((item) => (
        normalizeProjectCompletionResult(item.completion)?.criteria || []
      ))) {
        const identity = projectCriterionIdentity(criterion.criterion);
        const previous = supervisorCriteriaByIdentity.get(identity);
        supervisorCriteriaByIdentity.set(identity, previous ? {
          ...previous,
          status: previous.status === 'satisfied' && criterion.status === 'satisfied'
            ? 'satisfied'
            : previous.status === 'unsatisfied' || criterion.status === 'unsatisfied' ? 'unsatisfied' : 'unverified',
          result: previous.result === criterion.result ? previous.result : 'inconclusive',
          method: previous.method === criterion.method ? previous.method : 'evidence-review',
          evidence: `${previous.evidence}\n${criterion.evidence}`.slice(0, 12_000),
          evidenceRefs: [...new Set([...previous.evidenceRefs, ...criterion.evidenceRefs])].slice(0, 20),
          evidenceArtifacts: [...(previous.evidenceArtifacts || []), ...(criterion.evidenceArtifacts || [])]
            .filter((artifact, index, all) => all.findIndex((candidate) => candidate.ref === artifact.ref) === index)
            .slice(0, 20),
        } : criterion);
      }
      const supervisorCriteria = [...supervisorCriteriaByIdentity.values()];
      const supervisorSupportError = projectCompletionCriteriaError(
        activeGoal.doneWhen,
        normalizeProjectCompletionResult({
          summary: '当前版本监督工作项的目标条件证据汇总',
          validation: [],
          criteria: supervisorCriteria,
          completedAt: now,
        }),
        '主目标完成条件的监督证据',
        { allowExtra: true, requireArtifacts: true },
      );
      if (supervisorSupportError && !finalAccepted) return { ok: false, error: supervisorSupportError };
      if (!finalAccepted) for (const criterion of activeGoal.doneWhen) {
        const identity = projectCriterionIdentity(criterion);
        const declared = goalCompletion?.criteria?.find((item) => (
          projectCriterionIdentity(item.criterion) === identity
        ));
        const supervised = supervisorCriteriaByIdentity.get(identity);
        if (!declared || !supervised) continue;
        if (declared.result !== supervised.result || declared.method !== supervised.method) {
          return {
            ok: false,
            error: `主目标完成声明与监督实际证据结论不一致：${criterion}（声明 ${declared.result}/${declared.method}，监督 ${supervised.result}/${supervised.method}）`,
          };
        }
        if (declared.evidenceRefs.some((ref) => !supervised.evidenceRefs.includes(ref))) {
          return { ok: false, error: `主目标完成声明引用了未经监督核验的证据文件：${criterion}` };
        }
      }
      if (session.status !== 'active' && !(finalAccepted && session.status === 'waiting')) {
        return { ok: false, error: '项目必须处于运行中，完成复核后才能结束当前主目标' };
      }
      if (projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)) {
        return { ok: false, error: '最新主目标要求尚未由项目 AI 接受，不能完成主目标' };
      }
      const incompleteSubgoal = (session.subgoals || []).find((subgoal) => (
        subgoal.goalId === activeGoal.id
        && !['achieved', 'obsolete'].includes(subgoal.status)
      ));
      if (incompleteSubgoal && !finalAccepted) {
        return { ok: false, error: `阶段目标尚未验收：${incompleteSubgoal.title}` };
      }
      const invalidSubgoalCompletion = (session.subgoals || []).flatMap((subgoal) => {
        if (subgoal.goalId !== activeGoal.id
          || subgoal.status !== 'achieved') return [];
        const completion = projectSubgoalCompletionResult(subgoal, session.workItems);
        const error = projectCompletionCriteriaError(
          subgoal.acceptance,
          completion,
          `阶段目标 ${subgoal.title} 的 acceptance`,
          { allowExtra: true, requireArtifacts: true },
        );
        return error ? [error] : [];
      })[0];
      if (invalidSubgoalCompletion && !finalAccepted) return { ok: false, error: invalidSubgoalCompletion };
      next = {
        ...session,
        status: 'waiting',
        ...(finalAccepted ? {
          activeWorkItemId: undefined,
          workItems: session.workItems.map((item) => (
            item.goalId === activeGoal.id && !['completed', 'stopped'].includes(item.status)
              ? {
                  ...item,
                  status: 'stopped' as const,
                  supervisorLaneId: undefined,
                  workerSurfaceId: undefined,
                  updatedAt: now,
                }
              : item
          )),
        } : {}),
        goals: (session.goals || []).map((goal) => goal.id === activeGoal.id ? {
          ...goal,
          status: 'achieved' as const,
          closedAt: now,
        } : goal),
        subgoals: (session.subgoals || []).map((subgoal) => (
          subgoal.goalId === activeGoal.id && subgoal.status !== 'obsolete'
            ? {
                ...subgoal,
                status: finalAccepted && subgoal.status !== 'achieved'
                  ? 'obsolete' as const
                  : 'achieved' as const,
                updatedAt: now,
              }
            : subgoal
        )),
      };
      eventInput = {
        kind: 'project-goal-completed',
        summary: `主目标 G${activeGoal.sequence} 已完成，项目等待下一目标`,
        payload: {
          goalId: activeGoal.id,
          evidence: action.evidence.trim(),
          completion: goalCompletion,
          ...(finalAccepted ? {
            finalAcceptance: {
              eventId: userAcceptanceEvent!.id,
              answer: String(userAcceptanceEvent!.payload?.answer || ''),
              answeredBy: userAcceptanceEvent!.payload?.answeredBy,
              scope: currentFinalAcceptanceScope,
            },
          } : {}),
          attentionRequired: true,
        },
      };
    } else if (action.type === 'stop-project') {
      next = { ...session, status: 'stopped' };
      eventInput = {
        kind: 'project-stopped',
        summary: action.reason || '项目已停止',
        payload: { emergency: action.emergency === true, attentionRequired: true },
      };
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
