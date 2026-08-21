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

  it('passes the configured model to task Agent launch commands', () => {
    expect(buildInteractiveAgentLaunch('codex', '执行首条任务', 'gpt-5.6-terra').startupCommands[0])
      .toMatch(/^codex --model 'gpt-5\.6-terra' -- /);
    expect(buildInteractiveAgentLaunch('kimi', '执行首条任务', 'k3')).toEqual({
      startupCommands: ["kimi --model 'kimi-code/k3' # wmux-automated-agent-task"],
      startupInput: '执行首条任务',
    });
  });

  it('passes launcher-specific reasoning settings to interactive task Agents', () => {
    expect(buildInteractiveAgentLaunch('codex', '执行首条任务', 'gpt-5.6-sol', 'high').startupCommands[0])
      .toMatch(/^codex --model 'gpt-5\.6-sol' --config model_reasoning_effort='high' -- /);
    expect(buildInteractiveAgentLaunch('kimi', '执行首条任务', 'k3', 'on')).toEqual({
      startupCommands: ["kimi --model 'kimi-code/k3' # wmux-automated-agent-task"],
      startupInput: '执行首条任务',
    });
    expect(buildInteractiveAgentLaunch('grok', '执行首条任务', 'grok-4.6', 'medium').startupCommands[0])
      .toMatch(/^grok -m 'grok-4\.6' --reasoning-effort 'medium' -- /);
  });

  it('never bypasses Codex Hook trust for automated runtimes', () => {
    const managedCodex = buildInteractiveAgentLaunch('codex', '启动项目 AI');
    const ordinaryCodex = buildInteractiveAgentLaunch('codex', '启动普通任务');
    const grok = buildInteractiveAgentLaunch('grok', '启动项目 AI');

    expect(managedCodex.startupCommands[0]).toMatch(/^codex -- \(ConvertFrom-Json /);
    expect(managedCodex.startupCommands[0]).not.toContain('bypass-hook-trust');
    expect(ordinaryCodex.startupCommands[0]).not.toContain('bypass-hook-trust');
    expect(grok.startupCommands[0]).not.toContain('bypass-hook-trust');
  });

  it('detects only wmux automated task-Agent startup flows', () => {
    const codex = buildInteractiveAgentLaunch('codex', '执行首条任务');
    const kimi = buildInteractiveAgentLaunch('kimi', '执行首条任务');
    const grok = buildInteractiveAgentLaunch('grok', '执行首条任务');

    expect(detectAutomatedInteractiveAgent(codex.startupCommands, codex.startupInput)).toBe('codex');
    expect(detectAutomatedInteractiveAgent(kimi.startupCommands, kimi.startupInput)).toBe('kimi');
    expect(detectAutomatedInteractiveAgent(grok.startupCommands, grok.startupInput)).toBe('grok');
    expect(detectAutomatedInteractiveAgent(['codex'], undefined)).toBeUndefined();
    expect(detectAutomatedInteractiveAgent(['grok'], undefined)).toBeUndefined();
    expect(detectAutomatedInteractiveAgent(['kimi'], undefined)).toBeUndefined();
    expect(detectAutomatedInteractiveAgent(['kimi'], 'SSH 自动控制说明')).toBeUndefined();
  });

  it('detects all managed Agents inside wmux isolated supervisor launch commands', () => {
    const prelude = "$wmuxSupervisorRuntimeDir = 'C:\\runtime'; Set-Location $wmuxSupervisorRuntimeDir; ";
    expect(detectAutomatedInteractiveAgent([`${prelude}codex --model gpt-5`], undefined)).toBe('codex');
    expect(detectAutomatedInteractiveAgent([`${prelude}kimi --model k3`], undefined)).toBe('kimi');
    expect(detectAutomatedInteractiveAgent([`${prelude}grok -m grok-4.6`], undefined)).toBe('grok');
    expect(detectAutomatedInteractiveAgent([`${prelude}pi --model openai/gpt-5`], undefined)).toBe('pi');
    expect(detectAutomatedInteractiveAgent([`${prelude}& "C:\\Tools\\codex.exe"`], undefined)).toBe('codex');
  });
});
