import type { ProjectManagementAgentConfig } from './project-manager-terminal';

export const MAX_PROJECT_PLAN_FILES = 3;
export const MAX_PROJECT_PLAN_FILE_BYTES = 1024 * 1024;
/** Bump whenever restored work must be re-contracted before current supervisors may execute it. */
export const CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION = 9;

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
  | 'supervisor-status'
  | 'supervisor-handoff'
  | 'supervisor-transition'
  | 'supervisor-transition-acknowledged'
  | 'supervisor-decision-request'
  | 'supervisor-direction'
  | 'progress-inspection'
  | 'terminal-rotated'
  | 'task-context-reset'
  | 'recovery-restored'
  | 'execution-protocol-migrated'
  | 'manager-runtime-restarted'
  | 'manager-runtime-failed'
  | 'supervisor-runtime-failed'
  | 'task-runtime-failed'
  | 'project-agent-config-updated'
  | 'project-agent-limit-detected'
  | 'project-agent-runtime-switched'
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
  | 'user-clarification-restored'
  | 'user-clarification-answered'
  | 'user-clarification-invalidated'
  | 'requirements-alignment-required'
  | 'requirements-alignment-confirmed'
  | 'project-definition-updated'
  | 'project-subgoals-updated'
  | 'project-goal-completed'
  | 'project-goal-completion-invalidated'
  | 'project-preconditions-updated'
  | 'supervisor-decision'
  | 'guard-triggered'
  | 'project-paused'
  | 'project-resumed'
  | 'project-safe-exit-requested'
  | 'project-safe-exit-failed'
  | 'project-safe-exit-completed'
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
  'internal-project-failure',
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

export const PROJECT_RETRY_KINDS = [
  'task-failure',
  'command-correction',
  'evidence-closure',
  'runtime-recovery',
] as const;

export type ProjectRetryKind = typeof PROJECT_RETRY_KINDS[number];

/** One route correction is enough to prove whether a new direction can produce material progress. */
export const MAX_PROJECT_CONSECUTIVE_INTERNAL_REPLANS = 1;

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

export interface ProjectSupervisorContract {
  objective: string;
  description: string;
  preconditions: string[];
  /** Checkpoint and handoff reminders consumed by the supervisor, not direct task-AI instructions. */
  supervisorNotes?: string[];
  scope: ProjectWorkScope;
  authority: ProjectSupervisorAuthority;
  stopWhen: string[];
  validation: string[];
  budget: ProjectExecutionBudget;
}

export interface ProjectExecutionRecord {
  ts: number;
  /** False records a rejected/failed delivery attempt without affecting execution-loop accounting. */
  consumedDecision?: boolean;
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
  /** Verified supervisor-plan progress used to renew a healthy autonomy window. */
  planProgressSignature?: string;
  /** Content-addressed project artifacts verified by the control plane for a read-only evidence review. */
  evidenceProgressSignature?: string;
  /** Only task-failure consumes the work item's task retry budget. */
  retryKind?: ProjectRetryKind;
  escalationBoundary?: ProjectEscalationBoundary;
}

export interface ProjectExecutionWindowReplan {
  reason: string;
  requestedAt: number;
  trigger: 'decision-limit' | 'time-limit' | 'no-progress';
  previousDirectionSignature?: string;
}

export type ProjectCriterionVerificationStatus = 'satisfied' | 'unsatisfied' | 'unverified';
export type ProjectCriterionResult = 'passed' | 'failed' | 'inconclusive' | 'not-run';
export type ProjectCriterionMethod = 'runtime-test' | 'static-check' | 'evidence-review';

export interface ProjectEvidenceArtifact {
  ref: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

/** One explicit acceptance judgment. `satisfied` is the only status that can close a stage or goal. */
export interface ProjectCriterionVerification {
  criterion: string;
  status: ProjectCriterionVerificationStatus;
  result: ProjectCriterionResult;
  method: ProjectCriterionMethod;
  evidence: string;
  evidenceRefs: string[];
  evidenceArtifacts?: ProjectEvidenceArtifact[];
}

/** Final result reported by a supervisor or aggregated for a project stage. */
export interface ProjectCompletionResult {
  summary: string;
  validation: string[];
  evidence?: string;
  criteria?: ProjectCriterionVerification[];
  completedAt: number;
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
  /** A contract-only change reuses the last approval and reviews only the delta. */
  reviewKind?: 'contract-delta';
  deltaSummary?: string;
  priorWorkspaceVersion?: string;
  priorEvidence?: string;
  priorApprovedAt?: number;
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
  completion?: ProjectCompletionResult;
}

export interface ProjectWorkItem {
  id: string;
  /** Immutable predecessor/successor audit chain owned by the control plane. */
  predecessorWorkItemId?: string;
  supersededByWorkItemId?: string;
  successionReason?: 'protocol-migration' | 'budget-exhausted';
  /** Immutable main-goal ownership. Old-goal tasks cannot be rebound across a pivot. */
  goalId?: string;
  /** Coarse project-AI stage that owns this executable task. */
  subgoalId?: string;
  /** Requirements and inherited-authorization versions accepted for this task contract. */
  requirementsVersion?: number;
  authorizationVersion?: number;
  /** Contract semantics version. Older unfinished items must be re-contracted before dispatch. */
  executionProtocolVersion?: number;
  /** Project-AI decision made before dispatch so one task AI receives one focused outcome. */
  complexityAssessment?: ProjectTaskComplexityAssessment;
  /** Durable in-place context reset state. Project files and terminal identity are never replaced. */
  contextReset?: ProjectTaskContextResetState;
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
  attempts: number;
  /** Decisions consumed in the current renewable autonomy window. */
  decisionsUsed: number;
  /** Monotonic audit total across all renewed autonomy windows. */
  totalDecisionsUsed?: number;
  /** Number of verified-progress autonomy-window renewals; internal replans are counted separately. */
  budgetWindowRenewals?: number;
  /** Monotonic audit count of accepted in-place route corrections. */
  internalReplanCount?: number;
  /** Route corrections since the latest verified checkpoint or baseline approval. */
  consecutiveInternalReplans?: number;
  /** Last verified progress already credited with opening a new autonomy window. */
  lastBudgetCheckpointSignature?: string;
  /** Control-owned gate requiring the project AI to provide a materially different internal route. */
  executionWindowReplan?: ProjectExecutionWindowReplan;
  /** Recent accepted internal-route signatures prevent A/B cycling across renewed windows. */
  executionWindowReplanHistory?: string[];
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  completion?: ProjectCompletionResult;
  executionHistory: ProjectExecutionRecord[];
  latestEvidence?: string;
  latestContextSummary?: string;
  latestBlocker?: string;
}

export type ProjectTaskComplexityLevel = 'low' | 'medium' | 'high';
export type ProjectTaskSplitDecision = 'single-task' | 'split-before-dispatch';

export interface ProjectTaskComplexityAssessment {
  complexity: ProjectTaskComplexityLevel;
  decision: ProjectTaskSplitDecision;
  signals: string[];
  rationale: string;
  assessedAt: number;
}

export type ProjectTaskContextResetStatus = 'requested' | 'cleared' | 'republished' | 'failed';

export interface ProjectTaskContextResetState {
  generation: number;
  count: number;
  status: ProjectTaskContextResetStatus;
  fingerprint: string;
  reason: string;
  evidence: string;
  cleanContext: string;
  requestedAt: number;
  completedAt?: number;
  error?: string;
}

export function normalizeProjectTaskComplexityAssessment(
  value: unknown,
  fallbackAssessedAt?: number,
): ProjectTaskComplexityAssessment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<ProjectTaskComplexityAssessment>;
  if (!['low', 'medium', 'high'].includes(String(raw.complexity))
    || !['single-task', 'split-before-dispatch'].includes(String(raw.decision))
    || !Array.isArray(raw.signals)
    || raw.signals.length < 1
    || raw.signals.length > 8
    || raw.signals.some((signal) => typeof signal !== 'string' || !signal.trim())
    || typeof raw.rationale !== 'string'
    || !raw.rationale.trim()) return undefined;
  const assessedAt = Number.isFinite(raw.assessedAt) ? Number(raw.assessedAt) : fallbackAssessedAt;
  if (!Number.isFinite(assessedAt)) return undefined;
  return {
    complexity: raw.complexity as ProjectTaskComplexityLevel,
    decision: raw.decision as ProjectTaskSplitDecision,
    signals: [...new Set(raw.signals.map((signal) => signal.trim().slice(0, 1000)))],
    rationale: raw.rationale.trim().slice(0, 4000),
    assessedAt: Number(assessedAt),
  };
}

export function normalizeProjectTaskContextResetState(
  value: unknown,
): ProjectTaskContextResetState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<ProjectTaskContextResetState>;
  if (!Number.isInteger(raw.generation) || Number(raw.generation) < 2
    || raw.count !== 1
    || !['requested', 'cleared', 'republished', 'failed'].includes(String(raw.status))
    || typeof raw.fingerprint !== 'string' || !raw.fingerprint.trim()
    || typeof raw.reason !== 'string' || !raw.reason.trim()
    || typeof raw.evidence !== 'string' || !raw.evidence.trim()
    || typeof raw.cleanContext !== 'string' || !raw.cleanContext.trim()
    || !Number.isFinite(raw.requestedAt)
    || (raw.completedAt !== undefined && !Number.isFinite(raw.completedAt))
    || (raw.error !== undefined && typeof raw.error !== 'string')) return undefined;
  return {
    generation: Number(raw.generation),
    count: Number(raw.count),
    status: raw.status as ProjectTaskContextResetStatus,
    fingerprint: raw.fingerprint.trim().slice(0, 200),
    reason: raw.reason.trim().slice(0, 4000),
    evidence: raw.evidence.trim().slice(0, 12_000),
    cleanContext: raw.cleanContext.trim().slice(0, 12_000),
    requestedAt: Number(raw.requestedAt),
    ...(raw.completedAt !== undefined ? { completedAt: Number(raw.completedAt) } : {}),
    ...(raw.error?.trim() ? { error: raw.error.trim().slice(0, 4000) } : {}),
  };
}

export function projectTaskContextResetFingerprint(
  workItemId: string,
  reason: string,
  evidence: string,
): string {
  const input = [workItemId, reason, evidence]
    .map((part) => part.trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' '))
    .join('\u0000');
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `ctx-${hash.toString(16).padStart(8, '0')}`;
}

export function normalizeProjectCompletionResult(
  value: ProjectCompletionResult | undefined,
): ProjectCompletionResult | undefined {
  if (!value || !Number.isFinite(value.completedAt)) return undefined;
  const summary = String(value.summary || '').trim().slice(0, 12_000);
  if (!summary) return undefined;
  const validation = [...new Set((Array.isArray(value.validation) ? value.validation : [])
    .map((item) => String(item || '').trim().slice(0, 4000))
    .filter(Boolean))].slice(0, 20);
  const evidence = String(value.evidence || '').trim().slice(0, 12_000) || undefined;
  const criteria = (Array.isArray(value.criteria) ? value.criteria : []).slice(0, 100).flatMap((item) => {
    const criterion = String(item?.criterion || '').trim().slice(0, 4000);
    const status = String(item?.status || '').trim() as ProjectCriterionVerificationStatus;
    const result = String(item?.result || '').trim() as ProjectCriterionResult;
    const method = String(item?.method || '').trim() as ProjectCriterionMethod;
    const criterionEvidence = String(item?.evidence || '').trim().slice(0, 12_000);
    const evidenceRefs = [...new Set((Array.isArray(item?.evidenceRefs) ? item.evidenceRefs : [])
      .map((entry) => String(entry || '').trim().replace(/\\/g, '/').slice(0, 500))
      .filter(Boolean))].slice(0, 20);
    const evidenceArtifacts = (Array.isArray(item?.evidenceArtifacts) ? item.evidenceArtifacts : [])
      .slice(0, 20).flatMap((artifact) => {
        const ref = String(artifact?.ref || '').trim().replace(/\\/g, '/').slice(0, 500);
        const sizeBytes = Number(artifact?.sizeBytes);
        const mtimeMs = Number(artifact?.mtimeMs);
        const sha256 = String(artifact?.sha256 || '').trim().toLowerCase();
        return ref
          && Number.isFinite(sizeBytes) && sizeBytes > 0
          && Number.isFinite(mtimeMs) && mtimeMs >= 0
          && /^[a-f0-9]{64}$/u.test(sha256)
          ? [{ ref, sizeBytes, mtimeMs, sha256 }]
          : [];
      });
    return criterion
      && criterionEvidence
      && ['satisfied', 'unsatisfied', 'unverified'].includes(status)
      && ['passed', 'failed', 'inconclusive', 'not-run'].includes(result)
      && ['runtime-test', 'static-check', 'evidence-review'].includes(method)
      && evidenceRefs.length > 0
      ? [{
          criterion, status, result, method, evidence: criterionEvidence, evidenceRefs,
          ...(evidenceArtifacts.length > 0 ? { evidenceArtifacts } : {}),
        }]
      : [];
  });
  return {
    summary,
    validation,
    ...(evidence ? { evidence } : {}),
    ...(criteria.length > 0 ? { criteria } : {}),
    completedAt: value.completedAt,
  };
}

export function projectCriterionIdentity(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function projectCriterionRequiresRuntimeTest(value: string): boolean {
  return /(?:上机|实机|复测|实际运行|硬件测试|设备测试|执行.{0,20}(?:测试|验证)|(?:双向|重复一致性).{0,20}(?:测试|验证))/iu.test(value);
}

export function projectCriterionRequiresPassingResult(value: string): boolean {
  return /(?:通过|达标|合格|成功|无\s*(?:FAIL|失败)|(?:满足|低于|不超过).{0,20}(?:阈值|标准|要求)|\bPASS\b)/iu.test(value);
}

/** Reject incomplete, inconclusive, unverified, duplicate, or unrelated acceptance claims. */
export function projectCompletionCriteriaError(
  expected: readonly string[],
  completion: ProjectCompletionResult | undefined,
  label = '验收条件',
  options: { allowExtra?: boolean; requireArtifacts?: boolean } = {},
): string | null {
  const required = expected.map((criterion) => ({
    criterion,
    identity: projectCriterionIdentity(criterion),
  })).filter((entry) => !!entry.identity);
  if (required.length === 0) return null;
  const checks = normalizeProjectCompletionResult(completion)?.criteria || [];
  if (checks.length === 0) return `${label}缺少逐项结构化核验，不能完成`;
  const seen = new Set<string>();
  for (const check of checks) {
    const identity = projectCriterionIdentity(check.criterion);
    if (seen.has(identity)) return `${label}存在重复核验项：${check.criterion}`;
    seen.add(identity);
  }
  if (!options.allowExtra) {
    const unrelated = checks.find((check) => (
      !required.some((entry) => entry.identity === projectCriterionIdentity(check.criterion))
    ));
    if (unrelated) return `${label}包含不属于当前合同的核验项：${unrelated.criterion}`;
  }
  for (const entry of required) {
    const check = checks.find((candidate) => projectCriterionIdentity(candidate.criterion) === entry.identity);
    if (!check) return `${label}尚未核验：${entry.criterion}`;
    if (check.status !== 'satisfied') {
      return `${label}未满足：${entry.criterion}（status=${check.status}, result=${check.result}, method=${check.method}：${check.evidence}）`;
    }
    if (check.result === 'not-run' || check.result === 'inconclusive') {
      return `${label}尚无可收敛结论：${entry.criterion}（result=${check.result}, method=${check.method}：${check.evidence}）`;
    }
    if (projectCriterionRequiresRuntimeTest(entry.criterion) && check.method !== 'runtime-test') {
      return `${label}要求实际运行/实机证据，${check.method} 不能代替：${entry.criterion}`;
    }
    if (check.result === 'failed' && projectCriterionRequiresPassingResult(entry.criterion)) {
      return `${label}明确要求通过/达标，失败结果不能满足：${entry.criterion}`;
    }
    if (!check.evidence.trim()) return `${label}缺少证据：${entry.criterion}`;
    if (check.evidenceRefs.length === 0) return `${label}缺少实际证据引用：${entry.criterion}`;
    if (options.requireArtifacts && check.evidenceRefs.some((ref) => (
      !check.evidenceArtifacts?.some((artifact) => artifact.ref === ref)
    ))) {
      return `${label}的实际证据尚未由控制层读取并记录内容哈希：${entry.criterion}`;
    }
  }
  return null;
}

/** Present pre-upgrade completed work without mutating its historical record. */
export function projectWorkItemCompletionResult(item: ProjectWorkItem): ProjectCompletionResult | undefined {
  const stored = normalizeProjectCompletionResult(item.completion);
  if (stored) return stored;
  if (!['validating', 'completed'].includes(item.status)) return undefined;
  const summary = item.latestContextSummary?.trim() || item.latestEvidence?.trim();
  if (!summary) return undefined;
  return {
    summary: summary.slice(0, 12_000),
    validation: item.contract.validation.slice(0, 20),
    ...(item.latestEvidence?.trim() ? { evidence: item.latestEvidence.trim().slice(0, 12_000) } : {}),
    completedAt: item.completedAt || item.updatedAt,
  };
}

/** Preserve old completed projects by deriving a stage result from their completed work items. */
export function projectSubgoalCompletionResult(
  subgoal: Pick<ProjectSubgoal, 'id' | 'status' | 'updatedAt' | 'completion'>,
  workItems: readonly ProjectWorkItem[],
): ProjectCompletionResult | undefined {
  const stored = normalizeProjectCompletionResult(subgoal.completion);
  if (stored) return stored;
  if (subgoal.status !== 'achieved') return undefined;
  const completedItems = workItems.filter((item) => (
    item.subgoalId === subgoal.id && (item.status === 'completed' || !!item.completion)
  ));
  const summaries = completedItems.map((item) => (
    projectWorkItemCompletionResult(item)?.summary
    || ''
  )).filter(Boolean);
  const validation = [...new Set(completedItems.flatMap((item) => {
    const completion = projectWorkItemCompletionResult(item);
    return completion?.validation.length
      ? completion.validation
      : item.latestEvidence?.trim() ? [item.latestEvidence.trim()] : [];
  }))].slice(0, 20);
  const evidence = completedItems.map((item) => (
    projectWorkItemCompletionResult(item)?.evidence || item.latestEvidence || ''
  )).filter(Boolean).join('\n').slice(0, 12_000) || undefined;
  const criteria = new Map<string, ProjectCriterionVerification>();
  for (const check of completedItems.flatMap((item) => (
    projectWorkItemCompletionResult(item)?.criteria || []
  ))) {
    const identity = projectCriterionIdentity(check.criterion);
    const previous = criteria.get(identity);
    criteria.set(identity, previous ? {
      ...previous,
      status: previous.status === 'satisfied' && check.status === 'satisfied'
        ? 'satisfied'
        : previous.status === 'unsatisfied' || check.status === 'unsatisfied' ? 'unsatisfied' : 'unverified',
      result: previous.result === check.result ? previous.result : 'inconclusive',
      method: previous.method === check.method ? previous.method : 'evidence-review',
      evidence: `${previous.evidence}\n${check.evidence}`.slice(0, 12_000),
      evidenceRefs: [...new Set([...previous.evidenceRefs, ...check.evidenceRefs])].slice(0, 20),
      evidenceArtifacts: [...(previous.evidenceArtifacts || []), ...(check.evidenceArtifacts || [])]
        .filter((artifact, index, all) => all.findIndex((candidate) => candidate.ref === artifact.ref) === index)
        .slice(0, 20),
    } : check);
  }
  if (summaries.length === 0 && !evidence) return undefined;
  return {
    summary: summaries.join('\n').slice(0, 12_000) || evidence!,
    validation,
    ...(evidence ? { evidence } : {}),
    criteria: [...criteria.values()].slice(0, 100),
    completedAt: Math.max(
      subgoal.updatedAt,
      ...completedItems.map((item) => item.completedAt || item.completion?.completedAt || item.updatedAt),
    ),
  };
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
  if (event.payload?.attentionRequired === false) return false;
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
      resolvedKinds.add('project-goal-completed');
    } else if (event.kind === 'project-goal-completion-invalidated') {
      resolvedKinds.add('project-goal-completed');
    } else if (event.kind === 'manager-runtime-restarted') {
      resolvedKinds.add('manager-runtime-failed');
      resolvedKinds.add('manager-delivery-failed');
    } else if (event.kind === 'manager-delivery-restored') {
      resolvedKinds.add('manager-delivery-failed');
      // A lifecycle acknowledgement from the manager terminal also proves
      // that an earlier startup/runtime failure is no longer current.
      resolvedKinds.add('manager-runtime-failed');
    } else if (event.kind === 'project-agent-runtime-switched') {
      resolvedKinds.add('project-agent-limit-detected');
    } else if (event.kind === 'recovery-restored') {
      resolvedKinds.add('manager-runtime-failed');
      resolvedKinds.add('supervisor-runtime-failed');
      resolvedKinds.add('task-runtime-failed');
      resolvedKinds.add('project-safe-exit-failed');
    } else if (event.kind === 'project-safe-exit-completed') {
      resolvedKinds.add('project-safe-exit-failed');
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
  /** Keeps repeated internal recovery notices to one pending message per runtime scope. */
  dedupeKey?: string;
  /** Keeps an actionable supervisor transition traceable after PTY delivery. */
  transitionId?: string;
  /** Drops an internal gate continuation when the target/version/obligation has changed. */
  continuationKey?: string;
  /** Actionable decisions stay ahead of informational messages, including after restore. */
  priority?: boolean;
  /** PTY transport progress; submitted messages await an Agent lifecycle acknowledgement. */
  stage?: 'pending' | 'submitting' | 'submitted' | 'failed';
  submittedAt?: number;
}

export type ProjectAgentRole = 'manager' | 'supervisor' | 'task';

export interface ProjectAgentRuntimeIssue {
  role: ProjectAgentRole;
  category: 'rate-limit' | 'quota-limit';
  summary: string;
  detectedAt: number;
  surfaceId?: string;
  laneId?: string;
  workItemId?: string;
}

export interface ProjectAgentReconfiguration {
  status: 'applying' | 'pending-safe-point' | 'failed';
  requestedAt: number;
  roles: ProjectAgentRole[];
  pendingRoles: ProjectAgentRole[];
  completedRoles: ProjectAgentRole[];
  error?: string;
}

export interface ProjectSafeExitTerminalCheckpoint {
  surfaceId: string;
  role: 'project-ai' | 'supervisor-ai' | 'task-ai';
  label: string;
  workItemId?: string;
  activityState: 'idle' | 'working' | 'blocked' | 'unknown';
  activityUpdatedAt?: number;
  inputState?: 'empty' | 'pending' | 'unknown';
  excerpt?: string;
}

/** Durable state for a user-requested, recoverable shutdown of one project runtime. */
export interface ProjectSafeExitState {
  status: 'saving' | 'blocked' | 'saved' | 'restoring';
  requestedAt: number;
  updatedAt: number;
  completedAt?: number;
  reason: string;
  progressFingerprint?: string;
  terminalCheckpoints: ProjectSafeExitTerminalCheckpoint[];
  blockedTerminalIds?: string[];
  error?: string;
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
  /** The only work item currently bound to the persistent task/supervisor runtime. */
  activeWorkItemId?: string;
  managerSurfaceId?: string;
  feishuChatId?: string;
  recoveryState?: 'ready' | 'checking';
  /** Present while a project is saving, safely detached, or rebuilding from a safe exit. */
  safeExit?: ProjectSafeExitState;
  /** Last workspace state explicitly seen by the project AI or a trusted stage checkpoint. */
  progressSnapshot?: ProjectProgressSnapshot;
  /** Blocks stale task dispatch until the project AI has reviewed a changed recovery snapshot. */
  progressSync?: ProjectProgressSyncState;
  /** Blocks project-level planning and dispatch until the project AI records a structured understanding. */
  orientation?: ProjectOrientationState;
  pendingUserQuestion?: ProjectManagerUserQuestion;
  /** Project-specific runtime selection; absent legacy sessions inherit current defaults. */
  agentConfig?: ProjectManagementAgentConfig;
  /** Provider quota/rate-limit issue waiting for a user-selected runtime replacement. */
  agentIssue?: ProjectAgentRuntimeIssue;
  /** Durable safe-switch progress so working Agents can rotate at their next Stop. */
  agentReconfiguration?: ProjectAgentReconfiguration;
  /** Manager-bound messages retained until the manager Agent acknowledges prompt submission. */
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

/** Project AI may rewrite a user-owned main goal only to apply newer user input. */
export function projectManagerGoalChangeHasUserBasis(
  session: ProjectManagerSession,
  nextGoal: string,
): boolean {
  if (nextGoal.trim() === session.goal.trim()) return true;
  const latestDefinitionIndex = session.events.reduce((latest, event, index) => (
    event.kind === 'project-definition-updated' ? index : latest
  ), -1);
  return session.events.slice(latestDefinitionIndex + 1).some((event) => (
    (event.kind === 'user-clarification-answered'
      && event.payload?.category !== 'manual-intervention'
      && !event.workItemId)
    || (event.kind === 'user-message' && event.payload?.changeSignal === 'requirements-change')
  ));
}

export function projectDisplayName(session: Pick<ProjectManagerSession, 'projectName' | 'projectDir' | 'goal'>): string {
  return session.projectName?.trim() || fallbackProjectName(session);
}

export function projectPlanningConfirmationError(
  session: Pick<ProjectManagerSession, 'events'>,
  options: {
    changesUserPlan: boolean;
    supplements?: readonly string[];
    userConfirmationEventId?: string;
  },
): string | null {
  const supplements = (options.supplements || []).map((item) => item.trim()).filter(Boolean);
  if (!options.changesUserPlan && supplements.length === 0) return null;
  const confirmationEventId = options.userConfirmationEventId?.trim() || '';
  if (!confirmationEventId) {
    return '准备补充或改变用户规划；必须先通过 project ask 与用户确认，并携带 userConfirmationEventId';
  }
  const confirmation = session.events.find((event) => event.id === confirmationEventId);
  if (!confirmation || !['user-message', 'user-clarification-answered'].includes(confirmation.kind)) {
    return 'userConfirmationEventId 必须指向当前项目中的用户消息或结构化用户答复';
  }
  const latestPlanningChangeAt = session.events.reduce((latest, event) => (
    ['project-definition-updated', 'project-subgoals-updated'].includes(event.kind)
      ? Math.max(latest, event.ts)
      : latest
  ), 0);
  if (confirmation.ts < latestPlanningChangeAt) {
    return '用户确认早于最近一次项目定义或阶段计划变更；必须重新展示补充项并取得新确认';
  }
  if (supplements.length > 0 && confirmation.kind !== 'user-clarification-answered') {
    return 'AI 补充规划必须先通过 project ask 取得结构化用户答复，不能用普通用户消息替代确认';
  }
  return null;
}

function normalizeProjectSafeExitState(value: ProjectSafeExitState | undefined): ProjectSafeExitState | undefined {
  if (!value || !['saving', 'blocked', 'saved', 'restoring'].includes(value.status)) return undefined;
  if (!Number.isFinite(value.requestedAt) || !Number.isFinite(value.updatedAt)) return undefined;
  return {
    status: value.status,
    requestedAt: value.requestedAt,
    updatedAt: value.updatedAt,
    ...(Number.isFinite(value.completedAt) ? { completedAt: value.completedAt } : {}),
    reason: String(value.reason || '').trim().slice(0, 2000),
    ...(value.progressFingerprint?.trim()
      ? { progressFingerprint: value.progressFingerprint.trim().slice(0, 500) }
      : {}),
    terminalCheckpoints: (Array.isArray(value.terminalCheckpoints) ? value.terminalCheckpoints : [])
      .slice(0, 100)
      .filter((checkpoint) => (
        !!checkpoint
        && typeof checkpoint.surfaceId === 'string'
        && ['project-ai', 'supervisor-ai', 'task-ai'].includes(checkpoint.role)
        && ['idle', 'working', 'blocked', 'unknown'].includes(checkpoint.activityState)
      ))
      .map((checkpoint) => ({
        surfaceId: checkpoint.surfaceId.trim().slice(0, 200),
        role: checkpoint.role,
        label: String(checkpoint.label || '').trim().slice(0, 500),
        ...(checkpoint.workItemId?.trim() ? { workItemId: checkpoint.workItemId.trim().slice(0, 200) } : {}),
        activityState: checkpoint.activityState,
        ...(Number.isFinite(checkpoint.activityUpdatedAt) ? { activityUpdatedAt: checkpoint.activityUpdatedAt } : {}),
        ...(['empty', 'pending', 'unknown'].includes(checkpoint.inputState || '')
          ? { inputState: checkpoint.inputState }
          : {}),
        ...(checkpoint.excerpt?.trim() ? { excerpt: checkpoint.excerpt.trim().slice(0, 4000) } : {}),
      })),
    blockedTerminalIds: (Array.isArray(value.blockedTerminalIds) ? value.blockedTerminalIds : [])
      .map((id) => String(id || '').trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 100),
    ...(value.error?.trim() ? { error: value.error.trim().slice(0, 4000) } : {}),
  };
}

/** Keep only the newest unavailable handoff for one work item across replacement lanes. */
export function compactProjectSupervisorTransitions(
  transitions: readonly ProjectSupervisorTransition[],
): ProjectSupervisorTransition[] {
  const seenUnavailableScopes = new Set<string>();
  const compacted: ProjectSupervisorTransition[] = [];
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const transition = transitions[index];
    if (transition.kind === 'supervisor-unavailable') {
      const scope = transition.workItemId || `lane:${transition.laneId}`;
      if (seenUnavailableScopes.has(scope)) continue;
      seenUnavailableScopes.add(scope);
    }
    compacted.push(transition);
  }
  return compacted.reverse();
}

/** Upgrade stored sessions once at the boundary so runtime code has one coherent goal model. */
function normalizeProjectGovernanceSessionState(session: ProjectManagerSession): ProjectManagerSession {
  if ((session.executionProtocolVersion || 0) < 7) return session;
  return {
    ...session,
    workItems: session.workItems.map((item) => ({
      ...item,
      predecessorWorkItemId: undefined,
      supersededByWorkItemId: undefined,
      successionReason: undefined,
      baseline: undefined,
      supervisorPlan: undefined,
      supervisorPlanRequired: false,
      decisionsUsed: 0,
      budgetWindowRenewals: undefined,
      internalReplanCount: undefined,
      consecutiveInternalReplans: undefined,
      lastBudgetCheckpointSignature: undefined,
      executionWindowReplan: undefined,
      executionWindowReplanHistory: undefined,
      contract: {
        ...item.contract,
        scope: {
          root: item.contract.scope.root,
          allowPaths: [],
          denyPaths: [],
          forbiddenActions: [],
        },
        authority: {
          technicalChoices: false,
          lowRiskRetries: false,
          routeAdjustments: false,
          targetedTests: false,
          internalThreads: false,
          continuousExecution: true,
          permissionConfirm: false,
          allowedCommandPrefixes: [],
          authorizedDevices: [],
          authorizedEnvironments: [],
          authorizedOperations: [],
        },
      },
    })),
  };
}

/** Normalize only the current P9 single-task-runtime model; older sessions are rejected during recovery. */
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
  const rawSubgoals = (Array.isArray(session.subgoals) ? session.subgoals : []).map((subgoal) => ({
    ...subgoal,
    completion: normalizeProjectCompletionResult(subgoal.completion),
  }));
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
  return normalizeProjectGovernanceSessionState({
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
    executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
    progressSnapshot: normalizeProjectProgressSnapshot(session.progressSnapshot),
    progressSync: normalizeProjectProgressSyncState(session.progressSync),
    orientation: normalizeProjectOrientationState(session.orientation),
    safeExit: normalizeProjectSafeExitState(session.safeExit),
    pendingSupervisorTransitions: compactProjectSupervisorTransitions((Array.isArray(session.pendingSupervisorTransitions)
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
      }))),
    workItems: session.workItems.map((item) => {
      const itemRequirementsVersion = Math.max(1, Math.trunc(item.requirementsVersion || requirementsVersion));
      const legacyInternalReplanCount = item.internalReplanCount === undefined
        ? session.events.filter((event) => (
            event.workItemId === item.id
            && event.kind === 'guard-triggered'
            && event.payload?.action === 'autonomy-window-renewed'
            && event.payload?.reason === 'internal-replan'
          )).length
        : 0;
      const internalReplanCount = item.internalReplanCount === undefined
        ? legacyInternalReplanCount
        : Math.max(0, Math.trunc(item.internalReplanCount || 0));
      const verifiedProgressRenewals = item.internalReplanCount === undefined
        ? Math.max(0, Math.trunc(item.budgetWindowRenewals || 0) - legacyInternalReplanCount)
        : Math.max(0, Math.trunc(item.budgetWindowRenewals || 0));
      const activeBaseline = item.baseline?.requirementsVersion === itemRequirementsVersion && (
        (item.baseline.status === 'investigating' && Number.isFinite(item.baseline.requestedAt))
        || (item.baseline.status === 'approved'
          && !!item.baseline.workspaceVersion?.trim()
          && !!item.baseline.evidence?.trim())
      );
      return {
        ...item,
        predecessorWorkItemId: item.predecessorWorkItemId?.trim() || undefined,
        supersededByWorkItemId: item.supersededByWorkItemId?.trim() || undefined,
        successionReason: item.successionReason === 'protocol-migration'
          || item.successionReason === 'budget-exhausted'
          ? item.successionReason
          : undefined,
        contract: {
          ...item.contract,
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
        executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
        complexityAssessment: normalizeProjectTaskComplexityAssessment(
          item.complexityAssessment,
          item.updatedAt,
        ) || {
          complexity: 'medium',
          decision: 'single-task',
          signals: ['当前控制层工作项已定义为一个独立可验收成果'],
          rationale: '内部恢复路径保留现有单一成果工作项；新的项目 AI 任务创建必须显式提交复杂度评估',
          assessedAt: item.updatedAt,
        },
        contextReset: normalizeProjectTaskContextResetState(item.contextReset),
        baseline: activeBaseline
          ? item.baseline
          : requiredProjectTaskBaseline(itemRequirementsVersion),
        decisionsUsed: Math.max(0, Math.trunc(item.decisionsUsed || 0)),
        totalDecisionsUsed: Math.max(
          Math.max(0, Math.trunc(item.decisionsUsed || 0)),
          Math.max(0, Math.trunc(item.totalDecisionsUsed ?? item.decisionsUsed ?? 0)),
        ),
        budgetWindowRenewals: verifiedProgressRenewals,
        internalReplanCount,
        consecutiveInternalReplans: Math.max(0, Math.min(
          MAX_PROJECT_CONSECUTIVE_INTERNAL_REPLANS,
          Math.trunc(item.consecutiveInternalReplans || 0),
        )),
        lastBudgetCheckpointSignature: item.lastBudgetCheckpointSignature?.trim().slice(0, 200) || undefined,
        executionWindowReplan: item.executionWindowReplan
          && Number.isFinite(item.executionWindowReplan.requestedAt)
          && !!String(item.executionWindowReplan.reason || '').trim()
          && ['decision-limit', 'time-limit', 'no-progress'].includes(item.executionWindowReplan.trigger)
          ? {
              reason: String(item.executionWindowReplan.reason || '').trim().slice(0, 4000),
              requestedAt: item.executionWindowReplan.requestedAt,
              trigger: item.executionWindowReplan.trigger,
              previousDirectionSignature: item.executionWindowReplan.previousDirectionSignature?.trim().slice(0, 200)
                || undefined,
            }
          : undefined,
        executionWindowReplanHistory: Array.isArray(item.executionWindowReplanHistory)
          ? [...new Set(item.executionWindowReplanHistory
            .map((entry) => String(entry || '').trim().slice(0, 200))
            .filter(Boolean))].slice(-20)
          : [],
        completion: normalizeProjectCompletionResult(item.completion),
        supervisorPlanRequired: item.supervisorPlanRequired
          ?? !['completed', 'stopped'].includes(item.status),
      };
    }),
  });
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
      type: 'renew-execution-window';
      workItemId: string;
      reason: 'verified-progress' | 'internal-replan' | 'decision-limit' | 'time-limit' | 'decision-and-time';
      startedAt: number;
      checkpointSignature?: string;
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
  | { type: 'complete-current-goal'; evidence: string; completion?: ProjectCompletionResult }
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
  item: Pick<ProjectWorkItem, 'requirementsVersion' | 'executionProtocolVersion' | 'baseline'>,
): boolean {
  if ((item.executionProtocolVersion || 0) >= 7) return true;
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
