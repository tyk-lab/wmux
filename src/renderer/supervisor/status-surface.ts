import type { PaneId, SurfaceId, WorkspaceId } from '../../shared/types';
import { useStore } from '../store';
import { findLeaf, getAllPaneIds } from '../store/split-utils';

export interface OrdinarySupervisorStatusSurfaceResult {
  surfaceId: SurfaceId;
  created: boolean;
}

/** Ensure the ordinary supervision status page lives beside its task/supervisor terminals. */
export function ensureOrdinarySupervisorStatusSurface(
  workspaceId: WorkspaceId,
  paneId: PaneId,
  activate = false,
): OrdinarySupervisorStatusSurfaceResult | null {
  const store = useStore.getState();
  const workspace = store.workspaces.find((candidate) => candidate.id === workspaceId);
  const pane = workspace ? findLeaf(workspace.splitTree, paneId) : null;
  let surfaceId = pane?.surfaces.find((surface) => (
    surface.type === 'supervisor' && !surface.projectSupervisorProjectId
  ))?.id;
  let created = false;
  if (!surfaceId) {
    surfaceId = store.addSurface(workspaceId, paneId, 'supervisor', {
      customTitle: '普通监督状态',
    }) || undefined;
    created = !!surfaceId;
  }
  if (!surfaceId) return null;
  if (activate) {
    const refreshedWorkspace = useStore.getState().workspaces.find((candidate) => candidate.id === workspaceId);
    const refreshedPane = refreshedWorkspace ? findLeaf(refreshedWorkspace.splitTree, paneId) : null;
    const index = refreshedPane?.surfaces.findIndex((surface) => surface.id === surfaceId) ?? -1;
    if (index < 0) return null;
    store.selectWorkspace(workspaceId);
    store.selectSurface(workspaceId, paneId, index);
  }
  return { surfaceId, created };
}

export function openOrdinarySupervisorStatusForTask(taskSurfaceId: SurfaceId): boolean {
  const store = useStore.getState();
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const pane = findLeaf(workspace.splitTree, paneId);
      if (!pane?.surfaces.some((surface) => surface.id === taskSurfaceId)) continue;
      return !!ensureOrdinarySupervisorStatusSurface(workspace.id, paneId, true);
    }
  }
  return false;
}

/** Remove an ordinary status tab when its task is adopted by project mode. */
export function removeOrdinarySupervisorStatusSurfaceForTask(taskSurfaceId: SurfaceId): SurfaceId[] {
  const store = useStore.getState();
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const pane = findLeaf(workspace.splitTree, paneId);
      if (!pane?.surfaces.some((surface) => surface.id === taskSurfaceId)) continue;
      const surfaceIds = new Set(pane.surfaces.map((surface) => surface.id));
      const anotherOrdinaryLaneUsesPane = store.supervisor.lanes.some((lane) => (
        lane.surfaceId !== taskSurfaceId
        && !lane.projectManagerProjectId
        && !lane.projectWorkItemId
        && surfaceIds.has(lane.surfaceId)
      ));
      if (anotherOrdinaryLaneUsesPane) return [];
      const statusSurfaceIds = pane.surfaces.filter((surface) => (
        surface.type === 'supervisor' && !surface.projectSupervisorProjectId
      )).map((surface) => surface.id);
      for (const surfaceId of statusSurfaceIds) store.closeSurface(workspace.id, paneId, surfaceId);
      return statusSurfaceIds;
    }
  }
  return [];
}
