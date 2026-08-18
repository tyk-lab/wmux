import React, { useEffect, useState, useCallback, useRef } from 'react';
import { v4 as uuid } from 'uuid';
import { useStore } from './store';
import { PaneId, SurfaceId, WorkspaceId, WorkspaceInfo, SplitNode, SshCompanionAgent, SshConnectionProfile, SshFileEntry } from '../shared/types';
import SplitContainer from './components/SplitPane/SplitContainer';
import { updateRatio, getAllPaneIds, findLeaf, replaceSoleTerminalSurface } from './store/split-utils';
import { DEFAULT_DEV_PORTS, mergeDevPorts, matchDevPorts, firstNewDevPort } from './dev-ports';
import { aggregateProgress } from './store/progress-slice';
import Sidebar from './components/Sidebar/Sidebar';
import SshConnectionDialog from './components/Ssh/SshConnectionDialog';
import SshFileDrawer from './components/Ssh/SshFileDrawer';
import SshPasswordDialog from './components/Ssh/SshPasswordDialog';
import { attachSshProfileId, buildSshSplitTree, findSshFileSurface, upgradeSshSplitTree } from './ssh-workspace';
import Titlebar from './components/Titlebar/Titlebar';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import SettingsWindow from './components/Settings/SettingsWindow';
import CommandPalette from './components/CommandPalette/CommandPalette';
import ShortcutCheatSheet from './components/CheatSheet/ShortcutCheatSheet';
import ConfirmCloseDialog from './components/ConfirmCloseDialog';
import ConfirmCloseSurfaceDialog from './components/ConfirmCloseSurfaceDialog';
import SupervisorSetupDialog from './components/Supervisor/SupervisorSetupDialog';
import ProjectManagerDialog from './components/ProjectManager/ProjectManagerDialog';
import BrowserPane from './components/Browser/BrowserPane';
import Tutorial from './components/Tutorial/Tutorial';
import SplitPreviewOverlay from './components/SplitPane/SplitPreviewOverlay';
import { initPipeBridge, readTerminalScreen } from './pipe-bridge';
import { initSupervisorGenericInputGuard } from './supervisor/generic-input-guard';
import { useUiTheme } from './hooks/useUiTheme';
import { useUiMode } from './hooks/useUiMode';
import type {
  SurfaceDragCommitOptions,
  SurfaceDragPayload,
  SurfaceDragPreview,
  SurfaceDragPreviewTarget,
} from './components/SplitPane/drag-preview-types';
import { buildSurfaceDragPreview } from './components/SplitPane/surface-drag-preview';
import {
  formatAgentLifecycleText,
  inferAgentName,
  lifecycleDedupeKey,
  shouldNotifyAgentLifecycle,
  shouldDedupeLifecycleNotify,
  type LifecycleNotifyKind,
} from './agent-lifecycle-notify';
import {
  blankRuntime,
  pasteSubmitDelayMs,
  sendToSurface,
  tickLane,
  type LaneRuntime,
} from './supervisor/supervisor-engine';
import {
  buildUserNotifyText,
  buildSupervisorWakeRoleAnchor,
  effectiveSupervisorAutonomyPermissions,
  effectiveSupervisorAutonomous,
  effectiveSupervisorForbiddenActions,
  effectiveSupervisorLaneConfig,
  effectiveSupervisorStopWhen,
} from './supervisor/protocol';
import { detectSupervisorLauncher, supervisorLauncherDisplayName } from './supervisor/launch-command';
import { appendSupervisorRecord } from './supervisor/recording';
import {
  canDeliverToSupervisor,
  enqueueSupervisorDelivery,
  supervisorWakeDeliveryKind,
} from './supervisor/delivery';
import {
  omitNonRestorableWorkspaces,
  shouldInitializeWorkspaceLayout,
} from './supervisor/session-restore';
import {
  handleSupervisorUserSubmit,
  resolvePendingApprovalsForManualTask,
} from './supervisor/user-input-precedence';
import { TERMINAL_USER_SUBMIT_EVENT } from './utils/terminal-user-submit';
import {
  clearSupervisorProviderLimitAlert,
  reportSupervisorProviderLimit,
} from './supervisor/provider-limit';
import type { SupervisorLane, SupervisorSession } from './store/supervisor-slice';
import { dedicatedSupervisorSurfaceId, supervisorLaneControlState } from './store/supervisor-slice';
import {
  normalizeTaskChildThreadResponsibilities,
  normalizeTaskThreadResponsibility,
  normalizeTaskWorkMode,
} from '../shared/supervisor-work-mode';

const DEFAULT_SIDEBAR_WIDTH = 240;
const SUPERVISOR_DELIVERY_READY_EVENT = 'wmux:supervisor-delivery-ready';

function signalSupervisorDeliveryReady(): void {
  window.dispatchEvent(new Event(SUPERVISOR_DELIVERY_READY_EVENT));
}

/** Per-key last lifecycle notify time — drops twin Stop floods without merging panes. */
const lastLifecycleNotifyAt = new Map<string, number>();

/** Get all surface IDs from a split tree */
function getAllSurfaces(tree: SplitNode): string[] {
  if (tree.type === 'leaf') return tree.surfaces.map(s => s.id);
  return [...getAllSurfaces(tree.children[0]), ...getAllSurfaces(tree.children[1])];
}

function findLeafFromTree(node: SplitNode, paneId: PaneId): (SplitNode & { type: 'leaf' }) | null {
  if (node.type === 'leaf') return node.paneId === paneId ? node : null;
  return findLeafFromTree(node.children[0], paneId) || findLeafFromTree(node.children[1], paneId);
}

/** Apply `~/.wmux/config.toml`'s `[terminal]` section onto the terminal prefs slice. */
function applyUserConfigTerminal(state: ReturnType<typeof useStore.getState>, terminal: any): void {
  if (!terminal) return;
  const patch: Partial<typeof state.terminalPrefs> = {};
  if (terminal.fontFamily !== undefined) patch.fontFamily = terminal.fontFamily;
  if (terminal.fontSize !== undefined) patch.fontSize = terminal.fontSize;
  if (terminal.theme !== undefined) patch.theme = terminal.theme;
  if (terminal.cursorStyle !== undefined) patch.cursorStyle = terminal.cursorStyle;
  if (terminal.cursorBlink !== undefined) patch.cursorBlink = terminal.cursorBlink;
  if (terminal.scrollbackLines !== undefined) patch.scrollbackLines = terminal.scrollbackLines;
  if (terminal.userColorSchemes) {
    // Merge: file-defined schemes replace by-name but don't clobber others.
    patch.userColorSchemes = {
      ...state.terminalPrefs.userColorSchemes,
      ...terminal.userColorSchemes,
    };
  }
  if (Object.keys(patch).length) state.setTerminalPrefs(patch);
}

// ─── Shell-integration / hook metadata handlers (issue #53) ───────────────────
// Extracted from the metadata + hook listeners so each function stays under the
// cognitive-complexity budget. `fireNotification` is the single place that both
// adds the in-app bell entry and raises the OS toast (via the renderer → main
// NOTIFICATION_FIRE chokepoint).

// Effective runtime values — seeded from the built-in defaults, then widened/
// toggled by ~/.wmux/config.toml at startup and on `wmux reload-config`.
let activeDevPorts: number[] = DEFAULT_DEV_PORTS;
let autoOpenDevPort = true;

/**
 * Apply `~/.wmux/config.toml`'s `[browser]` section: dev-port detection + auto-open.
 * Resets to the built-in defaults first so `wmux reload-config` is idempotent —
 * deleting a key (or the whole section) from the file reverts its effect instead
 * of leaving the previous run's values sticky until restart.
 */
function applyUserConfigBrowser(browser: any): void {
  activeDevPorts = DEFAULT_DEV_PORTS;
  autoOpenDevPort = true;
  if (!browser) return;
  if (Array.isArray(browser.devPorts) && browser.devPorts.length) {
    activeDevPorts = mergeDevPorts(DEFAULT_DEV_PORTS, browser.devPorts);
  }
  if (typeof browser.autoOpen === 'boolean') autoOpenDevPort = browser.autoOpen;
}

type StoreAction = (...args: any[]) => void;
type MetaDeps = {
  updateWorkspaceMetadata: StoreAction;
  addNotification: StoreAction;
  runningStartTimes: React.MutableRefObject<Record<string, number>>;
};

function fireNotification(
  surfaceId: string,
  workspaceId: WorkspaceId | null,
  text: string,
  addNotification: StoreAction,
  opts?: { flash?: boolean; title?: string },
): void {
  if (workspaceId) {
    addNotification({ surfaceId: (surfaceId || '') as SurfaceId, workspaceId, text });
  }
  window.wmux?.notification?.fire({
    surfaceId: surfaceId || '',
    text,
    title: opts?.title || 'wmux',
    ...(opts?.flash === false ? { flash: false } : {}),
  });
}

/** Resolve the workspace that owns a surface, or undefined. */
function workspaceForSurface(surfaceId: string): WorkspaceInfo | undefined {
  if (!surfaceId) return undefined;
  return useStore.getState().workspaces.find(ws => getAllSurfaces(ws.splitTree).includes(surfaceId));
}

type HookActivityMap = Record<string, { lastTool: string; toolCount: number; lastSeen: number }>;

/**
 * Stop hook = the turn is over. Zero out lastSeen so the sidebar flips to
 * "Idle" immediately instead of waiting out the ACTIVITY_TTL window, and
 * upsert the entry so turns with zero tool uses (pure text generation) still
 * register as "Claude ran here and finished" — otherwise WorkspaceRow falls
 * back to the shell's perpetual "Running" while the TUI sits idle (issue #81).
 *
 * Keyed by SURFACE, not workspace: two Claude sessions split inside one
 * workspace must not zero each other's freshness. Only surfaceId-less legacy
 * events fall back to the active workspace's id as key.
 */
function markSessionIdleOnStop(
  surfaceId: string,
  setHookActivity: React.Dispatch<React.SetStateAction<HookActivityMap>>,
): void {
  const key = surfaceId || useStore.getState().activeWorkspaceId;
  if (!key) return;
  setHookActivity(prev => {
    const existing = prev[key] || { lastTool: '', toolCount: 0, lastSeen: 0 };
    return { ...prev, [key]: { ...existing, lastSeen: 0 } };
  });
}

function handlePortsUpdate(cmd: any, updateWorkspaceMetadata: StoreAction): void {
  try {
    const portsByPid = JSON.parse(cmd.args?.[0] || '{}');
    const allPorts = Object.values(portsByPid).flat() as number[];
    const devPorts = matchDevPorts(allPorts, activeDevPorts);
    if (devPorts.length > 0) {
      const currentWs = useStore.getState().activeWorkspaceId;
      const ws = useStore.getState().workspaces.find(w => w.id === currentWs);
      // Auto-navigate to a newly-appeared dev port — one this workspace hasn't seen
      // yet — rather than blindly devPorts[0]. Otherwise a freshly-started server
      // never opens when other recognized ports are already listening (netstat order
      // is arbitrary), and the guard permanently suppresses navigation thereafter.
      const newPort = firstNewDevPort(devPorts, ws?.ports || []);
      if (autoOpenDevPort && currentWs && newPort !== undefined) {
        window.wmux?.browser?.navigate?.(`browser-${currentWs}`, `http://localhost:${newPort}`);
      }
    }
    for (const ws of useStore.getState().workspaces) {
      updateWorkspaceMetadata(ws.id, { ports: devPorts.length > 0 ? devPorts : undefined });
    }
  } catch { /* Ignore malformed hook port metadata. */ }
}

/** `wmux notify <text>` — works even outside a pane (falls back to active workspace). */
function handleNotifyCommand(cmd: any, addNotification: StoreAction): void {
  const text = (cmd.args || []).join(' ').trim() || 'Notification';
  const ws = workspaceForSurface(cmd.surfaceId);
  const wsId = ws?.id || useStore.getState().activeWorkspaceId;
  fireNotification(cmd.surfaceId, wsId, text, addNotification);
}

/**
 * Per-terminal shell state → workspace aggregate.
 *
 * Session is busy if ANY terminal is running; fully idle only when every
 * terminal is idle. On busy→idle: sidebar attention blink + taskbar flash
 * (if unfocused). Focusing the session/window clears attention until the
 * next busy→idle edge.
 */
function applyShellState(cmd: any, ws: WorkspaceInfo, deps: MetaDeps): void {
  const newState = cmd.args?.[0] as 'idle' | 'running' | 'interrupted';
  if (newState !== 'idle' && newState !== 'running' && newState !== 'interrupted') return;
  if (!cmd.surfaceId) return;

  const store = useStore.getState();
  const result = store.setSurfaceShellState(cmd.surfaceId, newState);

  if (newState === 'running') {
    // Start the workspace busy clock only when the session first becomes busy.
    if (result.prevAgg !== 'running') {
      deps.runningStartTimes.current[ws.id] = Date.now();
    }
    return;
  }

  // Finished one terminal — only act when the whole session is now idle.
  if (!result.becameIdle) return;

  requestSessionIdleAttention(ws.id);

  const startTime = deps.runningStartTimes.current[ws.id];
  const elapsed = startTime ? (Date.now() - startTime) / 1000 : 0;
  delete deps.runningStartTimes.current[ws.id];
  // Toast only for long commands; icon flash already fired above.
  if (elapsed < 5) return;

  // Round to whole seconds BEFORE splitting into minutes — rounding the
  // remainder independently yields "3m60s" for 239.6s elapsed.
  const totalSeconds = Math.round(elapsed);
  const duration = totalSeconds >= 60
    ? `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`
    : `${totalSeconds}s`;
  const msg = result.nextAgg === 'interrupted'
    ? `Interrupted in ${ws.title} (${duration})`
    : `Finished in ${ws.title} (${duration})`;
  // Prefer the dedicated flash path (already requested); avoid double-flash.
  fireNotification(cmd.surfaceId, ws.id, msg, deps.addNotification, { flash: false });
}

/**
 * Mark a workspace as needing attention after all its terminals go idle.
 * Taskbar flash only when the OS window is unfocused and the pref allows it.
 * If the user is already looking at this session, skip attention entirely.
 */
function requestSessionIdleAttention(workspaceId: WorkspaceId): void {
  const store = useStore.getState();
  const watching =
    store.activeWorkspaceId === workspaceId &&
    (typeof document === 'undefined' ? true : document.hasFocus());
  if (watching) return;

  store.markWorkspaceAttention(workspaceId);

  if (typeof document !== 'undefined' && !document.hasFocus() && store.notificationPrefs.taskbarFlash) {
    window.wmux?.window?.flash?.(true);
  }
}

function clearSessionAttention(workspaceId?: WorkspaceId | null): void {
  const store = useStore.getState();
  if (workspaceId) store.clearWorkspaceAttention(workspaceId);
  else store.clearAllAttention();
  window.wmux?.window?.flash?.(false);
}

/** Dispatch a surface-scoped metadata command to the owning workspace. */
function handleSurfaceMetadata(cmd: any, ws: WorkspaceInfo, deps: MetaDeps): void {
  switch (cmd.command) {
    case 'report_pwd': {
      const pwd = cmd.args?.[0];
      deps.updateWorkspaceMetadata(ws.id, { cwd: pwd });
      // Also store cwd at the surface level so the tab label can show the project folder.
      if (pwd && cmd.surfaceId) {
        const { updateSurface } = useStore.getState();
        for (const paneId of getAllPaneIds(ws.splitTree)) {
          const leaf = findLeaf(ws.splitTree, paneId);
          if (leaf?.surfaces.some((s) => s.id === cmd.surfaceId)) {
            updateSurface(ws.id, paneId, cmd.surfaceId, { currentCwd: pwd });
            break;
          }
        }
      }
      break;
    }
    case 'report_git_branch':
      deps.updateWorkspaceMetadata(ws.id, { gitBranch: cmd.args?.[0], gitDirty: cmd.args?.[1] === 'dirty' });
      break;
    case 'clear_git_branch':
      deps.updateWorkspaceMetadata(ws.id, { gitBranch: undefined, gitDirty: undefined });
      break;
    case 'report_pr': {
      const [num, status, ...labelParts] = cmd.args || [];
      deps.updateWorkspaceMetadata(ws.id, {
        prNumber: num ? parseInt(num) : undefined,
        prStatus: status as any,
        prLabel: labelParts.join(' '),
      });
      break;
    }
    case 'clear_pr':
      deps.updateWorkspaceMetadata(ws.id, { prNumber: undefined, prStatus: undefined, prLabel: undefined });
      break;
    case 'report_shell_state':
      applyShellState(cmd, ws, deps);
      break;
  }
}

/** Collect pane label candidates for a surface (tab title, cwd folder, agent meta). */
function surfaceNotifyHints(
  surfaceId: string,
  ws: WorkspaceInfo | undefined,
): { where: string | null; labelHints: string[] } {
  if (!surfaceId || !ws) return { where: null, labelHints: [] };

  const meta = useStore.getState().agentMeta.get(surfaceId as SurfaceId);
  let customTitle: string | undefined;
  let cwdBase: string | undefined;
  for (const paneId of getAllPaneIds(ws.splitTree)) {
    const leaf = findLeaf(ws.splitTree, paneId);
    const surf = leaf?.surfaces.find((s) => s.id === surfaceId);
    if (!surf) continue;
    if (surf.customTitle?.trim()) customTitle = surf.customTitle.trim();
    const cwd = (surf as { currentCwd?: string }).currentCwd;
    if (cwd) {
      cwdBase = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || undefined;
    }
    break;
  }

  const where = meta?.label?.trim()
    || customTitle
    || cwdBase
    || surfaceId.replace(/^surf-/, '').slice(0, 6)
    || null;

  const labelHints = [meta?.label, customTitle, cwdBase, where].filter(
    (s): s is string => !!s && !!s.trim(),
  );
  return { where, labelHints };
}

/**
 * Agent lifecycle toasts.
 * Panel lines: (1) workspace title  (2) status + agent  (3) time.
 */
function handleAgentLifecycleEvent(
  event: any,
  addNotification: StoreAction,
  agentStates?: Record<string, any>,
): void {
  const state = useStore.getState();
  if (!shouldNotifyAgentLifecycle(state.supervisor.active)) return;

  const prefs = state.notificationPrefs;
  const ev = event?.event as string;

  const isNeedsInput = ev === 'Notification' || ev === 'PermissionRequest';
  const isTurnFinished = ev === 'Stop' || ev === 'StopFailure';
  if (!isNeedsInput && !isTurnFinished) return;

  if (isNeedsInput && prefs.agentInputNotify === false) return;
  if (isTurnFinished && prefs.agentStopNotify === false) return;

  const sid = (event.surfaceId as string) || '';
  const ws = workspaceForSurface(sid);
  const wsId = ws?.id || state.activeWorkspaceId;
  if (!wsId) return;

  const kind: LifecycleNotifyKind = isNeedsInput ? 'needs_input' : 'turn_finished';
  const dedupeKey = lifecycleDedupeKey(kind, sid || null, wsId);
  const now = Date.now();
  const lastAt = lastLifecycleNotifyAt.get(dedupeKey);
  if (shouldDedupeLifecycleNotify(
    lastAt !== undefined ? { key: dedupeKey, at: lastAt } : null,
    dedupeKey,
    now,
  )) return;
  lastLifecycleNotifyAt.set(dedupeKey, now);
  // Bound map size so a long session of many surfaces cannot grow forever.
  if (lastLifecycleNotifyAt.size > 128) {
    const oldest = lastLifecycleNotifyAt.keys().next().value;
    if (oldest !== undefined) lastLifecycleNotifyAt.delete(oldest);
  }

  // While the user is looking at this workspace, turn-finished is visible in
  // the sidebar (Working → Idle) — skip the bell spam. Needs-input still fires.
  if (isTurnFinished
    && state.activeWorkspaceId === wsId
    && typeof document !== 'undefined'
    && document.hasFocus()) {
    return;
  }

  const hints = surfaceNotifyHints(sid, ws);
  // Prefer explicit --agent from the harness hook install, then metadata / heuristics.
  const declaredModel = agentStates?.[sid]?.metadata?.model as string | undefined;
  const agent = (typeof event.agent === 'string' && event.agent.trim())
    ? event.agent.trim()
    : inferAgentName(declaredModel, ...hints.labelHints);

  // `where` is the terminal/tab label (custom title, wrap label, cwd folder, …).
  // Keep it alongside the agent product name so multi-pane sessions stay distinct:
  //   "Turn complete · Kimi · tyk"
  // Only drop when it is a pure duplicate of the agent name ("Kimi · Kimi").
  let where = hints.where;
  if (where && agent && where.toLowerCase() === agent.toLowerCase()) {
    where = null;
  }

  const text = formatAgentLifecycleText({
    kind,
    agent,
    where,
    message: isNeedsInput ? (event.message || null) : null,
  });
  fireNotification(sid, wsId, text, addNotification, {
    title: agent || 'wmux',
  });
}

/** Route compact Hook facts to the supervising terminal without echoing them to workers. */
function resolveSupervisorProjectDir(lane: { projectDir?: string }, cwd: unknown): string | undefined {
  const reported = typeof cwd === 'string' ? cwd.trim() : '';
  if (/^[A-Za-z]:[\\/]/.test(reported) || reported.startsWith('/')) return reported;
  return lane.projectDir;
}

function queueSupervisorDelivery(
  session: SupervisorSession,
  lane: SupervisorLane,
  kind: 'task-start' | 'task-end' | 'task-interrupted',
  task: string,
  text: string,
): void {
  const delivery = {
    id: uuid(),
    kind,
    task,
    text,
    createdAt: Date.now(),
    turnId: lane.workerTurnId,
    stage: 'pending' as const,
  };
  const pending = enqueueSupervisorDelivery(lane.pendingSupervisorDeliveries, delivery);
  if (pending === lane.pendingSupervisorDeliveries) return;
  const store = useStore.getState();
  store.updateLane(lane.id, { pendingSupervisorDeliveries: pending });
  appendSupervisorRecord(session, lane, 'supervisor.delivery.queued', { kind, task });
  signalSupervisorDeliveryReady();
}

function handleSupervisorHookEvent(event: any): void {
  const store = useStore.getState();
  const session = store.supervisor;
  const surfaceId = typeof event?.surfaceId === 'string' ? event.surfaceId : '';
  const lifecycle = String(event.event || '');
  if (['Stop', 'StopFailure', 'Interrupt', 'Notification'].includes(lifecycle)) {
    (window as any).__wmux_flushProjectManagerDeliveries?.();
  }
  if (!session.active || !surfaceId) return;
  const supervisorLane = session.lanes.find((item) => (
    dedicatedSupervisorSurfaceId(item) === surfaceId
    && (supervisorLaneControlState(item) === 'active' || supervisorLaneControlState(item) === 'waiting')
  ));
  if (supervisorLane) {
    if (lifecycle === 'UserPromptSubmit') {
      clearSupervisorProviderLimitAlert(session, supervisorLane);
    } else if (lifecycle === 'Stop' || lifecycle === 'StopFailure' || lifecycle === 'Notification') {
      reportSupervisorProviderLimit(session, supervisorLane, String(event.message || ''));
    }
    return;
  }

  const lane = session.lanes.find((item) => item.surfaceId === surfaceId && supervisorLaneControlState(item) === 'active');
  if (!lane || !dedicatedSupervisorSurfaceId(lane)) return;
  const projectDir = resolveSupervisorProjectDir(lane, event.cwd);
  const auditLane = projectDir ? { ...lane, projectDir } : lane;
  if (lifecycle === 'UserPromptSubmit') {
    const task = String(event.task || '').trim().slice(0, 800);
    const manuallyResolved = resolvePendingApprovalsForManualTask(session, auditLane, task);
    store.updateLane(lane.id, {
      awaitingReview: manuallyResolved ? false : !!lane.autoDecisionLimitReached,
      ...(manuallyResolved ? {
        awaitingStopCheck: false,
        stopConfirmed: false,
        resumeAfterCancelledDecision: false,
        autoDecisionLimitReached: false,
        autoDecisionsUsed: 0,
      } : {}),
      ...(projectDir ? { projectDir } : {}),
      ...(task ? { currentTask: task } : {}),
      workerTurnId: (lane.workerTurnId || 0) + 1,
    });
    appendSupervisorRecord(session, auditLane, 'worker.task', {
      task: event.task || '',
      cwd: event.cwd || '',
    });
    return;
  }

  if (lifecycle !== 'Stop' && lifecycle !== 'StopFailure' && lifecycle !== 'Interrupt' && lifecycle !== 'Notification') return;
  if (projectDir && projectDir !== lane.projectDir) store.updateLane(lane.id, { projectDir });
  appendSupervisorRecord(session, auditLane, 'worker.lifecycle', {
    event: lifecycle,
    message: event.message || '',
  });

  const deliveryKind = supervisorWakeDeliveryKind(lifecycle);
  if (deliveryKind) {
    store.updateLane(lane.id, { awaitingReview: true });
    if (lane.autoDecisionLimitReached) return;
    queueSupervisorDelivery(
      session,
      auditLane,
      deliveryKind,
      lane.currentTask || '（任务未上报）',
      [
        `[${deliveryKind === 'task-interrupted' ? '任务中断' : '任务结束'}] ${lane.label} (${surfaceId})。`,
        buildSupervisorWakeRoleAnchor(surfaceId),
        '',
      ].join('\n'),
    );
  }
}

/**
 * --replace-tab agent spawn (PR #85): swap the pane's sole idle default
 * terminal for the agent surface instead of appending, so orchestration panes
 * don't keep an unused shell tab. Guards: exactly one surface, terminal type
 * (enforced in replaceSoleTerminalSurface), and not itself an agent surface.
 * Returns true when the spawn was handled via replacement.
 */
function tryReplaceTabSpawn(event: any, ws: WorkspaceInfo, setAgentMeta: (surfaceId: any, meta: any) => void): boolean {
  if (!event.replaceTab) return false;
  const state = useStore.getState();
  const leaf = findLeaf(ws.splitTree, event.paneId);
  const sole = leaf?.surfaces.length === 1 ? leaf.surfaces[0] : undefined;
  if (!sole || state.agentMeta.get(sole.id)) return false;
  const { tree, replacedSurfaceId } = replaceSoleTerminalSurface(
    ws.splitTree, event.paneId, { id: event.surfaceId, type: 'terminal' },
  );
  if (!replacedSurfaceId) return false;
  state.updateSplitTree(event.workspaceId, tree);
  setAgentMeta(event.surfaceId, { agentId: event.agentId, label: event.label, status: 'running' });
  // Intentionally not pushed onto the reopen-closed stack — the replaced
  // surface is an idle default shell, not user work.
  window.wmux?.pty?.kill(replacedSurfaceId);
  return true;
}

/** Build the default left-right dual-terminal layout for new workspaces */
function buildDefaultSplitTree(): SplitNode {
  return {
    type: 'branch',
    direction: 'horizontal',
    ratio: 0.5,
    children: [
      {
        type: 'leaf',
        paneId: `pane-${uuid()}` as PaneId,
        surfaces: [{ id: `surf-${uuid()}` as SurfaceId, type: 'terminal' }],
        activeSurfaceIndex: 0,
      },
      {
        type: 'leaf',
        paneId: `pane-${uuid()}` as PaneId,
        surfaces: [{ id: `surf-${uuid()}` as SurfaceId, type: 'terminal' }],
        activeSurfaceIndex: 0,
      },
    ],
  };
}

export default function App() {
  const {
    workspaces,
    activeWorkspaceId,
    createWorkspace,
    requestCloseWorkspace,
    selectWorkspace,
    renameWorkspace,
    reorderWorkspaces,
    updateWorkspaceMetadata,
    updateSplitTree,
    sidebarVisible,
    shortcuts,
    notifications,
    markRead,
    markAllRead,
    clearAll,
    selectSurface,
    setAgentMeta,
    addNotification,
    toggleSidebar,
    sshConnections,
    setSshConnections,
    workspacePrefs,
    setWorkspacePrefs,
  } = useStore();

  useUiTheme();
  useUiMode();

  const [focusedPaneId, setFocusedPaneId] = useState<PaneId | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [sshPasswordRequest, setSshPasswordRequest] = useState<{
    workspaceId: WorkspaceId;
    profile: SshConnectionProfile;
    errorMessage?: string;
  } | null>(null);
  const sshWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const autoReconnectedSshWorkspaceIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const activeIds = new Set<string>(workspaces.filter((workspace) => workspace.sshProfileId).map((workspace) => workspace.id));
    sshWorkspaceIdsRef.current.forEach((workspaceId) => {
      if (!activeIds.has(workspaceId)) void window.wmux?.ssh?.disconnect?.(workspaceId as WorkspaceId);
    });
    sshWorkspaceIdsRef.current = activeIds;
  }, [workspaces]);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Shortcut cheat-sheet overlay (issue #64, toggled by F1 via wmux:toggle-cheatsheet).
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);
  useEffect(() => {
    const toggle = () => setCheatSheetOpen((open) => !open);
    document.addEventListener('wmux:toggle-cheatsheet', toggle);
    return () => document.removeEventListener('wmux:toggle-cheatsheet', toggle);
  }, []);
  // Broadcast-input mode banner (issue #64): mirror the runtime store flag.
  const broadcastInputActive = useStore((s) => s.broadcastInputActive);
  // Custom background parallel to theming (issue #89): rendered as a layer
  // behind the split tree; terminals show it through their alpha'd theme bg.
  const appearancePrefs = useStore((s) => s.appearancePrefs);
  const customBgActive = appearancePrefs.customBackgroundEnabled && !!appearancePrefs.customBackground.trim();
  // Browser panel auto-opens on startup unless disabled in Settings (issue #22).
  const [browserOpen, setBrowserOpen] = useState(() => useStore.getState().browserPrefs.openOnStartup);
  const [browserWidth, setBrowserWidth] = useState(420);
  const [isResizingBrowser, setIsResizingBrowser] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  // Per-workspace hook activity: workspaceId → { lastTool, toolCount, lastSeen }
  const [hookActivity, setHookActivity] = useState<Record<string, { lastTool: string; toolCount: number; lastSeen: number }>>({});
  // Per-surface Claude activity (parsed from terminal output)
  const [claudeActivity, setClaudeActivity] = useState<Record<string, any>>({});
  // surfaceId → declared agent state (blocked / working / idle), issue #128.
  const [agentStates, setAgentStates] = useState<Record<string, any>>({});
  // Hook listener is mounted once; read latest agentStates via ref.
  const agentStatesRef = useRef(agentStates);
  agentStatesRef.current = agentStates;
  // Supervisor setup dialog / engine read live declared states without prop drilling.
  useEffect(() => {
    (window as any).__wmux_getAgentStates = () => agentStatesRef.current;
    return () => {
      delete (window as any).__wmux_getAgentStates;
    };
  }, []);
  // Track when each workspace entered "running" state (for notification threshold)
  const runningStartTimes = useRef<Record<string, number>>({});
  // Browser URL tracking is now per-workspace via WorkspaceInfo.browserUrl

  // Global keyboard listener for command palette toggle (Ctrl+Shift+P)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const binding = shortcuts.commandPalette;
      const matches =
        e.key === binding.key &&
        !!binding.ctrl === e.ctrlKey &&
        !!binding.shift === e.shiftKey &&
        !!binding.alt === e.altKey;

      if (matches) {
        e.preventDefault();
        setCommandPaletteOpen((open) => !open);
        return;
      }

      // Also close palette on Escape when open
      if (e.key === 'Escape' && commandPaletteOpen) {
        setCommandPaletteOpen(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, commandPaletteOpen]);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);

  // Open tutorial on first launch, unless the welcome screen is disabled in
  // Settings (issue #22). The "seen" flag still prevents re-showing it.
  useEffect(() => {
    const showWelcome = useStore.getState().workspacePrefs.showWelcomeScreen;
    if (showWelcome && !localStorage.getItem('wmux-tutorial-seen')) {
      setTutorialOpen(true);
    }
  }, []);

  const handleTutorialClose = useCallback(() => {
    localStorage.setItem('wmux-tutorial-seen', '1');
    setTutorialOpen(false);
  }, []);

  // Open a folder as a new session (Explorer second-instance / IPC).
  const openFolderWorkspace = useCallback((dirPath: string) => {
    const dir = dirPath.trim();
    if (!dir) return;
    const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir;
    createWorkspace({
      title: base,
      cwd: dir,
      splitTree: buildDefaultSplitTree(),
    });
  }, [createWorkspace]);

  // Running instance: main process sends SYSTEM_OPEN_DIRECTORY (not executeJavaScript).
  useEffect(() => {
    const unsub = window.wmux?.system?.onOpenDirectory?.(openFolderWorkspace);
    return () => { try { unsub?.(); } catch { /* no-op */ } };
  }, [openFolderWorkspace]);

  // Initialize workspaces: Explorer cold-start folder wins over auto-save
  // (otherwise restore races the open-folder workspace back to home cwd).
  // Else prefer the rolling auto-saved session, then the most recent named
  // session, then a fresh default.
  useEffect(() => {
    let cancelled = false;
    const canInitialize = () => (
      !cancelled
      && shouldInitializeWorkspaceLayout(useStore.getState().workspaces.length)
    );

    // React remounts this component during Vite HMR. Replaying a cold-start
    // restore here would replace the live layout with the persisted layout,
    // which deliberately excludes transient AI supervisor terminals.
    if (!canInitialize()) return () => { cancelled = true; };

    (async () => {
      try {
        const launchDir = await window.wmux?.system?.consumeLaunchDirectory?.();
        if (!canInitialize()) return;
        if (typeof launchDir === 'string' && launchDir.trim()) {
          openFolderWorkspace(launchDir);
          return;
        }
      } catch { /* no-op */ }

      try {
        const autoSaved = await window.wmux?.session?.loadAuto?.();
        if (!canInitialize()) return;
        if (autoSaved && Array.isArray(autoSaved.workspaces) && autoSaved.workspaces.length > 0) {
          const { replaceAllWorkspaces } = useStore.getState();
          const restored = omitNonRestorableWorkspaces(autoSaved.workspaces, autoSaved.activeIndex);
          if (restored.workspaces.length > 0) {
            replaceAllWorkspaces(restored.workspaces, restored.activeIndex);
            if (autoSaved.sidebarWidth) setSidebarWidth(autoSaved.sidebarWidth);
            return;
          }
        }
      } catch { /* Fall through to the most recent named session. */ }
      try {
        const sessions = await window.wmux?.session?.list();
        if (!canInitialize()) return;
        if (sessions && sessions.length > 0) {
          const session = await window.wmux?.session?.load(sessions[0].name);
          if (!canInitialize()) return;
          if (session) {
            const { replaceAllWorkspaces } = useStore.getState();
            const restored = omitNonRestorableWorkspaces(session.workspaces);
            if (restored.workspaces.length > 0) {
              replaceAllWorkspaces(restored.workspaces, restored.activeIndex);
              if (session.sidebarWidth) setSidebarWidth(session.sidebarWidth);
              return;
            }
          }
        }
      } catch { /* Fall through to a fresh workspace. */ }
      // No saved session — create default workspace
      if (canInitialize()) {
        createWorkspace({
          title: 'Session 1',
          splitTree: buildDefaultSplitTree(),
        });
      }
    })();
    return () => { cancelled = true; };
  }, [createWorkspace, openFolderWorkspace]);

  // Expose helpers for main process queries + pipe bridge
  useEffect(() => {
    (window as any).__wmux_getActiveWorkspaceId = () => useStore.getState().activeWorkspaceId;
    (window as any).__wmux_getPaneLoads = () => {
      const state = useStore.getState();
      const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      if (!ws) return [];
      return getAllPaneIds(ws.splitTree).map((pid) => {
        const leaf = findLeafFromTree(ws.splitTree, pid);
        return { paneId: pid, tabCount: leaf ? leaf.surfaces.length : 0 };
      });
    };
    // Initialize pipe bridge — exposes store operations for V2 pipe handlers
    initPipeBridge();
    const disposeSupervisorInputGuard = initSupervisorGenericInputGuard();
    return () => {
      disposeSupervisorInputGuard();
      delete (window as any).__wmux_getActiveWorkspaceId;
      delete (window as any).__wmux_getPaneLoads;
    };
  }, []);

  // Load ~/.wmux/config.toml on startup and listen for `wmux reload-config`.
  // File-wins-at-startup, app-wins-at-runtime: file values are applied over
  // persisted Zustand state, then in-app edits take over until reload/restart.
  useEffect(() => {
    const cfg = (window as any).wmux?.config;
    if (!cfg?.getUserConfig) return;

    const apply = (result: any) => {
      const state = useStore.getState();
      applyUserConfigTerminal(state, result?.terminal);
      applyUserConfigBrowser(result?.browser);

      // App UI theme override (issue #67): `[appearance] ui-theme = "..."`.
      const uiTheme = result?.appearance?.uiTheme;
      if (uiTheme) state.setAppearancePrefs({ uiTheme });
    };

    cfg.getUserConfig().then(apply).catch(() => { /* no-op */ });
    const unsub = cfg.onUserConfigUpdated?.(apply);
    return () => { try { unsub?.(); } catch { /* no-op */ } };
  }, []);

  // Listen for agent spawn events from main process
  useEffect(() => {
    if (!window.wmux?.agent?.onUpdate) return;
    const unsub = window.wmux.agent.onUpdate((event: any) => {
      if (event.type === 'exited') {
        // Flip the sidebar agent line to done; no-op for unknown surfaces.
        const existing = useStore.getState().agentMeta.get(event.surfaceId);
        if (existing && existing.status !== 'exited') {
          setAgentMeta(event.surfaceId, { ...existing, status: 'exited', exitCode: event.exitCode });
        }
        return;
      }
      if (event.type === 'spawned') {
        const { surfaceId, paneId, workspaceId, label } = event;
        const state = useStore.getState();
        const ws = state.workspaces.find((w) => w.id === workspaceId);
        if (!ws) return;

        if (tryReplaceTabSpawn(event, ws, setAgentMeta)) return;

        const addSurfaceToLeaf = (node: SplitNode): SplitNode => {
          if (node.type === 'leaf' && node.paneId === paneId) {
            return { ...node, surfaces: [...node.surfaces, { id: surfaceId, type: 'terminal' }], activeSurfaceIndex: node.surfaces.length };
          }
          if (node.type === 'branch') {
            return { ...node, children: [addSurfaceToLeaf(node.children[0]), addSurfaceToLeaf(node.children[1])] as [SplitNode, SplitNode] };
          }
          return node;
        };
        state.updateSplitTree(workspaceId, addSurfaceToLeaf(ws.splitTree));
        setAgentMeta(surfaceId, { agentId: event.agentId, label, status: 'running' });
      }
    });
    return unsub;
  }, [setAgentMeta]);

  // Listen for real-time metadata updates from shell integration (pipe server → IPC → here)
  useEffect(() => {
    if (!window.wmux?.metadata?.onUpdate) return;
    const deps: MetaDeps = { updateWorkspaceMetadata, addNotification, runningStartTimes };
    const unsub = window.wmux.metadata.onUpdate((cmd: any) => {
      if (!cmd) return;
      // ports_update and notify have no (required) surfaceId — handle globally.
      if (cmd.command === 'ports_update') { handlePortsUpdate(cmd, updateWorkspaceMetadata); return; }
      if (cmd.command === 'notify') { handleNotifyCommand(cmd, addNotification); return; }
      // set_workspace_status is keyed on workspaceId (not surfaceId) — a
      // coordinator setting a named workspace's status via `wmux set-status
      // --workspace`. Handle before the surfaceId guard below.
      if (cmd.command === 'set_workspace_status') {
        const [state, text] = cmd.args || [];
        if (state === 'idle' || state === 'running' || state === 'interrupted') {
          const target = useStore.getState().workspaces.find((w) => w.id === cmd.workspaceId);
          if (target) {
            updateWorkspaceMetadata(target.id, { shellState: state, notificationText: text || undefined });
          }
        }
        return;
      }

      if (!cmd.surfaceId) return;
      const ws = workspaceForSurface(cmd.surfaceId);
      if (ws) handleSurfaceMetadata(cmd, ws, deps);
    });
    return unsub;
  }, []);

  // Listen for Claude Code hook events — tie to active workspace
  // Also auto-create diff surface when Edit/Write tools fire
  useEffect(() => {
    if (!window.wmux?.hook?.onEvent) return;
    const unsub = window.wmux.hook.onEvent((event: any) => {
      handleSupervisorHookEvent(event);
      // Agent lifecycle (issue #53): needs-input / turn-finished. No `tool`.
      // Kimi also emits PermissionRequest / StopFailure — same user-facing path.
      const lifecycle = event?.event as string | undefined;
      if (
        lifecycle === 'Notification'
        || lifecycle === 'PermissionRequest'
        || lifecycle === 'Stop'
        || lifecycle === 'StopFailure'
      ) {
        handleAgentLifecycleEvent(event, addNotification, agentStatesRef.current);
        if (lifecycle === 'Stop' || lifecycle === 'StopFailure') {
          markSessionIdleOnStop(event.surfaceId, setHookActivity);
        }
        return;
      }
      if (!event?.tool) return;
      const state = useStore.getState();
      // Key hook activity by SURFACE when the event carries one — each Claude
      // session (pane) tracks its own freshness, so two sessions in the same
      // workspace can't clobber each other into a stuck "Running"/false "Idle".
      // Legacy events without surfaceId fall back to the active workspace id.
      const key = event.surfaceId || state.activeWorkspaceId;
      if (!key) return;
      setHookActivity(prev => {
        const existing = prev[key] || { lastTool: '', toolCount: 0, lastSeen: 0 };
        return {
          ...prev,
          [key]: {
            lastTool: event.tool,
            toolCount: existing.toolCount + 1,
            lastSeen: Date.now(),
          },
        };
      });
    });
    return unsub;
  }, []);

  // NOTE: hookActivity entries are intentionally kept forever (not cleaned up).
  // Keys are surface ids (per Claude session) or workspace ids (legacy events).
  // WorkspaceRow uses the lastSeen timestamp + TTL to decide what to display.
  // Keeping stale entries lets us distinguish "Claude was active but stopped"
  // (idle) from "a regular shell command is running" (no hookActivity at all).

  // Listen for Claude Code activity parsed from terminal output
  useEffect(() => {
    if (!window.wmux?.claudeActivity?.onUpdate) return;
    const unsub = window.wmux.claudeActivity.onUpdate((data: any) => {
      if (!data?.surfaceId || !data?.activity) return;
      setClaudeActivity(prev => ({ ...prev, [data.surfaceId]: data.activity }));
    });
    return unsub;
  }, []);

  // Declared agent state pushed by the agent itself (issue #128). Unlike the
  // scraped/heuristic signals above this is authoritative, so it is kept in its
  // own map and given precedence in claude-session-view.
  useEffect(() => {
    if (!window.wmux?.agentState?.onUpdate) return;
    const unsub = window.wmux.agentState.onUpdate((data: any) => {
      if (!data?.surfaceId) return;
      setAgentStates(prev => ({ ...prev, [data.surfaceId]: data }));
      signalSupervisorDeliveryReady();
    });
    return unsub;
  }, []);

  // ── AI Supervisor scheduler (opt-in; never auto-starts) ─────────────────
  const supervisorActive = useStore((s) => s.supervisor.active);
  const supervisorSessionId = useStore((s) => s.supervisor.sessionId);
  const supervisorLaneSessionKey = useStore((s) => s.supervisor.lanes
    .map((lane) => lane.managementSessionId || lane.id)
    .join('|'));
  const supervisorPollMs = useStore((s) => s.supervisor.pollMs);
  const supervisorRuntimeRef = useRef<Record<string, LaneRuntime>>({});
  const supervisorRuntimeSessionIdRef = useRef('');
  const supervisorDeliveryInFlightRef = useRef(false);
  const recordedSupervisorManagementIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!supervisorActive) return;
    const session = useStore.getState().supervisor;
    if (supervisorRuntimeSessionIdRef.current !== session.sessionId) {
      supervisorRuntimeRef.current = {};
      supervisorRuntimeSessionIdRef.current = session.sessionId;
    }
    const launcher = detectSupervisorLauncher(session.supervisorLaunchCmd);
    const launcherName = supervisorLauncherDisplayName(launcher);
    let defaultReasoning = '不适用';
    if (launcher === 'codex') defaultReasoning = 'Codex 默认推理程度';
    else if (launcher === 'kimi') defaultReasoning = 'Kimi 默认 Thinking';
    else if (launcher === 'pi') defaultReasoning = 'Pi 默认 Thinking';
    for (const lane of session.lanes) {
      const managementSessionId = lane.managementSessionId || session.sessionId;
      if (!managementSessionId || recordedSupervisorManagementIdsRef.current.has(managementSessionId)) continue;
      recordedSupervisorManagementIdsRef.current.add(managementSessionId);
      const laneConfig = effectiveSupervisorLaneConfig(lane);
      appendSupervisorRecord(session, lane, 'session.started', {
        taskGoal: laneConfig.taskGoal,
        taskDescription: laneConfig.taskDescription,
        preconditions: laneConfig.preconditions,
        stopWhen: laneConfig.stopWhen,
        stopWhenKind: laneConfig.stopWhenKind,
        planFilePath: laneConfig.planFilePath,
        taskWorkMode: normalizeTaskWorkMode(laneConfig.taskWorkMode),
        mainThreadResponsibility: normalizeTaskThreadResponsibility(laneConfig.mainThreadResponsibility),
        childThreadResponsibilities: normalizeTaskChildThreadResponsibilities(
          laneConfig.childThreadResponsibilities,
        ),
        autonomous: effectiveSupervisorAutonomous(session, lane),
        autonomyPermissions: effectiveSupervisorAutonomyPermissions(session, lane),
        workScope: session.workScope,
        scopeRoot: lane.scopeRoot || lane.projectDir,
        forbiddenActions: effectiveSupervisorForbiddenActions(session, lane),
        supervisorModel: session.supervisorModel || `${launcherName} 默认模型`,
        supervisorReasoningEffort: session.supervisorReasoningEffort || defaultReasoning,
        terminalName: lane.label,
      });
    }
  }, [supervisorActive, supervisorSessionId, supervisorLaneSessionKey]);

  useEffect(() => {
    if (!supervisorActive) return;
    let cancelled = false;
    let retryTimer: number | null = null;

    const scheduleRetry = () => {
      if (cancelled || retryTimer != null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void flushDeliveries();
      }, 1200);
    };

    const flushDeliveries = async () => {
      if (cancelled) return;
      if (supervisorDeliveryInFlightRef.current) {
        scheduleRetry();
        return;
      }
      supervisorDeliveryInFlightRef.current = true;
      try {
        const pty = window.wmux?.pty;
        if (!pty?.has || !pty.writeChecked) return;
        const session = useStore.getState().supervisor;
        for (const lane of session.lanes) {
          let delivery = lane.pendingSupervisorDeliveries?.[0];
          const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
          if (supervisorLaneControlState(lane) !== 'active' || !delivery || !supervisorSurfaceId) continue;
          const supervisorState = agentStatesRef.current[supervisorSurfaceId]?.state || 'unknown';
          if (!canDeliverToSupervisor(supervisorState)) continue;
          const exists = await pty.has(supervisorSurfaceId);
          if (!exists) {
            if (delivery.stage === 'pasted') {
              const store = useStore.getState();
              const current = store.supervisor.lanes.find((item) => item.id === lane.id);
              if (current) {
                store.updateLane(lane.id, {
                  pendingSupervisorDeliveries: (current.pendingSupervisorDeliveries || []).map((item) => (
                    item.id === delivery!.id ? { ...item, stage: 'pending' as const } : item
                  )),
                });
              }
            }
            scheduleRetry();
            continue;
          }

          if (delivery.stage !== 'pasted') {
            const input = delivery.text.replace(/[\r\n]+$/u, '');
            const pasted = await pty.writeChecked(supervisorSurfaceId, input);
            if (!pasted) {
              scheduleRetry();
              continue;
            }
            const store = useStore.getState();
            const current = store.supervisor.lanes.find((item) => item.id === lane.id);
            const stillPending = current?.pendingSupervisorDeliveries?.some((item) => item.id === delivery!.id);
            if (!current || !stillPending) {
              // User input cancelled this review while the paste IPC was in flight.
              // The dedicated supervisor has not received Enter, so clear only
              // the automated draft that was just inserted.
              await pty.writeChecked(supervisorSurfaceId, '\x03');
              continue;
            }
            store.updateLane(lane.id, {
              pendingSupervisorDeliveries: (current.pendingSupervisorDeliveries || []).map((item) => (
                item.id === delivery!.id ? { ...item, stage: 'pasted' as const } : item
              )),
            });
            delivery = { ...delivery, text: input, stage: 'pasted' };
            await new Promise<void>((resolve) => window.setTimeout(resolve, pasteSubmitDelayMs(input)));
          }

          const beforeSubmit = useStore.getState().supervisor.lanes
            .find((item) => item.id === lane.id)
            ?.pendingSupervisorDeliveries?.find((item) => item.id === delivery!.id);
          if (!beforeSubmit) {
            await pty.writeChecked(supervisorSurfaceId, '\x03');
            continue;
          }
          const submitted = await pty.writeChecked(supervisorSurfaceId, '\r');
          if (!submitted) {
            if (!await pty.has(supervisorSurfaceId)) {
              const store = useStore.getState();
              const current = store.supervisor.lanes.find((item) => item.id === lane.id);
              if (current) {
                store.updateLane(lane.id, {
                  pendingSupervisorDeliveries: (current.pendingSupervisorDeliveries || []).map((item) => (
                    item.id === delivery!.id ? { ...item, stage: 'pending' as const } : item
                  )),
                });
              }
            }
            scheduleRetry();
            continue;
          }
          const store = useStore.getState();
          const current = store.supervisor.lanes.find((item) => item.id === lane.id);
          if (!current) continue;
          store.updateLane(lane.id, {
            pendingSupervisorDeliveries: (current.pendingSupervisorDeliveries || []).filter((item) => item.id !== delivery.id),
          });
          appendSupervisorRecord(store.supervisor, current, 'supervisor.delivery.delivered', {
            kind: delivery.kind,
            task: delivery.task,
          });
          store.appendSupervisorLog(lane.id, '监督通知已送达', delivery.kind === 'task-start' ? '任务开始' : delivery.kind === 'task-end' ? '任务结束' : '任务中断');
        }
      } catch {
        // Keep the head event queued and retry only while delivery work exists.
        scheduleRetry();
      } finally {
        supervisorDeliveryInFlightRef.current = false;
      }
    };

    void flushDeliveries();
    const onDeliveryReady = () => void flushDeliveries();
    window.addEventListener(SUPERVISOR_DELIVERY_READY_EVENT, onDeliveryReady);
    return () => {
      cancelled = true;
      window.removeEventListener(SUPERVISOR_DELIVERY_READY_EVENT, onDeliveryReady);
      if (retryTimer != null) window.clearTimeout(retryTimer);
    };
  }, [supervisorActive]);

  useEffect(() => {
    if (!supervisorActive) return;

    const runTick = () => {
      const store = useStore.getState();
      const session = store.supervisor;
      if (!session.active) return;
      const now = Date.now();
      const states = agentStatesRef.current;

      for (const lane of session.lanes) {
        if (supervisorLaneControlState(lane) !== 'active') continue;
        if (!supervisorRuntimeRef.current[lane.id]) {
          supervisorRuntimeRef.current[lane.id] = blankRuntime();
        }
        const runtime = supervisorRuntimeRef.current[lane.id];
        const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
        const supervisorState = supervisorSurfaceId ? states[supervisorSurfaceId]?.state || 'unknown' : 'unknown';
        if (supervisorSurfaceId && supervisorState !== 'working') {
          const screen = readTerminalScreen(supervisorSurfaceId, 30);
          if (screen.text) reportSupervisorProviderLimit(session, lane, screen.text);
        }
        const surfaceState = states[lane.surfaceId] || { state: 'unknown' };
        const { actions, runtime: nextRt } = tickLane({
          session,
          lane,
          surfaceState: {
            state: surfaceState.state || 'unknown',
            blockedReason: surfaceState.blockedReason,
            updatedAt: surfaceState.updatedAt,
          },
          runtime,
          now,
        });
        supervisorRuntimeRef.current[lane.id] = nextRt;

        for (const action of actions) {
          if (action.type === 'log') {
            store.appendSupervisorLog(action.laneId, action.action, action.detail);
          } else if (action.type === 'notify_supervisor') {
            if (action.opensReview) store.updateLane(action.laneId, { awaitingReview: true });
            const lane = useStore.getState().supervisor.lanes.find((item) => item.id === action.laneId);
            if (lane && action.statusEvent === 'blocked') {
              appendSupervisorRecord(session, lane, 'worker.blocked', {
                reason: action.statusDetail || '终端正在等待输入或权限处理',
              });
            }
            const sid = lane ? dedicatedSupervisorSurfaceId(lane) : null;
            if (sid) {
              try {
                sendToSurface(sid, action.text, true);
              } catch (err) {
                if (action.opensReview) store.updateLane(action.laneId, { awaitingReview: false });
                store.appendSupervisorLog(action.laneId, '监督通知发送失败', String((err as Error)?.message || err));
              }
            } else if (action.opensReview) {
              store.updateLane(action.laneId, { awaitingReview: false });
              store.appendSupervisorLog(action.laneId, '监督通知发送失败', '专属监督终端不存在');
            }
          } else if (action.type === 'notify_user') {
            const lane = store.supervisor.lanes.find((l) => l.id === action.laneId);
            const text = buildUserNotifyText({
              reason: action.reason,
              laneLabel: lane?.label,
              stopWhen: lane ? effectiveSupervisorStopWhen(lane) : '',
              detail: action.detail,
            });
            store.appendSupervisorLog(action.laneId, lane?.projectManagerProjectId ? '通知项目管理 AI' : '通知你', action.reason);
            if (lane?.projectManagerProjectId) {
              void Promise.resolve((window as any).__wmux_projectManagerRemoteControl?.({
                action: 'event',
                projectId: lane.projectManagerProjectId,
                workItemId: lane.projectWorkItemId,
                eventType: 'supervisor.scheduler-attention',
                summary: text,
                payload: { reason: action.reason, detail: action.detail || '' },
              })).catch(() => undefined);
            } else {
              store.addNotification({
                surfaceId: (lane?.surfaceId || '') as SurfaceId,
                workspaceId: (store.activeWorkspaceId || '') as WorkspaceId,
                text: text.replace(/\n/g, ' · '),
              });
            }
            store.stopSupervisorLane(action.laneId, action.reason);
          }
        }
      }
    };

    runTick();
    const id = window.setInterval(runTick, Math.max(1500, supervisorPollMs || 4000));
    return () => clearInterval(id);
  }, [supervisorActive, supervisorPollMs]);

  // ── Windows taskbar progress (OSC 9;4) ──────────────────────────────────
  // Fold every surface's progress into one value for this window's taskbar
  // button — the same convention Windows Terminal follows for the sequence.
  const surfaceProgress = useStore((s) => s.surfaceProgress);
  useEffect(() => {
    const api = window.wmux?.window;
    if (!api?.setProgress) return;
    const agg = aggregateProgress(Object.values(surfaceProgress));
    if (!agg) {
      api.setProgress(-1, 'none');
      return;
    }
    const MODES: Record<number, string> = { 1: 'normal', 2: 'error', 3: 'indeterminate', 4: 'paused' };
    const value = agg.state === 3 ? 1 : Math.min(1, Math.max(0, agg.value / 100));
    api.setProgress(value, MODES[agg.state]);
  }, [surfaceProgress]);

  // Respond to main process auto-save requests (30s timer + on quit)
  useEffect(() => {
    if (!window.wmux?.session?.onAutoSaveRequest) return;
    const unsub = window.wmux.session.onAutoSaveRequest(() => {
      const state = useStore.getState();
      const activeIndex = state.workspaces.findIndex((workspace) => workspace.id === state.activeWorkspaceId);
      const supervisorSurfaceIds = state.supervisor.lanes
        .map(dedicatedSupervisorSurfaceId)
        .filter((surfaceId): surfaceId is SurfaceId => !!surfaceId);
      // Project task terminals also contain native Agent conversations. Even
      // legacy surfaces without the new marker must not replay their old prompt.
      const projectTaskSurfaceIds = state.projectManagers.flatMap((session) => [
        session.taskTerminalSurfaceId,
        ...session.workItems.map((item) => item.workerSurfaceId),
      ]).filter((surfaceId): surfaceId is string => !!surfaceId);
      const persisted = omitNonRestorableWorkspaces(
        state.workspaces,
        activeIndex,
        [...supervisorSurfaceIds, ...projectTaskSurfaceIds],
      );
      const data = {
        version: 1,
        windows: [{
          bounds: { x: 0, y: 0, width: 0, height: 0 }, // main process fills real bounds
          sidebarWidth,
          activeWorkspaceId: persisted.workspaces[persisted.activeIndex]?.id ?? null,
          workspaces: persisted.workspaces.map(ws => ({
            id: ws.id,
            title: ws.title,
            customColor: ws.customColor,
            pinned: ws.pinned,
            shell: ws.shell,
            cwd: ws.cwd, // issue #20 — restore so new terminals reopen in the workspace folder
            splitTree: ws.splitTree,
            browserUrl: ws.browserUrl,
            browserWidth: ws.browserWidth,
            transientSupervisorWorkspace: ws.transientSupervisorWorkspace,
            sshProfileId: ws.sshProfileId,
          })),
        }],
      };
      window.wmux.session.pushAutoSave(data);
    });
    return unsub;
  }, [sidebarWidth]);

  // Auto-focus first pane whenever the active workspace changes or gains its first pane
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  // During drag use live browserWidth state; otherwise use the persisted value from the
  // workspace (falls back to browserWidth for workspaces that have never been resized).
  const displayBrowserWidth = isResizingBrowser ? browserWidth : (activeWorkspace?.browserWidth ?? browserWidth);

  useEffect(() => {
    if (!activeWorkspace) return;
    const paneIds = getAllPaneIds(activeWorkspace.splitTree);
    if (paneIds.length > 0 && (focusedPaneId === null || !paneIds.includes(focusedPaneId))) {
      setFocusedPaneId(paneIds[0]);
    }
  }, [activeWorkspace?.id, activeWorkspace?.splitTree]);

  const handleRatioChange = useCallback(
    (leftPaneId: PaneId, rightPaneId: PaneId, ratio: number) => {
      if (!activeWorkspace) return;
      const newTree = updateRatio(activeWorkspace.splitTree, leftPaneId, rightPaneId, ratio);
      updateSplitTree(activeWorkspace.id, newTree);
    },
    [activeWorkspace, updateSplitTree],
  );

  const handlePaneFocus = useCallback((paneId: PaneId) => {
    setFocusedPaneId(paneId);
  }, []);

  // A local user Enter outranks an in-flight AI review immediately. The agent's
  // UserPromptSubmit hook remains useful task metadata, but is no longer the
  // safety boundary because hook delivery can lag behind terminal input.
  useEffect(() => {
    const onUserSubmit = (event: Event) => {
      const surfaceId = String((event as CustomEvent<{ surfaceId?: string }>).detail?.surfaceId || '');
      handleSupervisorUserSubmit(surfaceId);
    };
    window.addEventListener(TERMINAL_USER_SUBMIT_EVENT, onUserSubmit);
    return () => window.removeEventListener(TERMINAL_USER_SUBMIT_EVENT, onUserSubmit);
  }, []);

  const handleOpenSshFile = useCallback(async (entry: SshFileEntry) => {
    if (!activeWorkspaceId) throw new Error('SSH 工作区不存在');
    const stateBeforeRead = useStore.getState();
    const workspaceBeforeRead = stateBeforeRead.workspaces.find((item) => item.id === activeWorkspaceId);
    if (!workspaceBeforeRead) throw new Error('SSH 工作区不存在');
    const existing = findSshFileSurface(workspaceBeforeRead.splitTree, activeWorkspaceId, entry.path);
    if (existing) {
      stateBeforeRead.selectSurface(activeWorkspaceId, existing.paneId, existing.index);
      setFocusedPaneId(existing.paneId);
      return;
    }

    const read = window.wmux?.ssh?.readFile?.(activeWorkspaceId, entry.path);
    if (!read) throw new Error('SSH 文件接口未更新，请重启应用后重试');
    const file = await read;
    if (file?.error || typeof file?.content !== 'string') {
      throw new Error(file?.error || '读取远程文件失败');
    }
    const state = useStore.getState();
    const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId);
    if (!workspace) throw new Error('SSH 工作区已关闭');
    const paneId = focusedPaneId && findLeaf(workspace.splitTree, focusedPaneId)
      ? focusedPaneId
      : getAllPaneIds(workspace.splitTree)[0];
    if (!paneId) throw new Error('没有可用于打开编辑器的窗格');
    const surfaceId = state.addSurface(activeWorkspaceId, paneId, 'markdown', { customTitle: entry.name });
    if (!surfaceId) throw new Error('无法创建编辑器标签');
    state.updateSurface(activeWorkspaceId, paneId, surfaceId, {
      markdownContent: file.content,
      markdownFileName: entry.name,
      markdownFilePath: file.path,
      markdownFileMtime: file.mtimeMs,
      markdownViewMode: 'source',
      markdownDirty: false,
      sshFileWorkspaceId: activeWorkspaceId,
      sshFilePath: file.path,
    });
    setFocusedPaneId(paneId);
  }, [activeWorkspaceId, focusedPaneId]);

  const handleSidebarWidthChange = useCallback((newWidth: number) => {
    setSidebarWidth(newWidth);
  }, []);

  /** Selecting a session acknowledges idle attention and stops taskbar flash. */
  const handleSelectWorkspace = useCallback((id: WorkspaceId) => {
    selectWorkspace(id);
    clearSessionAttention(id);
  }, [selectWorkspace]);

  // OS window focus → cancel flash and clear attention on the active session.
  useEffect(() => {
    const unsub = window.wmux?.window?.onFocus?.(() => {
      clearSessionAttention(useStore.getState().activeWorkspaceId);
    });
    return () => { unsub?.(); };
  }, []);

  const handleCreateWorkspace = useCallback(() => {
    const wsCount = useStore.getState().workspaces.length;
    const newId = createWorkspace({
      title: `Session ${wsCount + 1}`,
      splitTree: buildDefaultSplitTree(),
    });
    handleSelectWorkspace(newId);
  }, [createWorkspace, handleSelectWorkspace]);

  const connectSshWorkspace = useCallback(async (
    workspaceId: WorkspaceId,
    profile: SshConnectionProfile,
    password?: string,
  ): Promise<boolean> => {
    updateWorkspaceMetadata(workspaceId, { sshConnectionState: 'connecting', sshConnectionError: undefined });
    const existingWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === workspaceId);
    if (existingWorkspace) {
      updateSplitTree(workspaceId, attachSshProfileId(existingWorkspace.splitTree, profile.id));
    }
    try {
      const result = await window.wmux?.ssh?.connect?.(workspaceId, profile, password);
      if (!result?.ok) {
        const errorMessage = result?.error || 'SSH 连接失败';
        if (result?.passwordRequired) {
          updateWorkspaceMetadata(workspaceId, { sshConnectionState: 'connecting', sshConnectionError: errorMessage });
          setSshPasswordRequest({ workspaceId, profile, errorMessage });
        } else {
          updateWorkspaceMetadata(workspaceId, { sshConnectionState: 'error', sshConnectionError: errorMessage });
        }
        return false;
      }
      if (result.authMethod === 'password') {
        const passwordProfile: SshConnectionProfile = {
          ...profile,
          authMethod: 'password',
          privateKeyPath: undefined,
        };
        const profiles = useStore.getState().sshConnections;
        setSshConnections(profiles.map((item) => item.id === profile.id ? passwordProfile : item));
        const workspace = useStore.getState().workspaces.find((item) => item.id === workspaceId);
        if (workspace) {
          updateSplitTree(workspaceId, upgradeSshSplitTree(workspace.splitTree, passwordProfile));
        }
      }
      updateWorkspaceMetadata(workspaceId, { sshConnectionState: 'connected' });
      setSshPasswordRequest((request) => request?.workspaceId === workspaceId ? null : request);
      return true;
    } catch (reason) {
      const errorMessage = reason instanceof Error ? reason.message : String(reason);
      updateWorkspaceMetadata(workspaceId, {
        sshConnectionState: 'error',
        sshConnectionError: errorMessage,
      });
      return false;
    }
  }, [setSshConnections, updateSplitTree, updateWorkspaceMetadata]);

  useEffect(() => {
    for (const workspace of workspaces) {
      if (workspace.sshConnectionState !== 'disconnected' || !workspace.sshProfileId) continue;
      if (autoReconnectedSshWorkspaceIdsRef.current.has(workspace.id)) continue;
      const profile = sshConnections.find((item) => item.id === workspace.sshProfileId);
      if (!profile || profile.authMethod !== 'password') continue;
      autoReconnectedSshWorkspaceIdsRef.current.add(workspace.id);
      void connectSshWorkspace(workspace.id, profile);
    }
  }, [connectSshWorkspace, sshConnections, workspaces]);

  const handleCreateSshWorkspace = useCallback((profile: SshConnectionProfile, companionAgent: SshCompanionAgent, password?: string) => {
    const existing = sshConnections.findIndex((item) => item.id === profile.id);
    const saved = existing >= 0
      ? sshConnections.map((item, index) => index === existing ? profile : item)
      : [...sshConnections, profile];
    setSshConnections(saved);
    setSshDialogOpen(false);
    const workspaceId = createWorkspace({
      title: profile.name,
      splitTree: buildSshSplitTree(profile, companionAgent),
      sshProfileId: profile.id,
      sshConnectionState: 'connecting',
    });
    handleSelectWorkspace(workspaceId);
    void connectSshWorkspace(workspaceId, profile, password);
  }, [createWorkspace, connectSshWorkspace, handleSelectWorkspace, setSshConnections, sshConnections]);

  const handleSshProfilesChange = useCallback((profiles: SshConnectionProfile[]) => {
    setSshConnections(profiles);
    const state = useStore.getState();
    for (const workspace of state.workspaces) {
      if (!workspace.sshProfileId) continue;
      const profile = profiles.find((item) => item.id === workspace.sshProfileId);
      if (profile) updateSplitTree(workspace.id, upgradeSshSplitTree(workspace.splitTree, profile));
    }
  }, [setSshConnections, updateSplitTree]);

  const handleSaveSession = useCallback(async (name: string) => {
    const state = useStore.getState();
    const session = {
      name,
      savedAt: Date.now(),
      workspaces: state.workspaces.map(ws => ({
        title: ws.title,
        customColor: ws.customColor,
        shell: ws.shell,
        cwd: ws.cwd || '',
        splitTree: ws.splitTree,
        browserUrl: ws.browserUrl || '',
        browserWidth: ws.browserWidth,
        transientSupervisorWorkspace: ws.transientSupervisorWorkspace,
        sshProfileId: ws.sshProfileId,
      })),
      sidebarWidth,
      terminalPrefs: { ...state.terminalPrefs },
    };
    await window.wmux?.session?.save(session);
    window.wmux?.notification?.fire({ surfaceId: '', text: `Session "${name}" saved`, title: 'wmux' });
  }, [sidebarWidth]);

  const handleLoadSession = useCallback(async (name: string) => {
    const session = await window.wmux?.session?.load(name);
    if (!session) return;
    const { replaceAllWorkspaces, setTerminalPrefs } = useStore.getState();
    replaceAllWorkspaces(session.workspaces);
    if (session.sidebarWidth) setSidebarWidth(session.sidebarWidth);
    if (session.terminalPrefs) setTerminalPrefs(session.terminalPrefs);
  }, []);

  const handleUpdateMetadata = useCallback(
    (id: WorkspaceId, partial: Partial<WorkspaceInfo>) => {
      updateWorkspaceMetadata(id, partial);
    },
    [updateWorkspaceMetadata],
  );

  const handlePaletteClose = useCallback(() => {
    setCommandPaletteOpen(false);
  }, []);

  const handlePaletteAction = useCallback((action: string) => {
    console.log(`[wmux] Command palette action: ${action}`);
    setCommandPaletteOpen(false);
  }, []);

  const workspaceNames = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const ws of workspaces) map.set(ws.id, ws.title);
    return map;
  }, [workspaces]);

  const handleNotificationJump = useCallback(
    (workspaceId: WorkspaceId, surfaceId: SurfaceId, _paneId?: PaneId) => {
      handleSelectWorkspace(workspaceId);
      const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
      function findPaneForSurface(node: SplitNode): { paneId: PaneId; index: number } | null {
        if (node.type === 'leaf') {
          const idx = node.surfaces.findIndex((s) => s.id === surfaceId);
          if (idx !== -1) return { paneId: node.paneId, index: idx };
          return null;
        }
        return findPaneForSurface(node.children[0]) || findPaneForSurface(node.children[1]);
      }
      const found = findPaneForSurface(ws.splitTree);
      if (found) {
        setFocusedPaneId(found.paneId);
        selectSurface(workspaceId, found.paneId, found.index);
      }
      markRead(surfaceId);
    },
    [handleSelectWorkspace, markRead, selectSurface],
  );

  const handleToggleNotifPanel = useCallback(() => {
    setNotifPanelOpen((o) => !o);
  }, []);

  const [zoomedPaneId, setZoomedPaneId] = useState<PaneId | null>(null);
  const [surfaceDrag, setSurfaceDrag] = useState<SurfaceDragPayload | null>(null);
  const [surfaceDragPreview, setSurfaceDragPreview] = useState<SurfaceDragPreview | null>(null);
  const surfaceDragRef = useRef<SurfaceDragPayload | null>(null);
  const surfaceDragPreviewRef = useRef<SurfaceDragPreview | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const pendingPreviewTargetRef = useRef<{ targetPaneId: PaneId; target: SurfaceDragPreviewTarget } | null>(null);

  const handleToggleZoom = useCallback(() => {
    setZoomedPaneId((prev) => (prev ? null : focusedPaneId));
  }, [focusedPaneId]);

  useEffect(() => {
    surfaceDragRef.current = surfaceDrag;
  }, [surfaceDrag]);

  useEffect(() => {
    surfaceDragPreviewRef.current = surfaceDragPreview;
  }, [surfaceDragPreview]);

  useEffect(() => {
    return () => {
      if (previewFrameRef.current !== null) {
        cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = null;
      }
    };
  }, []);

  const handleSurfaceDragStart = useCallback((payload: SurfaceDragPayload) => {
    surfaceDragRef.current = payload;
    setSurfaceDrag(payload);
  }, []);

  const handleSurfaceDragEnd = useCallback(() => {
    pendingPreviewTargetRef.current = null;
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    surfaceDragRef.current = null;
    surfaceDragPreviewRef.current = null;
    setSurfaceDrag(null);
    setSurfaceDragPreview(null);
    document.body.classList.remove('wmux-dragging');
  }, []);

  const handleSurfaceDragPreviewTarget = useCallback((targetPaneId: PaneId, target: SurfaceDragPreviewTarget) => {
    pendingPreviewTargetRef.current = { targetPaneId, target };

    if (previewFrameRef.current !== null) return;

    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;

      const pending = pendingPreviewTargetRef.current;
      const drag = surfaceDragRef.current;
      if (!pending || !drag) {
        surfaceDragPreviewRef.current = null;
        setSurfaceDragPreview(null);
        return;
      }

      const nextPreview = buildSurfaceDragPreview({
        workspaces: useStore.getState().workspaces,
        activeWorkspaceId,
        drag,
        pendingTarget: pending,
      });
      surfaceDragPreviewRef.current = nextPreview;
      setSurfaceDragPreview(nextPreview);
    });
  }, [activeWorkspaceId]);

  const handleClearSurfaceDragPreview = useCallback(() => {
    pendingPreviewTargetRef.current = null;
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    surfaceDragPreviewRef.current = null;
    setSurfaceDragPreview(null);
  }, []);

  const handleSurfaceDragCommit = useCallback((options?: SurfaceDragCommitOptions) => {
    if (options?.clearZoom || surfaceDragPreviewRef.current) setZoomedPaneId(null);
    pendingPreviewTargetRef.current = null;
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    surfaceDragRef.current = null;
    surfaceDragPreviewRef.current = null;
    setSurfaceDrag(null);
    setSurfaceDragPreview(null);
    document.body.classList.remove('wmux-dragging');
  }, []);

  useEffect(() => {
    if (!surfaceDrag) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleSurfaceDragEnd();
    };

    // Native dragend is not guaranteed when Electron loses focus or React
    // detaches the dragged tab during a drop. The stale drag state leaves an
    // invisible drop-zone layer above terminal and supervisor inputs. Any new
    // pointer interaction means the old drag has ended, so clear it in capture
    // phase before normal application handling resumes.
    const onPointerDown = () => handleSurfaceDragEnd();
    const onWindowBlur = () => handleSurfaceDragEnd();
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') handleSurfaceDragEnd();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [surfaceDrag, handleSurfaceDragEnd]);

  // Clear zoom when the zoomed pane no longer exists
  useEffect(() => {
    if (!zoomedPaneId || !activeWorkspace) return;
    const paneIds = getAllPaneIds(activeWorkspace.splitTree);
    if (!paneIds.includes(zoomedPaneId)) setZoomedPaneId(null);
  }, [zoomedPaneId, activeWorkspace]);

  useKeyboardShortcuts(focusedPaneId, setSettingsOpen, () => setBrowserOpen(o => !o), handleToggleNotifPanel, setFocusedPaneId, handleToggleZoom);

  // Derive a title for the titlebar: active workspace title or blank
  const titlebarText = activeWorkspace?.title ?? '';
  const activeSshProfile = activeWorkspace?.sshProfileId
    ? sshConnections.find((profile) => profile.id === activeWorkspace.sshProfileId)
    : undefined;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {tutorialOpen && <Tutorial onClose={handleTutorialClose} />}
      {settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} />}
      {sshDialogOpen && <SshConnectionDialog
        profiles={sshConnections}
        defaultCompanionAgent={workspacePrefs.defaultSshAgent}
        onClose={() => setSshDialogOpen(false)}
        onConnect={handleCreateSshWorkspace}
        onProfilesChange={handleSshProfilesChange}
        onSetDefaultCompanionAgent={(agent) => setWorkspacePrefs({ defaultSshAgent: agent })}
      />}
      {sshPasswordRequest && <SshPasswordDialog
        profileName={sshPasswordRequest.profile.name}
        errorMessage={sshPasswordRequest.errorMessage}
        onCancel={() => {
          updateWorkspaceMetadata(sshPasswordRequest.workspaceId, {
            sshConnectionState: 'error',
            sshConnectionError: sshPasswordRequest.errorMessage,
          });
          setSshPasswordRequest(null);
        }}
        onSubmit={(password) => connectSshWorkspace(
          sshPasswordRequest.workspaceId,
          sshPasswordRequest.profile,
          password,
        )}
      />}
      <Titlebar
        title={titlebarText}
        onHelpClick={() => setTutorialOpen(true)}
        onDevToolsClick={() => window.wmux?.system?.toggleDevTools?.()}
        onSettingsClick={() => setSettingsOpen(true)}
        notifications={notifications}
        workspaceNames={workspaceNames}
        notificationPanelOpen={notifPanelOpen}
        onToggleNotificationPanel={handleToggleNotifPanel}
        onNotificationJump={handleNotificationJump}
        onMarkAllNotificationsRead={() => markAllRead()}
        onClearAllNotifications={() => clearAll()}
      />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {sidebarVisible ? (
          <Sidebar
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            sidebarWidth={sidebarWidth}
            onWidthChange={handleSidebarWidthChange}
            onSelect={handleSelectWorkspace}
            onClose={requestCloseWorkspace}
            onCreate={handleCreateWorkspace}
            onCreateSsh={() => setSshDialogOpen(true)}
            onRename={renameWorkspace}
            onReorder={reorderWorkspaces}
            onUpdateMetadata={handleUpdateMetadata}
            hookActivity={hookActivity}
            claudeActivity={claudeActivity}
            agentStates={agentStates}
            onSaveSession={handleSaveSession}
            onLoadSession={handleLoadSession}
            onCollapse={toggleSidebar}
            onFocusAgentPane={(wsId, paneId) => {
              handleSelectWorkspace(wsId);
              setFocusedPaneId(paneId);
            }}
          />
        ) : (
          <div
            className="sidebar-expand-strip"
            onClick={toggleSidebar}
            onMouseDown={(e) => {
              // Allow drag-to-expand: start listening for mousemove
              e.preventDefault();
              const onMove = (ev: MouseEvent) => {
                if (ev.clientX > 20) {
                  toggleSidebar();
                  setSidebarWidth(Math.max(180, ev.clientX));
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                }
              };
              const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
              };
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            }}
            title="Expand sidebar (Ctrl+B)"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z"/>
            </svg>
          </div>
        )}

        {/* Middle: terminals — ALL workspaces stay mounted, only active is visible */}
        {/* This keeps PTYs alive when switching sessions (Claude Code etc. keep running) */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minWidth: 0 }}>
          {customBgActive && (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                inset: 0,
                background: appearancePrefs.customBackground,
                pointerEvents: 'none',
              }}
            />
          )}
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              style={{
                position: 'absolute',
                inset: 0,
                visibility: ws.id === activeWorkspaceId ? 'visible' : 'hidden',
                pointerEvents: ws.id === activeWorkspaceId ? 'auto' : 'none',
              }}
            >
              <SplitContainer
                node={
                  ws.id === activeWorkspaceId && zoomedPaneId
                    ? (findLeaf(ws.splitTree, zoomedPaneId) ?? ws.splitTree)
                    : ws.splitTree
                }
                workspaceId={ws.id}
                focusedPaneId={ws.id === activeWorkspaceId ? focusedPaneId : null}
                onRatioChange={ws.id === activeWorkspaceId ? handleRatioChange : undefined}
                onPaneFocus={handlePaneFocus}
                surfaceDrag={ws.id === activeWorkspaceId ? surfaceDrag : null}
                onSurfaceDragStart={handleSurfaceDragStart}
                onSurfaceDragEnd={handleSurfaceDragEnd}
                onSurfaceDragPreviewTarget={handleSurfaceDragPreviewTarget}
                onClearSurfaceDragPreview={handleClearSurfaceDragPreview}
                onSurfaceDragCommit={handleSurfaceDragCommit}
              />
              {surfaceDragPreview?.workspaceId === ws.id && ws.id === activeWorkspaceId && (
                <SplitPreviewOverlay
                  tree={surfaceDragPreview.previewTree}
                  destinationPaneId={surfaceDragPreview.destinationPaneId}
                  draggedSurfaceId={surfaceDragPreview.surfaceId}
                  workspaceShell={ws.shell}
                />
              )}
            </div>
          ))}
        </div>

        {activeWorkspace && activeSshProfile && (
          <SshFileDrawer
            workspaceId={activeWorkspace.id}
            state={activeWorkspace.sshConnectionState ?? 'disconnected'}
            errorMessage={activeWorkspace.sshConnectionError}
            onReconnect={() => void connectSshWorkspace(activeWorkspace.id, activeSshProfile)}
            onOpenFile={handleOpenSshFile}
          />
        )}

        {/* Right: browser panel */}
        {browserOpen && (
          <>
            <div
              style={{
                width: 4,
                cursor: 'col-resize',
                flexShrink: 0,
                position: 'relative',
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingBrowser(true);
                const startX = e.clientX;
                const startWidth = activeWorkspace?.browserWidth ?? browserWidth;
                setBrowserWidth(startWidth);
                let finalWidth = startWidth;
                const onMove = (ev: MouseEvent) => {
                  const delta = startX - ev.clientX;
                  finalWidth = Math.max(250, Math.min(window.innerWidth - 400, startWidth + delta));
                  setBrowserWidth(finalWidth);
                };
                const onUp = () => {
                  setIsResizingBrowser(false);
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                  if (activeWorkspaceId) updateWorkspaceMetadata(activeWorkspaceId as any, { browserWidth: finalWidth });
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
            >
              <div style={{
                position: 'absolute',
                left: '50%',
                top: 0,
                bottom: 0,
                width: 1,
                background: 'rgba(255,255,255,0.04)',
                transform: 'translateX(-50%)',
              }} />
            </div>
            <div style={{ width: displayBrowserWidth, flexShrink: 0, overflow: 'hidden', position: 'relative' }}>
              {isResizingBrowser && (
                <div style={{
                  position: 'absolute', inset: 0, zIndex: 10,
                  cursor: 'col-resize', background: 'transparent',
                }} />
              )}
              {/* Browser close button */}
              <button
                onClick={() => setBrowserOpen(false)}
                style={{
                  position: 'absolute', top: 6, right: 8, zIndex: 20,
                  background: 'rgba(0,0,0,0.5)', border: 'none', color: '#999',
                  cursor: 'pointer', fontSize: 14, padding: '2px 6px', lineHeight: 1,
                  borderRadius: 3, backdropFilter: 'blur(4px)',
                }}
                onMouseEnter={(e) => { (e.target as HTMLElement).style.color = '#fff'; (e.target as HTMLElement).style.background = 'rgba(220,50,50,0.7)'; }}
                onMouseLeave={(e) => { (e.target as HTMLElement).style.color = '#999'; (e.target as HTMLElement).style.background = 'rgba(0,0,0,0.5)'; }}
                title="Close browser panel"
              >×</button>
              {/* Per-workspace browser — all stay mounted, only active visible */}
              {workspaces.map((ws) => (
                <div
                  key={`browser-${ws.id}`}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: ws.id === activeWorkspaceId ? 'block' : 'none',
                  }}
                >
                  <BrowserPane
                    surfaceId={`browser-${ws.id}`}
                    initialUrl={ws.browserUrl}
                    onUrlChange={(url) => { updateWorkspaceMetadata(ws.id, { browserUrl: url }); }}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {commandPaletteOpen && (
        <CommandPalette
          onClose={handlePaletteClose}
          onAction={handlePaletteAction}
        />
      )}

      {cheatSheetOpen && <ShortcutCheatSheet onClose={() => setCheatSheetOpen(false)} />}

      <ConfirmCloseDialog />
      <ConfirmCloseSurfaceDialog />
      <SupervisorSetupDialog />
      <ProjectManagerDialog />

      {broadcastInputActive && (
        <div className="broadcast-input-banner" title="Typed input is sent to every terminal pane in this workspace">
          Broadcast input ON — typing goes to all panes (Ctrl+Alt+B to stop)
        </div>
      )}
    </div>
  );
}
