import type { PaneId, SurfaceId, SurfaceRef, WorkspaceId, WorkspaceInfo } from '../../shared/types';
import { useStore } from '../store';
import { findLeaf, getAllPaneIds } from '../store/split-utils';
import { PROJECT_SUPERVISOR_WORKSPACE_TITLE } from './protocol';

export interface OrdinarySupervisorStatusSurfaceResult {
  surfaceId: SurfaceId;
  created: boolean;
  workspaceId?: WorkspaceId;
  paneId?: PaneId;
}

export type SupervisorStatusSurfaceResult = OrdinarySupervisorStatusSurfaceResult;

export interface OrdinarySupervisorStatusSurfaceLocation {
  surface: SurfaceRef;
  workspaceId: WorkspaceId;
  workspaceTitle: string;
  paneId: PaneId;
}

export function ordinarySupervisorStatusSurfaceLocations(
  workspaces: readonly WorkspaceInfo[],
): OrdinarySupervisorStatusSurfaceLocation[] {
  return workspaces.flatMap((workspace) => (
    getAllPaneIds(workspace.splitTree).flatMap((paneId) => (
      (findLeaf(workspace.splitTree, paneId)?.surfaces || [])
        .filter((surface) => surface.type === 'supervisor' && !surface.projectSupervisorProjectId)
        .map((surface) => ({
          surface,
          workspaceId: workspace.id,
          workspaceTitle: workspace.title,
          paneId,
        }))
    ))
  ));
}

export function shouldShowOrdinarySupervisorCenter(
  ordinaryLaneCount: number,
  ordinaryStatusSurfaceCount: number,
): boolean {
  return ordinaryLaneCount > 0 || ordinaryStatusSurfaceCount > 0;
}

/** Ensure one task-scoped ordinary-supervision status page beside its task terminal. */
export function ensureOrdinarySupervisorStatusSurface(
  workspaceId: WorkspaceId,
  paneId: PaneId,
  laneId?: string,
  taskSurfaceId?: SurfaceId,
  activate = false,
): OrdinarySupervisorStatusSurfaceResult | null {
  const store = useStore.getState();
  const workspace = store.workspaces.find((candidate) => candidate.id === workspaceId);
  const pane = workspace ? findLeaf(workspace.splitTree, paneId) : null;
  const statusSurfaces = pane?.surfaces.filter((surface) => (
    surface.type === 'supervisor'
    && !surface.projectSupervisorProjectId
  )) || [];
  const activeOrdinaryLaneIds = new Set(store.supervisor.lanes.filter((lane) => (
    !lane.projectManagerProjectId && !lane.projectWorkItemId
  )).map((lane) => lane.id));
  const reusable = (surface: SurfaceRef) => (
    !surface.ordinarySupervisorLaneId
    || surface.ordinarySupervisorLaneId === laneId
    || !activeOrdinaryLaneIds.has(surface.ordinarySupervisorLaneId)
  );
  const existing = (taskSurfaceId
    ? statusSurfaces.find((surface) => (
        surface.ordinarySupervisorTaskSurfaceId === taskSurfaceId && reusable(surface)
      ))
    : undefined)
    || statusSurfaces.find((surface) => surface.ordinarySupervisorLaneId === laneId)
    || statusSurfaces.find((surface) => (
      !surface.ordinarySupervisorTaskSurfaceId && reusable(surface)
    ));
  let surfaceId = existing?.id;
  let created = false;
  if (!surfaceId) {
    surfaceId = store.addSurface(workspaceId, paneId, 'supervisor', {
      customTitle: '普通 AI 监督',
      ordinarySupervisorLaneId: laneId,
      ordinarySupervisorTaskSurfaceId: taskSurfaceId,
    }) || undefined;
    created = !!surfaceId;
  }
  if (!surfaceId) return null;
  if (existing && (
    existing.customTitle !== '普通 AI 监督'
    || (!!laneId && existing.ordinarySupervisorLaneId !== laneId)
    || (!!taskSurfaceId && existing.ordinarySupervisorTaskSurfaceId !== taskSurfaceId)
  )) {
    store.updateSurface(workspaceId, paneId, surfaceId, {
      customTitle: '普通 AI 监督',
      ...(laneId ? { ordinarySupervisorLaneId: laneId } : {}),
      ...(taskSurfaceId ? { ordinarySupervisorTaskSurfaceId: taskSurfaceId } : {}),
    });
  }
  if (activate) {
    const refreshedWorkspace = useStore.getState().workspaces.find((candidate) => candidate.id === workspaceId);
    const refreshedPane = refreshedWorkspace ? findLeaf(refreshedWorkspace.splitTree, paneId) : null;
    const index = refreshedPane?.surfaces.findIndex((surface) => surface.id === surfaceId) ?? -1;
    if (index < 0) return null;
    store.selectWorkspace(workspaceId);
    store.selectSurface(workspaceId, paneId, index);
  }
  return { surfaceId, created, workspaceId, paneId };
}

export function openOrdinarySupervisorStatusForTask(taskSurfaceId: SurfaceId): boolean {
  const store = useStore.getState();
  const laneId = store.supervisor.lanes.find((lane) => (
    lane.surfaceId === taskSurfaceId
    && !lane.projectManagerProjectId
    && !lane.projectWorkItemId
  ))?.id;
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const pane = findLeaf(workspace.splitTree, paneId);
      if (!pane?.surfaces.some((surface) => surface.id === taskSurfaceId)) continue;
      return !!ensureOrdinarySupervisorStatusSurface(workspace.id, paneId, laneId, taskSurfaceId, true);
    }
  }
  return false;
}

/** Reopen only one project's status view; project execution and runtime state are untouched. */
export function ensureProjectSupervisorStatusSurface(
  projectId: string,
  activate = true,
): SupervisorStatusSurfaceResult | null {
  const store = useStore.getState();
  const candidates: Array<{ workspaceId: WorkspaceId; paneId: PaneId; supervisorRuntime: boolean }> = [];
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const pane = findLeaf(workspace.splitTree, paneId);
      if (!pane) continue;
      const existing = pane.surfaces.find((surface) => (
        surface.type === 'supervisor' && surface.projectSupervisorProjectId === projectId
      ));
      if (existing) {
        if (activate) {
          store.selectWorkspace(workspace.id);
          store.selectSurface(workspace.id, paneId, pane.surfaces.indexOf(existing));
        }
        return { surfaceId: existing.id, created: false };
      }
      const ownsProject = pane.surfaces.some((surface) => (
        surface.projectManagerProjectId === projectId
        || surface.projectSupervisorProjectId === projectId
      ));
      if (!ownsProject) continue;
      candidates.push({
        workspaceId: workspace.id,
        paneId,
        supervisorRuntime: pane.surfaces.some((surface) => (
          surface.type === 'terminal' && surface.projectSupervisorProjectId === projectId
        )),
      });
    }
  }
  const target = candidates.find((candidate) => candidate.supervisorRuntime) || candidates[0];
  if (!target) return null;
  const surfaceId = store.addSurface(target.workspaceId, target.paneId, 'supervisor', {
    customTitle: PROJECT_SUPERVISOR_WORKSPACE_TITLE,
    projectSupervisorProjectId: projectId,
  });
  if (!surfaceId) return null;
  if (activate) {
    const workspace = useStore.getState().workspaces.find((candidate) => candidate.id === target.workspaceId);
    const pane = workspace ? findLeaf(workspace.splitTree, target.paneId) : null;
    const index = pane?.surfaces.findIndex((surface) => surface.id === surfaceId) ?? -1;
    if (index < 0) return null;
    store.selectWorkspace(target.workspaceId);
    store.selectSurface(target.workspaceId, target.paneId, index);
  }
  return { surfaceId, created: true };
}

/** Remove the ordinary status page paired with a task adopted by project mode. */
export function removeOrdinarySupervisorStatusSurfaceForTask(taskSurfaceId: SurfaceId): SurfaceId[] {
  const store = useStore.getState();
  const laneId = store.supervisor.lanes.find((lane) => lane.surfaceId === taskSurfaceId)?.id;
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
      const statusSurfaceIds = pane.surfaces.filter((surface) => (
        surface.type === 'supervisor'
        && !surface.projectSupervisorProjectId
        && (surface.ordinarySupervisorTaskSurfaceId === taskSurfaceId
          || surface.ordinarySupervisorLaneId === laneId
          || (!surface.ordinarySupervisorLaneId && !anotherOrdinaryLaneUsesPane))
      )).map((surface) => surface.id);
      for (const surfaceId of statusSurfaceIds) store.closeSurface(workspace.id, paneId, surfaceId);
      return statusSurfaceIds;
    }
  }
  return [];
}
