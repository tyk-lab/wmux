import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const testRuntime = vi.hoisted(() => ({ appDataDir: '' }));

vi.mock('../../src/shared/instance', () => ({
  getAppDataDir: () => testRuntime.appDataDir,
}));

import {
  applyProjectMergeCandidate,
  finalizeProjectWorkerGroup,
  prepareProjectWorkerGroup,
  submitProjectMergeCandidate,
} from '../../src/main/project-worker-worktrees';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

describe('project worker Git worktrees', () => {
  let tempRoot = '';
  let repoRoot = '';

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-worker-test-'));
    testRuntime.appDataDir = path.join(tempRoot, 'appdata');
    repoRoot = path.join(tempRoot, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'base.txt'), 'base\n', 'utf8');
    git(repoRoot, ['init']);
    git(repoRoot, ['config', 'user.name', 'wmux test']);
    git(repoRoot, ['config', 'user.email', 'wmux-test@localhost']);
    git(repoRoot, ['config', 'core.autocrlf', 'false']);
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'base']);
    fs.writeFileSync(path.join(repoRoot, 'src', 'dirty.txt'), 'dirty baseline\n', 'utf8');
  });

  afterAll(() => {
    if (tempRoot && fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('captures dirty baseline, isolates writes, merges candidates, and applies only without baseline drift', async () => {
    const assignments = [
      {
        workerId: 'worker-main', role: 'integrator' as const, outcome: 'integrate', dependencies: ['worker-tests'],
        writeClaims: ['src'], resourceClaims: [], validation: ['test'],
      },
      {
        workerId: 'worker-tests', role: 'worker' as const, outcome: 'tests', dependencies: [],
        writeClaims: ['tests'], resourceClaims: [], validation: ['test'],
      },
    ];
    const prepared = await prepareProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1, projectDir: repoRoot, assignments,
    }) as any;
    expect(prepared.ok).toBe(true);
    expect(prepared.workers).toHaveLength(2);
    const recovered = await prepareProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1, projectDir: repoRoot, assignments,
    }) as any;
    expect(recovered).toMatchObject({ ok: true, recovered: true, baselineCommit: prepared.baselineCommit });
    const integrator = prepared.workers.find((worker: any) => worker.workerId === 'worker-main');
    const testsWorker = prepared.workers.find((worker: any) => worker.workerId === 'worker-tests');
    expect(fs.readFileSync(path.join(integrator.worktreePath, 'src', 'dirty.txt'), 'utf8')).toBe('dirty baseline\n');

    fs.mkdirSync(path.join(testsWorker.worktreePath, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(testsWorker.worktreePath, 'tests', 'new.test.txt'), 'worker result\n', 'utf8');
    const submitted = await submitProjectMergeCandidate({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      workerId: 'worker-tests', assignmentVersion: 1, evidence: ['focused test passed'],
    }) as any;
    expect(submitted.ok).toBe(true);
    expect(submitted.changedFiles).toEqual(['tests/new.test.txt']);

    const applied = await applyProjectMergeCandidate({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      candidateId: submitted.candidateId,
    }) as any;
    expect(applied.ok).toBe(true);
    expect(fs.readFileSync(path.join(integrator.worktreePath, 'tests', 'new.test.txt'), 'utf8')).toBe('worker result\n');

    fs.writeFileSync(path.join(integrator.worktreePath, 'src', 'integrated.txt'), 'integrated\n', 'utf8');
    const finalized = await finalizeProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
    }) as any;
    expect(finalized.ok).toBe(true);
    expect(fs.readFileSync(path.join(repoRoot, 'tests', 'new.test.txt'), 'utf8')).toBe('worker result\n');
    expect(fs.readFileSync(path.join(repoRoot, 'src', 'integrated.txt'), 'utf8')).toBe('integrated\n');
    expect(fs.readFileSync(path.join(repoRoot, 'src', 'dirty.txt'), 'utf8')).toBe('dirty baseline\n');
  });
});
