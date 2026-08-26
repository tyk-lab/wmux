import type { SupervisorLane } from '../store/supervisor-slice';
import {
  isProjectManagedSupervisorLane,
  supervisorLaneControlState,
} from '../store/supervisor-slice';
import { managedAgentDeadlinePolicy } from '../project-manager/liveness';

/** Ordinary lanes use task-only deadlines and never enter project runtime recovery. */
export function ordinaryWorkerWatchdogCandidate(
  lane: SupervisorLane | undefined,
  surfaceId: string,
): lane is SupervisorLane {
  return !!lane
    && lane.surfaceId === surfaceId
    && !isProjectManagedSupervisorLane(lane)
    && supervisorLaneControlState(lane) === 'active'
    && !!lane.supervisorSurfaceId;
}

export function ordinaryWorkerWatchdogPolicy() {
  return managedAgentDeadlinePolicy({ role: 'task', reasoningEffort: 'medium' });
}
