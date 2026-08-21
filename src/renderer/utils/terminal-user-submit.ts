import { supportedAgentLauncherExecutable } from '../supervisor/launch-command';

export const TERMINAL_USER_SUBMIT_EVENT = 'wmux:terminal-user-submit';

const pendingUserInput = new Map<string, string>();
const submittedUserInput = new Map<string, string>();

interface AutomatedSubmitToken {
  surfaceId: string;
  timer?: number;
  clearDraft: () => void;
}

const pendingAutomatedSubmits = new Map<string, AutomatedSubmitToken>();

function stripBracketedPasteMarkers(data: string): string {
  return data
    .split('\x1b[200~').join('')
    .split('\x1b[201~').join('');
}

function hasUserContent(data: string): boolean {
  for (const char of data) {
    const code = char.codePointAt(0) || 0;
    if (code === 10 || (code > 31 && code !== 127)) return true;
  }
  return false;
}

function isControlSequenceOnly(data: string): boolean {
  if (!data.startsWith('\x1b[')) return false;
  return /^[0-9;?]*[A-Za-z~]$/u.test(data.slice(2));
}

/** Shift+Enter and bracketed paste may contain CR without submitting a turn. */
export function isTerminalUserSubmit(data: string): boolean {
  return data === '\r' || data === '\n';
}

/**
 * Track user-originated terminal bytes without inspecting agent-specific UI.
 * Returns true only when a submit key follows actual text. Ctrl+C/Ctrl+U clear
 * the draft; navigation and other control-only sequences do not create one.
 */
export function trackTerminalUserInput(surfaceId: string, data: string): boolean {
  if (!surfaceId) return false;
  if (isTerminalUserSubmit(data)) {
    const pending = pendingUserInput.get(surfaceId);
    const submitted = pending?.trim() || '';
    // Arbitrary terminal input may contain passwords, tokens or permission
    // answers. Only an allowlisted Agent launcher may leave this local tracker.
    const safeSubmitted = supportedAgentLauncherExecutable(submitted) || '';
    pendingUserInput.delete(surfaceId);
    if (safeSubmitted) submittedUserInput.set(surfaceId, safeSubmitted);
    else submittedUserInput.delete(surfaceId);
    return pending !== undefined;
  }
  if (data === '\x03' || data === '\x15') {
    pendingUserInput.delete(surfaceId);
    submittedUserInput.delete(surfaceId);
    return false;
  }
  if (data === '\x7f' || data === '\b') {
    const current = pendingUserInput.get(surfaceId) || '';
    pendingUserInput.set(surfaceId, current.slice(0, -1));
    return false;
  }
  if (isControlSequenceOnly(data)) return false;

  const visible = stripBracketedPasteMarkers(data).split('\x1b\r').join('\n');
  if (hasUserContent(visible)) {
    pendingUserInput.set(surfaceId, `${pendingUserInput.get(surfaceId) || ''}${visible}`.slice(-2_048));
  }
  return false;
}

export function consumeTerminalUserSubmittedText(surfaceId: string): string {
  const submitted = submittedUserInput.get(surfaceId) || '';
  submittedUserInput.delete(surfaceId);
  return submitted;
}

export function beginAutomatedTerminalSubmit(
  surfaceId: string,
  clearDraft: () => void,
): AutomatedSubmitToken {
  cancelPendingAutomatedTerminalSubmit(surfaceId, true);
  const token = { surfaceId, clearDraft };
  pendingAutomatedSubmits.set(surfaceId, token);
  return token;
}

export function attachAutomatedTerminalSubmitTimer(
  token: AutomatedSubmitToken,
  timer: number,
): void {
  token.timer = timer;
}

export function consumeAutomatedTerminalSubmit(token: AutomatedSubmitToken): boolean {
  if (pendingAutomatedSubmits.get(token.surfaceId) !== token) return false;
  pendingAutomatedSubmits.delete(token.surfaceId);
  return true;
}

export function cancelPendingAutomatedTerminalSubmit(
  surfaceId: string,
  clearDraft: boolean,
): boolean {
  const token = pendingAutomatedSubmits.get(surfaceId);
  if (!token) return false;
  pendingAutomatedSubmits.delete(surfaceId);
  if (token.timer !== undefined) globalThis.clearTimeout(token.timer);
  if (clearDraft) token.clearDraft();
  return true;
}

export interface TerminalUserInputPreparation {
  shouldSubmit: boolean;
  clearAutomatedDraft: boolean;
  submittedText?: string;
}

/** Cancel a pending AI Enter before forwarding user-originated terminal bytes. */
export function prepareForUserTerminalInput(
  surfaceId: string,
  data: string,
  clearDraftLocally = true,
): TerminalUserInputPreparation {
  let clearAutomatedDraft = false;
  if (isTerminalUserSubmit(data)) {
    // The user's Enter submits whatever is currently visible; suppress only the
    // later automated Enter so it cannot create a second blank turn.
    cancelPendingAutomatedTerminalSubmit(surfaceId, false);
  } else if (data === '\x03' || data === '\x15') {
    // The user's own clear/cancel byte will remove the draft.
    cancelPendingAutomatedTerminalSubmit(surfaceId, false);
  } else if (
    data === '\x1b\r'
    || data === '\x7f'
    || (!isControlSequenceOnly(data) && hasUserContent(stripBracketedPasteMarkers(data)))
  ) {
    // User content must start from a clean composer, never after AI text.
    const cancelled = cancelPendingAutomatedTerminalSubmit(surfaceId, clearDraftLocally);
    clearAutomatedDraft = cancelled && !clearDraftLocally;
  }
  const shouldSubmit = trackTerminalUserInput(surfaceId, data);
  const submittedText = shouldSubmit ? consumeTerminalUserSubmittedText(surfaceId) : '';
  return {
    shouldSubmit,
    clearAutomatedDraft,
    ...(submittedText ? { submittedText } : {}),
  };
}

export function resetTerminalUserInputTracking(): void {
  pendingUserInput.clear();
  submittedUserInput.clear();
  for (const token of pendingAutomatedSubmits.values()) {
    if (token.timer !== undefined) globalThis.clearTimeout(token.timer);
  }
  pendingAutomatedSubmits.clear();
}

/** Notify supervision before the user's Enter is forwarded to the PTY. */
export function signalTerminalUserSubmit(surfaceId: string, task = ''): void {
  if (!surfaceId) return;
  window.dispatchEvent(new CustomEvent(TERMINAL_USER_SUBMIT_EVENT, {
    detail: { surfaceId, task: task.trim().slice(0, 12_000) },
  }));
}
