import {
  activeProjectGoal,
  activeProjectManagerAttentionEvent,
  type ProjectManagerSession,
} from '../../shared/project-manager';

export type ProjectCenterVisualState = 'error' | 'human' | 'waiting' | 'paused' | 'active' | 'stopped';

const NON_ERROR_ATTENTION_KINDS = new Set([
  'project-paused',
  'project-goal-completed',
]);

/** Maps project control-plane state onto the same colors used by the ordinary supervisor center. */
export function projectCenterVisualState(session: ProjectManagerSession): ProjectCenterVisualState {
  const attention = activeProjectManagerAttentionEvent(session.events);
  if (
    session.safeExit?.status === 'blocked'
    || !!session.agentIssue
    || session.agentReconfiguration?.status === 'failed'
    || (!!attention && !NON_ERROR_ATTENTION_KINDS.has(attention.kind))
  ) return 'error';
  if (session.status === 'completed' || session.status === 'stopped') return 'stopped';
  if (
    !!session.pendingUserQuestion
    || attention?.kind === 'project-goal-completed'
    || activeProjectGoal(session).status === 'achieved'
  ) return 'human';
  if (
    session.status === 'paused'
    || session.safeExit?.status === 'saved'
    || attention?.kind === 'project-paused'
  ) return 'paused';
  if (
    session.status === 'waiting'
    || session.safeExit?.status === 'saving'
    || session.safeExit?.status === 'restoring'
    || session.progressSync?.status === 'review-required'
    || (!!session.orientation && session.orientation.status !== 'ready')
    || !!session.pendingSupervisorTransitions?.length
    || !!session.agentReconfiguration
  ) return 'waiting';
  if (session.status === 'active') return 'active';
  return 'stopped';
}

export function projectCenterStatusLabel(
  session: ProjectManagerSession,
  activityLabel: string,
): string {
  const visualState = projectCenterVisualState(session);
  if (visualState === 'error') return '监督异常';
  if (visualState === 'human') {
    return session.pendingUserQuestion ? '等待人工处理' : '等待下一主目标';
  }
  return activityLabel;
}
