import { v4 as uuid } from 'uuid';
import { useStore } from '../store';
import {
  dedicatedSupervisorSurfaceId,
  isProjectManagedSupervisorLane,
  supervisorLaneControlState,
  type SupervisorDelivery,
} from '../store/supervisor-slice';
import {
  enqueueSupervisorDelivery,
  signalSupervisorDeliveryReady,
} from './delivery';

export interface OrdinarySupervisorControlDeliveryOptions {
  kind?: 'control-message' | 'owner-decision';
  correlationId?: string;
  bootstrapOnRuntimeReady?: boolean;
}

/** Queue ordinary-supervisor control text durably without touching project-managed lanes. */
export function queueOrdinarySupervisorControlDelivery(
  laneId: string,
  text: string,
  options: OrdinarySupervisorControlDeliveryOptions = {},
): SupervisorDelivery | null {
  const store = useStore.getState();
  const lane = store.supervisor.lanes.find((candidate) => candidate.id === laneId);
  if ((!store.supervisor.active && !store.supervisor.paused)
    || !lane
    || isProjectManagedSupervisorLane(lane)
    || supervisorLaneControlState(lane) === 'stopped'
    || !dedicatedSupervisorSurfaceId(lane)
    || !text.trim()) return null;
  const delivery: SupervisorDelivery = {
    id: `ordinary-control-${uuid()}`,
    kind: options.kind || 'control-message',
    task: lane.currentTask || lane.config?.taskGoal || lane.label,
    text: text.trim(),
    createdAt: Date.now(),
    turnId: lane.workerTurnId,
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    ...(options.bootstrapOnRuntimeReady ? { bootstrapOnRuntimeReady: true } : {}),
    stage: 'pending',
  };
  store.updateLane(lane.id, {
    pendingSupervisorDeliveries: enqueueSupervisorDelivery(
      lane.pendingSupervisorDeliveries,
      delivery,
    ),
  });
  signalSupervisorDeliveryReady();
  return delivery;
}
