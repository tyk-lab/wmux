import { useState } from 'react';
import { useStore } from '../../store';
import { modeLabel, stopWhenKindLabel } from '../../supervisor/protocol';
import { sendToSurface } from '../../supervisor/supervisor-engine';
import {
  appendSupervisorRecord,
  formatSupervisorAuditTrail,
  readSupervisorAuditTrail,
} from '../../supervisor/recording';
import { findLeaf, getAllPaneIds } from '../../store/split-utils';
import type { PaneId, SurfaceId, WorkspaceId } from '../../../shared/types';
import type { SupervisorLane } from '../../store/supervisor-slice';
import '../../styles/supervisor.css';

interface SupervisorPanelProps {
  expanded?: boolean;
  workspaceId?: WorkspaceId;
  paneId?: PaneId;
}

function auditTabTitle(lane: SupervisorLane): string {
  return `监督记录 · ${lane.label} · ${lane.surfaceId.slice(5, 13)}`;
}

export default function SupervisorPanel({ expanded = false, workspaceId, paneId }: SupervisorPanelProps) {
  const supervisor = useStore((s) => s.supervisor);
  const stopSupervisor = useStore((s) => s.stopSupervisor);
  const startSupervisor = useStore((s) => s.startSupervisor);
  const openSupervisorSetup = useStore((s) => s.openSupervisorSetup);
  const approvePending = useStore((s) => s.approvePending);
  const rejectPending = useStore((s) => s.rejectPending);
  const updateStep = useStore((s) => s.updateStep);
  const updateLane = useStore((s) => s.updateLane);
  const appendSupervisorLog = useStore((s) => s.appendSupervisorLog);
  const confirmStopCondition = useStore((s) => s.confirmStopCondition);
  const rejectStopCondition = useStore((s) => s.rejectStopCondition);
  const resetSupervisorSession = useStore((s) => s.resetSupervisorSession);
  const closeSurface = useStore((s) => s.closeSurface);
  const addSurface = useStore((s) => s.addSurface);
  const setMarkdownContent = useStore((s) => s.setMarkdownContent);
  const selectSurface = useStore((s) => s.selectSurface);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const workspaces = useStore((s) => s.workspaces);
  const [collapsed, setCollapsed] = useState(false);
  const [loadingRecordLaneId, setLoadingRecordLaneId] = useState<string | null>(null);
  const [proposalEdits, setProposalEdits] = useState<Record<string, string>>({});

  if (supervisor.lanes.length === 0 && !supervisor.active && !supervisor.supervisorWorkspaceId) return null;

  const enabled = supervisor.lanes.filter((l) => l.enabled);
  const pendingCount = supervisor.pendingApprovals.length;
  const mode = supervisor.mode || 'unified';
  const planFileName = supervisor.planFilePath.split(/[\\/]/).pop() || '';
  const liveSurfaceIds = new Set<string>();
  for (const workspace of workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const pane = findLeaf(workspace.splitTree, paneId);
      for (const surface of pane?.surfaces || []) liveSurfaceIds.add(surface.id);
    }
  }
  const missingDedicatedSupervisor = supervisor.lanes.some(
    (lane) => !lane.supervisorSurfaceId || !liveSurfaceIds.has(lane.supervisorSurfaceId),
  );

  const openSupervisorSession = () => {
    const target = workspaces.find((workspace) => workspace.id === supervisor.supervisorWorkspaceId);
    if (target) {
      const hasSessionView = getAllPaneIds(target.splitTree).some((candidatePaneId) =>
        findLeaf(target.splitTree, candidatePaneId)?.surfaces.some((surface) => surface.type === 'supervisor'),
      );
      if (!hasSessionView) {
        const targetPaneId = getAllPaneIds(target.splitTree)[0];
        if (targetPaneId) addSurface(target.id, targetPaneId, 'supervisor');
      }
      selectWorkspace(target.id);
      return;
    }
    openSupervisorSetup();
  };

  const openAuditTrail = async (lane: SupervisorLane) => {
    setLoadingRecordLaneId(lane.id);
    const trail = await readSupervisorAuditTrail(lane);
    const title = auditTabTitle(lane);
    let target: { workspaceId: WorkspaceId; paneId: PaneId; surfaceId: SurfaceId } | null = null;
    for (const workspace of workspaces) {
      for (const candidatePaneId of getAllPaneIds(workspace.splitTree)) {
        const leaf = findLeaf(workspace.splitTree, candidatePaneId);
        const surface = leaf?.surfaces.find((item) => item.type === 'markdown' && item.customTitle === title);
        if (surface) {
          target = { workspaceId: workspace.id, paneId: candidatePaneId, surfaceId: surface.id };
          break;
        }
      }
      if (target) break;
    }
    if (!target) {
      const targetWorkspaceId = workspaceId || lane.workspaceId;
      const targetPaneId = paneId || lane.paneId;
      if (!targetWorkspaceId || !targetPaneId) {
        appendSupervisorLog(lane.id, '读取记录失败', '找不到可放置记录页的会话窗格');
        setLoadingRecordLaneId(null);
        return;
      }
      const surfaceId = addSurface(targetWorkspaceId, targetPaneId, 'markdown', { customTitle: title });
      if (!surfaceId) {
        appendSupervisorLog(lane.id, '读取记录失败', '无法创建记录页');
        setLoadingRecordLaneId(null);
        return;
      }
      target = { workspaceId: targetWorkspaceId, paneId: targetPaneId, surfaceId };
    }
    setMarkdownContent(target.surfaceId, formatSupervisorAuditTrail(lane, trail), { dirty: false });
    selectWorkspace(target.workspaceId);
    const targetWorkspace = useStore.getState().workspaces.find(
      (workspace) => workspace.id === target!.workspaceId,
    );
    const leaf = targetWorkspace ? findLeaf(targetWorkspace.splitTree, target.paneId) : undefined;
    const index = leaf?.surfaces.findIndex((surface) => surface.id === target!.surfaceId) ?? -1;
    if (index >= 0) selectSurface(target.workspaceId, target.paneId, index);
    setLoadingRecordLaneId(null);
  };

  const onApprove = (id: string) => {
    const item = supervisor.pendingApprovals.find((entry) => entry.id === id);
    if (!item) return;
    try {
      const text = proposalEdits[id] ?? item.text;
      const lane = supervisor.lanes.find((l) => l.id === item.laneId);
      const isHumanProposal = item.source === 'supervisor-route' || item.source === 'supervisor-important';
      if (text.trim()) sendToSurface(item.surfaceId, text, supervisor.submitEnter);
      approvePending(id);
      if (isHumanProposal && lane) {
        updateLane(lane.id, { awaitingReview: false, currentTask: text.trim() || lane.currentTask });
        appendSupervisorRecord(supervisor, lane, 'supervisor.proposal.resolved', {
          resolution: 'approved',
          proposalKind: item.proposalKind || 'important',
          text,
        });
      } else {
        const step = lane?.steps.find((s) => s.status === 'pending');
        if (step) {
          updateStep(item.laneId, step.id, { status: 'in_progress', dispatchedAt: Date.now() });
        }
      }
      appendSupervisorLog(item.laneId, isHumanProposal ? '已批准建议' : '已批准发送', `${item.laneLabel} → ${item.surfaceId}`);
    } catch (err: any) {
      appendSupervisorLog(item.laneId, '发送失败', String(err?.message || err));
    }
  };

  const onReject = (id: string) => {
    const item = supervisor.pendingApprovals.find((entry) => entry.id === id);
    rejectPending(id);
    if (!item || (item.source !== 'supervisor-route' && item.source !== 'supervisor-important')) return;
    const lane = supervisor.lanes.find((entry) => entry.id === item.laneId);
    if (!lane) return;
    updateLane(lane.id, { awaitingReview: false });
    appendSupervisorRecord(supervisor, lane, 'supervisor.proposal.resolved', {
      resolution: 'rejected',
      proposalKind: item.proposalKind || 'important',
    });
    if (lane.supervisorSurfaceId) {
      sendToSurface(lane.supervisorSurfaceId, '[人工决定] 已拒绝该建议；请保持当前任务说明与计划方向继续监督。\n', true);
    }
  };

  const restartFromScratch = () => {
    if (!window.confirm('将关闭所有专属监督 AI，并清空本次任务与裁决记录；历史审计文件会保留。是否继续？')) {
      return;
    }

    for (const lane of supervisor.lanes) {
      appendSupervisorRecord(supervisor, lane, 'session.abandoned', {
        reason: '用户选择重头再来',
      });
      if (lane.supervisorSurfaceId) {
        let location: { workspaceId: WorkspaceId; paneId: PaneId; surfaceCount: number } | null = null;
        for (const workspace of workspaces) {
          for (const paneId of getAllPaneIds(workspace.splitTree)) {
            const pane = findLeaf(workspace.splitTree, paneId);
            if (pane?.surfaces.some((surface) => surface.id === lane.supervisorSurfaceId)) {
              location = { workspaceId: workspace.id, paneId, surfaceCount: pane.surfaces.length };
              break;
            }
          }
          if (location) break;
        }
        if (!location) continue;
        if (location.surfaceCount === 1) {
          const replacement = addSurface(location.workspaceId, location.paneId, 'terminal', {
            cwd: lane.projectDir,
          });
          if (!replacement) continue;
        }
        closeSurface(location.workspaceId, location.paneId, lane.supervisorSurfaceId);
      }
    }
    resetSupervisorSession();
    openSupervisorSetup();
  };

  if (expanded && supervisor.lanes.length === 0 && !supervisor.active) {
    return (
      <div className="sup-panel sup-panel--empty">
        <div className="sup-panel__empty-copy">尚未配置监督任务。</div>
        <div className="sup-panel__actions">
          <button type="button" className="sup-panel__btn-primary" onClick={openSupervisorSetup}>配置 AI 监督</button>
        </div>
      </div>
    );
  }

  if (!expanded) {
    return (
      <div className="sup-panel sup-panel--compact" data-active={supervisor.active ? '1' : '0'}>
        <button type="button" className="sup-panel__header" onClick={openSupervisorSession}>
          <span className="sup-panel__dot" />
          <span className="sup-panel__title">AI 监督</span>
          <span className="sup-panel__status">{supervisor.active ? '运行中' : '已停止'}</span>
          <span className="sup-panel__meta-right">{enabled.length} 通道 · 展开会话</span>
        </button>
        <div className="sup-panel__compact-actions">
          <button type="button" onClick={openSupervisorSession}>打开</button>
          <button type="button" onClick={openSupervisorSetup}>配置</button>
          {supervisor.active ? (
            <button type="button" onClick={() => stopSupervisor()}>停止</button>
          ) : (
            <button type="button" className="sup-panel__btn-primary" onClick={missingDedicatedSupervisor ? openSupervisorSetup : startSupervisor}>
              {missingDedicatedSupervisor ? '创建 AI' : '启动'}
            </button>
          )}
        </div>
      </div>
    );
  }

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
        title={collapsed ? '展开监督会话' : '折叠监督会话'}
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
            工作终端由你下达任务；停止条件（${stopWhenKindLabel(supervisor.stopWhenKind || 'concrete')}）由监督 AI 结合证据裁决，不会自动注入。
          </div>
          {supervisor.taskDescription.trim() && (
            <div className="sup-panel__goal" title={supervisor.taskDescription}>
              任务说明: {supervisor.taskDescription}
            </div>
          )}
          {supervisor.stopWhen.trim() && (
            <div className="sup-panel__goal" title={supervisor.stopWhen}>
              停止({stopWhenKindLabel(supervisor.stopWhenKind || 'concrete')}): {supervisor.stopWhen}
            </div>
          )}
          {planFileName && (
            <div className="sup-panel__goal" title={supervisor.planFilePath}>
              计划: {planFileName}
            </div>
          )}
          <div className="sup-panel__goal" title={supervisor.supervisorModel || 'Codex 默认模型'}>
            监督模型: {supervisor.supervisorModel || 'Codex 默认模型'}
          </div>
          <div className="sup-panel__goal" title={supervisor.supervisorReasoningEffort || 'Codex 默认推理程度'}>
            推理程度: {supervisor.supervisorReasoningEffort || '默认'}
          </div>

          <div className="sup-panel__lanes">
            {supervisor.lanes.map((lane) => {
              if (!lane.enabled && !lane.awaitingStopCheck && !lane.stopConfirmed) return null;
              const open = lane.steps.find(
                (s) => s.status === 'pending' || s.status === 'in_progress',
              );
              return (
                <div key={lane.id} className="sup-panel__lane">
                  <div className="sup-panel__lane-head">
                    <span className="sup-panel__lane-label">{lane.label}</span>
                    <span className="sup-panel__lane-progress">
                      {(lane.decisions || []).length} 次裁决
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
                  <div className="sup-panel__lane-task" title={lane.currentTask || '等待任务上报'}>
                    任务: {lane.currentTask || '等待任务上报'}
                  </div>
                  <div className="sup-panel__lane-supervisor">
                    专属监督: {lane.supervisorSurfaceId ? '已连接' : '未启动'}
                  </div>
                  {lane.restoredFromSessionId && (
                    <div className="sup-panel__lane-supervisor">
                      已恢复审计: {lane.restoredFromSessionId}
                    </div>
                  )}
                  {(lane.decisions || []).length > 0 && (() => {
                    const decision = lane.decisions![0];
                    return (
                      <div className="sup-panel__lane-decision" title={decision.reason || decision.next}>
                        最新裁决：{decision.outcome} · {decision.reason || decision.next || '未附说明'}
                      </div>
                    );
                  })()}
                  <div className="sup-panel__lane-actions">
                    <button type="button" onClick={() => void openAuditTrail(lane)} disabled={loadingRecordLaneId === lane.id}>
                      {loadingRecordLaneId === lane.id ? '读取记录…' : '查看/刷新记录'}
                    </button>
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
                        已达停止条件
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
                    <strong>{a.proposalKind === 'route-change' ? '路线变更' : a.proposalKind === 'important' ? '重要建议' : a.laneLabel}</strong>
                    {a.proposalKind && <span>{a.laneLabel}</span>}
                  </div>
                  {a.proposalKind ? (
                    <div className="sup-panel__proposal">
                      <div><b>当前任务：</b>{a.task || '（任务未上报）'}</div>
                      <div><b>建议：</b>{a.reason || '未附说明'}</div>
                      {a.impact && <div><b>影响：</b>{a.impact}</div>}
                      {a.alternatives && <div><b>备选：</b>{a.alternatives}</div>}
                      <textarea
                        className="sup-panel__proposal-input"
                        value={proposalEdits[a.id] ?? a.text}
                        onChange={(event) => setProposalEdits((current) => ({ ...current, [a.id]: event.target.value }))}
                        placeholder="批准后发送给工作终端的指令（可修改）"
                      />
                    </div>
                  ) : (
                    <pre className="sup-panel__approval-text">
                      {a.text.slice(0, 400)}
                      {a.text.length > 400 ? '…' : ''}
                    </pre>
                  )}
                  <div className="sup-panel__approval-actions">
                    <button type="button" onClick={() => onReject(a.id)}>
                      拒绝
                    </button>
                    <button
                      type="button"
                      className="sup-panel__btn-primary"
                      onClick={() => onApprove(a.id)}
                    >
                      {a.proposalKind ? '批准并发送' : '批准并发送'}
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
              <button
                type="button"
                className="sup-panel__btn-primary"
                onClick={missingDedicatedSupervisor ? openSupervisorSetup : startSupervisor}
              >
                {missingDedicatedSupervisor ? '创建专属监督 AI' : '启动'}
              </button>
            )}
            <button type="button" onClick={restartFromScratch}>
              重头再来
            </button>
          </div>
        </>
      )}
    </div>
  );
}
