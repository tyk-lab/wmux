import { v4 as uuid } from 'uuid';
import { PaneId, SplitNode, SshCompanionAgent, SshConnectionProfile, SshFileEntry, SurfaceId, SurfaceRef } from '../shared/types';

function quoteSshArgument(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}

function quotePowerShellArgument(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Gives the companion Agent terminal an explicit, scoped control contract. */
export function buildSshAgentInstruction(remoteSurfaceId: SurfaceId): string {
  return [
    `你负责协助操作同一 wmux 工作区内的 SSH 终端，目标 surfaceId 是 ${remoteSurfaceId}。`,
    `读取最近输出：wmux read-screen --surface ${remoteSurfaceId} --lines 100。`,
    `发送文本：wmux send --surface ${remoteSurfaceId} "<命令或输入>"。`,
    `提交输入：wmux send-key enter --surface ${remoteSurfaceId}。`,
    `中断当前远程命令：wmux send-key c --ctrl --surface ${remoteSurfaceId}；键名是 c，Ctrl 用 --ctrl 修饰，不要把 ctrl+c 当作键名。`,
    '发送后必须再读取屏幕确认结果。中断命令、删除数据、安装软件、修改服务/进程/账号/权限/网络/系统配置前，必须获得用户明确批准。',
  ].join(' ');
}

function buildCompanionSurface(agent: Exclude<SshCompanionAgent, 'none'>, instruction: string): SurfaceRef {
  const displayName = agent === 'codex' ? 'Codex' : agent === 'kimi' ? 'Kimi' : 'Grok';
  if (agent === 'kimi') {
    return {
      id: `surf-${uuid()}` as SurfaceId,
      type: 'terminal',
      customTitle: `${displayName} · 控制 SSH`,
      shell: 'pwsh.exe',
      startupCommands: ['kimi'],
      startupInput: instruction,
    };
  }
  return {
    id: `surf-${uuid()}` as SurfaceId,
    type: 'terminal',
    customTitle: `${displayName} · 控制 SSH`,
    shell: 'pwsh.exe',
    startupCommands: [`${agent} ${quotePowerShellArgument(instruction)}`],
  };
}

/** Returns a valid POSIX parent for absolute and home-relative SFTP paths. */
export function parentSshPath(current: string): string {
  const clean = current.replace(/\/+$/, '') || '/';
  if (clean === '/' || clean === '.') return clean;
  const separator = clean.lastIndexOf('/');
  if (separator < 0) return '.';
  return clean.slice(0, separator) || '/';
}

export function isMissingSftpPathError(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /no such file|not found|不存在/i.test(message);
}

export function updateSshFileSelection(
  entries: SshFileEntry[],
  selectedPaths: ReadonlySet<string>,
  clickedIndex: number,
  anchorIndex: number | undefined,
  additive: boolean,
  range: boolean,
): { selectedPaths: Set<string>; anchorIndex: number | undefined } {
  const entry = entries[clickedIndex];
  if (!entry || (entry.type !== 'file' && entry.type !== 'directory')) {
    return { selectedPaths: new Set(), anchorIndex: undefined };
  }
  if (range && anchorIndex !== undefined) {
    const [start, end] = [anchorIndex, clickedIndex].sort((a, b) => a - b);
    const paths = entries.slice(start, end + 1)
      .filter((item) => item.type === 'file' || item.type === 'directory')
      .map((item) => item.path);
    return {
      selectedPaths: additive ? new Set([...selectedPaths, ...paths]) : new Set(paths),
      anchorIndex: clickedIndex,
    };
  }
  if (additive) {
    const next = new Set(selectedPaths);
    if (next.has(entry.path)) next.delete(entry.path);
    else next.add(entry.path);
    return { selectedPaths: next, anchorIndex: clickedIndex };
  }
  return { selectedPaths: new Set([entry.path]), anchorIndex: clickedIndex };
}

/** Finds an already-open editor for one remote path so double-clicking reuses its tab. */
export function findSshFileSurface(
  tree: SplitNode,
  workspaceId: string,
  remotePath: string,
): { paneId: PaneId; surfaceId: SurfaceId; index: number } | null {
  if (tree.type === 'branch') {
    return findSshFileSurface(tree.children[0], workspaceId, remotePath)
      || findSshFileSurface(tree.children[1], workspaceId, remotePath);
  }
  const index = tree.surfaces.findIndex((surface) =>
    surface.sshFileWorkspaceId === workspaceId && surface.sshFilePath === remotePath);
  return index >= 0 ? { paneId: tree.paneId, surfaceId: tree.surfaces[index].id, index } : null;
}

function buildSshShell(profile: SshConnectionProfile): string {
  const identity = profile.authMethod === 'privateKey' && profile.privateKeyPath
    ? ` -i ${quoteSshArgument(profile.privateKeyPath)}`
    : '';
  const passwordOptions = profile.authMethod === 'password'
    ? ' -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no -o KbdInteractiveAuthentication=yes -o NumberOfPasswordPrompts=1'
    : '';
  return `ssh.exe -p ${profile.port}${identity}${passwordOptions} ${profile.username}@${profile.host}`;
}

function mapSshSurfaces(tree: SplitNode, update: (surface: SurfaceRef) => SurfaceRef): SplitNode {
  if (tree.type === 'branch') {
    return { ...tree, children: [mapSshSurfaces(tree.children[0], update), mapSshSurfaces(tree.children[1], update)] };
  }
  return {
    ...tree,
    surfaces: tree.surfaces.map((surface) => surface.sshRemote ? update(surface) : surface),
  };
}

/** Adds the profile lookup id to workspaces saved before credential management existed. */
export function attachSshProfileId(tree: SplitNode, profileId: string): SplitNode {
  return mapSshSurfaces(tree, (surface) => ({ ...surface, sshProfileId: profileId }));
}

/** Converts an existing SSH terminal to the password-managed launch form without changing pane ids. */
export function upgradeSshSplitTree(tree: SplitNode, profile: SshConnectionProfile): SplitNode {
  return mapSshSurfaces(tree, (surface) => ({
    ...surface,
    shell: buildSshShell(profile),
    sshProfileId: profile.id,
  }));
}

/** Builds a direct SSH terminal plus a local Codex terminal scoped to control it. */
export function buildSshSplitTree(profile: SshConnectionProfile, companionAgent: SshCompanionAgent = 'codex'): SplitNode {
  const remoteSurface = {
    id: `surf-${uuid()}` as SurfaceId,
    type: 'terminal' as const,
    customTitle: `SSH · ${profile.name}`,
    shell: buildSshShell(profile),
    sshRemote: true,
    sshProfileId: profile.id,
  };
  if (companionAgent === 'none') {
    return {
      type: 'leaf',
      paneId: `pane-${uuid()}` as PaneId,
      surfaces: [remoteSurface],
      activeSurfaceIndex: 0,
    };
  }
  const agentInstruction = buildSshAgentInstruction(remoteSurface.id);

  return {
    type: 'branch',
    direction: 'horizontal',
    ratio: 0.5,
    children: [
      {
        type: 'leaf',
        paneId: `pane-${uuid()}` as PaneId,
        surfaces: [remoteSurface],
        activeSurfaceIndex: 0,
      },
      {
        type: 'leaf',
        paneId: `pane-${uuid()}` as PaneId,
        surfaces: [buildCompanionSurface(companionAgent, agentInstruction)],
        activeSurfaceIndex: 0,
      },
    ],
  };
}
