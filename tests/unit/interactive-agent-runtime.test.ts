import { describe, expect, it } from 'vitest';
import {
  interactiveAgentExitDetail,
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
});
