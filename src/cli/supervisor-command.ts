import fs from 'fs';
import path from 'path';
import {
  SUPERVISOR_COMPLETION_FILE_EXAMPLE,
  supervisorCompletionFileShapeError,
} from '../shared/supervisor-completion';

export const SUPERVISOR_DECIDE_USAGE = [
  'Usage: wmux supervisor decide --surface <id> [--review-id <id>] --outcome <continue|rework|complete|needs-human> [--task-file <.wmux/tmp/file> | --next <text> | --next-file <.wmux/tmp/file>] [--task-work-mode <single-thread|multi-thread>] [--reason <text>] [--stage-plan-file <.wmux/tmp/file>] [--completion-file <.wmux/tmp/file>] [--evidence-progress-file <.wmux/tmp/file>] [--context-health <healthy|degraded> --context-symptoms <instruction-drift,repeated-mistake,forgotten-plan,contradiction,no-progress,irrelevant-context> --context-signal <evidence>] [--progress-health <healthy|stalled> --stall-kind <offline-overanalysis|repeated-validation|missing-real-test|single-condition-fixation|constraint-dead-end|evidence-free-deliberation> --stall-signal <evidence> --wasted-effort <detail> --missing-evidence <detail> --decisive-next-step <detail> --authorization-boundary <within-current|requires-expansion> --experiment-conditions <a;b;c>] [--proposal-kind <route-adjustment|route-change|important|context-recovery|direction-needed|clarification>] [--escalation-boundary <contract-change|cross-item-coordination|external-blocker|user-only-information|high-risk-action|budget-exhausted>] [--impact <text>] [--alternatives <text>] [--permission-command <text> --permission-response <y|yes|allow|approve>] [--execution-action <text> --command <text> --error <text> --workspace-version <hash> --test-command <text> --test-result <text> --changed-files <a,b> --diff-summary <text> --evidence <text> --context-summary <text> --full-suite --retry --retry-kind <task-failure|command-correction|evidence-closure|runtime-recovery>] [--verbose]',
  '',
  'Completion file JSON (copy this schema; one object per stopWhen/validation condition):',
  JSON.stringify(SUPERVISOR_COMPLETION_FILE_EXAMPLE, null, 2),
  'Project completion requires non-empty project-relative evidenceRefs on every condition. Replace example refs with actual paths allowed by the current contract; the CLI reads and hashes those files before decide.',
  'remainingWork must be an array; use []. Only the JSON fields shown above are accepted.',
].join('\n');

const MAX_INLINE_NEXT_CHARS = 4_000;
const MAX_NEXT_FILE_CHARS = 64_000;

export interface SupervisorNextInput {
  text: string;
  fileReference?: string;
  cleanup?: () => void;
}

export interface SupervisorStagePlanInput {
  value?: Record<string, unknown>;
  fileReference?: string;
  cleanup?: () => void;
}

export type SupervisorCompletionInput = SupervisorStagePlanInput;
export type SupervisorEvidenceProgressInput = SupervisorStagePlanInput;
export type SupervisorTaskInput = SupervisorStagePlanInput;

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

/** Read a long decision body only from the current supervisor runtime's ignored temp directory. */
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
    throw new Error('--next-file temp directory cannot redirect outside the current supervisor runtime');
  }
  const relative = path.relative(realTempRoot, realFilePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('--next-file is restricted to the current supervisor runtime .wmux/tmp/ directory');
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

/** Read the supervisor-owned execution plan from the same isolated runtime boundary. */
export function resolveSupervisorStagePlanInput(
  args: string[],
  cwd = process.cwd(),
): SupervisorStagePlanInput {
  if (!args.includes('--stage-plan-file')) return {};
  const fileArgument = flagValue(args, '--stage-plan-file');
  if (!fileArgument) throw new Error('--stage-plan-file requires a JSON file under .wmux/tmp/');
  let input: SupervisorNextInput;
  try {
    input = resolveSupervisorNextInput(
      ['decide', '--next-file', fileArgument],
      cwd,
    );
  } catch (error) {
    throw new Error(
      String((error as Error)?.message || error).replaceAll('--next-file', '--stage-plan-file'),
      { cause: error },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(input.text);
  } catch {
    throw new Error('--stage-plan-file must contain valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('--stage-plan-file must contain one JSON object');
  }
  return {
    value: value as Record<string, unknown>,
    fileReference: input.fileReference,
    cleanup: input.cleanup,
  };
}

export function cleanupSupervisorStagePlanInput(
  input: SupervisorStagePlanInput,
  decisionSucceeded: boolean,
): void {
  if (decisionSucceeded) input.cleanup?.();
}

/** Read one structured result-oriented task assignment from either supervision mode. */
export function resolveSupervisorTaskInput(
  args: string[],
  cwd = process.cwd(),
): SupervisorTaskInput {
  if (!args.includes('--task-file')) return {};
  if (args.includes('--next') || args.includes('--next-file')) {
    throw new Error('--task-file cannot be combined with --next or --next-file');
  }
  const fileArgument = flagValue(args, '--task-file');
  if (!fileArgument) throw new Error('--task-file requires a JSON file under .wmux/tmp/');
  let input: SupervisorNextInput;
  try {
    input = resolveSupervisorNextInput(['decide', '--next-file', fileArgument], cwd);
  } catch (error) {
    throw new Error(
      String((error as Error)?.message || error).replaceAll('--next-file', '--task-file'),
      { cause: error },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(input.text);
  } catch {
    throw new Error('--task-file must contain valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('--task-file must contain one JSON object');
  }
  return {
    value: value as Record<string, unknown>,
    fileReference: input.fileReference,
    cleanup: input.cleanup,
  };
}

export function cleanupSupervisorTaskInput(
  input: SupervisorTaskInput,
  decisionSucceeded: boolean,
): void {
  if (decisionSucceeded) input.cleanup?.();
}

/** Read per-condition completion judgments from the ignored supervisor-runtime temp boundary. */
export function resolveSupervisorCompletionInput(
  args: string[],
  cwd = process.cwd(),
): SupervisorCompletionInput {
  if (!args.includes('--completion-file')) return {};
  const fileArgument = flagValue(args, '--completion-file');
  if (!fileArgument) throw new Error('--completion-file requires a JSON file under .wmux/tmp/');
  let input: SupervisorNextInput;
  try {
    input = resolveSupervisorNextInput(['decide', '--next-file', fileArgument], cwd);
  } catch (error) {
    throw new Error(
      String((error as Error)?.message || error).replaceAll('--next-file', '--completion-file'),
      { cause: error },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(input.text);
  } catch {
    throw new Error('--completion-file must contain valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('--completion-file must contain one JSON object');
  }
  const shapeError = supervisorCompletionFileShapeError(value);
  if (shapeError) throw new Error(shapeError);
  return {
    value: value as Record<string, unknown>,
    fileReference: input.fileReference,
    cleanup: input.cleanup,
  };
}

export function cleanupSupervisorCompletionInput(
  input: SupervisorCompletionInput,
  decisionSucceeded: boolean,
): void {
  if (decisionSucceeded) input.cleanup?.();
}

/** Read a content-addressed evidence-review declaration from the isolated supervisor-runtime boundary. */
export function resolveSupervisorEvidenceProgressInput(
  args: string[],
  cwd = process.cwd(),
): SupervisorEvidenceProgressInput {
  if (!args.includes('--evidence-progress-file')) return {};
  const fileArgument = flagValue(args, '--evidence-progress-file');
  if (!fileArgument) throw new Error('--evidence-progress-file requires a JSON file under .wmux/tmp/');
  let input: SupervisorNextInput;
  try {
    input = resolveSupervisorNextInput(['decide', '--next-file', fileArgument], cwd);
  } catch (error) {
    throw new Error(
      String((error as Error)?.message || error).replaceAll('--next-file', '--evidence-progress-file'),
      { cause: error },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(input.text);
  } catch {
    throw new Error('--evidence-progress-file must contain valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('--evidence-progress-file must contain one JSON object');
  }
  const declaration = value as Record<string, unknown>;
  const refs = Array.isArray(declaration.evidenceRefs)
    ? declaration.evidenceRefs.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  const conclusion = String(declaration.conclusion || '').trim();
  if (refs.length === 0) {
    throw new Error('--evidence-progress-file requires a non-empty evidenceRefs array');
  }
  if (!['confirmed-success', 'confirmed-not-executed', 'inconclusive'].includes(conclusion)) {
    throw new Error('--evidence-progress-file conclusion must be confirmed-success, confirmed-not-executed, or inconclusive');
  }
  return {
    value: { evidenceRefs: refs, conclusion },
    fileReference: input.fileReference,
    cleanup: input.cleanup,
  };
}

export function cleanupSupervisorEvidenceProgressInput(
  input: SupervisorEvidenceProgressInput,
  decisionSucceeded: boolean,
): void {
  if (decisionSucceeded) input.cleanup?.();
}

export function isSupervisorDecideHelp(args: string[]): boolean {
  return args[1] === 'decide' && (args.includes('--help') || args.includes('-h'));
}
