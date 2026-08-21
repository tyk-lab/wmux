import { afterEach, describe, expect, it } from 'vitest';
import {
  cachedSupervisorEvidencePage,
  clearSupervisorEvidenceCache,
  createSupervisorEvidenceSnapshot,
  registerSupervisorEvidence,
} from '../../src/renderer/supervisor/evidence';
import { supervisorEvidenceSuggestedRanges } from '../../src/shared/supervisor-evidence';

afterEach(() => clearSupervisorEvidenceCache());

describe('supervisor evidence snapshots', () => {
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
