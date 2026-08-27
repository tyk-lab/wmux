import type {
  ProjectManagerEvent,
  ProjectManagerSessionStatus,
  ProjectSupervisorTransition,
  ProjectWorkItem,
} from '../../shared/project-manager';

export interface ProjectTransitionActiveBinding {
  laneId: string;
  taskSurfaceId: string;
  assignmentVersion?: number;
}

export interface ProjectTransitionResolutionInput {
  transition: ProjectSupervisorTransition;
  resolution: string;
  sessionStatus: ProjectManagerSessionStatus;
  activeGoalAchieved: boolean;
  userQuestionPending: boolean;
  events: readonly ProjectManagerEvent[];
  workItem?: ProjectWorkItem;
  activeBinding?: ProjectTransitionActiveBinding;
}

export function projectTransitionResolutionError(
  input: ProjectTransitionResolutionInput,
): string | null {
  const {
    transition,
    resolution,
    sessionStatus,
    activeGoalAchieved,
    userQuestionPending,
    events,
    workItem,
    activeBinding,
  } = input;
  if (resolution === 'continued') {
    if (!activeBinding || (workItem && workItem.status !== 'running')) {
      return '交接回执声明已继续，但没有对应的活动监督链和 running 工作项';
    }
    return null;
  }
  if (resolution === 'recovered') {
    const recoveredBinding = !!activeBinding
      && (!workItem || (
        ['waiting-decision', 'running', 'validating'].includes(workItem.status)
        && workItem.supervisorLaneId === activeBinding.laneId
        && workItem.workerSurfaceId === activeBinding.taskSurfaceId
        && typeof workItem.assignmentVersion === 'number'
        && activeBinding.assignmentVersion === workItem.assignmentVersion
      ));
    return recoveredBinding
      ? null
      : '交接回执声明已恢复，但没有对应的活动监督链和已确认任务绑定';
  }
  if (resolution === 'accepted') {
    if (sessionStatus !== 'completed'
      && !activeGoalAchieved
      && (!workItem || !['completed', 'stopped'].includes(workItem.status))) {
      return '交接回执声明已验收，但工作项或当前主目标尚未进入完成状态';
    }
    return null;
  }
  if (resolution === 'paused') {
    return sessionStatus === 'paused' || workItem?.status === 'paused'
      ? null
      : '交接回执声明已暂停，但项目和工作项都没有进入 paused 状态';
  }
  if (resolution === 'escalated') {
    return userQuestionPending
      ? null
      : '交接回执声明已升级用户处理，但当前没有持久化的结构化用户问题';
  }
  const replanEvents = new Set([
    'work-item-created', 'work-item-updated', 'project-definition-updated',
    'project-subgoals-updated', 'project-preconditions-updated', 'supervisor-direction',
  ]);
  const transitionEventIndex = events.findIndex((event) => (
    event.kind === 'supervisor-transition' && event.payload?.transitionId === transition.id
  ));
  const eventsAfterTransition = transitionEventIndex >= 0
    ? events.slice(transitionEventIndex + 1)
    : events.filter((event) => event.ts >= transition.createdAt);
  if (!eventsAfterTransition.some((event) => replanEvents.has(event.kind))) {
    return '交接回执声明已重规划，但交接创建后没有工作项、阶段、目标或任务方向变更';
  }
  const repeatedEvidenceReplan = !!transition.replanBaselineFingerprint && events.some((event) => (
    event.kind === 'supervisor-transition-acknowledged'
    && event.workItemId === transition.workItemId
    && event.payload?.resolution === 'replanned'
    && event.payload?.replanBaselineFingerprint === transition.replanBaselineFingerprint
  ));
  return repeatedEvidenceReplan
    ? '同一工作项在相同证据与拓扑状态下已经重规划过一次；不能通过改写任务措辞再次派发。请暂停、升级真实用户前提、推进独立工作项，或等待新的代码、测试、错误或已核验证据'
    : null;
}
