"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveWmuxHookRuntimeContext = resolveWmuxHookRuntimeContext;
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
