export interface SurfaceBoundSupervisorConfig {
  surfaceId: string;
  planFilePath?: string;
  autonomyPermissionsOverride?: unknown;
  autonomousOverride?: boolean;
  forbiddenActionsOverride?: unknown;
}

export interface MatchedSupervisorTerminalConfigs<T extends SurfaceBoundSupervisorConfig> {
  configs: T[];
  skipped: number;
}

export interface SupervisorTerminalConfigImportPlan<T extends SurfaceBoundSupervisorConfig>
  extends MatchedSupervisorTerminalConfigs<T> {
  selectedSurfaceIds: string[];
}

/** Import only terminal presets whose original terminal still exists. */
export function matchExistingSupervisorTerminalConfigs<T extends SurfaceBoundSupervisorConfig>(
  configs: readonly T[],
  existingSurfaceIds: Iterable<string>,
): MatchedSupervisorTerminalConfigs<T> {
  const existing = new Set(existingSurfaceIds);
  const matched = configs.filter((config) => existing.has(config.surfaceId));
  return {
    configs: matched,
    skipped: configs.length - matched.length,
  };
}

/** Retained supervision lanes stay selected even when an imported file omits them. */
export function planSupervisorTerminalConfigImport<T extends SurfaceBoundSupervisorConfig>(
  configs: readonly T[],
  existingSurfaceIds: Iterable<string>,
  retainedSurfaceIds: Iterable<string> = [],
): SupervisorTerminalConfigImportPlan<T> {
  const matched = matchExistingSupervisorTerminalConfigs(configs, existingSurfaceIds);
  return {
    ...matched,
    selectedSurfaceIds: [...new Set([
      ...retainedSurfaceIds,
      ...matched.configs.map((config) => config.surfaceId),
    ])],
  };
}
