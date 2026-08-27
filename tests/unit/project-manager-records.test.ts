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
  CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
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
    executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
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
  it('rejects saving an older execution protocol instead of migrating it', () => {
    const appData = root();

    expect(() => saveProjectManagerSession({
      ...session('pm-old-protocol-save', 10),
      executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION - 1,
    }, appData)).toThrow('invalid project manager execution protocol version');
    expect(readActiveProjectManagerSessions(appData)).toEqual([]);
  });

  it('persists a newly created project while completion conditions await AI alignment', () => {
    const appData = root();
    const now = 100;
    const created = normalizeProjectManagerSession({
      id: 'pm-new-project',
      projectDir: 'E:\\new-project',
      activeGoalId: 'pm-new-project-goal-1',
      goals: [{
        id: 'pm-new-project-goal-1',
        sequence: 1,
        statement: '完成首次需求对齐',
        doneWhen: [],
        status: 'transitioning',
        requirementsVersion: 1,
        createdAt: now,
      }],
      subgoals: [],
      goal: '完成首次需求对齐',
      preconditions: [],
      planFiles: [],
      doneWhen: [],
      requirementsVersion: 1,
      authorizationVersion: 1,
      acceptedRequirementsVersion: 0,
      status: 'active',
      orientation: {
        status: 'required',
        requirementsVersion: 1,
        authorizationVersion: 1,
        snapshotFingerprint: 'capture-pending',
        reason: '项目首次创建，需要先建立项目认知基线',
        requestedAt: now,
      },
      workItems: [],
      events: [],
      createdAt: now,
      updatedAt: now,
    });

    expect(() => saveProjectManagerSession(created, appData)).not.toThrow();
    expect(recoveredSession(appData, created.id)?.goals?.[0].doneWhen).toEqual([]);
    expect(() => saveProjectManagerSession({
      ...created,
      id: 'pm-invalid-completed',
      activeGoalId: 'pm-invalid-completed-goal-1',
      goals: [{
        ...created.goals![0],
        id: 'pm-invalid-completed-goal-1',
        status: 'completed',
        closedAt: now + 1,
      }],
      status: 'completed',
    }, appData)).toThrow('invalid project manager session payload');

    const withStageResult: ProjectManagerSession = {
      ...created,
      updatedAt: now + 2,
      subgoals: [{
        id: 'alignment-result',
        goalId: created.activeGoalId!,
        title: '需求对齐结果',
        outcome: '形成可执行需求',
        acceptance: ['需求边界明确'],
        dependencies: [],
        status: 'achieved',
        order: 1,
        createdAt: now,
        updatedAt: now + 1,
        completion: {
          summary: '需求、范围和验收条件已经完成对齐',
          validation: ['需求边界明确'],
          evidence: '项目定义已持久化',
          completedAt: now + 1,
        },
      }],
    };
    expect(() => saveProjectManagerSession(withStageResult, appData)).not.toThrow();
    expect(recoveredSession(appData, created.id)?.subgoals?.[0].completion).toMatchObject({
      summary: '需求、范围和验收条件已经完成对齐',
      validation: ['需求边界明确'],
      evidence: '项目定义已持久化',
    });
  });

  it('rejects the abandoned conversational project-goal state', () => {
    const appData = root();
    const drafting = normalizeProjectManagerSession({
      ...session('pm-goal-drafting', 20),
      status: 'waiting',
      goalConstruction: {
        status: 'drafting',
        initialIdea: '帮我整理这个旧项目',
        startedAt: 10,
      },
    });

    expect(() => saveProjectManagerSession(drafting, appData)).toThrow('invalid project manager session payload');
  });

  it('rejects another live project AI for the same normalized directory', () => {
    const appData = root();
    saveProjectManagerSession({ ...session('pm-first', 10), projectDir: 'E:\\Repo\\' }, appData);

    expect(() => saveProjectManagerSession({
      ...session('pm-second', 20),
      projectDir: 'e:/repo/.',
    }, appData)).toThrow('该目录已存在项目 AI：pm-first');
  });

  it.each(['verification-limited', 'final-acceptance', 'runtime-recovery'] as const)(
    'persists a %s user decision across restart',
    (reasonCode) => {
      const appData = root();
      const saved: ProjectManagerSession = {
        ...session(`pm-${reasonCode}`, 20),
        status: 'waiting',
        pendingUserQuestion: {
          id: `question-${reasonCode}`,
          category: 'manual-intervention',
          reasonCode,
          blocker: '当前自动恢复或验证路线已经耗尽',
          question: '请选择下一步处理方式。',
          context: '保留当前成果，不重复失败路线。',
          options: [
            { id: 'continue', label: '继续', description: '按新路线继续。' },
            { id: 'pause', label: '暂停', description: '保持暂停。' },
          ],
          recommendedOptionId: 'continue',
          previousStatus: 'paused',
          createdAt: 10,
        },
      };

      expect(() => saveProjectManagerSession(saved, appData)).not.toThrow();
      expect(recoveredSession(appData, saved.id)?.pendingUserQuestion).toMatchObject({ reasonCode });
    },
  );

  it('persists an explicit verification deferral on its work item', () => {
    const appData = root();
    const goalId = 'pm-verification-deferral-goal-1';
    const saved = normalizeProjectManagerSession({
      ...session('pm-verification-deferral', 20),
      activeGoalId: goalId,
      goals: [{
        id: goalId, sequence: 1, statement: '完成 GUI 项目', doneWhen: ['核心交互已验证'],
        status: 'active', requirementsVersion: 1, createdAt: 1, activatedAt: 1,
      }],
      subgoals: [{
        id: 'gui-stage', goalId, title: 'GUI 交互', outcome: '完成核心交互',
        acceptance: ['核心交互已验证'], dependencies: [], status: 'active', order: 1,
        createdAt: 1, updatedAt: 1,
      }],
      requirementsVersion: 1,
      authorizationVersion: 1,
      acceptedRequirementsVersion: 1,
      status: 'waiting',
      workItems: [{
        id: 'gui-work', goalId, subgoalId: 'gui-stage', title: 'GUI 交互',
        requirementsVersion: 1, authorizationVersion: 1,
        executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
        complexityAssessment: {
          complexity: 'medium', decision: 'single-task', signals: ['单一 GUI 成果'],
          rationale: '一个任务 AI 可以完成', assessedAt: 1,
        },
        taskWorkMode: 'single-thread', status: 'waiting-decision', dependencies: [], attempts: 0,
        updatedAt: 20, executionHistory: [],
        verificationLimitation: {
          kind: 'gui-automation-unavailable', detail: 'Win32 自动化通道不可用',
          missingEvidence: ['GUI 点击与输入结果'], affectedAcceptance: ['核心交互已验证'],
          requirementsVersion: 1, authorizationVersion: 1, detectedAt: 18,
        },
        verificationDecision: {
          action: 'defer-verification', questionId: 'question-gui', reason: 'Win32 自动化不可用',
          answeredBy: 'desktop', requirementsVersion: 1, authorizationVersion: 1, decidedAt: 19,
        },
        contract: {
          objective: '完成 GUI 交互', description: '', preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: {
            technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false,
          },
          stopWhen: ['核心交互已验证'], validation: ['运行 GUI 交互测试'],
          budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      }],
    });

    expect(() => saveProjectManagerSession(saved, appData)).not.toThrow();
    expect(recoveredSession(appData, saved.id)?.workItems[0].verificationDecision).toMatchObject({
      action: 'defer-verification', questionId: 'question-gui', answeredBy: 'desktop',
    });
    expect(recoveredSession(appData, saved.id)?.workItems[0].verificationLimitation).toMatchObject({
      kind: 'gui-automation-unavailable', missingEvidence: ['GUI 点击与输入结果'],
    });
    expect(recoveredSession(appData, saved.id)?.workItems[0].contract.stageAcceptanceCoverage)
      .toBeUndefined();

    saved.workItems[0].verificationDecision!.action = 'skip-verification';
    expect(() => saveProjectManagerSession(saved, appData)).not.toThrow();
    expect(recoveredSession(appData, saved.id)?.workItems[0].verificationDecision).toMatchObject({
      action: 'skip-verification', questionId: 'question-gui', answeredBy: 'desktop',
    });
  });

  it('atomically replaces one project snapshot without hiding a project from another directory', () => {
    const appData = root();
    saveProjectManagerSession({ ...session('pm-old', 10), projectDir: 'E:\\old' }, appData);
    saveProjectManagerSession({ ...session('pm-new', 20), projectDir: 'E:\\new' }, appData);
    saveProjectManagerSession({ ...session('pm-new', 30), projectDir: 'E:\\new' }, appData);
    expect(recoveredSession(appData, 'pm-new')?.updatedAt).toBe(30);
    expect(readActiveProjectManagerSessions(appData).map((candidate) => candidate.id)).toEqual(['pm-new', 'pm-old']);
  });  it('persists plan snapshots and a pending user clarification for recovery', () => {
    const appData = root();
    const pendingUserQuestion = {
      id: 'question-1',
      category: 'manual-intervention' as const,
      reasonCode: 'task-input-conflict' as const,
      workItemId: 'wol_validation',
      blocker: '需要用户进入 BIOS 进行真机验收',
      question: '是否允许覆盖现有配置？',
      context: '目标与计划文件存在冲突。',
      options: [
        { id: 'keep', label: '保留现有配置', confirmationScope: [] },
        { id: 'replace', label: '允许覆盖', confirmationScope: ['doneWhen: 新配置覆盖后可验证'] },
      ],
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
      agentConfig: {
        manager: { agent: 'kimi' as const, model: 'kimi-code/k3', reasoningEffort: '' },
        supervisor: { agent: 'codex' as const, model: 'gpt-5.6-terra', reasoningEffort: 'high' },
        task: { agent: 'grok' as const, model: 'grok-4.6', reasoningEffort: 'medium' },
        auxiliary: {
          enabled: true, allowProjectMaintenance: true,
          agent: 'codex' as const, model: 'gpt-5.6-terra', reasoningEffort: 'medium',
        },
      },
      agentIssue: {
        role: 'manager' as const, category: 'quota-limit' as const,
        summary: 'Weekly limit left: 0%', detectedAt: 12,
      },
      agentReconfiguration: {
        status: 'pending-safe-point' as const, requestedAt: 12,
        roles: ['manager', 'task'] as const, pendingRoles: ['task'] as const, completedRoles: ['manager'] as const,
      },
      pendingManagerDeliveries: [{
        id: 'delivery-1', text: '请按新条件重新规划', createdAt: 13,
        transitionId: 'transition-1', continuationKey: 'goal-2:R3:A1:orient-project:',
        stage: 'failed' as const, submittedAt: 14,
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
      orientation: {
        status: 'required' as const, requirementsVersion: 3, authorizationVersion: 1,
        snapshotFingerprint: 'progress-fingerprint', reason: '软件恢复后复核现状', requestedAt: 16,
      },
    };

    saveProjectManagerSession(saved, appData);

    expect(recoveredSession(appData, 'pm-plan')).toMatchObject({
      planFiles: [{ name: 'requirements.md', content: '# 需求' }],
      pendingUserQuestion: {
        id: 'question-1', previousStatus: 'active', category: 'manual-intervention',
        reasonCode: 'task-input-conflict', workItemId: 'wol_validation',
        options: expect.arrayContaining([
          expect.objectContaining({ id: 'replace', confirmationScope: ['doneWhen: 新配置覆盖后可验证'] }),
        ]),
      },
      requirementsVersion: 3,
      acceptedRequirementsVersion: 2,
      agentConfig: {
        manager: { agent: 'kimi', model: 'kimi-code/k3' },
        supervisor: { agent: 'codex', model: 'gpt-5.6-terra' },
        task: { agent: 'grok', model: 'grok-4.6' },
        auxiliary: { enabled: true, allowProjectMaintenance: true, agent: 'codex', model: 'gpt-5.6-terra' },
      },
      agentIssue: { role: 'manager', category: 'quota-limit', summary: 'Weekly limit left: 0%' },
      agentReconfiguration: {
        status: 'pending-safe-point', pendingRoles: ['task'], completedRoles: ['manager'],
      },
      pendingManagerDeliveries: [{
        id: 'delivery-1', text: '请按新条件重新规划', transitionId: 'transition-1',
        continuationKey: 'goal-2:R3:A1:orient-project:',
        stage: 'failed', submittedAt: 14,
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
      orientation: {
        status: 'required', requirementsVersion: 3,
        snapshotFingerprint: 'progress-fingerprint', reason: '软件恢复后复核现状',
      },
    });

    expect(() => saveProjectManagerSession({
      ...saved,
      id: 'pm-invalid-option-scope',
      projectDir: 'E:\\invalid-option-scope',
      pendingUserQuestion: {
        ...pendingUserQuestion,
        options: [
          { id: 'keep', label: '保留现有配置', confirmationScope: [] },
          { id: 'replace', label: '允许覆盖', confirmationScope: [''] },
        ],
      },
    }, appData)).toThrow('invalid project manager session payload');
  });  it('restores every active project across distinct directories', () => {
    const appData = root();
    saveProjectManagerSession({ ...session('pm-a', 50), projectDir: 'E:\\a' }, appData);
    saveProjectManagerSession({ ...session('pm-b', 40), projectDir: 'E:\\b' }, appData);
    saveProjectManagerSession({ ...session('pm-c', 30), projectDir: 'E:\\c' }, appData);
    saveProjectManagerSession({ ...session('pm-d', 20), projectDir: 'E:\\d' }, appData);
    saveProjectManagerSession({ ...session('pm-done', 60), projectDir: 'E:\\done', status: 'completed' }, appData);

    expect(readActiveProjectManagerSessions(appData).map((item) => item.id)).toEqual([
      'pm-a', 'pm-b', 'pm-c', 'pm-d',
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

  it('does not restore projects from an earlier execution protocol', () => {
    const appData = root();
    const directory = path.join(appData, 'project-manager');
    fs.mkdirSync(directory, { recursive: true });
    const old = session('pm-old-protocol', 100);
    fs.writeFileSync(path.join(directory, 'pm-old-protocol.json'), JSON.stringify({
      version: 1,
      session: {
        ...old,
        executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION - 1,
        workItems: old.workItems.map((item) => ({
          ...item,
          executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION - 1,
        })),
      },
    }), 'utf8');

    expect(recoveredSession(appData, 'pm-old-protocol')).toBeUndefined();
  });

  it('rejects malformed reusable user decisions during recovery', () => {
    const appData = root();
    const valid = normalizeProjectManagerSession({
      ...session('pm-reusable-corrupt', 100),
      reusableUserDecisions: [{
        id: 'decision-1', decisionKey: 'explicit:configuration', semanticFingerprint: 'semantic:0123456789abcdef',
        decisionScope: '配置冲突时是否保留兼容设置', category: 'clarification', question: '是否保留配置？',
        answer: '保留', optionId: 'keep', requirementsVersion: 1, authorizationVersion: 1,
        answeredBy: 'desktop', createdAt: 10,
      }],
    });
    const saved = saveProjectManagerSession(valid, appData).path;
    const payload = JSON.parse(fs.readFileSync(saved, 'utf8'));
    payload.session.reusableUserDecisions = [{ decisionKey: 7, answer: { unsafe: true } }];
    fs.writeFileSync(saved, JSON.stringify(payload), 'utf8');
    expect(recoveredSession(appData, valid.id)).toBeUndefined();
  });

  it('appends bounded audit records outside the project tree', () => {
    const appData = root();
    const result = appendProjectManagerRecord({
      sessionId: 'pm-audit', projectDir: 'E:\\repo', type: 'manager-reply', payload: { message: '完成' },
    }, appData);
    expect(result.path.startsWith(appData)).toBe(true);
    expect(fs.readFileSync(result.path, 'utf8')).toContain('manager-reply');
  });

  it('persists a recoverable safe-exit checkpoint', () => {
    const appData = root();
    saveProjectManagerSession({
      ...session('pm-safe-exit', 30),
      status: 'paused',
      safeExit: {
        status: 'saved',
        requestedAt: 20,
        updatedAt: 30,
        completedAt: 30,
        reason: '用户关闭项目',
        progressFingerprint: 'fingerprint-1',
        terminalCheckpoints: [{
          surfaceId: 'surface-manager',
          role: 'project-ai',
          label: '项目 AI',
          activityState: 'idle',
          activityUpdatedAt: 25,
          inputState: 'empty',
          excerpt: '已完成当前安全检查点',
        }],
      },
    }, appData);

    expect(recoveredSession(appData, 'pm-safe-exit')?.safeExit).toMatchObject({
      status: 'saved',
      progressFingerprint: 'fingerprint-1',
      terminalCheckpoints: [expect.objectContaining({
        role: 'project-ai', activityState: 'idle', inputState: 'empty',
      })],
    });
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
