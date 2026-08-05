import { useEffect, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { SshConfigDraft, SshConnectionProfile, type SshCompanionAgent } from '../../../shared/types';
import SshCredentialManager from './SshCredentialManager';
import '../../styles/ssh.css';

interface Props {
  profiles: SshConnectionProfile[];
  defaultCompanionAgent: SshCompanionAgent;
  onClose: () => void;
  onConnect: (profile: SshConnectionProfile, companionAgent: SshCompanionAgent, password?: string) => void;
  onProfilesChange: (profiles: SshConnectionProfile[]) => void;
  onSetDefaultCompanionAgent: (agent: SshCompanionAgent) => void;
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

export default function SshConnectionDialog({
  profiles,
  defaultCompanionAgent,
  onClose,
  onConnect,
  onProfilesChange,
  onSetDefaultCompanionAgent,
}: Props) {
  const [profile, setProfile] = useState<SshConnectionProfile>(() => profiles[0] ?? blankProfile());
  const [drafts, setDrafts] = useState<SshConfigDraft[]>([]);
  const [importError, setImportError] = useState('');
  const [formError, setFormError] = useState('');
  const [password, setPassword] = useState('');
  const [credentialManagerOpen, setCredentialManagerOpen] = useState(false);
  const [companionAgent, setCompanionAgent] = useState<SshCompanionAgent>(defaultCompanionAgent);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (credentialManagerOpen) setCredentialManagerOpen(false);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [credentialManagerOpen, onClose]);

  const update = (patch: Partial<SshConnectionProfile>) => setProfile((current) => ({ ...current, ...patch }));
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile.name.trim() || !profile.host.trim() || !profile.username.trim()) return;
    if (profile.authMethod === 'privateKey' && !profile.privateKeyPath) {
      setFormError('请选择私钥文件');
      return;
    }
    if (profile.authMethod === 'password' && !password && !profiles.some((item) => item.id === profile.id)) {
      setFormError('请输入 SSH 密码');
      return;
    }
    setFormError('');
    onConnect(
      { ...profile, name: profile.name.trim(), host: profile.host.trim(), username: profile.username.trim() },
      companionAgent,
      profile.authMethod === 'password' ? password || undefined : undefined,
    );
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

  if (credentialManagerOpen) {
    return <SshCredentialManager
      profiles={profiles}
      onClose={() => setCredentialManagerOpen(false)}
      onProfilesChange={(nextProfiles) => {
        onProfilesChange(nextProfiles);
        const selected = nextProfiles.find((item) => item.id === profile.id);
        if (selected) setProfile(selected);
      }}
    />;
  }

  return (
    <div className="ssh-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="ssh-dialog" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="ssh-dialog__header">
          <div><h2>添加 SSH</h2><p>将创建一个直连 SSH 终端，可选创建控制该会话的本地 Agent 终端；SFTP 文件抽屉始终可用。</p></div>
          <button type="button" className="ssh-icon-button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="ssh-dialog__preset-row">
          <select value={profile.id} onChange={(event) => {
            const selected = profiles.find((item) => item.id === event.target.value);
            if (selected) {
              setProfile(selected);
              setPassword('');
            }
          }}>
            <option value={profile.id}>当前配置</option>
            {profiles.filter((item) => item.id !== profile.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button type="button" onClick={() => { setProfile(blankProfile()); setPassword(''); }}>新建</button>
          <button type="button" onClick={importConfig}>导入 ~/.ssh/config</button>
          <button type="button" onClick={() => setCredentialManagerOpen(true)}>管理凭据</button>
        </div>
        {drafts.length > 0 && <select className="ssh-dialog__import" defaultValue="" onChange={(event) => {
          const draft = drafts.find((item) => item.hostAlias === event.target.value);
          if (draft) {
            setProfile(asProfile(draft));
            setPassword('');
          }
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
          <label><input type="radio" checked={profile.authMethod === 'agent'} onChange={() => { update({ authMethod: 'agent', privateKeyPath: undefined }); setPassword(''); }} /> SSH Agent</label>
          <label><input type="radio" checked={profile.authMethod === 'privateKey'} onChange={() => { update({ authMethod: 'privateKey' }); setPassword(''); }} /> 私钥文件</label>
          <label><input type="radio" checked={profile.authMethod === 'password'} onChange={() => update({ authMethod: 'password', privateKeyPath: undefined })} /> 密码</label>
          {profile.authMethod === 'privateKey' && <div className="ssh-dialog__key"><input value={profile.privateKeyPath || ''} readOnly placeholder="未选择私钥" /><button type="button" onClick={chooseKey}>选择文件</button></div>}
          {profile.authMethod === 'password' && <div className="ssh-dialog__key"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder={profiles.some((item) => item.id === profile.id) ? '留空使用已保存密码' : '输入 SSH 密码'} /></div>}
        </fieldset>
        <div className="ssh-dialog__agent">
          <label htmlFor="ssh-companion-agent">辅助 Agent</label>
          <span className="ssh-dialog__agent-choice">
            <select id="ssh-companion-agent" value={companionAgent} onChange={(event) => setCompanionAgent(event.target.value as SshCompanionAgent)}>
              <option value="codex">Codex{defaultCompanionAgent === 'codex' ? '（当前默认）' : ''}</option>
              <option value="kimi">Kimi Code{defaultCompanionAgent === 'kimi' ? '（当前默认）' : ''}</option>
              <option value="grok">Grok Build{defaultCompanionAgent === 'grok' ? '（当前默认）' : ''}</option>
              <option value="none">无（仅创建 SSH 终端）{defaultCompanionAgent === 'none' ? '（当前默认）' : ''}</option>
            </select>
            <button
              type="button"
              disabled={companionAgent === defaultCompanionAgent}
              onClick={() => onSetDefaultCompanionAgent(companionAgent)}
            >
              {companionAgent === defaultCompanionAgent ? '已为默认' : '设为默认'}
            </button>
          </span>
        </div>
        <p className="ssh-dialog__hint">密码经 Windows DPAPI 加密保存，仅在认证失败时要求重新输入；私钥内容不会保存。</p>
        {companionAgent !== 'none' && <p className="ssh-dialog__control-guide"><strong>Agent 控制 SSH：</strong>使用 <code>read-screen</code> 读取输出、<code>send</code> 发送文本、<code>send-key enter</code> 提交。中断命令必须使用 <code>send-key c --ctrl</code>，不能把 <code>ctrl+c</code> 当键名。创建后会自动把 SSH 终端 ID 和完整说明交给 Agent。</p>}
        <div className="ssh-dialog__actions"><button type="button" onClick={onClose}>取消</button><button className="ssh-primary-button" type="submit">连接并创建工作区</button></div>
      </form>
    </div>
  );
}
