#!/usr/bin/env node
/**
 * wmux hook helper — sends a hook event to the wmux pipe.
 * Called by Claude / Kimi / Codex / Grok / Pi hooks.
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
 * --agent (or WMUX_AGENT env) labels the notification (Kimi / Claude / …).
 */
import net from 'net';

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
const MAX_STDIN = 64 * 1024; // 64KB cap
const MAX_TASK = 800;
const MAX_PIPE_ATTEMPTS = 3;

function compact(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > MAX_TASK ? `${text.slice(0, MAX_TASK - 1)}…` : text;
}

function sendHook(): void {
  if (sent) return;
  sent = true;

  let file = '';
  let message = '';
  let task = '';
  try {
    if (stdinData.trim()) {
      const data = JSON.parse(stdinData);
      file = data.tool_input?.file_path
        || data.tool_input?.path
        || data.input?.file_path
        || '';
      message = data.message || data.tool_input?.description || '';
      task = compact(data.prompt || data.user_prompt || data.input?.prompt);
    }
  } catch {
    // stdin wasn't valid JSON — that's fine.
  }

  const params: Record<string, string> = {};
  if (event) params.event = event;
  if (tool) params.tool = tool;
  if (file) params.file = file;
  if (message) params.message = message;
  if (task) params.task = task;
  const cwd = process.cwd();
  if (cwd) params.cwd = cwd;
  if (surfaceId) params.surfaceId = surfaceId;
  if (agent) params.agent = agent;

  const wireMessage = JSON.stringify({ method: 'hook.event', params, id: 1, token }) + '\n';
  let attempt = 0;
  const write = () => {
    attempt++;
    let accepted = false;
    let retryScheduled = false;
    const client = net.connect({ path: pipePath }, () => {
      client.write(wireMessage, () => {
        accepted = true;
        client.end();
      });
    });
    client.setTimeout(1000);
    const retry = () => {
      if (accepted || retryScheduled || attempt >= MAX_PIPE_ATTEMPTS) return;
      retryScheduled = true;
      setTimeout(write, attempt * 200);
    };
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

setTimeout(sendHook, 1000);

if (process.stdin.readableEnded) sendHook();
