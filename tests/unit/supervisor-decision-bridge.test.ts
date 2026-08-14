import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initPipeBridge, readTerminalScreen, terminalConversationExcerpt, terminalScreenExcerpt } from '../../src/renderer/pipe-bridge';
import { surfaceTerminalRegistry } from '../../src/renderer/hooks/useTerminal';
import { useStore } from '../../src/renderer/store';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';
import {
  PROJECT_MANAGER_TERMINAL_CWD,
  PROJECT_MANAGER_TERMINAL_NAME,
  PROJECT_MANAGER_TERMINAL_STARTUP_INPUT,
} from '../../src/shared/project-manager-terminal';

function lane(): SupervisorLane {
  return {
    id: 'lane-a',
    label: 'worker',
    surfaceId: 'worker-a' as any,
    supervisorSurfaceId: 'supervisor-a' as any,
    projectDir: 'E:\\repo',
    enabled: true,
    steps: [],
    maxAutoSteps: 0,
    autoStepsUsed: 0,
    awaitingStopCheck: false,
    stopConfirmed: false,
    awaitingReview: false,
    autoDecisionsUsed: 0,
    decisions: [],
  };
}

describe('supervisor decision bridge', () => {
  const writes = vi.fn();
  let screenText: string;
  let agentState: {
    state: string;
    blockedReason: string | null;
    blockedVersion: number;
    blockedRequestId?: string | null;
    updatedAt: number;
  };

  beforeEach(() => {
    writes.mockReset();
    screenText = '';
    agentState = { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: 1 };
    surfaceTerminalRegistry.set('worker-a', {
      buffer: {
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          length: 1,
          getLine: () => ({ translateToString: (_trimRight?: boolean, start = 0, end?: number) => screenText.slice(start, end) }),
        },
      },
    } as any);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        wmux: {
          pty: { write: writes },
          notification: { fire: vi.fn() },
        },
        setTimeout: (callback: () => void) => {
          callback();
          return 1;
        },
        __wmux_getAgentStates: () => ({ 'worker-a': agentState }),
      },
    });
    const store = useStore.getState();
    store.resetSupervisorSession();
    store.setSupervisorLanes([lane()]);
    store.patchSupervisor({
      mode: 'unified',
      autonomous: false,
      submitEnter: false,
      taskGoal: '完成当前测试任务',
    });
    store.startSupervisor();
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(true);
    initPipeBridge();
  });

  afterEach(() => {
    useStore.getState().resetSupervisorSession();
    useStore.getState().replaceAllWorkspaces([]);
    surfaceTerminalRegistry.delete('worker-a');
    surfaceTerminalRegistry.delete('supervisor-a');
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('reports task terminal activity and rejects an unconfirmed busy send', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-control' as any,
      title: 'Work',
      splitTree: {
        type: 'leaf', paneId: 'pane-control' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'Codex worker' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi', customTitle: 'AI 监督 · Codex worker' },
        ],
      },
    }]);
    agentState = { state: 'working', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() };
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    const listResult = remoteControl({ action: 'list' });
    const listed = JSON.parse(listResult.message).terminals.find((terminal: any) => terminal.surfaceId === 'worker-a');
    expect(listed).toMatchObject({ activityState: 'working', activityUpdatedAt: agentState.updatedAt });

    expect(remoteControl({ action: 'send', terminal: 'worker-a', task: '继续执行', actor: 'ou-user' }))
      .toMatchObject({ ok: false, code: 'terminal_busy', terminal: { activityState: 'working' } });
    expect(writes).not.toHaveBeenCalled();

    expect(remoteControl({ action: 'send', terminal: 'worker-a', task: '确认后继续执行', actor: 'ou-user', force: true }))
      .toMatchObject({ ok: true });
    expect(writes).toHaveBeenCalledWith('worker-a', '确认后继续执行');
  });

  it('sends Feishu direction information only to the active dedicated supervisor terminal', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-control' as any,
      title: 'Work',
      splitTree: {
        type: 'leaf', paneId: 'pane-control' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'Codex worker' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi', customTitle: 'AI 监督 · Codex worker' },
        ],
      },
    }]);
    surfaceTerminalRegistry.set('supervisor-a', {
      buffer: {
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
    } as any);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'send-supervisor-message', terminal: 'worker-a', message: '先读取项目进度，再给任务终端建议', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: expect.stringContaining('AI 监督终端（管家）') });
    expect(writes).toHaveBeenCalledWith(
      'supervisor-a',
      '[用户调整监督方向] 先读取项目进度，再给任务终端建议',
    );
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    expect(useStore.getState().supervisor.log[0]).toMatchObject({
      laneId: 'lane-a', action: '用户调整监督方向', detail: '先读取项目进度，再给任务终端建议',
    });

    useStore.getState().pauseSupervisor('测试暂停');
    writes.mockClear();
    expect(remoteControl({
      action: 'send-supervisor-message', terminal: 'worker-a', message: '暂停时不应发送', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('当前未运行') });
    expect(writes).not.toHaveBeenCalled();
  });

  it('returns recent supervision logs with lane labels for Feishu', () => {
    useStore.getState().appendSupervisorLog('lane-a', '任务完成', '测试已通过');
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    const result = remoteControl({ action: 'logs' });
    const payload = JSON.parse(result.message);
    expect(result).toMatchObject({ ok: true });
    expect(payload).toMatchObject({ active: true, paused: false });
    expect(payload.entries[0]).toMatchObject({
      laneLabel: 'worker', action: '任务完成', detail: '测试已通过',
    });
  });

  it('returns only a current task terminal screen for Feishu private viewing', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-screen' as any,
      title: 'Screen Work',
      splitTree: {
        type: 'leaf', paneId: 'pane-screen' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'Codex worker' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi', customTitle: 'AI 监督 · Codex worker' },
        ],
      },
    }]);
    screenText = 'PS E:\\repo> npm test\nTests 1 failed';
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({ action: 'terminal-screen', terminal: 'worker-a', lines: 40 })).toMatchObject({
      ok: true,
      terminal: {
        surfaceId: 'worker-a', label: 'Codex worker', workspace: 'Screen Work', activityState: 'idle',
      },
      text: screenText,
      lines: 1,
      capturedAt: expect.any(Number),
    });
    expect(remoteControl({ action: 'terminal-screen', terminal: 'supervisor-a', lines: 40 }))
      .toMatchObject({ ok: false, error: expect.stringContaining('专属监督 AI 终端') });
    expect(remoteControl({ action: 'terminal-screen', terminal: 'missing', lines: 40 }))
      .toMatchObject({ ok: false });
  });

  it('returns the live worker screen and current AI recommendation for a Feishu decision card', () => {
    screenText = 'PS E:\\repo> npm test\nTests 1 failed\nPS E:\\repo>';
    expect(decide({
      outcome: 'needs-human', proposalKind: 'important', next: '保留接口并补齐适配层',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decision-context', approvalId: approval.id, terminal: 'worker-a', lines: 40,
    })).toMatchObject({
      ok: true,
      recommendation: '保留接口并补齐适配层',
      terminalScreen: screenText,
    });
    expect(remoteControl({
      action: 'decision-context', approvalId: approval.id, terminal: 'other-worker', lines: 40,
    })).toMatchObject({ ok: false, error: expect.stringContaining('不匹配') });
  });

  it('records public decision context separately from private options', async () => {
    const appendRecord = vi.fn(async () => undefined);
    (globalThis.window as any).wmux.supervisor = { appendRecord };

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      reason: '需要用户确认测试板位置并决定是否安排现场复测',
      impact: 'AI 无法确认实体设备位置，也不能代替用户执行现场操作',
      alternatives: '方案 A：远程烧录；方案 B：现场断开设备',
      next: '推荐方案 A：远程烧录后读取状态',
    })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(appendRecord).toHaveBeenCalled());

    const approvalRecord = appendRecord.mock.calls.find(([record]) => (
      record.type === 'supervisor.approval.requested'
    ))?.[0];
    expect(approvalRecord?.payload).toMatchObject({
      taskGoal: '完成当前测试任务',
      reason: '需要用户确认测试板位置并决定是否安排现场复测',
      impact: 'AI 无法确认实体设备位置，也不能代替用户执行现场操作',
      alternatives: '方案 A：远程烧录；方案 B：现场断开设备',
    });
    expect(approvalRecord?.payload).not.toHaveProperty('recommendation');
    expect(approvalRecord?.payload).not.toHaveProperty('next');
  });

  it('removes next-step plans from the fallback task goal published to the group', async () => {
    const appendRecord = vi.fn(async () => undefined);
    (globalThis.window as any).wmux.supervisor = { appendRecord };
    useStore.getState().patchSupervisor({ taskGoal: '' });
    useStore.getState().updateLane('lane-a', {
      currentTask: '固件修复已验收。下一步：方案 A：远程烧录；方案 B：现场断开设备',
    });

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      reason: '需要用户确认测试板位置',
      impact: 'AI 无法确认实体设备位置',
      alternatives: '方案 A：远程烧录；方案 B：现场断开设备',
      next: '推荐方案 A',
    })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(appendRecord).toHaveBeenCalled());

    const approvalRecord = appendRecord.mock.calls.find(([record]) => (
      record.type === 'supervisor.approval.requested'
    ))?.[0];
    expect(approvalRecord?.payload.taskGoal).toBe('固件修复已验收');
    expect(String(approvalRecord?.payload.taskGoal)).not.toContain('方案 A');
  });

  it('keeps the newest part when limiting terminal screen text for Feishu', () => {
    const excerpt = terminalScreenExcerpt(`旧输出${'x'.repeat(40)}\n最新错误：测试失败`, 20);
    expect(excerpt).toHaveLength(20);
    expect(excerpt.startsWith('…\n')).toBe(true);
    expect(excerpt).toContain('最新错误：测试失败');
  });

  it('joins Grok wrapped wide-character lines and collapses repeated TUI repaint frames', () => {
    const lines = [
      { text: '┌─ Grok 项目检查', wrapped: false },
      { text: '：发现中文错误', wrapped: true },
      { text: '结果：测试失败', wrapped: false },
      { text: '提示：修复后重试', wrapped: false },
      { text: '┌─ Grok 项目检查：发现中文错误', wrapped: false },
      { text: '结果：测试失败', wrapped: false },
      { text: '提示：修复后重试', wrapped: false },
    ];
    surfaceTerminalRegistry.set('worker-a', {
      buffer: {
        active: {
          length: lines.length,
          getLine: (index: number) => ({
            isWrapped: lines[index].wrapped,
            translateToString: () => lines[index].text,
          }),
        },
      },
    } as any);

    const screen = readTerminalScreen('worker-a', 40);
    expect(screen.text).toContain('┌─ Grok 项目检查：发现中文错误');
    expect(terminalScreenExcerpt(screen.text || '')).toBe(
      '┌─ Grok 项目检查：发现中文错误\n结果：测试失败\n提示：修复后重试',
    );
  });

  it('reads the complete Grok alternate screen and removes composer chrome', () => {
    const lines = [
      'Grok 正在检查项目',
      '结论：类型检查通过，仍有一个测试失败',
      '建议：先修复 terminal screen 用例',
      '',
      '╭────────────────────────────────────────────────────────────╮',
      '│',
      '│  >',
      '╰────────────────────────────────────────────────────────────╯',
      '────────────────── Grok 4.6 (high) · always-approve ─────────╯',
      'Shift+Tab:mode  |  Esc:cancel  |  Ctrl+X:shortcuts',
    ];
    surfaceTerminalRegistry.set('worker-a', {
      buffer: {
        active: {
          type: 'alternate',
          length: lines.length,
          getLine: (index: number) => ({
            isWrapped: false,
            translateToString: () => lines[index],
          }),
        },
      },
    } as any);

    const screen = readTerminalScreen('worker-a', 4);
    expect(screen.lines).toBe(lines.length);
    expect(terminalScreenExcerpt(screen.text || '')).toBe([
      'Grok 正在检查项目',
      '结论：类型检查通过，仍有一个测试失败',
      '建议：先修复 terminal screen 用例',
    ].join('\n'));
  });

  it('extracts the latest Grok question and answer without TUI noise', () => {
    const conversation = terminalConversationExcerpt([
      '〉 你是什么模型                                      11:03 PM',
      '◆user_prompt_submit   [hooks: 1/1]',
      '◆Thought for 0.1s',
      '',
      '我是 Grok 4.6，由 xAI 开发。',
      '11:04 PM',
      'Worked for 5.8s',
      'stop  [hooks: 1/1]',
      'Help improve Grok',
      '[Opt out] [Opt in]',
      'Read Terms and Privacy Policy.',
      '〉',
    ].join('\n'), 'Grok直连 · sd');

    expect(conversation).toMatchObject({
      question: '你是什么模型',
      answer: '我是 Grok 4.6，由 xAI 开发。',
    });
    expect(conversation.answer).not.toContain('Thought');
    expect(conversation.answer).not.toContain('Help improve');
  });

  it('detects a Grok conversation from screen content when the terminal title is generic', () => {
    const conversation = terminalConversationExcerpt([
      '28K / 500K',
      '❯ 你是什么模型                                      11:02 AM',
      '◆ user_prompt_submit   [hooks: 1/1]',
      '◆ Thought for 0.1s',
      '',
      '我是 Grok 4.6，由 xAI 开发。',
      '11:02 AM',
      'Worked for 7.7s',
      'stop  [hooks: 1/1]',
      'Help improve Grok',
      '[Opt out] [Opt in]',
      'Off by default. Opt-in to allow SpaceXAI to retain coding data.',
      'Change anytime via sett',
    ].join('\n'), 'pwsh.exe', 'idle');

    expect(conversation).toMatchObject({
      question: '你是什么模型',
      answer: '我是 Grok 4.6，由 xAI 开发。',
    });
    expect(conversation.answer).not.toContain('hooks');
    expect(conversation.answer).not.toContain('Help improve');
    expect(conversation.answer).not.toContain('Opt out');
  });

  it('detects Grok from its footer after hook markers scroll out of the viewport', () => {
    const conversation = terminalConversationExcerpt([
      '❯ 你有哪些技能                                      11:07 AM',
      '• requirements-clarifier：复杂需求澄清与实现前准备',
      '• code-reviewer / review：代码审查',
      '',
      '通用工程',
      '• brainstorming：方向不清时先对齐方案',
      '• verification-before-completion：完成前检验交付物',
      '',
      '需要某个技能时，直接说目标即可。',
      '█',
      '∷ Responding... 8.4s',
      '12s ↓29.1k [stop]',
      'Worked for 17s',
      'stop  [hooks: 1/1]',
      'Help improve Grok',
      '[Opt out] [Opt in]',
      'Off by default. Opt-in to allow SpaceXAI to retain coding data.',
    ].join('\n'), 'pwsh.exe', 'working');

    expect(conversation).toMatchObject({
      question: '你有哪些技能',
      answer: [
        '• requirements-clarifier：复杂需求澄清与实现前准备',
        '• code-reviewer / review：代码审查',
        '',
        '通用工程',
        '• brainstorming：方向不清时先对齐方案',
        '• verification-before-completion：完成前检验交付物',
        '',
        '需要某个技能时，直接说目标即可。',
      ].join('\n'),
    });
    expect(conversation.answer).not.toContain('Responding');
    expect(conversation.answer).not.toContain('[stop]');
    expect(conversation.answer).not.toContain('Help improve');
    expect(conversation.answer).not.toContain('█');
  });

  it('extracts a completed Grok turn before the composer placeholder and shortcuts', () => {
    const conversation = terminalConversationExcerpt([
      '❯ 你有哪些技能                                      11:13 AM',
      'test-driven-development    仅在你明确要求 TDD 时启用',
      'project-progress           维护 .project-plans/ 进度与交接',
      '',
      'Grok 内置',
      '通用能力，不限本仓库：',
      '• create-skill / create-workflow：创建技能、编排工作流',
      '• review / code-reviewer / pr-babysit：代码审查与 PR 跟进',
      '',
      '输入 / 可浏览全部可调用项；有命令可用 grok inspect 查看完整清单与来源。',
      'Worked for 44s',
      'stop  [hooks: 1/1]',
      '❯ Build anything',
      '│',
      'Ctrl+e:expand thinking  |  Space:prompt  |  Ctrl+x:shortcuts',
    ].join('\n'), 'pwsh.exe', 'idle');

    expect(conversation).toMatchObject({
      question: '你有哪些技能',
      answer: [
        'test-driven-development    仅在你明确要求 TDD 时启用',
        'project-progress           维护 .project-plans/ 进度与交接',
        '',
        'Grok 内置',
        '通用能力，不限本仓库：',
        '• create-skill / create-workflow：创建技能、编排工作流',
        '• review / code-reviewer / pr-babysit：代码审查与 PR 跟进',
        '',
        '输入 / 可浏览全部可调用项；有命令可用 grok inspect 查看完整清单与来源。',
      ].join('\n'),
    });
    expect(conversation.answer).not.toContain('Build anything');
    expect(conversation.answer).not.toContain('Ctrl+e');
    expect(conversation.answer).not.toContain('Worked for');
  });

  it('keeps the submitted Grok prompt instead of the empty composer and extracts the final reply', () => {
    const conversation = terminalConversationExcerpt([
      '❯ af',
      '◆user_prompt_submit   [hooks: 1/1]',
      '◆Thought for 10.6s',
      '',
      '我的理解是：你只发了 af，我先检查当前工作区。',
      '◈ Searched 1 MCP tools, Listed 1 dir, Searched 1 pattern',
      '',
      '工作区看起来是空的。我继续查看隐藏文件。',
      '◆ Run List hidden and parent directory files',
      '◈ Searched 1 pattern',
      '',
      'af 含义不清，当前工作区也是空的，没法据此推断你要做什么。',
      '',
      '请补一句目标，我再继续。',
      'Worked for 49s',
      '❯ |',
      'Shift+Tab:mode  |  Ctrl+x:shortcuts',
    ].join('\n'), 'Grok直连 · dasf', 'idle');

    expect(conversation).toMatchObject({
      question: 'af',
      answer: 'af 含义不清，当前工作区也是空的，没法据此推断你要做什么。\n\n请补一句目标，我再继续。',
    });
    expect(conversation.answer).not.toContain('Thought');
    expect(conversation.answer).not.toContain('Searched');
    expect(conversation.answer).not.toContain('Shift+Tab');
  });

  it('extracts the latest Kimi question and final response instead of its reasoning', () => {
    const conversation = terminalConversationExcerpt([
      '✦ asdf',
      '● User typed “asdf” — meaningless input. Reply briefly asking what they need.',
      '● 看起来像是误输入。需要我做什么？',
      '✦ 你是什么模型',
      '● The user asks what model I am. Answer candidly in Chinese.',
      '● 我是 Kimi Code CLI 的 AI 助手，由 Moonshot AI 的模型驱动。',
      'yolo  K3-256k thinking: high  C:\\repo',
      '/compact compresses context when it gets long',
      'context: 10% (25k/256k)',
    ].join('\n'), 'pwsh.exe');

    expect(conversation).toMatchObject({
      question: '你是什么模型',
      answer: '我是 Kimi Code CLI 的 AI 助手，由 Moonshot AI 的模型驱动。',
    });
    expect(conversation.answer).not.toContain('The user asks');
  });

  it('shows only the Codex question while tools are still running', () => {
    const conversation = terminalConversationExcerpt([
      'OpenAI Codex (v0.147.0)',
      'model: gpt-5.6-sol high fast',
      'directory: E:\\work\\wmux',
      'permissions: YOLO mode',
      'Tip: Type / to open the command popup',
      'MCP startup interrupted. The following servers were not initialized: fetch',
      '› 你是什么模型',
      '• 我的理解是：你想确认当前对话中我的模型身份。',
      '• Ran Get-Content -Raw -LiteralPath SKILL.md',
      '  └ name: openai-docs',
      '• Searching the web',
      '• Searched the web for Codex models',
      '• Working (12s • esc to interrupt)',
      '› Find and fix a bug in @filename',
      'gpt-5.6-sol high fast · E:\\work\\wmux',
    ].join('\n'), 'Codex直连 · sd', 'working');

    expect(conversation).toMatchObject({ question: '你是什么模型', answerPending: true });
    expect(conversation.answer).toBeUndefined();
    expect(terminalConversationExcerpt(conversation.text, 'Codex直连 · sd', 'unknown')).toMatchObject({
      question: '你是什么模型', answerPending: true,
    });
  });

  it('keeps the final Codex response and removes commentary and tool activity', () => {
    const conversation = terminalConversationExcerpt([
      '› 你是什么模型',
      '• 我是 Codex，基于 GPT-5 的编程智能体。',
      '› 你是什么模型',
      '• 我先检查当前环境和官方说明。',
      '• Ran Get-Content SKILL.md',
      '  └ 43 lines',
      '• Searching the web',
      '• Working (4s • esc to interrupt)',
      '• 我是 Codex，当前会话使用 GPT-5.6 系列模型。',
      '',
      '  具体运行配置以终端顶部显示为准。',
      '› Implement {feature}',
      'gpt-5.6-sol high fast · E:\\work\\wmux',
    ].join('\n'), 'pwsh.exe', 'idle');

    expect(conversation).toMatchObject({
      question: '你是什么模型',
      answer: '我是 Codex，当前会话使用 GPT-5.6 系列模型。\n\n  具体运行配置以终端顶部显示为准。',
    });
    expect(conversation.answer).not.toContain('Searching');
    expect(conversation.answer).not.toContain('我先检查');
    expect(conversation.answer).not.toContain('Implement {feature}');
  });

  it.each([
    'Find and fix a bug in @filename',
    'Improve documentation in @filename',
    'Ask Codex to do anything',
    'Implement {feature}',
  ])('ignores the Codex composer suggestion %s', (suggestion) => {
    const conversation = terminalConversationExcerpt([
      'OpenAI Codex (v0.147.0)',
      '› 你有哪些技能',
      '• 我可以协助代码开发、测试、审查和文档处理。',
      `› ${suggestion}`,
      'gpt-5.6-luna medium · D:\\repo',
    ].join('\n'), 'Codex直连 · test', 'idle');

    expect(conversation).toMatchObject({
      question: '你有哪些技能',
      answer: '我可以协助代码开发、测试、审查和文档处理。',
    });
  });

  it('keeps long final replies from Codex and Kimi', () => {
    const longAnswer = `结论：已完成检查。\n\n${'这里是需要在飞书中保留的详细回复。'.repeat(100)}\n\n以上是完整结果。`;
    const codex = terminalConversationExcerpt([
      '› 请详细说明检查结果',
      '• Ran npm test',
      '  └ Tests passed',
      `• ${longAnswer}`,
      '› Ask Codex to do anything',
      'gpt-5.6-sol high fast · E:\\work\\wmux',
    ].join('\n'), 'Codex直连 · long', 'idle');
    const kimi = terminalConversationExcerpt([
      '✦ 请详细说明检查结果',
      '● Summarize the completed checks for the user.',
      `● ${longAnswer}`,
      'yolo  K3-256k thinking: high  C:\\repo',
    ].join('\n'), 'Kimi直连 · long', 'idle');

    expect(longAnswer.length).toBeGreaterThan(850);
    expect(codex).toMatchObject({ question: '请详细说明检查结果', answer: longAnswer });
    expect(kimi).toMatchObject({ question: '请详细说明检查结果', answer: longAnswer });
  });

  it('creates an unsupervised Codex direct terminal that remains sendable and supervisable', () => {
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    const result = remoteControl({
      action: 'create-task',
      name: '修复登录页',
      task: '检查登录流程并补齐测试',
      cwd: 'E:\\Desktop\\wmux任务\\修复登录页-20260806-090807',
      displayPath: '桌面\\wmux任务\\修复登录页-20260806-090807',
      actor: 'ou-user',
    });

    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('首条任务将在终端就绪后自动发送') });
    const workspace = useStore.getState().workspaces.find((item) => item.title === '修复登录页');
    expect(workspace).toBeTruthy();
    const directSurface = workspace?.splitTree.type === 'leaf' ? workspace.splitTree.surfaces[0] : undefined;
    expect(directSurface).toMatchObject({
      customTitle: 'Codex直连 · 修复登录页',
      cwd: 'E:\\Desktop\\wmux任务\\修复登录页-20260806-090807',
      startupCommands: [expect.stringMatching(/^codex -- \(ConvertFrom-Json /)],
    });
    expect(directSurface?.startupInput).toBeUndefined();
    expect(writes).not.toHaveBeenCalled();

    const listed = JSON.parse(remoteControl({ action: 'list' }).message).terminals.find(
      (terminal: any) => terminal.surfaceId === directSurface?.id,
    );
    expect(listed).toMatchObject({
      label: 'Codex直连 · 修复登录页',
      workspace: '修复登录页',
      cwd: 'E:\\Desktop\\wmux任务\\修复登录页-20260806-090807',
      supervised: false,
      supervisionState: 'none',
    });

    surfaceTerminalRegistry.set(directSurface!.id, {
      buffer: {
        active: {
          baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
    } as any);
    writes.mockClear();
    expect(remoteControl({ action: 'send', terminal: directSurface?.id, task: '继续检查错误处理', actor: 'ou-user' }))
      .toMatchObject({ ok: true });
    expect(writes).toHaveBeenCalledWith(directSurface?.id, '继续检查错误处理');

    expect(remoteControl({
      action: 'start', terminals: [directSurface?.id], stopWhen: '测试通过', stopWhenKind: 'concrete', autonomous: false,
    })).toMatchObject({ ok: true });
    expect(useStore.getState().supervisor.lanes.some((item) => item.surfaceId === directSurface?.id)).toBe(true);
    surfaceTerminalRegistry.delete(directSurface!.id);
  });

  it.each([
    ['kimi', 'Kimi'],
    ['grok', 'Grok'],
  ] as const)('creates a %s direct terminal with the selected launcher', (agent, label) => {
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    expect(remoteControl({
      action: 'create-task',
      name: `${label}任务`,
      task: '执行首条任务',
      agent,
      cwd: `E:\\Desktop\\wmux任务\\${label}任务-20260807-120000`,
    })).toMatchObject({ ok: true, message: expect.stringContaining(`已创建 ${label} 直连终端`) });

    const workspace = useStore.getState().workspaces.find((item) => item.title === `${label}任务`);
    const surface = workspace?.splitTree.type === 'leaf' ? workspace.splitTree.surfaces[0] : undefined;
    expect(surface?.customTitle).toBe(`${label}直连 · ${label}任务`);
    if (agent === 'kimi') {
      expect(surface).toMatchObject({
        startupCommands: ['kimi # wmux-automated-agent-task'],
        startupInput: '执行首条任务',
      });
    } else {
      expect(surface?.startupCommands?.[0]).toMatch(/^grok -- \(ConvertFrom-Json /);
      expect(surface?.startupInput).toBeUndefined();
    }
  });

  it('creates one fixed Grok project management terminal and invokes its progress skill first', () => {
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    useStore.getState().replaceAllWorkspaces([{
      title: '被监督项目',
      cwd: 'E:\\repo',
      splitTree: {
        type: 'leaf', paneId: 'pane-anchor' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '被监督任务' },
          { id: 'worker-neighbor' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '相邻任务' },
        ],
      },
    }]);
    const command = {
      action: 'create-task',
      name: PROJECT_MANAGER_TERMINAL_NAME,
      task: PROJECT_MANAGER_TERMINAL_STARTUP_INPUT,
      agent: 'grok',
      preset: 'project-manager',
      cwd: PROJECT_MANAGER_TERMINAL_CWD,
      anchorTerminal: 'worker-a',
    };

    expect(remoteControl({ ...command, cwd: 'E:\\wrong-project' })).toMatchObject({
      ok: false,
      error: '项目管理终端启动配置无效。',
    });
    expect(useStore.getState().workspaces).toHaveLength(1);
    expect(remoteControl({ ...command, anchorTerminal: 'worker-neighbor' })).toMatchObject({
      ok: false,
      error: '项目管理终端锚点必须是当前被监督的任务终端。',
    });

    expect(remoteControl(command)).toMatchObject({ ok: true, message: expect.stringContaining('项目管理终端') });
    const workspace = useStore.getState().workspaces[0];
    const leaf = workspace.splitTree.type === 'leaf' ? workspace.splitTree : undefined;
    const surface = leaf?.surfaces.find((item) => item.customTitle === PROJECT_MANAGER_TERMINAL_NAME);
    expect(workspace.title).toBe('被监督项目');
    expect(surface).toMatchObject({
      customTitle: PROJECT_MANAGER_TERMINAL_NAME,
      cwd: PROJECT_MANAGER_TERMINAL_CWD,
      startupCommands: [expect.stringMatching(/^grok -- \(ConvertFrom-Json /)],
    });
    expect(surface?.startupInput).toBeUndefined();
    expect(leaf?.activeSurfaceIndex).toBe(2);
    expect(useStore.getState().activeWorkspaceId).toBe(workspace.id);

    expect(remoteControl(command)).toMatchObject({ ok: true, message: '项目管理终端已存在，已切换到该终端。' });
    const after = useStore.getState().workspaces[0].splitTree;
    expect(after.type === 'leaf' ? after.surfaces.filter((item) => item.customTitle === PROJECT_MANAGER_TERMINAL_NAME) : []).toHaveLength(1);
  });

  it('closes an ordinary task terminal and cleans up its last-tab workspace', () => {
    useStore.getState().replaceAllWorkspaces([{
      title: '临时任务',
      splitTree: {
        type: 'leaf', paneId: 'pane-close' as any, activeSurfaceIndex: 0,
        surfaces: [{ id: 'worker-close' as any, type: 'terminal', customTitle: '普通任务' }],
      },
    }]);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({ action: 'close-terminal', terminal: 'worker-close', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: expect.stringContaining('已关闭 普通任务') });
    expect(useStore.getState().workspaces).toHaveLength(0);
    expect(remoteControl({ action: 'close-terminal', terminal: 'worker-close', actor: 'ou-user' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('已关闭') });
  });

  it('stops supervision and closes its dedicated AI before closing a supervised task terminal', () => {
    useStore.getState().replaceAllWorkspaces([{
      title: '监督任务',
      splitTree: {
        type: 'leaf', paneId: 'pane-close-supervised' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', customTitle: '被监督任务' },
          { id: 'supervisor-a' as any, type: 'terminal', customTitle: 'AI 监督 · 被监督任务', transientSupervisor: true },
        ],
      },
    }]);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({ action: 'close-terminal', terminal: 'supervisor-a', actor: 'ou-user' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('专属监督 AI 终端') });
    expect(remoteControl({ action: 'close-terminal', terminal: 'worker-a', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: expect.stringContaining('停止对应 AI 监督通道') });
    expect(useStore.getState().supervisor.lanes).toHaveLength(0);
    expect(useStore.getState().workspaces).toHaveLength(0);
  });

  function decide(params: Record<string, unknown>): any {
    return (globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a',
      supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue',
      reason: '测试裁决',
      ...params,
    });
  }

  it('injects one safe next step from ordinary supervision', () => {
    expect(decide({ next: '运行相关单元测试' })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledWith('worker-a', '运行相关单元测试');
    expect(decide({ next: '重复发送下一步' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('waits for a long next step and Enter, then confirms task-terminal activity', async () => {
    const next = '继续检查当前实现并分段运行相关测试。'.repeat(120);
    const writeReliable = vi.fn(async (surfaceId: string, data: string) => {
      writes(surfaceId, data);
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 2 };
      else screenText = data;
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({ next })).resolves.toMatchObject({
      ok: true,
      outcome: 'continue',
      delivery: { confirmed: true, agentState: 'working' },
    });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', next],
      ['worker-a', '\r'],
    ]);
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(false);
  });

  it('uses bracketed paste for a multi-line next step when the task terminal supports it', async () => {
    (surfaceTerminalRegistry.get('worker-a') as any).modes = { bracketedPasteMode: true };
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 2 };
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({ next: '先检查实现\n再运行测试' })).resolves.toMatchObject({ ok: true });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', '\x1b[200~先检查实现\r再运行测试\x1b[201~'],
      ['worker-a', '\r'],
    ]);
  });

  it('flattens a multi-line next step when bracketed paste is unavailable', async () => {
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 2 };
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({ next: '先检查实现\n再运行测试' })).resolves.toMatchObject({ ok: true });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', '先检查实现 再运行测试'],
      ['worker-a', '\r'],
    ]);
  });

  it('keeps review open when PTY accepts input but terminal state and screen do not change', async () => {
    const writeReliable = vi.fn(async () => true);
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({ next: '运行相关单元测试' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('agent-state'),
      delivery: { confirmed: false, agentState: 'idle', screenChanged: false },
    });
    expect(writeReliable).toHaveBeenCalledWith('worker-a', '运行相关单元测试');
    expect(writeReliable).toHaveBeenCalledWith('worker-a', '\r');
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      autoDecisionsUsed: 0,
      decisions: [],
    });
  });

  it('does not treat an unrelated screen repaint as delivery confirmation', async () => {
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') screenText = '后台日志刷新，但任务状态未变化';
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({ next: '运行相关单元测试' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('仅检测到屏幕变化'),
      delivery: { confirmed: false, agentState: 'idle', screenChanged: true },
    });
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(true);
  });

  it('serializes decisions while one delivery is still in flight', async () => {
    let acceptBody: ((accepted: boolean) => void) | undefined;
    const writeReliable = vi.fn((_surfaceId: string, data: string) => {
      if (data === '第一条裁决') {
        return new Promise<boolean>((resolve) => { acceptBody = resolve; });
      }
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 2 };
      return Promise.resolve(true);
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    const first = decide({ next: '第一条裁决' });
    expect(decide({ next: '并发的第二条裁决' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('已有裁决正在投递'),
    });
    acceptBody?.(true);
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', '第一条裁决'],
      ['worker-a', '\r'],
    ]);
  });

  it('records that a decision needs human review when the automatic limit is reached', () => {
    const appendRecord = vi.fn(async () => undefined);
    (globalThis.window as any).wmux.supervisor = { appendRecord };
    useStore.getState().patchSupervisor({ maxAutoDecisions: 1 });

    expect(decide({ next: '运行相关单元测试' })).toMatchObject({
      ok: true,
      outcome: 'continue',
      requiresHuman: true,
    });
    expect(writes).not.toHaveBeenCalled();
    expect(appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'supervisor.decision',
      payload: expect.objectContaining({ requiresHuman: true }),
    }));
  });

  it('does not append a supervisor next step to an unsubmitted user draft', () => {
    screenText = '│ > 用户尚未提交的任务草稿';
    const terminal = surfaceTerminalRegistry.get('worker-a') as any;
    terminal.buffer.active.cursorX = screenText.length;

    expect(decide({ next: '监督建议的下一步' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('输入框已有未提交内容'),
    });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ awaitingReview: true });
  });

  it('fails closed when the task terminal input state is unavailable', () => {
    surfaceTerminalRegistry.delete('worker-a');

    expect(decide({ next: '监督建议的下一步' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('输入状态不可用'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('allows a bounded route adjustment and rejects material or incomplete proposals', () => {
    expect(decide({ proposalKind: 'route-adjustment', next: '保留接口，改用已有适配器并运行本地测试' }))
      .toMatchObject({ ok: true });
    expect(decide({ proposalKind: 'route-adjustment', next: '' })).toMatchObject({ ok: false });
    expect(decide({ proposalKind: 'route-change', next: '更换框架' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('answers one low-risk technical choice while the worker is blocked', () => {
    agentState = { state: 'blocked', blockedReason: 'technical implementation question: choose adapter A or B', blockedVersion: 1, updatedAt: 2 };
    expect(decide({
      proposalKind: 'route-adjustment',
      next: '选择方案 A：保留现有接口，改用已有适配器并运行本地测试',
    })).toMatchObject({ ok: true });
    expect(writes).toHaveBeenCalledWith('worker-a', '选择方案 A：保留现有接口，改用已有适配器并运行本地测试');

    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({ next: '再次选择方案 A' })).toMatchObject({ ok: false });
    expect(decide({ next: '' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('keeps risky or permission-blocked input out of the technical-choice path', () => {
    agentState = { state: 'blocked', blockedReason: 'question: choose方案 A or方案 B', blockedVersion: 1, updatedAt: 2 };
    expect(decide({ next: '选择方案 A 后 git push origin main' })).toMatchObject({ ok: false });
    agentState = { state: 'blocked', blockedReason: 'permission: npm test', blockedVersion: 2, updatedAt: 3 };
    expect(decide({ next: 'y' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps user-only or ambiguous questions out of the technical-choice path', () => {
    agentState = {
      state: 'blocked',
      blockedReason: 'input required: accept Terms of Service and choose billing plan A/B',
      blockedVersion: 1,
      blockedRequestId: 'business-choice',
      updatedAt: 2,
    };
    expect(decide({ next: '选择方案 A' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('用户偏好'),
    });
    agentState = {
      state: 'blocked',
      blockedReason: 'input required: choose shipping address A or B',
      blockedVersion: 2,
      blockedRequestId: 'shipping-choice',
      updatedAt: 3,
    };
    expect(decide({ next: '选择方案 A' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('blocks high-impact next work before it reaches the worker', () => {
    expect(decide({ next: 'git push origin main' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('requires a task source before autonomously sending next work', () => {
    useStore.getState().patchSupervisor({ taskGoal: '' });

    expect(decide({ next: '运行相关单元测试' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('当前没有任务目标'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('enforces each selected autonomy permission at the decision bridge', () => {
    useStore.getState().patchSupervisor({
      autonomyPermissions: ['technical-choice', 'route-adjustment', 'permission-confirm'],
    });
    expect(decide({ next: '运行相关单元测试' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('继续原路线'),
    });

    useStore.getState().patchSupervisor({ autonomyPermissions: ['same-route-next'] });
    expect(decide({ proposalKind: 'route-adjustment', next: '改用已有适配器并补测试' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('小范围可逆路线调整'),
    });

    agentState = { state: 'blocked', blockedReason: 'technical implementation question: choose adapter A or B', blockedVersion: 1, updatedAt: 2 };
    useStore.getState().patchSupervisor({ autonomyPermissions: ['route-adjustment'] });
    expect(decide({ proposalKind: 'route-adjustment', next: '选择方案 A 并验证' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('回答低风险技术问题'),
    });

    agentState = { state: 'blocked', blockedReason: 'permission: npm test', blockedVersion: 2, updatedAt: 3 };
    useStore.getState().patchSupervisor({ autonomyPermissions: ['same-route-next'] });
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('确认低风险权限请求'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('infers common unlabelled technical choices and route adjustments', () => {
    useStore.getState().patchSupervisor({ autonomyPermissions: ['same-route-next'] });
    expect(decide({ next: '选择方案 A 并运行测试' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('回答低风险技术问题'),
    });
    expect(decide({ next: '改用已有适配器并运行测试' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('小范围可逆路线调整'),
    });
    expect(decide({ next: '放弃现有认证层，从头重做登录流程' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('小范围可逆路线调整'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('enforces selected forbidden items and the current-project boundary', () => {
    expect(decide({ next: '执行 npm install example-package' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('新增或升级第三方依赖'),
    });
    expect(decide({ next: '读取 C:\\other\\config.json 后继续' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('当前工程文件夹之外'),
    });
    useStore.getState().updateLane('lane-a', {
      scopeRoot: 'E:\\repo',
      projectDir: 'D:\\outside',
    });
    expect(decide({ next: '读取 D:\\outside\\config.json 后继续' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('当前工程文件夹之外'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('allows users to clear optional forbidden selections without weakening hard safety', () => {
    useStore.getState().patchSupervisor({ forbiddenActions: [] });
    expect(decide({ next: '执行 npm install example-package' })).toMatchObject({ ok: true });
    expect(writes).toHaveBeenCalledWith('worker-a', '执行 npm install example-package');

    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({ next: 'git push origin main' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('keeps remote package and service operations human-gated even when optional restrictions are cleared', () => {
    useStore.getState().patchSupervisor({ forbiddenActions: [] });
    useStore.getState().updateLane('lane-a', { remoteSshControl: true });

    expect(decide({ next: '在 SSH 终端执行 npm install sharp' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/SSH 远程控制终端.*安装/),
    });
    expect(decide({ next: '在 SSH 终端执行 systemctl restart nginx' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/SSH 远程控制终端.*服务/),
    });
    expect(decide({ next: 'wmux send-key c --ctrl --surface ssh-task' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/SSH 远程控制终端.*中断信号/),
    });
    expect(decide({ next: '在 SSH 终端执行 rm -rf /srv/cache' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/SSH 远程控制终端.*删除/),
    });
    expect(decide({ next: '确认 SSH 远端权限请求并发送 y' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/SSH 远程控制终端.*权限批准/),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('allows stop decisions and needs-human with no autonomy permissions selected', () => {
    useStore.getState().patchSupervisor({ autonomyPermissions: [] });
    expect(decide({ next: '' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('必须携带明确的 --next'),
    });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '请用户补充业务取舍',
      impact: '无法从代码证据判断',
      alternatives: '保持现状',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });

    const approval = useStore.getState().supervisor.pendingApprovals[0];
    useStore.getState().rejectPending(approval.id);
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({ outcome: 'complete', next: '' })).toMatchObject({ ok: true, outcome: 'complete' });
    expect(writes).not.toHaveBeenCalled();
  });

  it('queues a context recovery draft for user confirmation without writing to the worker', () => {
    useStore.getState().updateLane('lane-a', {
      contextRecoveryStatus: 'draft-pending',
      restoreSource: { surfaceId: 'worker-old', label: '旧任务', sessionId: 'sup-old' },
      restoredHistory: '已完成基础实现，下一步恢复测试',
      restoredFromSessionId: 'sup-old',
    });
    const recoveryText = '请恢复当前任务，并按主线程统筹、子线程执行测试的分工继续。';

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'context-recovery',
      reason: '请确认恢复指令',
      next: recoveryText,
    })).toMatchObject({ ok: true, outcome: 'needs-human' });

    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.pendingApprovals[0]).toMatchObject({
      source: 'supervisor-context-recovery',
      proposalKind: 'context-recovery',
      text: recoveryText,
    });
    expect(useStore.getState().supervisor.lanes[0].contextRecoveryStatus).toBe('awaiting-confirmation');
  });

  it('sends the exact context recovery draft only after user approval', () => {
    useStore.getState().updateLane('lane-a', {
      contextRecoveryStatus: 'draft-pending',
      restoreSource: { surfaceId: 'worker-old', label: '旧任务', sessionId: 'sup-old' },
      restoredHistory: '已完成基础实现，下一步恢复测试',
      restoredFromSessionId: 'sup-old',
    });
    const recoveryText = '请恢复当前任务，并按主线程统筹、子线程执行测试的分工继续。';
    expect(decide({
      outcome: 'needs-human', proposalKind: 'context-recovery',
      reason: '请确认恢复指令', next: recoveryText,
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: '已确认上下文恢复指令并发送到 worker。' });
    expect(writes).toHaveBeenCalledWith('worker-a', recoveryText);
    expect(writes).toHaveBeenCalledWith('worker-a', '\r');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      contextRecoveryStatus: 'sent', awaitingReview: false, currentTask: recoveryText,
    });
  });

  it('rejects a context recovery proposal when the lane did not request recovery', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'context-recovery',
      reason: '请确认恢复指令',
      next: '恢复旧任务',
    })).toMatchObject({ ok: false, error: expect.stringContaining('没有等待拟定') });
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps the review window open when task delivery fails', () => {
    writes.mockImplementationOnce(() => { throw new Error('pty closed'); });

    expect(decide({ next: '运行相关单元测试' })).toMatchObject({ ok: false, error: expect.stringContaining('pty closed') });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      autoDecisionsUsed: 0,
      decisions: [],
    });
  });

  it('confirms a low-risk permission without consuming a judgment slot', async () => {
    screenText = 'Command: npm test\nContinue? [y/N]';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: npm test',
      blockedVersion: 1,
      blockedRequestId: 'request-1',
      updatedAt: 2,
    };
    writes.mockImplementation((_surfaceId: string, data: string) => {
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 3 };
    });
    await expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' }))
      .resolves.toMatchObject({ ok: true, autoAuthorized: true });
    expect(writes).toHaveBeenNthCalledWith(1, 'worker-a', 'y');
    expect(useStore.getState().supervisor.lanes[0].autoDecisionsUsed).toBe(0);
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    agentState = { ...agentState, state: 'blocked', updatedAt: 99 };
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it('confirms a permission response through the reliable queue and task-state observation', async () => {
    screenText = 'Command: npm test\nContinue? [y/N]';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: npm test',
      blockedVersion: 1,
      blockedRequestId: 'request-reliable',
      updatedAt: 2,
    };
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 3 };
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;

    await expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).resolves.toMatchObject({
      ok: true,
      autoAuthorized: true,
      delivery: { confirmed: true, agentState: 'working' },
    });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', 'y'],
      ['worker-a', '\r'],
    ]);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: false,
      autoDecisionsUsed: 0,
      lastBlockedResponseId: 'request-reliable',
    });
  });

  it('always sends an SSH-controlling terminal permission request to a human', () => {
    screenText = 'Command: npm test\nContinue? [y/N]';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: npm test',
      blockedVersion: 1,
      blockedRequestId: 'remote-request-1',
      updatedAt: 2,
    };
    useStore.getState().updateLane('lane-a', { remoteSshControl: true });

    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('必须由人工确认'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects a permission command that does not match the current blocked request', () => {
    screenText = 'Command: git push origin main\nContinue? [y/N]';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: git push origin main',
      blockedVersion: 1,
      blockedRequestId: 'request-risky',
      updatedAt: 2,
    };

    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/不一致|推送/),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects permission confirmation without a current permission block', () => {
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects unsafe or malformed permission confirmations', () => {
    agentState = { state: 'blocked', blockedReason: 'permission: command', blockedVersion: 1, updatedAt: 2 };
    expect(decide({ permissionCommand: 'git push origin main', permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'maybe' })).toMatchObject({ ok: false });
    expect(decide({ permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y', next: '继续任务' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects generic permission placeholders even when the screen contains the same words', () => {
    screenText = 'permission required';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission required',
      blockedVersion: 1,
      blockedRequestId: 'generic-permission',
      updatedAt: 2,
    };
    expect(decide({ permissionCommand: 'permission', permissionResponse: 'y' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('具体命令'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([false, true])('always queues needs-human instead of auto-sending (autonomous=%s)', (autonomous) => {
    useStore.getState().patchSupervisor({ autonomous });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'route-change',
      next: '切换主要实现路线',
      impact: '影响外部接口',
      alternatives: '保留当前路线',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
  });

  it('does not let a supervisor bypass a pending user decision after receiving supplemental context', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      reason: '需要用户决定',
      alternatives: '继续或停止',
    })).toMatchObject({ ok: true });

    expect(decide({ outcome: 'continue', next: '根据用户补充意见继续' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('仍有待用户决策项'),
    });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
  });

  it('returns the adopted proposal to the AI supervisor for整理 before worker delivery', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '按现有方案完成实现并运行测试',
      reason: '需要用户批准当前方案',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: '已采用 AI 监督当前方案；AI 监督将整理后发送到任务终端。' });
    expect(writes).toHaveBeenCalledWith(
      'supervisor-a',
      expect.stringContaining('[AI 原建议] 按现有方案完成实现并运行测试'),
    );
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(true);
  });

  it('keeps the pending approval when delivery to the AI supervisor fails', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '按现有方案完成实现并运行测试',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    writes.mockImplementationOnce(() => { throw new Error('supervisor pty closed'); });

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user' }))
      .toMatchObject({ ok: false, error: 'supervisor pty closed' });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(true);
  });

  it('does not append the adopted plan to an existing worker draft', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '按现有方案继续实现',
      reason: '需要用户批准当前方案',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    screenText = '› 用户正在编辑但尚未提交的 Codex 草稿';
    const terminal = surfaceTerminalRegistry.get('worker-a') as any;
    terminal.buffer.active.cursorX = screenText.length;

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user' }))
      .toMatchObject({ ok: true });
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    expect(writes).toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[人工决定]'));
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
  });

  it('accepts only a current AI-provided option for AI-assisted decisions', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '改用新框架重写当前模块',
      reason: '需要用户选择调整方向',
      alternatives: '方案 A：保留现有框架；方案 B：改用新框架',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('请先选择其中一个方案') });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'reject', actor: 'ou-user' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('无效的人工决策') });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', selection: '自定义修改意见', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('不属于 AI 监督当前提供的备选项') });
    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', selection: '方案', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('不属于 AI 监督当前提供的备选项') });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', selection: '方案 A', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: '已选择 方案 A；AI 监督将整理后发送到任务终端。' });
    expect(writes).toHaveBeenCalledWith(
      'supervisor-a',
      expect.stringContaining('[用户选择] 方案 A'),
    );
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
  });

  it('accepts a numbered option parsed from the AI recommendation', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '请你选下一步\n1. 收官（推荐）\n2. 试宽量级\n3. 换策略',
      reason: '需要用户选择调整方向',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', selection: '选项 2', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: '已选择 选项 2；AI 监督将整理后发送到任务终端。' });
    expect(writes).toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[用户选择] 选项 2'));
  });

  it('sends user-entered decision information directly to the worker terminal', () => {
    const appendRecord = vi.fn(async () => undefined);
    (globalThis.window as any).wmux.supervisor = { appendRecord };
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '改用新框架重写当前模块',
      reason: '需要用户选择调整方向',
      alternatives: '方案 A：保留现有框架；方案 B：改用新框架',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'direct', task: '   ', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('请填写') });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'direct',
      task: '保持现有 API，先补充回归测试', actor: 'ou-user',
    })).toMatchObject({
      ok: true,
      message: '已将用户决策直接发送到 worker，并记录为人工裁决。',
    });
    expect(writes).toHaveBeenCalledWith('worker-a', '保持现有 API，先补充回归测试');
    expect(writes).toHaveBeenCalledWith('worker-a', '\r');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(JSON.stringify(appendRecord.mock.calls)).not.toContain('保持现有 API，先补充回归测试');
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: false,
      currentTask: '保持现有 API，先补充回归测试',
    });
  });

  it('keeps the direct decision pending when the worker terminal already has a draft', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      reason: '需要用户提供决策信息',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    screenText = '› 用户正在编辑但尚未提交的 Codex 草稿';
    const terminal = surfaceTerminalRegistry.get('worker-a') as any;
    terminal.buffer.active.cursorX = screenText.length;

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'direct',
      task: '先保持现有实现', actor: 'ou-user',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('输入框已有未提交内容'),
    });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ awaitingReview: true });
  });

  it('pauses only the owning lane from a Feishu decision while retaining the approval and still allows stop', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      reason: '需要人工决定',
      impact: '影响当前实现',
      alternatives: '继续或停止',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'pause', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: expect.stringContaining('已暂停') });
    expect(useStore.getState().supervisor).toMatchObject({ active: true, paused: false });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ controlState: 'paused', enabled: true });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'stop', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: expect.stringContaining('已停止 worker 的 AI 监督') });
    expect(useStore.getState().supervisor).toMatchObject({ active: false, paused: false, pendingApprovals: [] });
    expect(useStore.getState().supervisor.lanes).toEqual([]);
  });

  it('pauses and resumes explicitly from the Feishu control menu without replacing the session', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-control' as any,
      title: 'Work',
      splitTree: {
        type: 'leaf',
        paneId: 'pane-control' as any,
        activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi' },
        ],
      },
    }]);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    const sessionId = useStore.getState().supervisor.sessionId;

    expect(remoteControl({ action: 'pause-all', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: expect.stringContaining('已暂停') });
    expect(useStore.getState().supervisor).toMatchObject({ active: false, paused: true, sessionId });

    expect(remoteControl({ action: 'resume-all', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: '已继续原 AI 监督会话。' });
    expect(useStore.getState().supervisor).toMatchObject({ active: true, paused: false, sessionId });
    expect(writes).toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[会话继续]'));
  });

  it('adds a new supervised terminal from Feishu without replacing the active session', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-control' as any,
      title: 'Work',
      cwd: 'E:\\repo',
      splitTree: {
        type: 'leaf',
        paneId: 'pane-control' as any,
        activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'worker A' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi', customTitle: 'AI 监督 · worker A' },
          { id: 'worker-b' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'worker B' },
          { id: 'supervisor-old-b' as any, type: 'terminal', shell: 'pi', customTitle: 'AI 监督 · worker B（旧）' },
        ],
      },
    }]);
    useStore.getState().patchSupervisor({ supervisorWorkspaceId: 'ws-control' as any });
    useStore.getState().setSupervisorLanes([
      ...useStore.getState().supervisor.lanes,
      {
        ...lane(),
        id: 'lane-old-b',
        label: 'worker B',
        surfaceId: 'worker-b' as any,
        supervisorSurfaceId: 'supervisor-old-b' as any,
        enabled: false,
        controlState: 'stopped',
      },
    ]);
    const before = useStore.getState().supervisor;
    const existingManagementSessionId = before.lanes[0].managementSessionId;
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'start',
      terminals: ['worker-b'],
      stopWhen: '新增终端测试通过',
      stopWhenKind: 'concrete',
      autonomous: false,
      actor: 'ou-user',
    })).toMatchObject({ ok: true, message: expect.stringContaining('已添加 AI 监督终端') });

    const after = useStore.getState().supervisor;
    expect(after).toMatchObject({ active: true, paused: false, sessionId: before.sessionId });
    expect(after.lanes).toHaveLength(2);
    expect(after.lanes[0]).toMatchObject({ surfaceId: 'worker-a', managementSessionId: existingManagementSessionId });
    expect(after.lanes.some((item) => item.id === 'lane-old-b')).toBe(false);
    expect(useStore.getState().workspaces[0].splitTree.type === 'leaf'
      && useStore.getState().workspaces[0].splitTree.surfaces.some((surface) => surface.id === 'supervisor-old-b')).toBe(false);
    expect(after.lanes[1]).toMatchObject({
      surfaceId: 'worker-b',
      awaitingReview: true,
      config: { stopWhen: '新增终端测试通过' },
    });
    expect(writes.mock.calls.some(([surfaceId, text]) => (
      surfaceId === after.lanes[1].supervisorSurfaceId && String(text).includes('新增终端测试通过')
    ))).toBe(true);
  });
});
