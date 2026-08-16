import React from 'react';
import { useStore } from '../../store';
import '../../styles/supervisor.css';

export default function ProjectManagerPanel() {
  const session = useStore((state) => state.projectManager);
  const sessions = useStore((state) => state.projectManagers);
  const openProjectManagerDialog = useStore((state) => state.openProjectManagerDialog);
  if (!session) return null;

  const completed = session.workItems.filter((item) => item.status === 'completed').length;
  const waiting = session.workItems.filter((item) => item.status === 'waiting-decision').length;
  const activeProjects = sessions.filter((project) => !['completed', 'stopped'].includes(project.status)).length;
  const active = session.status === 'active';
  const paused = session.status === 'paused';

  const control = (action: 'pause' | 'resume') => {
    void (window as any).__wmux_projectManagerRemoteControl?.({
      action,
      projectId: session.id,
      reason: action === 'pause' ? '用户在桌面端暂停项目' : '用户在桌面端恢复项目',
    });
  };

  return (
    <section className="sup-panel sup-panel--compact" data-active={active ? '1' : '0'} data-paused={paused ? '1' : '0'}>
      <button type="button" className="sup-panel__header" onClick={openProjectManagerDialog}>
        <span className="sup-panel__dot" />
        <span className="sup-panel__title">项目管理 AI</span>
        <span className="sup-panel__status">{activeProjects}/3 · {session.status}</span>
      </button>
      <div className="sup-panel__goal" title={session.goal}>{session.goal}</div>
      <div className="sup-panel__freedom">
        任务 {completed}/{session.workItems.length}{waiting > 0 ? ` · ${waiting} 待决` : ''}
      </div>
      <div className="sup-panel__compact-actions">
        <button type="button" onClick={openProjectManagerDialog}>打开控制台</button>
        {active && <button type="button" onClick={() => control('pause')}>暂停项目</button>}
        {paused && <button type="button" onClick={() => control('resume')}>恢复项目</button>}
      </div>
    </section>
  );
}
