export type WmuxHookRuntimeContext =
  | { state: 'inactive'; missing: string[] }
  | { state: 'invalid'; missing: string[] }
  | { state: 'ready'; missing: string[] };

/** Global agent hooks are harmless outside wmux, but partial wmux context is an integration fault. */
export function resolveWmuxHookRuntimeContext(
  env: Readonly<Record<string, string | undefined>>,
): WmuxHookRuntimeContext {
  if (env.WMUX_INTEGRATION?.trim() !== '1') return { state: 'inactive', missing: [] };
  const required = ['WMUX_SURFACE_ID', 'WMUX_PIPE', 'WMUX_PIPE_TOKEN'] as const;
  const missing = required.filter((name) => !env[name]?.trim());
  return missing.length > 0
    ? { state: 'invalid', missing }
    : { state: 'ready', missing: [] };
}
