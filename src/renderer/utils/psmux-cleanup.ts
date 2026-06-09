import { SplitNode, SurfaceRef } from '../../shared/types';

interface PsmuxSessionTarget {
  sessionName: string;
  surfaceId: string;
}

export function killPsmuxSurface(surface: SurfaceRef): void {
  if (surface.type !== 'terminal') return;
  if (surface.psmuxSessionName) {
    void window.wmux?.psmux?.killSession?.(surface.psmuxSessionName, surface.id);
  }
  window.wmux?.pty?.kill(surface.id);
}

export function killPsmuxSurfaces(surfaces: SurfaceRef[]): void {
  const targets = surfaces
    .filter((surface) => surface.type === 'terminal' && surface.psmuxSessionName)
    .map((surface) => ({
      sessionName: surface.psmuxSessionName as string,
      surfaceId: surface.id,
    }));

  if (targets.length > 0) {
    void window.wmux?.psmux?.killSessions?.(targets);
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

export function getPsmuxSessionTargetsFromTree(tree: SplitNode): PsmuxSessionTarget[] {
  if (tree.type === 'leaf') {
    return tree.surfaces
      .filter((surface) => surface.type === 'terminal' && surface.psmuxSessionName)
      .map((surface) => ({
        sessionName: surface.psmuxSessionName as string,
        surfaceId: surface.id,
      }));
  }

  return [
    ...getPsmuxSessionTargetsFromTree(tree.children[0]),
    ...getPsmuxSessionTargetsFromTree(tree.children[1]),
  ];
}

export function killPsmuxTreeSync(tree: SplitNode): void {
  const targets = getPsmuxSessionTargetsFromTree(tree);
  if (targets.length > 0) {
    window.wmux?.psmux?.killSessionsSync?.(targets);
  }
}
