/**
 * v2-bridge.ts — Table-driven V2 pipe handlers that simply forward to a renderer
 * `window.__wmux_*` bridge call and shape the reply. Extracted from index.ts's
 * dispatch switch so the switch stays maintainable; the behaviour (the exact JS
 * expression and response shape) is preserved verbatim per method.
 */
import { BrowserWindow } from 'electron';

type Respond = (result: any) => void;
type RespondError = (code: number, message: string) => void;

interface BridgeSpec {
  js: (params: any) => string;
  // Shape the renderer result into the RPC reply. Default: result ?? { ok: true }.
  shape?: (result: any) => any;
  // When there is no window: respond with this value instead of erroring. Used by
  // read-only "list" methods that should return an empty set rather than fail.
  emptyOnNoWindow?: any;
  // Error message when the renderer returns a falsy result (creation methods).
  requireResult?: string;
}

function firstWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0];
  return win && !win.isDestroyed() ? win : null;
}

const S = (v: any) => JSON.stringify(v);
const WINDOW_ROUTE_TIMEOUT_MS = 750;

function withWindowRouteTimeout(value: Promise<unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), WINDOW_ROUTE_TIMEOUT_MS);
    value.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

async function windowForCallerSurface(surfaceId: string): Promise<BrowserWindow | null> {
  const candidates = BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed());
  const ownership = await Promise.all(candidates.map((candidate) => withWindowRouteTimeout(
    candidate.webContents.executeJavaScript(`window.__wmux_hasSurface?.(${S(surfaceId)})`),
  )));
  const index = ownership.findIndex(Boolean);
  return index >= 0 ? candidates[index] : null;
}

const SPECS: Record<string, BridgeSpec> = {
  'workspace.create': {
    js: (p) => `window.__wmux_createWorkspace?.(${S(p || {})})`,
    shape: (r) => r || { ok: true },
  },
  'workspace.close': {
    js: (p) => `window.__wmux_closeWorkspace?.(${S(p?.id || p?.workspaceId)})`,
  },
  'workspace.select': {
    js: (p) => `window.__wmux_selectWorkspace?.(${S(p?.id || p?.workspaceId)})`,
  },
  'workspace.rename': {
    js: (p) => `window.__wmux_renameWorkspace?.(${S(p?.id || p?.workspaceId)}, ${S(p?.title || '')})`,
  },
  'workspace.list': {
    js: () => `window.__wmux_listWorkspaces?.()`,
    shape: (r) => ({ workspaces: r || [] }),
    emptyOnNoWindow: { workspaces: [] },
  },
  'pane.split': {
    js: (p) => `window.__wmux_splitPane?.(${S(p || {})})`,
    requireResult: 'No active workspace or panes',
  },
  'pane.close': {
    js: (p) => `window.__wmux_closePane?.(${S(p?.id || p?.paneId)}, ${S(p?.workspaceId)})`,
  },
  'pane.list': {
    js: (p) => `window.__wmux_listPanes?.(${S(p?.workspaceId)})`,
    shape: (r) => ({ panes: r || [] }),
    emptyOnNoWindow: { panes: [] },
  },
  'layout.grid': {
    js: (p) => `window.__wmux_layoutGrid?.(${S(p || {})})`,
    requireResult: 'No active workspace or invalid anchor',
  },
  'system.tree': {
    js: (p) => `window.__wmux_getTree?.(${S(p?.workspaceId)})`,
    shape: (r) => ({ tree: r || null }),
    emptyOnNoWindow: { tree: null },
  },
  'surface.create': {
    js: (p) => `window.__wmux_createSurface?.(${S(p || {})})`,
    requireResult: 'No active workspace or panes',
  },
  'surface.close': {
    js: (p) => `window.__wmux_closeSurface?.(${S(p?.id || p?.surfaceId)}, ${S(p?.workspaceId)})`,
  },
  'surface.focus': {
    js: (p) => `window.__wmux_focusSurface?.(${S(p?.id || p?.surfaceId)}, ${S(p?.workspaceId)})`,
  },
  'surface.rename': {
    js: (p) => `window.__wmux_renameSurface?.(${S(p?.id || p?.surfaceId)}, ${S(p?.title || '')}, ${S(p?.workspaceId)})`,
  },
  'surface.list': {
    js: (p) => `window.__wmux_listSurfaces?.(${S(p?.workspaceId)})`,
    shape: (r) => ({ surfaces: r || [] }),
    emptyOnNoWindow: { surfaces: [] },
  },
  'markdown.set_content': {
    // `title` is optional and only sets the tab label; without it every
    // CLI-pushed surface was labelled "Markdown", so several agent-pushed docs
    // in one pane were indistinguishable (issue #116). It does NOT make the
    // surface file-backed — pushed content stays pathless by design.
    js: (p) => `window.__wmux_setMarkdownContent?.(${S(p?.surfaceId || '')}, ${S(p?.markdown || '')}, ${S(p?.title || '')})`,
  },
  'markdown.get_content': {
    // Read the buffer back out, mirroring `read-screen` for terminals: it lets
    // an agent verify what it actually pushed, which is the only way to debug a
    // producer that emitted an escaped newline or an unclosed fence (#116).
    js: (p) => `window.__wmux_getMarkdownContent?.(${S(p?.surfaceId || '')})`,
    shape: (r) => r ?? { error: 'surface not found' },
  },
  'notification.list': {
    js: () => `window.__wmux_listNotifications?.()`,
    shape: (r) => ({ notifications: r || [] }),
    emptyOnNoWindow: { notifications: [] },
  },
  'supervisor.decide': {
    js: (p) => `window.__wmux_supervisorDecide?.(${S(p || {})})`,
    requireResult: 'No active supervisor lane for this terminal',
  },
  'supervisor.goal.draft': {
    js: (p) => `window.__wmux_supervisorGoalDraft?.(${S(p || {})})`,
    requireResult: 'No goal construction lane for this supervisor',
  },
  'supervisor.goal.finalize': {
    js: (p) => `window.__wmux_supervisorGoalFinalize?.(${S(p || {})})`,
    requireResult: 'No terminal-context goal construction lane for this supervisor',
  },
  'supervisor.reply': {
    js: (p) => `window.__wmux_supervisorReply?.(${S(p || {})})`,
    requireResult: 'No goal construction lane for this supervisor',
  },
  'supervisor.context': {
    js: (p) => `window.__wmux_supervisorContext?.(${S(p || {})})`,
    requireResult: 'No active supervisor lane for this terminal',
  },
  'supervisor.evidence': {
    js: (p) => `window.__wmux_supervisorEvidence?.(${S(p || {})})`,
    requireResult: 'No evidence available for this supervisor review',
  },
  'role.context': {
    js: (p) => `window.__wmux_roleContext?.(${S(p || {})})`,
    requireResult: 'No managed AI role for this terminal',
  },
  'project.status': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'status' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.update': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'update-definition' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.alignment.confirm': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'alignment-confirm' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.orientation.confirm': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'orientation-confirm' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.logs': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'logs' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.terminals': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'terminals' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.task.create': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'task-create' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.task.update': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'task-update' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.task.supervise': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'task-supervise' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.progress.sync': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'progress-sync' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.supervisor.transition.ack': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'transition-ack' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.goal.plan': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'goal-plan' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.task-terminal.start': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'task-terminal-start' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.task-terminal.rotate': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'task-terminal-rotate' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.task-terminal.control': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'task-terminal-control' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.worker.status': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'worker-status' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.worker.recover': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'worker-recover' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.worker.resource.acquire': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'worker-resource-acquire' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.worker.resource.release': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'worker-resource-release' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.worker.directive.reconcile': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'worker-directive-reconcile' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.worker.merge.submit': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'worker-merge-submit' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.worker.merge.apply': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'worker-merge-apply' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.worker.finalize': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'worker-finalize' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.supervisor.inspect': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'supervisor-inspect' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.supervisor.decide': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'supervisor-decide' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.user.question': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'user-question' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.terminal.rotate': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'terminal-rotate' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.execution.record': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'record-execution' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.pause': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'pause' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.pause-all': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'pause-all' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.resume': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'resume' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.resume-all': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'resume-all' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.stop': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'stop' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.complete': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'complete' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
  'project.reply': {
    js: (p) => `window.__wmux_projectManagerRequest?.(${S({ ...(p || {}), action: 'reply' })})`,
    requireResult: 'Project manager bridge is unavailable',
  },
};

function runBridge(spec: BridgeSpec, params: any, respond: Respond, respondError: RespondError): void {
  (async () => {
    try {
      let win: BrowserWindow | null = null;
      const callerSurfaceId = String(params?.callerSurfaceId || '').trim();
      if (callerSurfaceId) {
        win = await windowForCallerSurface(callerSurfaceId);
        if (!win) {
          respondError(-32000, 'Caller surface is not mounted in an active window');
          return;
        }
      } else {
        win = firstWindow();
      }
      if (!win) {
        if (spec.emptyOnNoWindow !== undefined) { respond(spec.emptyOnNoWindow); return; }
        respondError(-32000, 'No window');
        return;
      }
      const result = await win.webContents.executeJavaScript(spec.js(params));
      if (spec.requireResult && !result) { respondError(-32000, spec.requireResult); return; }
      respond(spec.shape ? spec.shape(result) : (result ?? { ok: true }));
    } catch (err: any) {
      respondError(-32000, err.message);
    }
  })();
}

/** Handle a uniform bridge method. Returns false if `method` isn't one. */
export function handleBridgeV2(
  method: string,
  params: any,
  respond: Respond,
  respondError: RespondError,
): boolean {
  const spec = SPECS[method];
  if (!spec) return false;
  runBridge(spec, params, respond, respondError);
  return true;
}
