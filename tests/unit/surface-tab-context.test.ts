import { describe, expect, it } from 'vitest';
import type { SurfaceRef } from '../../src/shared/types';
import {
  canOpenTerminalPathInExplorer,
  terminalContextPath,
} from '../../src/renderer/components/SplitPane/SurfaceTabBar';

function terminal(overrides: Partial<SurfaceRef> = {}): SurfaceRef {
  return { id: 'surf-context' as any, type: 'terminal', ...overrides };
}

describe('terminal tab context actions', () => {
  it('prefers the live terminal path and falls back to launch or workspace paths', () => {
    expect(terminalContextPath(terminal({
      currentCwd: 'D:\\live', cwd: 'D:\\launch',
    }), 'D:\\workspace')).toBe('D:\\live');
    expect(terminalContextPath(terminal({ cwd: 'D:\\launch' }), 'D:\\workspace')).toBe('D:\\launch');
    expect(terminalContextPath(terminal(), 'D:\\workspace')).toBe('D:\\workspace');
    expect(terminalContextPath({ id: 'surf-browser' as any, type: 'browser' }, 'D:\\workspace')).toBe('');
  });

  it('opens only local Windows terminal paths in Explorer', () => {
    expect(canOpenTerminalPathInExplorer(terminal(), 'D:\\repo')).toBe(true);
    expect(canOpenTerminalPathInExplorer(terminal(), '\\\\server\\share')).toBe(true);
    expect(canOpenTerminalPathInExplorer(terminal({ sshRemote: true }), '/home/user')).toBe(false);
    expect(canOpenTerminalPathInExplorer(terminal(), '/home/user', true)).toBe(false);
    expect(canOpenTerminalPathInExplorer(terminal({ sshProfileId: 'ssh-prod' }), 'D:\\repo')).toBe(false);
  });
});
