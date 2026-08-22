import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applyCodexProjectTrust,
  applyWmuxCodexHooks,
  ensureCodexProjectTrusted,
  ensureCodexSupervisorRuntimeTrusted,
} from '../../src/main/codex-context';

const SCRIPT = 'C:/wmux/resources/cli/wmux-hook.js';

describe('applyWmuxCodexHooks', () => {
  it('creates hooks for an empty file', () => {
    const next = applyWmuxCodexHooks({}, SCRIPT);
    expect(next.hooks.UserPromptSubmit).toBeDefined();
    expect(next.hooks.PreToolUse).toBeDefined();
    expect(next.hooks.Stop[0].hooks[0].command).toContain('--event Stop');
    expect(next.hooks.Notification).toBeUndefined();
    expect(next.hooks.StopFailure).toBeUndefined();
  });

  it('removes stale unsupported wmux hooks while preserving user hooks', () => {
    const next = applyWmuxCodexHooks({
      hooks: {
        Notification: [
          { hooks: [{ type: 'command', command: `node "${SCRIPT}" --event Notification` }] },
          { hooks: [{ type: 'command', command: 'notify-user' }] },
        ],
      },
    }, SCRIPT);

    expect(next.hooks.Notification).toHaveLength(1);
    expect(next.hooks.Notification[0].hooks[0].command).toBe('notify-user');
  });

  it('preserves existing non-wmux Stop hooks', () => {
    const next = applyWmuxCodexHooks({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'python stop.py' }] }],
      },
    }, SCRIPT);
    expect(next.hooks.Stop).toHaveLength(2);
    expect(next.hooks.Stop[0].hooks[0].command).toBe('python stop.py');
  });

});

describe('applyCodexProjectTrust', () => {
  it('appends one escaped trusted project without changing existing settings', () => {
    const current = 'model = "gpt-5"\n';
    const next = applyCodexProjectTrust(current, 'C:\\Users\\tyk\\Desktop\\wmux任务\\修复登录');

    expect(next).toContain('model = "gpt-5"\n');
    expect(next).toContain('[projects."c:\\\\users\\\\tyk\\\\desktop\\\\wmux任务\\\\修复登录"]');
    expect(next).toContain('trust_level = "trusted"');
  });

  it('updates an existing project table and remains idempotent', () => {
    const current = [
      "[projects.'c:\\users\\tyk\\desktop\\wmux任务\\修复登录']",
      'trust_level = "untrusted" # keep comment',
      '',
      '[features]',
      'apps = false',
      '',
    ].join('\n');
    const next = applyCodexProjectTrust(current, 'C:\\Users\\TYK\\Desktop\\wmux任务\\修复登录');

    expect(next).toContain('trust_level = "trusted" # keep comment');
    expect(next.match(/\[projects\./g)).toHaveLength(1);
    expect(applyCodexProjectTrust(next, 'C:\\Users\\tyk\\Desktop\\wmux任务\\修复登录')).toBe(next);
  });

  it('atomically updates an existing config file on Windows', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-trust-'));
    const configPath = path.join(directory, 'config.toml');
    try {
      fs.writeFileSync(configPath, 'model = "gpt-5"\n', 'utf-8');
      ensureCodexProjectTrusted('C:\\Users\\tyk\\Desktop\\wmux任务\\运行验证', configPath);
      const saved = fs.readFileSync(configPath, 'utf-8');
      expect(saved).toContain('model = "gpt-5"');
      expect(saved).toContain('trust_level = "trusted"');
      expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('trusts only the normalized wmux-owned supervisor runtime directory', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-supervisor-trust-'));
    const configPath = path.join(directory, 'codex', 'config.toml');
    const appDataRoot = path.join(directory, 'app-data');
    try {
      const runtimeDirectory = ensureCodexSupervisorRuntimeTrusted(
        appDataRoot,
        '..',
        'test-instance',
        configPath,
      );

      expect(runtimeDirectory).toBe(path.join(
        appDataRoot,
        'wmux-test-instance',
        'supervisor',
        'runtime',
        'default',
      ));
      expect(fs.statSync(runtimeDirectory).isDirectory()).toBe(true);
      expect(fs.readFileSync(configPath, 'utf-8')).toContain('trust_level = "trusted"');
      expect(() => ensureCodexSupervisorRuntimeTrusted(
        appDataRoot,
        'lane-safe',
        '..\\..\\..\\escape',
        configPath,
      )).toThrow('监督运行根目录超出应用数据目录');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
