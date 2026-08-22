import { describe, expect, it } from 'vitest';
import { formatProjectCompletionCriteria } from '../../src/renderer/project-manager/completion-display';

describe('project completion display', () => {
  it('distinguishes criterion satisfaction, failed test outcome, method, and hashed evidence', () => {
    const text = formatProjectCompletionCriteria({
      summary: '候选已评估', validation: [], completedAt: 1,
      criteria: [{
        criterion: '执行并评估候选实机测试',
        status: 'satisfied',
        result: 'failed',
        method: 'runtime-test',
        evidence: '性能阈值明确失败，因此不采用该候选',
        evidenceRefs: ['runs/run-1/result.json'],
        evidenceArtifacts: [{
          ref: 'runs/run-1/result.json', sizeBytes: 42, mtimeMs: 1, sha256: 'a'.repeat(64),
        }],
      }],
    });

    expect(text).toContain('条件已满足');
    expect(text).toContain('结果明确失败');
    expect(text).toContain('实际运行/实机测试');
    expect(text).toContain('runs/run-1/result.json');
    expect(text).toContain('sha256:aaaaaaaaaaaa…');
  });
});
