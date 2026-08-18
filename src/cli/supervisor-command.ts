import fs from 'fs';
import path from 'path';

export const SUPERVISOR_DECIDE_USAGE = 'Usage: wmux supervisor decide --surface <id> --outcome <continue|rework|complete|needs-human> [--reason <text>] [--next <text> | --next-file <.wmux/tmp/file>] [--proposal-kind <route-adjustment|route-change|important|context-recovery|direction-needed>] [--impact <text>] [--alternatives <text>] [--permission-command <text> --permission-response <y|yes|allow|approve>] [--execution-action <text> --command <text> --error <text> --workspace-version <hash> --test-command <text> --test-result <text> --changed-files <a,b> --evidence <text> --full-suite --retry] [--verbose]';

const MAX_INLINE_NEXT_CHARS = 4_000;
const MAX_NEXT_FILE_CHARS = 64_000;

export interface SupervisorNextInput {
  text: string;
  fileReference?: string;
  cleanup?: () => void;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

/** Read a long decision body only from the current project's ignored wmux temp directory. */
export function resolveSupervisorNextInput(args: string[], cwd = process.cwd()): SupervisorNextInput {
  const inline = flagValue(args, '--next') || '';
  const fileArgument = flagValue(args, '--next-file');
  if (args.includes('--next') && args.includes('--next-file')) {
    throw new Error('--next and --next-file cannot be used together');
  }
  if (!args.includes('--next-file')) {
    if (inline.length > MAX_INLINE_NEXT_CHARS) {
      throw new Error(`--next cannot exceed ${MAX_INLINE_NEXT_CHARS} characters; use --next-file`);
    }
    return { text: inline };
  }
  if (!fileArgument) throw new Error('--next-file requires a file under .wmux/tmp/');

  const tempRoot = path.resolve(cwd, '.wmux', 'tmp');
  const requestedPath = path.resolve(cwd, fileArgument);
  let realCwd: string;
  let realTempRoot: string;
  let realFilePath: string;
  try {
    realCwd = fs.realpathSync(cwd);
    realTempRoot = fs.realpathSync(tempRoot);
    realFilePath = fs.realpathSync(requestedPath);
  } catch {
    throw new Error('--next-file must reference an existing file under .wmux/tmp/');
  }
  if (path.relative(realCwd, realTempRoot).toLowerCase() !== path.join('.wmux', 'tmp').toLowerCase()) {
    throw new Error('--next-file temp directory cannot redirect outside the current project');
  }
  const relative = path.relative(realTempRoot, realFilePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('--next-file is restricted to the current project .wmux/tmp/ directory');
  }
  if (!fs.statSync(realFilePath).isFile()) throw new Error('--next-file must reference a regular file');

  const text = fs.readFileSync(realFilePath, 'utf8').trim();
  if (!text) throw new Error('--next-file cannot be empty');
  if (text.length > MAX_NEXT_FILE_CHARS) {
    throw new Error(`--next-file cannot exceed ${MAX_NEXT_FILE_CHARS} characters`);
  }
  return {
    text,
    fileReference: path.relative(realCwd, realFilePath).replace(/\\/g, '/'),
    cleanup: () => {
      try {
        fs.unlinkSync(realFilePath);
      } catch {
        // Delivery has already succeeded. A cleanup failure must not make the
        // supervisor retry the same decision; the ignored temp file can remain.
      }
    },
  };
}

export function cleanupSupervisorNextInput(input: SupervisorNextInput, decisionSucceeded: boolean): void {
  if (decisionSucceeded) input.cleanup?.();
}

export function isSupervisorDecideHelp(args: string[]): boolean {
  return args[1] === 'decide' && (args.includes('--help') || args.includes('-h'));
}
