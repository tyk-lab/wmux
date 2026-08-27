import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../src/renderer/store';
import { notificationDedupeKey } from '../../src/renderer/notification-policy';
import { resumeWaitingLaneFromSupervisorInput } from '../../src/renderer/supervisor/user-input-precedence';
import {
  createDefaultSupervisorSession,
  type SupervisorLane,
  type SupervisorSession,
} from '../../src/renderer/store/supervisor-slice';
import type { ProjectManagerSession } from '../../src/shared/project-manager';

function waitingLane(): SupervisorLane {
  return {
    id: 'lane-waiting',
    label: '普通任务',
    surfaceId: 'worker-waiting' as any,
    supervisorSurfaceId: 'supervisor-waiting' as any,
    controlState: 'waiting',
    awaitingStopCheck: false,
    stopConfirmed: true,
    awaitingReview: false,
    decisions: [],
    pendingSupervisorDeliveries: [],
  };
}

describe('project and supervisor notification lifecycle', () => {
  let originalProjectManager: ProjectManagerSession | null;
  let originalProjectManagers: ProjectManagerSession[];
  let originalSelectedProjectManagerId: string | null;
  let originalSupervisor: SupervisorSession;
  let originalNotifications: ReturnType<typeof useStore.getState>['notifications'];

  beforeEach(() => {
    const state = useStore.getState();
    originalProjectManager = state.projectManager;
    originalProjectManagers = state.projectManagers;
    originalSelectedProjectManagerId = state.selectedProjectManagerId;
    originalSupervisor = state.supervisor;
    originalNotifications = state.notifications;
    useStore.setState({
      projectManager: null,
      projectManagers: [],
      selectedProjectManagerId: null,
      notifications: [],
      supervisor: createDefaultSupervisorSession(),
    });
  });

  afterEach(() => {
    useStore.setState({
      projectManager: originalProjectManager,
      projectManagers: originalProjectManagers,
      selectedProjectManagerId: originalSelectedProjectManagerId,
      supervisor: originalSupervisor,
      notifications: originalNotifications,
    });
  });

  it('marks resolved project alerts read while retaining unrelated alerts', () => {
    const project = useStore.getState().startProjectManager({
      projectDir: 'E:\\notification-lifecycle',
      goal: '验证通知恢复',
      doneWhen: ['通知状态一致'],
    });
    const runtimeKey = notificationDedupeKey('project', project.id, 'manager-runtime-failed');
    const quiesceKey = notificationDedupeKey('project', project.id, 'requirements-quiesce-failed');
    useStore.getState().addNotification({
      surfaceId: 'manager-surface' as any,
      workspaceId: 'workspace-a' as any,
      title: '项目运行异常',
      text: '项目 AI 运行时失败',
      owner: 'project',
      severity: 'error',
      action: 'open-project-manager',
      projectId: project.id,
      dedupeKey: runtimeKey,
    });
    useStore.getState().addNotification({
      surfaceId: 'manager-surface' as any,
      workspaceId: 'workspace-a' as any,
      title: '需求停机失败',
      text: '旧任务尚未停止',
      owner: 'project',
      severity: 'error',
      action: 'open-project-manager',
      projectId: project.id,
      dedupeKey: quiesceKey,
    });

    useStore.getState().appendProjectManagerEvent({
      kind: 'manager-runtime-restarted',
      summary: '项目 AI 运行时已恢复',
    }, project.id);

    const notifications = useStore.getState().notifications;
    expect(notifications.find((item) => item.dedupeKey === runtimeKey)?.read).toBe(true);
    expect(notifications.find((item) => item.dedupeKey === quiesceKey)?.read).toBe(false);
  });

  it('resolves all previous project alerts before a normal terminal stop', () => {
    const project = useStore.getState().startProjectManager({
      projectDir: 'E:\\notification-stop',
      goal: '验证正常停止',
      doneWhen: ['停止分类正确'],
    });
    const alertKey = notificationDedupeKey('project', project.id, 'task-runtime-failed');
    useStore.getState().addNotification({
      surfaceId: 'manager-surface' as any,
      workspaceId: 'workspace-a' as any,
      text: '任务运行时失败',
      owner: 'project',
      severity: 'error',
      projectId: project.id,
      dedupeKey: alertKey,
    });

    const result = useStore.getState().applyProjectManagerAction({
      type: 'stop-project',
      reason: '按计划结束项目',
      stopKind: 'planned-close',
    }, project.id);

    expect(result).toMatchObject({
      ok: true,
      event: { payload: { stopKind: 'planned-close', emergency: false } },
    });
    expect(useStore.getState().notifications.find((item) => item.dedupeKey === alertKey)?.read).toBe(true);
  });

  it('keeps emergency stop classification safety-first', () => {
    const project = useStore.getState().startProjectManager({
      projectDir: 'E:\\notification-emergency-stop',
      goal: '验证紧急停止',
      doneWhen: ['停止分类不可降级'],
    });

    const result = useStore.getState().applyProjectManagerAction({
      type: 'stop-project',
      reason: '紧急停止',
      emergency: true,
      stopKind: 'planned-close',
    }, project.id);

    expect(result).toMatchObject({
      ok: true,
      event: { payload: { stopKind: 'safety-stop', emergency: true } },
    });
  });

  it('marks an ordinary waiting notification read when the lane resumes', () => {
    const lane = waitingLane();
    const supervisor = {
      ...createDefaultSupervisorSession(),
      active: true,
      sessionId: 'ordinary-waiting',
      lanes: [lane],
    };
    useStore.setState({ supervisor });
    const waitingKey = notificationDedupeKey('supervisor', lane.id, 'waiting-for-direction');
    useStore.getState().addNotification({
      surfaceId: lane.supervisorSurfaceId as any,
      workspaceId: 'workspace-a' as any,
      text: '监督通道等待下一步',
      owner: 'supervisor',
      severity: 'attention',
      laneId: lane.id,
      dedupeKey: waitingKey,
    });

    expect(resumeWaitingLaneFromSupervisorInput(supervisor, lane, 'remote-supervisor-message')).toBe(true);

    expect(useStore.getState().supervisor.lanes[0].controlState).toBe('active');
    expect(useStore.getState().notifications.find((item) => item.dedupeKey === waitingKey)?.read).toBe(true);
  });
});
