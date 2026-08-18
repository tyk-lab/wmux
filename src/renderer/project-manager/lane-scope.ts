import type { SupervisorLane } from '../store/supervisor-slice';

/** Match current lanes only by their explicit project identity. */
export function projectSupervisorLaneIds(
  session: { id: string },
  lanes: readonly SupervisorLane[],
): string[] {
  return lanes
    .filter((lane) => lane.projectManagerProjectId === session.id)
    .map((lane) => lane.id);
}
