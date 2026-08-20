import { useStore } from '../../store';
import type { DefaultSupervisorAgent, SshCompanionAgent } from '../../../shared/types';

export default function WorkspaceSettings() {
  const { workspacePrefs, setWorkspacePrefs } = useStore();

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Workspace Behaviour</h3>

      <div className="settings-row">
        <label className="settings-label">New workspace placement</label>
        <select
          className="settings-select"
          value={workspacePrefs.newWorkspacePlacement}
          onChange={(e) =>
            setWorkspacePrefs({
              newWorkspacePlacement: e.target.value as 'afterCurrent' | 'top' | 'end',
            })
          }
        >
          <option value="afterCurrent">After Current</option>
          <option value="top">Top</option>
          <option value="end">End</option>
        </select>
      </div>

      <div className="settings-row">
        <label className="settings-label">Auto-reorder on notification</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.autoReorderOnNotification}
          onChange={(e) => setWorkspacePrefs({ autoReorderOnNotification: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">Show welcome screen on startup</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.showWelcomeScreen}
          onChange={(e) => setWorkspacePrefs({ showWelcomeScreen: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">Confirm before closing a session</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={workspacePrefs.confirmWorkspaceClose}
          onChange={(e) => setWorkspacePrefs({ confirmWorkspaceClose: e.target.checked })}
        />
      </div>
      <p className="settings-hint">
        Ask before the × button, the context menu or Ctrl+Shift+W closes a session — a stray click
        can&apos;t take down agents that haven&apos;t saved their state yet. Closes from the CLI and
        agents never prompt.
      </p>

      <div className="settings-divider" />
      <h3 className="settings-section-title">AI Agent 默认设置</h3>

      <div className="settings-row">
        <label className="settings-label">AI 监督默认 Agent</label>
        <select
          className="settings-select"
          value={workspacePrefs.defaultSupervisorAgent}
          onChange={(e) => setWorkspacePrefs({ defaultSupervisorAgent: e.target.value as DefaultSupervisorAgent })}
        >
          <option value="pi">Pi Agent</option>
          <option value="codex">Codex</option>
          <option value="kimi">Kimi Code</option>
          <option value="grok">Grok Build</option>
          <option value="opencode">OpenCode</option>
          <option value="none">不自动启动</option>
        </select>
      </div>
      <p className="settings-hint">仅作为新建 AI 监督的初始选择，不会修改已在运行或已暂停的监督会话。</p>

      <div className="settings-row">
        <label className="settings-label">SSH 辅助默认 Agent</label>
        <select
          className="settings-select"
          value={workspacePrefs.defaultSshAgent}
          onChange={(e) => setWorkspacePrefs({ defaultSshAgent: e.target.value as SshCompanionAgent })}
        >
          <option value="codex">Codex</option>
          <option value="kimi">Kimi Code</option>
          <option value="grok">Grok Build</option>
          <option value="none">无（仅创建 SSH 终端）</option>
        </select>
      </div>
      <p className="settings-hint">打开“添加 SSH”时默认选中，创建前仍可临时切换。</p>

      <div className="settings-divider" />
      <h3 className="settings-section-title">Shell</h3>

      <div className="settings-row">
        <label className="settings-label">Default shell</label>
        <select
          className="settings-select"
          value={workspacePrefs.defaultShell}
          onChange={(e) => setWorkspacePrefs({ defaultShell: e.target.value })}
        >
          <option value="">System default</option>
          <option value="powershell.exe">PowerShell</option>
          <option value="pwsh.exe">PowerShell Core</option>
          <option value="cmd.exe">Command Prompt</option>
          <option value="bash.exe">Git Bash</option>
          <option value="wsl.exe">WSL</option>
        </select>
      </div>
    </div>
  );
}
