import { useStore } from '../store';
import {
  isProjectManagedSupervisorLane,
  supervisorLaneControlState,
  type SupervisorLane,
} from '../store/supervisor-slice';
import { effectiveSupervisorLaneConfig, effectiveSupervisorTaskGoal } from './protocol';
import { appendSupervisorRecord } from './recording';

/** Announce the one-way transition from active review into waiting for a new direction. */
export function announceSupervisorWaitingForDirection(
  previousLane: SupervisorLane,
  reason = '已确认达到停止条件',
): boolean {
  if (supervisorLaneControlState(previousLane) === 'waiting') return false;

  const store = useStore.getState();
  const lane = store.supervisor.lanes.find((candidate) => candidate.id === previousLane.id);
  if (!lane || supervisorLaneControlState(lane) !== 'waiting') return false;

  const config = effectiveSupervisorLaneConfig(lane);
  appendSupervisorRecord(store.supervisor, lane, 'supervisor.waiting-for-direction', {
    reason,
    taskGoal: effectiveSupervisorTaskGoal(lane),
    stopWhen: config.stopWhen,
  });

  // 项目管理模式下，待续由项目管理 AI 消化，不再打扰用户。
  if (isProjectManagedSupervisorLane(lane)) return true;

  const text = `AI 监督通道“${lane.label}”已进入待续；直接在对应 AI 监督终端说明新方案即可继续。`;
  const workspaceId = lane.workspaceId || store.activeWorkspaceId;
  if (workspaceId) store.addNotification({ surfaceId: lane.surfaceId, workspaceId, text });
  window.wmux?.notification?.fire({ surfaceId: lane.surfaceId, title: 'AI 监督待续', text });
  return true;
}
