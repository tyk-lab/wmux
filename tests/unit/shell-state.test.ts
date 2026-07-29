import { describe, expect, it } from 'vitest';
import {
  aggregateShellStates,
  aggregateWorkspaceShellState,
  getTerminalSurfaceIds,
  isBusyToIdleTransition,
  isShellBusy,
} from '../../src/renderer/store/shell-state';
import type { SplitNode } from '../../src/shared/types';

describe('aggregateShellStates', () => {
  it('is busy when any terminal is running', () => {
    expect(aggregateShellStates(['idle', 'running', 'idle'])).toBe('running');
    expect(aggregateShellStates(['interrupted', 'running'])).toBe('running');
  });

  it('is idle only when every known terminal is idle', () => {
    expect(aggregateShellStates(['idle', 'idle'])).toBe('idle');
    expect(aggregateShellStates(['idle', undefined, 'idle'])).toBe('idle');
  });

  it('prefers interrupted over idle when nothing is running', () => {
    expect(aggregateShellStates(['idle', 'interrupted'])).toBe('interrupted');
  });

  it('returns undefined when no states are known', () => {
    expect(aggregateShellStates([])).toBeUndefined();
    expect(aggregateShellStates([undefined, null])).toBeUndefined();
  });
});

describe('isShellBusy / isBusyToIdleTransition', () => {
  it('treats only running as busy', () => {
    expect(isShellBusy('running')).toBe(true);
    expect(isShellBusy('idle')).toBe(false);
    expect(isShellBusy('interrupted')).toBe(false);
    expect(isShellBusy(undefined)).toBe(false);
  });

  it('detects busy→idle edges for attention/flash', () => {
    expect(isBusyToIdleTransition('running', 'idle')).toBe(true);
    expect(isBusyToIdleTransition('running', 'interrupted')).toBe(true);
    expect(isBusyToIdleTransition('idle', 'idle')).toBe(false);
    expect(isBusyToIdleTransition('running', 'running')).toBe(false);
    expect(isBusyToIdleTransition(undefined, 'idle')).toBe(false);
  });
});

describe('workspace tree helpers', () => {
  const tree: SplitNode = {
    type: 'branch',
    direction: 'horizontal',
    ratio: 0.5,
    children: [
      {
        type: 'leaf',
        paneId: 'pane-1' as any,
        activeSurfaceIndex: 0,
        surfaces: [
          { id: 'surf-a' as any, type: 'terminal' },
          { id: 'surf-b' as any, type: 'browser' },
        ],
      },
      {
        type: 'leaf',
        paneId: 'pane-2' as any,
        activeSurfaceIndex: 0,
        surfaces: [{ id: 'surf-c' as any, type: 'terminal' }],
      },
    ],
  };

  it('lists only terminal surfaces', () => {
    expect(getTerminalSurfaceIds(tree)).toEqual(['surf-a', 'surf-c']);
  });

  it('aggregates from the per-surface map across the tree', () => {
    expect(aggregateWorkspaceShellState(tree, {
      'surf-a': 'idle',
      'surf-c': 'running',
    })).toBe('running');

    expect(aggregateWorkspaceShellState(tree, {
      'surf-a': 'idle',
      'surf-c': 'idle',
    })).toBe('idle');
  });
});
