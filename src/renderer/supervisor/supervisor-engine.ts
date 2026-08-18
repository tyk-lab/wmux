/** Pure supervisor polling decisions; side effects live in App. */

import type {
  SupervisorLane,
  SupervisorSession,
} from '../store/supervisor-slice';
import { surfaceTerminalRegistry } from '../hooks/useTerminal';
import { supervisorLaneControlState } from '../store/supervisor-slice';
import { effectiveSupervisorAutonomyPermissions } from './protocol';
import { hasPendingTerminalInput } from './pending-input-guard';
import {
  attachAutomatedTerminalSubmitTimer,
  beginAutomatedTerminalSubmit,
  cancelPendingAutomatedTerminalSubmit,
  consumeAutomatedTerminalSubmit,
} from '../utils/terminal-user-submit';
import { INTERACTIVE_TUI_READY_DELAY_MS, pasteSubmitDelayMs } from '../utils/terminal-input-delivery';

export { pasteSubmitDelayMs } from '../utils/terminal-input-delivery';

export type DeclaredState = 'blocked' | 'working' | 'idle' | 'unknown';

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

  const st = String(surfaceState.state || 'unknown');
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

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/** Keep multi-line AI text inside one terminal draft instead of submitting its first line. */
export function prepareTerminalPasteInput(
  text: string,
  bracketedPasteMode: boolean,
): string {
  if (!/[\r\n]/u.test(text)) return text;
  const normalized = text.replace(/\r\n|\n|\r/gu, '\r');
  if (bracketedPasteMode) {
    return `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}`;
  }
  return normalized.replace(/\r+/gu, ' ');
}

function terminalPasteInput(surfaceId: string, text: string, submitEnter: boolean): string {
  const input = submitEnter ? text.replace(/[\r\n]+$/u, '') : text;
  const bracketedPasteMode = surfaceTerminalRegistry.get(surfaceId)?.modes?.bracketedPasteMode === true;
  return prepareTerminalPasteInput(input, bracketedPasteMode);
}

export function sendToSurface(surfaceId: string, text: string, submitEnter: boolean): void {
  const pty = (window as any).wmux?.pty;
  if (!pty?.write) {
    throw new Error('wmux.pty.write unavailable');
  }
  const input = terminalPasteInput(surfaceId, text, submitEnter);
  if (!submitEnter) {
    pty.write(surfaceId, input);
    return;
  }

  const token = beginAutomatedTerminalSubmit(surfaceId, () => {
    try {
      pty.write(surfaceId, '\x03');
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
    throw new Error('任务终端输入框已有未提交内容；为避免与 AI 裁决粘连，已取消本次发送。请先提交或清空原输入后重试。');
  }
}

/** Send a new task without ever appending it to an existing user draft. */
export function sendTaskToSurface(surfaceId: string, text: string, submitEnter: boolean): void {
  assertTaskTerminalInputAvailable(surfaceId);
  sendToSurface(surfaceId, text, submitEnter);
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
  captureBeforeSubmit?: () => string,
): Promise<{ beforeSubmitScreen?: string }> | void {
  const pty = (window as any).wmux?.pty;
  if (!pty?.writeReliable) {
    if (!submitEnter) {
      sendToSurface(surfaceId, text, false);
      return;
    }
    if (!pty?.write) {
      throw new Error('wmux.pty.write unavailable');
    }
    const input = terminalPasteInput(surfaceId, text, true);
    return new Promise<{ beforeSubmitScreen?: string }>((resolve, reject) => {
      const token = beginAutomatedTerminalSubmit(surfaceId, () => {
        try {
          pty.write(surfaceId, '\x03');
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
        if (!consumeAutomatedTerminalSubmit(token)) {
          reject(new Error('正文投递期间检测到用户输入，已取消自动提交'));
          return;
        }
        const beforeSubmitScreen = captureBeforeSubmit?.();
        try {
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
      void pty.writeReliable(surfaceId, '\x03');
    });
    if (!await pty.writeReliable(surfaceId, input)) {
      cancelPendingAutomatedTerminalSubmit(surfaceId, false);
      throw new Error('任务终端未完整接受下一步正文');
    }

    await new Promise<void>((resolve) => window.setTimeout(resolve, pasteSubmitDelayMs(input)));
    if (!consumeAutomatedTerminalSubmit(token)) {
      throw new Error('正文投递期间检测到用户输入，已取消自动提交');
    }
    const beforeSubmitScreen = captureBeforeSubmit?.();
    if (!await pty.writeReliable(surfaceId, '\r')) {
      void pty.writeReliable(surfaceId, '\x03');
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
  captureBeforeSubmit?: () => string,
): Promise<{ beforeSubmitScreen?: string }> | void {
  return sendSurfaceInputReliably(surfaceId, text, submitEnter, captureBeforeSubmit);
}

export function sendTaskToSurfaceReliably(
  surfaceId: string,
  text: string,
  submitEnter: boolean,
  captureBeforeSubmit?: () => string,
): Promise<{ beforeSubmitScreen?: string }> | void {
  assertTaskTerminalInputAvailable(surfaceId);
  return sendSurfaceInputReliably(surfaceId, text, submitEnter, captureBeforeSubmit);
}

/** Permission prompts are the current terminal input, so they intentionally bypass the empty-draft guard. */
export function sendPermissionResponseReliably(
  surfaceId: string,
  response: string,
  captureBeforeSubmit?: () => string,
): Promise<{ beforeSubmitScreen?: string }> | void {
  return sendSurfaceInputReliably(surfaceId, response, true, captureBeforeSubmit);
}
