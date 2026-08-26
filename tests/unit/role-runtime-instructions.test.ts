import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureProjectManagerRuntimeInstructions,
  ensureRoleRuntimeInstructions,
} from '../../src/main/role-runtime-instructions';
import { roleProtocolFingerprint } from '../../src/shared/role-protocol';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-role-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createBundledInstructions(root: string, packaged: boolean): {
  appPath: string;
  resourcesPath: string;
} {
  const appPath = path.join(root, 'app');
  const resourcesPath = path.join(root, 'packaged-resources');
  const resourcesRoot = packaged ? resourcesPath : path.join(appPath, 'resources');
  for (const role of ['project-ai', 'supervisor-ai']) {
    const directory = path.join(resourcesRoot, 'agents', role);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'ROLE_AGENTS.md'), `# ${role}\n\nstable protocol\n`, 'utf8');
  }
  return { appPath, resourcesPath };
}

describe('managed role runtime instructions', () => {
  it('fingerprints the exact loaded role instructions and detects drift', () => {
    const first = roleProtocolFingerprint('# role\n\nstable protocol\n');

    expect(first).toBe(roleProtocolFingerprint('# role\n\nstable protocol\n'));
    expect(first).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
    expect(roleProtocolFingerprint('# role\n\nchanged protocol\n')).not.toBe(first);
  });

  it.each([false, true])('installs project AI AGENTS.md from packaged=%s resources', (packaged) => {
    const root = temporaryDirectory();
    const runtime = createBundledInstructions(root, packaged);
    const result = ensureProjectManagerRuntimeInstructions({
      ...runtime,
      isPackaged: packaged,
      appDataDir: path.join(root, 'app-data'),
    });

    expect(result).toMatchObject({ ok: true, created: true, updated: false });
    expect(result.runtimeDir).toBe(path.join(root, 'app-data', 'project-manager', 'runtime'));
    expect(result.agentsPath).toBe(path.join(result.runtimeDir, 'AGENTS.md'));
    expect(fs.readFileSync(result.agentsPath, 'utf8')).toContain('# project-ai');
  });

  it('updates an application-owned AGENTS.md when bundled instructions change', () => {
    const root = temporaryDirectory();
    const runtime = createBundledInstructions(root, false);
    const appDataDir = path.join(root, 'app-data');
    const first = ensureProjectManagerRuntimeInstructions({
      ...runtime,
      isPackaged: false,
      appDataDir,
    });
    fs.writeFileSync(
      path.join(runtime.appPath, 'resources', 'agents', 'project-ai', 'ROLE_AGENTS.md'),
      '# project-ai\n\nupdated protocol\n',
      'utf8',
    );

    const updated = ensureProjectManagerRuntimeInstructions({
      ...runtime,
      isPackaged: false,
      appDataDir,
    });

    expect(first.ok).toBe(true);
    expect(updated).toMatchObject({ ok: true, created: false, updated: true });
    expect(fs.readFileSync(updated.agentsPath, 'utf8')).toContain('updated protocol');
  });

  it('removes legacy project-manager skill copies from the application-owned runtime', () => {
    const root = temporaryDirectory();
    const runtime = createBundledInstructions(root, false);
    const runtimeDir = path.join(root, 'app-data', 'project-manager', 'runtime');
    const legacyDirectories = [
      path.join(runtimeDir, '.agents', 'skills', 'manage-project'),
      path.join(runtimeDir, '.grok', 'skills', 'manage-project'),
      path.join(runtimeDir, '.wmux', 'project-manager', 'manage-project'),
    ];
    for (const directory of legacyDirectories) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'), 'legacy protocol', 'utf8');
    }

    const result = ensureProjectManagerRuntimeInstructions({
      ...runtime,
      isPackaged: false,
      appDataDir: path.join(root, 'app-data'),
    });

    expect(result.ok).toBe(true);
    expect(legacyDirectories.every((directory) => !fs.existsSync(directory))).toBe(true);
  });

  it('does not delete a similarly named skill from a caller-supplied directory', () => {
    const root = temporaryDirectory();
    const runtime = createBundledInstructions(root, false);
    const callerDirectory = path.join(root, 'user-project');
    const userSkill = path.join(callerDirectory, '.agents', 'skills', 'manage-project', 'SKILL.md');
    fs.mkdirSync(path.dirname(userSkill), { recursive: true });
    fs.writeFileSync(userSkill, 'user-owned skill', 'utf8');

    const result = ensureRoleRuntimeInstructions(
      { ...runtime, isPackaged: false },
      'project-ai',
      callerDirectory,
    );

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(userSkill, 'utf8')).toBe('user-owned skill');
  });

  it('installs supervisor AGENTS.md into the exact isolated runtime directory', () => {
    const root = temporaryDirectory();
    const runtime = createBundledInstructions(root, false);
    const runtimeDir = path.join(root, 'app-data', 'wmux', 'supervisor', 'runtime', 'lane-a');
    const result = ensureRoleRuntimeInstructions(
      { ...runtime, isPackaged: false },
      'supervisor-ai',
      runtimeDir,
    );

    expect(result).toMatchObject({ ok: true, created: true, runtimeDir });
    expect(fs.readFileSync(result.agentsPath, 'utf8')).toContain('# supervisor-ai');
  });

  it('fails closed when the bundled role instructions are missing', () => {
    const root = temporaryDirectory();
    const result = ensureProjectManagerRuntimeInstructions({
      appPath: path.join(root, 'app'),
      resourcesPath: path.join(root, 'resources'),
      isPackaged: false,
      appDataDir: path.join(root, 'app-data'),
    });

    expect(result).toMatchObject({ ok: false, created: false, updated: false });
    expect(result.error).toContain('bundled AGENTS.md missing');
    expect(fs.existsSync(result.agentsPath)).toBe(false);
  });
});
