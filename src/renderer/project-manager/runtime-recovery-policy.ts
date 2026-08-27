export interface ProjectManagerRuntimeProbe {
  managerPresent: boolean;
  runtimeState?: string;
  shellFailure: boolean;
  ptyPresent?: boolean;
}

/** Semantic stalls reuse a live manager; only an unavailable runtime may be rebuilt. */
export function shouldRestartProjectManagerRuntime(probe: ProjectManagerRuntimeProbe): boolean {
  return !probe.managerPresent
    || probe.runtimeState === 'failed'
    || probe.runtimeState === 'exited'
    || probe.shellFailure
    || probe.ptyPresent === false;
}
