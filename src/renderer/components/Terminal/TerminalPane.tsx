import { useState, useCallback, useEffect, useRef } from 'react';
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
  /** Quick-launch profile startup commands (issue #32). */
  startupCommands?: string[];
  /** Text injected after an interactive startup command has initialized. */
  startupInput?: string;
  /** App-owned key for the isolated supervisor runtime directory. */
  supervisorRuntimeIsolationKey?: string;
  /** Explicit wmux-managed project/supervisor/task authorization for first-run Codex Hook trust. */
  allowManagedCodexHookTrust?: boolean;
  /** Secret-free key used for one-time SSH password injection in the main process. */
  sshProfileId?: string;
  focused?: boolean;
  visible?: boolean;
  showFindBar?: boolean;
  onFindBarClose?: () => void;
  copyModeActive?: boolean;
  /** Password/SFTP validation must finish before the remote PTY is spawned. */
  sshConnectionState?: 'connecting' | 'connected' | 'disconnected' | 'error';
}

function PendingSshTerminalPane({ state }: { state: Exclude<TerminalPaneProps['sshConnectionState'], 'connected' | undefined> }) {
  let message = 'SSH 终端已断开，请在右侧文件抽屉中重新连接。';
  if (state === 'connecting') message = '正在验证 SSH 凭据…';
  if (state === 'error') message = 'SSH 认证失败，请在密码窗口或右侧文件抽屉中重新连接。';
  return <div className="terminal-pane terminal-pane--disconnected">{message}</div>;
}

function ActiveTerminalPane({
  surfaceId,
  shell,
  cwd,
  colorScheme,
  startupCommands,
  startupInput,
  supervisorRuntimeIsolationKey,
  allowManagedCodexHookTrust = false,
  sshProfileId,
  focused = true,
  visible = true,
  showFindBar = false,
  onFindBarClose,
  copyModeActive = false,
}: TerminalPaneProps) {
  const { terminalRef, xtermRef, searchAddonRef } = useTerminal({
    surfaceId,
    shell,
    cwd,
    visible,
    focused,
    colorScheme,
    startupCommands,
    startupInput,
    supervisorRuntimeIsolationKey,
    allowManagedCodexHookTrust,
    sshProfileId,
  });

  const [_lastQuery, setLastQuery] = useState('');

  // Latest values mirrored into refs so the global F3 / Shift+F3 listener (issue
  // #64) can read them without re-subscribing on every keystroke or focus change.
  const lastQueryRef = useRef(_lastQuery);
  lastQueryRef.current = _lastQuery;
  const activeRef = useRef(false);
  activeRef.current = focused && visible;

  const focusTerminal = useCallback(() => {
    if (!activeRef.current || document.querySelector('[aria-modal="true"]')) return;
    requestAnimationFrame(() => {
      if (!activeRef.current || document.querySelector('[aria-modal="true"]')) return;
      try { xtermRef.current?.focus(); } catch { /* terminal may be disposing */ }
    });
  }, [xtermRef]);

  // Switching panes already restores focus in useTerminal, but clicking an
  // already-focused pane does not change React state. If a sidebar field or the
  // find bar owns DOM focus, xterm's hidden textarea therefore stays blurred and
  // the terminal appears read-only. Reassert focus after every pointer press in
  // the terminal viewport; controls such as the find bar are siblings and are
  // intentionally outside this handler.
  const handleTerminalPointerDown = useCallback(() => {
    focusTerminal();
  }, [focusTerminal]);

  const previousModesRef = useRef({ showFindBar, copyModeActive });
  useEffect(() => {
    const previous = previousModesRef.current;
    previousModesRef.current = { showFindBar, copyModeActive };
    if ((previous.showFindBar && !showFindBar) || (previous.copyModeActive && !copyModeActive)) {
      focusTerminal();
    }
  }, [showFindBar, copyModeActive, focusTerminal]);

  // F3 / Shift+F3 cycle search matches without reopening the find bar. Only the
  // focused, visible terminal acts (there's exactly one at a time).
  useEffect(() => {
    const cycle = (forward: boolean) => {
      if (!activeRef.current || !searchAddonRef.current || !lastQueryRef.current) return;
      if (forward) searchAddonRef.current.findNext(lastQueryRef.current);
      else searchAddonRef.current.findPrevious(lastQueryRef.current);
    };
    const onNext = () => cycle(true);
    const onPrev = () => cycle(false);
    document.addEventListener('wmux:find-next', onNext);
    document.addEventListener('wmux:find-prev', onPrev);
    return () => {
      document.removeEventListener('wmux:find-next', onNext);
      document.removeEventListener('wmux:find-prev', onPrev);
    };
  }, [searchAddonRef]);

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
    focusTerminal();
  }, [searchAddonRef, onFindBarClose, focusTerminal]);

  return (
    <div className={`terminal-pane ${focused ? 'terminal-pane--focused' : ''}`}>
      <div
        ref={terminalRef}
        className="terminal-pane__container"
        onPointerDown={handleTerminalPointerDown}
      />
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

export default function TerminalPane(props: TerminalPaneProps) {
  if (props.sshConnectionState && props.sshConnectionState !== 'connected') {
    return <PendingSshTerminalPane state={props.sshConnectionState} />;
  }
  return <ActiveTerminalPane {...props} />;
}
