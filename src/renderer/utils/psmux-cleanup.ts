import { SplitNode, SurfaceRef } from '../../shared/types';

export function killPsmuxSurface(surface: SurfaceRef): void {
  if (surface.type !== 'terminal') return;
  if (surface.psmuxSessionName) {
    void window.wmux?.psmux?.killSession?.(surface.psmuxSessionName);
  }
  window.wmux?.pty?.kill(surface.id);
}

export function killPsmuxSurfaces(surfaces: SurfaceRef[]): void {
  const sessionNames = surfaces
    .filter((surface) => surface.type === 'terminal' && surface.psmuxSessionName)
    .map((surface) => surface.psmuxSessionName as string);

  if (sessionNames.length > 0) {
    void window.wmux?.psmux?.killSessions?.(sessionNames);
  }

  for (const surface of surfaces) {
    if (surface.type === 'terminal') {
      window.wmux?.pty?.kill(surface.id);
    }
  }
}

export function killPsmuxTree(tree: SplitNode): void {
  if (tree.type === 'leaf') {
    killPsmuxSurfaces(tree.surfaces);
    return;
  }

  killPsmuxTree(tree.children[0]);
  killPsmuxTree(tree.children[1]);
}

export function getPsmuxSessionNamesFromTree(tree: SplitNode): string[] {
  if (tree.type === 'leaf') {
    return tree.surfaces
      .filter((surface) => surface.type === 'terminal' && surface.psmuxSessionName)
      .map((surface) => surface.psmuxSessionName as string);
  }

  return [
    ...getPsmuxSessionNamesFromTree(tree.children[0]),
    ...getPsmuxSessionNamesFromTree(tree.children[1]),
  ];
}

export function killPsmuxTreeSync(tree: SplitNode): void {
  const sessionNames = getPsmuxSessionNamesFromTree(tree);
  if (sessionNames.length > 0) {
    window.wmux?.psmux?.killSessionsSync?.(sessionNames);
  }
}
