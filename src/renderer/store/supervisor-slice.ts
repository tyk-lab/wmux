import { StateCreator } from 'zustand';
import { PaneId, SurfaceId, WorkspaceId } from '../../shared/types';
import {
  DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS,
  DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS,
  DEFAULT_SUPERVISOR_WORK_SCOPE,
  type SupervisorAutonomyPermission,
  type SupervisorForbiddenAction,
  type SupervisorWorkScope,
} from '../../shared/supervisor-policy';

/** Legacy values remain readable for saved sessions; new sessions are unified. */
export type SupervisorMode = 'unified' | 'direct' | 'goal-chase';

/**
 * How the supervisor AI should interpret stopWhen:
 * - direction: a heading / desired end-state (e.g. "auth 可登录"); judge if work is on track / done enough
 * - concrete: a checkable condition (e.g. "tests green" / "BUILD SUCCESS")
 */
export type StopWhenKind = 'direction' | 'concrete';

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

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
  proposalKind?: 'route-adjustment' | 'route-change' | 'important';
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
}

/** Explicitly chosen historical terminal whose audit context may be restored. */
export interface SupervisorRestoreSource {
  surfaceId: string;
  label: string;
  sessionId: string;
}

export interface SupervisorLane {
  id: string;
  label: string;
  surfaceId: SurfaceId;
  /** Dedicated visible AI terminal; it receives facts for this lane only. */
  supervisorSurfaceId?: SurfaceId | null;
  paneId?: PaneId;
  workspaceId?: WorkspaceId;
  workspaceTitle?: string;
  /** The worker may control an SSH target, including indirectly through psmux. */
  remoteSshControl?: boolean;
  /** Terminal cwd when supervision begins; audit records live below this project. */
  projectDir?: string;
  /** Immutable work-scope root captured when this supervision session starts. */
  scopeRoot?: string;
  enabled: boolean;
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
  /** Optional user-authored goal that overrides the shared session context for this lane. */
  taskGoalOverride?: string;
  /** Optional lane-specific stop reference; the shared session value remains the fallback. */
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
}

export type ApprovalSource =
  | 'plan'
  | 'manual'
  | 'idle-hint'
  | 'goal-chase'
  | 'supervisor-route'
  | 'supervisor-important';

export interface PendingApproval {
  id: string;
  laneId: string;
  surfaceId: SurfaceId;
  laneLabel: string;
  text: string;
  source: ApprovalSource;
  /** A supervisor proposal that must be decided by the user before injection. */
  proposalKind?: 'route-change' | 'important';
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
  startSupervisor: () => void;
  stopSupervisor: (detail?: string) => void;
  appendSupervisorLog: (laneId: string, action: string, detail: string) => void;
  enqueueApproval: (item: Omit<PendingApproval, 'id' | 'createdAt'>) => void;
  approvePending: (id: string) => PendingApproval | null;
  rejectPending: (id: string) => void;
  updateLane: (laneId: string, patch: Partial<SupervisorLane>) => void;
  updateStep: (laneId: string, stepId: string, patch: Partial<SupervisorStep>) => void;
  /** Drop the current in-memory session so the next run starts with clean context. */
  resetSupervisorSession: () => void;
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
    supervisorLaunchCmd: 'codex',
    supervisorModel: '',
    supervisorReasoningEffort: '',
    pendingApprovals: [],
    log: [],
    pollMs: 4000,
    idleStableMs: 8000,
    submitEnter: true,
    allowUnknown: false,
    setupOpen: false,
  };
}

/** Keep monitored-terminal facts while dropping transient supervisor state. */
export function clearSupervisorLaneContext(
  lane: SupervisorLane,
  supervisorSurfaceId: SurfaceId | null,
): SupervisorLane {
  return {
    ...lane,
    supervisorSurfaceId,
    enabled: true,
    steps: [],
    autoStepsUsed: 0,
    awaitingStopCheck: false,
    stopConfirmed: false,
    awaitingReview: false,
    lastBlockedResponseVersion: undefined,
    lastBlockedResponseId: undefined,
    autoDecisionLimitReached: false,
    autoDecisionsUsed: 0,
    pendingSupervisorDeliveries: [],
    decisions: [],
    restoredHistory: undefined,
    restoredFromSessionId: undefined,
    restoreSource: undefined,
  };
}

/** A task terminal is marked only while its lane is actively supervised. */
export function isSurfaceSupervised(
  session: Pick<SupervisorSession, 'active' | 'lanes'>,
  surfaceId: SurfaceId,
): boolean {
  return session.active && session.lanes.some((lane) => lane.enabled && lane.surfaceId === surfaceId);
}

export const createSupervisorSlice: StateCreator<SupervisorSlice, [], [], SupervisorSlice> = (set, get) => ({
  supervisor: createDefaultSupervisorSession(),

  openSupervisorSetup() {
    set((s) => ({ supervisor: { ...s.supervisor, setupOpen: true } }));
  },
  closeSupervisorSetup() {
    set((s) => ({ supervisor: { ...s.supervisor, setupOpen: false } }));
  },
  patchSupervisor(partial) {
    set((s) => ({ supervisor: { ...s.supervisor, ...partial } }));
  },
  setSupervisorLanes(lanes) {
    set((s) => ({ supervisor: { ...s.supervisor, lanes } }));
  },
  startSupervisor() {
    set((s) => {
      let lanes = s.supervisor.lanes;
      if (s.supervisor.mode === 'unified') {
        lanes = lanes.map((lane) => lane.enabled ? { ...lane, awaitingReview: true } : lane);
      }
      return {
        supervisor: {
          ...s.supervisor,
          lanes,
          sessionId: `sup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          active: true,
          setupOpen: false,
          pendingApprovals: [],
          log: [
            {
              ts: Date.now(),
              laneId: '-',
              action: '启动',
              detail: `统一监督 通道=${s.supervisor.lanes.filter((lane) => lane.enabled).length}`,
            },
            ...s.supervisor.log,
          ].slice(0, MAX_LOG),
        },
      };
    });
  },
  stopSupervisor(detail) {
    set((s) => ({
      supervisor: {
        ...s.supervisor,
        active: false,
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
        lanes: s.supervisor.lanes.map((l) => (l.id === laneId ? { ...l, ...patch } : l)),
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
  confirmStopCondition(laneId) {
    set((s) => ({
      supervisor: {
        ...s.supervisor,
        lanes: s.supervisor.lanes.map((l) =>
          l.id === laneId
            ? { ...l, awaitingStopCheck: false, stopConfirmed: true, enabled: false }
            : l,
        ),
        log: [
          {
            ts: Date.now(),
            laneId,
            action: '停止条件确认',
            detail: s.supervisor.lanes.find((lane) => lane.id === laneId)?.stopWhenOverride?.trim()
              || s.supervisor.stopWhen.trim()
              || '已确认达到结束条件，停止注入',
          },
          ...s.supervisor.log,
        ].slice(0, MAX_LOG),
      },
    }));
    const remaining = get().supervisor.lanes.filter((l) => l.enabled);
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
