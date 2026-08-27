import {
  projectAuthorizationVersion,
  projectRequirementsVersion,
  type ProjectManagerSession,
  type ProjectWorkItem,
} from '../../shared/project-manager';

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

/**
 * User-settled verification gaps remain immutable history. They must neither be
 * rebound to a newer definition nor block that definition from resuming; any
 * later verification is represented by a successor work item.
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
