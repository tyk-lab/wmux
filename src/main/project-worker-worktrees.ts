import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { getAppDataDir } from '../shared/instance';
import {
  normalizeProjectWorkerAssignments,
  projectWorkerAssignmentsViolation,
  type ProjectWorkerAssignment,
} from '../shared/project-manager';

const execFileAsync = promisify(execFile);
const WORKTREE_ROOT_DIRECTORY = 'project-worker-worktrees';
const workerGroupOperationLocks = new Map<string, Promise<void>>();

interface WorkerWorktreeRecord {
  workerId: string;
  role: ProjectWorkerAssignment['role'];
  repoWorktreePath: string;
  taskWorktreePath: string;
  writeClaims: string[];
  appliedTree?: string;
  appliedCandidateId?: string;
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
  baselineScopeTree?: string;
  lastFinalPatchHash?: string;
  workers: WorkerWorktreeRecord[];
  createdAt: number;
}

interface WorkerMergeCandidateRecord {
  version: 1;
  candidateId: string;
  workerId: string;
  assignmentVersion: number;
  directiveEpoch: number;
  baseTree: string;
  targetTree: string;
  patchHash: string;
  changedFiles: string[];
  createdAt: number;
}

type AuthoritativeWorker = Pick<ProjectWorkerAssignment, 'workerId' | 'role' | 'writeClaims'>;
type RevisionVerifier = () => boolean | Promise<boolean>;

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
  projectDir: string;
  workerId: string;
  assignmentVersion: number;
  directiveEpoch: number;
  evidence?: string[];
  authoritativeWorker?: AuthoritativeWorker;
}

export interface ApplyProjectMergeCandidateRequest {
  projectId: string;
  workItemId: string;
  executionEpoch: number;
  projectDir: string;
  candidateId: string;
  workerId: string;
  expectedPatchHash: string;
  expectedChangedFiles: string[];
  authoritativeWorkers?: AuthoritativeWorker[];
  verifyCurrentRevision?: RevisionVerifier;
}

export interface FinalizeProjectWorkerGroupRequest {
  projectId: string;
  workItemId: string;
  executionEpoch: number;
  projectDir: string;
  authoritativeWorkers?: AuthoritativeWorker[];
  verifyCurrentRevision?: RevisionVerifier;
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
  const key = crypto.createHash('sha256').update(`${projectId}\0${workItemId}\0${epoch}`).digest('hex').slice(0, 20);
  return path.join(runtimeRoot(), `${projectId.slice(0, 16)}--${workItemId.slice(0, 16)}--e${epoch}--${key}`);
}

function legacyGroupDirectory(request: Pick<PrepareProjectWorkerGroupRequest, 'projectId' | 'workItemId' | 'executionEpoch'>): string {
  const projectId = safeId(request.projectId, 'projectId');
  const workItemId = safeId(request.workItemId, 'workItemId');
  const epoch = Math.max(1, Math.trunc(Number(request.executionEpoch) || 0));
  return path.join(runtimeRoot(), `${projectId}--${workItemId}--e${epoch}`);
}

function existingGroupDirectory(
  request: Pick<PrepareProjectWorkerGroupRequest, 'projectId' | 'workItemId' | 'executionEpoch'>,
): string | undefined {
  return [groupDirectory(request), legacyGroupDirectory(request)]
    .find((candidate) => fs.existsSync(metadataPath(candidate)));
}

function metadataPath(groupDir: string): string {
  return path.join(groupDir, 'worker-group.json');
}

function candidatePath(groupDir: string, candidateId: string): string {
  return path.join(groupDir, 'candidates', `${safeId(candidateId, 'candidateId')}.patch`);
}

function candidateRecordPath(groupDir: string, candidateId: string): string {
  return path.join(groupDir, 'candidates', `${safeId(candidateId, 'candidateId')}.json`);
}

function pathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realPathInside(parent: string, child: string): boolean {
  if (!fs.existsSync(parent) || !fs.existsSync(child)) return pathInside(parent, child);
  return pathInside(fs.realpathSync.native(parent), fs.realpathSync.native(child));
}

function sameAuthoritativeWorkers(record: WorkerGroupRecord, expected: readonly AuthoritativeWorker[]): boolean {
  if (record.workers.length !== expected.length) return false;
  return record.workers.every((worker) => {
    const authoritative = expected.find((candidate) => candidate.workerId === worker.workerId);
    return !!authoritative
      && authoritative.role === worker.role
      && JSON.stringify(authoritative.writeClaims) === JSON.stringify(worker.writeClaims);
  });
}

async function withWorkerGroupOperationLock<T>(
  request: Pick<PrepareProjectWorkerGroupRequest, 'projectId' | 'workItemId' | 'executionEpoch'>,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${request.projectId}\0${request.workItemId}\0${request.executionEpoch}`;
  const previous = workerGroupOperationLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  workerGroupOperationLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (workerGroupOperationLocks.get(key) === queued) workerGroupOperationLocks.delete(key);
  }
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

async function scopeTree(repoRoot: string, tree: string, projectRelativePath: string): Promise<string> {
  return projectRelativePath === '.'
    ? tree
    : git(repoRoot, ['rev-parse', `${tree}:${projectRelativePath}`]);
}

async function captureTree(repoRoot: string, projectRelativePath: string): Promise<{
  parent: string;
  tree: string;
  scopeTree: string;
}> {
  const parent = await git(repoRoot, ['rev-parse', 'HEAD']);
  return withTemporaryIndex(repoRoot, async (env) => {
    await git(repoRoot, ['read-tree', parent], { env });
    const pathspec = projectRelativePath === '.' ? '.' : projectRelativePath;
    const tempExclusion = projectRelativePath === '.'
      ? ':(exclude).wmux/tmp'
      : `:(exclude)${projectRelativePath}/.wmux/tmp`;
    await git(repoRoot, ['add', '-A', '--', pathspec, tempExclusion], { env });
    const tree = await git(repoRoot, ['write-tree'], { env });
    return { parent, tree, scopeTree: await scopeTree(repoRoot, tree, projectRelativePath) };
  });
}

function writeGroupRecord(groupDir: string, record: WorkerGroupRecord): void {
  fs.writeFileSync(metadataPath(groupDir), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function readCandidateRecord(groupDir: string, candidateId: string): WorkerMergeCandidateRecord {
  const filePath = candidateRecordPath(groupDir, candidateId);
  if (!fs.existsSync(filePath)) throw new Error('集成候选缺少增量基线元数据，请由任务 AI 重新提交候选');
  const candidate = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WorkerMergeCandidateRecord;
  if (candidate.version !== 1 || candidate.candidateId !== candidateId) {
    throw new Error('集成候选元数据无效或与请求不匹配');
  }
  return candidate;
}

async function persistAppliedWorkerSnapshot(
  record: WorkerGroupRecord,
  worker: WorkerWorktreeRecord,
  targetTree: string,
): Promise<string> {
  const snapshotCommit = await withTemporaryIndex(record.repoRoot, (env) => git(record.repoRoot, [
    'commit-tree', targetTree, '-p', record.baselineCommit,
    '-m', `wmux applied worker snapshot ${record.projectId}/${record.workItemId}/${worker.workerId}`,
  ], { env }));
  const refKey = crypto.createHash('sha256').update([
    record.projectId,
    record.workItemId,
    record.executionEpoch,
    worker.workerId,
  ].join('\0')).digest('hex');
  await git(record.repoRoot, [
    'update-ref', `refs/wmux/project-worker-snapshots/${refKey}`, snapshotCommit,
  ]);
  return snapshotCommit;
}

async function advanceWorkerGroupBaseline(
  groupDir: string,
  record: WorkerGroupRecord,
  tree: string,
  scopedTree: string,
  patchHash: string,
): Promise<void> {
  const baselineCommit = await withTemporaryIndex(record.repoRoot, (env) => git(record.repoRoot, [
    'commit-tree', tree, '-p', record.baselineCommit,
    '-m', `wmux finalized worker-group baseline ${record.projectId}/${record.workItemId}`,
  ], { env }));
  const refKey = crypto.createHash('sha256').update([
    record.projectId,
    record.workItemId,
    record.executionEpoch,
  ].join('\0')).digest('hex');
  await git(record.repoRoot, [
    'update-ref', `refs/wmux/project-worker-baselines/${refKey}`, baselineCommit,
  ]);
  record.baselineCommit = baselineCommit;
  record.baselineTree = tree;
  record.baselineScopeTree = scopedTree;
  record.lastFinalPatchHash = patchHash;
  writeGroupRecord(groupDir, record);
}

function readGroupRecord(request: Pick<PrepareProjectWorkerGroupRequest, 'projectId' | 'workItemId' | 'executionEpoch'>): {
  groupDir: string;
  record: WorkerGroupRecord;
} {
  const groupDir = existingGroupDirectory(request) || groupDirectory(request);
  const filePath = metadataPath(groupDir);
  if (!fs.existsSync(filePath)) throw new Error('多任务 AI 隔离环境尚未创建或元数据不完整');
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WorkerGroupRecord;
  if (record.version !== 1
    || record.projectId !== request.projectId
    || record.workItemId !== request.workItemId
    || record.executionEpoch !== Math.trunc(Number(request.executionEpoch))) {
    throw new Error('多任务 AI 隔离环境与当前执行轮次不匹配');
  }
  const expectedProjectDir = 'projectDir' in request ? path.resolve(String(request.projectDir || '')) : undefined;
  if (!path.isAbsolute(record.projectDir)
    || !path.isAbsolute(record.repoRoot)
    || !realPathInside(record.repoRoot, record.projectDir)
    || (expectedProjectDir && path.resolve(record.projectDir) !== expectedProjectDir)
    || !Array.isArray(record.workers)
    || record.workers.some((worker) => (
      !realPathInside(groupDir, worker.repoWorktreePath)
      || !realPathInside(worker.repoWorktreePath, worker.taskWorktreePath)
    ))) {
    throw new Error('多任务 AI 隔离元数据的项目或 worktree 路径无效');
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

async function prepareProjectWorkerGroupUnlocked(request: PrepareProjectWorkerGroupRequest): Promise<Record<string, unknown>> {
  try {
    const projectId = safeId(request.projectId, 'projectId');
    const workItemId = safeId(request.workItemId, 'workItemId');
    const executionEpoch = Math.max(1, Math.trunc(Number(request.executionEpoch) || 0));
    const projectDir = path.resolve(String(request.projectDir || ''));
    if (!path.isAbsolute(projectDir) || !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      return { ok: false, error: '多任务 AI 的项目目录必须是存在的绝对目录' };
    }
    const rawAssignments = Array.isArray(request.assignments) ? request.assignments : [];
    const assignments = normalizeProjectWorkerAssignments(rawAssignments);
    const assignmentError = assignments.length !== rawAssignments.length
      ? '多任务 AI 分工包含无效或重复的 worker'
      : projectWorkerAssignmentsViolation(assignments);
    if (assignmentError) return { ok: false, error: assignmentError };
    assignments.forEach((assignment) => safeId(assignment.workerId, 'workerId'));
    const groupRequest = { projectId, workItemId, executionEpoch };
    const groupDir = existingGroupDirectory(groupRequest) || groupDirectory(groupRequest);
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
      const baselineScopeTree = record.baselineScopeTree
        || await scopeTree(record.repoRoot, record.baselineTree, record.projectRelativePath);
      if (current.scopeTree !== baselineScopeTree) {
        return { ok: false, error: '用户项目目录已偏离该多任务 AI 的原始基线；拒绝自动恢复旧 worker，请重新规划或人工合并' };
      }
      let recordUpdated = false;
      for (const worker of record.workers) {
        if (fs.existsSync(worker.repoWorktreePath)) {
          if (!fs.existsSync(path.join(worker.repoWorktreePath, '.git'))) {
            return { ok: false, error: `任务 AI ${worker.workerId} 的 worktree 路径被其他内容占用，拒绝覆盖` };
          }
          continue;
        }
        let recoveryCommit = worker.appliedTree || record.baselineCommit;
        if (worker.appliedTree && await git(record.repoRoot, ['cat-file', '-t', worker.appliedTree]) === 'tree') {
          recoveryCommit = await persistAppliedWorkerSnapshot(record, worker, worker.appliedTree);
          worker.appliedTree = recoveryCommit;
          recordUpdated = true;
        }
        await git(record.repoRoot, ['worktree', 'add', '--detach', worker.repoWorktreePath, recoveryCommit]);
      }
      if (recordUpdated) writeGroupRecord(groupDir, record);
      return publicGroupResult(record, true);
    }
    if (fs.existsSync(groupDir)
      || fs.existsSync(legacyGroupDirectory(groupRequest))) {
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
      const workerKey = crypto.createHash('sha256').update(workerId).digest('hex').slice(0, 12);
      const repoWorktreePath = path.join(groupDir, `worker-${workerId.slice(0, 20)}-${workerKey}`);
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
      baselineScopeTree: baseline.scopeTree,
      workers,
      createdAt: Date.now(),
    };
    writeGroupRecord(groupDir, record);
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

async function submitProjectMergeCandidateUnlocked(request: SubmitProjectMergeCandidateRequest): Promise<Record<string, unknown>> {
  try {
    const { groupDir, record } = readGroupRecord(request);
    const workerId = safeId(request.workerId, 'workerId');
    const worker = record.workers.find((candidate) => candidate.workerId === workerId);
    if (!worker) return { ok: false, error: '当前执行轮次不存在该任务 AI' };
    if (request.authoritativeWorker && (
      request.authoritativeWorker.workerId !== worker.workerId
      || request.authoritativeWorker.role !== worker.role
      || JSON.stringify(request.authoritativeWorker.writeClaims) !== JSON.stringify(worker.writeClaims)
    )) {
      return { ok: false, error: '任务 AI 隔离元数据与持久化 writeClaims 不一致，拒绝生成候选' };
    }
    const pathspec = record.projectRelativePath === '.' ? '.' : record.projectRelativePath;
    const tempExclusion = record.projectRelativePath === '.'
      ? ':(exclude).wmux/tmp'
      : `:(exclude)${record.projectRelativePath}/.wmux/tmp`;
    const baseTree = worker.appliedTree || record.baselineTree;
    const captured = await withTemporaryIndex(record.repoRoot, async (env) => {
      await git(worker.repoWorktreePath, ['read-tree', baseTree], { env });
      await git(worker.repoWorktreePath, ['add', '-A', '--', pathspec, tempExclusion], { env });
      const targetTree = await git(worker.repoWorktreePath, ['write-tree'], { env });
      const names = await git(worker.repoWorktreePath, [
        'diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB', baseTree, targetTree, '--', pathspec,
      ], { env, raw: true });
      const patchText = await git(worker.repoWorktreePath, [
        'diff', '--binary', '--full-index', baseTree, targetTree, '--', pathspec,
      ], { env, maxBuffer: 128 * 1024 * 1024, raw: true });
      return {
        targetTree,
        changedFiles: names.split('\0').filter(Boolean),
        patchText,
      };
    });
    const { changedFiles, patchText, targetTree } = captured;
    const projectFiles = changedFiles.map((file) => (
      record.projectRelativePath === '.' ? file : path.posix.relative(record.projectRelativePath, file)
    ));
    const outOfScope = projectFiles.find((file) => file.startsWith('..') || !worker.writeClaims.some((claim) => claimContains(claim, file)));
    if (outOfScope) return { ok: false, error: `任务 AI 修改超出 writeClaims：${outOfScope}` };
    const patchHash = crypto.createHash('sha256').update(patchText).digest('hex');
    const assignmentVersion = Math.max(1, Math.trunc(request.assignmentVersion || 1));
    const directiveEpoch = Math.max(0, Math.trunc(request.directiveEpoch || 0));
    const candidateId = `${workerId.slice(0, 40)}-a${assignmentVersion}-${patchHash.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`;
    const filePath = candidatePath(groupDir, candidateId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, patchText, 'utf8');
    const candidateRecord: WorkerMergeCandidateRecord = {
      version: 1,
      candidateId,
      workerId,
      assignmentVersion,
      directiveEpoch,
      baseTree,
      targetTree,
      patchHash,
      changedFiles: projectFiles,
      createdAt: Date.now(),
    };
    fs.writeFileSync(candidateRecordPath(groupDir, candidateId), `${JSON.stringify(candidateRecord, null, 2)}\n`, 'utf8');
    return {
      ok: true,
      candidateId,
      workerId,
      assignmentVersion,
      directiveEpoch,
      baselineCommit: record.baselineCommit,
      patchHash,
      changedFiles: projectFiles,
      evidence: Array.isArray(request.evidence) ? request.evidence.slice(0, 20) : [],
    };
  } catch (error) {
    return { ok: false, error: `提交集成候选失败：${String((error as Error)?.message || error)}` };
  }
}

async function applyProjectMergeCandidateUnlocked(request: ApplyProjectMergeCandidateRequest): Promise<Record<string, unknown>> {
  try {
    const { groupDir, record } = readGroupRecord(request);
    if (request.authoritativeWorkers && !sameAuthoritativeWorkers(record, request.authoritativeWorkers)) {
      return { ok: false, error: '多任务 AI 隔离元数据与持久化分工不一致，拒绝应用候选' };
    }
    const filePath = candidatePath(groupDir, request.candidateId);
    if (!fs.existsSync(filePath)) return { ok: false, error: '集成候选不存在或不属于当前执行轮次' };
    const candidate = readCandidateRecord(groupDir, request.candidateId);
    const expectedChangedFiles = Array.isArray(request.expectedChangedFiles) ? request.expectedChangedFiles : [];
    if (candidate.workerId !== request.workerId
      || candidate.patchHash !== request.expectedPatchHash
      || JSON.stringify(candidate.changedFiles) !== JSON.stringify(expectedChangedFiles)) {
      return { ok: false, error: '集成候选元数据与持久化审计记录不一致' };
    }
    const candidateWorker = record.workers.find((worker) => worker.workerId === candidate.workerId);
    if (!candidateWorker) return { ok: false, error: '集成候选所属任务 AI 不存在于当前执行轮次' };
    const integrator = record.workers.find((worker) => worker.role === 'integrator');
    if (!integrator) return { ok: false, error: '多任务 AI 运行时缺少主任务 AI' };
    if (candidateWorker.appliedCandidateId === candidate.candidateId) {
      return {
        ok: true,
        alreadyApplied: true,
        candidateId: request.candidateId,
        integrationWorktreePath: integrator.taskWorktreePath,
      };
    }
    const expectedBaseTree = candidateWorker.appliedTree || record.baselineTree;
    if (candidate.baseTree !== expectedBaseTree) {
      return { ok: false, error: '集成候选基于过期的 worker 合并状态，请重新提交当前候选' };
    }
    const patchText = fs.readFileSync(filePath, 'utf8');
    if (crypto.createHash('sha256').update(patchText).digest('hex') !== candidate.patchHash) {
      return { ok: false, error: '集成候选补丁内容与提交时哈希不一致' };
    }
    if (!patchText.trim()) {
      return { ok: false, error: '空候选必须由集成者明确拒绝，不能作为已应用变更处理' };
    }
    const verifiedTree = await withTemporaryIndex(record.repoRoot, async (env) => {
      await git(record.repoRoot, ['read-tree', candidate.baseTree], { env });
      await git(record.repoRoot, ['apply', '--cached', '--whitespace=nowarn', filePath], { env });
      return git(record.repoRoot, ['write-tree'], { env });
    });
    if (verifiedTree !== candidate.targetTree) {
      return { ok: false, error: '集成候选补丁无法重建提交时的目标树' };
    }
    if (request.verifyCurrentRevision && !await request.verifyCurrentRevision()) {
      return { ok: false, error: '候选检查期间项目状态已经变化，拒绝应用过期候选' };
    }
    let alreadyApplied = false;
    try {
      await git(integrator.repoWorktreePath, ['apply', '--check', '--whitespace=nowarn', filePath]);
      await git(integrator.repoWorktreePath, ['apply', '--whitespace=nowarn', filePath]);
    } catch (applyError) {
      try {
        await git(integrator.repoWorktreePath, ['apply', '--reverse', '--check', '--whitespace=nowarn', filePath]);
        alreadyApplied = true;
      } catch {
        throw applyError;
      }
    }
    for (const recipient of record.workers) {
      if (recipient.workerId === candidateWorker.workerId || recipient.role === 'integrator') continue;
      const recipientBaseTree = recipient.appliedTree || record.baselineTree;
      const recipientTargetTree = await withTemporaryIndex(record.repoRoot, async (env) => {
        await git(record.repoRoot, ['read-tree', recipientBaseTree], { env });
        await git(record.repoRoot, ['apply', '--cached', '--whitespace=nowarn', filePath], { env });
        return git(record.repoRoot, ['write-tree'], { env });
      });
      try {
        await git(recipient.repoWorktreePath, ['apply', '--check', '--whitespace=nowarn', filePath]);
        await git(recipient.repoWorktreePath, ['apply', '--whitespace=nowarn', filePath]);
      } catch (recipientApplyError) {
        try {
          await git(recipient.repoWorktreePath, ['apply', '--reverse', '--check', '--whitespace=nowarn', filePath]);
        } catch {
          throw recipientApplyError;
        }
      }
      recipient.appliedTree = await persistAppliedWorkerSnapshot(record, recipient, recipientTargetTree);
    }
    candidateWorker.appliedTree = await persistAppliedWorkerSnapshot(record, candidateWorker, candidate.targetTree);
    candidateWorker.appliedCandidateId = candidate.candidateId;
    writeGroupRecord(groupDir, record);
    return {
      ok: true,
      alreadyApplied,
      candidateId: request.candidateId,
      integrationWorktreePath: integrator.taskWorktreePath,
    };
  } catch (error) {
    return { ok: false, error: `应用集成候选失败：${String((error as Error)?.message || error)}` };
  }
}

async function finalizeProjectWorkerGroupUnlocked(request: FinalizeProjectWorkerGroupRequest): Promise<Record<string, unknown>> {
  try {
    const { groupDir, record } = readGroupRecord(request);
    if (request.authoritativeWorkers && !sameAuthoritativeWorkers(record, request.authoritativeWorkers)) {
      return { ok: false, error: '多任务 AI 隔离元数据与持久化分工不一致，拒绝最终应用' };
    }
    const integrator = record.workers.find((worker) => worker.role === 'integrator');
    if (!integrator) return { ok: false, error: '多任务 AI 运行时缺少主任务 AI' };
    const pathspec = record.projectRelativePath === '.' ? '.' : record.projectRelativePath;
    const tempExclusion = record.projectRelativePath === '.'
      ? ':(exclude).wmux/tmp'
      : `:(exclude)${record.projectRelativePath}/.wmux/tmp`;
    const integrated = await withTemporaryIndex(record.repoRoot, async (env) => {
      await git(integrator.repoWorktreePath, ['read-tree', record.baselineTree], { env });
      await git(integrator.repoWorktreePath, ['add', '-A', '--', pathspec, tempExclusion], { env });
      const tree = await git(integrator.repoWorktreePath, ['write-tree'], { env });
      const patchText = await git(integrator.repoWorktreePath, [
        'diff', '--binary', '--full-index', record.baselineTree, tree, '--', pathspec,
      ], { env, maxBuffer: 128 * 1024 * 1024, raw: true });
      const names = await git(integrator.repoWorktreePath, [
        'diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB', record.baselineTree, tree, '--', pathspec,
      ], { env, raw: true });
      return {
        tree,
        scopeTree: await scopeTree(record.repoRoot, tree, record.projectRelativePath),
        patchText,
        changedFiles: names.split('\0').filter(Boolean),
      };
    });
    const { patchText } = integrated;
    if (!patchText.trim()) {
      const current = await captureTree(record.repoRoot, record.projectRelativePath);
      const baselineScopeTree = record.baselineScopeTree
        || await scopeTree(record.repoRoot, record.baselineTree, record.projectRelativePath);
      return record.lastFinalPatchHash && current.scopeTree === baselineScopeTree
        ? { ok: true, changed: false, alreadyApplied: true, patchHash: record.lastFinalPatchHash }
        : { ok: false, error: '集成 worktree 没有可应用的最终变更' };
    }
    const projectFiles = integrated.changedFiles.map((file) => (
      record.projectRelativePath === '.' ? file : path.posix.relative(record.projectRelativePath, file)
    ));
    const ownershipWorkers = request.authoritativeWorkers || record.workers;
    const unownedFile = projectFiles.find((file) => (
      file.startsWith('..')
      || !ownershipWorkers.some((worker) => worker.writeClaims.some((claim) => claimContains(claim, file)))
    ));
    if (unownedFile) {
      return { ok: false, error: `集成结果包含不属于任何 worker writeClaims 的文件：${unownedFile}` };
    }
    for (const worker of ownershipWorkers) {
      if (worker.role === 'integrator' || worker.writeClaims.length === 0) continue;
      const runtimeWorker = record.workers.find((candidate) => candidate.workerId === worker.workerId);
      if (!runtimeWorker) return { ok: false, error: `持久化分工中的任务 AI ${worker.workerId} 缺少隔离运行时` };
      const expectedTree = runtimeWorker.appliedTree || record.baselineTree;
      const workerPathspecs = worker.writeClaims.map((claim) => (
        `:(icase,literal)${record.projectRelativePath === '.' ? claim : `${record.projectRelativePath}/${claim}`}`
      ));
      try {
        await git(record.repoRoot, ['diff', '--quiet', integrated.tree, expectedTree, '--', ...workerPathspecs]);
      } catch {
        return { ok: false, error: `集成者修改了任务 AI ${worker.workerId} writeClaims 内尚未由候选确认的内容` };
      }
    }
    const patchHash = crypto.createHash('sha256').update(patchText).digest('hex');
    const current = await captureTree(record.repoRoot, record.projectRelativePath);
    if (current.scopeTree === integrated.scopeTree) {
      await advanceWorkerGroupBaseline(
        groupDir,
        record,
        integrated.tree,
        integrated.scopeTree,
        patchHash,
      );
      return { ok: true, changed: false, alreadyApplied: true, patchHash };
    }
    const baselineScopeTree = record.baselineScopeTree
      || await scopeTree(record.repoRoot, record.baselineTree, record.projectRelativePath);
    if (current.scopeTree !== baselineScopeTree) {
      return { ok: false, error: '用户项目目录已在多任务 AI 执行期间发生变化；为避免覆盖，拒绝最终应用，请先重新基线或人工合并' };
    }
    const finalPatchPath = path.join(groupDir, 'final.patch');
    fs.writeFileSync(finalPatchPath, patchText, 'utf8');
    await git(record.repoRoot, ['apply', '--check', '--whitespace=nowarn', finalPatchPath]);
    if (request.verifyCurrentRevision && !await request.verifyCurrentRevision()) {
      return { ok: false, error: '最终检查期间项目状态已经变化，拒绝回填过期结果' };
    }
    await git(record.repoRoot, ['apply', '--whitespace=nowarn', finalPatchPath]);
    const applied = await captureTree(record.repoRoot, record.projectRelativePath);
    if (applied.scopeTree !== integrated.scopeTree) {
      return { ok: false, error: '最终补丁已经执行，但应用后的项目树与集成结果不一致；已停止自动完成并等待人工核对' };
    }
    await advanceWorkerGroupBaseline(
      groupDir,
      record,
      integrated.tree,
      integrated.scopeTree,
      patchHash,
    );
    return {
      ok: true,
      changed: true,
      patchHash,
    };
  } catch (error) {
    return { ok: false, error: `最终应用多任务 AI 结果失败：${String((error as Error)?.message || error)}` };
  }
}

export function prepareProjectWorkerGroup(request: PrepareProjectWorkerGroupRequest): Promise<Record<string, unknown>> {
  return withWorkerGroupOperationLock(request, () => prepareProjectWorkerGroupUnlocked(request));
}

export function submitProjectMergeCandidate(request: SubmitProjectMergeCandidateRequest): Promise<Record<string, unknown>> {
  return withWorkerGroupOperationLock(request, () => submitProjectMergeCandidateUnlocked(request));
}

export function applyProjectMergeCandidate(request: ApplyProjectMergeCandidateRequest): Promise<Record<string, unknown>> {
  return withWorkerGroupOperationLock(request, () => applyProjectMergeCandidateUnlocked(request));
}

export function finalizeProjectWorkerGroup(request: FinalizeProjectWorkerGroupRequest): Promise<Record<string, unknown>> {
  return withWorkerGroupOperationLock(request, () => finalizeProjectWorkerGroupUnlocked(request));
}
