import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../src/renderer/store';
import { findLeaf, getAllPaneIds } from '../../src/renderer/store/split-utils';
import {
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
});
