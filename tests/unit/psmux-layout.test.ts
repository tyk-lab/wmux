import { describe, expect, it } from 'vitest';
import { SplitNode } from '../../src/shared/types';
import {
  buildDefaultPsmuxSplitTree,
  createPsmuxDisplayName,
  createPsmuxSessionName,
  createPsmuxStartupCommand,
  getPsmuxSessionNames,
  getTerminalSurfaceIds,
  normalizePsmuxWorkspaceConfigs,
} from '../../src/renderer/store/psmux-layout';

describe('psmux layout', () => {
  const shortNameRe = /^wmx-[a-f0-9]{6}$/u;

  it('builds the default two-terminal horizontal psmux tree', () => {
    const tree = buildDefaultPsmuxSplitTree();

    expect(tree.type).toBe('branch');
    if (tree.type !== 'branch') return;

    expect(tree.direction).toBe('horizontal');
    expect(tree.ratio).toBe(0.5);
    expect(tree.children[0].type).toBe('leaf');
    expect(tree.children[1].type).toBe('leaf');

    const surfaceIds = getTerminalSurfaceIds(tree);
    expect(surfaceIds).toHaveLength(2);
    expect(new Set(surfaceIds).size).toBe(2);

    if (tree.children[0].type !== 'leaf' || tree.children[1].type !== 'leaf') return;
    const leftName = tree.children[0].surfaces[0].psmuxSessionName as string;
    const rightName = tree.children[1].surfaces[0].psmuxSessionName as string;
    expect(leftName).toMatch(shortNameRe);
    expect(rightName).toMatch(shortNameRe);
    expect(leftName).not.toBe(rightName);
    expect(tree.children[0].surfaces[0]).toMatchObject({
      customTitle: createPsmuxDisplayName(leftName),
    });
    expect(tree.children[0].surfaces[0].startupCommand).toBe(
      createPsmuxStartupCommand(leftName, 'new', tree.children[0].surfaces[0].id),
    );
    expect(tree.children[0].surfaces[0].startupCommand).not.toBe(
      tree.children[1].surfaces[0].startupCommand,
    );
    expect(tree.children[1].surfaces[0]).toMatchObject({
      customTitle: createPsmuxDisplayName(rightName),
    });
    expect(tree.children[1].surfaces[0].startupCommand).toBe(
      createPsmuxStartupCommand(rightName, 'new', tree.children[1].surfaces[0].id),
    );
  });

  it('uses a short unique psmux session name after existing names', () => {
    const sessionName = createPsmuxSessionName(['wmx-aaaaaa']);
    expect(sessionName).toMatch(shortNameRe);
    expect(sessionName).not.toBe('wmx-aaaaaa');

    const tree = buildDefaultPsmuxSplitTree(['wmx-aaaaaa']);
    const sessionNames = getPsmuxSessionNames(tree);
    expect(sessionNames).toHaveLength(2);
    expect(sessionNames.every((name) => shortNameRe.test(name))).toBe(true);
    expect(new Set([...sessionNames, 'wmx-aaaaaa']).size).toBe(3);
  });

  it('collects only terminal surfaces for psmux deletion cleanup', () => {
    const tree: SplitNode = {
      type: 'branch',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        {
          type: 'leaf',
          paneId: 'pane-left',
          surfaces: [
            { id: 'surf-terminal-1', type: 'terminal' },
            { id: 'surf-browser', type: 'browser' },
          ],
          activeSurfaceIndex: 0,
        },
        {
          type: 'leaf',
          paneId: 'pane-right',
          surfaces: [{ id: 'surf-terminal-2', type: 'terminal' }],
          activeSurfaceIndex: 0,
        },
      ],
    };

    expect(getTerminalSurfaceIds(tree)).toEqual(['surf-terminal-1', 'surf-terminal-2']);
  });

  it('collects only managed psmux session names', () => {
    const sessionName = 'psmux-12345678-1234-4234-9234-123456789abc';
    const tree: SplitNode = {
      type: 'leaf',
      paneId: 'pane-1',
      surfaces: [
        { id: 'surf-1', type: 'terminal', psmuxSessionName: sessionName },
        { id: 'surf-2', type: 'terminal' },
        { id: 'surf-browser', type: 'browser' },
      ],
      activeSurfaceIndex: 0,
    };

    expect(getPsmuxSessionNames(tree)).toEqual([sessionName]);
  });

  it('renames legacy default session titles without overwriting custom names', () => {
    const normalized = normalizePsmuxWorkspaceConfigs([
      {
        title: 'Session 1',
        splitTree: {
          type: 'leaf',
          paneId: 'pane-1',
          surfaces: [{ id: 'surf-1', type: 'terminal' }],
          activeSurfaceIndex: 0,
        },
      },
      { title: 'Workspace 2' },
      { title: 'prod api' },
      {},
    ]);

    expect(normalized.map((workspace) => workspace.title)).toEqual([
      'psmux 1',
      'psmux 2',
      'prod api',
      'psmux 4',
    ]);
    const firstTree = normalized[0].splitTree;
    expect(firstTree?.type).toBe('leaf');
    if (firstTree?.type !== 'leaf') return;
    const sessionName = firstTree.surfaces[0].psmuxSessionName as string;
    expect(sessionName).toMatch(shortNameRe);
    expect(firstTree.surfaces[0]).toMatchObject({
      customTitle: createPsmuxDisplayName(sessionName),
    });
    expect(firstTree.surfaces[0].startupCommand).toBe(
      createPsmuxStartupCommand(sessionName, 'attach', firstTree.surfaces[0].id),
    );
    expect(firstTree.surfaces[0].psmuxAttachExisting).toBe(true);
  });

  it('preserves safe custom psmux session names during normalization', () => {
    const normalized = normalizePsmuxWorkspaceConfigs([
      {
        title: 'psmux 1',
        splitTree: {
          type: 'leaf',
          paneId: 'pane-1',
          surfaces: [{ id: 'surf-1', type: 'terminal', psmuxSessionName: 'work-api' }],
          activeSurfaceIndex: 0,
        },
      },
    ]);

    const tree = normalized[0].splitTree;
    expect(tree?.type).toBe('leaf');
    if (tree?.type !== 'leaf') return;
    expect(tree.surfaces[0]).toMatchObject({
      psmuxSessionName: 'work-api',
      psmuxAttachExisting: true,
      startupCommand: 'psmux.exe -L surf-1 attach -t work-api',
    });
  });

  it('replaces unsafe restored psmux session names before building startup commands', () => {
    const normalized = normalizePsmuxWorkspaceConfigs([
      {
        title: 'psmux 1',
        splitTree: {
          type: 'leaf',
          paneId: 'pane-1',
          surfaces: [{ id: 'surf-1', type: 'terminal', psmuxSessionName: 'work;calc' }],
          activeSurfaceIndex: 0,
        },
      },
    ]);

    const tree = normalized[0].splitTree;
    expect(tree?.type).toBe('leaf');
    if (tree?.type !== 'leaf') return;
    expect(tree.surfaces[0].psmuxSessionName).toMatch(shortNameRe);
    expect(tree.surfaces[0].psmuxAttachExisting).toBe(true);
    expect(tree.surfaces[0].startupCommand).not.toContain('work;calc');
  });
});
