import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Guards against runtime-referenced files missing from the packaged app.
 *
 * Supported agent integrations execute `node <resources>/cli/wmux-hook.js` in
 * installed builds. The script must
 * live OUTSIDE the asar (bare node can't read asar archives), i.e. it must be
 * listed in electron-builder extraResources. It was missing until v0.29.1:
 * hook events could otherwise fail silently and leave workspaces pinned on
 * "Running" while the agent idled.
 */
describe('electron-builder packaging', () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../electron-builder.json'), 'utf8'),
  );
  const extraResources: Array<{ from: string; to: string; filter?: string[] }> = config.extraResources;

  it('ships every compiled CLI module and its shared dependencies outside the asar', () => {
    expect(extraResources).toContainEqual({ from: 'dist/cli', to: 'cli', filter: ['*.js'] });
    expect(extraResources).toContainEqual({ from: 'dist/shared', to: 'shared', filter: ['*.js'] });
  });

  it('ships wmux-scoped Codex launchers for Windows and POSIX shells', () => {
    const cliBin = path.join(__dirname, '../../src/cli-bin');
    const posixLauncher = fs.readFileSync(path.join(cliBin, 'codex'), 'utf8');
    expect(posixLauncher).toContain('--enable hooks');
    expect(posixLauncher).toContain('--dangerously-bypass-hook-trust');
    const powershellLauncher = fs.readFileSync(path.join(cliBin, 'codex.ps1'), 'utf8');
    expect(powershellLauncher).toContain("@('--enable', 'hooks')");
    expect(powershellLauncher).toContain('--dangerously-bypass-hook-trust');
    const windowsLauncher = fs.readFileSync(path.join(cliBin, 'codex.cmd'), 'utf8');
    expect(windowsLauncher).toContain('codex.ps1');
    expect(windowsLauncher).not.toContain('WMUX_CODEX_ARGS');
  });

  it.runIf(process.platform === 'win32')('applies wmux-scoped Codex hook trust on Windows', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-shim-'));
    const fakeBin = path.join(directory, 'bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, 'codex.ps1'),
      'Write-Output (ConvertTo-Json -Compress -InputObject @($args))\r\n',
      'utf8',
    );

    try {
      const cliBin = path.join(__dirname, '../../src/cli-bin');
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const executablePath = [cliBin, fakeBin, path.join(systemRoot, 'System32')].join(path.delimiter);
      const env = { ...process.env };
      for (const name of Object.keys(env)) {
        if (name.toLowerCase() === 'path') delete env[name];
      }
      env.PATH = executablePath;

      const runLauncher = (args = '') => spawnSync(
        process.env.ComSpec || path.join(systemRoot, 'System32', 'cmd.exe'),
        ['/d', '/s', '/c', `codex.cmd ${args} <nul`],
        { encoding: 'utf8', env },
      );
      const runPowerShellLauncher = (args: string[]) => spawnSync(
        path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
          '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(cliBin, 'codex.ps1'),
          ...args,
        ],
        { encoding: 'utf8', env },
      );

      const defaults = runLauncher();
      expect(defaults.status, defaults.stderr).toBe(0);
      expect(JSON.parse(defaults.stdout)).toEqual(['--dangerously-bypass-hook-trust', '--enable', 'hooks']);

      const enabled = runLauncher('--enable hooks');
      expect(enabled.status, enabled.stderr).toBe(0);
      expect(JSON.parse(enabled.stdout)).toEqual(['--dangerously-bypass-hook-trust', '--enable', 'hooks']);

      const disabled = runLauncher('--disable hooks');
      expect(disabled.status, disabled.stderr).toBe(0);
      expect(JSON.parse(disabled.stdout)).toEqual(['--disable', 'hooks']);

      const sshPrompt = runLauncher('--config history.persistence=none "send <missing-file>"');
      expect(sshPrompt.status, sshPrompt.stderr).toBe(0);
      expect(sshPrompt.stderr).not.toContain('The system cannot find the file specified.');

      const powershellSshPrompt = runPowerShellLauncher([
        '--config', 'history.persistence=none', 'send <missing-file>',
      ]);
      expect(powershellSshPrompt.status, powershellSshPrompt.stderr).toBe(0);
      expect(JSON.parse(powershellSshPrompt.stdout)).toEqual([
        '--dangerously-bypass-hook-trust', '--enable', 'hooks',
        '--config', 'history.persistence=none', 'send <missing-file>',
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ships generic agent instructions without Claude-only resources', () => {
    expect(extraResources).toContainEqual({
      from: 'resources/agent-instructions.md',
      to: 'agent-instructions/agent-instructions.md',
    });
    expect(extraResources.some(({ from }) => from.includes('claude'))).toBe(false);
    expect(extraResources.some(({ from }) => from.includes('wmux-orchestrator'))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '../../resources/agent-instructions.md'))).toBe(true);
  });

  it('ships application-owned project and supervisor role instructions outside the asar', () => {
    expect(extraResources).toContainEqual({ from: 'resources/agents', to: 'agents' });
    expect(fs.existsSync(path.join(
      __dirname,
      '../../resources/agents/project-ai/ROLE_AGENTS.md',
    ))).toBe(true);
    expect(fs.existsSync(path.join(
      __dirname,
      '../../resources/agents/supervisor-ai/ROLE_AGENTS.md',
    ))).toBe(true);
  });

  it('does not ship managed role instructions as an agent skill', () => {
    expect(fs.existsSync(path.join(
      __dirname,
      '../../resources/skills/manage-project/SKILL.md',
    ))).toBe(false);
    expect(fs.existsSync(path.join(
      __dirname,
      '../../resources/prompts/supervisor-protocol.md',
    ))).toBe(false);
  });

  it('keeps installer-only main-process modules out of normal CLI startup', () => {
    const cliSource = fs.readFileSync(path.join(__dirname, '../../src/cli/wmux.ts'), 'utf8');
    expect(cliSource).not.toMatch(/^import[\s\S]*?from '\.\.\/main\/install-agent-hooks';/m);
    expect(cliSource).toContain("require('../main/install-agent-hooks')");
  });

});
