import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const panelSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/Sidebar/SupervisorPanel.tsx'),
  'utf8',
);
const stylesSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/styles/supervisor.css'),
  'utf8',
);

describe('project supervisor card presentation', () => {
  it('keeps the default managed-lane view focused on action and moves contracts to audit details', () => {
    expect(panelSource).toContain('sup-panel__managed-lane-overview');
    expect(panelSource).toContain('sup-panel__managed-action-grid');
    expect(panelSource).toContain('当前成果');
    expect(panelSource).toContain("managedCompletion ? '当前结果' : '当前成果'");
    expect(panelSource).toContain('managedCompletion?.summary');
    expect(panelSource).toContain('任务 AI 状态');
    expect(panelSource).toContain('监督正在做');
    expect(panelSource).toContain('下一步');
    expect(panelSource).toContain('sup-panel__managed-lane-decision');
    expect(panelSource).toContain('compactProjectAlertSummary(decision.reason');
    expect(panelSource).toContain('sup-panel__managed-lane-audit');
    expect(panelSource).toContain('查看合同、权限与运行标识');
    expect(panelSource).toContain('formatProjectCompletionCriteria(managedCompletion)');
    expect(panelSource).not.toContain('监督通道执行路线');
    expect(panelSource).not.toContain('sup-panel__project-plan-list');
    expect(panelSource).not.toContain('停止补充: {laneConfig.taskDescription}');
  });

  it('uses a responsive two-column field grid with readable wrapping', () => {
    expect(stylesSource).toContain('.sup-panel__managed-action-grid');
    expect(stylesSource).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(stylesSource).toContain('.sup-panel__managed-lane-audit dl');
    expect(stylesSource).toContain('overflow-wrap: anywhere');
    expect(stylesSource).toContain('.supervisor-session-pane .sup-panel__managed-action-grid strong');
    expect(stylesSource).toContain('@media (max-width: 720px)');
  });
});
