import { describe, it, expect } from 'vitest';
import {
  resolveManagedProjectAlertText,
  resolveStatusText,
  resolveStatusClass,
} from '../../src/renderer/components/Sidebar/status-text';

const base = {
  runningAgentCount: 0,
  agentTotal: 0,
  sessionCount: 0,
  workingSessions: 0,
  blockedSessions: 0,
  currentToolLabel: null as string | null,
  agentIsIdle: false,
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

  it('shows a managed-project alert above idle agent telemetry', () => {
    expect(resolveStatusText({
      ...base,
      sessionCount: 3,
      shellState: 'running',
      agentIsIdle: true,
      statusOverride: 'idle',
      projectAlertText: '项目异常暂停',
    })).toBe('项目异常暂停');
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
      agentIsIdle: false,
      shellState: 'running',
    })).toBe('workspace-row__status--working');
  });

  it('uses blocked styling for a managed-project alert', () => {
    expect(resolveStatusClass({
      blockedSessions: 0,
      runningAgentCount: 0,
      workingSessions: 0,
      sessionCount: 3,
      currentToolLabel: null,
      agentIsIdle: true,
      shellState: 'running',
      statusOverride: 'idle',
      projectAlertText: '项目异常暂停',
    })).toBe('workspace-row__status--blocked');
  });
});

describe('resolveManagedProjectAlertText', () => {
  const event = (sessionId: string, ts: number) => ({
    id: `event-${sessionId}-${ts}`,
    sessionId,
    ts,
    kind: 'task-runtime-failed' as const,
    summary: '任务运行时失败，需要处理',
    payload: { attentionRequired: true },
  });

  it('finds an alert after an earlier healthy project in the same workspace', () => {
    expect(resolveManagedProjectAlertText([
      { id: 'project-a', status: 'active', events: [] },
      { id: 'project-b', status: 'waiting', events: [event('project-b', 2)] },
    ], new Set(['project-a', 'project-b']))).toBe('项目需要处理');
  });

  it('prioritizes a paused project when several associated projects need attention', () => {
    expect(resolveManagedProjectAlertText([
      { id: 'project-a', status: 'active', events: [event('project-a', 1)] },
      { id: 'project-b', status: 'paused', events: [event('project-b', 2)] },
    ], new Set(['project-a', 'project-b']))).toBe('项目异常暂停');
  });
});
