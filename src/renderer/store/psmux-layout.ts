import { PaneId, SplitNode, SurfaceId, SurfaceRef, WorkspaceInfo } from '../../shared/types';
import { v4 as uuid } from 'uuid';

export const DEFAULT_PSMUX_COMMAND = 'psmux.exe';
export const PSMUX_SESSION_NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/u;
export const PSMUX_SESSION_NAME_PREFIX = 'psmux-';

export function isValidPsmuxSessionName(sessionName: string | undefined): sessionName is string {
  return !!sessionName && PSMUX_SESSION_NAME_RE.test(sessionName);
}

export function createPsmuxSessionName(usedSessionNames: Iterable<string> = []): string {
  const usedNames = new Set(usedSessionNames);
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = `${PSMUX_SESSION_NAME_PREFIX}${index}`;
    if (!usedNames.has(candidate)) return candidate;
  }
  return `${PSMUX_SESSION_NAME_PREFIX}${uuid()}`;
}

export function createPsmuxStartupCommand(sessionName: string): string {
  return `${DEFAULT_PSMUX_COMMAND} new -s ${sessionName}`;
}

function reservePsmuxSessionName(surface: SurfaceRef, usedSessionNames: Set<string>): string {
  const existingName = surface.psmuxSessionName;
  if (isValidPsmuxSessionName(existingName) && !usedSessionNames.has(existingName)) {
    usedSessionNames.add(existingName);
    return existingName;
  }

  const sessionName = createPsmuxSessionName(usedSessionNames);
  usedSessionNames.add(sessionName);
  return sessionName;
}

export function withPsmuxTerminalDefaults(
  surface: SurfaceRef,
  usedSessionNames: Iterable<string> | Set<string> = [],
): SurfaceRef {
  if (surface.type !== 'terminal') return surface;

  const usedNames = usedSessionNames instanceof Set
    ? usedSessionNames
    : new Set(usedSessionNames);
  const psmuxSessionName = reservePsmuxSessionName(surface, usedNames);
  return {
    ...surface,
    customTitle: surface.customTitle ?? 'psmux',
    psmuxSessionName,
    startupCommand: createPsmuxStartupCommand(psmuxSessionName),
  };
}

export function createPsmuxTerminalSurface(usedSessionNames: Iterable<string> | Set<string> = []): SurfaceRef {
  const id = `surf-${uuid()}` as SurfaceId;
  return withPsmuxTerminalDefaults({
    id,
    type: 'terminal',
  }, usedSessionNames);
}

export function buildDefaultPsmuxSplitTree(usedSessionNames: Iterable<string> = []): SplitNode {
  const usedNames = new Set(usedSessionNames);
  return {
    type: 'branch',
    direction: 'horizontal',
    ratio: 0.5,
    children: [
      {
        type: 'leaf',
        paneId: `pane-${uuid()}` as PaneId,
        surfaces: [createPsmuxTerminalSurface(usedNames)],
        activeSurfaceIndex: 0,
      },
      {
        type: 'leaf',
        paneId: `pane-${uuid()}` as PaneId,
        surfaces: [createPsmuxTerminalSurface(usedNames)],
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

export function getPsmuxSessionNamesFromWorkspaces(
  workspaces: Array<Pick<WorkspaceInfo, 'id' | 'splitTree'>>,
  excludeWorkspaceId?: string,
): string[] {
  return workspaces
    .filter((workspace) => workspace.id !== excludeWorkspaceId)
    .flatMap((workspace) => getPsmuxSessionNames(workspace.splitTree))
    .filter(isValidPsmuxSessionName);
}

export function normalizePsmuxWorkspaceConfigs(
  workspaces: Array<Partial<WorkspaceInfo>>,
): Array<Partial<WorkspaceInfo>> {
  const usedNames = new Set<string>();
  return workspaces.map((workspace, index) => {
    const title = workspace.title?.trim();
    const isLegacyDefaultTitle = !title || /^(Session|Workspace)\s+\d+$/i.test(title);
    return {
      ...workspace,
      title: isLegacyDefaultTitle ? `psmux ${index + 1}` : workspace.title,
      splitTree: workspace.splitTree
        ? applyPsmuxStartupToTerminalSurfaces(workspace.splitTree, usedNames)
        : workspace.splitTree,
    };
  });
}

export function applyPsmuxStartupToTerminalSurfaces(
  tree: SplitNode,
  usedSessionNames: Iterable<string> | Set<string> = [],
): SplitNode {
  const usedNames = usedSessionNames instanceof Set
    ? usedSessionNames
    : new Set(usedSessionNames);

  if (tree.type === 'leaf') {
    return {
      ...tree,
      surfaces: tree.surfaces.map((surface) => {
        return withPsmuxTerminalDefaults(surface, usedNames);
      }),
    };
  }

  return {
    ...tree,
    children: [
      applyPsmuxStartupToTerminalSurfaces(tree.children[0], usedNames),
      applyPsmuxStartupToTerminalSurfaces(tree.children[1], usedNames),
    ],
  };
}
