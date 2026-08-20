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
import { execFileSync } from 'child_process';
import { ensureKimiHooks, resolveKimiConfigPath } from './kimi-context';
import { ensureCodexHooks, resolveCodexHooksPath } from './codex-context';
import { ensureGrokHooks, resolveGrokWmuxHooksPath } from './grok-context';
import { ensureOpencodePlugin } from './opencode-context';
import { ensurePiHooks, resolvePiSettingsPath, resolvePiWmuxExtensionPath } from './pi-context';
import { resolveWmuxHookScriptPath } from './wmux-hook-path';

export interface AgentHookInstallResult {
  id: string;
  label: string;
  ok: boolean;
  path: string;
  detail: string;
}

export interface InstallAgentHooksOptions {
  /** Install OpenCode plugin as well (default true). */
  opencode?: boolean;
}

function isLegacyWslBashPath(shellPath: string): boolean {
  const normalized = shellPath.replace(/\//g, '\\').toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function resolveGitBashPath(): string | undefined {
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
  ].filter((candidate): candidate is string => !!candidate);
  try {
    const gitPath = execFileSync('where.exe', ['git.exe'], { encoding: 'utf-8', windowsHide: true, timeout: 3000 })
      .split(/\r?\n/)
      .find(Boolean);
    if (gitPath) candidates.push(path.resolve(path.dirname(gitPath), '..', 'bin', 'bash.exe'));
  } catch {
    // Git may not be installed; leave Pi's existing shell configuration alone.
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/** Prefer Git Bash for Pi on Windows without replacing a valid custom Bash setup. */
export function ensurePiGitBashShell(
  settingsPath = resolvePiSettingsPath(),
  gitBashPath = resolveGitBashPath(),
  platform = process.platform,
): string {
  if (platform !== 'win32') return 'not required on this platform';
  if (!gitBashPath) return 'Git Bash not found — shellPath unchanged';

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('settings must be a JSON object');
      }
      settings = parsed as Record<string, unknown>;
    } catch (err: any) {
      throw new Error(`cannot update Pi settings: ${err?.message || String(err)}`, { cause: err });
    }
  }

  const existingShellPath = typeof settings.shellPath === 'string' ? settings.shellPath.trim() : '';
  if (existingShellPath && fs.existsSync(existingShellPath) && !isLegacyWslBashPath(existingShellPath)) {
    return `preserved existing shellPath: ${existingShellPath}`;
  }
  if (existingShellPath === gitBashPath) return `using Git Bash: ${gitBashPath}`;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify({ ...settings, shellPath: gitBashPath }, null, 2)}\n`, 'utf-8');
  return `configured Git Bash: ${gitBashPath}`;
}

function safeRun(id: string, label: string, targetPath: string, fn: () => void | string): AgentHookInstallResult {
  try {
    const detail = fn();
    const exists = fs.existsSync(targetPath);
    return {
      id,
      label,
      ok: true,
      path: targetPath,
      detail: detail || (exists ? 'updated' : 'ran (path may be created on next agent launch)'),
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

  results.push(safeRun('kimi', 'Kimi Code', resolveKimiConfigPath(), () => ensureKimiHooks()));
  results.push(safeRun('codex', 'Codex CLI', resolveCodexHooksPath(), () => ensureCodexHooks()));
  results.push(safeRun('grok', 'Grok Build', resolveGrokWmuxHooksPath(), () => ensureGrokHooks()));
  results.push(safeRun('pi', 'Pi Agent', resolvePiWmuxExtensionPath(), () => ensurePiHooks()));
  results.push(safeRun('pi-shell', 'Pi Agent Bash', resolvePiSettingsPath(), () => {
    return ensurePiGitBashShell();
  }));

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
  lines.push('  - On Windows, Pi uses Git Bash when available; an existing valid shellPath is preserved.');
  lines.push('  - Run inside a wmux pane so WMUX_SURFACE_ID is set when agents fire hooks.');
  return lines.join('\n');
}
