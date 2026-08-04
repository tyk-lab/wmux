import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { create } from 'zustand';
import { killSurfacePty, killTreeTerminalPtys, teardownWorkspaceRuntime } from '../../src/renderer/store/pty-teardown';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { SplitNode, SurfaceRef, SurfaceId, PaneId } from '../../src/shared/types';

// Regression coverage for issue #65: PTY teardown must run on every destructive
// close transition. These helpers are the shared reaping primitives the store
// actions call. They read window.wmux.pty.kill, which we mock here.

const term = (id: string): SurfaceRef => ({ id: id as SurfaceId, type: 'terminal' });
const browser = (id: string): SurfaceRef => ({ id: id as SurfaceId, type: 'browser' });
const leaf = (paneId: string, surfaces: SurfaceRef[]): SplitNode => ({
  type: 'leaf',
  paneId: paneId as PaneId,
  surfaces,
  activeSurfaceIndex: 0,
});

describe('pty-teardown', () => {
  let kill: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    kill = vi.fn();
    disconnect = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as any).window = { wmux: { pty: { kill }, ssh: { disconnect } } };
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it('kills the PTY of a terminal surface', () => {
    killSurfacePty(term('surf-1'));
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('surf-1');
  });

  it('does NOT kill non-terminal surfaces (no PTY to reap)', () => {
    killSurfacePty(browser('surf-b'));
    killSurfacePty({ id: 'surf-d' as SurfaceId, type: 'diff' });
    killSurfacePty({ id: 'surf-m' as SurfaceId, type: 'markdown' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('walks a split tree and kills every terminal, skipping non-terminals', () => {
    const tree: SplitNode = {
      type: 'branch',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        leaf('pane-1', [term('surf-1'), browser('surf-b'), term('surf-2')]),
        {
          type: 'branch',
          direction: 'vertical',
          ratio: 0.5,
          children: [
            leaf('pane-2', [term('surf-3')]),
            leaf('pane-3', [{ id: 'surf-md' as SurfaceId, type: 'markdown' }]),
          ],
        },
      ],
    };

    killTreeTerminalPtys(tree);

    expect(kill).toHaveBeenCalledTimes(3);
    expect(kill).toHaveBeenCalledWith('surf-1');
    expect(kill).toHaveBeenCalledWith('surf-2');
    expect(kill).toHaveBeenCalledWith('surf-3');
    expect(kill).not.toHaveBeenCalledWith('surf-b');
    expect(kill).not.toHaveBeenCalledWith('surf-md');
  });

  it('is a safe no-op when window/preload is unavailable (Node context)', () => {
    delete (globalThis as any).window;
    expect(() => killSurfacePty(term('surf-1'))).not.toThrow();
    expect(() => killTreeTerminalPtys(leaf('pane-1', [term('surf-1')]))).not.toThrow();
  });

  it('closes terminal PTYs and the SFTP session when an SSH workspace closes', () => {
    teardownWorkspaceRuntime({
      id: 'ws-ssh',
      sshProfileId: 'profile-a',
      splitTree: leaf('pane-1', [term('surf-ssh'), { id: 'surf-md' as SurfaceId, type: 'markdown' }]),
    });

    expect(kill).toHaveBeenCalledWith('surf-ssh');
    expect(disconnect).toHaveBeenCalledWith('ws-ssh');
  });

  it('does not request an SFTP disconnect for an ordinary local workspace', () => {
    teardownWorkspaceRuntime({ id: 'ws-local', splitTree: leaf('pane-1', [term('surf-local')]) });

    expect(kill).toHaveBeenCalledWith('surf-local');
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('disconnects SFTP and clears SSH metadata when the remote terminal is removed', () => {
    const store = create<WorkspaceSlice>()((...args) => createWorkspaceSlice(...args));
    const localPane = leaf('pane-local', [term('surf-local')]);
    const remotePane = leaf('pane-remote', [{
      ...term('surf-remote'),
      sshRemote: true,
      sshProfileId: 'profile-a',
    }]);
    const workspaceId = store.getState().createWorkspace({
      sshProfileId: 'profile-a',
      sshConnectionState: 'connected',
      splitTree: {
        type: 'branch',
        direction: 'horizontal',
        ratio: 0.5,
        children: [remotePane, localPane],
      },
    });

    store.getState().updateSplitTree(workspaceId, localPane);

    expect(disconnect).toHaveBeenCalledWith(workspaceId);
    expect(store.getState().workspaces[0]).toMatchObject({ splitTree: localPane });
    expect(store.getState().workspaces[0].sshProfileId).toBeUndefined();
    expect(store.getState().workspaces[0].sshConnectionState).toBeUndefined();
  });
});
