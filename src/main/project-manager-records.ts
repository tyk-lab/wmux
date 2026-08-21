import fs from 'fs';
import path from 'path';
import { getAppDataDir } from '../shared/instance';
import {
  MAX_PROJECT_ACTIVE_WORKERS,
  normalizeProjectManagerSession,
  projectDirectoryIdentity,
  normalizeProjectOrientationState,
  normalizeProjectProgressSnapshot,
  normalizeProjectProgressSyncState,
  normalizeProjectWorkerAssignments,
  projectWorkerAssignmentsViolation,
  type ProjectManagerSession,
} from '../shared/project-manager';
import {
  MAX_TASK_CHILD_THREADS,
  MAX_TASK_OPERATION_BOUNDARIES,
} from '../shared/supervisor-work-mode';

export interface ProjectManagerRecord {
  sessionId: string;
  projectDir: string;
  type: string;
  payload?: Record<string, unknown>;
  ts?: number;
}

const SESSION_ID = /^pm-[A-Za-z0-9_-]+$/;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
// Three 1 MB text snapshots can expand under JSON escaping; leave bounded room
// for work items and the 500-entry decision timeline without breaking recovery.
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const SESSION_STATUSES = new Set(['active', 'paused', 'waiting', 'completed', 'stopped']);
const WORK_ITEM_STATUSES = new Set([
  'planned', 'waiting-dependencies', 'running', 'validating', 'waiting-decision',
  'paused', 'completed', 'failed', 'stopped',
]);
const GOAL_STATUSES = new Set(['transitioning', 'active', 'achieved', 'superseded', 'abandoned']);
const SUBGOAL_STATUSES = new Set(['planned', 'active', 'blocked', 'achieved', 'obsolete']);
const CONTINUATION_BOUNDARIES = new Set([
  'project-owned-decision', 'external-prerequisite', 'high-risk-boundary',
]);

function recordsDirectory(appDataDir = getAppDataDir()): string {
  return path.join(appDataDir, 'project-manager');
}

function validateIdentity(sessionId: string, projectDir: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid project manager session id');
  if (!path.isAbsolute(projectDir)) throw new Error('projectDir must be absolute');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isWorkerRuntime(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const worker = value as Record<string, unknown>;
  return typeof worker.workerId === 'string' && worker.workerId.length > 0
    && ['integrator', 'worker', 'hardware-executor'].includes(String(worker.role))
    && typeof worker.outcome === 'string' && worker.outcome.length > 0
    && isStringArray(worker.dependencies) && isStringArray(worker.writeClaims)
    && isStringArray(worker.resourceClaims) && isStringArray(worker.validation)
    && ['planned', 'starting', 'running', 'waiting-resource', 'awaiting-review', 'completed', 'failed',
      'exited', 'recovering', 'frozen', 'superseded'].includes(String(worker.status))
    && Number.isInteger(worker.assignmentVersion) && Number(worker.assignmentVersion) >= 1
    && Number.isInteger(worker.directiveEpoch) && Number(worker.directiveEpoch) >= 0
    && (worker.surfaceId === undefined || typeof worker.surfaceId === 'string')
    && (worker.laneId === undefined || typeof worker.laneId === 'string')
    && (worker.worktreeId === undefined || typeof worker.worktreeId === 'string')
    && (worker.worktreePath === undefined || typeof worker.worktreePath === 'string')
    && (worker.checkpoint === undefined || typeof worker.checkpoint === 'string')
    && (worker.startedAt === undefined || Number.isFinite(worker.startedAt))
    && (worker.accumulatedActiveMs === undefined || (Number.isFinite(worker.accumulatedActiveMs) && Number(worker.accumulatedActiveMs) >= 0))
    && Number.isFinite(worker.updatedAt);
}

function isWorkerGroup(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const group = value as Record<string, any>;
  if (!Number.isInteger(group.executionEpoch)
    || typeof group.integratorWorkerId !== 'string'
    || !Array.isArray(group.workers)
    || group.workers.length < 2
    || group.workers.length > MAX_PROJECT_ACTIVE_WORKERS
    || !group.workers.every(isWorkerRuntime)
    || !isStringArray(group.mergeOrder)
    || group.mergeOrder.length !== group.workers.length
    || new Set(group.mergeOrder).size !== group.mergeOrder.length
    || group.mergeOrder.some((workerId: string) => !group.workers.some((worker: any) => worker.workerId === workerId))
    || !Number.isFinite(group.createdAt)
    || !Number.isFinite(group.updatedAt)) return false;
  const assignments = normalizeProjectWorkerAssignments(group.workers);
  return assignments.length === group.workers.length
    && projectWorkerAssignmentsViolation(assignments) === null
    && assignments.find((assignment) => assignment.role === 'integrator')?.workerId === group.integratorWorkerId;
}

function isUserDirective(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const directive = value as Record<string, unknown>;
  return typeof directive.directiveId === 'string' && typeof directive.workerId === 'string'
    && Number.isInteger(directive.directiveEpoch) && Number.isInteger(directive.assignmentVersion)
    && typeof directive.exactTextAvailable === 'boolean'
    && (directive.exactText === undefined || typeof directive.exactText === 'string')
    && ['pending', 'within-assignment', 'reassignment-required', 'contract-change', 'high-risk']
      .includes(String(directive.classification))
    && ['pending', 'reconciled', 'superseded'].includes(String(directive.reconciliationStatus))
    && Number.isFinite(directive.receivedAt);
}

function isResourceLease(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const lease = value as Record<string, unknown>;
  return ['leaseId', 'resourceId', 'ownerWorkerId', 'operationId'].every((key) => typeof lease[key] === 'string')
    && ['shared-read', 'exclusive-write', 'snapshot-read', 'brokered-read'].includes(String(lease.mode))
    && ['reserved', 'in-use', 'releasing', 'cooldown', 'released', 'quarantined'].includes(String(lease.status))
    && typeof lease.idempotent === 'boolean'
    && Number.isFinite(lease.grantedAt) && Number.isFinite(lease.updatedAt)
    && (lease.evidence === undefined || typeof lease.evidence === 'string');
}

function isMergeCandidate(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['candidateId', 'workerId', 'baselineCommit', 'patchHash'].every((key) => typeof candidate[key] === 'string')
    && Number.isInteger(candidate.assignmentVersion) && Number(candidate.assignmentVersion) >= 1
    && isStringArray(candidate.changedFiles) && isStringArray(candidate.evidence)
    && ['submitted', 'checking', 'accepted', 'applied', 'rejected', 'superseded', 'frozen']
      .includes(String(candidate.status))
    && Number.isFinite(candidate.createdAt) && Number.isFinite(candidate.updatedAt);
}

function isProjectTaskExecutionPlan(value: unknown, internalThreads: boolean): boolean {
  if (!value || typeof value !== 'object') return false;
  const execution = value as Record<string, unknown>;
  const mode = String(execution.taskWorkMode);
  if (
    !['single-thread', 'multi-thread', 'adaptive'].includes(mode)
    || typeof execution.modeReason !== 'string'
    || execution.modeReason.trim().length === 0
    || typeof execution.mainThreadResponsibility !== 'string'
    || execution.mainThreadResponsibility.trim().length === 0
    || !isStringArray(execution.childThreadResponsibilities)
    || execution.childThreadResponsibilities.length > MAX_TASK_CHILD_THREADS
  ) return false;
  if (execution.parallelismSelection !== undefined
    && !['auto', 'single-worker', 'internal-threads', 'worker-group']
      .includes(String(execution.parallelismSelection))) return false;
  if (mode !== 'single-thread' && !internalThreads) return false;
  if (execution.parallelismSelection === 'internal-threads' && !internalThreads) return false;
  if ((execution.parallelismSelection === 'single-worker' || execution.parallelismSelection === 'worker-group')
    && mode !== 'single-thread') return false;
  if (execution.parallelismSelection === 'internal-threads' && mode !== 'multi-thread') return false;
  const maxChildThreads = execution.maxChildThreads;
  if (maxChildThreads !== undefined && (
    typeof maxChildThreads !== 'number'
    || !Number.isInteger(maxChildThreads)
    || maxChildThreads < 1
    || maxChildThreads > MAX_TASK_CHILD_THREADS
  )) return false;
  if (execution.supervisorMayApproveThreads !== undefined
    && typeof execution.supervisorMayApproveThreads !== 'boolean') return false;
  if (execution.parallelizableOperations !== undefined
    && (!isStringArray(execution.parallelizableOperations)
      || execution.parallelizableOperations.length > MAX_TASK_OPERATION_BOUNDARIES)) return false;
  if (execution.serializedOperations !== undefined
    && (!isStringArray(execution.serializedOperations)
      || execution.serializedOperations.length > MAX_TASK_OPERATION_BOUNDARIES)) return false;
  return mode !== 'adaptive' || (
    typeof maxChildThreads === 'number'
    && Number.isInteger(maxChildThreads)
    && execution.supervisorMayApproveThreads === true
    && isStringArray(execution.parallelizableOperations)
    && execution.parallelizableOperations.length > 0
    && isStringArray(execution.serializedOperations)
    && execution.serializedOperations.length > 0
    && execution.childThreadResponsibilities.length === 0
  );
}

function isPlanFileSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  return typeof file.path === 'string' && path.isAbsolute(file.path)
    && typeof file.name === 'string'
    && typeof file.content === 'string'
    && Buffer.byteLength(file.content, 'utf8') <= 1024 * 1024
    && Number.isFinite(file.sizeBytes) && Number(file.sizeBytes) >= 0 && Number(file.sizeBytes) <= 1024 * 1024
    && Number.isFinite(file.mtimeMs) && Number.isFinite(file.capturedAt);
}

function isPendingUserQuestion(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const question = value as Record<string, unknown>;
  const options = question.options;
  return typeof question.id === 'string'
    && (question.category === undefined || ['clarification', 'manual-intervention'].includes(String(question.category)))
    && (question.workItemId === undefined || typeof question.workItemId === 'string')
    && (question.blocker === undefined || typeof question.blocker === 'string')
    && (question.reasonCode === undefined || [
      'physical-action', 'credentials', 'access-grant', 'business-choice',
      'destructive-action', 'production-action',
    ].includes(String(question.reasonCode)))
    && typeof question.question === 'string'
    && typeof question.context === 'string'
    && typeof question.previousStatus === 'string' && SESSION_STATUSES.has(question.previousStatus)
    && Number.isFinite(question.createdAt)
    && Array.isArray(options) && options.length >= 2 && options.length <= 4
    && options.every((option) => {
      if (!option || typeof option !== 'object') return false;
      const candidate = option as Record<string, unknown>;
      return typeof candidate.id === 'string' && typeof candidate.label === 'string'
        && (candidate.description === undefined || typeof candidate.description === 'string');
    })
    && (question.recommendedOptionId === undefined || typeof question.recommendedOptionId === 'string');
}

function isProjectTaskBaseline(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const baseline = value as Record<string, unknown>;
  if (!['required', 'investigating', 'approved'].includes(String(baseline.status))
    || !Number.isInteger(baseline.requirementsVersion)
    || Number(baseline.requirementsVersion) < 1) return false;
  if (baseline.workspaceVersion !== undefined && (
    typeof baseline.workspaceVersion !== 'string' || baseline.workspaceVersion.length > 2000
  )) return false;
  if (baseline.evidence !== undefined && (
    typeof baseline.evidence !== 'string' || baseline.evidence.length > 12000
  )) return false;
  if (baseline.requestedAt !== undefined && !Number.isFinite(baseline.requestedAt)) return false;
  if (baseline.approvedAt !== undefined && !Number.isFinite(baseline.approvedAt)) return false;
  if (baseline.status === 'investigating' && !Number.isFinite(baseline.requestedAt)) return false;
  return baseline.status !== 'approved' || (
    typeof baseline.workspaceVersion === 'string' && baseline.workspaceVersion.trim().length > 0
    && typeof baseline.evidence === 'string' && baseline.evidence.trim().length > 0
    && Number.isFinite(baseline.approvedAt)
  );
}

function isProjectGoal(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const goal = value as Record<string, unknown>;
  return typeof goal.id === 'string' && goal.id.length > 0
    && Number.isInteger(goal.sequence) && Number(goal.sequence) >= 1
    && typeof goal.statement === 'string' && goal.statement.trim().length > 0
    && isStringArray(goal.doneWhen)
    && typeof goal.status === 'string' && GOAL_STATUSES.has(goal.status)
    && Number.isFinite(goal.requirementsVersion) && Number(goal.requirementsVersion) >= 1
    && (goal.supersedesGoalId === undefined || typeof goal.supersedesGoalId === 'string')
    && (goal.changeReason === undefined || typeof goal.changeReason === 'string')
    && Number.isFinite(goal.createdAt)
    && (goal.activatedAt === undefined || Number.isFinite(goal.activatedAt))
    && (goal.closedAt === undefined || Number.isFinite(goal.closedAt));
}

function isProjectSubgoal(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const subgoal = value as Record<string, unknown>;
  return typeof subgoal.id === 'string' && subgoal.id.length > 0
    && typeof subgoal.goalId === 'string' && subgoal.goalId.length > 0
    && typeof subgoal.title === 'string' && subgoal.title.trim().length > 0
    && typeof subgoal.outcome === 'string' && subgoal.outcome.trim().length > 0
    && isStringArray(subgoal.acceptance) && subgoal.acceptance.length > 0
    && isStringArray(subgoal.dependencies)
    && typeof subgoal.status === 'string' && SUBGOAL_STATUSES.has(subgoal.status)
    && Number.isInteger(subgoal.order) && Number(subgoal.order) >= 1
    && Number.isFinite(subgoal.createdAt) && Number.isFinite(subgoal.updatedAt);
}

function isProjectSupervisorStagePlan(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Record<string, unknown>;
  if (!Number.isInteger(plan.revision) || Number(plan.revision) < 1
    || typeof plan.selectedRoute !== 'string' || !plan.selectedRoute.trim()
    || !Array.isArray(plan.milestones) || plan.milestones.length < 1 || plan.milestones.length > 12
    || !isStringArray(plan.expectedPaths) || !isStringArray(plan.targetedValidation)
    || !isStringArray(plan.serializedBoundaries) || !isStringArray(plan.remainingWork)
    || !Number.isFinite(plan.updatedAt)) return false;
  if (plan.workerAssignments !== undefined) {
    const assignments = normalizeProjectWorkerAssignments(plan.workerAssignments);
    if (assignments.length !== (plan.workerAssignments as unknown[]).length
      || projectWorkerAssignmentsViolation(assignments)) return false;
    if (plan.mergeOrder !== undefined && (
      !isStringArray(plan.mergeOrder)
      || plan.mergeOrder.length > MAX_PROJECT_ACTIVE_WORKERS
      || plan.mergeOrder.some((workerId) => !assignments.some((item) => item.workerId === workerId))
    )) return false;
  } else if (plan.mergeOrder !== undefined) return false;
  const milestoneIds = new Set<string>();
  let activeMilestones = 0;
  const milestonesValid = plan.milestones.every((value) => {
    if (!value || typeof value !== 'object') return false;
    const milestone = value as Record<string, unknown>;
    if (milestone.status === 'active') activeMilestones += 1;
    if (typeof milestone.id === 'string') milestoneIds.add(milestone.id.trim());
    return typeof milestone.id === 'string' && !!milestone.id.trim()
      && typeof milestone.title === 'string' && !!milestone.title.trim()
      && typeof milestone.outcome === 'string' && !!milestone.outcome.trim()
      && ['planned', 'active', 'completed'].includes(String(milestone.status))
      && (milestone.evidence === undefined || typeof milestone.evidence === 'string');
  });
  return milestonesValid
    && milestoneIds.size === plan.milestones.length
    && activeMilestones <= 1;
}

function isProjectManagerSession(value: unknown): value is ProjectManagerSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  if (
    typeof session.id !== 'string' || !SESSION_ID.test(session.id)
    || typeof session.projectDir !== 'string' || !path.isAbsolute(session.projectDir)
    || (session.projectName !== undefined && typeof session.projectName !== 'string')
    || (session.projectScope !== undefined && typeof session.projectScope !== 'string')
    || (session.activeGoalId !== undefined && typeof session.activeGoalId !== 'string')
    || (session.goals !== undefined && (!Array.isArray(session.goals) || !session.goals.every(isProjectGoal)))
    || (session.subgoals !== undefined && (!Array.isArray(session.subgoals) || !session.subgoals.every(isProjectSubgoal)))
    || typeof session.goal !== 'string' || !isStringArray(session.doneWhen)
    || (session.preconditions !== undefined && !isStringArray(session.preconditions))
    || (session.supervisorNotes !== undefined && !isStringArray(session.supervisorNotes))
    || (session.planFiles !== undefined && (!Array.isArray(session.planFiles) || session.planFiles.length > 3 || !session.planFiles.every(isPlanFileSnapshot)))
    || (session.pendingUserQuestion !== undefined && !isPendingUserQuestion(session.pendingUserQuestion))
    || (session.pendingManagerDeliveries !== undefined && (
      !Array.isArray(session.pendingManagerDeliveries)
      || session.pendingManagerDeliveries.length > 100
      || session.pendingManagerDeliveries.some((delivery) => (
        !delivery || typeof delivery !== 'object'
        || typeof delivery.id !== 'string'
        || typeof delivery.text !== 'string'
        || !Number.isFinite(delivery.createdAt)
        || (delivery.transitionId !== undefined && typeof delivery.transitionId !== 'string')
      ))
    ))
    || (session.pendingSupervisorTransitions !== undefined && (
      !Array.isArray(session.pendingSupervisorTransitions)
      || session.pendingSupervisorTransitions.length > 50
      || session.pendingSupervisorTransitions.some((transition) => (
        !transition || typeof transition !== 'object'
        || typeof transition.id !== 'string'
        || typeof transition.laneId !== 'string'
        || (transition.workItemId !== undefined && typeof transition.workItemId !== 'string')
        || !['stage-complete', 'direction-needed', 'decision-required', 'supervisor-unavailable', 'supervisor-idle', 'project-action-required']
          .includes(String(transition.kind))
        || typeof transition.eventType !== 'string' || !transition.eventType.trim()
        || typeof transition.summary !== 'string' || !transition.summary.trim()
        || (transition.evidence !== undefined && typeof transition.evidence !== 'string')
        || (transition.contextSummary !== undefined && typeof transition.contextSummary !== 'string')
        || !Number.isFinite(transition.createdAt)
        || !Number.isFinite(transition.notifiedAt)
        || !Number.isFinite(transition.notificationCount)
      ))
    ))
    || (session.requirementsVersion !== undefined && (!Number.isFinite(session.requirementsVersion) || Number(session.requirementsVersion) < 1))
    || (session.authorizationVersion !== undefined && (!Number.isFinite(session.authorizationVersion) || Number(session.authorizationVersion) < 1))
    || (session.acceptedRequirementsVersion !== undefined && (!Number.isFinite(session.acceptedRequirementsVersion) || Number(session.acceptedRequirementsVersion) < 0))
    || (session.executionProtocolVersion !== undefined && (
      !Number.isInteger(session.executionProtocolVersion) || Number(session.executionProtocolVersion) < 0
    ))
    || (session.progressSnapshot !== undefined && !normalizeProjectProgressSnapshot(session.progressSnapshot))
    || (session.progressSync !== undefined && !normalizeProjectProgressSyncState(session.progressSync))
    || (session.orientation !== undefined && !normalizeProjectOrientationState(session.orientation))
    || typeof session.status !== 'string' || !SESSION_STATUSES.has(session.status)
    || (session.pausedByPortfolio !== undefined && typeof session.pausedByPortfolio !== 'boolean')
    || (session.taskTerminalSurfaceId !== undefined && typeof session.taskTerminalSurfaceId !== 'string')
    || !Array.isArray(session.workItems) || !Array.isArray(session.events)
    || !Number.isFinite(session.createdAt) || !Number.isFinite(session.updatedAt)
  ) return false;
  const workItemsValid = session.workItems.every((value) => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, any>;
    const contract = item.contract;
    const scope = contract?.scope;
    const authority = contract?.authority;
    const budget = contract?.budget;
    const execution = contract?.execution;
    return typeof item.id === 'string'
      && (item.goalId === undefined || typeof item.goalId === 'string')
      && (item.subgoalId === undefined || typeof item.subgoalId === 'string')
      && (item.requirementsVersion === undefined || (Number.isFinite(item.requirementsVersion) && item.requirementsVersion >= 1))
      && (item.authorizationVersion === undefined || (Number.isFinite(item.authorizationVersion) && item.authorizationVersion >= 1))
      && (item.executionProtocolVersion === undefined || (
        Number.isInteger(item.executionProtocolVersion) && item.executionProtocolVersion >= 0
      ))
      && (item.baseline === undefined || isProjectTaskBaseline(item.baseline))
      && (item.supervisorPlan === undefined || isProjectSupervisorStagePlan(item.supervisorPlan))
      && (item.supervisorPlanRequired === undefined || typeof item.supervisorPlanRequired === 'boolean')
      && (item.parallelismDecision === undefined || (
        item.parallelismDecision && typeof item.parallelismDecision === 'object'
        && ['auto', 'single-worker', 'internal-threads', 'worker-group'].includes(String(item.parallelismDecision.requestedMode))
        && ['single-worker', 'internal-threads', 'worker-group'].includes(String(item.parallelismDecision.resolvedMode))
        && Number.isInteger(item.parallelismDecision.requirementsVersion)
        && Number.isInteger(item.parallelismDecision.executionEpoch)
        && typeof item.parallelismDecision.reason === 'string'
        && isStringArray(item.parallelismDecision.evidence)
        && Number.isFinite(item.parallelismDecision.resolvedAt)
      ))
      && (item.workerGroup === undefined || isWorkerGroup(item.workerGroup))
      && (item.userDirectives === undefined || (Array.isArray(item.userDirectives) && item.userDirectives.every(isUserDirective)))
      && (item.resourceLeases === undefined || (Array.isArray(item.resourceLeases) && item.resourceLeases.every(isResourceLease)))
      && (item.mergeCandidates === undefined || (Array.isArray(item.mergeCandidates) && item.mergeCandidates.every(isMergeCandidate)))
      && (item.finalApplyBlocked === undefined || typeof item.finalApplyBlocked === 'boolean')
      && typeof item.title === 'string'
      && typeof item.status === 'string' && WORK_ITEM_STATUSES.has(item.status)
      && isStringArray(item.dependencies)
      && Array.isArray(item.executionHistory)
      && Number.isFinite(item.attempts) && Number.isFinite(item.decisionsUsed) && Number.isFinite(item.updatedAt)
      && typeof contract?.objective === 'string' && typeof contract?.description === 'string'
      && isStringArray(contract?.preconditions) && isStringArray(contract?.stopWhen) && isStringArray(contract?.validation)
      && (contract?.supervisorNotes === undefined || isStringArray(contract.supervisorNotes))
      && typeof scope?.root === 'string' && path.isAbsolute(scope.root)
      && scope.root.toLowerCase() === String(session.projectDir).toLowerCase()
      && isStringArray(scope?.allowPaths) && isStringArray(scope?.denyPaths) && isStringArray(scope?.forbiddenActions)
      && ['technicalChoices', 'lowRiskRetries', 'targetedTests', 'internalThreads']
        .every((key) => typeof authority?.[key] === 'boolean')
      && (authority?.routeAdjustments === undefined || typeof authority.routeAdjustments === 'boolean')
      && (authority?.continuousExecution === undefined || typeof authority.continuousExecution === 'boolean')
      && (authority?.permissionConfirm === undefined || typeof authority.permissionConfirm === 'boolean')
      && (authority?.continuationBoundary === undefined
        || CONTINUATION_BOUNDARIES.has(String(authority.continuationBoundary)))
      && !(authority?.continuousExecution === false && authority.continuationBoundary === undefined)
      && !(authority?.continuousExecution === true && authority.continuationBoundary !== undefined)
      && (authority?.allowedCommandPrefixes === undefined || isStringArray(authority.allowedCommandPrefixes))
      && (authority?.authorizedDevices === undefined || isStringArray(authority.authorizedDevices))
      && (authority?.authorizedEnvironments === undefined || isStringArray(authority.authorizedEnvironments))
      && (authority?.authorizedOperations === undefined || isStringArray(authority.authorizedOperations))
      && ['maxDecisions', 'maxContinuousMinutes', 'maxIdenticalFailures', 'maxNoProgressRounds',
        'maxTaskRetries', 'maxSameTestRuns', 'maxFullSuiteRunsPerVersion']
        .every((key) => Number.isFinite(budget?.[key]) && budget[key] >= 1)
      && (budget?.maxAggregateWorkerMinutes === undefined
        || (Number.isFinite(budget.maxAggregateWorkerMinutes) && budget.maxAggregateWorkerMinutes >= 1))
      && (!execution || isProjectTaskExecutionPlan(execution, authority?.internalThreads === true));
  });
  if (!workItemsValid) return false;
  const goals = Array.isArray(session.goals) ? session.goals as Array<Record<string, unknown>> : [];
  const subgoals = Array.isArray(session.subgoals) ? session.subgoals as Array<Record<string, unknown>> : [];
  if (goals.some((goal) => goal.status === 'completed' && (goal.doneWhen as unknown[]).length === 0)) {
    return false;
  }
  if (session.status === 'completed' && (session.doneWhen as unknown[]).length === 0) return false;
  if (goals.length === 0) return session.activeGoalId === undefined && subgoals.length === 0;
  const goalIds = new Set(goals.map((goal) => String(goal.id)));
  const goalSequences = new Set(goals.map((goal) => Number(goal.sequence)));
  if (goalIds.size !== goals.length || goalSequences.size !== goals.length || !goalIds.has(String(session.activeGoalId))) {
    return false;
  }
  const openGoals = goals.filter((goal) => ['active', 'transitioning'].includes(String(goal.status)));
  if (openGoals.length > 1 || (openGoals.length === 1 && String(openGoals[0].id) !== String(session.activeGoalId))) {
    return false;
  }
  const subgoalKey = (goalId: unknown, subgoalId: unknown) => `${String(goalId)}\u0000${String(subgoalId)}`;
  const subgoalKeys = new Set(subgoals.map((subgoal) => subgoalKey(subgoal.goalId, subgoal.id)));
  if (subgoalKeys.size !== subgoals.length || subgoals.some((subgoal) => (
    !goalIds.has(String(subgoal.goalId))
    || (subgoal.dependencies as unknown[]).some((dependency) => (
      !subgoalKeys.has(subgoalKey(subgoal.goalId, dependency))
    ))
  ))) return false;
  const dependenciesBySubgoal = new Map(subgoals.map((subgoal) => [
    subgoalKey(subgoal.goalId, subgoal.id),
    (subgoal.dependencies as unknown[]).map((dependency) => subgoalKey(subgoal.goalId, dependency)),
  ]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dependencyGraphIsAcyclic = (subgoalId: string): boolean => {
    if (visited.has(subgoalId)) return true;
    if (visiting.has(subgoalId)) return false;
    visiting.add(subgoalId);
    for (const dependencyId of dependenciesBySubgoal.get(subgoalId) || []) {
      if (!dependencyGraphIsAcyclic(dependencyId)) return false;
    }
    visiting.delete(subgoalId);
    visited.add(subgoalId);
    return true;
  };
  if ([...subgoalKeys].some((subgoalId) => !dependencyGraphIsAcyclic(subgoalId))) return false;
  return session.workItems.every((rawItem) => {
    const item = rawItem as Record<string, unknown>;
    if (item.goalId === undefined && item.subgoalId === undefined) return true;
    if (!goalIds.has(String(item.goalId))) return false;
    if (item.subgoalId === undefined) return true;
    return subgoalKeys.has(subgoalKey(item.goalId, item.subgoalId));
  });
}

function readProjectManagerSessions(
  appDataDir = getAppDataDir(),
): ProjectManagerSession[] {
  const directory = recordsDirectory(appDataDir);
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_ID.test(path.basename(entry.name, '.json')) && entry.name.endsWith('.json'))
      .map<ProjectManagerSession | null>((entry) => {
        try {
          const filePath = path.join(directory, entry.name);
          if (fs.statSync(filePath).size > MAX_SESSION_BYTES) return null;
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version?: unknown; session?: unknown };
          return parsed.version === 1 && isProjectManagerSession(parsed.session)
            ? normalizeProjectManagerSession({
                ...parsed.session,
                preconditions: parsed.session.preconditions || [],
                supervisorNotes: parsed.session.supervisorNotes || [],
                planFiles: parsed.session.planFiles || [],
                pendingManagerDeliveries: parsed.session.pendingManagerDeliveries || [],
                requirementsVersion: parsed.session.requirementsVersion || 1,
                acceptedRequirementsVersion: parsed.session.acceptedRequirementsVersion ?? 0,
              } satisfies ProjectManagerSession)
            : null;
        } catch {
          return null;
        }
      })
      .filter((session): session is ProjectManagerSession => !!session)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveProjectManagerSession(
  session: ProjectManagerSession,
  appDataDir = getAppDataDir(),
): { path: string } {
  const normalized = normalizeProjectManagerSession(session);
  validateIdentity(normalized.id, normalized.projectDir);
  if (!isProjectManagerSession(normalized)) throw new Error('invalid project manager session payload');
  const duplicate = ['active', 'paused', 'waiting'].includes(normalized.status)
    ? readProjectManagerSessions(appDataDir).find((candidate) => (
        candidate.id !== normalized.id
        && projectDirectoryIdentity(candidate.projectDir) === projectDirectoryIdentity(normalized.projectDir)
        && ['active', 'paused', 'waiting'].includes(candidate.status)
      ))
    : undefined;
  if (duplicate) {
    throw new Error(`该目录已存在项目 AI：${duplicate.id}`);
  }
  const directory = recordsDirectory(appDataDir);
  fs.mkdirSync(directory, { recursive: true });
  const sessionPath = path.join(directory, `${session.id}.json`);
  const temporaryPath = path.join(directory, `${session.id}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, session: normalized }, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temporaryPath, sessionPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') throw error;
    fs.rmSync(sessionPath, { force: true });
    fs.renameSync(temporaryPath, sessionPath);
  }
  return { path: sessionPath };
}

export function deleteProjectManagerSession(
  sessionId: string,
  appDataDir = getAppDataDir(),
): { deleted: boolean } {
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid project manager session id');
  const directory = recordsDirectory(appDataDir);
  let deleted = false;
  // Keep the restorable snapshot until last so an audit-file failure cannot
  // leave the UI session alive while its durable project state is already gone.
  for (const extension of ['.ndjson', '.json']) {
    const filePath = path.join(directory, `${sessionId}${extension}`);
    try {
      fs.unlinkSync(filePath);
      deleted = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { deleted };
}

export function appendProjectManagerRecord(
  record: ProjectManagerRecord,
  appDataDir = getAppDataDir(),
): { path: string } {
  validateIdentity(record.sessionId, record.projectDir);
  const directory = recordsDirectory(appDataDir);
  fs.mkdirSync(directory, { recursive: true });
  const recordPath = path.join(directory, `${record.sessionId}.ndjson`);
  try {
    if (fs.statSync(recordPath).size >= MAX_RECORD_BYTES) {
      throw new Error('project manager audit log reached its size limit');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fs.appendFileSync(recordPath, `${JSON.stringify({
    version: 1,
    ts: record.ts ?? Date.now(),
    type: record.type,
    projectDir: record.projectDir,
    payload: record.payload || {},
  })}\n`, 'utf8');
  return { path: recordPath };
}

export function readActiveProjectManagerSessions(
  appDataDir = getAppDataDir(),
): ProjectManagerSession[] {
  const seenDirectories = new Set<string>();
  return readProjectManagerSessions(appDataDir)
    .filter((session) => ['active', 'paused', 'waiting'].includes(session.status))
    .filter((session) => {
      const identity = projectDirectoryIdentity(session.projectDir);
      if (seenDirectories.has(identity)) return false;
      seenDirectories.add(identity);
      return true;
    });
}

/** Native Agent conversations are restart-unsafe even after their project was completed or stopped. */
export function readProjectManagerRuntimeSurfaceIds(
  appDataDir = getAppDataDir(),
): string[] {
  return [...new Set(readProjectManagerSessions(appDataDir).flatMap((session) => [
    session.taskTerminalSurfaceId,
    ...session.workItems.map((item) => item.workerSurfaceId),
  ]).filter((surfaceId): surfaceId is string => !!surfaceId))];
}
