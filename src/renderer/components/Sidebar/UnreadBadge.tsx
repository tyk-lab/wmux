import React from 'react';

interface UnreadBadgeProps {
  count: number;
  isSelected: boolean;
}

export default function UnreadBadge({ count, isSelected }: UnreadBadgeProps) {
  return (
    <span
      className="unread-badge"
      style={{
        backgroundColor: isSelected ? 'rgba(255,255,255,0.25)' : 'var(--wmux-accent)',
      }}
    >
      {count}
    </span>
  );
}
