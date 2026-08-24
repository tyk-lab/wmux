import React from 'react';
import { NotificationInfo } from '../../../shared/types';
import '../../styles/notification-panel.css';

interface NotificationPanelProps {
  notifications: NotificationInfo[];
  workspaceNames: Map<string, string>;
  onJump: (notification: NotificationInfo) => void;
  onMarkAllRead: () => void;
  /** Remove every notification from the list (not just mark read). */
  onClearAll: () => void;
  onClose: () => void;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

function ownerLabel(notification: NotificationInfo): string {
  if (notification.owner === 'project') return '项目';
  if (notification.owner === 'supervisor') return '监督';
  return 'Agent';
}

function actionLabel(notification: NotificationInfo): string {
  if (notification.action === 'open-project-manager') return '打开项目管理';
  if (notification.action === 'open-supervisor') return '打开监督';
  return '打开终端';
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
        <span className="notif-panel__title">通知</span>
        {hasAny && (
          <div className="notif-panel__actions">
            {hasUnread && (
              <button
                type="button"
                className="notif-panel__action"
                onClick={onMarkAllRead}
                title="全部标记为已读"
              >
                全部已读
              </button>
            )}
            <button
              type="button"
              className="notif-panel__action notif-panel__action--danger"
              onClick={onClearAll}
              title="清空全部通知"
            >
              清空
            </button>
          </div>
        )}
      </div>
      <div className="notif-panel__list">
        {sorted.length === 0 ? (
          <div className="notif-panel__empty">暂无通知</div>
        ) : (
          sorted.map((n) => (
            <div
              key={n.id}
              className={`notif-panel__item notif-panel__item--${n.severity || 'info'} ${!n.read ? 'notif-panel__item--unread' : ''}`}
              onClick={() => {
                onJump(n);
                onClose();
              }}
            >
              {!n.read && <span className="notif-panel__dot" />}
              <div className="notif-panel__content">
                <span className="notif-panel__source">
                  <span className={`notif-panel__owner notif-panel__owner--${n.owner || 'agent'}`}>
                    {ownerLabel(n)}
                  </span>
                  {n.sourceLabel || workspaceNames.get(n.workspaceId) || '未知工作区'}
                </span>
                {n.title && <span className="notif-panel__item-title">{n.title}</span>}
                <span className="notif-panel__text" title={n.text}>{n.text}</span>
                <span className="notif-panel__meta">
                  <span>{timeAgo(n.timestamp)}</span>
                  <span className="notif-panel__action-label">{actionLabel(n)}</span>
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
