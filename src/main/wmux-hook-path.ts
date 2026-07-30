/**
 * Absolute path to wmux-hook.js (outside the asar when packaged).
 * Node outside Electron cannot read asar, so hooks always point at this copy.
 */

import * as fs from 'fs';
import * as path from 'path';

export function resolveWmuxHookScriptPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'cli', 'wmux-hook.js');
    }
  } catch { /* tests / non-Electron */ }

  // Dev / install-hooks: prefer compiled dist/cli next to main, then resources/.
  const fromDist = path.resolve(path.join(__dirname, '../cli/wmux-hook.js'));
  if (fs.existsSync(fromDist)) return fromDist;
  return path.resolve(path.join(__dirname, '../../resources/cli/wmux-hook.js'));
}

/** Forward-slash form for embedding in shell commands on Windows. */
export function resolveWmuxHookScriptPosix(): string {
  return resolveWmuxHookScriptPath().split(path.sep).join('/');
}

/**
 * Portable command for Claude/Codex/Grok/Kimi-style hooks.
 * Always quote the path (user dirs often contain spaces). No bash redirects —
 * Windows cmd cannot parse `2>/dev/null || true`.
 *
 * `agent` is written into every harness install so notifications can say
 * "Turn complete · Kimi" without guessing from the cwd folder name.
 */
export function makeWmuxHookEventCommand(
  hookScriptPosix: string,
  event: string,
  agent?: string,
): string {
  const agentFlag = agent?.trim() ? ` --agent ${shellQuoteArg(agent.trim())}` : '';
  return `node "${hookScriptPosix}" --event ${event}${agentFlag}`;
}

export function makeWmuxHookToolCommand(
  hookScriptPosix: string,
  tool: string,
  agent?: string,
): string {
  const agentFlag = agent?.trim() ? ` --agent ${shellQuoteArg(agent.trim())}` : '';
  return `node "${hookScriptPosix}" ${tool}${agentFlag}`;
}

/** Quote a single argv token for cmd/sh when it has spaces (agent names are simple). */
function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
