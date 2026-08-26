import { describe, expect, it } from 'vitest';
import {
  normalizeProjectTaskComplexityAssessment,
  normalizeProjectTaskContextResetState,
  projectTaskContextResetFingerprint,
} from '../../src/shared/project-manager';

describe('current project task orchestration', () => {
  it('requires an explicit bounded complexity assessment', () => {
    expect(normalizeProjectTaskComplexityAssessment(undefined, 1)).toBeUndefined();
    expect(normalizeProjectTaskComplexityAssessment({
      complexity: 'high',
      decision: 'split-before-dispatch',
      signals: ['包含多个可独立验收成果', '跨越低耦合模块'],
      rationale: '先拆成独立工作项，避免一个任务 AI 同时维护多条主线',
    }, 10)).toEqual({
      complexity: 'high',
      decision: 'split-before-dispatch',
      signals: ['包含多个可独立验收成果', '跨越低耦合模块'],
      rationale: '先拆成独立工作项，避免一个任务 AI 同时维护多条主线',
      assessedAt: 10,
    });
  });

  it('normalizes durable in-place reset state and keeps a stable pollution fingerprint', () => {
    const fingerprint = projectTaskContextResetFingerprint('task-a', '忘记项目规则', '连续两轮错误落位');
    expect(projectTaskContextResetFingerprint(' task-a ', '忘记项目规则', '连续两轮错误落位')).toBe(fingerprint);
    expect(normalizeProjectTaskContextResetState({
      generation: 2,
      count: 1,
      status: 'republished',
      fingerprint,
      reason: '忘记项目规则',
      evidence: '连续两轮错误落位',
      cleanContext: '保留源码成果，修复产物目录并验证',
      requestedAt: 10,
      completedAt: 20,
    })).toMatchObject({
      generation: 2,
      count: 1,
      status: 'republished',
      fingerprint,
    });
    expect(normalizeProjectTaskContextResetState({
      generation: 3,
      count: 2,
      status: 'republished',
      fingerprint,
      reason: '再次污染',
      evidence: '第二次证据',
      cleanContext: '应交回项目 AI',
      requestedAt: 30,
    })).toBeUndefined();
  });
});
