import { useState } from 'react';
import { useStore } from '../../store';
import { modeLabel, stopWhenKindLabel } from '../../supervisor/protocol';
import { sendToSurface } from '../../supervisor/supervisor-engine';
import '../../styles/supervisor.css';

export default function SupervisorPanel() {
  const supervisor = useStore((s) => s.supervisor);
  const stopSupervisor = useStore((s) => s.stopSupervisor);
  const startSupervisor = useStore((s) => s.startSupervisor);
  const openSupervisorSetup = useStore((s) => s.openSupervisorSetup);
  const approvePending = useStore((s) => s.approvePending);
  const rejectPending = useStore((s) => s.rejectPending);
  const updateStep = useStore((s) => s.updateStep);
  const appendSupervisorLog = useStore((s) => s.appendSupervisorLog);
  const confirmStopCondition = useStore((s) => s.confirmStopCondition);
  const rejectStopCondition = useStore((s) => s.rejectStopCondition);
  const [collapsed, setCollapsed] = useState(false);

  if (supervisor.lanes.length === 0 && !supervisor.active) return null;

  const enabled = supervisor.lanes.filter((l) => l.enabled);
  const pendingCount = supervisor.pendingApprovals.length;
  const mode = supervisor.mode || 'direct';

  const onApprove = (id: string) => {
    const item = approvePending(id);
    if (!item) return;
    try {
      sendToSurface(item.surfaceId, item.text, supervisor.submitEnter);
      const lane = supervisor.lanes.find((l) => l.id === item.laneId);
      const step = lane?.steps.find((s) => s.status === 'pending');
      if (step) {
        updateStep(item.laneId, step.id, { status: 'in_progress', dispatchedAt: Date.now() });
      }
      appendSupervisorLog(item.laneId, '已批准发送', `${item.laneLabel} → ${item.surfaceId}`);
    } catch (err: any) {
      appendSupervisorLog(item.laneId, '发送失败', String(err?.message || err));
    }
  };

  return (
    <div
      className="sup-panel"
      data-active={supervisor.active ? '1' : '0'}
      data-collapsed={collapsed ? '1' : '0'}
    >
      <button
        type="button"
        className="sup-panel__header"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? '展开监督面板' : '折叠监督面板'}
      >
        <span className="sup-panel__dot" />
        <span className="sup-panel__title">AI 监督</span>
        <span className="sup-panel__status">{supervisor.active ? '运行中' : '已停止'}</span>
        <span className="sup-panel__meta-right">
          {modeLabel(mode)} · {enabled.length} 通道
          {pendingCount > 0 ? ` · ${pendingCount} 待批` : ''}
        </span>
      </button>

      {!collapsed && (
        <>
          <div className="sup-panel__freedom">
            {mode === 'direct'
              ? `原样注入；停止条件（${stopWhenKindLabel(supervisor.stopWhenKind || 'concrete')}）由监督 AI 判断`
              : `目标追逐；完成条件（${stopWhenKindLabel(supervisor.stopWhenKind || 'concrete')}）由监督 AI 判断`}
          </div>
          {mode === 'direct' && supervisor.stopWhen.trim() && (
            <div className="sup-panel__goal" title={supervisor.stopWhen}>
              停止({stopWhenKindLabel(supervisor.stopWhenKind || 'concrete')}): {supervisor.stopWhen}
            </div>
          )}
          {mode === 'goal-chase' && (
            <>
              {supervisor.goal.trim() && (
                <div className="sup-panel__goal" title={supervisor.goal}>
                  目标: {supervisor.goal}
                </div>
              )}
              {supervisor.doneWhen.trim() && (
                <div className="sup-panel__goal" title={supervisor.doneWhen}>
                  完成({stopWhenKindLabel(supervisor.stopWhenKind || 'concrete')}):{' '}
                  {supervisor.doneWhen}
                </div>
              )}
            </>
          )}

          <div className="sup-panel__lanes">
            {supervisor.lanes.map((lane) => {
              if (!lane.enabled && !lane.awaitingStopCheck && !lane.stopConfirmed) return null;
              const done = lane.steps.filter((s) => s.status === 'completed').length;
              const open = lane.steps.find(
                (s) => s.status === 'pending' || s.status === 'in_progress',
              );
              return (
                <div key={lane.id} className="sup-panel__lane">
                  <div className="sup-panel__lane-head">
                    <span className="sup-panel__lane-label">{lane.label}</span>
                    <span className="sup-panel__lane-progress">
                      {mode === 'direct'
                        ? `${done}/${lane.steps.length || 0}`
                        : `${lane.autoStepsUsed}/${lane.maxAutoSteps}`}
                    </span>
                  </div>
                  <div className="sup-panel__lane-detail">
                    {lane.workspaceTitle ? `${lane.workspaceTitle} · ` : ''}
                    {lane.surfaceId.slice(0, 14)}…
                    {lane.stopConfirmed
                      ? ' · 已达停止条件'
                      : lane.awaitingStopCheck
                        ? ' · 待核对停止条件'
                        : open
                          ? ` · ${open.status === 'in_progress' ? '执行中' : '待执行'}`
                          : ' · 监控中'}
                  </div>
                  {lane.awaitingStopCheck && !lane.stopConfirmed && (
                    <div className="sup-panel__approval-actions" style={{ marginTop: 6 }}>
                      <button type="button" onClick={() => rejectStopCondition(lane.id)}>
                        未达到
                      </button>
                      <button
                        type="button"
                        className="sup-panel__btn-primary"
                        onClick={() => confirmStopCondition(lane.id)}
                      >
                        {mode === 'goal-chase' ? '已达完成条件' : '已达停止条件'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {supervisor.pendingApprovals.length > 0 && (
            <div className="sup-panel__approvals">
              <div className="sup-panel__approvals-title">待批准</div>
              {supervisor.pendingApprovals.map((a) => (
                <div key={a.id} className="sup-panel__approval">
                  <div className="sup-panel__approval-head">
                    <strong>{a.laneLabel}</strong>
                  </div>
                  <pre className="sup-panel__approval-text">
                    {a.text.slice(0, 400)}
                    {a.text.length > 400 ? '…' : ''}
                  </pre>
                  <div className="sup-panel__approval-actions">
                    <button type="button" onClick={() => rejectPending(a.id)}>
                      拒绝
                    </button>
                    <button
                      type="button"
                      className="sup-panel__btn-primary"
                      onClick={() => onApprove(a.id)}
                    >
                      批准并发送
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {supervisor.log.length > 0 && (
            <div className="sup-panel__log">
              {supervisor.log.slice(0, 6).map((e, i) => (
                <div key={`${e.ts}-${i}`} className="sup-panel__log-line">
                  <span className="sup-panel__log-action">{e.action}</span>
                  <span className="sup-panel__log-detail">
                    {e.laneId !== '-' ? `[${e.laneId}] ` : ''}
                    {e.detail}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="sup-panel__actions">
            <button type="button" onClick={openSupervisorSetup}>
              配置
            </button>
            {supervisor.active ? (
              <button type="button" onClick={() => stopSupervisor()}>
                停止
              </button>
            ) : (
              <button type="button" className="sup-panel__btn-primary" onClick={startSupervisor}>
                启动
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
