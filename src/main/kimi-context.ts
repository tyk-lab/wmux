/**
 * Kimi Code CLI lifecycle hooks → wmux declared agent state.
 *
 * Kimi stores hooks in `~/.kimi-code/config.toml` as `[[hooks]]` array tables
 * (event / matcher / command / timeout). Payloads are Claude-compatible JSON
 * on stdin, so we reuse `wmux-hook.js --event <Name>` and the shared
 * agent-hook-bridge mapping (UserPromptSubmit → working, Stop → idle, …).
 *
 * Config path matches Kimi 0.30: `$KIMI_CODE_HOME` or `~/.kimi-code/config.toml`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveWmuxHookScriptPosix } from './wmux-hook-path';

export const WMUX_KIMI_START = '# wmux-hooks:start';
export const WMUX_KIMI_END = '# wmux-hooks:end';

/** Turn-level + permission events Kimi documents (0.30 HOOK_EVENT_TYPES). */
export const KIMI_WMUX_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PostToolUse',
  'Notification',
  'PermissionRequest',
  'PermissionResult',
  'Stop',
  'StopFailure',
  'SubagentStop',
] as const;

export function resolveKimiHome(homeDir = os.homedir()): string {
  const fromEnv = process.env.KIMI_CODE_HOME?.trim();
  if (fromEnv) return fromEnv;
  return path.join(homeDir, '.kimi-code');
}

export function resolveKimiConfigPath(homeDir = os.homedir()): string {
  return path.join(resolveKimiHome(homeDir), 'config.toml');
}

/** Escape a string for double-quoted TOML. */
export function tomlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Portable hook command: always quote the script path (Windows user dirs
 * often contain spaces). No bash redirects — Kimi uses shell:true → cmd.exe.
 * `--agent Kimi` so notifications do not guess from the cwd folder name.
 */
export function makeKimiHookCommand(hookScript: string, event: string): string {
  const script = hookScript.split(path.sep).join('/');
  return `node "${script}" --event ${event} --agent Kimi`;
}

/** Build the managed `[[hooks]]` block (pure, unit-tested). */
export function buildWmuxKimiHooksBlock(hookScript: string): string {
  const lines: string[] = [
    WMUX_KIMI_START,
    '# Managed by wmux — do not edit between these markers',
  ];
  for (const event of KIMI_WMUX_HOOK_EVENTS) {
    lines.push('[[hooks]]');
    lines.push(`event = "${event}"`);
    lines.push(`command = ${tomlQuote(makeKimiHookCommand(hookScript, event))}`);
    lines.push('timeout = 10');
    lines.push('');
  }
  lines.push(WMUX_KIMI_END);
  return lines.join('\n');
}

/**
 * Insert or replace the wmux-managed hooks block in an existing config.toml
 * body. Preserves all user content outside the markers.
 */
export function applyWmuxKimiHooksToml(existing: string, hookScript: string): string {
  const block = buildWmuxKimiHooksBlock(hookScript);
  const start = existing.indexOf(WMUX_KIMI_START);
  const end = existing.indexOf(WMUX_KIMI_END);

  if (start !== -1 && end !== -1 && end >= start) {
    let after = existing.slice(end + WMUX_KIMI_END.length);
    if (after.startsWith('\r\n')) after = after.slice(2);
    else if (after.startsWith('\n')) after = after.slice(1);
    const before = existing.slice(0, start).replace(/[ \t\r\n]+$/u, '');
    const head = before ? `${before}\n\n` : '';
    const tail = after.replace(/^\s*/u, '');
    return `${head}${block}${tail ? `\n${tail}` : '\n'}`;
  }

  const base = existing.replace(/\s*$/u, '');
  if (!base) return `${block}\n`;
  return `${base}\n\n${block}\n`;
}

/**
 * Ensure `~/.kimi-code/config.toml` has wmux turn-level hooks.
 * Creates the home dir + file when missing so first Kimi launch picks them up.
 */
export function ensureKimiHooks(): void {
  try {
    const configPath = resolveKimiConfigPath();
    const home = path.dirname(configPath);
    if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true });

    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
    const hookScript = resolveWmuxHookScriptPosix();
    const next = applyWmuxKimiHooksToml(existing, hookScript);
    if (next !== existing) {
      fs.writeFileSync(configPath, next, 'utf-8');
      console.log('[wmux] Configured Kimi turn hooks in', configPath);
    }
  } catch (err) {
    console.warn('[wmux] Failed to update Kimi hooks:', err);
  }
}
