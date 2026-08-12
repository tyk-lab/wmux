import { BrowserWindow } from 'electron';

interface GuardWindow {
  isDestroyed(): boolean;
  webContents: {
    executeJavaScript(script: string): Promise<unknown>;
  };
}

interface GuardResult {
  blocked?: boolean;
  reason?: string;
}

export interface SupervisorTerminalInputResult {
  handled: boolean;
  clearAutomatedDraft: boolean;
}

const RENDERER_GUARD_TIMEOUT_MS = 500;

function withGuardTimeout(value: Promise<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), RENDERER_GUARD_TIMEOUT_MS);
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

/**
 * Ask renderer-owned supervisor state whether a generic cross-surface write is
 * allowed. Missing caller identity stays compatible with trusted external UI
 * integrations such as Feishu, which do not originate inside a wmux PTY.
 */
export async function supervisorGenericInputBlockReason(
  callerSurfaceId: string,
  targetSurfaceId: string,
  windows: GuardWindow[] = BrowserWindow.getAllWindows(),
): Promise<string | null> {
  if (!callerSurfaceId || !targetSurfaceId || callerSurfaceId === targetSurfaceId) return null;

  for (const win of windows) {
    if (win.isDestroyed()) continue;
    try {
      const result = await withGuardTimeout(win.webContents.executeJavaScript(
        `window.__wmux_guardSupervisorGenericInput?.(${JSON.stringify(callerSurfaceId)}, ${JSON.stringify(targetSurfaceId)})`,
      )) as GuardResult | undefined;
      if (result?.blocked) {
        return result.reason || '专用 AI 监督终端不能使用通用终端输入接口';
      }
    } catch {
      // Another renderer window may not have initialized yet; keep checking.
    }
  }
  return null;
}

/** Feed trusted CLI/remote terminal bytes into renderer input arbitration. */
export async function notifySupervisorTerminalInput(
  targetSurfaceId: string,
  data: string,
  windows: GuardWindow[] = BrowserWindow.getAllWindows(),
): Promise<SupervisorTerminalInputResult> {
  const fallback = { handled: false, clearAutomatedDraft: false };
  if (!targetSurfaceId || !data) return fallback;

  for (const win of windows) {
    if (win.isDestroyed()) continue;
    try {
      const result = await withGuardTimeout(win.webContents.executeJavaScript(
        `window.__wmux_handleTerminalUserInput?.(${JSON.stringify(targetSurfaceId)}, ${JSON.stringify(data)})`,
      )) as Partial<SupervisorTerminalInputResult> | undefined;
      if (result?.handled || result?.clearAutomatedDraft) {
        return {
          handled: result.handled === true,
          clearAutomatedDraft: result.clearAutomatedDraft === true,
        };
      }
    } catch {
      // The target surface may be mounted in a different renderer window.
    }
  }
  return fallback;
}
