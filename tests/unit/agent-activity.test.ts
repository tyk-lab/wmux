import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: sendMock } }],
  },
}));

import { applyExternalActivity, getActivity, clearActivity } from '../../src/main/agent-activity';
import { SurfaceId } from '../../src/shared/types';

describe('applyExternalActivity', () => {
  const surf = 'surf-test-1' as SurfaceId;
  beforeEach(() => { sendMock.mockClear(); clearActivity(surf); });

  it('merges partial activity and broadcasts an agent activity update', () => {
    applyExternalActivity(surf, { lastTool: 'bash', isDone: false });
    const a = getActivity(surf);
    expect(a?.lastTool).toBe('bash');
    expect(a?.isDone).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('preserves prior fields when later partial omits them', () => {
    applyExternalActivity(surf, { lastTool: 'read', isDone: false });
    applyExternalActivity(surf, { isDone: true });
    const a = getActivity(surf);
    expect(a?.lastTool).toBe('read');
    expect(a?.isDone).toBe(true);
  });
});
