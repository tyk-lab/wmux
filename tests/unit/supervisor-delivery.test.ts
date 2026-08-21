import { describe, expect, it } from 'vitest';
import {
  canDeliverToSupervisor,
  enqueueSupervisorDelivery,
  nextDeliverableSupervisorDelivery,
  nextSupervisorDeliveryRetryAttempt,
  shouldReportUnacknowledgedSupervisorIdle,
  supervisorDeliveryLabel,
  supervisorWakeDeliveryKind,
  unacknowledgedSupervisorIdleAction,
} from '../../src/renderer/supervisor/delivery';
import { isAwaitingNextPromptState } from '../../src/renderer/agent-state-semantics';

const event = (id: string, kind: 'task-end', task: string, turnId?: number) => ({
  id,
  kind,
  task,
  text: task,
  createdAt: 1,
  turnId,
  stage: 'pending' as const,
});

describe('supervisor delivery queue', () => {
  it('preserves repeated task text from different worker turns', () => {
    const first = event('end-1', 'task-end', '运行测试', 1);
    const second = event('end-2', 'task-end', '运行测试', 2);
    expect(enqueueSupervisorDelivery([first], second).map((item) => item.id))
      .toEqual(['end-1', 'end-2']);
  });

  it('coalesces queued worker status to the newest snapshot', () => {
    const first = {
      id: 'status-working', kind: 'worker-status' as const, task: '运行测试',
      text: '任务仍在运行', createdAt: 1, turnId: 1, stage: 'pending' as const,
    };
    const latest = { ...first, id: 'status-idle', text: '任务已经空闲', createdAt: 2 };
    const queued = enqueueSupervisorDelivery([first], latest);

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ id: 'status-idle', text: '任务已经空闲' });
  });

  it('preserves an in-flight worker status and queues the newest snapshot after it', () => {
    const pasted = {
      id: 'status-pasted', kind: 'worker-status' as const, task: '运行测试',
      text: '任务仍在运行', createdAt: 1, turnId: 1, stage: 'pasted' as const,
    };
    const latest = { ...pasted, id: 'status-latest', text: '任务已经空闲', createdAt: 2, stage: 'pending' as const };

    expect(enqueueSupervisorDelivery([pasted], latest).map((item) => item.id))
      .toEqual(['status-pasted', 'status-latest']);
  });

  it('coalesces owner decisions while the supervisor is busy and keeps the latest direction', () => {
    const first = {
      id: 'owner-1', kind: 'owner-decision' as const, task: '实现功能',
      text: '采用旧方向', createdAt: 1, correlationId: 'approval-1', stage: 'pending' as const,
    };
    const latest = {
      ...first, id: 'owner-2', text: '采用最新方向', createdAt: 2, correlationId: 'approval-2',
    };

    expect(enqueueSupervisorDelivery([first], latest)).toEqual([latest]);
    expect(nextDeliverableSupervisorDelivery([latest], { state: 'working' })).toBeUndefined();
    expect(nextDeliverableSupervisorDelivery([latest], { state: 'unknown' })).toBeUndefined();
    expect(nextDeliverableSupervisorDelivery([latest], { state: 'idle' })?.id).toBe('owner-2');
  });

  it('does not replace owner decision text after it has already been pasted', () => {
    const pasted = {
      id: 'owner-pasted', kind: 'owner-decision' as const, task: '实现功能',
      text: '已粘贴方向', createdAt: 1, correlationId: 'approval-1', stage: 'pasted' as const,
    };
    const latest = {
      ...pasted, id: 'owner-latest', text: '后续方向', createdAt: 2,
      correlationId: 'approval-2', stage: 'pending' as const,
    };

    expect(enqueueSupervisorDelivery([pasted], latest).map((item) => item.id))
      .toEqual(['owner-pasted', 'owner-latest']);
    expect(nextDeliverableSupervisorDelivery([pasted, latest], { state: 'working' })).toBeUndefined();
  });

  it('waits while the dedicated supervisor is working or blocked', () => {
    expect(canDeliverToSupervisor('working')).toBe(false);
    expect(canDeliverToSupervisor('blocked')).toBe(false);
    expect(canDeliverToSupervisor({ state: 'blocked', blockedReason: 'permission: npm test' })).toBe(false);
    expect(canDeliverToSupervisor({ state: 'blocked', blockedReason: 'question: choose A or B' })).toBe(false);
    expect(canDeliverToSupervisor('idle')).toBe(true);
    expect(canDeliverToSupervisor('unknown')).toBe(false);
  });

  it('delivers a queued lifecycle fact when the supervisor is only waiting for its next prompt', () => {
    const completed = event('end', 'task-end', '运行测试', 2);
    const promptReady = { state: 'blocked', blockedReason: 'Waiting for your next prompt' };

    expect(isAwaitingNextPromptState(promptReady)).toBe(true);
    expect(canDeliverToSupervisor(promptReady)).toBe(true);
    expect(nextDeliverableSupervisorDelivery([completed], promptReady)?.id).toBe('end');
    const liveness = {
      id: 'probe', kind: 'liveness-probe' as const, task: '检查状态',
      text: '请检查', createdAt: 1, stage: 'pending' as const,
    };
    expect(nextDeliverableSupervisorDelivery([liveness], promptReady)?.id).toBe('probe');
  });

  it('delivers only the first bootstrap briefing when a new TUI is ready but has no hook state yet', () => {
    const bootstrap = {
      id: 'startup', kind: 'control-message' as const, task: '启动监督',
      text: '完整监督协议', createdAt: 1, stage: 'pending' as const,
      bootstrapOnRuntimeReady: true,
    };
    const later = {
      id: 'later', kind: 'control-message' as const, task: '更新方向',
      text: '后续控制消息', createdAt: 2, stage: 'pending' as const,
    };
    const legacyBootstrap = {
      ...bootstrap,
      id: 'legacy-startup',
      bootstrapOnRuntimeReady: undefined,
      text: '# 项目监督 AI · 首次启动任务终端\n旧版持久化协议',
    };

    expect(nextDeliverableSupervisorDelivery([bootstrap, later], { state: 'unknown' }, false)).toBeUndefined();
    expect(nextDeliverableSupervisorDelivery([bootstrap, later], { state: 'unknown' }, true)?.id).toBe('startup');
    expect(nextDeliverableSupervisorDelivery([legacyBootstrap], { state: 'unknown' }, true)?.id)
      .toBe('legacy-startup');
    expect(nextDeliverableSupervisorDelivery([later], { state: 'unknown' }, true)).toBeUndefined();
    expect(nextDeliverableSupervisorDelivery([bootstrap], { state: 'working' }, true)).toBeUndefined();
    expect(nextDeliverableSupervisorDelivery([bootstrap], { state: 'blocked', blockedReason: 'permission' }, true))
      .toBeUndefined();
  });

  it.each([
    'Waiting for next prompt',
    'Awaiting another instruction.',
    '等待下一条指令。',
  ])('recognizes a supported Agent idle nudge without broadening real blockers: %s', (blockedReason) => {
    expect(isAwaitingNextPromptState({ state: 'blocked', blockedReason })).toBe(true);
  });

  it('bounds transient delivery retries until a new lifecycle event resets the attempt counter', () => {
    expect(nextSupervisorDeliveryRetryAttempt(0)).toBe(1);
    expect(nextSupervisorDeliveryRetryAttempt(1)).toBe(2);
    expect(nextSupervisorDeliveryRetryAttempt(2)).toBeNull();
    expect(nextSupervisorDeliveryRetryAttempt(200)).toBeNull();
  });

  it('does not mistake a real blocked question containing prompt words for prompt-ready idle', () => {
    const blocked = {
      state: 'blocked',
      blockedReason: 'Waiting for your next prompt: choose adapter A or B',
    };

    expect(isAwaitingNextPromptState(blocked)).toBe(false);
    expect(canDeliverToSupervisor(blocked)).toBe(false);
  });

  it('does not let an idle-only liveness probe block a later lifecycle fact', () => {
    const liveness = {
      id: 'probe', kind: 'liveness-probe' as const, task: '检查状态',
      text: '请检查', createdAt: 1, stage: 'pending' as const,
    };
    const completed = event('end', 'task-end', '运行测试', 2);

    expect(nextDeliverableSupervisorDelivery([liveness, completed], 'unknown')).toBeUndefined();
    expect(nextDeliverableSupervisorDelivery([liveness, completed], 'idle')?.id).toBe('end');
    expect(nextDeliverableSupervisorDelivery([liveness, completed], 'working')).toBeUndefined();
    expect(enqueueSupervisorDelivery([liveness], completed).map((item) => item.id)).toEqual(['end']);
    expect(nextDeliverableSupervisorDelivery([
      { ...liveness, stage: 'pasted' }, completed,
    ], 'unknown')).toBeUndefined();
  });

  it('coalesces an undelivered user-task notice into a later actionable review', () => {
    const userTask = {
      id: 'user-task', kind: 'user-task' as const, task: '用户直发回归任务',
      text: '仅同步用户任务', createdAt: 1, turnId: 2, stage: 'pending' as const,
    };
    const completed = event('end', 'task-end', '用户直发回归任务', 2);
    const blocked = {
      id: 'blocked', kind: 'worker-status' as const, task: '用户直发回归任务',
      text: '任务正在等待权限', createdAt: 2, turnId: 2, reviewId: 'review-2', stage: 'pending' as const,
    };

    expect(enqueueSupervisorDelivery([userTask], completed).map((item) => item.id)).toEqual(['end']);
    expect(enqueueSupervisorDelivery([userTask], blocked).map((item) => item.id)).toEqual(['blocked']);
    expect(enqueueSupervisorDelivery([userTask], { ...blocked, reviewId: undefined }).map((item) => item.id))
      .toEqual(['user-task', 'blocked']);
    expect(enqueueSupervisorDelivery([{ ...userTask, stage: 'pasted' }], completed).map((item) => item.id))
      .toEqual(['user-task', 'end']);
  });

  it('keeps a submitted delivery as an acknowledgement barrier', () => {
    const submitted = {
      id: 'submitted-control', kind: 'control-message' as const, task: '同步新约束',
      text: '重新核对约束', createdAt: 1, stage: 'submitted' as const, submittedAt: 2,
    };
    const later = event('end', 'task-end', '运行测试', 3);

    expect(nextDeliverableSupervisorDelivery([submitted, later], 'idle')).toBeUndefined();
    expect(enqueueSupervisorDelivery([submitted], later).map((item) => item.id))
      .toEqual(['submitted-control', 'end']);
  });

  it('keeps only the latest actionable fact for one review generation', () => {
    const completed = {
      ...event('end', 'task-end', '运行测试', 2),
      reviewId: 'review-2',
      stage: 'pending' as const,
    };
    const blocked = {
      id: 'blocked', kind: 'worker-status' as const, task: '运行测试',
      text: '补充发现权限阻塞', createdAt: 2, turnId: 2,
      reviewId: 'review-2', stage: 'pending' as const,
    };
    expect(enqueueSupervisorDelivery([completed], blocked)).toEqual([blocked]);
  });

  it('lets a newer user-direct task supersede an undelivered older review', () => {
    const completed = {
      ...event('end-1', 'task-end', '旧任务', 1),
      reviewId: 'review-1',
      stage: 'pending' as const,
    };
    const userTask = {
      id: 'user-task-2', kind: 'user-task' as const, task: '用户新任务',
      text: '用户新任务已确认', createdAt: 2, turnId: 2, stage: 'pending' as const,
    };

    expect(enqueueSupervisorDelivery([completed], userTask).map((item) => item.id))
      .toEqual(['user-task-2']);
    expect(enqueueSupervisorDelivery([{ ...completed, stage: 'pasted' }], userTask).map((item) => item.id))
      .toEqual(['end-1', 'user-task-2']);
  });

  it('wakes only for terminal states that require a supervisor decision', () => {
    expect(supervisorWakeDeliveryKind('UserPromptSubmit')).toBeNull();
    expect(supervisorWakeDeliveryKind('PostToolUse')).toBeNull();
    expect(supervisorWakeDeliveryKind('Stop')).toBe('task-end');
    expect(supervisorWakeDeliveryKind('StopFailure')).toBe('task-end');
    expect(supervisorWakeDeliveryKind('Interrupt')).toBe('task-interrupted');
  });

  it('labels liveness probes separately from task lifecycle notifications', () => {
    expect(supervisorDeliveryLabel('liveness-probe')).toBe('活性检查');
    expect(supervisorDeliveryLabel('agent-recovery')).toBe('Agent 恢复');
    expect(supervisorDeliveryLabel('user-task')).toBe('用户直发任务');
    expect(supervisorDeliveryLabel('owner-decision')).toBe('上级决策');
  });

  it('reports any active supervisor turn that ended without a structured state handoff', () => {
    const base = {
      lifecycle: 'Stop', controlState: 'active',
      awaitingReview: true, providerLimited: false, hasPendingDecision: false,
      pendingDeliveries: 0,
    };
    expect(shouldReportUnacknowledgedSupervisorIdle(base)).toBe(true);
    expect(shouldReportUnacknowledgedSupervisorIdle({ ...base, lifecycle: 'Notification' })).toBe(false);
    expect(shouldReportUnacknowledgedSupervisorIdle({ ...base, awaitingReview: false })).toBe(false);
    expect(shouldReportUnacknowledgedSupervisorIdle({ ...base, controlState: 'waiting' })).toBe(false);
    expect(shouldReportUnacknowledgedSupervisorIdle({ ...base, hasPendingDecision: true })).toBe(false);
    expect(shouldReportUnacknowledgedSupervisorIdle({ ...base, pendingDeliveries: 1 })).toBe(false);
    expect(shouldReportUnacknowledgedSupervisorIdle({ ...base, providerLimited: true })).toBe(false);
  });

  it('retries once, then routes project and ordinary supervisors to different recovery owners', () => {
    expect(unacknowledgedSupervisorIdleAction(undefined)).toBe('retry-local');
    expect(unacknowledgedSupervisorIdleAction(1)).toBe('escalate-project');
    expect(unacknowledgedSupervisorIdleAction(undefined, false)).toBe('retry-local');
    expect(unacknowledgedSupervisorIdleAction(1, false)).toBe('pause-ordinary');
    expect(unacknowledgedSupervisorIdleAction(2)).toBe('ignore');
    expect(unacknowledgedSupervisorIdleAction(2, false)).toBe('ignore');
    expect(unacknowledgedSupervisorIdleAction(3)).toBe('ignore');
  });
});
