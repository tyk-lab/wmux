import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client, SFTPWrapper } from 'ssh2';
import {
  buildAgentAuthMethods,
  buildSshConnectConfig,
  buildSshChildPath,
  buildSshArchiveCommand,
  buildSshRenameTarget,
  findOpenSshIdentityFiles,
  formatSshPermissions,
  hashKnownHostKey,
  parseOpenSshConfig,
  parseSshLongnameOwnerGroup,
  SshAuthenticationError,
  SshManager,
  SshPasswordAuthenticationError,
  SshUntrustedHostKeyError,
} from '../../src/main/ssh-manager';
import { parseSshHostPublicKey } from '../../src/main/ssh-known-hosts';

const temporaryDirectories: string[] = [];

function createSshDirectory(): string {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ssh-'));
  temporaryDirectories.push(homeDirectory);
  const sshDirectory = path.join(homeDirectory, '.ssh');
  fs.mkdirSync(sshDirectory);
  return sshDirectory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('parseOpenSshConfig', () => {
  it('imports selectable Host entries as editable SFTP-ready drafts', () => {
    const drafts = parseOpenSshConfig(`
      Host production
        HostName prod.example.com
        User deploy
        Port 2222
        IdentityFile ~/.ssh/id_ed25519
    `);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      hostAlias: 'production',
      name: 'production',
      host: 'prod.example.com',
      username: 'deploy',
      port: 2222,
      authMethod: 'privateKey',
    });
    expect(drafts[0].privateKeyPath).toMatch(/[\\/]\.ssh[\\/]id_ed25519$/);
  });

  it('ignores wildcard rules because they are not destinations users can connect to', () => {
    const drafts = parseOpenSshConfig(`
      Host *
        ServerAliveInterval 30
      Host staging
        HostName staging.example.com
    `);

    expect(drafts).toEqual([{ hostAlias: 'staging', name: 'staging', host: 'staging.example.com', port: 22, authMethod: 'agent' }]);
  });
});

describe('hashKnownHostKey', () => {
  it('uses the hexadecimal format ssh2 supplies to hostVerifier', () => {
    expect(hashKnownHostKey(Buffer.from('host-key').toString('base64')))
      .toBe('09f10e4bdc37a471382a5aa37101705b258c9b246fbcfa1e8727723214f1a738');
  });
});

describe('OpenSSH identity fallback', () => {
  it('finds a host-specific IdentityFile and conventional default keys', () => {
    const sshDirectory = createSshDirectory();
    const configuredKey = path.join(sshDirectory, 'server-key');
    const defaultKey = path.join(sshDirectory, 'id_ed25519');
    fs.writeFileSync(configuredKey, 'configured-key');
    fs.writeFileSync(defaultKey, 'default-key');
    fs.writeFileSync(path.join(sshDirectory, 'config'), `
      Host production
        HostName server.example.com
        IdentityFile ~/.ssh/server-key
    `);

    expect(findOpenSshIdentityFiles(
      { host: 'server.example.com', username: 'deploy' },
      sshDirectory,
    )).toEqual([configuredKey, defaultKey]);
  });

  it('falls back to discovered private keys after the SSH agent', () => {
    const sshDirectory = createSshDirectory();
    fs.writeFileSync(path.join(sshDirectory, 'id_rsa'), 'private-key');

    const methods = buildAgentAuthMethods(
      { host: 'server.example.com', username: 'deploy' },
      sshDirectory,
    );

    expect(methods.map((method) => method.type)).toEqual(['agent', 'publickey']);
    expect(methods.every((method) => method.username === 'deploy')).toBe(true);
  });
});

describe('password authentication', () => {
  it('classifies password rejection as a retryable SSH authentication error', () => {
    expect(new SshPasswordAuthenticationError('rejected')).toBeInstanceOf(SshAuthenticationError);
  });

  it('passes a supplied password only to ssh2 password authentication', () => {
    const config = buildSshConnectConfig({
      id: 'profile-a',
      name: 'Production',
      host: 'server.example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
    }, 'secret');

    expect(config.password).toBe('secret');
    expect(config.authHandler).toEqual(['password', 'keyboard-interactive']);
    expect(config.tryKeyboard).toBe(true);
    expect(config.agent).toBeUndefined();
    expect(config.privateKey).toBeUndefined();
    expect(config.hostHash).toBeUndefined();
    expect(typeof config.hostVerifier).toBe('function');
  });

  it('asks the UI to confirm an unknown host key instead of silently rejecting it', () => {
    const sshDirectory = createSshDirectory();
    const knownHostsPath = path.join(sshDirectory, 'known_hosts');
    let untrusted: SshUntrustedHostKeyError | undefined;
    const config = buildSshConnectConfig({
      id: 'profile-a',
      name: 'pi',
      host: '10.0.1.182',
      port: 22,
      username: 'pi',
      authMethod: 'password',
    }, 'secret', {
      knownHostsPath,
      onUntrustedHostKey: (error) => { untrusted = error; },
    });
    const name = Buffer.from('ssh-ed25519');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(name.length);
    const key = Buffer.concat([header, name, Buffer.from('new-device')]);

    expect((config.hostVerifier as (value: Buffer) => boolean)(key)).toBe(false);
    expect(untrusted).toBeInstanceOf(SshUntrustedHostKeyError);
    expect(untrusted?.changed).toBe(false);
    expect(untrusted?.toPrompt()).toMatchObject({
      host: '10.0.1.182',
      algorithm: 'ssh-ed25519',
      encodedKey: parseSshHostPublicKey(key).encodedKey,
      fingerprint: expect.stringMatching(/^SHA256:/),
    });
  });
});

describe('SFTP paths', () => {
  it('returns the resolved absolute directory and absolute entry paths', async () => {
    const manager = new SshManager();
    const sftp = {
      realpath: (_remotePath: string, callback: (error: Error | undefined, absolutePath: string) => void) => {
        callback(undefined, '/home/pi/klipper');
      },
      readdir: (_remotePath: string, callback: (error: Error | undefined, entries: unknown[]) => void) => {
        callback(undefined, [{
          filename: 'klippy',
          longname: 'drwxr-xr-x 1 pi pi 0 Aug 4 12:00 klippy',
          attrs: { size: 0, mode: 0o040755, uid: 1000, gid: 1000, mtime: 1_722_772_800 },
        }]);
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client: { end: () => undefined } as unknown as Client, sftp });

    await expect(manager.list('workspace-a', 'klipper')).resolves.toEqual({
      path: '/home/pi/klipper',
      entries: [{
        name: 'klippy',
        path: '/home/pi/klipper/klippy',
        type: 'directory',
        size: 0,
        modifiedAt: 1_722_772_800_000,
        owner: 'pi',
        group: 'pi',
        permissions: 'drwxr-xr-x',
      }],
    });
  });

  it('skips realpath for absolute directories to avoid an extra SSH round trip', async () => {
    const manager = new SshManager();
    let realpathCalls = 0;
    const sftp = {
      realpath: () => { realpathCalls += 1; },
      readdir: (remotePath: string, callback: (error: Error | undefined, entries: unknown[]) => void) => {
        expect(remotePath).toBe('/home/pi/klipper');
        callback(undefined, []);
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client: { end: () => undefined } as unknown as Client, sftp });

    await expect(manager.list('workspace-a', '/home/pi/klipper')).resolves.toEqual({
      path: '/home/pi/klipper',
      entries: [],
    });
    expect(realpathCalls).toBe(0);
  });
});

describe('SFTP file details', () => {
  it('formats Unix permissions and parses owner/group from longname', () => {
    expect(formatSshPermissions(0o100644)).toBe('-rw-r--r--');
    expect(formatSshPermissions(0o040755)).toBe('drwxr-xr-x');
    expect(parseSshLongnameOwnerGroup('-rw-r--r-- 1 pi users 10 Aug 4 12:00 file.txt'))
      .toEqual({ owner: 'pi', group: 'users' });
  });

  it('reads UTF-8 text and saves only when the remote mtime still matches', async () => {
    const manager = new SshManager();
    let mtime = 100;
    const writes: string[] = [];
    const sftp = {
      lstat: (_remotePath: string, callback: (error: Error | undefined, attrs: unknown) => void) => {
        callback(undefined, { mode: 0o100644, size: 12, mtime, uid: 1000, gid: 1000, atime: 99 });
      },
      readFile: (_remotePath: string, callback: (error: Error | undefined, value: Buffer) => void) => {
        callback(undefined, Buffer.from('你好，wmux\n'));
      },
      writeFile: (_remotePath: string, content: string, encoding: string, callback: (error?: Error) => void) => {
        expect(encoding).toBe('utf8');
        writes.push(content);
        mtime += 1;
        callback();
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client: { end: () => undefined } as unknown as Client, sftp });

    await expect(manager.readTextFile('workspace-a', '/home/pi/fluidd.cfg')).resolves.toEqual({
      path: '/home/pi/fluidd.cfg',
      content: '你好，wmux\n',
      mtimeMs: 100_000,
    });
    await expect(manager.writeTextFile('workspace-a', '/home/pi/fluidd.cfg', 'stale', 99_000))
      .resolves.toEqual({ conflict: true, currentMtimeMs: 100_000 });
    await expect(manager.writeTextFile('workspace-a', '/home/pi/fluidd.cfg', 'saved', 100_000))
      .resolves.toEqual({ ok: true, mtimeMs: 101_000 });
    expect(writes).toEqual(['saved']);
  });

  it('rejects binary files instead of corrupting them as UTF-8 text', async () => {
    const manager = new SshManager();
    const sftp = {
      lstat: (_remotePath: string, callback: (error: Error | undefined, attrs: unknown) => void) => {
        callback(undefined, { mode: 0o100644, size: 2, mtime: 100, uid: 1000, gid: 1000, atime: 99 });
      },
      readFile: (_remotePath: string, callback: (error: Error | undefined, value: Buffer) => void) => {
        callback(undefined, Buffer.from([0xff, 0xfe]));
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client: { end: () => undefined } as unknown as Client, sftp });

    await expect(manager.readTextFile('workspace-a', '/home/pi/image.bin')).rejects.toThrow('UTF-8 文本');
  });
});

describe('SFTP mutations', () => {
  it('builds a sibling rename target and rejects path separators', () => {
    expect(buildSshRenameTarget('/home/pi/old.txt', 'new.txt')).toBe('/home/pi/new.txt');
    expect(buildSshChildPath('/home/pi', 'new')).toBe('/home/pi/new');
    expect(() => buildSshRenameTarget('/home/pi/old.txt', '../new.txt')).toThrow('远程文件名无效');
  });

  it('creates empty files and directories without overwriting existing paths', async () => {
    const manager = new SshManager();
    const created: string[] = [];
    const handle = Buffer.from('handle');
    const sftp = {
      lstat: (_remotePath: string, callback: (error?: Error) => void) => {
        callback(Object.assign(new Error('missing'), { code: 2 }));
      },
      mkdir: (remotePath: string, callback: (error?: Error) => void) => {
        created.push(`directory:${remotePath}`);
        callback();
      },
      open: (remotePath: string, flags: string, callback: (error: Error | undefined, value: Buffer) => void) => {
        created.push(`file:${remotePath}:${flags}`);
        callback(undefined, handle);
      },
      close: (value: Buffer, callback: (error?: Error) => void) => {
        expect(value).toBe(handle);
        callback();
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client: { end: () => undefined } as unknown as Client, sftp });

    await manager.createEntry('workspace-a', '/home/pi', 'notes.txt', 'file');
    await manager.createEntry('workspace-a', '/home/pi', 'configs', 'directory');

    expect(created).toEqual(['file:/home/pi/notes.txt:wx', 'directory:/home/pi/configs']);
  });

  it('renames only when the target does not already exist', async () => {
    const manager = new SshManager();
    const renamed: string[] = [];
    let targetExists = false;
    const sftp = {
      lstat: (_remotePath: string, callback: (error?: Error) => void) => {
        callback(targetExists ? undefined : Object.assign(new Error('missing'), { code: 2 }));
      },
      rename: (oldPath: string, newPath: string, callback: (error?: Error) => void) => {
        renamed.push(`${oldPath}->${newPath}`);
        callback();
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client: { end: () => undefined } as unknown as Client, sftp });

    await expect(manager.rename('workspace-a', '/home/pi/old.txt', 'new.txt'))
      .resolves.toBe('/home/pi/new.txt');
    targetExists = true;
    await expect(manager.rename('workspace-a', '/home/pi/old.txt', 'taken.txt'))
      .rejects.toThrow('“taken.txt”已存在');
    expect(renamed).toEqual(['/home/pi/old.txt->/home/pi/new.txt']);
  });

  it('uses unlink for files and rmdir for empty directories', async () => {
    const manager = new SshManager();
    const removed: string[] = [];
    let mode = 0o100000;
    const sftp = {
      lstat: (_remotePath: string, callback: (error: Error | undefined, attrs: { mode: number }) => void) => {
        callback(undefined, { mode });
      },
      unlink: (remotePath: string, callback: (error?: Error) => void) => {
        removed.push(`file:${remotePath}`);
        callback();
      },
      rmdir: (remotePath: string, callback: (error?: Error) => void) => {
        removed.push(`directory:${remotePath}`);
        callback();
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client: { end: () => undefined } as unknown as Client, sftp });

    await manager.deleteEntry('workspace-a', '/home/pi/file.txt');
    mode = 0o040000;
    await manager.deleteEntry('workspace-a', '/home/pi/empty');

    expect(removed).toEqual(['file:/home/pi/file.txt', 'directory:/home/pi/empty']);
  });

  it('uploads local directories recursively and merges existing remote directories', async () => {
    const manager = new SshManager();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-upload-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(source, 'root.txt'), 'root');
    fs.writeFileSync(path.join(source, 'nested', 'child.txt'), 'child');
    const directories = new Set(['/remote/source']);
    const uploaded: string[] = [];
    const sftp = {
      lstat: (remotePath: string, callback: (error: Error | undefined, attrs?: { mode: number }) => void) => {
        if (directories.has(remotePath)) callback(undefined, { mode: 0o040755 });
        else callback(Object.assign(new Error('missing'), { code: 2 }));
      },
      mkdir: (remotePath: string, callback: (error?: Error) => void) => {
        directories.add(remotePath);
        callback();
      },
      fastPut: (localPath: string, remotePath: string, callback: (error?: Error) => void) => {
        uploaded.push(`${path.relative(source, localPath).replaceAll('\\', '/')}->${remotePath}`);
        callback();
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client: { end: () => undefined } as unknown as Client, sftp });

    await manager.uploadEntry('workspace-a', source, '/remote/source', 'directory');

    expect(directories).toContain('/remote/source/nested');
    expect(uploaded.sort()).toEqual([
      'nested/child.txt->/remote/source/nested/child.txt',
      'root.txt->/remote/source/root.txt',
    ]);
  });

  it('downloads remote directories recursively and sanitizes Windows file names', async () => {
    const manager = new SshManager();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-download-'));
    temporaryDirectories.push(root);
    const target = path.join(root, 'downloaded');
    const tree = new Map<string, Array<{ filename: string; attrs: { mode: number } }>>([
      ['/remote/source', [
        { filename: 'nested', attrs: { mode: 0o040755 } },
        { filename: 'bad:name?.txt', attrs: { mode: 0o100644 } },
      ]],
      ['/remote/source/nested', [{ filename: 'child.txt', attrs: { mode: 0o100644 } }]],
    ]);
    const sftp = {
      readdir: (remotePath: string, callback: (error: Error | undefined, entries: unknown[]) => void) => {
        callback(undefined, tree.get(remotePath) || []);
      },
      fastGet: (remotePath: string, localPath: string, callback: (error?: Error) => void) => {
        fs.writeFileSync(localPath, remotePath);
        callback();
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client: { end: () => undefined } as unknown as Client, sftp });

    await manager.downloadEntry('workspace-a', '/remote/source', target, 'directory');

    expect(fs.readFileSync(path.join(target, 'bad_name_.txt'), 'utf8')).toBe('/remote/source/bad:name?.txt');
    expect(fs.readFileSync(path.join(target, 'nested', 'child.txt'), 'utf8')).toBe('/remote/source/nested/child.txt');
  });

  it('keeps an existing local file intact when a download fails', async () => {
    const manager = new SshManager();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-download-'));
    temporaryDirectories.push(root);
    const target = path.join(root, 'existing.txt');
    fs.writeFileSync(target, 'original');
    const sftp = {
      fastGet: (_remotePath: string, localPath: string, callback: (error?: Error) => void) => {
        fs.writeFileSync(localPath, 'partial');
        callback(new Error('connection lost'));
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client: { end: () => undefined } as unknown as Client, sftp });

    await expect(manager.download('workspace-a', '/remote/file.txt', target)).rejects.toThrow('connection lost');

    expect(fs.readFileSync(target, 'utf8')).toBe('original');
    expect(fs.readdirSync(root)).toEqual(['existing.txt']);
  });

  it('builds a shell-safe tar command for selected siblings', () => {
    expect(buildSshArchiveCommand(
      ['/home/pi/project dir', "/home/pi/it's.txt"],
      '/tmp/wmux-test.tar.gz',
    )).toBe("tar -czf '/tmp/wmux-test.tar.gz' -C '/home/pi' './project dir' './it'\"'\"'s.txt'");
    expect(buildSshArchiveCommand(['/tmp'], '/tmp/wmux-test.tar.gz'))
      .toContain("'--exclude=./tmp/wmux-test.tar.gz' -C '/' './tmp'");
    expect(() => buildSshArchiveCommand(['/home/pi/a', '/var/log/b'], '/tmp/a.tar.gz'))
      .toThrow('同一远程目录');
  });

  it('downloads a remote archive and deletes it after success', async () => {
    const manager = new SshManager();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-archive-'));
    temporaryDirectories.push(root);
    const target = path.join(root, 'bundle.tar.gz');
    const commands: string[] = [];
    const removed: string[] = [];
    const client = {
      exec: (command: string, callback: (error: Error | undefined, stream: unknown) => void) => {
        commands.push(command);
        const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        stream.stderr = new EventEmitter();
        callback(undefined, stream);
        queueMicrotask(() => stream.emit('close', 0));
      },
      end: () => undefined,
    } as unknown as Client;
    const sftp = {
      fastGet: (remotePath: string, localPath: string, callback: (error?: Error) => void) => {
        fs.writeFileSync(localPath, remotePath);
        callback();
      },
      unlink: (remotePath: string, callback: (error?: Error) => void) => {
        removed.push(remotePath);
        callback();
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client, sftp });

    await manager.downloadArchive('workspace-a', ['/home/pi/folder', '/home/pi/file.txt'], target);

    expect(commands[0]).toMatch(/^tar -czf '\/tmp\/wmux-download-[a-f0-9-]+\.tar\.gz' -C '\/home\/pi'/);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/^\/tmp\/wmux-download-[a-f0-9-]+\.tar\.gz$/);
    expect(fs.readFileSync(target, 'utf8')).toBe(removed[0]);
  });

  it('deletes the remote temporary archive when downloading fails', async () => {
    const manager = new SshManager();
    const removed: string[] = [];
    const client = {
      exec: (_command: string, callback: (error: Error | undefined, stream: unknown) => void) => {
        const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        stream.stderr = new EventEmitter();
        callback(undefined, stream);
        queueMicrotask(() => stream.emit('close', 0));
      },
      end: () => undefined,
    } as unknown as Client;
    const sftp = {
      fastGet: (_remotePath: string, _localPath: string, callback: (error?: Error) => void) => {
        callback(new Error('connection lost'));
      },
      unlink: (remotePath: string, callback: (error?: Error) => void) => {
        removed.push(remotePath);
        callback();
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client, sftp });

    await expect(manager.downloadArchive('workspace-a', ['/home/pi/folder'], path.join(os.tmpdir(), 'unused.tar.gz')))
      .rejects.toThrow('connection lost');
    expect(removed).toHaveLength(1);
  });
});
