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

  it('adds a selected Grok Build model with its supported short flag', () => {
    expect(buildSupervisorLaunchCommand('grok', 'grok-build'))
      .toBe("grok -m 'grok-build'");
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
});
