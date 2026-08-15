import { describe, expect, it, vi } from 'vitest';
import {
  getLoginStartupEnabled,
  initializeLoginStartup,
  LOGIN_STARTUP_SETTING_KEY,
  setLoginStartupEnabled,
  updateLoginStartup,
} from '../../src/main/login-startup';

function fakeApp(packaged = true) {
  let enabled = false;
  return {
    app: {
      isPackaged: packaged,
      getAppPath: () => 'E:\\work\\wmux',
      getLoginItemSettings: vi.fn(() => ({
        openAtLogin: enabled,
        executableWillLaunchAtLogin: enabled,
      })),
      setLoginItemSettings: vi.fn((settings: Electron.Settings) => {
        enabled = settings.openAtLogin === true && settings.enabled !== false;
      }),
    },
    isEnabled: () => enabled,
  };
}

describe('Windows login startup', () => {
  it('enables login startup by default and persists the inferred preference', () => {
    const runtime = fakeApp();
    const save = vi.fn();

    expect(initializeLoginStartup(runtime.app, { load: () => ({}), save })).toEqual({
      ok: true,
      enabled: true,
    });
    expect(runtime.app.setLoginItemSettings).toHaveBeenCalledWith(expect.objectContaining({
      openAtLogin: true,
      enabled: true,
      args: [],
      name: 'wmux',
    }));
    expect(save).toHaveBeenCalledWith(LOGIN_STARTUP_SETTING_KEY, true);
  });

  it('preserves an explicit off preference and supports changing it later', () => {
    const runtime = fakeApp();
    const save = vi.fn();
    const store = { load: () => ({ [LOGIN_STARTUP_SETTING_KEY]: false }), save };

    expect(initializeLoginStartup(runtime.app, store)).toEqual({ ok: true, enabled: false });
    expect(save).not.toHaveBeenCalled();
    expect(updateLoginStartup(runtime.app, true, store)).toEqual({ ok: true, enabled: true });
    expect(save).toHaveBeenCalledWith(LOGIN_STARTUP_SETTING_KEY, true);
    expect(getLoginStartupEnabled(runtime.app)).toBe(true);
  });

  it('passes the app directory when registering a development Electron build', () => {
    const runtime = fakeApp(false);

    expect(setLoginStartupEnabled(runtime.app, true)).toEqual({ ok: true, enabled: true });
    expect(runtime.app.setLoginItemSettings).toHaveBeenCalledWith(expect.objectContaining({
      args: ['"E:\\work\\wmux"'],
    }));
  });

  it('does not persist a preference when Windows rejects the login item update', () => {
    const runtime = fakeApp();
    runtime.app.setLoginItemSettings.mockImplementation(() => { throw new Error('registry denied'); });
    const save = vi.fn();

    expect(updateLoginStartup(runtime.app, true, { load: () => ({}), save })).toEqual({
      ok: false,
      enabled: false,
      error: 'registry denied',
    });
    expect(save).not.toHaveBeenCalled();
  });
});
