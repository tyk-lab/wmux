/**
 * Absolute path to resources/cli/wmux-hook.js (outside the asar when packaged).
 * Node outside Electron cannot read asar, so hooks always point at this copy.
 */

import * as path from 'path';

export function resolveWmuxHookScriptPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'cli', 'wmux-hook.js');
    }
  } catch { /* tests / non-Electron */ }
  return path.resolve(path.join(__dirname, '../../resources/cli/wmux-hook.js'));
}

/** Forward-slash form for embedding in shell commands on Windows. */
export function resolveWmuxHookScriptPosix(): string {
  return resolveWmuxHookScriptPath().split(path.sep).join('/');
}

/**
 * Portable command for Claude/Codex/Grok-style hooks.
 * Always quote the path (user dirs often contain spaces). No bash redirects —
 * Windows cmd cannot parse `2>/dev/null || true`.
 */
export function makeWmuxHookEventCommand(hookScriptPosix: string, event: string): string {
  return `node "${hookScriptPosix}" --event ${event}`;
}

export function makeWmuxHookToolCommand(hookScriptPosix: string, tool: string): string {
  return `node "${hookScriptPosix}" ${tool}`;
}
