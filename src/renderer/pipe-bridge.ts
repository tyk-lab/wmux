/**
 * pipe-bridge.ts — Exposes Zustand store operations as window.__wmux_* globals
 * so the main process can call them via executeJavaScript from V2 pipe handlers.
 */
import { useStore } from './store';
import { splitNode, getAllPaneIds, findLeaf, buildGridLayout, createLeaf } from './store/split-utils';
import { surfaceTerminalRegistry } from './hooks/useTerminal';
import { PaneId, SurfaceId, WorkspaceId, SurfaceType, SplitNode, SurfaceRef } from '../shared/types';
import {
  DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS,
  DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS,
  DEFAULT_SUPERVISOR_WORK_SCOPE,
  type SupervisorAutonomyPermission,
  type SupervisorForbiddenAction,
  type SupervisorWorkScope,
} from '../shared/supervisor-policy';
import { v4 as uuid } from 'uuid';
import {
  sendPermissionResponseReliably,
  sendTaskToSurface,
  sendTaskToSurfaceReliably,
  sendToSurface,
  sendToSurfaceReliably,
  SUPERVISOR_TUI_READY_DELAY_MS,
} from './supervisor/supervisor-engine';
import {
  markTerminalRuntimeFailed,
  markTerminalRuntimeExited,
  markTerminalRuntimeStarting,
  terminalRuntimeStatus,
  waitForTerminalRuntimeReady,
} from './terminal-runtime-lifecycle';
import {
  handleSupervisorUserSubmit,
  resumeWaitingLaneFromSupervisorInput,
} from './supervisor/user-input-precedence';
import {
  cancelPendingAutomatedTerminalSubmit,
  prepareForUserTerminalInput,
} from './utils/terminal-user-submit';
import {
  PROJECT_MANAGER_RUNTIME_PATH_SUFFIX,
  PROJECT_MANAGER_TERMINAL_NAME,
  PROJECT_MANAGER_ALIGNMENT_GATE,
  normalizeProjectManagementAgentConfig,
  projectManagerStartupInput,
  withProjectManagerEventEnvelope,
  type ProjectManagerRuntimeAgent,
} from '../shared/project-manager-terminal';
import {
  USER_RECORDS_TERMINAL_AGENT,
  USER_RECORDS_TERMINAL_DIRECTORY,
  USER_RECORDS_TERMINAL_NAME,
  USER_RECORDS_TERMINAL_STARTUP_INPUT,
} from '../shared/user-records-terminal';
import {
  SUPERVISOR_NO_DECISION_OPTION,
  supervisorDecisionOptions,
} from '../shared/supervisor-decision-options';
import { appendSupervisorRecord } from './supervisor/recording';
import {
  clearSupervisorLaneContext,
  dedicatedSupervisorSurfaceId,
  isProjectManagedSupervisorLane,
  isSupervisorLaneBound,
  supervisorLaneControlState,
  type SupervisorDecision,
  type SupervisorDelivery,
  type SupervisorLane,
  type SupervisorSession,
} from './store/supervisor-slice';
import {
  buildProjectTaskStartupBriefing,
  buildSupervisorBriefing,
  buildUnacknowledgedSupervisorIdlePrompt,
  effectiveSupervisorAutonomyPermissions,
  effectiveSupervisorAutonomous,
  effectiveSupervisorForbiddenActions,
  effectiveSupervisorLaneConfig,
  effectiveSupervisorTaskGoal,
  effectiveSupervisorWorkScope,
  PROJECT_SUPERVISOR_WORKSPACE_TITLE,
  SUPERVISOR_TAB_TITLE,
  SUPERVISOR_WORKSPACE_TITLE,
  projectManagerWorkspaceTitle,
  projectSupervisorWorkspaceTitle,
  supervisorTabTitle,
} from './supervisor/protocol';
import { buildSupervisorLaunchCommand } from './supervisor/launch-command';
import {
  buildSupervisorRuntimeContext,
  evaluateSupervisorDecisionPreflight,
} from './supervisor/supervisor-context';
import {
  ORDINARY_TASK_ROLE_ANCHOR,
  authorizeManagedRoleV2,
  buildOrdinaryTaskEventEnvelope,
  buildProjectAiRuntimeContext,
  buildTaskAiRuntimeContext,
} from './role-context';
import { buildInteractiveAgentLaunch, type InteractiveAgent } from './utils/interactive-agent-launch';
import { announceSupervisorWaitingForDirection } from './supervisor/waiting-notification';
import {
  activeProjectManagerAttentionEvent,
  activeProjectGoal,
  activeProjectSubgoals,
  CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
  MAX_PROJECT_PLAN_FILE_BYTES,
  MAX_PROJECT_PLAN_FILES,
  PROJECT_MANAGER_MANUAL_INTERVENTION_REASON_CODES,
  PROJECT_ORIENTATION_DISPOSITIONS,
  diffProjectProgressSnapshots,
  normalizeProjectManagerSession,
  normalizeProjectExecutionBudget,
  projectAuthorizationVersion,
  projectDisplayName,
  projectManagerEventNeedsUserAttention,
  projectOrientationReady,
  projectAcceptedRequirementsVersion,
  projectRequirementsAlignmentPhase,
  projectRequirementsVersion,
  projectTaskBaselineApproved,
  requiredProjectOrientation,
  requiredProjectTaskBaseline,
  type ProjectManagerQuestionOption,
  type ProjectManagerEventKind,
  type ProjectManagerPendingDelivery,
  type ProjectEscalationBoundary,
  type ProjectSupervisorTransition,
  type ProjectSupervisorTransitionKind,
  type ProjectProgressDiff,
  type ProjectProgressSnapshot,
  type ProjectOrientationDisposition,
  type ProjectOrientationWorkItemReview,
  type ProjectManagerSession,
  type ProjectManagerUserQuestion,
  type ProjectExecutionRecord,
  type ProjectPlanFileSnapshot,
  type ProjectSubgoal,
  type ProjectSupervisorContract,
  type ProjectSupervisorStagePlan,
  type ProjectWorkItem,
} from '../shared/project-manager';
import { projectCommandNeedsExplicitId } from '../shared/project-command-scope';
import {
  MAX_TASK_CHILD_THREADS,
  TASK_WORK_MODE_VALUES,
  normalizeTaskChildThreadResponsibilities,
  normalizeTaskMaxChildThreads,
  normalizeTaskOperationBoundaries,
  normalizeTaskThreadResponsibility,
  normalizeTaskWorkMode,
  type TaskWorkMode,
} from '../shared/supervisor-work-mode';
import { evaluateProjectExecutionGuard } from './project-manager/anti-loop';
import {
  PROJECT_TASK_BASELINE_APPROVAL_MARKER,
  PROJECT_TASK_BASELINE_INVESTIGATION_MARKER,
  buildProjectExecutionIdentityBlock,
  buildProjectSupervisorBriefing,
  isProjectTargetedTestCommand,
  prepareProjectTaskDelivery,
  projectContractViolation,
  projectPermissionAuthorizationError,
  projectTaskBaselineViolation,
  projectWorkItemSubgoalDependencyError,
} from './project-manager/engine';
import {
  projectSupervisorDefaults,
  projectManagerRuntimeDefaults,
  projectTaskTerminalAgent,
  projectTaskTerminalDefaults,
} from './project-manager/agent-defaults';
import { projectSupervisorLaneIds as scopedProjectSupervisorLaneIds } from './project-manager/lane-scope';
import {
  beginManagedAgentTurn,
  evaluateManagedAgentDeadline,
  looksLikeManagedShellPrompt,
  managedAgentDeadlinePolicy,
  noteManagedAgentCommand,
  noteManagedAgentOutput,
  noteManagedAgentSemanticProgress,
  normalizeProjectActivityFingerprintText,
  pauseManagedAgentWatchdog,
  resumeManagedAgentWatchdog,
  shiftManagedAgentDeadlineForSuspend,
  type ManagedAgentDeadlinePolicy,
  type ManagedAgentWatchdogRuntime,
  type ManagedProjectAgentRole,
} from './project-manager/liveness';
import {
  enqueueSupervisorDelivery,
  signalSupervisorDeliveryReady,
} from './supervisor/delivery';

export function isSupervisorDecisionAuthorised(
  lane: Pick<SupervisorLane, 'surfaceId' | 'supervisorSurfaceId'>,
  supervisorSurfaceId: string,
): boolean {
  return !!supervisorSurfaceId && dedicatedSupervisorSurfaceId(lane) === supervisorSurfaceId;
}

const FEISHU_TERMINAL_SCREEN_MAX_CHARS = 1_500;
const FEISHU_TERMINAL_SCREEN_MAX_LINES = 18;
const FEISHU_TERMINAL_QUESTION_MAX_CHARS = 1_000;
const FEISHU_TERMINAL_ANSWER_MAX_CHARS = 4_000;

function sanitizeTerminalTextLine(line: string): string {
  return Array.from(line, (character) => {
    const codePoint = character.codePointAt(0) || 0;
    const isControl = codePoint <= 0x08
      || (codePoint >= 0x0b && codePoint <= 0x0c)
      || (codePoint >= 0x0e && codePoint <= 0x1f)
      || (codePoint >= 0x7f && codePoint <= 0x9f);
    const isTerminalGlyph = (codePoint >= 0x2580 && codePoint <= 0x259f)
      || (codePoint >= 0x25a0 && codePoint <= 0x25a3)
      || codePoint === 0x25ae
      || codePoint === 0x25af
      || codePoint === 0xfffc
      || codePoint === 0xfffd
      || (codePoint >= 0xe000 && codePoint <= 0xf8ff);
    return isControl || isTerminalGlyph ? ' ' : character;
  }).join('');
}

export function readTerminalScreen(surfaceId: string, lines = 50): { text?: string; lines?: number; surfaceId?: string; error?: string } {
  const terminal = surfaceTerminalRegistry.get(surfaceId);
  if (!terminal) {
    return { error: `no terminal for surface ${surfaceId} (markdown/browser pane, another window, or closed)` };
  }
  const buffer = terminal.buffer.active;
  const count = Math.min(Math.max(Math.floor(lines), 1), 10000);
  const output: string[] = [];
  // Alternate-screen TUIs use the entire viewport as one repaint frame. Taking
  // only its bottom N rows drops the conversation at the top and keeps mostly
  // the composer/footer (notably in Grok). Normal shells still use the newest
  // requested scrollback rows.
  const start = buffer.type === 'alternate' ? 0 : Math.max(0, buffer.length - count);
  for (let i = start; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    const text = line?.translateToString(true) ?? '';
    if (line?.isWrapped && output.length > 0) output[output.length - 1] += text;
    else output.push(text);
  }
  while (output.length && output[output.length - 1] === '') output.pop();
  return { text: output.join('\n'), lines: output.length, surfaceId };
}

function isTerminalTuiChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[\s\u2500-\u259f_=~-]+$/u.test(trimmed)) return true;
  if (/^[\s│┃╎╏┆┇┊┋`'|\\]*[>❯›〉][\s│┃╎╏┆┇┊┋`'|\\]*$/u.test(trimmed)) return true;
  if (/^[\s│┃╎╏┆┇┊┋`'|\\]+$/u.test(trimmed)) return true;
  if (/\bShift\+Tab\s*:\s*mode\b/i.test(trimmed)
    && /\b(?:Esc\s*:\s*cancel|Ctrl\+X\s*:\s*shortcuts)\b/i.test(trimmed)) return true;
  if (/\bCtrl\+E\s*:\s*expand thinking\b/i.test(trimmed)
    && /\b(?:Space\s*:\s*prompt|Ctrl\+X\s*:\s*shortcuts)\b/i.test(trimmed)) return true;
  if (/\bGrok\s+\d+(?:\.\d+)+(?:\s*\([^)]*\))?.*\b(?:always|auto)[- ]approve\b/i.test(trimmed)) return true;
  return false;
}

export function terminalScreenExcerpt(text: string, maxChars = FEISHU_TERMINAL_SCREEN_MAX_CHARS): string {
  const normalizedLines = text.replace(/\r\n?/g, '\n').split('\n').map(sanitizeTerminalTextLine);
  const compacted: string[] = [];
  for (const line of normalizedLines) {
    if (isTerminalTuiChromeLine(line)) continue;
    if (!line.trim()) {
      if (compacted.length > 0 && compacted[compacted.length - 1] !== '') compacted.push('');
      continue;
    }
    if (line === compacted[compacted.length - 1]) continue;
    compacted.push(line);
  }
  while (compacted[compacted.length - 1] === '') compacted.pop();

  // Full-screen TUIs can leave two or more identical repaint frames in the
  // scrollback. Keep only the newest repeated suffix frame.
  for (let size = Math.floor(compacted.length / 2); size >= 3; size--) {
    const latest = compacted.slice(-size);
    const previous = compacted.slice(-(size * 2), -size);
    if (latest.every((line, index) => line === previous[index])) {
      compacted.splice(-(size * 2), size);
      break;
    }
  }

  const limitedLines = compacted.slice(-FEISHU_TERMINAL_SCREEN_MAX_LINES);
  let normalized = limitedLines.join('\n');
  if (compacted.length > limitedLines.length) normalized = `…\n${normalized}`;
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 1) return '…'.slice(0, maxChars);
  return `…\n${normalized.slice(-(maxChars - 2))}`;
}

export interface TerminalConversationExcerpt {
  question?: string;
  answer?: string;
  answerPending?: boolean;
  text: string;
}

type TerminalConversationAgent = 'codex' | 'kimi' | 'grok' | 'generic';

function terminalConversationAgent(label: string, text: string): TerminalConversationAgent {
  const normalized = label.toLowerCase();
  if (normalized.includes('grok')) return 'grok';
  if (normalized.includes('kimi')) return 'kimi';
  if (normalized.includes('codex')) return 'codex';
  if (/\bHelp improve Grok\b/iu.test(text)
    || (/^\s*[◆◇◈◊]\s*user_prompt_submit\b/imu.test(text)
      && /(?:Thought for\b|Worked for\b)/iu.test(text))
    || (/\bWorked for\s+\d/iu.test(text) && /\bstop\s+\[hooks:/iu.test(text))) return 'grok';
  if (/^\s*[✦✧✨]\s+\S/mu.test(text)
    && /(?:^|\n)\s*(?:auto\b.*\bK\d|yolo\b|\/compact\b|context:\s*\d|K\d+-\d+k\b)/iu.test(text)) return 'kimi';
  if (/\(kimi-coding\).*\bkimi-for-coding\b/iu.test(text)) return 'kimi';
  if (/\bOpenAI Codex\b/iu.test(text)
    || (/^\s*[>❯›]\s+\S/mu.test(text) && /(?:^|\n)\s*gpt-[\w.-]+\b/iu.test(text))) return 'codex';
  return 'generic';
}

const REMOTE_TERMINAL_AGENT_LABELS: Record<Exclude<TerminalConversationAgent, 'generic'>, string> = {
  codex: 'Codex',
  kimi: 'Kimi',
  grok: 'Grok',
};

function remoteTerminalLabel(surface: SurfaceRef): string {
  const customTitle = surface.customTitle?.trim();
  if (customTitle) return customTitle;

  const agentLabel = useStore.getState().agentMeta.get(surface.id)?.label?.trim();
  if (agentLabel) return agentLabel;

  const screen = readTerminalScreen(surface.id, 40).text || '';
  const agent = terminalConversationAgent(surface.shell || '', screen);
  if (agent !== 'generic') return REMOTE_TERMINAL_AGENT_LABELS[agent];

  return surface.shell || 'terminal';
}

function isCodexComposerSuggestion(question: string): boolean {
  return /^Ask Codex\b/iu.test(question)
    || /^(?:Find and fix a bug in|Improve documentation in)\s+@filename$/iu.test(question)
    || /^Run \/review on my current changes$/iu.test(question)
    || /^Implement\s+\{[^{}]+\}$/u.test(question);
}

function isGrokComposerSuggestion(question: string): boolean {
  return /^(?:Build anything|Ask Grok\b.*)$/iu.test(question);
}

function lastMatchingLineIndex(lines: string[], pattern: RegExp): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (pattern.test(lines[index].trim())) return index;
  }
  return -1;
}

function grokQuestionSearchEnd(lines: string[]): number {
  const submittedIndex = lastMatchingLineIndex(lines, /^[◆◇◈◊]\s*user_prompt_submit\b/iu);
  if (submittedIndex >= 0) return submittedIndex;
  const completionIndex = lastMatchingLineIndex(lines, /^(?:Worked for\b|stop\s+\[hooks:)/iu);
  if (completionIndex >= 0) return completionIndex;
  const respondingIndex = lastMatchingLineIndex(lines, /^(?:[∷⋮:]\s*)?Responding\b/iu);
  return respondingIndex >= 0 ? respondingIndex : lines.length;
}

function terminalQuestionText(line: string, agent: TerminalConversationAgent): string | null {
  const trimmed = line.trim();
  const match = agent === 'kimi'
    ? /^[✦✧✨]\s*(.+)$/u.exec(trimmed)
    : /^(?:[│┃]\s*)?[>❯›〉]\s+(.+)$/u.exec(trimmed);
  if (!match?.[1]) return null;
  const question = match[1].replace(/\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*$/iu, '').trim();
  if (!question || (agent === 'kimi' && /^Use Kimi\b/iu.test(question))) return null;
  if (/^[\s│┃╎╏┆┇┊┋`'|\\]+$/u.test(question) || isTerminalTuiChromeLine(question)) return null;
  if (agent === 'codex' && isCodexComposerSuggestion(question)) return null;
  if (agent === 'grok' && isGrokComposerSuggestion(question)) return null;
  return question;
}

function isKimiRuntimeFooter(line: string): boolean {
  const trimmed = line.trim();
  return /^(?:(?:auto|yolo)\b.*\bK\d|\/compact\b|context:\s*\d|K\d+-\d+k\b)/iu.test(trimmed)
    || /\bK\d(?:\.\d+)?\s+Coding\s+thinking\b.*\bcontext:\s*\d/iu.test(trimmed)
    || /\(kimi-coding\).*\bkimi-for-coding\b/iu.test(trimmed);
}

function isTerminalConversationFooter(line: string, agent: TerminalConversationAgent): boolean {
  const trimmed = line.trim();
  if (agent === 'grok' && /^(?:Help improve Grok|Off by default\.|Change anytime via settings\.|Read Terms and Privacy Policy\.)/iu.test(trimmed)) return true;
  if (agent === 'kimi' && isKimiRuntimeFooter(line)) return true;
  if (agent === 'codex' && /^(?:gpt-[\w.-]+\b|model:|directory:|permissions:|Tip:|MCP startup interrupted)/iu.test(trimmed)) return true;
  return false;
}

function isTerminalConversationNoise(line: string, agent: TerminalConversationAgent): boolean {
  const trimmed = line.trim();
  if (!trimmed || isTerminalTuiChromeLine(line)) return true;
  if (/^\d{1,2}:\d{2}\s*(?:AM|PM)$/iu.test(trimmed)) return true;
  if (/^[◆◇]\s*(?:user_prompt_submit|Thought\b)/iu.test(trimmed)) return true;
  if (/^(?:Worked for\b|stop\s+\[hooks:)/iu.test(trimmed)) return true;
  if (agent === 'grok' && /^(?:[∷⋮:]\s*)?Responding\b.*$/iu.test(trimmed)) return true;
  if (agent === 'grok' && /^\d+(?:\.\d+)?s\s+.*\[stop\]\s*$/iu.test(trimmed)) return true;
  if (agent === 'grok' && /^(?:\[Opt out\]|\[Opt in\])/iu.test(trimmed)) return true;
  if (agent === 'kimi' && /^(?:Run \/model\b|No session yet\b)/iu.test(trimmed)) return true;
  return false;
}

function limitConversationText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const headLength = Math.floor((maxChars - 3) * 0.6);
  return `${value.slice(0, headLength)}\n…\n${value.slice(-(maxChars - headLength - 3))}`;
}

function isCodexActivityBlock(value: string): boolean {
  return /^(?:Ran|Running|Read|Explored|Searched?|Searching|Working|Called|Viewed|Edited|Updated|Added|Deleted|Reconnecting)\b/iu.test(value)
    || /^You have\s+\d+/iu.test(value);
}

function codexFinalAnswer(lines: string[]): string {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^\s*[>❯›]\s+/u.test(line)) {
      current = null;
      continue;
    }
    const bullet = /^\s*[•●]\s+(.+)$/u.exec(line);
    if (bullet) {
      current = [bullet[1].trimEnd()];
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\s*[└╰]/u.test(line) || isTerminalTuiChromeLine(line)) continue;
    current.push(line.trimEnd());
  }
  const candidate = [...blocks].reverse().find((block) => !isCodexActivityBlock(block[0] || ''));
  if (!candidate) return '';
  while (candidate[candidate.length - 1] === '') candidate.pop();
  return candidate.join('\n').trim();
}

function isSupervisorCoreActivity(value: string): boolean {
  const normalized = value.replace(/^\s*[•●◆◇◈◊◦]\s*/u, '').trim();
  return isCodexActivityBlock(normalized)
    || /^(?:Bash|Read|Edit|Write|Glob|Grep|Search|Task|WebFetch|WebSearch|TodoWrite)\s*\(/iu.test(normalized)
    || /^(?:Thought\b|Responding\b|Worked for\b|stop\s+\[hooks:)/iu.test(normalized)
    || /^(?:\+|…\s*\+?)\d+\s+lines?\b/iu.test(normalized)
    || /^\$\s+\S/u.test(normalized)
    || /^(?:PS\s+[A-Za-z]:[\\/][^>]*>|[A-Za-z]:[\\/][^>]*>)\s*\S*/iu.test(normalized)
    || /^(?:\(no output\)|Took\s+\d+(?:\.\d+)?s|(?:已|被)?成功提交[。.]*?)$/iu.test(normalized);
}

function isSupervisorCoreChrome(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed
    || isTerminalTuiChromeLine(value)
    || /^\s*(?:[>❯›〉]|[✦✧✨])\s+\S/u.test(value)
    || /^\s*[└╰⎿]\s*/u.test(value)
    || /^(?:gpt-[\w.-]+\b|model:|directory:|permissions:|Tip:|MCP startup interrupted)/iu.test(trimmed)
    || isKimiRuntimeFooter(value)
    || /^[A-Za-z]:[\\/][^\r\n]*$/u.test(trimmed)
    || /\bR\d+(?:\.\d+)?k?\b.*\bCH\d+(?:\.\d+)?%/iu.test(trimmed)
    || /^(?:Help improve Grok|Off by default\.|Change anytime via settings\.|Read Terms and Privacy Policy\.)/iu.test(trimmed)
    || /^\d+(?:\.\d+)?s\s+.*\[stop\]\s*$/iu.test(trimmed)
    || /^(?:\[Opt out\]|\[Opt in\])/iu.test(trimmed);
}

function supervisorVisibleCoreInformation(lines: string[]): string {
  const candidates: string[][] = [];
  let current: string[] | null = null;
  let skippingActivity = false;
  const finishCurrent = (): void => {
    if (!current) return;
    while (current[current.length - 1] === '') current.pop();
    if (current.some((line) => /[\p{L}\p{N}]/u.test(line))) candidates.push(current);
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current && current[current.length - 1] !== '') current.push('');
      skippingActivity = false;
      continue;
    }
    if (isSupervisorCoreActivity(line)) {
      finishCurrent();
      skippingActivity = true;
      continue;
    }
    if (isSupervisorCoreChrome(line)) {
      finishCurrent();
      continue;
    }

    const bullet = /^\s*[•●]\s+(.+)$/u.exec(line);
    if (bullet?.[1]) {
      finishCurrent();
      skippingActivity = false;
      current = [bullet[1].trimEnd()];
      continue;
    }
    if (skippingActivity) continue;
    if (!current) current = [];
    current.push(line.trimEnd());
  }
  finishCurrent();

  const candidate = candidates[candidates.length - 1];
  return candidate ? candidate.join('\n').trim() : '';
}

function kimiVisibleCoreInformation(lines: string[]): string {
  const footerIndex = lines.findIndex(isKimiRuntimeFooter);
  let visibleLines = footerIndex >= 0 ? lines.slice(0, footerIndex) : lines;
  const finalAnswerStart = visibleLines.reduce((latest, line, index) => (
    /^\s*●\s+\S/u.test(line) ? index : latest
  ), -1);
  if (finalAnswerStart >= 0) visibleLines = visibleLines.slice(finalAnswerStart);

  const candidates: string[][] = [];
  let current: string[] = [];
  let skippingActivity = false;
  const finishCurrent = (): void => {
    while (current[current.length - 1] === '') current.pop();
    if (current.some((line) => /[\p{L}\p{N}]/u.test(line))) candidates.push(current);
    current = [];
  };

  for (const line of visibleLines) {
    if (!line.trim()) {
      if (current.length > 0 && current[current.length - 1] !== '') current.push('');
      skippingActivity = false;
      continue;
    }
    if (isSupervisorCoreActivity(line)) {
      finishCurrent();
      skippingActivity = true;
      continue;
    }
    const isTableBorder = /^[\s\u2500-\u257f]*[┌┐└┘├┤┬┴┼╭╮╰╯][\s\u2500-\u257f]*$/u.test(line);
    if (!isTableBorder && isSupervisorCoreChrome(line)) {
      finishCurrent();
      skippingActivity = false;
      continue;
    }
    if (skippingActivity || (!isTableBorder && isTerminalConversationNoise(line, 'kimi'))) continue;
    current.push(line.trimEnd());
  }
  finishCurrent();

  const candidate = candidates[candidates.length - 1];
  if (!candidate) return '';
  candidate[0] = candidate[0].replace(
    candidate.length === 1 ? /^\s*[●•]\s+/u : /^\s*●\s+/u,
    '',
  );
  return candidate.join('\n').trim();
}

/** Preserve useful supervisor prose when a long-running TUI has scrolled its original prompt away. */
export function terminalSupervisorCoreExcerpt(
  text: string,
  terminalLabel: string,
  activityState: RemoteTerminalActivityState = 'unknown',
): TerminalConversationExcerpt {
  const conversation = terminalConversationExcerpt(text, terminalLabel, activityState);
  if (conversation.answer) return conversation;

  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(sanitizeTerminalTextLine);
  const agent = terminalConversationAgent(terminalLabel, text);
  const coreInformation = agent === 'codex'
    ? codexFinalAnswer(lines) || supervisorVisibleCoreInformation(lines)
    : agent === 'kimi'
      ? kimiVisibleCoreInformation(lines)
      : supervisorVisibleCoreInformation(lines);
  return {
    ...(coreInformation ? { answer: limitConversationText(coreInformation, FEISHU_TERMINAL_ANSWER_MAX_CHARS) } : {}),
    ...(activityState === 'working' ? { answerPending: true } : {}),
    text: conversation.text,
  };
}

function codexConversationQuestion(
  lines: string[],
  activityState: RemoteTerminalActivityState,
): { index: number; question: string } | null {
  const rawPromptIndexes = lines.flatMap((line, index) => (
    /^\s*[>❯›〉]\s+\S/u.test(line) ? [index] : []
  ));
  const candidates = rawPromptIndexes.flatMap((index) => {
    const question = terminalQuestionText(lines[index], 'codex');
    return question ? [{ index, question }] : [];
  });
  for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex--) {
    const candidate = candidates[candidateIndex];
    const nextPromptIndex = rawPromptIndexes.find((index) => index > candidate.index) ?? lines.length;
    const turnLines = lines.slice(candidate.index + 1, nextPromptIndex);
    const bulletTexts = turnLines.flatMap((line) => {
      const bullet = /^\s*[•●]\s+(.+)$/u.exec(line);
      return bullet?.[1] ? [bullet[1]] : [];
    });
    const hasPendingActivity = bulletTexts.some((bullet) => /^Working\b/iu.test(bullet))
      || (activityState === 'working' && bulletTexts.some(isCodexActivityBlock));
    if (hasPendingActivity || codexFinalAnswer(turnLines)) return candidate;
  }
  return candidates[0] || null;
}

/** Extract the newest submitted user prompt and final agent response from supported AI TUIs. */
export function terminalConversationExcerpt(
  text: string,
  terminalLabel: string,
  activityState: RemoteTerminalActivityState = 'unknown',
): TerminalConversationExcerpt {
  const fallback = terminalScreenExcerpt(text);
  const agent = terminalConversationAgent(terminalLabel, text);
  if (agent === 'generic') return { text: fallback };
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(sanitizeTerminalTextLine);
  let questionIndex = -1;
  let question = '';
  if (agent === 'codex') {
    const candidate = codexConversationQuestion(lines, activityState);
    if (candidate) {
      questionIndex = candidate.index;
      question = candidate.question;
    }
  } else {
    const questionSearchEnd = agent === 'grok' ? grokQuestionSearchEnd(lines) : lines.length;
    for (let index = 0; index < questionSearchEnd; index++) {
      const candidate = terminalQuestionText(lines[index], agent);
      if (!candidate) continue;
      questionIndex = index;
      question = candidate;
    }
  }
  if (questionIndex < 0) return { text: fallback };

  let answerLines = lines.slice(questionIndex + 1);
  const footerIndex = answerLines.findIndex((line) => isTerminalConversationFooter(line, agent));
  if (footerIndex >= 0) answerLines = answerLines.slice(0, footerIndex);
  if (agent === 'codex') {
    const latestBullet = [...answerLines].reverse().map((line) => /^\s*[•●]\s+(.+)$/u.exec(line)?.[1] || '').find(Boolean) || '';
    const answerPending = activityState === 'working'
      || /^Working\b/iu.test(latestBullet);
    const answer = codexFinalAnswer(answerLines);
    return {
      question: limitConversationText(question, FEISHU_TERMINAL_QUESTION_MAX_CHARS),
      ...(answer ? { answer: limitConversationText(answer, FEISHU_TERMINAL_ANSWER_MAX_CHARS) } : {}),
      ...(answerPending ? { answerPending: true } : {}),
      text: fallback,
    };
  }
  if (agent === 'grok') {
    const completionIndex = answerLines.findIndex((line) => /^(?:Worked for\b|stop\s+\[hooks:)/iu.test(line.trim()));
    if (completionIndex >= 0) answerLines = answerLines.slice(0, completionIndex);
    const respondingIndex = answerLines.findIndex((line) => /^(?:[∷⋮:]\s*)?Responding\b/iu.test(line.trim()));
    if (respondingIndex >= 0) answerLines = answerLines.slice(0, respondingIndex);
    const latestActivity = answerLines.reduce((latest, line, index) => (
      /^\s*[◆◇◈◊]\s*\S/u.test(line) ? index : latest
    ), -1);
    if (latestActivity >= 0) answerLines = answerLines.slice(latestActivity + 1);
  }
  if (agent === 'kimi') {
    const answerStart = answerLines.reduce((latest, line, index) => /^\s*●\s+\S/u.test(line) ? index : latest, -1);
    answerLines = answerStart >= 0 ? answerLines.slice(answerStart) : [];
  }
  const cleanedAnswerLines: string[] = [];
  for (const line of answerLines) {
    if (!line.trim()) {
      if (cleanedAnswerLines.length > 0 && cleanedAnswerLines[cleanedAnswerLines.length - 1] !== '') cleanedAnswerLines.push('');
      continue;
    }
    if (isTerminalConversationNoise(line, agent)) continue;
    cleanedAnswerLines.push(line.trimEnd());
  }
  while (cleanedAnswerLines[cleanedAnswerLines.length - 1] === '') cleanedAnswerLines.pop();
  if (agent === 'kimi' && cleanedAnswerLines.length > 0) {
    cleanedAnswerLines[0] = cleanedAnswerLines[0].replace(/^\s*[●•]\s+/u, '');
  }
  const answer = cleanedAnswerLines.join('\n').trim();
  const answerPending = activityState === 'working';
  return {
    question: limitConversationText(question, FEISHU_TERMINAL_QUESTION_MAX_CHARS),
    ...(answer ? { answer: limitConversationText(answer, FEISHU_TERMINAL_ANSWER_MAX_CHARS) } : {}),
    ...(answerPending ? { answerPending: true } : {}),
    text: fallback,
  };
}

export function isRemoteSshControlledLane(
  lane: Pick<SupervisorLane, 'remoteSshControl' | 'workspaceId'>,
  workspaces: ReadonlyArray<{ id: WorkspaceId; sshProfileId?: string }>,
): boolean {
  if (lane.remoteSshControl) return true;
  return !!lane.workspaceId
    && !!workspaces.find((workspace) => workspace.id === lane.workspaceId)?.sshProfileId;
}

/** Small reversible adjustments are autonomous; material proposals remain human-gated. */
export function isSupervisorProposalAllowed(outcome: string, proposalKind: string): boolean {
  if (!proposalKind) return true;
  if (proposalKind === 'route-adjustment') return outcome === 'continue' || outcome === 'rework';
  return (proposalKind === 'route-change'
    || proposalKind === 'important'
    || proposalKind === 'context-recovery'
    || proposalKind === 'direction-needed') && outcome === 'needs-human';
}

/** A supervisor may advance work only from a continuation/rework or a human proposal. */
export function isSupervisorNextAllowed(
  outcome: string,
  next: string,
): boolean {
  return !next || outcome === 'continue' || outcome === 'rework' || outcome === 'needs-human';
}

const AUTONOMOUS_BLOCKED_ACTIONS: Array<[RegExp, string]> = [
  [/(?:^|[\s;&|("'`])(?:rm|rmdir|del|erase|rd|ri|remove-item|clear-content|set-content|out-file)\b|删除|(?:覆盖|覆写)(?:.{0,8}(?:文件|数据)|\s+(?:[a-zA-Z]:|\\\\|\/|\.\.?[\\/]|[^\s]+\.[a-z0-9]{1,12}))/i, '删除或覆盖文件'],
  [/\bgit\b[^;；&|\r\n]{0,200}\b(?:push|reset\s+--hard|clean|remote\s+(?:add|remove|set-url))\b/i, '推送或重写 Git 历史'],
  [/\b(?:npm|pnpm|yarn|bun|cargo|twine)\s+(?:publish|release)\b/i, '发布软件包'],
  [/\bgh\s+(?:pr\s+(?:create|merge|close)|release\s+create)\b/i, '对外提交或发布'],
  [/\b(?:curl|invoke-restmethod|invoke-webrequest|irm|iwr)\b[^\r\n]{0,300}(?:-x|--request|-method)\s*(?:delete|post|put|patch)\b/i, '外部写操作'],
  [/\b(?:deploy|release|publish)\b|部署|发布|对外提交/i, '部署、发布或对外提交'],
  [/\b(?:kubectl|helm|terraform|pulumi|aws|az|gcloud)\b/i, '云端或生产环境操作'],
  [/\b(?:production|prod)\b|生产环境|线上环境/i, '生产环境操作'],
  [/(?:\b(?:read|show|print|export|write|modify|change|update|delete|rotate|reset)\b|读取|显示|打印|导出|写入|修改|更改|更新|删除|轮换|重置).{0,24}(?:\b(?:credential|secret|token|password|api[ _-]?key)\b|凭据|密钥|令牌|密码)|(?:\b(?:credential|secret|token|password|api[ _-]?key)\b|凭据|密钥|令牌|密码).{0,24}(?:\b(?:value|content|change|update|delete|rotate|reset)\b|值|内容|变更|更新|删除|轮换|重置)/i, '凭据或权限变更'],
  [/(?:^|\s)(?:sudo|runas)\b|\bstart-process\b[^\n]*\s-verb\s+runas\b|\b(?:set-executionpolicy|takeown|icacls|set-acl|new-localuser|add-localgroupmember)\b|管理员权限|系统权限/i, '管理员权限或系统权限变更'],
];

/** Returns why an AI-proposed action must remain a human decision. */
export function autonomousActionBlockReason(action: string): string | null {
  const text = action.trim();
  if (!text) return null;
  for (const [pattern, reason] of AUTONOMOUS_BLOCKED_ACTIONS) {
    const matches = text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
    for (const match of matches) {
      const actionOffset = Math.max(0, match[0].search(/[a-zA-Z\u3400-\u9fff]/u));
      if (!isNegatedMatch(text, (match.index ?? 0) + actionOffset)) return reason;
    }
  }
  return null;
}

const REMOTE_SSH_HUMAN_ACTIONS: Array<[RegExp, string]> = [
  [
    /(?:^|[\s;&|])(?:unlink|shred)\b|\bfind\b[^\r\n]{0,240}\s-delete\b|\brsync\b[^\r\n]{0,240}\s--delete\b|\btruncate\b[^\r\n]{0,120}\s-s\s*0\b|\bgit\b[^\r\n]{0,160}\brestore\b|\bgit\b[^\r\n]{0,160}\bcheckout\s+--(?:\s|$)|\b(?:cp|mv)\b[^\r\n]{0,160}\s-f\b|\b(?:move-item|copy-item)\b[^\r\n]{0,160}\s-force\b|清理.{0,20}(?:文件|目录|日志|缓存|数据)/i,
    '删除或破坏性覆盖远程文件',
  ],
  [
    /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade|remove|uninstall)\b|\b(?:pip|pip3|uv)\s+(?:install|uninstall|sync|add|remove|upgrade)\b|\bcargo\s+(?:install|uninstall|add|remove|update)\b|\bgo\s+(?:get|install)\b|\bdotnet\s+(?:add|remove)(?:\s+\S+)?\s+package\b|\b(?:apt(?:-get)?|yum|dnf|pacman|zypper|apk|brew|choco|winget|scoop)\s+(?:install|remove|uninstall|update|upgrade|add)\b|(?:安装|卸载|升级|更新).{0,12}(?:软件包|系统包|依赖)/i,
    '安装、卸载或升级软件包',
  ],
  [
    /\b(?:systemctl|service)\s+(?:start|stop|restart|reload|enable|disable|mask|unmask)\b|\bsc(?:\.exe)?\s+(?:start|stop|config|create|delete|failure)\b|\b(?:start-service|stop-service|restart-service|set-service|new-service|kill|pkill|killall|taskkill|stop-process|start-process)\b|\b(?:reboot|shutdown|halt|poweroff|restart-computer|stop-computer)\b|\b(?:docker|podman)\s+(?:stop|kill|restart|rm|rmi|system\s+prune)\b|\b(?:docker|podman)\s+compose\s+(?:down|stop|restart|rm)\b|\b(?:pm2|supervisorctl)\s+(?:start|stop|restart|reload|delete)\b|(?:启动|停止|重启|重载|启用|禁用).{0,10}(?:服务|进程|守护进程)|(?:终止|杀死).{0,10}(?:进程|任务)/i,
    '服务、进程或主机状态变更',
  ],
  [
    /\bwmux\b[^\r\n]{0,240}\bsend-key\s+c\b[^\r\n]{0,120}\s--ctrl\b/i,
    '向 SSH 任务终端发送中断信号',
  ],
  [
    /(?:\b(?:approve|allow|confirm)\b|确认|批准|允许|授权).{0,32}(?:\b(?:permission|privilege|elevation)\b|权限|提权)|(?:\b(?:permission|privilege|elevation)\b|权限|提权).{0,32}(?:\b(?:approve|allow|confirm)\b|确认|批准|允许|授权)/i,
    'SSH 远端权限批准',
  ],
  [
    /\b(?:chmod|chown|chgrp|setfacl|setcap|usermod|useradd|userdel|groupadd|groupdel|passwd|visudo|mount|umount|mkfs(?:\.\w+)?|fdisk|parted|iptables|nft|ufw|firewall-cmd|semanage|setenforce|sysctl)\b|\b(?:icacls|set-acl|takeown|netsh|bcdedit|diskpart)\b|(?:修改|变更|调整).{0,10}(?:权限|所有者|用户组|防火墙|系统配置)|(?:挂载|卸载|格式化).{0,10}(?:磁盘|文件系统|分区)/i,
    '权限、账户、网络或系统配置变更',
  ],
  [
    /\b(?:drop|truncate)\s+(?:database|schema|table)\b|\bdelete\s+from\b|\balter\s+(?:database|schema|table)\b|(?:删除|清空).{0,10}(?:数据库|数据表|远程数据)/i,
    '远程数据库破坏性变更',
  ],
];

/** Returns why an SSH-controlling worker must hand an otherwise allowed action to a human. */
export function remoteSshActionBlockReason(action: string): string | null {
  const text = action.trim();
  if (!text) return null;
  const generalBlockReason = autonomousActionBlockReason(text);
  if (generalBlockReason) return generalBlockReason;
  for (const [pattern, reason] of REMOTE_SSH_HUMAN_ACTIONS) {
    const matches = text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
    for (const match of matches) {
      const actionOffset = Math.max(0, match[0].search(/[a-zA-Z\u3400-\u9fff]/u));
      if (!isNegatedMatch(text, (match.index ?? 0) + actionOffset)) return reason;
    }
  }
  return null;
}

const CONFIGURED_FORBIDDEN_ACTIONS: Record<SupervisorForbiddenAction, [RegExp, string]> = {
  'new-dependencies': [
    /\bnpm\s+(?:i|install|update)\b|\b(?:pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade)\b|\b(?:cargo|pip|uv)\s+(?:install|add|update|upgrade)\b|\bgo\s+get\b|\bdotnet\s+add(?:\s+\S+)?\s+package\b|\bcomposer\s+require\b|新增.{0,12}依赖|升级.{0,12}依赖/i,
    '新增或升级第三方依赖',
  ],
  'public-api-change': [
    /\b(?:breaking\s+change|public\s+api)\b|改变.{0,16}(?:对外|公共).{0,8}(?:API|接口|协议)|破坏.{0,8}兼容/i,
    '改变对外 API、协议或兼容行为',
  ],
  'large-refactor': [
    /大范围.{0,8}重构|跨模块.{0,8}(?:重构|改写)|目录迁移|全量重写|rewrite\s+(?:all|entire)/i,
    '大范围重构或目录迁移',
  ],
  'weaken-tests': [
    /删除.{0,12}测试|跳过.{0,12}测试|弱化.{0,12}(?:测试|验收)|\b(?:disable|skip|remove)\b.{0,24}\btests?\b/i,
    '删除、跳过或弱化测试',
  ],
  'build-release-config': [
    /(?:修改|编辑|调整|更新|改动|重写).{0,16}(?:构建|发布|部署).{0,8}配置|\b(?:modify|edit|update|change)\b.{0,24}\b(?:electron-builder|dockerfile|\.github[\\/]workflows)\b/i,
    '修改构建、发布或部署配置',
  ],
  'external-network': [
    /\b(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|web[_-]?search)\b|访问外部网络|调用外部服务/i,
    '访问外部网络或调用外部服务',
  ],
};

function isNegatedMatch(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 64), index);
  const boundary = /[，。；;！？!?\n]|(?:但(?:是)?|不过|然而|而是|改为|然后|随后|接着|\bthen\b|\bbut\b|\binstead\b)/gi;
  let clauseStart = 0;
  for (const match of prefix.matchAll(boundary)) {
    clauseStart = (match.index ?? 0) + match[0].length;
  }
  const clausePrefix = prefix.slice(clauseStart);
  return /(?:不要|不得|禁止|严禁|避免|不可|不能|不允许|绝不|无需|无须)[^，。；;！？!?\n]{0,28}$/i.test(clausePrefix);
}

/** Returns a selected project restriction that matches the proposed action text. */
export function configuredActionBlockReason(
  action: string,
  forbiddenActions: readonly SupervisorForbiddenAction[],
): string | null {
  const text = action.trim();
  if (!text) return null;
  for (const forbidden of forbiddenActions) {
    const rule = CONFIGURED_FORBIDDEN_ACTIONS[forbidden];
    if (!rule) continue;
    const [pattern, reason] = rule;
    const matches = text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
    for (const match of matches) {
      const actionOffset = Math.max(0, match[0].search(/[a-zA-Z\u3400-\u9fff]/u));
      if (!isNegatedMatch(text, (match.index ?? 0) + actionOffset)) return reason;
    }
  }
  return null;
}

function normalizeAbsolutePath(value: string): string | null {
  const normalized = value.trim().replace(/[),;!?]+$/, '').replace(/\\/g, '/');
  let prefix: string;
  let rest: string;

  const drive = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (drive) {
    prefix = `${drive[1].toLowerCase()}:`;
    rest = drive[2];
  } else if (normalized.startsWith('//')) {
    const parts = normalized.slice(2).split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    prefix = `//${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
    rest = parts.slice(2).join('/');
  } else if (normalized.startsWith('/')) {
    prefix = '';
    rest = normalized.slice(1);
  } else {
    return null;
  }

  const caseInsensitive = !!prefix;
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(caseInsensitive ? segment.toLowerCase() : segment);
  }
  const suffix = segments.join('/');
  if (!prefix) return `/${suffix}`;
  return suffix ? `${prefix}/${suffix}` : `${prefix}/`;
}

type ScopePathStyle = 'windows' | 'posix';

function absolutePathStyle(value: string): ScopePathStyle | null {
  const normalized = value.trim().replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')) return 'windows';
  return normalized.startsWith('/') ? 'posix' : null;
}

function pathMatches(action: string, pattern: RegExp): string[] {
  return [...action.matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}

function extractPathReferences(action: string, style: ScopePathStyle): { absolute: string[]; relative: string[] } {
  // URI paths are network destinations, not local filesystem references. They
  // are governed separately by the external-network restriction.
  const quotedAbsolute: string[] = [];
  const withoutStandaloneQuotedPaths = action.replace(/(["'])(.*?)\1/g, (whole, _quote: string, value: string) => {
    if (absolutePathStyle(value) === style) {
      quotedAbsolute.push(value);
      return ' ';
    }
    return whole;
  });
  const text = withoutStandaloneQuotedPaths.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>|]+/gi, ' ');
  const boundary = '(?:^|[\\s(\\x22\\x27\\x60=,:])';
  const absolute = style === 'windows'
    ? [
        ...quotedAbsolute,
        ...pathMatches(text, new RegExp(`${boundary}([a-zA-Z]:[\\\\/][^\\s\\x22\\x27\\x60<>|]*)`, 'g')),
        ...pathMatches(text, new RegExp(`${boundary}((?:\\\\\\\\|//)[^\\\\/\\s\\x22\\x27\\x60<>|]+[\\\\/][^\\s\\x22\\x27\\x60<>|]*)`, 'g')),
        ...pathMatches(text, new RegExp('(?:^|[\\s(\\x22\\x27\\x60=,])(\\\\(?!\\\\)[^\\s\\x22\\x27\\x60<>|]+)', 'g')),
      ]
    : [
        ...quotedAbsolute,
        ...pathMatches(text, new RegExp(`${boundary}(/[^\\s\\x22\\x27\\x60<>|]*)`, 'g')),
      ];
  const relative = text
    .split(/[\s"'`=,:()]+/)
    .map((candidate) => candidate.replace(/[),;；!?！？]+$/, ''))
    .filter((candidate) => candidate.split(/[\\/]/).includes('..'));
  return { absolute, relative };
}

function resolveRelativePath(root: string, relative: string): string | null {
  return normalizeAbsolutePath(`${root.replace(/\/$/, '')}/${relative}`);
}

/** Explicit absolute paths outside the selected lane's immutable project root are never autonomous. */
export function workScopeBlockReason(
  action: string,
  workScope: SupervisorWorkScope,
  projectDir?: string,
): string | null {
  const root = projectDir?.trim();
  if (!root) return action.trim() ? '当前终端未上报工程文件夹' : null;
  const normalizedRoot = normalizeAbsolutePath(root);
  if (!normalizedRoot) return action.trim() ? '当前终端工程文件夹不是可校验的绝对路径' : null;
  const style = absolutePathStyle(root);
  if (!style) return action.trim() ? '当前终端工程文件夹不是可校验的绝对路径' : null;
  if (/\$(?:env:)?[a-z_][\w]*[\\/]|%[a-z_][\w]*%[\\/]|(?:^|\s)~[\\/]/i.test(action)) {
    return '使用了无法静态校验的工程外路径变量';
  }
  const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  const references = extractPathReferences(action, style);
  const outside = references.absolute.find((candidate) => {
    const normalized = normalizeAbsolutePath(candidate);
    return !!normalized && normalized !== normalizedRoot && !normalized.startsWith(rootPrefix);
  });
  if (outside) return '引用了当前工程文件夹之外的绝对路径';
  const traversesOutside = references.relative.some((candidate) => {
    const normalized = resolveRelativePath(normalizedRoot, candidate);
    return !!normalized && normalized !== normalizedRoot && !normalized.startsWith(rootPrefix);
  });
  if (traversesOutside) return '通过相对路径引用了当前工程文件夹之外的位置';
  if (workScope !== 'project' && /(?:全仓|整个工程|所有文件|无关文件|顺手(?:清理|修改|重构)|\b(?:entire|whole)\s+(?:repo|project)\b)/i.test(action)) {
    return workScope === 'plan-defined' ? '动作超出了计划文件限定范围' : '动作超出了当前任务直接涉及的文件范围';
  }
  return null;
}

export function isAutonomousPermissionResponseAllowed(response: string): boolean {
  return /^(?:y|yes|allow|approve)$/i.test(response.trim());
}

interface SupervisorAgentStateView {
  state?: string;
  blockedReason?: string | null;
  blockedVersion?: number;
  blockedRequestId?: string | null;
  sessionId?: string | null;
  updatedAt?: number;
}

function isPermissionBlockedState(
  state: SupervisorAgentStateView | undefined,
): state is SupervisorAgentStateView & { state: 'blocked' } {
  return state?.state === 'blocked'
    && /\b(?:permission|approval|allowance)\b|权限|授权/i.test(state.blockedReason || '');
}

function isQuestionBlockedState(
  state: SupervisorAgentStateView | undefined,
): state is SupervisorAgentStateView & { state: 'blocked' } {
  return state?.state === 'blocked'
    && /question|input|choice|choose|select|prompt|询问|选择|输入|问题|决定/i.test(state.blockedReason || '');
}

const USER_ONLY_DECISION = /\b(?:terms?|billing|payment|purchase|subscription|account|login|credential|secret|token|password|privacy|licen[cs]e|shipping|delivery|address|order)\b|条款|付费|支付|购买|账单|套餐|订阅|账号|账户|登录|凭据|密钥|令牌|密码|隐私|许可|收货|配送|地址|订单|业务取舍|用户偏好/i;
const TECHNICAL_DECISION = /\b(?:technical|implementation|code|test|build|compile|type|interface|adapter|algorithm|module|file|path)\b|技术|实现|代码|测试|构建|编译|类型|接口|适配|算法|模块|文件|路径/i;

function isLowRiskTechnicalQuestion(
  state: SupervisorAgentStateView | undefined,
  proposedAnswer: string,
): boolean {
  if (!isQuestionBlockedState(state)) return false;
  const blockedReason = state.blockedReason || '';
  return !USER_ONLY_DECISION.test(`${blockedReason}\n${proposedAnswer}`)
    && TECHNICAL_DECISION.test(`${blockedReason}\n${proposedAnswer}`);
}

/** Hooks also report an idle agent waiting for another prompt as blocked. It is not a decision blocker. */
function isAwaitingNextPromptState(
  state: SupervisorAgentStateView | undefined,
): state is SupervisorAgentStateView & { state: 'blocked' } {
  return state?.state === 'blocked'
    && /\b(?:wait(?:ing)?|await(?:ing)?)\b.{0,32}\b(?:next|another|new)\b.{0,16}\b(?:prompt|instruction|message|task)\b|等待.{0,16}(?:下一|新的).{0,12}(?:提示|指令|消息|任务|输入)/iu
      .test(state.blockedReason || '');
}

function blockedRequestAlreadyAnswered(lane: SupervisorLane, state: SupervisorAgentStateView): boolean {
  if (state.blockedRequestId) return lane.lastBlockedResponseId === state.blockedRequestId;
  return typeof state.blockedVersion === 'number'
    && lane.lastBlockedResponseVersion === state.blockedVersion;
}

function selectedAutonomyPermissions(value: unknown): readonly SupervisorAutonomyPermission[] {
  if (value === undefined) return DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS;
  return Array.isArray(value)
    ? value.filter((item): item is SupervisorAutonomyPermission =>
      (DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS as readonly unknown[]).includes(item))
    : [];
}

function inferredNextPermissions(next: string): SupervisorAutonomyPermission[] {
  const permissions: SupervisorAutonomyPermission[] = [];
  if (/选择.{0,12}方案|采用.{0,12}方案|方案\s*[A-Z]\b|\b(?:choose|select|adopt)\b.{0,20}\b(?:option|approach|solution)\b/i.test(next)) {
    permissions.push('technical-choice');
  }
  if (/改用|切换到|调整.{0,8}(?:路线|方案|实现)|替代方案|放弃.{0,16}(?:实现|方案|路线)|从头(?:重做|实现)|重新(?:设计|实现)|推翻|迁移到|全面重写|\b(?:switch|replace|alternative|discard|redesign|migrate|rewrite|start\s+over)\b/i.test(next)) {
    permissions.push('route-adjustment');
  }
  return permissions;
}

function requiredAutonomyPermissions(opts: {
  outcome: string;
  next: string;
  proposalKind: string;
  permissionCommand: string;
  permissionResponse: string;
  agentState?: SupervisorAgentStateView;
}): SupervisorAutonomyPermission[] {
  if (opts.outcome === 'needs-human') return [];
  if (opts.permissionCommand || opts.permissionResponse) return ['permission-confirm'];
  if (!opts.next) return [];
  const required = inferredNextPermissions(opts.next);
  if (opts.proposalKind === 'route-adjustment') required.push('route-adjustment');
  if (isLowRiskTechnicalQuestion(opts.agentState, opts.next)) required.push('technical-choice');
  if (required.length === 0) required.push('same-route-next');
  return [...new Set(required)];
}


function terminalScreenTail(surfaceId: string, lines = 24): string {
  return readTerminalScreen(surfaceId, lines).text?.trim() || '';
}

interface SupervisorDeliveryObservation {
  confirmed: boolean;
  agentState: string;
  screenChanged: boolean;
}

const supervisorDeliveriesInFlight = new Set<string>();

async function observeSupervisorDelivery(
  surfaceId: string,
  beforeScreen: string,
  beforeAgentState: SupervisorAgentStateView | undefined,
  timeoutMs = 2_000,
): Promise<SupervisorDeliveryObservation> {
  let agentState = 'unknown';
  let screenChanged = false;
  const attempts = Math.max(1, Math.ceil(timeoutMs / 100));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const currentState = ((window as any).__wmux_getAgentStates?.() || {})[surfaceId] as SupervisorAgentStateView | undefined;
    agentState = String(currentState?.state || 'unknown');
    screenChanged = terminalScreenTail(surfaceId) !== beforeScreen;
    const blockedStateChanged = agentState === 'blocked' && (
      beforeAgentState?.state !== 'blocked'
      || currentState?.blockedVersion !== beforeAgentState.blockedVersion
      || currentState?.blockedRequestId !== beforeAgentState.blockedRequestId
    );
    // Screen repaint alone is not an acknowledgement: delayed body echo and
    // unrelated terminal output can both change it before the task is accepted.
    if (agentState === 'working' || blockedStateChanged) {
      return { confirmed: true, agentState, screenChanged };
    }
    if (attempt + 1 < attempts) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
  }
  return { confirmed: false, agentState, screenChanged };
}

function normalizedEvidenceText(value: string): string {
  return value.toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();
}

export function permissionCommandMatchesEvidence(command: string, evidence: string): boolean {
  const normalizedCommand = normalizedEvidenceText(command);
  const activePrompt = evidence
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join('\n');
  const normalizedEvidence = normalizedEvidenceText(activePrompt);
  if (normalizedCommand.length < 3 || !normalizedEvidence) return false;
  if (/^(?:permission|approval|allowance|command|request|权限|授权|批准|命令|请求)(?:\s+required)?$/i.test(normalizedCommand)) {
    return false;
  }
  const hasActivePromptMarker = /\b(?:permission|approval|approve|allow|authorize|confirm|continue)\b|\[(?:y\/n|yes\/no)\]|权限|授权|批准|确认|是否继续/i.test(activePrompt);
  return hasActivePromptMarker && normalizedEvidence.includes(normalizedCommand);
}

function permissionCommandSignature(command: string): string {
  const text = normalizedEvidenceText(command);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function permissionConfirmationLoopReason(
  lane: Pick<SupervisorLane, 'permissionConfirmations'>,
  command: string,
): string | null {
  const signature = permissionCommandSignature(command);
  let consecutive = 0;
  for (let index = (lane.permissionConfirmations || []).length - 1; index >= 0; index -= 1) {
    if (lane.permissionConfirmations![index].commandSignature !== signature) break;
    consecutive += 1;
  }
  return consecutive >= 2
    ? '同一权限命令已连续自动确认 2 次仍再次阻塞；必须改变执行路径或交回上级判断'
    : null;
}

const AUTONOMY_PERMISSION_LABELS: Record<SupervisorAutonomyPermission, string> = {
  'same-route-next': '继续原路线的低风险下一步',
  'technical-choice': '回答低风险技术问题或方案选择',
  'route-adjustment': '小范围可逆路线调整',
  'permission-confirm': '确认低风险权限请求',
};

interface RemoteSupervisorStart {
  action: 'start';
  terminals: string[];
  stopWhen: string;
  stopWhenKind: 'concrete' | 'direction';
  taskGoal?: string;
  taskDescription?: string;
  preconditions?: string;
  supervisorNotes?: string;
  planFile?: string;
  autonomous: boolean;
  supervisorLaunchCmd?: string;
  supervisorModel?: string;
  supervisorReasoningEffort?: string;
  autonomyPermissions?: SupervisorAutonomyPermission[];
  actor?: string;
  projectWorkItemId?: string;
  projectManagerProjectId?: string;
  taskWorkMode?: TaskWorkMode;
  mainThreadResponsibility?: string;
  childThreadResponsibilities?: string[];
  maxChildThreads?: number;
  supervisorMayApproveThreads?: boolean;
  parallelizableOperations?: string[];
  serializedOperations?: string[];
  waitForNextDirection?: boolean;
  /** Project mode starts the supervisor first; the supervisor later replaces this reserved worker ID. */
  projectTaskBootstrap?: {
    reservedSurfaceId: SurfaceId;
    label: string;
    projectDir: string;
  };
}

interface RemoteTerminalTask {
  action: 'send';
  terminal: string;
  task: string;
  actor?: string;
  force?: boolean;
  mode?: 'project';
}

interface RemoteTerminalEscape {
  action: 'terminal-escape';
  terminal: string;
  actor?: string;
  mode?: 'project';
}

interface RemoteTerminalInterrupt {
  action: 'terminal-interrupt';
  terminal: string;
  actor?: string;
  mode?: 'project';
}

interface RemoteSupervisorMessage {
  action: 'send-supervisor-message';
  terminal: string;
  message: string;
  actor?: string;
}

interface RemoteWaitingDecision {
  action: 'waiting-decision';
  terminal: string;
  decision: 'keep' | 'resume' | 'submit' | 'stop';
  message?: string;
  actor?: string;
}

interface RemoteDirectTerminalTask {
  action: 'create-task';
  name: string;
  task: string;
  agent?: 'codex' | 'kimi' | 'grok';
  model?: string;
  reasoningEffort?: string;
  preset?: 'project-manager' | 'user-records';
  replaceProjectManager?: boolean;
  cwd: string;
  displayPath?: string;
  anchorWorkspace?: string;
  anchorTerminal?: string;
  projectManagerProjectId?: string;
  projectManagerWorkItemId?: string;
  actor?: string;
}

interface RemoteTaskTerminalLocation {
  surfaceId: SurfaceId;
  paneId: PaneId;
  workspaceId: WorkspaceId;
  workspaceTitle: string;
  projectDir?: string;
  cwd?: string;
  label: string;
  remoteSshControl: boolean;
  surface: SurfaceRef;
}

type RemoteProjectTerminalRole = 'project-ai' | 'supervisor-ai' | 'task-ai';

interface RemoteProjectTerminalLocation extends RemoteTaskTerminalLocation {
  role: RemoteProjectTerminalRole;
  projectId: string;
  projectName: string;
  workItemId?: string;
  workItemTitle?: string;
}

interface RemoteOrdinaryMonitoringTerminal extends RemoteTaskTerminalLocation {
  role: 'supervisor-ai' | 'task-ai';
  lane?: SupervisorLane;
}

type RemoteTerminalActivityState = 'idle' | 'working' | 'blocked' | 'unknown';

interface RemoteTerminalTaskResult {
  ok: boolean;
  message: string;
  error?: string;
  code?: 'terminal_busy';
  terminal?: {
    surfaceId: SurfaceId;
    label: string;
    workspace: string;
    activityState: RemoteTerminalActivityState;
    activityUpdatedAt: number | null;
  };
}

function publicDecisionTaskGoal(session: SupervisorSession, lane: SupervisorLane): string {
  const configuredGoal = effectiveSupervisorTaskGoal(lane);
  if (configuredGoal) return configuredGoal.slice(0, 800);
  const currentTask = lane.currentTask?.trim() || '';
  const privatePlanningMarker = /(?:^|[\n。；;])\s*(?:下一步|方案\s*[A-Za-z0-9一二三四五六七八九十]+|AI\s*建议|推荐方案)\s*[：:]?/u;
  const markerIndex = currentTask.search(privatePlanningMarker);
  const publicSummary = markerIndex > 0 ? currentTask.slice(0, markerIndex).trim() : currentTask;
  if (!publicSummary || /方案\s*[A-Za-z0-9一二三四五六七八九十]+/u.test(publicSummary)) {
    return `完成 ${lane.label} 当前任务（未单独设置任务目标）`;
  }
  return publicSummary.slice(0, 800);
}

const REMOTE_WORKING_STATE_MAX_AGE_MS = 15 * 60 * 1000;

function remoteTerminalActivity(surfaceId: SurfaceId, preserveStaleWorking = false): {
  activityState: RemoteTerminalActivityState;
  activityUpdatedAt: number | null;
} {
  const record = (window as any).__wmux_getAgentStates?.()?.[surfaceId];
  const updatedAt = Number.isFinite(record?.updatedAt) ? Number(record.updatedAt) : null;
  const state = ['idle', 'working', 'blocked', 'unknown'].includes(String(record?.state))
    ? record.state as RemoteTerminalActivityState
    : 'unknown';
  if (!preserveStaleWorking && state === 'working' && (!updatedAt || Date.now() - updatedAt > REMOTE_WORKING_STATE_MAX_AGE_MS)) {
    return { activityState: 'unknown', activityUpdatedAt: updatedAt };
  }
  return { activityState: state, activityUpdatedAt: updatedAt };
}

function remoteTaskTerminalLocation(
  surface: SurfaceRef,
  paneId: PaneId,
  workspace: { id: WorkspaceId; title: string; cwd?: string; sshProfileId?: string },
): RemoteTaskTerminalLocation {
  return {
    surfaceId: surface.id,
    paneId,
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
    projectDir: workspace.cwd || surface.currentCwd || surface.cwd,
    cwd: surface.currentCwd || surface.cwd || workspace.cwd,
    label: remoteTerminalLabel(surface),
    remoteSshControl: !!workspace.sshProfileId,
    surface,
  };
}

function collectRemoteTerminals(tree: SplitNode, workspace: { id: WorkspaceId; title: string; cwd?: string; sshProfileId?: string }, out: RemoteTaskTerminalLocation[]): void {
  if (tree.type !== 'leaf') {
    collectRemoteTerminals(tree.children[0], workspace, out);
    collectRemoteTerminals(tree.children[1], workspace, out);
    return;
  }
  for (const surface of tree.surfaces) {
    if (surface.type !== 'terminal') continue;
    const label = remoteTerminalLabel(surface);
    if (label.startsWith(SUPERVISOR_TAB_TITLE) || label === 'AI Supervisor') continue;
    out.push(remoteTaskTerminalLocation(surface, tree.paneId, workspace));
  }
}

function remoteTerminalList(): RemoteTaskTerminalLocation[] {
  const store = useStore.getState();
  const terminals: ReturnType<typeof remoteTerminalList> = [];
  for (const workspace of store.workspaces) {
    const projectRuntimeWorkspace = getAllPaneIds(workspace.splitTree).some((paneId) => (
      findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
        !!surface.projectManagerTerminal
        || !!surface.projectSupervisorProjectId
        || !!surface.projectManagerProjectId
      ))
    ));
    const dedicatedSupervisorWorkspace = (workspace.transientSupervisorWorkspace === true && !projectRuntimeWorkspace)
      || workspace.title.replace(/\s+/gu, '') === SUPERVISOR_WORKSPACE_TITLE.replace(/\s+/gu, '');
    if (dedicatedSupervisorWorkspace) continue;
    collectRemoteTerminals(workspace.splitTree, workspace, terminals);
  }
  const supervisorIds = new Set(store.supervisor.lanes.map(dedicatedSupervisorSurfaceId).filter(Boolean));
  return terminals.filter((terminal) => (
    !supervisorIds.has(terminal.surfaceId) && terminal.surface.projectManagerTerminal !== true
  ));
}

function locateRemoteTaskTerminal(surfaceId: string): { terminal?: RemoteTaskTerminalLocation; error?: string } {
  if (!surfaceId) return { error: '缺少任务终端 ID。' };
  const terminal = remoteTerminalList().find((item) => item.surfaceId === surfaceId);
  if (terminal) return { terminal };

  const store = useStore.getState();
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const surface = findLeaf(workspace.splitTree, paneId)?.surfaces.find((item) => item.id === surfaceId);
      if (!surface) continue;
      if (surface.type !== 'terminal') return { error: '目标不是任务终端。' };
      return { error: '目标是专属监督 AI 终端，不能通过任务终端控制入口操作。' };
    }
  }
  return { error: '目标任务终端不存在、已关闭或属于其他窗口；请刷新终端列表。' };
}

function locateRemoteSupervisorTerminal(identifier: string): {
  lane?: SupervisorLane;
  supervisorSurfaceId?: SurfaceId;
  workspaceTitle?: string;
  error?: string;
} {
  if (!identifier) return { error: '缺少 AI 监督终端 ID。' };
  const store = useStore.getState();
  const lane = store.supervisor.lanes.find((item) => (
    item.surfaceId === identifier
    || item.managementSessionId === identifier
    || dedicatedSupervisorSurfaceId(item) === identifier
  ));
  if (!lane) return { error: '没有找到对应的 AI 监督通道；请刷新监督终端列表。' };
  const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
  if (!supervisorSurfaceId) return { error: `${lane.label} 没有可查看的专属监督 AI 终端。` };

  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const surface = findLeaf(workspace.splitTree, paneId)?.surfaces.find((item) => item.id === supervisorSurfaceId);
      if (surface?.type === 'terminal') {
        return { lane, supervisorSurfaceId, workspaceTitle: workspace.title };
      }
    }
  }
  return { error: `${lane.label} 的 AI 监督终端（管家）已缺失；请在 wmux 中重新配置。` };
}

function locateRemoteTaskSession(
  params: Pick<RemoteDirectTerminalTask, 'anchorWorkspace' | 'anchorTerminal' | 'projectManagerProjectId'>,
  allowProjectManagedAnchor = false,
): { terminal?: RemoteTaskTerminalLocation; error?: string } {
  const eligibleTerminals = remoteTerminalList().filter((terminal) => (
    allowProjectManagedAnchor
      ? !params.projectManagerProjectId
        || terminal.surface.projectManagerProjectId === params.projectManagerProjectId
      : !terminal.surface.projectManagerProjectId && !terminal.surface.projectManagerWorkItemId
  ));
  if (params.anchorWorkspace) {
    const terminal = eligibleTerminals.find((item) => item.workspaceId === params.anchorWorkspace);
    if (terminal) return { terminal };
    if (allowProjectManagedAnchor && params.projectManagerProjectId) {
      const workspace = useStore.getState().workspaces.find((item) => item.id === params.anchorWorkspace);
      if (workspace?.transientSupervisorWorkspace === true) {
        for (const paneId of getAllPaneIds(workspace.splitTree)) {
          const projectSurface = findLeaf(workspace.splitTree, paneId)?.surfaces.find((surface) => (
            surface.type === 'terminal'
            && (
              surface.projectSupervisorProjectId === params.projectManagerProjectId
              || surface.projectManagerProjectId === params.projectManagerProjectId
            )
          ));
          if (projectSurface) {
            return { terminal: remoteTaskTerminalLocation(projectSurface, paneId, workspace) };
          }
        }
      }
    }
    return { error: '目标会话不存在、已关闭或当前没有可用任务终端。' };
  }
  const terminalId = String(params.anchorTerminal || '');
  if (!terminalId) return { error: '缺少任务终端 ID。' };
  const terminal = eligibleTerminals.find((item) => item.surfaceId === terminalId);
  return terminal
    ? { terminal }
    : { error: '目标任务终端不存在、已关闭或属于项目管理模式。' };
}

/** Project runtimes are deliberately absent from ordinary terminal controls. */
function remoteProjectTerminalList(): RemoteProjectTerminalLocation[] {
  const store = useStore.getState();
  const terminals: RemoteProjectTerminalLocation[] = [];
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      for (const surface of findLeaf(workspace.splitTree, paneId)?.surfaces || []) {
        if (surface.type !== 'terminal') continue;
        const role: RemoteProjectTerminalRole | undefined = surface.projectManagerTerminal
          ? 'project-ai'
          : surface.projectSupervisorProjectId
            ? 'supervisor-ai'
            : surface.projectManagerProjectId
              ? 'task-ai'
              : undefined;
        const projectId = role === 'supervisor-ai'
          ? surface.projectSupervisorProjectId
          : surface.projectManagerProjectId;
        if (!role || !projectId) continue;
        const project = store.projectManagers.find((candidate) => candidate.id === projectId);
        const lane = store.supervisor.lanes.find((candidate) => (
          candidate.projectManagerProjectId === projectId
          && (candidate.surfaceId === surface.id || candidate.supervisorSurfaceId === surface.id)
        ));
        const workItemId = surface.projectManagerWorkItemId || lane?.projectWorkItemId;
        const workItem = project?.workItems.find((candidate) => candidate.id === workItemId);
        terminals.push({
          ...remoteTaskTerminalLocation(surface, paneId, workspace),
          role,
          projectId,
          projectName: project ? projectDisplayName(project) : projectId,
          workItemId,
          workItemTitle: workItem?.title || lane?.label,
        });
      }
    }
  }
  return terminals;
}

function remoteSurfaceTerminalLocation(surfaceId: string): RemoteTaskTerminalLocation | undefined {
  const store = useStore.getState();
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const surface = findLeaf(workspace.splitTree, paneId)?.surfaces.find((candidate) => (
        candidate.id === surfaceId && candidate.type === 'terminal'
      ));
      if (surface) return remoteTaskTerminalLocation(surface, paneId, workspace);
    }
  }
  return undefined;
}

/** The ordinary-mode monitor includes both worker Agents and their dedicated supervisors. */
function remoteOrdinaryMonitoringTerminalList(): RemoteOrdinaryMonitoringTerminal[] {
  const state = useStore.getState().supervisor;
  const ordinaryLanes = state.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane));
  const laneByTaskSurface = new Map(ordinaryLanes.map((lane) => [lane.surfaceId, lane]));
  const taskTerminals: RemoteOrdinaryMonitoringTerminal[] = remoteTerminalList()
    .filter((terminal) => (
      !terminal.surface.projectManagerProjectId
      && !terminal.surface.projectManagerWorkItemId
    ))
    .map((terminal) => ({
      ...terminal,
      role: 'task-ai',
      lane: laneByTaskSurface.get(terminal.surfaceId),
    }));
  const supervisorTerminals = ordinaryLanes.flatMap((lane): RemoteOrdinaryMonitoringTerminal[] => {
    const surfaceId = dedicatedSupervisorSurfaceId(lane);
    if (!surfaceId) return [];
    const terminal = remoteSurfaceTerminalLocation(surfaceId);
    return terminal ? [{ ...terminal, role: 'supervisor-ai', lane }] : [];
  });
  return [...taskTerminals, ...supervisorTerminals];
}

function locateRemoteProjectTerminal(surfaceId: string): {
  terminal?: RemoteProjectTerminalLocation;
  error?: string;
} {
  if (!surfaceId) return { error: '缺少项目模式终端 ID。' };
  const terminal = remoteProjectTerminalList().find((candidate) => candidate.surfaceId === surfaceId);
  return terminal
    ? { terminal }
    : { error: '目标不属于项目 AI 模式、已经关闭或已被新运行时替代；请刷新终端列表。' };
}

function currentUserRecordsTerminal(): RemoteTaskTerminalLocation | undefined {
  return remoteTerminalList().find((terminal) => terminal.surface.userRecordsTerminal === true);
}

function focusRemoteTerminal(terminal: RemoteTaskTerminalLocation): void {
  const store = useStore.getState();
  store.selectWorkspace(terminal.workspaceId);
  const workspace = useStore.getState().workspaces.find((item) => item.id === terminal.workspaceId);
  const leaf = workspace && findLeaf(workspace.splitTree, terminal.paneId);
  const index = leaf?.surfaces.findIndex((surface) => surface.id === terminal.surfaceId) ?? -1;
  if (index >= 0) store.selectSurface(terminal.workspaceId, terminal.paneId, index);
}

function createRemoteDirectTerminalTask(
  params: RemoteDirectTerminalTask,
  allowProjectManagedCreate = false,
): { ok: boolean; message: string; error?: string; surfaceId?: string } {
  const name = String(params.name || '').trim();
  const task = String(params.task || '').trim();
  const cwd = String(params.cwd || '').trim();
  const requestedAgent = String(params.agent || 'codex').trim().toLowerCase();
  const model = String(params.model || '').trim();
  const reasoningEffort = String(params.reasoningEffort || '').trim();
  const projectManager = params.preset === 'project-manager';
  const userRecordsTerminal = params.preset === 'user-records';
  const agent = userRecordsTerminal
    ? USER_RECORDS_TERMINAL_AGENT
    : projectTaskTerminalAgent(params.agent);
  const requestsProjectManagedCreate = !!(
    projectManager || params.projectManagerProjectId || params.projectManagerWorkItemId
  );
  if (requestsProjectManagedCreate && !allowProjectManagedCreate) {
    return { ok: false, error: '项目管理终端只能由项目管理模式创建。', message: '' };
  }
  if (!name || !task) return { ok: false, error: '任务名称和首条任务都不能为空。', message: '' };
  if (!['codex', 'kimi', 'grok'].includes(requestedAgent)) return { ok: false, error: 'AI 终端类型仅允许 Codex、Kimi 或 Grok。', message: '' };
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd)) return { ok: false, error: '任务目录必须是 Windows 绝对路径。', message: '' };

  if (userRecordsTerminal) {
    const valid = name === USER_RECORDS_TERMINAL_NAME
      && task === USER_RECORDS_TERMINAL_STARTUP_INPUT
      && requestedAgent === USER_RECORDS_TERMINAL_AGENT
      && normalizeAbsolutePath(cwd) === normalizeAbsolutePath(USER_RECORDS_TERMINAL_DIRECTORY)
      && !model
      && !reasoningEffort
      && !params.anchorWorkspace
      && !params.anchorTerminal
      && !params.projectManagerProjectId
      && !params.projectManagerWorkItemId;
    if (!valid) return { ok: false, error: '用户记录终端配置无效。', message: '' };

    const existing = currentUserRecordsTerminal();
    if (existing) {
      const runtime = terminalRuntimeStatus(existing.surfaceId);
      if (runtime?.state !== 'failed' && runtime?.state !== 'exited') {
        focusRemoteTerminal(existing);
        return {
          ok: true,
          surfaceId: existing.surfaceId,
          message: runtime?.state === 'ready'
            ? '用户记录终端已存在，已切换到该终端。'
            : '用户记录终端已存在，正在等待运行时就绪。',
        };
      }
      useStore.getState().closeSurface(existing.workspaceId, existing.paneId, existing.surfaceId);
    }

    const launch = buildInteractiveAgentLaunch(USER_RECORDS_TERMINAL_AGENT, task);
    const tree = createLeaf(undefined, 'terminal', USER_RECORDS_TERMINAL_DIRECTORY);
    const surface = tree.surfaces[0];
    tree.surfaces[0] = {
      ...surface,
      customTitle: USER_RECORDS_TERMINAL_NAME,
      shell: 'pwsh.exe',
      cwd: USER_RECORDS_TERMINAL_DIRECTORY,
      userRecordsTerminal: true,
      ...launch,
    };
    markTerminalRuntimeStarting(surface.id);
    useStore.getState().createWorkspace({
      title: USER_RECORDS_TERMINAL_NAME,
      cwd: USER_RECORDS_TERMINAL_DIRECTORY,
      splitTree: tree,
    });
    return {
      ok: true,
      surfaceId: surface.id,
      message: `已创建${USER_RECORDS_TERMINAL_NAME}，正在启动 Codex 并加载默认技能 ${USER_RECORDS_TERMINAL_STARTUP_INPUT}。`,
    };
  }

  if (projectManager) {
    const projectId = String(params.projectManagerProjectId || '').trim();
    const runtimeSegments = cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).slice(-2);
    if (
      name !== PROJECT_MANAGER_TERMINAL_NAME
      || !projectId
      || runtimeSegments.length !== PROJECT_MANAGER_RUNTIME_PATH_SUFFIX.length
      || runtimeSegments.some((segment, index) => (
        segment.toLocaleLowerCase() !== PROJECT_MANAGER_RUNTIME_PATH_SUFFIX[index]
      ))
    ) {
      return { ok: false, error: '项目管理 AI 运行时配置无效。', message: '' };
    }
    const store = useStore.getState();
    const project = store.projectManagers.find((candidate) => candidate.id === projectId);
    if (!project) return { ok: false, error: '项目管理 AI 缺少有效的项目归属。', message: '' };
    const existing = projectManagerTerminal({ projectId });
    if (existing && !params.replaceProjectManager) {
      useStore.getState().updateSurface(existing.workspaceId, existing.paneId, existing.surfaceId, {
        projectManagerTerminal: true,
        projectManagerProjectId: projectId,
        projectManagerAgent: agent,
        projectManagerModel: model,
        projectManagerReasoningEffort: reasoningEffort,
      });
      return { ok: true, surfaceId: existing.surfaceId, message: '项目管理 AI 运行时已就绪。' };
    }

    const previousWorkspaceId = store.activeWorkspaceId;
    let controlWorkspace = store.workspaces.find((workspace) => (
      workspace.transientSupervisorWorkspace === true
      && getAllPaneIds(workspace.splitTree).some((paneId) => (
        findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
          (surface.projectManagerTerminal === true && surface.projectManagerProjectId === projectId)
          || surface.projectSupervisorProjectId === projectId
        ))
      ))
    ));
    if (!controlWorkspace) {
      const workspaceId = store.createWorkspace({
        title: projectManagerWorkspaceTitle(projectDisplayName(project), project.id),
        cwd: project.projectDir,
        pinned: true,
        transientSupervisorWorkspace: true,
        splitTree: createLeaf(undefined, 'supervisor'),
      });
      if (previousWorkspaceId) store.selectWorkspace(previousWorkspaceId);
      controlWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === workspaceId);
    }
    const targetPaneId = controlWorkspace ? getAllPaneIds(controlWorkspace.splitTree)[0] : undefined;
    if (!controlWorkspace || !targetPaneId) return { ok: false, error: '无法创建项目调度控制层运行时。', message: '' };
    const placeholderSurfaceId = findLeaf(controlWorkspace.splitTree, targetPaneId)?.surfaces
      .find((surface) => surface.type === 'supervisor')?.id;
    const launch = buildInteractiveAgentLaunch(agent, task, model, reasoningEffort);
    const surfaceId = store.addSurface(controlWorkspace.id, targetPaneId, 'terminal', {
      customTitle: PROJECT_MANAGER_TERMINAL_NAME,
      shell: 'pwsh.exe',
      cwd,
      projectManagerTerminal: true,
      projectManagerProjectId: projectId,
      projectManagerAgent: agent,
      projectManagerModel: model,
      projectManagerReasoningEffort: reasoningEffort,
      ...launch,
    });
    if (!surfaceId) return { ok: false, error: '无法创建项目管理 AI 运行时。', message: '' };
    if (placeholderSurfaceId) {
      store.closeSurface(controlWorkspace.id, targetPaneId, placeholderSurfaceId);
    }
    markTerminalRuntimeStarting(surfaceId);
    return {
      ok: true,
      surfaceId,
      message: '项目管理 AI 运行时已创建，正在等待启动就绪。',
    };
  }

  const agentLabel = agent === 'kimi' ? 'Kimi' : agent === 'grok' ? 'Grok' : 'Codex';
  const launch = buildInteractiveAgentLaunch(agent as InteractiveAgent, task, model, reasoningEffort);
  const surfaceOptions = {
    customTitle: `${agentLabel}直连 · ${name}`,
    shell: 'pwsh.exe',
    cwd,
    ...(params.projectManagerProjectId ? { projectManagerProjectId: params.projectManagerProjectId } : {}),
    ...(params.projectManagerWorkItemId ? { projectManagerWorkItemId: params.projectManagerWorkItemId } : {}),
    ...launch,
  };

  if (params.anchorWorkspace || params.anchorTerminal) {
    const anchor = locateRemoteTaskSession(params, allowProjectManagedCreate);
    if (!anchor.terminal) return { ok: false, error: `无法定位目标会话：${anchor.error}`, message: '' };
    const surfaceId = useStore.getState().addSurface(
      anchor.terminal.workspaceId,
      anchor.terminal.paneId,
      'terminal',
      surfaceOptions,
    );
    if (!surfaceId) return { ok: false, error: '无法在所选会话创建任务终端。', message: '' };
    markTerminalRuntimeStarting(surfaceId);
    const created = locateRemoteTaskTerminal(surfaceId);
    if (created.terminal) focusRemoteTerminal(created.terminal);
    return {
      ok: true,
      surfaceId,
      message: `已在会话“${anchor.terminal.workspaceTitle}”添加 ${agentLabel} 直连终端“${name}”；首条任务将在终端就绪后自动发送。目录：${params.displayPath || cwd}`,
    };
  }

  const tree = createLeaf(undefined, 'terminal', cwd);
  const surface = tree.surfaces[0];
  tree.surfaces[0] = {
    ...surface,
    ...surfaceOptions,
  };
  markTerminalRuntimeStarting(surface.id);
  useStore.getState().createWorkspace({ title: name, cwd, splitTree: tree });
  return {
    ok: true,
    surfaceId: surface.id,
    message: `已创建 ${agentLabel} 直连终端“${name}”；首条任务将在终端就绪后自动发送。目录：${params.displayPath || cwd}`,
  };
}

function remoteAudit(session: ReturnType<typeof useStore.getState>['supervisor'], lane: SupervisorLane | undefined, type: string, payload: Record<string, unknown>): void {
  if (lane) appendSupervisorRecord(session, lane, type, payload);
}

function hasLiveSurface(surfaceId: SurfaceId): boolean {
  return useStore.getState().workspaces.some((workspace) => getAllPaneIds(workspace.splitTree).some((paneId) =>
    findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => surface.id === surfaceId),
  ));
}

/** A stopped session must not leave its dedicated AI tabs attached to a replacement session. */
function closeStoppedSupervisorSurfaces(lanes: SupervisorLane[]): void {
  for (const lane of lanes) {
    const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
    if (!supervisorSurfaceId) continue;
    let location: { workspaceId: WorkspaceId; paneId: PaneId } | undefined;
    for (const workspace of useStore.getState().workspaces) {
      for (const paneId of getAllPaneIds(workspace.splitTree)) {
        const pane = findLeaf(workspace.splitTree, paneId);
        if (pane?.surfaces.some((surface) => surface.id === supervisorSurfaceId)) {
          location = { workspaceId: workspace.id, paneId };
          break;
        }
      }
      if (location) break;
    }
    if (location) useStore.getState().closeSurface(location.workspaceId, location.paneId, supervisorSurfaceId);
  }
}

function projectAwareSupervisorBriefing(
  session: SupervisorSession,
  lane: SupervisorLane,
  state: string,
): string {
  return lane.projectTaskStartupPending
    ? buildProjectTaskStartupBriefing(lane)
    : buildSupervisorBriefing(session, { lane, state });
}

function waitForControlPlaneDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

async function deliverSupervisorStartupBriefing(laneId: string): Promise<void> {
  const initial = useStore.getState().supervisor.lanes.find((lane) => lane.id === laneId);
  if (!initial?.supervisorSurfaceId) return;
  const ready = await waitForTerminalRuntimeReady(initial.supervisorSurfaceId);
  if (!ready.ok) {
    const failedLane = useStore.getState().supervisor.lanes.find((lane) => lane.id === laneId);
    if (!failedLane || failedLane.supervisorSurfaceId !== initial.supervisorSurfaceId) return;
    const detail = `AI 监督运行时启动失败：${ready.error || '未知错误'}`;
    if (terminalRuntimeStatus(initial.supervisorSurfaceId)?.state === 'starting') {
      markTerminalRuntimeFailed(initial.supervisorSurfaceId, detail);
    }
    useStore.getState().pauseSupervisorLane(laneId, detail);
    queueProjectSupervisorRecovery(failedLane, detail);
    return;
  }
  await waitForControlPlaneDelay(SUPERVISOR_TUI_READY_DELAY_MS);
  const current = useStore.getState().supervisor;
  const lane = current.lanes.find((candidate) => candidate.id === laneId);
  if (!lane?.supervisorSurfaceId || supervisorLaneControlState(lane) !== 'active') return;
  const states = (window as any).__wmux_getAgentStates?.() || {};
  try {
    await sendToSurfaceReliably(
      lane.supervisorSurfaceId,
      projectAwareSupervisorBriefing(current, lane, String(states[lane.surfaceId]?.state || 'unknown')),
      true,
    );
  } catch (error) {
    const detail = `AI 监督启动协议投递失败：${String((error as Error)?.message || error)}`;
    useStore.getState().pauseSupervisorLane(lane.id, detail);
    queueProjectSupervisorRecovery(lane, detail);
  }
}

function startRemoteSupervisor(
  params: RemoteSupervisorStart,
  allowProjectManagedStart = false,
): { ok: boolean; message: string; error?: string } {
  const store = useStore.getState();
  const retainedSession = store.supervisor.active || store.supervisor.paused;
  const requestsProjectManagedStart = !!(
    params.projectManagerProjectId || params.projectWorkItemId || params.projectTaskBootstrap
  );
  const projectManagedStart = !!params.projectManagerProjectId;
  if (requestsProjectManagedStart && !allowProjectManagedStart) {
    return { ok: false, error: '项目监督只能由对应的项目管理 AI 启动。', message: '' };
  }
  if (allowProjectManagedStart && (!params.projectManagerProjectId || !params.projectWorkItemId)) {
    return { ok: false, error: '项目监督缺少项目或工作项归属。', message: '' };
  }
  const previousLanes = store.supervisor.lanes;
  const boundSurfaceIds = new Set(retainedSession
    ? previousLanes.filter(isSupervisorLaneBound).map((lane) => lane.surfaceId)
    : []);
  const selectedIds = new Set(params.terminals);
  const projectTaskBootstrap = params.projectTaskBootstrap;
  const virtualTaskSurface = projectTaskBootstrap
    ? createLeaf(undefined, 'terminal', projectTaskBootstrap.projectDir)
    : null;
  const candidates: RemoteTaskTerminalLocation[] = projectTaskBootstrap && virtualTaskSurface
    ? [{
        surfaceId: projectTaskBootstrap.reservedSurfaceId,
        paneId: virtualTaskSurface.paneId,
        workspaceId: `project-task-pending-${uuid()}` as WorkspaceId,
        workspaceTitle: projectTaskBootstrap.label,
        projectDir: projectTaskBootstrap.projectDir,
        cwd: projectTaskBootstrap.projectDir,
        label: projectTaskBootstrap.label,
        remoteSshControl: false,
        surface: {
          ...virtualTaskSurface.surfaces[0],
          id: projectTaskBootstrap.reservedSurfaceId,
        },
      }]
    : remoteTerminalList().filter((terminal) => {
        if (!selectedIds.has(terminal.surfaceId) || boundSurfaceIds.has(terminal.surfaceId)) return false;
        if (terminal.surface.projectManagerTerminal) return false;
        return projectManagedStart
          ? terminal.surface.projectManagerProjectId === params.projectManagerProjectId
          : !terminal.surface.projectManagerProjectId && !terminal.surface.projectManagerWorkItemId;
      });
  if (candidates.length !== selectedIds.size) return { ok: false, error: '包含不存在或不可监督的终端 ID；先执行 LIST 获取最新终端。', message: '' };
  if (projectTaskBootstrap && (
    selectedIds.size !== 1 || !selectedIds.has(projectTaskBootstrap.reservedSurfaceId)
  )) {
    return { ok: false, error: '项目监督启动预留的任务终端身份无效。', message: '' };
  }
  if (!params.stopWhen.trim()) return { ok: false, error: '停止条件不能为空。', message: '' };
  if (candidates.some((candidate) => !candidate.projectDir)) return { ok: false, error: '所选终端缺少项目目录，无法写入审计记录。', message: '' };

  const project = projectManagedStart
    ? store.projectManagers.find((candidate) => candidate.id === params.projectManagerProjectId)
    : undefined;
  const previousActiveWorkspaceId = store.activeWorkspaceId;
  const workspaceHasProjectRuntime = (workspace: typeof store.workspaces[number], projectId?: string): boolean => (
    getAllPaneIds(workspace.splitTree).some((paneId) => (
      findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
        projectId
          ? surface.projectManagerProjectId === projectId
            || surface.projectSupervisorProjectId === projectId
          : !!surface.projectManagerTerminal || !!surface.projectSupervisorProjectId
      ))
    ))
  );
  let supervisorWorkspace = projectManagedStart
    ? store.workspaces.find((workspace) => (
        workspace.transientSupervisorWorkspace === true
        && workspaceHasProjectRuntime(workspace, params.projectManagerProjectId)
      ))
    : store.workspaces.find((workspace) => (
        workspace.id === store.supervisor.supervisorWorkspaceId
        && !workspaceHasProjectRuntime(workspace)
        && workspace.title === SUPERVISOR_WORKSPACE_TITLE
      ));
  if (!supervisorWorkspace) {
    const workspaceId = store.createWorkspace({
      title: projectManagedStart
        ? projectSupervisorWorkspaceTitle(project?.goal || '', params.projectManagerProjectId || '')
        : SUPERVISOR_WORKSPACE_TITLE,
      pinned: true,
      ...(projectManagedStart && project?.projectDir ? { cwd: project.projectDir } : {}),
      transientSupervisorWorkspace: true,
      splitTree: createLeaf(undefined, 'supervisor'),
    });
    supervisorWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === workspaceId);
    const projectControlPaneId = supervisorWorkspace ? getAllPaneIds(supervisorWorkspace.splitTree)[0] : undefined;
    const projectControlSurfaceId = projectManagedStart && supervisorWorkspace && projectControlPaneId
      ? findLeaf(supervisorWorkspace.splitTree, projectControlPaneId)?.surfaces
        .find((surface) => surface.type === 'supervisor')?.id
      : undefined;
    if (projectControlSurfaceId && projectControlPaneId) {
      store.updateSurface(supervisorWorkspace!.id, projectControlPaneId, projectControlSurfaceId, {
        customTitle: PROJECT_SUPERVISOR_WORKSPACE_TITLE,
        projectSupervisorProjectId: params.projectManagerProjectId,
      });
      supervisorWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === workspaceId);
    }
    if (!projectManagedStart) store.patchSupervisor({ supervisorWorkspaceId: workspaceId });
  }
  const targetPaneId = supervisorWorkspace ? getAllPaneIds(supervisorWorkspace.splitTree)[0] : undefined;
  if (!supervisorWorkspace || !targetPaneId) return { ok: false, error: '无法创建专属监督工作区。', message: '' };
  let projectControlSurfaceId = projectManagedStart
    ? findLeaf(supervisorWorkspace.splitTree, targetPaneId)?.surfaces.find((surface) => (
        surface.type === 'supervisor'
        && surface.projectSupervisorProjectId === params.projectManagerProjectId
      ))?.id
    : undefined;
  if (projectManagedStart && !projectControlSurfaceId) {
    projectControlSurfaceId = store.addSurface(supervisorWorkspace.id, targetPaneId, 'supervisor', {
      customTitle: PROJECT_SUPERVISOR_WORKSPACE_TITLE,
      projectSupervisorProjectId: params.projectManagerProjectId,
    }) || undefined;
  }

  const launchCmd = params.supervisorLaunchCmd !== undefined
    ? params.supervisorLaunchCmd
    : store.supervisor.supervisorLaunchCmd || 'pi';
  const supervisorModel = params.supervisorModel !== undefined
    ? params.supervisorModel
    : retainedSession ? store.supervisor.supervisorModel : '';
  const supervisorReasoningEffort = params.supervisorReasoningEffort !== undefined
    ? params.supervisorReasoningEffort
    : retainedSession ? store.supervisor.supervisorReasoningEffort : '';
  const lanes: SupervisorLane[] = candidates.map((candidate) => {
    const launch = buildSupervisorLaunchCommand(
      launchCmd,
      supervisorModel,
      supervisorReasoningEffort,
      {
        isolateSupervisor: true,
        projectDir: candidate.projectDir,
        isolationKey: candidate.surfaceId,
      },
    );
    const supervisorSurfaceId = store.addSurface(supervisorWorkspace!.id, targetPaneId!, 'terminal', {
      customTitle: supervisorTabTitle(candidate.label),
      shell: 'pwsh.exe',
      cwd: candidate.projectDir,
      startupCommands: launch ? [launch] : undefined,
      transientSupervisor: true,
      ...(projectManagedStart ? {
        projectSupervisorProjectId: params.projectManagerProjectId,
      } : {}),
    });
    if (supervisorSurfaceId) markTerminalRuntimeStarting(supervisorSurfaceId);
    const lane = clearSupervisorLaneContext({
      id: `lane-${uuid()}`,
      projectWorkItemId: params.projectWorkItemId,
      projectManagerProjectId: params.projectManagerProjectId,
      projectTaskStartupPending: !!projectTaskBootstrap,
      label: candidate.label,
      surfaceId: candidate.surfaceId,
      supervisorSurfaceId,
      paneId: candidate.paneId,
      workspaceId: candidate.workspaceId,
      workspaceTitle: candidate.workspaceTitle,
      remoteSshControl: candidate.remoteSshControl,
      projectDir: candidate.projectDir,
      scopeRoot: candidate.projectDir,
      config: {
        taskGoal: params.taskGoal || '',
        taskDescription: params.taskDescription || '',
        preconditions: params.preconditions || '',
        supervisorNotes: params.supervisorNotes || '',
        stopWhen: params.stopWhen,
        stopWhenKind: params.stopWhenKind,
        planFilePath: params.planFile || '',
        waitForNextDirection: params.waitForNextDirection === true,
        taskWorkMode: normalizeTaskWorkMode(params.taskWorkMode),
        mainThreadResponsibility: normalizeTaskThreadResponsibility(params.mainThreadResponsibility),
        childThreadResponsibilities: normalizeTaskChildThreadResponsibilities(params.childThreadResponsibilities),
        maxChildThreads: normalizeTaskMaxChildThreads(params.maxChildThreads),
        supervisorMayApproveThreads: params.supervisorMayApproveThreads === true,
        parallelizableOperations: normalizeTaskOperationBoundaries(params.parallelizableOperations),
        serializedOperations: normalizeTaskOperationBoundaries(params.serializedOperations),
      },
      autonomousOverride: retainedSession || projectManagedStart ? params.autonomous : undefined,
      ...(projectManagedStart ? {
        autonomyPermissionsOverride: [...selectedAutonomyPermissions(params.autonomyPermissions)],
        workScopeOverride: DEFAULT_SUPERVISOR_WORK_SCOPE,
        forbiddenActionsOverride: [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS],
      } : {}),
      controlState: 'active',
      awaitingStopCheck: false, stopConfirmed: false,
      awaitingReview: false, autoDecisionLimitReached: false, autoDecisionsUsed: 0, pendingSupervisorDeliveries: [], currentTask: '', decisions: [],
    }, supervisorSurfaceId);
    return retainedSession || projectTaskBootstrap ? { ...lane, awaitingReview: true } : lane;
  });
  if (lanes.some((lane) => !lane.supervisorSurfaceId)) {
    for (const lane of lanes) {
      if (lane.supervisorSurfaceId) store.closeSurface(supervisorWorkspace.id, targetPaneId, lane.supervisorSurfaceId);
    }
    return { ok: false, error: '无法为所有终端创建专属监督 AI。', message: '' };
  }
  if (projectManagedStart && projectControlSurfaceId) {
    const refreshedWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === supervisorWorkspace!.id);
    const controlIndex = refreshedWorkspace
      ? findLeaf(refreshedWorkspace.splitTree, targetPaneId)?.surfaces.findIndex((surface) => surface.id === projectControlSurfaceId) ?? -1
      : -1;
    if (controlIndex >= 0) store.selectSurface(supervisorWorkspace.id, targetPaneId, controlIndex);
    if (previousActiveWorkspaceId && previousActiveWorkspaceId !== supervisorWorkspace.id) {
      store.selectWorkspace(previousActiveWorkspaceId);
    }
  }
  if (!retainedSession && previousLanes.length > 0) {
    for (const lane of previousLanes) {
      remoteAudit(store.supervisor, lane, 'session.abandoned', { reason: '飞书启动新的监督会话', actor: params.actor || 'unknown' });
    }
    closeStoppedSupervisorSurfaces(previousLanes);
  }
  if (retainedSession) {
    const supersededStoppedLanes = previousLanes.filter((lane) => (
      selectedIds.has(lane.surfaceId) && !isSupervisorLaneBound(lane)
    ));
    for (const lane of supersededStoppedLanes) {
      remoteAudit(store.supervisor, lane, 'session.abandoned', {
        reason: '飞书在当前会话中重新添加此终端', actor: params.actor || 'unknown',
      });
    }
    closeStoppedSupervisorSurfaces(supersededStoppedLanes);
    const retainedLanes = previousLanes.filter((lane) => !supersededStoppedLanes.includes(lane));
    if (projectManagedStart) {
      store.setProjectSupervisorLanes([
        ...retainedLanes.filter(isProjectManagedSupervisorLane),
        ...lanes,
      ]);
    } else {
      store.setOrdinarySupervisorLanes([
        ...retainedLanes.filter((lane) => !isProjectManagedSupervisorLane(lane)),
        ...lanes,
      ]);
    }
    const session = useStore.getState().supervisor;
    for (const lane of lanes) {
      remoteAudit(session, lane, 'supervisor.remote-command', {
        action: 'add', terminals: [lane.surfaceId], autonomous: params.autonomous, actor: params.actor || 'unknown',
      });
    }
    for (const lane of lanes) void deliverSupervisorStartupBriefing(lane.id);
    return { ok: true, message: `已添加 AI 监督终端，正在等待运行时就绪：${lanes.map((lane) => `${lane.label} (${lane.surfaceId})`).join('、')}` };
  }
  if (!projectManagedStart) {
    store.patchSupervisor({
      supervisorLaunchCmd: launchCmd, supervisorModel, supervisorReasoningEffort,
      maxAutoDecisions: params.autonomous ? null : store.supervisor.maxAutoDecisions, autonomous: params.autonomous,
      autonomyPermissions: [...DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS],
      workScope: DEFAULT_SUPERVISOR_WORK_SCOPE,
      forbiddenActions: [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS],
    });
  }
  if (projectManagedStart) {
    store.setProjectSupervisorLanes(lanes);
    store.startProjectSupervisor(lanes.map((lane) => lane.id));
  } else {
    store.setOrdinarySupervisorLanes(lanes);
    store.startOrdinarySupervisor();
  }
  const session = useStore.getState().supervisor;
  for (const lane of lanes) remoteAudit(session, lane, 'supervisor.remote-command', { action: previousLanes.length > 0 ? 'restart' : 'start', terminals: params.terminals, autonomous: params.autonomous, actor: params.actor || 'unknown' });
  for (const lane of lanes) void deliverSupervisorStartupBriefing(lane.id);
  return { ok: true, message: `已创建 AI 监督，正在等待运行时就绪：${lanes.map((lane) => `${lane.label} (${lane.surfaceId})`).join('、')}` };
}

function sendRemoteTerminalTask(params: RemoteTerminalTask): RemoteTerminalTaskResult {
  const store = useStore.getState();
  const projectMode = params.mode === 'project';
  if (params.mode !== undefined && !projectMode) {
    return { ok: false, error: '终端发送模式无效。', message: '' };
  }
  const located = projectMode
    ? locateRemoteProjectTerminal(params.terminal)
    : locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可发送任务。', message: '' };
  if (!projectMode && (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId)) {
    return { ok: false, error: '项目任务终端只能由对应的项目监督 AI 投递任务。', message: '' };
  }
  const task = params.task.trim();
  if (!task) return { ok: false, error: '任务内容不能为空。', message: '' };

  const activity = remoteTerminalActivity(terminal.surfaceId);
  if (activity.activityState === 'working' && params.force !== true) {
    return {
      ok: false,
      error: `${terminal.label} 正在执行任务，需要确认后才能继续发送。`,
      message: '',
      code: 'terminal_busy',
      terminal: {
        surfaceId: terminal.surfaceId,
        label: terminal.label,
        workspace: terminal.workspaceTitle,
        ...activity,
      },
    };
  }

  try {
    sendTaskToSurface(terminal.surfaceId, task, true);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err), message: '' };
  }
  handleSupervisorUserSubmit(terminal.surfaceId);
  const session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => (
    item.surfaceId === terminal.surfaceId
    || (projectMode && dedicatedSupervisorSurfaceId(item) === terminal.surfaceId)
  ));
  let manuallyResolved = false;
  if (lane?.surfaceId === terminal.surfaceId) {
    const resolved = store.resolvePendingWithManualTask(lane.id, task);
    manuallyResolved = resolved.length > 0;
    for (const approval of resolved) {
      if (approval.source !== 'supervisor-route'
        && approval.source !== 'supervisor-important'
        && approval.source !== 'supervisor-context-recovery') continue;
      remoteAudit(session, lane, 'supervisor.proposal.resolved', {
        approvalId: approval.id,
        resolution: 'handled-manually',
        proposalKind: approval.proposalKind || 'important',
        text: task,
        actor: params.actor || 'unknown',
      });
    }
    store.updateLane(lane.id, {
      currentTask: task,
      ...(resolved.some((approval) => approval.source === 'supervisor-context-recovery')
        ? { contextRecoveryStatus: 'sent' as const }
        : {}),
    });
  }
  remoteAudit(session, lane, 'supervisor.remote-command', {
    action: projectMode ? 'send-project-terminal-content' : 'send-task',
    terminal: terminal.surfaceId,
    actor: params.actor || 'unknown',
    task,
  });
  return { ok: true, message: manuallyResolved
    ? `已向 ${terminal.label} 发送任务，并将内容记录为人工裁决。`
    : `已向 ${terminal.label} 发送任务。` };
}

function sendRemoteTerminalEscape(params: RemoteTerminalEscape): { ok: boolean; message: string; error?: string } {
  const projectMode = params.mode === 'project';
  if (params.mode !== undefined && !projectMode) {
    return { ok: false, error: '终端中断模式无效。', message: '' };
  }
  const located = projectMode
    ? locateRemoteProjectTerminal(params.terminal)
    : locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可中断。', message: '' };
  if (!projectMode && (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId)) {
    return { ok: false, error: '项目任务终端只能由项目管理模式处理中断。', message: '' };
  }
  try {
    sendToSurface(terminal.surfaceId, '\x1b', false);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err), message: '' };
  }
  const session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => (
    item.surfaceId === terminal.surfaceId
    || (projectMode && dedicatedSupervisorSurfaceId(item) === terminal.surfaceId)
  ));
  remoteAudit(session, lane, 'supervisor.remote-command', {
    action: projectMode ? 'send-project-terminal-escape' : 'send-escape',
    terminal: terminal.surfaceId,
    actor: params.actor || 'unknown',
  });
  return { ok: true, message: `已向 ${terminal.label} 发送 Esc 中断请求。` };
}

function sendRemoteTerminalInterrupt(params: RemoteTerminalInterrupt): { ok: boolean; message: string; error?: string } {
  const projectMode = params.mode === 'project';
  if (params.mode !== undefined && !projectMode) {
    return { ok: false, error: '终端中断模式无效。', message: '' };
  }
  const located = projectMode
    ? locateRemoteProjectTerminal(params.terminal)
    : locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可中断。', message: '' };
  if (!projectMode && (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId)) {
    return { ok: false, error: '项目任务终端只能由项目管理模式处理中断。', message: '' };
  }
  try {
    sendToSurface(terminal.surfaceId, '\x03', false);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err), message: '' };
  }
  const session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => (
    item.surfaceId === terminal.surfaceId
    || (projectMode && dedicatedSupervisorSurfaceId(item) === terminal.surfaceId)
  ));
  remoteAudit(session, lane, 'supervisor.remote-command', {
    action: projectMode ? 'send-project-terminal-ctrl-c' : 'send-ctrl-c',
    terminal: terminal.surfaceId,
    actor: params.actor || 'unknown',
  });
  return { ok: true, message: `已向 ${terminal.label} 发送 Ctrl+C 中断请求。` };
}

function closeRemoteTerminal(params: { terminal: string; actor?: string }): { ok: boolean; message: string; error?: string } {
  const located = locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可关闭。', message: '' };
  if (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId) {
    return { ok: false, error: '项目任务终端只能由项目管理模式关闭。', message: '' };
  }

  const store = useStore.getState();
  const session = store.supervisor;
  const lane = session.lanes.find((item) => item.surfaceId === terminal.surfaceId);
  const laneWasSupervised = !!lane && supervisorLaneControlState(lane) !== 'stopped';
  if (lane) {
    remoteAudit(session, lane, 'supervisor.remote-command', {
      action: 'close-terminal',
      terminal: terminal.surfaceId,
      actor: params.actor || 'unknown',
    });
    if (laneWasSupervised) {
      store.stopSupervisorLane(lane.id, `由飞书关闭任务终端 ${lane.label} 并解除监督绑定`);
    } else {
      store.setOrdinarySupervisorLanes(
        store.supervisor.lanes.filter((item) => !isProjectManagedSupervisorLane(item) && item.id !== lane.id),
      );
    }
    closeStoppedSupervisorSurfaces([lane]);
  }

  // Reuse the store's PTY reaping and last-tab workspace cleanup path.
  store.closeSurface(terminal.workspaceId, terminal.paneId, terminal.surfaceId);
  return {
    ok: true,
    message: laneWasSupervised
      ? `已关闭 ${terminal.label}，并停止对应 AI 监督通道。任务目录和审计记录均已保留。`
      : `已关闭 ${terminal.label}。任务目录和审计记录均已保留。`,
  };
}

function sendRemoteSupervisorMessage(params: RemoteSupervisorMessage): { ok: boolean; message: string; error?: string } {
  let session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => item.surfaceId === params.terminal || item.managementSessionId === params.terminal);
  if (lane && isProjectManagedSupervisorLane(lane)) {
    return { ok: false, error: '该通道属于项目管理模式，只能由对应的项目管理 AI 调整方向。', message: '' };
  }
  if (!session.active || !lane || (supervisorLaneControlState(lane) !== 'active'
    && supervisorLaneControlState(lane) !== 'waiting')) {
    return { ok: false, error: '目标 AI 监督终端（管家）当前未运行；请先启动或恢复该监督。', message: '' };
  }
  const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
  if (!supervisorSurfaceId || !hasLiveSurface(supervisorSurfaceId)) {
    return { ok: false, error: `${lane.label} 的 AI 监督终端（管家）已缺失；请在 wmux 中重新配置。`, message: '' };
  }
  const message = params.message.trim();
  if (!message) return { ok: false, error: '监督方向信息不能为空。', message: '' };

  try {
    sendTaskToSurface(supervisorSurfaceId, `[用户调整监督方向]\n${message}`, true);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err), message: '' };
  }
  if (supervisorLaneControlState(lane) === 'waiting') {
    resumeWaitingLaneFromSupervisorInput(session, lane, 'remote-supervisor-message');
    session = useStore.getState().supervisor;
  }
  remoteAudit(session, lane, 'supervisor.remote-command', {
    action: 'send-supervisor-message',
    actor: params.actor || 'unknown',
    message,
  });
  useStore.getState().appendSupervisorLog(lane.id, '用户调整监督方向', message);
  return { ok: true, message: `已向 AI 监督终端（管家）“${lane.label}”发送监督方向信息。` };
}

function decideRemoteWaiting(params: RemoteWaitingDecision): { ok: boolean; message: string; error?: string } {
  const session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => item.surfaceId === params.terminal || item.managementSessionId === params.terminal);
  if (lane && isProjectManagedSupervisorLane(lane)) {
    return { ok: false, error: '该通道属于项目管理模式，只能由对应的项目管理 AI 处理待续。', message: '' };
  }
  if (!lane || supervisorLaneControlState(lane) !== 'waiting') {
    return { ok: false, error: '该 AI 监督通道已不处于待续状态，请刷新后查看当前状态。', message: '' };
  }
  if (params.decision === 'keep') {
    return { ok: true, message: `${lane.label} 保持待续；之后仍可从原卡片提交新方案或恢复监督。` };
  }
  if (params.decision === 'stop') {
    remoteAudit(session, lane, 'supervisor.remote-command', {
      action: 'waiting-stop',
      actor: params.actor || 'unknown',
    });
    closeStoppedSupervisorSurfaces([lane]);
    useStore.getState().stopSupervisorLane(lane.id, `由飞书停止待续通道 ${lane.label} 并解除终端绑定`);
    return { ok: true, message: `已停止 ${lane.label} 的 AI 监督并解除终端绑定；其他通道不受影响。` };
  }
  if (!session.active) {
    return {
      ok: false,
      error: session.paused
        ? '当前监督会话处于全局暂停；请先继续全部监督，再恢复此待续通道。'
        : '当前监督会话已停止，不能恢复该待续通道。',
      message: '',
    };
  }
  const message = params.decision === 'resume'
    ? '按原任务目标和既有停止条件继续监督；先读取任务终端最新状态，再继续推进。'
    : String(params.message || '').trim();
  if (!message) return { ok: false, error: '新方案或下一步方向不能为空。', message: '' };
  const result = sendRemoteSupervisorMessage({
    action: 'send-supervisor-message',
    terminal: params.terminal,
    message,
    actor: params.actor,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    message: params.decision === 'resume'
      ? `已按原目标恢复 ${lane.label} 的 AI 监督。`
      : `已将新方案发送给 ${lane.label} 的 AI 监督终端，并恢复监督。`,
  };
}

function decideRemoteSupervisor(
  approvalId: string,
  decision: 'approve' | 'direct' | 'pause' | 'stop',
  selection?: string,
  task?: string,
  actor?: string,
  authorisedProjectManagerId?: string,
): { ok: boolean; message: string; error?: string } {
  const store = useStore.getState();
  const session = store.supervisor;
  const approval = session.pendingApprovals.find((item) => item.id === approvalId);
  if (!approval) return { ok: false, error: '该待决项不存在、已过期或已处理。', message: '' };
  const approvalLane = session.lanes.find((item) => item.id === approval.laneId);
  const projectManagedDecision = !!approvalLane && isProjectManagedSupervisorLane(approvalLane);
  if (projectManagedDecision && approvalLane.projectManagerProjectId !== authorisedProjectManagerId) {
    return { ok: false, error: '该待决项属于项目管理模式，只能由对应的项目管理 AI 处理。', message: '' };
  }
  if (!projectManagedDecision && authorisedProjectManagerId) {
    return { ok: false, error: '该待决项不属于项目管理模式，不能由项目管理 AI 处理。', message: '' };
  }
  const decisionOwnerLabel = projectManagedDecision ? '项目管理 AI' : '用户';
  if (Date.now() - approval.createdAt > 24 * 60 * 60 * 1000) {
    store.cancelPending(approvalId, '待决项超过 24 小时，已解除旧等待状态');
    if (approvalLane) {
      if (projectManagedDecision && supervisorLaneControlState(approvalLane) === 'paused') {
        const project = approvalLane.projectManagerProjectId
          ? store.projectManagers.find((candidate) => candidate.id === approvalLane.projectManagerProjectId)
          : undefined;
        if (project?.status === 'active') {
          store.resumeSupervisorLane(approvalLane.id, '项目管理 AI 已解除过期待决项并要求专属监督重新核对');
        } else {
          queueProjectSupervisorRecovery(approvalLane, '旧待决项已经过期，项目恢复后需由专属监督按最新证据重新提案');
        }
      }
      store.updateLane(approvalLane.id, {
        awaitingReview: false,
        autoDecisionLimitReached: false,
        resumeAfterCancelledDecision: false,
      });
      const supervisorSurfaceId = dedicatedSupervisorSurfaceId(approvalLane);
      if (supervisorSurfaceId) {
        try {
          sendToSurface(supervisorSurfaceId, [
            '[待决项已过期｜重新核对]',
            `原待决 ID：${approvalId}`,
            '旧待决项已解除。请重新读取任务终端当前状态和最新项目约束；能够在既有授权内继续时提交新的 continue/rework，需要上级决定时重新提交 needs-human。不得继续等待旧待决项。',
          ].join('\n'), true);
        } catch (error) {
          queueProjectSupervisorRecovery(
            approvalLane,
            `待决项过期后无法通知专属监督重新核对：${String((error as Error)?.message || error)}`,
          );
        }
      } else if (projectManagedDecision) {
        queueProjectSupervisorRecovery(approvalLane, '待决项过期后专属监督终端已经缺失');
      }
    }
    return {
      ok: false,
      error: '该待决项已超过 24 小时，旧等待状态已解除；专属监督必须按最新证据重新提案。',
      message: '',
    };
  }
  if (decision === 'pause') {
    if (!session.active) return { ok: false, error: '当前监督会话已停止，不能暂停旧待决项。', message: '' };
    const lane = session.lanes.find((item) => item.id === approval.laneId);
    if (!lane) return { ok: false, error: '待决项对应的监督通道不存在。', message: '' };
    if (supervisorLaneControlState(lane) === 'paused') return { ok: true, message: `${lane.label} 已经暂停，待决项仍保留。` };
    store.pauseSupervisorLane(lane.id, `${decisionOwnerLabel}暂停待决项：${approval.laneLabel}；该通道决策内容已保留`);
    remoteAudit(session, lane, 'supervisor.remote-decision', { approvalId, decision, actor: actor || 'unknown' });
    return { ok: true, message: `${decisionOwnerLabel}已暂停 ${lane.label} 的 AI 监督；其他监督通道继续运行。` };
  }
  const lane = session.lanes.find((item) => item.id === approval.laneId);
  if (decision === 'stop') {
    if (!session.active && !session.paused) return { ok: false, error: '当前监督会话已停止，不能处理旧待决项。', message: '' };
    store.rejectPending(approvalId);
    remoteAudit(session, lane, 'supervisor.remote-decision', { approvalId, decision, actor: actor || 'unknown' });
    if (lane) {
      closeStoppedSupervisorSurfaces([lane]);
      store.stopSupervisorLane(lane.id, `${decisionOwnerLabel}停止 ${lane.label} 并解除终端绑定`);
    }
    return { ok: true, message: lane
      ? `已停止 ${lane.label} 的 AI 监督并解除终端绑定；可重新选择该终端启动监督，其他通道不受影响。`
      : '待决项对应通道不存在，已移除该待决项。' };
  }
  if (session.paused && !projectManagedDecision) return { ok: false, error: '当前监督会话已暂停；请先在 wmux 中继续会话。', message: '' };
  if (!session.active && !projectManagedDecision) return { ok: false, error: '当前监督会话已停止，不能处理旧待决项。', message: '' };
  if (!lane) return { ok: false, error: '待决项对应的监督通道不存在。', message: '' };
  let laneState = supervisorLaneControlState(lane);
  if (projectManagedDecision && laneState === 'paused') {
    const project = lane.projectManagerProjectId
      ? store.projectManagers.find((candidate) => candidate.id === lane.projectManagerProjectId)
      : undefined;
    if (project?.status === 'active') {
      store.resumeSupervisorLane(lane.id, '项目管理 AI 正在处理该通道保留的待决项');
      laneState = 'active';
    }
  }
  if (laneState !== 'active') {
    const stateLabel = laneState === 'paused' ? '已暂停' : laneState === 'waiting' ? '正在待续' : '已停止';
    return {
      ok: false,
      error: `目标监督通道${stateLabel}；请先恢复该项目的专属监督，再处理待决项。`,
      message: '',
    };
  }
  const decisionInput = task?.trim().slice(0, 4000) || '';
  if (decision === 'direct') {
    const directTask = decisionInput;
    if (!directTask) return { ok: false, error: projectManagedDecision
      ? '请填写要交给专属 AI 监督的项目决策信息。'
      : '请填写要直接发送到任务终端的决策信息。', message: '' };
    if (!projectManagedDecision) {
      try {
        sendTaskToSurface(approval.surfaceId, directTask, true);
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message || err), message: '' };
      }
      const resolved = store.resolvePendingWithManualTask(lane.id, directTask);
      store.updateLane(lane.id, {
        pendingSupervisorDeliveries: [],
        ...(approval.source === 'supervisor-context-recovery' ? {
          contextRecoveryStatus: 'sent' as const,
          awaitingReview: false,
          currentTask: directTask,
        } : {}),
      });
      for (const item of resolved) {
        if (item.source !== 'supervisor-route'
          && item.source !== 'supervisor-important'
          && item.source !== 'supervisor-context-recovery') continue;
        remoteAudit(session, lane, 'supervisor.proposal.resolved', {
          approvalId: item.id,
          resolution: 'handled-manually',
          proposalKind: item.proposalKind || 'important',
          text: '用户已直接向任务终端发送决策信息',
          inputLength: directTask.length,
          actor: actor || 'unknown',
        });
      }
      remoteAudit(session, lane, 'supervisor.remote-decision', {
        approvalId,
        decision,
        actor: actor || 'unknown',
        inputLength: directTask.length,
      });
      return { ok: true, message: `已将用户决策直接发送到 ${lane.label}，并记录为人工裁决。` };
    }
  }
  if (!projectManagedDecision && decision === 'approve' && approval.source === 'supervisor-context-recovery') {
    const recoveryInstruction = approval.text.trim();
    if (!recoveryInstruction) {
      return { ok: false, error: 'AI 监督没有提供可发送的上下文恢复指令。', message: '' };
    }
    try {
      sendTaskToSurface(approval.surfaceId, recoveryInstruction, true);
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err), message: '' };
    }
    store.approvePending(approvalId);
    store.updateLane(lane.id, {
      contextRecoveryStatus: 'sent',
      awaitingReview: false,
      currentTask: recoveryInstruction,
      autoDecisionLimitReached: false,
      autoDecisionsUsed: 0,
    });
    remoteAudit(session, lane, 'supervisor.proposal.resolved', {
      approvalId,
      resolution: 'approved',
      proposalKind: 'context-recovery',
      text: recoveryInstruction,
      actor: actor || 'unknown',
    });
    remoteAudit(session, lane, 'supervisor.remote-decision', {
      approvalId,
      decision,
      actor: actor || 'unknown',
    });
    return { ok: true, message: `已确认上下文恢复指令并发送到 ${lane.label}。` };
  }
  const laneSupervisorSurfaceId = lane ? dedicatedSupervisorSurfaceId(lane) : null;
  if (!laneSupervisorSurfaceId) {
    return { ok: false, error: '待决项对应的 AI 监督已不存在，无法整理所选方案。', message: '' };
  }
  const rawSelection = selection?.trim().replace(/^用户选择\s*/u, '').slice(0, 200) || '';
  const selectedNone = rawSelection === SUPERVISOR_NO_DECISION_OPTION;
  const selectedOption = selectedNone ? '' : rawSelection;
  const parsedOptions = supervisorDecisionOptions(approval.alternatives, approval.text);
  const offeredOptions = new Set(parsedOptions.length >= 2
    ? parsedOptions.map((option) => option.value)
    : []);
  const requiresOptionSelection = decision === 'approve' && approval.source !== 'supervisor-context-recovery';
  if (requiresOptionSelection && offeredOptions.size >= 2 && !selectedOption && !selectedNone) {
    return { ok: false, error: 'AI 监督提供了多个方案，请先选择其中一个方案。', message: '' };
  }
  if (requiresOptionSelection && selectedNone && !decisionInput) {
    return { ok: false, error: '选择“无”时，请填写用户决策或补充信息。', message: '' };
  }
  if (requiresOptionSelection && selectedOption && !offeredOptions.has(selectedOption)) {
    return { ok: false, error: '所选方案不属于 AI 监督当前提供的备选项，请刷新决策卡后重试。', message: '' };
  }
  if (decision === 'approve' || (projectManagedDecision && decision === 'direct')) {
    const chosenPlan = decision === 'approve'
      ? selectedNone ? '' : selectedOption || approval.text.trim()
      : '';
    const briefing = [
      projectManagedDecision
        ? decision === 'direct'
          ? '[项目管理 AI 决定] 项目管理 AI 提供了项目内决策，请由专属 AI 监督结合最新终端证据整理处理。'
          : decisionInput
            ? chosenPlan
              ? '[项目管理 AI 决定] 项目管理 AI 已采用 AI 监督提出的方案，并提供了补充决策信息。'
              : '[项目管理 AI 决定] 项目管理 AI 提供了项目内决策，请由专属 AI 监督整理处理。'
            : '[项目管理 AI 决定] 项目管理 AI 已选择采用 AI 监督提出的方案。'
        : decisionInput
          ? chosenPlan
            ? '[人工决定] 用户已采用 AI 监督提出的方案，并提供了补充决策信息。'
            : '[人工决定] 用户提供了人工决策信息，请由 AI 监督整理处理。'
          : '[人工决定] 用户已选择采用 AI 监督提出的方案。',
      chosenPlan ? `[${decisionOwnerLabel}选择] ${chosenPlan}` : '',
      decisionInput ? `[${decisionOwnerLabel}补充信息] ${decisionInput}` : '',
      approval.text.trim() ? `[AI 原建议] ${approval.text.trim()}` : '',
      approval.reason?.trim() ? `[原判断依据] ${approval.reason.trim()}` : '',
      approval.impact?.trim() ? `[影响] ${approval.impact.trim()}` : '',
      approval.alternatives?.trim() ? `[AI 备选方案] ${approval.alternatives.trim()}` : '',
      '',
      `请先 read-screen 获取任务终端最新状态，再基于${decisionOwnerLabel}决定、当前任务、计划约束和终端证据，整理成完整、明确、可执行的下一步。`,
      `整理完成后，使用 wmux supervisor decide --surface ${approval.surfaceId} --outcome continue 或 rework 提交最终指令到任务终端；短文本使用 --next，长文本或多行文本写入当前项目 .wmux/tmp/<唯一文件名>.txt 后使用 --next-file，禁止在项目根目录创建监督草稿。不要把本消息原样转发，也不要使用通用 wmux send/send-key。`,
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
    try {
      sendToSurface(laneSupervisorSurfaceId, briefing, true);
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err), message: '' };
    }
  }
  store.approvePending(approvalId);
  if (lane && (
    approval.source === 'supervisor-route'
    || approval.source === 'supervisor-important'
    || (projectManagedDecision && approval.source === 'supervisor-context-recovery')
  )) {
    store.updateLane(lane.id, {
      awaitingReview: true,
      autoDecisionLimitReached: false,
      autoDecisionsUsed: 0,
      ...(approval.source === 'supervisor-context-recovery' ? { contextRecoveryStatus: 'sent' as const } : {}),
    });
    remoteAudit(session, lane, 'supervisor.proposal.resolved', {
      approvalId,
      resolution: 'approved',
      proposalKind: approval.proposalKind || 'important',
      text: selectedNone
        ? `${decisionOwnerLabel}未采用 AI 方案，已提供补充决策信息`
        : selectedOption || approval.text || (decisionInput ? `${decisionOwnerLabel}提供补充决策信息` : '采用 AI 监督当前建议'),
    });
  }
  remoteAudit(session, lane, 'supervisor.remote-decision', {
    approvalId,
    decision,
    actor: actor || 'unknown',
    selection: selectedOption || undefined,
    inputLength: decision === 'approve' ? decisionInput.length || undefined : undefined,
  });
  if (projectManagedDecision && decision === 'direct') {
    return { ok: true, message: `已将项目管理 AI 的决策交给 ${lane.label} 的专属 AI 监督；监督整理并重新核对终端证据后再投递任务。` };
  }
  const hasUserInput = decision === 'approve' && !!decisionInput;
  return { ok: true, message: selectedOption
    ? `已选择 ${selectedOption}${hasUserInput ? '并附加用户补充信息' : ''}；AI 监督将整理后发送到任务终端。`
    : hasUserInput
      ? '已将用户决策信息交给 AI 监督；AI 监督将整理后发送到任务终端。'
      : '已采用 AI 监督当前方案；AI 监督将整理后发送到任务终端。' };
}

export function normalizedMaxAutoDecisions(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(20, parsed) : null;
}

export function reachesAutoDecisionLimit(
  lane: Pick<SupervisorLane, 'autoDecisionsUsed'>,
  maxAutoDecisions: unknown,
): boolean {
  const limit = normalizedMaxAutoDecisions(maxAutoDecisions);
  return limit !== null && (lane.autoDecisionsUsed ?? 0) + 1 >= limit;
}

/** Permission acknowledgements are audited but do not consume a judgment slot. */
export function nextSupervisorDecisionCount(current: number | undefined, permissionResponse: string): number {
  return (current ?? 0) + (permissionResponse ? 0 : 1);
}

const PROJECT_WORK_ITEM_ID = /^[A-Za-z0-9_-]{1,80}$/;
const PROJECT_WORK_ITEM_STATUSES = new Set([
  'planned', 'waiting-dependencies', 'running', 'validating', 'waiting-decision',
  'paused', 'completed', 'failed', 'stopped',
]);
const PROJECT_ESCALATION_BOUNDARIES = new Set<ProjectEscalationBoundary>([
  'contract-change', 'cross-item-coordination', 'external-blocker',
  'user-only-information', 'high-risk-action', 'budget-exhausted',
]);

function taskWorkModeLabel(mode: TaskWorkMode): string {
  if (mode === 'multi-thread') return '多线程';
  if (mode === 'adaptive') return '自适应线程';
  return '单线程';
}

export function projectContractAutonomyPermissions(
  contract: ProjectSupervisorContract,
): SupervisorAutonomyPermission[] {
  return [
    'same-route-next',
    ...(contract.authority.technicalChoices ? ['technical-choice' as const] : []),
    ...(contract.authority.routeAdjustments ? ['route-adjustment' as const] : []),
    ...(contract.authority.permissionConfirm ? ['permission-confirm' as const] : []),
  ];
}

function projectStringArray(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[;,；]/u)
      : [];
  return entries.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100);
}

function safeProjectRelativePath(value: string): boolean {
  return !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value)
    && !/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value);
}

function projectCompletionIndexes(value: unknown): number[] {
  const serialized = (Array.isArray(value) ? value.join(',') : String(value || '')).trim();
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/u.test(serialized)) return [];
  return [...new Set(serialized.split(',').map((item) => Number(item)))]
    .sort((left, right) => left - right);
}

function projectStageCompletionError(
  workItem: ProjectWorkItem,
  params: Record<string, unknown>,
): string | null {
  const expectedStopWhen = workItem.contract.stopWhen.map((_item, index) => index + 1);
  const expectedValidation = workItem.contract.validation.map((_item, index) => index + 1);
  const actualStopWhen = projectCompletionIndexes(params.completionStopWhen);
  const actualValidation = projectCompletionIndexes(params.completionValidation);
  const sameIndexes = (left: readonly number[], right: readonly number[]) => (
    left.length === right.length && left.every((item, index) => item === right[index])
  );
  if (!sameIndexes(actualStopWhen, expectedStopWhen)
    || !sameIndexes(actualValidation, expectedValidation)) {
    return [
      '完整阶段交接必须显式核对全部停止条件和验证要求；普通 P0/P1/P2、单条命令、单次测试或任务 AI 回合结束应使用 continue/rework 直接推进，不得提交 complete。',
      `本阶段停止条件编号：${expectedStopWhen.join(',')}（${workItem.contract.stopWhen.join('；')}）`,
      `本阶段验证要求编号：${expectedValidation.join(',')}（${workItem.contract.validation.join('；')}）`,
      `确认全部满足后附 --completion-stop-when ${expectedStopWhen.join(',')} --completion-validation ${expectedValidation.join(',')} --remaining-work none。`,
    ].join('\n');
  }
  if (String(params.remainingWork || '').trim().toLowerCase() !== 'none') {
    return '完整阶段交接必须通过 --remaining-work none 明确声明合同内没有剩余工作；仍有下一步时使用 continue/rework 直接发送给任务 AI。';
  }
  const plan = (params.stagePlan as ProjectSupervisorStagePlan | undefined) || workItem.supervisorPlan;
  if (!plan && workItem.supervisorPlanRequired === true) {
    return '完整阶段交接缺少监督 AI 的持久化阶段计划；请先通过 --stage-plan-file 建立并推进阶段计划。';
  }
  if (!plan) return null;
  const unfinishedMilestones = plan.milestones.filter((milestone) => milestone.status !== 'completed');
  if (unfinishedMilestones.length > 0 || plan.remainingWork.length > 0) {
    return `监督阶段计划仍有未完成内容：${[
      ...unfinishedMilestones.map((milestone) => milestone.title),
      ...plan.remainingWork,
    ].join('；')}；请继续推进并更新 --stage-plan-file。`;
  }
  return null;
}

function normalizeSupervisorStagePlan(
  raw: unknown,
  workItem: ProjectWorkItem,
): { plan?: ProjectSupervisorStagePlan; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: '监督阶段计划必须是 JSON 对象' };
  }
  const input = raw as Record<string, unknown>;
  const selectedRoute = String(input.selectedRoute || '').trim().slice(0, 4000);
  const rawMilestones = Array.isArray(input.milestones) ? input.milestones : [];
  if (!selectedRoute || rawMilestones.length < 1 || rawMilestones.length > 12) {
    return { error: '监督阶段计划必须包含 selectedRoute 和 1-12 个 milestones' };
  }
  const milestones: ProjectSupervisorStagePlan['milestones'] = [];
  const milestoneIds = new Set<string>();
  for (let index = 0; index < rawMilestones.length; index += 1) {
    const milestone = rawMilestones[index] as Record<string, unknown> | null;
    const id = String(milestone?.id || '').trim();
    const title = String(milestone?.title || '').trim().slice(0, 200);
    const outcome = String(milestone?.outcome || '').trim().slice(0, 2000);
    const status = String(milestone?.status || 'planned');
    if (!PROJECT_WORK_ITEM_ID.test(id) || milestoneIds.has(id) || !title || !outcome
      || !['planned', 'active', 'completed'].includes(status)) {
      return { error: `监督阶段计划的里程碑 ${index + 1} 无效或 ID 重复` };
    }
    milestoneIds.add(id);
    milestones.push({
      id,
      title,
      outcome,
      status: status as ProjectSupervisorStagePlan['milestones'][number]['status'],
      ...(String(milestone?.evidence || '').trim()
        ? { evidence: String(milestone?.evidence || '').trim().slice(0, 4000) }
        : {}),
    });
  }
  if (milestones.filter((milestone) => milestone.status === 'active').length > 1) {
    return { error: '监督阶段计划同时只能有一个 active 里程碑' };
  }
  const expectedPaths = projectStringArray(input.expectedPaths);
  if (expectedPaths.some((entry) => !safeProjectRelativePath(entry))) {
    return { error: '监督阶段计划的 expectedPaths 只能使用项目内相对路径' };
  }
  const targetedValidation = projectStringArray(input.targetedValidation);
  const serializedBoundaries = projectStringArray(input.serializedBoundaries);
  const remainingWork = projectStringArray(input.remainingWork);
  if (workItem.supervisorPlan
    && workItem.supervisorPlan.selectedRoute !== selectedRoute
    && !workItem.contract.authority.routeAdjustments) {
    return { error: '任务契约未授权监督 AI 调整既定技术路线；请保持 selectedRoute 不变或按 contract-change 升级项目 AI' };
  }
  const scopeError = projectContractViolation(workItem.contract, {
    instruction: [
      selectedRoute,
      ...milestones.map((milestone) => milestone.outcome),
      ...serializedBoundaries,
      ...remainingWork,
    ].join('\n'),
    changedFiles: expectedPaths,
  });
  if (scopeError) return { error: `监督阶段计划越出项目 AI 给定的硬边界：${scopeError}` };
  for (const command of targetedValidation) {
    const validationError = projectContractViolation(workItem.contract, { testCommand: command });
    if (validationError) return { error: `监督阶段计划中的验证越出硬边界：${validationError}` };
  }
  return {
    plan: {
      revision: (workItem.supervisorPlan?.revision || 0) + 1,
      selectedRoute,
      milestones,
      expectedPaths,
      targetedValidation,
      serializedBoundaries,
      remainingWork,
      updatedAt: Date.now(),
    },
  };
}

function projectRequirementIdentity(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function mergeProjectRequirements(primary: readonly string[], inherited: readonly string[]): string[] {
  const result = [...primary];
  for (const candidate of inherited) {
    const identity = projectRequirementIdentity(candidate);
    const duplicate = result.some((existing) => {
      const existingIdentity = projectRequirementIdentity(existing);
      return identity === existingIdentity
        || (Math.min(identity.length, existingIdentity.length) >= 12
          && (identity.includes(existingIdentity) || existingIdentity.includes(identity)));
    });
    if (!duplicate) result.push(candidate);
  }
  return result;
}

function normalizeProjectSubgoalsInput(
  raw: unknown,
  session: ProjectManagerSession,
): { subgoals?: ProjectSubgoal[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
    return { error: '阶段目标必须是包含 1-20 项的数组，通常保持 3-7 项' };
  }
  const activeGoal = activeProjectGoal(session);
  const existing = new Map((session.subgoals || [])
    .filter((subgoal) => subgoal.goalId === activeGoal.id)
    .map((subgoal) => [subgoal.id, subgoal]));
  const now = Date.now();
  const subgoals: ProjectSubgoal[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const candidate = raw[index] as Record<string, unknown> | null;
    const id = String(candidate?.id || '').trim();
    const title = String(candidate?.title || '').trim().slice(0, 200);
    const outcome = String(candidate?.outcome || '').trim().slice(0, 4000);
    const acceptance = projectStringArray(candidate?.acceptance);
    const dependencies = projectStringArray(candidate?.dependencies);
    const status = String(candidate?.status || 'planned');
    if (!PROJECT_WORK_ITEM_ID.test(id)) return { error: `阶段目标 ${index + 1} 的 ID 格式无效` };
    if (!title || !outcome || acceptance.length === 0) {
      return { error: `阶段目标 ${id} 必须包含 title、outcome 和至少一项 acceptance` };
    }
    if (!['planned', 'active', 'blocked', 'achieved', 'obsolete'].includes(status)) {
      return { error: `阶段目标 ${id} 的状态无效：${status}` };
    }
    const previous = existing.get(id);
    subgoals.push({
      id,
      goalId: activeGoal.id,
      title,
      outcome,
      acceptance,
      dependencies,
      status: status as ProjectSubgoal['status'],
      order: index + 1,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    });
  }
  const unfinished = subgoals.filter((subgoal) => !['achieved', 'obsolete'].includes(subgoal.status));
  if (unfinished.length > 7) {
    return { error: '当前主目标同时只能保留 1-7 个未完成阶段；请合并微小步骤或将已结束阶段标记为 achieved/obsolete' };
  }
  return { subgoals };
}

function normalizeProjectWorkItemInput(
  raw: any,
  projectDir: string,
  previous?: ProjectWorkItem,
  requireExplicitAuthority = !previous,
  session?: ProjectManagerSession,
): { workItem?: ProjectWorkItem; error?: string } {
  const id = String(raw?.id || previous?.id || '').trim();
  if (!PROJECT_WORK_ITEM_ID.test(id)) return { error: '任务 ID 仅允许 1-80 位字母、数字、下划线或短横线' };
  const contractRaw = raw?.contract || previous?.contract || {};
  const objective = String(contractRaw.objective || '').trim();
  const stopWhen = projectStringArray(contractRaw.stopWhen);
  const validation = projectStringArray(contractRaw.validation);
  if (!objective || stopWhen.length === 0 || validation.length === 0) {
    return { error: '任务必须包含 objective、stopWhen 和 validation' };
  }
  const normalizedProjectDir = normalizeAbsolutePath(projectDir);
  const root = String(contractRaw.scope?.root || projectDir).trim();
  if (!normalizedProjectDir || normalizeAbsolutePath(root) !== normalizedProjectDir) {
    return { error: '任务工作根目录必须与项目管理会话目录一致' };
  }
  const allowPaths = projectStringArray(contractRaw.scope?.allowPaths);
  const denyPaths = projectStringArray(contractRaw.scope?.denyPaths);
  if (![...allowPaths, ...denyPaths].every(safeProjectRelativePath)) {
    return { error: '任务路径范围必须是项目内相对路径，不能包含 .. 或绝对路径' };
  }
  const status = String(raw?.status || previous?.status || 'planned');
  if (!PROJECT_WORK_ITEM_STATUSES.has(status)) return { error: `无效任务状态：${status}` };
  const executionRaw = contractRaw.execution || previous?.contract.execution || {};
  if (executionRaw.taskWorkMode !== undefined
    && !TASK_WORK_MODE_VALUES.includes(String(executionRaw.taskWorkMode) as TaskWorkMode)) {
    return { error: `无效任务执行模式：${String(executionRaw.taskWorkMode)}` };
  }
  const taskWorkMode = normalizeTaskWorkMode(executionRaw.taskWorkMode);
  const modeReason = String(executionRaw.modeReason || '').trim().slice(0, 2000)
    || (taskWorkMode === 'single-thread'
      ? '任务复杂度不需要拆分内部线程，采用保守的单线程执行'
      : '');
  const mainThreadResponsibility = normalizeTaskThreadResponsibility(
    executionRaw.mainThreadResponsibility || objective,
  ).trim();
  const requestedChildThreadResponsibilities = normalizeTaskChildThreadResponsibilities(
    executionRaw.childThreadResponsibilities,
  ).map((item) => item.trim()).filter(Boolean);
  const childThreadResponsibilities = taskWorkMode === 'multi-thread'
    ? requestedChildThreadResponsibilities
    : [];
  const requestedMaxChildThreads = Number(executionRaw.maxChildThreads);
  const maxChildThreads = normalizeTaskMaxChildThreads(executionRaw.maxChildThreads);
  const supervisorMayApproveThreads = executionRaw.supervisorMayApproveThreads === true;
  const parallelizableOperations = normalizeTaskOperationBoundaries(
    projectStringArray(executionRaw.parallelizableOperations),
  );
  const serializedOperations = normalizeTaskOperationBoundaries(
    projectStringArray(executionRaw.serializedOperations),
  );
  if (taskWorkMode === 'multi-thread' && (
    !modeReason || !mainThreadResponsibility || childThreadResponsibilities.length === 0
  )) {
    return { error: '多线程任务必须说明选择理由、主线程职责和至少一个子线程职责' };
  }
  if (taskWorkMode !== 'single-thread' && contractRaw.authority?.internalThreads !== true) {
    return { error: '多线程或自适应任务必须明确授权 internalThreads' };
  }
  if (taskWorkMode === 'adaptive' && requestedChildThreadResponsibilities.length > 0) {
    return { error: '自适应任务不能预分配子线程职责；应在只读探测后由任务 AI 提案' };
  }
  if (taskWorkMode === 'adaptive' && (
    !modeReason
    || !mainThreadResponsibility
    || !Number.isInteger(requestedMaxChildThreads)
    || requestedMaxChildThreads < 1
    || requestedMaxChildThreads > MAX_TASK_CHILD_THREADS
    || !supervisorMayApproveThreads
    || parallelizableOperations.length === 0
    || serializedOperations.length === 0
  )) {
    return {
      error: `自适应任务必须说明理由和主线程职责，明确 1-${MAX_TASK_CHILD_THREADS} 个子线程上限，授权监督 AI 审批，并分别列出可并行与必须串行操作`,
    };
  }
  if (requireExplicitAuthority && (
    typeof contractRaw.authority?.continuousExecution !== 'boolean'
    || typeof contractRaw.authority?.permissionConfirm !== 'boolean'
  )) {
    return { error: '任务必须明确设置 authority.continuousExecution 和 authority.permissionConfirm，不能继承隐式权限' };
  }
  const continuationBoundary = String(contractRaw.authority?.continuationBoundary || '').trim();
  const validContinuationBoundaries = new Set([
    'project-owned-decision', 'external-prerequisite', 'high-risk-boundary',
  ]);
  if (contractRaw.authority?.continuousExecution === false
    && !validContinuationBoundaries.has(continuationBoundary)) {
    return { error: '禁用 continuousExecution 时必须通过 continuationBoundary 说明真实停止边界，不能退化为逐步授权' };
  }
  if (contractRaw.authority?.continuousExecution === true && continuationBoundary) {
    return { error: '启用 continuousExecution 时不能同时设置 continuationBoundary' };
  }
  const allowedCommandPrefixes = projectStringArray(contractRaw.authority?.allowedCommandPrefixes)
    .map((item) => item.slice(0, 240));
  if (contractRaw.authority?.permissionConfirm === true
    && contractRaw.authority?.targetedTests !== true
    && allowedCommandPrefixes.length === 0) {
    return { error: '启用 permissionConfirm 时必须授权 targetedTests 或提供 allowedCommandPrefixes' };
  }
  if (contractRaw.authority?.permissionConfirm !== true && allowedCommandPrefixes.length > 0) {
    return { error: '未启用 permissionConfirm 时不能提供 allowedCommandPrefixes' };
  }
  // Runtime bindings are control-plane owned. Project AI defines the contract;
  // the dedicated supervisor creates and binds the task terminal afterwards.
  const workerSurfaceId = String(previous?.workerSurfaceId || '').trim() || undefined;
  if (workerSurfaceId) {
    const worker = remoteTerminalList().find((terminal) => terminal.surfaceId === workerSurfaceId);
    if (!worker) return { error: `任务终端不存在：${workerSurfaceId}` };
    const workerDirectory = normalizeAbsolutePath(worker.projectDir || worker.cwd || '');
    if (!workerDirectory || (
      workerDirectory !== normalizedProjectDir && !workerDirectory.startsWith(`${normalizedProjectDir}/`)
    )) {
      return { error: '任务终端必须位于该项目目录内，不能跨项目绑定' };
    }
  }
  const now = Date.now();
  const activeGoal = session ? activeProjectGoal(session) : undefined;
  const goalId = String(previous?.goalId || raw?.goalId || activeGoal?.id || '').trim() || undefined;
  const availableSubgoals = session ? activeProjectSubgoals(session).filter((candidate) => (
    !['achieved', 'obsolete'].includes(candidate.status)
  )) : [];
  const subgoalId = String(
    raw?.subgoalId !== undefined
      ? raw.subgoalId
      : previous?.subgoalId || (availableSubgoals.length === 1 ? availableSubgoals[0].id : ''),
  ).trim() || undefined;
  if (session && !previous) {
    if (!goalId || goalId !== activeGoal?.id) return { error: '新任务必须归属于当前主目标' };
    if (!subgoalId) return { error: '新任务必须指定当前主目标下的 subgoalId' };
    const subgoal = availableSubgoals.find((candidate) => candidate.id === subgoalId);
    if (!subgoal || ['achieved', 'obsolete'].includes(subgoal.status)) {
      return { error: `阶段目标不存在或已经结束：${subgoalId}` };
    }
  }
  if (session && previous?.goalId && previous.goalId !== activeGoal?.id) {
    return { error: '旧主目标任务已经失效，不能重新绑定到当前主目标' };
  }
  if (session && previous && subgoalId !== previous.subgoalId) {
    const subgoal = availableSubgoals.find((candidate) => candidate.id === subgoalId);
    if (!subgoal) return { error: `任务只能重分配到当前主目标下的有效阶段：${subgoalId || '未指定'}` };
  }
  const linkedSubgoal = session && subgoalId
    ? activeProjectSubgoals(session).find((candidate) => candidate.id === subgoalId)
    : undefined;
  const effectiveStopWhen = mergeProjectRequirements(stopWhen, linkedSubgoal?.acceptance || []);
  const rebindCurrentRequirements = raw?.rebindCurrentRequirements === true;
  const previousExecutionProtocolVersion = previous?.executionProtocolVersion || 0;
  const rebindCurrentExecutionProtocol = !!previous
    && previousExecutionProtocolVersion < CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION
    && requireExplicitAuthority;
  const requirementsVersion = session
    ? previous && !rebindCurrentRequirements
      ? previous.requirementsVersion || projectRequirementsVersion(session)
      : projectRequirementsVersion(session)
    : previous?.requirementsVersion;
  return {
    workItem: {
      id,
      goalId,
      subgoalId,
      requirementsVersion,
      authorizationVersion: session
        ? previous && !rebindCurrentRequirements
          ? previous.authorizationVersion || projectAuthorizationVersion(session)
          : projectAuthorizationVersion(session)
        : previous?.authorizationVersion,
      executionProtocolVersion: previous
        ? rebindCurrentExecutionProtocol
          ? CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION
          : previousExecutionProtocolVersion
        : CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
      baseline: previous && !rebindCurrentRequirements && !rebindCurrentExecutionProtocol
        ? previous.baseline || requiredProjectTaskBaseline(requirementsVersion || 1)
        : requiredProjectTaskBaseline(requirementsVersion || 1),
      supervisorPlan: previous && !rebindCurrentRequirements && !rebindCurrentExecutionProtocol
        ? previous.supervisorPlan
        : undefined,
      supervisorPlanRequired: previous?.supervisorPlanRequired ?? true,
      title: String(raw?.title || previous?.title || id).trim().slice(0, 200),
      contract: {
        objective,
        description: String(contractRaw.description || '').trim().slice(0, 4000),
        preconditions: projectStringArray(contractRaw.preconditions),
        supervisorNotes: projectStringArray(contractRaw.supervisorNotes)
          .slice(0, 20).map((note) => note.slice(0, 4000)),
        scope: {
          root: projectDir,
          allowPaths,
          denyPaths,
          forbiddenActions: projectStringArray(contractRaw.scope?.forbiddenActions),
        },
        authority: {
          technicalChoices: contractRaw.authority?.technicalChoices === true,
          lowRiskRetries: contractRaw.authority?.lowRiskRetries === true,
          routeAdjustments: contractRaw.authority?.routeAdjustments === true,
          targetedTests: contractRaw.authority?.targetedTests === true,
          internalThreads: contractRaw.authority?.internalThreads === true,
          continuousExecution: contractRaw.authority?.continuousExecution === true,
          ...(continuationBoundary ? {
            continuationBoundary: continuationBoundary as ProjectSupervisorContract['authority']['continuationBoundary'],
          } : {}),
          permissionConfirm: contractRaw.authority?.permissionConfirm === true,
          allowedCommandPrefixes,
          authorizedDevices: projectStringArray(contractRaw.authority?.authorizedDevices),
          authorizedEnvironments: projectStringArray(contractRaw.authority?.authorizedEnvironments),
          authorizedOperations: projectStringArray(contractRaw.authority?.authorizedOperations),
        },
        execution: {
          taskWorkMode,
          modeReason,
          mainThreadResponsibility,
          childThreadResponsibilities,
          ...(taskWorkMode === 'adaptive' ? {
            maxChildThreads,
            supervisorMayApproveThreads,
            parallelizableOperations,
            serializedOperations,
          } : {}),
        },
        stopWhen: effectiveStopWhen,
        validation,
        budget: normalizeProjectExecutionBudget(contractRaw.budget),
      },
      status: status as ProjectWorkItem['status'],
      dependencies: projectStringArray(raw?.dependencies ?? previous?.dependencies),
      supervisorLaneId: String(previous?.supervisorLaneId || '').trim() || undefined,
      workerSurfaceId,
      // These counters are owned by the control layer. Accepting them from task-create/task-update
      // would let the project-management AI reset anti-loop accounting.
      attempts: rebindCurrentExecutionProtocol ? 0 : previous?.attempts ?? 0,
      decisionsUsed: rebindCurrentExecutionProtocol ? 0 : previous?.decisionsUsed ?? 0,
      startedAt: rebindCurrentExecutionProtocol ? undefined : previous?.startedAt,
      updatedAt: now,
      completedAt: status === 'completed' ? previous?.completedAt || now : undefined,
      executionHistory: rebindCurrentExecutionProtocol ? [] : previous?.executionHistory || [],
      latestEvidence: String(raw?.latestEvidence ?? previous?.latestEvidence ?? '').trim() || undefined,
      latestContextSummary: String(raw?.latestContextSummary ?? previous?.latestContextSummary ?? '').trim() || undefined,
      latestBlocker: String(
        raw?.latestBlocker ?? (rebindCurrentExecutionProtocol ? '' : previous?.latestBlocker) ?? '',
      ).trim() || undefined,
    },
  };
}

function projectManagerCallerAllowed(
  callerSurfaceId: string,
  session: ProjectManagerSession | null,
): boolean {
  if (!callerSurfaceId || !session || session.managerSurfaceId !== callerSurfaceId) return false;
  return projectManagerTerminal({ surfaceId: callerSurfaceId, projectId: session.id })?.surfaceId === callerSurfaceId;
}

export type ProjectMessageChangeSignal = 'prerequisite-change' | 'requirements-change';

/** Only high-confidence user statements revoke the current project contract automatically. */
export function projectMessageChangeSignal(message: string): ProjectMessageChangeSignal | null {
  const text = message.trim();
  if (!text) return null;
  const hypotheticalOnly = /(?:如果|假如|假设|是否|会不会|怎么办|怎样处理)/u.test(text)
    && !/(?:已|现在|当前|刚刚|确认|实际)/u.test(text);
  if (hypotheticalOnly) return null;
  if (
    /(?:(?:硬件|设备|板卡|仪器|电源|环境|连接|网络).{0,16}(?:断电|掉电|未上电|离线|断开|不可用|更换|失效|不再满足))|(?:(?:已|现在|当前|刚刚).{0,8}(?:断电|掉电|停止上电|断开连接))|(?:(?:撤销|取消|收回).{0,12}(?:授权|许可|上机|实测))|(?:(?:前置条件|安全条件|环境条件).{0,16}(?:变化|变更|不再满足|失效))/u.test(text)
  ) {
    return 'prerequisite-change';
  }
  if (
    /(?:(?:需求|目标|范围|完成条件|验收标准|优先级).{0,12}(?:变更|变化|修改|调整|改为|取消|新增|删除))|(?:不再需要|不要再做|改做|换成).{0,40}/u.test(text)
  ) {
    return 'requirements-change';
  }
  return null;
}

function pendingProjectTaskStartupLane(
  callerSurfaceId: string,
  params: any,
): SupervisorLane | undefined {
  const projectId = String(params?.projectId || '').trim();
  const workItemId = String(params?.workItemId || '').trim();
  return useStore.getState().supervisor.lanes.find((lane) => (
    lane.projectTaskStartupPending === true
    && lane.supervisorSurfaceId === callerSurfaceId
    && lane.projectManagerProjectId === projectId
    && lane.projectWorkItemId === workItemId
    && supervisorLaneControlState(lane) === 'active'
  ));
}

function pendingProjectTaskRotationLane(
  callerSurfaceId: string,
  params: any,
): SupervisorLane | undefined {
  const projectId = String(params?.projectId || '').trim();
  const workItemId = String(params?.workItemId || '').trim();
  return useStore.getState().supervisor.lanes.find((lane) => (
    lane.projectTaskRotationPending === true
    && !!lane.projectTaskRotationSummary
    && lane.supervisorSurfaceId === callerSurfaceId
    && lane.projectManagerProjectId === projectId
    && lane.projectWorkItemId === workItemId
    && supervisorLaneControlState(lane) === 'active'
  ));
}

function projectTaskControlLane(
  callerSurfaceId: string,
  params: any,
): SupervisorLane | undefined {
  const projectId = String(params?.projectId || '').trim();
  const workItemId = String(params?.workItemId || '').trim();
  return useStore.getState().supervisor.lanes.find((lane) => (
    lane.projectTaskStartupPending !== true
    && lane.supervisorSurfaceId === callerSurfaceId
    && lane.projectManagerProjectId === projectId
    && lane.projectWorkItemId === workItemId
    && supervisorLaneControlState(lane) === 'active'
  ));
}

function closeLiveSurfaceById(surfaceId: SurfaceId): boolean {
  const store = useStore.getState();
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      if (!findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => surface.id === surfaceId)) continue;
      store.closeSurface(workspace.id, paneId, surfaceId);
      return true;
    }
  }
  return false;
}

function projectSupervisorLaneIds(session: Pick<ProjectManagerSession, 'id'>): string[] {
  return scopedProjectSupervisorLaneIds(session, useStore.getState().supervisor.lanes);
}

function resumeEligibleProjectSupervisorLanes(sessionId: string, reason: string): void {
  const state = useStore.getState();
  const session = state.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session) return;
  const activeGoalId = activeProjectGoal(session).id;
  for (const lane of state.supervisor.lanes.filter((candidate) => (
    candidate.projectManagerProjectId === sessionId && supervisorLaneControlState(candidate) !== 'stopped'
  ))) {
    const item = session.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
    const eligible = !!item
      && item.goalId === activeGoalId
      && !['completed', 'stopped'].includes(item.status)
      && item.requirementsVersion === projectRequirementsVersion(session)
      && item.authorizationVersion === projectAuthorizationVersion(session)
      && (!item.subgoalId || !projectWorkItemSubgoalDependencyError(session, item));
    if (eligible) state.resumeSupervisorLane(lane.id, reason);
    else state.pauseSupervisorLane(lane.id, '监督链尚未绑定当前主目标的可执行任务，保持暂停直到项目 AI 重新派发');
  }
}

function projectExecutionWorkspaceId(lane: SupervisorLane): WorkspaceId | undefined {
  if (!lane.supervisorSurfaceId || !lane.projectManagerProjectId) return undefined;
  for (const workspace of useStore.getState().workspaces) {
    if (workspace.transientSupervisorWorkspace !== true) continue;
    const ownsSupervisor = getAllPaneIds(workspace.splitTree).some((paneId) => (
      findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
        surface.id === lane.supervisorSurfaceId
        && surface.type === 'terminal'
        && surface.projectSupervisorProjectId === lane.projectManagerProjectId
      ))
    ));
    if (ownsSupervisor) return workspace.id;
  }
  return undefined;
}

function projectExecutionIdentity(session: ProjectManagerSession, item: ProjectWorkItem) {
  return {
    projectId: session.id,
    goalId: item.goalId || activeProjectGoal(session).id,
    workItemId: item.id,
    requirementsVersion: item.requirementsVersion || projectRequirementsVersion(session),
    authorizationVersion: item.authorizationVersion || projectAuthorizationVersion(session),
  };
}

function projectRecoveryBriefing(session: ProjectManagerSession, item: ProjectWorkItem): string {
  const recentEvents = session.events
    .filter((event) => !event.workItemId || event.workItemId === item.id)
    .slice(-12)
    .map((event) => `- ${event.kind}：${event.summary}`);
  return [
    '[项目任务冷启动恢复包｜旧终端会话不可恢复]',
    buildProjectExecutionIdentityBlock(projectExecutionIdentity(session, item)),
    `项目 ID：${session.id}`,
    `项目目录：${session.projectDir}`,
    `项目目标：${session.goal}`,
    `工作项：${item.id} · ${item.title}`,
    `当前任务：${item.contract.objective}`,
    item.latestContextSummary ? `最近上下文总结：${item.latestContextSummary}` : '最近上下文总结：无；必须先只读核对工作区。',
    item.latestEvidence ? `已有执行证据：${item.latestEvidence}` : '已有执行证据：无。',
    item.latestBlocker ? `最近阻塞：${item.latestBlocker}` : '',
    recentEvents.length > 0 ? `最近决策记录：\n${recentEvents.join('\n')}` : '',
    '',
    '恢复规则：这是新的监督 AI 和新的任务 AI 对话。控制层已经建立上面的本轮执行身份；旧 supervisorLaneId、workerSurfaceId 和终端会话均已失效，只能作为审计历史，禁止读取、发送、重新绑定、等待或反复尝试重建任何旧终端。先只读检查当前文件、diff、测试产物和进程状态，再决定下一步；不得重新执行已有证据支持的步骤，不得把“会话已丢失”误判为“工作未完成”。',
  ].filter(Boolean).join('\n');
}

function replaceProjectManagerSession(session: ProjectManagerSession): void {
  const state = useStore.getState();
  state.restoreProjectManagers(
    state.projectManagers.map((candidate) => candidate.id === session.id ? session : candidate),
    state.selectedProjectManagerId || undefined,
  );
}

function projectProgressSummary(
  diff: ProjectProgressDiff,
  current: ProjectProgressSnapshot,
  previous?: ProjectProgressSnapshot,
): string {
  const changedPaths = [...new Set([...diff.added, ...diff.modified, ...diff.removed])];
  const currentWorkspaceEntries = current.entries.filter((entry) => entry.source === 'workspace');
  const currentPlanEntries = current.entries.filter((entry) => entry.source === 'plan');
  return [
    diff.baselineMissing
      ? '缺少恢复前可信工作区指纹；本次现状必须由项目 AI 复核后才能继续派发。'
      : diff.changed
        ? '项目目录与上次已知进度不一致，可能包含其他 AI、人工操作或中断前尚未汇报的工作。'
        : '项目目录与上次已知进度一致。',
    `采集方式：${current.mode === 'git' ? 'Git 工作区' : '有界文件系统快照'}；当前指纹：${current.fingerprint.slice(0, 16)}`,
    diff.headChanged ? `Git HEAD：${previous?.head?.slice(0, 12) || '无'} → ${current.head?.slice(0, 12) || '无'}` : '',
    diff.headChanged && current.headSummary ? `当前提交：${current.headSummary}` : '',
    diff.branchChanged ? `Git 分支：${previous?.branch || '无'} → ${current.branch || '无'}` : '',
    `差异统计：新增记录 ${diff.added.length}、内容/状态变化 ${diff.modified.length}、不再出现 ${diff.removed.length}。`,
    current.mode === 'git'
      ? `当前未提交/未跟踪文件记录：${currentWorkspaceEntries.length}`
      : `当前纳入快照的项目文件：${currentWorkspaceEntries.length}`,
    currentPlanEntries.length > 0 ? `计划文件快照：${currentPlanEntries.length} 个。` : '',
    changedPaths.length > 0
      ? `主要变化：\n${changedPaths.slice(0, 40).map((filePath) => `- ${filePath}`).join('\n')}`
      : '',
    changedPaths.length > 40 ? `另有 ${changedPaths.length - 40} 项变化未展开。` : '',
    current.truncated ? '快照已达到 500 项上限；项目 AI 必须结合 git/status 做补充只读核对。' : '',
  ].filter(Boolean).join('\n').slice(0, 12_000);
}

async function captureProjectProgressSnapshot(
  session: ProjectManagerSession,
): Promise<{ snapshot?: ProjectProgressSnapshot; error?: string }> {
  const capture = (window as any).wmux?.projectManager?.captureProgress;
  if (typeof capture !== 'function') return { error: '项目进度同步接口尚未就绪，请重启 wmux' };
  try {
    const result = await capture(session.projectDir, (session.planFiles || []).map((file) => file.path));
    if (!result?.ok || !result.snapshot) return { error: String(result?.error || '无法采集项目目录现状') };
    return { snapshot: result.snapshot as ProjectProgressSnapshot };
  } catch (error) {
    return { error: String((error as Error)?.message || error) };
  }
}

function progressSyncFailureSession(session: ProjectManagerSession, reason: string): ProjectManagerSession {
  const failed: ProjectManagerSession = {
    ...session,
    progressSync: {
      status: 'review-required',
      checkedAt: Date.now(),
      snapshotFingerprint: session.progressSnapshot?.fingerprint || 'capture-unavailable',
      summary: `项目目录现状采集失败：${reason}`,
      changeCount: 0,
      reason,
    },
    updatedAt: Date.now(),
  };
  return {
    ...failed,
    orientation: requiredProjectOrientation(failed, `项目目录现状采集失败：${reason}`),
  };
}

async function scanProjectProgressForReview(
  sessionId: string,
  reason: string,
  notifyManager = true,
): Promise<{ ok: boolean; reviewRequired: boolean; summary: string; error?: string }> {
  const initial = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!initial) return { ok: false, reviewRequired: true, summary: '', error: '项目不存在' };
  const captured = await captureProjectProgressSnapshot(initial);
  if (!captured.snapshot) {
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
    const failed = progressSyncFailureSession(current, captured.error || '未知错误');
    replaceProjectManagerSession(failed);
    useStore.getState().appendProjectManagerEvent({
      kind: 'progress-sync-required',
      summary: failed.progressSync!.summary,
      payload: { reason, captureFailed: true },
    }, sessionId);
    saveProjectManagerSnapshot(sessionId);
    if (notifyManager) queueProjectManagerDelivery([
      '[项目进度同步失败｜禁止沿用旧安排]',
      `项目：${sessionId} · ${initial.projectDir}`,
      failed.progressSync!.summary,
      '请检查项目目录可访问性；恢复同步前不得创建或派发旧任务。',
    ].join('\n'), sessionId);
    return { ok: false, reviewRequired: true, summary: failed.progressSync!.summary, error: captured.error };
  }
  const latest = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
  const current = captured.snapshot;
  const diff = diffProjectProgressSnapshots(latest.progressSnapshot, current);
  const pendingReview = latest.progressSync?.status === 'review-required';
  const reviewRequired = diff.changed || pendingReview;
  const incrementalSummary = projectProgressSummary(diff, current, latest.progressSnapshot);
  const summary = !diff.changed && pendingReview && latest.progressSync?.summary
    ? latest.progressSync.summary
    : diff.changed && pendingReview && latest.progressSync?.summary
      ? [
          latest.progressSync.summary,
          '',
          '[项目 AI 复核期间工作区再次变化]',
          incrementalSummary,
        ].join('\n').slice(0, 12_000)
      : incrementalSummary;
  const changeCount = diff.changed && pendingReview
    ? (latest.progressSync?.changeCount || 0) + diff.changeCount
    : diff.changeCount;
  const stateChanged = diff.changed
    || !latest.progressSync
    || latest.progressSync.snapshotFingerprint !== current.fingerprint;
  const next: ProjectManagerSession = {
    ...latest,
    progressSnapshot: current,
    progressSync: {
      status: reviewRequired ? 'review-required' : 'ready',
      checkedAt: Date.now(),
      snapshotFingerprint: current.fingerprint,
      summary,
      changeCount,
      reason,
      ...(!reviewRequired ? { acknowledgedAt: Date.now(), acknowledgement: '控制层确认工作区未变化' } : {}),
    },
    workItems: diff.changed
      ? latest.workItems.map((item) => ['completed', 'stopped'].includes(item.status) ? item : {
          ...item,
          baseline: requiredProjectTaskBaseline(item.requirementsVersion || projectRequirementsVersion(latest)),
          updatedAt: Date.now(),
        })
      : latest.workItems,
    updatedAt: Date.now(),
  };
  if (diff.changed || !latest.orientation || latest.orientation.status === 'required') {
    next.orientation = requiredProjectOrientation(
      next,
      diff.changed
        ? `项目目录出现外部进度变化：${reason}`
        : latest.orientation?.reason || '项目尚未建立认知基线',
      latest.orientation?.status === 'required' ? latest.orientation.requestedAt : Date.now(),
    );
  } else {
    next.orientation = { ...latest.orientation, snapshotFingerprint: current.fingerprint };
  }
  replaceProjectManagerSession(next);
  if (stateChanged) {
    useStore.getState().appendProjectManagerEvent({
      kind: reviewRequired ? 'progress-sync-required' : 'progress-snapshot',
      summary: reviewRequired ? '检测到恢复期间的项目进度变化，等待项目 AI 复核' : '项目进度快照与已知状态一致',
      payload: {
        reason,
        fingerprint: current.fingerprint,
        mode: current.mode,
        changeCount,
        baselineMissing: diff.baselineMissing,
        summary,
      },
    }, sessionId);
    if (next.orientation.status === 'required') {
      useStore.getState().appendProjectManagerEvent({
        kind: 'project-orientation-required',
        summary: next.orientation.reason,
        payload: {
          reason,
          fingerprint: current.fingerprint,
          requirementsVersion: next.orientation.requirementsVersion,
          authorizationVersion: next.orientation.authorizationVersion,
        },
      }, sessionId);
    }
  }
  saveProjectManagerSnapshot(sessionId);
  if (reviewRequired && stateChanged && notifyManager) {
    queueProjectManagerDelivery([
      '[项目进度同步｜继续前必须由项目 AI 复核]',
      `项目：${sessionId} · ${latest.projectDir}`,
      `触发原因：${reason}`,
      summary,
      '',
      '把当前目录事实视为权威：先结合这里列出的提交/路径变化与持久化证据调整工作项和阶段安排。哈希与路径只证明“发生了变化”，不证明语义正确或已经完成；无法从现有证据判断的部分保持未完成，并交给恢复后的监督/任务 AI 通过强制新基线做只读核对。不要覆盖、回滚或从头重做未知来源的已有工作。',
      `更新安排后执行 wmux project progress-sync --project ${sessionId} --ack --summary "<已知变化、未知项和下一步核对安排>"。该确认只表示后续调度已改用当前快照，不代表代码正确或验收完成。确认前控制层拒绝 resume、task-create 和 supervise；这不需要询问用户，除非变化引出了真正的业务选择或高风险冲突。`,
    ].join('\n'), sessionId);
  }
  return { ok: true, reviewRequired, summary };
}

async function checkpointProjectProgress(sessionId: string, reason: string): Promise<boolean> {
  const initial = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!initial) return false;
  if (initial.progressSync?.status === 'review-required') return false;
  const captured = await captureProjectProgressSnapshot(initial);
  if (!captured.snapshot) {
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
    const failed = progressSyncFailureSession(current, captured.error || '未知错误');
    replaceProjectManagerSession(failed);
    useStore.getState().appendProjectManagerEvent({
      kind: 'progress-sync-required',
      summary: failed.progressSync!.summary,
      payload: { reason, captureFailed: true },
    }, sessionId);
    saveProjectManagerSnapshot(sessionId);
    queueProjectManagerDelivery([
      '[项目进度检查点保存失败｜继续前必须复核]',
      `项目：${sessionId} · ${initial.projectDir}`,
      failed.progressSync!.summary,
      '项目 AI 必须先恢复目录访问并重新执行 progress-sync；不得按旧工作区信息继续派发。',
    ].join('\n'), sessionId);
    return false;
  }
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
  const next: ProjectManagerSession = {
    ...current,
    progressSnapshot: captured.snapshot,
    progressSync: {
      status: 'ready',
      checkedAt: Date.now(),
      snapshotFingerprint: captured.snapshot.fingerprint,
      summary: `已记录可信项目进度检查点：${reason}`,
      changeCount: 0,
      reason,
      acknowledgedAt: Date.now(),
      acknowledgement: reason,
    },
    updatedAt: Date.now(),
  };
  next.orientation = current.orientation?.status === 'ready'
    ? { ...current.orientation, snapshotFingerprint: captured.snapshot.fingerprint }
    : requiredProjectOrientation(
        next,
        current.orientation?.reason || reason,
        current.orientation?.requestedAt || Date.now(),
      );
  replaceProjectManagerSession(next);
  useStore.getState().appendProjectManagerEvent({
    kind: 'progress-snapshot',
    summary: `已记录项目进度检查点：${reason}`,
    payload: { fingerprint: captured.snapshot.fingerprint, mode: captured.snapshot.mode },
  }, sessionId);
  saveProjectManagerSnapshot(sessionId);
  return true;
}

async function acknowledgeProjectProgress(
  sessionId: string,
  acknowledgement: string,
): Promise<{ ok: boolean; error?: string; summary?: string }> {
  const initial = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!initial) return { ok: false, error: '项目不存在' };
  const detail = acknowledgement.trim().slice(0, 4000);
  if (!detail) return { ok: false, error: '确认项目进度同步必须提供 --summary，说明变化影响和后续安排' };
  const captured = await captureProjectProgressSnapshot(initial);
  if (!captured.snapshot) return { ok: false, error: captured.error || '无法复核项目目录现状' };
  const latest = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
  if (!latest.progressSnapshot || captured.snapshot.fingerprint !== latest.progressSnapshot.fingerprint) {
    await scanProjectProgressForReview(sessionId, '项目 AI 复核期间工作区再次变化');
    return { ok: false, error: '项目 AI 复核期间工作区再次变化，已刷新同步摘要；请按最新现状重新复核' };
  }
  if (latest.progressSync?.status !== 'review-required') {
    return { ok: true, summary: latest.progressSync?.summary || '项目进度已经同步，无需重复确认' };
  }
  const now = Date.now();
  const next: ProjectManagerSession = {
    ...latest,
    progressSnapshot: captured.snapshot,
    progressSync: {
      ...latest.progressSync,
      status: 'ready',
      checkedAt: now,
      snapshotFingerprint: captured.snapshot.fingerprint,
      acknowledgedAt: now,
      acknowledgement: detail,
    },
    updatedAt: now,
  };
  replaceProjectManagerSession(next);
  useStore.getState().appendProjectManagerEvent({
    kind: 'progress-sync-acknowledged',
    summary: `项目 AI 已复核外部进度：${detail}`,
    payload: { fingerprint: captured.snapshot.fingerprint, acknowledgement: detail },
  }, sessionId);
  saveProjectManagerSnapshot(sessionId);
  return { ok: true, summary: next.progressSync!.summary };
}

function projectProgressReviewError(session: ProjectManagerSession): string | null {
  if (session.progressSync?.status !== 'review-required') return null;
  return `项目目录存在尚未复核的进度变化，禁止沿用旧合同。先检查 project status 中的 progressSync.summary，再执行 wmux project progress-sync --project ${session.id} --ack --summary "<影响判断和安排>"`;
}

function projectOrientationReviewError(session: ProjectManagerSession): string | null {
  if (projectOrientationReady(session)) return null;
  return `项目认知基线尚未确认，禁止规划或派发。先读取 project status 的目标、前置条件、progressSync、orientation、工作项和最近事件，在 JSON 中原样携带 orientation 的 requirementsVersion、authorizationVersion、snapshotFingerprint、requestedAt，再执行 wmux project orientation-confirm --project ${session.id} --json-file <项目目录内的 .wmux/tmp/文件>`;
}

async function acknowledgeProjectOrientation(
  sessionId: string,
  value: any,
): Promise<{ ok: boolean; error?: string; orientation?: ProjectManagerSession['orientation'] }> {
  const initial = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!initial) return { ok: false, error: '项目不存在' };
  const progressError = projectProgressReviewError(initial);
  if (progressError) return { ok: false, error: progressError };
  if (projectOrientationReady(initial)) {
    return { ok: true, orientation: initial.orientation };
  }
  if (!initial.progressSnapshot) {
    return { ok: false, error: '项目还没有可信目录快照；请先执行 project progress-sync' };
  }
  const captured = await captureProjectProgressSnapshot(initial);
  if (!captured.snapshot) return { ok: false, error: captured.error || '无法复核项目目录现状' };
  const latest = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
  if (!latest.progressSnapshot || captured.snapshot.fingerprint !== latest.progressSnapshot.fingerprint) {
    await scanProjectProgressForReview(sessionId, '项目认知基线确认期间工作区再次变化');
    return { ok: false, error: '认知基线确认期间工作区再次变化，已刷新进度摘要；请按最新状态重新确认' };
  }
  const expected = latest.orientation?.status === 'required' ? latest.orientation : undefined;
  if (!expected) {
    const orientation = requiredProjectOrientation(latest, '项目认知基线状态缺失，需要刷新后重新确认');
    replaceProjectManagerSession({ ...latest, orientation, updatedAt: Date.now() });
    saveProjectManagerSnapshot(sessionId);
    return { ok: false, error: '项目认知基线版本已刷新；请重新读取 project status 后提交' };
  }
  if (Number(value?.requirementsVersion) !== expected.requirementsVersion
    || Number(value?.authorizationVersion) !== expected.authorizationVersion
    || String(value?.snapshotFingerprint || '') !== expected.snapshotFingerprint
    || Number(value?.requestedAt) !== expected.requestedAt) {
    return {
      ok: false,
      error: '项目目标、授权、目录快照或认知请求版本已变化；请重新读取 project status，不能提交旧认知结果',
    };
  }
  if (projectRequirementsAlignmentPending(latest)) {
    return { ok: false, error: '首次需求充分性检测尚未完成；请先提交 alignment-confirm，再确认项目认知基线' };
  }
  const summary = String(value?.summary || '').trim().slice(0, 12_000);
  const normalizeFacts = (input: unknown, label: string): { values?: string[]; error?: string } => {
    if (!Array.isArray(input) || input.length > 100 || input.some((entry) => typeof entry !== 'string')) {
      return { error: `${label} 必须是最多 100 项的字符串数组` };
    }
    return { values: input.map((entry) => entry.trim().slice(0, 4000)).filter(Boolean) };
  };
  const knownFacts = normalizeFacts(value?.knownFacts, 'knownFacts');
  const unknowns = normalizeFacts(value?.unknowns, 'unknowns');
  if (!summary) return { ok: false, error: '项目认知基线必须提供 summary，说明当前目标、进度和下一步方向' };
  if (knownFacts.error || !knownFacts.values?.length) {
    return { ok: false, error: knownFacts.error || 'knownFacts 至少需要一项有证据支持的已知事实' };
  }
  if (unknowns.error) return { ok: false, error: unknowns.error };
  if (!Array.isArray(value?.workItems)) {
    return { ok: false, error: 'workItems 必须逐项覆盖当前所有未停止工作项；没有工作项时传空数组' };
  }
  const requiredItems = latest.workItems.filter((item) => item.status !== 'stopped');
  const reviews: ProjectOrientationWorkItemReview[] = [];
  const seen = new Set<string>();
  for (const raw of value.workItems as any[]) {
    const workItemId = String(raw?.workItemId || '').trim().slice(0, 200);
    const disposition = String(raw?.disposition || '') as ProjectOrientationDisposition;
    const basis = String(raw?.basis || '').trim().slice(0, 4000);
    const nextAction = String(raw?.nextAction || '').trim().slice(0, 4000);
    if (!workItemId || seen.has(workItemId)) {
      return { ok: false, error: `工作项认知记录缺少 ID 或重复：${workItemId || '空 ID'}` };
    }
    if (!PROJECT_ORIENTATION_DISPOSITIONS.includes(disposition)) {
      return { ok: false, error: `工作项 ${workItemId} 的 disposition 无效` };
    }
    if (!basis || !nextAction) return { ok: false, error: `工作项 ${workItemId} 必须同时提供 basis 和 nextAction` };
    seen.add(workItemId);
    reviews.push({ workItemId, disposition, basis, nextAction });
  }
  const expectedIds = new Set(requiredItems.map((item) => item.id));
  const unknownReview = reviews.find((review) => !expectedIds.has(review.workItemId));
  const missingItem = requiredItems.find((item) => !seen.has(item.id));
  if (unknownReview || missingItem || reviews.length !== requiredItems.length) {
    return {
      ok: false,
      error: unknownReview
        ? `认知记录包含不存在或已停止的工作项：${unknownReview.workItemId}`
        : `认知记录未覆盖工作项：${missingItem?.id || '数量不一致'}`,
    };
  }
  const activeGoal = activeProjectGoal(latest);
  for (const review of reviews) {
    const item = requiredItems.find((candidate) => candidate.id === review.workItemId)!;
    if (item.status === 'completed' && review.disposition !== 'retain-completed') {
      return { ok: false, error: `已完成工作项 ${item.id} 只能选择 retain-completed，保留为证据` };
    }
    if (item.status !== 'completed' && review.disposition === 'retain-completed') {
      return { ok: false, error: `未完成工作项 ${item.id} 不能选择 retain-completed` };
    }
    if (['continue', 'verify'].includes(review.disposition) && (
      item.goalId !== activeGoal.id
      || item.requirementsVersion !== projectRequirementsVersion(latest)
      || item.authorizationVersion !== projectAuthorizationVersion(latest)
    )) {
      return { ok: false, error: `工作项 ${item.id} 属于旧目标、旧需求或旧授权版本，只能 pause 或 stop，不能继续执行` };
    }
  }
  const now = Date.now();
  const reviewById = new Map(reviews.map((review) => [review.workItemId, review]));
  const workItems = latest.workItems.map((item) => {
    const review = reviewById.get(item.id);
    if (!review || review.disposition === 'retain-completed') return item;
    if (review.disposition === 'stop') {
      return {
        ...item,
        status: 'stopped' as const,
        workerSurfaceId: undefined,
        supervisorLaneId: undefined,
        latestBlocker: undefined,
        updatedAt: now,
      };
    }
    if (review.disposition === 'pause') {
      return { ...item, status: 'paused' as const, latestBlocker: review.basis, updatedAt: now };
    }
    return {
      ...item,
      status: ['waiting-decision', 'paused', 'failed', 'running', 'validating'].includes(item.status)
        ? 'planned' as const
        : item.status,
      baseline: review.disposition === 'verify'
        ? requiredProjectTaskBaseline(item.requirementsVersion || projectRequirementsVersion(latest))
        : item.baseline,
      latestBlocker: undefined,
      updatedAt: now,
    };
  });
  const orientation: NonNullable<ProjectManagerSession['orientation']> = {
    status: 'ready',
    requirementsVersion: projectRequirementsVersion(latest),
    authorizationVersion: projectAuthorizationVersion(latest),
    snapshotFingerprint: captured.snapshot.fingerprint,
    reason: latest.orientation?.reason || '项目 AI 主动建立项目认知基线',
    requestedAt: latest.orientation?.requestedAt || now,
    summary,
    knownFacts: knownFacts.values,
    unknowns: unknowns.values || [],
    workItems: reviews,
    acknowledgedAt: now,
  };
  replaceProjectManagerSession({ ...latest, progressSnapshot: captured.snapshot, orientation, workItems, updatedAt: now });
  useStore.getState().appendProjectManagerEvent({
    kind: 'project-orientation-confirmed',
    summary: `项目 AI 已建立当前认知基线：${summary}`,
    payload: {
      requirementsVersion: orientation.requirementsVersion,
      authorizationVersion: orientation.authorizationVersion,
      snapshotFingerprint: orientation.snapshotFingerprint,
      reviewedWorkItems: reviews.length,
    },
  }, sessionId);
  saveProjectManagerSnapshot(sessionId);
  return { ok: true, orientation };
}

function restoredProjectManagerSession(session: ProjectManagerSession, managerSurfaceId?: string): ProjectManagerSession {
  const now = Date.now();
  const normalized = normalizeProjectManagerSession(session);
  const previousProtocolVersion = normalized.executionProtocolVersion || 0;
  const outdatedWorkItemCount = normalized.workItems.filter((item) => (
    !['completed', 'stopped'].includes(item.status)
    && (item.executionProtocolVersion || 0) < CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION
  )).length;
  const sessionProtocolOutdated = previousProtocolVersion < CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION;
  const protocolMigrationRequired = sessionProtocolOutdated || outdatedWorkItemCount > 0;
  const protocolMigrationEvent = protocolMigrationRequired ? {
    id: uuid(),
    sessionId: normalized.id,
    ts: now,
    kind: 'execution-protocol-migrated' as const,
    summary: sessionProtocolOutdated
      ? `项目执行协议已从 v${previousProtocolVersion} 迁移到 v${CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION}；未完成工作项必须按最新阶段合同重新审核`
      : `检测到 ${outdatedWorkItemCount} 个未完成工作项尚未迁移到执行协议 v${CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION}；旧运行状态已失效`,
    payload: {
      fromVersion: previousProtocolVersion,
      toVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
      outdatedWorkItems: outdatedWorkItemCount,
    },
  } : undefined;
  const restored: ProjectManagerSession = {
    ...normalized,
    preconditions: projectStringArray(normalized.preconditions),
    planFiles: Array.isArray(normalized.planFiles) ? normalized.planFiles : [],
    requirementsVersion: projectRequirementsVersion(normalized),
    authorizationVersion: projectAuthorizationVersion(normalized),
    acceptedRequirementsVersion: projectAcceptedRequirementsVersion(normalized),
    executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
    managerSurfaceId,
    taskTerminalSurfaceId: undefined,
    recoveryState: 'checking' as const,
    ...(protocolMigrationRequired ? {
      pendingManagerDeliveries: [],
      pendingSupervisorTransitions: [],
      events: protocolMigrationEvent
        ? [...normalized.events, protocolMigrationEvent].slice(-500)
        : normalized.events,
    } : {}),
    updatedAt: now,
    workItems: normalized.workItems.map((item: ProjectWorkItem) => {
      const interrupted = ['running', 'validating'].includes(item.status);
      const hadRuntimeBinding = !!item.workerSurfaceId || !!item.supervisorLaneId;
      const needsRecovery = hadRuntimeBinding && !['completed', 'stopped'].includes(item.status);
      const unfinished = !['completed', 'stopped'].includes(item.status);
      const itemProtocolOutdated = unfinished
        && (item.executionProtocolVersion || 0) < CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION;
      return {
        ...item,
        workerSurfaceId: undefined,
        supervisorLaneId: undefined,
        startedAt: undefined,
        executionProtocolVersion: item.executionProtocolVersion || 0,
        supervisorPlanRequired: unfinished ? true : item.supervisorPlanRequired,
        supervisorPlan: itemProtocolOutdated ? undefined : item.supervisorPlan,
        status: interrupted ? 'waiting-decision' : item.status,
        baseline: !['completed', 'stopped'].includes(item.status)
          ? requiredProjectTaskBaseline(item.requirementsVersion || projectRequirementsVersion(normalized))
          : item.baseline,
        latestBlocker: needsRecovery
          ? [
              '应用重启后原 AI 监督和任务终端对话已失效；项目管理 AI 必须基于恢复包建立新链路',
              itemProtocolOutdated
                ? `工作项仍是执行协议 v${item.executionProtocolVersion || 0}；必须用 task-update 提交符合 v${CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION} 的完整阶段合同后才能重新监督`
                : '',
              item.latestBlocker ? `重启前阻塞：${item.latestBlocker}` : '',
            ].filter(Boolean).join('；')
          : itemProtocolOutdated
            ? `工作项仍是执行协议 v${item.executionProtocolVersion || 0}；必须按最新阶段合同重新审核后才能执行`
            : item.latestBlocker,
        updatedAt: needsRecovery || interrupted || itemProtocolOutdated ? now : item.updatedAt,
      };
    }),
  };
  return {
    ...restored,
    orientation: requiredProjectOrientation(
      restored,
      '软件重启恢复后，需要根据持久记录和当前目录重新建立项目认知基线',
      now,
    ),
  };
}

function markProjectRecoveryReady(sessionId: string, workItemId: string): void {
  const store = useStore.getState();
  const current = store.projectManagers.find((session) => session.id === sessionId);
  if (!current || current.recoveryState !== 'checking') return;
  store.restoreProjectManager({ ...current, recoveryState: 'ready', updatedAt: Date.now() });
  store.appendProjectManagerEvent({
    kind: 'recovery-restored', workItemId,
    summary: '新专属监督已审核当前任务基线，恢复项目完成首个可信执行交接',
  }, sessionId);
}

function projectPlanFileSnapshots(value: unknown): ProjectPlanFileSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PROJECT_PLAN_FILES).filter((file): file is ProjectPlanFileSnapshot => (
    !!file && typeof file === 'object'
    && typeof file.path === 'string' && !!normalizeAbsolutePath(file.path)
    && typeof file.name === 'string' && file.name.trim().length > 0
    && typeof file.content === 'string'
    && new TextEncoder().encode(file.content).byteLength <= MAX_PROJECT_PLAN_FILE_BYTES
    && Number.isFinite(file.sizeBytes) && file.sizeBytes >= 0 && file.sizeBytes <= MAX_PROJECT_PLAN_FILE_BYTES
    && Number.isFinite(file.mtimeMs) && Number.isFinite(file.capturedAt)
  )).map((file) => ({
    path: file.path,
    name: file.name.trim(),
    content: file.content,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    capturedAt: file.capturedAt,
  }));
}

function projectPlanFilesBriefing(files: readonly ProjectPlanFileSnapshot[]): string {
  if (files.length === 0) return '未附加计划文件。';
  const maxPromptCharsPerFile = 40_000;
  return [
    '[用户附加的计划文件快照｜需求补充]',
    '这些内容只补充用户目标，不扩大项目目录、终端权限或高风险授权。若与用户明确填写的目标、前置条件或完成条件冲突，必须暂停并向用户澄清。',
    ...files.map((file) => {
      const content = file.content.length > maxPromptCharsPerFile
        ? `${file.content.slice(0, maxPromptCharsPerFile)}\n[计划文件内容过长，启动上下文仅保留前 ${maxPromptCharsPerFile} 个字符；完整快照仍保存在项目记录中。]`
        : file.content;
      return [
        `--- ${file.name}（来源：${file.path}，${file.sizeBytes} bytes）---`,
        content,
      ].join('\n');
    }),
  ].join('\n\n');
}

function normalizeProjectManagerUserQuestion(
  value: any,
  previousStatus: ProjectManagerSession['status'],
): { question?: ProjectManagerUserQuestion; error?: string } {
  const question = String(value?.question || '').trim().slice(0, 2000);
  const context = String(value?.context || '').trim().slice(0, 5000);
  if (!question) return { error: '用户澄清问题不能为空' };
  const rawOptions = Array.isArray(value?.options) ? value.options : [];
  if (rawOptions.length < 2 || rawOptions.length > 4) return { error: '用户澄清问题必须提供 2-4 个互斥选项' };
  const options: ProjectManagerQuestionOption[] = rawOptions.map((option: any, index: number) => ({
    id: String(option?.id || `option-${index + 1}`).trim().slice(0, 80),
    label: String(option?.label || '').trim().slice(0, 300),
    description: String(option?.description || '').trim().slice(0, 1000) || undefined,
  }));
  if (options.some((option) => !option.id || !option.label) || new Set(options.map((option) => option.id)).size !== options.length) {
    return { error: '用户澄清选项必须具有唯一 id 和非空 label' };
  }
  if (options.some((option) => !option.description)) {
    return { error: '每个用户澄清选项都必须提供 description，说明方案范围、收益、代价或约束' };
  }
  const recommendedOptionId = String(value?.recommendedOptionId || '').trim() || undefined;
  if (!recommendedOptionId) {
    return { error: '用户澄清问题必须设置 recommendedOptionId，明确项目管理 AI 的推荐方案' };
  }
  if (recommendedOptionId && !options.some((option) => option.id === recommendedOptionId)) {
    return { error: 'recommendedOptionId 必须指向现有选项' };
  }
  return {
    question: {
      id: `pm-question-${uuid()}`,
      category: value?.category === 'manual-intervention' ? 'manual-intervention' : 'clarification',
      workItemId: String(value?.workItemId || '').trim().slice(0, 120) || undefined,
      blocker: String(value?.blocker || '').trim().slice(0, 4000) || undefined,
      reasonCode: PROJECT_MANAGER_MANUAL_INTERVENTION_REASON_CODES.includes(value?.reasonCode)
        ? value.reasonCode
        : undefined,
      question,
      context,
      options,
      recommendedOptionId,
      previousStatus,
      createdAt: Date.now(),
    },
  };
}

type ProjectRequirementAlignmentState = 'sufficient' | 'needs-question' | 'needs-definition-update';

function projectRequirementsAlignmentPending(session: ProjectManagerSession): boolean {
  if (projectRequirementsAlignmentPhase(session) === 'needs-definition-update') return true;
  const latestRequiredIndex = session.events.reduce((latest, event, index) => (
    event.kind === 'requirements-alignment-required' ? index : latest
  ), -1);
  if (latestRequiredIndex < 0) return false;
  const latestConfirmedIndex = session.events.reduce((latest, event, index) => (
    event.kind === 'requirements-alignment-confirmed' ? index : latest
  ), -1);
  return latestRequiredIndex > latestConfirmedIndex;
}

function projectRequirementAlignmentState(session: ProjectManagerSession): ProjectRequirementAlignmentState {
  const latestDefinitionIndex = session.events.reduce((latest, event, index) => (
    event.kind === 'project-definition-updated' ? index : latest
  ), -1);
  const latestChangeMessageIndex = session.events.reduce((latest, event, index) => (
    event.kind === 'user-message' && typeof event.payload?.changeSignal === 'string' ? index : latest
  ), -1);
  if (latestChangeMessageIndex > latestDefinitionIndex) return 'needs-definition-update';
  const goal = session.goal.trim();
  const doneWhen = session.doneWhen.map((item) => item.trim()).filter(Boolean);
  const onlyCriterion = doneWhen.length === 1 ? doneWhen[0] : '';
  const genericGoal = goal.length <= 12 && /^(测试(相关)?功能|测试项目|完成项目|继续项目|开发项目|实现(相关)?功能|做(个|一个).+)$/u.test(goal);
  const hasVerifiableCriterion = doneWhen.some((criterion) => (
    /(测试|验证|验收|通过|可复现|可运行|可用|覆盖|成功|错误处理|文档|保存|生成|显示|返回)/u.test(criterion)
  ));
  const requestAsCriterion = /^(做|开发|实现|创建|搭建)(个|一个)?/u.test(onlyCriterion)
    && !hasVerifiableCriterion;
  const goalSpecific = !genericGoal && goal.length >= 8;
  const criteriaSpecific = hasVerifiableCriterion
    || (doneWhen.length >= 2 && doneWhen.every((criterion) => criterion.length >= 6));
  const planText = (session.planFiles || []).map((file) => file.content).join('\n');
  const planDefinesBoundaries = planText.length >= 120
    && /(目标|范围|需求|功能)/u.test(planText)
    && /(验收|完成条件|测试|验证)/u.test(planText);
  if ((goalSpecific && (doneWhen.length === 0 || (criteriaSpecific && !requestAsCriterion))) || planDefinesBoundaries) {
    return 'sufficient';
  }
  if (session.pendingUserQuestion) return 'needs-definition-update';
  const latestAnswer = [...session.events].reverse().find((event) => event.kind === 'user-clarification-answered');
  const latestDefinition = [...session.events].reverse().find((event) => event.kind === 'project-definition-updated');
  if (latestAnswer && (!latestDefinition || latestAnswer.ts > latestDefinition.ts)) {
    return 'needs-definition-update';
  }
  return 'needs-question';
}

function projectAlignmentQuestionInput(session: ProjectManagerSession): Record<string, unknown> {
  const combined = [session.goal, ...session.doneWhen].join(' ');
  const managementSystem = /(图书|library|管理系统|管理平台|后台系统)/iu.test(combined);
  const subjectCandidate = session.doneWhen.find((item) => /^(做|开发|实现|创建|搭建)(个|一个)?/u.test(item)) || session.goal;
  const subject = subjectCandidate.replace(/^(做|开发|实现|创建|搭建)(个|一个)?/u, '').trim() || session.goal;
  if (managementSystem) {
    return {
      category: 'clarification',
      question: `你希望先按哪种产品形态实现“${subject}”？`,
      context: `当前项目目标为“${session.goal}”，完成条件为“${session.doneWhen.join('；')}”。这些信息还不能确定界面形态、首版范围和验收方式。项目管理 AI 推荐先做本地网页版本，选定后还会继续确认核心功能边界。`,
      options: [
        {
          id: 'local-web',
          label: '本地网页系统',
          description: '推荐方案：浏览器使用，首版覆盖核心数据管理、查询和主要业务流程；部署与自动化验证较简单，但暂不包含复杂多人权限和公网发布。',
        },
        {
          id: 'desktop-app',
          label: '桌面单机应用',
          description: '提供独立桌面窗口和本地数据存储，适合固定电脑离线使用；交互完整，但打包和跨平台验证成本更高。',
        },
        {
          id: 'command-line',
          label: '命令行原型',
          description: '先验证数据模型与核心业务逻辑，开发和测试最快；不提供图形界面，后续改成网页或桌面端需要补做交互层。',
        },
      ],
      recommendedOptionId: 'local-web',
    };
  }
  return {
    category: 'clarification',
    question: `你希望以哪种交付深度推进“${subject}”？`,
    context: `当前项目目标为“${session.goal}”，完成条件为“${session.doneWhen.join('；')}”，尚不足以唯一确定功能范围与验收边界。项目管理 AI 先给出三种可执行方向，选择后可继续在项目对话中补充细节。`,
    options: [
      {
        id: 'minimal-prototype',
        label: '最小可验证原型',
        description: '推荐方案：先完成最关键的一条业务链和可重复测试，最快取得可验证结果；非核心功能留到后续迭代。',
      },
      {
        id: 'standard-solution',
        label: '标准完整版本',
        description: '一次覆盖常用功能、基础异常处理和使用说明；交付更完整，但需求确认、实现和验证时间更长。',
      },
      {
        id: 'plan-first',
        label: '先产出实施计划',
        description: '暂不修改业务代码，先输出架构、任务拆分、风险和验收方案供确认；返工风险最低，但不会立即得到可运行成品。',
      },
    ],
    recommendedOptionId: 'minimal-prototype',
  };
}

const deletingProjectManagerSessions = new Set<string>();
let projectManagerRecoveryChoice: 'pending' | 'restore' | 'skip' = 'pending';
let projectManagerRecoveryMutationInFlight = false;

function projectSessionForParams(params: any): ProjectManagerSession | null {
  const state = useStore.getState();
  const projectId = String(params?.projectId || '').trim();
  const correlationId = String(params?.correlationId || '').trim();
  const callerSurfaceId = String(params?.callerSurfaceId || '').trim();
  const callerSession = !projectId && callerSurfaceId
    ? state.projectManagers.find((candidate) => candidate.managerSurfaceId === callerSurfaceId) || null
    : null;
  const correlatedSession = !projectId && correlationId
    ? state.projectManagers.find((candidate) => candidate.events.some((event) => (
      event.kind === 'user-message' && event.correlationId === correlationId
    ))) || null
    : null;
  const session = projectId
    ? state.projectManagers.find((candidate) => candidate.id === projectId) || null
    : correlatedSession || callerSession || state.projectManager;
  return session && !deletingProjectManagerSessions.has(session.id) ? session : null;
}

function projectManagerSessionView(session: ProjectManagerSession): ProjectManagerSession & {
  managedSupervisors: Array<Record<string, unknown>>;
  attentionKind?: ProjectManagerEventKind;
  attentionReason?: string;
  pauseReason?: string;
  pauseAttentionRequired?: boolean;
} {
  const supervisor = useStore.getState().supervisor;
  const lanes = supervisor.lanes.filter((lane) => (
    lane.projectManagerProjectId === session.id && supervisorLaneControlState(lane) !== 'stopped'
  ));
  const latestPause = [...session.events].reverse().find((event) => event.kind === 'project-paused');
  const activeAttention = activeProjectManagerAttentionEvent(session.events);
  return {
    ...session,
    ...(activeAttention ? {
      attentionKind: activeAttention.kind,
      attentionReason: activeAttention.summary,
    } : {}),
    ...(session.status === 'paused' && latestPause ? {
      pauseReason: latestPause.summary,
      pauseAttentionRequired: latestPause.payload?.attentionRequired === true,
    } : {}),
    managedSupervisors: lanes.map((lane) => {
      const item = session.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
      const config = effectiveSupervisorLaneConfig(lane);
      const pendingDecisions = supervisor.pendingApprovals.filter((approval) => approval.laneId === lane.id);
      return {
        laneId: lane.id,
        label: lane.label,
        workItemId: lane.projectWorkItemId,
        supervisorSurfaceId: lane.supervisorSurfaceId,
        terminalSurfaceId: lane.surfaceId,
        workerSurfaceId: lane.surfaceId,
        terminalLabel: lane.label,
        status: supervisorLaneControlState(lane),
        terminal: remoteTerminalActivity(lane.surfaceId),
        taskWorkMode: normalizeTaskWorkMode(config.taskWorkMode),
        mainThreadResponsibility: config.mainThreadResponsibility || '',
        childThreadResponsibilities: config.childThreadResponsibilities || [],
        maxChildThreads: config.maxChildThreads,
        supervisorMayApproveThreads: config.supervisorMayApproveThreads,
        parallelizableOperations: config.parallelizableOperations || [],
        serializedOperations: config.serializedOperations || [],
        pendingDecisionCount: pendingDecisions.length,
        pendingDecisions: pendingDecisions.map((approval) => ({
          approvalId: approval.id,
          proposalKind: approval.proposalKind,
          recommendation: approval.text,
          reason: approval.reason,
          impact: approval.impact,
          alternatives: approval.alternatives,
          createdAt: approval.createdAt,
        })),
        decisions: lane.decisions?.slice(-20) || [],
        budget: item ? {
          decisions: { used: item.decisionsUsed, limit: item.contract.budget.maxDecisions },
          retries: { used: item.attempts, limit: item.contract.budget.maxTaskRetries },
          sameTests: { limit: item.contract.budget.maxSameTestRuns },
          fullSuites: { limit: item.contract.budget.maxFullSuiteRunsPerVersion },
        } : undefined,
      };
    }),
  };
}

interface PendingProjectManagerDelivery extends ProjectManagerPendingDelivery {
  sessionId?: string;
  attempts: number;
  alerted: boolean;
}

function notifyProjectManagerUserQuestion(
  session: ProjectManagerSession,
  question: ProjectManagerUserQuestion,
): void {
  const store = useStore.getState();
  const manager = projectManagerTerminal({ surfaceId: session.managerSurfaceId, projectId: session.id });
  const workspaceId = manager?.workspaceId || projectRuntimeWorkspaceId(session.id);
  const surfaceId = manager?.surfaceId || session.taskTerminalSurfaceId || session.managerSurfaceId || '';
  const title = question.category === 'manual-intervention'
    ? '项目需要你的处理'
    : '项目需要需求确认';
  const text = `${session.goal}：${question.question}`;
  if (workspaceId) {
    store.addNotification({ surfaceId: surfaceId as SurfaceId, workspaceId, title, text });
  }
  window.wmux?.notification?.fire({ surfaceId, title, text });
}

const pendingProjectManagerDeliveries: PendingProjectManagerDelivery[] = [];
let projectManagerDeliveryScheduled = false;
let projectManagerDeliveryTimerArming = false;
let projectManagerDeliveryGeneration = 0;
const projectManagerDeliverySurfacesInFlight = new Set<string>();
const PROJECT_MANAGER_DELIVERY_ALERT_ATTEMPTS = 15;
const PROJECT_MANAGER_IDLE_SETTLE_MS = 750;
const PROJECT_SUPERVISOR_TRANSITION_REDELIVERY_MS = 10 * 60_000;
const PROJECT_ALIGNMENT_FALLBACK_DELAY_MS = 45_000;
const PROJECT_TASK_ROTATION_REQUEST_TTL_MS = 5 * 60_000;
const PROJECT_TASK_CONTROL_ESC_GRACE_MS = 60_000;
const projectProgressTimers = new Map<string, ReturnType<typeof setTimeout>>();
const projectAlignmentTimers = new Map<string, ReturnType<typeof setTimeout>>();
const projectManagerRuntimeRecoveries = new Set<string>();
const managedAgentWatchdogs = new Map<string, ManagedAgentWatchdogRuntime>();
const managedAgentWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();
const managedAgentDurationHistory = new Map<string, number[]>();
const managedAgentOutputTails = new Map<string, string>();
const managedAgentRecoveries = new Set<string>();
let managedAgentWatchdogGeneration = 0;

function projectManagerTerminal(options: { surfaceId?: string; projectId?: string } = {}): RemoteTaskTerminalLocation | undefined {
  for (const workspace of useStore.getState().workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const surface = findLeaf(workspace.splitTree, paneId)?.surfaces.find((candidate) => (
        candidate.type === 'terminal'
        && candidate.projectManagerTerminal === true
        && (!options.surfaceId || candidate.id === options.surfaceId)
        && (!options.projectId || candidate.projectManagerProjectId === options.projectId)
      ));
      if (!surface) continue;
      return {
        surfaceId: surface.id,
        paneId,
        workspaceId: workspace.id,
        workspaceTitle: workspace.title,
        projectDir: surface.currentCwd || surface.cwd || workspace.cwd,
        cwd: surface.currentCwd || surface.cwd || workspace.cwd,
        label: remoteTerminalLabel(surface),
        remoteSshControl: false,
        surface,
      };
    }
  }
  return undefined;
}

interface ManagedProjectAgentTarget {
  surfaceId: string;
  role: ManagedProjectAgentRole;
  session: ProjectManagerSession;
  lane?: SupervisorLane;
  reasoningEffort: string;
  taskBudgetMinutes?: number;
}

function managedProjectAgentTarget(surfaceId: string): ManagedProjectAgentTarget | undefined {
  const store = useStore.getState();
  const manager = projectManagerTerminal({ surfaceId });
  if (manager?.surface.projectManagerTerminal && manager.surface.projectManagerProjectId) {
    const session = store.projectManagers.find((candidate) => (
      candidate.id === manager.surface.projectManagerProjectId
      && !['completed', 'stopped'].includes(candidate.status)
    ));
    if (session) {
      return {
        surfaceId,
        role: 'manager',
        session,
        reasoningEffort: manager.surface.projectManagerReasoningEffort || 'medium',
      };
    }
  }
  const lane = store.supervisor.lanes.find((candidate) => (
    candidate.projectManagerProjectId
    && supervisorLaneControlState(candidate) === 'active'
    && (candidate.supervisorSurfaceId === surfaceId || candidate.surfaceId === surfaceId)
  ));
  if (!lane?.projectManagerProjectId) return undefined;
  const session = store.projectManagers.find((candidate) => (
    candidate.id === lane.projectManagerProjectId
    && candidate.status === 'active'
  ));
  if (!session) return undefined;
  if (lane.supervisorSurfaceId === surfaceId) {
    return {
      surfaceId,
      role: 'supervisor',
      session,
      lane,
      reasoningEffort: projectSupervisorDefaults(store.workspacePrefs.projectManagementAgents).supervisorReasoningEffort
        || store.supervisor.supervisorReasoningEffort
        || 'medium',
    };
  }
  const taskTerminal = locateRemoteTaskTerminal(surfaceId).terminal;
  const item = session.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
  return {
    surfaceId,
    role: 'task',
    session,
    lane,
    reasoningEffort: taskTerminal?.surface.projectManagerReasoningEffort || 'medium',
    taskBudgetMinutes: item?.contract.budget.maxContinuousMinutes,
  };
}

function managedAgentHistoryKey(target: ManagedProjectAgentTarget): string {
  return `${target.role}:${target.reasoningEffort || 'medium'}`;
}

function managedAgentPolicy(target: ManagedProjectAgentTarget): ManagedAgentDeadlinePolicy {
  return managedAgentDeadlinePolicy({
    role: target.role,
    reasoningEffort: target.reasoningEffort,
    taskBudgetMinutes: target.taskBudgetMinutes,
    successfulDurationsMs: managedAgentDurationHistory.get(managedAgentHistoryKey(target)),
  });
}

function clearManagedAgentWatchdog(surfaceId: string): ManagedAgentWatchdogRuntime | undefined {
  const timer = managedAgentWatchdogTimers.get(surfaceId);
  if (timer) globalThis.clearTimeout(timer);
  managedAgentWatchdogTimers.delete(surfaceId);
  const runtime = managedAgentWatchdogs.get(surfaceId);
  managedAgentWatchdogs.delete(surfaceId);
  managedAgentOutputTails.delete(surfaceId);
  return runtime;
}

function rememberManagedAgentDuration(target: ManagedProjectAgentTarget, runtime: ManagedAgentWatchdogRuntime): void {
  const duration = Math.max(0, Date.now() - runtime.turnStartedAt);
  if (!duration || runtime.escapeSentAt || runtime.interruptSentAt) return;
  const key = managedAgentHistoryKey(target);
  managedAgentDurationHistory.set(key, [...(managedAgentDurationHistory.get(key) || []), duration].slice(-100));
}

function queueInterruptedAgentRecovery(
  target: ManagedProjectAgentTarget,
  runtime: ManagedAgentWatchdogRuntime,
): void {
  const recoveryId = `watchdog-${runtime.surfaceId}-${runtime.generation}`;
  const source = runtime.sourceTask ? `\n原回合摘要：${runtime.sourceTask}` : '';
  if (target.role === 'manager') {
    queueProjectManagerDelivery([
      `[项目 AI 中断恢复｜${recoveryId}]`,
      `项目：${target.session.id} · ${target.session.projectDir}`,
      '控制层因超过活性截止时间中断了上一回合；Agent 仍在当前会话中。',
      `${source}`,
      `先运行 wmux project status --project ${target.session.id}，核对持久状态、工作树和最近事件，再继续尚未完成的部分。`,
      '不要盲目重放可能产生副作用的命令；已生效的修改、提交、消息或外部动作必须先只读确认。',
    ].filter(Boolean).join('\n'), target.session.id, { priority: true });
    return;
  }
  if (!target.lane) return;
  const task = target.lane.currentTask || target.lane.projectWorkItemId || '当前项目任务';
  const text = target.role === 'supervisor'
    ? [
        `[专属监督中断恢复｜${recoveryId}]`,
        `项目：${target.session.id}；任务：${target.lane.projectWorkItemId || '未绑定'}`,
        '控制层因超过活性截止时间中断了你的上一回合；当前 Agent 会话仍可用。',
        source,
        '先只读核对任务终端、持久记录与工作树，再继续未完成的监督裁决。不得盲目重放可能产生副作用的动作。',
      ].filter(Boolean).join('\n')
    : [
        `[任务 AI 中断恢复｜${recoveryId}]`,
        `项目：${target.session.id}；任务：${target.lane.projectWorkItemId || '未绑定'}`,
        '控制层已中断长期无响应的任务 AI 回合；请由专属监督只读核对任务终端、工作树和最近证据。',
        source,
        '若任务 AI 已回到可接收指令的 Agent 界面，发送一条带当前上下文的恢复指令；若已落入普通 shell 或运行时退出，停止投递并等待控制层重建。不要盲目重放副作用动作。',
      ].filter(Boolean).join('\n');
  const delivery: SupervisorDelivery = {
    id: recoveryId,
    kind: target.role === 'task' ? 'task-interrupted' : 'agent-recovery',
    task,
    text,
    createdAt: Date.now(),
    turnId: target.lane.workerTurnId,
    stage: 'pending' as const,
  };
  const pending = enqueueSupervisorDelivery(target.lane.pendingSupervisorDeliveries, delivery);
  if (pending === target.lane.pendingSupervisorDeliveries) return;
  const store = useStore.getState();
  store.updateLane(target.lane.id, { pendingSupervisorDeliveries: pending });
  appendSupervisorRecord(store.supervisor, target.lane, 'supervisor.delivery.queued', {
    kind: delivery.kind,
    task,
    recoveryId,
  });
  signalSupervisorDeliveryReady();
}

async function forceRecoverManagedAgent(
  target: ManagedProjectAgentTarget,
  runtime: ManagedAgentWatchdogRuntime,
): Promise<void> {
  const recoveryKey = `${target.session.id}:${target.role}:${target.lane?.id || 'manager'}`;
  if (managedAgentRecoveries.has(recoveryKey)) return;
  managedAgentRecoveries.add(recoveryKey);
  try {
    const output = normalizeProjectActivityFingerprintText(
      managedAgentOutputTails.get(runtime.surfaceId) || runtime.outputFingerprint,
    ).slice(-1200);
    const roleLabel = target.role === 'manager'
      ? '项目 AI'
      : target.role === 'supervisor'
        ? '专属监督 AI'
        : '任务 AI';
    const detail = runtime.escapeSentAt || runtime.interruptSentAt
      ? `${roleLabel}在 Esc、Ctrl+C 后仍未恢复，控制层正在重建运行时`
      : `${roleLabel}运行时已退出或不可用，控制层正在重建运行时`;
    const store = useStore.getState();
    if (target.lane?.projectWorkItemId) {
      const item = target.session.workItems.find((candidate) => candidate.id === target.lane!.projectWorkItemId);
      const context = [
        item?.latestContextSummary || '',
        runtime.sourceTask ? `被中断回合：${runtime.sourceTask}` : '',
        output ? `中断前终端摘要：${output}` : '',
      ].filter(Boolean).join('\n').slice(-4000);
      store.applyProjectManagerAction({
        type: 'update-work-item',
        workItemId: target.lane.projectWorkItemId,
        patch: { latestContextSummary: context || item?.latestContextSummary, latestBlocker: detail },
      }, target.session.id);
    }
    store.appendProjectManagerEvent({
      kind: 'guard-triggered',
      workItemId: target.lane?.projectWorkItemId,
      summary: detail,
      payload: {
        action: `watchdog-rebuild-${target.role}`,
        surfaceId: runtime.surfaceId,
        generation: runtime.generation,
        laneId: target.lane?.id,
      },
    }, target.session.id);
    saveProjectManagerSnapshot(target.session.id);

    markTerminalRuntimeExited(runtime.surfaceId, detail);
    if (target.role === 'manager') {
      (window as any).__wmux_queueProjectManagerRuntimeRecovery?.({
        projectId: target.session.id,
        role: 'manager',
        detail,
      });
      return;
    }
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === target.session.id);
    if (!current || current.status !== 'active' || !target.lane?.projectWorkItemId) return;
    let result: Record<string, unknown>;
    if (target.role === 'task') {
      const recoveryLane = useStore.getState().supervisor.lanes.find((candidate) => (
        candidate.id === target.lane?.id
        && candidate.projectManagerProjectId === current.id
        && supervisorLaneControlState(candidate) === 'active'
      ));
      if (!recoveryLane) return;
      const currentItem = current.workItems.find((candidate) => candidate.id === recoveryLane.projectWorkItemId);
      const recoverySummary = [
        currentItem?.latestContextSummary || '',
        runtime.sourceTask ? `被中断回合：${runtime.sourceTask}` : '',
        output ? `中断前终端摘要：${output}` : '',
        '任务 AI 运行时已不可用；新任务 AI 必须先只读核对工作树和持久记录，再继续未完成部分。',
      ].filter(Boolean).join('\n').slice(-4000);
      useStore.getState().updateLane(recoveryLane.id, {
        projectTaskRotationPending: true,
        projectTaskRotationSummary: recoverySummary,
        projectTaskRotationRequestedAt: Date.now(),
      });
      const preparedLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === recoveryLane.id);
      result = preparedLane
        ? await rotateProjectTaskTerminalFromSupervisor(current, preparedLane)
        : { ok: false, error: '任务 AI 恢复前监督通道已不存在' };
    } else {
      result = await handleProjectManagerRequest({
        action: 'task-supervise',
        callerSurfaceId: current.managerSurfaceId,
        projectId: current.id,
        workItemId: target.lane.projectWorkItemId,
      });
    }
    if (result?.ok && target.role === 'task') {
      useStore.getState().applyProjectManagerAction({
        type: 'update-work-item',
        workItemId: target.lane.projectWorkItemId,
        patch: { status: 'running', latestBlocker: undefined },
      }, current.id);
      saveProjectManagerSnapshot(current.id);
    }
    if (!result?.ok) {
      queueProjectManagerDelivery([
        '[项目运行链自动重建失败]',
        `项目：${current.id}；任务：${target.lane.projectWorkItemId}`,
        `原因：${String(result?.error || '未知错误')}`,
        '控制层已保留中断前上下文；请读取 project status 后决定恢复或暂缓，不要向旧终端继续投递。',
      ].join('\n'), current.id, { priority: true });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn('[managed-agent-watchdog] runtime recovery failed', {
      projectId: target.session.id,
      role: target.role,
      surfaceId: runtime.surfaceId,
      reason,
    });
    queueProjectManagerDelivery([
      '[项目运行链自动重建异常]',
      `项目：${target.session.id}${target.lane?.projectWorkItemId ? `；任务：${target.lane.projectWorkItemId}` : ''}`,
      `角色：${target.role}；原因：${reason}`,
      '控制层已停止向旧终端投递；请读取 project status 后人工决定恢复或暂缓。',
    ].join('\n'), target.session.id, { priority: true });
  } finally {
    managedAgentRecoveries.delete(recoveryKey);
  }
}

function armManagedAgentWatchdog(surfaceId: string): void {
  const existing = managedAgentWatchdogTimers.get(surfaceId);
  if (existing) globalThis.clearTimeout(existing);
  managedAgentWatchdogTimers.delete(surfaceId);
  const runtime = managedAgentWatchdogs.get(surfaceId);
  if (!runtime || runtime.phase === 'paused' || !Number.isFinite(runtime.nextDeadlineAt)) return;
  const expectedAt = runtime.nextDeadlineAt;
  const generation = runtime.generation;
  const timer = globalThis.setTimeout(() => {
    managedAgentWatchdogTimers.delete(surfaceId);
    const current = managedAgentWatchdogs.get(surfaceId);
    const target = managedProjectAgentTarget(surfaceId);
    if (!current || current.generation !== generation || !target) {
      clearManagedAgentWatchdog(surfaceId);
      return;
    }
    const now = Date.now();
    const delayedByMs = Math.max(0, now - expectedAt);
    const adjusted = shiftManagedAgentDeadlineForSuspend(current, delayedByMs);
    if (adjusted !== current) {
      managedAgentWatchdogs.set(surfaceId, adjusted);
      armManagedAgentWatchdog(surfaceId);
      return;
    }
    const activity = remoteTerminalActivity(surfaceId as SurfaceId, true).activityState;
    if (activity === 'blocked') {
      managedAgentWatchdogs.set(surfaceId, pauseManagedAgentWatchdog(current, now));
      return;
    }
    if (activity === 'idle') {
      clearManagedAgentWatchdog(surfaceId);
      if (current.escapeSentAt || current.interruptSentAt) queueInterruptedAgentRecovery(target, current);
      else rememberManagedAgentDuration(target, current);
      return;
    }
    const decision = evaluateManagedAgentDeadline({ runtime: current, now, policy: managedAgentPolicy(target) });
    managedAgentWatchdogs.set(surfaceId, decision.runtime);
    if (decision.action === 'escape' || decision.action === 'interrupt') {
      void writeProjectSupervisorControl(surfaceId as SurfaceId, decision.action === 'escape' ? '\x1b' : '\x03')
        .then((accepted) => {
          const fresh = managedAgentWatchdogs.get(surfaceId);
          if (!accepted && fresh?.generation === generation) {
            clearManagedAgentWatchdog(surfaceId);
            void forceRecoverManagedAgent(target, fresh);
          }
        });
    } else if (decision.action === 'recover') {
      clearManagedAgentWatchdog(surfaceId);
      void forceRecoverManagedAgent(target, decision.runtime);
      return;
    }
    armManagedAgentWatchdog(surfaceId);
  }, Math.max(0, expectedAt - Date.now()));
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  managedAgentWatchdogTimers.set(surfaceId, timer);
}

function handleManagedAgentHookEvent(event: any): void {
  const surfaceId = String(event?.surfaceId || '').trim();
  const lifecycle = String(event?.event || '').trim();
  const target = surfaceId ? managedProjectAgentTarget(surfaceId) : undefined;
  if (!target) return;
  const now = Date.now();
  if (lifecycle === 'UserPromptSubmit') {
    const runtime = beginManagedAgentTurn({
      surfaceId,
      role: target.role,
      generation: ++managedAgentWatchdogGeneration,
      now,
      policy: managedAgentPolicy(target),
      sourceTask: String(event?.task || ''),
    });
    clearManagedAgentWatchdog(surfaceId);
    managedAgentWatchdogs.set(surfaceId, runtime);
    armManagedAgentWatchdog(surfaceId);
    return;
  }
  const runtime = managedAgentWatchdogs.get(surfaceId);
  if (!runtime) return;
  if (lifecycle === 'Notification' || lifecycle === 'PermissionRequest') {
    managedAgentWatchdogs.set(surfaceId, pauseManagedAgentWatchdog(runtime, now));
    armManagedAgentWatchdog(surfaceId);
    return;
  }
  if (lifecycle === 'PermissionResult') {
    managedAgentWatchdogs.set(surfaceId, resumeManagedAgentWatchdog(runtime, now));
    armManagedAgentWatchdog(surfaceId);
    return;
  }
  if (lifecycle === 'PreToolUse') {
    const command = String(event?.command || '').trim();
    const next = command
      ? noteManagedAgentCommand(runtime, now, command)
      : noteManagedAgentSemanticProgress(runtime, now, managedAgentPolicy(target));
    managedAgentWatchdogs.set(surfaceId, next);
    armManagedAgentWatchdog(surfaceId);
    return;
  }
  if (lifecycle === 'PostToolUse' || lifecycle === 'SubagentStop') {
    managedAgentWatchdogs.set(
      surfaceId,
      noteManagedAgentSemanticProgress(runtime, now, managedAgentPolicy(target)),
    );
    armManagedAgentWatchdog(surfaceId);
    return;
  }
  if (lifecycle === 'Stop' || lifecycle === 'StopFailure' || lifecycle === 'Interrupt') {
    clearManagedAgentWatchdog(surfaceId);
    if (runtime.escapeSentAt || runtime.interruptSentAt) queueInterruptedAgentRecovery(target, runtime);
    else rememberManagedAgentDuration(target, runtime);
  }
}

function handleManagedAgentOutput(surfaceId: string, data: string): void {
  const runtime = managedAgentWatchdogs.get(surfaceId);
  if (!runtime || runtime.phase === 'paused' || !managedProjectAgentTarget(surfaceId)) return;
  const tail = `${managedAgentOutputTails.get(surfaceId) || ''}${data}`.slice(-6000);
  managedAgentOutputTails.set(surfaceId, tail);
  const fingerprint = normalizeProjectActivityFingerprintText(tail).slice(-2000);
  const now = Date.now();
  let next = noteManagedAgentOutput(runtime, now, fingerprint);
  if (
    (runtime.phase === 'escape-sent' || runtime.phase === 'interrupt-sent')
    && fingerprint
    && fingerprint !== runtime.outputFingerprint
  ) {
    const target = managedProjectAgentTarget(surfaceId);
    if (target && looksLikeManagedShellPrompt(tail)) {
      clearManagedAgentWatchdog(surfaceId);
      void forceRecoverManagedAgent(target, next);
      return;
    }
    if (target) {
      next = {
        ...noteManagedAgentSemanticProgress(next, now, managedAgentPolicy(target)),
        escapeSentAt: runtime.escapeSentAt,
        interruptSentAt: runtime.interruptSentAt,
      };
    }
  }
  managedAgentWatchdogs.set(surfaceId, next);
  if (next.nextDeadlineAt !== runtime.nextDeadlineAt || next.phase !== runtime.phase) {
    armManagedAgentWatchdog(surfaceId);
  }
}

function projectRuntimeWorkspaceId(projectId: string): WorkspaceId | undefined {
  return useStore.getState().workspaces.find((workspace) => (
    getAllPaneIds(workspace.splitTree).some((paneId) => (
      findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
        surface.projectManagerProjectId === projectId
        || surface.projectSupervisorProjectId === projectId
      ))
    ))
  ))?.id;
}

function teardownManagedProject(session: ProjectManagerSession): void {
  const store = useStore.getState();
  for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
    if (pendingProjectManagerDeliveries[index].sessionId === session.id) {
      pendingProjectManagerDeliveries.splice(index, 1);
    }
  }
  const lanes = store.supervisor.lanes.filter((lane) => lane.projectManagerProjectId === session.id);
  const workerSurfaceIds = new Set<string>([
    ...session.workItems.map((item) => item.workerSurfaceId || ''),
    ...lanes.map((lane) => lane.surfaceId),
  ].filter(Boolean));

  for (const lane of lanes) store.stopSupervisorLane(lane.id, '项目已删除并解除监督绑定');
  closeStoppedSupervisorSurfaces(lanes);
  const manager = projectManagerTerminal({ surfaceId: session.managerSurfaceId, projectId: session.id });
  if (manager) store.closeSurface(manager.workspaceId, manager.paneId, manager.surfaceId);
  for (const workspace of [...useStore.getState().workspaces]) {
    const ownsProjectSupervisor = getAllPaneIds(workspace.splitTree).some((paneId) => (
      findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
        surface.projectSupervisorProjectId === session.id
      ))
    ));
    if (ownsProjectSupervisor) store.closeWorkspace(workspace.id);
  }
  for (const surfaceId of workerSurfaceIds) {
    const terminal = remoteTerminalList().find((candidate) => candidate.surfaceId === surfaceId);
    if (terminal) store.closeSurface(terminal.workspaceId, terminal.paneId, terminal.surfaceId);
  }

  const timer = projectProgressTimers.get(session.id);
  if (timer) globalThis.clearTimeout(timer);
  projectProgressTimers.delete(session.id);
  for (const surfaceId of [
    session.managerSurfaceId,
    ...lanes.flatMap((lane) => [lane.supervisorSurfaceId, lane.surfaceId]),
  ].filter(Boolean) as string[]) {
    clearManagedAgentWatchdog(surfaceId);
  }
  const alignmentTimer = projectAlignmentTimers.get(session.id);
  if (alignmentTimer) globalThis.clearTimeout(alignmentTimer);
  projectAlignmentTimers.delete(session.id);
}

function flushProjectManagerDeliveries(): void {
  if (projectManagerDeliveryScheduled || pendingProjectManagerDeliveries.length === 0) return;
  for (let index = 0; index < pendingProjectManagerDeliveries.length; index += 1) {
    const delivery = pendingProjectManagerDeliveries[index];
    const session = delivery.sessionId
      ? useStore.getState().projectManagers.find((candidate) => candidate.id === delivery.sessionId)
      : undefined;
    const manager = session
      ? projectManagerTerminal({ surfaceId: session.managerSurfaceId, projectId: session.id })
      : undefined;
    const managerRuntime = manager ? terminalRuntimeStatus(manager.surfaceId) : undefined;
    const managerActivity = manager ? remoteTerminalActivity(manager.surfaceId) : undefined;
    if (!manager) {
      delivery.attempts += 1;
    } else if (managerRuntime?.state === 'failed' || managerRuntime?.state === 'exited') {
      delivery.attempts += 1;
    } else if (projectManagerDeliverySurfacesInFlight.has(manager.surfaceId)) {
      continue;
    } else if (managerActivity?.activityState === 'working') {
      // A busy Project AI must not block deliveries owned by another project.
      continue;
    } else {
      if (
        managerActivity?.activityState === 'idle'
        && managerActivity.activityUpdatedAt
        && Date.now() - managerActivity.activityUpdatedAt < PROJECT_MANAGER_IDLE_SETTLE_MS
      ) {
        // Stop means "turn ended", not "the nested Agent is healthy". Give the
        // terminal output a brief chance to report a Codex exit before writing.
        continue;
      }
      try {
        const deliveryGeneration = projectManagerDeliveryGeneration;
        const pending = sendTaskToSurfaceReliably(manager.surfaceId, delivery.text, true);
        projectManagerDeliverySurfacesInFlight.add(manager.surfaceId);
        void Promise.resolve(pending).then(() => {
          if (deliveryGeneration !== projectManagerDeliveryGeneration) return;
          const deliveredIndex = pendingProjectManagerDeliveries.findIndex((candidate) => candidate.id === delivery.id);
          if (deliveredIndex >= 0) pendingProjectManagerDeliveries.splice(deliveredIndex, 1);
          if (delivery.alerted) {
            useStore.getState().appendProjectManagerEvent({
              kind: 'manager-delivery-restored',
              summary: '项目管理 AI 消息投递已恢复，积压消息已成功送达',
              payload: { deliveryId: delivery.id, attempts: delivery.attempts },
            }, session!.id);
          }
          removePersistedProjectManagerDelivery(session!.id, delivery.id);
        }).catch(() => {
          if (deliveryGeneration !== projectManagerDeliveryGeneration) return;
          delivery.attempts += 1;
          if (delivery.attempts >= PROJECT_MANAGER_DELIVERY_ALERT_ATTEMPTS && !delivery.alerted) {
            delivery.alerted = true;
            notifyProjectManagerDeliveryUnavailable(delivery);
          }
        }).finally(() => {
          if (deliveryGeneration !== projectManagerDeliveryGeneration) return;
          projectManagerDeliverySurfacesInFlight.delete(manager.surfaceId);
          scheduleProjectManagerDeliveryFlush();
        });
        // Keep scanning other projects while this surface waits for its PTY
        // acknowledgement; only deliveries for the same surface are locked.
        scheduleProjectManagerDeliveryFlush();
        return;
      } catch {
        delivery.attempts += 1;
      }
    }
    if (delivery.attempts >= PROJECT_MANAGER_DELIVERY_ALERT_ATTEMPTS && !delivery.alerted) {
      delivery.alerted = true;
      notifyProjectManagerDeliveryUnavailable(delivery);
    }
  }
  scheduleProjectManagerDeliveryFlush();
}

function scheduleProjectManagerDeliveryFlush(): void {
  if (projectManagerDeliveryScheduled || pendingProjectManagerDeliveries.length === 0) return;
  projectManagerDeliveryScheduled = true;
  let firedSynchronously = false;
  projectManagerDeliveryTimerArming = true;
  window.setTimeout(() => {
    if (projectManagerDeliveryTimerArming) {
      firedSynchronously = true;
      return;
    }
    projectManagerDeliveryScheduled = false;
    flushProjectManagerDeliveries();
  }, pendingProjectManagerDeliveries.every((delivery) => delivery.alerted) ? 10_000 : 2_000);
  projectManagerDeliveryTimerArming = false;
  // Some hosts/tests provide a synchronous timer shim. Do not recurse on the
  // same stack; a later delivery/activity event can safely trigger another try.
  if (firedSynchronously) projectManagerDeliveryScheduled = false;
}

function updatePersistedProjectManagerDeliveries(
  sessionId: string,
  update: (deliveries: ProjectManagerPendingDelivery[]) => ProjectManagerPendingDelivery[],
): void {
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session) return;
  const next = { ...session, pendingManagerDeliveries: update(session.pendingManagerDeliveries || []) };
  store.restoreProjectManagers(
    store.projectManagers.map((candidate) => candidate.id === sessionId ? next : candidate),
    store.selectedProjectManagerId || undefined,
  );
  saveProjectManagerSnapshot(sessionId);
}

function removePersistedProjectManagerDelivery(sessionId: string, deliveryId: string): void {
  updatePersistedProjectManagerDeliveries(
    sessionId,
    (deliveries) => deliveries.filter((delivery) => delivery.id !== deliveryId),
  );
}

function notifyProjectManagerDeliveryUnavailable(delivery: PendingProjectManagerDelivery): void {
  const store = useStore.getState();
  const session = delivery.sessionId
    ? store.projectManagers.find((candidate) => candidate.id === delivery.sessionId)
    : undefined;
  const manager = session
    ? projectManagerTerminal({ surfaceId: session.managerSurfaceId, projectId: session.id })
    : undefined;
  const workspaceId = manager?.workspaceId || (session ? projectRuntimeWorkspaceId(session.id) : undefined);
  const surfaceId = manager?.surfaceId || session?.taskTerminalSurfaceId || session?.managerSurfaceId || '';
  const text = session
    ? `项目“${session.goal}”有消息等待交给项目管理 AI，但运行时当前不可用；消息会继续自动重试。`
    : '有消息等待交给项目管理 AI，但运行时当前不可用；消息会继续自动重试。';
  if (workspaceId) store.addNotification({ surfaceId: surfaceId as SurfaceId, workspaceId, text, title: '项目管理 AI 暂不可用' });
  window.wmux?.notification?.fire({ surfaceId, title: '项目管理 AI 暂不可用', text });
  if (session) {
    const event = store.appendProjectManagerEvent({
      kind: 'manager-delivery-failed',
      summary: text,
      payload: { deliveryId: delivery.id, attempts: delivery.attempts },
    }, session.id);
    saveProjectManagerSnapshot(session.id);
    if (event) {
      void (window as any).wmux?.projectManager?.appendRecord?.({
        sessionId: session.id,
        projectDir: session.projectDir,
        type: event.kind,
        payload: { message: event.summary, deliveryId: delivery.id, attempts: delivery.attempts },
      });
    }
  }
}

function hydrateProjectManagerDeliveries(sessions: readonly ProjectManagerSession[]): void {
  const queued = new Set(pendingProjectManagerDeliveries.map((delivery) => delivery.id));
  for (const session of sessions) {
    for (const delivery of session.pendingManagerDeliveries || []) {
      if (queued.has(delivery.id)) continue;
      queued.add(delivery.id);
      pendingProjectManagerDeliveries.push({
        ...delivery,
        text: withProjectManagerEventEnvelope(delivery.text, session.id),
        sessionId: session.id,
        attempts: 0,
        alerted: false,
      });
    }
  }
  flushProjectManagerDeliveries();
}

function queueProjectManagerDelivery(
  text: string,
  sessionId: string,
  options: { priority?: boolean; transitionId?: string } = {},
): void {
  const delivery: PendingProjectManagerDelivery = {
    id: `pm-delivery-${uuid()}`,
    text: withProjectManagerEventEnvelope(text, sessionId),
    createdAt: Date.now(),
    ...(options.transitionId ? { transitionId: options.transitionId } : {}),
    sessionId,
    attempts: 0,
    alerted: false,
  };
  if (options.priority) pendingProjectManagerDeliveries.unshift(delivery);
  else pendingProjectManagerDeliveries.push(delivery);
  if (sessionId) {
    updatePersistedProjectManagerDeliveries(sessionId, (deliveries) => {
      const persisted = {
        id: delivery.id,
        text: delivery.text,
        createdAt: delivery.createdAt,
        ...(delivery.transitionId ? { transitionId: delivery.transitionId } : {}),
      };
      const existing = deliveries.filter((candidate) => candidate.id !== delivery.id);
      return options.priority
        ? [persisted, ...existing.slice(-99)]
        : [...existing, persisted].slice(-100);
    });
  }
  flushProjectManagerDeliveries();
}

function projectSupervisorTransitionText(
  session: ProjectManagerSession,
  transition: ProjectSupervisorTransition,
  instruction = '',
): string {
  return [
    '[项目专属监督状态交接｜事件驱动｜必须处理并回执]',
    `项目：${session.id} · ${session.projectDir}`,
    `交接 ID：${transition.id}`,
    `任务：${transition.workItemId || '未绑定'}`,
    `监督状态：${transition.kind}`,
    `摘要：${transition.summary}`,
    transition.evidence ? `证据：${transition.evidence}` : '',
    transition.contextSummary ? `上下文：${transition.contextSummary}` : '',
    '',
    instruction || '请依据结构化项目状态决定继续、验收、重规划、暂停或恢复；不要绕过专属监督直接指挥任务 AI。',
    `完成相应的 task-update、decide、supervise 或项目状态更新后，执行 wmux project transition-ack --project ${session.id} --transition ${transition.id} --resolution <continued|accepted|replanned|paused|escalated|recovered> --summary "<处理结果和新方向>"。该回执是项目 AI 的内部状态同步，不需要用户确认。`,
    '未回执前该交接会保留在项目状态中；看门狗只会补投本事件，不再重复询问监督进度。',
  ].filter(Boolean).join('\n');
}

function projectTransitionPriority(kind: ProjectSupervisorTransitionKind): number {
  if (kind === 'supervisor-unavailable') return 0;
  if (kind === 'decision-required') return 1;
  if (kind === 'stage-complete') return 2;
  if (kind === 'project-action-required') return 3;
  if (kind === 'direction-needed') return 4;
  return 5;
}

function queueProjectSupervisorTransition(options: {
  sessionId: string;
  laneId: string;
  workItemId?: string;
  kind: ProjectSupervisorTransitionKind;
  eventType: string;
  summary: string;
  evidence?: string;
  contextSummary?: string;
  instruction?: string;
}): ProjectSupervisorTransition | undefined {
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === options.sessionId);
  if (!session || ['completed', 'stopped'].includes(session.status)) return undefined;
  const originalPending = session.pendingSupervisorTransitions || [];
  const sameScope = (transition: ProjectSupervisorTransition) => (
    transition.laneId === options.laneId && transition.workItemId === options.workItemId
  );
  // An idle-without-handoff event is only a recovery hint. If a real state
  // handoff for the same supervisor arrived concurrently, that newer fact is
  // authoritative and the stale idle hint must never trigger a later rebuild.
  const scopedPending = originalPending.filter(sameScope);
  if (options.kind === 'supervisor-idle' && scopedPending.length > 0) {
    return scopedPending.at(-1);
  }
  const supersededIds = new Set(originalPending
    .filter((transition) => sameScope(transition) && transition.kind === 'supervisor-idle')
    .map((transition) => transition.id));
  if (supersededIds.size > 0) {
    for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
      const delivery = pendingProjectManagerDeliveries[index];
      if (delivery.sessionId === session.id && delivery.transitionId
        && supersededIds.has(delivery.transitionId)) {
        pendingProjectManagerDeliveries.splice(index, 1);
      }
    }
  }
  const pending = originalPending.filter((transition) => !supersededIds.has(transition.id));
  const currentSession = supersededIds.size > 0
    ? {
        ...session,
        pendingSupervisorTransitions: pending,
        pendingManagerDeliveries: (session.pendingManagerDeliveries || [])
          .filter((delivery) => !delivery.transitionId || !supersededIds.has(delivery.transitionId)),
      }
    : session;
  const existing = pending.find((transition) => (
    transition.laneId === options.laneId
    && transition.workItemId === options.workItemId
    && transition.kind === options.kind
  ));
  if (existing) {
    const nextSummary = options.summary.trim().slice(0, 4000) || existing.summary;
    const nextEvidence = options.evidence?.trim().slice(0, 12_000);
    const nextContextSummary = options.contextSummary?.trim().slice(0, 12_000);
    const unchanged = existing.eventType === options.eventType
      && existing.summary === nextSummary
      && (!nextEvidence || existing.evidence === nextEvidence)
      && (!nextContextSummary || existing.contextSummary === nextContextSummary);
    if (unchanged) return existing;
    const now = Date.now();
    const updated = {
      ...existing,
      eventType: options.eventType,
      summary: nextSummary,
      ...(nextEvidence ? { evidence: nextEvidence } : {}),
      ...(nextContextSummary ? { contextSummary: nextContextSummary } : {}),
      notifiedAt: now,
      notificationCount: existing.notificationCount + 1,
    };
    for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
      const delivery = pendingProjectManagerDeliveries[index];
      if (delivery.sessionId === session.id && delivery.transitionId === existing.id) {
        pendingProjectManagerDeliveries.splice(index, 1);
      }
    }
    replaceProjectManagerSession({
      ...currentSession,
      pendingSupervisorTransitions: pending.map((transition) => transition.id === existing.id ? updated : transition),
      pendingManagerDeliveries: (currentSession.pendingManagerDeliveries || [])
        .filter((delivery) => delivery.transitionId !== existing.id),
      updatedAt: now,
    });
    saveProjectManagerSnapshot(session.id);
    queueProjectManagerDelivery(
      projectSupervisorTransitionText(currentSession, updated, options.instruction),
      session.id,
      { priority: true, transitionId: updated.id },
    );
    return updated;
  }
  const now = Date.now();
  const transition: ProjectSupervisorTransition = {
    id: `pm-transition-${uuid()}`,
    laneId: options.laneId,
    ...(options.workItemId ? { workItemId: options.workItemId } : {}),
    kind: options.kind,
    eventType: options.eventType,
    summary: options.summary.trim().slice(0, 4000) || options.eventType,
    ...(options.evidence?.trim() ? { evidence: options.evidence.trim().slice(0, 12_000) } : {}),
    ...(options.contextSummary?.trim()
      ? { contextSummary: options.contextSummary.trim().slice(0, 12_000) }
      : {}),
    createdAt: now,
    notifiedAt: now,
    notificationCount: 1,
  };
  replaceProjectManagerSession({
    ...currentSession,
    pendingSupervisorTransitions: [...pending, transition].slice(-50),
    updatedAt: now,
  });
  store.appendProjectManagerEvent({
    kind: 'supervisor-transition',
    workItemId: transition.workItemId,
    summary: transition.summary,
    payload: {
      transitionId: transition.id,
      laneId: transition.laneId,
      transitionKind: transition.kind,
      eventType: transition.eventType,
    },
  }, session.id);
  saveProjectManagerSnapshot(session.id);
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
  queueProjectManagerDelivery(
    projectSupervisorTransitionText(current, transition, options.instruction),
    session.id,
    { priority: true, transitionId: transition.id },
  );
  return transition;
}

function queueProjectSupervisorAnomaly(
  session: ProjectManagerSession,
  lane: SupervisorLane,
  workItem: ProjectWorkItem,
  eventType: string,
  summary: string,
  options: { evidence?: string; contextSummary?: string } = {},
): void {
  queueProjectSupervisorTransition({
    sessionId: session.id,
    laneId: lane.id,
    workItemId: workItem.id,
    kind: 'project-action-required',
    eventType,
    summary,
    evidence: options.evidence,
    contextSummary: options.contextSummary,
    instruction: [
      '这是阶段内异常交接，不是普通进度汇报。先在项目既有权限内调整合同、路线、预算或恢复监督链，再续接同一任务。',
      '只有确需人工操作、用户专属信息、业务取舍、凭据/访问授权、破坏性或生产动作时，才升级为结构化用户问题。',
    ].join('\n'),
  });
}

function maintainProjectSupervisorTransition(session: ProjectManagerSession, now: number): boolean {
  const transition = [...(session.pendingSupervisorTransitions || [])].sort((left, right) => (
    projectTransitionPriority(left.kind) - projectTransitionPriority(right.kind)
      || left.createdAt - right.createdAt
  ))[0];
  if (!transition) return false;
  const linkedDelivery = (session.pendingManagerDeliveries || []).some((delivery) => (
    delivery.transitionId === transition.id
  )) || pendingProjectManagerDeliveries.some((delivery) => (
    delivery.sessionId === session.id && delivery.transitionId === transition.id
  ));
  if (linkedDelivery) {
    flushProjectManagerDeliveries();
    return true;
  }
  if (now - transition.notifiedAt < PROJECT_SUPERVISOR_TRANSITION_REDELIVERY_MS) return true;
  const refreshed = {
    ...transition,
    notifiedAt: now,
    notificationCount: transition.notificationCount + 1,
  };
  replaceProjectManagerSession({
    ...session,
    pendingSupervisorTransitions: (session.pendingSupervisorTransitions || [])
      .map((candidate) => candidate.id === transition.id ? refreshed : candidate),
    updatedAt: now,
  });
  saveProjectManagerSnapshot(session.id);
  queueProjectManagerDelivery(
    projectSupervisorTransitionText(session, refreshed, '该交接尚未收到项目 AI 回执。请先处理这一个高价值状态，不要发起新的进度询问。'),
    session.id,
    { priority: true, transitionId: refreshed.id },
  );
  return true;
}

function projectTransitionResolutionError(
  session: ProjectManagerSession,
  transition: ProjectSupervisorTransition,
  resolution: string,
): string | null {
  const store = useStore.getState();
  const item = transition.workItemId
    ? session.workItems.find((candidate) => candidate.id === transition.workItemId)
    : undefined;
  const activeLane = store.supervisor.lanes.find((lane) => (
    lane.projectManagerProjectId === session.id
    && (!transition.workItemId || lane.projectWorkItemId === transition.workItemId)
    && supervisorLaneControlState(lane) === 'active'
  ));
  const unresolvedDecision = transition.kind === 'decision-required'
    && store.supervisor.pendingApprovals.some((approval) => approval.laneId === transition.laneId);
  if (unresolvedDecision && !['paused', 'escalated'].includes(resolution)) {
    return '该监督交接仍有未关闭的待决 ID；必须先执行 wmux project decide 处理对应 approval，不能只更新上下文或用回执绕过待决项';
  }
  if (resolution === 'continued' || resolution === 'recovered') {
    if (!activeLane || (item && item.status !== 'running')) {
      return '交接回执声明已继续/恢复，但没有对应的活动监督链和 running 工作项';
    }
    return null;
  }
  if (resolution === 'accepted') {
    if (session.status !== 'completed'
      && activeProjectGoal(session).status !== 'achieved'
      && (!item || !['completed', 'stopped'].includes(item.status))) {
      return '交接回执声明已验收，但工作项或当前主目标尚未进入完成状态';
    }
    return null;
  }
  if (resolution === 'paused') {
    return session.status === 'paused' || item?.status === 'paused'
      ? null
      : '交接回执声明已暂停，但项目和工作项都没有进入 paused 状态';
  }
  if (resolution === 'escalated') {
    return session.pendingUserQuestion
      ? null
      : '交接回执声明已升级用户处理，但当前没有持久化的结构化用户问题';
  }
  const replanEvents = new Set([
    'work-item-created', 'work-item-updated', 'project-definition-updated',
    'project-subgoals-updated', 'project-preconditions-updated', 'supervisor-direction',
  ]);
  const transitionEventIndex = session.events.findIndex((event) => (
    event.kind === 'supervisor-transition' && event.payload?.transitionId === transition.id
  ));
  const eventsAfterTransition = transitionEventIndex >= 0
    ? session.events.slice(transitionEventIndex + 1)
    : session.events.filter((event) => event.ts >= transition.createdAt);
  const stateChanged = eventsAfterTransition.some((event) => replanEvents.has(event.kind));
  return stateChanged
    ? null
    : '交接回执声明已重规划，但交接创建后没有工作项、阶段、目标或任务方向变更';
}

function queueProjectSupervisorRecovery(lane: SupervisorLane, detail: string): void {
  const projectId = lane.projectManagerProjectId;
  if (!projectId) return;
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === projectId);
  if (!session || ['completed', 'stopped'].includes(session.status)) return;
  if (lane.projectWorkItemId) {
    store.applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: lane.projectWorkItemId,
      patch: { status: 'waiting-decision', latestBlocker: detail },
    }, session.id);
  }
  store.appendProjectManagerEvent({
    kind: 'supervisor-status',
    workItemId: lane.projectWorkItemId,
    summary: detail,
    payload: { laneId: lane.id, supervisorSurfaceId: lane.supervisorSurfaceId, recoveryRequired: true },
  }, session.id);
  saveProjectManagerSnapshot(session.id);
  queueProjectSupervisorTransition({
    sessionId: session.id,
    laneId: lane.id,
    workItemId: lane.projectWorkItemId,
    kind: 'supervisor-unavailable',
    eventType: 'supervisor.runtime-unavailable',
    summary: detail,
    instruction: [
      session.status === 'active'
        ? '项目仍处于 active；核对失败原因后重新执行 supervise，恢复暂停通道或重建已经失效的专属监督。'
        : `项目当前为 ${session.status}；条件未变化时先恢复项目，再重新执行 supervise。`,
      '不得继续等待旧监督自行恢复，也不得绕过监督直接向任务终端发送指令。',
    ].join('\n'),
  });
}

function projectStableTerminalScreen(
  surfaceId: string,
  label: string,
  activityState: RemoteTerminalActivityState,
): string {
  const rawScreen = readTerminalScreen(surfaceId, 30).text || '';
  const excerpt = terminalSupervisorCoreExcerpt(rawScreen, label, activityState);
  return normalizeProjectActivityFingerprintText(excerpt.answer || excerpt.text).slice(-1200);
}

function projectTaskScreenFingerprint(lane: SupervisorLane): string {
  const activity = remoteTerminalActivity(lane.surfaceId, true);
  return projectStableTerminalScreen(lane.surfaceId, lane.label, activity.activityState);
}

async function writeProjectSupervisorControl(surfaceId: SurfaceId, data: '\x1b' | '\x03'): Promise<boolean> {
  const pty = (window as any).wmux?.pty;
  try {
    if (pty?.has && !await pty.has(surfaceId)) return false;
    cancelPendingAutomatedTerminalSubmit(surfaceId, true);
    if (pty?.writeReliable) return await pty.writeReliable(surfaceId, data);
    if (!pty?.write) return false;
    pty.write(surfaceId, data);
    return true;
  } catch {
    return false;
  }
}

function scheduleProjectProgressCheck(sessionId: string, notBeforeAt = 0): void {
  const existing = projectProgressTimers.get(sessionId);
  if (existing) globalThis.clearTimeout(existing);
  projectProgressTimers.delete(sessionId);
  const session = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  const transition = session?.pendingSupervisorTransitions?.[0];
  if (!session || session.status !== 'active' || !transition) return;
  const generation = projectManagerDeliveryGeneration;
  const deadlineAt = Math.max(
    notBeforeAt,
    transition.notifiedAt + PROJECT_SUPERVISOR_TRANSITION_REDELIVERY_MS,
  );
  const timer = globalThis.setTimeout(() => {
    if (generation !== projectManagerDeliveryGeneration) return;
    projectProgressTimers.delete(sessionId);
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
    if (!current || current.status !== 'active') return;
    maintainProjectSupervisorTransition(current, Date.now());
    scheduleProjectProgressCheck(sessionId, Date.now() + PROJECT_SUPERVISOR_TRANSITION_REDELIVERY_MS);
  }, Math.max(0, deadlineAt - Date.now()));
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  projectProgressTimers.set(sessionId, timer);
}

async function ensureProjectManagerRuntime(sessionId: string, options: {
  forceRestart?: boolean;
  recoveredAfterRestart?: boolean;
} = {}): Promise<{
  ok: boolean;
  error?: string;
  manager?: RemoteTaskTerminalLocation;
  created?: boolean;
}> {
  const initialSession = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!initialSession) return { ok: false, error: '项目中心没有找到对应项目' };
  const previousManager = projectManagerTerminal({ projectId: sessionId });
  const selection = projectManagerRuntimeDefaults(useStore.getState().workspacePrefs.projectManagementAgents);
  const matchesSelection = previousManager?.surface.projectManagerAgent === selection.agent
    && String(previousManager.surface.projectManagerModel || '') === selection.model
    && String(previousManager.surface.projectManagerReasoningEffort || '') === selection.reasoningEffort;
  const previousRuntimeState = previousManager
    ? terminalRuntimeStatus(previousManager.surfaceId)?.state
    : undefined;
  const replaceRuntime = !!previousManager && (
    options.forceRestart === true
    || !matchesSelection
    || previousRuntimeState === 'failed'
    || previousRuntimeState === 'exited'
  );
  const activeExecution = useStore.getState().supervisor.lanes.some((lane) => (
    lane.projectManagerProjectId === sessionId && supervisorLaneControlState(lane) === 'active'
  ));
  if ((!previousManager || replaceRuntime) && !options.recoveredAfterRestart && !activeExecution) {
    await scanProjectProgressForReview(sessionId, '项目 AI 运行时重建前检查项目现状');
  }
  if (replaceRuntime) {
    await (window as any).wmux?.projectManager?.saveSession?.(
      useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initialSession,
    );
  }
  const skill = await (window as any).wmux?.projectManager?.ensureSkill?.(selection.agent);
  if (!skill?.ok) return { ok: false, error: skill?.error || '无法准备项目管理 AI 协议技能' };
  const runtimeDir = String(skill.runtimeDir || '').trim();
  if (!normalizeAbsolutePath(runtimeDir)) return { ok: false, error: '项目管理 AI 运行目录无效' };
  const launched = createRemoteDirectTerminalTask({
    action: 'create-task',
    name: PROJECT_MANAGER_TERMINAL_NAME,
    task: projectManagerStartupInput(
      selection.agent as ProjectManagerRuntimeAgent,
      String(skill.skillPath || ''),
      initialSession.id,
    ),
    agent: selection.agent,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    preset: 'project-manager',
    replaceProjectManager: replaceRuntime,
    cwd: runtimeDir,
    projectManagerProjectId: initialSession.id,
    actor: 'project-management-control-plane',
  }, true);
  if (!launched.ok) return { ok: false, error: launched.error || '无法启动项目管理 AI 运行时' };
  const manager = projectManagerTerminal({ surfaceId: launched.surfaceId, projectId: initialSession.id });
  if (!manager) return { ok: false, error: '项目管理 AI 运行时未注册' };
  const managerReady = await waitForTerminalRuntimeReady(manager.surfaceId);
  if (!managerReady.ok) {
    if (!previousManager || previousManager.surfaceId !== manager.surfaceId) {
      useStore.getState().closeSurface(manager.workspaceId, manager.paneId, manager.surfaceId);
    }
    return { ok: false, error: `项目管理 AI 运行时未就绪：${managerReady.error || '未知错误'}` };
  }
  if (previousManager && previousManager.surfaceId !== manager.surfaceId) {
    useStore.getState().closeSurface(
      previousManager.workspaceId,
      previousManager.paneId,
      previousManager.surfaceId,
    );
  }
  const stateBeforeBinding = useStore.getState();
  const rebound = stateBeforeBinding.projectManagers.map((session) => session.id === initialSession.id
    ? {
        ...session,
        managerSurfaceId: manager.surfaceId,
        updatedAt: session.managerSurfaceId === manager.surfaceId ? session.updatedAt : Date.now(),
      }
    : session);
  stateBeforeBinding.restoreProjectManagers(rebound, stateBeforeBinding.selectedProjectManagerId || undefined);
  if (previousManager && previousManager.surfaceId !== manager.surfaceId) {
    useStore.getState().appendProjectManagerEvent({
      kind: 'manager-runtime-restarted',
      summary: `本项目的项目 AI 已按配置安全换代为 ${selection.agent}${selection.model ? ` / ${selection.model}` : ''}，并恢复结构化项目上下文`,
      payload: {
        previousSurfaceId: previousManager.surfaceId,
        managerSurfaceId: manager.surfaceId,
        agent: selection.agent,
        model: selection.model,
      },
    }, initialSession.id);
    try {
      await (window as any).wmux?.projectManager?.saveSession?.(
        useStore.getState().projectManagers.find((candidate) => candidate.id === initialSession.id),
      );
    } catch (error) {
      console.warn('[project-manager] failed to persist runtime-restart audit event', error);
    }
  }
  let current = useStore.getState().projectManagers.find((candidate) => candidate.id === initialSession.id)!;
  hydrateProjectManagerDeliveries([current]);
  if (options.recoveredAfterRestart) {
    useStore.getState().appendProjectManagerEvent({
      kind: 'recovery-restored',
      summary: '已从持久记录恢复本项目；旧项目 AI、监督 AI 和任务 AI 会话均已失效',
    }, current.id);
    if (projectRequirementsAlignmentPending(current)) {
      await requireProjectRequirementsAlignment(
        current.id,
        '继续首次启动时尚未完成的需求充分性检测',
        !previousManager || previousManager.surfaceId !== manager.surfaceId,
      );
    }
    current = useStore.getState().projectManagers.find((candidate) => candidate.id === initialSession.id)!;
    await (window as any).wmux?.projectManager?.saveSession?.(current);
    const recoverableWorkItems = current.workItems.filter((item) => item.status !== 'stopped');
    deliverProjectManagerMessage([
      '[本项目恢复｜创建全新项目运行链]',
      `项目：${current.id} · ${current.projectDir}`,
      `状态：${current.status}`,
      `目标：${current.goal}`,
      `前置条件：${current.preconditions.length > 0 ? current.preconditions.join('；') : '待核实'}`,
      current.progressSync
        ? `[恢复时项目进度同步｜${current.progressSync.status === 'review-required' ? '必须先复核' : '已确认一致'}]\n${current.progressSync.summary}`
        : '[恢复时项目进度同步] 未取得可信快照，禁止直接沿用旧安排。',
      current.pendingSupervisorTransitions?.length
        ? `[待处理监督状态交接｜${current.pendingSupervisorTransitions.length} 项]\n${current.pendingSupervisorTransitions.map((transition) => (
          `${transition.id} · ${transition.kind} · ${transition.summary}`
        )).join('\n')}\n这些交接仍未被项目 AI 回执，必须优先处理并执行 transition-ack；不得把它们当成已经完成。`
        : '没有遗留的未回执监督状态交接。',
      recoverableWorkItems.length > 0
        ? `[全部未停止工作项｜${recoverableWorkItems.length} 项]\n${recoverableWorkItems.slice(0, 50).map((item) => (
            `${item.id} · ${item.title} · ${item.status} · G=${item.goalId || '未知'} · R${item.requirementsVersion || 0}/A${item.authorizationVersion || 0}/P${item.executionProtocolVersion || 0}${item.latestEvidence ? `；证据：${item.latestEvidence}` : ''}${item.latestBlocker ? `；阻塞：${item.latestBlocker}` : ''}`
          )).join('\n')}${recoverableWorkItems.length > 50 ? `\n另有 ${recoverableWorkItems.length - 50} 项，请从 project status 完整读取。` : ''}`
        : '当前没有未停止工作项。',
      '旧项目 AI、监督 AI、任务 AI 及其 surfaceId 都已失效，不得恢复、读取、投递或重新绑定。请根据 latestContextSummary、latestEvidence、latestBlocker 和最近事件重建新的专属监督与任务 AI；不要重做已有证据支持的工作。',
      current.progressSync?.status === 'review-required'
        ? `先依据进度同步摘要和持久化证据更新受影响的工作项/阶段；摘要不能证明的语义与验证保持未知，并安排新任务基线只读核对。然后执行 wmux project progress-sync --project ${current.id} --ack --summary "<已知变化、未知项和后续核对安排>"。确认前不得 resume、task-create 或 supervise，也不要把内部同步交给用户确认。`
        : '恢复快照与上次已知进度一致，可继续按当前结构化状态规划。',
      current.workItems.some((item) => (
        !['completed', 'stopped'].includes(item.status)
        && (item.executionProtocolVersion || 0) < CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION
      ))
        ? `[执行协议迁移｜当前 P${CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION}] 上述 P 版本过期的未完成工作项不得直接 supervise。逐项审查目标、硬边界、授权、停止条件、验证和阶段粒度，然后用 task-update --json-file 提交完整 contract；控制层会重置旧基线、旧监督计划及旧反循环计数并绑定当前协议。不得仅修改状态、复用旧微任务合同或把 executionProtocolVersion 写进 JSON。`
        : `[执行协议｜P${CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION}] 未完成工作项已使用当前协议；恢复仍会重建当前工作树基线与监督运行链。`,
      `[项目认知基线｜继续前必须提交]\n在进度同步与需求对齐完成后，逐项判断上述所有未停止工作项，执行 wmux project orientation-confirm --project ${current.id} --json-file <项目目录内的 .wmux/tmp/文件>。JSON 必须原样携带 project status 中 orientation 的 requirementsVersion、authorizationVersion、snapshotFingerprint、requestedAt，并包含 summary、knownFacts、unknowns、workItems；每个工作项提供 workItemId、disposition（continue/verify/pause/stop/retain-completed）、basis 和 nextAction。未完成的旧目标/旧版本工作项只能 pause 或 stop。确认前不得 goal-plan、resume、task-create 或 supervise。`,
      '你只管理本项目；不得读取或决定项目中心中的其他项目。',
    ].join('\n'), true, current.id);
  }
  current = useStore.getState().projectManagers.find((candidate) => candidate.id === initialSession.id)!;
  if (current.status === 'active') {
    scheduleProjectProgressCheck(current.id);
  }
  return { ok: true, manager, created: !previousManager || previousManager.surfaceId !== manager.surfaceId };
}

function deliverProjectManagerMessage(text: string, runtimeCreated: boolean, sessionId: string): void {
  if (!runtimeCreated) {
    queueProjectManagerDelivery(text, sessionId);
    return;
  }
  window.setTimeout(() => queueProjectManagerDelivery(text, sessionId), SUPERVISOR_TUI_READY_DELAY_MS);
}

async function persistProjectManagerMutation<T extends { event?: { kind: string; summary: string; correlationId?: string; payload?: Record<string, unknown> } }>(
  result: T,
  sessionId?: string,
): Promise<T> {
  const state = useStore.getState();
  const session = sessionId
    ? state.projectManagers.find((candidate) => candidate.id === sessionId)
    : state.projectManager;
  if (!session) return result;
  const api = (window as any).wmux?.projectManager;
  await api?.saveSession?.(session);
  if (result.event) {
    await api?.appendRecord?.({
      sessionId: session.id,
      projectDir: session.projectDir,
      type: result.event.kind,
      payload: {
        ...(result.event.payload || {}),
        message: result.event.summary,
        correlationId: result.event.correlationId,
      },
    });
  }
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  if (current?.status === 'active') scheduleProjectProgressCheck(current.id);
  return result;
}

function scheduleProjectAlignmentFallback(sessionId: string, runtimeCreated = false): void {
  const existing = projectAlignmentTimers.get(sessionId);
  if (existing) globalThis.clearTimeout(existing);
  const timer = globalThis.setTimeout(() => {
    projectAlignmentTimers.delete(sessionId);
    void ensureProjectRequirementAlignment(
      sessionId,
      '项目管理 AI 在规定时间内未提交需求充分性结论，控制层再次提醒其提交结构化判定',
      runtimeCreated,
      false,
    ).catch((error) => console.warn('[project-manager] alignment fallback failed', error));
  }, PROJECT_ALIGNMENT_FALLBACK_DELAY_MS);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  projectAlignmentTimers.set(sessionId, timer);
}

async function requireProjectRequirementsAlignment(
  sessionId: string,
  reason: string,
  runtimeCreated = false,
): Promise<ProjectManagerSession | undefined> {
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session || ['completed', 'stopped'].includes(session.status)) return session;
  if (!projectRequirementsAlignmentPending(session)) {
    const result = store.applyProjectManagerAction({ type: 'require-requirements-alignment', reason }, session.id);
    if (!result.ok) return session;
    for (const laneId of projectSupervisorLaneIds(session)) {
      store.pauseSupervisorLane(laneId, '项目启动或恢复后必须重新核对需求充分性');
    }
    await persistProjectManagerMutation(result, session.id);
  }
  scheduleProjectAlignmentFallback(session.id, runtimeCreated);
  return useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
}

async function ensureProjectRequirementAlignment(
  sessionId: string,
  trigger: string,
  runtimeCreated = false,
  forceQuestion = false,
): Promise<{ triggered: boolean; alignmentRequired?: boolean; awaitingDefinitionUpdate?: boolean; session?: ProjectManagerSession; question?: ProjectManagerUserQuestion; error?: string }> {
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session || ['completed', 'stopped'].includes(session.status)) return { triggered: false, session };
  const alignmentRequired = projectRequirementsAlignmentPending(session);
  const alignmentState = projectRequirementAlignmentState(session);
  if ((!alignmentRequired && !forceQuestion) || session.pendingUserQuestion) {
    return { triggered: false, session };
  }
  if (alignmentState === 'needs-definition-update') {
    deliverProjectManagerMessage([
      '[需求对齐门禁｜用户已答复但项目定义尚未更新]',
      `项目：${session.id} · ${session.projectDir}`,
      `禁止直接恢复。请先根据用户答复执行 wmux project update --project ${session.id}，补全目标、范围和可验证完成条件；仍有关键歧义时再发起下一轮结构化提问。`,
    ].join('\n'), runtimeCreated, session.id);
    return { triggered: false, awaitingDefinitionUpdate: true, session };
  }
  if (alignmentRequired && alignmentState === 'sufficient' && !forceQuestion) {
    deliverProjectManagerMessage([
      '[强制需求充分性判定]',
      `项目：${session.id} · ${session.projectDir}`,
      `请先检查目标、产品形态、功能范围、前置条件和可验证完成标准。需求不足时必须执行 wmux project ask --project ${session.id} 并给出推荐方案；确认充分时执行 wmux project alignment-confirm --project ${session.id}，记录目标理解、范围、验收标准和理由。未提交结论前控制层不会创建终端、工作项、派遣监督或恢复项目。`,
    ].join('\n'), runtimeCreated, session.id);
    return { triggered: false, alignmentRequired: true, session };
  }
  const normalized = normalizeProjectManagerUserQuestion(
    projectAlignmentQuestionInput(session),
    session.status,
  );
  if (!normalized.question) return { triggered: false, session, error: normalized.error };
  const result = store.applyProjectManagerAction({
    type: 'request-user-clarification',
    question: normalized.question,
  }, session.id);
  if (!result.ok) return { triggered: false, session, error: result.error };
  for (const laneId of projectSupervisorLaneIds(session)) {
    store.pauseSupervisorLane(laneId, '项目需求尚未充分对齐，等待用户选择推荐方案');
  }
  const timer = projectProgressTimers.get(session.id);
  if (timer) globalThis.clearTimeout(timer);
  projectProgressTimers.delete(session.id);
  const alignmentTimer = projectAlignmentTimers.get(session.id);
  if (alignmentTimer) globalThis.clearTimeout(alignmentTimer);
  projectAlignmentTimers.delete(session.id);
  store.selectProjectManager(session.id);
  store.openProjectManagerDialog();
  await persistProjectManagerMutation(result, session.id);
  notifyProjectManagerUserQuestion(session, normalized.question);
  const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  deliverProjectManagerMessage([
    '[需求对齐门禁已由控制层执行]',
    `项目：${session.id} · ${session.projectDir}`,
    `触发原因：${trigger}`,
    `已向桌面项目对话和飞书发送带推荐项的问题：${normalized.question.question}`,
    '用户答复前不得恢复、创建工作项或派遣监督 AI。收到答复后先写回项目定义；仍有关键歧义时继续下一轮结构化提问。',
  ].join('\n'), runtimeCreated, session.id);
  return { triggered: true, session: updated, question: normalized.question };
}

async function appendRecordedProjectEvent(
  session: ProjectManagerSession,
  event: {
    kind: ProjectManagerEventKind;
    summary: string;
    workItemId?: string;
    payload?: Record<string, unknown>;
  },
  options: { persistSession?: boolean } = {},
): Promise<void> {
  const created = useStore.getState().appendProjectManagerEvent(event, session.id);
  const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  if (options.persistSession !== false) {
    await (window as any).wmux?.projectManager?.saveSession?.(updated);
  }
  if (created) {
    await (window as any).wmux?.projectManager?.appendRecord?.({
      sessionId: session.id,
      projectDir: session.projectDir,
      type: created.kind,
      payload: { message: created.summary, ...(created.payload || {}) },
    });
    if (projectManagerEventNeedsUserAttention(created)) {
      const workspaceId = projectRuntimeWorkspaceId(session.id);
      const surfaceId = updated?.managerSurfaceId || updated?.taskTerminalSurfaceId || '';
      const title = created.kind === 'guard-triggered' ? '项目执行护栏需要处理' : '项目运行异常';
      const text = `项目“${projectDisplayName(updated || session)}”需要处理：${created.summary}`;
      if (workspaceId) {
        useStore.getState().addNotification({
          surfaceId: surfaceId as SurfaceId,
          workspaceId,
          title,
          text,
        });
      }
      window.wmux?.notification?.fire({ surfaceId, title, text });
    }
  }
}

async function unresolvedProjectLaneQuiescenceError(
  session: ProjectManagerSession,
  lane: SupervisorLane,
): Promise<string | null> {
  const latest = [...session.events].reverse().find((event) => (
    (event.kind === 'requirements-quiesced' || event.kind === 'requirements-quiesce-failed')
    && event.payload?.laneId === lane.id
  ));
  if (latest?.kind !== 'requirements-quiesce-failed') return null;
  const activity = remoteTerminalActivity(lane.surfaceId);
  if (activity.activityState !== 'idle' && activity.activityState !== 'blocked') {
    return `旧需求任务终端仍为${activity.activityState === 'working' ? '运行中' : '未知状态'}且未确认中断；禁止复用该终端，请先等待其停止或由用户处理运行中的旧任务`;
  }
  await appendRecordedProjectEvent(session, {
    kind: 'requirements-quiesced',
    workItemId: lane.projectWorkItemId,
    summary: `重新派发前已确认旧任务终端不再运行：${lane.label}`,
    payload: { laneId: lane.id, surfaceId: lane.surfaceId, recoveredAfterFailure: true },
  });
  return null;
}

async function quiesceProjectRuntimeLanes(
  session: ProjectManagerSession,
  reason: string,
): Promise<{ confirmed: string[]; failed: string[] }> {
  const store = useStore.getState();
  const lanes = store.supervisor.lanes.filter((lane) => (
    lane.projectManagerProjectId === session.id
    && supervisorLaneControlState(lane) !== 'stopped'
  ));
  const confirmed: string[] = [];
  const failed: string[] = [];
  for (const lane of lanes) {
    // A requirement or prerequisite change revokes any delayed automatic Enter
    // before the control plane interrupts the old task.
    cancelPendingAutomatedTerminalSubmit(lane.surfaceId, true);
    store.pauseSupervisorLane(lane.id, reason);
    if (lane.projectTaskStartupPending) {
      confirmed.push(lane.id);
      continue;
    }
    const terminal = locateRemoteTaskTerminal(lane.surfaceId).terminal;
    if (!terminal) {
      failed.push(lane.id);
      await appendRecordedProjectEvent(session, {
        kind: 'requirements-quiesce-failed',
        workItemId: lane.projectWorkItemId,
        summary: `需求变更时无法定位任务终端，未能确认旧任务已停止：${lane.label}`,
        payload: { laneId: lane.id, surfaceId: lane.surfaceId, reason },
      });
      continue;
    }
    const activityBeforeInterrupt = remoteTerminalActivity(lane.surfaceId).activityState;
    if (activityBeforeInterrupt === 'idle' || activityBeforeInterrupt === 'blocked') {
      confirmed.push(lane.id);
      await appendRecordedProjectEvent(session, {
        kind: 'requirements-quiesced',
        workItemId: lane.projectWorkItemId,
        summary: `需求变更时任务终端已处于非运行状态，未发送 Ctrl+C：${lane.label}`,
        payload: { laneId: lane.id, surfaceId: lane.surfaceId, reason, activity: activityBeforeInterrupt },
      });
      continue;
    }
    if (activityBeforeInterrupt !== 'working') {
      failed.push(lane.id);
      await appendRecordedProjectEvent(session, {
        kind: 'requirements-quiesce-failed',
        workItemId: lane.projectWorkItemId,
        summary: `任务终端运行状态不明，为避免退出 Agent 未盲发 Ctrl+C：${lane.label}`,
        payload: { laneId: lane.id, surfaceId: lane.surfaceId, reason, activity: activityBeforeInterrupt },
      });
      continue;
    }
    const pty = (window as any).wmux?.pty;
    let accepted = false;
    try {
      if (pty?.has && !await pty.has(lane.surfaceId)) {
        accepted = false;
      } else if (pty?.writeReliable) {
        accepted = await pty.writeReliable(lane.surfaceId, '\x03');
      } else if (pty?.write) {
        pty.write(lane.surfaceId, '\x03');
        accepted = true;
      }
    } catch {
      accepted = false;
    }
    if (accepted) {
      let activity = remoteTerminalActivity(lane.surfaceId).activityState;
      if (activity === 'working') {
        for (let attempt = 0; attempt < 20 && activity === 'working'; attempt += 1) {
          await waitForControlPlaneDelay(100);
          activity = remoteTerminalActivity(lane.surfaceId).activityState;
        }
      }
      // A reliable Ctrl+C write proves delivery, not quiescence. Unknown or
      // stale activity must keep the project paused for user intervention.
      accepted = activity === 'idle' || activity === 'blocked';
    }
    if (accepted) {
      confirmed.push(lane.id);
      await appendRecordedProjectEvent(session, {
        kind: 'requirements-quiesced',
        workItemId: lane.projectWorkItemId,
        summary: `已暂停监督并确认中断旧任务：${lane.label}`,
        payload: { laneId: lane.id, surfaceId: lane.surfaceId, reason },
      });
    } else {
      failed.push(lane.id);
      await appendRecordedProjectEvent(session, {
        kind: 'requirements-quiesce-failed',
        workItemId: lane.projectWorkItemId,
        summary: `任务终端未确认中断，项目保持暂停：${lane.label}`,
        payload: { laneId: lane.id, surfaceId: lane.surfaceId, reason },
      });
    }
  }
  return { confirmed, failed };
}

async function updateProjectDefinition(
  session: ProjectManagerSession,
  params: any,
  source: 'user' | 'manager',
): Promise<any> {
  if (['completed', 'stopped'].includes(session.status)) {
    return { ok: false, error: '已完成或停止的项目不能修改目标和需求' };
  }
  if (session.pendingUserQuestion && source === 'manager') {
    return { ok: false, error: '项目仍有待答问题，请先在桌面或飞书完成当前需求确认' };
  }
  if (params?.mode !== undefined && !['refine', 'pivot'].includes(params.mode)) {
    return { ok: false, error: '主目标变更模式必须是 refine（调整当前目标）或 pivot（切换新目标）' };
  }
  const goal = params?.goal === undefined ? session.goal : String(params.goal || '').trim();
  const preconditions = params?.preconditions === undefined
    ? session.preconditions
    : projectStringArray(params.preconditions);
  const supervisorNotes = params?.supervisorNotes === undefined
    ? session.supervisorNotes || []
    : projectStringArray(params.supervisorNotes).slice(0, 20).map((note) => note.slice(0, 4000));
  const doneWhen = params?.doneWhen === undefined
    ? session.doneWhen
    : projectStringArray(params.doneWhen);
  const planFiles = params?.planFiles === undefined
    ? session.planFiles
    : projectPlanFileSnapshots(params.planFiles);
  if (params?.planFiles !== undefined && (
    !Array.isArray(params.planFiles) || planFiles.length !== params.planFiles.length
  )) {
    return { ok: false, error: `计划文件格式无效、不可访问或超过 ${MAX_PROJECT_PLAN_FILES} 个` };
  }
  if (!goal) return { ok: false, error: '项目目标不能为空' };
  if (preconditions.length === 0) {
    return { ok: false, error: '项目前置条件不能为空；没有额外条件时请明确填写“无额外物理前置条件”' };
  }
  if (doneWhen.length === 0) return { ok: false, error: '项目完成条件不能为空' };
  const mode = params?.mode === 'pivot' ? 'pivot' : 'refine';
  const unchanged = goal === session.goal
    && JSON.stringify(preconditions) === JSON.stringify(session.preconditions)
    && JSON.stringify(supervisorNotes) === JSON.stringify(session.supervisorNotes || [])
    && JSON.stringify(doneWhen) === JSON.stringify(session.doneWhen)
    && JSON.stringify(planFiles) === JSON.stringify(session.planFiles);
  if (unchanged && mode === 'refine') return { ok: false, error: '当前主目标和需求没有发生变化' };

  const reason = String(params?.reason || '').trim().slice(0, 2000)
    || `${source === 'user' ? '用户通过项目配置' : '项目 AI 根据用户对话'}${mode === 'pivot' ? '切换新的主目标' : '调整当前主目标'}`;
  const store = useStore.getState();
  const quiesce = await quiesceProjectRuntimeLanes(
    session,
    mode === 'pivot'
      ? '用户切换新的主目标，撤销旧目标运行授权并等待项目 AI 建立新阶段计划'
      : '当前主目标要求已调整，暂停当前执行链并等待项目 AI 评估影响',
  );
  const result = store.applyProjectManagerAction({
    type: 'update-project-definition',
    goal,
    preconditions,
    supervisorNotes,
    planFiles,
    doneWhen,
    reason,
    source,
    mode,
  }, session.id);
  if (!result.ok) return result;
  const alignmentResult = store.applyProjectManagerAction({
    type: 'require-requirements-alignment',
    reason: mode === 'pivot'
      ? '主目标已切换，需要按新目标重新确认需求、范围和验收充分性'
      : '目标或需求已调整，需要按新版本重新确认需求、范围和验收充分性',
  }, session.id);
  if (!alignmentResult.ok) return alignmentResult;
  for (const laneId of projectSupervisorLaneIds(session)) {
    store.pauseSupervisorLane(laneId, mode === 'pivot'
      ? '旧主目标已被替代，等待项目 AI 建立新目标执行链'
      : '当前主目标要求已调整，等待项目 AI 重新绑定任务版本');
  }
  const timer = projectProgressTimers.get(session.id);
  if (timer) globalThis.clearTimeout(timer);
  projectProgressTimers.delete(session.id);
  await persistProjectManagerMutation(result, session.id);
  const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  if (source === 'user') {
    queueProjectManagerDelivery([
      `[用户${mode === 'pivot' ? '切换新的主目标' : '调整当前主目标'}｜必须完成影响评估后回复用户]`,
      `项目：${session.id} · ${session.projectDir}`,
      `稳定项目范围：${session.projectScope || '仅当前项目目录'}`,
      `原主目标 ID：${activeProjectGoal(session).id}`,
      `原目标：${session.goal}`,
      `新目标：${goal}`,
      `变更模式：${mode === 'pivot' ? '切换新的主目标；旧目标进入历史且禁止继续派发' : '调整当前主目标；只允许显式复核后重绑任务版本'}`,
      `新前置条件：${preconditions.join('；')}`,
      `监督注意事项：${supervisorNotes.length > 0 ? supervisorNotes.join('；') : '无'}`,
      `新完成条件：${doneWhen.join('；')}`,
      `计划文件：${planFiles.length > 0 ? planFiles.map((file) => file.name).join('、') : '无'}`,
      `用户说明：${reason}`,
      '',
      mode === 'pivot'
        ? `旧目标未完成任务已经停止，完成成果仍保留为证据。先重新提交 alignment-confirm 和 orientation-confirm，再执行 wmux project goal-plan --project ${session.id} 建立新目标的 3-7 个阶段目标；不得把旧任务跨 goalId 复活。`
        : `检查现有任务与调整后的目标是否兼容；继续使用的任务必须通过 task-update 设置 rebindCurrentRequirements=true，过期任务应停止。重新提交 alignment-confirm 和 orientation-confirm 后，阶段计划变化时再执行 wmux project goal-plan --project ${session.id}。`,
      `完成影响评估和阶段计划后，执行 wmux project reply --project ${session.id} --message "<变更影响和新计划>" 回复用户，再显式执行 wmux project resume --project ${session.id}。除用户业务选择、越界或硬风险外，不得逐项向用户申请确认。`,
    ].join('\n'), session.id);
  }
  return {
    ok: true,
    event: result.event,
    session: updated,
    message: source === 'user'
      ? quiesce.failed.length > 0
        ? '主目标变更已记录；监督链保持暂停，但部分任务终端未确认中断，已通知用户处理。'
        : '主目标变更已记录；旧运行已中断，等待项目 AI 完成影响评估和阶段规划。'
      : quiesce.failed.length > 0
        ? '主目标要求已写入；部分旧任务未确认中断，项目保持暂停并已上报用户。'
        : '主目标要求已写入且旧运行已中断；请完成阶段规划和任务重绑后显式恢复。',
  };
}

async function answerProjectManagerUserQuestion(params: any): Promise<any> {
  const session = projectSessionForParams(params);
  const pending = session?.pendingUserQuestion;
  if (!session || !pending) return { ok: false, error: '当前项目没有待用户确认的问题' };
  const questionId = String(params?.questionId || '').trim();
  if (questionId && questionId !== pending.id) return { ok: false, error: '该问题已经失效，请刷新项目状态' };
  const optionId = String(params?.optionId || '').trim() || undefined;
  const option = optionId ? pending.options.find((candidate) => candidate.id === optionId) : undefined;
  if (optionId && !option) return { ok: false, error: '所选答复选项不存在' };
  const detail = String(params?.answer || '').trim().slice(0, 5000);
  const answer = option
    ? detail && detail !== option.label ? `${option.label}：${detail}` : option.label
    : detail;
  if (!answer) return { ok: false, error: '请选择一个选项或填写答复' };
  const answeredBy = params?.source === 'feishu' || params?.answeredBy === 'feishu' ? 'feishu' : 'desktop';
  const store = useStore.getState();
  const result = store.applyProjectManagerAction({
    type: 'answer-user-clarification',
    questionId: pending.id,
    answer,
    optionId,
    answeredBy,
  }, session.id);
  if (!result.ok) return result;
  const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  await persistProjectManagerMutation(result, session.id);
  deliverProjectManagerMessage([
    '[用户澄清答复]',
    `项目：${session.id}`,
    `问题 ID：${pending.id}`,
    `问题：${pending.question}`,
    `答复：${answer}`,
    `渠道：${answeredBy === 'feishu' ? '飞书' : '桌面端'}`,
    `项目和监督仍保持等待。请先依据答复决定恢复、改线、继续等待或结束；只有选择继续时才执行 wmux project resume --project ${session.id}。不得扩张原项目范围。`,
  ].join('\n'), false, session.id);
  return { ok: true, event: result.event, session: updated, message: '用户答复已提交给项目管理 AI；项目仍暂停等待其决策。' };
}

async function setProjectPortfolioPaused(paused: boolean, reason: string): Promise<{
  ok: true;
  affectedProjects: string[];
  blockedProjects: string[];
  message: string;
}> {
  const state = useStore.getState();
  const portfolioPaused = state.projectManagers.filter((session) => (
    session.status === 'paused' && session.pausedByPortfolio === true
  ));
  const definitionBlocked = paused ? [] : portfolioPaused.filter((session) => (
    !!session.pendingUserQuestion
    || projectRequirementsAlignmentPending(session)
    || projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)
  ));
  const progressBlocked: ProjectManagerSession[] = [];
  if (!paused) {
    const definitionBlockedIds = new Set(definitionBlocked.map((session) => session.id));
    for (const candidate of portfolioPaused.filter((session) => !definitionBlockedIds.has(session.id))) {
      const progress = await scanProjectProgressForReview(candidate.id, '项目组合恢复前检查项目现状');
      const refreshed = useStore.getState().projectManagers.find((session) => session.id === candidate.id) || candidate;
      if (!progress.ok || projectProgressReviewError(refreshed)) progressBlocked.push(refreshed);
    }
  }
  const blocked = [...definitionBlocked, ...progressBlocked];
  const blockedIds = new Set(blocked.map((session) => session.id));
  const targets = paused
    ? state.projectManagers.filter((session) => session.status === 'active')
    : portfolioPaused.filter((session) => !blockedIds.has(session.id));
  for (const session of targets) {
    const store = useStore.getState();
    const action = paused
      ? { type: 'pause-project' as const, reason, source: 'portfolio' as const }
      : { type: 'resume-project' as const, reason, source: 'portfolio' as const };
    const result = store.applyProjectManagerAction(action, session.id);
    if (paused) {
      for (const laneId of projectSupervisorLaneIds(session)) {
        store.pauseSupervisorLane(laneId, '项目组合已全局暂停');
      }
    } else {
      resumeEligibleProjectSupervisorLanes(session.id, '项目组合已全局恢复');
    }
    if (paused) {
      const timer = projectProgressTimers.get(session.id);
      if (timer) globalThis.clearTimeout(timer);
      projectProgressTimers.delete(session.id);
    } else {
      scheduleProjectProgressCheck(session.id);
    }
    await persistProjectManagerMutation(result, session.id);
    queueProjectManagerDelivery([
      '[项目中心状态通知]',
      `项目：${session.id}`,
      paused
        ? `用户通过项目中心暂停了本项目。原因：${reason}`
        : `用户通过项目中心恢复了本项目。原因：${reason}`,
      paused
        ? '停止派发新工作，并保留当前证据与待办。'
        : '先核对当前项目状态和需求版本，再继续项目内决策。',
    ].join('\n'), session.id);
  }
  return {
    ok: true,
    affectedProjects: targets.map((session) => session.id),
    blockedProjects: blocked.map((session) => session.id),
    message: targets.length > 0
      ? `已${paused ? '暂停' : '恢复'} ${targets.length} 个项目；${blocked.length > 0 ? `${blocked.length} 个项目仍受需求或用户答复门禁约束。` : '此前单独暂停或等待中的项目保持不变。'}`
      : paused
        ? '当前没有可暂停的运行中项目。'
        : blocked.length > 0
          ? `${blocked.length} 个项目仍受需求或用户答复门禁约束，未执行全局恢复。`
          : '当前没有由全局操作暂停的项目。',
  };
}

function saveProjectManagerSnapshot(sessionId?: string): void {
  const state = useStore.getState();
  const session = sessionId
    ? state.projectManagers.find((candidate) => candidate.id === sessionId)
    : state.projectManager;
  if (!session) return;
  void (window as any).wmux?.projectManager?.saveSession?.(session)
    ?.catch?.((error: unknown) => console.warn('[project-manager] snapshot save failed', error));
}

async function startProjectTaskTerminalFromSupervisor(
  session: ProjectManagerSession,
  lane: SupervisorLane,
): Promise<Record<string, unknown>> {
  const store = useStore.getState();
  const workItemId = lane.projectWorkItemId || '';
  const item = session.workItems.find((candidate) => candidate.id === workItemId);
  if (!item) return { ok: false, error: `任务不存在：${workItemId}` };
  if (item.supervisorLaneId !== lane.id) {
    return { ok: false, error: '工作项与当前 AI 监督绑定不一致，不能启动任务终端' };
  }
  if (['completed', 'stopped'].includes(item.status)) {
    return { ok: false, error: '已完成或停止的任务不能启动任务终端' };
  }
  const incompleteDependency = item.dependencies.find((dependencyId) => (
    session.workItems.find((candidate) => candidate.id === dependencyId)?.status !== 'completed'
  ));
  if (incompleteDependency) {
    return { ok: false, error: `依赖任务尚未完成：${incompleteDependency}` };
  }
  if (session.status !== 'active') {
    return { ok: false, error: '项目处于暂停或等待状态，监督 AI 不能启动任务终端' };
  }
  if (projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)) {
    return { ok: false, error: '项目管理 AI 尚未接受最新需求版本，不能启动任务终端' };
  }
  if (item.workerSurfaceId || session.taskTerminalSurfaceId) {
    return { ok: false, error: '该项目已经绑定任务终端，不能重复创建' };
  }
  const startupRequirementsVersion = projectRequirementsVersion(session);
  const taskDefaults = projectTaskTerminalDefaults(store.workspacePrefs.projectManagementAgents);
  const executionWorkspaceId = projectExecutionWorkspaceId(lane);
  if (!executionWorkspaceId) {
    return { ok: false, error: '项目专属监督不在有效的项目执行会话中，不能创建任务终端' };
  }
  const recoveryPackage = session.recoveryState === 'checking'
    ? projectRecoveryBriefing(session, item)
    : '';
  const executionIdentity = projectExecutionIdentity(session, item);
  const created = createRemoteDirectTerminalTask({
    action: 'create-task',
    name: item.title || item.id,
    task: [
      '[项目任务 AI 冷启动]',
      buildProjectExecutionIdentityBlock(executionIdentity),
      `项目：${session.id}`,
      `工作项：${item.id}`,
      '本终端由该工作项的监督 AI 在同一项目执行会话中创建，是全新的项目专属任务 AI 对话。上面的执行身份已经生效，不需要寻找或重建旧身份。不要扫描或接管其他终端，也不要自行从项目总目标推断任务。',
      '请保持等待；监督 AI 会通过受控裁决桥发送任务契约、恢复上下文和第一条可执行指令。',
    ].join('\n'),
    agent: taskDefaults.agent,
    model: taskDefaults.model,
    reasoningEffort: taskDefaults.reasoningEffort,
    cwd: session.projectDir,
    anchorWorkspace: executionWorkspaceId,
    projectManagerProjectId: session.id,
    projectManagerWorkItemId: item.id,
    actor: `project-supervisor:${lane.id}`,
  }, true);
  if (!created.ok || !created.surfaceId) return created;
  const terminal = locateRemoteTaskTerminal(created.surfaceId).terminal;
  if (!terminal) {
    closeLiveSurfaceById(created.surfaceId as SurfaceId);
    return { ok: false, error: '监督 AI 已创建任务终端，但控制层无法完成项目绑定；未绑定终端已关闭' };
  }
  const taskRuntimeReady = await waitForTerminalRuntimeReady(terminal.surfaceId);
  if (!taskRuntimeReady.ok) {
    closeLiveSurfaceById(terminal.surfaceId);
    return { ok: false, error: `任务终端运行时未就绪：${taskRuntimeReady.error || '未知错误'}` };
  }
  const currentStartupLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id);
  const currentStartupProject = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  const currentStartupItem = currentStartupProject?.workItems.find((candidate) => candidate.id === item.id);
  if (
    !currentStartupLane?.projectTaskStartupPending
    || currentStartupLane.supervisorSurfaceId !== lane.supervisorSurfaceId
    || supervisorLaneControlState(currentStartupLane) !== 'active'
    || currentStartupProject?.status !== 'active'
    || projectRequirementsVersion(currentStartupProject) !== startupRequirementsVersion
    || projectAcceptedRequirementsVersion(currentStartupProject) !== startupRequirementsVersion
    || currentStartupItem?.supervisorLaneId !== lane.id
  ) {
    closeLiveSurfaceById(terminal.surfaceId);
    return { ok: false, error: '任务终端启动期间项目状态或需求版本已变化；新终端已关闭，未绑定旧任务' };
  }

  store.updateLane(lane.id, {
    surfaceId: terminal.surfaceId,
    label: terminal.label,
    paneId: terminal.paneId,
    workspaceId: terminal.workspaceId,
    workspaceTitle: terminal.workspaceTitle,
    projectDir: terminal.projectDir,
    scopeRoot: session.projectDir,
    projectTaskStartupPending: false,
    awaitingReview: true,
    currentTask: '',
  });
  const latestSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
  store.restoreProjectManager({
    ...latestSession,
    taskTerminalSurfaceId: terminal.surfaceId,
    updatedAt: Date.now(),
  });
  store.applyProjectManagerAction({
    type: 'update-work-item',
    workItemId: item.id,
    patch: { workerSurfaceId: terminal.surfaceId },
  }, session.id);
  store.appendProjectManagerEvent({
    kind: 'supervisor-status',
    workItemId: item.id,
    summary: `AI 监督已创建新的项目专属任务终端：${terminal.surfaceId}`,
    payload: {
      laneId: lane.id,
      supervisorSurfaceId: lane.supervisorSurfaceId,
      workerSurfaceId: terminal.surfaceId,
      restored: session.recoveryState === 'checking',
    },
  }, session.id);
  await (window as any).wmux?.projectManager?.saveSession?.(
    useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
  );

  const current = useStore.getState().supervisor;
  const rebound = current.lanes.find((candidate) => candidate.id === lane.id);
  const currentProject = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  if (
    !rebound?.supervisorSurfaceId
    || rebound.projectTaskStartupPending
    || supervisorLaneControlState(rebound) !== 'active'
    || currentProject?.status !== 'active'
    || projectAcceptedRequirementsVersion(currentProject) !== projectRequirementsVersion(currentProject)
  ) {
    return { ok: false, error: '任务终端已就绪，但项目监督链状态已变化，未发送旧任务协议' };
  }
  const states = (window as any).__wmux_getAgentStates?.() || {};
  const briefing = buildSupervisorBriefing(current, {
    lane: rebound,
    state: String(states[rebound.surfaceId]?.state || 'unknown'),
  });
  try {
    await sendToSurfaceReliably(rebound.supervisorSurfaceId, [
      '[任务终端启动成功｜正式监督协议]',
      recoveryPackage,
      briefing,
      '',
      '这是新建任务终端的首次待裁决轮次。先 read-screen 核对其等待状态，再通过 supervisor decide 携带 --next 发送任务契约和第一条可执行指令。',
    ].filter(Boolean).join('\n\n'), true);
  } catch (error) {
    const detail = `任务终端已就绪，但正式监督协议投递失败：${String((error as Error)?.message || error)}`;
    store.pauseSupervisorLane(lane.id, detail);
    queueProjectSupervisorRecovery(
      useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane,
      detail,
    );
    return { ok: false, error: detail };
  }

  return {
    ok: true,
    surfaceId: terminal.surfaceId,
    workspaceId: terminal.workspaceId,
    message: '任务终端已由 AI 监督在当前项目执行会话中创建；请结束当前回合，等待控制层发送正式监督协议。',
  };
}

async function rotateProjectTaskTerminalFromSupervisor(
  session: ProjectManagerSession,
  lane: SupervisorLane,
): Promise<Record<string, unknown>> {
  const failRotation = (error: string): Record<string, unknown> => {
    useStore.getState().updateLane(lane.id, {
      projectTaskRotationPending: false,
      projectTaskRotationSummary: undefined,
      projectTaskRotationRequestedAt: undefined,
    });
    return { ok: false, error };
  };
  const summary = String(lane.projectTaskRotationSummary || '').trim();
  if (!summary) return failRotation('当前没有待执行的任务终端轮换请求');
  const oldTerminal = locateRemoteTaskTerminal(lane.surfaceId).terminal;
  if (!oldTerminal) return failRotation('原任务终端已经不存在，不能执行安全轮换');
  const item = lane.projectWorkItemId
    ? session.workItems.find((candidate) => candidate.id === lane.projectWorkItemId)
    : undefined;
  if (!item || item.supervisorLaneId !== lane.id) {
    return failRotation('工作项与当前 AI 监督绑定不一致，不能轮换任务终端');
  }
  if (session.status !== 'active'
    || projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)) {
    return failRotation('项目处于暂停、等待或需求未接受状态，不能轮换任务终端');
  }
  const rotationRequirementsVersion = projectRequirementsVersion(session);

  const store = useStore.getState();
  const taskDefaults = projectTaskTerminalDefaults(store.workspacePrefs.projectManagementAgents);
  const executionWorkspaceId = projectExecutionWorkspaceId(lane);
  if (!executionWorkspaceId) {
    return failRotation('项目专属监督不在有效的项目执行会话中，不能轮换任务终端');
  }
  const created = createRemoteDirectTerminalTask({
    action: 'create-task',
    name: `${item.title || '项目任务'} · 续作`,
    task: [
      '[项目任务上下文恢复]',
      `项目目标：${session.goal}`,
      `当前任务：${item.contract.objective || lane.currentTask || '继续项目任务'}`,
      '以下总结由原 AI 监督提供；先核对工作区现状，再继续执行，不要从头重复已经完成的步骤。',
      summary,
    ].join('\n'),
    agent: taskDefaults.agent,
    model: taskDefaults.model,
    reasoningEffort: taskDefaults.reasoningEffort,
    cwd: oldTerminal.cwd || session.projectDir,
    anchorWorkspace: executionWorkspaceId,
    projectManagerProjectId: session.id,
    projectManagerWorkItemId: item.id,
    actor: `project-supervisor:${lane.id}`,
  }, true);
  if (!created.ok || !created.surfaceId) {
    return failRotation(String(created.error || '新任务终端创建失败'));
  }
  const replacement = locateRemoteTaskTerminal(created.surfaceId).terminal;
  if (!replacement) {
    closeLiveSurfaceById(created.surfaceId as SurfaceId);
    return failRotation('新任务终端已创建但无法完成绑定；原任务终端保持不变');
  }
  const runtimeReady = await waitForTerminalRuntimeReady(replacement.surfaceId);
  if (!runtimeReady.ok) {
    closeLiveSurfaceById(replacement.surfaceId);
    return failRotation(`新任务终端未就绪，原任务终端保持不变：${runtimeReady.error || '未知错误'}`);
  }
  const currentRotationLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id);
  const currentRotationProject = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  const currentRotationItem = currentRotationProject?.workItems.find((candidate) => candidate.id === item.id);
  if (
    !currentRotationLane?.projectTaskRotationPending
    || currentRotationLane.surfaceId !== oldTerminal.surfaceId
    || currentRotationLane.supervisorSurfaceId !== lane.supervisorSurfaceId
    || supervisorLaneControlState(currentRotationLane) !== 'active'
    || currentRotationProject?.status !== 'active'
    || projectRequirementsVersion(currentRotationProject) !== rotationRequirementsVersion
    || projectAcceptedRequirementsVersion(currentRotationProject) !== rotationRequirementsVersion
    || currentRotationItem?.supervisorLaneId !== lane.id
  ) {
    closeLiveSurfaceById(replacement.surfaceId);
    return failRotation('轮换期间项目状态、需求版本或监督绑定已变化；新终端已关闭，原终端保持不变');
  }

  store.updateLane(lane.id, {
    surfaceId: replacement.surfaceId,
    label: replacement.label,
    paneId: replacement.paneId,
    workspaceId: replacement.workspaceId,
    workspaceTitle: replacement.workspaceTitle,
    projectDir: replacement.projectDir,
    scopeRoot: session.projectDir,
    currentTask: item.contract.objective || lane.currentTask,
    projectTaskContractPending: true,
    unreportedIdleRecoveryAttempts: 0,
    permissionConfirmations: [],
    projectTaskRotationPending: false,
    projectTaskRotationSummary: undefined,
    projectTaskRotationRequestedAt: undefined,
  });
  store.applyProjectManagerAction({
    type: 'update-work-item',
    workItemId: item.id,
    patch: { workerSurfaceId: replacement.surfaceId, latestContextSummary: summary },
  }, session.id);
  const latestSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
  store.restoreProjectManager({
    ...latestSession,
    taskTerminalSurfaceId: replacement.surfaceId,
    updatedAt: Date.now(),
  });
  store.closeSurface(oldTerminal.workspaceId, oldTerminal.paneId, oldTerminal.surfaceId);
  const event = store.appendProjectManagerEvent({
    kind: 'terminal-rotated',
    workItemId: item.id,
    summary: `AI 监督已安全轮换任务终端：${oldTerminal.surfaceId} → ${replacement.surfaceId}`,
    payload: { oldSurfaceId: oldTerminal.surfaceId, newSurfaceId: replacement.surfaceId, summary },
  }, session.id);
  const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  await (window as any).wmux?.projectManager?.saveSession?.(updated);
  if (event) {
    await (window as any).wmux?.projectManager?.appendRecord?.({
      sessionId: session.id,
      projectDir: session.projectDir,
      type: event.kind,
      payload: { message: event.summary, ...(event.payload || {}) },
    });
  }
  let notificationWarning: string | undefined;
  if (lane.supervisorSurfaceId) {
    try {
      await sendToSurfaceReliably(lane.supervisorSurfaceId, [
        '[任务终端已轮换]',
        `新任务终端：${replacement.surfaceId}`,
        '你继续担任该项目的 AI 监督。先核对新终端已收到恢复总结，再按原任务契约继续监督。',
      ].join('\n'), true);
    } catch (error) {
      notificationWarning = `任务终端已轮换，但无法通知 AI 监督：${String((error as Error)?.message || error)}`;
      store.pauseSupervisorLane(lane.id, notificationWarning);
      queueProjectSupervisorRecovery(
        useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane,
        notificationWarning,
      );
      const failure = store.appendProjectManagerEvent({
        kind: 'supervisor-runtime-failed',
        workItemId: item.id,
        summary: notificationWarning,
        payload: { laneId: lane.id, supervisorSurfaceId: lane.supervisorSurfaceId },
      }, session.id);
      const failedSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
      await (window as any).wmux?.projectManager?.saveSession?.(failedSession);
      if (failure) {
        await (window as any).wmux?.projectManager?.appendRecord?.({
          sessionId: session.id,
          projectDir: session.projectDir,
          type: failure.kind,
          payload: { message: failure.summary, ...(failure.payload || {}) },
        });
      }
    }
  }
  return {
    ok: true,
    oldSurfaceId: oldTerminal.surfaceId,
    surfaceId: replacement.surfaceId,
    ...(notificationWarning ? { warning: notificationWarning } : {}),
    message: notificationWarning || '任务终端已由对应 AI 监督安全轮换并保留上下文',
  };
}

async function handleProjectManagerRequest(params: any): Promise<any> {
  const action = String(params?.action || '');
  let store = useStore.getState();
  let session = projectSessionForParams(params);
  const callerSurfaceId = String(params?.callerSurfaceId || '');
  const startupLane = action === 'task-terminal-start'
    ? pendingProjectTaskStartupLane(callerSurfaceId, params)
    : undefined;
  const rotationLane = action === 'task-terminal-rotate'
    ? pendingProjectTaskRotationLane(callerSurfaceId, params)
    : undefined;
  const boundRotationCallerLane = action === 'task-terminal-rotate' && !rotationLane
    ? store.supervisor.lanes.find((lane) => (
        lane.supervisorSurfaceId === callerSurfaceId
        && lane.projectManagerProjectId === String(params?.projectId || '').trim()
        && lane.projectWorkItemId === String(params?.workItemId || '').trim()
        && supervisorLaneControlState(lane) !== 'stopped'
      ))
    : undefined;
  const controlLane = action === 'task-terminal-control'
    ? projectTaskControlLane(callerSurfaceId, params)
    : undefined;
  if (boundRotationCallerLane) {
    return {
      ok: false,
      error: supervisorLaneControlState(boundRotationCallerLane) === 'waiting'
        ? '当前监督已经完成阶段交接并处于待续；普通下一阶段会由项目 AI 通过 supervise 原地恢复同一监督和任务终端，无需轮换。只有上下文确实过长且项目 AI 已提交 terminal-rotate 请求时才执行轮换。'
        : '当前没有项目 AI 已登记的任务终端轮换请求；监督 AI 不能把普通续作当作上下文轮换。请继续阶段合同，或在上下文确实过长时先向项目 AI 提交结构化恢复总结。',
    };
  }
  if (!projectManagerCallerAllowed(callerSurfaceId, session) && !startupLane && !rotationLane && !controlLane) {
    return { ok: false, error: '项目管理命令只能由项目管理 AI 运行时执行' };
  }
  const correlationId = String(params?.correlationId || '').trim();
  const correlatedProjects = action === 'reply' && correlationId
    ? store.projectManagers.filter((project) => project.events.some((event) => (
        event.kind === 'user-message' && event.correlationId === correlationId
      )))
    : [];
  const uniquelyCorrelatedReply = action === 'reply'
    && !String(params?.projectId || '').trim()
    && correlatedProjects.length === 1
    && correlatedProjects[0].id === session?.id;
  if (projectCommandNeedsExplicitId(
    action,
    String(params?.projectId || ''),
    store.projectManagers,
  ) && !uniquelyCorrelatedReply) {
    return { ok: false, error: '存在多个项目，该项目动作必须显式指定 --project <id>' };
  }
  if (action === 'status') return {
    ok: true,
    session: session ? projectManagerSessionView(session) : null,
    projects: session ? [projectManagerSessionView(session)] : [],
  };
  if (action === 'logs') return { ok: true, events: session?.events.slice(-100).reverse() || [] };
  if (action === 'pause-all' || action === 'resume-all') {
    return { ok: false, error: '批量暂停或恢复属于无决策权的项目中心，单项目 AI 无权控制其他项目' };
  }

  store = useStore.getState();
  session = projectSessionForParams(params);
  if (!session) return { ok: false, error: '当前没有项目管理会话' };
  if (action === 'progress-sync') {
    if (params?.acknowledge === true) {
      return acknowledgeProjectProgress(session.id, String(params?.summary || ''));
    }
    const result = await scanProjectProgressForReview(session.id, '项目 AI 主动刷新项目进度');
    return {
      ok: result.ok,
      reviewRequired: result.reviewRequired,
      summary: result.summary,
      ...(result.error ? { error: result.error } : {}),
    };
  }
  if (action === 'transition-ack') {
    const transitionId = String(params?.transitionId || params?.transition || '').trim();
    const resolution = String(params?.resolution || '').trim();
    const summary = String(params?.summary || '').trim().slice(0, 4000);
    const allowedResolutions = new Set(['continued', 'accepted', 'replanned', 'paused', 'escalated', 'recovered']);
    if (!transitionId) return { ok: false, error: '监督状态交接回执必须指定 --transition' };
    if (!allowedResolutions.has(resolution)) {
      return { ok: false, error: '无效 resolution；可用值：continued、accepted、replanned、paused、escalated、recovered' };
    }
    if (!summary) return { ok: false, error: '监督状态交接回执必须用 --summary 说明处理结果和新方向' };
    const transition = (session.pendingSupervisorTransitions || [])
      .find((candidate) => candidate.id === transitionId);
    if (!transition) return { ok: false, error: '该监督状态交接已处理或不存在；请刷新 project status' };
    const resolutionError = projectTransitionResolutionError(session, transition, resolution);
    if (resolutionError) return { ok: false, error: resolutionError };
    for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
      const delivery = pendingProjectManagerDeliveries[index];
      if (delivery.sessionId === session.id && delivery.transitionId === transition.id) {
        pendingProjectManagerDeliveries.splice(index, 1);
      }
    }
    replaceProjectManagerSession({
      ...session,
      pendingSupervisorTransitions: (session.pendingSupervisorTransitions || [])
        .filter((candidate) => candidate.id !== transition.id),
      pendingManagerDeliveries: (session.pendingManagerDeliveries || [])
        .filter((delivery) => delivery.transitionId !== transition.id),
      updatedAt: Date.now(),
    });
    store.appendProjectManagerEvent({
      kind: 'supervisor-transition-acknowledged',
      workItemId: transition.workItemId,
      summary: `项目 AI 已处理监督状态交接：${summary}`,
      payload: {
        transitionId: transition.id,
        laneId: transition.laneId,
        transitionKind: transition.kind,
        resolution,
      },
    }, session.id);
    saveProjectManagerSnapshot(session.id);
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
    if (current?.status === 'active') scheduleProjectProgressCheck(session.id);
    return { ok: true, transitionId: transition.id, resolution };
  }
  if (action === 'task-terminal-start') {
    if (!startupLane) return { ok: false, error: '只有该工作项的新建 AI 监督可以启动任务终端' };
    return startProjectTaskTerminalFromSupervisor(session, startupLane);
  }
  if (action === 'task-terminal-rotate') {
    if (!rotationLane) return { ok: false, error: '只有该工作项绑定的 AI 监督可以执行任务终端轮换' };
    return rotateProjectTaskTerminalFromSupervisor(session, rotationLane);
  }
  if (action === 'task-terminal-control') {
    if (!controlLane) return { ok: false, error: '只有该工作项绑定的 AI 监督可以执行任务终端活性控制' };
    if (controlLane.remoteSshControl) {
      return { ok: false, error: 'SSH 远程控制任务禁止监督 AI 自动发送中断键，必须交给用户处理' };
    }
    const control = String(params?.control || '').trim();
    const reason = String(params?.reason || '').trim().slice(0, 1000);
    if (control !== 'escape' && control !== 'interrupt') {
      return { ok: false, error: '任务终端活性控制只允许 escape 或 interrupt' };
    }
    if (!reason) return { ok: false, error: '任务终端活性控制必须提供当前只读观察依据' };
    const activity = remoteTerminalActivity(controlLane.surfaceId, true);
    if (activity.activityState !== 'working') {
      return {
        ok: false,
        error: `任务 AI 当前为 ${activity.activityState}，禁止发送${control === 'escape' ? ' Esc' : ' Ctrl+C'}；请直接处理空闲/阻塞状态`,
      };
    }
    if (control === 'interrupt') {
      const recentEscape = [...session.events].reverse().find((event) => (
        event.kind === 'guard-triggered'
        && event.workItemId === controlLane.projectWorkItemId
        && event.payload?.action === 'task-ai-escape'
        && Date.now() - event.ts <= 10 * 60_000
      ));
      if (!recentEscape) {
        return { ok: false, error: '任务 AI 尚未执行过近期 Esc 软中断；必须先发送一次 Esc、重新只读检查，仍无响应后才能 Ctrl+C' };
      }
      const observationMs = Date.now() - recentEscape.ts;
      if (observationMs < PROJECT_TASK_CONTROL_ESC_GRACE_MS) {
        return {
          ok: false,
          error: `Esc 后观察时间不足；至少等待 ${Math.ceil((PROJECT_TASK_CONTROL_ESC_GRACE_MS - observationMs) / 1000)} 秒并重新只读检查，才能升级 Ctrl+C`,
        };
      }
      const screenBeforeEscape = String(recentEscape.payload?.workerScreenFingerprint || '');
      const currentScreen = projectTaskScreenFingerprint(controlLane);
      if (!screenBeforeEscape || currentScreen !== screenBeforeEscape) {
        return { ok: false, error: 'Esc 后任务终端出现了新的语义输出或缺少可比较的旧指纹，已拒绝 Ctrl+C；请重新只读检查并按当前状态裁决' };
      }
    }
    const screenBeforeControl = projectTaskScreenFingerprint(controlLane);
    const accepted = await writeProjectSupervisorControl(
      controlLane.surfaceId,
      control === 'escape' ? '\x1b' : '\x03',
    );
    if (!accepted) return { ok: false, error: `任务终端未接受${control === 'escape' ? ' Esc' : ' Ctrl+C'}` };
    const summary = `专属监督基于只读观察向任务 AI 发送了一次${control === 'escape' ? ' Esc 软中断' : ' Ctrl+C 硬中断'}：${reason}`;
    const event = store.appendProjectManagerEvent({
      kind: 'guard-triggered',
      workItemId: controlLane.projectWorkItemId,
      summary,
      payload: {
        laneId: controlLane.id,
        supervisorSurfaceId: controlLane.supervisorSurfaceId,
        workerSurfaceId: controlLane.surfaceId,
        action: control === 'escape' ? 'task-ai-escape' : 'task-ai-interrupt',
        ...(control === 'escape' ? { workerScreenFingerprint: screenBeforeControl } : {}),
      },
    }, session.id);
    saveProjectManagerSnapshot(session.id);
    queueProjectManagerDelivery([
      '[任务 AI 活性控制]',
      `项目：${session.id} · ${session.projectDir}`,
      `任务：${controlLane.projectWorkItemId || '未绑定'}`,
      summary,
      control === 'escape'
        ? '这是一次软中断；监督 AI 会重新检查，仍为 working 且没有语义进展时才允许升级 Ctrl+C。项目 AI 不要重复发送进度请求。'
        : '硬中断已记录；等待任务终端生命周期事件和监督裁决，不要绕过监督直接派送下一步。',
    ].join('\n'), session.id);
    if (event) {
      await (window as any).wmux?.projectManager?.appendRecord?.({
        sessionId: session.id,
        projectDir: session.projectDir,
        type: event.kind,
        payload: { message: event.summary, ...(event.payload || {}) },
      });
    }
    return {
      ok: true,
      control,
      activity,
      message: `已向任务 AI 发送一次${control === 'escape' ? ' Esc' : ' Ctrl+C'}并同步项目 AI`,
    };
  }
  if (!callerSurfaceId || callerSurfaceId !== session.managerSurfaceId) {
    return { ok: false, error: '该动作只能由当前项目管理 AI 执行' };
  }
  if (action === 'user-question') {
    if (['completed', 'stopped'].includes(session.status)) {
      return { ok: false, error: `项目管理会话已${session.status === 'completed' ? '完成' : '停止'}，不能再向用户提问` };
    }
    const normalized = normalizeProjectManagerUserQuestion(params, session.status);
    if (!normalized.question) return { ok: false, error: normalized.error };
    if (!projectRequirementsAlignmentPending(session) && normalized.question.category !== 'manual-intervention') {
      return { ok: false, error: '项目执行中仅在无法由项目管理 AI 处理、需要人工操作或越权授权时才能提问；请使用 category=manual-intervention' };
    }
    if (!projectRequirementsAlignmentPending(session) && (
      !normalized.question.workItemId
      || !normalized.question.blocker
      || !normalized.question.reasonCode
    )) {
      return {
        ok: false,
        error: '执行阶段的人工介入必须提供 workItemId、blocker 和有效 reasonCode，不能把普通技术问题转交用户',
      };
    }
    if (normalized.question.workItemId && !session.workItems.some((item) => item.id === normalized.question?.workItemId)) {
      return { ok: false, error: `任务不存在：${normalized.question.workItemId}` };
    }
    const owningWorkItem = normalized.question.workItemId
      ? session.workItems.find((item) => item.id === normalized.question?.workItemId)
      : undefined;
    if (owningWorkItem && ['completed', 'stopped'].includes(owningWorkItem.status)) {
      return { ok: false, error: '已完成或停止的任务不能再发起人工介入' };
    }
    const result = store.applyProjectManagerAction({
      type: 'request-user-clarification',
      question: normalized.question,
    }, session.id);
    if (!result.ok) return result;
    for (const laneId of projectSupervisorLaneIds(session)) {
      store.pauseSupervisorLane(laneId, '项目等待用户澄清关键需求');
    }
    const timer = projectProgressTimers.get(session.id);
    if (timer) globalThis.clearTimeout(timer);
    projectProgressTimers.delete(session.id);
    store.selectProjectManager(session.id);
    store.openProjectManagerDialog();
    await persistProjectManagerMutation(result, session.id);
    notifyProjectManagerUserQuestion(session, normalized.question);
    return {
      ok: true,
      question: normalized.question,
      message: '已暂停该项目并向用户发送澄清问题；其他项目继续运行。',
    };
  }
  if (['completed', 'stopped'].includes(session.status) && !['reply'].includes(action)) {
    return { ok: false, error: `项目管理会话已${session.status === 'completed' ? '完成' : '停止'}，不能再执行该动作` };
  }
  if (session.pendingUserQuestion && !['reply'].includes(action)) {
    return { ok: false, error: `项目正在等待用户答复：${session.pendingUserQuestion.question}` };
  }
  if (action === 'orientation-confirm') {
    return acknowledgeProjectOrientation(session.id, params?.orientation || params);
  }
  if (action === 'alignment-confirm') {
    if (!projectRequirementsAlignmentPending(session)) {
      return { ok: false, error: '该项目当前没有待完成的首次需求充分性检测' };
    }
    if (projectRequirementAlignmentState(session) === 'needs-definition-update') {
      return { ok: false, error: `用户变更尚未写回项目定义；请先执行 wmux project update --project ${session.id}` };
    }
    if (session.preconditions.length === 0 || session.doneWhen.length === 0) {
      return {
        ok: false,
        error: `项目定义仍有空白项；请先起草前置条件和可验证完成条件，并执行 wmux project update --project ${session.id} 写回。仅在存在实质歧义时向用户提问。`,
      };
    }
    const assessment = params?.assessment || params;
    const result = store.applyProjectManagerAction({
      type: 'confirm-requirements-alignment',
      goalUnderstanding: String(assessment?.goalUnderstanding || ''),
      scopeSummary: String(assessment?.scopeSummary || ''),
      acceptanceSummary: String(assessment?.acceptanceSummary || ''),
      reason: String(assessment?.reason || ''),
    }, session.id);
    if (!result.ok) return result;
    const timer = projectAlignmentTimers.get(session.id);
    if (timer) globalThis.clearTimeout(timer);
    projectAlignmentTimers.delete(session.id);
    await persistProjectManagerMutation(result, session.id);
    return {
      ok: true,
      event: result.event,
      message: '首次需求充分性检测已记录；请根据规划显式恢复项目后再创建任务链。',
    };
  }
  if (['goal-plan', 'task-create', 'task-supervise', 'complete'].includes(action)) {
    const alignment = await ensureProjectRequirementAlignment(session.id, `项目管理 AI 尝试在需求未充分对齐时执行 ${action}`);
    if (alignment.triggered || alignment.alignmentRequired || alignment.awaitingDefinitionUpdate) {
      return {
        ok: false,
        error: alignment.awaitingDefinitionUpdate
          ? `用户答复尚未写回项目定义；请先执行 wmux project update --project ${session.id}`
          : alignment.alignmentRequired
            ? `项目尚未提交首次需求充分性结论；请先执行 wmux project alignment-confirm --project ${session.id}，需求不足则执行 wmux project ask --project ${session.id}`
            : '项目需求尚未充分对齐；控制层已向桌面和飞书发送带推荐项的问题',
        question: alignment.question,
      };
    }
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
    const orientationError = projectOrientationReviewError(current);
    if (orientationError) return { ok: false, error: orientationError };
  }

  if (action === 'update-definition') {
    return updateProjectDefinition(session, params, 'manager');
  }

  if (action === 'goal-plan') {
    const normalized = normalizeProjectSubgoalsInput(params?.subgoals, session);
    if (!normalized.subgoals) return { ok: false, error: normalized.error };
    return persistProjectManagerMutation(store.applyProjectManagerAction({
      type: 'set-project-subgoals',
      subgoals: normalized.subgoals,
      reason: String(params?.reason || '').trim().slice(0, 2000),
      source: 'manager',
    }, session.id), session.id);
  }

  if (action === 'terminals') {
    return {
      ok: true,
      terminals: remoteTerminalList()
        .filter((terminal) => terminal.surface.projectManagerProjectId === session.id)
        .map((terminal) => ({
          surfaceId: terminal.surfaceId,
          label: terminal.label,
          workspaceId: terminal.workspaceId,
          workspace: terminal.workspaceTitle,
          cwd: terminal.cwd,
          ...remoteTerminalActivity(terminal.surfaceId),
        })),
    };
  }
  if (action === 'supervisor-inspect') {
    const lane = useStore.getState().supervisor.lanes.find((candidate) => (
      candidate.projectManagerProjectId === session.id && supervisorLaneControlState(candidate) !== 'stopped'
    ));
    if (!lane?.supervisorSurfaceId) return { ok: false, error: '该项目当前没有可检查的 AI 监督' };
    const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane)!;
    const supervisorActivity = remoteTerminalActivity(supervisorSurfaceId, true);
    const activity = remoteTerminalActivity(lane.surfaceId, true);
    const watchdog = managedAgentWatchdogs.get(supervisorSurfaceId);
    return {
      ok: true,
      laneId: lane.id,
      terminal: activity,
      supervisor: supervisorActivity,
      watchdog: watchdog ? {
        phase: watchdog.phase,
        turnStartedAt: watchdog.turnStartedAt,
        lastLivenessAt: watchdog.lastLivenessAt,
        lastSemanticProgressAt: watchdog.lastSemanticProgressAt,
        softDeadlineAt: watchdog.softDeadlineAt,
        hardDeadlineAt: watchdog.hardDeadlineAt,
      } : null,
      message: '已只读返回监督与任务终端状态；未向任何 Agent 发送活性探测消息。',
    };
  }
  if (action === 'supervisor-decide') {
    const approvalId = String(params?.approvalId || '').trim();
    const decision = String(params?.decision || '');
    if (!approvalId || !['approve', 'direct', 'pause', 'stop'].includes(decision)) {
      return { ok: false, error: '必须提供有效 approvalId 和 decision' };
    }
    const approval = useStore.getState().supervisor.pendingApprovals.find((candidate) => candidate.id === approvalId);
    const lane = approval && useStore.getState().supervisor.lanes.find((candidate) => candidate.id === approval.laneId);
    if (!approval || lane?.projectManagerProjectId !== session.id) {
      return { ok: false, error: '该待决项不属于指定项目或已经失效' };
    }
    if (decision === 'approve' || decision === 'direct') {
      if (session.status !== 'active') return { ok: false, error: '项目未处于活动状态，只能暂停或停止旧待决项' };
      if (projectRequirementsAlignmentPending(session)
        || projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)) {
        return { ok: false, error: '当前需求尚未重新对齐，只能暂停或停止旧待决项' };
      }
      const reviewError = projectProgressReviewError(session) || projectOrientationReviewError(session);
      if (reviewError) return { ok: false, error: reviewError };
    }
    const result = decideRemoteSupervisor(
      approvalId,
      decision as 'approve' | 'direct' | 'pause' | 'stop',
      String(params?.selection || ''),
      String(params?.task || ''),
      `project-manager:${session.id}`,
      session.id,
    );
    if (result.ok && lane.projectWorkItemId) {
      store.applyProjectManagerAction({
        type: 'update-work-item',
        workItemId: lane.projectWorkItemId,
        patch: decision === 'pause'
          ? { status: 'paused' }
          : decision === 'stop'
            ? { status: 'stopped' }
            : { status: 'running', latestBlocker: undefined },
      }, session.id);
    }
    store.appendProjectManagerEvent({
      kind: 'supervisor-direction', workItemId: lane.projectWorkItemId,
      summary: `项目管理 AI 处理监督待决项：${decision} · ${result.message || result.error || ''}`,
      payload: { approvalId, decision, ok: result.ok },
    }, session.id);
    saveProjectManagerSnapshot(session.id);
    return result;
  }
  if (action === 'terminal-rotate') {
    const summary = String(params?.summary || '').trim().slice(0, 12000);
    if (!summary) return { ok: false, error: '轮换任务终端必须提供可恢复的上下文总结' };
    const lane = useStore.getState().supervisor.lanes.find((candidate) => (
      candidate.projectManagerProjectId === session.id && supervisorLaneControlState(candidate) !== 'stopped'
    ));
    if (!lane) return { ok: false, error: '该项目当前没有可轮换的任务终端' };
    if (!lane.supervisorSurfaceId || !lane.projectWorkItemId) {
      return { ok: false, error: '当前监督链缺少专属 AI 监督或工作项绑定，不能轮换任务终端' };
    }
    if (lane.projectTaskStartupPending) {
      return { ok: false, error: 'AI 监督尚未完成首次任务终端创建，不能发起上下文轮换' };
    }
    if (lane.projectTaskRotationPending) {
      const requestedAt = Number(lane.projectTaskRotationRequestedAt || 0);
      if (requestedAt > 0 && Date.now() - requestedAt < PROJECT_TASK_ROTATION_REQUEST_TTL_MS) {
        return { ok: false, error: '该 AI 监督已有待执行的任务终端轮换请求' };
      }
      store.updateLane(lane.id, {
        projectTaskRotationPending: false,
        projectTaskRotationSummary: undefined,
        projectTaskRotationRequestedAt: undefined,
      });
    }
    store.updateLane(lane.id, {
      projectTaskRotationPending: true,
      projectTaskRotationSummary: summary,
      projectTaskRotationRequestedAt: Date.now(),
    });
    try {
      await sendToSurfaceReliably(lane.supervisorSurfaceId, [
        '[项目管理 AI 请求安全轮换任务终端]',
        `项目：${session.id}`,
        `工作项：${lane.projectWorkItemId}`,
        '轮换上下文已由控制层暂存。请核对当前任务已处于可交接点，然后执行：',
        `wmux project task-terminal-rotate --project ${session.id} --task ${lane.projectWorkItemId}`,
        '只能由你这个已绑定的 AI 监督执行；新终端确认就绪前，控制层不会关闭原任务终端。',
      ].join('\n'), true);
    } catch (error) {
      store.updateLane(lane.id, {
        projectTaskRotationPending: false,
        projectTaskRotationSummary: undefined,
        projectTaskRotationRequestedAt: undefined,
      });
      return { ok: false, error: `无法把轮换请求交给对应 AI 监督：${String((error as Error)?.message || error)}` };
    }
    const event = store.appendProjectManagerEvent({
      kind: 'supervisor-direction',
      workItemId: lane.projectWorkItemId,
      summary: '项目管理 AI 已请求对应 AI 监督执行安全任务终端轮换',
      payload: { laneId: lane.id, supervisorSurfaceId: lane.supervisorSurfaceId },
    }, session.id);
    const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
    await (window as any).wmux?.projectManager?.saveSession?.(updated);
    if (event) {
      await (window as any).wmux?.projectManager?.appendRecord?.({
        sessionId: session.id,
        projectDir: session.projectDir,
        type: event.kind,
        payload: { message: event.summary, ...(event.payload || {}) },
      });
    }
    return { ok: true, pending: true, laneId: lane.id, message: '轮换请求已交给对应 AI 监督；原任务终端将在新终端就绪后关闭。' };
  }

  if (action === 'task-create' || action === 'task-supervise' || action === 'complete') {
    const projectId = session.id;
    const activeExecution = useStore.getState().supervisor.lanes.some((lane) => (
      lane.projectManagerProjectId === projectId && supervisorLaneControlState(lane) === 'active'
    ));
    // An active owned chain is expected to mutate the worktree. Its changes are
    // checkpointed at stage handoff; treating them as external here would
    // invalidate a live baseline merely because the manager retried a command.
    if (!activeExecution) {
      const progress = await scanProjectProgressForReview(
        projectId,
        action === 'task-create'
          ? '创建阶段工作项前检查项目现状'
          : action === 'complete'
            ? '主目标验收前检查项目现状'
            : '派发或续接监督前检查项目现状',
      );
      const progressSession = useStore.getState().projectManagers.find((candidate) => candidate.id === projectId) || session;
      const reviewError = projectProgressReviewError(progressSession);
      if (!progress.ok || reviewError) {
        return { ok: false, error: reviewError || progress.error || '项目进度同步失败，不能派发旧任务' };
      }
    }
  }
  if (action === 'task-create') {
    if ((params?.workItem || params)?.baseline !== undefined
      || (params?.workItem || params)?.supervisorPlan !== undefined
      || (params?.workItem || params)?.executionProtocolVersion !== undefined) {
      return { ok: false, error: '执行协议版本、项目基线和阶段执行计划由控制层及专属监督维护，项目 AI 不能在任务定义中提供' };
    }
    const normalized = normalizeProjectWorkItemInput(params?.workItem || params, session.projectDir, undefined, true, session);
    if (!normalized.workItem) return { ok: false, error: normalized.error };
    if (['validating', 'completed'].includes(normalized.workItem.status)) {
      return { ok: false, error: '新任务必须先经过项目基线调查和监督执行，不能直接创建为验证中或已完成' };
    }
    if (
      String((params?.workItem || params)?.workerSurfaceId || '').trim()
      || String((params?.workItem || params)?.supervisorLaneId || '').trim()
    ) {
      return { ok: false, error: '项目工作项不能指定现有终端或监督通道；运行时绑定只能由控制层创建' };
    }
    return persistProjectManagerMutation(
      store.applyProjectManagerAction({ type: 'create-work-item', workItem: normalized.workItem }, session.id),
      session.id,
    );
  }
  if (action === 'task-update') {
    const workItemId = String(params?.workItemId || params?.id || '').trim();
    const previous = session.workItems.find((item) => item.id === workItemId);
    if (!previous) return { ok: false, error: `任务不存在：${workItemId}` };
    const requestedPatch = params?.patch || params;
    if (requestedPatch?.workerSurfaceId !== undefined
      || requestedPatch?.supervisorLaneId !== undefined
      || requestedPatch?.baseline !== undefined
      || requestedPatch?.supervisorPlan !== undefined
      || requestedPatch?.supervisorPlanRequired !== undefined
      || requestedPatch?.executionProtocolVersion !== undefined) {
      return { ok: false, error: '任务终端和监督通道绑定由控制层维护；执行协议版本和项目基线状态由控制层维护；阶段执行计划由专属监督维护，项目管理 AI 不能修改' };
    }
    const normalized = normalizeProjectWorkItemInput(
      { ...previous, ...requestedPatch, id: workItemId },
      session.projectDir,
      previous,
      requestedPatch?.contract !== undefined,
      session,
    );
    if (!normalized.workItem) return { ok: false, error: normalized.error };
    if ((previous.executionProtocolVersion || 0) < CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION
      && requestedPatch?.contract !== undefined
      && ['validating', 'completed'].includes(normalized.workItem.status)) {
      return {
        ok: false,
        error: '旧执行协议迁移必须回到 planned、waiting-decision 或 paused 等非完成状态，重新建立项目基线和监督阶段计划后才能验证或完成',
      };
    }
    if (['validating', 'completed'].includes(normalized.workItem.status)
      && !projectTaskBaselineApproved(previous)) {
      return { ok: false, error: '项目基线尚未由监督 AI 审核，项目 AI 不能直接把任务标记为验证中或已完成' };
    }
    if (normalized.workItem.status === 'completed' && !normalized.workItem.latestEvidence) {
      return { ok: false, error: '任务完成状态必须附带可复核的 latestEvidence' };
    }
    if (normalized.workItem.status === 'completed' && normalized.workItem.latestBlocker) {
      return {
        ok: false,
        error: `任务仍有 latestBlocker，不能标记完成。若确实需要用户介入，请先用 wmux project ask --project ${session.id} 发起 manual-intervention；用户答复并处理后显式清空 latestBlocker。`,
      };
    }
    if (normalized.workItem.status === 'completed'
      && normalized.workItem.supervisorPlanRequired === true
      && (!previous.supervisorPlan
        || previous.supervisorPlan.milestones.some((milestone) => milestone.status !== 'completed')
        || previous.supervisorPlan.remainingWork.length > 0)) {
      return {
        ok: false,
        error: '监督阶段计划尚未完成；项目 AI 必须等待监督 AI 通过完整 complete 核对更新计划，不能直接把工作项标记为 completed',
      };
    }
    if (normalized.workItem.status === 'completed'
      && normalized.workItem.supervisorPlanRequired === true
      && previous.status !== 'validating') {
      return {
        ok: false,
        error: '工作项尚未收到监督 AI 的完整 complete 交接并进入 validating；项目 AI 不能绕过监督阶段验收直接完成',
      };
    }
    return persistProjectManagerMutation(
      store.applyProjectManagerAction({ type: 'update-work-item', workItemId, patch: normalized.workItem }, session.id),
      session.id,
    );
  }
  if (action === 'task-supervise') {
    const workItemId = String(params?.workItemId || '').trim();
    const item = session.workItems.find((candidate) => candidate.id === workItemId);
    if (!item) return { ok: false, error: `任务不存在：${workItemId}` };
    const activeGoal = activeProjectGoal(session);
    if (item.goalId !== activeGoal.id) return { ok: false, error: '旧主目标任务已失效，不能在当前目标下启动监督' };
    const subgoal = activeProjectSubgoals(session).find((candidate) => candidate.id === item.subgoalId);
    if (!subgoal || ['achieved', 'obsolete'].includes(subgoal.status)) {
      return { ok: false, error: '任务没有有效的当前阶段目标，必须由项目 AI 重新规划' };
    }
    const subgoalDependencyError = projectWorkItemSubgoalDependencyError(session, item);
    if (subgoalDependencyError) return { ok: false, error: subgoalDependencyError };
    if (session.status !== 'active') return { ok: false, error: '项目处于暂停或等待状态，不能启动新监督任务' };
    if (projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)) {
      return { ok: false, error: '项目管理 AI 尚未接受最新需求版本，完成重规划并显式恢复后才能启动监督' };
    }
    if (item.requirementsVersion !== projectRequirementsVersion(session)
      || item.authorizationVersion !== projectAuthorizationVersion(session)) {
      return {
        ok: false,
        error: `任务尚未显式重新绑定当前需求和授权版本（任务 v${item.requirementsVersion || 0}/a${item.authorizationVersion || 0}，当前 v${projectRequirementsVersion(session)}/a${projectAuthorizationVersion(session)}）；请更新任务并设置 rebindCurrentRequirements=true`,
      };
    }
    if ((item.executionProtocolVersion || 0) < CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION) {
      return {
        ok: false,
        error: `工作项执行协议 v${item.executionProtocolVersion || 0} 已过期；请先用 task-update 提交完整 contract，将其迁移到当前 v${CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION} 阶段执行协议`,
      };
    }
    if (['completed', 'stopped'].includes(item.status)) return { ok: false, error: '已完成或停止的任务不能再次启动监督' };
    const incompleteDependency = item.dependencies.find((id) => (
      session.workItems.find((candidate) => candidate.id === id)?.status !== 'completed'
    ));
    if (incompleteDependency) return { ok: false, error: `依赖任务尚未完成：${incompleteDependency}` };
    if (item.workerSurfaceId) {
      const boundWorker = locateRemoteTaskTerminal(item.workerSurfaceId).terminal;
      const recoverableBoundLane = useStore.getState().supervisor.lanes.some((lane) => (
        lane.projectManagerProjectId === session.id
        && lane.projectWorkItemId === item.id
        && supervisorLaneControlState(lane) !== 'stopped'
      ));
      if ((!boundWorker || boundWorker.surface.projectManagerProjectId !== session.id) && !recoverableBoundLane) {
        return { ok: false, error: '任务绑定不是当前项目自行创建的终端，不能启动监督' };
      }
    }
    const projectLanes = useStore.getState().supervisor.lanes.filter((lane) => (
      lane.projectManagerProjectId === session.id && supervisorLaneControlState(lane) !== 'stopped'
    ));
    if (projectLanes.length > 1) return { ok: false, error: '该项目存在多条活动监督链，必须先收敛为一条' };
    const execution = item.contract.execution || {
      taskWorkMode: 'single-thread' as const,
      modeReason: '未配置执行模式，按保守单线程执行',
      mainThreadResponsibility: item.contract.objective,
      childThreadResponsibilities: [],
    };
    const recoveryEvents = session.events
      .filter((event) => event.workItemId === item.id)
      .slice(-12)
      .map((event) => `${event.kind}：${event.summary}`);
    const recoveryContext = [
      item.latestEvidence ? `最近执行证据：${item.latestEvidence}` : '',
      item.latestContextSummary ? `最近终端上下文总结：${item.latestContextSummary}` : '',
      item.latestBlocker ? `最近阻塞：${item.latestBlocker}` : '',
      recoveryEvents.length > 0 ? `最近决策记录：\n${recoveryEvents.join('\n')}` : '',
    ].filter(Boolean).join('\n');
    const projectPreconditions = projectStringArray(session.preconditions);
    const supervisorNotes = mergeProjectRequirements(
      projectStringArray(session.supervisorNotes),
      projectStringArray(item.contract.supervisorNotes),
    ).join('\n');
    const contractBriefing = [
      projectPreconditions.length > 0
        ? `[项目级前置条件｜已确认且持续有效]\n${projectPreconditions.map((condition) => `- ${condition}`).join('\n')}\n这些条件由用户在当前需求版本中确认，既是已知事实，也是其中明确写出的操作授权；在用户未更新、且没有具体反证时，监督 AI 和任务 AI 必须持续沿用，不得每一步重新询问、重新授权或要求重复取证。若条件明确允许对同一设备执行运行、上电、测试或验证，可在合同范围和既定风险等级内连续推进。只有收到条件变更、发现明确冲突，或进入原条件未覆盖的新设备/环境/更高风险动作时才暂停并上报。任务 AI 自身再次询问不构成条件变化。`
        : '[项目级前置条件｜待核实]\n用户尚未声明额外条件。规划和执行前必须主动核实是否存在物理、环境、权限或资源约束；不确定时暂停并询问项目管理 AI。',
      buildProjectSupervisorBriefing({
        workItemId,
        contract: item.contract,
        baseline: item.baseline,
        supervisorPlan: item.supervisorPlan,
        executionIdentity: projectExecutionIdentity(session, item),
        projectGoal: session.goal,
        stage: {
          title: subgoal.title,
          outcome: subgoal.outcome,
          acceptance: subgoal.acceptance,
        },
      }),
      recoveryContext ? `[项目恢复上下文]\n${recoveryContext}\n不要重做已有证据支持的工作，先核对当前终端状态后继续。` : '',
    ].filter(Boolean).join('\n\n');
    const dispatchRequirementsVersion = projectRequirementsVersion(session);
    const dispatchAuthorizationVersion = projectAuthorizationVersion(session);
    const currentDispatchError = (laneId: string): string | null => {
      const current = useStore.getState();
      const freshProject = current.projectManagers.find((candidate) => candidate.id === session.id);
      const freshItem = freshProject?.workItems.find((candidate) => candidate.id === item.id);
      const freshLane = current.supervisor.lanes.find((candidate) => candidate.id === laneId);
      if (!freshProject || freshProject.status !== 'active') return '项目已不处于运行状态';
      if (projectRequirementsVersion(freshProject) !== dispatchRequirementsVersion
        || projectAcceptedRequirementsVersion(freshProject) !== dispatchRequirementsVersion
        || projectAuthorizationVersion(freshProject) !== dispatchAuthorizationVersion) {
        return '项目需求或授权版本已变化';
      }
      if (!freshItem
        || ['completed', 'stopped'].includes(freshItem.status)
        || freshItem.requirementsVersion !== dispatchRequirementsVersion
        || freshItem.authorizationVersion !== dispatchAuthorizationVersion) {
        return '工作项已结束或不再绑定本轮需求与授权';
      }
      if (!freshLane
        || supervisorLaneControlState(freshLane) !== 'active'
        || freshLane.projectManagerProjectId !== session.id
        || freshLane.projectWorkItemId !== item.id) {
        return '专属监督绑定或运行状态已变化';
      }
      return null;
    };
    const existingLane = projectLanes[0];
    if (existingLane) {
      if (existingLane.projectWorkItemId === item.id) {
        const supervisorRuntime = existingLane.supervisorSurfaceId
          ? terminalRuntimeStatus(existingLane.supervisorSurfaceId)
          : undefined;
        const supervisorExists = !!existingLane.supervisorSurfaceId
          && !!locateRemoteSupervisorTerminal(existingLane.supervisorSurfaceId).supervisorSurfaceId;
        const currentTaskRuntime = existingLane.projectTaskStartupPending
          ? undefined
          : terminalRuntimeStatus(existingLane.surfaceId);
        const currentTaskUnavailable = currentTaskRuntime?.state === 'failed'
          || currentTaskRuntime?.state === 'exited';
        const supervisorUnavailable = !supervisorExists
          || supervisorRuntime?.state === 'failed'
          || supervisorRuntime?.state === 'exited';
        if (supervisorUnavailable || currentTaskUnavailable) {
          const taskRuntime = existingLane.projectTaskStartupPending
            ? undefined
            : currentTaskRuntime;
          const taskTerminal = existingLane.projectTaskStartupPending
            ? undefined
            : locateRemoteTaskTerminal(existingLane.surfaceId).terminal;
          const taskUnavailable = existingLane.projectTaskStartupPending === true
            || !taskTerminal
            || taskRuntime?.state === 'failed'
            || taskRuntime?.state === 'exited';
          if (existingLane.supervisorSurfaceId) closeLiveSurfaceById(existingLane.supervisorSurfaceId);
          if (taskUnavailable && !existingLane.projectTaskStartupPending) {
            closeLiveSurfaceById(existingLane.surfaceId);
          }
          store.stopSupervisorLane(existingLane.id, '项目管理 AI 正在替换失效的专属监督链');
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: item.id,
            patch: {
              supervisorLaneId: undefined,
              ...(taskUnavailable ? { workerSurfaceId: undefined } : {}),
              ...(existingLane.projectTaskRotationSummary
                ? { latestContextSummary: existingLane.projectTaskRotationSummary }
                : {}),
            },
          }, session.id);
          if (taskUnavailable) {
            const currentProject = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
            if (currentProject) {
              store.restoreProjectManager({
                ...currentProject,
                taskTerminalSurfaceId: undefined,
                updatedAt: Date.now(),
              });
            }
          }
          saveProjectManagerSnapshot(session.id);
          return handleProjectManagerRequest(params);
        }
        const quiescenceError = await unresolvedProjectLaneQuiescenceError(session, existingLane);
        if (quiescenceError) return { ok: false, error: quiescenceError };
        const pendingApproval = useStore.getState().supervisor.pendingApprovals
          .find((approval) => approval.laneId === existingLane.id);
        if (pendingApproval) {
          return {
            ok: false,
            error: `该任务仍有待决项 ${pendingApproval.id}；请直接处理待决项，控制层会自动恢复对应监督通道`,
          };
        }
        const existingLaneState = supervisorLaneControlState(existingLane);
        if (existingLaneState === 'waiting' && item.status === 'validating') {
          return {
            ok: false,
            error: `监督已提交阶段完成证据，当前任务正在等待项目 AI 验收。证据不足时先把 ${item.id} 改回 running 并写明需要补足的阶段结果，再重新执行 supervise；证据充分时应标记 completed 并派发下一个完整阶段目标。`,
          };
        }
        if (existingLaneState === 'paused' || existingLaneState === 'waiting') {
          store.resumeSupervisorLane(
            existingLane.id,
            existingLaneState === 'waiting'
              ? '项目管理 AI 已验收交接并重新开放同一阶段目标'
              : '项目管理 AI 正在恢复同一任务的专属监督',
          );
          store.updateLane(existingLane.id, {
            currentTask: item.contract.objective,
            awaitingReview: false,
            awaitingStopCheck: false,
            stopConfirmed: false,
            projectTaskContractPending: true,
            unreportedIdleRecoveryAttempts: 0,
            autonomyPermissionsOverride: projectContractAutonomyPermissions(item.contract),
            permissionConfirmations: [],
            config: {
              ...effectiveSupervisorLaneConfig(existingLane),
              taskGoal: item.contract.objective,
              taskDescription: [item.contract.description, contractBriefing].filter(Boolean).join('\n\n'),
              preconditions: [...projectPreconditions, ...item.contract.preconditions].join('；'),
              supervisorNotes,
              stopWhen: item.contract.stopWhen.join('；'),
              stopWhenKind: 'concrete',
              waitForNextDirection: true,
              taskWorkMode: execution.taskWorkMode,
              mainThreadResponsibility: execution.mainThreadResponsibility,
              childThreadResponsibilities: execution.childThreadResponsibilities,
              maxChildThreads: execution.maxChildThreads,
              supervisorMayApproveThreads: execution.supervisorMayApproveThreads,
              parallelizableOperations: execution.parallelizableOperations,
              serializedOperations: execution.serializedOperations,
            },
          });
          const resumedSupervisor = useStore.getState().supervisor;
          const resumedLane = resumedSupervisor.lanes.find((lane) => lane.id === existingLane.id);
          if (!resumedLane?.supervisorSurfaceId) {
            return { ok: false, error: '专属监督恢复后绑定已经失效，请重新执行 supervise' };
          }
          try {
            await sendToSurfaceReliably(
              resumedLane.supervisorSurfaceId,
              [
                existingLaneState === 'waiting'
                  ? '[项目 AI 续接阶段目标｜同一专属监督原地恢复]'
                  : '[项目专属监督恢复｜重新核对当前状态]',
                existingLaneState === 'waiting'
                  ? '项目 AI 已处理上一轮阶段交接，并重新开放当前委派目标。请基于最新合同和已有证据自主拆解剩余工作；小里程碑继续使用 continue/rework，只有整个委派目标及验证条件满足后才再次 complete。普通续作无需轮换任务终端。'
                  : '',
                projectAwareSupervisorBriefing(
                  resumedSupervisor,
                  resumedLane,
                  String(((window as any).__wmux_getAgentStates?.() || {})[resumedLane.surfaceId]?.state || 'unknown'),
                ),
              ].filter(Boolean).join('\n\n'),
              true,
            );
          } catch (error) {
            const detail = `恢复专属监督时协议重投失败：${String((error as Error)?.message || error)}`;
            store.pauseSupervisorLane(existingLane.id, detail);
            queueProjectSupervisorRecovery(resumedLane, detail);
            return { ok: false, error: detail };
          }
          const staleDispatch = currentDispatchError(existingLane.id);
          if (staleDispatch) {
            store.pauseSupervisorLane(existingLane.id, `阶段目标续接期间${staleDispatch}`);
            return { ok: false, error: `阶段目标续接期间${staleDispatch}；已拒绝沿用旧合同继续` };
          }
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: item.id,
            // A higher-level Project AI decision starts a new continuous-time
            // window. Keep decision/retry counters intact so resume cannot
            // bypass the stage's finite autonomy budget.
            patch: { status: 'running', latestBlocker: undefined, startedAt: Date.now() },
          }, session.id);
          store.appendProjectManagerEvent({
            kind: 'supervisor-direction',
            workItemId: item.id,
            summary: existingLaneState === 'waiting'
              ? '项目 AI 已验收阶段交接并原地续接同一专属监督'
              : '项目 AI 已恢复同一任务的专属监督',
            payload: { laneId: existingLane.id, resumedFrom: existingLaneState },
          }, session.id);
          saveProjectManagerSnapshot(session.id);
          scheduleProjectProgressCheck(session.id);
          return {
            ok: true,
            recovered: true,
            resumedFromWaiting: existingLaneState === 'waiting',
            laneId: existingLane.id,
            message: existingLaneState === 'waiting'
              ? '已在同一会话中恢复专属监督，并交付重新开放的完整阶段目标'
              : '已恢复同一任务的专属监督，并重新投递当前任务协议',
          };
        }
        return { ok: false, error: '该任务已有正常运行的监督通道，不能重复启动' };
      }
      const previousItem = session.workItems.find((candidate) => candidate.id === existingLane.projectWorkItemId);
      const previousItemParked = previousItem?.status === 'paused';
      if (previousItem && !['completed', 'stopped', 'paused'].includes(previousItem.status)) {
        return { ok: false, error: '该项目上一项任务仍在执行或等待裁决；先完成它，或由项目 AI 明确暂缓为 paused 后再推进不依赖项' };
      }
      if (item.workerSurfaceId && existingLane.surfaceId !== item.workerSurfaceId) {
        return { ok: false, error: '每个项目只能使用一个任务终端；需要更换时请先执行终端上下文轮换' };
      }
      const reusableWorker = locateRemoteTaskTerminal(existingLane.surfaceId).terminal;
      if (!reusableWorker || reusableWorker.surface.projectManagerProjectId !== session.id) {
        return { ok: false, error: '项目原任务终端已经失效；请停止旧监督并建立新的监督链' };
      }
      if (previousItemParked) {
        const pendingApproval = useStore.getState().supervisor.pendingApprovals
          .find((approval) => approval.laneId === existingLane.id);
        if (pendingApproval) {
          return { ok: false, error: `暂缓工作项仍有待决项 ${pendingApproval.id}；请先处理该待决项，再切换到不依赖它的工作项` };
        }
        if ((existingLane.pendingSupervisorDeliveries || []).length > 0) {
          return { ok: false, error: '暂缓工作项仍有待投递的监督消息；等待消息处理完成后再切换工作项' };
        }
        const parkedWorkerActivity = remoteTerminalActivity(existingLane.surfaceId, true).activityState;
        if (parkedWorkerActivity !== 'idle') {
          return {
            ok: false,
            error: `暂缓工作项的任务 AI 当前为 ${parkedWorkerActivity}；只有明确空闲后才能在同一终端切换到其他工作项`,
          };
        }
      }
      const quiescenceError = await unresolvedProjectLaneQuiescenceError(session, existingLane);
      if (quiescenceError) return { ok: false, error: quiescenceError };
      if (previousItemParked && previousItem) {
        const parked = store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: previousItem.id,
          patch: { supervisorLaneId: undefined, workerSurfaceId: undefined },
        }, session.id);
        if (!parked.ok) return parked;
        const baselineReset = store.applyProjectManagerAction({
          type: 'reset-work-item-baseline',
          workItemId: previousItem.id,
          reason: `执行链切换到不依赖项 ${item.id}，后续续接必须核对届时工作树`,
        }, session.id);
        if (!baselineReset.ok) return baselineReset;
        store.appendProjectManagerEvent({
          kind: 'supervisor-direction',
          workItemId: previousItem.id,
          summary: `暂缓工作项并释放执行链，继续推进不依赖项：${previousItem.title}`,
          payload: { laneId: existingLane.id, nextWorkItemId: item.id },
        }, session.id);
      }
      if (supervisorLaneControlState(existingLane) === 'waiting' || supervisorLaneControlState(existingLane) === 'paused') {
        store.resumeSupervisorLane(
          existingLane.id,
          previousItemParked ? '项目管理 AI 已暂缓上一工作项并派发不依赖项' : '项目管理 AI 已派发下一项任务',
        );
      }
      const currentLane = useStore.getState().supervisor.lanes.find((lane) => lane.id === existingLane.id) || existingLane;
      store.updateLane(existingLane.id, {
        projectWorkItemId: item.id,
        currentTask: item.contract.objective,
        awaitingReview: false,
        awaitingStopCheck: false,
        stopConfirmed: false,
        awaitingDirectionAfterWaitingResume: false,
        projectTaskContractPending: true,
        unreportedIdleRecoveryAttempts: 0,
        autonomyPermissionsOverride: projectContractAutonomyPermissions(item.contract),
        permissionConfirmations: [],
        config: {
          ...effectiveSupervisorLaneConfig(currentLane),
          taskGoal: item.contract.objective,
          taskDescription: [item.contract.description, contractBriefing].filter(Boolean).join('\n\n'),
          preconditions: [...projectPreconditions, ...item.contract.preconditions].join('；'),
          supervisorNotes,
          stopWhen: item.contract.stopWhen.join('；'),
          stopWhenKind: 'concrete',
          waitForNextDirection: true,
          taskWorkMode: execution.taskWorkMode,
          mainThreadResponsibility: execution.mainThreadResponsibility,
          childThreadResponsibilities: execution.childThreadResponsibilities,
          maxChildThreads: execution.maxChildThreads,
          supervisorMayApproveThreads: execution.supervisorMayApproveThreads,
          parallelizableOperations: execution.parallelizableOperations,
          serializedOperations: execution.serializedOperations,
        },
      });
      store.updateSurface(
        reusableWorker.workspaceId,
        reusableWorker.paneId,
        reusableWorker.surfaceId,
        { projectManagerWorkItemId: item.id },
      );
      const reboundLane = useStore.getState().supervisor.lanes.find((lane) => lane.id === existingLane.id);
      if (reboundLane?.supervisorSurfaceId) {
        try {
          await sendToSurfaceReliably(reboundLane.supervisorSurfaceId, [
            '[项目 AI 派发下一阶段目标｜复用同一专属监督]',
            previousItemParked
              ? `上一工作项 ${previousItem?.id || ''} 已暂缓并保留证据，本轮改为推进一个不依赖它的高价值工作项。不要尝试重建上一工作项缺失的身份或条件；以后只在阻塞解除且项目 AI 明确重新派发时续接。`
              : '上一工作项已经验收。你继续管理同一个项目，但本轮责任是下面的完整新阶段目标；请在合同内自行拆解任务 AI 的多个执行步骤，不要把每个命令或测试再交回项目 AI。普通续作无需轮换任务终端。',
            buildSupervisorBriefing(
              useStore.getState().supervisor,
              { lane: reboundLane, state: String(((window as any).__wmux_getAgentStates?.() || {})[reboundLane.surfaceId]?.state || 'unknown') },
            ),
          ].join('\n\n'), true);
        } catch (error) {
          const detail = `下一阶段目标交付失败：${String((error as Error)?.message || error)}`;
          store.pauseSupervisorLane(existingLane.id, detail);
          queueProjectSupervisorRecovery(reboundLane, detail);
          return { ok: false, error: detail };
        }
        const staleDispatch = currentDispatchError(existingLane.id);
        if (staleDispatch) {
          store.pauseSupervisorLane(existingLane.id, `下一阶段派发期间${staleDispatch}`);
          return { ok: false, error: `下一阶段派发期间${staleDispatch}；已拒绝沿用旧合同继续` };
        }
      }
      store.applyProjectManagerAction({
        type: 'update-work-item', workItemId: item.id,
        patch: {
          supervisorLaneId: existingLane.id,
          workerSurfaceId: existingLane.surfaceId,
          status: 'running',
          latestBlocker: undefined,
          startedAt: Date.now(),
        },
      }, session.id);
      store.appendProjectManagerEvent({
        kind: 'dispatch-mode-selected', workItemId: item.id,
        summary: `${taskWorkModeLabel(execution.taskWorkMode)}：${execution.modeReason}`,
        payload: { ...execution },
      }, session.id);
      saveProjectManagerSnapshot(session.id);
      scheduleProjectProgressCheck(session.id);
      return { ok: true, reused: true, laneId: existingLane.id, message: '已复用该项目的 AI 监督和任务终端并派发下一项任务' };
    }
    const supervisorDefaults = projectSupervisorDefaults(store.workspacePrefs.projectManagementAgents);
    const reservedSurfaceId = `project-task-pending-${uuid()}` as SurfaceId;
    const projectTaskBootstrap = item.workerSurfaceId
      ? undefined
      : {
          reservedSurfaceId,
          label: `${item.title} · 等待监督启动任务终端`,
          projectDir: session.projectDir,
        };
    const started = startRemoteSupervisor({
      action: 'start',
      terminals: [item.workerSurfaceId || reservedSurfaceId],
      stopWhen: item.contract.stopWhen.join('；'),
      stopWhenKind: 'concrete',
      taskGoal: item.contract.objective,
      taskDescription: [item.contract.description, contractBriefing].filter(Boolean).join('\n\n'),
      preconditions: [...projectPreconditions, ...item.contract.preconditions].join('；'),
      supervisorNotes,
      autonomous: true,
      supervisorLaunchCmd: supervisorDefaults.supervisorLaunchCmd,
      supervisorModel: supervisorDefaults.supervisorModel,
      supervisorReasoningEffort: supervisorDefaults.supervisorReasoningEffort,
      autonomyPermissions: [
        ...projectContractAutonomyPermissions(item.contract),
      ],
      actor: `project-manager:${session.id}`,
      projectWorkItemId: item.id,
      projectManagerProjectId: session.id,
      waitForNextDirection: true,
      taskWorkMode: execution.taskWorkMode,
      mainThreadResponsibility: execution.mainThreadResponsibility,
      childThreadResponsibilities: execution.childThreadResponsibilities,
      maxChildThreads: execution.maxChildThreads,
      supervisorMayApproveThreads: execution.supervisorMayApproveThreads,
      parallelizableOperations: execution.parallelizableOperations,
      serializedOperations: execution.serializedOperations,
      projectTaskBootstrap,
    }, true);
    if (!started.ok) return started;
    const lane = useStore.getState().supervisor.lanes.find((candidate) => (
      candidate.projectManagerProjectId === session.id && candidate.projectWorkItemId === item.id
    ));
    if (!lane) return { ok: false, error: '监督通道已创建但未能绑定项目任务' };
    if (!lane.supervisorSurfaceId) {
      store.stopSupervisorLane(lane.id, 'AI 监督终端创建失败');
      return { ok: false, error: '监督通道缺少专属 AI 监督终端' };
    }
    const supervisorRuntimeReady = await waitForTerminalRuntimeReady(lane.supervisorSurfaceId);
    if (!supervisorRuntimeReady.ok) {
      store.stopSupervisorLane(lane.id, 'AI 监督运行时启动失败');
      closeLiveSurfaceById(lane.supervisorSurfaceId);
      await appendRecordedProjectEvent(session, {
        kind: 'supervisor-runtime-failed',
        workItemId: item.id,
        summary: `AI 监督运行时启动失败：${supervisorRuntimeReady.error || '未知错误'}`,
        payload: { laneId: lane.id, supervisorSurfaceId: lane.supervisorSurfaceId },
      });
      return { ok: false, error: `AI 监督运行时未就绪：${supervisorRuntimeReady.error || '未知错误'}` };
    }
    const currentDispatchLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id);
    const currentDispatchProject = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
    if (
      !currentDispatchLane
      || supervisorLaneControlState(currentDispatchLane) !== 'active'
      || currentDispatchProject?.status !== 'active'
      || projectRequirementsVersion(currentDispatchProject) !== dispatchRequirementsVersion
      || projectAcceptedRequirementsVersion(currentDispatchProject) !== dispatchRequirementsVersion
      || projectAuthorizationVersion(currentDispatchProject) !== dispatchAuthorizationVersion
    ) {
      store.stopSupervisorLane(lane.id, 'AI 监督启动期间项目状态或需求版本发生变化');
      closeLiveSurfaceById(lane.supervisorSurfaceId);
      return { ok: false, error: 'AI 监督启动期间项目状态或需求版本已变化；旧任务未派发' };
    }
    store.updateLane(lane.id, {
      autonomyPermissionsOverride: projectContractAutonomyPermissions(item.contract),
      projectTaskContractPending: true,
      unreportedIdleRecoveryAttempts: 0,
      permissionConfirmations: [],
    });
    store.appendProjectManagerEvent({
      kind: 'dispatch-mode-selected', workItemId: item.id,
      summary: `${taskWorkModeLabel(execution.taskWorkMode)}：${execution.modeReason}`,
      payload: { ...execution },
    }, session.id);
    store.applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: item.id,
      patch: { supervisorLaneId: lane.id, status: 'running', latestBlocker: undefined, startedAt: Date.now() },
    }, session.id);
    await (window as any).wmux?.projectManager?.saveSession?.(
      useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
    );
    scheduleProjectProgressCheck(session.id);
    return {
      ok: true,
      message: projectTaskBootstrap
        ? '项目管理 AI 已启动新的 AI 监督；监督 AI 将自行创建项目专属任务终端并接收正式任务契约。'
        : started.message,
      laneId: lane.id,
      waitingForSupervisorTaskTerminal: !!projectTaskBootstrap,
    };
  }
  if (action === 'record-execution') {
    const workItemId = String(params?.workItemId || '').trim();
    const item = session.workItems.find((candidate) => candidate.id === workItemId);
    if (!item) return { ok: false, error: `任务不存在：${workItemId}` };
    const proposal = params?.proposal || params;
    const contractViolation = projectContractViolation(item.contract, {
      instruction: String(proposal.action || ''),
      command: String(proposal.command || ''),
      changedFiles: projectStringArray(proposal.changedFiles),
      testCommand: String(proposal.testCommand || '') || undefined,
      retry: proposal.retry === true,
    });
    if (contractViolation) return { ok: false, guard: 'reject', error: contractViolation };
    const guard = evaluateProjectExecutionGuard({
      history: item.executionHistory,
      proposal: {
        action: String(proposal.action || ''),
        command: String(proposal.command || ''),
        error: String(proposal.error || '') || undefined,
        changedFiles: projectStringArray(proposal.changedFiles),
        diffSummary: String(proposal.diffSummary || ''),
        evidence: String(proposal.evidence || ''),
        workspaceVersion: String(proposal.workspaceVersion || ''),
        testCommand: String(proposal.testCommand || '') || undefined,
        testResult: String(proposal.testResult || '') || undefined,
        fullSuite: proposal.fullSuite === true,
        now: Date.now(),
      },
      budget: item.contract.budget,
      decisionsUsed: item.decisionsUsed,
      startedAt: item.startedAt,
    });
    if (item.decisionsUsed < item.contract.budget.maxDecisions) {
      store.applyProjectManagerAction({ type: 'record-execution', workItemId, record: guard.record }, session.id);
    }
    if (guard.decision !== 'allow') {
      store.applyProjectManagerAction({
        type: 'update-work-item',
        workItemId,
        patch: {
          status: guard.decision === 'pause' ? 'paused' : 'waiting-decision',
          latestBlocker: guard.reason,
        },
      }, session.id);
      const guardEvent = {
        kind: 'guard-triggered' as const,
        workItemId,
        summary: guard.reason || '执行护栏已触发',
        payload: {
          decision: guard.decision,
          attentionRequired: guard.decision === 'pause',
        },
      };
      if (guard.decision === 'pause') await appendRecordedProjectEvent(session, guardEvent);
      else store.appendProjectManagerEvent(guardEvent, session.id);
    }
    await (window as any).wmux?.projectManager?.saveSession?.(
      useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
    );
    return { ok: guard.decision === 'allow', guard: guard.decision, error: guard.reason, record: guard.record };
  }
  if (action === 'pause') {
    if (session.status !== 'active' && session.status !== 'waiting') return { ok: false, error: '项目当前状态不能暂停' };
    const reason = String(params?.reason || '由项目管理 AI 暂停');
    const result = store.applyProjectManagerAction({
      type: 'pause-project',
      reason,
      source: 'manager',
      attentionRequired: true,
    }, session.id);
    for (const laneId of projectSupervisorLaneIds(session)) store.pauseSupervisorLane(laneId, '项目管理会话已暂停');
    const timer = projectProgressTimers.get(session.id);
    if (timer) globalThis.clearTimeout(timer);
    projectProgressTimers.delete(session.id);
    await persistProjectManagerMutation(result, session.id);
    const notificationText = `项目“${projectDisplayName(session)}”已由项目 AI 暂停：${reason}`;
    const notificationWorkspaceId = projectRuntimeWorkspaceId(session.id);
    const notificationSurfaceId = session.managerSurfaceId || session.taskTerminalSurfaceId || '';
    if (notificationWorkspaceId) {
      store.addNotification({
        surfaceId: notificationSurfaceId as SurfaceId,
        workspaceId: notificationWorkspaceId,
        title: '项目需要处理',
        text: notificationText,
      });
    }
    window.wmux?.notification?.fire({
      surfaceId: notificationSurfaceId,
      title: '项目需要处理',
      text: notificationText,
    });
    return result;
  }
  if (action === 'resume') {
    if (session.status !== 'paused' && session.status !== 'waiting') return { ok: false, error: '只有暂停或等待中的项目可以恢复' };
    const progress = await scanProjectProgressForReview(session.id, '项目恢复执行前检查项目现状');
    const progressSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
    const reviewError = projectProgressReviewError(progressSession);
    if (!progress.ok || reviewError) {
      return { ok: false, error: reviewError || progress.error || '项目进度同步失败，不能恢复旧合同' };
    }
    const alignment = await ensureProjectRequirementAlignment(session.id, '项目管理 AI 尝试在需求未充分对齐时恢复项目');
    if (alignment.triggered || alignment.alignmentRequired || alignment.awaitingDefinitionUpdate) {
      return {
        ok: false,
        error: alignment.awaitingDefinitionUpdate
          ? `用户答复尚未写回项目定义；请先执行 wmux project update --project ${session.id}，不能直接恢复`
          : alignment.alignmentRequired
            ? `项目尚未提交首次需求充分性结论；需求充分时先执行 wmux project alignment-confirm --project ${session.id}，需求不足时执行 wmux project ask --project ${session.id}`
            : '项目需求尚未充分对齐；已向桌面和飞书发送带推荐项的问题，用户答复前不能恢复',
        question: alignment.question,
      };
    }
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
    const orientationError = projectOrientationReviewError(current);
    if (orientationError) return { ok: false, error: orientationError };
    const activeGoal = activeProjectGoal(session);
    if (activeGoal.status === 'achieved') {
      return { ok: false, error: '当前主目标已经完成，请先通过 mode=pivot 切换新的主目标' };
    }
    if (activeProjectSubgoals(session).every((subgoal) => subgoal.status === 'obsolete')) {
      return {
        ok: false,
        error: `当前主目标尚未建立阶段计划；请先执行 wmux project goal-plan --project ${session.id}，再恢复执行`,
      };
    }
    const staleTask = session.workItems.find((item) => (
      item.goalId === activeGoal.id
      && !['completed', 'stopped'].includes(item.status)
      && (item.requirementsVersion !== projectRequirementsVersion(session)
        || item.authorizationVersion !== projectAuthorizationVersion(session))
    ));
    if (staleTask) {
      return {
        ok: false,
        error: `任务 ${staleTask.id} 仍绑定旧需求或授权版本；请先用 task-update 显式重绑（rebindCurrentRequirements=true）或停止该任务`,
      };
    }
    const result = store.applyProjectManagerAction({
      type: 'resume-project',
      reason: String(params?.reason || '由项目管理 AI 恢复'),
      acceptRequirementsVersion: true,
    }, session.id);
    resumeEligibleProjectSupervisorLanes(session.id, '项目管理会话已恢复');
    scheduleProjectProgressCheck(session.id);
    return persistProjectManagerMutation(result, session.id);
  }
  if (action === 'complete') {
    const evidence = String(params?.evidence || '').trim();
    return persistProjectManagerMutation(store.applyProjectManagerAction({ type: 'complete-current-goal', evidence }, session.id), session.id);
  }
  if (action === 'stop') {
    const emergency = params?.emergency === true;
    if (emergency) {
      return { ok: false, error: '紧急停止只能由用户在专用项目管理对话中明确确认后执行' };
    }
    const result = store.applyProjectManagerAction({ type: 'stop-project', reason: String(params?.reason || '由项目管理 AI 停止'), emergency }, session.id);
    for (const laneId of projectSupervisorLaneIds(session)) store.stopSupervisorLane(laneId, '项目管理会话已停止');
    return persistProjectManagerMutation(result, session.id);
  }
  if (action === 'reply') {
    const message = String(params?.message || '').trim();
    if (!message) return { ok: false, error: '回复内容不能为空' };
    return persistProjectManagerMutation(store.applyProjectManagerAction({
      type: 'reply',
      correlationId: String(params?.correlationId || '') || undefined,
      message,
    }, session.id), session.id);
  }
  return { ok: false, error: `不支持的项目管理动作：${action}` };
}

export function initPipeBridge(): void {
  const w = window as any;
  projectManagerDeliveryGeneration += 1;
  managedAgentWatchdogGeneration += 1;

  w.__wmux_noteManagedAgentHook = (event: any) => handleManagedAgentHookEvent(event);
  w.__wmux_noteManagedAgentOutput = (surfaceId: string, data: string) => {
    handleManagedAgentOutput(String(surfaceId || ''), String(data || ''));
  };
  w.__wmux_clearManagedAgentWatchdog = (surfaceId: string) => {
    clearManagedAgentWatchdog(String(surfaceId || ''));
  };

  w.__wmux_queueProjectManagerRuntimeRecovery = (params: any) => {
    const projectId = String(params?.projectId || '').trim();
    const session = useStore.getState().projectManagers.find((candidate) => candidate.id === projectId);
    if (!session || ['completed', 'stopped'].includes(session.status)) return false;
    if (params?.role === 'supervisor' || params?.role === 'task') {
      const laneId = String(params?.laneId || '').trim();
      const lane = useStore.getState().supervisor.lanes.find((candidate) => (
        candidate.id === laneId
        && candidate.projectManagerProjectId === projectId
        && supervisorLaneControlState(candidate) === 'active'
      ));
      const surfaceId = String(params?.surfaceId || (
        params.role === 'supervisor' ? lane?.supervisorSurfaceId : lane?.surfaceId
      ) || '').trim();
      const target = surfaceId ? managedProjectAgentTarget(surfaceId) : undefined;
      if (!target || target.lane?.id !== lane?.id) return false;
      const runtime = clearManagedAgentWatchdog(surfaceId) || beginManagedAgentTurn({
        surfaceId,
        role: params.role,
        generation: ++managedAgentWatchdogGeneration,
        now: Date.now(),
        policy: managedAgentPolicy(target),
        sourceTask: String(params?.detail || ''),
      });
      void forceRecoverManagedAgent(target, runtime);
      return true;
    }
    if (params?.role === 'manager') {
      if (projectManagerRuntimeRecoveries.has(projectId)) return true;
      projectManagerRuntimeRecoveries.add(projectId);
      void (async () => {
        queueProjectManagerDelivery([
          '[项目 AI 故障恢复上下文｜新会话优先读取]',
          `项目：${session.id} · ${session.projectDir}`,
          `故障原因：${String(params?.detail || '原项目 AI 已退出')}`,
          `当前状态：${session.status}`,
          '控制层正在重建全新的项目 AI 会话；不得将原 PowerShell 终端当作 Agent 继续投递。',
          `新会话收到本消息后，先运行 wmux project status --project ${session.id} 读取持久状态和最近事件；核对故障影响后，再决定恢复原监督链或重建监督与任务 AI。`,
          session.status === 'paused'
            ? '项目在故障处理完成前保持暂停，不要绕过持久化项目状态盲目继续。'
            : '现有监督链按持久状态继续；核对完成前不要新增、改派或绕过监督链直接投递任务。',
        ].join('\n'), session.id, { priority: true });
        const runtime = await ensureProjectManagerRuntime(projectId, { forceRestart: true });
        if (!runtime.ok) {
          console.warn('[project-manager] failed to rebuild exited manager runtime', runtime.error);
          useStore.getState().applyProjectManagerAction({
            type: 'pause-project',
            reason: runtime.error || '项目 AI 运行时重建失败',
            source: 'runtime',
          }, session.id);
          await appendRecordedProjectEvent(session, {
            kind: 'manager-runtime-failed',
            summary: runtime.error || '项目 AI 运行时重建失败',
          });
          return;
        }
        const current = useStore.getState().projectManagers.find((candidate) => candidate.id === projectId);
        if (!current || ['completed', 'stopped'].includes(current.status)) return;
      })().catch((error) => {
        console.warn('[project-manager] manager runtime recovery failed', error);
      }).finally(() => {
        projectManagerRuntimeRecoveries.delete(projectId);
      });
      return true;
    }
    return false;
  };

  pendingProjectManagerDeliveries.splice(0);
  projectManagerDeliveryScheduled = false;
  projectManagerDeliverySurfacesInFlight.clear();
  projectManagerRuntimeRecoveries.clear();
  managedAgentRecoveries.clear();
  deletingProjectManagerSessions.clear();
  projectManagerRecoveryChoice = 'pending';
  projectManagerRecoveryMutationInFlight = false;
  for (const timer of projectProgressTimers.values()) globalThis.clearTimeout(timer);
  projectProgressTimers.clear();
  for (const timer of managedAgentWatchdogTimers.values()) globalThis.clearTimeout(timer);
  managedAgentWatchdogTimers.clear();
  managedAgentWatchdogs.clear();
  managedAgentOutputTails.clear();
  for (const timer of projectAlignmentTimers.values()) globalThis.clearTimeout(timer);
  projectAlignmentTimers.clear();
  hydrateProjectManagerDeliveries(useStore.getState().projectManagers);
  w.__wmux_projectManagerRequest = (params: any) => handleProjectManagerRequest(params);
  w.__wmux_flushProjectManagerDeliveries = () => flushProjectManagerDeliveries();
  w.__wmux_projectManagerRemoteControl = async (params: any) => {
    const action = String(params?.action || '');
    let store = useStore.getState();
    if (action === 'status') {
      const selected = projectSessionForParams(params);
      return {
        ok: true,
        session: selected ? projectManagerSessionView(selected) : null,
        projects: store.projectManagers.map(projectManagerSessionView),
        recoveryChoice: projectManagerRecoveryChoice,
      };
    }
    if (action === 'recovery-candidates') {
      if (store.projectManagers.length > 0 || projectManagerRecoveryChoice !== 'pending') {
        return {
          ok: true,
          candidates: [],
          recoveryChoice: store.projectManagers.length > 0 ? 'active' : projectManagerRecoveryChoice,
        };
      }
      const listActiveSessions = (window as any).wmux?.projectManager?.listActiveSessions;
      if (typeof listActiveSessions !== 'function') {
        return { ok: false, error: '项目恢复接口尚未就绪，请重启 wmux 后再试' };
      }
      const persisted = await listActiveSessions();
      const candidates = Array.isArray(persisted) ? persisted : [];
      return {
        ok: true,
        recoveryChoice: 'pending',
        candidates: candidates.map((session: ProjectManagerSession) => ({
          id: session.id,
          projectDir: session.projectDir,
          projectName: projectDisplayName(session),
          goal: session.goal,
          status: session.status,
          workItemCount: session.workItems.length,
          executionProtocolVersion: session.executionProtocolVersion || 0,
          requiresProtocolMigration: (session.executionProtocolVersion || 0)
            < CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION
            || session.workItems.some((item) => (
              !['completed', 'stopped'].includes(item.status)
              && (item.executionProtocolVersion || 0) < CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION
            )),
          updatedAt: session.updatedAt,
        })),
      };
    }
    if (action === 'restore-projects') {
      if (projectManagerRecoveryMutationInFlight) {
        return { ok: false, error: '历史项目记录正在恢复或删除，请等待当前操作完成' };
      }
      projectManagerRecoveryMutationInFlight = true;
      try {
        if (store.projectManagers.length > 0) {
          projectManagerRecoveryChoice = 'restore';
          return {
            ok: true,
            restored: true,
            projects: store.projectManagers.map(projectManagerSessionView),
            message: '当前项目组合已经恢复。',
          };
        }
        const listActiveSessions = (window as any).wmux?.projectManager?.listActiveSessions;
        if (typeof listActiveSessions !== 'function') {
          return { ok: false, error: '项目恢复接口尚未就绪，请重启 wmux 后再试' };
        }
        const persisted = await listActiveSessions();
        const available = Array.isArray(persisted) ? persisted : [];
        const requestedIds = Array.isArray(params?.projectIds)
          ? [...new Set(params.projectIds.map((value: unknown) => String(value).trim()).filter(Boolean))]
          : [];
        const candidates = requestedIds.length > 0
          ? available.filter((session: ProjectManagerSession) => requestedIds.includes(session.id))
          : available;
        if (requestedIds.length > 0 && candidates.length !== requestedIds.length) {
          return { ok: false, error: '部分所选历史项目已失效，请刷新恢复列表后重试。' };
        }
        if (candidates.length === 0) {
          projectManagerRecoveryChoice = 'skip';
          return { ok: true, restored: false, projects: [], message: '没有可恢复的项目。' };
        }
        const recoveryAgentConfig = normalizeProjectManagementAgentConfig(
          params?.agentConfig ?? useStore.getState().workspacePrefs.projectManagementAgents,
        );
        useStore.getState().setWorkspacePrefs({ projectManagementAgents: recoveryAgentConfig });
        projectManagerRecoveryChoice = 'restore';
        const recoveredSessions = candidates.map((session: ProjectManagerSession) => (
          restoredProjectManagerSession(session)
        ));
        useStore.getState().restoreProjectManagers(recoveredSessions, recoveredSessions[0]?.id);
        for (const session of recoveredSessions) {
          await scanProjectProgressForReview(session.id, '软件重启后恢复项目', false);
          await (window as any).wmux?.projectManager?.saveSession?.(
            useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
          );
        }
        const failures: string[] = [];
        for (const session of recoveredSessions) {
          const runtime = await ensureProjectManagerRuntime(session.id, { recoveredAfterRestart: true });
          if (runtime.ok) continue;
          failures.push(`${session.goal}：${runtime.error || '项目 AI 启动失败'}`);
          useStore.getState().applyProjectManagerAction({
            type: 'pause-project',
            reason: runtime.error || '项目 AI 启动失败',
            source: 'runtime',
          }, session.id);
          await appendRecordedProjectEvent(session, {
            kind: 'manager-runtime-failed',
            summary: runtime.error || '项目 AI 启动失败',
          });
        }
        store = useStore.getState();
        return {
          ok: true,
          restored: store.projectManagers.length > 0,
          projects: store.projectManagers.map(projectManagerSessionView),
          agentConfig: recoveryAgentConfig,
          message: failures.length > 0
            ? `已恢复 ${store.projectManagers.length} 个项目；${failures.length} 个项目的专属项目 AI 启动失败并已暂停。`
            : `已恢复 ${store.projectManagers.length} 个项目，并分别启动专属项目 AI。`,
          ...(failures.length > 0 ? { warnings: failures } : {}),
        };
      } finally {
        projectManagerRecoveryMutationInFlight = false;
      }
    }
    if (action === 'delete-recovery-project') {
      const projectId = String(params?.projectId || '').trim();
      if (!projectId) return { ok: false, error: '必须指定要删除的历史项目记录' };
      if (store.projectManagers.length > 0 || projectManagerRecoveryChoice !== 'pending') {
        return { ok: false, error: '历史项目恢复阶段已经结束，不能从候选列表删除记录' };
      }
      if (projectManagerRecoveryMutationInFlight || deletingProjectManagerSessions.has(projectId)) {
        return { ok: false, error: '历史项目记录正在恢复或删除，请等待当前操作完成' };
      }
      const listActiveSessions = (window as any).wmux?.projectManager?.listActiveSessions;
      const deleteSession = (window as any).wmux?.projectManager?.deleteSession;
      if (typeof listActiveSessions !== 'function' || typeof deleteSession !== 'function') {
        return { ok: false, error: '项目记录删除接口尚未就绪，请重启 wmux 后再试' };
      }
      projectManagerRecoveryMutationInFlight = true;
      deletingProjectManagerSessions.add(projectId);
      try {
        const persisted = await listActiveSessions();
        const candidate = Array.isArray(persisted)
          ? persisted.find((session: ProjectManagerSession) => session.id === projectId)
          : undefined;
        if (!candidate) return { ok: false, error: '该历史项目记录已经不存在，请刷新恢复列表' };
        if (useStore.getState().projectManagers.length > 0 || projectManagerRecoveryChoice !== 'pending') {
          return { ok: false, error: '历史项目恢复状态已经变化，已取消删除' };
        }
        await deleteSession(projectId);
        return {
          ok: true,
          deletedProjectId: projectId,
          message: '历史项目管理记录已删除；项目目录、代码和业务文件未删除。',
        };
      } finally {
        deletingProjectManagerSessions.delete(projectId);
        projectManagerRecoveryMutationInFlight = false;
      }
    }
    if (action === 'skip-project-recovery') {
      if (projectManagerRecoveryMutationInFlight) {
        return { ok: false, error: '历史项目记录正在恢复或删除，请等待当前操作完成' };
      }
      projectManagerRecoveryChoice = 'skip';
      return {
        ok: true,
        recoveryChoice: projectManagerRecoveryChoice,
        message: '本次运行不恢复上次项目；历史记录仍保留，下次启动时可再次选择。',
      };
    }
    if (action === 'configure-agents') {
      const projects = store.projectManagers.filter((session) => !['completed', 'stopped'].includes(session.status));
      if (projects.length === 0) return { ok: true, restarted: false, message: '项目管理模式 Agent 配置已保存。' };
      let restartedCount = 0;
      const failures: string[] = [];
      for (const project of projects) {
        const runtime = await ensureProjectManagerRuntime(project.id, { forceRestart: params?.restartManager === true });
        if (!runtime.ok) failures.push(`${project.goal}：${runtime.error || '启动失败'}`);
        else if (runtime.created) restartedCount += 1;
      }
      if (failures.length > 0) return { ok: false, error: failures.join('；') };
      return {
        ok: true,
        restarted: restartedCount > 0,
        restartedCount,
        message: restartedCount > 0
          ? `已安全换代 ${restartedCount} 个项目的专属项目 AI，并分别恢复结构化上下文。`
          : '项目管理模式 Agent 配置已保存；既有监督与任务终端保持运行。',
      };
    }
    if (action === 'delete-project') {
      const projectId = String(params?.projectId || '').trim();
      const selected = projectId
        ? useStore.getState().projectManagers.find((session) => session.id === projectId) || null
        : useStore.getState().projectManager;
      if (!selected) return { ok: false, error: '当前没有可删除的项目' };
      if (deletingProjectManagerSessions.has(selected.id)) return { ok: false, error: '项目正在删除，请勿重复操作' };
      const deleteSession = (window as any).wmux?.projectManager?.deleteSession;
      if (typeof deleteSession !== 'function') {
        return { ok: false, error: '项目删除接口尚未就绪，请重启 wmux 后再试' };
      }
      deletingProjectManagerSessions.add(selected.id);
      try {
        await deleteSession(selected.id);
        teardownManagedProject(selected);
        useStore.getState().removeProjectManager(selected.id);
      } finally {
        deletingProjectManagerSessions.delete(selected.id);
      }
      return {
        ok: true,
        deletedProjectId: selected.id,
        selectedProjectId: useStore.getState().selectedProjectManagerId,
        message: '项目已从项目组合中删除；项目目录和业务文件未删除。',
      };
    }
    if (action === 'logs') {
      const selected = projectSessionForParams(params);
      return { ok: true, events: selected?.events.slice(-50).reverse() || [] };
    }
    if (action === 'answer-question') {
      return answerProjectManagerUserQuestion(params);
    }
    if (action === 'pause-all-projects' || action === 'resume-all-projects') {
      return setProjectPortfolioPaused(
        action === 'pause-all-projects',
        String(params?.reason || (action === 'pause-all-projects' ? '用户全局暂停项目组合' : '用户全局恢复项目组合')),
      );
    }
    if (action === 'start') {
      const projectDir = String(params?.projectDir || '').trim();
      const projectName = String(params?.projectName || '').trim()
        || projectDir.replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean).at(-1)
        || '未命名项目';
      const projectScope = String(params?.projectScope || '').trim()
        || `仅限项目目录 ${projectDir} 内与当前项目直接相关的工作`;
      const goal = String(params?.goal || '').trim();
      const preconditions = projectStringArray(params?.preconditions);
      const supervisorNotes = projectStringArray(params?.supervisorNotes)
        .slice(0, 20).map((note) => note.slice(0, 4000));
      const planFiles = projectPlanFileSnapshots(params?.planFiles);
      const doneWhen = projectStringArray(params?.doneWhen);
      if (!projectDir && store.projectManagers.length > 0) {
        const current = projectSessionForParams(params) || store.projectManagers[0];
        if (current) {
          const runtime = await ensureProjectManagerRuntime(current.id);
          if (!runtime.ok) return { ok: false, error: runtime.error };
          store = useStore.getState();
          store.selectProjectManager(current.id);
          const refreshed = store.projectManagers.find((candidate) => candidate.id === current.id) || current;
          return { ok: true, restored: true, session: projectManagerSessionView(refreshed), projects: store.projectManagers.map(projectManagerSessionView) };
        }
      }
      if (!normalizeAbsolutePath(projectDir) || !goal) {
        return { ok: false, error: 'projectDir 必须是绝对路径，goal 不能为空' };
      }
      if (projectManagerRecoveryChoice === 'pending') projectManagerRecoveryChoice = 'skip';
      const session = store.startProjectManager({
        projectDir, projectName, projectScope, goal, preconditions, supervisorNotes, planFiles, doneWhen,
      });
      await (window as any).wmux?.projectManager?.saveSession?.(session);
      await checkpointProjectProgress(session.id, '项目首次创建');
      await (window as any).wmux?.projectManager?.saveSession?.(
        useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session,
      );
      const runtime = await ensureProjectManagerRuntime(session.id);
      if (!runtime.ok || !runtime.manager) {
        useStore.getState().applyProjectManagerAction({
          type: 'pause-project',
          reason: runtime.error || '项目 AI 启动失败',
          source: 'runtime',
        }, session.id);
        await appendRecordedProjectEvent(session, {
          kind: 'manager-runtime-failed',
          summary: runtime.error || '项目 AI 启动失败',
        });
        return { ok: false, error: runtime.error || '项目 AI 尚未就绪' };
      }
      await requireProjectRequirementsAlignment(session.id, '项目首次启动，必须先完成需求充分性检测', runtime.created === true);
      const activeSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
      deliverProjectManagerMessage([
        '[项目管理 AI 会话]',
        `项目 ID：${activeSession.id}`,
        `项目名称：${activeSession.projectName}`,
        `项目目录：${activeSession.projectDir}`,
        `稳定项目范围：${activeSession.projectScope}`,
        `当前主目标：G${activeProjectGoal(activeSession).sequence} · ${activeSession.goal}`,
        `项目级前置条件：${activeSession.preconditions.length > 0 ? activeSession.preconditions.join('；') : '未填写；由项目 AI 在首次需求对齐时判断并起草'}`,
        activeSession.preconditions.length > 0
          ? '已记录的前置条件和其中明确授权，在当前需求版本内持续有效。用户未发送变更且没有具体反证时，项目 AI、监督 AI 和任务 AI 都应直接继承，不得把同一上电、运行、测试、环境或安全条件拆成逐步确认。'
          : '前置条件留空不表示已确认不存在。先根据目标和项目环境判断；仅当硬件、环境、权限、资源或安全差异会实质改变方案时才向用户提问，否则自行记录“无额外物理前置条件”。',
        `项目级监督注意事项：${activeSession.supervisorNotes?.length ? activeSession.supervisorNotes.join('；') : '无'}`,
        '创建或更新工作项时，把适用的项目级注意事项写入 contract.supervisorNotes，并可补充当前阶段专属事项。它们用于监督 AI 选择检查点和安排任务 AI，不扩大合同范围、命令权限或风险授权。',
        `完成条件：${activeSession.doneWhen.length > 0 ? activeSession.doneWhen.join('；') : '未填写；由项目 AI 起草可验证标准'}`,
        projectPlanFilesBriefing(activeSession.planFiles || []),
        '',
        '你只管理当前这一个项目。项目 AI、专属监督 AI 和任务 AI 都在本项目的独立会话中；不得读取或决定其他项目。',
        '[首次需求对齐门禁｜必须先执行]',
        PROJECT_MANAGER_ALIGNMENT_GATE,
        `若前置条件或完成条件未填写，先基于当前主目标起草完整定义，并执行 wmux project update --project ${activeSession.id} 写回；只有不同合理答案会实质改变业务范围、验收、硬件、环境、权限或安全边界时，才使用结构化提问。定义仍有空白时不得提交 alignment-confirm。`,
        `[项目认知基线｜需求对齐后必须执行]\n先读取 project status 中的目标、前置条件、当前目录快照、orientation、全部工作项和最近事件，再用 wmux project orientation-confirm --project ${activeSession.id} --json-file <项目目录内的 .wmux/tmp/文件> 提交 orientation 中原样读取的 requirementsVersion、authorizationVersion、snapshotFingerprint、requestedAt，以及 summary、knownFacts、unknowns 和 workItems。新项目的 workItems 传空数组。认知基线由控制层绑定当前需求、授权和目录快照；确认过程中任何版本或目录变化都会拒绝旧结果。`,
        `认知基线确认后，再用 wmux project goal-plan --project ${activeSession.id} --json-file <项目目录内的 .wmux/tmp/文件> 保存 3-7 个粗粒度阶段目标，然后 resume 和创建执行任务。阶段目标描述成果、依赖和验收，不得写成命令级微步骤。`,
        '每个执行任务必须携带当前 goalId 和 subgoalId。主目标切换后旧 goalId 的任务永久失效，只能复用其证据，不能复活执行。',
        `本项目的结构化提问命令必须包含：wmux project ask --project ${activeSession.id} --json-file <项目目录内的 .wmux/tmp/文件>。禁止把“请回复”“若无偏好”等问题只输出在项目管理终端后停住，因为用户不会直接监看该终端。`,
        '所有项目专属命令都必须显式携带 --project <项目ID>；不要依赖界面当前选中项目，也不要把普通执行过程发送给用户。',
        `每个有意义的里程碑及监督进入待续/阻塞前，必须用 wmux project task-update --project ${activeSession.id} 持久化 latestContextSummary、latestEvidence 和 latestBlocker，供软件重启后创建新 AI 会话续作。`,
        `需求不足或用户偏好不明确时，必须用 wmux project ask --project ${activeSession.id} 发起 category=clarification 的结构化飞书通知；阻塞超出你的决策权或需要人工操作时改用 category=manual-intervention。用户答复后先决定下一步，不得自动恢复任务。`,
        ].join('\n'), runtime.created === true, activeSession.id);
      return { ok: true, restored: false, session: activeSession };
    }
    if (action === 'message') {
      const selectedProject = projectSessionForParams(params);
      if (!selectedProject) return { ok: false, error: '请先在项目中心选择消息所属项目' };
      const message = String(params?.message || '').trim();
      if (!message) return { ok: false, error: '项目管理消息不能为空' };
      const changeSignal = projectMessageChangeSignal(message);
      const messageSource = String(params?.source || '').trim() === 'desktop'
        ? '桌面'
        : String(params?.chatId || '').trim()
          ? '飞书'
          : '桌面';
      let quiesce: { confirmed: string[]; failed: string[] } | undefined;
      const revokedOldRun = !!changeSignal && !['completed', 'stopped'].includes(selectedProject.status);
      if (revokedOldRun) {
        quiesce = await quiesceProjectRuntimeLanes(
          selectedProject,
          changeSignal === 'prerequisite-change'
            ? '用户消息表明项目级前置条件可能已变化，立即撤销旧版本运行授权'
            : '用户消息表明项目需求可能已变化，立即停止旧版本任务',
        );
        store = useStore.getState();
        store.applyProjectManagerAction({
          type: 'require-requirements-alignment',
          reason: changeSignal === 'prerequisite-change'
            ? '用户声明前置条件变化，项目定义写回后必须重新完成需求与权限对齐'
            : '用户声明需求变化，项目定义写回后必须重新完成需求对齐',
        }, selectedProject.id);
        if (selectedProject.status !== 'paused') {
          store.applyProjectManagerAction({
            type: 'pause-project',
            reason: changeSignal === 'prerequisite-change'
              ? '检测到用户声明前置条件变化，等待项目 AI 写回并重新对齐'
              : '检测到用户声明需求变化，等待项目 AI 写回并重新对齐',
          }, selectedProject.id);
        }
      }
      store = useStore.getState();
      const currentProject = store.projectManagers.find((candidate) => candidate.id === selectedProject.id) || selectedProject;
      store.restoreProjectManager({
        ...currentProject,
        feishuChatId: String(params?.chatId || currentProject.feishuChatId || '') || undefined,
        ...(revokedOldRun ? {
          orientation: requiredProjectOrientation(
            currentProject,
            changeSignal === 'prerequisite-change'
              ? '用户声明前置条件变化，需要按新权限边界重新建立项目认知基线'
              : '用户声明需求变化，需要按新目标与约束重新建立项目认知基线',
          ),
        } : {}),
        updatedAt: Date.now(),
      });
      store.appendProjectManagerEvent({
        kind: 'user-message',
        correlationId: String(params?.messageId || '') || undefined,
        summary: message,
        ...(changeSignal ? {
          payload: {
            changeSignal,
            quiescedLanes: quiesce?.confirmed || [],
            unconfirmedLanes: quiesce?.failed || [],
          },
        } : {}),
      }, selectedProject.id);
      await (window as any).wmux?.projectManager?.saveSession?.(
        useStore.getState().projectManagers.find((candidate) => candidate.id === selectedProject.id),
      );
      const runtime = await ensureProjectManagerRuntime(selectedProject.id);
      const manager = runtime.manager;
      if (!runtime.ok || !manager) {
        return {
          ok: false,
          error: `${runtime.error || '项目管理 AI 尚未就绪'}${revokedOldRun ? '；变更消息已记录，旧任务已保持暂停' : ''}`,
        };
      }
      deliverProjectManagerMessage([
        `[${messageSource}项目管理消息｜必须回复到对应项目会话${revokedOldRun ? '｜控制层已撤销旧运行授权' : ''}]`,
        `消息 ID：${String(params?.messageId || 'unknown')}`,
        `当前项目 ID：${selectedProject?.id || '未选择'}`,
        `当前项目目录：${selectedProject?.projectDir || '未选择'}`,
        message,
        '',
        revokedOldRun
          ? `控制层已将项目暂停并中断旧任务。该消息被识别为${changeSignal === 'prerequisite-change' ? '前置条件变化' : '需求变化'}；必须先执行 wmux project update --project ${selectedProject.id} 写回结构化定义并重新对齐，禁止直接恢复旧合同。${quiesce?.failed.length ? `以下通道未确认停止，必须通知用户处理：${quiesce.failed.join('、')}。` : ''}`
          : '',
        `请作为本项目的专属项目 AI 直接回复用户。需要执行管理动作时使用 wmux project；若消息只调整当前主目标的约束或验收，执行 wmux project update --project ${selectedProject.id} 并使用 mode=refine；若用户在同一稳定项目内切换新的最终结果，使用 mode=pivot，新建主目标版本并重新执行 goal-plan。项目范围改变时应提议另建项目，不能擅自并入。随后自主评估任务的复用、停止和重绑，不要逐项要求用户确认。最终必须执行 wmux project reply --project ${selectedProject.id} --correlation "${String(params?.messageId || 'unknown')}" --message "<回复内容>"，让回复进入该项目自己的桌面/飞书会话。`,
      ].filter(Boolean).join('\n'), runtime.created === true, selectedProject.id);
      return {
        ok: true,
        message: revokedOldRun
          ? '已记录变更并立即暂停旧任务，消息已交给项目管理 AI 重新对齐'
          : '消息已交给项目管理 AI',
      };
    }
    if (action === 'event') {
      store = useStore.getState();
      const session = projectSessionForParams(params);
      if (!session) return { ok: false, error: '当前没有项目管理会话' };
      const workItemId = String(params?.workItemId || '').trim();
      const summary = String(params?.summary || params?.eventType || '').trim().slice(0, 1200);
      const eventType = String(params?.eventType || '');
      const stageHandoff = eventType === 'supervisor.waiting-for-direction'
        && params?.payload?.handoffKind === 'stage-complete';
      const decisionRequest = eventType === 'supervisor.approval.requested'
        || (eventType === 'supervisor.waiting-for-direction' && !stageHandoff)
        || eventType === 'worker.blocked';
      store.appendProjectManagerEvent({
        kind: stageHandoff
          ? 'supervisor-handoff'
          : decisionRequest
            ? 'supervisor-decision-request'
            : 'supervisor-decision',
        workItemId: workItemId || undefined,
        summary,
        payload: { eventType, ...(params?.payload || {}) },
      }, session.id);
      const contextSummary = String(
        params?.payload?.contextSummary || (!decisionRequest ? summary : ''),
      ).trim().slice(0, 12000);
      const evidence = String(params?.payload?.evidence || '').trim().slice(0, 12000);
      const blocker = String(params?.payload?.blocker || '').trim().slice(0, 12000);
      if (workItemId && (decisionRequest || contextSummary || evidence || blocker)) {
        store.applyProjectManagerAction({
          type: 'update-work-item', workItemId,
          patch: {
            ...(stageHandoff
              ? { status: 'validating' as const, latestBlocker: undefined }
              : decisionRequest
                ? { status: 'waiting-decision' as const }
                : {}),
            ...(contextSummary ? { latestContextSummary: contextSummary } : {}),
            ...(evidence ? { latestEvidence: evidence } : {}),
            ...(!stageHandoff && (blocker || decisionRequest) ? { latestBlocker: blocker || summary } : {}),
          },
        }, session.id);
      }
      const currentProject = useStore.getState().projectManagers
        .find((candidate) => candidate.id === session.id);
      const currentWorkItem = currentProject?.workItems
        .find((candidate) => candidate.id === workItemId);
      const stage = currentWorkItem?.subgoalId
        ? activeProjectSubgoals(currentProject || session)
          .find((candidate) => candidate.id === currentWorkItem.subgoalId)
        : undefined;
      const transitionKind: ProjectSupervisorTransitionKind = stageHandoff
        ? 'stage-complete'
        : eventType === 'supervisor.waiting-for-direction'
          ? 'direction-needed'
          : eventType === 'supervisor.idle-unreported'
            ? 'supervisor-idle'
            : eventType === 'supervisor.provider-limit' || eventType === 'supervisor.delivery.failed'
              ? 'supervisor-unavailable'
              : 'decision-required';
      const transition = queueProjectSupervisorTransition({
        sessionId: session.id,
        laneId: String(params?.payload?.laneId || params?.laneId || '').trim() || `work-item:${workItemId || 'unknown'}`,
        workItemId: workItemId || undefined,
        kind: transitionKind,
        eventType,
        summary: [stage ? `${stage.title} · ${stage.outcome}` : '', summary].filter(Boolean).join('：'),
        evidence: evidence || currentWorkItem?.latestEvidence,
        contextSummary,
        instruction: stageHandoff
          ? [
              '这不是阻塞，也不需要用户确认。专属监督和任务终端保留在同一项目会话中，等待项目级验收和下一阶段续接。',
              `证据不足时把 ${workItemId || '<任务ID>'} 改回 running，写明待补结果并再次 supervise；证据充分时标记 completed，再派发覆盖完整下一阶段成果的工作项。`,
              '普通阶段续作不轮换任务终端；没有后续阶段时按目标级证据完成当前主目标。',
            ].join('\n')
          : decisionRequest
            ? `在项目既有前置条件和授权内自主裁决并更新任务方向。只有发现条件变化、超范围或高风险事项时才询问用户；存在 latestBlocker 时不得标记完成。`
            : '更新项目任务状态并决定继续、重规划、暂停或恢复；普通执行过程不要发送给用户。',
      });
      try {
        await (window as any).wmux?.projectManager?.saveSession?.(
          useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
        );
      } catch (error) {
        console.warn('[project-manager] failed to persist supervisor transition', error);
      }
      if (stageHandoff) {
        await checkpointProjectProgress(session.id, `监督完成阶段交接：${workItemId || '未知工作项'}`);
      }
      scheduleProjectProgressCheck(session.id);
      return { ok: true, transitionId: transition?.id };
    }
    store = useStore.getState();
    const session = projectSessionForParams(params);
    if (!session) return { ok: false, error: '当前没有项目管理会话' };
    if (action === 'intervene-work-item') {
      const workItemId = String(params?.workItemId || '').trim();
      const intervention = String(params?.intervention || '').trim();
      const reason = String(params?.reason || '').trim().slice(0, 1200);
      if (!workItemId) return { ok: false, error: '必须选择要干预的工作项' };
      if (intervention !== 'skip' && intervention !== 'close') {
        return { ok: false, error: '工作项干预方式必须是跳过或关闭' };
      }
      const workItem = session.workItems.find((item) => item.id === workItemId);
      if (!workItem) return { ok: false, error: `任务不存在：${workItemId}` };
      const targetLanes = store.supervisor.lanes.filter((lane) => (
        lane.projectManagerProjectId === session.id && lane.projectWorkItemId === workItemId
      ));
      const workerSurfaceIds = new Set<string>(targetLanes.map((lane) => lane.surfaceId).filter(Boolean));
      if (workItem.workerSurfaceId) {
        const reusedByAnotherWorkItem = store.supervisor.lanes.some((lane) => (
          lane.projectManagerProjectId === session.id
          && lane.projectWorkItemId !== workItemId
          && lane.surfaceId === workItem.workerSurfaceId
        ));
        const liveSurface = store.workspaces.flatMap((workspace) => getAllPaneIds(workspace.splitTree).flatMap((paneId) => (
          findLeaf(workspace.splitTree, paneId)?.surfaces || []
        ))).find((surface) => surface.id === workItem.workerSurfaceId);
        const reboundInWorkspace = !!liveSurface?.projectManagerWorkItemId
          && liveSurface.projectManagerWorkItemId !== workItemId;
        if (!reusedByAnotherWorkItem && !reboundInWorkspace) workerSurfaceIds.add(workItem.workerSurfaceId);
      }
      const result = store.applyProjectManagerAction({
        type: 'intervene-work-item',
        workItemId,
        intervention,
        reason,
      }, session.id);
      if (!result.ok) return result;

      closeStoppedSupervisorSurfaces(targetLanes);
      for (const lane of targetLanes) {
        useStore.getState().stopSupervisorLane(
          lane.id,
          `用户${intervention === 'skip' ? '跳过' : '关闭'}工作项 ${workItem.title}，停止对应专属监督链`,
        );
      }
      for (const surfaceId of workerSurfaceIds) closeLiveSurfaceById(surfaceId as SurfaceId);

      await persistProjectManagerMutation(result, session.id);
      const runtime = await ensureProjectManagerRuntime(session.id);
      const interventionLabel = intervention === 'skip' ? '跳过' : '关闭';
      deliverProjectManagerMessage([
        `[用户干预工作项｜${interventionLabel}]`,
        `项目：${session.id} · ${session.projectDir}`,
        `当前主目标：${session.goal}`,
        `工作项：${workItem.id} · ${workItem.title}`,
        `用户理由：${reason || '未填写；仅按用户选择的干预方式处理'}`,
        '控制层已把该工作项标记为停止，并关闭它当前绑定的专属监督与任务 AI；其他工作项没有被全局暂停。',
        '',
        intervention === 'skip'
          ? '“跳过”表示本轮计划不再执行原工作项。请立即复核其依赖项和主目标完成条件，在现有授权内自主重排、调整阶段或创建必要的替代工作项；不得恢复原工作项 ID，也不要为普通重排再次询问用户。只有主目标因此无法达成且没有授权范围内的可行替代方案时，才携带事实、依据和推荐方案向用户提案。'
          : '“关闭”表示用户明确从当前计划中移除该工作项。未经用户新的明确指示，不得恢复原工作项或以等价工作项绕过此决定；请自主重排受影响的依赖项。若关闭后主目标无法达成，携带事实、影响和推荐方案向用户提案。',
        `处理完后请使用 wmux project reply --project ${session.id} --message "<已如何调整计划的摘要>"，把结果写回当前项目会话。`,
      ].join('\n'), runtime.created === true, session.id);
      return {
        ...result,
        message: runtime.ok
          ? `已${interventionLabel}“${workItem.title}”，并通知项目 AI 重排后续计划。`
          : `已${interventionLabel}“${workItem.title}”；项目 AI 当前不可用，干预通知已持久排队并会自动重试。`,
      };
    }
    if (action === 'update-definition') {
      return updateProjectDefinition(session, params, 'user');
    }
    if (action === 'update-preconditions') {
      if (['completed', 'stopped'].includes(session.status)) {
        return { ok: false, error: '已完成或停止的项目不能再修改前置条件' };
      }
      const preconditions = projectStringArray(params?.preconditions);
      if (preconditions.length === 0) {
        return { ok: false, error: '项目前置条件不能为空；没有额外条件时请明确填写“无额外物理前置条件”' };
      }
      const quiesce = await quiesceProjectRuntimeLanes(
        session,
        '项目前置条件已更新，停止旧假设下的任务并等待重新核对',
      );
      const result = store.applyProjectManagerAction({
        type: 'update-project-preconditions',
        preconditions,
        reason: `用户更新项目前置条件：${preconditions.join('；')}`,
      }, session.id);
      if (!result.ok) return result;
      const alignmentResult = store.applyProjectManagerAction({
        type: 'require-requirements-alignment',
        reason: '项目前置条件和授权边界已更新，需要按新版本重新完成需求充分性检测',
      }, session.id);
      if (!alignmentResult.ok) return alignmentResult;
      const progressTimer = projectProgressTimers.get(session.id);
      if (progressTimer) {
        clearTimeout(progressTimer);
        projectProgressTimers.delete(session.id);
      }
      const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
      await (window as any).wmux?.projectManager?.saveSession?.(updated);
      try {
        await (window as any).wmux?.projectManager?.appendRecord?.({
          sessionId: session.id,
          projectDir: session.projectDir,
          type: result.event?.kind || 'project-preconditions-updated',
          payload: { message: result.event?.summary, preconditions },
        });
      } catch (error) {
        console.warn('[project-manager] failed to append prerequisite audit record', error);
      }
      const constraintNotice = [
        '[用户更新项目级前置条件｜立即重新核对]',
        `项目：${session.id} · ${session.projectDir}`,
        ...preconditions.map((condition) => `- ${condition}`),
        '这些条件是用户拥有的硬约束。不得假定已经满足；请重新检查当前规划和进行中的任务。任何依赖未满足条件的操作必须暂停，取得证据后才可继续。',
      ].join('\n');
      queueProjectManagerDelivery(constraintNotice, session.id);
      const latestStore = useStore.getState();
      let supervisorNotificationFailures = 0;
      for (const lane of latestStore.supervisor.lanes.filter((candidate) => (
        candidate.projectManagerProjectId === session.id && supervisorLaneControlState(candidate) !== 'stopped'
      ))) {
        const workItem = updated?.workItems.find((item) => item.id === lane.projectWorkItemId);
        latestStore.updateLane(lane.id, {
          config: {
            ...effectiveSupervisorLaneConfig(lane),
            preconditions: [...preconditions, ...(workItem?.contract.preconditions || [])].join('；'),
          },
        });
        latestStore.pauseSupervisorLane(lane.id, '项目前置条件已更新，等待项目管理 AI 按新版本重新规划');
        if (lane.supervisorSurfaceId) {
          try {
            await sendToSurfaceReliably(lane.supervisorSurfaceId, constraintNotice, true);
          } catch (error) {
            supervisorNotificationFailures += 1;
            console.warn('[project-manager] failed to notify supervisor about prerequisites', error);
          }
        }
      }
      return {
        ok: true,
        event: result.event,
        session: updated,
        message: supervisorNotificationFailures > 0
          ? '项目前置条件已更新且监督链已暂停；项目管理 AI 已收到通知，部分监督 AI 将由它继续转发并核对。'
          : quiesce.failed.length > 0
            ? '项目前置条件已更新；监督链保持暂停，但部分任务终端未确认中断，已通知用户处理。'
          : '项目前置条件已更新，监督链已暂停，并已通知项目管理 AI 和活动监督 AI 重新核对。',
      };
    }
    if (action === 'pause' || action === 'resume' || action === 'stop') {
      const reason = String(params?.reason || `由飞书${action}`).trim();
      if (action === 'pause' && session.status !== 'active' && session.status !== 'waiting') {
        return { ok: false, error: '项目当前状态不能暂停' };
      }
      if (action === 'resume' && session.status !== 'paused' && session.status !== 'waiting') {
        return { ok: false, error: '只有暂停或等待中的项目可以恢复' };
      }
      if (action === 'resume' && session.pendingUserQuestion) {
        return { ok: false, error: '项目仍在等待用户答复，不能绕过澄清直接恢复' };
      }
      if (action === 'resume') {
        const progress = await scanProjectProgressForReview(session.id, '用户从飞书恢复项目前检查项目现状');
        const progressSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
        const reviewError = projectProgressReviewError(progressSession);
        if (!progress.ok || reviewError) {
          return {
            ok: false,
            error: reviewError || progress.error || '项目进度同步失败；已交给项目 AI 复核，不能直接恢复旧合同',
          };
        }
      }
      if (
        action === 'resume'
        && projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)
      ) {
        return { ok: false, error: '需求或前置条件已经更新；必须先由项目管理 AI 重新规划并接受最新版本，用户恢复不能绕过该门禁' };
      }
      if (action === 'resume') {
        const alignment = await ensureProjectRequirementAlignment(session.id, '用户尝试在需求未充分对齐时恢复项目');
        if (alignment.triggered || alignment.alignmentRequired || alignment.awaitingDefinitionUpdate) {
          return {
            ok: false,
            error: alignment.awaitingDefinitionUpdate
              ? '用户答复尚未写回项目定义；请先让项目管理 AI 更新目标、范围和完成条件'
              : alignment.alignmentRequired
                ? '项目尚未提交首次需求充分性结论；请先由项目管理 AI 完成检测'
                : '项目需求尚未充分对齐；已向桌面和飞书发送带推荐项的问题，请先答复',
            question: alignment.question,
          };
        }
        const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
        const orientationError = projectOrientationReviewError(current);
        if (orientationError) return { ok: false, error: orientationError };
        const activeGoal = activeProjectGoal(session);
        if (activeGoal.status === 'achieved') {
          return { ok: false, error: '当前主目标已经完成，请先与项目 AI 对话并切换新的主目标' };
        }
        if (activeProjectSubgoals(session).every((subgoal) => subgoal.status === 'obsolete')) {
          return { ok: false, error: '当前主目标还没有阶段计划，请先由项目 AI 完成规划' };
        }
        const staleTask = session.workItems.find((item) => (
          item.goalId === activeGoal.id
          && !['completed', 'stopped'].includes(item.status)
          && (item.requirementsVersion !== projectRequirementsVersion(session)
            || item.authorizationVersion !== projectAuthorizationVersion(session))
        ));
        if (staleTask) {
          return { ok: false, error: `任务 ${staleTask.id} 尚未由项目 AI 重绑当前需求和授权版本，不能直接恢复` };
        }
      }
      const result = action === 'pause'
        ? store.applyProjectManagerAction({ type: 'pause-project', reason }, session.id)
        : action === 'resume'
          ? store.applyProjectManagerAction({ type: 'resume-project', reason }, session.id)
          : store.applyProjectManagerAction({ type: 'stop-project', reason, emergency: params?.emergency === true }, session.id);
      if (action === 'pause') {
        for (const laneId of projectSupervisorLaneIds(session)) store.pauseSupervisorLane(laneId, '由飞书暂停项目管理会话');
      }
      if (action === 'resume') {
        resumeEligibleProjectSupervisorLanes(session.id, '由飞书恢复项目管理会话');
      }
      if (action === 'stop') {
        if (params?.emergency === true) {
          for (const item of session.workItems) {
            if (item.workerSurfaceId && ['running', 'validating'].includes(item.status)) {
              try { sendToSurface(item.workerSurfaceId, '\x03', false); } catch { /* Already stopped. */ }
            }
          }
        }
        for (const laneId of projectSupervisorLaneIds(session)) store.stopSupervisorLane(laneId, '由飞书停止项目管理会话');
      }
      if (action === 'pause' || action === 'stop') {
        const timer = projectProgressTimers.get(session.id);
        if (timer) globalThis.clearTimeout(timer);
        projectProgressTimers.delete(session.id);
      } else {
        scheduleProjectProgressCheck(session.id);
      }
      await persistProjectManagerMutation(result, session.id);
      return result;
    }
    return { ok: false, error: `不支持的项目管理远程动作：${action}` };
  };

  // ─── Workspace ──────────────────────────────────────────────────────────────

  w.__wmux_createWorkspace = (params?: { title?: string; shell?: string; cwd?: string }) => {
    const store = useStore.getState();
    const id = store.createWorkspace({
      title: params?.title,
      shell: params?.shell,
      cwd: params?.cwd,
    });
    return { workspaceId: id };
  };

  w.__wmux_closeWorkspace = (id: string) => {
    useStore.getState().closeWorkspace(id as WorkspaceId);
  };

  w.__wmux_selectWorkspace = (id: string) => {
    useStore.getState().selectWorkspace(id as WorkspaceId);
  };

  w.__wmux_renameWorkspace = (id: string, title: string) => {
    useStore.getState().renameWorkspace(id as WorkspaceId, title);
  };

  w.__wmux_listWorkspaces = () => {
    const store = useStore.getState();
    return store.workspaces.map(ws => ({
      id: ws.id,
      title: ws.title,
      isActive: ws.id === store.activeWorkspaceId,
      cwd: ws.cwd,
      shell: ws.shell,
    }));
  };

  // Which workspace owns a given surface? Used by main to route browser commands
  // to a browser pane in the *caller agent's* workspace (issue #62). Returns the
  // active workspace id as a fallback when the surface isn't found.
  w.__wmux_getWorkspaceIdForSurface = (surfaceId: string) => {
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const leaf = findLeaf(ws.splitTree, paneId);
        if (leaf?.surfaces?.some(s => s.id === surfaceId)) return ws.id;
      }
    }
    return store.activeWorkspaceId ?? null;
  };

  // All browser surface ids in a workspace. Main adopts an unbound one for a
  // caller (or creates a fresh pane) so each agent gets its own browser (#62).
  w.__wmux_listBrowserSurfaces = (workspaceId: string) => {
    const store = useStore.getState();
    const ws = store.workspaces.find(x => x.id === workspaceId);
    if (!ws) return [];
    const ids: string[] = [];
    for (const paneId of getAllPaneIds(ws.splitTree)) {
      const leaf = findLeaf(ws.splitTree, paneId);
      for (const s of leaf?.surfaces ?? []) {
        if (s.type === 'browser') ids.push(s.id);
      }
    }
    return ids;
  };

  // ─── Pane ───────────────────────────────────────────────────────────────────

  w.__wmux_splitPane = (params?: { direction?: string; type?: string; workspaceId?: string; colorScheme?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;

    const paneIds = getAllPaneIds(ws.splitTree);
    const targetPaneId = paneIds[0];
    if (!targetPaneId) return null;

    const newPaneId = `pane-${uuid()}` as PaneId;
    const surfaceType = (params?.type || 'terminal') as SurfaceType;
    const direction = params?.direction === 'down' || params?.direction === 'vertical'
      ? 'vertical' : 'horizontal';

    const newTree = splitNode(ws.splitTree, targetPaneId, newPaneId, surfaceType, direction);
    store.updateSplitTree(wsId, newTree);

    const newLeaf = findLeaf(newTree, newPaneId);
    const surfaceId = newLeaf?.surfaces?.[0]?.id || null;

    // Apply a per-pane color scheme override to the freshly-created surface
    // so `wmux split --color-scheme prod` takes effect immediately.
    if (params?.colorScheme && surfaceId && newLeaf) {
      store.updateSurface(wsId, newPaneId, surfaceId as SurfaceId, { colorScheme: params.colorScheme });
    }

    return { paneId: newPaneId, surfaceId };
  };

  w.__wmux_closePane = (paneId: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return;

    // Reaping + tree surgery live in the store action (issue #65 fixed the
    // missing reap here; the last-pane case was still wrong in all three copies).
    store.closePane(wsId, paneId as PaneId);
  };

  w.__wmux_layoutGrid = (params: { count: number; type?: string; anchorSurfaceId?: string; anchorPaneId?: string; workspaceId?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;

    const count = Math.max(1, Math.floor(params.count || 1));
    if (count < 2) return { newPaneIds: [], newPanes: [] };

    // Resolve the anchor pane: explicit paneId > surface lookup > first pane
    const paneIds = getAllPaneIds(ws.splitTree);
    let anchorPaneId: PaneId | undefined;

    if (params.anchorPaneId) {
      anchorPaneId = params.anchorPaneId as PaneId;
    } else if (params.anchorSurfaceId) {
      for (const pid of paneIds) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces?.some(s => s.id === params.anchorSurfaceId)) {
          anchorPaneId = pid;
          break;
        }
      }
    }
    if (!anchorPaneId) anchorPaneId = paneIds[0];
    if (!anchorPaneId) return null;

    const surfaceType = (params.type || 'terminal') as SurfaceType;
    const { tree: newTree, newPaneIds } = buildGridLayout(ws.splitTree, anchorPaneId, count, surfaceType);
    store.updateSplitTree(wsId, newTree);

    // Resolve surface IDs for the newly-created panes so callers can target them directly.
    const newPanes = newPaneIds.map(pid => {
      const leaf = findLeaf(newTree, pid);
      return {
        paneId: pid,
        surfaceId: leaf?.surfaces?.[0]?.id || null,
      };
    });

    return { newPaneIds, newPanes, anchorPaneId, cols: Math.ceil(Math.sqrt(count)), rows: Math.ceil(count / Math.ceil(Math.sqrt(count))) };
  };

  w.__wmux_listPanes = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return [];

    const paneIds = getAllPaneIds(ws.splitTree);
    return paneIds.map(pid => {
      const leaf = findLeaf(ws.splitTree, pid);
      return {
        paneId: pid,
        surfaces: leaf?.surfaces?.map(s => ({ id: s.id, type: s.type })) || [],
        tabCount: leaf?.surfaces?.length || 0,
        activeSurfaceIndex: leaf?.activeSurfaceIndex ?? 0,
      };
    });
  };

  // ─── Surface ────────────────────────────────────────────────────────────────

  w.__wmux_createSurface = (params?: { type?: string; paneId?: string; workspaceId?: string; colorScheme?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;

    let paneId = params?.paneId as PaneId | undefined;
    if (!paneId) {
      const ws = store.workspaces.find(w => w.id === wsId);
      if (!ws) return null;
      const paneIds = getAllPaneIds(ws.splitTree);
      paneId = paneIds[0];
    }
    if (!paneId) return null;

    const type = (params?.type || 'terminal') as SurfaceType;
    const surfaceId = store.addSurface(wsId, paneId, type, { colorScheme: params?.colorScheme });
    if (!surfaceId) return null;
    return { surfaceId, paneId };
  };

  /**
   * Update an existing surface's color scheme. Lets users switch a running
   * pane to "prod" mid-session via `wmux surface set-color-scheme <id> prod`.
   */
  w.__wmux_setSurfaceColorScheme = (surfaceId: string, colorScheme: string | null) => {
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      const paneIds = getAllPaneIds(ws.splitTree);
      for (const pid of paneIds) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
          store.updateSurface(ws.id, pid, surfaceId as SurfaceId, {
            colorScheme: colorScheme || undefined,
          });
          return { ok: true };
        }
      }
    }
    return { ok: false, error: 'Surface not found' };
  };

  w.__wmux_closeSurface = (surfaceId: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return;
    const paneIds = getAllPaneIds(ws.splitTree);
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
        store.closeSurface(wsId, pid, surfaceId as SurfaceId);
        return;
      }
    }
  };

  w.__wmux_renameSurface = (surfaceId: string, title: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return { ok: false, error: 'No active workspace' };
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return { ok: false, error: 'Workspace not found' };
    const paneIds = getAllPaneIds(ws.splitTree);
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
        store.renameSurface(wsId, pid, surfaceId as SurfaceId, title ?? '');
        return { ok: true };
      }
    }
    return { ok: false, error: 'Surface not found' };
  };

  w.__wmux_focusSurface = (surfaceId: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return;
    const paneIds = getAllPaneIds(ws.splitTree);
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces) {
        const idx = leaf.surfaces.findIndex(s => s.id === surfaceId);
        if (idx >= 0) {
          store.selectSurface(wsId, pid, idx);
          return;
        }
      }
    }
  };

  w.__wmux_listSurfaces = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return [];

    const paneIds = getAllPaneIds(ws.splitTree);
    const surfaces: Array<{ id: string; type: string; paneId: string; isActive: boolean }> = [];
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces) {
        leaf.surfaces.forEach((s, idx) => {
          surfaces.push({
            id: s.id,
            type: s.type,
            paneId: pid,
            isActive: idx === leaf.activeSurfaceIndex,
          });
        });
      }
    }
    return surfaces;
  };

  w.__wmux_getActiveSurfaceId = () => {
    const store = useStore.getState();
    const wsId = store.activeWorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;
    const paneIds = getAllPaneIds(ws.splitTree);
    if (paneIds.length === 0) return null;
    const leaf = findLeaf(ws.splitTree, paneIds[0]);
    if (!leaf?.surfaces?.length) return null;
    const idx = leaf.activeSurfaceIndex ?? 0;
    return leaf.surfaces[idx]?.id || null;
  };

  // Main-process send/send-key callers feed the same draft tracker as local
  // xterm input. Only Enter after real text can displace an AI decision.
  w.__wmux_handleTerminalUserInput = (surfaceId: string, data: string) => {
    const id = String(surfaceId || '');
    if (!surfaceTerminalRegistry.has(id)) {
      return { handled: false, clearAutomatedDraft: false };
    }
    const preparation = prepareForUserTerminalInput(id, String(data || ''), false);
    return {
      handled: preparation.shouldSubmit ? handleSupervisorUserSubmit(id) : false,
      clearAutomatedDraft: preparation.clearAutomatedDraft,
    };
  };

  // Read a terminal's screen as plain text (surface.read_text / read-screen).
  // Reads the ACTIVE xterm buffer — alt buffer included, so a full-screen TUI
  // returns what is actually visible. `lines` counts back from the bottom of
  // the buffer (scrollback included); trailing blank lines are trimmed.
  w.__wmux_readScreen = (surfaceId?: string, lines?: number) => {
    const id = surfaceId || w.__wmux_getActiveSurfaceId?.();
    if (!id) return { error: 'No active surface' };
    return readTerminalScreen(id, lines ?? 50);
  };

  const surfaceInCurrentWindow = (surfaceId: string) => {
    const state = useStore.getState();
    for (const workspace of state.workspaces) {
      for (const paneId of getAllPaneIds(workspace.splitTree)) {
        const surface = findLeaf(workspace.splitTree, paneId)?.surfaces
          .find((candidate) => candidate.id === surfaceId);
        if (surface) return surface;
      }
    }
    return undefined;
  };

  w.__wmux_hasSurface = (surfaceId: string) => !!surfaceInCurrentWindow(String(surfaceId || ''));

  w.__wmux_authorizeSurfaceCapability = (request: any) => {
    const callerSurfaceId = String(request?.callerSurfaceId || '').trim();
    const surface = surfaceInCurrentWindow(callerSurfaceId);
    if (!surface) return { knownSurface: false };
    const state = useStore.getState();
    const supervisorLane = state.supervisor.lanes.find(
      (lane) => lane.supervisorSurfaceId === callerSurfaceId,
    );
    const managerProject = state.projectManagers.find((project) => (
      project.managerSurfaceId === callerSurfaceId
      && surface.projectManagerTerminal === true
      && surface.projectManagerProjectId === project.id
    ));
    const taskLane = state.supervisor.lanes.find((lane) => lane.surfaceId === callerSurfaceId);
    const projectTask = surface.projectManagerProjectId
      ? state.projectManagers.find((project) => project.id === surface.projectManagerProjectId)
      : undefined;
    const projectWorkItem = projectTask?.workItems.find((item) => (
      item.id === surface.projectManagerWorkItemId && item.workerSurfaceId === callerSurfaceId
    ));
    const binding = supervisorLane || surface.transientSupervisor || surface.projectSupervisorProjectId ? {
      role: supervisorLane?.projectManagerProjectId || surface.projectSupervisorProjectId
        ? 'project-supervisor' as const
        : 'supervisor' as const,
      callerSurfaceId,
      targetSurfaceId: supervisorLane?.surfaceId,
      projectId: supervisorLane?.projectManagerProjectId || surface.projectSupervisorProjectId,
      workItemId: supervisorLane?.projectWorkItemId,
    } : managerProject || surface.projectManagerTerminal ? {
      role: 'project-ai' as const,
      callerSurfaceId,
      projectId: managerProject?.id || surface.projectManagerProjectId,
    } : taskLane || projectWorkItem || surface.projectManagerProjectId ? {
      role: projectWorkItem || surface.projectManagerProjectId ? 'project-task' as const : 'task' as const,
      callerSurfaceId,
      targetSurfaceId: callerSurfaceId,
      projectId: projectTask?.id || surface.projectManagerProjectId,
      workItemId: projectWorkItem?.id || surface.projectManagerWorkItemId,
    } : null;
    if (!binding) return { knownSurface: true, managed: false, allowed: true };
    return {
      knownSurface: true,
      managed: true,
      ...authorizeManagedRoleV2(binding, String(request?.method || ''), request?.params || {}),
    };
  };

  const supervisorContextForCaller = (callerSurfaceId: string) => {
    const state = useStore.getState();
    const lane = state.supervisor.lanes.find((item) => (
      item.supervisorSurfaceId === callerSurfaceId
      && supervisorLaneControlState(item) !== 'stopped'
    ));
    if (!callerSurfaceId || !lane) {
      return { ok: false, error: '当前终端不是活动监督 lane 绑定的监督 AI，无法读取监督上下文' };
    }
    const project = lane.projectManagerProjectId
      ? state.projectManagers.find((item) => item.id === lane.projectManagerProjectId)
      : undefined;
    const workItem = project?.workItems.find((item) => item.id === lane.projectWorkItemId);
    if (lane.projectManagerProjectId && (
      !project
      || !workItem
      || workItem.supervisorLaneId !== lane.id
    )) {
      return { ok: false, error: '项目监督绑定不完整、已过期或与工作项不一致，无法生成可执行能力清单' };
    }
    const taskAgentState = (w.__wmux_getAgentStates?.()?.[lane.surfaceId] || undefined) as SupervisorAgentStateView | undefined;
    const taskState = String(taskAgentState?.state || 'unknown');
    return buildSupervisorRuntimeContext(state.supervisor, lane, {
      taskState,
      permissionBlocked: isPermissionBlockedState(taskAgentState),
      ...(project && workItem ? {
        project: {
          projectId: project.id,
          goalId: workItem.goalId,
          workItemId: workItem.id,
          requirementsVersion: workItem.requirementsVersion ?? projectRequirementsVersion(project),
          authorizationVersion: workItem.authorizationVersion ?? projectAuthorizationVersion(project),
          authority: workItem.contract.authority,
          decisionsUsed: workItem.decisionsUsed,
          maxDecisions: workItem.contract.budget.maxDecisions,
          attempts: workItem.attempts,
          maxTaskRetries: workItem.contract.budget.maxTaskRetries,
          projectStatus: project.status,
          workItemStatus: workItem.status,
          bindingCurrent: project.status === 'active'
            && projectAcceptedRequirementsVersion(project) === projectRequirementsVersion(project)
            && workItem.goalId === activeProjectGoal(project).id
            && !['completed', 'stopped'].includes(workItem.status)
            && workItem.requirementsVersion === projectRequirementsVersion(project)
            && workItem.authorizationVersion === projectAuthorizationVersion(project)
            && !projectWorkItemSubgoalDependencyError(project, workItem),
          baselineApproved: projectTaskBaselineApproved(workItem),
          dependencyError: projectWorkItemSubgoalDependencyError(project, workItem) || undefined,
          supervisorPlan: workItem.supervisorPlan,
        },
      } : {}),
    });
  };

  const roleContextForCaller = (callerSurfaceId: string) => {
    if (!callerSurfaceId) {
      return { ok: false, error: 'wmux context 只能在带有实时 surface capability 的 wmux 终端中运行' };
    }
    const state = useStore.getState();
    const supervisorLane = state.supervisor.lanes.find((item) => (
      item.supervisorSurfaceId === callerSurfaceId
      && supervisorLaneControlState(item) !== 'stopped'
    ));
    if (supervisorLane) return supervisorContextForCaller(callerSurfaceId);

    const managerProject = state.projectManagers.find((item) => item.managerSurfaceId === callerSurfaceId);
    const managerTerminal = managerProject
      ? projectManagerTerminal({ surfaceId: callerSurfaceId, projectId: managerProject.id })
      : null;
    if (managerProject && managerTerminal) {
      const pendingSupervisorApprovals = state.supervisor.pendingApprovals.filter((approval) => {
        const lane = state.supervisor.lanes.find((item) => item.id === approval.laneId);
        return lane?.projectManagerProjectId === managerProject.id;
      }).length;
      return buildProjectAiRuntimeContext(managerProject, {
        pendingSupervisorApprovals,
        runtime: {
          agent: managerTerminal.surface.projectManagerAgent,
          model: managerTerminal.surface.projectManagerModel,
          reasoningEffort: managerTerminal.surface.projectManagerReasoningEffort,
        },
      });
    }

    const taskTerminal = locateRemoteTaskTerminal(callerSurfaceId).terminal;
    if (!taskTerminal) {
      return { ok: false, error: '当前 surface 不是可识别的项目 AI、监督 AI 或受监督任务 AI 终端' };
    }
    const taskLane = state.supervisor.lanes.find((item) => (
      item.surfaceId === callerSurfaceId
      && supervisorLaneControlState(item) !== 'stopped'
    ));
    const projectId = taskLane?.projectManagerProjectId
      || taskTerminal.surface.projectManagerProjectId;
    if (taskLane?.projectManagerProjectId
      && taskTerminal.surface.projectManagerProjectId
      && taskLane.projectManagerProjectId !== taskTerminal.surface.projectManagerProjectId) {
      return { ok: false, error: '任务终端与监督 lane 的项目绑定不一致，无法生成任务上下文' };
    }
    const project = projectId
      ? state.projectManagers.find((item) => item.id === projectId)
      : undefined;
    const workItemId = taskLane?.projectWorkItemId
      || taskTerminal.surface.projectManagerWorkItemId;
    if (taskLane?.projectWorkItemId
      && taskTerminal.surface.projectManagerWorkItemId
      && taskLane.projectWorkItemId !== taskTerminal.surface.projectManagerWorkItemId) {
      return { ok: false, error: '任务终端与监督 lane 的工作项绑定不一致，无法生成任务上下文' };
    }
    const workItem = project?.workItems.find((item) => (
      item.id === workItemId && item.workerSurfaceId === callerSurfaceId
    ));
    if (projectId && (
      !project
      || !workItem
      || !taskLane
      || workItem.supervisorLaneId !== taskLane.id
    )) {
      return { ok: false, error: '项目任务终端绑定不完整、已过期或与工作项不一致，无法生成任务上下文' };
    }
    const taskState = String(w.__wmux_getAgentStates?.()?.[callerSurfaceId]?.state || 'unknown');
    if (project && workItem) {
      return buildTaskAiRuntimeContext({
        callerSurfaceId,
        taskState,
        lane: taskLane,
        project,
        workItem,
        runtime: {
          agent: taskTerminal.surface.projectManagerAgent,
          model: taskTerminal.surface.projectManagerModel,
          reasoningEffort: taskTerminal.surface.projectManagerReasoningEffort,
        },
      });
    }
    if (taskLane) {
      return buildTaskAiRuntimeContext({ callerSurfaceId, taskState, lane: taskLane });
    }
    return { ok: false, error: '当前终端未绑定活动监督 lane 或项目工作项，无法确认任务 AI 身份' };
  };

  w.__wmux_roleContext = (params: any) => (
    roleContextForCaller(String(params?.callerSurfaceId || '').trim())
  );

  w.__wmux_supervisorContext = (params: any) => {
    const context = roleContextForCaller(String(params?.callerSurfaceId || '').trim());
    if (context.ok === false) return context;
    return 'role' in context && (context.role === 'supervisor' || context.role === 'project-supervisor')
      ? context
      : { ok: false, error: '当前终端不是活动监督 lane 绑定的监督 AI，无法读取监督上下文' };
  };

  // The dedicated supervisor terminal records its judgment through a silent CLI
  // call. Routing by surfaceId, not display label, keeps duplicate tab names
  // distinct inside the same workspace/session.
  w.__wmux_supervisorDecide = (params: any) => {
    const store = useStore.getState();
    const session = store.supervisor;
    const surfaceId = String(params?.surfaceId || '');
    const supervisorSurfaceId = String(params?.supervisorSurfaceId || '');
    const outcome = String(params?.outcome || '') as SupervisorDecision['outcome'];
    const reason = String(params?.reason || '').trim().slice(0, 1200);
    const next = String(params?.next || '').trim();
    const rawNextFile = String(params?.nextFile || '').trim().replace(/\\/g, '/');
    const nextFile = /^\.wmux\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(rawNextFile)
      ? rawNextFile
      : '';
    const rawStagePlanFile = String(params?.stagePlanFile || '').trim().replace(/\\/g, '/');
    const stagePlanFile = /^\.wmux\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(rawStagePlanFile)
      ? rawStagePlanFile
      : '';
    const proposalKind = String(params?.proposalKind || '').trim();
    const rawEscalationBoundary = String(params?.escalationBoundary || '').trim();
    const escalationBoundary = PROJECT_ESCALATION_BOUNDARIES.has(rawEscalationBoundary as ProjectEscalationBoundary)
      ? rawEscalationBoundary as ProjectEscalationBoundary
      : undefined;
    const impact = String(params?.impact || '').trim().slice(0, 1200);
    const alternatives = String(params?.alternatives || '').trim().slice(0, 1200);
    const permissionCommand = String(params?.permissionCommand || '').trim().slice(0, 2000);
    const permissionResponse = String(params?.permissionResponse || '').trim().slice(0, 16);
    const executionError = String(params?.error || '').trim();
    const changedFiles = projectStringArray(params?.changedFiles);
    const testCommand = String(params?.testCommand || '').trim();
    const testResult = String(params?.testResult || '').trim();
    const diffSummary = String(params?.diffSummary || '').trim();
    const evidence = String(params?.evidence || '').trim();
    const contextSummary = String(params?.contextSummary || '').trim();
    const completionStopWhen = String(params?.completionStopWhen || '').trim().slice(0, 500);
    const completionValidation = String(params?.completionValidation || '').trim().slice(0, 500);
    const remainingWork = String(params?.remainingWork || '').trim().slice(0, 2000);
    const reviewId = String(params?.reviewId || '').trim().slice(0, 200);
    const retryRequested = params?.retry === true
      || ((outcome === 'continue' || outcome === 'rework') && !!executionError);
    const valid = new Set(['continue', 'rework', 'complete', 'needs-human']);
    const proposalKinds = new Set(['route-change', 'important', 'context-recovery']);
    const lane = session.lanes.find((item) => item.surfaceId === surfaceId);
    if (!session.active || !lane || !isSupervisorDecisionAuthorised(lane, supervisorSurfaceId) || !valid.has(outcome)) return null;
    if (rawNextFile && !nextFile) {
      return { ok: false, error: '--next-file 必须是当前项目 .wmux/tmp/ 下的单个安全文件名' };
    }
    if (rawStagePlanFile && !stagePlanFile) {
      return { ok: false, error: '--stage-plan-file 必须是当前项目 .wmux/tmp/ 下的单个安全 JSON 文件名' };
    }
    if (params?.stagePlan !== undefined && !stagePlanFile) {
      return { ok: false, error: '监督阶段计划只能通过 --stage-plan-file 提交，不能绕过受控临时文件边界' };
    }
    if (rawEscalationBoundary && !escalationBoundary) {
      return { ok: false, error: '无效 escalation-boundary；必须使用控制层定义的项目升级边界' };
    }
    if (next.length > 64_000) return { ok: false, error: '任务指令文件不得超过 64000 字符' };
    if (!nextFile && next.length > 4_000) {
      return { ok: false, error: '内联 --next 不得超过 4000 字符；请改用 .wmux/tmp/ 下的 --next-file' };
    }
    const laneState = supervisorLaneControlState(lane);
    if (laneState !== 'active') return { ok: false, error: laneState === 'paused' ? '当前监督通道已暂停' : '当前监督通道已停止' };
    const projectManagedLane = isProjectManagedSupervisorLane(lane);
    if (!projectManagedLane && lane.activeReviewId && reviewId !== lane.activeReviewId) {
      return {
        ok: false,
        error: reviewId
          ? 'reviewId 已过期或不属于当前任务回合；请重新运行 wmux context 获取当前复核 ID'
          : `当前复核必须附 --review-id ${lane.activeReviewId}，避免迟到裁决覆盖新任务回合`,
      };
    }
    if (!projectManagedLane && !lane.activeReviewId && reviewId) {
      return { ok: false, error: '当前没有与该 reviewId 对应的待裁决轮次；请等待新的监督事件' };
    }
    const projectSession = lane.projectManagerProjectId
      ? store.projectManagers.find((candidate) => candidate.id === lane.projectManagerProjectId)
      : undefined;
    const projectWorkItem = lane.projectWorkItemId
      ? projectSession?.workItems.find((item) => item.id === lane.projectWorkItemId)
      : undefined;
    let pendingProjectExecutionRecord: ProjectExecutionRecord | undefined;
    let proposedSupervisorPlan: ProjectSupervisorStagePlan | undefined;
    const recordProjectExecution = (consumeDecision: boolean) => {
      if (!projectSession || !projectWorkItem || !pendingProjectExecutionRecord) return;
      store.applyProjectManagerAction({
        type: 'record-execution',
        workItemId: projectWorkItem.id,
        record: pendingProjectExecutionRecord,
        consumeDecision,
      }, projectSession.id);
      pendingProjectExecutionRecord = undefined;
    };
    const applyProposedSupervisorPlan = () => {
      if (!projectSession || !projectWorkItem || !proposedSupervisorPlan) return;
      store.applyProjectManagerAction({
        type: 'update-work-item',
        workItemId: projectWorkItem.id,
        patch: { supervisorPlan: proposedSupervisorPlan },
      }, projectSession.id);
    };
    if (projectManagedLane && (
      !lane.projectManagerProjectId
      || !lane.projectWorkItemId
      || !projectSession
      || !projectWorkItem
      || projectWorkItem.supervisorLaneId !== lane.id
    )) {
      const bindingError = '项目监督绑定不完整、已过期或与工作项不一致；已暂停该通道，禁止回退到当前选中项目继续裁决';
      store.pauseSupervisorLane(lane.id, bindingError);
      store.appendSupervisorLog(lane.id, '项目绑定校验失败', bindingError);
      return { ok: false, error: bindingError };
    }
    if (projectManagedLane && projectSession?.status !== 'active') {
      const statusError = '项目当前未处于 active 状态；已暂停该监督通道，禁止沿用旧任务合同继续裁决';
      store.pauseSupervisorLane(lane.id, statusError);
      store.appendSupervisorLog(lane.id, '项目状态校验失败', statusError);
      return { ok: false, error: statusError };
    }
    const projectTaskBindingError = projectManagedLane && projectSession && projectWorkItem
      ? projectWorkItem.goalId !== activeProjectGoal(projectSession).id
        ? '项目监督绑定的任务不属于当前主目标'
        : ['completed', 'stopped'].includes(projectWorkItem.status)
          ? '项目监督绑定的任务已经结束'
          : projectWorkItem.requirementsVersion !== projectRequirementsVersion(projectSession)
            || projectWorkItem.authorizationVersion !== projectAuthorizationVersion(projectSession)
            ? '项目需求或前置条件已经更新，旧版本授权已经失效'
            : projectWorkItem.subgoalId
              ? projectWorkItemSubgoalDependencyError(projectSession, projectWorkItem)
              : null
      : null;
    if (projectTaskBindingError) {
      const contractError = `${projectTaskBindingError}；已暂停该通道，等待项目 AI 重新派发`;
      store.pauseSupervisorLane(lane.id, contractError);
      store.appendSupervisorLog(lane.id, '项目任务合同校验失败', contractError);
      return { ok: false, error: contractError };
    }
    if (projectManagedLane && outcome === 'needs-human') {
      if (!escalationBoundary) {
        return { ok: false, error: '项目专属监督升级项目 AI 时必须提供 --escalation-boundary，普通技术选择应由监督 AI 自主处理' };
      }
      if (!reason || !impact) {
        return { ok: false, error: '项目专属监督升级时必须同时提供事实化的 --reason 和边界影响 --impact' };
      }
      if (escalationBoundary === 'budget-exhausted' && projectWorkItem) {
        const budget = projectWorkItem.contract.budget;
        const elapsedBudgetReached = projectWorkItem.startedAt !== undefined
          && Date.now() - projectWorkItem.startedAt >= budget.maxContinuousMinutes * 60_000;
        if (projectWorkItem.decisionsUsed + 1 < budget.maxDecisions
          && projectWorkItem.attempts < budget.maxTaskRetries
          && !elapsedBudgetReached) {
          return { ok: false, error: '当前阶段预算尚未耗尽，不能使用 budget-exhausted 绕过监督 AI 的自主推进责任' };
        }
      }
    } else if (rawEscalationBoundary) {
      return { ok: false, error: '--escalation-boundary 仅用于项目专属监督的 needs-human 裁决' };
    }
    if (outcome !== 'needs-human' && session.pendingApprovals.some((approval) => approval.laneId === lane.id)) {
      return { ok: false, error: lane.projectManagerProjectId
        ? '当前通道仍有待项目管理 AI 处理的决策项；补充意见只用于更新上下文，不能绕过项目管理 AI 自动继续'
        : '当前通道仍有待用户决策项；补充意见只用于更新上下文，不能绕过用户自动继续' };
    }
    const autonomous = effectiveSupervisorAutonomous(session, lane);
    const remoteSshControl = isRemoteSshControlledLane(lane, store.workspaces);
    const laneConfig = effectiveSupervisorLaneConfig(lane);
    if (lane.autoDecisionLimitReached && !autonomous) {
      return { ok: false, error: '已达到自动判断上限，等待人工审阅后继续' };
    }
    // A supervisor must not smuggle a declared route/important proposal through
    // an auto-continue decision. Such proposals always stop for user consent.
    if (!isSupervisorProposalAllowed(outcome, proposalKind)) {
      return { ok: false, error: '小范围路线调整须使用 route-adjustment 配合 continue/rework；重大路线变更、重要建议或待续方向不足必须使用对应 proposal-kind 配合 needs-human' };
    }
    if (proposalKind === 'direction-needed' && !(
      lane.awaitingDirectionAfterWaitingResume
      && laneConfig.waitForNextDirection
    )) {
      return { ok: false, error: 'direction-needed 仅可用于待续恢复后新方向仍不足的通道' };
    }
    if (proposalKind === 'context-recovery') {
      if (lane.contextRecoveryStatus !== 'draft-pending') {
        return { ok: false, error: '当前通道没有等待拟定的上下文恢复指令' };
      }
      if (!next) {
        return { ok: false, error: '上下文恢复提案必须通过 --next 提供可直接发送的完整恢复指令' };
      }
    }
    if (proposalKind === 'route-adjustment' && !next) {
      return { ok: false, error: 'route-adjustment 必须携带明确的低风险 --next' };
    }
    if (!isSupervisorNextAllowed(outcome, next)) {
      return { ok: false, error: '只有 continue、rework 或 needs-human 可以携带 --next' };
    }
    if (
      (outcome === 'continue' || outcome === 'rework')
      && !next
      && !permissionCommand
      && !permissionResponse
    ) {
      return { ok: false, error: '统一监督的 continue/rework 必须携带明确的 --next；无法安全推进时请使用 needs-human' };
    }
    const preparedProjectTask = next && projectSession && projectWorkItem
      ? prepareProjectTaskDelivery(
          projectWorkItem.contract,
          next,
          lane.projectTaskContractPending === true,
          projectExecutionIdentity(projectSession, projectWorkItem),
        )
      : null;
    const guardedNext = preparedProjectTask?.action ?? next;
    const projectBaselineApprovalRequested = !!projectWorkItem
      && !projectTaskBaselineApproved(projectWorkItem)
      && guardedNext.includes(PROJECT_TASK_BASELINE_APPROVAL_MARKER);
    const projectBaselineInvestigationRequested = !!projectWorkItem
      && !projectTaskBaselineApproved(projectWorkItem)
      && guardedNext.startsWith(PROJECT_TASK_BASELINE_INVESTIGATION_MARKER);
    const projectBaselineError = projectWorkItem
      ? projectTaskBaselineViolation(projectWorkItem, {
          outcome,
          instruction: guardedNext,
          changedFiles,
          testCommand: testCommand || undefined,
          fullSuite: params?.fullSuite === true,
          retry: retryRequested,
          permissionResponse,
          evidence,
          workspaceVersion: String(params?.workspaceVersion || ''),
          escalationBoundary,
        })
      : null;
    if (projectBaselineError) {
      store.updateLane(lane.id, { awaitingReview: true });
      store.appendSupervisorLog(lane.id, '项目基线门禁阻止裁决', projectBaselineError);
      return { ok: false, error: projectBaselineError };
    }
    if (params?.stagePlan !== undefined) {
      if (!projectSession || !projectWorkItem || outcome === 'needs-human' || permissionResponse) {
        return { ok: false, error: '--stage-plan-file 仅用于项目专属监督的 continue/rework/complete 裁决' };
      }
      const normalizedPlan = normalizeSupervisorStagePlan(params.stagePlan, projectWorkItem);
      if (!normalizedPlan.plan) return { ok: false, error: normalizedPlan.error };
      proposedSupervisorPlan = normalizedPlan.plan;
    }
    if (projectWorkItem?.supervisorPlanRequired === true && (
      projectBaselineApprovalRequested
      || (projectTaskBaselineApproved(projectWorkItem)
        && !permissionResponse
        && (outcome === 'continue' || outcome === 'rework'))
    ) && !proposedSupervisorPlan && !projectWorkItem.supervisorPlan) {
      return {
        ok: false,
        error: '基线调查后必须由监督 AI 通过 --stage-plan-file 建立 selectedRoute、milestones、expectedPaths、targetedValidation、serializedBoundaries 和 remainingWork；项目 AI 只定义硬边界，不代替监督拆微任务',
      };
    }
    const remoteNextBlockReason = remoteSshControl ? remoteSshActionBlockReason(guardedNext) : null;
    if (outcome !== 'needs-human' && remoteNextBlockReason) {
      return { ok: false, error: `SSH 远程控制终端禁止自动执行${remoteNextBlockReason}；请使用 needs-human 交给人工处理` };
    }
    const nextBlockReason = autonomousActionBlockReason(guardedNext);
    if (outcome !== 'needs-human' && nextBlockReason) {
      return { ok: false, error: `监督 AI 禁止自动执行${nextBlockReason}；请使用 needs-human 交给人工处理` };
    }
    const forbiddenActions = effectiveSupervisorForbiddenActions(session, lane);
    const configuredNextBlockReason = configuredActionBlockReason(guardedNext, forbiddenActions);
    if (outcome !== 'needs-human' && configuredNextBlockReason) {
      return { ok: false, error: `该动作命中用户勾选的禁止事项：${configuredNextBlockReason}；请使用 needs-human` };
    }
    const effectiveWorkScope = effectiveSupervisorWorkScope(session, lane);
    const scopeBlockReason = workScopeBlockReason(
      guardedNext,
      effectiveWorkScope,
      lane.scopeRoot || lane.projectDir,
    );
    if (outcome !== 'needs-human' && scopeBlockReason) {
      return { ok: false, error: `${scopeBlockReason}；超出工作范围的动作必须使用 needs-human` };
    }
    if (
      next
      && outcome !== 'needs-human'
      && effectiveWorkScope === 'plan-defined'
      && !laneConfig.planFilePath.trim()
    ) {
      return { ok: false, error: '工作范围设为“仅计划文件定义范围”，但当前没有计划文件；请补充计划文件或使用 needs-human' };
    }
    const hasTaskContext = !!(
      effectiveSupervisorTaskGoal(lane)
      || lane.currentTask?.trim()
      || laneConfig.planFilePath.trim()
    );
    if (next && outcome !== 'needs-human' && !hasTaskContext) {
      return { ok: false, error: '当前没有任务目标、已捕获任务或计划文件；可继续停止裁决，但自主发送下一步必须交给人工' };
    }
    if (permissionCommand || permissionResponse) {
      if (remoteSshControl) {
        return { ok: false, error: 'SSH 远程控制终端的权限请求必须由人工确认，监督 AI 不得自动发送批准响应' };
      }
      const permissionBlockReason = autonomousActionBlockReason(permissionCommand);
      const configuredPermissionBlockReason = configuredActionBlockReason(permissionCommand, forbiddenActions);
      if (!permissionCommand || !isAutonomousPermissionResponseAllowed(permissionResponse)) {
        return { ok: false, error: '权限确认必须提供命令说明，并且响应只能是 y、yes、allow 或 approve' };
      }
      if (permissionBlockReason) {
        return { ok: false, error: `监督 AI 禁止自动确认${permissionBlockReason}；请交给人工确认` };
      }
      if (configuredPermissionBlockReason) {
        return { ok: false, error: `权限请求命中用户勾选的禁止事项：${configuredPermissionBlockReason}；请交给人工确认` };
      }
      const permissionScopeBlockReason = workScopeBlockReason(
        permissionCommand,
        effectiveWorkScope,
        lane.scopeRoot || lane.projectDir,
      );
      if (permissionScopeBlockReason) {
        return { ok: false, error: `${permissionScopeBlockReason}；该权限请求必须交给人工确认` };
      }
      if (outcome === 'complete' || outcome === 'needs-human') {
        return { ok: false, error: '终端权限确认只能与 continue 或 rework 裁决一起提交' };
      }
      if (next) {
        return { ok: false, error: '终端权限确认后需等待代理恢复；请不要在同一裁决中追加 --next' };
      }
    }
    const agentState = ((w.__wmux_getAgentStates?.() || {})[surfaceId] || undefined) as SupervisorAgentStateView | undefined;
    const proactiveProjectFollowUp = !lane.awaitingReview
      && !!lane.projectManagerProjectId
      && autonomous
      && (outcome === 'continue' || outcome === 'rework')
      && !!next
      && !permissionCommand
      && !permissionResponse;
    const preflight = evaluateSupervisorDecisionPreflight(session, lane, {
      taskState: agentState?.state || 'unknown',
      ...(projectManagedLane ? { project: { projectId: projectSession!.id, workItemId: projectWorkItem!.id, bindingCurrent: true } } : {}),
      outcome,
      hasNext: !!next,
      permissionRequested: !!permissionCommand || !!permissionResponse,
    });
    if (!preflight.decisionReady) {
      return { ok: false, error: lane.projectManagerProjectId
        ? `${preflight.blockers[0] || '当前没有待裁决轮次'}；项目专属监督仅可在任务终端非运行时，携带明确的低风险 --next 主动提交 continue/rework`
        : `${preflight.blockers[0] || '当前没有待裁决轮次'}；请等待工作终端任务结束或权限阻塞通知` };
    }
    if (proactiveProjectFollowUp && lane.decisions?.[0]?.outcome === outcome
      && lane.decisions[0].next.trim() === next && !retryRequested) {
      return { ok: false, error: '该主动补证指令与上一条裁决完全相同；请等待状态变化，或在有新失败证据时显式标记 retry' };
    }
    const selectedPermissions = selectedAutonomyPermissions(
      effectiveSupervisorAutonomyPermissions(session, lane),
    );
    const requiredPermissions = requiredAutonomyPermissions({
      outcome,
      next: guardedNext,
      proposalKind,
      permissionCommand,
      permissionResponse,
      agentState,
    });
    const missingPermissions = requiredPermissions.filter((permission) => !selectedPermissions.includes(permission));
    if (missingPermissions.length > 0) {
      const labels = missingPermissions.map((permission) => AUTONOMY_PERMISSION_LABELS[permission]).join('、');
      return { ok: false, error: `当前会话未授予“${labels}”；请使用 needs-human 交给人工处理` };
    }
    if (permissionCommand || permissionResponse) {
      if (!isPermissionBlockedState(agentState)) {
        return { ok: false, error: '未检测到可自动确认的真实权限阻塞；状态未知或普通输入必须交给人工' };
      }
      const terminalEvidence = terminalScreenTail(surfaceId);
      if (!terminalEvidence) {
        return { ok: false, error: '无法读取当前终端中的具体权限命令；不能仅凭 Hook 泛化原因自动确认' };
      }
      if (!permissionCommandMatchesEvidence(permissionCommand, terminalEvidence)) {
        return { ok: false, error: '权限命令与当前终端提示中的具体命令不一致；不能自动确认，请交给人工' };
      }
      const permissionEvidence = [agentState.blockedReason || '', terminalEvidence].filter(Boolean).join('\n');
      const evidenceRisk = autonomousActionBlockReason(permissionEvidence);
      if (evidenceRisk) {
        return { ok: false, error: `当前权限提示包含${evidenceRisk}；不能自动确认，请交给人工` };
      }
      const configuredEvidenceRisk = configuredActionBlockReason(permissionEvidence, forbiddenActions);
      if (configuredEvidenceRisk) {
        return { ok: false, error: `当前权限提示命中禁止事项：${configuredEvidenceRisk}；不能自动确认，请交给人工` };
      }
      const evidenceScopeRisk = workScopeBlockReason(
        permissionEvidence,
        effectiveWorkScope,
        lane.scopeRoot || lane.projectDir,
      );
      if (evidenceScopeRisk) {
        return { ok: false, error: `${evidenceScopeRisk}；不能自动确认，请交给人工` };
      }
      if (blockedRequestAlreadyAnswered(lane, agentState)) {
        return { ok: false, error: '该权限阻塞状态已经确认过，禁止重复发送响应' };
      }
      const permissionLoopReason = permissionConfirmationLoopReason(lane, permissionCommand);
      if (permissionLoopReason) {
        return { ok: false, error: permissionLoopReason };
      }
    } else if (agentState?.state === 'blocked'
      && !isAwaitingNextPromptState(agentState)
      && outcome !== 'needs-human' && !next) {
      return { ok: false, error: '工作终端仍在阻塞；请明确回答技术问题、确认低风险权限，或使用 needs-human' };
    } else if (next && outcome !== 'needs-human') {
      if (agentState?.state === 'working') {
        return { ok: false, error: '工作终端仍在运行，不能注入下一步' };
      }
      if (isAwaitingNextPromptState(agentState)) {
        // A completed agent waiting for another prompt is exactly when a supervisor may send the next batch.
      } else if (isPermissionBlockedState(agentState)) {
        return { ok: false, error: '当前是权限阻塞，必须使用权限确认参数，不能发送普通下一步' };
      } else if (agentState?.state === 'blocked' && !isQuestionBlockedState(agentState)) {
        return { ok: false, error: '当前阻塞不是明确的技术问题或方案选择，不能自动输入内容' };
      } else if (isQuestionBlockedState(agentState) && !isLowRiskTechnicalQuestion(agentState, next)) {
        return { ok: false, error: '当前输入涉及用户偏好、业务/账户决定或缺少明确技术证据；请使用 needs-human' };
      } else if (isQuestionBlockedState(agentState) && blockedRequestAlreadyAnswered(lane, agentState)) {
        return { ok: false, error: '该技术问题阻塞状态已经回答过，禁止重复发送响应' };
      }
    }
    if (outcome === 'complete' && agentState?.state === 'working') {
      return { ok: false, error: '工作终端仍在运行，不能判定完成' };
    }

    // The worker can emit several lifecycle updates while it is waiting. Keep
    // the first pending owner decision stable so the configured owner acts once.
    if (outcome === 'needs-human' && session.pendingApprovals.some((approval) => approval.laneId === lane.id)) {
      store.appendSupervisorLog(lane.id, '重复人工决策已忽略', reason || '该终端已有待决项');
      return { ok: true, outcome, duplicate: true };
    }

    if ((next || permissionResponse) && supervisorDeliveriesInFlight.has(lane.id)) {
      return { ok: false, error: '当前通道已有裁决正在投递；请等待本次投递确认后再裁决' };
    }

    if (projectSession && projectWorkItem && permissionResponse) {
      if (projectAcceptedRequirementsVersion(projectSession) !== projectRequirementsVersion(projectSession)) {
        return { ok: false, error: '项目需求或前置条件已经更新；旧版本授权已经失效，必须交回项目管理 AI 重新规划' };
      }
      const permissionTestCommand = isProjectTargetedTestCommand(permissionCommand)
        ? permissionCommand
        : undefined;
      const permissionAuthorizationError = projectPermissionAuthorizationError(
        projectWorkItem.contract,
        permissionCommand,
      );
      if (permissionAuthorizationError) {
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: { status: 'waiting-decision', latestBlocker: permissionAuthorizationError },
        }, projectSession.id);
        store.updateLane(lane.id, { awaitingReview: true });
        queueProjectSupervisorAnomaly(
          projectSession,
          lane,
          projectWorkItem,
          'supervisor.permission-outside-contract',
          permissionAuthorizationError,
          { contextSummary: permissionCommand },
        );
        saveProjectManagerSnapshot(projectSession.id);
        return { ok: false, error: permissionAuthorizationError };
      }
      const contractViolation = projectContractViolation(projectWorkItem.contract, {
        instruction: permissionCommand,
        command: permissionCommand,
        testCommand: permissionTestCommand,
      });
      if (contractViolation) {
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: { status: 'waiting-decision', latestBlocker: contractViolation },
        }, projectSession.id);
        store.updateLane(lane.id, { awaitingReview: true });
        queueProjectSupervisorAnomaly(
          projectSession,
          lane,
          projectWorkItem,
          'supervisor.permission-contract-violation',
          contractViolation,
          { contextSummary: permissionCommand },
        );
        saveProjectManagerSnapshot(projectSession.id);
        return { ok: false, error: contractViolation };
      }
    }
    if (projectSession && projectWorkItem && !permissionResponse) {
      if (projectAcceptedRequirementsVersion(projectSession) !== projectRequirementsVersion(projectSession)) {
        return { ok: false, error: '项目需求或前置条件已经更新；当前监督裁决基于旧版本，必须交回项目管理 AI 重新规划' };
      }
      if (outcome === 'needs-human') {
        const guard = evaluateProjectExecutionGuard({
          history: projectWorkItem.executionHistory,
          proposal: {
            action: `escalate:${escalationBoundary}`,
            command: guardedNext || reason,
            error: executionError || undefined,
            changedFiles,
            diffSummary: diffSummary || undefined,
            evidence,
            workspaceVersion: String(params?.workspaceVersion || ''),
            testCommand: testCommand || undefined,
            testResult: testResult || undefined,
            fullSuite: params?.fullSuite === true,
            escalationBoundary,
            now: Date.now(),
          },
          budget: projectWorkItem.contract.budget,
          decisionsUsed: projectWorkItem.decisionsUsed,
          startedAt: projectWorkItem.startedAt,
        });
        pendingProjectExecutionRecord = guard.record;
        if (guard.decision !== 'allow') {
          recordProjectExecution(false);
          const guardEvent = {
            kind: 'guard-triggered',
            workItemId: projectWorkItem.id,
            summary: guard.reason || '升级请求触发执行护栏',
            payload: {
              decision: guard.decision,
              escalationBoundary,
              attentionRequired: guard.decision === 'pause',
            },
          } as const;
          if (guard.decision === 'pause') {
            void appendRecordedProjectEvent(projectSession, guardEvent, { persistSession: false })
              .catch((error) => console.warn('[project-manager] failed to record execution guard alert', error));
          }
          else store.appendProjectManagerEvent(guardEvent, projectSession.id);
        }
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: {
            status: 'waiting-decision',
            latestBlocker: [reason || '监督 AI 请求项目管理决策', guard.reason].filter(Boolean).join('；'),
            ...(evidence ? { latestEvidence: evidence } : {}),
            ...(contextSummary || diffSummary ? { latestContextSummary: contextSummary || diffSummary } : {}),
          },
        }, projectSession.id);
        saveProjectManagerSnapshot(projectSession.id);
      } else {
        const contractViolation = projectContractViolation(projectWorkItem.contract, {
          instruction: guardedNext,
          command: String(params?.command || ''),
          changedFiles,
          testCommand: testCommand || undefined,
          retry: retryRequested,
        });
        if (contractViolation) {
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: { status: 'waiting-decision', latestBlocker: contractViolation },
          }, projectSession.id);
          store.updateLane(lane.id, { awaitingReview: true });
          queueProjectSupervisorAnomaly(
            projectSession,
            lane,
            projectWorkItem,
            'supervisor.contract-violation',
            contractViolation,
            { evidence, contextSummary: contextSummary || diffSummary || guardedNext },
          );
          saveProjectManagerSnapshot(projectSession.id);
          return { ok: false, error: contractViolation };
        }
        if (outcome === 'complete' && !evidence) {
          return { ok: false, error: '项目管理任务完成裁决必须通过 --evidence 提供验证证据' };
        }
        if (outcome === 'complete') {
          const completionError = projectStageCompletionError(projectWorkItem, {
            ...(params || {}),
            stagePlan: proposedSupervisorPlan,
          });
          if (completionError) return { ok: false, error: completionError };
        }
        if (projectBaselineApprovalRequested) {
          const baselineResult = store.applyProjectManagerAction({
            type: 'approve-work-item-baseline',
            workItemId: projectWorkItem.id,
            workspaceVersion: String(params?.workspaceVersion || ''),
            evidence,
          }, projectSession.id);
          if (!baselineResult.ok) {
            store.updateLane(lane.id, { awaitingReview: true });
            return { ok: false, error: baselineResult.error || '项目基线审核状态写入失败' };
          }
          markProjectRecoveryReady(projectSession.id, projectWorkItem.id);
        }
        if (retryRequested && projectWorkItem.attempts >= projectWorkItem.contract.budget.maxTaskRetries) {
          store.updateLane(lane.id, { awaitingReview: true });
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: { status: 'waiting-decision', latestBlocker: '已达到任务重试上限' },
          }, projectSession.id);
          store.appendProjectManagerEvent({
            kind: 'guard-triggered',
            workItemId: projectWorkItem.id,
            summary: `已达到任务重试上限 ${projectWorkItem.contract.budget.maxTaskRetries} 次`,
            payload: { decision: 'replan' },
          }, projectSession.id);
          queueProjectSupervisorAnomaly(
            projectSession,
            lane,
            projectWorkItem,
            'supervisor.retry-budget-exhausted',
            `已达到任务重试上限 ${projectWorkItem.contract.budget.maxTaskRetries} 次`,
            { evidence, contextSummary: contextSummary || diffSummary || executionError },
          );
          saveProjectManagerSnapshot(projectSession.id);
          return { ok: false, error: '已达到任务重试上限，必须交回项目管理 AI 重新规划' };
        }
        if (!projectBaselineInvestigationRequested && !projectBaselineApprovalRequested) {
          const guard = evaluateProjectExecutionGuard({
            history: projectWorkItem.executionHistory,
            proposal: {
              action: String(params?.executionAction || guardedNext || outcome),
              command: String(params?.command || guardedNext || ''),
              error: executionError || undefined,
              changedFiles,
              diffSummary: diffSummary || undefined,
              evidence,
              workspaceVersion: String(params?.workspaceVersion || ''),
              // Completion reports reference already-produced evidence. They do not execute the test again.
              testCommand: outcome === 'complete' ? undefined : testCommand || undefined,
              testResult: outcome === 'complete' ? undefined : testResult || undefined,
              fullSuite: outcome === 'complete' ? false : params?.fullSuite === true,
              now: Date.now(),
            },
            budget: projectWorkItem.contract.budget,
            decisionsUsed: projectWorkItem.decisionsUsed,
            startedAt: projectWorkItem.startedAt,
          });
          pendingProjectExecutionRecord = guard.record;
          if (guard.decision !== 'allow') {
            recordProjectExecution(false);
            const itemStatus = guard.decision === 'pause' ? 'paused' : 'waiting-decision';
            store.applyProjectManagerAction({
              type: 'update-work-item',
              workItemId: projectWorkItem.id,
              patch: { status: itemStatus, latestBlocker: guard.reason },
            }, projectSession.id);
            const guardEvent = {
              kind: 'guard-triggered' as const,
              workItemId: projectWorkItem.id,
              summary: guard.reason || '执行护栏已触发',
              payload: {
                decision: guard.decision,
                attentionRequired: guard.decision === 'pause',
              },
            };
            if (guard.decision === 'pause') {
              void appendRecordedProjectEvent(projectSession, guardEvent, { persistSession: false })
                .catch((error) => console.warn('[project-manager] failed to record execution guard alert', error));
            }
            else store.appendProjectManagerEvent(guardEvent, projectSession.id);
            if (guard.decision === 'pause') {
              store.pauseSupervisorLane(lane.id, guard.reason);
              queueProjectSupervisorRecovery(
                useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane,
                guard.reason || '执行护栏已暂停专属监督',
              );
            } else {
              store.updateLane(lane.id, { awaitingReview: true });
              queueProjectSupervisorAnomaly(
                projectSession,
                lane,
                projectWorkItem,
                'supervisor.execution-guard',
                guard.reason || '执行护栏已触发',
                { evidence, contextSummary: contextSummary || diffSummary || executionError },
              );
            }
            saveProjectManagerSnapshot(projectSession.id);
            return { ok: false, error: `${guard.reason}；已停止自动推进并交回项目管理 AI` };
          }
        }
        if (retryRequested) {
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: { attempts: projectWorkItem.attempts + 1 },
          }, projectSession.id);
        }
        if (outcome === 'continue' || outcome === 'rework') {
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: {
              ...(evidence ? { latestEvidence: evidence } : {}),
              ...(contextSummary || diffSummary ? { latestContextSummary: contextSummary || diffSummary } : {}),
              ...(executionError ? { latestBlocker: executionError } : {}),
            },
          }, projectSession.id);
        }
        if (outcome === 'complete') {
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: { status: 'validating', latestEvidence: evidence },
          }, projectSession.id);
        }
        saveProjectManagerSnapshot(projectSession.id);
      }
    }

    const autoDecisionsUsed = nextSupervisorDecisionCount(lane.autoDecisionsUsed, permissionResponse);
    const limitReached = !autonomous && !permissionResponse && reachesAutoDecisionLimit(lane, session.maxAutoDecisions);
    appendSupervisorRecord(session, lane, 'supervisor.decision', {
      outcome,
      reason,
      next,
      proposalKind,
      impact,
      alternatives,
      escalationBoundary,
      ...(outcome === 'complete' ? {
        completionStopWhen,
        completionValidation,
        remainingWork,
      } : {}),
      proactiveProjectFollowUp,
      requiresHuman: limitReached && outcome !== 'needs-human',
    });
    store.appendSupervisorLog(lane.id, '监督裁决', `${outcome}${reason ? `：${reason}` : ''}`);
    store.updateLane(lane.id, {
      autoDecisionsUsed,
      unreportedIdleRecoveryAttempts: 0,
      decisions: [
        {
          ts: Date.now(),
          task: lane.currentTask || '（任务未上报）',
          outcome,
          ...(proposalKind ? { proposalKind: proposalKind as SupervisorDecision['proposalKind'] } : {}),
          reason,
          next,
        },
        ...(lane.decisions || []),
      ].slice(0, 100),
    });

    if (limitReached && outcome !== 'needs-human') {
      store.updateLane(lane.id, {
        autoDecisionLimitReached: true,
        awaitingReview: true,
        ...(outcome === 'complete' ? { awaitingStopCheck: true } : {}),
      });
      if (!lane.projectManagerProjectId) {
        const text = `已达到 ${normalizedMaxAutoDecisions(session.maxAutoDecisions)} 次自动判断上限；请人工审阅 ${lane.label} 后再继续。`;
        const workspaceId = lane.workspaceId || store.activeWorkspaceId;
        if (workspaceId) store.addNotification({ surfaceId: lane.surfaceId, workspaceId, text });
        window.wmux?.notification?.fire({ surfaceId: lane.surfaceId, title: 'AI 监督', text });
      }
      return { ok: true, outcome, requiresHuman: true };
    }

    if (outcome === 'complete') {
      recordProjectExecution(true);
      applyProposedSupervisorPlan();
      if (projectSession) saveProjectManagerSnapshot(projectSession.id);
      store.updateLane(lane.id, { awaitingDirectionAfterWaitingResume: false });
      store.confirmStopCondition(lane.id);
      announceSupervisorWaitingForDirection(
        lane,
        reason || '监督 AI 已确认达到停止条件',
        projectSession && projectWorkItem ? {
          handoffKind: 'stage-complete',
          evidence,
          contextSummary: [
            contextSummary || reason,
            `阶段核对：stopWhen=${completionStopWhen}；validation=${completionValidation}；remainingWork=${remainingWork}`,
          ].filter(Boolean).join('\n'),
        } : {},
      );
      return {
        ok: true,
        outcome,
        ...(projectSession ? { waiting: true, handoff: true } : {}),
      };
    }

    const failDelivery = (
      kind: 'next' | 'permission',
      label: string,
      error: string,
      delivery?: SupervisorDeliveryObservation,
    ) => {
      recordProjectExecution(false);
      if (projectSession) saveProjectManagerSnapshot(projectSession.id);
      store.updateLane(lane.id, {
        awaitingReview: true,
        autoDecisionsUsed: lane.autoDecisionsUsed ?? 0,
        decisions: lane.decisions || [],
      });
      appendSupervisorRecord(session, lane, 'supervisor.delivery.failed', {
        kind,
        error,
        ...(delivery ? { delivery } : {}),
      });
      store.appendSupervisorLog(lane.id, `${label}失败`, error);
      return { ok: false, error: `${label}失败：${error}`, ...(delivery ? { delivery } : {}) };
    };

    if (permissionResponse) {
      const beforeScreen = terminalScreenTail(lane.surfaceId);
      const expectedBlockedVersion = agentState!.blockedVersion;
      const expectedBlockedRequestId = agentState!.blockedRequestId || '';
      const expectedRequirementsVersion = projectSession
        ? projectRequirementsVersion(projectSession)
        : undefined;
      const validatePermissionBeforeSubmit = (): string | null => {
        const freshStore = useStore.getState();
        const freshSupervisor = freshStore.supervisor;
        const freshLane = freshSupervisor.lanes.find((candidate) => candidate.id === lane.id);
        if (!freshSupervisor.active || !freshLane || supervisorLaneControlState(freshLane) !== 'active') {
          return '权限响应提交前通道已暂停、停止或失效，已取消自动确认';
        }
        if (
          freshLane.surfaceId !== lane.surfaceId
          || !isSupervisorDecisionAuthorised(freshLane, supervisorSurfaceId)
        ) {
          return '权限响应提交前任务终端或专属监督绑定已变化，已取消自动确认';
        }
        if (!effectiveSupervisorAutonomyPermissions(freshSupervisor, freshLane).includes('permission-confirm')) {
          return '权限响应提交前 permission-confirm 授权已撤销，已取消自动确认';
        }
        const freshAgentState = ((w.__wmux_getAgentStates?.() || {})[lane.surfaceId] || undefined) as SupervisorAgentStateView | undefined;
        if (
          !isPermissionBlockedState(freshAgentState)
          || freshAgentState.blockedVersion !== expectedBlockedVersion
          || String(freshAgentState.blockedRequestId || '') !== expectedBlockedRequestId
        ) {
          return '权限响应提交前阻塞轮次已变化或已经解除，已取消自动确认';
        }
        const freshEvidence = terminalScreenTail(lane.surfaceId);
        if (!permissionCommandMatchesEvidence(permissionCommand, freshEvidence)) {
          return '权限响应提交前终端提示已变化，具体命令不再匹配，已取消自动确认';
        }
        const freshForbiddenActions = effectiveSupervisorForbiddenActions(freshSupervisor, freshLane);
        const freshPermissionEvidence = [freshAgentState.blockedReason || '', freshEvidence].filter(Boolean).join('\n');
        const freshRisk = autonomousActionBlockReason(freshPermissionEvidence)
          || configuredActionBlockReason(freshPermissionEvidence, freshForbiddenActions)
          || workScopeBlockReason(
            freshPermissionEvidence,
            effectiveSupervisorWorkScope(freshSupervisor, freshLane),
            freshLane.scopeRoot || freshLane.projectDir,
          );
        if (freshRisk) return `权限响应提交前检测到新的安全或范围风险：${freshRisk}`;
        if (projectSession && projectWorkItem) {
          const freshProject = freshStore.projectManagers.find((candidate) => candidate.id === projectSession.id);
          const freshWorkItem = freshProject?.workItems.find((candidate) => candidate.id === projectWorkItem.id);
          if (
            !freshProject
            || freshProject.status !== 'active'
            || !freshWorkItem
            || freshLane.projectManagerProjectId !== freshProject.id
            || freshLane.projectWorkItemId !== freshWorkItem.id
            || freshWorkItem.supervisorLaneId !== freshLane.id
            || projectRequirementsVersion(freshProject) !== expectedRequirementsVersion
            || projectAcceptedRequirementsVersion(freshProject) !== expectedRequirementsVersion
          ) {
            return '权限响应提交前项目状态、需求版本或工作项绑定已变化，已取消自动确认';
          }
          const authorizationError = projectPermissionAuthorizationError(freshWorkItem.contract, permissionCommand);
          const contractError = projectContractViolation(freshWorkItem.contract, {
            instruction: permissionCommand,
            command: permissionCommand,
            testCommand: isProjectTargetedTestCommand(permissionCommand) ? permissionCommand : undefined,
          });
          if (authorizationError || contractError) {
            return `权限响应提交前任务合同已不再授权该命令：${authorizationError || contractError}`;
          }
        }
        return null;
      };
      const finishPermission = (delivery?: SupervisorDeliveryObservation) => {
        appendSupervisorRecord(session, lane, 'supervisor.permission-approved', {
          command: permissionCommand,
          response: permissionResponse,
        });
        store.appendSupervisorLog(lane.id, 'AI 自动授权', permissionCommand);
        store.updateLane(lane.id, {
          awaitingReview: false,
          activeReviewId: undefined,
          reviewWorkerTurnId: undefined,
          reviewOpenedAt: undefined,
          reviewDeliveryConfirmedAt: undefined,
          reviewWatchdogState: undefined,
          ...(lane.supervisorProblem?.kind === 'unreported-decision' ? { supervisorProblem: undefined } : {}),
          lastBlockedResponseVersion: agentState!.blockedVersion,
          lastBlockedResponseId: agentState!.blockedRequestId || undefined,
          permissionConfirmations: [
            ...(lane.permissionConfirmations || []),
            {
              ts: Date.now(),
              commandSignature: permissionCommandSignature(permissionCommand),
              ...(agentState!.blockedRequestId ? { blockedRequestId: agentState!.blockedRequestId } : {}),
              ...(projectSession ? { requirementsVersion: projectRequirementsVersion(projectSession) } : {}),
            },
          ].slice(-20),
        });
        return { ok: true, outcome, autoAuthorized: true, ...(delivery ? { delivery } : {}) };
      };
      supervisorDeliveriesInFlight.add(lane.id);
      try {
        const pendingDelivery = sendPermissionResponseReliably(
          lane.surfaceId,
          permissionResponse,
          () => terminalScreenTail(lane.surfaceId),
          validatePermissionBeforeSubmit,
        );
        if (pendingDelivery) {
          return pendingDelivery
            .then((receipt) => observeSupervisorDelivery(
              lane.surfaceId,
              receipt.beforeSubmitScreen ?? beforeScreen,
              agentState,
            ))
            .then((delivery) => delivery.confirmed
              ? finishPermission(delivery)
              : failDelivery(
                'permission',
                '权限响应发送',
                `PTY 已接受输入，但未观察到新的任务状态（当前 ${delivery.agentState}${delivery.screenChanged ? '，仅检测到屏幕变化' : ''}）；请核验权限提示后再重试`,
                delivery,
              ))
            .catch((err) => failDelivery(
              'permission',
              '权限响应发送',
              String((err as Error)?.message || err),
            ))
            .finally(() => supervisorDeliveriesInFlight.delete(lane.id));
        }
        const result = finishPermission();
        supervisorDeliveriesInFlight.delete(lane.id);
        return result;
      } catch (err) {
        supervisorDeliveriesInFlight.delete(lane.id);
        const error = String((err as Error)?.message || err);
        return failDelivery('permission', '权限响应发送', error);
      }
    }

    if (outcome === 'needs-human') {
      recordProjectExecution(true);
      if (proposalKind === 'direction-needed'
        && lane.awaitingDirectionAfterWaitingResume
        && laneConfig.waitForNextDirection) {
        store.updateLane(lane.id, {
          controlState: 'waiting',
          awaitingStopCheck: false,
          stopConfirmed: true,
          awaitingReview: false,
          awaitingDirectionAfterWaitingResume: false,
          autoDecisionLimitReached: false,
          activeReviewId: undefined,
          reviewWorkerTurnId: undefined,
          reviewOpenedAt: undefined,
          reviewDeliveryConfirmedAt: undefined,
          reviewWatchdogState: undefined,
        });
        const waitingReason = reason || '用户提供的新方向信息仍不足，等待补充';
        store.appendSupervisorLog(lane.id, '新方向信息不足，返回待续', waitingReason);
        announceSupervisorWaitingForDirection(lane, waitingReason, { handoffKind: 'direction-needed' });
        return { ok: true, outcome, waiting: true };
      }
      store.updateLane(lane.id, {
        awaitingReview: true,
        activeReviewId: undefined,
        reviewWorkerTurnId: undefined,
        reviewOpenedAt: undefined,
        reviewDeliveryConfirmedAt: undefined,
        reviewWatchdogState: undefined,
        ...(limitReached ? { autoDecisionLimitReached: true } : {}),
      });
      const kind = proposalKinds.has(proposalKind)
        ? proposalKind as 'route-change' | 'important' | 'context-recovery'
        : 'important';
      const approval = {
        laneId: lane.id,
        surfaceId: lane.surfaceId,
        laneLabel: lane.label,
        text: next,
        source: kind === 'route-change'
          ? 'supervisor-route' as const
          : kind === 'context-recovery'
            ? 'supervisor-context-recovery' as const
            : 'supervisor-important' as const,
        proposalKind: kind,
        reason: reason || `${lane.label} 需要人工决策`,
        impact,
        alternatives,
        task: lane.currentTask || '（任务未上报）',
      };
      store.enqueueApproval(approval);
      if (kind === 'context-recovery') {
        store.updateLane(lane.id, { contextRecoveryStatus: 'awaiting-confirmation' });
      }
      const pending = useStore.getState().supervisor.pendingApprovals.find((item) => item.laneId === lane.id);
      if (pending) {
        appendSupervisorRecord(useStore.getState().supervisor, lane, 'supervisor.approval.requested', {
          approvalId: pending.id,
          taskGoal: publicDecisionTaskGoal(useStore.getState().supervisor, lane),
          reason: approval.reason,
          impact: approval.impact,
          alternatives: approval.alternatives,
          proposalKind: approval.proposalKind,
        });
        if (projectSession) {
          store.appendProjectManagerEvent({
            kind: 'supervisor-decision-request',
            workItemId: lane.projectWorkItemId,
            summary: `AI 监督请求项目管理决策：${approval.reason}`,
            payload: {
              laneId: lane.id,
              approvalId: pending.id,
              proposalKind: approval.proposalKind,
              escalationBoundary,
              recommendation: approval.text,
              impact: approval.impact,
              alternatives: approval.alternatives,
            },
          }, projectSession.id);
          const decisionOptions = approval.proposalKind === 'context-recovery'
            ? []
            : supervisorDecisionOptions(approval.alternatives, approval.text);
          const approveCommand = decisionOptions.length >= 2
            ? `wmux project decide --project ${projectSession.id} --approval ${pending.id} --decision approve --selection "<从备选中原样选择一项>"`
            : `wmux project decide --project ${projectSession.id} --approval ${pending.id} --decision approve`;
          queueProjectSupervisorTransition({
            sessionId: projectSession.id,
            laneId: lane.id,
            workItemId: lane.projectWorkItemId,
            kind: 'decision-required',
            eventType: 'supervisor.approval.requested',
            summary: `${approval.reason}；建议：${approval.text || '未提供具体建议'}`,
            contextSummary: [
              approval.impact ? `影响：${approval.impact}` : '',
              approval.alternatives ? `备选：${approval.alternatives}` : '',
            ].filter(Boolean).join('\n'),
            instruction: [
              `待决 ID：${pending.id}`,
              `若属于项目内决策权，执行 ${approveCommand}；需要自定方向时使用 wmux project decide --project ${projectSession.id} --approval ${pending.id} --decision direct --task-message "<方向>"。`,
              `只有业务选择、目标或范围扩展、凭据/权限、破坏性或不可逆动作、生产发布或必须人工操作时，才使用 wmux project ask --project ${projectSession.id} 请求用户处理。`,
            ].join('\n'),
          });
          saveProjectManagerSnapshot(projectSession.id);
        }
      }
      const proposalLabel = kind === 'route-change'
        ? '路线变更'
        : kind === 'context-recovery'
          ? '上下文恢复指令'
          : '重要建议';
      const text = `${proposalLabel}待你决定：${reason || lane.label}`;
      if (!lane.projectManagerProjectId) {
        const workspaceId = lane.workspaceId || store.activeWorkspaceId;
        if (workspaceId) {
          store.addNotification({ surfaceId: lane.surfaceId, workspaceId, text });
        }
        window.wmux?.notification?.fire({ surfaceId: lane.surfaceId, title: 'AI 监督', text });
      }
      return { ok: true, outcome };
    }

    const finishDecision = (delivery?: SupervisorDeliveryObservation) => {
      if (projectBaselineInvestigationRequested && projectSession && projectWorkItem) {
        const baselineResult = store.applyProjectManagerAction({
          type: 'start-work-item-baseline',
          workItemId: projectWorkItem.id,
        }, projectSession.id);
        if (!baselineResult.ok) {
          store.updateLane(lane.id, { awaitingReview: true });
          return { ok: false, error: baselineResult.error || '项目基线调查状态写入失败' };
        }
        saveProjectManagerSnapshot(projectSession.id);
      }
      if (projectSession && projectWorkItem && (outcome === 'continue' || outcome === 'rework')) {
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: {
            status: 'running',
            ...(!executionError ? { latestBlocker: undefined } : {}),
          },
        }, projectSession.id);
          saveProjectManagerSnapshot(projectSession.id);
        }
      recordProjectExecution(true);
      applyProposedSupervisorPlan();
      if (projectSession) saveProjectManagerSnapshot(projectSession.id);
      store.updateLane(lane.id, {
        awaitingReview: false,
        activeReviewId: undefined,
        reviewWorkerTurnId: undefined,
        reviewOpenedAt: undefined,
        reviewDeliveryConfirmedAt: undefined,
        reviewWatchdogState: undefined,
        ...(lane.supervisorProblem?.kind === 'unreported-decision' ? { supervisorProblem: undefined } : {}),
        awaitingDirectionAfterWaitingResume: false,
        ...(next && !projectSession ? { taskRoleAnchorPending: false } : {}),
        ...(next && projectSession && projectWorkItem ? {
          projectTaskContractPending: false,
          permissionConfirmations: [],
        } : {}),
        ...(isQuestionBlockedState(agentState) ? {
          lastBlockedResponseVersion: agentState.blockedVersion,
          lastBlockedResponseId: agentState.blockedRequestId || undefined,
        } : {}),
      });
      return {
        ok: true,
        outcome,
        ...(nextFile && !preparedProjectTask ? { retainNextFile: true } : {}),
        ...(delivery ? { delivery } : {}),
      };
    };

    if (next) {
      const beforeScreen = terminalScreenTail(lane.surfaceId);
      const unanchoredDeliveryText = nextFile
        ? [
            '[wmux 临时任务文件]',
            `请先使用文件读取工具完整读取当前项目内的 ${nextFile}。`,
            '文件内容是本轮完整任务指令；读取完成后直接执行，不要将全文再次粘贴到终端。',
            `确认读取成功后，只删除这一个临时文件：${nextFile}。`,
          ].join('\n')
        : next;
      const deliveryText = preparedProjectTask?.delivery
        ?? (lane.taskRoleAnchorPending !== false
          ? `${ORDINARY_TASK_ROLE_ANCHOR}\n\n${unanchoredDeliveryText}`
          : `${buildOrdinaryTaskEventEnvelope(lane.surfaceId)}\n\n${unanchoredDeliveryText}`);
      supervisorDeliveriesInFlight.add(lane.id);
      try {
        const pendingDelivery = sendTaskToSurfaceReliably(
          lane.surfaceId,
          deliveryText,
          session.submitEnter,
          () => terminalScreenTail(lane.surfaceId),
        );
        if (pendingDelivery) {
          return pendingDelivery
            .then((receipt) => session.submitEnter
              ? observeSupervisorDelivery(
                lane.surfaceId,
                receipt.beforeSubmitScreen ?? beforeScreen,
                agentState,
              )
              : {
                confirmed: true,
                agentState: String(((window as any).__wmux_getAgentStates?.() || {})[lane.surfaceId]?.state || 'unknown'),
                screenChanged: terminalScreenTail(lane.surfaceId) !== beforeScreen,
              })
            .then((delivery) => delivery.confirmed
              ? finishDecision(delivery)
              : failDelivery(
                'next',
                '下一步发送',
                `PTY 已接受输入，但未观察到新的任务状态（当前 ${delivery.agentState}${delivery.screenChanged ? '，仅检测到屏幕变化' : ''}）；请先运行 wmux agent-state --surface ${lane.surfaceId}，必要时再 read-screen，确认未投递后改用短指令重试`,
                delivery,
              ))
            .catch((err) => failDelivery(
              'next',
              '下一步发送',
              String((err as Error)?.message || err),
            ))
            .finally(() => supervisorDeliveriesInFlight.delete(lane.id));
        }
      } catch (err) {
        supervisorDeliveriesInFlight.delete(lane.id);
        return failDelivery('next', '下一步发送', String((err as Error)?.message || err));
      }
      supervisorDeliveriesInFlight.delete(lane.id);
    }
    return finishDecision();
  };

  // The Feishu main-process gateway authenticates the caller; this renderer
  // bridge only accepts its small, explicit set of supervision/task actions.
  w.__wmux_supervisorRemoteControl = (params: any) => {
    const action = String(params?.action || '');
    if (action === 'list') {
      const state = useStore.getState().supervisor;
      const ordinaryLaneIds = new Set(
        state.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane)).map((lane) => lane.id),
      );
      const ordinaryLanes = state.lanes.filter((lane) => ordinaryLaneIds.has(lane.id));
      const ordinaryActive = ordinaryLanes.some((lane) => {
        const laneState = supervisorLaneControlState(lane);
        return laneState === 'active' || laneState === 'waiting';
      });
      const ordinaryPaused = !ordinaryActive
        && ordinaryLanes.some((lane) => supervisorLaneControlState(lane) === 'paused');
      return {
        ok: true,
        message: JSON.stringify({
          active: ordinaryActive,
          paused: ordinaryPaused,
          terminals: remoteTerminalList().filter((terminal) => (
            !terminal.surface.projectManagerProjectId && !terminal.surface.projectManagerWorkItemId
          )).map((terminal) => ({
            ...(() => {
              const lane = state.lanes.find((item) => item.surfaceId === terminal.surfaceId);
              const supervisionState = lane ? supervisorLaneControlState(lane) : 'none';
              return {
                supervised: !!lane && supervisionState !== 'stopped' && (state.active || state.paused),
                restartable: supervisionState === 'stopped',
                supervisionState,
                managementSessionId: lane?.managementSessionId || null,
                autonomous: lane ? effectiveSupervisorAutonomous(state, lane) : null,
                autonomyPermissionCount: lane ? effectiveSupervisorAutonomyPermissions(state, lane).length : null,
                forbiddenActionCount: lane ? effectiveSupervisorForbiddenActions(state, lane).length : null,
                policyOverridden: !!lane && (
                  Array.isArray(lane.autonomyPermissionsOverride)
                  || typeof lane.autonomousOverride === 'boolean'
                  || Array.isArray(lane.forbiddenActionsOverride)
                  || !!lane.workScopeOverride
                ),
              };
            })(),
            surfaceId: terminal.surfaceId,
            label: terminal.label,
            workspaceId: terminal.workspaceId,
            workspace: terminal.workspaceTitle,
            cwd: terminal.cwd,
            ...remoteTerminalActivity(terminal.surfaceId),
          })),
          session: ordinaryActive || ordinaryPaused
            ? { sessionId: state.sessionId, autonomous: state.autonomous }
            : null,
          pendingApprovals: state.pendingApprovals
            .filter((approval) => ordinaryLaneIds.has(approval.laneId))
            .map((approval) => ({ id: approval.id, terminal: approval.laneLabel, reason: approval.reason || '' })),
        }),
      };
    }
    if (action === 'terminal-list') {
      if (!['ordinary', 'project'].includes(String(params?.mode))) {
        return { ok: false, error: '终端列表模式无效。' };
      }
      const projectMode = params.mode === 'project';
      const terminals = projectMode
        ? remoteProjectTerminalList().map((terminal) => {
            const runtime = terminalRuntimeStatus(terminal.surfaceId);
            const activity = remoteTerminalActivity(terminal.surfaceId);
            return {
              surfaceId: terminal.surfaceId,
              label: terminal.label,
              workspaceId: terminal.workspaceId,
              workspace: terminal.workspaceTitle,
              cwd: terminal.cwd,
              supervised: terminal.role !== 'project-ai',
              supervisionState: 'none',
              ...activity,
              terminalMode: 'project',
              agentRole: terminal.role,
              projectId: terminal.projectId,
              projectName: terminal.projectName,
              workItemId: terminal.workItemId,
              workItemTitle: terminal.workItemTitle,
              runtimeState: runtime?.state,
              runtimeDetail: runtime?.detail,
            };
          })
        : remoteOrdinaryMonitoringTerminalList().map((terminal) => {
            const runtime = terminalRuntimeStatus(terminal.surfaceId);
            const activity = remoteTerminalActivity(terminal.surfaceId);
            const laneState = terminal.lane ? supervisorLaneControlState(terminal.lane) : 'none';
            const publicLaneState = laneState === 'waiting' ? 'active' : laneState;
            return {
              surfaceId: terminal.surfaceId,
              label: terminal.role === 'supervisor-ai' ? terminal.lane?.label || terminal.label : terminal.label,
              workspaceId: terminal.workspaceId,
              workspace: terminal.workspaceTitle,
              cwd: terminal.cwd,
              supervised: !!terminal.lane && publicLaneState !== 'stopped',
              restartable: publicLaneState === 'stopped',
              supervisionState: publicLaneState,
              managementSessionId: terminal.lane?.managementSessionId || null,
              ...activity,
              terminalMode: 'ordinary',
              agentRole: terminal.role,
              runtimeState: runtime?.state,
              runtimeDetail: runtime?.detail,
            };
          });
      return {
        ok: true,
        message: JSON.stringify({
          active: false,
          paused: false,
          terminals,
          session: null,
          pendingApprovals: [],
        }),
      };
    }
    if (action === 'logs') {
      const state = useStore.getState().supervisor;
      const ordinaryLanes = state.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane));
      const ordinaryLaneIds = new Set(ordinaryLanes.map((lane) => lane.id));
      const laneLabels = new Map(ordinaryLanes.map((lane) => [lane.id, lane.label]));
      return {
        ok: true,
        message: JSON.stringify({
          active: ordinaryLanes.some((lane) => {
            const laneState = supervisorLaneControlState(lane);
            return laneState === 'active' || laneState === 'waiting';
          }),
          paused: ordinaryLanes.some((lane) => supervisorLaneControlState(lane) === 'paused'),
          sessionId: state.sessionId,
          entries: state.log.filter((entry) => ordinaryLaneIds.has(entry.laneId)).slice(0, 20).map((entry) => ({
            ts: entry.ts,
            laneLabel: entry.laneId === '-' ? '会话' : laneLabels.get(entry.laneId) || '未知通道',
            action: entry.action,
            detail: entry.detail,
          })),
        }),
      };
    }
    if (action === 'terminal-screen') {
      const terminalId = String(params?.terminal || '');
      if (params?.mode === 'project') {
        const located = locateRemoteProjectTerminal(terminalId);
        const terminal = located.terminal;
        if (!terminal) return { ok: false, error: located.error };
        const requestedLines = Number(params?.lines);
        const lines = Number.isFinite(requestedLines)
          ? Math.min(Math.max(Math.floor(requestedLines), 1), 100)
          : 40;
        const screen = readTerminalScreen(terminal.surfaceId, lines);
        if (screen.error) return { ok: false, error: screen.error };
        const activity = remoteTerminalActivity(terminal.surfaceId);
        const conversation = terminalSupervisorCoreExcerpt(screen.text || '', terminal.label, activity.activityState);
        const runtime = terminalRuntimeStatus(terminal.surfaceId);
        return {
          ok: true,
          terminal: {
            surfaceId: terminal.surfaceId,
            label: terminal.label,
            workspace: terminal.workspaceTitle,
            cwd: terminal.cwd,
            terminalMode: 'project',
            agentRole: terminal.role,
            projectId: terminal.projectId,
            projectName: terminal.projectName,
            workItemId: terminal.workItemId,
            workItemTitle: terminal.workItemTitle,
            runtimeState: runtime?.state,
            runtimeDetail: runtime?.detail,
            ...activity,
          },
          ...conversation,
          lines: screen.lines || 0,
          capturedAt: Date.now(),
        };
      }
      if (params?.mode === 'ordinary') {
        const terminal = remoteOrdinaryMonitoringTerminalList()
          .find((candidate) => candidate.surfaceId === terminalId);
        if (!terminal) {
          return { ok: false, error: '目标不属于普通监督模式、已经关闭或已被新运行时替代；请刷新终端列表。' };
        }
        const requestedLines = Number(params?.lines);
        const lines = Number.isFinite(requestedLines)
          ? Math.min(Math.max(Math.floor(requestedLines), 1), 100)
          : 40;
        const screen = readTerminalScreen(terminal.surfaceId, lines);
        if (screen.error) return { ok: false, error: screen.error };
        const activity = remoteTerminalActivity(terminal.surfaceId);
        const label = terminal.role === 'supervisor-ai' ? terminal.lane?.label || terminal.label : terminal.label;
        const conversation = terminalSupervisorCoreExcerpt(screen.text || '', label, activity.activityState);
        const runtime = terminalRuntimeStatus(terminal.surfaceId);
        return {
          ok: true,
          terminal: {
            surfaceId: terminal.role === 'supervisor-ai' ? terminal.lane?.surfaceId || terminal.surfaceId : terminal.surfaceId,
            label,
            workspace: terminal.workspaceTitle,
            cwd: terminal.cwd,
            terminalMode: 'ordinary',
            agentRole: terminal.role,
            runtimeState: runtime?.state,
            runtimeDetail: runtime?.detail,
            ...activity,
          },
          ...conversation,
          lines: screen.lines || 0,
          capturedAt: Date.now(),
        };
      }
      if (params?.mode !== undefined) {
        return { ok: false, error: '终端读取模式无效。' };
      }
      const located = locateRemoteTaskTerminal(terminalId);
      const terminal = located.terminal;
      if (!terminal) {
        return { ok: false, error: located.error };
      }
      if (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId) {
        return { ok: false, error: '项目任务终端不能通过普通 AI 监督入口读取。' };
      }
      const requestedLines = Number(params?.lines);
      const lines = Number.isFinite(requestedLines)
        ? Math.min(Math.max(Math.floor(requestedLines), 1), 100)
        : 40;
      const screen = readTerminalScreen(terminal.surfaceId, lines);
      if (screen.error) return { ok: false, error: screen.error };
      const activity = remoteTerminalActivity(terminal.surfaceId);
      const conversation = terminalSupervisorCoreExcerpt(screen.text || '', terminal.label, activity.activityState);
      return {
        ok: true,
        terminal: {
          surfaceId: terminal.surfaceId,
          label: terminal.label,
          workspace: terminal.workspaceTitle,
          cwd: terminal.cwd,
          ...activity,
        },
        ...conversation,
        lines: screen.lines || 0,
        capturedAt: Date.now(),
      };
    }
    if (action === 'supervisor-screen') {
      const located = locateRemoteSupervisorTerminal(String(params?.terminal || ''));
      if (!located.lane || !located.supervisorSurfaceId) {
        return { ok: false, error: located.error };
      }
      if (isProjectManagedSupervisorLane(located.lane)) {
        return { ok: false, error: '项目监督终端只能通过项目管理模式查看。' };
      }
      const requestedLines = Number(params?.lines);
      const lines = Number.isFinite(requestedLines)
        ? Math.min(Math.max(Math.floor(requestedLines), 1), 100)
        : 40;
      const screen = readTerminalScreen(located.supervisorSurfaceId, lines);
      if (screen.error) return { ok: false, error: screen.error };
      const activity = remoteTerminalActivity(located.supervisorSurfaceId);
      const conversation = terminalSupervisorCoreExcerpt(screen.text || '', located.lane.label, activity.activityState);
      return {
        ok: true,
        terminal: {
          // Keep the public lane terminal ID so refresh/send actions never expose
          // the dedicated supervisor surface through the task-terminal endpoint.
          surfaceId: located.lane.surfaceId,
          label: located.lane.label,
          workspace: located.workspaceTitle || '',
          cwd: located.lane.scopeRoot || located.lane.projectDir,
          ...activity,
        },
        ...conversation,
        lines: screen.lines || 0,
        capturedAt: Date.now(),
      };
    }
    if (action === 'decision-context') {
      const approvalId = String(params?.approvalId || '');
      const terminal = String(params?.terminal || '');
      const approval = useStore.getState().supervisor.pendingApprovals.find((item) => item.id === approvalId);
      if (!approval || approval.surfaceId !== terminal) {
        return { ok: false, error: '该待决项不存在、已过期或与任务终端不匹配。' };
      }
      const lane = useStore.getState().supervisor.lanes.find((item) => item.id === approval.laneId);
      if (lane && isProjectManagedSupervisorLane(lane)) {
        return { ok: false, error: '该待决项属于项目管理模式，只能由对应的项目管理 AI 查看。' };
      }
      const screen = readTerminalScreen(terminal, Number(params?.lines) || 40);
      const activity = remoteTerminalActivity(approval.surfaceId);
      const coreInformation = terminalSupervisorCoreExcerpt(
        screen.text || '',
        approval.laneLabel,
        activity.activityState,
      ).answer || '';
      return {
        ok: true,
        recommendation: approval.text || '',
        terminalScreen: coreInformation,
      };
    }
    if (action === 'start') return startRemoteSupervisor(params as RemoteSupervisorStart);
    if (action === 'create-task') return createRemoteDirectTerminalTask(params as RemoteDirectTerminalTask);
    if (action === 'send') return sendRemoteTerminalTask(params as RemoteTerminalTask);
    if (action === 'terminal-escape') return sendRemoteTerminalEscape(params as RemoteTerminalEscape);
    if (action === 'terminal-interrupt') return sendRemoteTerminalInterrupt(params as RemoteTerminalInterrupt);
    if (action === 'close-terminal') return closeRemoteTerminal(params);
    if (action === 'send-supervisor-message') return sendRemoteSupervisorMessage(params as RemoteSupervisorMessage);
    if (action === 'waiting-decision') return decideRemoteWaiting(params as RemoteWaitingDecision);
    if (action === 'pause-lane' || action === 'resume-lane' || action === 'stop-lane') {
      const session = useStore.getState().supervisor;
      const actor = String(params?.actor || 'unknown');
      const terminal = String(params?.terminal || '');
      const lane = session.lanes.find((item) => item.surfaceId === terminal || item.managementSessionId === terminal);
      if (!lane) return { ok: false, error: '没有找到对应的 AI 监督通道。', message: '' };
      if (isProjectManagedSupervisorLane(lane)) {
        return { ok: false, error: '该通道属于项目管理模式，只能由对应的项目管理 AI 控制。', message: '' };
      }
      const laneState = supervisorLaneControlState(lane);
      if (action === 'pause-lane') {
        if (laneState === 'stopped') return { ok: false, error: `${lane.label} 已停止，不能暂停。`, message: '' };
        if (laneState === 'paused') return { ok: true, message: `${lane.label} 已经暂停。` };
        remoteAudit(session, lane, 'supervisor.remote-command', { action: 'pause-lane', actor });
        useStore.getState().pauseSupervisorLane(lane.id, `由飞书暂停 ${lane.label}`);
        return { ok: true, message: `已暂停 ${lane.label} 的 AI 监督；其他通道继续运行。` };
      }
      if (action === 'resume-lane') {
        if (laneState === 'stopped') return { ok: false, error: `${lane.label} 已停止；请重新配置后启动。`, message: '' };
        if (laneState === 'active') return { ok: true, message: `${lane.label} 已经在监督中。` };
        const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
        if (!supervisorSurfaceId
          || !hasLiveSurface(supervisorSurfaceId)
          || lane.supervisorProblem?.kind === 'runtime-failed') {
          return { ok: false, error: `${lane.label} 的专属监督终端已缺失；请在 wmux 中重新配置。`, message: '' };
        }
        const retriesWatchdog = lane.supervisorProblem?.kind === 'unreported-decision';
        remoteAudit(session, lane, 'supervisor.remote-command', { action: 'resume-lane', actor });
        useStore.getState().resumeSupervisorLane(lane.id, `由飞书继续 ${lane.label}`);
        if (retriesWatchdog) {
          useStore.getState().updateLane(lane.id, {
            reviewWatchdogState: 'retrying',
            reviewDeliveryConfirmedAt: undefined,
            unreportedIdleRecoveryAttempts: 1,
            supervisorProblem: undefined,
          });
        }
        if (session.active && !session.pendingApprovals.some((item) => item.laneId === lane.id)) {
          sendToSurface(
            supervisorSurfaceId,
            retriesWatchdog
              ? buildUnacknowledgedSupervisorIdlePrompt(lane)
              : '[通道继续] 用户已通过飞书恢复此监督通道。保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n',
            true,
          );
        }
        return { ok: true, message: session.paused
          ? `${lane.label} 已设为继续；当前会话仍处于全局暂停。`
          : `已继续 ${lane.label} 的 AI 监督。` };
      }
      if (laneState === 'stopped') return { ok: true, message: `${lane.label} 已经停止。` };
      remoteAudit(session, lane, 'supervisor.remote-command', { action: 'stop-lane', actor });
      closeStoppedSupervisorSurfaces([lane]);
      useStore.getState().stopSupervisorLane(lane.id, `由飞书停止 ${lane.label} 并解除终端绑定`);
      return { ok: true, message: `已停止 ${lane.label} 的 AI 监督并解除终端绑定；可重新选择该终端启动监督，其他通道不受影响。` };
    }
    if (action === 'pause-all' || action === 'resume-all' || action === 'toggle-pause') {
      const session = useStore.getState().supervisor;
      const actor = String(params?.actor || 'unknown');
      const ordinaryLanes = session.lanes.filter((lane) => (
        !isProjectManagedSupervisorLane(lane) && isSupervisorLaneBound(lane)
      ));
      const ordinaryActive = ordinaryLanes.some((lane) => supervisorLaneControlState(lane) === 'active');
      const ordinaryPaused = ordinaryLanes.some((lane) => supervisorLaneControlState(lane) === 'paused');
      if (ordinaryLanes.length === 0) {
        return { ok: false, error: '当前没有普通 AI 监督；项目监督请由项目管理 AI 控制。', message: '' };
      }
      if (action === 'pause-all' && !ordinaryActive) {
        return { ok: true, message: '当前普通 AI 监督已经暂停或正在待续。' };
      }
      if (action === 'resume-all' && !ordinaryPaused) {
        return { ok: true, message: '当前普通 AI 监督已经在运行或正在待续。' };
      }
      const shouldPause = action === 'pause-all' || (action === 'toggle-pause' && ordinaryActive);
      if (shouldPause && ordinaryActive) {
        useStore.getState().pauseOrdinarySupervisor('由飞书远程暂停普通监督；项目监督状态不变');
        for (const lane of ordinaryLanes) remoteAudit(session, lane, 'supervisor.remote-command', { action: 'pause', actor });
        return { ok: true, message: '已暂停普通 AI 监督；项目监督不受影响。' };
      }
      const shouldResume = action === 'resume-all' || (action === 'toggle-pause' && ordinaryPaused);
      if (shouldResume && ordinaryPaused) {
        const missingLane = ordinaryLanes.find((lane) => {
          const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
          return supervisorLaneControlState(lane) === 'paused'
            && (
              !supervisorSurfaceId
              || !hasLiveSurface(supervisorSurfaceId)
              || lane.supervisorProblem?.kind === 'runtime-failed'
            );
        });
        if (missingLane) return { ok: false, error: `专属监督终端已缺失：${missingLane.label}。请在 wmux 中停止后重新配置。`, message: '' };
        useStore.getState().resumeOrdinarySupervisor();
        const resumed = useStore.getState().supervisor;
        const pendingLaneIds = new Set(resumed.pendingApprovals.map((item) => item.laneId));
        for (const lane of resumed.lanes.filter((candidate) => !isProjectManagedSupervisorLane(candidate))) {
          remoteAudit(resumed, lane, 'supervisor.remote-command', { action: 'resume', actor });
          const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
          if (supervisorLaneControlState(lane) !== 'active'
            || !supervisorSurfaceId
            || pendingLaneIds.has(lane.id)) continue;
          const retriesWatchdog = lane.supervisorProblem?.kind === 'unreported-decision';
          if (retriesWatchdog) {
            useStore.getState().updateLane(lane.id, {
              reviewWatchdogState: 'retrying',
              reviewDeliveryConfirmedAt: undefined,
              unreportedIdleRecoveryAttempts: 1,
              supervisorProblem: undefined,
            });
          }
          sendToSurface(
            supervisorSurfaceId,
            retriesWatchdog
              ? buildUnacknowledgedSupervisorIdlePrompt(lane)
              : '[会话继续] 用户已通过飞书恢复当前监督会话。请保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n',
            true,
          );
        }
        return { ok: true, message: '已继续普通 AI 监督；项目监督不受影响。' };
      }
      return { ok: false, error: '当前没有可暂停或继续的普通 AI 监督。', message: '' };
    }
    if (action === 'stop') {
      const session = useStore.getState().supervisor;
      const ordinaryLanes = session.lanes.filter((lane) => (
        !isProjectManagedSupervisorLane(lane) && isSupervisorLaneBound(lane)
      ));
      if (ordinaryLanes.length === 0) {
        return { ok: false, error: '当前没有普通 AI 监督；项目监督请由项目管理 AI 控制。', message: '' };
      }
      useStore.getState().stopOrdinarySupervisor('由飞书远程停止普通监督；项目监督状态不变');
      for (const lane of ordinaryLanes) {
        remoteAudit(session, lane, 'supervisor.remote-command', { action: 'stop', actor: String(params?.actor || 'unknown') });
      }
      return { ok: true, message: '已停止普通 AI 监督；项目监督不受影响。' };
    }
    if (action === 'decide') {
      const decision = String(params?.decision || '');
      if (!['approve', 'direct', 'pause', 'stop'].includes(decision)) return { ok: false, error: '无效的人工决策。', message: '' };
      return decideRemoteSupervisor(
        String(params?.approvalId || ''),
        decision as 'approve' | 'direct' | 'pause' | 'stop',
        String(params?.selection || ''),
        String(params?.task || ''),
        String(params?.actor || 'unknown'),
      );
    }
    return { ok: false, error: '不支持的监督控制动作。', message: '' };
  };

  // ─── Markdown ───────────────────────────────────────────────────────────────

  w.__wmux_setMarkdownContent = (surfaceId: string, markdown: string, fileName?: string, filePath?: string, mtimeMs?: number) => {
    // Persist into the store so MarkdownPane (re)renders the content. The old
    // `wmux:markdown-update` CustomEvent had no listener, so content never
    // displayed (issue #54). `fileName`, when the content came from a file, is
    // used as the tab label so multiple markdown tabs stay distinguishable;
    // `filePath` makes the surface path-aware (issue #116) so the pane can show
    // the path, copy it, reveal it, and reload from it.
    // `mtimeMs` (F3) records what was on disk at load time so a later save can
    // detect an agent having rewritten the file underneath the pane.
    useStore.getState().setMarkdownContent(surfaceId as SurfaceId, markdown ?? '', { fileName, filePath, mtimeMs });
    return { ok: true };
  };

  // Read a markdown surface's buffer back out (issue #116). Mirrors
  // __wmux_readScreen for terminals — an agent that pushed content has no other
  // way to check what actually landed.
  w.__wmux_getMarkdownContent = (surfaceId: string) => {
    const state = useStore.getState();
    for (const ws of state.workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const surface = findLeaf(ws.splitTree, paneId)?.surfaces.find((s) => s.id === surfaceId);
        if (surface) {
          return {
            surfaceId,
            content: surface.markdownContent ?? '',
            filePath: surface.markdownFilePath ?? null,
            fileName: surface.markdownFileName ?? null,
            dirty: !!surface.markdownDirty,
          };
        }
      }
    }
    return null;
  };

  // ─── Notifications ──────────────────────────────────────────────────────────

  w.__wmux_listNotifications = () => {
    return useStore.getState().notifications || [];
  };

  w.__wmux_clearNotification = (id: string) => {
    useStore.getState().clearNotification(id);
  };

  w.__wmux_clearAllNotifications = () => {
    useStore.getState().clearAll();
  };

  // ─── Tree ───────────────────────────────────────────────────────────────────

  w.__wmux_getTree = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    return ws?.splitTree || null;
  };
}
