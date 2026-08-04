import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApprovalCard, buildSupervisorControlMenuCard, buildSupervisorResultCard, buildSupervisorSendTaskCard, buildSupervisorStartCard, formatFeishuSupervisorAuditEvent, formatFeishuSupervisorResponse, isFeishuSupervisorActorAllowed, isFeishuSupervisorHelp, loadFeishuEnvironment, parseFeishuCardFormValues, parseFeishuDotEnv, parseFeishuSupervisorCommand, parseLegacyFeishuEnv, resolveFeishuCardAction } from '../../src/main/feishu-supervisor';

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
      error: '批准时需要 task，作为后续任务发送到被监督终端。',
    });
    expect(parseFeishuSupervisorCommand('WMUX SUPERVISOR DECIDE\napproval_id: appr-1\naction: shell')).toEqual({
      error: 'DECIDE 需要 approval_id 和 action: approve|reject|stop。',
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

  it('解析本机 .env 和首次配置用的标签值文件', () => {
    expect(parseFeishuDotEnv("WMUX_FEISHU_APP_ID=cli-test\nWMUX_FEISHU_CONTROL_CHAT_ID=oc-control\nWMUX_FEISHU_ENV_FILE='docs/env.txt'")).toEqual({
      WMUX_FEISHU_APP_ID: 'cli-test', WMUX_FEISHU_CONTROL_CHAT_ID: 'oc-control', WMUX_FEISHU_ENV_FILE: 'docs/env.txt',
    });
    expect(parseLegacyFeishuEnv('App ID\ncli-test\n\nApp Secret\nsecret-test\n\n单聊会话 ID\noc-direct\n\n群聊会话 ID\noc-audit\n\n用户 ID\nou-allowed')).toEqual({
      WMUX_FEISHU_APP_ID: 'cli-test', WMUX_FEISHU_APP_SECRET: 'secret-test',
      WMUX_FEISHU_CHAT_ID: 'oc-audit', WMUX_FEISHU_ALLOWED_OPEN_IDS: 'ou-allowed',
    });
  });

  it('从 .env 指向的本机飞书配置文件加载值且不覆盖启动器环境', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-feishu-env-'));
    try {
      fs.writeFileSync(path.join(directory, '.env'), 'WMUX_FEISHU_ENV_FILE=legacy.txt\n', 'utf8');
      fs.writeFileSync(path.join(directory, 'legacy.txt'), 'App ID\ncli-from-file\n\nApp Secret\nsecret-from-file\n\n群聊会话 ID\noc-audit\n\n用户 ID\nou-allowed\n', 'utf8');
      const env: NodeJS.ProcessEnv = { WMUX_FEISHU_APP_ID: 'cli-from-launcher' };

      loadFeishuEnvironment(env, directory, path.join(directory, 'wmux.exe'));

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

      loadFeishuEnvironment(env, directory, executableDir);

      expect(env.WMUX_FEISHU_APP_ID).toBe('cli-from-exe-dir');
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
    expect(card).toContain('批准并发送任务');
    expect(card).toContain('停止监督');
  });

  it('将日常控制渲染为菜单、启动表单和任务表单', () => {
    const terminals = [{ surfaceId: 'surf-a', label: 'pwsh.exe', workspace: '飞书管理', supervised: false }];
    const menu = JSON.stringify(buildSupervisorControlMenuCard());
    const startObject = buildSupervisorStartCard(terminals) as { schema?: string; body?: { elements?: unknown[] }; elements?: unknown[] };
    const sendObject = buildSupervisorSendTaskCard(terminals) as { schema?: string; body?: { elements?: unknown[] }; elements?: unknown[] };
    const start = JSON.stringify(startObject);
    const send = JSON.stringify(sendObject);

    expect(menu).toContain('查看状态');
    expect(menu).toContain('启动监督');
    expect(menu).toContain('发送任务');
    expect(menu).toContain('停止监督');
    expect(menu).toContain('白名单用户单聊');
    expect(menu).not.toContain('审批卡片发送到审计群');
    expect(startObject.schema).toBe('2.0');
    expect(startObject.body?.elements).toBeInstanceOf(Array);
    expect(startObject.elements).toBeUndefined();
    expect(sendObject.schema).toBe('2.0');
    expect(sendObject.body?.elements).toBeInstanceOf(Array);
    expect(sendObject.elements).toBeUndefined();
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
    expect(start).toContain('surf-a');
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
    expect(resolveFeishuCardAction({ approval_id: 'appr-1' }, 'wmux_decide_approve')).toEqual({
      approval_id: 'appr-1', wmux_action: 'decide', decision: 'approve',
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
            { surfaceId: 'surf-supervised', label: 'pwsh.exe', workspace: '飞书管理', supervised: true },
            { surfaceId: 'surf-idle', label: 'pwsh.exe', workspace: '飞书管理', supervised: false, restartable: true },
          ],
          session: { sessionId: 'sup-1', stopWhen: '验证飞书连接', autonomous: false },
          pendingApprovals: [],
        }),
      },
    );

    expect(response).toContain('wmux · AI 监督状态');
    expect(response).toContain('监督会话：进行中');
    expect(response).toContain('监督模式：有限自主（低风险权限与小范围调整自动处理）');
    expect(response).toContain('1. pwsh.exe · 飞书管理');
    expect(response).toContain('状态：监督中');
    expect(response).toContain('状态：已停止，可重新监督');
    expect(response).toContain('终端 ID：surf-supervised');
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
