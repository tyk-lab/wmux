import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ windows: [] as any[] }));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => electronState.windows },
}));

import { handleBridgeV2 } from '../../src/main/v2-bridge';

describe('V2 renderer bridge caller routing', () => {
  beforeEach(() => {
    electronState.windows = [];
  });

  it('routes caller-bound context to the window that owns the surface', async () => {
    const firstExecute = vi.fn().mockResolvedValue(false);
    const secondExecute = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ ok: true, role: 'project-ai' });
    electronState.windows = [
      { isDestroyed: () => false, webContents: { executeJavaScript: firstExecute } },
      { isDestroyed: () => false, webContents: { executeJavaScript: secondExecute } },
    ];

    const result = await new Promise<any>((resolve, reject) => {
      expect(handleBridgeV2(
        'role.context',
        { callerSurfaceId: 'manager-b' },
        resolve,
        (_code, message) => reject(new Error(message)),
      )).toBe(true);
    });

    expect(result).toMatchObject({ ok: true, role: 'project-ai' });
    expect(firstExecute).toHaveBeenCalledWith(expect.stringContaining('__wmux_hasSurface'));
    expect(secondExecute).toHaveBeenLastCalledWith(expect.stringContaining('__wmux_roleContext'));
  });
});
