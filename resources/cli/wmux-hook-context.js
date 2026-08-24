"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveWmuxHookRuntimeContext = resolveWmuxHookRuntimeContext;
exports.wmuxHookTransportFailureExitCode = wmuxHookTransportFailureExitCode;
/** Global agent hooks are harmless outside wmux, but partial wmux context is an integration fault. */
function resolveWmuxHookRuntimeContext(env) {
    const required = ['WMUX_SURFACE_ID', 'WMUX_PIPE', 'WMUX_PIPE_TOKEN'];
    const integrationDeclared = env.WMUX_INTEGRATION?.trim() === '1';
    const capabilityDeclared = required.some((name) => !!env[name]?.trim());
    if (!integrationDeclared && !capabilityDeclared)
        return { state: 'inactive', missing: [] };
    const missing = required.filter((name) => !env[name]?.trim());
    return missing.length > 0
        ? { state: 'invalid', missing }
        : { state: 'ready', missing: [] };
}
const OBSERVATIONAL_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
/**
 * Tool activity is best-effort telemetry. Turn boundaries and permission
 * requests drive supervision state, so losing those must remain visible.
 */
function wmuxHookTransportFailureExitCode(event) {
    return OBSERVATIONAL_HOOK_EVENTS.has(event) ? 0 : 1;
}
