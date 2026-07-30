import { describe, it, expect } from 'vitest';
import {
  applyWmuxKimiHooksToml,
  buildWmuxKimiHooksBlock,
  makeKimiHookCommand,
  tomlQuote,
  WMUX_KIMI_START,
  WMUX_KIMI_END,
  KIMI_WMUX_HOOK_EVENTS,
} from '../../src/main/kimi-context';

const SCRIPT = 'C:/wmux/resources/cli/wmux-hook.js';

describe('makeKimiHookCommand', () => {
  it('quotes the script path and passes --event', () => {
    expect(makeKimiHookCommand(SCRIPT, 'Stop')).toBe(
      `node "${SCRIPT}" --event Stop`,
    );
  });
});

describe('tomlQuote', () => {
  it('escapes backslashes and quotes', () => {
    expect(tomlQuote('a\\b"c')).toBe('"a\\\\b\\"c"');
  });
});

describe('buildWmuxKimiHooksBlock', () => {
  it('emits every turn-level event between markers', () => {
    const block = buildWmuxKimiHooksBlock(SCRIPT);
    expect(block.startsWith(WMUX_KIMI_START)).toBe(true);
    expect(block.endsWith(WMUX_KIMI_END)).toBe(true);
    for (const event of KIMI_WMUX_HOOK_EVENTS) {
      expect(block).toContain(`event = "${event}"`);
      expect(block).toContain(`--event ${event}`);
    }
    expect(block).toContain('[[hooks]]');
  });
});

describe('applyWmuxKimiHooksToml', () => {
  it('appends the block to empty config', () => {
    const next = applyWmuxKimiHooksToml('', SCRIPT);
    expect(next).toContain(WMUX_KIMI_START);
    expect(next).toContain('UserPromptSubmit');
    expect(next.endsWith('\n')).toBe(true);
  });

  it('preserves user content outside markers', () => {
    const existing = 'default_model = "kimi"\n\nyolo = true\n';
    const next = applyWmuxKimiHooksToml(existing, SCRIPT);
    expect(next).toMatch(/^default_model = "kimi"/);
    expect(next).toContain('yolo = true');
    expect(next).toContain(WMUX_KIMI_START);
  });

  it('replaces a previous wmux block idempotently', () => {
    const first = applyWmuxKimiHooksToml('foo = 1\n', SCRIPT);
    const v2 = 'C:/wmux/resources/cli/wmux-hook-v2.js';
    const second = applyWmuxKimiHooksToml(first, v2);
    expect(second.match(/# wmux-hooks:start/g)?.length).toBe(1);
    expect(second).toContain('wmux-hook-v2.js');
    expect(second).toContain('foo = 1');
    expect(second).not.toContain('/wmux-hook.js');
  });
});
