import { describe, expect, it } from 'vitest';
import {
  canStartManagedProjectRuntimeRecovery,
  managedProjectRuntimeRecoveryKey,
} from '../../src/renderer/project-manager/runtime-recovery';

describe('project manager runtime recovery', () => {
  it('uses one stable recovery scope across replacement supervisor lanes', () => {
    const first = managedProjectRuntimeRecoveryKey({
      projectId: 'pm-1', role: 'supervisor', workItemId: 'task-1',
    });
    const replacement = managedProjectRuntimeRecoveryKey({
      projectId: 'pm-1', role: 'supervisor', workItemId: 'task-1',
    });

    expect(replacement).toBe(first);
    expect(canStartManagedProjectRuntimeRecovery(first, new Set(), new Set())).toBe(true);
    expect(canStartManagedProjectRuntimeRecovery(first, new Set([first]), new Set())).toBe(false);
    expect(canStartManagedProjectRuntimeRecovery(first, new Set(), new Set([first]))).toBe(false);
  });
});
