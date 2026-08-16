import type { ProjectManagerSession } from '../../shared/project-manager';
import type { SupervisorLane } from '../store/supervisor-slice';

/**
 * Match current lanes by project ID. Legacy lanes are accepted only when this
 * project's persisted work item explicitly references their lane ID.
 */
export function projectSupervisorLaneIds(
  session: Pick<ProjectManagerSession, 'id' | 'workItems'>,
  lanes: readonly SupervisorLane[],
): string[] {
  const persistedLaneIds = new Set(
    session.workItems
      .map((item) => item.supervisorLaneId)
      .filter((laneId): laneId is string => !!laneId),
  );
  return lanes
    .filter((lane) => lane.projectManagerProjectId === session.id || (
      !lane.projectManagerProjectId && persistedLaneIds.has(lane.id)
    ))
    .map((lane) => lane.id);
}
