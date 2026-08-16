import fs from 'fs';
import path from 'path';
import {
  PROJECT_MANAGER_TERMINAL_CWD,
  projectManagerSkillRelativePath,
  type ProjectManagerRuntimeAgent,
} from '../shared/project-manager-terminal';

interface ProjectManagerSkillRuntime {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  projectDir?: string;
}

export interface ProjectManagerSkillResult {
  ok: boolean;
  created: boolean;
  skillPath: string;
  error?: string;
}

function bundledSkillDirectory(runtime: ProjectManagerSkillRuntime): string {
  const root = runtime.isPackaged
    ? runtime.resourcesPath
    : path.join(runtime.appPath, 'resources');
  return path.join(root, 'skills', 'manage-project');
}

export function ensureProjectManagerSkill(
  runtime: ProjectManagerSkillRuntime,
  agent: ProjectManagerRuntimeAgent = 'codex',
): ProjectManagerSkillResult {
  const projectDir = runtime.projectDir || PROJECT_MANAGER_TERMINAL_CWD;
  const skillPath = path.join(projectDir, projectManagerSkillRelativePath(agent));
  try {
    if (!fs.statSync(projectDir).isDirectory()) {
      return { ok: false, created: false, skillPath, error: `项目管理终端目录不存在：${projectDir}` };
    }
  } catch {
    return { ok: false, created: false, skillPath, error: `项目管理终端目录不存在：${projectDir}` };
  }

  try {
    if (fs.statSync(skillPath).isFile()) return { ok: true, created: false, skillPath };
  } catch { /* Missing or incomplete target skill: restore it from bundled resources. */ }

  const sourceDir = bundledSkillDirectory(runtime);
  const sourceSkillPath = path.join(sourceDir, 'SKILL.md');
  try {
    if (!fs.statSync(sourceSkillPath).isFile()) throw new Error('bundled SKILL.md missing');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.cpSync(sourceDir, path.dirname(skillPath), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    if (!fs.statSync(skillPath).isFile()) throw new Error('target SKILL.md missing after copy');
    return { ok: true, created: true, skillPath };
  } catch (error) {
    return {
      ok: false,
      created: false,
      skillPath,
      error: `无法创建 manage-project 技能：${String((error as Error)?.message || error)}`,
    };
  }
}
