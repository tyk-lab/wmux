import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../src/renderer/store';
import {
  createDefaultSupervisorSession,
  type SupervisorLane,
  type SupervisorSession,
} from '../../src/renderer/store/supervisor-slice';
import { queueOrdinarySupervisorControlDelivery } from '../../src/renderer/supervisor/ordinary-control-delivery';

function lane(partial: Partial<SupervisorLane> = {}): SupervisorLane {
  return {
    id: 'lane-ordinary', label: '任务终端', surfaceId: 'worker-a' as any,
    supervisorSurfaceId: 'supervisor-a' as any,
    controlState: 'active', awaitingStopCheck: false, stopConfirmed: false,
    currentTask: '完成认证成果', decisions: [], pendingSupervisorDeliveries: [],
    config: {
      taskGoal: '完成认证成果', taskDescription: '', preconditions: '', supervisorNotes: '',
      stopWhen: '认证测试通过', stopWhenKind: 'concrete', planFilePath: '', planRevision: 1,
    },
    ...partial,
  };
}

describe('ordinary supervisor control delivery', () => {
  let originalSupervisor: SupervisorSession;

  beforeEach(() => {
    originalSupervisor = useStore.getState().supervisor;
    useStore.setState({
      supervisor: {
        ...createDefaultSupervisorSession(),
        active: true,
        sessionId: 'ordinary-session',
        lanes: [lane()],
      },
    });
  });

  afterEach(() => {
    useStore.setState({ supervisor: originalSupervisor });
  });

  it('keeps an owner decision queued until the ordinary supervisor acknowledges it', () => {
    const delivery = queueOrdinarySupervisorControlDelivery('lane-ordinary', '沿用用户决定继续', {
      kind: 'owner-decision', correlationId: 'approval-a',
    });

    expect(delivery).toMatchObject({
      kind: 'owner-decision', correlationId: 'approval-a', stage: 'pending',
    });
    expect(useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries)
      .toEqual([expect.objectContaining({ id: delivery!.id, stage: 'pending' })]);
  });

  it('never writes ordinary control messages into a project-managed lane', () => {
    useStore.setState({
      supervisor: {
        ...useStore.getState().supervisor,
        lanes: [lane({ projectManagerProjectId: 'project-a', projectWorkItemId: 'work-a' })],
      },
    });

    expect(queueOrdinarySupervisorControlDelivery('lane-ordinary', '普通监督消息')).toBeNull();
    expect(useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries).toEqual([]);
  });
});
