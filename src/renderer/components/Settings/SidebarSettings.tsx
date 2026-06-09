import { useStore } from '../../store';

export default function SidebarSettings() {
  const { sidebarPrefs, setSidebarPrefs } = useStore();

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Sidebar Details</h3>

      <div className="settings-row">
        <label className="settings-label">Show git branch</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={sidebarPrefs.showGitBranch}
          onChange={(e) => setSidebarPrefs({ showGitBranch: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">Show working directory</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={sidebarPrefs.showWorkingDir}
          onChange={(e) => setSidebarPrefs({ showWorkingDir: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">Show PR status</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={sidebarPrefs.showPR}
          onChange={(e) => setSidebarPrefs({ showPR: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">Show ports</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={sidebarPrefs.showPorts}
          onChange={(e) => setSidebarPrefs({ showPorts: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">Show notification message</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={sidebarPrefs.showNotificationMessage}
          onChange={(e) => setSidebarPrefs({ showNotificationMessage: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">Hide all details</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={sidebarPrefs.hideAllDetails}
          onChange={(e) => setSidebarPrefs({ hideAllDetails: e.target.checked })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">Appearance</h3>

      <div className="settings-row">
        <label className="settings-label">Interface theme</label>
        <select
          className="settings-select"
          value={sidebarPrefs.uiTheme}
          onChange={(e) =>
            setSidebarPrefs({ uiTheme: e.target.value as 'codex' | 'claude' })
          }
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </div>

      <div className="settings-row">
        <label className="settings-label">Active tab indicator</label>
        <select
          className="settings-select"
          value={sidebarPrefs.activeTabIndicator}
          onChange={(e) =>
            setSidebarPrefs({
              activeTabIndicator: e.target.value as 'leftRail' | 'solidFill',
            })
          }
        >
          <option value="leftRail">Left Rail</option>
          <option value="solidFill">Solid Fill</option>
        </select>
      </div>

      <div className="settings-row settings-row--column">
        <div className="settings-row-header">
          <label className="settings-label">Background opacity</label>
          <span className="settings-value">{sidebarPrefs.backgroundOpacity}%</span>
        </div>
        <input
          type="range"
          className="settings-slider"
          min={10}
          max={100}
          value={sidebarPrefs.backgroundOpacity}
          onChange={(e) => setSidebarPrefs({ backgroundOpacity: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
