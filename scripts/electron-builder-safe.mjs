/**
 * Run electron-builder without writing packaging intermediates under a
 * file-sync tree (VerySync/OneDrive/etc.). Those clients lock .asar mid-pack
 * and surface as EBUSY on unlink of default_app.asar / app.asar.
 *
 * - CI / non-Windows: use project release/ (electron-builder.json default)
 * - Local Windows: pack under %LOCALAPPDATA%/wmux-build/release, then copy
 *   installer artifacts back into project release/
 * Override: WMUX_BUILD_OUT=<absolute-or-relative-dir>
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  clearPackageLocks,
  resolvePackOutDir,
} from './clear-package-locks.mjs';

const projectRoot = process.cwd();
const extraArgs = process.argv.slice(2);

const outDir = resolvePackOutDir(projectRoot);
fs.mkdirSync(outDir, { recursive: true });

// Clear locks on both project release/ and the real pack out dir.
clearPackageLocks({ root: projectRoot });

const result = spawnSync(
  'npx',
  ['electron-builder', `--config.directories.output=${outDir}`, ...extraArgs],
  {
    stdio: 'inherit',
    shell: true,
    cwd: projectRoot,
    env: process.env,
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const projectRelease = path.join(projectRoot, 'release');
if (path.resolve(outDir) === path.resolve(projectRelease)) {
  process.exit(0);
}

fs.mkdirSync(projectRelease, { recursive: true });
const skipDirs = new Set([
  'win-unpacked',
  'win-unpacked.tmp',
]);

for (const name of fs.readdirSync(outDir)) {
  if (skipDirs.has(name) || name.includes('.trash-')) continue;
  const src = path.join(outDir, name);
  if (!fs.statSync(src).isFile()) continue;
  const dest = path.join(projectRelease, name);
  try {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${name} -> release/`);
  } catch (err) {
    console.warn(`Warning: could not copy ${name} to release/: ${err.message}`);
    console.warn(`  Artifact is at: ${src}`);
  }
}

console.log(`electron-builder output: ${outDir}`);
