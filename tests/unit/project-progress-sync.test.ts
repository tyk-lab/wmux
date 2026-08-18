import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { captureProjectProgress } from '../../src/main/project-progress-sync';
import { diffProjectProgressSnapshots } from '../../src/shared/project-manager';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-progress-sync-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('project progress sync', () => {
  it('detects external file and selected-plan changes outside git repositories', () => {
    const root = temporaryDirectory();
    const projectDir = path.join(root, 'project');
    const planFile = path.join(root, 'PLAN.md');
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'main.ts'), 'export const value = 1;\n', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'ignored', 'index.js'), 'ignored\n', 'utf8');
    fs.writeFileSync(planFile, '# Plan v1\n', 'utf8');

    const first = captureProjectProgress(projectDir, [planFile]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.snapshot.mode).toBe('filesystem');
    expect(first.snapshot.entries.some((entry) => entry.path.includes('node_modules'))).toBe(false);

    fs.writeFileSync(path.join(projectDir, 'src', 'main.ts'), 'export const value = 2;\n', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'src', 'added.ts'), 'export {};\n', 'utf8');
    fs.writeFileSync(planFile, '# Plan v2\n', 'utf8');
    const second = captureProjectProgress(projectDir, [planFile]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const diff = diffProjectProgressSnapshots(first.snapshot, second.snapshot);
    expect(diff.changed).toBe(true);
    expect(diff.added).toContain(path.join('src', 'added.ts'));
    expect(diff.modified).toEqual(expect.arrayContaining([
      path.join('src', 'main.ts'),
      path.normalize(planFile),
    ]));
  });

  it('captures git HEAD changes and current uncommitted content signatures', () => {
    const projectDir = temporaryDirectory();
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'wmux-test@example.invalid'], { cwd: projectDir });
    execFileSync('git', ['config', 'user.name', 'wmux test'], { cwd: projectDir });
    fs.writeFileSync(path.join(projectDir, 'tracked.txt'), 'one\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: projectDir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: projectDir, stdio: 'ignore' });

    const clean = captureProjectProgress(projectDir);
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(clean.snapshot.mode).toBe('git');
    expect(clean.snapshot.entries).toEqual([]);

    fs.writeFileSync(path.join(projectDir, 'tracked.txt'), 'two\n', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'untracked.txt'), 'new\n', 'utf8');
    const dirty = captureProjectProgress(projectDir);
    expect(dirty.ok).toBe(true);
    if (!dirty.ok) return;
    expect(dirty.snapshot.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'tracked.txt',
      'untracked.txt',
    ]));
    expect(diffProjectProgressSnapshots(clean.snapshot, dirty.snapshot).changed).toBe(true);

    execFileSync('git', ['add', '.'], { cwd: projectDir });
    execFileSync('git', ['commit', '-m', 'external progress'], { cwd: projectDir, stdio: 'ignore' });
    const committed = captureProjectProgress(projectDir);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const committedDiff = diffProjectProgressSnapshots(dirty.snapshot, committed.snapshot);
    expect(committedDiff.headChanged).toBe(true);
    expect(committedDiff.removed).toEqual(expect.arrayContaining(['tracked.txt', 'untracked.txt']));
  });

  it('scopes git progress to the managed project directory inside a monorepo', () => {
    const root = temporaryDirectory();
    const projectDir = path.join(root, 'managed-project');
    const otherDir = path.join(root, 'other-project');
    fs.mkdirSync(projectDir);
    fs.mkdirSync(otherDir);
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'wmux-test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'wmux test'], { cwd: root });
    fs.writeFileSync(path.join(projectDir, 'managed.txt'), 'managed v1\n', 'utf8');
    fs.writeFileSync(path.join(otherDir, 'other.txt'), 'other v1\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'initial monorepo'], { cwd: root, stdio: 'ignore' });

    const baseline = captureProjectProgress(projectDir);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    fs.writeFileSync(path.join(otherDir, 'other.txt'), 'other v2\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'unrelated project progress'], { cwd: root, stdio: 'ignore' });
    const unrelated = captureProjectProgress(projectDir);
    expect(unrelated.ok).toBe(true);
    if (!unrelated.ok) return;
    expect(diffProjectProgressSnapshots(baseline.snapshot, unrelated.snapshot).changed).toBe(false);

    fs.writeFileSync(path.join(projectDir, 'managed.txt'), 'managed v2\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'managed project progress'], { cwd: root, stdio: 'ignore' });
    const managed = captureProjectProgress(projectDir);
    expect(managed.ok).toBe(true);
    if (!managed.ok) return;
    expect(diffProjectProgressSnapshots(unrelated.snapshot, managed.snapshot).headChanged).toBe(true);
  });

  it('rejects relative or missing project directories', () => {
    expect(captureProjectProgress('relative-project')).toMatchObject({ ok: false });
    expect(captureProjectProgress(path.join(os.tmpdir(), 'wmux-progress-missing-project')))
      .toMatchObject({ ok: false });
  });
});
