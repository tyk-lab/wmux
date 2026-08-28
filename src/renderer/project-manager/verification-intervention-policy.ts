import {
  activeProjectGoal,
  normalizeProjectCompletionResult,
  normalizeProjectStageAcceptanceCoverage,
  projectCompletionCriteriaError,
  projectCriterionIdentity,
  projectCriterionVerificationCannotBeRelaxed,
  projectGoalVerificationPolicies,
  projectSubgoalCompletionResult,
  projectWorkItemCurrentVerificationLimitation,
  projectAuthorizationVersion,
  projectRequirementsVersion,
  type ProjectManagerSession,
  type ProjectWorkItem,
} from '../../shared/project-manager';

function projectWorkItemVerificationWaiverCriteria(
  session: ProjectManagerSession,
  item: ProjectWorkItem,
): string[] {
  const limitation = projectWorkItemCurrentVerificationLimitation(session, item);
  if (!limitation) return [];
  const coverage = normalizeProjectStageAcceptanceCoverage(item.contract.stageAcceptanceCoverage);
  const subgoal = item.subgoalId
    ? (session.subgoals || []).find((candidate) => candidate.id === item.subgoalId)
    : undefined;
  const affected = limitation.affectedAcceptance.length > 0
    ? limitation.affectedAcceptance.flatMap((criterion) => {
        const identity = projectCriterionIdentity(criterion);
        const mapped = coverage.filter((entry) => (
          projectCriterionIdentity(entry.verificationCriterion) === identity
          || projectCriterionIdentity(entry.stageCriterion) === identity
        )).map((entry) => entry.stageCriterion);
        if (mapped.length > 0) return mapped;
        if (!subgoal) return coverage.length > 0 ? [] : [criterion];
        const exactStageCriterion = subgoal.acceptance.find((entry) => (
          projectCriterionIdentity(entry) === identity
        ));
        if (exactStageCriterion) return [exactStageCriterion];
        return coverage.length === 0 && subgoal.acceptance.length === 1
          ? [subgoal.acceptance[0]]
          : [];
      })
    : coverage.length > 0
      ? coverage.map((mapping) => mapping.stageCriterion)
      : subgoal?.acceptance.length === 1 ? [subgoal.acceptance[0]] : [];
  return [...new Map(affected.map((criterion) => (
    [projectCriterionIdentity(criterion), criterion.trim()]
  ))).values()].filter(Boolean);
}

export function projectWorkItemVerificationWaiverError(
  session: ProjectManagerSession,
  item: ProjectWorkItem,
  options: { riskAcknowledged?: boolean } = {},
): string | null {
  if ((item.goalId && item.goalId !== activeProjectGoal(session).id)
    || item.requirementsVersion !== projectRequirementsVersion(session)
    || item.authorizationVersion !== projectAuthorizationVersion(session)) {
    return '只能跳过当前主目标、当前需求和授权版本的验证';
  }
  const completion = normalizeProjectCompletionResult(item.completion);
  const knownFailure = item.status === 'failed' || completion?.criteria?.find((criterion) => (
    criterion.status === 'unsatisfied' || criterion.result === 'failed'
  ));
  if (knownFailure) return '工作项存在真实失败，不能通过跳过验证掩盖';
  const limitation = projectWorkItemCurrentVerificationLimitation(session, item);
  const criteria = projectWorkItemVerificationWaiverCriteria(session, item);
  if (criteria.length === 0) return '当前工作项没有可由用户明确豁免的验证条件';
  const policies = new Map(projectGoalVerificationPolicies(activeProjectGoal(session)).map((policy) => (
    [projectCriterionIdentity(policy.criterion), policy]
  )));
  const protectedCriterion = criteria.find((criterion) => {
    if (projectCriterionVerificationCannotBeRelaxed(criterion)) return true;
    const policy = policies.get(projectCriterionIdentity(criterion));
    return !policy || policy.riskClass !== 'standard';
  });
  const protectedRawCriterion = limitation?.affectedAcceptance.find(
    projectCriterionVerificationCannotBeRelaxed,
  );
  const riskCriterion = protectedRawCriterion || protectedCriterion;
  const riskAcknowledged = options.riskAcknowledged === true
    || item.verificationDecision?.riskAcknowledged === true;
  return riskCriterion && !riskAcknowledged
    ? `跳过该验证需要用户先确认保护性验收风险：${riskCriterion}`
    : null;
}

export function projectWorkItemVerificationWaiverRisk(
  session: ProjectManagerSession,
  item: ProjectWorkItem,
): string | null {
  const limitation = projectWorkItemCurrentVerificationLimitation(session, item);
  const criteria = projectWorkItemVerificationWaiverCriteria(session, item);
  const policies = new Map(projectGoalVerificationPolicies(activeProjectGoal(session)).map((policy) => (
    [projectCriterionIdentity(policy.criterion), policy]
  )));
  const protectedRawCriterion = limitation?.affectedAcceptance.find(
    projectCriterionVerificationCannotBeRelaxed,
  );
  const protectedCriterion = criteria.find((criterion) => {
    if (projectCriterionVerificationCannotBeRelaxed(criterion)) return true;
    const policy = policies.get(projectCriterionIdentity(criterion));
    return !policy || policy.riskClass !== 'standard';
  });
  const riskCriterion = protectedRawCriterion || protectedCriterion;
  return riskCriterion
    ? `该验收属于保护性或高风险条件：${riskCriterion}。跳过后只记录“用户接受未验证风险”，不会记录为通过，也不能掩盖已知失败。`
    : null;
}

export function projectWorkItemVerificationWaived(
  session: ProjectManagerSession,
  item: ProjectWorkItem,
): boolean {
  const decision = item.verificationDecision;
  return decision?.action === 'skip-verification'
    && decision.requirementsVersion === projectRequirementsVersion(session)
    && decision.authorizationVersion === projectAuthorizationVersion(session)
    && !projectWorkItemVerificationWaiverError(session, item);
}

export function projectVerificationWaivedCriteria(
  session: ProjectManagerSession,
  subgoalId?: string,
): string[] {
  const criteria = session.workItems.filter((item) => (
    (!subgoalId || item.subgoalId === subgoalId) && projectWorkItemVerificationWaived(session, item)
  )).flatMap((item) => projectWorkItemVerificationWaiverCriteria(session, item));
  return [...new Map(criteria.map((criterion) => (
    [projectCriterionIdentity(criterion), criterion]
  ))).values()];
}

export function projectSubgoalClosedByVerificationWaiver(
  session: ProjectManagerSession,
  subgoalId: string,
): boolean {
  const subgoal = (session.subgoals || []).find((candidate) => candidate.id === subgoalId);
  if (!subgoal || subgoal.goalId !== activeProjectGoal(session).id) return false;
  const currentItems = session.workItems.filter((item) => (
    item.goalId === subgoal.goalId
    && item.subgoalId === subgoal.id
    && item.requirementsVersion === projectRequirementsVersion(session)
    && item.authorizationVersion === projectAuthorizationVersion(session)
  ));
  if (currentItems.length === 0 || currentItems.some((item) => (
    item.status !== 'completed' && !projectWorkItemVerificationWaived(session, item)
  ))) return false;
  const waived = new Set(projectVerificationWaivedCriteria(session, subgoal.id).map(projectCriterionIdentity));
  if (waived.size === 0) return false;
  const completion = projectSubgoalCompletionResult({
    ...subgoal,
    status: 'achieved',
    updatedAt: subgoal.updatedAt,
  }, currentItems, {
    requirementsVersion: projectRequirementsVersion(session),
    authorizationVersion: projectAuthorizationVersion(session),
  });
  return subgoal.acceptance.every((criterion) => (
    waived.has(projectCriterionIdentity(criterion))
    || !projectCompletionCriteriaError(
      [criterion],
      completion,
      '阶段验收',
      { allowExtra: true, requireArtifacts: true },
    )
  ));
}

export function projectWorkItemVerificationIntervened(item: ProjectWorkItem): boolean {
  const decision = item.verificationDecision;
  return !!decision && ['defer-verification', 'skip-verification'].includes(decision.action);
}

export function projectWorkItemVerificationDeferred(
  session: ProjectManagerSession,
  item: ProjectWorkItem,
): boolean {
  const decision = item.verificationDecision;
  if (!decision || !projectWorkItemVerificationIntervened(item)) return false;
  return decision.requirementsVersion === projectRequirementsVersion(session)
    && decision.authorizationVersion === projectAuthorizationVersion(session);
}

export interface ProjectStaleDeferredVerificationBlocker {
  deferredItem: ProjectWorkItem;
  completedSuccessor: ProjectWorkItem;
  subgoalId: string;
}

/** A historical defer may not silently block a stage already covered by current-version evidence. */
export function projectStaleDeferredVerificationBlocker(
  session: ProjectManagerSession,
): ProjectStaleDeferredVerificationBlocker | null {
  const goal = activeProjectGoal(session);
  const requirementsVersion = projectRequirementsVersion(session);
  const authorizationVersion = projectAuthorizationVersion(session);
  for (const deferredItem of session.workItems) {
    if (deferredItem.goalId !== goal.id
      || deferredItem.status !== 'paused'
      || !deferredItem.subgoalId
      || deferredItem.verificationDecision?.action !== 'defer-verification'
      || projectWorkItemVerificationDeferred(session, deferredItem)) continue;
    const subgoal = (session.subgoals || []).find((candidate) => (
      candidate.id === deferredItem.subgoalId
      && candidate.goalId === goal.id
      && !['achieved', 'obsolete'].includes(candidate.status)
    ));
    if (!subgoal) continue;
    const currentCompletedItems = session.workItems.filter((item) => (
      item.id !== deferredItem.id
      && item.goalId === goal.id
      && item.subgoalId === subgoal.id
      && item.requirementsVersion === requirementsVersion
      && item.authorizationVersion === authorizationVersion
      && item.status === 'completed'
      && !!normalizeProjectCompletionResult(item.completion)
    ));
    if (currentCompletedItems.length === 0) continue;
    const completion = projectSubgoalCompletionResult({
      ...subgoal,
      status: 'achieved',
      completion: undefined,
    }, currentCompletedItems, { requirementsVersion, authorizationVersion });
    if (subgoal.acceptance.some((criterion) => projectCompletionCriteriaError(
      [criterion],
      completion,
      '阶段验收',
      { allowExtra: true, requireArtifacts: true },
    ))) continue;
    const completedSuccessor = [...currentCompletedItems]
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return { deferredItem, completedSuccessor, subgoalId: subgoal.id };
  }
  return null;
}

/**
 * User-settled verification decisions remain immutable until the user explicitly
 * resumes the same deferred work item. A current skip is an audited waiver; protected
 * criteria additionally require riskAcknowledged and are never converted into passing evidence.
 */
export function projectWorkItemRequiresVersionReconciliation(
  session: ProjectManagerSession,
  item: ProjectWorkItem,
): boolean {
  return !['completed', 'stopped'].includes(item.status)
    && !projectWorkItemVerificationIntervened(item)
    && (item.requirementsVersion !== projectRequirementsVersion(session)
      || item.authorizationVersion !== projectAuthorizationVersion(session));
}
