import { describe, expect, it } from 'vitest';
import {
  buildOrdinaryContextRecoveryTask,
  nextOrdinaryContextHealthState,
  normalizeOrdinaryContextSymptoms,
  ordinaryContextClearCommand,
} from '../../src/renderer/supervisor/ordinary-context-health';

describe('ordinary context health', () => {
  it('normalizes only supported degradation symptoms', () => {
    expect(normalizeOrdinaryContextSymptoms('repeated-mistake,forgotten-plan,unknown,repeated-mistake'))
      .toEqual(['repeated-mistake', 'forgotten-plan']);
  });

  it('requires two distinct reviews of the same issue without new evidence', () => {
    const first = nextOrdinaryContextHealthState({
      symptoms: ['repeated-mistake', 'forgotten-plan'],
      signal: '重复已经纠正的错误并遗忘用户规划',
      evidenceFingerprint: 'same-evidence',
      reviewId: 'review-1', workerTurnId: 1, now: 1,
    });
    const duplicate = nextOrdinaryContextHealthState({
      previous: first,
      symptoms: ['forgotten-plan', 'repeated-mistake'],
      signal: '同一审核重复上报',
      evidenceFingerprint: 'same-evidence',
      reviewId: 'review-1', workerTurnId: 1, now: 2,
    });
    const second = nextOrdinaryContextHealthState({
      previous: duplicate,
      symptoms: ['repeated-mistake', 'forgotten-plan'],
      signal: '新任务回合仍重复同类问题',
      evidenceFingerprint: 'same-evidence',
      reviewId: 'review-2', workerTurnId: 2, now: 3,
    });
    const progress = nextOrdinaryContextHealthState({
      previous: second,
      symptoms: ['repeated-mistake', 'forgotten-plan'],
      signal: '已经出现新证据',
      evidenceFingerprint: 'new-evidence',
      reviewId: 'review-3', workerTurnId: 3, now: 4,
    });

    expect(first.occurrences).toBe(1);
    expect(duplicate.occurrences).toBe(1);
    expect(second.occurrences).toBe(2);
    expect(progress.occurrences).toBe(1);
  });

  it('builds a minimal trusted recovery task instead of restoring the old transcript', () => {
    const text = buildOrdinaryContextRecoveryTask({
      config: {
        taskGoal: '交付登录功能', taskDescription: '', preconditions: '',
        stopWhen: '登录测试通过', stopWhenKind: 'concrete', planFilePath: '', planRevision: 3,
        taskWorkMode: 'multi-thread',
      },
      plan: {
        sourceRevision: 3, revision: 2, objective: '交付登录功能', updatedAt: 1,
        milestones: [{
          id: 'api', title: '接口完成', outcome: '形成稳定登录接口',
          acceptance: ['接口可用'], status: 'completed', evidence: '接口测试通过',
        }, {
          id: 'claim-only', title: '只有自报', outcome: '未经证据确认的成果',
          acceptance: ['需要核验'], status: 'completed',
        }],
        remainingWork: ['完成界面联调'],
      },
      dispatch: {
        kind: 'rework', sourceRevision: 3, milestoneId: 'ui', outcome: '完成界面联调',
        constraints: ['保持公共 API'], acceptanceGap: ['登录测试通过'],
        evidenceContext: ['接口测试已经通过'],
      },
    });

    expect(text).toContain('用户规划版本：r3');
    expect(text).toContain('已核验证据：接口测试通过');
    expect(text).not.toContain('未经证据确认的成果');
    expect(text).toContain('自行加载和遵循目标项目适用的 AGENTS、技能与仓库规范');
    expect(text).toContain('不要尝试恢复旧对话、旧实现路线或旧命令');
    expect(text).toContain('不要等待或恢复旧子线程');
  });

  it('uses the native clear command only for supported ordinary task agents', () => {
    expect(ordinaryContextClearCommand('codex')).toBe('/new');
    expect(ordinaryContextClearCommand('kimi')).toBe('/new');
    expect(ordinaryContextClearCommand('grok')).toBe('/new');
    expect(ordinaryContextClearCommand('pi')).toBe('/new');
    expect(ordinaryContextClearCommand('opencode')).toBe('/new');
    expect(ordinaryContextClearCommand('generic')).toBeNull();
  });
});
