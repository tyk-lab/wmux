export const SUPERVISOR_AUTONOMY_PERMISSION_VALUES = [
  'same-route-next',
  'technical-choice',
  'route-adjustment',
  'permission-confirm',
] as const;

export type SupervisorAutonomyPermission = typeof SUPERVISOR_AUTONOMY_PERMISSION_VALUES[number];

export const DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS: readonly SupervisorAutonomyPermission[] =
  SUPERVISOR_AUTONOMY_PERMISSION_VALUES;

export const SUPERVISOR_WORK_SCOPE_VALUES = [
  'project',
  'task-files',
  'plan-defined',
] as const;

export type SupervisorWorkScope = typeof SUPERVISOR_WORK_SCOPE_VALUES[number];

export const DEFAULT_SUPERVISOR_WORK_SCOPE: SupervisorWorkScope = 'project';

export const SUPERVISOR_FORBIDDEN_ACTION_VALUES = [
  'new-dependencies',
  'public-api-change',
  'large-refactor',
  'weaken-tests',
  'build-release-config',
  'external-network',
] as const;

export type SupervisorForbiddenAction = typeof SUPERVISOR_FORBIDDEN_ACTION_VALUES[number];

export const DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS: readonly SupervisorForbiddenAction[] = [
  'new-dependencies',
  'public-api-change',
  'large-refactor',
  'weaken-tests',
];

function normalizeSelection<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: readonly T[],
  invalidFallback: readonly T[],
): T[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) return [...invalidFallback];
  const allowedValues = new Set<string>(allowed);
  return [...new Set(value.filter((item): item is T => typeof item === 'string' && allowedValues.has(item)))];
}

export function normalizeSupervisorAutonomyPermissions(value: unknown): SupervisorAutonomyPermission[] {
  return normalizeSelection(
    value,
    SUPERVISOR_AUTONOMY_PERMISSION_VALUES,
    DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS,
    [],
  );
}

export function normalizeSupervisorForbiddenActions(value: unknown): SupervisorForbiddenAction[] {
  if (Array.isArray(value) && value.some((item) =>
    typeof item !== 'string' || !(SUPERVISOR_FORBIDDEN_ACTION_VALUES as readonly string[]).includes(item))) {
    return [...SUPERVISOR_FORBIDDEN_ACTION_VALUES];
  }
  return normalizeSelection(
    value,
    SUPERVISOR_FORBIDDEN_ACTION_VALUES,
    DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS,
    SUPERVISOR_FORBIDDEN_ACTION_VALUES,
  );
}

export function normalizeSupervisorWorkScope(value: unknown): SupervisorWorkScope {
  if (value === undefined) return DEFAULT_SUPERVISOR_WORK_SCOPE;
  return typeof value === 'string' && (SUPERVISOR_WORK_SCOPE_VALUES as readonly string[]).includes(value)
    ? value as SupervisorWorkScope
    : 'task-files';
}
