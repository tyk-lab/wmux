import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sidebarSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/Sidebar/ProjectManagerPanel.tsx'),
  'utf8',
);
const dialogSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/ProjectManager/ProjectManagerDialog.tsx'),
  'utf8',
);
const stylesSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/styles/supervisor.css'),
  'utf8',
);

describe('project goal completion presentation', () => {
  it('renders an achieved goal as a completion notice instead of a failure alert', () => {
    expect(sidebarSource).toContain("const goalCompletionNotice = activeAlert?.kind === 'project-goal-completed'");
    expect(sidebarSource).toContain("data-kind={goalCompletionNotice ? 'completion' : 'alert'}");
    expect(sidebarSource).toContain("goalCompletionNotice ? '✓ 目标已完成' : '项目告警'");
    expect(sidebarSource).toContain("goalCompletionNotice ? '等待下一主目标' : activeAlert ? '需要处理' : currentGoal.status === 'achieved' ? '等待下一主目标'");
    expect(sidebarSource).toContain('查看结果并设置下一目标');
  });

  it('makes sidebar controls explicitly target the selected project in a multi-project center', () => {
    expect(sidebarSource).toContain('活动项目 {activeProjects} · 当前项目：');
    expect(sidebarSource).toContain('当前项目：{projectDisplayName(session)}');
    expect(sidebarSource).toContain('打开当前项目');
    expect(sidebarSource).toContain('打开当前项目监督');
    expect(sidebarSource).toContain('ensureProjectSupervisorStatusSurface(session.id, true)');
    expect(sidebarSource).toContain('暂停当前项目');
    expect(sidebarSource).toContain('恢复当前项目');
  });

  it('keeps completion attention actionable while using success semantics throughout the dialog', () => {
    expect(dialogSource).toContain("data-kind={goalCompletionAlert ? 'completion' : 'alert'}");
    expect(dialogSource).toContain("role={goalCompletionAlert ? 'status' : 'alert'}");
    expect(dialogSource).toContain("goalCompletionAlert ? '✓' : '!'");
    expect(stylesSource).toContain(".project-manager-panel__alert[data-kind='completion']");
    expect(stylesSource).toContain(".project-manager-dialog__alert[data-kind='completion']");
    expect(stylesSource).toContain(".project-manager-dialog__inspector-alert[data-kind='completion']");
  });

  it('collapses verbose work-item and criterion evidence while preserving legacy fallbacks', () => {
    expect(dialogSource).toContain('function ProjectCompletionDetails');
    expect(dialogSource).toContain('function ProjectStageWorkItems');
    expect(dialogSource).toContain('`${unfinished} 未结束`');
    expect(dialogSource).toContain('`${stopped} 已停止`');
    expect(dialogSource).toContain('项逐项核验与证据');
    expect(dialogSource).toContain('summarizeProjectCompletionCriteria(completion)');
    expect(dialogSource).toContain('formatProjectCompletionAuditDetails(completion, evidenceFallback)');
    expect(dialogSource).toContain("completion.validation.join('\\n')");
    expect(dialogSource).toContain('currentSubgoalLabels.get(dependency) || dependency');
    expect(stylesSource).toContain('.project-manager-dialog__audit-details > pre');
    expect(stylesSource).toContain('max-height: min(30vh, 260px)');
  });
});
