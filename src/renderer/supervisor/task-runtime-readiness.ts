import {
  interactiveAgentInputReady,
  interactiveAgentShellPromptFailureDetail,
} from '../utils/interactive-agent-runtime';

export type TaskTerminalRuntimeKind = 'agent' | 'shell' | 'unknown';

export interface TaskTerminalRuntimeEvidence {
  agentState?: unknown;
  runtimeState?: unknown;
  spawnedAgentStatus?: unknown;
  screenText?: string;
}

/** Require positive Agent evidence before natural-language task delivery. */
export function taskTerminalRuntimeKind(evidence: TaskTerminalRuntimeEvidence): TaskTerminalRuntimeKind {
  const screen = String(evidence.screenText || '');
  // A current shell prompt wins over stale Agent chrome left in scrollback or a
  // state/runtime-ready flag that was not cleared when the inner Agent exited.
  if (interactiveAgentShellPromptFailureDetail(screen)) return 'shell';
  // Explicit activity and the current Agent UI can recover a stale exited flag
  // after a manual relaunch. A visible shell prompt above already wins over both.
  if (['working', 'idle', 'blocked'].includes(String(evidence.agentState || ''))) return 'agent';
  if (interactiveAgentInputReady(screen)) return 'agent';
  // The inner Agent lifecycle is stronger than outer PTY metadata. A shell can
  // remain alive and keep agentMeta=running after its nested Agent exits.
  if (evidence.runtimeState === 'failed' || evidence.runtimeState === 'exited') return 'unknown';
  if (evidence.runtimeState === 'ready' && evidence.spawnedAgentStatus === 'running') return 'agent';
  return 'unknown';
}

export function ordinaryTaskDeliveryBlockReason(evidence: TaskTerminalRuntimeEvidence): string | null {
  const kind = taskTerminalRuntimeKind(evidence);
  if (kind === 'agent') return null;
  return kind === 'shell'
    ? '目标任务终端当前是普通 shell，尚未检测到可接收自然语言的 Agent；已禁止把任务正文发送给 PowerShell。请使用 needs-human 通知用户先在该终端启动受支持的 Agent，Agent 界面就绪后再重试当前裁决'
    : '目标任务终端尚无可信 Agent 就绪证据；已禁止发送自然语言任务。请先 read-screen 和 agent-state 核对，确认 Agent 界面就绪后再重试；若仍是普通 shell，使用 needs-human 通知用户启动 Agent';
}
