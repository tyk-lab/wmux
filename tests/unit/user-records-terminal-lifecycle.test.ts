import { afterEach, describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { createSurfaceSlice, type SurfaceSlice } from '../../src/renderer/store/surface-slice';
import { createWorkspaceSlice, type WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import type { SplitNode } from '../../src/shared/types';

type TestStore = WorkspaceSlice & SurfaceSlice;

function makeStore() {
  return create<TestStore>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createSurfaceSlice(...args),
  }));
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('user records terminal lifecycle', () => {
  it('does not resurrect the dedicated terminal through the generic closed-tab stack', () => {
    (globalThis as any).window = { wmux: { pty: { kill: () => undefined } } };
    const store = makeStore();
    const workspaceId = store.getState().createWorkspace({ title: '用户记录' });
    const tree = store.getState().workspaces[0].splitTree as Extract<SplitNode, { type: 'leaf' }>;
    const surfaceId = store.getState().addSurface(workspaceId, tree.paneId, 'terminal', {
      userRecordsTerminal: true,
      customTitle: '用户记录终端',
    });

    expect(surfaceId).toBeTruthy();
    store.getState().closeSurface(workspaceId, tree.paneId, surfaceId!);

    expect(store.getState().reopenClosedSurface(workspaceId, tree.paneId)).toBeNull();
  });
});
