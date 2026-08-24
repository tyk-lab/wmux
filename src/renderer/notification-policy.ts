import type {
  NotificationAction,
  NotificationInfo,
  NotificationOwner,
  NotificationSeverity,
} from '../shared/types';

type NotificationMetadata = Pick<
  NotificationInfo,
  'owner' | 'severity' | 'dedupeKey' | 'action' | 'projectId' | 'laneId' | 'sourceLabel'
>;

interface NotificationPolicyInput {
  owner: NotificationOwner;
  entityId: string;
  kind: string;
  severity?: NotificationSeverity;
  action?: NotificationAction;
  projectId?: string;
  laneId?: string;
  sourceLabel?: string;
}

export function notificationDedupeKey(
  owner: NotificationOwner,
  entityId: string,
  kind: string,
): string {
  return `${owner}:${entityId}:${kind}`;
}

/** Attach responsibility and a stable replacement key at every user-attention outlet. */
export function notificationMetadata(input: NotificationPolicyInput): NotificationMetadata {
  return {
    owner: input.owner,
    severity: input.severity || 'attention',
    dedupeKey: notificationDedupeKey(input.owner, input.entityId, input.kind),
    action: input.action || (input.owner === 'project'
      ? 'open-project-manager'
      : input.owner === 'supervisor'
        ? 'open-supervisor'
        : 'open-surface'),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.laneId ? { laneId: input.laneId } : {}),
    ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
  };
}

/** Project-owned supervisor events stay internal until the project control layer escalates them. */
export function shouldNotifySupervisorUser(projectId?: string): boolean {
  return !projectId;
}
