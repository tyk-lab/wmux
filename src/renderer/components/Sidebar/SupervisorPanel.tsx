import { useState } from 'react';
import { useStore } from '../../store';
import {
  buildSupervisorBriefing,
  effectiveSupervisorAutonomyPermissions,
  effectiveSupervisorAutonomous,
  effectiveSupervisorForbiddenActions,
  effectiveSupervisorLaneConfig,
  modeLabel,
  stopWhenKindLabel,
  supervisorTabTitle,
} from '../../supervisor/protocol';
import {
  buildSupervisorLaunchCommand,
  detectSupervisorLauncher,
  supervisorLauncherDisplayName,
} from '../../supervisor/launch-command';
import { sendTaskToSurface, sendToSurface, SUPERVISOR_TUI_READY_DELAY_MS } from '../../supervisor/supervisor-engine';
import {
  appendSupervisorRecord,
  formatSupervisorAuditTrail,
  readSupervisorAuditTrail,
} from '../../supervisor/recording';
import { findLeaf, getAllPaneIds } from '../../store/split-utils';
import type { PaneId, SurfaceId, WorkspaceId } from '../../../shared/types';
import {
  DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS,
  DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS,
  DEFAULT_SUPERVISOR_WORK_SCOPE,
  SUPERVISOR_AUTONOMY_PERMISSION_VALUES,
  normalizeSupervisorAutonomyPermissions,
  normalizeSupervisorForbiddenActions,
  normalizeSupervisorWorkScope,
  type SupervisorWorkScope,
} from '../../../shared/supervisor-policy';
import {
  clearSupervisorLaneContext,
  supervisorLaneControlState,
  type SupervisorLane,
} from '../../store/supervisor-slice';
import '../../styles/supervisor.css';

interface SupervisorPanelProps {
  expanded?: boolean;
  workspaceId?: WorkspaceId;
  paneId?: PaneId;
}

function auditTabTitle(lane: SupervisorLane): string {
  return `监督记录 · ${lane.label} · ${lane.surfaceId.slice(5, 13)}`;
}

const WORK_SCOPE_LABELS: Record<SupervisorWorkScope, string> = {
  project: '当前工程文件夹',
  'task-files': '仅当前任务相关文件',
  'plan-defined': '按计划文件定义',
};

export default function SupervisorPanel({ expanded = false, workspaceId, paneId }: SupervisorPanelProps) {
  const supervisor = useStore((s) => s.supervisor);
  const stopSupervisor = useStore((s) => s.stopSupervisor);
  const pauseSupervisorLane = useStore((s) => s.pauseSupervisorLane);
  const resumeSupervisorLane = useStore((s) => s.resumeSupervisorLane);
  const stopSupervisorLane = useStore((s) => s.stopSupervisorLane);
  const startSupervisor = useStore((s) => s.startSupervisor);
  const pauseSupervisor = useStore((s) => s.pauseSupervisor);
  const resumeSupervisor = useStore((s) => s.resumeSupervisor);
  const openSupervisorSetup = useStore((s) => s.openSupervisorSetup);
  const approvePending = useStore((s) => s.approvePending);
  const updateStep = useStore((s) => s.updateStep);
  const updateLane = useStore((s) => s.updateLane);
  const setSupervisorLanes = useStore((s) => s.setSupervisorLanes);
  const patchSupervisor = useStore((s) => s.patchSupervisor);
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
  const [supervisorNotes, setSupervisorNotes] = useState<Record<string, string>>({});

  if (supervisor.lanes.length === 0 && !supervisor.active && !supervisor.supervisorWorkspaceId) return null;

  const enabled = supervisor.lanes.filter((lane) => supervisorLaneControlState(lane) === 'active');
  const pendingCount = supervisor.pendingApprovals.length;
  const mode = supervisor.mode || 'unified';
  const supervisorLauncher = detectSupervisorLauncher(supervisor.supervisorLaunchCmd);
  const supervisorLauncherName = supervisorLauncherDisplayName(supervisorLauncher);
  const supervisorThinkingLabel = supervisorLauncher === 'codex' ? '推理程度' : 'Thinking';
  const autonomyPermissionCount = Array.isArray(supervisor.autonomyPermissions)
    ? supervisor.autonomyPermissions.length
    : DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS.length;
  const forbiddenActionCount = Array.isArray(supervisor.forbiddenActions)
    ? supervisor.forbiddenActions.length
    : DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS.length;
  const workScope = supervisor.workScope || DEFAULT_SUPERVISOR_WORK_SCOPE;
  const liveSurfaceIds = new Set<string>();
  for (const workspace of workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const pane = findLeaf(workspace.splitTree, paneId);
      for (const surface of pane?.surfaces || []) liveSurfaceIds.add(surface.id);
    }
  }
  const missingDedicatedSupervisor = supervisor.lanes.some(
    (lane) => supervisorLaneControlState(lane) !== 'stopped'
      && (!lane.supervisorSurfaceId || !liveSurfaceIds.has(lane.supervisorSurfaceId)),
  );
  let statusLabel = '已停止';
  if (supervisor.active) statusLabel = '运行中';
  else if (supervisor.paused) statusLabel = '已暂停';

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
      if (text.trim()) sendTaskToSurface(item.surfaceId, text, supervisor.submitEnter);
      approvePending(id);
      setProposalEdits((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setSupervisorNotes((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
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

  const onPause = (id: string) => {
    const item = supervisor.pendingApprovals.find((entry) => entry.id === id);
    if (!item) return;
    pauseSupervisorLane(item.laneId, `人工暂停待决项：${item.laneLabel}；该通道决策内容已保留`);
  };

  const sendSupervisorNote = (id: string) => {
    const item = supervisor.pendingApprovals.find((entry) => entry.id === id);
    const lane = item ? supervisor.lanes.find((entry) => entry.id === item.laneId) : undefined;
    const note = supervisorNotes[id]?.trim().slice(0, 4000) || '';
    if (!item || !lane || !lane.supervisorSurfaceId || !note) return;
    try {
      const paused = supervisorLaneControlState(lane) === 'paused';
      sendToSurface(lane.supervisorSurfaceId, [
        '[用户对当前待决项的补充意见]',
        `待决项: ${item.reason || item.text || item.laneLabel}`,
        `补充意见: ${note}`,
        '',
        '这是提供给你的补充上下文，不是发给任务终端的新任务。当前待决项仍由用户决定；不得因此自动发送 --next。',
        paused
          ? '此监督通道已暂停；请记住意见并等待用户继续。'
          : '请用该意见更新你对待决项的理解，然后等待用户决策。',
      ].join('\n'), true);
      setSupervisorNotes((current) => ({ ...current, [id]: '' }));
      appendSupervisorLog(lane.id, '已发送补充意见', '补充信息已发送给该通道的专属监督 AI');
    } catch (err: any) {
      appendSupervisorLog(lane.id, '补充意见发送失败', String(err?.message || err));
    }
  };

  const openTaskTerminalForDecision = (id: string) => {
    const item = supervisor.pendingApprovals.find((entry) => entry.id === id);
    if (!item) return;
    const lane = supervisor.lanes.find((entry) => entry.id === item.laneId);
    if (!lane) return;
    const targetWorkspace = workspaces.find((workspace) => workspace.id === lane.workspaceId)
      || workspaces.find((workspace) => getAllPaneIds(workspace.splitTree).some((candidatePaneId) =>
        findLeaf(workspace.splitTree, candidatePaneId)?.surfaces.some((surface) => surface.id === lane.surfaceId),
      ));
    if (!targetWorkspace) return;
    const targetPaneId = getAllPaneIds(targetWorkspace.splitTree).find((candidatePaneId) =>
      findLeaf(targetWorkspace.splitTree, candidatePaneId)?.surfaces.some((surface) => surface.id === lane.surfaceId),
    );
    if (!targetPaneId) return;
    const targetPane = findLeaf(targetWorkspace.splitTree, targetPaneId);
    const surfaceIndex = targetPane?.surfaces.findIndex((surface) => surface.id === lane.surfaceId) ?? -1;
    if (surfaceIndex < 0) return;
    selectWorkspace(targetWorkspace.id);
    selectSurface(targetWorkspace.id, targetPaneId, surfaceIndex);
    appendSupervisorLog(lane.id, '等待人工裁决', '请在任务终端发送裁决内容；发送后监督会继续运行');
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

  const resumePausedSession = () => {
    if (!supervisor.paused) return;
    if (missingDedicatedSupervisor) {
      openSupervisorSetup();
      return;
    }

    const pendingLaneIds = new Set(supervisor.pendingApprovals.map((item) => item.laneId));
    const cancelledDecisionLaneIds = new Set(supervisor.lanes.filter((lane) => (
      supervisorLaneControlState(lane) === 'active'
      && lane.awaitingReview
      && lane.resumeAfterCancelledDecision
      && !pendingLaneIds.has(lane.id)
    )).map((lane) => lane.id));
    resumeSupervisor();
    for (const lane of supervisor.lanes) {
      if (supervisorLaneControlState(lane) !== 'active'
        || !lane.supervisorSurfaceId
        || pendingLaneIds.has(lane.id)) continue;
      const message = cancelledDecisionLaneIds.has(lane.id)
        ? '[会话继续] 用户已通过任务终端等其他方式发送信息，原待决项已取消。请保持原任务上下文，read-screen 后继续监督。\n'
        : '[会话继续] 用户已恢复当前监督会话。请保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n';
      sendToSurface(lane.supervisorSurfaceId, message, true);
    }
  };

  const pauseActiveSession = () => {
    if (!supervisor.active) return;
    pauseSupervisor('用户手动暂停监督；现有监督终端与会话上下文已保留');
  };

  const closeDedicatedSupervisor = (lane: SupervisorLane): boolean => {
    if (!lane.supervisorSurfaceId) return true;
    for (const workspace of workspaces) {
      for (const candidatePaneId of getAllPaneIds(workspace.splitTree)) {
        const pane = findLeaf(workspace.splitTree, candidatePaneId);
        if (!pane?.surfaces.some((surface) => surface.id === lane.supervisorSurfaceId)) continue;
        if (pane.surfaces.length === 1) {
          const replacement = addSurface(workspace.id, candidatePaneId, 'terminal', { cwd: lane.projectDir });
          if (!replacement) return false;
        }
        closeSurface(workspace.id, candidatePaneId, lane.supervisorSurfaceId);
        return true;
      }
    }
    return true;
  };

  const pauseLane = (lane: SupervisorLane) => {
    pauseSupervisorLane(lane.id, `用户暂停 ${lane.label}；其他监督通道继续运行`);
    appendSupervisorRecord(supervisor, lane, 'supervisor.lane-control', { action: 'pause' });
  };

  const resumeLane = (lane: SupervisorLane) => {
    if (!lane.supervisorSurfaceId || !liveSurfaceIds.has(lane.supervisorSurfaceId)) {
      openSupervisorSetup();
      return;
    }
    resumeSupervisorLane(lane.id, `用户继续 ${lane.label}；其他监督通道状态不变`);
    appendSupervisorRecord(supervisor, lane, 'supervisor.lane-control', { action: 'resume' });
    if (supervisor.active && !supervisor.pendingApprovals.some((item) => item.laneId === lane.id)) {
      sendToSurface(lane.supervisorSurfaceId, '[通道继续] 用户已恢复此监督通道。保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n', true);
    }
  };

  const stopLane = (lane: SupervisorLane) => {
    if (!window.confirm(`将停止“${lane.label}”的监督、关闭其专属监督 AI，并解除与任务终端的绑定；之后可重新选择该终端启动监督，其他通道不受影响。是否继续？`)) return;
    if (!closeDedicatedSupervisor(lane)) {
      window.alert(`无法安全关闭“${lane.label}”的专属监督 AI，该通道未停止。`);
      return;
    }
    appendSupervisorRecord(supervisor, lane, 'supervisor.lane-control', { action: 'stop' });
    stopSupervisorLane(lane.id, `用户停止 ${lane.label} 并解除终端绑定；其他监督通道状态不变`);
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
    if (!launchCommand) {
      appendSupervisorLog('-', '启动失败', '未配置可启动的监督 AI，请先打开配置。');
      openSupervisorSetup();
      return;
    }
    const startupCommands = [launchCommand];
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
        shell: 'pwsh.exe',
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
    const normalizedScope = normalizeSupervisorWorkScope(supervisor.workScope);
    let normalizedDecisionLimit = supervisor.maxAutoDecisions;
    if (normalizedDecisionLimit !== null) {
      normalizedDecisionLimit = Number.isFinite(normalizedDecisionLimit) && normalizedDecisionLimit >= 1
        ? Math.min(20, Math.floor(normalizedDecisionLimit))
        : 1;
    }
    patchSupervisor({
      mode: 'unified',
      autonomous: false,
      autonomyPermissions: normalizeSupervisorAutonomyPermissions(supervisor.autonomyPermissions),
      workScope: normalizedScope === 'plan-defined' && supervisor.lanes.some(
        (lane) => !effectiveSupervisorLaneConfig(supervisor, lane).planFilePath.trim(),
      )
        ? 'task-files'
        : normalizedScope,
      forbiddenActions: normalizeSupervisorForbiddenActions(supervisor.forbiddenActions),
      taskGoal: supervisor.taskGoal?.trim()
        || supervisor.goal?.trim()
        || supervisor.directInstructions?.trim()
        || '',
      stopWhen: supervisor.stopWhen?.trim() || supervisor.doneWhen?.trim() || '',
      directInstructions: '',
      goal: '',
      allowPaths: '',
      denyNotes: '',
      doneWhen: '',
      maxAutoSteps: 0,
      maxAutoDecisions: normalizedDecisionLimit,
    });
    setSupervisorLanes(supervisor.lanes.map((lane) =>
      ({
        ...clearSupervisorLaneContext(lane, replacementByLaneId.get(lane.id) || null),
        autonomousOverride: undefined,
      }),
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
      <div
        className="sup-panel sup-panel--compact"
        data-active={supervisor.active ? '1' : '0'}
        data-paused={supervisor.paused ? '1' : '0'}
      >
        <button type="button" className="sup-panel__header" onClick={openSupervisorSession}>
          <span className="sup-panel__dot" />
          <span className="sup-panel__title">AI 监督</span>
          <span className="sup-panel__status">{statusLabel}</span>
          <span className="sup-panel__meta-right">{enabled.length} 通道 · 展开会话</span>
        </button>
        <div className="sup-panel__compact-actions">
          <button type="button" onClick={openSupervisorSession}>打开</button>
          <button type="button" onClick={openSupervisorSetup}>配置</button>
          {supervisor.active && (
            <>
              <button type="button" onClick={pauseActiveSession}>暂停监督</button>
              <button type="button" onClick={() => stopSupervisor()}>停止监督</button>
            </>
          )}
          {!supervisor.active && supervisor.paused && (
            <button type="button" className="sup-panel__btn-primary" onClick={resumePausedSession}>
              {missingDedicatedSupervisor ? '专属 AI 已缺失' : '继续监督'}
            </button>
          )}
          {!supervisor.active && !supervisor.paused && (
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
      data-paused={supervisor.paused ? '1' : '0'}
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
        <span className="sup-panel__status">{statusLabel}</span>
        <span className="sup-panel__meta-right">
          {modeLabel(mode)} · {enabled.length} 通道{supervisor.autonomous ? ' · 全自动' : ''}
          {pendingCount > 0 ? ` · ${pendingCount} 待批` : ''}
        </span>
      </button>

      {!collapsed && (
        <>
          {supervisor.paused && (
            <div className="sup-panel__paused-notice">
              {missingDedicatedSupervisor
                ? '会话已暂停，但专属监督终端已缺失；请停止后重新配置。'
                : '会话已暂停；任务上下文、监督终端和待决项均已保留。点击“继续监督”即可恢复。'}
            </div>
          )}
          <div className="sup-panel__freedom">
            {supervisor.autonomous ? '全自动监督' : '有限自主监督'}：已授予 {autonomyPermissionCount}/{SUPERVISOR_AUTONOMY_PERMISSION_VALUES.length} 项自主权限；
            工作范围为“{WORK_SCOPE_LABELS[workScope]}”，另有 {forbiddenActionCount} 项禁止事项。硬风险始终等待人工。
          </div>
          <div className="sup-panel__goal">
            最大自动判断: {supervisor.autonomous ? '全自动会话（不限制）' : supervisor.maxAutoDecisions ? `${supervisor.maxAutoDecisions} 次 / 终端` : '不限制'}
          </div>
          <div className="sup-panel__goal" title={supervisor.supervisorModel || `${supervisorLauncherName} 默认模型`}>
            监督模型: {supervisor.supervisorModel || `${supervisorLauncherName} 默认模型`}
          </div>
          {(supervisorLauncher === 'codex' || supervisorLauncher === 'kimi' || supervisorLauncher === 'pi') && (
            <div className="sup-panel__goal" title={supervisor.supervisorReasoningEffort || `${supervisorLauncherName} 默认${supervisorThinkingLabel}`}>
              {supervisorThinkingLabel}: {supervisor.supervisorReasoningEffort || '默认'}
            </div>
          )}

          <div className="sup-panel__lanes">
            {supervisor.lanes.map((lane) => {
              const laneControlState = supervisorLaneControlState(lane);
              const laneConfig = effectiveSupervisorLaneConfig(supervisor, lane);
              const lanePermissions = effectiveSupervisorAutonomyPermissions(supervisor, lane);
              const laneAutonomous = effectiveSupervisorAutonomous(supervisor, lane);
              const laneForbiddenActions = effectiveSupervisorForbiddenActions(supervisor, lane);
              const lanePolicyOverridden = Array.isArray(lane.autonomyPermissionsOverride)
                || typeof lane.autonomousOverride === 'boolean'
                || Array.isArray(lane.forbiddenActionsOverride);
              const planFileName = laneConfig.planFilePath.split(/[\\/]/).pop() || '';
              const open = lane.steps.find(
                (s) => s.status === 'pending' || s.status === 'in_progress',
              );
              return (
                <div key={lane.id} className="sup-panel__lane">
                  <div className="sup-panel__lane-head">
                    <span className="sup-panel__lane-label">{lane.label}</span>
                    <span className="sup-panel__lane-progress">
                      {laneControlState === 'active' ? '监督中' : laneControlState === 'paused' ? '已暂停' : '已停止'}
                      {' · '}{(lane.decisions || []).length} 次裁决 · 自动 {lane.autoDecisionsUsed || 0}/{supervisor.maxAutoDecisions || '∞'}
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
                  {laneConfig.taskGoal && (
                    <div className="sup-panel__lane-task" title={laneConfig.taskGoal}>
                      目标: {laneConfig.taskGoal}
                    </div>
                  )}
                  <div className="sup-panel__lane-task" title={laneConfig.stopWhen}>
                    停止({stopWhenKindLabel(laneConfig.stopWhenKind)}): {laneConfig.stopWhen}
                  </div>
                  {laneConfig.taskDescription && (
                    <div className="sup-panel__lane-task" title={laneConfig.taskDescription}>
                      停止补充: {laneConfig.taskDescription}
                    </div>
                  )}
                  {laneConfig.preconditions && (
                    <div className="sup-panel__lane-task" title={laneConfig.preconditions}>
                      前置条件: {laneConfig.preconditions}
                    </div>
                  )}
                  {planFileName && (
                    <div className="sup-panel__lane-task" title={laneConfig.planFilePath}>
                      计划: {planFileName}
                    </div>
                  )}
                  <div className="sup-panel__lane-supervisor">
                    专属监督: {lane.supervisorSurfaceId ? '已连接' : '未启动'}
                    {lane.managementSessionId ? ` · 会话 ${lane.managementSessionId.slice(-8)}` : ''}
                  </div>
                  <div className="sup-panel__lane-supervisor">
                    权限: {laneAutonomous ? '全自动' : '有限自主'} · 允许 {lanePermissions.length}/{SUPERVISOR_AUTONOMY_PERMISSION_VALUES.length} · 禁止 {laneForbiddenActions.length}
                    {lanePolicyOverridden ? '（终端专用）' : '（会话默认）'}
                  </div>
                  {lane.restoredFromSessionId && (
                    <div className="sup-panel__lane-supervisor">
                      已恢复审计: {lane.restoredFromSessionId}
                    </div>
                  )}
                  {(lane.decisions || []).length > 0 && (() => {
                    const decision = lane.decisions![0];
                    const decisionKindLabels: Record<string, string> = {
                      'route-adjustment': ' · 小范围路线调整',
                      'route-change': ' · 路线变更',
                      important: ' · 重要建议',
                    };
                    const decisionKind = decision.proposalKind ? decisionKindLabels[decision.proposalKind] : '';
                    return (
                      <div className="sup-panel__lane-decision" title={decision.reason || decision.next}>
                        最新裁决：{decision.outcome}{decisionKind} · {decision.reason || decision.next || '未附说明'}
                      </div>
                    );
                  })()}
                  <div className="sup-panel__lane-actions">
                    {laneControlState === 'active' && (
                      <button type="button" onClick={() => pauseLane(lane)} disabled={!supervisor.active}>
                        暂停此监督
                      </button>
                    )}
                    {laneControlState === 'paused' && (
                      <button type="button" onClick={() => resumeLane(lane)} disabled={!supervisor.active}>
                        继续此监督
                      </button>
                    )}
                    {laneControlState !== 'stopped' && (
                      <button type="button" onClick={() => stopLane(lane)}>
                        停止此监督
                      </button>
                    )}
                    <button type="button" onClick={() => void openAuditTrail(lane)} disabled={loadingRecordLaneId === lane.id}>
                      {loadingRecordLaneId === lane.id ? '读取记录…' : '查看/刷新记录'}
                    </button>
                  </div>
                  {lane.awaitingStopCheck && !lane.stopConfirmed && (
                    <div className="sup-panel__approval-actions" style={{ marginTop: 6 }}>
                      <button type="button" onClick={() => rejectStopCondition(lane.id)} disabled={!supervisor.active}>
                        未达到
                      </button>
                      <button
                        type="button"
                        className="sup-panel__btn-primary"
                        onClick={() => confirmStopCondition(lane.id)}
                        disabled={!supervisor.active}
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
                        disabled={!supervisor.active}
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
              {supervisor.pendingApprovals.map((a) => {
                const lane = supervisor.lanes.find((entry) => entry.id === a.laneId);
                const laneControlState = lane ? supervisorLaneControlState(lane) : 'stopped';
                const note = supervisorNotes[a.id] || '';
                return (
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
                          disabled={!supervisor.active}
                        />
                      </label>
                    </div>
                  ) : (
                    <pre className="sup-panel__approval-text">
                      {a.text.slice(0, 400)}
                      {a.text.length > 400 ? '…' : ''}
                    </pre>
                  )}
                  <label className="sup-panel__proposal-edit sup-panel__proposal-note">
                    <span>给 AI 监督的补充意见（可选）</span>
                    <textarea
                      className="sup-panel__proposal-input"
                      value={note}
                      maxLength={4000}
                      onChange={(event) => setSupervisorNotes((current) => ({ ...current, [a.id]: event.target.value }))}
                      placeholder="例如：优先保持现有 API，暂时不引入新依赖"
                      disabled={!supervisor.active || laneControlState === 'stopped' || !lane?.supervisorSurfaceId}
                    />
                  </label>
                  <div className="sup-panel__approval-actions">
                    <button
                      type="button"
                      onClick={() => sendSupervisorNote(a.id)}
                      disabled={!supervisor.active || laneControlState === 'stopped' || !lane?.supervisorSurfaceId || !note.trim()}
                    >
                      发送补充意见给 AI 监督
                    </button>
                  </div>
                  <div className="sup-panel__approval-actions">
                    {a.proposalKind && (
                      <button
                        type="button"
                        onClick={() => openTaskTerminalForDecision(a.id)}
                        title="切换到对应任务终端；发送的信息将作为人工裁决记录"
                        disabled={!supervisor.active}
                      >
                        去任务终端裁决
                      </button>
                    )}
                    {laneControlState === 'paused' ? (
                      <button
                        type="button"
                        onClick={() => lane && resumeLane(lane)}
                        title="保留当前待决项并继续此监督通道"
                        disabled={!supervisor.active || !lane}
                      >
                        继续此监督
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onPause(a.id)}
                        title="保留当前待决项并暂停此监督通道"
                        disabled={!supervisor.active || laneControlState === 'stopped'}
                      >
                        暂停此监督
                      </button>
                    )}
                    <button
                      type="button"
                      className="sup-panel__btn-primary"
                      onClick={() => onApprove(a.id)}
                      disabled={!supervisor.active}
                    >
                      批准并发送
                    </button>
                  </div>
                </div>
                );
              })}
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
            {supervisor.active && (
              <>
                <button type="button" onClick={pauseActiveSession}>
                  暂停监督
                </button>
                <button type="button" onClick={() => stopSupervisor()}>
                  停止监督
                </button>
              </>
            )}
            {!supervisor.active && supervisor.paused && (
              <button
                type="button"
                className="sup-panel__btn-primary"
                onClick={resumePausedSession}
              >
                {missingDedicatedSupervisor ? '专属 AI 已缺失' : '继续监督'}
              </button>
            )}
            {!supervisor.active && !supervisor.paused && (
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
