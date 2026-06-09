import { PaneId, SplitNode, SurfaceRef, WorkspaceId } from '../../shared/types';
import { createPsmuxStartupCommand, isValidPsmuxSessionName } from '../store/psmux-layout';
import { useStore } from '../store';

export interface RenamePsmuxResult {
  ok: boolean;
  error?: string;
}

function findSurfacePane(node: SplitNode, surfaceId: string): PaneId | null {
  if (node.type === 'leaf') {
    return node.surfaces.some((surface) => surface.id === surfaceId) ? node.paneId : null;
  }

  return findSurfacePane(node.children[0], surfaceId) ?? findSurfacePane(node.children[1], surfaceId);
}

export async function renamePsmuxSurfaceSession(
  workspaceId: WorkspaceId,
  paneId: PaneId,
  surface: SurfaceRef,
  nextName: string,
): Promise<RenamePsmuxResult> {
  const oldName = surface.psmuxSessionName;
  const newName = nextName.trim();
  if (!oldName) return { ok: false, error: 'Current terminal has no psmux session name' };
  if (!isValidPsmuxSessionName(newName)) {
    return { ok: false, error: 'psmux session name can only use letters, numbers, underscore, dot, and dash' };
  }
  if (oldName === newName) return { ok: true };

  const result = await window.wmux?.psmux?.renameSession?.(oldName, newName, surface.id);
  if (!result?.ok) {
    return { ok: false, error: result?.error ?? 'Failed to rename psmux session' };
  }

  const state = useStore.getState();
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  const currentPaneId = workspace ? findSurfacePane(workspace.splitTree, surface.id) : paneId;
  if (!currentPaneId) {
    await window.wmux?.psmux?.killSession?.(newName, surface.id);
    return { ok: false, error: 'Terminal was closed before the renamed psmux session could be tracked' };
  }

  state.updateSurface(workspaceId, currentPaneId, surface.id, {
    customTitle: newName,
    psmuxSessionName: newName,
    psmuxAttachExisting: true,
    startupCommand: createPsmuxStartupCommand(newName, 'attach'),
  });
  return { ok: true };
}

export function notifyPsmuxRenameError(surfaceId: string, error?: string): void {
  window.wmux?.notification?.fire?.({
    surfaceId,
    title: 'psmux',
    text: error ?? 'Failed to rename psmux session',
  });
}
