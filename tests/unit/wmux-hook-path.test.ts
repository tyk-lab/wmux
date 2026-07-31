import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWmuxHookScriptPath, resolveWmuxHookScriptPosix } from '../../src/main/wmux-hook-path';

const originalOverride = process.env.WMUX_HOOK_SCRIPT;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalOverride === undefined) delete process.env.WMUX_HOOK_SCRIPT;
  else process.env.WMUX_HOOK_SCRIPT = originalOverride;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveWmuxHookScriptPath', () => {
  it('uses an existing installer override for the selected wmux build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hook-path-'));
    tempDirs.push(dir);
    const hook = path.join(dir, 'resources', 'cli', 'wmux-hook.js');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '// hook\n');
    process.env.WMUX_HOOK_SCRIPT = hook;

    expect(resolveWmuxHookScriptPath()).toBe(hook);
    expect(resolveWmuxHookScriptPosix()).toBe(hook.split(path.sep).join('/'));
  });
});
