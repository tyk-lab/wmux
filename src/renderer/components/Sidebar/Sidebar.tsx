import React, { useState, useCallback, useEffect, useRef } from 'react';
import { WorkspaceInfo, WorkspaceId, PaneId } from '../../../shared/types';
import WorkspaceRow from './WorkspaceRow';
import SidebarResizeHandle from './SidebarResizeHandle';
import WorkspaceContextMenu from './WorkspaceContextMenu';
import SessionMenu from './SessionMenu';
import OrchestrationPanel from './OrchestrationPanel';
import SupervisorPanel from './SupervisorPanel';
import ProjectManagerPanel from './ProjectManagerPanel';
import { DropEdge, edgeForPointer, reorderByDrop } from './reorder';
import ErrorBoundary from '../ErrorBoundary';
import { useStore } from '../../store';
import '../../styles/sidebar.css';
import '../../styles/trace.css';

interface ContextMenuState {
  x: number;
  y: number;
  workspaceId: WorkspaceId;
}

interface SidebarProps {
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: WorkspaceId | null;
  sidebarWidth: number;
  onWidthChange: (newWidth: number) => void;
  onSelect: (id: WorkspaceId) => void;
  onClose: (id: WorkspaceId) => void;
  onCreate: () => void;
  onCreateSsh: () => void;
  onRename: (id: WorkspaceId, title: string) => void;
  onReorder: (ids: WorkspaceId[]) => void;
  onUpdateMetadata: (id: WorkspaceId, partial: Partial<WorkspaceInfo>) => void;
  hookActivity?: Record<string, { lastTool: string; toolCount: number; lastSeen: number }>;
  agentActivity?: Record<string, any>;
  /** surfaceId → declared agent state (issue #128). */
  agentStates?: Record<string, any>;
  onSaveSession?: (name: string) => void;
  onLoadSession?: (name: string) => void;
  onCollapse?: () => void;
  onFocusAgentPane?: (wsId: WorkspaceId, paneId: PaneId) => void;
}

export default function Sidebar({
  workspaces,
  activeWorkspaceId,
  sidebarWidth,
  onWidthChange,
  onSelect,
  onClose,
  onCreate,
  onCreateSsh,
  onRename,
  onReorder,
  onUpdateMetadata,
  hookActivity,
  agentActivity,
  agentStates,
  onSaveSession,
  onLoadSession,
  onCollapse,
  onFocusAgentPane,
}: SidebarProps) {
  const [draggedId, setDraggedId] = useState<WorkspaceId | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: WorkspaceId; edge: DropEdge } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [sessionMenuMode, setSessionMenuMode] = useState<'load' | 'save' | null>(null);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const aiMenuRef = useRef<HTMLDivElement | null>(null);
  const openSupervisorSetup = useStore((s) => s.openSupervisorSetup);
  const openProjectManagerCreationDialog = useStore((s) => s.openProjectManagerCreationDialog);

  useEffect(() => {
    if (!aiMenuOpen) return undefined;
    const dismiss = (event: MouseEvent) => {
      if (!aiMenuRef.current?.contains(event.target as Node)) setAiMenuOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAiMenuOpen(false);
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [aiMenuOpen]);

  // ── Orchestration IPC subscription ──────────────────────────────────────
  // Main process pushes wmux-orchestrator state.json updates; we mirror them
  // in the Zustand store so OrchestrationPanel re-renders on each change.
  useEffect(() => {
    const setOrchestration = useStore.getState().setOrchestration;
    const clearOrchestration = useStore.getState().clearOrchestration;
    const api = (window as any).wmux?.orchestration;
    if (!api) return;
    const offUpdate = api.onUpdate?.((state: any) => {
      if (state) setOrchestration(state);
    });
    const offClear = api.onClear?.(() => {
      clearOrchestration();
    });
    return () => {
      offUpdate?.();
      offClear?.();
    };
  }, []);

  // ── Resize ───────────────────────────────────────────────────────────────
  const handleResizeDelta = useCallback(
    (delta: number) => {
      const proposed = sidebarWidth + delta;
      // Dragging below 80px auto-collapses
      if (proposed < 80) {
        onCollapse?.();
        return;
      }
      const newWidth = Math.min(600, Math.max(140, proposed));
      onWidthChange(newWidth);
    },
    [sidebarWidth, onWidthChange, onCollapse],
  );

  // ── Drag-and-drop ────────────────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.DragEvent, id: WorkspaceId) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  // The marker follows the pointer's half of the row, not the drag direction —
  // see ./reorder.ts for why the direction-derived version was wrong downwards
  // (issue #124).
  const handleDragOver = useCallback((e: React.DragEvent, id: WorkspaceId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (id === draggedId) {
      setDropTarget(null);
      return;
    }
    const edge = edgeForPointer(e.clientY, e.currentTarget.getBoundingClientRect());
    setDropTarget((prev) => (prev?.id === id && prev.edge === edge ? prev : { id, edge }));
  }, [draggedId]);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: WorkspaceId) => {
      e.preventDefault();
      const edge = dropTarget?.id === targetId
        ? dropTarget.edge
        : edgeForPointer(e.clientY, e.currentTarget.getBoundingClientRect());

      if (draggedId) {
        const reordered = reorderByDrop(workspaces.map((w) => w.id), draggedId, targetId, edge);
        if (reordered) onReorder(reordered);
      }

      setDraggedId(null);
      setDropTarget(null);
    },
    [draggedId, dropTarget, workspaces, onReorder],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
    setDropTarget(null);
  }, []);

  // Leaving the list entirely retires the marker; without this it lingers on
  // the last row hovered while the pointer is somewhere else.
  const handleListDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
  }, []);

  // ── Context menu ─────────────────────────────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent, id: WorkspaceId) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, workspaceId: id });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // ── Pin/unpin from context menu ──────────────────────────────────────────
  const handlePin = useCallback(
    (id: WorkspaceId) => {
      const ws = workspaces.find((w) => w.id === id);
      if (ws) onUpdateMetadata(id, { pinned: !ws.pinned });
    },
    [workspaces, onUpdateMetadata],
  );

  // ── Color from context menu ──────────────────────────────────────────────
  const handleSetColor = useCallback(
    (id: WorkspaceId, color: string | null) => {
      onUpdateMetadata(id, { customColor: color ?? undefined });
    },
    [onUpdateMetadata],
  );

  // ── Status override from context menu (issue #81) ───────────────────────
  const handleSetStatusOverride = useCallback(
    (id: WorkspaceId, override: 'running' | 'idle' | null) => {
      onUpdateMetadata(id, { statusOverride: override ?? undefined });
    },
    [onUpdateMetadata],
  );

  // ── Move helpers ─────────────────────────────────────────────────────────
  const handleMoveUp = useCallback(
    (id: WorkspaceId) => {
      const ids = workspaces.map((w) => w.id);
      const idx = ids.indexOf(id);
      if (idx <= 0) return;
      const reordered = [...ids];
      [reordered[idx - 1], reordered[idx]] = [reordered[idx], reordered[idx - 1]];
      onReorder(reordered);
    },
    [workspaces, onReorder],
  );

  const handleMoveDown = useCallback(
    (id: WorkspaceId) => {
      const ids = workspaces.map((w) => w.id);
      const idx = ids.indexOf(id);
      if (idx === -1 || idx >= ids.length - 1) return;
      const reordered = [...ids];
      [reordered[idx], reordered[idx + 1]] = [reordered[idx + 1], reordered[idx]];
      onReorder(reordered);
    },
    [workspaces, onReorder],
  );

  const handleMoveToTop = useCallback(
    (id: WorkspaceId) => {
      const ids = workspaces.map((w) => w.id);
      const idx = ids.indexOf(id);
      if (idx <= 0) return;
      const reordered = [id, ...ids.filter((i) => i !== id)];
      onReorder(reordered);
    },
    [workspaces, onReorder],
  );

  // ── Mark as read/unread ──────────────────────────────────────────────────
  const handleMarkRead = useCallback(
    (id: WorkspaceId) => {
      onUpdateMetadata(id, { unreadCount: 0 });
    },
    [onUpdateMetadata],
  );

  const handleMarkUnread = useCallback(
    (id: WorkspaceId) => {
      const ws = workspaces.find((w) => w.id === id);
      if (ws && ws.unreadCount === 0) {
        onUpdateMetadata(id, { unreadCount: 1 });
      }
    },
    [workspaces, onUpdateMetadata],
  );

  // ── Close other workspaces ───────────────────────────────────────────────
  const handleCloseOthers = useCallback(
    (id: WorkspaceId) => {
      workspaces
        .filter((w) => w.id !== id)
        .forEach((w) => onClose(w.id));
    },
    [workspaces, onClose],
  );

  return (
    <div className="sidebar" style={{ width: sidebarWidth }}>
      {/* Spacer for titlebar area + collapse button */}
      <div className="sidebar__header">
        {onCollapse && (
          <button
            className="sidebar__collapse-btn"
            onClick={onCollapse}
            title="Collapse sidebar (Ctrl+B)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06z"/>
            </svg>
          </button>
        )}
      </div>

      <ErrorBoundary label="orchestration" silent>
        <OrchestrationPanel />
      </ErrorBoundary>

      <ErrorBoundary label="project-manager" silent>
        <ProjectManagerPanel />
      </ErrorBoundary>

      <ErrorBoundary label="supervisor" silent>
        <SupervisorPanel agentStates={agentStates} />
      </ErrorBoundary>

      <div className="sidebar__list" onDragLeave={handleListDragLeave}>
        {workspaces.map((ws) => (
          <WorkspaceRow
            key={ws.id}
            workspace={ws}
            isActive={ws.id === activeWorkspaceId}
            onSelect={() => onSelect(ws.id)}
            onClose={() => onClose(ws.id)}
            onRename={(newTitle) => onRename(ws.id, newTitle)}
            onContextMenu={(e) => handleContextMenu(e, ws.id)}
            draggable
            onDragStart={(e) => handleDragStart(e, ws.id)}
            onDragOver={(e) => handleDragOver(e, ws.id)}
            onDrop={(e) => handleDrop(e, ws.id)}
            onDragEnd={handleDragEnd}
            dropEdge={dropTarget?.id === ws.id ? dropTarget.edge : null}
            hookActivity={hookActivity}
            agentActivity={agentActivity}
            agentStates={agentStates}
            onFocusAgentPane={(paneId) => onFocusAgentPane?.(ws.id, paneId)}
          />
        ))}
      </div>

      <div ref={aiMenuRef} className="sidebar__footer">
        {aiMenuOpen && (
          <div className="sidebar__ai-menu" role="menu" aria-label="新建 AI 工作模式">
            <button type="button" role="menuitem" onClick={() => {
              setAiMenuOpen(false);
              openProjectManagerCreationDialog();
            }}>
              <strong>添加项目</strong>
              <span>创建独立项目 AI 与执行链</span>
            </button>
            <button type="button" role="menuitem" onClick={() => {
              setAiMenuOpen(false);
              openSupervisorSetup();
            }}>
              <strong>普通 AI 监督</strong>
              <span>监督当前已打开的任务终端</span>
            </button>
          </div>
        )}
        <button
          className="sidebar__footer-btn"
          onClick={() => setAiMenuOpen((current) => !current)}
          title="添加项目或普通 AI 监督"
          aria-haspopup="menu"
          aria-expanded={aiMenuOpen}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 1a3 3 0 0 0-3 3v1H4a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1V4a3 3 0 0 0-3-3zm2 4V4a2 2 0 1 0-4 0v1h4zM5.5 9a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zm5 0a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5z"/>
          </svg>
        </button>
        <button
          className="sidebar__footer-btn"
          onClick={() => setSessionMenuMode(sessionMenuMode === 'save' ? null : 'save')}
          title="Save session"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4.414A1 1 0 0 0 14.707 4L12 1.293A1 1 0 0 0 11.586 1H2zm0 1h1v3.5a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V2h.586L14 4.414V14H2V2zm3 0v3h5V2H5zm3 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>
        </button>
        <button
          className="sidebar__footer-btn"
          onClick={() => setSessionMenuMode(sessionMenuMode === 'load' ? null : 'load')}
          title="Load session"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9zM2.5 3a.5.5 0 0 0-.5.5V6h12v-.5a.5.5 0 0 0-.5-.5H9c-.964 0-1.71-.572-2.331-1.184C6.268 3.394 5.762 3 5.264 3H2.5zM14 7H2v5.5a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5V7z"/></svg>
        </button>
        <button className="sidebar__new-btn" onClick={onCreate} title="New workspace">
          +
        </button>
        <button className="sidebar__new-btn sidebar__new-btn--ssh" onClick={onCreateSsh} title="添加 SSH 工作区">
          添加 SSH
        </button>
        {sessionMenuMode && (
          <SessionMenu
            mode={sessionMenuMode}
            onSelect={(name) => {
              if (sessionMenuMode === 'save') onSaveSession?.(name);
              else onLoadSession?.(name);
              setSessionMenuMode(null);
            }}
            onClose={() => setSessionMenuMode(null)}
          />
        )}
      </div>

      <SidebarResizeHandle onWidthChange={handleResizeDelta} />

      {contextMenu && (
        <WorkspaceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          workspaceId={contextMenu.workspaceId}
          workspace={workspaces.find((w) => w.id === contextMenu.workspaceId)!}
          onClose={closeContextMenu}
          onPin={handlePin}
          onRename={onRename}
          onSetColor={handleSetColor}
          onSetStatusOverride={handleSetStatusOverride}
          onMoveUp={handleMoveUp}
          onMoveDown={handleMoveDown}
          onMoveToTop={handleMoveToTop}
          onCloseWorkspace={(id) => { onClose(id); closeContextMenu(); }}
          onCloseOthers={(id) => { handleCloseOthers(id); closeContextMenu(); }}
          onMarkRead={handleMarkRead}
          onMarkUnread={handleMarkUnread}
        />
      )}
    </div>
  );
}
