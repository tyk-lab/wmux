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

/** Legacy values remain readable for saved sessions; new sessions are unified. */
export type SupervisorMode = 'unified' | 'direct' | 'goal-chase';

/**
 * How the supervisor AI should interpret stopWhen:
 * - direction: a heading / desired end-state (e.g. "auth 可登录"); judge if work is on track / done enough
 * - concrete: a checkable condition (e.g. "tests green" / "BUILD SUCCESS")
 */
export type StopWhenKind = 'direction' | 'concrete';

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';
export type SupervisorLaneControlState = 'active' | 'paused' | 'waiting' | 'stopped';

export interface SupervisorStep {
  id: string;
  title?: string;
  prompt: string;
  status: StepStatus;
  dispatchedAt?: number;
  completedAt?: number;
}

export interface SupervisorDecision {
  ts: number;
  task: string;
  outcome: 'continue' | 'rework' | 'complete' | 'needs-human';
  proposalKind?: 'route-adjustment' | 'route-change' | 'important' | 'context-recovery' | 'direction-needed';
  reason: string;
  next: string;
}

/** A lifecycle fact waiting to be delivered to this lane's dedicated supervisor. */
export interface SupervisorDelivery {
  id: string;
  kind: 'task-start' | 'task-end' | 'task-interrupted';
  text: string;
  task: string;
  createdAt: number;
  /** Worker turn generation; separates repeated tasks from duplicate hooks. */
  turnId?: number;
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
  stopWhen: string;
  stopWhenKind: StopWhenKind;
  /** Keep the lane bound after completion and wait for a new user direction. */
  waitForNextDirection?: boolean;
  planFilePath: string;
  /** Work arrangement for the AI running inside the monitored task terminal. */
  taskWorkMode?: TaskWorkMode;
  mainThreadResponsibility?: string;
  childThreadResponsibilities?: string[];
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
  enabled: boolean;
  /** Independent runtime control; missing legacy values derive from enabled. */
  controlState?: SupervisorLaneControlState;
  steps: SupervisorStep[];
  /** goal-chase: max autonomous decision injects for this lane. */
  maxAutoSteps: number;
  autoStepsUsed: number;
  /**
   * direct mode: instruction queue drained; waiting for stop-condition judgment
   * (supervisor AI / human). Injection stays paused until confirmed or new steps.
   */
  awaitingStopCheck: boolean;
  /** direct mode: stop condition confirmed — no more injects for this lane. */
  stopConfirmed: boolean;
  /** A finished turn must be reviewed before the scheduler advances this terminal. */
  awaitingReview?: boolean;
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
  /** @deprecated Compatibility with sessions created before per-terminal configuration. */
  taskGoalOverride?: string;
  /** @deprecated Compatibility with sessions created before per-terminal configuration. */
  stopWhenOverride?: string;
  /** Hook lifecycle facts retained until the dedicated supervisor terminal accepts them. */
  pendingSupervisorDeliveries?: SupervisorDelivery[];
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
  | 'plan'
  | 'manual'
  | 'idle-hint'
  | 'goal-chase'
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
  proposalKind?: 'route-change' | 'important' | 'context-recovery';
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
  mode: SupervisorMode;
  /** Current-session-only authority for AI decisions and safe terminal confirmations. */
  autonomous: boolean;
  /** Explicit capabilities granted to the supervisor; hard safety gates still apply. */
  autonomyPermissions: SupervisorAutonomyPermission[];
  /** Structured work boundary applied independently to each lane's project directory. */
  workScope: SupervisorWorkScope;
  /** User-selected project constraints in addition to the non-overridable safety boundary. */
  forbiddenActions: SupervisorForbiddenAction[];

  /** Optional shared task goal; a lane may override it. */
  taskGoal: string;
  /** Optional context that clarifies the stopping condition for the supervisor only. */
  taskDescription: string;
  /** Environment facts the user has already confirmed for the supervisor only. */
  preconditions: string;

  /**
   * direct: raw multi-line instructions (also mirrored into lane.steps on start).
   * Kept on session so the setup dialog can re-open cleanly.
   */
  directInstructions: string;
  /**
   * direct mode: end condition. Injection stops only after this is confirmed
   * (human or supervisor AI), not merely when the instruction queue is empty.
   * May be a direction or a concrete predicate — see stopWhenKind.
   */
  stopWhen: string;
  stopWhenKind: StopWhenKind;

  /** goal-chase fields */
  goal: string;
  allowPaths: string;
  denyNotes: string;
  doneWhen: string;
  /** User-selected plan, supplied to dedicated supervisors but never worker terminals. */
  planFilePath: string;
  planFileContent: string;
  /** Restore the latest unambiguous audit summary into a new dedicated supervisor. */
  restoreAuditHistory: boolean;
  /** Legacy goal-chase setting kept for saved sessions. */
  maxAutoSteps: number;
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
  idleStableMs: number;
  submitEnter: boolean;
  allowUnknown: boolean;
  setupOpen: boolean;
}

export interface SupervisorSlice {
  supervisor: SupervisorSession;
  openSupervisorSetup: () => void;
  closeSupervisorSetup: () => void;
  patchSupervisor: (partial: Partial<SupervisorSession>) => void;
  setSupervisorLanes: (lanes: SupervisorLane[]) => void;
  /** Replace ordinary lanes while preserving every project-managed lane and its pending decisions. */
  setOrdinarySupervisorLanes: (lanes: SupervisorLane[]) => void;
  startSupervisor: () => void;
  startOrdinarySupervisor: () => void;
  pauseSupervisor: (detail?: string) => void;
  pauseOrdinarySupervisor: (detail?: string) => void;
  resumeSupervisor: () => void;
  resumeOrdinarySupervisor: () => void;
  stopSupervisor: (detail?: string) => void;
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
  updateStep: (laneId: string, stepId: string, patch: Partial<SupervisorStep>) => void;
  /** Drop the current in-memory session so the next run starts with clean context. */
  resetSupervisorSession: () => void;
  /** Drop ordinary supervision state without changing project-managed lanes. */
  resetOrdinarySupervisorSession: () => void;
  /** direct: human/AI confirms end condition — stop injects for this lane. */
  confirmStopCondition: (laneId: string) => void;
  /** direct: end condition not met — keep watching; allow further injects if steps added. */
  rejectStopCondition: (laneId: string) => void;
}

const MAX_LOG = 200;

export function createDefaultSupervisorSession(): SupervisorSession {
  return {
    sessionId: '',
    active: false,
    paused: false,
    mode: 'unified',
    autonomous: false,
    autonomyPermissions: [...DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS],
    workScope: DEFAULT_SUPERVISOR_WORK_SCOPE,
    forbiddenActions: [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS],
    taskGoal: '',
    taskDescription: '',
    preconditions: '',
    directInstructions: '',
    stopWhen: '',
    stopWhenKind: 'concrete',
    goal: '',
    allowPaths: '',
    denyNotes: '',
    doneWhen: '',
    planFilePath: '',
    planFileContent: '',
    restoreAuditHistory: false,
    maxAutoSteps: 3,
    maxAutoDecisions: null,
    lanes: [],
    supervisorLaunchCmd: 'pi',
    supervisorModel: '',
    supervisorReasoningEffort: 'medium',
    pendingApprovals: [],
    log: [],
    pollMs: 4000,
    idleStableMs: 8000,
    submitEnter: true,
    allowUnknown: false,
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
      supervisorReasoningEffort: 'on',
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
  const savedReasoningEffort = preferences?.defaultSupervisorReasoningEfforts?.[agent];
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
    enabled: true,
    controlState: 'active',
    steps: [],
    autoStepsUsed: 0,
    awaitingStopCheck: false,
    stopConfirmed: false,
    awaitingReview: false,
    resumeAfterCancelledDecision: false,
    awaitingDirectionAfterWaitingResume: false,
    lastBlockedResponseVersion: undefined,
    lastBlockedResponseId: undefined,
    autoDecisionLimitReached: false,
    autoDecisionsUsed: 0,
    pendingSupervisorDeliveries: [],
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
  lane: Pick<SupervisorLane, 'enabled' | 'controlState'>,
): SupervisorLaneControlState {
  return lane.controlState || (lane.enabled ? 'active' : 'stopped');
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
      : [...DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS],
    workScopeOverride: normalized.workScopeOverride || DEFAULT_SUPERVISOR_WORK_SCOPE,
    forbiddenActionsOverride: Array.isArray(normalized.forbiddenActionsOverride)
      ? normalized.forbiddenActionsOverride
      : [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS],
  };
}

/** Paused lanes remain bound; stopped lanes are historical compatibility data only. */
export function isSupervisorLaneBound(
  lane: Pick<SupervisorLane, 'enabled' | 'controlState'>,
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
  setSupervisorLanes(lanes) {
    set((s) => ({ supervisor: { ...s.supervisor, lanes: lanes.map(normalizeSupervisorLaneBinding) } }));
  },
  setOrdinarySupervisorLanes(lanes) {
    set((s) => {
      const projectLanes = s.supervisor.lanes.filter(isProjectManagedSupervisorLane);
      const ordinaryLanes = lanes
        .filter((lane) => !isProjectManagedSupervisorLane(lane))
        .map(normalizeSupervisorLaneBinding);
      return { supervisor: { ...s.supervisor, lanes: [...projectLanes, ...ordinaryLanes] } };
    });
  },
  startSupervisor() {
    set((s) => {
      const lanes = s.supervisor.lanes.map((rawLane) => {
        const lane = normalizeSupervisorLaneBinding(rawLane);
        return {
          ...lane,
          controlState: supervisorLaneControlState(lane),
          managementSessionId: lane.managementSessionId
            || `sup-lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ...(s.supervisor.mode === 'unified' && supervisorLaneControlState(lane) === 'active'
            ? { awaitingReview: true }
            : {}),
          resumeAfterCancelledDecision: false,
        };
      });
      return {
        supervisor: {
          ...s.supervisor,
          lanes,
          sessionId: `sup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          active: true,
          paused: false,
          setupOpen: false,
          pendingApprovals: [],
          log: [
            {
              ts: Date.now(),
              laneId: '-',
              action: '启动',
              detail: `统一监督 通道=${s.supervisor.lanes.filter((lane) => supervisorLaneControlState(lane) === 'active').length}`,
            },
            ...s.supervisor.log,
          ].slice(0, MAX_LOG),
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
          enabled: true,
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
  pauseSupervisor(detail) {
    set((s) => {
      if (!s.supervisor.active) return s;
      return {
        supervisor: {
          ...s.supervisor,
          active: false,
          paused: true,
          log: [
            {
              ts: Date.now(),
              laneId: '-',
              action: '暂停',
              detail: detail || '监督会话已暂停，可继续原会话',
            },
            ...s.supervisor.log,
          ].slice(0, MAX_LOG),
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
  resumeSupervisor() {
    set((s) => {
      if (!s.supervisor.paused || !s.supervisor.sessionId) return s;
      const pendingLaneIds = new Set(s.supervisor.pendingApprovals.map((item) => item.laneId));
      const lanes = s.supervisor.lanes.map((lane) => (
        lane.resumeAfterCancelledDecision && !pendingLaneIds.has(lane.id)
          ? { ...lane, awaitingReview: false, resumeAfterCancelledDecision: false }
          : lane
      ));
      return {
        supervisor: {
          ...s.supervisor,
          lanes,
          active: true,
          paused: false,
          setupOpen: false,
          log: [
            {
              ts: Date.now(),
              laneId: '-',
              action: '继续',
              detail: '继续原监督会话',
            },
            ...s.supervisor.log,
          ].slice(0, MAX_LOG),
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
          enabled: true,
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
  stopSupervisor(detail) {
    set((s) => ({
      supervisor: {
        ...s.supervisor,
        lanes: s.supervisor.lanes.map((lane) => ({
          ...lane,
          enabled: false,
          controlState: 'stopped',
          autonomousOverride: undefined,
        })),
        active: false,
        paused: false,
        // Autonomous authority is deliberately non-resumable: stopping ends
        // the consent scope, so a later session must be enabled explicitly.
        autonomous: false,
        log: [
          {
            ts: Date.now(),
            laneId: '-',
            action: '停止',
            detail: detail || '调度已停止',
          },
          ...s.supervisor.log,
        ].slice(0, MAX_LOG),
      },
    }));
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
            enabled: false,
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
      return {
        supervisor: {
          ...s.supervisor,
          lanes: s.supervisor.lanes.map((item) => item.id === laneId
            ? { ...item, controlState: 'paused' }
            : item),
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
      if (!lane || supervisorLaneControlState(lane) !== 'paused') return s;
      return {
        supervisor: {
          ...s.supervisor,
          lanes: s.supervisor.lanes.map((item) => item.id === laneId
            ? { ...item, enabled: true, controlState: 'active' }
            : item),
          log: [{
            ts: Date.now(), laneId, action: '继续通道', detail: detail || `${lane.label} 已继续`,
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
          lanes,
          pendingApprovals: s.supervisor.pendingApprovals.filter((item) => item.laneId !== laneId),
          ...(hasRetainedLane ? {} : { active: false, paused: false, autonomous: false }),
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
    set((s) => ({
      supervisor: {
        ...s.supervisor,
        lanes: s.supervisor.lanes.map((l) => (
          l.id === laneId ? normalizeSupervisorLaneBinding({ ...l, ...patch }) : l
        )),
      },
    }));
  },
  updateStep(laneId, stepId, patch) {
    set((s) => ({
      supervisor: {
        ...s.supervisor,
        lanes: s.supervisor.lanes.map((l) => {
          if (l.id !== laneId) return l;
          return {
            ...l,
            steps: l.steps.map((st) => (st.id === stepId ? { ...st, ...patch } : st)),
          };
        }),
      },
    }));
  },
  resetSupervisorSession() {
    set((s) => ({
      supervisor: {
        ...createDefaultSupervisorSession(),
        // The pinned session shell is UI chrome, not task context. Keep it so
        // “start over” opens a clean configuration in the same fixed session.
        supervisorWorkspaceId: s.supervisor.supervisorWorkspaceId ?? null,
      },
    }));
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
      return {
        supervisor: {
          ...s.supervisor,
          lanes: s.supervisor.lanes.map((lane) =>
            lane.id === laneId
              ? {
                  ...lane,
                  awaitingStopCheck: false,
                  stopConfirmed: true,
                  autoDecisionLimitReached: false,
                  enabled: waitForNextDirection,
                  controlState: waitForNextDirection ? 'waiting' as const : 'stopped' as const,
                  ...(waitForNextDirection ? { awaitingReview: false } : { autonomousOverride: undefined }),
                }
              : lane,
          ),
          log: [
            {
              ts: Date.now(),
              laneId,
              action: waitForNextDirection ? '停止条件确认，进入待续' : '停止条件确认',
              detail: target?.config?.stopWhen?.trim()
                || target?.stopWhenOverride?.trim()
                || s.supervisor.stopWhen.trim()
                || (waitForNextDirection ? '已确认达到结束条件，等待下一步方向' : '已确认达到结束条件，停止注入'),
            },
            ...s.supervisor.log,
          ].slice(0, MAX_LOG),
        },
      };
    });
    const remaining = get().supervisor.lanes.filter(
      (lane) => supervisorLaneControlState(lane) !== 'stopped',
    );
    if (remaining.length === 0) {
      get().stopSupervisor('全部通道已达停止条件');
    }
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
