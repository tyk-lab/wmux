import {
  normalizeProjectManagementAgentConfig,
  type ProjectManagementAgentConfig,
} from '../../shared/project-manager-terminal';
import {
  supervisorDefaultsForAgent,
} from '../store/supervisor-slice';
import type { InteractiveAgent } from '../utils/interactive-agent-launch';

/** Project mode has its own launch settings and never reads direct-supervision preferences. */
export function projectSupervisorDefaults(config: ProjectManagementAgentConfig) {
  const selection = normalizeProjectManagementAgentConfig(config).supervisor;
  return {
    ...supervisorDefaultsForAgent(selection.agent),
    supervisorModel: selection.model,
    supervisorReasoningEffort: selection.reasoningEffort,
  };
}

export function projectTaskTerminalAgent(value: unknown): InteractiveAgent {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'kimi' || normalized === 'grok' ? normalized : 'codex';
}

export function projectTaskTerminalDefaults(config: ProjectManagementAgentConfig) {
  return normalizeProjectManagementAgentConfig(config).task;
}

export function projectManagerRuntimeDefaults(config: ProjectManagementAgentConfig) {
  return normalizeProjectManagementAgentConfig(config).manager;
}
