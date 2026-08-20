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
  maxAttempts?: number;
  wait?: (delayMs: number) => Promise<void>;
}

export type StartupTrustPromptAgent = 'codex' | 'kimi';

export function isStartupTrustPromptReady(agent: StartupTrustPromptAgent, output: string): boolean {
  if (agent === 'codex') {
    return /Do you trust the contents of this directory\?[\s\S]{0,2000}Yes, continue/i.test(output)
      || /Yes, continue[\s\S]{0,1000}No, quit/i.test(output);
  }
  return /Trust this folder\?[\s\S]{0,2000}Trust this folder/i.test(output);
}

export function isKimiInteractiveInputReady(output: string): boolean {
  return /No session yet[\s\S]{0,2000}first message/i.test(output);
}

export async function confirmStartupTrustPrompt(
  writer: TerminalInputWriter,
  surfaceId: string,
  options: Pick<StartupInputDeliveryOptions, 'readyDelayMs' | 'retryDelayMs' | 'maxAttempts' | 'wait'> = {},
): Promise<boolean> {
  const wait = options.wait || defaultWait;
  const readyDelayMs = Math.max(0, options.readyDelayMs ?? 200);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? STARTUP_INPUT_RETRY_DELAY_MS);
  const maxAttempts = Math.max(1, options.maxAttempts ?? STARTUP_INPUT_MAX_ATTEMPTS);
  await wait(readyDelayMs);
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
  return writeWhenAvailable(writer, surfaceId, '\r', wait, retryDelayMs, maxAttempts);
}
