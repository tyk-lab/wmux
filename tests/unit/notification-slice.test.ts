import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { createNotificationSlice, NotificationSlice } from '../../src/renderer/store/notification-slice';
import { WorkspaceId, SurfaceId } from '../../src/shared/types';

type TestStore = WorkspaceSlice & NotificationSlice;

function makeStore() {
  return create<TestStore>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createNotificationSlice(...args),
  }));
}

describe('notification-slice', () => {
  let useStore: ReturnType<typeof makeStore>;
  let workspaceId: WorkspaceId;
  const surfaceId = 'surf-test-1' as SurfaceId;

  beforeEach(() => {
    useStore = makeStore();
    workspaceId = useStore.getState().createWorkspace({ title: 'Test WS' });
  });

  it('starts with empty notifications', () => {
    expect(useStore.getState().notifications).toEqual([]);
  });

  it('addNotification generates id, timestamp and read=false', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'hello' });
    const notifs = useStore.getState().notifications;
    expect(notifs.length).toBe(1);
    expect(notifs[0].id).toMatch(/^notif-/);
    expect(notifs[0].read).toBe(false);
    expect(typeof notifs[0].timestamp).toBe('number');
    expect(notifs[0].text).toBe('hello');
  });

  it('addNotification increments workspace unreadCount', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'ping' });
    const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
    expect(ws?.unreadCount).toBe(1);
  });

  it('replaces a repeated alert by dedupeKey without inflating unreadCount', () => {
    useStore.getState().addNotification({
      surfaceId,
      workspaceId,
      text: '第一次失败',
      dedupeKey: 'project:one:runtime-failed',
    });
    const originalId = useStore.getState().notifications[0].id;

    useStore.getState().addNotification({
      surfaceId,
      workspaceId,
      text: '恢复重试仍失败',
      dedupeKey: 'project:one:runtime-failed',
    });

    expect(useStore.getState().notifications).toHaveLength(1);
    expect(useStore.getState().notifications[0]).toMatchObject({
      id: originalId,
      text: '恢复重试仍失败',
      read: false,
    });
    expect(useStore.getState().workspaces.find((w) => w.id === workspaceId)?.unreadCount).toBe(1);
  });

  it('reopens a read alert when the same dedupeKey fails again', () => {
    useStore.getState().addNotification({
      surfaceId,
      workspaceId,
      text: '第一次失败',
      dedupeKey: 'supervisor:one:runtime-failed',
    });
    useStore.getState().markRead(surfaceId);
    useStore.getState().addNotification({
      surfaceId,
      workspaceId,
      text: '再次失败',
      dedupeKey: 'supervisor:one:runtime-failed',
    });

    expect(useStore.getState().notifications).toHaveLength(1);
    expect(useStore.getState().notifications[0]).toMatchObject({ text: '再次失败', read: false });
    expect(useStore.getState().workspaces.find((w) => w.id === workspaceId)?.unreadCount).toBe(1);
  });

  it('markRead marks notifications for a surface as read and decrements unreadCount', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'msg1' });
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'msg2' });
    useStore.getState().markRead(surfaceId);

    const notifs = useStore.getState().notifications;
    expect(notifs.every((n) => n.read)).toBe(true);

    const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
    expect(ws?.unreadCount).toBe(0);
  });

  it('markAllRead without workspaceId marks everything read', () => {
    const ws2Id = useStore.getState().createWorkspace({ title: 'WS2' });
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'a' });
    useStore.getState().addNotification({
      surfaceId: 'surf-test-2' as SurfaceId,
      workspaceId: ws2Id,
      text: 'b',
    });

    useStore.getState().markAllRead();
    expect(useStore.getState().notifications.every((n) => n.read)).toBe(true);
  });

  it('resolves only the matching alert and decrements its unread badge', () => {
    useStore.getState().addNotification({
      surfaceId,
      workspaceId,
      text: '模型受限',
      dedupeKey: 'supervisor:one:provider-limit',
    });
    useStore.getState().addNotification({
      surfaceId,
      workspaceId,
      text: '等待决定',
      dedupeKey: 'supervisor:one:decision',
    });

    useStore.getState().resolveNotification('supervisor:one:provider-limit');

    expect(useStore.getState().notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ dedupeKey: 'supervisor:one:provider-limit', read: true }),
      expect.objectContaining({ dedupeKey: 'supervisor:one:decision', read: false }),
    ]));
    expect(useStore.getState().workspaces.find((w) => w.id === workspaceId)?.unreadCount).toBe(1);
  });

  it('clearNotification removes a notification by id', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'x' });
    const id = useStore.getState().notifications[0].id;
    useStore.getState().clearNotification(id);
    expect(useStore.getState().notifications).toEqual([]);
  });

  it('clearAll empties notifications and resets unread badges', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'x' });
    expect(useStore.getState().workspaces.find((w) => w.id === workspaceId)?.unreadCount).toBe(1);
    useStore.getState().clearAll();
    expect(useStore.getState().notifications).toEqual([]);
    expect(useStore.getState().workspaces.find((w) => w.id === workspaceId)?.unreadCount).toBe(0);
  });

  it('jumpToUnread returns the last unread notification', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'first' });
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'second' });
    const result = useStore.getState().jumpToUnread();
    expect(result?.text).toBe('second');
  });

  it('jumpToUnread returns null when all notifications are read', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'x' });
    useStore.getState().markRead(surfaceId);
    expect(useStore.getState().jumpToUnread()).toBeNull();
  });
});
