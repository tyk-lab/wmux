import { describe, expect, it } from 'vitest';
import { interactiveAgentExitDetail } from '../../src/renderer/utils/interactive-agent-runtime';

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
});
