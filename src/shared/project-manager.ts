import type { ProjectManagementAgentConfig } from './project-manager-terminal';

export const MAX_PROJECT_PLAN_FILES = 3;
export const MAX_PROJECT_PLAN_FILE_BYTES = 1024 * 1024;
/** Bump whenever restored work must be re-contracted before current supervisors may execute it. */
export const CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION = 10;

export type ProjectManagerSessionStatus = 'active' | 'paused' | 'waiting' | 'completed' | 'stopped';

export type ProjectGoalStatus = 'transitioning' | 'active' | 'achieved' | 'superseded' | 'abandoned';

export const PROJECT_USER_ACCEPTANCE_POLICIES = ['always', 'on-gap', 'not-required'] as const;
export type ProjectUserAcceptancePolicy = typeof PROJECT_USER_ACCEPTANCE_POLICIES[number];
export const PROJECT_USER_ACCEPTANCE_REQUIRED_ERROR = '当前目标要求用户最终验收；全部实现和验证门禁已经满足，等待用户确认最终效果';

export const PROJECT_VERIFICATION_REQUIREMENTS = ['required', 'best-effort', 'not-applicable'] as const;
export type ProjectVerificationRequirement = typeof PROJECT_VERIFICATION_REQUIREMENTS[number];
export const PROJECT_VERIFICATION_RISK_CLASSES = ['protected', 'standard'] as const;
export type ProjectVerificationRiskClass = typeof PROJECT_VERIFICATION_RISK_CLASSES[number];

export interface ProjectCriterionVerificationPolicy {
  criterion: string;
  requirement: ProjectVerificationRequirement;
  /** Missing legacy values are protected; relaxation requires explicit standard classification. */
  riskClass?: ProjectVerificationRiskClass;
  reason?: string;
}

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

export type ProjectTaskWorkMode = 'single-thread' | 'multi-thread';

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
  | 'project-execution-stalled'
  | 'project-paused'
  | 'project-resumed'
  | 'project-safe-exit-requested'
  | 'project-safe-exit-failed'
  | 'project-safe-exit-completed'
  | 'project-recovery-requested'
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
  /** Exact planning changes authorized only when this option is selected. */
  confirmationScope?: string[];
}

export const PROJECT_MANAGER_MANUAL_INTERVENTION_REASON_CODES = [
  'physical-action',
  'credentials',
  'access-grant',
  'business-choice',
  'destructive-action',
  'production-action',
  'task-input-conflict',
  'verification-limited',
  'final-acceptance',
  'runtime-recovery',
] as const;

export type ProjectManagerManualInterventionReasonCode =
  typeof PROJECT_MANAGER_MANUAL_INTERVENTION_REASON_CODES[number];

export interface ProjectManagerUserQuestion {
  id: string;
  category?: 'clarification' | 'manual-intervention';
  workItemId?: string;
  blocker?: string;
  reasonCode?: ProjectManagerManualInterventionReasonCode;
  /** Stable semantic scope supplied by Project AI; equal keys may reuse one user-authorized decision. */
  decisionKey?: string;
  /** User-visible meaning boundary for reusable decisions. Paraphrased questions must retain this exact scope. */
  decisionScope?: string;
  /** Exact planning changes shown to the user and authorized by the answer. */
  confirmationScope?: string[];
  question: string;
  context: string;
  options: ProjectManagerQuestionOption[];
  recommendedOptionId?: string;
  previousStatus: ProjectManagerSessionStatus;
  createdAt: number;
}

export interface ProjectReusableUserDecision {
  id: string;
  decisionKey: string;
  semanticFingerprint: string;
  decisionScope?: string;
  projectId?: string;
  workItemId?: string;
  category: 'clarification' | 'manual-intervention';
  reasonCode?: ProjectManagerManualInterventionReasonCode;
  question: string;
  answer: string;
  optionId?: string;
  requirementsVersion: number;
  authorizationVersion: number;
  answeredBy: 'desktop' | 'feishu';
  createdAt: number;
}

export function projectManagerQuestionReusableDecisionScope(
  question: Pick<ProjectManagerUserQuestion, 'question' | 'decisionScope'>,
): string {
  return question.decisionScope?.trim() || `当前问题：${question.question.trim()}`;
}

export interface ProjectManagerReusableDestructiveScope {
  project: string;
  workItem: string;
  operation: 'single-test-record-delete';
  environment: 'local-desktop-app';
  acceptance: string;
}

export function projectManagerReusableDestructiveScope(
  scope: string | undefined,
): ProjectManagerReusableDestructiveScope | undefined {
  const entries = (scope || '').split(';').map((entry): [string, string] => {
    const separator = entry.indexOf('=');
    return separator > 0
      ? [entry.slice(0, separator).trim().toLocaleLowerCase(), entry.slice(separator + 1).trim()]
      : ['', ''];
  }).filter(([key, value]) => !!key && !!value);
  const fields = new Map<string, string>(entries);
  const allowedFields = new Set(['project', 'workitem', 'operation', 'environment', 'acceptance']);
  if (fields.size !== entries.length
    || fields.size !== allowedFields.size
    || [...fields.keys()].some((key) => !allowedFields.has(key))) return undefined;
  const project = fields.get('project') || '';
  const workItem = fields.get('workitem') || '';
  const operation = String(fields.get('operation') || '').toLocaleLowerCase();
  const environment = String(fields.get('environment') || '').toLocaleLowerCase();
  const acceptance = fields.get('acceptance') || '';
  if (!/^pm-[\p{L}\p{N}_-]+$/u.test(project)
    || !/^[\p{L}\p{N}_-]{1,80}$/u.test(workItem)
    || operation !== 'single-test-record-delete'
    || environment !== 'local-desktop-app'
    || !acceptance) return undefined;
  return { project, workItem, operation, environment, acceptance };
}

export function projectManagerDestructiveDecisionScopeMatches(
  scope: string | undefined,
  projectId: string,
  workItemId: string | undefined,
): boolean {
  const parsed = projectManagerReusableDestructiveScope(scope);
  return !!parsed && parsed.project === projectId && parsed.workItem === workItemId;
}

export function projectManagerQuestionAllowsReusableDecision(
  question: Pick<ProjectManagerUserQuestion, 'category' | 'reasonCode'>
    & Partial<Pick<ProjectManagerUserQuestion, 'decisionKey' | 'question' | 'decisionScope' | 'confirmationScope'>>,
): boolean {
  const questionText = question.question?.trim() || '';
  if (!questionText) return false;
  if (question.decisionKey?.trim() && !question.decisionScope?.trim()) return false;
  if (question.category !== 'manual-intervention') return true;
  if (['physical-action', 'access-grant', 'business-choice'].includes(question.reasonCode || '')) return true;
  const confirmationScope = new Set((question.confirmationScope || []).map((entry) => (
    entry.trim().toLocaleLowerCase()
  )));
  return question.reasonCode === 'destructive-action'
    && !!projectManagerReusableDestructiveScope(question.decisionScope)
    && confirmationScope.has('manualoperationauthorization')
    && confirmationScope.has('acceptance');
}

function projectDecisionKeyHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
}

export function projectManagerQuestionDecisionKey(
  question: Pick<ProjectManagerUserQuestion, 'category' | 'reasonCode' | 'decisionKey' | 'question' | 'options'>,
): string {
  const explicit = question.decisionKey?.trim().toLocaleLowerCase();
  if (explicit) return `explicit:${explicit}`;
  const normalized = [
    question.category || 'clarification',
    question.reasonCode || '',
    question.question.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),
    ...question.options.map((option) => `${option.id}:${option.label}`.toLocaleLowerCase()),
  ].join('|');
  return `derived:${projectDecisionKeyHash(normalized)}`;
}

function normalizedProjectDecisionText(value: string | undefined): string {
  return (value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function projectManagerQuestionSemanticFingerprint(
  question: Pick<ProjectManagerUserQuestion, 'category' | 'reasonCode' | 'question' | 'context' | 'options' | 'decisionScope' | 'confirmationScope' | 'workItemId'>,
): string {
  const destructiveAuthorization = question.reasonCode === 'destructive-action';
  const semanticBasis = question.decisionScope?.trim()
    ? [
        `scope:${normalizedProjectDecisionText(question.decisionScope)}`,
        ...(destructiveAuthorization ? [
          `question:${normalizedProjectDecisionText(question.question)}`,
          `context:${normalizedProjectDecisionText(question.context)}`,
          `workItem:${normalizedProjectDecisionText(question.workItemId)}`,
        ] : []),
      ].join('|')
    : `question:${normalizedProjectDecisionText(question.question)}|context:${normalizedProjectDecisionText(question.context)}`;
  const normalized = [
    question.category || 'clarification',
    question.reasonCode || '',
    semanticBasis,
    ...question.options.map((option) => [
      option.id,
      normalizedProjectDecisionText(option.label),
      ...(destructiveAuthorization ? [normalizedProjectDecisionText(option.description)] : []),
      ...(option.confirmationScope || []).map((entry) => `confirmation:${normalizedProjectDecisionText(entry)}`),
    ].join(':')),
    ...(question.confirmationScope || []).map((entry) => `confirmation:${normalizedProjectDecisionText(entry)}`),
  ].join('|');
  return `semantic:${projectDecisionKeyHash(normalized)}`;
}

export function projectPlanningConfirmationDigest(scope: readonly string[]): string {
  const normalized = [...new Set(scope.map(normalizedProjectDecisionText).filter(Boolean))].sort().join('|');
  return `planning:${projectDecisionKeyHash(normalized)}`;
}

export function normalizeProjectReusableUserDecision(value: unknown): ProjectReusableUserDecision | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<ProjectReusableUserDecision>;
  const category = raw.category === 'manual-intervention' ? 'manual-intervention' : raw.category === 'clarification' ? 'clarification' : undefined;
  const destructiveScope = raw.reasonCode === 'destructive-action'
    ? projectManagerReusableDestructiveScope(raw.decisionScope)
    : undefined;
  if (!category
    || (category === 'manual-intervention'
      && !['physical-action', 'access-grant', 'business-choice'].includes(raw.reasonCode || '')
      && !(raw.reasonCode === 'destructive-action'
        && destructiveScope
        && raw.projectId === destructiveScope.project
        && raw.workItemId === destructiveScope.workItem))
    || typeof raw.id !== 'string' || !raw.id.trim()
    || typeof raw.decisionKey !== 'string' || !/^(?:explicit:[\p{L}\p{N}][\p{L}\p{N}._:/-]{0,119}|derived:[0-9a-f]{16})$/u.test(raw.decisionKey)
    || typeof raw.semanticFingerprint !== 'string' || !/^semantic:[0-9a-f]{16}$/u.test(raw.semanticFingerprint)
    || typeof raw.question !== 'string' || !raw.question.trim()
    || typeof raw.answer !== 'string' || !raw.answer.trim()
    || (raw.decisionScope !== undefined && (typeof raw.decisionScope !== 'string' || !raw.decisionScope.trim()))
    || (raw.optionId !== undefined && typeof raw.optionId !== 'string')
    || !Number.isInteger(raw.requirementsVersion) || Number(raw.requirementsVersion) < 1
    || !Number.isInteger(raw.authorizationVersion) || Number(raw.authorizationVersion) < 1
    || !['desktop', 'feishu'].includes(String(raw.answeredBy))
    || !Number.isFinite(raw.createdAt)) return undefined;
  return {
    id: raw.id.trim().slice(0, 200),
    decisionKey: raw.decisionKey,
    semanticFingerprint: raw.semanticFingerprint,
    ...(raw.decisionScope?.trim() ? { decisionScope: raw.decisionScope.trim().slice(0, 1000) } : {}),
    ...(destructiveScope ? { projectId: destructiveScope.project, workItemId: destructiveScope.workItem } : {}),
    category,
    ...(raw.reasonCode ? { reasonCode: raw.reasonCode } : {}),
    question: raw.question.trim().slice(0, 2000),
    answer: raw.answer.trim().slice(0, 4000),
    ...(raw.optionId?.trim() ? { optionId: raw.optionId.trim().slice(0, 80) } : {}),
    requirementsVersion: Number(raw.requirementsVersion),
    authorizationVersion: Number(raw.authorizationVersion),
    answeredBy: raw.answeredBy as 'desktop' | 'feishu',
    createdAt: Number(raw.createdAt),
  };
}

export interface ProjectExecutionBudget {
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

export const DEFAULT_PROJECT_EXECUTION_BUDGET: ProjectExecutionBudget = {
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
  /** Explicit canonical stage-acceptance links; never inferred from similar wording. */
  stageAcceptanceCoverage?: ProjectStageAcceptanceCoverage[];
  budget: ProjectExecutionBudget;
}

export interface ProjectStageAcceptanceCoverage {
  stageCriterion: string;
  verificationCriterion: string;
}

export function projectManagerQuestionConfirmationScope(
  question: Pick<ProjectManagerUserQuestion, 'options' | 'confirmationScope'>,
  optionId?: string,
): string[] {
  const selected = optionId
    ? question.options.find((option) => option.id === optionId)
    : undefined;
  if (selected?.confirmationScope !== undefined) return [...selected.confirmationScope];
  return [...(question.confirmationScope || [])];
}

export type ProjectTaskBatchCoverage = 'whole-item' | 'bounded-batch';

/** One neutral, result-oriented batch selected by the dedicated supervisor. */
export interface ProjectTaskBatch {
  kind: 'task' | 'diagnostic' | 'rework';
  coverage: ProjectTaskBatchCoverage;
  outcome: string;
  completionDefinition: string[];
  evidenceExpectations: string[];
  unmetCompletionItems: string[];
  knownFacts: string[];
  constraints: string[];
  nonGoals: string[];
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
  /** Content-addressed project artifacts verified by the control plane for a read-only evidence review. */
  evidenceProgressSignature?: string;
  /** Only task-failure consumes the work item's task retry budget. */
  retryKind?: ProjectRetryKind;
  escalationBoundary?: ProjectEscalationBoundary;
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
  /** User involvement at final closure. Missing legacy values default to on-gap. */
  userAcceptancePolicy?: ProjectUserAcceptancePolicy;
  /** Per-doneWhen verification requirements. Missing criteria default to required. */
  verificationPolicies?: ProjectCriterionVerificationPolicy[];
  status: ProjectGoalStatus;
  requirementsVersion: number;
  supersedesGoalId?: string;
  changeReason?: string;
  createdAt: number;
  activatedAt?: number;
  closedAt?: number;
}

export function normalizeProjectUserAcceptancePolicy(value: unknown): ProjectUserAcceptancePolicy {
  return PROJECT_USER_ACCEPTANCE_POLICIES.includes(value as ProjectUserAcceptancePolicy)
    ? value as ProjectUserAcceptancePolicy
    : 'on-gap';
}

export function projectCriterionVerificationCannotBeRelaxed(value: string): boolean {
  return /(?:安全|人身|急停|联锁|生产|线上|发布|部署|客户环境|客户数据|权限|认证|授权|凭据|密钥|加密|隐私|合规|泄漏|数据完整|备份|恢复|不可逆|破坏|\b(?:safety|security|human\s+(?:safety|injury)|emergency\s*stop|interlock|production|release|deploy(?:ment)?|live\s+environment|customer\s+environment|customer\s+data|online|permission|privilege|admin(?:istrator)?|authentication|authorization|credential|secret|access\s+control|encryption|privacy|compliance|leak(?:age)?|integrity|data\s+integrity|backup|restore|recovery|irreversible|destructive)\b)/iu.test(value);
}

export function normalizeProjectVerificationPolicies(
  doneWhen: readonly string[],
  value: unknown,
): ProjectCriterionVerificationPolicy[] {
  const entries = Array.isArray(value) ? value : [];
  const byCriterion = new Map<string, ProjectCriterionVerificationPolicy>();
  for (const entry of entries.slice(0, 100)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    const criterion = String(candidate.criterion || '').trim().slice(0, 4000);
    const requirement = String(candidate.requirement || '') as ProjectVerificationRequirement;
    const riskClass = PROJECT_VERIFICATION_RISK_CLASSES.includes(candidate.riskClass as ProjectVerificationRiskClass)
      ? candidate.riskClass as ProjectVerificationRiskClass
      : 'protected';
    const reason = String(candidate.reason || '').trim().slice(0, 4000);
    if (!criterion || !PROJECT_VERIFICATION_REQUIREMENTS.includes(requirement)) continue;
    byCriterion.set(projectCriterionIdentity(criterion), {
      criterion,
      requirement,
      riskClass,
      ...(reason ? { reason } : {}),
    });
  }
  return doneWhen.map((rawCriterion) => {
    const criterion = rawCriterion.trim();
    const configured = byCriterion.get(projectCriterionIdentity(criterion));
    const riskClass = projectCriterionVerificationCannotBeRelaxed(criterion)
      ? 'protected'
      : configured?.riskClass || 'protected';
    const requirement = riskClass === 'protected'
      ? 'required'
      : configured?.requirement || 'required';
    return {
      criterion,
      requirement,
      riskClass,
      ...(configured?.reason ? { reason: configured.reason } : {}),
    };
  }).filter((entry) => !!entry.criterion);
}

export function projectGoalUserAcceptancePolicy(
  goal: Pick<ProjectGoalRevision, 'userAcceptancePolicy'>,
): ProjectUserAcceptancePolicy {
  return normalizeProjectUserAcceptancePolicy(goal.userAcceptancePolicy);
}

export function projectGoalVerificationPolicies(
  goal: Pick<ProjectGoalRevision, 'doneWhen' | 'verificationPolicies'>,
): ProjectCriterionVerificationPolicy[] {
  return normalizeProjectVerificationPolicies(goal.doneWhen, goal.verificationPolicies);
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

export interface ProjectVerificationLimitation {
  kind: 'gui-automation-unavailable';
  detail: string;
  missingEvidence: string[];
  affectedAcceptance: string[];
  requirementsVersion: number;
  authorizationVersion: number;
  detectedAt: number;
}

export function normalizeProjectVerificationLimitation(
  value: ProjectVerificationLimitation | undefined,
): ProjectVerificationLimitation | undefined {
  if (!value || value.kind !== 'gui-automation-unavailable') return undefined;
  const detail = String(value.detail || '').trim().slice(0, 12_000);
  const strings = (input: unknown): string[] => (Array.isArray(input) ? input : [])
    .map((item) => String(item || '').trim().slice(0, 4000))
    .filter(Boolean);
  const missingEvidence = strings(value.missingEvidence).slice(0, 30);
  const affectedAcceptance = strings(value.affectedAcceptance).slice(0, 30);
  if (!detail || missingEvidence.length === 0
    || !Number.isFinite(value.requirementsVersion) || value.requirementsVersion < 1
    || !Number.isFinite(value.authorizationVersion) || value.authorizationVersion < 1
    || !Number.isFinite(value.detectedAt)) return undefined;
  return {
    kind: value.kind,
    detail,
    missingEvidence,
    affectedAcceptance,
    requirementsVersion: Math.trunc(value.requirementsVersion),
    authorizationVersion: Math.trunc(value.authorizationVersion),
    detectedAt: value.detectedAt,
  };
}

export interface ProjectVerificationDecision {
  action: 'alternative-validation' | 'defer-verification' | 'skip-verification';
  questionId: string;
  reason: string;
  answeredBy: 'desktop' | 'feishu';
  requirementsVersion: number;
  authorizationVersion: number;
  decidedAt: number;
}

export type ProjectWorkItemIntervention =
  | 'skip'
  | 'close'
  | 'defer-verification'
  | 'skip-verification';

export function projectWorkItemCurrentVerificationLimitation(
  session: ProjectManagerSession,
  item: ProjectWorkItem | undefined,
): ProjectVerificationLimitation | undefined {
  const limitation = item?.verificationLimitation;
  return limitation
    && limitation.requirementsVersion === projectRequirementsVersion(session)
    && limitation.authorizationVersion === projectAuthorizationVersion(session)
    ? limitation
    : undefined;
}

export function normalizeProjectVerificationDecision(
  value: ProjectVerificationDecision | undefined,
): ProjectVerificationDecision | undefined {
  if (!value || !['alternative-validation', 'defer-verification', 'skip-verification'].includes(String(value.action))) return undefined;
  const questionId = String(value.questionId || '').trim().slice(0, 200);
  const reason = String(value.reason || '').trim().slice(0, 12_000);
  if (!questionId || !reason || !['desktop', 'feishu'].includes(String(value.answeredBy))
    || !Number.isFinite(value.requirementsVersion) || value.requirementsVersion < 1
    || !Number.isFinite(value.authorizationVersion) || value.authorizationVersion < 1
    || !Number.isFinite(value.decidedAt)) return undefined;
  return {
    action: value.action,
    questionId,
    reason,
    answeredBy: value.answeredBy,
    requirementsVersion: Math.trunc(value.requirementsVersion),
    authorizationVersion: Math.trunc(value.authorizationVersion),
    decidedAt: value.decidedAt,
  };
}

export function projectFinalAcceptanceScope(session: ProjectManagerSession): string {
  const goal = activeProjectGoal(session);
  const verificationPolicies = projectGoalVerificationPolicies(goal);
  return [
    `goalId=${goal.id}`,
    `requirementsVersion=${projectRequirementsVersion(session)}`,
    `authorizationVersion=${projectAuthorizationVersion(session)}`,
    `doneWhenDigest=${projectPlanningConfirmationDigest(goal.doneWhen)}`,
    `userAcceptancePolicy=${projectGoalUserAcceptancePolicy(goal)}`,
    `verificationPolicyDigest=${projectPlanningConfirmationDigest(verificationPolicies.map((policy) => (
      `${policy.criterion}:${policy.requirement}:${policy.riskClass || 'protected'}:${policy.reason || ''}`
    )))}`,
  ].join('; ');
}

export function projectFinalAcceptanceEligibilityError(session: ProjectManagerSession): string | null {
  const goal = activeProjectGoal(session);
  const requirementsVersion = projectRequirementsVersion(session);
  const authorizationVersion = projectAuthorizationVersion(session);
  const items = session.workItems.filter((item) => (
    item.goalId === goal.id
    && item.requirementsVersion === requirementsVersion
    && item.authorizationVersion === authorizationVersion
  ));
  if (!items.some((item) => item.status === 'completed' && !!normalizeProjectCompletionResult(item.completion))) {
    return '当前主目标还没有任何已完成成果，不能用最终效果接受代替项目执行';
  }
  const failedItem = items.find((item) => item.status === 'failed');
  if (failedItem) {
    return `工作项存在真实失败状态，不能作为验证缺口跳过：${failedItem.title}`;
  }
  const isVerificationGap = (item: ProjectWorkItem): boolean => {
    const decision = item.verificationDecision;
    const settledStatus = ['waiting-decision', 'paused', 'stopped'].includes(item.status);
    return settledStatus
      && !!decision
      && ['defer-verification', 'skip-verification'].includes(decision.action)
      && decision.requirementsVersion === requirementsVersion
      && decision.authorizationVersion === authorizationVersion;
  };
  const gaps = items.filter(isVerificationGap);
  if (gaps.length === 0) return '当前主目标没有可由用户最终接受收口的验证能力缺口';
  const unfinishedImplementation = items.find((item) => (
    item.status !== 'completed' && !isVerificationGap(item)
  ));
  if (unfinishedImplementation) {
    return `工作项仍未形成成果，不能作为验证缺口跳过：${unfinishedImplementation.title}`;
  }
  const knownFailure = items.flatMap((item) => (
    normalizeProjectCompletionResult(item.completion)?.criteria || []
  )).find((criterion) => criterion.status === 'unsatisfied' || criterion.result === 'failed');
  if (knownFailure) {
    return `存在已知失败结论，必须先处理或由用户修改目标，不能直接接受为完成：${knownFailure.criterion}`;
  }
  const safetyCriticalCriterion = goal.doneWhen.find(projectCriterionVerificationCannotBeRelaxed);
  if (safetyCriticalCriterion) {
    return `安全、权限、生产或数据完整性验收不能用最终效果接受代替：${safetyCriticalCriterion}`;
  }
  const uncoveredSubgoal = activeProjectSubgoals(session).find((subgoal) => (
    !['achieved', 'obsolete'].includes(subgoal.status)
    && !gaps.some((item) => item.subgoalId === subgoal.id)
  ));
  return uncoveredSubgoal
    ? `阶段尚未完成且不是验证能力缺口：${uncoveredSubgoal.title}`
    : null;
}

export interface ProjectWorkItem {
  id: string;
  /** Immutable main-goal ownership. */
  goalId: string;
  /** Coarse project-AI stage that owns this executable task. */
  subgoalId: string;
  /** Requirements and inherited-authorization versions accepted for this task contract. */
  requirementsVersion: number;
  authorizationVersion: number;
  /** Current managed-project contract semantics version. */
  executionProtocolVersion: number;
  /** Distinguishes task-local stop conditions from legacy stage-acceptance inheritance. */
  stopWhenScopeVersion?: number;
  /** Project-AI decision made before dispatch so one task AI receives one focused outcome. */
  complexityAssessment: ProjectTaskComplexityAssessment;
  /** Project AI selects the initial mode; the bound supervisor may revise it for later task turns. */
  taskWorkMode: ProjectTaskWorkMode;
  /** Durable in-place context reset state. Project files and terminal identity are never replaced. */
  contextReset?: ProjectTaskContextResetState;
  title: string;
  contract: ProjectSupervisorContract;
  status: ProjectWorkItemStatus;
  dependencies: string[];
  supervisorLaneId?: string;
  workerSurfaceId?: string;
  /** Monotonic assignment generation shared with the dedicated supervisor lane. */
  assignmentVersion?: number;
  attempts: number;
  /** Monotonic audit total of supervisor decisions. */
  totalDecisionsUsed?: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  completion?: ProjectCompletionResult;
  /** Control-plane fact explaining why current acceptance cannot be automated. */
  verificationLimitation?: ProjectVerificationLimitation;
  /** Explicit user disposition for a verification route that cannot currently be automated. */
  verificationDecision?: ProjectVerificationDecision;
  executionHistory: ProjectExecutionRecord[];
  latestEvidence?: string;
  latestContextSummary?: string;
  latestBlocker?: string;
}

export function projectWorkItemDisplayTitle(
  item: Pick<ProjectWorkItem, 'id' | 'title' | 'contract'>,
): string {
  const title = item.title.trim();
  const objective = item.contract.objective.trim();
  const source = (!title || title === item.id ? objective : title) || item.id;
  const firstOutcomeClause = source.split(/[\r\n：:；;。，,]/u)[0]?.trim() || source;
  const characters = Array.from(firstOutcomeClause);
  return characters.length > 24
    ? `${characters.slice(0, 24).join('')}…`
    : firstOutcomeClause;
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

export function normalizeProjectStageAcceptanceCoverage(
  value: unknown,
): ProjectStageAcceptanceCoverage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const candidate = entry as Record<string, unknown>;
    const stageCriterion = String(candidate.stageCriterion || '').trim().slice(0, 4000);
    const verificationCriterion = String(candidate.verificationCriterion || '').trim().slice(0, 4000);
    return stageCriterion && verificationCriterion
      ? [{ stageCriterion, verificationCriterion }]
      : [];
  });
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

/** Validate goal criteria while preserving explicit best-effort and not-applicable outcomes. */
export function projectGoalCompletionCriteriaError(
  goal: Pick<ProjectGoalRevision, 'doneWhen' | 'verificationPolicies'>,
  completion: ProjectCompletionResult | undefined,
  label = '主目标完成条件',
  options: { allowExtra?: boolean; requireArtifacts?: boolean } = {},
): string | null {
  const policies = projectGoalVerificationPolicies(goal);
  const checks = normalizeProjectCompletionResult(completion)?.criteria || [];
  const expectedIdentities = new Set(policies.map((policy) => projectCriterionIdentity(policy.criterion)));
  const seen = new Set<string>();
  for (const check of checks) {
    const identity = projectCriterionIdentity(check.criterion);
    if (seen.has(identity)) return `${label}存在重复核验项：${check.criterion}`;
    seen.add(identity);
    if (!options.allowExtra && !expectedIdentities.has(identity)) {
      return `${label}包含不属于当前合同的核验项：${check.criterion}`;
    }
  }
  for (const policy of policies) {
    if (policy.requirement === 'required') {
      const error = projectCompletionCriteriaError([policy.criterion], completion, label, {
        allowExtra: true,
        requireArtifacts: options.requireArtifacts,
      });
      if (error) return error;
      continue;
    }
    const identity = projectCriterionIdentity(policy.criterion);
    const check = checks.find((candidate) => projectCriterionIdentity(candidate.criterion) === identity);
    if (!check) return `${label}尚未记录${policy.requirement === 'best-effort' ? '尽力验证结果' : '不适用验证结论'}：${policy.criterion}`;
    if (check.status === 'unsatisfied' || check.result === 'failed') {
      return `${label}存在已知失败，不能用${policy.requirement === 'best-effort' ? '尽力验证' : '不适用验证'}覆盖：${policy.criterion}`;
    }
    if (policy.requirement === 'not-applicable'
      && check.result === 'not-run'
      && check.method !== 'evidence-review') {
      return `${label}的不适用验证结论必须通过 evidence-review 记录依据：${policy.criterion}`;
    }
    if (!check.evidence.trim() || check.evidenceRefs.length === 0) {
      return `${label}缺少实际交付或验证记录：${policy.criterion}`;
    }
    if (options.requireArtifacts && check.evidenceRefs.some((ref) => (
      !check.evidenceArtifacts?.some((artifact) => artifact.ref === ref)
    ))) {
      return `${label}的实际证据尚未由控制层读取并记录内容哈希：${policy.criterion}`;
    }
  }
  return null;
}

/** Read only the structured completion result produced by the current protocol. */
export function projectWorkItemCompletionResult(item: ProjectWorkItem): ProjectCompletionResult | undefined {
  const completion = normalizeProjectCompletionResult(item.completion);
  if (!completion) return undefined;
  const coverage = normalizeProjectStageAcceptanceCoverage(item.contract.stageAcceptanceCoverage);
  if (coverage.length === 0 || !completion.criteria?.length) return completion;
  const criteria = new Map(completion.criteria.map((criterion) => (
    [projectCriterionIdentity(criterion.criterion), criterion]
  )));
  for (const mapping of coverage) {
    const source = criteria.get(projectCriterionIdentity(mapping.verificationCriterion));
    if (!source) continue;
    const stageIdentity = projectCriterionIdentity(mapping.stageCriterion);
    const existing = criteria.get(stageIdentity);
    criteria.set(stageIdentity, existing || {
      ...source,
      criterion: mapping.stageCriterion,
    });
  }
  return { ...completion, criteria: [...criteria.values()].slice(0, 100) };
}

/** Aggregate a stage result from current-protocol structured work-item completions. */
export function projectSubgoalCompletionResult(
  subgoal: Pick<ProjectSubgoal, 'id' | 'goalId' | 'status' | 'updatedAt' | 'completion'>,
  workItems: readonly ProjectWorkItem[],
  options: { requirementsVersion?: number; authorizationVersion?: number } = {},
): ProjectCompletionResult | undefined {
  const stored = normalizeProjectCompletionResult(subgoal.completion);
  if (stored) return stored;
  if (subgoal.status !== 'achieved') return undefined;
  const completedItems = workItems.filter((item) => (
    item.goalId === subgoal.goalId
    && item.subgoalId === subgoal.id
    && (options.requirementsVersion === undefined || item.requirementsVersion === options.requirementsVersion)
    && (options.authorizationVersion === undefined || item.authorizationVersion === options.authorizationVersion)
    && !!item.completion
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

export type ProjectStopKind =
  | 'user-request'
  | 'planned-close'
  | 'safety-stop'
  | 'recovery-exhausted';

/**
 * A project event needs user attention when it is an explicit terminal
 * blocker, or when the producer marks a non-failure event as non-recoverable.
 */
export function projectManagerEventNeedsUserAttention(
  event: Pick<ProjectManagerEvent, 'kind' | 'summary' | 'payload'> | {
    kind: string;
    summary?: string;
    payload?: Record<string, unknown>;
  },
): boolean {
  // Current-protocol records created before runtime-pause alerts were enabled
  // may explicitly suppress this exact terminal failure. Keep other runtime
  // pauses suppressed when a dedicated *-failed event owns their notification.
  if (event.kind === 'project-paused'
    && event.payload?.source === 'runtime'
    && event.summary?.startsWith('内部恢复连续失败')) return true;
  if (event.payload?.attentionRequired === false) return false;
  return event.payload?.attentionRequired === true || event.kind.endsWith('-failed');
}

export function projectManagerEventResolvesAllAttention(
  event: Pick<ProjectManagerEvent, 'kind'> | { kind: string },
): boolean {
  return event.kind === 'project-completed' || event.kind === 'project-stopped';
}

/** Keep every user-attention outlet on the same recovery semantics. */
export function projectManagerResolvedAttentionKinds(
  event: Pick<ProjectManagerEvent, 'kind' | 'payload'> | {
    kind: string;
    payload?: Record<string, unknown>;
  },
): string[] {
  const resolvedKinds = new Set<string>();
  if (event.kind === 'project-resumed') {
    resolvedKinds.add('project-paused');
    resolvedKinds.add('guard-triggered');
    resolvedKinds.add('project-execution-stalled');
    resolvedKinds.add('project-goal-completed');
  } else if (event.kind === 'project-goal-completion-invalidated') {
    resolvedKinds.add('project-goal-completed');
  } else if (event.kind === 'manager-runtime-restarted') {
    resolvedKinds.add('manager-runtime-failed');
    resolvedKinds.add('manager-delivery-failed');
  } else if (event.kind === 'manager-delivery-restored') {
    resolvedKinds.add('manager-delivery-failed');
    resolvedKinds.add('manager-runtime-failed');
  } else if (event.kind === 'project-agent-runtime-switched') {
    resolvedKinds.add('project-agent-limit-detected');
  } else if (event.kind === 'recovery-restored') {
    resolvedKinds.add('manager-runtime-failed');
    resolvedKinds.add('supervisor-runtime-failed');
    resolvedKinds.add('task-runtime-failed');
    resolvedKinds.add('project-safe-exit-failed');
    resolvedKinds.add('project-execution-stalled');
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
  return [...resolvedKinds];
}

/** Returns the newest alert that has not been followed by a recovery event. */
export function activeProjectManagerAttentionEvent<T extends ProjectManagerEventSummary>(
  events: readonly T[],
): T | undefined {
  const resolvedKinds = new Set<string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (projectManagerEventResolvesAllAttention(event)) return undefined;
    projectManagerResolvedAttentionKinds(event).forEach((kind) => resolvedKinds.add(kind));
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

export type ProjectAgentRole = 'manager' | 'supervisor' | 'task' | 'auxiliary';

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
  role: 'project-ai' | 'supervisor-ai' | 'task-ai' | 'auxiliary-task-ai';
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
  /** Evidence/topology identity used to prevent repeated replans without material progress. */
  replanBaselineFingerprint?: string;
  createdAt: number;
  notifiedAt: number;
  notificationCount: number;
}

export type ProjectExecutionResponsibilityOwner =
  | 'project-ai'
  | 'supervisor-ai'
  | 'task-ai'
  | 'control-plane'
  | 'user';

export type ProjectExecutionResponsibilityState =
  | 'queued'
  | 'delivered'
  | 'working'
  | 'awaiting-result'
  | 'blocked';

/** Durable single-owner lease for the next meaningful transition of an active project. */
export interface ProjectExecutionResponsibility {
  id: string;
  owner: ProjectExecutionResponsibilityOwner;
  action: string;
  state: ProjectExecutionResponsibilityState;
  workItemId?: string;
  transitionId?: string;
  assignedAt: number;
  lastProgressAt: number;
  deadlineAt?: number;
  attempt: number;
  incidentKey: string;
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
  /** Mirrors the active goal for older/session-level consumers. */
  userAcceptancePolicy?: ProjectUserAcceptancePolicy;
  /** Mirrors the active goal for older/session-level consumers. */
  verificationPolicies?: ProjectCriterionVerificationPolicy[];
  /** Monotonic version of user-owned goals, prerequisites, plans, and completion criteria. */
  requirementsVersion?: number;
  /** Changes only when inherited project scope, prerequisites, or grants change. */
  authorizationVersion?: number;
  /** Latest requirements version explicitly accepted by the project manager through resume. */
  acceptedRequirementsVersion?: number;
  /** Persisted execution semantics version, independent from user requirement revisions. */
  executionProtocolVersion: number;
  status: ProjectManagerSessionStatus;
  /** Cleared only after the first task packet following project creation or resume is delivered. */
  repositoryBootstrapPending?: boolean;
  /** True only when the project was paused by the portfolio-level control. */
  pausedByPortfolio?: boolean;
  /** The one task terminal reserved for this project, including before supervision starts. */
  taskTerminalSurfaceId?: string;
  /** Optional second task Agent, invisible to the main task AI and limited to auxiliary work. */
  auxiliaryTaskTerminalSurfaceId?: string;
  auxiliaryTask?: {
    id: string;
    requesterRole: 'project-ai' | 'supervisor-ai';
    requesterSurfaceId: string;
    requesterLaneId?: string;
    kind: 'research' | 'documentation' | 'progress' | 'git-commit';
    task: string;
    allowedPaths: string[];
    status: 'running' | 'completed' | 'failed';
    startedAt: number;
    completedAt?: number;
    summary?: string;
  };
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
  /** User-authorized answers reusable only within the recorded requirement and authorization versions. */
  reusableUserDecisions?: ProjectReusableUserDecision[];
  /** Project-specific runtime selection. */
  agentConfig?: ProjectManagementAgentConfig;
  /** Provider quota/rate-limit issue waiting for a user-selected runtime replacement. */
  agentIssue?: ProjectAgentRuntimeIssue;
  /** Durable safe-switch progress so working Agents can rotate at their next Stop. */
  agentReconfiguration?: ProjectAgentReconfiguration;
  /** Manager-bound messages retained until the manager Agent acknowledges prompt submission. */
  pendingManagerDeliveries?: ProjectManagerPendingDelivery[];
  /** Actionable supervisor handoffs remain here until the project AI records a resolution. */
  pendingSupervisorTransitions?: ProjectSupervisorTransition[];
  /** Exactly one durable owner for the next meaningful project transition. */
  executionResponsibility?: ProjectExecutionResponsibility;
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
    userAcceptancePolicy: normalizeProjectUserAcceptancePolicy(session.userAcceptancePolicy),
    verificationPolicies: normalizeProjectVerificationPolicies(
      session.doneWhen,
      session.verificationPolicies,
    ),
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
    confirmationScope?: readonly string[];
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
  const requiredScope = [...new Set((options.confirmationScope || []).map((entry) => entry.trim()).filter(Boolean))];
  if (requiredScope.length > 0) {
    if (confirmation.kind !== 'user-clarification-answered') {
      return '改变用户规划必须引用包含 confirmationScope 的结构化用户答复';
    }
    const confirmedScope = Array.isArray(confirmation.payload?.confirmationScope)
      ? confirmation.payload.confirmationScope.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    const digest = projectPlanningConfirmationDigest(confirmedScope);
    if (confirmedScope.length === 0 || confirmation.payload?.confirmationDigest !== digest) {
      return '用户答复没有绑定可验证的规划变更范围；请通过 project ask 重新展示 confirmationScope';
    }
    const normalizedConfirmed = new Set(confirmedScope.map(normalizedProjectDecisionText));
    const missing = requiredScope.find((entry) => (
      !normalizedConfirmed.has(normalizedProjectDecisionText(entry))
    ));
    if (missing) return `用户确认未覆盖当前规划变更：${missing}`;
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

/** Normalize the current governance state. Older protocols are rejected before this boundary. */
function normalizeProjectGovernanceSessionState(session: ProjectManagerSession): ProjectManagerSession {
  return {
    ...session,
    workItems: session.workItems.map((item) => ({
      ...item,
      contract: {
        ...item.contract,
        ...(normalizeProjectStageAcceptanceCoverage(item.contract.stageAcceptanceCoverage).length > 0
          ? { stageAcceptanceCoverage: normalizeProjectStageAcceptanceCoverage(item.contract.stageAcceptanceCoverage) }
          : { stageAcceptanceCoverage: undefined }),
        scope: {
          root: item.contract.scope.root,
          allowPaths: [],
          denyPaths: [],
          forbiddenActions: [],
        },
        authority: {
          technicalChoices: item.contract.authority.technicalChoices !== false,
          lowRiskRetries: item.contract.authority.lowRiskRetries !== false,
          routeAdjustments: item.contract.authority.routeAdjustments !== false,
          targetedTests: item.contract.authority.targetedTests !== false,
          internalThreads: item.contract.authority.internalThreads !== false,
          continuousExecution: item.contract.authority.continuousExecution !== false,
          permissionConfirm: item.contract.authority.permissionConfirm !== false,
          allowedCommandPrefixes: Array.isArray(item.contract.authority.allowedCommandPrefixes)
            ? item.contract.authority.allowedCommandPrefixes.map((entry) => String(entry).trim().slice(0, 240)).filter(Boolean)
            : [],
          authorizedDevices: [],
          authorizedEnvironments: [],
          authorizedOperations: [],
        },
      },
    })),
  };
}

/** Normalize only the current single-task-runtime model; older sessions are rejected during recovery. */
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
        userAcceptancePolicy: normalizeProjectUserAcceptancePolicy(goal.userAcceptancePolicy),
        verificationPolicies: normalizeProjectVerificationPolicies(
          goal.doneWhen,
          goal.verificationPolicies,
        ),
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
  const subgoals = rawSubgoals;
  return normalizeProjectGovernanceSessionState({
    ...session,
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
    userAcceptancePolicy: normalizeProjectUserAcceptancePolicy(activeGoal.userAcceptancePolicy),
    verificationPolicies: normalizeProjectVerificationPolicies(
      activeGoal.doneWhen,
      activeGoal.verificationPolicies,
    ),
    requirementsVersion,
    authorizationVersion,
    acceptedRequirementsVersion: projectAcceptedRequirementsVersion(session),
    executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
    repositoryBootstrapPending: session.repositoryBootstrapPending === true,
    progressSnapshot: normalizeProjectProgressSnapshot(session.progressSnapshot),
    progressSync: normalizeProjectProgressSyncState(session.progressSync),
    orientation: normalizeProjectOrientationState(session.orientation),
    safeExit: normalizeProjectSafeExitState(session.safeExit),
    executionResponsibility: session.executionResponsibility
      && typeof session.executionResponsibility.id === 'string'
      && !!session.executionResponsibility.id.trim()
      && typeof session.executionResponsibility.action === 'string'
      && !!session.executionResponsibility.action.trim()
      && typeof session.executionResponsibility.incidentKey === 'string'
      && !!session.executionResponsibility.incidentKey.trim()
      && ['project-ai', 'supervisor-ai', 'task-ai', 'control-plane', 'user']
        .includes(String(session.executionResponsibility.owner))
      && ['queued', 'delivered', 'working', 'awaiting-result', 'blocked']
        .includes(String(session.executionResponsibility.state))
      && Number.isFinite(session.executionResponsibility.assignedAt)
      && Number.isFinite(session.executionResponsibility.lastProgressAt)
      && Number.isFinite(session.executionResponsibility.attempt)
      ? {
          ...session.executionResponsibility,
          id: session.executionResponsibility.id.trim().slice(0, 500),
          action: String(session.executionResponsibility.action || '').trim().slice(0, 200),
          incidentKey: String(session.executionResponsibility.incidentKey || '').trim().slice(0, 500),
          ...(typeof session.executionResponsibility.workItemId === 'string'
            && session.executionResponsibility.workItemId.trim()
            ? { workItemId: session.executionResponsibility.workItemId.trim().slice(0, 200) }
            : {}),
          ...(typeof session.executionResponsibility.transitionId === 'string'
            && session.executionResponsibility.transitionId.trim()
            ? { transitionId: session.executionResponsibility.transitionId.trim().slice(0, 200) }
            : {}),
          ...(Number.isFinite(session.executionResponsibility.deadlineAt)
            ? { deadlineAt: session.executionResponsibility.deadlineAt }
            : {}),
          attempt: Math.max(0, Math.trunc(session.executionResponsibility.attempt)),
        }
      : undefined,
    reusableUserDecisions: (Array.isArray(session.reusableUserDecisions) ? session.reusableUserDecisions : [])
      .map(normalizeProjectReusableUserDecision)
      .filter((decision): decision is ProjectReusableUserDecision => !!decision)
      .slice(-50),
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
        && (transition.replanBaselineFingerprint === undefined
          || typeof transition.replanBaselineFingerprint === 'string')
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
        ...(transition.replanBaselineFingerprint?.trim()
          ? { replanBaselineFingerprint: transition.replanBaselineFingerprint.trim().slice(0, 200) }
          : {}),
        notificationCount: Math.max(1, Math.trunc(transition.notificationCount)),
      }))),
    workItems: session.workItems.map((item) => {
      const itemRequirementsVersion = Math.max(1, Math.trunc(item.requirementsVersion || requirementsVersion));
      const verificationLimitation = normalizeProjectVerificationLimitation(item.verificationLimitation);
      const verificationDecision = normalizeProjectVerificationDecision(item.verificationDecision);
      return {
        ...item,
        verificationLimitation,
        verificationDecision,
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
        subgoalId: item.subgoalId || '',
        requirementsVersion: itemRequirementsVersion,
        authorizationVersion: Math.max(1, Math.trunc(item.authorizationVersion || authorizationVersion)),
        executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
        complexityAssessment: normalizeProjectTaskComplexityAssessment(item.complexityAssessment, item.updatedAt)!,
        taskWorkMode: item.taskWorkMode === 'multi-thread' ? 'multi-thread' : 'single-thread',
        contextReset: normalizeProjectTaskContextResetState(item.contextReset),
        totalDecisionsUsed: Math.max(0, Math.trunc(item.totalDecisionsUsed || 0)),
        completion: normalizeProjectCompletionResult(item.completion),
      };
    }),
  });
}

export type ProjectManagerAction =
  | { type: 'require-requirements-alignment'; reason: string; userConfirmationEventId?: string }
  | {
    type: 'confirm-requirements-alignment';
    goalUnderstanding: string;
    scopeSummary: string;
    acceptanceSummary: string;
    reason: string;
    userConfirmationEventId?: string;
  }
  | {
    type: 'update-project-definition';
    goal: string;
    preconditions: string[];
    supervisorNotes?: string[];
    planFiles: ProjectPlanFileSnapshot[];
    doneWhen: string[];
    userAcceptancePolicy?: ProjectUserAcceptancePolicy;
    verificationPolicies?: ProjectCriterionVerificationPolicy[];
    reason?: string;
    userConfirmationEventId?: string;
    source: 'user' | 'manager';
    mode: 'refine' | 'pivot';
  }
  | {
    type: 'set-project-subgoals';
    subgoals: ProjectSubgoal[];
    reason?: string;
    source: 'user' | 'manager';
    userConfirmationEventId?: string;
  }
  | { type: 'update-project-preconditions'; preconditions: string[]; reason?: string }
  | { type: 'request-user-clarification'; question: ProjectManagerUserQuestion }
  | {
      type: 'refine-user-clarification';
      questionId: string;
      question: ProjectManagerUserQuestion;
      selectedOptionId: string;
    }
  | {
      type: 'answer-user-clarification';
      questionId: string;
      answer: string;
      optionId?: string;
      answeredBy: 'desktop' | 'feishu';
      reuseForSimilar?: boolean;
    }
  | { type: 'create-work-item'; workItem: ProjectWorkItem }
  | { type: 'update-work-item'; workItemId: string; patch: Partial<ProjectWorkItem> }
  | {
    type: 'intervene-work-item';
    workItemId: string;
    intervention: ProjectWorkItemIntervention;
    reason?: string;
    answeredBy?: 'desktop' | 'feishu';
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
  | {
      type: 'complete-current-goal';
      evidence: string;
      completion?: ProjectCompletionResult;
      userAcceptanceEventId?: string;
    }
  | { type: 'stop-project'; reason: string; emergency?: boolean; stopKind?: ProjectStopKind }
  | { type: 'reply'; correlationId?: string; message: string };

export function projectWorkItemReady(
  item: ProjectWorkItem,
  items: readonly ProjectWorkItem[],
): boolean {
  if (item.status !== 'planned' && item.status !== 'waiting-dependencies') return false;
  const byId = new Map(items.map((candidate) => [candidate.id, candidate]));
  return item.dependencies.every((dependency) => byId.get(dependency)?.status === 'completed');
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
