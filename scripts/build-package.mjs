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
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearPackageLocks } from './clear-package-locks.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const packageOnly = args.includes('--package-only');
const ebArgs = args.filter((a) => a !== '--package-only');
const require = createRequire(import.meta.url);

const feishuEnvKeys = [
  'WMUX_FEISHU_APP_ID',
  'WMUX_FEISHU_APP_SECRET',
  'WMUX_FEISHU_CHAT_ID',
  'WMUX_FEISHU_CONTROL_CHAT_ID',
  'WMUX_FEISHU_DECISION_CHAT_ID',
  'WMUX_FEISHU_ALLOWED_OPEN_IDS',
];
/** Persist only the allowlisted Feishu values for the locally installed app. */
function syncLocalFeishuConfig() {
  const sourcePath = path.join(projectRoot, '.env');
  let content;
  try {
    content = fs.readFileSync(sourcePath, 'utf8');
  } catch {
    return;
  }

  const {
    parseFeishuDotEnv,
    parseReferencedFeishuEnv,
    resolveFeishuEnvFilePointer,
  } = require(path.join(projectRoot, 'dist', 'main', 'feishu-supervisor.js'));
  const parsed = parseFeishuDotEnv(content);
  const values = Object.fromEntries(feishuEnvKeys.flatMap((key) => parsed[key] ? [[key, parsed[key]]] : []));
  const referencedFile = resolveFeishuEnvFilePointer(parsed, process.env);
  if (referencedFile) {
    const referencedPath = path.isAbsolute(referencedFile)
      ? referencedFile
      : path.resolve(projectRoot, referencedFile);
    try {
      const referencedValues = parseReferencedFeishuEnv(fs.readFileSync(referencedPath, 'utf8'));
      for (const [key, value] of Object.entries(referencedValues)) {
        if (!values[key]) values[key] = value;
      }
      console.log(`[build-package] Using Feishu env file: ${referencedPath}`);
    } catch {
      console.warn(`[build-package] Feishu config reference is unavailable: ${referencedPath}`);
    }
  }

  const lines = feishuEnvKeys.flatMap((key) => values[key] ? [`${key}=${values[key]}`] : []);
  if (lines.length === 0) return;

  const instanceSuffix = process.env.WMUX_INSTANCE?.trim() ? `-${process.env.WMUX_INSTANCE.trim()}` : '';
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const targetDir = path.join(appData, `wmux${instanceSuffix}`);
  const targetPath = path.join(targetDir, '.env');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(targetPath, 0o600); } catch { /* best effort on Windows */ }
  console.log(`[build-package] Synced local Feishu configuration to ${targetPath}`);
}

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

syncLocalFeishuConfig();

run(
  'Package (electron-builder)',
  'node',
  [path.join('scripts', 'electron-builder-safe.mjs'), ...ebArgs],
);

console.log('\n[build-package] done.');
