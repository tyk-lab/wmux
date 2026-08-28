import { describe, expect, it } from 'vitest';
import { shouldRestartProjectManagerRuntime } from '../../src/renderer/project-manager/runtime-recovery-policy';
import { projectSupervisorRuntimeRequired } from '../../src/renderer/project-manager/runtime-admission-policy';
import { projectSupervisorBriefingStartupError } from '../../src/renderer/project-manager/supervisor-startup-policy';
import {
  buildProjectInternalRecoveryScopeKey,
  projectGoalClosurePauseWasMisclassified,
  projectInternalRecoveryAttempts,
  projectRecoveryExhaustionRequiresRuntimeEscalation,
  projectRouteRecoveryAlreadyAttempted,
} from '../../src/renderer/project-manager/semantic-recovery-policy';
import { projectTransitionResolutionError } from '../../src/renderer/project-manager/transition-policy';
import { projectWorkItemCreationError } from '../../src/renderer/project-manager/work-item-admission-policy';
import {
  projectStaleDeferredVerificationBlocker,
  projectSubgoalClosedByVerificationWaiver,
  projectWorkItemRequiresVersionReconciliation,
  projectWorkItemVerificationWaiverError,
  projectWorkItemVerificationWaiverRisk,
} from '../../src/renderer/project-manager/verification-intervention-policy';
import {
  normalizeProjectManagerSession,
  normalizeProjectOrientationState,
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
  it('treats a never-started dispatch deadlock as a runtime failure instead of a failed work route', () => {
    const planned = workItem({
      status: 'planned', attempts: 0, executionHistory: [],
      startedAt: undefined, latestEvidence: undefined, completion: undefined,
    });
    expect(projectRecoveryExhaustionRequiresRuntimeEscalation('dispatch-work', planned)).toBe(true);
    expect(projectRecoveryExhaustionRequiresRuntimeEscalation('recover-work', planned)).toBe(false);
    expect(projectRecoveryExhaustionRequiresRuntimeEscalation('dispatch-work', {
      ...planned, attempts: 1, executionHistory: [{
        ts: 2, action: '尝试执行成果', workspaceVersion: 'v1', consumedDecision: true,
      }],
    })).toBe(false);
  });

  it('allows only one automatic L2 replan for the same work item and project snapshot', () => {
    const project = normalizeProjectManagerSession({
      id: 'pm-route-once', projectDir: 'C:/project', goal: '交付成果', preconditions: [],
      planFiles: [], doneWhen: ['成果可验收'], status: 'active', requirementsVersion: 3,
      authorizationVersion: 2, acceptedRequirementsVersion: 3,
      executionProtocolVersion: 10, workItems: [], events: [], createdAt: 1, updatedAt: 1,
    });
    project.progressSnapshot = {
      version: 1, capturedAt: 1, mode: 'git', fingerprint: 'snapshot-current', entries: [], truncated: false,
    };
    project.events = [{
      id: 'route-assessment', sessionId: project.id, ts: 2,
      kind: 'project-orientation-confirmed', summary: '已完成一次路线重评估',
      payload: {
        recoveryLevel: 'route', recoveryWorkItemId: 'task-a',
        snapshotFingerprint: 'snapshot-current', requirementsVersion: 3, authorizationVersion: 2,
      },
    }];

    expect(projectRouteRecoveryAlreadyAttempted(project, 'task-a')).toBe(true);
    expect(projectRouteRecoveryAlreadyAttempted(project, 'task-b')).toBe(false);
    expect(projectRouteRecoveryAlreadyAttempted({
      ...project,
      events: [],
      orientation: {
        status: 'ready', requirementsVersion: 3, authorizationVersion: 2,
        snapshotFingerprint: 'snapshot-current', reason: '已完成 L2', requestedAt: 3,
        summary: '旧路线已退役', knownFacts: ['当前事实'], unknowns: [],
        workItems: [{
          workItemId: 'task-a', disposition: 'replan', basis: '同一阻碍', nextAction: '建立新链',
        }],
        recovery: {
          level: 'route', role: 'manager', triggerFingerprint: 'stable-route', blocker: '同一阻碍',
          occurrence: 2, requestedAt: 3, workItemId: 'task-a',
        },
        acknowledgedAt: 4,
      },
    }, 'task-a')).toBe(true);
    expect(projectRouteRecoveryAlreadyAttempted({
      ...project,
      progressSnapshot: { ...project.progressSnapshot, fingerprint: 'snapshot-with-new-evidence' },
    }, 'task-a')).toBe(false);
  });

  it('preserves structured recovery orientation and accepts an explicit replan disposition', () => {
    expect(normalizeProjectOrientationState({
      status: 'required', requirementsVersion: 3, authorizationVersion: 2,
      snapshotFingerprint: 'snapshot-a', reason: '异常恢复前重新核对', requestedAt: 10,
      recovery: {
        level: 'route', role: 'manager', triggerFingerprint: 'same-blocker',
        blocker: '同一阻碍连续出现', occurrence: 2, requestedAt: 10,
        workItemId: 'task-a', evidenceSummary: '两轮均无新证据',
      },
    })).toMatchObject({
      status: 'required',
      recovery: {
        level: 'route', role: 'manager', triggerFingerprint: 'same-blocker',
        occurrence: 2, workItemId: 'task-a',
      },
    });
    expect(normalizeProjectOrientationState({
      status: 'ready', requirementsVersion: 3, authorizationVersion: 2,
      snapshotFingerprint: 'snapshot-a', reason: '异常恢复前重新核对', requestedAt: 10,
      summary: '保留成果并重新安排剩余工作', knownFacts: ['已有成果继续有效'], unknowns: [],
      workItems: [{
        workItemId: 'task-a', disposition: 'replan',
        basis: '旧路线无新证据', nextAction: '按剩余验收重新派发',
      }],
      acknowledgedAt: 11,
      recovery: {
        level: 'route', role: 'manager', triggerFingerprint: 'same-blocker',
        blocker: '同一阻碍连续出现', occurrence: 2, requestedAt: 10, workItemId: 'task-a',
      },
    })?.workItems).toEqual([expect.objectContaining({ disposition: 'replan' })]);
  });

  it('starts a project supervisor only after a current work item owns execution', () => {
    const project = pausedCompletedProject();
    project.workItems = [];
    project.activeWorkItemId = undefined;
    expect(projectSupervisorRuntimeRequired(project)).toBe(false);

    const planned = workItem({ goalId: project.activeGoalId, status: 'planned' });
    project.workItems = [planned];
    expect(projectSupervisorRuntimeRequired(project)).toBe(false);

    project.workItems = [{ ...planned, status: 'waiting-decision', supervisorLaneId: 'lane-a' }];
    expect(projectSupervisorRuntimeRequired(project)).toBe(true);
  });

  it('trusts the mounted runtime ready verdict when a full-screen supervisor is transiently blank', () => {
    expect(projectSupervisorBriefingStartupError({
      runtimeState: 'ready', screen: '\n\n', nonElectronHarness: false,
    })).toBeNull();
    expect(projectSupervisorBriefingStartupError({
      runtimeState: 'starting', screen: 'PS C:\\repo>', nonElectronHarness: false,
    })).toContain('外层 Shell');
    expect(projectSupervisorBriefingStartupError({
      runtimeState: 'starting', screen: '', nonElectronHarness: false,
    })).toContain('未检测到 Codex');
  });

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

  it('keeps user-settled verification gaps out of version reconciliation and blocks successor admission', () => {
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
    expect(projectWorkItemCreationError({ subgoals, workItems: [deferred] }, successor))
      .toContain('已有开放成果工作项');
    expect(projectWorkItemCreationError({ subgoals, workItems: [deferred] }, {
      ...successor,
      dependencies: [deferred.id],
    })).toContain('不能依赖已由用户暂缓或跳过验证的旧工作项');

    const waived = {
      ...deferred,
      status: 'stopped' as const,
      verificationDecision: {
        ...deferred.verificationDecision!,
        action: 'skip-verification' as const,
      },
    };
    expect(projectWorkItemCreationError({ subgoals, workItems: [waived] }, successor))
      .toContain('必须留在原成果的监督链内');
  });

  it('detects an old deferred item that blocks a stage already covered by current evidence', () => {
    const project = normalizeProjectManagerSession({
      id: 'stale-defer-project', projectDir: 'C:/project', goal: '交付阶段成果',
      preconditions: [], planFiles: [], doneWhen: ['验收 A', '验收 B'], status: 'active',
      requirementsVersion: 6, authorizationVersion: 1, acceptedRequirementsVersion: 6,
      executionProtocolVersion: 10, workItems: [], events: [], createdAt: 1, updatedAt: 1,
    });
    const goalId = project.activeGoalId!;
    project.subgoals = [{
      id: 'stage-a', goalId, title: '阶段 A', outcome: '阶段成果',
      acceptance: ['验收 A', '验收 B'], dependencies: [], status: 'active',
      order: 1, createdAt: 1, updatedAt: 1,
    }];
    const deferred = workItem({
      id: 'old-deferred', goalId, subgoalId: 'stage-a', status: 'paused',
      requirementsVersion: 4,
      verificationDecision: {
        action: 'defer-verification', questionId: 'old-question', reason: '稍后人工验证',
        answeredBy: 'desktop', requirementsVersion: 2, authorizationVersion: 1, decidedAt: 2,
      },
    });
    const completed = workItem({
      id: 'current-evidence', goalId, subgoalId: 'stage-a', status: 'completed',
      requirementsVersion: 6,
      completion: {
        summary: '当前版本证据已覆盖阶段验收', validation: ['验收 A', '验收 B'], completedAt: 6,
        criteria: ['验收 A', '验收 B'].map((criterion) => ({
          criterion, status: 'satisfied' as const, result: 'passed' as const,
          method: 'evidence-review' as const, evidence: `${criterion} 已通过`,
          evidenceRefs: [`evidence/${criterion}.json`],
          evidenceArtifacts: [{
            ref: `evidence/${criterion}.json`, sizeBytes: 12, mtimeMs: 1, sha256: 'c'.repeat(64),
          }],
        })),
      },
    });
    project.workItems = [deferred, completed];

    expect(projectStaleDeferredVerificationBlocker(project)).toMatchObject({
      deferredItem: { id: deferred.id },
      completedSuccessor: { id: completed.id },
      subgoalId: 'stage-a',
    });
    expect(projectStaleDeferredVerificationBlocker({
      ...project,
      workItems: [{
        ...deferred,
        verificationDecision: {
          ...deferred.verificationDecision!, requirementsVersion: 6,
        },
      }, completed],
    })).toBeNull();
    const failedAfterRestart = normalizeProjectManagerSession(JSON.parse(JSON.stringify({
      ...project,
      workItems: [{ ...deferred, status: 'failed' }, completed],
    })));
    expect(projectStaleDeferredVerificationBlocker(failedAfterRestart)).toBeNull();
  });

  it('allows an audited standard verification waiver but rejects protected criteria and real failures', () => {
    const project = normalizeProjectManagerSession({
      id: 'waiver-project', projectDir: 'C:/project', goal: '交付 GUI 成果',
      preconditions: [], planFiles: [], doneWhen: ['GUI CRUD 可复核'], status: 'waiting',
      verificationPolicies: [{
        criterion: 'GUI CRUD 可复核', requirement: 'required', riskClass: 'standard',
        reason: '用户明确分类为普通成果',
      }],
      requirementsVersion: 1, authorizationVersion: 1, acceptedRequirementsVersion: 1,
      executionProtocolVersion: 10, workItems: [], events: [], createdAt: 1, updatedAt: 1,
    });
    const goalId = project.activeGoalId!;
    const limitation = {
      kind: 'gui-automation-unavailable' as const,
      detail: '当前环境无法执行可靠的 GUI 自动化',
      missingEvidence: ['GUI CRUD 实际交互证据'],
      affectedAcceptance: ['复核 GUI CRUD 实际交互'],
      requirementsVersion: 1,
      authorizationVersion: 1,
      detectedAt: 2,
    };
    const standard = workItem({
      goalId,
      status: 'waiting-decision',
      verificationLimitation: limitation,
      contract: {
        ...workItem().contract,
        validation: ['复核 GUI CRUD 实际交互'],
        stageAcceptanceCoverage: [{
          stageCriterion: 'GUI CRUD 可复核',
          verificationCriterion: '复核 GUI CRUD 实际交互',
        }],
      },
    });
    project.workItems = [standard];
    project.subgoals = [{
      id: 'stage-a', goalId, title: 'GUI 阶段', outcome: 'GUI CRUD 可用',
      acceptance: ['GUI CRUD 可复核'], dependencies: [], status: 'active',
      order: 1, createdAt: 1, updatedAt: 1,
    }];

    expect(projectWorkItemVerificationWaiverError(project, standard)).toBeNull();
    const defaultProtectedProject = normalizeProjectManagerSession({
      ...project,
      goals: undefined,
      activeGoalId: undefined,
      verificationPolicies: undefined,
      workItems: [standard],
    });
    expect(projectWorkItemVerificationWaiverError(defaultProtectedProject, {
      ...standard,
      goalId: defaultProtectedProject.activeGoalId,
    })).toContain('先确认保护性验收风险');
    expect(projectWorkItemVerificationWaiverError(defaultProtectedProject, {
      ...standard,
      goalId: defaultProtectedProject.activeGoalId,
    }, { riskAcknowledged: true })).toBeNull();
    const stageOnlyProject = {
      ...project,
      subgoals: project.subgoals?.map((stage) => ({
        ...stage,
        acceptance: ['阶段专用 GUI 验收'],
      })),
      workItems: [{
        ...standard,
        contract: {
          ...standard.contract,
          stageAcceptanceCoverage: [{
            stageCriterion: '阶段专用 GUI 验收',
            verificationCriterion: '复核 GUI CRUD 实际交互',
          }],
        },
      }],
    };
    expect(projectWorkItemVerificationWaiverError(stageOnlyProject, stageOnlyProject.workItems[0]))
      .toContain('先确认保护性验收风险');
    const ambiguousStage = {
      ...project,
      subgoals: project.subgoals?.map((stage) => ({
        ...stage,
        acceptance: ['GUI 新增可复核', 'GUI 删除可复核'],
      })),
      workItems: [{
        ...standard,
        contract: { ...standard.contract, stageAcceptanceCoverage: undefined },
      }],
    };
    expect(projectWorkItemVerificationWaiverError(ambiguousStage, ambiguousStage.workItems[0]))
      .toContain('没有可由用户明确豁免的验证条件');
    const waived = {
      ...standard,
      status: 'stopped' as const,
      verificationDecision: {
        action: 'skip-verification' as const,
        questionId: 'waiver-choice',
        reason: '用户不关心这项普通 GUI 验证',
        answeredBy: 'desktop' as const,
        requirementsVersion: 1,
        authorizationVersion: 1,
        decidedAt: 3,
      },
    };
    expect(projectSubgoalClosedByVerificationWaiver({ ...project, workItems: [waived] }, 'stage-a')).toBe(true);

    const protectedByContent = {
      ...standard,
      contract: {
        ...standard.contract,
        validation: ['权限与数据完整性验收通过'],
        stageAcceptanceCoverage: [{
          stageCriterion: 'GUI CRUD 可复核',
          verificationCriterion: '权限与数据完整性验收通过',
        }],
      },
      verificationLimitation: {
        ...limitation,
        affectedAcceptance: ['权限与数据完整性验收通过'],
      },
    };
    expect(projectWorkItemVerificationWaiverRisk(project, protectedByContent))
      .toContain('权限与数据完整性验收通过');
    expect(projectWorkItemVerificationWaiverError(project, protectedByContent))
      .toContain('先确认保护性验收风险');
    expect(projectWorkItemVerificationWaiverError(
      project,
      protectedByContent,
      { riskAcknowledged: true },
    )).toBeNull();

    const explicitProtectedProject = {
      ...project,
      goals: project.goals?.map((goal) => ({
        ...goal,
        verificationPolicies: [{
          criterion: 'GUI CRUD 可复核',
          requirement: 'required' as const,
          riskClass: 'protected' as const,
          reason: '用户明确标记为保护性条件',
        }],
      })),
    };
    expect(projectWorkItemVerificationWaiverError(explicitProtectedProject, standard))
      .toContain('先确认保护性验收风险');
    const protectedWaived = {
      ...standard,
      status: 'stopped' as const,
      verificationDecision: {
        ...waived.verificationDecision,
        riskAcknowledged: true,
      },
    };
    expect(projectWorkItemVerificationWaiverError(explicitProtectedProject, protectedWaived)).toBeNull();
    expect(projectSubgoalClosedByVerificationWaiver(
      { ...explicitProtectedProject, workItems: [protectedWaived] },
      'stage-a',
    )).toBe(true);

    const failed = {
      ...standard,
      status: 'failed' as const,
      completion: {
        summary: 'GUI 验证失败', validation: ['Delete 失败'], completedAt: 4,
        criteria: [{
          criterion: 'GUI CRUD 可复核', status: 'unsatisfied' as const, result: 'failed' as const,
          method: 'runtime-test' as const, evidence: 'Delete 操作失败', evidenceRefs: ['failure.log'],
        }],
      },
    };
    expect(projectWorkItemVerificationWaiverError(project, failed)).toContain('真实失败');
  });
});
