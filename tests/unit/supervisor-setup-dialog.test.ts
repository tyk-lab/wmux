import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dialogSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/Supervisor/SupervisorSetupDialog.tsx'),
  'utf8',
);
const panelSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/Sidebar/SupervisorPanel.tsx'),
  'utf8',
);

describe('supervisor setup dialog feedback', () => {
  it('uses non-blocking inline notices instead of native alerts', () => {
    expect(dialogSource).not.toContain('window.alert');
    expect(dialogSource).toContain('className="supervisor-dialog__notice"');
    expect(dialogSource).toContain("role={dialogNotice.kind === 'error' ? 'alert' : 'status'}");
  });

  it('closes the setup dialog after applying changes to a retained session', () => {
    expect(dialogSource).toMatch(
      /if \(!sessionRetained\) startSupervisor\(\);\s*else closeSupervisorSetup\(\);/,
    );
  });

  it('saves retained-session settings and exports all currently selected terminals', () => {
    expect(dialogSource).toContain('if (andStart || sessionRetained)');
    expect(dialogSource).toContain('terminals: candidates.filter((candidate) => selected.has(candidate.surfaceId)).map');
    expect(dialogSource).toContain('导出当前终端配置…');
    expect(dialogSource).not.toContain('disabled={sessionRetained}\n            title=');
    expect(dialogSource).not.toContain('导出任务配置时请只选择一个终端');
  });

  it('keeps retained supervision lanes selected while importing only matched terminal configs', () => {
    expect(dialogSource).toContain('planSupervisorTerminalConfigImport(');
    expect(dialogSource).toContain('supervisor.lanes.filter(isSupervisorLaneBound)');
    expect(dialogSource).toContain('setSelected(new Set(importPlan.selectedSurfaceIds))');
    expect(dialogSource).toContain('for (const surfaceId of importedSurfaceIds)');
  });

  it('configures task-terminal work mode with one to three child threads', () => {
    expect(dialogSource).toContain('任务终端 AI 工作模式');
    expect(dialogSource).toContain("['single-thread', '单线程工作'");
    expect(dialogSource).toContain("['multi-thread', '多线程工程'");
    expect(dialogSource).toContain('<option value={1}>1 个</option>');
    expect(dialogSource).toContain('<option value={3}>3 个</option>');
    expect(dialogSource).toContain('主线程职责');
    expect(dialogSource).toContain('子线程 ${index + 1} 职责');
    expect(dialogSource).toContain('不是监督 AI');
  });

  it('configures context recovery per terminal, defaults to latest, and allows another source', () => {
    expect(dialogSource).toContain('恢复任务终端上下文');
    expect(dialogSource).toContain('恢复上下文（默认最新）');
    expect(dialogSource).toContain('restoreOptions[0]');
    expect(dialogSource).toContain('value={restoreSourceIdFor(candidate.surfaceId)}');
    expect(dialogSource).toContain('selectRestoreSource(candidate.surfaceId, event.target.value)');
    expect(dialogSource).toContain("{index === 0 ? '（最新）' : ''}");
    expect(dialogSource).toContain('restoreTaskContext: restoreEnabled.has(surfaceId)');
    expect(dialogSource).toContain('if (terminalConfig.restoreTaskContext) next.add(surfaceId)');
    expect(dialogSource).toContain('监督 AI 拟定恢复指令，需你确认后才发送');
    expect(dialogSource).not.toContain('恢复审计上下文（手动选择来源）');
    expect(panelSource).toContain('AI 监督拟定的任务恢复指令');
    expect(panelSource).toContain('确认并发送到任务终端');
    expect(panelSource).toContain('确认前不会改动任务终端');
  });

  it('collapses lanes that have reached their stop condition and lets users expand them', () => {
    expect(panelSource).toContain('const laneDetailsCollapsed = lane.stopConfirmed && !stoppedLaneExpanded;');
    expect(panelSource).toMatch(/const laneStatusLabel = laneControlState === 'waiting'[\s\S]+lane\.stopConfirmed[\s\S]+\? '已达停止条件'/);
    expect(panelSource).toContain('aria-expanded={stoppedLaneExpanded}');
    expect(panelSource).toContain("title={stoppedLaneExpanded ? '折叠监督详情' : '展开监督详情'}");
    expect(panelSource).toContain('{!laneDetailsCollapsed && (');
    expect(panelSource).toContain('supervisor.lanes.filter((lane) => lane.stopConfirmed)');
  });

  it('configures optional waiting after completion per terminal', () => {
    expect(dialogSource).toContain('完成后待续（可选）');
    expect(dialogSource).toContain('waitForNextDirection: event.target.checked');
    expect(dialogSource).toContain('supervisorWaitingConfigAction(');
    expect(dialogSource).toContain("=== 'finalize'");
    expect(dialogSource).toContain("? 'stopped'");
    expect(panelSource).toContain("laneControlState === 'waiting'");
    expect(panelSource).toContain('等待下一步方向');
  });
});
