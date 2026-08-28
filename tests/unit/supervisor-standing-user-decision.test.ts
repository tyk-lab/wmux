import { describe, expect, it } from 'vitest';
import {
  activeStandingUserDecisions,
  ordinaryUserDecisionReuseEnabled,
  repeatedStandingUserDecisionError,
  standingUserDecisionFingerprint,
  upsertStandingUserDecision,
} from '../../src/renderer/supervisor/standing-user-decision';

describe('standing user decisions', () => {
  const first = {
    decision: '保持现有 API', subject: '是否改变现有 API',
    subjectFingerprint: standingUserDecisionFingerprint('是否改变现有 API'),
    sourceApprovalId: 'approval-api', updatedAt: 1, planRevision: 2,
  };
  const second = {
    decision: '继续既有安全范围内的实测', subject: '是否继续当前实测',
    subjectFingerprint: standingUserDecisionFingerprint('是否继续当前实测'),
    sourceApprovalId: 'approval-test', updatedAt: 2, planRevision: 2,
  };

  it('persists an explicit ordinary-mode decision by default and allows a one-shot opt-out', () => {
    expect(ordinaryUserDecisionReuseEnabled(undefined)).toBe(true);
    expect(ordinaryUserDecisionReuseEnabled(true)).toBe(true);
    expect(ordinaryUserDecisionReuseEnabled(false)).toBe(false);
  });

  it('keeps multiple subjects and replaces only the same subject', () => {
    const decisions = upsertStandingUserDecision(
      upsertStandingUserDecision([], first),
      second,
    );
    const replaced = upsertStandingUserDecision(decisions, {
      ...first, decision: '保持 API 并补充兼容测试', updatedAt: 3,
    });

    expect(replaced).toHaveLength(2);
    expect(replaced[0].decision).toBe('保持 API 并补充兼容测试');
    expect(activeStandingUserDecisions({ standingUserDecisions: replaced }, 2)).toHaveLength(2);
    expect(activeStandingUserDecisions({ standingUserDecisions: replaced }, 3)).toEqual([]);
  });

  it('rejects only an unchanged high-confidence repeat', () => {
    expect(repeatedStandingUserDecisionError([first], '是否改变现有 API'))
      .toContain('approval-api');
    expect(repeatedStandingUserDecisionError(
      [first],
      '现有 API 的外部范围已经变化，需要重新决定是否改变现有 API',
    )).toBeNull();
  });
});
