export type ProjectAgentActivityState = 'idle' | 'working' | 'blocked' | 'unknown';

export const PROJECT_LIVENESS_IDLE_PROBE_MS = 6 * 60_000;
export const PROJECT_LIVENESS_WORKER_PROBE_MS = 10 * 60_000;
export const PROJECT_LIVENESS_SUPERVISOR_WORKING_GRACE_MS = 30 * 60_000;
export const PROJECT_LIVENESS_BLOCKED_REPORT_MS = 10 * 60_000;
export const PROJECT_LIVENESS_PROBE_REPORT_MS = 12 * 60_000;
export const PROJECT_LIVENESS_CONTROL_GRACE_MS = 5 * 60_000;

export interface ProjectLivenessRuntime {
  fingerprint: string;
  lastProgressAt: number;
  probeQueuedAt?: number;
  escapeSentAt?: number;
  interruptSentAt?: number;
  attentionReportedAt?: number;
}

export type ProjectLivenessAction =
  | 'none'
  | 'wake-supervisor'
  | 'probe-supervisor'
  | 'escape-supervisor'
  | 'interrupt-supervisor'
  | 'report-supervisor-stuck';

export interface ProjectLivenessDecision {
  action: ProjectLivenessAction;
  runtime: ProjectLivenessRuntime;
  silentForMs: number;
}

/** Remove presentation-only timers/spinners so they cannot masquerade as progress. */
export function normalizeProjectActivityFingerprintText(text: string): string {
  return text
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/gu, '•')
    .replace(/\b(working|thinking)\s*\(\s*(?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\s*)+(?:[·•|—-]\s*)?(?:esc\s+to\s+interrupt)?\s*\)/giu, '$1')
    .replace(/\b(working|thinking)\s+for\s+(?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\s*)+/giu, '$1')
    .replace(/\b\d+\s*seconds?\s+ago\b/giu, '')
    .replace(/\d+\s*秒前/gu, '');
}

/**
 * Pure backpressure policy for one project execution chain. A semantic screen
 * or state change resets escalation; elapsed wall time alone never creates a
 * stream of prompts.
 */
export function evaluateProjectLiveness(options: {
  runtime?: ProjectLivenessRuntime;
  fingerprint: string;
  now: number;
  supervisorState: ProjectAgentActivityState;
  workerState: ProjectAgentActivityState;
  pendingSupervisorDeliveries: number;
}): ProjectLivenessDecision {
  const { fingerprint, now, supervisorState, workerState, pendingSupervisorDeliveries } = options;
  const previous = options.runtime;
  if (!previous || previous.fingerprint !== fingerprint) {
    return {
      action: pendingSupervisorDeliveries > 0 && supervisorState !== 'working' && supervisorState !== 'blocked'
        ? 'wake-supervisor'
        : 'none',
      runtime: {
        fingerprint,
        lastProgressAt: now,
        ...(pendingSupervisorDeliveries > 0 ? { probeQueuedAt: now } : {}),
      },
      silentForMs: 0,
    };
  }

  const silentForMs = Math.max(0, now - previous.lastProgressAt);
  const runtime = { ...previous };
  if (supervisorState === 'working') {
    if (runtime.interruptSentAt) {
      if (!runtime.attentionReportedAt && now - runtime.interruptSentAt >= PROJECT_LIVENESS_CONTROL_GRACE_MS) {
        runtime.attentionReportedAt = now;
        return { action: 'report-supervisor-stuck', runtime, silentForMs };
      }
      return { action: 'none', runtime, silentForMs };
    }
    if (runtime.escapeSentAt) {
      if (now - runtime.escapeSentAt >= PROJECT_LIVENESS_CONTROL_GRACE_MS) {
        runtime.interruptSentAt = now;
        return { action: 'interrupt-supervisor', runtime, silentForMs };
      }
      return { action: 'none', runtime, silentForMs };
    }
    if (silentForMs >= PROJECT_LIVENESS_SUPERVISOR_WORKING_GRACE_MS) {
      runtime.escapeSentAt = now;
      return { action: 'escape-supervisor', runtime, silentForMs };
    }
    return { action: 'none', runtime, silentForMs };
  }

  if (supervisorState === 'blocked') {
    if (!runtime.attentionReportedAt && silentForMs >= PROJECT_LIVENESS_BLOCKED_REPORT_MS) {
      runtime.attentionReportedAt = now;
      return { action: 'report-supervisor-stuck', runtime, silentForMs };
    }
    return { action: 'none', runtime, silentForMs };
  }

  if (runtime.probeQueuedAt) {
    if (!runtime.attentionReportedAt && now - runtime.probeQueuedAt >= PROJECT_LIVENESS_PROBE_REPORT_MS) {
      runtime.attentionReportedAt = now;
      return { action: 'report-supervisor-stuck', runtime, silentForMs };
    }
    return {
      action: pendingSupervisorDeliveries > 0 ? 'wake-supervisor' : 'none',
      runtime,
      silentForMs,
    };
  }

  if (pendingSupervisorDeliveries > 0) {
    runtime.probeQueuedAt = now;
    return { action: 'wake-supervisor', runtime, silentForMs };
  }

  const probeAfterMs = workerState === 'idle'
    ? PROJECT_LIVENESS_IDLE_PROBE_MS
    : PROJECT_LIVENESS_WORKER_PROBE_MS;
  if (silentForMs >= probeAfterMs) {
    runtime.probeQueuedAt = now;
    return { action: 'probe-supervisor', runtime, silentForMs };
  }
  return { action: 'none', runtime, silentForMs };
}
