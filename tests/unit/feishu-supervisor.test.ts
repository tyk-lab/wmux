import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApprovalCard, formatFeishuSupervisorResponse, isFeishuSupervisorActorAllowed, loadFeishuEnvironment, parseFeishuDotEnv, parseFeishuSupervisorCommand, parseLegacyFeishuEnv } from '../../src/main/feishu-supervisor';

describe('飞书 AI 监督命令', () => {
  it('解析启动命令及可选监督配置', () => {
    expect(parseFeishuSupervisorCommand(`WMUX SUPERVISOR START
terminals: surf-a,surf-b
stop_when: npm test 通过
stop_when_kind: concrete
task_description: 仅补充结束条件
autonomous: on
supervisor_launch_cmd: kimi
supervisor_model: k3`)).toEqual({
      action: 'start',
      terminals: ['surf-a', 'surf-b'],
      stopWhen: 'npm test 通过',
      stopWhenKind: 'concrete',
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
    const card = JSON.stringify(buildApprovalCard({
      sessionId: 'sup-1', projectDir: 'E:\\test', type: 'supervisor.approval.requested',
      terminal: { surfaceId: 'surf-1', label: 'pwsh.exe' },
      payload: { approvalId: 'appr-1', alternatives: '用户选择方案 A；用户选择方案 B。' },
    }));

    expect(card).toContain('select_static');
    expect(card).toContain('选择方案 A');
    expect(card).toContain('选择方案 B');
    expect(card).toContain('follow_up_task');
    expect(card).toContain('批准并发送任务');
    expect(card).toContain('停止监督');
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
            { surfaceId: 'surf-idle', label: 'pwsh.exe', workspace: '飞书管理', supervised: false },
          ],
          session: { sessionId: 'sup-1', stopWhen: '验证飞书连接', autonomous: false },
          pendingApprovals: [],
        }),
      },
    );

    expect(response).toContain('wmux · AI 监督状态');
    expect(response).toContain('监督会话：进行中');
    expect(response).toContain('AI 自主决策：关闭');
    expect(response).toContain('1. pwsh.exe · 飞书管理');
    expect(response).toContain('状态：监督中');
    expect(response).toContain('终端 ID：surf-supervised');
    expect(response).toContain('终端 ID：surf-idle');
    expect(response).toContain('提示：复制“终端 ID”填写到 WMUX SUPERVISOR START 的 terminals 字段。');
  });
});
