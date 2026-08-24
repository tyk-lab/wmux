#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const node_fs_1 = __importDefault(require("node:fs"));
const net_1 = __importDefault(require("net"));
const node_crypto_1 = require("node:crypto");
const node_path_1 = __importDefault(require("node:path"));
const wmux_hook_context_1 = require("./wmux-hook-context");
const wmux_hook_payload_1 = require("./wmux-hook-payload");
const argv = process.argv.slice(2);
function takeFlag(args, name) {
    const i = args.indexOf(name);
    if (i === -1 || i + 1 >= args.length)
        return '';
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
}
else if (!event && !tool) {
    // Legacy: node wmux-hook.js --event Stop  (already consumed by takeFlag)
}
const pipePath = process.env.WMUX_PIPE || '\\\\.\\pipe\\wmux';
const token = process.env.WMUX_PIPE_TOKEN || '';
const surfaceId = process.env.WMUX_SURFACE_ID || '';
const agent = agentFlag || process.env.WMUX_AGENT || '';
const failureEvent = event || (tool ? 'PostToolUse' : 'unknown');
let stdinData = '';
let sent = false;
let fallbackTimer;
const MAX_STDIN = 64 * 1024; // 64KB cap
const MAX_PIPE_ATTEMPTS = 3;
const PIPE_RESPONSE_TIMEOUT_MS = 1000;
function recordHookTransportFailure(kind, detail, attempts) {
    try {
        const appData = process.env.APPDATA?.trim();
        if (!appData)
            return;
        const instance = process.env.WMUX_INSTANCE?.trim();
        const logDir = node_path_1.default.join(appData, instance ? `wmux-${instance}` : 'wmux', 'logs');
        node_fs_1.default.mkdirSync(logDir, { recursive: true });
        const safeDetail = detail.replace(/[\r\n]+/gu, ' ').slice(0, 240);
        node_fs_1.default.writeFileSync(node_path_1.default.join(logDir, 'hook-transport-last.json'), JSON.stringify({
            version: 1,
            ts: Date.now(),
            event: failureEvent,
            agent,
            surfaceId,
            attempts,
            kind,
            detail: safeDetail,
        }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    }
    catch {
        // Diagnostics must never turn a recoverable telemetry loss into a Hook failure.
    }
}
function finishHookTransportFailure(kind, detail, attempts) {
    recordHookTransportFailure(kind, detail, attempts);
    const exitCode = (0, wmux_hook_context_1.wmuxHookTransportFailureExitCode)(failureEvent);
    if (exitCode !== 0) {
        const suffix = detail ? `: ${detail.replace(/[\r\n]+/gu, ' ').slice(0, 240)}` : '';
        console.error(`[wmux-hook] ${failureEvent} delivery failed (${kind}, attempts=${attempts})${suffix}`);
    }
    process.exitCode = exitCode;
}
const runtimeContext = (0, wmux_hook_context_1.resolveWmuxHookRuntimeContext)(process.env);
if (runtimeContext.state === 'inactive')
    process.exit(0);
if (runtimeContext.state === 'invalid') {
    finishHookTransportFailure('missing-context', runtimeContext.missing.join(', '), 0);
    process.exit();
}
function sendHook() {
    if (sent)
        return;
    sent = true;
    if (fallbackTimer)
        clearTimeout(fallbackTimer);
    const payload = (0, wmux_hook_payload_1.parseWmuxHookPayload)(stdinData, event || failureEvent);
    const params = {};
    params.hookId = (0, wmux_hook_payload_1.stableWmuxHookId)({
        event,
        agent,
        surfaceId,
        sessionId: payload.sessionId,
        turnId: payload.turnId,
    }) || (0, node_crypto_1.randomUUID)();
    if (event)
        params.event = event;
    if (tool)
        params.tool = tool;
    if (payload.file)
        params.file = payload.file;
    if (payload.message)
        params.message = payload.message;
    if (payload.task)
        params.task = payload.task;
    if (payload.command)
        params.command = payload.command;
    if (payload.sessionId)
        params.agentSessionId = payload.sessionId;
    if (payload.turnId)
        params.agentTurnId = payload.turnId;
    const cwd = payload.cwd || process.cwd();
    if (cwd)
        params.cwd = cwd;
    if (surfaceId)
        params.surfaceId = surfaceId;
    if (agent)
        params.agent = agent;
    const wireMessage = JSON.stringify({ method: 'hook.event', params, id: 1, token }) + '\n';
    let attempt = 0;
    const write = () => {
        attempt++;
        let completed = false;
        let retryScheduled = false;
        let response = '';
        const client = net_1.default.connect({ path: pipePath }, () => {
            client.write(wireMessage);
        });
        client.setTimeout(PIPE_RESPONSE_TIMEOUT_MS);
        const retry = (kind, detail) => {
            if (completed || retryScheduled)
                return;
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
            if (!response.includes('\n'))
                return;
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
            }
            catch {
                retry('invalid-response', 'wmux returned non-JSON data');
            }
        });
        client.once('end', () => retry('invalid-response', 'wmux closed before a complete response'));
        client.once('error', (error) => {
            retry('socket-error', error.code || error.message || 'unknown socket error');
        });
        client.once('timeout', () => {
            retry('response-timeout', `no response within ${PIPE_RESPONSE_TIMEOUT_MS}ms`);
        });
    };
    write();
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { if (stdinData.length < MAX_STDIN)
    stdinData += chunk; });
process.stdin.on('end', sendHook);
process.stdin.on('error', sendHook);
fallbackTimer = setTimeout(sendHook, 1000);
if (process.stdin.readableEnded)
    sendHook();
