import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import { CDPProxy } from '../../src/main/cdp-proxy';

vi.mock('electron', () => ({
  webContents: {
    fromId: vi.fn(),
  },
}));

describe('CDPProxy', () => {
  let proxy: CDPProxy | null = null;
  let blocker: http.Server | null = null;

  afterEach(() => {
    proxy?.stop();
    blocker?.close();
    proxy = null;
    blocker = null;
  });

  it('falls back when the default debugging port is already in use', async () => {
    blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker!.once('error', (error: NodeJS.ErrnoException) => {
        blocker?.close();
        blocker = null;

        if (error.code === 'EADDRINUSE') {
          resolve();
          return;
        }

        reject(error);
      });
      blocker!.listen(9222, '127.0.0.1', () => resolve());
    });

    proxy = new CDPProxy();
    await proxy.start();

    expect(proxy.getPort()).toBeGreaterThan(9222);
    expect(proxy.getPort()).toBeLessThanOrEqual(9230);
  });
});
