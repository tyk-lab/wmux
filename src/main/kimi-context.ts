/**
 * Kimi Code CLI lifecycle hooks → wmux declared agent state.
 *
 * Kimi stores hooks in `~/.kimi-code/config.toml` as `[[hooks]]` array tables
 * (event / matcher / command / timeout). Payloads use the shared lifecycle JSON
 * on stdin, so we reuse `wmux-hook.js --event <Name>` and the shared
 * agent-hook-bridge mapping (UserPromptSubmit → working, Stop → idle, …).
 *
 * Config path matches current Kimi Code: `$KIMI_CODE_HOME` or
 * `~/.kimi-code/config.toml`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveWmuxHookScriptPosix } from './wmux-hook-path';

export const WMUX_KIMI_START = '# wmux-hooks:start';
export const WMUX_KIMI_END = '# wmux-hooks:end';

/** Turn-level + permission events supported by Kimi Code 0.38. */
export const KIMI_WMUX_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'PermissionRequest',
  'PermissionResult',
  'Stop',
  'StopFailure',
  'Interrupt',
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
 * Remove wmux hook tables written by older installers before managed markers
 * existed. User-owned Kimi hooks, including other Stop hooks, are preserved.
 */
export function stripLegacyWmuxKimiHookTables(existing: string): string {
  const lines = existing.replace(/\r\n/gu, '\n').split('\n');
  const output: string[] = [];
  const tableHeader = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/u;
  for (let index = 0; index < lines.length;) {
    if (!/^\s*\[\[hooks\]\]\s*$/u.test(lines[index])) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !tableHeader.test(lines[end])) end += 1;
    const table = lines.slice(index, end);
    const wmuxOwned = table.some((line) => (
      /^\s*command\s*=/u.test(line) && /wmux-hook[^"\r\n]*\.js/iu.test(line)
    ));
    if (!wmuxOwned) output.push(...table);
    index = end;
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n');
}

/**
 * Insert or replace the wmux-managed hooks block in an existing config.toml
 * body. Preserves all user content outside the markers.
 */
export function applyWmuxKimiHooksToml(existing: string, hookScript: string): string {
  const block = buildWmuxKimiHooksBlock(hookScript);
  const start = existing.indexOf(WMUX_KIMI_START);
  const end = existing.indexOf(WMUX_KIMI_END);
  let unmanaged = existing;
  if (start !== -1 && end !== -1 && end >= start) {
    unmanaged = `${existing.slice(0, start)}${existing.slice(end + WMUX_KIMI_END.length)}`;
  }
  const base = stripLegacyWmuxKimiHookTables(unmanaged).replace(/\s*$/u, '');
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
