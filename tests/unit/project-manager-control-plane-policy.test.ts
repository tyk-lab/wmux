import { describe, expect, it } from 'vitest';
import { shouldRestartProjectManagerRuntime } from '../../src/renderer/project-manager/runtime-recovery-policy';
import {
  buildProjectInternalRecoveryScopeKey,
  projectGoalClosurePauseWasMisclassified,
  projectInternalRecoveryAttempts,
} from '../../src/renderer/project-manager/semantic-recovery-policy';
import { projectTransitionResolutionError } from '../../src/renderer/project-manager/transition-policy';
import { projectWorkItemCreationError } from '../../src/renderer/project-manager/work-item-admission-policy';
import {
  projectWorkItemRequiresVersionReconciliation,
} from '../../src/renderer/project-manager/verification-intervention-policy';
import {
  normalizeProjectManagerSession,
  type ProjectManagerEvent,
  type ProjectManagerSession,
  type ProjectSupervisorTransition,
  type ProjectWorkItem,
} from '../../src/shared/project-manager';

function workItem(overrides: Partial<ProjectWorkItem> = {}): ProjectWorkItem {
  return {
    id: 'task-a',
    goalId: 'goal-a',
    subgoalId: 'stage-a',
    requirementsVersion: 1,
    authorizationVersion: 1,
    executionProtocolVersion: 10,
    complexityAssessment: {
      complexity: 'low',
      decision: 'single-task',
      signals: ['单一成果'],
      rationale: '保持单一成果',
      assessedAt: 1,
    },
    taskWorkMode: 'single-thread',
    title: '阶段成果',
    contract: {
      objective: '交付阶段成果',
      description: '',
      preconditions: [],
      supervisorNotes: [],
      scope: { root: 'C:/project', allowPaths: [], denyPaths: [], forbiddenActions: [] },
      authority: {
        technicalChoices: true,
        lowRiskRetries: true,
        routeAdjustments: true,
        targetedTests: true,
        internalThreads: true,
        continuousExecution: true,
        permissionConfirm: true,
        allowedCommandPrefixes: [],
      },
      stopWhen: ['成果可运行'],
      validation: ['验收 A', '验收 B'],
      stageAcceptanceCoverage: [
        { stageCriterion: '验收 A', verificationCriterion: '验收 A' },
        { stageCriterion: '验收 B', verificationCriterion: '验收 B' },
      ],
      budget: {
        maxTaskRetries: 2,
        maxIdenticalFailures: 2,
        maxSameTestRuns: 2,
        maxFullSuiteRunsPerVersion: 1,
        maxNoProgressRounds: 2,
        maxAggregateWorkerMinutes: 60,
      },
    },
    status: 'planned',
    dependencies: [],
    attempts: 0,
    decisionsUsed: 0,
    executionHistory: [],
    ...overrides,
  };
}

const transition: ProjectSupervisorTransition = {
  id: 'transition-a',
  laneId: 'lane-a',
  workItemId: 'task-a',
  kind: 'decision-required',
  eventType: 'supervisor.decision-required',
  summary: '需要恢复',
  createdAt: 1,
  notifiedAt: 1,
  notificationCount: 1,
};

function pausedCompletedProject(): ProjectManagerSession {
  const project = normalizeProjectManagerSession({
    id: 'project-a', projectDir: 'C:/project', goal: '完成项目',
    preconditions: [], planFiles: [], doneWhen: ['成果已验收'], status: 'paused',
    requirementsVersion: 1, authorizationVersion: 1, acceptedRequirementsVersion: 1,
    executionProtocolVersion: 10, workItems: [], events: [], createdAt: 1, updatedAt: 1,
  });
  const goalId = project.activeGoalId!;
  project.workItems = [workItem({
    id: 'validated-result', goalId, subgoalId: 'validated-stage', status: 'completed',
  })];
  project.subgoals = [{
    id: 'validated-stage', goalId, title: '已验收阶段', outcome: '形成已验收成果',
    acceptance: [project.doneWhen[0]], dependencies: [], status: 'achieved',
    order: 1, createdAt: 1, updatedAt: 10,
  }];
  const incidentKey = `project-internal-recovery:role-41:${project.id}:project:project-execution-deadlock:complete-goal`;
  project.events = [{
    id: 'legacy-goal-closure-exhausted', sessionId: project.id, ts: 9,
    kind: 'guard-triggered', summary: '旧版目标收口恢复已耗尽',
    payload: {
      reason: 'project-internal-recovery-exhausted', obligation: 'complete-goal', recoveryKey: incidentKey,
    },
  }, {
    id: 'legacy-goal-closure-pause', sessionId: project.id, ts: 10,
    kind: 'project-paused', summary: '旧版控制层自动暂停目标收口',
    payload: { source: 'runtime', attentionRequired: false },
  }, {
    id: 'legacy-goal-closure-stall', sessionId: project.id, ts: 11,
    kind: 'project-execution-stalled', summary: '旧版控制层误判目标收口为执行停滞',
    payload: { incidentKey, automaticPause: true },
  }];
  return project;
}

describe('project manager control-plane policies', () => {
  it('restarts only an unavailable manager runtime', () => {
    expect(shouldRestartProjectManagerRuntime({
      managerPresent: true, runtimeState: 'ready', shellFailure: false, ptyPresent: true,
    })).toBe(false);
    expect(shouldRestartProjectManagerRuntime({
      managerPresent: true, runtimeState: 'ready', shellFailure: false, ptyPresent: false,
    })).toBe(true);
    expect(shouldRestartProjectManagerRuntime({
      managerPresent: true, runtimeState: 'exited', shellFailure: false,
    })).toBe(true);
  });

  it('shares recovery attempts across incident names until material state changes', () => {
    const scope = buildProjectInternalRecoveryScopeKey({
      protocolRevision: '40', sessionId: 'project-a', workItemId: 'task-a', baselineFingerprint: 'same-state',
    });
    const events = [1, 2].map((attempt): ProjectManagerEvent => ({
      id: `event-${attempt}`,
      sessionId: 'project-a',
      ts: attempt,
      kind: 'project-recovery-requested',
      summary: '内部恢复',
      payload: {
        recoveryKey: `incident-${attempt}`,
        recoveryScopeKey: scope,
      },
    }));
    expect(projectInternalRecoveryAttempts(events, scope)).toBe(2);

    const resetAndRetryAtSameTimestamp: ProjectManagerEvent[] = [
      events[0],
      {
        id: 'reset', sessionId: 'project-a', ts: 2,
        kind: 'supervisor-transition-acknowledged', summary: '恢复完成',
        payload: { resolution: 'recovered' },
      },
      { ...events[1], id: 'retry-after-reset', ts: 2 },
    ];
    expect(projectInternalRecoveryAttempts(resetAndRetryAtSameTimestamp, scope)).toBe(1);
  });

  it('reclassifies only the persisted legacy complete-goal deadlock pause', () => {
    const project = pausedCompletedProject();

    expect(projectGoalClosurePauseWasMisclassified(project)).toBe(true);
    expect(projectGoalClosurePauseWasMisclassified({
      ...project,
      workItems: project.workItems.map((item) => ({ ...item, status: 'paused' })),
    })).toBe(false);
    expect(projectGoalClosurePauseWasMisclassified({ ...project, events: [] })).toBe(false);
    expect(projectGoalClosurePauseWasMisclassified({
      ...project,
      events: [...project.events, {
        id: 'later-user-pause', sessionId: project.id, ts: 12,
        kind: 'project-paused', summary: '用户后来明确保持暂停',
        payload: { source: 'user' },
      }],
    })).toBe(false);
  });

  it('accepts recovered only for a matching active assignment', () => {
    const item = workItem({
      status: 'waiting-decision',
      supervisorLaneId: 'lane-a',
      workerSurfaceId: 'surface-a',
      assignmentVersion: 3,
    });
    expect(projectTransitionResolutionError({
      transition,
      resolution: 'recovered',
      sessionStatus: 'active',
      activeGoalAchieved: false,
      userQuestionPending: false,
      events: [],
      workItem: item,
      activeBinding: { laneId: 'lane-a', taskSurfaceId: 'surface-a', assignmentVersion: 3 },
    })).toBeNull();
    expect(projectTransitionResolutionError({
      transition,
      resolution: 'continued',
      sessionStatus: 'active',
      activeGoalAchieved: false,
      userQuestionPending: false,
      events: [],
      workItem: item,
      activeBinding: { laneId: 'lane-a', taskSurfaceId: 'surface-a', assignmentVersion: 3 },
    })).toContain('running');
  });

  it('blocks duplicate stage work and requires one successor to cover every remaining acceptance', () => {
    const subgoals = [{
      id: 'stage-a', goalId: 'goal-a', title: '阶段 A', outcome: '阶段成果',
      acceptance: ['验收 A', '验收 B'], dependencies: [], status: 'planned' as const,
      order: 1, createdAt: 1, updatedAt: 1,
    }];
    const candidate = workItem({ id: 'task-next' });
    expect(projectWorkItemCreationError({ subgoals, workItems: [workItem()] }, candidate))
      .toContain('已有开放成果工作项');

    const completed = workItem({
      status: 'completed',
      completion: {
        summary: '完成验收 A',
        validation: ['验收 A'],
        completedAt: 2,
        criteria: [{
          criterion: '验收 A', status: 'satisfied', result: 'passed', method: 'evidence-review',
          evidence: '证据 A', evidenceRefs: ['evidence/a.json'],
          evidenceArtifacts: [{
            ref: 'evidence/a.json', sizeBytes: 12, mtimeMs: 1, sha256: 'a'.repeat(64),
          }],
        }],
      },
    });
    const missingRemainder = workItem({
      id: 'task-next',
      contract: { ...candidate.contract, validation: ['验收 A'] },
    });
    missingRemainder.contract.stageAcceptanceCoverage = [
      { stageCriterion: '验收 A', verificationCriterion: '验收 A' },
    ];
    expect(projectWorkItemCreationError({ subgoals, workItems: [completed] }, missingRemainder))
      .toContain('当前缺少：验收 B');
    expect(projectWorkItemCreationError({ subgoals, workItems: [completed] }, candidate)).toBeNull();

    const fullyCompleted = workItem({
      status: 'completed',
      completion: {
        summary: '阶段验收已覆盖',
        validation: ['验收 A', '验收 B'],
        completedAt: 3,
        criteria: ['验收 A', '验收 B'].map((criterion) => ({
          criterion,
          status: 'satisfied' as const,
          result: 'passed' as const,
          method: 'evidence-review' as const,
          evidence: `${criterion} 证据`,
          evidenceRefs: [`evidence/${criterion}.json`],
          evidenceArtifacts: [{
            ref: `evidence/${criterion}.json`, sizeBytes: 12, mtimeMs: 1, sha256: 'b'.repeat(64),
          }],
        })),
      },
    });
    expect(projectWorkItemCreationError({ subgoals, workItems: [fullyCompleted] }, candidate))
      .toContain('必须先用 goal-plan 将阶段更新为 achieved');

    const incompleteEvidence = {
      ...fullyCompleted,
      completion: {
        ...fullyCompleted.completion!,
        criteria: fullyCompleted.completion!.criteria!.map((criterion) => ({
          ...criterion,
          evidenceArtifacts: undefined,
        })),
      },
    };
    const coverageOnlyB = workItem({
      id: 'task-next',
      contract: {
        ...candidate.contract,
        stageAcceptanceCoverage: [
          { stageCriterion: '验收 B', verificationCriterion: '验收 B' },
        ],
      },
    });
    expect(projectWorkItemCreationError({ subgoals, workItems: [incompleteEvidence] }, coverageOnlyB))
      .toContain('当前缺少：验收 A');
  });

  it('keeps user-settled verification gaps out of version reconciliation and successor admission gates', () => {
    const project = pausedCompletedProject();
    project.requirementsVersion = 2;
    project.authorizationVersion = 2;
    const deferred = workItem({
      id: 'deferred-verification',
      goalId: 'goal-a',
      status: 'paused',
      verificationDecision: {
        action: 'defer-verification',
        questionId: 'verification-choice',
        reason: '用户选择稍后验证',
        answeredBy: 'desktop',
        requirementsVersion: 1,
        authorizationVersion: 1,
        decidedAt: 2,
      },
    });
    expect(projectWorkItemRequiresVersionReconciliation(project, deferred)).toBe(false);
    expect(projectWorkItemRequiresVersionReconciliation(project, {
      ...deferred,
      verificationDecision: undefined,
    })).toBe(true);

    const subgoals = [{
      id: 'stage-a', goalId: 'goal-a', title: '阶段 A', outcome: '阶段成果',
      acceptance: ['验收 A', '验收 B'], dependencies: [], status: 'planned' as const,
      order: 1, createdAt: 1, updatedAt: 1,
    }];
    const successor = workItem({ id: 'focused-verification' });
    expect(projectWorkItemCreationError({ subgoals, workItems: [deferred] }, successor)).toBeNull();
    expect(projectWorkItemCreationError({ subgoals, workItems: [deferred] }, {
      ...successor,
      dependencies: [deferred.id],
    })).toContain('不能依赖已由用户暂缓或跳过验证的旧工作项');
  });
});
