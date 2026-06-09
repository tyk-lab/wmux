import { useState, useCallback } from 'react';
import { useTerminal } from '../../hooks/useTerminal';
import FindBar from './FindBar';
import CopyMode from './CopyMode';
import '../../styles/terminal.css';

interface TerminalPaneProps {
  surfaceId?: string;
  shell?: string;
  cwd?: string;
  /** Per-surface color scheme override (issue #4). */
  colorScheme?: string;
  startupCommand?: string;
  psmuxSessionName?: string;
  psmuxAttachExisting?: boolean;
  focused?: boolean;
  visible?: boolean;
  showFindBar?: boolean;
  onFindBarClose?: () => void;
  copyModeActive?: boolean;
  onCopyModeActiveChange?: (active: boolean) => void;
}

export default function TerminalPane({
  surfaceId,
  shell,
  cwd,
  colorScheme,
  startupCommand,
  psmuxSessionName,
  psmuxAttachExisting,
  focused = true,
  visible = true,
  showFindBar = false,
  onFindBarClose,
  copyModeActive = false,
  onCopyModeActiveChange,
}: TerminalPaneProps) {
  const { terminalRef, searchAddonRef } = useTerminal({
    surfaceId,
    shell,
    cwd,
    visible,
    focused,
    colorScheme,
    startupCommand,
    psmuxSessionName,
    psmuxAttachExisting,
    copyModeActive,
    onCopyModeActiveChange,
  });

  const [_lastQuery, setLastQuery] = useState('');

  const handleSearch = useCallback((query: string) => {
    setLastQuery(query);
    if (!searchAddonRef.current) return;
    if (!query) {
      // Clear highlights when query is empty
      searchAddonRef.current.clearDecorations();
      return;
    }
    searchAddonRef.current.findNext(query, { incremental: true });
  }, [searchAddonRef]);

  const handleNext = useCallback(() => {
    if (!searchAddonRef.current || !_lastQuery) return;
    searchAddonRef.current.findNext(_lastQuery);
  }, [searchAddonRef, _lastQuery]);

  const handlePrevious = useCallback(() => {
    if (!searchAddonRef.current || !_lastQuery) return;
    searchAddonRef.current.findPrevious(_lastQuery);
  }, [searchAddonRef, _lastQuery]);

  const handleFindBarClose = useCallback(() => {
    if (searchAddonRef.current) {
      searchAddonRef.current.clearDecorations();
    }
    onFindBarClose?.();
  }, [searchAddonRef, onFindBarClose]);

  return (
    <div className={`terminal-pane ${focused ? 'terminal-pane--focused' : ''}`}>
      <div ref={terminalRef} className="terminal-pane__container" />
      {showFindBar && (
        <FindBar
          onSearch={handleSearch}
          onNext={handleNext}
          onPrevious={handlePrevious}
          onClose={handleFindBarClose}
        />
      )}
      <CopyMode active={copyModeActive} />
    </div>
  );
}
