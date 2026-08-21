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
const workspaceSettingsSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/Settings/WorkspaceSettings.tsx'),
  'utf8',
);
const supervisorCssSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/styles/supervisor.css'),
  'utf8',
);
const sidebarSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/Sidebar/Sidebar.tsx'),
  'utf8',
);
const paneWrapperSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/SplitPane/PaneWrapper.tsx'),
  'utf8',
);
const consoleSurfaceSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/project-manager/console-surface.ts'),
  'utf8',
);

describe('supervisor setup dialog feedback', () => {
  it('does not offer Claude Code as a supervisor launcher', () => {
    expect(dialogSource).not.toContain("value: 'claude'");
    expect(dialogSource).not.toContain('Claude Code');
    expect(workspaceSettingsSource).not.toContain('value="claude"');
    expect(workspaceSettingsSource).not.toContain('Claude Code');
  });

  it('keeps ordinary supervision and project management in separate dialogs', () => {
    expect(dialogSource).toContain('普通 AI 监督');
    expect(dialogSource).toContain('配置直接监督已打开任务终端的独立监督会话');
    expect(dialogSource).not.toContain('openProjectManagerDialog');
    expect(dialogSource).not.toContain('AI 工作模式切换');
    expect(dialogSource).not.toContain('supervisor-dialog__mode-tabs');
    expect(dialogSource).not.toContain('supervisor-dialog__mode-picker');
    expect(dialogSource).not.toContain('创建或打开项目管理终端');
    expect(dialogSource).toContain('if (s.projectManagerTerminal) continue;');
    expect(projectManagerDialogSource).toContain('项目 AI 中心');
    expect(projectManagerDialogSource).not.toContain('switchToSupervisorMode');
    expect(projectManagerDialogSource).not.toContain('openSupervisorSetup');
    expect(projectManagerDialogSource).not.toContain('AI 工作模式切换');
    expect(projectManagerDialogSource).not.toContain('supervisor-dialog__mode-tabs');
    expect(projectManagerDialogSource).toContain("action: 'start'");
    expect(projectManagerDialogSource).toContain('项目 AI + 监督 AI + 任务 AI');
    expect(projectManagerDialogSource).toContain('选择目录');
    expect(projectManagerDialogSource).toContain('项目数量不受限制');
    expect(projectManagerDialogSource).toContain('查看当前项目 AI 处理日志');
    expect(projectManagerDialogSource).toContain('添加项目');
    expect(projectManagerDialogSource).toContain('disabled={creating}');
    expect(projectManagerDialogSource).toContain('onClick={beginCreatingProject}');
    expect(projectManagerDialogSource).toContain('id="project-manager-create-form"');
    expect(projectManagerDialogSource).toContain("form.scrollIntoView({ block: 'start' })");
    expect(projectManagerDialogSource).toContain("?.focus({ preventScroll: true })");
    expect(projectManagerDialogSource).not.toContain("setCreating(dialogView === 'create' || sessions.length === 0)");
    expect(projectManagerDialogSource).toContain('项目管理模式 Agent 配置');
    expect(projectManagerDialogSource).toContain("action: 'configure-agents'");
    expect(projectManagerDialogSource).toContain('不读取“AI 监督模式”的默认设置');
    expect(projectManagerDialogSource).toContain('分别选择 Agent、模型和思考程度');
    expect(projectManagerDialogSource).toContain('首次使用请在任一 Codex 会话执行 /hooks');
    expect(projectManagerDialogSource).toContain('wmux 不会绕过 Hook 信任');
    expect(projectManagerDialogSource).toContain('不会代替你信任项目自带的 Hook');
    expect(projectManagerDialogSource).toContain("selection.agent === 'codex' ? '推理程度' : 'Thinking'");
    expect(projectManagerDialogSource).toContain('使用 Grok 默认 Thinking');
    expect(projectManagerDialogSource).not.toContain('disabled={selection.agent === \'grok\'}');
    expect(dialogSource).toContain('GROK_THINKING_OPTIONS');
    expect(dialogSource).toContain('Grok Thinking');
    expect(projectManagerDialogSource).toContain('项目前置条件（可选，每行一项）');
    expect(projectManagerDialogSource).toContain('当前主目标完成条件（可选，每行一项）');
    expect(projectManagerDialogSource).toContain("setPreconditions('无额外物理前置条件')");
    const startHandler = projectManagerDialogSource.match(
      /const start = async \(\) => \{[\s\S]*?^  \};/m,
    )?.[0] || '';
    expect(startHandler).toContain('if (!projectDir.trim() || !initialGoal)');
    expect(startHandler).not.toContain('!projectName.trim()');
    expect(startHandler).not.toContain('projectPreconditions.length === 0');
    expect(startHandler).not.toContain('conditions.length === 0');
    expect(projectManagerDialogSource).toContain('视为当前需求版本中用户已确认的事实');
    expect(projectManagerDialogSource).toContain('只有硬件、环境、权限或安全差异会实质改变方案时才会向你确认');
    expect(projectManagerDialogSource).toContain("action: 'update-definition'");
    expect(projectManagerDialogSource).toContain('项目身份与当前主目标');
    expect(projectManagerDialogSource).toContain('未确认变更尚未生效');
    expect(projectManagerDialogSource).toContain('取消变更');
    expect(projectManagerDialogSource).toContain('确认生效');
    expect(projectManagerDialogSource).toContain('关闭（取消变更）');
    expect(projectManagerDialogSource).toContain('项目稳定范围');
    expect(projectManagerDialogSource).toContain('调整当前主目标');
    expect(projectManagerDialogSource).toContain('切换新的主目标');
    expect(projectManagerDialogSource).toContain("goalChangeMode === 'pivot'");
    expect(projectManagerDialogSource).toContain('当前主目标的阶段计划');
    expect(projectManagerDialogSource).toContain('主目标历史');
    const definitionUpdateHandler = projectManagerDialogSource.match(
      /const updateProjectDefinition = async[\s\S]*?^  };/m,
    )?.[0] || '';
    expect(definitionUpdateHandler).not.toContain('window.confirm');
    const discardDefinitionHandler = projectManagerDialogSource.match(
      /const discardProjectDefinitionChanges = \(\) => \{[\s\S]*?^  };/m,
    )?.[0] || '';
    expect(discardDefinitionHandler).toContain('setDefinitionGoalDraft(session.goal)');
    expect(discardDefinitionHandler).toContain("setGoalChangeMode('refine')");
    expect(discardDefinitionHandler).not.toContain('invoke(');
    const closeDialogHandler = projectManagerDialogSource.match(
      /const closeDialog = \(\) => \{[\s\S]*?^  };/m,
    )?.[0] || '';
    expect(closeDialogHandler).toContain('discardProjectDefinitionChanges()');
    expect(closeDialogHandler).toContain('close()');
    expect(closeDialogHandler).not.toContain('updateProjectDefinition');
    const definitionFingerprint = projectManagerDialogSource.match(
      /const sessionDefinitionFingerprint = session \? JSON\.stringify\(\[[\s\S]*?\]\) : '';/m,
    )?.[0] || '';
    expect(definitionFingerprint).not.toContain('session.subgoals');
    expect(projectManagerDialogSource).toContain('同一项目目录同时只允许一个活动项目 AI');
    expect(projectManagerDialogSource).toContain('删除选中项目');
    expect(projectManagerDialogSource).toContain("action: 'delete-project'");
    expect(projectManagerDialogSource).toContain('恢复所选项目');
    expect(projectManagerDialogSource).toContain('setSelectedRecoveryIds([])');
    expect(projectManagerDialogSource).not.toContain('setSelectedRecoveryIds(candidates.map');
    expect(projectManagerDialogSource).toContain('当前情况（可选）');
    expect(projectManagerDialogSource).toContain('currentSituations: Object.fromEntries');
    expect(projectManagerDialogSource).toContain('留空则沿用原记录');
    expect(projectManagerDialogSource).toContain('本次恢复使用的 Agent 配置');
    expect(projectManagerDialogSource).toContain('可在恢复前重新选择');
    expect(projectManagerDialogSource).toContain('agentConfig: normalizeProjectManagementAgentConfig(agentDraft)');
    expect(projectManagerDialogSource).toContain('暂不恢复');
    expect(projectManagerDialogSource).toContain("action: 'recovery-candidates'");
    expect(projectManagerDialogSource).toContain('恢复时升级到最新执行协议');
    expect(projectManagerDialogSource).toContain("'restore-projects'");
    expect(projectManagerDialogSource).toContain("'skip-project-recovery'");
    expect(projectManagerDialogSource).toContain("action: 'delete-recovery-project'");
    expect(projectManagerDialogSource).toContain('删除记录');
    expect(projectManagerDialogSource).toContain('确认删除历史项目记录？');
    expect(projectManagerDialogSource).toContain('项目记录已不可用');
    expect(projectManagerDialogSource).toContain('recoveryDeleteCancelRef.current?.focus()');
    expect(projectManagerDialogSource).toContain('删除后无法从此页面恢复');
    expect(projectManagerDialogSource).toContain('计划文件（可选，最多');
    expect(projectManagerDialogSource).toContain('选择计划文件');
    expect(projectManagerDialogSource).toContain('添加路径');
    expect(projectManagerDialogSource).toContain('pendingUserQuestion');
    expect(projectManagerDialogSource).toContain('项目阻塞，需要你指示');
    expect(projectManagerDialogSource).toContain('项目管理 AI 邀请你对齐需求');
    expect(projectManagerDialogSource).toContain("action: 'answer-question'");
    expect(projectManagerDialogSource).toContain("scrollIntoView({ block: 'start', behavior: 'smooth' })");
    expect(projectManagerDialogSource).toContain('当前项目：{session.goal}。');
    expect(projectManagerDialogSource).toContain('项目 AI · 回复');
    expect(projectManagerDialogSource).toContain('你 · 询问');
    expect(projectManagerDialogSource).toContain('当前项目 AI 正在处理并将回复到此项目会话');
    expect(projectManagerDialogSource).toContain('messageDrafts');
    expect(projectManagerDialogSource).toContain("action: 'intervene-work-item'");
    expect(projectManagerDialogSource).toContain('跳过此项');
    expect(projectManagerDialogSource).toContain('关闭此项');
    expect(projectManagerDialogSource).toContain('可选：说明跳过或关闭的理由');
    expect(projectManagerDialogSource).toContain('project-manager-dialog__work-item-decisions');
    expect(projectManagerDialogSource).toContain('监督 AI 当前路线');
    expect(projectManagerDialogSource).toContain('监督 AI 下一步');
    expect(projectManagerDialogSource).toContain('监督执行进度');
    expect(projectManagerDialogSource).toContain('buildSupervisorPlanView');
    expect(supervisorCssSource).toMatch(
      /\.project-manager-dialog__work-item-decisions\s*\{[\s\S]*?max-height:[\s\S]*?overflow-y:\s*auto;/,
    );
    expect(pipeBridgeSource).toContain("if (action === 'intervene-work-item')");
    expect(pipeBridgeSource).toContain('其他工作项没有被全局暂停');
    expect(pipeBridgeSource).toContain('[${messageSource}项目管理消息｜必须回复到对应项目会话${revokedOldRun');
    expect(pipeBridgeSource).toContain('wmux project reply --project ${selectedProject.id} --correlation');
  });

  it('creates project and ordinary supervisors from existing terminal context', () => {
    expect(dialogSource).toContain('从已有终端创建 — 自动汇总 Agent 对话与项目进度');
    expect(dialogSource).toContain('基于终端创建监督 AI');
    expect(dialogSource).toContain('buildSupervisorGoalConstructionBriefing');
    expect(dialogSource).toContain("creationMode === 'terminal'");
    expect(dialogSource).not.toContain("origin: 'conversation'");
    expect(panelSource).toContain('监督 AI 正在汇总终端上下文');
    expect(panelSource).toContain('确认补全并开始');
    expect(panelSource).toContain("action: 'confirm-goal-construction'");
    expect(projectManagerDialogSource).toContain('上下文来源终端');
    expect(projectManagerDialogSource).toContain('基于终端创建项目 AI');
    expect(projectManagerDialogSource).toContain('sourceTerminalId: creationMode === \'terminal\'');
    expect(projectManagerDialogSource).toContain('该终端仅作为只读上下文来源');
    expect(projectManagerDialogSource).not.toContain("action: 'confirm-goal-construction'");
    expect(pipeBridgeSource).toContain('terminalBootstrapContext');
    expect(pipeBridgeSource).toContain('[已有终端上下文｜只读证据，不继承权限]');
    expect(pipeBridgeSource).toContain('只有会实质改变目标、范围、权限边界或验收的缺口');
    expect(pipeBridgeSource).not.toContain('项目目标草案尚未由用户确认');
    expect(dialogSource).not.toContain('创建监督 AI 并对话');
    expect(projectManagerDialogSource).not.toContain('创建项目 AI 并对话');
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

  it('uses an in-app confirmation so deleting the last recovery record preserves renderer focus', () => {
    const deleteRecoveryHandler = projectManagerDialogSource.match(
      /const deleteRecoveryCandidate = async[\s\S]*?^  };/m,
    )?.[0] || '';

    expect(deleteRecoveryHandler).not.toContain('window.confirm');
    expect(deleteRecoveryHandler).toContain('goalRef.current?.focus({ preventScroll: true })');
    expect(projectManagerDialogSource).toContain('role="alertdialog"');
    expect(projectManagerDialogSource).toContain("onClick={() => void deleteRecoveryCandidate(recoveryDeleteCandidate)}");
  });

  it('isolates ordinary setup and lifecycle controls from project-managed supervision', () => {
    expect(dialogSource).toContain('if (s.projectManagerProjectId || s.projectManagerWorkItemId) continue;');
    expect(dialogSource).toContain('supervisor.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane))');
    expect(dialogSource).toContain('setOrdinarySupervisorLanes(result.lanes)');
    expect(dialogSource).toContain('ordinaryPlanRequired: keepsCurrentContext ? prev?.ordinaryPlanRequired : true');
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

  it('allows optional user guidance to be evaluated by the AI supervisor', () => {
    expect(panelSource).toContain('proposalGuidance');
    expect(panelSource).toContain('补充给 AI 监督的信息（可选）');
    expect(panelSource).toContain('没有可选方案时，也可以只提交这段信息');
    expect(panelSource).toContain("(!selectedOption && !userGuidance.trim())");
    expect(panelSource).toMatch(/isClarification\s*\? '提交对齐答复'/);
    expect(panelSource).toContain("selectedOption ? '采用所选 AI 方案' : '提交补充给 AI 判断'");
  });

  it('separates supervision setup into focused steps and terminal details', () => {
    expect(dialogSource).toContain("useState<'targets' | 'permissions' | 'agent'>('targets')");
    expect(dialogSource).toContain('AI 监督配置步骤');
    expect(dialogSource).toContain('supervisor-dialog__setup-layout');
    expect(dialogSource).toContain("setupSection === 'targets'");
    expect(dialogSource).toContain("setupSection === 'permissions'");
    expect(dialogSource).toContain("setupSection === 'agent'");
    expect(dialogSource).toContain('配置详情');
    expect(dialogSource).toContain('terminalConfigExpansion[candidate.surfaceId] ?? false');
    expect(dialogSource).toContain('expandedSurfaceId');
    expect(dialogSource).toContain("[expandedSurfaceId]: false");
    expect(dialogSource).toContain('supervisor-dialog__drawer-title');
    expect(dialogSource).toContain('supervisor-dialog__drawer-overview');
    expect(dialogSource).toContain('任务终端监督配置');
    expect(supervisorCssSource).toContain('.supervisor-dialog__lane-settings[open]');
    expect(supervisorCssSource).toContain('position: fixed;');
    expect(supervisorCssSource).toContain('width: min(760px, calc(100vw - 32px))');
    expect(supervisorCssSource).toContain('.supervisor-dialog__config-panel > .supervisor-dialog__section');
  });

  it('groups terminal details into tabs with summaries and a fixed save bar', () => {
    expect(dialogSource).toContain("type TerminalConfigSection = 'basic' | 'execution' | 'context' | 'supervision'");
    expect(dialogSource).toContain("{ id: 'basic', label: '基础配置' }");
    expect(dialogSource).toContain("{ id: 'execution', label: '执行方式' }");
    expect(dialogSource).toContain("{ id: 'context', label: '上下文与资料' }");
    expect(dialogSource).toContain("{ id: 'supervision', label: '监督与权限' }");
    expect(dialogSource).toContain('supervisor-dialog__terminal-config-summary');
    expect(dialogSource).toContain('supervisor-dialog__config-tabs');
    expect(dialogSource).toContain('supervisor-dialog__drawer-notice');
    expect(dialogSource).toContain('supervisor-dialog__lane-settings-content');
    expect(dialogSource).toContain('已修改，尚未保存');
    expect(dialogSource).toContain('保存全部设置');
    expect(dialogSource).toContain('markTerminalConfigSaved(candidate.surfaceId)');
    expect(dialogSource).toContain('setTerminalConfigExpanded(candidate.surfaceId, false)');
    expect(dialogSource).not.toContain('applyConfig(false, false)');
    expect(dialogSource).toContain("showTerminalConfigSection(firstLane.surfaceId, 'basic'");
    expect(dialogSource).toContain("showTerminalConfigSection(firstLane.surfaceId, 'execution'");
    expect(supervisorCssSource).toContain('.supervisor-dialog__drawer-actions');
    expect(supervisorCssSource).toContain('.supervisor-dialog__lane-settings[open]::details-content');
    expect(supervisorCssSource).toContain('.supervisor-dialog__config-tabs button[aria-selected=\'true\']');
  });

  it('keeps draft save separate from applying a retained supervision session', () => {
    const footer = dialogSource.match(
      /<div className="supervisor-dialog__actions">[\s\S]*?^        <\/div>/m,
    )?.[0] || '';

    expect(footer).toContain("{!sessionRetained && creationMode === 'direct' && (");
    expect(footer).toContain('保存设置');
    expect(footer).toContain('{primaryActionLabel}');
    expect(dialogSource).toContain("if (ordinaryActive) primaryActionLabel = '应用并继续普通监督'");
  });

  it('uses a wide responsive project workspace with project and status sidebars', () => {
    expect(projectManagerDialogSource).toContain('project-manager-dialog__workspace');
    expect(projectManagerDialogSource).toContain('project-manager-dialog__main');
    expect(projectManagerDialogSource).toContain('project-manager-dialog__inspector');
    expect(projectManagerDialogSource).toContain('当前项目状态');
    expect(projectManagerDialogSource).toContain('project-manager-dialog__portfolio-actions');
    expect(supervisorCssSource).toMatch(/\.project-manager-dialog\s*\{[\s\S]*?width:\s*min\(1280px,/);
    expect(supervisorCssSource).toContain("grid-template-areas: 'main inspector'");
    expect(supervisorCssSource).toContain("[data-creating='1']");
    expect(supervisorCssSource).toContain("grid-template-areas: 'projects main'");
    expect(supervisorCssSource).toContain('@media (max-width: 1100px)');
    expect(supervisorCssSource).toContain('@media (max-width: 820px)');
    expect(supervisorCssSource).toMatch(
      /\[data-console='0'\]\[data-has-projects='1'\]\[data-creating='1'\][\s\S]*?grid-template-areas:\s*'projects'\s*'main'/,
    );
  });

  it('keeps the project message composer in normal flow so it cannot cover history', () => {
    const composerStyle = supervisorCssSource.match(
      /\.project-manager-dialog__composer\s*\{[\s\S]*?\}/,
    )?.[0] || '';

    expect(composerStyle).not.toContain('position: sticky');
    expect(composerStyle).not.toContain('bottom: 0');
    expect(composerStyle).toContain('margin-top: 8px');
    expect(projectManagerDialogSource).toMatch(
      /project-manager-dialog__chat[\s\S]*project-manager-dialog__conversation[\s\S]*project-manager-dialog__composer[\s\S]*<\/section>/,
    );
    expect(supervisorCssSource).toContain('grid-template-rows: auto minmax(0, 1fr) auto');
    expect(supervisorCssSource).toContain('overscroll-behavior: auto');
  });

  it('separates the project center from an embedded project management surface', () => {
    expect(projectManagerDialogSource).toContain('embeddedProjectId?: string');
    expect(projectManagerDialogSource).toContain("embedded ? '项目管理' : '项目 AI 中心'");
    expect(projectManagerDialogSource).toContain("enterProjectConsole(candidate.id)");
    expect(projectManagerDialogSource).toContain("data-console={embedded && session");
    expect(projectManagerDialogSource).toContain('if (projectId) enterProjectConsole(projectId)');
    expect(projectManagerDialogSource).toContain('window.requestAnimationFrame(() => openProjectManagerConsole(projectId))');
    expect(paneWrapperSource).toContain("surface.type === 'project-manager'");
    expect(paneWrapperSource).toContain('<ProjectManagerSessionPane projectId={surface.projectManagerProjectId} />');
    expect(consoleSurfaceSource).toContain("surface.type === 'project-manager'");
    expect(consoleSurfaceSource).toContain("store.addSurface(projectWorkspace.id, paneId, 'project-manager'");
    expect(pipeBridgeSource).toContain("createLeaf(undefined, projectManagedStart ? 'project-manager' : 'supervisor')");
  });

  it('uses the sidebar AI button as the unified creation entry', () => {
    expect(sidebarSource).toContain('新建 AI 工作模式');
    expect(sidebarSource).toContain('添加项目');
    expect(sidebarSource).toContain('普通 AI 监督');
    expect(sidebarSource).toContain('openProjectManagerCreationDialog()');
    expect(sidebarSource).toContain('openSupervisorSetup()');
    expect(panelSource).not.toContain('>配置普通监督</button>');
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
