import { describe, it, expect } from 'vitest';
import { buildGrokWmuxHooksFile } from '../../src/main/grok-context';

const SCRIPT = 'C:/wmux/resources/cli/wmux-hook.js';

describe('buildGrokWmuxHooksFile', () => {
  it('emits nested lifecycle hooks for Grok global discovery', () => {
    const file = buildGrokWmuxHooksFile(SCRIPT);
    expect(file.hooks.UserPromptSubmit).toBeDefined();
    expect(file.hooks.PreToolUse).toBeDefined();
    expect(file.hooks.PostToolUse).toBeDefined();
    expect(file.hooks.Stop).toBeDefined();
    expect(file.hooks.Notification).toBeDefined();
    expect(file.hooks.StopCancelled[0].hooks[0].command).toContain('--event Interrupt');
    expect(file.hooks.PermissionRequest).toBeUndefined();
    expect(file.description).toMatch(/wmux/i);
  });
});
