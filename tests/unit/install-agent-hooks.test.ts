import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensurePiGitBashShell,
  formatInstallAgentHooksReport,
  type AgentHookInstallResult,
} from '../../src/main/install-agent-hooks';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('formatInstallAgentHooksReport', () => {
  it('prints ok/fail rows and notes', () => {
    const results: AgentHookInstallResult[] = [
      { id: 'kimi', label: 'Kimi Code', ok: true, path: '/x/settings.json', detail: 'updated' },
      { id: 'pi', label: 'Pi Agent', ok: true, path: '/x/wmux-agent-hooks.ts', detail: 'updated' },
      { id: 'codex', label: 'Codex CLI', ok: false, path: '/x/hooks.json', detail: 'boom' },
    ];
    const text = formatInstallAgentHooksReport(results);
    expect(text).toContain('[OK] Kimi Code');
    expect(text).toContain('[OK] Pi Agent');
    expect(text).toContain('[FAIL] Codex CLI');
    expect(text).toContain('/hooks');
    expect(text).toContain('Restart each agent');
  });
});

describe('supported hook installers', () => {
  it('does not configure Claude Code from either installer entry point', () => {
    const implementation = fs.readFileSync(
      path.resolve(__dirname, '../../src/main/install-agent-hooks.ts'),
      'utf8',
    );
    const powershellInstaller = fs.readFileSync(
      path.resolve(__dirname, '../../scripts/install-agent-hooks.ps1'),
      'utf8',
    );

    expect(implementation).not.toContain('ensureClaudeHooks');
    expect(implementation).not.toContain("safeRun('claude'");
    expect(powershellInstaller).not.toContain('~/.claude');
    expect(powershellInstaller).not.toContain('Claude Code');
  });
});

describe('ensurePiGitBashShell', () => {
  it('replaces the legacy WSL bash path and preserves other Pi settings', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pi-shell-'));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, 'settings.json');
    const gitBashPath = path.join(directory, 'Git', 'bin', 'bash.exe');
    fs.mkdirSync(path.dirname(gitBashPath), { recursive: true });
    fs.writeFileSync(gitBashPath, 'placeholder');
    fs.writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'k3', shellPath: 'C:\\Windows\\System32\\bash.exe' }));

    expect(ensurePiGitBashShell(settingsPath, gitBashPath, 'win32')).toContain('configured Git Bash');
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
      defaultModel: 'k3',
      shellPath: gitBashPath,
    });
  });

  it('preserves a valid user-configured Bash path', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pi-shell-'));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, 'settings.json');
    const customBashPath = path.join(directory, 'custom-bash.exe');
    const gitBashPath = path.join(directory, 'Git', 'bin', 'bash.exe');
    fs.mkdirSync(path.dirname(gitBashPath), { recursive: true });
    fs.writeFileSync(customBashPath, 'placeholder');
    fs.writeFileSync(gitBashPath, 'placeholder');
    fs.writeFileSync(settingsPath, JSON.stringify({ shellPath: customBashPath }));

    expect(ensurePiGitBashShell(settingsPath, gitBashPath, 'win32')).toContain('preserved existing');
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).shellPath).toBe(customBashPath);
  });
});
