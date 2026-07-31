import { describe, expect, it } from 'vitest';
import { buildSupervisorLaunchCommand } from '../../src/renderer/supervisor/launch-command';

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

  it('does not add Codex arguments to another launcher', () => {
    expect(buildSupervisorLaunchCommand('claude', 'gpt-5.6-sol')).toBe('claude');
  });
});
