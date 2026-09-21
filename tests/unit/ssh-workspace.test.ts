import { describe, expect, it } from 'vitest';
import {
  attachSshCompanion,
  attachSshProfileId,
  buildSshSplitTree,
  dismissSshHostKeyRequestForWorkspace,
  findSshFileSurface,
  isMissingSftpPathError,
  parentSshPath,
  resolveSshReconnectTarget,
  runSshSingleFlight,
  sshReconnectRuntimeFailure,
  sshTerminalErrorMetadata,
  sshTerminalPresentationState,
  sshDeleteErrorText,
  sshExitedWorkspaceMetadata,
  suppressSshCompanionCodexHistory,
  updateSshFileSelection,
  upgradeSshSplitTree,
} from '../../src/renderer/ssh-workspace';
import { SshConnectionProfile, SshFileEntry } from '../../src/shared/types';
import { isSshCompanionReconnectTargetAllowed } from '../../src/shared/ssh-agent-policy';

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

describe('SSH delete UI errors', () => {
  it('identifies the failed file and keeps the main-process reason', () => {
    expect(sshDeleteErrorText(
      { name: 'config.yaml', type: 'file' },
      new Error('没有删除远程文件的权限；请检查所在目录的写权限和文件所有者'),
    )).toBe('删除文件“config.yaml”失败：没有删除远程文件的权限；请检查所在目录的写权限和文件所有者');
  });
});

describe('SSH host-key prompt transitions', () => {
  it('dismisses only the prompt for the accepted workspace', () => {
    const request = { workspaceId: 'ws-a', prompt: 'fingerprint' };

    expect(dismissSshHostKeyRequestForWorkspace(request, 'ws-a')).toBeNull();
    expect(dismissSshHostKeyRequestForWorkspace(request, 'ws-b')).toBe(request);
    expect(dismissSshHostKeyRequestForWorkspace(null, 'ws-a')).toBeNull();
  });
});

describe('buildSshSplitTree', () => {
  it('forces one password prompt and attaches only a secret-free credential id', () => {
    const tree = buildSshSplitTree(profile('password'));
    expect(tree.type).toBe('branch');
    if (tree.type !== 'branch') return;
    const remote = tree.children[0].type === 'leaf' ? tree.children[0].surfaces[0] : undefined;

    expect(remote?.shell).toMatch(/^ssh\.exe -p 2222 /);
    expect(remote?.shell).toContain('PreferredAuthentications=password,keyboard-interactive');
    expect(remote?.shell).toContain('NumberOfPasswordPrompts=1');
    expect(remote?.sshProfileId).toBe('profile-a');
    expect(remote).not.toHaveProperty('password');
  });

  it('starts a Codex companion with scoped instructions for controlling the SSH terminal', () => {
    const tree = buildSshSplitTree(profile('agent'));
    if (tree.type !== 'branch' || tree.children[0].type !== 'leaf' || tree.children[1].type !== 'leaf') return;
    const remote = tree.children[0].surfaces[0];
    const companion = tree.children[1].surfaces[0];
    const launchCommand = companion.startupCommands?.[0] || '';

    expect(remote.customTitle).toBe('SSH · Production');
    expect(companion.customTitle).toBe('Codex · 控制 SSH');
    expect(companion.shell).toBe('pwsh.exe');
    expect(companion.sshControllerTargetSurfaceId).toBe(remote.id);
    expect(launchCommand).toMatch(/^codex --config history\.persistence='none' '/);
    expect(launchCommand).not.toMatch(/[\r\n]/);
    expect(launchCommand).toContain(remote.id);
    expect(launchCommand).toContain('wmux read-screen --surface');
    expect(launchCommand).toContain(`wmux reconnect --surface ${remote.id}`);
    expect(launchCommand).toContain('wmux send --surface');
    expect(launchCommand).toContain('wmux send-key enter --surface');
    expect(launchCommand).toContain(`wmux send-key c --ctrl --surface ${remote.id}`);
    expect(launchCommand).toContain('不要把 ctrl+c 当作键名');
    expect(launchCommand).toContain('目标项目只存在于 SSH 远端');
    expect(launchCommand).toContain('禁止使用本地 apply_patch');
    expect(launchCommand).toContain('wmux ssh-file checkout');
    expect(launchCommand).toContain('wmux ssh-file commit');
    expect(launchCommand).toContain('只有远端输出可作为完成证据');
  });

  it('attaches a companion to an existing SSH-only tree without duplicating the same agent', () => {
    const sshOnly = buildSshSplitTree(profile('agent'), 'none');
    expect(sshOnly.type).toBe('leaf');
    const withCodex = attachSshCompanion(sshOnly, 'codex');
    expect(withCodex.type).toBe('branch');
    if (withCodex.type !== 'branch' || withCodex.children[1].type !== 'leaf') return;
    expect(withCodex.children[1].surfaces[0].customTitle).toBe('Codex · 控制 SSH');
    expect(attachSshCompanion(withCodex, 'codex')).toBe(withCodex);

    const withKimi = attachSshCompanion(withCodex, 'kimi');
    expect(withKimi).not.toBe(withCodex);
    if (withKimi.type !== 'branch') return;
    const titles: string[] = [];
    const walk = (node: typeof withKimi) => {
      if (node.type === 'leaf') titles.push(...node.surfaces.map((surface) => surface.customTitle || ''));
      else {
        walk(node.children[0] as typeof withKimi);
        walk(node.children[1] as typeof withKimi);
      }
    };
    walk(withKimi);
    expect(titles).toContain('Codex · 控制 SSH');
    expect(titles).toContain('Kimi · 控制 SSH');
  });

  it('supports Kimi, Grok, or no companion agent', () => {
    const kimiTree = buildSshSplitTree(profile('agent'), 'kimi');
    const grokTree = buildSshSplitTree(profile('agent'), 'grok');
    const sshOnlyTree = buildSshSplitTree(profile('agent'), 'none');
    if (kimiTree.type !== 'branch' || kimiTree.children[1].type !== 'leaf') return;
    if (grokTree.type !== 'branch' || grokTree.children[1].type !== 'leaf') return;

    const kimi = kimiTree.children[1].surfaces[0];
    const grok = grokTree.children[1].surfaces[0];
    expect(kimi.customTitle).toBe('Kimi · 控制 SSH');
    expect(kimi.startupCommands).toEqual(['kimi']);
    expect(kimi.startupInput).toContain('wmux send-key c --ctrl --surface');
    expect(kimi.startupCommands[0]).not.toContain('history.persistence');
    expect(kimi.startupInput).toContain('禁止使用本地 apply_patch');
    expect(kimi.sshControllerTargetSurfaceId).toBe(kimiTree.children[0].type === 'leaf'
      ? kimiTree.children[0].surfaces[0].id
      : undefined);
    expect(grok.customTitle).toBe('Grok · 控制 SSH');
    expect(grok.startupCommands?.[0]).toContain('目标项目只存在于 SSH 远端');
    expect(grok.startupCommands?.[0]).not.toContain('history.persistence');
    expect(grok.startupCommands?.[0]).toMatch(/^grok '/);
    expect(sshOnlyTree.type).toBe('leaf');
    if (sshOnlyTree.type === 'leaf') expect(sshOnlyTree.surfaces).toHaveLength(1);
  });

  it('upgrades a restored legacy Codex companion without changing other Agents', () => {
    const tree = buildSshSplitTree(profile('agent'));
    if (tree.type !== 'branch' || tree.children[1].type !== 'leaf') return;
    const companion = tree.children[1].surfaces[0];
    companion.startupCommands = [
      "codex -c history.persistence=save-all '临时控制 SSH'",
    ];

    const upgraded = suppressSshCompanionCodexHistory(tree);
    if (upgraded.type !== 'branch' || upgraded.children[1].type !== 'leaf') return;
    const upgradedCommand = upgraded.children[1].surfaces[0].startupCommands?.[0];

    expect(upgradedCommand).toBe("codex --config history.persistence='none' '临时控制 SSH'");
    expect(suppressSshCompanionCodexHistory(upgraded)).toEqual(upgraded);

    const kimiTree = buildSshSplitTree(profile('agent'), 'kimi');
    expect(suppressSshCompanionCodexHistory(kimiTree)).toEqual(kimiTree);
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

describe('SSH reconnect targeting', () => {
  it('allows a companion to reconnect only its bound target', () => {
    expect(isSshCompanionReconnectTargetAllowed('surf-ssh', undefined)).toBe(true);
    expect(isSshCompanionReconnectTargetAllowed('surf-ssh', '')).toBe(true);
    expect(isSshCompanionReconnectTargetAllowed('surf-ssh', 'surf-ssh')).toBe(true);
    expect(isSshCompanionReconnectTargetAllowed('surf-ssh', 'surf-other')).toBe(false);
    expect(isSshCompanionReconnectTargetAllowed(undefined, 'surf-ssh')).toBe(false);
  });

  it('coalesces concurrent reconnects and permits a later retry', async () => {
    const inFlight = new Map<string, Promise<boolean>>();
    let finish!: (value: boolean) => void;
    let starts = 0;
    const operation = () => {
      starts++;
      return new Promise<boolean>((resolve) => { finish = resolve; });
    };

    const first = runSshSingleFlight(inFlight, 'ws-remote', operation);
    const second = runSshSingleFlight(inFlight, 'ws-remote', operation);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(starts).toBe(1);
    finish(true);
    await expect(first).resolves.toBe(true);

    await expect(runSshSingleFlight(inFlight, 'ws-remote', async () => false)).resolves.toBe(false);
  });

  it('resolves an explicit SSH surface without changing its identity', () => {
    const tree = buildSshSplitTree(profile('agent'));
    const workspace = {
      id: 'ws-remote',
      title: 'Production',
      pinned: false,
      shell: 'pwsh.exe',
      splitTree: tree,
      unreadCount: 0,
      sshProfileId: 'profile-a',
      sshConnectionState: 'exited' as const,
    } as any;
    if (tree.type !== 'branch' || tree.children[0].type !== 'leaf') return;
    const remote = tree.children[0].surfaces[0];

    const resolved = resolveSshReconnectTarget([workspace], remote.id);

    expect(resolved).toMatchObject({
      ok: true,
      target: { workspace: { id: 'ws-remote' }, surface: { id: remote.id } },
    });
  });

  it('defaults a companion Agent to only its bound SSH surface', () => {
    const tree = buildSshSplitTree(profile('agent'));
    const workspace = {
      id: 'ws-remote', title: 'Production', pinned: false, shell: 'pwsh.exe',
      splitTree: tree, unreadCount: 0,
    } as any;
    if (tree.type !== 'branch' || tree.children[0].type !== 'leaf' || tree.children[1].type !== 'leaf') return;
    const remote = tree.children[0].surfaces[0];
    const companion = tree.children[1].surfaces[0];

    expect(resolveSshReconnectTarget([workspace], undefined, companion.id)).toMatchObject({
      ok: true,
      target: { surface: { id: remote.id } },
    });
    expect(resolveSshReconnectTarget([workspace])).toMatchObject({ ok: false });
    expect(resolveSshReconnectTarget([workspace], companion.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('不是可重连的 SSH 终端'),
    });
  });

  it('records an exited runtime without clearing the persisted profile id', () => {
    expect(sshExitedWorkspaceMetadata(255)).toEqual({
      sshConnectionState: 'exited',
      sshConnectionError: 'SSH 终端已退出（代码 255）',
    });
    expect(sshExitedWorkspaceMetadata(255)).not.toHaveProperty('sshProfileId');
    expect(sshTerminalErrorMetadata('无法创建终端')).toEqual({
      sshConnectionState: 'terminal-error',
      sshConnectionError: '无法创建终端',
    });
    expect(sshReconnectRuntimeFailure({
      sshConnectionState: 'exited',
      sshConnectionError: 'SSH 终端已退出（代码 255）',
    })).toEqual({ ok: false, error: 'SSH 终端已退出（代码 255）' });
    expect(sshReconnectRuntimeFailure({ sshConnectionState: 'connected' })).toBeUndefined();
  });

  it('remounts a key-based SSH terminal only for terminal runtime failures', () => {
    const tree = buildSshSplitTree(profile('agent'), 'none');
    if (tree.type !== 'leaf') return;
    const remote = tree.surfaces[0];

    expect(sshTerminalPresentationState(remote, 'error')).toBeUndefined();
    expect(sshTerminalPresentationState(remote, 'terminal-error')).toBe('terminal-error');
    expect(sshTerminalPresentationState(remote, 'connected')).toBeUndefined();
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
