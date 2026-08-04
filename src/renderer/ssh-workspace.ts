import { v4 as uuid } from 'uuid';
import { PaneId, SplitNode, SshConnectionProfile, SshFileEntry, SurfaceId, SurfaceRef } from '../shared/types';

function quoteSshArgument(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
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
  if (!entry || entry.type !== 'file') {
    return { selectedPaths: new Set(), anchorIndex: undefined };
  }
  if (range && anchorIndex !== undefined) {
    const [start, end] = [anchorIndex, clickedIndex].sort((a, b) => a - b);
    const paths = entries.slice(start, end + 1)
      .filter((item) => item.type === 'file')
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

function buildSshShell(profile: SshConnectionProfile): string {
  const identity = profile.authMethod === 'privateKey' && profile.privateKeyPath
    ? ` -i ${quoteSshArgument(profile.privateKeyPath)}`
    : '';
  const passwordOptions = profile.authMethod === 'password'
    ? ' -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no -o KbdInteractiveAuthentication=yes -o NumberOfPasswordPrompts=1'
    : '';
  const remoteShell = `ssh -p ${profile.port}${identity}${passwordOptions} ${profile.username}@${profile.host}`;
  const sessionBase = `ssh-${uuid().replace(/-/g, '').slice(0, 12)}`;
  return `psmux.exe new-session -s ${sessionBase} -- ${remoteShell}`;
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

/** Builds the remote terminal plus its ordinary local companion. */
export function buildSshSplitTree(profile: SshConnectionProfile): SplitNode {
  const remoteSurface = {
    id: `surf-${uuid()}` as SurfaceId,
    type: 'terminal' as const,
    shell: buildSshShell(profile),
    sshRemote: true,
    sshProfileId: profile.id,
  };

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
        surfaces: [{ id: `surf-${uuid()}` as SurfaceId, type: 'terminal' }],
        activeSurfaceIndex: 0,
      },
    ],
  };
}
