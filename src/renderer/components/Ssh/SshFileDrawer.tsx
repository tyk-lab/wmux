import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SshFileEntry } from '../../../shared/types';
import { isMissingSftpPathError, parentSshPath, updateSshFileSelection } from '../../ssh-workspace';
import '../../styles/ssh.css';

interface Props {
  workspaceId: string;
  state: 'connecting' | 'connected' | 'disconnected' | 'error';
  errorMessage?: string;
  onReconnect: () => void;
}

interface PreparedSelection {
  signature: string;
  token: string;
}

const REMOTE_DRAG_TYPE = 'application/x-wmux-remote-file';

export default function SshFileDrawer({ workspaceId, state, errorMessage, onReconnect }: Props) {
  const [currentPath, setCurrentPath] = useState('.');
  const [pathDraft, setPathDraft] = useState('.');
  const [entries, setEntries] = useState<SshFileEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<number>();
  const [preparedSelection, setPreparedSelection] = useState<PreparedSelection>();
  const [error, setError] = useState('');
  const [transferStatus, setTransferStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const lastValidPathRef = useRef('.');

  const selectedFiles = useMemo(
    () => entries.filter((entry) => entry.type === 'file' && selectedPaths.has(entry.path)),
    [entries, selectedPaths],
  );
  const selectionSignature = selectedFiles.map((entry) => entry.path).sort().join('\n');

  const refresh = useCallback(async () => {
    if (state !== 'connected') return;
    setLoading(true);
    setError('');
    try {
      const result = await window.wmux?.ssh?.list?.(workspaceId, currentPath);
      setEntries(result?.entries || []);
      const resolvedPath = result?.path || currentPath;
      lastValidPathRef.current = resolvedPath;
      setCurrentPath(resolvedPath);
      setPathDraft(resolvedPath);
    } catch (reason) {
      setEntries([]);
      if (isMissingSftpPathError(reason)) {
        const fallbackPath = lastValidPathRef.current === currentPath ? '.' : lastValidPathRef.current;
        try {
          const fallback = await window.wmux?.ssh?.list?.(workspaceId, fallbackPath);
          const resolvedFallbackPath = fallback?.path || fallbackPath;
          lastValidPathRef.current = resolvedFallbackPath;
          setCurrentPath(resolvedFallbackPath);
          setPathDraft(resolvedFallbackPath);
          setEntries(fallback?.entries || []);
          setError('');
          setTransferStatus(`路径不存在，已返回 ${resolvedFallbackPath}`);
          return;
        } catch (fallbackReason) {
          setError(fallbackReason instanceof Error ? fallbackReason.message : String(fallbackReason));
          return;
        }
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, currentPath, state]);

  useEffect(() => {
    lastValidPathRef.current = '.';
    setCurrentPath('.');
    setPathDraft('.');
    setEntries([]);
    setSelectedPaths(new Set());
    setError('');
    setTransferStatus('');
  }, [workspaceId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    setPreparedSelection((current) => current?.signature === selectionSignature ? current : undefined);
  }, [selectionSignature]);

  const navigate = (nextPath: string) => {
    const normalized = nextPath.trim() || '.';
    setTransferStatus('');
    if (normalized === currentPath) {
      void refresh();
      return;
    }
    setSelectedPaths(new Set());
    setSelectionAnchor(undefined);
    setCurrentPath(normalized);
    setPathDraft(normalized);
  };

  const upload = async () => {
    setTransferStatus('');
    try {
      const result = await window.wmux?.ssh?.upload?.(workspaceId, currentPath);
      if (!result?.canceled) {
        setTransferStatus('上传完成');
        await refresh();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const uploadDroppedFiles = async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDropActive(false);
    if (event.dataTransfer.types.includes(REMOTE_DRAG_TYPE)) return;
    const droppedFiles = [...event.dataTransfer.files];
    const localPaths = droppedFiles
      .map((file) => window.wmux?.shell?.getPathForFile?.(file) || '')
      .filter(Boolean);
    if (!localPaths.length) return;
    const existingNames = new Set(entries.map((entry) => entry.name.toLowerCase()));
    const droppedNameCounts = new Map<string, number>();
    droppedFiles.forEach((file) => {
      const name = file.name.toLowerCase();
      droppedNameCounts.set(name, (droppedNameCounts.get(name) || 0) + 1);
    });
    const conflicts = [...new Set(droppedFiles
      .filter((file) => existingNames.has(file.name.toLowerCase()) || (droppedNameCounts.get(file.name.toLowerCase()) || 0) > 1)
      .map((file) => file.name))];
    if (conflicts.length && !window.confirm(`以下文件已存在，继续将覆盖远程文件：\n${conflicts.join('\n')}`)) return;
    setTransferStatus(`正在上传 ${localPaths.length} 项…`);
    setError('');
    try {
      const result = await window.wmux?.ssh?.uploadPaths?.(workspaceId, currentPath, localPaths);
      const rejected = result?.rejected || [];
      setTransferStatus(rejected.length
        ? `已上传 ${result?.uploaded || 0} 个文件；已忽略目录或无效项：${rejected.join('、')}`
        : `已上传 ${result?.uploaded || localPaths.length} 个文件`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setTransferStatus('');
    }
  };

  const downloadSelected = async () => {
    if (!selectedFiles.length) return;
    setTransferStatus(`正在下载 ${selectedFiles.length} 个文件…`);
    setError('');
    try {
      const files = selectedFiles.map((entry) => ({ path: entry.path, name: entry.name }));
      const result = files.length === 1
        ? await window.wmux?.ssh?.download?.(workspaceId, files[0].path)
        : await window.wmux?.ssh?.downloadMany?.(workspaceId, files);
      setTransferStatus(result?.canceled ? '' : `已下载 ${files.length} 个文件`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setTransferStatus('');
    }
  };

  const selectEntry = (event: React.MouseEvent, entry: SshFileEntry, index: number) => {
    const selection = updateSshFileSelection(
      entries,
      selectedPaths,
      index,
      selectionAnchor,
      event.ctrlKey,
      event.shiftKey,
    );
    setSelectedPaths(selection.selectedPaths);
    setSelectionAnchor(selection.anchorIndex);
  };

  const beginRemoteDrag = (event: React.DragEvent, entry: SshFileEntry) => {
    if (entry.type !== 'file') return;
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(REMOTE_DRAG_TYPE, '1');
    const files = selectedPaths.has(entry.path) && selectedFiles.length > 0 ? selectedFiles : [entry];
    const signature = files.map((file) => file.path).sort().join('\n');
    if (preparedSelection?.signature === signature) {
      event.preventDefault();
      window.wmux?.ssh?.startDrag?.(preparedSelection.token);
      return;
    }
    event.preventDefault();
    setSelectedPaths(new Set(files.map((file) => file.path)));
    setTransferStatus(`正在准备 ${files.length} 个文件，完成后请再次拖动…`);
    setError('');
    void window.wmux?.ssh?.prepareDrag?.(
      workspaceId,
      files.map((file) => ({ path: file.path, name: file.name })),
    ).then((result: { ok?: boolean; token?: string; error?: string } | undefined) => {
      if (!result?.ok || !result.token) throw new Error(result?.error || '准备拖出文件失败');
      setPreparedSelection({ signature, token: result.token });
      setTransferStatus(`已准备 ${files.length} 个文件，请再次拖动到资源管理器`);
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
      setTransferStatus('');
    });
  };

  const acceptsExternalFiles = (event: React.DragEvent): boolean =>
    event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes(REMOTE_DRAG_TYPE);

  return <aside
    className={`ssh-file-drawer ${dropActive ? 'ssh-file-drawer--drop-active' : ''}`}
    onDragEnter={(event) => { if (acceptsExternalFiles(event)) { event.preventDefault(); setDropActive(true); } }}
    onDragOver={(event) => { if (acceptsExternalFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }}
    onDrop={(event) => void uploadDroppedFiles(event)}
  >
    <div className="ssh-file-drawer__header"><strong>远程文件</strong><button onClick={refresh} disabled={loading || state !== 'connected'}>刷新</button></div>
    {state !== 'connected' ? <div className="ssh-file-drawer__status">
      <p>{state === 'connecting' ? '正在连接 SFTP…' : state === 'error' ? errorMessage || 'SFTP 连接失败。' : 'SSH 文件连接已断开。'}</p>
      <button className="ssh-primary-button" onClick={onReconnect}>重新连接</button>
    </div> : <>
      <form className="ssh-file-drawer__path" onSubmit={(event) => { event.preventDefault(); navigate(pathDraft); }}>
        <button type="button" onClick={() => navigate(parentSshPath(currentPath))}>↑</button>
        <input value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} aria-label="远程路径" title="输入路径后按 Enter 切换" />
        <button type="button" onClick={upload}>上传</button>
        <button type="button" onClick={() => void downloadSelected()} disabled={!selectedFiles.length}>下载</button>
      </form>
      {error && <p className="ssh-dialog__error ssh-file-drawer__message">{error}</p>}
      {transferStatus && <p className="ssh-file-drawer__message">{transferStatus}</p>}
      <div className="ssh-file-drawer__list">{entries.map((entry, index) => <button
        key={entry.path}
        className={`ssh-file-entry ${selectedPaths.has(entry.path) ? 'ssh-file-entry--selected' : ''}`}
        aria-pressed={entry.type === 'file' ? selectedPaths.has(entry.path) : undefined}
        draggable={entry.type === 'file'}
        onDragStart={(event) => beginRemoteDrag(event, entry)}
        onDoubleClick={() => entry.type === 'directory' && navigate(entry.path)}
        onClick={(event) => selectEntry(event, entry, index)}
      >
        <span>{entry.type === 'directory' ? '📁' : '📄'} {entry.name}</span><small>{entry.type === 'file' ? `${entry.size} B` : '目录'}</small>
      </button>)}</div>
      {loading && <p className="ssh-file-drawer__loading">正在读取…</p>}
      {dropActive && <div className="ssh-file-drawer__drop-overlay">释放以上传文件</div>}
    </>}
  </aside>;
}
