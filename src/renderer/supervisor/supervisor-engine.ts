/** Pure supervisor polling decisions; side effects live in App. */

import type {
  SupervisorLane,
  SupervisorSession,
} from '../store/supervisor-slice';
import type { TerminalInputIsolationScope } from '../../shared/types';
import { surfaceTerminalRegistry } from '../hooks/useTerminal';
import { isProjectManagedSupervisorLane, supervisorLaneControlState } from '../store/supervisor-slice';
import { buildSupervisorWakeEventEnvelope, effectiveSupervisorAutonomyPermissions } from './protocol';
import { hasPendingTerminalInput } from './pending-input-guard';
import {
  attachAutomatedTerminalSubmitTimer,
  beginAutomatedTerminalSubmit,
  cancelPendingAutomatedTerminalSubmit,
  consumeAutomatedTerminalSubmit,
} from '../utils/terminal-user-submit';
import {
  INTERACTIVE_TUI_READY_DELAY_MS,
  pasteSubmitDelayMs,
  prepareAutomatedTerminalInput,
} from '../utils/terminal-input-delivery';
import { terminalRuntimeInputError } from '../terminal-runtime-lifecycle';
import { isAwaitingNextPromptState } from '../agent-state-semantics';

export { pasteSubmitDelayMs } from '../utils/terminal-input-delivery';

export type DeclaredState = 'blocked' | 'working' | 'idle' | 'unknown';

export function supervisorLaneInputIsolationScope(
  lane?: Pick<SupervisorLane, 'projectManagerProjectId' | 'projectWorkItemId' | 'projectTaskStartupPending'>,
): TerminalInputIsolationScope {
  return lane && isProjectManagedSupervisorLane(lane) ? 'project' : 'ordinary';
}

export interface SurfaceStateView {
  state: DeclaredState | string;
  blockedReason?: string | null;
  updatedAt?: number;
}

export interface LaneRuntime {
  lastState: string;
  lastBlockedLogAt: number | null;
  /** After notifying user for this lane, skip further auto work until restart. */
  humanNotified: boolean;
}

export function blankRuntime(): LaneRuntime {
  return {
    lastState: 'unknown',
    lastBlockedLogAt: null,
    humanNotified: false,
  };
}

export type TickAction =
  | { type: 'log'; laneId: string; action: string; detail: string }
  | {
      type: 'notify_supervisor';
      laneId: string;
      text: string;
      /** Opens exactly one decision window for the reported worker state. */
      opensReview?: boolean;
      /** Optional durable state fact for audit/status integrations. */
      statusEvent?: 'blocked';
      statusDetail?: string;
    }
  | {
      type: 'notify_user';
      laneId: string;
      reason: string;
      detail: string;
    };

export interface TickResult {
  actions: TickAction[];
  runtime: LaneRuntime;
}

/**
 * Advance one lane for one poll.
 */
export function tickLane(opts: {
  session: SupervisorSession;
  lane: SupervisorLane;
  surfaceState: SurfaceStateView;
  runtime: LaneRuntime;
  now: number;
}): TickResult {
  const { session, lane, surfaceState, now } = opts;
  const rt: LaneRuntime = { ...opts.runtime };
  const actions: TickAction[] = [];
  if (supervisorLaneControlState(lane) !== 'active' || rt.humanNotified || lane.stopConfirmed) {
    return { actions, runtime: rt };
  }
  // A worker finished a turn. Its supervisor must inspect that turn before the
  // scheduler injects another instruction or treats an idle state as success.
  if (lane.awaitingReview) return { actions, runtime: rt };

  const st = isAwaitingNextPromptState(surfaceState)
    ? 'idle'
    : String(surfaceState.state || 'unknown');
  const autonomyPermissions = effectiveSupervisorAutonomyPermissions(session, lane);

  let permissionInstruction: string;
  if (lane.remoteSshControl) {
    permissionInstruction = '当前任务终端会直接或间接控制 SSH 远端；任何权限请求都必须使用 needs-human，由人工确认。';
  } else if (autonomyPermissions.includes('permission-confirm')) {
    permissionInstruction = `先 read-screen --surface ${lane.surfaceId} 查看实际请求。仅当终端仍为 blocked、原因属于权限请求，且命令低风险、可逆、明确时，使用 wmux supervisor decide --surface ${lane.surfaceId} --outcome continue --reason "..." --permission-command "<实际命令>" --permission-response y；同一阻塞状态只确认一次。`;
  } else {
    permissionInstruction = '本会话未勾选“低风险权限确认”；权限请求必须使用 needs-human。';
  }

  // ── blocked → a dedicated supervisor may resolve explicit low-risk permissions ─
  if (st === 'blocked') {
    const reason = surfaceState.blockedReason || '等待人类（权限/输入）';
    if (!rt.lastBlockedLogAt || now - rt.lastBlockedLogAt > 15_000) {
      actions.push({
        type: 'log',
        laneId: lane.id,
        action: '阻塞',
        detail: `${lane.label}: ${reason}`,
      });
      if (lane.supervisorSurfaceId) {
        actions.push({
          type: 'notify_supervisor',
          laneId: lane.id,
          opensReview: true,
          ...(rt.lastState !== 'blocked' ? { statusEvent: 'blocked' as const, statusDetail: reason } : {}),
          text: [
            `[权限/输入阻塞] 通道=${lane.label} (${lane.surfaceId})`,
            `Hook 原因: ${reason}`,
            permissionInstruction,
            autonomyPermissions.includes('technical-choice')
              ? '若原因是 question / input，且只是原目标内低风险技术选择，可用 continue / rework 携带 --next 回答一次；业务偏好、用户专属决定或原因不明的输入使用 needs-human。'
              : '本会话未勾选“技术方案选择”；question / input 必须使用 needs-human，不得自行回答。',
            ...(lane.remoteSshControl
              ? ['SSH 远程控制下，删除/覆盖、向 SSH 任务终端发送中断信号、软件包安装/卸载/升级、服务/进程、账户/权限/网络/系统配置及破坏性数据库操作一律使用 needs-human，不得通过终端转发、脚本或其他间接方式绕过。']
              : []),
            '删除或覆盖、git push/重写历史、发布/部署、云端/生产环境、凭据/权限变更或无法确认的请求，一律使用 needs-human，不要发送权限确认。',
            buildSupervisorWakeEventEnvelope(
              lane.surfaceId,
              lane.activeReviewId,
              isProjectManagedSupervisorLane(lane),
            ),
          ].join('\n'),
        });
      } else {
        actions.push({
          type: 'notify_user',
          laneId: lane.id,
          reason: 'Agent 阻塞，需要你处理（注入已暂停）',
          detail: reason,
        });
      }
      rt.lastBlockedLogAt = now;
      // Only lanes without a dedicated supervisor pause on direct human
      // notification. AI-reviewed permission checks keep polling so a safe
      // confirmation can resume the worker normally.
      if (!lane.supervisorSurfaceId) rt.humanNotified = true;
    }
    rt.lastState = st;
    return { actions, runtime: rt };
  }

  // The scheduler never invents or dispatches work. Only an authenticated,
  // evidence-based supervisor decision may inject a bounded next action.
  rt.lastState = st;
  return { actions, runtime: rt };
}

/** Delay before the first briefing so a freshly launched AI TUI can accept it. */
export const SUPERVISOR_TUI_READY_DELAY_MS = INTERACTIVE_TUI_READY_DELAY_MS;

/**
 * Keep automated control text inside one terminal draft. The emulator's
 * bracketed-paste flag can be stale after a nested Agent TUI redraw or restart,
 * so embedded newlines must never be trusted as safe input delimiters.
 */
export function prepareTerminalPasteInput(
  text: string,
  _bracketedPasteMode: boolean,
): string {
  return prepareAutomatedTerminalInput(text);
}

function terminalPasteInput(_surfaceId: string, text: string, submitEnter: boolean): string {
  const input = submitEnter ? text.replace(/[\r\n]+$/u, '') : text;
  return prepareTerminalPasteInput(input, false);
}

export const TERMINAL_INLINE_TEXT_LIMIT = 4_000;

export function stagedTerminalInputPrompt(
  reference: string,
  filePath: string,
  isolationScope: TerminalInputIsolationScope,
): string {
  const scopeLabel = isolationScope === 'project' ? '项目 AI 链' : '普通监督链';
  return [
    `[wmux 临时投递文件｜${scopeLabel}]`,
    `投递域：${isolationScope}；仅当前目标终端可读取并执行。`,
    `请先使用文件读取工具完整读取此路径：${filePath}。`,
    '文件内容是本轮完整指令；读取后直接执行，不要将全文重新粘贴到终端。',
    `确认读取成功后，只删除这一个临时文件：${filePath}。`,
  ].join('\n');
}

function stageOversizedTerminalInput(
  surfaceId: string,
  text: string,
  isolationScope: TerminalInputIsolationScope,
): Promise<string> {
  const pty = (window as any).wmux?.pty;
  if (!pty?.stageInputFile) {
    return Promise.reject(new Error('当前版本不支持大文段临时文件投递；已拒绝全文写入终端'));
  }
  return Promise.resolve(pty.stageInputFile(surfaceId, text, isolationScope)).then(
    (staged: { reference?: string; filePath?: string }) => {
      const reference = String(staged?.reference || '');
      const expectedPrefix = `.wmux/tmp/terminal-input/${isolationScope}/`;
      if (!reference.startsWith(expectedPrefix)
        || !/^\.wmux\/tmp\/terminal-input\/(?:ordinary|project)\/terminal-input-[A-Za-z0-9._-]+\.txt$/u.test(reference)) {
        throw new Error('临时投递文件返回了非法路径');
      }
      const filePath = String(staged?.filePath || '').trim();
      const normalizedFilePath = filePath.replace(/\\/gu, '/');
      if (filePath && (
        /[\r\n]/u.test(filePath)
        || !/^(?:[A-Za-z]:\/|\/\/)/u.test(normalizedFilePath)
        || !normalizedFilePath.toLocaleLowerCase().endsWith(`/${reference.toLocaleLowerCase()}`)
      )) {
        throw new Error('临时投递文件返回了非法绝对路径');
      }
      return stagedTerminalInputPrompt(reference, filePath || reference, isolationScope);
    },
  );
}

export function sendToSurface(
  surfaceId: string,
  text: string,
  submitEnter: boolean,
  isolationScope: TerminalInputIsolationScope,
): Promise<void> | void {
  const runtimeError = terminalRuntimeInputError(surfaceId);
  if (runtimeError) throw new Error(`终端 Agent 已不可用：${runtimeError}`);
  const pty = (window as any).wmux?.pty;
  if (!pty?.write) {
    throw new Error('wmux.pty.write unavailable');
  }
  if (submitEnter && text.length > TERMINAL_INLINE_TEXT_LIMIT) {
    const stagedDelivery = stageOversizedTerminalInput(surfaceId, text, isolationScope).then((prompt) => {
      sendToSurface(surfaceId, prompt, true, isolationScope);
    });
    void stagedDelivery.catch((error) => {
      console.warn('[supervisor] oversized terminal input staging failed', error);
    });
    return stagedDelivery;
  }
  const input = terminalPasteInput(surfaceId, text, submitEnter);
  if (!submitEnter) {
    pty.write(surfaceId, input);
    return;
  }

  const token = beginAutomatedTerminalSubmit(surfaceId, () => {
    try {
      // The text has not been submitted yet. Clear the composer without using
      // Ctrl+C, which can terminate an idle interactive Agent.
      pty.write(surfaceId, '\x15');
    } catch {
      /* ignore */
    }
  });
  try {
    pty.write(surfaceId, input);
  } catch (error) {
    cancelPendingAutomatedTerminalSubmit(surfaceId, false);
    throw error;
  }
  const timer = window.setTimeout(() => {
    if (!consumeAutomatedTerminalSubmit(token)) return;
    try {
      pty.write(surfaceId, '\r');
    } catch {
      /* ignore */
    }
  }, pasteSubmitDelayMs(input));
  attachAutomatedTerminalSubmitTimer(token, timer);
}

function assertTaskTerminalInputAvailable(surfaceId: string): void {
  const terminal = surfaceTerminalRegistry.get(surfaceId);
  if (!terminal?.buffer.active) {
    throw new Error('任务终端输入状态不可用；为避免覆盖未知输入，已取消本次发送。请等待终端恢复后重试。');
  }
  if (hasPendingTerminalInput(terminal.buffer.active)) {
    throw new TaskTerminalInputBusyError();
  }
}

export class TaskTerminalInputBusyError extends Error {
  readonly code = 'task-terminal-input-busy';

  constructor() {
    super('任务终端输入框已有未提交内容；为避免与 AI 裁决粘连，已延后本次发送。提交或清空原输入后，控制层会通知监督 AI 重新裁决。');
    this.name = 'TaskTerminalInputBusyError';
  }
}

export function isTaskTerminalInputBusyError(error: unknown): error is TaskTerminalInputBusyError {
  return error instanceof TaskTerminalInputBusyError
    || (typeof error === 'object' && error !== null
      && (error as { code?: unknown }).code === 'task-terminal-input-busy');
}

/** Send a new task without ever appending it to an existing user draft. */
export function sendTaskToSurface(
  surfaceId: string,
  text: string,
  submitEnter: boolean,
  isolationScope: TerminalInputIsolationScope,
): void {
  assertTaskTerminalInputAvailable(surfaceId);
  sendToSurface(surfaceId, text, submitEnter, isolationScope);
}

/**
 * Deliver a supervisor decision through the acknowledged main-process queue.
 * Older preload bridges keep the same awaited body/Enter sequence, without the
 * main-process acknowledgement, so their in-flight lock is still preserved.
 */
function sendSurfaceInputReliably(
  surfaceId: string,
  text: string,
  submitEnter: boolean,
  isolationScope: TerminalInputIsolationScope,
  captureBeforeSubmit?: () => string,
  validateBeforeSubmit?: () => string | null,
  onBeforeSubmit?: () => void,
): Promise<{ beforeSubmitScreen?: string }> | void {
  const runtimeError = terminalRuntimeInputError(surfaceId);
  if (runtimeError) throw new Error(`终端 Agent 已不可用：${runtimeError}`);
  const pty = (window as any).wmux?.pty;
  if (submitEnter && text.length > TERMINAL_INLINE_TEXT_LIMIT) {
    return stageOversizedTerminalInput(surfaceId, text, isolationScope).then((prompt) => (
      sendSurfaceInputReliably(
        surfaceId,
        prompt,
        true,
        isolationScope,
        captureBeforeSubmit,
        validateBeforeSubmit,
        onBeforeSubmit,
      ) || { beforeSubmitScreen: captureBeforeSubmit?.() }
    ));
  }
  const preSubmitValidationError = (): string | null => {
    try {
      return validateBeforeSubmit?.() || null;
    } catch (error) {
      return `提交前校验异常，已按失败关闭处理：${String((error as Error)?.message || error)}`;
    }
  };
  if (!pty?.writeReliable) {
    if (!submitEnter) {
      sendToSurface(surfaceId, text, false, isolationScope);
      return;
    }
    if (!pty?.write) {
      throw new Error('wmux.pty.write unavailable');
    }
    const input = terminalPasteInput(surfaceId, text, true);
    return new Promise<{ beforeSubmitScreen?: string }>((resolve, reject) => {
      const token = beginAutomatedTerminalSubmit(surfaceId, () => {
        try {
          pty.write(surfaceId, '\x15');
        } catch {
          /* ignore */
        }
      });
      try {
        pty.write(surfaceId, input);
      } catch (error) {
        cancelPendingAutomatedTerminalSubmit(surfaceId, false);
        reject(error);
        return;
      }
      window.setTimeout(() => {
        const validationError = preSubmitValidationError();
        if (validationError) {
          cancelPendingAutomatedTerminalSubmit(surfaceId, true);
          reject(new Error(validationError));
          return;
        }
        if (!consumeAutomatedTerminalSubmit(token)) {
          reject(new Error('正文投递期间检测到用户输入，已取消自动提交'));
          return;
        }
        const beforeSubmitScreen = captureBeforeSubmit?.();
        try {
          onBeforeSubmit?.();
          pty.write(surfaceId, '\r');
          resolve({ beforeSubmitScreen });
        } catch (error) {
          reject(error);
        }
      }, pasteSubmitDelayMs(input));
    });
  }

  const input = terminalPasteInput(surfaceId, text, submitEnter);
  return (async () => {
    if (!submitEnter) {
      if (!await pty.writeReliable(surfaceId, input)) {
        throw new Error('任务终端未接受下一步正文');
      }
      return { beforeSubmitScreen: captureBeforeSubmit?.() };
    }

    const token = beginAutomatedTerminalSubmit(surfaceId, () => {
      void pty.writeReliable(surfaceId, '\x15');
    });
    if (!await pty.writeReliable(surfaceId, input)) {
      cancelPendingAutomatedTerminalSubmit(surfaceId, false);
      throw new Error('任务终端未完整接受下一步正文');
    }

    await new Promise<void>((resolve) => window.setTimeout(resolve, pasteSubmitDelayMs(input)));
    const validationError = preSubmitValidationError();
    if (validationError) {
      cancelPendingAutomatedTerminalSubmit(surfaceId, true);
      throw new Error(validationError);
    }
    if (!consumeAutomatedTerminalSubmit(token)) {
      throw new Error('正文投递期间检测到用户输入，已取消自动提交');
    }
    const beforeSubmitScreen = captureBeforeSubmit?.();
    onBeforeSubmit?.();
    if (!await pty.writeReliable(surfaceId, '\r')) {
      void pty.writeReliable(surfaceId, '\x15');
      throw new Error('任务终端未接受提交键；已尝试清理未提交正文');
    }
    return { beforeSubmitScreen };
  })();
}

/** Reliable control-plane delivery without the worker draft-empty assertion. */
export function sendToSurfaceReliably(
  surfaceId: string,
  text: string,
  submitEnter: boolean,
  isolationScope: TerminalInputIsolationScope,
  captureBeforeSubmit?: () => string,
): Promise<{ beforeSubmitScreen?: string }> | void {
  return sendSurfaceInputReliably(surfaceId, text, submitEnter, isolationScope, captureBeforeSubmit);
}

export function sendTaskToSurfaceReliably(
  surfaceId: string,
  text: string,
  submitEnter: boolean,
  isolationScope: TerminalInputIsolationScope,
  captureBeforeSubmit?: () => string,
  onBeforeSubmit?: () => void,
): Promise<{ beforeSubmitScreen?: string }> | void {
  assertTaskTerminalInputAvailable(surfaceId);
  return sendSurfaceInputReliably(
    surfaceId,
    text,
    submitEnter,
    isolationScope,
    captureBeforeSubmit,
    undefined,
    onBeforeSubmit,
  );
}

/** Permission prompts are the current terminal input, so they intentionally bypass the empty-draft guard. */
export function sendPermissionResponseReliably(
  surfaceId: string,
  response: string,
  isolationScope: TerminalInputIsolationScope,
  captureBeforeSubmit?: () => string,
  validateBeforeSubmit?: () => string | null,
): Promise<{ beforeSubmitScreen?: string }> | void {
  return sendSurfaceInputReliably(
    surfaceId,
    response,
    true,
    isolationScope,
    captureBeforeSubmit,
    validateBeforeSubmit,
  );
}
