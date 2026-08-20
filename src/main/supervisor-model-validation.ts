import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { stripVTControlCharacters } from 'util';
import { resolveCodexHome } from './codex-context';
import { resolveGrokHome } from './grok-context';
import { parseToml, type TomlTable } from './toml-parser';

export type SupervisorModelValidationLauncher = 'pi' | 'codex' | 'kimi' | 'grok';

export interface SupervisorModelValidationRequest {
  launcher: SupervisorModelValidationLauncher;
  model: string;
  cwd?: string;
}

export type SupervisorModelValidationResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const VALIDATION_PROMPT = 'Reply with exactly WMUX_MODEL_OK. Do not use tools or modify files.';
const VALIDATION_TIMEOUT_MS = 120_000;
const MODEL_LIST_TIMEOUT_MS = 20_000;
const MODEL_ID_PATTERN = /^[a-z0-9._:/@+-]+$/i;

export type SupervisorModelListResult =
  | { ok: true; models: string[]; source: string; limited?: boolean }
  | { ok: false; error: string };

export function buildSupervisorModelValidationArgs(
  launcher: SupervisorModelValidationLauncher,
  model: string,
): string[] {
  const modelArgs = model.trim() ? ['--model', model.trim()] : [];
  if (launcher === 'pi') {
    return [
      ...modelArgs,
      '--print',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--system-prompt',
      VALIDATION_PROMPT,
      VALIDATION_PROMPT,
    ];
  }
  if (launcher === 'codex') {
    return [
      'exec',
      ...modelArgs,
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      VALIDATION_PROMPT,
    ];
  }
  if (launcher === 'kimi') {
    return [
      ...modelArgs,
      '--prompt',
      VALIDATION_PROMPT,
      '--output-format',
      'text',
    ];
  }
  return [
    ...modelArgs,
    '--single',
    VALIDATION_PROMPT,
    '--max-turns',
    '1',
    '--no-memory',
    '--no-subagents',
    '--disable-web-search',
    '--permission-mode',
    'plan',
    '--verbatim',
    '--output-format',
    'plain',
  ];
}

function executableCandidates(command: string): string[] {
  if (process.platform !== 'win32') return [command];
  return [`${command}.exe`, `${command}.com`, `${command}.ps1`, `${command}.cmd`, `${command}.bat`, command];
}

function resolveExecutable(command: string): string | null {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory.trim()) continue;
    for (const candidate of executableCandidates(command)) {
      const fullPath = path.join(directory.replace(/^"|"$/g, ''), candidate);
      try {
        if (fs.statSync(fullPath).isFile()) return fullPath;
      } catch {
        // Continue through PATH just like the shell would.
      }
    }
  }
  return null;
}

function validationCommand(
  launcher: SupervisorModelValidationLauncher,
  args: string[],
): { executable: string; args: string[] } | null {
  const executable = resolveExecutable(launcher);
  if (!executable) return null;
  if (process.platform === 'win32' && executable.toLocaleLowerCase().endsWith('.ps1')) {
    const powershell = resolveExecutable('pwsh')
      || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return {
      executable: powershell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args],
    };
  }
  if (/\.(?:cmd|bat)$/i.test(executable)) return null;
  return { executable, args };
}

interface SupervisorCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
}

function runSupervisorCommand(
  launcher: SupervisorModelValidationLauncher,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
): Promise<SupervisorCommandResult> {
  const invocation = validationCommand(launcher, args);
  if (!invocation) {
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: '',
      error: `未找到可安全执行的 ${launcher} 命令。`,
      timedOut: false,
    });
  }
  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile(invocation.executable, invocation.args, {
      cwd,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      clearTimeout(timeout);
      resolve({
        ok: !error,
        stdout,
        stderr,
        error: error?.message,
        timedOut,
      });
    });
    child.stdin?.end();
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
      } else {
        child.kill('SIGTERM');
      }
    }, timeoutMs);
  });
}

function uniqueValidModels(models: string[]): string[] {
  const seen = new Set<string>();
  return models.flatMap((raw) => {
    const model = raw.trim();
    const key = model.toLocaleLowerCase();
    if (!MODEL_ID_PATTERN.test(model) || seen.has(key)) return [];
    seen.add(key);
    return [model];
  }).sort((left, right) => left.localeCompare(right));
}

export function parsePiModelList(output: string): string[] {
  const models = stripVTControlCharacters(output).split(/\r?\n/).flatMap((line) => {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 6 || columns[0].toLocaleLowerCase() === 'provider') return [];
    if (!/^(?:yes|no)$/i.test(columns[4]) || !/^(?:yes|no)$/i.test(columns[5])) return [];
    return [`${columns[0]}/${columns[1]}`];
  });
  return uniqueValidModels(models);
}

export function parseKimiProviderModelList(output: string): string[] {
  try {
    const parsed = JSON.parse(output) as { models?: Record<string, unknown> };
    return uniqueValidModels(Object.keys(parsed.models || {}));
  } catch {
    return [];
  }
}

export function parseCodexModelCache(output: string): string[] {
  try {
    const parsed = JSON.parse(output) as { models?: Array<Record<string, unknown>> };
    return uniqueValidModels((parsed.models || []).flatMap((model) => {
      const id = model.id || model.slug || model.name;
      return typeof id === 'string' ? [id] : [];
    }));
  } catch {
    return [];
  }
}

export function parseGrokConfiguredModels(output: string): string[] {
  try {
    const parsed = parseToml(output);
    const models = parsed.models as TomlTable | undefined;
    if (!models || typeof models !== 'object' || Array.isArray(models)) return [];
    return uniqueValidModels(Object.entries(models).flatMap(([key, value]) => (
      typeof value === 'string' && !/(?:reasoning|effort)/i.test(key) ? [value] : []
    )));
  } catch {
    return [];
  }
}

export function conciseSupervisorModelValidationOutput(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[已隐藏标识]')
    .replace(/\b(?:sk|xai)-[a-z0-9_-]{12,}\b/gi, '[已隐藏凭据]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

export async function validateSupervisorModel(
  request: SupervisorModelValidationRequest,
): Promise<SupervisorModelValidationResult> {
  const model = typeof request.model === 'string' ? request.model.trim() : '';
  if (model.length > 200 || (model && !MODEL_ID_PATTERN.test(model))) {
    return { ok: false, error: '模型 ID 格式无效。' };
  }
  const cwd = request.cwd && path.isAbsolute(request.cwd) && fs.existsSync(request.cwd)
    ? request.cwd
    : undefined;
  const result = await runSupervisorCommand(
    request.launcher,
    buildSupervisorModelValidationArgs(request.launcher, model),
    cwd,
    VALIDATION_TIMEOUT_MS,
  );
  if (result.ok) {
    const detail = conciseSupervisorModelValidationOutput(result.stdout || result.stderr || '模型请求成功。');
    return { ok: true, message: detail || '模型请求成功。' };
  }
  const detail = conciseSupervisorModelValidationOutput(result.stderr || result.stdout || result.error || '');
  return {
    ok: false,
    error: result.timedOut ? '模型验证超时（120 秒）。' : detail || '模型请求失败。',
  };
}

export async function listSupervisorModels(
  request: Pick<SupervisorModelValidationRequest, 'launcher' | 'cwd'>,
): Promise<SupervisorModelListResult> {
  if (request.launcher === 'codex') {
    const cachePath = path.join(resolveCodexHome(), 'models_cache.json');
    if (!fs.existsSync(cachePath)) {
      return { ok: false, error: '未找到 Codex 本地模型缓存；请先启动一次 Codex。' };
    }
    try {
      if (fs.statSync(cachePath).size > 4 * 1024 * 1024) {
        return { ok: false, error: 'Codex 本地模型缓存异常过大，已停止读取。' };
      }
      const models = parseCodexModelCache(fs.readFileSync(cachePath, 'utf8'));
      return models.length > 0
        ? { ok: true, models, source: 'Codex 本地模型缓存' }
        : { ok: false, error: 'Codex 本地模型缓存中没有可用模型。' };
    } catch {
      return { ok: false, error: '无法读取 Codex 本地模型缓存。' };
    }
  }
  if (request.launcher === 'grok') {
    const configPath = path.join(resolveGrokHome(), 'config.toml');
    if (!fs.existsSync(configPath)) {
      return { ok: false, error: 'Grok CLI 不提供完整模型目录，且未找到本地模型配置。' };
    }
    try {
      if (fs.statSync(configPath).size > 1024 * 1024) {
        return { ok: false, error: 'Grok 本地配置异常过大，已停止读取。' };
      }
      const models = parseGrokConfiguredModels(fs.readFileSync(configPath, 'utf8'));
      return models.length > 0
        ? { ok: true, models, source: 'Grok 本地配置', limited: true }
        : { ok: false, error: 'Grok CLI 不提供完整模型目录，且本地配置中没有发现模型。' };
    } catch {
      return { ok: false, error: '无法读取 Grok 本地模型配置。' };
    }
  }

  const cwd = request.cwd && path.isAbsolute(request.cwd) && fs.existsSync(request.cwd)
    ? request.cwd
    : undefined;
  const args = request.launcher === 'pi'
    ? ['--list-models']
    : ['provider', 'list', '--json'];
  const result = await runSupervisorCommand(request.launcher, args, cwd, MODEL_LIST_TIMEOUT_MS);
  if (!result.ok) {
    const detail = conciseSupervisorModelValidationOutput(result.stderr || result.stdout || result.error || '');
    return { ok: false, error: result.timedOut ? '获取模型目录超时（20 秒）。' : detail || '无法获取模型目录。' };
  }
  const models = request.launcher === 'pi'
    ? parsePiModelList(result.stdout)
    : parseKimiProviderModelList(result.stdout);
  if (models.length === 0) return { ok: false, error: 'Agent 返回了空模型目录。' };
  return {
    ok: true,
    models,
    source: request.launcher === 'pi' ? 'Pi 模型目录' : 'Kimi provider 配置',
  };
}
