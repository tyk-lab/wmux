import { describe, expect, it } from 'vitest';
import {
  notificationMetadata,
  shouldFlashTaskbar,
  shouldNotifySupervisorUser,
} from '../../src/renderer/notification-policy';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/renderer/store/settings-slice';

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

  it('enables taskbar flashing by default and only requests it for an unfocused window', () => {
    expect(DEFAULT_NOTIFICATION_PREFS.taskbarFlash).toBe(true);
    expect(shouldFlashTaskbar(true, false)).toBe(true);
    expect(shouldFlashTaskbar(false, false)).toBe(false);
    expect(shouldFlashTaskbar(true, true)).toBe(false);
    expect(shouldFlashTaskbar(true, false, false)).toBe(false);
  });
});
