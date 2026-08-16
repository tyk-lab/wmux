import fs from 'fs';
import path from 'path';

export interface ProjectJsonInput {
  value: Record<string, unknown>;
  sourceFile?: string;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function resolveProjectJsonInput(args: string[], cwd = process.cwd()): ProjectJsonInput {
  const inline = flagValue(args, '--json');
  const fileArgument = flagValue(args, '--json-file');
  if (inline && fileArgument) throw new Error('use exactly one of --json or --json-file');
  let text = inline;
  let sourceFile: string | undefined;
  if (fileArgument) {
    const requested = path.resolve(cwd, fileArgument);
    const configuredTempRoot = path.resolve(cwd, '.wmux', 'tmp');
    const lexicalRelative = path.relative(configuredTempRoot, requested);
    if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
      throw new Error('--json-file is restricted to the current project .wmux/tmp/ directory');
    }
    if (!fs.existsSync(configuredTempRoot) || !fs.statSync(configuredTempRoot).isDirectory()) {
      throw new Error('project JSON draft directory .wmux/tmp does not exist');
    }
    if (!fs.existsSync(requested)) throw new Error('project JSON draft file does not exist');
    const tempRoot = fs.realpathSync(configuredTempRoot);
    sourceFile = fs.realpathSync(requested);
    const relative = path.relative(tempRoot, sourceFile);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('--json-file is restricted to the current project .wmux/tmp/ directory');
    }
    if (!fs.statSync(sourceFile).isFile()) throw new Error('--json-file must reference a regular file');
    text = fs.readFileSync(sourceFile, 'utf8');
  }
  if (!text) throw new Error('--json or --json-file is required');
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('project JSON must be an object');
  }
  return { value: parsed as Record<string, unknown>, sourceFile };
}

export function cleanupProjectJsonInput(input: ProjectJsonInput, success: boolean): void {
  if (!success || !input.sourceFile) return;
  try { fs.unlinkSync(input.sourceFile); } catch { /* A consumed temp draft is best-effort cleanup. */ }
}
