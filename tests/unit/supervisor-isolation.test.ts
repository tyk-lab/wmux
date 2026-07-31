import { create } from 'zustand';
import { describe, expect, it } from 'vitest';
import { isSupervisorDecisionAuthorised } from '../../src/renderer/pipe-bridge';
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
import { summarizeRestoredHistory } from '../../src/renderer/supervisor/recording';

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

  it('gives the selected plan to the dedicated supervisor but not the worker', () => {
    const session = {
      ...createDefaultSupervisorSession(),
      planFilePath: 'D:\\plans\\auth.md',
      planFileContent: '只允许改动 src/auth，必须保留现有 API。',
    };
    const briefing = buildSupervisorBriefing(session, { lane: lane(), state: 'idle' });
    const workerPrompt = buildInjectedPrompt({
      session,
      lane: lane(),
      step: { id: 's1', prompt: '修复登录错误处理', status: 'pending' },
      stepIndex: 1,
      stepCount: 1,
    });

    expect(briefing).toContain('计划文件（最高任务方向与约束）');
    expect(briefing).toContain('只允许改动 src/auth');
    expect(workerPrompt).not.toContain('只允许改动 src/auth');
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
});
