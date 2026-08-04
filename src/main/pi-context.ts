/**
 * Pi Agent extension → wmux lifecycle hooks.
 *
 * Pi discovers global extensions from `~/.pi/agent/extensions/*.ts`. We own a
 * dedicated managed file and translate Pi's native events into the existing
 * wmux hook protocol, so the renderer and supervisor stay agent-agnostic.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWmuxHookScriptPath } from './wmux-hook-path';

export const WMUX_PI_EXTENSION_MARKER = '// wmux-pi-extension: managed';
const WMUX_PI_EXTENSION_VERSION = '// wmux-pi-extension-version: 1';

export function resolvePiAgentDir(homeDir = os.homedir(), env = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return configured || path.join(homeDir, '.pi', 'agent');
}

export function resolvePiWmuxExtensionPath(homeDir = os.homedir(), env = process.env): string {
  return path.join(resolvePiAgentDir(homeDir, env), 'extensions', 'wmux-agent-hooks.ts');
}

/** Build a dependency-free Pi extension with a fixed, argv-safe Hook target. */
export function buildPiWmuxExtension(hookScript: string): string {
  const script = JSON.stringify(hookScript.split(path.sep).join('/'));
  return `${WMUX_PI_EXTENSION_MARKER}
${WMUX_PI_EXTENSION_VERSION}
import { spawn } from "node:child_process";

const WMUX_HOOK_SCRIPT = ${script};
let promptReported = false;

function wmuxToolName(toolName) {
  if (toolName === "edit") return "Edit";
  if (toolName === "write") return "Write";
  return toolName;
}

function sendWmuxEvent(event, payload = {}, toolName = "") {
  if (!process.env.WMUX_SURFACE_ID) return;
  try {
    const input = JSON.stringify(payload);
    const args = [WMUX_HOOK_SCRIPT, "--event", event, "--agent", "Pi"];
    if (toolName) args.push("--tool", toolName);
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    child.on("error", () => undefined);
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    child.unref();
  } catch {
    // Hooks must never interrupt the Pi session.
  }
}

export default function wmuxAgentHooks(pi) {
  pi.on("input", (event) => {
    if (event.source === "extension") return;
    promptReported = true;
    sendWmuxEvent("UserPromptSubmit", { prompt: event.text });
  });

  pi.on("before_agent_start", (event) => {
    if (!promptReported) sendWmuxEvent("UserPromptSubmit", { prompt: event.prompt });
    promptReported = false;
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === "ask_question") {
      sendWmuxEvent("Notification", { message: "Pi Agent 正在等待用户回答" });
    }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "ask_question") sendWmuxEvent("PermissionResult");
    sendWmuxEvent("PostToolUse", { tool_input: event.input }, wmuxToolName(event.toolName));
  });

  pi.on("agent_settled", () => {
    promptReported = false;
    sendWmuxEvent("Stop");
  });
  pi.on("session_shutdown", () => sendWmuxEvent("Interrupt"));
}
`;
}

/** Install/update only wmux's dedicated Pi extension; never overwrite another file. */
export function ensurePiHooks(
  extensionPath = resolvePiWmuxExtensionPath(),
  hookScript = resolveWmuxHookScriptPath(),
): void {
  const next = buildPiWmuxExtension(hookScript);
  const existing = fs.existsSync(extensionPath) ? fs.readFileSync(extensionPath, 'utf-8') : '';
  if (existing && !existing.startsWith(WMUX_PI_EXTENSION_MARKER)) {
    throw new Error(`refusing to overwrite unmanaged Pi extension: ${extensionPath}`);
  }
  if (existing === next) return;

  const directory = path.dirname(extensionPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(extensionPath, next, 'utf-8');
  console.log('[wmux] Configured Pi Agent lifecycle extension in', extensionPath);
}
