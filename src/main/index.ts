import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { registerIpcHandlers, agentManager, ptyManager, setupAgentPtyForwarding, sshManager, sshTransferCache } from './ipc-handlers';
import { notifySupervisorTerminalInput, supervisorGenericInputBlockReason } from './supervisor-input-guard';
import { handleBrowserV2 } from './v2-browser';
import { handleBridgeV2 } from './v2-bridge';
import { distributeAgents } from './agent-manager';
import { PipeServer } from './pipe-server';
import { PortScanner } from './port-scanner';
import { CDPProxy } from './cdp-proxy';
import { IPC_CHANNELS, SurfaceId } from '../shared/types';
import { getPipePath, getAppDataDir, ensurePipeToken } from '../shared/instance';
import { loadSession, saveSession, handleVersionChange, SessionData } from './session-persistence';
import { sessionWindows, MAX_RESTORED_WINDOWS } from './session-windows';
import { WindowManager } from './window-manager';
import { initAutoUpdater, requestUpdateNow, getUpdateState } from './updater';
import { initUpdateChecker, getLatestUpdate } from './update-checker';
import { ensureClaudeHooks, ensureChromeDevtoolsConfig, ensureOrchestratorPlugin } from './claude-context';
import { ensureOpencodeContext, ensureOpencodePlugin } from './opencode-context';
import { ensureKimiHooks } from './kimi-context';
import { ensureCodexHooks, ensureCodexProjectTrusted } from './codex-context';
import { ensureGrokHooks } from './grok-context';
import { ensurePiHooks } from './pi-context';
import { applyExternalActivity, markSubagentStop, markAllAgentsDone } from './claude-observer';
import { handleAgentStateV2 } from './agent-state-rpc';
import { applyHookToAgentState, isAgentHookTerminalEvent } from './agent-hook-bridge';
import {
  appendSupervisorRecord,
  listSupervisorRestoreCandidates,
  readLatestSupervisorHistory,
  readSupervisorAuditTrail,
} from './supervisor-records';
import { FeishuSupervisorService, type FeishuSupervisorCommand } from './feishu-supervisor';
import { createFeishuDirectTaskDirectory, resolveExistingFeishuDirectTaskDirectory } from './feishu-direct-task';
import {
  USER_RECORDS_TERMINAL_AGENT,
  USER_RECORDS_TERMINAL_DIRECTORY,
  USER_RECORDS_TERMINAL_NAME,
  USER_RECORDS_TERMINAL_SKILL_RELATIVE_PATH,
  USER_RECORDS_TERMINAL_STARTUP_INPUT,
} from '../shared/user-records-terminal';
import {
  parseSupervisorConfig,
  serializeSupervisorConfig,
} from './supervisor-config-file';
import { listSupervisorModels, validateSupervisorModel } from './supervisor-model-validation';
import { startOrchestrationWatcher } from './orchestration-watcher';
import { readMarkdownFile } from './markdown-file';
import { grantMarkdownPath, clearMarkdownGrants } from './markdown-grants';
import {
  directoryFromArgv,
  setPendingLaunchDirectory,
  isContextMenuInstalled,
  installContextMenu,
} from './shell-context-menu';
import fs from 'fs';
import path from 'path';
import { initializeLoginStartup } from './login-startup';
import { ensureProjectManagerSkill } from './project-manager-skill';
import {
  appendProjectManagerRecord,
  deleteProjectManagerSession,
  readActiveProjectManagerSessions,
  readLatestProjectManagerSession,
  saveProjectManagerSession,
} from './project-manager-records';
import { captureProjectPlanFiles, PROJECT_PLAN_FILE_DIALOG_EXTENSIONS } from './project-plan-files';

let feishuSupervisor: FeishuSupervisorService | null = null;

async function controlSupervisorFromFeishu(command: FeishuSupervisorCommand, actor: { openId: string; source: 'text' | 'card' | 'system' }): Promise<unknown> {
  if (command.action === 'start') {
    if (command.planFile && (!path.isAbsolute(command.planFile) || !fs.existsSync(command.planFile) || !fs.statSync(command.planFile).isFile())) {
      return { ok: false, error: 'plan_file 必须是当前电脑上存在的绝对路径。' };
    }
    if (command.supervisorLaunchCmd && !['', 'codex', 'claude', 'kimi', 'grok', 'pi', 'opencode'].includes(command.supervisorLaunchCmd.trim())) {
      return { ok: false, error: 'supervisor_launch_cmd 仅允许 codex、claude、kimi、grok、pi、opencode 或留空。' };
    }
  }
  const target = BrowserWindow.getAllWindows()[0];
  if (!target || target.isDestroyed()) return { ok: false, error: 'wmux 窗口未就绪。' };
  if (command.action.startsWith('project-')) {
    const action = command.action === 'project-status'
      ? 'status'
      : command.action === 'project-message'
        ? 'message'
      : command.action === 'project-answer'
        ? 'answer-question'
      : command.action === 'project-logs'
        ? 'logs'
        : command.action === 'project-pause-all'
          ? 'pause-all-projects'
          : command.action === 'project-resume-all'
            ? 'resume-all-projects'
        : command.action === 'project-pause'
          ? 'pause'
          : command.action === 'project-resume'
            ? 'resume'
            : 'stop';
    const payload = JSON.stringify({ ...command, action, actor: actor.openId, source: actor.source });
    const result = await target.webContents.executeJavaScript(`window.__wmux_projectManagerRemoteControl?.(${payload})`);
    return result || { ok: false, error: 'wmux 界面尚未初始化项目管理控制器。' };
  }
  let forwardedCommand: FeishuSupervisorCommand = command;
  let preservedDirectory = '';
  if (command.action === 'create-task') {
    const preset = String(command.preset || '');
    if (preset && preset !== 'user-records') {
      return { ok: false, error: '该飞书专用终端类型已停用，请从新版控制卡创建用户记录终端。' };
    }
    const userRecordsTerminal = preset === 'user-records';
    const name = userRecordsTerminal ? USER_RECORDS_TERMINAL_NAME : command.name.trim();
    let task = command.task.trim();
    const agent = userRecordsTerminal ? USER_RECORDS_TERMINAL_AGENT : command.agent || 'codex';
    if (!name || (!userRecordsTerminal && !task)) {
      return { ok: false, error: '任务名称和首条任务都不能为空。' };
    }
    if (!['codex', 'kimi', 'grok'].includes(agent)) return { ok: false, error: 'AI 终端类型仅允许 codex、kimi 或 grok。' };
    if (userRecordsTerminal) {
      const skillPath = path.join(
        USER_RECORDS_TERMINAL_DIRECTORY,
        ...USER_RECORDS_TERMINAL_SKILL_RELATIVE_PATH,
      );
      let directoryAvailable = false;
      let skillAvailable = false;
      try {
        directoryAvailable = fs.statSync(USER_RECORDS_TERMINAL_DIRECTORY).isDirectory();
        skillAvailable = fs.statSync(skillPath).isFile();
      } catch {
        // Report the precise missing requirement below without exposing a raw filesystem error.
      }
      if (!directoryAvailable) {
        return { ok: false, error: `用户记录终端目录不存在：${USER_RECORDS_TERMINAL_DIRECTORY}` };
      }
      if (!skillAvailable) {
        return { ok: false, error: `用户记录终端缺少默认技能：${skillPath}` };
      }
      try {
        ensureCodexProjectTrusted(USER_RECORDS_TERMINAL_DIRECTORY);
      } catch (error) {
        console.warn('[feishu] failed to trust user-records terminal directory', error);
        return { ok: false, error: '用户记录终端目录可用，但无法写入 Codex 信任配置。' };
      }
      task = USER_RECORDS_TERMINAL_STARTUP_INPUT;
      forwardedCommand = {
        ...command,
        name,
        task,
        agent,
        preset: 'user-records',
        cwd: USER_RECORDS_TERMINAL_DIRECTORY,
        displayPath: USER_RECORDS_TERMINAL_DIRECTORY,
      };
    } else {
      const selectedCwd = command.cwd?.trim();
      let directory: ReturnType<typeof createFeishuDirectTaskDirectory>;
      try {
        directory = selectedCwd
          ? resolveExistingFeishuDirectTaskDirectory(selectedCwd, name)
          : createFeishuDirectTaskDirectory(app.getPath('desktop'), name);
        if (!selectedCwd) preservedDirectory = directory.displayPath;
      } catch (error) {
        console.warn('[feishu] failed to prepare direct task directory', error);
        return {
          ok: false,
          error: selectedCwd
            ? '所选终端路径不存在或不是有效的绝对目录，请刷新卡片后重试。'
            : '无法在桌面创建 wmux 任务目录，请检查目录权限后重试。',
        };
      }
      try {
        if (agent === 'codex') ensureCodexProjectTrusted(directory.cwd);
        forwardedCommand = {
          ...command,
          name: directory.taskName,
          task,
          agent,
          cwd: directory.cwd,
          displayPath: directory.displayPath,
        };
      } catch (error) {
        console.warn('[feishu] failed to trust direct task directory', error);
        return {
          ok: false,
          error: selectedCwd
            ? '所选终端路径可用，但无法写入 Codex 信任配置，请检查配置文件权限后重试。'
            : `任务目录已创建，但无法写入 Codex 信任配置；已保留目录：${preservedDirectory}`,
        };
      }
    }
  }
  const payload = JSON.stringify({ ...forwardedCommand, actor: actor.openId, source: actor.source });
  try {
    const result = await target.webContents.executeJavaScript(`window.__wmux_supervisorRemoteControl?.(${payload})`);
    if (result) {
      if (
        preservedDirectory
        && typeof result === 'object'
        && result !== null
        && ((result as { ok?: boolean }).ok === false || typeof (result as { error?: unknown }).error === 'string')
      ) {
        const error = String((result as { error?: string }).error || 'AI 终端未能打开。');
        return { ...result, error: `${error} 已保留任务目录：${preservedDirectory}` };
      }
      return result;
    }
  } catch (error) {
    if (!preservedDirectory) throw error;
    console.warn('[feishu] direct task workspace creation failed after directory creation', error);
  }
  return preservedDirectory
    ? { ok: false, error: `AI 终端未能打开；已保留任务目录：${preservedDirectory}` }
    : { ok: false, error: 'wmux 界面尚未初始化监督控制器。' };
}

// Route the V2 methods that live in their own modules: browser.* (per-caller
// isolated routing, issue #62) and the uniform renderer-bridge methods. Returns
// true when the method was handled here so the main switch can be skipped.
function routeSpecialV2(
  request: { method: string; params?: any },
  respond: (result: any) => void,
  respondError: (code: number, message: string) => void,
): boolean {
  if (request.method.startsWith('browser.')) {
    handleBrowserV2(request.method, request.params, respond, respondError);
    return true;
  }
  if (request.method.startsWith('window.')) {
    return handleWindowV2(request.method, request.params, respond, respondError);
  }
  // Declared agent state (issue #128) — pane.report_agent and friends.
  if (handleAgentStateV2(request.method, request.params, respond, respondError)) return true;
  return handleBridgeV2(request.method, request.params, respond, respondError);
}

// Pick which pane each agent in a batch lands in, per distribution strategy.
function resolveAgentAssignments(strategy: string, count: number, paneLoads: any[]): string[] {
  if (strategy === 'stack') {
    const sorted = [...paneLoads].sort((a, b) => a.tabCount - b.tabCount);
    return Array.from({ length: count }, () => sorted[0].paneId);
  }
  if (strategy !== 'distribute') {
    console.warn('[wmux] split strategy not yet implemented, falling back to distribute');
  }
  return distributeAgents(count, paneLoads);
}

// Spawn each agent in a batch into its assigned pane, broadcasting updates.
// Per-agent failures are captured as { error } so one bad agent can't fail the batch.
function spawnAgentBatch(
  agentParams: any[],
  assignments: string[],
  workspaceId: any,
  win: BrowserWindow | undefined,
): any[] {
  const results: any[] = [];
  agentParams.forEach((p, i) => {
    try {
      const agentCmd = p.cmd || p.prompt; // accept both 'cmd' and 'prompt'
      if (!agentCmd) { results.push({ error: `Agent ${i}: missing required field 'cmd'` }); return; }
      const result = agentManager.spawn({ ...p, cmd: agentCmd, paneId: assignments[i] as any, workspaceId });
      if (win && !win.isDestroyed()) setupAgentPtyForwarding(result.surfaceId, win);
      BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.isDestroyed()) {
          w.webContents.send(IPC_CHANNELS.AGENT_UPDATE, {
            type: 'spawned', ...result, paneId: assignments[i], workspaceId, label: p.label,
          });
        }
      });
      results.push(result);
    } catch (err: any) { results.push({ error: err.message }); }
  });
  return results;
}

const windowManager = new WindowManager();

// Closing a window should forget its saved workspaces — otherwise the merged
// session file keeps them and they reappear as a ghost window next launch
// (issue #118). Two cases deliberately do NOT prune: shutdown, and closing the
// *last* window, which is how most people quit wmux and must still persist
// everything for the next launch.
windowManager.onWindowClosed = (id, webContentsId) => {
  clearMarkdownGrants(webContentsId);
  if (isQuitting || windowManager.getCount() === 0) return;
  sessionWindows.forget(id);
  saveSession({ version: 1, windows: sessionWindows.toArray() });
};

// Agent exit → renderer. Without this broadcast, sidebar agent lines would
// pulse "running" forever: agentMeta is only written at spawn, and the old
// 3s agent.list poll that used to sync statuses is gone. Mirrors the
// 'spawned' AGENT_UPDATE emissions above.
agentManager.setOnAgentExit((info) => {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.AGENT_UPDATE, {
        type: 'exited', surfaceId: info.surfaceId, exitCode: info.exitCode,
      });
    }
  });
});

// window.* V2 methods (issue #78) run entirely in the main process against
// windowManager — no renderer bridge involved. Returns true when handled so
// the main dispatch switch can be skipped.
function handleWindowV2(
  method: string,
  params: any,
  respond: (result: any) => void,
  respondError: (code: number, message: string) => void,
): boolean {
  switch (method) {
    case 'window.create':
      // Second OS window — lets users spread workspaces across monitors
      // without a second wmux instance. Same code path as the Ctrl+Shift+N
      // shortcut, just reachable from the CLI/agents.
      respond({ windowId: windowManager.createWindow() });
      return true;
    case 'window.list':
      respond({ windows: windowManager.listWindows() });
      return true;
    case 'window.focus': {
      const id = params?.id || params?.windowId;
      if (!id) { respondError(-32602, 'Missing window id'); return true; }
      windowManager.focusWindow(id);
      respond({ ok: true });
      return true;
    }
    default:
      return false;
  }
}
// Per-instance secret that authenticates privileged (V2) pipe requests.
// Generated/persisted once per APPDATA dir and injected into spawned shells
// as WMUX_PIPE_TOKEN so the CLI and hooks can authenticate.
const pipeToken = ensurePipeToken();
process.env.WMUX_PIPE_TOKEN = pipeToken;
const pipeServer = new PipeServer(getPipePath(), pipeToken);
const portScanner = new PortScanner();
const cdpProxy = new CDPProxy();

// Strip MOTW (Mark of the Web) Zone.Identifier ADS from app directory.
// Windows blocks taskbar pinning and shows security warnings for downloaded files.
// Removing the :Zone.Identifier alternate data stream fixes this transparently.
function stripMotw(): void {
  if (process.platform !== 'win32') return;
  const appDir = path.dirname(process.execPath);
  const stripDir = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stripDir(full);
      } else if (/\.(exe|dll|node|lnk)$/i.test(entry.name)) {
        fs.unlink(full + ':Zone.Identifier', () => {});
      }
    }
  };
  stripDir(appDir);
}

// Auto-save debounce handle
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
// Set on before-quit so the final round of session:save replies is merged
// instead of pruned — during shutdown every window is being destroyed, and
// "forget windows that no longer exist" would erase the whole file (issue #118).
let isQuitting = false;
const AUTO_SAVE_INTERVAL_MS = 30_000;

function scheduleAutoSave(): void {
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer);
  }
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('session:request');
      }
    });
  }, AUTO_SAVE_INTERVAL_MS);
}

// ─── PTY surface resolution + named-key translation (V2 send_text / send_key) ──
// When no surfaceId is provided, the active surface from the renderer can point
// at a pane without a PTY (markdown / browser). Writing into that silently drops
// the input. Return a clear error instead so callers can react.
async function resolvePtySurface(
  id: string | undefined
): Promise<{ ok: true; id: `surf-${string}` } | { ok: false; error: string }> {
  let surfaceId = id;
  if (!surfaceId) {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return { ok: false, error: 'No window' };
    try {
      surfaceId = await win.webContents.executeJavaScript(
        `window.__wmux_getActiveSurfaceId?.()`
      );
    } catch (err: any) {
      return { ok: false, error: `Could not resolve active surface: ${err.message}` };
    }
    if (!surfaceId) return { ok: false, error: 'No active surface' };
  }
  const branded = surfaceId as `surf-${string}`;
  if (!ptyManager.has(branded)) {
    return {
      ok: false,
      error: `surface ${surfaceId} has no PTY (pane is markdown/browser, or surface was closed). Pass an explicit surfaceId pointing at a terminal surface.`,
    };
  }
  return { ok: true, id: branded };
}

// Named-key → raw PTY input translation. Fallback rules:
//   - length === 1            → literal character (covers Ctrl+letter flow).
//   - known multi-char name   → translated to real control/escape bytes.
//   - unknown multi-char name → null (caller returns -32602 invalid params).
const PTY_KEY_MAP: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  esc: '\x1b',
  escape: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  space: ' ',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-u': '\x15',
  'ctrl-l': '\x0c',
  'ctrl-a': '\x01',
  'ctrl-e': '\x05',
  'ctrl-k': '\x0b',
  'ctrl-w': '\x17',
  'ctrl-r': '\x12',
  'ctrl-z': '\x1a',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS',
  f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~',
  f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
};
function translateKeyName(key: string, shift: boolean): string | null {
  if (key.length === 1) return shift ? key.toUpperCase() : key;
  const normalized = key.toLowerCase();
  if (normalized in PTY_KEY_MAP) return PTY_KEY_MAP[normalized];
  return null;
}

// Auto-strip MOTW on startup so users never see security warnings or pinning failures
stripMotw();

// Single-instance lock (issue #32). Outside a wmux-spawned shell, `wmux` on PATH
// resolves to the GUI exe rather than the CLI, so `wmux browser open <url>` (and
// any stray re-launch) would otherwise spawn a SECOND window and ignore its args.
// Holding the lock makes the second launch hand off to the running instance,
// which just focuses its window. Named instances (WMUX_INSTANCE) point Electron's
// userData at their own dir so the lock is per-instance and dev/prod still coexist.
if (process.env.WMUX_INSTANCE?.trim()) {
  app.setPath('userData', getAppDataDir());
}
const gotInstanceLock = app.requestSingleInstanceLock();

/**
 * Open a folder as a new workspace, for the Explorer context-menu verb
 * ("Open in wmux" — see shell-context-menu.ts, which registers
 * `"wmux.exe" "%V"`).
 *
 * Routed through the same `__wmux_createWorkspace` bridge the CLI's
 * `new-workspace --cwd` uses, so Explorer, the CLI and the UI all land on one
 * store action rather than a fourth way to make a workspace.
 */
/**
 * Ask the renderer to open a folder as a workspace.
 * Prefer IPC (not executeJavaScript): with contextIsolation, page globals are
 * unreliable from main, and executeJavaScript often no-ops → path stays $HOME.
 */
function openDirectoryAsWorkspace(dirPath: string): void {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const win = BrowserWindow.getFocusedWindow()
    || wins[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send(IPC_CHANNELS.SYSTEM_OPEN_DIRECTORY, dirPath);
}

const isDirectory = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Stash Explorer cold-start folder before any window loads (consumed by renderer).
setPendingLaunchDirectory(directoryFromArgv(process.argv, isDirectory));

if (!gotInstanceLock) {
  app.quit();
} else {
  // Explorer launches `wmux.exe "C:\folder"`. With the single-instance lock held
  // that becomes a second-instance event on the RUNNING window, carrying the new
  // process's argv — so the folder has to be read from the event, not from our
  // own process.argv, which still holds the original launch.
  app.on('second-instance', (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const dir = directoryFromArgv(argv, isDirectory);
    if (dir) openDirectoryAsWorkspace(dir);
  });
}

// ─── Webview / navigation hardening (issue #9) ────────────────────────────────
// The renderer hosts <webview> tags that load arbitrary web content. Lock down
// the attack surface so a compromised/hostile page can't escalate:
//  - strip Node integration & preload from attached webviews
//  - block window.open popups (route http/https to the OS browser instead)
//  - prevent the top-level app window from navigating away from its own UI
function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    const type = contents.getType();

    if (type === 'webview') {
      // Enforce safe webview preferences regardless of attributes set in the DOM.
      contents.on('will-attach-webview', (_e, webPreferences, params) => {
        delete (webPreferences as any).preload;
        delete (webPreferences as any).preloadURL;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        (params as any).nodeintegration = 'false';
      });
    }

    // Open new-window requests externally rather than spawning in-app windows
    // with full privileges. Only http/https go to the OS browser; deny the rest.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    // The main app window (loads localhost in dev, file:// in prod) must never
    // be navigated to remote content. Webviews host their own contents and are
    // exempt — their navigation is the whole point.
    if (type !== 'webview') {
      contents.on('will-navigate', (e, url) => {
        const isDevServer = url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
        const isLocalFile = url.startsWith('file://');
        if (!isDevServer && !isLocalFile) {
          e.preventDefault();
          if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
        }
      });
    }
  });
}

// Lifecycle truth for sidebar agent lines: hooks, not output parsing, decide
// when agents are finished (spec 2026-07-22, issue #81 class). SubagentStop
// marks a single parallel subagent done; Stop marks the whole surface done.
function applyHookLifecycle(params: any): void {
  const sid = params?.surfaceId as SurfaceId | undefined;
  if (!sid) return;
  if (params.event === 'SubagentStop') markSubagentStop(sid);
  else if (isAgentHookTerminalEvent(params.event)) {
    markAllAgentsDone(sid);
  }
}

/** Edit/Write hooks refresh the diff view; delays let the DiffPane mount first. */
function pushDiffUpdate(file: string): void {
  // Stagger updates: 500ms for immediate feedback, 2s to catch slower writes.
  for (const delay of [500, 2000]) {
    setTimeout(() => {
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.DIFF_UPDATE, { file });
      });
    }, delay);
  }
}

/** One Claude Code hook event, fanned out to every consumer that wants it. */
function handleHookEvent(params: any): void {
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.HOOK_EVENT, params);
  });
  applyHookLifecycle(params);

  // Same events, second consumer: declared agent run state (issue #128). This
  // is what makes "which pane is parked on me?" work for Claude Code with no
  // plugin to install — wmux already registers these hooks.
  if (params?.surfaceId && params?.event) {
    applyHookToAgentState(params.surfaceId as SurfaceId, String(params.event), params.message ?? null);
  }

  // Always refresh the diff for Edit/Write, even without a file path.
  if (params?.tool === 'Edit' || params?.tool === 'Write') pushDiffUpdate(params.file || '');
}

app.whenReady().then(() => {
  // A losing second instance is already quitting; don't run startup side effects.
  if (!gotInstanceLock) return;
  hardenWebContents();
  const loginStartup = initializeLoginStartup(app);
  if (!loginStartup.ok) console.warn('[wmux] Failed to apply login startup setting:', loginStartup.error);
  ensureClaudeHooks();
  ensureChromeDevtoolsConfig();
  ensureOrchestratorPlugin();
  ensureOpencodeContext();
  ensureOpencodePlugin();
  ensureKimiHooks();
  ensureCodexHooks();
  ensureGrokHooks();
  try {
    ensurePiHooks();
  } catch (err) {
    console.warn('[wmux] Failed to update Pi Agent hooks:', err);
  }

  ipcMain.handle('supervisor:append-record', (_event, record) => {
    const result = appendSupervisorRecord(record);
    feishuSupervisor?.onRecord(record);
    return result;
  });
  ipcMain.handle('supervisor:read-latest-history', (_event, options) =>
    readLatestSupervisorHistory(String(options?.projectDir || ''), {
      surfaceId: String(options?.surfaceId || ''),
      label: String(options?.terminalLabel || ''),
    }),
  );
  feishuSupervisor = new FeishuSupervisorService(controlSupervisorFromFeishu);
  feishuSupervisor.start();
  ipcMain.handle('supervisor:read-audit-trail', (_event, options) =>
    readSupervisorAuditTrail(String(options?.projectDir || ''), {
      surfaceId: String(options?.surfaceId || ''),
      label: String(options?.terminalLabel || ''),
    }),
  );
  ipcMain.handle('supervisor:list-restore-candidates', (_event, projectDir) =>
    listSupervisorRestoreCandidates(String(projectDir || '')),
  );
  ipcMain.handle('supervisor:validate-model', (_event, request) => {
    const launcher = String(request?.launcher || '');
    if (!['pi', 'codex', 'kimi', 'grok'].includes(launcher)) {
      return { ok: false, error: '该监督启动器暂不支持模型验证。' };
    }
    return validateSupervisorModel({
      launcher: launcher as 'pi' | 'codex' | 'kimi' | 'grok',
      model: String(request?.model || ''),
      cwd: typeof request?.cwd === 'string' ? request.cwd : undefined,
    });
  });
  ipcMain.handle('project-manager:save-session', (_event, session) => saveProjectManagerSession(session));
  ipcMain.handle('project-manager:delete-session', (_event, sessionId) => deleteProjectManagerSession(String(sessionId || '')));
  ipcMain.handle('project-manager:ensure-skill', (_event, requestedAgent) => {
    const agent = requestedAgent === 'kimi' || requestedAgent === 'grok' ? requestedAgent : 'codex';
    return ensureProjectManagerSkill({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }, agent);
  });
  ipcMain.handle('project-manager:read-latest-session', (_event, projectDir) => readLatestProjectManagerSession(projectDir));
  ipcMain.handle('project-manager:list-active-sessions', () => readActiveProjectManagerSessions());
  ipcMain.handle('project-manager:read-plan-files', (_event, filePaths) => captureProjectPlanFiles(filePaths));
  ipcMain.handle('project-manager:pick-plan-files', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: '选择项目计划文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '项目计划文本', extensions: PROJECT_PLAN_FILE_DIALOG_EXTENSIONS },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: true, canceled: true, files: [] };
    return captureProjectPlanFiles(result.filePaths);
  });
  ipcMain.handle('project-manager:append-record', (_event, record) => {
    const result = appendProjectManagerRecord(record);
    feishuSupervisor?.onProjectManagerRecord?.(record);
    return result;
  });
  ipcMain.handle('supervisor:list-models', (_event, request) => {
    const launcher = String(request?.launcher || '');
    if (!['pi', 'codex', 'kimi', 'grok'].includes(launcher)) {
      return { ok: false, error: '该监督启动器暂不支持模型目录查询。' };
    }
    return listSupervisorModels({
      launcher: launcher as 'pi' | 'codex' | 'kimi' | 'grok',
      cwd: typeof request?.cwd === 'string' ? request.cwd : undefined,
    });
  });
  ipcMain.handle('supervisor:load-config', async (event, defaultPath) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: '加载 AI 监督配置',
      ...(typeof defaultPath === 'string' && defaultPath.trim() ? { defaultPath } : {}),
      properties: ['openFile'],
      filters: [
        { name: 'wmux AI 监督配置', extensions: ['wmux-supervisor.json'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    try {
      const filePath = result.filePaths[0];
      if (fs.statSync(filePath).size > 512 * 1024) return { error: '配置文件超过 512 KiB' };
      const config = parseSupervisorConfig(fs.readFileSync(filePath, 'utf8'));
      return 'error' in config ? config : { config, filePath };
    } catch (err: any) {
      return { error: err?.message || '无法读取配置文件' };
    }
  });
  ipcMain.handle('supervisor:save-config', async (event, config, defaultPath) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showSaveDialog(win as BrowserWindow, {
      title: '保存 AI 监督配置',
      defaultPath: typeof defaultPath === 'string' && defaultPath.trim()
        ? defaultPath
        : 'ai-supervisor.wmux-supervisor.json',
      filters: [{ name: 'wmux AI 监督配置', extensions: ['wmux-supervisor.json'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    try {
      fs.writeFileSync(result.filePath, serializeSupervisorConfig(config), 'utf8');
      return { ok: true, filePath: result.filePath };
    } catch (err: any) {
      return { error: err?.message || '无法保存配置文件' };
    }
  });

  // IPC: renderer pushes session state (auto-save response or explicit save).
  // Every window answers the same broadcast, each with a one-entry `windows`
  // array describing itself. Merging them through the registry is what stops
  // the last responder from overwriting every other window's workspaces —
  // before this, a second window silently cost you the first one's tabs and
  // browser pages on the next 30s tick (issue #118).
  ipcMain.on('session:save', (event, data: SessionData) => {
    const state = data?.windows?.[0];
    if (!state) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      // Persist the maximized flag and the *normal* (pre-maximize) rectangle so a
      // relaunch can re-maximize on the right monitor and un-maximize sanely (issue #57).
      state.maximized = win.isMaximized();
      state.bounds = win.getNormalBounds();
    }

    const windowId = windowManager.idForWebContents(event.sender);
    if (windowId) {
      sessionWindows.update(windowId, state);
      // Forget windows the user closed — but never while quitting, when every
      // window is being torn down and pruning would erase what we're saving.
      if (!isQuitting) {
        sessionWindows.retainOnly(windowManager.getAllWindows().map((w) => w.id));
      }
      saveSession({ version: 1, windows: sessionWindows.toArray() });
    } else {
      // Unattributable sender (a window created outside WindowManager). Better
      // to persist its state alone than to drop the save entirely.
      saveSession({ version: 1, windows: [state] });
    }
    scheduleAutoSave();
  });

  registerIpcHandlers(windowManager, cdpProxy);

  // Clear stale session data on version change (clean start for upgrades/fresh installs)
  handleVersionChange(app.getVersion());

  // Reopen every window the last session had, not just the first (issue #118).
  // Each gets its own slot in the registry so its renderer restores its own
  // workspaces — `SESSION_LOAD_AUTO` used to hand windows[0] to whoever asked,
  // which made a second window a clone of the first.
  const savedSession = loadSession();
  const savedWindows = (savedSession?.windows ?? []).slice(0, MAX_RESTORED_WINDOWS);
  if (savedWindows.length === 0) {
    windowManager.createWindow();
  } else {
    for (const saved of savedWindows) {
      const id = windowManager.createWindow(saved.bounds, saved.maximized);
      sessionWindows.prime(id, saved);
    }
  }

  // Cold-start Explorer folder is consumed by the renderer
  // (system:consumeLaunchDirectory) so it cannot race auto-session restore.

  // Refresh Explorer verb command if already installed — fixes stale
  // `electron.exe "%V"` (missing app path) from older builds.
  try {
    if (isContextMenuInstalled()) {
      const exe = app.getPath('exe');
      const appPath = app.isPackaged ? null : app.getAppPath();
      installContextMenu(exe, 'Open in wmux', appPath);
    }
  } catch { /* registry optional */ }

  // Initialize auto-updater only when packaged (avoids errors in dev)
  if (app.isPackaged) {
    initAutoUpdater();
    initUpdateChecker();
  }

  // Late-mounted windows query the cached latest update info so the badge
  // appears even if the GitHub poll fired before the window's renderer attached.
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_LATEST, () => getLatestUpdate());
  // Badge click — download + install in place; the renderer falls back to the
  // release page when this says it can't (issue #125).
  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => requestUpdateNow());
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_STATE, () => getUpdateState());
  ipcMain.on(IPC_CHANNELS.UPDATE_OPEN_RELEASE, (_event, url: string) => {
    // Whitelist GitHub release URLs so a hostile renderer can't pivot this
    // channel into an arbitrary openExternal sink.
    if (typeof url === 'string' && /^https:\/\/github\.com\//.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
  });

  // Kick off the first auto-save cycle after the window is ready
  scheduleAutoSave();

  // Start named pipe server
  pipeServer.start();
  cdpProxy.start().catch(() => {}); // CDP proxy is optional — don't crash if ports are busy

  // Watch TMPDIR for wmux-orchestrator runs and push state to the sidebar.
  startOrchestrationWatcher();

  portScanner.onResults((portsByPid) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
          command: 'ports_update',
          surfaceId: '',
          args: [JSON.stringify(Object.fromEntries(portsByPid))],
        });
      }
    });
  });

  pipeServer.on('v1', (cmd) => {
    // Trigger port scan when requested from shell integration
    if (cmd.command === 'ports_kick') {
      portScanner.kick();
    }
    // Forward metadata updates to all windows
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.METADATA_UPDATE, cmd);
      }
    });
  });

  pipeServer.on('v2', (request, respond, respondError) => {
    // Browser commands (per-caller isolated routing, #62) and uniform
    // renderer-bridge methods are handled in their own modules.
    if (routeSpecialV2(request, respond, respondError)) return;

    switch (request.method) {
      case 'system.identify':
        respond({ name: 'wmux', version: app.getVersion(), platform: 'win32' });
        break;
      case 'system.capabilities':
        respond({ protocols: ['v1', 'v2'], features: ['workspaces', 'splits', 'notifications'] });
        break;
      // workspace.* and pane.split/close handled by handleBridgeV2 (./v2-bridge).
      // window.* handled by handleWindowV2 above.
      case 'pane.focus': {
        // Focus the first surface in the specified pane
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) { respondError(-32000, 'No window'); return; }
            // Get pane's first surface and focus it
            const panes = await win.webContents.executeJavaScript(
              `window.__wmux_listPanes?.(${JSON.stringify(request.params?.workspaceId)})`
            );
            const pane = (panes || []).find((p: any) => p.paneId === (request.params?.id || request.params?.paneId));
            if (pane && pane.surfaces.length > 0) {
              await win.webContents.executeJavaScript(
                `window.__wmux_focusSurface?.(${JSON.stringify(pane.surfaces[0].id)})`
              );
            }
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'pane.zoom': {
        // Zoom toggles are UI-only; acknowledge for now
        respond({ ok: true, note: 'Zoom toggle is a renderer-only action' });
        break;
      }
      // pane.list, layout.grid, system.tree, surface.create/close/focus/list
      // handled by handleBridgeV2 (./v2-bridge).
      case 'surface.set_color_scheme': {
        // Per-pane color scheme override (issue #4). Pass `scheme: null` to clear.
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) { respondError(-32000, 'No window'); return; }
            const surfaceId = request.params?.surfaceId || request.params?.id;
            const scheme = request.params?.colorScheme ?? request.params?.scheme ?? null;
            if (!surfaceId) { respondError(-32602, 'surfaceId required'); return; }
            const result = await win.webContents.executeJavaScript(
              `window.__wmux_setSurfaceColorScheme?.(${JSON.stringify(surfaceId)}, ${JSON.stringify(scheme)})`
            );
            respond(result || { ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'theme.list': {
        // Report available color schemes so the CLI / external tools can discover
        // valid `--color-scheme` values without touching the filesystem.
        (async () => {
          try {
            const { loadBundledThemes } = await import('./theme-loader');
            const bundled = loadBundledThemes();
            const names = ['Monokai', ...Array.from(bundled.keys())];
            respond({ themes: Array.from(new Set(names)).sort((a, b) => a.localeCompare(b)) });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'config.get': {
        // Expose the current ~/.wmux/config.toml state (incl. parse errors).
        (async () => {
          try {
            const { loadUserConfig } = await import('./user-config');
            respond(loadUserConfig());
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'config.reload': {
        // Re-read ~/.wmux/config.toml and live-apply to every open window.
        (async () => {
          try {
            const { loadUserConfig } = await import('./user-config');
            const cfg = loadUserConfig();
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) {
                win.webContents.send('config:userConfigUpdated', cfg);
              }
            }
            respond(cfg);
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // ─── Terminal I/O V2 handlers ─────────────────────────────────────────
      case 'surface.send_text': {
        (async () => {
          try {
            const surfaceId = await resolvePtySurface(request.params?.surfaceId || request.params?.id);
            if (!surfaceId.ok) { respondError(-32000, surfaceId.error); return; }
            const blockReason = await supervisorGenericInputBlockReason(
              String(request.params?.callerSurfaceId || ''),
              surfaceId.id,
            );
            if (blockReason) { respondError(-32003, blockReason); return; }
            const text = String(request.params?.text || '');
            const arbitration = text
              ? await notifySupervisorTerminalInput(surfaceId.id, text)
              : { clearAutomatedDraft: false };
            if (arbitration.clearAutomatedDraft) ptyManager.write(surfaceId.id, '\x03');
            ptyManager.write(surfaceId.id, text);
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.send_key': {
        (async () => {
          try {
            let key = request.params?.key || '';
            const mods: string[] = request.params?.modifiers || [];
            const hasCtrl = mods.includes('ctrl') || request.params?.ctrl;
            const hasAlt = mods.includes('alt') || request.params?.alt;
            const hasShift = mods.includes('shift') || request.params?.shift;

            // Translate named keys to control bytes / ANSI escape sequences.
            // Fallback: length-1 key is treated as literal (Ctrl+letter stays); unknown multi-char → error.
            const translated = translateKeyName(key, hasShift);
            if (translated === null) {
              respondError(-32602, `unknown key name: "${key}" (use one of: enter, tab, esc, backspace, delete, up, down, left, right, home, end, pageup, pagedown, f1..f12, or a single character)`);
              return;
            }
            key = translated;

            if (hasCtrl && key.length === 1) {
              const upper = key.toUpperCase();
              const code = upper.charCodeAt(0) - 64;
              if (code > 0 && code < 27) key = String.fromCharCode(code);
            }
            if (hasAlt) key = '\x1b' + key;

            const surfaceId = await resolvePtySurface(request.params?.surfaceId || request.params?.id);
            if (!surfaceId.ok) { respondError(-32000, surfaceId.error); return; }
            const blockReason = await supervisorGenericInputBlockReason(
              String(request.params?.callerSurfaceId || ''),
              surfaceId.id,
            );
            if (blockReason) { respondError(-32003, blockReason); return; }
            const arbitration = await notifySupervisorTerminalInput(surfaceId.id, key);
            if (arbitration.clearAutomatedDraft) ptyManager.write(surfaceId.id, '\x03');
            ptyManager.write(surfaceId.id, key);
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.read_text': {
        // Screen content lives in the renderer (xterm owns the buffer), so
        // delegate to the __wmux_readScreen bridge global. It reads the ACTIVE
        // buffer — alt buffer included — so full-screen TUIs return what is
        // actually visible, as plain text (no ANSI escapes).
        (async () => {
          try {
            const surfaceId = await resolvePtySurface(request.params?.surfaceId || request.params?.id);
            if (!surfaceId.ok) { respondError(-32000, surfaceId.error); return; }
            const rawLines = Number(request.params?.lines);
            const lines = Number.isFinite(rawLines)
              ? Math.min(Math.max(Math.floor(rawLines), 1), 10000)
              : 50;
            // The surface's terminal is mounted in exactly one window; probe
            // each until one has it, keeping the first miss as the error.
            let result: { text?: string; error?: string } | null = null;
            for (const win of BrowserWindow.getAllWindows()) {
              if (win.isDestroyed()) continue;
              const r = await win.webContents.executeJavaScript(
                `window.__wmux_readScreen?.(${JSON.stringify(surfaceId.id)}, ${lines})`
              );
              if (r && !r.error) { result = r; break; }
              if (r && !result) result = r;
            }
            if (!result) { respondError(-32000, 'No window'); return; }
            if (result.error) { respondError(-32000, result.error); return; }
            respond(result);
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.trigger_flash': {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) {
            w.webContents.send(IPC_CHANNELS.NOTIFICATION_FIRE, {
              surfaceId: request.params?.surfaceId,
              text: 'Flash triggered via CLI',
            });
          }
        });
        respond({ ok: true });
        break;
      }

      // ─── Markdown V2 handlers ─────────────────────────────────────────────
      // markdown.set_content handled by handleBridgeV2 (./v2-bridge).
      case 'markdown.load_file': {
        (async () => {
          try {
            const requested = request.params?.filePath || request.params?.path || request.params?.file;
            if (!requested) { respondError(-32000, 'No file path provided'); return; }
            // Defense-in-depth: even with a valid pipe token, only render plain
            // text/markdown files and cap the size, so this can't be used to
            // slurp secrets (e.g. id_rsa, .env) into the markdown viewer. The
            // guards live in ./markdown-file so every entry point shares them.
            //
            // Normalize to an absolute path before handing it to the renderer:
            // a path-aware surface (issue #116) has to show and reload something
            // unambiguous. The CLI already resolves against the caller's cwd
            // (src/cli/wmux.ts), so this only normalizes; a raw pipe client that
            // sends a relative path gets the same main-cwd resolution fs would
            // have applied anyway, just made explicit and visible in the pane.
            const filePath = path.resolve(requested);
            const read = readMarkdownFile(filePath);
            if ('error' in read) {
              respondError(-32602, `markdown.load_file: ${read.error}`);
              return;
            }
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) { respondError(-32000, 'No window'); return; }
            // This method is token-gated, so the caller is an authenticated
            // client that deliberately opened this file — the same standard as
            // a native dialog, and enough to allow editing it back (F3).
            grantMarkdownPath(win.webContents.id, filePath);
            await win.webContents.executeJavaScript(
              `window.__wmux_setMarkdownContent?.(${JSON.stringify(request.params?.surfaceId || '')}, ${JSON.stringify(read.content)}, ${JSON.stringify(path.basename(filePath))}, ${JSON.stringify(filePath)}, ${JSON.stringify(read.mtimeMs)})`
            );
            respond({ ok: true, length: read.content.length, filePath });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // ─── Notification V2 handlers ─────────────────────────────────────────
      // notification.list handled by handleBridgeV2 (./v2-bridge).
      case 'notification.clear': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) { respondError(-32000, 'No window'); return; }
            if (request.params?.all) {
              await win.webContents.executeJavaScript(
                `window.__wmux_clearAllNotifications?.()`
              );
            } else {
              await win.webContents.executeJavaScript(
                `window.__wmux_clearNotification?.(${JSON.stringify(request.params?.id || '')})`
              );
            }
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // ─── Workspace status handler ─────────────────────────────────────────
      case 'workspace.set_status': {
        // Set a named workspace's sidebar status by id (e.g. an orchestration
        // coordinator marking a workspace idle when all waves finish). Keyed on
        // workspaceId, not surfaceId, so it works from outside any pane.
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) {
            w.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
              command: 'set_workspace_status',
              workspaceId: request.params?.workspaceId,
              args: [request.params?.state || '', request.params?.text || ''],
            });
          }
        });
        respond({ ok: true });
        break;
      }

      // ─── Sidebar V2 handlers ──────────────────────────────────────────────
      case 'sidebar.set_status': {
        // Forward as metadata update to renderer
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) {
            w.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
              command: 'status',
              surfaceId: request.params?.surfaceId,
              args: [request.params?.key || '', request.params?.value || ''],
            });
          }
        });
        respond({ ok: true });
        break;
      }
      case 'sidebar.set_progress': {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) {
            w.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
              command: 'progress',
              surfaceId: request.params?.surfaceId,
              args: [String(request.params?.value ?? 0), request.params?.label || ''],
            });
          }
        });
        respond({ ok: true });
        break;
      }
      case 'sidebar.log': {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) {
            w.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
              command: 'log',
              surfaceId: request.params?.surfaceId,
              args: [request.params?.level || 'info', request.params?.message || ''],
            });
          }
        });
        respond({ ok: true });
        break;
      }
      case 'sidebar.get_state': {
        // Return current sidebar metadata — this is stored in the renderer
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) { respond({ state: null }); return; }
            const workspaces = await win.webContents.executeJavaScript(
              `window.__wmux_listWorkspaces?.()`
            );
            respond({ workspaces: workspaces || [] });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // browser.* handled by handleBrowserV2 (./v2-browser) — per-caller isolation (#62).
      case 'agent.spawn': {
        (async () => {
          try {
            const params = request.params;
            let workspaceId = params.workspaceId;
            if (!workspaceId) {
              const wins = BrowserWindow.getAllWindows();
              if (wins.length > 0) {
                workspaceId = await wins[0].webContents.executeJavaScript('window.__wmux_getActiveWorkspaceId?.()');
              }
            }
            if (!workspaceId) { respondError(-32000, 'No active workspace'); return; }

            let paneId = params.paneId;
            if (!paneId) {
              const paneLoads = await BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript('window.__wmux_getPaneLoads?.()');
              if (paneLoads && paneLoads.length > 0) paneId = distributeAgents(1, paneLoads)[0];
            }
            if (!paneId) { respondError(-32000, 'No panes available'); return; }

            // Accept both 'cmd' and 'prompt' field names (plugins may use either)
            const cmd = params.cmd || params.prompt;
            if (!cmd) { respondError(-32602, 'Missing required field: cmd'); return; }
            const result = agentManager.spawn({ cmd, label: params.label, cwd: params.cwd, env: params.env, paneId, workspaceId });

            const win = BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) setupAgentPtyForwarding(result.surfaceId, win);

            BrowserWindow.getAllWindows().forEach(w => {
              if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.AGENT_UPDATE, { type: 'spawned', ...result, paneId, workspaceId, label: params.label, replaceTab: !!params.replaceTab });
            });
            respond(result);
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      case 'agent.spawn_batch': {
        (async () => {
          try {
            const { agents: agentParams, strategy = 'distribute', workspaceId: wsId } = request.params;
            let workspaceId = wsId;
            if (!workspaceId) {
              const wins = BrowserWindow.getAllWindows();
              if (wins.length > 0) workspaceId = await wins[0].webContents.executeJavaScript('window.__wmux_getActiveWorkspaceId?.()');
            }
            if (!workspaceId) { respondError(-32000, 'No active workspace'); return; }

            const paneLoads = await BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript('window.__wmux_getPaneLoads?.()') || [];
            if (paneLoads.length === 0) { respondError(-32000, 'No panes available'); return; }

            const assignments = resolveAgentAssignments(strategy, agentParams.length, paneLoads);
            const win = BrowserWindow.getAllWindows()[0];
            respond({ agents: spawnAgentBatch(agentParams, assignments, workspaceId, win) });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      case 'agent.status': {
        const info = agentManager.getStatus(request.params.agentId);
        if (!info) { respondError(-32000, 'Agent not found'); break; }
        respond(info);
        break;
      }
      case 'agent.list':
        respond({ agents: agentManager.list(request.params.workspaceId) });
        break;
      case 'agent.kill': {
        const killed = agentManager.kill(request.params.agentId);
        if (!killed) { respondError(-32000, 'Agent not found'); break; }
        respond({ ok: true });
        break;
      }

      case 'hook.event': {
        handleHookEvent(request.params);
        respond({ ok: true });
        break;
      }

      case 'agent.activity': {
        const p = request.params || {};
        const surfaceId = p.surfaceId as SurfaceId;
        if (!surfaceId) { respondError(-32602, 'surfaceId required'); break; }
        applyExternalActivity(surfaceId, {
          lastTool: p.tool || undefined,
          activeSkill: p.skill || undefined,
          isDone: typeof p.done === 'boolean' ? p.done : undefined,
        });
        respond({ ok: true });
        break;
      }

      case 'diff.refresh': {
        // CLI can trigger a full diff refresh
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.DIFF_UPDATE, { file: request.params?.file || '' });
        });
        respond({ ok: true });
        break;
      }

      default:
        respondError(-32601, `Method not found: ${request.method}`);
    }
  });
});

let runtimeResourcesReleased = false;

function releaseRuntimeResources(): void {
  if (runtimeResourcesReleased) return;
  runtimeResourcesReleased = true;
  ptyManager.killAll();
  sshManager.disconnectAll();
  sshTransferCache.cleanup();
  pipeServer.stop();
  cdpProxy.stop();
  portScanner.stop();
}

app.on('before-quit', () => {
  isQuitting = true;
  // Cancel pending auto-save timer
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  // Ask all renderers to push their current state synchronously before quit
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('session:request');
    }
  });
  // Start process cleanup while renderer shutdown is still in progress.
  releaseRuntimeResources();
});

app.on('will-quit', () => {
  // Kill all PTYs before anything else tears down. Without this, node-pty's
  // libuv async handles (batons) are still pending when the process exits,
  // triggering the "Assertion failed: remove_pty_baton" MSVC runtime error.
  releaseRuntimeResources();
});

app.on('window-all-closed', () => {
  app.quit();
});
