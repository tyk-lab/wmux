import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { authorizeSurfaceCapabilityRequest } from '../../src/main/surface-capability-guard';

describe('surface capability main-process guard', () => {
  it('finds the window that owns the caller and returns its managed-role decision', async () => {
    const first = vi.fn().mockResolvedValue({ knownSurface: false });
    const second = vi.fn().mockResolvedValue({
      knownSurface: true, managed: true, allowed: false, reason: 'cross-surface denied',
    });
    const result = await authorizeSurfaceCapabilityRequest('task-a', 'surface.close', {}, [
      { isDestroyed: () => false, webContents: { executeJavaScript: first } },
      { isDestroyed: () => false, webContents: { executeJavaScript: second } },
    ]);

    expect(result).toEqual({ allowed: false, reason: 'cross-surface denied' });
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(expect.stringContaining('surface.close'));
  });

  it('allows an explicitly identified unmanaged terminal and fails closed for an unknown surface', async () => {
    const unmanaged = [{
      isDestroyed: () => false,
      webContents: { executeJavaScript: vi.fn().mockResolvedValue({ knownSurface: true, managed: false }) },
    }];
    await expect(authorizeSurfaceCapabilityRequest('shell-a', 'workspace.list', {}, unmanaged))
      .resolves.toEqual({ allowed: true });

    const unknown = [{
      isDestroyed: () => false,
      webContents: { executeJavaScript: vi.fn().mockResolvedValue({ knownSurface: false }) },
    }];
    await expect(authorizeSurfaceCapabilityRequest('missing', 'workspace.list', {}, unknown))
      .resolves.toMatchObject({ allowed: false });
  });
});
