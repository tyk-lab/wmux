import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const MAX_TRANSFER_FILES = 100;

export interface RemoteTransferFile {
  path: string;
  name: string;
}

export interface PreparedDrag {
  token: string;
  files: string[];
}

function safeLocalName(name: string, index: number): string {
  const base = [...path.posix.basename(name)]
    .map((character) => character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? '_' : character)
    .join('')
    .replace(/[. ]+$/g, '');
  if (!base) return `download-${index + 1}`;
  const stem = path.parse(base).name;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? `_${base}` : base;
}

function uniqueLocalName(name: string, usedNames: ReadonlySet<string>): string {
  if (!usedNames.has(name.toLowerCase())) return name;
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  for (let suffix = 2; ; suffix++) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!usedNames.has(candidate.toLowerCase())) return candidate;
  }
}

export function validateLocalUploadFiles(localPaths: unknown): { files: string[]; rejected: string[] } {
  if (!Array.isArray(localPaths) || localPaths.length > MAX_TRANSFER_FILES) {
    throw new Error(`一次最多传输 ${MAX_TRANSFER_FILES} 个文件`);
  }
  const files: string[] = [];
  const rejected: string[] = [];
  for (const value of localPaths) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
    try {
      if (fs.statSync(value).isFile()) files.push(value);
      else rejected.push(path.basename(value));
    } catch {
      rejected.push(path.basename(value));
    }
  }
  return { files: [...new Set(files)], rejected };
}

export function validateRemoteTransferFiles(files: unknown): RemoteTransferFile[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_TRANSFER_FILES) {
    throw new Error(`请选择 1-${MAX_TRANSFER_FILES} 个远程文件`);
  }
  return files.map((value, index) => {
    const candidate = value as Partial<RemoteTransferFile>;
    if (
      !candidate
      || typeof candidate.path !== 'string'
      || typeof candidate.name !== 'string'
      || !candidate.path
      || candidate.path.includes('\0')
    ) {
      throw new Error('远程文件信息无效');
    }
    return { path: candidate.path, name: safeLocalName(candidate.name, index) };
  });
}

export function nextAvailableLocalPath(directory: string, name: string): string {
  const safeName = safeLocalName(name, 0);
  const extension = path.extname(safeName);
  const stem = path.basename(safeName, extension);
  let candidate = path.join(directory, safeName);
  for (let suffix = 1; fs.existsSync(candidate); suffix++) {
    candidate = path.join(directory, `${stem} (${suffix})${extension}`);
  }
  return candidate;
}

export class SshTransferCache {
  private readonly root: string;
  private readonly prepared = new Map<string, string[]>();
  private readonly ownerTokens = new Map<string, string>();

  constructor(root = path.join(os.tmpdir(), `wmux-ssh-drag-${process.pid}`)) {
    this.root = path.resolve(root);
  }

  async prepare(
    remoteFiles: unknown,
    download: (remotePath: string, localPath: string) => Promise<void>,
    owner = 'default',
  ): Promise<PreparedDrag> {
    const files = validateRemoteTransferFiles(remoteFiles);
    const previousToken = this.ownerTokens.get(owner);
    if (previousToken) {
      this.prepared.delete(previousToken);
      fs.rmSync(path.join(this.root, previousToken), { recursive: true, force: true });
      this.ownerTokens.delete(owner);
    }
    const token = randomUUID();
    const directory = path.join(this.root, token);
    fs.mkdirSync(directory, { recursive: true });
    const localFiles: string[] = [];
    const usedNames = new Set<string>();
    try {
      for (const file of files) {
        const localName = uniqueLocalName(file.name, usedNames);
        usedNames.add(localName.toLowerCase());
        const localPath = path.join(directory, localName);
        await download(file.path, localPath);
        localFiles.push(localPath);
      }
      this.prepared.set(token, localFiles);
      this.ownerTokens.set(owner, token);
      return { token, files: localFiles };
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  get(token: string): string[] | undefined {
    if (!/^[a-f0-9-]{36}$/i.test(token)) return undefined;
    const files = this.prepared.get(token);
    if (!files?.length) return undefined;
    const rootPrefix = `${this.root}${path.sep}`.toLowerCase();
    if (files.some((file) => !path.resolve(file).toLowerCase().startsWith(rootPrefix) || !fs.existsSync(file))) return undefined;
    return [...files];
  }

  cleanup(): void {
    this.prepared.clear();
    this.ownerTokens.clear();
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
