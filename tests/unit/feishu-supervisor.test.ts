import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApprovalCard, buildBusyTaskConfirmationCard, buildDirectTerminalTaskCard, buildFeishuAuditAlertCard, buildFeishuAuditStatusCard, buildSupervisorControlMenuCard, buildSupervisorLaneControlCard, buildSupervisorManagementCard, buildSupervisorResultCard, buildSupervisorSendTaskCard, buildSupervisorStartCard, buildSupervisorStopConfirmationCard, formatFeishuSupervisorAuditEvent, formatFeishuSupervisorResponse, isFeishuSupervisorActorAllowed, isFeishuSupervisorHelp, loadFeishuEnvironment, parseFeishuCardFormValues, parseFeishuDotEnv, parseFeishuSupervisorCommand, parseLegacyFeishuEnv, reduceFeishuAuditTerminalStatus, resolveFeishuCardAction } from '../../src/main/feishu-supervisor';
import { PROJECT_MANAGER_TERMINAL_STARTUP_INPUT } from '../../src/shared/project-manager-terminal';

describe('飞书 AI 监督命令', () => {
  it('解析启动命令及可选监督配置', () => {
    expect(parseFeishuSupervisorCommand(`WMUX SUPERVISOR START
terminals: surf-a,surf-b
stop_when: npm test 通过
stop_when_kind: concrete
task_goal: 完成飞书监督测试
task_description: 仅补充结束条件
autonomous: on
supervisor_launch_cmd: kimi
supervisor_model: k3`)).toEqual({
      action: 'start',
      terminals: ['surf-a', 'surf-b'],
      stopWhen: 'npm test 通过',
      stopWhenKind: 'concrete',
      taskGoal: '完成飞书监督测试',
      taskDescription: '仅补充结束条件',
      preconditions: undefined,
      planFile: undefined,
      autonomous: true,
      supervisorLaunchCmd: 'kimi',
      supervisorModel: 'k3',
      supervisorReasoningEffort: undefined,
    });
  });

  it('拒绝缺少必要字段和未知自动化值', () => {
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR START\nterminals: surf-a')).toEqual({ error: 'START 需要 terminals 和 stop_when。' });
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR START\nterminals: surf-a\nstop_when: done\nautonomous: maybe')).toEqual({ error: 'autonomous 只能是 on 或 off。' });
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR START\nterminals: surf-a\nstop_when: done\nrun: whoami')).toEqual({ error: 'START 包含不支持的字段。' });
  });

  it('只允许明确的人为决策动作', () => {
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR DECIDE\napproval_id: appr-1\naction: approve\ntask: 按当前路线继续并补齐测试')).toEqual({
      action: 'decide', approvalId: 'appr-1', decision: 'approve', task: '按当前路线继续并补齐测试',
    });
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR DECIDE\napproval_id: appr-1\naction: approve')).toEqual({
      action: 'decide', approvalId: 'appr-1', decision: 'approve', task: undefined,
    });
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR DECIDE\napproval_id: appr-1\naction: reject')).toEqual({
      action: 'decide', approvalId: 'appr-1', decision: 'reject', task: undefined,
    });
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR DECIDE\napproval_id: appr-1\naction: shell')).toEqual({
      error: 'DECIDE 需要 approval_id 和 action: approve|reject|pause|stop。',
    });
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR DECIDE\napproval_id: appr-1\naction: pause')).toEqual({
      action: 'decide', approvalId: 'appr-1', decision: 'pause', task: undefined,
    });
  });

  it('识别单聊控制菜单的中英文帮助口令', () => {
    expect(isFeishuSupervisorHelp('wmux帮助')).toBe(true);
    expect(isFeishuSupervisorHelp('WMUX HELP')).toBe(true);
    expect(isFeishuSupervisorHelp('帮助')).toBe(true);
    expect(isFeishuSupervisorHelp('WMUX SUPERVISOR LIST')).toBe(false);
  });

  it('解析指定终端发送任务的受限命令', () => {
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR SEND\nterminal: surf-a\ntask: 运行测试并汇报结果')).toEqual({
      action: 'send', terminal: 'surf-a', task: '运行测试并汇报结果',
    });
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR SEND\nterminal: surf-a')).toEqual({
      error: 'SEND 需要 terminal 和 task。',
    });
  });

  it('解析单个 AI 监督的暂停、继续和停止命令', () => {
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR PAUSE\nterminal: surf-a')).toEqual({ action: 'pause-lane', terminal: 'surf-a' });
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR RESUME\nterminal: sup-lane-a')).toEqual({ action: 'resume-lane', terminal: 'sup-lane-a' });
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR STOP\nterminal: surf-a')).toEqual({ action: 'stop-lane', terminal: 'surf-a' });
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR STOP\nsession: current')).toEqual({ action: 'stop' });
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR STOP\nterminal: surf-a\nsession: current')).toEqual({
      error: 'STOP 需要 terminal: <终端 ID> 或 session: current。',
    });
  });

  it('允许白名单单聊和指定群聊，拒绝其他来源', () => {
    const config = { controlChatId: 'oc-control', allowedOpenIds: new Set(['ou-allowed']) };
    expect(isFeishuSupervisorActorAllowed(config, 'oc-control', 'ou-allowed', 'group')).toBe(true);
    expect(isFeishuSupervisorActorAllowed(config, 'oc-direct', 'ou-allowed', 'p2p')).toBe(true);
    expect(isFeishuSupervisorActorAllowed(config, 'oc-audit', 'ou-allowed', 'group')).toBe(false);
    expect(isFeishuSupervisorActorAllowed(config, 'oc-control', 'ou-other', 'p2p')).toBe(false);
    expect(isFeishuSupervisorActorAllowed({ controlChatId: undefined, allowedOpenIds: new Set(['ou-allowed']) }, 'oc-audit', 'ou-allowed', 'group')).toBe(false);
  });

  it('将普通审计事件格式化为脱敏的群摘要', () => {
    const text = formatFeishuSupervisorAuditEvent({
      sessionId: 'sup-1', projectDir: 'E:\\private', type: 'worker.task',
      terminal: { surfaceId: 'surf-1', label: 'pwsh.exe' },
      payload: {
        task: '读取 E:\\private\\plan.md，token: sk-secret-token-value',
        cwd: 'E:\\private',
        apiKey: 'should-not-leak',
      },
    });

    expect(text).toContain('工作终端任务更新');
    expect(text).toContain('task：读取 本地路径已隐藏');
    expect(text).toContain('cwd：本地路径已隐藏');
    expect(text).toContain('apiKey：已脱敏');
    expect(text).not.toContain('sk-secret-token-value');
  });

  it('将终端事件归并为清晰且脱敏的当前状态卡', () => {
    const started = reduceFeishuAuditTerminalStatus(undefined, {
      sessionId: 'sup-1', projectDir: 'E:\\private', type: 'session.started', ts: 1_700_000_000_000,
      terminal: { surfaceId: 'surf-1', label: 'codex', workspaceTitle: '桌面任务' }, payload: {},
    });
    const working = reduceFeishuAuditTerminalStatus(started, {
      sessionId: 'sup-1', projectDir: 'E:\\private', type: 'worker.task', ts: 1_700_000_001_000,
      terminal: { surfaceId: 'surf-1', label: 'codex', workspaceTitle: '桌面任务' },
      payload: { task: '读取 E:\\private\\plan.md，token: sk-secret-token-value' },
    });
    const blocked = reduceFeishuAuditTerminalStatus(working, {
      sessionId: 'sup-1', projectDir: 'E:\\private', type: 'worker.blocked', ts: 1_700_000_002_000,
      terminal: { surfaceId: 'surf-1', label: 'codex', workspaceTitle: '桌面任务' },
      payload: { reason: '等待输入' },
    });
    const cardText = JSON.stringify(buildFeishuAuditStatusCard(blocked));
    const alertText = JSON.stringify(buildFeishuAuditAlertCard({
      sessionId: 'sup-1', projectDir: 'E:\\private', type: 'worker.blocked', ts: 1_700_000_002_000,
      terminal: { surfaceId: 'surf-1', label: 'codex', workspaceTitle: '桌面任务' }, payload: { reason: '等待输入' },
    }, blocked));

    expect(blocked.taskState).toBe('blocked');
    expect(blocked.currentTask).toContain('本地路径已隐藏');
    expect(cardText).toContain('当前任务');
    expect(cardText).toContain('下一步');
    expect(cardText).not.toContain('sk-secret-token-value');
    expect(cardText).not.toContain('E:\\\\private');
    expect(alertText).toContain('终端任务已阻塞');
  });

  it('同一终端进入新监督会话时不沿用旧任务状态', () => {
    const completed = reduceFeishuAuditTerminalStatus(undefined, {
      sessionId: 'sup-old', projectDir: '', type: 'supervisor.decision',
      terminal: { surfaceId: 'surf-1', label: 'codex', workspaceTitle: '旧工作区' }, payload: { outcome: 'complete' },
    });
    const restarted = reduceFeishuAuditTerminalStatus(completed, {
      sessionId: 'sup-new', projectDir: '', type: 'worker.lifecycle',
      terminal: { surfaceId: 'surf-1', label: 'codex' }, payload: { event: 'SessionStart' },
    });

    expect(restarted.taskState).toBe('waiting');
    expect(restarted.currentTask).toBe('尚未收到任务');
    expect(restarted.workspaceTitle).toBeUndefined();
  });

  it('自动判断上限要求人工复核时不提前发送完成提醒', () => {
    const record = {
      sessionId: 'sup-1', projectDir: '', type: 'supervisor.decision' as const,
      terminal: { surfaceId: 'surf-1', label: 'codex' },
      payload: { outcome: 'complete', requiresHuman: true },
    };
    const status = reduceFeishuAuditTerminalStatus(undefined, record);

    expect(status.taskState).toBe('awaiting-human');
    expect(JSON.stringify(buildFeishuAuditAlertCard(record, status))).toContain('任务等待人工复核');
  });

  it('人工从飞书暂停监督时保留待决状态，停止时清空待决状态', () => {
    const awaiting = reduceFeishuAuditTerminalStatus(undefined, {
      sessionId: 'sup-1', projectDir: '', type: 'supervisor.approval.requested',
      terminal: { surfaceId: 'surf-1', label: 'codex' }, payload: { approvalId: 'approval-1' },
    });
    const paused = reduceFeishuAuditTerminalStatus(awaiting, {
      sessionId: 'sup-1', projectDir: '', type: 'supervisor.remote-decision',
      terminal: { surfaceId: 'surf-1', label: 'codex' }, payload: { decision: 'pause' },
    });
    const stopped = reduceFeishuAuditTerminalStatus(paused, {
      sessionId: 'sup-1', projectDir: '', type: 'supervisor.remote-decision',
      terminal: { surfaceId: 'surf-1', label: 'codex' }, payload: { decision: 'stop' },
    });

    expect(paused).toMatchObject({ taskState: 'paused', supervisionState: '已暂停', pendingHuman: '待处理；详细内容不在群内展示' });
    expect(stopped).toMatchObject({ taskState: 'stopped', supervisionState: '已停止', pendingHuman: '无' });
  });

  it('解析本机 .env 和首次配置用的标签值文件', () => {
    expect(parseFeishuDotEnv("WMUX_FEISHU_APP_ID=cli-test\nWMUX_FEISHU_CONTROL_CHAT_ID=oc-control\nWMUX_FEISHU_ENV_FILE='docs/env.txt'")).toEqual({
      WMUX_FEISHU_APP_ID: 'cli-test', WMUX_FEISHU_CONTROL_CHAT_ID: 'oc-control', WMUX_FEISHU_ENV_FILE: 'docs/env.txt',
    });
    expect(parseFeishuDotEnv('FEISHU_APP_ID=cli-test\nFEISHU_APP_SECRET=secret-test\nFEISHU_CHAT_ID=oc-direct\nFEISHU_GROUP_CHAT_ID=oc-audit\nFEISHU_USER_OPEN_ID=ou-allowed')).toEqual({
      WMUX_FEISHU_APP_ID: 'cli-test', WMUX_FEISHU_APP_SECRET: 'secret-test',
      WMUX_FEISHU_DECISION_CHAT_ID: 'oc-direct', WMUX_FEISHU_CHAT_ID: 'oc-audit', WMUX_FEISHU_ALLOWED_OPEN_IDS: 'ou-allowed',
    });
    expect(parseLegacyFeishuEnv('App ID\ncli-test\n\nApp Secret\nsecret-test\n\n单聊会话 ID\noc-direct\n\n群聊会话 ID\noc-audit\n\n用户 ID\nou-allowed')).toEqual({
      WMUX_FEISHU_APP_ID: 'cli-test', WMUX_FEISHU_APP_SECRET: 'secret-test',
      WMUX_FEISHU_DECISION_CHAT_ID: 'oc-direct', WMUX_FEISHU_CHAT_ID: 'oc-audit', WMUX_FEISHU_ALLOWED_OPEN_IDS: 'ou-allowed',
    });
  });

  it('从 .env 指向的本机飞书配置文件加载值且不覆盖启动器环境', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-feishu-env-'));
    try {
      fs.writeFileSync(path.join(directory, '.env'), 'WMUX_FEISHU_ENV_FILE=legacy.txt\n', 'utf8');
      fs.writeFileSync(path.join(directory, 'legacy.txt'), 'App ID\ncli-from-file\n\nApp Secret\nsecret-from-file\n\n群聊会话 ID\noc-audit\n\n用户 ID\nou-allowed\n', 'utf8');
      const env: NodeJS.ProcessEnv = { WMUX_FEISHU_APP_ID: 'cli-from-launcher' };

      loadFeishuEnvironment(env, directory, path.join(directory, 'wmux.exe'), path.join(directory, 'appdata'));

      expect(env).toMatchObject({
        WMUX_FEISHU_APP_ID: 'cli-from-launcher', WMUX_FEISHU_APP_SECRET: 'secret-from-file',
        WMUX_FEISHU_CHAT_ID: 'oc-audit', WMUX_FEISHU_ALLOWED_OPEN_IDS: 'ou-allowed',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('从 wmux.exe 同目录的 .env 解析相对配置路径', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-feishu-exe-env-'));
    const executableDir = path.join(directory, 'release');
    try {
      fs.mkdirSync(executableDir);
      fs.writeFileSync(path.join(executableDir, '.env'), 'WMUX_FEISHU_ENV_FILE=legacy.txt\n', 'utf8');
      fs.writeFileSync(path.join(executableDir, 'legacy.txt'), 'App ID\ncli-from-exe-dir\n\nApp Secret\nsecret-from-exe-dir\n\n群聊会话 ID\noc-audit\n\n用户 ID\nou-allowed\n', 'utf8');
      const env: NodeJS.ProcessEnv = {};

      loadFeishuEnvironment(env, directory, executableDir, path.join(directory, 'appdata'));

      expect(env.WMUX_FEISHU_APP_ID).toBe('cli-from-exe-dir');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('安装版从用户配置目录加载飞书凭据', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-feishu-appdata-env-'));
    const appDataDir = path.join(directory, 'appdata');
    try {
      fs.mkdirSync(appDataDir);
      fs.writeFileSync(path.join(appDataDir, '.env'), [
        'WMUX_FEISHU_APP_ID=cli-installed',
        'WMUX_FEISHU_APP_SECRET=secret-installed',
        'WMUX_FEISHU_CHAT_ID=oc-audit',
        'WMUX_FEISHU_ALLOWED_OPEN_IDS=ou-allowed',
      ].join('\n'), 'utf8');
      const env: NodeJS.ProcessEnv = {};

      loadFeishuEnvironment(env, path.join(directory, 'working'), path.join(directory, 'installed'), appDataDir);

      expect(env).toMatchObject({
        WMUX_FEISHU_APP_ID: 'cli-installed',
        WMUX_FEISHU_APP_SECRET: 'secret-installed',
        WMUX_FEISHU_CHAT_ID: 'oc-audit',
        WMUX_FEISHU_ALLOWED_OPEN_IDS: 'ou-allowed',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('将人工审批渲染为包含方案选择、输入和操作按钮的表单', () => {
    const cardObject = buildApprovalCard({
      sessionId: 'sup-1', projectDir: 'E:\\test', type: 'supervisor.approval.requested',
      terminal: { surfaceId: 'surf-1', label: 'pwsh.exe' },
      payload: { approvalId: 'appr-1', alternatives: '用户选择方案 A；用户选择方案 B。' },
    }) as { schema?: string; body?: { elements?: unknown[] }; elements?: unknown[] };
    const card = JSON.stringify(cardObject);

    expect(cardObject.schema).toBe('2.0');
    expect(cardObject.body?.elements).toBeInstanceOf(Array);
    expect(cardObject.elements).toBeUndefined();
    expect(card).toContain('select_static');
    expect(card).toContain('选择方案 A');
    expect(card).toContain('选择方案 B');
    expect(card).toContain('follow_up_task');
    expect(card).toContain('批准并继续');
    expect(card).toContain('按补充说明调整');
    expect(card).toContain('调整时必填，批准时可选');
    expect(card).toContain('处理当前决策');
    expect(card).toContain('监督控制');
    expect(card).toContain('暂停此监督');
    expect(card).toContain('"decision":"reject"');
    expect(card).toContain('停止此监督');
  });

  it('将日常控制渲染为菜单、启动表单和任务表单', () => {
    const terminals = [{ surfaceId: 'surf-a', label: 'pwsh.exe', workspace: '飞书管理', supervised: false }];
    const menuObject = buildSupervisorControlMenuCard() as { schema?: string; body?: { elements?: unknown[] }; elements?: unknown[] };
    const menu = JSON.stringify(menuObject);
    const activeMenu = JSON.stringify(buildSupervisorControlMenuCard({
      active: true, paused: false, totalTerminals: 2, availableTerminals: 1, supervisedTerminals: 1, pendingApprovals: 2,
    }));
    const pausedMenu = JSON.stringify(buildSupervisorControlMenuCard({
      active: false, paused: true, totalTerminals: 2, availableTerminals: 1, supervisedTerminals: 1, pendingApprovals: 0,
    }));
    const idleMenu = JSON.stringify(buildSupervisorControlMenuCard({
      active: false, paused: false, totalTerminals: 1, availableTerminals: 1, supervisedTerminals: 0, pendingApprovals: 0,
    }));
    const startObject = buildSupervisorStartCard(terminals) as { schema?: string; body?: { elements?: unknown[] }; elements?: unknown[] };
    const sendObject = buildSupervisorSendTaskCard(terminals) as { schema?: string; body?: { elements?: unknown[] }; elements?: unknown[] };
    const createTaskObject = buildDirectTerminalTaskCard() as { body?: { elements?: Array<{ tag?: string; elements?: Array<Record<string, unknown>> }> } };
    const createTask = JSON.stringify(createTaskObject);
    const laneControl = JSON.stringify(buildSupervisorLaneControlCard([
      { ...terminals[0], supervised: true, supervisionState: 'active' },
    ]));
    const start = JSON.stringify(startObject);
    const send = JSON.stringify(sendObject);
    const startElements = startObject.body?.elements as Array<{ tag?: string }> | undefined;
    const sendElements = sendObject.body?.elements as Array<{ tag?: string }> | undefined;

    expect(menuObject.schema).toBe('2.0');
    expect(menuObject.body?.elements).toBeInstanceOf(Array);
    expect(menuObject.elements).toBeUndefined();
    expect(menu).not.toContain('"tag":"note"');
    expect(menu).toContain('"text_size":"notation"');
    expect(menu).toContain('刷新状态');
    expect(menu).toContain('添加终端任务');
    expect(menu).toContain('启动监督');
    expect(menu).toContain('发送任务');
    expect(activeMenu).toContain('管理监督');
    expect(menu).not.toContain('停止全部');
    expect(activeMenu).toContain('添加监督终端');
    expect(activeMenu).toContain('监督通道 1 个');
    expect(activeMenu).toContain('待审批 2 项');
    expect(activeMenu).not.toContain('暂停全部');
    expect(activeMenu).not.toContain('停止全部');
    expect(pausedMenu).toContain('已暂停（上下文已保留）');
    expect(pausedMenu).toContain('继续全部监督');
    expect(idleMenu).toContain('启动监督');
    expect(idleMenu).not.toContain('管理监督');
    expect(menu).toContain('白名单用户');
    expect(menu).not.toContain('审批卡片发送到审计群');
    expect(startObject.schema).toBe('2.0');
    expect(startObject.body?.elements).toBeInstanceOf(Array);
    expect(startObject.elements).toBeUndefined();
    expect(startElements?.at(-1)?.tag).toBe('column_set');
    expect(start).toContain('返回控制首页');
    expect(sendObject.schema).toBe('2.0');
    expect(sendObject.body?.elements).toBeInstanceOf(Array);
    expect(sendObject.elements).toBeUndefined();
    expect(sendElements?.at(-1)?.tag).toBe('column_set');
    expect(send).toContain('返回控制首页');
    const startForm = (startObject.body?.elements as Array<{ tag?: string; elements?: Array<Record<string, unknown>> }>).find((element) => element.tag === 'form');
    const selects = startForm?.elements?.filter((element) => element.tag === 'select_static') || [];
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((select) => !('label' in select))).toBe(true);
    expect(selects.flatMap((select) => Array.isArray(select.options) ? select.options : []).every((option) => !('selected' in (option as object)))).toBe(true);
    expect(start).toContain('task_goal');
    expect(start).toContain('stop_when');
    expect(start).toContain('plan_file');
    expect(start).toContain('form_start');
    expect(send).toContain('task');
    expect(send).toContain('form_send');
    expect(send).toContain('multiline_text');
    expect(createTask).toContain('添加 AI 终端任务');
    expect(createTask).toContain('Codex（默认）');
    expect(createTask).toContain('Kimi');
    expect(createTask).toContain('Grok');
    expect(createTask).toContain('创建项目管理终端');
    expect(createTask).toContain(PROJECT_MANAGER_TERMINAL_STARTUP_INPUT);
    expect(createTask).toContain('create_project_manager');
    expect(createTask).toContain('task_name');
    expect(createTask).toContain('form_create_task');
    expect(createTask).toContain('返回控制首页');
    const createTaskForm = createTaskObject.body?.elements?.find((element) => element.tag === 'form');
    const createTaskInputs = createTaskForm?.elements?.filter((element) => element.tag === 'input') || [];
    const createTaskSelects = createTaskForm?.elements?.filter((element) => element.tag === 'select_static') || [];
    expect(createTaskInputs).toHaveLength(2);
    expect(createTaskSelects).toHaveLength(1);
    expect(createTaskSelects[0]).toMatchObject({ name: 'agent' });
    expect(createTaskInputs.every((input) => Number(input.max_length) >= 1 && Number(input.max_length) <= 1000)).toBe(true);
    expect(start).toContain('surf-a');
    expect(laneControl).toContain('pause-lane');
    expect(laneControl).toContain('resume-lane');
    expect(laneControl).toContain('stop-lane');
  });

  it('将暂停和停止收拢到管理卡，并为停止提供确认卡', () => {
    const terminal = { surfaceId: 'surf-a', label: 'pwsh.exe', workspace: '飞书管理', supervised: true, supervisionState: 'active' as const };
    const activeManagement = JSON.stringify(buildSupervisorManagementCard([terminal], { active: true, paused: false }));
    const pausedManagement = JSON.stringify(buildSupervisorManagementCard([terminal], { active: false, paused: true }));
    const stopAll = JSON.stringify(buildSupervisorStopConfirmationCard());
    const stopLane = JSON.stringify(buildSupervisorStopConfirmationCard(terminal));

    expect(activeManagement).toContain('暂停全部');
    expect(activeManagement).toContain('stop-confirm');
    expect(activeManagement).toContain('暂停此监督');
    expect(activeManagement).not.toContain('继续此监督');
    expect(pausedManagement).toContain('继续全部');
    expect(pausedManagement).toContain('随会话暂停（继续全部后恢复）');
    expect(pausedManagement).not.toContain('继续此监督');
    expect(pausedManagement).not.toContain('暂停此监督');
    expect(activeManagement).toContain('stop-lane');
    expect(stopAll).toContain('确认停止全部');
    expect(stopLane).toContain('confirm_stop_lane');
    expect(stopLane).toContain('surf-a');
  });

  it('在发送任务和管理监督中展示四种任务终端状态', () => {
    const updatedAt = Date.now();
    const terminals = [
      { surfaceId: 'surf-idle', label: 'Codex', workspace: '代码', supervised: true, supervisionState: 'active' as const, activityState: 'idle' as const, activityUpdatedAt: updatedAt },
      { surfaceId: 'surf-working', label: 'Grok', workspace: '分析', supervised: true, supervisionState: 'active' as const, activityState: 'working' as const, activityUpdatedAt: updatedAt },
      { surfaceId: 'surf-blocked', label: 'Kimi', workspace: '文档', supervised: true, supervisionState: 'active' as const, activityState: 'blocked' as const, activityUpdatedAt: updatedAt },
      { surfaceId: 'surf-unknown', label: 'Shell', workspace: '其他', supervised: true, supervisionState: 'active' as const, activityState: 'unknown' as const },
    ];

    const sendCard = JSON.stringify(buildSupervisorSendTaskCard(terminals));
    const managementCard = JSON.stringify(buildSupervisorManagementCard(terminals, { active: true, paused: false }));

    for (const card of [sendCard, managementCard]) {
      expect(card).toContain('空闲');
      expect(card).toContain('执行中');
      expect(card).toContain('等待人工');
      expect(card).toContain('未知');
      expect(card).toContain('刚刚');
    }
  });

  it('忙碌确认卡不携带任务正文', () => {
    const card = JSON.stringify(buildBusyTaskConfirmationCard({
      surfaceId: 'surf-working', label: 'Grok', workspace: '分析', activityState: 'working', activityUpdatedAt: Date.now(),
    }, 'confirm-1'));

    expect(card).toContain('确认向忙碌终端发送任务');
    expect(card).toContain('仍然发送');
    expect(card).toContain('confirm_busy_send');
    expect(card).toContain('confirm-1');
    expect(card).not.toContain('任务正文');
  });

  it('允许从启动表单重新监督已停止的终端', () => {
    const card = JSON.stringify(buildSupervisorStartCard([
      { surfaceId: 'surf-stopped', label: 'pwsh.exe', workspace: '飞书管理', supervised: false, restartable: true },
    ]));

    expect(card).toContain('已停止，可重新监督');
  });

  it('兼容飞书两种表单回调包裹结构并按按钮名称恢复动作', () => {
    expect(parseFeishuCardFormValues({ action: { form_value: { terminal: ' surf-a ', task: '执行测试' } } })).toEqual({
      terminal: 'surf-a', task: '执行测试',
    });
    expect(parseFeishuCardFormValues({ event: { action: { form_value: { terminal: ['surf-b'] } } } })).toEqual({ terminal: 'surf-b' });
    expect(resolveFeishuCardAction(undefined, 'wmux_form_send')).toEqual({ wmux_action: 'form_send' });
    expect(resolveFeishuCardAction(undefined, 'wmux_form_create_task')).toEqual({ wmux_action: 'form_create_task' });
    expect(resolveFeishuCardAction(undefined, 'wmux_form_lane_control')).toEqual({ wmux_action: 'form_lane_control' });
    expect(resolveFeishuCardAction({ approval_id: 'appr-1' }, 'wmux_decide_approve')).toEqual({
      approval_id: 'appr-1', wmux_action: 'decide', decision: 'approve',
    });
    expect(resolveFeishuCardAction({ approval_id: 'appr-1' }, 'wmux_decide_pause')).toEqual({
      approval_id: 'appr-1', wmux_action: 'decide', decision: 'pause',
    });
    expect(resolveFeishuCardAction({ approval_id: 'appr-1' }, 'wmux_decide_reject')).toEqual({
      approval_id: 'appr-1', wmux_action: 'decide', decision: 'reject',
    });
  });

  it('使用 JSON 2.0 更新已处理卡片', () => {
    const card = buildSupervisorResultCard('已处理', '结果：approved', true) as {
      schema?: string; header?: { template?: string }; body?: { elements?: unknown[] }; elements?: unknown[];
    };

    expect(card.schema).toBe('2.0');
    expect(card.header?.template).toBe('green');
    expect(card.body?.elements).toBeInstanceOf(Array);
    expect(card.elements).toBeUndefined();
  });

  it('将终端列表渲染为适合飞书阅读的状态文本', () => {
    const response = formatFeishuSupervisorResponse(
      { action: 'list' },
      {
        ok: true,
        message: JSON.stringify({
          active: true,
          terminals: [
            {
              surfaceId: 'surf-supervised', label: 'pwsh.exe', workspace: '飞书管理', supervised: true,
              supervisionState: 'active', managementSessionId: 'sup-lane-auth', autonomous: true,
              autonomyPermissionCount: 2, forbiddenActionCount: 3, policyOverridden: true,
              activityState: 'working', activityUpdatedAt: Date.now(),
            },
            { surfaceId: 'surf-idle', label: 'pwsh.exe', workspace: '飞书管理', supervised: false, restartable: true, activityState: 'idle', activityUpdatedAt: Date.now() },
          ],
          session: { sessionId: 'sup-1', stopWhen: '验证飞书连接', autonomous: false },
          pendingApprovals: [],
        }),
      },
    );

    expect(response).toContain('wmux · AI 监督状态');
    expect(response).toContain('监督会话：进行中');
    expect(response).toContain('可监督终端：1 个');
    expect(response).toContain('监督模式：有限自主（低风险权限与小范围调整自动处理）');
    expect(response).toContain('1. pwsh.exe · 飞书管理');
    expect(response).toContain('状态：监督中');
    expect(response).toContain('状态：已停止，可重新监督');
    expect(response).toContain('任务终端：执行中');
    expect(response).toContain('任务终端：空闲');
    expect(response).toContain('终端 ID：surf-supervised');
    expect(response).toContain('管理会话 ID：sup-lane-auth');
    expect(response).toContain('权限：全自动 · 允许 2/4 · 禁止 3（终端专用）');
    expect(response).toContain('终端 ID：surf-idle');
    expect(response).toContain('点击“启动监督”或“发送任务”，即可从下拉列表选择终端。');
  });

  it('显示暂停但仍保留的监督会话', () => {
    const response = formatFeishuSupervisorResponse(
      { action: 'list' },
      {
        ok: true,
        message: JSON.stringify({
          active: false,
          paused: true,
          terminals: [
            { surfaceId: 'surf-paused', label: 'pwsh.exe', workspace: '飞书管理', supervised: true },
          ],
          session: { sessionId: 'sup-paused', stopWhen: '测试完成', autonomous: false },
          pendingApprovals: [],
        }),
      },
    );

    expect(response).toContain('监督会话：已暂停（会话已保留）');
    expect(response).toContain('状态：已暂停（会话已保留）');
    expect(response).toContain('会话 ID：sup-paused');
  });
});
