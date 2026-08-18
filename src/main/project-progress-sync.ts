import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { ProjectProgressEntry, ProjectProgressSnapshot } from '../shared/project-manager';

const MAX_ENTRIES = 500;
const MAX_HASH_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_HASH_BYTES = 32 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.wmux', '.my', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache',
]);

export type CaptureProjectProgressResult =
  | { ok: true; snapshot: ProjectProgressSnapshot }
  | { ok: false; error: string };

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

interface HashBudget { remaining: number }

function fileSignature(filePath: string, budget: HashBudget): string {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return `symlink:${sha256(fs.readlinkSync(filePath))}`;
    if (!stat.isFile()) return `non-file:${stat.mode}`;
    if (stat.size <= MAX_HASH_BYTES && stat.size <= budget.remaining) {
      budget.remaining -= stat.size;
      return `sha256:${sha256(fs.readFileSync(filePath))}`;
    }
    return `large:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code || 'unreadable';
    return `missing:${code}`;
  }
}

function runGit(cwd: string, args: string[]): Buffer | null {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    windowsHide: true,
    timeout: 8_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.status === 0 && Buffer.isBuffer(result.stdout) ? result.stdout : null;
}

function gitText(cwd: string, args: string[]): string {
  return runGit(cwd, args)?.toString('utf8').trim() || '';
}

function parseGitNameStatus(output: Buffer): Array<{ status: string; filePath: string }> {
  const tokens = output.toString('utf8').split('\0').filter(Boolean);
  const entries: Array<{ status: string; filePath: string }> = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] || 'M';
    const firstPath = tokens[index++] || '';
    const renamed = status.startsWith('R') || status.startsWith('C');
    const filePath = renamed ? tokens[index++] || firstPath : firstPath;
    if (filePath) entries.push({ status, filePath });
  }
  return entries;
}

function projectRelativeGitPath(root: string, projectDir: string, filePath: string): string | null {
  const absolute = path.resolve(root, filePath);
  const relative = path.relative(projectDir, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.replace(/\\/gu, '/');
}

function captureGitEntries(projectDir: string, budget: HashBudget): {
  entries: ProjectProgressEntry[];
  head?: string;
  headSummary?: string;
  branch?: string;
  truncated: boolean;
} | null {
  const root = gitText(projectDir, ['rev-parse', '--show-toplevel']);
  if (!root || !path.isAbsolute(root)) return null;
  const relativeScope = path.relative(root, projectDir).replace(/\\/gu, '/');
  if (relativeScope === '..' || relativeScope.startsWith('../') || path.isAbsolute(relativeScope)) return null;
  const scope = relativeScope || '.';
  // Use the latest commit that touched this managed directory. A monorepo commit
  // outside the project must not invalidate this project's scheduling state.
  const head = gitText(root, ['log', '-1', '--format=%H', '--', scope]);
  const headSummary = head ? gitText(root, ['log', '-1', '--pretty=%h %s', '--', scope]) : '';
  const branch = gitText(root, ['branch', '--show-current']);
  const trackedOutputs = head
    ? [runGit(root, ['diff', '--name-status', '-z', 'HEAD', '--', scope])]
    : [
        runGit(root, ['diff', '--name-status', '-z', '--cached', '--', scope]),
        runGit(root, ['diff', '--name-status', '-z', '--', scope]),
      ];
  const byPath = new Map<string, { status: string; filePath: string }>();
  for (const output of trackedOutputs) {
    if (!output) continue;
    for (const entry of parseGitNameStatus(output)) {
      const relative = projectRelativeGitPath(root, projectDir, entry.filePath);
      if (relative) byPath.set(relative, { ...entry, filePath: relative });
    }
  }
  const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', scope]);
  for (const filePath of untracked?.toString('utf8').split('\0').filter(Boolean) || []) {
    const relative = projectRelativeGitPath(root, projectDir, filePath);
    if (relative) byPath.set(relative, { status: 'A?', filePath: relative });
  }
  const candidates = [...byPath.values()]
    .filter((entry) => {
      const normalized = `/${entry.filePath.replace(/\\/gu, '/')}/`;
      return !normalized.includes('/.wmux/') && !normalized.includes('/.my/');
    })
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  const entries = candidates.slice(0, MAX_ENTRIES).map((entry) => ({
    path: entry.filePath,
    source: 'workspace' as const,
    status: entry.status,
    signature: fileSignature(path.resolve(projectDir, entry.filePath), budget),
  }));
  return {
    entries,
    ...(head ? { head } : {}),
    ...(headSummary ? { headSummary } : {}),
    ...(branch ? { branch } : {}),
    truncated: candidates.length > MAX_ENTRIES,
  };
}

function captureFilesystemEntries(projectDir: string, budget: HashBudget): {
  entries: ProjectProgressEntry[];
  truncated: boolean;
} {
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (files.length > MAX_ENTRIES) return;
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }
    for (const child of children) {
      if (files.length > MAX_ENTRIES) return;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(child.name)) visit(absolute);
      } else if (child.isFile()) {
        files.push(absolute);
      }
    }
  };
  visit(projectDir);
  return {
    entries: files.slice(0, MAX_ENTRIES).map((filePath) => ({
      path: path.relative(projectDir, filePath),
      source: 'workspace' as const,
      status: 'F',
      signature: fileSignature(filePath, budget),
    })),
    truncated: files.length > MAX_ENTRIES,
  };
}

function capturePlanEntries(filePaths: unknown, budget: HashBudget): ProjectProgressEntry[] {
  if (!Array.isArray(filePaths)) return [];
  return [...new Set(filePaths.map((value) => String(value || '').trim()).filter(path.isAbsolute))]
    .slice(0, 3)
    .map((filePath) => ({
      path: path.normalize(filePath),
      source: 'plan' as const,
      status: 'PLAN',
      signature: fileSignature(filePath, budget),
    }));
}

export function captureProjectProgress(
  projectDirValue: unknown,
  planFilePaths: unknown = [],
): CaptureProjectProgressResult {
  const rawProjectDir = String(projectDirValue || '').trim();
  if (!path.isAbsolute(rawProjectDir)) {
    return { ok: false, error: '项目进度同步目录必须是绝对路径' };
  }
  const projectDir = path.resolve(rawProjectDir);
  try {
    if (!path.isAbsolute(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      return { ok: false, error: '项目进度同步目录不存在或不是文件夹' };
    }
  } catch {
    return { ok: false, error: '项目进度同步目录不存在或不可访问' };
  }
  const budget = { remaining: MAX_TOTAL_HASH_BYTES };
  const git = captureGitEntries(projectDir, budget);
  const workspace = git || captureFilesystemEntries(projectDir, budget);
  const planEntries = capturePlanEntries(planFilePaths, budget);
  const allEntries = [...workspace.entries, ...planEntries]
    .sort((left, right) => `${left.source}:${left.path}`.localeCompare(`${right.source}:${right.path}`));
  const entries = allEntries.slice(0, MAX_ENTRIES);
  const truncated = workspace.truncated || allEntries.length > MAX_ENTRIES;
  const capturedAt = Date.now();
  const fingerprint = sha256(JSON.stringify({
    mode: git ? 'git' : 'filesystem',
    head: git?.head || '',
    headSummary: git?.headSummary || '',
    branch: git?.branch || '',
    entries: entries.map((entry) => [entry.source, entry.path, entry.status, entry.signature]),
    truncated,
  }));
  return {
    ok: true,
    snapshot: {
      version: 1,
      capturedAt,
      mode: git ? 'git' : 'filesystem',
      fingerprint,
      ...(git?.head ? { head: git.head } : {}),
      ...(git?.headSummary ? { headSummary: git.headSummary } : {}),
      ...(git?.branch ? { branch: git.branch } : {}),
      entries,
      truncated,
    },
  };
}
