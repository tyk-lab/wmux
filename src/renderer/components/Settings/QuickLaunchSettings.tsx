import { useState } from 'react';
import { useStore } from '../../store';
import { QuickLaunchProfile, SurfaceType } from '../../../shared/types';

const TYPES: SurfaceType[] = ['terminal', 'browser', 'markdown'];

function blankProfile(): QuickLaunchProfile {
  return { id: crypto.randomUUID(), name: 'New profile', type: 'terminal', shell: 'pwsh.exe' };
}

export default function QuickLaunchSettings() {
  const profiles = useStore((s) => s.quickLaunchProfiles);
  const setProfiles = useStore((s) => s.setQuickLaunchProfiles);
  const [importNote, setImportNote] = useState<string>('');

  const update = (id: string, patch: Partial<QuickLaunchProfile>) => {
    setProfiles(profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };
  const remove = (id: string) => setProfiles(profiles.filter((p) => p.id !== id));
  const add = () => setProfiles([...profiles, blankProfile()]);

  const importFromWT = async () => {
    const imported: QuickLaunchProfile[] = (await window.wmux?.config?.importWindowsTerminalProfiles?.()) || [];
    if (imported.length === 0) {
      setImportNote('No Windows Terminal profiles found.');
      return;
    }
    // De-dupe by id against existing profiles.
    const existing = new Set(profiles.map((p) => p.id));
    const fresh = imported.filter((p) => !existing.has(p.id));
    setProfiles([...profiles, ...fresh]);
    setImportNote(`Imported ${fresh.length} profile${fresh.length === 1 ? '' : 's'} from Windows Terminal.`);
  };

  const pickWorkingDirectory = async (id: string) => {
    const result = await window.wmux?.system?.pickFolder?.();
    if (!result || result.canceled || !result.path) return;
    update(id, { cwd: result.path });
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Quick-launch profiles</h3>
      <p className="settings-hint">
        One-click tab presets shown in the <strong>+</strong> dropdown next to each pane. A terminal
        profile can pick a shell, auto-<code>cd</code> into a directory and run startup commands; a
        browser profile opens a fixed URL. Project-specific profiles can also live in a committed
        <code> .wmux.json</code> at a workspace root.
      </p>

      <div className="settings-row">
        <button className="settings-button" onClick={importFromWT}>Import from Windows Terminal</button>
        {importNote && <span className="settings-hint">{importNote}</span>}
      </div>

      <div className="settings-divider" />

      {profiles.length === 0 && (
        <p className="settings-hint">No profiles yet. Add one below.</p>
      )}

      {profiles.map((p) => (
        <div key={p.id} className="ql-profile">
          <div className="ql-profile__head">
            <input
              className="settings-input ql-profile__name"
              value={p.name}
              placeholder="Name"
              onChange={(e) => update(p.id, { name: e.target.value })}
            />
            <input
              className="settings-input ql-profile__icon"
              value={p.icon ?? ''}
              placeholder="icon"
              title="Optional emoji/glyph"
              maxLength={2}
              onChange={(e) => update(p.id, { icon: e.target.value || undefined })}
            />
            <select
              className="settings-select"
              value={p.type}
              onChange={(e) => update(p.id, { type: e.target.value as SurfaceType })}
            >
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button className="settings-button settings-button--danger" onClick={() => remove(p.id)}>Remove</button>
          </div>

          {p.type === 'terminal' && (
            <div className="ql-profile__fields">
              <input
                className="settings-input"
                value={p.shell ?? ''}
                placeholder="Shell (optional, e.g. pwsh.exe)"
                onChange={(e) => update(p.id, { shell: e.target.value || undefined })}
              />
              <input
                className="settings-input"
                value={p.cwd ?? ''}
                placeholder="Working directory (optional)"
                onChange={(e) => update(p.id, { cwd: e.target.value || undefined })}
              />
              <button className="settings-button" onClick={() => void pickWorkingDirectory(p.id)}>
                Choose directory
              </button>
              <textarea
                className="settings-input ql-profile__commands"
                value={(p.startupCommands ?? []).join('\n')}
                placeholder="Startup commands (one per line)"
                rows={2}
                onChange={(e) =>
                  update(p.id, {
                    startupCommands: e.target.value
                      .split('\n')
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0),
                  })
                }
              />
            </div>
          )}

          {p.type === 'browser' && (
            <div className="ql-profile__fields">
              <input
                className="settings-input"
                value={p.url ?? ''}
                placeholder="URL (e.g. https://localhost:3000)"
                onChange={(e) => update(p.id, { url: e.target.value || undefined })}
              />
            </div>
          )}
        </div>
      ))}

      <div className="settings-row">
        <button className="settings-button" onClick={add}>+ Add profile</button>
      </div>
    </div>
  );
}
