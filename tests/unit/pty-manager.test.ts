import { describe, it, expect, afterEach, vi } from 'vitest';
import { PtyManager } from '../../src/main/pty-manager';
import { SurfaceId } from '../../src/shared/types';

const TEST_SHELL = 'cmd.exe';
const TEST_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined)
) as Record<string, string>;

describe('PtyManager', () => {
  const managers: PtyManager[] = [];

  function makeManager(): PtyManager {
    const m = new PtyManager();
    managers.push(m);
    return m;
  }

  afterEach(() => {
    for (const m of managers) {
      m.killAll();
    }
    managers.length = 0;
  });

  it('create returns a surf- prefixed SurfaceId', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(id).toMatch(/^surf-/);
  });

  it('has() returns true after create and false after kill', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(manager.has(id)).toBe(true);
    manager.kill(id);
    expect(manager.has(id)).toBe(false);
  });

  it('write does not throw', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(() => manager.write(id, 'echo hello\r')).not.toThrow();
  });

  it('write of a large payload (>1KB) does not throw and is processed via the chunked queue', async () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    // 8 KiB payload — would have flooded ConPTY's input buffer in one shot
    // before the per-PTY chunked write queue was added.
    const big = 'x'.repeat(8 * 1024);
    expect(() => manager.write(id, big)).not.toThrow();
    // Yield long enough for setImmediate-driven chunks to drain.
    await new Promise((r) => setTimeout(r, 50));
  });

  it('resize does not throw', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(() => manager.resize(id, 120, 40)).not.toThrow();
  });

  it('receives data from PTY after writing', async () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
      cols: 80,
      rows: 24,
    });

    const received = await new Promise<string>((resolve) => {
      const unsub = manager.onData(id, (data) => {
        unsub();
        resolve(data);
      });
      // Write something to trigger output; initial prompt should arrive shortly
    });

    expect(typeof received).toBe('string');
    expect(received.length).toBeGreaterThan(0);
  });

  it('kill removes the PTY from the manager', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(manager.has(id)).toBe(true);
    manager.kill(id);
    expect(manager.has(id)).toBe(false);
  });

  it('getPid returns a numeric PID', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    const pid = manager.getPid(id);
    expect(typeof pid).toBe('number');
    expect(pid).toBeGreaterThan(0);
  });

  it('killAll removes all PTYs', () => {
    const manager = makeManager();
    const { id: id1 } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    const { id: id2 } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    manager.killAll();
    expect(manager.has(id1)).toBe(false);
    expect(manager.has(id2)).toBe(false);
  });

  it('detach releases a PTY without calling native kill', () => {
    const manager = makeManager();
    const id = 'surf-test' as SurfaceId;
    const nativeKill = vi.fn();
    const timer = setTimeout(() => {}, 1000);
    const entry = {
      pty: { kill: nativeKill },
      shell: TEST_SHELL,
      dataListeners: new Set([vi.fn()]),
      exitListeners: new Set([vi.fn()]),
      writeChain: Promise.resolve(),
      pendingChunks: 0,
      alive: true,
      outBuffer: [],
      outBufferLen: 0,
      flushTimer: timer,
    };
    const internals = manager as unknown as { ptys: Map<SurfaceId, typeof entry> };
    internals.ptys.set(id, entry);

    manager.detach(id);

    expect(nativeKill).not.toHaveBeenCalled();
    expect(manager.has(id)).toBe(false);
    expect(entry.alive).toBe(false);
    expect(entry.dataListeners.size).toBe(0);
    expect(entry.exitListeners.size).toBe(0);
    expect(entry.flushTimer).toBeNull();
  });

  it('kill releases a PTY and calls native kill once', () => {
    const manager = makeManager();
    const id = 'surf-test' as SurfaceId;
    const nativeKill = vi.fn();
    const entry = {
      pty: { kill: nativeKill },
      shell: TEST_SHELL,
      dataListeners: new Set<() => void>(),
      exitListeners: new Set<() => void>(),
      writeChain: Promise.resolve(),
      pendingChunks: 0,
      alive: true,
      outBuffer: [],
      outBufferLen: 0,
      flushTimer: null,
    };
    const internals = manager as unknown as { ptys: Map<SurfaceId, typeof entry> };
    internals.ptys.set(id, entry);

    manager.kill(id);

    expect(nativeKill).toHaveBeenCalledTimes(1);
    expect(manager.has(id)).toBe(false);
    expect(entry.alive).toBe(false);
  });
});
