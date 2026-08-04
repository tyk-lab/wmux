import { useState } from 'react';
import '../../styles/ssh.css';

interface Props {
  profileName: string;
  errorMessage?: string;
  onCancel: () => void;
  onSubmit: (password: string) => Promise<boolean>;
}

export default function SshPasswordDialog({ profileName, errorMessage, onCancel, onSubmit }: Props) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    const connected = await onSubmit(password);
    setSubmitting(false);
    if (!connected) setPassword('');
  };

  return <div className="ssh-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
    <form className="ssh-dialog ssh-password-dialog" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
      <div className="ssh-dialog__header">
        <div><h2>输入 SSH 密码</h2><p>{profileName} 的密码将由 Windows DPAPI 加密保存。</p></div>
        <button type="button" className="ssh-icon-button" onClick={onCancel} aria-label="关闭">×</button>
      </div>
      {errorMessage && <p className="ssh-dialog__error">{errorMessage}</p>}
      <input
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="current-password"
        placeholder="SSH 密码"
        autoFocus
        disabled={submitting}
      />
      <div className="ssh-dialog__actions">
        <button type="button" onClick={onCancel} disabled={submitting}>取消</button>
        <button className="ssh-primary-button" type="submit" disabled={!password || submitting}>
          {submitting ? '正在验证…' : '连接并保存'}
        </button>
      </div>
    </form>
  </div>;
}
