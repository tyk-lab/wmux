import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dialogSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/ProjectManager/ProjectManagerDialog.tsx'),
  'utf8',
);
const stylesSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/styles/supervisor.css'),
  'utf8',
);

describe('project manager action-first layout', () => {
  it('shows current state, supervisor action, next step and progress before audit data', () => {
    expect(dialogSource).toContain('project-manager-dialog__action-card');
    expect(dialogSource).toContain('project-manager-dialog__action-grid');
    expect(dialogSource).toContain('<span>当前状态</span>');
    expect(dialogSource).toContain('<span>监督正在做</span>');
    expect(dialogSource).toContain('<span>下一步</span>');
    expect(dialogSource).toContain('<span>当前进度</span>');
    expect(dialogSource).toContain('查看合同、证据与历史');
    expect(dialogSource).toContain('project-manager-dialog__action-alert');
  });

  it('keeps phase planning and event logs collapsed by default', () => {
    expect(dialogSource).toContain('阶段规划与验收 <span>{currentSubgoals.length} 个阶段 · 按需查看</span>');
    expect(dialogSource).toContain('project-manager-dialog__execution-audit');
    expect(dialogSource).toContain('project-manager-dialog__logs">');
    expect(dialogSource).not.toContain('project-manager-dialog__logs" open');
  });

  it('shows separate start and end timestamps for completed records', () => {
    expect(dialogSource).toContain('<dt>开始时间</dt>');
    expect(dialogSource).toContain('<dt>结束时间</dt>');
    expect(dialogSource).toContain('startedAt={projectStageStartedAt(stageWorkItems)}');
    expect(dialogSource).toContain("compactProjectAlertSummary(item.latestEvidence || item.latestContextSummary || '等待新的执行证据')");
    expect(dialogSource).not.toContain('<dt>完成时间</dt>');
  });

  it('uses responsive action grids and bounded scrolling', () => {
    expect(stylesSource).toContain('.project-manager-dialog__action-grid');
    expect(stylesSource).toContain('max-height: min(52vh, 520px)');
    expect(stylesSource).toContain('.project-manager-dialog__action-audit');
    expect(stylesSource).toContain('@media (max-width: 620px)');
  });
});
