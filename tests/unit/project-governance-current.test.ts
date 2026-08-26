import { describe, expect, it } from 'vitest';
import {
  projectPlanningConfirmationError,
  type ProjectSupervisorContract,
} from '../../src/shared/project-manager';
import {
  buildProjectSupervisorBriefing,
  renderProjectTaskBatch,
} from '../../src/renderer/project-manager/engine';
import { evaluateProjectExecutionGuard } from '../../src/renderer/project-manager/anti-loop';

const contract: ProjectSupervisorContract = {
  objective: '形成可验收成果',
  description: '',
  preconditions: [],
  scope: { root: 'D:\\repo', allowPaths: ['src'], denyPaths: ['docs'], forbiddenActions: [] },
  authority: {
    technicalChoices: false,
    lowRiskRetries: false,
    targetedTests: false,
    internalThreads: false,
    continuousExecution: true,
  },
  stopWhen: ['成果完成'],
  validation: ['按项目规范验证'],
  budget: {
    maxContinuousMinutes: 1,
    maxAggregateWorkerMinutes: 60,
    maxIdenticalFailures: 2,
    maxNoProgressRounds: 2,
    maxTaskRetries: 2,
    maxSameTestRuns: 2,
    maxFullSuiteRunsPerVersion: 1,
  },
};

describe('project governance P9', () => {
  it('requires a fresh user event before applying AI planning supplements', () => {
    const session = {
      events: [
        { id: 'old-user', kind: 'user-message', ts: 5 },
        { id: 'old-confirmed', kind: 'user-clarification-answered', ts: 6 },
        { id: 'definition', kind: 'project-definition-updated', ts: 10 },
        { id: 'fresh-message', kind: 'user-message', ts: 15 },
        { id: 'confirmed', kind: 'user-clarification-answered', ts: 20 },
      ],
    } as any;
    expect(projectPlanningConfirmationError(session, {
      changesUserPlan: true,
      supplements: ['新增验收约束'],
    })).toContain('project ask');
    expect(projectPlanningConfirmationError(session, {
      changesUserPlan: true,
      supplements: ['新增验收约束'],
      userConfirmationEventId: 'old-confirmed',
    })).toContain('早于最近一次');
    expect(projectPlanningConfirmationError(session, {
      changesUserPlan: true,
      supplements: ['新增验收约束'],
      userConfirmationEventId: 'fresh-message',
    })).toContain('结构化用户答复');
    expect(projectPlanningConfirmationError(session, {
      changesUserPlan: true,
      supplements: ['新增验收约束'],
      userConfirmationEventId: 'confirmed',
    })).toBeNull();
    expect(projectPlanningConfirmationError(session, { changesUserPlan: false })).toBeNull();
  });

  it('makes the task AI the sole project executor', () => {
    const briefing = renderProjectTaskBatch(contract, {
      kind: 'task', coverage: 'bounded-batch', outcome: '形成当前可验收成果',
      completionDefinition: ['成果完成'], evidenceExpectations: ['按项目规范提供适用证据'],
      unmetCompletionItems: [], knownFacts: [], constraints: [], nonGoals: [],
    }, 'multi-thread');
    expect(briefing).toContain('[成果任务]');
    expect(briefing).toContain('读取并严格遵循当前目录层级适用的 AGENTS、项目技能和仓库规范');
    expect(briefing).toContain('自行决定实现路线、必要的相邻修改、文件、命令、测试、技能和任务内部组织方式');
    expect(briefing).toContain('完成定义');
    expect(briefing).toContain('证据期望（如适用）');
    expect(briefing).toContain('[并行能力] 允许内部并行');
    expect(briefing).not.toContain('允许范围：');
    expect(briefing).not.toMatch(/项目 ID|工作项|监督 AI|普通监督链|裁决|lane|budget/iu);
  });

  it('keeps the supervisor outcome-oriented and read-only', () => {
    const briefing = buildProjectSupervisorBriefing({ workItemId: 'task-a', contract, taskWorkMode: 'single-thread' });
    expect(briefing).toContain('常驻监督和结果裁决者，不是项目执行者');
    expect(briefing).toContain('不向任务端注入项目/工作项身份');
    expect(briefing).toContain('--task-file');
    expect(briefing).toContain('coverage=whole-item');
    expect(briefing).toContain('工作项合同内直接决定');
    expect(briefing).toContain('项目 AI 仍无法决定');
    expect(briefing).toContain('--task-work-mode multi-thread 开放并行');
    expect(briefing).toContain('用 single-thread 恢复串行');
  });

  it('does not interrupt progressing work at a decision or time window', () => {
    const result = evaluateProjectExecutionGuard({
      history: [],
      proposal: { action: '继续形成成果', changedFiles: ['src/a.ts'], workspaceVersion: 'v2', now: 120_000 },
      budget: contract.budget,
      startedAt: 0,
    });
    expect(result.decision).toBe('allow');
  });

  it('does not mention the removed baseline handshake in P9 briefings', () => {
    const briefing = buildProjectSupervisorBriefing({ workItemId: 'task-a', contract });
    expect(briefing).not.toMatch(/项目基线|baseline|selectedRoute|expectedPaths/iu);
  });
});
