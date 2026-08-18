export const TASK_WORK_MODE_VALUES = ['single-thread', 'multi-thread', 'adaptive'] as const;
export type TaskWorkMode = typeof TASK_WORK_MODE_VALUES[number];

export const MAX_TASK_CHILD_THREADS = 3;
export const MAX_TASK_THREAD_RESPONSIBILITY_LENGTH = 4000;
export const MAX_TASK_OPERATION_BOUNDARIES = 20;

export function normalizeTaskWorkMode(value: unknown): TaskWorkMode {
  return value === 'multi-thread' || value === 'adaptive' ? value : 'single-thread';
}

export function normalizeTaskThreadResponsibility(value: unknown): string {
  return typeof value === 'string'
    ? value.slice(0, MAX_TASK_THREAD_RESPONSIBILITY_LENGTH)
    : '';
}

export function normalizeTaskChildThreadResponsibilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_TASK_CHILD_THREADS)
    .map(normalizeTaskThreadResponsibility);
}

export function normalizeTaskMaxChildThreads(
  value: unknown,
  fallback = MAX_TASK_CHILD_THREADS,
): number {
  const normalizedFallback = Math.max(1, Math.min(MAX_TASK_CHILD_THREADS, Math.trunc(fallback)));
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric)) return normalizedFallback;
  return Math.max(1, Math.min(MAX_TASK_CHILD_THREADS, numeric));
}

export function normalizeTaskOperationBoundaries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_TASK_OPERATION_BOUNDARIES)
    .map(normalizeTaskThreadResponsibility)
    .map((item) => item.trim())
    .filter(Boolean);
}
