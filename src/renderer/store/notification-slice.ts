import { StateCreator } from 'zustand';
import { v4 as uuid } from 'uuid';
import { NotificationInfo, SurfaceId, WorkspaceId } from '../../shared/types';
import { WorkspaceSlice } from './workspace-slice';

const MAX_NOTIFICATIONS = 200;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NotificationSlice {
  notifications: NotificationInfo[];
  addNotification: (notification: Omit<NotificationInfo, 'id' | 'timestamp' | 'read'>) => void;
  markRead: (surfaceId: SurfaceId) => void;
  markAllRead: (workspaceId?: WorkspaceId) => void;
  resolveNotification: (dedupeKey: string) => void;
  clearNotification: (id: string) => void;
  clearAll: () => void;
  jumpToUnread: () => NotificationInfo | null;
}

// ─── Slice creator ───────────────────────────────────────────────────────────

export const createNotificationSlice: StateCreator<
  NotificationSlice & WorkspaceSlice,
  [],
  [],
  NotificationSlice
> = (set, get) => ({
  notifications: [],

  addNotification(notification: Omit<NotificationInfo, 'id' | 'timestamp' | 'read'>): void {
    const stateBefore = get();
    const existing = notification.dedupeKey
      ? stateBefore.notifications.find((item) => item.dedupeKey === notification.dedupeKey)
      : undefined;
    const newNotification: NotificationInfo = {
      ...notification,
      id: existing?.id || `notif-${uuid()}`,
      timestamp: Date.now(),
      read: false,
    };

    set((state) => {
      let updated = existing
        ? state.notifications.map((item) => item.id === existing.id ? newNotification : item)
        : [...state.notifications, newNotification];
      if (updated.length > MAX_NOTIFICATIONS) {
        const readToEvict = updated.filter((n) => n.read);
        const evictCount = updated.length - MAX_NOTIFICATIONS;
        const evictIds = new Set(readToEvict.slice(0, evictCount).map((n) => n.id));
        updated = updated.filter((n) => !evictIds.has(n.id));
      }
      return { notifications: updated };
    });

    // A repeated unread alert is replaced in place. Re-open a read alert once.
    if (existing && !existing.read) return;

    // Increment unreadCount on the workspace
    const { workspaceId } = notification;
    const state = get();
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    if (workspace) {
      state.updateWorkspaceMetadata(workspaceId, {
        unreadCount: workspace.unreadCount + 1,
      });
    }
  },

  markRead(surfaceId: SurfaceId): void {
    const state = get();
    const toMark = state.notifications.filter(
      (n) => n.surfaceId === surfaceId && !n.read,
    );

    if (toMark.length === 0) return;

    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.surfaceId === surfaceId ? { ...n, read: true } : n,
      ),
    }));

    // Decrement unreadCount per workspace
    const countsByWorkspace = new Map<WorkspaceId, number>();
    for (const n of toMark) {
      countsByWorkspace.set(
        n.workspaceId,
        (countsByWorkspace.get(n.workspaceId) ?? 0) + 1,
      );
    }

    const currentState = get();
    for (const [workspaceId, count] of countsByWorkspace) {
      const workspace = currentState.workspaces.find((w) => w.id === workspaceId);
      if (workspace) {
        currentState.updateWorkspaceMetadata(workspaceId, {
          unreadCount: Math.max(0, workspace.unreadCount - count),
        });
      }
    }
  },

  markAllRead(workspaceId?: WorkspaceId): void {
    const state = get();
    const toMark = state.notifications.filter(
      (n) => !n.read && (workspaceId === undefined || n.workspaceId === workspaceId),
    );

    if (toMark.length === 0) return;

    set((state) => ({
      notifications: state.notifications.map((n) => {
        if (!n.read && (workspaceId === undefined || n.workspaceId === workspaceId)) {
          return { ...n, read: true };
        }
        return n;
      }),
    }));

    // Reset unreadCount on affected workspaces
    const currentState = get();
    if (workspaceId) {
      currentState.updateWorkspaceMetadata(workspaceId, { unreadCount: 0 });
    } else {
      for (const workspace of currentState.workspaces) {
        if (workspace.unreadCount > 0) {
          currentState.updateWorkspaceMetadata(workspace.id, { unreadCount: 0 });
        }
      }
    }
  },

  resolveNotification(dedupeKey: string): void {
    const state = get();
    const notification = state.notifications.find((item) => (
      item.dedupeKey === dedupeKey && !item.read
    ));
    if (!notification) return;

    set((current) => ({
      notifications: current.notifications.map((item) => (
        item.id === notification.id ? { ...item, read: true } : item
      )),
    }));

    const current = get();
    const workspace = current.workspaces.find((item) => item.id === notification.workspaceId);
    if (workspace) {
      current.updateWorkspaceMetadata(notification.workspaceId, {
        unreadCount: Math.max(0, workspace.unreadCount - 1),
      });
    }
  },

  clearNotification(id: string): void {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  clearAll(): void {
    set({ notifications: [] });
    // Drop workspace unread badges so the bell and sidebar stay in sync.
    const current = get();
    for (const workspace of current.workspaces) {
      if (workspace.unreadCount > 0) {
        current.updateWorkspaceMetadata(workspace.id, { unreadCount: 0 });
      }
    }
  },

  jumpToUnread(): NotificationInfo | null {
    const state = get();
    const unread = state.notifications.filter((n) => !n.read);
    if (unread.length === 0) return null;
    return unread[unread.length - 1];
  },
});
