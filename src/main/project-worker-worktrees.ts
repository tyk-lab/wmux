import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { getAppDataDir } from '../shared/instance';
import type { ProjectWorkerAssignment } from '../shared/project-manager';

const execFileAsync = promisify(execFile);
const WORKTREE_ROOT_DIRECTORY = 'project-worker-worktrees';

interface WorkerWorktreeRecord {
  workerId: string;
  role: ProjectWorkerAssignment['role'];
  repoWorktreePath: string;
  taskWorktreePath: string;
  writeClaims: string[];
}

interface WorkerGroupRecord {
  version: 1;
  projectId: string;
  workItemId: string;
  executionEpoch: number;
  projectDir: string;
  repoRoot: string;
  projectRelativePath: string;
  baselineCommit: string;
  baselineTree: string;
  workers: WorkerWorktreeRecord[];
  createdAt: number;
}

export interface PrepareProjectWorkerGroupRequest {
  projectId: string;
  workItemId: string;
  executionEpoch: number;
  projectDir: string;
  assignments: ProjectWorkerAssignment[];
}

export interface SubmitProjectMergeCandidateRequest {
  projectId: string;
  workItemId: string;
  executionEpoch: number;
  workerId: string;
  assignmentVersion: number;
  evidence?: string[];
}

export interface ApplyProjectMergeCandidateRequest {
  projectId: string;
  workItemId: string;
  executionEpoch: number;
  candidateId: string;
}

export interface FinalizeProjectWorkerGroupRequest {
  projectId: string;
  workItemId: string;
  executionEpoch: number;
}

function safeId(value: unknown, label: string): string {
  const text = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u.test(text)) {
    throw new Error(`${label} 只能包含字母、数字、点、下划线和短横线`);
  }
  return text;
}

function runtimeRoot(): string {
  return path.join(getAppDataDir(), 'supervisor', 'runtime', WORKTREE_ROOT_DIRECTORY);
}

function groupDirectory(request: Pick<PrepareProjectWorkerGroupRequest, 'projectId' | 'workItemId' | 'executionEpoch'>): string {
  const projectId = safeId(request.projectId, 'projectId');
  const workItemId = safeId(request.workItemId, 'workItemId');
  const epoch = Math.max(1, Math.trunc(Number(request.executionEpoch) || 0));
  return path.join(runtimeRoot(), `${projectId}--${workItemId}--e${epoch}`);
}

function metadataPath(groupDir: string): string {
  return path.join(groupDir, 'worker-group.json');
}

function candidatePath(groupDir: string, candidateId: string): string {
  return path.join(groupDir, 'candidates', `${safeId(candidateId, 'candidateId')}.patch`);
}

function pathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function git(cwd: string, args: string[], options: {
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  raw?: boolean;
} = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    env: options.env,
  });
  const output = String(stdout || '');
  return options.raw ? output : output.trim();
}

async function withTemporaryIndex<T>(repoRoot: string, operation: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const indexPath = path.join(os.tmpdir(), `wmux-project-index-${crypto.randomUUID()}`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: 'wmux project supervisor',
    GIT_AUTHOR_EMAIL: 'wmux-project@localhost',
    GIT_COMMITTER_NAME: 'wmux project supervisor',
    GIT_COMMITTER_EMAIL: 'wmux-project@localhost',
  };
  try {
    return await operation(env);
  } finally {
    try {
      fs.rmSync(indexPath, { force: true });
    } catch {
      // The temporary index is outside the repository and has no durable value.
    }
  }
}

async function captureTree(repoRoot: string, projectRelativePath: string): Promise<{ parent: string; tree: string }> {
  const parent = await git(repoRoot, ['rev-parse', 'HEAD']);
  return withTemporaryIndex(repoRoot, async (env) => {
    await git(repoRoot, ['read-tree', parent], { env });
    const pathspec = projectRelativePath === '.' ? '.' : projectRelativePath;
    const tempExclusion = projectRelativePath === '.'
      ? ':(exclude).wmux/tmp'
      : `:(exclude)${projectRelativePath}/.wmux/tmp`;
    await git(repoRoot, ['add', '-A', '--', pathspec, tempExclusion], { env });
    const tree = await git(repoRoot, ['write-tree'], { env });
    return { parent, tree };
  });
}

function readGroupRecord(request: Pick<PrepareProjectWorkerGroupRequest, 'projectId' | 'workItemId' | 'executionEpoch'>): {
  groupDir: string;
  record: WorkerGroupRecord;
} {
  const groupDir = groupDirectory(request);
  const filePath = metadataPath(groupDir);
  if (!fs.existsSync(filePath)) throw new Error('多任务 AI 隔离环境尚未创建或元数据不完整');
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WorkerGroupRecord;
  if (record.version !== 1
    || record.projectId !== request.projectId
    || record.workItemId !== request.workItemId
    || record.executionEpoch !== Math.trunc(Number(request.executionEpoch))) {
    throw new Error('多任务 AI 隔离环境与当前执行轮次不匹配');
  }
  return { groupDir, record };
}

function publicGroupResult(record: WorkerGroupRecord, recovered: boolean): Record<string, unknown> {
  return {
    ok: true,
    recovered,
    repoRoot: record.repoRoot,
    projectRelativePath: record.projectRelativePath,
    baselineCommit: record.baselineCommit,
    baselineTree: record.baselineTree,
    workers: record.workers.map((worker) => ({
      workerId: worker.workerId,
      role: worker.role,
      worktreePath: worker.taskWorktreePath,
      repoWorktreePath: worker.repoWorktreePath,
    })),
  };
}

export async function prepareProjectWorkerGroup(request: PrepareProjectWorkerGroupRequest): Promise<Record<string, unknown>> {
  try {
    const projectId = safeId(request.projectId, 'projectId');
    const workItemId = safeId(request.workItemId, 'workItemId');
    const executionEpoch = Math.max(1, Math.trunc(Number(request.executionEpoch) || 0));
    const projectDir = path.resolve(String(request.projectDir || ''));
    if (!path.isAbsolute(projectDir) || !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      return { ok: false, error: '多任务 AI 的项目目录必须是存在的绝对目录' };
    }
    const assignments = Array.isArray(request.assignments) ? request.assignments : [];
    if (assignments.length < 2 || assignments.length > 3) {
      return { ok: false, error: '多任务 AI 必须包含 2-3 个任务 AI' };
    }
    assignments.forEach((assignment) => safeId(assignment.workerId, 'workerId'));
    const groupDir = groupDirectory({ projectId, workItemId, executionEpoch });
    const existingMetadata = metadataPath(groupDir);
    if (fs.existsSync(existingMetadata)) {
      const record = readGroupRecord({ projectId, workItemId, executionEpoch }).record;
      if (path.resolve(record.projectDir) !== projectDir
        || record.workers.length !== assignments.length
        || record.workers.some((worker) => {
          const assignment = assignments.find((candidate) => candidate.workerId === worker.workerId);
          return !assignment
            || assignment.role !== worker.role
            || JSON.stringify(assignment.writeClaims) !== JSON.stringify(worker.writeClaims);
        })) {
        return { ok: false, error: '已有多任务 AI 隔离环境与当前项目路径或分工不一致，拒绝复用' };
      }
      const current = await captureTree(record.repoRoot, record.projectRelativePath);
      if (current.tree !== record.baselineTree) {
        return { ok: false, error: '用户项目目录已偏离该多任务 AI 的原始基线；拒绝自动恢复旧 worker，请重新规划或人工合并' };
      }
      for (const worker of record.workers) {
        if (fs.existsSync(worker.repoWorktreePath)) {
          if (!fs.existsSync(path.join(worker.repoWorktreePath, '.git'))) {
            return { ok: false, error: `任务 AI ${worker.workerId} 的 worktree 路径被其他内容占用，拒绝覆盖` };
          }
          continue;
        }
        await git(record.repoRoot, ['worktree', 'add', '--detach', worker.repoWorktreePath, record.baselineCommit]);
      }
      return publicGroupResult(record, true);
    }
    if (fs.existsSync(groupDir)) {
      return { ok: false, error: '多任务 AI 运行目录已存在但缺少完整元数据；为避免覆盖未知工作，已停止自动恢复' };
    }

    const repoRoot = path.resolve(await git(projectDir, ['rev-parse', '--show-toplevel']));
    if (!pathInside(repoRoot, projectDir)) return { ok: false, error: '项目目录不在 Git 仓库根目录内' };
    const projectRelativePath = path.relative(repoRoot, projectDir).replace(/\\/gu, '/') || '.';
    const baseline = await captureTree(repoRoot, projectRelativePath);
    const baselineCommit = await withTemporaryIndex(repoRoot, async (env) => git(repoRoot, [
      'commit-tree', baseline.tree, '-p', baseline.parent,
      '-m', `wmux worker-group baseline ${projectId}/${workItemId} epoch ${executionEpoch}`,
    ], { env }));

    fs.mkdirSync(runtimeRoot(), { recursive: true });
    fs.mkdirSync(groupDir, { recursive: false });
    const workers: WorkerWorktreeRecord[] = assignments.map((assignment) => {
      const workerId = safeId(assignment.workerId, 'workerId');
      const repoWorktreePath = path.join(groupDir, `worker-${workerId}`);
      const taskWorktreePath = projectRelativePath === '.'
        ? repoWorktreePath
        : path.join(repoWorktreePath, ...projectRelativePath.split('/'));
      return {
        workerId,
        role: assignment.role,
        repoWorktreePath,
        taskWorktreePath,
        writeClaims: assignment.writeClaims,
      };
    });
    const record: WorkerGroupRecord = {
      version: 1,
      projectId,
      workItemId,
      executionEpoch,
      projectDir,
      repoRoot,
      projectRelativePath,
      baselineCommit,
      baselineTree: baseline.tree,
      workers,
      createdAt: Date.now(),
    };
    fs.writeFileSync(existingMetadata, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    for (const worker of workers) {
      await git(repoRoot, ['worktree', 'add', '--detach', worker.repoWorktreePath, baselineCommit]);
    }
    return publicGroupResult(record, false);
  } catch (error) {
    return { ok: false, error: `创建多任务 AI 隔离环境失败：${String((error as Error)?.message || error)}` };
  }
}

function claimContains(claim: string, changedFile: string): boolean {
  const normalizedClaim = claim.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/$/u, '').toLowerCase();
  const normalizedFile = changedFile.replace(/\\/gu, '/').replace(/^\.\//u, '').toLowerCase();
  return normalizedFile === normalizedClaim || normalizedFile.startsWith(`${normalizedClaim}/`);
}

export async function submitProjectMergeCandidate(request: SubmitProjectMergeCandidateRequest): Promise<Record<string, unknown>> {
  try {
    const { groupDir, record } = readGroupRecord(request);
    const workerId = safeId(request.workerId, 'workerId');
    const worker = record.workers.find((candidate) => candidate.workerId === workerId);
    if (!worker) return { ok: false, error: '当前执行轮次不存在该任务 AI' };
    const pathspec = record.projectRelativePath === '.' ? '.' : record.projectRelativePath;
    const tempExclusion = record.projectRelativePath === '.'
      ? ':(exclude).wmux/tmp'
      : `:(exclude)${record.projectRelativePath}/.wmux/tmp`;
    const changedFiles = await withTemporaryIndex(record.repoRoot, async (env) => {
      await git(worker.repoWorktreePath, ['read-tree', record.baselineCommit], { env });
      await git(worker.repoWorktreePath, ['add', '-A', '--', pathspec, tempExclusion], { env });
      const names = await git(worker.repoWorktreePath, [
        'diff', '--cached', '--name-only', '--diff-filter=ACDMRTUXB', record.baselineCommit, '--', pathspec,
      ], { env });
      return names.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
    });
    if (changedFiles.length === 0) return { ok: false, error: '任务 AI 没有可提交的文件变更' };
    const projectFiles = changedFiles.map((file) => (
      record.projectRelativePath === '.' ? file : path.posix.relative(record.projectRelativePath, file)
    ));
    const outOfScope = projectFiles.find((file) => file.startsWith('..') || !worker.writeClaims.some((claim) => claimContains(claim, file)));
    if (outOfScope) return { ok: false, error: `任务 AI 修改超出 writeClaims：${outOfScope}` };
    const patchText = await withTemporaryIndex(record.repoRoot, async (env) => {
      await git(worker.repoWorktreePath, ['read-tree', record.baselineCommit], { env });
      await git(worker.repoWorktreePath, ['add', '-A', '--', pathspec, tempExclusion], { env });
      return git(worker.repoWorktreePath, [
        'diff', '--cached', '--binary', '--full-index', record.baselineCommit, '--', pathspec,
      ], { env, maxBuffer: 128 * 1024 * 1024, raw: true });
    });
    const patchHash = crypto.createHash('sha256').update(patchText).digest('hex');
    const candidateId = `${workerId}-a${Math.max(1, Math.trunc(request.assignmentVersion || 1))}-${patchHash.slice(0, 12)}`;
    const filePath = candidatePath(groupDir, candidateId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, `${patchText}\n`, 'utf8');
    return {
      ok: true,
      candidateId,
      workerId,
      assignmentVersion: Math.max(1, Math.trunc(request.assignmentVersion || 1)),
      baselineCommit: record.baselineCommit,
      patchHash,
      changedFiles: projectFiles,
      evidence: Array.isArray(request.evidence) ? request.evidence.slice(0, 20) : [],
    };
  } catch (error) {
    return { ok: false, error: `提交集成候选失败：${String((error as Error)?.message || error)}` };
  }
}

export async function applyProjectMergeCandidate(request: ApplyProjectMergeCandidateRequest): Promise<Record<string, unknown>> {
  try {
    const { groupDir, record } = readGroupRecord(request);
    const filePath = candidatePath(groupDir, request.candidateId);
    if (!fs.existsSync(filePath)) return { ok: false, error: '集成候选不存在或不属于当前执行轮次' };
    const integrator = record.workers.find((worker) => worker.role === 'integrator');
    if (!integrator) return { ok: false, error: '多任务 AI 运行时缺少主任务 AI' };
    await git(integrator.repoWorktreePath, ['apply', '--check', '--whitespace=nowarn', filePath]);
    await git(integrator.repoWorktreePath, ['apply', '--whitespace=nowarn', filePath]);
    return { ok: true, candidateId: request.candidateId, integrationWorktreePath: integrator.taskWorktreePath };
  } catch (error) {
    return { ok: false, error: `应用集成候选失败：${String((error as Error)?.message || error)}` };
  }
}

export async function finalizeProjectWorkerGroup(request: FinalizeProjectWorkerGroupRequest): Promise<Record<string, unknown>> {
  try {
    const { groupDir, record } = readGroupRecord(request);
    const current = await captureTree(record.repoRoot, record.projectRelativePath);
    if (current.tree !== record.baselineTree) {
      return { ok: false, error: '用户项目目录已在多任务 AI 执行期间发生变化；为避免覆盖，拒绝最终应用，请先重新基线或人工合并' };
    }
    const integrator = record.workers.find((worker) => worker.role === 'integrator');
    if (!integrator) return { ok: false, error: '多任务 AI 运行时缺少主任务 AI' };
    const pathspec = record.projectRelativePath === '.' ? '.' : record.projectRelativePath;
    const tempExclusion = record.projectRelativePath === '.'
      ? ':(exclude).wmux/tmp'
      : `:(exclude)${record.projectRelativePath}/.wmux/tmp`;
    const patchText = await withTemporaryIndex(record.repoRoot, async (env) => {
      await git(integrator.repoWorktreePath, ['read-tree', record.baselineCommit], { env });
      await git(integrator.repoWorktreePath, ['add', '-A', '--', pathspec, tempExclusion], { env });
      return git(integrator.repoWorktreePath, [
        'diff', '--cached', '--binary', '--full-index', record.baselineCommit, '--', pathspec,
      ], { env, maxBuffer: 128 * 1024 * 1024, raw: true });
    });
    if (!patchText.trim()) return { ok: false, error: '集成 worktree 没有可应用的最终变更' };
    const finalPatchPath = path.join(groupDir, 'final.patch');
    fs.writeFileSync(finalPatchPath, `${patchText}\n`, 'utf8');
    await git(record.repoRoot, ['apply', '--check', '--whitespace=nowarn', finalPatchPath]);
    await git(record.repoRoot, ['apply', '--whitespace=nowarn', finalPatchPath]);
    return {
      ok: true,
      changed: true,
      patchHash: crypto.createHash('sha256').update(patchText).digest('hex'),
    };
  } catch (error) {
    return { ok: false, error: `最终应用多任务 AI 结果失败：${String((error as Error)?.message || error)}` };
  }
}
