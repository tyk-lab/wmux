import { describe, expect, it } from 'vitest';
import {
  formatProjectCompletionAuditDetails,
  formatProjectCompletionCriteria,
  summarizeProjectCompletionCriteria,
} from '../../src/renderer/project-manager/completion-display';

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

  it('summarizes satisfaction separately from pass and fail outcomes', () => {
    const completion = {
      summary: '两个候选均已完成评估', validation: [], completedAt: 1,
      evidence: '阶段级证据说明仍需保留',
      criteria: [{
        criterion: '评估候选 A', status: 'satisfied', result: 'passed', method: 'runtime-test',
        evidence: '候选 A 通过', evidenceRefs: ['runs/a.json'],
      }, {
        criterion: '评估候选 B', status: 'satisfied', result: 'failed', method: 'runtime-test',
        evidence: '候选 B 明确失败', evidenceRefs: ['runs/b.json'],
      }],
    };
    const summary = summarizeProjectCompletionCriteria(completion);

    expect(summary).toBe('完成定义：2 满足；验证结果：1 通过，1 明确失败');
    expect(formatProjectCompletionAuditDetails(completion)).toContain('阶段证据摘要：\n阶段级证据说明仍需保留');
    expect(formatProjectCompletionAuditDetails(completion)).toContain('逐项核验与实际证据：');
    expect(formatProjectCompletionAuditDetails({ ...completion, evidence: undefined }, '工作项证据回退'))
      .toContain('阶段证据摘要：\n工作项证据回退');
  });
});
