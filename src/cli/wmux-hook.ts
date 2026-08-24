#!/usr/bin/env node
/**
 * wmux hook helper — sends a hook event to the wmux pipe.
 * Called by Kimi / Codex / Grok / Pi hooks.
 *
 * Usage:
 *   node wmux-hook.js <tool-name> [--agent Name]   # PostToolUse
 *   node wmux-hook.js --event <Event> [--agent Name]
 *   node wmux-hook.js --event PostToolUse --tool <name> [--agent Name]
 *
 * Reads stdin for the harness hook payload (JSON):
 *   - PostToolUse Edit/Write → extracts tool_input.file_path
 *   - Notification           → extracts the `message`
 * WMUX_SURFACE_ID ties the event to its pane.
 * --agent (or WMUX_AGENT env) labels the notification (Kimi / Codex / …).
 */
import fs from 'node:fs';
import net from 'net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  resolveWmuxHookRuntimeContext,
  wmuxHookTransportFailureExitCode,
} from './wmux-hook-context';
import { parseWmuxHookPayload, stableWmuxHookId } from './wmux-hook-payload';

const argv = process.argv.slice(2);

function takeFlag(args: string[], name: string): string {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return '';
  const v = args[i + 1] || '';
  args.splice(i, 2);
  return v;
}

const agentFlag = takeFlag(argv, '--agent');
const eventFlag = takeFlag(argv, '--event');
const toolFlag = takeFlag(argv, '--tool');

let tool = toolFlag;
let event = eventFlag;
if (!event && argv[0] && !argv[0].startsWith('-')) {
  tool = argv[0] || 'unknown';
} else if (!event && !tool) {
  // Legacy: node wmux-hook.js --event Stop  (already consumed by takeFlag)
}

const pipePath = process.env.WMUX_PIPE || '\\\\.\\pipe\\wmux';
const token = process.env.WMUX_PIPE_TOKEN || '';
const surfaceId = process.env.WMUX_SURFACE_ID || '';
const agent = agentFlag || process.env.WMUX_AGENT || '';
const failureEvent = event || (tool ? 'PostToolUse' : 'unknown');

let stdinData = '';
let sent = false;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
const MAX_STDIN = 64 * 1024; // 64KB cap
const MAX_PIPE_ATTEMPTS = 3;
const PIPE_RESPONSE_TIMEOUT_MS = 1000;

type HookTransportFailureKind =
  | 'missing-context'
  | 'socket-error'
  | 'response-timeout'
  | 'invalid-response'
  | 'server-error';

function recordHookTransportFailure(
  kind: HookTransportFailureKind,
  detail: string,
  attempts: number,
): void {
  try {
    const appData = process.env.APPDATA?.trim();
    if (!appData) return;
    const instance = process.env.WMUX_INSTANCE?.trim();
    const logDir = path.join(appData, instance ? `wmux-${instance}` : 'wmux', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const safeDetail = detail.replace(/[\r\n]+/gu, ' ').slice(0, 240);
    fs.writeFileSync(path.join(logDir, 'hook-transport-last.json'), JSON.stringify({
      version: 1,
      ts: Date.now(),
      event: failureEvent,
      agent,
      surfaceId,
      attempts,
      kind,
      detail: safeDetail,
    }, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Diagnostics must never turn a recoverable telemetry loss into a Hook failure.
  }
}

function finishHookTransportFailure(
  kind: HookTransportFailureKind,
  detail: string,
  attempts: number,
): void {
  recordHookTransportFailure(kind, detail, attempts);
  const exitCode = wmuxHookTransportFailureExitCode(failureEvent);
  if (exitCode !== 0) {
    const suffix = detail ? `: ${detail.replace(/[\r\n]+/gu, ' ').slice(0, 240)}` : '';
    console.error(`[wmux-hook] ${failureEvent} delivery failed (${kind}, attempts=${attempts})${suffix}`);
  }
  process.exitCode = exitCode;
}

const runtimeContext = resolveWmuxHookRuntimeContext(process.env);
if (runtimeContext.state === 'inactive') process.exit(0);
if (runtimeContext.state === 'invalid') {
  finishHookTransportFailure('missing-context', runtimeContext.missing.join(', '), 0);
  process.exit();
}

function sendHook(): void {
  if (sent) return;
  sent = true;
  if (fallbackTimer) clearTimeout(fallbackTimer);

  const payload = parseWmuxHookPayload(stdinData, event || failureEvent);

  const params: Record<string, string> = {};
  params.hookId = stableWmuxHookId({
    event,
    agent,
    surfaceId,
    sessionId: payload.sessionId,
    turnId: payload.turnId,
  }) || randomUUID();
  if (event) params.event = event;
  if (tool) params.tool = tool;
  if (payload.file) params.file = payload.file;
  if (payload.message) params.message = payload.message;
  if (payload.task) params.task = payload.task;
  if (payload.command) params.command = payload.command;
  if (payload.sessionId) params.agentSessionId = payload.sessionId;
  if (payload.turnId) params.agentTurnId = payload.turnId;
  const cwd = payload.cwd || process.cwd();
  if (cwd) params.cwd = cwd;
  if (surfaceId) params.surfaceId = surfaceId;
  if (agent) params.agent = agent;

  const wireMessage = JSON.stringify({ method: 'hook.event', params, id: 1, token }) + '\n';
  let attempt = 0;
  const write = () => {
    attempt++;
    let completed = false;
    let retryScheduled = false;
    let response = '';
    const client = net.connect({ path: pipePath }, () => {
      client.write(wireMessage);
    });
    client.setTimeout(PIPE_RESPONSE_TIMEOUT_MS);
    const retry = (kind: HookTransportFailureKind, detail: string) => {
      if (completed || retryScheduled) return;
      if (attempt >= MAX_PIPE_ATTEMPTS) {
        completed = true;
        client.destroy();
        finishHookTransportFailure(kind, detail, attempt);
        return;
      }
      retryScheduled = true;
      client.destroy();
      setTimeout(write, attempt * 200);
    };
    client.on('data', (chunk) => {
      response += chunk.toString();
      if (!response.includes('\n')) return;
      try {
        const reply = JSON.parse(response.trim());
        if (reply.error) {
          completed = true;
          client.end();
          const code = String(reply.error.code ?? 'unknown');
          const message = String(reply.error.message ?? 'wmux rejected the Hook event');
          finishHookTransportFailure('server-error', `${code} ${message}`, attempt);
          return;
        }
        completed = true;
        client.end();
      } catch {
        retry('invalid-response', 'wmux returned non-JSON data');
      }
    });
    client.once('end', () => retry('invalid-response', 'wmux closed before a complete response'));
    client.once('error', (error: NodeJS.ErrnoException) => {
      retry('socket-error', error.code || error.message || 'unknown socket error');
    });
    client.once('timeout', () => {
      retry('response-timeout', `no response within ${PIPE_RESPONSE_TIMEOUT_MS}ms`);
    });
  };
  write();
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { if (stdinData.length < MAX_STDIN) stdinData += chunk; });
process.stdin.on('end', sendHook);
process.stdin.on('error', sendHook);

fallbackTimer = setTimeout(sendHook, 1000);

if (process.stdin.readableEnded) sendHook();
