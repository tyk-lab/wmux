export function normalizeSupervisorRuntimeIsolationKey(value: string): string {
  const normalized = value.trim().replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80);
  if (!normalized || normalized === '.' || normalized === '..') return 'default';
  return normalized;
}
