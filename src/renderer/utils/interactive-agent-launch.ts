import { buildSupervisorLaunchCommand, detectSupervisorLauncher } from '../supervisor/launch-command';

export type InteractiveAgent = 'codex' | 'kimi' | 'grok';

export interface InteractiveAgentLaunch {
  startupCommands: string[];
  startupInput?: string;
}

const AUTOMATED_KIMI_STARTUP_MARKER = '# wmux-automated-agent-task';

function powerShellStringExpression(value: string): string {
  const json = JSON.stringify(value).replace(/'/g, "''");
  return `(ConvertFrom-Json '${json}')`;
}

/**
 * Codex and Grok accept an initial prompt natively, which avoids racing their
 * TUI startup. Kimi has no interactive initial-prompt option, so it still uses
 * the checked PTY input path after its interface starts.
 */
export function buildInteractiveAgentLaunch(
  agent: InteractiveAgent,
  prompt: string,
  model = '',
  reasoningEffort = '',
): InteractiveAgentLaunch {
  const launchCommand = buildSupervisorLaunchCommand(agent, model, reasoningEffort);
  if (agent === 'kimi') {
    return {
      startupCommands: [`${launchCommand} ${AUTOMATED_KIMI_STARTUP_MARKER}`],
      startupInput: prompt,
    };
  }

  return {
    startupCommands: [
      `${launchCommand} -- ${powerShellStringExpression(prompt)}`,
    ],
  };
}

export type AutomatedInteractiveAgent = 'codex' | 'kimi' | 'grok' | 'pi';

export function detectAutomatedInteractiveAgent(
  startupCommands: string[] | undefined,
  startupInput: string | undefined,
): AutomatedInteractiveAgent | undefined {
  const rawCommand = startupCommands?.[0]?.trim() || '';
  const command = rawCommand.toLowerCase();
  if (command.startsWith('codex ') && command.includes('convertfrom-json')) return 'codex';
  if (command.startsWith('grok ') && command.includes('convertfrom-json')) return 'grok';
  if (command.startsWith('kimi ') && command.endsWith(AUTOMATED_KIMI_STARTUP_MARKER) && !!startupInput) return 'kimi';
  if (command.includes('$wmuxsupervisorruntimedir')) {
    const isolatedCommand = rawCommand.split(/;\s*/u).pop() || '';
    const launcher = detectSupervisorLauncher(isolatedCommand);
    if (launcher === 'codex' || launcher === 'kimi' || launcher === 'grok' || launcher === 'pi') {
      return launcher;
    }
  }
  return undefined;
}
