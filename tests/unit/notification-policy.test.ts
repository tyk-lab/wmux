import { describe, expect, it } from 'vitest';
import {
  notificationMetadata,
  shouldNotifySupervisorUser,
} from '../../src/renderer/notification-policy';

describe('notification responsibility policy', () => {
  it('routes project attention to the project manager with a stable replacement key', () => {
    expect(notificationMetadata({
      owner: 'project',
      entityId: 'project-1',
      kind: 'manager-runtime-failed',
      projectId: 'project-1',
      sourceLabel: '示例项目',
    })).toEqual({
      owner: 'project',
      severity: 'attention',
      dedupeKey: 'project:project-1:manager-runtime-failed',
      action: 'open-project-manager',
      projectId: 'project-1',
      sourceLabel: '示例项目',
    });
  });

  it('keeps project-owned supervisor events internal', () => {
    expect(shouldNotifySupervisorUser('project-1')).toBe(false);
    expect(shouldNotifySupervisorUser()).toBe(true);
  });

  it('routes ordinary supervisor attention to its supervision surface', () => {
    expect(notificationMetadata({
      owner: 'supervisor',
      entityId: 'lane-1',
      kind: 'waiting-for-direction',
      laneId: 'lane-1',
    })).toMatchObject({
      owner: 'supervisor',
      dedupeKey: 'supervisor:lane-1:waiting-for-direction',
      action: 'open-supervisor',
      laneId: 'lane-1',
    });
  });
});
