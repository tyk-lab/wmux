import { useCallback, useEffect, useState } from 'react';
import { SshFileEntry } from '../../../shared/types';
import '../../styles/ssh.css';

interface Props {
  workspaceId: string;
  state: 'connecting' | 'connected' | 'disconnected' | 'error';
  errorMessage?: string;
  onReconnect: () => void;
}

function parentPath(current: string): string {
  const clean = current.replace(/\/+$/, '') || '/';
  if (clean === '/' || clean === '.') return clean;
  const parent = clean.slice(0, clean.lastIndexOf('/'));
  return parent || '/';
}

export default function SshFileDrawer({ workspaceId, state, errorMessage, onReconnect }: Props) {
  const [currentPath, setCurrentPath] = useState('.');
  const [entries, setEntries] = useState<SshFileEntry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (state !== 'connected') return;
    setLoading(true);
    setError('');
    try {
      const result = await window.wmux?.ssh?.list?.(workspaceId, currentPath);
      setEntries(result?.entries || []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, currentPath, state]);

  useEffect(() => { void refresh(); }, [refresh]);
  const upload = async () => {
    try {
      await window.wmux?.ssh?.upload?.(workspaceId, currentPath);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const download = async (entry: SshFileEntry) => {
    try {
      await window.wmux?.ssh?.download?.(workspaceId, entry.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return <aside className="ssh-file-drawer">
    <div className="ssh-file-drawer__header"><strong>远程文件</strong><button onClick={refresh} disabled={loading || state !== 'connected'}>刷新</button></div>
    {state !== 'connected' ? <div className="ssh-file-drawer__status">
      <p>{state === 'connecting' ? '正在连接 SFTP…' : state === 'error' ? errorMessage || 'SFTP 连接失败。' : 'SSH 文件连接已断开。'}</p>
      <button className="ssh-primary-button" onClick={onReconnect}>重新连接</button>
    </div> : <>
      <div className="ssh-file-drawer__path"><button onClick={() => setCurrentPath(parentPath(currentPath))}>↑</button><span title={currentPath}>{currentPath}</span><button onClick={upload}>上传</button></div>
      {error && <p className="ssh-dialog__error">{error}</p>}
      <div className="ssh-file-drawer__list">{entries.map((entry) => <button key={entry.path} className="ssh-file-entry" onDoubleClick={() => entry.type === 'directory' && setCurrentPath(entry.path)} onClick={() => entry.type === 'file' && void download(entry)}>
        <span>{entry.type === 'directory' ? '📁' : '📄'} {entry.name}</span><small>{entry.type === 'file' ? `${entry.size} B` : '目录'}</small>
      </button>)}</div>
      {loading && <p className="ssh-file-drawer__loading">正在读取…</p>}
    </>}
  </aside>;
}
