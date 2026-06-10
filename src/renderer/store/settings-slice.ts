import { StateCreator } from 'zustand';

// ─── Persistence helpers (issue #12 + issue #15 + issue #19) ─────────────────
// Zustand has no persistence middleware here, so any pref that lives only in
// state resets on every launch — which made "Default shell" (issue #12) and
// theme/font/shortcut customizations (issue #15) feel broken.
//
// Settings used to live in renderer localStorage, but localStorage is scoped to
// the page origin. wmux ships as a portable zip extracted to a new folder per
// version, so the production `file://` origin changes between versions and
// Chromium buckets storage by that path — font/theme customizations appeared to
// reset on every update (issue #19). We now persist through the main process to
// %APPDATA%\wmux\settings.json (stable across updates), and migrate any existing
// localStorage values forward on first launch.

const STORAGE_KEYS = {
  workspacePrefs:    'wmux-workspace-prefs',
  terminalPrefs:     'wmux-terminal-prefs',
  sidebarPrefs:      'wmux-sidebar-prefs',
  notificationPrefs: 'wmux-notification-prefs',
  browserPrefs:      'wmux-browser-prefs',
  shortcuts:         'wmux-shortcuts',
} as const;

// Read the whole settings file once at module load (synchronous IPC). The
// preload runs before this module, so window.wmux is already available. In
// non-Electron contexts (tests) this is absent and we fall back to localStorage.
function readFileSnapshot(): Record<string, any> {
  try {
    const snap = (globalThis as any).window?.wmux?.settings?.getAllSync?.();
    return snap && typeof snap === 'object' ? snap : {};
  } catch {
    return {};
  }
}

const FILE_SETTINGS = readFileSnapshot();

function loadPersisted<T>(key: string): Partial<T> {
  // File store is the source of truth; fall back to legacy localStorage and
  // migrate it forward so existing users keep their customizations.
  const fromFile = FILE_SETTINGS[key];
  if (fromFile && typeof fromFile === 'object') return fromFile as Partial<T>;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      try { (globalThis as any).window?.wmux?.settings?.set?.(key, parsed); } catch { /* no-op */ }
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

function persist<T>(key: string, value: T): void {
  try { (globalThis as any).window?.wmux?.settings?.set?.(key, value); } catch { /* no-op */ }
  // Keep a localStorage mirror as a harmless dev/non-Electron fallback.
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // localStorage unavailable (private mode, quota exceeded) — ignore
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ShortcutBinding {
  key: string; // e.g., 'n', 'd', 'w', 'b', 'PageDown'
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type ShortcutAction =
  | 'newWorkspace'
  | 'newWindow'
  | 'closeWorkspace'
  | 'closeWindow'
  | 'openFolder'
  | 'toggleSidebar'
  | 'nextWorkspace'
  | 'prevWorkspace'
  | 'renameSurface'
  | 'renameWorkspace'
  | 'splitRight'
  | 'splitDown'
  | 'splitBrowserRight'
  | 'splitBrowserDown'
  | 'toggleZoom'
  | 'focusLeft'
  | 'focusRight'
  | 'focusUp'
  | 'focusDown'
  | 'closeSurfaceOrPane'
  | 'newSurface'
  | 'nextSurface'
  | 'prevSurface'
  | 'jumpToUnread'
  | 'showNotifications'
  | 'flashFocused'
  | 'openBrowser'
  | 'browserDevTools'
  | 'browserConsole'
  | 'find'
  | 'copyMode'
  | 'copy'
  | 'paste'
  | 'fontSizeIncrease'
  | 'fontSizeDecrease'
  | 'fontSizeReset'
  | 'openSettings'
  | 'commandPalette'
  | 'openMarkdownPanel';

// ─── Default shortcuts ────────────────────────────────────────────────────────

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, ShortcutBinding> = {
  newWorkspace:      { key: 'n', ctrl: true },
  newWindow:         { key: 'n', ctrl: true, shift: true },
  closeWorkspace:    { key: 'w', ctrl: true, shift: true },
  closeWindow:       { key: 'F4', alt: true },
  openFolder:        { key: 'o', ctrl: true },
  toggleSidebar:     { key: 'b', ctrl: true },
  nextWorkspace:     { key: 'PageDown', ctrl: true },
  prevWorkspace:     { key: 'PageUp', ctrl: true },
  renameSurface:     { key: 'F2', ctrl: true },
  renameWorkspace:   { key: 'F2', ctrl: true, shift: true },
  splitRight:        { key: 'd', ctrl: true },
  splitDown:         { key: 'd', ctrl: true, shift: true },
  splitBrowserRight: { key: 'd', ctrl: true, alt: true },
  splitBrowserDown:  { key: 'd', ctrl: true, alt: true, shift: true },
  toggleZoom:        { key: 'Enter', ctrl: true, shift: true },
  focusLeft:         { key: 'ArrowLeft', ctrl: true, alt: true },
  focusRight:        { key: 'ArrowRight', ctrl: true, alt: true },
  focusUp:           { key: 'ArrowUp', ctrl: true, alt: true },
  focusDown:         { key: 'ArrowDown', ctrl: true, alt: true },
  closeSurfaceOrPane:{ key: 'w', ctrl: true },
  newSurface:        { key: 't', ctrl: true },
  nextSurface:       { key: ']', ctrl: true, shift: true },
  prevSurface:       { key: '[', ctrl: true, shift: true },
  jumpToUnread:      { key: 'u', ctrl: true, shift: true },
  showNotifications: { key: 'n', ctrl: true, alt: true },
  flashFocused:      { key: 'f', ctrl: true, alt: true },
  openBrowser:       { key: 'i', ctrl: true, shift: true },
  browserDevTools:   { key: 'F12', ctrl: true },
  browserConsole:    { key: 'j', ctrl: true, shift: true },
  find:              { key: 'f', ctrl: true },
  copyMode:          { key: '[', ctrl: true, alt: true },
  copy:              { key: 'c', ctrl: true, shift: true },
  paste:             { key: 'v', ctrl: true, shift: true },
  fontSizeIncrease:  { key: '=', ctrl: true },
  fontSizeDecrease:  { key: '-', ctrl: true },
  fontSizeReset:     { key: '0', ctrl: true },
  openSettings:      { key: ',', ctrl: true },
  commandPalette:    { key: 'p', ctrl: true, shift: true },
  openMarkdownPanel: { key: 'm', ctrl: true, shift: true },
};

// ─── Sidebar settings ─────────────────────────────────────────────────────────

export type UiTheme = 'codex' | 'claude' | 'vscode-studio-dark';

export interface SidebarPrefs {
  showGitBranch: boolean;
  showWorkingDir: boolean;
  showPR: boolean;
  showPorts: boolean;
  showNotificationMessage: boolean;
  hideAllDetails: boolean;
  activeTabIndicator: 'leftRail' | 'solidFill';
  backgroundOpacity: number; // 0–100
  /** UI chrome 配色方案（侧栏/标题栏/标签等），独立于终端 xterm 主题。 */
  uiTheme: UiTheme;
}

export const DEFAULT_SIDEBAR_PREFS: SidebarPrefs = {
  showGitBranch: true,
  showWorkingDir: true,
  showPR: true,
  showPorts: true,
  showNotificationMessage: true,
  hideAllDetails: false,
  activeTabIndicator: 'leftRail',
  backgroundOpacity: 100,
  uiTheme: 'codex',
};

// ─── Workspace settings ───────────────────────────────────────────────────────

export interface WorkspacePrefs {
  newWorkspacePlacement: 'afterCurrent' | 'top' | 'end';
  autoReorderOnNotification: boolean;
  defaultShell: string;
  /** Show the welcome/tutorial screen on first launch (issue #22). */
  showWelcomeScreen: boolean;
}

export const DEFAULT_WORKSPACE_PREFS: WorkspacePrefs = {
  newWorkspacePlacement: 'afterCurrent',
  autoReorderOnNotification: false,
  defaultShell: '',
  showWelcomeScreen: false,
};

// ─── Terminal settings ────────────────────────────────────────────────────────

/**
 * A user-defined color scheme. Partial: only specified fields override the
 * base theme (so users can tweak just `background` + `foreground` if they want).
 * Mirrors the shape requested in issue #4.
 */
export interface UserColorScheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorText?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  palette?: string[]; // up to 16 ANSI entries
}

export interface TerminalPrefs {
  fontFamily: string;
  fontSize: number;
  /** Global default color scheme name (bundled theme or userColorSchemes key). */
  theme: string;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  scrollbackLines: number;
  /** User-defined color schemes, addressable by name in per-pane overrides. */
  userColorSchemes: Record<string, UserColorScheme>;
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontFamily: 'Consolas, Menlo, Monaco, monospace',
  fontSize: 13,
  theme: 'Codex',
  cursorStyle: 'block',
  cursorBlink: true,
  scrollbackLines: 5000,
  userColorSchemes: {},
};

// ─── Notification settings ────────────────────────────────────────────────────

export interface NotificationPrefs {
  toast: boolean;
  taskbarFlash: boolean;
  paneRing: boolean;
  paneFlashAnimation: boolean;
  sound: 'default' | 'none';
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  toast: true,
  taskbarFlash: true,
  paneRing: true,
  paneFlashAnimation: true,
  sound: 'default',
};

// ─── Browser settings ─────────────────────────────────────────────────────────

export interface BrowserPrefs {
  searchEngine: 'google' | 'duckduckgo' | 'bing' | 'brave';
  devToolsIcon: 'default' | 'compact' | 'hidden';
  /** Open the browser panel automatically on startup (issue #22). */
  openOnStartup: boolean;
}

export const DEFAULT_BROWSER_PREFS: BrowserPrefs = {
  searchEngine: 'google',
  devToolsIcon: 'default',
  openOnStartup: false,
};

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface SettingsSlice {
  shortcuts: Record<ShortcutAction, ShortcutBinding>;
  sidebarVisible: boolean;
  sidebarPrefs: SidebarPrefs;
  workspacePrefs: WorkspacePrefs;
  terminalPrefs: TerminalPrefs;
  notificationPrefs: NotificationPrefs;
  browserPrefs: BrowserPrefs;

  setShortcut(action: ShortcutAction, binding: ShortcutBinding): void;
  resetShortcuts(): void;
  toggleSidebar(): void;
  setSidebarPrefs(prefs: Partial<SidebarPrefs>): void;
  setWorkspacePrefs(prefs: Partial<WorkspacePrefs>): void;
  setTerminalPrefs(prefs: Partial<TerminalPrefs>): void;
  setNotificationPrefs(prefs: Partial<NotificationPrefs>): void;
  setBrowserPrefs(prefs: Partial<BrowserPrefs>): void;
}

// ─── Slice creator ────────────────────────────────────────────────────────────

export const createSettingsSlice: StateCreator<SettingsSlice> = (set) => ({
  shortcuts:         { ...DEFAULT_SHORTCUTS,         ...loadPersisted<Record<ShortcutAction, ShortcutBinding>>(STORAGE_KEYS.shortcuts) },
  sidebarVisible:    true,
  sidebarPrefs:      { ...DEFAULT_SIDEBAR_PREFS,      ...loadPersisted<SidebarPrefs>(STORAGE_KEYS.sidebarPrefs) },
  workspacePrefs:    { ...DEFAULT_WORKSPACE_PREFS,    ...loadPersisted<WorkspacePrefs>(STORAGE_KEYS.workspacePrefs) },
  terminalPrefs:     { ...DEFAULT_TERMINAL_PREFS,     ...loadPersisted<TerminalPrefs>(STORAGE_KEYS.terminalPrefs) },
  notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS, ...loadPersisted<NotificationPrefs>(STORAGE_KEYS.notificationPrefs) },
  browserPrefs:      { ...DEFAULT_BROWSER_PREFS,      ...loadPersisted<BrowserPrefs>(STORAGE_KEYS.browserPrefs) },

  setShortcut(action: ShortcutAction, binding: ShortcutBinding): void {
    set((state) => {
      const merged = { ...state.shortcuts, [action]: binding };
      persist(STORAGE_KEYS.shortcuts, merged);
      return { shortcuts: merged };
    });
  },

  resetShortcuts(): void {
    persist(STORAGE_KEYS.shortcuts, DEFAULT_SHORTCUTS);
    set({ shortcuts: { ...DEFAULT_SHORTCUTS } });
  },

  toggleSidebar(): void {
    set((state) => ({ sidebarVisible: !state.sidebarVisible }));
  },

  setSidebarPrefs(prefs: Partial<SidebarPrefs>): void {
    set((state) => {
      const merged = { ...state.sidebarPrefs, ...prefs };
      persist(STORAGE_KEYS.sidebarPrefs, merged);
      return { sidebarPrefs: merged };
    });
  },

  setWorkspacePrefs(prefs: Partial<WorkspacePrefs>): void {
    set((state) => {
      const merged = { ...state.workspacePrefs, ...prefs };
      persist(STORAGE_KEYS.workspacePrefs, merged);
      return { workspacePrefs: merged };
    });
  },

  setTerminalPrefs(prefs: Partial<TerminalPrefs>): void {
    set((state) => {
      const merged = { ...state.terminalPrefs, ...prefs };
      persist(STORAGE_KEYS.terminalPrefs, merged);
      return { terminalPrefs: merged };
    });
  },

  setNotificationPrefs(prefs: Partial<NotificationPrefs>): void {
    set((state) => {
      const merged = { ...state.notificationPrefs, ...prefs };
      persist(STORAGE_KEYS.notificationPrefs, merged);
      return { notificationPrefs: merged };
    });
  },

  setBrowserPrefs(prefs: Partial<BrowserPrefs>): void {
    set((state) => {
      const merged = { ...state.browserPrefs, ...prefs };
      persist(STORAGE_KEYS.browserPrefs, merged);
      return { browserPrefs: merged };
    });
  },
});
