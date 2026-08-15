import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Guards against runtime-referenced files missing from the packaged app.
 *
 * claude-context.ts writes Claude Code hooks into ~/.claude/settings.json that
 * exec `node <resources>/cli/wmux-hook.js` in installed builds. The script must
 * live OUTSIDE the asar (bare node can't read asar archives), i.e. it must be
 * listed in electron-builder extraResources. It was missing until v0.29.1:
 * every hook silently failed, so the sidebar never received PostToolUse/Stop
 * events and workspaces stayed pinned on "Running" while Claude idled.
 */
describe('electron-builder packaging', () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../electron-builder.json'), 'utf8'),
  );
  const extraResources: Array<{ from: string; to: string; filter?: string[] }> = config.extraResources;

  it('ships every compiled CLI module outside the asar', () => {
    expect(extraResources).toContainEqual({ from: 'dist/cli', to: 'cli', filter: ['*.js'] });
  });

  it('ships the project progress inspection skill outside the asar', () => {
    expect(extraResources).toContainEqual({ from: 'resources/skills', to: 'skills' });
    expect(fs.existsSync(path.join(
      __dirname,
      '../../resources/skills/inspect-project-progress/SKILL.md',
    ))).toBe(true);
  });

  it('keeps installer-only main-process modules out of normal CLI startup', () => {
    const cliSource = fs.readFileSync(path.join(__dirname, '../../src/cli/wmux.ts'), 'utf8');
    expect(cliSource).not.toMatch(/^import[\s\S]*?from '\.\.\/main\/install-agent-hooks';/m);
    expect(cliSource).toContain("require('../main/install-agent-hooks')");
  });

});
