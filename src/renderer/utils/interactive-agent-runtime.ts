import type { AutomatedInteractiveAgent } from './interactive-agent-launch';

const ANSI_ESCAPE = new RegExp(
  String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`,
  'gu',
);
const CODEX_EXIT_FOOTER = /Token usage:[\s\S]{0,2000}To continue this session,\s*run\s+codex resume\s+[0-9a-f-]{20,}/iu;

function plainTerminalOutput(output: string): string {
  return output.replace(ANSI_ESCAPE, '').replace(/\r/gu, '');
}

const STARTUP_FAILURE_PATTERNS = [
  /(?:^|\n)\s*error:\s*(?:unknown|unrecognized)\s+(?:option|argument)\b[^\n]*/iu,
  /(?:^|\n)\s*error:\s*unexpected argument\b[^\n]*/iu,
  /(?:^|\n)\s*(?:unknown|unrecognized)\s+(?:option|argument)\b[^\n]*/iu,
  /(?:^|\n)\s*ParserError:\s*[^\n]*/iu,
  /(?:^|\n)\s*[^\n]*\bis not recognized as (?:the name of a cmdlet|an internal or external command)\b[^\n]*/iu,
  /(?:^|\n)\s*[^\n]*\bcommand not found\b[^\n]*/iu,
  /(?:^|\n)\s*(?:Error:\s*)?Cannot find module\b[^\n]*/iu,
] as const;

/** Detect an explicit launcher/outer-shell failure before any Agent becomes ready. */
export function interactiveAgentStartupFailureDetail(output: string): string | null {
  const plain = plainTerminalOutput(output);
  for (const pattern of STARTUP_FAILURE_PATTERNS) {
    const match = pattern.exec(plain)?.[0]?.trim();
    if (match) return `Agent 启动失败：${match.replace(/\s+/gu, ' ').slice(0, 500)}`;
  }
  return null;
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
