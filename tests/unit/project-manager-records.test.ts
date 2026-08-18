import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendProjectManagerRecord,
  deleteProjectManagerSession,
  readActiveProjectManagerSessions,
  readProjectManagerRuntimeSurfaceIds,
  saveProjectManagerSession,
} from '../../src/main/project-manager-records';
import {
  DEFAULT_PROJECT_EXECUTION_BUDGET,
  normalizeProjectManagerSession,
  type ProjectManagerSession,
} from '../../src/shared/project-manager';

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

function recoveredSession(appData: string, sessionId: string): ProjectManagerSession | undefined {
  return readActiveProjectManagerSessions(appData).find((candidate) => candidate.id === sessionId);
}

describe('project manager records', () => {
  it('atomically replaces one project snapshot without hiding another project in the directory', () => {
    const appData = root();
    saveProjectManagerSession(session('pm-old', 10), appData);
    saveProjectManagerSession(session('pm-new', 20), appData);
    saveProjectManagerSession(session('pm-new', 30), appData);
    expect(recoveredSession(appData, 'pm-new')?.updatedAt).toBe(30);
    expect(readActiveProjectManagerSessions(appData).map((candidate) => candidate.id)).toEqual(['pm-new', 'pm-old']);
  });

  it('restores incomplete snapshots as unaccepted definitions that require alignment', () => {
    const appData = root();
    const directory = path.join(appData, 'project-manager');
    fs.mkdirSync(directory, { recursive: true });
    const legacy = session('pm-legacy', 10) as Partial<ProjectManagerSession>;
    delete legacy.preconditions;
    delete legacy.planFiles;
    fs.writeFileSync(path.join(directory, 'pm-legacy.json'), JSON.stringify({ version: 1, session: legacy }), 'utf8');

    const restored = recoveredSession(appData, 'pm-legacy');
    expect(restored?.preconditions).toEqual([]);
    expect(restored?.planFiles).toEqual([]);
    expect(restored?.acceptedRequirementsVersion).toBe(0);
    expect(restored).toMatchObject({
      projectName: 'repo',
      activeGoalId: 'pm-legacy-goal-1',
      goals: [expect.objectContaining({ statement: '完成项目', status: 'active' })],
      authorizationVersion: 1,
    });
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
      pendingManagerDeliveries: [{
        id: 'delivery-1', text: '请按新条件重新规划', createdAt: 13,
        transitionId: 'transition-1',
      }],
      pendingSupervisorTransitions: [{
        id: 'transition-1', laneId: 'lane-1', workItemId: 'wol_validation',
        kind: 'stage-complete' as const, eventType: 'supervisor.waiting-for-direction',
        summary: '阶段证据已经交接', evidence: '定向测试通过',
        createdAt: 12, notifiedAt: 13, notificationCount: 1,
      }],
      progressSnapshot: {
        version: 1 as const, capturedAt: 14, mode: 'git' as const,
        fingerprint: 'progress-fingerprint', head: 'abc123', headSummary: 'abc123 外部实现进度',
        branch: 'main', truncated: false,
        entries: [{
          path: 'src/external.ts', source: 'workspace' as const,
          status: 'M', signature: 'sha256:external',
        }],
      },
      progressSync: {
        status: 'review-required' as const, checkedAt: 15,
        snapshotFingerprint: 'progress-fingerprint', summary: '检测到外部实现进度',
        changeCount: 1, reason: '软件恢复',
      },
    };

    saveProjectManagerSession(saved, appData);

    expect(recoveredSession(appData, 'pm-plan')).toMatchObject({
      planFiles: [{ name: 'requirements.md', content: '# 需求' }],
      pendingUserQuestion: {
        id: 'question-1', previousStatus: 'active', category: 'manual-intervention',
        reasonCode: 'physical-action', workItemId: 'wol_validation',
      },
      requirementsVersion: 3,
      acceptedRequirementsVersion: 2,
      pendingManagerDeliveries: [{
        id: 'delivery-1', text: '请按新条件重新规划', transitionId: 'transition-1',
      }],
      pendingSupervisorTransitions: [{
        id: 'transition-1', kind: 'stage-complete', workItemId: 'wol_validation',
        evidence: '定向测试通过', notificationCount: 1,
      }],
      progressSnapshot: {
        fingerprint: 'progress-fingerprint', headSummary: 'abc123 外部实现进度',
        entries: [{ path: 'src/external.ts', status: 'M' }],
      },
      progressSync: {
        status: 'review-required', snapshotFingerprint: 'progress-fingerprint', changeCount: 1,
      },
    });
  });

  it('restores a complete adaptive thread contract', () => {
    const appData = root();
    const saved: ProjectManagerSession = {
      ...session('pm-adaptive', 20),
      workItems: [{
        id: 'adaptive-task',
        requirementsVersion: 1,
        baseline: {
          status: 'approved', requirementsVersion: 1,
          workspaceVersion: 'head:adaptive,status:clean',
          evidence: '已审核项目结构、测试约定与共享资源边界', approvedAt: 19,
        },
        title: '自适应任务',
        status: 'planned',
        dependencies: [],
        attempts: 0,
        decisionsUsed: 0,
        updatedAt: 20,
        executionHistory: [],
        contract: {
          objective: '完成自适应任务',
          description: '',
          preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: ['src'], denyPaths: [], forbiddenActions: [] },
          authority: {
            technicalChoices: true,
            lowRiskRetries: true,
            targetedTests: true,
            internalThreads: true,
            continuousExecution: true,
            permissionConfirm: false,
          },
          execution: {
            taskWorkMode: 'adaptive',
            modeReason: '先探测安全拆分边界',
            mainThreadResponsibility: '集成并验证',
            childThreadResponsibilities: [],
            maxChildThreads: 2,
            supervisorMayApproveThreads: true,
            parallelizableOperations: ['只读分析'],
            serializedOperations: ['硬件重上电', '最终验证'],
          },
          stopWhen: ['验证完成'],
          validation: ['检查结果'],
          budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      }],
    };

    saveProjectManagerSession(saved, appData);

    expect(recoveredSession(appData, 'pm-adaptive')?.workItems[0])
      .toMatchObject({
        baseline: {
          status: 'approved',
          workspaceVersion: 'head:adaptive,status:clean',
        },
        contract: { execution: {
        taskWorkMode: 'adaptive',
        maxChildThreads: 2,
        supervisorMayApproveThreads: true,
        serializedOperations: ['硬件重上电', '最终验证'],
        } },
      });
  });

  it('persists repeated stage ids in separate main goals and rejects cyclic stage plans', () => {
    const appData = root();
    const base = normalizeProjectManagerSession(session('pm-goals', 20));
    const firstGoal = base.goals![0];
    const secondGoal = {
      ...firstGoal,
      id: 'pm-goals-goal-2', sequence: 2, statement: '完成第二目标',
      status: 'active' as const, requirementsVersion: 2, supersedesGoalId: firstGoal.id, createdAt: 10,
    };
    const repeatedStages: ProjectManagerSession = {
      ...base,
      activeGoalId: secondGoal.id,
      goals: [{ ...firstGoal, status: 'superseded' }, secondGoal],
      goal: secondGoal.statement,
      doneWhen: secondGoal.doneWhen,
      requirementsVersion: 2,
      subgoals: [firstGoal, secondGoal].map((goal, index) => ({
        id: 'implementation', goalId: goal.id, title: `实现阶段 ${index + 1}`, outcome: '形成可验收实现',
        acceptance: ['实现可验证'], dependencies: [], status: index === 0 ? 'achieved' : 'active',
        order: 1, createdAt: index + 1, updatedAt: index + 1,
      })),
    };
    expect(() => saveProjectManagerSession(repeatedStages, appData)).not.toThrow();
    expect(recoveredSession(appData, repeatedStages.id)?.subgoals).toHaveLength(2);

    const cyclic = {
      ...repeatedStages,
      id: 'pm-cyclic',
      subgoals: [
        { ...repeatedStages.subgoals![1], id: 'a', dependencies: ['b'] },
        { ...repeatedStages.subgoals![1], id: 'b', dependencies: ['a'] },
      ],
    };
    expect(() => saveProjectManagerSession(cyclic, appData)).toThrow('invalid project manager session payload');

    const competingGoals = {
      ...repeatedStages,
      id: 'pm-competing-goals',
      goals: repeatedStages.goals!.map((goal) => ({ ...goal, status: 'active' as const })),
    };
    expect(() => saveProjectManagerSession(competingGoals, appData)).toThrow('invalid project manager session payload');
  });

  it('restores every active project including independent projects that share one directory', () => {
    const appData = root();
    saveProjectManagerSession({ ...session('pm-a', 50), projectDir: 'E:\\a' }, appData);
    saveProjectManagerSession({ ...session('pm-a-old', 10), projectDir: 'E:\\a\\' }, appData);
    saveProjectManagerSession({ ...session('pm-b', 40), projectDir: 'E:\\b' }, appData);
    saveProjectManagerSession({ ...session('pm-c', 30), projectDir: 'E:\\c' }, appData);
    saveProjectManagerSession({ ...session('pm-d', 20), projectDir: 'E:\\d' }, appData);
    saveProjectManagerSession({ ...session('pm-done', 60), projectDir: 'E:\\done', status: 'completed' }, appData);

    expect(readActiveProjectManagerSessions(appData).map((item) => item.id)).toEqual([
      'pm-a', 'pm-b', 'pm-c', 'pm-d', 'pm-a-old',
    ]);
  });

  it('does not truncate the recovery list at the former session-file ceiling', () => {
    const appData = root();
    for (let index = 0; index < 105; index += 1) {
      saveProjectManagerSession({
        ...session(`pm-many-${index}`, index + 1),
        projectDir: `E:\\many-${index}`,
      }, appData);
    }

    expect(readActiveProjectManagerSessions(appData)).toHaveLength(105);
  });

  it('keeps an independent active project recoverable when another project in the directory completed', () => {
    const appData = root();
    saveProjectManagerSession({ ...session('pm-stale', 10), projectDir: 'E:\\finished' }, appData);
    saveProjectManagerSession({ ...session('pm-finished', 20), projectDir: 'e:\\finished\\', status: 'completed' }, appData);
    expect(readActiveProjectManagerSessions(appData)).toEqual([
      expect.objectContaining({ id: 'pm-stale', status: 'active' }),
    ]);
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
    expect(recoveredSession(appData, 'pm-bad')).toBeUndefined();
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
