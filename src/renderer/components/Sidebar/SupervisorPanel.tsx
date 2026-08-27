import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { v4 as uuid } from 'uuid';
import { useStore } from '../../store';
import { openProjectManagerConsole } from '../../project-manager/console-surface';
import { formatProjectCompletionCriteria } from '../../project-manager/completion-display';
import {
  buildSupervisorBriefing,
  buildUnacknowledgedSupervisorIdlePrompt,
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
  supportedAgentLauncherExecutable,
  supervisorLauncherDisplayName,
} from '../../supervisor/launch-command';
import {
  sendTaskToSurface,
  sendToSurface,
  SUPERVISOR_TUI_READY_DELAY_MS,
  supervisorLaneInputIsolationScope,
} from '../../supervisor/supervisor-engine';
import { readTerminalScreen, redactProjectSafeExitExcerpt } from '../../pipe-bridge';
import {
  markTerminalRuntimeFailed,
  waitForTerminalRuntimeReady,
} from '../../terminal-runtime-lifecycle';
import {
  interactiveAgentInputReady,
  interactiveAgentShellPromptFailureDetail,
} from '../../utils/interactive-agent-runtime';
import {
  buildAdoptedPlanBriefing,
  supervisorDecisionOptions,
  supervisorRecommendedOptionValue,
} from '../../supervisor/decision-options';
import {
  buildSupervisorPlanView,
  compactProjectAlertSummary,
  isProjectSupervisorAssignmentPending,
  summarizeProjectManagedStatus,
  summarizeSupervisorPlan,
  summarizeTaskExecution,
  type SupervisorTaskAgentState,
} from '../../supervisor/status-summary';
import {
  appendSupervisorRecord,
  formatSupervisorAuditTrail,
  readSupervisorAuditTrail,
  restoreSelectedLaneHistory,
} from '../../supervisor/recording';
import { announceSupervisorWaitingForDirection } from '../../supervisor/waiting-notification';
import { createLeaf, findLeaf, getAllPaneIds } from '../../store/split-utils';
import type { PaneId, SurfaceId, SurfaceRef, WorkspaceId } from '../../../shared/types';
import { projectWorkItemCompletionResult } from '../../../shared/project-manager';
import type { SupervisedTerminalSnapshot } from '../../../shared/supervisor-recovery';
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
import { isAwaitingNextPromptState } from '../../agent-state-semantics';
import {
  ensureOrdinarySupervisorStatusSurface,
  ordinarySupervisorStatusSurfaceLocations,
  openOrdinarySupervisorStatusForTask,
  shouldShowOrdinarySupervisorCenter,
} from '../../supervisor/status-surface';
import {
  SUPERVISOR_SNAPSHOT_SAVE_EVENT,
  type SupervisorSnapshotSaveRequest,
  type SupervisorSnapshotSaveResult,
} from '../../supervisor/recovery-request';
import { queueOrdinarySupervisorControlDelivery } from '../../supervisor/ordinary-control-delivery';
import {
  ordinarySupervisorRuntimeNeedsRestore,
  ordinarySupervisorRuntimeRestorePatch,
} from '../../supervisor/ordinary-runtime-recovery';
import {
  activeStandingUserDecisions,
  standingUserDecisionFingerprint,
  upsertStandingUserDecision,
} from '../../supervisor/standing-user-decision';
import '../../styles/supervisor.css';

interface SupervisorPanelProps {
  expanded?: boolean;
  workspaceId?: WorkspaceId;
  paneId?: PaneId;
  surfaceId?: SurfaceId;
  agentStates?: Record<string, SupervisorTaskAgentState | undefined>;
  onRequestClose?: () => void;
  centerSelectedLaneId?: string | null;
  onCenterLaneSelect?: (laneId: string) => void;
}

function auditTabTitle(lane: SupervisorLane): string {
  return `监督记录 · ${lane.label} · ${lane.surfaceId.slice(5, 13)}`;
}

const WORK_SCOPE_LABELS: Record<SupervisorWorkScope, string> = {
  project: '当前工程文件夹',
  'task-files': '仅当前任务相关文件',
  'plan-defined': '按计划文件定义',
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

const ORDINARY_VERIFICATION_FEASIBILITY_LABELS: Record<string, string> = {
  direct: '可直接验证',
  partial: '只能部分验证',
  blocked: '当前验证受阻',
  'not-applicable': '不适用直接验证',
};

type OrdinaryCenterVisualState = 'error' | 'human' | 'waiting' | 'paused' | 'active' | 'stopped';

function ordinaryCenterVisualState(
  lane: SupervisorLane,
  taskState: SupervisorTaskAgentState | undefined,
  liveSurfaceIds: ReadonlySet<string>,
  needsHuman: boolean,
): OrdinaryCenterVisualState {
  if (
    lane.supervisorProblem
    || ordinarySupervisorRuntimeNeedsRestore(lane, liveSurfaceIds)
    || (taskState?.state === 'blocked' && !isAwaitingNextPromptState(taskState))
  ) return 'error';
  if (needsHuman) return 'human';
  const controlState = supervisorLaneControlState(lane);
  return controlState === 'waiting'
    ? 'waiting'
    : controlState === 'paused'
      ? 'paused'
      : controlState === 'active'
        ? 'active'
        : 'stopped';
}

function terminalSnapshotConsistency(lane: SupervisorLane): string {
  const config = effectiveSupervisorLaneConfig(lane);
  return [
    lane.id,
    lane.managementSessionId || '',
    lane.surfaceId,
    dedicatedSupervisorSurfaceId(lane) || '',
    lane.workerTurnId || 0,
    config.planRevision || 1,
    lane.decisions?.length || 0,
    lane.currentTask || '',
    lane.standingUserDecision
      ? `${lane.standingUserDecision.sourceApprovalId}:${lane.standingUserDecision.updatedAt}`
      : '',
    lane.latestSupervisorUserGuidance?.updatedAt || 0,
    lane.ordinaryContextResetCount || 0,
    lane.ordinaryContextResetPlanRevision || 0,
    lane.ordinaryContextReset
      ? `${lane.ordinaryContextReset.id}:${lane.ordinaryContextReset.status}`
      : '',
    supervisorLaneControlState(lane),
  ].join('|');
}

const snapshotSaveInFlightLaneIds = new Set<string>();
const runtimeRestoreInFlightLaneIds = new Set<string>();

function taskAgentExecutableFromLabel(value: unknown): string | null {
  const label = String(value || '').toLowerCase();
  if (label.includes('codex')) return 'codex';
  if (label.includes('kimi')) return 'kimi';
  if (label.includes('grok')) return 'grok';
  if (/\bpi(?:\s+agent)?\b/u.test(label)) return 'pi';
  if (label.includes('opencode')) return 'opencode';
  return null;
}

function snapshotTaskAgentExecutable(snapshot: SupervisedTerminalSnapshot): string | null {
  const startup = snapshot.terminal.startupCommands?.[0] || '';
  return supportedAgentLauncherExecutable(startup)
    || taskAgentExecutableFromLabel(snapshot.terminal.agent);
}

function buildSnapshotTaskRecovery(snapshot: SupervisedTerminalSnapshot): string {
  return [
    '[终端快照恢复｜继续执行]',
    `当前成果：${snapshot.supervisor.state.currentTask || snapshot.supervisor.config.taskGoal}`,
    snapshot.projectContext.verifiedEvidence.length > 0
      ? `已验证事实：${snapshot.projectContext.verifiedEvidence.join('；')}`
      : '',
    snapshot.projectContext.acceptanceGaps.length > 0
      ? `剩余验收缺口：${snapshot.projectContext.acceptanceGaps.join('；')}`
      : '',
    `停止条件：${snapshot.supervisor.config.stopWhen}`,
    '先读取并遵循当前项目适用的 AGENTS、技能和仓库规范。不要恢复旧命令、旧会话管理信息或旧对话推理；依据项目文件和上述已核对事实继续形成可验证成果。',
  ].filter(Boolean).join('\n');
}

export default function SupervisorPanel({
  expanded = false,
  workspaceId,
  paneId,
  surfaceId,
  agentStates,
  onRequestClose,
  centerSelectedLaneId,
  onCenterLaneSelect,
}: SupervisorPanelProps) {
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
  const createWorkspace = useStore((s) => s.createWorkspace);
  const updateSurface = useStore((s) => s.updateSurface);
  const setMarkdownContent = useStore((s) => s.setMarkdownContent);
  const selectSurface = useStore((s) => s.selectSurface);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const projectManagers = useStore((s) => s.projectManagers);
  const workspaces = useStore((s) => s.workspaces);
  const [collapsed, setCollapsed] = useState(false);
  const [centerOpen, setCenterOpen] = useState(false);
  const [selectedCenterLaneId, setSelectedCenterLaneId] = useState<string | null>(null);
  const [expandedCenterLaneIds, setExpandedCenterLaneIds] = useState<Set<string>>(() => new Set(
    supervisor.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane)).map((lane) => lane.id),
  ));
  const knownCenterLaneIds = useRef(new Set(
    supervisor.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane)).map((lane) => lane.id),
  ));
  const [expandedStoppedLaneIds, setExpandedStoppedLaneIds] = useState<Set<string>>(() => new Set());
  const [loadingRecordLaneId, setLoadingRecordLaneId] = useState<string | null>(null);
  const [snapshotActionLaneId, setSnapshotActionLaneId] = useState<string | null>(null);
  const [snapshotDeleteLaneId, setSnapshotDeleteLaneId] = useState<string | null>(null);
  const [snapshotNotices, setSnapshotNotices] = useState<Record<string, string>>({});
  const [runtimeRestoreLaneId, setRuntimeRestoreLaneId] = useState<string | null>(null);
  const [runtimeRestoreNotices, setRuntimeRestoreNotices] = useState<Record<string, string>>({});
  const [proposalEdits, setProposalEdits] = useState<Record<string, string>>({});
  const [proposalSelections, setProposalSelections] = useState<Record<string, string>>({});
  const [proposalGuidance, setProposalGuidance] = useState<Record<string, string>>({});
  const [stopConditionGuidance, setStopConditionGuidance] = useState<Record<string, string>>({});
  const [proposalStandingDecisions, setProposalStandingDecisions] = useState<Record<string, boolean>>({});
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

  const ordinaryLanes = supervisor.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane));
  const projectLanes = supervisor.lanes.filter(isProjectManagedSupervisorLane);

  useEffect(() => {
    const currentLaneIds = new Set(supervisor.lanes
      .filter((lane) => !isProjectManagedSupervisorLane(lane))
      .map((lane) => lane.id));
    const newlyAddedLaneIds = [...currentLaneIds].filter((laneId) => !knownCenterLaneIds.current.has(laneId));
    knownCenterLaneIds.current = currentLaneIds;
    setExpandedCenterLaneIds((current) => {
      const next = new Set([...current].filter((laneId) => currentLaneIds.has(laneId)));
      for (const laneId of newlyAddedLaneIds) next.add(laneId);
      return next.size === current.size && [...next].every((laneId) => current.has(laneId)) ? current : next;
    });
  }, [supervisor.lanes]);

  const ordinaryStatusSurfaces = ordinarySupervisorStatusSurfaceLocations(workspaces);
  const panelWorkspace = expanded && workspaceId
    ? workspaces.find((workspace) => workspace.id === workspaceId)
    : undefined;
  const panelSurface = panelWorkspace && paneId && surfaceId
    ? findLeaf(panelWorkspace.splitTree, paneId)?.surfaces.find((surface) => surface.id === surfaceId)
    : undefined;
  const scopedProjectId = panelSurface?.projectSupervisorProjectId;
  const ordinaryCenterMode = expanded && !workspaceId && !scopedProjectId;
  const scopedOrdinaryLaneId = panelSurface?.ordinarySupervisorLaneId;
  const scopedOrdinaryStatusSurface = panelSurface?.type === 'supervisor' && !scopedProjectId
    ? panelSurface
    : undefined;
  const visibleRestoredStatusSurfaces = scopedOrdinaryStatusSurface
    ? ordinaryStatusSurfaces.filter((entry) => entry.surface.id === scopedOrdinaryStatusSurface.id)
    : ordinaryStatusSurfaces;
  const visibleLanes = scopedProjectId
    ? projectLanes.filter((lane) => lane.projectManagerProjectId === scopedProjectId)
    : scopedOrdinaryLaneId
      ? ordinaryLanes.filter((lane) => lane.id === scopedOrdinaryLaneId)
      : ordinaryLanes;
  const scopedOrdinaryLane = scopedOrdinaryLaneId
    ? ordinaryLanes.find((lane) => lane.id === scopedOrdinaryLaneId)
    : undefined;
  const ordinaryLaneIds = new Set(ordinaryLanes.map((lane) => lane.id));
  const restoredOnlyStatusSurfaces = ordinaryStatusSurfaces.filter((entry) => (
    !entry.surface.ordinarySupervisorLaneId
    || !ordinaryLaneIds.has(entry.surface.ordinarySupervisorLaneId)
  ));
  const effectiveCenterLaneId = centerSelectedLaneId ?? selectedCenterLaneId;
  const centerSelectionScope = !expanded || ordinaryCenterMode;
  const selectedCenterLane = centerSelectionScope
    ? ordinaryLanes.find((lane) => lane.id === effectiveCenterLaneId) || ordinaryLanes[0]
    : undefined;
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
  const visibleChannelCount = scopedProjectId
    ? enabled.length
    : Math.max(visibleBoundLanes.length, ordinaryStatusSurfaces.length);
  const controlledOrdinaryLanes = scopedOrdinaryLane ? [scopedOrdinaryLane] : ordinaryLanes;
  const ordinaryEnabled = controlledOrdinaryLanes.filter((lane) => supervisorLaneControlState(lane) === 'active');
  const ordinaryWaiting = controlledOrdinaryLanes.filter((lane) => supervisorLaneControlState(lane) === 'waiting');
  const ordinaryPaused = controlledOrdinaryLanes.filter((lane) => supervisorLaneControlState(lane) === 'paused');
  const ordinaryRetained = controlledOrdinaryLanes.some(isSupervisorLaneBound);

  const ordinaryStatusSurfaceRevision = ordinaryLanes
    .filter(isSupervisorLaneBound)
    .map((lane) => `${lane.id}:${lane.surfaceId}:${lane.workspaceId || ''}:${lane.paneId || ''}`)
    .join('|');

  useEffect(() => {
    if (expanded || !ordinaryStatusSurfaceRevision) return;
    const state = useStore.getState();
    for (const lane of state.supervisor.lanes.filter((candidate) => (
      !isProjectManagedSupervisorLane(candidate) && isSupervisorLaneBound(candidate)
    ))) {
      for (const workspace of state.workspaces) {
        const taskPaneId = getAllPaneIds(workspace.splitTree).find((candidatePaneId) => (
          findLeaf(workspace.splitTree, candidatePaneId)?.surfaces.some((surface) => surface.id === lane.surfaceId)
        ));
        if (!taskPaneId) continue;
        ensureOrdinarySupervisorStatusSurface(workspace.id, taskPaneId, lane.id, lane.surfaceId);
        break;
      }
    }
  }, [expanded, ordinaryStatusSurfaceRevision, workspaces]);

  useEffect(() => {
    if (!centerOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCenterOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [centerOpen]);

  useEffect(() => {
    if (!centerSelectionScope) return;
    if (ordinaryLanes.length === 0) {
      if (selectedCenterLaneId !== null) setSelectedCenterLaneId(null);
      return;
    }
    if (centerSelectedLaneId === undefined
      && !ordinaryLanes.some((lane) => lane.id === selectedCenterLaneId)) {
      setSelectedCenterLaneId(ordinaryLanes[0].id);
    }
  }, [centerSelectedLaneId, centerSelectionScope, ordinaryLanes, selectedCenterLaneId]);

  const selectCenterLane = (laneId: string) => {
    setSelectedCenterLaneId(laneId);
    onCenterLaneSelect?.(laneId);
  };

  const controlledOrdinaryLaneIds = new Set(controlledOrdinaryLanes.map((lane) => lane.id));
  const visiblePendingApprovals = scopedProjectId
    ? []
    : supervisor.pendingApprovals.filter((approval) => controlledOrdinaryLaneIds.has(approval.laneId));
  const pendingCount = visiblePendingApprovals.length;
  const ordinaryBoundLanes = controlledOrdinaryLanes.filter(isSupervisorLaneBound);
  const ordinaryWorkingCount = ordinaryBoundLanes.filter((lane) => (
    summarizeTaskExecution({
      controlState: supervisorLaneControlState(lane),
      currentTask: lane.currentTask,
      awaitingReview: lane.awaitingReview,
      stopConfirmed: lane.stopConfirmed,
    }, visibleAgentStates[lane.surfaceId]).label === '执行中'
  )).length;
  const ordinaryAttentionLaneIds = new Set(ordinaryBoundLanes.filter((lane) => (
    supervisorLaneControlState(lane) === 'waiting'
    || supervisorLaneControlState(lane) === 'paused'
    || (visibleAgentStates[lane.surfaceId]?.state === 'blocked'
      && !isAwaitingNextPromptState(visibleAgentStates[lane.surfaceId]))
    || !!lane.supervisorProblem
  )).map((lane) => lane.id));
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
  const missingOrdinarySupervisorLanes = controlledOrdinaryLanes.filter((lane) => (
    ordinarySupervisorRuntimeNeedsRestore(lane, liveSurfaceIds)
  ));
  const missingDedicatedSupervisor = missingOrdinarySupervisorLanes.length > 0;
  for (const lane of missingOrdinarySupervisorLanes) ordinaryAttentionLaneIds.add(lane.id);
  const ordinaryAttentionCount = ordinaryAttentionLaneIds.size + pendingCount;
  let statusLabel = '已停止';
  if (ordinaryLanes.length === 0 && ordinaryStatusSurfaces.length > 0 && !scopedProjectId) {
    statusLabel = '待恢复';
  } else if (enabled.length > 0 || waiting.length > 0) {
    statusLabel = enabled.length === 0 && waiting.length > 0
      ? '待续'
      : waiting.length > 0
        ? `运行中 · ${waiting.length} 待续`
        : '运行中';
  }
  else if (visiblePaused.length > 0) statusLabel = '已暂停';
  if (missingDedicatedSupervisor) {
    statusLabel = `${statusLabel} · ${missingOrdinarySupervisorLanes.length} 通道异常`;
  }
  if (!scopedProjectId && ordinaryLanes.length > 0 && restoredOnlyStatusSurfaces.length > 0) {
    statusLabel = `${statusLabel} · ${restoredOnlyStatusSurfaces.length} 待恢复`;
  }
  const selectedCenterControlState = selectedCenterLane
    ? supervisorLaneControlState(selectedCenterLane)
    : null;
  const selectedCenterExecution = selectedCenterLane
    ? summarizeTaskExecution({
        controlState: selectedCenterControlState || 'stopped',
        currentTask: selectedCenterLane.currentTask,
        awaitingReview: selectedCenterLane.awaitingReview,
        stopConfirmed: selectedCenterLane.stopConfirmed,
      }, visibleAgentStates[selectedCenterLane.surfaceId])
    : null;
  const selectedCenterTaskState = selectedCenterLane
    ? visibleAgentStates[selectedCenterLane.surfaceId]
    : undefined;
  const selectedCenterNeedsHuman = !!selectedCenterLane && (
    supervisor.pendingApprovals.some((approval) => approval.laneId === selectedCenterLane.id)
    || selectedCenterLane.awaitingStopCheck
    || selectedCenterLane.autoDecisionLimitReached === true
  );
  const selectedCenterVisualState = selectedCenterLane
    ? ordinaryCenterVisualState(
        selectedCenterLane,
        selectedCenterTaskState,
        liveSurfaceIds,
        selectedCenterNeedsHuman,
      )
    : ordinaryStatusSurfaces.length > 0
      ? 'waiting'
      : 'stopped';
  const selectedCenterAttention = selectedCenterVisualState === 'error';
  const selectedCenterStatusLabel = selectedCenterAttention
    ? '异常'
    : selectedCenterNeedsHuman
      ? '需人工处理'
      : selectedCenterControlState === 'active'
        ? '监督中'
        : selectedCenterControlState === 'waiting'
          ? '待续'
          : selectedCenterControlState === 'paused'
            ? '已暂停'
            : selectedCenterControlState === 'stopped'
              ? '已停止'
              : statusLabel;
  const activeOrdinaryCenterCount = ordinaryLanes.filter((lane) => (
    supervisorLaneControlState(lane) !== 'stopped'
  )).length;

  const visibleLaneIds = new Set(visibleLanes.map((lane) => lane.id));
  const visibleLogs = supervisor.log.filter((entry) => (
    visibleLaneIds.has(entry.laneId)
    || (!scopedProjectId && entry.laneId === '-' && entry.scope === 'ordinary')
    || (!!scopedProjectId && entry.laneId === '-' && entry.scope === 'project')
  ));

  const locateSurface = (surfaceId: SurfaceId) => {
    for (const workspace of useStore.getState().workspaces) {
      for (const candidatePaneId of getAllPaneIds(workspace.splitTree)) {
        const pane = findLeaf(workspace.splitTree, candidatePaneId);
        const index = pane?.surfaces.findIndex((surface) => surface.id === surfaceId) ?? -1;
        if (index >= 0) return { workspace, paneId: candidatePaneId, index };
      }
    }
    return null;
  };

  const focusSurface = (surfaceId: SurfaceId): boolean => {
    const location = locateSurface(surfaceId);
    if (!location) return false;
    selectWorkspace(location.workspace.id);
    selectSurface(location.workspace.id, location.paneId, location.index);
    return true;
  };

  const openSupervisorSession = () => {
    if (
      ordinaryLanes.some((lane) => locateSurface(lane.surfaceId))
      || ordinaryStatusSurfaces.length > 0
    ) setCenterOpen(true);
    else openSupervisorSetup();
  };

  const openLaneSupervisorTerminal = async (lane: SupervisorLane) => {
    const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
    if (supervisorSurfaceId && focusSurface(supervisorSurfaceId)) return;
    if (!await restoreSupervisorRuntime(lane)) return;
    const restoredLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id);
    const restoredSurfaceId = restoredLane && dedicatedSupervisorSurfaceId(restoredLane);
    if (restoredSurfaceId) focusSurface(restoredSurfaceId);
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
    const userGuidance = proposalGuidance[id]?.trim() || '';
    try {
      const lane = supervisor.lanes.find((l) => l.id === item.laneId);
      const reuseForSimilarIssues = !!lane
        && !isProjectManagedSupervisorLane(lane)
        && proposalStandingDecisions[id] === true;
      const isHumanProposal = item.source === 'supervisor-route' || item.source === 'supervisor-important';
      let adoptedPlan = '';
      if (isHumanProposal) {
        const supervisorSurfaceId = lane ? dedicatedSupervisorSurfaceId(lane) : null;
        const choices = supervisorDecisionOptions(item.alternatives, item.text);
        const recommendedOption = item.recommendedOption
          || supervisorRecommendedOptionValue(choices, item.text);
        const selected = choices.find((choice) => (
          choice.value === (proposalSelections[id] || recommendedOption)
        ));
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
        const briefing = buildAdoptedPlanBriefing({
          surfaceId: item.surfaceId,
          selection: selected,
          userGuidance,
          recommendation: item.text,
          reason: item.reason,
          impact: item.impact,
          alternatives: item.alternatives,
          clarification: item.proposalKind === 'clarification',
          reuseForSimilarIssues,
        });
        if (isProjectManagedSupervisorLane(lane)) {
          sendToSurface(supervisorSurfaceId, briefing, true, supervisorLaneInputIsolationScope(lane));
        } else if (!queueOrdinarySupervisorControlDelivery(lane.id, briefing, {
          kind: 'owner-decision',
          correlationId: item.id,
        })) return;
      } else if (item.text.trim()) {
        sendTaskToSurface(
          item.surfaceId,
          [item.text, userGuidance ? `[用户补充意见]\n${userGuidance}` : ''].filter(Boolean).join('\n\n'),
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
      setProposalStandingDecisions((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (isHumanProposal && lane) {
        const choices = supervisorDecisionOptions(item.alternatives, item.text);
        const recommendedOption = item.recommendedOption
          || supervisorRecommendedOptionValue(choices, item.text);
        const selected = choices.find((choice) => (
          choice.value === (proposalSelections[id] || recommendedOption)
        ));
        const standingDecisionSubject = [item.reason, item.impact, item.alternatives, item.text]
          .filter(Boolean).join('\n').slice(0, 4000);
        const standingDecision = reuseForSimilarIssues
          ? {
              decision: [
                selected ? `${selected.value}：${selected.detail}` : '',
                userGuidance,
              ].filter(Boolean).join('\n'),
              subject: standingDecisionSubject,
              subjectFingerprint: standingUserDecisionFingerprint(standingDecisionSubject),
              proposalKind: item.proposalKind,
              sourceApprovalId: item.id,
              updatedAt: Date.now(),
              planRevision: effectiveSupervisorLaneConfig(lane).planRevision || 1,
            }
          : undefined;
        updateLane(lane.id, {
          awaitingReview: true,
          autoDecisionLimitReached: false,
          autoDecisionsUsed: 0,
          ...(standingDecision ? {
            standingUserDecision: standingDecision,
            standingUserDecisions: upsertStandingUserDecision(
              activeStandingUserDecisions(lane, standingDecision.planRevision),
              standingDecision,
            ),
          } : {}),
        });
        appendSupervisorRecord(supervisor, lane, 'supervisor.proposal.resolved', {
          approvalId: item.id,
          resolution: 'approved',
          proposalKind: item.proposalKind || 'important',
          text: adoptedPlan,
          reuseForSimilarIssues,
        });
        if (standingDecision) {
          appendSupervisorLog(lane.id, '已记录持续用户决策', standingDecision.decision.slice(0, 160));
        }
      }
      appendSupervisorLog(
        item.laneId,
        isHumanProposal
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
    const reuseForSimilarIssues = !isProjectManagedSupervisorLane(lane)
      && proposalStandingDecisions[id] === true;
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
      const standingDecisionSubject = [item.reason, item.impact, item.alternatives, item.text]
        .filter(Boolean).join('\n').slice(0, 4000);
      const standingDecision = reuseForSimilarIssues
        ? {
            decision: text,
            subject: standingDecisionSubject,
            subjectFingerprint: standingUserDecisionFingerprint(standingDecisionSubject),
            proposalKind: item.proposalKind,
            sourceApprovalId: item.id,
            updatedAt: Date.now(),
            planRevision: effectiveSupervisorLaneConfig(lane).planRevision || 1,
          }
        : undefined;
      const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
      if (standingDecision && supervisorSurfaceId) {
        const notification = [
          '[持续用户决策] 用户已直接向任务终端发送本次决定。',
          `适用问题：${standingDecision.subject}`,
          `用户决定：${standingDecision.decision}`,
          '后续遇到语义相近且范围、前提、风险和验收没有实质变化的问题时，以本次决定为主直接继续，不要反复询问；出现实质差异或新风险时再说明差异并请求决策。',
        ].join('\n');
        if (isProjectManagedSupervisorLane(lane)) {
          sendToSurface(supervisorSurfaceId, notification, true, supervisorLaneInputIsolationScope(lane));
        } else {
          queueOrdinarySupervisorControlDelivery(lane.id, notification, {
            kind: 'owner-decision',
            correlationId: item.id,
          });
        }
      }
      setProposalStandingDecisions((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      updateLane(lane.id, {
        awaitingReview: false,
        currentTask: text,
        autoDecisionLimitReached: false,
        autoDecisionsUsed: 0,
        ...(standingDecision ? {
          standingUserDecision: standingDecision,
          standingUserDecisions: upsertStandingUserDecision(
            activeStandingUserDecisions(lane, standingDecision.planRevision),
            standingDecision,
          ),
        } : {}),
      });
      appendSupervisorRecord(supervisor, lane, 'supervisor.proposal.resolved', {
        approvalId: item.id,
        resolution: 'handled-manually',
        proposalKind: item.proposalKind || 'important',
        text,
        reuseForSimilarIssues,
      });
      if (standingDecision) {
        appendSupervisorLog(lane.id, '已记录持续用户决策', standingDecision.decision.slice(0, 160));
      }
      appendSupervisorLog(item.laneId, '已直接发送用户决策', `${item.laneLabel} → ${item.surfaceId}`);
    } catch (err: any) {
      appendSupervisorLog(item.laneId, '发送失败', String(err?.message || err));
    }
  };

  const onPause = (id: string) => {
    const item = supervisor.pendingApprovals.find((entry) => entry.id === id);
    if (!item) return;
    const lane = supervisor.lanes.find((entry) => entry.id === item.laneId);
    const userGuidance = proposalGuidance[id]?.trim() || '';
    pauseSupervisorLane(
      item.laneId,
      `人工暂停待决项：${item.laneLabel}；该通道决策内容已保留${userGuidance ? `；用户补充：${userGuidance}` : ''}`,
    );
    if (lane) {
      appendSupervisorRecord(supervisor, lane, 'supervisor.proposal.resolved', {
        approvalId: item.id,
        resolution: 'paused',
        proposalKind: item.proposalKind,
        userGuidance: userGuidance || undefined,
      });
      if (userGuidance) appendSupervisorLog(lane.id, '用户暂停待决项并补充意见', userGuidance);
    }
  };

  const resolveStopCondition = (lane: SupervisorLane, reached: boolean) => {
    const userGuidance = stopConditionGuidance[lane.id]?.trim() || '';
    if (reached) {
      confirmStopCondition(lane.id);
      announceSupervisorWaitingForDirection(
        lane,
        `用户已确认达到停止条件${userGuidance ? `；用户补充：${userGuidance}` : ''}`,
      );
    } else {
      rejectStopCondition(lane.id);
      if (userGuidance) {
        queueOrdinarySupervisorControlDelivery(
          lane.id,
          `[用户停止条件判断] 用户确认尚未达到停止条件。\n[用户补充意见] ${userGuidance}\n请读取任务终端最新状态后继续监督。`,
          { kind: 'owner-decision' },
        );
      }
    }
    appendSupervisorRecord(supervisor, lane, 'supervisor.stop-condition.user-decision', {
      reached,
      userGuidance: userGuidance || undefined,
    });
    if (userGuidance) appendSupervisorLog(lane.id, '用户补充停止条件判断', userGuidance);
    setStopConditionGuidance((current) => {
      const next = { ...current };
      delete next[lane.id];
      return next;
    });
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
      queueOrdinarySupervisorControlDelivery(
        lane.id,
        '[人工已介入] 已审阅当前终端。自动判断计数已重置；下一轮结束后可继续裁决。\n',
      );
    }
  };

  const resumePausedSession = async () => {
    if (ordinaryPaused.length === 0) return;
    if (missingDedicatedSupervisor) {
      if (!await restoreMissingSupervisorRuntimes()) return;
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
    const stalledTaskLaneIds = new Set(ordinaryLanes.filter((lane) => (
      supervisorLaneControlState(lane) === 'paused'
      && lane.supervisorProblem?.kind === 'task-stalled'
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
      } else if (stalledTaskLaneIds.has(lane.id)) {
        updateLane(lane.id, { supervisorProblem: undefined });
      }
      const message = watchdogLaneIds.has(lane.id)
        ? buildUnacknowledgedSupervisorIdlePrompt(lane)
        : stalledTaskLaneIds.has(lane.id)
          ? '[会话继续] 用户已处理任务 AI 长回合异常。先 read-screen 核对原任务终端和工作树，只根据当前证据决定返工或上报；不要重建任务终端或盲目重放旧命令。\n'
        : cancelledDecisionLaneIds.has(lane.id)
        ? '[会话继续] 用户已通过任务终端等其他方式发送信息，原待决项已取消。请保持原任务上下文，read-screen 后继续监督。\n'
        : '[会话继续] 用户已恢复当前监督会话。请保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n';
      queueOrdinarySupervisorControlDelivery(
        lane.id,
        message,
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

  const restoreSupervisorRuntime = async (lane: SupervisorLane): Promise<boolean> => {
    if (isProjectManagedSupervisorLane(lane) || runtimeRestoreInFlightLaneIds.has(lane.id)) return false;
    const latestLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id);
    if (!latestLane || supervisorLaneControlState(latestLane) === 'stopped') return false;
    const existingSupervisorSurfaceId = dedicatedSupervisorSurfaceId(latestLane);
    const currentLiveSurfaceIds = new Set(useStore.getState().workspaces.flatMap((workspace) => (
      getAllPaneIds(workspace.splitTree).flatMap((candidatePaneId) => (
        findLeaf(workspace.splitTree, candidatePaneId)?.surfaces.map((surface) => surface.id) || []
      ))
    )));
    if (!ordinarySupervisorRuntimeNeedsRestore(latestLane, currentLiveSurfaceIds)) {
      return !!existingSupervisorSurfaceId && focusSurface(existingSupervisorSurfaceId);
    }

    const taskLocation = locateSurface(latestLane.surfaceId);
    if (!taskLocation) {
      const detail = '绑定的任务终端已缺失，无法只恢复监督终端；请先恢复任务终端或使用恢复档案。';
      appendSupervisorLog(latestLane.id, '监督终端恢复失败', detail);
      setRuntimeRestoreNotices((current) => ({ ...current, [latestLane.id]: detail }));
      return false;
    }
    const configuredLaunchCommand = latestLane.supervisorLaunchCmdOverride
      || useStore.getState().supervisor.supervisorLaunchCmd;
    if (!configuredLaunchCommand.trim()) {
      const detail = '未配置监督 AI 启动命令，请先在监督配置中选择可用 Agent。';
      appendSupervisorLog(latestLane.id, '监督终端恢复失败', detail);
      setRuntimeRestoreNotices((current) => ({ ...current, [latestLane.id]: detail }));
      return false;
    }
    const currentSession = useStore.getState().supervisor;
    const launchCommand = buildSupervisorLaunchCommand(
      configuredLaunchCommand,
      latestLane.supervisorModelOverride ?? currentSession.supervisorModel,
      latestLane.supervisorReasoningEffortOverride ?? currentSession.supervisorReasoningEffort,
      { isolateSupervisor: true, projectDir: latestLane.projectDir, isolationKey: latestLane.id },
    );
    const binding = {
      laneId: latestLane.id,
      managementSessionId: latestLane.managementSessionId,
      taskSurfaceId: latestLane.surfaceId,
    };
    runtimeRestoreInFlightLaneIds.add(latestLane.id);
    setRuntimeRestoreLaneId(latestLane.id);
    setRuntimeRestoreNotices((current) => ({ ...current, [latestLane.id]: '正在恢复监督终端…' }));
    let newSupervisorSurfaceId: SurfaceId | null = null;
    let restoredRuntimeReady = false;
    try {
      newSupervisorSurfaceId = addSurface(
        taskLocation.workspace.id,
        taskLocation.paneId,
        'terminal',
        {
          customTitle: supervisorTabTitle(latestLane.label),
          shell: 'pwsh.exe',
          cwd: latestLane.projectDir,
          startupCommands: [launchCommand],
          transientSupervisor: true,
          supervisorRuntimeIsolationKey: latestLane.id,
        },
      );
      if (!newSupervisorSurfaceId) throw new Error('无法在任务终端所在窗格创建监督终端');
      useStore.getState().updateLane(
        latestLane.id,
        ordinarySupervisorRuntimeRestorePatch(latestLane, newSupervisorSurfaceId),
      );

      const ready = await waitForTerminalRuntimeReady(newSupervisorSurfaceId);
      const screen = readTerminalScreen(newSupervisorSurfaceId, 80).text || '';
      const reboundLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === binding.laneId);
      const bindingChanged = !reboundLane
        || reboundLane.managementSessionId !== binding.managementSessionId
        || reboundLane.surfaceId !== binding.taskSurfaceId
        || reboundLane.supervisorSurfaceId !== newSupervisorSurfaceId
        || supervisorLaneControlState(reboundLane) === 'stopped';
      if (bindingChanged) {
        const createdLocation = locateSurface(newSupervisorSurfaceId);
        if (createdLocation) closeSurface(createdLocation.workspace.id, createdLocation.paneId, newSupervisorSurfaceId);
        newSupervisorSurfaceId = null;
        throw new Error('恢复期间监督通道绑定已变化，已取消旧恢复结果');
      }
      if (!ready.ok || !interactiveAgentInputReady(screen)) {
        const detail = ready.error
          || interactiveAgentShellPromptFailureDetail(screen)
          || '新监督终端未进入可接收任务的 Agent 输入界面';
        markTerminalRuntimeFailed(newSupervisorSurfaceId, detail);
        const store = useStore.getState();
        store.updateLane(reboundLane.id, {
          supervisorProblem: { kind: 'runtime-failed', detail, detectedAt: Date.now() },
        });
        if (supervisorLaneControlState(reboundLane) === 'active') {
          store.pauseSupervisorLane(reboundLane.id, detail);
        }
        store.appendSupervisorLog(reboundLane.id, '监督终端恢复失败', detail);
        setRuntimeRestoreNotices((current) => ({ ...current, [reboundLane.id]: `恢复失败：${detail}` }));
        return false;
      }
      restoredRuntimeReady = true;

      const store = useStore.getState();
      let restoredLane = store.supervisor.lanes.find((candidate) => candidate.id === reboundLane.id)!;
      if (restoredLane.supervisorProblem?.kind === 'runtime-failed') {
        store.updateLane(restoredLane.id, { supervisorProblem: undefined });
        restoredLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === reboundLane.id)!;
      }
      const taskStates = (window as any).__wmux_getAgentStates?.() || {};
      queueOrdinarySupervisorControlDelivery(
        restoredLane.id,
        [
          '[监督终端恢复｜继续原监督通道]',
          '本次只替换已关闭或失效的监督运行时；原管理会话、任务、裁决、待复核项和控制状态继续有效。',
          buildSupervisorBriefing(useStore.getState().supervisor, {
            lane: restoredLane,
            state: String(taskStates[restoredLane.surfaceId]?.state || 'unknown'),
          }),
        ].join('\n'),
      );
      appendSupervisorRecord(useStore.getState().supervisor, restoredLane, 'supervisor.runtime-restored', {
        previousSurfaceId: existingSupervisorSurfaceId,
        supervisorSurfaceId: newSupervisorSurfaceId,
        managementSessionId: restoredLane.managementSessionId,
        controlState: supervisorLaneControlState(restoredLane),
      });
      store.appendSupervisorLog(
        restoredLane.id,
        '监督终端已恢复',
        `已保留原监督通道和${supervisorLaneControlState(restoredLane) === 'active' ? '运行中' : '当前'}状态`,
      );
      if (existingSupervisorSurfaceId && existingSupervisorSurfaceId !== newSupervisorSurfaceId) {
        const previousLocation = locateSurface(existingSupervisorSurfaceId);
        if (previousLocation) {
          closeSurface(previousLocation.workspace.id, previousLocation.paneId, existingSupervisorSurfaceId);
        }
      }
      focusSurface(newSupervisorSurfaceId);
      setRuntimeRestoreNotices((current) => ({
        ...current,
        [restoredLane.id]: '监督终端已恢复；原任务、裁决、待复核项和控制状态均已保留。',
      }));
      return true;
    } catch (error) {
      const detail = String((error as Error)?.message || error);
      if (newSupervisorSurfaceId) {
        const currentLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === latestLane.id);
        if (currentLane?.supervisorSurfaceId !== newSupervisorSurfaceId) {
          const createdLocation = locateSurface(newSupervisorSurfaceId);
          if (createdLocation) closeSurface(createdLocation.workspace.id, createdLocation.paneId, newSupervisorSurfaceId);
        } else if (!restoredRuntimeReady) {
          markTerminalRuntimeFailed(newSupervisorSurfaceId, detail);
          useStore.getState().updateLane(currentLane.id, {
            supervisorProblem: { kind: 'runtime-failed', detail, detectedAt: Date.now() },
          });
          if (supervisorLaneControlState(currentLane) === 'active') {
            useStore.getState().pauseSupervisorLane(currentLane.id, detail);
          }
        }
      }
      appendSupervisorLog(
        latestLane.id,
        restoredRuntimeReady ? '监督终端恢复说明投递失败' : '监督终端恢复失败',
        detail,
      );
      setRuntimeRestoreNotices((current) => ({
        ...current,
        [latestLane.id]: restoredRuntimeReady
          ? `监督终端已恢复，但恢复说明投递失败：${detail}`
          : `恢复失败：${detail}`,
      }));
      return false;
    } finally {
      runtimeRestoreInFlightLaneIds.delete(latestLane.id);
      setRuntimeRestoreLaneId(null);
    }
  };

  const restoreMissingSupervisorRuntimes = async (): Promise<boolean> => {
    const targets = useStore.getState().supervisor.lanes.filter((candidate) => (
      !isProjectManagedSupervisorLane(candidate)
      && ordinarySupervisorRuntimeNeedsRestore(candidate, new Set(useStore.getState().workspaces.flatMap((workspace) => (
        getAllPaneIds(workspace.splitTree).flatMap((candidatePaneId) => (
          findLeaf(workspace.splitTree, candidatePaneId)?.surfaces.map((surface) => surface.id) || []
        ))
      ))))
    ));
    for (const target of targets) {
      if (!await restoreSupervisorRuntime(target)) return false;
    }
    return targets.length > 0;
  };

  const resumeLane = async (lane: SupervisorLane) => {
    if (isProjectManagedSupervisorLane(lane)) return;
    const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
    if (!supervisorSurfaceId
      || !liveSurfaceIds.has(supervisorSurfaceId)
      || lane.supervisorProblem?.kind === 'runtime-failed') {
      if (!await restoreSupervisorRuntime(lane)) return;
    }
    const currentLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane;
    const retriesWatchdog = currentLane.supervisorProblem?.kind === 'unreported-decision';
    const clearsTaskStall = currentLane.supervisorProblem?.kind === 'task-stalled';
    resumeSupervisorLane(currentLane.id, `用户继续 ${currentLane.label}；其他监督通道状态不变`);
    if (retriesWatchdog) {
      updateLane(lane.id, {
        reviewWatchdogState: 'retrying',
        reviewDeliveryConfirmedAt: undefined,
        unreportedIdleRecoveryAttempts: 1,
        supervisorProblem: undefined,
      });
    } else if (clearsTaskStall) {
      updateLane(lane.id, { supervisorProblem: undefined });
    }
    appendSupervisorRecord(useStore.getState().supervisor, currentLane, 'supervisor.lane-control', { action: 'resume' });
    if (useStore.getState().supervisor.active
      && !useStore.getState().supervisor.pendingApprovals.some((item) => item.laneId === currentLane.id)) {
      queueOrdinarySupervisorControlDelivery(
        currentLane.id,
        retriesWatchdog
          ? buildUnacknowledgedSupervisorIdlePrompt(currentLane)
          : clearsTaskStall
            ? '[通道继续] 用户已处理任务 AI 长回合异常。先 read-screen 核对原任务终端和工作树，只根据当前证据返工；不要重建任务终端或盲目重放旧命令。\n'
          : '[通道继续] 用户已恢复此监督通道。保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n',
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
        lane.supervisorLaunchCmdOverride || supervisor.supervisorLaunchCmd,
        lane.supervisorModelOverride ?? supervisor.supervisorModel,
        lane.supervisorReasoningEffortOverride ?? supervisor.supervisorReasoningEffort,
        { isolateSupervisor: true, projectDir: lane.projectDir, isolationKey: lane.id },
      );
      const newSurfaceId = addSurface(location!.workspaceId, location!.paneId, 'terminal', {
        customTitle: supervisorTabTitle(lane.label),
        shell: 'pwsh.exe',
        cwd: lane.projectDir,
        startupCommands: [launchCommand],
        transientSupervisor: true,
        supervisorRuntimeIsolationKey: lane.id,
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
    void (async () => {
      let session = useStore.getState().supervisor;
      if (!session.active || session.sessionId !== sessionId) return;
      for (const lane of session.lanes.filter((candidate) => !isProjectManagedSupervisorLane(candidate))) {
        const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
        if (!supervisorSurfaceId) continue;
        const ready = await waitForTerminalRuntimeReady(supervisorSurfaceId);
        const screen = readTerminalScreen(supervisorSurfaceId, 80).text || '';
        if (!ready.ok || !interactiveAgentInputReady(screen)) {
          const detail = ready.error
            || interactiveAgentShellPromptFailureDetail(screen)
            || '未检测到可接收监督任务的 Agent 输入界面；已禁止向未知终端发送监督协议';
          markTerminalRuntimeFailed(supervisorSurfaceId, detail);
          const store = useStore.getState();
          store.updateLane(lane.id, {
            supervisorProblem: { kind: 'runtime-failed', detail, detectedAt: Date.now() },
          });
          store.pauseSupervisorLane(lane.id, detail);
          store.appendSupervisorLog(lane.id, '监督 Agent 未就绪', detail);
          continue;
        }
        session = useStore.getState().supervisor;
        const currentLane = session.lanes.find((candidate) => candidate.id === lane.id);
        if (!session.active || session.sessionId !== sessionId || !currentLane
          || supervisorLaneControlState(currentLane) !== 'active') continue;
        const states = (window as any).__wmux_getAgentStates?.() || {};
        const text = buildSupervisorBriefing(session, {
          lane: currentLane,
          state: String(states[currentLane.surfaceId]?.state || 'unknown'),
        });
        queueOrdinarySupervisorControlDelivery(
          currentLane.id,
          text,
          { bootstrapOnRuntimeReady: true },
        );
      }
    })().catch((error) => {
      appendSupervisorLog('-', '监督 Agent 重启失败', error instanceof Error ? error.message : String(error));
    });
  };

  const clearStandingDecisions = (lane: SupervisorLane) => {
    if (isProjectManagedSupervisorLane(lane)) return;
    const planRevision = effectiveSupervisorLaneConfig(lane).planRevision || 1;
    if (!window.confirm('清除当前规划版本内记录的全部“同类问题沿用”决定？之后遇到相关问题时，监督 AI 可以重新询问。')) return;
    updateLane(lane.id, {
      standingUserDecision: undefined,
      standingUserDecisions: undefined,
    });
    queueOrdinarySupervisorControlDelivery(
      lane.id,
      `[持续用户决策已清除] 用户已撤销当前规划版本 r${planRevision} 内的“同类问题沿用”记录。后续不得继续引用已撤销的决定；确有需要时可重新请求用户决策。`,
      { kind: 'owner-decision' },
    );
    appendSupervisorRecord(supervisor, lane, 'supervisor.user-guidance', {
      action: 'standing-decisions-cleared',
      planRevision,
    });
    appendSupervisorLog(lane.id, '已清除持续用户决策', `规划版本 r${planRevision}`);
  };

  const saveTerminalSnapshot = async (lane: SupervisorLane): Promise<SupervisorSnapshotSaveResult> => {
    if (!lane.projectDir || isProjectManagedSupervisorLane(lane)) {
      return { ok: false, error: '当前终端没有可保存的普通监督项目上下文' };
    }
    if (snapshotSaveInFlightLaneIds.has(lane.id)) {
      return { ok: false, error: '此终端的监督进度正在保存，请等待当前保存完成' };
    }
    snapshotSaveInFlightLaneIds.add(lane.id);
    setSnapshotActionLaneId(lane.id);
    setSnapshotNotices((current) => ({ ...current, [lane.id]: '正在采集终端与项目上下文…' }));
    try {
      const before = terminalSnapshotConsistency(lane);
      let terminalSurface: SurfaceRef | undefined;
      let terminalWorkspace = workspaces.find((workspace) => workspace.id === lane.workspaceId);
      let terminalPaneId = lane.paneId;
      if (terminalWorkspace && terminalPaneId) {
        terminalSurface = findLeaf(terminalWorkspace.splitTree, terminalPaneId)?.surfaces
          .find((surface) => surface.id === lane.surfaceId);
      }
      if (!terminalSurface) {
        for (const workspace of workspaces) {
          for (const candidatePaneId of getAllPaneIds(workspace.splitTree)) {
            const surface = findLeaf(workspace.splitTree, candidatePaneId)?.surfaces
              .find((candidate) => candidate.id === lane.surfaceId);
            if (!surface) continue;
            terminalSurface = surface;
            terminalWorkspace = workspace;
            terminalPaneId = candidatePaneId;
            break;
          }
          if (terminalSurface) break;
        }
      }
      if (!terminalSurface || !terminalWorkspace || !terminalPaneId) throw new Error('被监督终端已不存在');
      const api = (window as any).wmux?.supervisor;
      if (!api?.captureRecoveryContext || !api?.saveRecoverySnapshot) throw new Error('恢复档案接口尚未就绪');
      const latestDecision = lane.decisions?.[0];
      const taskDispatch = latestDecision?.taskDispatch;
      const verifiedEvidence = [
        ...(taskDispatch?.evidenceContext || []),
        ...(latestDecision?.ordinaryPlan?.milestones || []).flatMap((milestone) => milestone.evidence ? [milestone.evidence] : []),
      ].map(redactProjectSafeExitExcerpt);
      const acceptanceGaps = taskDispatch?.acceptanceGap || latestDecision?.ordinaryPlan?.remainingWork || [];
      const terminalScreen = redactProjectSafeExitExcerpt(
        readTerminalScreen(lane.surfaceId, 120).text || '',
      );
      const captured = await api.captureRecoveryContext({
        projectDir: lane.projectDir,
        planFilePaths: effectiveSupervisorLaneConfig(lane).planFilePath
          ? [effectiveSupervisorLaneConfig(lane).planFilePath]
          : [],
        currentTask: lane.currentTask || '',
        verifiedEvidence,
        acceptanceGaps,
        terminalScreenTail: terminalScreen,
      });
      if (!captured?.ok || !captured.projectContext) throw new Error(captured?.error || '项目上下文采集失败');
      const currentLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id);
      if (!currentLane || terminalSnapshotConsistency(currentLane) !== before) {
        throw new Error('保存期间任务回合、规划或终端绑定发生变化；旧档案保持不变，请重新保存');
      }
      const currentSession = useStore.getState().supervisor;
      const agentMeta = useStore.getState().agentMeta.get(lane.surfaceId);
      const config = effectiveSupervisorLaneConfig(currentLane);
      const savedControlState = supervisorLaneControlState(currentLane);
      const taskAgentExecutable = supportedAgentLauncherExecutable(terminalSurface.startupCommands?.[0] || '')
        || taskAgentExecutableFromLabel(agentMeta?.label);
      const snapshot: SupervisedTerminalSnapshot = {
        version: 1,
        snapshotId: currentLane.recoverySnapshotId || `snapshot-${uuid()}`,
        savedAt: Date.now(),
        terminal: {
          surfaceId: currentLane.surfaceId,
          workspaceId: terminalWorkspace.id,
          paneId: terminalPaneId,
          workspaceTitle: terminalWorkspace.title,
          label: currentLane.label,
          projectDir: lane.projectDir,
          cwd: terminalSurface.currentCwd || terminalSurface.cwd || lane.projectDir,
          shell: terminalSurface.shell || 'pwsh.exe',
          customTitle: terminalSurface.customTitle,
          startupCommands: taskAgentExecutable ? [taskAgentExecutable] : undefined,
          agent: taskAgentExecutable || agentMeta?.label,
          agentState: visibleAgentStates[lane.surfaceId]?.state,
          screenTail: terminalScreen,
        },
        supervisor: {
          surfaceId: dedicatedSupervisorSurfaceId(currentLane) || undefined,
          launchCmd: currentLane.supervisorLaunchCmdOverride || currentSession.supervisorLaunchCmd,
          model: currentLane.supervisorModelOverride ?? currentSession.supervisorModel,
          reasoningEffort: currentLane.supervisorReasoningEffortOverride ?? currentSession.supervisorReasoningEffort,
          config,
          autonomous: effectiveSupervisorAutonomous(currentSession, currentLane),
          autonomyPermissions: effectiveSupervisorAutonomyPermissions(currentSession, currentLane),
          forbiddenActions: effectiveSupervisorForbiddenActions(currentSession, currentLane),
          workScope: effectiveSupervisorWorkScope(currentSession, currentLane),
          state: {
            controlState: savedControlState === 'stopped'
              ? 'paused'
              : savedControlState,
            currentTask: currentLane.currentTask || '',
            workerTurnId: currentLane.workerTurnId || 0,
            decisions: [...(currentLane.decisions || [])],
            ordinaryPlan: latestDecision?.ordinaryPlan,
            ordinaryBlocker: currentLane.ordinaryBlocker,
            ordinaryContextHealth: currentLane.ordinaryContextHealth,
            ordinaryContextReset: currentLane.ordinaryContextReset?.status === 'failed'
              ? currentLane.ordinaryContextReset
              : undefined,
            ordinaryContextResetCount: currentLane.ordinaryContextResetCount,
            ordinaryContextResetPlanRevision: currentLane.ordinaryContextResetPlanRevision,
            goalVortex: currentLane.goalVortex,
            latestSupervisorUserGuidance: currentLane.latestSupervisorUserGuidance,
            standingUserDecision: currentLane.standingUserDecision,
            standingUserDecisions: currentLane.standingUserDecisions,
            latestEvidence: verifiedEvidence,
            acceptanceGaps,
          },
        },
        projectContext: captured.projectContext,
        consistency: {
          laneId: currentLane.id,
          managementSessionId: currentLane.managementSessionId,
          taskSurfaceId: currentLane.surfaceId,
          supervisorSurfaceId: dedicatedSupervisorSurfaceId(currentLane) || undefined,
          workerTurnId: currentLane.workerTurnId || 0,
          planRevision: config.planRevision || 1,
          decisionCount: currentLane.decisions?.length || 0,
        },
      };
      const saved = await api.saveRecoverySnapshot(snapshot);
      if (!saved?.ok || !saved.snapshot) throw new Error(saved?.error || '恢复档案写入失败');
      updateLane(lane.id, {
        recoverySnapshotId: saved.snapshot.snapshotId,
        recoverySnapshotSavedAt: saved.snapshot.savedAt,
      });
      appendSupervisorLog(lane.id, '终端恢复档案已保存', `快照=${saved.snapshot.snapshotId}`);
      setSnapshotNotices((current) => ({
        ...current,
        [lane.id]: `已保存 · ${new Date(saved.snapshot.savedAt).toLocaleString('zh-CN', { hour12: false })}`,
      }));
      return {
        ok: true,
        snapshotId: saved.snapshot.snapshotId,
        savedAt: saved.snapshot.savedAt,
      };
    } catch (error) {
      const message = String((error as Error)?.message || error);
      setSnapshotNotices((current) => ({
        ...current,
        [lane.id]: `保存失败：${message}`,
      }));
      return { ok: false, error: message };
    } finally {
      snapshotSaveInFlightLaneIds.delete(lane.id);
      setSnapshotActionLaneId(null);
    }
  };

  useEffect(() => {
    if (expanded) return undefined;
    const handleSnapshotSave = (event: Event) => {
      const detail = (event as CustomEvent<SupervisorSnapshotSaveRequest>).detail;
      if (!detail?.surfaceId || typeof detail.resolve !== 'function') return;
      const lane = useStore.getState().supervisor.lanes.find((candidate) => (
        candidate.surfaceId === detail.surfaceId && !isProjectManagedSupervisorLane(candidate)
      ));
      if (!lane) {
        detail.resolve({ ok: false, error: '没有找到此终端的普通监督通道' });
        return;
      }
      void saveTerminalSnapshot(lane).then(detail.resolve);
    };
    window.addEventListener(SUPERVISOR_SNAPSHOT_SAVE_EVENT, handleSnapshotSave);
    return () => window.removeEventListener(SUPERVISOR_SNAPSHOT_SAVE_EVENT, handleSnapshotSave);
  }, [expanded, saveTerminalSnapshot]);

  const deleteTerminalSnapshot = async (lane: SupervisorLane) => {
    if (!lane.projectDir || !lane.recoverySnapshotId) return;
    setSnapshotActionLaneId(lane.id);
    try {
      const result = await (window as any).wmux?.supervisor?.deleteRecoverySnapshot?.({
        projectDir: lane.projectDir,
        snapshotId: lane.recoverySnapshotId,
      });
      if (!result?.ok) throw new Error(result?.error || '删除恢复档案失败');
      updateLane(lane.id, { recoverySnapshotId: undefined, recoverySnapshotSavedAt: undefined });
      if (supervisorLaneControlState(lane) === 'stopped') {
        stopSupervisorLane(lane.id, '恢复档案已删除，移除停止占位');
      }
      appendSupervisorLog(lane.id, '终端恢复档案已删除', '审计记录仍保留，但不再用于恢复');
      setSnapshotNotices((current) => ({ ...current, [lane.id]: '恢复档案已删除' }));
      setSnapshotDeleteLaneId(null);
    } catch (error) {
      setSnapshotNotices((current) => ({
        ...current,
        [lane.id]: `删除失败：${String((error as Error)?.message || error)}`,
      }));
    } finally {
      setSnapshotActionLaneId(null);
    }
  };

  const restoreTerminalSnapshot = async (lane: SupervisorLane) => {
    if (!lane.projectDir || !lane.recoverySnapshotId || isProjectManagedSupervisorLane(lane)) return;
    setSnapshotActionLaneId(lane.id);
    setSnapshotNotices((current) => ({ ...current, [lane.id]: '正在恢复任务终端与专属监督…' }));
    try {
      const api = (window as any).wmux?.supervisor;
      const loaded = await api?.readRecoverySnapshot?.({
        projectDir: lane.projectDir,
        snapshotId: lane.recoverySnapshotId,
      });
      if (!loaded?.ok || !loaded.snapshot) throw new Error(loaded?.error || '恢复档案不可用');
      const snapshot = loaded.snapshot as SupervisedTerminalSnapshot;
      let taskSurfaceId = snapshot.terminal.surfaceId as SurfaceId;
      let taskExists = false;
      for (const workspace of useStore.getState().workspaces) {
        for (const candidatePaneId of getAllPaneIds(workspace.splitTree)) {
          if (findLeaf(workspace.splitTree, candidatePaneId)?.surfaces.some((surface) => surface.id === taskSurfaceId)) {
            taskExists = true;
            break;
          }
        }
        if (taskExists) break;
      }
      const recoveryTask = buildSnapshotTaskRecovery(snapshot);
      const recoveryStartupInput = snapshot.supervisor.state.controlState === 'active'
        ? recoveryTask
        : undefined;
      if (!taskExists) {
        const agentExecutable = snapshotTaskAgentExecutable(snapshot);
        const startupCommands = snapshot.terminal.startupCommands?.length
          ? snapshot.terminal.startupCommands
          : agentExecutable ? [agentExecutable] : undefined;
        if (!startupCommands?.length) {
          throw new Error('快照缺少可安全重建任务 AI 的启动命令；请先创建对应 Agent 终端再恢复');
        }
        let targetWorkspace = useStore.getState().workspaces.find((workspace) => (
          workspace.id === snapshot.terminal.workspaceId
          || workspace.title === snapshot.terminal.workspaceTitle
        ));
        let targetPaneId = targetWorkspace && snapshot.terminal.paneId
          && getAllPaneIds(targetWorkspace.splitTree).includes(snapshot.terminal.paneId as PaneId)
          ? snapshot.terminal.paneId as PaneId
          : targetWorkspace ? getAllPaneIds(targetWorkspace.splitTree)[0] : undefined;
        if (!targetWorkspace || !targetPaneId) {
          const workspaceId = createWorkspace({
            title: snapshot.terminal.workspaceTitle || snapshot.terminal.label,
            cwd: snapshot.terminal.cwd || snapshot.terminal.projectDir,
            splitTree: createLeaf(),
          });
          targetWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === workspaceId);
          targetPaneId = targetWorkspace ? getAllPaneIds(targetWorkspace.splitTree)[0] : undefined;
          const initialSurface = targetWorkspace && targetPaneId
            ? findLeaf(targetWorkspace.splitTree, targetPaneId)?.surfaces[0]
            : undefined;
          if (!initialSurface || !targetPaneId) throw new Error('无法重建任务终端会话');
          taskSurfaceId = initialSurface.id;
          updateSurface(targetWorkspace!.id, targetPaneId, taskSurfaceId, {
            customTitle: snapshot.terminal.customTitle || snapshot.terminal.label,
            shell: snapshot.terminal.shell,
            cwd: snapshot.terminal.cwd,
            startupCommands,
            startupInput: recoveryStartupInput,
          });
        } else {
          const created = addSurface(targetWorkspace.id, targetPaneId, 'terminal', {
            customTitle: snapshot.terminal.customTitle || snapshot.terminal.label,
            shell: snapshot.terminal.shell,
            cwd: snapshot.terminal.cwd,
            startupCommands,
            startupInput: recoveryStartupInput,
          });
          if (!created) throw new Error('无法在原会话重建任务终端');
          taskSurfaceId = created;
        }
      }
      const control = (window as any).__wmux_supervisorRemoteControl;
      const started = control?.({
        action: 'start',
        terminals: [taskSurfaceId],
        taskGoal: snapshot.supervisor.config.taskGoal,
        taskDescription: snapshot.supervisor.config.taskDescription,
        preconditions: snapshot.supervisor.config.preconditions,
        supervisorNotes: snapshot.supervisor.config.supervisorNotes || '',
        stopWhen: snapshot.supervisor.config.stopWhen,
        stopWhenKind: snapshot.supervisor.config.stopWhenKind,
        planFile: snapshot.supervisor.config.planFilePath,
        autonomous: snapshot.supervisor.autonomous,
        autonomyPermissions: snapshot.supervisor.autonomyPermissions,
        supervisorLaunchCmd: snapshot.supervisor.launchCmd,
        supervisorModel: snapshot.supervisor.model,
        supervisorReasoningEffort: snapshot.supervisor.reasoningEffort,
        taskWorkMode: snapshot.supervisor.config.taskWorkMode,
        mainThreadResponsibility: snapshot.supervisor.config.mainThreadResponsibility,
        childThreadResponsibilities: snapshot.supervisor.config.childThreadResponsibilities,
        maxChildThreads: snapshot.supervisor.config.maxChildThreads,
        supervisorMayApproveThreads: snapshot.supervisor.config.supervisorMayApproveThreads,
        parallelizableOperations: snapshot.supervisor.config.parallelizableOperations,
        serializedOperations: snapshot.supervisor.config.serializedOperations,
        waitForNextDirection: snapshot.supervisor.config.waitForNextDirection,
        actor: 'desktop-snapshot-restore',
        recoverySnapshotId: snapshot.snapshotId,
      });
      if (!started?.ok) throw new Error(started?.error || '无法恢复监督通道');
      const restoredLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.surfaceId === taskSurfaceId);
      if (!restoredLane) throw new Error('监督通道已启动，但没有建立终端绑定');
      const restored = await restoreSelectedLaneHistory(restoredLane, {
        snapshotId: snapshot.snapshotId,
        surfaceId: snapshot.terminal.surfaceId,
        label: snapshot.terminal.label,
        sessionId: snapshot.snapshotId,
      });
      if (restored) updateLane(restoredLane.id, {
        ...restored,
        ...(!taskExists ? {
          pendingInitialReview: true,
          awaitingReview: false,
          ordinaryContextHealth: undefined,
          ordinaryContextReset: undefined,
        } : {}),
      });
      const taskState = ((window as any).__wmux_getAgentStates?.() || {})[taskSurfaceId];
      if (taskExists && snapshot.supervisor.state.controlState === 'active'
        && String(taskState?.state || 'unknown') === 'idle') {
        sendTaskToSurface(
          taskSurfaceId,
          recoveryTask,
          true,
          supervisorLaneInputIsolationScope(restoredLane),
        );
      }
      if (snapshot.supervisor.state.controlState !== 'active') {
        const supervisorSurfaceId = dedicatedSupervisorSurfaceId(restoredLane);
        if (supervisorSurfaceId) {
          const ready = await waitForTerminalRuntimeReady(supervisorSurfaceId);
          if (ready.ok) {
            await new Promise<void>((resolve) => window.setTimeout(
              resolve,
              SUPERVISOR_TUI_READY_DELAY_MS + 500,
            ));
            updateLane(restoredLane.id, { controlState: snapshot.supervisor.state.controlState });
          }
        }
      }
      setSnapshotNotices((current) => ({
        ...current,
        [restoredLane.id]: taskExists
          ? '恢复完成：原任务终端继续工作，专属监督已重建'
          : '恢复完成：任务终端和专属监督已在同一会话重建',
      }));
    } catch (error) {
      setSnapshotNotices((current) => ({
        ...current,
        [lane.id]: `恢复失败：${String((error as Error)?.message || error)}`,
      }));
    } finally {
      setSnapshotActionLaneId(null);
    }
  };

  if (expanded && visibleLanes.length === 0 && scopedProjectWorkItems.length === 0) {
    if (!scopedProjectId && visibleRestoredStatusSurfaces.length > 0) {
      return (
        <div className="sup-panel sup-panel--recovery" data-paused="1">
          <div className="sup-panel__header sup-panel__header--static">
            <span className="sup-panel__dot" />
            <span className="sup-panel__title">
              {scopedOrdinaryStatusSurface ? '普通 AI 监督' : '监督 AI 中心'}
            </span>
            <span className="sup-panel__status">待恢复</span>
            <span className="sup-panel__meta-right">{visibleRestoredStatusSurfaces.length} 个状态页</span>
          </div>
          <div className="sup-panel__paused-notice">
            软件重启后普通监督 AI 运行时不会自动重放；状态页和任务终端仍保留。请从这里打开状态页，或重新配置监督以安全恢复。
          </div>
          <div className="sup-panel__lanes">
            {visibleRestoredStatusSurfaces.map((entry) => (
              <section key={entry.surface.id} className="sup-panel__lane">
                <div className="sup-panel__lane-head">
                  <strong>{entry.workspaceTitle}</strong>
                  <span>普通监督待恢复</span>
                </div>
                <div className="sup-panel__lane-detail">
                  状态页：{entry.surface.customTitle || '普通 AI 监督'}
                </div>
                <div className="sup-panel__lane-actions">
                  <button type="button" onClick={() => {
                    focusSurface(entry.surface.id);
                    onRequestClose?.();
                  }}>
                    打开状态页
                  </button>
                </div>
              </section>
            ))}
          </div>
          <div className="sup-panel__actions">
            <button type="button" className="sup-panel__btn-primary" onClick={() => {
              onRequestClose?.();
              openSupervisorSetup();
            }}>
              恢复或重新配置监督
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="sup-panel sup-panel--empty">
        <div className="sup-panel__empty-copy">
          {scopedProjectId ? '该项目的专属监督正在重建，或当前没有活动工作项。' : '尚未配置普通监督任务。'}
        </div>
      </div>
    );
  }

  if (!expanded && !shouldShowOrdinarySupervisorCenter(
    ordinaryLanes.length,
    ordinaryStatusSurfaces.length,
  )) return null;

  if (!expanded) {
    return (
      <>
        <div
          className="sup-panel sup-panel--compact"
          data-active={selectedCenterVisualState === 'active' ? '1' : '0'}
          data-paused={selectedCenterVisualState === 'waiting' || selectedCenterVisualState === 'paused' ? '1' : '0'}
          data-center-state={selectedCenterVisualState}
        >
          <button type="button" className="sup-panel__header" onClick={openSupervisorSession}>
            <span className="sup-panel__dot" />
            <span className="sup-panel__title">监督 AI 中心</span>
            <span className="sup-panel__status">{selectedCenterStatusLabel}</span>
            <span className="sup-panel__meta-right">
              {selectedCenterLane ? `当前：${selectedCenterLane.label}` : `${visibleChannelCount} 通道`}
            </span>
          </button>
          {selectedCenterLane && (
            <div className="sup-panel__goal" title={selectedCenterLane.currentTask || effectiveSupervisorLaneConfig(selectedCenterLane).taskGoal}>
              当前监督：{selectedCenterLane.label} · {selectedCenterExecution?.label || '状态未知'}
            </div>
          )}
          <div className="sup-panel__compact-actions">
            {selectedCenterLane && (
              <>
                <button type="button" onClick={() => focusSurface(selectedCenterLane.surfaceId)}>
                  打开任务终端
                </button>
                <button type="button" onClick={() => openOrdinarySupervisorStatusForTask(selectedCenterLane.surfaceId)}>
                  打开监督状态
                </button>
                <button
                  type="button"
                  onClick={() => void openLaneSupervisorTerminal(selectedCenterLane)}
                  disabled={selectedCenterControlState === 'stopped' || runtimeRestoreLaneId !== null}
                >
                  {runtimeRestoreLaneId === selectedCenterLane.id ? '连接中…' : '打开监督终端'}
                </button>
              </>
            )}
            {!selectedCenterLane && !ordinaryRetained && ordinaryLanes.length > 0 && !missingDedicatedSupervisor && (
              <button type="button" className="sup-panel__btn-primary" onClick={startFreshSupervisorSession}>
                启动普通监督
              </button>
            )}
          </div>
        </div>
        {centerOpen && createPortal(
          <div
            className="confirm-dialog__overlay supervisor-center-dialog__overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setCenterOpen(false);
            }}
          >
            <section className="supervisor-center-dialog" role="dialog" aria-modal="true" aria-label="监督 AI 中心">
              <header className="supervisor-center-dialog__header">
                <div className="supervisor-center-dialog__header-row">
                  <strong>普通监督 AI 中心</strong>
                  <span className="supervisor-center-dialog__status" data-visual-state={selectedCenterVisualState}>
                    {selectedCenterStatusLabel} · 普通监督 {activeOrdinaryCenterCount}
                  </span>
                </div>
                <span className="supervisor-center-dialog__subtitle" title={selectedCenterLane
                  ? selectedCenterLane.currentTask || effectiveSupervisorLaneConfig(selectedCenterLane).taskGoal
                  : undefined}>
                  {selectedCenterLane
                    ? `${selectedCenterLane.label} · ${selectedCenterLane.currentTask || effectiveSupervisorLaneConfig(selectedCenterLane).taskGoal || '等待任务上报'}`
                    : '集中查看普通监督状态并打开对应终端'}
                </span>
              </header>
              <div className="supervisor-center-dialog__body">
                <section className="supervisor-center-dialog__portfolio">
                  <div className="supervisor-center-dialog__section-head">
                    <strong>普通监督（{activeOrdinaryCenterCount} 个活动）</strong>
                    <button
                      type="button"
                      className="confirm-dialog__btn"
                      onClick={() => {
                        setCenterOpen(false);
                        openSupervisorSetup();
                      }}
                    >添加普通监督 AI</button>
                  </div>
                  <SupervisorPanel
                    expanded
                    agentStates={agentStates}
                    onRequestClose={() => setCenterOpen(false)}
                    centerSelectedLaneId={selectedCenterLane?.id || null}
                    onCenterLaneSelect={selectCenterLane}
                  />
                </section>
              </div>
              <footer className="supervisor-center-dialog__footer">
                <span />
                <button type="button" className="confirm-dialog__btn" onClick={() => setCenterOpen(false)}>关闭</button>
              </footer>
            </section>
          </div>,
          document.body,
        )}
      </>
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
        <span className="sup-panel__title">
          {scopedProjectId ? '监督 AI' : scopedOrdinaryLaneId ? '普通 AI 监督' : '监督 AI 中心'}
        </span>
        <span className="sup-panel__status">{statusLabel}</span>
        <span className="sup-panel__meta-right">
          {visibleChannelCount} 通道{waiting.length > 0 ? ` · ${waiting.length} 待续` : ''}{!scopedProjectId && supervisor.autonomous ? ' · 全自动' : ''}
          {pendingCount > 0 ? ` · ${pendingCount} 待批` : ''}
        </span>
      </button>

      {!collapsed && (
        <>
          {!ordinaryCenterMode && ordinaryPaused.length > 0 && (
            <div className="sup-panel__paused-notice">
              {missingDedicatedSupervisor
                ? '部分监督终端离线；从对应通道打开监督终端即可重新连接，原任务、裁决、待复核项和暂停状态不会被清空。'
                : scopedOrdinaryLaneId
                  ? '此监督已暂停；任务上下文、监督终端和待决项均已保留。'
                  : '会话已暂停；任务上下文、监督终端和待决项均已保留。可选择“全部继续”或只继续某个通道。'}
            </div>
          )}
          {!ordinaryCenterMode && ordinaryWaiting.length > 0 && (
            <div className="sup-panel__waiting-notice" role="status">
              当前有 {ordinaryWaiting.length} 个普通监督通道处于待续状态，正在等待用户提供新方案或下一步方向。
            </div>
          )}
          {!scopedProjectId && !scopedOrdinaryLaneId && restoredOnlyStatusSurfaces.length > 0 && (
            <section className="sup-panel__restored-statuses" aria-label="待恢复的普通监督">
              <strong>待恢复监督</strong>
              <span>软件重启后仍保留 {restoredOnlyStatusSurfaces.length} 个状态页</span>
              <div className="sup-panel__lane-actions">
                {restoredOnlyStatusSurfaces.map((entry) => (
                  <button key={entry.surface.id} type="button" onClick={() => {
                    focusSurface(entry.surface.id);
                    onRequestClose?.();
                  }}>
                    {entry.workspaceTitle}
                  </button>
                ))}
                <button type="button" className="sup-panel__btn-primary" onClick={() => {
                  onRequestClose?.();
                  openSupervisorSetup();
                }}>
                  恢复或重新配置
                </button>
              </div>
            </section>
          )}
          {scopedProjectId && waiting.length > 0 && (
            <div className="sup-panel__waiting-notice" role="status">
              当前项目有 {waiting.length} 个监督通道待续，由该项目管理 AI 处理；普通监督不会接管。
            </div>
          )}
          {!scopedProjectId && !ordinaryCenterMode && ordinaryLanes.length > 0 && (
            <section className="sup-panel__summary" aria-label="普通监督运行总览">
              <div><span>状态</span><strong>{statusLabel}</strong></div>
              <div><span>监督通道</span><strong>{ordinaryBoundLanes.length}</strong></div>
              <div><span>任务执行中</span><strong>{ordinaryWorkingCount}</strong></div>
              <div data-attention={ordinaryAttentionCount > 0 ? '1' : '0'}><span>待处理</span><strong>{ordinaryAttentionCount}</strong></div>
            </section>
          )}
          {scopedProjectId && (
            <section className="sup-panel__project-scope-summary" aria-label="项目监督范围">
              <div>
                <strong>当前项目监督</strong>
                <span>{visibleLanes.length} 个通道 · 只接受当前项目 AI 的成果任务</span>
              </div>
              <button type="button" onClick={() => openProjectManagerConsole(scopedProjectId)}>打开项目管理</button>
            </section>
          )}
          {!scopedProjectId && !ordinaryCenterMode && ordinaryLanes.length > 0 && (
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
              const laneStandingDecisions = laneProjectManaged
                ? []
                : activeStandingUserDecisions(lane, laneConfig.planRevision || 1);
              const laneTaskWorkMode = normalizeTaskWorkMode(laneConfig.taskWorkMode);
              const laneTaskWorkModeLabel = laneTaskWorkMode === 'multi-thread'
                ? `多线程工程（主线程 + ${normalizeTaskChildThreadResponsibilities(laneConfig.childThreadResponsibilities).length} 个子线程）`
                : laneTaskWorkMode === 'adaptive'
                  ? `自适应线程（最多 ${normalizeTaskMaxChildThreads(laneConfig.maxChildThreads)} 个内部子线程）`
                  : '单线程工作';
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
              const managedWorkItem = laneProjectManaged
                ? scopedProjectWorkItems.find((item) => item.id === lane.projectWorkItemId)
                : undefined;
              const managedTransition = laneProjectManaged
                ? [...(scopedProject?.pendingSupervisorTransitions || [])].reverse().find((transition) => (
                    transition.laneId === lane.id
                    || (!!managedWorkItem && transition.workItemId === managedWorkItem.id)
                  ))
                : undefined;
              const supervisorAssignmentPending = managedWorkItem
                ? isProjectSupervisorAssignmentPending({
                    workItemStatus: managedWorkItem.status,
                    workItemLaneId: managedWorkItem.supervisorLaneId,
                    workItemAssignmentVersion: managedWorkItem.assignmentVersion,
                    laneId: lane.id,
                    laneAssignmentVersion: lane.projectAssignmentVersion,
                    laneControlState,
                    laneAwaitingReview: lane.awaitingReview,
                    taskContractPending: lane.projectTaskContractPending,
                    latestBlocker: managedWorkItem.latestBlocker,
                  })
                : false;
              const managedStatus = managedWorkItem
                ? summarizeProjectManagedStatus({
                    workItemStatus: managedWorkItem.status,
                    laneControlState,
                    pendingTransition: managedTransition,
                    latestBlocker: managedWorkItem.latestBlocker,
                    supervisorAssignmentPending,
                  })
                : undefined;
              const managedCompletion = managedWorkItem
                ? projectWorkItemCompletionResult(managedWorkItem)
                : undefined;
              const completion = !laneProjectManaged
                && latestDecision?.outcome === 'complete'
                && (lane.stopConfirmed || laneControlState === 'waiting' || laneControlState === 'stopped')
                ? latestDecision.completion || {
                    summary: latestDecision.reason || '监督 AI 已确认达到停止条件',
                    validation: laneConfig.stopWhen ? [laneConfig.stopWhen] : [],
                    completedAt: latestDecision.ts,
                  }
                : undefined;
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
                projectTaskBatch: lane.projectTaskBatch,
                pendingTransition: managedTransition,
                workItemStatus: managedWorkItem?.status,
                latestBlocker: managedWorkItem?.latestBlocker,
                supervisorAssignmentPending,
              });
              const managedOutcome = managedCompletion?.summary
                || lane.currentTask
                || laneConfig.taskGoal
                || '等待任务上报';
              const managedOutcomeDetail = managedCompletion
                ? `完成于 ${new Date(managedCompletion.completedAt).toLocaleString('zh-CN', { hour12: false })}`
                : laneConfig.taskDescription || '成果合同已由项目 AI 下发';
              const laneNeedsHuman = !laneProjectManaged && (
                supervisor.pendingApprovals.some((approval) => approval.laneId === lane.id)
                || lane.awaitingStopCheck
                || lane.autoDecisionLimitReached === true
              );
              const laneStatusLabel = managedStatus?.supervisorLabel || (laneNeedsHuman
                ? '需人工处理'
                : laneControlState === 'waiting'
                  ? '待续'
                  : lane.stopConfirmed
                    ? '已达停止条件'
                    : laneControlState === 'active'
                    ? '监督中'
                    : laneControlState === 'paused'
                      ? '已暂停'
                      : '已停止');
              const laneHeader = (
                <>
                  <span className="sup-panel__lane-label">{lane.label}</span>
                  <span className="sup-panel__lane-progress">
                    {laneProjectManaged ? (
                      <>项目监督 · {laneStatusLabel} · {(lane.decisions || []).length} 次裁决</>
                    ) : (
                      <span className="sup-panel__lane-status-pill" data-state={laneNeedsHuman ? 'needs-human' : laneControlState}>{laneStatusLabel}</span>
                    )}
                  </span>
                </>
              );
              if (ordinaryCenterMode && !laneProjectManaged) {
                const centerLaneExpanded = expandedCenterLaneIds.has(lane.id);
                const centerLaneSelected = selectedCenterLane?.id === lane.id;
                const centerLaneTaskState = visibleAgentStates[lane.surfaceId];
                const centerLaneVisualState = ordinaryCenterVisualState(
                  lane,
                  centerLaneTaskState,
                  liveSurfaceIds,
                  laneNeedsHuman,
                );
                return (
                  <article
                    key={lane.id}
                    className="sup-panel__center-lane"
                    data-selected={centerLaneSelected ? '1' : '0'}
                    data-visual-state={centerLaneVisualState}
                    data-attention={centerLaneVisualState === 'error' ? '1' : '0'}
                    data-needs-human={laneNeedsHuman ? '1' : '0'}
                  >
                    <button
                      type="button"
                      className="sup-panel__center-lane-select sup-panel__lane-toggle"
                      aria-expanded={centerLaneExpanded}
                      aria-pressed={centerLaneSelected}
                      onClick={() => {
                        selectCenterLane(lane.id);
                        setExpandedCenterLaneIds((current) => {
                          const next = new Set(current);
                          if (next.has(lane.id)) next.delete(lane.id);
                          else next.add(lane.id);
                          return next;
                        });
                      }}
                    >
                      {laneHeader}
                    </button>
                    {centerLaneExpanded && (
                      <div className="sup-panel__center-lane-body">
                        <div className="sup-panel__center-lane-info">
                          <div><span>任务目标</span><strong>{lane.currentTask || laneConfig.taskGoal || '等待任务上报'}</strong></div>
                          <div><span>任务 AI</span><strong>{executionStatus.label}</strong></div>
                          <div><span>监督状态</span><strong>{planView.modeLabel}</strong></div>
                          <div><span>监督终端</span><strong>{dedicatedSupervisorSurfaceId(lane) ? '已连接' : '未连接'}</strong></div>
                        </div>
                        {lane.supervisorProblem && (
                          <div className="sup-panel__waiting-notice" role="alert">{lane.supervisorProblem.detail}</div>
                        )}
                        <div className="sup-panel__lane-actions">
                          <button type="button" onClick={() => {
                            focusSurface(lane.surfaceId);
                            onRequestClose?.();
                          }}>
                            打开任务终端
                          </button>
                          <button type="button" onClick={() => {
                            openOrdinarySupervisorStatusForTask(lane.surfaceId);
                            onRequestClose?.();
                          }}>
                            打开监督状态
                          </button>
                          {laneControlState !== 'stopped' && (
                            <button type="button" onClick={() => {
                              void openLaneSupervisorTerminal(lane);
                              onRequestClose?.();
                            }} disabled={runtimeRestoreLaneId !== null}>
                              {runtimeRestoreLaneId === lane.id ? '连接中…' : '打开监督终端'}
                            </button>
                          )}
                          {(laneControlState === 'active' || laneControlState === 'waiting') && (
                            <button type="button" onClick={() => pauseLane(lane)}>暂停此监督</button>
                          )}
                          {laneControlState === 'paused' && (
                            <button
                              type="button"
                              className="sup-panel__btn-primary"
                              onClick={() => void resumeLane(lane)}
                              disabled={runtimeRestoreLaneId !== null}
                            >
                              继续此监督
                            </button>
                          )}
                          {laneControlState !== 'stopped' && (
                            <button type="button" onClick={() => stopLane(lane)}>停止此监督</button>
                          )}
                        </div>
                      </div>
                    )}
                  </article>
                );
              }
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
                  {laneDetailsCollapsed && completion && (
                    <div className="sup-panel__project-plan-latest">完成结果：{completion.summary}</div>
                  )}
                  {!laneDetailsCollapsed && (
                    <>
                  {!laneProjectManaged && lane.supervisorProblem && (
                    <div className="sup-panel__waiting-notice" role="alert">
                      {lane.supervisorProblem.detail}
                    </div>
                  )}
                  {!laneProjectManaged && lane.ordinaryContextReset && (
                    <div className="sup-panel__waiting-notice" role={lane.ordinaryContextReset.status === 'failed' ? 'alert' : 'status'}>
                      {lane.ordinaryContextReset.status === 'clearing'
                        ? '正在清空任务 AI 上下文…'
                        : lane.ordinaryContextReset.status === 'recovering'
                          ? '上下文已清空，正在重新发布可信任务摘要…'
                          : `上下文清空失败：${lane.ordinaryContextReset.error || '请交给用户处理'}`}
                    </div>
                  )}
                  {!laneProjectManaged && !lane.ordinaryContextReset && lane.ordinaryContextHealth && (
                    <div className="sup-panel__waiting-notice" role="status">
                      已发现任务 AI 上下文退化迹象（{lane.ordinaryContextHealth.occurrences}/2）；首次先由监督 AI 派发纠偏任务。
                    </div>
                  )}
                  {!laneProjectManaged && (
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
                        {laneStandingDecisions.length > 0 && <span>持续决策 {laneStandingDecisions.length}</span>}
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
                          {completion ? <div className="sup-panel__ordinary-plan-grid">
                            <div>
                              <span>完成结果</span>
                              <strong>{completion.summary}</strong>
                              <small>{completion.evidence || '结果摘要已记录'}</small>
                              {!!completion.criteria?.length && <small>{formatProjectCompletionCriteria(completion)}</small>}
                            </div>
                            <div>
                              <span>完成验证</span>
                              <strong>{completion.validation.join('；') || '监督已确认停止条件'}</strong>
                              <small>完成时间：{new Date(completion.completedAt).toLocaleString('zh-CN', { hour12: false })}</small>
                            </div>
                          </div> : <>
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
                          </>}
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
                                    <p>决策依据：{decision.reason
                                      || decision.taskDispatch?.evidenceContext.join('；')
                                      || (decision.taskDispatch?.acceptanceGap.length
                                        ? `当前成果仍有 ${decision.taskDispatch.acceptanceGap.length} 项验收缺口`
                                        : `依据当前终端证据作出 ${SUPERVISOR_DECISION_OUTCOME_LABELS[decision.outcome] || decision.outcome} 裁决`)}</p>
                                    <small><b>→ 下发成果</b>{decision.taskDispatch?.outcome || decision.next || '本次裁决不下发新任务'}</small>
                                    {decision.taskDispatch?.acceptanceGap.length ? (
                                      <small><b>本次完成定义</b>{decision.taskDispatch.acceptanceGap.join('；')}</small>
                                    ) : null}
                                    {decision.taskDispatch?.verification ? (
                                      <small><b>验证可行性</b>{ORDINARY_VERIFICATION_FEASIBILITY_LABELS[decision.taskDispatch.verification.feasibility]}</small>
                                    ) : null}
                                    {decision.taskDispatch?.verification?.expectedEvidence.length ? (
                                      <small><b>期望证据</b>{decision.taskDispatch.verification.expectedEvidence.join('；')}</small>
                                    ) : null}
                                    {decision.taskDispatch?.verification?.fallbackWhenUnavailable.length ? (
                                      <small><b>验证受限回退</b>{decision.taskDispatch.verification.fallbackWhenUnavailable.join('；')}</small>
                                    ) : null}
                                    {decision.taskDispatch?.returnWhen?.length ? (
                                      <small><b>返回条件</b>{decision.taskDispatch.returnWhen.join('；')}</small>
                                    ) : null}
                                    {decision.goalVortex ? (
                                      <small><b>目标旋涡纠偏</b>{decision.goalVortex.decisiveNextStep}</small>
                                    ) : null}
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
                  <section className="sup-panel__managed-lane-overview" aria-label={`${lane.label} 的项目监督信息`}>
                    <div className="sup-panel__managed-compact-summary">
                      <div className="sup-panel__managed-status-line">
                        <span data-attention={managedStatus?.attention ? '1' : '0'}>任务 AI · {executionStatus.label}</span>
                        <span>监督 · {planView.modeLabel}</span>
                      </div>
                      <div className="sup-panel__managed-summary-row" title={managedOutcome}>
                        <span>{managedCompletion ? '当前结果' : '当前成果'}</span>
                        <strong>{managedOutcome}</strong>
                      </div>
                      <div className="sup-panel__managed-summary-row" title={planView.nextInstruction}>
                        <span>下一步</span>
                        <strong>{planView.nextInstruction}</strong>
                      </div>
                    </div>

                    {(managedWorkItem?.latestBlocker || managedStatus?.attention) && (
                      <div className="sup-panel__managed-lane-attention" role="alert">
                        <strong>{managedStatus?.workItemLabel || '需要处理'}</strong>
                        <span>{compactProjectAlertSummary(managedWorkItem?.latestBlocker || managedStatus?.detail || '当前工作项需要处理')}</span>
                      </div>
                    )}

                    {!!lane.pendingSupervisorDeliveries?.length && (
                      <div className="sup-panel__managed-lane-pending" role="status">
                        待投递监督通知：{lane.pendingSupervisorDeliveries.length} 条
                      </div>
                    )}

                    <details className="sup-panel__managed-lane-details">
                      <summary>查看成果、监督与合同详情</summary>
                      <div className="sup-panel__managed-lane-details-body">
                        <div className="sup-panel__managed-action-grid">
                          <article>
                            <span>成果说明</span>
                            <strong>{managedOutcomeDetail}</strong>
                          </article>
                          <article data-attention={managedStatus?.attention ? '1' : '0'}>
                            <span>任务 AI 状态</span>
                            <strong>{executionStatus.label}</strong>
                            <small>{executionStatus.detail}</small>
                          </article>
                          <article>
                            <span>监督正在做</span>
                            <strong>{planView.route}</strong>
                            <small>{managedStatus?.detail || '监督依据任务终端证据继续判断'}</small>
                          </article>
                        </div>

                        {(lane.decisions || []).length > 0 && (() => {
                          const decision = lane.decisions![0];
                          const decisionKindLabels: Record<string, string> = {
                            'route-adjustment': '小范围路线调整',
                            'route-change': '路线变更',
                            important: '重要建议',
                          };
                          const decisionKind = decision.proposalKind ? decisionKindLabels[decision.proposalKind] : '';
                          return <div className="sup-panel__managed-lane-decision">
                            <header>
                              <span>{managedStatus?.attention ? '最近历史裁决' : '最新裁决'}</span>
                              <strong>{decision.outcome}{decisionKind ? ` · ${decisionKind}` : ''}</strong>
                            </header>
                            <p>{compactProjectAlertSummary(decision.reason
                              || decision.taskDispatch?.outcome
                              || decision.next
                              || `依据当前终端证据完成 ${decision.outcome} 判定`)}</p>
                          </div>;
                        })()}

                        <details className="sup-panel__managed-lane-audit">
                          <summary>查看合同、权限与运行标识</summary>
                          <dl>
                            <dt>项目 / 任务终端</dt><dd>{lane.workspaceTitle || '当前项目'} · {lane.surfaceId}</dd>
                            <dt>成果目标</dt><dd>{laneConfig.taskGoal || '未配置'}</dd>
                            <dt>工作方式</dt><dd>{laneTaskWorkModeLabel}</dd>
                            <dt>完成后</dt><dd>{laneConfig.waitForNextDirection ? '待续，等待下一步方向' : '结束监督'}</dd>
                            <dt>停止条件</dt><dd>{stopWhenKindLabel(laneConfig.stopWhenKind)} · {laneConfig.stopWhen || '未配置'}</dd>
                            <dt>监督连接</dt><dd>{dedicatedSupervisorSurfaceId(lane) ? '已连接' : '未启动'}{lane.managementSessionId ? ` · 会话 ${lane.managementSessionId.slice(-8)}` : ''}</dd>
                            <dt>权限与范围</dt><dd>{laneAutonomous ? '全自动' : '有限自主'} · 允许 {lanePermissions.length}/{SUPERVISOR_AUTONOMY_PERMISSION_VALUES.length} · 禁止 {laneForbiddenActions.length} · {WORK_SCOPE_LABELS[laneWorkScope]}{lanePolicyOverridden ? '（终端专用）' : '（普通会话默认）'}</dd>
                            {managedCompletion && <>
                              <dt>完成验证</dt><dd>{managedCompletion.validation.join('；') || '监督已确认停止条件'}</dd>
                              <dt>完成证据</dt><dd>{managedCompletion.evidence || managedWorkItem?.latestEvidence || '结果摘要已记录'}</dd>
                              {!!managedCompletion.criteria?.length && <><dt>逐项核验</dt><dd>{formatProjectCompletionCriteria(managedCompletion)}</dd></>}
                            </>}
                            {laneConfig.preconditions && <><dt>前置条件</dt><dd>{laneConfig.preconditions}</dd></>}
                            {planFileName && <><dt>计划文件</dt><dd title={laneConfig.planFilePath}>{planFileName}</dd></>}
                          </dl>
                        </details>
                      </div>
                    </details>
                  </section>
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
                  <div className="sup-panel__lane-actions">
                    {!laneProjectManaged && laneControlState !== 'stopped' && (
                      <>
                        {!scopedOrdinaryLaneId && (
                          <button type="button" onClick={() => openOrdinarySupervisorStatusForTask(lane.surfaceId)}>
                            打开监督状态
                          </button>
                        )}
                        <button type="button" onClick={() => focusSurface(lane.surfaceId)}>
                          打开任务终端
                        </button>
                        <button
                          type="button"
                          onClick={() => void openLaneSupervisorTerminal(lane)}
                          disabled={runtimeRestoreLaneId !== null}
                        >
                          {runtimeRestoreLaneId === lane.id ? '连接中…' : '打开监督终端'}
                        </button>
                      </>
                    )}
                    {!laneProjectManaged && laneControlState === 'active' && (
                      <button type="button" onClick={() => pauseLane(lane)} disabled={!supervisor.active}>
                        暂停此监督
                      </button>
                    )}
                    {!laneProjectManaged && laneControlState === 'paused' && (
                      <button type="button" onClick={() => void resumeLane(lane)} disabled={!supervisor.active || runtimeRestoreLaneId !== null}>
                        继续此监督
                      </button>
                    )}
                    {!laneProjectManaged && laneControlState !== 'stopped' && (
                      <button type="button" onClick={() => stopLane(lane)}>
                        停止此监督
                      </button>
                    )}
                    {!laneProjectManaged && laneControlState === 'stopped' && lane.recoverySnapshotId && (
                      <button
                        type="button"
                        onClick={() => void restoreTerminalSnapshot(lane)}
                        disabled={snapshotActionLaneId === lane.id}
                      >
                        {snapshotActionLaneId === lane.id ? '恢复中…' : '恢复终端快照'}
                      </button>
                    )}
                    {!laneProjectManaged && laneControlState !== 'stopped' && (
                      <button
                        type="button"
                        onClick={() => void saveTerminalSnapshot(lane)}
                        disabled={snapshotActionLaneId === lane.id}
                      >
                        {snapshotActionLaneId === lane.id
                          ? '保存中…'
                          : lane.recoverySnapshotId ? '刷新恢复档案' : '保存恢复档案'}
                      </button>
                    )}
                    {!laneProjectManaged && lane.recoverySnapshotId && snapshotDeleteLaneId !== lane.id && (
                      <button type="button" onClick={() => setSnapshotDeleteLaneId(lane.id)}>
                        删除恢复档案
                      </button>
                    )}
                    {!laneProjectManaged && laneStandingDecisions.length > 0 && (
                      <button type="button" onClick={() => clearStandingDecisions(lane)}>
                        清除持续决策
                      </button>
                    )}
                    <button type="button" onClick={() => void openAuditTrail(lane)} disabled={loadingRecordLaneId === lane.id}>
                      {loadingRecordLaneId === lane.id ? '读取记录…' : '查看/刷新记录'}
                    </button>
                  </div>
                  {runtimeRestoreNotices[lane.id] && (
                    <div className="sup-panel__lane-supervisor" role="status">
                      {runtimeRestoreNotices[lane.id]}
                    </div>
                  )}
                  {!laneProjectManaged && snapshotDeleteLaneId === lane.id && (
                    <div className="sup-panel__approval-actions" role="alertdialog" aria-label={`确认删除 ${lane.label} 的恢复档案`}>
                      <span>删除后不能再从该快照恢复，审计记录仍保留。</span>
                      <button type="button" onClick={() => void deleteTerminalSnapshot(lane)} disabled={snapshotActionLaneId === lane.id}>
                        确认删除
                      </button>
                      <button type="button" onClick={() => setSnapshotDeleteLaneId(null)}>取消</button>
                    </div>
                  )}
                  {!laneProjectManaged && (lane.recoverySnapshotSavedAt || snapshotNotices[lane.id]) && (
                    <div className="sup-panel__lane-supervisor" role="status">
                      {snapshotNotices[lane.id]
                        || `恢复档案：${new Date(lane.recoverySnapshotSavedAt!).toLocaleString('zh-CN', { hour12: false })}`}
                    </div>
                  )}
                  {laneControlState === 'waiting' && (
                    <div className="sup-panel__lane-supervisor">
                      {laneProjectManaged
                        ? '待续中：由对应项目管理 AI 提供新任务契约或下一步方向。'
                        : '待续中：直接在对应 AI 监督终端说明新方案或下一步方向即可自动恢复；向任务终端发送新任务也可恢复，无需重新配置监督。'}
                    </div>
                  )}
                  {!laneProjectManaged && lane.awaitingStopCheck && !lane.stopConfirmed && (
                    <div style={{ marginTop: 6 }}>
                      <label className="sup-panel__proposal-edit">
                        <span>自定义意见（可选）</span>
                        <textarea
                          className="sup-panel__proposal-input"
                          value={stopConditionGuidance[lane.id] || ''}
                          maxLength={4000}
                          onChange={(event) => setStopConditionGuidance((current) => ({
                            ...current,
                            [lane.id]: event.target.value,
                          }))}
                          placeholder="可补充为什么已达到或尚未达到，以及希望监督下一步怎么处理"
                          disabled={!supervisor.active}
                        />
                      </label>
                      <div className="sup-panel__approval-actions">
                        <button type="button" onClick={() => resolveStopCondition(lane, false)} disabled={!supervisor.active}>
                          未达到
                        </button>
                        <button
                          type="button"
                          className="sup-panel__btn-primary"
                          onClick={() => resolveStopCondition(lane, true)}
                          disabled={!supervisor.active}
                        >
                          已达停止条件
                        </button>
                      </div>
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

          {!ordinaryCenterMode && visiblePendingApprovals.length > 0 && (
            <div className="sup-panel__approvals">
            <div className="sup-panel__approvals-title">需人工处理</div>
              {visiblePendingApprovals.map((a) => {
                const lane = supervisor.lanes.find((entry) => entry.id === a.laneId);
                const laneControlState = lane ? supervisorLaneControlState(lane) : 'stopped';
                const isClarification = a.proposalKind === 'clarification';
                const decisionOptions = a.proposalKind && !isClarification
                  ? supervisorDecisionOptions(a.alternatives, a.text)
                  : [];
                const recommendedOption = a.recommendedOption
                  || supervisorRecommendedOptionValue(decisionOptions, a.text);
                const selectedOption = proposalSelections[a.id] || '';
                const userGuidance = proposalGuidance[a.id] || '';
                const directDecision = proposalEdits[a.id] || '';
                const supervisorSurfaceId = lane ? dedicatedSupervisorSurfaceId(lane) : null;
                return (
                <div key={a.id} className={`sup-panel__approval${a.proposalKind ? ' sup-panel__confirmation-card project-manager-dialog__clarification' : ''}`}>
                  {a.proposalKind ? <header className="project-manager-dialog__clarification-header">
                    <div>
                      <span>普通监督 AI 需要你确认</span>
                      <strong>{isClarification ? '需求对齐后开始执行' : a.proposalKind === 'route-change' ? '确认是否调整当前路线' : a.proposalKind === 'important' ? '确认重要监督建议' : a.laneLabel}</strong>
                    </div>
                    <em>等待你的答复</em>
                  </header> : <div className="sup-panel__approval-head"><strong>{a.laneLabel}</strong></div>}
                  {a.proposalKind ? (
                    <div className="sup-panel__proposal">
                      <div className="project-manager-dialog__clarification-question">
                        {a.reason || (isClarification ? '请确认普通监督开始执行前需要对齐的事项' : 'AI 监督请求你确认下一步路线')}
                      </div>
                      <details className="project-manager-dialog__clarification-context">
                        <summary>查看当前任务、进展与影响</summary>
                        <div className="sup-panel__decision-overview">
                          <div className="sup-panel__decision-fact sup-panel__decision-fact--task">
                            <span>当前任务</span>
                            <div>{a.task || '任务终端暂未上报明确目标'}</div>
                          </div>
                          <div className="sup-panel__decision-fact">
                            <span>当前进展 / 状态</span>
                            <div>{a.currentState || '尚无额外进展摘要，请结合当前任务和问题说明判断'}</div>
                          </div>
                          <div className="sup-panel__decision-fact">
                            <span>影响 / 风险</span>
                            <div>{a.impact || '未报告额外风险'}</div>
                          </div>
                        </div>
                      </details>

                      <section className="sup-panel__decision-section sup-panel__recommendation project-manager-dialog__clarification-impact">
                        <h4>{isClarification ? 'AI 推荐答案（不会自动采用）' : 'AI 推荐方案'}</h4>
                        <div>{isClarification
                          ? a.alternatives || 'AI 未提供推荐答案'
                          : a.text || 'AI 未提供具体下一步'}</div>
                      </section>

                      {!isClarification && <fieldset className="sup-panel__decision-section sup-panel__decision-options project-manager-dialog__clarification-options">
                        <legend>请选择一项</legend>
                        <p>选择后，AI 监督会读取任务终端最新状态，整理成完整指令再发送。</p>
                        <div className="sup-panel__decision-option-list">
                          {decisionOptions.map((option) => (
                            <label
                              key={option.value}
                              className={`sup-panel__decision-option${selectedOption === option.value ? ' is-selected' : ''}`}
                              data-selected={selectedOption === option.value ? '1' : '0'}
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
                                <strong>
                                  {option.title}
                                  {option.value === recommendedOption && <em className="sup-panel__decision-option-recommended">推荐</em>}
                                </strong>
                                <span>{option.detail}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>}

                      <details
                        className="sup-panel__decision-section sup-panel__supervisor-guidance project-manager-dialog__clarification-supplement"
                        open={isClarification || undefined}
                      >
                        <summary>{isClarification ? '集中回答对齐问题' : '补充给监督 AI 的信息（可选）'}</summary>
                        <label className="sup-panel__proposal-edit">
                          <textarea
                            className="sup-panel__proposal-input"
                            value={userGuidance}
                            maxLength={4000}
                            onChange={(event) => setProposalGuidance((current) => ({
                              ...current,
                              [a.id]: event.target.value,
                            }))}
                            placeholder={isClarification
                              ? '请按问题编号集中答复；如接受全部推荐，可明确写“全部按推荐答案”'
                              : '例如：优先保持现有 API；请结合当前终端状态判断是否调整方案'}
                            disabled={!supervisor.active || laneControlState === 'stopped'}
                            aria-label={`${a.laneLabel} 的监督 AI 补充信息`}
                          />
                          <small>{isClarification
                            ? '答复只交给监督 AI 完成对齐；监督 AI 形成正式计划前不会向任务 AI 发送执行指令。'
                            : '采用时会与所选方案一起交给 AI 监督分析，不会直接发送到任务终端。没有可选方案时，也可以只提交这段信息。'}</small>
                        </label>
                      </details>
                      {lane && !isProjectManagedSupervisorLane(lane) && (
                        <details className="project-manager-dialog__clarification-advanced">
                          <summary>高级选项</summary>
                          <label className="sup-panel__standing-decision">
                            <input
                              type="checkbox"
                              checked={proposalStandingDecisions[a.id] === true}
                              onChange={(event) => setProposalStandingDecisions((current) => ({
                                ...current,
                                [a.id]: event.target.checked,
                              }))}
                              disabled={!supervisor.active || laneControlState === 'stopped'}
                            />
                            <span>
                              <strong>同类问题沿用本次决定，不再重复询问</strong>
                              <small>仅限当前终端和当前规划版本；出现新风险、范围或验收变化时仍需重新确认。</small>
                              </span>
                            </label>
                        </details>
                      )}

                      <div className="sup-panel__approval-actions sup-panel__decision-actions project-manager-dialog__clarification-actions">
                        <span>{isClarification
                          ? '完成对齐前，监督 AI 不会向任务终端派发执行指令。'
                          : '你的选择会先交给监督 AI 结合终端最新状态整理。'}</span>
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
                          className="sup-panel__btn-primary project-manager-dialog__clarification-submit"
                          onClick={() => onApprove(a.id)}
                          disabled={
                            !supervisor.active
                             || laneControlState !== 'active'
                             || !supervisorSurfaceId
                             || (!selectedOption && !recommendedOption && !userGuidance.trim())
                          }
                        >
                          {isClarification
                            ? '提交对齐答复'
                            : selectedOption
                              ? '采用所选 AI 方案'
                              : recommendedOption
                                ? '采用 AI 推荐方案'
                                : '提交补充给 AI 判断'}
                        </button>
                      </div>

                      {!isClarification && <details className="project-manager-dialog__clarification-advanced sup-panel__direct-decision-advanced">
                        <summary>直接决定并发送给任务终端</summary>
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
                      </details>}
                    </div>
                  ) : (
                    <>
                      <pre className="sup-panel__approval-text">
                        {a.text.slice(0, 400)}
                        {a.text.length > 400 ? '…' : ''}
                      </pre>
                      <label className="sup-panel__proposal-edit">
                        <span>自定义意见（可选）</span>
                        <textarea
                          className="sup-panel__proposal-input"
                          value={userGuidance}
                          maxLength={4000}
                          onChange={(event) => setProposalGuidance((current) => ({
                            ...current,
                            [a.id]: event.target.value,
                          }))}
                          placeholder="可补充边界、偏好或暂停原因；留空则按当前选项处理"
                          disabled={!supervisor.active || laneControlState === 'stopped'}
                        />
                      </label>
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

          {!scopedProjectId && !ordinaryCenterMode && visibleLogs.length > 0 && (
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
          ) : ordinaryCenterMode ? null : <div className="sup-panel__actions">
            {ordinaryEnabled.length > 0 && (
              <button type="button" onClick={() => scopedOrdinaryLane ? pauseLane(scopedOrdinaryLane) : pauseActiveSession()}>
                {scopedOrdinaryLane ? '暂停此监督' : '全部暂停'}
              </button>
            )}
            {ordinaryRetained && (
              <button type="button" onClick={() => scopedOrdinaryLane ? stopLane(scopedOrdinaryLane) : stopOrdinarySupervisor()}>
                {scopedOrdinaryLane ? '停止此监督' : '停止普通监督'}
              </button>
            )}
            {ordinaryPaused.length > 0 && (
              <button
                type="button"
                className="sup-panel__btn-primary"
                onClick={() => void (scopedOrdinaryLane ? resumeLane(scopedOrdinaryLane) : resumePausedSession())}
                disabled={runtimeRestoreLaneId !== null}
              >
                {runtimeRestoreLaneId ? '连接中…' : scopedOrdinaryLane ? '继续此监督' : '全部继续'}
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
            {!scopedOrdinaryLane && ordinaryLanes.length > 0 && (
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
