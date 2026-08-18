import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjectJsonInput, resolveProjectJsonInput } from '../../src/cli/project-command';
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
