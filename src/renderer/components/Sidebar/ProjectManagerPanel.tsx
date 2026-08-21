import React from 'react';
import {
  activeProjectGoal,
  activeProjectManagerAttentionEvent,
  projectDisplayName,
} from '../../../shared/project-manager';
import { useStore } from '../../store';
import { openProjectManagerConsole } from '../../project-manager/console-surface';
import { findLeaf, getAllPaneIds } from '../../store/split-utils';
import { supervisorLaneControlState } from '../../store/supervisor-slice';
import '../../styles/supervisor.css';

export default function ProjectManagerPanel() {
  const session = useStore((state) => state.projectManager);
  const sessions = useStore((state) => state.projectManagers);
  const supervisor = useStore((state) => state.supervisor);
  const workspaces = useStore((state) => state.workspaces);
  const selectWorkspace = useStore((state) => state.selectWorkspace);
  const selectSurface = useStore((state) => state.selectSurface);
  const openProjectManagerDialog = useStore((state) => state.openProjectManagerDialog);
  if (!session) return null;

  const currentGoal = activeProjectGoal(session);
  const currentWorkItems = session.workItems.filter((item) => (
    !session.activeGoalId || !item.goalId || item.goalId === session.activeGoalId
  ));
  const completed = currentWorkItems.filter((item) => item.status === 'completed').length;
  const waiting = currentWorkItems.filter((item) => item.status === 'waiting-decision').length;
  const activeProjects = sessions.filter((project) => !['completed', 'stopped'].includes(project.status)).length;
  const active = session.status === 'active';
  const paused = session.status === 'paused';
  const projectLanes = supervisor.lanes.filter((lane) => (
    lane.projectManagerProjectId === session.id
    && supervisorLaneControlState(lane) !== 'stopped'
  ));
  const projectSupervisorView = workspaces.flatMap((workspace) => (
    workspace.transientSupervisorWorkspace === true
      ? getAllPaneIds(workspace.splitTree).flatMap((paneId) => {
          const pane = findLeaf(workspace.splitTree, paneId);
          const surfaceIndex = pane?.surfaces.findIndex((surface) => (
            surface.type === 'supervisor' && surface.projectSupervisorProjectId === session.id
          )) ?? -1;
          return surfaceIndex >= 0 ? [{ workspaceId: workspace.id, paneId, surfaceIndex }] : [];
        })
      : []
  ))[0];
  const activeAlert = activeProjectManagerAttentionEvent(session.events) || null;

  const control = (action: 'pause' | 'resume') => {
    void (window as any).__wmux_projectManagerRemoteControl?.({
      action,
      projectId: session.id,
      reason: action === 'pause' ? '用户在桌面端暂停项目' : '用户在桌面端恢复项目',
    });
  };

  const openProjectSupervisor = () => {
    if (!projectSupervisorView) return;
    selectWorkspace(projectSupervisorView.workspaceId);
    selectSurface(projectSupervisorView.workspaceId, projectSupervisorView.paneId, projectSupervisorView.surfaceIndex);
  };

  return (
    <section className="sup-panel sup-panel--compact" data-active={active ? '1' : '0'} data-paused={paused ? '1' : '0'}>
      <button type="button" className="sup-panel__header" onClick={openProjectManagerDialog}>
        <span className="sup-panel__dot" />
        <span className="sup-panel__title">项目中心</span>
        <span className="sup-panel__status">{activeProjects} 个项目 · {session.pendingUserQuestion ? '等待用户处理' : session.progressSync?.status === 'review-required' ? '同步新进度' : session.orientation?.status !== 'ready' ? '复核项目现状' : session.pendingSupervisorTransitions?.length ? '处理监督交接' : active ? '运行中' : paused ? '已暂停' : session.status}</span>
      </button>
      <div className="sup-panel__goal" title={`${projectDisplayName(session)} · ${session.goal}`}>
        {projectDisplayName(session)} · G{currentGoal.sequence} {session.goal}
      </div>
      <div className="sup-panel__freedom">
        当前目标任务 {completed}/{currentWorkItems.length} · 专属监督 {projectLanes.length}{waiting > 0 ? ` · ${waiting} 待决` : ''}
      </div>
      {activeAlert && (
        <button type="button" className="project-manager-panel__alert" onClick={() => openProjectManagerConsole(session.id)}>
          <span>项目告警</span>
          <strong>{activeAlert.summary}</strong>
        </button>
      )}
      <div className="sup-panel__compact-actions">
        <button type="button" onClick={() => openProjectManagerConsole(session.id)}>打开控制台</button>
        {projectSupervisorView && (
          <button type="button" onClick={openProjectSupervisor}>打开项目监督</button>
        )}
        {active && <button type="button" onClick={() => control('pause')}>暂停项目</button>}
        {paused && <button type="button" onClick={() => control('resume')}>恢复项目</button>}
      </div>
    </section>
  );
}
