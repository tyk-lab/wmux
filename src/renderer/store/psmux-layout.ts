import { v4 as uuid } from 'uuid';
import { PaneId, SplitNode, SurfaceId, SurfaceRef, WorkspaceInfo } from '../../shared/types';

export const DEFAULT_PSMUX_COMMAND = 'psmux.exe';
export const PSMUX_SESSION_NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/u;

export function isValidPsmuxSessionName(sessionName: string | undefined): sessionName is string {
  return !!sessionName && PSMUX_SESSION_NAME_RE.test(sessionName);
}

export function createPsmuxSessionName(): string {
  return `psmux-${uuid()}`;
}

export function createPsmuxStartupCommand(sessionName: string): string {
  return `${DEFAULT_PSMUX_COMMAND} new -s ${sessionName}`;
}

export function withPsmuxTerminalDefaults(surface: SurfaceRef): SurfaceRef {
  if (surface.type !== 'terminal') return surface;

  const psmuxSessionName = isValidPsmuxSessionName(surface.psmuxSessionName)
    ? surface.psmuxSessionName
    : createPsmuxSessionName();
  return {
    ...surface,
    customTitle: surface.customTitle ?? 'psmux',
    psmuxSessionName,
    startupCommand: createPsmuxStartupCommand(psmuxSessionName),
  };
}

export function createPsmuxTerminalSurface(): SurfaceRef {
  const id = `surf-${uuid()}` as SurfaceId;
  return withPsmuxTerminalDefaults({
    id,
    type: 'terminal',
  });
}

export function buildDefaultPsmuxSplitTree(): SplitNode {
  return {
    type: 'branch',
    direction: 'horizontal',
    ratio: 0.5,
    children: [
      {
        type: 'leaf',
        paneId: `pane-${uuid()}` as PaneId,
        surfaces: [createPsmuxTerminalSurface()],
        activeSurfaceIndex: 0,
      },
      {
        type: 'leaf',
        paneId: `pane-${uuid()}` as PaneId,
        surfaces: [createPsmuxTerminalSurface()],
        activeSurfaceIndex: 0,
      },
    ],
  };
}

export function getTerminalSurfaceIds(tree: SplitNode): SurfaceId[] {
  if (tree.type === 'leaf') {
    return tree.surfaces
      .filter((surface) => surface.type === 'terminal')
      .map((surface) => surface.id);
  }

  return [
    ...getTerminalSurfaceIds(tree.children[0]),
    ...getTerminalSurfaceIds(tree.children[1]),
  ];
}

export function getPsmuxSessionNames(tree: SplitNode): string[] {
  if (tree.type === 'leaf') {
    return tree.surfaces
      .filter((surface) => surface.type === 'terminal' && surface.psmuxSessionName)
      .map((surface) => surface.psmuxSessionName as string);
  }

  return [
    ...getPsmuxSessionNames(tree.children[0]),
    ...getPsmuxSessionNames(tree.children[1]),
  ];
}

export function normalizePsmuxWorkspaceConfigs(
  workspaces: Array<Partial<WorkspaceInfo>>,
): Array<Partial<WorkspaceInfo>> {
  return workspaces.map((workspace, index) => {
    const title = workspace.title?.trim();
    const isLegacyDefaultTitle = !title || /^(Session|Workspace)\s+\d+$/i.test(title);
    return {
      ...workspace,
      title: isLegacyDefaultTitle ? `psmux ${index + 1}` : workspace.title,
      splitTree: workspace.splitTree
        ? applyPsmuxStartupToTerminalSurfaces(workspace.splitTree)
        : workspace.splitTree,
    };
  });
}

export function applyPsmuxStartupToTerminalSurfaces(tree: SplitNode): SplitNode {
  if (tree.type === 'leaf') {
    return {
      ...tree,
      surfaces: tree.surfaces.map((surface) => {
        return withPsmuxTerminalDefaults(surface);
      }),
    };
  }

  return {
    ...tree,
    children: [
      applyPsmuxStartupToTerminalSurfaces(tree.children[0]),
      applyPsmuxStartupToTerminalSurfaces(tree.children[1]),
    ],
  };
}
