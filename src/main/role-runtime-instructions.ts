import fs from 'fs';
import path from 'path';
import { getAppDataDir } from '../shared/instance';

export type ManagedRoleInstruction = 'project-ai' | 'supervisor-ai';

export interface RoleInstructionRuntime {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  appDataDir?: string;
}

export interface RoleInstructionResult {
  ok: boolean;
  created: boolean;
  updated: boolean;
  agentsPath: string;
  runtimeDir: string;
  error?: string;
}

const LEGACY_PROJECT_MANAGER_SKILL_DIRECTORIES = [
  ['.agents', 'skills', 'manage-project'],
  ['.grok', 'skills', 'manage-project'],
  ['.wmux', 'project-manager', 'manage-project'],
] as const;

export function projectManagerRuntimeDirectory(appDataDir = getAppDataDir()): string {
  return path.join(appDataDir, 'project-manager', 'runtime');
}

function bundledAgentsPath(runtime: RoleInstructionRuntime, role: ManagedRoleInstruction): string {
  const resourcesRoot = runtime.isPackaged
    ? runtime.resourcesPath
    : path.join(runtime.appPath, 'resources');
  return path.join(resourcesRoot, 'agents', role, 'ROLE_AGENTS.md');
}

function removeLegacyProjectManagerSkills(runtimeDir: string): string | undefined {
  try {
    for (const segments of LEGACY_PROJECT_MANAGER_SKILL_DIRECTORIES) {
      fs.rmSync(path.join(runtimeDir, ...segments), { recursive: true, force: true });
    }
    return undefined;
  } catch (error) {
    return String((error as Error)?.message || error);
  }
}

export function ensureRoleRuntimeInstructions(
  runtime: RoleInstructionRuntime,
  role: ManagedRoleInstruction,
  runtimeDir: string,
): RoleInstructionResult {
  const agentsPath = path.join(runtimeDir, 'AGENTS.md');
  const sourcePath = bundledAgentsPath(runtime, role);
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    if (!fs.statSync(runtimeDir).isDirectory()) throw new Error('runtime directory is not a directory');
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error('bundled AGENTS.md missing');
    }
  } catch (error) {
    return {
      ok: false,
      created: false,
      updated: false,
      agentsPath,
      runtimeDir,
      error: `无法准备 ${role} 角色协议：${String((error as Error)?.message || error)}`,
    };
  }

  let current: Buffer | undefined;
  try {
    current = fs.readFileSync(agentsPath);
  } catch { /* Missing target: install it below. */ }

  try {
    const source = fs.readFileSync(sourcePath);
    if (current?.equals(source)) {
      return { ok: true, created: false, updated: false, agentsPath, runtimeDir };
    }
    fs.copyFileSync(sourcePath, agentsPath);
    return {
      ok: true,
      created: !current,
      updated: !!current,
      agentsPath,
      runtimeDir,
    };
  } catch (error) {
    return {
      ok: false,
      created: false,
      updated: false,
      agentsPath,
      runtimeDir,
      error: `无法更新 ${role} 角色协议：${String((error as Error)?.message || error)}`,
    };
  }
}

export function ensureProjectManagerRuntimeInstructions(
  runtime: RoleInstructionRuntime,
): RoleInstructionResult {
  const runtimeDir = projectManagerRuntimeDirectory(runtime.appDataDir);
  const legacyCleanupError = removeLegacyProjectManagerSkills(runtimeDir);
  if (legacyCleanupError) {
    return {
      ok: false,
      created: false,
      updated: false,
      agentsPath: path.join(runtimeDir, 'AGENTS.md'),
      runtimeDir,
      error: `无法清理旧项目 AI 兼容技能：${legacyCleanupError}`,
    };
  }
  return ensureRoleRuntimeInstructions(
    runtime,
    'project-ai',
    runtimeDir,
  );
}
