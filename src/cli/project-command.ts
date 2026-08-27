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
    '  "preconditions": [],',
    '  "supervisorNotes": ["optional supervisor constraint"],',
    '  "doneWhen": ["verifiable completion criterion"],',
    '  "userAcceptancePolicy": "always|on-gap|not-required",',
    '  "verificationPolicies": [{"criterion":"exact doneWhen text","requirement":"required|best-effort|not-applicable","riskClass":"protected|standard","reason":"optional"}],',
    '  "reason": "why the project definition changed"',
    '}',
    '',
    '`refine` keeps the current final result; `pivot` creates a new main-goal revision and should explicitly provide the new goal, preconditions, and doneWhen.',
    'Omitted policies default to on-gap plus required. A runtime policy change creates a new requirements version, pauses old execution, and requires impact review/rebinding before resume.',
    'Legacy and unspecified riskClass values default to protected. best-effort/not-applicable require explicit riskClass=standard, still require honest evidence records, and cannot cover known failures or protected criteria.',
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
    '',
    'Recovery-safe form: write that object to .wmux/tmp/orientation-<requestedAt>.json, then run:',
    'wmux project orientation-confirm --project <id> --json-file .wmux/tmp/orientation-<requestedAt>.json',
    'Do not pass JSON as a positional argument. `project inspect` is read-only and cannot satisfy the orientation gate.',
  ].join('\n'),
  'goal-plan': [
    'Usage: wmux project goal-plan --project <id> (--json <object> | --json-file <.wmux/tmp/file>)',
    '',
    'JSON object (normally 3-7 subgoals; every active goal criterion must be covered exactly once):',
    '{"reason":"...","subgoals":[{"id":"stage-1","title":"...","outcome":"...","acceptance":["..."],"dependencies":[],"status":"planned"}]}',
    'Stage status values are planned, active, blocked, achieved, or obsolete. After completed work items cover a stage, resubmit that stage as achieved; never use completed or delete dependencies to bypass closure.',
  ].join('\n'),
  'task-create': [
    'Usage: wmux project task-create --project <id> (--json <object> | --json-file <.wmux/tmp/file>)',
    '',
    'JSON must include a project-AI complexity assessment made before dispatch:',
    '{"id":"task-a","title":"用户可识别成果","subgoalId":"stage-1","taskWorkMode":"single-thread|multi-thread","complexityAssessment":{"complexity":"low|medium|high","decision":"single-task|split-before-dispatch","signals":["..."],"rationale":"..."},"contract":{"objective":"...","stopWhen":["..."],"validation":["..."],"stageAcceptanceCoverage":[{"stageCriterion":"<stage acceptance exact text>","verificationCriterion":"<stopWhen or validation exact text>"}]}}',
    '',
    '`split-before-dispatch` is a planning result, not an executable task; create focused child work items instead. `taskWorkMode` controls the unique task AI internal execution mode. stageAcceptanceCoverage is an explicit canonical mapping; wording similarity is never inferred.',
  ].join('\n'),
  'task-update': [
    'Usage: wmux project task-update --project <id> (--json <object> | --json-file <.wmux/tmp/file>)',
    '',
    'JSON object (partial update; omitted fields keep their current values):',
    '{"workItemId":"task-a","status":"planned","contract":{"objective":"updated outcome","stageAcceptanceCoverage":[{"stageCriterion":"<stage acceptance exact text>","verificationCriterion":"<existing work-item criterion exact text>"}]},"latestContextSummary":"...","latestEvidence":"...","latestBlocker":"..."}',
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
    'Clarification JSON: {"category":"clarification","decisionKey":"requirements-confirmation","decisionScope":"用户可见的同类决定含义边界","question":"是否确认按 GUI 版本推进？","context":"完成定义见推荐方案。","options":[{"id":"confirm-requirements","label":"确认需求","description":"完成标准：GUI 可运行；数据可保存并重新加载。","confirmationScope":["doneWhen: GUI 可运行；数据可保存并重新加载"]},{"id":"revise-requirements","label":"补充调整","description":"继续补充目标、范围或验收。","confirmationScope":[]}],"recommendedOptionId":"confirm-requirements"}',
    'Reusable decisions require the same stable decisionKey and user-visible decisionScope. Planning changes must put exact canonical field:value entries in each authorizing option confirmationScope; every value must be visible in that option. Later submit the matching userConfirmationEventId.',
    'Manual-intervention JSON additionally requires workItemId, blocker, and reasonCode.',
    'Valid reasonCode values: physical-action, credentials, access-grant, business-choice, destructive-action, production-action, task-input-conflict, verification-limited, runtime-recovery. final-acceptance is reserved for a control-layer generated final-effect question and cannot be submitted directly.',
  ].join('\n'),
  'complete': [
    'Usage: wmux project complete --project <id> (--json <object> | --json-file <.wmux/tmp/file>)',
    '',
    'Normal JSON: {"summary":"...","evidence":"...","criteria":[...]}',
    'If the control layer asks whether to accept the current final effect, answer that question first, then submit: {"userAcceptanceEventId":"pm-event-..."}. This may close validation-only gaps, but never known failures, unfinished implementation, or safety issues.',
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
  'transition-ack': [
    'Usage: wmux project transition-ack --project <id> --transition <transition-id> --resolution <continued|accepted|replanned|paused|escalated|recovered> --summary <result>',
    '',
    '`replanned` requires a material planning update and is allowed only once for the same work item evidence/topology state. Rewording the same task is not a new route.',
    'If the same no-progress handoff returns, pause, advance a genuinely independent work item, or escalate a real user-controlled prerequisite.',
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
  if (!text) {
    const command = args[1] || '<command>';
    throw new Error(
      `project ${command} requires --json <object> or --json-file <.wmux/tmp/file>; positional JSON is not accepted. `
      + `Run "wmux project ${command} --help" and retry the same command; read-only project inspect cannot substitute for a rejected mutation.`,
    );
  }
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
