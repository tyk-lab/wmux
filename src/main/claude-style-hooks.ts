/**
 * Claude / Codex / Grok share the same nested hooks JSON shape:
 *
 *   { hooks: { EventName: [ { matcher?, hooks: [ { type, command } ] } ] } }
 *
 * Pure merge helpers so each ensure* installer stays thin and unit-testable.
 */

import { makeWmuxHookEventCommand } from './wmux-hook-path';

/** Turn-level events every supported agent understands (or safely ignores). */
export const WMUX_LIFECYCLE_EVENTS = [
  'UserPromptSubmit',
  'PostToolUse',
  'Notification',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'SubagentStop',
] as const;

export type WmuxLifecycleEvent = (typeof WMUX_LIFECYCLE_EVENTS)[number];

export function isWmuxHookCommand(command: string | undefined | null): boolean {
  if (!command) return false;
  return command.includes('wmux-hook') || /wmux["']?\s+report-agent/.test(command);
}

/** Drop matcher groups that only exist to run wmux (preserve user hooks). */
export function stripWmuxHookGroups(entries: unknown): any[] {
  return (Array.isArray(entries) ? entries : []).filter((e: any) => {
    if (!Array.isArray(e?.hooks)) return true;
    return !e.hooks.some((h: any) => isWmuxHookCommand(h?.command));
  });
}

function makeEventGroup(hookScriptPosix: string, event: string): any {
  return {
    hooks: [{
      type: 'command',
      command: makeWmuxHookEventCommand(hookScriptPosix, event),
      timeout: 10,
    }],
  };
}

/**
 * Merge wmux lifecycle handlers into a Claude-style hooks root object.
 * `root` may be the whole settings file (`{ hooks: {...} }`) or just the
 * inner `hooks` map — both are accepted.
 */
export function applyWmuxLifecycleHooks(
  root: any,
  hookScriptPosix: string,
  events: readonly string[] = WMUX_LIFECYCLE_EVENTS,
): any {
  const isFullSettings = root && typeof root === 'object' && root.hooks !== undefined
    && !WMUX_LIFECYCLE_EVENTS.some((e) => Array.isArray(root[e]));
  const next = isFullSettings
    ? { ...root, hooks: { ...(root.hooks || {}) } }
    : { ...(root || {}) };
  const hooksMap = isFullSettings ? next.hooks : next;

  for (const event of events) {
    hooksMap[event] = [
      ...stripWmuxHookGroups(hooksMap[event]),
      makeEventGroup(hookScriptPosix, event),
    ];
  }

  return next;
}

/** Build a standalone hooks.json body managed entirely by wmux. */
export function buildWmuxHooksJsonFile(
  hookScriptPosix: string,
  description: string,
  events: readonly string[] = WMUX_LIFECYCLE_EVENTS,
): any {
  const hooks: Record<string, any[]> = {};
  for (const event of events) {
    hooks[event] = [makeEventGroup(hookScriptPosix, event)];
  }
  return {
    description,
    hooks,
  };
}
