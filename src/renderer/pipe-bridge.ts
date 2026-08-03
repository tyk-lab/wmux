/**
 * pipe-bridge.ts — Exposes Zustand store operations as window.__wmux_* globals
 * so the main process can call them via executeJavaScript from V2 pipe handlers.
 */
import { useStore } from './store';
import { splitNode, getAllPaneIds, findLeaf, buildGridLayout, createLeaf } from './store/split-utils';
import { surfaceTerminalRegistry } from './hooks/useTerminal';
import { PaneId, SurfaceId, WorkspaceId, SurfaceType, SplitNode } from '../shared/types';
import { v4 as uuid } from 'uuid';
import { sendToSurface, SUPERVISOR_TUI_READY_DELAY_MS } from './supervisor/supervisor-engine';
import { appendSupervisorRecord } from './supervisor/recording';
import type { SupervisorDecision, SupervisorLane } from './store/supervisor-slice';
import { buildSupervisorBriefing, SUPERVISOR_TAB_TITLE, SUPERVISOR_WORKSPACE_TITLE, supervisorTabTitle } from './supervisor/protocol';
import { buildSupervisorLaunchCommand } from './supervisor/launch-command';

export function isSupervisorDecisionAuthorised(
  lane: Pick<SupervisorLane, 'supervisorSurfaceId'>,
  supervisorSurfaceId: string,
): boolean {
  return !!supervisorSurfaceId && lane.supervisorSurfaceId === supervisorSurfaceId;
}

/** Small reversible adjustments are autonomous; material proposals remain human-gated. */
export function isSupervisorProposalAllowed(outcome: string, proposalKind: string): boolean {
  if (!proposalKind) return true;
  if (proposalKind === 'route-adjustment') return outcome === 'continue' || outcome === 'rework';
  return (proposalKind === 'route-change' || proposalKind === 'important') && outcome === 'needs-human';
}

/** A supervisor may advance work only from a continuation/rework or a human proposal. */
export function isSupervisorNextAllowed(
  _mode: string,
  outcome: string,
  next: string,
  _autonomous = false,
): boolean {
  return !next || outcome === 'continue' || outcome === 'rework' || outcome === 'needs-human';
}

const AUTONOMOUS_BLOCKED_ACTIONS: Array<[RegExp, string]> = [
  [/(?:^|\s)(?:rm|rmdir|del|erase|rd|ri|remove-item|clear-content|set-content|out-file)\b|删除|覆盖/i, '删除或覆盖文件'],
  [/\bgit\b[^\r\n]{0,200}\b(?:push|reset\s+--hard|clean|remote\s+(?:add|remove|set-url))\b/i, '推送或重写 Git 历史'],
  [/\b(?:npm|pnpm|yarn|bun|cargo|twine)\s+(?:publish|release)\b/i, '发布软件包'],
  [/\bgh\s+(?:pr\s+(?:create|merge|close)|release\s+create)\b/i, '对外提交或发布'],
  [/\b(?:curl|invoke-restmethod|invoke-webrequest)\b[^\r\n]{0,300}(?:-x|--request|-method)\s*(?:delete|post|put|patch)\b/i, '外部写操作'],
  [/\b(?:deploy|release|publish)\b|部署|发布|对外提交/i, '部署、发布或对外提交'],
  [/\b(?:kubectl|helm|terraform|pulumi|aws|az|gcloud)\b/i, '云端或生产环境操作'],
  [/\b(?:production|prod)\b|生产环境|线上环境/i, '生产环境操作'],
  [/\b(?:credential|secret|token|password|api[ _-]?key)\b|凭据|密钥|令牌|密码/i, '凭据或权限变更'],
  [/(?:^|\s)(?:sudo|runas)\b|\bstart-process\b[^\n]*\s-verb\s+runas\b|\b(?:set-executionpolicy|takeown|icacls|set-acl|new-localuser|add-localgroupmember)\b|管理员权限|系统权限/i, '管理员权限或系统权限变更'],
];

/** Returns why an AI-proposed action must remain a human decision. */
export function autonomousActionBlockReason(action: string): string | null {
  const text = action.trim();
  if (!text) return null;
  const matched = AUTONOMOUS_BLOCKED_ACTIONS.find(([pattern]) => pattern.test(text));
  return matched?.[1] ?? null;
}

export function isAutonomousPermissionResponseAllowed(response: string): boolean {
  return /^(?:y|yes|allow|approve)$/i.test(response.trim());
}

interface SupervisorAgentStateView {
  state?: string;
  blockedReason?: string | null;
  updatedAt?: number;
}

function isPermissionBlockedState(
  state: SupervisorAgentStateView | undefined,
): state is SupervisorAgentStateView & { updatedAt: number } {
  return state?.state === 'blocked'
    && typeof state.updatedAt === 'number'
    && /\b(?:permission|approval|allowance)\b|权限|授权/i.test(state.blockedReason || '');
}

function isQuestionBlockedState(
  state: SupervisorAgentStateView | undefined,
): state is SupervisorAgentStateView & { updatedAt: number } {
  return state?.state === 'blocked'
    && typeof state.updatedAt === 'number'
    && /question|input|choice|choose|select|prompt|询问|选择|输入|问题|决定/i.test(state.blockedReason || '');
}

interface RemoteSupervisorStart {
  action: 'start';
  terminals: string[];
  stopWhen: string;
  stopWhenKind: 'concrete' | 'direction';
  taskDescription?: string;
  preconditions?: string;
  planFile?: string;
  autonomous: boolean;
  supervisorLaunchCmd?: string;
  supervisorModel?: string;
  supervisorReasoningEffort?: string;
  actor?: string;
}

interface RemoteTerminalTask {
  action: 'send';
  terminal: string;
  task: string;
  actor?: string;
}

function collectRemoteTerminals(tree: SplitNode, workspace: { id: WorkspaceId; title: string; cwd?: string }, out: Array<{
  surfaceId: SurfaceId; paneId: PaneId; workspaceId: WorkspaceId; workspaceTitle: string; projectDir?: string; label: string;
}>): void {
  if (tree.type !== 'leaf') {
    collectRemoteTerminals(tree.children[0], workspace, out);
    collectRemoteTerminals(tree.children[1], workspace, out);
    return;
  }
  for (const surface of tree.surfaces) {
    if (surface.type !== 'terminal') continue;
    const label = surface.customTitle?.trim() || surface.shell || 'terminal';
    if (label.startsWith(SUPERVISOR_TAB_TITLE) || label === 'AI Supervisor') continue;
    out.push({
      surfaceId: surface.id,
      paneId: tree.paneId,
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      projectDir: workspace.cwd || surface.currentCwd || surface.cwd,
      label,
    });
  }
}

function remoteTerminalList(): Array<{
  surfaceId: SurfaceId; paneId: PaneId; workspaceId: WorkspaceId; workspaceTitle: string; projectDir?: string; label: string;
}> {
  const store = useStore.getState();
  const terminals: ReturnType<typeof remoteTerminalList> = [];
  for (const workspace of store.workspaces) collectRemoteTerminals(workspace.splitTree, workspace, terminals);
  const supervisorIds = new Set(store.supervisor.lanes.map((lane) => lane.supervisorSurfaceId).filter(Boolean));
  return terminals.filter((terminal) => !supervisorIds.has(terminal.surfaceId));
}

function remoteAudit(session: ReturnType<typeof useStore.getState>['supervisor'], lane: SupervisorLane | undefined, type: string, payload: Record<string, unknown>): void {
  if (lane) appendSupervisorRecord(session, lane, type, payload);
}

function startRemoteSupervisor(params: RemoteSupervisorStart): { ok: boolean; message: string; error?: string } {
  const store = useStore.getState();
  if (store.supervisor.active) return { ok: false, error: '当前已有进行中的 AI 监督；请先停止。', message: '' };
  const selectedIds = new Set(params.terminals);
  const candidates = remoteTerminalList().filter((terminal) => selectedIds.has(terminal.surfaceId));
  if (candidates.length !== selectedIds.size) return { ok: false, error: '包含不存在或不可监督的终端 ID；先执行 LIST 获取最新终端。', message: '' };
  if (!params.stopWhen.trim()) return { ok: false, error: '停止条件不能为空。', message: '' };
  if (candidates.some((candidate) => !candidate.projectDir)) return { ok: false, error: '所选终端缺少项目目录，无法写入审计记录。', message: '' };

  let supervisorWorkspace = store.workspaces.find((workspace) => workspace.id === store.supervisor.supervisorWorkspaceId);
  if (!supervisorWorkspace) {
    const workspaceId = store.createWorkspace({ title: SUPERVISOR_WORKSPACE_TITLE, pinned: true, splitTree: createLeaf(undefined, 'supervisor') });
    store.patchSupervisor({ supervisorWorkspaceId: workspaceId });
    supervisorWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === workspaceId);
  }
  const targetPaneId = supervisorWorkspace ? getAllPaneIds(supervisorWorkspace.splitTree)[0] : undefined;
  if (!supervisorWorkspace || !targetPaneId) return { ok: false, error: '无法创建专属监督工作区。', message: '' };

  const launchCmd = params.supervisorLaunchCmd || store.supervisor.supervisorLaunchCmd || 'codex';
  const supervisorModel = params.supervisorModel || '';
  const supervisorReasoningEffort = params.supervisorReasoningEffort || '';
  const launch = buildSupervisorLaunchCommand(launchCmd, supervisorModel, supervisorReasoningEffort);
  const lanes: SupervisorLane[] = candidates.map((candidate, index) => {
    const supervisorSurfaceId = store.addSurface(supervisorWorkspace!.id, targetPaneId!, 'terminal', {
      customTitle: supervisorTabTitle(candidate.label),
      cwd: candidate.projectDir,
      startupCommands: launch ? [launch] : undefined,
      transientSupervisor: true,
    });
    return {
      id: `lane-${index + 1}`,
      label: candidate.label,
      surfaceId: candidate.surfaceId,
      supervisorSurfaceId,
      paneId: candidate.paneId,
      workspaceId: candidate.workspaceId,
      workspaceTitle: candidate.workspaceTitle,
      projectDir: candidate.projectDir,
      enabled: true,
      steps: [], maxAutoSteps: 0, autoStepsUsed: 0, awaitingStopCheck: false, stopConfirmed: false,
      awaitingReview: false, autoDecisionLimitReached: false, autoDecisionsUsed: 0, pendingSupervisorDeliveries: [], currentTask: '', decisions: [],
    };
  });
  if (lanes.some((lane) => !lane.supervisorSurfaceId)) return { ok: false, error: '无法为所有终端创建专属监督 AI。', message: '' };
  store.patchSupervisor({
    mode: 'unified', taskDescription: params.taskDescription || '', preconditions: params.preconditions || '',
    stopWhen: params.stopWhen, stopWhenKind: params.stopWhenKind, planFilePath: params.planFile || '', planFileContent: '',
    supervisorLaunchCmd: launchCmd, supervisorModel, supervisorReasoningEffort, maxAutoSteps: 0,
    maxAutoDecisions: params.autonomous ? null : store.supervisor.maxAutoDecisions, autonomous: params.autonomous,
  });
  store.setSupervisorLanes(lanes);
  store.startSupervisor();
  const session = useStore.getState().supervisor;
  for (const lane of session.lanes) remoteAudit(session, lane, 'supervisor.remote-command', { action: 'start', terminals: params.terminals, autonomous: params.autonomous, actor: params.actor || 'unknown' });
  window.setTimeout(() => {
    const current = useStore.getState().supervisor;
    const states = (window as any).__wmux_getAgentStates?.() || {};
    for (const lane of current.lanes) {
      if (!lane.supervisorSurfaceId) continue;
      sendToSurface(lane.supervisorSurfaceId, buildSupervisorBriefing(current, { lane, state: String(states[lane.surfaceId]?.state || 'unknown') }), true);
    }
  // Codex and similar TUIs need to finish their initial render before a large
  // briefing is pasted; otherwise the following Enter can be swallowed by the
  // paste handler and leave the supervisor waiting at an unsubmitted prompt.
  }, SUPERVISOR_TUI_READY_DELAY_MS);
  return { ok: true, message: `已启动 AI 监督：${lanes.map((lane) => `${lane.label} (${lane.surfaceId})`).join('、')}` };
}

function sendRemoteTerminalTask(params: RemoteTerminalTask): { ok: boolean; message: string; error?: string } {
  const store = useStore.getState();
  const terminal = remoteTerminalList().find((item) => item.surfaceId === params.terminal);
  if (!terminal) return { ok: false, error: '终端不存在或不可发送任务；请先执行 LIST 获取最新终端。', message: '' };
  const task = params.task.trim();
  if (!task) return { ok: false, error: '任务内容不能为空。', message: '' };

  sendToSurface(terminal.surfaceId, task, true);
  const session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => item.surfaceId === terminal.surfaceId);
  if (lane) store.updateLane(lane.id, { currentTask: task });
  remoteAudit(session, lane, 'supervisor.remote-command', { action: 'send-task', terminal: terminal.surfaceId, actor: params.actor || 'unknown', task });
  return { ok: true, message: `已向 ${terminal.label} 发送任务。` };
}

function decideRemoteSupervisor(approvalId: string, decision: 'approve' | 'reject' | 'stop', task?: string, actor?: string): { ok: boolean; message: string; error?: string } {
  const store = useStore.getState();
  const session = store.supervisor;
  if (!session.active) return { ok: false, error: '当前监督会话已停止，不能处理旧待决项。', message: '' };
  const approval = session.pendingApprovals.find((item) => item.id === approvalId);
  if (!approval) return { ok: false, error: '该待决项不存在、已过期或已处理。', message: '' };
  if (Date.now() - approval.createdAt > 24 * 60 * 60 * 1000) {
    store.rejectPending(approvalId);
    return { ok: false, error: '该待决项已超过 24 小时，已作废。', message: '' };
  }
  const lane = session.lanes.find((item) => item.id === approval.laneId);
  if (decision === 'stop') {
    store.rejectPending(approvalId);
    store.stopSupervisor('飞书人工决定停止监督');
    remoteAudit(session, lane, 'supervisor.remote-decision', { approvalId, decision, actor: actor || 'unknown' });
    return { ok: true, message: '已停止当前 AI 监督。' };
  }
  const followUpTask = task?.trim() || '';
  if (decision === 'approve' && !followUpTask) return { ok: false, error: '批准时需要填写后续任务。', message: '' };
  const delivery = [approval.text.trim(), followUpTask].filter(Boolean).join('\n\n');
  if (decision === 'approve' && delivery) sendToSurface(approval.surfaceId, delivery, session.submitEnter);
  if (decision === 'approve') store.approvePending(approvalId);
  else store.rejectPending(approvalId);
  if (lane && (approval.source === 'supervisor-route' || approval.source === 'supervisor-important')) {
    store.updateLane(lane.id, { awaitingReview: decision !== 'approve', autoDecisionLimitReached: false, autoDecisionsUsed: 0, ...(decision === 'approve' ? { currentTask: followUpTask } : {}) });
    remoteAudit(session, lane, 'supervisor.proposal.resolved', { approvalId, resolution: decision === 'approve' ? 'approved' : 'rejected', proposalKind: approval.proposalKind || 'important', text: decision === 'approve' ? delivery : undefined });
    if (decision === 'reject' && lane.supervisorSurfaceId) {
      sendToSurface(lane.supervisorSurfaceId, '[人工决定] 已拒绝该建议；请依据当前任务、计划约束和终端证据重新裁决。\n', true);
    }
  }
  remoteAudit(session, lane, 'supervisor.remote-decision', { approvalId, decision, actor: actor || 'unknown', task: decision === 'approve' ? followUpTask : undefined });
  return { ok: true, message: decision === 'approve' ? '已批准并发送后续任务。' : '已拒绝建议。' };
}

export function normalizedMaxAutoDecisions(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(20, parsed) : null;
}

export function reachesAutoDecisionLimit(
  lane: Pick<SupervisorLane, 'autoDecisionsUsed'>,
  maxAutoDecisions: unknown,
): boolean {
  const limit = normalizedMaxAutoDecisions(maxAutoDecisions);
  return limit !== null && (lane.autoDecisionsUsed ?? 0) + 1 >= limit;
}

/** Permission acknowledgements are audited but do not consume a judgment slot. */
export function nextSupervisorDecisionCount(current: number | undefined, permissionResponse: string): number {
  return (current ?? 0) + (permissionResponse ? 0 : 1);
}

export function initPipeBridge(): void {
  const w = window as any;

  // ─── Workspace ──────────────────────────────────────────────────────────────

  w.__wmux_createWorkspace = (params?: { title?: string; shell?: string; cwd?: string }) => {
    const store = useStore.getState();
    const id = store.createWorkspace({
      title: params?.title,
      shell: params?.shell,
      cwd: params?.cwd,
    });
    return { workspaceId: id };
  };

  w.__wmux_closeWorkspace = (id: string) => {
    useStore.getState().closeWorkspace(id as WorkspaceId);
  };

  w.__wmux_selectWorkspace = (id: string) => {
    useStore.getState().selectWorkspace(id as WorkspaceId);
  };

  w.__wmux_renameWorkspace = (id: string, title: string) => {
    useStore.getState().renameWorkspace(id as WorkspaceId, title);
  };

  w.__wmux_listWorkspaces = () => {
    const store = useStore.getState();
    return store.workspaces.map(ws => ({
      id: ws.id,
      title: ws.title,
      isActive: ws.id === store.activeWorkspaceId,
      cwd: ws.cwd,
      shell: ws.shell,
    }));
  };

  // Which workspace owns a given surface? Used by main to route browser commands
  // to a browser pane in the *caller agent's* workspace (issue #62). Returns the
  // active workspace id as a fallback when the surface isn't found.
  w.__wmux_getWorkspaceIdForSurface = (surfaceId: string) => {
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const leaf = findLeaf(ws.splitTree, paneId);
        if (leaf?.surfaces?.some(s => s.id === surfaceId)) return ws.id;
      }
    }
    return store.activeWorkspaceId ?? null;
  };

  // All browser surface ids in a workspace. Main adopts an unbound one for a
  // caller (or creates a fresh pane) so each agent gets its own browser (#62).
  w.__wmux_listBrowserSurfaces = (workspaceId: string) => {
    const store = useStore.getState();
    const ws = store.workspaces.find(x => x.id === workspaceId);
    if (!ws) return [];
    const ids: string[] = [];
    for (const paneId of getAllPaneIds(ws.splitTree)) {
      const leaf = findLeaf(ws.splitTree, paneId);
      for (const s of leaf?.surfaces ?? []) {
        if (s.type === 'browser') ids.push(s.id);
      }
    }
    return ids;
  };

  // ─── Pane ───────────────────────────────────────────────────────────────────

  w.__wmux_splitPane = (params?: { direction?: string; type?: string; workspaceId?: string; colorScheme?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;

    const paneIds = getAllPaneIds(ws.splitTree);
    const targetPaneId = paneIds[0];
    if (!targetPaneId) return null;

    const newPaneId = `pane-${uuid()}` as PaneId;
    const surfaceType = (params?.type || 'terminal') as SurfaceType;
    const direction = params?.direction === 'down' || params?.direction === 'vertical'
      ? 'vertical' : 'horizontal';

    const newTree = splitNode(ws.splitTree, targetPaneId, newPaneId, surfaceType, direction);
    store.updateSplitTree(wsId, newTree);

    const newLeaf = findLeaf(newTree, newPaneId);
    const surfaceId = newLeaf?.surfaces?.[0]?.id || null;

    // Apply a per-pane color scheme override to the freshly-created surface
    // so `wmux split --color-scheme prod` takes effect immediately.
    if (params?.colorScheme && surfaceId && newLeaf) {
      store.updateSurface(wsId, newPaneId, surfaceId as SurfaceId, { colorScheme: params.colorScheme });
    }

    return { paneId: newPaneId, surfaceId };
  };

  w.__wmux_closePane = (paneId: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return;

    // Reaping + tree surgery live in the store action (issue #65 fixed the
    // missing reap here; the last-pane case was still wrong in all three copies).
    store.closePane(wsId, paneId as PaneId);
  };

  w.__wmux_layoutGrid = (params: { count: number; type?: string; anchorSurfaceId?: string; anchorPaneId?: string; workspaceId?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;

    const count = Math.max(1, Math.floor(params.count || 1));
    if (count < 2) return { newPaneIds: [], newPanes: [] };

    // Resolve the anchor pane: explicit paneId > surface lookup > first pane
    const paneIds = getAllPaneIds(ws.splitTree);
    let anchorPaneId: PaneId | undefined;

    if (params.anchorPaneId) {
      anchorPaneId = params.anchorPaneId as PaneId;
    } else if (params.anchorSurfaceId) {
      for (const pid of paneIds) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces?.some(s => s.id === params.anchorSurfaceId)) {
          anchorPaneId = pid;
          break;
        }
      }
    }
    if (!anchorPaneId) anchorPaneId = paneIds[0];
    if (!anchorPaneId) return null;

    const surfaceType = (params.type || 'terminal') as SurfaceType;
    const { tree: newTree, newPaneIds } = buildGridLayout(ws.splitTree, anchorPaneId, count, surfaceType);
    store.updateSplitTree(wsId, newTree);

    // Resolve surface IDs for the newly-created panes so callers can target them directly.
    const newPanes = newPaneIds.map(pid => {
      const leaf = findLeaf(newTree, pid);
      return {
        paneId: pid,
        surfaceId: leaf?.surfaces?.[0]?.id || null,
      };
    });

    return { newPaneIds, newPanes, anchorPaneId, cols: Math.ceil(Math.sqrt(count)), rows: Math.ceil(count / Math.ceil(Math.sqrt(count))) };
  };

  w.__wmux_listPanes = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return [];

    const paneIds = getAllPaneIds(ws.splitTree);
    return paneIds.map(pid => {
      const leaf = findLeaf(ws.splitTree, pid);
      return {
        paneId: pid,
        surfaces: leaf?.surfaces?.map(s => ({ id: s.id, type: s.type })) || [],
        tabCount: leaf?.surfaces?.length || 0,
        activeSurfaceIndex: leaf?.activeSurfaceIndex ?? 0,
      };
    });
  };

  // ─── Surface ────────────────────────────────────────────────────────────────

  w.__wmux_createSurface = (params?: { type?: string; paneId?: string; workspaceId?: string; colorScheme?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;

    let paneId = params?.paneId as PaneId | undefined;
    if (!paneId) {
      const ws = store.workspaces.find(w => w.id === wsId);
      if (!ws) return null;
      const paneIds = getAllPaneIds(ws.splitTree);
      paneId = paneIds[0];
    }
    if (!paneId) return null;

    const type = (params?.type || 'terminal') as SurfaceType;
    const surfaceId = store.addSurface(wsId, paneId, type, { colorScheme: params?.colorScheme });
    if (!surfaceId) return null;
    return { surfaceId, paneId };
  };

  /**
   * Update an existing surface's color scheme. Lets users switch a running
   * pane to "prod" mid-session via `wmux surface set-color-scheme <id> prod`.
   */
  w.__wmux_setSurfaceColorScheme = (surfaceId: string, colorScheme: string | null) => {
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      const paneIds = getAllPaneIds(ws.splitTree);
      for (const pid of paneIds) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
          store.updateSurface(ws.id, pid, surfaceId as SurfaceId, {
            colorScheme: colorScheme || undefined,
          });
          return { ok: true };
        }
      }
    }
    return { ok: false, error: 'Surface not found' };
  };

  w.__wmux_closeSurface = (surfaceId: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return;
    const paneIds = getAllPaneIds(ws.splitTree);
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
        store.closeSurface(wsId, pid, surfaceId as SurfaceId);
        return;
      }
    }
  };

  w.__wmux_renameSurface = (surfaceId: string, title: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return { ok: false, error: 'No active workspace' };
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return { ok: false, error: 'Workspace not found' };
    const paneIds = getAllPaneIds(ws.splitTree);
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
        store.renameSurface(wsId, pid, surfaceId as SurfaceId, title ?? '');
        return { ok: true };
      }
    }
    return { ok: false, error: 'Surface not found' };
  };

  w.__wmux_focusSurface = (surfaceId: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return;
    const paneIds = getAllPaneIds(ws.splitTree);
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces) {
        const idx = leaf.surfaces.findIndex(s => s.id === surfaceId);
        if (idx >= 0) {
          store.selectSurface(wsId, pid, idx);
          return;
        }
      }
    }
  };

  w.__wmux_listSurfaces = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return [];

    const paneIds = getAllPaneIds(ws.splitTree);
    const surfaces: Array<{ id: string; type: string; paneId: string; isActive: boolean }> = [];
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces) {
        leaf.surfaces.forEach((s, idx) => {
          surfaces.push({
            id: s.id,
            type: s.type,
            paneId: pid,
            isActive: idx === leaf.activeSurfaceIndex,
          });
        });
      }
    }
    return surfaces;
  };

  w.__wmux_getActiveSurfaceId = () => {
    const store = useStore.getState();
    const wsId = store.activeWorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;
    const paneIds = getAllPaneIds(ws.splitTree);
    if (paneIds.length === 0) return null;
    const leaf = findLeaf(ws.splitTree, paneIds[0]);
    if (!leaf?.surfaces?.length) return null;
    const idx = leaf.activeSurfaceIndex ?? 0;
    return leaf.surfaces[idx]?.id || null;
  };

  // Read a terminal's screen as plain text (surface.read_text / read-screen).
  // Reads the ACTIVE xterm buffer — alt buffer included, so a full-screen TUI
  // returns what is actually visible. `lines` counts back from the bottom of
  // the buffer (scrollback included); trailing blank lines are trimmed.
  w.__wmux_readScreen = (surfaceId?: string, lines?: number) => {
    const id = surfaceId || w.__wmux_getActiveSurfaceId?.();
    if (!id) return { error: 'No active surface' };
    const terminal = surfaceTerminalRegistry.get(id);
    if (!terminal) {
      return { error: `no terminal for surface ${id} (markdown/browser pane, another window, or closed)` };
    }
    const buf = terminal.buffer.active;
    const count = Math.min(Math.max(Math.floor(lines ?? 50), 1), 10000);
    const end = buf.length;
    const out: string[] = [];
    for (let i = Math.max(0, end - count); i < end; i++) {
      out.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return { text: out.join('\n'), lines: out.length, surfaceId: id };
  };

  // The dedicated supervisor terminal records its judgment through a silent CLI
  // call. Routing by surfaceId, not display label, keeps duplicate tab names
  // distinct inside the same workspace/session.
  w.__wmux_supervisorDecide = (params: any) => {
    const store = useStore.getState();
    const session = store.supervisor;
    const surfaceId = String(params?.surfaceId || '');
    const supervisorSurfaceId = String(params?.supervisorSurfaceId || '');
    const outcome = String(params?.outcome || '') as SupervisorDecision['outcome'];
    const reason = String(params?.reason || '').trim().slice(0, 1200);
    const next = String(params?.next || '').trim().slice(0, 4000);
    const proposalKind = String(params?.proposalKind || '').trim();
    const impact = String(params?.impact || '').trim().slice(0, 1200);
    const alternatives = String(params?.alternatives || '').trim().slice(0, 1200);
    const permissionCommand = String(params?.permissionCommand || '').trim().slice(0, 2000);
    const permissionResponse = String(params?.permissionResponse || '').trim().slice(0, 16);
    const valid = new Set(['continue', 'rework', 'complete', 'needs-human']);
    const proposalKinds = new Set(['route-change', 'important']);
    const lane = session.lanes.find((item) => item.surfaceId === surfaceId && item.enabled);
    if (!session.active || !lane || !isSupervisorDecisionAuthorised(lane, supervisorSurfaceId) || !valid.has(outcome)) return null;
    if (lane.autoDecisionLimitReached && !session.autonomous) {
      return { ok: false, error: '已达到自动判断上限，等待人工审阅后继续' };
    }
    // A supervisor must not smuggle a declared route/important proposal through
    // an auto-continue decision. Such proposals always stop for user consent.
    if (!isSupervisorProposalAllowed(outcome, proposalKind)) {
      return { ok: false, error: '小范围路线调整须使用 route-adjustment 配合 continue/rework；重大路线变更或重要建议必须使用 needs-human' };
    }
    if (proposalKind === 'route-adjustment' && !next) {
      return { ok: false, error: 'route-adjustment 必须携带明确的低风险 --next' };
    }
    if (!isSupervisorNextAllowed(session.mode, outcome, next, session.autonomous)) {
      return { ok: false, error: '只有 continue、rework 或 needs-human 可以携带 --next' };
    }
    const nextBlockReason = autonomousActionBlockReason(next);
    if (outcome !== 'needs-human' && nextBlockReason) {
      return { ok: false, error: `监督 AI 禁止自动执行${nextBlockReason}；请使用 needs-human 交给人工处理` };
    }
    if (permissionCommand || permissionResponse) {
      const permissionBlockReason = autonomousActionBlockReason(permissionCommand);
      if (!permissionCommand || !isAutonomousPermissionResponseAllowed(permissionResponse)) {
        return { ok: false, error: '权限确认必须提供命令说明，并且响应只能是 y、yes、allow 或 approve' };
      }
      if (permissionBlockReason) {
        return { ok: false, error: `监督 AI 禁止自动确认${permissionBlockReason}；请交给人工确认` };
      }
      if (outcome === 'complete' || outcome === 'needs-human') {
        return { ok: false, error: '终端权限确认只能与 continue 或 rework 裁决一起提交' };
      }
      if (next) {
        return { ok: false, error: '终端权限确认后需等待代理恢复；请不要在同一裁决中追加 --next' };
      }
    }
    if (!lane.awaitingReview) {
      return { ok: false, error: '当前没有待裁决轮次；请等待工作终端任务结束或权限阻塞通知' };
    }
    const agentState = ((w.__wmux_getAgentStates?.() || {})[surfaceId] || undefined) as SupervisorAgentStateView | undefined;
    if (permissionCommand || permissionResponse) {
      if (!isPermissionBlockedState(agentState)) {
        return { ok: false, error: '未检测到可自动确认的真实权限阻塞；状态未知或普通输入必须交给人工' };
      }
      if (lane.lastBlockedResponseStateAt === agentState.updatedAt) {
        return { ok: false, error: '该权限阻塞状态已经确认过，禁止重复发送响应' };
      }
    } else if (agentState?.state === 'blocked' && outcome !== 'needs-human' && !next) {
      return { ok: false, error: '工作终端仍在阻塞；请明确回答技术问题、确认低风险权限，或使用 needs-human' };
    } else if (next && outcome !== 'needs-human') {
      if (agentState?.state === 'working') {
        return { ok: false, error: '工作终端仍在运行，不能注入下一步' };
      }
      if (isPermissionBlockedState(agentState)) {
        return { ok: false, error: '当前是权限阻塞，必须使用权限确认参数，不能发送普通下一步' };
      }
      if (agentState?.state === 'blocked' && !isQuestionBlockedState(agentState)) {
        return { ok: false, error: '当前阻塞不是明确的技术问题或方案选择，不能自动输入内容' };
      }
      if (isQuestionBlockedState(agentState) && lane.lastBlockedResponseStateAt === agentState.updatedAt) {
        return { ok: false, error: '该技术问题阻塞状态已经回答过，禁止重复发送响应' };
      }
    }
    if (outcome === 'complete' && agentState?.state === 'working') {
      return { ok: false, error: '工作终端仍在运行，不能判定完成' };
    }

    // The worker can emit several lifecycle updates while it is waiting. Keep
    // the first pending human decision stable so Feishu has one card to act on.
    if (outcome === 'needs-human' && session.pendingApprovals.some((approval) => approval.laneId === lane.id)) {
      store.appendSupervisorLog(lane.id, '重复人工决策已忽略', reason || '该终端已有待决项');
      return { ok: true, outcome, duplicate: true };
    }

    appendSupervisorRecord(session, lane, 'supervisor.decision', {
      outcome,
      reason,
      next,
      proposalKind,
      impact,
      alternatives,
    });
    store.appendSupervisorLog(lane.id, '监督裁决', `${outcome}${reason ? `：${reason}` : ''}`);
    const autoDecisionsUsed = nextSupervisorDecisionCount(lane.autoDecisionsUsed, permissionResponse);
    const limitReached = !session.autonomous && !permissionResponse && reachesAutoDecisionLimit(lane, session.maxAutoDecisions);
    store.updateLane(lane.id, {
      autoDecisionsUsed,
      decisions: [
        {
          ts: Date.now(),
          task: lane.currentTask || '（任务未上报）',
          outcome,
          ...(proposalKind ? { proposalKind: proposalKind as SupervisorDecision['proposalKind'] } : {}),
          reason,
          next,
        },
        ...(lane.decisions || []),
      ].slice(0, 100),
    });

    if (limitReached && outcome !== 'needs-human') {
      store.updateLane(lane.id, {
        autoDecisionLimitReached: true,
        awaitingReview: true,
        ...(outcome === 'complete' ? { awaitingStopCheck: true } : {}),
      });
      const text = `已达到 ${normalizedMaxAutoDecisions(session.maxAutoDecisions)} 次自动判断上限；请人工审阅 ${lane.label} 后再继续。`;
      const workspaceId = lane.workspaceId || store.activeWorkspaceId;
      if (workspaceId) store.addNotification({ surfaceId: lane.surfaceId, workspaceId, text });
      window.wmux?.notification?.fire({ surfaceId: lane.surfaceId, title: 'AI 监督', text });
      return { ok: true, outcome, requiresHuman: true };
    }

    if (outcome === 'complete') {
      store.confirmStopCondition(lane.id);
      return { ok: true, outcome };
    }

    if (permissionResponse) {
      try {
        sendToSurface(lane.surfaceId, permissionResponse, true);
      } catch (err) {
        const error = String((err as Error)?.message || err);
        store.updateLane(lane.id, {
          awaitingReview: true,
          autoDecisionsUsed: lane.autoDecisionsUsed ?? 0,
          decisions: lane.decisions || [],
        });
        appendSupervisorRecord(session, lane, 'supervisor.delivery.failed', { kind: 'permission', error });
        store.appendSupervisorLog(lane.id, '权限响应发送失败', error);
        return { ok: false, error: `权限响应发送失败：${error}` };
      }
      appendSupervisorRecord(session, lane, 'supervisor.permission-approved', {
        command: permissionCommand,
        response: permissionResponse,
      });
      store.appendSupervisorLog(lane.id, 'AI 自动授权', permissionCommand);
      store.updateLane(lane.id, {
        awaitingReview: false,
        lastBlockedResponseStateAt: agentState!.updatedAt,
      });
      return { ok: true, outcome, autoAuthorized: true };
    }

    if (outcome === 'needs-human') {
      store.updateLane(lane.id, { awaitingReview: true, ...(limitReached ? { autoDecisionLimitReached: true } : {}) });
      const kind = proposalKinds.has(proposalKind) ? proposalKind as 'route-change' | 'important' : 'important';
      const approval = {
        laneId: lane.id,
        surfaceId: lane.surfaceId,
        laneLabel: lane.label,
        text: next,
        source: kind === 'route-change' ? 'supervisor-route' as const : 'supervisor-important' as const,
        proposalKind: kind,
        reason: reason || `${lane.label} 需要人工决策`,
        impact,
        alternatives,
        task: lane.currentTask || '（任务未上报）',
      };
      store.enqueueApproval(approval);
      const pending = useStore.getState().supervisor.pendingApprovals[0];
      if (pending) {
        appendSupervisorRecord(useStore.getState().supervisor, lane, 'supervisor.approval.requested', {
          approvalId: pending.id,
          reason: approval.reason,
          impact: approval.impact,
          alternatives: approval.alternatives,
          proposalKind: approval.proposalKind,
        });
      }
      const text = `${kind === 'route-change' ? '路线变更' : '重要建议'}待你决定：${reason || lane.label}`;
      const workspaceId = lane.workspaceId || store.activeWorkspaceId;
      if (workspaceId) {
        store.addNotification({ surfaceId: lane.surfaceId, workspaceId, text });
      }
      window.wmux?.notification?.fire({ surfaceId: lane.surfaceId, title: 'AI 监督', text });
      return { ok: true, outcome };
    }

    if (next) {
      try {
        sendToSurface(lane.surfaceId, next, session.submitEnter);
      } catch (err) {
        const error = String((err as Error)?.message || err);
        store.updateLane(lane.id, {
          awaitingReview: true,
          autoDecisionsUsed: lane.autoDecisionsUsed ?? 0,
          decisions: lane.decisions || [],
        });
        appendSupervisorRecord(session, lane, 'supervisor.delivery.failed', { kind: 'next', error });
        store.appendSupervisorLog(lane.id, '下一步发送失败', error);
        return { ok: false, error: `下一步发送失败：${error}` };
      }
    }
    store.updateLane(lane.id, {
      awaitingReview: false,
      ...(isQuestionBlockedState(agentState) ? { lastBlockedResponseStateAt: agentState.updatedAt } : {}),
    });
    return { ok: true, outcome };
  };

  // The Feishu main-process gateway authenticates the caller; this renderer
  // bridge only accepts its small, explicit set of supervision/task actions.
  w.__wmux_supervisorRemoteControl = (params: any) => {
    const action = String(params?.action || '');
    if (action === 'list') {
      const state = useStore.getState().supervisor;
      return {
        ok: true,
        message: JSON.stringify({
          active: state.active,
          terminals: remoteTerminalList().map((terminal) => ({
            surfaceId: terminal.surfaceId,
            label: terminal.label,
            workspace: terminal.workspaceTitle,
            supervised: state.lanes.some((lane) => lane.surfaceId === terminal.surfaceId && lane.enabled),
          })),
          session: state.active ? { sessionId: state.sessionId, stopWhen: state.stopWhen, autonomous: state.autonomous } : null,
          pendingApprovals: state.pendingApprovals.map((approval) => ({ id: approval.id, terminal: approval.laneLabel, reason: approval.reason || '' })),
        }),
      };
    }
    if (action === 'start') return startRemoteSupervisor(params as RemoteSupervisorStart);
    if (action === 'send') return sendRemoteTerminalTask(params as RemoteTerminalTask);
    if (action === 'stop') {
      const session = useStore.getState().supervisor;
      if (!session.active) return { ok: false, error: '当前没有进行中的 AI 监督。', message: '' };
      useStore.getState().stopSupervisor('由飞书远程停止');
      for (const lane of session.lanes) remoteAudit(session, lane, 'supervisor.remote-command', { action: 'stop', actor: String(params?.actor || 'unknown') });
      return { ok: true, message: '已停止当前 AI 监督。' };
    }
    if (action === 'decide') {
      const decision = String(params?.decision || '');
      if (!['approve', 'reject', 'stop'].includes(decision)) return { ok: false, error: '无效的人工决策。', message: '' };
      return decideRemoteSupervisor(String(params?.approvalId || ''), decision as 'approve' | 'reject' | 'stop', String(params?.task || ''), String(params?.actor || 'unknown'));
    }
    return { ok: false, error: '不支持的监督控制动作。', message: '' };
  };

  // ─── Markdown ───────────────────────────────────────────────────────────────

  w.__wmux_setMarkdownContent = (surfaceId: string, markdown: string, fileName?: string, filePath?: string, mtimeMs?: number) => {
    // Persist into the store so MarkdownPane (re)renders the content. The old
    // `wmux:markdown-update` CustomEvent had no listener, so content never
    // displayed (issue #54). `fileName`, when the content came from a file, is
    // used as the tab label so multiple markdown tabs stay distinguishable;
    // `filePath` makes the surface path-aware (issue #116) so the pane can show
    // the path, copy it, reveal it, and reload from it.
    // `mtimeMs` (F3) records what was on disk at load time so a later save can
    // detect an agent having rewritten the file underneath the pane.
    useStore.getState().setMarkdownContent(surfaceId as SurfaceId, markdown ?? '', { fileName, filePath, mtimeMs });
    return { ok: true };
  };

  // Read a markdown surface's buffer back out (issue #116). Mirrors
  // __wmux_readScreen for terminals — an agent that pushed content has no other
  // way to check what actually landed.
  w.__wmux_getMarkdownContent = (surfaceId: string) => {
    const state = useStore.getState();
    for (const ws of state.workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const surface = findLeaf(ws.splitTree, paneId)?.surfaces.find((s) => s.id === surfaceId);
        if (surface) {
          return {
            surfaceId,
            content: surface.markdownContent ?? '',
            filePath: surface.markdownFilePath ?? null,
            fileName: surface.markdownFileName ?? null,
            dirty: !!surface.markdownDirty,
          };
        }
      }
    }
    return null;
  };

  // ─── Notifications ──────────────────────────────────────────────────────────

  w.__wmux_listNotifications = () => {
    return useStore.getState().notifications || [];
  };

  w.__wmux_clearNotification = (id: string) => {
    useStore.getState().clearNotification(id);
  };

  w.__wmux_clearAllNotifications = () => {
    useStore.getState().clearAll();
  };

  // ─── Tree ───────────────────────────────────────────────────────────────────

  w.__wmux_getTree = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    return ws?.splitTree || null;
  };
}
