export const TASK_WORK_MODE_VALUES = ['single-thread', 'multi-thread'] as const;
export type TaskWorkMode = typeof TASK_WORK_MODE_VALUES[number];

export const MAX_TASK_CHILD_THREADS = 3;
export const MAX_TASK_THREAD_RESPONSIBILITY_LENGTH = 4000;

export function normalizeTaskWorkMode(value: unknown): TaskWorkMode {
  return value === 'multi-thread' ? 'multi-thread' : 'single-thread';
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
