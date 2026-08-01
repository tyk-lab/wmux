/**
 * pipe-bridge.ts — Exposes Zustand store operations as window.__wmux_* globals
 * so the main process can call them via executeJavaScript from V2 pipe handlers.
 */
import { useStore } from './store';
import { splitNode, getAllPaneIds, findLeaf, buildGridLayout } from './store/split-utils';
import { surfaceTerminalRegistry } from './hooks/useTerminal';
import { PaneId, SurfaceId, WorkspaceId, SurfaceType } from '../shared/types';
import { v4 as uuid } from 'uuid';
import { sendToSurface } from './supervisor/supervisor-engine';
import { appendSupervisorRecord } from './supervisor/recording';
import type { SupervisorDecision, SupervisorLane } from './store/supervisor-slice';

export function isSupervisorDecisionAuthorised(
  lane: Pick<SupervisorLane, 'supervisorSurfaceId'>,
  supervisorSurfaceId: string,
): boolean {
  return !!supervisorSurfaceId && lane.supervisorSurfaceId === supervisorSurfaceId;
}

/** Important proposals are never eligible for automatic continuation. */
export function isSupervisorProposalAllowed(outcome: string, proposalKind: string): boolean {
  if (!proposalKind) return true;
  return (proposalKind === 'route-change' || proposalKind === 'important') && outcome === 'needs-human';
}

/** Unified supervision can only send a proposal after explicit human approval. */
export function isSupervisorNextAllowed(
  mode: string,
  outcome: string,
  next: string,
  autonomous = false,
): boolean {
  return autonomous || mode !== 'unified' || !next || outcome === 'needs-human';
}

const AUTONOMOUS_BLOCKED_ACTIONS: Array<[RegExp, string]> = [
  [/(?:^|\s)(?:rm|rmdir|del|erase|rd|remove-item)\b/i, '删除或覆盖文件'],
  [/\bgit\s+(?:push|reset\s+--hard|clean|remote\s+(?:add|remove|set-url))\b/i, '推送或重写 Git 历史'],
  [/\b(?:npm|pnpm|yarn|bun|cargo|twine)\s+(?:publish|release)\b/i, '发布软件包'],
  [/\b(?:deploy|release|publish)\b/i, '部署、发布或对外提交'],
  [/\b(?:kubectl|helm|terraform|pulumi|aws|az|gcloud)\b/i, '云端或生产环境操作'],
  [/\b(?:production|prod)\b/i, '生产环境操作'],
  [/\b(?:credential|secret|token|password|api[ _-]?key)\b/i, '凭据或权限变更'],
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
      return { ok: false, error: '重要建议或路线变更必须使用 needs-human' };
    }
    if (!isSupervisorNextAllowed(session.mode, outcome, next, session.autonomous)) {
      return { ok: false, error: '统一监督不会自动注入工作终端；请移除 --next，或通过 needs-human 提交给用户审批' };
    }
    const nextBlockReason = autonomousActionBlockReason(next);
    if (session.autonomous && outcome !== 'needs-human' && nextBlockReason) {
      return { ok: false, error: `全自动监督禁止${nextBlockReason}；请使用 needs-human 交给人工处理` };
    }
    if (permissionCommand || permissionResponse) {
      const permissionBlockReason = autonomousActionBlockReason(permissionCommand);
      if (!session.autonomous) {
        return { ok: false, error: '仅全自动监督会话可处理终端权限确认' };
      }
      if (!permissionCommand || !isAutonomousPermissionResponseAllowed(permissionResponse)) {
        return { ok: false, error: '权限确认必须提供命令说明，并且响应只能是 y、yes、allow 或 approve' };
      }
      if (permissionBlockReason) {
        return { ok: false, error: `全自动监督禁止${permissionBlockReason}；请交给人工确认` };
      }
      if (outcome === 'complete' || outcome === 'needs-human') {
        return { ok: false, error: '终端权限确认只能与 continue 或 rework 裁决一起提交' };
      }
      if (next) {
        return { ok: false, error: '终端权限确认后需等待代理恢复；请不要在同一裁决中追加 --next' };
      }
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
    const autoDecisionsUsed = (lane.autoDecisionsUsed ?? 0) + 1;
    const limitReached = !session.autonomous && reachesAutoDecisionLimit(lane, session.maxAutoDecisions);
    store.updateLane(lane.id, {
      autoDecisionsUsed,
      decisions: [
        {
          ts: Date.now(),
          task: lane.currentTask || '（任务未上报）',
          outcome,
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
      appendSupervisorRecord(session, lane, 'supervisor.permission-approved', {
        command: permissionCommand,
        response: permissionResponse,
      });
      store.appendSupervisorLog(lane.id, 'AI 自动授权', permissionCommand);
      store.updateLane(lane.id, { awaitingReview: false });
      sendToSurface(lane.surfaceId, permissionResponse, true);
      return { ok: true, outcome, autoAuthorized: true };
    }

    if (outcome === 'needs-human') {
      if (session.autonomous && next && !nextBlockReason) {
        appendSupervisorRecord(session, lane, 'supervisor.auto-approved', {
          proposalKind: proposalKind || 'important',
          reason,
          next,
        });
        store.appendSupervisorLog(lane.id, 'AI 自动批准', reason || '按监督建议继续');
        store.updateLane(lane.id, { awaitingReview: false });
        sendToSurface(lane.surfaceId, next, session.submitEnter);
        return { ok: true, outcome, autoApproved: true };
      }
      store.updateLane(lane.id, { awaitingReview: true, ...(limitReached ? { autoDecisionLimitReached: true } : {}) });
      const kind = proposalKinds.has(proposalKind) ? proposalKind as 'route-change' | 'important' : 'important';
      store.enqueueApproval({
        laneId: lane.id,
        surfaceId: lane.surfaceId,
        laneLabel: lane.label,
        text: next,
        source: kind === 'route-change' ? 'supervisor-route' : 'supervisor-important',
        proposalKind: kind,
        reason: reason || `${lane.label} 需要人工决策`,
        impact,
        alternatives,
        task: lane.currentTask || '（任务未上报）',
      });
      const text = `${kind === 'route-change' ? '路线变更' : '重要建议'}待你决定：${reason || lane.label}`;
      const workspaceId = lane.workspaceId || store.activeWorkspaceId;
      if (workspaceId) {
        store.addNotification({ surfaceId: lane.surfaceId, workspaceId, text });
      }
      window.wmux?.notification?.fire({ surfaceId: lane.surfaceId, title: 'AI 监督', text });
      return { ok: true, outcome };
    }

    store.updateLane(lane.id, { awaitingReview: false });
    if (next) sendToSurface(lane.surfaceId, next, session.submitEnter);
    return { ok: true, outcome };
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
