import { SplitNode } from '../../shared/types';

type BufferSnapshotter = () => string;
type BufferSerializer = { serialize: () => string };

const MAX_BUFFER_SNAPSHOTS = 32;
const bufferSnapshots = new Map<string, string>();
const liveSnapshotters = new Map<string, BufferSnapshotter>();

/** Serializes both normal scrollback and the active alternate-screen buffer. */
export function serializeTerminalBuffer(serializer: BufferSerializer): string {
  try {
    return serializer.serialize();
  } catch {
    return '';
  }
}

function storeBufferSnapshot(surfaceId: string, snapshot: string): void {
  // An empty snapshot must not wipe a previously captured one. Serialization
  // can legitimately return '' for a hidden/minimized terminal or during a
  // render race, and replacing a valid snapshot with '' would clear the
  // terminal after a pane close/remount.
  if (!snapshot) return;
  if (bufferSnapshots.size >= MAX_BUFFER_SNAPSHOTS) {
    const oldest = bufferSnapshots.keys().next().value;
    if (oldest !== undefined) bufferSnapshots.delete(oldest);
  }
  bufferSnapshots.set(surfaceId, snapshot);
}

/**
 * Registers the serializer owned by the current xterm instance. The returned
 * cleanup reports whether that instance still owns the registration, which
 * prevents an old React cleanup from overwriting a replacement terminal.
 */
export function registerTerminalBufferSnapshotter(
  surfaceId: string,
  snapshotter: BufferSnapshotter,
): () => boolean {
  liveSnapshotters.set(surfaceId, snapshotter);
  return () => {
    if (liveSnapshotters.get(surfaceId) !== snapshotter) return false;
    liveSnapshotters.delete(surfaceId);
    return true;
  };
}

export function saveTerminalBufferSnapshot(surfaceId: string, snapshot: string): void {
  storeBufferSnapshot(surfaceId, snapshot);
}

export function consumeTerminalBufferSnapshot(surfaceId: string): string | undefined {
  const snapshot = bufferSnapshots.get(surfaceId);
  if (snapshot !== undefined) bufferSnapshots.delete(surfaceId);
  return snapshot;
}

function collectTerminalSurfaceIds(node: SplitNode, ids: Set<string>): void {
  if (node.type === 'leaf') {
    for (const surface of node.surfaces) {
      if (surface.type === 'terminal') ids.add(surface.id);
    }
    return;
  }
  collectTerminalSurfaceIds(node.children[0], ids);
  collectTerminalSurfaceIds(node.children[1], ids);
}

/** Saves every live terminal that survives into the next split tree. */
export function snapshotSurvivingTerminalBuffers(nextTree: SplitNode): void {
  const survivingIds = new Set<string>();
  collectTerminalSurfaceIds(nextTree, survivingIds);
  for (const surfaceId of survivingIds) {
    const snapshotter = liveSnapshotters.get(surfaceId);
    if (!snapshotter) continue;
    try {
      storeBufferSnapshot(surfaceId, snapshotter());
    } catch {
      // A terminal can exit between tree calculation and serialization.
    }
  }
}

function treeKey(node: SplitNode): string {
  if (node.type === 'leaf') return node.paneId;
  return `${treeKey(node.children[0])}_${treeKey(node.children[1])}`;
}

function collectTerminalRenderPaths(
  node: SplitNode,
  ancestors: string[],
  paths: Map<string, string>,
): void {
  if (node.type === 'leaf') {
    const renderPath = [...ancestors, `pane:${node.paneId}`].join('/');
    for (const surface of node.surfaces) {
      if (surface.type === 'terminal') paths.set(surface.id, renderPath);
    }
    return;
  }

  collectTerminalRenderPaths(
    node.children[0],
    [...ancestors, `child:${treeKey(node.children[0])}`],
    paths,
  );
  collectTerminalRenderPaths(
    node.children[1],
    [...ancestors, `child:${treeKey(node.children[1])}`],
    paths,
  );
}

/** Returns true when React will re-parent at least one surviving terminal. */
export function terminalTreeRemountsSurvivors(previousTree: SplitNode, nextTree: SplitNode): boolean {
  const previousPaths = new Map<string, string>();
  const nextPaths = new Map<string, string>();
  collectTerminalRenderPaths(previousTree, [], previousPaths);
  collectTerminalRenderPaths(nextTree, [], nextPaths);

  for (const [surfaceId, nextPath] of nextPaths) {
    const previousPath = previousPaths.get(surfaceId);
    if (previousPath !== undefined && previousPath !== nextPath) return true;
  }
  return false;
}
