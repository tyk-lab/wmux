export type ManagedProjectAgentRole = 'manager' | 'supervisor' | 'task';

export type ManagedAgentWatchdogPhase =
  | 'watching'
  | 'soft-grace'
  | 'escape-sent'
  | 'interrupt-sent'
  | 'paused';

export interface ManagedAgentDeadlinePolicy {
  softMs: number;
  hardMs: number;
  noLivenessGraceMs: number;
  escapeGraceMs: number;
  interruptGraceMs: number;
}

export interface ManagedAgentWatchdogRuntime {
  surfaceId: string;
  role: ManagedProjectAgentRole;
  generation: number;
  phase: ManagedAgentWatchdogPhase;
  turnStartedAt: number;
  lastLivenessAt: number;
  lastSemanticProgressAt: number;
  softDeadlineAt: number;
  hardDeadlineAt: number;
  nextDeadlineAt: number;
  outputFingerprint: string;
  sourceTask?: string;
  command?: string;
  pausedAt?: number;
  escapeSentAt?: number;
  interruptSentAt?: number;
}

export type ManagedAgentDeadlineAction = 'none' | 'escape' | 'interrupt' | 'recover';

export const MANAGED_AGENT_NO_LIVENESS_GRACE_MS = 5 * 60_000;
export const MANAGED_AGENT_ESCAPE_GRACE_MS = 5 * 60_000;
export const MANAGED_AGENT_INTERRUPT_GRACE_MS = 2 * 60_000;
export const MANAGED_AGENT_SUSPEND_SKEW_MS = 60_000;

const MIN_SOFT_MS = 10 * 60_000;
const MAX_SOFT_MS = 90 * 60_000;
const MAX_HARD_MS = 180 * 60_000;

const ROLE_BASE_MINUTES: Record<ManagedProjectAgentRole, { soft: number; hard: number }> = {
  manager: { soft: 30, hard: 90 },
  supervisor: { soft: 20, hard: 60 },
  task: { soft: 25, hard: 75 },
};

const REASONING_FACTORS: Record<string, number> = {
  low: 0.7,
  medium: 1,
  high: 1.5,
  xhigh: 2,
  max: 2.5,
  ultra: 2.5,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

/** Conservative defaults, raised only after enough successful local samples. */
export function managedAgentDeadlinePolicy(options: {
  role: ManagedProjectAgentRole;
  reasoningEffort?: string;
  complexityFactor?: number;
  successfulDurationsMs?: number[];
  taskBudgetMinutes?: number;
}): ManagedAgentDeadlinePolicy {
  const base = ROLE_BASE_MINUTES[options.role];
  const reasoning = String(options.reasoningEffort || 'medium').toLowerCase();
  const effort = REASONING_FACTORS[reasoning] || 1;
  const complexity = clamp(options.complexityFactor || 1, 0.7, 2);
  const managerMinutes = reasoning === 'low'
    ? { soft: 20, hard: 60 }
    : reasoning === 'high'
      ? { soft: 45, hard: 120 }
      : ['xhigh', 'max', 'ultra'].includes(reasoning)
        ? { soft: 60, hard: 180 }
        : { soft: 30, hard: 90 };
  const softMinutes = options.role === 'manager' ? managerMinutes.soft : base.soft * effort;
  const hardMinutes = options.role === 'manager' ? managerMinutes.hard : base.hard * effort;
  const hardCeilingMs = options.role === 'task' && options.taskBudgetMinutes
    ? 240 * 60_000
    : MAX_HARD_MS;
  let softMs = clamp(softMinutes * complexity * 60_000, MIN_SOFT_MS, MAX_SOFT_MS);
  let hardMs = clamp(hardMinutes * complexity * 60_000, softMs * 2, hardCeilingMs);
  if (options.role === 'task' && options.taskBudgetMinutes) {
    hardMs = clamp(Math.max(hardMs, options.taskBudgetMinutes * 60_000), softMs * 2, hardCeilingMs);
  }
  const history = (options.successfulDurationsMs || []).filter((value) => Number.isFinite(value) && value > 0);
  if (history.length >= 20) {
    softMs = clamp(Math.max(softMs, percentile(history, 0.95) * 1.25), MIN_SOFT_MS, MAX_SOFT_MS);
    hardMs = clamp(Math.max(hardMs, percentile(history, 0.99) * 1.5), softMs * 2, hardCeilingMs);
  }
  return {
    softMs: Math.round(softMs),
    hardMs: Math.round(hardMs),
    noLivenessGraceMs: MANAGED_AGENT_NO_LIVENESS_GRACE_MS,
    escapeGraceMs: MANAGED_AGENT_ESCAPE_GRACE_MS,
    interruptGraceMs: MANAGED_AGENT_INTERRUPT_GRACE_MS,
  };
}

/** Long commands get an explicit hard budget instead of looking like silent thought. */
export function managedCommandHardBudgetMs(command: string): number {
  const normalized = command.toLowerCase();
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install)\b|\b(?:pip|uv)\s+install\b/u.test(normalized)) {
    return 180 * 60_000;
  }
  if (/\b(?:test|vitest|jest|pytest|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\w*\s+test)\b/u.test(normalized)) {
    return 120 * 60_000;
  }
  if (/\b(?:build|compile|package|electron-builder)\b/u.test(normalized)) return 120 * 60_000;
  return 90 * 60_000;
}

/** Remove presentation-only timers/spinners so they cannot masquerade as progress. */
export function normalizeProjectActivityFingerprintText(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex -- terminal ANSI/OSC sequences are literal control bytes.
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu, '')
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/gu, '•')
    .replace(/\b(working|thinking)\s*\(\s*(?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\s*)+(?:[·•|—-]\s*)?(?:esc\s+to\s+interrupt)?\s*\)/giu, '$1')
    .replace(/\b(working|thinking)\s+for\s+(?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\s*)+/giu, '$1')
    .replace(/\b\d+\s*seconds?\s+ago\b/giu, '')
    .replace(/\d+\s*秒前/gu, '')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

/** Recognize the ordinary shell reached when Ctrl+C terminates the inner Agent. */
export function looksLikeManagedShellPrompt(text: string): boolean {
  const lines = normalizeProjectActivityFingerprintText(text)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-3).join('\n');
  return /(?:^|\n)PS\s+[A-Za-z]:\\[^\r\n>]*>\s*$/u.test(tail)
    || /(?:^|\n)[^\r\n]*@[^\r\n:]+:[^\r\n]*[$#]\s*$/u.test(tail)
    || /(?:^|\n)[A-Za-z]:\\[^\r\n>]*>\s*$/u.test(tail);
}

export function beginManagedAgentTurn(options: {
  surfaceId: string;
  role: ManagedProjectAgentRole;
  generation: number;
  now: number;
  policy: ManagedAgentDeadlinePolicy;
  sourceTask?: string;
}): ManagedAgentWatchdogRuntime {
  return {
    surfaceId: options.surfaceId,
    role: options.role,
    generation: options.generation,
    phase: 'watching',
    turnStartedAt: options.now,
    lastLivenessAt: options.now,
    lastSemanticProgressAt: options.now,
    softDeadlineAt: options.now + options.policy.softMs,
    hardDeadlineAt: options.now + options.policy.hardMs,
    nextDeadlineAt: options.now + options.policy.softMs,
    outputFingerprint: '',
    ...(options.sourceTask?.trim() ? { sourceTask: options.sourceTask.trim() } : {}),
  };
}

/** Hook-backed progress starts a fresh bounded segment; PTY animation never does. */
export function noteManagedAgentSemanticProgress(
  runtime: ManagedAgentWatchdogRuntime,
  now: number,
  policy: ManagedAgentDeadlinePolicy,
): ManagedAgentWatchdogRuntime {
  if (runtime.phase === 'paused') return runtime;
  return {
    ...runtime,
    phase: 'watching',
    lastLivenessAt: now,
    lastSemanticProgressAt: now,
    softDeadlineAt: now + policy.softMs,
    hardDeadlineAt: now + policy.hardMs,
    nextDeadlineAt: now + policy.softMs,
    escapeSentAt: undefined,
    interruptSentAt: undefined,
  };
}

export function noteManagedAgentOutput(
  runtime: ManagedAgentWatchdogRuntime,
  now: number,
  outputFingerprint: string,
): ManagedAgentWatchdogRuntime {
  if (runtime.phase === 'paused') return runtime;
  return { ...runtime, lastLivenessAt: now, outputFingerprint };
}

export function noteManagedAgentCommand(
  runtime: ManagedAgentWatchdogRuntime,
  now: number,
  command: string,
): ManagedAgentWatchdogRuntime {
  const commandHardBudgetMs = managedCommandHardBudgetMs(command);
  const hardDeadlineAt = Math.max(runtime.hardDeadlineAt, now + commandHardBudgetMs);
  const softDeadlineAt = Math.max(
    runtime.softDeadlineAt,
    now + Math.min(MAX_SOFT_MS, commandHardBudgetMs / 2),
  );
  return {
    ...runtime,
    command,
    lastLivenessAt: now,
    lastSemanticProgressAt: now,
    hardDeadlineAt,
    softDeadlineAt,
    nextDeadlineAt: Math.min(hardDeadlineAt, softDeadlineAt),
  };
}

export function pauseManagedAgentWatchdog(
  runtime: ManagedAgentWatchdogRuntime,
  now: number,
): ManagedAgentWatchdogRuntime {
  return { ...runtime, phase: 'paused', pausedAt: now, nextDeadlineAt: Number.POSITIVE_INFINITY };
}

export function resumeManagedAgentWatchdog(
  runtime: ManagedAgentWatchdogRuntime,
  now: number,
): ManagedAgentWatchdogRuntime {
  if (runtime.phase !== 'paused' || runtime.pausedAt === undefined) return runtime;
  const pausedForMs = Math.max(0, now - runtime.pausedAt);
  return {
    ...runtime,
    phase: 'watching',
    turnStartedAt: runtime.turnStartedAt + pausedForMs,
    lastLivenessAt: now,
    lastSemanticProgressAt: runtime.lastSemanticProgressAt + pausedForMs,
    softDeadlineAt: runtime.softDeadlineAt + pausedForMs,
    hardDeadlineAt: runtime.hardDeadlineAt + pausedForMs,
    nextDeadlineAt: runtime.softDeadlineAt + pausedForMs,
    pausedAt: undefined,
  };
}

/** Exclude system sleep / renderer suspension from elapsed time. */
export function shiftManagedAgentDeadlineForSuspend(
  runtime: ManagedAgentWatchdogRuntime,
  delayedByMs: number,
): ManagedAgentWatchdogRuntime {
  if (delayedByMs <= MANAGED_AGENT_SUSPEND_SKEW_MS) return runtime;
  const deadlineShiftMs = delayedByMs + MANAGED_AGENT_NO_LIVENESS_GRACE_MS;
  return {
    ...runtime,
    turnStartedAt: runtime.turnStartedAt + delayedByMs,
    lastLivenessAt: runtime.lastLivenessAt + delayedByMs,
    lastSemanticProgressAt: runtime.lastSemanticProgressAt + delayedByMs,
    softDeadlineAt: runtime.softDeadlineAt + deadlineShiftMs,
    hardDeadlineAt: runtime.hardDeadlineAt + deadlineShiftMs,
    nextDeadlineAt: runtime.nextDeadlineAt + deadlineShiftMs,
    ...(runtime.escapeSentAt ? { escapeSentAt: runtime.escapeSentAt + deadlineShiftMs } : {}),
    ...(runtime.interruptSentAt ? { interruptSentAt: runtime.interruptSentAt + deadlineShiftMs } : {}),
  };
}

/** Pure one-shot deadline transition; callers arm exactly `nextDeadlineAt`. */
export function evaluateManagedAgentDeadline(options: {
  runtime: ManagedAgentWatchdogRuntime;
  now: number;
  policy: ManagedAgentDeadlinePolicy;
}): { action: ManagedAgentDeadlineAction; runtime: ManagedAgentWatchdogRuntime } {
  const { now, policy } = options;
  const runtime = { ...options.runtime };
  if (runtime.phase === 'paused' || now < runtime.nextDeadlineAt) return { action: 'none', runtime };

  if (runtime.phase === 'escape-sent') {
    runtime.phase = 'interrupt-sent';
    runtime.interruptSentAt = now;
    runtime.nextDeadlineAt = now + policy.interruptGraceMs;
    return { action: 'interrupt', runtime };
  }
  if (runtime.phase === 'interrupt-sent') return { action: 'recover', runtime };

  if (now >= runtime.hardDeadlineAt) {
    runtime.phase = 'escape-sent';
    runtime.escapeSentAt = now;
    runtime.nextDeadlineAt = now + policy.escapeGraceMs;
    return { action: 'escape', runtime };
  }

  const hasRecentLiveness = runtime.lastLivenessAt > runtime.lastSemanticProgressAt;
  if (hasRecentLiveness) {
    runtime.nextDeadlineAt = runtime.hardDeadlineAt;
    return { action: 'none', runtime };
  }

  if (runtime.phase === 'soft-grace') {
    runtime.phase = 'escape-sent';
    runtime.escapeSentAt = now;
    runtime.nextDeadlineAt = now + policy.escapeGraceMs;
    return { action: 'escape', runtime };
  }

  runtime.phase = 'soft-grace';
  runtime.nextDeadlineAt = Math.min(runtime.hardDeadlineAt, now + policy.noLivenessGraceMs);
  return { action: 'none', runtime };
}
