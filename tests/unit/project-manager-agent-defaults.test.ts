import { describe, expect, it } from 'vitest';
import {
  projectManagerRuntimeDefaults,
  projectSupervisorDefaults,
  projectTaskTerminalAgent,
  projectTaskTerminalDefaults,
} from '../../src/renderer/project-manager/agent-defaults';
import {
  DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
  normalizeProjectManagementAgentConfig,
} from '../../src/shared/project-manager-terminal';

describe('project manager agent defaults', () => {
  it('uses the project-mode Pi supervisor model without direct-supervision preferences', () => {
    expect(projectSupervisorDefaults({
      ...DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
      supervisor: { agent: 'pi', model: 'openai-codex/gpt-5.6-terra', reasoningEffort: 'high' },
    })).toEqual({
      supervisorLaunchCmd: 'pi',
      supervisorModel: 'openai-codex/gpt-5.6-terra',
      supervisorReasoningEffort: 'high',
    });
  });

  it('keeps independent defaults for all three project layers', () => {
    expect(projectManagerRuntimeDefaults(DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG)).toEqual({
      agent: 'codex', model: '', reasoningEffort: '',
    });
    expect(projectSupervisorDefaults(DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG).supervisorLaunchCmd).toBe('pi');
    expect(projectTaskTerminalDefaults(DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG)).toEqual({
      agent: 'codex', model: '', reasoningEffort: '',
    });
  });

  it('defaults project task terminals to Codex', () => {
    expect(projectTaskTerminalAgent(undefined)).toBe('codex');
    expect(projectTaskTerminalAgent('invalid')).toBe('codex');
    expect(projectTaskTerminalAgent('grok')).toBe('grok');
  });

  it('restores legacy settings and clamps unsupported reasoning values per Agent', () => {
    expect(normalizeProjectManagementAgentConfig({
      manager: { agent: 'codex', model: '' },
      supervisor: { agent: 'pi', model: '' },
      task: { agent: 'kimi', model: '' },
    } as any)).toMatchObject({
      manager: { reasoningEffort: '' },
      supervisor: { reasoningEffort: 'medium' },
      task: { reasoningEffort: '' },
    });
    expect(normalizeProjectManagementAgentConfig({
      ...DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
      manager: { agent: 'grok', model: 'grok-4.5', reasoningEffort: 'xhigh' },
    }).manager.reasoningEffort).toBe('');
  });

  it('accepts supported Grok Thinking levels', () => {
    expect(normalizeProjectManagementAgentConfig({
      ...DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
      manager: { agent: 'grok', model: 'grok-4.6', reasoningEffort: 'high' },
    }).manager.reasoningEffort).toBe('high');
  });

  it('migrates obsolete Grok Build model IDs in saved project settings', () => {
    expect(normalizeProjectManagementAgentConfig({
      manager: { agent: 'grok', model: 'grok-build', reasoningEffort: '' },
      supervisor: { agent: 'pi', model: 'xai/grok-build-0.1', reasoningEffort: 'medium' },
      task: { agent: 'grok', model: 'grok-build', reasoningEffort: '' },
    })).toMatchObject({
      manager: { model: 'grok-4.6' },
      supervisor: { model: 'xai/grok-4.6' },
      task: { model: 'grok-4.6' },
    });
  });

  it('migrates legacy Kimi model names to configured aliases', () => {
    expect(normalizeProjectManagementAgentConfig({
      manager: { agent: 'kimi', model: 'k3-256k', reasoningEffort: '' },
      supervisor: { agent: 'kimi', model: 'k3', reasoningEffort: '' },
      task: { agent: 'kimi', model: 'kimi-for-coding', reasoningEffort: '' },
    })).toMatchObject({
      manager: { model: 'kimi-code/k3-256k' },
      supervisor: { model: 'kimi-code/k3' },
      task: { model: 'kimi-code/kimi-for-coding' },
    });
  });

  it('migrates the obsolete Codex Spark model ID in project settings', () => {
    expect(normalizeProjectManagementAgentConfig({
      manager: { agent: 'codex', model: 'gpt-5.4-codex-spark', reasoningEffort: '' },
      supervisor: { agent: 'codex', model: 'gpt-5.4-codex-spark', reasoningEffort: 'medium' },
      task: { agent: 'codex', model: 'gpt-5.4-codex-spark', reasoningEffort: '' },
    })).toMatchObject({
      manager: { model: 'gpt-5.3-codex-spark' },
      supervisor: { model: 'gpt-5.3-codex-spark' },
      task: { model: 'gpt-5.3-codex-spark' },
    });
  });
});
