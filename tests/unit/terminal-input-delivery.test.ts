import { describe, expect, it, vi } from 'vitest';
import { deliverStartupInput, pasteSubmitDelayMs } from '../../src/renderer/utils/terminal-input-delivery';

describe('terminal startup input delivery', () => {
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
