import fs from 'fs';
import path from 'path';
import {
  projectManagerSkillRelativePath,
  type ProjectManagerRuntimeAgent,
} from '../shared/project-manager-terminal';
import { getAppDataDir } from '../shared/instance';

interface ProjectManagerSkillRuntime {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  projectDir?: string;
  appDataDir?: string;
}

export interface ProjectManagerSkillResult {
  ok: boolean;
  created: boolean;
  updated?: boolean;
  skillPath: string;
  runtimeDir: string;
  error?: string;
}

export function projectManagerRuntimeDirectory(appDataDir = getAppDataDir()): string {
  return path.join(appDataDir, 'project-manager', 'runtime');
}

function bundledSkillDirectory(runtime: ProjectManagerSkillRuntime): string {
  const root = runtime.isPackaged
    ? runtime.resourcesPath
    : path.join(runtime.appPath, 'resources');
  return path.join(root, 'skills', 'manage-project');
}

function bundledSkillFilesMatch(sourceDir: string, targetDir: string): boolean {
  const sourceFiles: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) sourceFiles.push(path.relative(sourceDir, absolute));
    }
  };
  visit(sourceDir);
  return sourceFiles.every((relativePath) => {
    try {
      return fs.readFileSync(path.join(sourceDir, relativePath))
        .equals(fs.readFileSync(path.join(targetDir, relativePath)));
    } catch {
      return false;
    }
  });
}

export function ensureProjectManagerSkill(
  runtime: ProjectManagerSkillRuntime,
  agent: ProjectManagerRuntimeAgent = 'codex',
): ProjectManagerSkillResult {
  const projectDir = runtime.projectDir || projectManagerRuntimeDirectory(runtime.appDataDir);
  const skillPath = path.join(projectDir, projectManagerSkillRelativePath(agent));
  const sourceDir = bundledSkillDirectory(runtime);
  const sourceSkillPath = path.join(sourceDir, 'SKILL.md');
  try {
    if (!runtime.projectDir) fs.mkdirSync(projectDir, { recursive: true });
    if (!fs.statSync(projectDir).isDirectory()) {
      return { ok: false, created: false, skillPath, runtimeDir: projectDir, error: `项目管理终端目录不存在：${projectDir}` };
    }
  } catch {
    return { ok: false, created: false, skillPath, runtimeDir: projectDir, error: `无法创建项目管理终端目录：${projectDir}` };
  }

  try {
    if (!fs.statSync(sourceSkillPath).isFile()) throw new Error('bundled SKILL.md missing');
  } catch (error) {
    return {
      ok: false,
      created: false,
      skillPath,
      runtimeDir: projectDir,
      error: `无法创建 manage-project 技能：${String((error as Error)?.message || error)}`,
    };
  }

  let targetExists = false;
  try {
    targetExists = fs.statSync(skillPath).isFile();
  } catch { /* Missing target: install it below. */ }
  if (targetExists) {
    try {
      // A caller-supplied project directory may contain a user-maintained skill.
      // The portable app-data runtime is application-owned and must track the
      // bundled protocol across upgrades.
      if (runtime.projectDir || bundledSkillFilesMatch(sourceDir, path.dirname(skillPath))) {
        return { ok: true, created: false, updated: false, skillPath, runtimeDir: projectDir };
      }
      fs.cpSync(sourceDir, path.dirname(skillPath), {
        recursive: true,
        force: true,
        errorOnExist: false,
      });
      if (!fs.statSync(skillPath).isFile()) throw new Error('target SKILL.md missing after update');
      return { ok: true, created: false, updated: true, skillPath, runtimeDir: projectDir };
    } catch (error) {
      return {
        ok: false,
        created: false,
        skillPath,
        runtimeDir: projectDir,
        error: `无法更新 manage-project 技能：${String((error as Error)?.message || error)}`,
      };
    }
  }

  try {
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.cpSync(sourceDir, path.dirname(skillPath), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    if (!fs.statSync(skillPath).isFile()) throw new Error('target SKILL.md missing after copy');
    return { ok: true, created: true, skillPath, runtimeDir: projectDir };
  } catch (error) {
    return {
      ok: false,
      created: false,
      skillPath,
      runtimeDir: projectDir,
      error: `无法创建 manage-project 技能：${String((error as Error)?.message || error)}`,
    };
  }
}
