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
const projectManagerDialogSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/ProjectManager/ProjectManagerDialog.tsx'),
  'utf8',
);
const pipeBridgeSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/pipe-bridge.ts'),
  'utf8',
);

describe('supervisor setup dialog feedback', () => {
  it('offers project management as a separate visible mode', () => {
    expect(dialogSource).toContain('选择 AI 工作模式');
    expect(dialogSource).toContain('AI 监督模式');
    expect(dialogSource).toContain('项目 AI 模式');
    expect(dialogSource).toContain('openProjectManagerDialog');
    expect(dialogSource).toContain('进入项目中心');
    expect(dialogSource).not.toContain('创建或打开项目管理终端');
    expect(dialogSource).toContain('if (s.projectManagerTerminal) continue;');
    expect(projectManagerDialogSource).toContain('项目中心');
    expect(projectManagerDialogSource).toContain("action: 'start'");
    expect(projectManagerDialogSource).toContain('项目 AI + 监督 AI + 任务 AI');
    expect(projectManagerDialogSource).toContain('选择目录');
    expect(projectManagerDialogSource).toContain('项目数量不受限制');
    expect(projectManagerDialogSource).toContain('查看当前项目 AI 处理日志');
    expect(projectManagerDialogSource).toContain('添加项目');
    expect(projectManagerDialogSource).toContain('项目管理模式 Agent 配置');
    expect(projectManagerDialogSource).toContain("action: 'configure-agents'");
    expect(projectManagerDialogSource).toContain('不读取“AI 监督模式”的默认设置');
    expect(projectManagerDialogSource).toContain('分别选择 Agent、模型和思考程度');
    expect(projectManagerDialogSource).toContain("selection.agent === 'codex' ? '推理程度' : 'Thinking'");
    expect(projectManagerDialogSource).toContain('通过会话内 /effort 调整');
    expect(projectManagerDialogSource).toContain('项目前置条件（每行一项）');
    expect(projectManagerDialogSource).toContain('视为当前需求版本中用户已确认的事实');
    expect(projectManagerDialogSource).toContain('不会逐步重复确认');
    expect(projectManagerDialogSource).toContain("action: 'update-definition'");
    expect(projectManagerDialogSource).toContain('项目目标与需求');
    expect(projectManagerDialogSource).toContain('保存需求变更');
    expect(projectManagerDialogSource).toContain('删除选中项目');
    expect(projectManagerDialogSource).toContain("action: 'delete-project'");
    expect(projectManagerDialogSource).toContain('恢复所选项目');
    expect(projectManagerDialogSource).toContain('暂不恢复');
    expect(projectManagerDialogSource).toContain("action: 'recovery-candidates'");
    expect(projectManagerDialogSource).toContain("'restore-projects'");
    expect(projectManagerDialogSource).toContain("'skip-project-recovery'");
    expect(projectManagerDialogSource).toContain('计划文件（可选，最多');
    expect(projectManagerDialogSource).toContain('选择计划文件');
    expect(projectManagerDialogSource).toContain('添加路径');
    expect(projectManagerDialogSource).toContain('pendingUserQuestion');
    expect(projectManagerDialogSource).toContain('项目阻塞，需要你指示');
    expect(projectManagerDialogSource).toContain('项目管理 AI 邀请你对齐需求');
    expect(projectManagerDialogSource).toContain("action: 'answer-question'");
    expect(projectManagerDialogSource).toContain("scrollIntoView({ block: 'start', behavior: 'smooth' })");
    expect(projectManagerDialogSource).toContain('当前项目：{session.goal}');
    expect(projectManagerDialogSource).toContain('项目 AI · 回复');
    expect(projectManagerDialogSource).toContain('你 · 询问');
    expect(projectManagerDialogSource).toContain('当前项目 AI 正在处理并将回复到此项目会话');
    expect(projectManagerDialogSource).toContain('messageDrafts');
    expect(pipeBridgeSource).toContain('[${messageSource}项目管理消息｜必须回复到对应项目会话${revokedOldRun');
    expect(pipeBridgeSource).toContain('wmux project reply --project ${selectedProject.id} --correlation');
  });

  it('defaults new supervision lanes to wait for the next direction after completion', () => {
    expect(dialogSource).toMatch(
      /function emptyLaneConfig\(\): SupervisorLaneConfig \{[\s\S]*?waitForNextDirection: true,/,
    );
  });

  it('uses non-blocking inline notices instead of native alerts', () => {
    expect(dialogSource).not.toContain('window.alert');
    expect(dialogSource).toContain('className="supervisor-dialog__notice"');
    expect(dialogSource).toContain("role={dialogNotice.kind === 'error' ? 'alert' : 'status'}");
  });

  it('closes the setup dialog after applying changes to a retained session', () => {
    expect(dialogSource).toMatch(
      /if \(!sessionRetained\) startOrdinarySupervisor\(\);\s*else closeSupervisorSetup\(\);/,
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
    expect(dialogSource).toContain('ordinarySupervisorLanes.filter(isSupervisorLaneBound)');
    expect(dialogSource).toContain('setSelected(new Set(importPlan.selectedSurfaceIds))');
    expect(dialogSource).toContain('for (const surfaceId of importedSurfaceIds)');
  });

  it('isolates ordinary setup and lifecycle controls from project-managed supervision', () => {
    expect(dialogSource).toContain('if (s.projectManagerProjectId || s.projectManagerWorkItemId) continue;');
    expect(dialogSource).toContain('supervisor.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane))');
    expect(dialogSource).toContain('setOrdinarySupervisorLanes(result.lanes)');
    expect(dialogSource).toContain('startOrdinarySupervisor()');
    expect(dialogSource).toContain('stopOrdinarySupervisor()');
    expect(panelSource).toContain('普通监督的配置、暂停和停止操作均不会修改这里');
    expect(panelSource).toContain('isProjectManagedSupervisorLane(lane)');
    expect(panelSource).toContain('stopOrdinarySupervisor()');
    expect(panelSource).toContain('resetOrdinarySupervisorSession()');
    expect(panelSource).toContain("surface.type === 'supervisor' && surface.projectSupervisorProjectId");
    expect(panelSource).toContain("scopedProjectId ? '项目专属监督' : 'AI 监督'");
    expect(pipeBridgeSource).toContain('projectManagerWorkspaceTitle');
    expect(pipeBridgeSource).toContain('projectSupervisorWorkspaceTitle');
    expect(projectManagerDialogSource).toContain('project-manager-dialog__tabs');
    expect(projectManagerDialogSource).toContain('project-manager-dialog__alert');
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

  it('shows waiting state prominently in the supervisor header and lane card', () => {
    expect(panelSource).toContain("? `运行中 · ${waiting.length} 待续`");
    expect(panelSource).toContain('data-waiting={waiting.length > 0');
    expect(panelSource).toContain('当前有 {ordinaryWaiting.length} 个普通监督通道处于待续状态');
    expect(panelSource).toContain('当前项目有 {waiting.length} 个监督通道待续');
    expect(panelSource).toContain('普通监督不会接管');
    expect(panelSource).toContain('data-control-state={laneControlState}');
  });
});
