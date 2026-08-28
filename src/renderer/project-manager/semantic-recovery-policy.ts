import {
  activeProjectGoal,
  activeProjectSubgoals,
  projectAuthorizationVersion,
  projectRequirementsVersion,
  type ProjectManagerSession,
  type ProjectWorkItem,
} from '../../shared/project-manager';

export interface ProjectInternalRecoveryScopeInput {
  protocolRevision: string;
  sessionId: string;
  workItemId?: string;
  baselineFingerprint: string;
}

export function buildProjectInternalRecoveryScopeKey(
  input: ProjectInternalRecoveryScopeInput,
): string {
  return [
    'project-internal-recovery-scope',
    `role-${input.protocolRevision}`,
    input.sessionId,
    input.workItemId || 'project',
    input.baselineFingerprint,
  ].join(':');
}

export function projectInternalRecoveryAttempts(
  events: ProjectManagerSession['events'],
  recoveryKey: string,
): number {
  let recoveryResetIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if ((event.kind === 'user-clarification-invalidated'
        && event.payload?.reason === 'runtime-recovery-auto-retry-on-restore')
      || (event.kind === 'supervisor-transition-acknowledged'
        && event.payload?.resolution === 'recovered')
      || (event.kind === 'recovery-restored'
        && event.payload?.recoverySource === 'active-assignment'
        && event.payload?.phase === 'runtime-chain-ready')) {
      recoveryResetIndex = index;
      break;
    }
  }
  return events.slice(recoveryResetIndex + 1).filter((event) => (
    event.kind === 'project-recovery-requested'
    && (event.payload?.recoveryKey === recoveryKey
      || event.payload?.recoveryScopeKey === recoveryKey)
  )).length;
}

/** A never-started dispatch failure is a runtime/control-plane incident, not evidence that the work route failed. */
export function projectRecoveryExhaustionRequiresRuntimeEscalation(
  obligation: string | undefined,
  workItem: ProjectWorkItem | undefined,
): boolean {
  if (obligation !== 'dispatch-work' || !workItem) return false;
  return ['planned', 'waiting-dependencies'].includes(workItem.status)
    && (workItem.attempts || 0) === 0
    && (workItem.executionHistory || []).length === 0
    && !workItem.startedAt
    && !workItem.latestEvidence
    && !workItem.completion;
}

/** The same project facts may receive at most one automatic L2 replan before ownership returns to the user. */
export function projectRouteRecoveryAlreadyAttempted(
  session: ProjectManagerSession,
  workItemId: string,
): boolean {
  const snapshotFingerprint = session.progressSnapshot?.fingerprint;
  if (!snapshotFingerprint) return false;
  const requirementsVersion = projectRequirementsVersion(session);
  const authorizationVersion = projectAuthorizationVersion(session);
  if (session.orientation?.status === 'ready'
    && session.orientation.recovery?.level === 'route'
    && session.orientation.recovery.workItemId === workItemId
    && session.orientation.snapshotFingerprint === snapshotFingerprint
    && session.orientation.requirementsVersion === requirementsVersion
    && session.orientation.authorizationVersion === authorizationVersion) {
    return true;
  }
  return session.events.some((event) => (
    event.kind === 'project-orientation-confirmed'
    && event.payload?.recoveryLevel === 'route'
    && (event.workItemId === workItemId || event.payload?.recoveryWorkItemId === workItemId)
    && event.payload?.snapshotFingerprint === snapshotFingerprint
    && event.payload?.requirementsVersion === requirementsVersion
    && event.payload?.authorizationVersion === authorizationVersion
  ));
}

/**
 * Detect sessions paused by the pre-fix watchdog after every current result and
 * stage had already closed. Only the persisted complete-goal recovery signature
 * qualifies; user, portfolio, runtime, and unfinished-work pauses stay intact.
 */
export function projectGoalClosurePauseWasMisclassified(
  session: ProjectManagerSession,
): boolean {
  if (session.status !== 'paused'
    || session.pausedByPortfolio
    || session.pendingUserQuestion
    || session.agentIssue) return false;
  const goal = activeProjectGoal(session);
  if (goal.status !== 'active') return false;
  const goalItems = session.workItems.filter((item) => (
    item.goalId === goal.id
    && item.status !== 'stopped'
  ));
  if (goalItems.some((item) => item.status !== 'completed')) return false;
  const currentItems = goalItems.filter((item) => (
    item.requirementsVersion === projectRequirementsVersion(session)
    && item.authorizationVersion === projectAuthorizationVersion(session)
  ));
  if (currentItems.length === 0) return false;
  const subgoals = activeProjectSubgoals(session);
  if (subgoals.length === 0 || subgoals.some((subgoal) => (
    !['achieved', 'obsolete'].includes(subgoal.status)
  ))) return false;
  const reversedEvents = [...session.events].reverse();
  const latestStall = reversedEvents.find((event) => event.kind === 'project-execution-stalled');
  const latestExhaustion = reversedEvents.find((event) => (
    event.kind === 'guard-triggered'
    && event.payload?.reason === 'project-internal-recovery-exhausted'
  ));
  const latestPause = reversedEvents.find((event) => event.kind === 'project-paused');
  const latestStatusTransition = reversedEvents.find((event) => (
    event.kind === 'project-paused'
    || event.kind === 'project-resumed'
    || event.kind === 'recovery-restored'
  ));
  const stallKey = String(latestStall?.payload?.incidentKey || latestStall?.payload?.recoveryKey || '');
  return latestStall?.payload?.automaticPause === true
    && stallKey.endsWith(':complete-goal')
    && latestExhaustion?.payload?.obligation === 'complete-goal'
    && latestExhaustion?.payload?.recoveryKey === stallKey
    && latestPause?.payload?.source === 'runtime'
    && latestStatusTransition?.id === latestPause.id;
}
