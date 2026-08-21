import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPiWmuxExtension,
  ensurePiHooks,
  resolvePiAgentDir,
  resolvePiWmuxExtensionPath,
  WMUX_PI_EXTENSION_MARKER,
} from '../../src/main/pi-context';

const HOOK = 'C:\\wmux build\\resources\\cli\\wmux-hook.js';

describe('Pi Agent wmux hooks', () => {
  it('resolves the default and overridden global extension directory', () => {
    expect(resolvePiAgentDir('C:\\Users\\tester', {})).toBe(path.join('C:\\Users\\tester', '.pi', 'agent'));
    expect(resolvePiAgentDir('C:\\Users\\tester', { PI_CODING_AGENT_DIR: 'D:\\pi-home' })).toBe('D:\\pi-home');
    expect(resolvePiWmuxExtensionPath('C:\\Users\\tester', {})).toBe(
      path.join('C:\\Users\\tester', '.pi', 'agent', 'extensions', 'wmux-agent-hooks.ts'),
    );
  });

  it('maps Pi lifecycle and tool events onto the wmux Hook protocol', () => {
    const source = buildPiWmuxExtension(HOOK);

    expect(source).toContain(WMUX_PI_EXTENSION_MARKER);
    expect(source).toContain('pi.on("input"');
    expect(source).toContain('event.source === "extension"');
    expect(source).toContain('before_agent_start');
    expect(source).toContain('UserPromptSubmit');
    expect(source).toContain('wmux_session_id');
    expect(source).toContain('wmux_turn_id');
    expect(source).toContain('const WMUX_SESSION_ID = String(process.pid) + "-" + Date.now()');
    expect(source).toContain('tool_result');
    expect(source).toContain('PreToolUse');
    expect(source).toContain('PostToolUse');
    expect(source).toContain('agent_settled');
    expect(source).toContain('session_shutdown');
    expect(source).toContain('if (currentTurnId) sendWmuxEvent("Interrupt"');
    expect(source).toContain('args.push("--tool", toolName)');
    expect(source).toContain('if (toolName === "edit") return "Edit"');
    expect(source).toContain('if (toolName === "write") return "Write"');
    expect(source).toContain('"--agent", "Pi"');
    expect(source).toContain('C:/wmux build/resources/cli/wmux-hook.js');
  });

  it('installs idempotently and refuses to replace an unmanaged Pi extension', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pi-hooks-'));
    const extensionPath = path.join(directory, 'extensions', 'wmux-agent-hooks.ts');
    try {
      ensurePiHooks(extensionPath, HOOK);
      const installed = fs.readFileSync(extensionPath, 'utf-8');
      ensurePiHooks(extensionPath, HOOK);
      expect(fs.readFileSync(extensionPath, 'utf-8')).toBe(installed);

      fs.writeFileSync(extensionPath, `${WMUX_PI_EXTENSION_MARKER}\n// wmux-pi-extension-version: 0\n`, 'utf-8');
      ensurePiHooks(extensionPath, HOOK);
      expect(fs.readFileSync(extensionPath, 'utf-8')).toBe(installed);

      fs.writeFileSync(extensionPath, 'export default function userExtension() {}\n', 'utf-8');
      expect(() => ensurePiHooks(extensionPath, HOOK)).toThrow('refusing to overwrite unmanaged Pi extension');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
