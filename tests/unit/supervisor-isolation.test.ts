import { create } from 'zustand';
import { describe, expect, it } from 'vitest';
import {
  isSupervisorDecisionAuthorised,
  isSupervisorNextAllowed,
  isSupervisorProposalAllowed,
  normalizedMaxAutoDecisions,
  reachesAutoDecisionLimit,
} from '../../src/renderer/pipe-bridge';
import {
  createDefaultSupervisorSession,
  createSupervisorSlice,
  type SupervisorLane,
  type SupervisorSlice,
} from '../../src/renderer/store/supervisor-slice';
import {
  buildInjectedPrompt,
  buildSupervisorBriefing,
  supervisorTabTitle,
} from '../../src/renderer/supervisor/protocol';
import { formatSupervisorAuditTrail, summarizeRestoredHistory } from '../../src/renderer/supervisor/recording';

function lane(partial: Partial<SupervisorLane> = {}): SupervisorLane {
  return {
    id: 'lane-a',
    label: 'Auth worker',
    surfaceId: 'worker-a' as any,
    supervisorSurfaceId: 'supervisor-a' as any,
    enabled: true,
    steps: [],
    maxAutoSteps: 8,
    autoStepsUsed: 0,
    awaitingStopCheck: false,
    stopConfirmed: false,
    ...partial,
  };
}

function makeStore() {
  return create<SupervisorSlice>()((...args) => createSupervisorSlice(...args));
}

describe('supervisor isolation', () => {
  it('briefs a dedicated supervisor about one worker only', () => {
    const session = createDefaultSupervisorSession();
    const text = buildSupervisorBriefing(session, { lane: lane(), state: 'idle' });

    expect(text).toContain('worker-a');
    expect(text).toContain('只监督此终端');
    expect(text).not.toContain('worker-b');
  });

  it('only accepts a decision from the lane dedicated supervisor terminal', () => {
    const monitored = lane();

    expect(isSupervisorDecisionAuthorised(monitored, 'supervisor-a')).toBe(true);
    expect(isSupervisorDecisionAuthorised(monitored, 'supervisor-b')).toBe(false);
    expect(isSupervisorDecisionAuthorised(monitored, '')).toBe(false);
  });

  it('requires human decision for route changes and important suggestions', () => {
    expect(isSupervisorProposalAllowed('continue', 'route-change')).toBe(false);
    expect(isSupervisorProposalAllowed('rework', 'important')).toBe(false);
    expect(isSupervisorProposalAllowed('needs-human', 'route-change')).toBe(true);
    expect(isSupervisorProposalAllowed('needs-human', 'important')).toBe(true);
    expect(isSupervisorProposalAllowed('continue', '')).toBe(true);
  });

  it('does not allow unified supervision to inject a normal next task', () => {
    expect(isSupervisorNextAllowed('unified', 'continue', '继续修复')).toBe(false);
    expect(isSupervisorNextAllowed('unified', 'rework', '补测试')).toBe(false);
    expect(isSupervisorNextAllowed('unified', 'needs-human', '建议改为另一方案')).toBe(true);
    expect(isSupervisorNextAllowed('direct', 'continue', '继续')).toBe(true);
  });

  it('requires human review after the configured automatic decision limit', () => {
    expect(normalizedMaxAutoDecisions(undefined)).toBeNull();
    expect(normalizedMaxAutoDecisions(0)).toBeNull();
    expect(reachesAutoDecisionLimit(lane({ autoDecisionsUsed: 99 }), null)).toBe(false);
    expect(reachesAutoDecisionLimit(lane({ autoDecisionsUsed: 2 }), 3)).toBe(true);
    expect(reachesAutoDecisionLimit(lane({ autoDecisionsUsed: 1 }), 3)).toBe(false);
  });

  it('clears lanes and in-memory decision history when restarting from scratch', () => {
    const store = makeStore();
    store.getState().setSupervisorLanes([
      lane({ currentTask: '修复登录', decisions: [{ ts: 1, task: '修复登录', outcome: 'continue', reason: '继续', next: '' }] }),
    ]);
    store.getState().startSupervisor();

    store.getState().resetSupervisorSession();

    expect(store.getState().supervisor).toMatchObject({
      active: false,
      sessionId: '',
      lanes: [],
      log: [],
    });
  });

  it('names each visible supervisor tab after its worker lane', () => {
    expect(supervisorTabTitle('Auth worker')).toBe('AI 监督 · Auth worker');
  });

  it('uses codex as the default dedicated supervisor launch command', () => {
    expect(createDefaultSupervisorSession().supervisorLaunchCmd).toBe('codex');
  });

  it('leaves the Codex model and reasoning effort to their defaults by default', () => {
    const session = createDefaultSupervisorSession();
    expect(session.supervisorModel).toBe('');
    expect(session.supervisorReasoningEffort).toBe('');
  });

  it('creates unified supervision by default', () => {
    const session = createDefaultSupervisorSession();
    expect(session.mode).toBe('unified');
    expect(session.taskDescription).toBe('');
    expect(session.maxAutoDecisions).toBeNull();
  });

  it('does not restore audit history unless the user enables it', () => {
    expect(createDefaultSupervisorSession().restoreAuditHistory).toBe(false);
  });

  it('retains the route-change proposal details until the user resolves them', () => {
    const store = makeStore();
    store.getState().enqueueApproval({
      laneId: 'lane-a',
      surfaceId: 'worker-a' as any,
      laneLabel: 'Auth worker',
      text: '改用新的认证依赖',
      source: 'supervisor-route',
      proposalKind: 'route-change',
      reason: '现有方案无法满足需求',
      impact: '需要新增依赖并修改登录流程',
      alternatives: '保留现有方案并补适配层',
    });

    const proposal = store.getState().supervisor.pendingApprovals[0];
    expect(proposal).toMatchObject({
      proposalKind: 'route-change',
      impact: '需要新增依赖并修改登录流程',
      alternatives: '保留现有方案并补适配层',
    });
  });

  it('gives the selected plan to the dedicated supervisor but not the worker', () => {
    const session = {
      ...createDefaultSupervisorSession(),
      planFilePath: 'D:\\plans\\auth.md',
      planFileContent: '只允许改动 src/auth，必须保留现有 API。',
      preconditions: '设备已上电，安全措施已确认。',
      maxAutoDecisions: 3,
    };
    const briefing = buildSupervisorBriefing(session, { lane: lane(), state: 'idle' });
    const workerPrompt = buildInjectedPrompt({
      session,
      lane: lane(),
      step: { id: 's1', prompt: '修复登录错误处理', status: 'pending' },
      stepIndex: 1,
      stepCount: 1,
    });

    expect(briefing).toContain('计划文件（任务背景参考）');
    expect(briefing).toContain('路径: D:\\plans\\auth.md');
    expect(briefing).toContain('启动 briefing 不会附带或粘贴文件正文');
    expect(briefing).not.toContain('只允许改动 src/auth');
    expect(briefing).toContain('不是停止条件或硬约束');
    expect(briefing).toContain('已确认的前置条件 / 环境信息');
    expect(briefing).toContain('设备已上电');
    expect(briefing).toContain('用户已确认、在本次监督会话内有效');
    expect(briefing).toContain('不要仅因历史审计、任务日志');
    expect(briefing).toContain('每 3 次 AI 裁决后必须等待人工审阅');
    expect(workerPrompt).not.toContain('只允许改动 src/auth');
    expect(workerPrompt).not.toContain('设备已上电');
  });

  it('injects recovered audit context only into its dedicated supervisor briefing', () => {
    const session = { ...createDefaultSupervisorSession(), mode: 'goal-chase' as const };
    const laneA = lane({
      restoredFromSessionId: 'sup-old',
      restoredHistory: '[2026/7/31 10:00:00] 收到任务：修复登录',
    });
    const laneB = lane({ id: 'lane-b', label: 'B', surfaceId: 'worker-b' as any });

    const briefingA = buildSupervisorBriefing(session, { lane: laneA, state: 'idle' });
    const briefingB = buildSupervisorBriefing(session, { lane: laneB, state: 'idle' });
    expect(briefingA).toContain('已恢复的本终端审计摘要');
    expect(briefingA).toContain('修复登录');
    expect(briefingB).not.toContain('修复登录');
  });

  it('restores the latest task and decisions into the matching lane timeline', () => {
    const restored = summarizeRestoredHistory({
      sessionId: 'sup-old',
      events: [
        { ts: 1, type: 'worker.task', payload: { task: '修复登录' } },
        { ts: 2, type: 'supervisor.decision', payload: { outcome: 'rework', reason: '缺少测试', next: '补单测' } },
      ],
    });

    expect(restored).toMatchObject({
      currentTask: '修复登录',
      restoredFromSessionId: 'sup-old',
      decisions: [{ task: '修复登录', outcome: 'rework', reason: '缺少测试', next: '补单测' }],
    });
  });

  it('formats a terminal-isolated audit trail for a separate record tab', () => {
    const text = formatSupervisorAuditTrail(lane({ projectDir: 'D:\\repo' }), {
      sessions: [{
        sessionId: 'sup-a',
        createdAt: 1,
        events: [
          { ts: 2, type: 'worker.task', payload: { task: '修复登录' } },
          { ts: 3, type: 'supervisor.decision', payload: { outcome: 'complete', reason: '测试通过' } },
          { ts: 4, type: 'session.abandoned', payload: { reason: '用户选择重头再来' } },
          { ts: 5, type: 'supervisor.proposal.resolved', payload: { resolution: 'approved', proposalKind: 'route-change', text: '按替代方案继续' } },
          { ts: 6, type: 'supervisor.auto-decision-limit.resolved', payload: { resolution: 'human-reviewed' } },
        ],
      }],
    });

    expect(text).toContain('监督记录 · Auth worker');
    expect(text).toContain('裁决：complete');
    expect(text).toContain('已废除旧上下文');
    expect(text).toContain('人工裁决：已批准（路线变更）');
    expect(text).toContain('人工已审阅');
    expect(text).toContain('D:\\\\repo\\\\.wmux\\\\supervisor');
  });
});
