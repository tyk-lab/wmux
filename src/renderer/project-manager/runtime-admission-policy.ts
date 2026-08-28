import {
  activeProjectGoal,
  projectAuthorizationVersion,
  projectRequirementsVersion,
  type ProjectManagerSession,
} from '../../shared/project-manager';

/** A project supervisor exists for an owned work item, not for pre-planning idle time. */
export function projectSupervisorRuntimeRequired(session: ProjectManagerSession): boolean {
  const goalId = activeProjectGoal(session).id;
  const requirementsVersion = projectRequirementsVersion(session);
  const authorizationVersion = projectAuthorizationVersion(session);
  return session.workItems.some((item) => (
    item.goalId === goalId
    && item.requirementsVersion === requirementsVersion
    && item.authorizationVersion === authorizationVersion
    && !['completed', 'stopped'].includes(item.status)
    && (
      item.id === session.activeWorkItemId
      || !!item.supervisorLaneId
      || ['running', 'validating', 'waiting-decision'].includes(item.status)
    )
  ));
}
