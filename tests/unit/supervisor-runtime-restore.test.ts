import { describe, expect, it } from 'vitest';
import type { SurfaceId } from '../../src/shared/types';
import {
  ordinarySupervisorRuntimeNeedsRestore,
  ordinarySupervisorRuntimeRestorePatch,
} from '../../src/renderer/supervisor/ordinary-runtime-recovery';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';

function lane(partial: Partial<SupervisorLane> = {}): SupervisorLane {
  return {
    id: 'lane-a',
    managementSessionId: 'management-session-a',
    label: '任务 A',
    surfaceId: 'task-a' as SurfaceId,
    supervisorSurfaceId: 'supervisor-old' as SurfaceId,
    controlState: 'paused',
    awaitingStopCheck: false,
    stopConfirmed: false,
    awaitingReview: true,
    activeReviewId: 'review-a',
    currentTask: '完成成果 A',
    decisions: [{
      ts: 1,
      task: '完成成果 A',
      outcome: 'rework',
      reason: '缺少证据',
      next: '补齐证据',
    }],
    pendingSupervisorDeliveries: [{
      id: 'delivery-a',
      kind: 'owner-decision',
      text: '用户决定继续',
      task: '完成成果 A',
      createdAt: 1,
      stage: 'submitted',
      submittedAt: 2,
      submitAttempts: 1,
    }],
    config: {
      taskGoal: '完成成果 A',
      taskDescription: '实现并验证',
      preconditions: '仓库可用',
      stopWhen: '验收通过',
      stopWhenKind: 'specific',
      planFilePath: '',
    },
    ...partial,
  };
}

describe('ordinary supervisor runtime restore', () => {
  it('detects only the missing ordinary lane among multiple independent lanes', () => {
    const live = new Set(['supervisor-b']);

    expect(ordinarySupervisorRuntimeNeedsRestore(lane(), live)).toBe(true);
    expect(ordinarySupervisorRuntimeNeedsRestore(lane({
      id: 'lane-b',
      surfaceId: 'task-b' as SurfaceId,
      supervisorSurfaceId: 'supervisor-b' as SurfaceId,
    }), live)).toBe(false);
    expect(ordinarySupervisorRuntimeNeedsRestore(lane({
      projectManagerProjectId: 'project-a',
      projectWorkItemId: 'work-a',
    }), live)).toBe(false);
  });

  it('rebinds a new terminal without replacing the management session or lane state', () => {
    const original = lane();
    const restored = {
      ...original,
      ...ordinarySupervisorRuntimeRestorePatch(original, 'supervisor-new' as SurfaceId),
    };

    expect(restored).toMatchObject({
      id: 'lane-a',
      managementSessionId: 'management-session-a',
      surfaceId: 'task-a',
      supervisorSurfaceId: 'supervisor-new',
      controlState: 'paused',
      awaitingReview: true,
      activeReviewId: 'review-a',
      currentTask: '完成成果 A',
      decisions: original.decisions,
      supervisorBriefingStatus: 'pending',
    });
    expect(restored.pendingSupervisorDeliveries).toEqual([
      expect.objectContaining({ id: 'delivery-a', stage: 'pending' }),
    ]);
    expect(restored.pendingSupervisorDeliveries?.[0]).not.toHaveProperty('submittedAt', 2);
  });

  it('rejects project-managed lanes so one project cannot be restored through ordinary mode', () => {
    const projectLane = lane({
      projectManagerProjectId: 'project-a',
      projectWorkItemId: 'work-a',
    });

    expect(() => ordinarySupervisorRuntimeRestorePatch(
      projectLane,
      'supervisor-new' as SurfaceId,
    )).toThrow('项目监督运行时必须由项目控制面恢复');
  });
});
