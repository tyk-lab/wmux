import React from 'react';
import { NotificationInfo, WorkspaceId, PaneId, SurfaceId } from '../../../shared/types';
import '../../styles/notification-panel.css';

interface NotificationPanelProps {
  notifications: NotificationInfo[];
  workspaceNames: Map<string, string>;
  onJump: (workspaceId: WorkspaceId, surfaceId: SurfaceId, paneId?: PaneId) => void;
  onMarkAllRead: () => void;
  /** Remove every notification from the list (not just mark read). */
  onClearAll: () => void;
  onClose: () => void;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

export default function NotificationPanel({
  notifications,
  workspaceNames,
  onJump,
  onMarkAllRead,
  onClearAll,
  onClose,
}: NotificationPanelProps) {
  const sorted = [...notifications].sort((a, b) => b.timestamp - a.timestamp);
  const hasAny = notifications.length > 0;
  const hasUnread = notifications.some((n) => !n.read);

  return (
    <div className="notif-panel" onClick={(e) => e.stopPropagation()}>
      <div className="notif-panel__header">
        <span className="notif-panel__title">Notifications</span>
        {hasAny && (
          <div className="notif-panel__actions">
            {hasUnread && (
              <button
                type="button"
                className="notif-panel__action"
                onClick={onMarkAllRead}
                title="Mark all as read"
              >
                Mark read
              </button>
            )}
            <button
              type="button"
              className="notif-panel__action notif-panel__action--danger"
              onClick={onClearAll}
              title="Clear all notifications"
            >
              Clear all
            </button>
          </div>
        )}
      </div>
      <div className="notif-panel__list">
        {sorted.length === 0 ? (
          <div className="notif-panel__empty">No notifications</div>
        ) : (
          sorted.map((n) => (
            <div
              key={n.id}
              className={`notif-panel__item ${!n.read ? 'notif-panel__item--unread' : ''}`}
              onClick={() => {
                onJump(n.workspaceId, n.surfaceId, n.paneId);
                onClose();
              }}
            >
              {!n.read && <span className="notif-panel__dot" />}
              {/* Three lines: session name → status (+ agent) → time */}
              <div className="notif-panel__content">
                <span className="notif-panel__source">
                  {workspaceNames.get(n.workspaceId) || 'Unknown'}
                </span>
                <span className="notif-panel__text" title={n.text}>{n.text}</span>
                <span className="notif-panel__time">{timeAgo(n.timestamp)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
