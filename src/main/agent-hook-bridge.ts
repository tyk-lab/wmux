/**
 * Agent lifecycle hooks → declared agent state (issue #128).
 *
 * The protocol in agent-state.ts is agent-agnostic: anything that can write a
 * line of JSON to the wmux pipe can drive it. Supported agents expose the
 * transitions through their native hook or extension systems:
 *
 *   PostToolUse   — a tool just finished running
 *   Notification  — the agent wants the user's attention
 *   Stop          — the turn is over
 *   SubagentStop  — one parallel subagent finished
 *
 * Translating those into report_agent calls provides the "which pane needs me?"
 * signal without output scraping or polling.
 *
 * These hooks are lifecycle truth from the agent process itself, which is the
 * same reasoning that made hooks — not output parsing — authoritative for the
 * sidebar's agent lines (issue #81 class).
 */

import { SurfaceId } from '../shared/types';
import { reportAgent, ReportAgentParams } from './agent-state';

/**
 * Hook event names we translate into declared agent state.
 * Shared by Kimi, Codex, Grok and any harness that emits the same names
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

const handledHookEventIds = new Set<string>();
const MAX_HANDLED_HOOK_EVENT_IDS = 1024;

/** Accept one hook helper process once even when an ACK loss causes a retry. */
export function acceptHookEventId(value: unknown): boolean {
  const hookId = typeof value === 'string' ? value.trim() : '';
  if (!hookId) return true;
  if (handledHookEventIds.has(hookId)) return false;
  handledHookEventIds.add(hookId);
  if (handledHookEventIds.size > MAX_HANDLED_HOOK_EVENT_IDS) {
    handledHookEventIds.delete(handledHookEventIds.values().next().value as string);
  }
  return true;
}

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
    // Turn start. Marks working even when the
    // turn never touches a tool (pure text replies).
    case 'UserPromptSubmit':
      return { awaitingHuman: false, runDepth: 1 };

    case 'PreToolUse':
      return { awaitingHuman: false, runDepth: 1 };

    // The agent wants the user. This fires both for permission/question
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
