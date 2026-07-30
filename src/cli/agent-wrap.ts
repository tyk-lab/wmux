/**
 * `wmux wrap` — process-level agent lifecycle for harnesses without hooks.
 *
 * Spawns an arbitrary command and, when running inside a wmux pane
 * (WMUX_SURFACE_ID / --surface), bookends it with report-agent:
 *   start → runDepth +1 (working)
 *   exit  → runDepth 0 + release (idle / forget)
 *
 * This cannot see permission prompts (no native hooks) — only process
 * boundaries. Per-agent ensure* hooks remain the path for blocked/turn detail.
 */

export interface WrapPlan {
  /** Optional display label (reserved for future report-metadata). */
  label?: string;
  /** Surface to report against; undefined ⇒ passthrough, no reporting. */
  surfaceId?: string;
  cmd: string;
  cmdArgs: string[];
}

export type WrapParseResult =
  | { ok: true; plan: WrapPlan }
  | { ok: false; error: string };

/**
 * Parse `wmux wrap …` argv (args[0] is the command name `wrap`).
 * Does not read env — caller supplies ambientSurface (typically WMUX_SURFACE_ID).
 */
export function parseWrapArgs(args: string[], ambientSurface?: string): WrapParseResult {
  let i = 1;
  let label: string | undefined;
  let surfaceFlag: string | undefined;

  while (i < args.length) {
    const a = args[i];
    if (a === '--') {
      i += 1;
      break;
    }
    if (a === '--label') {
      if (!args[i + 1]) return { ok: false, error: 'wrap: --label requires a value' };
      label = args[i + 1];
      i += 2;
      continue;
    }
    if (a === '--surface') {
      if (!args[i + 1]) return { ok: false, error: 'wrap: --surface requires a value' };
      surfaceFlag = args[i + 1];
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, error: `wrap: unknown flag ${a}` };
    }
    break;
  }

  if (i >= args.length) {
    return {
      ok: false,
      error: 'wrap: missing command\nUsage: wmux wrap [--label L] [--surface id] [--] <cmd> [args...]',
    };
  }

  return {
    ok: true,
    plan: {
      label,
      surfaceId: surfaceFlag || ambientSurface || undefined,
      cmd: args[i],
      cmdArgs: args.slice(i + 1),
    },
  };
}

/** True when wrap should emit report-agent around the child. */
export function shouldTrackAgent(plan: WrapPlan): boolean {
  return Boolean(plan.surfaceId);
}
