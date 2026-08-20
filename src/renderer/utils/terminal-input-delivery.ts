export const INTERACTIVE_TUI_READY_DELAY_MS = 2_500;
export const STARTUP_INPUT_RETRY_DELAY_MS = 500;
export const STARTUP_INPUT_MAX_ATTEMPTS = 20;
export const STARTUP_INPUT_READY_TIMEOUT_MS = 30_000;
export const STARTUP_INPUT_READY_POLL_MS = 100;

export function pasteSubmitDelayMs(text: string): number {
  return Math.min(3_000, Math.max(300, 300 + Math.ceil(text.length * 0.75)));
}

/** Make one automated prompt one terminal draft and one explicit submit. */
export function prepareAutomatedTerminalInput(text: string): string {
  return text.replace(/[\r\n]+$/u, '').replace(/\r\n|\n|\r/gu, ' ');
}

export interface TerminalInputWriter {
  write: (surfaceId: string, data: string) => void;
  writeChecked?: (surfaceId: string, data: string) => Promise<boolean>;
}

interface StartupInputDeliveryOptions {
  cancelWhen?: () => boolean;
  readyDelayMs?: number;
  readyWhen?: () => boolean;
  readyTimeoutMs?: number;
  readyPollMs?: number;
  retryDelayMs?: number;
  submitSettleMs?: number;
  maxAttempts?: number;
  wait?: (delayMs: number) => Promise<void>;
}

export type StartupTrustPromptAgent = 'codex' | 'kimi' | 'grok' | 'pi';
export type StartupTrustPromptAction = 'confirm-selected' | 'select-previous' | 'type-yes';

const ANSI_ESCAPE = new RegExp(
  String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`,
  'gu',
);

function normalizedTerminalOutput(output: string): string {
  return output.replace(ANSI_ESCAPE, '').replace(/\r/gu, '');
}

interface StartupTrustPromptOptions extends Pick<
  StartupInputDeliveryOptions,
  'readyDelayMs' | 'retryDelayMs' | 'maxAttempts' | 'wait'
> {
  action: StartupTrustPromptAction;
  selectionDelayMs?: number;
}

export function isStartupTrustPromptReady(agent: StartupTrustPromptAgent, output: string): boolean {
  const normalizedOutput = normalizedTerminalOutput(output);
  if (agent === 'codex') {
    return /Do you trust the contents of this directory\?[\s\S]{0,2000}Yes, continue/i.test(normalizedOutput)
      || /Yes, continue[\s\S]{0,1000}No, quit/i.test(normalizedOutput);
  }
  if (agent === 'kimi') {
    return /Trust this folder\?[\s\S]{0,2000}Trust this folder/i.test(normalizedOutput);
  }
  if (agent === 'grok') {
    return /This folder contains repo-local config[\s\S]{0,2000}Trust the authors of this folder and allow these servers to start\?\s*\[y\/N\]/i.test(normalizedOutput);
  }
  // Pi isolated supervisors receive --approve, so no interactive fallback is
  // accepted until a stable Pi trust prompt can be identified precisely.
  return false;
}

export function startupTrustPromptAction(
  agent: StartupTrustPromptAgent,
  output: string,
): StartupTrustPromptAction | null {
  if (agent === 'grok') {
    return isStartupTrustPromptReady(agent, output) ? 'type-yes' : null;
  }
  if (agent === 'pi') return null;

  const normalizedOutput = normalizedTerminalOutput(output);
  const selectedMarker = '(?:[>❯›➜→]|[●◉])';
  const selectedTrust = agent === 'codex'
    ? new RegExp(`(?:^|\\n)\\s*${selectedMarker}\\s*(?:1\\.\\s*)?Yes, continue\\b`, 'giu')
    : new RegExp(`(?:^|\\n)\\s*${selectedMarker}\\s*Trust this folder\\b`, 'giu');
  const selectedReject = agent === 'codex'
    ? new RegExp(`(?:^|\\n)\\s*${selectedMarker}\\s*(?:2\\.\\s*)?No, quit\\b`, 'giu')
    : new RegExp(`(?:^|\\n)\\s*${selectedMarker}\\s*Don't trust\\b`, 'giu');
  const trustMatches = [...normalizedOutput.matchAll(selectedTrust)];
  const rejectMatches = [...normalizedOutput.matchAll(selectedReject)];
  const lastTrustIndex = trustMatches[trustMatches.length - 1]?.index ?? -1;
  const lastRejectIndex = rejectMatches[rejectMatches.length - 1]?.index ?? -1;
  if (lastRejectIndex > lastTrustIndex) return 'select-previous';
  if (lastTrustIndex >= 0) return 'confirm-selected';
  return null;
}

export function isKimiInteractiveInputReady(output: string): boolean {
  const normalizedOutput = normalizedTerminalOutput(output);
  return !/Failed to start a session/i.test(normalizedOutput)
    && /No session yet[\s\S]{0,2000}first message/i.test(normalizedOutput);
}

export async function confirmStartupTrustPrompt(
  writer: TerminalInputWriter,
  surfaceId: string,
  options: StartupTrustPromptOptions,
): Promise<boolean> {
  const wait = options.wait || defaultWait;
  const readyDelayMs = Math.max(0, options.readyDelayMs ?? 200);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? STARTUP_INPUT_RETRY_DELAY_MS);
  const maxAttempts = Math.max(1, options.maxAttempts ?? STARTUP_INPUT_MAX_ATTEMPTS);
  await wait(readyDelayMs);
  if (options.action === 'type-yes') {
    return writeWhenAvailable(writer, surfaceId, 'y\r', wait, retryDelayMs, maxAttempts);
  }
  if (options.action === 'select-previous') {
    const selectedTrust = await writeWhenAvailable(
      writer,
      surfaceId,
      '\x1b[A',
      wait,
      retryDelayMs,
      maxAttempts,
    );
    if (!selectedTrust) return false;
    await wait(Math.max(0, options.selectionDelayMs ?? 100));
  }
  return writeWhenAvailable(writer, surfaceId, '\r', wait, retryDelayMs, maxAttempts);
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

async function writeWhenAvailable(
  writer: TerminalInputWriter,
  surfaceId: string,
  data: string,
  wait: (delayMs: number) => Promise<void>,
  retryDelayMs: number,
  maxAttempts: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if (writer.writeChecked) {
        if (await writer.writeChecked(surfaceId, data)) return true;
      } else {
        writer.write(surfaceId, data);
        return true;
      }
    } catch {
      // The PTY can disappear briefly while a newly created pane is mounting.
    }
    if (attempt + 1 < maxAttempts) await wait(retryDelayMs);
  }
  return false;
}

/**
 * Deliver one startup prompt only after the PTY exists. Failed paste attempts
 * are safe to retry because writeChecked guarantees that no bytes were accepted.
 * Once the paste succeeds, only Enter is retried to avoid duplicating the task.
 */
export async function deliverStartupInput(
  writer: TerminalInputWriter,
  surfaceId: string,
  input: string,
  options: StartupInputDeliveryOptions = {},
): Promise<boolean> {
  const wait = options.wait || defaultWait;
  const readyDelayMs = Math.max(0, options.readyDelayMs ?? INTERACTIVE_TUI_READY_DELAY_MS);
  const readyTimeoutMs = Math.max(0, options.readyTimeoutMs ?? STARTUP_INPUT_READY_TIMEOUT_MS);
  const readyPollMs = Math.max(1, options.readyPollMs ?? STARTUP_INPUT_READY_POLL_MS);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? STARTUP_INPUT_RETRY_DELAY_MS);
  const submitSettleMs = Math.max(0, options.submitSettleMs ?? 0);
  const maxAttempts = Math.max(1, options.maxAttempts ?? STARTUP_INPUT_MAX_ATTEMPTS);
  if (!input) return false;
  if (options.cancelWhen?.()) return false;
  const atomicInput = prepareAutomatedTerminalInput(input);
  if (!atomicInput) return false;

  if (options.readyWhen) {
    const maxReadyAttempts = Math.max(1, Math.ceil(readyTimeoutMs / readyPollMs) + 1);
    let ready = false;
    for (let attempt = 0; attempt < maxReadyAttempts; attempt += 1) {
      if (options.cancelWhen?.()) return false;
      if (options.readyWhen()) {
        ready = true;
        break;
      }
      if (attempt + 1 < maxReadyAttempts) await wait(readyPollMs);
    }
    if (!ready) return false;
  }
  await wait(readyDelayMs);
  if (options.cancelWhen?.()) return false;
  const pasted = await writeWhenAvailable(writer, surfaceId, atomicInput, wait, retryDelayMs, maxAttempts);
  if (!pasted) return false;

  await wait(pasteSubmitDelayMs(atomicInput));
  if (options.cancelWhen?.()) return false;
  const submitted = await writeWhenAvailable(writer, surfaceId, '\r', wait, retryDelayMs, maxAttempts);
  if (!submitted) return false;
  if (submitSettleMs > 0) await wait(submitSettleMs);
  return !options.cancelWhen?.();
}
