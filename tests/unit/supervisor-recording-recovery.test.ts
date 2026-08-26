import { afterEach, describe, expect, it } from 'vitest';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';
import { restoreSelectedLaneHistory } from '../../src/renderer/supervisor/recording';

const lane: SupervisorLane = {
  id: 'lane-a', label: '任务 AI', surfaceId: 'worker-a' as any,
  supervisorSurfaceId: 'supervisor-a' as any,
  projectDir: 'E:\\repo', controlState: 'active', awaitingStopCheck: false, stopConfirmed: false,
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('ordinary supervisor snapshot restoration', () => {
  it('restores user authority and per-plan reset safety counters', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        wmux: {
          supervisor: {
            readRecoverySnapshot: async () => ({
              ok: true,
              snapshot: {
                snapshotId: 'snapshot-a', savedAt: 10,
                supervisor: {
                  launchCmd: 'pi', model: '', reasoningEffort: 'medium', autonomous: false,
                  autonomyPermissions: [], forbiddenActions: [], workScope: 'project',
                  config: {
                    taskGoal: '完成认证', taskDescription: '', preconditions: '', supervisorNotes: '',
                    stopWhen: '认证通过', stopWhenKind: 'concrete', planFilePath: '', planRevision: 3,
                  },
                  state: {
                    currentTask: '完成认证', workerTurnId: 4, decisions: [],
                    ordinaryContextResetCount: 1, ordinaryContextResetPlanRevision: 3,
                    latestSupervisorUserGuidance: {
                      text: '保持现有 API', updatedAt: 9, planRevision: 3,
                    },
                    standingUserDecisions: [{
                      decision: '保持现有 API', subject: '是否改变 API',
                      sourceApprovalId: 'approval-api', updatedAt: 9, planRevision: 3,
                    }],
                  },
                },
                terminal: { label: '任务 AI' },
                projectContext: { verifiedEvidence: [], acceptanceGaps: [] },
              },
            }),
          },
        },
      },
    });

    const restored = await restoreSelectedLaneHistory(lane, {
      snapshotId: 'snapshot-a', surfaceId: 'worker-a', label: '任务 AI', sessionId: 'snapshot-a',
    });

    expect(restored).toMatchObject({
      ordinaryContextResetCount: 1,
      ordinaryContextResetPlanRevision: 3,
      latestSupervisorUserGuidance: { text: '保持现有 API', planRevision: 3 },
      standingUserDecisions: [expect.objectContaining({ sourceApprovalId: 'approval-api' })],
    });
  });
});
