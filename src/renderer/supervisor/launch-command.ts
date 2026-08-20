export type SupervisorLauncherKind = 'codex' | 'kimi' | 'grok' | 'pi' | 'other';

export interface SupervisorLaunchOptions {
  /** Run a dedicated supervisor outside the managed project context. */
  isolateSupervisor?: boolean;
  /** Authoritative project root retained only for constrained wmux temp files. */
  projectDir?: string;
  /** Stable lane/surface identity used to prevent supervisor runtimes sharing context. */
  isolationKey?: string;
}

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
  if (/^grok-4\.(?:3|5|6)$/i.test(model)) {
    return `xai/${model}`;
  }
  return model;
}

function appendFlagIfMissing(command: string, pattern: RegExp, flag: string): string {
  return pattern.test(command) ? command : `${command} ${flag}`;
}

function isKnownSupervisorLauncher(command: string, launcher: SupervisorLauncherKind): boolean {
  return launcher !== 'other'
    || matchesLauncherCommand(command, 'claude')
    || matchesLauncherCommand(command, 'opencode');
}

function normalizedIsolationKey(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'default';
}

function isolatedSupervisorCommand(
  command: string,
  launcher: SupervisorLauncherKind,
  projectDir: string,
  isolationKey: string,
): string {
  if (!isKnownSupervisorLauncher(command, launcher)) return command;

  let isolatedCommand = command;
  if (launcher === 'pi') {
    isolatedCommand = appendFlagIfMissing(isolatedCommand, /(?:^|\s)--no-skills(?:\s|$)/i, '--no-skills');
    isolatedCommand = appendFlagIfMissing(
      isolatedCommand,
      /(?:^|\s)--no-prompt-templates(?:\s|$)/i,
      '--no-prompt-templates',
    );
    isolatedCommand = appendFlagIfMissing(
      isolatedCommand,
      /(?:^|\s)--no-context-files(?:\s|$)/i,
      '--no-context-files',
    );
  } else if (launcher === 'grok') {
    isolatedCommand = appendFlagIfMissing(isolatedCommand, /(?:^|\s)--no-memory(?:\s|$)/i, '--no-memory');
    isolatedCommand = appendFlagIfMissing(isolatedCommand, /(?:^|\s)--no-subagents(?:\s|$)/i, '--no-subagents');
    isolatedCommand = appendFlagIfMissing(
      isolatedCommand,
      /(?:^|\s)--disable-web-search(?:\s|$)/i,
      '--disable-web-search',
    );
  }

  const prelude = [
    "$wmuxSupervisorDataRoot = [Environment]::GetFolderPath('ApplicationData')",
    "$wmuxSupervisorInstance = if ($env:WMUX_INSTANCE) { 'wmux-' + $env:WMUX_INSTANCE } else { 'wmux' }",
    `$wmuxSupervisorRuntimeDir = Join-Path $wmuxSupervisorDataRoot ($wmuxSupervisorInstance + '\\supervisor\\runtime\\${normalizedIsolationKey(isolationKey)}')`,
    '[void][System.IO.Directory]::CreateDirectory($wmuxSupervisorRuntimeDir)',
  ];
  if (projectDir.trim()) {
    prelude.push(`$env:WMUX_SUPERVISOR_PROJECT_DIR = ${quotePowerShellArgument(projectDir.trim())}`);
  }
  if (launcher === 'kimi' && !/(?:^|\s)--skills-dir(?:\s|=)/i.test(isolatedCommand)) {
    prelude.push("$wmuxSupervisorSkillsDir = Join-Path $wmuxSupervisorRuntimeDir 'skills'");
    prelude.push('[void][System.IO.Directory]::CreateDirectory($wmuxSupervisorSkillsDir)');
    isolatedCommand = `${isolatedCommand} --skills-dir $wmuxSupervisorSkillsDir`;
  }
  prelude.push('Set-Location -LiteralPath $wmuxSupervisorRuntimeDir', isolatedCommand);
  return prelude.join('; ');
}

/**
 * Adds only the selected launcher's supported startup options. A caller-supplied
 * --model / -m always wins so existing custom commands stay reproducible.
 */
export function buildSupervisorLaunchCommand(
  launchCommand: string,
  model: string,
  reasoningEffort = '',
  options: SupervisorLaunchOptions = {},
): string {
  const command = launchCommand.trim();
  const launcher = detectSupervisorLauncher(command);
  const rawModel = model.trim();
  const selectedModel = launcher === 'pi'
    ? qualifyPiModel(rawModel === 'xai/grok-build-0.1' ? 'xai/grok-4.6' : rawModel)
    : launcher === 'grok' && rawModel === 'grok-build'
      ? 'grok-4.6'
      : rawModel;
  const selectedEffort = reasoningEffort.trim();
  if (!command) return command;
  const modelFlag = launcher === 'grok' ? '-m' : '--model';
  const modelCommand = launcher !== 'other'
    && selectedModel
    && !/(?:^|\s)(?:--model|-m)(?:\s|=)/i.test(command)
    ? `${command} ${modelFlag} ${quotePowerShellArgument(selectedModel)}`
    : command;
  let configuredCommand = modelCommand;
  if (launcher === 'codex') {
    if (selectedEffort && !/\bmodel_reasoning_effort\b/i.test(command)) {
      configuredCommand = `${modelCommand} --config model_reasoning_effort=${quotePowerShellArgument(selectedEffort)}`;
    }
  }
  // Current Kimi Code releases do not expose a --thinking CLI option. Legacy
  // preferences are normalized away; the selected model/profile decides its
  // thinking behavior instead of making the Agent fail at startup.
  if (launcher === 'grok'
    && selectedEffort
    && !/(?:^|\s)--(?:reasoning-)?effort(?:\s|=)/i.test(command)) {
    configuredCommand = `${modelCommand} --reasoning-effort ${quotePowerShellArgument(selectedEffort)}`;
  }
  if (launcher === 'pi' && selectedEffort && !/(?:^|\s)--thinking(?:\s|=)/i.test(command)) {
    configuredCommand = `${modelCommand} --thinking ${quotePowerShellArgument(selectedEffort)}`;
  }
  return options.isolateSupervisor
    ? isolatedSupervisorCommand(
        configuredCommand,
        launcher,
        options.projectDir || '',
        options.isolationKey || '',
      )
    : configuredCommand;
}
