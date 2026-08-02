import { describe, expect, it } from 'vitest';
import type { SplitNode } from '../../src/shared/types';
import { omitTransientSupervisorWorkspaces } from '../../src/renderer/supervisor/session-restore';

function leaf(surfaces: any[], activeSurfaceIndex = 0): SplitNode {
  return { type: 'leaf', paneId: 'pane-a' as any, surfaces, activeSurfaceIndex };
}

describe('supervisor session restore', () => {
  it('omits dedicated supervisor terminals and the supervisor panel from restored layouts', () => {
    const result = omitTransientSupervisorWorkspaces([
      {
        id: 'ws-work' as any,
        splitTree: leaf([
          { id: 'worker' as any, type: 'terminal' },
          { id: 'supervisor-terminal' as any, type: 'terminal', customTitle: 'AI 监督 · worker', startupCommands: ['codex'], transientSupervisor: true },
          { id: 'supervisor-panel' as any, type: 'supervisor' },
        ], 2),
      },
    ]);

    expect(result.workspaces).toHaveLength(1);
    const restored = result.workspaces[0].splitTree;
    expect(restored.type).toBe('leaf');
    if (restored.type !== 'leaf') return;
    expect(restored.surfaces).toEqual([{ id: 'worker', type: 'terminal' }]);
    expect(restored.activeSurfaceIndex).toBe(0);
  });

  it('drops an AI-supervision-only workspace and remaps the active workspace', () => {
    const result = omitTransientSupervisorWorkspaces([
      {
        id: 'ws-work' as any,
        splitTree: leaf([{ id: 'worker' as any, type: 'terminal' }]),
      },
      {
        id: 'ws-supervisor' as any,
        splitTree: leaf([{ id: 'supervisor-panel' as any, type: 'supervisor' }]),
      },
    ], 1);

    expect(result.workspaces.map((workspace) => workspace.id)).toEqual(['ws-work']);
    expect(result.activeIndex).toBe(0);
  });

  it('retains a user terminal that merely has an AI supervision-like title', () => {
    const result = omitTransientSupervisorWorkspaces([{
      id: 'ws-work' as any,
      splitTree: leaf([{ id: 'user-terminal' as any, type: 'terminal', customTitle: 'AI 监督 · 备忘', startupCommands: ['codex'] }]),
    }]);

    expect(result.workspaces).toHaveLength(1);
  });

  it('removes an existing dedicated supervisor by its live lane surface id', () => {
    const result = omitTransientSupervisorWorkspaces([{
      id: 'ws-work' as any,
      splitTree: leaf([
        { id: 'worker' as any, type: 'terminal' },
        { id: 'legacy-supervisor' as any, type: 'terminal', customTitle: 'AI 监督 · worker', startupCommands: ['custom-ai'] },
      ]),
    }], 0, ['legacy-supervisor']);

    const restored = result.workspaces[0].splitTree;
    expect(restored.type).toBe('leaf');
    if (restored.type !== 'leaf') return;
    expect(restored.surfaces.map((surface) => surface.id)).toEqual(['worker']);
  });
});
