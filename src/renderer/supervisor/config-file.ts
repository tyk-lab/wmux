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

export interface SupervisorTerminalConfigImportPlan<T extends SurfaceBoundSupervisorConfig> {
  configs: T[];
  selectedSurfaceIds: string[];
  templateApplications: number;
}

export type SupervisorWaitingConfigAction = 'retain' | 'resume' | 'finalize';

/** Resolve how applying terminal config affects a lane that already completed into waiting. */
export function supervisorWaitingConfigAction(
  previousControlState: string | undefined,
  waitForNextDirection: boolean,
  briefingChanged: boolean,
): SupervisorWaitingConfigAction {
  if (previousControlState !== 'waiting') return 'retain';
  if (!waitForNextDirection) return 'finalize';
  return briefingChanged ? 'resume' : 'retain';
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

/** Apply imported terminal presets to the terminals the user has currently selected. */
export function planSupervisorTerminalConfigImport<T extends SurfaceBoundSupervisorConfig>(
  configs: readonly T[],
  selectedSurfaceIds: Iterable<string>,
): SupervisorTerminalConfigImportPlan<T> {
  const selected = [...new Set(selectedSurfaceIds)];
  const configBySurfaceId = new Map(configs.map((config) => [config.surfaceId, config]));
  const fallback = configs[0];
  let templateApplications = 0;
  const applied = selected.flatMap((surfaceId) => {
    const exact = configBySurfaceId.get(surfaceId);
    const template = exact || fallback;
    if (!template) return [];
    if (!exact) templateApplications += 1;
    return [{ ...template, surfaceId } as T];
  });
  return {
    configs: applied,
    selectedSurfaceIds: selected,
    templateApplications,
  };
}
