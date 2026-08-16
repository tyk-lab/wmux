import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendProjectManagerRecord,
  readActiveProjectManagerSessions,
  readLatestProjectManagerSession,
  saveProjectManagerSession,
} from '../../src/main/project-manager-records';
import type { ProjectManagerSession } from '../../src/shared/project-manager';

const roots: string[] = [];

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-project-records-'));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function session(id: string, updatedAt: number): ProjectManagerSession {
  return {
    id,
    projectDir: 'E:\\repo',
    goal: '完成项目',
    doneWhen: ['测试通过'],
    status: 'active',
    workItems: [],
    events: [],
    createdAt: 1,
    updatedAt,
  };
}

describe('project manager records', () => {
  it('atomically saves and restores the latest session for one project', () => {
    const appData = root();
    saveProjectManagerSession(session('pm-old', 10), appData);
    saveProjectManagerSession(session('pm-new', 20), appData);
    saveProjectManagerSession(session('pm-new', 30), appData);
    expect(readLatestProjectManagerSession('E:\\repo', appData)?.id).toBe('pm-new');
    expect(readLatestProjectManagerSession('E:\\repo', appData)?.updatedAt).toBe(30);
    expect(readLatestProjectManagerSession('E:\\other', appData)).toBeNull();
  });

  it('restores at most three active projects with unique directories', () => {
    const appData = root();
    saveProjectManagerSession({ ...session('pm-a', 50), projectDir: 'E:\\a' }, appData);
    saveProjectManagerSession({ ...session('pm-a-old', 10), projectDir: 'E:\\a\\' }, appData);
    saveProjectManagerSession({ ...session('pm-b', 40), projectDir: 'E:\\b' }, appData);
    saveProjectManagerSession({ ...session('pm-c', 30), projectDir: 'E:\\c' }, appData);
    saveProjectManagerSession({ ...session('pm-d', 20), projectDir: 'E:\\d' }, appData);
    saveProjectManagerSession({ ...session('pm-done', 60), projectDir: 'E:\\done', status: 'completed' }, appData);

    expect(readActiveProjectManagerSessions(appData).map((item) => item.id)).toEqual(['pm-a', 'pm-b', 'pm-c']);
  });

  it('does not resurrect an older active session after the same directory was completed', () => {
    const appData = root();
    saveProjectManagerSession({ ...session('pm-stale', 10), projectDir: 'E:\\finished' }, appData);
    saveProjectManagerSession({ ...session('pm-finished', 20), projectDir: 'e:\\finished\\', status: 'completed' }, appData);
    expect(readActiveProjectManagerSessions(appData)).toEqual([]);
  });

  it('ignores malformed snapshots instead of restoring executable state', () => {
    const appData = root();
    const directory = path.join(appData, 'project-manager');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'pm-bad.json'), JSON.stringify({
      version: 1,
      session: { ...session('pm-bad', 100), workItems: [{}] },
    }), 'utf8');
    expect(readLatestProjectManagerSession('E:\\repo', appData)).toBeNull();
  });

  it('appends bounded audit records outside the project tree', () => {
    const appData = root();
    const result = appendProjectManagerRecord({
      sessionId: 'pm-audit', projectDir: 'E:\\repo', type: 'manager-reply', payload: { message: '完成' },
    }, appData);
    expect(result.path.startsWith(appData)).toBe(true);
    expect(fs.readFileSync(result.path, 'utf8')).toContain('manager-reply');
  });
});
