import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupStaleSshEditDirectories,
  SshEditTransactionManager,
} from '../../src/main/ssh-edit-transactions';

function backend(initial: Record<string, { content: string; mtimeMs: number }> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    pathExists: vi.fn(async (_workspaceId: string, remotePath: string) => files.has(remotePath)),
    readTextFile: vi.fn(async (_workspaceId: string, remotePath: string) => {
      const file = files.get(remotePath);
      if (!file) throw new Error('missing');
      return { path: remotePath, ...file };
    }),
    writeTextFileAtomically: vi.fn(async (
      _workspaceId: string,
      remotePath: string,
      content: string,
      expected: { mtimeMs?: number; mustBeMissing?: boolean },
    ) => {
      const current = files.get(remotePath);
      if (expected.mustBeMissing && current) {
        return { conflict: true as const, currentMtimeMs: current.mtimeMs, reason: 'created' as const };
      }
      if (!expected.mustBeMissing && (!current || current.mtimeMs !== expected.mtimeMs)) {
        return { conflict: true as const, currentMtimeMs: current?.mtimeMs, reason: 'changed' as const };
      }
      const next = { content, mtimeMs: (current?.mtimeMs || 1000) + 1000 };
      files.set(remotePath, next);
      return { ok: true as const, mtimeMs: next.mtimeMs };
    }),
  };
}

describe('SSH edit transactions', () => {
  const managers: SshEditTransactionManager[] = [];

  afterEach(() => {
    for (const manager of managers) manager.cleanupAll();
    managers.length = 0;
  });

  it('checks out, commits, verifies, and removes the managed staging file', async () => {
    const remote = backend({ '/srv/app/readme.md': { content: 'old\n', mtimeMs: 1000 } });
    const manager = new SshEditTransactionManager(remote);
    managers.push(manager);
    const checkout = await manager.checkout({
      callerSurfaceId: 'companion-a',
      targetSurfaceId: 'ssh-a',
      workspaceId: 'workspace-a',
      remotePath: '/srv/app/readme.md',
    });
    const stagingPath = String(checkout.stagingPath);
    fs.writeFileSync(stagingPath, 'new long text\n', 'utf8');

    await expect(manager.commit('companion-a', String(checkout.token))).resolves.toMatchObject({
      ok: true,
      remotePath: '/srv/app/readme.md',
      bytes: 14,
    });
    expect(remote.files.get('/srv/app/readme.md')?.content).toBe('new long text\n');
    expect(remote.writeTextFileAtomically).toHaveBeenCalledWith(
      'workspace-a',
      '/srv/app/readme.md',
      'new long text\n',
      { mtimeMs: 1000 },
    );
    expect(fs.existsSync(stagingPath)).toBe(false);
  });

  it('keeps a conflicting staging file until the owner aborts', async () => {
    const remote = backend({ '/srv/app/config.ts': { content: 'one', mtimeMs: 1000 } });
    const manager = new SshEditTransactionManager(remote);
    managers.push(manager);
    const checkout = await manager.checkout({
      callerSurfaceId: 'companion-a',
      targetSurfaceId: 'ssh-a',
      workspaceId: 'workspace-a',
      remotePath: '/srv/app/config.ts',
    });
    const stagingPath = String(checkout.stagingPath);
    remote.files.set('/srv/app/config.ts', { content: 'concurrent', mtimeMs: 2000 });

    await expect(manager.commit('companion-a', String(checkout.token))).resolves.toMatchObject({
      ok: false,
      conflict: true,
      currentMtimeMs: 2000,
      stagingPath,
    });
    expect(fs.existsSync(stagingPath)).toBe(true);
    expect(() => manager.abort('companion-b', String(checkout.token))).toThrow('无权');
    expect(manager.abort('companion-a', String(checkout.token))).toEqual({ ok: true });
    expect(fs.existsSync(stagingPath)).toBe(false);
  });

  it('detects same-second remote changes by content hash', async () => {
    const remote = backend({ '/srv/app/config.ts': { content: 'one', mtimeMs: 1000 } });
    const manager = new SshEditTransactionManager(remote);
    managers.push(manager);
    const checkout = await manager.checkout({
      callerSurfaceId: 'companion-a', targetSurfaceId: 'ssh-a', workspaceId: 'workspace-a', remotePath: '/srv/app/config.ts',
    });
    remote.files.set('/srv/app/config.ts', { content: 'changed in same second', mtimeMs: 1000 });

    await expect(manager.commit('companion-a', String(checkout.token))).resolves.toMatchObject({
      ok: false,
      conflict: true,
      reason: 'changed',
      currentMtimeMs: 1000,
    });
    expect(remote.writeTextFileAtomically).not.toHaveBeenCalled();
  });

  it('uses a Windows-safe bounded staging name for remote reserved names', async () => {
    const remote = backend({ '/srv/app/CON': { content: 'safe', mtimeMs: 1000 } });
    const manager = new SshEditTransactionManager(remote);
    managers.push(manager);
    const checkout = await manager.checkout({
      callerSurfaceId: 'companion-a', targetSurfaceId: 'ssh-a', workspaceId: 'workspace-a', remotePath: '/srv/app/CON',
    });
    expect(path.basename(String(checkout.stagingPath))).toBe('remote-CON.wmux-staging');
    expect(fs.existsSync(String(checkout.stagingPath))).toBe(true);
  });

  it('supports an explicitly requested new remote file without overwriting a race', async () => {
    const remote = backend();
    const manager = new SshEditTransactionManager(remote);
    managers.push(manager);
    const checkout = await manager.checkout({
      callerSurfaceId: 'companion-a',
      targetSurfaceId: 'ssh-a',
      workspaceId: 'workspace-a',
      remotePath: '/srv/app/new-file.md',
      create: true,
    });
    fs.writeFileSync(String(checkout.stagingPath), '# 新文件\n', 'utf8');

    await expect(manager.commit('companion-a', String(checkout.token))).resolves.toMatchObject({ ok: true });
    expect(remote.writeTextFileAtomically).toHaveBeenCalledWith(
      'workspace-a',
      '/srv/app/new-file.md',
      '# 新文件\n',
      { mustBeMissing: true },
    );
  });

  it('rejects abort and duplicate commit while a remote commit is in flight', async () => {
    const remote = backend({ '/srv/app/locked.txt': { content: 'old', mtimeMs: 1000 } });
    let release!: () => void;
    remote.writeTextFileAtomically.mockImplementation(async (_workspaceId, remotePath, content) => {
      await new Promise<void>((resolve) => { release = resolve; });
      remote.files.set(remotePath, { content, mtimeMs: 2000 });
      return { ok: true, mtimeMs: 2000 };
    });
    const manager = new SshEditTransactionManager(remote);
    managers.push(manager);
    const checkout = await manager.checkout({
      callerSurfaceId: 'companion-a', targetSurfaceId: 'ssh-a', workspaceId: 'workspace-a', remotePath: '/srv/app/locked.txt',
    });
    fs.writeFileSync(String(checkout.stagingPath), 'new', 'utf8');

    const committing = manager.commit('companion-a', String(checkout.token));
    expect(() => manager.abort('companion-a', String(checkout.token))).toThrow('正在提交');
    await expect(manager.commit('companion-a', String(checkout.token))).rejects.toThrow('正在提交');
    release();
    await expect(committing).resolves.toMatchObject({ ok: true });
  });

  it('requires --create for a missing remote path and rejects relative paths', async () => {
    const manager = new SshEditTransactionManager(backend());
    managers.push(manager);
    await expect(manager.checkout({
      callerSurfaceId: 'companion-a', targetSurfaceId: 'ssh-a', workspaceId: 'workspace-a', remotePath: '/missing',
    })).rejects.toThrow('--create');
    await expect(manager.checkout({
      callerSurfaceId: 'companion-a', targetSurfaceId: 'ssh-a', workspaceId: 'workspace-a', remotePath: 'relative.txt', create: true,
    })).rejects.toThrow('绝对文件路径');
  });

  it('removes only stale wmux-owned edit directories during startup cleanup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ssh-edit-test-root-'));
    const stale = path.join(root, 'wmux-ssh-edit-stale');
    const fresh = path.join(root, 'wmux-ssh-edit-fresh');
    const unrelated = path.join(root, 'other-stale');
    fs.mkdirSync(stale);
    fs.mkdirSync(fresh);
    fs.mkdirSync(unrelated);
    const now = Date.now();
    fs.utimesSync(stale, new Date(now - 10_000), new Date(now - 10_000));
    fs.utimesSync(unrelated, new Date(now - 10_000), new Date(now - 10_000));
    try {
      cleanupStaleSshEditDirectories(root, now, 5_000);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(fs.existsSync(unrelated)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
