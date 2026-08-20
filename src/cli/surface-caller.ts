const CALLER_AWARE_SURFACE_METHODS = new Set([
  'surface.send_text',
  'surface.send_key',
  'supervisor.evidence',
]);

/** Attach the ambient wmux surface so main can enforce supervisor isolation. */
export function withSurfaceCaller(
  method: string,
  params: Record<string, any>,
  callerSurfaceId: string | undefined,
): Record<string, any> {
  if (
    (!CALLER_AWARE_SURFACE_METHODS.has(method) && !method.startsWith('project.'))
    || params.callerSurfaceId !== undefined
    || !callerSurfaceId
  ) {
    return params;
  }
  return { ...params, callerSurfaceId };
}
