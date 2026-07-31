function isCodexLaunchCommand(command: string): boolean {
  return /^(?:&\s+)?(?:"[^"]*\\codex(?:\.exe)?"|'[^']*\\codex(?:\.exe)?'|(?:\S*\\)?codex(?:\.exe)?)(?:\s|$)/i.test(command);
}

function quotePowerShellArgument(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Adds a selected Codex model without changing custom, non-Codex launchers.
 * A caller-supplied --model / -m always wins so existing custom commands stay
 * reproducible.
 */
export function buildSupervisorLaunchCommand(
  launchCommand: string,
  model: string,
  reasoningEffort = '',
): string {
  const command = launchCommand.trim();
  const selectedModel = model.trim();
  const selectedEffort = reasoningEffort.trim();
  if (!command || !isCodexLaunchCommand(command)) return command;
  const modelCommand = selectedModel && !/(?:^|\s)(?:--model|-m)(?:\s|=)/i.test(command)
    ? `${command} --model ${quotePowerShellArgument(selectedModel)}`
    : command;
  if (!selectedEffort || /\bmodel_reasoning_effort\b/i.test(command)) return modelCommand;
  return `${modelCommand} --config model_reasoning_effort=${quotePowerShellArgument(selectedEffort)}`;
}
