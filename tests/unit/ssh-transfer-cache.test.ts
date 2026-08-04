import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  nextAvailableLocalPath,
  SshTransferCache,
  validateLocalUploadFiles,
  validateRemoteTransferFiles,
} from '../../src/main/ssh-transfer-cache';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-transfer-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SSH transfer validation', () => {
  it('accepts existing files and rejects directories or missing paths', () => {
    const root = temporaryDirectory();
    const file = path.join(root, 'file.txt');
    const directory = path.join(root, 'folder');
    fs.writeFileSync(file, 'content');
    fs.mkdirSync(directory);

    expect(validateLocalUploadFiles([file, directory, path.join(root, 'missing')])).toEqual({
      files: [file],
      rejected: ['folder', 'missing'],
    });
  });

  it('sanitizes remote names and rejects malformed records', () => {
    expect(validateRemoteTransferFiles([{ path: '/tmp/a', name: 'bad:name?.txt' }])).toEqual([
      { path: '/tmp/a', name: 'bad_name_.txt' },
    ]);
    expect(validateRemoteTransferFiles([{ path: '/tmp/con', name: 'CON.txt' }])[0].name).toBe('_CON.txt');
    expect(() => validateRemoteTransferFiles([{ path: '', name: 'a.txt' }])).toThrow('远程文件信息无效');
  });

  it('chooses a non-conflicting local download path', () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, 'report.txt'), 'old');
    fs.writeFileSync(path.join(root, 'report (1).txt'), 'old');

    expect(nextAvailableLocalPath(root, 'report.txt')).toBe(path.join(root, 'report (2).txt'));
  });
});

describe('SshTransferCache', () => {
  it('prepares duplicate remote names for a native drag and cleans the cache', async () => {
    const root = temporaryDirectory();
    const cacheRoot = path.join(root, 'cache');
    const cache = new SshTransferCache(cacheRoot);
    const prepared = await cache.prepare([
      { path: '/one/report.txt', name: 'report.txt' },
      { path: '/two/report.txt', name: 'report.txt' },
      { path: '/three/report-2.txt', name: 'report-2.txt' },
    ], async (remotePath, localPath) => {
      fs.writeFileSync(localPath, remotePath);
    });

    expect(cache.get(prepared.token)?.map((file) => path.basename(file))).toEqual([
      'report.txt',
      'report-2.txt',
      'report-2-2.txt',
    ]);
    expect(cache.get('not-a-token')).toBeUndefined();
    expect(fs.readFileSync(prepared.files[1], 'utf8')).toBe('/two/report.txt');

    cache.cleanup();
    expect(fs.existsSync(cacheRoot)).toBe(false);
    expect(cache.get(prepared.token)).toBeUndefined();
  });

  it('removes partial output when preparing a drag fails', async () => {
    const root = temporaryDirectory();
    const cacheRoot = path.join(root, 'cache');
    const cache = new SshTransferCache(cacheRoot);

    await expect(cache.prepare([{ path: '/bad', name: 'bad.txt' }], async () => {
      throw new Error('download failed');
    })).rejects.toThrow('download failed');
    expect(fs.readdirSync(cacheRoot)).toEqual([]);
  });

  it('replaces the previous prepared drag for the same renderer', async () => {
    const root = temporaryDirectory();
    const cache = new SshTransferCache(path.join(root, 'cache'));
    const download = async (remotePath: string, localPath: string) => {
      fs.writeFileSync(localPath, remotePath);
    };
    const first = await cache.prepare([{ path: '/one', name: 'one.txt' }], download, 'renderer-1');
    const second = await cache.prepare([{ path: '/two', name: 'two.txt' }], download, 'renderer-1');

    expect(cache.get(first.token)).toBeUndefined();
    expect(cache.get(second.token)).toHaveLength(1);
    expect(fs.existsSync(path.dirname(first.files[0]))).toBe(false);
  });
});
