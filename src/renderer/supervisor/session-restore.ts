import type { SplitNode, SurfaceRef } from '../../shared/types';

/** Session restore is a cold-start operation; an HMR remount must keep live terminals. */
export function shouldInitializeWorkspaceLayout(existingWorkspaceCount: number): boolean {
  return existingWorkspaceCount === 0;
}

/** Agent runtimes are transient; the ordinary status page itself is safe to restore beside the task terminal. */
export function isTransientSupervisorSurface(surface: SurfaceRef): boolean {
  return (surface.type === 'supervisor' && !!surface.projectSupervisorProjectId)
    || surface.transientSupervisor === true
    || surface.userRecordsTerminal === true
    || !!surface.projectManagerProjectId;
}

function stripTransientSurfacesFromTree(tree: SplitNode, transientSurfaceIds: ReadonlySet<string>): SplitNode | null {
  if (tree.type === 'leaf') {
    const restorableCompanionExists = tree.surfaces.some((surface) => (
      surface.type !== 'supervisor'
      && surface.type !== 'diff'
      && !isTransientSupervisorSurface(surface)
      && !transientSurfaceIds.has(surface.id)
    ));
    const surfaces = tree.surfaces.filter((surface) => {
      if (surface.type === 'supervisor' && !surface.projectSupervisorProjectId) {
        return restorableCompanionExists;
      }
      return surface.type !== 'diff'
        && !isTransientSupervisorSurface(surface)
        && !transientSurfaceIds.has(surface.id);
    });
    if (surfaces.length === 0) return null;

    const previousActive = tree.surfaces[tree.activeSurfaceIndex];
    const activeSurfaceIndex = previousActive
      ? surfaces.findIndex((surface) => surface.id === previousActive.id)
      : -1;
    return {
      ...tree,
      surfaces,
      activeSurfaceIndex: activeSurfaceIndex >= 0
        ? activeSurfaceIndex
        : Math.min(tree.activeSurfaceIndex, surfaces.length - 1),
    };
  }

  const left = stripTransientSurfacesFromTree(tree.children[0], transientSurfaceIds);
  const right = stripTransientSurfacesFromTree(tree.children[1], transientSurfaceIds);
  if (!left) return right;
  if (!right) return left;
  return { ...tree, children: [left, right] };
}

function treeHasSshSurface(tree: SplitNode): boolean {
  if (tree.type === 'leaf') {
    return tree.surfaces.some((surface) => {
      if (
        surface.sshRemote
        || surface.sshProfileId
        || surface.sshFileWorkspaceId
        || surface.sshControllerTargetSurfaceId
      ) return true;
      return typeof surface.shell === 'string'
        && /^\s*ssh(?:\.exe)?(?:\s|$)/i.test(surface.shell);
    });
  }
  return treeHasSshSurface(tree.children[0]) || treeHasSshSurface(tree.children[1]);
}

function isSshWorkspace<T extends {
  splitTree: SplitNode;
  sshProfileId?: string;
  shell?: string;
}>(workspace: T): boolean {
  if (workspace.sshProfileId) return true;
  return /^\s*ssh(?:\.exe)?(?:\s|$)/i.test(workspace.shell || '')
    || treeHasSshSurface(workspace.splitTree);
}

/**
 * Supervision and project task Agents own native conversations that cannot
 * survive a process restart, and Diff is an on-demand view. SSH workspaces
 * (managed profiles, companions, and legacy layouts) stay closed across restart.
 */
export function omitNonRestorableWorkspaces<T extends {
  splitTree: SplitNode;
  title?: string;
  transientSupervisorWorkspace?: boolean;
  sshProfileId?: string;
}>(
  workspaces: T[],
  activeIndex = 0,
  transientSurfaceIds: Iterable<string> = [],
): { workspaces: T[]; activeIndex: number } {
  const transientIds = new Set(transientSurfaceIds);
  let nextActiveIndex: number | null = null;
  const retained: T[] = [];

  workspaces.forEach((workspace, index) => {
    if (workspace.transientSupervisorWorkspace || workspace.title?.trim() === 'AI 监督') return;
    if (isSshWorkspace(workspace)) return;
    const splitTree = stripTransientSurfacesFromTree(workspace.splitTree, transientIds);
    if (!splitTree) return;
    if (index === activeIndex) nextActiveIndex = retained.length;
    retained.push({ ...workspace, splitTree });
  });

  return {
    workspaces: retained,
    activeIndex: nextActiveIndex ?? Math.min(Math.max(activeIndex, 0), Math.max(retained.length - 1, 0)),
  };
}
