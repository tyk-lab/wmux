import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, SFTPWrapper } from 'ssh2';
import {
  buildAgentAuthMethods,
  buildSshConnectConfig,
  findOpenSshIdentityFiles,
  hashKnownHostKey,
  parseOpenSshConfig,
  SshAuthenticationError,
  SshManager,
  SshPasswordAuthenticationError,
} from '../../src/main/ssh-manager';

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
        callback(undefined, [{ filename: 'klippy', longname: '', attrs: { size: 0, mode: 0o040000 } }]);
      },
    } as unknown as SFTPWrapper;
    const sessions = (manager as unknown as {
      sessions: Map<string, { client: Client; sftp: SFTPWrapper }>;
    }).sessions;
    sessions.set('workspace-a', { client: { end: () => undefined } as unknown as Client, sftp });

    await expect(manager.list('workspace-a', 'klipper')).resolves.toEqual({
      path: '/home/pi/klipper',
      entries: [{ name: 'klippy', path: '/home/pi/klipper/klippy', type: 'directory', size: 0 }],
    });
  });
});
