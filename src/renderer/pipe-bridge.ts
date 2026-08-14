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
  SUPERVISOR_TUI_READY_DELAY_MS,
} from './supervisor/supervisor-engine';
import {
  handleSupervisorUserSubmit,
  resumeWaitingLaneFromSupervisorInput,
} from './supervisor/user-input-precedence';
import { prepareForUserTerminalInput } from './utils/terminal-user-submit';
import {
  PROJECT_MANAGER_TERMINAL_CWD,
  PROJECT_MANAGER_TERMINAL_NAME,
  PROJECT_MANAGER_TERMINAL_STARTUP_INPUT,
} from '../shared/project-manager-terminal';
import {
  SUPERVISOR_NO_DECISION_OPTION,
  supervisorDecisionOptions,
} from '../shared/supervisor-decision-options';
import { appendSupervisorRecord } from './supervisor/recording';
import {
  clearSupervisorLaneContext,
  dedicatedSupervisorSurfaceId,
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
  SUPERVISOR_TAB_TITLE,
  SUPERVISOR_WORKSPACE_TITLE,
  supervisorTabTitle,
} from './supervisor/protocol';
import { buildSupervisorLaunchCommand } from './supervisor/launch-command';
import { buildInteractiveAgentLaunch, type InteractiveAgent } from './utils/interactive-agent-launch';
import { announceSupervisorWaitingForDirection } from './supervisor/waiting-notification';

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
    || proposalKind === 'context-recovery') && outcome === 'needs-human';
}

/** A supervisor may advance work only from a continuation/rework or a human proposal. */
export function isSupervisorNextAllowed(
  _mode: string,
  outcome: string,
  next: string,
  _autonomous = false,
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
  actor?: string;
}

interface RemoteTerminalTask {
  action: 'send';
  terminal: string;
  task: string;
  actor?: string;
  force?: boolean;
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
  preset?: 'project-manager';
  cwd: string;
  displayPath?: string;
  anchorWorkspace?: string;
  anchorTerminal?: string;
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
  const configuredGoal = effectiveSupervisorTaskGoal(session, lane);
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
    out.push({
      surfaceId: surface.id,
      paneId: tree.paneId,
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      projectDir: workspace.cwd || surface.currentCwd || surface.cwd,
      cwd: surface.currentCwd || surface.cwd || workspace.cwd,
      label,
      remoteSshControl: !!workspace.sshProfileId,
      surface,
    });
  }
}

function remoteTerminalList(): RemoteTaskTerminalLocation[] {
  const store = useStore.getState();
  const terminals: ReturnType<typeof remoteTerminalList> = [];
  for (const workspace of store.workspaces) {
    const dedicatedSupervisorWorkspace = workspace.transientSupervisorWorkspace === true
      || workspace.title.replace(/\s+/gu, '') === SUPERVISOR_WORKSPACE_TITLE.replace(/\s+/gu, '');
    if (dedicatedSupervisorWorkspace) continue;
    collectRemoteTerminals(workspace.splitTree, workspace, terminals);
  }
  const supervisorIds = new Set(store.supervisor.lanes.map(dedicatedSupervisorSurfaceId).filter(Boolean));
  return terminals.filter((terminal) => !supervisorIds.has(terminal.surfaceId));
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

function locateRemoteTaskSession(params: Pick<RemoteDirectTerminalTask, 'anchorWorkspace' | 'anchorTerminal'>): { terminal?: RemoteTaskTerminalLocation; error?: string } {
  if (params.anchorWorkspace) {
    const terminal = remoteTerminalList().find((item) => item.workspaceId === params.anchorWorkspace);
    return terminal
      ? { terminal }
      : { error: '目标会话不存在、已关闭或当前没有可用任务终端。' };
  }
  return locateRemoteTaskTerminal(String(params.anchorTerminal || ''));
}

function focusRemoteTerminal(terminal: RemoteTaskTerminalLocation): void {
  const store = useStore.getState();
  store.selectWorkspace(terminal.workspaceId);
  const workspace = useStore.getState().workspaces.find((item) => item.id === terminal.workspaceId);
  const leaf = workspace && findLeaf(workspace.splitTree, terminal.paneId);
  const index = leaf?.surfaces.findIndex((surface) => surface.id === terminal.surfaceId) ?? -1;
  if (index >= 0) store.selectSurface(terminal.workspaceId, terminal.paneId, index);
}

function createRemoteDirectTerminalTask(params: RemoteDirectTerminalTask): { ok: boolean; message: string; error?: string } {
  const name = String(params.name || '').trim();
  const task = String(params.task || '').trim();
  const cwd = String(params.cwd || '').trim();
  const agent = String(params.agent || 'codex').toLowerCase();
  const projectManager = params.preset === 'project-manager';
  if (!name || !task) return { ok: false, error: '任务名称和首条任务都不能为空。', message: '' };
  if (!['codex', 'kimi', 'grok'].includes(agent)) return { ok: false, error: 'AI 终端类型仅允许 Codex、Kimi 或 Grok。', message: '' };
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd)) return { ok: false, error: '任务目录必须是 Windows 绝对路径。', message: '' };

  if (projectManager) {
    if (name !== PROJECT_MANAGER_TERMINAL_NAME || task !== PROJECT_MANAGER_TERMINAL_STARTUP_INPUT || agent !== 'grok' || cwd !== PROJECT_MANAGER_TERMINAL_CWD) {
      return { ok: false, error: '项目管理终端启动配置无效。', message: '' };
    }
    const existing = remoteTerminalList().find((terminal) => (
      terminal.label === PROJECT_MANAGER_TERMINAL_NAME
      && terminal.surface.cwd?.toLowerCase() === PROJECT_MANAGER_TERMINAL_CWD.toLowerCase()
    ));
    if (existing) {
      focusRemoteTerminal(existing);
      return { ok: true, message: '项目管理终端已存在，已切换到该终端。' };
    }

    const anchor = locateRemoteTaskSession(params);
    if (!anchor.terminal) return { ok: false, error: `无法定位项目管理终端锚点：${anchor.error}`, message: '' };
    const launch = buildInteractiveAgentLaunch('grok', task);
    const surfaceId = useStore.getState().addSurface(anchor.terminal.workspaceId, anchor.terminal.paneId, 'terminal', {
      customTitle: PROJECT_MANAGER_TERMINAL_NAME,
      shell: 'pwsh.exe',
      cwd,
      ...launch,
    });
    if (!surfaceId) return { ok: false, error: '无法在锚点窗格创建项目管理终端。', message: '' };
    const created = locateRemoteTaskTerminal(surfaceId);
    if (created.terminal) focusRemoteTerminal(created.terminal);
    return {
      ok: true,
      message: `已在会话“${anchor.terminal.workspaceTitle}”创建项目管理终端，并自动选中。`,
    };
  }

  const agentLabel = agent === 'kimi' ? 'Kimi' : agent === 'grok' ? 'Grok' : 'Codex';
  const launch = buildInteractiveAgentLaunch(agent as InteractiveAgent, task);
  const surfaceOptions = {
    customTitle: `${agentLabel}直连 · ${name}`,
    shell: 'pwsh.exe',
    cwd,
    ...launch,
  };

  if (params.anchorWorkspace || params.anchorTerminal) {
    const anchor = locateRemoteTaskSession(params);
    if (!anchor.terminal) return { ok: false, error: `无法定位目标会话：${anchor.error}`, message: '' };
    const surfaceId = useStore.getState().addSurface(
      anchor.terminal.workspaceId,
      anchor.terminal.paneId,
      'terminal',
      surfaceOptions,
    );
    if (!surfaceId) return { ok: false, error: '无法在所选会话创建任务终端。', message: '' };
    const created = locateRemoteTaskTerminal(surfaceId);
    if (created.terminal) focusRemoteTerminal(created.terminal);
    return {
      ok: true,
      message: `已在会话“${anchor.terminal.workspaceTitle}”添加 ${agentLabel} 直连终端“${name}”；首条任务将在终端就绪后自动发送。目录：${params.displayPath || cwd}`,
    };
  }

  const tree = createLeaf(undefined, 'terminal', cwd);
  const surface = tree.surfaces[0];
  tree.surfaces[0] = {
    ...surface,
    ...surfaceOptions,
  };
  useStore.getState().createWorkspace({ title: name, cwd, splitTree: tree });
  return {
    ok: true,
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

function startRemoteSupervisor(params: RemoteSupervisorStart): { ok: boolean; message: string; error?: string } {
  const store = useStore.getState();
  const retainedSession = store.supervisor.active || store.supervisor.paused;
  const previousLanes = store.supervisor.lanes;
  const boundSurfaceIds = new Set(retainedSession
    ? previousLanes.filter(isSupervisorLaneBound).map((lane) => lane.surfaceId)
    : []);
  const selectedIds = new Set(params.terminals);
  const candidates = remoteTerminalList().filter((terminal) => (
    selectedIds.has(terminal.surfaceId) && !boundSurfaceIds.has(terminal.surfaceId)
  ));
  if (candidates.length !== selectedIds.size) return { ok: false, error: '包含不存在或不可监督的终端 ID；先执行 LIST 获取最新终端。', message: '' };
  if (!params.stopWhen.trim()) return { ok: false, error: '停止条件不能为空。', message: '' };
  if (candidates.some((candidate) => !candidate.projectDir)) return { ok: false, error: '所选终端缺少项目目录，无法写入审计记录。', message: '' };

  let supervisorWorkspace = store.workspaces.find((workspace) => workspace.id === store.supervisor.supervisorWorkspaceId);
  if (!supervisorWorkspace) {
    const workspaceId = store.createWorkspace({
      title: SUPERVISOR_WORKSPACE_TITLE,
      pinned: true,
      transientSupervisorWorkspace: true,
      splitTree: createLeaf(undefined, 'supervisor'),
    });
    store.patchSupervisor({ supervisorWorkspaceId: workspaceId });
    supervisorWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === workspaceId);
  }
  const targetPaneId = supervisorWorkspace ? getAllPaneIds(supervisorWorkspace.splitTree)[0] : undefined;
  if (!supervisorWorkspace || !targetPaneId) return { ok: false, error: '无法创建专属监督工作区。', message: '' };

  const launchCmd = params.supervisorLaunchCmd || store.supervisor.supervisorLaunchCmd || 'pi';
  const supervisorModel = params.supervisorModel || (retainedSession ? store.supervisor.supervisorModel : '');
  const supervisorReasoningEffort = params.supervisorReasoningEffort || (retainedSession ? store.supervisor.supervisorReasoningEffort : '');
  const launch = buildSupervisorLaunchCommand(launchCmd, supervisorModel, supervisorReasoningEffort);
  const lanes: SupervisorLane[] = candidates.map((candidate) => {
    const supervisorSurfaceId = store.addSurface(supervisorWorkspace!.id, targetPaneId!, 'terminal', {
      customTitle: supervisorTabTitle(candidate.label),
      shell: 'pwsh.exe',
      cwd: candidate.projectDir,
      startupCommands: launch ? [launch] : undefined,
      transientSupervisor: true,
    });
    const lane = clearSupervisorLaneContext({
      id: `lane-${uuid()}`,
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
      },
      autonomousOverride: retainedSession ? params.autonomous : undefined,
      enabled: true,
      steps: [], maxAutoSteps: 0, autoStepsUsed: 0, awaitingStopCheck: false, stopConfirmed: false,
      awaitingReview: false, autoDecisionLimitReached: false, autoDecisionsUsed: 0, pendingSupervisorDeliveries: [], currentTask: '', decisions: [],
    }, supervisorSurfaceId);
    return retainedSession ? { ...lane, awaitingReview: true } : lane;
  });
  if (lanes.some((lane) => !lane.supervisorSurfaceId)) {
    for (const lane of lanes) {
      if (lane.supervisorSurfaceId) store.closeSurface(supervisorWorkspace.id, targetPaneId, lane.supervisorSurfaceId);
    }
    return { ok: false, error: '无法为所有终端创建专属监督 AI。', message: '' };
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
    store.setSupervisorLanes([...retainedLanes, ...lanes]);
    const session = useStore.getState().supervisor;
    for (const lane of lanes) {
      remoteAudit(session, lane, 'supervisor.remote-command', {
        action: 'add', terminals: [lane.surfaceId], autonomous: params.autonomous, actor: params.actor || 'unknown',
      });
    }
    const addedLaneIds = new Set(lanes.map((lane) => lane.id));
    window.setTimeout(() => {
      const current = useStore.getState().supervisor;
      const states = (window as any).__wmux_getAgentStates?.() || {};
      for (const lane of current.lanes) {
        if (!addedLaneIds.has(lane.id) || !lane.supervisorSurfaceId) continue;
        sendToSurface(lane.supervisorSurfaceId, buildSupervisorBriefing(current, { lane, state: String(states[lane.surfaceId]?.state || 'unknown') }), true);
      }
    }, SUPERVISOR_TUI_READY_DELAY_MS);
    return { ok: true, message: `已添加 AI 监督终端：${lanes.map((lane) => `${lane.label} (${lane.surfaceId})`).join('、')}` };
  }
  store.patchSupervisor({
    mode: 'unified', taskGoal: params.taskGoal || '', taskDescription: params.taskDescription || '', preconditions: params.preconditions || '',
    stopWhen: params.stopWhen, stopWhenKind: params.stopWhenKind, planFilePath: params.planFile || '', planFileContent: '',
    supervisorLaunchCmd: launchCmd, supervisorModel, supervisorReasoningEffort, maxAutoSteps: 0,
    maxAutoDecisions: params.autonomous ? null : store.supervisor.maxAutoDecisions, autonomous: params.autonomous,
    autonomyPermissions: [...DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS],
    workScope: DEFAULT_SUPERVISOR_WORK_SCOPE,
    forbiddenActions: [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS],
  });
  store.setSupervisorLanes(lanes);
  store.startSupervisor();
  const session = useStore.getState().supervisor;
  for (const lane of session.lanes) remoteAudit(session, lane, 'supervisor.remote-command', { action: previousLanes.length > 0 ? 'restart' : 'start', terminals: params.terminals, autonomous: params.autonomous, actor: params.actor || 'unknown' });
  window.setTimeout(() => {
    const current = useStore.getState().supervisor;
    const states = (window as any).__wmux_getAgentStates?.() || {};
    for (const lane of current.lanes) {
      if (!lane.supervisorSurfaceId) continue;
      sendToSurface(lane.supervisorSurfaceId, buildSupervisorBriefing(current, { lane, state: String(states[lane.surfaceId]?.state || 'unknown') }), true);
    }
  // Codex and similar TUIs need to finish their initial render before a large
  // briefing is pasted; otherwise the following Enter can be swallowed by the
  // paste handler and leave the supervisor waiting at an unsubmitted prompt.
  }, SUPERVISOR_TUI_READY_DELAY_MS);
  return { ok: true, message: `已启动 AI 监督：${lanes.map((lane) => `${lane.label} (${lane.surfaceId})`).join('、')}` };
}

function sendRemoteTerminalTask(params: RemoteTerminalTask): RemoteTerminalTaskResult {
  const store = useStore.getState();
  const located = locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可发送任务。', message: '' };
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

function closeRemoteTerminal(params: { terminal: string; actor?: string }): { ok: boolean; message: string; error?: string } {
  const located = locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可关闭。', message: '' };

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
      store.setSupervisorLanes(store.supervisor.lanes.filter((item) => item.id !== lane.id));
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
): { ok: boolean; message: string; error?: string } {
  const store = useStore.getState();
  const session = store.supervisor;
  const approval = session.pendingApprovals.find((item) => item.id === approvalId);
  if (!approval) return { ok: false, error: '该待决项不存在、已过期或已处理。', message: '' };
  if (Date.now() - approval.createdAt > 24 * 60 * 60 * 1000) {
    store.rejectPending(approvalId);
    return { ok: false, error: '该待决项已超过 24 小时，已作废。', message: '' };
  }
  if (decision === 'pause') {
    if (!session.active) return { ok: false, error: '当前监督会话已停止，不能暂停旧待决项。', message: '' };
    const lane = session.lanes.find((item) => item.id === approval.laneId);
    if (!lane) return { ok: false, error: '待决项对应的监督通道不存在。', message: '' };
    if (supervisorLaneControlState(lane) === 'paused') return { ok: true, message: `${lane.label} 已经暂停，待决项仍保留。` };
    store.pauseSupervisorLane(lane.id, `飞书人工暂停待决项：${approval.laneLabel}；该通道决策内容已保留`);
    remoteAudit(session, lane, 'supervisor.remote-decision', { approvalId, decision, actor: actor || 'unknown' });
    return { ok: true, message: `已暂停 ${lane.label} 的 AI 监督；其他监督通道继续运行。` };
  }
  const lane = session.lanes.find((item) => item.id === approval.laneId);
  if (decision === 'stop') {
    if (!session.active && !session.paused) return { ok: false, error: '当前监督会话已停止，不能处理旧待决项。', message: '' };
    store.rejectPending(approvalId);
    remoteAudit(session, lane, 'supervisor.remote-decision', { approvalId, decision, actor: actor || 'unknown' });
    if (lane) {
      closeStoppedSupervisorSurfaces([lane]);
      store.stopSupervisorLane(lane.id, `飞书人工停止 ${lane.label} 并解除终端绑定`);
    }
    return { ok: true, message: lane
      ? `已停止 ${lane.label} 的 AI 监督并解除终端绑定；可重新选择该终端启动监督，其他通道不受影响。`
      : '待决项对应通道不存在，已移除该待决项。' };
  }
  if (session.paused) return { ok: false, error: '当前监督会话已暂停；请先在 wmux 中继续会话。', message: '' };
  if (!session.active) return { ok: false, error: '当前监督会话已停止，不能处理旧待决项。', message: '' };
  if (!lane) return { ok: false, error: '待决项对应的监督通道不存在。', message: '' };
  const decisionInput = task?.trim().slice(0, 4000) || '';
  if (decision === 'direct') {
    const directTask = decisionInput;
    if (!directTask) return { ok: false, error: '请填写要直接发送到任务终端的决策信息。', message: '' };
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
  if (decision === 'approve' && approval.source === 'supervisor-context-recovery') {
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
  if (offeredOptions.size >= 2 && !selectedOption && !selectedNone) {
    return { ok: false, error: 'AI 监督提供了多个方案，请先选择其中一个方案。', message: '' };
  }
  if (selectedNone && !decisionInput) {
    return { ok: false, error: '选择“无”时，请填写用户决策或补充信息。', message: '' };
  }
  if (selectedOption && !offeredOptions.has(selectedOption)) {
    return { ok: false, error: '所选方案不属于 AI 监督当前提供的备选项，请刷新决策卡后重试。', message: '' };
  }
  if (decision === 'approve') {
    const chosenPlan = selectedNone ? '' : selectedOption || approval.text.trim();
    const briefing = [
      decisionInput
        ? chosenPlan
          ? '[人工决定] 用户已采用 AI 监督提出的方案，并提供了补充决策信息。'
          : '[人工决定] 用户提供了人工决策信息，请由 AI 监督整理处理。'
        : '[人工决定] 用户已选择采用 AI 监督提出的方案。',
      chosenPlan ? `[用户选择] ${chosenPlan}` : '',
      decisionInput ? `[用户补充信息] ${decisionInput}` : '',
      approval.text.trim() ? `[AI 原建议] ${approval.text.trim()}` : '',
      approval.reason?.trim() ? `[原判断依据] ${approval.reason.trim()}` : '',
      approval.impact?.trim() ? `[影响] ${approval.impact.trim()}` : '',
      approval.alternatives?.trim() ? `[AI 备选方案] ${approval.alternatives.trim()}` : '',
      '',
      '请先 read-screen 获取任务终端最新状态，再基于用户选择、当前任务、计划约束和终端证据，整理成完整、明确、可执行的下一步。',
      `整理完成后，使用 wmux supervisor decide --surface ${approval.surfaceId} --outcome continue 或 rework 提交最终指令到任务终端；短文本使用 --next，长文本或多行文本写入当前项目 .wmux/tmp/<唯一文件名>.txt 后使用 --next-file，禁止在项目根目录创建监督草稿。不要把本消息原样转发，也不要使用通用 wmux send/send-key。`,
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
    try {
      sendToSurface(laneSupervisorSurfaceId, briefing, true);
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err), message: '' };
    }
  }
  store.approvePending(approvalId);
  if (lane && (approval.source === 'supervisor-route' || approval.source === 'supervisor-important')) {
    store.updateLane(lane.id, {
      awaitingReview: true,
      autoDecisionLimitReached: false,
      autoDecisionsUsed: 0,
    });
    remoteAudit(session, lane, 'supervisor.proposal.resolved', {
      approvalId,
      resolution: 'approved',
      proposalKind: approval.proposalKind || 'important',
      text: selectedNone
        ? '用户未采用 AI 方案，已提供补充决策信息'
        : selectedOption || approval.text || (decisionInput ? '用户提供补充决策信息' : '采用 AI 监督当前建议'),
    });
  }
  remoteAudit(session, lane, 'supervisor.remote-decision', {
    approvalId,
    decision,
    actor: actor || 'unknown',
    selection: selectedOption || undefined,
    inputLength: decision === 'approve' ? decisionInput.length || undefined : undefined,
  });
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

export function initPipeBridge(): void {
  const w = window as any;

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
      return { ok: false, error: '当前通道仍有待用户决策项；补充意见只用于更新上下文，不能绕过用户自动继续' };
    }
    const autonomous = effectiveSupervisorAutonomous(session, lane);
    const remoteSshControl = isRemoteSshControlledLane(lane, store.workspaces);
    if (lane.autoDecisionLimitReached && !autonomous) {
      return { ok: false, error: '已达到自动判断上限，等待人工审阅后继续' };
    }
    // A supervisor must not smuggle a declared route/important proposal through
    // an auto-continue decision. Such proposals always stop for user consent.
    if (!isSupervisorProposalAllowed(outcome, proposalKind)) {
      return { ok: false, error: '小范围路线调整须使用 route-adjustment 配合 continue/rework；重大路线变更或重要建议必须使用 needs-human' };
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
    if (!isSupervisorNextAllowed(session.mode, outcome, next, autonomous)) {
      return { ok: false, error: '只有 continue、rework 或 needs-human 可以携带 --next' };
    }
    if (
      session.mode === 'unified'
      && (outcome === 'continue' || outcome === 'rework')
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
    const scopeBlockReason = workScopeBlockReason(
      next,
      session.workScope || DEFAULT_SUPERVISOR_WORK_SCOPE,
      lane.scopeRoot || lane.projectDir,
    );
    const laneConfig = effectiveSupervisorLaneConfig(session, lane);
    if (outcome !== 'needs-human' && scopeBlockReason) {
      return { ok: false, error: `${scopeBlockReason}；超出工作范围的动作必须使用 needs-human` };
    }
    if (
      next
      && outcome !== 'needs-human'
      && session.workScope === 'plan-defined'
      && !laneConfig.planFilePath.trim()
    ) {
      return { ok: false, error: '工作范围设为“仅计划文件定义范围”，但当前没有计划文件；请补充计划文件或使用 needs-human' };
    }
    const hasTaskContext = !!(
      effectiveSupervisorTaskGoal(session, lane)
      || lane.currentTask?.trim()
      || laneConfig.planFilePath.trim()
      || (session.mode !== 'unified' && session.directInstructions?.trim())
      || (session.mode !== 'unified' && session.goal?.trim())
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
        session.workScope || DEFAULT_SUPERVISOR_WORK_SCOPE,
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
    if (!lane.awaitingReview) {
      return { ok: false, error: '当前没有待裁决轮次；请等待工作终端任务结束或权限阻塞通知' };
    }
    const agentState = ((w.__wmux_getAgentStates?.() || {})[surfaceId] || undefined) as SupervisorAgentStateView | undefined;
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
        session.workScope || DEFAULT_SUPERVISOR_WORK_SCOPE,
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
    // the first pending human decision stable so Feishu has one card to act on.
    if (outcome === 'needs-human' && session.pendingApprovals.some((approval) => approval.laneId === lane.id)) {
      store.appendSupervisorLog(lane.id, '重复人工决策已忽略', reason || '该终端已有待决项');
      return { ok: true, outcome, duplicate: true };
    }

    if ((next || permissionResponse) && supervisorDeliveriesInFlight.has(lane.id)) {
      return { ok: false, error: '当前通道已有裁决正在投递；请等待本次投递确认后再裁决' };
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
      const text = `已达到 ${normalizedMaxAutoDecisions(session.maxAutoDecisions)} 次自动判断上限；请人工审阅 ${lane.label} 后再继续。`;
      const workspaceId = lane.workspaceId || store.activeWorkspaceId;
      if (workspaceId) store.addNotification({ surfaceId: lane.surfaceId, workspaceId, text });
      window.wmux?.notification?.fire({ surfaceId: lane.surfaceId, title: 'AI 监督', text });
      return { ok: true, outcome, requiresHuman: true };
    }

    if (outcome === 'complete') {
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
      const pending = useStore.getState().supervisor.pendingApprovals[0];
      if (pending) {
        appendSupervisorRecord(useStore.getState().supervisor, lane, 'supervisor.approval.requested', {
          approvalId: pending.id,
          taskGoal: publicDecisionTaskGoal(useStore.getState().supervisor, lane),
          reason: approval.reason,
          impact: approval.impact,
          alternatives: approval.alternatives,
          proposalKind: approval.proposalKind,
        });
      }
      const proposalLabel = kind === 'route-change'
        ? '路线变更'
        : kind === 'context-recovery'
          ? '上下文恢复指令'
          : '重要建议';
      const text = `${proposalLabel}待你决定：${reason || lane.label}`;
      const workspaceId = lane.workspaceId || store.activeWorkspaceId;
      if (workspaceId) {
        store.addNotification({ surfaceId: lane.surfaceId, workspaceId, text });
      }
      window.wmux?.notification?.fire({ surfaceId: lane.surfaceId, title: 'AI 监督', text });
      return { ok: true, outcome };
    }

    const finishDecision = (delivery?: SupervisorDeliveryObservation) => {
      store.updateLane(lane.id, {
        awaitingReview: false,
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
      return {
        ok: true,
        message: JSON.stringify({
          active: state.active,
          paused: state.paused,
          terminals: remoteTerminalList().map((terminal) => ({
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
          session: state.active || state.paused
            ? { sessionId: state.sessionId, stopWhen: state.stopWhen, autonomous: state.autonomous }
            : null,
          pendingApprovals: state.pendingApprovals.map((approval) => ({ id: approval.id, terminal: approval.laneLabel, reason: approval.reason || '' })),
        }),
      };
    }
    if (action === 'logs') {
      const state = useStore.getState().supervisor;
      const laneLabels = new Map(state.lanes.map((lane) => [lane.id, lane.label]));
      return {
        ok: true,
        message: JSON.stringify({
          active: state.active,
          paused: state.paused,
          sessionId: state.sessionId,
          entries: state.log.slice(0, 20).map((entry) => ({
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
    if (action === 'close-terminal') return closeRemoteTerminal(params);
    if (action === 'send-supervisor-message') return sendRemoteSupervisorMessage(params as RemoteSupervisorMessage);
    if (action === 'waiting-decision') return decideRemoteWaiting(params as RemoteWaitingDecision);
    if (action === 'pause-lane' || action === 'resume-lane' || action === 'stop-lane') {
      const session = useStore.getState().supervisor;
      const actor = String(params?.actor || 'unknown');
      const terminal = String(params?.terminal || '');
      const lane = session.lanes.find((item) => item.surfaceId === terminal || item.managementSessionId === terminal);
      if (!lane) return { ok: false, error: '没有找到对应的 AI 监督通道。', message: '' };
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
      if (action === 'pause-all' && session.paused) {
        return { ok: true, message: '当前 AI 监督已经全部暂停。' };
      }
      if (action === 'resume-all' && session.active) {
        return { ok: true, message: '当前 AI 监督已经在运行。' };
      }
      const shouldPause = action === 'pause-all' || (action === 'toggle-pause' && session.active);
      if (shouldPause && session.active) {
        useStore.getState().pauseSupervisor('由飞书远程暂停；现有监督终端与会话上下文已保留');
        for (const lane of session.lanes) remoteAudit(session, lane, 'supervisor.remote-command', { action: 'pause', actor });
        return { ok: true, message: '已暂停当前 AI 监督；会话、监督终端和待决项均已保留。' };
      }
      const shouldResume = action === 'resume-all' || (action === 'toggle-pause' && session.paused);
      if (shouldResume && session.paused) {
        const missingLane = session.lanes.find((lane) => {
          const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
          return supervisorLaneControlState(lane) !== 'stopped'
            && (!supervisorSurfaceId || !hasLiveSurface(supervisorSurfaceId));
        });
        if (missingLane) return { ok: false, error: `专属监督终端已缺失：${missingLane.label}。请在 wmux 中停止后重新配置。`, message: '' };
        useStore.getState().resumeSupervisor();
        const resumed = useStore.getState().supervisor;
        const pendingLaneIds = new Set(resumed.pendingApprovals.map((item) => item.laneId));
        for (const lane of resumed.lanes) {
          remoteAudit(resumed, lane, 'supervisor.remote-command', { action: 'resume', actor });
          const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
          if (supervisorLaneControlState(lane) !== 'active'
            || !supervisorSurfaceId
            || pendingLaneIds.has(lane.id)) continue;
          sendToSurface(supervisorSurfaceId, '[会话继续] 用户已通过飞书恢复当前监督会话。请保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n', true);
        }
        return { ok: true, message: '已继续原 AI 监督会话。' };
      }
      return { ok: false, error: '当前没有运行中或暂停保留的 AI 监督。', message: '' };
    }
    if (action === 'stop') {
      const session = useStore.getState().supervisor;
      if (!session.active && !session.paused) return { ok: false, error: '当前没有运行中或暂停保留的 AI 监督。', message: '' };
      useStore.getState().stopSupervisor('由飞书远程停止');
      for (const lane of session.lanes) remoteAudit(session, lane, 'supervisor.remote-command', { action: 'stop', actor: String(params?.actor || 'unknown') });
      return { ok: true, message: '已停止当前 AI 监督。' };
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
