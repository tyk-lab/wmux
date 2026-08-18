import type { TaskWorkMode } from './supervisor-work-mode';

export const MAX_PROJECT_PLAN_FILES = 3;
export const MAX_PROJECT_PLAN_FILE_BYTES = 1024 * 1024;

export type ProjectManagerSessionStatus = 'active' | 'paused' | 'waiting' | 'completed' | 'stopped';

export type ProjectGoalStatus = 'transitioning' | 'active' | 'achieved' | 'superseded' | 'abandoned';

export type ProjectSubgoalStatus = 'planned' | 'active' | 'blocked' | 'achieved' | 'obsolete';

export type ProjectWorkItemStatus =
  | 'planned'
  | 'waiting-dependencies'
  | 'running'
  | 'validating'
  | 'waiting-decision'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped';

export type ProjectManagerEventKind =
  | 'user-message'
  | 'work-item-created'
  | 'work-item-updated'
  | 'work-item-baseline-started'
  | 'work-item-baseline-approved'
  | 'user-work-item-intervention'
  | 'dispatch-mode-selected'
  | 'supervisor-status'
  | 'supervisor-handoff'
  | 'supervisor-transition'
  | 'supervisor-transition-acknowledged'
  | 'supervisor-decision-request'
  | 'supervisor-direction'
  | 'progress-inspection'
  | 'terminal-rotated'
  | 'recovery-restored'
  | 'manager-runtime-restarted'
  | 'manager-runtime-failed'
  | 'supervisor-runtime-failed'
  | 'task-runtime-failed'
  | 'progress-snapshot'
  | 'progress-sync-required'
  | 'progress-sync-acknowledged'
  | 'requirements-quiesce-failed'
  | 'requirements-quiesced'
  | 'manager-delivery-failed'
  | 'user-clarification-requested'
  | 'user-clarification-answered'
  | 'requirements-alignment-required'
  | 'requirements-alignment-confirmed'
  | 'project-definition-updated'
  | 'project-subgoals-updated'
  | 'project-goal-completed'
  | 'project-preconditions-updated'
  | 'supervisor-decision'
  | 'guard-triggered'
  | 'project-paused'
  | 'project-resumed'
  | 'project-completed'
  | 'project-stopped'
  | 'manager-reply';

export interface ProjectPlanFileSnapshot {
  path: string;
  name: string;
  content: string;
  sizeBytes: number;
  mtimeMs: number;
  capturedAt: number;
}

export interface ProjectManagerQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export const PROJECT_MANAGER_MANUAL_INTERVENTION_REASON_CODES = [
  'physical-action',
  'credentials',
  'access-grant',
  'business-choice',
  'destructive-action',
  'production-action',
] as const;

export type ProjectManagerManualInterventionReasonCode =
  typeof PROJECT_MANAGER_MANUAL_INTERVENTION_REASON_CODES[number];

export interface ProjectManagerUserQuestion {
  id: string;
  category?: 'clarification' | 'manual-intervention';
  workItemId?: string;
  blocker?: string;
  reasonCode?: ProjectManagerManualInterventionReasonCode;
  question: string;
  context: string;
  options: ProjectManagerQuestionOption[];
  recommendedOptionId?: string;
  previousStatus: ProjectManagerSessionStatus;
  createdAt: number;
}

export interface ProjectExecutionBudget {
  maxDecisions: number;
  maxContinuousMinutes: number;
  maxIdenticalFailures: number;
  maxNoProgressRounds: number;
  maxTaskRetries: number;
  maxSameTestRuns: number;
  maxFullSuiteRunsPerVersion: number;
}

export const DEFAULT_PROJECT_EXECUTION_BUDGET: ProjectExecutionBudget = {
  maxDecisions: 12,
  maxContinuousMinutes: 90,
  maxIdenticalFailures: 2,
  maxNoProgressRounds: 2,
  maxTaskRetries: 3,
  maxSameTestRuns: 2,
  maxFullSuiteRunsPerVersion: 1,
};

/** Hard ceilings prevent a project-management AI from disabling anti-loop controls through its task contract. */
export const MAX_PROJECT_EXECUTION_BUDGET: ProjectExecutionBudget = {
  maxDecisions: 50,
  maxContinuousMinutes: 240,
  maxIdenticalFailures: 5,
  maxNoProgressRounds: 5,
  maxTaskRetries: 5,
  maxSameTestRuns: 5,
  maxFullSuiteRunsPerVersion: 2,
};

export interface ProjectWorkScope {
  root: string;
  allowPaths: string[];
  denyPaths: string[];
  forbiddenActions: string[];
}

export interface ProjectSupervisorAuthority {
  technicalChoices: boolean;
  lowRiskRetries: boolean;
  targetedTests: boolean;
  internalThreads: boolean;
  /** Keep executing the bounded workflow until its stop condition or a real boundary is reached. */
  continuousExecution?: boolean;
  /** Allow the supervisor to answer eligible local permission prompts without returning to the user. */
  permissionConfirm?: boolean;
  /** Exact executable prefixes eligible for permission confirmation; an empty list grants no custom command. */
  allowedCommandPrefixes?: string[];
  /** Human-readable physical subjects covered by the current requirements version. */
  authorizedDevices?: string[];
  /** Human-readable environments covered by the current requirements version. */
  authorizedEnvironments?: string[];
  /** Human-readable operation classes the task may carry through as one workflow. */
  authorizedOperations?: string[];
}

export interface ProjectTaskExecutionPlan {
  taskWorkMode: TaskWorkMode;
  modeReason: string;
  mainThreadResponsibility: string;
  childThreadResponsibilities: string[];
  /** Hard upper bound for task-AI-owned child threads in adaptive mode. */
  maxChildThreads?: number;
  /** Whether the dedicated supervisor may approve a task AI thread proposal within this contract. */
  supervisorMayApproveThreads?: boolean;
  /** Operations that may be split after the supervisor validates independence and ownership. */
  parallelizableOperations?: string[];
  /** Shared-resource or high-coupling operations that must remain on the main thread. */
  serializedOperations?: string[];
}

export interface ProjectSupervisorContract {
  objective: string;
  description: string;
  preconditions: string[];
  scope: ProjectWorkScope;
  authority: ProjectSupervisorAuthority;
  /** Selected by the project manager and forwarded through the supervisor to the task terminal. */
  execution?: ProjectTaskExecutionPlan;
  stopWhen: string[];
  validation: string[];
  budget: ProjectExecutionBudget;
}

export interface ProjectExecutionRecord {
  ts: number;
  actionSignature: string;
  commandSignature: string;
  errorSignature: string;
  progressSignature: string;
  workspaceVersion: string;
  testCommand?: string;
  fullSuite?: boolean;
}

export type ProjectTaskBaselineStatus = 'required' | 'investigating' | 'approved';

/** Control-plane-owned proof that the task inspected the current project before writing. */
export interface ProjectTaskBaseline {
  status: ProjectTaskBaselineStatus;
  requirementsVersion: number;
  requestedAt?: number;
  workspaceVersion?: string;
  evidence?: string;
  approvedAt?: number;
}

export type ProjectProgressEntrySource = 'workspace' | 'plan';

/** Bounded content identity captured from the managed project directory. */
export interface ProjectProgressEntry {
  path: string;
  source: ProjectProgressEntrySource;
  status: string;
  signature: string;
}

export interface ProjectProgressSnapshot {
  version: 1;
  capturedAt: number;
  mode: 'git' | 'filesystem';
  fingerprint: string;
  head?: string;
  headSummary?: string;
  branch?: string;
  entries: ProjectProgressEntry[];
  truncated: boolean;
}

export interface ProjectProgressSyncState {
  status: 'ready' | 'review-required';
  checkedAt: number;
  snapshotFingerprint: string;
  summary: string;
  changeCount: number;
  reason?: string;
  acknowledgedAt?: number;
  acknowledgement?: string;
}

export interface ProjectProgressDiff {
  baselineMissing: boolean;
  changed: boolean;
  headChanged: boolean;
  branchChanged: boolean;
  added: string[];
  modified: string[];
  removed: string[];
  changeCount: number;
}

/** A user-owned main-goal episode inside a long-lived project. */
export interface ProjectGoalRevision {
  id: string;
  sequence: number;
  statement: string;
  doneWhen: string[];
  status: ProjectGoalStatus;
  requirementsVersion: number;
  supersedesGoalId?: string;
  changeReason?: string;
  createdAt: number;
  activatedAt?: number;
  closedAt?: number;
}

/** A coarse outcome planned by the project AI. It is not an executable terminal task. */
export interface ProjectSubgoal {
  id: string;
  goalId: string;
  title: string;
  outcome: string;
  acceptance: string[];
  dependencies: string[];
  status: ProjectSubgoalStatus;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectWorkItem {
  id: string;
  /** Immutable main-goal ownership. Old-goal tasks cannot be rebound across a pivot. */
  goalId?: string;
  /** Coarse project-AI stage that owns this executable task. */
  subgoalId?: string;
  /** Requirements and inherited-authorization versions accepted for this task contract. */
  requirementsVersion?: number;
  authorizationVersion?: number;
  /** Project AI cannot approve this field; only the bound supervisor decision bridge can. */
  baseline?: ProjectTaskBaseline;
  title: string;
  contract: ProjectSupervisorContract;
  status: ProjectWorkItemStatus;
  dependencies: string[];
  supervisorLaneId?: string;
  workerSurfaceId?: string;
  attempts: number;
  decisionsUsed: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  executionHistory: ProjectExecutionRecord[];
  latestEvidence?: string;
  latestContextSummary?: string;
  latestBlocker?: string;
}

export interface ProjectManagerEvent {
  id: string;
  sessionId: string;
  ts: number;
  kind: ProjectManagerEventKind;
  summary: string;
  workItemId?: string;
  correlationId?: string;
  payload?: Record<string, unknown>;
}

export interface ProjectManagerPendingDelivery {
  id: string;
  text: string;
  createdAt: number;
  /** Keeps an actionable supervisor transition traceable after PTY delivery. */
  transitionId?: string;
}

export type ProjectSupervisorTransitionKind =
  | 'stage-complete'
  | 'direction-needed'
  | 'decision-required'
  | 'supervisor-unavailable'
  | 'supervisor-idle';

/** Durable actionable state handoff from one project's dedicated supervisor. */
export interface ProjectSupervisorTransition {
  id: string;
  laneId: string;
  workItemId?: string;
  kind: ProjectSupervisorTransitionKind;
  eventType: string;
  summary: string;
  evidence?: string;
  contextSummary?: string;
  createdAt: number;
  notifiedAt: number;
  notificationCount: number;
}

export interface ProjectManagerSession {
  id: string;
  projectDir: string;
  /** Stable identity fields. They survive main-goal changes. */
  projectName?: string;
  projectScope?: string;
  /** First-class goal history. `goal` and `doneWhen` mirror the active entry for older consumers. */
  activeGoalId?: string;
  goals?: ProjectGoalRevision[];
  subgoals?: ProjectSubgoal[];
  goal: string;
  /** User-owned physical, environmental, access, or resource gates for all project work. */
  preconditions: string[];
  /** User-selected, size-limited text snapshots that supplement the stated requirements. */
  planFiles: ProjectPlanFileSnapshot[];
  doneWhen: string[];
  /** Monotonic version of user-owned goals, prerequisites, plans, and completion criteria. */
  requirementsVersion?: number;
  /** Changes only when inherited project scope, prerequisites, or grants change. */
  authorizationVersion?: number;
  /** Latest requirements version explicitly accepted by the project manager through resume. */
  acceptedRequirementsVersion?: number;
  status: ProjectManagerSessionStatus;
  /** True only when the project was paused by the portfolio-level control. */
  pausedByPortfolio?: boolean;
  /** The one task terminal reserved for this project, including before supervision starts. */
  taskTerminalSurfaceId?: string;
  managerSurfaceId?: string;
  feishuChatId?: string;
  recoveryState?: 'ready' | 'checking';
  /** Last workspace state explicitly seen by the project AI or a trusted stage checkpoint. */
  progressSnapshot?: ProjectProgressSnapshot;
  /** Blocks stale task dispatch until the project AI has reviewed a changed recovery snapshot. */
  progressSync?: ProjectProgressSyncState;
  pendingUserQuestion?: ProjectManagerUserQuestion;
  /** Manager-bound messages that have not yet been written to the manager terminal. */
  pendingManagerDeliveries?: ProjectManagerPendingDelivery[];
  /** Actionable supervisor handoffs remain here until the project AI records a resolution. */
  pendingSupervisorTransitions?: ProjectSupervisorTransition[];
  workItems: ProjectWorkItem[];
  events: ProjectManagerEvent[];
  createdAt: number;
  updatedAt: number;
}

export function projectRequirementsVersion(session: Pick<ProjectManagerSession, 'requirementsVersion'>): number {
  return Math.max(1, Math.trunc(session.requirementsVersion || 1));
}

export function projectAuthorizationVersion(
  session: Pick<ProjectManagerSession, 'authorizationVersion' | 'requirementsVersion'>,
): number {
  return Math.max(1, Math.trunc(session.authorizationVersion || session.requirementsVersion || 1));
}

export function projectAcceptedRequirementsVersion(
  session: Pick<ProjectManagerSession, 'requirementsVersion' | 'acceptedRequirementsVersion' | 'status'>,
): number {
  if (Number.isFinite(session.acceptedRequirementsVersion)) {
    return Math.max(0, Math.trunc(session.acceptedRequirementsVersion || 0));
  }
  // Missing acceptance is never interpreted as authorization to execute. Old
  // snapshots may still be inspected, but must pass alignment before resuming.
  return 0;
}

const MAX_PROJECT_PROGRESS_ENTRIES = 500;
const MAX_PROJECT_PROGRESS_TEXT = 12_000;

export function normalizeProjectProgressSnapshot(value: unknown): ProjectProgressSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<ProjectProgressSnapshot>;
  if (raw.version !== 1
    || !Number.isFinite(raw.capturedAt)
    || !['git', 'filesystem'].includes(String(raw.mode))
    || typeof raw.fingerprint !== 'string'
    || !raw.fingerprint.trim()
    || !Array.isArray(raw.entries)) return undefined;
  const entries = raw.entries.slice(0, MAX_PROJECT_PROGRESS_ENTRIES)
    .filter((entry): entry is ProjectProgressEntry => (
      !!entry && typeof entry === 'object'
      && typeof entry.path === 'string' && !!entry.path.trim()
      && ['workspace', 'plan'].includes(String(entry.source))
      && typeof entry.status === 'string'
      && typeof entry.signature === 'string' && !!entry.signature.trim()
    ))
    .map((entry) => ({
      path: entry.path.slice(0, 2000),
      source: entry.source,
      status: entry.status.slice(0, 40),
      signature: entry.signature.slice(0, 200),
    }));
  if (entries.length !== Math.min(raw.entries.length, MAX_PROJECT_PROGRESS_ENTRIES)) return undefined;
  return {
    version: 1,
    capturedAt: Number(raw.capturedAt),
    mode: raw.mode as ProjectProgressSnapshot['mode'],
    fingerprint: raw.fingerprint.trim().slice(0, 200),
    ...(typeof raw.head === 'string' && raw.head.trim() ? { head: raw.head.trim().slice(0, 200) } : {}),
    ...(typeof raw.headSummary === 'string' && raw.headSummary.trim()
      ? { headSummary: raw.headSummary.trim().slice(0, 500) }
      : {}),
    ...(typeof raw.branch === 'string' && raw.branch.trim() ? { branch: raw.branch.trim().slice(0, 500) } : {}),
    entries,
    truncated: raw.truncated === true || raw.entries.length > MAX_PROJECT_PROGRESS_ENTRIES,
  };
}

export function normalizeProjectProgressSyncState(value: unknown): ProjectProgressSyncState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<ProjectProgressSyncState>;
  if (!['ready', 'review-required'].includes(String(raw.status))
    || !Number.isFinite(raw.checkedAt)
    || typeof raw.snapshotFingerprint !== 'string' || !raw.snapshotFingerprint.trim()
    || typeof raw.summary !== 'string'
    || !Number.isFinite(raw.changeCount) || Number(raw.changeCount) < 0) return undefined;
  return {
    status: raw.status as ProjectProgressSyncState['status'],
    checkedAt: Number(raw.checkedAt),
    snapshotFingerprint: raw.snapshotFingerprint.trim().slice(0, 200),
    summary: raw.summary.slice(0, MAX_PROJECT_PROGRESS_TEXT),
    changeCount: Math.max(0, Math.trunc(Number(raw.changeCount))),
    ...(typeof raw.reason === 'string' && raw.reason.trim()
      ? { reason: raw.reason.trim().slice(0, 2000) }
      : {}),
    ...(Number.isFinite(raw.acknowledgedAt) ? { acknowledgedAt: Number(raw.acknowledgedAt) } : {}),
    ...(typeof raw.acknowledgement === 'string' && raw.acknowledgement.trim()
      ? { acknowledgement: raw.acknowledgement.trim().slice(0, 4000) }
      : {}),
  };
}

export function diffProjectProgressSnapshots(
  previous: ProjectProgressSnapshot | undefined,
  current: ProjectProgressSnapshot,
): ProjectProgressDiff {
  if (!previous) {
    return {
      baselineMissing: true,
      changed: true,
      headChanged: false,
      branchChanged: false,
      added: current.entries.map((entry) => entry.path),
      modified: [],
      removed: [],
      changeCount: current.entries.length,
    };
  }
  const before = new Map(previous.entries.map((entry) => [`${entry.source}\u0000${entry.path}`, entry]));
  const after = new Map(current.entries.map((entry) => [`${entry.source}\u0000${entry.path}`, entry]));
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [key, entry] of after) {
    const old = before.get(key);
    if (!old) added.push(entry.path);
    else if (old.signature !== entry.signature || old.status !== entry.status) modified.push(entry.path);
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) removed.push(entry.path);
  }
  const headChanged = (previous.head || '') !== (current.head || '');
  const branchChanged = (previous.branch || '') !== (current.branch || '');
  const changeCount = added.length + modified.length + removed.length
    + (headChanged ? 1 : 0) + (branchChanged ? 1 : 0);
  return {
    baselineMissing: false,
    changed: previous.fingerprint !== current.fingerprint || changeCount > 0,
    headChanged,
    branchChanged,
    added,
    modified,
    removed,
    changeCount,
  };
}

function fallbackProjectName(session: Pick<ProjectManagerSession, 'projectDir' | 'goal'>): string {
  const segments = session.projectDir.trim().replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) || session.goal.trim().slice(0, 80) || '未命名项目';
}

export function activeProjectGoal(session: ProjectManagerSession): ProjectGoalRevision {
  const requirementsVersion = projectRequirementsVersion(session);
  const goals = Array.isArray(session.goals) ? session.goals : [];
  const active = goals.find((goal) => goal.id === session.activeGoalId)
    || [...goals].reverse().find((goal) => goal.status === 'active' || goal.status === 'transitioning')
    || goals.at(-1);
  return active || {
    id: `${session.id}-goal-1`,
    sequence: 1,
    statement: session.goal,
    doneWhen: session.doneWhen,
    status: session.status === 'completed' ? 'achieved' : 'active',
    requirementsVersion,
    createdAt: session.createdAt,
    activatedAt: session.createdAt,
  };
}

export function activeProjectSubgoals(session: ProjectManagerSession): ProjectSubgoal[] {
  const goalId = activeProjectGoal(session).id;
  return (session.subgoals || [])
    .filter((subgoal) => subgoal.goalId === goalId)
    .sort((left, right) => left.order - right.order || left.createdAt - right.createdAt);
}

export function projectDisplayName(session: Pick<ProjectManagerSession, 'projectName' | 'projectDir' | 'goal'>): string {
  return session.projectName?.trim() || fallbackProjectName(session);
}

/** Upgrade stored sessions once at the boundary so runtime code has one coherent goal model. */
export function normalizeProjectManagerSession(session: ProjectManagerSession): ProjectManagerSession {
  const requirementsVersion = projectRequirementsVersion(session);
  const authorizationVersion = projectAuthorizationVersion(session);
  const rawGoals = Array.isArray(session.goals) ? session.goals : [];
  const goals = rawGoals.length > 0
    ? rawGoals.map((goal, index) => ({
        ...goal,
        sequence: Math.max(1, Math.trunc(goal.sequence || index + 1)),
        statement: goal.statement.trim(),
        doneWhen: goal.doneWhen.map((item) => item.trim()).filter(Boolean),
        requirementsVersion: Math.max(1, Math.trunc(goal.requirementsVersion || requirementsVersion)),
      }))
    : [activeProjectGoal(session)];
  const activeGoal = goals.find((goal) => goal.id === session.activeGoalId)
    || [...goals].reverse().find((goal) => goal.status === 'active' || goal.status === 'transitioning')
    || goals[goals.length - 1];
  const activeGoalId = activeGoal.id;
  const rawSubgoals = Array.isArray(session.subgoals) ? session.subgoals : [];
  const needsLegacySubgoal = rawSubgoals.length === 0 && session.workItems.length > 0;
  const legacySubgoalId = `${session.id}-legacy-${activeGoalId}`;
  const subgoals = needsLegacySubgoal
    ? [{
        id: legacySubgoalId,
        goalId: activeGoalId,
        title: '历史执行工作',
        outcome: '保留升级前已有工作项的归属和审计记录',
        acceptance: activeGoal.doneWhen,
        dependencies: [],
        status: 'active' as const,
        order: 1,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }]
    : rawSubgoals;
  return {
    ...session,
    projectName: projectDisplayName(session),
    projectScope: session.projectScope?.trim() || `仅限项目目录 ${session.projectDir} 内与本项目直接相关的工作`,
    activeGoalId,
    goals,
    subgoals,
    goal: activeGoal.statement,
    doneWhen: activeGoal.doneWhen,
    requirementsVersion,
    authorizationVersion,
    acceptedRequirementsVersion: projectAcceptedRequirementsVersion(session),
    progressSnapshot: normalizeProjectProgressSnapshot(session.progressSnapshot),
    progressSync: normalizeProjectProgressSyncState(session.progressSync),
    pendingSupervisorTransitions: (Array.isArray(session.pendingSupervisorTransitions)
      ? session.pendingSupervisorTransitions
      : [])
      .slice(-50)
      .filter((transition): transition is ProjectSupervisorTransition => (
        !!transition
        && typeof transition.id === 'string' && !!transition.id.trim()
        && typeof transition.laneId === 'string' && !!transition.laneId.trim()
        && ['stage-complete', 'direction-needed', 'decision-required', 'supervisor-unavailable', 'supervisor-idle']
          .includes(String(transition.kind))
        && typeof transition.eventType === 'string' && !!transition.eventType.trim()
        && typeof transition.summary === 'string' && !!transition.summary.trim()
        && (transition.evidence === undefined || typeof transition.evidence === 'string')
        && (transition.contextSummary === undefined || typeof transition.contextSummary === 'string')
        && Number.isFinite(transition.createdAt)
        && Number.isFinite(transition.notifiedAt)
        && Number.isFinite(transition.notificationCount)
      ))
      .map((transition) => ({
        ...transition,
        id: transition.id.trim().slice(0, 200),
        laneId: transition.laneId.trim().slice(0, 200),
        ...(transition.workItemId?.trim() ? { workItemId: transition.workItemId.trim().slice(0, 200) } : {}),
        eventType: transition.eventType.trim().slice(0, 200),
        summary: transition.summary.trim().slice(0, 4000),
        ...(transition.evidence?.trim() ? { evidence: transition.evidence.trim().slice(0, 12_000) } : {}),
        ...(transition.contextSummary?.trim()
          ? { contextSummary: transition.contextSummary.trim().slice(0, 12_000) }
          : {}),
        notificationCount: Math.max(1, Math.trunc(transition.notificationCount)),
      })),
    workItems: session.workItems.map((item) => {
      const itemRequirementsVersion = Math.max(1, Math.trunc(item.requirementsVersion || requirementsVersion));
      const activeBaseline = item.baseline?.requirementsVersion === itemRequirementsVersion && (
        (item.baseline.status === 'investigating' && Number.isFinite(item.baseline.requestedAt))
        || (item.baseline.status === 'approved'
          && !!item.baseline.workspaceVersion?.trim()
          && !!item.baseline.evidence?.trim())
      );
      return {
        ...item,
        goalId: item.goalId || activeGoalId,
        subgoalId: item.subgoalId || (needsLegacySubgoal ? legacySubgoalId : undefined),
        requirementsVersion: itemRequirementsVersion,
        authorizationVersion: Math.max(1, Math.trunc(item.authorizationVersion || authorizationVersion)),
        baseline: activeBaseline
          ? item.baseline
          : requiredProjectTaskBaseline(itemRequirementsVersion),
      };
    }),
  };
}

export type ProjectManagerAction =
  | { type: 'require-requirements-alignment'; reason: string }
  | {
    type: 'confirm-requirements-alignment';
    goalUnderstanding: string;
    scopeSummary: string;
    acceptanceSummary: string;
    reason: string;
  }
  | {
    type: 'update-project-definition';
    goal: string;
    preconditions: string[];
    planFiles: ProjectPlanFileSnapshot[];
    doneWhen: string[];
    reason?: string;
    source: 'user' | 'manager';
    mode: 'refine' | 'pivot';
  }
  | { type: 'set-project-subgoals'; subgoals: ProjectSubgoal[]; reason?: string; source: 'user' | 'manager' }
  | { type: 'update-project-preconditions'; preconditions: string[]; reason?: string }
  | { type: 'request-user-clarification'; question: ProjectManagerUserQuestion }
  | { type: 'answer-user-clarification'; questionId: string; answer: string; optionId?: string; answeredBy: 'desktop' | 'feishu' }
  | { type: 'create-work-item'; workItem: ProjectWorkItem }
  | { type: 'update-work-item'; workItemId: string; patch: Partial<ProjectWorkItem> }
  | { type: 'start-work-item-baseline'; workItemId: string }
  | {
    type: 'approve-work-item-baseline';
    workItemId: string;
    workspaceVersion: string;
    evidence: string;
  }
  | {
    type: 'intervene-work-item';
    workItemId: string;
    intervention: 'skip' | 'close';
    reason?: string;
  }
  | { type: 'record-execution'; workItemId: string; record: ProjectExecutionRecord }
  | { type: 'pause-project'; reason: string; source?: 'project' | 'portfolio' }
  | {
    type: 'resume-project';
    reason: string;
    source?: 'project' | 'portfolio';
    /** Only the authenticated project-manager protocol may accept a new requirements version. */
    acceptRequirementsVersion?: boolean;
  }
  | { type: 'complete-current-goal'; evidence: string }
  | { type: 'stop-project'; reason: string; emergency?: boolean }
  | { type: 'reply'; correlationId?: string; message: string };

export function projectWorkItemReady(
  item: ProjectWorkItem,
  items: readonly ProjectWorkItem[],
): boolean {
  if (item.status !== 'planned' && item.status !== 'waiting-dependencies') return false;
  const byId = new Map(items.map((candidate) => [candidate.id, candidate]));
  return item.dependencies.every((dependency) => byId.get(dependency)?.status === 'completed');
}

export function requiredProjectTaskBaseline(requirementsVersion: number): ProjectTaskBaseline {
  return {
    status: 'required',
    requirementsVersion: Math.max(1, Math.trunc(requirementsVersion || 1)),
  };
}

export function projectTaskBaselineApproved(
  item: Pick<ProjectWorkItem, 'requirementsVersion' | 'baseline'>,
): boolean {
  const requirementsVersion = Math.max(1, Math.trunc(item.requirementsVersion || 1));
  return item.baseline?.status === 'approved'
    && item.baseline.requirementsVersion === requirementsVersion
    && !!item.baseline.workspaceVersion?.trim()
    && !!item.baseline.evidence?.trim();
}

export function normalizeProjectExecutionBudget(
  value?: Partial<ProjectExecutionBudget>,
): ProjectExecutionBudget {
  const positiveInteger = (candidate: unknown, fallback: number, maximum: number): number => (
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 1
      ? Math.min(Math.floor(candidate), maximum)
      : fallback
  );
  return {
    maxDecisions: positiveInteger(value?.maxDecisions, DEFAULT_PROJECT_EXECUTION_BUDGET.maxDecisions, MAX_PROJECT_EXECUTION_BUDGET.maxDecisions),
    maxContinuousMinutes: positiveInteger(value?.maxContinuousMinutes, DEFAULT_PROJECT_EXECUTION_BUDGET.maxContinuousMinutes, MAX_PROJECT_EXECUTION_BUDGET.maxContinuousMinutes),
    maxIdenticalFailures: positiveInteger(value?.maxIdenticalFailures, DEFAULT_PROJECT_EXECUTION_BUDGET.maxIdenticalFailures, MAX_PROJECT_EXECUTION_BUDGET.maxIdenticalFailures),
    maxNoProgressRounds: positiveInteger(value?.maxNoProgressRounds, DEFAULT_PROJECT_EXECUTION_BUDGET.maxNoProgressRounds, MAX_PROJECT_EXECUTION_BUDGET.maxNoProgressRounds),
    maxTaskRetries: positiveInteger(value?.maxTaskRetries, DEFAULT_PROJECT_EXECUTION_BUDGET.maxTaskRetries, MAX_PROJECT_EXECUTION_BUDGET.maxTaskRetries),
    maxSameTestRuns: positiveInteger(value?.maxSameTestRuns, DEFAULT_PROJECT_EXECUTION_BUDGET.maxSameTestRuns, MAX_PROJECT_EXECUTION_BUDGET.maxSameTestRuns),
    maxFullSuiteRunsPerVersion: positiveInteger(
      value?.maxFullSuiteRunsPerVersion,
      DEFAULT_PROJECT_EXECUTION_BUDGET.maxFullSuiteRunsPerVersion,
      MAX_PROJECT_EXECUTION_BUDGET.maxFullSuiteRunsPerVersion,
    ),
  };
}
