import { useState } from 'react';
import { useStore } from '../../store';
import { buildSupervisorBriefing, modeLabel, stopWhenKindLabel, supervisorTabTitle } from '../../supervisor/protocol';
import {
  buildSupervisorLaunchCommand,
  detectSupervisorLauncher,
  supervisorLauncherDisplayName,
} from '../../supervisor/launch-command';
import { sendToSurface, SUPERVISOR_TUI_READY_DELAY_MS } from '../../supervisor/supervisor-engine';
import {
  appendSupervisorRecord,
  formatSupervisorAuditTrail,
  readSupervisorAuditTrail,
} from '../../supervisor/recording';
import { findLeaf, getAllPaneIds } from '../../store/split-utils';
import type { PaneId, SurfaceId, WorkspaceId } from '../../../shared/types';
import { clearSupervisorLaneContext, type SupervisorLane } from '../../store/supervisor-slice';
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
  const setSupervisorLanes = useStore((s) => s.setSupervisorLanes);
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
  const supervisorLauncher = detectSupervisorLauncher(supervisor.supervisorLaunchCmd);
  const supervisorLauncherName = supervisorLauncherDisplayName(supervisorLauncher);
  const supervisorThinkingLabel = supervisorLauncher === 'kimi' ? 'Thinking' : '推理程度';
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
        updateLane(lane.id, {
          awaitingReview: false,
          currentTask: text.trim() || lane.currentTask,
          autoDecisionLimitReached: false,
          autoDecisionsUsed: 0,
        });
        appendSupervisorRecord(supervisor, lane, 'supervisor.proposal.resolved', {
          approvalId: item.id,
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
    updateLane(lane.id, {
      awaitingReview: false,
      autoDecisionLimitReached: false,
      autoDecisionsUsed: 0,
    });
    appendSupervisorRecord(supervisor, lane, 'supervisor.proposal.resolved', {
      approvalId: item.id,
      resolution: 'rejected',
      proposalKind: item.proposalKind || 'important',
    });
    if (lane.supervisorSurfaceId) {
      sendToSurface(lane.supervisorSurfaceId, '[人工决定] 已拒绝该建议；请以当前任务说明和终端证据继续监督，计划文件仅作背景参考。\n', true);
    }
  };

  const onCancel = (id: string) => {
    const item = supervisor.pendingApprovals.find((entry) => entry.id === id);
    rejectPending(id);
    setProposalEdits((current) => {
      const { [id]: _discarded, ...rest } = current;
      return rest;
    });
    if (!item || (item.source !== 'supervisor-route' && item.source !== 'supervisor-important')) return;
    const lane = supervisor.lanes.find((entry) => entry.id === item.laneId);
    if (!lane) return;
    updateLane(lane.id, {
      awaitingReview: false,
      autoDecisionLimitReached: false,
      autoDecisionsUsed: 0,
    });
    appendSupervisorRecord(supervisor, lane, 'supervisor.proposal.resolved', {
      approvalId: item.id,
      resolution: 'handled-manually',
      proposalKind: item.proposalKind || 'important',
    });
    appendSupervisorLog(lane.id, '已取消建议', '由用户在工作终端自行处理');
  };

  const resumeAfterHumanReview = (lane: SupervisorLane) => {
    updateLane(lane.id, {
      awaitingReview: false,
      awaitingStopCheck: false,
      autoDecisionLimitReached: false,
      autoDecisionsUsed: 0,
    });
    appendSupervisorRecord(supervisor, lane, 'supervisor.auto-decision-limit.resolved', {
      resolution: 'human-reviewed',
    });
    appendSupervisorLog(lane.id, '人工已审阅', '自动判断计数已重置，可继续监督');
    if (lane.supervisorSurfaceId) {
      sendToSurface(lane.supervisorSurfaceId, '[人工已介入] 已审阅当前终端。自动判断计数已重置；下一轮结束后可继续裁决。\n', true);
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

  const startFreshSupervisorSession = () => {
    const supervisorLocations = new Map<string, { workspaceId: WorkspaceId; paneId: PaneId }>();
    for (const workspace of workspaces) {
      for (const candidatePaneId of getAllPaneIds(workspace.splitTree)) {
        const pane = findLeaf(workspace.splitTree, candidatePaneId);
        for (const surface of pane?.surfaces || []) {
          supervisorLocations.set(surface.id, { workspaceId: workspace.id, paneId: candidatePaneId });
        }
      }
    }

    const lanesToRestart = supervisor.lanes.map((lane) => ({
      lane,
      location: lane.supervisorSurfaceId ? supervisorLocations.get(lane.supervisorSurfaceId) : undefined,
    }));
    if (lanesToRestart.some(({ location }) => !location)) {
      openSupervisorSetup();
      return;
    }

    const launchCommand = buildSupervisorLaunchCommand(
      supervisor.supervisorLaunchCmd,
      supervisor.supervisorModel,
      supervisor.supervisorReasoningEffort,
    );
    const startupCommands = launchCommand ? [launchCommand] : undefined;
    const replacements: Array<{
      lane: SupervisorLane;
      oldSurfaceId: SurfaceId;
      newSurfaceId: SurfaceId;
      workspaceId: WorkspaceId;
      paneId: PaneId;
    }> = [];

    for (const { lane, location } of lanesToRestart) {
      const newSurfaceId = addSurface(location!.workspaceId, location!.paneId, 'terminal', {
        customTitle: supervisorTabTitle(lane.label),
        cwd: lane.projectDir,
        startupCommands,
        transientSupervisor: true,
      });
      if (!newSurfaceId || !lane.supervisorSurfaceId) {
        for (const replacement of replacements) {
          closeSurface(replacement.workspaceId, replacement.paneId, replacement.newSurfaceId);
        }
        appendSupervisorLog('-', '启动失败', '无法创建新的专属监督 AI；已保留原监督会话');
        openSupervisorSetup();
        return;
      }
      replacements.push({
        lane,
        oldSurfaceId: lane.supervisorSurfaceId,
        newSurfaceId,
        workspaceId: location!.workspaceId,
        paneId: location!.paneId,
      });
    }

    const replacementByLaneId = new Map(replacements.map((item) => [item.lane.id, item.newSurfaceId]));
    setSupervisorLanes(supervisor.lanes.map((lane) =>
      clearSupervisorLaneContext(lane, replacementByLaneId.get(lane.id) || null),
    ));
    for (const replacement of replacements) {
      closeSurface(replacement.workspaceId, replacement.paneId, replacement.oldSurfaceId);
    }

    startSupervisor();
    const sessionId = useStore.getState().supervisor.sessionId;
    window.setTimeout(() => {
      const session = useStore.getState().supervisor;
      if (!session.active || session.sessionId !== sessionId) return;
      const states = (window as any).__wmux_getAgentStates?.() || {};
      for (const lane of session.lanes) {
        if (!lane.supervisorSurfaceId) continue;
        const text = buildSupervisorBriefing(session, {
          lane,
          state: String(states[lane.surfaceId]?.state || 'unknown'),
        });
        sendToSurface(lane.supervisorSurfaceId, text, true);
      }
    }, SUPERVISOR_TUI_READY_DELAY_MS);
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
            <button type="button" className="sup-panel__btn-primary" onClick={missingDedicatedSupervisor ? openSupervisorSetup : startFreshSupervisorSession}>
              {missingDedicatedSupervisor ? '创建 AI' : '启动新会话'}
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
          {modeLabel(mode)} · {enabled.length} 通道{supervisor.autonomous ? ' · 全自动' : ''}
          {pendingCount > 0 ? ` · ${pendingCount} 待批` : ''}
        </span>
      </button>

      {!collapsed && (
        <>
          <div className="sup-panel__freedom">
            {supervisor.autonomous
              ? `全自动监督：AI 可在安全策略范围内推进任务、裁决停止条件并处理明确的低风险权限确认；高风险操作仍会等待人工。`
              : `工作终端由你下达任务；停止条件（${stopWhenKindLabel(supervisor.stopWhenKind || 'concrete')}）由监督 AI 结合证据裁决，不会自动注入。`}
          </div>
          <div className="sup-panel__goal">
            最大自动判断: {supervisor.autonomous ? '全自动会话（不限制）' : supervisor.maxAutoDecisions ? `${supervisor.maxAutoDecisions} 次 / 终端` : '不限制'}
          </div>
          {supervisor.taskDescription.trim() && (
            <div className="sup-panel__goal" title={supervisor.taskDescription}>
              停止补充: {supervisor.taskDescription}
            </div>
          )}
          {supervisor.preconditions.trim() && (
            <div className="sup-panel__goal" title={supervisor.preconditions}>
              前置条件: {supervisor.preconditions}
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
          <div className="sup-panel__goal" title={supervisor.supervisorModel || `${supervisorLauncherName} 默认模型`}>
            监督模型: {supervisor.supervisorModel || `${supervisorLauncherName} 默认模型`}
          </div>
          {(supervisorLauncher === 'codex' || supervisorLauncher === 'kimi') && (
            <div className="sup-panel__goal" title={supervisor.supervisorReasoningEffort || `${supervisorLauncherName} 默认${supervisorThinkingLabel}`}>
              {supervisorThinkingLabel}: {supervisor.supervisorReasoningEffort || '默认'}
            </div>
          )}

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
                      {(lane.decisions || []).length} 次裁决 · 自动 {lane.autoDecisionsUsed || 0}/{supervisor.maxAutoDecisions || '∞'}
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
                  {!!lane.pendingSupervisorDeliveries?.length && (
                    <div className="sup-panel__lane-supervisor">
                      监督通知待投递: {lane.pendingSupervisorDeliveries.length}
                    </div>
                  )}
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
                  {lane.autoDecisionLimitReached && (
                    <div className="sup-panel__approval-actions" style={{ marginTop: 6 }}>
                      <span>已达自动判断上限，请先人工审阅。</span>
                      <button
                        type="button"
                        className="sup-panel__btn-primary"
                        onClick={() => resumeAfterHumanReview(lane)}
                      >
                        我已人工审阅，继续监督
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {supervisor.pendingApprovals.length > 0 && (
            <div className="sup-panel__approvals">
            <div className="sup-panel__approvals-title">需人工处理</div>
              {supervisor.pendingApprovals.map((a) => (
                <div key={a.id} className="sup-panel__approval">
                  <div className="sup-panel__approval-head">
                    <strong>{a.proposalKind === 'route-change' ? '路线变更' : a.proposalKind === 'important' ? '重要建议' : a.laneLabel}</strong>
                    {a.proposalKind && <span>{a.laneLabel}</span>}
                  </div>
                  {a.proposalKind ? (
                    <div className="sup-panel__proposal">
                      <div className="sup-panel__proposal-summary">
                        <div className="sup-panel__proposal-row">
                          <span>当前任务</span>
                          <div>{a.task || '（任务未上报）'}</div>
                        </div>
                        <div className="sup-panel__proposal-row">
                          <span>问题 / 判断依据</span>
                          <div>{a.reason || '未附说明'}</div>
                        </div>
                        <div className="sup-panel__proposal-row sup-panel__proposal-row--next">
                          <span>AI 建议的下一步</span>
                          <div>{a.text || '未提供具体下一步'}</div>
                        </div>
                        {a.impact && (
                          <div className="sup-panel__proposal-row">
                            <span>影响 / 风险</span>
                            <div>{a.impact}</div>
                          </div>
                        )}
                        {a.alternatives && (
                          <div className="sup-panel__proposal-row">
                            <span>备选方案</span>
                            <div>{a.alternatives}</div>
                          </div>
                        )}
                      </div>
                      <label className="sup-panel__proposal-edit">
                        <span>你要发送给任务终端的指令（可修改）</span>
                        <textarea
                          className="sup-panel__proposal-input"
                          value={proposalEdits[a.id] ?? a.text}
                          onChange={(event) => setProposalEdits((current) => ({ ...current, [a.id]: event.target.value }))}
                          placeholder="例如：按上述建议继续，但先补充测试"
                        />
                      </label>
                    </div>
                  ) : (
                    <pre className="sup-panel__approval-text">
                      {a.text.slice(0, 400)}
                      {a.text.length > 400 ? '…' : ''}
                    </pre>
                  )}
                  <div className="sup-panel__approval-actions">
                    {a.proposalKind && (
                      <button type="button" onClick={() => onCancel(a.id)} title="不发送建议；由你在工作终端自行处理">
                        取消
                      </button>
                    )}
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
                onClick={missingDedicatedSupervisor ? openSupervisorSetup : startFreshSupervisorSession}
              >
                {missingDedicatedSupervisor ? '创建专属监督 AI' : '启动新会话'}
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
