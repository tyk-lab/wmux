import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DEFAULT_PROJECT_EXECUTION_BUDGET } from '../../src/shared/project-manager';

/**
 * Guards against runtime-referenced files missing from the packaged app.
 *
 * Supported agent integrations execute `node <resources>/cli/wmux-hook.js` in
 * installed builds. The script must
 * live OUTSIDE the asar (bare node can't read asar archives), i.e. it must be
 * listed in electron-builder extraResources. It was missing until v0.29.1:
 * hook events could otherwise fail silently and leave workspaces pinned on
 * "Running" while the agent idled.
 */
describe('electron-builder packaging', () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../electron-builder.json'), 'utf8'),
  );
  const extraResources: Array<{ from: string; to: string; filter?: string[] }> = config.extraResources;

  it('ships every compiled CLI module and its shared dependencies outside the asar', () => {
    expect(extraResources).toContainEqual({ from: 'dist/cli', to: 'cli', filter: ['*.js'] });
    expect(extraResources).toContainEqual({ from: 'dist/shared', to: 'shared', filter: ['*.js'] });
  });

  it('ships generic agent instructions without Claude-only resources', () => {
    expect(extraResources).toContainEqual({
      from: 'resources/agent-instructions.md',
      to: 'agent-instructions/agent-instructions.md',
    });
    expect(extraResources.some(({ from }) => from.includes('claude'))).toBe(false);
    expect(extraResources.some(({ from }) => from.includes('wmux-orchestrator'))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '../../resources/agent-instructions.md'))).toBe(true);
  });

  it('ships the project management orchestration skill outside the asar', () => {
    expect(extraResources).toContainEqual({ from: 'resources/skills', to: 'skills' });
    expect(fs.existsSync(path.join(
      __dirname,
      '../../resources/skills/manage-project/SKILL.md',
    ))).toBe(true);
  });

  it('keeps the project skill example aligned with the runtime stage budget defaults', () => {
    const skill = fs.readFileSync(path.join(
      __dirname,
      '../../resources/skills/manage-project/SKILL.md',
    ), 'utf8');
    const budgetBlock = skill.match(/"budget":\s*(\{[^}]+\})/u)?.[1];
    expect(budgetBlock).toBeTruthy();
    expect(JSON.parse(budgetBlock || '{}')).toEqual(DEFAULT_PROJECT_EXECUTION_BUDGET);
  });

  it('keeps dedicated supervisor instructions as an application prompt, not an agent skill', () => {
    expect(fs.existsSync(path.join(
      __dirname,
      '../../resources/prompts/supervisor-protocol.md',
    ))).toBe(true);
    expect(fs.existsSync(path.join(
      __dirname,
      '../../resources/skills/supervise-task/SKILL.md',
    ))).toBe(false);
  });

  it('keeps installer-only main-process modules out of normal CLI startup', () => {
    const cliSource = fs.readFileSync(path.join(__dirname, '../../src/cli/wmux.ts'), 'utf8');
    expect(cliSource).not.toMatch(/^import[\s\S]*?from '\.\.\/main\/install-agent-hooks';/m);
    expect(cliSource).toContain("require('../main/install-agent-hooks')");
  });

});
