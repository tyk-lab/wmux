import fs from 'fs';
import path from 'path';

export interface ProjectJsonInput {
  value: Record<string, unknown>;
  sourceFile?: string;
}

const PROJECT_COMMANDS = [
  'update', 'alignment-confirm', 'orientation-confirm', 'goal-plan', 'status', 'logs', 'terminals',
  'task-create', 'task-update', 'record', 'dispatch', 'auxiliary-dispatch', 'auxiliary-status', 'progress-sync',
  'transition-ack',
  'inspect', 'ask', 'pause', 'resume', 'pause-all', 'resume-all', 'complete', 'stop', 'reply',
] as const;

export const PROJECT_USAGE = [
  `Usage: wmux project <${PROJECT_COMMANDS.join('|')}> [options]`,
  '',
  'Common options:',
  '  --project <id>                 Select a project (required when multiple projects exist)',
  '  --help, -h                     Show project or subcommand help without executing it',
  '',
  'Structured commands accept exactly one of:',
  '  --json <object>                Inline JSON object',
  '  --json-file <.wmux/tmp/file>   UTF-8 JSON file under the managed project .wmux/tmp directory',
  '',
  'Planning supplements must include userConfirmationEventId plus supplements (goal-plan) or planningSupplements (task create/update).',
  'Run `wmux project <command> --help` for command-specific input examples.',
].join('\n');

const PROJECT_COMMAND_HELP: Partial<Record<(typeof PROJECT_COMMANDS)[number], string>> = {
  update: [
    'Usage: wmux project update --project <id> (--json <object> | --json-file <.wmux/tmp/file>)',
    '',
    'JSON object (partial update; omitted fields keep their current values):',
    '{',
    '  "mode": "refine|pivot",',
    '  "goal": "optional updated main goal",',
    '  "preconditions": ["无额外物理前置条件"],',
    '  "supervisorNotes": ["optional supervisor constraint"],',
    '  "doneWhen": ["verifiable completion criterion"],',
    '  "reason": "why the project definition changed"',
    '}',
    '',
    '`refine` keeps the current final result; `pivot` creates a new main-goal revision and should explicitly provide the new goal, preconditions, and doneWhen.',
  ].join('\n'),
  'alignment-confirm': [
    'Usage: wmux project alignment-confirm --project <id> (--json <object> | --json-file <.wmux/tmp/file>)',
    '',
    'JSON object (userConfirmationEventId must reference the latest structured user confirmation):',
    '{"userConfirmationEventId":"pm-event-...","goalUnderstanding":"...","scopeSummary":"...","acceptanceSummary":"...","reason":"..."}',
  ].join('\n'),
  'orientation-confirm': [
    'Usage: wmux project orientation-confirm --project <id> (--json <object> | --json-file <.wmux/tmp/file>)',
    '',
    'Copy all binding fields from `wmux project status`; do not guess them:',
    '{"requirementsVersion":1,"authorizationVersion":1,"snapshotFingerprint":"...","requestedAt":123,"summary":"...","knownFacts":["..."],"unknowns":[],"workItems":[]}',
  ].join('\n'),
  'goal-plan': [
    'Usage: wmux project goal-plan --project <id> (--json <object> | --json-file <.wmux/tmp/file>)',
    '',
    'JSON object (normally 3-7 subgoals; every active goal criterion must be covered exactly once):',
    '{"reason":"...","subgoals":[{"id":"stage-1","title":"...","outcome":"...","acceptance":["..."],"dependencies":[],"status":"planned"}]}',
  ].join('\n'),
  'task-create': [
    'Usage: wmux project task-create --project <id> (--json <object> | --json-file <.wmux/tmp/file>)',
    '',
    'JSON must include a project-AI complexity assessment made before dispatch:',
    '{"id":"task-a","subgoalId":"stage-1","taskWorkMode":"single-thread|multi-thread","complexityAssessment":{"complexity":"low|medium|high","decision":"single-task|split-before-dispatch","signals":["..."],"rationale":"..."},"contract":{"objective":"...","stopWhen":["..."],"validation":["..."]}}',
    '',
    '`split-before-dispatch` is a planning result, not an executable task; create focused child work items instead. `taskWorkMode` controls the unique task AI internal execution mode.',
  ].join('\n'),
  'task-update': [
    'Usage: wmux project task-update --project <id> (--json <object> | --json-file <.wmux/tmp/file>)',
    '',
    'JSON object (partial update; omitted fields keep their current values):',
    '{"workItemId":"task-a","status":"planned","contract":{"objective":"updated outcome"},"latestContextSummary":"...","latestEvidence":"...","latestBlocker":"..."}',
    '`running` and `validating` are supervisor-owned execution states. Replanned work should use `planned`, then `dispatch`.',
  ].join('\n'),
  dispatch: [
    'Usage: wmux project dispatch --project <id> --task <work-item-id>',
    '',
    'Assigns or reassigns one eligible work item to the dedicated supervisor. Eligible states are planned, waiting-dependencies, waiting-decision, paused, or failed after dependencies are satisfied.',
    'The project AI cannot write the task terminal; only the bound supervisor may send the neutral outcome package.',
  ].join('\n'),
  ask: [
    'Usage: wmux project ask --project <id> (--json <object> | --json-file <.wmux/tmp/file>)',
    '',
    'Clarification JSON: {"category":"clarification","decisionKey":"requirements-confirmation","decisionScope":"用户可见的同类决定含义边界","confirmationScope":["goal: 精确目标或其他将落盘的规划变更"],"question":"...","context":"...","options":[{"id":"confirm-requirements","label":"确认需求","description":"..."},{"id":"revise-requirements","label":"补充调整","description":"..."}],"recommendedOptionId":"confirm-requirements"}',
    'Reusable decisions require the same stable decisionKey and user-visible decisionScope. Planning changes must list their exact canonical confirmationScope and later submit the matching userConfirmationEventId.',
    'Manual-intervention JSON additionally requires workItemId, blocker, and reasonCode.',
    'Valid reasonCode values: physical-action, credentials, access-grant, business-choice, destructive-action, production-action, internal-project-failure.',
  ].join('\n'),
  'auxiliary-dispatch': [
    'Usage: wmux project auxiliary-dispatch --project <id> (--json <object> | --json-file <.wmux/tmp/file>)',
    '',
    'JSON: {"kind":"research|documentation|progress|git-commit","task":"...","allowedPaths":["docs/file.md"]}',
    '`research` must remain read-only. Other kinds require explicit allowedPaths. `git-commit` also requires user authorization in project Agent settings.',
  ].join('\n'),
  'auxiliary-status': [
    'Usage: wmux project auxiliary-status --project <id>',
  ].join('\n'),
};

const JSON_PROJECT_COMMANDS = new Set<string>([
  'update', 'alignment-confirm', 'orientation-confirm', 'goal-plan', 'auxiliary-dispatch',
  'task-create', 'task-update', 'record', 'ask', 'complete',
]);

export function resolveProjectCommandHelp(args: readonly string[]): string | undefined {
  if (!args.includes('--help') && !args.includes('-h')) return undefined;
  const subcommand = args[1];
  if (!subcommand || subcommand === '--help' || subcommand === '-h') return PROJECT_USAGE;
  const specific = PROJECT_COMMAND_HELP[subcommand as keyof typeof PROJECT_COMMAND_HELP];
  if (specific) return specific;
  if (JSON_PROJECT_COMMANDS.has(subcommand)) {
    return [
      `Usage: wmux project ${subcommand} --project <id> (--json <object> | --json-file <.wmux/tmp/file>)`,
      '',
      'This command requires a JSON object. Use `wmux context` for the current project-bound capability and schema.',
    ].join('\n');
  }
  if ((PROJECT_COMMANDS as readonly string[]).includes(subcommand)) {
    return `Usage: wmux project ${subcommand} [--project <id>] [options]`;
  }
  return PROJECT_USAGE;
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

const EMPTY_CHANGED_FILE_MARKERS = new Set([
  'none',
  'no change',
  'no changes',
  '无',
  '无变更',
  '没有变更',
]);

/** Normalize the optional CLI report without treating a prose empty marker as a project path. */
export function normalizeSupervisorChangedFiles(value: string): string[] {
  return [...new Set(value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && !EMPTY_CHANGED_FILE_MARKERS.has(item.toLocaleLowerCase('en-US'))))];
}
