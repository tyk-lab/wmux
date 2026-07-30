import { describe, it, expect } from 'vitest';
import {
  formatAgentLifecycleText,
  lifecycleDedupeKey,
  shouldDedupeLifecycleNotify,
  LIFECYCLE_DEDUP_MS,
} from '../../src/renderer/agent-lifecycle-notify';

describe('formatAgentLifecycleText', () => {
  it('uses agent-agnostic turn finished copy without workspace name', () => {
    expect(formatAgentLifecycleText({ kind: 'turn_finished' })).toBe('Turn finished');
    expect(formatAgentLifecycleText({ kind: 'turn_finished', where: 'api' }))
      .toBe('Turn finished · api');
  });

  it('does not say Claude Code', () => {
    const text = formatAgentLifecycleText({ kind: 'turn_finished', where: 'Workspace 2' });
    expect(text.toLowerCase()).not.toContain('claude');
  });

  it('prefers the agent message for needs_input and appends where', () => {
    expect(formatAgentLifecycleText({
      kind: 'needs_input',
      message: 'Allow Bash?',
      where: 'kimi-a',
    })).toBe('Allow Bash? · kimi-a');
  });

  it('truncates long permission messages', () => {
    const long = 'x'.repeat(120);
    const text = formatAgentLifecycleText({ kind: 'needs_input', message: long });
    expect(text.length).toBeLessThanOrEqual(80);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('lifecycle dedupe', () => {
  it('keys by surface so two panes do not collapse into one', () => {
    expect(lifecycleDedupeKey('turn_finished', 'surf-a', 'ws-1'))
      .not.toBe(lifecycleDedupeKey('turn_finished', 'surf-b', 'ws-1'));
  });

  it('suppresses a second identical event inside the window', () => {
    const key = lifecycleDedupeKey('turn_finished', 'surf-a', 'ws-1');
    const last = { key, at: 1000 };
    expect(shouldDedupeLifecycleNotify(last, key, 1000 + LIFECYCLE_DEDUP_MS - 1)).toBe(true);
    expect(shouldDedupeLifecycleNotify(last, key, 1000 + LIFECYCLE_DEDUP_MS + 1)).toBe(false);
  });
});
