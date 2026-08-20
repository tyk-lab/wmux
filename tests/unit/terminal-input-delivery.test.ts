import { describe, expect, it, vi } from 'vitest';
import {
  confirmStartupTrustPrompt,
  deliverStartupInput,
  isKimiInteractiveInputReady,
  isStartupTrustPromptReady,
  pasteSubmitDelayMs,
  prepareAutomatedTerminalInput,
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

  it('识别 Codex 和 Kimi 的目录信任页，且不误判普通欢迎页', () => {
    expect(isStartupTrustPromptReady('codex', 'Do you trust the contents of this directory? 1. Yes, continue')).toBe(true);
    expect(isStartupTrustPromptReady('codex', '1. Yes, continue\n2. No, quit')).toBe(true);
    expect(isStartupTrustPromptReady('kimi', "Trust this folder? Trust this folder Don't trust")).toBe(true);
    expect(isStartupTrustPromptReady('kimi', 'Welcome to Kimi Code!')).toBe(false);
  });

  it('信任页就绪后只发送一次 Enter，并在 PTY 忙时重试', async () => {
    const writeChecked = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(confirmStartupTrustPrompt({ write: vi.fn(), writeChecked }, 'surf-trust', {
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

  it('只在 Kimi 的首条消息输入界面出现后判定为就绪', () => {
    expect(isKimiInteractiveInputReady('Welcome to Kimi Code!')).toBe(false);
    expect(isKimiInteractiveInputReady('No session yet — one will be created on your first message.')).toBe(true);
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
