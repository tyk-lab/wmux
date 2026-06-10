import { ipcMain, BrowserWindow, clipboard, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile, execFileSync } from 'child_process';
import { IPC_CHANNELS, SurfaceId, WindowId, WorkspaceId, AgentId } from '../shared/types';
import { observePtyData } from './claude-observer';
import { PtyManager } from './pty-manager';
import { NotificationManager } from './notification-manager';
import { detectShells } from './shell-detector';
import { getDefaultTheme, getThemeByName, loadBundledThemes } from './theme-loader';
import { parseWindowsTerminalConfig, parseGhosttyConfig } from './config-loader';
import { loadUserConfig, getConfigPath } from './user-config';
import { WindowManager } from './window-manager';
import { CDPBridge } from './cdp-bridge';
import { CDPProxy } from './cdp-proxy';
import { AgentManager } from './agent-manager';
import { saveNamedSession, loadNamedSession, listNamedSessions, deleteNamedSession, loadSession } from './session-persistence';
import { loadSettings, saveSetting } from './settings-store';
import { getChangedFiles, getFileDiff } from './diff-provider';

const ptyManager = new PtyManager();
const notificationManager = new NotificationManager();
const cdpBridge = new CDPBridge();
const agentManager = new AgentManager(ptyManager);
const PSMUX_SESSION_NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/u;
const PSMUX_SHORT_SESSION_NAME_RE = /^psmux-(\d+)$/u;
const PSMUX_MANAGED_SESSION_NAME_PREFIX = 'wmx-';
const ownedPsmuxSessions = new Map<string, { webContentsId: number; surfaceId?: SurfaceId }>();
type PsmuxKillTarget = string | { sessionName: string; surfaceId?: SurfaceId };
type PsmuxStartupMode = 'new' | 'attach';
type PreparedPsmuxSession = { sessionName?: string; mode?: PsmuxStartupMode; created?: boolean };
interface PsmuxSessionInfo {
  name: string;
  windows?: number;
  created?: string;
  attached: boolean;
  managed: boolean;
  raw: string;
}

function runPsmux(args: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile('psmux.exe', args, { windowsHide: true, timeout: 5000 }, (error, _stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: stderr?.trim() || error.message });
        return;
      }
      resolve({ ok: true });
    });
  });
}

function parsePsmuxList(stdout: string): PsmuxSessionInfo[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([^:\s]+):\s+(\d+)\s+windows?\s+\(created\s+(.+?)\)(?:\s+\(attached\))?$/u);
      const name = match?.[1] ?? line.match(/^([^:\s]+):/u)?.[1] ?? line;
      return {
        name,
        windows: match ? Number(match[2]) : undefined,
        created: match?.[3],
        attached: /\(attached\)\s*$/u.test(line),
        managed: ownedPsmuxSessions.has(name),
        raw: line,
      };
    })
    .filter((session) => PSMUX_SESSION_NAME_RE.test(session.name));
}

function listPsmuxSessions(): Promise<{ ok: boolean; sessions: PsmuxSessionInfo[]; error?: string }> {
  return new Promise((resolve) => {
    execFile('psmux.exe', ['ls'], { windowsHide: true, timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr?.trim() || error.message;
        const noServer = /no server|failed to connect|server not found/i.test(message);
        resolve({ ok: noServer, sessions: [], error: noServer ? undefined : message });
        return;
      }
      resolve({ ok: true, sessions: parsePsmuxList(stdout) });
    });
  });
}

async function killPsmuxServer(): Promise<{ ok: boolean; error?: string }> {
  const result = await runPsmux(['kill-server']);
  if (result.ok) ownedPsmuxSessions.clear();
  return result;
}

function isPsmuxSessionOwner(sessionName: string, webContentsId: number, surfaceId?: SurfaceId): boolean {
  const owner = ownedPsmuxSessions.get(sessionName);
  if (!owner || owner.webContentsId !== webContentsId) return false;
  return !surfaceId || owner.surfaceId === surfaceId;
}

function listPsmuxSessionNamesSync(): { ok: boolean; names: Set<string> } {
  try {
    const stdout = execFileSync('psmux.exe', ['ls'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return {
      ok: true,
      names: new Set(
        stdout
          .split(/\r?\n/u)
          .map((line) => line.match(/^([^:\s]+):/u)?.[1])
          .filter((name): name is string => !!name && PSMUX_SESSION_NAME_RE.test(name)),
      ),
    };
  } catch {
    return { ok: false, names: new Set() };
  }
}

function addOwnedPsmuxSessionNames(usedNames: Set<string>): Set<string> {
  for (const ownedName of ownedPsmuxSessions.keys()) {
    usedNames.add(ownedName);
  }
  return usedNames;
}

function createShortPsmuxSessionName(usedNames: Set<string> = new Set()): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `${PSMUX_MANAGED_SESSION_NAME_PREFIX}${crypto.randomBytes(3).toString('hex')}`;
    if (!usedNames.has(candidate)) return candidate;
  }
  return `${PSMUX_MANAGED_SESSION_NAME_PREFIX}${crypto.randomUUID()}`;
}

function getNextPsmuxSessionName(requestedName: string, skippedNames: Set<string> = new Set()): string {
  const listedSessions = listPsmuxSessionNamesSync();
  const usedNames = addOwnedPsmuxSessionNames(new Set(listedSessions.names));
  for (const skippedName of skippedNames) {
    usedNames.add(skippedName);
  }

  if (!usedNames.has(requestedName)) return requestedName;

  if (requestedName.startsWith(PSMUX_MANAGED_SESSION_NAME_PREFIX)) {
    return createShortPsmuxSessionName(usedNames);
  }

  const match = requestedName.match(PSMUX_SHORT_SESSION_NAME_RE);
  if (!match) return createShortPsmuxSessionName(usedNames);

  const startIndex = Number(match[1]) + 1;
  for (let index = startIndex; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = `psmux-${index}`;
    if (!usedNames.has(candidate)) return candidate;
  }
  return createShortPsmuxSessionName(usedNames);
}

function allocatePsmuxSession(
  requestedName: string | undefined,
  attachExisting?: boolean,
): { sessionName?: string; mode?: PsmuxStartupMode } {
  if (!requestedName || !PSMUX_SESSION_NAME_RE.test(requestedName)) return {};

  const listedSessions = listPsmuxSessionNamesSync();
  if (!listedSessions.ok) return { sessionName: createShortPsmuxSessionName(), mode: 'new' };

  const usedNames = addOwnedPsmuxSessionNames(listedSessions.names);
  if (!usedNames.has(requestedName)) return { sessionName: requestedName, mode: 'new' };
  if (attachExisting) return { sessionName: requestedName, mode: 'attach' };

  return { sessionName: getNextPsmuxSessionName(requestedName), mode: 'new' };
}

function createDetachedPsmuxSessionSync(sessionName: string): { ok: boolean; duplicate?: boolean; error?: string } {
  try {
    execFileSync('psmux.exe', ['new', '-d', '-s', sessionName], {
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (err: unknown) {
    const execError = err as { message?: string; stderr?: Buffer | string };
    const stderr = Buffer.isBuffer(execError.stderr)
      ? execError.stderr.toString('utf8')
      : execError.stderr;
    const message = [stderr, execError.message || String(err)].filter(Boolean).join('\n');
    return {
      ok: false,
      duplicate: message.includes('duplicate session'),
      error: message,
    };
  }
}

function preparePsmuxSession(
  requestedName: string | undefined,
  attachExisting?: boolean,
): PreparedPsmuxSession {
  const allocated = allocatePsmuxSession(requestedName, attachExisting);
  if (!allocated.sessionName || allocated.mode !== 'new') return allocated;

  let sessionName = allocated.sessionName;
  let lastError = '';
  const skippedNames = new Set<string>();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = createDetachedPsmuxSessionSync(sessionName);
    if (result.ok) return { sessionName, mode: 'attach', created: true };

    lastError = result.error ?? '';
    if (!result.duplicate) break;

    skippedNames.add(sessionName);
    sessionName = getNextPsmuxSessionName(sessionName, skippedNames);
  }

  throw new Error(`Failed to create psmux session ${sessionName}: ${lastError || 'unknown error'}`);
}

function findOwnedPsmuxSessionBySurface(
  webContentsId: number,
  surfaceId: SurfaceId,
): string | undefined {
  for (const [sessionName, owner] of ownedPsmuxSessions.entries()) {
    if (owner.webContentsId === webContentsId && owner.surfaceId === surfaceId) return sessionName;
  }
  return undefined;
}

async function killPsmuxSession(
  sessionName: string,
  webContentsId?: number,
  surfaceId?: SurfaceId,
): Promise<{ ok: boolean; error?: string }> {
  if (!PSMUX_SESSION_NAME_RE.test(sessionName)) {
    return { ok: false, error: `Refusing to kill unmanaged psmux session: ${sessionName}` };
  }
  if (!ownedPsmuxSessions.has(sessionName)) {
    return { ok: false, error: `Refusing to kill unowned psmux session: ${sessionName}` };
  }
  if (webContentsId !== undefined && !isPsmuxSessionOwner(sessionName, webContentsId, surfaceId)) {
    return { ok: false, error: `Refusing to kill psmux session from another surface: ${sessionName}` };
  }
  const result = await runPsmux(['kill-session', '-t', sessionName]);
  if (result.ok) {
    ownedPsmuxSessions.delete(sessionName);
    if (surfaceId) ptyManager.detach(surfaceId);
  }
  return result;
}

async function renamePsmuxSession(
  oldName: string,
  newName: string,
  webContentsId: number,
  surfaceId: SurfaceId,
): Promise<{ ok: boolean; error?: string }> {
  if (!PSMUX_SESSION_NAME_RE.test(oldName)) {
    return { ok: false, error: `Refusing to rename unmanaged psmux session: ${oldName}` };
  }
  if (!PSMUX_SESSION_NAME_RE.test(newName)) {
    return { ok: false, error: `Invalid psmux session name: ${newName}` };
  }
  if (!ownedPsmuxSessions.has(oldName)) {
    return { ok: false, error: `Refusing to rename unowned psmux session: ${oldName}` };
  }
  if (!isPsmuxSessionOwner(oldName, webContentsId, surfaceId)) {
    return { ok: false, error: `Refusing to rename psmux session from another surface: ${oldName}` };
  }
  if (ownedPsmuxSessions.has(newName)) {
    return { ok: false, error: `psmux session already managed: ${newName}` };
  }

  const owner = ownedPsmuxSessions.get(oldName);
  const result = await runPsmux(['rename-session', '-t', oldName, newName]);
  if (result.ok) {
    ownedPsmuxSessions.delete(oldName);
    ownedPsmuxSessions.set(newName, owner ?? { webContentsId, surfaceId });
  }
  return result;
}

function killPsmuxSessionSync(
  sessionName: string,
  webContentsId?: number,
  surfaceId?: SurfaceId,
): { ok: boolean; error?: string } {
  if (!PSMUX_SESSION_NAME_RE.test(sessionName)) {
    return { ok: false, error: `Refusing to kill unmanaged psmux session: ${sessionName}` };
  }
  if (!ownedPsmuxSessions.has(sessionName)) {
    return { ok: false, error: `Refusing to kill unowned psmux session: ${sessionName}` };
  }
  if (webContentsId !== undefined && !isPsmuxSessionOwner(sessionName, webContentsId, surfaceId)) {
    return { ok: false, error: `Refusing to kill psmux session from another surface: ${sessionName}` };
  }
  try {
    execFileSync('psmux.exe', ['kill-session', '-t', sessionName], {
      windowsHide: true,
      timeout: 5000,
      stdio: 'ignore',
    });
    ownedPsmuxSessions.delete(sessionName);
    if (surfaceId) ptyManager.detach(surfaceId);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function killCreatedPsmuxSessionSync(sessionName: string): void {
  if (!PSMUX_SESSION_NAME_RE.test(sessionName)) return;
  try {
    execFileSync('psmux.exe', ['kill-session', '-t', sessionName], {
      windowsHide: true,
      timeout: 5000,
      stdio: 'ignore',
    });
  } catch {
    // Best-effort cleanup when PTY creation fails after the detached session was created.
  }
}

function normalizePsmuxKillTarget(target: PsmuxKillTarget): { sessionName: string; surfaceId?: SurfaceId } {
  return typeof target === 'string' ? { sessionName: target } : target;
}

function killPsmuxSessionsSync(
  targets: PsmuxKillTarget[],
  webContentsId?: number,
): Array<{ sessionName: string; ok: boolean; error?: string }> {
  const uniqueTargets = Array.from(
    new Map(targets.filter(Boolean).map((target) => {
      const normalized = normalizePsmuxKillTarget(target);
      return [normalized.sessionName, normalized];
    })).values(),
  );
  return uniqueTargets.map(({ sessionName, surfaceId }) => ({
    sessionName,
    ...killPsmuxSessionSync(sessionName, webContentsId, surfaceId),
  }));
}

export function killOwnedPsmuxSessionsSync(): void {
  for (const [sessionName, owner] of Array.from(ownedPsmuxSessions.entries())) {
    try {
      execFileSync('psmux.exe', ['kill-session', '-t', sessionName], {
        windowsHide: true,
        timeout: 5000,
        stdio: 'ignore',
      });
      if (owner.surfaceId) ptyManager.detach(owner.surfaceId);
    } catch {
      // Session may already have exited or psmux may be unavailable during shutdown.
    }
  }
  ownedPsmuxSessions.clear();
}

export function registerIpcHandlers(windowManager: WindowManager, cdpProxyInstance?: CDPProxy): void {
  // Toggle DevTools for the renderer window
  ipcMain.on('toggle-devtools', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

  ipcMain.handle(IPC_CHANNELS.PTY_CREATE, async (_event, options) => {
    let psmuxSession: PreparedPsmuxSession | undefined;
    try {
      if (options.surfaceId && ptyManager.has(options.surfaceId)) {
        const existingPsmuxSessionName = findOwnedPsmuxSessionBySurface(_event.sender.id, options.surfaceId);
        return {
          id: options.surfaceId,
          shell: ptyManager.getShell(options.surfaceId) ?? options.shell ?? '',
          ptyReused: true,
          ...(existingPsmuxSessionName
            ? { psmuxSessionName: existingPsmuxSessionName, psmuxStartupMode: 'attach' as const }
            : {}),
        };
      }

      psmuxSession = preparePsmuxSession(options.psmuxSessionName, options.psmuxAttachExisting);
      const psmuxSessionName = psmuxSession.sessionName;
      const resolvedOptions = {
        ...options,
        cwd: options.cwd || process.env.USERPROFILE || 'C:\\',
        ...(psmuxSessionName ? { psmuxSessionName } : {}),
      };
      const created = ptyManager.create(resolvedOptions);
      if (psmuxSessionName) {
        ownedPsmuxSessions.set(psmuxSessionName, {
          webContentsId: _event.sender.id,
          surfaceId: options.surfaceId,
        });
      }
      const id = created.id;
      const window = BrowserWindow.fromWebContents(_event.sender);
      const unsubData = ptyManager.onData(id, (data) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.PTY_DATA, id, data);
        }
        // Feed Claude Code observer for sidebar activity display
        try { observePtyData(id, data); } catch { /* observer failure must not break PTY output */ }
      });
      const unsubExit = ptyManager.onExit(id, (code) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.PTY_EXIT, id, code);
        }
        // Clean up listeners when PTY exits
        unsubData();
        unsubExit();
      });
      return psmuxSessionName
        ? { ...created, psmuxSessionName, psmuxStartupMode: psmuxSession.mode ?? 'new' }
        : created;
    } catch (err: unknown) {
      if (psmuxSession?.created && psmuxSession.sessionName) {
        killCreatedPsmuxSessionSync(psmuxSession.sessionName);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create terminal: ${msg}`);
    }
  });

  ipcMain.on(IPC_CHANNELS.PTY_WRITE, (_event, id: SurfaceId, data: string) => {
    ptyManager.write(id, data);
  });

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_event, id: SurfaceId, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows);
  });

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_event, id: SurfaceId) => {
    const sessionName = findOwnedPsmuxSessionBySurface(_event.sender.id, id);
    if (sessionName) {
      void killPsmuxSession(sessionName, _event.sender.id, id).then((result) => {
        if (!result.ok) ptyManager.kill(id);
      });
      return;
    }
    ptyManager.kill(id);
  });

  ipcMain.handle(IPC_CHANNELS.PTY_HAS, (_event, id: SurfaceId) => {
    return ptyManager.has(id);
  });

  ipcMain.handle(IPC_CHANNELS.PSMUX_KILL_SESSION, async (_event, sessionName: string, surfaceId?: SurfaceId) => {
    return killPsmuxSession(sessionName, _event.sender.id, surfaceId);
  });

  ipcMain.handle(IPC_CHANNELS.PSMUX_KILL_SESSIONS, async (_event, targets: PsmuxKillTarget[]) => {
    const uniqueTargets = Array.from(
      new Map(targets.filter(Boolean).map((target) => {
        const normalized = normalizePsmuxKillTarget(target);
        return [normalized.sessionName, normalized];
      })).values(),
    );
    const results = [];
    for (const { sessionName, surfaceId } of uniqueTargets) {
      results.push({ sessionName, ...(await killPsmuxSession(sessionName, _event.sender.id, surfaceId)) });
    }
    return results;
  });

  ipcMain.on(IPC_CHANNELS.PSMUX_KILL_SESSIONS_SYNC, (event, targets: PsmuxKillTarget[]) => {
    event.returnValue = killPsmuxSessionsSync(targets, event.sender.id);
  });

  ipcMain.handle(IPC_CHANNELS.PSMUX_RENAME_SESSION, async (
    _event,
    oldName: string,
    newName: string,
    surfaceId: SurfaceId,
  ) => {
    return renamePsmuxSession(oldName, newName, _event.sender.id, surfaceId);
  });

  ipcMain.handle(IPC_CHANNELS.PSMUX_LIST_SESSIONS, async () => {
    return listPsmuxSessions();
  });

  ipcMain.handle(IPC_CHANNELS.PSMUX_KILL_SERVER, async () => {
    return killPsmuxServer();
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_SHELLS, async () => {
    return detectShells();
  });

  ipcMain.on(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
    }
  });

  // Config / Theme handlers
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_THEME, async (_event, name?: string) => {
    // Passing a name resolves a specific bundled theme; no name returns the default.
    return name ? getThemeByName(name) : getDefaultTheme();
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_THEME_LIST, async () => {
    const bundled = loadBundledThemes();
    const names = ['Monokai', ...Array.from(bundled.keys())];
    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_IMPORT_WT, async () => {
    return parseWindowsTerminalConfig();
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_IMPORT_GHOSTTY, async () => {
    return parseGhosttyConfig();
  });

  // User config (~/.wmux/config.toml) — read on startup, reloadable at runtime.
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_USER_CONFIG, async () => {
    return loadUserConfig();
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_RELOAD_USER_CONFIG, async () => {
    const cfg = loadUserConfig();
    // Broadcast to every open window so all surfaces live-apply the new prefs.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.CONFIG_USER_CONFIG_UPDATED, cfg);
      }
    }
    return cfg;
  });

  // Exposed so diagnostics (and the CLI) can report which path was read.
  ipcMain.handle('config:getUserConfigPath', async () => getConfigPath());

  ipcMain.on(IPC_CHANNELS.NOTIFICATION_FIRE, (_event, data: { surfaceId: string; text: string; title?: string }) => {
    const window = BrowserWindow.fromWebContents(_event.sender);
    // Show toast
    notificationManager.showToast(data.title || 'wmux', data.text, () => {
      if (window && !window.isDestroyed()) {
        window.focus();
        window.webContents.send('notification:focus-surface', data.surfaceId);
      }
    });
    // Flash taskbar
    if (window && !window.isDestroyed()) {
      notificationManager.flashTaskbar(window);
    }
  });

  // Window management handlers
  ipcMain.handle(IPC_CHANNELS.WINDOW_CREATE, () => windowManager.createWindow());
  ipcMain.handle(IPC_CHANNELS.WINDOW_LIST, () => windowManager.listWindows());
  ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, (_e, id: WindowId) => windowManager.closeWindow(id));
  ipcMain.on(IPC_CHANNELS.WINDOW_FOCUS, (_e, id: WindowId) => windowManager.focusWindow(id));
  ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win?.isMaximized()) win.unmaximize(); else win?.maximize();
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, (e) =>
    BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  );

  ipcMain.on(IPC_CHANNELS.CDP_ATTACH, (_event, webContentsId: number) => {
    cdpBridge.attach(webContentsId);
    cdpProxyInstance?.setWebContentsId(webContentsId);
  });
  ipcMain.on(IPC_CHANNELS.CDP_DETACH, (_event, webContentsId?: number) => {
    // Only the pane that owns the current attachment may clear it (issue #27).
    if (webContentsId !== undefined && cdpBridge.attachedWebContentsId !== webContentsId) return;
    cdpBridge.detach(webContentsId);
    cdpProxyInstance?.setWebContentsId(null);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_LIST, async (_event, workspaceId?: string) => {
    return agentManager.list(workspaceId as WorkspaceId | undefined);
  });
  ipcMain.handle(IPC_CHANNELS.AGENT_STATUS, async (_event, agentId: string) => {
    return agentManager.getStatus(agentId as AgentId);
  });

  // Clipboard text write: used by the OSC 52 handler in the renderer.
  // navigator.clipboard.writeText() requires a user-gesture context; PTY data
  // callbacks don't qualify, so we route through Electron's clipboard module.
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_READ_TEXT, () => {
    return clipboard.readText();
  });

  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_WRITE_TEXT, (_event, text: string) => {
    clipboard.writeText(text);
  });

  // Clipboard image paste: save clipboard image to temp file, return path
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_PASTE_IMAGE, async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    const tmpDir = path.join(os.tmpdir(), 'wmux');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, `screenshot-${Date.now()}.png`);
    fs.writeFileSync(filePath, img.toPNG());
    return filePath;
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_SAVE_NAMED, (_event, session: any) => {
    saveNamedSession(session);
    return { ok: true };
  });
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD_NAMED, (_event, name: string) => {
    return loadNamedSession(name);
  });
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_NAMED, () => {
    return listNamedSessions();
  });
  // Return the most recent auto-saved session in the flattened shape the
  // renderer's restore code already understands. Used on app launch so the
  // workspaces / splits / tabs persisted by the 30s rolling save are actually
  // rehydrated (instead of the renderer falling back to a fresh "Session 1").
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD_AUTO, () => {
    const data = loadSession();
    const win = data?.windows?.[0];
    if (!win) return null;
    const activeIndex = win.activeWorkspaceId
      ? win.workspaces.findIndex(w => w.id === win.activeWorkspaceId)
      : 0;
    return {
      workspaces: win.workspaces,
      sidebarWidth: win.sidebarWidth,
      activeIndex: activeIndex >= 0 ? activeIndex : 0,
    };
  });
  // Settings persistence (issue #19) — file-backed in %APPDATA%\wmux so prefs
  // survive portable-zip updates. get-all is synchronous so the renderer's
  // Zustand settings slice can hydrate at module-load time (no async flash).
  ipcMain.on('settings:get-all-sync', (event) => {
    event.returnValue = loadSettings();
  });
  ipcMain.on('settings:set', (_event, key: string, value: unknown) => {
    saveSetting(key, value);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE_NAMED, (_event, name: string) => {
    return deleteNamedSession(name);
  });

  // Diff viewer handlers
  // Fallback: prefer process.cwd() (often the project dir) over USERPROFILE (never a git repo)
  ipcMain.handle(IPC_CHANNELS.DIFF_GET_FILES, async (_event, cwd: string) => {
    const resolvedCwd = cwd || process.cwd();
    const files = await getChangedFiles(resolvedCwd);
    return { files };
  });

  ipcMain.handle(IPC_CHANNELS.DIFF_GET_DIFF, async (_event, cwd: string, file: string) => {
    const resolvedCwd = cwd || process.cwd();
    const diff = await getFileDiff(resolvedCwd, file);
    return { diff };
  });
}

export function setupAgentPtyForwarding(surfaceId: string, window: BrowserWindow): void {
  const unsubData = ptyManager.onData(surfaceId as SurfaceId, (data) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.PTY_DATA, surfaceId, data);
    }
  });
  const unsubExit = ptyManager.onExit(surfaceId as SurfaceId, (code) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.PTY_EXIT, surfaceId, code);
    }
    // Clean up listeners when PTY exits
    unsubData();
    unsubExit();
  });
}

export { ptyManager, cdpBridge, agentManager };
