import { describe, expect, it } from 'vitest';
import {
  interactiveAgentExitDetail,
  interactiveAgentInputReady,
  interactiveAgentShellPromptFailureDetail,
  interactiveAgentStartupDiagnostic,
  interactiveAgentStartupFailureDetail,
} from '../../src/renderer/utils/interactive-agent-runtime';

describe('interactive Agent runtime detection', () => {
  it('detects a Codex exit even when the outer shell remains alive', () => {
    const output = [
      'Token usage: total=60,335',
      'To continue this session, run codex resume 01a014d1-c1d6-7363-92dd-c68642fbf1d4',
      'PS C:\\Users\\tester\\AppData\\Roaming\\wmux\\project-manager\\runtime>',
    ].join('\r\n');

    expect(interactiveAgentExitDetail('codex', output)).toContain('Codex Agent 已退出');
  });

  it('handles ANSI sequences and output split across PTY chunks', () => {
    let tail = '\x1b[2mToken usage: total=12,345\r\nTo continue this session, run codex ';
    expect(interactiveAgentExitDetail('codex', tail)).toBeNull();

    tail += 'resume 01a014d1-c1d6-7363-92dd-c68642fbf1d4\x1b[0m';
    expect(interactiveAgentExitDetail('codex', tail)).not.toBeNull();
  });

  it('does not treat normal turn completion or another Agent output as an exit', () => {
    expect(interactiveAgentExitDetail('codex', 'Task complete. Waiting for the next prompt.')).toBeNull();
    expect(interactiveAgentExitDetail('codex', 'Run codex resume 01a014d1-c1d6-7363-92dd-c68642fbf1d4 if needed.')).toBeNull();
    expect(interactiveAgentExitDetail('kimi', 'Token usage: total=1\nTo continue this session, run codex resume 01a014d1-c1d6-7363-92dd-c68642fbf1d4')).toBeNull();
  });

  it('detects an unsupported startup option before a shell can receive the task prompt', () => {
    expect(interactiveAgentStartupFailureDetail("error: unknown option '--thinking'"))
      .toBe("Agent 启动失败：error: unknown option '--thinking'");
    expect(interactiveAgentStartupFailureDetail('Welcome to Kimi Code!')).toBeNull();
  });

  it('treats a rejected Kimi trust prompt as startup failure', () => {
    expect(interactiveAgentStartupFailureDetail('Bye!\nPS C:\\runtime>'))
      .toBe('Agent 启动失败：目录信任未获确认，Agent 已退出');
  });

  it('detects a Kimi session creation failure before accepting startup input', () => {
    expect(interactiveAgentStartupFailureDetail(
      'Error: Failed to start a session: Model "k3-256k" is not configured in config.toml.',
    )).toBe(
      'Agent 启动失败：Error: Failed to start a session: Model "k3-256k" is not configured in config.toml.',
    );
  });

  it('detects ordinary shell startup failures with ANSI and split output', () => {
    expect(interactiveAgentStartupFailureDetail('\u001b[31mParserError:\u001b[0m Missing an argument for parameter.'))
      .toContain('ParserError');
    expect(interactiveAgentStartupFailureDetail("foo : The term 'foo' is not recognized as the name of a cmdlet"))
      .toContain('not recognized');
    expect(interactiveAgentStartupFailureDetail('/bin/sh: agent: command not found'))
      .toContain('command not found');
  });

  it('rejects an outer shell prompt before a control message can be executed as a command', () => {
    expect(interactiveAgentShellPromptFailureDetail(
      'PS C:\\Users\\tester\\AppData\\Roaming\\wmux\\supervisor\\runtime>',
    )).toContain('外层 Shell 提示符');
    expect(interactiveAgentShellPromptFailureDetail('C:\\runtime>')).toContain('外层 Shell 提示符');
    expect(interactiveAgentShellPromptFailureDetail('tester@host:/workspace$')).toContain('外层 Shell 提示符');
    expect(interactiveAgentShellPromptFailureDetail('OpenAI Codex\nmodel: gpt-5.6-terra')).toBeNull();
  });

  it('requires recognizable Agent input chrome instead of generic shell output', () => {
    expect(interactiveAgentInputReady('PS C:\\runtime>')).toBe(false);
    expect(interactiveAgentInputReady('PowerShell 7.5\nCopyright Microsoft Corporation')).toBe(false);
    expect(interactiveAgentInputReady('gpt-5.6-terra medium\nAsk Codex to do anything')).toBe(true);
    expect(interactiveAgentInputReady([
      '─ Worked for 1m 30s ─',
      '',
      '› Ask Codex to do anything',
      '',
      '  gpt-5.6-terra medium · ~\\AppData\\Roaming\\wmux\\supervisor\\runtime',
    ].join('\n'))).toBe(true);
    expect(interactiveAgentInputReady(
      '  gpt-5.6-terra medium · ~\\AppData\\Roaming\\wmux\\supervisor\\runtime',
    )).toBe(true);
    expect(interactiveAgentInputReady('Kimi Code\nNo session yet — send your first message')).toBe(true);
    expect(interactiveAgentInputReady('Grok Build 1.0.5\nNew worktree\nCtrl+O')).toBe(true);
    expect(interactiveAgentInputReady('Pi Agent\nAsk anything')).toBe(true);
    expect(interactiveAgentInputReady('pi v0.48.2\nctrl+c/ctrl+d clear/exit · / commands\nPi can explain its own features')).toBe(true);
  });

  it('keeps raw Codex readiness evidence when the current xterm screen contains only blank rows', () => {
    const rawOutput = [
      '╭────────────────────────────────────────╮',
      '│ >_ OpenAI Codex (v0.149.0)             │',
      '╰────────────────────────────────────────╯',
      '› Ask Codex to do anything',
      'gpt-5.6-terra medium · ~\\AppData\\Roaming\\wmux\\supervisor\\runtime',
    ].join('\n');

    expect(interactiveAgentInputReady(`${rawOutput}\n${'\n'.repeat(29)}`)).toBe(true);
  });

  it('records only structural startup diagnostics without leaking paths or task text', () => {
    const diagnostic = interactiveAgentStartupDiagnostic([
      '执行敏感项目任务',
      '› Ask Codex to do anything',
      'gpt-5.6-terra medium · C:\\Users\\tester\\secret-project',
    ].join('\n'));

    expect(diagnostic).toContain('markers=ask-codex,gpt-model');
    expect(diagnostic).not.toContain('敏感项目任务');
    expect(diagnostic).not.toContain('secret-project');
  });

  it('recognizes a project protocol already pasted after the PowerShell prompt', () => {
    const contaminated = [
      'PS C:\\Users\\tester\\AppData\\Roaming\\wmux\\supervisor\\runtime> e> [目标任务终端和项目指令协议正文]',
      '项目目标：实现功能',
    ].join('\n');
    expect(interactiveAgentShellPromptFailureDetail(contaminated)).toContain('外层 Shell 提示符');
    expect(interactiveAgentInputReady(`OpenAI Codex\n${contaminated}`)).toBe(false);
  });
});
