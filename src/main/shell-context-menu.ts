/**
 * shell-context-menu.ts — "Open in wmux" in the Windows Explorer context menu.
 *
 * Registers the classic shell verbs under HKCU\Software\Classes. Three roots are
 * needed because Explorer treats them as different objects:
 *   Directory             right-click ON a folder
 *   Directory\Background  right-click the empty space INSIDE a folder  <- the gesture
 *   Drive                 right-click a drive root (C:\)
 *
 * WHERE THIS SHOWS UP: on Windows 11 these land in the legacy menu, under
 * "Show more options" (Shift+F10). The modern top-level menu only accepts an
 * IExplorerCommand shell extension shipped in an MSIX package, and MSIX refuses
 * to install unless signed by a cert the machine trusts — wmux's signing is
 * self-signed and SignPath currently 400s, so that route is closed. This is the
 * same placement "Open with Code" gets, for the same reason.
 *
 * HKCU, never HKLM: no elevation prompt, per-user, and uninstall can't strand
 * a machine-wide key pointing at a deleted exe.
 *
 * Registry writes go through reg.exe rather than a native module: wmux ships as
 * a portable zip whose path routinely contains spaces and OneDrive segments, and
 * adding a node-gyp dependency for four keys would break the very packaging
 * story that already forbids electron-builder here.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

/** Verb key name — also the subkey under each root. */
const VERB = 'wmux';

/** The three Explorer object types that need their own copy of the verb. */
export const REG_ROOTS = [
  'Directory',
  'Directory\\Background',
  'Drive',
] as const;

export function verbKeyFor(root: string): string {
  return `HKCU\\Software\\Classes\\${root}\\shell\\${VERB}`;
}

/**
 * The command Explorer runs. `%V` is the folder the user acted on, and is the
 * one token that resolves correctly for ALL THREE roots — `%1` is empty for
 * Directory\Background, which is precisely the right-click-empty-space gesture
 * this feature exists to serve.
 *
 * Packaged:  `"C:\...\wmux.exe" "%V"`
 * Dev:       `"...\electron.exe" "C:\...\wmux" "%V"`
 *            (without the app path, Electron treats %V as the app and never
 *            boots wmux — the registry used to only store electron.exe "%V".)
 */
export function commandFor(exePath: string, appPath?: string | null): string {
  if (appPath) {
    return `"${exePath}" "${appPath}" "%V"`;
  }
  return `"${exePath}" "%V"`;
}

/** Icon spec — index 0 of the exe's own resources, which rcedit embeds at release. */
export function iconFor(exePath: string): string {
  return `"${exePath}",0`;
}

function reg(args: string[]): void {
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), args, {
    windowsHide: true,
    stdio: 'ignore',
  });
}

/** True when the verb is registered for every root (a partial state reads false). */
export function isContextMenuInstalled(): boolean {
  if (process.platform !== 'win32') return false;
  return REG_ROOTS.every((root) => {
    try {
      reg(['query', verbKeyFor(root), '/ve']);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Register the verb for all three roots.
 *
 * @param exePath absolute path to wmux.exe (or electron.exe in dev)
 * @param label   menu text, localized by the caller
 * @param appPath in dev: absolute path to the wmux project (app.getAppPath());
 *                packaged: omit / null so the command is just exe + "%V"
 */
export function installContextMenu(
  exePath: string,
  label = 'Open in wmux',
  appPath?: string | null,
): void {
  if (process.platform !== 'win32') return;
  for (const root of REG_ROOTS) {
    const key = verbKeyFor(root);
    reg(['add', key, '/ve', '/t', 'REG_SZ', '/d', label, '/f']);
    reg(['add', key, '/v', 'Icon', '/t', 'REG_SZ', '/d', iconFor(exePath), '/f']);
    reg(['add', `${key}\\command`, '/ve', '/t', 'REG_SZ', '/d', commandFor(exePath, appPath), '/f']);
  }
}

/** Remove the verb from all three roots. Missing keys are not an error. */
export function uninstallContextMenu(): void {
  if (process.platform !== 'win32') return;
  for (const root of REG_ROOTS) {
    try {
      reg(['delete', verbKeyFor(root), '/f']);
    } catch {
      // Not registered for this root — nothing to remove.
    }
  }
}

/**
 * Pull a directory to open out of a process argv.
 *
 * Explorer:  `wmux.exe "C:\folder"`           → last dir is the folder
 * Dev:       `electron.exe "C:\wmux" "C:\folder"` → last dir is the folder
 *                                        (first dir is the app root — skip by last-wins)
 *
 * Anything that is not an existing directory is ignored rather than guessed at.
 */
export function directoryFromArgv(
  argv: string[],
  isDirectory: (p: string) => boolean,
): string | null {
  let found: string | null = null;
  for (const raw of argv.slice(1)) {
    if (!raw || raw.startsWith('-')) continue;
    // Skip the packed app entry and dev script path.
    if (/\.(js|asar|exe)$/i.test(raw) || raw === '.') continue;
    const candidate = path.normalize(raw.replace(/^"|"$/g, ''));
    if (!path.isAbsolute(candidate)) continue;
    try {
      if (isDirectory(candidate)) {
        // Last directory wins: Explorer's folder is last; Electron app path first.
        found = candidate;
      }
    } catch {
      // Unreadable path — not a workspace target.
    }
  }
  return found;
}

/**
 * Cold-start folder from Explorer (`wmux.exe "%V"`). Stashed at process start
 * and consumed once by the renderer so session restore cannot race it away.
 */
let pendingLaunchDirectory: string | null = null;

export function setPendingLaunchDirectory(dir: string | null): void {
  pendingLaunchDirectory = dir;
}

/** One-shot: returns and clears the cold-start directory. */
export function consumePendingLaunchDirectory(): string | null {
  const dir = pendingLaunchDirectory;
  pendingLaunchDirectory = null;
  return dir;
}
