import { describe, it, expect } from 'vitest';
import {
  applyWmuxLifecycleHooks,
  buildWmuxHooksJsonFile,
  isWmuxHookCommand,
  stripWmuxHookGroups,
  WMUX_LIFECYCLE_EVENTS,
} from '../../src/main/lifecycle-hooks';

const SCRIPT = 'C:/wmux/resources/cli/wmux-hook.js';

describe('isWmuxHookCommand', () => {
  it('detects wmux-hook and report-agent commands', () => {
    expect(isWmuxHookCommand(`node "${SCRIPT}" --event Stop`)).toBe(true);
    expect(isWmuxHookCommand('wmux report-agent --run-depth 0')).toBe(true);
    expect(isWmuxHookCommand('prettier --write')).toBe(false);
  });
});

describe('stripWmuxHookGroups', () => {
  it('keeps user groups and drops wmux-only groups', () => {
    const groups = [
      { hooks: [{ type: 'command', command: 'echo user' }] },
      { hooks: [{ type: 'command', command: `node "${SCRIPT}" --event Stop` }] },
    ];
    const next = stripWmuxHookGroups(groups);
    expect(next).toHaveLength(1);
    expect(next[0].hooks[0].command).toBe('echo user');
  });
});

describe('applyWmuxLifecycleHooks', () => {
  it('merges into a full settings object without clobbering user hooks', () => {
    const settings = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
      },
      other: true,
    };
    const next = applyWmuxLifecycleHooks(settings, SCRIPT, undefined, 'Codex');
    expect(next.other).toBe(true);
    expect(next.hooks.Stop).toHaveLength(2);
    expect(next.hooks.Stop[0].hooks[0].command).toBe('echo mine');
    expect(next.hooks.Stop[1].hooks[0].command).toContain('--event Stop');
    expect(next.hooks.Stop[1].hooks[0].command).toContain('--agent Codex');
    for (const event of WMUX_LIFECYCLE_EVENTS) {
      expect(next.hooks[event]?.length).toBeGreaterThan(0);
    }
  });

  it('is idempotent when re-applied', () => {
    const once = applyWmuxLifecycleHooks({ hooks: {} }, SCRIPT);
    const twice = applyWmuxLifecycleHooks(once, SCRIPT);
    expect(twice.hooks.UserPromptSubmit).toHaveLength(1);
    expect(twice.hooks.Stop).toHaveLength(1);
  });

  it('normalizes native event names and removes stale wmux groups only', () => {
    const existing = {
      hooks: {
        StopFailure: [{ hooks: [{ command: `node "${SCRIPT}" --event StopFailure` }] }],
        Custom: [{ hooks: [{ command: 'echo user' }] }],
      },
    };
    const next = applyWmuxLifecycleHooks(existing, SCRIPT, [
      'UserPromptSubmit',
      { hookEvent: 'StopCancelled', protocolEvent: 'Interrupt' },
    ], 'Grok');

    expect(next.hooks.StopFailure).toBeUndefined();
    expect(next.hooks.Custom[0].hooks[0].command).toBe('echo user');
    expect(next.hooks.StopCancelled[0].hooks[0].command).toContain('--event Interrupt');
  });
});

describe('buildWmuxHooksJsonFile', () => {
  it('builds a standalone hooks.json with description', () => {
    const file = buildWmuxHooksJsonFile(SCRIPT, 'wmux managed');
    expect(file.description).toBe('wmux managed');
    expect(file.hooks.UserPromptSubmit[0].hooks[0].command).toContain('UserPromptSubmit');
  });
});
