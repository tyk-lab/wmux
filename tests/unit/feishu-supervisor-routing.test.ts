import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const larkMocks = vi.hoisted(() => ({
  createLarkChannel: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  createLarkChannel: larkMocks.createLarkChannel,
}));

import { FEISHU_CONTROL_CARD_VERSION, FeishuSupervisorService, isFeishuApprovalCardContext } from '../../src/main/feishu-supervisor';
import type { SupervisorRecord } from '../../src/main/supervisor-records';
import {
  USER_RECORDS_TERMINAL_AGENT,
  USER_RECORDS_TERMINAL_NAME,
  USER_RECORDS_TERMINAL_STARTUP_INPUT,
} from '../../src/shared/user-records-terminal';

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

function waitingRecord(): SupervisorRecord {
  return {
    sessionId: 'sup-1',
    projectDir: 'E:\\test',
    type: 'supervisor.waiting-for-direction',
    terminal: { surfaceId: 'surf-1', label: '测试终端' },
    payload: {
      reason: '当前阶段测试已经通过',
      taskGoal: '完成当前阶段测试',
      stopWhen: '当前阶段测试通过',
    },
  };
}

function providerLimitRecord(): SupervisorRecord {
  return {
    sessionId: 'sup-1',
    projectDir: 'E:\\test',
    type: 'supervisor.provider-limit',
    terminal: { surfaceId: 'surf-1', label: '测试终端' },
    payload: {
      category: 'rate-limit',
      summary: 'Error: request failed with status code 429',
      supervisorModel: 'gpt-limited',
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
    vi.stubEnv('WMUX_FEISHU_PROJECT_MANAGER_CHAT_ID', '');

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
      const approvalCall = send.mock.calls.find(([, payload]) => JSON.stringify(payload).includes('采用 AI 方案'));
      expect(approvalCall?.[0]).toBe('oc-dm-a');
    });
    await vi.waitFor(() => expect(send.mock.calls.filter(([chatId]) => chatId === 'oc-audit')).toHaveLength(2));
  });

  it('配置单聊会话后无需先发送帮助即可主动推送审批', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();

    service.onRecord(approvalRecord('appr-proactive'));

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const approvalCall = send.mock.calls.find(([, payload]) => JSON.stringify(payload).includes('采用 AI 方案'));
    expect(approvalCall?.[0]).toBe('oc-dm-configured');
    expect(send.mock.calls.filter(([chatId]) => chatId === 'oc-audit')).toHaveLength(2);
  });

  it('项目人工介入在没有项目群配置时缓存，并在首次白名单单聊后发送决策卡', async () => {
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();
    service.onProjectManagerRecord({
      sessionId: 'pm-dm-queued', projectDir: 'E:\\repo', type: 'user-clarification-requested',
      payload: {
        question: {
          id: 'question-dm-queued', category: 'manual-intervention', workItemId: 'deploy',
          blocker: '需要用户授权生产发布', question: '是否授权发布到生产？',
          options: [{ id: 'wait', label: '暂不发布', description: '继续在预发布环境验证。' }, { id: 'deploy', label: '授权发布', description: '执行已验证的生产发布流程。' }],
          recommendedOptionId: 'wait',
        },
      },
    });

    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    handlers.message({
      chatId: 'oc-dm-project', senderId: 'ou-allowed', messageId: 'om-project-dm',
      content: '帮助', chatType: 'p2p',
    });

    await vi.waitFor(() => {
      const card = send.mock.calls.find(([, payload]) => JSON.stringify(payload).includes('是否授权发布到生产'));
      expect(card?.[0]).toBe('oc-dm-project');
    });
  });

  it('项目人工介入使用监督决策私聊，任一渠道答复后关闭同一张飞书卡片', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true, message: '已记录用户答复' })));
    service.start();
    service.onProjectManagerRecord({
      sessionId: 'pm-dm', projectDir: 'E:\\repo', type: 'user-clarification-requested',
      payload: {
        question: {
          id: 'question-dm', category: 'manual-intervention', workItemId: 'deploy',
          blocker: '需要用户授权生产发布', question: '是否授权发布到生产？',
          options: [{ id: 'wait', label: '暂不发布', description: '继续在预发布环境验证。' }, { id: 'deploy', label: '授权发布', description: '执行已验证的生产发布流程。' }],
          recommendedOptionId: 'wait',
        },
      },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toBe('oc-dm-configured');
    expect(JSON.stringify(send.mock.calls[0][1])).toContain('项目阻塞，需要你的指示');
    service.onProjectManagerRecord({
      sessionId: 'pm-dm', projectDir: 'E:\\repo', type: 'user-clarification-answered',
      payload: { questionId: 'question-dm', answer: '暂不发布', answeredBy: 'desktop' },
    });

    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('项目确认已提交');
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('暂不发布');
  });

  it('待续通道主动发送包含 AI 监督核心信息的决策卡，并可提交新方案继续', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const control = vi.fn(async (command: { action: string }) => {
      if (command.action === 'supervisor-screen') {
        return {
          ok: true,
          answer: 'AI 监督核心结论：当前阶段已完成，等待用户确定下一步。',
          text: 'Ran Get-Content\n工具调用噪声\n任务终端原始结构',
        };
      }
      return { ok: true, message: '已将新方案发送给 AI 监督终端，并恢复监督。' };
    });
    const service = new FeishuSupervisorService(control);
    service.start();

    service.onRecord(waitingRecord());

    await vi.waitFor(() => {
      const waitingCall = send.mock.calls.find(([chatId, payload]) => (
        chatId === 'oc-dm-configured' && JSON.stringify(payload).includes('通道待续')
      ));
      expect(waitingCall?.[0]).toBe('oc-dm-configured');
      const card = JSON.stringify(waitingCall?.[1]);
      expect(card).toContain('当前阶段测试已经通过');
      expect(card).toContain('AI 监督核心结论：当前阶段已完成');
      expect(card).toContain('保持待续');
      expect(card).toContain('按原目标继续监督');
      expect(card).toContain('提交新方案并继续');
      expect(card).toContain('停止此监督');
      expect(card).not.toContain('工具调用噪声');
      expect(card).not.toContain('任务终端原始结构');
    });
    expect(control).toHaveBeenCalledWith({
      action: 'supervisor-screen', terminal: 'surf-1', lines: 100,
    }, { openId: 'wmux-system', source: 'system' });
    await vi.waitFor(() => expect(send.mock.calls.filter(([chatId]) => chatId === 'oc-audit')).toHaveLength(2));

    const waitingCallIndex = send.mock.calls.findIndex(([chatId, payload]) => (
      chatId === 'oc-dm-configured' && JSON.stringify(payload).includes('通道待续')
    ));
    handlers.cardAction({
      chatId: 'oc-dm-configured',
      messageId: `om-${waitingCallIndex + 1}`,
      operator: { openId: 'ou-allowed' },
      action: {
        name: 'wmux_waiting_submit',
        value: { wmux_action: 'waiting_decision', terminal: 'surf-1', decision: 'submit' },
      },
      raw: { action: { form_value: { waiting_direction: '  ' } } },
    });
    await vi.waitFor(() => expect(send.mock.calls.some(([, payload]) => (
      JSON.stringify(payload).includes('请先填写新方案或下一步方向')
    ))).toBe(true));
    expect(control.mock.calls.some(([command]) => command.action === 'waiting-decision')).toBe(false);

    handlers.cardAction({
      chatId: 'oc-dm-configured',
      messageId: `om-${waitingCallIndex + 1}`,
      operator: { openId: 'ou-allowed' },
      action: {
        name: 'wmux_waiting_submit',
        value: { wmux_action: 'waiting_decision', terminal: 'surf-1', decision: 'submit' },
      },
      raw: { action: { form_value: { waiting_direction: ' 改为先补齐回归测试，再检查发布条件 ' } } },
    });

    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'waiting-decision')).toBe(true));
    expect(control.mock.calls.find(([command]) => command.action === 'waiting-decision')?.[0]).toEqual({
      action: 'waiting-decision',
      terminal: 'surf-1',
      decision: 'submit',
      message: '改为先补齐回归测试，再检查发布条件',
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
  });

  it('通道从其他入口恢复后使旧待续卡失效，并明确提示重放点击', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const control = vi.fn(async (command: { action: string }) => command.action === 'supervisor-screen'
      ? { ok: true, answer: '当前阶段已完成，等待下一步。' }
      : { ok: true });
    const service = new FeishuSupervisorService(control);
    service.start();
    service.onRecord(waitingRecord());

    await vi.waitFor(() => expect(send.mock.calls.some(([chatId, payload]) => (
      chatId === 'oc-dm-configured' && JSON.stringify(payload).includes('通道待续')
    ))).toBe(true));
    const waitingCallIndex = send.mock.calls.findIndex(([chatId, payload]) => (
      chatId === 'oc-dm-configured' && JSON.stringify(payload).includes('通道待续')
    ));
    const waitingMessageId = `om-${waitingCallIndex + 1}`;

    service.onRecord({
      ...waitingRecord(),
      type: 'supervisor.waiting-resumed',
      payload: { source: 'supervisor-terminal' },
    });
    await vi.waitFor(() => expect(updateCard.mock.calls.some(([messageId, card]) => (
      messageId === waitingMessageId && JSON.stringify(card).includes('待续卡已失效')
    ))).toBe(true));

    handlers.cardAction({
      chatId: 'oc-dm-configured',
      messageId: waitingMessageId,
      operator: { openId: 'ou-allowed' },
      action: {
        name: 'wmux_waiting_resume',
        value: { wmux_action: 'waiting_decision', terminal: 'surf-1', decision: 'resume' },
      },
      raw: {},
    });
    await vi.waitFor(() => expect(send.mock.calls.some(([, payload]) => (
      JSON.stringify(payload).includes('待续卡已过期或 wmux 已重启')
    ))).toBe(true));
    expect(control.mock.calls.some(([command]) => command.action === 'waiting-decision')).toBe(false);
  });

  it('新方向信息不足再次待续时重新发送最新待续卡', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const control = vi.fn(async (command: { action: string }) => command.action === 'supervisor-screen'
      ? { ok: true, answer: '新方向信息不足，请补充明确目标和验收条件。' }
      : { ok: true });
    const service = new FeishuSupervisorService(control);
    service.start();
    const firstWaiting = waitingRecord();
    service.onRecord(firstWaiting);

    await vi.waitFor(() => expect(send.mock.calls.filter(([chatId, payload]) => (
      chatId === 'oc-dm-configured' && JSON.stringify(payload).includes('通道待续')
    ))).toHaveLength(1));
    service.onRecord({
      ...firstWaiting,
      type: 'supervisor.waiting-resumed',
      payload: { source: 'remote-supervisor-message' },
    });
    service.onRecord({
      ...firstWaiting,
      ts: firstWaiting.ts + 2,
      payload: { ...firstWaiting.payload, reason: '新方向信息不足，等待用户补充' },
    });

    await vi.waitFor(() => expect(send.mock.calls.filter(([chatId, payload]) => (
      chatId === 'oc-dm-configured' && JSON.stringify(payload).includes('通道待续')
    ))).toHaveLength(2));
    const waitingCards = send.mock.calls.filter(([chatId, payload]) => (
      chatId === 'oc-dm-configured' && JSON.stringify(payload).includes('通道待续')
    ));
    expect(JSON.stringify(waitingCards[1][1])).toContain('新方向信息不足，等待用户补充');
  });

  it('监督模型限流时通过人工决策单聊主动告警', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();

    service.onRecord(providerLimitRecord());

    await vi.waitFor(() => {
      const alertCall = send.mock.calls.find(([chatId, payload]) => (
        chatId === 'oc-dm-configured' && JSON.stringify(payload).includes('模型请求受限')
      ));
      expect(alertCall?.[0]).toBe('oc-dm-configured');
      expect(JSON.stringify(alertCall?.[1])).toContain('status code 429');
      expect(JSON.stringify(alertCall?.[1])).toContain('gpt-limited');
    });
    await vi.waitFor(() => expect(send.mock.calls.filter(([chatId]) => chatId === 'oc-audit')).toHaveLength(2));
  });

  it('发送决策卡前读取任务终端核心信息和 AI 原建议', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const control = vi.fn(async (command: { action: string }) => command.action === 'decision-context'
      ? { ok: true, recommendation: '保留现有接口并补齐适配层', terminalScreen: '核心结论：测试仍有 1 项失败。' }
      : { ok: true });
    const service = new FeishuSupervisorService(control);
    service.start();
    service.onRecord(approvalRecord('appr-context'));

    await vi.waitFor(() => {
      const approvalCall = send.mock.calls.find(([, payload]) => JSON.stringify(payload).includes('采用 AI 方案'));
      const card = JSON.stringify(approvalCall?.[1]);
      expect(card).toContain('保留现有接口并补齐适配层');
      expect(card).toContain('任务终端核心信息');
      expect(card).toContain('核心结论：测试仍有 1 项失败。');
    });
    expect(control).toHaveBeenCalledWith({
      action: 'decision-context', approvalId: 'appr-context', terminal: 'surf-1', lines: 100,
    }, { openId: 'wmux-system', source: 'system' });
    expect(send.mock.calls
      .filter(([chatId]) => chatId === 'oc-audit')
      .some(([, payload]) => JSON.stringify(payload).includes('核心结论：测试仍有 1 项失败。'))).toBe(false);
  });

  it('暂停审批会保留原卡和待决项供继续后处理', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const control = vi.fn(async () => ({ ok: true, message: '已暂停当前 AI 监督，原待决项和决策卡均已保留。' }));
    const service = new FeishuSupervisorService(control);
    service.start();
    service.onRecord(approvalRecord('appr-pause'));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const approvalCallIndex = send.mock.calls.findIndex(([, payload]) => JSON.stringify(payload).includes('采用 AI 方案'));
    expect(approvalCallIndex).toBeGreaterThanOrEqual(0);

    handlers.cardAction({
      chatId: 'oc-dm-configured',
      messageId: `om-${approvalCallIndex + 1}`,
      operator: { openId: 'ou-allowed' },
      action: {
        name: 'wmux_decide_pause',
        value: { wmux_action: 'decide', approval_id: 'appr-pause', decision: 'pause' },
      },
      raw: {},
    });

    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'decide')).toBe(true));
    expect(control.mock.calls.find(([command]) => command.action === 'decide')?.[0]).toMatchObject({
      action: 'decide', approvalId: 'appr-pause', decision: 'pause',
    });
    expect(updateCard).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    expect(send.mock.calls.some(([, payload]) => JSON.stringify(payload).includes('已暂停当前 AI 监督'))).toBe(true);
  });

  it('将飞书选中的 AI 方案交给监督端整理', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const control = vi.fn(async () => ({
      ok: true,
      message: '已选择 方案 B；AI 监督将整理后发送到任务终端。',
    }));
    const service = new FeishuSupervisorService(control);
    service.start();
    service.onRecord(approvalRecord('appr-select'));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const approvalCallIndex = send.mock.calls.findIndex(([, payload]) => JSON.stringify(payload).includes('采用 AI 方案'));
    expect(approvalCallIndex).toBeGreaterThanOrEqual(0);

    handlers.cardAction({
      chatId: 'oc-dm-configured',
      messageId: `om-${approvalCallIndex + 1}`,
      operator: { openId: 'ou-allowed' },
      action: {
        name: 'wmux_decide_approve',
        value: { wmux_action: 'decide', approval_id: 'appr-select', decision: 'approve' },
      },
      raw: { action: { form_value: { decision_choice: '方案 B' } } },
    });

    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'decide')).toBe(true));
    expect(control.mock.calls.find(([command]) => command.action === 'decide')?.[0]).toEqual({
      action: 'decide', approvalId: 'appr-select', decision: 'approve', selection: '方案 B',
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
  });

  it('决策校验失败后刷新原卡并允许再次提交', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    let decisionAttempts = 0;
    const control = vi.fn(async (command: { action: string }) => {
      if (command.action === 'decision-context') return { ok: true };
      if (command.action === 'decide') {
        decisionAttempts += 1;
        return decisionAttempts === 1
          ? { ok: false, error: 'AI 监督提供了多个方案，请先选择其中一个方案。' }
          : { ok: true, message: '已选择 方案 B；AI 监督将整理后发送到任务终端。' };
      }
      return { ok: true };
    });
    const service = new FeishuSupervisorService(control);
    service.start();
    service.onRecord(approvalRecord('appr-retry'));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const approvalCallIndex = send.mock.calls.findIndex(([, payload]) => (
      JSON.stringify(payload).includes('确认并采用 AI 方案')
    ));
    const messageId = `om-${approvalCallIndex + 1}`;

    handlers.cardAction({
      chatId: 'oc-dm-configured',
      messageId,
      operator: { openId: 'ou-allowed' },
      action: {
        name: 'wmux_decide_approve',
        value: { wmux_action: 'decide', approval_id: 'appr-retry', decision: 'approve' },
      },
      raw: { action: { form_value: { decision_input: '进入待续状态' } } },
    });

    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    const refreshedCard = JSON.stringify(updateCard.mock.calls[0][1]);
    expect(refreshedCard).toContain('未提交：AI 监督提供了多个方案，请先选择其中一个方案。');
    expect(refreshedCard).toContain('确认并采用 AI 方案');
    expect(refreshedCard).toContain('进入待续状态');

    handlers.cardAction({
      chatId: 'oc-dm-configured',
      messageId,
      operator: { openId: 'ou-allowed' },
      action: {
        name: 'wmux_decide_approve',
        value: { wmux_action: 'decide', approval_id: 'appr-retry', decision: 'approve' },
      },
      raw: { action: { form_value: { decision_choice: '方案 B', decision_input: '进入待续状态' } } },
    });

    await vi.waitFor(() => expect(decisionAttempts).toBe(2));
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    expect(control.mock.calls.filter(([command]) => command.action === 'decide')).toHaveLength(2);
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('人工决策已处理');
  });

  it('采用 AI 当前方案时将飞书填写的信息交给监督端整理', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const control = vi.fn(async () => ({
      ok: true,
      message: '已将用户决策信息交给 AI 监督；AI 监督将整理后发送到任务终端。',
    }));
    const service = new FeishuSupervisorService(control);
    service.start();
    const record = approvalRecord('appr-guidance');
    service.onRecord({ ...record, payload: { ...record.payload, alternatives: '', recommendation: '' } });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const approvalCallIndex = send.mock.calls.findIndex(([, payload]) => JSON.stringify(payload).includes('采用 AI 当前方案'));

    handlers.cardAction({
      chatId: 'oc-dm-configured',
      messageId: `om-${approvalCallIndex + 1}`,
      operator: { openId: 'ou-allowed' },
      action: {
        name: 'wmux_decide_approve',
        value: { wmux_action: 'decide', approval_id: 'appr-guidance', decision: 'approve' },
      },
      raw: { action: { form_value: { decision_input: ' 保持现有 API，先补充回归测试 ' } } },
    });

    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'decide')).toBe(true));
    expect(control.mock.calls.find(([command]) => command.action === 'decide')?.[0]).toEqual({
      action: 'decide',
      approvalId: 'appr-guidance',
      decision: 'approve',
      task: '保持现有 API，先补充回归测试',
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
  });

  it('将飞书填写的用户决策直接交给任务终端', async () => {
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-dm-configured');
    const control = vi.fn(async () => ({
      ok: true,
      message: '已将用户决策直接发送到 pwsh.exe，并记录为人工裁决。',
    }));
    const service = new FeishuSupervisorService(control);
    service.start();
    service.onRecord(approvalRecord('appr-direct'));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const approvalCallIndex = send.mock.calls.findIndex(([, payload]) => JSON.stringify(payload).includes('直接发送用户输入'));
    expect(approvalCallIndex).toBeGreaterThanOrEqual(0);

    handlers.cardAction({
      chatId: 'oc-dm-configured',
      messageId: `om-${approvalCallIndex + 1}`,
      operator: { openId: 'ou-allowed' },
      action: {
        name: 'wmux_decide_direct',
        value: { wmux_action: 'decide', approval_id: 'appr-direct', decision: 'direct' },
      },
      raw: { action: { form_value: { decision_choice: '方案 B', decision_input: ' 保持现有 API，先补充回归测试 ' } } },
    });

    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'decide')).toBe(true));
    expect(control.mock.calls.find(([command]) => command.action === 'decide')?.[0]).toEqual({
      action: 'decide',
      approvalId: 'appr-direct',
      decision: 'direct',
      task: '保持现有 API，先补充回归测试',
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
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

  it('不执行缺少版本标识的旧操作并发送当前控制卡', async () => {
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

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(control).toHaveBeenCalledTimes(2);
    expect(control.mock.calls.every(([command]) => command.action === 'list')).toBe(true);
    expect(JSON.stringify(send.mock.calls[1][1])).toContain(`"wmux_card_version":"${FEISHU_CONTROL_CARD_VERSION}"`);
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
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('任务与监督控制');

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
    expect(JSON.stringify(updateCard.mock.calls[3][1])).toContain('任务与监督控制');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'project-manager', nonce: 'open-project-manager' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(5));
    const projectManagerCard = JSON.stringify(updateCard.mock.calls[4][1]);
    expect(projectManagerCard).toContain('wmux · 项目组合');
    expect(projectManagerCard).toContain('选择项目进入工作台');
    expect(projectManagerCard).not.toContain('启动项目管理 AI');
    expect(projectManagerCard).not.toContain('项目管理终端');
    expect(control.mock.calls.some(([command]) => command.action === 'project-status')).toBe(true);
    expect(control.mock.calls.every(([command]) => ['list', 'project-status'].includes(command.action))).toBe(true);
  });

  it('可从控制首页查看并刷新监督状态和监督日志', async () => {
    const listMessage = JSON.stringify({
      active: true,
      paused: false,
      terminals: [{
        surfaceId: 'surf-a', label: 'Codex任务', workspace: 'workspace-a', supervised: true,
        supervisionState: 'active', activityState: 'working', activityUpdatedAt: Date.now(),
      }],
      session: { sessionId: 'sup-1', stopWhen: '完成测试', autonomous: false },
      pendingApprovals: [],
    });
    const logMessage = JSON.stringify({
      active: true,
      paused: false,
      sessionId: 'sup-1',
      entries: [{ ts: Date.now(), laneLabel: 'Codex任务', action: '任务完成', detail: '测试已通过' }],
    });
    const control = vi.fn(async (command: { action: string }) => ({
      ok: true,
      message: command.action === 'logs' ? logMessage : listMessage,
    }));
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-observe', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'detail-status', nonce: 'status-1' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('AI 监督状态');
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('Codex任务');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'logs', nonce: 'logs-1' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('AI 监督日志');
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('测试已通过');
    expect(control.mock.calls.some(([command]) => command.action === 'logs')).toBe(true);
  });

  it('从控制首页创建 Codex 直连终端任务并返回最新首页', async () => {
    const listMessage = JSON.stringify({
      active: false,
      paused: false,
      terminals: [
        { surfaceId: 'surf-direct', label: 'Kimi直连 · 修复登录页', workspaceId: 'ws-direct', workspace: '修复登录页', cwd: 'E:\\repo', supervised: false, supervisionState: 'none' },
        { surfaceId: 'surf-duplicate', label: 'Codex直连 · 同目录', workspaceId: 'ws-duplicate', workspace: '同目录', cwd: 'e:/repo/', supervised: false, supervisionState: 'none' },
        { surfaceId: 'surf-other', label: 'Grok直连 · 其他目录', workspaceId: 'ws-other', workspace: '其他目录', cwd: 'D:\\other', supervised: false, supervisionState: 'none' },
      ],
      session: null,
      pendingApprovals: [],
    });
    const control = vi.fn(async (command: { action: string; agent?: string }) => command.action === 'create-task'
      ? { ok: true, message: `已创建 ${command.agent === 'kimi' ? 'Kimi' : 'Codex'} 直连终端“修复登录页”。` }
      : { ok: true, message: listMessage });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-create', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'create-task', nonce: 'open-create' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    const createCardObject = updateCard.mock.calls[0][1] as any;
    const createCard = JSON.stringify(createCardObject);
    const taskForm = createCardObject.body.elements.find((element: any) => element.name === 'wmux_create_task_form');
    const sessionSelect = taskForm.elements.find((element: any) => element.name === 'session_target');
    const pathSelect = taskForm.elements.find((element: any) => element.name === 'path_terminal');
    const serializedPathOptions = JSON.stringify(pathSelect.options);
    expect(createCard).toContain('添加 AI 终端任务');
    expect(createCard).toContain('Codex（默认）');
    expect(sessionSelect.options).toEqual([
      { text: { tag: 'plain_text', content: '新建独立会话（默认）' }, value: 'new' },
      { text: { tag: 'plain_text', content: '已有会话：修复登录页' }, value: 'workspace:ws-direct' },
      { text: { tag: 'plain_text', content: '已有会话：同目录' }, value: 'workspace:ws-duplicate' },
      { text: { tag: 'plain_text', content: '已有会话：其他目录' }, value: 'workspace:ws-other' },
    ]);
    expect(serializedPathOptions).toContain('E:\\\\repo');
    expect(serializedPathOptions).toContain('D:\\\\other');
    expect(serializedPathOptions).not.toContain('surf-duplicate');
    expect(control).toHaveBeenCalledTimes(2);

    const formNonce = /"wmux_action":"form_create_task"[^}]*"nonce":"([^"]+)"/.exec(createCard)?.[1];
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_create_task', value: currentControlValue({ wmux_action: 'form_create_task', nonce: formNonce }) },
      raw: { action: { form_value: { task_name: '修复登录页', agent: 'kimi', session_target: 'workspace:ws-other', path_terminal: 'surf-direct', task: '检查登录流程并修复测试' } } },
    });

    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'create-task')).toBe(true));
    expect(control.mock.calls.find(([command]) => command.action === 'create-task')?.[0]).toEqual({
      action: 'create-task', name: '修复登录页', task: '检查登录流程并修复测试', agent: 'kimi', cwd: 'E:\\repo', anchorWorkspace: 'ws-other',
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    const refreshedHome = JSON.stringify(updateCard.mock.calls[1][1]);
    expect(refreshedHome).toContain('已创建 Kimi 直连终端');
    expect(refreshedHome).toContain('可添加终端 3 个');

    const reopenNonce = /"wmux_action":"menu","flow":"create-task"[^}]*"nonce":"([^"]+)"/.exec(refreshedHome)?.[1];
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'create-task', nonce: reopenNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    const defaultCard = JSON.stringify(updateCard.mock.calls[2][1]);
    const defaultFormNonce = /"wmux_action":"form_create_task"[^}]*"nonce":"([^"]+)"/.exec(defaultCard)?.[1];
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_create_task', value: currentControlValue({ wmux_action: 'form_create_task', nonce: defaultFormNonce }) },
      raw: { action: { form_value: { task_name: '默认模型任务', task: '验证默认使用 Codex' } } },
    });
    await vi.waitFor(() => expect(control.mock.calls.filter(([command]) => command.action === 'create-task')).toHaveLength(2));
    expect(control.mock.calls.filter(([command]) => command.action === 'create-task').at(-1)?.[0]).toMatchObject({
      action: 'create-task', agent: 'codex',
    });
    expect(control.mock.calls.filter(([command]) => command.action === 'create-task').at(-1)?.[0]).not.toHaveProperty('cwd');
    expect(control.mock.calls.filter(([command]) => command.action === 'create-task').at(-1)?.[0]).not.toHaveProperty('anchorWorkspace');
  });

  it('从控制首页创建独立的用户记录特别终端', async () => {
    const listMessage = JSON.stringify({
      active: false,
      paused: false,
      terminals: [],
      session: null,
      pendingApprovals: [],
    });
    const control = vi.fn(async (command: { action: string }) => command.action === 'create-task'
      ? { ok: true, message: '已创建用户记录终端。' }
      : { ok: true, message: listMessage });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-special', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'special-terminal', nonce: 'open-special' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    const specialCard = JSON.stringify(updateCard.mock.calls[0][1]);
    expect(specialCard).toContain('创建特别终端');
    expect(specialCard).toContain(USER_RECORDS_TERMINAL_NAME);
    expect(specialCard).toContain('$user-data-management');

    const formNonce = /"wmux_action":"form_create_user_records_terminal"[^}]*"nonce":"([^"]+)"/.exec(specialCard)?.[1];
    expect(formNonce).toBeTruthy();
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: {
        name: 'wmux_form_create_user_records_terminal',
        value: currentControlValue({ wmux_action: 'form_create_user_records_terminal', nonce: formNonce }),
      },
      raw: { action: { form_value: {} } },
    });

    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'create-task')).toBe(true));
    expect(control.mock.calls.find(([command]) => command.action === 'create-task')?.[0]).toEqual({
      action: 'create-task',
      name: USER_RECORDS_TERMINAL_NAME,
      task: USER_RECORDS_TERMINAL_STARTUP_INPUT,
      agent: USER_RECORDS_TERMINAL_AGENT,
      preset: 'user-records',
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('已创建用户记录终端。');
  });

  it('选择的已有会话已关闭时不创建任务目录或终端', async () => {
    let listCalls = 0;
    const control = vi.fn(async (command: { action: string }) => {
      if (command.action !== 'list') return { ok: true, message: '不应创建任务' };
      listCalls += 1;
      return {
        ok: true,
        message: JSON.stringify({
          active: false,
          paused: false,
          terminals: listCalls <= 2
            ? [{ surfaceId: 'surf-session', label: 'Codex任务', workspaceId: 'ws-session', workspace: '项目', cwd: 'E:\\repo', supervised: false }]
            : [],
          session: null,
          pendingApprovals: [],
        }),
      };
    });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-stale-session', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'create-task', nonce: 'open-stale-session' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    const card = JSON.stringify(updateCard.mock.calls[0][1]);
    const nonce = /"wmux_action":"form_create_task"[^}]*"nonce":"([^"]+)"/.exec(card)?.[1];

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_create_task', value: currentControlValue({ wmux_action: 'form_create_task', nonce }) },
      raw: { action: { form_value: { task_name: '新任务', task: '执行任务', session_target: 'workspace:ws-session' } } },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(send.mock.calls[1][1])).toContain('所选会话已关闭或不可用');
    expect(control.mock.calls.some(([command]) => command.action === 'create-task')).toBe(false);
  });

  it('选择路径的终端已关闭时要求刷新卡片且不创建任务', async () => {
    let listCalls = 0;
    const listMessage = (terminals: unknown[]) => JSON.stringify({
      active: false, paused: false, terminals, session: null, pendingApprovals: [],
    });
    const control = vi.fn(async (command: { action: string }) => {
      if (command.action !== 'list') return { ok: true, message: '不应创建任务' };
      listCalls += 1;
      return {
        ok: true,
        message: listMessage(listCalls <= 2
          ? [{ surfaceId: 'surf-path', label: 'Codex任务', workspace: '项目', cwd: 'E:\\repo', supervised: false }]
          : []),
      };
    });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-stale-path', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'create-task', nonce: 'open-stale-path' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    const card = JSON.stringify(updateCard.mock.calls[0][1]);
    const nonce = /"wmux_action":"form_create_task"[^}]*"nonce":"([^"]+)"/.exec(card)?.[1];

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_create_task', value: currentControlValue({ wmux_action: 'form_create_task', nonce }) },
      raw: { action: { form_value: { task_name: '复用目录', task: '执行任务', path_terminal: 'surf-path' } } },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(send.mock.calls[1][1])).toContain('所选终端已关闭或路径不可用');
    expect(control.mock.calls.some(([command]) => command.action === 'create-task')).toBe(false);
  });

  it('从独立入口直接与项目管理 AI 对话并把异步回复送回当前飞书会话', async () => {
    const conversation: Array<{ ts: number; kind: string; summary: string }> = [];
    const control = vi.fn(async (command: { action: string; message?: string }) => {
      if (command.action === 'project-message') {
        conversation.push({ ts: 2, kind: 'user-message', summary: String(command.message || '') });
        return { ok: true, message: '消息已交给项目管理 AI' };
      }
      if (command.action === 'project-status') return {
        ok: true,
        session: { id: 'pm-a', status: 'active', goal: '完成认证功能', workItems: [], events: conversation },
        projects: [{ id: 'pm-a', status: 'active', goal: '完成认证功能' }],
      };
      return { ok: true, message: '{}' };
    });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-manager', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'project-manager', nonce: 'open-manager' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    const portfolioCard = JSON.stringify(updateCard.mock.calls[0][1]);
    expect(portfolioCard).toContain('wmux · 项目组合');
    const workspaceNonce = /"wmux_action":"project_ai_workspace"[^}]*"nonce":"([^"]+)"/.exec(portfolioCard)?.[1];
    expect(workspaceNonce).toBeTruthy();
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'project_ai_workspace', projectId: 'pm-a', nonce: workspaceNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    const workspaceCard = JSON.stringify(updateCard.mock.calls[1][1]);
    const chatNonce = /"wmux_action":"project_ai_view"[^}]*"view":"chat"[^}]*"nonce":"([^"]+)"/.exec(workspaceCard)?.[1];
    expect(chatNonce).toBeTruthy();
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'project_ai_view', projectId: 'pm-a', view: 'chat', nonce: chatNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    const projectCard = JSON.stringify(updateCard.mock.calls[2][1]);
    expect(projectCard).toContain('与项目管理 AI 对话');
    expect(projectCard).not.toContain('activate_project_manager_ai');
    expect(projectCard).not.toContain('项目管理终端');
    const managerNonce = /"wmux_action":"form_project_ai_message"[^}]*"nonce":"([^"]+)"/.exec(projectCard)?.[1];
    expect(managerNonce).toBeTruthy();

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: {
        name: 'wmux_form_project_ai_message',
        value: currentControlValue({ wmux_action: 'form_project_ai_message', nonce: managerNonce }),
      },
      raw: { action: { form_value: { project_ai_message: '请先梳理认证方案' } } },
    });

    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'project-message')).toBe(true));
    const projectMessage = control.mock.calls.find(([command]) => command.action === 'project-message')?.[0] as {
      action: string; message: string; messageId: string; chatId: string;
    };
    expect(projectMessage).toMatchObject({
      action: 'project-message', message: '请先梳理认证方案', chatId: 'oc-dm-a',
    });
    expect(projectMessage.messageId).toMatch(/^feishu-card:om-1:/);
    expect(control.mock.calls.some(([command]) => command.action === 'create-task')).toBe(false);
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(4));
    expect(JSON.stringify(updateCard.mock.calls[3][1])).toContain('项目管理 AI 会在当前飞书会话直接回复');

    conversation.push({ ts: 3, kind: 'manager-reply', summary: '我先整理认证方案。' });
    service.onProjectManagerRecord({
      sessionId: 'pm-a', projectDir: 'E:\\repo', type: 'manager-reply',
      payload: { message: '我先整理认证方案。', correlationId: projectMessage.messageId },
    });

    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(5));
    const refreshedCard = JSON.stringify(updateCard.mock.calls[4][1]);
    expect(refreshedCard).toContain('🔵 **你**');
    expect(refreshedCard).toContain('🟣 **项目管理 AI**');
    expect(refreshedCard).toContain('我先整理认证方案');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('飞书项目管理卡可选择不同项目并只显示该项目的对话', async () => {
    const sessions = {
      'pm-a': {
        id: 'pm-a', status: 'active', goal: '项目 A', workItems: [],
        events: [{ ts: 1, kind: 'manager-reply', summary: 'A 项目回复' }],
      },
      'pm-b': {
        id: 'pm-b', status: 'paused', goal: '项目 B', workItems: [],
        events: [
          { ts: 1, kind: 'manager-reply', summary: 'B 项目较早回复' },
          { ts: 2, kind: 'user-message', summary: 'B 项目询问' },
          { ts: 3, kind: 'manager-reply', summary: 'B 项目回复' },
        ],
      },
    };
    const control = vi.fn(async (command: { action: string; projectId?: 'pm-a' | 'pm-b' }) => ({
      ok: true,
      session: sessions[command.projectId || 'pm-a'],
      projects: [
        { id: 'pm-a', status: 'active', goal: '项目 A', projectDir: 'E:\\project-a' },
        { id: 'pm-b', status: 'paused', goal: '项目 B', projectDir: 'E:\\project-b' },
      ],
    }));
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-project-select', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'project-manager', nonce: 'open-project-select' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    const openedCardObject = updateCard.mock.calls[0][1] as Record<string, unknown>;
    const openedCard = JSON.stringify(openedCardObject);
    expect(openedCard).toContain('wmux · 项目组合');
    expect(openedCard).toContain('项目 A');
    expect(openedCard).toContain('项目 B');
    const values: Array<Record<string, unknown>> = [];
    const collectValues = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(collectValues);
      if (!value || typeof value !== 'object') return;
      const object = value as Record<string, unknown>;
      if (object.wmux_action) values.push(object);
      Object.values(object).forEach(collectValues);
    };
    collectValues(openedCardObject);
    const selectBValue = values.find((value) => (
      value.wmux_action === 'project_ai_workspace' && value.projectId === 'pm-b'
    ));
    expect(selectBValue).toBeTruthy();

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: selectBValue }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    const selectedWorkspace = JSON.stringify(updateCard.mock.calls[1][1]);
    const chatNonce = /"wmux_action":"project_ai_view"[^}]*"view":"chat"[^}]*"nonce":"([^"]+)"/.exec(selectedWorkspace)?.[1];
    expect(chatNonce).toBeTruthy();
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'project_ai_view', projectId: 'pm-b', view: 'chat', nonce: chatNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    const selectedCard = JSON.stringify(updateCard.mock.calls[2][1]);
    expect(selectedCard).toContain('B 项目询问');
    expect(selectedCard).toContain('B 项目回复');
    expect(selectedCard).not.toContain('B 项目较早回复');
    expect(selectedCard).toContain('展开近期对话（1）');
    expect(selectedCard).not.toContain('A 项目回复');
    expect(control).toHaveBeenCalledWith(
      { action: 'project-status', projectId: 'pm-b' },
      { openId: 'ou-allowed', source: 'card' },
    );

    const expandNonce = /"wmux_action":"project_ai_view"[^}]*"view":"chat-expanded"[^}]*"nonce":"([^"]+)"/.exec(selectedCard)?.[1];
    expect(expandNonce).toBeTruthy();
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'project_ai_view', projectId: 'pm-b', view: 'chat-expanded', nonce: expandNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(4));
    const expandedCard = JSON.stringify(updateCard.mock.calls[3][1]);
    expect(expandedCard).toContain('B 项目较早回复');
    expect(expandedCard).toContain('收起近期对话');
  });

  it('项目管理 AI 对话卡可查看处理日志并暂停和恢复项目', async () => {
    let status = 'active';
    let pausedByPortfolio = false;
    const control = vi.fn(async (command: { action: string }) => {
      if (command.action === 'project-status') {
        return {
          ok: true,
          session: { id: 'pm-a', status, goal: '完成认证功能', workItems: [] },
          projects: [{ id: 'pm-a', status, goal: '完成认证功能', pausedByPortfolio }],
        };
      }
      if (command.action === 'project-logs') {
        return {
          ok: true,
          events: Array.from({ length: 8 }, (_, index) => ({
            ts: index + 1,
            kind: 'work-item-created',
            summary: index === 7 ? '创建认证任务' : `处理日志 ${index + 1}`,
          })),
        };
      }
      if (command.action === 'project-pause') status = 'paused';
      if (command.action === 'project-resume') status = 'active';
      if (command.action === 'project-pause-all') {
        status = 'paused';
        pausedByPortfolio = true;
      }
      if (command.action === 'project-resume-all') {
        status = 'active';
        pausedByPortfolio = false;
      }
      return { ok: true, message: '操作成功' };
    });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-manager-controls', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'project-manager', nonce: 'open-manager-controls' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    const portfolioCard = JSON.stringify(updateCard.mock.calls[0][1]);
    const workspaceNonce = /"wmux_action":"project_ai_workspace"[^}]*"nonce":"([^"]+)"/.exec(portfolioCard)?.[1];
    expect(workspaceNonce).toBeTruthy();
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'project_ai_workspace', projectId: 'pm-a', nonce: workspaceNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    const workspaceCard = JSON.stringify(updateCard.mock.calls[1][1]);
    const logsNonce = /"wmux_action":"project_ai_view"[^}]*"view":"activity"[^}]*"nonce":"([^"]+)"/.exec(workspaceCard)?.[1];
    expect(logsNonce).toBeTruthy();

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'project_ai_view', projectId: 'pm-a', view: 'activity', nonce: logsNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    const logsCard = JSON.stringify(updateCard.mock.calls[2][1]);
    expect(logsCard).toContain('创建认证任务');
    expect(logsCard).not.toContain('处理日志 5');
    expect(logsCard).toContain('展开近期日志（6）');
    const expandLogsNonce = /"wmux_action":"project_ai_view"[^}]*"view":"activity-expanded"[^}]*"nonce":"([^"]+)"/.exec(logsCard)?.[1];
    expect(expandLogsNonce).toBeTruthy();

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'project_ai_view', projectId: 'pm-a', view: 'activity-expanded', nonce: expandLogsNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(4));
    const expandedLogsCard = JSON.stringify(updateCard.mock.calls[3][1]);
    expect(expandedLogsCard).toContain('处理日志 3');
    expect(expandedLogsCard).not.toContain('处理日志 2');
    expect(expandedLogsCard).toContain('完整日志请在桌面端查看');
    expect(expandedLogsCard).toContain('收起近期日志');
    const pauseNonce = /"wmux_action":"project_ai_pause"[^}]*"nonce":"([^"]+)"/.exec(expandedLogsCard)?.[1];
    expect(pauseNonce).toBeTruthy();

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'project_ai_pause', nonce: pauseNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(5));
    expect(control.mock.calls.some(([command]) => command.action === 'project-pause')).toBe(true);
    const pausedCard = JSON.stringify(updateCard.mock.calls[4][1]);
    expect(pausedCard).toContain('已暂停');
    const resumeNonce = /"wmux_action":"project_ai_resume"[^}]*"nonce":"([^"]+)"/.exec(pausedCard)?.[1];
    expect(resumeNonce).toBeTruthy();

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'project_ai_resume', nonce: resumeNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(6));
    expect(control.mock.calls.some(([command]) => command.action === 'project-resume')).toBe(true);
    const resumedCard = JSON.stringify(updateCard.mock.calls[5][1]);
    expect(resumedCard).toContain('运行中');
    const portfolioNonce = /"wmux_action":"project_ai_portfolio"[^}]*"nonce":"([^"]+)"/.exec(resumedCard)?.[1];
    expect(portfolioNonce).toBeTruthy();
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'project_ai_portfolio', nonce: portfolioNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(7));
    const portfolioAfterResume = JSON.stringify(updateCard.mock.calls[6][1]);
    const pauseAllNonce = /"wmux_action":"project_ai_pause_all"[^}]*"nonce":"([^"]+)"/.exec(portfolioAfterResume)?.[1];
    expect(pauseAllNonce).toBeTruthy();

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'project_ai_pause_all', nonce: pauseAllNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(8));
    expect(control.mock.calls.some(([command]) => command.action === 'project-pause-all')).toBe(true);
    const globallyPausedCard = JSON.stringify(updateCard.mock.calls[7][1]);
    const resumeAllNonce = /"wmux_action":"project_ai_resume_all"[^}]*"nonce":"([^"]+)"/.exec(globallyPausedCard)?.[1];
    expect(resumeAllNonce).toBeTruthy();

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'project_ai_resume_all', nonce: resumeAllNonce }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(9));
    expect(control.mock.calls.some(([command]) => command.action === 'project-resume-all')).toBe(true);
  });

  it('忙碌任务终端需二次确认且任务正文只保存在内存中', async () => {
    const listMessage = JSON.stringify({
      active: true,
      paused: false,
      terminals: [{
        surfaceId: 'surf-busy', label: 'Grok worker', workspace: 'workspace-a', supervised: true,
        supervisionState: 'active', activityState: 'working', activityUpdatedAt: Date.now(),
      }],
      session: { sessionId: 'sup-1', stopWhen: '完成测试', autonomous: false },
      pendingApprovals: [],
    });
    const control = vi.fn(async (command: { action: string; terminal?: string; task?: string; force?: boolean }) => {
      if (command.action === 'send' && command.force) return { ok: true, message: '已强制发送任务。' };
      if (command.action === 'send') {
        return {
          ok: false,
          code: 'terminal_busy',
          error: 'Grok worker 正在执行任务，需要确认后才能继续发送。',
          terminal: {
            surfaceId: 'surf-busy', label: 'Grok worker', workspace: 'workspace-a',
            activityState: 'working', activityUpdatedAt: Date.now(),
          },
        };
      }
      return { ok: true, message: listMessage };
    });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-busy', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'send', nonce: 'open-busy-send' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('执行中');

    updateCard.mockRejectedValueOnce(new Error('busy confirmation patch failed'));
    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_send', value: currentControlValue({ wmux_action: 'form_send', nonce: 'submit-busy-send' }) },
      raw: { action: { form_value: { terminal: 'surf-busy', task: '仅存在于内存的任务正文' } } },
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const confirmationCard = JSON.stringify(send.mock.calls[1][1]);
    expect(confirmationCard).toContain('确认向忙碌终端发送任务');
    expect(confirmationCard).not.toContain('仅存在于内存的任务正文');
    expect(control.mock.calls.some(([command]) => command.action === 'send' && !command.force)).toBe(true);
    const confirmationId = /"confirmation_id":"([^"]+)"/.exec(confirmationCard)?.[1];
    expect(confirmationId).toBeTruthy();

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-2', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({
        wmux_action: 'confirm_busy_send', terminal: 'surf-busy', confirmation_id: confirmationId, nonce: 'confirm-busy-send',
      }) },
      raw: {},
    });
    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'send' && command.force)).toBe(true));
    expect(control.mock.calls.find(([command]) => command.action === 'send' && command.force)?.[0]).toMatchObject({
      terminal: 'surf-busy', task: '仅存在于内存的任务正文', force: true,
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(updateCard.mock.calls[2][1])).toContain('已强制发送任务。');
  });

  it('通过独立表单向运行中的 AI 监督终端发送方向信息', async () => {
    const listMessage = JSON.stringify({
      active: true,
      paused: false,
      terminals: [{
        surfaceId: 'surf-supervised', label: 'TMC6460', workspace: 'motor-control', supervised: true,
        supervisionState: 'active', activityState: 'working', activityUpdatedAt: Date.now(),
      }],
      session: { sessionId: 'sup-1', stopWhen: '完成粗定位验证', autonomous: false },
      pendingApprovals: [],
    });
    let supervisorScreenVersion = 0;
    const control = vi.fn(async (command: { action: string }) => {
      if (command.action === 'send-supervisor-message') {
        return { ok: true, message: '已向 AI 监督终端（管家）发送监督方向信息。' };
      }
      if (command.action === 'supervisor-screen') {
        supervisorScreenVersion += 1;
        return {
          ok: true,
          terminal: {
            surfaceId: 'surf-supervised', label: 'TMC6460', workspace: 'motor-control',
            activityState: 'working', activityUpdatedAt: Date.now(),
          },
          text: `监督终端原始辅助信息-${supervisorScreenVersion}`,
          answer: `监督终端进度-${supervisorScreenVersion}`,
          lines: 1,
          capturedAt: Date.now(),
        };
      }
      return { ok: true, message: listMessage };
    });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-supervisor-message', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'send-supervisor', nonce: 'open-supervisor-message' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    const formCard = JSON.stringify(updateCard.mock.calls[0][1]);
    expect(formCard).toContain('AI监督终端（管家） · 负责：TMC6460');
    expect(formCard).toContain('监督方向信息');
    expect(formCard).toContain('查看终端信息');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_supervisor_screen', value: currentControlValue({ wmux_action: 'form_supervisor_screen', nonce: 'open-supervisor-screen' }) },
      raw: { action: { form_value: { terminal: 'surf-supervised', message: '先核对项目动态和最新进度，再调整发布方向' } } },
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    expect(control).toHaveBeenCalledWith(
      { action: 'supervisor-screen', terminal: 'surf-supervised', lines: 100 },
      { openId: 'ou-allowed', source: 'card' },
    );
    const screenCard = JSON.stringify(updateCard.mock.calls[1][1]);
    expect(screenCard).toContain('监督终端进度-1');
    expect(screenCard).toContain('先核对项目动态和最新进度，再调整发布方向');
    expect(screenCard).toContain('刷新界面');
    expect(screenCard).toContain('发送监督信息');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_supervisor_refresh', value: currentControlValue({ wmux_action: 'form_supervisor_refresh', terminal: 'surf-supervised', nonce: 'refresh-supervisor-screen' }) },
      raw: { action: { form_value: { message: '刷新时保留的草稿' } } },
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(updateCard.mock.calls[2][1])).toContain('监督终端进度-2');
    expect(JSON.stringify(updateCard.mock.calls[2][1])).toContain('刷新时保留的草稿');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_supervisor_send', value: currentControlValue({ wmux_action: 'form_supervisor_send', terminal: 'surf-supervised', nonce: 'send-supervisor-message' }) },
      raw: { action: { form_value: { message: '先核对项目动态和最新进度，再调整发布方向' } } },
    });
    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'send-supervisor-message')).toBe(true));
    expect(control.mock.calls.find(([command]) => command.action === 'send-supervisor-message')?.[0]).toEqual({
      action: 'send-supervisor-message',
      terminal: 'surf-supervised',
      message: '先核对项目动态和最新进度，再调整发布方向',
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(4));
    expect(JSON.stringify(updateCard.mock.calls[3][1])).toContain('已向 AI 监督终端（管家）发送监督方向信息');
    expect(JSON.stringify(updateCard.mock.calls[3][1])).toContain('监督终端进度-3');
  });

  it('在白名单单聊的统一卡片中选择、刷新并发送任务', async () => {
    const listMessage = JSON.stringify({
      active: false,
      paused: false,
      terminals: [{
        surfaceId: 'surf-screen', label: 'Codex worker', workspace: 'workspace-a', supervised: false,
        supervisionState: 'none', activityState: 'idle', activityUpdatedAt: Date.now(),
      }],
      session: null,
      pendingApprovals: [],
    });
    let screenVersion = 0;
    const longAnswerTail = `${'前'.repeat(1_000)}仅展开可见${'后'.repeat(1_000)}-Agent回复末尾`;
    const control = vi.fn(async (command: { action: string; terminal?: string; lines?: number; task?: string }) => {
      if (command.action === 'terminal-screen') {
        screenVersion += 1;
        return {
          ok: true,
          terminal: {
            surfaceId: 'surf-screen', label: 'Codex worker', workspace: 'workspace-a',
            cwd: 'E:\\work\\sync_file\\work\\ai相关\\ai环境部署\\常用工具环境部署\\codex环境部署',
            activityState: 'idle', activityUpdatedAt: Date.now(),
          },
          text: `PS E:\\repo> raw-${screenVersion}`,
          question: `question-${screenVersion}`,
          answer: `answer-${screenVersion}-${longAnswerTail}`,
          lines: 1,
          capturedAt: Date.now(),
        };
      }
      if (command.action === 'send') return { ok: true, message: '已向 Codex worker 发送任务。' };
      if (command.action === 'terminal-escape') return { ok: true, message: '已向 Codex worker 发送 Esc 中断请求。' };
      if (command.action === 'terminal-interrupt') return { ok: true, message: '已向 Codex worker 发送 Ctrl+C 中断请求。' };
      return { ok: true, message: listMessage };
    });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-screen', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(send.mock.calls[0][1])).toContain('终端控制');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'terminal-control', nonce: 'open-screen' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('wmux_form_terminal_control');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_terminal_control', value: currentControlValue({ wmux_action: 'form_terminal_control', nonce: 'submit-screen' }) },
      raw: { action: { form_value: { terminal: 'surf-screen' } } },
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    expect(control).toHaveBeenCalledWith(
      { action: 'terminal-screen', terminal: 'surf-screen', lines: 100 },
      { openId: 'ou-allowed', source: 'card' },
    );
    expect(JSON.stringify(updateCard.mock.calls[1][1])).not.toContain('你的提问');
    expect(JSON.stringify(updateCard.mock.calls[1][1])).not.toContain('question-1');
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('Agent 回复');
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('路径：E:\\\\…\\\\常用工具环境部署\\\\codex环境部署');
    expect(JSON.stringify(updateCard.mock.calls[1][1])).not.toContain('sync_file\\\\work\\\\ai相关');
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('answer-1');
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('Agent回复末尾');
    expect(JSON.stringify(updateCard.mock.calls[1][1])).toContain('展开完整回复');
    expect(JSON.stringify(updateCard.mock.calls[1][1])).not.toContain('仅展开可见');
    expect(JSON.stringify(updateCard.mock.calls[1][1])).not.toContain('raw-1');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_terminal_expand', value: currentControlValue({ wmux_action: 'form_terminal_expand', terminal: 'surf-screen', nonce: 'expand-screen' }) },
      raw: { action: { form_value: { task: '尚未发送的草稿' } } },
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(updateCard.mock.calls[2][1])).toContain('仅展开可见');
    expect(JSON.stringify(updateCard.mock.calls[2][1])).toContain('收起回复');
    expect(JSON.stringify(updateCard.mock.calls[2][1])).toContain('尚未发送的草稿');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_terminal_collapse', value: currentControlValue({ wmux_action: 'form_terminal_collapse', terminal: 'surf-screen', nonce: 'collapse-screen' }) },
      raw: { action: { form_value: { task: '尚未发送的草稿' } } },
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(4));
    expect(JSON.stringify(updateCard.mock.calls[3][1])).toContain('展开完整回复');
    expect(JSON.stringify(updateCard.mock.calls[3][1])).not.toContain('仅展开可见');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_terminal_refresh', value: currentControlValue({ wmux_action: 'form_terminal_refresh', terminal: 'surf-screen', nonce: 'refresh-screen' }) },
      raw: { action: { form_value: { task: '尚未发送的草稿' } } },
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(5));
    expect(JSON.stringify(updateCard.mock.calls[4][1])).not.toContain('question-4');
    expect(JSON.stringify(updateCard.mock.calls[4][1])).toContain('answer-4');
    expect(JSON.stringify(updateCard.mock.calls[4][1])).toContain('尚未发送的草稿');
    expect(control.mock.calls.filter(([command]) => command.action === 'send')).toHaveLength(0);

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_terminal_send', value: currentControlValue({ wmux_action: 'form_terminal_send', terminal: 'surf-screen', nonce: 'send-screen' }) },
      raw: { action: { form_value: { task: '运行相关测试并汇报结果' } } },
    });
    await vi.waitFor(() => expect(control.mock.calls.filter(([command]) => command.action === 'send')).toHaveLength(1));
    expect(control.mock.calls.find(([command]) => command.action === 'send')?.[0]).toEqual({
      action: 'send', terminal: 'surf-screen', task: '运行相关测试并汇报结果',
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(6));
    expect(JSON.stringify(updateCard.mock.calls[5][1])).toContain('已向 Codex worker 发送任务');
    expect(JSON.stringify(updateCard.mock.calls[5][1])).toContain('AI 回复可能尚未生成');
    expect(JSON.stringify(updateCard.mock.calls[5][1])).not.toContain('default_value');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_terminal_escape', value: currentControlValue({ wmux_action: 'form_terminal_escape', terminal: 'surf-screen', nonce: 'escape-screen' }) },
      raw: { action: { form_value: { task: '不会被发送的草稿' } } },
    });
    await vi.waitFor(() => expect(control.mock.calls.filter(([command]) => command.action === 'terminal-escape')).toHaveLength(1));
    expect(control.mock.calls.find(([command]) => command.action === 'terminal-escape')?.[0]).toEqual({
      action: 'terminal-escape', terminal: 'surf-screen',
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(7));
    expect(JSON.stringify(updateCard.mock.calls[6][1])).toContain('已向 Codex worker 发送 Esc 中断请求');
    expect(JSON.stringify(updateCard.mock.calls[6][1])).toContain('不会被发送的草稿');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_terminal_interrupt', value: currentControlValue({ wmux_action: 'form_terminal_interrupt', terminal: 'surf-screen', nonce: 'interrupt-screen' }) },
      raw: { action: { form_value: { task: '仍然不会被发送的草稿' } } },
    });
    await vi.waitFor(() => expect(control.mock.calls.filter(([command]) => command.action === 'terminal-interrupt')).toHaveLength(1));
    expect(control.mock.calls.find(([command]) => command.action === 'terminal-interrupt')?.[0]).toEqual({
      action: 'terminal-interrupt', terminal: 'surf-screen',
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(8));
    expect(JSON.stringify(updateCard.mock.calls[7][1])).toContain('已向 Codex worker 发送 Ctrl+C 中断请求');
    expect(JSON.stringify(updateCard.mock.calls[7][1])).toContain('仍然不会被发送的草稿');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { name: 'wmux_form_terminal_home', value: currentControlValue({ wmux_action: 'menu', flow: 'status', nonce: 'terminal-home' }) },
      raw: { action: { form_value: { task: '不会被发送的残留文本' } } },
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(9));
    expect(JSON.stringify(updateCard.mock.calls[8][1])).toContain('任务与监督控制');
    expect(control.mock.calls.filter(([command]) => command.action === 'send')).toHaveLength(1);
  });

  it('未知会话中的旧版控制卡不执行操作且只提示重新打开', async () => {
    const control = vi.fn(async () => ({
      ok: true,
      message: JSON.stringify({
        active: false, paused: false, terminals: [], session: null, pendingApprovals: [],
      }),
    }));
    const service = new FeishuSupervisorService(control);
    service.start();

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-obsolete', operator: { openId: 'ou-allowed' },
      action: { value: { wmux_action: 'terminal_screen', terminal: 'surf-old', wmux_card_version: '7' } },
      raw: {},
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(control).not.toHaveBeenCalled();
    expect(JSON.stringify(send.mock.calls[0][1])).toContain('发送“帮助”打开新版控制卡');
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('关闭被监督终端前展示影响并阻止重复确认', async () => {
    const listMessage = JSON.stringify({
      active: true,
      paused: false,
      terminals: [{
        surfaceId: 'surf-close', label: 'Codex worker', workspace: 'workspace-a', supervised: true,
        supervisionState: 'active', activityState: 'working', activityUpdatedAt: Date.now(),
      }],
      session: { sessionId: 'sup-1', stopWhen: '完成任务', autonomous: false },
      pendingApprovals: [],
    });
    const control = vi.fn(async (command: { action: string }) => command.action === 'close-terminal'
      ? { ok: true, message: '已关闭 Codex worker，并停止对应 AI 监督通道。' }
      : { ok: true, message: listMessage });
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-help-close', content: '帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'close-terminal', nonce: 'open-close' }) }, raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('查看关闭影响');
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('inspect_close_terminal');

    handlers.cardAction({
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'inspect_close_terminal', terminal: 'surf-close', nonce: 'inspect-close' }) },
      raw: {},
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    const confirmation = JSON.stringify(updateCard.mock.calls[1][1]);
    expect(confirmation).toContain('同时停止对应监督通道');

    const confirmEvent = {
      chatId: 'oc-dm-a', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'confirm_close_terminal', terminal: 'surf-close', nonce: 'confirm-close' }) }, raw: {},
    };
    handlers.cardAction(confirmEvent);
    handlers.cardAction(confirmEvent);
    await vi.waitFor(() => expect(control.mock.calls.filter(([command]) => command.action === 'close-terminal')).toHaveLength(1));
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(updateCard.mock.calls[2][1])).toContain('已关闭 Codex worker');
  });

  it('控制群不显示也不能调用任务终端界面', async () => {
    vi.stubEnv('WMUX_FEISHU_CONTROL_CHAT_ID', 'oc-control');
    const control = vi.fn(async () => ({
      ok: true,
      message: JSON.stringify({
        active: false, paused: false,
        terminals: [{ surfaceId: 'surf-secret', label: 'Codex', workspace: 'secret', supervised: false }],
        session: null, pendingApprovals: [],
      }),
    }));
    const service = new FeishuSupervisorService(control);
    service.start();
    handlers.message({
      chatId: 'oc-control', senderId: 'ou-allowed', messageId: 'om-group-screen', content: '帮助', chatType: 'group',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(send.mock.calls[0][1])).not.toContain('终端控制');

    handlers.cardAction({
      chatId: 'oc-control', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({ wmux_action: 'menu', flow: 'terminal-control', nonce: 'forged-screen' }) }, raw: {},
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]).toEqual([
      'oc-control',
      { text: '任务终端界面可能包含敏感信息，仅支持白名单用户单聊查看。' },
    ]);
    expect(control.mock.calls.filter(([command]) => command.action === 'terminal-screen')).toHaveLength(0);
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
    expect(JSON.stringify(send.mock.calls[1][1])).toContain('任务与监督控制');
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

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const approvalCall = send.mock.calls.find(([, payload]) => JSON.stringify(payload).includes('采用 AI 方案'));
    expect(approvalCall?.[0]).toBe('oc-dm-b');
    expect(send.mock.calls.filter(([chatId]) => chatId === 'oc-audit')).toHaveLength(2);
  });

  it('审批事件缺少 ID 时私聊详情且群里只显示公开决策上下文', async () => {
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();
    handlers.message({
      chatId: 'oc-dm-a', senderId: 'ou-allowed', messageId: 'om-inbound-a', content: 'wmux帮助', chatType: 'p2p',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    send.mockClear();

    service.onRecord({ ...approvalRecord('unused'), payload: { reason: '缺少审批 ID' } });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const directCall = send.mock.calls.find(([chatId]) => chatId === 'oc-dm-a');
    expect(directCall).toBeDefined();
    const auditPayloads = send.mock.calls
      .filter(([chatId]) => chatId === 'oc-audit')
      .map(([, payload]) => JSON.stringify(payload));
    expect(auditPayloads).toHaveLength(2);
    expect(auditPayloads.join('\n')).toContain('需要用户决定');
    expect(auditPayloads.join('\n')).toContain('缺少审批 ID');
    expect(auditPayloads.join('\n')).toContain('方案选择、AI 推荐和决策操作仅在机器人单聊中提供');
    expect(auditPayloads.join('\n')).not.toContain('方案 A');
  });

  it('同一终端复用群状态卡且失败时额外提醒', async () => {
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();

    service.onRecord({
      sessionId: 'sup-1',
      projectDir: 'E:\\test',
      type: 'worker.task',
      terminal: { surfaceId: 'surf-1', label: 'pwsh.exe' },
      payload: { task: '运行测试并整理结果' },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toBe('oc-audit');
    expect(JSON.stringify(send.mock.calls[0][1])).toContain('运行测试并整理结果');

    service.onRecord({
      sessionId: 'sup-1', projectDir: 'E:\\test', type: 'worker.lifecycle',
      terminal: { surfaceId: 'surf-1', label: 'pwsh.exe' }, payload: { event: 'Stop' },
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('等待监督裁决');
    expect(send).toHaveBeenCalledTimes(1);

    service.onRecord({
      sessionId: 'sup-1', projectDir: 'E:\\test', type: 'worker.lifecycle',
      terminal: { surfaceId: 'surf-1', label: 'pwsh.exe' }, payload: { event: 'StopFailure', message: '测试失败' },
    });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(send.mock.calls[1][1])).toContain('终端任务执行失败');
  });

  it('状态卡发送失败时仍继续发送关键提醒', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    send.mockRejectedValueOnce(new Error('status card failed'));
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();

    service.onRecord({
      sessionId: 'sup-1', projectDir: 'E:\\test', type: 'worker.blocked',
      terminal: { surfaceId: 'surf-1', label: 'codex' }, payload: { reason: '等待权限确认' },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(send.mock.calls[1][1])).toContain('终端任务已阻塞');
    expect(warning).toHaveBeenCalledWith('[feishu] audit status card delivery failed', expect.any(Error));
    warning.mockRestore();
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
      content: 'WMUX SUPERVISOR DECIDE\napproval_id: appr-secret\naction: approve\nselection: 方案 A',
      chatType: 'group',
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(control).not.toHaveBeenCalled();
    expect(send.mock.calls[0]).toEqual([
      'oc-control',
      { text: '人工决策仅支持白名单用户单聊。' },
    ]);
  });

  it('专用项目管理群将普通消息直接交给项目管理 AI 且不发送过程回执', async () => {
    vi.stubEnv('WMUX_FEISHU_PROJECT_MANAGER_CHAT_ID', 'oc-project');
    const control = vi.fn(async () => ({ ok: true, message: '消息已交给项目管理 AI' }));
    const service = new FeishuSupervisorService(control);
    service.start();

    handlers.message({
      chatId: 'oc-project', senderId: 'ou-allowed', messageId: 'om-project-1',
      content: '先暂停新增任务，我们讨论认证方案', chatType: 'group',
    });

    await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(1));
    expect(control).toHaveBeenCalledWith({
      action: 'project-message',
      message: '先暂停新增任务，我们讨论认证方案',
      messageId: 'om-project-1',
      chatId: 'oc-project',
    }, { openId: 'ou-allowed', source: 'text' });
    expect(send).not.toHaveBeenCalled();
  });

  it('专用项目管理群支持查看日志、软暂停和显式紧急停止确认', async () => {
    vi.stubEnv('WMUX_FEISHU_PROJECT_MANAGER_CHAT_ID', 'oc-project');
    const control = vi.fn(async (command: { action: string }) => {
      if (command.action === 'project-logs') {
        return { ok: true, events: [{ ts: 1, kind: 'work-item-created', summary: '创建认证任务' }] };
      }
      return { ok: true, message: '操作成功' };
    });
    const service = new FeishuSupervisorService(control);
    service.start();

    handlers.message({ chatId: 'oc-project', senderId: 'ou-allowed', messageId: 'om-log', content: '/项目日志', chatType: 'group' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(send.mock.calls[0][1])).toContain('创建认证任务');

    handlers.message({ chatId: 'oc-project', senderId: 'ou-allowed', messageId: 'om-pause', content: '/暂停项目', chatType: 'group' });
    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'project-pause')).toBe(true));

    handlers.message({ chatId: 'oc-project', senderId: 'ou-allowed', messageId: 'om-stop-prompt', content: '/紧急停止', chatType: 'group' });
    await vi.waitFor(() => expect(send.mock.calls.some(([, payload]) => JSON.stringify(payload).includes('/确认紧急停止'))).toBe(true));
    expect(control.mock.calls.some(([command]) => command.action === 'project-stop')).toBe(false);

    handlers.message({ chatId: 'oc-project', senderId: 'ou-allowed', messageId: 'om-stop-confirm', content: '/确认紧急停止', chatType: 'group' });
    await vi.waitFor(() => expect(control.mock.calls.some(([command]) => command.action === 'project-stop')).toBe(true));
    expect(control.mock.calls.find(([command]) => command.action === 'project-stop')?.[0]).toMatchObject({ emergency: true });
  });

  it('项目管理 AI 的结构化回复只发送到专用项目管理群', async () => {
    vi.stubEnv('WMUX_FEISHU_PROJECT_MANAGER_CHAT_ID', 'oc-project');
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();

    service.onProjectManagerRecord({
      sessionId: 'pm-a', projectDir: 'E:\\repo', type: 'manager-reply', payload: { message: '已暂停，我们先比较两个方案。' },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]).toEqual(['oc-project', { text: '已暂停，我们先比较两个方案。' }]);
  });

  it('项目运行故障发送带处理入口的红色项目告警卡，而不是普通文本', async () => {
    vi.stubEnv('WMUX_FEISHU_PROJECT_MANAGER_CHAT_ID', 'oc-project-alert');
    const service = new FeishuSupervisorService(vi.fn(async () => ({ ok: true })));
    service.start();

    service.onProjectManagerRecord({
      sessionId: 'pm-alert', projectDir: 'E:\\repo', type: 'supervisor-runtime-failed',
      payload: { message: '项目专属监督启动失败' },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toBe('oc-project-alert');
    const payload = send.mock.calls[0][1] as { card?: unknown; text?: string };
    const card = JSON.stringify(payload.card);
    expect(payload.text).toBeUndefined();
    expect(card).toContain('wmux · 项目需要处理');
    expect(card).toContain('"template":"red"');
    expect(card).toContain('项目专属监督启动失败');
    expect(card).toContain('打开项目工作台');
    expect(card).toContain('"projectId":"pm-alert"');
    expect(card).toContain('普通 AI 监督接管');
  });

  it('项目人工介入阻塞推送到专用飞书群，答复进入对应项目且不自动恢复', async () => {
    vi.stubEnv('WMUX_FEISHU_PROJECT_MANAGER_CHAT_ID', 'oc-project');
    vi.stubEnv('WMUX_FEISHU_DECISION_CHAT_ID', 'oc-project');
    const control = vi.fn(async () => ({ ok: true, message: '已记录用户答复' }));
    const service = new FeishuSupervisorService(control);
    service.start();

    service.onProjectManagerRecord({
      sessionId: 'pm-a', projectDir: 'E:\\repo', type: 'user-clarification-requested',
      payload: {
        question: {
          id: 'question-1', category: 'manual-intervention', workItemId: 'wol_validation',
          blocker: '需要用户进入 BIOS 完成真机验收',
          question: '是否现在进入 BIOS 完成验收？', context: '必须先完成人工操作。',
          options: [{ id: 'keep', label: '保留现有配置' }, { id: 'replace', label: '允许覆盖' }],
          recommendedOptionId: 'keep', previousStatus: 'active', createdAt: 1,
        },
      },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toBe('oc-project');
    expect(JSON.stringify(send.mock.calls[0][1])).toContain('项目阻塞，需要你的指示');
    expect(JSON.stringify(send.mock.calls[0][1])).toContain('wol_validation');
    expect(JSON.stringify(send.mock.calls[0][1])).toContain('保留现有配置（推荐）');

    handlers.cardAction({
      chatId: 'oc-project', messageId: 'om-1', operator: { openId: 'ou-allowed' },
      action: { value: currentControlValue({
        wmux_action: 'project_clarification_option', projectId: 'pm-a', questionId: 'question-1',
        optionId: 'keep', answer: '保留现有配置',
      }) },
      raw: {},
    });

    await vi.waitFor(() => expect(control).toHaveBeenCalledWith({
      action: 'project-answer', projectId: 'pm-a', questionId: 'question-1',
      optionId: 'keep', answer: '保留现有配置',
    }, { openId: 'ou-allowed', source: 'card' }));
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('项目确认已提交');
    expect(JSON.stringify(updateCard.mock.calls[0][1])).toContain('项目仍保持暂停');

    service.onProjectManagerRecord({
      sessionId: 'pm-a', projectDir: 'E:\\repo', type: 'user-clarification-answered',
      payload: { questionId: 'question-1', answer: '保留现有配置', answeredBy: 'feishu' },
    });
    await Promise.resolve();
    expect(updateCard).toHaveBeenCalledTimes(1);
  });

  it('项目模式的监督事件不经过飞书服务转发，也不发送普通飞书审计卡', async () => {
    vi.stubEnv('WMUX_FEISHU_PROJECT_MANAGER_CHAT_ID', 'oc-project');
    const control = vi.fn(async () => ({ ok: true }));
    const service = new FeishuSupervisorService(control);
    service.start();

    service.onRecord({
      sessionId: 'sup-project',
      projectDir: 'E:\\repo',
      type: 'worker.lifecycle',
      terminal: { surfaceId: 'surf-worker', label: '认证任务' },
      payload: { event: 'Stop', projectWorkItemId: 'auth_api' },
    });

    await Promise.resolve();
    expect(control).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('审批卡片只能从原始单聊和原始消息处理', () => {
    const card = { messageId: 'om-card', chatId: 'oc-dm-a' };

    expect(isFeishuApprovalCardContext(card, 'om-card', 'oc-dm-a')).toBe(true);
    expect(isFeishuApprovalCardContext(card, 'om-card', 'oc-dm-b')).toBe(false);
    expect(isFeishuApprovalCardContext(card, 'om-copy', 'oc-dm-a')).toBe(false);
  });
});
