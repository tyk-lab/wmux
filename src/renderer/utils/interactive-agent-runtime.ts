import type { AutomatedInteractiveAgent } from './interactive-agent-launch';

const ANSI_ESCAPE = new RegExp(
  String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`,
  'gu',
);
const CODEX_EXIT_FOOTER = /Token usage:[\s\S]{0,2000}To continue this session,\s*run\s+codex resume\s+[0-9a-f-]{20,}/iu;

function plainTerminalOutput(output: string): string {
  return output.replace(ANSI_ESCAPE, '').replace(/\r/gu, '');
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
