import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const larkMocks = vi.hoisted(() => ({
  createLarkChannel: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  createLarkChannel: larkMocks.createLarkChannel,
}));

import { FEISHU_CONTROL_CARD_VERSION, FeishuSupervisorService, isFeishuApprovalCardContext } from '../../src/main/feishu-supervisor';
import type { SupervisorRecord } from '../../src/main/supervisor-records';

interface MessageEvent {
  chatId: string;
  senderId: string;
  messageId: string;
  content: string;
  chatType: 'group' | 'p2p';
}

interface ChannelHandlers {
  message: (event: MessageEvent) => void;
  cardAction: (event: any) => void;
}

function currentControlValue(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value, wmux_card_version: FEISHU_CONTROL_CARD_VERSION };
}

function approvalRecord(approvalId: string): SupervisorRecord {
  return {
    sessionId: 'sup-1',
    projectDir: 'E:\\test',
    type: 'supervisor.approval.requested',
    terminal: { surfaceId: 'surf-1', label: 'pwsh.exe' },
    payload: {
      approvalId,
      reason: '需要用户决定发布方案',
      impact: '会影响对外文案',
      alternatives: '方案 A；方案 B',
    },
  };
}

describe('飞书人工决策单聊路由', () => {
  let handlers: ChannelHandlers;
  let send: ReturnType<typeof vi.fn>;
  let updateCard: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('WMUX_FEISHU_APP_ID', 'cli-test');
    vi.stubEnv('WMUX_FEISHU_APP_SECRET', 'secret-test');
    vi.stubEnv('WMUX_FEISHU_CHAT_ID', 'oc-audit');
    vi.stubEnv('WMUX_FEISHU_ALLOWED_OPEN_IDS', 'ou-allowed');
    vi.stubEnv('WMUX_FEISHU_CONTROL_CHAT_ID', '');
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', '');

    let messageSequence = 0;
    send = vi.fn(async () => ({ messageId: `om-${++messageSequence}` }));
    updateCard = vi.fn(async () => undefined);
    larkMocks.createLarkChannel.mockReturnValue({
      on: vi.fn((registered: ChannelHandlers) => { handlers = registered; }),
      connect: vi.fn(async () => undefined),
      send,
      updateCard,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('没有有效单聊时缓存审批，首次白名单单聊后再私发', async () => {
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();
    service.onRecord(approvalRecord('appr-queued'));

    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();

    handlers.message({
      chatId: 'oc-dm-a',
      senderId: 'ou-allowed',
      messageId: 'om-inbound-a',
      content: 'wmux帮助',
      chatType: 'p2p',
    });

    await vi.waitFor(() => {
      const approvalCall = send.mock.calls.find(([, payload]) => JSON.stringify(payload).includes('待人工决策'));
      expect(approvalCall?.[0]).toBe('oc-dm-a');
    });
    expect(send.mock.calls.some(([chatId]) => chatId === 'oc-audit')).toBe(false);
  });

  it('配置单聊会话后无需先发送帮助即可主动推送审批', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();

    service.onRecord(approvalRecord('appr-proactive'));

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toBe('oc-dm-configured');
    expect(JSON.stringify(send.mock.calls[0][1])).toContain('待人工决策');
  });

  it('暂停审批会保留原卡和待决项供继续后处理', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const control = vi.fn(async () => ({ ok: true, message: '已暂停当前 AI 监督，原待决项和决策卡均已保留。' }));
    const service = new FeishuSupervisorService(control);
    service.start();
    service.onRecord(approvalRecord('appr-pause'));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-configured',
      messageId: 'om-1',
      operator: { openId: 'ou-allowed' },
      action: {
        name: 'wmux_decide_pause',
        value: { wmux_action: 'decide', approval_id: 'appr-pause', decision: 'pause' },
      },
      raw: {},
    });

    await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(1));
    expect(control.mock.calls[0][0]).toMatchObject({
      action: 'decide', approvalId: 'appr-pause', decision: 'pause',
    });
    expect(updateCard).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][1]).toEqual({ text: '已暂停当前 AI 监督，原待决项和决策卡均已保留。' });
  });

  it('从管理卡暂停或继续全部监督并刷新首页状态', async () => {
    let paused = false;
    const control = vi.fn(async (command: { action: string }) => {
      if (command.action === 'pause-all') {
        paused = true;
        return { ok: true, message: '已暂停当前 AI 监督。' };
      }
      if (command.action === 'resume-all') {
        paused = false;
        return { ok: true, message: '已继续原 AI 监督会话。' };
      }
      return {
        ok: true,
        message: JSON.stringify({
          active: !paused,
          paused,
          terminals: [],
          session: { sessionId: 'sup-1', stopWhen: '完成测试', autonomous: false },
          pendingApprovals: [],
        }),
      };
    });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(send.mock.calls[0][1])).toContain('管理监督');

    handlers.cardAction({
      chatId: 'oc-dm-a',
      messageId: 'om-1',
      operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'manage' }) },
      raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('暂停全部');

    handlers.cardAction({
      chatId: 'oc-dm-a',
      messageId: 'om-1',
      operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'pause-all' }) },
      raw: {},
    });

    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'pause-all')).toBe(true));
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('已暂停当前 AI 监督。');
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('已暂停（上下文已保留）');
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('继续全部监督');

    handlers.cardAction({
      chatId: 'oc-dm-a',
      messageId: 'om-1',
      operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'resume-all', nonce: 'resume-now' }) },
      raw: {},
    });
    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'resume-all')).toBe(true));
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(updateCard.mock.calls[2][1])).toContain('已继续原 AI 监督会话。');
    expect(JSON.stringify(updateCard.mock.calls[2][1])).toContain('监督状态：进行中');
  });

  it('拒绝不带当前版本标识的旧控制卡', async () => {
    const control = vi.fn(async () => ({
      ok: true,
      message: JSON.stringify({
        active: true, paused: false, terminals: [], session: null, pendingApprovals: [],
      }),
    }));
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-old-card', content: 'wmux帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(control).toHaveBeenCalledTimes(1);

    handlers.cardAction({
      chatId: 'oc-dm-a',
      messageId: 'om-1',
      operator: { openId: 'ou-allowed' },
      action: { value: { wmux_action: 'menu', flow: 'toggle-pause' } },
      raw: {},
    });

    await Promise.resolve();
    expect(control).toHaveBeenCalledTimes(1);
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('从飞书控制卡只暂停所选 AI 监督通道', async () => {
    const control = vi.fn(async (command: { action: string; terminal?: string }) => {
      if (command.action === 'pause-lane') return { ok: true, message: '已暂停 Auth worker；其他通道继续运行。' };
      return {
        ok: true,
        message: JSON.stringify({
          active: true,
          paused: false,
          terminals: [{
            surfaceId: 'surf-a', label: 'Auth worker', workspace: 'workspace-a',
            supervised: true, supervisionState: 'active', managementSessionId: 'sup-lane-a',
          }],
          session: { sessionId: 'sup-1', stopWhen: '完成测试', autonomous: false },
          pendingApprovals: [],
        }),
      };
    });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-lane', content: 'wmux帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'manage' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('管理 AI 监督');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'lane_control', flow: 'pause-lane', terminal: 'surf-a' }) },
      raw: {},
    });
    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'pause-lane')).toBe(true));
    expect(control.mock.calls.find(([command]) => command.action === 'pause-lane')?.[0]).toEqual({
      action: 'pause-lane', terminal: 'surf-a',
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('停止全部监督前必须经过二次确认', async () => {
    const control = vi.fn(async (command: { action: string }) => {
      if (command.action === 'stop') return { ok: true, message: '已停止当前 AI 监督。' };
      return {
        ok: true,
        message: JSON.stringify({
          active: true,
          paused: false,
          terminals: [{ surfaceId: 'surf-a', label: 'Auth worker', workspace: 'workspace-a', supervised: true, supervisionState: 'active' }],
          session: { sessionId: 'sup-1', stopWhen: '完成测试', autonomous: false },
          pendingApprovals: [],
        }),
      };
    });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-stop', content: 'wmux帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'manage' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'stop-confirm' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('确认停止全部');
    expect(control.mock.calls.some(([command]) => command.action === 'stop')).toBe(false);

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'stop' }) }, raw: {},
    });
    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'stop')).toBe(true));
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('停止单个监督通道前必须经过二次确认', async () => {
    const control = vi.fn(async (command: { action: string; terminal?: string }) => {
      if (command.action === 'stop-lane') return { ok: true, message: '已停止 Auth worker 的 AI 监督。' };
      return {
        ok: true,
        message: JSON.stringify({
          active: true,
          paused: false,
          terminals: [{ surfaceId: 'surf-a', label: 'Auth worker', workspace: 'workspace-a', supervised: true, supervisionState: 'active' }],
          session: { sessionId: 'sup-1', stopWhen: '完成测试', autonomous: false },
          pendingApprovals: [],
        }),
      };
    });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-stop-lane', content: 'wmux帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'manage' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'stop_lane_confirm', flow: 'stop-lane', terminal: 'surf-a' }) },
      raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('confirm_stop_lane');
    expect(control.mock.calls.some(([command]) => command.action === 'stop-lane')).toBe(false);

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'confirm_stop_lane', terminal: 'surf-a' }) }, raw: {},
    });
    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'stop-lane')).toBe(true));
    expect(control.mock.calls.find(([command]) => command.action === 'stop-lane')?.[0]).toEqual({
      action: 'stop-lane', terminal: 'surf-a',
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('启动监督表单排除运行中和暂停保留的终端', async () => {
    const listMessage = JSON.stringify({
        active: true,
        paused: false,
        terminals: [
          { surfaceId: 'surf-active', label: 'Active worker', workspace: 'workspace-a', supervised: false, supervisionState: 'active' },
          { surfaceId: 'surf-paused', label: 'Paused worker', workspace: 'workspace-a', supervised: false, supervisionState: 'paused' },
          { surfaceId: 'surf-idle', label: 'Idle worker', workspace: 'workspace-a', supervised: false, supervisionState: 'none' },
          { surfaceId: 'surf-stopped', label: 'Stopped worker', workspace: 'workspace-a', supervised: false, restartable: true, supervisionState: 'stopped' },
        ],
        session: { sessionId: 'sup-1', stopWhen: '完成测试', autonomous: false },
        pendingApprovals: [],
      });
    const control = vi.fn(async (command: { action: string }) => command.action === 'start'
      ? { ok: true, message: '已添加 AI 监督终端。' }
      : { ok: true, message: listMessage });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-start', content: 'wmux帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'start' }) }, raw: {},
    });

    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    const startCard = JSON.stringify(updateCard.mock.calls[0][1]);
    expect(startCard).toContain('添加 AI 监督终端');
    expect(startCard).toContain('surf-idle');
    expect(startCard).toContain('surf-stopped');
    expect(startCard).not.toContain('surf-active');
    expect(startCard).not.toContain('surf-paused');

    const formNonce = /"wmux_action":"form_start"[^}]*"nonce":"([^"]+)"/.exec(startCard)?.[1];
    expect(formNonce).toBeTruthy();
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_start', value: currentControlValue({ wmux_action: 'form_start', nonce: formNonce }) },
      raw: { action: { form_value: { terminal: 'surf-idle', stop_when: '测试通过' } } },
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    const refreshedHome = JSON.stringify(updateCard.mock.calls[1][1]);
    expect(refreshedHome).toContain('已添加 AI 监督终端。');
    const refreshedStartNonce = /"wmux_action":"menu","flow":"start"[^}]*"nonce":"([^"]+)"/.exec(refreshedHome)?.[1];
    expect(refreshedStartNonce).toBeTruthy();
    expect(refreshedStartNonce).not.toBe(formNonce);

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'start', nonce: refreshedStartNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(updateCard.mock.calls[2][1])).toContain('添加 AI 监督终端');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('启动监督和发送任务表单可直接返回控制首页', async () => {
    const control = vi.fn(async () => ({
      ok: true,
      message: JSON.stringify({
        active: false,
        paused: false,
        terminals: [{ surfaceId: 'surf-idle', label: 'Worker', workspace: 'workspace-a', supervised: false, supervisionState: 'none' }],
        session: null,
        pendingApprovals: [],
      }),
    }));
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-back', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'start', nonce: 'open-start' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('返回控制首页');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'status', nonce: 'back-start' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('AI 监督控制');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'send', nonce: 'open-send' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(updateCard.mock.calls[2][1])).toContain('返回控制首页');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'status', nonce: 'back-send' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(4));
    expect(JSON.stringify(updateCard.mock.calls[3][1])).toContain('AI 监督控制');
    expect(control.mock.calls.every(([command]) => command.action === 'list')).toBe(true);
  });

  it('原地更新失败时降级发送替代控制卡', async () => {
    updateCard.mockRejectedValueOnce(new Error('patch failed'));
    const control = vi.fn(async () => ({
      ok: true,
      message: JSON.stringify({
        active: false, paused: false, terminals: [], session: null, pendingApprovals: [],
      }),
    }));
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-fallback', content: 'wmux帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'status', nonce: 'refresh-1' }) }, raw: {},
    });

    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(send.mock.calls[1][1])).toContain('AI 监督控制');
  });

  it('将新审批发送给最近联系机器人的白名单单聊', async () => {
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-inbound-a', content: 'wmux帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    handlers.message({
      chatId: 'oc-dm-b', senderId: 'ou-allowed', messageId: 'om-inbound-b', content: 'wmux帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send.mock.calls.some(([chatId]) => chatId === 'oc-dm-b')).toBe(true));
    send.mockClear();

    service.onRecord(approvalRecord('appr-latest'));

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toBe('oc-dm-b');
    expect(JSON.stringify(send.mock.calls[0][1])).toContain('待人工决策');
  });

  it('审批事件缺少 ID 时仍只发送到白名单单聊', async () => {
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-inbound-a', content: 'wmux帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    send.mockClear();

    service.onRecord({ ...approvalRecord('unused'), payload: { reason: '缺少审批 ID' } });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toBe('oc-dm-a');
    expect(send.mock.calls.some(([chatId]) => chatId === 'oc-audit')).toBe(false);
  });

  it('普通监督事件仍发送到审计群', async () => {
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();

    service.onRecord({
      sessionId: 'sup-1',
      projectDir: 'E:\\test',
      type: 'worker.lifecycle',
      terminal: { surfaceId: 'surf-1', label: 'pwsh.exe' },
      payload: { event: 'TurnComplete' },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toBe('oc-audit');
  });

  it('控制群中的 DECIDE 不执行且不回显决策内容', async () => {
    vi.stubEnv('WMUX_FEISHU_CONTROL_CHAT_ID', 'oc-control');
    const control = vi.fn(async () => ({ ok: true }));
    const service = new FeishuSupervisorService(control);
    service.start();

    handlers.message({
      chatId: 'oc-control',
      senderId: 'ou-allowed',
      messageId: 'om-group-decision',
      content: 'WMUX SUPERVISOR DECIDE\napproval_id: appr-secret\naction: reject',
      chatType: 'group',
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(control).not.toHaveBeenCalled();
    expect(send.mock.calls[0]).toEqual([
      'oc-control',
      { text: '人工决策仅支持白名单用户单聊。' },
    ]);
  });

  it('审批卡片只能从原始单聊和原始消息处理', () => {
    const card = { messageId: 'om-card', chatId: 'oc-dm-a' };

    expect(isFeishuApprovalCardContext(card, 'om-card', 'oc-dm-a')).toBe(true);
    expect(isFeishuApprovalCardContext(card, 'om-card', 'oc-dm-b')).toBe(false);
    expect(isFeishuApprovalCardContext(card, 'om-copy', 'oc-dm-a')).toBe(false);
  });
});
