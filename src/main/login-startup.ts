import { loadSettings, saveSetting } from './settings-store';

export const LOGIN_STARTUP_SETTING_KEY = 'launchAtLogin';

interface LoginStartupApp {
  isPackaged: boolean;
  getAppPath(): string;
  getLoginItemSettings(options?: Electron.LoginItemSettingsOptions): Pick<
    Electron.LoginItemSettings,
    'openAtLogin' | 'executableWillLaunchAtLogin'
  >;
  setLoginItemSettings(settings: Electron.Settings): void;
}

interface LoginStartupStore {
  load(): Record<string, unknown>;
  save(key: string, value: unknown): void;
}

const defaultStore: LoginStartupStore = {
  load: loadSettings,
  save: saveSetting,
};

function loginItemIdentity(app: LoginStartupApp): Electron.LoginItemSettingsOptions & {
  args: string[];
  path: string;
} {
  return {
    path: process.execPath,
    args: app.isPackaged ? [] : [`"${app.getAppPath()}"`],
  };
}

export function getLoginStartupEnabled(app: LoginStartupApp): boolean {
  const identity = loginItemIdentity(app);
  const settings = app.getLoginItemSettings({ path: identity.path, args: identity.args });
  return settings.openAtLogin && settings.executableWillLaunchAtLogin;
}

export function setLoginStartupEnabled(
  app: LoginStartupApp,
  enabled: boolean,
): { ok: boolean; enabled: boolean; error?: string } {
  try {
    const identity = loginItemIdentity(app);
    // Early builds used a custom Run value name. Electron's read API cannot
    // query that name, so remove it before registering the default AppUserModelId
    // entry that getLoginItemSettings can verify.
    try {
      app.setLoginItemSettings({ ...identity, name: 'wmux', openAtLogin: false });
    } catch { /* Legacy cleanup is best-effort; the canonical write below is authoritative. */ }
    app.setLoginItemSettings({ ...identity, openAtLogin: enabled, enabled });
    const actual = getLoginStartupEnabled(app);
    return actual === enabled
      ? { ok: true, enabled: actual }
      : { ok: false, enabled: actual, error: 'Windows 未应用开机自启设置。' };
  } catch (error) {
    let actual = false;
    try {
      actual = getLoginStartupEnabled(app);
    } catch { /* Keep the safe fallback when Windows cannot read the login item. */ }
    return { ok: false, enabled: actual, error: String((error as Error)?.message || error) };
  }
}

export function updateLoginStartup(
  app: LoginStartupApp,
  enabled: boolean,
  store: LoginStartupStore = defaultStore,
): { ok: boolean; enabled: boolean; error?: string } {
  const result = setLoginStartupEnabled(app, enabled);
  if (result.ok) store.save(LOGIN_STARTUP_SETTING_KEY, enabled);
  return result;
}

/** Missing preferences opt in by default; explicit user choices remain authoritative. */
export function initializeLoginStartup(
  app: LoginStartupApp,
  store: LoginStartupStore = defaultStore,
): { ok: boolean; enabled: boolean; error?: string } {
  const stored = store.load()[LOGIN_STARTUP_SETTING_KEY];
  const enabled = typeof stored === 'boolean' ? stored : true;
  const result = setLoginStartupEnabled(app, enabled);
  if (result.ok && typeof stored !== 'boolean') store.save(LOGIN_STARTUP_SETTING_KEY, enabled);
  return result;
}
