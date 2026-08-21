export type WmuxHookRuntimeContext =
  | { state: 'inactive'; missing: string[] }
  | { state: 'invalid'; missing: string[] }
  | { state: 'ready'; missing: string[] };

/** Global agent hooks are harmless outside wmux, but partial wmux context is an integration fault. */
export function resolveWmuxHookRuntimeContext(
  env: Readonly<Record<string, string | undefined>>,
): WmuxHookRuntimeContext {
  const required = ['WMUX_SURFACE_ID', 'WMUX_PIPE', 'WMUX_PIPE_TOKEN'] as const;
  const integrationDeclared = env.WMUX_INTEGRATION?.trim() === '1';
  const capabilityDeclared = required.some((name) => !!env[name]?.trim());
  if (!integrationDeclared && !capabilityDeclared) return { state: 'inactive', missing: [] };
  const missing = required.filter((name) => !env[name]?.trim());
  return missing.length > 0
    ? { state: 'invalid', missing }
    : { state: 'ready', missing: [] };
}
