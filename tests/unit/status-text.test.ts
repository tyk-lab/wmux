import { describe, it, expect } from 'vitest';
import { resolveStatusText, resolveStatusClass } from '../../src/renderer/components/Sidebar/status-text';

const base = {
  runningAgentCount: 0,
  agentTotal: 0,
  sessionCount: 0,
  workingSessions: 0,
  blockedSessions: 0,
  currentToolLabel: null as string | null,
  claudeIsIdle: false,
};

describe('resolveStatusText', () => {
  it('shows Working for a single declared session with no tool (wmux wrap)', () => {
    // Regression: previously fell through to shell "Running" and looked unchanged.
    expect(resolveStatusText({
      ...base,
      sessionCount: 1,
      workingSessions: 1,
      shellState: 'running',
    })).toBe('Working');
  });

  it('prefers tool label when the working session has one', () => {
    expect(resolveStatusText({
      ...base,
      sessionCount: 1,
      workingSessions: 1,
      currentToolLabel: 'Editing...',
      shellState: 'running',
    })).toBe('Editing...');
  });

  it('shows Needs you above Working', () => {
    expect(resolveStatusText({
      ...base,
      sessionCount: 1,
      workingSessions: 1,
      blockedSessions: 1,
      shellState: 'running',
    })).toBe('Needs you');
  });

  it('falls back to shell Running when nothing is tracked', () => {
    expect(resolveStatusText({
      ...base,
      shellState: 'running',
    })).toBe('Running');
  });
});

describe('resolveStatusClass', () => {
  it('uses working style for declared workingSessions', () => {
    expect(resolveStatusClass({
      blockedSessions: 0,
      runningAgentCount: 0,
      workingSessions: 1,
      sessionCount: 1,
      currentToolLabel: null,
      claudeIsIdle: false,
      shellState: 'running',
    })).toBe('workspace-row__status--working');
  });
});
