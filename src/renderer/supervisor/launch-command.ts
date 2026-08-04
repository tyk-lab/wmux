export type SupervisorLauncherKind = 'codex' | 'kimi' | 'grok' | 'pi' | 'other';

function matchesLauncherCommand(command: string, executable: string): boolean {
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^(?:&\\s+)?(?:"[^"]*\\\\${escaped}(?:\\.exe)?"|'[^']*\\\\${escaped}(?:\\.exe)?'|(?:\\S*\\\\)?${escaped}(?:\\.exe)?)(?:\\s|$)`,
    'i',
  ).test(command);
}

export function detectSupervisorLauncher(command: string): SupervisorLauncherKind {
  const normalized = command.trim();
  if (matchesLauncherCommand(normalized, 'codex')) return 'codex';
  if (matchesLauncherCommand(normalized, 'kimi')) return 'kimi';
  if (matchesLauncherCommand(normalized, 'grok')) return 'grok';
  if (matchesLauncherCommand(normalized, 'pi')) return 'pi';
  return 'other';
}

export function supervisorLauncherDisplayName(launcher: SupervisorLauncherKind): string {
  if (launcher === 'codex') return 'Codex';
  if (launcher === 'kimi') return 'Kimi Code';
  if (launcher === 'grok') return 'Grok Build';
  if (launcher === 'pi') return 'Pi Agent';
  return '当前启动器';
}

function quotePowerShellArgument(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function qualifyPiModel(model: string): string {
  if (/^gpt-5\.6-(?:sol|terra|luna)$/i.test(model)) {
    return `openai-codex/${model}`;
  }
  if (/^(?:k3|k3-256k|kimi-for-coding(?:-highspeed)?)$/i.test(model)) {
    return `kimi-coding/${model}`;
  }
  if (/^(?:grok-4\.3|grok-4\.5|grok-build-0\.1)$/i.test(model)) {
    return `xai/${model}`;
  }
  return model;
}

/**
 * Adds only the selected launcher's supported startup options. A caller-supplied
 * --model / -m always wins so existing custom commands stay reproducible.
 */
export function buildSupervisorLaunchCommand(
  launchCommand: string,
  model: string,
  reasoningEffort = '',
): string {
  const command = launchCommand.trim();
  const launcher = detectSupervisorLauncher(command);
  const selectedModel = launcher === 'pi' ? qualifyPiModel(model.trim()) : model.trim();
  const selectedEffort = reasoningEffort.trim();
  if (!command || launcher === 'other') return command;
  const modelFlag = launcher === 'grok' ? '-m' : '--model';
  const modelCommand = selectedModel && !/(?:^|\s)(?:--model|-m)(?:\s|=)/i.test(command)
    ? `${command} ${modelFlag} ${quotePowerShellArgument(selectedModel)}`
    : command;
  if (launcher === 'codex') {
    if (!selectedEffort || /\bmodel_reasoning_effort\b/i.test(command)) return modelCommand;
    return `${modelCommand} --config model_reasoning_effort=${quotePowerShellArgument(selectedEffort)}`;
  }
  if (launcher === 'kimi' && selectedEffort === 'on' && !/(?:^|\s)--thinking(?:\s|$)/i.test(command)) {
    return `${modelCommand} --thinking`;
  }
  if (launcher === 'pi' && selectedEffort && !/(?:^|\s)--thinking(?:\s|=)/i.test(command)) {
    return `${modelCommand} --thinking ${quotePowerShellArgument(selectedEffort)}`;
  }
  return modelCommand;
}
