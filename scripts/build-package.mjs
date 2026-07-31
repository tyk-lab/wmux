/**
 * Full compile + package pipeline with lock clearing.
 *
 * 1. Clear old packaging handles / win-unpacked leftovers
 * 2. tsc (main/preload/cli) + vite (renderer)   [skip with --package-only]
 * 3. Clear locks again (sync may re-grab during long compile)
 * 4. electron-builder via electron-builder-safe.mjs
 *
 * Usage (from repo root):
 *   node scripts/build-package.mjs
 *   node scripts/build-package.mjs --package-only
 *   node scripts/build-package.mjs --win nsis
 *   npm run build
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearPackageLocks } from './clear-package-locks.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const packageOnly = args.includes('--package-only');
const ebArgs = args.filter((a) => a !== '--package-only');

function run(label, command, commandArgs) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: true,
    cwd: projectRoot,
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`[build-package] failed: ${label} (exit ${result.status ?? 1})`);
    process.exit(result.status ?? 1);
  }
}

console.log('[build-package] wmux compile + package');

clearPackageLocks({ root: projectRoot });

if (!packageOnly) {
  run('Compile main / preload / cli', 'npx', ['tsc', '-p', 'tsconfig.node.json']);
  run('Build renderer', 'npx', ['vite', 'build']);
  // Compile can take long enough for sync clients to re-open leftovers.
  clearPackageLocks({ root: projectRoot });
}

run(
  'Package (electron-builder)',
  'node',
  [path.join('scripts', 'electron-builder-safe.mjs'), ...ebArgs],
);

console.log('\n[build-package] done.');
