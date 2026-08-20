/**
 * Claude Code hooks → declared agent state (issue #128).
 *
 * The protocol in agent-state.ts is agent-agnostic: anything that can write a
 * line of JSON to the wmux pipe can drive it. But Claude Code is what most wmux
 * panes actually run, and wmux ALREADY configures four of its hooks in
 * ~/.claude/settings.json (see ensureClaudeHooks in claude-context.ts):
 *
 *   PostToolUse   — a tool just finished running
 *   Notification  — Claude Code wants the user's attention
 *   Stop          — the turn is over
 *   SubagentStop  — one parallel subagent finished
 *
 * Translating those into report_agent calls means the "which pane needs me?"
 * signal works for Claude Code with zero install: no plugin, no wrapper, no
 * opt-in. Other agents (OpenCode, custom harnesses) call the pipe directly.
 *
 * These hooks are lifecycle truth from the agent process itself, which is the
 * same reasoning that made hooks — not output parsing — authoritative for the
 * sidebar's agent lines (issue #81 class).
 */

import { SurfaceId } from '../shared/types';
import { reportAgent, ReportAgentParams } from './agent-state';

/**
 * Hook event names we translate into declared agent state.
 * Shared by Claude Code, Kimi Code, and any harness that emits the same names
 * via `wmux-hook.js --event <Name>` / `wmux hook --event <Name>`.
 */
export type AgentHookEvent =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'PermissionRequest'
  | 'PermissionResult'
  | 'Stop'
  | 'StopFailure'
  | 'Interrupt'
  | 'SubagentStop';

/** @deprecated Use AgentHookEvent — kept for existing imports/tests. */
export type ClaudeHookEvent = AgentHookEvent;

const KNOWN_EVENTS: readonly AgentHookEvent[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'PermissionRequest',
  'PermissionResult',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SubagentStop',
];

export function isAgentHookTerminalEvent(event: unknown): boolean {
  return event === 'Stop' || event === 'StopFailure' || event === 'Interrupt';
}

/**
 * Map one lifecycle hook event to a report_agent payload, or null to ignore it.
 */
export function hookToAgentReport(
  event: AgentHookEvent,
  message: string | null,
): ReportAgentParams | null {
  switch (event) {
    // Turn start (Claude / Kimi / Codex-style). Marks working even when the
    // turn never touches a tool (pure text replies).
    case 'UserPromptSubmit':
      return { awaitingHuman: false, runDepth: 1 };

    case 'PreToolUse':
      return { awaitingHuman: false, runDepth: 1 };

    // Claude Code / Kimi wants the user. This fires both for permission/question
    // prompts and for idle nudges; we park the pane for both — sniffing message
    // text to tell them apart fails the dangerous direction when copy changes.
    case 'Notification':
    case 'PermissionRequest':
      return { awaitingHuman: true, reason: message };

    // Human answered a permission prompt; turn may still be in flight.
    case 'PermissionResult':
      return { awaitingHuman: false };

    // A tool finished, so a turn is in flight — and nobody is parked on a
    // prompt, because a pending permission dialog would have stopped the tool
    // from running at all.
    //
    // Absolute runDepth rather than a delta: this fires on EVERY tool call and
    // nothing decrements per-call, so `runDelta: +1` would climb forever. An
    // absolute value is idempotent — five hundred tool calls still leave the
    // depth at 1.
    case 'PostToolUse':
      return { awaitingHuman: false, runDepth: 1 };

    // One parallel subagent finished. The outer turn normally continues, so
    // this decrements rather than clearing — that is the whole reason runDepth
    // is a refcount. reportAgent clamps at zero, so an unbalanced decrement
    // (a subagent whose start we never saw) cannot go negative.
    case 'SubagentStop':
      return { runDelta: -1 };

    // The turn is over (or failed / interrupted): decisive idle so no ghost
    // "working" survives a dropped earlier event.
    case 'Stop':
    case 'StopFailure':
    case 'Interrupt':
      return { awaitingHuman: false, runDepth: 0 };

    default:
      return null;
  }
}

/**
 * Apply a lifecycle hook event to the declared agent state for `surfaceId`.
 * Called from the hook.event pipe handler in index.ts.
 */
export function applyHookToAgentState(
  surfaceId: SurfaceId,
  event: string,
  message: string | null,
): void {
  if (!KNOWN_EVENTS.includes(event as AgentHookEvent)) return;

  const params = hookToAgentReport(event as AgentHookEvent, message);
  if (!params) return;
  reportAgent(surfaceId, params);
}
