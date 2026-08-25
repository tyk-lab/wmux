import { describe, expect, it } from 'vitest';
import {
  CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
  type ProjectSupervisorContract,
  type ProjectWorkItem,
} from '../../src/shared/project-manager';
import {
  buildProjectSupervisorBriefing,
  buildProjectTaskExecutionEnvelope,
  projectTaskBaselineViolation,
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
    maxDecisions: 1,
    maxContinuousMinutes: 1,
    maxAggregateWorkerMinutes: 60,
    maxIdenticalFailures: 2,
    maxNoProgressRounds: 2,
    maxTaskRetries: 2,
    maxSameTestRuns: 2,
    maxFullSuiteRunsPerVersion: 1,
  },
};

describe('project governance P7', () => {
  it('makes the task AI the sole project executor', () => {
    const briefing = buildProjectTaskExecutionEnvelope(contract);
    expect(briefing).toContain('唯一执行者');
    expect(briefing).toContain('具体技术路线、文件、命令、技能、测试与内部拆分由你自行决定');
    expect(briefing).not.toContain('允许范围：');
  });

  it('keeps the supervisor outcome-oriented and read-only', () => {
    const briefing = buildProjectSupervisorBriefing({ workItemId: 'task-a', contract });
    expect(briefing).toContain('专属监督和编排者，不是项目执行者');
    expect(briefing).toContain('不得指定必须修改的文件');
  });

  it('does not interrupt progressing work at a decision or time window', () => {
    const result = evaluateProjectExecutionGuard({
      history: [],
      proposal: { action: '继续形成成果', changedFiles: ['src/a.ts'], workspaceVersion: 'v2', now: 120_000 },
      budget: contract.budget,
      decisionsUsed: contract.budget.maxDecisions,
      startedAt: 0,
    });
    expect(result.decision).toBe('allow');
  });

  it('does not require the legacy baseline handshake for P7 work', () => {
    const item = {
      executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
      requirementsVersion: 1,
      baseline: { status: 'required' as const, requirementsVersion: 1 },
    } satisfies Pick<ProjectWorkItem, 'executionProtocolVersion' | 'requirementsVersion' | 'baseline'>;
    expect(projectTaskBaselineViolation(item, { outcome: 'continue', instruction: '形成下一阶段成果' }))
      .toBeNull();
  });
});
