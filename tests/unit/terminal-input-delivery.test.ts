import { describe, expect, it, vi } from 'vitest';
import {
  confirmStartupTrustPrompt,
  deliverStartupInput,
  isKimiInteractiveInputReady,
  isStartupTrustPromptReady,
  pasteSubmitDelayMs,
  prepareAutomatedTerminalInput,
  startupTrustPromptAction,
  startupTrustPromptKind,
} from '../../src/renderer/utils/terminal-input-delivery';

describe('terminal startup input delivery', () => {
  it('把多行自动消息合并为一个草稿，只保留最终一次提交', async () => {
    const writeChecked = vi.fn(async () => true);
    const input = '用户澄清答复\n项目：pm-1\r\n答复：继续保持暂停\n';

    expect(prepareAutomatedTerminalInput(input)).toBe('用户澄清答复 项目：pm-1 答复：继续保持暂停');
    await expect(deliverStartupInput({ write: vi.fn(), writeChecked }, 'surf-atomic', input, {
      readyDelayMs: 0,
      wait: async () => undefined,
    })).resolves.toBe(true);

    expect(writeChecked.mock.calls).toEqual([
      ['surf-atomic', '用户澄清答复 项目：pm-1 答复：继续保持暂停'],
      ['surf-atomic', '\r'],
    ]);
  });

  it('精确识别 Codex、Kimi 和 Grok 的目录信任页', () => {
    expect(isStartupTrustPromptReady('codex', 'Do you trust the contents of this directory? 1. Yes, continue')).toBe(true);
    expect(isStartupTrustPromptReady('codex', '1. Yes, continue\n2. No, quit')).toBe(true);
    expect(isStartupTrustPromptReady(
      'codex',
      'Hooks need review\n5 hooks are new or changed.\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won\'t run)',
    )).toBe(true);
    expect(isStartupTrustPromptReady('kimi', "Trust this folder? Trust this folder Don't trust")).toBe(true);
    expect(isStartupTrustPromptReady(
      'grok',
      'This folder contains repo-local config (.mcp.json) that can run commands on your machine.\nTrust the authors of this folder and allow these servers to start? [y/N]',
    )).toBe(true);
    expect(isStartupTrustPromptReady('kimi', 'Welcome to Kimi Code!')).toBe(false);
    expect(isStartupTrustPromptReady('grok', 'Trust this folder for hooks')).toBe(false);
    expect(isStartupTrustPromptReady('pi', 'Trust this folder?')).toBe(false);
  });

  it('只根据实际选中项决定 Codex 和 Kimi 的信任操作', () => {
    expect(startupTrustPromptAction('kimi', '  Trust this folder\n❯ Don\'t trust')).toBe('select-previous');
    expect(startupTrustPromptAction('kimi', '❯ Trust this folder\n  Don\'t trust')).toBe('confirm-selected');
    expect(startupTrustPromptAction('codex', '  1. Yes, continue\n› 2. No, quit')).toBe('select-previous');
    expect(startupTrustPromptAction('codex', '› 1. Yes, continue\n  2. No, quit')).toBe('confirm-selected');
    expect(startupTrustPromptAction(
      'codex',
      'Hooks need review\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won\'t run)',
    )).toBeNull();
    expect(startupTrustPromptAction(
      'codex',
      'Hooks need review\n  1. Review hooks\n› 2. Trust all and continue\n  3. Continue without trusting (hooks won\'t run)',
    )).toBeNull();
    expect(startupTrustPromptAction(
      'codex',
      'Hooks need review\n  1. Review hooks\n  2. Trust all and continue\n› 3. Continue without trusting (hooks won\'t run)',
    )).toBeNull();
    expect(startupTrustPromptAction(
      'kimi',
      "❯ Don't trust\n\n\x1b[2J❯ Trust this folder\n  Don't trust",
    )).toBe('confirm-selected');
    expect(startupTrustPromptAction('kimi', 'Trust this folder?')).toBeNull();
    expect(startupTrustPromptAction('pi', 'Trust this folder?')).toBeNull();
  });

  it('同一 Codex 启动中优先处理后出现的 Hook 审核页', () => {
    const sequentialPrompts = [
      'Do you trust the contents of this directory?',
      '› 1. Yes, continue',
      '  2. No, quit',
      'Hooks need review',
      '› 1. Review hooks',
      '  2. Trust all and continue',
      '  3. Continue without trusting (hooks won\'t run)',
    ].join('\n');

    expect(startupTrustPromptKind('codex', sequentialPrompts)).toBe('hooks');
    expect(startupTrustPromptAction('codex', sequentialPrompts)).toBeNull();
  });

  it('信任页就绪后只发送一次 Enter，并在 PTY 忙时重试', async () => {
    const writeChecked = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(confirmStartupTrustPrompt({ write: vi.fn(), writeChecked }, 'surf-trust', {
      action: 'confirm-selected',
      readyDelayMs: 0,
      retryDelayMs: 0,
      maxAttempts: 3,
      wait: async () => undefined,
    })).resolves.toBe(true);

    expect(writeChecked.mock.calls).toEqual([
      ['surf-trust', '\r'],
      ['surf-trust', '\r'],
    ]);
  });

  it('Kimi 信任页先上移选择 Trust，再发送一次 Enter', async () => {
    const writeChecked = vi.fn(async () => true);

    await expect(confirmStartupTrustPrompt({ write: vi.fn(), writeChecked }, 'surf-kimi-trust', {
      action: 'select-previous',
      readyDelayMs: 0,
      selectionDelayMs: 0,
      wait: async () => undefined,
    })).resolves.toBe(true);

    expect(writeChecked.mock.calls).toEqual([
      ['surf-kimi-trust', '\x1b[A'],
      ['surf-kimi-trust', '\r'],
    ]);

    writeChecked.mockClear();
    await expect(confirmStartupTrustPrompt({ write: vi.fn(), writeChecked }, 'surf-kimi-selected', {
      action: 'confirm-selected',
      readyDelayMs: 0,
      wait: async () => undefined,
    })).resolves.toBe(true);
    expect(writeChecked.mock.calls).toEqual([['surf-kimi-selected', '\r']]);
  });

  it('Codex Hook 审核页必须留给用户处理，不能生成自动确认动作', () => {
    const hooksPrompt = [
      'Hooks need review',
      '› 1. Review hooks',
      '  2. Trust all and continue',
      '  3. Continue without trusting (hooks won\'t run)',
    ].join('\n');

    expect(startupTrustPromptKind('codex', hooksPrompt)).toBe('hooks');
    expect(startupTrustPromptAction('codex', hooksPrompt)).toBeNull();
  });

  it('显式的 wmux 项目、监督或任务授权会自动确认 Codex Hook 信任项', async () => {
    const fromReview = [
      'Hooks need review',
      '› 1. Review hooks',
      '  2. Trust all and continue',
      '  3. Continue without trusting (hooks won\'t run)',
    ].join('\n');
    const alreadySelected = [
      'Hooks need review',
      '  1. Review hooks',
      '› 2. Trust all and continue',
      '  3. Continue without trusting (hooks won\'t run)',
    ].join('\n');

    const action = startupTrustPromptAction('codex', fromReview, 'hooks', {
      allowCodexHookTrust: true,
    });
    expect(action).toBe('select-next');
    expect(startupTrustPromptAction('codex', alreadySelected, 'hooks', {
      allowCodexHookTrust: true,
    })).toBe('confirm-selected');

    let confirmed = false;
    const writeChecked = vi.fn(async () => true);
    await expect(confirmStartupTrustPrompt({ write: vi.fn(), writeChecked }, 'surf-managed-hooks', {
      action: action!,
      readyDelayMs: 0,
      selectionDelayMs: 0,
      confirmationPollMs: 1,
      confirmedWhen: () => confirmed,
      retryActionWhen: () => 'confirm-selected',
      wait: async (delayMs) => { if (delayMs === 1) confirmed = true; },
    })).resolves.toBe(true);
    expect(writeChecked.mock.calls).toEqual([
      ['surf-managed-hooks', '\x1b[B'],
      ['surf-managed-hooks', '\r'],
    ]);
  });

  it('只有信任页得到语义确认后才报告成功', async () => {
    let confirmed = false;
    const writeChecked = vi.fn(async () => true);

    await expect(confirmStartupTrustPrompt({ write: vi.fn(), writeChecked }, 'surf-semantic-trust', {
      action: 'confirm-selected',
      readyDelayMs: 0,
      confirmationPollMs: 1,
      confirmedWhen: () => confirmed,
      retryActionWhen: () => 'confirm-selected',
      wait: async (delayMs) => { if (delayMs === 1) confirmed = true; },
    })).resolves.toBe(true);

    expect(writeChecked.mock.calls).toEqual([['surf-semantic-trust', '\r']]);
  });

  it('信任页未消失时只做有界重试并返回失败', async () => {
    const writeChecked = vi.fn(async () => true);

    await expect(confirmStartupTrustPrompt({ write: vi.fn(), writeChecked }, 'surf-stuck-trust', {
      action: 'confirm-selected',
      readyDelayMs: 0,
      confirmationPollMs: 0,
      confirmationPollAttempts: 4,
      maxConfirmationWrites: 2,
      confirmedWhen: () => false,
      retryActionWhen: () => 'confirm-selected',
      wait: async () => undefined,
    })).resolves.toBe(false);

    expect(writeChecked.mock.calls).toEqual([
      ['surf-stuck-trust', '\r'],
      ['surf-stuck-trust', '\r'],
    ]);
  });

  it('Grok 精确信任提示只写入一次 y 和 Enter', async () => {
    const writeChecked = vi.fn(async () => true);

    await expect(confirmStartupTrustPrompt({ write: vi.fn(), writeChecked }, 'surf-grok-trust', {
      action: 'type-yes',
      readyDelayMs: 0,
      wait: async () => undefined,
    })).resolves.toBe(true);

    expect(writeChecked.mock.calls).toEqual([['surf-grok-trust', 'y\r']]);
  });

  it('只在 Kimi 的首条消息输入界面出现后判定为就绪', () => {
    expect(isKimiInteractiveInputReady('Welcome to Kimi Code!')).toBe(false);
    expect(isKimiInteractiveInputReady('No session yet — one will be created on your first message.')).toBe(true);
    expect(isKimiInteractiveInputReady(
      'No session yet — one will be created on your first message.\nError: Failed to start a session: model missing',
    )).toBe(false);
  });

  it('Kimi 首条消息提交后保留启动窗口，并在会话创建失败时取消就绪', async () => {
    let failed = false;
    const writeChecked = vi.fn(async () => true);

    await expect(deliverStartupInput({ write: vi.fn(), writeChecked }, 'surf-kimi-failed', '项目上下文', {
      cancelWhen: () => failed,
      readyDelayMs: 0,
      submitSettleMs: 2_000,
      wait: async (delayMs) => {
        if (delayMs === 2_000) failed = true;
      },
    })).resolves.toBe(false);

    expect(writeChecked.mock.calls).toEqual([
      ['surf-kimi-failed', '项目上下文'],
      ['surf-kimi-failed', '\r'],
    ]);
  });

  it('等待交互界面的可观测就绪标记后才写入', async () => {
    let readyChecks = 0;
    const writeChecked = vi.fn(async () => true);

    await expect(deliverStartupInput({ write: vi.fn(), writeChecked }, 'surf-kimi', '执行首条任务', {
      readyWhen: () => ++readyChecks >= 3,
      readyDelayMs: 0,
      readyPollMs: 1,
      readyTimeoutMs: 10,
      retryDelayMs: 0,
      wait: async () => undefined,
    })).resolves.toBe(true);

    expect(readyChecks).toBe(3);
    expect(writeChecked.mock.calls[0]).toEqual(['surf-kimi', '执行首条任务']);
  });

  it('交互界面未就绪时失败且不提前写入', async () => {
    const writeChecked = vi.fn(async () => true);

    await expect(deliverStartupInput({ write: vi.fn(), writeChecked }, 'surf-kimi', '不要抢先发送', {
      readyWhen: () => false,
      readyDelayMs: 0,
      readyPollMs: 1,
      readyTimeoutMs: 2,
      wait: async () => undefined,
    })).resolves.toBe(false);

    expect(writeChecked).not.toHaveBeenCalled();
  });

  it('Agent 启动失败后取消等待且不向普通 shell 写入', async () => {
    const writeChecked = vi.fn(async () => true);
    let cancelled = false;

    await expect(deliverStartupInput({ write: vi.fn(), writeChecked }, 'surf-failed', '不要投进普通 shell', {
      cancelWhen: () => cancelled,
      readyWhen: () => false,
      readyTimeoutMs: 1_000,
      readyPollMs: 100,
      wait: async () => { cancelled = true; },
    })).resolves.toBe(false);

    expect(writeChecked).not.toHaveBeenCalled();
  });

  it('等待 PTY 可写后再发送任务，并且只提交一次', async () => {
    const writeChecked = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const wait = vi.fn(async () => undefined);

    await expect(deliverStartupInput({ write: vi.fn(), writeChecked }, 'surf-1', '执行首条任务', {
      readyDelayMs: 0,
      retryDelayMs: 0,
      maxAttempts: 5,
      wait,
    })).resolves.toBe(true);

    expect(writeChecked.mock.calls).toEqual([
      ['surf-1', '执行首条任务'],
      ['surf-1', '执行首条任务'],
      ['surf-1', '执行首条任务'],
      ['surf-1', '\r'],
    ]);
    expect(wait).toHaveBeenCalledWith(pasteSubmitDelayMs('执行首条任务'));
  });

  it('任务文本写入成功后仅重试 Enter，避免重复粘贴任务', async () => {
    const writeChecked = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(deliverStartupInput({ write: vi.fn(), writeChecked }, 'surf-2', '不要重复发送', {
      readyDelayMs: 0,
      retryDelayMs: 0,
      maxAttempts: 4,
      wait: async () => undefined,
    })).resolves.toBe(true);

    expect(writeChecked.mock.calls.filter(([, data]) => data === '不要重复发送')).toHaveLength(1);
    expect(writeChecked.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(3);
  });

  it('PTY 始终不可用时返回失败且不发送 Enter', async () => {
    const writeChecked = vi.fn(async () => false);

    await expect(deliverStartupInput({ write: vi.fn(), writeChecked }, 'surf-3', '执行任务', {
      readyDelayMs: 0,
      retryDelayMs: 0,
      maxAttempts: 3,
      wait: async () => undefined,
    })).resolves.toBe(false);

    expect(writeChecked).toHaveBeenCalledTimes(3);
    expect(writeChecked.mock.calls.some(([, data]) => data === '\r')).toBe(false);
  });

  it('兼容没有 writeChecked 的旧桥接，但仍在 PTY 创建后按粘贴和提交顺序发送', async () => {
    const write = vi.fn();

    await expect(deliverStartupInput({ write }, 'surf-4', '兼容任务', {
      readyDelayMs: 0,
      retryDelayMs: 0,
      wait: async () => undefined,
    })).resolves.toBe(true);

    expect(write.mock.calls).toEqual([
      ['surf-4', '兼容任务'],
      ['surf-4', '\r'],
    ]);
  });
});
