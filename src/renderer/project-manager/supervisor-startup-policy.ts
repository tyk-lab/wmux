import {
  interactiveAgentInputReady,
  interactiveAgentShellPromptFailureDetail,
} from '../utils/interactive-agent-runtime';

export interface ProjectSupervisorBriefingStartupProbe {
  runtimeState?: string;
  screen: string;
  nonElectronHarness: boolean;
}

/** Reuse the mounted terminal's combined startup verdict; the active TUI screen may be transiently blank. */
export function projectSupervisorBriefingStartupError(
  probe: ProjectSupervisorBriefingStartupProbe,
): string | null {
  if (probe.nonElectronHarness) return null;
  const shellFailure = interactiveAgentShellPromptFailureDetail(probe.screen);
  if (shellFailure) return shellFailure;
  if (probe.runtimeState === 'ready' || interactiveAgentInputReady(probe.screen)) return null;
  return 'AI 监督运行时启动失败：未检测到 Codex、Kimi、Grok 或 Pi 的可输入界面；已禁止向未知终端发送监督协议';
}
