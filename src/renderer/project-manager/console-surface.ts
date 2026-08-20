import { projectDisplayName } from '../../shared/project-manager';
import { useStore } from '../store';
import { createLeaf, findLeaf, getAllPaneIds } from '../store/split-utils';
import { projectSupervisorWorkspaceTitle } from '../supervisor/protocol';

export function openProjectManagerConsole(projectId: string): boolean {
  const store = useStore.getState();
  const project = store.projectManagers.find((candidate) => candidate.id === projectId);
  if (!project) return false;

  store.selectProjectManager(projectId);
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const pane = findLeaf(workspace.splitTree, paneId);
      const surfaceIndex = pane?.surfaces.findIndex((surface) => (
        surface.type === 'project-manager' && surface.projectManagerProjectId === projectId
      )) ?? -1;
      if (surfaceIndex < 0) continue;
      store.selectWorkspace(workspace.id);
      store.selectSurface(workspace.id, paneId, surfaceIndex);
      return true;
    }
  }

  const projectWorkspace = store.workspaces.find((workspace) => (
    workspace.transientSupervisorWorkspace === true
    && getAllPaneIds(workspace.splitTree).some((paneId) => (
      findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
        surface.projectManagerProjectId === projectId || surface.projectSupervisorProjectId === projectId
      ))
    ))
  ));
  if (projectWorkspace) {
    const paneId = getAllPaneIds(projectWorkspace.splitTree)[0];
    if (!paneId) return false;
    const surfaceId = store.addSurface(projectWorkspace.id, paneId, 'project-manager', {
      customTitle: '项目管理',
      projectManagerProjectId: projectId,
    });
    if (!surfaceId) return false;
    const refreshedWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === projectWorkspace.id);
    if (!refreshedWorkspace) return false;
    const pane = findLeaf(refreshedWorkspace.splitTree, paneId);
    const surfaceIndex = pane?.surfaces.findIndex((surface) => surface.id === surfaceId) ?? -1;
    store.selectWorkspace(projectWorkspace.id);
    if (surfaceIndex >= 0) store.selectSurface(projectWorkspace.id, paneId, surfaceIndex);
    return true;
  }

  const splitTree = createLeaf(undefined, 'project-manager');
  splitTree.surfaces[0] = {
    ...splitTree.surfaces[0],
    customTitle: '项目管理',
    projectManagerProjectId: projectId,
  };
  const workspaceId = store.createWorkspace({
    title: projectSupervisorWorkspaceTitle(projectDisplayName(project), projectId),
    pinned: true,
    cwd: project.projectDir,
    transientSupervisorWorkspace: true,
    splitTree,
  });
  store.selectWorkspace(workspaceId);
  return true;
}
