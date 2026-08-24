import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupProjectJsonInput,
  normalizeSupervisorChangedFiles,
  PROJECT_USAGE,
  resolveProjectCommandHelp,
  resolveProjectJsonInput,
} from '../../src/cli/project-command';
import { projectCommandNeedsExplicitId } from '../../src/shared/project-command-scope';

const roots: string[] = [];

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-project-command-'));
  roots.push(directory);
  fs.mkdirSync(path.join(directory, '.wmux', 'tmp'), { recursive: true });
  return directory;
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('project command JSON input', () => {
  it('keeps required JSON validation for real commands', () => {
    expect(() => resolveProjectJsonInput(['project', 'update'])).toThrow('--json or --json-file is required');
  });

  it('reads and removes a consumed JSON draft inside .wmux/tmp', () => {
    const cwd = root();
    const file = path.join(cwd, '.wmux', 'tmp', 'task.json');
    fs.writeFileSync(file, '{"id":"auth"}\n', 'utf8');
    const input = resolveProjectJsonInput(['task-create', '--json-file', '.wmux/tmp/task.json'], cwd);
    expect(input.value).toEqual({ id: 'auth' });
    cleanupProjectJsonInput(input, true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects JSON files outside .wmux/tmp', () => {
    const cwd = root();
    fs.writeFileSync(path.join(cwd, 'task.json'), '{}', 'utf8');
    expect(() => resolveProjectJsonInput(['task-create', '--json-file', 'task.json'], cwd)).toThrow('restricted');
  });

  it('classifies a missing draft directory and file without leaking fs errors', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-project-command-missing-'));
    roots.push(cwd);
    expect(() => resolveProjectJsonInput(['task-create', '--json-file', '.wmux/tmp/task.json'], cwd))
      .toThrow('draft directory');

    const valid = root();
    expect(() => resolveProjectJsonInput(['task-create', '--json-file', '.wmux/tmp/task.json'], valid))
      .toThrow('draft file');
  });

  it('preserves the draft after a failed command', () => {
    const cwd = root();
    const file = path.join(cwd, '.wmux', 'tmp', 'task.json');
    fs.writeFileSync(file, '{}', 'utf8');
    const input = resolveProjectJsonInput(['task-create', '--json-file', '.wmux/tmp/task.json'], cwd);
    cleanupProjectJsonInput(input, false);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('supervisor changed-file report', () => {
  it('omits prose markers used for a zero-change completion', () => {
    expect(normalizeSupervisorChangedFiles('none')).toEqual([]);
    expect(normalizeSupervisorChangedFiles('无变更')).toEqual([]);
    expect(normalizeSupervisorChangedFiles('src/auth.ts, none, src/auth.ts')).toEqual(['src/auth.ts']);
  });
});

describe('project command help', () => {
  it.each([
    ['--help'],
    ['-h'],
  ])('returns general help for wmux project %s without executing a command', (helpFlag) => {
    expect(resolveProjectCommandHelp(['project', helpFlag])).toBe(PROJECT_USAGE);
  });

  it('documents project update before JSON validation is considered', () => {
    const help = resolveProjectCommandHelp(['project', 'update', '--help']);
    expect(help).toContain('Usage: wmux project update');
    expect(help).toContain('"mode": "refine|pivot"');
    expect(help).toContain('"preconditions"');
    expect(help).toContain('"doneWhen"');
  });

  it.each([
    ['alignment-confirm', 'goalUnderstanding'],
    ['orientation-confirm', 'snapshotFingerprint'],
    ['goal-plan', 'subgoals'],
  ])('documents the %s JSON shape', (subcommand, expectedField) => {
    expect(resolveProjectCommandHelp(['project', subcommand, '-h'])).toContain(expectedField);
  });

  it('returns lightweight command-specific help for non-JSON commands', () => {
    expect(resolveProjectCommandHelp(['project', 'status', '--help']))
      .toBe('Usage: wmux project status [--project <id>] [options]');
  });

  it('documents execution-window replanning as a structured project command', () => {
    const help = resolveProjectCommandHelp(['project', 'execution-window-replan', '--help']);
    expect(help).toContain('Usage: wmux project execution-window-replan');
    expect(help).toContain('--json-file');
    expect(PROJECT_USAGE).toContain('execution-window-replan');
  });

  it('does not intercept a real project command', () => {
    expect(resolveProjectCommandHelp(['project', 'update', '--json', '{}'])).toBeUndefined();
  });
});

describe('project command scope', () => {
  const projects = [
    { status: 'active' },
    { status: 'waiting' },
    { status: 'completed' },
  ];

  it('requires an explicit project ID for scoped commands in a multi-project portfolio', () => {
    expect(projectCommandNeedsExplicitId('task-create', '', projects)).toBe(true);
    expect(projectCommandNeedsExplicitId('supervisor-decide', '', projects)).toBe(true);
    expect(projectCommandNeedsExplicitId('goal-plan', '', projects)).toBe(true);
    expect(projectCommandNeedsExplicitId('orientation-confirm', '', projects)).toBe(true);
    expect(projectCommandNeedsExplicitId('task-create', 'project-a', projects)).toBe(false);
  });

  it('also keeps completed project history from making an unscoped command ambiguous', () => {
    expect(projectCommandNeedsExplicitId('logs', '', [
      { status: 'active' },
      { status: 'completed' },
    ])).toBe(true);
  });

  it('keeps status and portfolio controls unscoped', () => {
    expect(projectCommandNeedsExplicitId('status', '', projects)).toBe(false);
    expect(projectCommandNeedsExplicitId('pause-all', '', projects)).toBe(false);
  });
});
