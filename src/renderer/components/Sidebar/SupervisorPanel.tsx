import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import {
  buildSupervisorBriefing,
  effectiveSupervisorAutonomyPermissions,
  effectiveSupervisorAutonomous,
  effectiveSupervisorForbiddenActions,
  effectiveSupervisorLaneConfig,
  effectiveSupervisorWorkScope,
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
  buildAdoptedPlanBriefing,
  supervisorDecisionOptions,
} from '../../supervisor/decision-options';
import {
  appendSupervisorRecord,
  formatSupervisorAuditTrail,
  readSupervisorAuditTrail,
} from '../../supervisor/recording';
import { announceSupervisorWaitingForDirection } from '../../supervisor/waiting-notification';
import { findLeaf, getAllPaneIds } from '../../store/split-utils';
import type { PaneId, SurfaceId, WorkspaceId } from '../../../shared/types';
import {
  normalizeTaskChildThreadResponsibilities,
  normalizeTaskWorkMode,
} from '../../../shared/supervisor-work-mode';
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
  dedicatedSupervisorSurfaceId,
  isProjectManagedSupervisorLane,
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
  const stopOrdinarySupervisor = useStore((s) => s.stopOrdinarySupervisor);
  const pauseSupervisorLane = useStore((s) => s.pauseSupervisorLane);
  const resumeSupervisorLane = useStore((s) => s.resumeSupervisorLane);
  const stopSupervisorLane = useStore((s) => s.stopSupervisorLane);
  const startOrdinarySupervisor = useStore((s) => s.startOrdinarySupervisor);
  const pauseOrdinarySupervisor = useStore((s) => s.pauseOrdinarySupervisor);
  const resumeOrdinarySupervisor = useStore((s) => s.resumeOrdinarySupervisor);
  const openSupervisorSetup = useStore((s) => s.openSupervisorSetup);
  const approvePending = useStore((s) => s.approvePending);
  const updateLane = useStore((s) => s.updateLane);
  const setOrdinarySupervisorLanes = useStore((s) => s.setOrdinarySupervisorLanes);
  const patchSupervisor = useStore((s) => s.patchSupervisor);
  const appendSupervisorLog = useStore((s) => s.appendSupervisorLog);
  const confirmStopCondition = useStore((s) => s.confirmStopCondition);
  const rejectStopCondition = useStore((s) => s.rejectStopCondition);
  const resetOrdinarySupervisorSession = useStore((s) => s.resetOrdinarySupervisorSession);
  const closeSurface = useStore((s) => s.closeSurface);
  const addSurface = useStore((s) => s.addSurface);
  const setMarkdownContent = useStore((s) => s.setMarkdownContent);
  const selectSurface = useStore((s) => s.selectSurface);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const workspaces = useStore((s) => s.workspaces);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedStoppedLaneIds, setExpandedStoppedLaneIds] = useState<Set<string>>(() => new Set());
  const [loadingRecordLaneId, setLoadingRecordLaneId] = useState<string | null>(null);
  const [proposalEdits, setProposalEdits] = useState<Record<string, string>>({});
  const [proposalSelections, setProposalSelections] = useState<Record<string, string>>({});

  useEffect(() => {
    const stoppedLaneIds = new Set(
      supervisor.lanes.filter((lane) => lane.stopConfirmed).map((lane) => lane.id),
    );
    setExpandedStoppedLaneIds((current) => {
      const retained = new Set([...current].filter((laneId) => stoppedLaneIds.has(laneId)));
      return retained.size === current.size ? current : retained;
    });
  }, [supervisor.lanes]);

  if (supervisor.lanes.length === 0 && !supervisor.active && !supervisor.supervisorWorkspaceId) return null;

  const ordinaryLanes = supervisor.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane));
  const projectLanes = supervisor.lanes.filter(isProjectManagedSupervisorLane);
  const enabled = supervisor.lanes.filter((lane) => supervisorLaneControlState(lane) === 'active');
  const waiting = supervisor.lanes.filter((lane) => supervisorLaneControlState(lane) === 'waiting');
  const ordinaryEnabled = ordinaryLanes.filter((lane) => supervisorLaneControlState(lane) === 'active');
  const ordinaryWaiting = ordinaryLanes.filter((lane) => supervisorLaneControlState(lane) === 'waiting');
  const ordinaryPaused = ordinaryLanes.filter((lane) => supervisorLaneControlState(lane) === 'paused');
  const projectWaiting = projectLanes.filter((lane) => supervisorLaneControlState(lane) === 'waiting');
  const ordinaryRetained = ordinaryLanes.some((lane) => supervisorLaneControlState(lane) !== 'stopped');
  const projectManaged = projectLanes.length > 0;
  const visiblePendingApprovals = supervisor.pendingApprovals.filter((approval) => (
    !supervisor.lanes.some((lane) => (
      lane.id === approval.laneId && isProjectManagedSupervisorLane(lane)
    ))
  ));
  const pendingCount = visiblePendingApprovals.length;
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
    (lane) => {
      const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
      return !isProjectManagedSupervisorLane(lane)
        && supervisorLaneControlState(lane) !== 'stopped'
        && (!supervisorSurfaceId || !liveSurfaceIds.has(supervisorSurfaceId));
    },
  );
  let statusLabel = '已停止';
  if (supervisor.active) {
    statusLabel = enabled.length === 0 && waiting.length > 0
      ? '待续'
      : waiting.length > 0
        ? `运行中 · ${waiting.length} 待续`
        : '运行中';
  }
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
      const lane = supervisor.lanes.find((l) => l.id === item.laneId);
      const isHumanProposal = item.source === 'supervisor-route' || item.source === 'supervisor-important';
      const isContextRecovery = item.source === 'supervisor-context-recovery';
      let adoptedPlan = '';
      if (isContextRecovery) {
        if (!lane || supervisorLaneControlState(lane) !== 'active' || !item.text.trim()) return;
        sendTaskToSurface(item.surfaceId, item.text, supervisor.submitEnter);
      } else if (isHumanProposal) {
        const supervisorSurfaceId = lane ? dedicatedSupervisorSurfaceId(lane) : null;
        const choices = supervisorDecisionOptions(item.alternatives, item.text);
        const selected = choices.find((choice) => choice.value === proposalSelections[id]);
        if (!lane || supervisorLaneControlState(lane) !== 'active' || !supervisorSurfaceId || !selected) return;
        adoptedPlan = `${selected.value}：${selected.detail}`;
        sendToSurface(supervisorSurfaceId, buildAdoptedPlanBriefing({
          surfaceId: item.surfaceId,
          selection: selected,
          recommendation: item.text,
          reason: item.reason,
          impact: item.impact,
          alternatives: item.alternatives,
        }), true);
      } else if (item.text.trim()) {
        sendTaskToSurface(item.surfaceId, item.text, supervisor.submitEnter);
      }
      approvePending(id);
      setProposalSelections((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setProposalEdits((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (isContextRecovery && lane) {
        updateLane(lane.id, {
          contextRecoveryStatus: 'sent',
          awaitingReview: false,
          currentTask: item.text.trim(),
          autoDecisionLimitReached: false,
          autoDecisionsUsed: 0,
        });
        appendSupervisorRecord(supervisor, lane, 'supervisor.proposal.resolved', {
          approvalId: item.id,
          resolution: 'approved',
          proposalKind: 'context-recovery',
          text: item.text.trim(),
        });
      } else if (isHumanProposal && lane) {
        updateLane(lane.id, {
          awaitingReview: true,
          autoDecisionLimitReached: false,
          autoDecisionsUsed: 0,
        });
        appendSupervisorRecord(supervisor, lane, 'supervisor.proposal.resolved', {
          approvalId: item.id,
          resolution: 'approved',
          proposalKind: item.proposalKind || 'important',
          text: adoptedPlan,
        });
      }
      appendSupervisorLog(
        item.laneId,
        isContextRecovery ? '已确认并发送上下文恢复指令' : isHumanProposal ? '已采用 AI 方案' : '已批准发送',
        `${item.laneLabel} → ${item.surfaceId}`,
      );
    } catch (err: any) {
      appendSupervisorLog(item.laneId, '发送失败', String(err?.message || err));
    }
  };

  const onDirectSend = (id: string) => {
    const item = supervisor.pendingApprovals.find((entry) => entry.id === id);
    const lane = item ? supervisor.lanes.find((entry) => entry.id === item.laneId) : undefined;
    const text = proposalEdits[id]?.trim() || '';
    if (!item || !lane || supervisorLaneControlState(lane) !== 'active' || !text) return;
    try {
      sendTaskToSurface(item.surfaceId, text, supervisor.submitEnter);
      approvePending(id);
      setProposalEdits((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setProposalSelections((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      updateLane(lane.id, {
        awaitingReview: false,
        currentTask: text,
        autoDecisionLimitReached: false,
        autoDecisionsUsed: 0,
      });
      appendSupervisorRecord(supervisor, lane, 'supervisor.proposal.resolved', {
        approvalId: item.id,
        resolution: 'handled-manually',
        proposalKind: item.proposalKind || 'important',
        text,
      });
      appendSupervisorLog(item.laneId, '已直接发送用户决策', `${item.laneLabel} → ${item.surfaceId}`);
    } catch (err: any) {
      appendSupervisorLog(item.laneId, '发送失败', String(err?.message || err));
    }
  };

  const onPause = (id: string) => {
    const item = supervisor.pendingApprovals.find((entry) => entry.id === id);
    if (!item) return;
    pauseSupervisorLane(item.laneId, `人工暂停待决项：${item.laneLabel}；该通道决策内容已保留`);
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
    const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
    if (supervisorSurfaceId) {
      sendToSurface(supervisorSurfaceId, '[人工已介入] 已审阅当前终端。自动判断计数已重置；下一轮结束后可继续裁决。\n', true);
    }
  };

  const resumePausedSession = () => {
    if (ordinaryPaused.length === 0) return;
    if (missingDedicatedSupervisor) {
      openSupervisorSetup();
      return;
    }

    const pendingLaneIds = new Set(supervisor.pendingApprovals.map((item) => item.laneId));
    const cancelledDecisionLaneIds = new Set(ordinaryLanes.filter((lane) => (
      supervisorLaneControlState(lane) === 'paused'
      && lane.awaitingReview
      && lane.resumeAfterCancelledDecision
      && !pendingLaneIds.has(lane.id)
    )).map((lane) => lane.id));
    resumeOrdinarySupervisor();
    const resumedSession = useStore.getState().supervisor;
    for (const lane of resumedSession.lanes.filter((candidate) => !isProjectManagedSupervisorLane(candidate))) {
      const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
      if (supervisorLaneControlState(lane) !== 'active'
        || !supervisorSurfaceId
        || pendingLaneIds.has(lane.id)) continue;
      const message = cancelledDecisionLaneIds.has(lane.id)
        ? '[会话继续] 用户已通过任务终端等其他方式发送信息，原待决项已取消。请保持原任务上下文，read-screen 后继续监督。\n'
        : '[会话继续] 用户已恢复当前监督会话。请保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n';
      sendToSurface(supervisorSurfaceId, message, true);
    }
  };

  const pauseActiveSession = () => {
    if (ordinaryEnabled.length === 0) return;
    pauseOrdinarySupervisor('用户手动暂停普通监督；项目监督状态不变');
  };

  const closeDedicatedSupervisor = (lane: SupervisorLane): boolean => {
    const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
    if (!supervisorSurfaceId) return true;
    for (const workspace of workspaces) {
      for (const candidatePaneId of getAllPaneIds(workspace.splitTree)) {
        const pane = findLeaf(workspace.splitTree, candidatePaneId);
        if (!pane?.surfaces.some((surface) => surface.id === supervisorSurfaceId)) continue;
        if (pane.surfaces.length === 1) {
          const replacement = addSurface(workspace.id, candidatePaneId, 'terminal', { cwd: lane.projectDir });
          if (!replacement) return false;
        }
        closeSurface(workspace.id, candidatePaneId, supervisorSurfaceId);
        return true;
      }
    }
    return true;
  };

  const pauseLane = (lane: SupervisorLane) => {
    if (isProjectManagedSupervisorLane(lane)) return;
    pauseSupervisorLane(lane.id, `用户暂停 ${lane.label}；其他监督通道继续运行`);
    appendSupervisorRecord(supervisor, lane, 'supervisor.lane-control', { action: 'pause' });
  };

  const resumeLane = (lane: SupervisorLane) => {
    if (isProjectManagedSupervisorLane(lane)) return;
    const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
    if (!supervisorSurfaceId || !liveSurfaceIds.has(supervisorSurfaceId)) {
      openSupervisorSetup();
      return;
    }
    resumeSupervisorLane(lane.id, `用户继续 ${lane.label}；其他监督通道状态不变`);
    appendSupervisorRecord(supervisor, lane, 'supervisor.lane-control', { action: 'resume' });
    if (supervisor.active && !supervisor.pendingApprovals.some((item) => item.laneId === lane.id)) {
      sendToSurface(supervisorSurfaceId, '[通道继续] 用户已恢复此监督通道。保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n', true);
    }
  };

  const stopLane = (lane: SupervisorLane) => {
    if (isProjectManagedSupervisorLane(lane)) return;
    if (!window.confirm(`将停止“${lane.label}”的监督、关闭其专属监督 AI，并解除与任务终端的绑定；之后可重新选择该终端启动监督，其他通道不受影响。是否继续？`)) return;
    if (!closeDedicatedSupervisor(lane)) {
      window.alert(`无法安全关闭“${lane.label}”的专属监督 AI，该通道未停止。`);
      return;
    }
    appendSupervisorRecord(supervisor, lane, 'supervisor.lane-control', { action: 'stop' });
    stopSupervisorLane(lane.id, `用户停止 ${lane.label} 并解除终端绑定；其他监督通道状态不变`);
  };

  const restartFromScratch = () => {
    if (!window.confirm('将关闭所有普通监督 AI，并清空普通监督任务与裁决记录；项目监督和历史审计文件不受影响。是否继续？')) {
      return;
    }

    for (const lane of ordinaryLanes) {
      appendSupervisorRecord(supervisor, lane, 'session.abandoned', {
        reason: '用户选择重头再来',
      });
      const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
      if (supervisorSurfaceId) {
        let location: { workspaceId: WorkspaceId; paneId: PaneId; surfaceCount: number } | null = null;
        for (const workspace of workspaces) {
          for (const paneId of getAllPaneIds(workspace.splitTree)) {
            const pane = findLeaf(workspace.splitTree, paneId);
            if (pane?.surfaces.some((surface) => surface.id === supervisorSurfaceId)) {
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
        closeSurface(location.workspaceId, location.paneId, supervisorSurfaceId);
      }
    }
    resetOrdinarySupervisorSession();
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

    const lanesToRestart = ordinaryLanes.map((lane) => {
      const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
      return {
        lane,
        supervisorSurfaceId,
        location: supervisorSurfaceId ? supervisorLocations.get(supervisorSurfaceId) : undefined,
      };
    });
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

    for (const { lane, supervisorSurfaceId, location } of lanesToRestart) {
      const newSurfaceId = addSurface(location!.workspaceId, location!.paneId, 'terminal', {
        customTitle: supervisorTabTitle(lane.label),
        shell: 'pwsh.exe',
        cwd: lane.projectDir,
        startupCommands,
        transientSupervisor: true,
      });
      if (!newSurfaceId || !supervisorSurfaceId) {
        for (const replacement of replacements) {
          closeSurface(replacement.workspaceId, replacement.paneId, replacement.newSurfaceId);
        }
        appendSupervisorLog('-', '启动失败', '无法创建新的专属监督 AI；已保留原监督会话');
        openSupervisorSetup();
        return;
      }
      replacements.push({
        lane,
        oldSurfaceId: supervisorSurfaceId,
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
      autonomous: false,
      autonomyPermissions: normalizeSupervisorAutonomyPermissions(supervisor.autonomyPermissions),
      workScope: normalizedScope === 'plan-defined' && ordinaryLanes.some(
        (lane) => !effectiveSupervisorLaneConfig(lane).planFilePath.trim(),
      )
        ? 'task-files'
        : normalizedScope,
      forbiddenActions: normalizeSupervisorForbiddenActions(supervisor.forbiddenActions),
      maxAutoDecisions: normalizedDecisionLimit,
    });
    setOrdinarySupervisorLanes(ordinaryLanes.map((lane) =>
      ({
        ...clearSupervisorLaneContext(lane, replacementByLaneId.get(lane.id) || null),
        autonomousOverride: undefined,
      }),
    ));
    for (const replacement of replacements) {
      closeSurface(replacement.workspaceId, replacement.paneId, replacement.oldSurfaceId);
    }

    startOrdinarySupervisor();
    const sessionId = useStore.getState().supervisor.sessionId;
    window.setTimeout(() => {
      const session = useStore.getState().supervisor;
      if (!session.active || session.sessionId !== sessionId) return;
      const states = (window as any).__wmux_getAgentStates?.() || {};
      for (const lane of session.lanes.filter((candidate) => !isProjectManagedSupervisorLane(candidate))) {
        const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
        if (!supervisorSurfaceId) continue;
        const text = buildSupervisorBriefing(session, {
          lane,
          state: String(states[lane.surfaceId]?.state || 'unknown'),
        });
        sendToSurface(supervisorSurfaceId, text, true);
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
          <button type="button" onClick={openSupervisorSetup}>配置普通监督</button>
          {ordinaryEnabled.length > 0 && (
            <button type="button" onClick={pauseActiveSession}>暂停普通监督</button>
          )}
          {ordinaryRetained && (
            <button type="button" onClick={() => stopOrdinarySupervisor()}>停止普通监督</button>
          )}
          {ordinaryPaused.length > 0 && (
            <button type="button" className="sup-panel__btn-primary" onClick={resumePausedSession}>
              {missingDedicatedSupervisor ? '专属 AI 已缺失' : '继续监督'}
            </button>
          )}
          {!ordinaryRetained && (
            <button
              type="button"
              className="sup-panel__btn-primary"
              onClick={ordinaryLanes.length === 0 || missingDedicatedSupervisor ? openSupervisorSetup : startFreshSupervisorSession}
            >
              {ordinaryLanes.length === 0 || missingDedicatedSupervisor ? '配置普通监督' : '启动普通监督新会话'}
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
      data-waiting={waiting.length > 0 ? '1' : '0'}
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
          {enabled.length} 通道{waiting.length > 0 ? ` · ${waiting.length} 待续` : ''}{supervisor.autonomous ? ' · 全自动' : ''}
          {pendingCount > 0 ? ` · ${pendingCount} 待批` : ''}
        </span>
      </button>

      {!collapsed && (
        <>
          {ordinaryPaused.length > 0 && (
            <div className="sup-panel__paused-notice">
              {missingDedicatedSupervisor
                ? '会话已暂停，但专属监督终端已缺失；请停止后重新配置。'
                : '会话已暂停；任务上下文、监督终端和待决项均已保留。点击“继续监督”即可恢复。'}
            </div>
          )}
          {ordinaryWaiting.length > 0 && (
            <div className="sup-panel__waiting-notice" role="status">
              当前有 {ordinaryWaiting.length} 个普通监督通道处于待续状态，正在等待用户提供新方案或下一步方向。
            </div>
          )}
          {projectWaiting.length > 0 && (
            <div className="sup-panel__waiting-notice" role="status">
              当前有 {projectWaiting.length} 个项目监督通道待续，由对应项目管理 AI 处理，不需要用户在普通监督中介入。
            </div>
          )}
          {ordinaryLanes.length > 0 && (
            <div className="sup-panel__freedom">
              {supervisor.autonomous ? '普通全自动监督' : '普通有限自主监督'}：已授予 {autonomyPermissionCount}/{SUPERVISOR_AUTONOMY_PERMISSION_VALUES.length} 项自主权限；
              工作范围为“{WORK_SCOPE_LABELS[workScope]}”，另有 {forbiddenActionCount} 项禁止事项。硬风险始终等待人工。
            </div>
          )}
          {projectManaged && (
            <div className="sup-panel__freedom">
              项目管理护栏监督：{projectLanes.length} 个通道由项目管理 AI 按各自任务契约管理；普通监督配置和控制不会修改这些通道。
            </div>
          )}
          {ordinaryLanes.length > 0 && (
            <div className="sup-panel__goal">
              普通监督最大自动判断: {supervisor.autonomous ? '全自动会话（不限制）' : supervisor.maxAutoDecisions ? `${supervisor.maxAutoDecisions} 次 / 终端` : '不限制'}
            </div>
          )}
          {ordinaryLanes.length > 0 && (
            <div className="sup-panel__goal" title={supervisor.supervisorModel || `${supervisorLauncherName} 默认模型`}>
              普通监督模型: {supervisor.supervisorModel || `${supervisorLauncherName} 默认模型`}
            </div>
          )}
          {ordinaryLanes.length > 0 && (supervisorLauncher === 'codex' || supervisorLauncher === 'kimi' || supervisorLauncher === 'pi') && (
            <div className="sup-panel__goal" title={supervisor.supervisorReasoningEffort || `${supervisorLauncherName} 默认${supervisorThinkingLabel}`}>
              {supervisorThinkingLabel}: {supervisor.supervisorReasoningEffort || '默认'}
            </div>
          )}

          <div className="sup-panel__lanes">
            {supervisor.lanes.map((lane) => {
              const laneProjectManaged = isProjectManagedSupervisorLane(lane);
              const laneControlState = supervisorLaneControlState(lane);
              const laneConfig = effectiveSupervisorLaneConfig(lane);
              const lanePermissions = effectiveSupervisorAutonomyPermissions(supervisor, lane);
              const laneAutonomous = effectiveSupervisorAutonomous(supervisor, lane);
              const laneForbiddenActions = effectiveSupervisorForbiddenActions(supervisor, lane);
              const laneWorkScope = effectiveSupervisorWorkScope(supervisor, lane);
              const lanePolicyOverridden = Array.isArray(lane.autonomyPermissionsOverride)
                || typeof lane.autonomousOverride === 'boolean'
                || Array.isArray(lane.forbiddenActionsOverride)
                || !!lane.workScopeOverride;
              const planFileName = laneConfig.planFilePath.split(/[\\/]/).pop() || '';
              const stoppedLaneExpanded = expandedStoppedLaneIds.has(lane.id);
              const laneDetailsCollapsed = lane.stopConfirmed && !stoppedLaneExpanded;
              const laneStatusLabel = laneControlState === 'waiting'
                ? '待续'
                : lane.stopConfirmed
                  ? '已达停止条件'
                  : laneControlState === 'active'
                  ? '监督中'
                  : laneControlState === 'paused'
                    ? '已暂停'
                    : '已停止';
              const laneHeader = (
                <>
                  <span className="sup-panel__lane-label">{lane.label}</span>
                  <span className="sup-panel__lane-progress">
                    {laneProjectManaged ? '项目监督 · ' : '普通监督 · '}
                    {laneStatusLabel}
                    {' · '}{(lane.decisions || []).length} 次裁决 · 自动 {lane.autoDecisionsUsed || 0}/{laneProjectManaged || laneAutonomous ? '∞' : supervisor.maxAutoDecisions || '∞'}
                  </span>
                </>
              );
              return (
                <div
                  key={lane.id}
                  className="sup-panel__lane"
                  data-control-state={laneControlState}
                  data-details-collapsed={laneDetailsCollapsed ? '1' : '0'}
                >
                  {lane.stopConfirmed ? (
                    <button
                      type="button"
                      className="sup-panel__lane-head sup-panel__lane-toggle"
                      aria-expanded={stoppedLaneExpanded}
                      onClick={() => setExpandedStoppedLaneIds((current) => {
                        const next = new Set(current);
                        if (next.has(lane.id)) next.delete(lane.id);
                        else next.add(lane.id);
                        return next;
                      })}
                      title={stoppedLaneExpanded ? '折叠监督详情' : '展开监督详情'}
                    >
                      {laneHeader}
                    </button>
                  ) : (
                    <div className="sup-panel__lane-head">{laneHeader}</div>
                  )}
                  {!laneDetailsCollapsed && (
                    <>
                  <div className="sup-panel__lane-detail">
                    {lane.workspaceTitle ? `${lane.workspaceTitle} · ` : ''}
                    {lane.surfaceId.slice(0, 14)}…
                    {laneControlState === 'waiting'
                      ? ' · 已达停止条件，等待下一步方向'
                      : lane.stopConfirmed
                        ? ' · 已达停止条件'
                      : lane.awaitingStopCheck
                        ? ' · 待核对停止条件'
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
                  <div className="sup-panel__lane-task">
                    工作模式: {normalizeTaskWorkMode(laneConfig.taskWorkMode) === 'multi-thread'
                      ? `多线程工程（主线程 + ${normalizeTaskChildThreadResponsibilities(laneConfig.childThreadResponsibilities).length} 个子线程）`
                      : '单线程工作'}
                  </div>
                  <div className="sup-panel__lane-task" title={laneConfig.stopWhen}>
                    停止({stopWhenKindLabel(laneConfig.stopWhenKind)}): {laneConfig.stopWhen}
                  </div>
                  {laneConfig.waitForNextDirection && (
                    <div className="sup-panel__lane-task">
                      完成后: 待续，等待下一步方向
                    </div>
                  )}
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
                    专属监督: {dedicatedSupervisorSurfaceId(lane) ? '已连接' : '未启动'}
                    {lane.managementSessionId ? ` · 会话 ${lane.managementSessionId.slice(-8)}` : ''}
                  </div>
                  <div className="sup-panel__lane-supervisor">
                    权限: {laneAutonomous ? '全自动' : '有限自主'} · 允许 {lanePermissions.length}/{SUPERVISOR_AUTONOMY_PERMISSION_VALUES.length} · 禁止 {laneForbiddenActions.length}
                    {' · '}范围: {WORK_SCOPE_LABELS[laneWorkScope]}
                    {lanePolicyOverridden ? '（终端专用）' : '（普通会话默认）'}
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
                    {!laneProjectManaged && laneControlState === 'active' && (
                      <button type="button" onClick={() => pauseLane(lane)} disabled={!supervisor.active}>
                        暂停此监督
                      </button>
                    )}
                    {!laneProjectManaged && laneControlState === 'paused' && (
                      <button type="button" onClick={() => resumeLane(lane)} disabled={!supervisor.active}>
                        继续此监督
                      </button>
                    )}
                    {!laneProjectManaged && laneControlState !== 'stopped' && (
                      <button type="button" onClick={() => stopLane(lane)}>
                        停止此监督
                      </button>
                    )}
                    <button type="button" onClick={() => void openAuditTrail(lane)} disabled={loadingRecordLaneId === lane.id}>
                      {loadingRecordLaneId === lane.id ? '读取记录…' : '查看/刷新记录'}
                    </button>
                  </div>
                  {laneControlState === 'waiting' && (
                    <div className="sup-panel__lane-supervisor">
                      {laneProjectManaged
                        ? '待续中：由对应项目管理 AI 提供新任务契约或下一步方向。'
                        : '待续中：直接在对应 AI 监督终端说明新方案或下一步方向即可自动恢复；向任务终端发送新任务也可恢复，无需重新配置监督。'}
                    </div>
                  )}
                  {!laneProjectManaged && lane.awaitingStopCheck && !lane.stopConfirmed && (
                    <div className="sup-panel__approval-actions" style={{ marginTop: 6 }}>
                      <button type="button" onClick={() => rejectStopCondition(lane.id)} disabled={!supervisor.active}>
                        未达到
                      </button>
                      <button
                        type="button"
                        className="sup-panel__btn-primary"
                        onClick={() => {
                          confirmStopCondition(lane.id);
                          announceSupervisorWaitingForDirection(lane, '用户已确认达到停止条件');
                        }}
                        disabled={!supervisor.active}
                      >
                        已达停止条件
                      </button>
                    </div>
                  )}
                  {!laneProjectManaged && lane.autoDecisionLimitReached && (
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
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {visiblePendingApprovals.length > 0 && (
            <div className="sup-panel__approvals">
            <div className="sup-panel__approvals-title">需人工处理</div>
              {visiblePendingApprovals.map((a) => {
                const lane = supervisor.lanes.find((entry) => entry.id === a.laneId);
                const laneControlState = lane ? supervisorLaneControlState(lane) : 'stopped';
                const isContextRecovery = a.source === 'supervisor-context-recovery';
                const decisionOptions = a.proposalKind && !isContextRecovery
                  ? supervisorDecisionOptions(a.alternatives, a.text)
                  : [];
                const selectedOption = proposalSelections[a.id] || '';
                const directDecision = proposalEdits[a.id] || '';
                const supervisorSurfaceId = lane ? dedicatedSupervisorSurfaceId(lane) : null;
                return (
                <div key={a.id} className="sup-panel__approval">
                  <div className="sup-panel__approval-head">
                    <strong>{isContextRecovery ? '上下文恢复指令' : a.proposalKind === 'route-change' ? '路线变更' : a.proposalKind === 'important' ? '重要建议' : a.laneLabel}</strong>
                    {a.proposalKind && <span>{a.laneLabel}</span>}
                  </div>
                  {isContextRecovery ? (
                    <div className="sup-panel__proposal">
                      <section className="sup-panel__decision-section">
                        <h4>AI 监督拟定的任务恢复指令</h4>
                        <p>确认后将把以下原文直接发送到任务终端；确认前不会改动任务终端。</p>
                        <textarea
                          className="sup-panel__proposal-input"
                          value={a.text}
                          rows={12}
                          readOnly
                          aria-label={`${a.laneLabel} 的上下文恢复指令`}
                        />
                      </section>
                      <div className="sup-panel__approval-actions sup-panel__decision-actions">
                        {laneControlState === 'paused' ? (
                          <button
                            type="button"
                            onClick={() => lane && resumeLane(lane)}
                            disabled={!supervisor.active || !lane}
                          >
                            继续此监督
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onPause(a.id)}
                            disabled={!supervisor.active || laneControlState === 'stopped'}
                          >
                            暂不发送
                          </button>
                        )}
                        <button
                          type="button"
                          className="sup-panel__btn-primary"
                          onClick={() => onApprove(a.id)}
                          disabled={!supervisor.active || laneControlState !== 'active' || !a.text.trim()}
                        >
                          确认并发送到任务终端
                        </button>
                      </div>
                    </div>
                  ) : a.proposalKind ? (
                    <div className="sup-panel__proposal">
                      <section className="sup-panel__decision-section">
                        <h4>决策背景</h4>
                        <div className="sup-panel__decision-overview">
                          <div className="sup-panel__decision-fact sup-panel__decision-fact--task">
                            <span>当前任务目标</span>
                            <div>{a.task || '任务终端暂未上报明确目标'}</div>
                          </div>
                          <div className="sup-panel__decision-fact">
                            <span>需要你决定</span>
                            <div>{a.reason || 'AI 监督请求你确认下一步路线'}</div>
                          </div>
                          <div className="sup-panel__decision-fact">
                            <span>影响 / 风险</span>
                            <div>{a.impact || '未报告额外风险'}</div>
                          </div>
                        </div>
                      </section>

                      <section className="sup-panel__decision-section sup-panel__recommendation">
                        <h4>AI 推荐</h4>
                        <div>{a.text || 'AI 未提供具体下一步'}</div>
                      </section>

                      <fieldset className="sup-panel__decision-section sup-panel__decision-options">
                        <legend>选择 AI 方案</legend>
                        <p>选择后，AI 监督会读取任务终端最新状态，整理成完整指令再发送。</p>
                        <div className="sup-panel__decision-option-list">
                          {decisionOptions.map((option) => (
                            <label
                              key={option.value}
                              className={`sup-panel__decision-option${selectedOption === option.value ? ' is-selected' : ''}`}
                            >
                              <input
                                type="radio"
                                name={`supervisor-decision-${a.id}`}
                                value={option.value}
                                checked={selectedOption === option.value}
                                onChange={() => setProposalSelections((current) => ({
                                  ...current,
                                  [a.id]: option.value,
                                }))}
                                disabled={!supervisor.active || laneControlState === 'stopped'}
                              />
                              <span className="sup-panel__decision-option-copy">
                                <strong>{option.title}</strong>
                                <span>{option.detail}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>

                      <div className="sup-panel__approval-actions sup-panel__decision-actions">
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
                          disabled={
                            !supervisor.active
                            || laneControlState !== 'active'
                            || !supervisorSurfaceId
                            || !selectedOption
                          }
                        >
                          采用所选 AI 方案
                        </button>
                      </div>

                      <div className="sup-panel__decision-divider"><span>或者直接决定</span></div>

                      <section className="sup-panel__direct-decision">
                        <label className="sup-panel__proposal-edit">
                          <span>直接发送给任务终端的指令</span>
                          <textarea
                            className="sup-panel__proposal-input"
                            value={directDecision}
                            maxLength={4000}
                            onChange={(event) => setProposalEdits((current) => ({
                              ...current,
                              [a.id]: event.target.value,
                            }))}
                            placeholder="输入你的决定，例如：先保持现有实现，补充测试后再继续"
                            disabled={!supervisor.active || laneControlState === 'stopped'}
                          />
                        </label>
                        <div className="sup-panel__approval-actions">
                          <button
                            type="button"
                            onClick={() => openTaskTerminalForDecision(a.id)}
                            title="切换到对应任务终端查看最新界面"
                            disabled={!supervisor.active}
                          >
                            查看任务终端
                          </button>
                          <button
                            type="button"
                            onClick={() => onDirectSend(a.id)}
                            disabled={!supervisor.active || laneControlState !== 'active' || !directDecision.trim()}
                          >
                            直接发送用户指令
                          </button>
                        </div>
                      </section>
                    </div>
                  ) : (
                    <>
                      <pre className="sup-panel__approval-text">
                        {a.text.slice(0, 400)}
                        {a.text.length > 400 ? '…' : ''}
                      </pre>
                      <div className="sup-panel__approval-actions">
                        {laneControlState === 'paused' ? (
                          <button
                            type="button"
                            onClick={() => lane && resumeLane(lane)}
                            disabled={!supervisor.active || !lane}
                          >
                            继续此监督
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onPause(a.id)}
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
                    </>
                  )}
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
              配置普通监督
            </button>
            {ordinaryEnabled.length > 0 && (
              <button type="button" onClick={pauseActiveSession}>
                暂停普通监督
              </button>
            )}
            {ordinaryRetained && (
              <button type="button" onClick={() => stopOrdinarySupervisor()}>
                停止普通监督
              </button>
            )}
            {ordinaryPaused.length > 0 && (
              <button
                type="button"
                className="sup-panel__btn-primary"
                onClick={resumePausedSession}
              >
                {missingDedicatedSupervisor ? '专属 AI 已缺失' : '继续监督'}
              </button>
            )}
            {!ordinaryRetained && (
              <button
                type="button"
                className="sup-panel__btn-primary"
                onClick={ordinaryLanes.length === 0 || missingDedicatedSupervisor ? openSupervisorSetup : startFreshSupervisorSession}
              >
                {ordinaryLanes.length === 0 || missingDedicatedSupervisor ? '创建普通监督 AI' : '启动普通监督新会话'}
              </button>
            )}
            {ordinaryLanes.length > 0 && (
              <button type="button" onClick={restartFromScratch}>
                普通监督重头再来
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
