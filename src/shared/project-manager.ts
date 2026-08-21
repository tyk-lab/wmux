import type { TaskWorkMode } from './supervisor-work-mode';

export const MAX_PROJECT_PLAN_FILES = 3;
export const MAX_PROJECT_PLAN_FILE_BYTES = 1024 * 1024;
/** Bump whenever restored work must be re-contracted before current supervisors may execute it. */
export const CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION = 3;

export const PROJECT_PARALLELISM_SELECTIONS = [
  'auto',
  'single-worker',
  'internal-threads',
  'worker-group',
] as const;
export type ProjectParallelismSelection = typeof PROJECT_PARALLELISM_SELECTIONS[number];
export type ProjectParallelismMode = Exclude<ProjectParallelismSelection, 'auto'>;
export const MAX_PROJECT_ACTIVE_WORKERS = 3;

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

export type ProjectEscalationBoundary =
  | 'contract-change'
  | 'cross-item-coordination'
  | 'external-blocker'
  | 'user-only-information'
  | 'high-risk-action'
  | 'budget-exhausted';

export type ProjectContinuationBoundary =
  | 'project-owned-decision'
  | 'external-prerequisite'
  | 'high-risk-boundary';

export const PROJECT_ORIENTATION_DISPOSITIONS = [
  'continue',
  'verify',
  'pause',
  'stop',
  'retain-completed',
] as const;

export type ProjectOrientationDisposition = typeof PROJECT_ORIENTATION_DISPOSITIONS[number];

export type ProjectManagerEventKind =
  | 'user-message'
  | 'work-item-created'
  | 'work-item-updated'
  | 'work-item-baseline-started'
  | 'work-item-baseline-approved'
  | 'user-work-item-intervention'
  | 'dispatch-mode-selected'
  | 'worker-group-created'
  | 'worker-group-cleaned'
  | 'worker-status'
  | 'worker-user-directive'
  | 'worker-assignment-updated'
  | 'merge-candidate-updated'
  | 'resource-lease-updated'
  | 'supervisor-status'
  | 'supervisor-handoff'
  | 'supervisor-transition'
  | 'supervisor-transition-acknowledged'
  | 'supervisor-decision-request'
  | 'supervisor-direction'
  | 'progress-inspection'
  | 'terminal-rotated'
  | 'recovery-restored'
  | 'execution-protocol-migrated'
  | 'manager-runtime-restarted'
  | 'manager-runtime-failed'
  | 'supervisor-runtime-failed'
  | 'task-runtime-failed'
  | 'progress-snapshot'
  | 'progress-sync-required'
  | 'progress-sync-acknowledged'
  | 'project-orientation-required'
  | 'project-orientation-confirmed'
  | 'requirements-quiesce-failed'
  | 'requirements-quiesced'
  | 'manager-delivery-failed'
  | 'manager-delivery-restored'
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
  /** Aggregate task-AI time across a worker group; parallelism must not multiply the budget. */
  maxAggregateWorkerMinutes: number;
  maxIdenticalFailures: number;
  maxNoProgressRounds: number;
  maxTaskRetries: number;
  maxSameTestRuns: number;
  maxFullSuiteRunsPerVersion: number;
}

export const DEFAULT_PROJECT_EXECUTION_BUDGET: ProjectExecutionBudget = {
  maxDecisions: 12,
  maxContinuousMinutes: 90,
  maxAggregateWorkerMinutes: 180,
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
  maxAggregateWorkerMinutes: 720,
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
  /** Permit bounded implementation-route adjustments independently from retry authority. */
  routeAdjustments?: boolean;
  targetedTests: boolean;
  internalThreads: boolean;
  /** Keep executing the bounded workflow until its stop condition or a real boundary is reached. */
  continuousExecution?: boolean;
  /** Required when continuousExecution is disabled so one-step delegation cannot become the default. */
  continuationBoundary?: ProjectContinuationBoundary;
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
  /** Project-only mutually exclusive parallelism request. Legacy taskWorkMode is normalized into this field. */
  parallelismSelection?: ProjectParallelismSelection;
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

export interface ProjectParallelismDecision {
  requestedMode: ProjectParallelismSelection;
  resolvedMode: ProjectParallelismMode;
  requirementsVersion: number;
  executionEpoch: number;
  reason: string;
  evidence: string[];
  resolvedAt: number;
}

export type ProjectWorkerRole = 'integrator' | 'worker' | 'hardware-executor';
export type ProjectWorkerStatus =
  | 'planned'
  | 'starting'
  | 'running'
  | 'waiting-resource'
  | 'awaiting-review'
  | 'completed'
  | 'failed'
  | 'exited'
  | 'recovering'
  | 'frozen'
  | 'superseded';

export interface ProjectWorkerAssignment {
  workerId: string;
  role: ProjectWorkerRole;
  outcome: string;
  dependencies: string[];
  writeClaims: string[];
  resourceClaims: string[];
  validation: string[];
}

export interface ProjectWorkerRuntime extends ProjectWorkerAssignment {
  status: ProjectWorkerStatus;
  assignmentVersion: number;
  directiveEpoch: number;
  surfaceId?: string;
  laneId?: string;
  worktreeId?: string;
  worktreePath?: string;
  checkpoint?: string;
  resourceWait?: ProjectResourceWait;
  startedAt?: number;
  accumulatedActiveMs: number;
  updatedAt: number;
}

export interface ProjectWorkerGroup {
  executionEpoch: number;
  integratorWorkerId: string;
  workers: ProjectWorkerRuntime[];
  mergeOrder: string[];
  baselineCommit?: string;
  integrationWorktreePath?: string;
  createdAt: number;
  updatedAt: number;
}

export type ProjectUserDirectiveClassification =
  | 'pending'
  | 'within-assignment'
  | 'reassignment-required'
  | 'contract-change'
  | 'high-risk';

export interface ProjectUserDirective {
  directiveId: string;
  workerId: string;
  directiveEpoch: number;
  assignmentVersion: number;
  /** Execution generation in which the direct user input was observed. */
  executionEpoch?: number;
  /** Requirements generation in which the direct user input was observed. */
  requirementsVersion?: number;
  /** Authorization generation in which the direct user input was observed. */
  authorizationVersion?: number;
  exactText?: string;
  exactTextAvailable: boolean;
  classification: ProjectUserDirectiveClassification;
  reconciliationStatus: 'pending' | 'reconciled' | 'superseded';
  resolution?: 'replanned' | 'rebound';
  resolutionReason?: string;
  resolvedAt?: number;
  receivedAt: number;
}

export type ProjectResourceMode = 'shared-read' | 'exclusive-write' | 'snapshot-read' | 'brokered-read';
export type ProjectResourceLeaseStatus = 'reserved' | 'in-use' | 'releasing' | 'cooldown' | 'released' | 'quarantined';

export interface ProjectResourceLease {
  leaseId: string;
  resourceId: string;
  mode: ProjectResourceMode;
  ownerWorkerId: string;
  operationId: string;
  status: ProjectResourceLeaseStatus;
  idempotent: boolean;
  grantedAt: number;
  updatedAt: number;
  evidence?: string;
}

export interface ProjectResourceWait {
  resourceId: string;
  mode: ProjectResourceMode;
  operationId: string;
  idempotent: boolean;
  requestedAt: number;
}

export interface ProjectMergeCandidate {
  candidateId: string;
  workerId: string;
  assignmentVersion: number;
  /** User-directive generation captured when this candidate was submitted. */
  directiveEpoch?: number;
  baselineCommit: string;
  patchHash: string;
  changedFiles: string[];
  evidence: string[];
  status: 'submitted' | 'checking' | 'accepted' | 'applied' | 'rejected' | 'superseded' | 'frozen';
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSupervisorContract {
  objective: string;
  description: string;
  preconditions: string[];
  /** Checkpoint and handoff reminders consumed by the supervisor, not direct task-AI instructions. */
  supervisorNotes?: string[];
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
  changedFiles?: string[];
  testResult?: string;
  diffSummary?: string;
  evidenceSummary?: string;
  escalationBoundary?: ProjectEscalationBoundary;
}

export type ProjectSupervisorMilestoneStatus = 'planned' | 'active' | 'completed';

export interface ProjectSupervisorMilestone {
  id: string;
  title: string;
  outcome: string;
  status: ProjectSupervisorMilestoneStatus;
  evidence?: string;
}

/** Supervisor-owned route and milestone state inside the project AI's hard contract. */
export interface ProjectSupervisorStagePlan {
  revision: number;
  selectedRoute: string;
  milestones: ProjectSupervisorMilestone[];
  expectedPaths: string[];
  targetedValidation: string[];
  serializedBoundaries: string[];
  remainingWork: string[];
  /** Present only when this revision resolves to control-plane worker-group execution. */
  workerAssignments?: ProjectWorkerAssignment[];
  mergeOrder?: string[];
  updatedAt: number;
}

export type ProjectTaskBaselineStatus = 'required' | 'investigating' | 'approved';

/** Control-plane-owned proof that the task inspected the current project before writing. */
export interface ProjectTaskBaseline {
  status: ProjectTaskBaselineStatus;
  requirementsVersion: number;
  requestedAt?: number;
  /** Initial read-only investigation plus at most one targeted supplement. */
  investigationRounds?: number;
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

export interface ProjectOrientationWorkItemReview {
  workItemId: string;
  disposition: ProjectOrientationDisposition;
  basis: string;
  nextAction: string;
}

/** Project-AI-owned semantic understanding, bound to one immutable workspace snapshot and requirement revision. */
export interface ProjectOrientationState {
  status: 'required' | 'ready';
  requirementsVersion: number;
  authorizationVersion: number;
  snapshotFingerprint: string;
  reason: string;
  requestedAt: number;
  summary?: string;
  knownFacts?: string[];
  unknowns?: string[];
  workItems?: ProjectOrientationWorkItemReview[];
  acknowledgedAt?: number;
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
  /** Contract semantics version. Older unfinished items must be re-contracted before dispatch. */
  executionProtocolVersion?: number;
  /** Project AI cannot approve this field; only the bound supervisor decision bridge can. */
  baseline?: ProjectTaskBaseline;
  /** Mutable execution route owned by the supervisor after baseline investigation. */
  supervisorPlan?: ProjectSupervisorStagePlan;
  /** Control-plane migration gate for supervisor-owned planning after baseline approval. */
  supervisorPlanRequired?: boolean;
  title: string;
  contract: ProjectSupervisorContract;
  status: ProjectWorkItemStatus;
  dependencies: string[];
  supervisorLaneId?: string;
  workerSurfaceId?: string;
  parallelismDecision?: ProjectParallelismDecision;
  workerGroup?: ProjectWorkerGroup;
  userDirectives?: ProjectUserDirective[];
  resourceLeases?: ProjectResourceLease[];
  mergeCandidates?: ProjectMergeCandidate[];
  finalApplyBlocked?: boolean;
  /** Monotonic control-plane revision used to fence stale merge/finalize requests. */
  mutationRevision?: number;
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

export type ProjectManagerEventSummary = Pick<ProjectManagerEvent, 'kind' | 'ts' | 'payload'>;

/**
 * A project event needs user attention when it is an explicit terminal
 * blocker, or when the producer marks a non-failure event as non-recoverable.
 */
export function projectManagerEventNeedsUserAttention(
  event: Pick<ProjectManagerEvent, 'kind' | 'payload'> | { kind: string; payload?: Record<string, unknown> },
): boolean {
  return event.payload?.attentionRequired === true || event.kind.endsWith('-failed');
}

/** Returns the newest alert that has not been followed by a recovery event. */
export function activeProjectManagerAttentionEvent<T extends ProjectManagerEventSummary>(
  events: readonly T[],
): T | undefined {
  const resolvedKinds = new Set<string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'project-completed' || event.kind === 'project-stopped') return undefined;
    if (event.kind === 'project-resumed') {
      resolvedKinds.add('project-paused');
      resolvedKinds.add('guard-triggered');
    } else if (event.kind === 'manager-runtime-restarted') {
      resolvedKinds.add('manager-runtime-failed');
      resolvedKinds.add('manager-delivery-failed');
    } else if (event.kind === 'manager-delivery-restored') {
      resolvedKinds.add('manager-delivery-failed');
    } else if (event.kind === 'recovery-restored') {
      resolvedKinds.add('manager-runtime-failed');
      resolvedKinds.add('supervisor-runtime-failed');
      resolvedKinds.add('task-runtime-failed');
    } else if (event.kind === 'requirements-quiesced') {
      resolvedKinds.add('requirements-quiesce-failed');
    }
    const explicitResolvedKinds = event.payload?.resolvedAttentionKinds;
    if (Array.isArray(explicitResolvedKinds)) {
      for (const kind of explicitResolvedKinds) {
        if (typeof kind === 'string' && kind.trim()) resolvedKinds.add(kind.trim());
      }
    }
    if (projectManagerEventNeedsUserAttention(event) && !resolvedKinds.has(event.kind)) return event;
  }
  return undefined;
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
  | 'supervisor-idle'
  | 'project-action-required';

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
  /** Project-level reminders that project AI may inherit and refine for each supervisor contract. */
  supervisorNotes?: string[];
  /** User-selected, size-limited text snapshots that supplement the stated requirements. */
  planFiles: ProjectPlanFileSnapshot[];
  doneWhen: string[];
  /** Monotonic version of user-owned goals, prerequisites, plans, and completion criteria. */
  requirementsVersion?: number;
  /** Changes only when inherited project scope, prerequisites, or grants change. */
  authorizationVersion?: number;
  /** Latest requirements version explicitly accepted by the project manager through resume. */
  acceptedRequirementsVersion?: number;
  /** Persisted execution semantics version, independent from user requirement revisions. */
  executionProtocolVersion?: number;
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
  /** Blocks project-level planning and dispatch until the project AI records a structured understanding. */
  orientation?: ProjectOrientationState;
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

/** Stable directory key used to prevent two live project AIs from owning one project root. */
export function projectDirectoryIdentity(value: string): string {
  const slashed = value.trim().replace(/\\/gu, '/');
  if (slashed === '/') return '/';
  if (/^[A-Za-z]:\/+$/u.test(slashed)) return `${slashed[0].toLowerCase()}:/`;
  const normalized = slashed.replace(/\/+$/u, '');
  const windowsPath = /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith('//');
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(windowsPath ? segment.toLowerCase() : segment);
  }
  if (/^[A-Za-z]:\//u.test(normalized)) return segments.join('/');
  if (normalized.startsWith('//')) return `//${segments.join('/')}`;
  if (normalized.startsWith('/')) return `/${segments.join('/')}`;
  return segments.join('/');
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

export type ProjectRequirementsAlignmentPhase =
  | 'required'
  | 'confirmed-awaiting-plan-or-resume'
  | 'accepted'
  | 'needs-definition-update';

/**
 * Keep the conversational alignment decision separate from execution-version
 * acceptance. `alignment-confirm` records the former, while an authenticated
 * project-AI resume records the latter after orientation and planning gates.
 */
export function projectRequirementsAlignmentPhase(
  session: Pick<
    ProjectManagerSession,
    'requirementsVersion' | 'acceptedRequirementsVersion' | 'status' | 'events'
  >,
): ProjectRequirementsAlignmentPhase {
  let latestRequired = -1;
  let latestConfirmed = -1;
  let latestDefinition = -1;
  let latestChangeMessage = -1;
  session.events.forEach((event, index) => {
    if (event.kind === 'requirements-alignment-required') latestRequired = index;
    if (event.kind === 'requirements-alignment-confirmed') latestConfirmed = index;
    if (event.kind === 'project-definition-updated') latestDefinition = index;
    if (event.kind === 'user-message' && typeof event.payload?.changeSignal === 'string') {
      latestChangeMessage = index;
    }
  });
  if (latestChangeMessage > latestDefinition) return 'needs-definition-update';
  if (latestRequired > latestConfirmed) return 'required';
  if (projectAcceptedRequirementsVersion(session) === projectRequirementsVersion(session)) {
    return 'accepted';
  }
  return latestConfirmed >= 0
    ? 'confirmed-awaiting-plan-or-resume'
    : 'required';
}

const MAX_PROJECT_PROGRESS_ENTRIES = 500;
const MAX_PROJECT_PROGRESS_TEXT = 12_000;
const MAX_PROJECT_ORIENTATION_ITEMS = 200;

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

export function normalizeProjectOrientationState(value: unknown): ProjectOrientationState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<ProjectOrientationState>;
  if (!['required', 'ready'].includes(String(raw.status))
    || !Number.isFinite(raw.requirementsVersion) || Number(raw.requirementsVersion) < 1
    || !Number.isFinite(raw.authorizationVersion) || Number(raw.authorizationVersion) < 1
    || typeof raw.snapshotFingerprint !== 'string' || !raw.snapshotFingerprint.trim()
    || typeof raw.reason !== 'string' || !raw.reason.trim()
    || !Number.isFinite(raw.requestedAt)) return undefined;
  const stringList = (input: unknown, maximum: number): string[] | undefined => {
    if (!Array.isArray(input) || input.length > maximum || input.some((entry) => typeof entry !== 'string')) {
      return undefined;
    }
    return input.map((entry) => entry.trim().slice(0, 4000)).filter(Boolean);
  };
  const knownFacts = raw.knownFacts === undefined ? undefined : stringList(raw.knownFacts, 100);
  const unknowns = raw.unknowns === undefined ? undefined : stringList(raw.unknowns, 100);
  if ((raw.knownFacts !== undefined && knownFacts === undefined)
    || (raw.unknowns !== undefined && unknowns === undefined)) return undefined;
  let workItems: ProjectOrientationWorkItemReview[] | undefined;
  if (raw.workItems !== undefined) {
    if (!Array.isArray(raw.workItems) || raw.workItems.length > MAX_PROJECT_ORIENTATION_ITEMS) return undefined;
    workItems = raw.workItems.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Partial<ProjectOrientationWorkItemReview>;
      if (typeof item.workItemId !== 'string' || !item.workItemId.trim()
        || !PROJECT_ORIENTATION_DISPOSITIONS.includes(item.disposition as ProjectOrientationDisposition)
        || typeof item.basis !== 'string' || !item.basis.trim()
        || typeof item.nextAction !== 'string' || !item.nextAction.trim()) return [];
      return [{
        workItemId: item.workItemId.trim().slice(0, 200),
        disposition: item.disposition as ProjectOrientationDisposition,
        basis: item.basis.trim().slice(0, 4000),
        nextAction: item.nextAction.trim().slice(0, 4000),
      }];
    });
    if (workItems.length !== raw.workItems.length) return undefined;
  }
  const normalized: ProjectOrientationState = {
    status: raw.status as ProjectOrientationState['status'],
    requirementsVersion: Math.max(1, Math.trunc(Number(raw.requirementsVersion))),
    authorizationVersion: Math.max(1, Math.trunc(Number(raw.authorizationVersion))),
    snapshotFingerprint: raw.snapshotFingerprint.trim().slice(0, 200),
    reason: raw.reason.trim().slice(0, 2000),
    requestedAt: Number(raw.requestedAt),
    ...(typeof raw.summary === 'string' && raw.summary.trim()
      ? { summary: raw.summary.trim().slice(0, MAX_PROJECT_PROGRESS_TEXT) }
      : {}),
    ...(knownFacts ? { knownFacts } : {}),
    ...(unknowns ? { unknowns } : {}),
    ...(workItems ? { workItems } : {}),
    ...(Number.isFinite(raw.acknowledgedAt) ? { acknowledgedAt: Number(raw.acknowledgedAt) } : {}),
  };
  if (normalized.status === 'ready' && (
    !normalized.summary
    || !normalized.knownFacts?.length
    || !normalized.workItems
    || !Number.isFinite(normalized.acknowledgedAt)
  )) return undefined;
  return normalized;
}

export function requiredProjectOrientation(
  session: Pick<ProjectManagerSession, 'requirementsVersion' | 'authorizationVersion' | 'progressSnapshot' | 'orientation'>,
  reason: string,
  requestedAt = Date.now(),
): ProjectOrientationState {
  return {
    status: 'required',
    requirementsVersion: projectRequirementsVersion(session),
    authorizationVersion: projectAuthorizationVersion(session),
    snapshotFingerprint: session.progressSnapshot?.fingerprint || 'capture-pending',
    reason: reason.trim().slice(0, 2000) || '项目现状需要重新建立认知基线',
    requestedAt: Math.max(requestedAt, (session.orientation?.requestedAt || 0) + 1),
  };
}

export function projectOrientationReady(
  session: Pick<ProjectManagerSession, 'requirementsVersion' | 'authorizationVersion' | 'progressSnapshot' | 'orientation'>,
): boolean {
  const orientation = session.orientation;
  return orientation?.status === 'ready'
    && orientation.requirementsVersion === projectRequirementsVersion(session)
    && orientation.authorizationVersion === projectAuthorizationVersion(session)
    && !!session.progressSnapshot?.fingerprint
    && orientation.snapshotFingerprint === session.progressSnapshot.fingerprint;
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

export function normalizeProjectParallelismSelection(
  value: unknown,
  legacyMode: TaskWorkMode = 'single-thread',
): ProjectParallelismSelection {
  if (PROJECT_PARALLELISM_SELECTIONS.includes(value as ProjectParallelismSelection)) {
    return value as ProjectParallelismSelection;
  }
  if (legacyMode === 'adaptive') return 'auto';
  if (legacyMode === 'multi-thread') return 'internal-threads';
  return 'single-worker';
}

function normalizeProjectWorkerAssignment(value: ProjectWorkerAssignment): ProjectWorkerAssignment {
  const strings = (items: unknown, maximum = 50): string[] => (
    Array.isArray(items)
      ? items.slice(0, maximum).map((item) => String(item || '').trim()).filter(Boolean)
      : []
  );
  const writeClaims = [...new Set(strings(value?.writeClaims).map((item) => {
    const normalized = item
      .replace(/\\/gu, '/')
      .replace(/^(?:\.\/)+/u, '')
      .replace(/\/{2,}/gu, '/')
      .replace(/\/+$/u, '');
    return normalized || '.';
  }))];
  return {
    workerId: String(value?.workerId || '').trim().slice(0, 100),
    role: value?.role === 'integrator' || value?.role === 'hardware-executor' ? value.role : 'worker',
    outcome: String(value?.outcome || '').trim().slice(0, 4000),
    dependencies: strings(value?.dependencies, MAX_PROJECT_ACTIVE_WORKERS),
    writeClaims,
    resourceClaims: strings(value?.resourceClaims),
    validation: strings(value?.validation),
  };
}

export function normalizeProjectWorkerAssignments(value: unknown): ProjectWorkerAssignment[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, MAX_PROJECT_ACTIVE_WORKERS)
    .map((item) => normalizeProjectWorkerAssignment(item as ProjectWorkerAssignment))
    .filter((item) => {
      if (!item.workerId || !item.outcome || seen.has(item.workerId)) return false;
      seen.add(item.workerId);
      return true;
    });
}

export function projectWorkerAssignmentsViolation(assignments: readonly ProjectWorkerAssignment[]): string | null {
  if (assignments.length < 2 || assignments.length > MAX_PROJECT_ACTIVE_WORKERS) {
    return `多任务 AI 必须包含 2-${MAX_PROJECT_ACTIVE_WORKERS} 个执行 AI`;
  }
  const workerIds = new Set(assignments.map((item) => item.workerId));
  if (workerIds.size !== assignments.length) return '多任务 AI 的 workerId 不能重复';
  const integrators = assignments.filter((item) => item.role === 'integrator');
  if (integrators.length !== 1) return '多任务 AI 必须且只能包含一个主任务 AI';
  const integratorId = integrators[0].workerId;
  if (assignments.filter((item) => item.role === 'hardware-executor').length > 1) {
    return '多任务 AI 最多只能包含一个硬件执行 AI；共享硬件必须通过租约串行使用';
  }
  for (const assignment of assignments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(assignment.workerId)) {
      return `无效 workerId：${assignment.workerId}`;
    }
    if (assignment.dependencies.includes(assignment.workerId)) return `${assignment.workerId} 不能依赖自己`;
    const unknownDependency = assignment.dependencies.find((dependency) => !workerIds.has(dependency));
    if (unknownDependency) return `${assignment.workerId} 依赖了未知 worker：${unknownDependency}`;
    const invalidClaim = assignment.writeClaims.find((claim) => (
      !claim
      || claim === '.'
      || /^(?:[A-Za-z]:\/|\/)/u.test(claim)
      || claim.split('/').includes('..')
    ));
    if (invalidClaim) return `${assignment.workerId} 的 writeClaims 只能是项目内规范相对路径：${invalidClaim}`;
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(assignments.map((item) => [item.workerId, item]));
  const visit = (workerId: string): boolean => {
    if (visited.has(workerId)) return true;
    if (visiting.has(workerId)) return false;
    visiting.add(workerId);
    for (const dependency of byId.get(workerId)?.dependencies || []) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(workerId);
    visited.add(workerId);
    return true;
  };
  if (assignments.some((item) => !visit(item.workerId))) return '多任务 AI 的依赖关系不能形成循环';
  const downstreamOfIntegrator = assignments.find((item) => (
    item.role !== 'integrator' && item.dependencies.includes(integratorId)
  ));
  if (downstreamOfIntegrator) {
    return `${downstreamOfIntegrator.workerId} 不能依赖集成者；集成者必须是 worker 依赖图的最终汇聚点`;
  }
  const pathOwner = new Map<string, string>();
  for (const assignment of assignments) {
    for (const claim of assignment.writeClaims.map((item) => item.replace(/\\/gu, '/').toLowerCase())) {
      const overlap = [...pathOwner.entries()].find(([otherClaim, owner]) => (
        owner !== assignment.workerId
        && (claim === otherClaim || claim.startsWith(`${otherClaim}/`) || otherClaim.startsWith(`${claim}/`))
      ));
      if (overlap) return `写入区域 ${claim} 与 ${overlap[0]} 重叠，分别分配给 ${assignment.workerId} 和 ${overlap[1]}`;
      pathOwner.set(claim, assignment.workerId);
    }
  }
  return null;
}

export function createProjectWorkerGroup(options: {
  decision: ProjectParallelismDecision;
  assignments: readonly ProjectWorkerAssignment[];
  mergeOrder?: readonly string[];
  worktrees?: readonly { workerId: string; worktreePath: string }[];
  baselineCommit?: string;
  now?: number;
}): ProjectWorkerGroup {
  if (options.decision.resolvedMode !== 'worker-group') {
    throw new Error('只有 worker-group 决策可以创建多任务 AI 运行时');
  }
  const assignments = normalizeProjectWorkerAssignments(options.assignments);
  const violation = projectWorkerAssignmentsViolation(assignments);
  if (violation) throw new Error(violation);
  const mergeOrder = Array.isArray(options.mergeOrder) && options.mergeOrder.length === assignments.length
    ? options.mergeOrder.map(String)
    : assignments.map((assignment) => assignment.workerId);
  if (new Set(mergeOrder).size !== assignments.length
    || mergeOrder.some((workerId) => !assignments.some((assignment) => assignment.workerId === workerId))) {
    throw new Error('多任务 AI 的 mergeOrder 必须且只能包含全部 workerId 一次');
  }
  const now = options.now ?? Date.now();
  const worktreeByWorker = new Map((options.worktrees || []).map((item) => [item.workerId, item.worktreePath]));
  const workers: ProjectWorkerRuntime[] = assignments.map((assignment) => ({
    ...assignment,
    status: 'starting',
    assignmentVersion: 1,
    directiveEpoch: 0,
    worktreeId: `epoch-${options.decision.executionEpoch}-${assignment.workerId}`,
    worktreePath: worktreeByWorker.get(assignment.workerId),
    startedAt: now,
    accumulatedActiveMs: 0,
    updatedAt: now,
  }));
  const integrator = workers.find((worker) => worker.role === 'integrator')!;
  return {
    executionEpoch: options.decision.executionEpoch,
    integratorWorkerId: integrator.workerId,
    workers,
    mergeOrder,
    baselineCommit: options.baselineCommit,
    integrationWorktreePath: integrator.worktreePath,
    createdAt: now,
    updatedAt: now,
  };
}

export function projectResourceLeaseViolation(
  leases: readonly ProjectResourceLease[],
  request: Pick<ProjectResourceLease, 'resourceId' | 'mode' | 'ownerWorkerId'>,
): string | null {
  const resourceIdentity = projectResourceIdentity(request.resourceId);
  const active = leases.filter((lease) => (
    projectResourceIdentity(lease.resourceId) === resourceIdentity
    && lease.status !== 'released'
  ));
  const quarantined = active.find((lease) => lease.status === 'quarantined');
  if (quarantined) {
    return `资源 ${request.resourceId} 因任务 AI ${quarantined.ownerWorkerId} 异常退出仍处于隔离状态，必须先核对设备并解除隔离`;
  }
  if (request.mode === 'shared-read' && active.every((lease) => lease.mode === 'shared-read')) return null;
  if (request.mode === 'snapshot-read' || request.mode === 'brokered-read') {
    const blocking = active.find((lease) => (
      lease.mode === 'exclusive-write' || lease.mode === 'shared-read'
    ));
    return blocking
      ? `资源 ${request.resourceId} 的 ${blocking.mode} 租约正由 ${blocking.ownerWorkerId} 持有`
      : null;
  }
  return active.length > 0
    ? `资源 ${request.resourceId} 已由 ${active.map((lease) => lease.ownerWorkerId).join('、')} 占用`
    : null;
}

export function projectResourceIdentity(resourceId: unknown): string {
  return String(resourceId || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

export function projectWorkerDependencyViolation(
  item: Pick<ProjectWorkItem, 'workerGroup' | 'mergeCandidates'>,
  worker: Pick<ProjectWorkerRuntime, 'workerId' | 'dependencies'>,
): string | null {
  const group = item.workerGroup;
  if (!group) return '多任务 AI 运行时不存在';
  for (const dependencyId of worker.dependencies) {
    const dependency = group.workers.find((candidate) => candidate.workerId === dependencyId);
    if (!dependency || !['completed', 'superseded'].includes(dependency.status)) {
      return `依赖任务 AI ${dependencyId} 尚未完成`;
    }
    if (dependency.status === 'completed'
      && dependency.role !== 'integrator'
      && dependency.writeClaims.length > 0
      && !(item.mergeCandidates || []).some((candidate) => (
        candidate.workerId === dependency.workerId
        && candidate.assignmentVersion === dependency.assignmentVersion
        && (candidate.directiveEpoch ?? 0) === dependency.directiveEpoch
        && ['applied', 'rejected'].includes(candidate.status)
      ))) {
      return `依赖任务 AI ${dependencyId} 的当前候选尚未应用或明确拒绝`;
    }
  }
  return null;
}

export function projectWorkerGroupAggregateMinutes(group: ProjectWorkerGroup, now = Date.now()): number {
  const totalMs = group.workers.reduce((total, worker) => (
    total
    + Math.max(0, worker.accumulatedActiveMs || 0)
    + (worker.status === 'running' && worker.startedAt ? Math.max(0, now - worker.startedAt) : 0)
  ), 0);
  return totalMs / 60_000;
}

export function projectWorkerGroupCompletionViolation(item: Pick<ProjectWorkItem,
  'workerGroup' | 'userDirectives' | 'resourceLeases' | 'mergeCandidates' | 'finalApplyBlocked'
>): string | null {
  if (!item.workerGroup) return null;
  const pendingDirective = (item.userDirectives || []).find((directive) => directive.reconciliationStatus === 'pending');
  if (pendingDirective) return `用户直发指令 ${pendingDirective.directiveId} 尚未完成范围与分工协调`;
  const activeLease = (item.resourceLeases || []).find((lease) => lease.status !== 'released');
  if (activeLease) return `共享资源 ${activeLease.resourceId} 的租约尚未释放`;
  const unfinishedWorker = item.workerGroup.workers.find((worker) => !['completed', 'superseded'].includes(worker.status));
  if (unfinishedWorker) return `任务 AI ${unfinishedWorker.workerId} 尚未完成或安全终止`;
  const unaccountedWorker = item.workerGroup.workers.find((worker) => (
    worker.role !== 'integrator'
    && worker.status === 'completed'
    && worker.writeClaims.length > 0
    && !(item.mergeCandidates || []).some((candidate) => (
      candidate.workerId === worker.workerId
      && candidate.assignmentVersion === worker.assignmentVersion
      && (candidate.directiveEpoch ?? 0) === worker.directiveEpoch
      && ['applied', 'rejected'].includes(candidate.status)
    ))
  ));
  if (unaccountedWorker) {
    return `任务 AI ${unaccountedWorker.workerId} 有写入职责，但尚无已应用或明确拒绝的当前版本候选`;
  }
  const unapplied = (item.mergeCandidates || []).find((candidate) => !['applied', 'rejected', 'superseded'].includes(candidate.status));
  if (unapplied) return `集成候选 ${unapplied.candidateId} 尚未完成处理`;
  if (item.finalApplyBlocked) return '多任务 AI 最终应用仍被用户直发、基线漂移或合并门禁阻止';
  return null;
}

export function resolveProjectParallelismDecision(options: {
  execution?: ProjectTaskExecutionPlan;
  stagePlan?: Pick<ProjectSupervisorStagePlan, 'workerAssignments'>;
  requirementsVersion: number;
  previousEpoch?: number;
  now?: number;
}): ProjectParallelismDecision {
  const legacyMode = options.execution?.taskWorkMode || 'single-thread';
  const requestedMode = normalizeProjectParallelismSelection(
    options.execution?.parallelismSelection,
    legacyMode,
  );
  const assignments = normalizeProjectWorkerAssignments(options.stagePlan?.workerAssignments);
  const assignmentViolation = assignments.length > 0 ? projectWorkerAssignmentsViolation(assignments) : null;
  let resolvedMode: ProjectParallelismMode;
  let reason: string;
  const evidence: string[] = [];
  if (requestedMode !== 'auto') {
    resolvedMode = requestedMode;
    reason = options.execution?.modeReason?.trim() || `项目 AI 固定选择 ${requestedMode}`;
  } else if (assignments.length >= 2 && !assignmentViolation) {
    resolvedMode = 'worker-group';
    reason = '基线阶段识别出多个可独立验收、写域互斥的长期交付成果';
    evidence.push(`${assignments.length} 个任务 AI；写入区域和依赖图已通过校验`);
  } else if (options.execution?.parallelizableOperations?.length && options.execution?.taskWorkMode !== 'single-thread') {
    resolvedMode = 'internal-threads';
    reason = '存在可并行分析工作，但没有形成可安全隔离的独立写入交付';
    evidence.push(`${options.execution?.parallelizableOperations?.length || 0} 个可并行分析边界`);
  } else {
    resolvedMode = 'single-worker';
    reason = '未发现两个以上值得独立调度且可安全隔离的并行单元';
  }
  if (assignmentViolation) evidence.push(`工人方案未采用：${assignmentViolation}`);
  return {
    requestedMode,
    resolvedMode,
    requirementsVersion: Math.max(1, Math.trunc(options.requirementsVersion || 1)),
    executionEpoch: Math.max(1, Math.trunc(options.previousEpoch || 0) + 1),
    reason,
    evidence,
    resolvedAt: options.now ?? Date.now(),
  };
}

/** Upgrade stored sessions once at the boundary so runtime code has one coherent goal model. */
export function normalizeProjectManagerSession(session: ProjectManagerSession): ProjectManagerSession {
  const { goalConstruction: _legacyGoalConstruction, ...sessionWithoutLegacyGoalConstruction } = session as ProjectManagerSession & {
    goalConstruction?: unknown;
  };
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
    ...sessionWithoutLegacyGoalConstruction,
    projectName: projectDisplayName(session),
    projectScope: session.projectScope?.trim() || `仅限项目目录 ${session.projectDir} 内与本项目直接相关的工作`,
    activeGoalId,
    goals,
    subgoals,
    goal: activeGoal.statement,
    supervisorNotes: (Array.isArray(session.supervisorNotes) ? session.supervisorNotes : [])
      .slice(0, 20)
      .map((item) => item.trim().slice(0, 4000))
      .filter(Boolean),
    doneWhen: activeGoal.doneWhen,
    requirementsVersion,
    authorizationVersion,
    acceptedRequirementsVersion: projectAcceptedRequirementsVersion(session),
    executionProtocolVersion: Math.max(0, Math.trunc(session.executionProtocolVersion || 0)),
    progressSnapshot: normalizeProjectProgressSnapshot(session.progressSnapshot),
    progressSync: normalizeProjectProgressSyncState(session.progressSync),
    orientation: normalizeProjectOrientationState(session.orientation),
    pendingSupervisorTransitions: (Array.isArray(session.pendingSupervisorTransitions)
      ? session.pendingSupervisorTransitions
      : [])
      .slice(-50)
      .filter((transition): transition is ProjectSupervisorTransition => (
        !!transition
        && typeof transition.id === 'string' && !!transition.id.trim()
        && typeof transition.laneId === 'string' && !!transition.laneId.trim()
        && ['stage-complete', 'direction-needed', 'decision-required', 'supervisor-unavailable', 'supervisor-idle', 'project-action-required']
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
        contract: {
          ...item.contract,
          execution: item.contract.execution ? {
            ...item.contract.execution,
            parallelismSelection: normalizeProjectParallelismSelection(
              item.contract.execution.parallelismSelection,
              item.contract.execution.taskWorkMode,
            ),
          } : undefined,
          budget: normalizeProjectExecutionBudget(item.contract.budget),
          supervisorNotes: (Array.isArray(item.contract.supervisorNotes)
            ? item.contract.supervisorNotes
            : [])
            .slice(0, 20)
            .map((note) => note.trim().slice(0, 4000))
            .filter(Boolean),
        },
        goalId: item.goalId || activeGoalId,
        subgoalId: item.subgoalId || (needsLegacySubgoal ? legacySubgoalId : undefined),
        requirementsVersion: itemRequirementsVersion,
        authorizationVersion: Math.max(1, Math.trunc(item.authorizationVersion || authorizationVersion)),
        executionProtocolVersion: Math.max(0, Math.trunc(item.executionProtocolVersion || 0)),
        baseline: activeBaseline
          ? item.baseline
          : requiredProjectTaskBaseline(itemRequirementsVersion),
        parallelismDecision: item.parallelismDecision?.requirementsVersion === itemRequirementsVersion
          ? {
              ...item.parallelismDecision,
              requestedMode: normalizeProjectParallelismSelection(item.parallelismDecision.requestedMode),
              resolvedMode: item.parallelismDecision.resolvedMode === 'internal-threads'
                || item.parallelismDecision.resolvedMode === 'worker-group'
                ? item.parallelismDecision.resolvedMode
                : 'single-worker',
              requirementsVersion: itemRequirementsVersion,
              executionEpoch: Math.max(1, Math.trunc(item.parallelismDecision.executionEpoch || 1)),
              evidence: Array.isArray(item.parallelismDecision.evidence)
                ? item.parallelismDecision.evidence.slice(0, 20).map((entry) => String(entry).slice(0, 2000))
                : [],
            }
          : undefined,
        workerGroup: item.workerGroup?.workers?.length
          ? {
              ...item.workerGroup,
              workers: item.workerGroup.workers.slice(0, MAX_PROJECT_ACTIVE_WORKERS).map((worker) => ({
                ...normalizeProjectWorkerAssignment(worker),
                status: worker.status,
                assignmentVersion: Math.max(1, Math.trunc(worker.assignmentVersion || 1)),
                directiveEpoch: Math.max(0, Math.trunc(worker.directiveEpoch || 0)),
                surfaceId: worker.surfaceId,
                laneId: worker.laneId,
                worktreeId: worker.worktreeId,
                worktreePath: worker.worktreePath,
                checkpoint: worker.checkpoint,
                resourceWait: worker.resourceWait && Number.isFinite(worker.resourceWait.requestedAt)
                  ? {
                      resourceId: String(worker.resourceWait.resourceId || '').slice(0, 200),
                      mode: worker.resourceWait.mode,
                      operationId: String(worker.resourceWait.operationId || '').slice(0, 200),
                      idempotent: worker.resourceWait.idempotent === true,
                      requestedAt: worker.resourceWait.requestedAt,
                    }
                  : undefined,
                startedAt: Number.isFinite(worker.startedAt) ? worker.startedAt : undefined,
                accumulatedActiveMs: Math.max(0, Number(worker.accumulatedActiveMs) || 0),
                updatedAt: Number.isFinite(worker.updatedAt) ? worker.updatedAt : item.updatedAt,
              })),
              mergeOrder: Array.isArray(item.workerGroup.mergeOrder)
                ? item.workerGroup.mergeOrder.slice(0, MAX_PROJECT_ACTIVE_WORKERS)
                : [],
            }
          : undefined,
        userDirectives: Array.isArray(item.userDirectives) ? item.userDirectives.slice(-100) : [],
        resourceLeases: Array.isArray(item.resourceLeases) ? item.resourceLeases.slice(-100) : [],
        mergeCandidates: Array.isArray(item.mergeCandidates) ? item.mergeCandidates.slice(-100) : [],
        finalApplyBlocked: item.finalApplyBlocked === true,
        mutationRevision: Math.max(0, Math.trunc(item.mutationRevision || 0)),
        supervisorPlanRequired: item.supervisorPlanRequired
          ?? !['completed', 'stopped'].includes(item.status),
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
    supervisorNotes?: string[];
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
  | { type: 'reset-work-item-baseline'; workItemId: string; reason: string }
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
  | {
    type: 'record-execution';
    workItemId: string;
    record: ProjectExecutionRecord;
    /** Rejected or failed delivery attempts remain auditable without spending autonomy budget. */
    consumeDecision?: boolean;
  }
  | {
    type: 'pause-project';
    reason: string;
    source?: 'user' | 'manager' | 'portfolio' | 'runtime' | 'system';
    /** Project-AI pauses caused by a material blocker must be surfaced to the user. */
    attentionRequired?: boolean;
  }
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
    maxAggregateWorkerMinutes: positiveInteger(
      value?.maxAggregateWorkerMinutes,
      DEFAULT_PROJECT_EXECUTION_BUDGET.maxAggregateWorkerMinutes,
      MAX_PROJECT_EXECUTION_BUDGET.maxAggregateWorkerMinutes,
    ),
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
