/**
 * Grok Build CLI lifecycle hooks → wmux declared agent state.
 *
 * Grok loads global hooks from `~/.grok/hooks/*.json` (always trusted).
 * We write a dedicated `wmux.json` file (overwrite when content changes) so we
 * never edit the user's other hook files.
 *
 * Events match Grok's published table. StopCancelled is normalized to wmux's
 * Interrupt event so Esc/Ctrl+C and rejected permission end the active turn.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildWmuxHooksJsonFile } from './lifecycle-hooks';
import { resolveWmuxHookScriptPosix } from './wmux-hook-path';

export const GROK_WMUX_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'StopFailure',
  { hookEvent: 'StopCancelled', protocolEvent: 'Interrupt' },
  'SubagentStop',
] as const;

export function resolveGrokHome(homeDir = os.homedir()): string {
  const fromEnv = process.env.GROK_HOME?.trim();
  if (fromEnv) return fromEnv;
  return path.join(homeDir, '.grok');
}

export function resolveGrokWmuxHooksPath(homeDir = os.homedir()): string {
  return path.join(resolveGrokHome(homeDir), 'hooks', 'wmux.json');
}

/** Pure builder for unit tests. */
export function buildGrokWmuxHooksFile(hookScriptPosix: string): any {
  return buildWmuxHooksJsonFile(
    hookScriptPosix,
    'wmux agent lifecycle (managed — edit via wmux, not by hand)',
    GROK_WMUX_HOOK_EVENTS,
    'Grok',
  );
}

/** Ensure `~/.grok/hooks/wmux.json` is installed and up to date. */
export function ensureGrokHooks(): void {
  try {
    const hooksPath = resolveGrokWmuxHooksPath();
    const dir = path.dirname(hooksPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const hookScript = resolveWmuxHookScriptPosix();
    const next = buildGrokWmuxHooksFile(hookScript);
    const serialized = JSON.stringify(next, null, 2) + '\n';
    const existing = fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath, 'utf-8') : '';
    if (existing !== serialized) {
      fs.writeFileSync(hooksPath, serialized, 'utf-8');
      console.log('[wmux] Configured Grok turn hooks in', hooksPath);
    }
  } catch (err) {
    console.warn('[wmux] Failed to update Grok hooks:', err);
  }
}
