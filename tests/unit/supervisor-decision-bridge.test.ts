import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initPipeBridge,
  permissionCommandMatchesEvidence,
  projectMessageChangeSignal,
  readTerminalScreen,
  terminalConversationExcerpt,
  terminalScreenExcerpt,
  terminalSupervisorCoreExcerpt,
} from '../../src/renderer/pipe-bridge';
import { surfaceTerminalRegistry } from '../../src/renderer/hooks/useTerminal';
import { useStore } from '../../src/renderer/store';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';
import {
  DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
  PROJECT_MANAGER_TERMINAL_NAME,
} from '../../src/shared/project-manager-terminal';
import { SUPERVISOR_NO_DECISION_OPTION } from '../../src/shared/supervisor-decision-options';
import {
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
} from '../../src/renderer/terminal-runtime-lifecycle';
import {
  effectiveSupervisorAutonomyPermissions,
  PROJECT_MANAGER_WORKSPACE_TITLE,
} from '../../src/renderer/supervisor/protocol';

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
  await expect(request({
    action: 'goal-plan', callerSurfaceId: session?.managerSurfaceId, projectId,
    reason: '测试阶段计划',
    subgoals: [{
      id: 'test_stage', title: '完成测试目标', outcome: '测试目标形成可验收结果',
      acceptance: ['按项目完成条件验收'], dependencies: [], status: 'planned',
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
    progressSnapshot: progressSnapshot(),
    progressSync: {
      status: 'ready', checkedAt: 1, snapshotFingerprint: 'test-progress',
      summary: '测试项目现状已同步', changeCount: 0,
    },
    status: 'active',
    workItems: [{
      id: workItemId,
      requirementsVersion: 1,
      authorizationVersion: 1,
      baseline: options.baselineRequired
        ? { status: 'required', requirementsVersion: 1 }
        : {
            status: 'approved', requirementsVersion: 1, workspaceVersion: 'head:test',
            evidence: '测试夹具已提供项目基线', approvedAt: 1,
          },
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
  await expect(request({
    action: 'task-supervise',
    callerSurfaceId: session?.managerSurfaceId,
    projectId,
    workItemId,
  })).resolves.toMatchObject({ ok: true, waitingForSupervisorTaskTerminal: true });
  const pendingLane = useStore.getState().supervisor.lanes.find((lane) => (
    lane.projectManagerProjectId === projectId && lane.projectWorkItemId === workItemId
  ));
  expect(pendingLane).toMatchObject({
    projectTaskStartupPending: true,
    supervisorSurfaceId: expect.any(String),
    surfaceId: expect.stringContaining('project-task-pending-'),
    autonomousOverride: true,
    workScopeOverride: 'project',
    forbiddenActionsOverride: expect.any(Array),
  });
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
            stageInputFile: vi.fn(async () => ({ reference: '.wmux/tmp/terminal-input-1234-abcd1234.txt' })),
          },
          notification: { fire: vi.fn() },
          projectManager: {
            ensureSkill: vi.fn(async () => ({
              ok: true,
              runtimeDir: 'E:\\wmux-data\\project-manager\\runtime',
            })),
            saveSession: vi.fn(async () => ({ ok: true })),
            captureProgress: vi.fn(async () => ({ ok: true, snapshot: progressSnapshot() })),
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
    useStore.getState().setProjectSupervisorLanes([]);
    useStore.getState().resetOrdinarySupervisorSession();
    useStore.getState().restoreProjectManager(null);
    useStore.getState().replaceAllWorkspaces([]);
    useStore.getState().setWorkspacePrefs({ projectManagementAgents: DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG });
    surfaceTerminalRegistry.delete('worker-a');
    surfaceTerminalRegistry.delete('supervisor-a');
    surfaceTerminalRegistry.delete('project-manager-atomic');
    clearTerminalRuntimeStatus('project-manager-atomic');
    Reflect.deleteProperty(globalThis, 'window');
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

  it('defers repeated project progress inspections without writing into a working supervisor', async () => {
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
    })).resolves.toMatchObject({ ok: true, deferred: true });
    await expect(request({
      action: 'supervisor-inspect',
      callerSurfaceId: managerSurfaceId,
      projectId: project.id,
      reason: '再次询问同一进度',
    })).resolves.toMatchObject({ ok: true, deferred: true });

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
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'progress-sync-required' }),
      expect.objectContaining({ kind: 'progress-sync-acknowledged' }),
    ]));
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

  it.each(['Codex', 'Claude Code', 'Kimi Code', 'Grok Build', 'Pi Agent', 'OpenCode'])(
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
      action: 'start', projectDir: 'E:\\repo', goal: '完成项目', doneWhen: ['测试通过'],
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('preconditions'),
    });

    await expect(projectRemoteControl({
      action: 'start', projectDir: 'E:\\repo', goal: '完成项目', preconditions: ['无额外物理前置条件'], doneWhen: ['测试通过'],
    })).resolves.toMatchObject({ ok: true, session: { goal: '完成项目', status: 'waiting' } });

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

    await expect(projectRequest({
      action: 'alignment-confirm', callerSurfaceId: surface?.id,
      projectId: useStore.getState().projectManager?.id,
      goalUnderstanding: '完成当前仓库项目',
      scopeSummary: '仅修改 E:\\repo 内的认证功能',
      acceptanceSummary: '相关测试通过且结果可复核',
      reason: '目标、范围和验收标准均已明确',
    })).resolves.toMatchObject({ ok: true, event: { kind: 'requirements-alignment-confirmed' } });
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
        id: 'external_auth', title: '错误绑定', status: 'planned', dependencies: [], workerSurfaceId: 'worker-a',
        contract: {
          objective: '不应接管现有终端', description: '', preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
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
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
          stopWhen: ['认证测试通过'], validation: ['npm test -- auth'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      },
    })).resolves.toMatchObject({ ok: true });
    expect(useStore.getState().projectManager?.workItems[0]).toMatchObject({
      attempts: 0,
      decisionsUsed: 0,
      baseline: { status: 'required', requirementsVersion: 1 },
    });
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
    expect(useStore.getState().projectManagerDialogOpen).toBe(true);

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
      action: 'update-definition', projectId: project.id, goal: '无效新目标',
      preconditions: ['测试环境可用'], doneWhen: [], mode: 'pivot',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('完成条件') });
    expect(useStore.getState().projectManager?.pendingUserQuestion?.id).toBe(questionId);

    await expect(remote({
      action: 'update-definition', projectId: project.id, goal: '有效新目标',
      preconditions: ['测试环境可用'], doneWhen: ['新目标验收通过'], mode: 'pivot',
    })).resolves.toMatchObject({
      ok: true,
      event: { payload: { supersededQuestionId: questionId } },
      session: { pendingUserQuestion: undefined },
    });
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
    expect(useStore.getState().projectManagerDialogOpen).toBe(true);
    expect((globalThis.window as any).wmux.projectManager.appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user-clarification-requested',
    }));
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
    })).resolves.toMatchObject({ ok: true, event: { kind: 'project-paused' } });

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
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
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
  });

  it('rebuilds a restored project AI and records recovery without forcing a new user question', async () => {
    const persisted = {
      id: 'pm-unaccepted-recovery', projectDir: 'E:\\unaccepted-recovery',
      goal: '测试相关功能', preconditions: ['无'], planFiles: [], doneWhen: ['做个管理系统'],
      status: 'active' as const, workItems: [], events: [], createdAt: 1, updatedAt: 2,
    };
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await remote({ action: 'recovery-candidates' });
    await expect(remote({ action: 'restore-projects', projectIds: [persisted.id] })).resolves.toMatchObject({
      ok: true, restored: true, projects: [{ id: persisted.id, status: 'active' }],
    });
    expect(useStore.getState().projectManager?.pendingUserQuestion).toBeUndefined();
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

  it('keeps one project message pending until its flattened body and final Enter are acknowledged', async () => {
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
    expect(body).toContain('桌面项目管理消息');
    expect(body).toContain('继续保持暂停，等待新的复核结果。');
    expect(body).not.toMatch(/[\r\n]/u);
    expect(writeReliable.mock.calls[1]).toEqual([managerSurfaceId, '\r']);
    expect(useStore.getState().projectManager?.pendingManagerDeliveries).toHaveLength(1);

    acknowledgeEnter?.(true);
    await vi.waitFor(() => expect(useStore.getState().projectManager?.pendingManagerDeliveries).toHaveLength(0));
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
    expect(useStore.getState().supervisor.lanes.find((candidate) => candidate.id === 'lane-a')?.controlState)
      .toBe('paused');
    expect(current?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user-message',
        correlationId: 'condition-change-1',
        payload: expect.objectContaining({ changeSignal: 'prerequisite-change' }),
      }),
    ]));
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
      status: 'active',
      taskTerminalSurfaceId: 'old-worker',
      workItems: [{
        id: 'recover_task', title: '恢复任务', status: 'running', dependencies: [],
        requirementsVersion: 1,
        baseline: {
          status: 'approved', requirementsVersion: 1, workspaceVersion: 'head:before-restart',
          evidence: '重启前已审核项目基线', approvedAt: 15,
        },
        workerSurfaceId: 'old-worker', supervisorLaneId: 'old-lane', attempts: 1, decisionsUsed: 2,
        startedAt: 12, updatedAt: 18, executionHistory: [],
        latestContextSummary: '已完成核心实现，剩余针对性测试。',
        latestEvidence: 'src/core.ts 已修改并通过静态检查。',
        contract: {
          objective: '完成恢复任务', description: '从持久化检查点续作', preconditions: [],
          scope: { root: 'E:\\recover-project', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
          stopWhen: ['针对性测试通过'], validation: ['检查 diff'], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
        },
      }],
      events: [],
      createdAt: 10,
      updatedAt: 20,
    };
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue([persisted]);
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
      candidates: [{ id: 'pm-recover', projectDir: 'E:\\recover-project', goal: '继续上次项目' }],
    });
    expect(useStore.getState().projectManagers).toEqual([]);
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.projectManagerTerminal)).toBe(false);

    await expect(remote({ action: 'restore-projects' })).resolves.toMatchObject({
      ok: true, restored: true, projects: [{ id: 'pm-recover' }],
    });
    expect(useStore.getState().projectManager).toMatchObject({
      id: 'pm-recover', managerSurfaceId: expect.any(String), recoveryState: 'checking',
      progressSync: { status: 'review-required' },
      taskTerminalSurfaceId: undefined,
      workItems: [{
        id: 'recover_task', status: 'waiting-decision', workerSurfaceId: undefined,
        supervisorLaneId: undefined, startedAt: undefined,
        baseline: { status: 'required', requirementsVersion: 1 },
        latestContextSummary: expect.stringContaining('核心实现'),
      }],
    });
    expect(useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).some((surface) => surface.projectManagerTerminal)).toBe(true);
    expect(JSON.stringify(useStore.getState().projectManager?.pendingManagerDeliveries))
      .toContain('旧项目 AI、监督 AI、任务 AI 及其 surfaceId 都已失效');

    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'progress-sync',
      callerSurfaceId: useStore.getState().projectManager?.managerSurfaceId,
      projectId: 'pm-recover',
      acknowledge: true,
      summary: '已核对当前工作树，保留核心实现并重新执行剩余针对性验证',
    })).resolves.toMatchObject({ ok: true });
    const { created, lane } = await startTaskThroughDedicatedSupervisor('pm-recover', 'recover_task');
    const recoveredSurface = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.id === created.surfaceId);
    expect(recoveredSurface).toMatchObject({
      projectManagerProjectId: 'pm-recover', projectManagerWorkItemId: 'recover_task',
    });
    const recoveredLaunch = JSON.stringify({
      startupCommands: recoveredSurface?.startupCommands,
      startupInput: recoveredSurface?.startupInput,
    });
    expect(recoveredLaunch).toContain('项目任务 AI 冷启动');
    expect(recoveredLaunch).not.toContain('old-worker');
    const recoveryDeliveries = JSON.stringify([
      ...writes.mock.calls,
      ...(globalThis.window as any).wmux.pty.stageInputFile.mock.calls,
    ]);
    expect(recoveryDeliveries).toContain('项目任务冷启动恢复包');
    expect(recoveryDeliveries).toContain('已完成核心实现');
    expect(lane?.surfaceId).toBe(created.surfaceId);
    expect(useStore.getState().projectManager?.workItems[0].workerSurfaceId).toBe(created.surfaceId);
    expect(useStore.getState().projectManager?.recoveryState).toBe('ready');
    expect(useStore.getState().projectManager?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'recovery-restored', summary: expect.stringContaining('建立新 AI 监督') }),
    ]));
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
        workItems: [], events: [], createdAt: 11, updatedAt: 20,
      },
    ];
    (globalThis.window as any).wmux.projectManager.listActiveSessions.mockResolvedValue(persisted);
    const remote = (globalThis.window as any).__wmux_projectManagerRemoteControl;

    await expect(remote({ action: 'restore-projects', projectIds: ['pm-history-missing'] })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('已失效'),
    });
    expect(useStore.getState().projectManagers).toEqual([]);

    await expect(remote({ action: 'restore-projects', projectIds: ['pm-history-b'] })).resolves.toMatchObject({
      ok: true,
      restored: true,
      projects: [{ id: 'pm-history-b', projectDir: 'E:\\history-b' }],
    });
    expect(useStore.getState().projectManagers.map((project) => project.id)).toEqual(['pm-history-b']);
    expect((globalThis.window as any).wmux.projectManager.deleteSession).not.toHaveBeenCalled();
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
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
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
      startupCommands: ["kimi --model 'k3' --thinking # wmux-automated-agent-task"],
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
        authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
        stopWhen: [`${id} 完成`], validation: [`验证 ${id}`], budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
      },
    });
    await expect(request({
      action: 'task-create', callerSurfaceId: managerSurfaceId, projectId,
      workItem: workItem('first_task'),
    })).resolves.toMatchObject({ ok: true });
    const first = await startTaskThroughDedicatedSupervisor(projectId, 'first_task');
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
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
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

  it('creates an isolated project-AI session without a count or directory-uniqueness cap', async () => {
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
    await expect(start('e:\\project-a\\', '同目录独立项目')).resolves.toMatchObject({ ok: true, restored: false });
    await expect(start('E:\\project-b', '项目 B')).resolves.toMatchObject({ ok: true });
    await expect(start('E:\\project-c', '项目 C')).resolves.toMatchObject({ ok: true });
    await expect(start('E:\\project-d', '项目 D')).resolves.toMatchObject({ ok: true });

    expect(useStore.getState().projectManagers.map((session) => session.projectDir)).toEqual([
      'E:\\project-a', 'e:\\project-a\\', 'E:\\project-b', 'E:\\project-c', 'E:\\project-d',
    ]);
    const managerSurfaceIds = useStore.getState().projectManagers.map((session) => session.managerSurfaceId);
    expect(managerSurfaceIds.every(Boolean)).toBe(true);
    expect(new Set(managerSurfaceIds).size).toBe(5);
    const managerWorkspaces = useStore.getState().workspaces.filter((workspace) => (
      workspace.splitTree.type === 'leaf'
      && workspace.splitTree.surfaces.some((surface) => surface.projectManagerTerminal === true)
    ));
    expect(managerWorkspaces).toHaveLength(5);
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
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
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
      preconditions: ['设备已断电并确认安全'], doneWhen: ['测试通过'],
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
          scope: { root: 'E:\\rotation', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
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
    const { created: initialTask, lane: previousLane } = await startTaskThroughDedicatedSupervisor(projectId, 'rotation_task');
    expect(previousLane?.surfaceId).toBe(initialTask.surfaceId);
    expect(previousLane?.surfaceId).not.toBe('worker-a');
    expect(previousLane?.config?.preconditions).toContain('设备已断电并确认安全');
    expect(effectiveSupervisorAutonomyPermissions(
      useStore.getState().supervisor,
      previousLane!,
    )).not.toContain('permission-confirm');
    expect(writes).toHaveBeenCalledWith(
      previousLane?.supervisorSurfaceId,
      expect.stringContaining('[项目级前置条件｜已确认且持续有效]'),
    );
    expect(writes).toHaveBeenCalledWith(
      previousLane?.supervisorSurfaceId,
      expect.stringContaining('不得每一步重新询问、重新授权或要求重复取证'),
    );
    const supervisorSurface = useStore.getState().workspaces.flatMap((workspace) => (
      workspace.splitTree.type === 'leaf' ? workspace.splitTree.surfaces : []
    )).find((surface) => surface.id === previousLane?.supervisorSurfaceId);
    expect(supervisorSurface?.startupCommands?.[0]).toContain('\\supervisor\\runtime\\');
    expect(supervisorSurface?.startupCommands?.[0]).toContain(
      "$env:WMUX_SUPERVISOR_PROJECT_DIR = 'E:\\rotation'",
    );
    expect(supervisorSurface?.startupCommands?.[0]).toMatch(
      /; codex --model 'gpt-5\.6-terra' --config model_reasoning_effort='high'$/,
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
    await expect(request({
      action: 'task-supervise', callerSurfaceId: managerSurfaceId,
      projectId,
      workItemId: 'rotation_task',
    })).resolves.toMatchObject({
      ok: true,
      waitingForSupervisorTaskTerminal: true,
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
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
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
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
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

  it('injects one safe next step from ordinary supervision', () => {
    expect(decide({ next: '运行相关单元测试' })).toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledWith('worker-a', '运行相关单元测试');
    expect(decide({ next: '重复发送下一步' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(1);
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
    const next = '继续检查当前实现并分段运行相关测试。'.repeat(120);
    const writeReliable = vi.fn(async (surfaceId: string, data: string) => {
      writes(surfaceId, data);
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 2 };
      else screenText = data;
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({ next })).resolves.toMatchObject({
      ok: true,
      outcome: 'continue',
      delivery: { confirmed: true, agentState: 'working' },
    });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', next],
      ['worker-a', '\r'],
    ]);
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(false);
  });

  it('flattens a multi-line next step even when the terminal reports bracketed paste', async () => {
    (surfaceTerminalRegistry.get('worker-a') as any).modes = { bracketedPasteMode: true };
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 2 };
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({ next: '先检查实现\n再运行测试' })).resolves.toMatchObject({ ok: true });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', '先检查实现 再运行测试'],
      ['worker-a', '\r'],
    ]);
  });

  it('flattens a multi-line next step when bracketed paste is unavailable', async () => {
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 2 };
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({ next: '先检查实现\n再运行测试' })).resolves.toMatchObject({ ok: true });
    expect(writeReliable.mock.calls).toEqual([
      ['worker-a', '先检查实现 再运行测试'],
      ['worker-a', '\r'],
    ]);
  });

  it('keeps review open when PTY accepts input but terminal state and screen do not change', async () => {
    const writeReliable = vi.fn(async () => true);
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({ next: '运行相关单元测试' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('agent-state'),
      delivery: { confirmed: false, agentState: 'idle', screenChanged: false },
    });
    expect(writeReliable).toHaveBeenCalledWith('worker-a', '运行相关单元测试');
    expect(writeReliable).toHaveBeenCalledWith('worker-a', '\r');
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      autoDecisionsUsed: 0,
      decisions: [],
    });
  });

  it('does not treat an unrelated screen repaint as delivery confirmation', async () => {
    const writeReliable = vi.fn(async (_surfaceId: string, data: string) => {
      if (data === '\r') screenText = '后台日志刷新，但任务状态未变化';
      return true;
    });
    (globalThis.window as any).wmux.pty.writeReliable = writeReliable;
    useStore.getState().patchSupervisor({ submitEnter: true });

    await expect(decide({ next: '运行相关单元测试' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('仅检测到屏幕变化'),
      delivery: { confirmed: false, agentState: 'idle', screenChanged: true },
    });
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(true);
  });

  it('serializes decisions while one delivery is still in flight', async () => {
    let acceptBody: ((accepted: boolean) => void) | undefined;
    const writeReliable = vi.fn((_surfaceId: string, data: string) => {
      if (data === '第一条裁决') {
        return new Promise<boolean>((resolve) => { acceptBody = resolve; });
      }
      if (data === '\r') agentState = { ...agentState, state: 'working', updatedAt: 2 };
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
      ['worker-a', '第一条裁决'],
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
  });

  it('routes project-managed approvals internally without notifying the user', () => {
    bindProjectLaneToWorkItem();

    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '需要项目管理 AI 选择下一条技术路线',
      reason: '两条路线都在任务边界内',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
    expect((globalThis.window as any).wmux.notification.fire).not.toHaveBeenCalled();
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
    expect(writes).toHaveBeenCalledWith('worker-a', '执行终审补证并输出可复核证据');

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
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
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
      next: '在既有范围内采用候选方案并补充聚焦验证',
      reason: '需要项目管理 AI 选择项目内技术路线',
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
    expect(writes).toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[项目管理 AI 决定]'));
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ awaitingReview: true });
    expect(useStore.getState().projectManagers.find((project) => project.id === projectId)?.workItems[0])
      .toMatchObject({ status: 'running', latestBlocker: undefined });

    writes.mockClear();
    expect(decide({ outcome: 'continue', next: '执行最小聚焦验证并报告证据' }))
      .toMatchObject({ ok: true, outcome: 'continue' });
    expect(writes).toHaveBeenCalledWith('worker-a', '执行最小聚焦验证并报告证据');

    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '重新选择聚焦验证方案',
      reason: '旧证据需要重新核对',
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
    expect(writes).toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[待决项已过期｜重新核对]'));

    useStore.getState().updateLane('lane-a', {
      awaitingReview: true,
      contextRecoveryStatus: 'draft-pending',
    });
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'context-recovery',
      next: '恢复步骤：\n1. 读取既有检查结果。\n2. 只执行尚未完成的聚焦验证。',
      reason: '需要确认恢复上下文',
    })).toMatchObject({ ok: true, outcome: 'needs-human' });
    const recoveryApproval = useStore.getState().supervisor.pendingApprovals[0];
    writes.mockClear();
    await expect(request({
      action: 'supervisor-decide', callerSurfaceId: session.managerSurfaceId, projectId,
      approvalId: recoveryApproval.id, decision: 'approve',
    })).resolves.toMatchObject({ ok: true });
    expect(writes).toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[项目管理 AI 决定]'));
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      contextRecoveryStatus: 'sent',
    });

    writes.mockClear();
    expect(decide({
      outcome: 'complete',
      reason: '聚焦验证已经通过',
      evidence: '相关回归测试通过且 diff 已核对',
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
      .toMatchObject({ status: 'validating', latestEvidence: '相关回归测试通过且 diff 已核对', latestBlocker: undefined });
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
      .toMatchObject({ controlState: 'active', stopConfirmed: false, projectTaskContractPending: true });
    expect(useStore.getState().projectManagers.find((project) => project.id === projectId)
      ?.workItems.find((item) => item.id === 'decision_task')).toMatchObject({
        startedAt: expect.any(Number),
        decisionsUsed: budgetUsageBeforeResume?.decisionsUsed,
        attempts: budgetUsageBeforeResume?.attempts,
      });
    expect(useStore.getState().projectManagers.find((project) => project.id === projectId)
      ?.workItems.find((item) => item.id === 'decision_task')?.startedAt)
      .toBeGreaterThan(previousContinuousWindowStartedAt);
    expect((globalThis.window as any).wmux.pty.stageInputFile)
      .toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[项目 AI 续接阶段目标'));
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

    const request = (globalThis.window as any).__wmux_projectManagerRequest;
    await expect(request({
      action: 'transition-ack', callerSurfaceId: managerSurfaceId, projectId: project.id,
      transitionId: first.transitionId, resolution: 'accepted',
      summary: '阶段证据充分，已验收并准备下一阶段目标',
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
        startedAt: Date.now(), updatedAt: Date.now(), executionHistory: [], workerSurfaceId: 'worker-a', supervisorLaneId: 'lane-a',
        contract: {
          objective: '完成认证', description: '', preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: ['src/auth'], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
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
      next: '按相同方式重试认证测试',
      executionAction: '重试认证测试',
      command: 'npm test -- auth',
      error: 'expected 200 received 500',
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
    expect(useStore.getState().projectManager?.workItems[0]).toMatchObject({ status: 'waiting-decision' });
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
        startedAt: Date.now(), updatedAt: Date.now(), executionHistory: [], workerSurfaceId: 'worker-a', supervisorLaneId: 'lane-a',
        contract: {
          objective: '完成认证', description: '', preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: [], denyPaths: [], forbiddenActions: [] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
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
        startedAt: Date.now(), updatedAt: Date.now(), executionHistory: [], workerSurfaceId: 'worker-a', supervisorLaneId: 'lane-a',
        contract: {
          objective: '完成认证', description: '', preconditions: [],
          scope: { root: 'E:\\repo', allowPaths: ['src/auth'], denyPaths: ['src/payments'], forbiddenActions: ['git push'] },
          authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false, continuousExecution: false, permissionConfirm: false },
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
    });
    expect(appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'supervisor.waiting-for-direction',
      payload: expect.objectContaining({
        reason: '当前阶段测试已经通过',
        stopWhen: '当前阶段测试通过',
      }),
    }));
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith({
      surfaceId: 'worker-a',
      title: 'AI 监督待续',
      text: 'AI 监督通道“worker”已进入待续；直接在对应 AI 监督终端说明新方案即可继续。',
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

  it('does not append a supervisor next step to an unsubmitted user draft', () => {
    screenText = '│ > 用户尚未提交的任务草稿';
    const terminal = surfaceTerminalRegistry.get('worker-a') as any;
    terminal.buffer.active.cursorX = screenText.length;

    expect(decide({ next: '监督建议的下一步' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('输入框已有未提交内容'),
    });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ awaitingReview: true });
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
    expect(writes).toHaveBeenCalledWith('worker-a', '选择方案 A：保留现有接口，改用已有适配器并运行本地测试');

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
    expect(writes).toHaveBeenCalledWith('worker-a', '执行 npm install example-package');

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
    expect(writes).toHaveBeenCalledWith(
      'supervisor-a',
      expect.stringContaining('[AI 原建议] 按现有方案完成实现并运行测试'),
    );
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
    expect(writes).toHaveBeenCalledWith(
      'supervisor-a',
      expect.stringContaining('[用户补充信息] 保持现有 API，先补充回归测试'),
    );
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[用户选择]'));
    expect(writes).not.toHaveBeenCalledWith('worker-a', expect.any(String));
  });

  it('keeps the pending approval when delivery to the AI supervisor fails', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '按现有方案完成实现并运行测试',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;
    writes.mockImplementationOnce(() => { throw new Error('supervisor pty closed'); });

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user' }))
      .toMatchObject({ ok: false, error: 'supervisor pty closed' });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
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
    expect(writes).toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[人工决定]'));
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
    expect(writes).toHaveBeenCalledWith(
      'supervisor-a',
      expect.stringContaining('[用户选择] 方案 A'),
    );
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
    expect(writes).toHaveBeenCalledWith(
      'supervisor-a',
      expect.stringContaining('[用户补充信息] 保留现有 API，只补充回归测试'),
    );
    expect(writes).not.toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[用户选择]'));
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
    expect(writes).toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[用户选择] 选项 2'));
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
    expect(writes).toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[会话继续]'));
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
    await vi.waitFor(() => expect([
      ...writes.mock.calls,
      ...(globalThis.window as any).wmux.pty.stageInputFile.mock.calls,
    ].some(([surfaceId, text]) => (
      surfaceId === after.lanes[1].supervisorSurfaceId && String(text).includes('新增终端测试通过')
    ))).toBe(true));
  });
});
