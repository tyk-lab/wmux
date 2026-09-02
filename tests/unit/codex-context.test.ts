import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applyCodexHooksDisabledOutsideWmux,
  applyCodexProjectTrust,
  applyTrustedWmuxCodexHookState,
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

describe('applyCodexHooksDisabledOutsideWmux', () => {
  it('adds the disabled default to an existing features table and remains idempotent', () => {
    const current = [
      'model = "gpt-5.6-sol"',
      '',
      '[features]',
      'multi_agent = true',
      '',
      '[agents]',
      'enabled = true',
      '',
    ].join('\n');

    const next = applyCodexHooksDisabledOutsideWmux(current);

    expect(next).toContain('[features]\nhooks = false\nmulti_agent = true');
    expect(applyCodexHooksDisabledOutsideWmux(next)).toBe(next);
  });

  it('turns an enabled Hooks feature off without changing its comment', () => {
    const current = '[features]\r\nhooks = true # user default\r\napps = false\r\n';
    expect(applyCodexHooksDisabledOutsideWmux(current))
      .toBe('[features]\r\nhooks = false # user default\r\napps = false\r\n');
  });

  it('updates quoted feature tables and keys without creating duplicate TOML definitions', () => {
    const current = '["features"]\n"hooks" = true # user default\napps = false\n';
    expect(applyCodexHooksDisabledOutsideWmux(current))
      .toBe('["features"]\n"hooks" = false # user default\napps = false\n');
  });

  it('updates a root dotted key without appending a duplicate features table', () => {
    const current = 'features.hooks = true # user default\nmodel = "gpt-5"\n';
    expect(applyCodexHooksDisabledOutsideWmux(current))
      .toBe('features.hooks = false # user default\nmodel = "gpt-5"\n');
  });

  it('keeps an existing dotted features table in dotted-key form', () => {
    const current = 'features.multi_agent = true\nmodel = "gpt-5"\n';
    expect(applyCodexHooksDisabledOutsideWmux(current))
      .toBe('features.multi_agent = true\nfeatures.hooks = false\nmodel = "gpt-5"\n');
  });

  it('creates a features table when the config has none', () => {
    expect(applyCodexHooksDisabledOutsideWmux('model = "gpt-5"\n'))
      .toBe('model = "gpt-5"\n\n[features]\nhooks = false\n');
  });
});

describe('applyTrustedWmuxCodexHookState', () => {
  it('enables only already-trusted wmux handlers from the exact hooks file', () => {
    const hooksPath = 'C:\\Users\\tyk\\.codex\\hooks.json';
    const hooksRoot = applyWmuxCodexHooks({}, SCRIPT);
    const current = [
      `[hooks.state.'${hooksPath}:user_prompt_submit:0:0']`,
      'trusted_hash = "sha256:aaaaaaaa"',
      'enabled = false',
      '',
      `[hooks.state.'${hooksPath}:stop:0:0']`,
      'trusted_hash = "sha256:bbbbbbbb"',
      'enabled = true',
      '',
      `[hooks.state.'${hooksPath}:pre_tool_use:0:0']`,
      'enabled = false',
      '',
      "[hooks.state.'C:\\other\\hooks.json:stop:0:0']",
      'trusted_hash = "sha256:cccccccc"',
      'enabled = false',
      '',
    ].join('\n');

    const result = applyTrustedWmuxCodexHookState(current, hooksRoot, hooksPath);

    expect(result.enabledEvents).toEqual(['UserPromptSubmit']);
    expect(result.alreadyEnabledEvents).toEqual(['Stop']);
    expect(result.pendingTrustEvents).toEqual(expect.arrayContaining([
      'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStop',
    ]));
    expect(result.pendingTrustEvents).toHaveLength(4);
    expect(result.content).toContain(`[hooks.state.'${hooksPath}:user_prompt_submit:0:0']\ntrusted_hash = "sha256:aaaaaaaa"\nenabled = true`);
    expect(result.content).toContain("[hooks.state.'C:\\other\\hooks.json:stop:0:0']\ntrusted_hash = \"sha256:cccccccc\"\nenabled = false");
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
