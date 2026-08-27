import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../src/renderer/store';
import { findLeaf, getAllPaneIds } from '../../src/renderer/store/split-utils';
import {
  ensureProjectSupervisorStatusSurface,
  ensureOrdinarySupervisorStatusSurface,
  openOrdinarySupervisorStatusForTask,
} from '../../src/renderer/supervisor/status-surface';

describe('ordinary supervisor status surface', () => {
  let originalWorkspaces = useStore.getState().workspaces;
  let originalActiveWorkspaceId = useStore.getState().activeWorkspaceId;

  beforeEach(() => {
    originalWorkspaces = useStore.getState().workspaces;
    originalActiveWorkspaceId = useStore.getState().activeWorkspaceId;
  });

  afterEach(() => {
    useStore.setState({
      workspaces: originalWorkspaces,
      activeWorkspaceId: originalActiveWorkspaceId,
    });
  });

  it('creates one status tab beside the task terminal and focuses the same tab on reopen', () => {
    const workspaceId = useStore.getState().createWorkspace({ title: 'ordinary-supervisor-status-test' });
    const workspace = useStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)!;
    const paneId = getAllPaneIds(workspace.splitTree)[0];
    const taskSurfaceId = findLeaf(workspace.splitTree, paneId)!.surfaces[0].id;

    const created = ensureOrdinarySupervisorStatusSurface(workspaceId, paneId);
    const reused = ensureOrdinarySupervisorStatusSurface(workspaceId, paneId);

    expect(created).toMatchObject({ created: true });
    expect(reused).toEqual({ surfaceId: created!.surfaceId, created: false });
    expect(openOrdinarySupervisorStatusForTask(taskSurfaceId)).toBe(true);
    const refreshedWorkspace = useStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)!;
    const pane = findLeaf(refreshedWorkspace.splitTree, paneId)!;
    expect(pane.surfaces.filter((surface) => surface.type === 'supervisor')).toHaveLength(1);
    expect(pane.surfaces[pane.activeSurfaceIndex]).toMatchObject({
      id: created!.surfaceId,
      customTitle: '普通监督状态',
    });
  });

  it('recreates only the deleted status tab when multiple supervised workspaces exist', () => {
    const firstWorkspaceId = useStore.getState().createWorkspace({ title: 'ordinary-status-a' });
    const secondWorkspaceId = useStore.getState().createWorkspace({ title: 'ordinary-status-b' });
    const firstWorkspace = useStore.getState().workspaces.find((item) => item.id === firstWorkspaceId)!;
    const secondWorkspace = useStore.getState().workspaces.find((item) => item.id === secondWorkspaceId)!;
    const firstPaneId = getAllPaneIds(firstWorkspace.splitTree)[0];
    const secondPaneId = getAllPaneIds(secondWorkspace.splitTree)[0];
    const firstTaskId = findLeaf(firstWorkspace.splitTree, firstPaneId)!.surfaces[0].id;
    const firstStatus = ensureOrdinarySupervisorStatusSurface(firstWorkspaceId, firstPaneId)!;
    const secondStatus = ensureOrdinarySupervisorStatusSurface(secondWorkspaceId, secondPaneId)!;

    useStore.getState().closeSurface(firstWorkspaceId, firstPaneId, firstStatus.surfaceId);
    expect(openOrdinarySupervisorStatusForTask(firstTaskId)).toBe(true);

    const refreshedFirst = useStore.getState().workspaces.find((item) => item.id === firstWorkspaceId)!;
    const refreshedSecond = useStore.getState().workspaces.find((item) => item.id === secondWorkspaceId)!;
    const recreatedFirst = findLeaf(refreshedFirst.splitTree, firstPaneId)!.surfaces
      .find((surface) => surface.type === 'supervisor');
    const retainedSecond = findLeaf(refreshedSecond.splitTree, secondPaneId)!.surfaces
      .find((surface) => surface.type === 'supervisor');
    expect(recreatedFirst?.id).not.toBe(firstStatus.surfaceId);
    expect(retainedSecond?.id).toBe(secondStatus.surfaceId);
  });

  it('recreates one project status view by project id without touching another project', () => {
    const firstWorkspaceId = useStore.getState().createWorkspace({ title: 'project-runtime-a' });
    const secondWorkspaceId = useStore.getState().createWorkspace({ title: 'project-runtime-b' });
    const firstWorkspace = useStore.getState().workspaces.find((item) => item.id === firstWorkspaceId)!;
    const secondWorkspace = useStore.getState().workspaces.find((item) => item.id === secondWorkspaceId)!;
    const firstPaneId = getAllPaneIds(firstWorkspace.splitTree)[0];
    const secondPaneId = getAllPaneIds(secondWorkspace.splitTree)[0];
    const firstRuntimeId = findLeaf(firstWorkspace.splitTree, firstPaneId)!.surfaces[0].id;
    const secondRuntimeId = findLeaf(secondWorkspace.splitTree, secondPaneId)!.surfaces[0].id;
    useStore.getState().updateSurface(firstWorkspaceId, firstPaneId, firstRuntimeId, {
      projectManagerProjectId: 'project-a',
    });
    useStore.getState().updateSurface(secondWorkspaceId, secondPaneId, secondRuntimeId, {
      projectManagerProjectId: 'project-b',
    });
    const firstStatus = ensureProjectSupervisorStatusSurface('project-a', false)!;
    const secondStatus = ensureProjectSupervisorStatusSurface('project-b', false)!;

    useStore.getState().closeSurface(firstWorkspaceId, firstPaneId, firstStatus.surfaceId);
    const restored = ensureProjectSupervisorStatusSurface('project-a', true)!;

    expect(restored).toMatchObject({ created: true });
    expect(restored.surfaceId).not.toBe(firstStatus.surfaceId);
    const refreshedSecond = useStore.getState().workspaces.find((item) => item.id === secondWorkspaceId)!;
    expect(findLeaf(refreshedSecond.splitTree, secondPaneId)!.surfaces
      .some((surface) => surface.id === secondStatus.surfaceId)).toBe(true);
  });
});
