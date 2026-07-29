import type { SplitNode } from '../../shared/types';

/** Shell-integration report_shell_state values. */
export type ShellState = 'idle' | 'running' | 'interrupted';

/** True while a foreground command is executing. */
export function isShellBusy(state: ShellState | undefined): boolean {
  return state === 'running';
}

/**
 * Aggregate per-terminal shell states into one workspace status.
 *
 * - Any terminal running → `running` (session is busy)
 * - Else any interrupted → `interrupted`
 * - Else any idle (and none busy) → `idle` (session is fully idle)
 * - No known states → undefined
 */
export function aggregateShellStates(
  states: Array<ShellState | undefined | null>,
): ShellState | undefined {
  let hasRunning = false;
  let hasInterrupted = false;
  let hasIdle = false;

  for (const state of states) {
    if (state === 'running') hasRunning = true;
    else if (state === 'interrupted') hasInterrupted = true;
    else if (state === 'idle') hasIdle = true;
  }

  if (hasRunning) return 'running';
  if (hasInterrupted) return 'interrupted';
  if (hasIdle) return 'idle';
  return undefined;
}

/** Collect terminal surface ids under a split tree (browser/markdown/diff ignored). */
export function getTerminalSurfaceIds(tree: SplitNode): string[] {
  if (tree.type === 'leaf') {
    return tree.surfaces.filter((s) => s.type === 'terminal').map((s) => s.id);
  }
  return [
    ...getTerminalSurfaceIds(tree.children[0]),
    ...getTerminalSurfaceIds(tree.children[1]),
  ];
}

/**
 * Aggregate shell states for every terminal in a workspace tree, using a
 * surfaceId → state map. Surfaces with no entry contribute nothing.
 */
export function aggregateWorkspaceShellState(
  tree: SplitNode,
  surfaceShellStates: Record<string, ShellState>,
): ShellState | undefined {
  const ids = getTerminalSurfaceIds(tree);
  return aggregateShellStates(ids.map((id) => surfaceShellStates[id]));
}

/** Transition from busy → fully idle/interrupted (attention + flash edge). */
export function isBusyToIdleTransition(
  prev: ShellState | undefined,
  next: ShellState | undefined,
): boolean {
  return prev === 'running' && (next === 'idle' || next === 'interrupted');
}
