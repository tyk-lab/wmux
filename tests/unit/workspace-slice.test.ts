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
        type: 'branch', direction: 'horizontal', ratio: 0.5,
        children: [
          {
            type: 'leaf', paneId: 'pane-ssh' as any, activeSurfaceIndex: 0,
            surfaces: [{
              id: 'surf-remote' as any, type: 'terminal', sshRemote: true, sshProfileId: 'profile-a',
            }],
          },
          {
            type: 'leaf', paneId: 'pane-companion' as any, activeSurfaceIndex: 0,
            surfaces: [{
              id: 'surf-companion' as any,
              type: 'terminal',
              startupCommands: ["codex '临时控制 SSH'"],
              sshControllerTargetSurfaceId: 'surf-remote' as any,
            }],
          },
        ],
      },
    }]);

    const workspace = store.getState().workspaces[0];
    expect(workspace.sshConnectionState).toBe('disconnected');
    const restored = workspace.splitTree;
    if (restored.type !== 'branch' || restored.children[1].type !== 'leaf') {
      throw new Error('expected restored SSH split');
    }
    expect(restored.children[1].surfaces[0].sshControllerTargetSurfaceId).toBe('surf-remote');
    expect(restored.children[1].surfaces[0].startupCommands).toEqual([
      "codex --config history.persistence='none' '临时控制 SSH'",
    ]);
  });
});
