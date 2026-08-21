/**
 * Codex and Grok share the same nested lifecycle-hooks JSON shape:
 *
 *   { hooks: { EventName: [ { matcher?, hooks: [ { type, command } ] } ] } }
 *
 * Pure merge helpers keep each ensure* installer thin and unit-testable.
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

export interface WmuxLifecycleEventBinding {
  /** Native event name used in the agent's hook configuration. */
  hookEvent: string;
  /** Normalized event reported to wmux when it differs from the native name. */
  protocolEvent?: string;
}

export type WmuxLifecycleEventSpec = string | WmuxLifecycleEventBinding;

export function isWmuxHookCommand(command: string | undefined | null): boolean {
  if (!command) return false;
  return command.includes('wmux-hook') || /wmux["']?\s+report-agent/.test(command);
}

/** Remove wmux commands while preserving user commands in the same matcher group. */
export function stripWmuxHookGroups(entries: unknown): any[] {
  return (Array.isArray(entries) ? entries : []).flatMap((entry: any) => {
    if (!Array.isArray(entry?.hooks)) return [entry];
    const hooks = entry.hooks.filter((hook: any) => !isWmuxHookCommand(hook?.command));
    if (hooks.length === entry.hooks.length) return [entry];
    return hooks.length > 0 ? [{ ...entry, hooks }] : [];
  });
}

function makeEventGroup(hookScriptPosix: string, event: string, agent?: string): any {
  return {
    hooks: [{
      type: 'command',
      command: makeWmuxHookEventCommand(hookScriptPosix, event, agent),
      timeout: 10,
    }],
  };
}

/**
 * Merge wmux lifecycle handlers into a nested hooks root object. `root` may be
 * the whole settings file (`{ hooks: {...} }`) or just the inner hooks map.
 */
export function applyWmuxLifecycleHooks(
  root: any,
  hookScriptPosix: string,
  events: readonly WmuxLifecycleEventSpec[] = WMUX_LIFECYCLE_EVENTS,
  agent?: string,
): any {
  const isFullSettings = root && typeof root === 'object' && root.hooks !== undefined
    && !events.some((spec) => Array.isArray(root[typeof spec === 'string' ? spec : spec.hookEvent]));
  const next = isFullSettings
    ? { ...root, hooks: { ...(root.hooks || {}) } }
    : { ...(root || {}) };
  const hooksMap = isFullSettings ? next.hooks : next;

  // Remove stale wmux-owned handlers first. This matters when an agent drops
  // support for an event, while preserving every user-owned matcher group.
  for (const [event, entries] of Object.entries(hooksMap)) {
    if (!Array.isArray(entries)) continue;
    const remaining = stripWmuxHookGroups(entries);
    if (remaining.length > 0) hooksMap[event] = remaining;
    else delete hooksMap[event];
  }

  for (const spec of events) {
    const binding = typeof spec === 'string'
      ? { hookEvent: spec, protocolEvent: spec }
      : { ...spec, protocolEvent: spec.protocolEvent || spec.hookEvent };
    hooksMap[binding.hookEvent] = [
      ...stripWmuxHookGroups(hooksMap[binding.hookEvent]),
      makeEventGroup(hookScriptPosix, binding.protocolEvent, agent),
    ];
  }

  return next;
}

/** Build a standalone hooks.json body managed entirely by wmux. */
export function buildWmuxHooksJsonFile(
  hookScriptPosix: string,
  description: string,
  events: readonly WmuxLifecycleEventSpec[] = WMUX_LIFECYCLE_EVENTS,
  agent?: string,
): any {
  const hooks: Record<string, any[]> = {};
  for (const spec of events) {
    const binding = typeof spec === 'string'
      ? { hookEvent: spec, protocolEvent: spec }
      : { ...spec, protocolEvent: spec.protocolEvent || spec.hookEvent };
    hooks[binding.hookEvent] = [makeEventGroup(hookScriptPosix, binding.protocolEvent, agent)];
  }
  return {
    description,
    hooks,
  };
}
