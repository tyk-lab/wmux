import type { StateCreator } from 'zustand';
import { v4 as uuid } from 'uuid';
import {
  type ProjectManagerAction,
  type ProjectManagerEvent,
  type ProjectManagerSession,
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
    goal: string;
    doneWhen: string[];
    managerSurfaceId?: string;
    feishuChatId?: string;
  }) => ProjectManagerSession;
  restoreProjectManager: (session: ProjectManagerSession | null) => void;
  restoreProjectManagers: (sessions: ProjectManagerSession[], selectedId?: string) => void;
  selectProjectManager: (sessionId: string) => void;
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
    const session: ProjectManagerSession = {
      id: `pm-${uuid()}`,
      projectDir: options.projectDir,
      goal: options.goal,
      doneWhen: options.doneWhen,
      status: 'active',
      recoveryState: 'ready',
      managerSurfaceId: options.managerSurfaceId,
      feishuChatId: options.feishuChatId,
      workItems: [],
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({
      projectManager: session,
      projectManagers: upsertProjectManagerSession(state.projectManagers, session),
      selectedProjectManagerId: session.id,
    }));
    return session;
  },
  restoreProjectManager(session) {
    if (!session) {
      set({ projectManager: null, projectManagers: [], selectedProjectManagerId: null });
      return;
    }
    set((state) => ({
      projectManager: session,
      projectManagers: upsertProjectManagerSession(state.projectManagers, session),
      selectedProjectManagerId: session.id,
    }));
  },
  restoreProjectManagers(sessions, selectedId) {
    const selected = sessions.find((session) => session.id === selectedId) || sessions[0] || null;
    set({
      projectManager: selected,
      projectManagers: [...sessions],
      selectedProjectManagerId: selected?.id || null,
    });
  },
  selectProjectManager(sessionId) {
    const selected = get().projectManagers.find((session) => session.id === sessionId);
    if (selected) set({ projectManager: selected, selectedProjectManagerId: selected.id });
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
    const session = sessionId
      ? state.projectManagers.find((candidate) => candidate.id === sessionId) || null
      : state.projectManager;
    if (!session) return { ok: false, error: '当前没有项目管理会话' };
    const now = Date.now();
    let next = session;
    let eventInput: Omit<ProjectManagerEvent, 'id' | 'sessionId' | 'ts'>;

    if (action.type === 'create-work-item') {
      if (session.workItems.some((item) => item.id === action.workItem.id)) {
        return { ok: false, error: `任务 ID 已存在：${action.workItem.id}` };
      }
      const workItems = [...session.workItems, action.workItem];
      const dependencyError = projectDependencyError(workItems);
      if (dependencyError) return { ok: false, error: dependencyError };
      next = { ...session, workItems };
      eventInput = { kind: 'work-item-created', workItemId: action.workItem.id, summary: `创建任务：${action.workItem.title}` };
    } else if (action.type === 'update-work-item') {
      const updated = updateWorkItem(session, action.workItemId, (item) => ({ ...item, ...action.patch, id: item.id, updatedAt: now }));
      if (!updated) return { ok: false, error: `任务不存在：${action.workItemId}` };
      const dependencyError = projectDependencyError(updated.workItems);
      if (dependencyError) return { ok: false, error: dependencyError };
      next = updated;
      eventInput = { kind: 'work-item-updated', workItemId: action.workItemId, summary: `更新任务：${action.workItemId}` };
    } else if (action.type === 'record-execution') {
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
      next = { ...session, status: 'paused' };
      eventInput = { kind: 'project-paused', summary: action.reason || '项目已暂停' };
    } else if (action.type === 'resume-project') {
      next = { ...session, status: 'active' };
      eventInput = { kind: 'project-resumed', summary: action.reason || '项目已恢复' };
    } else if (action.type === 'complete-project') {
      const required = session.workItems.filter((item) => item.status !== 'stopped');
      if (required.length === 0 || required.some((item) => item.status !== 'completed')) {
        return { ok: false, error: '所有未停止的项目任务完成后才能完成项目' };
      }
      if (!action.evidence.trim()) return { ok: false, error: '完成项目必须提供项目级验证证据' };
      next = { ...session, status: 'completed' };
      eventInput = { kind: 'project-completed', summary: '项目级验收已完成', payload: { evidence: action.evidence.trim() } };
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
