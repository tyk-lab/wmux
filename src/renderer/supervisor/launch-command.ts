import { normalizeSupervisorRuntimeIsolationKey } from '../../shared/supervisor-runtime';

export type SupervisorLauncherKind = 'codex' | 'kimi' | 'grok' | 'pi' | 'other';

export interface SupervisorLaunchOptions {
  /** Run a dedicated supervisor outside the managed project context. */
  isolateSupervisor?: boolean;
  /** Legacy caller context; never exported into the isolated supervisor process. */
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

/** Return a canonical executable name without retaining possibly sensitive arguments. */
export function supportedAgentLauncherExecutable(command: string): string | null {
  const normalized = command.trim();
  const launcher = detectSupervisorLauncher(normalized);
  if (launcher !== 'other') return launcher;
  return matchesLauncherCommand(normalized, 'opencode') ? 'opencode' : null;
}

export function supervisorLaunchIsolationError(command: string): string | null {
  if (!command.trim()) return '监督 AI 启动命令不能为空';
  return supportedAgentLauncherExecutable(command)
    ? null
    : '监督 AI 只支持 Codex、Kimi、Grok、Pi 或 OpenCode；未知启动器无法保证项目只读隔离';
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

function qualifyKimiModel(model: string): string {
  if (/^(?:k3|k3-256k|kimi-for-coding(?:-highspeed)?)$/i.test(model)) {
    return `kimi-code/${model}`;
  }
  return model;
}

function appendFlagIfMissing(command: string, pattern: RegExp, flag: string): string {
  return pattern.test(command) ? command : `${command} ${flag}`;
}

function isKnownSupervisorLauncher(command: string, launcher: SupervisorLauncherKind): boolean {
  return launcher !== 'other'
    || matchesLauncherCommand(command, 'opencode');
}

function removeBooleanFlag(command: string, flag: string): string {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return command.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'giu'), '$1').replace(/\s{2,}/gu, ' ').trim();
}

function removeValueFlag(command: string, flags: string[]): string {
  const escaped = flags.map((flag) => flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return command.replace(
    new RegExp(`(^|\\s)(?:${escaped})(?:=|\\s+)(?:"[^"]*"|'[^']*'|\\S+)`, 'giu'),
    '$1',
  ).replace(/\s{2,}/gu, ' ').trim();
}

function enforceSupervisorReadOnlyMode(command: string, launcher: SupervisorLauncherKind): string {
  if (launcher === 'codex') {
    let safe = removeBooleanFlag(command, '--dangerously-bypass-approvals-and-sandbox');
    safe = removeBooleanFlag(safe, '--approve-for-me');
    safe = removeValueFlag(safe, ['--sandbox', '-s', '--ask-for-approval', '-a']);
    return `${safe} --sandbox workspace-write --ask-for-approval never`;
  }
  if (launcher === 'kimi') {
    let safe = removeBooleanFlag(command, '--auto');
    safe = removeBooleanFlag(safe, '--yolo');
    safe = removeBooleanFlag(safe, '-y');
    return appendFlagIfMissing(safe, /(?:^|\s)--plan(?:\s|$)/i, '--plan');
  }
  if (launcher === 'grok') {
    let safe = removeBooleanFlag(command, '--always-approve');
    safe = removeValueFlag(safe, ['--permission-mode', '--sandbox']);
    safe = appendFlagIfMissing(safe, /(?:^|\s)--permission-mode(?:\s|=)/i, '--permission-mode plan');
    safe = appendFlagIfMissing(safe, /(?:^|\s)--sandbox(?:\s|=)/i, '--sandbox workspace-write');
    return safe;
  }
  if (launcher === 'pi') {
    let safe = removeBooleanFlag(command, '--approve');
    safe = removeBooleanFlag(safe, '-a');
    safe = removeBooleanFlag(safe, '--no-approve');
    safe = removeBooleanFlag(safe, '-na');
    safe = removeBooleanFlag(safe, '--plan');
    safe = removeBooleanFlag(safe, '--no-tools');
    safe = removeBooleanFlag(safe, '-nt');
    safe = removeValueFlag(safe, ['--tools', '-t']);
    safe = appendFlagIfMissing(safe, /(?:^|\s)--no-approve(?:\s|$)/i, '--no-approve');
    return `${safe} --tools read,grep,find,ls,powershell`;
  }
  if (matchesLauncherCommand(command, 'opencode')) {
    let safe = removeBooleanFlag(command, '--auto');
    safe = removeValueFlag(safe, ['--agent']);
    return `${safe} --agent plan`;
  }
  return command;
}

function isolatedSupervisorCommand(
  command: string,
  launcher: SupervisorLauncherKind,
  projectDir: string,
  isolationKey: string,
): string {
  if (!isKnownSupervisorLauncher(command, launcher)) {
    return "Write-Error '不支持的监督 AI 启动器：无法保证项目只读隔离'; exit 1";
  }

  let isolatedCommand = enforceSupervisorReadOnlyMode(command, launcher);
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
    `$wmuxSupervisorRuntimeDir = Join-Path $wmuxSupervisorDataRoot ($wmuxSupervisorInstance + '\\supervisor\\runtime\\${normalizeSupervisorRuntimeIsolationKey(isolationKey)}')`,
    '[void][System.IO.Directory]::CreateDirectory($wmuxSupervisorRuntimeDir)',
  ];
  void projectDir;
  if (launcher === 'kimi' && !/(?:^|\s)--skills-dir(?:\s|=)/i.test(isolatedCommand)) {
    prelude.push("$wmuxSupervisorSkillsDir = Join-Path $wmuxSupervisorRuntimeDir 'skills'");
    prelude.push('[void][System.IO.Directory]::CreateDirectory($wmuxSupervisorSkillsDir)');
    isolatedCommand = `${isolatedCommand} --skills-dir $wmuxSupervisorSkillsDir`;
  }
  prelude.push(
    'Set-Location -LiteralPath $wmuxSupervisorRuntimeDir',
    `try { ${isolatedCommand} } finally { exit $(if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }) }`,
  );
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
    : launcher === 'kimi'
      ? qualifyKimiModel(rawModel)
    : launcher === 'codex' && rawModel === 'gpt-5.4-codex-spark'
      ? 'gpt-5.3-codex-spark'
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
