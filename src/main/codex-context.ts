/**
 * Codex CLI lifecycle hooks → wmux declared agent state.
 *
 * Codex discovers `~/.codex/hooks.json` (same nested shape as Claude settings).
 * We merge wmux handlers without removing the user's other hooks. First launch
 * may require `/hooks` trust for non-managed commands — documented in README.
 *
 * Spec: https://developers.openai.com/codex/hooks (ChatGPT Learn docs).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { applyWmuxLifecycleHooks } from './claude-style-hooks';
import { resolveWmuxHookScriptPosix } from './wmux-hook-path';

export function resolveCodexHome(homeDir = os.homedir()): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) return fromEnv;
  return path.join(homeDir, '.codex');
}

export function resolveCodexHooksPath(homeDir = os.homedir()): string {
  return path.join(resolveCodexHome(homeDir), 'hooks.json');
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
