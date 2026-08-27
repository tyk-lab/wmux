import React, { useState } from 'react';
import {
  activeProjectGoal,
  activeProjectManagerAttentionEvent,
  projectDisplayName,
} from '../../../shared/project-manager';
import { useStore } from '../../store';
import { openProjectManagerConsole } from '../../project-manager/console-surface';
import { supervisorLaneControlState } from '../../store/supervisor-slice';
import { ensureProjectSupervisorStatusSurface } from '../../supervisor/status-surface';
import '../../styles/supervisor.css';

export default function ProjectManagerPanel() {
  const session = useStore((state) => state.projectManager);
  const sessions = useStore((state) => state.projectManagers);
  const supervisor = useStore((state) => state.supervisor);
  const openProjectManagerDialog = useStore((state) => state.openProjectManagerDialog);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlMessage, setControlMessage] = useState('');
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
  const activeAlert = activeProjectManagerAttentionEvent(session.events) || null;
  const goalCompletionNotice = activeAlert?.kind === 'project-goal-completed';

  const control = async (action: 'pause' | 'resume') => {
    if (controlBusy) return;
    setControlBusy(true);
    setControlMessage('');
    try {
      const remoteControl = (window as any).__wmux_projectManagerRemoteControl;
      if (typeof remoteControl !== 'function') throw new Error('项目调度控制层尚未就绪');
      const result = await remoteControl({
        action,
        projectId: session.id,
        reason: action === 'pause' ? '用户在桌面端暂停项目' : '用户在桌面端恢复项目',
      });
      if (!result?.ok) throw new Error(result?.error || '项目控制操作失败');
      setControlMessage(result.message || (action === 'resume' ? '项目已恢复，正在唤醒项目 AI。' : '项目已暂停。'));
    } catch (error) {
      setControlMessage(String((error as Error)?.message || error));
    } finally {
      setControlBusy(false);
    }
  };

  const openProjectSupervisor = () => {
    if (ensureProjectSupervisorStatusSurface(session.id, true)) return;
    setControlMessage('当前项目执行工作区尚未建立，无法打开监督状态页；请先打开当前项目查看恢复要求。');
  };

  return (
    <section className="sup-panel sup-panel--compact" data-active={active ? '1' : '0'} data-paused={paused ? '1' : '0'}>
      <button type="button" className="sup-panel__header" onClick={openProjectManagerDialog}>
        <span className="sup-panel__dot" />
        <span className="sup-panel__title">项目中心</span>
        <span className="sup-panel__status">活动项目 {activeProjects} · 当前项目：{session.pendingUserQuestion ? '等待用户处理' : goalCompletionNotice ? '等待下一主目标' : activeAlert ? '需要处理' : currentGoal.status === 'achieved' ? '等待下一主目标' : session.progressSync?.status === 'review-required' ? '同步新进度' : session.orientation?.status !== 'ready' ? '复核项目现状' : session.pendingSupervisorTransitions?.length ? '处理监督交接' : active ? '运行中' : paused ? '已暂停' : session.status}</span>
      </button>
      <div className="sup-panel__goal" title={`${projectDisplayName(session)} · ${session.goal}`}>
        当前项目：{projectDisplayName(session)} · G{currentGoal.sequence} {session.goal}
      </div>
      <div className="sup-panel__freedom">
        当前目标任务 {completed}/{currentWorkItems.length} · 专属监督 {projectLanes.length}{waiting > 0 ? ` · ${waiting} 待决` : ''}
      </div>
      {activeAlert && (
        <button
          type="button"
          className="project-manager-panel__alert"
          data-kind={goalCompletionNotice ? 'completion' : 'alert'}
          onClick={goalCompletionNotice ? openProjectManagerDialog : () => openProjectManagerConsole(session.id)}
        >
          <span>{goalCompletionNotice ? '✓ 目标已完成' : '项目告警'}</span>
          <strong>{goalCompletionNotice
            ? `G${currentGoal.sequence} 已完成 · 查看结果并设置下一目标`
            : activeAlert.summary}</strong>
        </button>
      )}
      {controlMessage && <div className="sup-panel__freedom project-manager-panel__message" role="status" title={controlMessage}>{controlMessage}</div>}
      <div className="sup-panel__compact-actions">
        <button type="button" onClick={() => openProjectManagerConsole(session.id)}>打开当前项目</button>
        <button type="button" onClick={openProjectSupervisor}>打开当前项目监督</button>
        {active && <button type="button" disabled={controlBusy} onClick={() => void control('pause')}>{controlBusy ? '处理中…' : '暂停当前项目'}</button>}
        {paused && <button type="button" disabled={controlBusy} onClick={() => void control('resume')}>{controlBusy ? '恢复中…' : '恢复当前项目'}</button>}
      </div>
    </section>
  );
}
