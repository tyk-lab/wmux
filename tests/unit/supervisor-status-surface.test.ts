import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../src/renderer/store';
import { findLeaf, getAllPaneIds } from '../../src/renderer/store/split-utils';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';
import type { SurfaceId } from '../../src/shared/types';
import {
  ensureOrdinarySupervisorStatusSurface,
  ensureProjectSupervisorStatusSurface,
  ordinarySupervisorStatusSurfaceLocations,
  openOrdinarySupervisorStatusForTask,
  removeOrdinarySupervisorStatusSurfaceForTask,
  shouldShowOrdinarySupervisorCenter,
} from '../../src/renderer/supervisor/status-surface';

function ordinaryLane(id: string, surfaceId: SurfaceId): SupervisorLane {
  return {
    id,
    label: id,
    surfaceId,
    supervisorSurfaceId: null,
    controlState: 'paused',
    awaitingStopCheck: false,
    stopConfirmed: false,
    currentTask: '',
    decisions: [],
    pendingSupervisorDeliveries: [],
    config: {
      taskGoal: id,
      taskDescription: '',
      preconditions: '',
      stopWhen: '用户停止',
      stopWhenKind: 'specific',
      planFilePath: '',
    },
  };
}

describe('ordinary supervisor status surface', () => {
  let originalWorkspaces = useStore.getState().workspaces;
  let originalActiveWorkspaceId = useStore.getState().activeWorkspaceId;
  let originalSupervisor = useStore.getState().supervisor;

  beforeEach(() => {
    originalWorkspaces = useStore.getState().workspaces;
    originalActiveWorkspaceId = useStore.getState().activeWorkspaceId;
    originalSupervisor = useStore.getState().supervisor;
  });

  afterEach(() => {
    useStore.setState({
      workspaces: originalWorkspaces,
      activeWorkspaceId: originalActiveWorkspaceId,
      supervisor: originalSupervisor,
    });
  });

  it('keeps the center visible when restart restores status pages without live lanes', () => {
    const workspaceId = useStore.getState().createWorkspace({ title: 'restored-status-only' });
    const workspace = useStore.getState().workspaces.find((item) => item.id === workspaceId)!;
    const paneId = getAllPaneIds(workspace.splitTree)[0];
    useStore.getState().addSurface(workspaceId, paneId, 'supervisor', {
      customTitle: '普通 AI 监督',
      ordinarySupervisorLaneId: 'lane-restored',
    });
    const projectStatusId = useStore.getState().addSurface(workspaceId, paneId, 'supervisor', {
      customTitle: '监督 AI',
      projectSupervisorProjectId: 'project-a',
    });
    const restoredLocations = ordinarySupervisorStatusSurfaceLocations(useStore.getState().workspaces);

    expect(restoredLocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspaceId, paneId }),
    ]));
    expect(restoredLocations.some((entry) => entry.surface.id === projectStatusId)).toBe(false);
    expect(shouldShowOrdinarySupervisorCenter(0, restoredLocations.length)).toBe(true);
    expect(shouldShowOrdinarySupervisorCenter(1, 0)).toBe(true);
    expect(shouldShowOrdinarySupervisorCenter(0, 0)).toBe(false);
  });

  it('creates a task-scoped ordinary supervision status page in each workspace', () => {
    const firstWorkspaceId = useStore.getState().createWorkspace({ title: 'ordinary-status-a' });
    const secondWorkspaceId = useStore.getState().createWorkspace({ title: 'ordinary-status-b' });
    const firstWorkspace = useStore.getState().workspaces.find((item) => item.id === firstWorkspaceId)!;
    const secondWorkspace = useStore.getState().workspaces.find((item) => item.id === secondWorkspaceId)!;
    const firstPaneId = getAllPaneIds(firstWorkspace.splitTree)[0];
    const secondPaneId = getAllPaneIds(secondWorkspace.splitTree)[0];
    const firstTaskId = findLeaf(firstWorkspace.splitTree, firstPaneId)!.surfaces[0].id;
    const secondTaskId = findLeaf(secondWorkspace.splitTree, secondPaneId)!.surfaces[0].id;
    useStore.setState({
      supervisor: {
        ...originalSupervisor,
        lanes: [ordinaryLane('lane-a', firstTaskId), ordinaryLane('lane-b', secondTaskId)],
      },
    });
    const firstStatus = ensureOrdinarySupervisorStatusSurface(
      firstWorkspaceId,
      firstPaneId,
      'lane-a',
      firstTaskId,
    )!;
    const secondStatus = ensureOrdinarySupervisorStatusSurface(
      secondWorkspaceId,
      secondPaneId,
      'lane-b',
      secondTaskId,
    )!;

    const refreshedFirst = useStore.getState().workspaces.find((item) => item.id === firstWorkspaceId)!;
    const refreshedSecond = useStore.getState().workspaces.find((item) => item.id === secondWorkspaceId)!;
    const statusSurfaces = [refreshedFirst, refreshedSecond].flatMap((workspace) => (
      getAllPaneIds(workspace.splitTree).flatMap((paneId) => (
        findLeaf(workspace.splitTree, paneId)?.surfaces.filter((surface) => surface.type === 'supervisor') || []
      ))
    ));
    expect(firstStatus).toMatchObject({ created: true, workspaceId: firstWorkspaceId, paneId: firstPaneId });
    expect(secondStatus).toMatchObject({ created: true, workspaceId: secondWorkspaceId, paneId: secondPaneId });
    expect(statusSurfaces).toHaveLength(2);
    expect(statusSurfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: firstStatus.surfaceId,
        customTitle: '普通 AI 监督',
        ordinarySupervisorLaneId: 'lane-a',
        ordinarySupervisorTaskSurfaceId: firstTaskId,
      }),
      expect.objectContaining({
        id: secondStatus.surfaceId,
        customTitle: '普通 AI 监督',
        ordinarySupervisorLaneId: 'lane-b',
        ordinarySupervisorTaskSurfaceId: secondTaskId,
      }),
    ]));
    expect(openOrdinarySupervisorStatusForTask(secondTaskId)).toBe(true);
  });

  it('adopts one legacy status page without turning it into a global center', () => {
    const workspaceId = useStore.getState().createWorkspace({ title: 'legacy-ordinary' });
    const workspace = useStore.getState().workspaces.find((item) => item.id === workspaceId)!;
    const paneId = getAllPaneIds(workspace.splitTree)[0];
    const taskSurfaceId = findLeaf(workspace.splitTree, paneId)!.surfaces[0].id;
    const legacy = useStore.getState().addSurface(workspaceId, paneId, 'supervisor', {
      customTitle: '普通监督状态',
      ordinarySupervisorLaneId: 'lane-before-restart',
    })!;
    const retained = ensureOrdinarySupervisorStatusSurface(
      workspaceId,
      paneId,
      'lane-after-restart',
      taskSurfaceId,
    )!;

    expect(retained).toMatchObject({ created: false, surfaceId: legacy });
    expect(findLeaf(
      useStore.getState().workspaces.find((item) => item.id === workspaceId)!.splitTree,
      paneId,
    )!.surfaces.find((surface) => surface.id === legacy)).toMatchObject({
      customTitle: '普通 AI 监督',
      ordinarySupervisorLaneId: 'lane-after-restart',
      ordinarySupervisorTaskSurfaceId: taskSurfaceId,
    });
    expect(findLeaf(
      useStore.getState().workspaces.find((item) => item.id === workspaceId)!.splitTree,
      paneId,
    )!.surfaces.filter((surface) => surface.type === 'supervisor')).toHaveLength(1);
  });

  it('removes only the status page paired with the adopted task', () => {
    const workspaceId = useStore.getState().createWorkspace({ title: 'ordinary-remove' });
    const workspace = useStore.getState().workspaces.find((item) => item.id === workspaceId)!;
    const paneId = getAllPaneIds(workspace.splitTree)[0];
    const firstTaskId = findLeaf(workspace.splitTree, paneId)!.surfaces[0].id;
    const secondTaskId = useStore.getState().addSurface(workspaceId, paneId, 'terminal')!;
    useStore.setState({
      supervisor: {
        ...originalSupervisor,
        lanes: [ordinaryLane('lane-a', firstTaskId), ordinaryLane('lane-b', secondTaskId)],
      },
    });
    const firstStatus = ensureOrdinarySupervisorStatusSurface(
      workspaceId,
      paneId,
      'lane-a',
      firstTaskId,
    )!;
    const secondStatus = ensureOrdinarySupervisorStatusSurface(
      workspaceId,
      paneId,
      'lane-b',
      secondTaskId,
    )!;

    expect(removeOrdinarySupervisorStatusSurfaceForTask(firstTaskId)).toEqual([firstStatus.surfaceId]);
    const refreshedPane = findLeaf(
      useStore.getState().workspaces.find((item) => item.id === workspaceId)!.splitTree,
      paneId,
    )!;
    expect(refreshedPane.surfaces.some((surface) => surface.id === firstStatus.surfaceId)).toBe(false);
    expect(refreshedPane.surfaces.some((surface) => surface.id === secondStatus.surfaceId)).toBe(true);
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
