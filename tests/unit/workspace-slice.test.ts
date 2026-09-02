import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, type WorkspaceSlice } from '../../src/renderer/store/workspace-slice';

describe('workspace-slice SSH restore', () => {
  it('suppresses history before a restored Codex companion can start', () => {
    const store = create<WorkspaceSlice>()(createWorkspaceSlice);

    store.getState().replaceAllWorkspaces([{
      title: 'SSH',
      sshProfileId: 'profile-a',
      splitTree: {
        type: 'leaf',
        paneId: 'pane-ssh' as any,
        activeSurfaceIndex: 0,
        surfaces: [{
          id: 'surf-companion' as any,
          type: 'terminal',
          startupCommands: ["codex '临时控制 SSH'"],
          sshControllerTargetSurfaceId: 'surf-remote' as any,
        }],
      },
    }]);

    const restored = store.getState().workspaces[0].splitTree;
    if (restored.type !== 'leaf') throw new Error('expected leaf');
    expect(restored.surfaces[0].startupCommands).toEqual([
      "codex --config history.persistence='none' '临时控制 SSH'",
    ]);
  });
});
