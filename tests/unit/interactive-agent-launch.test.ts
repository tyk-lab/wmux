import { describe, expect, it } from 'vitest';
import {
  buildInteractiveAgentLaunch,
  detectAutomatedInteractiveAgent,
} from '../../src/renderer/utils/interactive-agent-launch';

describe('interactive Agent launch', () => {
  it.each(['codex', 'grok'] as const)('passes the initial %s prompt in the launch command', (agent) => {
    const prompt = "检查第一行\n修复用户的 '登录' 流程";
    const launch = buildInteractiveAgentLaunch(agent, prompt);

    expect(launch.startupCommands).toHaveLength(1);
    expect(launch.startupCommands[0]).toMatch(new RegExp(`^${agent} -- \\(ConvertFrom-Json '`));
    expect(launch.startupCommands[0]).not.toContain('\n');
    expect(launch.startupCommands[0]).toContain("''登录''");
    expect(launch.startupInput).toBeUndefined();
  });

  it('keeps Kimi on the checked interactive-input path', () => {
    expect(buildInteractiveAgentLaunch('kimi', '执行首条任务')).toEqual({
      startupCommands: ['kimi # wmux-automated-agent-task'],
      startupInput: '执行首条任务',
    });
  });

  it('detects only wmux automated Codex and Kimi startup flows', () => {
    const codex = buildInteractiveAgentLaunch('codex', '执行首条任务');
    const kimi = buildInteractiveAgentLaunch('kimi', '执行首条任务');

    expect(detectAutomatedInteractiveAgent(codex.startupCommands, codex.startupInput)).toBe('codex');
    expect(detectAutomatedInteractiveAgent(kimi.startupCommands, kimi.startupInput)).toBe('kimi');
    expect(detectAutomatedInteractiveAgent(['codex'], undefined)).toBeUndefined();
    expect(detectAutomatedInteractiveAgent(['kimi'], undefined)).toBeUndefined();
    expect(detectAutomatedInteractiveAgent(['kimi'], 'SSH 自动控制说明')).toBeUndefined();
  });
});
