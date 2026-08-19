import { useState } from 'react';
import { SshHostKeyPrompt } from '../../../shared/types';
import '../../styles/ssh.css';

interface Props {
  prompt: SshHostKeyPrompt;
  onCancel: () => void;
  onAccept: () => Promise<boolean>;
}

export default function SshHostKeyDialog({ prompt, onCancel, onAccept }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const hostLabel = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    const connected = await onAccept();
    setSubmitting(false);
    if (!connected) return;
  };

  return <div className="ssh-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
    <form className="ssh-dialog ssh-password-dialog" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
      <div className="ssh-dialog__header">
        <div>
          <h2>{prompt.changed ? '主机密钥已变化' : '确认 SSH 主机密钥'}</h2>
          <p>这与命令行首次连接时输入 yes 相同。确认后会写入 ~/.ssh/known_hosts。</p>
        </div>
        <button type="button" className="ssh-icon-button" onClick={onCancel} aria-label="关闭">×</button>
      </div>
      {prompt.changed && (
        <p className="ssh-dialog__error">
          {hostLabel} 记录的密钥与当前服务器不一致。若你没有重装或更换过这台机器，应取消连接。
        </p>
      )}
      <p className="ssh-dialog__hint">{hostLabel} 的 {prompt.algorithm} 指纹：</p>
      <code className="ssh-host-key-fingerprint">{prompt.fingerprint}</code>
      {prompt.knownAs.length > 0 && (
        <p className="ssh-dialog__hint">此密钥已用于：{prompt.knownAs.join('、')}</p>
      )}
      <div className="ssh-dialog__actions">
        <button type="button" onClick={onCancel} disabled={submitting}>取消</button>
        <button className="ssh-primary-button" type="submit" disabled={submitting}>
          {submitting ? '正在连接…' : prompt.changed ? '仍要信任并继续' : '信任并继续'}
        </button>
      </div>
    </form>
  </div>;
}
