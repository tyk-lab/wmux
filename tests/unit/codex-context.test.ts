import { describe, it, expect } from 'vitest';
import { applyWmuxCodexHooks } from '../../src/main/codex-context';

const SCRIPT = 'C:/wmux/resources/cli/wmux-hook.js';

describe('applyWmuxCodexHooks', () => {
  it('creates hooks for an empty file', () => {
    const next = applyWmuxCodexHooks({}, SCRIPT);
    expect(next.hooks.UserPromptSubmit).toBeDefined();
    expect(next.hooks.Stop[0].hooks[0].command).toContain('--event Stop');
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
