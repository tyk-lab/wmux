import { create } from 'zustand';
import { describe, expect, it } from 'vitest';
import { SplitNode } from '../../src/shared/types';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import {
  consumeTerminalBufferSnapshot,
  registerTerminalBufferSnapshotter,
  serializeTerminalBuffer,
  snapshotSurvivingTerminalBuffers,
  terminalTreeRemountsSurvivors,
} from '../../src/renderer/utils/terminal-buffer-cache';

function leaf(paneId: string, surfaceIds: string[]): SplitNode {
  return {
    type: 'leaf',
    paneId: paneId as any,
    surfaces: surfaceIds.map((id) => ({ id: id as any, type: 'terminal' })),
    activeSurfaceIndex: 0,
  };
}

describe('terminal-buffer-cache', () => {
  it('does not exclude the active alternate-screen buffer', () => {
    const calls: unknown[] = [];
    const snapshot = serializeTerminalBuffer({
      serialize: (options?: unknown) => {
        calls.push(options);
        return '\x1b[?1049hTUI output';
      },
    });

    expect(snapshot).toBe('\x1b[?1049hTUI output');
    expect(calls).toEqual([undefined]);
  });

  it('snapshots only terminals that survive into the next split tree', () => {
    const unregisterKept = registerTerminalBufferSnapshotter('surf-kept', () => 'kept output');
    const unregisterClosed = registerTerminalBufferSnapshotter('surf-closed', () => 'closed output');

    snapshotSurvivingTerminalBuffers(leaf('pane-kept', ['surf-kept']));

    expect(consumeTerminalBufferSnapshot('surf-kept')).toBe('kept output');
    expect(consumeTerminalBufferSnapshot('surf-closed')).toBeUndefined();
    unregisterKept();
    unregisterClosed();
  });

  it('does not let stale cleanup unregister a replacement terminal', () => {
    const unregisterOld = registerTerminalBufferSnapshotter('surf-shared', () => 'old output');
    const unregisterNew = registerTerminalBufferSnapshotter('surf-shared', () => 'new output');

    expect(unregisterOld()).toBe(false);
    snapshotSurvivingTerminalBuffers(leaf('pane-shared', ['surf-shared']));
    expect(consumeTerminalBufferSnapshot('surf-shared')).toBe('new output');
    expect(unregisterNew()).toBe(true);
  });

  it('preserves an older snapshot when the live terminal buffer is empty', () => {
    let output = 'old output';
    const unregister = registerTerminalBufferSnapshotter('surf-cleared', () => output);
    const tree = leaf('pane-cleared', ['surf-cleared']);

    snapshotSurvivingTerminalBuffers(tree);
    output = '';
    snapshotSurvivingTerminalBuffers(tree);

    expect(consumeTerminalBufferSnapshot('surf-cleared')).toBe('old output');
    unregister();
  });

  it('captures a surviving terminal before adding or removing a split pane', () => {
    const store = create<WorkspaceSlice>()(createWorkspaceSlice);
    const workspaceId = store.getState().createWorkspace({ title: 'buffer test' });
    const currentTree = store.getState().workspaces[0].splitTree;
    if (currentTree.type !== 'leaf') throw new Error('Expected a leaf workspace');
    const survivingId = currentTree.surfaces[0].id;
    const unregister = registerTerminalBufferSnapshotter(survivingId, () => 'before split');
    const nextTree: SplitNode = {
      type: 'branch',
      direction: 'horizontal',
      ratio: 0.5,
      children: [currentTree, leaf('pane-new', ['surf-new'])],
    };

    store.getState().updateSplitTree(workspaceId, nextTree);

    // React may register the replacement before cleaning up the old instance.
    // The proactive snapshot must remain available regardless of that order.
    const unregisterReplacement = registerTerminalBufferSnapshotter(survivingId, () => 'replacement');
    expect(unregister()).toBe(false);
    expect(consumeTerminalBufferSnapshot(survivingId)).toBe('before split');
    store.getState().updateSplitTree(workspaceId, currentTree);
    expect(consumeTerminalBufferSnapshot(survivingId)).toBe('replacement');
    unregisterReplacement();
  });

  it('detects only layout changes that re-parent a surviving terminal', () => {
    const left = leaf('pane-left', ['surf-left']);
    const right = leaf('pane-right', ['surf-right']);
    const tree: SplitNode = {
      type: 'branch',
      direction: 'horizontal',
      ratio: 0.5,
      children: [left, right],
    };
    const resized: SplitNode = { ...tree, ratio: 0.7 };
    const tabbed = leaf('pane-tabbed', ['surf-first', 'surf-second']);
    const selected: SplitNode = { ...tabbed, activeSurfaceIndex: 1 };
    const addedTab = leaf('pane-left', ['surf-left', 'surf-new']);
    const splitLeft: SplitNode = {
      type: 'branch',
      direction: 'horizontal',
      ratio: 0.5,
      children: [left, leaf('pane-new', ['surf-new'])],
    };
    const movedLeft: SplitNode = {
      ...tree,
      children: [leaf('pane-left', []), leaf('pane-right', ['surf-right', 'surf-left'])],
    };

    expect(terminalTreeRemountsSurvivors(tree, resized)).toBe(false);
    expect(terminalTreeRemountsSurvivors(tabbed, selected)).toBe(false);
    expect(terminalTreeRemountsSurvivors(left, addedTab)).toBe(false);
    expect(terminalTreeRemountsSurvivors(left, splitLeft)).toBe(true);
    expect(terminalTreeRemountsSurvivors(tree, movedLeft)).toBe(true);
  });
});
