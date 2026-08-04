import { describe, expect, it } from 'vitest';
import {
  attachSshProfileId,
  buildSshSplitTree,
  findSshFileSurface,
  isMissingSftpPathError,
  parentSshPath,
  updateSshFileSelection,
  upgradeSshSplitTree,
} from '../../src/renderer/ssh-workspace';
import { SshConnectionProfile, SshFileEntry } from '../../src/shared/types';

function profile(authMethod: SshConnectionProfile['authMethod']): SshConnectionProfile {
  return {
    id: 'profile-a',
    name: 'Production',
    host: 'server.example.com',
    port: 2222,
    username: 'deploy',
    authMethod,
  };
}

describe('buildSshSplitTree', () => {
  it('forces one password prompt and attaches only a secret-free credential id', () => {
    const tree = buildSshSplitTree(profile('password'));
    expect(tree.type).toBe('branch');
    if (tree.type !== 'branch') return;
    const remote = tree.children[0].type === 'leaf' ? tree.children[0].surfaces[0] : undefined;

    expect(remote?.shell).toContain('psmux.exe new-session');
    expect(remote?.shell).toContain('PreferredAuthentications=password,keyboard-interactive');
    expect(remote?.shell).toContain('NumberOfPasswordPrompts=1');
    expect(remote?.sshProfileId).toBe('profile-a');
    expect(remote).not.toHaveProperty('password');
  });

  it('keeps a secret-free profile id on agent terminals for password fallback', () => {
    const tree = buildSshSplitTree(profile('agent'));
    if (tree.type !== 'branch' || tree.children[0].type !== 'leaf') return;

    expect(tree.children[0].surfaces[0].sshProfileId).toBe('profile-a');
    expect(tree.children[0].surfaces[0].shell).not.toContain('PreferredAuthentications=password');
  });

  it('upgrades a legacy agent terminal without changing its pane or surface ids', () => {
    const tree = buildSshSplitTree(profile('agent'));
    if (tree.type !== 'branch' || tree.children[0].type !== 'leaf') return;
    const paneId = tree.children[0].paneId;
    const surfaceId = tree.children[0].surfaces[0].id;
    delete tree.children[0].surfaces[0].sshProfileId;

    const attached = attachSshProfileId(tree, 'profile-a');
    const upgraded = upgradeSshSplitTree(attached, profile('password'));
    if (upgraded.type !== 'branch' || upgraded.children[0].type !== 'leaf') return;

    expect(upgraded.children[0].paneId).toBe(paneId);
    expect(upgraded.children[0].surfaces[0].id).toBe(surfaceId);
    expect(upgraded.children[0].surfaces[0].sshProfileId).toBe('profile-a');
    expect(upgraded.children[0].surfaces[0].shell).toContain('PreferredAuthentications=password');
  });
});

describe('parentSshPath', () => {
  it('returns the home-relative root for a single-segment directory', () => {
    expect(parentSshPath('.git')).toBe('.');
    expect(parentSshPath('src')).toBe('.');
  });

  it('handles nested relative and absolute directories', () => {
    expect(parentSshPath('.git/hooks')).toBe('.git');
    expect(parentSshPath('/srv/app')).toBe('/srv');
    expect(parentSshPath('/')).toBe('/');
  });

  it('recognizes missing remote directory errors for automatic recovery', () => {
    expect(isMissingSftpPathError(new Error('No such file'))).toBe(true);
    expect(isMissingSftpPathError('远程目录不存在')).toBe(true);
    expect(isMissingSftpPathError(new Error('Permission denied'))).toBe(false);
  });
});

describe('findSshFileSurface', () => {
  it('finds the pane and tab for an already-open remote file', () => {
    const tree = buildSshSplitTree(profile('agent'));
    if (tree.type !== 'branch' || tree.children[1].type !== 'leaf') return;
    tree.children[1].surfaces.push({
      id: 'surf-editor',
      type: 'markdown',
      sshFileWorkspaceId: 'ws-remote',
      sshFilePath: '/home/pi/fluidd.cfg',
    });

    expect(findSshFileSurface(tree, 'ws-remote', '/home/pi/fluidd.cfg')).toEqual({
      paneId: tree.children[1].paneId,
      surfaceId: 'surf-editor',
      index: 1,
    });
    expect(findSshFileSurface(tree, 'ws-other', '/home/pi/fluidd.cfg')).toBeNull();
  });
});

describe('updateSshFileSelection', () => {
  const entries: SshFileEntry[] = [
    { name: 'a.txt', path: '/a.txt', type: 'file', size: 1 },
    { name: 'folder', path: '/folder', type: 'directory', size: 0 },
    { name: 'b.txt', path: '/b.txt', type: 'file', size: 2 },
    { name: 'c.txt', path: '/c.txt', type: 'file', size: 3 },
  ];

  it('supports Ctrl toggling for files and directories', () => {
    const added = updateSshFileSelection(entries, new Set(['/a.txt']), 2, 0, true, false);
    expect([...added.selectedPaths]).toEqual(['/a.txt', '/b.txt']);

    const removed = updateSshFileSelection(entries, added.selectedPaths, 0, 2, true, false);
    expect([...removed.selectedPaths]).toEqual(['/b.txt']);

    const directory = updateSshFileSelection(entries, removed.selectedPaths, 1, 0, false, false);
    expect([...directory.selectedPaths]).toEqual(['/folder']);
    expect(directory.anchorIndex).toBe(1);
  });

  it('selects files and directories in a Shift range and can add that range', () => {
    const range = updateSshFileSelection(entries, new Set(), 3, 0, false, true);
    expect([...range.selectedPaths]).toEqual(['/a.txt', '/folder', '/b.txt', '/c.txt']);

    const additive = updateSshFileSelection(entries, new Set(['/c.txt']), 2, 0, true, true);
    expect([...additive.selectedPaths]).toEqual(['/c.txt', '/a.txt', '/folder', '/b.txt']);
  });
});
