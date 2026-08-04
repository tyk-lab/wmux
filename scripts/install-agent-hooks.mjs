#!/usr/bin/env node
/**
 * Cross-platform installer for Claude/Kimi/Codex/Grok/Pi/OpenCode lifecycle hooks.
 *
 * Usage (from repo root):
 *   node scripts/install-agent-hooks.mjs
 *   node scripts/install-agent-hooks.mjs --no-opencode
 *   node scripts/install-agent-hooks.mjs --skip-build
 *   node scripts/install-agent-hooks.mjs --wmux-exe <path-to-wmux.exe>
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
const wmuxExeArg = args.indexOf('--wmux-exe');

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function optionValue(index, name) {
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) die(`${name} requires a path to wmux.exe`);
  return value;
}

function resolveInstalledWmuxHook() {
  const requestedExe = optionValue(wmuxExeArg, '--wmux-exe') || process.env.WMUX_EXE;
  const isExplicit = Boolean(requestedExe);
  const standardExe = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'wmux-build', 'release', 'win-unpacked', 'wmux.exe')
    : undefined;
  const exe = requestedExe || (standardExe && fs.existsSync(standardExe) ? standardExe : undefined);
  if (!exe) return undefined;

  const resolvedExe = path.resolve(exe);
  if (!fs.existsSync(resolvedExe)) {
    if (isExplicit) die(`wmux.exe not found: ${resolvedExe}`);
    return undefined;
  }

  const installedHook = path.join(path.dirname(resolvedExe), 'resources', 'cli', 'wmux-hook.js');
  if (!fs.existsSync(installedHook)) die(`wmux-hook.js not found beside wmux.exe: ${installedHook}`);
  return installedHook;
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
const installedHook = resolveInstalledWmuxHook();
const env = installedHook ? { ...process.env, WMUX_HOOK_SCRIPT: installedHook } : process.env;
console.log(installedHook
  ? `→ Use installed wmux Hook: ${installedHook}`
  : `→ Use repository Hook: ${path.join(root, 'dist', 'cli', 'wmux-hook.js')}`);
console.log(`→ node ${argv.join(' ')}`);
const r = spawnSync(process.execPath, argv, { cwd: root, stdio: 'inherit', env });
process.exit(r.status ?? 1);
