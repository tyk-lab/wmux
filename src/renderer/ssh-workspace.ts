import { v4 as uuid } from 'uuid';
import { PaneId, SplitNode, SshCompanionAgent, SshConnectionProfile, SshFileEntry, SurfaceId, SurfaceRef, WorkspaceInfo } from '../shared/types';
import { SSH_REMOTE_EDITING_RULES } from '../shared/ssh-agent-policy';

function quoteSshArgument(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}

function quotePowerShellArgument(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function suppressCodexHistory(command: string): string {
  const withoutExistingOverride = command.replace(
    /(^|\s)(?:--config|-c)(?:=|\s+)(?:"history\.persistence=[^"]*"|'history\.persistence=[^']*'|history\.persistence=(?:"[^"]*"|'[^']*'|\S+))/giu,
    '$1',
  ).replace(/\s{2,}/gu, ' ').trim();
  return withoutExistingOverride.replace(
    /^(codex(?:\.exe|\.cmd|\.bat)?)(?=\s|$)/iu,
    `$1 --config history.persistence=${quotePowerShellArgument('none')}`,
  );
}

/** Upgrade restored SSH companion surfaces before their temporary Codex process starts. */
export function suppressSshCompanionCodexHistory(tree: SplitNode): SplitNode {
  if (tree.type === 'branch') {
    return {
      ...tree,
      children: [
        suppressSshCompanionCodexHistory(tree.children[0]),
        suppressSshCompanionCodexHistory(tree.children[1]),
      ],
    };
  }
  return {
    ...tree,
    surfaces: tree.surfaces.map((surface) => {
      if (!surface.sshControllerTargetSurfaceId || !surface.startupCommands?.length) return surface;
      const startupCommands = surface.startupCommands.map(suppressCodexHistory);
      return startupCommands.every((command, index) => command === surface.startupCommands?.[index])
        ? surface
        : { ...surface, startupCommands };
    }),
  };
}

/** Gives the companion Agent terminal an explicit, scoped control contract. */
export function buildSshAgentInstruction(remoteSurfaceId: SurfaceId): string {
  return [
    '[SSH 远端 Agent 控制契约]',
    `你负责协助操作同一 wmux 工作区内的 SSH 终端，目标 surfaceId 是 ${remoteSurfaceId}。`,
    ...SSH_REMOTE_EDITING_RULES,
    '终端控制方式：',
    `读取最近输出：wmux read-screen --surface ${remoteSurfaceId} --lines 100。`,
    `SSH 断开后重连：wmux reconnect --surface ${remoteSurfaceId}。`,
    `发送文本：wmux send --surface ${remoteSurfaceId} "<命令或输入>"。`,
    `提交输入：wmux send-key enter --surface ${remoteSurfaceId}。`,
    `中断当前远程命令：wmux send-key c --ctrl --surface ${remoteSurfaceId}；键名是 c，Ctrl 用 --ctrl 修饰，不要把 ctrl+c 当作键名。`,
    '发送命令后必须再次读取屏幕，等待远端提示符或明确完成结果后再决定下一步。中断命令、删除数据、破坏性覆盖、安装软件、修改服务/进程/账号/权限/网络/系统配置前，必须获得用户明确批准。',
  // Keep Codex/Grok launch commands on one physical PowerShell line; Kimi receives
  // the same text as startup input, where the sentence boundaries remain explicit.
  ].join(' ');
}

export type SshReconnectTarget = {
  workspace: WorkspaceInfo;
  surface: SurfaceRef;
};

export type SshReconnectTargetResult =
  | { ok: true; target: SshReconnectTarget }
  | { ok: false; error: string };

/** Coalesce simultaneous connection attempts for one workspace or surface. */
export function runSshSingleFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const started = Promise.resolve().then(operation);
  const tracked = started.finally(() => {
    if (inFlight.get(key) === tracked) inFlight.delete(key);
  });
  inFlight.set(key, tracked);
  return tracked;
}

/** Dismiss only the host-key prompt whose accepted connection is being retried. */
export function dismissSshHostKeyRequestForWorkspace<T extends { workspaceId: string }>(
  request: T | null,
  workspaceId: string,
): T | null {
  return request?.workspaceId === workspaceId ? null : request;
}

/** Resolve an explicit SSH surface, or the remote surface bound to a companion Agent. */
export function resolveSshReconnectTarget(
  workspaces: WorkspaceInfo[],
  requestedSurfaceId?: string,
  callerSurfaceId?: string,
): SshReconnectTargetResult {
  let targetSurfaceId = requestedSurfaceId?.trim() || '';
  if (!targetSurfaceId && callerSurfaceId) {
    for (const workspace of workspaces) {
      if (workspace.splitTree.type === 'branch') {
        const pending = [workspace.splitTree.children[0], workspace.splitTree.children[1]];
        while (pending.length > 0) {
          const node = pending.pop()!;
          if (node.type === 'branch') {
            pending.push(node.children[0], node.children[1]);
            continue;
          }
          const caller = node.surfaces.find((surface) => surface.id === callerSurfaceId);
          if (caller?.sshControllerTargetSurfaceId) {
            targetSurfaceId = caller.sshControllerTargetSurfaceId;
            break;
          }
        }
      } else {
        const caller = workspace.splitTree.surfaces.find((surface) => surface.id === callerSurfaceId);
        if (caller?.sshControllerTargetSurfaceId) targetSurfaceId = caller.sshControllerTargetSurfaceId;
      }
      if (targetSurfaceId) break;
    }
  }
  if (!targetSurfaceId) {
    return { ok: false, error: '请指定 SSH Surface ID，或在对应的 SSH companion Agent 中运行此命令' };
  }

  for (const workspace of workspaces) {
    const pending: SplitNode[] = [workspace.splitTree];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (node.type === 'branch') {
        pending.push(node.children[0], node.children[1]);
        continue;
      }
      const surface = node.surfaces.find((candidate) => candidate.id === targetSurfaceId);
      if (!surface) continue;
      if (surface.type !== 'terminal' || !surface.sshRemote || !surface.sshProfileId) {
        return { ok: false, error: `surface ${targetSurfaceId} 不是可重连的 SSH 终端` };
      }
      return { ok: true, target: { workspace, surface } };
    }
  }
  return { ok: false, error: `找不到 SSH surface ${targetSurfaceId}` };
}

/** Runtime-only state recorded when the OpenSSH PTY exits unexpectedly. */
export function sshExitedWorkspaceMetadata(exitCode: number): Pick<WorkspaceInfo, 'sshConnectionState' | 'sshConnectionError'> {
  return {
    sshConnectionState: 'exited',
    sshConnectionError: `SSH 终端已退出（代码 ${exitCode}）`,
  };
}

export function sshTerminalErrorMetadata(error: string): Pick<WorkspaceInfo, 'sshConnectionState' | 'sshConnectionError'> {
  return {
    sshConnectionState: 'terminal-error',
    sshConnectionError: error,
  };
}

export function sshReconnectRuntimeFailure(
  workspace: Pick<WorkspaceInfo, 'sshConnectionState' | 'sshConnectionError'> | undefined,
): { ok: false; error: string } | undefined {
  if (
    workspace?.sshConnectionState !== 'exited'
    && workspace?.sshConnectionState !== 'terminal-error'
    && workspace?.sshConnectionState !== 'error'
  ) {
    return undefined;
  }
  return {
    ok: false,
    error: workspace.sshConnectionError || 'SSH 终端重连失败',
  };
}

/** Keep SFTP-only failures degradable while forcing PTY failures through a remount. */
export function sshTerminalPresentationState(
  surface: SurfaceRef,
  workspaceState: WorkspaceInfo['sshConnectionState'],
): WorkspaceInfo['sshConnectionState'] {
  const passwordManaged = surface.shell?.includes('PreferredAuthentications=password,keyboard-interactive');
  if (passwordManaged) return workspaceState;
  if (surface.sshRemote && (
    workspaceState === 'connecting'
    || workspaceState === 'disconnected'
    || workspaceState === 'exited'
    || workspaceState === 'terminal-error'
  )) {
    return workspaceState;
  }
  return undefined;
}

function buildCompanionSurface(
  agent: Exclude<SshCompanionAgent, 'none'>,
  instruction: string,
  remoteSurfaceId: SurfaceId,
): SurfaceRef {
  const displayName = agent === 'codex' ? 'Codex' : agent === 'kimi' ? 'Kimi' : 'Grok';
  if (agent === 'kimi') {
    return {
      id: `surf-${uuid()}` as SurfaceId,
      type: 'terminal',
      customTitle: `${displayName} · 控制 SSH`,
      shell: 'pwsh.exe',
      startupCommands: ['kimi'],
      startupInput: instruction,
      sshControllerTargetSurfaceId: remoteSurfaceId,
    };
  }
  const launchCommand = agent === 'codex' ? suppressCodexHistory(agent) : agent;
  return {
    id: `surf-${uuid()}` as SurfaceId,
    type: 'terminal',
    customTitle: `${displayName} · 控制 SSH`,
    shell: 'pwsh.exe',
    startupCommands: [`${launchCommand} ${quotePowerShellArgument(instruction)}`],
    sshControllerTargetSurfaceId: remoteSurfaceId,
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

export function sshDeleteErrorText(entry: Pick<SshFileEntry, 'name' | 'type'>, reason: unknown): string {
  const detail = reason instanceof Error ? reason.message : String(reason || 'SSH 服务器未提供具体原因');
  const label = entry.type === 'directory' ? '目录' : '文件';
  return `删除${label}“${entry.name}”失败：${detail}`;
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

export function findSshRemoteSurface(tree: SplitNode): SurfaceRef | undefined {
  if (tree.type === 'leaf') return tree.surfaces.find((surface) => surface.sshRemote);
  return findSshRemoteSurface(tree.children[0]) || findSshRemoteSurface(tree.children[1]);
}

export function sshCompanionAgentOf(surface: SurfaceRef): Exclude<SshCompanionAgent, 'none'> | undefined {
  if (!surface.sshControllerTargetSurfaceId) return undefined;
  const command = surface.startupCommands?.[0] || '';
  if (surface.customTitle?.startsWith('Kimi') || /^kimi(?:\s|$)/iu.test(command)) return 'kimi';
  if (surface.customTitle?.startsWith('Grok') || /^grok(?:\s|$)/iu.test(command)) return 'grok';
  if (surface.customTitle?.startsWith('Codex') || /^codex(?:\s|$)/iu.test(command)) return 'codex';
  return 'codex';
}

function findSshCompanion(
  tree: SplitNode,
  remoteSurfaceId: SurfaceId,
  agent?: Exclude<SshCompanionAgent, 'none'>,
): SurfaceRef | undefined {
  if (tree.type === 'leaf') {
    return tree.surfaces.find((surface) => (
      surface.sshControllerTargetSurfaceId === remoteSurfaceId
      && (!agent || sshCompanionAgentOf(surface) === agent)
    ));
  }
  return findSshCompanion(tree.children[0], remoteSurfaceId, agent)
    || findSshCompanion(tree.children[1], remoteSurfaceId, agent);
}

function splitLeafContainingSurface(
  tree: SplitNode,
  surfaceId: SurfaceId,
  companion: SurfaceRef,
): SplitNode {
  if (tree.type === 'leaf') {
    if (!tree.surfaces.some((surface) => surface.id === surfaceId)) return tree;
    return {
      type: 'branch',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        tree,
        {
          type: 'leaf',
          paneId: `pane-${uuid()}` as PaneId,
          surfaces: [companion],
          activeSurfaceIndex: 0,
        },
      ],
    };
  }
  const left = splitLeafContainingSurface(tree.children[0], surfaceId, companion);
  if (left !== tree.children[0]) return { ...tree, children: [left, tree.children[1]] };
  const right = splitLeafContainingSurface(tree.children[1], surfaceId, companion);
  if (right !== tree.children[1]) return { ...tree, children: [tree.children[0], right] };
  return tree;
}

/** Adds a local companion Agent beside an existing SSH terminal, skipping duplicates. */
export function attachSshCompanion(
  tree: SplitNode,
  agent: Exclude<SshCompanionAgent, 'none'>,
): SplitNode {
  const remote = findSshRemoteSurface(tree);
  if (!remote || findSshCompanion(tree, remote.id, agent)) return tree;
  return splitLeafContainingSurface(
    tree,
    remote.id,
    buildCompanionSurface(agent, buildSshAgentInstruction(remote.id), remote.id),
  );
}

/** Builds a direct SSH terminal, optionally with a local companion Agent. */
export function buildSshSplitTree(profile: SshConnectionProfile, companionAgent: SshCompanionAgent = 'codex'): SplitNode {
  const remoteSurface = {
    id: `surf-${uuid()}` as SurfaceId,
    type: 'terminal' as const,
    customTitle: `SSH · ${profile.name}`,
    shell: buildSshShell(profile),
    sshRemote: true,
    sshProfileId: profile.id,
  };
  const sshOnly: SplitNode = {
    type: 'leaf',
    paneId: `pane-${uuid()}` as PaneId,
    surfaces: [remoteSurface],
    activeSurfaceIndex: 0,
  };
  if (companionAgent === 'none') return sshOnly;
  return attachSshCompanion(sshOnly, companionAgent);
}
