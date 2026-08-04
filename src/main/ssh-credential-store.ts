import fs from 'fs';
import path from 'path';
import { getAppDataDir } from '../shared/instance';

interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface CredentialFile {
  version: 1;
  credentials: Record<string, StoredCredential>;
}

export interface SshCredentialScope {
  host: string;
  port: number;
  username: string;
}

interface StoredCredential extends SshCredentialScope {
  encryptedPassword: string;
}

const EMPTY_CREDENTIALS: CredentialFile = { version: 1, credentials: {} };

function isCredentialId(profileId: string): boolean {
  return /^[a-z0-9_-]{1,128}$/i.test(profileId)
    && !['__proto__', 'constructor', 'prototype'].includes(profileId.toLowerCase());
}

/** Stores only DPAPI-protected ciphertext; plaintext never reaches settings/session files. */
export class SshCredentialStore {
  constructor(
    private readonly encryption: SafeStorageAdapter,
    private readonly filePath = path.join(getAppDataDir(), 'ssh-credentials.json'),
  ) {}

  get(profileId: string, scope: SshCredentialScope): string | undefined {
    if (!isCredentialId(profileId) || !this.encryption.isEncryptionAvailable()) return undefined;
    const stored = this.read().credentials[profileId];
    if (!stored || !this.matchesScope(stored, scope)) return undefined;
    try {
      return this.encryption.decryptString(Buffer.from(stored.encryptedPassword, 'base64'));
    } catch {
      // Corrupt or no-longer-decryptable DPAPI data must not cause repeated
      // startup failures. Remove it so the UI asks for a fresh password.
      this.delete(profileId);
      return undefined;
    }
  }

  has(profileId: string, scope: SshCredentialScope): boolean {
    return this.get(profileId, scope) !== undefined;
  }

  save(profileId: string, password: string, scope: SshCredentialScope): void {
    if (!isCredentialId(profileId)) throw new Error('SSH 凭据标识无效');
    if (!password) throw new Error('SSH 密码不能为空');
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储不可用，SSH 密码未保存');
    }
    const file = this.read();
    file.credentials[profileId] = {
      ...scope,
      encryptedPassword: this.encryption.encryptString(password).toString('base64'),
    };
    this.write(file);
  }

  delete(profileId: string): void {
    if (!isCredentialId(profileId)) return;
    const file = this.read();
    if (!(profileId in file.credentials)) return;
    delete file.credentials[profileId];
    this.write(file);
  }

  private read(): CredentialFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<CredentialFile>;
      if (parsed.version !== 1 || !parsed.credentials || typeof parsed.credentials !== 'object') {
        return { ...EMPTY_CREDENTIALS, credentials: {} };
      }
      return { version: 1, credentials: { ...parsed.credentials } };
    } catch {
      return { ...EMPTY_CREDENTIALS, credentials: {} };
    }
  }

  private matchesScope(stored: StoredCredential, scope: SshCredentialScope): boolean {
    return stored.host === scope.host
      && stored.port === scope.port
      && stored.username === scope.username;
  }

  private write(file: CredentialFile): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    fs.renameSync(temporaryPath, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* best effort on Windows */ }
  }
}
