import type { SplitNode, SurfaceRef } from '../../shared/types';

/** Dedicated supervisor terminals are transient: their state lives only in the active renderer session. */
export function isTransientSupervisorSurface(surface: SurfaceRef): boolean {
  return surface.type === 'supervisor' || surface.transientSupervisor === true;
}

function stripSupervisorSurfacesFromTree(tree: SplitNode, transientSurfaceIds: ReadonlySet<string>): SplitNode | null {
  if (tree.type === 'leaf') {
    const surfaces = tree.surfaces.filter((surface) =>
      !isTransientSupervisorSurface(surface) && !transientSurfaceIds.has(surface.id),
    );
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

  const left = stripSupervisorSurfacesFromTree(tree.children[0], transientSurfaceIds);
  const right = stripSupervisorSurfacesFromTree(tree.children[1], transientSurfaceIds);
  if (!left) return right;
  if (!right) return left;
  return { ...tree, children: [left, right] };
}

/**
 * AI supervision has no restart-safe renderer state, so omit its terminal and
 * panel surfaces from auto/named session layouts instead of restoring a stale shell.
 */
export function omitTransientSupervisorWorkspaces<T extends { splitTree: SplitNode }>(
  workspaces: T[],
  activeIndex = 0,
  transientSurfaceIds: Iterable<string> = [],
): { workspaces: T[]; activeIndex: number } {
  const transientIds = new Set(transientSurfaceIds);
  let nextActiveIndex: number | null = null;
  const retained: T[] = [];

  workspaces.forEach((workspace, index) => {
    const splitTree = stripSupervisorSurfacesFromTree(workspace.splitTree, transientIds);
    if (!splitTree) return;
    if (index === activeIndex) nextActiveIndex = retained.length;
    retained.push({ ...workspace, splitTree });
  });

  return {
    workspaces: retained,
    activeIndex: nextActiveIndex ?? Math.min(Math.max(activeIndex, 0), Math.max(retained.length - 1, 0)),
  };
}
