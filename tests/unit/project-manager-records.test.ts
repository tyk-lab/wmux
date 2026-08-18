import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendProjectManagerRecord,
  deleteProjectManagerSession,
  readActiveProjectManagerSessions,
  readLatestProjectManagerSession,
  readProjectManagerRuntimeSurfaceIds,
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
    preconditions: ['测试环境已准备'],
    planFiles: [],
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

  it('restores legacy snapshots without prerequisites or plan files as empty lists', () => {
    const appData = root();
    const directory = path.join(appData, 'project-manager');
    fs.mkdirSync(directory, { recursive: true });
    const legacy = session('pm-legacy', 10) as Partial<ProjectManagerSession>;
    delete legacy.preconditions;
    delete legacy.planFiles;
    fs.writeFileSync(path.join(directory, 'pm-legacy.json'), JSON.stringify({ version: 1, session: legacy }), 'utf8');

    expect(readLatestProjectManagerSession('E:\\repo', appData)?.preconditions).toEqual([]);
    expect(readLatestProjectManagerSession('E:\\repo', appData)?.planFiles).toEqual([]);
  });

  it('persists plan snapshots and a pending user clarification for recovery', () => {
    const appData = root();
    const pendingUserQuestion = {
      id: 'question-1',
      category: 'manual-intervention' as const,
      reasonCode: 'physical-action' as const,
      workItemId: 'wol_validation',
      blocker: '需要用户进入 BIOS 进行真机验收',
      question: '是否允许覆盖现有配置？',
      context: '目标与计划文件存在冲突。',
      options: [{ id: 'keep', label: '保留现有配置' }, { id: 'replace', label: '允许覆盖' }],
      recommendedOptionId: 'keep',
      previousStatus: 'active' as const,
      createdAt: 12,
    };
    const saved = {
      ...session('pm-plan', 20),
      status: 'waiting' as const,
      planFiles: [{
        path: 'E:\\requirements.md', name: 'requirements.md', content: '# 需求',
        sizeBytes: 8, mtimeMs: 10, capturedAt: 11,
      }],
      pendingUserQuestion,
      requirementsVersion: 3,
      acceptedRequirementsVersion: 2,
      pendingManagerDeliveries: [{ id: 'delivery-1', text: '请按新条件重新规划', createdAt: 13 }],
    };

    saveProjectManagerSession(saved, appData);

    expect(readLatestProjectManagerSession('E:\\repo', appData)).toMatchObject({
      planFiles: [{ name: 'requirements.md', content: '# 需求' }],
      pendingUserQuestion: {
        id: 'question-1', previousStatus: 'active', category: 'manual-intervention',
        reasonCode: 'physical-action', workItemId: 'wol_validation',
      },
      requirementsVersion: 3,
      acceptedRequirementsVersion: 2,
      pendingManagerDeliveries: [{ id: 'delivery-1', text: '请按新条件重新规划' }],
    });
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

  it('returns restart-unsafe task terminal ids from active and completed projects', () => {
    const appData = root();
    saveProjectManagerSession({
      ...session('pm-active', 10), projectDir: 'E:\\active', taskTerminalSurfaceId: 'surf-active',
    }, appData);
    saveProjectManagerSession({
      ...session('pm-completed', 20), projectDir: 'E:\\completed', status: 'completed',
      taskTerminalSurfaceId: 'surf-completed',
    }, appData);

    expect(readProjectManagerRuntimeSurfaceIds(appData)).toEqual([
      'surf-completed', 'surf-active',
    ]);
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

  it('deletes the selected project snapshot and audit trail without touching the project directory', () => {
    const appData = root();
    const projectDir = path.join(appData, 'project-files');
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, 'keep.txt'), 'keep', 'utf8');
    const project = { ...session('pm-delete', 10), projectDir };
    const snapshot = saveProjectManagerSession(project, appData).path;
    const audit = appendProjectManagerRecord({
      sessionId: project.id, projectDir, type: 'manager-reply', payload: { message: '记录' },
    }, appData).path;

    expect(deleteProjectManagerSession(project.id, appData)).toEqual({ deleted: true });
    expect(fs.existsSync(snapshot)).toBe(false);
    expect(fs.existsSync(audit)).toBe(false);
    expect(fs.readFileSync(path.join(projectDir, 'keep.txt'), 'utf8')).toBe('keep');
  });
});
