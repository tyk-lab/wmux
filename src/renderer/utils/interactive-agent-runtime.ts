import type { AutomatedInteractiveAgent } from './interactive-agent-launch';

const ANSI_ESCAPE = new RegExp(
  String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`,
  'gu',
);
const CODEX_EXIT_FOOTER = /Token usage:[\s\S]{0,2000}To continue this session,\s*run\s+codex resume\s+[0-9a-f-]{20,}/iu;
const INTERACTIVE_AGENT_SCREEN_PATTERNS = [
  /\bOpenAI Codex\b/iu,
  /(?:^|\n)\s*gpt-[\w.-]+\b[\s\S]{0,1200}(?:directory:|permissions:|Ask Codex)/iu,
  /\bAsk Codex to do anything\b[\s\S]{0,1200}(?:^|\n)\s*gpt-[\w.-]+\b/imu,
  /(?:^|\n)\s*gpt-[\w.-]+\s+(?:low|medium|high|xhigh|max|ultra)\s+·[^\n]*$/imu,
  /No session yet[\s\S]{0,2000}first message/iu,
  /(?:^|\n)\s*(?:auto\b.*\bK\d|yolo\b|\/compact\b|context:\s*\d|K\d+-\d+k\b)/iu,
  /\(kimi-coding\).*\bkimi-for-coding\b/iu,
  /\bHelp improve Grok\b/iu,
  /\bGrok Build\b[\s\S]{0,2000}(?:New worktree|Resume session|always-approve|Ctrl\+O)/iu,
  /\b(?:Pi Agent|OpenCode)\b/iu,
  /(?:^|\n)\s*pi\s+v\d+(?:\.\d+){1,3}\b[\s\S]{0,2000}(?:clear\/exit|Pi can explain|commands\b)/iu,
] as const;

function plainTerminalOutput(output: string): string {
  return output.replace(ANSI_ESCAPE, '').replace(/\r/gu, '');
}

function lastNonEmptyTerminalLine(output: string): string {
  return plainTerminalOutput(output)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .at(-1) || '';
}

const STARTUP_FAILURE_PATTERNS = [
  /(?:^|\n)\s*error:\s*(?:unknown|unrecognized)\s+(?:option|argument)\b[^\n]*/iu,
  /(?:^|\n)\s*error:\s*unexpected argument\b[^\n]*/iu,
  /(?:^|\n)\s*(?:unknown|unrecognized)\s+(?:option|argument)\b[^\n]*/iu,
  /(?:^|\n)\s*ParserError:\s*[^\n]*/iu,
  /(?:^|\n)\s*Error:\s*Failed to start a session:\s*[^\n]*/iu,
  /(?:^|\n)\s*[^\n]*\bis not recognized as (?:the name of a cmdlet|an internal or external command)\b[^\n]*/iu,
  /(?:^|\n)\s*[^\n]*\bcommand not found\b[^\n]*/iu,
  /(?:^|\n)\s*(?:Error:\s*)?Cannot find module\b[^\n]*/iu,
] as const;

/** Detect an explicit launcher/outer-shell failure before any Agent becomes ready. */
export function interactiveAgentStartupFailureDetail(output: string): string | null {
  const plain = plainTerminalOutput(output);
  if (/(?:^|\n)\s*Bye!\s*(?=\n|$)/iu.test(plain)) {
    return 'Agent 启动失败：目录信任未获确认，Agent 已退出';
  }
  for (const pattern of STARTUP_FAILURE_PATTERNS) {
    const match = pattern.exec(plain)?.[0]?.trim();
    if (match) return `Agent 启动失败：${match.replace(/\s+/gu, ' ').slice(0, 500)}`;
  }
  return null;
}

/**
 * The outer shell remains writable when a nested interactive Agent exits or
 * never launches. Treating that prompt as Agent readiness would paste the
 * control protocol into PowerShell/CMD and execute it as a command.
 */
export function interactiveAgentShellPromptFailureDetail(output: string): string | null {
  const plain = plainTerminalOutput(output);
  const lastLine = lastNonEmptyTerminalLine(output);
  const powerShellPrompt = /^PS\s+[A-Za-z]:[\\/].*>\s*$/u.test(lastLine);
  const cmdPrompt = /^[A-Za-z]:[\\/].*>\s*$/u.test(lastLine);
  const posixPrompt = /^[^\s@]+@[^:\s]+:[^\n]*[$#]\s*$/u.test(lastLine);
  const protocolPastedIntoShell = /(?:^|\n)(?:PS\s+[A-Za-z]:[\\/][^\n>]*>|[A-Za-z]:[\\/][^\n>]*>|[^\s@]+@[^:\s]+:[^\n]*[$#])\s*(?:e>\s*)?(?:\[(?:目标任务终端|项目事件|普通监督终端上下文启动)|#\s*项目监督\s*AI)/u.test(plain);
  if (!powerShellPrompt && !cmdPrompt && !posixPrompt && !protocolPastedIntoShell) return null;
  return 'Agent 启动失败：检测到外层 Shell 提示符，交互式 Agent 未保持运行';
}

/** Require recognizable current Agent chrome before the first natural-language prompt. */
export function interactiveAgentInputReady(output: string): boolean {
  const plain = plainTerminalOutput(output);
  if (interactiveAgentShellPromptFailureDetail(plain)) return false;
  return INTERACTIVE_AGENT_SCREEN_PATTERNS.some((pattern) => pattern.test(plain))
    || (/^\s*[◆◇◈◊]\s*user_prompt_submit\b/imu.test(plain)
      && /(?:Thought for\b|Worked for\b)/iu.test(plain));
}

/** Persist only structural startup evidence; never include project text or filesystem paths. */
export function interactiveAgentStartupDiagnostic(output: string): string {
  const plain = plainTerminalOutput(output);
  const lines = plain.split('\n').filter((line) => line.trim().length > 0);
  const markers = [
    /\bOpenAI Codex\b/iu.test(plain) ? 'openai-codex' : '',
    /\bAsk Codex to do anything\b/iu.test(plain) ? 'ask-codex' : '',
    /(?:^|\n)\s*gpt-[\w.-]+\b/imu.test(plain) ? 'gpt-model' : '',
    /Hooks need review/iu.test(plain) ? 'hooks-review' : '',
    /(?:Do you trust|Trust this folder|Trust all and continue)/iu.test(plain) ? 'trust-prompt' : '',
    /(?:^|\n)\s*(?:PS\s+[A-Za-z]:[\\/]|[A-Za-z]:[\\/])/mu.test(plain) ? 'shell-prompt' : '',
  ].filter(Boolean);
  return `终端诊断：lines=${lines.length}; chars=${plain.length}; markers=${markers.join(',') || 'none'}; lastLineChars=${lines.at(-1)?.trim().length || 0}`;
}

/**
 * Detect that the interactive Agent nested inside a still-live shell has left.
 * The outer PowerShell PTY remains writable, so this must not rely on PTY exit.
 */
export function interactiveAgentExitDetail(
  agent: AutomatedInteractiveAgent | undefined,
  output: string,
): string | null {
  if (agent !== 'codex') return null;
  if (!CODEX_EXIT_FOOTER.test(plainTerminalOutput(output))) return null;
  return 'Codex Agent 已退出，外层终端仍处于运行状态';
}
