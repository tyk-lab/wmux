import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { TextDecoder } from 'util';
import {
  Client,
  type Attributes,
  type AnyAuthMethod,
  type ConnectConfig,
  type KeyboardInteractiveCallback,
  type Prompt,
  type SFTPWrapper,
} from 'ssh2';
import {
  SshConfigDraft,
  SshConnectionProfile,
  SshFileEntry,
  SshFileListResult,
  SshTextFileResult,
  SshTextFileWriteResult,
} from '../shared/types';

type SshSession = { client: Client; sftp: SFTPWrapper };

export const MAX_SSH_TEXT_BYTES = 5 * 1024 * 1024;

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

function permissionCharacter(mode: number, read: number, write: number, execute: number, special: number, specialChar: string): string {
  const readChar = mode & read ? 'r' : '-';
  const writeChar = mode & write ? 'w' : '-';
  const executable = Boolean(mode & execute);
  const executeChar = mode & special ? (executable ? specialChar : specialChar.toUpperCase()) : executable ? 'x' : '-';
  return `${readChar}${writeChar}${executeChar}`;
}

export function formatSshPermissions(mode = 0): string {
  const kind = (mode & 0o170000) === 0o040000 ? 'd'
    : (mode & 0o170000) === 0o120000 ? 'l'
      : (mode & 0o170000) === 0o100000 ? '-' : '?';
  return kind
    + permissionCharacter(mode, 0o400, 0o200, 0o100, 0o4000, 's')
    + permissionCharacter(mode, 0o040, 0o020, 0o010, 0o2000, 's')
    + permissionCharacter(mode, 0o004, 0o002, 0o001, 0o1000, 't');
}

export function parseSshLongnameOwnerGroup(longname: string): { owner?: string; group?: string } {
  const fields = longname.trim().split(/\s+/);
  if (fields.length < 4 || !/^[bcdlps?-][rwxStTs-]{9}[+@.]?$/.test(fields[0])) return {};
  return { owner: fields[2], group: fields[3] };
}

function toFileEntry(entry: {
  filename: string;
  longname: string;
  attrs: { size: number; mtime?: number; mode?: number; uid?: number; gid?: number };
}, parent: string): SshFileEntry {
  const mode = entry.attrs.mode ?? 0;
  const kind = (mode & 0o170000) === 0o040000 ? 'directory'
    : (mode & 0o170000) === 0o120000 ? 'link'
      : (mode & 0o170000) === 0o100000 ? 'file' : 'other';
  const longnameDetails = parseSshLongnameOwnerGroup(entry.longname || '');
  const owner = longnameDetails.owner || (entry.attrs.uid !== undefined ? String(entry.attrs.uid) : undefined);
  const group = longnameDetails.group || (entry.attrs.gid !== undefined ? String(entry.attrs.gid) : undefined);
  return {
    name: entry.filename,
    path: path.posix.join(parent, entry.filename),
    type: kind,
    size: entry.attrs.size ?? 0,
    modifiedAt: entry.attrs.mtime ? entry.attrs.mtime * 1000 : undefined,
    ...(owner ? { owner } : {}),
    ...(group ? { group } : {}),
    permissions: formatSshPermissions(mode),
  };
}

function cleanSshEntryName(name: string): string {
  const cleanName = name?.trim();
  if (
    !cleanName
    || cleanName === '.'
    || cleanName === '..'
    || cleanName.includes('/')
    || cleanName.includes('\0')
  ) {
    throw new Error('远程文件名无效');
  }
  return cleanName;
}

export function buildSshChildPath(remoteDirectory: string, name: string): string {
  const cleanDirectory = remoteDirectory?.trim();
  if (!cleanDirectory || cleanDirectory.includes('\0')) throw new Error('远程目录路径无效');
  return path.posix.join(cleanDirectory, cleanSshEntryName(name));
}

export function buildSshRenameTarget(remotePath: string, newName: string): string {
  const cleanPath = remotePath?.trim();
  if (!cleanPath || cleanPath.includes('\0')) throw new Error('远程文件路径无效');
  return buildSshChildPath(path.posix.dirname(cleanPath), newName);
}

async function sftpPathExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    sftp.lstat(remotePath, (error) => {
      if (!error) {
        resolve(true);
        return;
      }
      const code = (error as Error & { code?: number | string }).code;
      if (code === 2 || code === 'ENOENT') resolve(false);
      else reject(new Error(error.message || '无法检查远程目标'));
    });
  });
}

function validateSshFilePath(remotePath: string): string {
  const cleanPath = remotePath?.trim();
  if (!cleanPath || cleanPath.includes('\0')) throw new Error('远程文件路径无效');
  return cleanPath;
}

function remoteMtimeMs(mtime: number | undefined): number {
  return (mtime || 0) * 1000;
}

async function statSshTextFile(sftp: SFTPWrapper, remotePath: string): Promise<Attributes> {
  const attributes = await new Promise<Attributes>((resolve, reject) => {
    sftp.lstat(remotePath, (error, value) => {
      if (error || !value) {
        reject(new Error(error?.message || '无法读取远程文件信息'));
        return;
      }
      resolve(value);
    });
  });
  if ((attributes.mode & 0o170000) !== 0o100000) throw new Error('只能用编辑器打开普通文件');
  if (attributes.size > MAX_SSH_TEXT_BYTES) throw new Error('远程文件超过 5MB，无法在编辑器中打开');
  return attributes;
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
      const readDirectory = (absolutePath: string) => {
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
      };
      if (directory.startsWith('/')) {
        readDirectory(path.posix.normalize(directory));
        return;
      }
      sftp.realpath(directory, (pathError, absolutePath) => {
        if (pathError || !absolutePath) return reject(new Error(pathError?.message || '无法解析远程目录'));
        readDirectory(absolutePath);
      });
    });
  }

  async readTextFile(workspaceId: string, remotePath: string): Promise<SshTextFileResult> {
    const cleanPath = validateSshFilePath(remotePath);
    const sftp = this.getSftp(workspaceId);
    const attributes = await statSshTextFile(sftp, cleanPath);
    const data = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(cleanPath, (error, value) => {
        if (error || !value) {
          reject(new Error(error?.message || '读取远程文件失败'));
          return;
        }
        resolve(value);
      });
    });
    if (data.byteLength > MAX_SSH_TEXT_BYTES) throw new Error('远程文件超过 5MB，无法在编辑器中打开');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw new Error('远程文件不是有效的 UTF-8 文本，无法在编辑器中打开');
    }
    return { path: cleanPath, content, mtimeMs: remoteMtimeMs(attributes.mtime) };
  }

  async statTextFile(workspaceId: string, remotePath: string): Promise<{ mtimeMs: number }> {
    const cleanPath = validateSshFilePath(remotePath);
    const attributes = await statSshTextFile(this.getSftp(workspaceId), cleanPath);
    return { mtimeMs: remoteMtimeMs(attributes.mtime) };
  }

  async writeTextFile(
    workspaceId: string,
    remotePath: string,
    content: string,
    expectedMtimeMs?: number,
  ): Promise<SshTextFileWriteResult> {
    const cleanPath = validateSshFilePath(remotePath);
    if (typeof content !== 'string') throw new Error('没有可写入的文本内容');
    if (Buffer.byteLength(content, 'utf8') > MAX_SSH_TEXT_BYTES) throw new Error('文本内容超过 5MB，无法保存');
    const sftp = this.getSftp(workspaceId);
    const attributes = await statSshTextFile(sftp, cleanPath);
    const currentMtimeMs = remoteMtimeMs(attributes.mtime);
    if (expectedMtimeMs !== undefined && currentMtimeMs !== expectedMtimeMs) {
      return { conflict: true, currentMtimeMs };
    }
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(cleanPath, content, 'utf8', (error) => error
        ? reject(new Error(error.message || '保存远程文件失败'))
        : resolve());
    });
    const updated = await statSshTextFile(sftp, cleanPath);
    return { ok: true, mtimeMs: remoteMtimeMs(updated.mtime) };
  }

  async rename(workspaceId: string, remotePath: string, newName: string): Promise<string> {
    const targetPath = buildSshRenameTarget(remotePath, newName);
    const sftp = this.getSftp(workspaceId);
    if (await sftpPathExists(sftp, targetPath)) throw new Error(`“${newName.trim()}”已存在`);
    await new Promise<void>((resolve, reject) => sftp.rename(remotePath, targetPath, (error) =>
      error ? reject(new Error(error.message || '重命名失败')) : resolve()));
    return targetPath;
  }

  async createEntry(
    workspaceId: string,
    remoteDirectory: string,
    name: string,
    type: 'file' | 'directory',
  ): Promise<string> {
    if (type !== 'file' && type !== 'directory') throw new Error('远程项目类型无效');
    const targetPath = buildSshChildPath(remoteDirectory, name);
    const sftp = this.getSftp(workspaceId);
    if (await sftpPathExists(sftp, targetPath)) throw new Error(`“${name.trim()}”已存在`);
    if (type === 'directory') {
      await new Promise<void>((resolve, reject) => sftp.mkdir(targetPath, (error) =>
        error ? reject(new Error(error.message || '新建目录失败')) : resolve()));
      return targetPath;
    }
    await new Promise<void>((resolve, reject) => {
      sftp.open(targetPath, 'wx', (openError, handle) => {
        if (openError || !handle) {
          reject(new Error(openError?.message || '新建文件失败'));
          return;
        }
        sftp.close(handle, (closeError) => closeError
          ? reject(new Error(closeError.message || '关闭新文件失败'))
          : resolve());
      });
    });
    return targetPath;
  }

  async deleteEntry(workspaceId: string, remotePath: string): Promise<void> {
    if (!remotePath?.trim() || remotePath.includes('\0')) throw new Error('远程文件路径无效');
    const sftp = this.getSftp(workspaceId);
    await new Promise<void>((resolve, reject) => {
      sftp.lstat(remotePath, (statError, attributes) => {
        if (statError || !attributes) {
          reject(new Error(statError?.message || '无法读取远程文件信息'));
          return;
        }
        const callback = (error?: Error | null) => error
          ? reject(new Error(error.message || '删除失败；目录必须为空'))
          : resolve();
        if ((attributes.mode & 0o170000) === 0o040000) sftp.rmdir(remotePath, callback);
        else sftp.unlink(remotePath, callback);
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
