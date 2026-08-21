import { describe, expect, it } from 'vitest';
import { parseWmuxHookPayload, stableWmuxHookId } from '../../src/cli/wmux-hook-payload';

describe('wmux Hook payload normalization', () => {
  it('parses Codex/Kimi snake_case payloads', () => {
    expect(parseWmuxHookPayload(JSON.stringify({
      session_id: 'session-1',
      turn_id: 'turn-1',
      user_prompt: '修复测试',
      cwd: 'D:/project',
      tool_input: { file_path: 'src/main.ts', command: 'npm test' },
    }))).toMatchObject({
      sessionId: 'session-1',
      turnId: 'turn-1',
      task: '修复测试',
      cwd: 'D:/project',
      file: 'src/main.ts',
      command: 'npm test',
    });
  });

  it('parses Grok camelCase and Pi-prefixed identities', () => {
    expect(parseWmuxHookPayload(JSON.stringify({
      sessionId: 'grok-session', turnId: 'grok-turn', userPrompt: '检查构建',
      toolInput: { filePath: 'src/app.ts' },
    }))).toMatchObject({
      sessionId: 'grok-session', turnId: 'grok-turn', task: '检查构建', file: 'src/app.ts',
    });
    expect(parseWmuxHookPayload(JSON.stringify({
      wmux_session_id: 'pi-session', wmux_turn_id: 'pi-turn', prompt: '运行测试',
    }))).toMatchObject({ sessionId: 'pi-session', turnId: 'pi-turn', task: '运行测试' });
  });

  it('deduplicates all terminal variants for one native turn but not its start', () => {
    const base = { agent: 'Pi', surfaceId: 'surface-1', sessionId: 'session-1', turnId: 'turn-1' };
    const stopped = stableWmuxHookId({ ...base, event: 'Stop' });

    expect(stopped).toBe(stableWmuxHookId({ ...base, event: 'StopFailure' }));
    expect(stopped).toBe(stableWmuxHookId({ ...base, event: 'Interrupt' }));
    expect(stopped).not.toBe(stableWmuxHookId({ ...base, event: 'UserPromptSubmit' }));
    expect(stableWmuxHookId({ ...base, event: 'PostToolUse' })).toBeUndefined();
  });
});
