import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TextDecoder } from 'util';
import { MAX_SSH_TEXT_BYTES, type SshAtomicTextWriteResult } from './ssh-manager';
import type { SshTextFileResult } from '../shared/types';

const SSH_EDIT_TTL_MS = 30 * 60 * 1000;
const STALE_SSH_EDIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SSH_EDIT_DIRECTORY_PREFIX = 'wmux-ssh-edit-';

interface SshEditBackend {
  pathExists(workspaceId: string, remotePath: string): Promise<boolean>;
  readTextFile(workspaceId: string, remotePath: string): Promise<SshTextFileResult>;
  writeTextFileAtomically(
    workspaceId: string,
    remotePath: string,
    content: string,
    expected: { mtimeMs?: number; mustBeMissing?: boolean },
  ): Promise<SshAtomicTextWriteResult>;
}

interface SshEditTransaction {
  callerSurfaceId: string;
  targetSurfaceId: string;
  workspaceId: string;
  remotePath: string;
  stagingDirectory: string;
  stagingPath: string;
  originalMtimeMs?: number;
  originalSha256: string;
  remoteExisted: boolean;
  state: 'open' | 'committing';
  timer: ReturnType<typeof setTimeout>;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validateRemoteEditPath(remotePath: string): string {
  const cleanPath = path.posix.normalize(String(remotePath || '').trim());
  if (!cleanPath.startsWith('/') || cleanPath === '/' || cleanPath.includes('\0')) {
    throw new Error('远程编辑路径必须是绝对文件路径');
  }
  return cleanPath;
}

function stagingFileName(remotePath: string): string {
  const name = [...path.posix.basename(remotePath)]
    .map((character) => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character)
    .join('')
    .slice(0, 120);
  const safeName = name && name !== '.' && name !== '..' ? name : 'file';
  return `remote-${safeName}.wmux-staging`;
}

export class SshEditTransactionManager {
  private transactions = new Map<string, SshEditTransaction>();

  constructor(private readonly backend: SshEditBackend) {
    cleanupStaleSshEditDirectories();
  }

  async checkout(input: {
    callerSurfaceId: string;
    targetSurfaceId: string;
    workspaceId: string;
    remotePath: string;
    create?: boolean;
  }): Promise<Record<string, unknown>> {
    const remotePath = validateRemoteEditPath(input.remotePath);
    const remoteExisted = await this.backend.pathExists(input.workspaceId, remotePath);
    if (!remoteExisted && !input.create) throw new Error('远程文件不存在；新建文件请增加 --create');
    const remote = remoteExisted
      ? await this.backend.readTextFile(input.workspaceId, remotePath)
      : { path: remotePath, content: '', mtimeMs: undefined };
    const token = `ssh-edit-${crypto.randomUUID()}`;
    const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), SSH_EDIT_DIRECTORY_PREFIX));
    const stagingPath = path.join(stagingDirectory, stagingFileName(remotePath));
    try {
      fs.writeFileSync(stagingPath, remote.content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
    const timer = setTimeout(() => this.expire(token), SSH_EDIT_TTL_MS);
    timer.unref?.();
    this.transactions.set(token, {
      callerSurfaceId: input.callerSurfaceId,
      targetSurfaceId: input.targetSurfaceId,
      workspaceId: input.workspaceId,
      remotePath,
      stagingDirectory,
      stagingPath,
      originalMtimeMs: remote.mtimeMs,
      originalSha256: sha256(remote.content),
      remoteExisted,
      state: 'open',
      timer,
    });
    return {
      ok: true,
      token,
      stagingPath,
      remotePath,
      remoteExisted,
      mtimeMs: remote.mtimeMs,
      sha256: sha256(remote.content),
      expiresInMs: SSH_EDIT_TTL_MS,
    };
  }

  async commit(callerSurfaceId: string, token: string): Promise<Record<string, unknown>> {
    const transaction = this.requireOwned(callerSurfaceId, token);
    if (transaction.state !== 'open') throw new Error('SSH 编辑事务正在提交，请勿重复操作');
    transaction.state = 'committing';
    try {
      const stat = fs.lstatSync(transaction.stagingPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('受管暂存文件无效');
      const contentBuffer = fs.readFileSync(transaction.stagingPath);
      if (contentBuffer.byteLength > MAX_SSH_TEXT_BYTES) throw new Error('暂存文本超过 5MB，无法提交');
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(contentBuffer);
      } catch {
        throw new Error('暂存文件不是有效的 UTF-8 文本');
      }
      if (transaction.remoteExisted) {
        const currentRemote = await this.backend.readTextFile(
          transaction.workspaceId,
          transaction.remotePath,
        );
        if (currentRemote.mtimeMs !== transaction.originalMtimeMs
          || sha256(currentRemote.content) !== transaction.originalSha256) {
          transaction.state = 'open';
          return {
            ok: false,
            conflict: true,
            reason: 'changed',
            currentMtimeMs: currentRemote.mtimeMs,
            token,
            stagingPath: transaction.stagingPath,
          };
        }
      }
      const result = await this.backend.writeTextFileAtomically(
        transaction.workspaceId,
        transaction.remotePath,
        content,
        transaction.remoteExisted
          ? { mtimeMs: transaction.originalMtimeMs }
          : { mustBeMissing: true },
      );
      if ('conflict' in result) {
        transaction.state = 'open';
        return {
          ok: false,
          conflict: true,
          reason: result.reason,
          currentMtimeMs: result.currentMtimeMs,
          token,
          stagingPath: transaction.stagingPath,
        };
      }
      const verified = await this.backend.readTextFile(transaction.workspaceId, transaction.remotePath);
      const localSha256 = sha256(contentBuffer);
      const remoteSha256 = sha256(verified.content);
      if (localSha256 !== remoteSha256) throw new Error('远端写后校验失败；暂存文件已保留');
      this.cleanup(token, true);
      return {
        ok: true,
        remotePath: transaction.remotePath,
        mtimeMs: verified.mtimeMs,
        sha256: remoteSha256,
        bytes: contentBuffer.byteLength,
        originalSha256: transaction.originalSha256,
      };
    } catch (error) {
      if (this.transactions.get(token) === transaction) transaction.state = 'open';
      throw error;
    }
  }

  abort(callerSurfaceId: string, token: string): { ok: true } {
    const transaction = this.requireOwned(callerSurfaceId, token);
    if (transaction.state !== 'open') throw new Error('SSH 编辑事务正在提交，无法中止');
    this.cleanup(token, true);
    return { ok: true };
  }

  cleanupAll(): void {
    for (const token of [...this.transactions.keys()]) this.cleanup(token, true);
  }

  private requireOwned(callerSurfaceId: string, token: string): SshEditTransaction {
    const transaction = this.transactions.get(String(token || ''));
    if (!transaction) throw new Error('SSH 编辑事务不存在或已过期');
    if (!callerSurfaceId || transaction.callerSurfaceId !== callerSurfaceId) {
      throw new Error('当前 surface 无权使用该 SSH 编辑事务');
    }
    return transaction;
  }

  private expire(token: string): void {
    const transaction = this.transactions.get(token);
    if (!transaction) return;
    if (transaction.state === 'committing') {
      transaction.timer = setTimeout(() => this.expire(token), 60_000);
      transaction.timer.unref?.();
      return;
    }
    this.cleanup(token, true);
  }

  private cleanup(token: string, force = false): void {
    const transaction = this.transactions.get(token);
    if (!transaction) return;
    if (transaction.state === 'committing' && !force) return;
    clearTimeout(transaction.timer);
    this.transactions.delete(token);
    try {
      fs.rmSync(transaction.stagingDirectory, { recursive: true, force: true });
    } catch {
      // A later startup sweep retries cleanup without turning a remote success into failure.
    }
  }
}

export function cleanupStaleSshEditDirectories(
  tempRoot = os.tmpdir(),
  now = Date.now(),
  maxAgeMs = STALE_SSH_EDIT_MAX_AGE_MS,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tempRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SSH_EDIT_DIRECTORY_PREFIX)) continue;
    const candidate = path.join(tempRoot, entry.name);
    try {
      const stat = fs.lstatSync(candidate);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      fs.rmSync(candidate, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup must never prevent wmux startup.
    }
  }
}
