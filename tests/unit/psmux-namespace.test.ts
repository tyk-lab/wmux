import { describe, expect, it } from 'vitest';
import { getPsmuxNamespace, withPsmuxNamespace } from '../../src/shared/psmux';

describe('psmux namespace', () => {
  it('uses the Surface ID as a deterministic isolated server namespace', () => {
    expect(getPsmuxNamespace('surf-1234-abcd')).toBe('surf-1234-abcd');
  });

  it('normalizes unsafe characters and limits the namespace length', () => {
    const namespace = getPsmuxNamespace(`surf bad;${'x'.repeat(100)}`);
    expect(namespace).toHaveLength(80);
    expect(namespace).toMatch(/^surf-bad-x+$/u);
  });

  it('prefixes psmux commands only when a namespace exists', () => {
    expect(withPsmuxNamespace('surf-1', ['attach', '-t', 'wmx-1']))
      .toEqual(['-L', 'surf-1', 'attach', '-t', 'wmx-1']);
    expect(withPsmuxNamespace(undefined, ['ls'])).toEqual(['ls']);
  });
});
