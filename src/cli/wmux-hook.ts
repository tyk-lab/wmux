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
import net from 'net';
import { randomUUID } from 'node:crypto';
import { resolveWmuxHookRuntimeContext } from './wmux-hook-context';
import { parseWmuxHookPayload, stableWmuxHookId } from './wmux-hook-payload';

const runtimeContext = resolveWmuxHookRuntimeContext(process.env);
if (runtimeContext.state === 'inactive') process.exit(0);
if (runtimeContext.state === 'invalid') {
  console.error(`[wmux-hook] wmux integration is missing: ${runtimeContext.missing.join(', ')}`);
  process.exit(1);
}

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

let stdinData = '';
let sent = false;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
const MAX_STDIN = 64 * 1024; // 64KB cap
const MAX_PIPE_ATTEMPTS = 3;

function sendHook(): void {
  if (sent) return;
  sent = true;
  if (fallbackTimer) clearTimeout(fallbackTimer);

  const payload = parseWmuxHookPayload(stdinData);

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
    client.setTimeout(1000);
    const retry = () => {
      if (completed || retryScheduled) return;
      if (attempt >= MAX_PIPE_ATTEMPTS) {
        process.exitCode = 1;
        return;
      }
      retryScheduled = true;
      setTimeout(write, attempt * 200);
    };
    client.on('data', (chunk) => {
      response += chunk.toString();
      if (!response.includes('\n')) return;
      completed = true;
      client.end();
      try {
        const reply = JSON.parse(response.trim());
        if (reply.error) process.exitCode = 1;
      } catch {
        process.exitCode = 1;
      }
    });
    client.once('end', retry);
    client.once('error', retry);
    client.once('timeout', () => {
      client.destroy();
      retry();
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
