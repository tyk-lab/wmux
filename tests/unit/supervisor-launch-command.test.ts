import { describe, expect, it } from 'vitest';
import {
  buildSupervisorLaunchCommand,
  detectSupervisorLauncher,
  supervisorLauncherDisplayName,
} from '../../src/renderer/supervisor/launch-command';

describe('supervisor launch command', () => {
  it('adds the selected model to a Codex launcher', () => {
    expect(buildSupervisorLaunchCommand('codex', 'gpt-5.6-sol'))
      .toBe("codex --model 'gpt-5.6-sol'");
  });

  it('adds the selected reasoning effort as a one-session Codex override', () => {
    expect(buildSupervisorLaunchCommand('codex', 'gpt-5.6-sol', 'high'))
      .toBe("codex --model 'gpt-5.6-sol' --config model_reasoning_effort='high'");
  });

  it('keeps an explicitly configured reasoning effort unchanged', () => {
    expect(buildSupervisorLaunchCommand('codex -c model_reasoning_effort=medium', '', 'high'))
      .toBe('codex -c model_reasoning_effort=medium');
  });

  it('supports a quoted PowerShell Codex executable path', () => {
    expect(buildSupervisorLaunchCommand('& "C:\\Tools\\codex.exe"', 'gpt-5.6-terra'))
      .toBe("& \"C:\\Tools\\codex.exe\" --model 'gpt-5.6-terra'");
  });

  it('keeps an explicitly configured Codex model unchanged', () => {
    expect(buildSupervisorLaunchCommand('codex --model gpt-5.6-terra', 'gpt-5.6-sol'))
      .toBe('codex --model gpt-5.6-terra');
  });

  it('adds a selected Kimi model and Thinking flag', () => {
    expect(buildSupervisorLaunchCommand('kimi', 'k3', 'on'))
      .toBe("kimi --model 'k3' --thinking");
  });

  it('adds a selected Grok model with the Grok Build CLI short flag', () => {
    expect(buildSupervisorLaunchCommand('grok', 'grok-4.6', 'high'))
      .toBe("grok -m 'grok-4.6' --reasoning-effort 'high'");
  });

  it('keeps an explicitly configured Grok reasoning effort unchanged', () => {
    expect(buildSupervisorLaunchCommand('grok --effort low', 'grok-4.6', 'high'))
      .toBe("grok --effort low -m 'grok-4.6'");
  });

  it('migrates obsolete Grok model IDs before launching', () => {
    expect(buildSupervisorLaunchCommand('grok', 'grok-build'))
      .toBe("grok -m 'grok-4.6'");
    expect(buildSupervisorLaunchCommand('pi', 'xai/grok-build-0.1', 'medium'))
      .toBe("pi --model 'xai/grok-4.6' --thinking 'medium'");
  });

  it('adds the selected Pi model and Thinking level', () => {
    expect(buildSupervisorLaunchCommand('pi', 'openai-codex/gpt-5.5', 'high'))
      .toBe("pi --model 'openai-codex/gpt-5.5' --thinking 'high'");
  });

  it('qualifies built-in Pi models with their providers', () => {
    expect(buildSupervisorLaunchCommand('pi', 'gpt-5.6-terra', 'medium'))
      .toBe("pi --model 'openai-codex/gpt-5.6-terra' --thinking 'medium'");
    expect(buildSupervisorLaunchCommand('pi', 'k3', 'medium'))
      .toBe("pi --model 'kimi-coding/k3' --thinking 'medium'");
    expect(buildSupervisorLaunchCommand('pi', 'grok-4.5', 'medium'))
      .toBe("pi --model 'xai/grok-4.5' --thinking 'medium'");
    expect(buildSupervisorLaunchCommand('pi', 'grok-4.6', 'medium'))
      .toBe("pi --model 'xai/grok-4.6' --thinking 'medium'");
  });

  it('keeps explicit Pi model and Thinking options unchanged', () => {
    expect(buildSupervisorLaunchCommand('pi --model anthropic/claude-sonnet --thinking max', 'openai/gpt-4o', 'low'))
      .toBe('pi --model anthropic/claude-sonnet --thinking max');
  });

  it('recognizes Pi launch commands and displays the Pi Agent name', () => {
    expect(detectSupervisorLauncher('pi')).toBe('pi');
    expect(detectSupervisorLauncher('& "C:\\Tools\\pi.exe" --thinking high')).toBe('pi');
    expect(supervisorLauncherDisplayName('pi')).toBe('Pi Agent');
  });

  it('does not add Kimi Thinking or Grok Build model options to another launcher', () => {
    expect(buildSupervisorLaunchCommand('claude', 'k3', 'on')).toBe('claude');
  });

  it('does not add Codex arguments to another launcher', () => {
    expect(buildSupervisorLaunchCommand('claude', 'gpt-5.6-sol')).toBe('claude');
  });

  it('isolates a dedicated Pi supervisor from project context and external skills', () => {
    const command = buildSupervisorLaunchCommand(
      'pi',
      'gpt-5.6-sol',
      'medium',
      { isolateSupervisor: true, projectDir: "E:\\Work\\O'Brien", isolationKey: 'lane-auth' },
    );

    expect(command).toContain("$env:WMUX_SUPERVISOR_PROJECT_DIR = 'E:\\Work\\O''Brien'");
    expect(command).toContain('\\supervisor\\runtime\\lane-auth');
    expect(command).toContain('Set-Location -LiteralPath $wmuxSupervisorRuntimeDir');
    expect(command).toContain('--no-skills');
    expect(command).toContain('--no-prompt-templates');
    expect(command).toContain('--no-context-files');
  });

  it('gives a dedicated Kimi supervisor an empty isolated skill directory', () => {
    const command = buildSupervisorLaunchCommand(
      'kimi',
      'k3',
      'on',
      { isolateSupervisor: true, projectDir: 'E:\\project' },
    );

    expect(command).toContain("$wmuxSupervisorSkillsDir = Join-Path $wmuxSupervisorRuntimeDir 'skills'");
    expect(command).toContain('--skills-dir $wmuxSupervisorSkillsDir');
  });

  it('disables memory, subagents and web search for a dedicated Grok supervisor', () => {
    const command = buildSupervisorLaunchCommand(
      'grok --no-memory',
      'grok-4.6',
      '',
      { isolateSupervisor: true, projectDir: 'E:\\project', isolationKey: 'lane-grok' },
    );

    expect(command.match(/--no-memory/g)).toHaveLength(1);
    expect(command).toContain('--no-subagents');
    expect(command).toContain('--disable-web-search');
  });

  it('isolates built-in Claude even though wmux does not add launcher options to it', () => {
    const command = buildSupervisorLaunchCommand(
      'claude',
      'gpt-5.6-sol',
      '',
      { isolateSupervisor: true, projectDir: 'E:\\project', isolationKey: 'lane-claude' },
    );

    expect(command).toContain('\\supervisor\\runtime\\lane-claude');
    expect(command.endsWith('; claude')).toBe(true);
    expect(command).not.toContain("--model 'gpt-5.6-sol'");
  });

  it('preserves an unknown custom launcher when supervisor isolation is requested', () => {
    expect(buildSupervisorLaunchCommand(
      'my-supervisor --profile safe',
      '',
      '',
      { isolateSupervisor: true, projectDir: 'E:\\project' },
    )).toBe('my-supervisor --profile safe');
  });
});
