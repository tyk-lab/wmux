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
  cleanupProjectWorkerGroup,
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
      {
        workerId: 'worker-docs', role: 'worker' as const, outcome: 'docs', dependencies: ['worker-tests'],
        writeClaims: ['docs'], resourceClaims: [], validation: ['review'],
      },
    ];
    const prepared = await prepareProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1, projectDir: repoRoot, assignments,
    }) as any;
    expect(prepared.ok).toBe(true);
    expect(prepared.workers).toHaveLength(3);
    const recovered = await prepareProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1, projectDir: repoRoot, assignments,
    }) as any;
    expect(recovered).toMatchObject({ ok: true, recovered: true, baselineCommit: prepared.baselineCommit });
    const integrator = prepared.workers.find((worker: any) => worker.workerId === 'worker-main');
    const testsWorker = prepared.workers.find((worker: any) => worker.workerId === 'worker-tests');
    const docsWorker = prepared.workers.find((worker: any) => worker.workerId === 'worker-docs');
    expect(fs.readFileSync(path.join(integrator.worktreePath, 'src', 'dirty.txt'), 'utf8')).toBe('dirty baseline\n');

    fs.mkdirSync(path.join(testsWorker.worktreePath, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(testsWorker.worktreePath, 'tests', 'new.test.txt'), 'worker result\n', 'utf8');
    fs.writeFileSync(path.join(testsWorker.worktreePath, 'tests', '中文 空格.txt'), 'unicode path\n', 'utf8');
    const submitted = await submitProjectMergeCandidate({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
      workerId: 'worker-tests', assignmentVersion: 1, directiveEpoch: 0, evidence: ['focused test passed'],
    }) as any;
    expect(submitted.ok).toBe(true);
    expect(submitted.changedFiles).toEqual(['tests/new.test.txt', 'tests/中文 空格.txt']);
    expect(await submitProjectMergeCandidate({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
      workerId: 'worker-tests', assignmentVersion: 1, directiveEpoch: 0,
      authoritativeWorker: { workerId: 'worker-tests', role: 'worker', writeClaims: ['src'] },
    })).toMatchObject({ ok: false });
    expect(await applyProjectMergeCandidate({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
      candidateId: submitted.candidateId,
      workerId: submitted.workerId,
      expectedPatchHash: submitted.patchHash,
      expectedChangedFiles: submitted.changedFiles,
      verifyCurrentRevision: () => false,
    })).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(integrator.worktreePath, 'tests', 'new.test.txt'))).toBe(false);
    const resubmitted = await submitProjectMergeCandidate({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
      workerId: 'worker-tests', assignmentVersion: 1, directiveEpoch: 0, evidence: ['same result resubmitted'],
    }) as any;
    expect(resubmitted.ok).toBe(true);
    expect(resubmitted.candidateId).not.toBe(submitted.candidateId);
    const workerRuntimeRoot = path.join(
      testRuntime.appDataDir,
      'supervisor',
      'runtime',
      'project-worker-worktrees',
    );
    const runtimeGroup = fs.readdirSync(workerRuntimeRoot).find((entry) => (
      fs.existsSync(path.join(workerRuntimeRoot, entry, 'candidates', `${resubmitted.candidateId}.patch`))
    ));
    expect(runtimeGroup).toBeTruthy();
    const candidatePatchPath = path.join(
      workerRuntimeRoot,
      runtimeGroup!,
      'candidates',
      `${resubmitted.candidateId}.patch`,
    );
    const originalPatch = fs.readFileSync(candidatePatchPath, 'utf8');
    fs.writeFileSync(candidatePatchPath, `${originalPatch}\n# tampered`, 'utf8');
    expect(await applyProjectMergeCandidate({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
      candidateId: resubmitted.candidateId,
      workerId: resubmitted.workerId,
      expectedPatchHash: resubmitted.patchHash,
      expectedChangedFiles: resubmitted.changedFiles,
    })).toMatchObject({ ok: false });
    fs.writeFileSync(candidatePatchPath, originalPatch, 'utf8');

    const applied = await applyProjectMergeCandidate({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
      candidateId: resubmitted.candidateId,
      workerId: resubmitted.workerId,
      expectedPatchHash: resubmitted.patchHash,
      expectedChangedFiles: resubmitted.changedFiles,
    }) as any;
    expect(applied.ok).toBe(true);
    expect(fs.readFileSync(path.join(integrator.worktreePath, 'tests', 'new.test.txt'), 'utf8')).toBe('worker result\n');
    expect(fs.readFileSync(path.join(docsWorker.worktreePath, 'tests', 'new.test.txt'), 'utf8')).toBe('worker result\n');
    const appliedAgain = await applyProjectMergeCandidate({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
      candidateId: resubmitted.candidateId,
      workerId: resubmitted.workerId,
      expectedPatchHash: resubmitted.patchHash,
      expectedChangedFiles: resubmitted.changedFiles,
    }) as any;
    expect(appliedAgain).toMatchObject({ ok: true, alreadyApplied: true });

    fs.writeFileSync(path.join(testsWorker.worktreePath, 'tests', 'new.test.txt'), 'worker result revised\n', 'utf8');
    const revised = await submitProjectMergeCandidate({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
      workerId: 'worker-tests', assignmentVersion: 1, directiveEpoch: 0, evidence: ['revision passed'],
    }) as any;
    expect(revised.changedFiles).toEqual(['tests/new.test.txt']);
    expect((await applyProjectMergeCandidate({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
      candidateId: revised.candidateId,
      workerId: revised.workerId,
      expectedPatchHash: revised.patchHash,
      expectedChangedFiles: revised.changedFiles,
    }) as any).ok).toBe(true);
    expect(fs.readFileSync(path.join(integrator.worktreePath, 'tests', 'new.test.txt'), 'utf8')).toBe('worker result revised\n');
    git(repoRoot, ['worktree', 'remove', '--force', testsWorker.repoWorktreePath]);
    const recoveredAfterLoss = await prepareProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1, projectDir: repoRoot, assignments,
    }) as any;
    expect(recoveredAfterLoss.ok).toBe(true);
    const restoredWorker = recoveredAfterLoss.workers.find((worker: any) => worker.workerId === 'worker-tests');
    expect(fs.readFileSync(path.join(restoredWorker.worktreePath, 'tests', 'new.test.txt'), 'utf8'))
      .toBe('worker result revised\n');

    fs.writeFileSync(path.join(integrator.worktreePath, 'tests', 'new.test.txt'), 'integrator override\n', 'utf8');
    expect(await finalizeProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
    })).toMatchObject({ ok: false });
    fs.writeFileSync(path.join(integrator.worktreePath, 'tests', 'new.test.txt'), 'worker result revised\n', 'utf8');
    const unownedPath = path.join(integrator.worktreePath, 'outside-claims.txt');
    fs.writeFileSync(unownedPath, 'out of scope\n', 'utf8');
    expect(await finalizeProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
    })).toMatchObject({ ok: false });
    fs.rmSync(unownedPath, { force: true });

    fs.writeFileSync(path.join(integrator.worktreePath, 'src', 'integrated.txt'), 'integrated\n', 'utf8');
    const finalized = await finalizeProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
    }) as any;
    expect(finalized.ok).toBe(true);
    expect(fs.readFileSync(path.join(repoRoot, 'tests', 'new.test.txt'), 'utf8')).toBe('worker result revised\n');
    expect(fs.readFileSync(path.join(repoRoot, 'src', 'integrated.txt'), 'utf8')).toBe('integrated\n');
    expect(fs.readFileSync(path.join(repoRoot, 'src', 'dirty.txt'), 'utf8')).toBe('dirty baseline\n');
    expect(await finalizeProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
    })).toMatchObject({ ok: true, alreadyApplied: true });
    fs.writeFileSync(path.join(integrator.worktreePath, 'src', 'follow-up.txt'), 'follow up\n', 'utf8');
    expect(await finalizeProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1,
      projectDir: repoRoot,
    })).toMatchObject({ ok: true, changed: true });
    expect(fs.readFileSync(path.join(repoRoot, 'src', 'follow-up.txt'), 'utf8')).toBe('follow up\n');
    const unaccountedWorkerFile = path.join(restoredWorker.worktreePath, 'tests', 'unaccounted.tmp');
    fs.writeFileSync(unaccountedWorkerFile, 'not submitted\n', 'utf8');
    expect(await cleanupProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1, projectDir: repoRoot,
    })).toMatchObject({ ok: false, error: expect.stringContaining('未收敛改动') });
    expect(fs.existsSync(restoredWorker.repoWorktreePath)).toBe(true);
    fs.rmSync(unaccountedWorkerFile, { force: true });
    expect(await cleanupProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1, projectDir: repoRoot,
    })).toMatchObject({ ok: true, cleanedWorktrees: 3 });
    for (const worker of prepared.workers) expect(fs.existsSync(worker.repoWorktreePath)).toBe(false);
    expect(await cleanupProjectWorkerGroup({
      projectId: 'project-test', workItemId: 'task-test', executionEpoch: 1, projectDir: repoRoot,
    })).toMatchObject({ ok: true, alreadyCleaned: true });
  });

  it('does not treat a commit outside a subdirectory project as project baseline drift', async () => {
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'capture first worker result']);
    const projectDir = path.join(repoRoot, 'src', 'subproject');
    fs.mkdirSync(path.join(projectDir, 'integration'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'integration', 'base.txt'), 'base\n', 'utf8');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'add nested project']);
    const prepared = await prepareProjectWorkerGroup({
      projectId: 'project-nested',
      workItemId: 'task-nested',
      executionEpoch: 1,
      projectDir,
      assignments: [
        {
          workerId: 'worker-main', role: 'integrator', outcome: 'integrate', dependencies: [],
          writeClaims: ['integration'], resourceClaims: [], validation: ['test'],
        },
        {
          workerId: 'worker-tests', role: 'worker', outcome: 'test', dependencies: [],
          writeClaims: ['tests'], resourceClaims: [], validation: ['test'],
        },
      ],
    }) as any;
    expect(prepared.ok).toBe(true);
    fs.writeFileSync(path.join(repoRoot, 'outside-project.txt'), 'outside commit\n', 'utf8');
    git(repoRoot, ['add', 'outside-project.txt']);
    git(repoRoot, ['commit', '-m', 'change outside nested project']);
    const integrator = prepared.workers.find((worker: any) => worker.workerId === 'worker-main');
    fs.writeFileSync(path.join(integrator.worktreePath, 'integration', 'result.txt'), 'nested result\n', 'utf8');
    const finalized = await finalizeProjectWorkerGroup({
      projectId: 'project-nested', workItemId: 'task-nested', executionEpoch: 1, projectDir,
    }) as any;
    expect(finalized.ok).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, 'integration', 'result.txt'), 'utf8')).toBe('nested result\n');
  });

  it('creates an auditable empty candidate that must be explicitly rejected', async () => {
    const assignments = [
      {
        workerId: 'worker-main', role: 'integrator' as const, outcome: 'integrate', dependencies: ['worker-check'],
        writeClaims: ['src'], resourceClaims: [], validation: ['test'],
      },
      {
        workerId: 'worker-check', role: 'worker' as const, outcome: 'check', dependencies: [],
        writeClaims: ['tests'], resourceClaims: [], validation: ['review'],
      },
    ];
    const prepared = await prepareProjectWorkerGroup({
      projectId: 'project-empty', workItemId: 'task-empty', executionEpoch: 1, projectDir: repoRoot, assignments,
    }) as any;
    expect(prepared.ok).toBe(true);
    const submitted = await submitProjectMergeCandidate({
      projectId: 'project-empty', workItemId: 'task-empty', executionEpoch: 1, projectDir: repoRoot,
      workerId: 'worker-check', assignmentVersion: 1, directiveEpoch: 0,
      authoritativeWorker: assignments[1],
    }) as any;
    expect(submitted).toMatchObject({ ok: true, changedFiles: [] });
    expect(await applyProjectMergeCandidate({
      projectId: 'project-empty', workItemId: 'task-empty', executionEpoch: 1, projectDir: repoRoot,
      candidateId: submitted.candidateId, workerId: submitted.workerId,
      expectedPatchHash: submitted.patchHash, expectedChangedFiles: [],
    })).toMatchObject({ ok: false, error: expect.stringContaining('明确拒绝') });
  });
});
