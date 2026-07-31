/**
 * Release packaging file locks before electron-builder runs.
 *
 * Windows sync clients (VerySync/OneDrive), leftover wmux from release\,
 * and antivirus can hold .asar handles → EBUSY on unlink.
 *
 * Strategy:
 * 1. Stop processes whose executable lives under package output dirs
 * 2. Retry-delete win-unpacked / win-unpacked.tmp (+ leftover .trash-*)
 * 3. If still locked, rename aside so the canonical path is free again
 *
 * Usage:
 *   node scripts/clear-package-locks.mjs
 *   import { clearPackageLocks, resolvePackOutDir } from './clear-package-locks.mjs'
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isCi = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);

const PACK_DIR_NAMES = new Set([
  'win-unpacked',
  'win-unpacked.tmp',
]);

function isPackArtifactName(name) {
  if (PACK_DIR_NAMES.has(name)) return true;
  return (
    name.startsWith('win-unpacked.trash-') ||
    name.startsWith('win-unpacked.tmp.trash-')
  );
}

export function resolvePackOutDir(root = projectRoot) {
  if (process.env.WMUX_BUILD_OUT) {
    return path.resolve(root, process.env.WMUX_BUILD_OUT);
  }
  if (process.platform === 'win32' && !isCi) {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'wmux-build', 'release');
  }
  return path.join(root, 'release');
}

function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    spawnSync(
      process.platform === 'win32' ? 'pwsh' : 'sleep',
      process.platform === 'win32'
        ? ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${ms}`]
        : [String(Math.ceil(ms / 1000))],
      { stdio: 'ignore' },
    );
  }
}

/**
 * Kill only packaging-related processes under the given output roots.
 * Does not touch VS Code, VerySync, or dev `electron .` from node_modules.
 */
export function killPackageHolders(dirs) {
  if (process.platform !== 'win32') return [];

  const roots = [...new Set(
    dirs
      .filter(Boolean)
      .map((d) => path.resolve(d).toLowerCase().replace(/\//g, '\\')),
  )];
  if (roots.length === 0) return [];

  const rootsLiteral = roots
    .map((d) => `'${d.replace(/'/g, "''")}'`)
    .join(',');

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$roots = @(${rootsLiteral})
$killed = New-Object System.Collections.Generic.List[string]
$allow = [regex]'^(wmux|electron|elevate|app-builder|winpty-agent|openconsole)\\.exe$'

function Test-UnderRoot([string]$path) {
  if (-not $path) { return $false }
  $pl = $path.ToLowerInvariant().Replace('/', '\\')
  foreach ($r in $roots) {
    if ($pl -eq $r -or $pl.StartsWith($r + '\\')) { return $true }
  }
  return $false
}

Get-CimInstance Win32_Process | ForEach-Object {
  $exe = $_.ExecutablePath
  if (-not (Test-UnderRoot $exe)) { return }
  if (-not $allow.IsMatch($_.Name)) { return }
  try {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
    $killed.Add("$($_.ProcessId) $($_.Name) $exe") | Out-Null
  } catch {}
}

# Packaged binary is always named wmux.exe; only stop copies under pack dirs.
Get-Process -Name wmux -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $null
  try { $p = $_.Path } catch {}
  if (-not $p) { return }
  if (-not (Test-UnderRoot $p) -and -not ($p -match 'win-unpacked|wmux-build')) { return }
  try {
    Stop-Process -Id $_.Id -Force -ErrorAction Stop
    $killed.Add("$($_.Id) wmux.exe $p") | Out-Null
  } catch {}
}

$killed | ForEach-Object { $_ }
`;

  const result = spawnSync('pwsh', ['-NoProfile', '-Command', ps], {
    encoding: 'utf8',
    shell: false,
  });

  const lines = (result.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return lines;
}

function deepUnlinkBestEffort(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        deepUnlinkBestEffort(full);
        fs.rmdirSync(full);
      } else {
        fs.chmodSync(full, 0o666);
        fs.unlinkSync(full);
      }
    } catch {
      // leave locked leaves; parent rename may still free the name
    }
  }
}

function tryRemovePath(target, retries = 6) {
  for (let i = 0; i < retries; i++) {
    try {
      if (!fs.existsSync(target)) return { ok: true, method: 'absent' };
      fs.rmSync(target, { recursive: true, force: true });
      return { ok: true, method: i === 0 ? 'rm' : `rm-retry-${i}` };
    } catch {
      // Peel locked trees leaf-first, then retry.
      try {
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          deepUnlinkBestEffort(target);
        }
      } catch {
        // ignore
      }
      if (process.platform === 'win32') {
        spawnSync('cmd.exe', ['/d', '/c', `rmdir /s /q "${target}"`], {
          stdio: 'ignore',
          windowsHide: true,
        });
      }
      sleepMs(200 * (i + 1));
    }
  }

  // Free the canonical name even if contents stay locked.
  try {
    if (!fs.existsSync(target)) return { ok: true, method: 'absent' };
    const trash = `${target}.trash-${Date.now()}-${process.pid}`;
    fs.renameSync(target, trash);
    try {
      fs.rmSync(trash, { recursive: true, force: true });
      return { ok: true, method: 'rename+rm' };
    } catch {
      console.warn(`  renamed locked path aside (delete later): ${path.basename(trash)}`);
      return { ok: true, method: 'rename' };
    }
  } catch (err) {
    console.warn(`  still locked: ${target} (${err.message})`);
    return { ok: false, method: 'fail', error: err };
  }
}

export function clearPackageLocks(options = {}) {
  const root = options.root || projectRoot;
  const projectRelease = path.join(root, 'release');
  const packOut = resolvePackOutDir(root);
  const bases = [...new Set([projectRelease, packOut].map((p) => path.resolve(p)))];

  console.log('[clear-package-locks] Releasing old packaging handles...');
  for (const base of bases) {
    console.log(`  target: ${base}`);
  }

  const killed = killPackageHolders(bases);
  if (killed.length > 0) {
    console.log('[clear-package-locks] Stopped processes holding package paths:');
    for (const line of killed) console.log(`  killed ${line}`);
  } else {
    console.log('[clear-package-locks] No packaging process holds those paths.');
  }

  // Brief pause so handles drop after Stop-Process.
  sleepMs(300);

  let failed = 0;
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(base);
    } catch (err) {
      console.warn(`  cannot list ${base}: ${err.message}`);
      continue;
    }

    for (const name of entries) {
      if (!isPackArtifactName(name)) continue;
      const target = path.join(base, name);
      const result = tryRemovePath(target);
      if (result.ok) {
        if (result.method !== 'absent') {
          console.log(`  cleared ${name} (${result.method})`);
        }
      } else {
        failed += 1;
      }
    }
  }

  if (failed > 0) {
    console.warn(
      `[clear-package-locks] ${failed} path(s) still locked — packaging may hit EBUSY. ` +
        'Close wmux started from release\\, or pause VerySync on this folder.',
    );
  } else {
    console.log('[clear-package-locks] Package dirs ready.');
  }

  return { bases, killed, failed };
}

const isMain =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const { failed } = clearPackageLocks();
  process.exit(failed > 0 ? 2 : 0);
}
