import { StateCreator } from 'zustand';
import { DefaultSupervisorAgent, PaneId, SurfaceId, WorkspaceId } from '../../shared/types';
import {
  DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS,
  DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS,
  DEFAULT_SUPERVISOR_WORK_SCOPE,
  type SupervisorAutonomyPermission,
  type SupervisorForbiddenAction,
  type SupervisorWorkScope,
} from '../../shared/supervisor-policy';
import type { TaskWorkMode } from '../../shared/supervisor-work-mode';
import type { ProjectSupervisorStagePlan } from '../../shared/project-manager';

/**
 * How the supervisor AI should interpret stopWhen:
 * - direction: a heading / desired end-state (e.g. "auth 可登录"); judge if work is on track / done enough
 * - concrete: a checkable condition (e.g. "tests green" / "BUILD SUCCESS")
 */
export type StopWhenKind = 'direction' | 'concrete';

export type SupervisorLaneControlState = 'active' | 'paused' | 'waiting' | 'stopped';

export interface SupervisorDecision {
  ts: number;
  task: string;
  outcome: 'continue' | 'rework' | 'complete' | 'needs-human';
  proposalKind?: 'route-adjustment' | 'route-change' | 'important' | 'context-recovery' | 'direction-needed' | 'clarification';
  reason: string;
  next: string;
  /** Supervisor-owned execution plan snapshot; one milestone means direct execution. */
  plan?: ProjectSupervisorStagePlan;
}

/** A lifecycle fact waiting to be delivered to this lane's dedicated supervisor. */
export interface SupervisorDelivery {
  id: string;
  kind: 'task-start' | 'task-end' | 'task-interrupted' | 'worker-status' | 'liveness-probe' | 'agent-recovery';
  text: string;
  task: string;
  createdAt: number;
  /** Worker turn generation; separates repeated tasks from duplicate hooks. */
  turnId?: number;
  /** Review generation that must be acknowledged by the matching supervisor decision. */
  reviewId?: string;
  /** Paste succeeded; only Enter remains, so retries must not duplicate text. */
  stage?: 'pending' | 'pasted';
}

/** Explicitly chosen historical terminal whose audit context may be restored. */
export interface SupervisorRestoreSource {
  surfaceId: string;
  label: string;
  sessionId: string;
}

/** Task semantics owned by one monitored terminal and its dedicated supervisor. */
export interface SupervisorLaneConfig {
  taskGoal: string;
  taskDescription: string;
  preconditions: string;
  /** Optional checkpoint and handoff reminders for the dedicated supervisor only. */
  supervisorNotes?: string;
  stopWhen: string;
  stopWhenKind: StopWhenKind;
  /** Keep the lane bound after completion and wait for a new user direction. */
  waitForNextDirection?: boolean;
  planFilePath: string;
  /** Work arrangement for the AI running inside the monitored task terminal. */
  taskWorkMode?: TaskWorkMode;
  mainThreadResponsibility?: string;
  childThreadResponsibilities?: string[];
  maxChildThreads?: number;
  supervisorMayApproveThreads?: boolean;
  parallelizableOperations?: string[];
  serializedOperations?: string[];
}

export interface SupervisorGoalConstructionMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface SupervisorGoalConstructionState {
  status: 'drafting' | 'confirmed';
  /** Terminal-context bootstrap may finalize without user input when the evidence is sufficient. */
  origin?: 'conversation' | 'terminal-context';
  initialIdea: string;
  draft: Pick<SupervisorLaneConfig, 'taskGoal' | 'taskDescription' | 'preconditions' | 'stopWhen' | 'stopWhenKind'>;
  messages: SupervisorGoalConstructionMessage[];
  startedAt: number;
  confirmedAt?: number;
}

export interface SupervisorLane {
  id: string;
  /** Stable identity for this terminal's management/audit conversation. */
  managementSessionId?: string;
  /** Project-management work item that owns this lane, when centrally orchestrated. */
  projectWorkItemId?: string;
  /** Project-management project that owns this lane; work-item IDs are only unique within it. */
  projectManagerProjectId?: string;
  /** The project supervisor is running, but it has not created its dedicated task terminal yet. */
  projectTaskStartupPending?: boolean;
  /** Project manager requested context rotation; only this lane's supervisor may execute it. */
  projectTaskRotationPending?: boolean;
  projectTaskRotationSummary?: string;
  /** Used to reclaim a delivered rotation request when the supervisor never acknowledges it. */
  projectTaskRotationRequestedAt?: number;
  label: string;
  surfaceId: SurfaceId;
  /** Dedicated visible AI terminal; it receives facts for this lane only. */
  supervisorSurfaceId?: SurfaceId | null;
  paneId?: PaneId;
  workspaceId?: WorkspaceId;
  workspaceTitle?: string;
  /** The worker may control an SSH target, directly or through another terminal. */
  remoteSshControl?: boolean;
  /** Terminal cwd when supervision begins; audit records live below this project. */
  projectDir?: string;
  /** Immutable work-scope root captured when this supervision session starts. */
  scopeRoot?: string;
  /** Authoritative lifecycle state for this independently owned lane. */
  controlState: SupervisorLaneControlState;
  /** A completed decision is awaiting stop-condition confirmation. */
  awaitingStopCheck: boolean;
  /** The stop condition has been confirmed; no further work may be injected. */
  stopConfirmed: boolean;
  /** A finished turn must be reviewed before the scheduler advances this terminal. */
  awaitingReview?: boolean;
  /** Stable identity of the currently unresolved ordinary-supervisor review. */
  activeReviewId?: string;
  /** Worker generation that opened activeReviewId. */
  reviewWorkerTurnId?: number;
  /** Wall-clock time at which the current review was opened. */
  reviewOpenedAt?: number;
  /** Time at which the current review prompt was accepted by the supervisor terminal. */
  reviewDeliveryConfirmedAt?: number;
  /** Bounded watchdog lifecycle for the current review. */
  reviewWatchdogState?: 'pending' | 'retrying' | 'failed';
  /** User-visible fault that prevents the dedicated supervisor from completing reviews. */
  supervisorProblem?: {
    kind: 'provider-limit' | 'runtime-failed' | 'unreported-decision';
    detail: string;
    detectedAt: number;
  };
  /** Number of consecutive supervisor turns that ended without a structured decision. */
  unreportedIdleRecoveryAttempts?: number;
  /** Marks review created by alternate input so resume clears only this lane. */
  resumeAfterCancelledDecision?: boolean;
  /** The current review began by resuming a waiting lane and still needs an actionable direction. */
  awaitingDirectionAfterWaitingResume?: boolean;
  /** Blocked-request generation already answered for a permission or technical question. */
  lastBlockedResponseVersion?: number;
  /** Stable blocked-request identity; unlike a counter, it cannot collide after an agent restart. */
  lastBlockedResponseId?: string;
  /** Automatic AI decisions reached the configured limit; human review must resume supervision. */
  autoDecisionLimitReached?: boolean;
  /** Number of AI decisions since this terminal was last acknowledged by a human. */
  autoDecisionsUsed?: number;
  /** Latest task reported by the worker hook, shown with its decision history. */
  currentTask?: string;
  /** Monotonic worker turn generation advanced by UserPromptSubmit hooks. */
  workerTurnId?: number;
  /** Independent task configuration for this terminal and its dedicated supervisor. */
  config?: SupervisorLaneConfig;
  /** Optional per-terminal override; undefined inherits the session defaults. */
  autonomyPermissionsOverride?: SupervisorAutonomyPermission[];
  /** Optional per-terminal full-auto switch; undefined inherits the session default. */
  autonomousOverride?: boolean;
  /** Optional per-terminal forbidden actions; undefined inherits the session defaults. */
  forbiddenActionsOverride?: SupervisorForbiddenAction[];
  /** Optional per-terminal work scope; project-managed lanes never inherit ordinary-mode settings. */
  workScopeOverride?: SupervisorWorkScope;
  /** Hook lifecycle facts retained until the dedicated supervisor terminal accepts them. */
  pendingSupervisorDeliveries?: SupervisorDelivery[];
  /** True until the dedicated supervisor has delivered this work item's complete task contract. */
  projectTaskContractPending?: boolean;
  /** True until an ordinary task terminal receives its one-time role anchor. */
  taskRoleAnchorPending?: boolean;
  /** New ordinary lanes must align material ambiguity and persist a plan before first execution. */
  ordinaryPlanRequired?: boolean;
  /** Conversational target definition gate; the same supervisor becomes active after explicit user confirmation. */
  goalConstruction?: SupervisorGoalConstructionState;
  /** Bounded permission audit used to stop repeated confirmations that make no progress. */
  permissionConfirmations?: Array<{
    ts: number;
    commandSignature: string;
    blockedRequestId?: string;
    requirementsVersion?: number;
  }>;
  /** In-memory timeline for this lane; durable copies are written to its audit stream. */
  decisions?: SupervisorDecision[];
  /** Bounded audit summary restored for this terminal only after a restart. */
  restoredHistory?: string;
  restoredFromSessionId?: string;
  /** User-selected historical terminal; intentionally independent of this lane's surfaceId. */
  restoreSource?: SupervisorRestoreSource;
  /** User-gated bootstrap that rebuilds a task terminal from restored audit context. */
  contextRecoveryStatus?: 'draft-pending' | 'awaiting-confirmation' | 'sent';
}

export type ApprovalSource =
  | 'supervisor-route'
  | 'supervisor-important'
  | 'supervisor-context-recovery';

export interface PendingApproval {
  id: string;
  laneId: string;
  surfaceId: SurfaceId;
  laneLabel: string;
  text: string;
  source: ApprovalSource;
  /** A supervisor proposal that must be decided by the user before injection. */
  proposalKind?: 'route-change' | 'important' | 'context-recovery' | 'clarification';
  reason?: string;
  impact?: string;
  alternatives?: string;
  task?: string;
  createdAt: number;
}

export interface SupervisorLogEntry {
  ts: number;
  laneId: string;
  action: string;
  detail: string;
}

export interface SupervisorSession {
  sessionId: string;
  active: boolean;
  /** Paused sessions retain their lanes, pending decisions, and session identity. */
  paused: boolean;
  /** Current-session-only authority for AI decisions and safe terminal confirmations. */
  autonomous: boolean;
  /** Explicit capabilities granted to the supervisor; hard safety gates still apply. */
  autonomyPermissions: SupervisorAutonomyPermission[];
  /** Structured work boundary applied independently to each lane's project directory. */
  workScope: SupervisorWorkScope;
  /** User-selected project constraints in addition to the non-overridable safety boundary. */
  forbiddenActions: SupervisorForbiddenAction[];

  /** Per-terminal AI decision limit before a human must review and resume; null means unlimited. */
  maxAutoDecisions: number | null;

  lanes: SupervisorLane[];
  /** Pinned workspace that provides the full-width supervisor session view. */
  supervisorWorkspaceId?: WorkspaceId | null;
  supervisorLaunchCmd: string;
  /** Optional launcher-specific model ID or alias. */
  supervisorModel: string;
  /** Optional launcher-specific thinking or reasoning setting. */
  supervisorReasoningEffort: string;
  pendingApprovals: PendingApproval[];
  log: SupervisorLogEntry[];
  pollMs: number;
  submitEnter: boolean;
  setupOpen: boolean;
}

export interface SupervisorSlice {
  supervisor: SupervisorSession;
  openSupervisorSetup: () => void;
  closeSupervisorSetup: () => void;
  patchSupervisor: (partial: Partial<SupervisorSession>) => void;
  /** Replace ordinary lanes while preserving every project-managed lane and its pending decisions. */
  setOrdinarySupervisorLanes: (lanes: SupervisorLane[]) => void;
  /** Replace project lanes while preserving every ordinary lane and its pending decisions. */
  setProjectSupervisorLanes: (lanes: SupervisorLane[]) => void;
  startOrdinarySupervisor: () => void;
  startProjectSupervisor: (laneIds: string[]) => void;
  pauseOrdinarySupervisor: (detail?: string) => void;
  resumeOrdinarySupervisor: () => void;
  stopOrdinarySupervisor: (detail?: string) => void;
  pauseSupervisorLane: (laneId: string, detail?: string) => void;
  resumeSupervisorLane: (laneId: string, detail?: string) => void;
  stopSupervisorLane: (laneId: string, detail?: string) => void;
  appendSupervisorLog: (laneId: string, action: string, detail: string) => void;
  enqueueApproval: (item: Omit<PendingApproval, 'id' | 'createdAt'>) => void;
  approvePending: (id: string) => PendingApproval | null;
  resolvePendingWithManualTask: (laneId: string, task: string) => PendingApproval[];
  cancelPending: (id: string, detail?: string) => PendingApproval | null;
  rejectPending: (id: string) => void;
  updateLane: (laneId: string, patch: Partial<SupervisorLane>) => void;
  /** Drop ordinary supervision state without changing project-managed lanes. */
  resetOrdinarySupervisorSession: () => void;
  /** Human/AI confirms the configured end condition. */
  confirmStopCondition: (laneId: string) => void;
  /** End condition not met — keep watching for a new task or supervisor decision. */
  rejectStopCondition: (laneId: string) => void;
}

const MAX_LOG = 200;

export function createDefaultSupervisorSession(): SupervisorSession {
  return {
    sessionId: '',
    active: false,
    paused: false,
    autonomous: false,
    autonomyPermissions: [...DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS],
    workScope: DEFAULT_SUPERVISOR_WORK_SCOPE,
    forbiddenActions: [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS],
    maxAutoDecisions: null,
    lanes: [],
    supervisorLaunchCmd: 'pi',
    supervisorModel: '',
    supervisorReasoningEffort: 'medium',
    pendingApprovals: [],
    log: [],
    pollMs: 4000,
    submitEnter: true,
    setupOpen: false,
  };
}

export interface SupervisorDefaultPreferences {
  defaultSupervisorModels?: Partial<Record<DefaultSupervisorAgent, string>>;
  defaultSupervisorReasoningEfforts?: Partial<Record<DefaultSupervisorAgent, string>>;
}

export function supervisorDefaultsForAgent(
  agent: DefaultSupervisorAgent,
  preferences?: SupervisorDefaultPreferences,
): Pick<
  SupervisorSession,
  'supervisorLaunchCmd' | 'supervisorModel' | 'supervisorReasoningEffort'
> {
  let defaults: Pick<
    SupervisorSession,
    'supervisorLaunchCmd' | 'supervisorModel' | 'supervisorReasoningEffort'
  >;
  if (agent === 'pi') {
    defaults = {
      supervisorLaunchCmd: 'pi',
      supervisorModel: '',
      supervisorReasoningEffort: 'medium',
    };
  } else if (agent === 'codex') {
    defaults = {
      supervisorLaunchCmd: 'codex',
      supervisorModel: '',
      supervisorReasoningEffort: 'medium',
    };
  } else if (agent === 'kimi') {
    defaults = {
      supervisorLaunchCmd: 'kimi',
      supervisorModel: '',
      supervisorReasoningEffort: '',
    };
  } else if (agent === 'grok') {
    defaults = {
      supervisorLaunchCmd: 'grok',
      supervisorModel: '',
      supervisorReasoningEffort: '',
    };
  } else {
    defaults = {
      supervisorLaunchCmd: agent === 'none' ? '' : agent,
      supervisorModel: '',
      supervisorReasoningEffort: '',
    };
  }

  const savedModel = preferences?.defaultSupervisorModels?.[agent];
  const savedReasoningEffort = agent === 'kimi'
    ? undefined
    : preferences?.defaultSupervisorReasoningEfforts?.[agent];
  return {
    ...defaults,
    supervisorModel: typeof savedModel === 'string' ? savedModel : defaults.supervisorModel,
    supervisorReasoningEffort: typeof savedReasoningEffort === 'string'
      ? savedReasoningEffort
      : defaults.supervisorReasoningEffort,
  };
}

/** Keep monitored-terminal facts while dropping transient supervisor state. */
export function clearSupervisorLaneContext(
  lane: SupervisorLane,
  supervisorSurfaceId: SurfaceId | null,
): SupervisorLane {
  return {
    ...lane,
    managementSessionId: `sup-lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    supervisorSurfaceId: supervisorSurfaceId === lane.surfaceId ? null : supervisorSurfaceId,
    controlState: 'active',
    awaitingStopCheck: false,
    stopConfirmed: false,
    awaitingReview: false,
    activeReviewId: undefined,
    reviewWorkerTurnId: undefined,
    reviewOpenedAt: undefined,
    reviewDeliveryConfirmedAt: undefined,
    reviewWatchdogState: undefined,
    supervisorProblem: undefined,
    unreportedIdleRecoveryAttempts: 0,
    resumeAfterCancelledDecision: false,
    awaitingDirectionAfterWaitingResume: false,
    lastBlockedResponseVersion: undefined,
    lastBlockedResponseId: undefined,
    autoDecisionLimitReached: false,
    autoDecisionsUsed: 0,
    pendingSupervisorDeliveries: [],
    taskRoleAnchorPending: true,
    permissionConfirmations: [],
    decisions: [],
    restoredHistory: undefined,
    restoredFromSessionId: undefined,
    restoreSource: undefined,
    contextRecoveryStatus: undefined,
  };
}

/** A task terminal is marked only while its lane is actively supervised. */
export function isSurfaceSupervised(
  session: Pick<SupervisorSession, 'active' | 'lanes'>,
  surfaceId: SurfaceId,
): boolean {
  return session.active && session.lanes.some((lane) => (
    supervisorLaneControlState(lane) === 'active' && lane.surfaceId === surfaceId
  ));
}

export function supervisorLaneControlState(
  lane: Pick<SupervisorLane, 'controlState'>,
): SupervisorLaneControlState {
  return lane.controlState;
}

/** A dedicated supervisor can never be the worker terminal it controls. */
export function dedicatedSupervisorSurfaceId(
  lane: Pick<SupervisorLane, 'surfaceId' | 'supervisorSurfaceId'>,
): SurfaceId | null {
  const supervisorSurfaceId = lane.supervisorSurfaceId || null;
  return supervisorSurfaceId && supervisorSurfaceId !== lane.surfaceId
    ? supervisorSurfaceId
    : null;
}

export function normalizeSupervisorLaneBinding(lane: SupervisorLane): SupervisorLane {
  const normalized = dedicatedSupervisorSurfaceId(lane) || !lane.supervisorSurfaceId
    ? lane
    : { ...lane, supervisorSurfaceId: null };
  if (!isProjectManagedSupervisorLane(normalized)) return normalized;
  return {
    ...normalized,
    autonomousOverride: normalized.autonomousOverride ?? true,
    autonomyPermissionsOverride: Array.isArray(normalized.autonomyPermissionsOverride)
      ? normalized.autonomyPermissionsOverride
      : ['same-route-next'],
    workScopeOverride: normalized.workScopeOverride || DEFAULT_SUPERVISOR_WORK_SCOPE,
    forbiddenActionsOverride: Array.isArray(normalized.forbiddenActionsOverride)
      ? normalized.forbiddenActionsOverride
      : [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS],
  };
}

/** Paused and waiting lanes remain bound; stopped lanes can be selected for a fresh supervisor. */
export function isSupervisorLaneBound(
  lane: Pick<SupervisorLane, 'controlState'>,
): boolean {
  return supervisorLaneControlState(lane) !== 'stopped';
}

/** Project-owned lanes are controlled by Project AI, never by ordinary supervision controls. */
export function isProjectManagedSupervisorLane(
  lane: Pick<SupervisorLane, 'projectManagerProjectId' | 'projectWorkItemId' | 'projectTaskStartupPending'>,
): boolean {
  return !!(lane.projectManagerProjectId || lane.projectWorkItemId || lane.projectTaskStartupPending);
}

function supervisorRuntimeFlags(lanes: readonly SupervisorLane[]): Pick<SupervisorSession, 'active' | 'paused'> {
  const active = lanes.some((lane) => {
    const state = supervisorLaneControlState(lane);
    return state === 'active' || state === 'waiting';
  });
  const paused = !active && lanes.some((lane) => supervisorLaneControlState(lane) === 'paused');
  return { active, paused };
}

export const createSupervisorSlice: StateCreator<SupervisorSlice, [], [], SupervisorSlice> = (set, get) => ({
  supervisor: createDefaultSupervisorSession(),

  openSupervisorSetup() {
    set((s) => {
      const hasRetainedOrdinaryLane = s.supervisor.lanes.some((lane) => (
        !isProjectManagedSupervisorLane(lane) && isSupervisorLaneBound(lane)
      ));
      const hasProjectLane = s.supervisor.lanes.some(isProjectManagedSupervisorLane);
      if (hasRetainedOrdinaryLane || (!!s.supervisor.sessionId && !hasProjectLane)) {
        return { supervisor: { ...s.supervisor, setupOpen: true } };
      }
      const workspacePrefs = (s as unknown as {
        workspacePrefs?: SupervisorDefaultPreferences & {
          defaultSupervisorAgent?: DefaultSupervisorAgent;
        };
      }).workspacePrefs;
      const defaults = supervisorDefaultsForAgent(
        workspacePrefs?.defaultSupervisorAgent || 'pi',
        workspacePrefs,
      );
      return {
        supervisor: {
          ...s.supervisor,
          ...defaults,
          autonomous: false,
          setupOpen: true,
        },
      };
    });
  },
  closeSupervisorSetup() {
    set((s) => ({ supervisor: { ...s.supervisor, setupOpen: false } }));
  },
  patchSupervisor(partial) {
    set((s) => ({ supervisor: { ...s.supervisor, ...partial } }));
  },
  setOrdinarySupervisorLanes(lanes) {
    set((s) => {
      const projectLanes = s.supervisor.lanes.filter(isProjectManagedSupervisorLane);
      const ordinaryLanes = lanes
        .filter((lane) => !isProjectManagedSupervisorLane(lane))
        .map(normalizeSupervisorLaneBinding);
      const nextLanes = [...projectLanes, ...ordinaryLanes];
      return {
        supervisor: {
          ...s.supervisor,
          ...(s.supervisor.sessionId ? supervisorRuntimeFlags(nextLanes) : {}),
          lanes: nextLanes,
        },
      };
    });
  },
  setProjectSupervisorLanes(lanes) {
    set((s) => {
      const ordinaryLanes = s.supervisor.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane));
      const projectLanes = lanes
        .filter(isProjectManagedSupervisorLane)
        .map(normalizeSupervisorLaneBinding);
      const nextLanes = [...ordinaryLanes, ...projectLanes];
      return {
        supervisor: {
          ...s.supervisor,
          ...(s.supervisor.sessionId ? supervisorRuntimeFlags(nextLanes) : {}),
          lanes: nextLanes,
        },
      };
    });
  },
  startOrdinarySupervisor() {
    set((s) => {
      const ordinaryLaneIds = new Set(
        s.supervisor.lanes
          .filter((lane) => !isProjectManagedSupervisorLane(lane))
          .map((lane) => lane.id),
      );
      if (ordinaryLaneIds.size === 0) return s;
      const projectLaneIds = new Set(
        s.supervisor.lanes
          .filter(isProjectManagedSupervisorLane)
          .map((lane) => lane.id),
      );
      const lanes = s.supervisor.lanes.map((rawLane) => {
        if (!ordinaryLaneIds.has(rawLane.id)) return rawLane;
        const lane = normalizeSupervisorLaneBinding(rawLane);
        return {
          ...lane,
          controlState: 'active' as const,
          managementSessionId: lane.managementSessionId
            || `sup-lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          awaitingReview: true,
          resumeAfterCancelledDecision: false,
        };
      });
      return {
        supervisor: {
          ...s.supervisor,
          lanes,
          sessionId: s.supervisor.sessionId
            || `sup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          active: true,
          paused: false,
          setupOpen: false,
          pendingApprovals: s.supervisor.pendingApprovals.filter((item) => projectLaneIds.has(item.laneId)),
          log: [{
            ts: Date.now(),
            laneId: '-',
            action: '启动普通监督',
            detail: `普通监督 通道=${ordinaryLaneIds.size}`,
          }, ...s.supervisor.log].slice(0, MAX_LOG),
        },
      };
    });
  },
  startProjectSupervisor(laneIds) {
    set((s) => {
      const targetIds = new Set(laneIds);
      if (targetIds.size === 0) return s;
      const lanes = s.supervisor.lanes.map((rawLane) => {
        if (!targetIds.has(rawLane.id) || !isProjectManagedSupervisorLane(rawLane)) return rawLane;
        const lane = normalizeSupervisorLaneBinding(rawLane);
        return {
          ...lane,
          controlState: 'active' as const,
          managementSessionId: lane.managementSessionId
            || `sup-lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          awaitingReview: true,
          resumeAfterCancelledDecision: false,
        };
      });
      if (!lanes.some((lane, index) => lane !== s.supervisor.lanes[index])) return s;
      return {
        supervisor: {
          ...s.supervisor,
          ...supervisorRuntimeFlags(lanes),
          lanes,
          sessionId: s.supervisor.sessionId
            || `sup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          setupOpen: false,
          log: [{
            ts: Date.now(), laneId: '-', action: '启动项目监督', detail: `项目监督 通道=${targetIds.size}`,
          }, ...s.supervisor.log].slice(0, MAX_LOG),
        },
      };
    });
  },
  pauseOrdinarySupervisor(detail) {
    set((s) => {
      const ordinaryLaneIds = new Set(
        s.supervisor.lanes
          .filter((lane) => !isProjectManagedSupervisorLane(lane))
          .map((lane) => lane.id),
      );
      const lanes = s.supervisor.lanes.map((lane) => (
        ordinaryLaneIds.has(lane.id) && supervisorLaneControlState(lane) === 'active'
          ? { ...lane, controlState: 'paused' as const }
          : lane
      ));
      if (!lanes.some((lane, index) => lane !== s.supervisor.lanes[index])) return s;
      return {
        supervisor: {
          ...s.supervisor,
          ...supervisorRuntimeFlags(lanes),
          lanes,
          log: [{
            ts: Date.now(), laneId: '-', action: '暂停普通监督',
            detail: detail || '普通监督已暂停；项目监督状态不变',
          }, ...s.supervisor.log].slice(0, MAX_LOG),
        },
      };
    });
  },
  resumeOrdinarySupervisor() {
    set((s) => {
      const ordinaryLaneIds = new Set(
        s.supervisor.lanes
          .filter((lane) => !isProjectManagedSupervisorLane(lane))
          .map((lane) => lane.id),
      );
      const pendingLaneIds = new Set(s.supervisor.pendingApprovals.map((item) => item.laneId));
      const lanes = s.supervisor.lanes.map((lane) => {
        if (!ordinaryLaneIds.has(lane.id) || supervisorLaneControlState(lane) !== 'paused') return lane;
        return {
          ...lane,
          controlState: 'active' as const,
          awaitingReview: lane.resumeAfterCancelledDecision && !pendingLaneIds.has(lane.id)
            ? false
            : lane.awaitingReview,
          resumeAfterCancelledDecision: false,
        };
      });
      if (!lanes.some((lane, index) => lane !== s.supervisor.lanes[index])) return s;
      return {
        supervisor: {
          ...s.supervisor,
          ...supervisorRuntimeFlags(lanes),
          lanes,
          setupOpen: false,
          log: [{
            ts: Date.now(), laneId: '-', action: '继续普通监督', detail: '继续普通监督会话；项目监督状态不变',
          }, ...s.supervisor.log].slice(0, MAX_LOG),
        },
      };
    });
  },
  stopOrdinarySupervisor(detail) {
    set((s) => {
      const ordinaryLaneIds = new Set(
        s.supervisor.lanes
          .filter((lane) => !isProjectManagedSupervisorLane(lane))
          .map((lane) => lane.id),
      );
      if (ordinaryLaneIds.size === 0) return s;
      const lanes = s.supervisor.lanes.map((lane) => ordinaryLaneIds.has(lane.id)
        ? {
            ...lane,
            controlState: 'stopped' as const,
            autonomousOverride: undefined,
          }
        : lane);
      return {
        supervisor: {
          ...s.supervisor,
          ...supervisorRuntimeFlags(lanes),
          lanes,
          autonomous: false,
          pendingApprovals: s.supervisor.pendingApprovals.filter((item) => !ordinaryLaneIds.has(item.laneId)),
          log: [{
            ts: Date.now(), laneId: '-', action: '停止普通监督',
            detail: detail || '普通监督已停止；项目监督状态不变',
          }, ...s.supervisor.log].slice(0, MAX_LOG),
        },
      };
    });
  },
  pauseSupervisorLane(laneId, detail) {
    set((s) => {
      const lane = s.supervisor.lanes.find((item) => item.id === laneId);
      if (!lane || supervisorLaneControlState(lane) !== 'active') return s;
      const lanes = s.supervisor.lanes.map((item) => item.id === laneId
        ? { ...item, controlState: 'paused' as const }
        : item);
      return {
        supervisor: {
          ...s.supervisor,
          ...supervisorRuntimeFlags(lanes),
          lanes,
          log: [{
            ts: Date.now(), laneId, action: '暂停通道', detail: detail || `${lane.label} 已暂停`,
          }, ...s.supervisor.log].slice(0, MAX_LOG),
        },
      };
    });
  },
  resumeSupervisorLane(laneId, detail) {
    set((s) => {
      const lane = s.supervisor.lanes.find((item) => item.id === laneId);
      const previousState = lane ? supervisorLaneControlState(lane) : 'stopped';
      if (!lane || (previousState !== 'paused' && previousState !== 'waiting')) return s;
      const lanes = s.supervisor.lanes.map((item) => item.id === laneId
        ? {
            ...item,
            controlState: 'active' as const,
            ...(previousState === 'waiting' ? {
              awaitingStopCheck: false,
              stopConfirmed: false,
              awaitingReview: false,
              activeReviewId: undefined,
              reviewWorkerTurnId: undefined,
              reviewOpenedAt: undefined,
              reviewDeliveryConfirmedAt: undefined,
              reviewWatchdogState: undefined,
              awaitingDirectionAfterWaitingResume: true,
              resumeAfterCancelledDecision: false,
              autoDecisionLimitReached: false,
              autoDecisionsUsed: 0,
              pendingSupervisorDeliveries: [],
            } : {}),
          }
        : item);
      return {
        supervisor: {
          ...s.supervisor,
          ...supervisorRuntimeFlags(lanes),
          lanes,
          log: [{
            ts: Date.now(), laneId,
            action: previousState === 'waiting' ? '待续恢复' : '继续通道',
            detail: detail || `${lane.label} 已继续`,
          }, ...s.supervisor.log].slice(0, MAX_LOG),
        },
      };
    });
  },
  stopSupervisorLane(laneId, detail) {
    set((s) => {
      const lane = s.supervisor.lanes.find((item) => item.id === laneId);
      if (!lane || supervisorLaneControlState(lane) === 'stopped') return s;
      // Stopping ends this terminal's management relationship. The audit record
      // has already been persisted by the caller, so retaining a stopped lane
      // here only makes the setup dialog treat the worker as still bound and
      // prevents selecting it for a fresh dedicated supervisor. Pausing uses a
      // separate path and deliberately keeps the lane and management session.
      const lanes = s.supervisor.lanes.filter((item) => item.id !== laneId);
      const hasRetainedLane = lanes.some((item) => supervisorLaneControlState(item) !== 'stopped');
      return {
        supervisor: {
          ...s.supervisor,
          ...supervisorRuntimeFlags(lanes),
          lanes,
          pendingApprovals: s.supervisor.pendingApprovals.filter((item) => item.laneId !== laneId),
          ...(hasRetainedLane ? {} : { autonomous: false }),
          log: [{
            ts: Date.now(), laneId, action: '停止通道', detail: detail || `${lane.label} 已停止并解除终端绑定`,
          }, ...s.supervisor.log].slice(0, MAX_LOG),
        },
      };
    });
  },
  appendSupervisorLog(laneId, action, detail) {
    set((s) => ({
      supervisor: {
        ...s.supervisor,
        log: [{ ts: Date.now(), laneId, action, detail }, ...s.supervisor.log].slice(0, MAX_LOG),
      },
    }));
  },
  enqueueApproval(item) {
    const id = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => {
      const rest = s.supervisor.pendingApprovals.filter((a) => a.laneId !== item.laneId);
      return {
        supervisor: {
          ...s.supervisor,
          pendingApprovals: [{ ...item, id, createdAt: Date.now() }, ...rest],
          log: [
            {
              ts: Date.now(),
              laneId: item.laneId,
              action: '提案',
              detail: `${item.text.slice(0, 80)}${item.text.length > 80 ? '…' : ''}`,
            },
            ...s.supervisor.log,
          ].slice(0, MAX_LOG),
        },
      };
    });
  },
  approvePending(id) {
    const found = get().supervisor.pendingApprovals.find((a) => a.id === id) ?? null;
    if (!found) return null;
    set((s) => ({
      supervisor: {
        ...s.supervisor,
        pendingApprovals: s.supervisor.pendingApprovals.filter((a) => a.id !== id),
      },
    }));
    return found;
  },
  resolvePendingWithManualTask(laneId, task) {
    const found = get().supervisor.pendingApprovals.filter((item) => item.laneId === laneId);
    if (found.length === 0) return [];
    const decisionText = task.trim();
    set((s) => ({
      supervisor: {
        ...s.supervisor,
        pendingApprovals: s.supervisor.pendingApprovals.filter((item) => item.laneId !== laneId),
        lanes: s.supervisor.lanes.map((lane) => lane.id === laneId ? {
          ...lane,
          awaitingReview: false,
          awaitingStopCheck: false,
          stopConfirmed: false,
          resumeAfterCancelledDecision: false,
          autoDecisionLimitReached: false,
          autoDecisionsUsed: 0,
          ...(decisionText ? { currentTask: decisionText } : {}),
        } : lane),
        log: [
          {
            ts: Date.now(),
            laneId,
            action: '人工裁决',
            detail: decisionText || '用户已直接向任务终端发送信息',
          },
          ...s.supervisor.log,
        ].slice(0, MAX_LOG),
      },
    }));
    return found;
  },
  cancelPending(id, detail) {
    const found = get().supervisor.pendingApprovals.find((a) => a.id === id) ?? null;
    if (!found) return null;
    set((s) => ({
      supervisor: {
        ...s.supervisor,
        pendingApprovals: s.supervisor.pendingApprovals.filter((a) => a.id !== id),
        log: [
          {
            ts: Date.now(),
            laneId: found.laneId,
            action: '取消决策',
            detail: detail || '待决项已取消',
          },
          ...s.supervisor.log,
        ].slice(0, MAX_LOG),
      },
    }));
    return found;
  },
  rejectPending(id) {
    set((s) => {
      const item = s.supervisor.pendingApprovals.find((a) => a.id === id);
      return {
        supervisor: {
          ...s.supervisor,
          pendingApprovals: s.supervisor.pendingApprovals.filter((a) => a.id !== id),
          log: item
            ? [
                { ts: Date.now(), laneId: item.laneId, action: '拒绝', detail: '用户拒绝了提案' },
                ...s.supervisor.log,
              ].slice(0, MAX_LOG)
            : s.supervisor.log,
        },
      };
    });
  },
  updateLane(laneId, patch) {
    set((s) => {
      const lanes = s.supervisor.lanes.map((lane) => (
        lane.id === laneId ? normalizeSupervisorLaneBinding({ ...lane, ...patch }) : lane
      ));
      return {
        supervisor: {
          ...s.supervisor,
          ...(patch.controlState !== undefined && s.supervisor.sessionId
            ? supervisorRuntimeFlags(lanes)
            : {}),
          lanes,
        },
      };
    });
  },
  resetOrdinarySupervisorSession() {
    set((s) => {
      const defaults = createDefaultSupervisorSession();
      const projectLanes = s.supervisor.lanes.filter(isProjectManagedSupervisorLane);
      if (projectLanes.length === 0) {
        return {
          supervisor: {
            ...defaults,
            supervisorWorkspaceId: s.supervisor.supervisorWorkspaceId ?? null,
          },
        };
      }
      const projectLaneIds = new Set(projectLanes.map((lane) => lane.id));
      return {
        supervisor: {
          ...defaults,
          ...supervisorRuntimeFlags(projectLanes),
          sessionId: s.supervisor.sessionId,
          lanes: projectLanes,
          supervisorWorkspaceId: s.supervisor.supervisorWorkspaceId ?? null,
          pendingApprovals: s.supervisor.pendingApprovals.filter((item) => projectLaneIds.has(item.laneId)),
          log: s.supervisor.log,
        },
      };
    });
  },
  confirmStopCondition(laneId) {
    set((s) => {
      const target = s.supervisor.lanes.find((lane) => lane.id === laneId);
      const waitForNextDirection = target?.config?.waitForNextDirection === true;
      const lanes = s.supervisor.lanes.map((lane) =>
        lane.id === laneId
          ? {
              ...lane,
              awaitingStopCheck: false,
              stopConfirmed: true,
              autoDecisionLimitReached: false,
              controlState: waitForNextDirection ? 'waiting' as const : 'stopped' as const,
              activeReviewId: undefined,
              reviewWorkerTurnId: undefined,
              reviewOpenedAt: undefined,
              reviewDeliveryConfirmedAt: undefined,
              reviewWatchdogState: undefined,
              ...(waitForNextDirection ? { awaitingReview: false } : { autonomousOverride: undefined }),
            }
          : lane,
      );
      return {
        supervisor: {
          ...s.supervisor,
          ...supervisorRuntimeFlags(lanes),
          lanes,
          log: [
            {
              ts: Date.now(),
              laneId,
              action: waitForNextDirection ? '停止条件确认，进入待续' : '停止条件确认',
              detail: target?.config?.stopWhen?.trim()
                || (waitForNextDirection ? '已确认达到结束条件，等待下一步方向' : '已确认达到结束条件，停止注入'),
            },
            ...s.supervisor.log,
          ].slice(0, MAX_LOG),
        },
      };
    });
  },
  rejectStopCondition(laneId) {
    set((s) => ({
      supervisor: {
        ...s.supervisor,
        lanes: s.supervisor.lanes.map((l) =>
          l.id === laneId
            ? { ...l, awaitingStopCheck: false, stopConfirmed: false }
            : l,
        ),
        log: [
          {
            ts: Date.now(),
            laneId,
            action: '未达停止条件',
            detail: '继续监控；可补充指令后再注入，或稍后再次确认',
          },
          ...s.supervisor.log,
        ].slice(0, MAX_LOG),
      },
    }));
  },
});
