/**
 * Copy + dedupe for agent lifecycle notifications (Stop / needs-input).
 *
 * Notification panel layout (three lines):
 *   1. Session name  — workspace title (panel source, not this module)
 *   2. Status        — e.g. "Turn complete · Kimi · tyk-kimi"
 *   3. Time          — "just now" (panel clock, not this module)
 */

export type LifecycleNotifyKind = 'needs_input' | 'turn_finished';

/** Supervision owns user-facing status while it is actively scheduling lanes. */
export function shouldNotifyAgentLifecycle(supervisorActive: boolean): boolean {
  return !supervisorActive;
}

export interface LifecycleNotifyInput {
  kind: LifecycleNotifyKind;
  /** Product name: Claude / Kimi / Codex / Grok / Pi / OpenCode. */
  agent?: string | null;
  /** Pane label: tab title, cwd folder, wrap --label, … */
  where?: string | null;
  /** Permission / prompt message from the agent, when present. */
  message?: string | null;
}

const MAX_MESSAGE = 72;

/** Known harness names inferred from labels / cwd / metadata. */
const AGENT_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /\bkimi\b/i, name: 'Kimi' },
  { re: /\bclaude\b/i, name: 'Claude' },
  { re: /\bcodex\b/i, name: 'Codex' },
  { re: /\bgrok\b/i, name: 'Grok' },
  { re: /\bpi(?:\s+agent)?\b/i, name: 'Pi' },
  { re: /\bopencode\b/i, name: 'OpenCode' },
];

function truncate(text: string, max = MAX_MESSAGE): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Infer a display agent name from free-text candidates (label, cwd, model, …).
 * First match wins.
 */
export function inferAgentName(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const raw of candidates) {
    if (!raw || !raw.trim()) continue;
    for (const { re, name } of AGENT_PATTERNS) {
      if (re.test(raw)) return name;
    }
  }
  return null;
}

/** Join agent + where without dumb duplicates ("Kimi · Kimi"). */
export function joinAgentIdentity(
  agent?: string | null,
  where?: string | null,
): string {
  const a = agent?.trim() || '';
  const w = where?.trim() || '';
  if (a && w) {
    if (a.toLowerCase() === w.toLowerCase()) return a;
    return `${a} · ${w}`;
  }
  return a || w || '';
}

/**
 * Line 2 body for the notification list / OS toast.
 * Does not include the workspace title (line 1) or the time (line 3).
 */
export function formatAgentLifecycleText(input: LifecycleNotifyInput): string {
  const identity = joinAgentIdentity(input.agent, input.where);

  if (input.kind === 'needs_input') {
    const msg = input.message?.trim();
    if (msg) {
      const body = truncate(msg);
      return identity ? `${body} · ${identity}` : body;
    }
    return identity ? `Needs your input · ${identity}` : 'Needs your input';
  }

  // turn_finished — user-facing "Turn complete"
  return identity ? `Turn complete · ${identity}` : 'Turn complete';
}

/** Dedupe window for identical lifecycle keys (double Stop, twin hooks, …). */
export const LIFECYCLE_DEDUP_MS = 4_000;

export interface LifecycleDedupeStamp {
  key: string;
  at: number;
}

/**
 * Build a stable dedupe key. Prefer surfaceId so two panes in one workspace
 * each get their own notify; fall back to workspace + kind.
 */
export function lifecycleDedupeKey(
  kind: LifecycleNotifyKind,
  surfaceId: string | undefined | null,
  workspaceId: string | undefined | null,
): string {
  if (surfaceId) return `${kind}:surf:${surfaceId}`;
  if (workspaceId) return `${kind}:ws:${workspaceId}`;
  return `${kind}:global`;
}

/** True when this event should be suppressed as a duplicate of `last`. */
export function shouldDedupeLifecycleNotify(
  last: LifecycleDedupeStamp | null | undefined,
  key: string,
  now: number,
  windowMs = LIFECYCLE_DEDUP_MS,
): boolean {
  if (!last) return false;
  return last.key === key && now - last.at < windowMs;
}
