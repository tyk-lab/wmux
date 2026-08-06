import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initPipeBridge } from '../../src/renderer/pipe-bridge';
import { surfaceTerminalRegistry } from '../../src/renderer/hooks/useTerminal';
import { useStore } from '../../src/renderer/store';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';

function lane(): SupervisorLane {
  return {
    id: 'lane-a',
    label: 'worker',
    surfaceId: 'worker-a' as any,
    supervisorSurfaceId: 'supervisor-a' as any,
    projectDir: 'E:\\repo',
    enabled: true,
    steps: [],
    maxAutoSteps: 0,
    autoStepsUsed: 0,
    awaitingStopCheck: false,
    stopConfirmed: false,
    awaitingReview: false,
    autoDecisionsUsed: 0,
    decisions: [],
  };
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
          pty: { write: writes },
          notification: { fire: vi.fn() },
        },
        setTimeout: (callback: () => void) => {
          callback();
          return 1;
        },
        __wmux_getAgentStates: () => ({ 'worker-a': agentState }),
      },
    });
    const store = useStore.getState();
    store.resetSupervisorSession();
    store.setSupervisorLanes([lane()]);
    store.patchSupervisor({
      mode: 'unified',
      autonomous: false,
      submitEnter: false,
      taskGoal: '完成当前测试任务',
    });
    store.startSupervisor();
    expect(useStore.getState().supervisor.lanes[0].awaitingReview).toBe(true);
    initPipeBridge();
  });

  afterEach(() => {
    useStore.getState().resetSupervisorSession();
    useStore.getState().replaceAllWorkspaces([]);
    surfaceTerminalRegistry.delete('worker-a');
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

    expect(remoteControl({ action: 'send', terminal: 'worker-a', task: '继续执行', actor: 'ou-user' }))
      .toMatchObject({ ok: false, code: 'terminal_busy', terminal: { activityState: 'working' } });
    expect(writes).not.toHaveBeenCalled();

    expect(remoteControl({ action: 'send', terminal: 'worker-a', task: '确认后继续执行', actor: 'ou-user', force: true }))
      .toMatchObject({ ok: true });
    expect(writes).toHaveBeenCalledWith('worker-a', '确认后继续执行');
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
      startupCommands: ['codex'],
    });
    expect(directSurface).not.toHaveProperty('startupInput');
    expect(writes).toHaveBeenCalledWith(directSurface?.id, '检查登录流程并补齐测试');

    const listed = JSON.parse(remoteControl({ action: 'list' }).message).terminals.find(
      (terminal: any) => terminal.surfaceId === directSurface?.id,
    );
    expect(listed).toMatchObject({
      label: 'Codex直连 · 修复登录页',
      workspace: '修复登录页',
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
    useStore.getState().patchSupervisor({ taskGoal: '' });

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

  it('keeps the review window open when task delivery fails', () => {
    writes.mockImplementationOnce(() => { throw new Error('pty closed'); });

    expect(decide({ next: '运行相关单元测试' })).toMatchObject({ ok: false, error: expect.stringContaining('pty closed') });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({
      awaitingReview: true,
      autoDecisionsUsed: 0,
      decisions: [],
    });
  });

  it('confirms a low-risk permission without consuming a judgment slot', () => {
    screenText = 'Command: npm test\nContinue? [y/N]';
    agentState = {
      state: 'blocked',
      blockedReason: 'permission: npm test',
      blockedVersion: 1,
      blockedRequestId: 'request-1',
      updatedAt: 2,
    };
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' }))
      .toMatchObject({ ok: true, autoAuthorized: true });
    expect(writes).toHaveBeenNthCalledWith(1, 'worker-a', 'y');
    expect(useStore.getState().supervisor.lanes[0].autoDecisionsUsed).toBe(0);
    useStore.getState().updateLane('lane-a', { awaitingReview: true });
    agentState = { ...agentState, updatedAt: 99 };
    expect(decide({ permissionCommand: 'npm test', permissionResponse: 'y' })).toMatchObject({ ok: false });
    expect(writes).toHaveBeenCalledTimes(2);
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

  it('approves the original proposal without requiring supplemental input', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '按现有方案完成实现并运行测试',
      reason: '需要用户批准当前方案',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'approve', actor: 'ou-user' }))
      .toMatchObject({ ok: true, message: '已批准，AI 监督将按当前建议继续。' });
    expect(writes).toHaveBeenCalledWith('worker-a', '按现有方案完成实现并运行测试');
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
  });

  it('keeps a pending approval when the task terminal already contains a draft', () => {
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
      .toMatchObject({ ok: false, error: expect.stringContaining('输入框已有未提交内容') });
    expect(writes).not.toHaveBeenCalled();
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
  });

  it('requires adjustment guidance and sends it back to the owning AI supervisor', () => {
    expect(decide({
      outcome: 'needs-human',
      proposalKind: 'important',
      next: '改用新框架重写当前模块',
      reason: '需要用户选择调整方向',
    })).toMatchObject({ ok: true });
    const approval = useStore.getState().supervisor.pendingApprovals[0];
    const remoteControl = (globalThis.window as any).__wmux_supervisorRemoteControl;

    expect(remoteControl({ action: 'decide', approvalId: approval.id, decision: 'reject', actor: 'ou-user' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('填写具体意见') });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);

    useStore.getState().updateLane('lane-a', { supervisorSurfaceId: undefined });
    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'reject', task: '保留现有框架。', actor: 'ou-user',
    })).toMatchObject({ ok: false, error: expect.stringContaining('AI 监督已不存在') });
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(1);
    useStore.getState().updateLane('lane-a', { supervisorSurfaceId: 'supervisor-a' as any });

    expect(remoteControl({
      action: 'decide', approvalId: approval.id, decision: 'reject', task: '保留现有框架，只调整适配层。', actor: 'ou-user',
    })).toMatchObject({ ok: true, message: '已将补充说明交给 AI 监督重新处理。' });
    expect(writes).toHaveBeenCalledWith(
      'supervisor-a',
      expect.stringContaining('[用户补充说明]\n保留现有框架，只调整适配层。'),
    );
    expect(useStore.getState().supervisor.pendingApprovals).toHaveLength(0);
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
    expect(useStore.getState().supervisor).toMatchObject({ active: true, paused: false });
    expect(useStore.getState().supervisor.lanes[0]).toMatchObject({ controlState: 'paused', enabled: true });
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
      .toMatchObject({ ok: true, message: '已继续原 AI 监督会话。' });
    expect(useStore.getState().supervisor).toMatchObject({ active: true, paused: false, sessionId });
    expect(writes).toHaveBeenCalledWith('supervisor-a', expect.stringContaining('[会话继续]'));
  });

  it('adds a new supervised terminal from Feishu without replacing the active session', () => {
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
    useStore.getState().setSupervisorLanes([
      ...useStore.getState().supervisor.lanes,
      {
        ...lane(),
        id: 'lane-old-b',
        label: 'worker B',
        surfaceId: 'worker-b' as any,
        supervisorSurfaceId: 'supervisor-old-b' as any,
        enabled: false,
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
    expect(writes.mock.calls.some(([surfaceId, text]) => (
      surfaceId === after.lanes[1].supervisorSurfaceId && String(text).includes('新增终端测试通过')
    ))).toBe(true);
  });
});
