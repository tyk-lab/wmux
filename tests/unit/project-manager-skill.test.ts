import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureProjectManagerSkill } from '../../src/main/project-manager-skill';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-project-manager-skill-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createBundledSkill(root: string, packaged: boolean): { appPath: string; resourcesPath: string } {
  const appPath = path.join(root, 'app');
  const resourcesPath = path.join(root, 'packaged-resources');
  const resourcesRoot = packaged ? resourcesPath : path.join(appPath, 'resources');
  const sourceDir = path.join(resourcesRoot, 'skills', 'inspect-project-progress');
  fs.mkdirSync(path.join(sourceDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '---\nname: inspect-project-progress\ndescription: test\n---\n', 'utf8');
  fs.writeFileSync(path.join(sourceDir, 'agents', 'openai.yaml'), 'interface:\n  display_name: "Test"\n', 'utf8');
  return { appPath, resourcesPath };
}

describe('project manager bundled skill', () => {
  it.each([false, true])('creates a missing target skill from %s resources', (packaged) => {
    const root = temporaryDirectory();
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir);
    const runtime = createBundledSkill(root, packaged);

    const result = ensureProjectManagerSkill({ ...runtime, isPackaged: packaged, projectDir });

    expect(result).toMatchObject({ ok: true, created: true });
    expect(fs.readFileSync(result.skillPath, 'utf8')).toContain('name: inspect-project-progress');
    expect(fs.existsSync(path.join(path.dirname(result.skillPath), 'agents', 'openai.yaml'))).toBe(true);
  });

  it('preserves an existing project skill', () => {
    const root = temporaryDirectory();
    const projectDir = path.join(root, 'project');
    const targetSkill = path.join(projectDir, '.grok', 'skills', 'inspect-project-progress', 'SKILL.md');
    fs.mkdirSync(path.dirname(targetSkill), { recursive: true });
    fs.writeFileSync(targetSkill, 'custom project skill', 'utf8');
    const runtime = createBundledSkill(root, false);

    const result = ensureProjectManagerSkill({ ...runtime, isPackaged: false, projectDir });

    expect(result).toMatchObject({ ok: true, created: false, skillPath: targetSkill });
    expect(fs.readFileSync(targetSkill, 'utf8')).toBe('custom project skill');
  });

  it('reports a missing bundled skill without leaving a false success', () => {
    const root = temporaryDirectory();
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir);

    const result = ensureProjectManagerSkill({
      appPath: path.join(root, 'app'),
      resourcesPath: path.join(root, 'resources'),
      isPackaged: false,
      projectDir,
    });

    expect(result).toMatchObject({ ok: false, created: false });
    expect(result.error).toContain('无法创建 inspect-project-progress 技能');
    expect(fs.existsSync(result.skillPath)).toBe(false);
  });
});
