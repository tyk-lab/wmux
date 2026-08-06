/**
 * Plan/goal supervisor tick — pure planning; side effects in App.
 */

import type {
  SupervisorLane,
  SupervisorSession,
  SupervisorStep,
} from '../store/supervisor-slice';
import { supervisorLaneControlState } from '../store/supervisor-slice';
import {
  buildInjectedPrompt,
  buildIdleHint,
  buildStopCheckHint,
  effectiveSupervisorAutonomyPermissions,
  effectiveSupervisorStopWhen,
  effectiveSupervisorStopWhenKind,
} from './protocol';

export type DeclaredState = 'blocked' | 'working' | 'idle' | 'unknown';

export interface SurfaceStateView {
  state: DeclaredState | string;
  blockedReason?: string | null;
  updatedAt?: number;
}

export interface LaneRuntime {
  lastState: string;
  inProgressSince: number | null;
  sawWorking: boolean;
  lastDispatchAt: number | null;
  lastProposeAt: number | null;
  lastBlockedLogAt: number | null;
  lastIdleHintAt: number | null;
  /** After notifying user for this lane, skip further auto work until restart. */
  humanNotified: boolean;
}

export function blankRuntime(): LaneRuntime {
  return {
    lastState: 'unknown',
    inProgressSince: null,
    sawWorking: false,
    lastDispatchAt: null,
    lastProposeAt: null,
    lastBlockedLogAt: null,
    lastIdleHintAt: null,
    humanNotified: false,
  };
}

export function getNextOpenStep(lane: SupervisorLane): { index: number; step: SupervisorStep } | null {
  for (let i = 0; i < lane.steps.length; i++) {
    const st = lane.steps[i];
    if (st.status === 'pending' || st.status === 'in_progress') {
      return { index: i, step: st };
    }
  }
  return null;
}

export function mayDispatch(state: string, allowUnknown: boolean): boolean {
  if (state === 'blocked' || state === 'working') return false;
  if (state === 'idle') return true;
  if (state === 'unknown' && allowUnknown) return true;
  return false;
}

export type TickAction =
  | { type: 'log'; laneId: string; action: string; detail: string }
  | { type: 'complete_step'; laneId: string; stepId: string }
  | {
      type: 'dispatch';
      laneId: string;
      surfaceId: string;
      stepId: string;
      text: string;
      countAuto: boolean;
    }
  | {
      type: 'notify_supervisor';
      laneId: string;
      text: string;
      /** Opens exactly one decision window for the reported worker state. */
      opensReview?: boolean;
    }
  | {
      type: 'notify_user';
      laneId: string;
      reason: string;
      detail: string;
      /** If true, stop entire scheduler after notify. */
      stopAll: boolean;
      /** If false, keep lane enabled (e.g. awaiting stop-condition confirm). Default true. */
      disableLane?: boolean;
    }
  | {
      type: 'ensure_goal_step';
      laneId: string;
    }
  | {
      /** direct: queue empty → pause injects and ask supervisor/human to judge stopWhen */
      type: 'request_stop_check';
      laneId: string;
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
  hasPendingApproval: boolean;
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
  const mode = session.mode || 'direct';
  const laneStopWhen = effectiveSupervisorStopWhen(session, lane);
  const laneStopWhenKind = effectiveSupervisorStopWhenKind(session, lane);
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
          stopAll: false,
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

  // The unified scheduler never invents work on its own. Only an explicit,
  // evidence-based supervisor decision may inject a bounded next step.
  if (mode === 'unified') {
    rt.lastState = st;
    return { actions, runtime: rt };
  }

  let open = getNextOpenStep(lane);

  // Awaiting stop/done judgment: only resume when new open steps appear (direct inject)
  // or human clicks「未达到」(clears awaitingStopCheck).
  if (lane.awaitingStopCheck && !open) {
    // Handled in !open branch below for re-prompt; skip dispatch.
  } else if (lane.awaitingStopCheck && open) {
    // New work queued — resume.
  }

  if (!open) {
    if (mode === 'direct') {
      // Queue empty ≠ done. Enter stop-condition check; only confirmStop stops injects.
      if (!lane.awaitingStopCheck) {
        actions.push({ type: 'request_stop_check', laneId: lane.id });
        actions.push({
          type: 'log',
          laneId: lane.id,
          action: '核对停止条件',
          detail: laneStopWhen || '（未填写停止条件）',
        });
        actions.push({
          type: 'notify_supervisor',
          laneId: lane.id,
          opensReview: true,
          text: buildStopCheckHint({
            lane,
            stopWhen: laneStopWhen,
            stopWhenKind: laneStopWhenKind,
            state: st,
            mode: 'direct',
            autonomyPermissions,
          }),
        });
        const kindLabel = laneStopWhenKind === 'direction' ? '方向' : '具体条件';
        actions.push({
          type: 'notify_user',
          laneId: lane.id,
          reason: '指令已执行完，请监督 AI / 你判断停止条件是否满足',
          detail: laneStopWhen
            ? `停止条件（${kindLabel}）: ${laneStopWhen} — 侧栏可确认「已达」或「未达到」`
            : '请填写停止条件',
          stopAll: false,
          disableLane: false,
        });
      } else if (
        lane.supervisorSurfaceId &&
        (!rt.lastIdleHintAt || now - rt.lastIdleHintAt > Math.max(session.idleStableMs * 3, 20_000))
      ) {
        actions.push({
          type: 'notify_supervisor',
          laneId: lane.id,
          opensReview: true,
          text: buildStopCheckHint({
            lane,
            stopWhen: laneStopWhen,
            stopWhenKind: laneStopWhenKind,
            state: st,
            mode: 'direct',
            autonomyPermissions,
          }),
        });
        rt.lastIdleHintAt = now;
      }
      rt.lastState = st;
      return { actions, runtime: rt };
    }

    // goal-chase: after a round of decisions, judge doneWhen before next auto step
    if (mode === 'goal-chase') {
      if (lane.awaitingStopCheck) {
        if (
          lane.supervisorSurfaceId &&
          (!rt.lastIdleHintAt || now - rt.lastIdleHintAt > Math.max(session.idleStableMs * 3, 20_000))
        ) {
          actions.push({
            type: 'notify_supervisor',
            laneId: lane.id,
            opensReview: true,
            text: buildStopCheckHint({
              lane,
              stopWhen: session.doneWhen,
              stopWhenKind: session.stopWhenKind || 'concrete',
              state: st,
              mode: 'goal-chase',
              autonomyPermissions,
            }),
          });
          rt.lastIdleHintAt = now;
        }
        rt.lastState = st;
        return { actions, runtime: rt };
      }

      const allDone =
        lane.steps.length > 0 &&
        lane.steps.every((s) => s.status === 'completed' || s.status === 'skipped');
      if (allDone && lane.autoStepsUsed > 0) {
        actions.push({ type: 'request_stop_check', laneId: lane.id });
        actions.push({
          type: 'log',
          laneId: lane.id,
          action: '核对完成条件',
          detail: session.doneWhen.trim() || '（未填写）',
        });
        actions.push({
          type: 'notify_supervisor',
          laneId: lane.id,
          opensReview: true,
          text: buildStopCheckHint({
            lane,
            stopWhen: session.doneWhen,
            stopWhenKind: session.stopWhenKind || 'concrete',
            autonomyPermissions,
            state: st,
            mode: 'goal-chase',
          }),
        });
        const kindLabel =
          (session.stopWhenKind || 'concrete') === 'direction' ? '方向' : '具体条件';
        actions.push({
          type: 'notify_user',
          laneId: lane.id,
          reason: '请监督 AI / 你判断完成条件是否满足',
          detail: session.doneWhen.trim()
            ? `完成条件（${kindLabel}）: ${session.doneWhen.trim()}`
            : '请填写完成条件',
          stopAll: false,
          disableLane: false,
        });
        rt.lastState = st;
        return { actions, runtime: rt };
      }

      if (lane.autoStepsUsed < lane.maxAutoSteps) {
        actions.push({ type: 'ensure_goal_step', laneId: lane.id });
        rt.lastState = st;
        return { actions, runtime: rt };
      }

      actions.push({
        type: 'notify_user',
        laneId: lane.id,
        reason: '决策步数用尽，请你接管并核对完成条件',
        detail: session.doneWhen.trim()
          ? `完成条件参考: ${session.doneWhen.trim()}`
          : '已达自动决策上限',
        stopAll: false,
      });
      rt.humanNotified = true;
      rt.lastState = st;
      return { actions, runtime: rt };
    }

    rt.lastState = st;
    return { actions, runtime: rt };
  }

  const { step, index } = open;
  const stepCount = Math.max(lane.steps.length, 1);
  const stepHuman = index + 1;

  // ── complete in_progress ───────────────────────────────────────────────
  if (step.status === 'in_progress') {
    if (st === 'working') rt.sawWorking = true;

    const elapsed = rt.inProgressSince != null ? now - rt.inProgressSince : 0;
    const stable = elapsed >= session.idleStableMs;
    const canComplete =
      st === 'idle' &&
      stable &&
      (rt.sawWorking || elapsed >= session.idleStableMs * 2);

    if (canComplete) {
      actions.push({ type: 'complete_step', laneId: lane.id, stepId: step.id });
      actions.push({
        type: 'log',
        laneId: lane.id,
        action: '步骤完成',
        detail: `${step.id} (${stepHuman}/${stepCount})`,
      });
      rt.sawWorking = false;
      rt.inProgressSince = null;
      rt.lastState = st;
      return { actions, runtime: rt };
    }

    rt.lastState = st;
    return { actions, runtime: rt };
  }

  // ── pending dispatch ───────────────────────────────────────────────────
  if (step.status !== 'pending') {
    rt.lastState = st;
    return { actions, runtime: rt };
  }

  if (!mayDispatch(st, session.allowUnknown)) {
    rt.lastState = st;
    return { actions, runtime: rt };
  }

  if (rt.lastDispatchAt && now - rt.lastDispatchAt < session.idleStableMs) {
    rt.lastState = st;
    return { actions, runtime: rt };
  }

  // goal-chase: ping supervisor AI with doneWhen judgment + next decision
  if (mode === 'goal-chase') {
    if (
      lane.supervisorSurfaceId
      && (!rt.lastIdleHintAt || now - rt.lastIdleHintAt > session.idleStableMs * 2)
    ) {
      actions.push({
        type: 'notify_supervisor',
        laneId: lane.id,
        opensReview: true,
        text:
          buildIdleHint({
            lane,
            state: st,
            goal: session.goal,
            doneWhen: session.doneWhen,
            stopWhenKind: session.stopWhenKind || 'concrete',
            autonomyPermissions,
          }) + '\n',
      });
      rt.lastIdleHintAt = now;
    }
    // Legacy goal-chase used to inject a generated worker prompt directly,
    // bypassing the unified decision policy. It is now read-only compatible:
    // the dedicated supervisor must submit any next step through decide.
    rt.lastState = st;
    return { actions, runtime: rt };
  }

  const text = buildInjectedPrompt({
    session,
    lane,
    step,
    stepIndex: stepHuman,
    stepCount,
  });

  if (!text.trim()) {
    actions.push({
      type: 'log',
      laneId: lane.id,
      action: '跳过',
      detail: '空指令，未注入',
    });
    rt.lastState = st;
    return { actions, runtime: rt };
  }

  actions.push({
    type: 'dispatch',
    laneId: lane.id,
    surfaceId: lane.surfaceId,
    stepId: step.id,
    text,
    countAuto: false,
  });
  actions.push({
    type: 'log',
    laneId: lane.id,
    action: '派发',
    detail: `原样注入 → ${lane.label} (${stepHuman}/${stepCount})`,
  });
  rt.lastDispatchAt = now;
  rt.inProgressSince = now;
  rt.sawWorking = false;
  rt.lastState = st;
  return { actions, runtime: rt };
}

/** Give interactive AI TUIs time to finish processing a paste before Enter submits it. */
export function pasteSubmitDelayMs(text: string): number {
  return Math.min(3_000, Math.max(300, 300 + Math.ceil(text.length * 0.75)));
}

/** Delay before the first briefing so a freshly launched AI TUI can accept it. */
export const SUPERVISOR_TUI_READY_DELAY_MS = 2_500;

export function sendToSurface(surfaceId: string, text: string, submitEnter: boolean): void {
  const pty = (window as any).wmux?.pty;
  if (!pty?.write) {
    throw new Error('wmux.pty.write unavailable');
  }
  pty.write(surfaceId, text);
  if (submitEnter) {
    window.setTimeout(() => {
      try {
        pty.write(surfaceId, '\r');
      } catch {
        /* ignore */
      }
    }, pasteSubmitDelayMs(text));
  }
}

/** Build a pending goal-chase decision step (id unique enough for UI). */
export function makeGoalChaseStep(used: number): SupervisorStep {
  return {
    id: `g${used + 1}`,
    title: `决策 ${used + 1}`,
    prompt: '',
    status: 'pending',
  };
}
