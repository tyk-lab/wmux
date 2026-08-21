import { createHash } from 'node:crypto';

const MAX_TEXT = 800;

function compact(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

export interface ParsedWmuxHookPayload {
  file: string;
  message: string;
  task: string;
  command: string;
  cwd: string;
  sessionId: string;
  turnId: string;
}

/** Parse snake_case, camelCase and Pi's wmux-prefixed lifecycle payloads. */
export function parseWmuxHookPayload(stdinData: string): ParsedWmuxHookPayload {
  let data: Record<string, any> = {};
  try {
    data = record(stdinData.trim() ? JSON.parse(stdinData) : {});
  } catch {
    // An empty/invalid native payload is valid for lifecycle-only events.
  }
  const toolInput = record(data.tool_input || data.toolInput || data.input);
  const nestedInput = record(data.input);
  return {
    file: compact(toolInput.file_path || toolInput.filePath || toolInput.path),
    message: compact(data.message || toolInput.description),
    task: compact(data.prompt || data.user_prompt || data.userPrompt || nestedInput.prompt),
    command: compact(toolInput.command || nestedInput.command),
    cwd: compact(data.cwd || data.working_directory || data.workingDirectory),
    sessionId: compact(data.wmux_session_id || data.session_id || data.sessionId),
    turnId: compact(
      data.wmux_turn_id || data.turn_id || data.turnId || data.prompt_id || data.promptId,
    ),
  };
}

const TURN_BOUNDARY_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'Interrupt']);

/** Stable boundary ID suppresses duplicate start/end Hooks for one native turn. */
export function stableWmuxHookId(options: {
  event: string;
  agent: string;
  surfaceId: string;
  sessionId: string;
  turnId: string;
}): string | undefined {
  if (!TURN_BOUNDARY_EVENTS.has(options.event) || !options.turnId) return undefined;
  const boundary = options.event === 'UserPromptSubmit' ? 'TurnStart' : 'TurnEnd';
  const digest = createHash('sha256')
    .update([
      options.agent,
      options.surfaceId,
      options.sessionId,
      options.turnId,
      boundary,
    ].join('\0'))
    .digest('hex');
  return `turn-${digest}`;
}
