import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFeishuDirectTaskDirectory,
  resolveExistingFeishuDirectTaskDirectory,
  sanitizeFeishuDirectTaskName,
} from '../../src/main/feishu-direct-task';

describe('飞书直连终端任务目录', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('清理 Windows 非法字符、保留名和末尾点号', () => {
    expect(sanitizeFeishuDirectTaskName('  登录页:修复?  ')).toBe('登录页-修复-');
    expect(sanitizeFeishuDirectTaskName('控制\u0000字符')).toBe('控制-字符');
    expect(sanitizeFeishuDirectTaskName('CON')).toBe('任务-CON');
    expect(sanitizeFeishuDirectTaskName('...')).toBe('Codex任务');
  });

  it('在桌面 wmux任务 下创建带时间戳的唯一目录', () => {
    const desktop = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-desktop-'));
    temporaryDirectories.push(desktop);
    const now = new Date(2026, 7, 6, 9, 8, 7);

    const first = createFeishuDirectTaskDirectory(desktop, '修复登录页', now);
    const second = createFeishuDirectTaskDirectory(desktop, '修复登录页', now);

    expect(first.folderName).toBe('修复登录页-20260806-090807');
    expect(second.folderName).toBe('修复登录页-20260806-090807-2');
    expect(first.displayPath).toBe('桌面\\wmux任务\\修复登录页-20260806-090807');
    expect(fs.statSync(first.cwd).isDirectory()).toBe(true);
    expect(fs.statSync(second.cwd).isDirectory()).toBe(true);
  });

  it('复用已存在的绝对目录且不创建任务子目录', () => {
    const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-existing-'));
    temporaryDirectories.push(existing);

    expect(resolveExistingFeishuDirectTaskDirectory(existing, '登录页:修复')).toEqual({
      cwd: path.resolve(existing),
      folderName: path.basename(existing),
      taskName: '登录页-修复',
      displayPath: path.resolve(existing),
    });
    expect(() => resolveExistingFeishuDirectTaskDirectory('relative-path', '任务')).toThrow('绝对路径');
    expect(() => resolveExistingFeishuDirectTaskDirectory(path.join(existing, 'missing'), '任务')).toThrow();
  });
});
