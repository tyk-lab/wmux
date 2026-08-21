import { describe, expect, it } from 'vitest';
import { resolveWmuxHookRuntimeContext } from '../../src/cli/wmux-hook-context';

describe('wmux hook runtime context', () => {
  it('silently skips globally installed hooks outside wmux', () => {
    expect(resolveWmuxHookRuntimeContext({})).toEqual({ state: 'inactive', missing: [] });
    expect(resolveWmuxHookRuntimeContext({ WMUX_PIPE: '\\\\.\\pipe\\wmux' }))
      .toEqual({ state: 'inactive', missing: [] });
  });

  it('reports a partial wmux integration instead of silently losing lifecycle events', () => {
    expect(resolveWmuxHookRuntimeContext({ WMUX_INTEGRATION: '1' })).toEqual({
      state: 'invalid',
      missing: ['WMUX_SURFACE_ID', 'WMUX_PIPE', 'WMUX_PIPE_TOKEN'],
    });
  });

  it('accepts a complete wmux-scoped hook capability', () => {
    expect(resolveWmuxHookRuntimeContext({
      WMUX_INTEGRATION: '1',
      WMUX_SURFACE_ID: 'surface-a',
      WMUX_PIPE: '\\\\.\\pipe\\wmux',
      WMUX_PIPE_TOKEN: 'test-token',
    })).toEqual({ state: 'ready', missing: [] });
  });
});
