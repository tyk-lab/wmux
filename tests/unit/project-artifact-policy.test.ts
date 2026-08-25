import { describe, expect, it } from 'vitest';
import {
  projectArtifactLocationViolation,
  projectProgressDocumentViolation,
} from '../../src/shared/project-artifact-policy';

describe('project artifact policy', () => {
  it('keeps the project-plans root reserved for PROGRESS.md', () => {
    expect(projectArtifactLocationViolation('.project-plans/PROGRESS.md')).toBeNull();
    expect(projectArtifactLocationViolation('.project-plans/debug/topic/report.md')).toBeNull();
    expect(projectArtifactLocationViolation('.project-plans/archive/legacy/telemetry.json')).toBeNull();
    expect(projectArtifactLocationViolation('.project-plans/plans/telemetry.json')).toContain('不能保存实际运行事实');
    expect(projectArtifactLocationViolation('.project-plans/qualification-conclusion.md'))
      .toContain('根目录只允许 PROGRESS.md');
  });

  it('routes runtime facts to a dated run directory', () => {
    expect(projectArtifactLocationViolation('runs/2026-08-25/run-a/telemetry.json')).toBeNull();
    expect(projectArtifactLocationViolation('run_templates/telemetry.json')).toContain('模板目录');
    expect(projectArtifactLocationViolation('tests/results.json')).toContain('源码和测试目录');
    expect(projectArtifactLocationViolation('tests/fixtures/data.json')).toBeNull();
    expect(projectArtifactLocationViolation('src/data.json')).toBeNull();
  });

  it('rejects an accumulated progress document', () => {
    const content = ['# 进度', '## 当前任务', '- 当前项', '## 追加记录'].join('\n');
    expect(projectProgressDocumentViolation(content)).toContain('追加/补充');
  });
});
