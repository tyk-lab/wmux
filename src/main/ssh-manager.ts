import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { SshConfigDraft, SshConnectionProfile, SshFileEntry } from '../shared/types';

type SshSession = { client: Client; sftp: SFTPWrapper };

function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function parsePort(value: string | undefined): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/** Returns SHA-256 host fingerprints already trusted by the user's OpenSSH client. */
export function hashKnownHostKey(encodedKey: string): string {
  return createHash('sha256').update(Buffer.from(encodedKey, 'base64')).digest('hex');
}

export function readKnownHostFingerprints(host: string, port: number): Set<string> {
  const knownHostsPath = path.join(os.homedir(), '.ssh', 'known_hosts');
  const expectedHosts = new Set(port === 22 ? [host] : [`[${host}]:${port}`]);
  const fingerprints = new Set<string>();
  try {
    for (const line of fs.readFileSync(knownHostsPath, 'utf8').split(/\r?\n/)) {
      const [hosts, _algorithm, encodedKey] = line.trim().split(/\s+/);
      if (!hosts || !encodedKey || hosts.startsWith('|')) continue;
      if (!hosts.split(',').some((entry) => expectedHosts.has(entry))) continue;
      // ssh2 passes hostHash values to hostVerifier as lowercase hexadecimal.
      fingerprints.add(hashKnownHostKey(encodedKey));
    }
  } catch {
    // Missing known_hosts is normal on a fresh machine; the verifier will reject it.
  }
  return fingerprints;
}

/** Reads the simple per-host fields needed to turn OpenSSH entries into editable wmux presets. */
export function parseOpenSshConfig(content: string): SshConfigDraft[] {
  const drafts: SshConfigDraft[] = [];
  let current: SshConfigDraft | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');

    if (key === 'host') {
      // Wildcards describe rules, not selectable destinations.
      if (/[*!?]/.test(value) || value.includes(' ')) {
        current = null;
      } else {
        current = { hostAlias: value, name: value, host: value, port: 22, authMethod: 'agent' };
        drafts.push(current);
      }
      continue;
    }
    if (!current) continue;
    if (key === 'hostname') current.host = value;
    if (key === 'user') current.username = value;
    if (key === 'port') current.port = parsePort(value) ?? 22;
    if (key === 'identityfile') {
      current.privateKeyPath = expandHome(value);
      current.authMethod = 'privateKey';
    }
  }

  return drafts;
}

function validateProfile(profile: SshConnectionProfile): SshConnectionProfile {
  const host = profile.host.trim();
  const username = profile.username.trim();
  const port = Number(profile.port);
  if (!host || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SSH 连接信息无效');
  }
  if (profile.authMethod === 'privateKey' && !profile.privateKeyPath?.trim()) {
    throw new Error('请选择私钥文件');
  }
  return { ...profile, host, username, port, privateKeyPath: profile.privateKeyPath?.trim() };
}

function connectConfig(profile: SshConnectionProfile): ConnectConfig {
  const config: ConnectConfig = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    readyTimeout: 15_000,
  };
  if (profile.authMethod === 'privateKey') {
    const keyPath = expandHome(profile.privateKeyPath!);
    config.privateKey = fs.readFileSync(keyPath);
  } else {
    // Windows OpenSSH uses this named pipe when SSH_AUTH_SOCK is absent.
    config.agent = process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent';
  }
  const trustedFingerprints = readKnownHostFingerprints(profile.host, profile.port);
  config.hostHash = 'sha256';
  config.hostVerifier = (fingerprint: string) => trustedFingerprints.has(fingerprint);
  return config;
}

function toFileEntry(entry: { filename: string; longname: string; attrs: { size: number; mtime?: number; mode?: number } }, parent: string): SshFileEntry {
  const mode = entry.attrs.mode ?? 0;
  const kind = (mode & 0o170000) === 0o040000 ? 'directory'
    : (mode & 0o170000) === 0o120000 ? 'link'
      : (mode & 0o170000) === 0o100000 ? 'file' : 'other';
  return {
    name: entry.filename,
    path: path.posix.join(parent, entry.filename),
    type: kind,
    size: entry.attrs.size ?? 0,
    modifiedAt: entry.attrs.mtime ? entry.attrs.mtime * 1000 : undefined,
  };
}

export class SshManager {
  private sessions = new Map<string, SshSession>();

  async connect(workspaceId: string, rawProfile: SshConnectionProfile): Promise<void> {
    this.disconnect(workspaceId);
    const profile = validateProfile(rawProfile);
    const client = new Client();
    client.on('error', () => this.disconnect(workspaceId));
    let sftp: SFTPWrapper;
    try {
      sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      const fail = (error: Error) => reject(new Error(error.message || 'SSH 连接失败'));
      client.once('error', fail);
      client.once('ready', () => {
        client.sftp((error, wrapper) => {
          if (error || !wrapper) {
            fail(error ?? new Error('无法建立 SFTP 会话'));
            return;
          }
          client.removeListener('error', fail);
          resolve(wrapper);
        });
      });
      try {
        client.connect(connectConfig(profile));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
      });
    } catch (error) {
      try { client.end(); } catch { /* connection already closed */ }
      throw error;
    }
    this.sessions.set(workspaceId, { client, sftp });
  }

  disconnect(workspaceId: string): void {
    const session = this.sessions.get(workspaceId);
    this.sessions.delete(workspaceId);
    if (session) {
      try { session.client.end(); } catch { /* already closed */ }
    }
  }

  disconnectAll(): void {
    [...this.sessions.keys()].forEach((workspaceId) => this.disconnect(workspaceId));
  }

  async list(workspaceId: string, remotePath: string): Promise<SshFileEntry[]> {
    const sftp = this.getSftp(workspaceId);
    const directory = remotePath || '.';
    return new Promise((resolve, reject) => {
      sftp.readdir(directory, (error, entries) => {
        if (error) return reject(new Error(error.message || '无法读取远程目录'));
        resolve(entries
          .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
          .map((entry) => toFileEntry(entry, directory))
          .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name)));
      });
    });
  }

  async upload(workspaceId: string, localPath: string, remotePath: string): Promise<void> {
    const sftp = this.getSftp(workspaceId);
    await new Promise<void>((resolve, reject) => sftp.fastPut(localPath, remotePath, (error) =>
      error ? reject(new Error(error.message || '上传失败')) : resolve()));
  }

  async download(workspaceId: string, remotePath: string, localPath: string): Promise<void> {
    const sftp = this.getSftp(workspaceId);
    await new Promise<void>((resolve, reject) => sftp.fastGet(remotePath, localPath, (error) =>
      error ? reject(new Error(error.message || '下载失败')) : resolve()));
  }

  private getSftp(workspaceId: string): SFTPWrapper {
    const session = this.sessions.get(workspaceId);
    if (!session) throw new Error('SSH 文件连接未建立，请重新连接');
    return session.sftp;
  }
}
