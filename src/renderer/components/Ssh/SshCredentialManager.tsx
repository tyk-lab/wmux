import { useCallback, useEffect, useState } from 'react';
import { SshConnectionProfile, SshCredentialStatus } from '../../../shared/types';
import '../../styles/ssh.css';

interface Props {
  profiles: SshConnectionProfile[];
  onClose: () => void;
  onProfilesChange: (profiles: SshConnectionProfile[]) => void;
}

export default function SshCredentialManager({ profiles, onClose, onProfilesChange }: Props) {
  const [statuses, setStatuses] = useState<Record<string, SshCredentialStatus>>({});
  const [editingPasswordId, setEditingPasswordId] = useState<string>();
  const [password, setPassword] = useState('');
  const [busyId, setBusyId] = useState<string>();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [error, setError] = useState('');

  const refreshStatuses = useCallback(async () => {
    const pairs = await Promise.all(profiles.map(async (profile) => {
      const status = await window.wmux?.ssh?.credentialStatus?.(profile);
      return [profile.id, status || { passwordSaved: false, privateKeyConfigured: Boolean(profile.privateKeyPath) }] as const;
    }));
    setStatuses(Object.fromEntries(pairs));
  }, [profiles]);

  useEffect(() => {
    void refreshStatuses().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [refreshStatuses]);

  const replaceProfile = (profile: SshConnectionProfile) => {
    onProfilesChange(profiles.map((item) => item.id === profile.id ? profile : item));
  };

  const updatePassword = async (profile: SshConnectionProfile) => {
    if (!password || busyId) return;
    setBusyId(profile.id);
    setError('');
    try {
      const result = await window.wmux?.ssh?.updateCredential?.(profile, password);
      if (!result?.ok) {
        setError(result?.error || 'SSH 密码验证失败');
        return;
      }
      replaceProfile({ ...profile, authMethod: 'password', privateKeyPath: undefined });
      setEditingPasswordId(undefined);
      setPassword('');
      await refreshStatuses();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(undefined);
    }
  };

  const deletePassword = async (profile: SshConnectionProfile) => {
    if (busyId) return;
    setBusyId(profile.id);
    setError('');
    try {
      await window.wmux?.ssh?.deleteCredential?.(profile);
      setConfirmDeleteId(undefined);
      await refreshStatuses();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(undefined);
    }
  };

  const choosePrivateKey = async (profile: SshConnectionProfile) => {
    const result = await window.wmux?.ssh?.pickKey?.();
    if (!result?.path) return;
    replaceProfile({ ...profile, authMethod: 'privateKey', privateKeyPath: result.path });
  };

  const clearPrivateKey = (profile: SshConnectionProfile) => {
    replaceProfile({
      ...profile,
      authMethod: profile.authMethod === 'privateKey' ? 'agent' : profile.authMethod,
      privateKeyPath: undefined,
    });
  };

  return <div className="ssh-dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="ssh-dialog ssh-credential-manager" role="dialog" aria-modal="true" aria-label="SSH 凭据管理" onMouseDown={(event) => event.stopPropagation()}>
      <div className="ssh-dialog__header">
        <div><h2>SSH 凭据管理</h2><p>密码仅显示保存状态；私钥只管理文件路径，不会复制或删除原文件。</p></div>
        <button type="button" className="ssh-icon-button" onClick={onClose} aria-label="关闭">×</button>
      </div>
      {error && <p className="ssh-dialog__error">{error}</p>}
      {profiles.length === 0 && <p className="ssh-credential-manager__empty">暂无 SSH 配置。</p>}
      <div className="ssh-credential-manager__list">
        {profiles.map((profile) => {
          const status = statuses[profile.id];
          const editing = editingPasswordId === profile.id;
          return <article className="ssh-credential-card" key={profile.id}>
            <div className="ssh-credential-card__title">
              <strong>{profile.name}</strong>
              <span>{profile.username}@{profile.host}:{profile.port}</span>
            </div>
            <div className="ssh-credential-card__row">
              <span>密码：{status?.passwordSaved ? '已加密保存' : '未保存'}</span>
              <button type="button" onClick={() => { setEditingPasswordId(profile.id); setPassword(''); setError(''); }}>更新密码</button>
              <button type="button" disabled={!status?.passwordSaved || busyId === profile.id} onClick={() => {
                if (confirmDeleteId === profile.id) void deletePassword(profile);
                else setConfirmDeleteId(profile.id);
              }}>{confirmDeleteId === profile.id ? '确认删除' : '删除密码'}</button>
            </div>
            {editing && <form className="ssh-credential-card__password" onSubmit={(event) => { event.preventDefault(); void updatePassword(profile); }}>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder="输入新密码并验证" autoFocus />
              <button className="ssh-primary-button" type="submit" disabled={!password || busyId === profile.id}>{busyId === profile.id ? '验证中…' : '验证并保存'}</button>
              <button type="button" onClick={() => { setEditingPasswordId(undefined); setPassword(''); }}>取消</button>
            </form>}
            <div className="ssh-credential-card__row">
              <span className="ssh-credential-card__path" title={profile.privateKeyPath || ''}>私钥：{profile.privateKeyPath || '未配置'}</span>
              <button type="button" onClick={() => void choosePrivateKey(profile)}>{profile.privateKeyPath ? '更换私钥' : '选择私钥'}</button>
              <button type="button" disabled={!profile.privateKeyPath} onClick={() => clearPrivateKey(profile)}>清除路径</button>
            </div>
          </article>;
        })}
      </div>
      <div className="ssh-dialog__actions"><button type="button" onClick={onClose}>完成</button></div>
    </section>
  </div>;
}
