"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveWmuxHookRuntimeContext = resolveWmuxHookRuntimeContext;
/** Global agent hooks are harmless outside wmux, but partial wmux context is an integration fault. */
function resolveWmuxHookRuntimeContext(env) {
    if (env.WMUX_INTEGRATION?.trim() !== '1')
        return { state: 'inactive', missing: [] };
    const required = ['WMUX_SURFACE_ID', 'WMUX_PIPE', 'WMUX_PIPE_TOKEN'];
    const missing = required.filter((name) => !env[name]?.trim());
    return missing.length > 0
        ? { state: 'invalid', missing }
        : { state: 'ready', missing: [] };
}
