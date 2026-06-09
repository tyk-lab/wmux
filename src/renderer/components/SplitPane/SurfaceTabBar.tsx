import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SurfaceRef, SurfaceId, PaneId } from '../../../shared/types';
import { useStore } from '../../store';
import { notifyPsmuxRenameError, renamePsmuxSurfaceSession } from '../../utils/psmux-rename';

interface SurfaceTabBarProps {
  paneId: PaneId;
  workspaceShell?: string;
  surfaces: SurfaceRef[];
  activeSurfaceIndex: number;
  onSelect: (index: number) => void;
  onClose: (surfaceId: SurfaceId) => void;
  onNew: () => void;
  onNewTyped?: (type: 'terminal' | 'browser' | 'markdown') => void;
  onClosePane?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onDropSurface?: (sourcePaneId: PaneId, surfaceId: SurfaceId, targetPaneId: PaneId) => void;
  onReorderSurface?: (surfaceId: SurfaceId, newIndex: number) => void;
  isDragActive?: boolean;
  isFocused?: boolean;
}

function surfaceIcon(type: string, isAgent: boolean): string {
  if (isAgent) return '>_';
  switch (type) {
    case 'terminal': return '>';
    case 'browser': return '◎';
    case 'markdown': return '¶';
    case 'diff': return '±';
    default: return '○';
  }
}

function getShellLabel(shell?: string): string | null {
  if (!shell) return null;
  const normalized = shell.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || shell.toLowerCase();
  if (normalized === 'pwsh.exe' || normalized === 'pwsh') return 'PowerShell';
  if (normalized === 'powershell.exe' || normalized === 'powershell') return 'Windows PowerShell';
  if (normalized === 'cmd.exe' || normalized === 'cmd') return 'Command Prompt';
  if (normalized === 'bash.exe' || normalized === 'bash') return 'Bash';
  if (normalized === 'zsh' || normalized === 'zsh.exe') return 'Zsh';
  if (normalized === 'wsl.exe' || normalized === 'wsl') return 'WSL';
  if (normalized === 'git-bash.exe') return 'Git Bash';
  return normalized.replace(/\.exe$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function surfaceLabel(surface: SurfaceRef, agentLabel?: string, workspaceShell?: string): string {
  if (surface.type === 'terminal' && surface.psmuxSessionName) return surface.psmuxSessionName;
  if (surface.customTitle) return surface.customTitle;
  if (agentLabel) return agentLabel;
  switch (surface.type) {
    case 'terminal': return getShellLabel(surface.shell || workspaceShell) || 'Terminal';
    case 'browser': return 'Browser';
    case 'markdown': return 'Markdown';
    case 'diff': return 'Diff';
    default: return 'Tab';
  }
}

export default function SurfaceTabBar({
  paneId,
  workspaceShell,
  surfaces,
  activeSurfaceIndex,
  onSelect,
  onClose,
  onNew,
  onNewTyped,
  onClosePane,
  onSplitRight,
  onSplitDown,
  onDropSurface,
  onReorderSurface,
  isDragActive: _isDragActive,
  isFocused,
}: SurfaceTabBarProps) {
  const [draggingSurfaceId, setDraggingSurfaceId] = useState<SurfaceId | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<SurfaceId | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const agentMeta = useStore((state) => state.agentMeta);
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId);
  const renameSurface = useStore((state) => state.renameSurface);
  const getAgentMeta = (surfaceId: string) => agentMeta.get(surfaceId as any);

  // Start rename for the active surface
  const startRename = useCallback(() => {
    const activeSurface = surfaces[activeSurfaceIndex];
    if (!activeSurface) return;
    setRenamingId(activeSurface.id);
    setRenameValue(activeSurface.psmuxSessionName || activeSurface.customTitle || '');
  }, [surfaces, activeSurfaceIndex]);

  // Commit rename
  const commitRename = useCallback(() => {
    if (renamingId && activeWorkspaceId) {
      const surface = surfaces.find((item) => item.id === renamingId);
      if (surface?.type === 'terminal') {
        void renamePsmuxSurfaceSession(activeWorkspaceId, paneId, surface, renameValue)
          .then((result) => {
            if (!result.ok) notifyPsmuxRenameError(surface.id, result.error);
          });
      } else {
        renameSurface(activeWorkspaceId, paneId, renamingId, renameValue.trim());
      }
    }
    setRenamingId(null);
    setRenameValue('');
  }, [renamingId, activeWorkspaceId, paneId, renameValue, renameSurface, surfaces]);

  // Cancel rename
  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameValue('');
  }, []);

  // Listen for keyboard shortcut rename event (only when focused)
  useEffect(() => {
    if (!isFocused) return;
    const handler = () => startRename();
    document.addEventListener('wmux:rename-surface', handler);
    return () => document.removeEventListener('wmux:rename-surface', handler);
  }, [isFocused, startRename]);

  // Auto-focus rename input
  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  // Close the "new surface" menu on outside click or Escape
  useEffect(() => {
    if (!newMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) setNewMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNewMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [newMenuOpen]);

  const pickNew = useCallback((type: 'terminal' | 'browser' | 'markdown') => {
    setNewMenuOpen(false);
    if (onNewTyped) onNewTyped(type);
    else onNew();
  }, [onNewTyped, onNew]);

  // Always show tab bar (even for 1 surface — like browser tabs)
  return (
    <div
      className="surface-tab-bar"
      role="tablist"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        e.preventDefault();
        const savedInsertIndex = insertIndex;
        setInsertIndex(null);
        setDraggingSurfaceId(null);
        document.body.classList.remove('wmux-dragging');
        const data = e.dataTransfer.getData('application/wmux-surface');
        if (!data) return;
        try {
          const { sourcePaneId, surfaceId } = JSON.parse(data);
          if (sourcePaneId === paneId && onReorderSurface && savedInsertIndex !== null) {
            const currentIndex = surfaces.findIndex(s => s.id === surfaceId);
            const adjustedIndex = savedInsertIndex > currentIndex ? savedInsertIndex - 1 : savedInsertIndex;
            if (adjustedIndex !== currentIndex) {
              onReorderSurface(surfaceId as SurfaceId, adjustedIndex);
            }
          } else if (sourcePaneId !== paneId && onDropSurface) {
            onDropSurface(sourcePaneId as PaneId, surfaceId as SurfaceId, paneId);
          }
        } catch { /* Ignore malformed drag payloads from outside the app. */ }
      }}
      onDragLeave={() => setInsertIndex(null)}
    >
      <div className="surface-tab-bar__tabs">
        {surfaces.map((surface, index) => {
          const isActive = index === activeSurfaceIndex;
          const agentMeta = getAgentMeta(surface.id);
          const isAgent = !!agentMeta;
          const isRenaming = renamingId === surface.id;
          return (
            <div
              key={surface.id}
              className={[
                'surface-tab',
                isActive ? 'surface-tab--active' : '',
                draggingSurfaceId === surface.id ? 'surface-tab--dragging' : '',
                insertIndex === index ? 'surface-tab--insert-before' : '',
                insertIndex === index + 1 && index === surfaces.length - 1 ? 'surface-tab--insert-after' : '',
                isAgent ? 'surface-tab--agent' : '',
              ].filter(Boolean).join(' ')}
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(index)}
              onDoubleClick={() => {
                setRenamingId(surface.id);
                setRenameValue(surface.psmuxSessionName || surface.customTitle || '');
              }}
              title={surface.psmuxSessionName ? `${surfaceLabel(surface, agentMeta?.label, workspaceShell)} (${surface.psmuxSessionName})` : surfaceLabel(surface, agentMeta?.label, workspaceShell)}
              draggable={!isRenaming}
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  'application/wmux-surface',
                  JSON.stringify({ sourcePaneId: paneId, surfaceId: surface.id })
                );
                e.dataTransfer.effectAllowed = 'move';
                setDraggingSurfaceId(surface.id);
                document.body.classList.add('wmux-dragging');
              }}
              onDragEnd={() => {
                setDraggingSurfaceId(null);
                setInsertIndex(null);
                document.body.classList.remove('wmux-dragging');
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const midpoint = rect.left + rect.width / 2;
                const newInsertIndex = e.clientX < midpoint ? index : index + 1;
                setInsertIndex(newInsertIndex);
              }}
            >
              <span className="surface-tab__icon">{surfaceIcon(surface.type, isAgent)}</span>
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  className="surface-tab__rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { commitRename(); e.stopPropagation(); }
                    if (e.key === 'Escape') { cancelRename(); e.stopPropagation(); }
                    e.stopPropagation();
                  }}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  placeholder={surfaceLabel(surface, agentMeta?.label, workspaceShell)}
                />
              ) : (
                <span className="surface-tab__label">{surfaceLabel(surface, agentMeta?.label, workspaceShell)}</span>
              )}
              {surfaces.length > 1 && !isRenaming && (
                <button
                  className="surface-tab__close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(surface.id);
                  }}
                  tabIndex={-1}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        className="surface-tab-bar__new-btn"
        onClick={onNew}
        tabIndex={-1}
        title="New terminal tab (Ctrl+T)"
      >
        +
      </button>
      {onNewTyped && (
        <div className="surface-tab-bar__new-menu-wrap" ref={newMenuRef}>
          <button
            className="surface-tab-bar__new-caret"
            onClick={() => setNewMenuOpen((v) => !v)}
            tabIndex={-1}
            aria-haspopup="menu"
            aria-expanded={newMenuOpen}
            title="New tab type…"
          >
            ▾
          </button>
          {newMenuOpen && (
            <div className="surface-tab-bar__new-menu" role="menu">
              <button role="menuitem" onClick={() => pickNew('terminal')}>
                <span className="surface-tab-bar__new-menu-icon">{surfaceIcon('terminal', false)}</span> Terminal
              </button>
              <button role="menuitem" onClick={() => pickNew('browser')}>
                <span className="surface-tab-bar__new-menu-icon">{surfaceIcon('browser', false)}</span> Browser
              </button>
              <button role="menuitem" onClick={() => pickNew('markdown')}>
                <span className="surface-tab-bar__new-menu-icon">{surfaceIcon('markdown', false)}</span> Markdown
              </button>
            </div>
          )}
        </div>
      )}
      {onSplitRight && (
        <button
          className="surface-tab-bar__split-btn"
          onClick={onSplitRight}
          tabIndex={-1}
          title="Split right (Ctrl+D)"
        >
          ⏐
        </button>
      )}
      {onSplitDown && (
        <button
          className="surface-tab-bar__split-btn"
          onClick={onSplitDown}
          tabIndex={-1}
          title="Split down (Ctrl+Shift+D)"
        >
          ⎯
        </button>
      )}
      {onClosePane && (
        <button
          className="surface-tab-bar__close-pane-btn"
          onClick={onClosePane}
          tabIndex={-1}
          title="Close pane"
        >
          ×
        </button>
      )}
    </div>
  );
}
