import { describe, it, expect } from 'vitest';
import {
  formatAgentLifecycleText,
  inferAgentName,
  joinAgentIdentity,
  lifecycleDedupeKey,
  shouldDedupeLifecycleNotify,
  LIFECYCLE_DEDUP_MS,
} from '../../src/renderer/agent-lifecycle-notify';

describe('inferAgentName', () => {
  it('detects common harness names from free text', () => {
    expect(inferAgentName('tyk-kimi')).toBe('Kimi');
    expect(inferAgentName('run with claude code')).toBe('Claude');
    expect(inferAgentName('codex')).toBe('Codex');
    expect(inferAgentName('Grok Build')).toBe('Grok');
    expect(inferAgentName('opencode worker')).toBe('OpenCode');
  });

  it('returns null when nothing matches', () => {
    expect(inferAgentName('api-server', 'build')).toBeNull();
  });
});

describe('joinAgentIdentity', () => {
  it('joins agent and where without duplicating the same string', () => {
    expect(joinAgentIdentity('Kimi', 'tyk-kimi')).toBe('Kimi · tyk-kimi');
    expect(joinAgentIdentity('Kimi', 'Kimi')).toBe('Kimi');
    expect(joinAgentIdentity(null, 'tyk-kimi')).toBe('tyk-kimi');
  });
});

describe('formatAgentLifecycleText', () => {
  it('formats turn complete with agent and pane label (panel line 2)', () => {
    expect(formatAgentLifecycleText({
      kind: 'turn_finished',
      agent: 'Kimi',
      where: 'tyk-kimi',
    })).toBe('Turn complete · Kimi · tyk-kimi');
  });

  it('does not say Claude Code or include the workspace title', () => {
    const text = formatAgentLifecycleText({
      kind: 'turn_finished',
      agent: 'Kimi',
      where: 'tyk-kimi',
    });
    expect(text.toLowerCase()).not.toContain('claude code');
    expect(text).not.toContain('Workspace');
  });

  it('formats needs_input with agent identity', () => {
    expect(formatAgentLifecycleText({
      kind: 'needs_input',
      agent: 'Codex',
      where: 'surf-1',
      message: 'Allow Bash?',
    })).toBe('Allow Bash? · Codex · surf-1');
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
