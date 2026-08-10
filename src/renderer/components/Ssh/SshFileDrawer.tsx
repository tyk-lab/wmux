import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SshFileEntry } from '../../../shared/types';
import { isMissingSftpPathError, parentSshPath, updateSshFileSelection } from '../../ssh-workspace';
import '../../styles/ssh.css';

interface Props {
  workspaceId: string;
  state: 'connecting' | 'connected' | 'disconnected' | 'error';
  errorMessage?: string;
  onReconnect: () => void;
  onOpenFile: (entry: SshFileEntry) => Promise<void>;
}

interface PreparedSelection {
  signature: string;
  token: string;
}

interface DirectoryResult {
  path: string;
  entries: SshFileEntry[];
}

interface EntryContextMenu {
  entry?: SshFileEntry;
  x: number;
  y: number;
}

interface NameDialogState {
  action: 'create-file' | 'create-directory' | 'rename';
  entry?: SshFileEntry;
  value: string;
}

const REMOTE_DRAG_TYPE = 'application/x-wmux-remote-file';
const DIRECTORY_CACHE_TTL = 10_000;
const MAX_CACHED_DIRECTORIES = 100;
const SSH_DRAWER_WIDTH_KEY = 'wmux:ssh-file-drawer-width';
const MIN_DRAWER_WIDTH = 320;
const MAX_DRAWER_WIDTH = 800;

function initialDrawerWidth(): number {
  const maximum = Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, window.innerWidth - 320));
  const saved = Number(window.localStorage.getItem(SSH_DRAWER_WIDTH_KEY));
  if (Number.isFinite(saved) && saved >= MIN_DRAWER_WIDTH) return Math.min(maximum, saved);
  return Math.min(maximum, Math.max(380, window.innerWidth * 0.46));
}

function formatFileSize(entry: SshFileEntry): string {
  if (entry.type !== 'file') return '';
  if (entry.size < 1024) return `${entry.size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = entry.size / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function formatModifiedAt(modifiedAt?: number): string {
  if (!modifiedAt) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(modifiedAt);
}

export default function SshFileDrawer({ workspaceId, state, errorMessage, onReconnect, onOpenFile }: Props) {
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
  const [contextMenu, setContextMenu] = useState<EntryContextMenu>();
  const [nameDialog, setNameDialog] = useState<NameDialogState>();
  const [nameDialogError, setNameDialogError] = useState('');
  const [drawerWidth, setDrawerWidth] = useState(initialDrawerWidth);
  const [resizing, setResizing] = useState(false);
  const [openingPath, setOpeningPath] = useState<string>();
  const lastValidPathRef = useRef('.');
  const directoryCacheRef = useRef(new Map<string, { result: DirectoryResult; cachedAt: number }>());
  const pendingDirectoriesRef = useRef(new Map<string, Promise<DirectoryResult>>());
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeWorkspaceIdRef = useRef(workspaceId);
  const dragPreparationGenerationRef = useRef(0);
  const resizeCleanupRef = useRef<(() => void) | undefined>(undefined);
  activeWorkspaceIdRef.current = workspaceId;

  const selectedTransferEntries = useMemo(
    () => entries.filter((entry) =>
      (entry.type === 'file' || entry.type === 'directory') && selectedPaths.has(entry.path)),
    [entries, selectedPaths],
  );
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedPaths.has(entry.path)),
    [entries, selectedPaths],
  );
  const canDownloadSelection = selectedEntries.length > 0
    && selectedEntries.every((entry) => entry.type === 'file' || entry.type === 'directory');
  const selectionSignature = selectedTransferEntries.map((entry) => entry.path).sort().join('\n');
  const selectionSignatureRef = useRef(selectionSignature);
  selectionSignatureRef.current = selectionSignature;

  const requestDirectory = useCallback((remotePath: string, force = false): Promise<DirectoryResult> => {
    const cached = directoryCacheRef.current.get(remotePath);
    if (!force && cached && Date.now() - cached.cachedAt < DIRECTORY_CACHE_TTL) {
      return Promise.resolve(cached.result);
    }
    const pending = pendingDirectoriesRef.current.get(remotePath);
    if (pending) return pending;
    const request = window.wmux?.ssh?.list?.(workspaceId, remotePath);
    if (!request) return Promise.reject(new Error('SSH 文件接口不可用'));
    let tracked: Promise<DirectoryResult>;
    tracked = Promise.resolve(request).then((value: DirectoryResult | undefined) => {
      const result = { path: value?.path || remotePath, entries: value?.entries || [] };
      if (activeWorkspaceIdRef.current !== workspaceId) return result;
      const cache = directoryCacheRef.current;
      if (cache.size >= MAX_CACHED_DIRECTORIES) cache.delete(cache.keys().next().value as string);
      const cacheEntry = { result, cachedAt: Date.now() };
      cache.set(remotePath, cacheEntry);
      cache.set(result.path, cacheEntry);
      return result;
    }).finally(() => {
      if (pendingDirectoriesRef.current.get(remotePath) === tracked) {
        pendingDirectoriesRef.current.delete(remotePath);
      }
    });
    pendingDirectoriesRef.current.set(remotePath, tracked);
    return tracked;
  }, [workspaceId]);

  const refresh = useCallback(async (force = false) => {
    if (state !== 'connected') return;
    const requestedWorkspaceId = workspaceId;
    setLoading(!directoryCacheRef.current.has(currentPath) || force);
    setError('');
    try {
      const result = await requestDirectory(currentPath, force);
      if (activeWorkspaceIdRef.current !== requestedWorkspaceId) return;
      setEntries(result.entries);
      const resolvedPath = result.path;
      lastValidPathRef.current = resolvedPath;
      setCurrentPath(resolvedPath);
      setPathDraft(resolvedPath);
    } catch (reason) {
      if (activeWorkspaceIdRef.current !== requestedWorkspaceId) return;
      setEntries([]);
      if (isMissingSftpPathError(reason)) {
        const fallbackPath = lastValidPathRef.current === currentPath ? '.' : lastValidPathRef.current;
        try {
          const fallback = await requestDirectory(fallbackPath);
          if (activeWorkspaceIdRef.current !== requestedWorkspaceId) return;
          const resolvedFallbackPath = fallback.path;
          lastValidPathRef.current = resolvedFallbackPath;
          setCurrentPath(resolvedFallbackPath);
          setPathDraft(resolvedFallbackPath);
          setEntries(fallback.entries);
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
      if (activeWorkspaceIdRef.current === requestedWorkspaceId) setLoading(false);
    }
  }, [currentPath, requestDirectory, state, workspaceId]);

  useEffect(() => {
    dragPreparationGenerationRef.current += 1;
    lastValidPathRef.current = '.';
    setCurrentPath('.');
    setPathDraft('.');
    setEntries([]);
    setSelectedPaths(new Set());
    setError('');
    setTransferStatus('');
    setContextMenu(undefined);
    setNameDialog(undefined);
    setNameDialogError('');
    directoryCacheRef.current.clear();
    pendingDirectoriesRef.current.clear();
  }, [workspaceId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    setPreparedSelection((current) => current?.signature === selectionSignature ? current : undefined);
  }, [selectionSignature]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [contextMenu]);
  useEffect(() => () => {
    if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
    resizeCleanupRef.current?.();
  }, []);

  const beginResize = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = drawerWidth;
    let latestWidth = drawerWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setResizing(true);
    const move = (pointerEvent: PointerEvent) => {
      const availableWidth = Math.max(MIN_DRAWER_WIDTH, window.innerWidth - 320);
      const maxWidth = Math.min(MAX_DRAWER_WIDTH, availableWidth);
      latestWidth = Math.max(MIN_DRAWER_WIDTH, Math.min(maxWidth, startWidth + startX - pointerEvent.clientX));
      setDrawerWidth(latestWidth);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.localStorage.setItem(SSH_DRAWER_WIDTH_KEY, String(Math.round(latestWidth)));
      setResizing(false);
      resizeCleanupRef.current = undefined;
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  const navigate = (nextPath: string) => {
    const normalized = nextPath.trim() || '.';
    setTransferStatus('');
    if (normalized === currentPath) {
      void refresh();
      return;
    }
    setSelectedPaths(new Set());
    setSelectionAnchor(undefined);
    const cached = directoryCacheRef.current.get(normalized);
    if (cached && Date.now() - cached.cachedAt < DIRECTORY_CACHE_TTL) {
      setEntries(cached.result.entries);
      setCurrentPath(cached.result.path);
      setPathDraft(cached.result.path);
    } else {
      setCurrentPath(normalized);
      setPathDraft(normalized);
    }
  };

  const invalidateCurrentDirectory = () => {
    directoryCacheRef.current.delete(currentPath);
    directoryCacheRef.current.delete(lastValidPathRef.current);
  };

  const upload = async () => {
    setTransferStatus('');
    setError('');
    try {
      const uploadFiles = window.wmux?.ssh?.upload;
      if (!uploadFiles) throw new Error('SSH 文件接口未更新，请重启应用后重试');
      const result = await uploadFiles(workspaceId, currentPath);
      if (!result?.canceled) {
        setTransferStatus('上传完成');
        invalidateCurrentDirectory();
        await refresh(true);
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
    setTransferStatus(`正在上传 ${localPaths.length} 项…`);
    setError('');
    try {
      const uploadPaths = window.wmux?.ssh?.uploadPaths;
      if (!uploadPaths) throw new Error('SSH 文件接口未更新，请重启应用后重试');
      const result = await uploadPaths(workspaceId, currentPath, localPaths);
      if (result?.canceled) {
        setTransferStatus('');
        return;
      }
      const rejected = result?.rejected || [];
      setTransferStatus(rejected.length
        ? `已上传 ${result?.uploaded || 0} 项；已忽略不支持或无效项：${rejected.join('、')}`
        : `已上传 ${result?.uploaded || localPaths.length} 项`);
      invalidateCurrentDirectory();
      await refresh(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setTransferStatus('');
    }
  };

  const downloadSelected = async () => {
    if (!selectedTransferEntries.length) return;
    const downloadsAsArchive = selectedTransferEntries.length > 1
      || selectedTransferEntries[0]?.type === 'directory';
    setTransferStatus(downloadsAsArchive
      ? `正在压缩并下载 ${selectedTransferEntries.length} 项…`
      : '正在下载文件…');
    setError('');
    try {
      const files = selectedTransferEntries.map((entry) => ({ path: entry.path, name: entry.name, type: entry.type }));
      let result;
      if (files.length === 1 && files[0].type === 'file') {
        const download = window.wmux?.ssh?.download;
        if (!download) throw new Error('SSH 文件接口未更新，请重启应用后重试');
        result = await download(workspaceId, files[0].path);
      } else {
        const downloadMany = window.wmux?.ssh?.downloadMany;
        if (!downloadMany) throw new Error('SSH 文件接口未更新，请重启应用后重试');
        result = await downloadMany(workspaceId, files);
      }
      setTransferStatus(result?.canceled ? '' : downloadsAsArchive ? '压缩包下载完成' : '文件下载完成');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setTransferStatus('');
    }
  };

  const openFile = async (entry: SshFileEntry) => {
    if (entry.type !== 'file' || openingPath) return;
    setOpeningPath(entry.path);
    setTransferStatus(`正在打开 ${entry.name}…`);
    setError('');
    try {
      await onOpenFile(entry);
      setTransferStatus('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setTransferStatus('');
    } finally {
      setOpeningPath(undefined);
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

  const openEntryContextMenu = (event: React.MouseEvent, entry: SshFileEntry, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    if ((entry.type === 'file' || entry.type === 'directory') && !selectedPaths.has(entry.path)) {
      setSelectedPaths(new Set([entry.path]));
      setSelectionAnchor(index);
    } else if (entry.type !== 'file' && entry.type !== 'directory') {
      setSelectedPaths(new Set());
      setSelectionAnchor(undefined);
    }
    setContextMenu({
      entry,
      x: Math.max(4, Math.min(event.clientX, window.innerWidth - 150)),
      y: Math.max(4, Math.min(event.clientY, window.innerHeight - 180)),
    });
  };

  const openCreateContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({
      x: Math.max(4, Math.min(event.clientX, window.innerWidth - 150)),
      y: Math.max(4, Math.min(event.clientY, window.innerHeight - 110)),
    });
  };

  const createEntry = async (type: 'file' | 'directory', name: string) => {
    const typeLabel = type === 'file' ? '文件' : '目录';
    setError('');
    setTransferStatus(`正在新建${typeLabel}…`);
    try {
      const create = window.wmux?.ssh?.create;
      if (!create) throw new Error('SSH 文件接口未更新，请重启应用后重试');
      const result = await create(workspaceId, currentPath, name, type);
      invalidateCurrentDirectory();
      setTransferStatus(`${typeLabel}已创建`);
      await refresh(true);
      if (type === 'file' && result?.path) setSelectedPaths(new Set([result.path]));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setTransferStatus('');
    }
  };

  const renameEntry = async (entry: SshFileEntry, newName: string) => {
    setError('');
    setTransferStatus(`正在重命名 ${entry.name}…`);
    try {
      const rename = window.wmux?.ssh?.rename;
      if (!rename) throw new Error('SSH 文件接口未更新，请重启应用后重试');
      await rename(workspaceId, entry.path, newName);
      setSelectedPaths(new Set());
      directoryCacheRef.current.delete(entry.path);
      invalidateCurrentDirectory();
      setTransferStatus('重命名完成');
      await refresh(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setTransferStatus('');
    }
  };

  const openNameDialog = (action: NameDialogState['action'], entry?: SshFileEntry) => {
    setContextMenu(undefined);
    setNameDialogError('');
    setNameDialog({
      action,
      entry,
      value: action === 'rename' ? entry?.name || '' : action === 'create-file' ? '新建文件' : '新建目录',
    });
  };

  const submitNameDialog = () => {
    if (!nameDialog) return;
    const name = nameDialog.value.trim();
    if (!name || name === '.' || name === '..' || name.includes('/')) {
      setNameDialogError('请输入有效名称，名称不能包含 /');
      return;
    }
    if (entries.some((item) => item.path !== nameDialog.entry?.path && item.name === name)) {
      setNameDialogError(`“${name}”已存在`);
      return;
    }
    if (nameDialog.action === 'rename' && nameDialog.entry?.name === name) {
      setNameDialog(undefined);
      return;
    }
    const dialog = nameDialog;
    setNameDialog(undefined);
    if (dialog.action === 'rename' && dialog.entry) void renameEntry(dialog.entry, name);
    else void createEntry(dialog.action === 'create-file' ? 'file' : 'directory', name);
  };

  const deleteEntry = async (entry: SshFileEntry) => {
    setError('');
    setTransferStatus('');
    try {
      const result = await window.wmux?.ssh?.delete?.(workspaceId, entry.path);
      if (result?.canceled) return;
      setTransferStatus('正在更新目录…');
      setSelectedPaths((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      directoryCacheRef.current.delete(entry.path);
      invalidateCurrentDirectory();
      setTransferStatus('删除完成');
      await refresh(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setTransferStatus('');
    }
  };

  const scheduleDirectoryPrefetch = (entry: SshFileEntry) => {
    if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
    if (entry.type !== 'directory') return;
    prefetchTimerRef.current = setTimeout(() => {
      void requestDirectory(entry.path).catch(() => undefined);
    }, 120);
  };

  const beginRemoteDrag = (event: React.DragEvent, entry: SshFileEntry) => {
    if (entry.type !== 'file' && entry.type !== 'directory') return;
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(REMOTE_DRAG_TYPE, '1');
    const files = selectedPaths.has(entry.path) && selectedTransferEntries.length > 0
      ? selectedTransferEntries
      : [entry];
    const signature = files.map((file) => file.path).sort().join('\n');
    if (preparedSelection?.signature === signature) {
      event.preventDefault();
      const startDrag = window.wmux?.ssh?.startDrag;
      if (!startDrag) {
        setError('SSH 文件接口未更新，请重启应用后重试');
        setTransferStatus('');
        return;
      }
      startDrag(preparedSelection.token);
      return;
    }
    event.preventDefault();
    setSelectedPaths(new Set(files.map((file) => file.path)));
    setTransferStatus(`正在准备 ${files.length} 项，完成后请再次拖动…`);
    setError('');
    const prepareDrag = window.wmux?.ssh?.prepareDrag;
    if (!prepareDrag) {
      setError('SSH 文件接口未更新，请重启应用后重试');
      setTransferStatus('');
      return;
    }
    const generation = ++dragPreparationGenerationRef.current;
    void prepareDrag(
      workspaceId,
      files.map((file) => ({ path: file.path, name: file.name, type: file.type })),
    ).then((result: { ok?: boolean; token?: string; error?: string } | undefined) => {
      if (!result?.ok || !result.token) throw new Error(result?.error || '准备拖出文件失败');
      if (
        dragPreparationGenerationRef.current !== generation
        || activeWorkspaceIdRef.current !== workspaceId
        || selectionSignatureRef.current !== signature
      ) return;
      setPreparedSelection({ signature, token: result.token });
      setTransferStatus(`已准备 ${files.length} 项，请再次拖动到资源管理器`);
    }).catch((reason: unknown) => {
      if (
        dragPreparationGenerationRef.current !== generation
        || activeWorkspaceIdRef.current !== workspaceId
        || selectionSignatureRef.current !== signature
      ) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setTransferStatus('');
    });
  };

  const acceptsExternalFiles = (event: React.DragEvent): boolean =>
    event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes(REMOTE_DRAG_TYPE);

  return <aside
    className={`ssh-file-drawer ${dropActive ? 'ssh-file-drawer--drop-active' : ''} ${resizing ? 'ssh-file-drawer--resizing' : ''}`}
    style={{ width: drawerWidth, flexBasis: drawerWidth }}
    onDragEnter={(event) => { if (acceptsExternalFiles(event)) { event.preventDefault(); setDropActive(true); } }}
    onDragOver={(event) => { if (acceptsExternalFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }}
    onDrop={(event) => void uploadDroppedFiles(event)}
  >
    <div className="ssh-file-drawer__resize-handle" onPointerDown={beginResize} title="拖动调整远程文件面板宽度" />
    <div className="ssh-file-drawer__header"><strong>远程文件</strong><button onClick={() => void refresh(true)} disabled={loading || state !== 'connected'}>刷新</button></div>
    {state !== 'connected' ? <div className="ssh-file-drawer__status">
      <p>{state === 'connecting' ? '正在连接 SFTP…' : state === 'error' ? errorMessage || 'SFTP 连接失败。' : 'SSH 文件连接已断开。'}</p>
      <button className="ssh-primary-button" onClick={onReconnect}>重新连接</button>
    </div> : <>
      <form className="ssh-file-drawer__path" onSubmit={(event) => { event.preventDefault(); navigate(pathDraft); }}>
        <button type="button" onClick={() => navigate(parentSshPath(currentPath))}>↑</button>
        <input value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} aria-label="远程路径" title="输入路径后按 Enter 切换" />
        <button type="button" onClick={upload}>上传</button>
        <button type="button" onClick={() => void downloadSelected()} disabled={!canDownloadSelection}>下载</button>
      </form>
      {error && <p className="ssh-dialog__error ssh-file-drawer__message">{error}</p>}
      {transferStatus && <p className="ssh-file-drawer__message">{transferStatus}</p>}
      <div className="ssh-file-drawer__list" onContextMenu={openCreateContextMenu}>
        <div className="ssh-file-table-header" role="row">
          <span>名称</span><span>大小</span><span>修改时间</span><span>所有者</span><span>组</span><span>权限</span>
        </div>
        {currentPath !== '/' && <button
          className="ssh-file-entry ssh-file-entry--parent"
          onDoubleClick={() => navigate(parentSshPath(currentPath))}
          title="双击返回上一级"
        >
          <span className="ssh-file-cell ssh-file-cell--name">📁 ..</span>
          <span /><span /><span /><span /><span />
        </button>}
        {entries.map((entry, index) => <button
        key={entry.path}
        className={`ssh-file-entry ${selectedPaths.has(entry.path) ? 'ssh-file-entry--selected' : ''}`}
        aria-pressed={entry.type === 'file' || entry.type === 'directory' ? selectedPaths.has(entry.path) : undefined}
        draggable={entry.type === 'file' || entry.type === 'directory'}
        onContextMenu={(event) => openEntryContextMenu(event, entry, index)}
        onMouseEnter={() => scheduleDirectoryPrefetch(entry)}
        onMouseLeave={() => { if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current); }}
        onDragStart={(event) => beginRemoteDrag(event, entry)}
        onDoubleClick={() => {
          if (entry.type === 'directory') navigate(entry.path);
          else if (entry.type === 'file') void openFile(entry);
        }}
        onClick={(event) => selectEntry(event, entry, index)}
      >
        <span className="ssh-file-cell ssh-file-cell--name" title={entry.name}>
          {entry.type === 'directory' ? '📁' : entry.type === 'link' ? '🔗' : '📄'} {entry.name}
        </span>
        <span className="ssh-file-cell ssh-file-cell--size">{formatFileSize(entry)}</span>
        <span className="ssh-file-cell" title={entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : ''}>{formatModifiedAt(entry.modifiedAt)}</span>
        <span className="ssh-file-cell" title={entry.owner}>{entry.owner || ''}</span>
        <span className="ssh-file-cell" title={entry.group}>{entry.group || ''}</span>
        <span className="ssh-file-cell ssh-file-cell--permissions">{entry.permissions || ''}</span>
      </button>)}</div>
      {loading && <p className="ssh-file-drawer__loading">正在读取…</p>}
      {dropActive && <div className="ssh-file-drawer__drop-overlay">释放以上传文件</div>}
      {contextMenu && <div
        className="ssh-file-context-menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        role="menu"
        onClick={(event) => event.stopPropagation()}
      >
        <button role="menuitem" onClick={() => {
          openNameDialog('create-file');
        }}>新建文件</button>
        <button role="menuitem" onClick={() => {
          openNameDialog('create-directory');
        }}>新建目录</button>
        {contextMenu.entry && <div className="ssh-file-context-menu__separator" role="separator" />}
        {contextMenu.entry && <>
        <button role="menuitem" onClick={() => {
          const entry = contextMenu.entry;
          if (entry) openNameDialog('rename', entry);
        }}>重命名</button>
        <button className="ssh-file-context-menu__danger" role="menuitem" onClick={() => {
          const entry = contextMenu.entry;
          setContextMenu(undefined);
          if (entry) void deleteEntry(entry);
        }}>删除</button>
        </>}
      </div>}
    </>}
    {nameDialog && <div
      className="ssh-dialog-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setNameDialog(undefined); }}
    >
      <form className="ssh-dialog ssh-name-dialog" onSubmit={(event) => {
        event.preventDefault();
        submitNameDialog();
      }}>
        <div className="ssh-dialog__header">
          <h2>{nameDialog.action === 'rename' ? '重命名' : nameDialog.action === 'create-file' ? '新建文件' : '新建目录'}</h2>
          <button className="ssh-icon-button" type="button" onClick={() => setNameDialog(undefined)}>×</button>
        </div>
        <input
          autoFocus
          value={nameDialog.value}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setNameDialog((current) => current ? { ...current, value: event.target.value } : current);
            setNameDialogError('');
          }}
          aria-label="名称"
        />
        {nameDialogError && <p className="ssh-dialog__error">{nameDialogError}</p>}
        <div className="ssh-dialog__actions">
          <button type="button" onClick={() => setNameDialog(undefined)}>取消</button>
          <button className="ssh-primary-button" type="submit">确定</button>
        </div>
      </form>
    </div>}
  </aside>;
}
