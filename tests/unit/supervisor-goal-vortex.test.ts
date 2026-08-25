import { describe, expect, it } from 'vitest';
import {
  nextGoalVortexState,
  normalizeExperimentConditions,
  normalizeGoalVortexKind,
  sameGoalVortexCorrection,
} from '../../src/renderer/supervisor/goal-vortex';

describe('supervisor goal vortex', () => {
  const observation = {
    kind: 'single-condition-fixation' as const,
    signal: '任务 AI 反复围绕 0.10A 条件验证，没有形成新的判别证据',
    wastedEffort: '连续两轮重复同一离线资格与同一测试条件',
    missingEvidence: '缺少授权范围内多个电流条件的实际对照结果',
    decisiveNextStep: '执行三个安全范围内电流条件的对照实验',
    authorizationBoundary: 'within-current' as const,
    experimentConditions: ['0.08A', '0.10A', '0.12A'],
    correctionTask: '形成三个电流条件的对照结果和结论',
    evidenceFingerprint: 'evidence-a',
  };

  it('counts the same evidence-backed stall only across distinct task reviews', () => {
    const first = nextGoalVortexState({ ...observation, reviewId: 'r1', workerTurnId: 1, now: 1 });
    const duplicate = nextGoalVortexState({ ...observation, previous: first, reviewId: 'r1', workerTurnId: 1, now: 2 });
    const second = nextGoalVortexState({
      ...observation,
      missingEvidence: '换一种措辞描述同一缺失的多条件对照证据',
      previous: first,
      reviewId: 'r2',
      workerTurnId: 2,
      now: 3,
    });

    expect(first.occurrences).toBe(1);
    expect(first.evidenceFingerprint).toBe('evidence-a');
    expect(duplicate.occurrences).toBe(1);
    expect(second.occurrences).toBe(2);
  });

  it('normalizes bounded experiment matrices and detects repeated corrections', () => {
    expect(normalizeExperimentConditions('0.08A；0.10A;0.12A\n0.12A;0.14A'))
      .toEqual(['0.08A', '0.10A', '0.12A', '0.14A']);
    expect(sameGoalVortexCorrection('执行 三组 对照实验', '执行 三组 对照实验')).toBe(true);
    expect(sameGoalVortexCorrection('继续离线资格', '执行实际对照实验')).toBe(false);
    expect(normalizeGoalVortexKind('missing-real-test')).toBe('missing-real-test');
    expect(normalizeGoalVortexKind('slow-task')).toBeUndefined();
  });
});
