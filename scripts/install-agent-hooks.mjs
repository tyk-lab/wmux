#!/usr/bin/env node
/**
 * Cross-platform installer for wmux agent lifecycle hooks.
 *
 * Usage (from repo root):
 *   node scripts/install-agent-hooks.mjs
 *   node scripts/install-agent-hooks.mjs --no-opencode
 *   node scripts/install-agent-hooks.mjs --skip-build
 *
 * Builds dist/ when needed, then runs: node dist/cli/wmux.js install-hooks
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'dist', 'cli', 'wmux.js');
const hook = path.join(root, 'resources', 'cli', 'wmux-hook.js');

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const noOpencode = args.includes('--no-opencode');

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

if (!fs.existsSync(hook)) {
  die(`Missing ${hook}`);
}

function mtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function needsBuild() {
  if (!fs.existsSync(cli)) return true;
  const cliM = mtime(cli);
  for (const dir of ['src/main', 'src/cli']) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length) {
      const cur = stack.pop();
      for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
        const p = path.join(cur, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.name.endsWith('.ts') && mtime(p) > cliM) return true;
      }
    }
  }
  return false;
}

if (!skipBuild && needsBuild()) {
  console.log('→ npm run build:main');
  const r = spawnSync('npm', ['run', 'build:main'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!fs.existsSync(cli)) {
  die(`Missing ${cli}. Run: npm run build:main`);
}

const argv = [cli, 'install-hooks'];
if (noOpencode) argv.push('--no-opencode');
console.log(`→ node ${argv.join(' ')}`);
const r = spawnSync(process.execPath, argv, { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
