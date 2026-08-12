import { ipcMain, BrowserWindow, clipboard, shell, dialog, app, nativeTheme, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { IPC_CHANNELS, SurfaceId, WindowId, WorkspaceId, AgentId, SshConnectionProfile, SshConnectResult } from '../shared/types';
import { observePtyData, clearActivity } from './claude-observer';
import { clearAgentState } from './agent-state';
import { isAuthorizedSshPasswordLaunch, PtyManager, type SshPasswordEndpoint } from './pty-manager';
import { NotificationManager } from './notification-manager';
import { detectShells } from './shell-detector';
import { listSystemFonts } from './font-detector';
import {
  isContextMenuInstalled,
  installContextMenu,
  uninstallContextMenu,
  consumePendingLaunchDirectory,
} from './shell-context-menu';
import { getDefaultTheme, getThemeByName, loadBundledThemes } from './theme-loader';
import { parseWindowsTerminalConfig, parseGhosttyConfig, loadProjectProfiles, importWindowsTerminalProfiles } from './config-loader';
import { loadUserConfig, getConfigPath } from './user-config';
import { WindowManager } from './window-manager';
import { CDPBridge } from './cdp-bridge';
import { CDPProxy } from './cdp-proxy';
import { AgentManager } from './agent-manager';
import { saveNamedSession, loadNamedSession, listNamedSessions, deleteNamedSession, loadSession } from './session-persistence';
import { sessionWindows, toRestorePayload } from './session-windows';
import { loadSettings, saveSetting } from './settings-store';
import { getChangedFiles, getFileDiff } from './diff-provider';
import {
  readMarkdownFile,
  isAllowedMarkdownPath,
  statMarkdownFile,
  writeMarkdownFile,
  MD_DIALOG_EXTENSIONS,
} from './markdown-file';
import { grantMarkdownPath, isMarkdownPathGranted } from './markdown-grants';
import {
  SshAuthenticationError,
  SshManager,
  SshPasswordAuthenticationError,
  parseOpenSshConfig,
} from './ssh-manager';
import { SshCredentialStore } from './ssh-credential-store';
import {
  SshTransferCache,
  validateLocalUploadFiles,
  validateRemoteTransferFiles,
} from './ssh-transfer-cache';

const sshCredentialStore = new SshCredentialStore(safeStorage);
const passwordProfiles = new Map<string, SshPasswordEndpoint>();
const ptyManager = new PtyManager((profileId, launch) => {
  const endpoint = passwordProfiles.get(profileId);
  if (!endpoint || !isAuthorizedSshPasswordLaunch(launch.command, launch.args, endpoint)) return undefined;
  return sshCredentialStore.get(profileId, endpoint);
});
const notificationManager = new NotificationManager();
const cdpBridge = new CDPBridge();
const agentManager = new AgentManager(ptyManager);
const sshManager = new SshManager();
const sshTransferCache = new SshTransferCache();

function asPasswordProfile(profile: SshConnectionProfile): SshConnectionProfile {
  return { ...profile, authMethod: 'password', privateKeyPath: undefined };
}

function credentialEndpoint(profile: SshConnectionProfile): SshPasswordEndpoint {
  return {
    host: profile.host.trim(),
    port: Number(profile.port),
    username: profile.username.trim(),
  };
}

export function registerIpcHandlers(windowManager: WindowManager, cdpProxyInstance?: CDPProxy): void {
  const confirmSshUploadOverwrite = async (
    event: Electron.IpcMainInvokeEvent,
    workspaceId: string,
    targets: Array<{ path: string; name: string }>,
  ): Promise<boolean> => {
    const conflicts = new Set<string>();
    const uniqueTargets = new Map<string, { path: string; name: string }>();
    for (const target of targets) {
      if (uniqueTargets.has(target.path)) conflicts.add(target.name);
      else uniqueTargets.set(target.path, target);
    }
    const existence = await Promise.all([...uniqueTargets.values()].map(async (target) => ({
      target,
      exists: await sshManager.pathExists(workspaceId, target.path),
    })));
    existence.forEach(({ target, exists }) => { if (exists) conflicts.add(target.name); });
    if (conflicts.size === 0) return true;
    const win = BrowserWindow.fromWebContents(event.sender);
    const conflictNames = [...conflicts];
    const shownNames = conflictNames.slice(0, 20);
    const options = {
      type: 'warning' as const,
      title: '确认覆盖远程项目',
      message: '远程目录中已有同名项目，是否继续？',
      detail: `${shownNames.join('\n')}${conflictNames.length > shownNames.length ? `\n…以及其他 ${conflictNames.length - shownNames.length} 项` : ''}\n\n目录将合并，同名文件将被覆盖。`,
      buttons: ['继续上传', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const confirmation = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return confirmation.response === 0;
  };

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
    try {
      const resolvedOptions = {
        ...options,
        cwd: options.cwd || process.env.USERPROFILE || 'C:\\',
      };
      const created = ptyManager.create(resolvedOptions);
      const id = created.id;
      // Reused PTY (idempotent create — e.g. StrictMode's double create() race):
      // the original create already wired data/exit forwarding. Re-wiring here
      // would forward every chunk twice and double everything in the renderer.
      if (created.reused) {
        return created;
      }
      const window = BrowserWindow.fromWebContents(_event.sender);
      const unsubData = ptyManager.onData(id, (data) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.PTY_DATA, id, data);
        }
        // Feed Claude Code observer for sidebar activity display
        try { observePtyData(id, data); } catch {}
      });
      const unsubExit = ptyManager.onExit(id, (code) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.PTY_EXIT, id, code);
        }
        // The process that owned this surface is gone, so any state it declared
        // is now a lie. Drop it rather than leave a `working`/`blocked` pane
        // pointing at a dead PID (issue #128); the observer's scraped activity
        // goes with it, since it describes the same dead process.
        clearAgentState(id);
        clearActivity(id);
        // Clean up listeners when PTY exits
        unsubData();
        unsubExit();
      });
      return created;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create terminal: ${msg}`);
    }
  });

  ipcMain.on(IPC_CHANNELS.PTY_WRITE, (_event, id: SurfaceId, data: string) => {
    ptyManager.write(id, data);
  });

  ipcMain.handle(IPC_CHANNELS.PTY_WRITE_CHECKED, (_event, id: SurfaceId, data: string) => {
    return ptyManager.writeChecked(id, data);
  });

  ipcMain.handle(IPC_CHANNELS.PTY_WRITE_RELIABLE, (_event, id: SurfaceId, data: string) => {
    return ptyManager.writeReliable(id, data);
  });

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_event, id: SurfaceId, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows);
  });

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_event, id: SurfaceId) => {
    ptyManager.kill(id);
  });

  ipcMain.handle(IPC_CHANNELS.PTY_HAS, (_event, id: SurfaceId) => {
    return ptyManager.has(id);
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_SHELLS, async () => {
    return detectShells();
  });

  // Installed font families for the Settings font picker (issue #89).
  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_FONTS, async () => {
    return listSystemFonts();
  });

  ipcMain.on(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_DIRECTORY_IN_EXPLORER, async (_event, directoryPath: unknown) => {
    if (typeof directoryPath !== 'string') return { ok: false, error: '目录路径无效。' };
    const candidate = directoryPath.trim();
    if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(candidate)) {
      return { ok: false, error: '只能在资源管理器中打开 Windows 本地目录。' };
    }
    try {
      const normalized = path.win32.normalize(candidate);
      if (!fs.statSync(normalized).isDirectory()) return { ok: false, error: '当前路径不是可打开的目录。' };
      const error = await shell.openPath(normalized);
      return error ? { ok: false, error } : { ok: true };
    } catch {
      return { ok: false, error: '当前目录不存在或无法访问。' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_VERSION, () => app.getVersion());

  // App UI theme (issue #67): report the Windows light/dark setting so the
  // renderer can follow it when appearance mode is "system", and push updates
  // when the user flips it in Windows Settings while wmux is running.
  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_SHOULD_USE_DARK_COLORS, () => nativeTheme.shouldUseDarkColors);
  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SYSTEM_NATIVE_THEME_UPDATED, nativeTheme.shouldUseDarkColors);
      }
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

  // Quick-launch profiles (issue #32): read project `.wmux.json` and import WT profiles.
  ipcMain.handle('config:getProjectProfiles', async (_event, cwd: string) => {
    return loadProjectProfiles(cwd);
  });
  ipcMain.handle('config:importWindowsTerminalProfiles', async () => {
    return importWindowsTerminalProfiles();
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

  ipcMain.handle(IPC_CHANNELS.SSH_IMPORT_CONFIG, async () => {
    try {
      const configPath = path.join(os.homedir(), '.ssh', 'config');
      if (!fs.existsSync(configPath)) return { drafts: [] };
      return { drafts: parseOpenSshConfig(fs.readFileSync(configPath, 'utf8')) };
    } catch (error) {
      return { drafts: [], error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(IPC_CHANNELS.SSH_PICK_KEY, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: '选择 SSH 私钥',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile'],
    });
    return result.canceled || result.filePaths.length === 0
      ? { canceled: true }
      : { path: result.filePaths[0] };
  });

  ipcMain.handle(IPC_CHANNELS.SSH_CONNECT, async (
    _event,
    workspaceId: string,
    profile: SshConnectionProfile,
    suppliedPassword?: string,
  ): Promise<SshConnectResult> => {
    const passwordProfile = asPasswordProfile(profile);
    const endpoint = credentialEndpoint(passwordProfile);
    const connectWithPassword = async (password: string): Promise<SshConnectResult> => {
      try {
        await sshManager.connect(workspaceId, passwordProfile, password);
        sshCredentialStore.save(profile.id, password, endpoint);
        passwordProfiles.set(profile.id, endpoint);
        return { ok: true, authMethod: 'password' };
      } catch (error) {
        sshManager.disconnect(workspaceId);
        if (error instanceof SshPasswordAuthenticationError) {
          sshCredentialStore.delete(profile.id);
          passwordProfiles.delete(profile.id);
          return { ok: false, passwordRequired: true, error: error.message };
        }
        throw error;
      }
    };

    const passwordRequested = profile.authMethod === 'password' || suppliedPassword !== undefined;
    if (!passwordRequested) {
      try {
        await sshManager.connect(workspaceId, profile);
        sshCredentialStore.delete(profile.id);
        passwordProfiles.delete(profile.id);
        return { ok: true, authMethod: profile.authMethod };
      } catch (error) {
        if (error instanceof SshAuthenticationError) {
          const cachedPassword = sshCredentialStore.get(profile.id, endpoint);
          if (cachedPassword) return connectWithPassword(cachedPassword);
          return { ok: false, passwordRequired: true, error: error.message };
        }
        throw error;
      }
    }

    const password = suppliedPassword
      || sshCredentialStore.get(profile.id, endpoint);
    if (!password) {
      return { ok: false, passwordRequired: true, error: '请输入 SSH 密码' };
    }
    return connectWithPassword(password);
  });
  ipcMain.handle(IPC_CHANNELS.SSH_DISCONNECT, async (_event, workspaceId: string) => {
    sshManager.disconnect(workspaceId);
    return { ok: true };
  });
  ipcMain.handle(IPC_CHANNELS.SSH_CREDENTIAL_STATUS, async (_event, profile: SshConnectionProfile) => {
    const endpoint = credentialEndpoint(profile);
    return {
      passwordSaved: sshCredentialStore.has(profile.id, endpoint),
      privateKeyConfigured: Boolean(profile.privateKeyPath),
    };
  });
  ipcMain.handle(IPC_CHANNELS.SSH_CREDENTIAL_UPDATE, async (
    _event,
    profile: SshConnectionProfile,
    password: string,
  ) => {
    if (!password) return { ok: false, error: 'SSH 密码不能为空' };
    const passwordProfile = asPasswordProfile(profile);
    const endpoint = credentialEndpoint(passwordProfile);
    const verificationId = `credential-${randomUUID()}`;
    try {
      await sshManager.connect(verificationId, passwordProfile, password);
      sshCredentialStore.save(profile.id, password, endpoint);
      passwordProfiles.set(profile.id, endpoint);
      return { ok: true };
    } catch (error) {
      if (error instanceof SshPasswordAuthenticationError) {
        return { ok: false, error: error.message };
      }
      throw error;
    } finally {
      sshManager.disconnect(verificationId);
    }
  });
  ipcMain.handle(IPC_CHANNELS.SSH_CREDENTIAL_DELETE, async (_event, profile: SshConnectionProfile) => {
    sshCredentialStore.delete(profile.id);
    passwordProfiles.delete(profile.id);
    return { ok: true };
  });
  ipcMain.handle(IPC_CHANNELS.SSH_LIST, async (_event, workspaceId: string, remotePath: string) => {
    return sshManager.list(workspaceId, remotePath);
  });
  ipcMain.handle(IPC_CHANNELS.SSH_UPLOAD, async (event, workspaceId: string, remoteDirectory: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: '上传到远程服务器',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const targets = result.filePaths.map((localPath) => ({
      path: path.posix.join(remoteDirectory || '.', path.basename(localPath)),
      name: path.basename(localPath),
    }));
    if (!await confirmSshUploadOverwrite(event, workspaceId, targets)) return { canceled: true };
    for (const localPath of result.filePaths) {
      await sshManager.uploadEntry(
        workspaceId,
        localPath,
        path.posix.join(remoteDirectory || '.', path.basename(localPath)),
        'file',
      );
    }
    return { ok: true };
  });
  ipcMain.handle(IPC_CHANNELS.SSH_UPLOAD_PATHS, async (
    event,
    workspaceId: string,
    remoteDirectory: string,
    localPaths: unknown,
  ) => {
    const { entries, rejected } = validateLocalUploadFiles(localPaths);
    const targets = entries.map((entry) => ({
      path: path.posix.join(remoteDirectory || '.', entry.name),
      name: entry.name,
    }));
    if (!await confirmSshUploadOverwrite(event, workspaceId, targets)) return { canceled: true, rejected };
    for (const entry of entries) {
      await sshManager.uploadEntry(
        workspaceId,
        entry.path,
        path.posix.join(remoteDirectory || '.', entry.name),
        entry.type,
      );
    }
    return { ok: true, uploaded: entries.length, rejected };
  });
  ipcMain.handle(IPC_CHANNELS.SSH_DOWNLOAD, async (event, workspaceId: string, remotePath: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showSaveDialog(win as BrowserWindow, {
      title: '下载远程文件',
      defaultPath: path.basename(remotePath),
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await sshManager.download(workspaceId, remotePath, result.filePath);
    return { ok: true, filePath: result.filePath };
  });
  ipcMain.handle(IPC_CHANNELS.SSH_DOWNLOAD_MANY, async (event, workspaceId: string, remoteFiles: unknown) => {
    const files = validateRemoteTransferFiles(remoteFiles);
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const defaultName = files.length === 1 && files[0].type === 'directory'
      ? `${files[0].name}.tar.gz`
      : `wmux-download-${files.length}-items.tar.gz`;
    const result = await dialog.showSaveDialog(win as BrowserWindow, {
      title: '下载远程压缩包',
      defaultPath: defaultName,
      filters: [{ name: 'Tar GZip 压缩包', extensions: ['gz', 'tgz'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await sshManager.downloadArchive(workspaceId, files.map((file) => file.path), result.filePath);
    return { ok: true, downloaded: files.length, filePath: result.filePath };
  });
  ipcMain.handle(IPC_CHANNELS.SSH_PREPARE_DRAG, async (event, workspaceId: string, remoteFiles: unknown) => {
    const prepared = await sshTransferCache.prepare(remoteFiles, (remotePath, localPath, type) =>
      sshManager.downloadEntry(workspaceId, remotePath, localPath, type), String(event.sender.id));
    return { ok: true, token: prepared.token };
  });
  ipcMain.on(IPC_CHANNELS.SSH_START_DRAG, (event, token: string) => {
    const files = sshTransferCache.get(token);
    if (!files) return;
    event.sender.startDrag({
      file: files[0],
      files,
      icon: path.join(app.getAppPath(), 'resources', 'icon.png'),
    });
  });
  ipcMain.handle(IPC_CHANNELS.SSH_RENAME, async (
    _event,
    workspaceId: string,
    remotePath: string,
    newName: string,
  ) => ({ ok: true, path: await sshManager.rename(workspaceId, remotePath, newName) }));
  ipcMain.handle(IPC_CHANNELS.SSH_DELETE, async (event, workspaceId: string, remotePath: string) => {
    if (typeof remotePath !== 'string' || !remotePath.trim() || remotePath.includes('\0')) {
      throw new Error('远程文件路径无效');
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = {
      type: 'warning' as const,
      title: '删除远程项目',
      message: `确定删除“${path.posix.basename(remotePath)}”吗？`,
      detail: '此操作无法撤销；目录仅在为空时才能删除。',
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const confirmation = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    if (confirmation.response !== 0) return { canceled: true };
    await sshManager.deleteEntry(workspaceId, remotePath);
    return { ok: true };
  });
  ipcMain.handle(IPC_CHANNELS.SSH_CREATE, async (
    _event,
    workspaceId: string,
    remoteDirectory: string,
    name: string,
    type: 'file' | 'directory',
  ) => ({ ok: true, path: await sshManager.createEntry(workspaceId, remoteDirectory, name, type) }));
  ipcMain.handle(IPC_CHANNELS.SSH_READ_FILE, async (
    _event,
    workspaceId: string,
    remotePath: string,
  ) => {
    try {
      return await sshManager.readTextFile(workspaceId, remotePath);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(IPC_CHANNELS.SSH_STAT_FILE, async (
    _event,
    workspaceId: string,
    remotePath: string,
  ) => {
    try {
      return await sshManager.statTextFile(workspaceId, remotePath);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(IPC_CHANNELS.SSH_WRITE_FILE, async (
    _event,
    workspaceId: string,
    remotePath: string,
    content: string,
    expectedMtimeMs?: number,
  ) => {
    try {
      return await sshManager.writeTextFile(workspaceId, remotePath, content, expectedMtimeMs);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.on(IPC_CHANNELS.NOTIFICATION_FIRE, (_event, data: { surfaceId: string; text: string; title?: string; flash?: boolean }) => {
    const window = BrowserWindow.fromWebContents(_event.sender);
    // Show toast
    notificationManager.showToast(data.title || 'wmux', data.text, () => {
      if (window && !window.isDestroyed()) {
        window.focus();
        window.webContents.send('notification:focus-surface', data.surfaceId);
      }
    });
    // Flash taskbar unless the caller opted out (idle-attention uses WINDOW_FLASH
    // instead so it can respect notificationPrefs.taskbarFlash in the renderer).
    if (data.flash !== false && window && !window.isDestroyed()) {
      notificationManager.flashTaskbar(window);
    }
    // Ask the renderer to play the notification sound. The main process can't
    // play audio (no Web Audio API), and only the renderer knows the user's
    // `notificationPrefs.sound` preference — it decides whether to actually
    // play. Sending here makes this the single chokepoint for every fired
    // notification (OSC 9/99/777 + App.tsx) regardless of call-site (issue #32).
    if (window && !window.isDestroyed()) {
      window.webContents.send('notification:play-sound');
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
  // Taskbar icon flash for "session went idle while you were away".
  // enable=true only flashes when the window is unfocused; enable=false always stops.
  ipcMain.on(IPC_CHANNELS.WINDOW_FLASH, (e, enable: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    if (enable) notificationManager.flashTaskbar(win);
    else notificationManager.stopFlash(win);
  });

  // Taskbar progress: renderer sends its OSC 9;4 aggregate for this window.
  ipcMain.on(IPC_CHANNELS.WINDOW_SET_PROGRESS, (e, value: number, mode?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    const validModes = ['none', 'normal', 'indeterminate', 'error', 'paused'];
    const safeMode = (validModes.includes(mode ?? '') ? mode : 'normal') as
      'none' | 'normal' | 'indeterminate' | 'error' | 'paused';
    win.setProgressBar(typeof value === 'number' ? value : -1, { mode: safeMode });
  });

  ipcMain.on(
    IPC_CHANNELS.CDP_ATTACH,
    (_event, webContentsId: number, surfaceId?: string | null, workspaceId?: string | null) => {
      // surfaceId/workspaceId let main route per-caller browser commands to the
      // right pane so concurrent agents don't collide (issue #62).
      cdpBridge.attach(webContentsId, surfaceId, workspaceId);
      cdpProxyInstance?.setWebContentsId(webContentsId);
    },
  );
  ipcMain.on(IPC_CHANNELS.CDP_DETACH, (_event, webContentsId?: number) => {
    // Detach only this pane's own target — other open browsers keep their
    // independent connections (issues #27, #62).
    cdpBridge.detach(webContentsId);
    if (webContentsId === undefined || cdpProxyInstance?.currentWebContentsId === webContentsId) {
      cdpProxyInstance?.setWebContentsId(null);
    }
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
  ipcMain.handle('clipboard:write-text', (_event, text: string) => {
    clipboard.writeText(text);
  });

  // Use Electron's clipboard for reads too — navigator.clipboard.readText() can
  // return garbled text on Windows when the source app wrote a non-UTF-8 format.
  ipcMain.handle('clipboard:read-text', () => clipboard.readText());

  // Clipboard image paste: save clipboard image to temp file, return path
  ipcMain.handle('clipboard:paste-image', async () => {
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
  // Return the auto-saved session in the flattened shape the renderer's restore
  // code already understands. Used on app launch so the workspaces / splits /
  // tabs persisted by the 30s rolling save are actually rehydrated (instead of
  // the renderer falling back to a fresh "Session 1").
  //
  // Answered per window (issue #118): main primes each restored window's slot
  // at creation, so a window gets back its own workspaces. Returning windows[0]
  // to every caller — the old behaviour — meant a window opened during the run
  // came up as a clone of the first window's tabs, and multi-window sessions
  // could never restore more than one window's worth of state.
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD_AUTO, (event) => {
    const windowId = windowManager.idForWebContents(event.sender);
    if (windowId) return toRestorePayload(sessionWindows.get(windowId));
    // Unattributable sender: fall back to the file's first window rather than
    // leaving a legitimately-restored window empty.
    return toRestorePayload(loadSession()?.windows?.[0] ?? null);
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

  // OS display-language list for first-launch UI language detection (issue #114).
  // navigator.language follows Chromium's locale resolution, which on Windows can
  // pick up regional-format/Accept-Language settings and disagree with the actual
  // display language — an English Windows reported French. GetUserPreferredUILanguages
  // (what getPreferredSystemLanguages wraps) is the authoritative signal. Synchronous
  // because the Zustand settings slice hydrates at module-load time.
  ipcMain.on('system:get-preferred-languages-sync', (event) => {
    try {
      event.returnValue = app.getPreferredSystemLanguages();
    } catch {
      event.returnValue = [];
    }
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

  // Markdown viewer (issue #54): manual "open markdown file" entry point.
  // Shows a native file picker filtered to the allowed extensions, then reads
  // the file applying the SAME guards as the markdown.load_file pipe handler
  // (extension whitelist + 5 MB cap) so the manual path can't slurp secrets.
  ipcMain.handle(IPC_CHANNELS.MARKDOWN_OPEN_FILE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Open Markdown File',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown / Text', extensions: MD_DIALOG_EXTENSIONS },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    // The "All Files" filter lets the user pick anything, so the whitelist still
    // has to be enforced after the dialog — the filter is a convenience, not a guard.
    const read = readMarkdownFile(result.filePaths[0]);
    // The user chose this file in a native dialog, so editing and saving it back
    // is what they asked for. That consent is what the grant set records (F3).
    if (!('error' in read)) grantMarkdownPath(event.sender.id, read.filePath);
    return read;
  });

  // Markdown viewer (issue #116): re-read a file the pane already knows about.
  // Backs "Reload from disk" (agents rewrite files under the pane constantly)
  // and drag-and-drop of a file onto a markdown pane. Same guards as every
  // other read — the renderer supplies the path, so it is treated as untrusted.
  ipcMain.handle(IPC_CHANNELS.MARKDOWN_READ_FILE, async (_event, filePath: string) => {
    return readMarkdownFile(filePath);
  });

  // Markdown viewer (issue #116): the two read-only shell actions on the backing
  // file. Both are gated on the extension whitelist — without it, `openPath` on
  // a renderer-supplied path is an arbitrary-program launcher, which is a much
  // bigger capability than "open the doc I'm reading in Typora".
  ipcMain.handle(IPC_CHANNELS.MARKDOWN_REVEAL, async (_event, filePath: string) => {
    if (!isAllowedMarkdownPath(filePath)) return { error: 'Unsupported file type' };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MARKDOWN_OPEN_IN_APP, async (_event, filePath: string) => {
    if (!isAllowedMarkdownPath(filePath)) return { error: 'Unsupported file type' };
    const err = await shell.openPath(filePath);
    return err ? { error: err } : { ok: true };
  });

  // Markdown editing (issue #116, F3). Re-stat only — backs the on-focus
  // "changed on disk?" check, which needs the mtime and not the content.
  ipcMain.handle(IPC_CHANNELS.MARKDOWN_STAT_FILE, async (_event, filePath: string) => {
    return statMarkdownFile(filePath);
  });

  // Save in place. The path comes from the renderer's store, so it is only
  // honoured if it is in this window's grant set — see ./markdown-grants for
  // why a renderer-supplied write path is treated as attacker-controlled.
  ipcMain.handle(
    IPC_CHANNELS.MARKDOWN_SAVE_FILE,
    async (event, filePath: string, content: string, expectedMtimeMs?: number) => {
      if (!isMarkdownPathGranted(event.sender.id, filePath)) {
        return { error: 'This file was not opened in wmux — use Save As' };
      }
      return writeMarkdownFile(filePath, content, expectedMtimeMs);
    },
  );

  // Save As: the native dialog is the user's consent, so a confirmed
  // destination both gets written and becomes a grant for later in-place saves.
  ipcMain.handle(
    IPC_CHANNELS.MARKDOWN_SAVE_AS,
    async (event, content: string, suggestedName?: string, defaultDir?: string) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = await dialog.showSaveDialog(win as BrowserWindow, {
        title: 'Save Markdown File',
        defaultPath: suggestedName
          ? path.join(defaultDir || '', suggestedName)
          : path.join(defaultDir || '', 'untitled.md'),
        filters: [{ name: 'Markdown / Text', extensions: MD_DIALOG_EXTENSIONS }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      const written = writeMarkdownFile(result.filePath, content);
      if ('ok' in written) {
        grantMarkdownPath(event.sender.id, result.filePath);
        return { ...written, filePath: result.filePath };
      }
      return written;
    },
  );

  // Folder picker (issue #64): backs the `openFolder` shortcut (Ctrl+O). Shows a
  // native directory dialog and returns the chosen path; the renderer opens a new
  // workspace rooted there. Previously `openFolder` was a bound-but-no-op stub.
  // "Open in wmux" Explorer verb (HKCU shell keys — see shell-context-menu.ts).
  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_CONTEXT_MENU, () => {
    try {
      return isContextMenuInstalled();
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_SET_CONTEXT_MENU, (_event, enabled: boolean, label?: string) => {
    try {
      if (enabled) {
        // Packaged: wmux.exe "%V"
        // Dev: electron.exe "<project>" "%V" — without the project path Electron
        // treats %V as the app and never boots wmux (registry used to be broken).
        const exe = app.getPath('exe');
        const appPath = app.isPackaged ? null : app.getAppPath();
        installContextMenu(exe, label || 'Open in wmux', appPath);
      } else {
        uninstallContextMenu();
      }
      // Report the state actually achieved, not the state requested — a partial
      // registry write must not leave the toggle claiming success.
      return { ok: true, enabled: isContextMenuInstalled() };
    } catch (err) {
      return { ok: false, enabled: isContextMenuInstalled(), error: (err as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_PICK_FOLDER, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Open Folder as Workspace',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    return { path: result.filePaths[0] };
  });

  // Explorer cold-start: one-shot folder path for the renderer's session init.
  ipcMain.handle(IPC_CHANNELS.SYSTEM_CONSUME_LAUNCH_DIRECTORY, () => consumePendingLaunchDirectory());
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

export { ptyManager, cdpBridge, agentManager, sshManager, sshTransferCache };
