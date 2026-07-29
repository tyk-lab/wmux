import { StateCreator } from 'zustand';
import type { WorkspaceId } from '../../shared/types';
import type { WorkspaceSlice } from './workspace-slice';
import {
  ShellState,
  aggregateWorkspaceShellState,
  getTerminalSurfaceIds,
  isBusyToIdleTransition,
} from './shell-state';

export interface ShellStateApplyResult {
  workspaceId: WorkspaceId | null;
  prevAgg: ShellState | undefined;
  nextAgg: ShellState | undefined;
  /** True when the workspace just became fully idle after being busy. */
  becameIdle: boolean;
}

export interface ShellActivitySlice {
  /** Per-terminal shell state from shell integration (runtime only). */
  surfaceShellStates: Record<string, ShellState>;
  /**
   * Workspaces that finished work and need attention (sidebar blink / taskbar
   * flash). Cleared when the user focuses the workspace or the window.
   */
  workspaceAttention: Record<string, boolean>;

  /**
   * Update one terminal's shell state and re-aggregate the owning workspace.
   * Pass null to drop the entry (PTY exit / tab close).
   */
  setSurfaceShellState: (
    surfaceId: string,
    state: ShellState | null,
  ) => ShellStateApplyResult;

  markWorkspaceAttention: (workspaceId: WorkspaceId) => void;
  clearWorkspaceAttention: (workspaceId: WorkspaceId) => void;
  clearAllAttention: () => void;
}

function findWorkspaceForSurface(
  workspaces: WorkspaceSlice['workspaces'],
  surfaceId: string,
) {
  for (const ws of workspaces) {
    const ids = getTerminalSurfaceIds(ws.splitTree);
    // Also match non-terminal ids that somehow reported (defensive): walk all surfaces.
    if (treeHasSurfaceId(ws.splitTree, surfaceId) || ids.includes(surfaceId)) {
      return ws;
    }
  }
  return undefined;
}

function treeHasSurfaceId(tree: WorkspaceSlice['workspaces'][0]['splitTree'], surfaceId: string): boolean {
  if (tree.type === 'leaf') return tree.surfaces.some((s) => s.id === surfaceId);
  return treeHasSurfaceId(tree.children[0], surfaceId) || treeHasSurfaceId(tree.children[1], surfaceId);
}

export const createShellActivitySlice: StateCreator<
  ShellActivitySlice & WorkspaceSlice,
  [],
  [],
  ShellActivitySlice
> = (set, get) => ({
  surfaceShellStates: {},
  workspaceAttention: {},

  setSurfaceShellState(surfaceId, state): ShellStateApplyResult {
    const empty: ShellStateApplyResult = {
      workspaceId: null,
      prevAgg: undefined,
      nextAgg: undefined,
      becameIdle: false,
    };
    if (!surfaceId) return empty;

    const ws = findWorkspaceForSurface(get().workspaces, surfaceId);
    if (!ws) {
      // Still record the state so a late-arriving surface can resolve later.
      set((s) => {
        if (state === null) {
          if (!(surfaceId in s.surfaceShellStates)) return s;
          const next = { ...s.surfaceShellStates };
          delete next[surfaceId];
          return { surfaceShellStates: next };
        }
        if (s.surfaceShellStates[surfaceId] === state) return s;
        return {
          surfaceShellStates: { ...s.surfaceShellStates, [surfaceId]: state },
        };
      });
      return empty;
    }

    const prevAgg = ws.shellState;
    const prevMap = get().surfaceShellStates;
    const nextMap = { ...prevMap };
    if (state === null) delete nextMap[surfaceId];
    else nextMap[surfaceId] = state;

    const nextAgg = aggregateWorkspaceShellState(ws.splitTree, nextMap);
    const becameIdle = isBusyToIdleTransition(prevAgg, nextAgg);

    set((s) => {
      const workspaces = s.workspaces.map((w) =>
        w.id === ws.id ? { ...w, shellState: nextAgg } : w,
      );
      let workspaceAttention = s.workspaceAttention;
      // Going busy again clears attention until the next idle edge.
      if (nextAgg === 'running' && workspaceAttention[ws.id]) {
        workspaceAttention = { ...workspaceAttention };
        delete workspaceAttention[ws.id];
      }
      return { surfaceShellStates: nextMap, workspaces, workspaceAttention };
    });

    return {
      workspaceId: ws.id,
      prevAgg,
      nextAgg,
      becameIdle,
    };
  },

  markWorkspaceAttention(workspaceId) {
    set((s) => {
      if (s.workspaceAttention[workspaceId]) return s;
      return {
        workspaceAttention: { ...s.workspaceAttention, [workspaceId]: true },
      };
    });
  },

  clearWorkspaceAttention(workspaceId) {
    set((s) => {
      if (!s.workspaceAttention[workspaceId]) return s;
      const next = { ...s.workspaceAttention };
      delete next[workspaceId];
      return { workspaceAttention: next };
    });
  },

  clearAllAttention() {
    set((s) => {
      if (Object.keys(s.workspaceAttention).length === 0) return s;
      return { workspaceAttention: {} };
    });
  },
});
