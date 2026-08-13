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

  it('configures context recovery per selected task terminal and picks the latest audit candidate', () => {
    expect(dialogSource).toContain('恢复任务终端上下文');
    expect(dialogSource).toContain('自动选择最新上下文');
    expect(dialogSource).toContain('restoreOptions[0]');
    expect(dialogSource).toContain('restoreTaskContext: restoreEnabled.has(surfaceId)');
    expect(dialogSource).toContain('if (config.restoreTaskContext) next.add(surfaceId)');
    expect(dialogSource).toContain('监督 AI 拟定恢复指令，需你确认后才发送');
    expect(dialogSource).not.toContain('恢复审计上下文（手动选择来源）');
    expect(panelSource).toContain('AI 监督拟定的任务恢复指令');
    expect(panelSource).toContain('确认并发送到任务终端');
    expect(panelSource).toContain('确认前不会改动任务终端');
  });
});
