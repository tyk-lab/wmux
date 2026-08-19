import { describe, expect, it } from 'vitest';
import { requireSuccessfulContext } from '../../src/cli/context-result';

describe('CLI role context result', () => {
  it('throws for renderer-level failures so the CLI exits non-zero', () => {
    expect(() => requireSuccessfulContext({ ok: false, error: '身份绑定已失效' }))
      .toThrow('身份绑定已失效');
  });

  it('returns a successful context unchanged', () => {
    const context = { ok: true, role: 'task' };
    expect(requireSuccessfulContext(context)).toBe(context);
  });
});
