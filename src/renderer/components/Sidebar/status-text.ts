/**
 * Pure status-line priority for a workspace row.
 * Extracted so wrap/report-agent "working with no tool name" stays testable —
 * that path used to fall through to shell "Running" and look unchanged.
 */

export interface StatusTextInputs {
  statusOverride?: 'idle' | 'running';
  runningAgentCount: number;
  agentTotal: number;
  sessionCount: number;
  workingSessions: number;
  blockedSessions: number;
  currentToolLabel: string | null;
  claudeIsIdle: boolean;
  shellState?: string;
  notificationText?: string;
}

/** Priorities 0–2: agent-derived signals. Null → fall through to shell state. */
export function claudeStatusText(s: StatusTextInputs): string | null {
  // Priority 0: user pinned the status by hand (issue #81).
  if (s.statusOverride) {
    return s.statusOverride === 'running' ? 'Running' : 'Idle';
  }

  // Priority 0.25: parked on the user (issue #128).
  if (s.blockedSessions > 0) {
    return s.blockedSessions > 1 ? `Needs you · ${s.blockedSessions}` : 'Needs you';
  }

  // Priority 0.5: wmux-spawned orchestration agents.
  if (s.runningAgentCount > 0) {
    return `Orchestrating · ${s.agentTotal} agent${s.agentTotal > 1 ? 's' : ''}`;
  }

  // Priority 0.75: several tracked sessions — summarize; sub-lines carry detail.
  if (s.sessionCount >= 2) {
    return s.workingSessions > 0
      ? `Claude · ${s.workingSessions}/${s.sessionCount} running`
      : 'Idle';
  }

  // Priority 0.85: at least one session working (declared wrap/report-agent or
  // inferred). Critical for single-pane `wmux wrap kimi`: no tool label, so
  // without this branch the row stays on shell "Running" and looks unchanged.
  if (s.workingSessions > 0) {
    return s.currentToolLabel || 'Working';
  }

  // Priority 1: workspace-level tool label without a session entry.
  if (s.currentToolLabel) return s.currentToolLabel;

  // Priority 2: agent was active but stopped while shell still "running".
  if (s.claudeIsIdle) return 'Idle';

  return null;
}

/** Full chain: agent signals → shell → notification → default Idle. */
export function resolveStatusText(s: StatusTextInputs): string {
  const claude = claudeStatusText(s);
  if (claude) return claude;

  if (s.shellState === 'running') return 'Running';
  if (s.shellState === 'interrupted') return 'Interrupted';
  if (s.shellState === 'idle') {
    return s.notificationText ? `Done: ${s.notificationText}` : 'Idle';
  }

  if (s.notificationText) return s.notificationText;
  return 'Idle';
}

/** CSS modifier for the status line (not the state dot). */
export function resolveStatusClass(s: {
  statusOverride?: 'idle' | 'running';
  blockedSessions: number;
  runningAgentCount: number;
  workingSessions: number;
  sessionCount: number;
  currentToolLabel: string | null;
  claudeIsIdle: boolean;
  shellState?: string;
  notificationText?: string;
}): string {
  if (s.statusOverride) {
    return s.statusOverride === 'running'
      ? 'workspace-row__status--running'
      : 'workspace-row__status--idle-clear';
  }
  if (s.blockedSessions > 0) return 'workspace-row__status--blocked';
  if (s.runningAgentCount > 0) return 'workspace-row__status--working';
  if (s.workingSessions > 0) return 'workspace-row__status--working';
  if (s.sessionCount >= 2) {
    return s.workingSessions > 0 ? 'workspace-row__status--working' : 'workspace-row__status--idle-clear';
  }
  if (s.currentToolLabel) return 'workspace-row__status--working';
  if (s.claudeIsIdle) return 'workspace-row__status--idle-clear';
  if (s.shellState === 'running') return 'workspace-row__status--running';
  if (s.shellState === 'interrupted') return 'workspace-row__status--interrupted';
  if (s.shellState === 'idle') {
    return s.notificationText
      ? 'workspace-row__status--done'
      : 'workspace-row__status--idle-clear';
  }
  return 'workspace-row__status--idle';
}
