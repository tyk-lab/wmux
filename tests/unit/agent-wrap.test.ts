import { describe, it, expect } from 'vitest';
import { parseWrapArgs, shouldTrackAgent } from '../../src/cli/agent-wrap';

describe('parseWrapArgs', () => {
  it('parses a bare command', () => {
    const r = parseWrapArgs(['wrap', 'kimi']);
    expect(r).toEqual({
      ok: true,
      plan: { label: undefined, surfaceId: undefined, cmd: 'kimi', cmdArgs: [] },
    });
  });

  it('parses command args after --', () => {
    const r = parseWrapArgs(['wrap', '--', 'codex', '--full-auto', 'fix it']);
    expect(r.ok && r.plan).toMatchObject({
      cmd: 'codex',
      cmdArgs: ['--full-auto', 'fix it'],
    });
  });

  it('accepts --label and --surface', () => {
    const r = parseWrapArgs(['wrap', '--label', 'kimi', '--surface', 'surf-1', 'kimi', '-p']);
    expect(r).toEqual({
      ok: true,
      plan: {
        label: 'kimi',
        surfaceId: 'surf-1',
        cmd: 'kimi',
        cmdArgs: ['-p'],
      },
    });
  });

  it('uses ambient surface when flag omitted', () => {
    const r = parseWrapArgs(['wrap', 'opencode'], 'surf-env');
    expect(r.ok && r.plan.surfaceId).toBe('surf-env');
  });

  it('--surface overrides ambient', () => {
    const r = parseWrapArgs(['wrap', '--surface', 'surf-flag', 'x'], 'surf-env');
    expect(r.ok && r.plan.surfaceId).toBe('surf-flag');
  });

  it('errors on missing command', () => {
    const r = parseWrapArgs(['wrap']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing command/);
  });

  it('errors on unknown flag', () => {
    const r = parseWrapArgs(['wrap', '--nope', 'kimi']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown flag/);
  });

  it('errors when --label has no value', () => {
    const r = parseWrapArgs(['wrap', '--label']);
    expect(r.ok).toBe(false);
  });
});

describe('shouldTrackAgent', () => {
  it('tracks only when surfaceId is set', () => {
    expect(shouldTrackAgent({ cmd: 'kimi', cmdArgs: [], surfaceId: 's1' })).toBe(true);
    expect(shouldTrackAgent({ cmd: 'kimi', cmdArgs: [] })).toBe(false);
  });
});
