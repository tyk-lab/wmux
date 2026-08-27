import type { ProjectManagerSession } from '../../shared/project-manager';

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
