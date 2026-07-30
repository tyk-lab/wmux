import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendSupervisorRecord } from '../../src/main/supervisor-records';

const tempDirs: string[] = [];

function projectDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-supervisor-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('supervisor records', () => {
  it('keeps duplicate terminal labels distinct by surface id and ignores the audit directory', () => {
    const project = projectDir();
    const shared = {
      sessionId: 'sup-123',
      projectDir: project,
      type: 'worker.lifecycle',
      payload: { event: 'Stop' },
    };

    appendSupervisorRecord({ ...shared, terminal: { surfaceId: 'surf-a', label: 'Codex' } });
    appendSupervisorRecord({ ...shared, terminal: { surfaceId: 'surf-b', label: 'Codex' } });

    const records = fs.readFileSync(path.join(project, '.wmux', 'supervisor', 'sup-123', 'events.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.terminal.surfaceId)).toEqual(['surf-a', 'surf-b']);
    expect(fs.readFileSync(path.join(project, '.gitignore'), 'utf8')).toContain('.wmux/supervisor/');
    expect(fs.existsSync(path.join(project, '.wmux', 'supervisor', 'sup-123', 'session.json'))).toBe(true);
  });
});
