import { describe, it, expect } from 'vitest';
import { buildGrokWmuxHooksFile } from '../../src/main/grok-context';

const SCRIPT = 'C:/wmux/resources/cli/wmux-hook.js';

describe('buildGrokWmuxHooksFile', () => {
  it('emits Claude-compatible hooks for Grok global discovery', () => {
    const file = buildGrokWmuxHooksFile(SCRIPT);
    expect(file.hooks.UserPromptSubmit).toBeDefined();
    expect(file.hooks.PostToolUse).toBeDefined();
    expect(file.hooks.Stop).toBeDefined();
    expect(file.hooks.Notification).toBeDefined();
    expect(file.description).toMatch(/wmux/i);
  });
});
