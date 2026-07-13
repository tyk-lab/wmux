const PSMUX_NAMESPACE_MAX_LENGTH = 80;

/** Returns a deterministic, command-safe psmux server namespace for one Surface. */
export function getPsmuxNamespace(surfaceId: string | undefined): string | undefined {
  if (!surfaceId) return undefined;
  const namespace = surfaceId
    .replace(/[^A-Za-z0-9_.-]/gu, '-')
    .slice(0, PSMUX_NAMESPACE_MAX_LENGTH);
  return namespace || undefined;
}

export function withPsmuxNamespace(namespace: string | undefined, args: string[]): string[] {
  return namespace ? ['-L', namespace, ...args] : args;
}
