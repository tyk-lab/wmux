import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeSupervisorDelivery,
  auditProjectLiveness,
  cleanupOrphanedProjectRuntimeSurfaces,
  initPipeBridge,
  ordinaryClarificationQuestions,
  permissionCommandMatchesEvidence,
  projectContractAutonomyPermissions,
  projectMessageChangeSignal,
  projectSafeExitEffectiveActivity,
  projectSupervisorTransitionRedeliveryMs,
  redactProjectSafeExitExcerpt,
  shouldSupersedeStoppedSupervisorLane,
  shouldScheduleProjectSupervisorTransitionReminder,
  readTerminalScreen,
  terminalBootstrapContext,
  terminalConversationExcerpt,
  terminalScreenExcerpt,
  terminalSupervisorCoreExcerpt,
} from '../../src/renderer/pipe-bridge';
import { surfaceTerminalRegistry } from '../../src/renderer/hooks/useTerminal';
import {
  clearSupervisorEvidenceCache,
  createSupervisorEvidenceSnapshot,
  registerSupervisorEvidence,
} from '../../src/renderer/supervisor/evidence';
import { useStore } from '../../src/renderer/store';
import {
  ORDINARY_SUPERVISION_PROTOCOL_VERSION,
  type SupervisorLane,
} from '../../src/renderer/store/supervisor-slice';
import { interactiveAgentPromptReady } from '../../src/renderer/utils/interactive-agent-runtime';
import {
  DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
  PROJECT_MANAGER_TERMINAL_NAME,
} from '../../src/shared/project-manager-terminal';
import { SUPERVISOR_NO_DECISION_OPTION } from '../../src/shared/supervisor-decision-options';
import {
  activeProjectManagerAttentionEvent,
  CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
  DEFAULT_PROJECT_EXECUTION_BUDGET,
  type ProjectManagerSession,
  type ProjectProgressSnapshot,
} from '../../src/shared/project-manager';
import {
  USER_RECORDS_TERMINAL_AGENT,
  USER_RECORDS_TERMINAL_DIRECTORY,
  USER_RECORDS_TERMINAL_NAME,
  USER_RECORDS_TERMINAL_STARTUP_INPUT,
} from '../../src/shared/user-records-terminal';
import {
  clearTerminalRuntimeStatus,
  markTerminalRuntimeExited,
  markTerminalRuntimeReady,
  terminalRuntimeStatus,
} from '../../src/renderer/terminal-runtime-lifecycle';
import {
  effectiveSupervisorAutonomyPermissions,
  PROJECT_MANAGER_WORKSPACE_TITLE,
} from '../../src/renderer/supervisor/protocol';
import { prepareTerminalPasteInput } from '../../src/renderer/supervisor/supervisor-engine';
import { confirmSupervisorUserSubmitFromHook } from '../../src/renderer/supervisor/user-input-precedence';
import { openProjectManagerConsole } from '../../src/renderer/project-manager/console-surface';

async function confirmProjectOrientation(projectId: string): Promise<void> {
  const session = useStore.getState().projectManagers.find((project) => project.id === projectId);
  const request = (globalThis.window as any).__wmux_projectManagerRequest;
  const activeGoalId = session?.activeGoalId;
  const workItems = (session?.workItems || []).filter((item) => item.status !== 'stopped').map((item) => ({
    workItemId: item.id,
    disposition: item.status === 'completed'
      ? 'retain-completed'
      : item.goalId === activeGoalId
        && item.requirementsVersion === session?.requirementsVersion
        && item.authorizationVersion === session?.authorizationVersion
        ? 'verify'
        : 'pause',
    basis: item.status === 'completed' ? '已有完成证据需要保留' : '按当前目标和目录重新核对任务',
    nextAction: item.status === 'completed' ? '作为后续规划证据' : '建立当前任务基线后继续或暂缓',
  }));
  await expect(request({
    action: 'orientation-confirm', callerSurfaceId: session?.managerSurfaceId, projectId,
    requirementsVersion: session?.orientation?.requirementsVersion,
    authorizationVersion: session?.orientation?.authorizationVersion,
    snapshotFingerprint: session?.orientation?.snapshotFingerprint,
    requestedAt: session?.orientation?.requestedAt,
    summary: '已核对当前测试目标、目录快照和全部工作项状态',
    knownFacts: ['当前目录快照与测试状态已经读取'],
    unknowns: [],
    workItems,
  })).resolves.toMatchObject({ ok: true, orientation: { status: 'ready' } });
}

function lane(): SupervisorLane {
  return {
    id: 'lane-a',
    label: 'worker',
    surfaceId: 'worker-a' as any,
    supervisorSurfaceId: 'supervisor-a' as any,
    projectDir: 'E:\\repo',
    ordinaryProtocolVersion: ORDINARY_SUPERVISION_PROTOCOL_VERSION,
    controlState: 'active',
    awaitingStopCheck: false,
    stopConfirmed: false,
    awaitingReview: false,
    autoDecisionsUsed: 0,
    decisions: [],
    config: {
      taskGoal: '完成当前测试任务', taskDescription: '', preconditions: '',
      stopWhen: '测试任务完成', stopWhenKind: 'concrete', planFilePath: '', planRevision: 1,
    },
  };
}

function queuedOwnerDecision(laneId = 'lane-a') {
  return useStore.getState().supervisor.lanes.find((candidate) => candidate.id === laneId)
    ?.pendingSupervisorDeliveries?.find((delivery) => delivery.kind === 'owner-decision');
}

function consumeQueuedOwnerDecision(laneId = 'lane-a'): void {
  const store = useStore.getState();
  const target = store.supervisor.lanes.find((candidate) => candidate.id === laneId);
  if (!target) return;
  const delivery = target.pendingSupervisorDeliveries?.find((candidate) => candidate.kind === 'owner-decision');
  if (delivery) acknowledgeSupervisorDelivery(laneId, delivery);
  store.updateLane(laneId, {
    pendingSupervisorDeliveries: (target.pendingSupervisorDeliveries || [])
      .filter((delivery) => delivery.kind !== 'owner-decision'),
  });
}

function consumeQueuedControlMessage(laneId = 'lane-a'): void {
  const store = useStore.getState();
  const target = store.supervisor.lanes.find((candidate) => candidate.id === laneId);
  if (!target) return;
  for (const delivery of target.pendingSupervisorDeliveries || []) {
    if (delivery.kind === 'control-message') acknowledgeSupervisorDelivery(laneId, delivery);
  }
  const current = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === laneId);
  if (!current) return;
  store.updateLane(laneId, {
    pendingSupervisorDeliveries: (current.pendingSupervisorDeliveries || [])
      .filter((delivery) => delivery.kind !== 'control-message'),
  });
}

function queuedControlText(laneId = 'lane-a'): string {
  return useStore.getState().supervisor.lanes.find((candidate) => candidate.id === laneId)
    ?.pendingSupervisorDeliveries?.filter((delivery) => delivery.kind === 'control-message')
    .map((delivery) => delivery.text).join('\n') || '';
}

function acknowledgeTaskPrompt(surfaceId = 'worker-a'): void {
  (globalThis.window as any).__wmux_noteManagedAgentHook({
    surfaceId,
    event: 'UserPromptSubmit',
    task: '测试中的监督任务投递',
  });
}

function useAcknowledgedTaskDelivery(): void {
  (globalThis.window as any).wmux.pty.writeReliable = vi.fn(async (surfaceId: string, data: string) => {
    (globalThis.window as any).wmux.pty.write(surfaceId, data);
    if (data === '\r') acknowledgeTaskPrompt(surfaceId);
    return true;
  });
}

async function completionEvidenceToken(refs = ['evidence/result.json']): Promise<string> {
  const lane = useStore.getState().supervisor.lanes.find((candidate) => candidate.surfaceId === 'worker-a');
  const result = await (globalThis.window as any).__wmux_supervisorVerifyCompletionEvidence({
    surfaceId: 'worker-a',
    supervisorSurfaceId: lane?.supervisorSurfaceId,
    refs,
  });
  expect(result).toMatchObject({ ok: true, token: expect.any(String) });
  return result.token;
}

async function confirmAndResumeProject(projectId: string): Promise<void> {
  const session = useStore.getState().projectManagers.find((project) => project.id === projectId);
  const request = (globalThis.window as any).__wmux_projectManagerRequest;
  const confirmation = useStore.getState().appendProjectManagerEvent({
    kind: 'user-clarification-answered',
    summary: '用户确认测试需求',
    payload: { category: 'clarification', optionId: 'confirm-requirements' },
  }, projectId);
  expect(confirmation).toBeDefined();
  await expect(request({
    action: 'alignment-confirm', callerSurfaceId: session?.managerSurfaceId, projectId,
    userConfirmationEventId: confirmation?.id,
    goalUnderstanding: `按已保存目标推进：${session?.goal || projectId}`,
    scopeSummary: `工作范围严格限制在 ${session?.projectDir || '项目目录'}`,
    acceptanceSummary: (session?.doneWhen || []).join('；') || '按项目完成条件验收',
    reason: '测试场景已明确目标、目录边界和可验证完成标准',
  })).resolves.toMatchObject({ ok: true });
  await confirmProjectOrientation(projectId);
  await expect(request({
    action: 'goal-plan', callerSurfaceId: session?.managerSurfaceId, projectId,
    reason: '测试阶段计划',
    subgoals: [{
      id: 'test_stage', title: '完成测试目标', outcome: '测试目标形成可验收结果',
      acceptance: session?.doneWhen || ['按项目完成条件验收'], dependencies: [], status: 'planned',
    }],
  })).resolves.toMatchObject({ ok: true });
  await expect(request({
    action: 'resume', callerSurfaceId: session?.managerSurfaceId, projectId,
    reason: '首次需求检测完成后继续',
  })).resolves.toMatchObject({ ok: true });
}

function progressSnapshot(fingerprint = 'test-progress'): ProjectProgressSnapshot {
  return {
    version: 1,
    capturedAt: Date.now(),
    mode: 'git',
    fingerprint,
    head: 'head-test',
    branch: 'main',
    entries: [],
    truncated: false,
  };
}

function auxiliaryProjectRuntimeIdleStates(projectId: string, excludedSurfaceIds: string[] = []) {
  const excluded = new Set(excludedSurfaceIds);
  const states: Record<string, { state: 'idle'; blockedReason: null; blockedVersion: number; updatedAt: number }> = {};
  for (const workspace of useStore.getState().workspaces) {
    if (workspace.splitTree.type !== 'leaf') continue;
    for (const surface of workspace.splitTree.surfaces) {
      const owned = surface.projectManagerProjectId === projectId || surface.projectSupervisorProjectId === projectId;
      if (!owned || excluded.has(surface.id)) continue;
      states[surface.id] = { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() };
      surfaceTerminalRegistry.set(surface.id, {
        buffer: {
          active: {
            baseY: 0, cursorX: 0, cursorY: 0, length: 1,
            getLine: () => ({ translateToString: () => '' }),
          },
        },
      } as any);
      markTerminalRuntimeReady(surface.id);
    }
  }
  return states;
}

function bindProjectLaneToWorkItem(options: {
  projectId?: string;
  workItemId?: string;
  continuousExecution?: boolean;
  permissionConfirm?: boolean;
  allowedCommandPrefixes?: string[];
} = {}): ProjectManagerSession {
  const projectId = options.projectId || 'pm-project';
  const workItemId = options.workItemId || 'task-a';
  const project: ProjectManagerSession = {
    id: projectId,
    projectDir: 'E:\\repo',
    goal: '完成当前测试项目',
    preconditions: ['无额外物理前置条件'],
    planFiles: [],
    doneWhen: ['相关测试通过'],
    requirementsVersion: 1,
    acceptedRequirementsVersion: 1,
    executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
    progressSnapshot: progressSnapshot(),
    progressSync: {
      status: 'ready', checkedAt: 1, snapshotFingerprint: 'test-progress',
      summary: '测试项目现状已同步', changeCount: 0,
    },
    orientation: {
      status: 'ready', requirementsVersion: 1, authorizationVersion: 1,
      snapshotFingerprint: 'test-progress', reason: '测试项目认知已确认',
      requestedAt: 1, summary: '测试项目状态已知', knownFacts: ['测试事实'], unknowns: [],
      workItems: [{ workItemId, disposition: 'continue', basis: '当前测试工作项', nextAction: '继续测试' }],
      acknowledgedAt: 1,
    },
    status: 'active',
    workItems: [{
      id: workItemId,
      requirementsVersion: 1,
      authorizationVersion: 1,
      executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
      complexityAssessment: {
        complexity: 'medium',
        decision: 'single-task',
        signals: ['测试工作项只有一个独立可验收成果'],
        rationale: '测试监督链只需要一个任务 AI 连续完成当前成果',
        assessedAt: 1,
      },
      title: workItemId,
      status: 'running',
      dependencies: [],
      supervisorLaneId: 'lane-a',
      workerSurfaceId: 'worker-a',
      attempts: 0,
      updatedAt: 1,
      executionHistory: [],
      contract: {
        objective: '完成当前测试任务',
        description: '',
        preconditions: ['无额外物理前置条件'],
        scope: { root: 'E:\\repo', allowPaths: [], denyPaths: [], forbiddenActions: [] },
        authority: {
          technicalChoices: true,
          lowRiskRetries: true,
          targetedTests: true,
          internalThreads: false,
          continuousExecution: options.continuousExecution === true,
          permissionConfirm: options.permissionConfirm === true,
          allowedCommandPrefixes: options.allowedCommandPrefixes || [],
        },
        stopWhen: ['测试任务完成'],
        validation: ['检查相关测试结果'],
        budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      },
    }],
    events: [],
    createdAt: 1,
    updatedAt: 1,
  };
  useStore.getState().restoreProjectManager(project);
  useStore.getState().updateLane('lane-a', {
    projectManagerProjectId: projectId,
    projectWorkItemId: workItemId,
    autonomousOverride: true,
    autonomyPermissionsOverride: [
      'same-route-next',
      ...(options.permissionConfirm ? ['permission-confirm' as const] : []),
    ],
  });
  return project;
}

function attachProjectManagerSurface(projectId: string, managerSurfaceId: string): void {
  const session = useStore.getState().projectManagers.find((candidate) => candidate.id === projectId);
  if (!session) throw new Error(`missing project ${projectId}`);
  useStore.getState().restoreProjectManager({ ...session, managerSurfaceId: managerSurfaceId as any });
  useStore.getState().replaceAllWorkspaces([{
    id: `ws-${managerSurfaceId}` as any,
    title: '项目门禁续作测试',
    cwd: session.projectDir,
    transientSupervisorWorkspace: true,
    splitTree: {
      type: 'leaf' as const,
      paneId: `pane-${managerSurfaceId}` as any,
      activeSurfaceIndex: 0,
      surfaces: [{
        id: managerSurfaceId as any,
        type: 'terminal' as const,
        shell: 'pwsh.exe',
        projectManagerTerminal: true,
        projectManagerProjectId: projectId,
        projectManagerAgent: 'codex',
      }],
    },
  }]);
}

function bindAuthorizedPiOptimizationProject(projectId: string): ProjectManagerSession {
  const project = bindProjectLaneToWorkItem({ projectId });
  const store = useStore.getState();
  const current = store.projectManagers.find((candidate) => candidate.id === project.id)!;
  const goal = '验证既有 PI；若效果不理想，在原设备和安全边界内优化 PI 参数并重新资格';
  const doneWhen = [
    '既有 PI 的资格结果有正式证据',
    '完成有界 PI 参数探索并对新冻结候选重新资格',
  ];
  store.restoreProjectManager({
    ...current,
    goal,
    doneWhen,
    supervisorNotes: ['多点尝试不同电流和 PI 参数，确认稳定参数是否可用'],
    goals: (current.goals || []).map((entry) => entry.id === current.activeGoalId
      ? { ...entry, statement: goal, doneWhen }
      : entry),
    workItems: current.workItems.map((item) => ({
      ...item,
      contract: {
        ...item.contract,
        objective: '验证既有 PI 并为主目标提供资格证据',
        authority: { ...item.contract.authority, routeAdjustments: true },
      },
    })),
  });
  attachProjectManagerSurface(project.id, `manager-${project.id}`);
  return useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
}async function startTaskThroughDedicatedSupervisor(projectId: string, workItemId: string) {
  const request = (globalThis.window as any).__wmux_projectManagerRequest;
  const session = useStore.getState().projectManagers.find((project) => project.id === projectId);
  const created = await request({
    action: 'supervisor-assign',
    callerSurfaceId: session?.managerSurfaceId,
    projectId,
    workItemId,
  });
  expect(created, JSON.stringify(created)).toMatchObject({
    ok: true,
    workItemId,
    laneId: expect.any(String),
    surfaceId: expect.any(String),
  });
  const lane = useStore.getState().supervisor.lanes.find((candidate) => (
    candidate.projectManagerProjectId === projectId && candidate.projectWorkItemId === workItemId
  ));
  expect(lane).toMatchObject({
    supervisorSurfaceId: expect.any(String),
    surfaceId: created.surfaceId,
    autonomousOverride: true,
    workScopeOverride: 'project',
    forbiddenActionsOverride: expect.any(Array),
  });
  expect(lane?.autonomyPermissionsOverride).toContain('same-route-next');

  const taskLocation = useStore.getState().workspaces.flatMap((workspace) => (
    workspace.splitTree.type === 'leaf'
      ? workspace.splitTree.surfaces.map((surface) => ({ workspace, surface }))
      : []
  )).find(({ surface }) => surface.id === created.surfaceId);
  expect(taskLocation?.surface).toMatchObject({
    projectManagerProjectId: projectId,
    projectManagerWorkItemId: workItemId,
  });
  expect(taskLocation?.workspace.transientSupervisorWorkspace).not.toBe(true);
  const supervisorLocation = useStore.getState().workspaces.flatMap((workspace) => (
    workspace.splitTree.type === 'leaf'
      ? workspace.splitTree.surfaces.map((surface) => ({ workspace, surface }))
      : []
  )).find(({ surface }) => surface.id === lane?.supervisorSurfaceId);
  expect(supervisorLocation?.workspace.id).toBe(taskLocation?.workspace.id);
  expect(
    supervisorLocation?.workspace.splitTree.type === 'leaf'
      ? supervisorLocation.workspace.splitTree.paneId
      : undefined,
  ).toBe(
    taskLocation?.workspace.splitTree.type === 'leaf'
      ? taskLocation.workspace.splitTree.paneId
      : undefined,
  );
  expect(useStore.getState().workspaces.filter((workspace) => (
    workspace.splitTree.type === 'leaf'
    && workspace.splitTree.surfaces.some((surface) => (
      surface.projectManagerProjectId === projectId
      || surface.projectSupervisorProjectId === projectId
    ))
  ))).toHaveLength(1);
  expect(useStore.getState().projectManagers.find((project) => project.id === projectId))
    .toMatchObject({ taskTerminalSurfaceId: created.surfaceId, activeWorkItemId: workItemId });
  return { created, lane, pendingLane: lane };
}
describe('supervisor decision bridge', () => {
  const writes = vi.fn();
  let screenText: string;
  let agentState: {
    state: string;
    blockedReason: string | null;
    blockedVersion: number;
    blockedRequestId?: string | null;
    updatedAt: number;
  };

  beforeEach(() => {
    writes.mockReset();
    screenText = '';
    agentState = { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: 1 };
    surfaceTerminalRegistry.set('worker-a', {
      buffer: {
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          length: 1,
          getLine: () => ({ translateToString: (_trimRight?: boolean, start = 0, end?: number) => screenText.slice(start, end) }),
        },
      },
    } as any);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        wmux: {
          pty: {
            write: writes,
            stageInputFile: vi.fn(async (
              _surfaceId: string,
              _text: string,
              isolationScope: 'ordinary' | 'project',
            ) => ({
              reference: `.wmux/tmp/terminal-input/${isolationScope}/terminal-input-1234-abcd1234.txt`,
            })),
          },
          notification: { fire: vi.fn() },
          projectManager: {
            ensureSkill: vi.fn(async () => ({
              ok: true,
              runtimeDir: 'E:\\wmux-data\\project-manager\\runtime',
            })),
            saveSession: vi.fn(async () => ({ ok: true })),
            captureProgress: vi.fn(async () => ({ ok: true, snapshot: progressSnapshot() })),
            verifyEvidenceRefs: vi.fn(async (request: any) => ({
              ok: true,
              entries: (request.refs || []).map((ref: string) => ({
                ref, sizeBytes: 12, mtimeMs: 1, sha256: 'a'.repeat(64),
              })),
            })),
            appendRecord: vi.fn(async () => ({ ok: true })),
            deleteSession: vi.fn(async () => ({ deleted: true })),
            listActiveSessions: vi.fn(async () => []),
          },
        },
        setTimeout: (callback: () => void) => {
          callback();
          return 1;
        },
        __wmux_getAgentStates: () => ({ 'worker-a': agentState }),
      },
    });
    const store = useStore.getState();
    store.setProjectSupervisorLanes([]);
    store.resetOrdinarySupervisorSession();
    store.restoreProjectManager(null);
    store.setOrdinarySupervisorLanes([lane()]);
    store.patchSupervisor({
      autonomous: false,
      submitEnter: false,
    });
    store.startOrdinarySupervisor();
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(true);
    initPipeBridge();
  });

  it('supersedes only the stopped recovery placeholder that owns the restored snapshot', () => {
    const stoppedPlaceholder = {
      ...lane(),
      id: 'lane-recovery-placeholder',
      surfaceId: 'worker-missing' as any,
      controlState: 'stopped' as const,
      recoverySnapshotId: 'snapshot-a',
    };
    const activeLane = {
      ...stoppedPlaceholder,
      id: 'lane-active',
      controlState: 'active' as const,
    };
    const selectedIds = new Set(['worker-restored']);

    expect(shouldSupersedeStoppedSupervisorLane(stoppedPlaceholder, selectedIds, 'snapshot-a')).toBe(true);
    expect(shouldSupersedeStoppedSupervisorLane(activeLane, selectedIds, 'snapshot-a')).toBe(false);
    expect(shouldSupersedeStoppedSupervisorLane(
      { ...stoppedPlaceholder, recoverySnapshotId: 'snapshot-b' },
      selectedIds,
      'snapshot-a',
    )).toBe(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().resetOrdinarySupervisorSession();
    useStore.getState().restoreProjectManager(null);
    useStore.getState().replaceAllWorkspaces([]);
    useStore.getState().setWorkspacePrefs({ projectManagementAgents: DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG });
    surfaceTerminalRegistry.delete('worker-a');
    surfaceTerminalRegistry.delete('supervisor-a');
    clearTerminalRuntimeStatus('worker-a');
    clearTerminalRuntimeStatus('supervisor-a');
    surfaceTerminalRegistry.delete('project-manager-atomic');
    clearTerminalRuntimeStatus('project-manager-atomic');
    clearSupervisorEvidenceCache();
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('allows only the bound supervisor terminal to page frozen worker evidence', async () => {
    const state = useStore.getState().supervisor;
    const boundLane = state.lanes[0];
    const sessionId = boundLane.managementSessionId || state.sessionId || '';
    registerSupervisorEvidence(createSupervisorEvidenceSnapshot({
      sessionId,
      reviewId: 'review-evidence',
      laneId: boundLane.id,
      surfaceId: boundLane.surfaceId,
      isolationScope: 'ordinary',
      task: '验证冻结证据',
      bufferType: 'normal',
      bufferLines: 3,
      capturedLines: 3,
      summary: '第二页仍可读取',
      text: '第一行\n第二行\n第三行',
    }));
    const readEvidence = (globalThis.window as any).__wmux_supervisorEvidence;

    await expect(readEvidence({
      callerSurfaceId: 'supervisor-a',
      reviewId: 'review-evidence',
      page: 2,
      pageLines: 2,
    })).resolves.toMatchObject({
      ok: true,
      surfaceId: 'worker-a',
      page: 2,
      text: '第三行',
    });
    const saveEvidence = vi.fn(async () => ({ ok: true }));
    const readEvidenceFile = vi.fn(async (options: any) => ({
      ok: true,
      accessMode: 'file',
      reviewId: options.reviewId,
      surfaceId: options.surfaceId,
      path: 'E:\\repo\\.wmux\\supervisor\\evidence.txt',
      sha256: 'a'.repeat(64),
      totalLines: 3,
      suggestedRanges: [{ startLine: 1, endLine: 3, reason: 'tail' }],
    }));
    (globalThis.window as any).wmux.supervisor = { saveEvidence, readEvidenceFile };
    await expect(readEvidence({
      callerSurfaceId: 'supervisor-a',
      reviewId: 'review-evidence',
      file: true,
    })).resolves.toMatchObject({
      ok: true,
      accessMode: 'file',
      surfaceId: 'worker-a',
      totalLines: 3,
    });
    expect(saveEvidence).toHaveBeenCalledTimes(1);
    expect(readEvidenceFile).toHaveBeenCalledWith(expect.objectContaining({
      reviewId: 'review-evidence',
      surfaceId: 'worker-a',
      isolationScope: 'ordinary',
    }));
    (globalThis.window as any).wmux.supervisor.readEvidenceFile = vi.fn(async () => {
      throw new Error('旧主进程不支持文件引用');
    });
    await expect(readEvidence({
      callerSurfaceId: 'supervisor-a',
      reviewId: 'review-evidence',
      file: true,
      pageLines: 2,
    })).resolves.toMatchObject({
      ok: true,
      accessMode: 'page-fallback',
      fallbackReason: '只读证据文件不可用',
      page: 1,
      hasMore: true,
    });
    await expect(readEvidence({
      callerSurfaceId: 'worker-a',
      reviewId: 'review-evidence',
    })).resolves.toEqual({
      ok: false,
      error: '当前终端不是活动监督 lane 绑定的监督 AI',
    });
  });

  it('keeps terminal-context supervision read-only while the user fills a material gap', async () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-goal-builder' as any,
      title: '目标构建测试',
      cwd: 'E:\\repo',
      splitTree: {
        type: 'leaf', paneId: 'pane-goal-builder' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '任务 AI' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '监督 AI', transientSupervisor: true },
        ],
      },
    }]);
    surfaceTerminalRegistry.set('supervisor-a', {
      buffer: {
        active: {
          baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
    } as any);
    expect((globalThis.window as any).__wmux_supervisorGoalDraft).toBeUndefined();
    expect((globalThis.window as any).__wmux_supervisorReply).toBeUndefined();
  });

  it('lets the bound supervisor finalize a sufficient terminal-context summary without user confirmation', async () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-terminal-context' as any,
      title: '终端上下文测试',
      cwd: 'E:\\repo',
      splitTree: {
        type: 'leaf', paneId: 'pane-terminal-context' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '任务 AI' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '监督 AI', transientSupervisor: true },
        ],
      },
    }]);
    surfaceTerminalRegistry.set('supervisor-a', {
      buffer: {
        active: {
          baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
    } as any);
    expect((globalThis.window as any).__wmux_supervisorGoalFinalize).toBeUndefined();
  });

  it('creates a project AI from an existing terminal conversation without a mandatory creation dialogue', async () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-project-source' as any,
      title: '已有任务终端',
      cwd: 'E:\\goal-construction',
      splitTree: {
        type: 'leaf', paneId: 'pane-project-source' as any, activeSurfaceIndex: 0,
        surfaces: [{ id: 'project-source' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '现有 Codex' }],
      },
    }]);
    const sourceLines = [
      '❯ 修复登录流程并完成发布前验证',
      '',
      '• 登录实现已经完成，剩余集成测试和发布检查。',
    ];
    surfaceTerminalRegistry.set('project-source', {
      buffer: {
        active: {
          type: 'normal', baseY: 0, cursorX: 0, cursorY: 0, length: sourceLines.length,
          getLine: (index: number) => ({ translateToString: () => sourceLines[index] || '' }),
        },
      },
    } as any);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'start', projectDir: 'E:\\goal-construction', goal: '继续完成登录项目', sourceTerminalId: 'project-source',
    })).resolves.toMatchObject({
      ok: true,
      session: { goal: '继续完成登录项目', status: 'waiting' },
    });
    const project = useStore.getState().projectManager!;
    expect(project.goalConstruction).toBeUndefined();
    const startupContext = useStore.getState().projectManager?.pendingManagerDeliveries
      ?.map((delivery) => delivery.text).join('\n') || '';
    expect(startupContext).toContain('[已有终端上下文｜只读证据，不继承权限]');
    expect(startupContext).toContain('登录实现已经完成，剩余集成测试和发布检查。');
  });

  it('allows a new active project in a directory whose previous project was stopped', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'start', projectDir: 'E:\\reused-project', goal: '旧项目',
      preconditions: ['无额外物理前置条件'], doneWhen: ['旧项目完成'],
    })).resolves.toMatchObject({ ok: true });
    const previous = useStore.getState().projectManager!;
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'stop', callerSurfaceId: previous.managerSurfaceId, projectId: previous.id,
      reason: '旧项目已停止',
    })).resolves.toMatchObject({ ok: true });
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: '项目已停止，请查看',
      text: expect.stringContaining('旧项目已停止'),
    }));

    await expect(remote({
      action: 'start', projectDir: 'e:/reused-project/.', goal: '新项目',
      preconditions: ['无额外物理前置条件'], doneWhen: ['新项目完成'],
    })).resolves.toMatchObject({ ok: true, session: { goal: '新项目' } });
    const sessions = useStore.getState().projectManagers;
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: previous.id, status: 'stopped' }),
      expect.objectContaining({ goal: '新项目', status: 'waiting' }),
    ]));
  });

  it('does not derive route-adjustment authority from retry authority', () => {
    const project = bindProjectLaneToWorkItem();
    const contract = project.workItems[0].contract;
    expect(projectContractAutonomyPermissions(contract)).not.toContain('route-adjustment');
    expect(projectContractAutonomyPermissions({
      ...contract,
      authority: { ...contract.authority, routeAdjustments: true },
    })).toContain('route-adjustment');
  });

  it('routes unified context by the caller surface role without trusting supplied IDs', () => {
    const project = bindProjectLaneToWorkItem();
    useStore.getState().restoreProjectManager({ ...project, managerSurfaceId: 'manager-a' });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-context' as any,
      title: 'Project',
      splitTree: {
        type: 'leaf', paneId: 'pane-context' as any, activeSurfaceIndex: 0,
        surfaces: [
          {
            id: 'manager-a' as any, type: 'terminal', projectManagerTerminal: true,
            projectManagerProjectId: project.id,
          },
          {
            id: 'worker-a' as any, type: 'terminal', projectManagerProjectId: project.id,
            projectManagerWorkItemId: project.workItems[0].id,
          },
          { id: 'supervisor-a' as any, type: 'terminal', transientSupervisor: true },
        ],
      },
    }]);
    const context = (globalThis.window as any).__wmux_roleContext;

    expect(context({ callerSurfaceId: 'manager-a', projectId: 'forged' })).toMatchObject({
      role: 'project-ai', identity: { projectId: project.id, managerSurfaceId: 'manager-a' },
    });
    expect(context({ callerSurfaceId: 'supervisor-a', projectId: 'forged' })).toMatchObject({
      role: 'project-supervisor', identity: { supervisorSurfaceId: 'supervisor-a' },
    });
    expect(context({ callerSurfaceId: 'worker-a', projectId: 'forged' })).toMatchObject({
      role: 'task', identity: { taskSurfaceId: 'worker-a' },
    });
    expect(context({ callerSurfaceId: 'worker-a', projectId: 'forged' }).identity).not.toHaveProperty('projectId');
    expect(context({ callerSurfaceId: 'worker-a', projectId: 'forged' }).identity).not.toHaveProperty('workItemId');
    useStore.getState().stopSupervisorLane('lane-a', '验证失效绑定');
    expect(context({ callerSurfaceId: 'worker-a' })).toMatchObject({
      ok: false, error: expect.stringContaining('绑定不完整'),
    });
    expect((globalThis.window as any).__wmux_authorizeSurfaceCapability({
      callerSurfaceId: 'worker-a', method: 'surface.close', params: { surfaceId: 'supervisor-a' },
    })).toMatchObject({ knownSurface: true, managed: true, allowed: false });
    expect(context({ callerSurfaceId: 'unbound', projectId: project.id })).toMatchObject({ ok: false });
  });

  it('reports task terminal activity and rejects an unconfirmed busy send', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-control' as any,
      title: 'Work',
      splitTree: {
        type: 'leaf', paneId: 'pane-control' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'Codex worker' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi', customTitle: 'AI 监督 · Codex worker' },
        ],
      },
    }]);
    agentState = { state: 'working', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() };
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    const listResult = remoteControl({ action: 'list' });
    const listed = JSON.parse(listResult.message).terminals.find((terminal: any) => terminal.surfaceId === 'worker-a');
    expect(listed).toMatchObject({ activityState: 'working', activityUpdatedAt: agentState.updatedAt });
    const monitoringTerminals = JSON.parse(remoteControl({ action: 'terminal-list', mode: 'ordinary' }).message).terminals;
    expect(monitoringTerminals).toEqual(expect.arrayContaining([
      expect.objectContaining({ surfaceId: 'worker-a', terminalMode: 'ordinary', agentRole: 'task-ai' }),
      expect.objectContaining({ surfaceId: 'supervisor-a', terminalMode: 'ordinary', agentRole: 'supervisor-ai', supervisionState: 'active' }),
    ]));

    expect(remoteControl({ action: 'send', terminal: 'worker-a', task: '错误项目模式', mode: 'project' }))
      .toMatchObject({ ok: false });

    expect(remoteControl({ action: 'send', terminal: 'worker-a', task: '继续执行', actor: 'ou-user' }))
      .toMatchObject({ ok: false, code: 'terminal_busy', terminal: { activityState: 'working' } });
    expect(writes).not.toHaveBeenCalled();

    expect(remoteControl({ action: 'send', terminal: 'worker-a', task: '确认后继续执行', actor: 'ou-user', force: true }))
      .toMatchObject({ ok: true });
    expect(writes).toHaveBeenCalledWith('worker-a', '确认后继续执行');

    expect(remoteControl({ action: 'terminal-escape', terminal: 'worker-a', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: '已向 Codex worker 发送 Esc 中断请求。' });
    expect(writes).toHaveBeenLastCalledWith('worker-a', '\x1b');

    expect(remoteControl({ action: 'terminal-interrupt', terminal: 'worker-a', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: '已向 Codex worker 发送 Ctrl+C 中断请求。' });
    expect(writes).toHaveBeenLastCalledWith('worker-a', '\x03');

    agentState = {
      state: 'blocked',
      blockedReason: 'Waiting for your next prompt',
      blockedVersion: 1,
      updatedAt: Date.now(),
    };
    const promptReadyList = remoteControl({ action: 'list' });
    const promptReadyTerminal = JSON.parse(promptReadyList.message).terminals
      .find((terminal: any) => terminal.surfaceId === 'worker-a');
    expect(promptReadyTerminal).toMatchObject({ activityState: 'idle' });
  });

  it('stops only the selected project work-item runtime and delivers the user reason to project AI', async () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-project-intervention' as any,
      title: '项目执行链',
      cwd: 'E:\\repo',
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf', paneId: 'pane-project-intervention' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', projectManagerProjectId: 'pm-project', projectManagerWorkItemId: 'task-a' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi', transientSupervisor: true, projectSupervisorProjectId: 'pm-project' },
          { id: 'unrelated-worker' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '其他工作项' },
        ],
      },
    }]);
    const project = bindProjectLaneToWorkItem();
    writes.mockClear();

    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'intervene-work-item',
      projectId: project.id,
      workItemId: 'task-a',
      intervention: 'skip',
      reason: '已有验收记录，无需重复执行',
    })).resolves.toMatchObject({ ok: true, message: expect.stringContaining('通知项目 AI') });

    expect(useStore.getState().projectManager?.workItems[0]).toMatchObject({
      id: 'task-a', status: 'stopped', supervisorLaneId: undefined, workerSurfaceId: undefined,
    });
    expect(useStore.getState().projectManager?.events.at(-1)).toMatchObject({
      kind: 'user-work-item-intervention',
      workItemId: 'task-a',
      payload: { intervention: 'skip', reason: '已有验收记录，无需重复执行' },
    });
    expect(useStore.getState().supervisor.lanes.some((item) => item.id === 'lane-a')).toBe(false);
    const remainingSurfaces = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    ));
    expect(remainingSurfaces.some((surface) => surface.id === 'worker-a')).toBe(false);
    expect(remainingSurfaces.some((surface) => surface.id === 'supervisor-a')).toBe(false);
    expect(remainingSurfaces.some((surface) => surface.id === 'unrelated-worker')).toBe(true);
    const managerNotifications = JSON.stringify([
      ...writes.mock.calls,
      ...(useStore.getState().projectManager?.pendingManagerDeliveries || []).map((delivery) => delivery.text),
    ]);
    expect(managerNotifications).toContain('已有验收记录，无需重复执行');
    expect(managerNotifications).toContain('其他工作项没有被全局暂停');
  });

  it('keeps repeated project progress inspections read-only without writing into a working supervisor', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-inspect-backpressure' });
    const managerSurfaceId = 'project-manager-inspect';
    useStore.getState().restoreProjectManager({ ...project, managerSurfaceId: managerSurfaceId as any });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-project-inspect' as any,
      title: '项目执行空间',
      cwd: project.projectDir,
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf', paneId: 'pane-project-inspect' as any, activeSurfaceIndex: 0,
        surfaces: [
          {
            id: managerSurfaceId as any,
            type: 'terminal',
            shell: 'pwsh.exe',
            projectManagerTerminal: true,
            projectManagerProjectId: project.id,
            projectManagerAgent: 'codex',
            projectManagerModel: '',
            projectManagerReasoningEffort: '',
          },
          {
            id: 'worker-a' as any,
            type: 'terminal',
            shell: 'pwsh.exe',
            projectManagerProjectId: project.id,
            projectManagerWorkItemId: 'task-a',
          },
          {
            id: 'supervisor-a' as any,
            type: 'terminal',
            shell: 'pi',
            transientSupervisor: true,
            projectSupervisorProjectId: project.id,
          },
        ],
      },
    }]);
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      'worker-a': { ...agentState, state: 'working', updatedAt: Date.now() },
      'supervisor-a': { state: 'working', updatedAt: Date.now() },
    });
    writes.mockClear();
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    await expect(request({
      action: 'supervisor-inspect',
      callerSurfaceId: managerSurfaceId,
      projectId: project.id,
      reason: '暂时没有新进度',
    })).resolves.toMatchObject({
      ok: true,
      watchdog: null,
      message: expect.stringContaining('未向任何 Agent 发送'),
    });
    await expect(request({
      action: 'supervisor-inspect',
      callerSurfaceId: managerSurfaceId,
      projectId: project.id,
      reason: '再次询问同一进度',
    })).resolves.toMatchObject({ ok: true, watchdog: null });

    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(useStore.getState().supervisor.lanes[0].pendingSupervisorDeliveries || []).toEqual([]);
  });

  it('identifies a manually created agent terminal from its screen content', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-control' as any,
      title: 'sdf',
      splitTree: {
        type: 'leaf', paneId: 'pane-control' as any, activeSurfaceIndex: 0,
        surfaces: [{ id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe' }],
      },
    }]);
    screenText = '> OpenAI Codex (v0.147.0)\n> 你是什么模型\n• 我是 Codex。';
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    const result = remoteControl({ action: 'list' });
    const listed = JSON.parse(result.message).terminals[0];
    expect(listed).toMatchObject({ label: 'Codex', workspace: 'sdf' });
  });

  it('excludes every terminal in the dedicated AI supervisor workspace from task controls', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-task' as any,
      title: '任务工作区',
      splitTree: {
        type: 'leaf', paneId: 'pane-task' as any, activeSurfaceIndex: 0,
        surfaces: [{ id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'Codex worker' }],
      },
    }, {
      id: 'ws-orphan-supervisor' as any,
      title: 'AI 监督',
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf', paneId: 'pane-supervisor' as any, activeSurfaceIndex: 0,
        surfaces: [{ id: 'orphan-supervisor' as any, type: 'terminal', shell: 'pwsh.exe' }],
      },
    }]);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    const listed = JSON.parse(remoteControl({ action: 'list' }).message).terminals;
    expect(listed.map((terminal: any) => terminal.surfaceId)).toEqual(['worker-a']);
    expect(remoteControl({ action: 'terminal-screen', terminal: 'orphan-supervisor', lines: 40 }))
      .toMatchObject({ ok: false, error: expect.stringContaining('专属监督 AI 终端') });
  });

  it('separates project AI runtime monitoring from ordinary supervisor terminal controls', () => {
    const store = useStore.getState();
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-monitor', workItemId: 'task-monitor' });
    store.restoreProjectManager({
      ...project,
      projectName: '监控项目',
      managerSurfaceId: 'project-manager-a' as any,
    });
    store.setProjectSupervisorLanes([{
      ...lane(),
      id: 'project-lane',
      label: '项目任务',
      surfaceId: 'project-task-a' as any,
      supervisorSurfaceId: 'project-supervisor-a' as any,
      projectManagerProjectId: 'pm-monitor',
      projectWorkItemId: 'task-monitor',
    }]);
    store.replaceAllWorkspaces([{
      id: 'ws-project-monitor' as any,
      title: '项目执行空间',
      cwd: 'E:\\repo',
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf', paneId: 'pane-project-monitor' as any, activeSurfaceIndex: 0,
        surfaces: [
          {
            id: 'project-manager-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '项目 AI 控制台',
            projectManagerTerminal: true, projectManagerProjectId: 'pm-monitor',
          },
          {
            id: 'project-supervisor-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'AI 监督 · 项目任务',
            transientSupervisor: true, projectSupervisorProjectId: 'pm-monitor',
          },
          {
            id: 'project-task-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '任务 AI · 项目任务',
            projectManagerProjectId: 'pm-monitor', projectManagerWorkItemId: 'task-monitor',
          },
        ],
      },
    }]);
    for (const surfaceId of ['project-manager-a', 'project-supervisor-a', 'project-task-a']) {
      surfaceTerminalRegistry.set(surfaceId, {
        buffer: {
          active: {
            baseY: 0, cursorX: 0, cursorY: 0, length: 1,
            getLine: () => ({ translateToString: () => `Agent ${surfaceId} 正常运行` }),
          },
        },
      } as any);
      markTerminalRuntimeReady(surfaceId);
    }
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    const ordinary = JSON.parse(remoteControl({ action: 'list' }).message).terminals;
    expect(ordinary).toEqual([]);
    const projectTerminals = JSON.parse(remoteControl({ action: 'terminal-list', mode: 'project' }).message).terminals;
    expect(projectTerminals).toEqual(expect.arrayContaining([
      expect.objectContaining({ surfaceId: 'project-manager-a', agentRole: 'project-ai', projectName: '监控项目', runtimeState: 'ready' }),
      expect.objectContaining({ surfaceId: 'project-supervisor-a', agentRole: 'supervisor-ai', projectId: 'pm-monitor' }),
      expect.objectContaining({ surfaceId: 'project-task-a', agentRole: 'task-ai', workItemId: 'task-monitor' }),
    ]));
    expect(remoteControl({ action: 'terminal-screen', terminal: 'project-supervisor-a', mode: 'project', lines: 40 }))
      .toMatchObject({
        ok: true,
        terminal: {
          surfaceId: 'project-supervisor-a', terminalMode: 'project', agentRole: 'supervisor-ai', projectId: 'pm-monitor',
        },
      });
    expect(remoteControl({ action: 'terminal-screen', terminal: 'project-supervisor-a', lines: 40 }))
      .toMatchObject({ ok: false, error: expect.stringContaining('专属监督 AI 终端') });
    expect(JSON.parse(remoteControl({ action: 'terminal-list', mode: 'ordinary' }).message).terminals)
      .toEqual([]);

    surfaceTerminalRegistry.set('project-manager-a', {
      buffer: {
        active: {
          baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
    } as any);
    writes.mockClear();
    expect(remoteControl({ action: 'send', terminal: 'project-manager-a', task: '绕过模式隔离' }))
      .toMatchObject({ ok: false });
    const projectSend = remoteControl({
      action: 'send', terminal: 'project-manager-a', task: '用户通过飞书直接补充项目背景', mode: 'project', actor: 'ou-user',
    });
    expect(projectSend.error).toBeUndefined();
    expect(projectSend).toMatchObject({ ok: true });
    expect(writes).toHaveBeenCalledWith('project-manager-a', '用户通过飞书直接补充项目背景');
    surfaceTerminalRegistry.set('project-task-a', {
      buffer: {
        active: {
          baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
    } as any);
    const directTask = remoteControl({
      action: 'send', terminal: 'project-task-a', task: '用户直接发起新的发布回归任务', mode: 'project', actor: 'ou-user',
    });
    expect(directTask).toMatchObject({
      ok: true,
      message: expect.stringContaining('确认接收后将同步专属监督 AI'),
    });
    expect(writes).toHaveBeenCalledWith('project-task-a', '用户直接发起新的发布回归任务');
    const laneBeforeHook = useStore.getState().supervisor.lanes
      .find((lane) => lane.surfaceId === 'project-task-a');
    expect(laneBeforeHook?.currentTask).toBeUndefined();
    expect(laneBeforeHook?.pendingSupervisorDeliveries || []).toEqual([]);
    const decideAfterDirectTask = (globalThis.window as any).__wmux_supervisorDecide;
    const writesBeforeStaleDecision = writes.mock.calls.length;
    expect(decideAfterDirectTask({
      surfaceId: 'project-task-a',
      supervisorSurfaceId: 'project-supervisor-a',
      outcome: 'continue',
      next: '旧监督回合试图覆盖用户的新任务',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('等待 UserPromptSubmit 生命周期确认'),
    });
    expect(writes).toHaveBeenCalledTimes(writesBeforeStaleDecision);
    expect(confirmSupervisorUserSubmitFromHook(
      'project-task-a',
      '用户直接发起新的发布回归任务',
    )).toBe(true);
    useStore.getState().updateLane('project-lane', { workerTurnId: 1, userDirectTaskTurnId: 1 });
    expect(decideAfterDirectTask({
      surfaceId: 'project-task-a',
      supervisorSurfaceId: 'project-supervisor-a',
      outcome: 'continue',
      next: '旧监督回合再次尝试覆盖用户任务',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('任务 Agent 确认接收'),
    });
    expect(writes).toHaveBeenCalledTimes(writesBeforeStaleDecision);
    expect(remoteControl({
      action: 'terminal-escape', terminal: 'project-supervisor-a', mode: 'project', actor: 'ou-user',
    })).toMatchObject({ ok: true });
    expect(writes).toHaveBeenLastCalledWith('project-supervisor-a', '\x1b');
    expect(remoteControl({
      action: 'terminal-interrupt', terminal: 'project-task-a', mode: 'project', actor: 'ou-user',
    })).toMatchObject({ ok: true });
    expect(writes).toHaveBeenLastCalledWith('project-task-a', '\x03');

    for (const surfaceId of ['project-manager-a', 'project-supervisor-a', 'project-task-a']) {
      surfaceTerminalRegistry.delete(surfaceId);
      clearTerminalRuntimeStatus(surfaceId);
    }
  });

  it('sends Feishu direction information only to the active dedicated supervisor terminal', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-control' as any,
      title: 'Work',
      splitTree: {
        type: 'leaf', paneId: 'pane-control' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'Codex worker' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi', customTitle: 'AI 监督 · Codex worker' },
        ],
      },
    }]);
    surfaceTerminalRegistry.set('supervisor-a', {
      buffer: {
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
    } as any);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'send-supervisor-message', terminal: 'worker-a', message: '先读取项目进度，再给任务终端建议', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: expect.stringContaining('AI 监督终端（管家）') });
    expect(writes).toHaveBeenCalledWith(
      'supervisor-a',
      '[用户调整监督方向] 先读取项目进度，再给任务终端建议',
    );
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    expect(useStore.getState().supervisor.log[0]).toMatchObject({
      laneId: 'lane-a', action: '用户调整监督方向', detail: '先读取项目进度，再给任务终端建议',
    });

    useStore.getState().updateLane('lane-a', {
      controlState: 'waiting', stopConfirmed: true, awaitingReview: false, autoDecisionsUsed: 4,
    });
    writes.mockClear();
    expect(remoteControl({
      action: 'send-supervisor-message', terminal: 'worker-a', message: '采用新的验证方案继续', actor: 'ou-user',
    })).toMatchObject({ ok: true });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'active', stopConfirmed: false, awaitingReview: true, autoDecisionsUsed: 0,
    });
    expect(useStore.getState().supervisor.log[1]).toMatchObject({
      laneId: 'lane-a', action: '待续恢复', detail: '用户已远程向 AI 监督终端提供新方向，继续监督',
    });

    useStore.getState().pauseOrdinarySupervisor('测试暂停');
    writes.mockClear();
    expect(remoteControl({
      action: 'send-supervisor-message', terminal: 'worker-a', message: '暂停时不应发送', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('当前未运行') });
    expect(writes).not.toHaveBeenCalled();
  });

  it('handles every waiting decision only while the AI supervisor lane is waiting', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-control' as any,
      title: 'Work',
      splitTree: {
        type: 'leaf', paneId: 'pane-control' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'Codex worker' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi', customTitle: 'AI 监督 · Codex worker' },
        ],
      },
    }]);
    surfaceTerminalRegistry.set('supervisor-a', {
      buffer: {
        active: {
          baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
    } as any);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    useStore.getState().updateLane('lane-a', {
      controlState: 'waiting', stopConfirmed: true, awaitingReview: false, autoDecisionsUsed: 3,
    });

    expect(remoteControl({
      action: 'waiting-decision', terminal: 'worker-a', decision: 'keep', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: expect.stringContaining('保持待续') });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ controlState: 'waiting' });
    expect(writes).not.toHaveBeenCalled();

    expect(remoteControl({
      action: 'waiting-decision', terminal: 'worker-a', decision: 'submit', message: '  ', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('不能为空') });

    expect(remoteControl({
      action: 'waiting-decision', terminal: 'worker-a', decision: 'submit', message: '先补齐回归测试再发布', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: expect.stringContaining('恢复监督') });
    expect(writes).toHaveBeenCalledWith('supervisor-a', '[用户调整监督方向] 先补齐回归测试再发布');
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'active', stopConfirmed: false, awaitingReview: true, autoDecisionsUsed: 0,
    });

    expect(remoteControl({
      action: 'waiting-decision', terminal: 'worker-a', decision: 'resume', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('已不处于待续状态') });

    useStore.getState().updateLane('lane-a', { controlState: 'waiting', stopConfirmed: true, awaitingReview: false });
    writes.mockClear();
    expect(remoteControl({
      action: 'waiting-decision', terminal: 'worker-a', decision: 'resume', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: expect.stringContaining('按原目标恢复') });
    expect(writes).toHaveBeenCalledWith(
      'supervisor-a',
      expect.stringContaining('按原任务目标和既有停止条件继续监督'),
    );

    useStore.getState().updateLane('lane-a', { controlState: 'waiting', stopConfirmed: true, awaitingReview: false });
    useStore.getState().pauseOrdinarySupervisor('等待中的通道无需暂停');
    expect(remoteControl({
      action: 'waiting-decision', terminal: 'worker-a', decision: 'resume', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: expect.stringContaining('按原目标恢复') });
    useStore.getState().updateLane('lane-a', { controlState: 'waiting', stopConfirmed: true, awaitingReview: false });
    expect(remoteControl({
      action: 'waiting-decision', terminal: 'worker-a', decision: 'stop', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: expect.stringContaining('其他通道不受影响') });
    expect(useStore.getState().supervisor.lanes).toHaveLength(0);
  });

  it('returns recent supervision logs with lane labels for Feishu', () => {
    useStore.getState().appendSupervisorLog('lane-a', '任务完成', '测试已通过');
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    const result = remoteControl({ action: 'logs' });
    const payload = JSON.parse(result.message);
    expect(result).toMatchObject({ ok: true });
    expect(payload).toMatchObject({ active: true, paused: false });
    expect(payload.entries[0]).toMatchObject({
      laneLabel: 'worker', action: '任务完成', detail: '测试已通过',
    });
  });

  it('returns only a current task terminal screen for Feishu private viewing', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-screen' as any,
      title: 'Screen Work',
      cwd: 'E:\\repo',
      splitTree: {
        type: 'leaf', paneId: 'pane-screen' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'Codex worker' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi', customTitle: 'AI 监督 · Codex worker' },
        ],
      },
    }]);
    screenText = 'PS E:\\repo> npm test\nTests 1 failed';
    surfaceTerminalRegistry.set('supervisor-a', surfaceTerminalRegistry.get('worker-a')!);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({ action: 'terminal-screen', terminal: 'worker-a', lines: 40 })).toMatchObject({
      ok: true,
      terminal: {
        surfaceId: 'worker-a', label: 'Codex worker', workspace: 'Screen Work', cwd: 'E:\\repo', activityState: 'idle',
      },
      text: screenText,
      lines: 1,
      capturedAt: expect.any(Number),
    });
    expect(remoteControl({ action: 'terminal-screen', terminal: 'supervisor-a', lines: 40 }))
      .toMatchObject({ ok: false, error: expect.stringContaining('专属监督 AI 终端') });
    const supervisorScreen = remoteControl({ action: 'supervisor-screen', terminal: 'worker-a', lines: 40 });
    expect(supervisorScreen).toMatchObject({
      ok: true,
      terminal: {
        surfaceId: 'worker-a', label: 'worker', workspace: 'Screen Work', cwd: 'E:\\repo', activityState: 'unknown',
      },
      text: screenText,
      lines: 1,
      capturedAt: expect.any(Number),
    });
    expect(supervisorScreen.answer).toBeUndefined();
    screenText = [
      '• 当前正文：类型检查通过，接下来运行针对性测试。',
      '• Ran npm test -- --run focused.test.ts',
      '  └ Tests still running',
      '◦ Working (8s)',
      '› Run /review on my current changes',
      'gpt-5.6-sol high · E:\\repo',
    ].join('\n');
    expect(remoteControl({ action: 'terminal-screen', terminal: 'worker-a', lines: 40 })).toMatchObject({
      ok: true,
      answer: '当前正文：类型检查通过，接下来运行针对性测试。',
    });
    expect(remoteControl({ action: 'terminal-screen', terminal: 'missing', lines: 40 }))
      .toMatchObject({ ok: false });
  });

  it('returns the live worker screen and current AI recommendation for a Feishu decision card', () => {
    screenText = [
      '• 核心结论：类型检查通过，仍有 1 项测试失败。',
      '• Ran npm test -- --run focused.test.ts',
      '  └ Tests 1 failed',
      '◦ Working (8s)',
      '› Run /review on my current changes',
      'gpt-5.6-sol high · E:\\repo',
    ].join('\n');
    expect(decide({
      outcome: 'needs-human', proposalKind: 'important', next: '保留接口并补齐适配层',
    })).toMatchObject({ ok: true });
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      surfaceId: 'supervisor-a',
      title: 'AI 监督',
    }));
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decision-context', approvalId: approval.id, terminal: 'worker-a', lines: 40,
    })).toMatchObject({
      ok: true,
      recommendation: '保留接口并补齐适配层',
      terminalScreen: '核心结论：类型检查通过，仍有 1 项测试失败。',
    });
    expect(remoteControl({
      action: 'decision-context', approvalId: approval.id, terminal: 'other-worker', lines: 40,
    })).toMatchObject({ ok: false, error: expect.stringContaining('不匹配') });
  });

  it('records public decision context separately from private options', async () => {
    const appendRecord = vi.fn(async () => undefined);
    (globalThis.window as any).wmux.supervisor = { appendRecord };

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      reason: '需要用户确认测试板位置并决定是否安排现场复测',
      impact: 'AI 无法确认实体设备位置，也不能代替用户执行现场操作',
      alternatives: '方案 A：远程烧录；方案 B：现场断开设备',
      next: '推荐方案 A：远程烧录后读取状态',
    })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(appendRecord).toHaveBeenCalled());

    const approvalRecord = appendRecord.mock.calls.find(([record]) => (
      record.type === 'supervisor.approval.requested'
    ))?.[0];
    expect(approvalRecord?.payload).toMatchObject({
      taskGoal: '完成当前测试任务',
      reason: '需要用户确认测试板位置并决定是否安排现场复测',
      impact: 'AI 无法确认实体设备位置，也不能代替用户执行现场操作',
      alternatives: '方案 A：远程烧录；方案 B：现场断开设备',
    });
    expect(approvalRecord?.payload).not.toHaveProperty('recommendation');
    expect(approvalRecord?.payload).not.toHaveProperty('next');
  });

  it('removes next-step plans from the fallback task goal published to the group', async () => {
    const appendRecord = vi.fn(async () => undefined);
    (globalThis.window as any).wmux.supervisor = { appendRecord };
    const currentConfig = useStore.getState().supervisor.lanes[0].config!;
    useStore.getState().updateLane('lane-a', {
      config: { ...currentConfig, taskGoal: '' },
      currentTask: '固件修复已验收。下一步：方案 A：远程烧录；方案 B：现场断开设备',
    });

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      reason: '需要用户确认测试板位置',
      impact: 'AI 无法确认实体设备位置',
      alternatives: '方案 A：远程烧录；方案 B：现场断开设备',
      next: '推荐方案 A',
    })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(appendRecord).toHaveBeenCalled());

    const approvalRecord = appendRecord.mock.calls.find(([record]) => (
      record.type === 'supervisor.approval.requested'
    ))?.[0];
    expect(approvalRecord?.payload.taskGoal).toBe('固件修复已验收');
    expect(String(approvalRecord?.payload.taskGoal)).not.toContain('方案 A');
  });

  it('keeps the newest part when limiting terminal screen text for Feishu', () => {
    const excerpt = terminalScreenExcerpt(`旧输出${'x'.repeat(40)}\n最新错误：测试失败`, 20);
    expect(excerpt).toHaveLength(20);
    expect(excerpt.startsWith('…\n')).toBe(true);
    expect(excerpt).toContain('最新错误：测试失败');
  });

  it('redacts credentials before persisting a safe-exit terminal checkpoint', () => {
    const excerpt = redactProjectSafeExitExcerpt([
      'api_key=secret-value-123',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'GitHub token ghp_abcdefghijklmnopqrstuvwxyz',
    ].join('\n'));

    expect(excerpt).toContain('api_key: 已隐藏凭据');
    expect(excerpt).toContain('Bearer 已隐藏凭据');
    expect(excerpt).not.toContain('secret-value-123');
    expect(excerpt).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
  });

  it('builds bounded terminal bootstrap evidence with the latest request and Agent conclusion', () => {
    const context = terminalBootstrapContext([
      '❯ 修复认证失败并确认发布条件',
      '',
      '• 已完成认证实现。',
      '  剩余工作是集成测试和发布检查。',
    ].join('\n'), 'Codex', 'idle');

    expect(context).toContain('来源终端：Codex');
    expect(context).toContain('最近用户请求');
    expect(context).toContain('修复认证失败并确认发布条件');
    expect(context).toContain('最近 Agent 结论');
    expect(context).toContain('剩余工作是集成测试和发布检查');
  });

  it('joins Grok wrapped wide-character lines and collapses repeated TUI repaint frames', () => {
    const lines = [
      { text: '┌─ Grok 项目检查', wrapped: false },
      { text: '：发现中文错误', wrapped: true },
      { text: '结果：测试失败', wrapped: false },
      { text: '提示：修复后重试', wrapped: false },
      { text: '┌─ Grok 项目检查：发现中文错误', wrapped: false },
      { text: '结果：测试失败', wrapped: false },
      { text: '提示：修复后重试', wrapped: false },
    ];
    surfaceTerminalRegistry.set('worker-a', {
      buffer: {
        active: {
          length: lines.length,
          getLine: (index: number) => ({
            isWrapped: lines[index].wrapped,
            translateToString: () => lines[index].text,
          }),
        },
      },
    } as any);

    const screen = readTerminalScreen('worker-a', 40);
    expect(screen.text).toContain('┌─ Grok 项目检查：发现中文错误');
    expect(terminalScreenExcerpt(screen.text || '')).toBe(
      '┌─ Grok 项目检查：发现中文错误\n结果：测试失败\n提示：修复后重试',
    );
  });

  it('reads the complete Grok alternate screen and removes composer chrome', () => {
    const lines = [
      'Grok 正在检查项目',
      '结论：类型检查通过，仍有一个测试失败',
      '建议：先修复 terminal screen 用例',
      '',
      '╭────────────────────────────────────────────────────────────╮',
      '│',
      '│  >',
      '╰────────────────────────────────────────────────────────────╯',
      '────────────────── Grok 4.6 (high) · always-approve ─────────╯',
      'Shift+Tab:mode  |  Esc:cancel  |  Ctrl+X:shortcuts',
    ];
    surfaceTerminalRegistry.set('worker-a', {
      buffer: {
        active: {
          type: 'alternate',
          length: lines.length,
          getLine: (index: number) => ({
            isWrapped: false,
            translateToString: () => lines[index],
          }),
        },
      },
    } as any);

    const screen = readTerminalScreen('worker-a', 4);
    expect(screen.lines).toBe(lines.length);
    expect(terminalScreenExcerpt(screen.text || '')).toBe([
      'Grok 正在检查项目',
      '结论：类型检查通过，仍有一个测试失败',
      '建议：先修复 terminal screen 用例',
    ].join('\n'));
  });

  it('extracts the latest Grok question and answer without TUI noise', () => {
    const conversation = terminalConversationExcerpt([
      '〉 你是什么模型                                      11:03 PM',
      '◆user_prompt_submit   [hooks: 1/1]',
      '◆Thought for 0.1s',
      '',
      '我是 Grok 4.6，由 xAI 开发。',
      '11:04 PM',
      'Worked for 5.8s',
      'stop  [hooks: 1/1]',
      'Help improve Grok',
      '[Opt out] [Opt in]',
      'Read Terms and Privacy Policy.',
      '〉',
    ].join('\n'), 'Grok直连 · sd');

    expect(conversation).toMatchObject({
      question: '你是什么模型',
      answer: '我是 Grok 4.6，由 xAI 开发。',
    });
    expect(conversation.answer).not.toContain('Thought');
    expect(conversation.answer).not.toContain('Help improve');
  });

  it('detects a Grok conversation from screen content when the terminal title is generic', () => {
    const conversation = terminalConversationExcerpt([
      '28K / 500K',
      '❯ 你是什么模型                                      11:02 AM',
      '◆ user_prompt_submit   [hooks: 1/1]',
      '◆ Thought for 0.1s',
      '',
      '我是 Grok 4.6，由 xAI 开发。',
      '11:02 AM',
      'Worked for 7.7s',
      'stop  [hooks: 1/1]',
      'Help improve Grok',
      '[Opt out] [Opt in]',
      'Off by default. Opt-in to allow SpaceXAI to retain coding data.',
      'Change anytime via sett',
    ].join('\n'), 'pwsh.exe', 'idle');

    expect(conversation).toMatchObject({
      question: '你是什么模型',
      answer: '我是 Grok 4.6，由 xAI 开发。',
    });
    expect(conversation.answer).not.toContain('hooks');
    expect(conversation.answer).not.toContain('Help improve');
    expect(conversation.answer).not.toContain('Opt out');
  });

  it('detects Grok from its footer after hook markers scroll out of the viewport', () => {
    const conversation = terminalConversationExcerpt([
      '❯ 你有哪些技能                                      11:07 AM',
      '• requirements-clarifier：复杂需求澄清与实现前准备',
      '• code-reviewer / review：代码审查',
      '',
      '通用工程',
      '• brainstorming：方向不清时先对齐方案',
      '• verification-before-completion：完成前检验交付物',
      '',
      '需要某个技能时，直接说目标即可。',
      '█',
      '∷ Responding... 8.4s',
      '12s ↓29.1k [stop]',
      'Worked for 17s',
      'stop  [hooks: 1/1]',
      'Help improve Grok',
      '[Opt out] [Opt in]',
      'Off by default. Opt-in to allow SpaceXAI to retain coding data.',
    ].join('\n'), 'pwsh.exe', 'working');

    expect(conversation).toMatchObject({
      question: '你有哪些技能',
      answer: [
        '• requirements-clarifier：复杂需求澄清与实现前准备',
        '• code-reviewer / review：代码审查',
        '',
        '通用工程',
        '• brainstorming：方向不清时先对齐方案',
        '• verification-before-completion：完成前检验交付物',
        '',
        '需要某个技能时，直接说目标即可。',
      ].join('\n'),
    });
    expect(conversation.answer).not.toContain('Responding');
    expect(conversation.answer).not.toContain('[stop]');
    expect(conversation.answer).not.toContain('Help improve');
    expect(conversation.answer).not.toContain('█');
  });

  it('extracts a completed Grok turn before the composer placeholder and shortcuts', () => {
    const conversation = terminalConversationExcerpt([
      '❯ 你有哪些技能                                      11:13 AM',
      'test-driven-development    仅在你明确要求 TDD 时启用',
      'project-progress           维护 .project-plans/ 进度与交接',
      '',
      'Grok 内置',
      '通用能力，不限本仓库：',
      '• create-skill / create-workflow：创建技能、编排工作流',
      '• review / code-reviewer / pr-babysit：代码审查与 PR 跟进',
      '',
      '输入 / 可浏览全部可调用项；有命令可用 grok inspect 查看完整清单与来源。',
      'Worked for 44s',
      'stop  [hooks: 1/1]',
      '❯ Build anything',
      '│',
      'Ctrl+e:expand thinking  |  Space:prompt  |  Ctrl+x:shortcuts',
    ].join('\n'), 'pwsh.exe', 'idle');

    expect(conversation).toMatchObject({
      question: '你有哪些技能',
      answer: [
        'test-driven-development    仅在你明确要求 TDD 时启用',
        'project-progress           维护 .project-plans/ 进度与交接',
        '',
        'Grok 内置',
        '通用能力，不限本仓库：',
        '• create-skill / create-workflow：创建技能、编排工作流',
        '• review / code-reviewer / pr-babysit：代码审查与 PR 跟进',
        '',
        '输入 / 可浏览全部可调用项；有命令可用 grok inspect 查看完整清单与来源。',
      ].join('\n'),
    });
    expect(conversation.answer).not.toContain('Build anything');
    expect(conversation.answer).not.toContain('Ctrl+e');
    expect(conversation.answer).not.toContain('Worked for');
  });

  it('removes inline terminal glyph artifacts without damaging Grok list formatting', () => {
    const conversation = terminalConversationExcerpt([
      '❯ 你有哪些技能',
      '• commit-gatekeeper：提交、暂存、提交前检查',
      '文档与办公文件',
      '• drawio-diagram：仅在你明确说“用画图技能”时画 █ draw.io 图',
      '■',
      '• json-canvas / obsidian-markdown：Obsidian 画布、数据库视图 \uFFFC Markdown',
      '• image：文字图/改图时的提示词与用法 \uE001',
      '直接说你想做什么，我可以按对应流程做。',
      'Worked for 23s',
      'stop  [hooks: 1/1]',
    ].join('\n'), 'Grok直连 · glyphs', 'idle');

    expect(conversation.answer).toBe([
      '• commit-gatekeeper：提交、暂存、提交前检查',
      '文档与办公文件',
      '• drawio-diagram：仅在你明确说“用画图技能”时画   draw.io 图',
      '',
      '• json-canvas / obsidian-markdown：Obsidian 画布、数据库视图   Markdown',
      '• image：文字图/改图时的提示词与用法',
      '直接说你想做什么，我可以按对应流程做。',
    ].join('\n'));
    expect(conversation.answer).not.toMatch(/[█■\uFFFC\uE001]/u);
  });

  it('keeps the submitted Grok prompt instead of the empty composer and extracts the final reply', () => {
    const conversation = terminalConversationExcerpt([
      '❯ af',
      '◆user_prompt_submit   [hooks: 1/1]',
      '◆Thought for 10.6s',
      '',
      '我的理解是：你只发了 af，我先检查当前工作区。',
      '◈ Searched 1 MCP tools, Listed 1 dir, Searched 1 pattern',
      '',
      '工作区看起来是空的。我继续查看隐藏文件。',
      '◆ Run List hidden and parent directory files',
      '◈ Searched 1 pattern',
      '',
      'af 含义不清，当前工作区也是空的，没法据此推断你要做什么。',
      '',
      '请补一句目标，我再继续。',
      'Worked for 49s',
      '❯ |',
      'Shift+Tab:mode  |  Ctrl+x:shortcuts',
    ].join('\n'), 'Grok直连 · dasf', 'idle');

    expect(conversation).toMatchObject({
      question: 'af',
      answer: 'af 含义不清，当前工作区也是空的，没法据此推断你要做什么。\n\n请补一句目标，我再继续。',
    });
    expect(conversation.answer).not.toContain('Thought');
    expect(conversation.answer).not.toContain('Searched');
    expect(conversation.answer).not.toContain('Shift+Tab');
  });

  it('extracts the latest Kimi question and final response instead of its reasoning', () => {
    const conversation = terminalConversationExcerpt([
      '✦ asdf',
      '● User typed “asdf” — meaningless input. Reply briefly asking what they need.',
      '● 看起来像是误输入。需要我做什么？',
      '✦ 你是什么模型',
      '● The user asks what model I am. Answer candidly in Chinese.',
      '● 我是 Kimi Code CLI 的 AI 助手，由 Moonshot AI 的模型驱动。',
      'yolo  K3-256k thinking: high  C:\\repo',
      '/compact compresses context when it gets long',
      'context: 10% (25k/256k)',
    ].join('\n'), 'pwsh.exe');

    expect(conversation).toMatchObject({
      question: '你是什么模型',
      answer: '我是 Kimi Code CLI 的 AI 助手，由 Moonshot AI 的模型驱动。',
    });
    expect(conversation.answer).not.toContain('The user asks');
  });

  it('keeps the complete Kimi answer block and removes its auto status bar', () => {
    const conversation = terminalConversationExcerpt([
      'Use Kimi K3 with High thinking effort',
      '✨ 你有哪些技能',
      '● 用户询问技能列表，需要按系统提示回答。',
      '... (9 more lines, ctrl+o to expand)',
      '● 我当前可用的技能分为三个范围：',
      '',
      '项目级（Project）',
      '• coding-standards-provisioner：代码规范配置生成',
      '• project-progress：维护项目进度文档',
      '',
      '内置（Built-in）',
      '• check-kimi-code-docs：Kimi Code 产品文档问答',
      '• write-goal：辅助编写 /goal 目标',
      '',
      '需要我调用其中某个技能吗？',
      '> █',
      'auto  K2.7 Coding thinking  D:\\repo  main [+1487]',
      'context: 11% (28.1k/256k)',
    ].join('\n'), 'pwsh.exe', 'idle');

    expect(conversation).toMatchObject({
      question: '你有哪些技能',
      answer: [
        '我当前可用的技能分为三个范围：',
        '',
        '项目级（Project）',
        '• coding-standards-provisioner：代码规范配置生成',
        '• project-progress：维护项目进度文档',
        '',
        '内置（Built-in）',
        '• check-kimi-code-docs：Kimi Code 产品文档问答',
        '• write-goal：辅助编写 /goal 目标',
        '',
        '需要我调用其中某个技能吗？',
      ].join('\n'),
    });
    expect(conversation.answer).not.toContain('用户询问');
    expect(conversation.answer).not.toContain('auto  K2.7');
    expect(conversation.answer).not.toContain('context:');
  });

  it('keeps visible Codex正文 while tools are still running', () => {
    const conversation = terminalConversationExcerpt([
      'OpenAI Codex (v0.147.0)',
      'model: gpt-5.6-sol high fast',
      'directory: E:\\work\\wmux',
      'permissions: YOLO mode',
      'Tip: Type / to open the command popup',
      'MCP startup interrupted. The following servers were not initialized: fetch',
      '› 你是什么模型',
      '• 我的理解是：你想确认当前对话中我的模型身份。',
      '• Ran Get-Content -Raw -LiteralPath SKILL.md',
      '  └ name: openai-docs',
      '• Searching the web',
      '• Searched the web for Codex models',
      '• Working (12s • esc to interrupt)',
      '› Find and fix a bug in @filename',
      'gpt-5.6-sol high fast · E:\\work\\wmux',
    ].join('\n'), 'Codex直连 · sd', 'working');

    expect(conversation).toMatchObject({
      question: '你是什么模型',
      answer: '我的理解是：你想确认当前对话中我的模型身份。',
      answerPending: true,
    });
    expect(terminalConversationExcerpt(conversation.text, 'Codex直连 · sd', 'unknown')).toMatchObject({
      question: '你是什么模型', answerPending: true,
    });
  });

  it('keeps the final Codex response and removes commentary and tool activity', () => {
    const conversation = terminalConversationExcerpt([
      '› 你是什么模型',
      '• 我是 Codex，基于 GPT-5 的编程智能体。',
      '› 你是什么模型',
      '• 我先检查当前环境和官方说明。',
      '• Ran Get-Content SKILL.md',
      '  └ 43 lines',
      '• Searching the web',
      '• Working (4s • esc to interrupt)',
      '• 我是 Codex，当前会话使用 GPT-5.6 系列模型。',
      '',
      '  具体运行配置以终端顶部显示为准。',
      '› Implement {feature}',
      'gpt-5.6-sol high fast · E:\\work\\wmux',
    ].join('\n'), 'pwsh.exe', 'idle');

    expect(conversation).toMatchObject({
      question: '你是什么模型',
      answer: '我是 Codex，当前会话使用 GPT-5.6 系列模型。\n\n  具体运行配置以终端顶部显示为准。',
    });
    expect(conversation.answer).not.toContain('Searching');
    expect(conversation.answer).not.toContain('我先检查');
    expect(conversation.answer).not.toContain('Implement {feature}');
  });

  it.each([
    {
      agent: 'Kimi',
      screen: [
        '✦ 请说明当前进度',
        '● 正在整理检查结果。',
        '● 已完成类型检查，接下来核对单元测试。',
      ].join('\n'),
      answer: '已完成类型检查，接下来核对单元测试。',
    },
    {
      agent: 'Grok',
      screen: [
        '❯ 请说明当前进度',
        '◆ user_prompt_submit   [hooks: 1/1]',
        '已经完成类型检查，正在核对单元测试。',
        '∷ Responding (12s)',
      ].join('\n'),
      answer: '已经完成类型检查，正在核对单元测试。',
    },
  ])('keeps visible $agent正文 while the reply is still generating', ({ agent, screen, answer }) => {
    expect(terminalConversationExcerpt(screen, `${agent}直连`, 'working')).toMatchObject({
      question: '请说明当前进度',
      answer,
      answerPending: true,
    });
  });

  it('keeps Codex supervisor core information after the original prompt scrolls away', () => {
    const conversation = terminalSupervisorCoreExcerpt([
      '• 我的理解是：本轮仅检查 T1 收口齐备、反向软件资格 PASS、反向锁 0.100 A 阈门阻断。',
      '',
      "• Ran $p='.agents/skills/project-progress/SKILL.md'; Get-Content -LiteralPath $p",
      '  └ name: project-progress',
      '    +158 lines (ctrl+t to view transcript)',
      '',
      "• Ran Get-Content -LiteralPath '.agents/skills/project-index/SKILL.md'",
      '  └ 当前文件加载完毕',
      '◦ Working (45s • esc to interrupt)',
      '› Run /review on my current changes',
      'gpt-5.6-sol high · D:\\repo · Main [default]',
    ].join('\n'), '任务通道 TMC6460', 'working');

    expect(conversation).toMatchObject({
      answer: '我的理解是：本轮仅检查 T1 收口齐备、反向软件资格 PASS、反向锁 0.100 A 阈门阻断。',
      answerPending: true,
    });
    expect(conversation.question).toBeUndefined();
    expect(conversation.answer).not.toContain('Get-Content');
    expect(conversation.answer).not.toContain('/review');
  });

  it.each(['Codex', 'Kimi Code', 'Grok Build', 'Pi Agent', 'OpenCode'])(
    'uses the shared supervisor core fallback for %s',
    (agent) => {
      const conversation = terminalSupervisorCoreExcerpt([
        '• 当前核心结论：类型检查通过，仍需核对一个单元测试。',
        '• Ran npm test -- --run focused.test.ts',
        '  └ Tests still running',
        '◦ Working (8s)',
      ].join('\n'), agent, 'working');

      expect(conversation).toMatchObject({
        answer: '当前核心结论：类型检查通过，仍需核对一个单元测试。',
        answerPending: true,
      });
    },
  );

  it('keeps Kimi supervisor正文 and removes shell output plus the runtime footer', () => {
    const conversation = terminalSupervisorCoreExcerpt([
      '$ wmux supervisor decide --surface surf-a --outcome needs-human',
      '  --reason "用户希望由监督 AI 提取可选方案" --alternatives "方案 A；方案 B"',
      '  保证修改前先阅读 README，并说明本次变化。',
      '',
      '(no output)',
      'Took 0.2s',
      '',
      '被成功提交。',
      '',
      '已提交 needs-human 裁决，并向用户提供 4 个可选方案：',
      '',
      '- 方案 A：结束当前会话并判定任务完成',
      '- 方案 B：完善项目文档（补充 README 等）',
      '- 方案 C：只读检查 config.toml 与配置差异',
      '- 方案 D：以 whatif 预览同步脚本效果',
      '',
      '等待用户选择后推进。',
      '────────────────────────────────────────',
      'E:\\work\\project (chore/agent-skills-sync)',
      '↑8.8k ↓2.5k R76k CH92.3% $0.033 (sub) 3.6%/262k (auto) (kimi-coding) kimi-for-coding • medium',
    ].join('\n'), 'pwsh.exe', 'idle');

    expect(conversation.answer).toBe([
      '已提交 needs-human 裁决，并向用户提供 4 个可选方案：',
      '',
      '- 方案 A：结束当前会话并判定任务完成',
      '- 方案 B：完善项目文档（补充 README 等）',
      '- 方案 C：只读检查 config.toml 与配置差异',
      '- 方案 D：以 whatif 预览同步脚本效果',
      '',
      '等待用户选择后推进。',
    ].join('\n'));
    expect(conversation.answer).not.toContain('wmux supervisor decide');
    expect(conversation.answer).not.toContain('chore/agent-skills-sync');
    expect(conversation.answer).not.toContain('CH92.3%');
    expect(conversation.answer).not.toContain('kimi-for-coding');
  });

  it('keeps the complete visible Kimi answer when its question and answer marker have scrolled away', () => {
    const conversation = terminalSupervisorCoreExcerpt([
      '• 支持 -WhatIf 预演，不会误写。',
      '• 使用 ShouldProcess，符合 PowerShell 最佳实践。',
      '• 有 Set-StrictMode 和 $ErrorActionPreference = "Stop"。',
      '',
      '总体评价',
      '┌──────────┬────────────────────────────┐',
      '│ 维度     │ 评价                       │',
      '├──────────┼────────────────────────────┤',
      '│ 脚本质量 │ 合格，幂等、可预演           │',
      '└──────────┴────────────────────────────┘',
      '',
      '建议',
      '1. 确认模型名是否正确。',
      '2. 收紧权限：把 sandbox_mode 改为 default 或 read-only。',
      '3. 加一条 README 说明。',
      '4. 检查 .env 是否已由 .gitignore 排除。',
      '',
      '如果你愿意，我可以直接帮你调整为更安全的版本。',
      '────────────────────────────────────────────────',
      'yolo  K2.7 Coding thinking  E:\\work\\project',
      'context: 11%',
      '(26.6k/256k)',
    ].join('\n'), 'Kimi直连 · 配置检查', 'idle');

    expect(conversation.answer).toContain('• 支持 -WhatIf 预演，不会误写。');
    expect(conversation.answer).toContain('总体评价');
    expect(conversation.answer).toContain('│ 脚本质量 │ 合格，幂等、可预演');
    expect(conversation.answer).toContain('1. 确认模型名是否正确。');
    expect(conversation.answer).toContain('如果你愿意，我可以直接帮你调整为更安全的版本。');
    expect(conversation.answer).not.toContain('K2.7 Coding thinking');
    expect(conversation.answer).not.toContain('context:');
    expect(conversation.answer).not.toContain('26.6k/256k');
  });

  it.each([
    'Find and fix a bug in @filename',
    'Improve documentation in @filename',
    'Ask Codex to do anything',
    'Run /review on my current changes',
    'Implement {feature}',
  ])('ignores the Codex composer suggestion %s', (suggestion) => {
    const conversation = terminalConversationExcerpt([
      'OpenAI Codex (v0.147.0)',
      '› 你有哪些技能',
      '• 我可以协助代码开发、测试、审查和文档处理。',
      `› ${suggestion}`,
      'gpt-5.6-luna medium · D:\\repo',
    ].join('\n'), 'Codex直连 · test', 'idle');

    expect(conversation).toMatchObject({
      question: '你有哪些技能',
      answer: '我可以协助代码开发、测试、审查和文档处理。',
    });
  });

  it('uses the latest answered Codex turn instead of an unknown composer suggestion', () => {
    const conversation = terminalConversationExcerpt([
      'OpenAI Codex (v0.147.0)',
      'model: gpt-5.3-codex-spark high',
      '› 你是什么模型',
      '⚠ Skill descriptions were shortened to fit the skills context budget.',
      '• 我是 GPT-5 系列的 Codex（面向代码协作的助手模型）。',
      '› Run /review on my current changes',
      'gpt-5.3-codex-spark high · D:\\repo',
    ].join('\n'), 'Codex直连 · sdf', 'idle');

    expect(conversation).toMatchObject({
      question: '你是什么模型',
      answer: '我是 GPT-5 系列的 Codex（面向代码协作的助手模型）。',
    });
    expect(conversation.answer).not.toContain('/review');
  });

  it('keeps long final replies from Codex and Kimi', () => {
    const longAnswer = `结论：已完成检查。\n\n${'这里是需要在飞书中保留的详细回复。'.repeat(100)}\n\n以上是完整结果。`;
    const codex = terminalConversationExcerpt([
      '› 请详细说明检查结果',
      '• Ran npm test',
      '  └ Tests passed',
      `• ${longAnswer}`,
      '› Ask Codex to do anything',
      'gpt-5.6-sol high fast · E:\\work\\wmux',
    ].join('\n'), 'Codex直连 · long', 'idle');
    const kimi = terminalConversationExcerpt([
      '✦ 请详细说明检查结果',
      '● Summarize the completed checks for the user.',
      `● ${longAnswer}`,
      'yolo  K3-256k thinking: high  C:\\repo',
    ].join('\n'), 'Kimi直连 · long', 'idle');

    expect(longAnswer.length).toBeGreaterThan(850);
    expect(codex).toMatchObject({ question: '请详细说明检查结果', answer: longAnswer });
    expect(kimi).toMatchObject({ question: '请详细说明检查结果', answer: longAnswer });
  });

  it('creates an unsupervised Codex direct terminal that remains sendable and supervisable', () => {
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    const result = remoteControl({
      action: 'create-task',
      name: '修复登录页',
      task: '检查登录流程并补齐测试',
      cwd: 'E:\\Desktop\\wmux任务\\修复登录页-20260806-090807',
      displayPath: '桌面\\wmux任务\\修复登录页-20260806-090807',
      actor: 'ou-user',
    });

    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('首条任务将在终端就绪后自动发送') });
    const workspace = useStore.getState().workspaces.find((item) => item.title === '修复登录页');
    expect(workspace).toBeTruthy();
    const directSurface = workspace?.splitTree.type === 'leaf' ? workspace.splitTree.surfaces[0] : undefined;
    expect(directSurface).toMatchObject({
      customTitle: 'Codex直连 · 修复登录页',
      cwd: 'E:\\Desktop\\wmux任务\\修复登录页-20260806-090807',
      startupCommands: [expect.stringMatching(/^codex -- \(ConvertFrom-Json /)],
    });
    expect(directSurface?.startupInput).toBeUndefined();
    expect(writes).not.toHaveBeenCalled();

    const listed = JSON.parse(remoteControl({ action: 'list' }).message).terminals.find(
      (terminal: any) => terminal.surfaceId === directSurface?.id,
    );
    expect(listed).toMatchObject({
      label: 'Codex直连 · 修复登录页',
      workspaceId: workspace?.id,
      workspace: '修复登录页',
      cwd: 'E:\\Desktop\\wmux任务\\修复登录页-20260806-090807',
      supervised: false,
      supervisionState: 'none',
    });

    surfaceTerminalRegistry.set(directSurface!.id, {
      buffer: {
        active: {
          baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
    } as any);
    writes.mockClear();
    expect(remoteControl({ action: 'send', terminal: directSurface?.id, task: '继续检查错误处理', actor: 'ou-user' }))
      .toMatchObject({ ok: true });
    expect(writes).toHaveBeenCalledWith(directSurface?.id, '继续检查错误处理');

    expect(remoteControl({
      action: 'start', terminals: [directSurface?.id], taskGoal: '完成登录页错误处理', stopWhen: '测试通过', stopWhenKind: 'concrete', autonomous: false,
    })).toMatchObject({ ok: true });
    const pairedLane = useStore.getState().supervisor.lanes.find((item) => item.surfaceId === directSurface?.id);
    expect(pairedLane).toBeTruthy();
    const pairedWorkspace = useStore.getState().workspaces.find((item) => item.id === workspace?.id);
    expect(pairedWorkspace?.splitTree.type === 'leaf'
      ? pairedWorkspace.splitTree.surfaces.some((surface) => surface.id === pairedLane?.supervisorSurfaceId)
      : false).toBe(true);
    expect(useStore.getState().workspaces.some((item) => item.title === 'AI 监督')).toBe(false);
    surfaceTerminalRegistry.delete(directSurface!.id);
  });

  it('rebuilds an exited project AI instead of delivering into its PowerShell shell', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'start', projectDir: 'E:\\manager-recovery', goal: '恢复退出的项目 AI',
      preconditions: ['项目状态已持久化'], doneWhen: ['项目 AI 可继续管理'],
    })).resolves.toMatchObject({ ok: true });
    const project = useStore.getState().projectManager!;
    const previousSurfaceId = project.managerSurfaceId!;
    markTerminalRuntimeExited(previousSurfaceId, 'Codex Agent 已退出');
    writes.mockClear();

    expect((globalThis.window as any).__wmux_queueProjectManagerRuntimeRecovery({
      projectId: project.id,
      role: 'manager',
      detail: 'Codex Agent 已退出',
    })).toBe(true);

    await vi.waitFor(() => {
      expect(useStore.getState().projectManager?.managerSurfaceId).not.toBe(previousSurfaceId);
    });
    const replacementSurfaceId = useStore.getState().projectManager?.managerSurfaceId;
    expect(replacementSurfaceId).toBeTruthy();
    expect(writes.mock.calls.some(([surfaceId]) => surfaceId === previousSurfaceId)).toBe(false);
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'manager-runtime-restarted' }),
    ]));
    clearTerminalRuntimeStatus(previousSurfaceId);
    if (replacementSurfaceId) clearTerminalRuntimeStatus(replacementSurfaceId);
  });

  it('creates one dedicated user-records terminal with its fixed directory and default skill', () => {
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    const request = {
      action: 'create-task',
      name: USER_RECORDS_TERMINAL_NAME,
      task: USER_RECORDS_TERMINAL_STARTUP_INPUT,
      agent: USER_RECORDS_TERMINAL_AGENT,
      preset: 'user-records',
      cwd: USER_RECORDS_TERMINAL_DIRECTORY,
    };

    const created = remoteControl(request);
    expect(created).toMatchObject({
      ok: true,
      message: expect.stringContaining('默认技能 $user-data-management'),
    });
    const workspace = useStore.getState().workspaces.find(
      (item) => item.title === USER_RECORDS_TERMINAL_NAME,
    );
    const surface = workspace?.splitTree.type === 'leaf' ? workspace.splitTree.surfaces[0] : undefined;
    expect(workspace).toMatchObject({ cwd: USER_RECORDS_TERMINAL_DIRECTORY });
    expect(surface).toMatchObject({
      customTitle: USER_RECORDS_TERMINAL_NAME,
      cwd: USER_RECORDS_TERMINAL_DIRECTORY,
      userRecordsTerminal: true,
      startupCommands: [expect.stringContaining('$user-data-management')],
    });
    expect(surface?.projectManagerTerminal).toBeUndefined();
    expect(surface?.projectManagerProjectId).toBeUndefined();

    const repeated = remoteControl(request);
    expect(repeated).toMatchObject({
      ok: true,
      surfaceId: surface?.id,
      message: expect.stringContaining('已存在'),
    });
    expect(useStore.getState().workspaces.filter(
      (item) => item.title === USER_RECORDS_TERMINAL_NAME,
    )).toHaveLength(1);
  });

  it('rejects a user-records preset that changes its dedicated terminal contract', () => {
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    expect(remoteControl({
      action: 'create-task',
      name: USER_RECORDS_TERMINAL_NAME,
      task: USER_RECORDS_TERMINAL_STARTUP_INPUT,
      agent: USER_RECORDS_TERMINAL_AGENT,
      preset: 'user-records',
      cwd: 'E:\\other',
    })).toMatchObject({ ok: false, error: '用户记录终端配置无效。' });
    expect(useStore.getState().workspaces.some(
      (item) => item.title === USER_RECORDS_TERMINAL_NAME,
    )).toBe(false);
  });

  it('adds a direct task terminal to an existing session while keeping the selected task directory', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-existing' as any,
      title: '现有会话',
      cwd: 'E:\\existing',
      splitTree: {
        type: 'leaf', paneId: 'pane-existing' as any, activeSurfaceIndex: 0,
        surfaces: [{ id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', cwd: 'E:\\existing' }],
      },
    }]);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    const existingWorkspaceId = useStore.getState().workspaces[0].id;

    expect(remoteControl({
      action: 'create-task',
      name: '新增检查',
      task: '执行新增检查',
      agent: 'kimi',
      cwd: 'E:\\Desktop\\wmux任务\\新增检查-20260814-120000',
      displayPath: '桌面\\wmux任务\\新增检查-20260814-120000',
      anchorWorkspace: existingWorkspaceId,
    })).toMatchObject({ ok: true, message: expect.stringContaining('已在会话“现有会话”添加 Kimi 直连终端') });

    expect(useStore.getState().workspaces).toHaveLength(1);
    const workspace = useStore.getState().workspaces[0];
    const leaf = workspace.splitTree.type === 'leaf' ? workspace.splitTree : undefined;
    expect(leaf?.surfaces).toHaveLength(2);
    expect(leaf?.activeSurfaceIndex).toBe(1);
    expect(leaf?.surfaces[1]).toMatchObject({
      customTitle: 'Kimi直连 · 新增检查',
      cwd: 'E:\\Desktop\\wmux任务\\新增检查-20260814-120000',
      startupCommands: ['kimi # wmux-automated-agent-task'],
      startupInput: '执行新增检查',
    });
    expect(useStore.getState().activeWorkspaceId).toBe(workspace.id);
  });

  it.each([
    ['kimi', 'Kimi'],
    ['grok', 'Grok'],
  ] as const)('creates a %s direct terminal with the selected launcher', (agent, label) => {
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    expect(remoteControl({
      action: 'create-task',
      name: `${label}任务`,
      task: '执行首条任务',
      agent,
      cwd: `E:\\Desktop\\wmux任务\\${label}任务-20260807-120000`,
    })).toMatchObject({ ok: true, message: expect.stringContaining(`已创建 ${label} 直连终端`) });

    const workspace = useStore.getState().workspaces.find((item) => item.title === `${label}任务`);
    const surface = workspace?.splitTree.type === 'leaf' ? workspace.splitTree.surfaces[0] : undefined;
    expect(surface?.customTitle).toBe(`${label}直连 · ${label}任务`);
    if (agent === 'kimi') {
      expect(surface).toMatchObject({
        startupCommands: ['kimi # wmux-automated-agent-task'],
        startupInput: '执行首条任务',
      });
    } else {
      expect(surface?.startupCommands?.[0]).toMatch(/^grok -- \(ConvertFrom-Json /);
      expect(surface?.startupInput).toBeUndefined();
    }
  });

  it('lets the project manager pause one project for clarification and accepts the first desktop or Feishu answer', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({ action: 'start', projectDir: 'E:\\question-a', goal: '实现项目 A 的登录配置', preconditions: ['无额外物理前置条件'], doneWhen: ['登录配置测试通过'] });
    const first = useStore.getState().projectManager!;
    await remote({ action: 'start', projectDir: 'E:\\question-b', goal: '实现项目 B 的登录配置', preconditions: ['无额外物理前置条件'], doneWhen: ['登录配置测试通过'] });
    const second = useStore.getState().projectManager!;
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    await expect(request({
      action: 'user-question', callerSurfaceId: first.managerSurfaceId, projectId: first.id,
      question: '选择哪种配置方案？',
      options: [{ id: 'keep', label: '保留', description: '兼容现状。' }, { id: 'replace', label: '替换' }],
      recommendedOptionId: 'keep',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('description') });
    await expect(request({
      action: 'user-question', callerSurfaceId: first.managerSurfaceId, projectId: first.id,
      question: '选择哪种配置方案？',
      options: [
        { id: 'keep', label: '保留', description: '兼容现状。' },
        { id: 'replace', label: '替换', description: '配置更简洁。' },
      ],
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('recommendedOptionId') });
    await expect(request({
      action: 'user-question', callerSurfaceId: first.managerSurfaceId, projectId: first.id,
      question: '是否复用现有配置策略？', decisionKey: 'configuration-strategy',
      options: [
        { id: 'keep', label: '保留配置', description: '保持兼容性。' },
        { id: 'replace', label: '采用新配置', description: '切换兼容策略。' },
      ],
      recommendedOptionId: 'keep',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('decisionScope') });

    await expect(request({
      action: 'user-question', callerSurfaceId: first.managerSurfaceId, projectId: first.id,
      question: '是否继续采用现有兼容配置方案？',
      decisionKey: 'configuration-strategy',
      decisionScope: '配置冲突时是否保留现有兼容性设置',
      context: '计划文件提供了另一种配置方向。',
      options: [
        { id: 'keep', label: '保留现有配置', description: '采用兼容性修改。' },
        { id: 'replace', label: '采用新配置', description: '配置更简洁，但兼容策略不同。' },
      ],
      recommendedOptionId: 'keep',
    })).resolves.toMatchObject({ ok: true, question: { recommendedOptionId: 'keep' } });
    expect(useStore.getState().projectManagers.find((project) => project.id === first.id)).toMatchObject({
      status: 'waiting', pendingUserQuestion: { question: '是否继续采用现有兼容配置方案？' },
    });
    expect(useStore.getState().projectManagers.find((project) => project.id === second.id)?.status).toBe('waiting');
    expect(useStore.getState().projectManagerDialogOpen).toBe(false);

    await expect(remote({
      action: 'answer-question', projectId: first.id, questionId: useStore.getState().projectManagers
        .find((project) => project.id === first.id)?.pendingUserQuestion?.id,
      optionId: 'keep', answer: '保留现有配置', source: 'feishu', reuseForSimilar: true,
    })).resolves.toMatchObject({
      ok: true,
      session: { id: first.id, status: 'waiting', pendingUserQuestion: undefined },
      event: { kind: 'user-clarification-answered', payload: { answeredBy: 'feishu', optionId: 'keep', reuseForSimilar: true } },
    });
    await expect(request({
      action: 'user-question', callerSurfaceId: first.managerSurfaceId, projectId: first.id,
      question: '同类配置冲突仍应如何处理？', decisionKey: 'configuration-strategy',
      decisionScope: '配置冲突时是否保留现有兼容性设置',
      options: [
        { id: 'keep', label: '保留现有配置', description: '继续采用兼容性修改。' },
        { id: 'replace', label: '采用新配置', description: '采用不同的兼容策略。' },
      ],
      recommendedOptionId: 'keep',
    })).resolves.toMatchObject({
      ok: true, autoAnswered: true, answer: '保留现有配置', optionId: 'keep',
    });
    expect(useStore.getState().projectManagers.find((project) => project.id === first.id)?.pendingUserQuestion)
      .toBeUndefined();
    await confirmAndResumeProject(first.id);
    await expect(remote({
      action: 'answer-question', projectId: first.id, optionId: 'replace', answer: '改为覆盖', source: 'desktop',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('没有待用户确认') });
    expect((globalThis.window as any).wmux.projectManager.appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user-clarification-requested',
      payload: expect.objectContaining({ question: expect.objectContaining({ question: '是否继续采用现有兼容配置方案？' }) }),
    }));
  });

  it('keeps a pending question when a replacement definition is invalid and supersedes it only after a valid update', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({
      action: 'start', projectDir: 'E:\\atomic-definition', goal: '完成旧目标',
      preconditions: ['测试环境可用'], doneWhen: ['旧目标验收通过'],
    });
    const project = useStore.getState().projectManager!;
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await request({
      action: 'user-question', callerSurfaceId: project.managerSurfaceId, projectId: project.id,
      question: '是否切换新的主目标？', context: '当前目标与新需求不同。',
      options: [
        { id: 'keep', label: '保留旧目标', description: '继续当前项目目标。' },
        { id: 'pivot', label: '切换新目标', description: '保留历史并建立新目标。' },
      ],
      recommendedOptionId: 'pivot',
    });
    const questionId = useStore.getState().projectManager?.pendingUserQuestion?.id;

    await expect(remote({
      action: 'update-definition', projectId: project.id, goal: '',
      preconditions: ['测试环境可用'], doneWhen: [], mode: 'pivot',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('目标不能为空') });
    expect(useStore.getState().projectManager?.pendingUserQuestion?.id).toBe(questionId);

    await expect(remote({
      action: 'update-definition', projectId: project.id, goal: '用户提供的新目标', mode: 'pivot',
    })).resolves.toMatchObject({
      ok: true,
      event: { payload: { supersededQuestionId: questionId } },
      session: { goal: '用户提供的新目标', doneWhen: [], pendingUserQuestion: undefined },
    });
    const goalChangeDelivery = JSON.stringify(useStore.getState().projectManager?.pendingManagerDeliveries);
    expect(goalChangeDelivery).toContain('用户提供的新主目标是当前权威目标');
    expect(goalChangeDelivery).toContain('先基于用户主目标起草条件');
  });

  it('lets project AI assess requirements first and asks only when it tries to execute underspecified work', async () => {
    useStore.getState().closeProjectManagerDialog();
    const project = {
      projectDir: 'C:\\Users\\tyk\\Desktop\\新建文件夹 (2)',
      goal: '测试相关功能',
      preconditions: ['无'],
      doneWhen: ['做个图书馆管理系统'],
    };
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    const result = await remote({
      action: 'start',
      ...project,
    });

    expect(result).toMatchObject({
      ok: true,
      restored: false,
      session: {
        status: 'waiting',
      },
    });
    expect(result.session.pendingUserQuestion).toBeUndefined();
    expect(useStore.getState().projectManagerDialogOpen).toBe(false);

    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'task-create', callerSurfaceId: useStore.getState().projectManager?.managerSurfaceId,
      projectId: useStore.getState().projectManager?.id,
    })).resolves.toMatchObject({
      ok: false,
      question: {
        question: expect.stringContaining('产品形态'),
        recommendedOptionId: 'local-web',
        options: [
          expect.objectContaining({ id: 'local-web', label: '本地网页系统', description: expect.stringContaining('推荐方案') }),
          expect.objectContaining({ id: 'desktop-app', label: '桌面单机应用' }),
          expect.objectContaining({ id: 'command-line', label: '命令行原型' }),
        ],
      },
    });
    expect(useStore.getState().projectManagerDialogOpen).toBe(false);
    expect((globalThis.window as any).wmux.projectManager.appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user-clarification-requested',
    }));
  });

  it('asks for user alignment when a specific goal still lacks acceptance criteria', async () => {
    useStore.getState().closeProjectManagerDialog();
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    const result = await remote({
      action: 'start',
      projectDir: 'E:\\optional-definition',
      goal: '实现并验证当前仓库的认证模块',
    });
    expect(result).toMatchObject({
      ok: true,
      session: { preconditions: [], doneWhen: [] },
    });
    expect(result.session.pendingUserQuestion).toBeUndefined();

    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'task-create',
      callerSurfaceId: result.session.managerSurfaceId,
      projectId: result.session.id,
    })).resolves.toMatchObject({
      ok: false,
      question: expect.objectContaining({
        question: expect.stringContaining('交付深度'),
      }),
    });
    expect(useStore.getState().projectManager?.pendingUserQuestion).toBeDefined();
  });

  it('requires structured user confirmation even when the drafted requirements are already specific', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    const result = await remote({
      action: 'start',
      projectDir: 'E:\\specific-definition',
      goal: '实现并验证当前仓库的认证模块',
      preconditions: ['使用现有测试环境'],
      doneWhen: ['认证模块单元测试通过并覆盖失败路径'],
    });
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    await expect(request({
      action: 'task-create', callerSurfaceId: result.session.managerSurfaceId,
      projectId: result.session.id,
    })).resolves.toMatchObject({
      ok: false,
      question: expect.objectContaining({
        question: expect.stringContaining('是否确认按当前需求推进'),
        recommendedOptionId: 'confirm-requirements',
      }),
    });
  });

  it('reuses a persisted initial alignment decision when restoring a project', async () => {
    const persisted = {
      id: 'pm-aligned-recovery', projectDir: 'E:\\aligned-recovery',
      goal: '实现认证模块', preconditions: ['测试环境可用'], planFiles: [], doneWhen: ['认证测试通过'],
      status: 'active' as const, workItems: [],
      events: [
        {
          id: 'required', sessionId: 'pm-aligned-recovery', ts: 10,
          kind: 'requirements-alignment-required' as const, summary: '项目首次启动检测',
        },
        {
          id: 'confirmed', sessionId: 'pm-aligned-recovery', ts: 20,
          kind: 'requirements-alignment-confirmed' as const, summary: '目标、范围和验收标准已明确',
        },
      ],
      createdAt: 1, updatedAt: 20,
    };
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({ action: 'recovery-candidates' })).resolves.toMatchObject({
      ok: true, candidates: [{ id: persisted.id }],
    });
    await expect(remote({ action: 'restore-projects', projectIds: [persisted.id] })).resolves.toMatchObject({
      ok: true, restored: true,
      projects: [{ id: persisted.id, status: 'active' }],
    });
    expect(useStore.getState().projectManager?.pendingUserQuestion).toBeUndefined();
    const alignmentEvents = useStore.getState().projectManager?.events.filter((event) => (
      event.kind === 'requirements-alignment-required' || event.kind === 'requirements-alignment-confirmed'
    ));
    expect(alignmentEvents).toHaveLength(2);
    expect((globalThis.window as any).wmux.projectManager.appendRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'requirements-alignment-required' }),
    );
  });

  it('requires a current-protocol alignment audit before resuming a legacy project', async () => {
    const persisted = {
      id: 'pm-legacy-recovery', projectDir: 'E:\\legacy-recovery',
      goal: '测试项目', preconditions: ['测试环境可用'],
      planFiles: [], doneWhen: ['完成项目'], status: 'active' as const,
      workItems: [], events: [], createdAt: 1, updatedAt: 2,
    };
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({ action: 'restore-projects', projectIds: [persisted.id] })).resolves.toMatchObject({
      ok: true,
      projects: [{ id: persisted.id, status: 'waiting' }],
    });
    expect(useStore.getState().projectManager?.pendingUserQuestion).toMatchObject({
      category: 'clarification',
      recommendedOptionId: 'minimal-prototype',
    });
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'requirements-alignment-required',
        summary: expect.stringContaining('当前协议下仍不充分'),
      }),
    ]));
  });

  it('persists and publishes a project AI runtime failure during recovery', async () => {
    const persisted = {
      id: 'pm-runtime-failure', projectDir: 'E:\\runtime-failure',
      goal: '恢复认证项目', preconditions: ['测试环境可用'], planFiles: [], doneWhen: ['认证测试通过'],
      status: 'active' as const, workItems: [], events: [], createdAt: 1, updatedAt: 2,
    };
    const projectManagerApi = (globalThis.window as any).wmux.projectManager;
    projectManagerApi.listActiveSessions.mockResolvedValue([persisted]);
    projectManagerApi.ensureSkill.mockResolvedValueOnce({ ok: false, error: '项目 AI skill 无法准备' });
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await remote({ action: 'recovery-candidates' });
    await expect(remote({ action: 'restore-projects', projectIds: [persisted.id] })).resolves.toMatchObject({
      ok: true,
      projects: [{ id: persisted.id, status: 'paused' }],
      warnings: [expect.stringContaining('项目 AI skill 无法准备')],
    });
    expect(projectManagerApi.appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: persisted.id,
      type: 'manager-runtime-failed',
      payload: expect.objectContaining({ message: '项目 AI skill 无法准备' }),
    }));
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: '项目运行异常',
      text: expect.stringContaining('项目 AI skill 无法准备'),
    }));
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'project-paused', payload: { source: 'runtime', attentionRequired: false } }),
      expect.objectContaining({ kind: 'manager-runtime-failed', summary: '项目 AI skill 无法准备' }),
    ]));
  });

  it('does not reopen requirements alignment when a started project is paused for a requirement-related reason', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'start', projectDir: 'E:\\aligned-pause', goal: '实现认证模块',
      preconditions: ['测试环境可用'], doneWhen: ['认证测试通过'],
    })).resolves.toMatchObject({ ok: true, session: { status: 'waiting' } });
    const session = useStore.getState().projectManager!;
    await confirmAndResumeProject(session.id);
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    await expect(request({
      action: 'pause', callerSurfaceId: session.managerSurfaceId, projectId: session.id,
      reason: '实现中发现需求范围仍有不足，先暂停重新规划',
    })).resolves.toMatchObject({
      ok: true,
      event: {
        kind: 'project-paused',
        payload: { source: 'manager', attentionRequired: true },
      },
    });
    expect((globalThis.window as any).wmux.projectManager.appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'project-paused',
      payload: expect.objectContaining({ source: 'manager', attentionRequired: true }),
    }));
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: '项目需要处理',
      text: expect.stringContaining('实现中发现需求范围仍有不足'),
    }));

    const paused = useStore.getState().projectManager!;
    expect(paused.status).toBe('paused');
    expect(paused.pendingUserQuestion).toBeUndefined();
    expect(paused.events.filter((event) => (
      event.kind === 'requirements-alignment-required' || event.kind === 'requirements-alignment-confirmed'
    ))).toHaveLength(2);
  });

  it('keeps a genuinely new external access grant at the user boundary', async () => {
    const session = bindProjectLaneToWorkItem({ projectId: 'pm-user-owned-external-access' });
    attachProjectManagerSurface(session.id, `manager-${session.id}`);
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id)!;
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    await expect(request({
      action: 'user-question', callerSurfaceId: current.managerSurfaceId, projectId: current.id,
      category: 'manual-intervention', workItemId: 'task-a', reasonCode: 'access-grant',
      blocker: '任务 AI 缺少生产云账号和新的部署角色授予。',
      question: '是否向任务 AI 授予生产云端部署访问？',
      context: '当前项目合同和既有凭据均未覆盖该外部访问。',
      options: [
        { id: 'grant', label: '授予生产访问', description: '新增生产云端部署角色和凭据。' },
        { id: 'keep-local', label: '保持本地范围', description: '不新增外部访问，项目继续保持暂停。' },
      ],
      recommendedOptionId: 'keep-local',
    })).resolves.toMatchObject({
      ok: true,
      question: { reasonCode: 'access-grant', recommendedOptionId: 'keep-local' },
    });
  });

  it('keeps authorization for a new third-party dependency at the user boundary', async () => {
    const session = bindProjectLaneToWorkItem({ projectId: 'pm-user-owned-new-dependency' });
    attachProjectManagerSurface(session.id, `manager-${session.id}`);
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id)!;
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    await expect(request({
      action: 'user-question', callerSurfaceId: current.managerSurfaceId, projectId: current.id,
      category: 'manual-intervention', workItemId: 'task-a', reasonCode: 'business-choice',
      blocker: '当前实现需要新增第三方依赖。',
      question: '是否允许任务 AI 运行 npm install new-package？',
      context: '该依赖不在现有 package.json 和 lockfile 中。',
      options: [
        { id: 'stdlib', label: '保持现有依赖', description: '使用标准库或项目已安装依赖实现。' },
        { id: 'install', label: '安装新依赖', description: '扩大依赖范围并更新 lockfile。' },
      ],
      recommendedOptionId: 'stdlib',
    })).resolves.toMatchObject({
      ok: true,
      question: { reasonCode: 'business-choice', recommendedOptionId: 'stdlib' },
    });
  });

  it('asks the user before restoring an underspecified legacy project', async () => {
    const persisted = {
      id: 'pm-unaccepted-recovery', projectDir: 'E:\\unaccepted-recovery',
      goal: '测试相关功能', preconditions: ['无'], planFiles: [], doneWhen: ['做个管理系统'],
      status: 'active' as const, workItems: [], events: [], createdAt: 1, updatedAt: 2,
    };
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await remote({ action: 'recovery-candidates' });
    await expect(remote({ action: 'restore-projects', projectIds: [persisted.id] })).resolves.toMatchObject({
      ok: true, restored: true, projects: [{ id: persisted.id, status: 'waiting' }],
    });
    expect(useStore.getState().projectManager?.pendingUserQuestion).toMatchObject({
      category: 'clarification',
      recommendedOptionId: expect.any(String),
    });
    expect(useStore.getState().projectManagerDialogOpen).toBe(false);
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'recovery-restored',
        summary: expect.stringContaining('旧项目 AI、监督 AI 和任务 AI 会话均已失效'),
      }),
    ]));
  });

  it('routes a manager reply back to the correlated project conversation', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({ action: 'start', projectDir: 'E:\\chat-a', goal: '项目 A', preconditions: ['无额外物理前置条件'], doneWhen: ['A 完成'] });
    const first = useStore.getState().projectManager!;
    await remote({ action: 'start', projectDir: 'E:\\chat-b', goal: '项目 B', preconditions: ['无额外物理前置条件'], doneWhen: ['B 完成'] });
    const second = useStore.getState().projectManager!;
    expect(first.managerSurfaceId).not.toBe(second.managerSurfaceId);

    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'status', callerSurfaceId: first.managerSurfaceId, projectId: second.id,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('只能由项目管理 AI'),
    });

    writes.mockClear();
    await expect(remote({
      action: 'message',
      source: 'desktop',
      projectId: first.id,
      messageId: 'desktop-project-a-1',
      message: '项目 A 现在进展如何？',
    })).resolves.toMatchObject({ ok: true });
    const firstAfterMessage = useStore.getState().projectManagers.find((project) => project.id === first.id);
    const deliveredToFirst = writes.mock.calls.some(([surfaceId, text]) => (
      surfaceId === first.managerSurfaceId && String(text).includes('项目 A 现在进展如何？')
    ));
    const queuedForFirst = firstAfterMessage?.pendingManagerDeliveries
      ?.some((delivery) => delivery.text.includes('项目 A 现在进展如何？'));
    expect(deliveredToFirst || queuedForFirst).toBe(true);
    expect(writes).not.toHaveBeenCalledWith(second.managerSurfaceId, expect.any(String));
    expect(useStore.getState().projectManagers.find((project) => project.id === second.id)?.pendingManagerDeliveries)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('项目 A 现在进展如何？') }),
      ]));
    useStore.getState().selectProjectManager(second.id);

    await expect(request({
      action: 'reply',
      callerSurfaceId: first.managerSurfaceId,
      correlationId: 'desktop-project-a-1',
      message: '项目 A 正在等待验证。',
    })).resolves.toMatchObject({ ok: true, event: { kind: 'manager-reply' } });

    const projects = useStore.getState().projectManagers;
    expect(projects.find((project) => project.id === first.id)?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'user-message', summary: '项目 A 现在进展如何？' }),
      expect.objectContaining({ kind: 'manager-reply', summary: '项目 A 正在等待验证。' }),
    ]));
    expect(projects.find((project) => project.id === second.id)?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'requirements-alignment-required' }),
    ]));
  });

  it('delivers a queued manager handoff after the project Agent becomes idle', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-manager-idle-wake' });
    const managerSurfaceId = 'project-manager-idle-wake';
    useStore.getState().restoreProjectManager({
      ...project,
      managerSurfaceId: managerSurfaceId as any,
    });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-project-manager-idle-wake' as any,
      title: '项目执行空间',
      cwd: project.projectDir,
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf', paneId: 'pane-project-manager-idle-wake' as any, activeSurfaceIndex: 0,
        surfaces: [{
          id: managerSurfaceId as any,
          type: 'terminal',
          shell: 'pwsh.exe',
          cwd: 'E:\\wmux-data\\project-manager\\runtime',
          projectManagerTerminal: true,
          projectManagerProjectId: project.id,
          projectManagerAgent: 'codex',
          projectManagerModel: '',
          projectManagerReasoningEffort: '',
        }],
      },
    }]);
    surfaceTerminalRegistry.set(managerSurfaceId, {
      buffer: {
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
      modes: { bracketedPasteMode: true },
    } as any);
    markTerminalRuntimeReady(managerSurfaceId);
    const managerState = { state: 'working', updatedAt: Date.now() };
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      'worker-a': agentState,
      [managerSurfaceId]: managerState,
    });
    const writeReliable = vi.fn(async () => true);
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;

    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'message',
      source: 'desktop',
      projectId: project.id,
      messageId: 'manager-idle-wake-1',
      message: '处理当前监督交接并留下下一责任者。',
    })).resolves.toMatchObject({ ok: true });
    expect(writeReliable).not.toHaveBeenCalled();
    expect(useStore.getState().projectManager?.pendingManagerDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'pending' }),
    ]));

    managerState.state = 'idle';
    managerState.updatedAt = Date.now() - 1_000;
    (globalThis.window as any).__wmux_flushProjectManagerDeliveries();
    await vi.waitFor(() => expect(writeReliable).toHaveBeenCalled());
    expect(String(writeReliable.mock.calls[0]?.[1] || '')).toContain('处理当前监督交接并留下下一责任者。');

    surfaceTerminalRegistry.delete(managerSurfaceId);
    clearTerminalRuntimeStatus(managerSurfaceId);
  });

  it('accepts a later tool lifecycle as proof when project message submit hook is missing', async () => {
    vi.useFakeTimers();
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-atomic-message' });
    const managerSurfaceId = 'project-manager-atomic';
    useStore.getState().restoreProjectManager({
      ...project,
      managerSurfaceId: managerSurfaceId as any,
    });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-project-manager-atomic' as any,
      title: '项目执行空间',
      cwd: project.projectDir,
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf', paneId: 'pane-project-manager-atomic' as any, activeSurfaceIndex: 0,
        surfaces: [{
          id: managerSurfaceId as any,
          type: 'terminal',
          shell: 'pwsh.exe',
          cwd: 'E:\\wmux-data\\project-manager\\runtime',
          projectManagerTerminal: true,
          projectManagerProjectId: project.id,
          projectManagerAgent: 'codex',
          projectManagerModel: '',
          projectManagerReasoningEffort: '',
        }],
      },
    }]);
    surfaceTerminalRegistry.set(managerSurfaceId, {
      buffer: {
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
      modes: { bracketedPasteMode: true },
    } as any);
    markTerminalRuntimeReady(managerSurfaceId);
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      'worker-a': agentState,
      [managerSurfaceId]: { state: 'idle', updatedAt: Date.now() - 1_000 },
    });
    let acknowledgeEnter: ((accepted: boolean) => void) | undefined;
    const enterAcknowledgement = new Promise<boolean>((resolve) => {
      acknowledgeEnter = resolve;
    });
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => (
      data === '\r' ? enterAcknowledgement : true
    ));
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;

    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'message',
      source: 'desktop',
      projectId: project.id,
      messageId: 'desktop-atomic-1',
      message: '继续保持暂停，等待新的复核结果。',
    })).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(writeReliable).toHaveBeenCalledTimes(2));

    const body = String(writeReliable.mock.calls[0]?.[1] || '');
    expect(body).toContain('[项目事件｜控制层｜project=');
    expect(body).toContain('无需重读技能或重新确认角色');
    expect(body).not.toContain('[项目 AI 角色锚点｜控制层]');
    expect(body).toContain('桌面项目管理消息');
    expect(body).toContain('继续保持暂停，等待新的复核结果。');
    expect(body).not.toMatch(/[\r\n]/u);
    expect(writeReliable.mock.calls[1]).toEqual([managerSurfaceId, '\r']);
    expect(useStore.getState().projectManager?.pendingManagerDeliveries).toHaveLength(1);

    acknowledgeEnter?.(true);
    await vi.waitFor(() => expect(useStore.getState().projectManager?.pendingManagerDeliveries?.[0])
      .toMatchObject({ stage: 'submitted' }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(useStore.getState().projectManager?.pendingManagerDeliveries?.[0])
      .toMatchObject({ stage: 'failed' });
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'manager-delivery-failed' }),
    ]));
    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: managerSurfaceId,
      event: 'PreToolUse',
      command: 'wmux project status',
    });
    expect(useStore.getState().projectManager?.pendingManagerDeliveries).toHaveLength(0);
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'manager-delivery-restored',
        payload: expect.objectContaining({ acknowledgement: 'PreToolUse' }),
      }),
    ]));
    surfaceTerminalRegistry.delete(managerSurfaceId);
    clearTerminalRuntimeStatus(managerSurfaceId);
  });

  it('revokes the old project run before routing a confirmed prerequisite-change message', async () => {
    expect(projectMessageChangeSignal('如果设备断电应该怎么办？')).toBeNull();
    expect(projectMessageChangeSignal('目标硬件刚刚断电，先不要继续实测')).toBe('prerequisite-change');
    const project = bindProjectLaneToWorkItem();
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({
      action: 'message',
      projectId: project.id,
      messageId: 'condition-change-1',
      source: 'desktop',
      message: '目标硬件刚刚断电，先不要继续实测',
    })).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('立即暂停旧任务'),
    });

    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(current?.status).toBe('paused');
    expect(current?.orientation).toMatchObject({ status: 'required' });
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a')?.controlState)
      .toBe('paused');
    expect(current?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user-message',
        correlationId: 'condition-change-1',
        payload: expect.objectContaining({ changeSignal: 'prerequisite-change' }),
      }),
    ]));
    await expect((globalThis.window as any).__wmux_projectManagerRequest({
      action: 'alignment-confirm', callerSurfaceId: current?.managerSurfaceId, projectId: project.id,
      goalUnderstanding: '仍按旧目标执行', scopeSummary: '仍按旧范围执行',
      acceptanceSummary: '仍按旧条件验收', reason: '试图跳过用户变更写回',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('先执行 wmux project update') });
  });

  it('keeps a real user decision across recovery and replays its notification record', async () => {
    const persisted: ProjectManagerSession = {
      id: 'pm-recover-user-question', projectDir: 'E:\\recover-user-question',
      goal: '完成需要人工接线的硬件验证', preconditions: ['设备保持断电'], planFiles: [],
      doneWhen: ['人工接线后验证通过'], requirementsVersion: 1, acceptedRequirementsVersion: 1,
      executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
      status: 'waiting', workItems: [], events: [], createdAt: 10, updatedAt: 20,
      pendingUserQuestion: {
        id: 'question-physical-action', category: 'manual-intervention',
        blocker: '需要用户完成设备接线', reasonCode: 'physical-action',
        question: '是否已经完成设备接线？', context: '接线完成前不能上电。',
        options: [{ id: 'wait', label: '尚未完成' }, { id: 'ready', label: '已经完成' }],
        recommendedOptionId: 'wait', previousStatus: 'active', createdAt: 19,
      },
    };
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({ action: 'restore-projects' })).resolves.toMatchObject({ ok: true, restored: true });

    expect(useStore.getState().projectManager?.pendingUserQuestion).toMatchObject({
      id: 'question-physical-action', reasonCode: 'physical-action',
    });
    expect((globalThis.window as any).wmux.projectManager.appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: persisted.id,
      type: 'user-clarification-restored',
      payload: expect.objectContaining({
        questionId: 'question-physical-action',
        question: expect.objectContaining({ question: '是否已经完成设备接线？' }),
      }),
    }));
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: '项目需要你的处理',
      text: expect.stringContaining('是否已经完成设备接线'),
    }));
  });

  it('treats a stale working claim as quiescent only when a real Agent prompt is visible', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({
      action: 'start', projectDir: 'E:\\safe-exit-stale-working', goal: '保存漏失 Stop 的项目',
      preconditions: ['环境安全'], doneWhen: ['运行时安全退出'],
    });
    const session = useStore.getState().projectManager!;
    const managerSurfaceId = session.managerSurfaceId!;
    const staleAt = Date.now() - 15 * 60_000 - 1;
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      ...auxiliaryProjectRuntimeIdleStates(session.id, [managerSurfaceId]),
      [managerSurfaceId]: {
        state: 'working', runDepth: 1, blockedReason: null, blockedVersion: 0, updatedAt: staleAt,
      },
    });
    surfaceTerminalRegistry.set(managerSurfaceId, {
      buffer: {
        active: {
          baseY: 0, cursorX: 0, cursorY: 0, length: 2,
          getLine: (index: number) => ({
            translateToString: () => index === 0 ? 'Stop hook (failed)' : '› Ask Codex to do anything',
          }),
        },
      },
    } as any);
    const kill = vi.fn();
    (globalThis.window as any).wmux.pty.kill = kill;
    (globalThis.window as any).wmux.pty.has = vi.fn(async () => false);

    expect(projectSafeExitEffectiveActivity({
      activityState: 'working', activityUpdatedAt: Date.now(), inputState: 'empty',
      screen: '› Ask Codex to do anything',
    })).toBe('working');
    expect(projectSafeExitEffectiveActivity({
      activityState: 'working', activityUpdatedAt: staleAt, inputState: 'pending',
      screen: '› Ask Codex to do anything',
    })).toBe('working');
    expect(projectSafeExitEffectiveActivity({
      activityState: 'working', activityUpdatedAt: staleAt, inputState: 'empty',
      screen: '⠋ Working (20m)',
    })).toBe('working');
    expect(projectSafeExitEffectiveActivity({
      activityState: 'working', activityUpdatedAt: staleAt, inputState: 'empty',
      screen: '/ T R A N S C R I P T /\nq to quit\nenter to edit message',
    })).toBe('working');

    const staleSafeExitResult = await remote({
      action: 'save-and-exit', projectId: session.id, reason: '保存漏失 Stop 的安全断点',
    });
    expect(staleSafeExitResult).toMatchObject({ ok: true, safeExited: true });
    expect(kill).toHaveBeenCalledWith(managerSurfaceId);
    expect(useStore.getState().projectManager).toMatchObject({
      safeExit: {
        status: 'saved',
        terminalCheckpoints: expect.arrayContaining([expect.objectContaining({
          surfaceId: managerSurfaceId, activityState: 'idle', inputState: 'empty',
        })]),
      },
    });
    surfaceTerminalRegistry.delete(managerSurfaceId);
  });

  it.each([
    { label: 'matching', restoredFingerprint: 'test-progress', expectedOrientation: 'ready' },
    { label: 'changed', restoredFingerprint: 'changed-after-safe-exit', expectedOrientation: 'required' },
  ])('restores a $label safe-exit checkpoint without confusing runtime rebuild with project progress', async ({
    restoredFingerprint, expectedOrientation,
  }) => {
    const project = bindProjectLaneToWorkItem({
      projectId: `pm-safe-checkpoint-${expectedOrientation}`, continuousExecution: true,
    });
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    const persisted: ProjectManagerSession = {
      ...current,
      status: 'paused',
      managerSurfaceId: undefined,
      taskTerminalSurfaceId: undefined,
      safeExit: {
        status: 'saved', requestedAt: 10, updatedAt: 20, completedAt: 20,
        reason: '测试断点恢复', progressFingerprint: 'test-progress', terminalCheckpoints: [],
      },
      workItems: current.workItems.map((item) => ({
        ...item,
        status: 'running' as const,
        workerSurfaceId: undefined,
        supervisorLaneId: undefined,
        attempts: 1,
        latestEvidence: '断点前已验证的证据',
      })),
    };
    useStore.getState().restoreProjectManager(null);
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().replaceAllWorkspaces([]);
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
    (globalThis.window as any).wmux.projectManager.captureProgress.mockResolvedValue({
      ok: true, snapshot: progressSnapshot(restoredFingerprint),
    });
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({ action: 'restore-projects' })).resolves.toMatchObject({
      ok: true, restored: true, projects: [{ id: persisted.id }],
    });

    const restored = useStore.getState().projectManagers.find((candidate) => candidate.id === persisted.id);
    expect(restored).toMatchObject({
      status: 'paused',
      recoveryState: 'checking',
      safeExit: { status: 'restoring', progressFingerprint: 'test-progress' },
      orientation: { status: expectedOrientation },
      workItems: [expect.objectContaining({
        status: 'running',
        attempts: 1,
        latestEvidence: '断点前已验证的证据',
      })],
    });
    if (expectedOrientation === 'ready') {
      expect(restored?.events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'project-orientation-required' }),
      ]));
      expect(restored?.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'recovery-restored',
          payload: expect.objectContaining({ recoverySource: 'safe-exit-checkpoint' }),
        }),
      ]));
    } else {
      expect(restored?.progressSync).toMatchObject({ status: 'review-required' });
      expect(restored?.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'project-orientation-required' }),
      ]));
    }
  });

  it('records an interrupted safe exit as abnormal recovery instead of claiming checkpoint continuity', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-safe-exit-interrupted' });
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    const persisted: ProjectManagerSession = {
      ...current,
      status: 'paused',
      managerSurfaceId: undefined,
      taskTerminalSurfaceId: undefined,
      safeExit: {
        status: 'saving', requestedAt: 10, updatedAt: 15,
        reason: '尚未完成的安全退出', progressFingerprint: 'test-progress', terminalCheckpoints: [],
      },
      workItems: current.workItems.map((item) => ({
        ...item, status: 'running' as const, workerSurfaceId: undefined, supervisorLaneId: undefined,
      })),
    };
    useStore.getState().restoreProjectManager(null);
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().replaceAllWorkspaces([]);
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({ action: 'restore-projects' })).resolves.toMatchObject({ ok: true, restored: true });

    const restored = useStore.getState().projectManagers.find((candidate) => candidate.id === persisted.id);
    expect(restored).toMatchObject({
      safeExit: { status: 'restoring' },
      workItems: [expect.objectContaining({
        status: 'waiting-decision',
      })],
      events: expect.arrayContaining([expect.objectContaining({
        kind: 'project-safe-exit-failed',
        summary: expect.stringContaining('安全退出完成前关闭'),
        payload: expect.objectContaining({
          phase: 'application-closed-before-safe-exit-completed',
          attentionRequired: true,
        }),
      })]),
    });
  });

  it('resumes a paused restoring project and explicitly wakes the project AI', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-paused-restoring-resume' });
    const store = useStore.getState();
    const current = store.projectManagers.find((candidate) => candidate.id === project.id)!;
    store.restoreProjectManager({
      ...current,
      status: 'paused',
      recoveryState: 'checking',
      safeExit: {
        status: 'restoring',
        requestedAt: 1,
        updatedAt: 2,
        completedAt: 2,
        reason: '恢复测试项目',
        progressFingerprint: 'test-progress',
        terminalCheckpoints: [],
      },
      subgoals: [{
        id: 'resume-stage',
        goalId: current.activeGoalId!,
        title: '恢复执行阶段',
        outcome: '继续完成恢复后的项目任务',
        acceptance: [...current.doneWhen],
        dependencies: [],
        status: 'planned',
        order: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
      workItems: current.workItems.map((item) => ({
        ...item,
        subgoalId: 'resume-stage',
        status: 'planned' as const,
        supervisorLaneId: undefined,
        workerSurfaceId: undefined,
        baseline: { status: 'required' as const, requirementsVersion: 1 },
      })),
    });
    store.setProjectSupervisorLanes([]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({
      action: 'resume',
      projectId: project.id,
      reason: '用户在桌面端恢复项目',
    })).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('项目 AI 已收到继续执行通知'),
    });

    const resumed = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(resumed).toMatchObject({
      status: 'active',
      recoveryState: 'checking',
      safeExit: { status: 'restoring', progressFingerprint: 'test-progress' },
    });
    expect(resumed?.pendingManagerDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        priority: true,
        dedupeKey: `project-user-resume:${project.id}`,
        text: expect.stringContaining('[用户已恢复项目｜立即继续执行链]'),
      }),
    ]));
    expect((globalThis.window as any).wmux.projectManager.captureProgress).not.toHaveBeenCalled();
  });

  it('rechecks a persisted saved marker when its project runtime still exists', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({
      action: 'start', projectDir: 'E:\\safe-exit-recheck', goal: '验证旧完成标记',
      preconditions: ['环境安全'], doneWhen: ['运行时确实退出'],
    });
    const session = useStore.getState().projectManager!;
    const managerSurfaceId = session.managerSurfaceId!;
    useStore.getState().restoreProjectManager({
      ...session,
      managerSurfaceId: undefined,
      safeExit: {
        status: 'saved', requestedAt: 1, updatedAt: 2, completedAt: 2, reason: '旧版本先写完成标记',
        terminalCheckpoints: [{
          surfaceId: managerSurfaceId, role: 'project-ai', label: '项目 AI',
          activityState: 'idle', inputState: 'empty',
        }],
      },
    });
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      ...auxiliaryProjectRuntimeIdleStates(session.id, [managerSurfaceId]),
      [managerSurfaceId]: { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: 2 },
    });
    surfaceTerminalRegistry.set(managerSurfaceId, {
      buffer: {
        active: {
          baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => 'Ask Codex to do anything' }),
        },
      },
    } as any);
    const kill = vi.fn();
    (globalThis.window as any).wmux.pty.kill = kill;
    (globalThis.window as any).wmux.pty.has = vi.fn(async () => false);

    await expect(remote({
      action: 'save-and-exit', projectId: session.id, reason: '重新确认旧完成标记',
    })).resolves.toMatchObject({ ok: true, safeExited: true });

    expect(kill).toHaveBeenCalledWith(managerSurfaceId);
    expect((globalThis.window as any).wmux.projectManager.captureProgress).toHaveBeenCalled();
    expect(useStore.getState().projectManager).toMatchObject({
      safeExit: { status: 'saved', completedAt: expect.any(Number) },
    });
    surfaceTerminalRegistry.delete(managerSurfaceId);
  });

  it('keeps project runtimes open when safe exit detects an unsubmitted terminal draft', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({
      action: 'start', projectDir: 'E:\\safe-exit-draft', goal: '保护未提交输入',
      preconditions: ['环境安全'], doneWhen: ['草稿不会丢失'],
    });
    const session = useStore.getState().projectManager!;
    const draft = '› 用户尚未提交的恢复说明';
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [session.managerSurfaceId!]: { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: 2 },
    });
    surfaceTerminalRegistry.set(session.managerSurfaceId!, {
      buffer: {
        active: {
          baseY: 0, cursorX: draft.length, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: (_trimRight?: boolean, start = 0, end?: number) => draft.slice(start, end) }),
        },
      },
    } as any);
    const kill = vi.fn();
    (globalThis.window as any).wmux.pty.kill = kill;

    await expect(remote({
      action: 'save-and-exit', projectId: session.id, reason: '测试草稿保护',
    })).resolves.toMatchObject({
      ok: true, safeExited: false,
      message: expect.stringContaining('未提交输入'),
    });

    expect(useStore.getState().projectManager).toMatchObject({
      status: 'paused',
      safeExit: {
        status: 'blocked',
        error: expect.stringContaining('未提交输入'),
        terminalCheckpoints: expect.arrayContaining([expect.objectContaining({
          surfaceId: session.managerSurfaceId, inputState: 'pending',
        })]),
      },
    });
    expect(kill).not.toHaveBeenCalled();
    expect(useStore.getState().workspaces.flatMap((candidate) => (
      candidate.splitTree.type === 'leaf' ? candidate.splitTree.surfaces : []
    )).some((surface) => surface.id === session.managerSurfaceId)).toBe(true);
    surfaceTerminalRegistry.delete(session.managerSurfaceId!);
  });

  it('persists a blocked safe-exit state when the first checkpoint save throws', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({
      action: 'start', projectDir: 'E:\\safe-exit-persist-failure', goal: '验证安全退出失败恢复',
      preconditions: ['环境安全'], doneWhen: ['失败状态可恢复'],
    });
    const session = useStore.getState().projectManager!;
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [session.managerSurfaceId!]: { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: 2 },
    });
    const projectManagerApi = (globalThis.window as any).wmux.projectManager;
    projectManagerApi.saveSession.mockRejectedValueOnce(new Error('snapshot write failed'));
    const kill = vi.fn();
    (globalThis.window as any).wmux.pty.kill = kill;

    await expect(remote({
      action: 'save-and-exit', projectId: session.id, reason: '测试持久化失败',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('snapshot write failed') });

    expect(useStore.getState().projectManager).toMatchObject({
      status: 'paused',
      safeExit: { status: 'blocked', error: expect.stringContaining('snapshot write failed') },
      events: expect.arrayContaining([expect.objectContaining({ kind: 'project-safe-exit-failed' })]),
    });
    expect(projectManagerApi.saveSession).toHaveBeenLastCalledWith(expect.objectContaining({
      safeExit: expect.objectContaining({ status: 'blocked' }),
    }));
    expect(kill).not.toHaveBeenCalled();
    expect(useStore.getState().workspaces.flatMap((candidate) => (
      candidate.splitTree.type === 'leaf' ? candidate.splitTree.surfaces : []
    )).some((surface) => surface.id === session.managerSurfaceId)).toBe(true);
  });

  it('can skip persisted projects for the current run without deleting them', async () => {
    const persisted = {
      id: 'pm-skipped', projectDir: 'E:\\old-project', goal: '旧项目',
      preconditions: ['环境安全'], doneWhen: ['完成'], status: 'active',
      workItems: [], events: [], createdAt: 10, updatedAt: 20,
    };
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({ action: 'skip-project-recovery' })).resolves.toMatchObject({
      ok: true, recoveryChoice: 'skip',
    });
    await expect(remote({ action: 'recovery-candidates' })).resolves.toMatchObject({
      ok: true, candidates: [], recoveryChoice: 'skip',
    });
    expect((globalThis.window as any).wmux.projectManager.deleteSession).not.toHaveBeenCalled();
    expect(useStore.getState().projectManagers).toEqual([]);
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.projectManagerTerminal)).toBe(false);

    await expect(remote({
      action: 'start', projectDir: 'E:\\new-project', goal: '本次新项目', preconditions: ['无额外物理前置条件'], doneWhen: ['完成'],
    })).resolves.toMatchObject({ ok: true, session: { projectDir: 'E:\\new-project' } });
    expect(useStore.getState().projectManagers.map((project) => project.id)).not.toContain('pm-skipped');
    expect(useStore.getState().projectManagers.map((project) => project.projectDir)).toEqual(['E:\\new-project']);
    expect((globalThis.window as any).wmux.projectManager.deleteSession).not.toHaveBeenCalled();
  });

  it('deletes one un-restored historical project record without loading its AI runtime', async () => {
    const persisted = {
      id: 'pm-delete-history', projectDir: 'E:\\delete-history', goal: '待删除历史项目',
      preconditions: ['环境安全'], doneWhen: ['完成'], status: 'paused',
      workItems: [], events: [], createdAt: 10, updatedAt: 20,
    };
    let records = [persisted];
    const projectManagerApi = (globalThis.window as any).wmux.projectManager;
    projectManagerApi.listActiveSessions.mockImplementation(async () => records);
    projectManagerApi.deleteSession.mockImplementation(async (projectId: string) => {
      records = records.filter((candidate) => candidate.id !== projectId);
      return { deleted: true };
    });
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({
      action: 'delete-recovery-project', projectId: persisted.id,
    })).resolves.toMatchObject({
      ok: true,
      deletedProjectId: persisted.id,
      message: expect.stringContaining('项目目录、代码和业务文件未删除'),
    });
    expect(projectManagerApi.deleteSession).toHaveBeenCalledWith(persisted.id);
    expect(useStore.getState().projectManagers).toEqual([]);
    await expect(remote({ action: 'recovery-candidates' })).resolves.toMatchObject({
      ok: true,
      candidates: [],
      recoveryChoice: 'pending',
    });
    await expect(remote({
      action: 'delete-recovery-project', projectId: persisted.id,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('已经不存在'),
    });
  });

  it('restores only the historical projects explicitly selected by the user', async () => {
    const persisted = [
      {
        id: 'pm-history-a', projectDir: 'E:\\history-a', goal: '历史项目 A',
        preconditions: ['环境安全'], doneWhen: ['完成 A'], status: 'active',
        workItems: [], events: [], createdAt: 10, updatedAt: 30,
      },
      {
        id: 'pm-history-b', projectDir: 'E:\\history-b', goal: '历史项目 B',
        preconditions: ['环境安全'], doneWhen: ['完成 B'], status: 'waiting',
        workItems: [], events: [
          {
            id: 'required-b', sessionId: 'pm-history-b', ts: 12,
            kind: 'requirements-alignment-required' as const, summary: '首次需求对齐',
          },
          {
            id: 'confirmed-b', sessionId: 'pm-history-b', ts: 13,
            kind: 'requirements-alignment-confirmed' as const, summary: '需求已确认',
          },
        ], createdAt: 11, updatedAt: 20,
      },
    ];
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue(persisted);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({ action: 'restore-projects', projectIds: ['pm-history-missing'] })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('已失效'),
    });
    expect(useStore.getState().projectManagers).toEqual([]);

    await expect(remote({
      action: 'restore-projects',
      projectIds: ['pm-history-b'],
      currentSituations: {
        'pm-history-a': '未选择项目的情况不应写入',
        'pm-history-b': '核心实现已完成，目前只需完成发布前验证。',
      },
    })).resolves.toMatchObject({
      ok: true,
      restored: true,
      projects: [{ id: 'pm-history-b', projectDir: 'E:\\history-b' }],
    });
    expect(useStore.getState().projectManagers.map((project) => project.id)).toEqual(['pm-history-b']);
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user-message',
        summary: '核心实现已完成，目前只需完成发布前验证。',
        payload: expect.objectContaining({ source: 'desktop-recovery' }),
      }),
    ]));
    expect(useStore.getState().projectManager?.events.some((event) => (
      event.kind === 'user-message' && !!event.payload?.changeSignal
    ))).toBe(false);
    expect(useStore.getState().projectManager?.events.filter((event) => (
      event.kind === 'requirements-alignment-required' || event.kind === 'requirements-alignment-confirmed'
    ))).toHaveLength(2);
    expect(JSON.stringify(useStore.getState().projectManager?.events)).not.toContain('未选择项目的情况不应写入');
    const recoveryBriefings = JSON.stringify(useStore.getState().projectManager?.pendingManagerDeliveries);
    expect(recoveryBriefings).toContain('[用户恢复时设置的当前情况｜优先核对]');
    expect(recoveryBriefings).toContain('[恢复需求异常门禁｜先核对再继续]');
    expect(recoveryBriefings).toContain('核心实现已完成，目前只需完成发布前验证。');
    expect(recoveryBriefings).not.toContain('未选择项目的情况不应写入');
    expect((globalThis.window as any).wmux.projectManager.deleteSession).not.toHaveBeenCalled();
  });

  it('lists and restores historical projects without replacing projects already loaded at runtime', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({
      action: 'start',
      projectDir: 'E:\\runtime-current',
      goal: '继续当前项目',
      preconditions: ['环境可用'],
      doneWhen: ['当前项目完成'],
    });
    const current = useStore.getState().projectManager!;
    const historical = {
      id: 'pm-runtime-history', projectDir: 'E:\\runtime-history', goal: '恢复历史项目',
      preconditions: ['环境安全'], doneWhen: ['历史项目完成'], status: 'paused' as const,
      workItems: [],
      events: [
        {
          id: 'runtime-history-required', sessionId: 'pm-runtime-history', ts: 10,
          kind: 'requirements-alignment-required' as const, summary: '首次需求对齐',
        },
        {
          id: 'runtime-history-confirmed', sessionId: 'pm-runtime-history', ts: 11,
          kind: 'requirements-alignment-confirmed' as const, summary: '需求已确认',
        },
      ],
      createdAt: 1, updatedAt: 20,
    };
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([current, historical]);

    await expect(remote({ action: 'recovery-candidates', mode: 'runtime' })).resolves.toMatchObject({
      ok: true,
      recoveryChoice: 'runtime',
      candidates: [{ id: historical.id }],
    });
    await expect(remote({
      action: 'restore-projects', mode: 'runtime', projectIds: [historical.id],
    })).resolves.toMatchObject({
      ok: true,
      restored: true,
      projects: expect.arrayContaining([
        expect.objectContaining({ id: current.id }),
        expect.objectContaining({ id: historical.id }),
      ]),
    });
    expect(useStore.getState().projectManagers.map((project) => project.id)).toEqual(expect.arrayContaining([
      current.id,
      historical.id,
    ]));
    expect(useStore.getState().projectManager?.id).toBe(historical.id);
  });

  it('revokes persisted alignment when a project recovery note changes requirements', async () => {
    const persisted = {
      id: 'pm-history-changed', projectDir: 'E:\\history-changed', goal: '交付桌面端和服务端',
      preconditions: ['测试环境可用'], doneWhen: ['桌面端和服务端测试通过'], status: 'active' as const,
      workItems: [],
      events: [
        {
          id: 'required', sessionId: 'pm-history-changed', ts: 10,
          kind: 'requirements-alignment-required' as const, summary: '首次需求对齐',
        },
        {
          id: 'confirmed', sessionId: 'pm-history-changed', ts: 20,
          kind: 'requirements-alignment-confirmed' as const, summary: '原需求已确认',
        },
      ],
      createdAt: 1, updatedAt: 20,
    };
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({
      action: 'restore-projects',
      projectIds: [persisted.id],
      currentSituations: {
        [persisted.id]: '需求改为只交付桌面端，验收标准也调整为安装包测试通过。',
      },
    })).resolves.toMatchObject({ ok: true, restored: true });

    const restored = useStore.getState().projectManager!;
    expect(restored.status).toBe('waiting');
    expect(restored.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user-message',
        payload: expect.objectContaining({
          source: 'desktop-recovery',
          changeSignal: 'requirements-change',
        }),
      }),
      expect.objectContaining({
        kind: 'requirements-alignment-required',
        summary: expect.stringContaining('恢复说明表明项目需求可能已变化'),
      }),
    ]));
    const recoveryBriefings = JSON.stringify(restored.pendingManagerDeliveries);
    expect(recoveryBriefings).toContain('[恢复需求异常门禁｜先核对再继续]');
    expect(recoveryBriefings).toContain('wmux project ask');
    expect(recoveryBriefings).toContain('用户答复并写回项目定义前');
  });

  it('creates multiple project-AI sessions while rejecting a duplicate project directory', async () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-projects' as any,
      title: '项目组合',
      cwd: 'E:\\portfolio',
      splitTree: {
        type: 'leaf', paneId: 'pane-projects' as any, activeSurfaceIndex: 0,
        surfaces: [{ id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '任务终端' }],
      },
    }]);
    const control = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    const start = (projectDir: string, goal: string) => control({
      action: 'start', projectDir, goal, preconditions: ['无额外物理前置条件'], doneWhen: [`${goal}验收通过`],
    });

    await expect(start('E:\\project-a', '项目 A')).resolves.toMatchObject({ ok: true });
    await expect(start('e:\\project-a\\', '同目录重复项目')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('该目录已绑定项目 AI'),
    });
    await expect(start('E:\\project-b', '项目 B')).resolves.toMatchObject({ ok: true });
    await expect(start('E:\\project-c', '项目 C')).resolves.toMatchObject({ ok: true });
    await expect(start('E:\\project-d', '项目 D')).resolves.toMatchObject({ ok: true });

    expect(useStore.getState().projectManagers.map((session) => session.projectDir)).toEqual([
      'E:\\project-a', 'E:\\project-b', 'E:\\project-c', 'E:\\project-d',
    ]);
    const managerSurfaceIds = useStore.getState().projectManagers.map((session) => session.managerSurfaceId);
    expect(managerSurfaceIds.every(Boolean)).toBe(true);
    expect(new Set(managerSurfaceIds).size).toBe(4);
    const managerWorkspaces = useStore.getState().workspaces.filter((workspace) => (
      workspace.splitTree.type === 'leaf'
      && workspace.splitTree.surfaces.some((surface) => surface.projectManagerTerminal === true)
    ));
    expect(managerWorkspaces).toHaveLength(4);
    for (const session of useStore.getState().projectManagers) {
      const workspace = managerWorkspaces.find((candidate) => (
        candidate.splitTree.type === 'leaf'
        && candidate.splitTree.surfaces.some((surface) => surface.id === session.managerSurfaceId)
      ));
      expect(workspace).toMatchObject({ transientSupervisorWorkspace: true });
      const projectWorkspaces = useStore.getState().workspaces.filter((candidate) => (
        candidate.splitTree.type === 'leaf'
        && candidate.splitTree.surfaces.some((surface) => (
          surface.projectManagerProjectId === session.id
          || surface.projectSupervisorProjectId === session.id
        ))
      ));
      expect(projectWorkspaces).toHaveLength(1);
      expect(projectWorkspaces[0].splitTree.type === 'leaf'
        ? projectWorkspaces[0].splitTree.surfaces.some((surface) => surface.id === session.taskTerminalSurfaceId)
        : false).toBe(true);
      expect(projectWorkspaces[0].splitTree.type === 'leaf'
        ? projectWorkspaces[0].splitTree.surfaces.some((surface) => surface.id === session.managerSurfaceId)
        : false).toBe(true);
      expect(workspace?.title).toContain(`${PROJECT_MANAGER_WORKSPACE_TITLE} ·`);
      expect(workspace?.splitTree.type === 'leaf'
        ? workspace.splitTree.surfaces.some((surface) => (
          surface.projectManagerProjectId === session.id
          && surface.projectManagerTerminal === true
        ))
        : false).toBe(true);
    }
  });

  it('lets project AI assign work without writing the task and lets only the supervisor dispatch it', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    const started = await remote({
      action: 'start',
      projectDir: 'E:\\supervisor-first-dispatch',
      goal: '由专属监督派发唯一主任务',
      preconditions: ['测试环境可用'],
      doneWhen: ['主任务形成可验证成果'],
    });
    const projectId = started.session.id;
    await confirmAndResumeProject(projectId);

    const store = useStore.getState();
    const current = store.projectManagers.find((project) => project.id === projectId)!;
    const assignment = {
      id: 'task-supervisor-first',
      title: '监督首次派发测试',
      goalId: current.activeGoalId,
      subgoalId: current.subgoals?.[0]?.id,
      requirementsVersion: current.requirementsVersion,
      authorizationVersion: current.authorizationVersion,
      executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
      complexityAssessment: {
        complexity: 'low' as const,
        decision: 'single-task' as const,
        signals: ['只有一个独立可验收成果'],
        rationale: '由唯一主任务 AI 连续完成',
        assessedAt: Date.now(),
      },
      status: 'planned' as const,
      dependencies: [],
      attempts: 0,
      updatedAt: Date.now(),
      executionHistory: [],
      contract: {
        objective: '完成监督首次派发测试成果',
        description: '',
        preconditions: ['测试环境可用'],
        scope: {
          root: current.projectDir,
          allowPaths: [],
          denyPaths: [],
          forbiddenActions: [],
        },
        authority: {
          technicalChoices: true,
          lowRiskRetries: true,
          targetedTests: true,
          internalThreads: false,
          continuousExecution: true,
          permissionConfirm: false,
          allowedCommandPrefixes: [],
        },
        stopWhen: ['形成测试成果'],
        validation: ['提供可验证证据'],
        budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      },
    };
    store.restoreProjectManager({ ...current, workItems: [assignment] });
    const taskSurfaceId = current.taskTerminalSurfaceId!;
    surfaceTerminalRegistry.set(taskSurfaceId, {
      buffer: {
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
    } as any);
    acknowledgeTaskPrompt(taskSurfaceId);
    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: taskSurfaceId,
      event: 'Stop',
    });
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [taskSurfaceId]: agentState,
    });
    writes.mockClear();

    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'supervisor-assign',
      callerSurfaceId: current.managerSurfaceId,
      projectId,
      workItemId: assignment.id,
    })).resolves.toMatchObject({
      ok: true,
      awaitingSupervisor: true,
      contractPending: true,
    });
    expect(writes.mock.calls.filter(([surfaceId]) => surfaceId === taskSurfaceId)).toHaveLength(0);

    const assignedProject = useStore.getState().projectManagers.find((project) => project.id === projectId)!;
    const assignedItem = assignedProject.workItems[0];
    const assignedLane = useStore.getState().supervisor.lanes.find((candidate) => (
      candidate.projectManagerProjectId === projectId && candidate.projectWorkItemId === assignment.id
    ))!;
    expect(assignedItem).toMatchObject({
      status: 'waiting-decision',
      supervisorLaneId: assignedLane.id,
      workerSurfaceId: taskSurfaceId,
      assignmentVersion: expect.any(Number),
    });
    expect(assignedLane).toMatchObject({
      projectTaskContractPending: true,
      awaitingReview: true,
      projectAssignmentVersion: assignedItem.assignmentVersion,
    });

    consumeQueuedControlMessage(assignedLane.id);
    const projectSurfaceCount = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf'
        ? workspace.splitTree.surfaces.filter((surface) => (
            surface.projectManagerProjectId === projectId
            || surface.projectSupervisorProjectId === projectId
          ))
        : []
    )).length;
    await expect(request({
      action: 'supervisor-assign',
      callerSurfaceId: current.managerSurfaceId,
      projectId,
      workItemId: assignment.id,
    })).resolves.toMatchObject({
      ok: true,
      alreadyAssigned: true,
      laneId: assignedLane.id,
    });
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === assignedLane.id)
      ?.supervisorSurfaceId).toBe(assignedLane.supervisorSurfaceId);
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf'
        ? workspace.splitTree.surfaces.filter((surface) => (
            surface.projectManagerProjectId === projectId
            || surface.projectSupervisorProjectId === projectId
          ))
        : []
    ))).toHaveLength(projectSurfaceCount);
    (globalThis.window as any).wmux.pty.writeReliable = vi.fn(async (surfaceId: string, data: string) => {
      writes(surfaceId, data);
      if (surfaceId === taskSurfaceId && data === '\r') acknowledgeTaskPrompt(taskSurfaceId);
      return true;
    });
    useStore.getState().patchSupervisor({ submitEnter: false });
    const decision = await (globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: taskSurfaceId,
      supervisorSurfaceId: assignedLane.supervisorSurfaceId,
      outcome: 'continue',
      next: '完成当前合同成果并返回可验证证据',
      taskWorkMode: 'single-thread',
    });
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, outcome: 'continue' });
    const taskPayload = writes.mock.calls
      .filter(([surfaceId]) => surfaceId === taskSurfaceId)
      .map(([, data]) => String(data))
      .join('');
    expect(taskPayload).toContain('[成果任务]');
    expect(taskPayload).not.toMatch(/项目 AI|监督 AI|辅助 AI|项目 ID|工作项 ID|\blane\b|控制层/iu);
    expect(useStore.getState().projectManagers.find((project) => project.id === projectId)?.workItems[0])
      .toMatchObject({ status: 'running', startedAt: expect.any(Number) });
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === assignedLane.id)
      ?.projectTaskContractPending).toBe(false);
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === assignedLane.id)
      ?.submitEnterOverride).toBe(true);

    useStore.getState().stopSupervisorLane(assignedLane.id, '模拟历史监督链丢失');
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: assignment.id,
      patch: { status: 'waiting-decision', latestBlocker: '历史监督链已经丢失' },
    }, projectId);
    writes.mockClear();
    const recovered = await request({
      action: 'supervisor-assign',
      callerSurfaceId: current.managerSurfaceId,
      projectId,
      workItemId: assignment.id,
    });
    expect(recovered, JSON.stringify(recovered)).toMatchObject({
      ok: true,
      awaitingSupervisor: true,
      contractPending: false,
      laneId: expect.any(String),
    });
    expect(recovered.laneId).not.toBe(assignedLane.id);
    expect(writes.mock.calls.filter(([surfaceId]) => surfaceId === taskSurfaceId)).toHaveLength(0);
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === recovered.laneId))
      .toMatchObject({ projectTaskContractPending: false, awaitingReview: true });
  });

  it('does not globally resume a portfolio-paused project whose requirements changed', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    const started = await remote({
      action: 'start', projectDir: 'E:\\portfolio-gate', goal: '完成明确的项目目标',
      preconditions: ['测试环境可用'], doneWhen: ['相关回归测试全部通过'],
    });
    const projectId = started.session.id;
    await confirmAndResumeProject(projectId);

    await expect(remote({ action: 'pause-all-projects', reason: '用户临时暂停全部项目' }))
      .resolves.toMatchObject({ ok: true, affectedProjects: [projectId] });
    const paused = useStore.getState().projectManagers.find((project) => project.id === projectId)!;
    useStore.getState().restoreProjectManagers([{
      ...paused,
      requirementsVersion: 2,
      acceptedRequirementsVersion: 1,
    }], projectId);

    await expect(remote({ action: 'resume-all-projects', reason: '用户尝试全局恢复' }))
      .resolves.toMatchObject({
        ok: true,
        affectedProjects: [],
        blockedProjects: [projectId],
      });
    expect(useStore.getState().projectManager).toMatchObject({
      id: projectId,
      status: 'paused',
      pausedByPortfolio: true,
    });
  });

  it('rejects and pauses a project whose manager runtime fell back to PowerShell', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    (globalThis.window as any).wmux.pty.has = vi.fn(async () => true);

    const starting = remote({
      action: 'start', projectDir: 'E:\\manager-shell-fallback', goal: '验证项目 AI 启动保护',
      preconditions: ['测试环境已准备'], doneWhen: ['失效项目 AI 不接收控制消息'],
    });
    await vi.waitFor(() => {
      expect(useStore.getState().workspaces.flatMap((workspace) => (
        workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
      )).find((surface) => surface.projectManagerProjectId && !surface.projectManagerTerminal)?.id).toBeTruthy();
    });
    const taskSurfaceId = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.projectManagerProjectId && !surface.projectManagerTerminal)!.id;
    surfaceTerminalRegistry.set(taskSurfaceId, {
      buffer: {
        active: {
          type: 'normal', baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => '› Ask Codex to do anything' }),
        },
      },
    } as any);
    markTerminalRuntimeReady(taskSurfaceId);
    await vi.waitFor(() => {
      expect(useStore.getState().workspaces.flatMap((workspace) => (
        workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
      )).find((surface) => surface.projectManagerTerminal)?.id).toBeTruthy();
    });
    const managerSurfaceId = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.projectManagerTerminal)!.id;
    surfaceTerminalRegistry.set(managerSurfaceId, {
      buffer: {
        active: {
          type: 'normal', baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => 'PS C:\\Users\\tester\\AppData\\Roaming\\wmux\\project-manager\\runtime>' }),
        },
      },
    } as any);
    markTerminalRuntimeReady(managerSurfaceId);

    await expect(starting).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('外层 Shell 提示符'),
    });
    expect(useStore.getState().projectManager).toMatchObject({
      status: 'paused',
      events: expect.arrayContaining([expect.objectContaining({ kind: 'manager-runtime-failed' })]),
    });

    surfaceTerminalRegistry.delete(managerSurfaceId);
    clearTerminalRuntimeStatus(managerSurfaceId);
    delete (globalThis.window as any).wmux.pty.has;
  });

  it('closes all three visible project runtimes when an undispatched project is deleted', async () => {
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().resetOrdinarySupervisorSession();
    useStore.getState().replaceAllWorkspaces([]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({
      action: 'start', projectDir: 'E:\\delete-planning-project', goal: '删除尚未派发任务的项目',
      preconditions: ['项目目录可访问'], doneWhen: ['项目完成'],
    })).resolves.toMatchObject({ ok: true });
    const projectId = useStore.getState().projectManager?.id;
    expect(projectId).toBeTruthy();
    expect(openProjectManagerConsole(projectId!)).toBe(true);
    const consoleWorkspace = useStore.getState().workspaces.find((workspace) => (
      workspace.transientSupervisorWorkspace === true
      && workspace.splitTree.type === 'leaf'
      && workspace.splitTree.surfaces.some((surface) => (
        surface.type === 'project-manager' && surface.projectManagerProjectId === projectId
      ))
    ));
    expect(consoleWorkspace).toBeDefined();
    expect(useStore.getState().supervisor.lanes.some((lane) => lane.projectManagerProjectId === projectId)).toBe(true);

    await expect(remote({ action: 'delete-project', projectId })).resolves.toMatchObject({
      ok: true, deletedProjectId: projectId,
    });
    expect(useStore.getState().workspaces.some((workspace) => workspace.id === consoleWorkspace?.id)).toBe(false);
  });

  it('closes an ordinary task terminal and cleans up its last-tab workspace', () => {
    useStore.getState().replaceAllWorkspaces([{
      title: '临时任务',
      splitTree: {
        type: 'leaf', paneId: 'pane-close' as any, activeSurfaceIndex: 0,
        surfaces: [{ id: 'worker-close' as any, type: 'terminal', customTitle: '普通任务' }],
      },
    }]);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({ action: 'close-terminal', terminal: 'worker-close', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: expect.stringContaining('已关闭 普通任务') });
    expect(useStore.getState().workspaces).toHaveLength(0);
    expect(remoteControl({ action: 'close-terminal', terminal: 'worker-close', actor: 'ou-user' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('已关闭') });
  });

  it('stops supervision and closes its dedicated AI before closing a supervised task terminal', () => {
    useStore.getState().replaceAllWorkspaces([{
      title: '监督任务',
      splitTree: {
        type: 'leaf', paneId: 'pane-close-supervised' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', customTitle: '被监督任务' },
          { id: 'supervisor-a' as any, type: 'terminal', customTitle: 'AI 监督 · 被监督任务', transientSupervisor: true },
        ],
      },
    }]);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({ action: 'close-terminal', terminal: 'supervisor-a', actor: 'ou-user' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('专属监督 AI 终端') });
    expect(remoteControl({ action: 'close-terminal', terminal: 'worker-a', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: expect.stringContaining('停止对应 AI 监督通道') });
    expect(useStore.getState().supervisor.lanes).toHaveLength(0);
    expect(useStore.getState().workspaces).toHaveLength(0);
  });

  function decide(params: Record<string, unknown>): any {
    const currentLane = useStore.getState().supervisor.lanes
      .find((candidate) => candidate.surfaceId === 'worker-a');
    const rawNext = String(params.next || '').trim();
    const ordinaryStructured = currentLane
      && !currentLane.projectManagerProjectId
      && currentLane.ordinaryProtocolVersion === ORDINARY_SUPERVISION_PROTOCOL_VERSION
      && rawNext
      && ['continue', 'rework'].includes(String(params.outcome || 'continue'));
    const needsHuman = String(params.outcome || 'continue') === 'needs-human';
    const ordinaryComplete = currentLane
      && !currentLane.projectManagerProjectId
      && currentLane.ordinaryProtocolVersion === ORDINARY_SUPERVISION_PROTOCOL_VERSION
      && String(params.outcome || 'continue') === 'complete';
    const needsHumanWithoutRecommendation = params.proposalKind === 'clarification'
      || params.proposalKind === 'direction-needed';
    const hasPlan = currentLane?.decisions?.some((decision) => !!decision.ordinaryPlan);
    return (globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a',
      supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue',
      reason: '测试裁决',
      ...params,
      ...(needsHuman ? {
        reason: String(params.reason || '需要用户决定当前边界'),
        impact: String(params.impact || '该决定只能由用户确认'),
        alternatives: String(params.alternatives
          || (/\n\s*\d+[.)、]/u.test(String(params.next || '')) ? params.next : '保持现状')),
        ...(!needsHumanWithoutRecommendation
          ? { next: String(params.next || '推荐方案 A：保持现状并等待用户确认') }
          : {}),
      } : {}),
      ...(ordinaryComplete && params.completionFile === undefined ? {
        stagePlanFile: '.wmux/tmp/stage-plan-complete.json',
        stagePlan: {
          objective: currentLane.config?.taskGoal || '完成当前测试任务',
          milestones: [{
            id: 'deliver', title: '完成并验证', outcome: '形成可验证结果',
            acceptance: [currentLane.config?.stopWhen || '测试任务完成'], status: 'completed',
            evidence: '测试证据已复核',
          }],
          remainingWork: [],
        },
        completionFile: '.wmux/tmp/completion.json',
        completionChecklist: {
          stopWhen: [{
            index: 1, status: 'satisfied', result: 'passed', method: 'evidence-review',
            evidence: '当前测试已形成明确完成证据',
          }],
          validation: [{
            index: 1, status: 'satisfied', result: 'passed', method: 'evidence-review',
            evidence: '计划成果验收标准已逐项复核',
          }],
          remainingWork: [],
        },
      } : {}),
      ...(ordinaryStructured ? {
        next: '',
        taskFile: '.wmux/tmp/task.json',
        taskDispatch: {
          kind: String(params.outcome || 'continue') === 'rework' ? 'rework' : 'task',
          sourceRevision: 1,
          milestoneId: 'deliver',
          outcome: rawNext,
          constraints: ['遵循目标项目规范'],
          acceptanceGap: ['当前成果形成可复核结果'],
          evidenceContext: [],
        },
        ...(!hasPlan && params.stagePlan === undefined ? {
          stagePlanFile: '.wmux/tmp/stage-plan.json',
          stagePlan: {
            objective: '完成当前测试任务',
            milestones: [{
              id: 'deliver', title: '完成并验证', outcome: '形成可验证结果',
              acceptance: ['测试任务完成'], status: 'active',
            }],
            remainingWork: ['测试任务完成'],
          },
        } : {}),
      } : {}),
    });
  }

  const ordinaryTaskDelivery = (next: string) => prepareTerminalPasteInput([
    '[任务]',
    `成果：${next}`,
    '约束：\n- 遵循目标项目规范',
    '本次任务验收：\n- 当前成果形成可复核结果',
    '请自主读取并遵循目标项目适用的规范与技能，选择实现方式并推进到可验证结果。实验、测试或操作无论成功还是失败，都必须如实执行并返回实际结果、失败信息和可复核证据；不得为了满足预设结论而隐瞒失败、篡改结果或无边界重复。完成后简要报告成果、验证证据、剩余工作和真实阻塞。',
  ].join('\n\n'), false);

  it('injects one safe next step from ordinary supervision', () => {
    expect(decide({ next: '运行相关单元测试' })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledWith('worker-a', ordinaryTaskDelivery('运行相关单元测试'));
    expect(String(writes.mock.calls[0][1])).not.toContain('监督 AI');
    expect(String(writes.mock.calls[0][1])).not.toContain('wmux context');
    expect(decide({ next: '重复发送下一步' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('records an evidence-backed goal vortex and immediately dispatches a bounded correction', () => {
    const appendRecord = vi.fn(async () => undefined);
    (globalThis.window as any).wmux.supervisor = { appendRecord };
    const result = decide({
      outcome: 'rework',
      next: '形成三个授权范围内电流条件的实际对照结果和结论',
      progressHealth: 'stalled',
      stallKind: 'single-condition-fixation',
      stallSignal: '任务 AI 连续围绕单一电流条件重复验证，没有新增判别证据',
      wastedEffort: '重复离线资格和相同条件测试，未推动实际上机对照',
      missingEvidence: '缺少多个授权范围内电流条件的实际对照结果',
      decisiveNextStep: '执行三组安全范围内电流条件的受控实测',
      authorizationBoundary: 'within-current',
      experimentConditions: '0.08A;0.10A;0.12A',
    });

    expect(result).toMatchObject({ ok: true, outcome: 'rework' });
    expect(useStore.getState().supervisor.lanes[0].goalVortex).toMatchObject({
      kind: 'single-condition-fixation',
      occurrences: 1,
      experimentConditions: ['0.08A', '0.10A', '0.12A'],
    });
    expect((globalThis.window as any).wmux.supervisor.appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'supervisor.goal-vortex.detected',
      payload: expect.objectContaining({
        kind: 'single-condition-fixation',
        wastedEffort: '重复离线资格和相同条件测试，未推动实际上机对照',
      }),
    }));
  });

  it('records the details when a repeated goal-vortex correction is rejected', () => {
    const appendRecord = vi.fn(async () => undefined);
    (globalThis.window as any).wmux.supervisor = { appendRecord };
    const stalled = {
      outcome: 'rework',
      next: '形成三个授权范围内电流条件的实际对照结果和结论',
      progressHealth: 'stalled',
      stallKind: 'single-condition-fixation',
      stallSignal: '任务 AI 连续围绕单一电流条件重复验证，没有新增判别证据',
      wastedEffort: '重复离线资格和相同条件测试，未推动实际上机对照',
      missingEvidence: '缺少多个授权范围内电流条件的实际对照结果',
      decisiveNextStep: '改变实验条件并执行三组安全范围内受控实测',
      authorizationBoundary: 'within-current',
      experimentConditions: '0.08A;0.10A;0.12A',
    };

    expect(decide(stalled)).toMatchObject({ ok: true, outcome: 'rework' });
    useStore.getState().updateLane('lane-a', {
      awaitingReview: true,
      activeReviewId: 'review-vortex-2',
      reviewWorkerTurnId: 2,
      workerTurnId: 2,
    });

    expect(decide({ ...stalled, reviewId: 'review-vortex-2' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('禁止重复同一纠偏任务'),
    });
    expect(appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'supervisor.goal-vortex.rejected-repeat',
      payload: expect.objectContaining({
        occurrence: 2,
        previousCorrectionTask: expect.stringContaining(stalled.next),
        correctionTask: expect.stringContaining(stalled.next),
        wastedEffort: stalled.wastedEffort,
        missingEvidence: stalled.missingEvidence,
      }),
    }));
    expect(useStore.getState().supervisor.lanes[0].goalVortex?.occurrences).toBe(1);
  });

  it('requires a fresh task review and new evidence before clearing health incidents', () => {
    useStore.getState().updateLane('lane-a', {
      awaitingReview: true,
      activeReviewId: 'review-health-2',
      reviewWorkerTurnId: 2,
      workerTurnId: 2,
      ordinaryContextHealth: {
        fingerprint: 'forgotten-plan', symptoms: ['forgotten-plan'], signal: '遗忘当前规划',
        evidenceFingerprint: 'no-new-evidence', occurrences: 1,
        reviewId: 'review-health-1', workerTurnId: 1, updatedAt: 1,
      },
      goalVortex: {
        fingerprint: 'repeated-validation|within-current',
        evidenceFingerprint: 'no-new-evidence',
        kind: 'repeated-validation', signal: '反复运行同一验证', wastedEffort: '没有形成新结论',
        missingEvidence: '缺少新的判别结果', decisiveNextStep: '改用能产生决定性证据的验证',
        authorizationBoundary: 'within-current', experimentConditions: [],
        correctionTask: '执行决定性验证', occurrences: 1,
        reviewId: 'review-health-1', workerTurnId: 1, updatedAt: 1,
      },
    });

    expect(decide({
      reviewId: 'review-health-2', outcome: 'continue', next: '继续完成当前成果',
      contextHealth: 'healthy', progressHealth: 'healthy',
    })).toMatchObject({ ok: false, error: expect.stringContaining('新进展证据') });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      ordinaryContextHealth: expect.any(Object),
      goalVortex: expect.any(Object),
    });

    expect(decide({
      reviewId: 'review-health-2', outcome: 'continue', next: '继续完成当前成果',
      contextHealth: 'healthy', progressHealth: 'healthy',
      evidence: '任务 AI 已完成新的对照实验，形成三组结果并更新结论',
    })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      ordinaryContextHealth: undefined,
      goalVortex: undefined,
    });
  });

  it('rejects a single-condition goal vortex without a bounded experiment matrix', () => {
    expect(decide({
      outcome: 'rework', next: '继续研究当前条件',
      progressHealth: 'stalled', stallKind: 'single-condition-fixation',
      stallSignal: '反复验证同一条件', wastedEffort: '没有新增证据',
      missingEvidence: '缺少对照条件', decisiveNextStep: '扩展条件对照',
      authorizationBoundary: 'within-current', experimentConditions: '0.10A',
    })).toMatchObject({ ok: false, error: expect.stringContaining('2-4 个') });
  });

  it('rejects arbitrary next text for the current ordinary protocol', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: '尝试绕过结构化派发', next: '直接修改指定文件并运行命令',
    })).toMatchObject({ ok: false, error: expect.stringContaining('--task-file') });
    expect(writes).not.toHaveBeenCalled();
  });

  it('does not expose a wmux managed-role context to an ordinary task terminal', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-ordinary-role' as any,
      title: '普通任务项目',
      cwd: 'E:\\repo',
      splitTree: {
        type: 'leaf', paneId: 'pane-ordinary-role' as any, activeSurfaceIndex: 0,
        surfaces: [{ id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe' }],
      },
    }]);

    expect((globalThis.window as any).__wmux_roleContext({ callerSurfaceId: 'worker-a' }))
      .toMatchObject({
        ok: false,
        error: expect.stringContaining('当前终端不承载 wmux 管理角色'),
      });
    expect((globalThis.window as any).__wmux_authorizeSurfaceCapability({
      callerSurfaceId: 'worker-a', method: 'surface.read_text', params: { surfaceId: 'worker-a' },
    })).toMatchObject({ knownSurface: true, managed: false, allowed: true });
  });

  it('rejects implementation-route fields from an ordinary outcome plan', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: '建立成果计划',
      stagePlanFile: '.wmux/tmp/stage-plan.json',
      stagePlan: {
        objective: '完成当前测试任务', selectedRoute: '指定实现路线',
        milestones: [{
          id: 'deliver', title: '交付', outcome: '形成结果',
          acceptance: ['测试任务完成'], status: 'active',
        }],
        remainingWork: ['完成交付'],
      },
      taskFile: '.wmux/tmp/task.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 1, milestoneId: 'deliver', outcome: '形成结果',
        constraints: [], acceptanceGap: ['测试任务完成'], evidenceContext: [],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不能包含实现路线、路径、命令或技能字段'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects an ordinary plan that carries unresolved user-planning questions into execution', () => {
    expect(decide({
      outcome: 'continue',
      reason: '尝试按未对齐规划执行',
      next: '形成用户期望的最终交付结果',
      stagePlanFile: '.wmux/tmp/stage-plan-unresolved.json',
      stagePlan: {
        objective: '根据用户未确认的默认方案完成交付',
        milestones: [{
          id: 'deliver', title: '完成交付', outcome: '形成最终成果',
          acceptance: ['验收范围待用户确认'], status: 'active',
        }],
        remainingWork: ['需要用户选择最终验收范围'],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('禁止默认忽略或按推荐值执行'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('allows a literal product question in an otherwise aligned acceptance plan', () => {
    expect(decide({
      outcome: 'continue',
      reason: '需求已经明确',
      next: '形成已对齐的操作确认交互',
      stagePlanFile: '.wmux/tmp/stage-plan-literal-question.json',
      stagePlan: {
        objective: '交付操作确认交互',
        milestones: [{
          id: 'deliver', title: '完成交互', outcome: '形成可验收成果',
          acceptance: ['测试任务完成', '弹窗显示“是否继续？”并支持取消'], status: 'active',
        }],
        remainingWork: ['完成操作确认交互'],
      },
    })).toMatchObject({ ok: true, outcome: 'continue' });
  });

  it('rejects a task dispatch created for a stale user-plan revision', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: '旧规划任务', taskFile: '.wmux/tmp/task.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 2, milestoneId: 'deliver', outcome: '形成结果',
        constraints: [], acceptanceGap: ['测试任务完成'], evidenceContext: [],
      },
    })).toMatchObject({ ok: false, error: expect.stringContaining('拒绝投递旧规划') });
  });

  it('rejects copying the user stop condition into one dispatched task acceptance', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: '错误复制用户总条件',
      stagePlanFile: '.wmux/tmp/stage-plan-user-stop.json',
      stagePlan: {
        objective: '完成当前测试任务',
        milestones: [{
          id: 'deliver', title: '形成结果', outcome: '完成阶段成果',
          acceptance: ['测试任务完成'], status: 'active',
        }],
        remainingWork: ['完成阶段成果'],
      },
      taskFile: '.wmux/tmp/task-user-stop.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 1, milestoneId: 'deliver',
        outcome: '形成当前阶段结果', constraints: [],
        acceptanceGap: ['测试任务完成'], evidenceContext: [],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不能复制或轻微改写用户总停止条件'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects a prefixed or comma-split user stop condition anywhere in the task envelope', () => {
    const currentLane = useStore.getState().supervisor.lanes[0];
    useStore.getState().updateLane(currentLane.id, {
      config: {
        ...currentLane.config!,
        stopWhen: '正向实验形成结果，身份账本保持一致，完成最终复核',
      },
    });
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: '错误转发用户总条件',
      stagePlanFile: '.wmux/tmp/stage-plan-prefixed-stop.json',
      stagePlan: {
        objective: '完成当前测试任务',
        milestones: [{
          id: 'deliver', title: '形成结果', outcome: '完成阶段成果',
          acceptance: ['正向实验形成结果'], status: 'active',
        }],
        remainingWork: ['完成阶段成果'],
      },
      taskFile: '.wmux/tmp/task-prefixed-stop.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 1, milestoneId: 'deliver',
        outcome: '形成本次实验记录',
        constraints: ['本次任务要求身份账本保持一致'],
        acceptanceGap: ['实际操作完成并记录结果'],
        evidenceContext: ['当前需要完成最终复核'],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不能复制或轻微改写用户总停止条件'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('allows a task-local evidence criterion that is only part of a broader user stop condition', () => {
    const currentLane = useStore.getState().supervisor.lanes[0];
    useStore.getState().updateLane(currentLane.id, {
      config: {
        ...currentLane.config!,
        stopWhen: '测试任务完成并提供可复核证据',
      },
    });
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: '派发本次证据闭合任务',
      stagePlanFile: '.wmux/tmp/stage-plan-local-evidence.json',
      stagePlan: {
        objective: '完成当前测试任务',
        milestones: [{
          id: 'deliver', title: '形成证据', outcome: '取得本次可复核结果',
          acceptance: ['测试任务完成并提供可复核证据'], status: 'active',
        }],
        remainingWork: ['取得本次证据'],
      },
      taskFile: '.wmux/tmp/task-local-evidence.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 1, milestoneId: 'deliver',
        outcome: '形成本次执行证据', constraints: [],
        acceptanceGap: ['提供可复核证据'], evidenceContext: [],
      },
    })).toMatchObject({ ok: true, outcome: 'continue' });
  });

  it('lets the supervisor define outcome-neutral evidence acceptance for one experiment task', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: '执行一次受控上电实验并如实取证',
      stagePlanFile: '.wmux/tmp/stage-plan-experiment.json',
      stagePlan: {
        objective: '完成当前测试任务',
        milestones: [{
          id: 'deliver', title: '完成实验', outcome: '形成可复核实验结果',
          acceptance: ['测试任务完成'], status: 'active',
        }],
        remainingWork: ['完成实验并由监督判断结果'],
      },
      taskFile: '.wmux/tmp/task-experiment.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 1, milestoneId: 'deliver',
        outcome: '执行一次受控正向上电实验', constraints: ['沿用已确认安全条件'],
        acceptanceGap: ['实际执行完成并如实记录 PASS/FAIL、原始结果和证据'],
        evidenceContext: ['此前尚未形成上电实验结果'],
      },
    })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledWith(
      'worker-a',
      expect.stringContaining('本次任务验收'),
    );
    expect(writes).toHaveBeenCalledWith(
      'worker-a',
      expect.stringContaining('无论成功还是失败，都必须如实执行'),
    );
    expect(String(writes.mock.calls.at(-1)?.[1] || '')).not.toContain('监督 AI');
  });

  it('rejects a PASS-only acceptance for an empirical task', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: '错误地预设实验必须成功',
      taskFile: '.wmux/tmp/task-forced-pass.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 1, milestoneId: 'deliver',
        outcome: '执行正向上电实验', constraints: [],
        acceptanceGap: ['取得正向实验 PASS 结果'], evidenceContext: [],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不能预设必须 PASS'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('detects an empirical PASS-only requirement even when the outcome is generic', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: '用通用成果名掩盖实验成功预设',
      taskFile: '.wmux/tmp/task-generic-forced-pass.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 1, milestoneId: 'deliver',
        outcome: '形成可复核记录', constraints: [],
        acceptanceGap: ['上电实验必须 PASS'], evidenceContext: [],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不能预设必须 PASS'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('allows historical PASS evidence without treating it as a forced result for the next experiment', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: '基于历史事实执行下一次实验',
      stagePlanFile: '.wmux/tmp/stage-plan-historical-pass.json',
      stagePlan: {
        objective: '完成当前测试任务',
        milestones: [{
          id: 'deliver', title: '完成实验', outcome: '形成可复核实验结果',
          acceptance: ['测试任务完成'], status: 'active',
        }],
        remainingWork: ['完成反向实验'],
      },
      taskFile: '.wmux/tmp/task-historical-pass.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 1, milestoneId: 'deliver',
        outcome: '执行一次反向上电实验', constraints: [],
        acceptanceGap: ['实际执行并如实记录 PASS/FAIL、原始结果和证据'],
        evidenceContext: ['此前正向上电实验 PASS，已按约定停止'],
      },
    })).toMatchObject({ ok: true, outcome: 'continue' });
  });

  it('allows truthful recording and an existing safety-interlock path for an experiment', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: '按既有安全路径如实执行实验',
      stagePlanFile: '.wmux/tmp/stage-plan-truthful-record.json',
      stagePlan: {
        objective: '完成当前测试任务',
        milestones: [{
          id: 'deliver', title: '完成实验', outcome: '形成可复核实验结果',
          acceptance: ['测试任务完成'], status: 'active',
        }],
        remainingWork: ['完成实验取证'],
      },
      taskFile: '.wmux/tmp/task-truthful-record.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 1, milestoneId: 'deliver',
        outcome: '执行一次上电实验',
        constraints: ['通过既有安全联锁启动实验', '确保安全联锁检查通过'],
        acceptanceGap: ['实际执行完成并正确记录原始结果和证据'],
        evidenceContext: [],
      },
    })).toMatchObject({ ok: true, outcome: 'continue' });
  });

  it('rejects file, command, skill and route directives inside an ordinary task dispatch', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: '错误的实现型任务', taskFile: '.wmux/tmp/task.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 1, milestoneId: 'deliver',
        outcome: '必须修改 src/auth.ts 并运行 npm test',
        constraints: ['必须使用指定 skill'],
        acceptanceGap: ['测试任务完成'], evidenceContext: [],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不能指定文件、命令、技能或实现路线'),
    });

    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: 'English implementation directive', taskFile: '.wmux/tmp/task-en.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 1, milestoneId: 'deliver',
        outcome: 'Edit src/auth.ts and run npm test',
        constraints: ['Use the authentication skill'],
        acceptanceGap: ['Return the command output'], evidenceContext: [],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不能指定文件、命令、技能或实现路线'),
    });

    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue', reason: 'Control identity disclosure', taskFile: '.wmux/tmp/task-role.json',
      taskDispatch: {
        kind: 'task', sourceRevision: 1, milestoneId: 'deliver',
        outcome: "Follow the project manager's plan and report back to your supervisor",
        constraints: ['Keep the control plane informed'],
        acceptanceGap: ['Current outcome is verified'], evidenceContext: [],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不能暴露监督或内部编排身份'),
    });
  });

  it('rejects ordinary completion until every plan acceptance item has evidence', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'complete', reason: '错误地尝试提前完成',
      stagePlanFile: '.wmux/tmp/stage-plan-complete.json',
      stagePlan: {
        objective: '完成当前测试任务',
        milestones: [{
          id: 'deliver', title: '交付', outcome: '形成结果',
          acceptance: ['测试任务完成'], status: 'completed', evidence: '已有概括性说明',
        }],
        remainingWork: [],
      },
      completionFile: '.wmux/tmp/completion.json',
      completionChecklist: {
        stopWhen: [{
          index: 1, status: 'satisfied', result: 'passed', method: 'evidence-review',
          evidence: '用户停止条件已复核',
        }],
        validation: [],
        remainingWork: [],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('逐项覆盖全部成果验收'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects failed evidence for an ordinary acceptance item that requires passing', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'complete', reason: '测试失败但错误地尝试完成',
      stagePlanFile: '.wmux/tmp/stage-plan-complete.json',
      stagePlan: {
        objective: '完成当前测试任务',
        milestones: [{
          id: 'deliver', title: '交付', outcome: '形成结果',
          acceptance: ['相关测试通过'], status: 'completed', evidence: '测试已执行',
        }],
        remainingWork: [],
      },
      completionFile: '.wmux/tmp/completion.json',
      completionChecklist: {
        stopWhen: [{
          index: 1, status: 'satisfied', result: 'passed', method: 'evidence-review',
          evidence: '用户停止条件已复核',
        }],
        validation: [{
          index: 1, status: 'satisfied', result: 'failed', method: 'runtime-test',
          evidence: '相关测试实际失败',
        }],
        remainingWork: [],
      },
    })).toMatchObject({ ok: false, error: expect.stringContaining('失败结果不能') });
    expect(writes).not.toHaveBeenCalled();
  });

  it('does not let wording alone bypass the ordinary technical-blocker retry gate', () => {
    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'needs-human', proposalKind: 'important',
      reason: '同一编译错误需要用户处理', impact: '当前成果无法通过验收',
      alternatives: '方案 A：调整诊断假设；方案 B：停止当前分支',
      next: '推荐方案 A：先调整诊断假设',
    })).toMatchObject({ ok: false, error: expect.stringContaining('尚未达到升级条件') });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
  });

  it('rejects re-confirming physical conditions already covered by current user guidance', () => {
    const currentLane = useStore.getState().supervisor.lanes[0];
    useStore.getState().updateLane(currentLane.id, {
      config: {
        ...currentLane.config!,
        preconditions: '现有设备、接线和安全条件已确认，允许直接上机、上电并执行本项目测试。',
        supervisorNotes: '当前参数范围内持续推进实测。',
      },
    });

    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'needs-human', proposalKind: 'important',
      reason: '本次上电是否是在最近一次控制面失败后完成物理断电并重新上电后取得的？急停是否已确认就绪？',
      impact: '确认后才能执行下一次控制面的恢复',
      alternatives: '方案 A：用户再次确认；方案 B：保持停止',
      next: '推荐方案 A：请用户补充两项安全确认',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('用户最新确认的权威状态'),
    });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
  });

  it('rejects a high-confidence repeat of a standing user decision', () => {
    const reason = '是否改变现有 API 以绕过当前失败';
    const impact = '改变后会破坏现有调用方兼容性';
    const alternatives = '方案 A：保持现有 API；方案 B：改变 API';
    const next = '推荐方案 A：保持现有 API';
    const currentLane = useStore.getState().supervisor.lanes[0];
    useStore.getState().updateLane(currentLane.id, {
      standingUserDecisions: [{
        decision: '保持现有 API，优先补充证据后继续',
        subject: [reason, impact, alternatives, next].join('\n'),
        proposalKind: 'route-change', sourceApprovalId: 'approval-api',
        updatedAt: 1, planRevision: 1,
      }],
    });

    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      outcome: 'needs-human', proposalKind: 'route-change',
      reason, impact, alternatives, next,
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('已由用户持续决策 approval-api 覆盖'),
    });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
  });

  it('opens an ordinary-only review when a long task turn returns idle after bounded interruption', async () => {
    vi.useFakeTimers();
    useStore.getState().updateLane('lane-a', { awaitingReview: false, workerTurnId: 1 });
    screenText = 'OpenAI Codex\nWorking';
    agentState = { ...agentState, state: 'working', updatedAt: 2 };

    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: 'worker-a', event: 'UserPromptSubmit', task: '长期执行任务',
    });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(writes).toHaveBeenCalledWith('worker-a', '\x1b');

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(writes).toHaveBeenCalledWith('worker-a', '\x03');

    screenText = 'OpenAI Codex\n› Ask Codex to do anything';
    agentState = { ...agentState, state: 'idle', updatedAt: 3 };
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    const watchedLane = useStore.getState().supervisor.lanes[0];
    expect(watchedLane).toMatchObject({
      awaitingReview: true,
      activeReviewId: expect.stringContaining('ordinary-watchdog-review-'),
    });
    expect(watchedLane.projectManagerProjectId).toBeUndefined();
    expect(watchedLane.projectWorkItemId).toBeUndefined();
    expect(watchedLane.pendingSupervisorDeliveries)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'task-interrupted',
          text: expect.stringContaining('不调用项目 AI'),
        }),
      ]));
  });

  it('clears the same task Agent context after two degraded reviews and republishes trusted context', async () => {
    vi.useFakeTimers();
    screenText = 'Pi Agent\nAsk anything';
    let pendingBody = '';
    let sessionReadyAt = 0;
    let recoverySubmittedAt = 0;
    const submittedBodies: string[] = [];
    const writeReliable = vi.fn(async (surfaceId: string, data: string) => {
      if (data !== '\r') {
        pendingBody = data;
        submittedBodies.push(data);
        if (data.includes('[上下文已清空｜可信任务恢复]')) recoverySubmittedAt = Date.now();
      } else if (pendingBody === '/new') {
        screenText = 'Pi Agent\nStarting a new session…';
        agentState = { ...agentState, state: 'working', runDepth: 0, updatedAt: agentState.updatedAt + 1 };
        window.setTimeout(() => {
          screenText = 'Pi Agent\nAsk anything';
          agentState = { ...agentState, state: 'idle', runDepth: 0, updatedAt: agentState.updatedAt + 1 };
          sessionReadyAt = Date.now();
        }, 1_500);
      } else {
        agentState = { ...agentState, state: 'working', updatedAt: agentState.updatedAt + 1 };
        acknowledgeTaskPrompt(surfaceId);
      }
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    const first = decide({
      outcome: 'rework', next: '先纠正遗忘规划的问题',
      contextHealth: 'degraded',
      contextSymptoms: 'forgotten-plan,repeated-mistake',
      contextSignal: '任务 AI 遗忘用户规划并再次重复已经纠正的错误',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toMatchObject({ ok: true, outcome: 'rework' });
    expect(useStore.getState().supervisor.lanes[0].ordinaryContextHealth?.occurrences).toBe(1);

    useStore.getState().updateLane('lane-a', {
      awaitingReview: true,
      activeReviewId: 'review-context-2',
      reviewWorkerTurnId: 2,
      workerTurnId: 2,
    });
    agentState = { ...agentState, state: 'idle', runDepth: 0, updatedAt: agentState.updatedAt + 1 };
    screenText = 'Pi Agent\nAsk anything';

    const second = decide({
      reviewId: 'review-context-2', outcome: 'rework', next: '重新完成当前成果',
      contextHealth: 'degraded',
      contextSymptoms: 'forgotten-plan,repeated-mistake',
      contextSignal: '新任务回合仍遗忘用户规划并重复相同错误',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(second).resolves.toMatchObject({ ok: true, outcome: 'rework' });

    expect(submittedBodies).toHaveLength(3);
    expect(submittedBodies[1]).toBe('/new');
    expect(submittedBodies[2]).toContain('[上下文已清空｜可信任务恢复]');
    expect(sessionReadyAt).toBeGreaterThan(0);
    expect(recoverySubmittedAt).toBeGreaterThanOrEqual(sessionReadyAt);
    expect(submittedBodies[2]).not.toMatch(/监督 AI|普通监督链|裁决|lane/iu);
    expect(submittedBodies[2]).toContain('用户规划版本：r1');
    expect(submittedBodies[2]).toContain('AGENTS、技能与仓库规范');
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      ordinaryContextHealth: undefined,
      ordinaryContextReset: undefined,
      ordinaryContextResetCount: 1,
      ordinaryContextResetPlanRevision: 1,
      awaitingReview: false,
    });
  });

  it('reports a failed context clear and never retries it automatically', async () => {
    screenText = 'OpenAI Codex\n› Ask Codex to do anything';
    useStore.getState().updateLane('lane-a', {
      awaitingReview: true,
      activeReviewId: 'review-context-failed',
      reviewWorkerTurnId: 2,
      workerTurnId: 2,
      ordinaryContextHealth: {
        fingerprint: 'forgotten-plan|repeated-mistake',
        symptoms: ['forgotten-plan', 'repeated-mistake'],
        signal: '首次发现上下文退化',
        evidenceFingerprint: 'no-new-evidence',
        occurrences: 1,
        reviewId: 'review-context-1',
        workerTurnId: 1,
        updatedAt: 1,
      },
    });
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '/new') throw new Error('clear rejected');
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({
      reviewId: 'review-context-failed', outcome: 'rework', next: '重新完成当前成果',
      contextHealth: 'degraded',
      contextSymptoms: 'forgotten-plan,repeated-mistake',
      contextSignal: '第二个任务回合仍然遗忘规划并重复错误',
    })).resolves.toMatchObject({
      ok: false,
      contextResetFailed: true,
      requiresHuman: true,
      error: expect.stringContaining('clear rejected'),
    });
    expect(useStore.getState().supervisor.lanes[0].ordinaryContextReset).toMatchObject({
      status: 'failed', error: expect.stringContaining('clear rejected'),
    });
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: 'AI 监督需要你的处理',
    }));
    const writesAfterFailure = writeReliable.mock.calls.length;

    expect(decide({
      reviewId: 'review-context-failed', outcome: 'rework', next: '不得再次清空',
      contextHealth: 'degraded',
      contextSymptoms: 'forgotten-plan,repeated-mistake',
      contextSignal: '同一问题再次出现',
    })).toMatchObject({ ok: false, error: expect.stringContaining('禁止自动重试') });
    expect(writeReliable).toHaveBeenCalledTimes(writesAfterFailure);
  });

  it('cancels context clearing before Enter when the user plan changes in flight', async () => {
    vi.useFakeTimers();
    screenText = 'OpenAI Codex\n› Ask Codex to do anything';
    useStore.getState().updateLane('lane-a', {
      awaitingReview: true,
      activeReviewId: 'review-context-race',
      reviewWorkerTurnId: 2,
      workerTurnId: 2,
      ordinaryContextHealth: {
        fingerprint: 'forgotten-plan', symptoms: ['forgotten-plan'],
        signal: '首次遗忘规划', evidenceFingerprint: 'no-new-evidence', occurrences: 1,
        reviewId: 'review-context-1', workerTurnId: 1, updatedAt: 1,
      },
    });
    let acceptClearBody: ((accepted: boolean) => void) | undefined;
    const writeReliable = vi.fn((_surfaceId: string, data: string) => {
      if (data === '/new') {
        return new Promise<boolean>((resolve) => { acceptClearBody = resolve; });
      }
      return Promise.resolve(true);
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    const decision = decide({
      reviewId: 'review-context-race', outcome: 'rework', next: '重新完成当前成果',
      contextHealth: 'degraded', contextSymptoms: 'forgotten-plan',
      contextSignal: '第二轮仍遗忘用户规划',
    });
    const currentLane = useStore.getState().supervisor.lanes[0];
    useStore.getState().updateLane('lane-a', {
      config: { ...currentLane.config!, planRevision: 2, taskGoal: '用户刚更新的新目标' },
    });
    acceptClearBody?.(true);
    await vi.runAllTimersAsync();

    await expect(decision).resolves.toMatchObject({
      ok: false,
      contextResetFailed: true,
      error: expect.stringContaining('用户规划版本已变化'),
    });
    expect(writeReliable).not.toHaveBeenCalledWith('worker-a', '\r');
    expect(writeReliable.mock.calls.some(([, data]) => String(data).includes('[上下文已清空'))).toBe(false);
  });

  it('escalates the same technical blocker only after a second review without new evidence', () => {
    const escalation = (reviewId?: string) => (globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a',
      ...(reviewId ? { reviewId } : {}),
      outcome: 'needs-human', proposalKind: 'important',
      reason: '同一编译错误仍无法定位', impact: '当前成果无法通过验收',
      alternatives: '方案 A：调整诊断假设；方案 B：停止当前分支',
      next: '推荐方案 A：先调整诊断假设',
    });

    expect(escalation()).toMatchObject({ ok: false, error: expect.stringContaining('尚未达到升级条件') });
    expect(escalation()).toMatchObject({ ok: false, error: expect.stringContaining('尚未达到升级条件') });
    expect(useStore.getState().supervisor.lanes[0].ordinaryBlocker?.occurrences).toBe(1);

    useStore.getState().updateLane('lane-a', {
      awaitingReview: true,
      activeReviewId: 'review-second',
      reviewWorkerTurnId: 2,
      workerTurnId: 2,
    });
    expect(escalation('review-second')).toMatchObject({ ok: true, outcome: 'needs-human' });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
  });

  it('refuses to send a supervisor decision into a task terminal that fell back to PowerShell', () => {
    screenText = 'PS E:\\repo>';
    markTerminalRuntimeReady('worker-a');

    expect(decide({ next: '不得作为 PowerShell 命令执行的任务协议' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('PowerShell'),
    });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ awaitingReview: true });
    clearTerminalRuntimeStatus('worker-a');
  });

  it('accepts a new UserPromptSubmit hook as proof of a manual Agent relaunch', () => {
    markTerminalRuntimeExited('worker-a', '旧 Agent 已退出');
    expect(terminalRuntimeStatus('worker-a')?.state).toBe('exited');

    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: 'worker-a',
      event: 'UserPromptSubmit',
      task: '人工重新启动后的新任务',
    });

    expect(terminalRuntimeStatus('worker-a')?.state).toBe('ready');
    clearTerminalRuntimeStatus('worker-a');
  });

  it('rejects a missing or stale ordinary review id before accepting the matching decision', () => {
    useStore.getState().updateLane('lane-a', {
      activeReviewId: 'review-current',
      reviewWorkerTurnId: 3,
      reviewWatchdogState: 'pending',
    });

    expect(decide({ next: '运行相关单元测试' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('--review-id review-current'),
    });
    expect(decide({ reviewId: 'review-old', next: '运行相关单元测试' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('已过期'),
    });
    expect(decide({ reviewId: 'review-current', next: '运行相关单元测试' }))
      .toMatchObject({ ok: true, outcome: 'continue' });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: false,
      activeReviewId: undefined,
      reviewWatchdogState: undefined,
    });
  });

  it('keeps subsequent ordinary tasks free of control-plane role envelopes', () => {
    expect(decide({ next: '检查当前实现' })).toMatchObject({ ok: true, outcome: 'continue' });
    useStore.getState().updateLane('lane-a', { awaitingReview: true });

    expect(decide({ next: '运行相关单元测试' })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledTimes(2);
    expect(writes).toHaveBeenNthCalledWith(2, 'worker-a', ordinaryTaskDelivery('运行相关单元测试'));
    expect(String(writes.mock.calls[1][1])).not.toContain('任务事件｜控制层');
  });

  it('lets the project supervisor switch the unique task AI execution mode', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-task-mode' });
    useAcknowledgedTaskDelivery();
    const decision = await decide({
      next: '并行核对相互独立的证据并完成当前成果',
      taskWorkMode: 'multi-thread',
    });
    expect(decision?.error).toBeUndefined();
    expect(decision).toMatchObject({ ok: true, outcome: 'continue' });

    expect(writes.mock.calls.map(([, data]) => String(data)).join('\n')).toContain('[执行模式] 多线程');
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === 'lane-a')
      ?.config.taskWorkMode).toBe('multi-thread');
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.workItems[0]?.taskWorkMode)
      .toBe('multi-thread');
  });

  it('requires project AI to assess task complexity before creating an executable work item', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-complexity-gate' });
    attachProjectManagerSurface(project.id, 'manager-complexity-gate');
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    const template = current.workItems[0];
    useStore.getState().restoreProjectManager({
      ...current,
      subgoals: [{
        id: 'stage-complexity', goalId: current.activeGoalId!, title: '复杂度评估',
        outcome: '形成独立可验收成果', acceptance: ['成果完成'], dependencies: [],
        status: 'active', order: 1, createdAt: 1, updatedAt: 1,
      }],
    });
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    const workItem = {
      id: 'task-b',
      title: '第二个独立成果',
      subgoalId: 'stage-complexity',
      status: 'planned',
      dependencies: [],
      contract: {
        ...template.contract,
        authority: { ...template.contract.authority, continuousExecution: true },
      },
    };

    await expect(request({
      action: 'task-create',
      callerSurfaceId: current.managerSurfaceId,
      projectId: current.id,
      workItem,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('complexityAssessment'),
    });
    await expect(request({
      action: 'task-create',
      callerSurfaceId: current.managerSurfaceId,
      projectId: current.id,
      workItem: {
        ...workItem,
        taskWorkMode: 'single-thread',
        complexityAssessment: {
          complexity: 'high',
          decision: 'split-before-dispatch',
          signals: ['包含多个独立成果'],
          rationale: '应先拆成多个工作项',
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('先拆分'),
    });
    const acceptedCreation = await request({
      action: 'task-create',
      callerSurfaceId: current.managerSurfaceId,
      projectId: current.id,
      workItem: {
        ...workItem,
        taskWorkMode: 'single-thread',
        complexityAssessment: {
          complexity: 'low',
          decision: 'single-task',
          signals: ['只有一个可独立验收成果'],
          rationale: '一个任务 AI 可以保持单一主线完成',
        },
      },
    });
    expect(acceptedCreation).toMatchObject({ ok: true });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === current.id)
      ?.workItems.find((candidate) => candidate.id === 'task-b')?.complexityAssessment)
      .toMatchObject({ decision: 'single-task', complexity: 'low' });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === current.id)
      ?.workItems.find((candidate) => candidate.id === 'task-b')?.taskWorkMode)
      .toBe('single-thread');
  });

  it('clears polluted task context in place once and escalates a repeated reset', async () => {
    vi.useFakeTimers();
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-context-reset' });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-context-reset' as any,
      title: '上下文原地清空测试',
      cwd: project.projectDir,
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf' as const,
        paneId: 'pane-context-reset' as any,
        activeSurfaceIndex: 0,
        surfaces: [{
          id: 'worker-a' as any,
          type: 'terminal' as const,
          shell: 'pwsh.exe',
          projectManagerProjectId: project.id,
          projectManagerWorkItemId: 'task-a',
        }],
      },
    }]);
    surfaceTerminalRegistry.set('worker-a', {
      buffer: {
        active: {
          type: 'normal', baseY: 0, cursorX: 0, cursorY: 1, length: 2,
          getLine: (index: number) => ({
            translateToString: (_trimRight?: boolean, startColumn?: number, endColumn?: number) => {
              const text = index === 0 ? 'OpenAI Codex' : '› Ask Codex to do anything';
              return typeof endColumn === 'number'
                ? text.slice(startColumn || 0, endColumn)
                : text;
            },
          }),
        },
      },
    } as any);
    markTerminalRuntimeReady('worker-a');
    agentState = { ...agentState, state: 'idle', runDepth: 0, updatedAt: Date.now() };
    const pendingBodies = new Map<string, string>();
    const submittedBodies: string[] = [];
    (globalThis.window as any).wmux.pty.writeReliable = vi.fn(async (surfaceId: string, data: string) => {
      if (data !== '\r') {
        pendingBodies.set(surfaceId, data);
        if (surfaceId === 'worker-a') submittedBodies.push(data);
      } else if (surfaceId === 'worker-a') {
        const body = pendingBodies.get(surfaceId) || '';
        if (body === '/new') {
          agentState = { ...agentState, state: 'idle', runDepth: 0, updatedAt: agentState.updatedAt + 1 };
        } else {
          agentState = { ...agentState, state: 'working', updatedAt: agentState.updatedAt + 1 };
          acknowledgeTaskPrompt(surfaceId);
        }
      }
      return true;
    });
    const originalSurfaceId = useStore.getState().supervisor.lanes[0].surfaceId;

    const resetPromise = Promise.resolve(decide({
      outcome: 'rework',
      proposalKind: 'context-recovery',
      reason: '任务 AI 连续两轮忘记项目产物目录规范',
      evidence: '两次检查点都把运行结果写入 .project-plans 根目录',
      contextSummary: '目标文件尚未完成；保留已有源码修改，下一步按项目规范修复产物落位并运行相关验证。',
    }));
    await vi.runAllTimersAsync();
    const resetResult = await resetPromise;
    expect(resetResult, JSON.stringify(resetResult)).toMatchObject({
      ok: true,
      contextReset: true,
      surfaceId: originalSurfaceId,
      generation: 2,
    });
    const submittedPrompts = submittedBodies.filter((text) => text !== '\x1b' && text !== '\x03');
    expect(submittedPrompts).toEqual([
      '/new',
      expect.stringContaining('[成果任务]'),
    ]);
    expect(submittedPrompts[1]).toContain('读取并严格遵循当前目录层级适用的 AGENTS');
    expect(submittedPrompts[1]).not.toMatch(/项目 ID|工作项 ID|监督 AI|lane/iu);
    expect(useStore.getState().supervisor.lanes[0].surfaceId).toBe(originalSurfaceId);
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.workItems[0].contextReset).toMatchObject({ count: 1, status: 'republished', generation: 2 });
    useStore.getState().updateLane('lane-a', { pendingSupervisorDeliveries: [], awaitingReview: true });

    expect(await decide({
      outcome: 'rework',
      proposalKind: 'context-recovery',
      reason: '清空后再次持续偏离当前成果',
      evidence: '新上下文再次处理其他工作项且没有新增证据',
      contextSummary: '当前成果仍未完成，需要项目 AI 缩小或拆分工作项。',
    })).toMatchObject({
      ok: true,
      projectDecisionRequired: true,
      contextResetBlocked: true,
    });
    expect(submittedPrompts.filter((text) => text === '/new')).toHaveLength(1);
    vi.useRealTimers();
  });

  it('rejects context reset without pollution evidence and a clean context packet', () => {
    bindProjectLaneToWorkItem({ projectId: 'pm-context-reset-evidence' });
    expect(decide({
      outcome: 'rework',
      proposalKind: 'context-recovery',
      reason: '上下文可能有问题',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('--reason、--evidence 和 --context-summary'),
    });
  });

  it('fails closed when a project lane cannot prove its exact project and work-item binding', () => {
    useStore.getState().updateLane('lane-a', {
      projectManagerProjectId: 'missing-project',
      projectWorkItemId: 'missing-task',
      autonomousOverride: true,
    });

    expect(decide({ next: '不得回退到当前选中的其他项目' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('绑定不完整'),
    });
    expect(useStore.getState().supervisor.lanes[0].controlState).toBe('paused');
    expect(writes).not.toHaveBeenCalled();
  });

  it('closes historical project AI surfaces that no active lane or work item owns', () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-orphan-runtime-cleanup' });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-orphan-runtime-cleanup' as any,
      title: '孤儿终端清理测试',
      cwd: project.projectDir,
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf' as const,
        paneId: 'pane-orphan-runtime-cleanup' as any,
        activeSurfaceIndex: 0,
        surfaces: [
          {
            id: 'worker-a' as any,
            type: 'terminal' as const,
            shell: 'pwsh.exe',
            projectManagerProjectId: project.id,
            projectManagerWorkItemId: 'task-a',
          },
          {
            id: 'supervisor-a' as any,
            type: 'terminal' as const,
            shell: 'pi',
            transientSupervisor: true,
            projectSupervisorProjectId: project.id,
          },
          {
            id: 'worker-old-budget' as any,
            type: 'terminal' as const,
            shell: 'pwsh.exe',
            projectManagerProjectId: project.id,
            projectManagerWorkItemId: 'task-a-budget-old',
          },
          {
            id: 'supervisor-old-budget' as any,
            type: 'terminal' as const,
            shell: 'pi',
            transientSupervisor: true,
            projectSupervisorProjectId: project.id,
          },
        ],
      },
    }]);

    markTerminalRuntimeExited('worker-old-budget', '历史任务终端已经退出');
    markTerminalRuntimeExited('supervisor-old-budget', '历史监督终端已经退出');

    expect(cleanupOrphanedProjectRuntimeSurfaces(project.id).sort()).toEqual([
      'supervisor-old-budget',
      'worker-old-budget',
    ]);
    const retained = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces.map((surface) => surface.id) : []
    ));
    expect(retained).toEqual(['worker-a', 'supervisor-a']);
  });

  it('does not clean project terminals while a persisted active lane is still restoring', () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-runtime-cleanup-restore-guard' });
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    useStore.getState().restoreProjectManager({
      ...current,
      workItems: current.workItems.map((item) => ({
        ...item,
        supervisorLaneId: 'lane-still-restoring',
      })),
    });
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-runtime-cleanup-restore-guard' as any,
      title: '恢复门禁测试',
      cwd: project.projectDir,
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf' as const,
        paneId: 'pane-runtime-cleanup-restore-guard' as any,
        activeSurfaceIndex: 0,
        surfaces: [{
          id: 'supervisor-still-restoring' as any,
          type: 'terminal' as const,
          shell: 'pi',
          transientSupervisor: true,
          projectSupervisorProjectId: project.id,
        }],
      },
    }]);

    expect(cleanupOrphanedProjectRuntimeSurfaces(project.id)).toEqual([]);
    expect(useStore.getState().workspaces[0].splitTree.type === 'leaf'
      ? useStore.getState().workspaces[0].splitTree.surfaces.map((surface) => surface.id)
      : []).toEqual(['supervisor-still-restoring']);
  });

  it('detects a project AI weekly quota failure and recovers with a project-specific Agent selection', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-manager-quota-switch' });
    useStore.getState().setProjectSupervisorLanes([]);
    const managerSurfaceId = 'project-manager-quota-switch';
    attachProjectManagerSurface(project.id, managerSurfaceId);
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [managerSurfaceId]: { state: 'working', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() },
    });
    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: managerSurfaceId, event: 'UserPromptSubmit', task: '继续管理当前项目',
    });
    (globalThis.window as any).__wmux_noteManagedAgentOutput(
      managerSurfaceId,
      'Weekly limit left: 0% · Grok 4.5 (medium)',
    );

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)).toMatchObject({
      agentIssue: { role: 'manager', category: 'quota-limit', surfaceId: managerSurfaceId },
    }));
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.events)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'project-agent-limit-detected' }),
      ]));

    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'configure-agents', projectId: project.id,
      agentConfig: {
        ...DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
        manager: { agent: 'grok', model: 'grok-4.6', reasoningEffort: 'high' },
      },
    })).resolves.toMatchObject({ ok: true, pendingRoles: [] });
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(current).toMatchObject({
      agentConfig: { manager: { agent: 'grok', model: 'grok-4.6', reasoningEffort: 'high' } },
      agentIssue: undefined,
      agentReconfiguration: undefined,
    });
    const replacement = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.id === current?.managerSurfaceId);
    expect(replacement).toMatchObject({ projectManagerAgent: 'grok', projectManagerModel: 'grok-4.6' });
  });

  it('queues a task Agent configuration change until the working task reaches Stop', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-task-config-safe-point' });
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      'worker-a': { state: 'working', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() },
    });
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    const workerBefore = useStore.getState().projectManager?.workItems[0].workerSurfaceId;

    await expect(remote({
      action: 'configure-agents', projectId: project.id,
      agentConfig: {
        ...DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
        task: { agent: 'kimi', model: 'kimi-code/k3', reasoningEffort: '' },
      },
    })).resolves.toMatchObject({ ok: true, pendingRoles: ['task'] });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)).toMatchObject({
      agentConfig: { task: { agent: 'kimi', model: 'kimi-code/k3' } },
      agentReconfiguration: {
        status: 'pending-safe-point', pendingRoles: ['task'], completedRoles: [],
      },
    });
    expect(useStore.getState().projectManager?.workItems[0].workerSurfaceId).toBe(workerBefore);
  });

  it('keeps runtime configuration isolated to the selected project', async () => {
    const first = useStore.getState().startProjectManager({
      projectDir: 'E:\\agent-config-a', goal: '项目 A', preconditions: ['无额外物理前置条件'], doneWhen: ['A 完成'],
      agentConfig: DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
    });
    const second = useStore.getState().startProjectManager({
      projectDir: 'E:\\agent-config-b', goal: '项目 B', preconditions: ['无额外物理前置条件'], doneWhen: ['B 完成'],
      agentConfig: DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
    });
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'configure-agents', projectId: first.id,
      agentConfig: {
        ...DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
        task: { agent: 'grok', model: 'grok-4.6', reasoningEffort: 'medium' },
      },
    })).resolves.toMatchObject({ ok: true });

    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === first.id)?.agentConfig)
      .toMatchObject({ task: { agent: 'grok', model: 'grok-4.6' } });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === second.id)?.agentConfig)
      .toEqual(DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG);
  });

  it('matches permission evidence only in the active prompt tail', () => {
    const staleEvidence = [
      'Permission required: npm test -- auth',
      ...Array.from({ length: 9 }, (_, index) => `ordinary output ${index}`),
    ].join('\n');
    expect(permissionCommandMatchesEvidence('npm test -- auth', staleEvidence)).toBe(false);
    expect(permissionCommandMatchesEvidence(
      'npm test -- auth',
      'ordinary output\nPermission required: npm test -- auth [y/n]',
    )).toBe(true);
  });

  it('waits for a long next step and Enter, then confirms task-terminal activity', async () => {
    vi.useFakeTimers();
    const next = '继续检查当前实现并分段运行相关测试。'.repeat(120);
    const writeReliable = vi.fn(async (surfaceId: string, data: string) => {
      writes(surfaceId, data);
      if (data === '\r') {
        globalThis.setTimeout(() => {
          agentState = { ...agentState, state: 'working', updatedAt: 2 };
          acknowledgeTaskPrompt(surfaceId);
        }, 5_000);
      }
      else screenText = data;
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    const result = decide({ next });
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(result).resolves.toMatchObject({
      ok: true,
      outcome: 'continue',
      delivery: { confirmed: true, agentState: 'working', acknowledgement: 'UserPromptSubmit' },
    });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', ordinaryTaskDelivery(next)],
      ['worker-a', '\r'],
    ]);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: false,
      currentTask: next,
    });
  });

  it('flattens a multi-line next step even when the terminal reports bracketed paste', async () => {
    (surfaceTerminalRegistry.get('worker-a') as any).modes = { bracketedPasteMode: true };
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') {
        agentState = { ...agentState, state: 'working', updatedAt: 2 };
        acknowledgeTaskPrompt();
      }
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({ next: '先检查实现\n再运行测试' })).resolves.toMatchObject({ ok: true });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', ordinaryTaskDelivery('先检查实现\n再运行测试')],
      ['worker-a', '\r'],
    ]);
  });

  it('flattens a multi-line next step when bracketed paste is unavailable', async () => {
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') {
        agentState = { ...agentState, state: 'working', updatedAt: 2 };
        acknowledgeTaskPrompt();
      }
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({ next: '先检查实现\n再运行测试' })).resolves.toMatchObject({ ok: true });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', ordinaryTaskDelivery('先检查实现\n再运行测试')],
      ['worker-a', '\r'],
    ]);
  });

  it('keeps review open when PTY accepts input but terminal state and screen do not change', async () => {
    vi.useFakeTimers();
    const writeReliable = vi.fn(async () => true);
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    const result = decide({ next: '运行相关单元测试' });
    await vi.advanceTimersByTimeAsync(15_001);
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('agent-state'),
      delivery: { confirmed: false, agentState: 'idle', screenChanged: false },
    });
    expect(writeReliable).toHaveBeenCalledWith('worker-a', ordinaryTaskDelivery('运行相关单元测试'));
    expect(writeReliable).toHaveBeenCalledWith('worker-a', '\r');
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      autoDecisionsUsed: 0,
      decisions: [],
    });
  });

  it('does not treat an unrelated screen repaint as delivery confirmation', async () => {
    vi.useFakeTimers();
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') screenText = '后台日志刷新，但任务状态未变化';
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    const result = decide({ next: '运行相关单元测试' });
    await vi.advanceTimersByTimeAsync(15_001);
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('仅检测到屏幕变化'),
      delivery: { confirmed: false, agentState: 'idle', screenChanged: true },
    });
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(true);
  });

  it('serializes decisions while one delivery is still in flight', async () => {
    let acceptBody: ((accepted: boolean) => void) | undefined;
    const writeReliable = vi.fn((_surfaceId: string, data: string) => {
      if (data === ordinaryTaskDelivery('第一条裁决')) {
        return new Promise<boolean>((resolve) => { acceptBody = resolve; });
      }
      if (data === '\r') {
        agentState = { ...agentState, state: 'working', updatedAt: 2 };
        acknowledgeTaskPrompt();
      }
      return Promise.resolve(true);
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    const first = decide({ next: '第一条裁决' });
    expect(decide({ next: '并发的第二条裁决' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('已有裁决正在投递'),
    });
    acceptBody?.(true);
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', ordinaryTaskDelivery('第一条裁决')],
      ['worker-a', '\r'],
    ]);
  });

  it('records that a decision needs human review when the automatic limit is reached', () => {
    const appendRecord = vi.fn(async () => undefined);
    (globalThis.window as any).wmux.supervisor = { appendRecord };
    useStore.getState().patchSupervisor({ maxAutoDecisions: 1 });

    expect(decide({ next: '运行相关单元测试' })).toMatchObject({
      ok: true,
      outcome: 'continue',
      requiresHuman: true,
    });
    expect(writes).not.toHaveBeenCalled();
    expect(appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'supervisor.decision',
      payload: expect.objectContaining({ requiresHuman: true }),
    }));
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      surfaceId: 'supervisor-a',
      title: 'AI 监督',
    }));
  });

  it('activates a waiting project contract as soon as the submitted task prompt is acknowledged', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-task-prompt-contract-race' });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'task-a', patch: {
        status: 'waiting-decision', latestBlocker: '等待监督任务投递确认',
      },
    }, project.id);
    useStore.getState().updateLane('lane-a', {
      projectTaskContractPending: true,
      awaitingReview: true,
    });
    let statusAtAcknowledgement = '';
    let contractPendingAtAcknowledgement = true;
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') {
        agentState = { ...agentState, state: 'working', updatedAt: 2 };
        acknowledgeTaskPrompt();
        statusAtAcknowledgement = useStore.getState().projectManagers
          .find((candidate) => candidate.id === project.id)?.workItems[0].status || '';
        contractPendingAtAcknowledgement = useStore.getState().supervisor.lanes[0]
          .projectTaskContractPending === true;
      }
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    const decision = decide({ next: '执行已批准的合同内批次' });
    const decisionResult = await decision;
    expect(decisionResult?.error).toBeUndefined();
    expect(decisionResult).toMatchObject({ ok: true });
    expect(statusAtAcknowledgement).toBe('running');
    expect(contractPendingAtAcknowledgement).toBe(false);
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0])
      .toMatchObject({ status: 'running', latestBlocker: undefined });
  });

  it('routes project-managed escalations as project notifications without legacy approvals', () => {
    const project = bindProjectLaneToWorkItem();

    expect(decide({
      outcome: 'needs-human', proposalKind: 'important',
      reason: '尝试使用未分类升级', impact: '不应通过',
    })).toMatchObject({ ok: false, error: expect.stringContaining('--escalation-boundary') });

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      escalationBoundary: 'contract-change',
      next: '需要项目管理 AI 调整任务合同后选择下一条技术路线',
      reason: '现有两条路线都需要修改任务合同范围',
      impact: '监督 AI 无权扩大任务合同的文件范围',
    })).toMatchObject({ ok: true, outcome: 'needs-human', projectNotification: true });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    const transition = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingSupervisorTransitions?.[0];
    expect(transition).toMatchObject({
      kind: 'project-action-required', eventType: 'supervisor.project-contract-review',
    });
    const delivery = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingManagerDeliveries?.find((candidate) => candidate.transitionId === transition?.id)?.text;
    expect(delivery).toContain('项目 AI 必须根据总计划、工作项和证据直接决策');
    expect(delivery).not.toContain('--approval');
    expect(delivery).not.toContain('待决 ID');
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ awaitingReview: false });
    expect((globalThis.window as any).wmux.notification.fire).not.toHaveBeenCalled();
  });

  it('routes a project supervisor runtime question to project AI when the work-item binding drifted', () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-binding-drift' });
    useStore.getState().updateLane('lane-a', { projectWorkItemId: undefined });

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'clarification',
      escalationBoundary: 'external-blocker',
      reason: 'Hook 状态 unknown，监督无法确认任务 Agent 是否仍可用',
      impact: '暂时不能核对任务成果',
      alternatives: '由项目 AI 读取任务终端屏幕并恢复绑定',
    })).toMatchObject({
      ok: true,
      outcome: 'needs-human',
      projectNotification: true,
    });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingSupervisorTransitions?.[0]).toMatchObject({
      kind: 'project-action-required',
      eventType: 'supervisor.project-binding-recovery',
    });
  });

  it('escalates a project task terminal draft directly to a persistent user intervention', () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-task-input-draft' });
    screenText = '│ > 用户尚未提交的任务草稿';
    const terminal = surfaceTerminalRegistry.get('worker-a') as any;
    terminal.buffer.active.cursorX = screenText.length;

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      escalationBoundary: 'external-blocker',
      reason: 'R3/A2 baseline.required，但任务终端存在未提交用户草稿，不能安全接收项目指令。',
      impact: '当前任务需要项目 AI 调整成果或依赖',
    })).toMatchObject({
      ok: true,
      outcome: 'needs-human',
      userInterventionRequired: true,
      question: {
        category: 'manual-intervention',
        workItemId: 'task-a',
        reasonCode: 'internal-project-failure',
        recommendedOptionId: 'draft-handled',
      },
    });

    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(current).toMatchObject({
      status: 'waiting',
      pendingUserQuestion: {
        question: expect.stringContaining('未提交内容'),
        blocker: expect.stringContaining('不能覆盖'),
      },
      workItems: [expect.objectContaining({ status: 'waiting-decision' })],
      pendingSupervisorTransitions: [],
    });
    expect(useStore.getState().supervisor.pendingApprovals).toEqual([]);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ controlState: 'paused' });
    expect(writes).not.toHaveBeenCalled();
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: '项目需要你的处理',
      text: expect.stringContaining('未提交内容'),
    }));
  });

  it('immediately reclassifies a persisted task-input transition instead of waiting for redelivery', async () => {
    vi.useFakeTimers();
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-persisted-task-input-draft' });
    screenText = '│ > 恢复前遗留的未提交任务草稿';
    const terminal = surfaceTerminalRegistry.get('worker-a') as any;
    terminal.buffer.active.cursorX = screenText.length;
    const restored = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    useStore.getState().restoreProjectManager({
      ...restored,
      workItems: restored.workItems.map((item) => ({ ...item, status: 'waiting-decision' as const })),
      pendingSupervisorTransitions: [{
        id: 'persisted-task-input-transition',
        laneId: 'lane-a',
        workItemId: 'task-a',
        kind: 'decision-required',
        eventType: 'supervisor.approval.requested',
        summary: '任务终端输入框仍有未提交用户草稿，不能安全接收或追加项目指令。',
        createdAt: 1,
        notifiedAt: 1,
        notificationCount: 1,
      }],
    });

    initPipeBridge();
    await vi.advanceTimersByTimeAsync(1);

    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(current).toMatchObject({
      status: 'waiting',
      pendingUserQuestion: { recommendedOptionId: 'draft-handled' },
      pendingSupervisorTransitions: [],
      pendingManagerDeliveries: [],
    });
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: '项目需要你的处理',
    }));
  });

  it('keeps the normal transition reminder when the previously reported task draft is already cleared', async () => {
    vi.useFakeTimers();
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-cleared-task-input-draft' });
    screenText = '│ > ';
    const terminal = surfaceTerminalRegistry.get('worker-a') as any;
    terminal.buffer.active.cursorX = screenText.length;
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({
      action: 'event',
      projectId: project.id,
      workItemId: 'task-a',
      eventType: 'supervisor.approval.requested',
      summary: '任务终端输入框曾有未提交用户草稿，等待项目 AI 重新裁决。',
      payload: { laneId: 'lane-a' },
    })).resolves.toMatchObject({ ok: true, transitionId: expect.any(String) });
    await vi.advanceTimersByTimeAsync(1);

    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(current).toMatchObject({
      status: 'active',
      pendingSupervisorTransitions: [expect.objectContaining({ notificationCount: 1 })],
    });
    expect(current?.pendingUserQuestion).toBeUndefined();
    expect((globalThis.window as any).wmux.notification.fire).not.toHaveBeenCalledWith(expect.objectContaining({
      title: '项目需要你的处理',
    }));
  });

  it('repairs a persisted completion-verifier routing conflict and resumes the same supervisor closeout', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-completion-routing-recovery' });
    const store = useStore.getState();
    const current = store.projectManagers.find((candidate) => candidate.id === project.id)!;
    store.restoreProjectManager({
      ...current,
      workItems: current.workItems.map((item) => ({
        ...item,
        status: 'paused' as const,
        latestBlocker: '缺少 supervisor.completion.verify capability；连续 2 轮没有产生新的代码、测试或错误证据',
      })),
      pendingSupervisorTransitions: [
        {
          id: 'completion-capability-transition',
          laneId: 'lane-a',
          workItemId: 'task-a',
          kind: 'decision-required',
          eventType: 'supervisor.approval.requested',
          summary: 'complete refused: project-supervisor lacks supervisor.completion.verify',
          createdAt: 10,
          notifiedAt: 10,
          notificationCount: 1,
        },
        {
          id: 'completion-no-progress-transition',
          laneId: 'lane-a',
          workItemId: 'task-a',
          kind: 'project-action-required',
          eventType: 'supervisor.execution-guard',
          summary: '连续 2 轮没有产生新的代码、测试或错误证据',
          createdAt: 11,
          notifiedAt: 11,
          notificationCount: 1,
        },
      ],
      pendingManagerDeliveries: [
        {
          id: 'stale-completion-delivery',
          text: '请项目 AI 批准 completion verifier capability',
          createdAt: 10,
          transitionId: 'completion-capability-transition',
          stage: 'pending',
        },
        {
          id: 'stale-no-progress-delivery',
          text: '完成收口没有产生新代码',
          createdAt: 11,
          transitionId: 'completion-no-progress-transition',
          stage: 'pending',
        },
      ],
    });
    store.pauseSupervisorLane('lane-a', '旧 capability 路由错误导致完成链暂停');
    store.updateLane('lane-a', {
      pendingSupervisorDeliveries: [{
        id: 'stale-owner-decision',
        kind: 'owner-decision',
        task: '完成核验',
        text: '等待项目 AI 批准 completion verifier capability',
        createdAt: 12,
        stage: 'pending',
      }],
    });
    store.enqueueApproval({
      laneId: 'lane-a',
      surfaceId: 'worker-a' as any,
      laneLabel: 'worker',
      source: 'supervisor-important',
      proposalKind: 'important',
      text: '请求项目 AI 批准 supervisor.completion.verify',
      reason: '旧 capability 路由拒绝',
      impact: '完成收口停滞',
    });

    initPipeBridge();

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)).toMatchObject({
      status: 'active',
      workItems: [expect.objectContaining({ id: 'task-a', status: 'running' })],
      pendingSupervisorTransitions: [],
    }));
    const repaired = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(repaired?.workItems[0].latestBlocker).toBeUndefined();
    expect(repaired?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'work-item-updated',
        payload: expect.objectContaining({ reason: 'supervisor-completion-verifier-capability-recovered' }),
      }),
    ]));
    expect(repaired?.pendingManagerDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('控制层已恢复完成核验链') }),
    ]));
    expect(useStore.getState().supervisor.pendingApprovals).toEqual([]);
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a')).toMatchObject({
      controlState: 'active',
      awaitingReview: true,
    });
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a')
      ?.pendingSupervisorDeliveries?.some((delivery) => delivery.kind === 'owner-decision')).toBe(false);
    expect(queuedControlText()).toContain('supervisor.completion.verify');
    expect(queuedControlText()).toContain('省略 --changed-files');
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
  });

  it('allows one safe proactive follow-up from a project supervisor without a pending review round', async () => {
    bindProjectLaneToWorkItem();
    useAcknowledgedTaskDelivery();
    useStore.getState().updateLane('lane-a', {
      autonomousOverride: true,
      autonomyPermissionsOverride: ['same-route-next'],
      awaitingReview: false,
    });

    expect(await decide({ next: '执行终审补证并输出可复核证据' })).toMatchObject({
      ok: true,
      outcome: 'continue',
    });
    expect(writes).toHaveBeenCalledWith(
      'worker-a',
      expect.stringContaining('执行终审补证并输出可复核证据'),
    );
    expect(String(writes.mock.calls[0]?.[1] || '')).not.toMatch(/项目 ID|工作项 ID|监督 AI|lane/iu);

    expect(decide({ next: '执行终审补证并输出可复核证据' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('上一条裁决完全相同'),
    });

    agentState = { ...agentState, state: 'working', updatedAt: 2 };
    expect(decide({ next: '根据新增证据完成另一项聚焦检查' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('仍在运行'),
    });
  });('keeps ordinary supervision closed when there is no pending review round', () => {
    useStore.getState().updateLane('lane-a', { awaitingReview: false });

    expect(decide({ next: '普通监督尝试主动补证' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('当前没有待裁决轮次'),
    });
  });

  it('atomically releases the project task binding when the project work item is closed', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-stop-binding' });
    const managerSurfaceId = 'project-manager-stop-binding';
    attachProjectManagerSurface(project.id, managerSurfaceId);
    useStore.getState().restoreProjectManager({
      ...useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!,
      taskTerminalSurfaceId: 'worker-a',
    });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      escalationBoundary: 'contract-change',
      next: '停止旧执行链并重新派发后继任务',
      reason: '旧执行链已经不再适用',
      impact: '继续使用旧终端会违反当前任务身份',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    const stopped = await remote({
      action: 'intervene-work-item',
      projectId: project.id,
      workItemId: 'task-a',
      intervention: 'close',
      reason: '旧执行链已经不再适用',
    });
    expect(stopped, JSON.stringify(stopped)).toMatchObject({
      ok: true,
      message: expect.stringContaining('已关闭'),
    });

    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id))
      .toMatchObject({
        taskTerminalSurfaceId: 'worker-a',
        workItems: [expect.objectContaining({
          id: 'task-a',
          status: 'stopped',
          workerSurfaceId: undefined,
          supervisorLaneId: undefined,
        })],
      });
  });

  it('repairs a missing stopped terminal before accepting the reset-binding user choice', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-reset-stale-binding' });
    const oldItem = project.workItems[0];
    useStore.getState().restoreProjectManager({
      ...project,
      status: 'waiting',
      taskTerminalSurfaceId: 'stale-worker',
      workItems: [
        {
          ...oldItem,
          status: 'stopped',
          workerSurfaceId: 'stale-worker',
          supervisorLaneId: 'stale-lane',
        },
        {
          ...oldItem,
          id: 'next-task',
          title: '后继任务',
          status: 'waiting-decision',
          workerSurfaceId: undefined,
          supervisorLaneId: 'next-lane',
        },
      ],
      pendingUserQuestion: {
        id: 'reset-stale-binding-question',
        category: 'manual-intervention',
        workItemId: 'next-task',
        blocker: '旧任务终端已经关闭，但项目仍保留唯一终端绑定',
        reasonCode: 'internal-project-failure',
        question: '是否重置旧任务终端绑定？',
        context: '新监督无法创建自己的任务终端。',
        options: [
          { id: 'reset_terminal_binding', label: '重置终端绑定' },
          { id: 'keep_paused', label: '保持暂停' },
        ],
        recommendedOptionId: 'reset_terminal_binding',
        previousStatus: 'active',
        createdAt: Date.now(),
      },
    });
    useStore.getState().setProjectSupervisorLanes([]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({
      action: 'answer-question',
      projectId: project.id,
      questionId: 'reset-stale-binding-question',
      optionId: 'reset_terminal_binding',
      source: 'desktop',
    })).resolves.toMatchObject({ ok: true });

    const repaired = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(repaired).toMatchObject({
      taskTerminalSurfaceId: undefined,
      pendingUserQuestion: undefined,
      workItems: [
        expect.objectContaining({
          id: 'task-a',
          workerSurfaceId: undefined,
          supervisorLaneId: undefined,
        }),
        expect.objectContaining({ id: 'next-task', supervisorLaneId: 'next-lane' }),
      ],
    });
    expect(repaired?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'supervisor-status',
        payload: expect.objectContaining({ action: 'repair-stale-task-binding' }),
      }),
    ]));
  });

  it('refuses to reset a binding while its project task terminal is still live', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-live-binding' });
    useStore.getState().restoreProjectManager({
      ...project,
      status: 'waiting',
      taskTerminalSurfaceId: 'live-project-worker',
      workItems: project.workItems.map((item) => ({
        ...item,
        status: 'waiting-decision' as const,
        workerSurfaceId: 'live-project-worker',
      })),
      pendingUserQuestion: {
        id: 'reset-live-binding-question',
        category: 'manual-intervention',
        workItemId: 'task-a',
        blocker: '项目仍记录任务终端绑定',
        reasonCode: 'internal-project-failure',
        question: '是否重置任务终端绑定？',
        context: '该测试终端实际仍存在。',
        options: [
          { id: 'reset_terminal_binding', label: '重置终端绑定' },
          { id: 'keep_paused', label: '保持暂停' },
        ],
        recommendedOptionId: 'keep_paused',
        previousStatus: 'active',
        createdAt: Date.now(),
      },
    });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-live-project-worker' as any,
      title: '存活任务终端',
      cwd: project.projectDir,
      splitTree: {
        type: 'leaf',
        paneId: 'pane-live-project-worker' as any,
        activeSurfaceIndex: 0,
        surfaces: [{
          id: 'live-project-worker' as any,
          type: 'terminal',
          shell: 'pwsh.exe',
          projectManagerProjectId: project.id,
          projectManagerWorkItemId: 'task-a',
        }],
      },
    }]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({
      action: 'answer-question',
      projectId: project.id,
      questionId: 'reset-live-binding-question',
      optionId: 'reset_terminal_binding',
      source: 'desktop',
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('不能强制重置'),
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id))
      .toMatchObject({
        taskTerminalSurfaceId: 'live-project-worker',
        pendingUserQuestion: { id: 'reset-live-binding-question' },
        workItems: [expect.objectContaining({ workerSurfaceId: 'live-project-worker' })],
      });
  });

  it('gives the project AI an actionable notification when a supervisor has no recommendation', () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-empty-supervisor-recommendation' });

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      escalationBoundary: 'contract-change',
      reason: '结构化证据冲突，无法确认当前不可变身份是否已经消费',
      impact: '继续旧路线可能重复执行已经消费的身份',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });

    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    const transition = current?.pendingSupervisorTransitions?.find((candidate) => (
      candidate.kind === 'project-action-required'
    ));
    expect(transition?.summary).toContain('结构化证据冲突');
    expect(transition?.summary).toContain('继续旧路线可能重复执行');
    expect(current?.pendingManagerDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        transitionId: transition?.id,
        text: expect.stringContaining('必须在本回合留下真实且立即可执行的下一责任者'),
      }),
    ]));
    expect(current?.pendingManagerDeliveries?.find((delivery) => delivery.transitionId === transition?.id)?.text)
      .toContain('项目 AI 必须根据总计划、工作项和证据直接决策');
    expect(current?.pendingManagerDeliveries?.find((delivery) => delivery.transitionId === transition?.id)?.text)
      .not.toContain('--approval');
  });

  it('keeps one durable supervisor transition until the project AI records its resolution', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-transition-inbox' });
    const managerSurfaceId = 'project-manager-transition';
    useStore.getState().restoreProjectManager({ ...project, managerSurfaceId: managerSurfaceId as any });
    useStore.getState().replaceAllWorkspaces([
      {
        id: 'ws-transition-manager' as any,
        title: '项目 AI 控制台',
        cwd: project.projectDir,
        splitTree: {
          type: 'leaf' as const,
          paneId: 'pane-transition-manager' as any,
          activeSurfaceIndex: 0,
          surfaces: [{
            id: managerSurfaceId as any,
            type: 'terminal' as const,
            shell: 'pwsh.exe',
            projectManagerTerminal: true,
            projectManagerProjectId: project.id,
            projectManagerAgent: 'codex',
            projectManagerModel: '',
            projectManagerReasoningEffort: '',
          }],
        },
      },
      {
        id: 'ws-transition-execution' as any,
        title: '项目执行链',
        cwd: project.projectDir,
        transientSupervisorWorkspace: true,
        splitTree: {
          type: 'leaf' as const,
          paneId: 'pane-transition-execution' as any,
          activeSurfaceIndex: 0,
          surfaces: [
            {
              id: 'worker-a' as any,
              type: 'terminal' as const,
              shell: 'pwsh.exe',
              projectManagerProjectId: project.id,
              projectManagerWorkItemId: 'task-a',
            },
            {
              id: 'supervisor-a' as any,
              type: 'terminal' as const,
              shell: 'pi',
              transientSupervisor: true,
              projectSupervisorProjectId: project.id,
            },
          ],
        },
      },
    ]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    const handoff = {
      action: 'event',
      projectId: project.id,
      laneId: 'lane-a',
      workItemId: 'task-a',
      eventType: 'supervisor.waiting-for-direction',
      summary: '阶段测试已经通过，监督进入待续',
      payload: {
        handoffKind: 'stage-complete',
        evidence: '定向测试 12/12 通过',
        contextSummary: '实现与验证已经完成，等待项目级验收',
      },
    };

    const first = await remote(handoff);
    await expect(remote(handoff)).resolves.toMatchObject({ ok: true, transitionId: first.transitionId });
    const pending = useStore.getState().projectManager?.pendingSupervisorTransitions || [];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: first.transitionId,
      laneId: 'lane-a',
      workItemId: 'task-a',
      kind: 'stage-complete',
      notificationCount: 1,
    });
    expect(useStore.getState().projectManager?.pendingManagerDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ transitionId: first.transitionId }),
    ]));
    const firstDelivery = useStore.getState().projectManager?.pendingManagerDeliveries
      ?.find((delivery) => delivery.transitionId === first.transitionId);
    expect(firstDelivery).toBeDefined();
    const revised = await remote({
      ...handoff,
      summary: '阶段测试已经通过，并补充最终 diff 证据',
      payload: { ...handoff.payload, evidence: '定向测试 12/12 通过；diff-check 通过' },
    });
    expect(revised.transitionId).toBe(first.transitionId);
    expect(useStore.getState().projectManager?.pendingSupervisorTransitions[0]).toMatchObject({
      id: first.transitionId,
      notificationCount: 1,
      evidence: '定向测试 12/12 通过；diff-check 通过',
    });
    expect(useStore.getState().projectManager?.pendingManagerDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: firstDelivery?.id,
        transitionId: first.transitionId,
        text: expect.stringContaining('定向测试 12/12 通过；diff-check 通过'),
      }),
    ]));

    const longSummary = `阶段摘要头。${'摘要细节。'.repeat(300)}阶段摘要尾。`;
    const longEvidence = `证据头。${'完整证据。'.repeat(300)}证据尾。`;
    const longContext = `上下文头。${'上下文细节。'.repeat(250)}上下文尾。`;
    await remote({
      ...handoff,
      summary: longSummary,
      payload: { ...handoff.payload, evidence: longEvidence, contextSummary: longContext },
    });
    const compactedTransition = useStore.getState().projectManager?.pendingSupervisorTransitions[0];
    const compactedDelivery = useStore.getState().projectManager?.pendingManagerDeliveries
      ?.find((delivery) => delivery.transitionId === first.transitionId);
    expect(compactedTransition).toMatchObject({
      evidence: longEvidence,
      contextSummary: longContext,
    });
    expect(compactedTransition?.summary).toContain(longSummary);
    expect(compactedDelivery?.text).toContain('内联已压缩');
    expect(compactedDelivery?.text).toContain('阶段摘要头');
    expect(compactedDelivery?.text).toContain('阶段摘要尾');
    expect(compactedDelivery?.text).toContain(`pendingSupervisorTransitions 中 ID=${first.transitionId}`);
    expect(compactedDelivery?.text).not.toContain(longEvidence);
    expect(compactedDelivery?.text.length).toBeLessThan(5_000);

    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'transition-ack', callerSurfaceId: managerSurfaceId, projectId: project.id,
      transitionId: first.transitionId, resolution: 'accepted',
      summary: '阶段证据充分，已验收并准备下一阶段目标',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('尚未进入完成状态') });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'task-a', patch: { status: 'completed' },
    }, project.id);
    await expect(request({
      action: 'transition-ack', callerSurfaceId: managerSurfaceId, projectId: project.id,
      transitionId: first.transitionId, resolution: 'accepted',
      summary: '阶段证据充分，工作项已完成并准备下一阶段目标',
    })).resolves.toMatchObject({ ok: true, resolution: 'accepted' });
    expect(useStore.getState().projectManager?.pendingSupervisorTransitions).toEqual([]);
    expect(useStore.getState().projectManager?.pendingManagerDeliveries
      ?.some((delivery) => delivery.transitionId === first.transitionId)).toBe(false);
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'supervisor-transition' }),
      expect.objectContaining({ kind: 'supervisor-transition-acknowledged' }),
    ]));

    const idle = await remote({
      action: 'event', projectId: project.id, laneId: 'lane-a', workItemId: 'task-a',
      eventType: 'supervisor.idle-unreported', summary: '监督回合结束但尚未写回状态',
    });
    const completed = await remote(handoff);
    expect(completed.transitionId).not.toBe(idle.transitionId);
    expect(useStore.getState().projectManager?.pendingSupervisorTransitions).toEqual([
      expect.objectContaining({ id: completed.transitionId, kind: 'stage-complete' }),
    ]);
    expect(useStore.getState().projectManager?.pendingManagerDeliveries
      ?.some((delivery) => delivery.transitionId === idle.transitionId)).toBe(false);

    const lateIdle = await remote({
      action: 'event', projectId: project.id, laneId: 'lane-a', workItemId: 'task-a',
      eventType: 'supervisor.idle-unreported', summary: '迟到的旧空闲事件',
    });
    expect(lateIdle.transitionId).toBe(completed.transitionId);
    expect(useStore.getState().projectManager?.pendingSupervisorTransitions).toHaveLength(1);
  });

  it('updates a waiting work item through the public action and unlocks a replanned transition', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-public-task-update' });
    const managerSurfaceId = 'project-manager-task-update';
    attachProjectManagerSurface(project.id, managerSurfaceId);
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    useStore.getState().restoreProjectManager({
      ...current,
      activeWorkItemId: 'task-a',
      workItems: current.workItems.map((item) => ({
        ...item,
        status: 'waiting-decision',
        supervisorLaneId: undefined,
        workerSurfaceId: undefined,
        latestBlocker: '旧监督路线没有产生新证据',
      })),
    });
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    const handoff = await remote({
      action: 'event', projectId: project.id, laneId: 'lane-a', workItemId: 'task-a',
      eventType: 'supervisor.waiting-for-direction', summary: '需要项目 AI 调整成果方向',
      payload: { handoffKind: 'project-action-required', evidence: '连续两轮无新证据' },
    });
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    await expect(request({
      action: 'task-update', callerSurfaceId: managerSurfaceId, projectId: project.id,
      workItemId: 'task-a', status: 'planned',
      objective: '形成现有证据覆盖判定并明确剩余缺口',
      latestContextSummary: '复用已有证据，不重复无变化验证',
      latestBlocker: '仅保留尚未验证的真实权限边界',
    })).resolves.toMatchObject({
      ok: true,
      workItem: expect.objectContaining({
        id: 'task-a', status: 'planned',
        contract: expect.objectContaining({ objective: '形成现有证据覆盖判定并明确剩余缺口' }),
      }),
    });
    const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    expect(updated.workItems[0].contract.stopWhen)
      .toEqual(expect.arrayContaining(project.workItems[0].contract.stopWhen));
    expect(updated.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'work-item-updated', workItemId: 'task-a' }),
    ]));
    await expect(request({
      action: 'transition-ack', callerSurfaceId: managerSurfaceId, projectId: project.id,
      transitionId: handoff.transitionId, resolution: 'replanned',
      summary: '已把成果收敛为证据覆盖判定，下一步重新派发专属监督',
    })).resolves.toMatchObject({ ok: true, resolution: 'replanned' });
  });

  it('allows only one delayed project supervisor transition reminder', () => {
    expect(projectSupervisorTransitionRedeliveryMs(1)).toBe(10 * 60_000);
    expect(projectSupervisorTransitionRedeliveryMs(2)).toBe(30 * 60_000);
    expect(projectSupervisorTransitionRedeliveryMs(3)).toBe(60 * 60_000);
    expect(projectSupervisorTransitionRedeliveryMs(4)).toBe(2 * 60 * 60_000);
    expect(projectSupervisorTransitionRedeliveryMs(20)).toBe(2 * 60 * 60_000);
    expect(projectSupervisorTransitionRedeliveryMs(Number.NaN)).toBe(10 * 60_000);
    expect(shouldScheduleProjectSupervisorTransitionReminder(1)).toBe(true);
    expect(shouldScheduleProjectSupervisorTransitionReminder(2)).toBe(false);
    expect(shouldScheduleProjectSupervisorTransitionReminder(20)).toBe(false);
  });

  it('continues a restored active project whose only execution chain was already paused', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-restored-deadlock' });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'task-a',
      patch: { status: 'paused', latestBlocker: '旧会话在协议纠错后没有留下恢复事件' },
    }, project.id);

    initPipeBridge();

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)).toMatchObject({
      status: 'active',
      pendingManagerDeliveries: [expect.objectContaining({
        text: expect.stringContaining('主目标仍有可内部消解的执行义务'),
      })],
    }));
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingUserQuestion).toBeUndefined();
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === 'lane-a'))
      .toMatchObject({ controlState: 'paused' });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.events)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        payload: expect.objectContaining({ reason: 'paused-work-item-active-lane-reconciled' }),
      })]));
  });

  it('does not treat an idle active lane as live execution and wakes the project AI first', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-idle-active-lane-recovery' });
    const managerSurfaceId = 'project-manager-idle-active-lane';
    attachProjectManagerSurface(project.id, managerSurfaceId);
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [managerSurfaceId]: {
        state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000,
      },
      'worker-a': {
        state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000,
      },
      'supervisor-a': {
        state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000,
      },
    });

    initPipeBridge();

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)).toMatchObject({
      status: 'active',
      pendingManagerDeliveries: [expect.objectContaining({
        text: expect.stringContaining('recover-work'),
      })],
    }));
    const recovered = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    expect(recovered.pendingUserQuestion).toBeUndefined();
    expect(recovered.workItems.find((item) => item.id === 'task-a')).toMatchObject({ status: 'running' });
    expect(recovered.events).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'guard-triggered',
      payload: expect.objectContaining({
        attentionRequired: false,
        action: 'project-active-obligation-continuation',
        obligation: 'recover-work',
      }),
    })]));
  });

  it('detects an all-agent idle project on the recurring control-plane watchdog without hook events', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-recurring-idle-watchdog' });
    const managerSurfaceId = 'project-manager-recurring-idle-watchdog';
    attachProjectManagerSurface(project.id, managerSurfaceId);
    let activityState: 'working' | 'idle' = 'working';
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [managerSurfaceId]: {
        state: activityState, blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000,
      },
      'worker-a': {
        state: activityState, blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000,
      },
      'supervisor-a': {
        state: activityState, blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000,
      },
    });

    initPipeBridge();
    await auditProjectLiveness();
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingManagerDeliveries).toHaveLength(0);

    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: 'task-a',
      patch: { status: 'waiting-decision', latestBlocker: '模拟控制消息丢失后的待决状态' },
    }, project.id);
    activityState = 'idle';
    await auditProjectLiveness();

    const recovered = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    expect(recovered.pendingUserQuestion).toBeUndefined();
    expect(recovered.pendingManagerDeliveries).toEqual([expect.objectContaining({
      continuationKey: expect.stringContaining('resolve-decision'),
    })]);
    expect(recovered.events).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'guard-triggered',
      payload: expect.objectContaining({
        attentionRequired: false,
        action: 'project-active-obligation-continuation',
        obligation: 'resolve-decision',
      }),
    })]));
  });

  it('does not let a stale working lifecycle claim hide an idle project from the watchdog', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-stale-working-watchdog' });
    const managerSurfaceId = 'project-manager-stale-working-watchdog';
    attachProjectManagerSurface(project.id, managerSurfaceId);
    const staleUpdatedAt = Date.now() - 16 * 60_000;
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [managerSurfaceId]: {
        state: 'working', blockedReason: null, blockedVersion: 0, updatedAt: staleUpdatedAt,
      },
      'worker-a': {
        state: 'working', blockedReason: null, blockedVersion: 0, updatedAt: staleUpdatedAt,
      },
      'supervisor-a': {
        state: 'working', blockedReason: null, blockedVersion: 0, updatedAt: staleUpdatedAt,
      },
    });
    surfaceTerminalRegistry.set(managerSurfaceId, {
      buffer: {
        active: {
          type: 'normal', baseY: 0, cursorX: 0, cursorY: 1, length: 2,
          getLine: (index: number) => ({
            translateToString: (_trimRight?: boolean, start = 0, end?: number) => (
              (index === 0 ? 'OpenAI Codex' : '› Ask Codex to do anything').slice(start, end)
            ),
          }),
        },
      },
      modes: { bracketedPasteMode: true },
    } as any);
    markTerminalRuntimeReady(managerSurfaceId);
    expect(interactiveAgentPromptReady(readTerminalScreen(managerSurfaceId, 80).text || '')).toBe(true);

    initPipeBridge();
    await auditProjectLiveness();

    const recovered = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    expect(recovered.pendingUserQuestion).toBeUndefined();
    expect(recovered.pendingManagerDeliveries).toEqual([expect.objectContaining({
      continuationKey: expect.stringContaining('recover-work'),
    })]);
    await vi.waitFor(() => expect(writes).toHaveBeenCalledWith(
      managerSurfaceId,
      expect.stringContaining('主目标仍有可内部消解的执行义务'),
    ));
    surfaceTerminalRegistry.delete(managerSurfaceId);
    clearTerminalRuntimeStatus(managerSurfaceId);
  });

  it('recovers a project created after bridge initialization when its manager runtime is missing', async () => {
    initPipeBridge();
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-missing-manager-watchdog' });
    const queueRuntimeRecovery = vi.fn(() => true);
    (globalThis.window as any).__wmux_queueProjectManagerRuntimeRecovery = queueRuntimeRecovery;
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      'worker-a': { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000 },
      'supervisor-a': { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000 },
    });

    await auditProjectLiveness();

    expect(queueRuntimeRecovery).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id,
      role: 'manager',
      watchdogRecovery: true,
    }));
  });

  it('requeues a restored waiting-decision project that lost its manager delivery', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-restored-silent-waiting-decision' });
    const managerSurfaceId = 'project-manager-restored-silent-waiting-decision';
    attachProjectManagerSurface(project.id, managerSurfaceId);
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'task-a', patch: {
        status: 'waiting-decision', latestBlocker: '旧续作投递已经丢失',
      },
    }, project.id);
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [managerSurfaceId]: { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000 },
      'worker-a': { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000 },
      'supervisor-a': { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000 },
    });

    initPipeBridge();

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)).toMatchObject({
      status: 'active',
      pendingManagerDeliveries: [expect.objectContaining({
        text: expect.stringContaining('resolve-decision'),
      })],
    }));
    const restored = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    expect(restored.workItems.find((item) => item.id === 'task-a')).toMatchObject({
      status: 'waiting-decision',
    });
    expect(restored.pendingUserQuestion).toBeUndefined();
  });

  it('notifies the user after a stale active lane cannot hide an ignored paused-work continuation', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-stale-active-lane-escalation' });
    const managerSurfaceId = 'project-manager-stale-active-lane';
    attachProjectManagerSurface(project.id, managerSurfaceId);
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    const continuationKey = [
      current.activeGoalId,
      current.requirementsVersion,
      current.authorizationVersion,
      current.orientation?.requestedAt || 0,
      'resume-paused',
      '',
    ].join(':');
    useStore.getState().restoreProjectManager({
      ...current,
      workItems: current.workItems.map((item) => ({
        ...item, status: 'paused' as const, latestBlocker: '内部控制链恢复一次后仍无执行者',
      })),
      events: [...current.events, {
        id: 'ignored-paused-continuation', sessionId: project.id, ts: 2,
        kind: 'guard-triggered', summary: '项目 AI 已收到一次内部续作',
        payload: {
          decision: 'continue', attentionRequired: false,
          action: 'project-active-obligation-continuation',
          continuationKey, attempt: 1, obligation: 'resume-paused',
        },
      }],
    });
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [managerSurfaceId]: {
        state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000,
      },
    });

    initPipeBridge();

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)).toMatchObject({
      status: 'waiting',
      pendingUserQuestion: {
        category: 'manual-intervention',
        reasonCode: 'internal-project-failure',
        workItemId: 'task-a',
      },
    }));
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.events)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        kind: 'guard-triggered',
        payload: expect.objectContaining({
          attentionRequired: true,
          reason: 'project-active-obligation-unhandled',
          obligation: 'resume-paused',
        }),
      })]));
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: '项目需要你的处理',
    }));
  });

  it.each(['refine', 'pivot'] as const)(
    'automatically continues the internal gate after a %s target change instead of asking the user again',
    async (mode) => {
      const project = bindProjectLaneToWorkItem({ projectId: `pm-${mode}-gate-continuation` });
      const store = useStore.getState();
      const updated = store.applyProjectManagerAction({
        type: 'update-project-definition',
        goal: mode === 'pivot' ? '切换后的新主目标' : '调整后的当前主目标',
        preconditions: ['无额外物理前置条件'],
        planFiles: [],
        doneWhen: ['新版本目标可以验收'],
        source: 'user',
        mode,
        reason: `测试 ${mode} 后的门禁续作`,
      }, project.id);
      expect(updated).toMatchObject({ ok: true });
      expect(store.applyProjectManagerAction({
        type: 'require-requirements-alignment', reason: '目标变更后重新对齐',
      }, project.id)).toMatchObject({ ok: true });
      expect(store.applyProjectManagerAction({
        type: 'confirm-requirements-alignment',
        goalUnderstanding: '用户已确认当前目标', scopeSummary: '范围明确',
        acceptanceSummary: '验收明确', reason: '不存在新的实质歧义',
      }, project.id)).toMatchObject({ ok: true });
      store.setProjectSupervisorLanes([]);
      const managerSurfaceId = `project-manager-${mode}-gate`;
      attachProjectManagerSurface(project.id, managerSurfaceId);

      (globalThis.window as any).__wmux_noteManagedAgentHook({
        surfaceId: managerSurfaceId,
        event: 'Stop',
      });

      await vi.waitFor(() => expect(useStore.getState().projectManagers
        .find((candidate) => candidate.id === project.id)?.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'guard-triggered',
          payload: expect.objectContaining({
            action: 'project-waiting-gate-continuation',
            attentionRequired: false,
            obligation: 'orient-project',
          }),
        }),
      ])));
      const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
      expect(current?.pendingUserQuestion).toBeUndefined();
      expect(current?.pendingManagerDeliveries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('wmux project orientation-confirm'),
        }),
      ]));
      expect(current?.pendingManagerDeliveries?.[0]?.text).toContain('不得仅为复述、补格式或重复确认而再次 update-definition 或 ask');
    },
  );

  it('escalates when project AI ignores the bounded target-change gate continuation', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-waiting-gate-escalation' });
    const store = useStore.getState();
    const currentGoalId = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.activeGoalId;
    store.restoreProjectManager({
      ...useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!,
      status: 'waiting',
      orientation: {
        status: 'required', requirementsVersion: 1, authorizationVersion: 1,
        snapshotFingerprint: 'test-progress', reason: '目标调整后重新建立认知', requestedAt: 25,
      },
      events: [{
        id: 'event-gate-continuation', sessionId: project.id, ts: 2, kind: 'guard-triggered',
        summary: '已自动续作一次',
        payload: {
          decision: 'continue', attentionRequired: false,
          action: 'project-waiting-gate-continuation',
          continuationKey: `${currentGoalId}:1:1:25:orient-project:`,
          attempt: 1, obligation: 'orient-project',
        },
      }],
    });
    store.setProjectSupervisorLanes([]);
    const managerSurfaceId = 'project-manager-waiting-gate-escalation';
    attachProjectManagerSurface(project.id, managerSurfaceId);

    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: managerSurfaceId,
      event: 'Stop',
    });

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)).toMatchObject({
      status: 'waiting',
      pendingUserQuestion: {
        category: 'manual-intervention',
        reasonCode: 'internal-project-failure',
      },
    }));
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.events)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'guard-triggered',
          payload: expect.objectContaining({
            attentionRequired: true,
            reason: 'project-waiting-gate-unhandled',
            obligation: 'orient-project',
          }),
        }),
      ]));
  });

  it('continues a restored waiting project from its latest confirmed gate without another user question', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-restored-waiting-gate' });
    const store = useStore.getState();
    const restored = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    store.restoreProjectManager({
      ...restored,
      status: 'waiting',
      requirementsVersion: 2,
      acceptedRequirementsVersion: 1,
      orientation: {
        status: 'required', requirementsVersion: 2, authorizationVersion: 1,
        snapshotFingerprint: 'test-progress', reason: '恢复后按最新目标重新建立认知', requestedAt: 30,
      },
      events: [
        { id: 'restored-alignment-required', sessionId: project.id, ts: 2, kind: 'requirements-alignment-required', summary: '恢复后重新对齐' },
        { id: 'restored-alignment-confirmed', sessionId: project.id, ts: 3, kind: 'requirements-alignment-confirmed', summary: '最新目标已经确认' },
      ],
    });
    store.setProjectSupervisorLanes([]);
    const managerSurfaceId = 'project-manager-restored-waiting-gate';
    attachProjectManagerSurface(project.id, managerSurfaceId);
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [managerSurfaceId]: { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000 },
    });

    initPipeBridge();

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'guard-triggered',
        payload: expect.objectContaining({
          action: 'project-waiting-gate-continuation',
          obligation: 'orient-project',
        }),
      }),
    ])));
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.pendingUserQuestion)
      .toBeUndefined();
  });

  it('does not treat achieved legacy stages as a runnable plan on manager or remote resume', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-achieved-plan-resume' });
    const store = useStore.getState();
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    store.restoreProjectManager({
      ...current,
      status: 'waiting',
      workItems: current.workItems.map((item) => ({
        ...item, status: 'completed' as const, supervisorLaneId: undefined, workerSurfaceId: undefined,
      })),
      subgoals: [{
        id: 'legacy-achieved-stage', goalId: current.activeGoalId!, title: '旧目标已完成阶段', outcome: '旧成果',
        acceptance: ['旧成果已经验收'], dependencies: [], status: 'achieved', order: 1, createdAt: 1, updatedAt: 1,
      }],
    });
    store.setProjectSupervisorLanes([]);
    const managerSurfaceId = 'project-manager-achieved-plan-resume';
    attachProjectManagerSurface(project.id, managerSurfaceId);
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(request({
      action: 'resume', callerSurfaceId: managerSurfaceId, projectId: project.id,
      reason: '尝试复用全部已完成的旧阶段',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('阶段计划') });
    await expect(remote({
      action: 'resume', projectId: project.id, reason: '用户尝试从远程恢复旧阶段',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('阶段计划') });
  });

  it('automatically creates a planning continuation when completed legacy work leaves an unfinished stage uncovered', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-uncovered-stage-continuation' });
    const managerSurfaceId = 'project-manager-uncovered-stage';
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    useStore.getState().restoreProjectManager({
      ...current,
      managerSurfaceId: managerSurfaceId as any,
      workItems: current.workItems.map((workItem) => ({
        ...workItem,
        status: 'completed' as const,
        supervisorLaneId: undefined,
        workerSurfaceId: undefined,
      })),
      subgoals: [{
        id: 'qualification', goalId: current.activeGoalId!, title: '最终资格验收', outcome: '形成最终资格结论',
        acceptance: ['实际验证证据齐全'], dependencies: [], status: 'planned', order: 1, createdAt: 1, updatedAt: 1,
      }],
    });
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-unplanned' as any,
      title: '项目未规划死等测试',
      cwd: project.projectDir,
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf' as const,
        paneId: 'pane-unplanned' as any,
        activeSurfaceIndex: 0,
        surfaces: [{
          id: managerSurfaceId as any,
          type: 'terminal' as const,
          shell: 'pwsh.exe',
          projectManagerTerminal: true,
          projectManagerProjectId: project.id,
          projectManagerAgent: 'codex',
        }],
      },
    }]);
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [managerSurfaceId]: {
        state: 'working', blockedReason: null, blockedVersion: 0, updatedAt: Date.now(),
      },
    });

    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: managerSurfaceId,
      event: 'UserPromptSubmit',
      task: '核对旧项目恢复后的剩余阶段',
    });
    await Promise.resolve();
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.status)
      .toBe('active');

    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: managerSurfaceId,
      event: 'Stop',
    });
    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)?.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'guard-triggered', payload: expect.objectContaining({
            action: 'project-active-obligation-continuation',
            attentionRequired: false,
            obligation: 'plan-work',
          }),
        }),
      ])));
    const continued = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(continued?.status).toBe('active');
    expect(continued?.pendingUserQuestion).toBeUndefined();
    expect(continued?.pendingManagerDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('wmux project task-create') }),
    ]));
    expect(continued?.pendingManagerDeliveries?.[0]?.text).toContain('不得重复覆盖 goal-plan');
    expect((globalThis.window as any).wmux.notification.fire).not.toHaveBeenCalledWith(expect.objectContaining({
      title: '项目需要你的处理',
    }));
  });

  it('invalidates the stale completed-chain question on initialization and resumes internal planning', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-stale-completed-chain-question' });
    const managerSurfaceId = 'project-manager-stale-completed-chain';
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    const questionCreatedAt = Date.now() - 10;
    useStore.getState().restoreProjectManager({
      ...current,
      status: 'waiting',
      workItems: current.workItems.map((workItem) => ({
        ...workItem,
        status: 'completed' as const,
        supervisorLaneId: undefined,
        workerSurfaceId: undefined,
      })),
      subgoals: [{
        id: 'qualification', goalId: current.activeGoalId!, title: '最终资格验收', outcome: '形成最终资格结论',
        acceptance: ['实际验证证据齐全'], dependencies: [], status: 'planned', order: 1, createdAt: 1, updatedAt: 1,
      }],
      pendingUserQuestion: {
        id: 'stale-completed-chain-question', category: 'manual-intervention',
        blocker: '当前主目标的工作项均已完成，需要执行目标级验收或关闭主目标',
        reasonCode: 'internal-project-failure',
        question: '执行链已全部停止，是否按最新协议恢复？', context: '旧控制层误判为目标验收。',
        options: [{ id: 'retry-latest-protocol', label: '按最新协议恢复' }, { id: 'keep-paused', label: '保持暂停' }],
        recommendedOptionId: 'retry-latest-protocol', previousStatus: 'active', createdAt: questionCreatedAt,
      },
      events: [...current.events, {
        id: 'stale-completed-chain-guard', sessionId: project.id, ts: questionCreatedAt + 1,
        kind: 'guard-triggered', summary: '项目执行链没有后续处理者',
        payload: { attentionRequired: true, obligation: 'complete-goal', reason: 'project-execution-deadlock' },
      }],
    });
    useStore.getState().setProjectSupervisorLanes([]);
    attachProjectManagerSurface(project.id, managerSurfaceId);
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [managerSurfaceId]: { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() - 2_000 },
    });

    initPipeBridge();

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user-clarification-invalidated',
        payload: expect.objectContaining({ reason: 'active-goal-has-uncovered-subgoal' }),
      }),
      expect.objectContaining({
        kind: 'guard-triggered',
        payload: expect.objectContaining({ action: 'project-active-obligation-continuation' }),
      }),
    ])));
    const recovered = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(recovered).toMatchObject({ status: 'active', pendingUserQuestion: undefined });
    expect(recovered?.pendingManagerDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('qualification（最终资格验收，planned）') }),
    ]));
  });

  it('escalates when project AI ends a turn without applying the user answer', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-unhandled-answer' });
    const managerSurfaceId = 'project-manager-unhandled-answer';
    useStore.getState().restoreProjectManager({ ...project, managerSurfaceId: managerSurfaceId as any });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-unhandled-answer' as any,
      title: '用户答复未落实测试',
      cwd: project.projectDir,
      splitTree: {
        type: 'leaf' as const,
        paneId: 'pane-unhandled-answer' as any,
        activeSurfaceIndex: 0,
        surfaces: [{
          id: managerSurfaceId as any,
          type: 'terminal' as const,
          shell: 'pwsh.exe',
          projectManagerTerminal: true,
          projectManagerProjectId: project.id,
          projectManagerAgent: 'codex',
        }],
      },
    }]);
    const store = useStore.getState();
    const question = {
      id: 'question-unhandled-answer',
      category: 'manual-intervention' as const,
      workItemId: 'task-a',
      blocker: '执行链需要用户选择恢复方式',
      reasonCode: 'internal-project-failure' as const,
      question: '是否按最新协议恢复？',
      context: '当前执行链已暂停。',
      options: [
        { id: 'retry', label: '恢复', description: '按最新协议恢复。' },
        { id: 'pause', label: '暂停', description: '继续保持暂停。' },
      ],
      recommendedOptionId: 'retry',
      previousStatus: 'active' as const,
      createdAt: Date.now(),
    };
    expect(store.applyProjectManagerAction({ type: 'request-user-clarification', question }, project.id))
      .toMatchObject({ ok: true });
    expect(store.applyProjectManagerAction({
      type: 'answer-user-clarification', questionId: question.id,
      answer: '按最新协议恢复', optionId: 'retry', answeredBy: 'desktop',
    }, project.id)).toMatchObject({ ok: true });

    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: managerSurfaceId,
      event: 'UserPromptSubmit',
      task: '处理用户答复',
    });
    (globalThis.window as any).__wmux_noteManagedAgentHook({ surfaceId: managerSurfaceId, event: 'Stop' });

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)).toMatchObject({
      status: 'waiting',
      pendingUserQuestion: {
        category: 'manual-intervention',
        reasonCode: 'internal-project-failure',
        recommendedOptionId: 'retry-latest-protocol',
      },
    }));
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.events)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'guard-triggered',
          payload: expect.objectContaining({ reason: 'project-user-answer-unhandled' }),
        }),
      ]));
  });

  it('escalates an exhausted supervisor transition after the final manager reminder turn', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-transition-exhausted' });
    const managerSurfaceId = 'project-manager-transition-exhausted';
    useStore.getState().restoreProjectManager({
      ...project,
      managerSurfaceId: managerSurfaceId as any,
      pendingManagerDeliveries: [],
      pendingSupervisorTransitions: [{
        id: 'transition-exhausted',
        laneId: 'lane-a',
        workItemId: 'task-a',
        kind: 'project-action-required',
        eventType: 'supervisor.decision-error-loop',
        summary: '监督协议异常等待项目 AI 处理',
        createdAt: 1,
        notifiedAt: 2,
        notificationCount: 2,
      }],
    });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-transition-exhausted' as any,
      title: '交接提醒耗尽测试',
      cwd: project.projectDir,
      splitTree: {
        type: 'leaf' as const,
        paneId: 'pane-transition-exhausted' as any,
        activeSurfaceIndex: 0,
        surfaces: [{
          id: managerSurfaceId as any,
          type: 'terminal' as const,
          shell: 'pwsh.exe',
          projectManagerTerminal: true,
          projectManagerProjectId: project.id,
          projectManagerAgent: 'codex',
        }],
      },
    }]);

    (globalThis.window as any).__wmux_noteManagedAgentHook({
      surfaceId: managerSurfaceId,
      event: 'UserPromptSubmit',
      task: '再次处理监督交接',
    });
    (globalThis.window as any).__wmux_noteManagedAgentHook({ surfaceId: managerSurfaceId, event: 'Stop' });

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)).toMatchObject({
      status: 'waiting',
      pendingUserQuestion: {
        category: 'manual-intervention',
        reasonCode: 'internal-project-failure',
      },
    }));
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.events)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'guard-triggered',
          payload: expect.objectContaining({ reason: 'project-transition-unhandled' }),
        }),
      ]));
  });

  it('does not send the first project task contract while the new task Agent state is unknown', () => {
    bindProjectLaneToWorkItem();
    agentState = { ...agentState, state: 'unknown', updatedAt: 2 };

    expect(decide({ next: '开始执行项目任务契约' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('尚未产生可信 Agent 生命周期'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps an internal milestone inside the supervisor until the full stage checklist is complete', async () => {
    bindProjectLaneToWorkItem({ continuousExecution: true });
    useAcknowledgedTaskDelivery();
    const completionToken = await completionEvidenceToken();

    expect(decide({
      outcome: 'complete',
      executionAction: 'complete-p1-qualification',
      evidence: 'P1 资格验证通过；下一步执行 P2',
      contextSummary: 'P1 已通过，下一步 P2 尚未执行',
      workspaceVersion: 'head:test,diff:p1',
      completionFile: '.wmux/tmp/incomplete-milestone-completion.json',
      completionEvidenceToken: completionToken,
      completionChecklist: {
        stopWhen: [{ index: 1, status: 'satisfied', result: 'passed', method: 'runtime-test', evidence: '测试任务完成证据', evidenceRefs: ['evidence/result.json'] }],
        validation: [{ index: 1, status: 'satisfied', result: 'passed', method: 'runtime-test', evidence: '测试结果核对证据', evidenceRefs: ['evidence/result.json'] }],
        remainingWork: ['继续执行 P2'],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('剩余工作'),
    });
    expect(useStore.getState().projectManager?.pendingSupervisorTransitions || []).toHaveLength(0);
    expect(useStore.getState().projectManager?.pendingManagerDeliveries || []).toHaveLength(0);

    expect(await decide({
      outcome: 'continue',
      next: '继续执行 P2，并在完成全部阶段验证后汇总证据',
      executionAction: 'continue-p2-qualification',
      evidence: 'P1 资格验证通过',
      contextSummary: 'P1 已完成，P2 是合同内明确下一步',
      workspaceVersion: 'head:test,diff:p1',
    })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledWith(
      'worker-a',
      expect.stringContaining('继续执行 P2'),
    );
    expect(useStore.getState().projectManager?.pendingSupervisorTransitions || []).toHaveLength(0);
  });

  it('treats waiting for the next prompt as ready for the next supervised batch', async () => {
    bindProjectLaneToWorkItem({ continuousExecution: true });
    useAcknowledgedTaskDelivery();
    agentState = {
      state: 'blocked',
      blockedReason: 'Waiting for your next prompt',
      blockedVersion: 7,
      updatedAt: Date.now(),
    };

    expect(await decide({
      outcome: 'continue',
      next: '继续执行合同内下一批并报告证据',
      executionAction: 'continue-next-batch',
    })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledWith('worker-a', expect.stringContaining('继续执行合同内下一批'));
    expect(useStore.getState().supervisor.lanes[0].lastBlockedResponseVersion).toBeUndefined();
  });

  it('allows completion from an agent waiting for the next prompt and reuses prior test evidence', async () => {
    const project = bindProjectLaneToWorkItem({ continuousExecution: true });
    const priorRecord = {
      ts: 1,
      actionSignature: 'test-action',
      commandSignature: 'test-command',
      errorSignature: '',
      progressSignature: 'test-progress',
      workspaceVersion: 'head:test',
      testCommand: 'npm test -- auth',
      testResult: 'passed',
    };
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: project.workItems[0].id,
      patch: { executionHistory: [priorRecord, { ...priorRecord, ts: 2 }] },
    }, project.id);
    agentState = {
      state: 'blocked',
      blockedReason: 'Waiting for next prompt',
      blockedVersion: 9,
      updatedAt: Date.now(),
    };
    const completionToken = await completionEvidenceToken();

    expect(decide({
      outcome: 'complete',
      reason: '全部验收已满足',
      executionAction: 'complete-stage',
      evidence: '既有定向测试已通过，相关 diff 已复核',
      testCommand: 'npm test -- auth',
      testResult: 'passed',
      workspaceVersion: 'head:test',
      completionStopWhen: '1',
      completionValidation: '1',
      remainingWork: 'none',
      completionFile: '.wmux/tmp/waiting-agent-completion.json',
      completionEvidenceToken: completionToken,
      completionChecklist: {
        stopWhen: [{ index: 1, status: 'satisfied', result: 'failed', method: 'runtime-test', evidence: '测试已实际执行并形成明确失败结论，该条件要求完成评估而非必须通过', evidenceRefs: ['evidence/result.json'] }],
        validation: [{ index: 1, status: 'satisfied', result: 'passed', method: 'evidence-review', evidence: '既有定向测试和 diff 已复核', evidenceRefs: ['evidence/result.json'] }],
        remainingWork: [],
      },
    })).toMatchObject({ ok: true, outcome: 'complete', waiting: true });
  });

  it('rejects legacy numeric completion self-reports for a current-protocol project task', () => {
    bindProjectLaneToWorkItem({ continuousExecution: true });

    expect(decide({
      outcome: 'complete',
      evidence: '只提交了旧式编号，没有逐项证据',
      completionStopWhen: '1',
      completionValidation: '1',
      remainingWork: 'none',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('--completion-file'),
    });
  });

  it('rejects a structured completion when any required condition is unverified', async () => {
    bindProjectLaneToWorkItem({ continuousExecution: true });
    const completionToken = await completionEvidenceToken();

    expect(decide({
      outcome: 'complete',
      evidence: '离线证据存在，但没有执行上机验证',
      completionFile: '.wmux/tmp/unverified-completion.json',
      completionEvidenceToken: completionToken,
      completionChecklist: {
        stopWhen: [{ index: 1, status: 'unverified', result: 'not-run', method: 'static-check', evidence: '任务终端未连接设备', evidenceRefs: ['evidence/result.json'] }],
        validation: [{ index: 1, status: 'satisfied', result: 'passed', method: 'static-check', evidence: '仅核对了离线文件', evidenceRefs: ['evidence/result.json'] }],
        remainingWork: [],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('unverified'),
    });
  });

  it('does not let a static inspection impersonate a required runtime retest', async () => {
    const project = bindProjectLaneToWorkItem({ continuousExecution: true });
    const item = project.workItems[0];
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: item.id, patch: {
        contract: { ...item.contract, stopWhen: ['完成实机复测'] },
      },
    }, project.id);
    const completionToken = await completionEvidenceToken();

    expect(decide({
      outcome: 'complete', evidence: '只检查了既有结果文件',
      completionFile: '.wmux/tmp/static-only-completion.json',
      completionEvidenceToken: completionToken,
      completionChecklist: {
        stopWhen: [{ index: 1, status: 'satisfied', result: 'passed', method: 'static-check', evidence: '既有配置文件可解析', evidenceRefs: ['evidence/result.json'] }],
        validation: [{ index: 1, status: 'satisfied', result: 'passed', method: 'evidence-review', evidence: '既有结果格式已核对', evidenceRefs: ['evidence/result.json'] }],
        remainingWork: [],
      },
    })).toMatchObject({ ok: false, error: expect.stringContaining('不能代替') });
  });

  it('records a failed test but does not satisfy a criterion that explicitly requires passing', async () => {
    const project = bindProjectLaneToWorkItem({ continuousExecution: true });
    const item = project.workItems[0];
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: item.id, patch: {
        contract: { ...item.contract, stopWhen: ['实机复测通过'] },
      },
    }, project.id);
    const completionToken = await completionEvidenceToken();

    expect(decide({
      outcome: 'complete', evidence: '实机复测已执行但性能失败',
      completionFile: '.wmux/tmp/failed-required-pass.json',
      completionEvidenceToken: completionToken,
      completionChecklist: {
        stopWhen: [{ index: 1, status: 'satisfied', result: 'failed', method: 'runtime-test', evidence: '性能阈值失败', evidenceRefs: ['evidence/result.json'] }],
        validation: [{ index: 1, status: 'satisfied', result: 'passed', method: 'evidence-review', evidence: '失败结果文件完整', evidenceRefs: ['evidence/result.json'] }],
        remainingWork: [],
      },
    })).toMatchObject({ ok: false, error: expect.stringContaining('失败结果不能') });
  });

  it('still escalates a real external blocker after the task AI is no longer running', () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-real-external-blocker' });
    agentState = { ...agentState, state: 'idle', updatedAt: Date.now() };

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      escalationBoundary: 'external-blocker',
      reason: '外部测试环境凭据已经失效',
      impact: '本地无法恢复该外部环境',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    const transition = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingSupervisorTransitions?.[0];
    expect(transition).toMatchObject({
      kind: 'project-action-required', eventType: 'supervisor.project-blocker',
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingManagerDeliveries?.find((delivery) => delivery.transitionId === transition?.id)?.text)
      .toContain('真实外部条件');
  });

  it('notifies the user when a completed lane enters waiting for a new direction', () => {
    const appendRecord = vi.fn(async () => undefined);
    (globalThis.window as any).wmux.supervisor = { appendRecord };
    useStore.getState().updateLane('lane-a', {
      config: { waitForNextDirection: true, stopWhen: '当前阶段测试通过' },
    });

    expect(decide({ outcome: 'complete', next: '', reason: '当前阶段测试已经通过' }))
      .toMatchObject({ ok: true, outcome: 'complete' });

    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'waiting',
      decisions: [expect.objectContaining({
        outcome: 'complete',
        completion: {
          summary: '当前阶段测试已经通过',
          validation: ['当前阶段测试通过'],
          completedAt: expect.any(Number),
        },
      })],
    });
    expect(appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'supervisor.waiting-for-direction',
      payload: expect.objectContaining({
        reason: '当前阶段测试已经通过',
        stopWhen: '当前阶段测试通过',
      }),
    }));
    expect(appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'supervisor.decision',
      payload: expect.objectContaining({
        completion: expect.objectContaining({
          summary: '当前阶段测试已经通过',
          validation: ['当前阶段测试通过'],
        }),
      }),
    }));
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith({
      surfaceId: 'supervisor-a',
      title: 'AI 监督待续',
      text: 'AI 监督通道“worker”已进入待续；直接在对应 AI 监督终端说明新方案即可继续。',
      flash: false,
    });
  });

  it('returns to waiting and emits a new waiting event when resumed direction is insufficient', () => {
    const appendRecord = vi.fn(async () => undefined);
    (globalThis.window as any).wmux.supervisor = { appendRecord };
    useStore.getState().updateLane('lane-a', {
      config: { waitForNextDirection: true, stopWhen: '当前阶段测试通过' },
      awaitingDirectionAfterWaitingResume: true,
    });

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'direction-needed',
      reason: '新方向只有“继续看看”，缺少明确目标和验收条件',
    })).toMatchObject({ ok: true, outcome: 'needs-human', waiting: true });

    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'waiting',
      stopConfirmed: true,
      awaitingReview: false,
      awaitingDirectionAfterWaitingResume: false,
    });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'supervisor.waiting-for-direction',
      payload: expect.objectContaining({
        reason: '新方向只有“继续看看”，缺少明确目标和验收条件',
      }),
    }));
  });

  it('keeps real human decisions as approvals after a waiting lane resumes', () => {
    useStore.getState().updateLane('lane-a', {
      config: { waitForNextDirection: true, stopWhen: '当前阶段测试通过' },
      awaitingDirectionAfterWaitingResume: true,
    });

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      reason: '需要用户决定是否发布到生产环境',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });

    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'active',
      awaitingReview: true,
      awaitingDirectionAfterWaitingResume: true,
    });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
  });

  it('rejects direction-needed outside a resumed waiting cycle', () => {
    useStore.getState().updateLane('lane-a', {
      config: { waitForNextDirection: true, stopWhen: '当前阶段测试通过' },
      awaitingDirectionAfterWaitingResume: false,
    });

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'direction-needed',
      reason: '缺少下一步方向',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('仅可用于待续恢复后'),
    });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
  });

  it('defers a project next step until the task composer is stably empty without escalating the project', async () => {
    vi.useFakeTimers();
    const project = bindProjectLaneToWorkItem();
    screenText = '│ > 用户尚未提交的任务草稿';
    const terminal = surfaceTerminalRegistry.get('worker-a') as any;
    terminal.buffer.active.cursorX = screenText.length;

    expect(decide({ next: '监督建议的下一步' })).toMatchObject({
      ok: true,
      deliveryDeferred: true,
      message: expect.stringContaining('输入框已有未提交内容'),
    });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      controlState: 'active',
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)).toMatchObject({
      status: 'active',
      workItems: [expect.objectContaining({ id: 'task-a', status: 'running' })],
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingSupervisorTransitions || []).toHaveLength(0);
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      surfaceId: 'worker-a',
      text: expect.stringContaining('提交或清空输入后'),
    }));

    await vi.advanceTimersByTimeAsync(1_200);
    expect(queuedControlText()).toBe('');
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingSupervisorTransitions || []).toHaveLength(0);

    screenText = '│ > ';
    terminal.buffer.active.cursorX = screenText.length;
    await vi.advanceTimersByTimeAsync(600);

    expect(queuedControlText()).toContain('[任务终端输入区已恢复为空｜重新裁决]');
    expect(queuedControlText()).toContain('不得假设任务 AI 已经收到');
    expect(writes).not.toHaveBeenCalled();
  });

  it('fails closed when the task terminal input state is unavailable', () => {
    surfaceTerminalRegistry.delete('worker-a');

    expect(decide({ next: '监督建议的下一步' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('输入状态不可用'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('allows a bounded route adjustment and rejects material or incomplete proposals', () => {
    expect(decide({ proposalKind: 'route-adjustment', next: '保留接口，改用已有适配器并运行本地测试' }))
      .toMatchObject({ ok: true });
    expect(decide({ proposalKind: 'route-adjustment', next: '' })).toMatchObject({ ok: false });
    expect(decide({ proposalKind: 'route-change', next: '更换框架' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('answers one low-risk technical choice while the worker is blocked', () => {
    agentState = { state: 'blocked', blockedReason: 'technical implementation question: choose adapter A or B', blockedVersion: 1, updatedAt: 2 };
    expect(decide({
      proposalKind: 'route-adjustment',
      next: '选择方案 A：保留现有接口，改用已有适配器并运行本地测试',
    })).toMatchObject({ ok: true });
    expect(writes).toHaveBeenCalledWith(
      'worker-a',
      ordinaryTaskDelivery('选择方案 A：保留现有接口，改用已有适配器并运行本地测试'),
    );

    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({ next: '再次选择方案 A' })).toMatchObject({ ok: false });
    expect(decide({ next: '' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('keeps risky or permission-blocked input out of the technical-choice path', () => {
    agentState = { state: 'blocked', blockedReason: 'question: choose方案 A or方案 B', blockedVersion: 1, updatedAt: 2 };
    expect(decide({ next: '选择方案 A 后 git push origin main' })).toMatchObject({ ok: false });
    agentState = { state: 'blocked', blockedReason: 'permission: npm test', blockedVersion: 2, updatedAt: 3 };
    expect(decide({ next: 'y' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps user-only or ambiguous questions out of the technical-choice path', () => {
    agentState = {
      state: 'blocked',
      blockedReason: 'input required: accept Terms of Service and choose billing plan A/B',
      blockedVersion: 1,
      blockedRequestId: 'business-choice',
      updatedAt: 2,
    };
    expect(decide({ next: '选择方案 A' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('用户偏好'),
    });
    agentState = {
      state: 'blocked',
      blockedReason: 'input required: choose shipping address A or B',
      blockedVersion: 2,
      blockedRequestId: 'shipping-choice',
      updatedAt: 3,
    };
    expect(decide({ next: '选择方案 A' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('blocks high-impact next work before it reaches the worker', () => {
    expect(decide({ next: 'git push origin main' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('requires a task source before autonomously sending next work', () => {
    const currentConfig = useStore.getState().supervisor.lanes[0].config!;
    useStore.getState().updateLane('lane-a', { config: { ...currentConfig, taskGoal: '' } });

    expect(decide({ next: '运行相关单元测试' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('当前没有任务目标'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('enforces each selected autonomy permission at the decision bridge', () => {
    useStore.getState().patchSupervisor({
      autonomyPermissions: ['technical-choice', 'route-adjustment', 'permission-confirm'],
    });
    expect(decide({ next: '运行相关单元测试' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('继续原路线'),
    });

    useStore.getState().patchSupervisor({ autonomyPermissions: ['same-route-next'] });
    expect(decide({ proposalKind: 'route-adjustment', next: '改用已有适配器并补测试' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('小范围可逆路线调整'),
    });

    agentState = { state: 'blocked', blockedReason: 'technical implementation question: choose adapter A or B', blockedVersion: 1, updatedAt: 2 };
    useStore.getState().patchSupervisor({ autonomyPermissions: ['route-adjustment'] });
    expect(decide({ proposalKind: 'route-adjustment', next: '选择方案 A 并验证' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('回答低风险技术问题'),
    });

    agentState = { state: 'blocked', blockedReason: 'permission: npm test', blockedVersion: 2, updatedAt: 3 };
    useStore.getState().patchSupervisor({ autonomyPermissions: ['same-route-next'] });
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('确认低风险权限请求'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('infers common unlabelled technical choices and route adjustments', () => {
    useStore.getState().patchSupervisor({ autonomyPermissions: ['same-route-next'] });
    expect(decide({ next: '选择方案 A 并运行测试' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('回答低风险技术问题'),
    });
    expect(decide({ next: '改用已有适配器并运行测试' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('小范围可逆路线调整'),
    });
    expect(decide({ next: '放弃现有认证层，从头重做登录流程' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('小范围可逆路线调整'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('enforces selected forbidden items and the current-project boundary', () => {
    expect(decide({ next: '执行 npm install example-package' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('新增或升级第三方依赖'),
    });
    expect(decide({ next: '读取 C:\\other\\config.json 后继续' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('当前工程文件夹之外'),
    });
    useStore.getState().updateLane('lane-a', {
      scopeRoot: 'E:\\repo',
      projectDir: 'D:\\outside',
    });
    expect(decide({ next: '读取 D:\\outside\\config.json 后继续' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('当前工程文件夹之外'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('allows users to clear optional forbidden selections without weakening hard safety', () => {
    useStore.getState().patchSupervisor({ forbiddenActions: [] });
    expect(decide({ next: '执行 npm install example-package' })).toMatchObject({ ok: true });
    expect(writes).toHaveBeenCalledWith(
      'worker-a',
      ordinaryTaskDelivery('执行 npm install example-package'),
    );

    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({ next: 'git push origin main' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('keeps remote package and service operations human-gated even when optional restrictions are cleared', () => {
    useStore.getState().patchSupervisor({ forbiddenActions: [] });
    useStore.getState().updateLane('lane-a', { remoteSshControl: true });

    expect(decide({ next: '在 SSH 终端执行 npm install sharp' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/SSH 远程控制终端.*安装/),
    });
    expect(decide({ next: '在 SSH 终端执行 systemctl restart nginx' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/SSH 远程控制终端.*服务/),
    });
    expect(decide({ next: 'wmux send-key c --ctrl --surface ssh-task' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/SSH 远程控制终端.*中断信号/),
    });
    expect(decide({ next: '在 SSH 终端执行 rm -rf /srv/cache' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/SSH 远程控制终端.*删除/),
    });
    expect(decide({ next: '确认 SSH 远端权限请求并发送 y' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/SSH 远程控制终端.*权限批准/),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('allows stop decisions and needs-human with no autonomy permissions selected', () => {
    useStore.getState().patchSupervisor({ autonomyPermissions: [] });
    expect(decide({ next: '' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('--task-file'),
    });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '请用户补充业务取舍',
      impact: '无法从代码证据判断',
      alternatives: '保持现状',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });

    const approval = useStore.getState().supervisor.pendingApprovals[0];
    useStore.getState().rejectPending(approval.id);
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({ outcome: 'complete', next: '' })).toMatchObject({ ok: true, outcome: 'complete' });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects old context recovery delivery under the current ordinary protocol', () => {
    useStore.getState().updateLane('lane-a', {
      contextRecoveryStatus: 'draft-pending',
      restoreSource: { surfaceId: 'worker-old', label: '旧任务', sessionId: 'sup-old' },
      restoredHistory: '已完成基础实现，下一步恢复测试',
      restoredFromSessionId: 'sup-old',
    });
    const recoveryText = '请恢复当前任务，并按主线程统筹、子线程执行测试的分工继续。';

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'context-recovery',
      reason: '请确认恢复指令',
      next: recoveryText,
    })).toMatchObject({ ok: false, error: expect.stringContaining('不允许向任务 AI 发送旧上下文') });

    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
  });

  it('keeps restored history as supervisor evidence without enabling task recovery delivery', () => {
    useStore.getState().updateLane('lane-a', {
      restoreSource: { surfaceId: 'worker-old', label: '旧任务', sessionId: 'sup-old' },
      restoredHistory: '已完成基础实现，下一步恢复测试',
      restoredFromSessionId: 'sup-old',
    });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      restoreSource: { surfaceId: 'worker-old' },
      restoredHistory: '已完成基础实现，下一步恢复测试',
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('expires a persisted old context-recovery approval instead of delivering it', () => {
    useStore.getState().enqueueApproval({
      laneId: 'lane-a', surfaceId: 'worker-a' as any, laneLabel: 'worker',
      source: 'supervisor-context-recovery', proposalKind: 'context-recovery',
      text: '恢复旧任务并重建 wmux 角色上下文', reason: '升级前遗留待决项',
    });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('待决项协议无效') });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects a context recovery proposal when the lane did not request recovery', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'context-recovery',
      reason: '请确认恢复指令',
      next: '恢复旧任务',
    })).toMatchObject({ ok: false, error: expect.stringContaining('不允许向任务 AI 发送旧上下文') });
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps the review window open when task delivery fails', () => {
    writes.mockImplementationOnce(() => { throw new Error('pty closed'); });

    expect(decide({ next: '运行相关单元测试' })).toMatchObject({ ok: false, error: expect.stringContaining('pty closed') });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      autoDecisionsUsed: 0,
      decisions: [],
    });
  });

  it('confirms a low-risk permission without consuming a judgment slot', async () => {
    screenText = 'Command: npm test\nContinue? [y/N]';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: npm test',
      blockedVersion: 1,
      blockedRequestId: 'request-1',
      updatedAt: 2,
    };
    writes.mockImplementation((_surfaceId: string, data: string) => {
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 3 };
    });
    await expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' }))
      .resolves.toMatchObject({ ok: true, autoAuthorized: true });
    expect(writes).toHaveBeenNthCalledWith(1, 'worker-a', 'y');
    expect(useStore.getState().supervisor.lanes[0].autoDecisionsUsed).toBe(0);
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    agentState = { ...agentState, state: 'blocked', updatedAt: 99 };
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it('allows a project supervisor to confirm a contract-authorized local permission prompt', async () => {
    bindProjectLaneToWorkItem({ permissionConfirm: true, allowedCommandPrefixes: ['npm test'] });
    screenText = 'Command: npm test\nContinue? [y/N]';
    agentState = {
      state: 'blocked', blockedReason: 'permission: npm test', blockedVersion: 1,
      blockedRequestId: 'project-permission-1', updatedAt: 2,
    };
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 3 };
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;

    await expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).resolves.toMatchObject({
      ok: true, autoAuthorized: true,
    });
  });

  it('rejects project context recovery summaries that disclose orchestration identities', () => {
    bindProjectLaneToWorkItem();
    expect(decide({
      outcome: 'rework', proposalKind: 'context-recovery',
      reason: '任务 AI 连续遗忘当前成果', evidence: '连续两轮重复已经完成的工作',
      contextSummary: '项目 AI 要求等待监督 AI 下一步，工作项 ID=task-a',
    })).toMatchObject({ ok: false, error: expect.stringContaining('污染任务 AI') });
  });

  it('confirms a permission response through the reliable queue and task-state observation', async () => {
    screenText = 'Command: npm test\nContinue? [y/N]';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: npm test',
      blockedVersion: 1,
      blockedRequestId: 'request-reliable',
      updatedAt: 2,
    };
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 3 };
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;

    await expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).resolves.toMatchObject({
      ok: true,
      autoAuthorized: true,
      delivery: { confirmed: true, agentState: 'working' },
    });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', 'y'],
      ['worker-a', '\r'],
    ]);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: false,
      autoDecisionsUsed: 0,
      lastBlockedResponseId: 'request-reliable',
    });
  });

  it('always sends an SSH-controlling terminal permission request to a human', () => {
    screenText = 'Command: npm test\nContinue? [y/N]';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: npm test',
      blockedVersion: 1,
      blockedRequestId: 'remote-request-1',
      updatedAt: 2,
    };
    useStore.getState().updateLane('lane-a', { remoteSshControl: true });

    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('必须由人工确认'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects a permission command that does not match the current blocked request', () => {
    screenText = 'Command: git push origin main\nContinue? [y/N]';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: git push origin main',
      blockedVersion: 1,
      blockedRequestId: 'request-risky',
      updatedAt: 2,
    };

    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/不一致|推送/),
    });
    expect(writes).not.toHaveBeenCalled();
  });('rejects generic permission placeholders even when the screen contains the same words', () => {
    screenText = 'permission required';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission required',
      blockedVersion: 1,
      blockedRequestId: 'generic-permission',
      updatedAt: 2,
    };
    expect(decide({ permissionCommand: 'permission', permissionResponse: 'y' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('具体命令'),
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([false, true])('always queues needs-human instead of auto-sending (autonomous=%s)', (autonomous) => {
    useStore.getState().patchSupervisor({ autonomous });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'route-change',
      next: '切换主要实现路线',
      impact: '影响外部接口',
      alternatives: '保留当前路线',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
  });

  it('does not let a supervisor bypass a pending user decision after receiving supplemental context', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      reason: '需要用户决定',
      alternatives: '继续或停止',
    })).toMatchObject({ ok: true });

    expect(decide({ outcome: 'continue', next: '根据用户补充意见继续' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('仍有待用户决策项'),
    });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
  });

  it('returns the adopted proposal to the AI supervisor for整理 before worker delivery', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '按现有方案完成实现并运行测试',
      reason: '需要用户批准当前方案',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: '已采用 AI 监督当前方案；AI 监督将整理后发送到任务终端。' });
    expect(queuedOwnerDecision()?.text).toContain('[用户选择] 按现有方案完成实现并运行测试');
    expect(queuedOwnerDecision()?.text).not.toContain('[AI 原建议] 按现有方案完成实现并运行测试');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(true);
  });

  it('returns user-entered guidance to the AI supervisor with the adopted proposal', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      reason: '需要用户补充明确的处理方向',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decide',
      approvalId: approval.id,
      decision: 'approve',
      task: '保持现有 API，先补充回归测试',
      actor: 'ou-user',
    })).toMatchObject({
      ok: true,
      message: '已将用户决策信息交给 AI 监督；AI 监督将整理后发送到任务终端。',
    });
    expect(queuedOwnerDecision()?.text).toContain('[用户补充信息] 保持现有 API，先补充回归测试');
    expect(queuedOwnerDecision()?.text).toContain('[用户选择] 推荐方案 A：保持现状并等待用户确认');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
  });

  it('persists an accepted owner decision until the AI supervisor is ready', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '按现有方案完成实现并运行测试',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user' }))
      .toMatchObject({ ok: true });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(queuedOwnerDecision()).toMatchObject({
      kind: 'owner-decision', correlationId: approval.id, stage: 'pending',
    });
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(true);
  });

  it('does not append the adopted plan to an existing worker draft', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '按现有方案继续实现',
      reason: '需要用户批准当前方案',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    screenText = '› 用户正在编辑但尚未提交的 Codex 草稿';
    const terminal = surfaceTerminalRegistry.get('worker-a') as any;
    terminal.buffer.active.cursorX = screenText.length;

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user' }))
      .toMatchObject({ ok: true });
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    expect(queuedOwnerDecision()?.text).toContain('[人工决定]');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
  });

  it('accepts only a current AI-provided option for AI-assisted decisions', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '改用新框架重写当前模块',
      reason: '需要用户选择调整方向',
      alternatives: '方案 A：保留现有框架；方案 B：改用新框架',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('请先选择其中一个方案') });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'reject', actor: 'ou-user' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('无效的人工决策') });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', selection: '自定义修改意见', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('不属于 AI 监督当前提供的备选项') });
    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', selection: '方案', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('不属于 AI 监督当前提供的备选项') });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', selection: '方案 A', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: '已选择 方案 A；AI 监督将整理后发送到任务终端。' });
    expect(queuedOwnerDecision()?.text).toContain('[用户选择] 方案 A');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
  });

  it('uses user guidance instead of an AI option when the user selects none', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '改用新框架重写当前模块',
      reason: '需要用户选择调整方向',
      alternatives: '方案 A：保留现有框架；方案 B：改用新框架',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve',
      selection: SUPERVISOR_NO_DECISION_OPTION, actor: 'ou-user',
    })).toMatchObject({ ok: false, error: '选择“无”时，请填写用户决策或补充信息。' });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve',
      selection: SUPERVISOR_NO_DECISION_OPTION,
      task: '保留现有 API，只补充回归测试', actor: 'ou-user',
    })).toMatchObject({
      ok: true,
      message: '已将用户决策信息交给 AI 监督；AI 监督将整理后发送到任务终端。',
    });
    expect(queuedOwnerDecision()?.text).toContain('[用户补充信息] 保留现有 API，只补充回归测试');
    expect(queuedOwnerDecision()?.text).not.toContain('[用户选择]');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
  });

  it('accepts a numbered option parsed from the AI recommendation', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '请你选下一步\n1. 收官（推荐）\n2. 试宽量级\n3. 换策略',
      reason: '需要用户选择调整方向',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', selection: '选项 2', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: '已选择 选项 2；AI 监督将整理后发送到任务终端。' });
    expect(queuedOwnerDecision()?.text).toContain('[用户选择] 选项 2');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
  });

  it('routes user-entered decision information through the AI supervisor', () => {
    const appendRecord = vi.fn(async () => undefined);
    (globalThis.window as any).wmux.supervisor = { appendRecord };
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '改用新框架重写当前模块',
      reason: '需要用户选择调整方向',
      alternatives: '方案 A：保留现有框架；方案 B：改用新框架',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'direct', task: '   ', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('请填写') });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'direct',
      task: '保持现有 API，先补充回归测试', actor: 'ou-user',
    })).toMatchObject({
      ok: true,
      message: '已将用户决策信息交给 AI 监督；AI 监督将整理后发送到任务终端。',
    });
    expect(queuedOwnerDecision()?.text).toContain('[用户补充信息] 保持现有 API，先补充回归测试');
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(JSON.stringify(appendRecord.mock.calls)).not.toContain('保持现有 API，先补充回归测试');
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
    });
  });

  it('can route a direct user decision to the supervisor while the worker has a draft', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      reason: '需要用户提供决策信息',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    screenText = '› 用户正在编辑但尚未提交的 Codex 草稿';
    const terminal = surfaceTerminalRegistry.get('worker-a') as any;
    terminal.buffer.active.cursorX = screenText.length;

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'direct',
      task: '先保持现有实现', actor: 'ou-user',
    })).toMatchObject({
      ok: true,
      message: expect.stringContaining('交给 AI 监督'),
    });
    expect(writes).not.toHaveBeenCalled();
    expect(queuedOwnerDecision()?.text).toContain('[用户补充信息] 先保持现有实现');
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ awaitingReview: true });
  });

  it('pauses only the owning lane from a Feishu decision while retaining the approval and still allows stop', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      reason: '需要人工决定',
      impact: '影响当前实现',
      alternatives: '继续或停止',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'pause', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: expect.stringContaining('已暂停') });
    expect(useStore.getState().supervisor).toMatchObject({ active: false, paused: true });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ controlState: 'paused' });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'stop', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: expect.stringContaining('已停止 worker 的 AI 监督') });
    expect(useStore.getState().supervisor).toMatchObject({ active: false, paused: false, pendingApprovals: [] });
    expect(useStore.getState().supervisor.lanes).toEqual([]);
  });

  it('pauses and resumes explicitly from the Feishu control menu without replacing the session', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-control' as any,
      title: 'Work',
      splitTree: {
        type: 'leaf',
        paneId: 'pane-control' as any,
        activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi' },
        ],
      },
    }]);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    const sessionId = useStore.getState().supervisor.sessionId;

    expect(remoteControl({ action: 'pause-all', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: expect.stringContaining('已暂停') });
    expect(useStore.getState().supervisor).toMatchObject({ active: false, paused: true, sessionId });

    expect(remoteControl({ action: 'resume-all', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: '已继续普通 AI 监督；项目监督不受影响。' });
    expect(useStore.getState().supervisor).toMatchObject({ active: true, paused: false, sessionId });
    expect(queuedControlText()).toContain('[会话继续]');
  });

  it('keeps Feishu ordinary supervision controls away from project-managed lanes', () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-control' as any,
      title: 'Work',
      splitTree: {
        type: 'leaf',
        paneId: 'pane-control' as any,
        activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi' },
          {
            id: 'worker-project' as any,
            type: 'terminal',
            shell: 'pwsh.exe',
            projectManagerProjectId: 'project-a',
            projectManagerWorkItemId: 'task-a',
          },
          { id: 'supervisor-project' as any, type: 'terminal', shell: 'pi' },
        ],
      },
    }]);
    useStore.getState().setProjectSupervisorLanes([
      {
        ...lane(),
        id: 'lane-project',
        surfaceId: 'worker-project' as any,
        supervisorSurfaceId: 'supervisor-project' as any,
        projectManagerProjectId: 'project-a',
        projectWorkItemId: 'task-a',
      },
    ]);
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    const listed = JSON.parse(remoteControl({ action: 'list' }).message).terminals;
    expect(listed.map((terminal: any) => terminal.surfaceId)).toContain('worker-a');
    expect(listed.map((terminal: any) => terminal.surfaceId)).not.toContain('worker-project');
    expect(remoteControl({ action: 'pause-lane', terminal: 'worker-project', actor: 'ou-user' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('只能由对应的项目管理 AI 控制') });
    expect(remoteControl({ action: 'send', terminal: 'worker-project', task: '绕过项目监督' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('只能由对应的项目监督 AI 投递任务') });
    expect(remoteControl({ action: 'terminal-interrupt', terminal: 'worker-project' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('只能由项目管理模式处理中断') });
    expect(remoteControl({ action: 'close-terminal', terminal: 'worker-project' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('只能由项目管理模式关闭') });
    expect(remoteControl({
      action: 'start',
      terminals: ['worker-project'],
      stopWhen: '伪造项目监督',
      stopWhenKind: 'concrete',
      autonomous: true,
      projectManagerProjectId: 'project-a',
      projectWorkItemId: 'task-a',
    })).toMatchObject({ ok: false, error: expect.stringContaining('只能由对应的项目管理 AI 启动') });
    expect(remoteControl({
      action: 'create-task',
      name: '伪造项目任务',
      task: '绕过项目管理链路',
      cwd: 'E:\\repo',
      projectManagerProjectId: 'project-a',
      projectManagerWorkItemId: 'task-a',
    })).toMatchObject({ ok: false, error: expect.stringContaining('只能由项目管理模式创建') });

    expect(remoteControl({ action: 'pause-all', actor: 'ou-user' })).toMatchObject({ ok: true });
    expect(useStore.getState().supervisor).toMatchObject({ active: true, paused: false });
    expect(useStore.getState().supervisor.lanes.find((item) => item.id === 'lane-a')).toMatchObject({ controlState: 'paused' });
    expect(useStore.getState().supervisor.lanes.find((item) => item.id === 'lane-project')?.controlState).toBe('active');

    expect(remoteControl({ action: 'stop', actor: 'ou-user' })).toMatchObject({
      ok: true,
      message: '已停止普通 AI 监督；项目监督不受影响。',
    });
    expect(useStore.getState().supervisor).toMatchObject({ active: true, paused: false });
    expect(useStore.getState().supervisor.lanes.find((item) => item.id === 'lane-a')).toMatchObject({ controlState: 'stopped' });
    expect(useStore.getState().supervisor.lanes.find((item) => item.id === 'lane-project')?.controlState).toBe('active');
  });

  it('keeps the review open instead of sending natural language to a bare PowerShell terminal', () => {
    agentState = { ...agentState, state: 'unknown' };
    screenText = 'ParserError: Missing ] at end of attribute or type literal.\nPS E:\\repo> ';

    expect(decide({ next: '创建 string-extractor 并运行测试' })).toMatchObject({
      ok: false,
      taskRuntimeBlocked: true,
      error: expect.stringContaining('普通 shell'),
    });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      decisions: [],
    });
  });

  it('allows the first task when an idle Kimi screen is visible before hooks exist', () => {
    agentState = { ...agentState, state: 'unknown' };
    screenText = '✦ Kimi Code\nNo session yet — send your first message\ncontext: 0';

    expect(decide({ next: '创建 string-extractor 并运行测试' })).toMatchObject({
      ok: true,
      outcome: 'continue',
    });
    expect(writes).toHaveBeenCalledWith(
      'worker-a',
      ordinaryTaskDelivery('创建 string-extractor 并运行测试'),
    );
  });

  it('adds a new supervised terminal from Feishu without replacing the active session', async () => {
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-control' as any,
      title: 'Work',
      cwd: 'E:\\repo',
      splitTree: {
        type: 'leaf',
        paneId: 'pane-control' as any,
        activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'worker A' },
          { id: 'supervisor-a' as any, type: 'terminal', shell: 'pi', customTitle: 'AI 监督 · worker A' },
          { id: 'worker-b' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: 'worker B' },
          { id: 'supervisor-old-b' as any, type: 'terminal', shell: 'pi', customTitle: 'AI 监督 · worker B（旧）' },
        ],
      },
    }]);
    useStore.getState().patchSupervisor({ supervisorWorkspaceId: 'ws-control' as any });
    useStore.getState().setOrdinarySupervisorLanes([
      ...useStore.getState().supervisor.lanes.filter((item) => !item.projectManagerProjectId),
      {
        ...lane(),
        id: 'lane-old-b',
        label: 'worker B',
        surfaceId: 'worker-b' as any,
        supervisorSurfaceId: 'supervisor-old-b' as any,
        controlState: 'stopped',
      },
    ]);
    const before = useStore.getState().supervisor;
    const existingManagementSessionId = before.lanes[0].managementSessionId;
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'start',
      terminals: ['worker-b'],
      taskGoal: '完成新增终端测试',
      stopWhen: '新增终端测试通过',
      stopWhenKind: 'concrete',
      autonomous: false,
      actor: 'ou-user',
    })).toMatchObject({ ok: true, message: expect.stringContaining('已添加 AI 监督终端') });

    const after = useStore.getState().supervisor;
    expect(after).toMatchObject({ active: true, paused: false, sessionId: before.sessionId });
    expect(after.lanes).toHaveLength(2);
    expect(after.lanes[0]).toMatchObject({ surfaceId: 'worker-a', managementSessionId: existingManagementSessionId });
    expect(after.lanes.some((item) => item.id === 'lane-old-b')).toBe(false);
    expect(useStore.getState().workspaces[0].splitTree.type === 'leaf'
      && useStore.getState().workspaces[0].splitTree.surfaces.some((surface) => surface.id === 'supervisor-old-b')).toBe(false);
    expect(after.lanes[1]).toMatchObject({
      surfaceId: 'worker-b',
      awaitingReview: true,
      config: { stopWhen: '新增终端测试通过' },
    });
    await vi.waitFor(() => expect(queuedControlText(after.lanes[1].id)).toContain('新增终端测试通过'));
  });
});
