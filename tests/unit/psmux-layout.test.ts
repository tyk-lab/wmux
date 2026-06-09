import { describe, expect, it } from 'vitest';
import { SplitNode } from '../../src/shared/types';
import {
  buildDefaultPsmuxSplitTree,
  createPsmuxStartupCommand,
  getPsmuxSessionNames,
  getTerminalSurfaceIds,
  normalizePsmuxWorkspaceConfigs,
} from '../../src/renderer/store/psmux-layout';

describe('psmux layout', () => {
  it('builds the default two-terminal horizontal split', () => {
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
    expect(tree.children[0].surfaces[0]).toMatchObject({
      customTitle: 'psmux',
    });
    expect(tree.children[0].surfaces[0].psmuxSessionName).toMatch(/^psmux-/);
    expect(tree.children[0].surfaces[0].startupCommand).toBe(
      createPsmuxStartupCommand(tree.children[0].surfaces[0].psmuxSessionName as string),
    );
    expect(tree.children[1].surfaces[0]).toMatchObject({
      customTitle: 'psmux',
    });
    expect(tree.children[1].surfaces[0].psmuxSessionName).toMatch(/^psmux-/);
    expect(tree.children[1].surfaces[0].startupCommand).toBe(
      createPsmuxStartupCommand(tree.children[1].surfaces[0].psmuxSessionName as string),
    );
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
    expect(firstTree.surfaces[0]).toMatchObject({
      customTitle: 'psmux',
    });
    expect(firstTree.surfaces[0].psmuxSessionName).toMatch(/^psmux-[0-9a-f-]{36}$/);
    expect(firstTree.surfaces[0].startupCommand).toBe(
      createPsmuxStartupCommand(firstTree.surfaces[0].psmuxSessionName as string),
    );
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
      startupCommand: 'psmux.exe new -s work-api',
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
    expect(tree.surfaces[0].psmuxSessionName).toMatch(/^psmux-[0-9a-f-]{36}$/);
    expect(tree.surfaces[0].startupCommand).not.toContain('work;calc');
  });
});
