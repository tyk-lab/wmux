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
  markTerminalRuntimeStarting,
  terminalRuntimeStatus,
  waitForTerminalRuntimeReady,
} from './terminal-runtime-lifecycle';
import {
  handleSupervisorUserSubmit,
  resumeWaitingLaneFromSupervisorInput,
} from './supervisor/user-input-precedence';
import { prepareForUserTerminalInput } from './utils/terminal-user-submit';
import {
  PROJECT_MANAGER_RUNTIME_PATH_SUFFIX,
  PROJECT_MANAGER_TERMINAL_NAME,
  PROJECT_MANAGER_ALIGNMENT_GATE,
  projectManagerStartupInput,
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
  type SupervisorLane,
  type SupervisorSession,
} from './store/supervisor-slice';
import {
  buildSupervisorBriefing,
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
import { buildInteractiveAgentLaunch, type InteractiveAgent } from './utils/interactive-agent-launch';
import { announceSupervisorWaitingForDirection } from './supervisor/waiting-notification';
import {
  MAX_PROJECT_PLAN_FILE_BYTES,
  MAX_PROJECT_PLAN_FILES,
  PROJECT_MANAGER_MANUAL_INTERVENTION_REASON_CODES,
  normalizedProjectDirectoryKey,
  normalizeProjectExecutionBudget,
  projectAcceptedRequirementsVersion,
  projectRequirementsVersion,
  type ProjectManagerQuestionOption,
  type ProjectManagerPendingDelivery,
  type ProjectManagerSession,
  type ProjectManagerUserQuestion,
  type ProjectPlanFileSnapshot,
  type ProjectWorkItem,
} from '../shared/project-manager';
import { projectCommandNeedsExplicitId } from '../shared/project-command-scope';
import {
  normalizeTaskChildThreadResponsibilities,
  normalizeTaskThreadResponsibility,
  normalizeTaskWorkMode,
  type TaskWorkMode,
} from '../shared/supervisor-work-mode';
import { evaluateProjectExecutionGuard } from './project-manager/anti-loop';
import { buildProjectSupervisorBriefing, projectContractViolation } from './project-manager/engine';
import {
  projectSupervisorDefaults,
  projectManagerRuntimeDefaults,
  projectTaskTerminalAgent,
  projectTaskTerminalDefaults,
} from './project-manager/agent-defaults';
import { projectSupervisorLaneIds as scopedProjectSupervisorLaneIds } from './project-manager/lane-scope';

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
  return /(?:不要|不得|禁止|避免|不可|不能|无需|无须)[^，。；;！？!?\n]{0,28}$/i.test(clausePrefix);
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
    && TECHNICAL_DECISION.test(blockedReason);
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
  const normalizedEvidence = normalizedEvidenceText(evidence);
  if (normalizedCommand.length < 3 || !normalizedEvidence) return false;
  if (/^(?:permission|approval|allowance|command|request|权限|授权|批准|命令|请求)(?:\s+required)?$/i.test(normalizedCommand)) {
    return false;
  }
  return normalizedEvidence.includes(normalizedCommand);
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
}

interface RemoteTerminalEscape {
  action: 'terminal-escape';
  terminal: string;
  actor?: string;
}

interface RemoteTerminalInterrupt {
  action: 'terminal-interrupt';
  terminal: string;
  actor?: string;
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

function remoteTerminalActivity(surfaceId: SurfaceId): {
  activityState: RemoteTerminalActivityState;
  activityUpdatedAt: number | null;
} {
  const record = (window as any).__wmux_getAgentStates?.()?.[surfaceId];
  const updatedAt = Number.isFinite(record?.updatedAt) ? Number(record.updatedAt) : null;
  const state = ['idle', 'working', 'blocked', 'unknown'].includes(String(record?.state))
    ? record.state as RemoteTerminalActivityState
    : 'unknown';
  if (state === 'working' && (!updatedAt || Date.now() - updatedAt > REMOTE_WORKING_STATE_MAX_AGE_MS)) {
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
        title: projectManagerWorkspaceTitle(project.goal, project.id),
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

function buildProjectTaskStartupBriefing(lane: SupervisorLane): string {
  const config = effectiveSupervisorLaneConfig(lane);
  return [
    '# 项目监督 AI · 首次启动任务终端',
    '',
    '项目管理 AI 已先启动你，但尚未创建任务终端。你必须亲自启动本工作项的专属任务终端；项目管理 AI 不会把任务直接投递到既有终端。',
    `项目 ID：${lane.projectManagerProjectId || '（缺失）'}`,
    `工作项 ID：${lane.projectWorkItemId || '（缺失）'}`,
    `预留任务通道 ID：${lane.surfaceId}`,
    `项目目录：${lane.projectDir || '（缺失）'}`,
    `任务目标：${config.taskGoal || '（缺失）'}`,
    config.taskDescription ? `任务与恢复上下文：\n${config.taskDescription}` : '',
    config.preconditions ? `前置条件：${config.preconditions}` : '',
    `停止条件：${config.stopWhen || '（缺失）'}`,
    '',
    '启动顺序（只能执行一次）：',
    `1. 运行 wmux project task-terminal-start --project ${lane.projectManagerProjectId || '<项目ID>'} --task ${lane.projectWorkItemId || '<工作项ID>'}。`,
    '2. 该受控命令只接受本监督终端调用，会在当前项目执行会话中创建新的任务 AI；不会新建第三个会话，也不会选择、复用或依赖用户现有终端。',
    '3. 命令成功后立即结束当前回合，不要使用通用终端发送接口投递任务。控制层随后会发送绑定真实任务终端后的正式监督协议。',
    '',
    `若启动命令失败，使用 wmux supervisor decide --surface ${lane.surfaceId} --outcome needs-human --proposal-kind important --reason "任务终端启动失败：<具体错误>" --impact "监督 AI 无法建立项目任务运行时" 上报项目管理 AI；不要直接询问用户，也不要自行改用现有终端。`,
  ].filter(Boolean).join('\n');
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
    useStore.getState().pauseSupervisorLane(laneId, `AI 监督运行时启动失败：${ready.error || '未知错误'}`);
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
    useStore.getState().pauseSupervisorLane(
      lane.id,
      `AI 监督启动协议投递失败：${String((error as Error)?.message || error)}`,
    );
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
        stopWhen: params.stopWhen,
        stopWhenKind: params.stopWhenKind,
        planFilePath: params.planFile || '',
        waitForNextDirection: params.waitForNextDirection === true,
        taskWorkMode: normalizeTaskWorkMode(params.taskWorkMode),
        mainThreadResponsibility: normalizeTaskThreadResponsibility(params.mainThreadResponsibility),
        childThreadResponsibilities: normalizeTaskChildThreadResponsibilities(params.childThreadResponsibilities),
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
  const located = locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可发送任务。', message: '' };
  if (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId) {
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
  const lane = session.lanes.find((item) => item.surfaceId === terminal.surfaceId);
  let manuallyResolved = false;
  if (lane) {
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
  remoteAudit(session, lane, 'supervisor.remote-command', { action: 'send-task', terminal: terminal.surfaceId, actor: params.actor || 'unknown', task });
  return { ok: true, message: manuallyResolved
    ? `已向 ${terminal.label} 发送任务，并将内容记录为人工裁决。`
    : `已向 ${terminal.label} 发送任务。` };
}

function sendRemoteTerminalEscape(params: RemoteTerminalEscape): { ok: boolean; message: string; error?: string } {
  const located = locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可中断。', message: '' };
  if (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId) {
    return { ok: false, error: '项目任务终端只能由项目管理模式处理中断。', message: '' };
  }
  try {
    sendToSurface(terminal.surfaceId, '\x1b', false);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err), message: '' };
  }
  const session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => item.surfaceId === terminal.surfaceId);
  remoteAudit(session, lane, 'supervisor.remote-command', {
    action: 'send-escape', terminal: terminal.surfaceId, actor: params.actor || 'unknown',
  });
  return { ok: true, message: `已向 ${terminal.label} 发送 Esc 中断请求。` };
}

function sendRemoteTerminalInterrupt(params: RemoteTerminalInterrupt): { ok: boolean; message: string; error?: string } {
  const located = locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可中断。', message: '' };
  if (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId) {
    return { ok: false, error: '项目任务终端只能由项目管理模式处理中断。', message: '' };
  }
  try {
    sendToSurface(terminal.surfaceId, '\x03', false);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err), message: '' };
  }
  const session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => item.surfaceId === terminal.surfaceId);
  remoteAudit(session, lane, 'supervisor.remote-command', {
    action: 'send-ctrl-c', terminal: terminal.surfaceId, actor: params.actor || 'unknown',
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
    store.rejectPending(approvalId);
    return { ok: false, error: '该待决项已超过 24 小时，已作废。', message: '' };
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
  if (session.paused) return { ok: false, error: '当前监督会话已暂停；请先在 wmux 中继续会话。', message: '' };
  if (!session.active) return { ok: false, error: '当前监督会话已停止，不能处理旧待决项。', message: '' };
  if (!lane) return { ok: false, error: '待决项对应的监督通道不存在。', message: '' };
  const laneState = supervisorLaneControlState(lane);
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

function normalizeProjectWorkItemInput(
  raw: any,
  projectDir: string,
  previous?: ProjectWorkItem,
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
  const taskWorkMode = normalizeTaskWorkMode(executionRaw.taskWorkMode);
  const modeReason = String(executionRaw.modeReason || '').trim().slice(0, 2000)
    || (taskWorkMode === 'multi-thread'
      ? ''
      : '任务复杂度不需要拆分内部线程，采用保守的单线程执行');
  const mainThreadResponsibility = normalizeTaskThreadResponsibility(
    executionRaw.mainThreadResponsibility || objective,
  ).trim();
  const childThreadResponsibilities = normalizeTaskChildThreadResponsibilities(
    executionRaw.childThreadResponsibilities,
  ).map((item) => item.trim()).filter(Boolean);
  if (taskWorkMode === 'multi-thread' && (
    !modeReason || !mainThreadResponsibility || childThreadResponsibilities.length === 0
  )) {
    return { error: '多线程任务必须说明选择理由、主线程职责和至少一个子线程职责' };
  }
  if (taskWorkMode === 'multi-thread' && contractRaw.authority?.internalThreads !== true) {
    return { error: '多线程任务必须明确授权 internalThreads' };
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
  return {
    workItem: {
      id,
      title: String(raw?.title || previous?.title || id).trim().slice(0, 200),
      contract: {
        objective,
        description: String(contractRaw.description || '').trim().slice(0, 4000),
        preconditions: projectStringArray(contractRaw.preconditions),
        scope: {
          root: projectDir,
          allowPaths,
          denyPaths,
          forbiddenActions: projectStringArray(contractRaw.scope?.forbiddenActions),
        },
        authority: {
          technicalChoices: contractRaw.authority?.technicalChoices === true,
          lowRiskRetries: contractRaw.authority?.lowRiskRetries === true,
          targetedTests: contractRaw.authority?.targetedTests === true,
          internalThreads: contractRaw.authority?.internalThreads === true,
        },
        execution: {
          taskWorkMode,
          modeReason,
          mainThreadResponsibility,
          childThreadResponsibilities,
        },
        stopWhen,
        validation,
        budget: normalizeProjectExecutionBudget(contractRaw.budget),
      },
      status: status as ProjectWorkItem['status'],
      dependencies: projectStringArray(raw?.dependencies ?? previous?.dependencies),
      supervisorLaneId: String(previous?.supervisorLaneId || '').trim() || undefined,
      workerSurfaceId,
      // These counters are owned by the control layer. Accepting them from task-create/task-update
      // would let the project-management AI reset anti-loop accounting.
      attempts: previous?.attempts ?? 0,
      decisionsUsed: previous?.decisionsUsed ?? 0,
      startedAt: previous?.startedAt,
      updatedAt: now,
      completedAt: status === 'completed' ? previous?.completedAt || now : undefined,
      executionHistory: previous?.executionHistory || [],
      latestEvidence: String(raw?.latestEvidence ?? previous?.latestEvidence ?? '').trim() || undefined,
      latestContextSummary: String(raw?.latestContextSummary ?? previous?.latestContextSummary ?? '').trim() || undefined,
      latestBlocker: String(raw?.latestBlocker ?? previous?.latestBlocker ?? '').trim() || undefined,
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

function projectRecoveryBriefing(session: ProjectManagerSession, item: ProjectWorkItem): string {
  const recentEvents = session.events
    .filter((event) => !event.workItemId || event.workItemId === item.id)
    .slice(-12)
    .map((event) => `- ${event.kind}：${event.summary}`);
  return [
    '[项目任务冷启动恢复包｜旧终端会话不可恢复]',
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
    '恢复规则：这是新的监督 AI 和新的任务 AI 对话。旧 supervisorLaneId、workerSurfaceId 和终端会话均已失效，只能作为审计历史；禁止读取、发送、重新绑定或等待任何旧终端。先只读检查当前文件、diff、测试产物和进程状态，再决定下一步；不得重新执行已有证据支持的步骤，不得把“会话已丢失”误判为“工作未完成”。',
  ].filter(Boolean).join('\n');
}

function restoredProjectManagerSession(session: ProjectManagerSession, managerSurfaceId?: string): ProjectManagerSession {
  const now = Date.now();
  return {
    ...session,
    preconditions: projectStringArray(session.preconditions),
    planFiles: Array.isArray(session.planFiles) ? session.planFiles : [],
    requirementsVersion: projectRequirementsVersion(session),
    acceptedRequirementsVersion: projectAcceptedRequirementsVersion(session),
    managerSurfaceId,
    taskTerminalSurfaceId: undefined,
    recoveryState: 'checking' as const,
    updatedAt: now,
    workItems: session.workItems.map((item: ProjectWorkItem) => {
      const interrupted = ['running', 'validating'].includes(item.status);
      const hadRuntimeBinding = !!item.workerSurfaceId || !!item.supervisorLaneId;
      const needsRecovery = hadRuntimeBinding && !['completed', 'stopped'].includes(item.status);
      return {
        ...item,
        workerSurfaceId: undefined,
        supervisorLaneId: undefined,
        startedAt: undefined,
        status: interrupted ? 'waiting-decision' : item.status,
        latestBlocker: needsRecovery
          ? [
              '应用重启后原 AI 监督和任务终端对话已失效；项目管理 AI 必须基于恢复包建立新链路',
              item.latestBlocker ? `重启前阻塞：${item.latestBlocker}` : '',
            ].filter(Boolean).join('；')
          : item.latestBlocker,
        updatedAt: needsRecovery || interrupted ? now : item.updatedAt,
      };
    }),
  };
}

function markProjectRecoveryReady(sessionId: string, workItemId: string): void {
  const store = useStore.getState();
  const current = store.projectManagers.find((session) => session.id === sessionId);
  if (!current || current.recoveryState !== 'checking') return;
  store.restoreProjectManager({ ...current, recoveryState: 'ready', updatedAt: Date.now() });
  store.appendProjectManagerEvent({
    kind: 'recovery-restored', workItemId,
    summary: '已基于持久化恢复包建立新 AI 监督和任务终端会话，项目继续推进',
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
  const latestRequired = [...session.events].reverse().find((event) => event.kind === 'requirements-alignment-required');
  if (!latestRequired) return false;
  const latestConfirmed = [...session.events].reverse().find((event) => event.kind === 'requirements-alignment-confirmed');
  return !latestConfirmed || latestRequired.ts > latestConfirmed.ts;
}

function projectRequirementAlignmentState(session: ProjectManagerSession): ProjectRequirementAlignmentState {
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
  if ((goalSpecific && criteriaSpecific && !requestAsCriterion) || planDefinesBoundaries) return 'sufficient';
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
} {
  const supervisor = useStore.getState().supervisor;
  const lanes = supervisor.lanes.filter((lane) => (
    lane.projectManagerProjectId === session.id && supervisorLaneControlState(lane) !== 'stopped'
  ));
  return {
    ...session,
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
const PROJECT_MANAGER_DELIVERY_ALERT_ATTEMPTS = 15;
const PROJECT_PROGRESS_CHECK_INTERVAL_MS = 2 * 60_000;
const PROJECT_ALIGNMENT_FALLBACK_DELAY_MS = 45_000;
const projectProgressTimers = new Map<string, ReturnType<typeof setTimeout>>();
const projectProgressChecks = new Map<string, { fingerprint: string; unchanged: number }>();
const projectAlignmentTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  projectProgressChecks.delete(session.id);
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
    let delivered = false;
    if (!manager) {
      delivery.attempts += 1;
    } else if (remoteTerminalActivity(manager.surfaceId).activityState === 'working') {
      // A busy Project AI must not block deliveries owned by another project.
      continue;
    } else {
      try {
        sendTaskToSurface(manager.surfaceId, delivery.text, true);
        pendingProjectManagerDeliveries.splice(index, 1);
        removePersistedProjectManagerDelivery(session!.id, delivery.id);
        delivered = true;
      } catch {
        delivery.attempts += 1;
      }
    }
    if (delivery.attempts >= PROJECT_MANAGER_DELIVERY_ALERT_ATTEMPTS && !delivery.alerted) {
      delivery.alerted = true;
      notifyProjectManagerDeliveryUnavailable(delivery);
    }
    if (delivered) break;
  }
  if (pendingProjectManagerDeliveries.length === 0) return;
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
      pendingProjectManagerDeliveries.push({ ...delivery, sessionId: session.id, attempts: 0, alerted: false });
    }
  }
  flushProjectManagerDeliveries();
}

function queueProjectManagerDelivery(text: string, sessionId: string): void {
  const delivery: PendingProjectManagerDelivery = {
    id: `pm-delivery-${uuid()}`,
    text,
    createdAt: Date.now(),
    sessionId,
    attempts: 0,
    alerted: false,
  };
  pendingProjectManagerDeliveries.push(delivery);
  if (sessionId) {
    updatePersistedProjectManagerDeliveries(sessionId, (deliveries) => [
      ...deliveries.filter((candidate) => candidate.id !== delivery.id),
      { id: delivery.id, text: delivery.text, createdAt: delivery.createdAt },
    ].slice(-100));
  }
  flushProjectManagerDeliveries();
}

function projectProgressFingerprint(lane: SupervisorLane): string {
  const activity = remoteTerminalActivity(lane.surfaceId);
  const decisions = lane.decisions || [];
  const lastDecision = decisions[0];
  const rawScreen = readTerminalScreen(lane.surfaceId, 30).text || '';
  const excerpt = terminalSupervisorCoreExcerpt(rawScreen, lane.label, activity.activityState);
  const screen = (excerpt.answer || excerpt.text)
    .replace(/\b(working|thinking)\s*\(\d+s\)/giu, '$1')
    .replace(/\b\d+\s*seconds?\s+ago\b/giu, '')
    .replace(/\d+\s*秒前/gu, '')
    .slice(-1200);
  return JSON.stringify([
    lane.projectWorkItemId,
    lane.currentTask,
    supervisorLaneControlState(lane),
    activity.activityState,
    activity.activityUpdatedAt,
    lastDecision?.ts,
    lastDecision?.outcome,
    screen,
  ]);
}

function scheduleProjectProgressCheck(sessionId: string): void {
  const existing = projectProgressTimers.get(sessionId);
  if (existing) globalThis.clearTimeout(existing);
  const timer = globalThis.setTimeout(() => {
    projectProgressTimers.delete(sessionId);
    const store = useStore.getState();
    const session = store.projectManagers.find((candidate) => candidate.id === sessionId);
    if (!session || session.status !== 'active') return;
    const lane = store.supervisor.lanes.find((candidate) => (
      candidate.projectManagerProjectId === sessionId && supervisorLaneControlState(candidate) !== 'stopped'
    ));
    if (!lane?.supervisorSurfaceId) return;
    const fingerprint = projectProgressFingerprint(lane);
    const previous = projectProgressChecks.get(sessionId);
    if (!previous || previous.fingerprint !== fingerprint) {
      projectProgressChecks.set(sessionId, { fingerprint, unchanged: 0 });
      scheduleProjectProgressCheck(sessionId);
      return;
    }
    const unchanged = previous.unchanged + 1;
    projectProgressChecks.set(sessionId, { fingerprint, unchanged });
    if (unchanged === 1) {
      sendToSurface(lane.supervisorSurfaceId, [
        '[项目管理 AI 定时进度检查]',
        `项目：${session.id}`,
        `任务：${lane.projectWorkItemId || '未绑定'}`,
        '连续两个检查周期没有观察到新状态。请只读检查任务终端；正常运行的长任务不要中断。',
        '请报告新证据、阻塞、偏航风险和预计下一步；上下文过长时提供结构化总结并请求轮换终端。',
      ].join('\n'), true);
      store.appendProjectManagerEvent({
        kind: 'progress-inspection', workItemId: lane.projectWorkItemId,
        summary: '连续两个检查周期没有观察到新进展，已询问 AI 监督',
        payload: { laneId: lane.id, unchangedChecks: unchanged },
      }, sessionId);
      saveProjectManagerSnapshot(sessionId);
      scheduleProjectProgressCheck(sessionId);
      return;
    }
    store.appendProjectManagerEvent({
      kind: 'guard-triggered', workItemId: lane.projectWorkItemId,
      summary: '询问 AI 监督后仍无新进展，项目管理 AI 必须调整方向、暂停或重新规划',
      payload: { laneId: lane.id, unchangedChecks: unchanged, decision: 'replan' },
    }, sessionId);
    saveProjectManagerSnapshot(sessionId);
    queueProjectManagerDelivery([
      '[项目无进展护栏]',
      `项目：${session.id} · ${session.projectDir}`,
      `任务：${lane.projectWorkItemId || '未绑定'}`,
      '询问监督后仍没有新状态、输出、证据或错误变化。请停止重复检查，改为调整方向、暂停或重新规划；必要时再上报用户。',
    ].join('\n'), session.id);
  }, PROJECT_PROGRESS_CHECK_INTERVAL_MS);
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
  if (replaceRuntime) {
    await (window as any).wmux?.projectManager?.saveSession?.(initialSession);
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
    const activeWorkItem = current.workItems.find((item) => (
      ['running', 'validating', 'waiting-decision', 'paused'].includes(item.status)
    ));
    deliverProjectManagerMessage([
      '[本项目恢复｜创建全新项目运行链]',
      `项目：${current.id} · ${current.projectDir}`,
      `状态：${current.status}`,
      `目标：${current.goal}`,
      `前置条件：${current.preconditions.length > 0 ? current.preconditions.join('；') : '待核实'}`,
      activeWorkItem
        ? `待续工作项：${activeWorkItem.id} · ${activeWorkItem.title} · ${activeWorkItem.status}${activeWorkItem.latestBlocker ? `；阻塞：${activeWorkItem.latestBlocker}` : ''}`
        : '当前没有待续工作项。',
      '旧项目 AI、监督 AI、任务 AI 及其 surfaceId 都已失效，不得恢复、读取、投递或重新绑定。请根据 latestContextSummary、latestEvidence、latestBlocker 和最近事件重建新的专属监督与任务 AI；不要重做已有证据支持的工作。',
      '你只管理本项目；不得读取或决定项目中心中的其他项目。',
    ].join('\n'), true, current.id);
  }
  current = useStore.getState().projectManagers.find((candidate) => candidate.id === initialSession.id)!;
  if (current.status === 'active' && projectSupervisorLaneIds(current).length > 0) {
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

async function appendProjectRuntimeEvent(
  session: ProjectManagerSession,
  event: {
    kind: 'requirements-quiesced' | 'requirements-quiesce-failed';
    summary: string;
    workItemId?: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const created = useStore.getState().appendProjectManagerEvent(event, session.id);
  const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  await (window as any).wmux?.projectManager?.saveSession?.(updated);
  if (created) {
    await (window as any).wmux?.projectManager?.appendRecord?.({
      sessionId: session.id,
      projectDir: session.projectDir,
      type: created.kind,
      payload: { message: created.summary, ...(created.payload || {}) },
    });
  }
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
    store.pauseSupervisorLane(lane.id, reason);
    if (lane.projectTaskStartupPending) {
      confirmed.push(lane.id);
      continue;
    }
    const terminal = locateRemoteTaskTerminal(lane.surfaceId).terminal;
    if (!terminal) {
      failed.push(lane.id);
      await appendProjectRuntimeEvent(session, {
        kind: 'requirements-quiesce-failed',
        workItemId: lane.projectWorkItemId,
        summary: `需求变更时无法定位任务终端，未能确认旧任务已停止：${lane.label}`,
        payload: { laneId: lane.id, surfaceId: lane.surfaceId, reason },
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
      await appendProjectRuntimeEvent(session, {
        kind: 'requirements-quiesced',
        workItemId: lane.projectWorkItemId,
        summary: `已暂停监督并确认中断旧任务：${lane.label}`,
        payload: { laneId: lane.id, surfaceId: lane.surfaceId, reason },
      });
    } else {
      failed.push(lane.id);
      await appendProjectRuntimeEvent(session, {
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
  if (session.pendingUserQuestion && source === 'user') {
    const superseded = useStore.getState().applyProjectManagerAction({
      type: 'answer-user-clarification',
      questionId: session.pendingUserQuestion.id,
      answer: '用户直接提交了新的项目定义，本问题已失效',
      answeredBy: 'desktop',
    }, session.id);
    if (!superseded.ok) return superseded;
    await persistProjectManagerMutation(superseded, session.id);
    session = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
  }
  if (params?.mode !== undefined && !['revise', 'replace'].includes(params.mode)) {
    return { ok: false, error: '项目需求变更模式必须是 revise 或 replace' };
  }
  const goal = params?.goal === undefined ? session.goal : String(params.goal || '').trim();
  const preconditions = params?.preconditions === undefined
    ? session.preconditions
    : projectStringArray(params.preconditions);
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
  const unchanged = goal === session.goal
    && JSON.stringify(preconditions) === JSON.stringify(session.preconditions)
    && JSON.stringify(doneWhen) === JSON.stringify(session.doneWhen)
    && JSON.stringify(planFiles) === JSON.stringify(session.planFiles);
  if (unchanged) return { ok: false, error: '项目目标和需求没有发生变化' };

  const mode = params?.mode === 'replace' ? 'replace' : 'revise';
  const reason = String(params?.reason || '').trim().slice(0, 2000)
    || `${source === 'user' ? '用户通过项目配置' : '项目管理 AI 根据用户对话'}${mode === 'replace' ? '替换旧目标并要求按新方向重新规划' : '更新项目目标和需求'}`;
  const store = useStore.getState();
  const quiesce = await quiesceProjectRuntimeLanes(
    session,
    '项目目标或需求已更新，停止旧版本任务并等待项目管理 AI 重新规划',
  );
  const result = store.applyProjectManagerAction({
    type: 'update-project-definition',
    goal,
    preconditions,
    planFiles,
    doneWhen,
    reason,
    source,
    mode,
  }, session.id);
  if (!result.ok) return result;
  for (const laneId of projectSupervisorLaneIds(session)) {
    store.pauseSupervisorLane(laneId, '项目目标或需求已更新，等待项目管理 AI 重新规划');
  }
  const timer = projectProgressTimers.get(session.id);
  if (timer) globalThis.clearTimeout(timer);
  projectProgressTimers.delete(session.id);
  projectProgressChecks.delete(session.id);
  await persistProjectManagerMutation(result, session.id);
  const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  if (source === 'user') {
    queueProjectManagerDelivery([
      '[用户更新项目目标与需求｜必须重新评估后回复用户]',
      `项目：${session.id} · ${session.projectDir}`,
      `原目标：${session.goal}`,
      `新目标：${goal}`,
      `变更模式：${mode === 'replace' ? '替换旧目标并从新方向重新规划' : '调整现有需求并评估既有任务'}`,
      `新前置条件：${preconditions.join('；')}`,
      `新完成条件：${doneWhen.join('；')}`,
      `计划文件：${planFiles.length > 0 ? planFiles.map((file) => file.name).join('、') : '无'}`,
      `用户说明：${reason}`,
      '',
      mode === 'replace'
        ? '旧目标已退出当前约束，未完成的旧工作项已停止但保留审计记录。当前监督链已暂停；请按新目标重新拆分任务，必要时轮换任务终端上下文。'
        : `当前项目和监督链已暂停等待复核。请检查既有工作项与新目标是否冲突，停止或改写过期任务，必要时通过 wmux project ask --project ${session.id} 继续澄清。`,
      `完成重规划后，执行 wmux project reply --project ${session.id} --message "<变更影响和新计划>" 回复用户，再显式执行 wmux project resume --project ${session.id}。`,
    ].join('\n'), session.id);
  }
  return {
    ok: true,
    event: result.event,
    session: updated,
    message: source === 'user'
      ? quiesce.failed.length > 0
        ? '项目目标和需求已更新；监督链保持暂停，但部分任务终端未确认中断，已通知用户处理。'
        : '项目目标和需求已更新；旧任务已确认中断，等待项目管理 AI 评估影响并重规划。'
      : quiesce.failed.length > 0
        ? '项目需求已写入；部分旧任务未确认中断，项目保持暂停并已上报用户。'
        : '项目需求已写入且旧任务已确认中断；请完成重规划后显式恢复项目。',
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
  const blocked = paused ? [] : portfolioPaused.filter((session) => (
    !!session.pendingUserQuestion
    || projectRequirementsAlignmentPending(session)
    || projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)
  ));
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
    for (const laneId of projectSupervisorLaneIds(session)) {
      if (paused) store.pauseSupervisorLane(laneId, '项目组合已全局暂停');
      else store.resumeSupervisorLane(laneId, '项目组合已全局恢复');
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
  const created = createRemoteDirectTerminalTask({
    action: 'create-task',
    name: item.title || item.id,
    task: [
      '[项目任务 AI 冷启动]',
      `项目：${session.id}`,
      `工作项：${item.id}`,
      '本终端由该工作项的监督 AI 在同一项目执行会话中创建，是全新的项目专属任务 AI 对话。不要扫描或接管其他终端，也不要自行从项目总目标推断任务。',
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
  if (session.recoveryState === 'checking') markProjectRecoveryReady(session.id, item.id);
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
    store.pauseSupervisorLane(lane.id, '任务终端已就绪，但正式监督协议投递失败');
    return { ok: false, error: `任务终端已就绪，但正式监督协议投递失败：${String((error as Error)?.message || error)}` };
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
  const summary = String(lane.projectTaskRotationSummary || '').trim();
  if (!summary) return { ok: false, error: '当前没有待执行的任务终端轮换请求' };
  const oldTerminal = locateRemoteTaskTerminal(lane.surfaceId).terminal;
  if (!oldTerminal) return { ok: false, error: '原任务终端已经不存在，不能执行安全轮换' };
  const item = lane.projectWorkItemId
    ? session.workItems.find((candidate) => candidate.id === lane.projectWorkItemId)
    : undefined;
  if (!item || item.supervisorLaneId !== lane.id) {
    return { ok: false, error: '工作项与当前 AI 监督绑定不一致，不能轮换任务终端' };
  }
  if (session.status !== 'active'
    || projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)) {
    return { ok: false, error: '项目处于暂停、等待或需求未接受状态，不能轮换任务终端' };
  }
  const rotationRequirementsVersion = projectRequirementsVersion(session);

  const store = useStore.getState();
  const taskDefaults = projectTaskTerminalDefaults(store.workspacePrefs.projectManagementAgents);
  const executionWorkspaceId = projectExecutionWorkspaceId(lane);
  if (!executionWorkspaceId) {
    return { ok: false, error: '项目专属监督不在有效的项目执行会话中，不能轮换任务终端' };
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
  if (!created.ok || !created.surfaceId) return created;
  const replacement = locateRemoteTaskTerminal(created.surfaceId).terminal;
  if (!replacement) {
    closeLiveSurfaceById(created.surfaceId as SurfaceId);
    return { ok: false, error: '新任务终端已创建但无法完成绑定；原任务终端保持不变' };
  }
  const runtimeReady = await waitForTerminalRuntimeReady(replacement.surfaceId);
  if (!runtimeReady.ok) {
    closeLiveSurfaceById(replacement.surfaceId);
    return { ok: false, error: `新任务终端未就绪，原任务终端保持不变：${runtimeReady.error || '未知错误'}` };
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
    return { ok: false, error: '轮换期间项目状态、需求版本或监督绑定已变化；新终端已关闭，原终端保持不变' };
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
    projectTaskRotationPending: false,
    projectTaskRotationSummary: undefined,
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
  if (!projectManagerCallerAllowed(callerSurfaceId, session) && !startupLane && !rotationLane) {
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

  if (action === 'start') {
    const projectDir = String(params?.projectDir || '').trim();
    const goal = String(params?.goal || '').trim();
    const doneWhen = projectStringArray(params?.doneWhen);
    if (!normalizeAbsolutePath(projectDir) || !goal || doneWhen.length === 0) {
      return { ok: false, error: 'projectDir 必须是绝对路径，goal 和 doneWhen 不能为空' };
    }
    return session && normalizedProjectDirectoryKey(session.projectDir) === normalizedProjectDirectoryKey(projectDir)
      ? { ok: true, restored: true, session: projectManagerSessionView(session) }
      : { ok: false, error: '本项目 AI 已绑定一个项目，不能创建、恢复或接管其他项目' };
  }
  store = useStore.getState();
  session = projectSessionForParams(params);
  if (!session) return { ok: false, error: '当前没有项目管理会话' };
  if (action === 'task-terminal-start') {
    if (!startupLane) return { ok: false, error: '只有该工作项的新建 AI 监督可以启动任务终端' };
    return startProjectTaskTerminalFromSupervisor(session, startupLane);
  }
  if (action === 'task-terminal-rotate') {
    if (!rotationLane) return { ok: false, error: '只有该工作项绑定的 AI 监督可以执行任务终端轮换' };
    return rotateProjectTaskTerminalFromSupervisor(session, rotationLane);
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
  if (action === 'alignment-confirm') {
    if (!projectRequirementsAlignmentPending(session)) {
      return { ok: false, error: '该项目当前没有待完成的首次需求充分性检测' };
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
  if (['task-create', 'task-supervise'].includes(action)) {
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
  }

  if (action === 'update-definition') {
    return updateProjectDefinition(session, params, 'manager');
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
    const lastInspection = [...session.events].reverse().find((event) => event.kind === 'progress-inspection');
    if (lastInspection && Date.now() - lastInspection.ts < PROJECT_PROGRESS_CHECK_INTERVAL_MS) {
      return { ok: false, error: '距上次进度检查不足 2 分钟；请等待事件更新，避免重复询问监督 AI' };
    }
    const activity = remoteTerminalActivity(lane.surfaceId);
    const reason = String(params?.reason || '长时间未收到新的项目进度').trim().slice(0, 1000);
    sendToSurface(lane.supervisorSurfaceId, [
      '[项目管理 AI 进度检查]',
      `项目：${session.id}`,
      `任务：${lane.projectWorkItemId || '未绑定'}`,
      `检查原因：${reason}`,
      `任务终端状态：${activity.activityState}`,
      '',
      '请先只读检查任务终端当前状态，不要打断仍在正常运行的长任务。',
      '请说明已有新证据、当前阻塞、是否偏离目标以及下一步；若终端上下文过长，请提供可恢复的结构化总结并请求项目管理 AI 轮换终端。',
    ].join('\n'), true);
    store.appendProjectManagerEvent({
      kind: 'progress-inspection', workItemId: lane.projectWorkItemId,
      summary: `检查 AI 监督：${reason}`,
      payload: { laneId: lane.id, terminalState: activity.activityState },
    }, session.id);
    saveProjectManagerSnapshot(session.id);
    return { ok: true, laneId: lane.id, terminal: activity, message: '已通过协议询问该项目的 AI 监督' };
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
      return { ok: false, error: '该 AI 监督已有待执行的任务终端轮换请求' };
    }
    store.updateLane(lane.id, {
      projectTaskRotationPending: true,
      projectTaskRotationSummary: summary,
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

  if (action === 'task-create') {
    const normalized = normalizeProjectWorkItemInput(params?.workItem || params, session.projectDir);
    if (!normalized.workItem) return { ok: false, error: normalized.error };
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
    if (requestedPatch?.workerSurfaceId !== undefined || requestedPatch?.supervisorLaneId !== undefined) {
      return { ok: false, error: '任务终端和监督通道绑定由控制层维护，项目管理 AI 不能修改' };
    }
    const normalized = normalizeProjectWorkItemInput({ ...previous, ...requestedPatch, id: workItemId }, session.projectDir, previous);
    if (!normalized.workItem) return { ok: false, error: normalized.error };
    if (normalized.workItem.status === 'completed' && !normalized.workItem.latestEvidence) {
      return { ok: false, error: '任务完成状态必须附带可复核的 latestEvidence' };
    }
    if (normalized.workItem.status === 'completed' && normalized.workItem.latestBlocker) {
      return {
        ok: false,
        error: `任务仍有 latestBlocker，不能标记完成。若确实需要用户介入，请先用 wmux project ask --project ${session.id} 发起 manual-intervention；用户答复并处理后显式清空 latestBlocker。`,
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
    if (session.status !== 'active') return { ok: false, error: '项目处于暂停或等待状态，不能启动新监督任务' };
    if (projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)) {
      return { ok: false, error: '项目管理 AI 尚未接受最新需求版本，完成重规划并显式恢复后才能启动监督' };
    }
    if (['completed', 'stopped'].includes(item.status)) return { ok: false, error: '已完成或停止的任务不能再次启动监督' };
    const incompleteDependency = item.dependencies.find((id) => (
      session.workItems.find((candidate) => candidate.id === id)?.status !== 'completed'
    ));
    if (incompleteDependency) return { ok: false, error: `依赖任务尚未完成：${incompleteDependency}` };
    if (item.workerSurfaceId) {
      const boundWorker = locateRemoteTaskTerminal(item.workerSurfaceId).terminal;
      if (!boundWorker || boundWorker.surface.projectManagerProjectId !== session.id) {
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
    const contractBriefing = [
      projectPreconditions.length > 0
        ? `[项目级前置条件｜已确认且持续有效]\n${projectPreconditions.map((condition) => `- ${condition}`).join('\n')}\n这些条件由用户在当前需求版本中确认，既是已知事实，也是其中明确写出的操作授权；在用户未更新、且没有具体反证时，监督 AI 和任务 AI 必须持续沿用，不得每一步重新询问、重新授权或要求重复取证。若条件明确允许对同一设备执行运行、上电、测试或验证，可在合同范围和既定风险等级内连续推进。只有收到条件变更、发现明确冲突，或进入原条件未覆盖的新设备/环境/更高风险动作时才暂停并上报。任务 AI 自身再次询问不构成条件变化。`
        : '[项目级前置条件｜待核实]\n用户尚未声明额外条件。规划和执行前必须主动核实是否存在物理、环境、权限或资源约束；不确定时暂停并询问项目管理 AI。',
      buildProjectSupervisorBriefing({ workItemId, contract: item.contract }),
      recoveryContext ? `[项目恢复上下文]\n${recoveryContext}\n不要重做已有证据支持的工作，先核对当前终端状态后继续。` : '',
    ].filter(Boolean).join('\n\n');
    const existingLane = projectLanes[0];
    if (existingLane) {
      if (existingLane.projectWorkItemId === item.id) return { ok: false, error: '该任务已有监督通道，不能重复启动' };
      const previousItem = session.workItems.find((candidate) => candidate.id === existingLane.projectWorkItemId);
      if (previousItem && !['completed', 'stopped'].includes(previousItem.status)) {
        return { ok: false, error: '该项目上一项任务尚未完成，不能启动下一项任务' };
      }
      if (item.workerSurfaceId && existingLane.surfaceId !== item.workerSurfaceId) {
        return { ok: false, error: '每个项目只能使用一个任务终端；需要更换时请先执行终端上下文轮换' };
      }
      const reusableWorker = locateRemoteTaskTerminal(existingLane.surfaceId).terminal;
      if (!reusableWorker || reusableWorker.surface.projectManagerProjectId !== session.id) {
        return { ok: false, error: '项目原任务终端已经失效；请停止旧监督并建立新的监督链' };
      }
      if (supervisorLaneControlState(existingLane) === 'waiting' || supervisorLaneControlState(existingLane) === 'paused') {
        store.resumeSupervisorLane(existingLane.id, '项目管理 AI 已派发下一项任务');
      }
      const currentLane = useStore.getState().supervisor.lanes.find((lane) => lane.id === existingLane.id) || existingLane;
      store.updateLane(existingLane.id, {
        projectWorkItemId: item.id,
        currentTask: item.contract.objective,
        awaitingReview: false,
        config: {
          ...effectiveSupervisorLaneConfig(currentLane),
          taskGoal: item.contract.objective,
          taskDescription: [item.contract.description, contractBriefing].filter(Boolean).join('\n\n'),
          preconditions: [...projectPreconditions, ...item.contract.preconditions].join('；'),
          stopWhen: item.contract.stopWhen.join('；'),
          stopWhenKind: 'concrete',
          waitForNextDirection: true,
          taskWorkMode: execution.taskWorkMode,
          mainThreadResponsibility: execution.mainThreadResponsibility,
          childThreadResponsibilities: execution.childThreadResponsibilities,
        },
      });
      const reboundLane = useStore.getState().supervisor.lanes.find((lane) => lane.id === existingLane.id);
      if (reboundLane?.supervisorSurfaceId) {
        sendToSurface(reboundLane.supervisorSurfaceId, buildSupervisorBriefing(
          useStore.getState().supervisor,
          { lane: reboundLane, state: String(((window as any).__wmux_getAgentStates?.() || {})[reboundLane.surfaceId]?.state || 'unknown') },
        ), true);
      }
      store.applyProjectManagerAction({
        type: 'update-work-item', workItemId: item.id,
        patch: {
          supervisorLaneId: existingLane.id,
          workerSurfaceId: existingLane.surfaceId,
          status: 'running',
          startedAt: Date.now(),
        },
      }, session.id);
      store.appendProjectManagerEvent({
        kind: 'dispatch-mode-selected', workItemId: item.id,
        summary: `${execution.taskWorkMode === 'multi-thread' ? '多线程' : '单线程'}：${execution.modeReason}`,
        payload: { ...execution },
      }, session.id);
      markProjectRecoveryReady(session.id, item.id);
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
    const dispatchRequirementsVersion = projectRequirementsVersion(session);
    const started = startRemoteSupervisor({
      action: 'start',
      terminals: [item.workerSurfaceId || reservedSurfaceId],
      stopWhen: item.contract.stopWhen.join('；'),
      stopWhenKind: 'concrete',
      taskGoal: item.contract.objective,
      taskDescription: [item.contract.description, contractBriefing].filter(Boolean).join('\n\n'),
      preconditions: [...projectPreconditions, ...item.contract.preconditions].join('；'),
      autonomous: true,
      supervisorLaunchCmd: supervisorDefaults.supervisorLaunchCmd,
      supervisorModel: supervisorDefaults.supervisorModel,
      supervisorReasoningEffort: supervisorDefaults.supervisorReasoningEffort,
      autonomyPermissions: [
        'same-route-next',
        'permission-confirm',
        ...(item.contract.authority.technicalChoices ? ['technical-choice' as const] : []),
        ...(item.contract.authority.lowRiskRetries ? ['route-adjustment' as const] : []),
      ],
      actor: `project-manager:${session.id}`,
      projectWorkItemId: item.id,
      projectManagerProjectId: session.id,
      waitForNextDirection: true,
      taskWorkMode: execution.taskWorkMode,
      mainThreadResponsibility: execution.mainThreadResponsibility,
      childThreadResponsibilities: execution.childThreadResponsibilities,
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
      store.appendProjectManagerEvent({
        kind: 'supervisor-runtime-failed',
        workItemId: item.id,
        summary: `AI 监督运行时启动失败：${supervisorRuntimeReady.error || '未知错误'}`,
        payload: { laneId: lane.id, supervisorSurfaceId: lane.supervisorSurfaceId },
      }, session.id);
      saveProjectManagerSnapshot(session.id);
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
    ) {
      store.stopSupervisorLane(lane.id, 'AI 监督启动期间项目状态或需求版本发生变化');
      closeLiveSurfaceById(lane.supervisorSurfaceId);
      return { ok: false, error: 'AI 监督启动期间项目状态或需求版本已变化；旧任务未派发' };
    }
    store.updateLane(lane.id, {
      autonomyPermissionsOverride: [
        'same-route-next',
        ...(item.contract.authority.technicalChoices ? ['technical-choice' as const] : []),
        ...(item.contract.authority.lowRiskRetries ? ['route-adjustment' as const] : []),
      ],
    });
    store.appendProjectManagerEvent({
      kind: 'dispatch-mode-selected', workItemId: item.id,
      summary: `${execution.taskWorkMode === 'multi-thread' ? '多线程' : '单线程'}：${execution.modeReason}`,
      payload: { ...execution },
    }, session.id);
    store.applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: item.id,
      patch: { supervisorLaneId: lane.id, status: 'running', startedAt: Date.now() },
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
    store.applyProjectManagerAction({ type: 'record-execution', workItemId, record: guard.record }, session.id);
    if (guard.decision !== 'allow') {
      store.applyProjectManagerAction({
        type: 'update-work-item',
        workItemId,
        patch: {
          status: guard.decision === 'pause' ? 'paused' : 'waiting-decision',
          latestBlocker: guard.reason,
        },
      }, session.id);
      store.appendProjectManagerEvent({
        kind: 'guard-triggered',
        workItemId,
        summary: guard.reason || '执行护栏已触发',
        payload: { decision: guard.decision },
      }, session.id);
    }
    await (window as any).wmux?.projectManager?.saveSession?.(
      useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
    );
    return { ok: guard.decision === 'allow', guard: guard.decision, error: guard.reason, record: guard.record };
  }
  if (action === 'pause') {
    if (session.status !== 'active' && session.status !== 'waiting') return { ok: false, error: '项目当前状态不能暂停' };
    const reason = String(params?.reason || '由项目管理 AI 暂停');
    const result = store.applyProjectManagerAction({ type: 'pause-project', reason }, session.id);
    for (const laneId of projectSupervisorLaneIds(session)) store.pauseSupervisorLane(laneId, '项目管理会话已暂停');
    const timer = projectProgressTimers.get(session.id);
    if (timer) globalThis.clearTimeout(timer);
    projectProgressTimers.delete(session.id);
    await persistProjectManagerMutation(result, session.id);
    return result;
  }
  if (action === 'resume') {
    if (session.status !== 'paused' && session.status !== 'waiting') return { ok: false, error: '只有暂停或等待中的项目可以恢复' };
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
    const result = store.applyProjectManagerAction({
      type: 'resume-project',
      reason: String(params?.reason || '由项目管理 AI 恢复'),
      acceptRequirementsVersion: true,
    }, session.id);
    for (const laneId of projectSupervisorLaneIds(session)) store.resumeSupervisorLane(laneId, '项目管理会话已恢复');
    scheduleProjectProgressCheck(session.id);
    return persistProjectManagerMutation(result, session.id);
  }
  if (action === 'complete') {
    const evidence = String(params?.evidence || '').trim();
    return persistProjectManagerMutation(store.applyProjectManagerAction({ type: 'complete-project', evidence }, session.id), session.id);
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

  pendingProjectManagerDeliveries.splice(0);
  projectManagerDeliveryScheduled = false;
  deletingProjectManagerSessions.clear();
  projectManagerRecoveryChoice = 'pending';
  for (const timer of projectProgressTimers.values()) globalThis.clearTimeout(timer);
  projectProgressTimers.clear();
  projectProgressChecks.clear();
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
          goal: session.goal,
          status: session.status,
          workItemCount: session.workItems.length,
          updatedAt: session.updatedAt,
        })),
      };
    }
    if (action === 'restore-projects') {
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
      projectManagerRecoveryChoice = 'restore';
      const recoveredSessions = candidates.map((session: ProjectManagerSession) => (
        restoredProjectManagerSession(session)
      ));
      useStore.getState().restoreProjectManagers(recoveredSessions, recoveredSessions[0]?.id);
      for (const session of recoveredSessions) {
        await (window as any).wmux?.projectManager?.saveSession?.(session);
      }
      const failures: string[] = [];
      for (const session of recoveredSessions) {
        const runtime = await ensureProjectManagerRuntime(session.id, { recoveredAfterRestart: true });
        if (runtime.ok) continue;
        failures.push(`${session.goal}：${runtime.error || '项目 AI 启动失败'}`);
        useStore.getState().appendProjectManagerEvent({
          kind: 'manager-runtime-failed',
          summary: runtime.error || '项目 AI 启动失败',
        }, session.id);
        useStore.getState().applyProjectManagerAction({
          type: 'pause-project',
          reason: runtime.error || '项目 AI 启动失败',
        }, session.id);
        await (window as any).wmux?.projectManager?.saveSession?.(
          useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
        );
      }
      store = useStore.getState();
      return {
        ok: true,
        restored: store.projectManagers.length > 0,
        projects: store.projectManagers.map(projectManagerSessionView),
        message: failures.length > 0
          ? `已恢复 ${store.projectManagers.length} 个项目；${failures.length} 个项目的专属项目 AI 启动失败并已暂停。`
          : `已恢复 ${store.projectManagers.length} 个项目，并分别启动专属项目 AI。`,
        ...(failures.length > 0 ? { warnings: failures } : {}),
      };
    }
    if (action === 'skip-project-recovery') {
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
      const goal = String(params?.goal || '').trim();
      const preconditions = projectStringArray(params?.preconditions);
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
      if (!normalizeAbsolutePath(projectDir) || !goal || doneWhen.length === 0) {
        return { ok: false, error: 'projectDir 必须是绝对路径，goal 和 doneWhen 不能为空' };
      }
      if (projectManagerRecoveryChoice === 'pending') projectManagerRecoveryChoice = 'skip';
      const directoryKey = normalizedProjectDirectoryKey(projectDir);
      const current = store.projectManagers.find((candidate) => (
        normalizedProjectDirectoryKey(candidate.projectDir) === directoryKey
        && !['completed', 'stopped'].includes(candidate.status)
      ));
      if (current) {
        const runtime = await ensureProjectManagerRuntime(current.id);
        if (!runtime.ok) return { ok: false, error: runtime.error };
        store = useStore.getState();
        store.selectProjectManager(current.id);
        const refreshed = store.projectManagers.find((candidate) => candidate.id === current.id) || current;
        return { ok: true, restored: true, session: projectManagerSessionView(refreshed), projects: store.projectManagers.map(projectManagerSessionView) };
      }
      const restored = await (window as any).wmux?.projectManager?.readLatestSession?.(projectDir);
      const session = restored && ['active', 'paused', 'waiting'].includes(restored.status)
        ? restoredProjectManagerSession(restored)
        : store.startProjectManager({ projectDir, goal, preconditions, planFiles, doneWhen });
      if (restored && ['active', 'paused', 'waiting'].includes(restored.status)) store.restoreProjectManager(session);
      await (window as any).wmux?.projectManager?.saveSession?.(session);
      const runtime = await ensureProjectManagerRuntime(session.id, {
        recoveredAfterRestart: !!restored && ['active', 'paused', 'waiting'].includes(restored.status),
      });
      if (!runtime.ok || !runtime.manager) {
        useStore.getState().appendProjectManagerEvent({
          kind: 'manager-runtime-failed',
          summary: runtime.error || '项目 AI 启动失败',
        }, session.id);
        await (window as any).wmux?.projectManager?.saveSession?.(
          useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
        );
        return { ok: false, error: runtime.error || '项目 AI 尚未就绪' };
      }
      if (!restored) {
        await requireProjectRequirementsAlignment(session.id, '项目首次启动，必须先完成需求充分性检测', runtime.created === true);
      }
      const activeSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
      if (!restored) deliverProjectManagerMessage([
        '[项目管理 AI 会话]',
        `项目 ID：${activeSession.id}`,
        `项目目录：${activeSession.projectDir}`,
        `项目目标：${activeSession.goal}`,
        `项目级前置条件：${activeSession.preconditions.length > 0 ? activeSession.preconditions.join('；') : '未声明；规划前必须主动核实物理、环境、权限和资源条件'}`,
        '已记录的前置条件和其中明确授权，在当前需求版本内持续有效。用户未发送变更且没有具体反证时，项目 AI、监督 AI 和任务 AI 都应直接继承，不得把同一上电、运行、测试、环境或安全条件拆成逐步确认。',
        `完成条件：${activeSession.doneWhen.join('；')}`,
        projectPlanFilesBriefing(activeSession.planFiles || []),
        '',
        '你只管理当前这一个项目。项目 AI、专属监督 AI 和任务 AI 都在本项目的独立会话中；不得读取或决定其他项目。',
        '[首次需求对齐门禁｜必须先执行]',
        PROJECT_MANAGER_ALIGNMENT_GATE,
        `本项目的结构化提问命令必须包含：wmux project ask --project ${activeSession.id} --json-file <项目目录内的 .wmux/tmp/文件>。禁止把“请回复”“若无偏好”等问题只输出在项目管理终端后停住，因为用户不会直接监看该终端。`,
        '所有项目专属命令都必须显式携带 --project <项目ID>；不要依赖界面当前选中项目，也不要把普通执行过程发送给用户。',
        `每个有意义的里程碑及监督进入待续/阻塞前，必须用 wmux project task-update --project ${activeSession.id} 持久化 latestContextSummary、latestEvidence 和 latestBlocker，供软件重启后创建新 AI 会话续作。`,
        `需求不足或用户偏好不明确时，必须用 wmux project ask --project ${activeSession.id} 发起 category=clarification 的结构化飞书通知；阻塞超出你的决策权或需要人工操作时改用 category=manual-intervention。用户答复后先决定下一步，不得自动恢复任务。`,
        ].join('\n'), runtime.created === true, activeSession.id);
      return { ok: true, restored: !!restored, session: activeSession };
    }
    if (action === 'message') {
      const selectedProject = projectSessionForParams(params);
      if (!selectedProject) return { ok: false, error: '请先在项目中心选择消息所属项目' };
      const runtime = await ensureProjectManagerRuntime(selectedProject.id);
      const manager = runtime.manager;
      if (!runtime.ok || !manager) return { ok: false, error: runtime.error || '项目管理 AI 尚未就绪' };
      const message = String(params?.message || '').trim();
      if (!message) return { ok: false, error: '项目管理消息不能为空' };
      const messageSource = String(params?.source || '').trim() === 'desktop'
        ? '桌面'
        : String(params?.chatId || '').trim()
          ? '飞书'
          : '桌面';
      store = useStore.getState();
      store.restoreProjectManager({
        ...selectedProject,
        managerSurfaceId: manager.surfaceId,
        feishuChatId: String(params?.chatId || selectedProject.feishuChatId || '') || undefined,
        updatedAt: Date.now(),
      });
      store.appendProjectManagerEvent({
        kind: 'user-message',
        correlationId: String(params?.messageId || '') || undefined,
        summary: message,
      }, selectedProject.id);
      await (window as any).wmux?.projectManager?.saveSession?.(
        useStore.getState().projectManagers.find((candidate) => candidate.id === selectedProject.id),
      );
      deliverProjectManagerMessage([
        `[${messageSource}项目管理消息｜必须回复到对应项目会话]`,
        `消息 ID：${String(params?.messageId || 'unknown')}`,
        `当前项目 ID：${selectedProject?.id || '未选择'}`,
        `当前项目目录：${selectedProject?.projectDir || '未选择'}`,
        message,
        '',
        `请作为本项目的专属项目 AI 直接回复用户。需要执行管理动作时使用 wmux project；若消息确认了目标、范围、前置条件或完成条件的变化，先执行 wmux project update --project ${selectedProject.id} --json-file <项目目录内的 .wmux/tmp/文件> 将新需求写回项目记录：调整需求使用 mode=revise，用户明确清除旧目标并切换方向时使用 mode=replace。随后评估既有任务是否需要停止或重规划。最终必须执行 wmux project reply --project ${selectedProject.id} --correlation "${String(params?.messageId || 'unknown')}" --message "<回复内容>"，让回复进入该项目自己的桌面/飞书会话。`,
      ].filter(Boolean).join('\n'), runtime.created === true, selectedProject.id);
      return { ok: true, message: '消息已交给项目管理 AI' };
    }
    if (action === 'event') {
      store = useStore.getState();
      const session = projectSessionForParams(params);
      if (!session) return { ok: false, error: '当前没有项目管理会话' };
      const workItemId = String(params?.workItemId || '').trim();
      const summary = String(params?.summary || params?.eventType || '').trim().slice(0, 1200);
      const eventType = String(params?.eventType || '');
      const decisionRequest = eventType === 'supervisor.approval.requested'
        || eventType === 'supervisor.waiting-for-direction'
        || eventType === 'worker.blocked';
      store.appendProjectManagerEvent({
        kind: decisionRequest ? 'supervisor-decision-request' : 'supervisor-decision',
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
            ...(decisionRequest ? { status: 'waiting-decision' as const } : {}),
            ...(contextSummary ? { latestContextSummary: contextSummary } : {}),
            ...(evidence ? { latestEvidence: evidence } : {}),
            ...((blocker || decisionRequest) ? { latestBlocker: blocker || summary } : {}),
          },
        }, session.id);
      }
      await (window as any).wmux?.projectManager?.saveSession?.(
        useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
      );
      scheduleProjectProgressCheck(session.id);
      queueProjectManagerDelivery([
        '[项目监督事件]',
        `项目：${session.id} · ${session.projectDir}`,
        `任务：${workItemId || '未知'}`,
        `类型：${String(params?.eventType || 'event')}`,
        `摘要：${summary}`,
        '',
        decisionRequest
          ? `该监督决策只交给项目管理 AI。请先对照当前项目已确认前置条件和授权：若只是重复确认同一设备、上电、运行、测试、环境或安全条件，直接在合同内决定并让监督继续，不得询问用户。只有发现条件已变化的具体证据、超出原授权设备/环境/范围，或涉及用户偏好及高风险动作时，才执行 wmux project ask --project ${session.id}，并在 JSON 中设置 category=manual-intervention、workItemId、blocker 和 reasonCode，通过飞书请用户指示。存在 latestBlocker 时禁止将任务或项目标记完成。`
          : '请更新项目任务状态并决定继续、重规划、暂停或验收。普通执行过程不要发送给用户。',
      ].join('\n'), session.id);
      return { ok: true };
    }
    store = useStore.getState();
    const session = projectSessionForParams(params);
    if (!session) return { ok: false, error: '当前没有项目管理会话' };
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
      const progressTimer = projectProgressTimers.get(session.id);
      if (progressTimer) {
        clearTimeout(progressTimer);
        projectProgressTimers.delete(session.id);
      }
      projectProgressChecks.delete(session.id);
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
        for (const laneId of projectSupervisorLaneIds(session)) store.resumeSupervisorLane(laneId, '由飞书恢复项目管理会话');
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
    const next = String(params?.next || '').trim().slice(0, 4000);
    const proposalKind = String(params?.proposalKind || '').trim();
    const impact = String(params?.impact || '').trim().slice(0, 1200);
    const alternatives = String(params?.alternatives || '').trim().slice(0, 1200);
    const permissionCommand = String(params?.permissionCommand || '').trim().slice(0, 2000);
    const permissionResponse = String(params?.permissionResponse || '').trim().slice(0, 16);
    const valid = new Set(['continue', 'rework', 'complete', 'needs-human']);
    const proposalKinds = new Set(['route-change', 'important', 'context-recovery']);
    const lane = session.lanes.find((item) => item.surfaceId === surfaceId);
    if (!session.active || !lane || !isSupervisorDecisionAuthorised(lane, supervisorSurfaceId) || !valid.has(outcome)) return null;
    const laneState = supervisorLaneControlState(lane);
    if (laneState !== 'active') return { ok: false, error: laneState === 'paused' ? '当前监督通道已暂停' : '当前监督通道已停止' };
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
    const remoteNextBlockReason = remoteSshControl ? remoteSshActionBlockReason(next) : null;
    if (outcome !== 'needs-human' && remoteNextBlockReason) {
      return { ok: false, error: `SSH 远程控制终端禁止自动执行${remoteNextBlockReason}；请使用 needs-human 交给人工处理` };
    }
    const nextBlockReason = autonomousActionBlockReason(next);
    if (outcome !== 'needs-human' && nextBlockReason) {
      return { ok: false, error: `监督 AI 禁止自动执行${nextBlockReason}；请使用 needs-human 交给人工处理` };
    }
    const forbiddenActions = effectiveSupervisorForbiddenActions(session, lane);
    const configuredNextBlockReason = configuredActionBlockReason(next, forbiddenActions);
    if (outcome !== 'needs-human' && configuredNextBlockReason) {
      return { ok: false, error: `该动作命中用户勾选的禁止事项：${configuredNextBlockReason}；请使用 needs-human` };
    }
    const effectiveWorkScope = effectiveSupervisorWorkScope(session, lane);
    const scopeBlockReason = workScopeBlockReason(
      next,
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
    if (!lane.awaitingReview && !proactiveProjectFollowUp) {
      return { ok: false, error: lane.projectManagerProjectId
        ? '当前没有待裁决轮次；项目专属监督仅可在任务终端非运行时，携带明确的低风险 --next 主动提交 continue/rework'
        : '当前没有待裁决轮次；请等待工作终端任务结束或权限阻塞通知' };
    }
    if (proactiveProjectFollowUp && lane.decisions?.[0]?.outcome === outcome
      && lane.decisions[0].next.trim() === next && params?.retry !== true) {
      return { ok: false, error: '该主动补证指令与上一条裁决完全相同；请等待状态变化，或在有新失败证据时显式标记 retry' };
    }
    const selectedPermissions = selectedAutonomyPermissions(
      effectiveSupervisorAutonomyPermissions(session, lane),
    );
    const requiredPermissions = requiredAutonomyPermissions({
      outcome,
      next,
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
    } else if (agentState?.state === 'blocked' && outcome !== 'needs-human' && !next) {
      return { ok: false, error: '工作终端仍在阻塞；请明确回答技术问题、确认低风险权限，或使用 needs-human' };
    } else if (next && outcome !== 'needs-human') {
      if (agentState?.state === 'working') {
        return { ok: false, error: '工作终端仍在运行，不能注入下一步' };
      }
      if (isPermissionBlockedState(agentState)) {
        return { ok: false, error: '当前是权限阻塞，必须使用权限确认参数，不能发送普通下一步' };
      }
      if (agentState?.state === 'blocked' && !isQuestionBlockedState(agentState)) {
        return { ok: false, error: '当前阻塞不是明确的技术问题或方案选择，不能自动输入内容' };
      }
      if (isQuestionBlockedState(agentState) && !isLowRiskTechnicalQuestion(agentState, next)) {
        return { ok: false, error: '当前输入涉及用户偏好、业务/账户决定或缺少明确技术证据；请使用 needs-human' };
      }
      if (isQuestionBlockedState(agentState) && blockedRequestAlreadyAnswered(lane, agentState)) {
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

    const projectSession = lane.projectManagerProjectId
      ? store.projectManagers.find((candidate) => candidate.id === lane.projectManagerProjectId)
      : store.projectManager;
    const projectWorkItem = lane.projectWorkItemId
      ? projectSession?.workItems.find((item) => item.id === lane.projectWorkItemId)
      : undefined;
    if (projectSession && projectWorkItem && permissionResponse) {
      if (projectAcceptedRequirementsVersion(projectSession) !== projectRequirementsVersion(projectSession)) {
        return { ok: false, error: '项目需求或前置条件已经更新；旧版本授权已经失效，必须交回项目管理 AI 重新规划' };
      }
      const permissionTestCommand = /(?:^|\s)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test(?::[^\s]+)?|vitest|jest)|npx\s+(?:vitest|jest)|python(?:\.exe)?\s+-m\s+pytest|pytest|vitest|jest|cargo\s+test|go\s+test|dotnet\s+test|ctest|mvn\s+test|(?:gradle|gradlew|\.\/gradlew)\s+test)\b/i.test(permissionCommand)
        ? permissionCommand
        : undefined;
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
        saveProjectManagerSnapshot(projectSession.id);
        return { ok: false, error: contractViolation };
      }
    }
    if (projectSession && projectWorkItem && !permissionResponse) {
      if (projectAcceptedRequirementsVersion(projectSession) !== projectRequirementsVersion(projectSession)) {
        return { ok: false, error: '项目需求或前置条件已经更新；当前监督裁决基于旧版本，必须交回项目管理 AI 重新规划' };
      }
      if (outcome === 'needs-human') {
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: { status: 'waiting-decision', latestBlocker: reason || '监督 AI 请求项目管理决策' },
        }, projectSession.id);
        saveProjectManagerSnapshot(projectSession.id);
      } else {
        const contractViolation = projectContractViolation(projectWorkItem.contract, {
          instruction: next,
          command: String(params?.command || ''),
          changedFiles: projectStringArray(params?.changedFiles),
          testCommand: String(params?.testCommand || '') || undefined,
          retry: params?.retry === true,
        });
        if (contractViolation) {
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: { status: 'waiting-decision', latestBlocker: contractViolation },
          }, projectSession.id);
          store.updateLane(lane.id, { awaitingReview: true });
          saveProjectManagerSnapshot(projectSession.id);
          return { ok: false, error: contractViolation };
        }
        if (outcome === 'complete' && !String(params?.evidence || '').trim()) {
          return { ok: false, error: '项目管理任务完成裁决必须通过 --evidence 提供验证证据' };
        }
        if (params?.retry === true && projectWorkItem.attempts >= projectWorkItem.contract.budget.maxTaskRetries) {
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
          saveProjectManagerSnapshot(projectSession.id);
          return { ok: false, error: '已达到任务重试上限，必须交回项目管理 AI 重新规划' };
        }
        const guard = evaluateProjectExecutionGuard({
          history: projectWorkItem.executionHistory,
          proposal: {
            action: String(params?.executionAction || next || outcome),
            command: String(params?.command || next || ''),
            error: String(params?.error || '') || undefined,
            changedFiles: projectStringArray(params?.changedFiles),
            evidence: String(params?.evidence || ''),
            workspaceVersion: String(params?.workspaceVersion || ''),
            testCommand: String(params?.testCommand || '') || undefined,
            testResult: String(params?.testResult || '') || undefined,
            fullSuite: params?.fullSuite === true,
            now: Date.now(),
          },
          budget: projectWorkItem.contract.budget,
          decisionsUsed: projectWorkItem.decisionsUsed,
          startedAt: projectWorkItem.startedAt,
        });
        store.applyProjectManagerAction({
          type: 'record-execution',
          workItemId: projectWorkItem.id,
          record: guard.record,
        }, projectSession.id);
        if (guard.decision !== 'allow') {
          const itemStatus = guard.decision === 'pause' ? 'paused' : 'waiting-decision';
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: { status: itemStatus, latestBlocker: guard.reason },
          }, projectSession.id);
          store.appendProjectManagerEvent({
            kind: 'guard-triggered',
            workItemId: projectWorkItem.id,
            summary: guard.reason || '执行护栏已触发',
            payload: { decision: guard.decision },
          }, projectSession.id);
          if (guard.decision === 'pause') store.pauseSupervisorLane(lane.id, guard.reason);
          else store.updateLane(lane.id, { awaitingReview: true });
          saveProjectManagerSnapshot(projectSession.id);
          return { ok: false, error: `${guard.reason}；已停止自动推进并交回项目管理 AI` };
        }
        if (params?.retry === true) {
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: { attempts: projectWorkItem.attempts + 1 },
          }, projectSession.id);
        }
        if (outcome === 'complete') {
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: { status: 'validating', latestEvidence: String(params?.evidence || '').trim() },
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
      proactiveProjectFollowUp,
      requiresHuman: limitReached && outcome !== 'needs-human',
    });
    store.appendSupervisorLog(lane.id, '监督裁决', `${outcome}${reason ? `：${reason}` : ''}`);
    store.updateLane(lane.id, {
      autoDecisionsUsed,
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
      store.updateLane(lane.id, { awaitingDirectionAfterWaitingResume: false });
      store.confirmStopCondition(lane.id);
      announceSupervisorWaitingForDirection(lane, reason || '监督 AI 已确认达到停止条件');
      return { ok: true, outcome };
    }

    const failDelivery = (
      kind: 'next' | 'permission',
      label: string,
      error: string,
      delivery?: SupervisorDeliveryObservation,
    ) => {
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
      const finishPermission = (delivery?: SupervisorDeliveryObservation) => {
        appendSupervisorRecord(session, lane, 'supervisor.permission-approved', {
          command: permissionCommand,
          response: permissionResponse,
        });
        store.appendSupervisorLog(lane.id, 'AI 自动授权', permissionCommand);
        store.updateLane(lane.id, {
          awaitingReview: false,
          lastBlockedResponseVersion: agentState!.blockedVersion,
          lastBlockedResponseId: agentState!.blockedRequestId || undefined,
        });
        return { ok: true, outcome, autoAuthorized: true, ...(delivery ? { delivery } : {}) };
      };
      supervisorDeliveriesInFlight.add(lane.id);
      try {
        const pendingDelivery = sendPermissionResponseReliably(
          lane.surfaceId,
          permissionResponse,
          () => terminalScreenTail(lane.surfaceId),
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
        });
        const waitingReason = reason || '用户提供的新方向信息仍不足，等待补充';
        store.appendSupervisorLog(lane.id, '新方向信息不足，返回待续', waitingReason);
        announceSupervisorWaitingForDirection(lane, waitingReason);
        return { ok: true, outcome, waiting: true };
      }
      store.updateLane(lane.id, { awaitingReview: true, ...(limitReached ? { autoDecisionLimitReached: true } : {}) });
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
          queueProjectManagerDelivery([
            '[AI 监督请求项目管理决策]',
            `项目：${projectSession.id} · ${projectSession.projectDir}`,
            `任务：${lane.projectWorkItemId || '未绑定'}`,
            `待决 ID：${pending.id}`,
            `事项：${approval.text || 'AI 监督未提供具体建议'}`,
            `原因：${approval.reason}`,
            approval.impact ? `影响：${approval.impact}` : '',
            approval.alternatives ? `备选：${approval.alternatives}` : '',
            '',
            `若属于你的项目内决策权，执行 ${approveCommand}；若要提供自定方向，使用 wmux project decide --project ${projectSession.id} --approval ${pending.id} --decision direct --task-message "<方向>"。项目模式的确认和自定方向都只会交给专属 AI 监督整理和复核，不会直接发送给任务终端。`,
            `只有业务选择、目标或范围扩展、凭据/权限、破坏性或不可逆动作、生产发布或必须人工操作时，才使用 wmux project ask --project ${projectSession.id} 请求用户处理。不要重复发送 needs-human，也不要让监督直接 continue 绕过本待决项。`,
          ].filter(Boolean).join('\n'), projectSession.id);
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
      store.updateLane(lane.id, {
        awaitingReview: false,
        awaitingDirectionAfterWaitingResume: false,
        ...(isQuestionBlockedState(agentState) ? {
          lastBlockedResponseVersion: agentState.blockedVersion,
          lastBlockedResponseId: agentState.blockedRequestId || undefined,
        } : {}),
      });
      return { ok: true, outcome, ...(delivery ? { delivery } : {}) };
    };

    if (next) {
      const beforeScreen = terminalScreenTail(lane.surfaceId);
      supervisorDeliveriesInFlight.add(lane.id);
      try {
        const pendingDelivery = sendTaskToSurfaceReliably(
          lane.surfaceId,
          next,
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
        if (!supervisorSurfaceId || !hasLiveSurface(supervisorSurfaceId)) {
          return { ok: false, error: `${lane.label} 的专属监督终端已缺失；请在 wmux 中重新配置。`, message: '' };
        }
        remoteAudit(session, lane, 'supervisor.remote-command', { action: 'resume-lane', actor });
        useStore.getState().resumeSupervisorLane(lane.id, `由飞书继续 ${lane.label}`);
        if (session.active && !session.pendingApprovals.some((item) => item.laneId === lane.id)) {
          sendToSurface(supervisorSurfaceId, '[通道继续] 用户已通过飞书恢复此监督通道。保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n', true);
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
            && (!supervisorSurfaceId || !hasLiveSurface(supervisorSurfaceId));
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
          sendToSurface(supervisorSurfaceId, '[会话继续] 用户已通过飞书恢复当前监督会话。请保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n', true);
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
