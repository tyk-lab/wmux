export const INTERACTIVE_TUI_READY_DELAY_MS = 2_500;
export const STARTUP_INPUT_RETRY_DELAY_MS = 500;
export const STARTUP_INPUT_MAX_ATTEMPTS = 20;

export function pasteSubmitDelayMs(text: string): number {
  return Math.min(3_000, Math.max(300, 300 + Math.ceil(text.length * 0.75)));
}

export interface TerminalInputWriter {
  write: (surfaceId: string, data: string) => void;
  writeChecked?: (surfaceId: string, data: string) => Promise<boolean>;
}

interface StartupInputDeliveryOptions {
  readyDelayMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  wait?: (delayMs: number) => Promise<void>;
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
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? STARTUP_INPUT_RETRY_DELAY_MS);
  const maxAttempts = Math.max(1, options.maxAttempts ?? STARTUP_INPUT_MAX_ATTEMPTS);
  if (!input) return false;

  await wait(readyDelayMs);
  const pasted = await writeWhenAvailable(writer, surfaceId, input, wait, retryDelayMs, maxAttempts);
  if (!pasted) return false;

  await wait(pasteSubmitDelayMs(input));
  return writeWhenAvailable(writer, surfaceId, '\r', wait, retryDelayMs, maxAttempts);
}
