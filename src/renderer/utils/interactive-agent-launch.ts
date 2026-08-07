export type InteractiveAgent = 'codex' | 'kimi' | 'grok';

export interface InteractiveAgentLaunch {
  startupCommands: string[];
  startupInput?: string;
}

const AUTOMATED_KIMI_STARTUP_COMMAND = 'kimi # wmux-automated-agent-task';

function powerShellStringExpression(value: string): string {
  const json = JSON.stringify(value).replace(/'/g, "''");
  return `(ConvertFrom-Json '${json}')`;
}

/**
 * Codex and Grok accept an initial prompt natively, which avoids racing their
 * TUI startup. Kimi has no interactive initial-prompt option, so it still uses
 * the checked PTY input path after its interface starts.
 */
export function buildInteractiveAgentLaunch(agent: InteractiveAgent, prompt: string): InteractiveAgentLaunch {
  if (agent === 'kimi') {
    return {
      startupCommands: [AUTOMATED_KIMI_STARTUP_COMMAND],
      startupInput: prompt,
    };
  }

  return {
    startupCommands: [`${agent} -- ${powerShellStringExpression(prompt)}`],
  };
}

export function detectAutomatedInteractiveAgent(
  startupCommands: string[] | undefined,
  startupInput: string | undefined,
): 'codex' | 'kimi' | undefined {
  const command = startupCommands?.[0]?.trim().toLowerCase() || '';
  if (command.startsWith('codex ') && command.includes('convertfrom-json')) return 'codex';
  if (command === AUTOMATED_KIMI_STARTUP_COMMAND && !!startupInput) return 'kimi';
  return undefined;
}
