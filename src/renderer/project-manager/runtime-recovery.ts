export type ManagedProjectRuntimeRole = 'manager' | 'supervisor' | 'task';

/** Replacement lanes share one recovery budget for the same project work item. */
export function managedProjectRuntimeRecoveryKey(options: {
  projectId: string;
  role: ManagedProjectRuntimeRole;
  workItemId?: string;
}): string {
  return `${options.projectId}:${options.role}:${options.workItemId || 'manager'}`;
}

export function canStartManagedProjectRuntimeRecovery(
  recoveryKey: string,
  inFlight: ReadonlySet<string>,
  failed: ReadonlySet<string>,
): boolean {
  return !inFlight.has(recoveryKey) && !failed.has(recoveryKey);
}
