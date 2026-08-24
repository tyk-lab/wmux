import { afterEach, describe, expect, it } from 'vitest';
import {
  cachedSupervisorEvidencePage,
  clearSupervisorEvidenceCache,
  createSupervisorEvidenceSnapshot,
  latestCachedSupervisorEvidence,
  mergeSupervisorLifecycleEvidence,
  registerSupervisorEvidence,
  supervisorEvidenceBufferRewound,
  supervisorEvidenceContextDiscontinuity,
  supervisorEvidenceContinuity,
} from '../../src/renderer/supervisor/evidence';
import { supervisorEvidenceSuggestedRanges } from '../../src/shared/supervisor-evidence';

afterEach(() => clearSupervisorEvidenceCache());

describe('supervisor evidence snapshots', () => {
  it('keeps the authoritative Stop Hook answer ahead of a stale terminal screen', () => {
    const merged = mergeSupervisorLifecycleEvidence({
      lifecycleMessage: 'P170 正向正式运行失败；已 safe-stop，身份已消费。',
      terminalSummary: '旧 recover 批次仍在准备中。',
      terminalText: '历史终端回卷：recover candidate',
    });

    expect(merged.summary).toContain('[Agent 结束 Hook 最终消息]\nP170 正向正式运行失败');
    expect(merged.summary).toContain('[终端屏幕摘要]\n旧 recover 批次');
    expect(merged.text).toContain('P170 正向正式运行失败');
    expect(merged.text).toContain('历史终端回卷：recover candidate');
  });

  it('binds immutable evidence to one session, review and task terminal', () => {
    const snapshot = createSupervisorEvidenceSnapshot({
      sessionId: 'sup-1',
      reviewId: 'review-1',
      laneId: 'lane-1',
      surfaceId: 'worker-a',
      isolationScope: 'ordinary',
      task: '修复登录',
      bufferType: 'normal',
      bufferLines: 4,
      capturedLines: 4,
      summary: '测试通过',
      text: ['第一行', '第二行', '第三行', '第四行'].join('\n'),
    });
    registerSupervisorEvidence(snapshot);

    expect(cachedSupervisorEvidencePage('sup-1', 'review-1', 'worker-a', 'ordinary', 2, 2))
      .toMatchObject({
        reviewId: 'review-1',
        surfaceId: 'worker-a',
        page: 2,
        totalPages: 2,
        hasMore: false,
        text: '第三行\n第四行',
      });
    expect(cachedSupervisorEvidencePage('sup-1', 'review-1', 'worker-b', 'ordinary', 1, 2))
      .toBeUndefined();
    expect(cachedSupervisorEvidencePage('sup-1', 'review-other', 'worker-a', 'ordinary', 1, 2))
      .toBeUndefined();
    expect(cachedSupervisorEvidencePage('sup-1', 'review-1', 'worker-a', 'project', 1, 2))
      .toBeUndefined();
  });

  it('marks alternate-screen evidence as incomplete even when the visible frame fits', () => {
    const snapshot = createSupervisorEvidenceSnapshot({
      sessionId: 'sup-1',
      reviewId: 'review-alt',
      laneId: 'lane-1',
      surfaceId: 'worker-a',
      isolationScope: 'ordinary',
      task: '长任务',
      bufferType: 'alternate',
      bufferLines: 30,
      capturedLines: 30,
      summary: '当前可见最终回答',
      text: '当前可见最终回答',
    });

    expect(snapshot).toMatchObject({ bufferType: 'alternate', truncated: true });
  });

  it('detects a material TUI buffer rewind and keeps the pre-rewind review as the authority anchor', () => {
    const beforeRewind = createSupervisorEvidenceSnapshot({
      sessionId: 'sup-1', reviewId: 'review-b3', laneId: 'lane-1', surfaceId: 'worker-a',
      isolationScope: 'project', task: '执行 B3-positive', workerTurnId: 7,
      bufferType: 'normal', bufferLines: 1_619, capturedLines: 1_619,
      summary: 'B3-positive 已执行并 consumed/pass', text: 'B3 immutable evidence',
    });
    registerSupervisorEvidence(beforeRewind);
    const previous = latestCachedSupervisorEvidence('sup-1', 'lane-1', 'worker-a', 'project');
    const rewoundBuffer = { bufferType: 'normal' as const, bufferLines: 928, capturedLines: 928 };

    expect(previous).toBe(beforeRewind);
    expect(supervisorEvidenceBufferRewound(beforeRewind, rewoundBuffer)).toBe(true);
    expect(supervisorEvidenceBufferRewound(beforeRewind, {
      bufferType: 'normal', bufferLines: 1_580, capturedLines: 1_580,
    })).toBe(false);
    expect(supervisorEvidenceContinuity(previous, rewoundBuffer)).toEqual({
      previousReviewId: 'review-b3',
      continuityAnchorReviewId: 'review-b3',
      contextContinuity: 'rewound',
      contextDiscontinuityReason: 'buffer-rewind',
      previousBufferLines: 1_619,
    });

    const afterRewind = createSupervisorEvidenceSnapshot({
      sessionId: 'sup-1', reviewId: 'review-recovery', laneId: 'lane-1', surfaceId: 'worker-a',
      isolationScope: 'project', task: '只读恢复 B3 证据', workerTurnId: 8,
      bufferType: 'normal', bufferLines: 928, capturedLines: 928,
      summary: '当前屏幕显示旧 B1', text: 'stale B1 screen',
      ...supervisorEvidenceContinuity(previous, rewoundBuffer),
    });
    registerSupervisorEvidence(afterRewind);
    expect(supervisorEvidenceContinuity(afterRewind, {
      bufferType: 'normal', bufferLines: 1_100, capturedLines: 1_100,
    })).toMatchObject({
      previousReviewId: 'review-recovery',
      continuityAnchorReviewId: 'review-b3',
      contextContinuity: 'rewound',
    });
    expect(cachedSupervisorEvidencePage('sup-1', 'review-recovery', 'worker-a', 'project'))
      .toMatchObject({
        workerTurnId: 8,
        previousReviewId: 'review-b3',
        continuityAnchorReviewId: 'review-b3',
        contextContinuity: 'rewound',
        contextDiscontinuityReason: 'buffer-rewind',
      });
  });

  it.each([
    ['Codex', 640, 300],
    ['Kimi', 1_619, 928],
  ])('anchors %s normal-buffer evidence after a material rewind', (_agent, before, after) => {
    const previous = createSupervisorEvidenceSnapshot({
      sessionId: 'sup-agents', reviewId: `review-${_agent}`, laneId: 'lane-1',
      surfaceId: `worker-${_agent}`, isolationScope: 'project', task: '执行一次性任务',
      bufferType: 'normal', bufferLines: before, capturedLines: before,
      summary: '执行完成', text: 'immutable result',
    });
    const current = { bufferType: 'normal' as const, bufferLines: after, capturedLines: after };

    expect(supervisorEvidenceContextDiscontinuity(previous, current)).toBe('buffer-rewind');
    expect(supervisorEvidenceContinuity(previous, current)).toMatchObject({
      contextContinuity: 'rewound',
      contextDiscontinuityReason: 'buffer-rewind',
      continuityAnchorReviewId: `review-${_agent}`,
    });
  });

  it('anchors Grok evidence when alternate-screen repaints without shrinking line counts', () => {
    const previous = createSupervisorEvidenceSnapshot({
      sessionId: 'sup-grok', reviewId: 'review-grok-result', laneId: 'lane-1',
      surfaceId: 'worker-grok', isolationScope: 'project', task: '执行一次性任务',
      bufferType: 'alternate', bufferLines: 40, capturedLines: 40,
      summary: '执行完成', text: 'Grok immutable result',
    });
    const repaint = { bufferType: 'alternate' as const, bufferLines: 40, capturedLines: 40 };

    expect(supervisorEvidenceBufferRewound(previous, repaint)).toBe(false);
    expect(supervisorEvidenceContextDiscontinuity(previous, repaint)).toBe('alternate-repaint');
    expect(supervisorEvidenceContinuity(previous, repaint)).toEqual({
      previousReviewId: 'review-grok-result',
      continuityAnchorReviewId: 'review-grok-result',
      contextContinuity: 'rewound',
      contextDiscontinuityReason: 'alternate-repaint',
      previousBufferLines: 40,
    });
  });

  it('keeps the result head and tail while compacting only the inline summary', () => {
    const fullSummary = `完成：已修改核心逻辑。${'中间执行细节。'.repeat(300)}剩余：无；验证：定向测试通过。`;
    const evidenceText = `完整终端证据\n${'证据行\n'.repeat(500)}`;
    const snapshot = createSupervisorEvidenceSnapshot({
      sessionId: 'sup-1',
      reviewId: 'review-long-summary',
      laneId: 'lane-1',
      surfaceId: 'worker-a',
      isolationScope: 'project',
      task: '压缩跨角色消息',
      bufferType: 'normal',
      bufferLines: 501,
      capturedLines: 501,
      summary: fullSummary,
      text: evidenceText,
    });

    expect(snapshot.summary.length).toBeLessThanOrEqual(1_200);
    expect(snapshot.summary).toContain('完成：已修改核心逻辑');
    expect(snapshot.summary).toContain('摘要已压缩');
    expect(snapshot.summary).toContain('剩余：无；验证：定向测试通过。');
    expect(snapshot.text).toBe(evidenceText.trim());
  });

  it('suggests bounded diagnostic, validation and tail ranges for file inspection', () => {
    const lines = Array.from({ length: 180 }, (_, index) => `日志 ${index + 1}`);
    lines[79] = '测试通过：42/42';
    lines[149] = 'Error: final validation mismatch';

    expect(supervisorEvidenceSuggestedRanges(lines.join('\n'))).toEqual([
      { startLine: 144, endLine: 156, reason: 'diagnostic' },
      { startLine: 74, endLine: 86, reason: 'validation' },
      { startLine: 61, endLine: 180, reason: 'tail' },
    ]);
  });
});
