import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjectJsonInput, resolveProjectJsonInput } from '../../src/cli/project-command';

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

  it('preserves the draft after a failed command', () => {
    const cwd = root();
    const file = path.join(cwd, '.wmux', 'tmp', 'task.json');
    fs.writeFileSync(file, '{}', 'utf8');
    const input = resolveProjectJsonInput(['task-create', '--json-file', '.wmux/tmp/task.json'], cwd);
    cleanupProjectJsonInput(input, false);
    expect(fs.existsSync(file)).toBe(true);
  });
});
