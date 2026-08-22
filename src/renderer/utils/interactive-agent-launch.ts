import { buildSupervisorLaunchCommand, detectSupervisorLauncher } from '../supervisor/launch-command';
import { startupTrustPromptKind } from './terminal-input-delivery';
import type { SurfaceRef } from '../../shared/types';

export type InteractiveAgent = 'codex' | 'kimi' | 'grok';

export interface InteractiveAgentLaunch {
  startupCommands: string[];
  startupInput?: string;
}

/** Only wmux-owned project-AI, task-AI and dedicated supervisor surfaces may auto-trust Codex hooks. */
export function surfaceAllowsManagedCodexHookTrust(
  surface: Pick<SurfaceRef, 'projectManagerProjectId' | 'projectManagerTerminal' | 'transientSupervisor'>,
): boolean {
  return surface.projectManagerTerminal === true
    || surface.transientSupervisor === true
    || !!surface.projectManagerProjectId;
}

const AUTOMATED_KIMI_STARTUP_MARKER = '# wmux-automated-agent-task';

function isolatedSupervisorLauncherCommand(rawCommand: string): string {
  const tail = rawCommand.split(/;\s*/u).pop()?.trim() || '';
  const wrapped = /^try\s*\{\s*([\s\S]*?)\s*\}\s*finally\s*\{/iu.exec(tail);
  return wrapped?.[1]?.trim() || tail;
}

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
  observedOutput = '',
): AutomatedInteractiveAgent | undefined {
  const rawCommand = startupCommands?.[0]?.trim() || '';
  const command = rawCommand.toLowerCase();
  if (command.startsWith('codex ') && command.includes('convertfrom-json')) return 'codex';
  if (command.startsWith('grok ') && command.includes('convertfrom-json')) return 'grok';
  if (command.startsWith('kimi ') && command.endsWith(AUTOMATED_KIMI_STARTUP_MARKER) && !!startupInput) return 'kimi';
  if (command.includes('$wmuxsupervisorruntimedir')) {
    const isolatedCommand = isolatedSupervisorLauncherCommand(rawCommand);
    const launcher = detectSupervisorLauncher(isolatedCommand);
    if (launcher === 'codex' || launcher === 'kimi' || launcher === 'grok' || launcher === 'pi') {
      return launcher;
    }
    // The isolated runtime marker is authoritative, but the exact PowerShell
    // wrapper may evolve independently. A precise trust screen can recover the
    // launcher identity without ever auto-confirming a normal user terminal.
    for (const candidate of ['codex', 'kimi', 'grok'] as const) {
      if (startupTrustPromptKind(candidate, observedOutput)) return candidate;
    }
  }
  return undefined;
}
