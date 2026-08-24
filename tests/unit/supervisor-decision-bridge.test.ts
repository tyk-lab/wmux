import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeSupervisorDelivery,
  initPipeBridge,
  ordinaryClarificationQuestions,
  permissionCommandMatchesEvidence,
  projectContractAutonomyPermissions,
  projectMessageChangeSignal,
  projectSafeExitEffectiveActivity,
  reconcileResolvedProjectDecisionTransitions,
  projectSupervisorTransitionRedeliveryMs,
  redactProjectSafeExitExcerpt,
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
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';
import {
  DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
  PROJECT_MANAGER_TERMINAL_NAME,
} from '../../src/shared/project-manager-terminal';
import { SUPERVISOR_NO_DECISION_OPTION } from '../../src/shared/supervisor-decision-options';
import {
  activeProjectManagerAttentionEvent,
  CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
  DEFAULT_PROJECT_EXECUTION_BUDGET,
  createProjectWorkerGroup,
  resolveProjectParallelismDecision,
  type ProjectManagerSession,
  type ProjectProgressSnapshot,
  type ProjectResourceLease,
  type ProjectWorkerAssignment,
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
import {
  ORDINARY_TASK_ROLE_ANCHOR,
  buildOrdinaryTaskEventEnvelope,
} from '../../src/renderer/role-context';
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
    controlState: 'active',
    awaitingStopCheck: false,
    stopConfirmed: false,
    awaitingReview: false,
    autoDecisionsUsed: 0,
    decisions: [],
    config: {
      taskGoal: '完成当前测试任务', taskDescription: '', preconditions: '',
      stopWhen: '测试任务完成', stopWhenKind: 'concrete', planFilePath: '',
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
  store.updateLane(laneId, {
    pendingSupervisorDeliveries: (target.pendingSupervisorDeliveries || [])
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
  await expect(request({
    action: 'alignment-confirm', callerSurfaceId: session?.managerSurfaceId, projectId,
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

function bindProjectLaneToWorkItem(options: {
  projectId?: string;
  workItemId?: string;
  continuousExecution?: boolean;
  permissionConfirm?: boolean;
  allowedCommandPrefixes?: string[];
  baselineRequired?: boolean;
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
      baseline: options.baselineRequired
        ? { status: 'required', requirementsVersion: 1 }
        : {
            status: 'approved', requirementsVersion: 1, workspaceVersion: 'head:test',
            evidence: '测试夹具已提供项目基线', approvedAt: 1,
          },
      supervisorPlanRequired: false,
      title: workItemId,
      status: 'running',
      dependencies: [],
      supervisorLaneId: 'lane-a',
      workerSurfaceId: 'worker-a',
      attempts: 0,
      decisionsUsed: 0,
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
}

function approveProjectWorkItemBaseline(projectId: string, workItemId: string, requirementsVersion = 1): void {
  const store = useStore.getState();
  const started = store.applyProjectManagerAction({ type: 'start-work-item-baseline', workItemId }, projectId);
  if (!started.ok) throw new Error(started.error || 'failed to start project baseline');
  const approved = store.applyProjectManagerAction({
    type: 'approve-work-item-baseline',
    workItemId,
    workspaceVersion: `head:test-v${requirementsVersion}`,
    evidence: '测试夹具已审核当前项目工作树、入口、测试约定和改动边界',
  }, projectId);
  if (!approved.ok) throw new Error(approved.error || 'failed to approve project baseline');
}

async function startTaskThroughDedicatedSupervisor(projectId: string, workItemId: string) {
  const request = (globalThis.window as any).__wmux_projectManagerRequest;
  const session = useStore.getState().projectManagers.find((project) => project.id === projectId);
  let pendingLane = useStore.getState().supervisor.lanes.find((lane) => (
    lane.projectManagerProjectId === projectId && lane.projectWorkItemId === workItemId
  ));
  if (!pendingLane) {
    await expect(request({
      action: 'task-supervise',
      callerSurfaceId: session?.managerSurfaceId,
      projectId,
      workItemId,
    })).resolves.toMatchObject({ ok: true, waitingForSupervisorTaskTerminal: true });
    pendingLane = useStore.getState().supervisor.lanes.find((lane) => (
      lane.projectManagerProjectId === projectId && lane.projectWorkItemId === workItemId
    ));
  }
  expect(pendingLane).toMatchObject({
    projectTaskStartupPending: true,
    supervisorSurfaceId: expect.any(String),
    surfaceId: expect.stringContaining('project-task-pending-'),
    autonomousOverride: true,
    workScopeOverride: 'project',
    forbiddenActionsOverride: expect.any(Array),
  });
  await vi.waitFor(() => expect(useStore.getState().supervisor.lanes
    .find((lane) => lane.id === pendingLane?.id)?.pendingSupervisorDeliveries)
    .toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'control-message',
        bootstrapOnRuntimeReady: true,
        text: expect.stringContaining('项目监督 AI · 首次启动任务终端'),
      }),
    ])));
  expect(pendingLane?.autonomyPermissionsOverride).toContain('same-route-next');
  const effectivePermissions = effectiveSupervisorAutonomyPermissions(
    useStore.getState().supervisor,
    pendingLane!,
  );
  const workItem = useStore.getState().projectManagers.find((project) => project.id === projectId)
    ?.workItems.find((item) => item.id === workItemId);
  expect(effectivePermissions.includes('permission-confirm'))
    .toBe(workItem?.contract.authority.permissionConfirm === true);
  const projectExecutionWorkspace = useStore.getState().workspaces.find((workspace) => (
    workspace.transientSupervisorWorkspace === true
    && workspace.splitTree.type === 'leaf'
    && workspace.splitTree.surfaces.some((surface) => surface.id === pendingLane?.supervisorSurfaceId)
  ));
  expect(projectExecutionWorkspace).toBeTruthy();
  expect(projectExecutionWorkspace?.splitTree.type === 'leaf'
    ? projectExecutionWorkspace.splitTree.surfaces.some((surface) => (
      surface.id === session?.managerSurfaceId
      && surface.projectManagerTerminal === true
      && surface.projectManagerProjectId === projectId
    ))
    : false).toBe(true);
  const projectTaskSurfacesBefore = useStore.getState().workspaces.flatMap((workspace) => (
    workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
  )).filter((surface) => (
    surface.projectManagerProjectId === projectId && !surface.projectManagerTerminal
  ));
  expect(projectTaskSurfacesBefore).toEqual([]);
  await expect(request({
    action: 'task-terminal-start',
    callerSurfaceId: session?.managerSurfaceId,
    projectId,
    workItemId,
  })).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining('只有该工作项的新建 AI 监督'),
  });
  const created = await request({
    action: 'task-terminal-start',
    callerSurfaceId: pendingLane?.supervisorSurfaceId,
    projectId,
    workItemId,
  });
  expect(created, JSON.stringify(created)).toMatchObject({ ok: true, surfaceId: expect.any(String) });
  const lane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === pendingLane?.id);
  expect(lane).toMatchObject({
    projectTaskStartupPending: false,
    surfaceId: created.surfaceId,
    supervisorSurfaceId: pendingLane?.supervisorSurfaceId,
  });
  const taskWorkspace = useStore.getState().workspaces.find((workspace) => (
    workspace.splitTree.type === 'leaf'
    && workspace.splitTree.surfaces.some((surface) => surface.id === created.surfaceId)
  ));
  const taskSurface = taskWorkspace?.splitTree.type === 'leaf'
    ? taskWorkspace.splitTree.surfaces.find((surface) => surface.id === created.surfaceId)
    : undefined;
  expect(taskWorkspace?.id).toBe(projectExecutionWorkspace?.id);
  expect(taskWorkspace?.transientSupervisorWorkspace).toBe(true);
  expect(lane?.workspaceId).toBe(projectExecutionWorkspace?.id);
  expect(taskWorkspace?.splitTree.type === 'leaf'
    ? taskWorkspace.splitTree.surfaces.some((surface) => surface.id === lane?.supervisorSurfaceId)
    : false).toBe(true);
  expect(taskSurface).toMatchObject({
    projectManagerProjectId: projectId,
    projectManagerWorkItemId: workItemId,
  });
  return { created, lane, pendingLane };
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

  afterEach(() => {
    vi.useRealTimers();
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().resetOrdinarySupervisorSession();
    useStore.getState().restoreProjectManager(null);
    useStore.getState().replaceAllWorkspaces([]);
    useStore.getState().setWorkspacePrefs({ projectManagementAgents: DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG });
    surfaceTerminalRegistry.delete('worker-a');
    surfaceTerminalRegistry.delete('supervisor-a');
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
    const current = useStore.getState().supervisor.lanes[0];
    useStore.getState().updateLane(current.id, {
      awaitingReview: false,
      goalConstruction: {
        status: 'drafting',
        initialIdea: '把登录问题修好',
        draft: {
          taskGoal: '把登录问题修好',
          taskDescription: '',
          preconditions: '',
          stopWhen: '',
          stopWhenKind: 'concrete',
        },
        messages: [{ id: 'initial', role: 'user', text: '把登录问题修好', ts: 1 }],
        startedAt: 1,
      },
    });

    expect((globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a', supervisorSurfaceId: 'supervisor-a', outcome: 'continue', reason: '开始执行', next: '修改登录逻辑',
    })).toMatchObject({ ok: false, error: expect.stringContaining('终端上下文尚未汇总完成') });

    expect((globalThis.window as any).__wmux_supervisorGoalDraft({
      surfaceId: 'worker-a', callerSurfaceId: 'supervisor-a',
      taskGoal: '无效草案', preconditions: ['无额外物理前置条件'], stopWhen: ['完成'], stopWhenKind: 'invalid',
    })).toMatchObject({ ok: false, error: expect.stringContaining('concrete 或 direction') });
    expect((globalThis.window as any).__wmux_supervisorGoalDraft({
      surfaceId: 'worker-a', callerSurfaceId: 'supervisor-a',
      taskGoal: '修复登录失败并保持现有兼容性',
      taskDescription: '仅处理登录模块和相关测试',
      preconditions: ['无额外物理前置条件'],
      stopWhen: ['登录相关测试通过', '错误提示可验证'],
      stopWhenKind: 'concrete',
    })).toMatchObject({ ok: true, draft: { taskGoal: '修复登录失败并保持现有兼容性' } });
    expect((globalThis.window as any).__wmux_supervisorReply({
      surfaceId: 'worker-a', callerSurfaceId: 'supervisor-a', message: '草案已补全，请确认。',
    })).toMatchObject({ ok: true });
    expect(useStore.getState().supervisor.lanes[0].goalConstruction?.messages.at(-1)).toMatchObject({
      role: 'assistant', text: '草案已补全，请确认。',
    });

    const remote = (globalThis.window as any).__wmux_supervisorRemoteControl;
    expect(remote({
      action: 'send-supervisor-message', terminal: 'worker-a', message: '保持旧接口兼容', actor: 'desktop',
    })).toMatchObject({ ok: true, message: expect.stringContaining('终端上下文补充') });
    expect(writes).toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[终端上下文补充｜用户回复]'));

    expect(remote({ action: 'confirm-goal-construction', terminal: 'worker-a', actor: 'desktop' }))
      .toMatchObject({ ok: true, message: expect.stringContaining('原地进入正式') });
    const confirmed = useStore.getState().supervisor.lanes[0];
    expect(confirmed.goalConstruction).toMatchObject({ status: 'confirmed', confirmedAt: expect.any(Number) });
    expect(confirmed.config).toMatchObject({
      taskGoal: '修复登录失败并保持现有兼容性',
      preconditions: '无额外物理前置条件',
      stopWhen: '登录相关测试通过\n错误提示可验证',
    });
    expect(confirmed.supervisorSurfaceId).toBe('supervisor-a');
    expect(queuedControlText()).toContain('[终端上下文补全完成｜用户已确认｜现在进入正式监督]');
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
    const current = useStore.getState().supervisor.lanes[0];
    useStore.getState().updateLane(current.id, {
      awaitingReview: false,
      goalConstruction: {
        status: 'drafting',
        initialIdea: '从已有终端继续',
        draft: {
          taskGoal: '', taskDescription: '', preconditions: '', stopWhen: '', stopWhenKind: 'concrete',
        },
        messages: [],
        startedAt: 1,
      },
    });

    const finalize = (globalThis.window as any).__wmux_supervisorGoalFinalize;
    expect(finalize({
      surfaceId: 'worker-a', callerSurfaceId: 'worker-a',
      taskGoal: '完成认证收尾', preconditions: ['无额外前置条件'], stopWhen: ['集成测试通过'], stopWhenKind: 'concrete',
    })).toMatchObject({ ok: false, error: expect.stringContaining('绑定的监督 AI') });
    expect(finalize({
      surfaceId: 'worker-a', callerSurfaceId: 'supervisor-a',
      taskGoal: '完成认证收尾',
      taskDescription: '根据已有终端进度完成剩余验证',
      preconditions: ['无额外前置条件'],
      stopWhen: ['集成测试通过'],
      stopWhenKind: 'concrete',
    })).toMatchObject({ ok: true, message: expect.stringContaining('信息充分') });

    const confirmed = useStore.getState().supervisor.lanes[0];
    expect(confirmed.goalConstruction).toMatchObject({
      status: 'confirmed', confirmedAt: expect.any(Number),
    });
    expect(confirmed.config).toMatchObject({ taskGoal: '完成认证收尾', stopWhen: '集成测试通过' });
    expect(queuedControlText()).toContain('[终端上下文汇总完成｜条件充分｜现在进入正式监督]');
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
      role: 'project-task', identity: { projectId: project.id, workItemId: project.workItems[0].id },
    });
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

  it('lets only the owning project supervisor escalate a stuck task from Esc to Ctrl+C', async () => {
    const project = bindProjectLaneToWorkItem();
    useStore.getState().restoreProjectManager({ ...project, managerSurfaceId: 'project-manager-a' as any });
    agentState = { state: 'working', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() };
    screenText = 'Working (1200s) · 正在执行既定任务';
    const writeReliable = vi.fn(async () => true);
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    await expect(request({
      action: 'task-terminal-control',
      callerSurfaceId: 'project-manager-a',
      projectId: project.id,
      workItemId: 'task-a',
      control: 'escape',
      reason: '越权调用',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('项目管理 AI 运行时') });

    await expect(request({
      action: 'task-terminal-control',
      callerSurfaceId: 'supervisor-a',
      projectId: project.id,
      workItemId: 'task-a',
      control: 'interrupt',
      reason: '任务终端仍无语义输出',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('先发送一次 Esc') });

    await expect(request({
      action: 'task-terminal-control',
      callerSurfaceId: 'supervisor-a',
      projectId: project.id,
      workItemId: 'task-a',
      control: 'escape',
      reason: '只读屏幕连续无语义变化，只有计时刷新',
    })).resolves.toMatchObject({ ok: true, control: 'escape' });
    expect(writeReliable).toHaveBeenCalledWith('worker-a', '\x1b');

    await expect(request({
      action: 'task-terminal-control',
      callerSurfaceId: 'supervisor-a',
      projectId: project.id,
      workItemId: 'task-a',
      control: 'interrupt',
      reason: '尝试在 Esc 后立即升级硬中断',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('观察时间不足') });
    const escapeEvent = useStore.getState().projectManager?.events.find((event) => (
      event.kind === 'guard-triggered' && event.payload?.action === 'task-ai-escape'
    ));
    if (escapeEvent) escapeEvent.ts -= 60_000;

    screenText = 'Esc 后任务终端输出了新的恢复信息';
    await expect(request({
      action: 'task-terminal-control',
      callerSurfaceId: 'supervisor-a',
      projectId: project.id,
      workItemId: 'task-a',
      control: 'interrupt',
      reason: '尝试忽略新的输出继续中断',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('新的语义输出') });

    screenText = 'Working (1200s) · 正在执行既定任务';
    await expect(request({
      action: 'task-terminal-control',
      callerSurfaceId: 'supervisor-a',
      projectId: project.id,
      workItemId: 'task-a',
      control: 'interrupt',
      reason: 'Esc 后重新只读检查仍为 working 且无新输出',
    })).resolves.toMatchObject({ ok: true, control: 'interrupt' });
    expect(writeReliable).toHaveBeenCalledWith('worker-a', '\x03');
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'guard-triggered', payload: expect.objectContaining({ action: 'task-ai-escape' }) }),
      expect.objectContaining({ kind: 'guard-triggered', payload: expect.objectContaining({ action: 'task-ai-interrupt' }) }),
    ]));

    agentState = { ...agentState, state: 'idle', updatedAt: Date.now() };
    await expect(request({
      action: 'task-terminal-control',
      callerSurfaceId: 'supervisor-a',
      projectId: project.id,
      workItemId: 'task-a',
      control: 'escape',
      reason: '不应中断已经空闲的任务 AI',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('当前为 idle') });
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

  it('blocks stale project dispatch until the project AI reviews external progress', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-progress-review' });
    const managerSurfaceId = 'project-manager-progress';
    useStore.getState().restoreProjectManager({ ...project, managerSurfaceId: managerSurfaceId as any });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-progress-review' as any,
      title: '项目进度同步',
      cwd: project.projectDir,
      splitTree: {
        type: 'leaf', paneId: 'pane-progress-review' as any, activeSurfaceIndex: 0,
        surfaces: [{
          id: managerSurfaceId as any,
          type: 'terminal',
          shell: 'pwsh.exe',
          projectManagerTerminal: true,
          projectManagerProjectId: project.id,
          projectManagerAgent: 'codex',
          projectManagerModel: '',
          projectManagerReasoningEffort: '',
        }],
      },
    }, {
      id: 'ws-progress-execution' as any,
      title: '项目执行链',
      cwd: project.projectDir,
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf', paneId: 'pane-progress-execution' as any, activeSurfaceIndex: 0,
        surfaces: [{
          id: 'worker-a' as any,
          type: 'terminal',
          shell: 'pwsh.exe',
          projectManagerProjectId: project.id,
          projectManagerWorkItemId: 'task-a',
        }, {
          id: 'supervisor-a' as any,
          type: 'terminal',
          shell: 'pi',
          transientSupervisor: true,
          projectSupervisorProjectId: project.id,
        }],
      },
    }]);
    const external = {
      ...progressSnapshot('external-progress'),
      entries: [{
        path: 'src/external-change.ts', source: 'workspace' as const,
        status: 'M', signature: 'sha256:external',
      }],
    };
    const captureProgress = vi.mocked((globalThis.window as any).wmux.projectManager.captureProgress);
    captureProgress.mockResolvedValue({ ok: true, snapshot: external });
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === 'lane-a')).toMatchObject({
      controlState: 'active',
      projectManagerProjectId: project.id,
      projectWorkItemId: 'task-a',
    });
    expect(captureProgress).not.toHaveBeenCalled();
    const activeLaneRetry = await request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId,
      projectId: project.id, workItemId: 'task-a',
    });
    expect(captureProgress).not.toHaveBeenCalled();
    expect(activeLaneRetry).toMatchObject({ ok: false, error: expect.stringContaining('已有正常运行的监督通道') });
    expect(useStore.getState().projectManager?.progressSync).toMatchObject({
      status: 'ready', snapshotFingerprint: 'test-progress',
    });

    useStore.getState().pauseSupervisorLane('lane-a', '模拟恢复前已暂停的项目执行链');
    await expect(request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId,
      projectId: project.id, workItemId: 'task-a',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('尚未复核的进度变化') });
    expect(useStore.getState().projectManager?.progressSync).toMatchObject({
      status: 'review-required', snapshotFingerprint: 'external-progress',
    });
    expect(useStore.getState().projectManager?.workItems[0].baseline).toMatchObject({ status: 'required' });

    await expect(request({
      action: 'progress-sync', callerSurfaceId: 'worker-a', projectId: project.id,
      acknowledge: true, summary: '越权确认',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('项目管理 AI 运行时') });
    captureProgress.mockResolvedValue({
      ok: true,
      snapshot: {
        ...external,
        fingerprint: 'external-progress-2',
        entries: [...external.entries, {
          path: 'tests/external-change.test.ts', source: 'workspace' as const,
          status: 'A?', signature: 'sha256:external-test',
        }],
      },
    });
    await expect(request({
      action: 'progress-sync', callerSurfaceId: managerSurfaceId, projectId: project.id,
      acknowledge: true, summary: '尝试确认已经过期的第一次快照',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('再次变化') });
    expect(useStore.getState().projectManager?.progressSync).toMatchObject({
      status: 'review-required', snapshotFingerprint: 'external-progress-2',
    });
    expect(useStore.getState().projectManager?.progressSync?.summary).toEqual(expect.stringContaining('src/external-change.ts'));
    expect(useStore.getState().projectManager?.progressSync?.summary).toEqual(expect.stringContaining('tests/external-change.test.ts'));
    await expect(request({
      action: 'progress-sync', callerSurfaceId: managerSurfaceId, projectId: project.id,
      acknowledge: true, summary: '确认外部改动属于可复用实现；先重新建立任务基线再补充验证',
    })).resolves.toMatchObject({ ok: true });
    expect(useStore.getState().projectManager?.progressSync).toMatchObject({
      status: 'ready', acknowledgement: expect.stringContaining('可复用实现'),
    });
    expect(useStore.getState().projectManager?.orientation).toMatchObject({
      status: 'required', snapshotFingerprint: 'external-progress-2',
    });
    const requiredOrientation = useStore.getState().projectManager!.orientation!;
    await expect(request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId,
      projectId: project.id, workItemId: 'task-a',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('认知基线') });
    await expect(request({
      action: 'orientation-confirm', callerSurfaceId: managerSurfaceId, projectId: project.id,
      requirementsVersion: requiredOrientation.requirementsVersion,
      authorizationVersion: requiredOrientation.authorizationVersion,
      snapshotFingerprint: requiredOrientation.snapshotFingerprint,
      requestedAt: requiredOrientation.requestedAt - 1,
      summary: '旧认知请求不应生效', knownFacts: ['旧状态'], unknowns: [],
      workItems: [{ workItemId: 'task-a', disposition: 'verify', basis: '旧状态', nextAction: '不执行' }],
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('认知请求版本已变化') });
    await expect(request({
      action: 'orientation-confirm', callerSurfaceId: managerSurfaceId, projectId: project.id,
      requirementsVersion: requiredOrientation.requirementsVersion,
      authorizationVersion: requiredOrientation.authorizationVersion,
      snapshotFingerprint: requiredOrientation.snapshotFingerprint,
      requestedAt: requiredOrientation.requestedAt,
      summary: '已审查外部进度', knownFacts: ['外部路径发生变化'], unknowns: [], workItems: [],
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('未覆盖工作项') });
    await expect(request({
      action: 'orientation-confirm', callerSurfaceId: managerSurfaceId, projectId: project.id,
      requirementsVersion: requiredOrientation.requirementsVersion,
      authorizationVersion: requiredOrientation.authorizationVersion,
      snapshotFingerprint: requiredOrientation.snapshotFingerprint,
      requestedAt: requiredOrientation.requestedAt,
      summary: '已把外部进度纳入当前任务安排',
      knownFacts: ['当前快照包含外部实现和测试变更'],
      unknowns: ['变化语义仍由新任务基线复核'],
      workItems: [{
        workItemId: 'task-a', disposition: 'verify',
        basis: '目录在中断期间发生变化，不能沿用旧基线', nextAction: '建立新任务基线后继续',
      }],
    })).resolves.toMatchObject({ ok: true, orientation: { status: 'ready' } });
    expect(useStore.getState().projectManager?.workItems[0]).toMatchObject({
      status: 'planned', baseline: { status: 'required' },
    });
    await expect(request({
      action: 'orientation-confirm', callerSurfaceId: managerSurfaceId, projectId: project.id,
      summary: '重复确认不应改写工作项', knownFacts: ['重复调用'], unknowns: [],
      workItems: [{ workItemId: 'task-a', disposition: 'stop', basis: '不应生效', nextAction: '不应停止' }],
    })).resolves.toMatchObject({ ok: true, orientation: { status: 'ready' } });
    expect(useStore.getState().projectManager?.workItems[0].status).toBe('planned');
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'progress-sync-required' }),
      expect.objectContaining({ kind: 'progress-sync-acknowledged' }),
      expect.objectContaining({ kind: 'project-orientation-confirmed' }),
    ]));

    useStore.getState().resumeSupervisorLane(
      'lane-a',
      '模拟需求重新对齐后遗留的伪 active 标志',
    );
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === 'lane-a'))
      .toMatchObject({ controlState: 'active' });

    await expect(request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId,
      projectId: project.id, workItemId: 'task-a',
    })).resolves.toMatchObject({ ok: true, recovered: true, laneId: 'lane-a' });
    expect(useStore.getState().projectManager?.workItems[0]).toMatchObject({
      status: 'running', baseline: { status: 'required' },
    });
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === 'lane-a'))
      .toMatchObject({ controlState: 'active', projectTaskContractPending: true });
    expect(queuedControlText()).toContain('项目专属监督恢复');
    expect(queuedControlText()).toContain('项目基线：待审核');
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
      action: 'start', terminals: [directSurface?.id], stopWhen: '测试通过', stopWhenKind: 'concrete', autonomous: false,
    })).toMatchObject({ ok: true });
    expect(useStore.getState().supervisor.lanes.some((item) => item.surfaceId === directSurface?.id)).toBe(true);
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

  it('starts one internal project-management AI runtime without exposing or focusing it as a task terminal', async () => {
    const supervisorRemoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    const projectRemoteControl = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-project' as any,
      title: '被监督项目',
      cwd: 'E:\\repo',
      splitTree: {
        type: 'leaf', paneId: 'pane-anchor' as any, activeSurfaceIndex: 0,
        surfaces: [
          { id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '被监督任务' },
          { id: 'worker-neighbor' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: PROJECT_MANAGER_TERMINAL_NAME },
        ],
      },
    }]);
    const projectRequest = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(projectRequest({
      action: 'status', callerSurfaceId: 'worker-neighbor', projectId: 'pm-not-created',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('项目管理 AI 运行时') });

    await expect(projectRemoteControl({
      action: 'start', projectDir: 'E:\\repo', goal: '',
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('goal'),
    });

    await expect(projectRemoteControl({
      action: 'start', projectDir: 'E:\\repo', goal: '完成项目',
    })).resolves.toMatchObject({
      ok: true,
      session: {
        projectName: 'repo',
        projectScope: '仅限项目目录 E:\\repo 内与当前项目直接相关的工作',
        goal: '完成项目',
        preconditions: [],
        doneWhen: [],
        status: 'waiting',
      },
    });

    const project = useStore.getState().projectManager!;
    const workspaces = useStore.getState().workspaces;
    const taskWorkspace = workspaces.find((workspace) => workspace.title === '被监督项目');
    const controlWorkspace = workspaces.find((workspace) => (
      workspace.splitTree.type === 'leaf'
      && workspace.splitTree.surfaces.some((item) => item.id === project.managerSurfaceId)
    ));
    const controlLeaf = controlWorkspace?.splitTree.type === 'leaf' ? controlWorkspace.splitTree : undefined;
    const surface = controlLeaf?.surfaces.find((item) => item.projectManagerTerminal === true);
    expect(taskWorkspace).toBeTruthy();
    expect(controlWorkspace).toBeTruthy();
    expect(useStore.getState().supervisor.supervisorWorkspaceId).not.toBe(controlWorkspace?.id);
    expect(surface).toMatchObject({
      customTitle: PROJECT_MANAGER_TERMINAL_NAME,
      cwd: 'E:\\wmux-data\\project-manager\\runtime',
      projectManagerTerminal: true,
      projectManagerProjectId: project.id,
      projectManagerAgent: 'codex',
      projectManagerModel: '',
      startupCommands: [expect.stringMatching(/^codex -- \(ConvertFrom-Json /)],
    });
    expect(surface?.startupInput).toBeUndefined();
    expect(controlWorkspace?.title).toContain(`${PROJECT_MANAGER_WORKSPACE_TITLE} ·`);
    expect(useStore.getState().activeWorkspaceId).toBe(taskWorkspace?.id);
    expect(JSON.parse(supervisorRemoteControl({ action: 'list' }).message).terminals)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ surfaceId: surface?.id })]));

    const alignmentAssessment = {
      action: 'alignment-confirm', callerSurfaceId: surface?.id,
      projectId: useStore.getState().projectManager?.id,
      goalUnderstanding: '完成当前仓库项目',
      scopeSummary: '仅修改 E:\\repo 内的认证功能',
      acceptanceSummary: '相关测试通过且结果可复核',
      reason: '目标、范围和验收标准均已明确',
    };
    await expect(projectRequest(alignmentAssessment)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('先起草前置条件和可验证完成条件'),
    });
    await expect(projectRequest({
      action: 'update-definition', callerSurfaceId: surface?.id,
      projectId: useStore.getState().projectManager?.id,
      goal: '项目 AI 自行换成另一个目标',
      preconditions: ['无额外物理前置条件'], doneWhen: ['相关测试通过'],
      mode: 'refine', reason: '项目 AI 试图替换用户目标',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('用户提供') });
    await expect(projectRequest({
      action: 'update-definition', callerSurfaceId: surface?.id,
      projectId: useStore.getState().projectManager?.id,
      preconditions: ['无额外物理前置条件'],
      doneWhen: ['相关测试通过'],
      mode: 'refine',
      reason: '项目 AI 补全新建表单中的可选定义',
    })).resolves.toMatchObject({ ok: true, event: { kind: 'project-definition-updated' } });
    await expect(projectRequest(alignmentAssessment)).resolves.toMatchObject({
      ok: true,
      event: { kind: 'requirements-alignment-confirmed' },
    });
    expect((globalThis.window as any).__wmux_roleContext({ callerSurfaceId: surface?.id }))
      .toMatchObject({
        ok: true,
        role: 'project-ai',
        state: { requirementsAlignment: 'confirmed-awaiting-plan-or-resume' },
      });
    await confirmProjectOrientation(project.id);
    await expect(projectRequest({
      action: 'goal-plan', callerSurfaceId: surface?.id,
      projectId: useStore.getState().projectManager?.id,
      reason: '建立首轮测试阶段计划',
      subgoals: [{
        id: 'test_stage', title: '完成测试目标', outcome: '当前项目形成可验收结果',
        acceptance: ['相关测试通过'], dependencies: [], status: 'planned',
      }],
    })).resolves.toMatchObject({ ok: true });
    await expect(projectRequest({
      action: 'resume', callerSurfaceId: surface?.id,
      projectId: useStore.getState().projectManager?.id,
      reason: '首次需求检测已经完成',
    })).resolves.toMatchObject({ ok: true });
    await expect(projectRequest({
      action: 'terminals', callerSurfaceId: surface?.id,
      projectId: useStore.getState().projectManager?.id,
    })).resolves.toMatchObject({ ok: true, terminals: [] });

    await expect(projectRequest({
      action: 'task-create', callerSurfaceId: surface?.id,
      workItem: {
        id: 'missing_boundary', title: '错误单步合同', status: 'planned', dependencies: [],
        contract: {
          objective: '不允许退化成逐步授权', description: '', preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: {
            technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false,
            continuousExecution: false, permissionConfirm: false,
          },
          stopWhen: ['不执行'], validation: ['不执行'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('continuationBoundary'),
    });

    await expect(projectRequest({
      action: 'task-create', callerSurfaceId: surface?.id,
      workItem: {
        id: 'external_auth', title: '错误绑定', status: 'planned', dependencies: [], workerSurfaceId: 'worker-a',
        contract: {
          objective: '不应接管现有终端', description: '', preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['不执行'], validation: ['不执行'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('运行时绑定只能由控制层创建'),
    });
    await expect(projectRequest({
      action: 'task-create', callerSurfaceId: surface?.id,
      workItem: {
        id: 'auth', title: '认证', status: 'planned', dependencies: [],
        attempts: 999, decisionsUsed: 999,
        contract: {
          objective: '完成认证', description: '', preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: ['src/auth'], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['认证测试通过'], validation: ['npm test -- auth'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    })).resolves.toMatchObject({ ok: true });
    expect(useStore.getState().projectManager?.workItems[0]).toMatchObject({
      attempts: 0,
      decisionsUsed: 0,
      supervisorPlanRequired: true,
      baseline: { status: 'required', requirementsVersion: 2 },
    });
    expect(useStore.getState().projectManager?.workItems[0].contract.stopWhen)
      .toEqual(['认证测试通过', '相关测试通过']);
    await expect(projectRequest({
      action: 'task-update', callerSurfaceId: surface?.id, workItemId: 'auth',
      patch: {
        baseline: {
          status: 'approved', requirementsVersion: 1, workspaceVersion: 'forged',
          evidence: 'forged', approvedAt: 1,
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('项目基线状态由控制层维护'),
    });
    await expect(projectRequest({
      action: 'task-update', callerSurfaceId: surface?.id, workItemId: 'auth',
      patch: { workerSurfaceId: 'worker-a', supervisorLaneId: 'lane-a' },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('绑定由控制层维护'),
    });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'auth', patch: { attempts: 2, decisionsUsed: 4 },
    });
    await expect(projectRequest({
      action: 'task-update', callerSurfaceId: surface?.id, workItemId: 'auth',
      patch: { title: '认证更新', attempts: 0, decisionsUsed: 0 },
    })).resolves.toMatchObject({ ok: true });
    expect(useStore.getState().projectManager?.workItems[0]).toMatchObject({
      title: '认证更新', attempts: 2, decisionsUsed: 4,
    });
    approveProjectWorkItemBaseline(project.id, 'auth');
    await expect(projectRequest({
      action: 'task-update', callerSurfaceId: surface?.id, workItemId: 'auth',
      patch: { status: 'completed', latestEvidence: '代码测试通过', latestBlocker: 'needs-human: 等待用户现场验收' },
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('manual-intervention') });
    await expect(projectRequest({
      action: 'task-update', callerSurfaceId: surface?.id, workItemId: 'auth',
      patch: { status: 'validating', latestBlocker: '' },
    })).resolves.toMatchObject({ ok: true });
    expect(useStore.getState().projectManager?.workItems[0].latestBlocker).toBeUndefined();

    const adaptiveContract = {
      objective: '分析并实现自适应任务', description: '', preconditions: [],
      scope: { root: 'E:\\repo', allowPaths: ['src/auth'], denyPaths: [], forbiddenActions: [] },
      authority: {
        technicalChoices: true, lowRiskRetries: true, targetedTests: true,
        internalThreads: true, continuousExecution: true, permissionConfirm: false,
      },
      execution: {
        taskWorkMode: 'adaptive',
        modeReason: '需要先探测代码所有权边界',
        mainThreadResponsibility: '负责探测、集成和最终验证',
        childThreadResponsibilities: [],
        maxChildThreads: 2,
        supervisorMayApproveThreads: true,
        parallelizableOperations: ['只读分析实现', '只读分析测试'],
        serializedOperations: ['设备重上电', '最终集成验证'],
      },
      stopWhen: ['自适应任务完成'], validation: ['检查相关 diff'],
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
    };
    await expect(projectRequest({
      action: 'task-create', callerSurfaceId: surface?.id,
      workItem: {
        id: 'adaptive_preassigned', title: '提前分工', status: 'planned', dependencies: [],
        contract: {
          ...adaptiveContract,
          execution: {
            ...adaptiveContract.execution,
            childThreadResponsibilities: ['提前指定实现线程'],
          },
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('不能预分配子线程职责'),
    });
    await expect(projectRequest({
      action: 'task-create', callerSurfaceId: surface?.id,
      workItem: {
        id: 'adaptive_bad', title: '缺少串行边界', status: 'planned', dependencies: [],
        contract: {
          ...adaptiveContract,
          execution: { ...adaptiveContract.execution, serializedOperations: [] },
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('可并行与必须串行操作'),
    });
    await expect(projectRequest({
      action: 'task-create', callerSurfaceId: surface?.id,
      workItem: {
        id: 'adaptive_ok', title: '自适应任务', status: 'planned', dependencies: [],
        contract: adaptiveContract,
      },
    })).resolves.toMatchObject({ ok: true });
    expect(useStore.getState().projectManager?.workItems.find((item) => item.id === 'adaptive_ok')?.contract.execution)
      .toEqual(expect.objectContaining({
        taskWorkMode: 'adaptive',
        childThreadResponsibilities: [],
        maxChildThreads: 2,
        supervisorMayApproveThreads: true,
        parallelizableOperations: ['只读分析实现', '只读分析测试'],
        serializedOperations: ['设备重上电', '最终集成验证'],
      }));

    await expect(projectRequest({
      action: 'stop', callerSurfaceId: surface?.id, emergency: true, reason: '未获用户确认',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('用户') });
    await expect(projectRequest({
      action: 'pause', callerSurfaceId: surface?.id, reason: '讨论项目方案',
    })).resolves.toMatchObject({ ok: true });
    expect(useStore.getState().supervisor.lanes.find((item) => item.id === 'lane-a')?.controlState).not.toBe('paused');
    await expect(projectRequest({
      action: 'resume', callerSurfaceId: surface?.id, reason: '继续项目',
    })).resolves.toMatchObject({ ok: true });

    await expect(projectRemoteControl({ action: 'start' })).resolves.toMatchObject({ ok: true, restored: true });
    const runtimes = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf'
        ? workspace.splitTree.surfaces.filter((item) => item.projectManagerTerminal === true)
        : []
    ));
    expect(runtimes).toHaveLength(1);
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
      question: '是否允许覆盖现有配置？',
      context: '计划文件与当前配置存在冲突。',
      options: [
        { id: 'keep', label: '保留现有配置', description: '采用兼容性修改。' },
        { id: 'replace', label: '允许覆盖', description: '配置更简洁，但会替换现有设置。' },
      ],
      recommendedOptionId: 'keep',
    })).resolves.toMatchObject({ ok: true, question: { recommendedOptionId: 'keep' } });
    expect(useStore.getState().projectManagers.find((project) => project.id === first.id)).toMatchObject({
      status: 'waiting', pendingUserQuestion: { question: '是否允许覆盖现有配置？' },
    });
    expect(useStore.getState().projectManagers.find((project) => project.id === second.id)?.status).toBe('waiting');
    expect(useStore.getState().projectManagerDialogOpen).toBe(false);

    await expect(remote({
      action: 'answer-question', projectId: first.id, questionId: useStore.getState().projectManagers
        .find((project) => project.id === first.id)?.pendingUserQuestion?.id,
      optionId: 'keep', answer: '保留现有配置', source: 'feishu',
    })).resolves.toMatchObject({
      ok: true,
      session: { id: first.id, status: 'waiting', pendingUserQuestion: undefined },
      event: { kind: 'user-clarification-answered', payload: { answeredBy: 'feishu', optionId: 'keep' } },
    });
    await confirmAndResumeProject(first.id);
    await expect(remote({
      action: 'answer-question', projectId: first.id, optionId: 'replace', answer: '改为覆盖', source: 'desktop',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('没有待用户确认') });
    expect((globalThis.window as any).wmux.projectManager.appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user-clarification-requested',
      payload: expect.objectContaining({ question: expect.objectContaining({ question: '是否允许覆盖现有配置？' }) }),
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

  it('does not ask solely because optional draft fields were omitted for a specific goal', async () => {
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
      error: expect.stringContaining('alignment-confirm'),
    });
    expect(useStore.getState().projectManager?.pendingUserQuestion).toBeUndefined();
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

  it('only permits scoped manual intervention questions after initial alignment', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({
      action: 'start', projectDir: 'E:\\manual-question', goal: '实现认证模块',
      preconditions: ['测试环境可用'], doneWhen: ['认证测试通过'],
    });
    const session = useStore.getState().projectManager!;
    await confirmAndResumeProject(session.id);
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    await expect(request({
      action: 'user-question', callerSurfaceId: session.managerSurfaceId, projectId: session.id,
      question: '是否采用方案 A？',
      options: [{ id: 'a', label: '方案 A', description: '实现成本较低。' }, { id: 'b', label: '方案 B', description: '扩展性更高。' }],
      recommendedOptionId: 'a',
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('category=manual-intervention'),
    });

    useStore.getState().applyProjectManagerAction({
      type: 'create-work-item',
      workItem: {
        id: 'manual-check', title: '现场检查', status: 'waiting-decision', dependencies: [],
        attempts: 0, decisionsUsed: 0, updatedAt: 1, executionHistory: [],
        contract: {
          objective: '完成现场检查', description: '', preconditions: [],
          scope: { root: 'E:\\manual-question', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['现场检查完成'], validation: ['用户确认现场结果'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    }, session.id);
    await expect(request({
      action: 'user-question', callerSurfaceId: session.managerSurfaceId, projectId: session.id,
      category: 'manual-intervention', question: '请用户完成现场检查。',
      workItemId: 'manual-check', blocker: '必须由用户在设备旁确认指示灯状态',
      reasonCode: 'unsupported-reason',
      options: [
        { id: 'done', label: '已经完成', description: '现场操作已完成，可以继续项目。' },
        { id: 'blocked', label: '暂时无法完成', description: '保留阻塞并继续等待人工处理。' },
      ],
      recommendedOptionId: 'done',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('reasonCode') });

    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'manual-check', patch: { status: 'running' },
    }, session.id);
    await expect(request({
      action: 'user-question', callerSurfaceId: session.managerSurfaceId, projectId: session.id,
      category: 'manual-intervention', question: '项目内部执行链是否需要人工恢复？',
      context: '当前工作项仍标记运行中。', workItemId: 'manual-check',
      blocker: '任务暂时没有输出', reasonCode: 'internal-project-failure',
      options: [
        { id: 'retry', label: '恢复执行', description: '重新启动当前工作项的执行链。' },
        { id: 'pause', label: '保持暂停', description: '保留当前状态并暂不继续执行。' },
      ],
      recommendedOptionId: 'retry',
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('仅用于控制层确认全部执行链停止'),
    });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'manual-check', patch: { status: 'waiting-decision' },
    }, session.id);
    useStore.getState().openProjectManagerCreationDialog();
    expect(useStore.getState()).toMatchObject({
      projectManagerDialogOpen: true,
      projectManagerDialogView: 'create',
    });

    (globalThis.window as any).wmux.notification.fire.mockClear();
    await expect(request({
      action: 'user-question', callerSurfaceId: session.managerSurfaceId, projectId: session.id,
      category: 'manual-intervention', question: '请确认设备指示灯是否为绿色。',
      context: '终端 AI 无法观察实体设备。', workItemId: 'manual-check',
      blocker: '必须由用户在设备旁确认指示灯状态', reasonCode: 'physical-action',
      options: [
        { id: 'green', label: '指示灯为绿色', description: '现场状态正常，可以继续后续验证。' },
        { id: 'other', label: '不是绿色', description: '现场状态异常，项目保持暂停并重新诊断。' },
      ],
      recommendedOptionId: 'green',
    })).resolves.toMatchObject({
      ok: true,
      question: { category: 'manual-intervention', workItemId: 'manual-check', reasonCode: 'physical-action' },
    });
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: '项目需要你的处理',
    }));
    const attentionState = useStore.getState();
    const attentionWorkspace = attentionState.workspaces.find((workspace) => (
      workspace.id === attentionState.activeWorkspaceId
    ));
    const attentionSurface = attentionWorkspace?.splitTree.type === 'leaf'
      ? attentionWorkspace.splitTree.surfaces[attentionWorkspace.splitTree.activeSurfaceIndex]
      : undefined;
    expect(attentionState.projectManagerDialogOpen).toBe(false);
    expect(attentionState.projectManager?.id).toBe(session.id);
    expect(attentionSurface).toMatchObject({
      type: 'project-manager',
      projectManagerProjectId: session.id,
    });
  });

  it('rejects a business-choice question when the recommended technical route is already authorized by the main goal', async () => {
    const session = bindAuthorizedPiOptimizationProject('pm-authorized-pi-route');
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    await expect(request({
      action: 'user-question', callerSurfaceId: session.managerSurfaceId, projectId: session.id,
      category: 'manual-intervention', workItemId: 'task-a', reasonCode: 'business-choice',
      blocker: '既有 PI 在冻结电流点正式 run 中性能失败，需要切换下一技术路线。',
      question: '下一步采用哪种目标处理方式？',
      context: '失败 run 和安全停机证据已经保存。',
      options: [
        {
          id: 'pi-optimization', label: '调整 PI 后重新资格',
          description: '将当前 P=200/I=32 记录为未获资格，在相同设备、单一电流环和既有安全上限内冻结新的 PI 候选并重新验证；会更新完成条件，不进入速度环或位置环。',
        },
        {
          id: 'accept-failure', label: '以不可用结论收口',
          description: '停止参数探索并把未获资格作为最终结果。',
        },
      ],
      recommendedOptionId: 'pi-optimization',
    })).resolves.toMatchObject({
      ok: false,
      internalDecisionRequired: true,
      recommendedOptionId: 'pi-optimization',
      error: expect.stringContaining('属于项目 AI 的内部重规划责任'),
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === session.id)
      ?.pendingUserQuestion).toBeUndefined();
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === session.id)?.events)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'guard-triggered',
          payload: expect.objectContaining({ reason: 'authorized-technical-route-owned-by-project-ai' }),
        }),
      ]));

    await expect(request({
      action: 'user-question', callerSurfaceId: session.managerSurfaceId, projectId: session.id,
      category: 'manual-intervention', workItemId: 'task-a', reasonCode: 'business-choice',
      blocker: '只有放宽性能门槛才能把现有失败结果判为通过。',
      question: '是否改变项目验收标准？',
      context: '这会改变用户确认的通过条件。',
      options: [
        { id: 'relax', label: '放宽性能门槛', description: '降低验收标准并接受当前失败结果。' },
        { id: 'keep', label: '保持原标准', description: '不改变现有性能门槛。' },
      ],
      recommendedOptionId: 'relax',
    })).resolves.toMatchObject({
      ok: true,
      question: { reasonCode: 'business-choice', recommendedOptionId: 'relax' },
    });
  });

  it('withdraws a persisted authorized technical-route question and returns it to the project AI', async () => {
    const session = bindAuthorizedPiOptimizationProject('pm-persisted-authorized-pi-route');
    const store = useStore.getState();
    store.restoreProjectManager({
      ...session,
      status: 'waiting',
      pendingUserQuestion: {
        id: 'authorized-pi-route-question',
        category: 'manual-intervention',
        workItemId: 'task-a',
        blocker: '既有 PI 正式 run 性能失败，需要调整 PI 或停止路线。',
        reasonCode: 'business-choice',
        question: '下一步采用哪种目标处理方式？',
        context: '既有失败和安全停机证据均已保存。',
        options: [
          {
            id: 'pi-optimization', label: '调整 PI 后重新资格',
            description: '将当前 P=200/I=32 记录为未获资格，在相同设备、单一电流环和既有安全上限内冻结新的 PI 候选并重新验证；会更新完成条件，不进入速度环或位置环。',
          },
          { id: 'pause', label: '保持暂停', description: '等待新的用户方向。' },
        ],
        recommendedOptionId: 'pi-optimization',
        previousStatus: 'active',
        createdAt: 10,
      },
    });
    store.pauseSupervisorLane('lane-a', '旧项目 AI 将主目标内技术路线错误升级给用户');

    initPipeBridge();

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === session.id)).toMatchObject({
      status: 'active',
      pendingManagerDeliveries: [expect.objectContaining({
        text: expect.stringContaining('控制层已撤销越权用户提问'),
      })],
    }));
    const recovered = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
    expect(recovered?.pendingUserQuestion).toBeUndefined();
    expect(recovered?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user-clarification-invalidated',
        payload: expect.objectContaining({ reason: 'authorized-technical-route-owned-by-project-ai' }),
      }),
    ]));
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === 'lane-a'))
      .toMatchObject({ controlState: 'paused' });
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
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

  it('previews persisted projects without starting AI and restores them only after an explicit choice', async () => {
    const persisted: import('../../src/shared/project-manager').ProjectManagerSession = {
      id: 'pm-recover',
      projectDir: 'E:\\recover-project',
      goal: '继续上次项目',
      preconditions: ['环境安全'],
      planFiles: [],
      doneWhen: ['完成'],
      requirementsVersion: 1,
      acceptedRequirementsVersion: 1,
      executionProtocolVersion: 1,
      status: 'active',
      safeExit: {
        status: 'saved', requestedAt: 5, updatedAt: 20, completedAt: 20,
        reason: '测试安全退出恢复', terminalCheckpoints: [],
      },
      taskTerminalSurfaceId: 'old-worker',
      workItems: [{
        id: 'recover_task', title: '恢复任务', status: 'running', dependencies: [],
        requirementsVersion: 1,
        executionProtocolVersion: 1,
        baseline: {
          status: 'approved', requirementsVersion: 1, workspaceVersion: 'head:before-restart',
          evidence: '重启前已审核项目基线', approvedAt: 15,
        },
        workerSurfaceId: 'old-worker', supervisorLaneId: 'old-lane', attempts: 1, decisionsUsed: 2,
        startedAt: 12, updatedAt: 18, executionHistory: [],
        supervisorPlanRequired: true,
        supervisorPlan: {
          revision: 1,
          selectedRoute: '旧的细粒度恢复路线',
          milestones: [{
            id: 'old_micro_step', title: '旧微步骤', outcome: '执行一条旧指令', status: 'active',
          }],
          expectedPaths: [], targetedValidation: [], serializedBoundaries: [],
          remainingWork: ['继续旧微步骤'], updatedAt: 17,
        },
        latestContextSummary: '已完成核心实现，剩余针对性测试。',
        latestEvidence: 'review-recovery-evidence：src/core.ts 已修改并通过静态检查。',
        contract: {
          objective: '完成恢复任务', description: '从持久化检查点续作', preconditions: [],
          scope: { root: 'E:\\recover-project', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['针对性测试通过'], validation: ['检查 diff'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      }],
      agentConfig: {
        manager: { agent: 'codex', model: 'gpt-5.5', reasoningEffort: 'medium' },
        supervisor: { agent: 'pi', model: 'openai-codex/gpt-5.5', reasoningEffort: 'medium' },
        task: { agent: 'codex', model: 'gpt-5.5', reasoningEffort: 'medium' },
      },
      pendingUserQuestion: {
        id: 'question-stale-runtime', category: 'manual-intervention', workItemId: 'recover_task',
        blocker: '旧监督运行时已经失效', reasonCode: 'internal-project-failure',
        question: '是否按最新协议恢复旧监督链？', context: '旧运行时无法继续。',
        options: [{ id: 'retry', label: '恢复' }, { id: 'wait', label: '等待' }],
        recommendedOptionId: 'retry', previousStatus: 'active', createdAt: 19,
      },
      events: [{
        id: 'old-guard', sessionId: 'pm-recover', ts: 19, kind: 'guard-triggered',
        summary: '旧运行链没有后续处理者', payload: { attentionRequired: true },
      }],
      createdAt: 10,
      updatedAt: 20,
    };
    persisted.workItems[0].decisionsUsed = persisted.workItems[0].contract.budget.maxDecisions;
    persisted.workItems.push({
      ...persisted.workItems[0],
      id: 'recover_task_s1', title: '恢复任务的既有手工后继', status: 'paused',
      dependencies: ['recover_task'],
      workerSurfaceId: undefined, supervisorLaneId: undefined, startedAt: undefined,
      attempts: 0, decisionsUsed: 1, updatedAt: 20, executionHistory: [],
      latestBlocker: '等待恢复时迁移到当前协议',
    });
    persisted.workItems[1].contract = {
      ...persisted.workItems[1].contract,
      stopWhen: ['只读封存完成', '完成'],
      supervisorNotes: ['当前 baseline.status=investigating，不得发起第二次完整调查。'],
      budget: {
        ...DEFAULT_PROJECT_EXECUTION_BUDGET,
        maxDecisions: 4,
        maxContinuousMinutes: 30,
        maxAggregateWorkerMinutes: 30,
        maxIdenticalFailures: 1,
        maxNoProgressRounds: 1,
        maxTaskRetries: 1,
      },
    };
    persisted.events.push(
      {
        id: 'budget-guard', sessionId: 'pm-recover', ts: 20, kind: 'guard-triggered',
        workItemId: 'recover_task', summary: '旧工作项预算已耗尽',
        payload: { attentionRequired: false, budgetExhausted: true },
      },
      {
        id: 'manual-successor-created', sessionId: 'pm-recover', ts: 21, kind: 'work-item-created',
        workItemId: 'recover_task_s1', summary: '旧版本项目 AI 已建立手工后继',
      },
    );
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
    useStore.getState().setProjectSupervisorLanes([{
      ...useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a')!,
      id: 'old-lane',
      surfaceId: 'old-worker' as any,
      supervisorSurfaceId: 'old-supervisor' as any,
      projectManagerProjectId: persisted.id,
      projectWorkItemId: 'recover_task',
    }]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({ action: 'status' })).resolves.toMatchObject({
      ok: true, projects: [], recoveryChoice: 'pending',
    });
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.projectManagerTerminal)).toBe(false);

    await expect(remote({ action: 'recovery-candidates' })).resolves.toMatchObject({
      ok: true,
      recoveryChoice: 'pending',
      candidates: [{
        id: 'pm-recover', projectDir: 'E:\\recover-project', goal: '继续上次项目',
        executionProtocolVersion: 1, requiresProtocolMigration: true,
      }],
    });
    expect(useStore.getState().projectManagers).toEqual([]);
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.projectManagerTerminal)).toBe(false);

    const recoveredAgentConfig = {
      manager: { agent: 'grok', model: 'grok-4.6', reasoningEffort: 'high' },
      supervisor: { agent: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
      task: { agent: 'kimi', model: 'k3', reasoningEffort: 'on' },
    };
    const normalizedRecoveredAgentConfig = {
      ...recoveredAgentConfig,
      task: { ...recoveredAgentConfig.task, model: 'kimi-code/k3', reasoningEffort: '' },
    };
    await expect(remote({
      action: 'restore-projects', agentConfig: recoveredAgentConfig,
    })).resolves.toMatchObject({
      ok: true, restored: true, projects: [{ id: 'pm-recover' }],
      agentConfig: normalizedRecoveredAgentConfig,
    });
    expect(useStore.getState().workspacePrefs.projectManagementAgents).toEqual(normalizedRecoveredAgentConfig);
    expect(useStore.getState().projectManager).toMatchObject({
      id: 'pm-recover', managerSurfaceId: expect.any(String), recoveryState: 'checking',
      pendingUserQuestion: undefined,
      agentConfig: normalizedRecoveredAgentConfig,
      executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
      progressSync: { status: 'review-required' },
      taskTerminalSurfaceId: undefined,
      workItems: [
        expect.objectContaining({
          id: 'recover_task', status: 'stopped', workerSurfaceId: undefined,
          supervisorLaneId: undefined, startedAt: undefined,
          executionProtocolVersion: 1,
          attempts: 1, decisionsUsed: DEFAULT_PROJECT_EXECUTION_BUDGET.maxDecisions,
          supersededByWorkItemId: 'recover_task_s1',
          latestBlocker: expect.stringContaining('已冻结'),
          latestContextSummary: expect.stringContaining('核心实现'),
        }),
        expect.objectContaining({
          id: 'recover_task_s1', status: 'stopped',
          predecessorWorkItemId: 'recover_task', successionReason: 'budget-exhausted',
          supersededByWorkItemId: 'recover_task_s1-p6-s1',
          executionProtocolVersion: 1,
          attempts: 0, decisionsUsed: 1,
        }),
        expect.objectContaining({
          id: 'recover_task_s1-p6-s1', status: 'planned',
          predecessorWorkItemId: 'recover_task_s1', successionReason: 'protocol-migration',
          executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
          attempts: 0, decisionsUsed: 0, executionHistory: [],
          baseline: { status: 'required', requirementsVersion: 1 },
          supervisorPlan: undefined,
          supervisorPlanRequired: true,
          latestEvidence: expect.stringContaining('src/core.ts'),
          contract: expect.objectContaining({
            stopWhen: ['只读封存完成', '完成'],
            budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
          }),
        }),
      ],
    });
    expect(useStore.getState().projectManager?.workItems.find((item) => item.id === 'recover_task_s1-p6-s1')
      ?.contract.supervisorNotes).toEqual(expect.arrayContaining([
      expect.stringContaining('后继项目基线已重置为 required'),
      expect.stringContaining('粗阶段验收条件'),
    ]));
    expect(useStore.getState().supervisor.lanes.some((candidate) => (
      candidate.projectManagerProjectId === persisted.id
    ))).toBe(false);
    expect(useStore.getState().supervisor.lanes.some((candidate) => candidate.id === 'lane-a')).toBe(true);
    expect((globalThis.window as any).wmux.projectManager.appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'pm-recover',
      type: 'user-clarification-invalidated',
      payload: expect.objectContaining({ questionId: 'question-stale-runtime' }),
    }));
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.projectManagerTerminal)).toBe(true);
    const recoveredManagerSurface = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.id === useStore.getState().projectManager?.managerSurfaceId);
    expect(recoveredManagerSurface).toMatchObject({
      projectManagerAgent: 'grok',
      projectManagerModel: 'grok-4.6',
      projectManagerReasoningEffort: 'high',
    });
    expect((globalThis.window as any).wmux.projectManager.ensureSkill).toHaveBeenCalledWith('grok');
    expect(JSON.stringify(useStore.getState().projectManager?.pendingManagerDeliveries))
      .toContain('旧项目 AI、监督 AI、任务 AI 及其 surfaceId 都已失效');
    expect(JSON.stringify(useStore.getState().projectManager?.pendingManagerDeliveries))
      .toContain(`执行协议｜P${CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION}`);
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'execution-protocol-migrated' }),
    ]));

    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'progress-sync',
      callerSurfaceId: useStore.getState().projectManager?.managerSurfaceId,
      projectId: 'pm-recover',
      acknowledge: true,
      summary: '已核对当前工作树，保留核心实现并重新执行剩余针对性验证',
    })).resolves.toMatchObject({ ok: true });
    await expect(request({
      action: 'orientation-confirm',
      callerSurfaceId: useStore.getState().projectManager?.managerSurfaceId,
      projectId: 'pm-recover',
      requirementsVersion: useStore.getState().projectManager?.orientation?.requirementsVersion,
      authorizationVersion: useStore.getState().projectManager?.orientation?.authorizationVersion,
      snapshotFingerprint: useStore.getState().projectManager?.orientation?.snapshotFingerprint,
      requestedAt: useStore.getState().projectManager?.orientation?.requestedAt,
      summary: '已核对恢复记录、当前目录与待续任务，保留既有实现并重新验证',
      knownFacts: ['核心实现已有持久证据', '旧运行时绑定已经失效'],
      unknowns: ['当前工作树语义仍需新任务基线复核'],
      workItems: [{
        workItemId: 'recover_task_s1-p6-s1', disposition: 'verify',
        basis: '应用重启且目录存在新进度，不能沿用旧基线', nextAction: '由新监督建立当前工作树基线后续作',
      }],
    })).resolves.toMatchObject({
      ok: true,
      orientation: { status: 'ready' },
      recoverySupervisor: { ok: true, waitingForSupervisorTaskTerminal: true },
    });
    await expect(request({
      action: 'task-supervise',
      callerSurfaceId: useStore.getState().projectManager?.managerSurfaceId,
      projectId: 'pm-recover', workItemId: 'recover_task',
    })).resolves.toMatchObject({
      ok: false,
      workItemSuperseded: true,
      successorWorkItemId: 'recover_task_s1-p6-s1',
    });
    await expect(request({
      action: 'task-update',
      callerSurfaceId: useStore.getState().projectManager?.managerSurfaceId,
      projectId: 'pm-recover', workItemId: 'recover_task',
      patch: { executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION },
    })).resolves.toMatchObject({
      ok: false, workItemSuperseded: true, successorWorkItemId: 'recover_task_s1-p6-s1',
    });
    expect(useStore.getState().projectManager?.workItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'recover_task', status: 'stopped', executionProtocolVersion: 1,
        attempts: 1, decisionsUsed: DEFAULT_PROJECT_EXECUTION_BUDGET.maxDecisions,
        supersededByWorkItemId: 'recover_task_s1',
      }),
      expect.objectContaining({
        id: 'recover_task_s1', status: 'stopped', decisionsUsed: 1,
        predecessorWorkItemId: 'recover_task', supersededByWorkItemId: 'recover_task_s1-p6-s1',
      }),
      expect.objectContaining({
        id: 'recover_task_s1-p6-s1', status: 'running', supervisorLaneId: expect.any(String),
        executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
        attempts: 0, decisionsUsed: 0, executionHistory: [],
        baseline: { status: 'required', requirementsVersion: 1 },
        supervisorPlan: undefined,
        latestBlocker: undefined,
        latestEvidence: expect.stringContaining('src/core.ts'),
      }),
    ]));
    const { created, lane } = await startTaskThroughDedicatedSupervisor('pm-recover', 'recover_task_s1-p6-s1');
    const recoveredSurface = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.id === created.surfaceId);
    expect(recoveredSurface).toMatchObject({
      projectManagerProjectId: 'pm-recover', projectManagerWorkItemId: 'recover_task_s1-p6-s1',
      customTitle: 'Kimi直连 · 恢复任务的既有手工后继（续作）',
      startupCommands: ["kimi --model 'kimi-code/k3' # wmux-automated-agent-task"],
    });
    const recoveredSupervisorSurface = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.id === lane?.supervisorSurfaceId);
    expect(recoveredSupervisorSurface?.startupCommands?.[0]).toContain("--model 'gpt-5.6-terra'");
    expect(recoveredSupervisorSurface?.startupCommands?.[0]).toContain("model_reasoning_effort='high'");
    const recoveredLaunch = JSON.stringify({
      startupCommands: recoveredSurface?.startupCommands,
      startupInput: recoveredSurface?.startupInput,
    });
    expect(recoveredLaunch).toContain('项目任务 AI 冷启动');
    expect(recoveredLaunch).toContain('[项目执行身份｜控制层已绑定]');
    expect(recoveredLaunch).toContain('需求版本：R1');
    expect(recoveredLaunch).not.toContain('old-worker');
    const recoveryDeliveries = queuedControlText(lane?.id);
    expect(recoveryDeliveries).toContain('项目任务冷启动恢复包');
    expect(recoveryDeliveries).toContain('已完成核心实现');
    expect(recoveryDeliveries).toContain(
      '.wmux/supervisor/*/evidence/project/review-recovery-evidence.json',
    );
    expect(recoveryDeliveries).toContain('不得仅因新终端屏幕未显示旧事实');
    expect(recoveryDeliveries).not.toContain('用户恢复时设置的当前情况');
    consumeQueuedControlMessage(lane?.id);
    expect(lane?.surfaceId).toBe(created.surfaceId);
    expect(useStore.getState().projectManager?.workItems.find((item) => item.id === 'recover_task_s1-p6-s1')
      ?.workerSurfaceId).toBe(created.surfaceId);
    expect(useStore.getState().projectManager?.recoveryState).toBe('checking');
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      'worker-a': agentState,
      [created.surfaceId]: { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() },
    });
    surfaceTerminalRegistry.set(created.surfaceId, {
      buffer: {
        active: {
          baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => '' }),
        },
      },
    } as any);
    const decideRecovered = (globalThis.window as any).__wmux_supervisorDecide;
    const recoveryInvestigation = await Promise.resolve(decideRecovered({
      surfaceId: created.surfaceId,
      supervisorSurfaceId: lane?.supervisorSurfaceId,
      outcome: 'continue',
      reason: '建立恢复后的当前工作树基线',
      next: '[项目基线调查] 只读检查当前工作树、相关入口、测试约定和共享资源边界；以 [项目基线报告] 返回',
      executionAction: 'readonly-project-baseline',
    }));
    expect(recoveryInvestigation, JSON.stringify(recoveryInvestigation)).toMatchObject({ ok: true });
    await expect(Promise.resolve(decideRecovered({
      surfaceId: created.surfaceId,
      supervisorSurfaceId: lane?.supervisorSurfaceId,
      outcome: 'continue',
      reason: '审核恢复后的项目基线',
      next: '[批准项目基线] 当前工作树与恢复证据已核对，继续剩余验证',
      executionAction: 'approve-project-baseline',
      workspaceVersion: 'head:recovered,status:known',
      evidence: '已审核当前工作树、入口、测试约定、既有变更和恢复证据',
      stagePlanFile: '.wmux/tmp/recovery-plan.json',
      stagePlan: {
        selectedRoute: '沿恢复证据继续剩余验证',
        milestones: [{ id: 'finish_recovery', title: '完成恢复验证', outcome: '剩余验证形成可复核结论', status: 'active' }],
        expectedPaths: [],
        targetedValidation: [],
        serializedBoundaries: ['最终验证串行执行'],
        remainingWork: ['完成剩余验证'],
      },
    }))).resolves.toMatchObject({ ok: true });
    expect(useStore.getState().projectManager?.recoveryState).toBe('ready');
    expect(useStore.getState().projectManager?.safeExit).toBeUndefined();
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'recovery-restored', summary: expect.stringContaining('审核当前任务基线') }),
    ]));
    surfaceTerminalRegistry.delete(created.surfaceId);
  });

  it('reopens a baseline that was paused only because the task AI was still running', async () => {
    const persisted: ProjectManagerSession = {
      id: 'pm-transient-baseline-pause',
      projectDir: 'E:\\transient-baseline-pause',
      goal: '恢复误暂停的项目基线审核',
      preconditions: ['仅执行只读基线调查'],
      planFiles: [],
      doneWhen: ['项目基线获监督批准'],
      requirementsVersion: 1,
      authorizationVersion: 1,
      acceptedRequirementsVersion: 1,
      executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
      status: 'active',
      taskTerminalSurfaceId: 'old-worker',
      workItems: [{
        id: 'baseline_task',
        title: '核对项目基线',
        status: 'paused',
        dependencies: [],
        requirementsVersion: 1,
        authorizationVersion: 1,
        executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
        baseline: {
          status: 'investigating',
          requirementsVersion: 1,
          investigationRounds: 1,
          requestedAt: 15,
        },
        workerSurfaceId: 'old-worker',
        supervisorLaneId: 'old-lane',
        attempts: 1,
        decisionsUsed: 1,
        updatedAt: 18,
        executionHistory: [],
        latestBlocker: '任务终端当前仍在执行 fresh 恢复资格检查；尚未出现项目基线报告，需要等待可裁决检查点。',
        contract: {
          objective: '核对项目基线',
          description: '只读核对当前工作树与恢复证据',
          preconditions: [],
          scope: {
            root: 'E:\\transient-baseline-pause',
            allowPaths: [],
            denyPaths: [],
            forbiddenActions: [],
          },
          authority: {
            technicalChoices: true,
            lowRiskRetries: true,
            targetedTests: true,
            internalThreads: false,
            continuousExecution: false,
            continuationBoundary: 'project-owned-decision',
            permissionConfirm: false,
          },
          stopWhen: ['项目基线报告可供审核'],
          validation: ['检查基线报告'],
          budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      }],
      events: [],
      createdAt: 10,
      updatedAt: 20,
    };
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({ action: 'restore-projects' })).resolves.toMatchObject({
      ok: true,
      restored: true,
      projects: [{ id: persisted.id }],
    });

    expect(useStore.getState().projectManager).toMatchObject({
      id: persisted.id,
      recoveryState: 'checking',
      taskTerminalSurfaceId: undefined,
      workItems: [expect.objectContaining({
        id: 'baseline_task',
        status: 'planned',
        workerSurfaceId: undefined,
        supervisorLaneId: undefined,
        baseline: { status: 'required', requirementsVersion: 1 },
        latestBlocker: expect.stringContaining('不再等待旧检查点'),
      })],
    });
  });

  it('reopens a legacy completed goal whose own evidence still contains unverified work', async () => {
    const goalId = 'pm-invalid-completion-goal-1';
    const persisted: ProjectManagerSession = {
      id: 'pm-invalid-completion',
      projectDir: 'E:\\invalid-completion',
      goal: '完成双向实机与重复验证',
      preconditions: ['设备环境可用'],
      planFiles: [],
      doneWhen: ['双向实机验证完成', '三次重复一致性通过'],
      requirementsVersion: 1,
      authorizationVersion: 1,
      acceptedRequirementsVersion: 1,
      executionProtocolVersion: 5,
      activeGoalId: goalId,
      goals: [{
        id: goalId, sequence: 1, statement: '完成双向实机与重复验证',
        doneWhen: ['双向实机验证完成', '三次重复一致性通过'],
        status: 'achieved', requirementsVersion: 1, createdAt: 1, activatedAt: 2, closedAt: 20,
      }],
      subgoals: [{
        id: 'paper-conclusion', goalId, title: '结论文档', outcome: '整理已有结果',
        acceptance: ['记录现有证据'], dependencies: [], status: 'achieved',
        order: 1, createdAt: 3, updatedAt: 19,
        completion: {
          summary: '仅整理文件，未运行测试；其余实机与重复项未验证',
          validation: ['检查文档'], evidence: '无新增实机', completedAt: 19,
        },
      }],
      status: 'waiting',
      workItems: [],
      events: [{
        id: 'legacy-goal-complete', sessionId: 'pm-invalid-completion', ts: 20,
        kind: 'project-goal-completed', summary: '旧协议将目标标记完成',
        payload: { goalId, evidence: '已整理结论，但仍有未验证项' },
      }],
      createdAt: 1,
      updatedAt: 20,
    };
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({ action: 'restore-projects' })).resolves.toMatchObject({
      ok: true, restored: true,
    });

    expect(useStore.getState().projectManager).toMatchObject({
      id: persisted.id,
      status: 'active',
      executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
      goals: [expect.objectContaining({ id: goalId, status: 'active', closedAt: undefined })],
      subgoals: [expect.objectContaining({ id: 'paper-conclusion', status: 'blocked', completion: undefined })],
      events: expect.arrayContaining([
        expect.objectContaining({ kind: 'project-goal-completion-invalidated' }),
      ]),
    });
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

  it('saves progress, captures orphan project terminals, and confirms every PTY is closed on safe exit', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({
      action: 'start', projectDir: 'E:\\safe-exit', goal: '保存并恢复项目',
      preconditions: ['环境安全'], doneWhen: ['恢复后继续执行'],
    });
    const session = useStore.getState().projectManager!;
    await confirmAndResumeProject(session.id);
    expect(useStore.getState().applyProjectManagerAction({
      type: 'create-work-item',
      workItem: {
        id: 'checkpoint-task', title: '断点续作任务', status: 'running', dependencies: [],
        attempts: 0, decisionsUsed: 0, updatedAt: 1, executionHistory: [],
        executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
        supervisorPlanRequired: true,
        contract: {
          objective: '从安全退出断点继续', description: '', preconditions: [],
          scope: { root: 'E:\\safe-exit', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: {
            technicalChoices: true, lowRiskRetries: true, targetedTests: true,
            internalThreads: false, continuousExecution: false,
            continuationBoundary: 'project-owned-decision', permissionConfirm: false,
          },
          stopWhen: ['断点后的剩余验证完成'], validation: ['核对保存证据'],
          budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    }, session.id)).toMatchObject({ ok: true });
    approveProjectWorkItemBaseline(session.id, 'checkpoint-task');
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'checkpoint-task', patch: {
        status: 'running', decisionsUsed: 3, attempts: 1,
        latestEvidence: '安全退出前已形成的证据',
        supervisorPlan: {
          revision: 1, selectedRoute: '沿断点继续剩余验证',
          milestones: [{ id: 'resume-next', title: '继续下一动作', outcome: '剩余验证完成', status: 'active' }],
          expectedPaths: [], targetedValidation: ['npm test -- checkpoint'],
          serializedBoundaries: [], remainingWork: ['执行剩余定向验证'], updatedAt: 2,
        },
      },
    }, session.id);
    const workspace = useStore.getState().workspaces.find((candidate) => (
      candidate.splitTree.type === 'leaf'
      && candidate.splitTree.surfaces.some((surface) => surface.id === session.managerSurfaceId)
    ))!;
    const paneId = workspace.splitTree.type === 'leaf' ? workspace.splitTree.paneId : '' as any;
    const orphanSurfaceId = useStore.getState().addSurface(workspace.id, paneId, 'terminal', {
      customTitle: '孤立项目任务 AI', projectManagerProjectId: session.id,
      projectManagerWorkItemId: 'orphan-task', shell: 'pwsh.exe', cwd: session.projectDir,
    })!;
    const hiddenPtySurfaceId = 'hidden-project-pty';
    const checkpointSession = useStore.getState().projectManagers
      .find((candidate) => candidate.id === session.id)!;
    useStore.getState().restoreProjectManager({
      ...checkpointSession,
      safeExit: {
        status: 'blocked', requestedAt: 1, updatedAt: 1, reason: '上次关闭未确认',
        terminalCheckpoints: [{
          surfaceId: hiddenPtySurfaceId, role: 'task-ai', label: '已脱离 UI 的任务 AI',
          activityState: 'unknown', inputState: 'unknown',
        }],
      },
    });
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [session.managerSurfaceId!]: { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: 2 },
      [orphanSurfaceId]: { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: 2 },
    });
    for (const surfaceId of [session.managerSurfaceId!, orphanSurfaceId]) {
      surfaceTerminalRegistry.set(surfaceId, {
        buffer: {
          active: {
            baseY: 0, cursorX: 0, cursorY: 0, length: 1,
            getLine: () => ({ translateToString: () => '' }),
          },
        },
      } as any);
    }
    const kill = vi.fn();
    (globalThis.window as any).wmux.pty.kill = kill;
    (globalThis.window as any).wmux.pty.has = vi.fn(async () => false);

    await expect(remote({
      action: 'save-and-exit', projectId: session.id, reason: '用户保存当前项目进度',
    })).resolves.toMatchObject({ ok: true, safeExited: true });

    expect(useStore.getState().projectManager).toMatchObject({
      status: 'paused', recoveryState: 'checking', managerSurfaceId: undefined,
      taskTerminalSurfaceId: undefined,
      safeExit: {
        status: 'saved',
        terminalCheckpoints: expect.arrayContaining([
          expect.objectContaining({ surfaceId: session.managerSurfaceId, role: 'project-ai' }),
          expect.objectContaining({ surfaceId: orphanSurfaceId, role: 'task-ai', workItemId: 'orphan-task' }),
          expect.objectContaining({ surfaceId: hiddenPtySurfaceId, role: 'task-ai' }),
        ]),
      },
      workItems: [expect.objectContaining({
        id: 'checkpoint-task', status: 'running', decisionsUsed: 3, attempts: 1,
        baseline: expect.objectContaining({ status: 'approved' }),
        latestEvidence: '安全退出前已形成的证据',
        supervisorPlan: expect.objectContaining({
          selectedRoute: '沿断点继续剩余验证', remainingWork: ['执行剩余定向验证'],
        }),
      })],
    });
    expect(kill).toHaveBeenCalledWith(session.managerSurfaceId);
    expect(kill).toHaveBeenCalledWith(orphanSurfaceId);
    expect(kill).toHaveBeenCalledWith(hiddenPtySurfaceId);
    expect((globalThis.window as any).wmux.pty.has).toHaveBeenCalledWith(session.managerSurfaceId);
    expect((globalThis.window as any).wmux.pty.has).toHaveBeenCalledWith(orphanSurfaceId);
    expect((globalThis.window as any).wmux.pty.has).toHaveBeenCalledWith(hiddenPtySurfaceId);
    expect(useStore.getState().workspaces.flatMap((candidate) => (
      candidate.splitTree.type === 'leaf' ? candidate.splitTree.surfaces : []
    )).some((surface) => (
      surface.projectManagerProjectId === session.id || surface.projectSupervisorProjectId === session.id
    ))).toBe(false);
    expect((globalThis.window as any).wmux.projectManager.appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id, type: 'project-safe-exit-completed',
    }));
    const appendRecord = (globalThis.window as any).wmux.projectManager.appendRecord;
    const completionIndex = appendRecord.mock.calls.findIndex((call: any[]) => (
      call[0]?.type === 'project-safe-exit-completed'
    ));
    expect(Math.max(...(globalThis.window as any).wmux.pty.has.mock.invocationCallOrder))
      .toBeLessThan(appendRecord.mock.invocationCallOrder[completionIndex]);
    surfaceTerminalRegistry.delete(session.managerSurfaceId!);
    surfaceTerminalRegistry.delete(orphanSurfaceId);
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

    await expect(remote({
      action: 'save-and-exit', projectId: session.id, reason: '保存漏失 Stop 的安全断点',
    })).resolves.toMatchObject({ ok: true, safeExited: true });
    expect(kill).toHaveBeenCalledWith(managerSurfaceId);
    expect(useStore.getState().projectManager).toMatchObject({
      safeExit: {
        status: 'saved',
        terminalCheckpoints: [expect.objectContaining({
          surfaceId: managerSurfaceId, activityState: 'idle', inputState: 'empty',
        })],
      },
    });
    surfaceTerminalRegistry.delete(managerSurfaceId);
  });

  it.each([
    { label: 'matching', restoredFingerprint: 'test-progress', expectedBaseline: 'approved', expectedOrientation: 'ready' },
    { label: 'changed', restoredFingerprint: 'changed-after-safe-exit', expectedBaseline: 'required', expectedOrientation: 'required' },
  ])('restores a $label safe-exit checkpoint without confusing runtime rebuild with project progress', async ({
    restoredFingerprint, expectedBaseline, expectedOrientation,
  }) => {
    const project = bindProjectLaneToWorkItem({
      projectId: `pm-safe-checkpoint-${expectedBaseline}`, continuousExecution: true,
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
        decisionsUsed: 3,
        attempts: 1,
        latestEvidence: '断点前已验证的证据',
        supervisorPlanRequired: true,
        supervisorPlan: {
          revision: 1, selectedRoute: '从断点后的下一动作继续',
          milestones: [{ id: 'next-action', title: '执行下一动作', outcome: '剩余验证完成', status: 'active' }],
          expectedPaths: [], targetedValidation: ['npm test -- checkpoint'],
          serializedBoundaries: [], remainingWork: ['执行剩余验证'], updatedAt: 15,
        },
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
        baseline: expect.objectContaining({ status: expectedBaseline }),
        decisionsUsed: 3,
        attempts: 1,
        latestEvidence: '断点前已验证的证据',
        supervisorPlan: expect.objectContaining({
          selectedRoute: '从断点后的下一动作继续',
          remainingWork: ['执行剩余验证'],
        }),
      })],
    });
    if (expectedBaseline === 'approved') {
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
        status: 'waiting-decision', baseline: expect.objectContaining({ status: 'required' }),
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
        terminalCheckpoints: [expect.objectContaining({
          surfaceId: session.managerSurfaceId, inputState: 'pending',
        })],
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

  it('safely replaces only the project-manager runtime after its project-mode launch configuration changes', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-configured-project' as any,
      title: '配置测试项目',
      cwd: 'E:\\configured-repo',
      splitTree: {
        type: 'leaf', paneId: 'pane-configured' as any, activeSurfaceIndex: 0,
        surfaces: [{ id: 'configured-worker' as any, type: 'terminal', shell: 'pwsh.exe' }],
      },
    }]);
    await remote({
      action: 'start', projectDir: 'E:\\configured-repo', goal: '验证配置换代', preconditions: ['无额外物理前置条件'], doneWhen: ['配置生效'],
    });
    await confirmAndResumeProject(useStore.getState().projectManager!.id);
    const before = useStore.getState().projectManager?.managerSurfaceId;
    useStore.getState().setWorkspacePrefs({
      projectManagementAgents: {
        manager: { agent: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
        supervisor: { agent: 'pi', model: 'openai-codex/gpt-5.6-terra', reasoningEffort: 'max' },
        task: { agent: 'kimi', model: 'k3', reasoningEffort: 'on' },
      },
    });

    await expect(remote({ action: 'configure-agents', restartManager: true })).resolves.toMatchObject({
      ok: true,
      restarted: true,
    });

    const runtimes = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf'
        ? workspace.splitTree.surfaces.filter((surface) => surface.projectManagerTerminal)
        : []
    ));
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]).toMatchObject({
      projectManagerAgent: 'codex',
      projectManagerModel: 'gpt-5.6-sol',
      projectManagerReasoningEffort: 'high',
      startupCommands: [expect.stringMatching(/^codex --model 'gpt-5\.6-sol' --config model_reasoning_effort='high' -- /)],
    });
    expect(runtimes[0].id).not.toBe(before);
    expect(useStore.getState().projectManager?.managerSurfaceId).toBe(runtimes[0].id);
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'manager-runtime-restarted' }),
    ]));

    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    const projectId = useStore.getState().projectManager!.id;
    await expect(request({
      action: 'task-create',
      callerSurfaceId: runtimes[0].id,
      projectId,
      workItem: {
        id: 'configured_task', title: '配置任务', status: 'planned', dependencies: [],
        contract: {
          objective: '按配置启动任务终端', description: '', preconditions: [],
          scope: { root: 'E:\\configured-repo', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['配置生效'], validation: ['检查运行配置'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    })).resolves.toMatchObject({ ok: true });
    const { created, lane } = await startTaskThroughDedicatedSupervisor(projectId, 'configured_task');
    const taskSurface = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.id === created.surfaceId);
    expect(taskSurface).toMatchObject({
      customTitle: 'Kimi直连 · 配置任务',
      startupCommands: ["kimi --model 'kimi-code/k3' # wmux-automated-agent-task"],
      startupInput: expect.stringContaining('项目任务 AI 冷启动'),
    });
    const supervisorSurface = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.id === lane?.supervisorSurfaceId);
    expect(supervisorSurface?.startupCommands?.[0]).toContain("--model 'openai-codex/gpt-5.6-terra'");
  });

  it('reuses only the project-owned supervisor chain for a later work item', async () => {
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().resetOrdinarySupervisorSession();
    useStore.getState().patchSupervisor({
      supervisorLaunchCmd: 'grok',
      supervisorModel: 'ordinary-model',
      supervisorReasoningEffort: 'ordinary-effort',
      workScope: 'task-files',
      autonomyPermissions: ['technical-choice'],
      forbiddenActions: ['external-network'],
    });
    const ordinarySettings = {
      supervisorLaunchCmd: useStore.getState().supervisor.supervisorLaunchCmd,
      supervisorModel: useStore.getState().supervisor.supervisorModel,
      supervisorReasoningEffort: useStore.getState().supervisor.supervisorReasoningEffort,
      workScope: useStore.getState().supervisor.workScope,
      autonomyPermissions: useStore.getState().supervisor.autonomyPermissions,
      forbiddenActions: useStore.getState().supervisor.forbiddenActions,
    };
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'start', projectDir: 'E:\\sequential-project', goal: '顺序完成两个任务',
      preconditions: ['无额外物理前置条件'], doneWhen: ['两个任务完成'],
    })).resolves.toMatchObject({ ok: true });
    const projectId = useStore.getState().projectManager!.id;
    await confirmAndResumeProject(projectId);
    const managerSurfaceId = useStore.getState().projectManager?.managerSurfaceId;
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    const workItem = (id: string, dependencies: string[] = []) => ({
      id, title: id, status: 'planned', dependencies,
      contract: {
        objective: `完成 ${id}`, description: '', preconditions: [],
        scope: { root: 'E:\\sequential-project', allowPaths: [], denyPaths: [], forbiddenActions: [] },
        authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
        stopWhen: [`${id} 完成`], validation: [`验证 ${id}`], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      },
    });
    await expect(request({
      action: 'task-create', callerSurfaceId: managerSurfaceId, projectId,
      workItem: workItem('first_task'),
    })).resolves.toMatchObject({ ok: true });
    const first = await startTaskThroughDedicatedSupervisor(projectId, 'first_task');
    consumeQueuedControlMessage(first.lane?.id);
    expect(useStore.getState().supervisor).toMatchObject(ordinarySettings);
    const projectSupervisorWorkspace = useStore.getState().workspaces.find((workspace) => (
      workspace.splitTree.type === 'leaf'
      && workspace.splitTree.surfaces.some((surface) => surface.id === managerSurfaceId)
    ));
    const projectSupervisorSurfaces = projectSupervisorWorkspace?.splitTree.type === 'leaf'
      ? projectSupervisorWorkspace.splitTree.surfaces
      : [];
    expect(projectSupervisorWorkspace).toBeTruthy();
    expect(projectSupervisorWorkspace?.title).toContain(`${PROJECT_MANAGER_WORKSPACE_TITLE} ·`);
    expect(projectSupervisorWorkspace?.cwd).toBe('E:\\sequential-project');
    expect(projectSupervisorWorkspace?.splitTree.type === 'leaf'
      ? projectSupervisorWorkspace.splitTree.surfaces[projectSupervisorWorkspace.splitTree.activeSurfaceIndex]
      : undefined).toMatchObject({
      id: first.created.surfaceId,
      projectManagerProjectId: projectId,
      projectManagerWorkItemId: 'first_task',
    });
    expect(useStore.getState().activeWorkspaceId).toBe(projectSupervisorWorkspace?.id);
    expect(projectSupervisorSurfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: managerSurfaceId,
        projectManagerTerminal: true,
        projectManagerProjectId: projectId,
      }),
      expect.objectContaining({ type: 'supervisor', projectSupervisorProjectId: projectId }),
      expect.objectContaining({
        id: first.lane?.supervisorSurfaceId,
        transientSupervisor: true,
        projectSupervisorProjectId: projectId,
      }),
      expect.objectContaining({
        id: first.created.surfaceId,
        projectManagerProjectId: projectId,
        projectManagerWorkItemId: 'first_task',
      }),
    ]));
    expect(useStore.getState().supervisor.supervisorWorkspaceId).not.toBe(projectSupervisorWorkspace?.id);
    approveProjectWorkItemBaseline(projectId, 'first_task');
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'first_task', patch: {
        status: 'validating',
        supervisorPlan: {
          revision: 1,
          selectedRoute: '完成第一阶段并复核验证证据',
          milestones: [{
            id: 'finish_first', title: '完成第一阶段', outcome: '第一阶段验证通过',
            status: 'completed', evidence: '第一项验证通过',
          }],
          expectedPaths: [], targetedValidation: [], serializedBoundaries: [], remainingWork: [],
          updatedAt: Date.now(),
        },
      },
    }, projectId);
    await expect(request({
      action: 'task-update', callerSurfaceId: managerSurfaceId, projectId,
      workItemId: 'first_task', patch: { status: 'completed', latestEvidence: '第一项验证通过' },
    })).resolves.toMatchObject({ ok: true });
    useStore.getState().confirmStopCondition(first.lane!.id);
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === first.lane?.id))
      .toMatchObject({ controlState: 'waiting', stopConfirmed: true });
    await expect(request({
      action: 'task-create', callerSurfaceId: managerSurfaceId, projectId,
      workItem: workItem('second_task', ['first_task']),
    })).resolves.toMatchObject({ ok: true });
    useStore.getState().appendProjectManagerEvent({
      kind: 'requirements-quiesce-failed', workItemId: 'first_task',
      summary: '旧任务终端未确认中断', payload: { laneId: first.lane?.id },
    }, projectId);
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      [first.created.surfaceId]: agentState,
    });
    agentState = { state: 'working', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() };
    await expect(request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId, projectId, workItemId: 'second_task',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('未确认中断') });
    agentState = { state: 'idle', blockedReason: null, blockedVersion: 0, updatedAt: Date.now() };
    await expect(request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId, projectId, workItemId: 'second_task',
    })).resolves.toMatchObject({ ok: true, reused: true, laneId: first.lane?.id });
    consumeQueuedControlMessage(first.lane?.id);

    const projectLanes = useStore.getState().supervisor.lanes.filter((lane) => lane.projectManagerProjectId === projectId);
    expect(projectLanes).toHaveLength(1);
    expect(projectLanes[0]).toMatchObject({
      id: first.lane?.id,
      supervisorSurfaceId: first.lane?.supervisorSurfaceId,
      surfaceId: first.created.surfaceId,
      projectWorkItemId: 'second_task',
      controlState: 'active',
      stopConfirmed: false,
    });
    expect(useStore.getState().projectManager?.workItems.find((item) => item.id === 'second_task'))
      .toMatchObject({ workerSurfaceId: first.created.surfaceId, supervisorLaneId: first.lane?.id });
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'requirements-quiesced', payload: expect.objectContaining({ recoveredAfterFailure: true }) }),
    ]));

    approveProjectWorkItemBaseline(projectId, 'second_task');
    await expect(request({
      action: 'task-update', callerSurfaceId: managerSurfaceId, projectId,
      workItemId: 'second_task', patch: {
        status: 'paused',
        latestContextSummary: '执行身份暂不可用，已保留现有证据等待后续恢复。',
        latestBlocker: '缺少外部执行身份，但不阻塞独立工作项。',
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(request({
      action: 'task-create', callerSurfaceId: managerSurfaceId, projectId,
      workItem: workItem('blocked_by_paused', ['second_task']),
    })).resolves.toMatchObject({ ok: true });
    await expect(request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId, projectId, workItemId: 'blocked_by_paused',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('依赖任务尚未完成') });
    await expect(request({
      action: 'task-create', callerSurfaceId: managerSurfaceId, projectId,
      workItem: workItem('independent_task'),
    })).resolves.toMatchObject({ ok: true });
    await expect(request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId, projectId, workItemId: 'independent_task',
    })).resolves.toMatchObject({ ok: true, reused: true, laneId: first.lane?.id });

    expect(useStore.getState().projectManager?.workItems.find((item) => item.id === 'second_task'))
      .toMatchObject({
        status: 'paused', workerSurfaceId: undefined, supervisorLaneId: undefined,
        baseline: { status: 'required' },
      });
    expect(useStore.getState().projectManager?.workItems.find((item) => item.id === 'independent_task'))
      .toMatchObject({ status: 'running', workerSurfaceId: first.created.surfaceId, supervisorLaneId: first.lane?.id });
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === first.lane?.id))
      .toMatchObject({ projectWorkItemId: 'independent_task', surfaceId: first.created.surfaceId });
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.id === first.created.surfaceId)).toMatchObject({
      projectManagerProjectId: projectId,
      projectManagerWorkItemId: 'independent_task',
    });
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'supervisor-direction',
        workItemId: 'second_task',
        summary: expect.stringContaining('暂缓工作项并释放执行链'),
      }),
    ]));
  });

  it('does not resume an old-goal supervisor lane before the new goal is explicitly dispatched', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'start', projectDir: 'E:\\goal-pivot', goal: '完成旧目标',
      preconditions: ['测试环境可用'], doneWhen: ['旧目标验收通过'],
    })).resolves.toMatchObject({ ok: true });
    const projectId = useStore.getState().projectManager!.id;
    await confirmAndResumeProject(projectId);
    const managerSurfaceId = useStore.getState().projectManager?.managerSurfaceId;
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'task-create', callerSurfaceId: managerSurfaceId, projectId,
      workItem: {
        id: 'old_goal_task', title: '旧目标任务', status: 'planned', dependencies: [],
        contract: {
          objective: '执行旧目标', description: '', preconditions: [],
          scope: { root: 'E:\\goal-pivot', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['旧目标完成'], validation: ['检查旧目标结果'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    })).resolves.toMatchObject({ ok: true });
    const running = await startTaskThroughDedicatedSupervisor(projectId, 'old_goal_task');

    await expect(remote({
      action: 'update-definition', projectId, goal: '完成新目标', mode: 'pivot',
      preconditions: ['测试环境可用'], doneWhen: ['新目标验收通过'], reason: '用户切换主目标',
    })).resolves.toMatchObject({ ok: true });
    await expect(request({
      action: 'alignment-confirm', callerSurfaceId: managerSurfaceId, projectId,
      goalUnderstanding: '按新目标交付可验收结果', scopeSummary: '仅处理当前项目目录',
      acceptanceSummary: '新目标验收通过', reason: '新目标、范围和验收已经明确',
    })).resolves.toMatchObject({ ok: true });
    await confirmProjectOrientation(projectId);
    await expect(request({
      action: 'goal-plan', callerSurfaceId: managerSurfaceId, projectId,
      subgoals: [{
        id: 'new_goal_stage', title: '新目标阶段', outcome: '形成新目标结果',
        acceptance: ['新目标验收通过'], dependencies: [], status: 'planned',
      }],
    })).resolves.toMatchObject({ ok: true });
    await expect(request({
      action: 'resume', callerSurfaceId: managerSurfaceId, projectId, reason: '新目标计划已建立',
    })).resolves.toMatchObject({ ok: true });

    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === running.lane?.id))
      .toMatchObject({ controlState: 'paused', projectWorkItemId: 'old_goal_task' });
    expect(useStore.getState().projectManager?.workItems.find((item) => item.id === 'old_goal_task'))
      .toMatchObject({ status: 'stopped' });
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
      expect(workspace?.title).toContain(`${PROJECT_MANAGER_WORKSPACE_TITLE} ·`);
      expect(workspace?.splitTree.type === 'leaf'
        ? workspace.splitTree.surfaces.some((surface) => (
          surface.projectManagerProjectId === session.id
          && surface.projectManagerTerminal === true
        ))
        : false).toBe(true);
    }
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

  it('replaces one project direction through the UI bridge and accepts later manager revisions', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    const firstStart = await remote({
      action: 'start', projectDir: 'E:\\direction-a', goal: '旧方向 A',
      preconditions: ['旧前置条件'], doneWhen: ['旧验收'],
    });
    await remote({
      action: 'start', projectDir: 'E:\\direction-b', goal: '保持方向 B',
      preconditions: ['环境可用'], doneWhen: ['B 验收'],
    });
    const firstId = firstStart.session.id;
    useStore.getState().applyProjectManagerAction({
      type: 'create-work-item',
      workItem: {
        id: 'obsolete-task', title: '旧工作', status: 'planned', dependencies: [],
        contract: {
          objective: '实现旧方向', description: '', preconditions: [],
          scope: { root: 'E:\\direction-a', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['完成'], validation: ['检查'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    }, firstId);

    await expect(remote({
      action: 'update-definition',
      projectId: firstId,
      goal: '全新方向 A',
      preconditions: ['新资源到位'],
      planFiles: [],
      doneWhen: ['新方向验收'],
      mode: 'pivot',
      reason: '用户清除旧目标',
    })).resolves.toMatchObject({
      ok: true,
      event: { kind: 'project-definition-updated', payload: { mode: 'pivot' } },
    });
    expect(useStore.getState().projectManagers.find((project) => project.id === firstId)).toMatchObject({
      goal: '全新方向 A',
      status: 'waiting',
      workItems: [{ id: 'obsolete-task', status: 'stopped' }],
    });
    expect(useStore.getState().projectManagers.find((project) => project.projectDir === 'E:\\direction-b'))
      .toMatchObject({ goal: '保持方向 B', status: 'waiting' });

    const managerSurfaceId = useStore.getState().projectManagers.find((project) => project.id === firstId)?.managerSurfaceId;
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'update-definition', callerSurfaceId: managerSurfaceId, projectId: firstId,
      goal: '不应写入的目标', mode: 'overwrite',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('refine') });
    await expect(request({
      action: 'update-definition',
      callerSurfaceId: managerSurfaceId,
      projectId: firstId,
      doneWhen: ['新方向验收', '回归测试通过'],
      mode: 'refine',
      reason: '根据用户确认补充验收条件',
    })).resolves.toMatchObject({
      ok: true,
      event: { payload: { source: 'manager', mode: 'refine' } },
    });
    expect(useStore.getState().projectManagers.find((project) => project.id === firstId)?.doneWhen)
      .toEqual(['新方向验收', '回归测试通过']);
    expect((globalThis.window as any).wmux.projectManager.saveSession).toHaveBeenCalled();
    expect((globalThis.window as any).wmux.projectManager.appendRecord).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'project-definition-updated' }),
    );
  });

  it('rotates an overlong task terminal while preserving the project supervisor lane', async () => {
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().resetOrdinarySupervisorSession();
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-rotation' as any,
      title: '轮换项目',
      cwd: 'E:\\rotation',
      splitTree: {
        type: 'leaf', paneId: 'pane-rotation' as any, activeSurfaceIndex: 0,
        surfaces: [{ id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', customTitle: '原任务终端' }],
      },
    }]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'start', projectDir: 'E:\\rotation', goal: '完成轮换项目',
      preconditions: ['设备已断电并确认安全'],
      supervisorNotes: ['阶段完成后让任务 AI 同步文档'],
      doneWhen: ['测试通过'],
    })).resolves.toMatchObject({ ok: true });
    await confirmAndResumeProject(useStore.getState().projectManager!.id);
    const managerSurfaceId = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.projectManagerTerminal)?.id;
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'task-create', callerSurfaceId: managerSurfaceId,
      workItem: {
        id: 'rotation_task', title: '轮换任务', status: 'planned', dependencies: [],
        contract: {
          objective: '继续既有实现', description: '', preconditions: [],
          supervisorNotes: ['形成可回滚成果后创建本地提交'],
          scope: { root: 'E:\\rotation', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['测试通过'], validation: ['运行相关测试'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    })).resolves.toMatchObject({ ok: true });
    useStore.getState().setWorkspacePrefs({
      projectManagementAgents: {
        ...DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
        supervisor: { agent: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
      },
    });
    const projectId = useStore.getState().projectManager!.id;
    await expect(remote({
      action: 'configure-agents', projectId,
      agentConfig: useStore.getState().workspacePrefs.projectManagementAgents,
    })).resolves.toMatchObject({ ok: true });
    const { created: initialTask, lane: previousLane } = await startTaskThroughDedicatedSupervisor(projectId, 'rotation_task');
    expect(previousLane?.surfaceId).toBe(initialTask.surfaceId);
    expect(previousLane?.surfaceId).not.toBe('worker-a');
    expect(previousLane?.config?.preconditions).toContain('设备已断电并确认安全');
    expect(previousLane?.config?.supervisorNotes).toBe([
      '阶段完成后让任务 AI 同步文档',
      '形成可回滚成果后创建本地提交',
    ].join('\n'));
    expect(effectiveSupervisorAutonomyPermissions(
      useStore.getState().supervisor,
      previousLane!,
    )).not.toContain('permission-confirm');
    const supervisorBriefings = queuedControlText(previousLane?.id);
    expect(supervisorBriefings).toContain('[项目级前置条件｜已确认且持续有效]');
    expect(supervisorBriefings).toContain('不得每一步重新询问、重新授权或要求重复取证');
    expect(supervisorBriefings).toContain('注意事项（监督检查点提醒）');
    expect(supervisorBriefings).toContain('形成可回滚成果后创建本地提交');
    const supervisorSurface = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.id === previousLane?.supervisorSurfaceId);
    expect(supervisorSurface?.startupCommands?.[0]).toContain('\\supervisor\\runtime\\');
    expect(supervisorSurface?.startupCommands?.[0]).toContain(
      "$env:WMUX_SUPERVISOR_PROJECT_DIR = 'E:\\rotation'",
    );
    expect(supervisorSurface?.startupCommands?.[0]).toContain(
      "; try { codex --model 'gpt-5.6-terra' --config model_reasoning_effort='high' } finally { exit",
    );

    await expect(remote({
      action: 'update-preconditions',
      projectId: useStore.getState().projectManager?.id,
      preconditions: ['设备现已接入受控电源', '断电保护已经人工验证'],
    })).resolves.toMatchObject({ ok: true, event: { kind: 'project-preconditions-updated' } });
    expect(useStore.getState().projectManager?.preconditions).toEqual([
      '设备现已接入受控电源', '断电保护已经人工验证',
    ]);
    expect(useStore.getState().projectManager).toMatchObject({
      status: 'waiting', requirementsVersion: 2, acceptedRequirementsVersion: 1,
      workItems: [{ id: 'rotation_task', status: 'waiting-decision' }],
    });
    expect(useStore.getState().projectManager?.events).toContainEqual(expect.objectContaining({
      kind: 'requirements-quiesce-failed',
      workItemId: 'rotation_task',
    }));
    await expect(remote({
      action: 'resume', projectId: useStore.getState().projectManager?.id,
      reason: '用户尝试直接恢复',
    })).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('项目管理 AI 重新规划'),
    });
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === previousLane?.id)?.config?.preconditions)
      .toContain('断电保护已经人工验证');
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === previousLane?.id)?.controlState)
      .toBe('paused');

    await expect(request({
      action: 'task-update', callerSurfaceId: managerSurfaceId,
      projectId: useStore.getState().projectManager?.id,
      workItemId: 'rotation_task',
      patch: {
        status: 'planned',
        latestBlocker: '',
        rebindCurrentRequirements: true,
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(request({
      action: 'alignment-confirm', callerSurfaceId: managerSurfaceId,
      projectId: useStore.getState().projectManager?.id,
      goalUnderstanding: '继续完成当前轮换项目', scopeSummary: '仅限当前轮换项目目录和已绑定设备',
      acceptanceSummary: '按更新后的前置条件完成测试', reason: '新前置条件、授权边界和验收均已明确',
    })).resolves.toMatchObject({ ok: true });
    await confirmProjectOrientation(projectId);
    await expect(request({
      action: 'resume', callerSurfaceId: managerSurfaceId,
      projectId: useStore.getState().projectManager?.id,
      reason: '项目管理 AI 已按新前置条件完成重新规划',
    })).resolves.toMatchObject({ ok: true });

    const rotationRequested = await request({
      action: 'terminal-rotate', callerSurfaceId: managerSurfaceId,
      projectId: useStore.getState().projectManager?.id,
      summary: '已完成核心实现；下一步只需运行相关测试并检查 diff。',
    });
    expect(rotationRequested).toMatchObject({ ok: true, pending: true, laneId: previousLane?.id });
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.id === initialTask.surfaceId)).toBe(true);
    const rotated = await request({
      action: 'task-terminal-rotate', callerSurfaceId: previousLane?.supervisorSurfaceId,
      projectId: useStore.getState().projectManager?.id,
      workItemId: 'rotation_task',
    });
    expect(rotated).toMatchObject({ ok: true, oldSurfaceId: initialTask.surfaceId, surfaceId: expect.any(String) });
    const reboundLane = useStore.getState().supervisor.lanes.find((lane) => lane.id === previousLane?.id);
    expect(reboundLane?.surfaceId).not.toBe(initialTask.surfaceId);
    const rotatedTaskWorkspace = useStore.getState().workspaces.find((workspace) => (
      workspace.splitTree.type === 'leaf'
      && workspace.splitTree.surfaces.some((surface) => surface.id === reboundLane?.surfaceId)
    ));
    const rotatedSupervisorWorkspace = useStore.getState().workspaces.find((workspace) => (
      workspace.splitTree.type === 'leaf'
      && workspace.splitTree.surfaces.some((surface) => surface.id === reboundLane?.supervisorSurfaceId)
    ));
    expect(rotatedTaskWorkspace?.id).toBe(rotatedSupervisorWorkspace?.id);
    expect(useStore.getState().projectManager?.workItems[0]).toMatchObject({
      workerSurfaceId: reboundLane?.surfaceId,
      latestContextSummary: expect.stringContaining('已完成核心实现'),
      latestEvidence: undefined,
    });
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.id === initialTask.surfaceId)).toBe(false);
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.id === 'worker-a')).toBe(true);

    await expect(request({
      action: 'terminal-rotate', callerSurfaceId: managerSurfaceId,
      projectId,
      summary: '轮换失败前已保存的恢复总结。',
    })).resolves.toMatchObject({ ok: true, pending: true });
    useStore.getState().updateLane(reboundLane!.id, {
      projectTaskRotationRequestedAt: Date.now() - 6 * 60 * 1000,
    });
    await expect(request({
      action: 'terminal-rotate', callerSurfaceId: managerSurfaceId,
      projectId,
      summary: '过期请求回收后的最新恢复总结。',
    })).resolves.toMatchObject({ ok: true, pending: true });
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === reboundLane?.id))
      .toMatchObject({ projectTaskRotationSummary: '过期请求回收后的最新恢复总结。' });
    expect(rotatedTaskWorkspace?.splitTree.type).toBe('leaf');
    if (rotatedTaskWorkspace?.splitTree.type === 'leaf' && reboundLane?.surfaceId) {
      useStore.getState().closeSurface(
        rotatedTaskWorkspace.id,
        rotatedTaskWorkspace.splitTree.paneId,
        reboundLane.surfaceId,
      );
    }
    await expect(request({
      action: 'task-terminal-rotate', callerSurfaceId: reboundLane?.supervisorSurfaceId,
      projectId,
      workItemId: 'rotation_task',
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('原任务终端已经不存在'),
    });
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === reboundLane?.id))
      .toMatchObject({
        projectTaskRotationPending: false,
        projectTaskRotationSummary: undefined,
        projectTaskRotationRequestedAt: undefined,
      });

    useStore.getState().enqueueApproval({
      laneId: reboundLane!.id,
      surfaceId: reboundLane!.surfaceId,
      laneLabel: reboundLane!.label,
      text: '监督退出前尚未完成的旧待决项',
      source: 'supervisor-important',
      proposalKind: 'important',
    });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
    markTerminalRuntimeExited(reboundLane!.supervisorSurfaceId!, '测试监督运行时退出');
    expect((globalThis.window as any).__wmux_queueProjectManagerRuntimeRecovery({
      projectId,
      role: 'supervisor',
      laneId: reboundLane?.id,
      surfaceId: reboundLane?.supervisorSurfaceId,
      workItemId: 'rotation_task',
      detail: '测试监督运行时退出',
    })).toBe(true);
    await vi.waitFor(() => {
      expect(useStore.getState().supervisor.lanes.find((lane) => (
        lane.projectManagerProjectId === projectId && lane.projectWorkItemId === 'rotation_task'
      ))?.id).not.toBe(reboundLane?.id);
    });
    const rebuiltLane = useStore.getState().supervisor.lanes.find((lane) => (
      lane.projectManagerProjectId === projectId && lane.projectWorkItemId === 'rotation_task'
    ));
    expect(rebuiltLane).toMatchObject({
      projectTaskStartupPending: true,
      supervisorSurfaceId: expect.any(String),
    });
    expect(rebuiltLane?.projectTaskRotationPending).not.toBe(true);
    expect(rebuiltLane?.id).not.toBe(reboundLane?.id);
    expect(rebuiltLane?.supervisorSurfaceId).not.toBe(reboundLane?.supervisorSurfaceId);
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    clearTerminalRuntimeStatus(reboundLane!.supervisorSurfaceId!);

    await expect(request({
      action: 'task-terminal-start',
      callerSurfaceId: rebuiltLane?.supervisorSurfaceId,
      projectId,
      workItemId: 'rotation_task',
    })).resolves.toMatchObject({ ok: true });
    const runningLane = useStore.getState().supervisor.lanes.find((lane) => (
      lane.projectManagerProjectId === projectId && lane.projectWorkItemId === 'rotation_task'
    ));
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: 'rotation_task',
      patch: { status: 'waiting-decision', latestBlocker: '测试任务运行时退出' },
    }, projectId);
    markTerminalRuntimeExited(runningLane!.surfaceId, '测试任务运行时退出');
    expect((globalThis.window as any).__wmux_queueProjectManagerRuntimeRecovery({
      projectId,
      role: 'task',
      laneId: runningLane?.id,
      surfaceId: runningLane?.surfaceId,
      workItemId: 'rotation_task',
      detail: '测试任务运行时退出',
    })).toBe(true);
    await vi.waitFor(() => {
      expect(useStore.getState().supervisor.lanes.find((lane) => (
        lane.projectManagerProjectId === projectId && lane.projectWorkItemId === 'rotation_task'
      ))?.surfaceId).not.toBe(runningLane?.surfaceId);
    });
    const taskRecoveredLane = useStore.getState().supervisor.lanes.find((lane) => (
      lane.projectManagerProjectId === projectId && lane.projectWorkItemId === 'rotation_task'
    ));
    expect(taskRecoveredLane).toMatchObject({
      id: runningLane?.id,
      supervisorSurfaceId: runningLane?.supervisorSurfaceId,
    });
    expect(taskRecoveredLane?.surfaceId).not.toBe(runningLane?.surfaceId);
    expect(useStore.getState().projectManager?.workItems[0]).toMatchObject({ status: 'running' });
    expect(useStore.getState().projectManager?.workItems[0].latestBlocker).toBeUndefined();
    clearTerminalRuntimeStatus(runningLane!.surfaceId);
  });

  it('closes an unbound task terminal when requirements change during startup', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({
      action: 'start', projectDir: 'E:\\startup-race', goal: '完成启动竞态验证',
      preconditions: ['测试环境已准备'], doneWhen: ['启动竞态回归测试通过'],
    });
    const session = useStore.getState().projectManager!;
    await confirmAndResumeProject(session.id);
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await request({
      action: 'task-create', callerSurfaceId: session.managerSurfaceId, projectId: session.id,
      workItem: {
        id: 'startup_race', title: '启动竞态', status: 'planned', dependencies: [],
        contract: {
          objective: '验证启动期间的需求变更', description: '', preconditions: [],
          scope: { root: 'E:\\startup-race', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['回归测试通过'], validation: ['运行聚焦测试'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    });
    await expect(request({
      action: 'task-supervise', callerSurfaceId: session.managerSurfaceId,
      projectId: session.id, workItemId: 'startup_race',
    })).resolves.toMatchObject({ ok: true, waitingForSupervisorTaskTerminal: true });
    const pendingLane = useStore.getState().supervisor.lanes.find((lane) => (
      lane.projectManagerProjectId === session.id && lane.projectWorkItemId === 'startup_race'
    ))!;
    (globalThis.window as any).wmux.pty.has = vi.fn(async () => true);

    const starting = request({
      action: 'task-terminal-start', callerSurfaceId: pendingLane.supervisorSurfaceId,
      projectId: session.id, workItemId: 'startup_race',
    });
    await vi.waitFor(() => {
      const candidate = useStore.getState().workspaces.flatMap((workspace) => (
        workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
      )).find((surface) => surface.projectManagerWorkItemId === 'startup_race');
      expect(candidate).toBeDefined();
    });
    const startingSurfaceId = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.projectManagerWorkItemId === 'startup_race')!.id;

    await expect(remote({
      action: 'update-preconditions', projectId: session.id,
      preconditions: ['启动后新增的安全条件必须重新确认'],
    })).resolves.toMatchObject({ ok: true });
    markTerminalRuntimeReady(startingSurfaceId);

    await expect(starting).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('需求版本已变化'),
    });
    expect(useStore.getState().projectManager).toMatchObject({
      status: 'waiting',
      workItems: [{ id: 'startup_race', workerSurfaceId: undefined }],
    });
    expect(useStore.getState().projectManager?.taskTerminalSurfaceId).toBeUndefined();
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.id === startingSurfaceId)).toBe(false);
    clearTerminalRuntimeStatus(startingSurfaceId);
    delete (globalThis.window as any).wmux.pty.has;
  });

  it('rejects a supervisor startup that has fallen back to an outer PowerShell prompt', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({
      action: 'start', projectDir: 'E:\\supervisor-shell-fallback', goal: '验证监督启动失败保护',
      preconditions: ['测试环境已准备'], doneWhen: ['失败监督不会接收控制协议'],
    });
    const session = useStore.getState().projectManager!;
    await confirmAndResumeProject(session.id);
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await request({
      action: 'task-create', callerSurfaceId: session.managerSurfaceId, projectId: session.id,
      workItem: {
        id: 'supervisor_shell_fallback', title: '监督启动保护', status: 'planned', dependencies: [],
        contract: {
          objective: '拒绝向普通 PowerShell 投递监督协议', description: '', preconditions: [],
          scope: { root: 'E:\\supervisor-shell-fallback', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['失败监督不会接收协议'], validation: ['检查启动失败事件'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    });
    (globalThis.window as any).wmux.pty.has = vi.fn(async () => true);

    const starting = request({
      action: 'task-supervise', callerSurfaceId: session.managerSurfaceId,
      projectId: session.id, workItemId: 'supervisor_shell_fallback',
    });
    await vi.waitFor(() => {
      expect(useStore.getState().supervisor.lanes.find((lane) => (
        lane.projectWorkItemId === 'supervisor_shell_fallback'
      ))?.supervisorSurfaceId).toBeTruthy();
    });
    const startingLane = useStore.getState().supervisor.lanes.find((lane) => (
      lane.projectWorkItemId === 'supervisor_shell_fallback'
    ))!;
    surfaceTerminalRegistry.set(startingLane.supervisorSurfaceId!, {
      buffer: {
        active: {
          type: 'normal', baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => 'PS C:\\Users\\tester\\AppData\\Roaming\\wmux\\supervisor\\runtime>' }),
        },
      },
    } as any);
    markTerminalRuntimeReady(startingLane.supervisorSurfaceId!);

    await expect(starting).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('外层 Shell 提示符'),
    });
    expect(useStore.getState().supervisor.lanes.some((lane) => (
      lane.id === startingLane.id
    ))).toBe(false);
    expect(useStore.getState().projectManager?.events).toContainEqual(expect.objectContaining({
      kind: 'supervisor-runtime-failed',
      workItemId: 'supervisor_shell_fallback',
    }));

    surfaceTerminalRegistry.delete(startingLane.supervisorSurfaceId!);
    clearTerminalRuntimeStatus(startingLane.supervisorSurfaceId!);
    delete (globalThis.window as any).wmux.pty.has;
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

  it('does not bind a new task terminal that fell back to PowerShell', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await remote({
      action: 'start', projectDir: 'E:\\task-shell-fallback', goal: '验证任务 AI 启动保护',
      preconditions: ['测试环境已准备'], doneWhen: ['失效任务终端不会绑定工作项'],
    });
    const session = useStore.getState().projectManager!;
    await confirmAndResumeProject(session.id);
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await request({
      action: 'task-create', callerSurfaceId: session.managerSurfaceId, projectId: session.id,
      workItem: {
        id: 'task_shell_fallback', title: '任务启动保护', status: 'planned', dependencies: [],
        contract: {
          objective: '拒绝绑定普通 PowerShell 任务终端', description: '', preconditions: [],
          scope: { root: 'E:\\task-shell-fallback', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['失效任务终端保持未绑定'], validation: ['检查任务绑定'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    });
    await expect(request({
      action: 'task-supervise', callerSurfaceId: session.managerSurfaceId,
      projectId: session.id, workItemId: 'task_shell_fallback',
    })).resolves.toMatchObject({ ok: true, waitingForSupervisorTaskTerminal: true });
    const lane = useStore.getState().supervisor.lanes.find((candidate) => (
      candidate.projectWorkItemId === 'task_shell_fallback'
    ))!;
    (globalThis.window as any).wmux.pty.has = vi.fn(async () => true);

    const starting = request({
      action: 'task-terminal-start', callerSurfaceId: lane.supervisorSurfaceId,
      projectId: session.id, workItemId: 'task_shell_fallback',
    });
    await vi.waitFor(() => {
      expect(useStore.getState().workspaces.flatMap((workspace) => (
        workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
      )).find((surface) => surface.projectManagerWorkItemId === 'task_shell_fallback')?.id).toBeTruthy();
    });
    const taskSurfaceId = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.projectManagerWorkItemId === 'task_shell_fallback')!.id;
    surfaceTerminalRegistry.set(taskSurfaceId, {
      buffer: {
        active: {
          type: 'normal', baseY: 0, cursorX: 0, cursorY: 0, length: 1,
          getLine: () => ({ translateToString: () => 'PS E:\\task-shell-fallback>' }),
        },
      },
    } as any);
    markTerminalRuntimeReady(taskSurfaceId);

    await expect(starting).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('外层 Shell 提示符'),
    });
    expect(useStore.getState().projectManager?.workItems.find((item) => (
      item.id === 'task_shell_fallback'
    ))?.workerSurfaceId).toBeUndefined();
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id))
      .toMatchObject({ projectTaskStartupPending: true });

    surfaceTerminalRegistry.delete(taskSurfaceId);
    clearTerminalRuntimeStatus(taskSurfaceId);
    delete (globalThis.window as any).wmux.pty.has;
  });

  it('deletes only the selected project and closes its managed supervisor chain', async () => {
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().resetOrdinarySupervisorSession();
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-delete-worker' as any,
      title: '待删除项目',
      cwd: 'E:\\delete-project',
      splitTree: {
        type: 'leaf', paneId: 'pane-delete-worker' as any, activeSurfaceIndex: 0,
        surfaces: [{ id: 'worker-a' as any, type: 'terminal', shell: 'pwsh.exe', cwd: 'E:\\delete-project' }],
      },
    }]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    await expect(remote({
      action: 'start', projectDir: 'E:\\delete-project', goal: '删除项目',
      preconditions: ['环境安全'], doneWhen: ['完成'],
    })).resolves.toMatchObject({ ok: true });
    const projectId = useStore.getState().projectManager?.id;
    await confirmAndResumeProject(projectId!);
    const managerSurfaceId = useStore.getState().projectManager?.managerSurfaceId;
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'task-create', callerSurfaceId: managerSurfaceId,
      workItem: {
        id: 'delete_task', title: '删除任务', status: 'planned', dependencies: [],
        contract: {
          objective: '验证删除', description: '', preconditions: [],
          scope: { root: 'E:\\delete-project', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['完成'], validation: ['检查'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    })).resolves.toMatchObject({ ok: true });
    const { created: projectTask } = await startTaskThroughDedicatedSupervisor(projectId!, 'delete_task');
    await expect(remote({
      action: 'start', projectDir: 'E:\\keep-project', goal: '保留项目',
      preconditions: ['环境安全'], doneWhen: ['完成'],
    })).resolves.toMatchObject({ ok: true });
    const remainingProjectId = useStore.getState().projectManager?.id;
    useStore.getState().selectProjectManager(projectId!);

    await expect(remote({ action: 'delete-project', projectId })).resolves.toMatchObject({
      ok: true, deletedProjectId: projectId, selectedProjectId: remainingProjectId,
    });
    expect((globalThis.window as any).wmux.projectManager.deleteSession).toHaveBeenCalledWith(projectId);
    expect(useStore.getState().projectManagers.map((project) => project.id)).toEqual([remainingProjectId]);
    expect(useStore.getState().projectManager?.id).toBe(remainingProjectId);
    expect(useStore.getState().supervisor.lanes).toEqual([]);
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.id === projectTask.surfaceId)).toBe(false);
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.id === 'worker-a')).toBe(true);
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.projectManagerTerminal)).toBe(true);
  });

  it('closes a planning-only project console when the project is deleted', async () => {
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
    expect(useStore.getState().supervisor.lanes.some((lane) => lane.projectManagerProjectId === projectId)).toBe(false);

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
    return (globalThis.window as any).__wmux_supervisorDecide({
      surfaceId: 'worker-a',
      supervisorSurfaceId: 'supervisor-a',
      outcome: 'continue',
      reason: '测试裁决',
      ...params,
    });
  }

  const ordinaryTaskDelivery = (next: string, first = true) => prepareTerminalPasteInput(
    `${first ? ORDINARY_TASK_ROLE_ANCHOR : buildOrdinaryTaskEventEnvelope('worker-a')}\n\n${next}`,
    false,
  );

  it('injects one safe next step from ordinary supervision', () => {
    expect(decide({ next: '运行相关单元测试' })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledWith('worker-a', ordinaryTaskDelivery('运行相关单元测试'));
    expect(useStore.getState().supervisor.lanes[0].taskRoleAnchorPending).toBe(false);
    expect(decide({ next: '重复发送下一步' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
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

  it('accepts and retains an ordinary supervisor execution plan derived from the user task', () => {
    useStore.getState().updateLane('lane-a', { ordinaryPlanRequired: true });
    const plan = {
      selectedRoute: '先完成聚焦修复，再运行定向测试',
      milestones: [{
        id: 'fix_and_test', title: '修复并验证', outcome: '形成修复和测试证据', status: 'active',
      }],
      expectedPaths: ['src/config.ts'],
      targetedValidation: ['npm test -- config'],
      serializedBoundaries: ['修改完成后再运行测试'],
      remainingWork: ['完成修复和验证'],
    };

    expect(decide({
      next: '修复配置缺失分支并运行定向测试',
      stagePlanFile: '.wmux/tmp/ordinary-plan.json',
      stagePlan: plan,
    })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(useStore.getState().supervisor.lanes[0].decisions?.[0]).toMatchObject({
      plan: {
        revision: 1,
        selectedRoute: plan.selectedRoute,
        milestones: plan.milestones,
      },
    });
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({
      next: '继续处理同一配置分支',
      stagePlanFile: '.wmux/tmp/hidden-route-change.json',
      stagePlan: {
        ...plan,
        selectedRoute: '改为重写整个配置加载流程',
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('--proposal-kind route-adjustment'),
    });
    expect(decide({ outcome: 'complete', next: '' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('仍有未完成执行项'),
    });
  });

  it('rejects runtime artifacts in run templates for ordinary supervision', () => {
    useStore.getState().updateLane('lane-a', { ordinaryPlanRequired: true });
    expect(decide({
      next: '运行测试并保存验证日志',
      stagePlanFile: '.wmux/tmp/ordinary-artifact-plan.json',
      stagePlan: {
        selectedRoute: '运行聚焦测试并保存证据',
        milestones: [{ id: 'validate', title: '聚焦验证', outcome: '形成测试证据', status: 'active' }],
        expectedPaths: ['runs/run_templates/focused-test.log'],
        targetedValidation: ['npm test -- focused'],
        serializedBoundaries: [],
        remainingWork: ['完成聚焦验证'],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('模板目录只能保存可复用的预执行输入'),
    });
  });

  it('rejects validation logs in test source directories for ordinary supervision', () => {
    useStore.getState().updateLane('lane-a', { ordinaryPlanRequired: true });
    expect(decide({
      next: '运行测试并保存验证日志',
      stagePlanFile: '.wmux/tmp/ordinary-test-log-plan.json',
      stagePlan: {
        selectedRoute: '运行聚焦测试并保存证据',
        milestones: [{ id: 'validate', title: '聚焦验证', outcome: '形成测试证据', status: 'active' }],
        expectedPaths: ['tests/focused-validation.log'],
        targetedValidation: ['npm test -- focused'],
        serializedBoundaries: [],
        remainingWork: ['完成聚焦验证'],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('测试/源码目录只能保存源码'),
    });
  });

  it('normalizes pending milestones and reports the exact invalid stage-plan field', () => {
    useStore.getState().updateLane('lane-a', { ordinaryPlanRequired: true });
    expect(decide({
      next: '只读核对证据后形成安全交接',
      stagePlanFile: '.wmux/tmp/pending-stage-plan.json',
      stagePlan: {
        selectedRoute: '只读证据封存',
        milestones: [
          { id: 'q01_b3_ledger_run_audit', title: '核对证据', outcome: '形成可复核结论', status: 'pending' },
          { id: 'q02_suspend_handoff', title: '安全交接', outcome: '交回剩余边界', status: 'pending' },
        ],
        expectedPaths: [], targetedValidation: [], serializedBoundaries: [], remainingWork: ['完成只读核对'],
      },
    })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(useStore.getState().supervisor.lanes[0].decisions?.[0]?.plan?.milestones)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'q01_b3_ledger_run_audit', status: 'planned' }),
        expect.objectContaining({ id: 'q02_suspend_handoff', status: 'planned' }),
      ]));

    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({
      next: '提交修正后的阶段计划',
      stagePlanFile: '.wmux/tmp/invalid-stage-plan.json',
      stagePlan: {
        selectedRoute: '只读证据封存',
        milestones: [{ id: 'q03_invalid_status', title: '核对', outcome: '形成结论', status: 'waiting' }],
        expectedPaths: [], targetedValidation: [], serializedBoundaries: [], remainingWork: ['完成核对'],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('status“waiting”无效'),
    });
  });

  it('aligns several material ambiguities before a new ordinary lane can execute', () => {
    useStore.getState().updateLane('lane-a', { ordinaryPlanRequired: true });
    expect(decide({ next: '直接开始实现' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('首次执行前'),
    });

    const questions = '1. 目标是修复现有登录还是新增登录？\n2. 完成条件是否包含失败分支测试？';
    expect(ordinaryClarificationQuestions(questions)).toHaveLength(2);
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'clarification',
      reason: '1. 目标是修复现有登录吗？',
      impact: '答案会改变实现范围',
      alternatives: '推荐默认答案：修复现有登录并补失败分支测试',
      next: '',
    })).toMatchObject({ ok: false, error: expect.stringContaining('2-5 个') });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'clarification',
      reason: questions,
      impact: '答案会改变功能范围和验收标准',
      alternatives: '推荐默认答案：1=修复现有登录；2=包含失败分支测试',
      next: '',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });

    const approval = useStore.getState().supervisor.pendingApprovals[0];
    expect(approval).toMatchObject({ proposalKind: 'clarification', reason: questions });
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('集中填写') });
    writes.mockClear();
    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve',
      task: '1. 修复现有登录。2. 包含失败分支测试。', actor: 'ou-user',
    })).toMatchObject({ ok: true });
    expect(queuedOwnerDecision()?.text).toContain('[需求对齐答复]');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    consumeQueuedOwnerDecision();

    expect(decide({
      next: '修复现有登录并补充失败分支测试',
      stagePlanFile: '.wmux/tmp/aligned-ordinary-plan.json',
      stagePlan: {
        selectedRoute: '聚焦修复现有登录并补齐验收测试',
        milestones: [{ id: 'fix_login', title: '修复并验证', outcome: '登录及失败分支测试通过', status: 'active' }],
        expectedPaths: [], targetedValidation: [], serializedBoundaries: [], remainingWork: ['完成修复和验证'],
      },
    })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledWith('worker-a', expect.stringContaining('修复现有登录并补充失败分支测试'));
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

  it('uses a compact event envelope after the ordinary task role was loaded once', () => {
    expect(decide({ next: '检查当前实现' })).toMatchObject({ ok: true, outcome: 'continue' });
    useStore.getState().updateLane('lane-a', { awaitingReview: true });

    expect(decide({ next: '运行相关单元测试' })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledTimes(2);
    expect(writes).toHaveBeenNthCalledWith(2, 'worker-a', ordinaryTaskDelivery('运行相关单元测试', false));
    expect(String(writes.mock.calls[1][1])).not.toContain(ORDINARY_TASK_ROLE_ANCHOR);
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

  it('injects the trusted continuous contract into the first project task instruction', () => {
    bindProjectLaneToWorkItem({ continuousExecution: true });
    useStore.getState().updateLane('lane-a', {
      projectTaskContractPending: true,
      awaitingReview: true,
    });

    expect(decide({ next: '检查现状并完成合同内剩余流程' })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(useStore.getState().supervisor.lanes[0].projectTaskContractPending).toBe(false);
    expect(writes.mock.calls.some(([surfaceId, text]) => (
      surfaceId === 'worker-a'
      && String(text).includes('[项目任务连续执行契约]')
      && String(text).includes('检查现状并完成合同内剩余流程')
    ))).toBe(true);
  });

  it('blocks implementation until a delivered read-only baseline is reviewed and approved', () => {
    const project = bindProjectLaneToWorkItem({ baselineRequired: true, continuousExecution: true });
    useStore.getState().updateLane('lane-a', {
      projectTaskContractPending: true,
      awaitingReview: true,
    });

    expect(decide({ next: '直接修改实现', executionAction: 'implementation' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('项目基线尚未审核'),
    });
    expect(decide({
      next: '[批准项目基线] 开始实现',
      executionAction: 'approve-baseline',
      workspaceVersion: 'head:test',
      evidence: '声称已经看过项目',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('不能预先批准'),
    });
    expect(writes).not.toHaveBeenCalled();

    expect(decide({
      next: '[项目基线调查] 只读检查当前工作树、相关入口、测试约定和共享资源边界；以 [项目基线报告] 返回，不得写入或运行测试',
      executionAction: 'readonly-project-baseline',
    })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(useStore.getState().projectManagers.find((item) => item.id === project.id)?.workItems[0].baseline)
      .toMatchObject({ status: 'investigating', requirementsVersion: 1 });

    expect(decide({
      next: '[批准项目基线] 报告与合同一致，开始实现合同内任务',
      executionAction: 'approve-project-baseline',
      workspaceVersion: 'head:test,status:dirty-known',
      evidence: '已审核工作树、入口调用链、测试约定、既有改动和共享资源边界',
    })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(useStore.getState().projectManagers.find((item) => item.id === project.id)?.workItems[0].baseline)
      .toMatchObject({
        status: 'approved',
        requirementsVersion: 1,
        workspaceVersion: 'head:test,status:dirty-known',
      });
    expect(useStore.getState().projectManagers.find((item) => item.id === project.id)?.workItems[0].decisionsUsed)
      .toBe(0);
  });

  it('explains why generated outputs do not belong in supervisor expected paths', () => {
    const project = bindProjectLaneToWorkItem();
    project.workItems[0].contract.scope.allowPaths = ['src'];
    useStore.getState().restoreProjectManager(project);

    expect(decide({
      next: '按阶段计划完成合同内实现和验证',
      executionAction: 'implement-and-validate',
      stagePlanFile: '.wmux/tmp/generated-output-plan.json',
      stagePlan: {
        selectedRoute: '修改源码后生成并验证控制台程序',
        milestones: [{
          id: 'build_console', title: '构建控制台程序', outcome: '完成源码实现与构建验证', status: 'active',
        }],
        expectedPaths: ['console_app.exe'],
        targetedValidation: ['npm test'],
        serializedBoundaries: [],
        remainingWork: ['完成源码实现与验证'],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('构建工具自动生成的二进制'),
    });
  });

  it('pauses a project supervisor after the same invalid decision is rejected twice', () => {
    const project = bindProjectLaneToWorkItem({ baselineRequired: true });
    expect(decide({
      next: '[项目基线调查] 只读核对当前工作树、入口和测试约定；不得写入或运行测试',
      executionAction: 'readonly-project-baseline',
    })).toMatchObject({ ok: true });
    useStore.getState().updateLane('lane-a', { awaitingReview: true });

    const invalidApproval = {
      next: '[批准项目基线] 基线证据已核对，开始合同内实现',
      executionAction: 'approve-project-baseline',
      workspaceVersion: 'head:test,status:known',
      evidence: '已审核当前工作树、入口、测试约定和改动边界',
      changedFiles: ['src/auth.ts'],
      testCommand: 'npm test -- auth',
      testResult: 'planned',
    };
    expect(decide(invalidApproval)).toMatchObject({
      ok: false,
      error: expect.stringContaining('原子裁决不得携带'),
    });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'active',
      supervisorDecisionErrorGuard: { occurrences: 1, blocked: false },
    });

    expect(decide(invalidApproval)).toMatchObject({
      ok: false,
      protocolCorrectionPaused: true,
      error: expect.stringContaining('协议纠错暂停'),
    });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'paused',
      supervisorDecisionErrorGuard: { occurrences: 2, blocked: true },
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0])
      .toMatchObject({ status: 'waiting-decision', baseline: { status: 'investigating' } });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingSupervisorTransitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'supervisor.decision-error-loop' }),
    ]));
    useStore.getState().resumeSupervisorLane('lane-a', '验证普通恢复不能清除协议错误锁');
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'active',
      supervisorDecisionErrorGuard: { occurrences: 2, blocked: true },
    });
    useStore.getState().pauseSupervisorLane('lane-a', '继续验证纠错暂停');
    const transitionCount = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingSupervisorTransitions?.length;
    expect(decide({ ...invalidApproval, supervisorSurfaceId: 'unbound-supervisor' })).toBeNull();
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'paused',
      supervisorDecisionErrorGuard: { occurrences: 2, blocked: true },
    });
    expect(decide(invalidApproval)).toMatchObject({
      ok: false,
      protocolCorrectionPaused: true,
      error: expect.stringContaining('已连续出现两次'),
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingSupervisorTransitions).toHaveLength(transitionCount || 0);

    expect(decide({
      next: '[批准项目基线] 基线证据已核对，开始合同内实现',
      executionAction: 'approve-project-baseline',
      workspaceVersion: 'head:test,status:known',
      evidence: '已审核当前工作树、入口、测试约定和改动边界',
    })).toMatchObject({ ok: true });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'active',
      supervisorDecisionErrorGuard: undefined,
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0])
      .toMatchObject({ status: 'running', baseline: { status: 'approved' } });
  });

  it('rejects runtime artifacts in a project run template directory', () => {
    const project = bindProjectLaneToWorkItem();
    project.workItems[0].contract.scope.allowPaths = ['runs'];
    useStore.getState().restoreProjectManager(project);

    expect(decide({
      next: '冻结候选并保存离线验证证据',
      executionAction: 'freeze-and-validate',
      stagePlanFile: '.wmux/tmp/runtime-artifact-in-template-plan.json',
      stagePlan: {
        selectedRoute: '冻结候选后执行离线验证',
        milestones: [{
          id: 'freeze_candidate', title: '冻结候选', outcome: '形成候选与验证证据', status: 'active',
        }],
        expectedPaths: [
          'runs/run_templates/candidate.plan.json',
          'runs/run_templates/candidate.identity.json',
          'runs/run_templates/candidate.pytest.log',
        ],
        targetedValidation: ['python -m unittest'],
        serializedBoundaries: [],
        remainingWork: ['完成候选冻结与验证'],
      },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('模板目录只能保存可复用的预执行输入'),
    });
  });

  it('opens only a budget-exhausted handoff after protocol-correction pause', async () => {
    const project = bindProjectLaneToWorkItem({
      projectId: 'pm-protocol-budget-handoff',
      baselineRequired: true,
    });
    const managerSurfaceId = 'project-manager-protocol-budget-handoff';
    useStore.getState().restoreProjectManager({
      ...useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!,
      managerSurfaceId: managerSurfaceId as any,
    });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-protocol-budget-handoff' as any,
      title: '协议纠错预算交回测试',
      cwd: project.projectDir,
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf' as const,
        paneId: 'pane-protocol-budget-handoff' as any,
        activeSurfaceIndex: 0,
        surfaces: [
          {
            id: managerSurfaceId as any,
            type: 'terminal' as const,
            shell: 'pwsh.exe',
            projectManagerTerminal: true,
            projectManagerProjectId: project.id,
            projectManagerAgent: 'codex',
          },
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
    }]);
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'task-a', patch: { decisionsUsed: 5 },
    }, project.id);
    const beforeShrink = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!
      .workItems[0];
    await expect(request({
      action: 'task-update', callerSurfaceId: managerSurfaceId, projectId: project.id,
      workItemId: 'task-a', patch: {
        contract: {
          ...beforeShrink.contract,
          authority: {
            ...beforeShrink.contract.authority,
            continuousExecution: true,
            continuationBoundary: undefined,
          },
          budget: { ...beforeShrink.contract.budget, maxDecisions: 4 },
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('不能低于已使用次数'),
    });
    await expect(request({
      action: 'task-update', callerSurfaceId: managerSurfaceId, projectId: project.id,
      workItemId: 'task-a', patch: {
        contract: {
          ...beforeShrink.contract,
          authority: {
            ...beforeShrink.contract.authority,
            continuousExecution: true,
            continuationBoundary: undefined,
          },
          budget: { ...beforeShrink.contract.budget, maxDecisions: 13 },
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('工作项开始执行后不能修改'),
    });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'task-a', patch: { decisionsUsed: 0 },
    }, project.id);

    expect(decide({
      next: '[项目基线调查] 只读核对当前工作树、入口和测试约定；不得写入或运行测试',
      executionAction: 'readonly-project-baseline',
    })).toMatchObject({ ok: true });
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    const invalidApproval = {
      next: '[批准项目基线] 基线证据已核对，开始合同内实现',
      executionAction: 'approve-project-baseline',
      workspaceVersion: 'head:test,status:known',
      evidence: '已审核当前工作树、入口、测试约定和改动边界',
      changedFiles: ['src/auth.ts'],
      testCommand: 'npm test -- auth',
      testResult: 'planned',
    };
    expect(decide(invalidApproval)).toMatchObject({ ok: false });
    expect(decide(invalidApproval)).toMatchObject({
      ok: false,
      protocolCorrectionPaused: true,
    });
    const maxDecisions = useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)!.workItems[0].contract.budget.maxDecisions;
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'task-a', patch: { decisionsUsed: maxDecisions },
    }, project.id);
    const errorTransition = useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)?.pendingSupervisorTransitions
      ?.find((transition) => transition.eventType === 'supervisor.decision-error-loop');
    expect(errorTransition).toBeTruthy();

    writes.mockClear();
    await expect(request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId, projectId: project.id,
      workItemId: 'task-a',
    })).resolves.toMatchObject({
      ok: true,
      recovered: false,
      budgetHandoffRequired: true,
      laneId: 'lane-a',
    });
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a'))
      .toMatchObject({
        controlState: 'active',
        awaitingReview: true,
        projectTaskContractPending: false,
        supervisorDecisionErrorGuard: { blocked: true },
      });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0])
      .toMatchObject({
        status: 'waiting-decision',
        decisionsUsed: maxDecisions,
        latestBlocker: expect.stringContaining('等待专属监督结构化交回'),
      });
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    const context = (globalThis.window as any).__wmux_supervisorContext({
      callerSurfaceId: 'supervisor-a',
    });
    expect(context).toMatchObject({
      ok: true,
      state: { decision: 'ready' },
      commands: { decisionOutcomes: ['needs-human'] },
      budget: { projectDecisionsRemaining: 0 },
    });
    consumeQueuedControlMessage('lane-a');
    await expect(request({
      action: 'transition-ack', callerSurfaceId: managerSurfaceId, projectId: project.id,
      transitionId: errorTransition?.id, resolution: 'recovered',
      summary: '错误地声称旧任务已恢复',
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('running 工作项'),
    });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      escalationBoundary: 'budget-exhausted',
      reason: '旧工作项监督裁决预算已耗尽',
      impact: '继续向旧任务终端投递会绕过已冻结的有限自治预算',
      alternatives: '保留旧审计并创建唯一后继工作项承接剩余范围',
    })).toMatchObject({
      ok: true,
      outcome: 'needs-human',
      budgetExhausted: true,
      successorCreated: true,
      successorWorkItemId: 'task-a-budget-s1',
    });
    const succeeded = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    expect(succeeded.workItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'task-a', status: 'stopped', supersededByWorkItemId: 'task-a-budget-s1',
      }),
      expect.objectContaining({
        id: 'task-a-budget-s1', status: 'planned', predecessorWorkItemId: 'task-a',
        decisionsUsed: 0, successionReason: 'budget-exhausted',
      }),
    ]));
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(activeProjectManagerAttentionEvent(succeeded.events)).toBeUndefined();
  });

  it('freezes an exhausted restored work item and creates one independent-budget successor', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-restored-budget-exhausted' });
    useStore.getState().setProjectSupervisorLanes([]);
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    const exhaustedBudget = {
      ...DEFAULT_PROJECT_EXECUTION_BUDGET,
      maxDecisions: 4,
      maxContinuousMinutes: 30,
      maxAggregateWorkerMinutes: 30,
      maxIdenticalFailures: 1,
      maxNoProgressRounds: 1,
      maxTaskRetries: 1,
    };
    const maxDecisions = exhaustedBudget.maxDecisions;
    useStore.getState().restoreProjectManager({
      ...current,
      workItems: current.workItems.map((item) => ({
        ...item,
        status: 'running' as const,
        supervisorLaneId: undefined,
        workerSurfaceId: undefined,
        decisionsUsed: maxDecisions,
        contract: {
          ...item.contract,
          budget: exhaustedBudget,
        },
      })),
    });
    const managerSurfaceId = 'project-manager-restored-budget-exhausted';
    attachProjectManagerSurface(project.id, managerSurfaceId);
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    await expect(request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId, projectId: project.id,
      workItemId: 'task-a', recoveryAutoStart: true,
    })).resolves.toMatchObject({
      ok: false,
      budgetExhausted: true,
      successorCreated: true,
      successorWorkItemId: 'task-a-budget-s1',
      error: expect.stringContaining('独立预算后继'),
    });
    const parked = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!;
    expect(parked.workItems[0]).toMatchObject({
      status: 'stopped',
      decisionsUsed: maxDecisions,
      supersededByWorkItemId: 'task-a-budget-s1',
      latestBlocker: expect.stringContaining('已冻结'),
    });
    expect(parked.workItems[1]).toMatchObject({
      id: 'task-a-budget-s1', status: 'planned',
      predecessorWorkItemId: 'task-a', successionReason: 'budget-exhausted',
      decisionsUsed: 0, attempts: 0, executionHistory: [],
      contract: {
        stopWhen: ['测试任务完成', '相关测试通过'],
        budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      },
    });
    expect(useStore.getState().supervisor.lanes.some((lane) => (
      lane.projectManagerProjectId === project.id
    ))).toBe(false);
    expect(parked.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'guard-triggered',
        payload: expect.objectContaining({
          attentionRequired: false,
          budgetExhausted: true,
        }),
      }),
    ]));
    const successorInstruction = [
      JSON.stringify(parked.pendingManagerDeliveries || []),
      JSON.stringify(writes.mock.calls),
    ].join('\n');
    expect(successorInstruction).toContain('控制层已建立唯一后继工作项');
    expect(successorInstruction).toContain('无需用户审批');
    const guardEventCount = parked.events.filter((event) => (
      event.kind === 'guard-triggered' && event.payload?.budgetExhausted === true
    )).length;
    await expect(request({
      action: 'task-update', callerSurfaceId: managerSurfaceId, projectId: project.id,
      workItemId: 'task-a', patch: { status: 'planned' },
    })).resolves.toMatchObject({
      ok: false, workItemSuperseded: true, successorWorkItemId: 'task-a-budget-s1',
    });
    await expect(request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId, projectId: project.id,
      workItemId: 'task-a', recoveryAutoStart: true,
    })).resolves.toMatchObject({
      ok: false, workItemSuperseded: true, successorWorkItemId: 'task-a-budget-s1',
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.events
      .filter((event) => event.kind === 'guard-triggered' && event.payload?.budgetExhausted === true))
      .toHaveLength(guardEventCount);
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

  it('keeps a semantic baseline error latched across needs-human and a new review', () => {
    const project = bindProjectLaneToWorkItem({ baselineRequired: true });
    expect(decide({
      next: '[项目基线调查] 只读核对当前工作树；随后 [批准项目基线] 并开始实现',
      executionAction: 'investigate-and-approve-at-once',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('必须分成两轮'),
    });
    expect(useStore.getState().supervisor.lanes[0].supervisorDecisionErrorGuard).toMatchObject({
      occurrences: 1,
      blocked: false,
      blockerCategory: 'project-baseline-not-investigating',
    });

    useStore.getState().updateLane('lane-a', { awaitingReview: true, activeReviewId: 'review-after-error' });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      escalationBoundary: 'contract-change',
      reason: '基线状态与旧屏幕报告不一致，需要项目 AI 协调',
      impact: '继续批准会绕过结构化基线门禁',
      alternatives: '安排一次有界当前工作树核对；或暂停该工作项',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    expect(useStore.getState().supervisor.lanes[0].supervisorDecisionErrorGuard).toMatchObject({
      occurrences: 1,
      blockerCategory: 'project-baseline-not-investigating',
    });
    const pending = useStore.getState().supervisor.pendingApprovals[0];
    useStore.getState().rejectPending(pending.id);
    useStore.getState().updateLane('lane-a', { awaitingReview: true, activeReviewId: 'review-new-generation' });

    expect(decide({
      next: '[批准项目基线] 复用旧报告并开始合同内实现',
      executionAction: 'approve-existing-report',
      workspaceVersion: 'head:test,status:known',
      evidence: '旧屏幕包含完整项目基线报告',
    })).toMatchObject({
      ok: false,
      protocolCorrectionPaused: true,
      error: expect.stringContaining('协议纠错暂停'),
    });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'paused',
      supervisorDecisionErrorGuard: {
        occurrences: 2,
        blocked: true,
        blockerCategory: 'project-baseline-not-investigating',
      },
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0])
      .toMatchObject({ status: 'waiting-decision', baseline: { status: 'required' } });
  });

  it('reopens one semantic retry after the project contract actually changes', () => {
    const project = bindProjectLaneToWorkItem({ baselineRequired: true });
    const invalidApproval = {
      next: '[批准项目基线] 复用旧报告并开始实现',
      executionAction: 'approve-existing-report',
      workspaceVersion: 'head:test,status:known',
      evidence: '旧屏幕包含完整项目基线报告',
    };
    expect(decide(invalidApproval)).toMatchObject({
      ok: false,
      error: expect.stringContaining('不能预先批准'),
    });
    const firstGuard = useStore.getState().supervisor.lanes[0].supervisorDecisionErrorGuard;
    const item = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)!.workItems[0];
    expect(useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: item.id,
      patch: { contract: { ...item.contract, description: '项目 AI 补充了实质合同边界' } },
    }, project.id)).toMatchObject({ ok: true });
    useStore.getState().updateLane('lane-a', { awaitingReview: true });

    const retried = decide(invalidApproval);
    expect(retried).toMatchObject({
      ok: false,
      error: expect.stringContaining('不能预先批准'),
    });
    expect(retried).not.toHaveProperty('protocolCorrectionPaused');
    const secondGuard = useStore.getState().supervisor.lanes[0].supervisorDecisionErrorGuard;
    expect(secondGuard).toMatchObject({
      occurrences: 1,
      blocked: false,
      blockerCategory: 'project-baseline-not-investigating',
    });
    expect(secondGuard?.contractSignature).not.toBe(firstGuard?.contractSignature);
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

  it('routes project-managed approvals internally without notifying the user', () => {
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
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0]
      .decisionsUsed).toBe(1);
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
    expect((globalThis.window as any).wmux.notification.fire).not.toHaveBeenCalled();
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
      impact: '无法覆盖或追加项目基线调查',
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

  it('repairs a persisted approved-baseline synchronization conflict and resumes the same goal chain', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-baseline-sync-recovery' });
    const store = useStore.getState();
    const current = store.projectManagers.find((candidate) => candidate.id === project.id)!;
    store.restoreProjectManager({
      ...current,
      status: 'waiting',
      workItems: current.workItems.map((item) => ({
        ...item,
        status: 'waiting-decision' as const,
        baseline: { status: 'required' as const, requirementsVersion: 1 },
        latestBlocker: '控制层基线门禁与已成功裁决记录冲突，协议禁止重复调查',
      })),
      events: [{
        id: 'approved-baseline-event',
        sessionId: project.id,
        ts: 10,
        kind: 'work-item-baseline-approved',
        workItemId: 'task-a',
        summary: '监督 AI 已审核项目基线：task-a',
        payload: { workspaceVersion: 'head:approved', evidence: '既有基线已经审核并批准' },
      }],
      pendingUserQuestion: {
        id: 'baseline-sync-question',
        category: 'manual-intervention',
        workItemId: 'task-a',
        blocker: '控制层基线门禁与已成功裁决记录冲突：此前已批准，禁止重复调查或重复批准。',
        reasonCode: 'internal-project-failure',
        question: '执行链已经停止，请选择恢复方式。',
        context: '内部结构化基线冲突',
        options: [
          { id: 'retry', label: '恢复', description: '重建执行链' },
          { id: 'pause', label: '暂停', description: '保持暂停' },
        ],
        recommendedOptionId: 'retry',
        previousStatus: 'active',
        createdAt: 20,
      },
    });
    store.pauseSupervisorLane('lane-a', '模拟旧控制层因基线同步冲突暂停');

    initPipeBridge();

    await vi.waitFor(() => expect(useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)).toMatchObject({
      status: 'active',
      workItems: [expect.objectContaining({
        id: 'task-a',
        status: 'waiting-decision',
        baseline: expect.objectContaining({
          status: 'investigating',
          reviewKind: 'contract-delta',
          priorWorkspaceVersion: 'head:approved',
          priorEvidence: '既有基线已经审核并批准',
        }),
      })],
    }));
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingUserQuestion).toBeUndefined();
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === 'lane-a'))
      .toMatchObject({ controlState: 'active' });
    const repaired = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(repaired?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user-clarification-invalidated',
        payload: expect.objectContaining({ reason: 'project-baseline-contract-delta-recovered' }),
      }),
    ]));
    expect(repaired?.pendingManagerDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('控制层已消解内部基线同步冲突') }),
    ]));
    expect(queuedControlText()).toContain('reviewKind=contract-delta');
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
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

  it('does not reuse an old baseline approval after a requirements change', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-stale-baseline-approval' });
    const store = useStore.getState();
    const current = store.projectManagers.find((candidate) => candidate.id === project.id)!;
    const question = {
      id: 'stale-baseline-question',
      category: 'manual-intervention' as const,
      workItemId: 'task-a',
      blocker: '控制层基线状态冲突，需要判断是否复用旧批准',
      reasonCode: 'internal-project-failure' as const,
      question: '是否恢复？',
      context: '需求已经变化',
      options: [
        { id: 'retry', label: '恢复', description: '尝试恢复' },
        { id: 'pause', label: '暂停', description: '保持暂停' },
      ],
      recommendedOptionId: 'retry',
      previousStatus: 'active' as const,
      createdAt: 20,
    };
    store.restoreProjectManager({
      ...current,
      status: 'waiting',
      requirementsVersion: 2,
      acceptedRequirementsVersion: 2,
      workItems: current.workItems.map((item) => ({
        ...item,
        requirementsVersion: 2,
        baseline: { status: 'required' as const, requirementsVersion: 2 },
      })),
      events: [
        {
          id: 'old-approved-baseline', sessionId: project.id, ts: 10,
          kind: 'work-item-baseline-approved', workItemId: 'task-a', summary: '旧需求基线已批准',
          payload: { workspaceVersion: 'head:old', evidence: '旧需求证据' },
        },
        {
          id: 'requirements-changed-after-approval', sessionId: project.id, ts: 11,
          kind: 'requirements-alignment-required', summary: '需求已变化，旧批准失效',
        },
      ],
      pendingUserQuestion: question,
    });

    initPipeBridge();
    await Promise.resolve();
    await Promise.resolve();

    const unchanged = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(unchanged).toMatchObject({
      status: 'waiting',
      pendingUserQuestion: { id: question.id },
      workItems: [expect.objectContaining({ baseline: { status: 'required', requirementsVersion: 2 } })],
    });
  });

  it('accepts budget-exhausted only after the renewable window is actually exhausted', () => {
    const project = bindProjectLaneToWorkItem();
    const escalation = {
      outcome: 'needs-human', proposalKind: 'important', escalationBoundary: 'budget-exhausted',
      reason: '阶段自主裁决预算即将耗尽', impact: '需要项目 AI 重规划后续阶段',
    };
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: project.workItems[0].id,
      patch: { decisionsUsed: project.workItems[0].contract.budget.maxDecisions - 1 },
    }, project.id);
    expect(decide(escalation)).toMatchObject({
      ok: false, error: expect.stringContaining('预算尚未耗尽'),
    });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: project.workItems[0].id,
      patch: { decisionsUsed: project.workItems[0].contract.budget.maxDecisions },
    }, project.id);
    expect(decide(escalation)).toMatchObject({ ok: true, outcome: 'needs-human' });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0]
      .decisionsUsed).toBe(project.workItems[0].contract.budget.maxDecisions);
  });

  it('names an exhausted task retry budget even while decision capacity remains', () => {
    const project = bindProjectLaneToWorkItem();
    const workItem = project.workItems[0];
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: workItem.id,
      patch: {
        attempts: workItem.contract.budget.maxTaskRetries,
        decisionsUsed: workItem.contract.budget.maxDecisions - 1,
      },
    }, project.id);

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      escalationBoundary: 'budget-exhausted',
      reason: '真实任务失败重试已经达到硬上限',
      impact: '旧工作项不得继续执行新的真实任务重试',
    })).toMatchObject({
      ok: true,
      budgetExhausted: true,
      successorCreated: true,
    });

    const frozen = useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)?.workItems
      .find((candidate) => candidate.id === workItem.id);
    expect(frozen?.latestBlocker).toContain(
      `真实任务失败重试 ${workItem.contract.budget.maxTaskRetries}/${workItem.contract.budget.maxTaskRetries}`,
    );
    expect(frozen?.latestBlocker).not.toContain('监督预算耗尽');
  });

  it('notifies the user when an exhausted execution budget pauses project progress', async () => {
    const project = bindProjectLaneToWorkItem();
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: project.workItems[0].id,
      patch: { decisionsUsed: project.workItems[0].contract.budget.maxDecisions },
    }, project.id);
    const appendRecord = (globalThis.window as any).wmux.projectManager.appendRecord as ReturnType<typeof vi.fn>;

    expect(decide({
      next: '继续执行合同内剩余工作',
      executionAction: 'implementation',
      workspaceVersion: 'head:test',
      evidence: '当前仍有未完成工作',
      contextSummary: '决策预算已耗尽',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('健康窗口'),
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0]
      .decisionsUsed).toBe(project.workItems[0].contract.budget.maxDecisions);

    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.events.find((event) => (
      event.kind === 'guard-triggered' && event.payload?.attentionRequired === true
    )))
      .toMatchObject({
        kind: 'guard-triggered',
        payload: { decision: 'pause', attentionRequired: true },
      });
    await vi.waitFor(() => expect(appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'guard-triggered',
      payload: expect.objectContaining({ decision: 'pause', attentionRequired: true }),
    })));
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: '项目执行护栏需要处理',
    }));
  });

  it('renews an exhausted health window in place when the supervisor proves workspace progress', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-renewed-health-window' });
    const workItem = project.workItems[0];
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: workItem.id,
      patch: {
        decisionsUsed: workItem.contract.budget.maxDecisions,
        totalDecisionsUsed: workItem.contract.budget.maxDecisions,
        startedAt: Date.now(),
        executionHistory: [{
          ts: 1, actionSignature: 'previous-action', commandSignature: 'previous-command',
          errorSignature: '', progressSignature: 'previous-progress', workspaceVersion: 'diff-a',
          changedFiles: ['src/auth.ts'],
        }],
      },
    }, project.id);

    const result = decide({
      next: '继续完成合同内认证实现',
      executionAction: 'implementation',
      workspaceVersion: 'diff-b',
      changedFiles: ['src/auth.ts'],
      diffSummary: '认证实现产生新的可复核工作区差异',
      evidence: 'src/auth.ts 已出现新的认证逻辑差异',
      contextSummary: '当前里程碑继续推进',
    });
    await expect(Promise.resolve(result)).resolves.toMatchObject({ ok: true, outcome: 'continue' });

    const renewed = useStore.getState().projectManagers
      .find((candidate) => candidate.id === project.id)!.workItems[0];
    expect(renewed).toMatchObject({
      status: 'running',
      decisionsUsed: 1,
      totalDecisionsUsed: workItem.contract.budget.maxDecisions + 1,
      budgetWindowRenewals: 1,
    });
    expect(renewed.supersededByWorkItemId).toBeUndefined();
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.events)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'guard-triggered',
          payload: expect.objectContaining({ action: 'autonomy-window-renewed', attentionRequired: false }),
        }),
      ]));
  });

  it('allows one safe proactive follow-up from a project supervisor without a pending review round', () => {
    bindProjectLaneToWorkItem();
    useStore.getState().updateLane('lane-a', {
      autonomousOverride: true,
      autonomyPermissionsOverride: ['same-route-next'],
      awaitingReview: false,
    });

    expect(decide({ next: '执行终审补证并输出可复核证据' })).toMatchObject({
      ok: true,
      outcome: 'continue',
    });
    expect(writes).toHaveBeenCalledWith(
      'worker-a',
      expect.stringContaining('执行终审补证并输出可复核证据'),
    );
    expect(String(writes.mock.calls[0]?.[1] || '')).toContain('wmux context');

    expect(decide({ next: '执行终审补证并输出可复核证据' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('上一条裁决完全相同'),
    });

    agentState = { ...agentState, state: 'working', updatedAt: 2 };
    expect(decide({ next: '根据新增证据完成另一项聚焦检查' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('仍在运行'),
    });
  });

  it('uses only the task contract explicit permission grant without repeated user approval', async () => {
    const project: ProjectManagerSession = {
      id: 'pm-project',
      projectDir: 'E:\\repo',
      goal: '完成目标硬件验证',
      preconditions: ['目标硬件已上电，允许直接运行本项目测试。'],
      planFiles: [],
      doneWhen: ['验证完成'],
      requirementsVersion: 1,
      acceptedRequirementsVersion: 1,
      status: 'active',
      workItems: [{
        id: 'hardware-test',
        title: '目标硬件测试',
        status: 'running',
        dependencies: [],
        supervisorLaneId: 'lane-a',
        workerSurfaceId: 'worker-a',
        attempts: 0,
        decisionsUsed: 0,
        updatedAt: 1,
        executionHistory: [],
        contract: {
          objective: '运行目标硬件资格测试',
          description: '',
          preconditions: [],
          scope: {
            root: 'E:\\repo',
            allowPaths: [],
            denyPaths: [],
            forbiddenActions: ['board-cli flash'],
          },
          authority: {
            technicalChoices: true,
            lowRiskRetries: true,
            targetedTests: true,
            internalThreads: false,
            continuousExecution: true,
            permissionConfirm: true,
            allowedCommandPrefixes: ['board-cli run qualification'],
            authorizedDevices: ['目标硬件'],
            authorizedEnvironments: ['本地资格测试环境'],
            authorizedOperations: ['运行资格测试'],
          },
          stopWhen: ['资格测试完成'],
          validation: ['检查测试证据'],
          budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      }],
      events: [],
      createdAt: 1,
      updatedAt: 1,
    };
    useStore.getState().restoreProjectManager(project);
    approveProjectWorkItemBaseline(project.id, 'hardware-test');
    useStore.getState().updateLane('lane-a', {
      projectManagerProjectId: 'pm-project',
      projectWorkItemId: 'hardware-test',
      autonomousOverride: true,
      autonomyPermissionsOverride: ['same-route-next', 'technical-choice', 'route-adjustment', 'permission-confirm'],
      config: {
        ...useStore.getState().supervisor.lanes[0].config!,
        preconditions: '目标硬件已上电，允许直接运行本项目测试。',
      },
    });
    screenText = 'Permission required: board-cli run qualification';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: board-cli run qualification',
      blockedVersion: 3,
      blockedRequestId: 'board-run-1',
      updatedAt: 2,
    };
    const writeReliable = vi.fn(async (surfaceId: string, data: string) => {
      writes(surfaceId, data);
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 3 };
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;

    await expect(decide({
      permissionCommand: 'board-cli run qualification',
      permissionResponse: 'y',
    })).resolves.toMatchObject({ ok: true, autoAuthorized: true });
    expect(writes).toHaveBeenCalledWith('worker-a', 'y');

    screenText = 'Permission required: git push origin main';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: git push origin main',
      blockedVersion: 4,
      blockedRequestId: 'push-1',
      updatedAt: 3,
    };
    expect(decide({
      permissionCommand: 'git push origin main',
      permissionResponse: 'y',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('推送或重写 Git 历史'),
    });

    screenText = 'Permission required: board-cli flash firmware';
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: board-cli flash firmware',
      blockedVersion: 5,
      blockedRequestId: 'flash-1',
      updatedAt: 4,
    };
    expect(decide({
      permissionCommand: 'board-cli flash firmware',
      permissionResponse: 'y',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('allowedCommandPrefixes'),
    });

    useStore.getState().restoreProjectManager({
      ...useStore.getState().projectManagers.find((session) => session.id === project.id)!,
      requirementsVersion: 2,
      acceptedRequirementsVersion: 1,
      updatedAt: 2,
    });
    screenText = 'Permission required: board-cli run qualification';
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: board-cli run qualification',
      blockedVersion: 6,
      blockedRequestId: 'board-run-2',
      updatedAt: 5,
    };
    expect(decide({
      permissionCommand: 'board-cli run qualification',
      permissionResponse: 'y',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('旧版本授权已经失效'),
    });

    const currentProject = useStore.getState().projectManagers.find((session) => session.id === project.id)!;
    useStore.getState().restoreProjectManager({
      ...currentProject,
      acceptedRequirementsVersion: 2,
      workItems: currentProject.workItems.map((item) => ({
        ...item,
        requirementsVersion: 2,
        contract: {
          ...item.contract,
          authority: { ...item.contract.authority, targetedTests: false },
        },
      })),
      updatedAt: 3,
    });
    useStore.getState().resumeSupervisorLane('lane-a', '测试已显式重绑当前需求版本');
    approveProjectWorkItemBaseline(project.id, 'hardware-test', 2);
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    screenText = 'Permission required: npm test';
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: npm test',
      blockedVersion: 7,
      blockedRequestId: 'test-1',
      updatedAt: 6,
    };
    expect(decide({
      permissionCommand: 'npm test',
      permissionResponse: 'y',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('未授权监督 AI 运行测试'),
    });
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it('revalidates a delayed permission response and cancels Enter after project authorization changes', async () => {
    bindProjectLaneToWorkItem({
      permissionConfirm: true,
      allowedCommandPrefixes: ['board-cli run qualification'],
    });
    screenText = 'Permission required: board-cli run qualification [y/n]';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: board-cli run qualification',
      blockedVersion: 9,
      blockedRequestId: 'delayed-permission-1',
      updatedAt: 2,
    };
    let releaseSubmit: (() => void) | undefined;
    (globalThis.window as any).setTimeout = (callback: () => void) => {
      releaseSubmit = callback;
      return 1;
    };
    const writeReliable = vi.fn(async (surfaceId: string, data: string) => {
      writes(surfaceId, data);
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;

    const pending = decide({
      permissionCommand: 'board-cli run qualification',
      permissionResponse: 'y',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseSubmit).toBeTypeOf('function');
    useStore.getState().pauseSupervisorLane('lane-a', '用户已更新前置条件');
    releaseSubmit?.();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('通道已暂停'),
    });
    expect(writeReliable).toHaveBeenCalledWith('worker-a', 'y');
    expect(writeReliable).toHaveBeenCalledWith('worker-a', '\x15');
    expect(writeReliable).not.toHaveBeenCalledWith('worker-a', '\r');
  });

  it('stops automatically confirming the same command after two consecutive permission blocks', async () => {
    bindProjectLaneToWorkItem({
      permissionConfirm: true,
      allowedCommandPrefixes: ['board-cli run qualification'],
    });
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: agentState.updatedAt + 1 };
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    screenText = 'Permission required: board-cli run qualification [y/n]';

    for (let round = 1; round <= 2; round += 1) {
      agentState = {
        state: 'blocked',
        blockedReason: 'permission: board-cli run qualification',
        blockedVersion: round,
        blockedRequestId: `repeat-permission-${round}`,
        updatedAt: round,
      };
      useStore.getState().updateLane('lane-a', { awaitingReview: true });
      await expect(decide({
        permissionCommand: 'board-cli run qualification',
        permissionResponse: 'y',
      })).resolves.toMatchObject({ ok: true, autoAuthorized: true });
    }

    agentState = {
      state: 'blocked',
      blockedReason: 'permission: board-cli run qualification',
      blockedVersion: 3,
      blockedRequestId: 'repeat-permission-3',
      updatedAt: 3,
    };
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({
      permissionCommand: 'board-cli run qualification',
      permissionResponse: 'y',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('连续自动确认 2 次'),
    });
    expect(writeReliable).toHaveBeenCalledTimes(4);
  });

  it('keeps ordinary supervision closed when there is no pending review round', () => {
    useStore.getState().updateLane('lane-a', { awaitingReview: false });

    expect(decide({ next: '普通监督尝试主动补证' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('当前没有待裁决轮次'),
    });
  });

  it('atomically releases the project task binding when the project manager stops its supervisor', async () => {
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
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const request = (globalThis.window as any).__wmux_projectManagerRequest;

    const stopped = await request({
      action: 'supervisor-decide',
      callerSurfaceId: managerSurfaceId,
      projectId: project.id,
      approvalId: approval.id,
      decision: 'stop',
    });
    expect(stopped, JSON.stringify(stopped)).toMatchObject({
      ok: true,
      message: expect.stringContaining('解除终端绑定'),
    });

    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id))
      .toMatchObject({
        taskTerminalSurfaceId: undefined,
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

  it('lets the owning project manager close a supervisor decision without bypassing the supervisor', async () => {
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    const started = await remote({
      action: 'start',
      projectDir: 'E:\\project-decision',
      goal: '完成项目监督互锁验证',
      preconditions: ['无额外人工前置条件'],
      doneWhen: ['项目监督可以继续推进'],
    });
    const projectId = started.session.id;
    await confirmAndResumeProject(projectId);
    const session = useStore.getState().projectManagers.find((project) => project.id === projectId)!;
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'task-create', callerSurfaceId: session.managerSurfaceId, projectId,
      workItem: {
        id: 'decision_task', title: '互锁验证', status: 'planned', dependencies: [],
        contract: {
          objective: '验证项目监督待决项可由项目管理 AI 闭合', description: '', preconditions: [],
          scope: { root: 'E:\\project-decision', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['互锁解除'], validation: ['检查监督状态'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    })).resolves.toMatchObject({ ok: true });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: 'decision_task',
      patch: { supervisorLaneId: 'lane-a', workerSurfaceId: 'worker-a' },
    }, projectId);
    approveProjectWorkItemBaseline(projectId, 'decision_task');
    useStore.getState().updateLane('lane-a', {
      projectManagerProjectId: projectId,
      projectWorkItemId: 'decision_task',
      autonomousOverride: true,
      config: {
        ...useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a')?.config!,
        waitForNextDirection: true,
      },
    });
    writes.mockClear();

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      escalationBoundary: 'contract-change',
      next: '在既有范围内采用候选方案并补充聚焦验证',
      reason: '需要项目管理 AI 选择项目内技术路线',
      impact: '选择会改变当前任务合同的实现路线',
      alternatives: '方案 A：补充聚焦验证；方案 B：调整内部实现',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    expect(approval).toBeDefined();
    const deliveredNotice = writes.mock.calls.find(([surfaceId, text]) => (
      surfaceId === session.managerSurfaceId && String(text).includes(`待决 ID：${approval.id}`)
    ))?.[1];
    const queuedNotice = useStore.getState().projectManagers
      .find((project) => project.id === projectId)?.pendingManagerDeliveries
      ?.find((delivery) => delivery.text.includes(`待决 ID：${approval.id}`))?.text;
    const managerNotice = String(deliveredNotice || queuedNotice || '');
    expect(managerNotice).toContain(`--approval ${approval.id}`);
    expect(managerNotice).toContain('--selection');
    const decisionTransition = useStore.getState().projectManagers
      .find((project) => project.id === projectId)?.pendingSupervisorTransitions
      ?.find((transition) => transition.kind === 'decision-required');
    expect(decisionTransition).toBeDefined();
    await expect(request({
      action: 'transition-ack', callerSurfaceId: session.managerSurfaceId, projectId,
      transitionId: decisionTransition?.id, resolution: 'replanned',
      summary: '只在文字中采纳方案但尚未关闭待决项',
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('必须先执行 wmux project decide'),
    });
    expect(decide({ outcome: 'continue', next: '尝试绕过待决项继续' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('待项目管理 AI 处理的决策项'),
    });
    await expect(request({
      action: 'status', callerSurfaceId: session.managerSurfaceId, projectId,
    })).resolves.toMatchObject({
      ok: true,
      session: {
        managedSupervisors: [expect.objectContaining({
          pendingDecisionCount: 1,
          pendingDecisions: [expect.objectContaining({ approvalId: approval.id })],
        })],
      },
    });
    const ordinaryRemoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    expect(ordinaryRemoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('项目管理模式') });

    useStore.getState().setOrdinarySupervisorLanes([{
      ...lane(),
      id: 'lane-b',
      label: 'ordinary-worker',
      surfaceId: 'worker-b' as any,
      supervisorSurfaceId: 'supervisor-b' as any,
    }]);
    useStore.getState().pauseSupervisorLane('lane-a', '验证项目专属监督暂停隔离');
    expect(useStore.getState().applyProjectManagerAction({
      type: 'reset-work-item-baseline', workItemId: 'decision_task',
      reason: '模拟合同补充后结构化基线需要重新协调',
    }, projectId)).toMatchObject({ ok: true });
    writes.mockClear();
    await expect(request({
      action: 'supervisor-decide', callerSurfaceId: session.managerSurfaceId, projectId,
      approvalId: approval.id, decision: 'direct', task: '保留当前方案，只补充最小聚焦验证',
    })).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('交给 worker 的专属 AI 监督'),
    });
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a'))
      .toMatchObject({ controlState: 'active' });
    expect(queuedOwnerDecision()?.text).toContain('[项目管理 AI 决定]');
    expect(queuedOwnerDecision()?.text).toContain('baseline.status=required');
    expect(queuedOwnerDecision()?.text).toContain('下一步只能先提交一次以 [项目基线调查] 开头');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ awaitingReview: true });
    expect(useStore.getState().projectManagers.find((project) => project.id === projectId)?.workItems[0]?.status)
      .not.toBe('running');
    await expect(request({
      action: 'transition-ack', callerSurfaceId: session.managerSurfaceId, projectId,
      transitionId: decisionTransition?.id, resolution: 'replanned',
      summary: '决定已提交，但监督 Agent 尚未确认接收',
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('等待专属监督 Agent 确认接收'),
    });

    expect(decide({
      outcome: 'needs-human', proposalKind: 'important', escalationBoundary: 'external-blocker',
      reason: '旧监督回合又尝试创建待决项',
    })).toMatchObject({ ok: true, duplicate: true, awaitingOwnerDecisionDelivery: true });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(decide({ outcome: 'continue', next: '尚未消费上级决定就继续' })).toMatchObject({
      ok: false, awaitingOwnerDecisionDelivery: true,
    });
    consumeQueuedOwnerDecision();
    expect(useStore.getState().projectManagers.find((project) => project.id === projectId)?.workItems[0])
      .toMatchObject({ status: 'running', latestBlocker: undefined });
    expect(useStore.getState().projectManagers.find((project) => project.id === projectId)
      ?.pendingSupervisorTransitions?.some((transition) => transition.id === decisionTransition?.id)).toBe(false);
    expect(useStore.getState().projectManagers.find((project) => project.id === projectId)?.events)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'supervisor-transition-acknowledged',
          payload: expect.objectContaining({
            transitionId: decisionTransition?.id,
            automatic: true,
          }),
        }),
      ]));
    approveProjectWorkItemBaseline(projectId, 'decision_task');

    writes.mockClear();
    expect(decide({
      outcome: 'continue',
      next: '执行最小聚焦验证并报告证据',
      stagePlanFile: '.wmux/tmp/manager-decision-plan.json',
      stagePlan: {
        selectedRoute: '保留当前方案并补充最小聚焦验证',
        milestones: [{ id: 'focused_validation', title: '聚焦验证', outcome: '形成可复核验证证据', status: 'active' }],
        expectedPaths: [], targetedValidation: [], serializedBoundaries: [],
        remainingWork: ['完成聚焦验证'],
      },
    }))
      .toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledWith(
      'worker-a',
      expect.stringContaining('执行最小聚焦验证并报告证据'),
    );
    expect(String(writes.mock.calls[0]?.[1] || '')).toContain('wmux context');

    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      escalationBoundary: 'external-blocker',
      next: '重新选择聚焦验证方案',
      reason: '外部测试环境已失效，旧证据需要重新核对',
      impact: '当前任务无法在本地恢复该外部环境',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    const expiredApproval = useStore.getState().supervisor.pendingApprovals[0];
    expiredApproval.createdAt = Date.now() - 25 * 60 * 60 * 1000;
    useStore.getState().pauseSupervisorLane('lane-a', '测试保留待决项后暂停通道');
    writes.mockClear();
    await expect(request({
      action: 'supervisor-decide', callerSurfaceId: session.managerSurfaceId, projectId,
      approvalId: expiredApproval.id, decision: 'approve',
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('旧等待状态已解除'),
    });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a'))
      .toMatchObject({ awaitingReview: false, controlState: 'active' });
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a')
      ?.pendingSupervisorDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'control-message', text: expect.stringContaining('[待决项已过期｜重新核对]') }),
    ]));
    consumeQueuedControlMessage();

    useStore.getState().updateLane('lane-a', {
      awaitingReview: true,
      contextRecoveryStatus: 'draft-pending',
    });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'context-recovery',
      escalationBoundary: 'external-blocker',
      next: '恢复步骤：\n1. 读取既有检查结果。\n2. 只执行尚未完成的聚焦验证。',
      reason: '需要确认恢复上下文',
      impact: '旧任务上下文已经丢失，监督 AI 无法验证隐含状态',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    const recoveryApproval = useStore.getState().supervisor.pendingApprovals[0];
    writes.mockClear();
    await expect(request({
      action: 'supervisor-decide', callerSurfaceId: session.managerSurfaceId, projectId,
      approvalId: recoveryApproval.id, decision: 'approve',
    })).resolves.toMatchObject({ ok: true });
    expect(queuedOwnerDecision()?.text).toContain('[项目管理 AI 决定]');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      contextRecoveryStatus: 'sent',
    });
    consumeQueuedOwnerDecision();

    writes.mockClear();
    const completionToken = await completionEvidenceToken();
    expect(decide({
      outcome: 'complete',
      reason: '聚焦验证已经通过',
      evidence: '相关回归测试通过且 diff 已核对',
      testResult: '相关回归测试全部通过',
      changedFiles: ['src/auth.ts'],
      workspaceVersion: 'head:test,diff:auth-v2',
      completionStopWhen: '1',
      completionValidation: '1',
      remainingWork: 'none',
      completionFile: '.wmux/tmp/manager-decision-completion.json',
      completionEvidenceToken: completionToken,
      completionChecklist: {
        stopWhen: [
          { index: 1, status: 'satisfied', result: 'passed', method: 'runtime-test', evidence: '监督互锁已经解除', evidenceRefs: ['evidence/result.json'] },
          { index: 2, status: 'satisfied', result: 'passed', method: 'runtime-test', evidence: '项目监督已恢复合同内推进能力', evidenceRefs: ['evidence/result.json'] },
        ],
        validation: [{ index: 1, status: 'satisfied', result: 'passed', method: 'runtime-test', evidence: '相关测试结果与 diff 已核对', evidenceRefs: ['evidence/result.json'] }],
        remainingWork: [],
      },
      stagePlanFile: '.wmux/tmp/manager-decision-complete.json',
      stagePlan: {
        selectedRoute: '保留当前方案并补充最小聚焦验证',
        milestones: [{
          id: 'focused_validation', title: '聚焦验证', outcome: '形成可复核验证证据',
          status: 'completed', evidence: '相关回归测试通过且 diff 已核对',
        }],
        expectedPaths: ['src/auth.ts'], targetedValidation: [], serializedBoundaries: [],
        remainingWork: [],
      },
    })).toMatchObject({ ok: true, outcome: 'complete', waiting: true, handoff: true });
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a'))
      .toMatchObject({ controlState: 'waiting' });
    await vi.waitFor(() => {
      const delivered = writes.mock.calls.some(([surfaceId, text]) => (
        surfaceId === session.managerSurfaceId && String(text).includes('[项目专属监督状态交接')
      ));
      const queued = useStore.getState().projectManagers.find((project) => project.id === projectId)
        ?.pendingManagerDeliveries?.some((delivery) => delivery.text.includes('[项目专属监督状态交接'));
      expect(delivered || queued).toBe(true);
    });
    expect(useStore.getState().projectManagers.find((project) => project.id === projectId)?.workItems[0])
      .toMatchObject({
        status: 'validating',
        latestEvidence: '相关回归测试通过且 diff 已核对',
        latestBlocker: undefined,
        completion: {
          summary: '聚焦验证已经通过',
          validation: ['检查监督状态'],
          evidence: '相关回归测试通过且 diff 已核对',
          completedAt: expect.any(Number),
        },
      });
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a')?.decisions?.[0])
      .toMatchObject({
        outcome: 'complete',
        completion: { summary: '聚焦验证已经通过', completedAt: expect.any(Number) },
      });
    expect(useStore.getState().projectManagers.find((project) => project.id === projectId)?.events)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'supervisor-handoff', workItemId: 'decision_task' })]));

    await expect(request({
      action: 'task-terminal-rotate', callerSurfaceId: 'supervisor-a', projectId,
      workItemId: 'decision_task',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('普通下一阶段') });
    useStore.getState().replaceAllWorkspaces([
      ...useStore.getState().workspaces,
      {
        id: 'ws-project-handoff-worker' as any,
        title: '阶段交接任务终端',
        cwd: 'E:\\project-decision',
        splitTree: {
          type: 'leaf' as const,
          paneId: 'pane-project-handoff-worker' as any,
          activeSurfaceIndex: 0,
          surfaces: [
            {
              id: 'worker-a' as any,
              type: 'terminal' as const,
              shell: 'pwsh.exe',
              projectManagerProjectId: projectId,
              projectManagerWorkItemId: 'decision_task',
            },
            {
              id: 'supervisor-a' as any,
              type: 'terminal' as const,
              shell: 'pi',
              transientSupervisor: true,
              projectSupervisorProjectId: projectId,
            },
          ],
        },
      },
    ]);
    const previousContinuousWindowStartedAt = Date.now() - 91 * 60_000;
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'decision_task',
      patch: { startedAt: previousContinuousWindowStartedAt },
    }, projectId);
    const budgetUsageBeforeResume = useStore.getState().projectManagers.find((project) => project.id === projectId)
      ?.workItems.find((item) => item.id === 'decision_task');
    useStore.getState().updateLane('lane-a', { unreportedIdleRecoveryAttempts: 2 });
    const reopened = await request({
      action: 'task-update', callerSurfaceId: session.managerSurfaceId, projectId,
      workItemId: 'decision_task', patch: {
        status: 'running',
        latestContextSummary: '项目 AI 复核后要求补充一个阶段级验收场景',
      },
    });
    expect(reopened, JSON.stringify(reopened)).toMatchObject({ ok: true });
    writes.mockClear();
    await expect(request({
      action: 'task-supervise', callerSurfaceId: session.managerSurfaceId, projectId,
      workItemId: 'decision_task',
    })).resolves.toMatchObject({
      ok: true, recovered: true, resumedFromWaiting: true, laneId: 'lane-a',
    });
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a'))
      .toMatchObject({
        controlState: 'active', stopConfirmed: false, projectTaskContractPending: true,
        unreportedIdleRecoveryAttempts: 0,
      });
    expect(useStore.getState().projectManagers.find((project) => project.id === projectId)
      ?.workItems.find((item) => item.id === 'decision_task')).toMatchObject({
        startedAt: expect.any(Number),
        decisionsUsed: budgetUsageBeforeResume?.decisionsUsed,
        attempts: budgetUsageBeforeResume?.attempts,
      });
    expect(useStore.getState().projectManagers.find((project) => project.id === projectId)
      ?.workItems.find((item) => item.id === 'decision_task')?.startedAt)
      .toBeGreaterThan(previousContinuousWindowStartedAt);
    expect(queuedControlText()).toContain('[项目 AI 续接阶段目标');
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

  it('reconciles a legacy decision transition only after later persisted facts prove continuation', () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-transition-reconcile' });
    const transition = {
      id: 'transition-old-decision',
      laneId: 'lane-a',
      workItemId: 'task-a',
      kind: 'decision-required' as const,
      eventType: 'supervisor.approval.requested',
      summary: '等待项目内技术决定',
      createdAt: 10,
      notifiedAt: 10,
      notificationCount: 1,
    };
    useStore.getState().restoreProjectManager({
      ...project,
      pendingSupervisorTransitions: [transition],
      events: [],
    });
    expect(reconcileResolvedProjectDecisionTransitions(project.id)).toEqual([]);
    expect(useStore.getState().projectManager?.pendingSupervisorTransitions).toHaveLength(1);

    useStore.getState().restoreProjectManager({
      ...useStore.getState().projectManager!,
      events: [{
        id: 'event-direction', sessionId: project.id, ts: 20,
        kind: 'supervisor-direction', workItemId: 'task-a',
        summary: '专属监督已确认项目决定并继续',
      }],
    });
    expect(reconcileResolvedProjectDecisionTransitions(project.id)).toEqual([transition.id]);
    expect(useStore.getState().projectManager?.pendingSupervisorTransitions).toEqual([]);
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'supervisor-transition-acknowledged',
        payload: expect.objectContaining({ reconciledFromLaterFacts: true }),
      }),
    ]));
  });

  it('gives the project AI one bounded main-goal continuation before escalating a stopped chain', async () => {
    const project = bindProjectLaneToWorkItem({
      projectId: 'pm-deadlock-intervention', continuousExecution: true,
    });
    const managerSurfaceId = 'project-manager-deadlock';
    useStore.getState().restoreProjectManager({ ...project, managerSurfaceId: managerSurfaceId as any });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-deadlock' as any,
      title: '项目死等测试',
      cwd: project.projectDir,
      transientSupervisorWorkspace: true,
      splitTree: {
        type: 'leaf' as const,
        paneId: 'pane-deadlock' as any,
        activeSurfaceIndex: 0,
        surfaces: [
          {
            id: managerSurfaceId as any,
            type: 'terminal' as const,
            shell: 'pwsh.exe',
            projectManagerTerminal: true,
            projectManagerProjectId: project.id,
            projectManagerAgent: 'codex',
          },
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
    }]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;
    const transition = await remote({
      action: 'event', projectId: project.id, laneId: 'lane-a', workItemId: 'task-a',
      eventType: 'supervisor.decision-error-loop',
      summary: '监督裁决协议错误重复，执行链已经暂停',
      payload: { blocker: '基线批准参数连续被协议门禁拒绝' },
    });
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    const pausedUpdate = await request({
      action: 'task-update', callerSurfaceId: managerSurfaceId, projectId: project.id,
      workItemId: 'task-a', patch: {
        status: 'paused', latestBlocker: '基线批准参数连续被协议门禁拒绝',
      },
    });
    expect(pausedUpdate.error).toBeUndefined();
    expect(pausedUpdate).toMatchObject({ ok: true, pausedSupervisorLaneIds: ['lane-a'] });
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === 'lane-a'))
      .toMatchObject({ controlState: 'paused' });
    (globalThis.window as any).__wmux_getAgentStates = () => ({
      'worker-a': agentState,
      [managerSurfaceId]: {
        state: 'working', blockedReason: null, blockedVersion: 0, updatedAt: Date.now(),
      },
    });
    await expect(request({
      action: 'transition-ack', callerSurfaceId: managerSurfaceId, projectId: project.id,
      transitionId: transition.transitionId, resolution: 'paused',
      summary: '当前监督和任务执行链均已暂停',
    })).resolves.toMatchObject({
      ok: true,
      resolution: 'paused',
    });
    const continued = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id);
    expect(continued).toMatchObject({ status: 'active' });
    expect(continued?.pendingUserQuestion).toBeUndefined();
    expect(continued?.pendingManagerDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('主目标仍有可内部消解的执行义务') }),
    ]));
    expect(continued?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'guard-triggered',
        payload: expect.objectContaining({
          attentionRequired: false,
          action: 'project-active-obligation-continuation',
          obligation: 'resume-paused',
        }),
      }),
    ]));
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)
      ?.pendingSupervisorTransitions).toEqual([]);

    expect((globalThis.window as any).wmux.notification.fire).not.toHaveBeenCalledWith(expect.objectContaining({
      title: '项目需要你的处理',
    }));

    await expect(request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId,
      projectId: project.id, workItemId: 'task-a',
    })).resolves.toMatchObject({ ok: true, recovered: true, laneId: 'lane-a' });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0])
      .toMatchObject({ status: 'running', latestBlocker: undefined });
    expect(useStore.getState().supervisor.lanes.find((lane) => lane.id === 'lane-a'))
      .toMatchObject({ controlState: 'active' });
    expect(queuedControlText()).toContain('项目专属监督恢复');
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

  it('enforces project anti-loop limits on supervisor decisions', () => {
    const store = useStore.getState();
    store.startProjectManager({ projectDir: 'E:\\repo', goal: '完成认证', preconditions: ['无额外物理前置条件'], doneWhen: ['认证测试通过'] });
    store.applyProjectManagerAction({
      type: 'resume-project', reason: '测试已完成项目需求对齐', acceptRequirementsVersion: true,
    });
    store.applyProjectManagerAction({
      type: 'create-work-item',
      workItem: {
        id: 'auth', title: '认证', status: 'running', dependencies: [], attempts: 0, decisionsUsed: 0,
        supervisorPlanRequired: false,
        startedAt: Date.now(), updatedAt: Date.now(), executionHistory: [], workerSurfaceId: 'worker-a', supervisorLaneId: 'lane-a',
        contract: {
          objective: '完成认证', description: '', preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: ['src/auth'], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['认证测试通过'], validation: ['npm test -- auth'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    });
    approveProjectWorkItemBaseline(useStore.getState().projectManagers[0].id, 'auth');
    store.updateLane('lane-a', {
      projectManagerProjectId: useStore.getState().projectManagers[0].id,
      projectWorkItemId: 'auth',
      autonomousOverride: true,
    });
    const projectEvent = vi.fn(async () => ({ ok: true }));
    (globalThis.window as any).__wmux_projectManagerRemoteControl = projectEvent;

    const retry = {
      outcome: 'rework',
      next: '按相同方式重试认证测试',
      executionAction: '重试认证测试',
      command: 'npm test -- auth',
      error: 'expected 200 received 500',
      retryKind: 'task-failure',
      workspaceVersion: 'diff-a',
      testCommand: 'npm test -- auth',
      testResult: 'failed',
    };
    expect(decide(retry)).toMatchObject({ ok: true });
    expect(projectEvent).not.toHaveBeenCalled();
    store.updateLane('lane-a', { awaitingReview: true });
    expect(decide(retry)).toMatchObject({ ok: true });
    store.updateLane('lane-a', { awaitingReview: true });
    expect(decide(retry)).toMatchObject({ ok: false, error: expect.stringContaining('相同动作和错误') });
    expect(writes).toHaveBeenCalledTimes(2);
    expect(useStore.getState().projectManager?.workItems[0]).toMatchObject({
      status: 'waiting-decision', attempts: 2, decisionsUsed: 2,
    });
  });

  it('does not charge command, runtime, or execution-window corrections as task retries', () => {
    const project = bindProjectLaneToWorkItem();
    const base = {
      next: '修正命令入口后继续同一批次',
      executionAction: '修正测试命令入口',
      retry: true,
      workspaceVersion: 'diff-a',
      diffSummary: '上一命令在进程启动前失败；本轮只修正调用方式',
      evidence: '终端证据确认零测试执行、零设备动作',
      contextSummary: '保持当前实现和验收不变',
    };

    expect(decide(base)).toMatchObject({
      ok: false,
      error: expect.stringContaining('--retry-kind'),
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0])
      .toMatchObject({ attempts: 0, decisionsUsed: 0 });

    expect(decide({ ...base, retryKind: 'command-correction' })).toMatchObject({ ok: true });
    let updated = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0];
    expect(updated).toMatchObject({ attempts: 0, decisionsUsed: 1 });
    expect(updated?.executionHistory.at(-1)).toMatchObject({ retryKind: 'command-correction' });

    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({
      ...base,
      next: '在新的任务 AI 执行窗口继续同一最小实现',
      executionAction: '续接执行窗口',
      retryKind: 'execution-window',
      diffSummary: '上一回合因执行窗口不足结束；零写入、零测试、无执行错误',
    })).toMatchObject({ ok: true });
    updated = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0];
    expect(updated).toMatchObject({ attempts: 0, decisionsUsed: 2 });
    expect(updated?.executionHistory.at(-1)).toMatchObject({ retryKind: 'execution-window' });

    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({
      ...base,
      next: '运行时恢复后继续原批次',
      executionAction: '恢复任务运行时',
      retry: false,
      retryKind: 'runtime-recovery',
      error: 'PTY exited before task execution',
      diffSummary: '任务未启动，恢复同一执行身份',
    })).toMatchObject({ ok: true });
    updated = useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0];
    expect(updated).toMatchObject({ attempts: 0, decisionsUsed: 3 });
    expect(updated?.executionHistory.at(-1)).toMatchObject({ retryKind: 'runtime-recovery' });
  });

  it('requires evidence before a project-managed supervisor can complete work', () => {
    const store = useStore.getState();
    store.startProjectManager({ projectDir: 'E:\\repo', goal: '完成认证', preconditions: ['无额外物理前置条件'], doneWhen: ['认证测试通过'] });
    store.applyProjectManagerAction({
      type: 'resume-project', reason: '测试已完成项目需求对齐', acceptRequirementsVersion: true,
    });
    store.applyProjectManagerAction({
      type: 'create-work-item',
      workItem: {
        id: 'auth', title: '认证', status: 'running', dependencies: [], attempts: 0, decisionsUsed: 0,
        supervisorPlanRequired: false,
        startedAt: Date.now(), updatedAt: Date.now(), executionHistory: [], workerSurfaceId: 'worker-a', supervisorLaneId: 'lane-a',
        contract: {
          objective: '完成认证', description: '', preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['认证测试通过'], validation: ['npm test -- auth'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    });
    approveProjectWorkItemBaseline(useStore.getState().projectManagers[0].id, 'auth');
    store.updateLane('lane-a', {
      projectManagerProjectId: useStore.getState().projectManagers[0].id,
      projectWorkItemId: 'auth',
      autonomousOverride: true,
    });
    expect(decide({ outcome: 'complete', next: '' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('--evidence'),
    });
  });

  it('keeps an internal milestone inside the supervisor until the full stage checklist is complete', async () => {
    bindProjectLaneToWorkItem({ continuousExecution: true });
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

    expect(decide({
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

  it('treats waiting for the next prompt as ready for the next supervised batch', () => {
    bindProjectLaneToWorkItem({ continuousExecution: true });
    agentState = {
      state: 'blocked',
      blockedReason: 'Waiting for your next prompt',
      blockedVersion: 7,
      updatedAt: Date.now(),
    };

    expect(decide({
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
    approveProjectWorkItemBaseline(project.id, item.id);
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
    approveProjectWorkItemBaseline(project.id, item.id);
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

  it('defers a transient project escalation while the task AI is still running', () => {
    const project = bindProjectLaneToWorkItem({
      projectId: 'pm-running-baseline-review',
      baselineRequired: true,
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'start-work-item-baseline', workItemId: 'task-a',
    }, project.id)).toMatchObject({ ok: true });
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    agentState = { ...agentState, state: 'working', updatedAt: Date.now() };

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      escalationBoundary: 'external-blocker',
      reason: '任务终端仍在执行唯一的只读项目基线调查，尚未产生项目基线报告',
      impact: '当前不能向运行终端注入下一步，只能等待可裁决检查点',
    })).toMatchObject({
      ok: true,
      deferred: true,
      waitingForTaskCompletion: true,
    });
    expect(useStore.getState().supervisor.pendingApprovals).toEqual([]);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      controlState: 'active', awaitingReview: false,
    });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0])
      .toMatchObject({ status: 'running', baseline: { status: 'investigating' }, decisionsUsed: 0 });
  });

  it('automatically resumes a mistakenly paused baseline review when the task end hook arrives', () => {
    const project = bindProjectLaneToWorkItem({
      projectId: 'pm-paused-baseline-review',
      baselineRequired: true,
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'start-work-item-baseline', workItemId: 'task-a',
    }, project.id)).toMatchObject({ ok: true });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'task-a',
      patch: { status: 'paused', latestBlocker: '等待控制层提供可裁决检查点' },
    }, project.id);
    useStore.getState().pauseSupervisorLane('lane-a', '项目 AI 暂停瞬时阻塞裁决');
    useStore.getState().enqueueApproval({
      laneId: 'lane-a',
      surfaceId: 'worker-a' as any,
      laneLabel: 'worker',
      source: 'supervisor-important',
      proposalKind: 'important',
      text: '控制层要求裁决，但任务终端仍在执行唯一基线调查，需等待可裁决检查点',
      reason: '任务终端正在运行且尚无项目基线报告',
      impact: '不能向运行终端注入下一步',
    });

    (globalThis.window as any).__wmux_noteManagedAgentHook({ surfaceId: 'worker-a', event: 'Stop' });

    expect(useStore.getState().supervisor.pendingApprovals).toEqual([]);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ controlState: 'active' });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0])
      .toMatchObject({ status: 'running', latestBlocker: undefined, baseline: { status: 'investigating' } });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.events)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        kind: 'supervisor-status',
        payload: expect.objectContaining({ action: 'resume-deferred-task-review' }),
      })]));
  });

  it('keeps a paused baseline blocked when a real user approval supersedes the transient one', () => {
    const project = bindProjectLaneToWorkItem({
      projectId: 'pm-paused-baseline-with-user-approval',
      baselineRequired: true,
    });
    expect(useStore.getState().applyProjectManagerAction({
      type: 'start-work-item-baseline', workItemId: 'task-a',
    }, project.id)).toMatchObject({ ok: true });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'task-a',
      patch: { status: 'paused', latestBlocker: '等待控制层提供可裁决检查点' },
    }, project.id);
    useStore.getState().pauseSupervisorLane('lane-a', '项目 AI 暂停监督裁决');
    useStore.getState().enqueueApproval({
      laneId: 'lane-a',
      surfaceId: 'worker-a' as any,
      laneLabel: 'worker',
      source: 'supervisor-important',
      proposalKind: 'important',
      text: '任务终端仍在执行唯一基线调查，需等待可裁决检查点',
      reason: '任务终端正在运行且尚无项目基线报告',
      impact: '不能向运行终端注入下一步',
    });
    useStore.getState().enqueueApproval({
      laneId: 'lane-a',
      surfaceId: 'worker-a' as any,
      laneLabel: 'worker',
      source: 'supervisor-important',
      proposalKind: 'important',
      text: '需要用户插入硬件测试密钥后才能继续',
      reason: '缺少只有用户持有的物理密钥',
      impact: '无法执行硬件验收',
    });

    (globalThis.window as any).__wmux_noteManagedAgentHook({ surfaceId: 'worker-a', event: 'Stop' });

    expect(useStore.getState().supervisor.pendingApprovals).toEqual([
      expect.objectContaining({ text: expect.stringContaining('硬件测试密钥') }),
    ]);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ controlState: 'paused' });
    expect(useStore.getState().projectManagers.find((candidate) => candidate.id === project.id)?.workItems[0])
      .toMatchObject({ status: 'paused', baseline: { status: 'investigating' } });
  });

  it('still escalates a real external blocker after the task AI is no longer running', () => {
    bindProjectLaneToWorkItem({ projectId: 'pm-real-external-blocker' });
    agentState = { ...agentState, state: 'idle', updatedAt: Date.now() };

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      escalationBoundary: 'external-blocker',
      reason: '外部测试环境凭据已经失效',
      impact: '本地无法恢复该外部环境',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
  });

  it('rejects a project-managed supervisor decision outside the task contract', () => {
    const store = useStore.getState();
    store.startProjectManager({ projectDir: 'E:\\repo', goal: '完成认证', preconditions: ['无额外物理前置条件'], doneWhen: ['认证测试通过'] });
    store.applyProjectManagerAction({
      type: 'resume-project', reason: '测试已完成项目需求对齐', acceptRequirementsVersion: true,
    });
    store.applyProjectManagerAction({
      type: 'create-work-item',
      workItem: {
        id: 'auth', title: '认证', status: 'running', dependencies: [], attempts: 0, decisionsUsed: 0,
        supervisorPlanRequired: false,
        startedAt: Date.now(), updatedAt: Date.now(), executionHistory: [], workerSurfaceId: 'worker-a', supervisorLaneId: 'lane-a',
        contract: {
          objective: '完成认证', description: '', preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: ['src/auth'], denyPaths: ['src/payments'], forbiddenActions: ['git push'] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, continuationBoundary: 'project-owned-decision', permissionConfirm: false },
          stopWhen: ['认证测试通过'], validation: ['npm test -- auth'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    });
    approveProjectWorkItemBaseline(useStore.getState().projectManagers[0].id, 'auth');
    store.updateLane('lane-a', {
      projectManagerProjectId: useStore.getState().projectManagers[0].id,
      projectWorkItemId: 'auth',
      autonomousOverride: true,
    });

    expect(decide({
      next: '继续修改支付模块', executionAction: '修改支付模块', changedFiles: 'src/payments/card.ts',
    })).toMatchObject({ ok: false, error: expect.stringContaining('禁止路径') });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().projectManager?.workItems[0]).toMatchObject({ status: 'waiting-decision' });
    expect(useStore.getState().projectManager?.pendingSupervisorTransitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'project-action-required',
        eventType: 'supervisor.contract-violation',
        workItemId: 'auth',
      }),
    ]));
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
      error: expect.stringContaining('必须携带明确的 --next'),
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

  it('queues a context recovery draft for user confirmation without writing to the worker', () => {
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
    })).toMatchObject({ ok: true, outcome: 'needs-human' });

    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.pendingApprovals[0]).toMatchObject({
      source: 'supervisor-context-recovery',
      proposalKind: 'context-recovery',
      text: recoveryText,
    });
    expect(useStore.getState().supervisor.lanes[0].contextRecoveryStatus).toBe('awaiting-confirmation');
  });

  it('sends the exact context recovery draft only after user approval', () => {
    useStore.getState().updateLane('lane-a', {
      contextRecoveryStatus: 'draft-pending',
      restoreSource: { surfaceId: 'worker-old', label: '旧任务', sessionId: 'sup-old' },
      restoredHistory: '已完成基础实现，下一步恢复测试',
      restoredFromSessionId: 'sup-old',
    });
    const recoveryText = '请恢复当前任务，并按主线程统筹、子线程执行测试的分工继续。';
    expect(decide({
      outcome: 'needs-human', proposalKind: 'context-recovery',
      reason: '请确认恢复指令', next: recoveryText,
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: '已确认上下文恢复指令并发送到 worker。' });
    expect(writes).toHaveBeenCalledWith('worker-a', recoveryText);
    expect(writes).toHaveBeenCalledWith('worker-a', '\r');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      contextRecoveryStatus: 'sent', awaitingReview: false, currentTask: recoveryText,
    });
  });

  it('rejects a context recovery proposal when the lane did not request recovery', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'context-recovery',
      reason: '请确认恢复指令',
      next: '恢复旧任务',
    })).toMatchObject({ ok: false, error: expect.stringContaining('没有等待拟定') });
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
  });

  it('rejects permission confirmation without a current permission block', () => {
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects unsafe or malformed permission confirmations', () => {
    agentState = { state: 'blocked', blockedReason: 'permission: command', blockedVersion: 1, updatedAt: 2 };
    expect(decide({ permissionCommand: 'git push origin main', permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'maybe' })).toMatchObject({ ok: false });
    expect(decide({ permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y', next: '继续任务' })).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
  });

  it('rejects generic permission placeholders even when the screen contains the same words', () => {
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
    expect(queuedOwnerDecision()?.text).not.toContain('[用户选择]');
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

  it('sends user-entered decision information directly to the worker terminal', () => {
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
      message: '已将用户决策直接发送到 worker，并记录为人工裁决。',
    });
    expect(writes).toHaveBeenCalledWith('worker-a', '保持现有 API，先补充回归测试');
    expect(writes).toHaveBeenCalledWith('worker-a', '\r');
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.any(String));
    expect(JSON.stringify(appendRecord.mock.calls)).not.toContain('保持现有 API，先补充回归测试');
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: false,
      currentTask: '保持现有 API，先补充回归测试',
    });
  });

  it('keeps the direct decision pending when the worker terminal already has a draft', () => {
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
      ok: false,
      error: expect.stringContaining('输入框已有未提交内容'),
    });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
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

  it('prevents hold-and-wait and replay, requires release evidence, and quarantines failed owners', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-worker-lock', workItemId: 'worker_task' });
    const assignments: ProjectWorkerAssignment[] = [
      {
        workerId: 'worker-main', role: 'integrator', outcome: '集成', dependencies: ['worker-tests'],
        writeClaims: ['src'], resourceClaims: ['device-a'], validation: ['检查集成'],
      },
      {
        workerId: 'worker-tests', role: 'worker', outcome: '验证', dependencies: [],
        writeClaims: ['tests'], resourceClaims: ['device-a', 'device-b'], validation: ['运行测试'],
      },
    ];
    const decision = resolveProjectParallelismDecision({
      execution: {
        taskWorkMode: 'single-thread', parallelismSelection: 'worker-group', modeReason: '隔离验证',
        mainThreadResponsibility: '集成', childThreadResponsibilities: [],
      },
      stagePlan: { workerAssignments: assignments },
      requirementsVersion: 1,
    });
    const workerGroup = createProjectWorkerGroup({ decision, assignments, now: 10 });
    workerGroup.workers = workerGroup.workers.map((worker) => ({ ...worker, status: 'running' }));
    const resourceLeases: ProjectResourceLease[] = [
      {
        leaseId: 'lease-main', resourceId: 'device-a', mode: 'exclusive-write',
        ownerWorkerId: 'worker-main', operationId: 'main-op', status: 'in-use',
        idempotent: false, grantedAt: 10, updatedAt: 10,
      },
      {
        leaseId: 'lease-tests', resourceId: 'device-b', mode: 'exclusive-write',
        ownerWorkerId: 'worker-tests', operationId: 'tests-op', status: 'in-use',
        idempotent: false, grantedAt: 10, updatedAt: 10,
      },
    ];
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'worker_task',
      patch: { parallelismDecision: decision, workerGroup, resourceLeases, finalApplyBlocked: true },
    }, project.id);
    useStore.getState().updateLane('lane-a', {
      projectWorkerId: 'worker-tests', projectWorkerRole: 'worker',
      projectWorkerExecutionEpoch: decision.executionEpoch,
    });
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    const acquire = {
      action: 'worker-resource-acquire', callerSurfaceId: 'supervisor-a', projectId: project.id,
      workItemId: 'worker_task', workerId: 'worker-tests', resourceId: 'device-a',
      mode: 'exclusive-write', operationId: 'wait-op',
    };
    await expect(request(acquire)).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('禁止持有并等待多个资源'),
    });
    await expect(request({
      action: 'worker-resource-release', callerSurfaceId: 'supervisor-a', projectId: project.id,
      workItemId: 'worker_task', workerId: 'worker-tests', leaseId: 'lease-tests',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('核验证据') });
    await expect(request({
      action: 'worker-resource-release', callerSurfaceId: 'supervisor-a', projectId: project.id,
      workItemId: 'worker_task', workerId: 'worker-tests', leaseId: 'lease-tests', evidence: '接口已关闭且设备空闲',
    })).resolves.toMatchObject({ ok: true });
    await expect(request({
      ...acquire, resourceId: 'device-b', operationId: 'tests-op',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('禁止自动重放') });
    const firstWait = await request(acquire);
    expect(firstWait).toMatchObject({ ok: true, waiting: true });
    const requestedAt = useStore.getState().projectManagers.find((entry) => entry.id === project.id)
      ?.workItems[0].workerGroup?.workers.find((worker) => worker.workerId === 'worker-tests')?.resourceWait?.requestedAt;
    await expect(request(acquire)).resolves.toMatchObject({ ok: true, waiting: true, reused: true });
    expect(useStore.getState().projectManagers.find((entry) => entry.id === project.id)
      ?.workItems[0].workerGroup?.workers.find((worker) => worker.workerId === 'worker-tests')?.resourceWait?.requestedAt)
      .toBe(requestedAt);
    await expect(request({
      action: 'worker-status', callerSurfaceId: 'supervisor-a', projectId: project.id,
      workItemId: 'worker_task', workerId: 'worker-tests', status: 'superseded',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('不得自行切换') });
    await expect(request({
      action: 'worker-status', callerSurfaceId: 'supervisor-a', projectId: project.id,
      workItemId: 'worker_task', workerId: 'worker-tests', status: 'failed', checkpoint: '运行时退出',
    })).resolves.toMatchObject({ ok: true, status: 'failed' });
    expect(useStore.getState().projectManagers.find((entry) => entry.id === project.id)?.workItems[0]
      .workerGroup?.workers.find((worker) => worker.workerId === 'worker-tests'))
      .toMatchObject({ status: 'failed', resourceWait: undefined });
    useStore.getState().updateLane('lane-a', {
      projectWorkerId: 'worker-main', projectWorkerRole: 'integrator',
      projectWorkerExecutionEpoch: decision.executionEpoch,
    });
    await expect(request({
      action: 'worker-status', callerSurfaceId: 'supervisor-a', projectId: project.id,
      workItemId: 'worker_task', workerId: 'worker-main', status: 'failed', checkpoint: '集成运行时退出',
    })).resolves.toMatchObject({ ok: true, status: 'failed' });
    const updated = useStore.getState().projectManagers.find((entry) => entry.id === project.id)?.workItems[0];
    expect(updated?.resourceLeases?.find((lease) => lease.leaseId === 'lease-tests'))
      .toMatchObject({ status: 'released', evidence: '接口已关闭且设备空闲' });
    expect(updated?.resourceLeases?.find((lease) => lease.leaseId === 'lease-main'))
      .toMatchObject({ status: 'quarantined' });
    expect((globalThis.window as any).__wmux_roleContext({ callerSurfaceId: 'supervisor-a' }))
      .toMatchObject({
        workerGroup: {
          activeLeases: expect.arrayContaining([
            expect.objectContaining({ leaseId: 'lease-main', status: 'quarantined' }),
          ]),
        },
      });
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

  it('keeps escalated direct-user instructions pending until a real rebind is recorded', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-worker-directive', workItemId: 'worker_task' });
    const assignments: ProjectWorkerAssignment[] = [
      {
        workerId: 'worker-main', role: 'integrator', outcome: '集成', dependencies: ['worker-tests'],
        writeClaims: ['src'], resourceClaims: [], validation: ['检查集成'],
      },
      {
        workerId: 'worker-tests', role: 'worker', outcome: '验证', dependencies: [],
        writeClaims: ['tests'], resourceClaims: [], validation: ['运行测试'],
      },
    ];
    const decision = resolveProjectParallelismDecision({
      execution: {
        taskWorkMode: 'single-thread', parallelismSelection: 'worker-group', modeReason: '隔离验证',
        mainThreadResponsibility: '集成', childThreadResponsibilities: [],
      },
      stagePlan: { workerAssignments: assignments },
      requirementsVersion: 1,
    });
    const workerGroup = createProjectWorkerGroup({ decision, assignments, now: 10 });
    workerGroup.workers = workerGroup.workers.map((worker) => ({ ...worker, status: 'running' }));
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'worker_task', patch: {
        parallelismDecision: decision,
        workerGroup,
        finalApplyBlocked: true,
        userDirectives: [{
          directiveId: 'directive-risk', workerId: 'worker-tests', directiveEpoch: 1,
          assignmentVersion: 1, executionEpoch: decision.executionEpoch, requirementsVersion: 1,
          authorizationVersion: 1,
          exactTextAvailable: true, exactText: '改为操作生产设备', classification: 'pending',
          reconciliationStatus: 'pending', receivedAt: 20,
        }],
      },
    }, project.id);
    useStore.getState().updateLane('lane-a', {
      projectWorkerId: 'worker-tests', projectWorkerRole: 'worker',
      projectWorkerExecutionEpoch: decision.executionEpoch,
    });
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'worker-directive-reconcile', callerSurfaceId: 'supervisor-a', projectId: project.id,
      workItemId: 'worker_task', workerId: 'worker-tests', directiveId: 'directive-risk',
      classification: 'high-risk', reason: '生产设备操作超出当前授权',
    })).resolves.toMatchObject({ ok: true, escalated: true });
    expect(useStore.getState().projectManagers.find((entry) => entry.id === project.id)?.workItems[0])
      .toMatchObject({
        status: 'waiting-decision', finalApplyBlocked: true,
        userDirectives: [expect.objectContaining({ classification: 'high-risk', reconciliationStatus: 'pending' })],
      });

    useStore.getState().restoreProjectManager({
      ...useStore.getState().projectManagers.find((entry) => entry.id === project.id)!,
      managerSurfaceId: 'manager-directive' as any,
    });
    useStore.getState().replaceAllWorkspaces([{
      id: 'ws-directive' as any,
      title: 'Project',
      splitTree: {
        type: 'leaf', paneId: 'pane-directive' as any, activeSurfaceIndex: 0,
        surfaces: [
          {
            id: 'manager-directive' as any, type: 'terminal', projectManagerTerminal: true,
            projectManagerProjectId: project.id,
          },
          { id: 'worker-a' as any, type: 'terminal', projectManagerProjectId: project.id, projectManagerWorkItemId: 'worker_task' },
          { id: 'supervisor-a' as any, type: 'terminal', transientSupervisor: true },
        ],
      },
    }]);
    const resolveRequest = {
      action: 'directive-resolve', callerSurfaceId: 'manager-directive', projectId: project.id,
      workItemId: 'worker_task', directiveId: 'directive-risk', resolution: 'rebound',
      reason: '已将生产设备范围纳入新授权版本',
    };
    await expect(request(resolveRequest)).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('授权版本未变化'),
    });
    const current = useStore.getState().projectManagers.find((entry) => entry.id === project.id)!.workItems[0];
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'worker_task', patch: {
        workerGroup: {
          ...current.workerGroup!,
          workers: current.workerGroup!.workers.map((worker) => worker.workerId === 'worker-tests'
            ? { ...worker, assignmentVersion: 2 }
            : worker),
        },
      },
    }, project.id);
    await expect(request(resolveRequest)).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('授权版本未变化'),
    });
    useStore.getState().restoreProjectManager({
      ...useStore.getState().projectManagers.find((entry) => entry.id === project.id)!,
      authorizationVersion: 2,
    });
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'worker_task', patch: { authorizationVersion: 2 },
    }, project.id);
    await expect(request(resolveRequest)).resolves.toMatchObject({ ok: true, resolution: 'rebound' });
    expect(useStore.getState().projectManagers.find((entry) => entry.id === project.id)?.workItems[0]
      .userDirectives?.[0]).toMatchObject({
        reconciliationStatus: 'reconciled', resolution: 'rebound', resolvedAt: expect.any(Number),
      });
  });

  it('keeps final apply blocked when a newer work-item revision arrives during finalization', async () => {
    const project = bindProjectLaneToWorkItem({ projectId: 'pm-worker-finalize-race', workItemId: 'worker_task' });
    const assignments: ProjectWorkerAssignment[] = [
      {
        workerId: 'worker-main', role: 'integrator', outcome: '集成', dependencies: ['worker-tests'],
        writeClaims: ['src'], resourceClaims: [], validation: ['检查集成'],
      },
      {
        workerId: 'worker-tests', role: 'worker', outcome: '验证', dependencies: [],
        writeClaims: ['tests'], resourceClaims: [], validation: ['运行测试'],
      },
    ];
    const decision = resolveProjectParallelismDecision({
      execution: {
        taskWorkMode: 'single-thread', parallelismSelection: 'worker-group', modeReason: '隔离验证',
        mainThreadResponsibility: '集成', childThreadResponsibilities: [],
      },
      stagePlan: { workerAssignments: assignments },
      requirementsVersion: 1,
    });
    const workerGroup = createProjectWorkerGroup({ decision, assignments, now: 10 });
    workerGroup.workers = workerGroup.workers.map((worker) => ({ ...worker, status: 'completed' }));
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item', workItemId: 'worker_task', patch: {
        parallelismDecision: decision,
        workerGroup,
        finalApplyBlocked: true,
        mergeCandidates: [{
          candidateId: 'candidate-tests', workerId: 'worker-tests', assignmentVersion: 1,
          directiveEpoch: 0, baselineCommit: 'base', patchHash: 'patch', changedFiles: ['tests/result.ts'],
          evidence: ['测试通过'], status: 'applied', createdAt: 10, updatedAt: 10,
        }],
      },
    }, project.id);
    useStore.getState().updateLane('lane-a', {
      projectWorkerId: 'worker-main', projectWorkerRole: 'integrator',
      projectWorkerExecutionEpoch: decision.executionEpoch,
    });
    (globalThis.window as any).wmux.projectManager.finalizeWorkerGroup = vi.fn(async () => {
      useStore.getState().applyProjectManagerAction({
        type: 'update-work-item', workItemId: 'worker_task', patch: {
          finalApplyBlocked: true,
          latestContextSummary: '回填期间收到新的用户方向',
        },
      }, project.id);
      return { ok: true, patchHash: 'final-patch' };
    });
    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'worker-finalize', callerSurfaceId: 'supervisor-a', projectId: project.id,
      workItemId: 'worker_task', workerId: 'worker-main',
    })).resolves.toMatchObject({ ok: false, applied: true, error: expect.stringContaining('保留最终应用锁') });
    expect(useStore.getState().projectManagers.find((entry) => entry.id === project.id)?.workItems[0])
      .toMatchObject({ finalApplyBlocked: true, latestContextSummary: '回填期间收到新的用户方向' });
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
