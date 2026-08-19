import { BrowserWindow } from 'electron';

interface GuardWindow {
  isDestroyed(): boolean;
  webContents: {
    executeJavaScript(script: string): Promise<unknown>;
  };
}

interface SurfaceAuthorizationResult {
  knownSurface?: boolean;
  managed?: boolean;
  allowed?: boolean;
  reason?: string;
}

const RENDERER_AUTH_TIMEOUT_MS = 750;

function withAuthorizationTimeout(value: Promise<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), RENDERER_AUTH_TIMEOUT_MS);
    value.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Resolve the window owning the caller surface, then enforce its live role policy. */
export async function authorizeSurfaceCapabilityRequest(
  callerSurfaceId: string,
  method: string,
  params: Record<string, any>,
  windows: GuardWindow[] = BrowserWindow.getAllWindows(),
): Promise<{ allowed: boolean; reason?: string }> {
  const candidates = windows.filter((win) => !win.isDestroyed());
  const results = await Promise.all(candidates.map(async (win) => {
    try {
      return await withAuthorizationTimeout(win.webContents.executeJavaScript(
        `window.__wmux_authorizeSurfaceCapability?.(${JSON.stringify({ callerSurfaceId, method, params })})`,
      )) as SurfaceAuthorizationResult | undefined;
    } catch {
      return undefined;
    }
  }));
  const managedResults = results.filter((candidate) => candidate?.knownSurface && candidate.managed);
  const denied = managedResults.find((candidate) => candidate?.allowed !== true);
  if (denied) {
    return { allowed: false, reason: denied.reason || '当前 AI 角色无权执行该 wmux 命令' };
  }
  if (managedResults.some((candidate) => candidate?.allowed === true)) return { allowed: true };
  if (results.some((candidate) => candidate?.knownSurface)) return { allowed: true };
  return { allowed: false, reason: '无法在活动窗口中确认当前 surface capability 的角色归属' };
}
