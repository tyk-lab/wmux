import type { SurfaceId } from '../../shared/types';
import {
  isProjectManagedSupervisorLane,
  supervisorLaneControlState,
  type SupervisorLane,
} from '../store/supervisor-slice';

export function ordinarySupervisorRuntimeNeedsRestore(
  lane: SupervisorLane,
  liveSurfaceIds: ReadonlySet<string>,
): boolean {
  if (isProjectManagedSupervisorLane(lane) || supervisorLaneControlState(lane) === 'stopped') {
    return false;
  }
  return !lane.supervisorSurfaceId
    || !liveSurfaceIds.has(lane.supervisorSurfaceId)
    || lane.supervisorProblem?.kind === 'runtime-failed';
}

/**
 * Rebind only the disposable supervisor runtime. The lane and its durable control-plane
 * state remain authoritative; deliveries that may have died with the old terminal are retried.
 */
export function ordinarySupervisorRuntimeRestorePatch(
  lane: SupervisorLane,
  supervisorSurfaceId: SurfaceId,
): Partial<SupervisorLane> {
  if (isProjectManagedSupervisorLane(lane)) {
    throw new Error('项目监督运行时必须由项目控制面恢复');
  }
  return {
    supervisorSurfaceId,
    supervisorBriefingStatus: 'pending',
    supervisorBriefingConfirmedAt: undefined,
    pendingSupervisorDeliveries: (lane.pendingSupervisorDeliveries || []).map((delivery) => (
      delivery.stage === 'pending'
        ? delivery
        : {
            ...delivery,
            stage: 'pending' as const,
            submittedAt: undefined,
            submitAttempts: undefined,
          }
    )),
  };
}
