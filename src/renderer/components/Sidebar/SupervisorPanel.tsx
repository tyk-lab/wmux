import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { openProjectManagerConsole } from '../../project-manager/console-surface';
import {
  buildSupervisorBriefing,
  buildUnacknowledgedSupervisorIdlePrompt,
  effectiveSupervisorAutonomyPermissions,
  effectiveSupervisorAutonomous,
  effectiveSupervisorForbiddenActions,
  effectiveSupervisorLaneConfig,
  effectiveSupervisorWorkScope,
  SUPERVISOR_WORKSPACE_TITLE,
  stopWhenKindLabel,
  supervisorTabTitle,
} from '../../supervisor/protocol';
import {
  buildSupervisorLaunchCommand,
  detectSupervisorLauncher,
  supervisorLauncherDisplayName,
} from '../../supervisor/launch-command';
import {
  sendTaskToSurface,
  sendToSurface,
  supervisorLaneInputIsolationScope,
  SUPERVISOR_TUI_READY_DELAY_MS,
} from '../../supervisor/supervisor-engine';
import {
  buildAdoptedPlanBriefing,
  supervisorDecisionOptions,
} from '../../supervisor/decision-options';
import {
  buildSupervisorPlanView,
  summarizeSupervisorPlan,
  summarizeTaskExecution,
  type SupervisorTaskAgentState,
} from '../../supervisor/status-summary';
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
  normalizeTaskMaxChildThreads,
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
  isSupervisorLaneBound,
  supervisorLaneControlState,
  type SupervisorLane,
} from '../../store/supervisor-slice';
import '../../styles/supervisor.css';

interface SupervisorPanelProps {
  expanded?: boolean;
  workspaceId?: WorkspaceId;
  paneId?: PaneId;
  agentStates?: Record<string, SupervisorTaskAgentState | undefined>;
}

function auditTabTitle(lane: SupervisorLane): string {
  return `监督记录 · ${lane.label} · ${lane.surfaceId.slice(5, 13)}`;
}

const WORK_SCOPE_LABELS: Record<SupervisorWorkScope, string> = {
  project: '当前工程文件夹',
  'task-files': '仅当前任务相关文件',
  'plan-defined': '按计划文件定义',
};

const PROJECT_WORK_ITEM_STATUS_LABELS: Record<string, string> = {
  planned: '待派遣',
  'waiting-dependencies': '等待依赖',
  running: '监督中',
  validating: '验证中',
  'waiting-decision': '待决策',
  failed: '执行失败',
  completed: '已完成',
  stopped: '已关闭',
};

const PROJECT_SUPERVISOR_MILESTONE_STATUS_LABELS: Record<string, string> = {
  planned: '待执行',
  active: '进行中',
  completed: '已完成',
};

const SUPERVISOR_DECISION_OUTCOME_LABELS: Record<string, string> = {
  continue: '沿当前路线继续',
  rework: '调整当前路线',
  complete: '本轮规划完成',
  'needs-human': '等待人工决定',
};

function projectTaskWorkModeLabel(mode: string | undefined): string {
  if (mode === 'multi-thread') return '多线程';
  if (mode === 'adaptive') return '自适应线程';
  return '单线程';
}

export default function SupervisorPanel({ expanded = false, workspaceId, paneId, agentStates }: SupervisorPanelProps) {
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
  const projectManagers = useStore((s) => s.projectManagers);
  const workspaces = useStore((s) => s.workspaces);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedStoppedLaneIds, setExpandedStoppedLaneIds] = useState<Set<string>>(() => new Set());
  const [loadingRecordLaneId, setLoadingRecordLaneId] = useState<string | null>(null);
  const [proposalEdits, setProposalEdits] = useState<Record<string, string>>({});
  const [proposalSelections, setProposalSelections] = useState<Record<string, string>>({});
  const [proposalGuidance, setProposalGuidance] = useState<Record<string, string>>({});
  const [goalConstructionInputs, setGoalConstructionInputs] = useState<Record<string, string>>({});
  const [goalConstructionNotices, setGoalConstructionNotices] = useState<Record<string, string>>({});
  const goalConversationRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [polledAgentStates, setPolledAgentStates] = useState<Record<string, SupervisorTaskAgentState | undefined>>({});

  useEffect(() => {
    if (agentStates) return undefined;
    const refresh = () => {
      setPolledAgentStates((window as any).__wmux_getAgentStates?.() || {});
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, [agentStates]);

  useEffect(() => {
    const stoppedLaneIds = new Set(
      supervisor.lanes.filter((lane) => lane.stopConfirmed).map((lane) => lane.id),
    );
    setExpandedStoppedLaneIds((current) => {
      const retained = new Set([...current].filter((laneId) => stoppedLaneIds.has(laneId)));
      return retained.size === current.size ? current : retained;
    });
  }, [supervisor.lanes]);

  const goalConversationRevision = supervisor.lanes.map((lane) => {
    const messages = lane.goalConstruction?.messages || [];
    return `${lane.id}:${messages.length}:${messages.at(-1)?.id || ''}`;
  }).join('|');

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      for (const conversation of goalConversationRefs.current.values()) {
        conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [goalConversationRevision]);

  const ordinaryLanes = supervisor.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane));
  const projectLanes = supervisor.lanes.filter(isProjectManagedSupervisorLane);
  const panelWorkspace = expanded && workspaceId
    ? workspaces.find((workspace) => workspace.id === workspaceId)
    : undefined;
  const scopedProjectId = panelWorkspace
    ? getAllPaneIds(panelWorkspace.splitTree).flatMap((candidatePaneId) => (
        findLeaf(panelWorkspace.splitTree, candidatePaneId)?.surfaces || []
      )).find((surface) => surface.type === 'supervisor' && surface.projectSupervisorProjectId)
        ?.projectSupervisorProjectId
    : undefined;
  const visibleLanes = scopedProjectId
    ? projectLanes.filter((lane) => lane.projectManagerProjectId === scopedProjectId)
    : ordinaryLanes;
  const scopedProject = scopedProjectId
    ? projectManagers.find((project) => project.id === scopedProjectId)
    : undefined;
  const scopedProjectWorkItems = scopedProject?.workItems.filter((item) => (
    !scopedProject.activeGoalId || !item.goalId || item.goalId === scopedProject.activeGoalId
  )) || [];
  const visibleAgentStates = agentStates || polledAgentStates;
  const visibleBoundLanes = visibleLanes.filter(isSupervisorLaneBound);
  const enabled = visibleLanes.filter((lane) => supervisorLaneControlState(lane) === 'active');
  const waiting = visibleLanes.filter((lane) => supervisorLaneControlState(lane) === 'waiting');
  const visiblePaused = visibleLanes.filter((lane) => supervisorLaneControlState(lane) === 'paused');
  const visibleChannelCount = scopedProjectId ? enabled.length : visibleBoundLanes.length;
  const ordinaryEnabled = ordinaryLanes.filter((lane) => supervisorLaneControlState(lane) === 'active');
  const ordinaryWaiting = ordinaryLanes.filter((lane) => supervisorLaneControlState(lane) === 'waiting');
  const ordinaryPaused = ordinaryLanes.filter((lane) => supervisorLaneControlState(lane) === 'paused');
  const ordinaryRetained = ordinaryLanes.some(isSupervisorLaneBound);
  const ordinaryWorkspaceExists = workspaces.some((workspace) => (
    workspace.id === supervisor.supervisorWorkspaceId
    && workspace.title === SUPERVISOR_WORKSPACE_TITLE
  ));
  if (!expanded && ordinaryLanes.length === 0 && !ordinaryWorkspaceExists) return null;
  const visiblePendingApprovals = supervisor.pendingApprovals.filter((approval) => (
    !supervisor.lanes.some((lane) => (
      lane.id === approval.laneId && isProjectManagedSupervisorLane(lane)
    ))
  ));
  const pendingCount = visiblePendingApprovals.length;
  const ordinaryBoundLanes = ordinaryLanes.filter(isSupervisorLaneBound);
  const ordinaryWorkingCount = ordinaryBoundLanes.filter((lane) => (
    summarizeTaskExecution({
      controlState: supervisorLaneControlState(lane),
      currentTask: lane.currentTask,
      awaitingReview: lane.awaitingReview,
      stopConfirmed: lane.stopConfirmed,
    }, visibleAgentStates[lane.surfaceId]).label === '执行中'
  )).length;
  const ordinaryAttentionLaneCount = new Set(ordinaryBoundLanes.filter((lane) => (
    supervisorLaneControlState(lane) === 'waiting'
    || supervisorLaneControlState(lane) === 'paused'
    || visibleAgentStates[lane.surfaceId]?.state === 'blocked'
    || !!lane.supervisorProblem
  )).map((lane) => lane.id)).size;
  const ordinaryAttentionCount = ordinaryAttentionLaneCount + pendingCount;
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
          && (
            !supervisorSurfaceId
            || !liveSurfaceIds.has(supervisorSurfaceId)
            || lane.supervisorProblem?.kind === 'runtime-failed'
          );
    },
  );
  let statusLabel = '已停止';
  if (enabled.length > 0 || waiting.length > 0) {
    statusLabel = enabled.length === 0 && waiting.length > 0
      ? '待续'
      : waiting.length > 0
        ? `运行中 · ${waiting.length} 待续`
        : '运行中';
  }
  else if (visiblePaused.length > 0) statusLabel = '已暂停';

  const visibleLaneIds = new Set(visibleLanes.map((lane) => lane.id));
  const visibleLogs = supervisor.log.filter((entry) => (
    visibleLaneIds.has(entry.laneId)
    || (!scopedProjectId && entry.laneId === '-' && !entry.action.includes('项目监督'))
    || (!!scopedProjectId && entry.laneId === '-' && entry.action.includes('项目监督'))
  ));

  const openSupervisorSession = () => {
    const target = workspaces.find((workspace) => workspace.id === supervisor.supervisorWorkspaceId);
    if (target && target.title === SUPERVISOR_WORKSPACE_TITLE) {
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

  const sendGoalConstructionMessage = (lane: SupervisorLane) => {
    const message = (goalConstructionInputs[lane.id] || '').trim();
    if (!message) return;
    const control = (window as any).__wmux_supervisorRemoteControl;
    if (typeof control !== 'function') {
      setGoalConstructionNotices((current) => ({ ...current, [lane.id]: '监督控制层尚未就绪' }));
      return;
    }
    const result = control({
      action: 'send-supervisor-message',
      terminal: lane.surfaceId,
      message,
      actor: 'desktop-goal-construction',
    });
    if (result?.ok === false) {
      setGoalConstructionNotices((current) => ({ ...current, [lane.id]: result.error || '消息发送失败' }));
      return;
    }
    setGoalConstructionInputs((current) => ({ ...current, [lane.id]: '' }));
    setGoalConstructionNotices((current) => ({ ...current, [lane.id]: result?.message || '已发送' }));
  };

  const confirmGoalConstruction = (lane: SupervisorLane) => {
    const control = (window as any).__wmux_supervisorRemoteControl;
    if (typeof control !== 'function') {
      setGoalConstructionNotices((current) => ({ ...current, [lane.id]: '监督控制层尚未就绪' }));
      return;
    }
    const result = control({
      action: 'confirm-goal-construction',
      terminal: lane.surfaceId,
      actor: 'desktop-goal-construction',
    });
    setGoalConstructionNotices((current) => ({
      ...current,
      [lane.id]: result?.ok === false ? result.error || '目标确认失败' : result?.message || '目标已确认',
    }));
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
        sendTaskToSurface(
          item.surfaceId,
          item.text,
          supervisor.submitEnter,
          supervisorLaneInputIsolationScope(lane),
        );
      } else if (isHumanProposal) {
        const supervisorSurfaceId = lane ? dedicatedSupervisorSurfaceId(lane) : null;
        const choices = supervisorDecisionOptions(item.alternatives, item.text);
        const selected = choices.find((choice) => choice.value === proposalSelections[id]);
        const userGuidance = proposalGuidance[id]?.trim() || '';
        if (
          !lane
          || supervisorLaneControlState(lane) !== 'active'
          || !supervisorSurfaceId
          || (!selected && !userGuidance)
        ) return;
        adoptedPlan = [
          selected ? `${selected.value}：${selected.detail}` : '',
          userGuidance ? `用户补充：${userGuidance}` : '',
        ].filter(Boolean).join('\n');
        sendToSurface(supervisorSurfaceId, buildAdoptedPlanBriefing({
          surfaceId: item.surfaceId,
          selection: selected,
          userGuidance,
          recommendation: item.text,
          reason: item.reason,
           impact: item.impact,
           alternatives: item.alternatives,
           clarification: item.proposalKind === 'clarification',
         }), true, supervisorLaneInputIsolationScope(lane));
      } else if (item.text.trim()) {
        sendTaskToSurface(
          item.surfaceId,
          item.text,
          supervisor.submitEnter,
          supervisorLaneInputIsolationScope(lane),
        );
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
      setProposalGuidance((current) => {
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
        isContextRecovery
          ? '已确认并发送上下文恢复指令'
          : isHumanProposal
            ? proposalSelections[id]
              ? '已将所选方案交给 AI 监督处理'
              : '已将用户补充交给 AI 监督判断'
            : '已批准发送',
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
      sendTaskToSurface(
        item.surfaceId,
        text,
        supervisor.submitEnter,
        supervisorLaneInputIsolationScope(lane),
      );
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
      setProposalGuidance((current) => {
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
      activeReviewId: undefined,
      reviewWorkerTurnId: undefined,
      reviewOpenedAt: undefined,
      reviewDeliveryConfirmedAt: undefined,
      reviewWatchdogState: undefined,
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
      sendToSurface(
        supervisorSurfaceId,
        '[人工已介入] 已审阅当前终端。自动判断计数已重置；下一轮结束后可继续裁决。\n',
        true,
        supervisorLaneInputIsolationScope(lane),
      );
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
    const watchdogLaneIds = new Set(ordinaryLanes.filter((lane) => (
      supervisorLaneControlState(lane) === 'paused'
      && lane.supervisorProblem?.kind === 'unreported-decision'
    )).map((lane) => lane.id));
    resumeOrdinarySupervisor();
    const resumedSession = useStore.getState().supervisor;
    for (const lane of resumedSession.lanes.filter((candidate) => !isProjectManagedSupervisorLane(candidate))) {
      const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
      if (supervisorLaneControlState(lane) !== 'active'
        || !supervisorSurfaceId
        || pendingLaneIds.has(lane.id)) continue;
      if (watchdogLaneIds.has(lane.id)) {
        updateLane(lane.id, {
          reviewWatchdogState: 'retrying',
          reviewDeliveryConfirmedAt: undefined,
          unreportedIdleRecoveryAttempts: 1,
          supervisorProblem: undefined,
        });
      }
      const message = watchdogLaneIds.has(lane.id)
        ? buildUnacknowledgedSupervisorIdlePrompt(lane)
        : cancelledDecisionLaneIds.has(lane.id)
        ? '[会话继续] 用户已通过任务终端等其他方式发送信息，原待决项已取消。请保持原任务上下文，read-screen 后继续监督。\n'
        : '[会话继续] 用户已恢复当前监督会话。请保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n';
      sendToSurface(
        supervisorSurfaceId,
        message,
        true,
        supervisorLaneInputIsolationScope(lane),
      );
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
    if (!supervisorSurfaceId
      || !liveSurfaceIds.has(supervisorSurfaceId)
      || lane.supervisorProblem?.kind === 'runtime-failed') {
      openSupervisorSetup();
      return;
    }
    const retriesWatchdog = lane.supervisorProblem?.kind === 'unreported-decision';
    resumeSupervisorLane(lane.id, `用户继续 ${lane.label}；其他监督通道状态不变`);
    if (retriesWatchdog) {
      updateLane(lane.id, {
        reviewWatchdogState: 'retrying',
        reviewDeliveryConfirmedAt: undefined,
        unreportedIdleRecoveryAttempts: 1,
        supervisorProblem: undefined,
      });
    }
    appendSupervisorRecord(supervisor, lane, 'supervisor.lane-control', { action: 'resume' });
    if (supervisor.active && !supervisor.pendingApprovals.some((item) => item.laneId === lane.id)) {
      sendToSurface(
        supervisorSurfaceId,
        retriesWatchdog
          ? buildUnacknowledgedSupervisorIdlePrompt(lane)
          : '[通道继续] 用户已恢复此监督通道。保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n',
        true,
        supervisorLaneInputIsolationScope(lane),
      );
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

    if (!supervisor.supervisorLaunchCmd.trim()) {
      appendSupervisorLog('-', '启动失败', '未配置可启动的监督 AI，请先打开配置。');
      openSupervisorSetup();
      return;
    }
    const replacements: Array<{
      lane: SupervisorLane;
      oldSurfaceId: SurfaceId;
      newSurfaceId: SurfaceId;
      workspaceId: WorkspaceId;
      paneId: PaneId;
    }> = [];

    for (const { lane, supervisorSurfaceId, location } of lanesToRestart) {
      const launchCommand = buildSupervisorLaunchCommand(
        supervisor.supervisorLaunchCmd,
        supervisor.supervisorModel,
        supervisor.supervisorReasoningEffort,
        { isolateSupervisor: true, projectDir: lane.projectDir, isolationKey: lane.id },
      );
      const newSurfaceId = addSurface(location!.workspaceId, location!.paneId, 'terminal', {
        customTitle: supervisorTabTitle(lane.label),
        shell: 'pwsh.exe',
        cwd: lane.projectDir,
        startupCommands: [launchCommand],
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
        sendToSurface(
          supervisorSurfaceId,
          text,
          true,
          supervisorLaneInputIsolationScope(lane),
        );
      }
    }, SUPERVISOR_TUI_READY_DELAY_MS);
  };

  if (expanded && visibleLanes.length === 0 && scopedProjectWorkItems.length === 0) {
    return (
      <div className="sup-panel sup-panel--empty">
        <div className="sup-panel__empty-copy">
          {scopedProjectId ? '该项目的专属监督正在重建，或当前没有活动工作项。' : '尚未配置普通监督任务。'}
        </div>
      </div>
    );
  }

  if (!expanded && ordinaryLanes.length === 0) return null;

  if (!expanded) {
    return (
      <div
        className="sup-panel sup-panel--compact"
        data-active={enabled.length > 0 || waiting.length > 0 ? '1' : '0'}
        data-paused={visiblePaused.length > 0 ? '1' : '0'}
      >
        <button type="button" className="sup-panel__header" onClick={openSupervisorSession}>
          <span className="sup-panel__dot" />
          <span className="sup-panel__title">AI 监督</span>
          <span className="sup-panel__status">{statusLabel}</span>
          <span className="sup-panel__meta-right">{visibleChannelCount} 通道 · 展开会话</span>
        </button>
        <div className="sup-panel__compact-actions">
          <button type="button" onClick={openSupervisorSession}>打开</button>
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
          {!ordinaryRetained && ordinaryLanes.length > 0 && !missingDedicatedSupervisor && (
            <button
              type="button"
              className="sup-panel__btn-primary"
              onClick={startFreshSupervisorSession}
            >
              启动普通监督新会话
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="sup-panel"
      data-active={enabled.length > 0 || waiting.length > 0 ? '1' : '0'}
      data-paused={visiblePaused.length > 0 ? '1' : '0'}
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
        <span className="sup-panel__title">{scopedProjectId ? '项目专属监督' : 'AI 监督'}</span>
        <span className="sup-panel__status">{statusLabel}</span>
        <span className="sup-panel__meta-right">
          {visibleChannelCount} 通道{waiting.length > 0 ? ` · ${waiting.length} 待续` : ''}{!scopedProjectId && supervisor.autonomous ? ' · 全自动' : ''}
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
          {scopedProjectId && waiting.length > 0 && (
            <div className="sup-panel__waiting-notice" role="status">
              当前项目有 {waiting.length} 个监督通道待续，由该项目管理 AI 处理；普通监督不会接管。
            </div>
          )}
          {!scopedProjectId && ordinaryLanes.length > 0 && (
            <section className="sup-panel__summary" aria-label="普通监督运行总览">
              <div><span>状态</span><strong>{statusLabel}</strong></div>
              <div><span>监督通道</span><strong>{ordinaryBoundLanes.length}</strong></div>
              <div><span>任务执行中</span><strong>{ordinaryWorkingCount}</strong></div>
              <div data-attention={ordinaryAttentionCount > 0 ? '1' : '0'}><span>待处理</span><strong>{ordinaryAttentionCount}</strong></div>
            </section>
          )}
          {scopedProjectId && (
            <div className="sup-panel__freedom">
              项目专属监督：{visibleLanes.length} 个通道只接受当前项目管理 AI 的任务契约；普通监督的配置、暂停和停止操作均不会修改这里。
            </div>
          )}
          {scopedProjectId && scopedProject && (
            <section className="sup-panel__project-plan" aria-label="当前项目监督执行路线">
              <div className="sup-panel__project-plan-heading">
                <div>
                  <strong>监督通道执行路线</strong>
                  <span>{visibleLanes.length} 个监督通道 · 工作项由项目 AI 下发，具体路线由各监督 AI 维护</span>
                </div>
                <button type="button" onClick={() => {
                  openProjectManagerConsole(scopedProjectId);
                }}>打开项目管理</button>
              </div>
              <div className="sup-panel__project-plan-list">
                {visibleLanes.length === 0 && (
                  <div className="sup-panel__project-plan-empty">当前没有正在运行或保留的项目监督通道。</div>
                )}
                {visibleLanes.map((lane) => {
                  const item = scopedProjectWorkItems.find((candidate) => candidate.id === lane.projectWorkItemId);
                  const laneState = supervisorLaneControlState(lane);
                  if (!item) {
                    return (
                      <article key={lane.id} data-status={laneState} data-active="1">
                        <div className="sup-panel__project-plan-row">
                          <span className="sup-panel__project-plan-dot" />
                          <strong title={lane.label}>{lane.label}</strong>
                          <em>等待项目工作项</em>
                        </div>
                        <div className="sup-panel__project-plan-progress">监督通道正在恢复与项目工作项的绑定。</div>
                      </article>
                    );
                  }
                  const statusLabel = item.status === 'completed' || item.status === 'stopped'
                    ? PROJECT_WORK_ITEM_STATUS_LABELS[item.status]
                    : laneState === 'waiting'
                      ? '待续'
                      : laneState === 'paused'
                        ? '已暂停'
                        : PROJECT_WORK_ITEM_STATUS_LABELS[item.status] || item.status;
                  const planView = buildSupervisorPlanView({
                    source: 'project-ai',
                    task: item.title,
                    plan: item.supervisorPlan,
                    latestDecision: lane.decisions?.[0],
                    baselineStatus: item.baseline?.status,
                  });
                  const taskExecution = summarizeTaskExecution({
                    controlState: laneState,
                    currentTask: lane.currentTask || item.title,
                    awaitingReview: lane.awaitingReview,
                    stopConfirmed: lane.stopConfirmed,
                  }, visibleAgentStates[lane.surfaceId]);
                  const supervisorStatusLabel = item.status === 'completed' || item.status === 'stopped'
                    ? '已结束'
                    : laneState === 'active'
                        ? '已连接'
                        : laneState === 'waiting'
                          ? '待续'
                          : laneState === 'paused'
                            ? '已暂停'
                            : '已停止';
                  return (
                    <article key={lane.id} data-status={item.status} data-active="1">
                      <div className="sup-panel__project-plan-row">
                        <span className="sup-panel__project-plan-dot" />
                        <strong title={item.title}>{item.title}</strong>
                        <em>{statusLabel}</em>
                      </div>
                      <div className="sup-panel__project-plan-meta">
                        <span>上级任务：{planView.sourceLabel}</span>
                        <span>任务终端：{item.workerSurfaceId ? `…${item.workerSurfaceId.slice(-12)}` : '等待创建'}</span>
                        <span>监督：{supervisorStatusLabel}</span>
                        <span>{projectTaskWorkModeLabel(item.contract.execution?.taskWorkMode)}</span>
                      </div>
                      <div className="sup-panel__project-plan-route"><strong>监督 AI 当前规划</strong><span>{planView.modeLabel}</span></div>
                      <div className="sup-panel__project-plan-detail"><strong>当前路线</strong><span>{planView.route}</span></div>
                      <div className="sup-panel__project-plan-detail"><strong>下一步给任务 AI</strong><span>{planView.nextInstruction}</span></div>
                      {planView.steps.length > 0 && <>
                        <ol className="sup-panel__project-plan-milestones">
                          {planView.steps.map((milestone) => (
                            <li key={milestone.id} data-status={milestone.status}>
                              <span>{PROJECT_SUPERVISOR_MILESTONE_STATUS_LABELS[milestone.status] || milestone.status}</span>
                              <strong>{milestone.title}</strong>
                              <p>{milestone.outcome}</p>
                              {milestone.evidence && <small>证据：{milestone.evidence}</small>}
                            </li>
                          ))}
                        </ol>
                      </>}
                      {item.supervisorPlan?.remainingWork.length ? (
                        <div className="sup-panel__project-plan-detail"><strong>剩余工作</strong><span>{item.supervisorPlan.remainingWork.join('；')}</span></div>
                      ) : null}
                      {item.supervisorPlan?.targetedValidation.length ? (
                        <div className="sup-panel__project-plan-detail"><strong>定向验证</strong><span>{item.supervisorPlan.targetedValidation.join('；')}</span></div>
                      ) : null}
                      {item.supervisorPlan?.serializedBoundaries.length ? (
                        <div className="sup-panel__project-plan-detail"><strong>串行边界</strong><span>{item.supervisorPlan.serializedBoundaries.join('；')}</span></div>
                      ) : null}
                      <div className="sup-panel__project-plan-progress">
                        任务 AI 执行摘要：{taskExecution.label} · {item.latestEvidence || item.latestContextSummary || taskExecution.detail}
                      </div>
                      {(item.latestBlocker || item.latestEvidence || item.latestContextSummary) && (
                        <div className="sup-panel__project-plan-latest" data-blocked={item.latestBlocker ? '1' : '0'}>
                          {item.latestBlocker
                            ? `阻塞：${item.latestBlocker}`
                            : item.latestEvidence
                              ? `最近证据：${item.latestEvidence}`
                              : `上下文：${item.latestContextSummary}`}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )}
          {!scopedProjectId && ordinaryLanes.length > 0 && (
            <details className="sup-panel__session-config">
              <summary>
                <span>监督配置</span>
                <small>{supervisor.autonomous ? '全自动' : '有限自主'} · {supervisor.supervisorModel || `${supervisorLauncherName} 默认模型`}</small>
              </summary>
              <div className="sup-panel__config-grid">
                <div><span>自主权限</span><strong>{autonomyPermissionCount}/{SUPERVISOR_AUTONOMY_PERMISSION_VALUES.length} 项</strong></div>
                <div><span>工作范围</span><strong>{WORK_SCOPE_LABELS[workScope]}</strong></div>
                <div><span>禁止事项</span><strong>{forbiddenActionCount} 项</strong></div>
                <div><span>自动判断</span><strong>{supervisor.autonomous ? '不限制' : supervisor.maxAutoDecisions ? `${supervisor.maxAutoDecisions} 次/终端` : '不限制'}</strong></div>
                <div><span>监督模型</span><strong>{supervisor.supervisorModel || `${supervisorLauncherName} 默认模型`}</strong></div>
                {(supervisorLauncher === 'codex' || supervisorLauncher === 'kimi' || supervisorLauncher === 'pi') && (
                  <div><span>{supervisorThinkingLabel}</span><strong>{supervisor.supervisorReasoningEffort || '默认'}</strong></div>
                )}
              </div>
              <p>硬风险始终等待人工处理。</p>
            </details>
          )}

          <div className="sup-panel__lanes">
            {visibleLanes.map((lane) => {
              const laneProjectManaged = isProjectManagedSupervisorLane(lane);
              const laneControlState = supervisorLaneControlState(lane);
              const laneConfig = effectiveSupervisorLaneConfig(lane);
              const laneTaskWorkMode = normalizeTaskWorkMode(laneConfig.taskWorkMode);
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
              const latestDecision = lane.decisions?.[0];
              const planStatus = summarizeSupervisorPlan({
                latestDecision,
                currentTask: lane.currentTask,
                taskGoal: laneConfig.taskGoal,
                planFileName,
              });
              const executionStatus = summarizeTaskExecution(
                {
                  controlState: laneControlState,
                  currentTask: lane.currentTask,
                  awaitingReview: lane.awaitingReview,
                  stopConfirmed: lane.stopConfirmed,
                },
                visibleAgentStates[lane.surfaceId],
              );
              const planView = buildSupervisorPlanView({
                source: laneProjectManaged ? 'project-ai' : 'user',
                task: lane.currentTask || laneConfig.taskGoal || planFileName,
                latestDecision,
              });
              const laneStatusLabel = laneControlState === 'waiting'
                ? '待续'
                : lane.goalConstruction?.status === 'drafting'
                  ? '目标构建中'
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
                    {laneProjectManaged ? (
                      <>项目监督 · {laneStatusLabel} · {(lane.decisions || []).length} 次裁决</>
                    ) : (
                      <span className="sup-panel__lane-status-pill" data-state={laneControlState}>{laneStatusLabel}</span>
                    )}
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
                  {!laneProjectManaged && lane.supervisorProblem && (
                    <div className="sup-panel__waiting-notice" role="alert">
                      {lane.supervisorProblem.detail}
                    </div>
                  )}
                  {!laneProjectManaged && lane.goalConstruction?.status === 'drafting' && (() => {
                    const construction = lane.goalConstruction;
                    const draft = construction.draft;
                    const terminalContext = construction.origin === 'terminal-context';
                    return (
                      <section className="sup-panel__goal-construction" aria-label={`${lane.label} 的${terminalContext ? '终端上下文汇总' : '任务目标构建对话'}`}>
                        <header>
                          <div>
                            <span>{terminalContext ? '监督 AI 正在汇总终端上下文' : '监督 AI 目标构建'}</span>
                            <strong>{terminalContext ? '信息充分时自动开始；关键条件不足时在此询问' : '确认前只读，不会启动任务'}</strong>
                          </div>
                          <em>同一个 Agent</em>
                        </header>
                        <div className="sup-panel__goal-draft">
                          <div><span>任务目标</span><strong>{draft.taskGoal || '等待监督 AI 补全'}</strong></div>
                          <div><span>任务范围</span><strong>{draft.taskDescription || '仅限所选任务终端和项目目录'}</strong></div>
                          <div><span>前置条件</span><strong>{draft.preconditions || '等待监督 AI 补全'}</strong></div>
                          <div><span>停止条件</span><strong>{draft.stopWhen || '等待监督 AI 补全'}</strong></div>
                        </div>
                        <div
                          ref={(element) => {
                            if (element) goalConversationRefs.current.set(lane.id, element);
                            else goalConversationRefs.current.delete(lane.id);
                          }}
                          className="sup-panel__goal-conversation"
                        >
                          {construction.messages.map((entry) => (
                            <article key={entry.id} data-role={entry.role}>
                              <header><strong>{entry.role === 'assistant' ? '监督 AI' : '你'}</strong><time>{new Date(entry.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></header>
                              <p>{entry.text}</p>
                            </article>
                          ))}
                        </div>
                        <textarea
                          className="supervisor-dialog__textarea"
                          rows={2}
                          value={goalConstructionInputs[lane.id] || ''}
                          onChange={(event) => setGoalConstructionInputs((current) => ({ ...current, [lane.id]: event.target.value }))}
                          placeholder={terminalContext ? '仅在监督 AI 提问时补充目标、边界或验收信息' : '回答监督 AI 的问题，或继续补充目标、范围和验收要求'}
                          aria-label={`回复 ${lane.label} 的目标构建 Agent`}
                        />
                        {goalConstructionNotices[lane.id] && <div className="sup-panel__goal-notice" role="status">{goalConstructionNotices[lane.id]}</div>}
                        <div className="sup-panel__approval-actions">
                          <button type="button" disabled={!(goalConstructionInputs[lane.id] || '').trim()} onClick={() => sendGoalConstructionMessage(lane)}>发送给监督 AI</button>
                          <button
                            type="button"
                            disabled={!draft.taskGoal.trim() || !draft.preconditions.trim() || !draft.stopWhen.trim()}
                            onClick={() => confirmGoalConstruction(lane)}
                          >{terminalContext ? '确认补全并开始' : '确认目标并开始'}</button>
                        </div>
                      </section>
                    );
                  })()}
                  {!laneProjectManaged && lane.goalConstruction?.status !== 'drafting' && (
                    <>
                      <div className="sup-panel__lane-status-grid" aria-label={`${lane.label} 的规划与执行状态`}>
                        <div title={lane.currentTask || laneConfig.taskGoal || planFileName}>
                          <span>上级任务 · {planView.sourceLabel}</span>
                          <strong>{lane.currentTask || laneConfig.taskGoal || planFileName || '等待用户任务'}</strong>
                          <small>{laneConfig.taskDescription || '监督 AI 只在用户给定目标和范围内拆分执行项'}</small>
                        </div>
                        <div title={executionStatus.title}>
                          <span>任务 AI 执行摘要</span>
                          <strong>{executionStatus.label}</strong>
                          <small>{executionStatus.detail}</small>
                        </div>
                      </div>
                      <div className="sup-panel__lane-metrics">
                        <span>裁决 {(lane.decisions || []).length} 次</span>
                        <span>自动 {lane.autoDecisionsUsed || 0}/{laneAutonomous ? '∞' : supervisor.maxAutoDecisions || '∞'}</span>
                        {!!lane.pendingSupervisorDeliveries?.length && <span data-attention="1">待投递 {lane.pendingSupervisorDeliveries.length}</span>}
                      </div>
                      <section className="sup-panel__ordinary-plan" aria-label={`${lane.label} 的监督规划`}>
                        <div className="sup-panel__ordinary-plan-heading">
                          <div>
                            <span>监督 AI 当前规划</span>
                            <strong>{planView.modeLabel}</strong>
                          </div>
                          <em>{(lane.decisions || []).length} 次更新</em>
                        </div>
                        <>
                          <div className="sup-panel__ordinary-plan-grid">
                            <div>
                              <span>当前路线</span>
                              <strong>{planView.route}</strong>
                              <small>{latestDecision?.reason || planStatus.title}</small>
                            </div>
                            <div>
                              <span>下一步给任务 AI</span>
                              <strong>{planView.nextInstruction}</strong>
                              <small>{planView.mode === 'staged'
                                ? `执行项 ${planView.completedSteps}/${planView.steps.length}`
                                : '具体任务不做机械拆分'}</small>
                            </div>
                          </div>
                          {planView.steps.length > 0 && (
                            <ol className="sup-panel__project-plan-milestones sup-panel__ordinary-plan-steps">
                              {planView.steps.map((step) => (
                                <li key={step.id} data-status={step.status}>
                                  <span>{PROJECT_SUPERVISOR_MILESTONE_STATUS_LABELS[step.status] || step.status}</span>
                                  <strong>{step.title}</strong>
                                  <p>{step.outcome}</p>
                                  {step.evidence && <small>证据：{step.evidence}</small>}
                                </li>
                              ))}
                            </ol>
                          )}
                          {latestDecision ? (
                            <section className="sup-panel__ordinary-plan-history" aria-label={`${lane.label} 的监督决策链`}>
                              <div className="sup-panel__ordinary-plan-history-heading">
                                <strong>监督决策链</strong>
                                <span>最近 {Math.min(6, lane.decisions?.length || 0)} 次</span>
                              </div>
                              <div className="sup-panel__ordinary-plan-history-list">
                                {(lane.decisions || []).slice(0, 6).map((decision, index) => (
                                  <article key={`${decision.ts}-${index}`}>
                                    <header>
                                      <strong>{SUPERVISOR_DECISION_OUTCOME_LABELS[decision.outcome] || decision.outcome}</strong>
                                      <time>{new Date(decision.ts).toLocaleString('zh-CN', { hour12: false })}</time>
                                    </header>
                                    <div>负责任务：{decision.task || '任务尚未上报'}</div>
                                    <p>决策依据：{decision.reason || '未附选择理由'}</p>
                                    <small><b>→ 指示任务 AI</b>{decision.next || '未附下一步安排'}</small>
                                  </article>
                                ))}
                              </div>
                            </section>
                          ) : (
                            <div className="sup-panel__ordinary-plan-empty">
                              <span>监督规划状态</span>
                              <strong>等待监督 AI 首次正式裁决</strong>
                              <small>首次 continue/rework 后会显示直接监督执行或分阶段监督执行。</small>
                            </div>
                          )}
                        </>
                      </section>
                    </>
                  )}
                  {laneProjectManaged && <>
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
                    工作模式: {laneTaskWorkMode === 'multi-thread'
                      ? `多线程工程（主线程 + ${normalizeTaskChildThreadResponsibilities(laneConfig.childThreadResponsibilities).length} 个子线程）`
                      : laneTaskWorkMode === 'adaptive'
                        ? `自适应线程（最多 ${normalizeTaskMaxChildThreads(laneConfig.maxChildThreads)} 个内部子线程）`
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
                  </>}
                  {!laneProjectManaged && (
                    <details className="sup-panel__lane-config">
                      <summary>任务与监督配置</summary>
                      <dl>
                        <dt>任务目标</dt><dd>{laneConfig.taskGoal || lane.currentTask || '等待任务上报'}</dd>
                        <dt>任务终端</dt><dd>{lane.workspaceTitle ? `${lane.workspaceTitle} · ` : ''}{lane.surfaceId}</dd>
                        <dt>工作模式</dt><dd>{laneTaskWorkMode === 'multi-thread'
                          ? `多线程工程（主线程 + ${normalizeTaskChildThreadResponsibilities(laneConfig.childThreadResponsibilities).length} 个子线程）`
                          : laneTaskWorkMode === 'adaptive'
                            ? `自适应线程（最多 ${normalizeTaskMaxChildThreads(laneConfig.maxChildThreads)} 个内部子线程）`
                            : '单线程工作'}</dd>
                        <dt>停止条件</dt><dd>{laneConfig.stopWhen || '未配置'}</dd>
                        <dt>完成后</dt><dd>{laneConfig.waitForNextDirection ? '待续，等待下一步方向' : '结束监督'}</dd>
                        <dt>专属监督</dt><dd>{dedicatedSupervisorSurfaceId(lane) ? '已连接' : '未启动'}</dd>
                        <dt>权限范围</dt><dd>{laneAutonomous ? '全自动' : '有限自主'} · 允许 {lanePermissions.length}/{SUPERVISOR_AUTONOMY_PERMISSION_VALUES.length} · 禁止 {laneForbiddenActions.length} · {WORK_SCOPE_LABELS[laneWorkScope]}</dd>
                        {planFileName && <><dt>计划文件</dt><dd>{planFileName}</dd></>}
                        {laneConfig.preconditions && <><dt>前置条件</dt><dd>{laneConfig.preconditions}</dd></>}
                      </dl>
                    </details>
                  )}
                  {lane.restoredFromSessionId && (
                    <div className="sup-panel__lane-supervisor">
                      已恢复审计: {lane.restoredFromSessionId}
                    </div>
                  )}
                  {laneProjectManaged && (lane.decisions || []).length > 0 && (() => {
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
                const isClarification = a.proposalKind === 'clarification';
                const decisionOptions = a.proposalKind && !isContextRecovery && !isClarification
                  ? supervisorDecisionOptions(a.alternatives, a.text)
                  : [];
                const selectedOption = proposalSelections[a.id] || '';
                const userGuidance = proposalGuidance[a.id] || '';
                const directDecision = proposalEdits[a.id] || '';
                const supervisorSurfaceId = lane ? dedicatedSupervisorSurfaceId(lane) : null;
                return (
                <div key={a.id} className="sup-panel__approval">
                  <div className="sup-panel__approval-head">
                    <strong>{isContextRecovery ? '上下文恢复指令' : isClarification ? '需求对齐' : a.proposalKind === 'route-change' ? '路线变更' : a.proposalKind === 'important' ? '重要建议' : a.laneLabel}</strong>
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
                        <h4>{isClarification ? '需要集中确认的问题' : '决策背景'}</h4>
                        <div className="sup-panel__decision-overview">
                          <div className="sup-panel__decision-fact sup-panel__decision-fact--task">
                            <span>当前任务目标</span>
                            <div>{a.task || '任务终端暂未上报明确目标'}</div>
                          </div>
                          <div className="sup-panel__decision-fact">
                            <span>{isClarification ? '对齐问题' : '需要你决定'}</span>
                            <div>{a.reason || 'AI 监督请求你确认下一步路线'}</div>
                          </div>
                          <div className="sup-panel__decision-fact">
                            <span>影响 / 风险</span>
                            <div>{a.impact || '未报告额外风险'}</div>
                          </div>
                        </div>
                      </section>

                      <section className="sup-panel__decision-section sup-panel__recommendation">
                        <h4>{isClarification ? 'AI 推荐默认答案' : 'AI 推荐'}</h4>
                        <div>{isClarification
                          ? a.alternatives || 'AI 未提供推荐默认答案'
                          : a.text || 'AI 未提供具体下一步'}</div>
                      </section>

                      {!isClarification && <fieldset className="sup-panel__decision-section sup-panel__decision-options">
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
                      </fieldset>}

                      <section className="sup-panel__decision-section sup-panel__supervisor-guidance">
                        <label className="sup-panel__proposal-edit">
                          <span>{isClarification ? '集中回答以上问题' : '补充给 AI 监督的信息（可选）'}</span>
                          <textarea
                            className="sup-panel__proposal-input"
                            value={userGuidance}
                            maxLength={4000}
                            onChange={(event) => setProposalGuidance((current) => ({
                              ...current,
                              [a.id]: event.target.value,
                            }))}
                            placeholder={isClarification
                              ? '按问题编号集中答复；未特别说明的项目可写“按推荐默认答案”'
                              : '例如：优先保持现有 API；请结合当前终端状态判断是否调整方案'}
                            disabled={!supervisor.active || laneControlState === 'stopped'}
                            aria-label={`${a.laneLabel} 的监督 AI 补充信息`}
                          />
                          <small>{isClarification
                            ? '答复只交给监督 AI 完成对齐；监督 AI 形成正式计划前不会向任务 AI 发送执行指令。'
                            : '采用时会与所选方案一起交给 AI 监督分析，不会直接发送到任务终端。没有可选方案时，也可以只提交这段信息。'}</small>
                        </label>
                      </section>

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
                            || (!selectedOption && !userGuidance.trim())
                          }
                        >
                          {isClarification
                            ? '提交对齐答复'
                            : selectedOption ? '采用所选 AI 方案' : '提交补充给 AI 判断'}
                        </button>
                      </div>

                      {!isClarification && <>
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
                      </>}
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

          {!scopedProjectId && visibleLogs.length > 0 && (
            <div className="sup-panel__log">
              {visibleLogs.slice(0, 6).map((e, i) => (
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

          {scopedProjectId ? (
            <div className="sup-panel__waiting-notice" role="note">
              此处只展示当前项目的专属监督。暂停、恢复、换线和需求调整请到“项目管理”页处理。
            </div>
          ) : <div className="sup-panel__actions">
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
            {!ordinaryRetained && ordinaryLanes.length > 0 && !missingDedicatedSupervisor && (
              <button
                type="button"
                className="sup-panel__btn-primary"
                onClick={startFreshSupervisorSession}
              >
                启动普通监督新会话
              </button>
            )}
            {ordinaryLanes.length > 0 && (
              <button type="button" onClick={restartFromScratch}>
                普通监督重头再来
              </button>
            )}
          </div>}
        </>
      )}
    </div>
  );
}
