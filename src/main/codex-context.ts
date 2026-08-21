/**
 * Codex CLI lifecycle hooks → wmux declared agent state.
 *
 * Codex discovers `~/.codex/hooks.json` using the nested lifecycle-hooks shape.
 * We merge wmux handlers without removing the user's other hooks. First launch
 * may require `/hooks` trust for non-managed commands — documented in README.
 *
 * Spec: https://developers.openai.com/codex/hooks (ChatGPT Learn docs).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { applyWmuxLifecycleHooks } from './lifecycle-hooks';
import { resolveWmuxHookScriptPosix } from './wmux-hook-path';

export function resolveCodexHome(homeDir = os.homedir()): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) return fromEnv;
  return path.join(homeDir, '.codex');
}

export function resolveCodexHooksPath(homeDir = os.homedir()): string {
  return path.join(resolveCodexHome(homeDir), 'hooks.json');
}

export function resolveCodexConfigPath(homeDir = os.homedir()): string {
  return path.join(resolveCodexHome(homeDir), 'config.toml');
}

function normalizeCodexProjectPath(projectPath: string): string {
  return path.win32.normalize(projectPath).replace(/\//g, '\\').toLowerCase();
}

function projectPathFromTableHeader(line: string): string | undefined {
  const match = /^\[projects\.(?:'([^']*)'|"((?:\\.|[^"])*)")\]\s*$/.exec(line.trim());
  if (!match) return undefined;
  if (match[1] !== undefined) return normalizeCodexProjectPath(match[1]);
  try {
    return normalizeCodexProjectPath(JSON.parse(`"${match[2]}"`));
  } catch {
    return undefined;
  }
}

/** Adds or updates one exact project trust entry without rewriting unrelated Codex settings. */
export function applyCodexProjectTrust(current: string, projectPath: string): string {
  const normalizedPath = normalizeCodexProjectPath(projectPath);
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current.replace(/\r\n/g, '\n').split('\n');
  const tableIndex = lines.findIndex((line) => projectPathFromTableHeader(line) === normalizedPath);

  if (tableIndex >= 0) {
    const nextTableIndex = lines.findIndex((line, index) => index > tableIndex && /^\s*\[/.test(line));
    const tableEnd = nextTableIndex >= 0 ? nextTableIndex : lines.length;
    const trustIndex = lines.findIndex((line, index) => (
      index > tableIndex && index < tableEnd && /^\s*trust_level\s*=/.test(line)
    ));
    if (trustIndex >= 0) {
      lines[trustIndex] = lines[trustIndex].replace(
        /^(\s*trust_level\s*=\s*)(?:"[^"]*"|'[^']*')(\s*(?:#.*)?)$/,
        '$1"trusted"$2',
      );
    } else {
      lines.splice(tableIndex + 1, 0, 'trust_level = "trusted"');
    }
    return lines.join(newline);
  }

  const separator = current.length === 0
    ? ''
    : current.endsWith('\n') || current.endsWith('\r') ? newline : `${newline}${newline}`;
  const header = `[projects.${JSON.stringify(normalizedPath)}]`;
  return `${current}${separator}${header}${newline}trust_level = "trusted"${newline}`;
}

/** Trusts the user-selected directory before launch; Codex still reviews every project-local Hook separately. */
export function ensureCodexProjectTrusted(projectPath: string, configPath = resolveCodexConfigPath()): void {
  const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
  const next = applyCodexProjectTrust(current, projectPath);
  if (next === current) return;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.wmux-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, next, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temporaryPath, configPath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** Pure merge for unit tests — returns the next hooks.json object. */
export function applyWmuxCodexHooks(existing: any, hookScriptPosix: string): any {
  const base = existing && typeof existing === 'object' ? existing : {};
  const withDesc = {
    description: base.description || 'Codex lifecycle hooks (wmux-managed entries use wmux-hook.js)',
    ...base,
    hooks: { ...(base.hooks || {}) },
  };
  return applyWmuxLifecycleHooks(withDesc, hookScriptPosix, undefined, 'Codex');
}

/**
 * Ensure `~/.codex/hooks.json` includes wmux turn-level hooks.
 * Creates the file when missing. Does not rewrite config.toml (hooks are on by default).
 */
export function ensureCodexHooks(): void {
  try {
    const hooksPath = resolveCodexHooksPath();
    const home = path.dirname(hooksPath);
    if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true });

    let existing: any = {};
    if (fs.existsSync(hooksPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      } catch {
        console.warn('[wmux] ~/.codex/hooks.json is not valid JSON — leaving it untouched');
        return;
      }
    }

    const hookScript = resolveWmuxHookScriptPosix();
    const next = applyWmuxCodexHooks(existing, hookScript);
    const prev = JSON.stringify(existing, null, 2);
    const serialized = JSON.stringify(next, null, 2) + '\n';
    if (serialized !== prev && serialized !== prev + '\n') {
      fs.writeFileSync(hooksPath, serialized, 'utf-8');
      console.log('[wmux] Configured Codex turn hooks in', hooksPath);
    }
  } catch (err) {
    console.warn('[wmux] Failed to update Codex hooks:', err);
  }
}
