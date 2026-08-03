import { useEffect, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { SshConfigDraft, SshConnectionProfile } from '../../../shared/types';
import '../../styles/ssh.css';

interface Props {
  profiles: SshConnectionProfile[];
  onClose: () => void;
  onConnect: (profile: SshConnectionProfile) => void;
}

function blankProfile(): SshConnectionProfile {
  return { id: uuid(), name: '', host: '', port: 22, username: '', authMethod: 'agent' };
}

function asProfile(draft: SshConfigDraft): SshConnectionProfile {
  return {
    id: uuid(),
    name: draft.name || draft.hostAlias,
    host: draft.host || draft.hostAlias,
    port: draft.port || 22,
    username: draft.username || '',
    authMethod: draft.authMethod || 'agent',
    privateKeyPath: draft.privateKeyPath,
  };
}

export default function SshConnectionDialog({ profiles, onClose, onConnect }: Props) {
  const [profile, setProfile] = useState<SshConnectionProfile>(() => profiles[0] ?? blankProfile());
  const [drafts, setDrafts] = useState<SshConfigDraft[]>([]);
  const [importError, setImportError] = useState('');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const update = (patch: Partial<SshConnectionProfile>) => setProfile((current) => ({ ...current, ...patch }));
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile.name.trim() || !profile.host.trim() || !profile.username.trim()) return;
    if (profile.authMethod === 'privateKey' && !profile.privateKeyPath) {
      setFormError('请选择私钥文件');
      return;
    }
    setFormError('');
    onConnect({ ...profile, name: profile.name.trim(), host: profile.host.trim(), username: profile.username.trim() });
  };
  const importConfig = async () => {
    const result = await window.wmux?.ssh?.importConfig?.();
    setDrafts(result?.drafts || []);
    setImportError(result?.error || (result?.drafts?.length ? '' : '未找到可导入的 Host 配置'));
  };
  const chooseKey = async () => {
    const result = await window.wmux?.ssh?.pickKey?.();
    if (result?.path) update({ privateKeyPath: result.path });
  };

  return (
    <div className="ssh-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="ssh-dialog" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="ssh-dialog__header">
          <div><h2>添加 SSH</h2><p>将创建一个 psmux→SSH 终端、一个普通本地终端，以及 SFTP 文件抽屉。</p></div>
          <button type="button" className="ssh-icon-button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="ssh-dialog__preset-row">
          <select value={profile.id} onChange={(event) => {
            const selected = profiles.find((item) => item.id === event.target.value);
            if (selected) setProfile(selected);
          }}>
            <option value={profile.id}>当前配置</option>
            {profiles.filter((item) => item.id !== profile.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button type="button" onClick={() => setProfile(blankProfile())}>新建</button>
          <button type="button" onClick={importConfig}>导入 ~/.ssh/config</button>
        </div>
        {drafts.length > 0 && <select className="ssh-dialog__import" defaultValue="" onChange={(event) => {
          const draft = drafts.find((item) => item.hostAlias === event.target.value);
          if (draft) setProfile(asProfile(draft));
        }}>
          <option value="" disabled>选择导入的 Host</option>
          {drafts.map((draft) => <option key={draft.hostAlias} value={draft.hostAlias}>{draft.hostAlias}</option>)}
        </select>}
        {importError && <p className="ssh-dialog__error">{importError}</p>}
        {formError && <p className="ssh-dialog__error">{formError}</p>}
        <div className="ssh-dialog__grid">
          <label>名称<input value={profile.name} onChange={(event) => update({ name: event.target.value })} placeholder="生产服务器" required /></label>
          <label>主机<input value={profile.host} onChange={(event) => update({ host: event.target.value })} placeholder="example.com" required /></label>
          <label>端口<input type="number" min="1" max="65535" value={profile.port} onChange={(event) => update({ port: Number(event.target.value) || 22 })} required /></label>
          <label>用户名<input value={profile.username} onChange={(event) => update({ username: event.target.value })} placeholder="ubuntu" required /></label>
        </div>
        <fieldset className="ssh-dialog__auth"><legend>认证方式</legend>
          <label><input type="radio" checked={profile.authMethod === 'agent'} onChange={() => update({ authMethod: 'agent', privateKeyPath: undefined })} /> SSH Agent</label>
          <label><input type="radio" checked={profile.authMethod === 'privateKey'} onChange={() => update({ authMethod: 'privateKey' })} /> 私钥文件</label>
          {profile.authMethod === 'privateKey' && <div className="ssh-dialog__key"><input value={profile.privateKeyPath || ''} readOnly placeholder="未选择私钥" /><button type="button" onClick={chooseKey}>选择文件</button></div>}
        </fieldset>
        <p className="ssh-dialog__hint">密码认证仅可在远程终端交互，不能用于文件管理。密码和私钥内容不会保存。</p>
        <div className="ssh-dialog__actions"><button type="button" onClick={onClose}>取消</button><button className="ssh-primary-button" type="submit">连接并创建工作区</button></div>
      </form>
    </div>
  );
}
