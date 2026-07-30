/**
 * Copy + dedupe for agent lifecycle notifications (Stop / needs-input).
 *
 * The panel already shows the workspace name as the source line, so the body
 * must not repeat it. Branding stays agent-agnostic (Claude / Kimi / Codex / …).
 */

export type LifecycleNotifyKind = 'needs_input' | 'turn_finished';

export interface LifecycleNotifyInput {
  kind: LifecycleNotifyKind;
  /** Tab title, cwd folder, or agent label — distinguishes panes in one workspace. */
  where?: string | null;
  /** Permission / prompt message from the agent, when present. */
  message?: string | null;
}

const MAX_MESSAGE = 80;

function truncate(text: string, max = MAX_MESSAGE): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Body text for the notification list / OS toast.
 * Workspace title is omitted — `NotificationPanel` already renders it as source.
 */
export function formatAgentLifecycleText(input: LifecycleNotifyInput): string {
  const where = input.where?.trim() || '';

  if (input.kind === 'needs_input') {
    const msg = input.message?.trim();
    if (msg) {
      const body = truncate(msg);
      return where ? `${body} · ${where}` : body;
    }
    return where ? `Needs your input · ${where}` : 'Needs your input';
  }

  // turn_finished
  return where ? `Turn finished · ${where}` : 'Turn finished';
}

/** Dedupe window for identical lifecycle keys (double Stop, twin hooks, …). */
export const LIFECYCLE_DEDUP_MS = 4_000;

export interface LifecycleDedupeStamp {
  key: string;
  at: number;
}

/**
 * Build a stable dedupe key. Prefer surfaceId so two panes in one workspace
 * each get their own "Turn finished"; fall back to workspace + kind.
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
