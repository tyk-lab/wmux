/**
 * Install turn-level wmux hooks for every supported agent harness.
 *
 * Used by `wmux install-hooks` and `scripts/install-agent-hooks.*` so users can
 * re-run injection without restarting the Electron app. Each ensure* is
 * idempotent and preserves non-wmux user hooks where applicable.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureClaudeHooks } from './claude-context';
import { ensureKimiHooks, resolveKimiConfigPath } from './kimi-context';
import { ensureCodexHooks, resolveCodexHooksPath } from './codex-context';
import { ensureGrokHooks, resolveGrokWmuxHooksPath } from './grok-context';
import { ensureOpencodePlugin } from './opencode-context';
import { ensurePiHooks, resolvePiWmuxExtensionPath } from './pi-context';
import { resolveWmuxHookScriptPath } from './wmux-hook-path';

export interface AgentHookInstallResult {
  id: string;
  label: string;
  ok: boolean;
  path: string;
  detail: string;
}

export interface InstallAgentHooksOptions {
  /** When true (default for the install script), create empty Claude settings if missing. */
  createClaudeSettings?: boolean;
  /** Install OpenCode plugin as well (default true). */
  opencode?: boolean;
}

function claudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function ensureClaudeSettingsFile(): void {
  const settingsPath = claudeSettingsPath();
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, '{}\n', 'utf-8');
  }
}

function safeRun(id: string, label: string, targetPath: string, fn: () => void): AgentHookInstallResult {
  try {
    fn();
    const exists = fs.existsSync(targetPath);
    return {
      id,
      label,
      ok: true,
      path: targetPath,
      detail: exists ? 'updated' : 'ran (path may be created on next agent launch)',
    };
  } catch (err: any) {
    return {
      id,
      label,
      ok: false,
      path: targetPath,
      detail: err?.message || String(err),
    };
  }
}

/**
 * Install/refresh all agent lifecycle hooks.
 * Returns one result row per harness for CLI printing.
 */
export function installAllAgentHooks(opts: InstallAgentHooksOptions = {}): AgentHookInstallResult[] {
  const createClaude = opts.createClaudeSettings !== false;
  const withOpencode = opts.opencode !== false;
  const results: AgentHookInstallResult[] = [];

  // Verify the hook helper exists (packaged or repo resources/cli).
  const hookScript = resolveWmuxHookScriptPath();
  if (!fs.existsSync(hookScript)) {
    results.push({
      id: 'wmux-hook',
      label: 'wmux-hook.js',
      ok: false,
      path: hookScript,
      detail: 'hook helper missing — run from a built/packaged wmux tree',
    });
    return results;
  }

  results.push({
    id: 'wmux-hook',
    label: 'wmux-hook.js',
    ok: true,
    path: hookScript,
    detail: 'ok',
  });

  if (createClaude) {
    try { ensureClaudeSettingsFile(); } catch { /* ensureClaudeHooks will report */ }
  }
  results.push(safeRun('claude', 'Claude Code', claudeSettingsPath(), () => ensureClaudeHooks()));
  results.push(safeRun('kimi', 'Kimi Code', resolveKimiConfigPath(), () => ensureKimiHooks()));
  results.push(safeRun('codex', 'Codex CLI', resolveCodexHooksPath(), () => ensureCodexHooks()));
  results.push(safeRun('grok', 'Grok Build', resolveGrokWmuxHooksPath(), () => ensureGrokHooks()));
  results.push(safeRun('pi', 'Pi Agent', resolvePiWmuxExtensionPath(), () => ensurePiHooks()));

  if (withOpencode) {
    const pluginPath = path.join(os.homedir(), '.config', 'opencode', 'plugin', 'wmux.js');
    results.push(safeRun('opencode', 'OpenCode plugin', pluginPath, () => ensureOpencodePlugin()));
  }

  return results;
}

/** Format results for terminal output. */
export function formatInstallAgentHooksReport(results: AgentHookInstallResult[]): string {
  const lines = ['wmux agent hooks install', ''];
  for (const r of results) {
    const mark = r.ok ? 'OK' : 'FAIL';
    lines.push(`[${mark}] ${r.label}`);
    lines.push(`      ${r.path}`);
    lines.push(`      ${r.detail}`);
  }
  lines.push('');
  lines.push('Notes:');
  lines.push('  - Restart each agent session to load new hooks.');
  lines.push('  - Codex may require `/hooks` trust for wmux-hook commands.');
  lines.push('  - Run inside a wmux pane so WMUX_SURFACE_ID is set when agents fire hooks.');
  return lines.join('\n');
}
