import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const larkMocks = vi.hoisted(() => ({
  createLarkChannel: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  createLarkChannel: larkMocks.createLarkChannel,
}));

import { FeishuSupervisorService, isFeishuApprovalCardContext } from '../../src/main/feishu-supervisor';
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
