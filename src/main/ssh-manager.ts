import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  Client,
  type AnyAuthMethod,
  type ConnectConfig,
  type KeyboardInteractiveCallback,
  type Prompt,
  type SFTPWrapper,
} from 'ssh2';
import { SshConfigDraft, SshConnectionProfile, SshFileEntry, SshFileListResult } from '../shared/types';

type SshSession = { client: Client; sftp: SFTPWrapper };

function expandHome(filePath: string, homeDirectory = os.homedir()): string {
  if (filePath === '~') return homeDirectory;
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) return path.join(homeDirectory, filePath.slice(2));
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

const DEFAULT_IDENTITY_FILES = [
  'id_ed25519',
  'id_ecdsa',
  'id_ecdsa_sk',
  'id_ed25519_sk',
  'id_rsa',
  'id_dsa',
];

function hostPatternMatches(pattern: string, host: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i').test(host);
}

function hostBlockMatches(patterns: string[], aliases: Set<string>): boolean {
  let matched = false;
  for (const rawPattern of patterns) {
    const negated = rawPattern.startsWith('!');
    const pattern = negated ? rawPattern.slice(1) : rawPattern;
    const patternMatches = [...aliases].some((alias) => hostPatternMatches(pattern, alias));
    if (negated && patternMatches) return false;
    if (!negated && patternMatches) matched = true;
  }
  return matched;
}

function resolveIdentityPath(
  rawPath: string,
  profile: Pick<SshConnectionProfile, 'host' | 'username'>,
  sshDirectory: string,
): string {
  const homeDirectory = path.dirname(sshDirectory);
  const expanded = rawPath
    .replace(/^['"]|['"]$/g, '')
    .replace(/%d/g, homeDirectory)
    .replace(/%h/g, profile.host)
    .replace(/%r/g, profile.username);
  const homeExpanded = expandHome(expanded, homeDirectory);
  return path.isAbsolute(homeExpanded) ? homeExpanded : path.resolve(sshDirectory, homeExpanded);
}

/** Finds OpenSSH-configured and conventional private keys usable without an agent. */
export function findOpenSshIdentityFiles(
  profile: Pick<SshConnectionProfile, 'host' | 'username'>,
  sshDirectory = path.join(os.homedir(), '.ssh'),
): string[] {
  const configPath = path.join(sshDirectory, 'config');
  let configContent = '';
  try {
    configContent = fs.readFileSync(configPath, 'utf8');
  } catch {
    // A config file is optional; conventional identity names still apply.
  }

  const aliases = new Set([profile.host]);
  for (const draft of parseOpenSshConfig(configContent)) {
    if (draft.host === profile.host) aliases.add(draft.hostAlias);
  }

  const candidates: string[] = [];
  let activeHostBlock = false;
  for (const rawLine of configContent.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'host') {
      activeHostBlock = hostBlockMatches(value.split(/\s+/), aliases);
    } else if (key === 'identityfile' && activeHostBlock) {
      candidates.push(resolveIdentityPath(value, profile, sshDirectory));
    }
  }

  candidates.push(...DEFAULT_IDENTITY_FILES.map((name) => path.join(sshDirectory, name)));
  return [...new Set(candidates)].filter((candidate) => {
    try {
      return fs.statSync(candidate).isFile() && !candidate.toLowerCase().endsWith('.pub');
    } catch {
      return false;
    }
  });
}

/** Agent profiles use the agent first, with OpenSSH identity files as fallback. */
export function buildAgentAuthMethods(
  profile: Pick<SshConnectionProfile, 'host' | 'username'>,
  sshDirectory = path.join(os.homedir(), '.ssh'),
): AnyAuthMethod[] {
  const methods: AnyAuthMethod[] = [{
    type: 'agent',
    username: profile.username,
    agent: process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent',
  }];
  for (const identityPath of findOpenSshIdentityFiles(profile, sshDirectory)) {
    try {
      methods.push({ type: 'publickey', username: profile.username, key: fs.readFileSync(identityPath) });
    } catch {
      // A key may disappear or become unreadable between discovery and connect.
    }
  }
  return methods;
}

function validateProfile(profile: SshConnectionProfile): SshConnectionProfile {
  const host = profile.host.trim();
  const username = profile.username.trim();
  const port = Number(profile.port);
  const supportedAuthMethods = new Set(['agent', 'privateKey', 'password']);
  if (
    !host
    || !username
    || /\s/.test(host)
    || /\s/.test(username)
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
    || !supportedAuthMethods.has(profile.authMethod)
  ) {
    throw new Error('SSH 连接信息无效');
  }
  if (profile.authMethod === 'privateKey' && !profile.privateKeyPath?.trim()) {
    throw new Error('请选择私钥文件');
  }
  return { ...profile, host, username, port, privateKeyPath: profile.privateKeyPath?.trim() };
}

export class SshAuthenticationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SshAuthenticationError';
  }
}

export class SshPasswordAuthenticationError extends SshAuthenticationError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SshPasswordAuthenticationError';
  }
}

function isAuthenticationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const level = (error as Error & { level?: string }).level;
  return level === 'client-authentication'
    || /authentication methods failed|authentication failure|permission denied/i.test(error.message);
}

function isSshPasswordPrompt(prompt: string): boolean {
  return /(?:password\s*[:：]|密码\s*[:：])\s*$/i.test(prompt);
}

export function buildSshConnectConfig(profile: SshConnectionProfile, password?: string): ConnectConfig {
  const config: ConnectConfig = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    readyTimeout: 15_000,
  };
  if (profile.authMethod === 'privateKey') {
    const keyPath = expandHome(profile.privateKeyPath!);
    config.privateKey = fs.readFileSync(keyPath);
  } else if (profile.authMethod === 'agent') {
    // The terminal's OpenSSH client can read IdentityFile/default keys even when
    // ssh-agent is disabled. ssh2 is a separate connection, so mirror that
    // behavior before trying the agent instead of failing at the named pipe.
    config.authHandler = buildAgentAuthMethods(profile);
  } else if (password) {
    config.password = password;
    config.tryKeyboard = true;
    config.authHandler = ['password', 'keyboard-interactive'];
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

  async connect(workspaceId: string, rawProfile: SshConnectionProfile, password?: string): Promise<void> {
    this.disconnect(workspaceId);
    const profile = validateProfile(rawProfile);
    const client = new Client();
    client.on('error', () => this.disconnect(workspaceId));
    let sftp: SFTPWrapper;
    let agentError: Error | undefined;
    try {
      sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        const answerKeyboardInteractive = (
          _name: string,
          _instructions: string,
          _language: string,
          prompts: Prompt[],
          finish: KeyboardInteractiveCallback,
        ) => {
          const answers = prompts.map((prompt) => isSshPasswordPrompt(prompt.prompt) ? password || '' : '');
          finish(answers);
        };
        const fail = (error: Error & { level?: string }) => {
          // ssh2 emits an agent-level error and then advances authHandler. Keep
          // listening so OpenSSH-configured/default keys can complete the same
          // connection instead of rejecting at the unavailable Windows pipe.
          if (error.level === 'agent') {
            agentError = error;
            return;
          }
          reject(error);
        };
        client.on('error', fail);
        if (profile.authMethod === 'password') {
          client.on('keyboard-interactive', answerKeyboardInteractive);
        }
        client.once('ready', () => {
          client.sftp((error, wrapper) => {
            if (error || !wrapper) {
              fail(error ?? new Error('无法建立 SFTP 会话'));
              return;
            }
            client.removeListener('error', fail);
            client.removeListener('keyboard-interactive', answerKeyboardInteractive);
            resolve(wrapper);
          });
        });
        try {
          client.connect(buildSshConnectConfig(profile, password));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } catch (error) {
      try { client.end(); } catch { /* connection already closed */ }
      if (profile.authMethod === 'password' && isAuthenticationFailure(error)) {
        throw new SshPasswordAuthenticationError('SSH 密码无效，请重新输入', { cause: error });
      }
      if (agentError) {
        throw new SshAuthenticationError(
          'SSH Agent 或默认私钥认证失败，请输入 SSH 密码继续',
          { cause: error },
        );
      }
      if (isAuthenticationFailure(error)) {
        throw new SshAuthenticationError('当前 SSH 认证方式失败，请输入 SSH 密码继续', {
          cause: error,
        });
      }
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

  async list(workspaceId: string, remotePath: string): Promise<SshFileListResult> {
    const sftp = this.getSftp(workspaceId);
    const directory = remotePath || '.';
    return new Promise((resolve, reject) => {
      sftp.realpath(directory, (pathError, absolutePath) => {
        if (pathError || !absolutePath) return reject(new Error(pathError?.message || '无法解析远程目录'));
        sftp.readdir(absolutePath, (error, entries) => {
          if (error) return reject(new Error(error.message || '无法读取远程目录'));
          resolve({
            path: absolutePath,
            entries: entries
              .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
              .map((entry) => toFileEntry(entry, absolutePath))
              .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name)),
          });
        });
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
