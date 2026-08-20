import { afterEach, describe, expect, it } from 'vitest';
import {
  cachedSupervisorEvidencePage,
  clearSupervisorEvidenceCache,
  createSupervisorEvidenceSnapshot,
  registerSupervisorEvidence,
} from '../../src/renderer/supervisor/evidence';

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
});
