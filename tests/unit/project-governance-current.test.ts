import { describe, expect, it } from 'vitest';
import {
  projectPlanningConfirmationError,
  type ProjectSupervisorContract,
} from '../../src/shared/project-manager';
import {
  buildProjectSupervisorBriefing,
  projectRepositoryBootstrapRequired,
  projectTaskInstructionDisclosureError,
  projectWorkItemOutcomeTitleError,
  projectWorkItemHistoricallyDelivered,
  renderProjectRepositoryBootstrapTask,
  renderProjectTaskBatch,
  type ProjectSupervisorAssignment,
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
  stageAcceptanceCoverage: [{
    stageCriterion: '阶段成果已验收',
    verificationCriterion: '按项目规范验证',
  }],
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

const supervisorAssignment: ProjectSupervisorAssignment = {
  projectGoal: '交付当前用户目标',
  stage: {
    id: 'stage-a', title: '阶段成果', outcome: '形成阶段成果', acceptance: ['阶段成果已验收'],
  },
  workItemId: 'task-a',
  title: '可验收成果',
  objective: contract.objective,
  description: '保留用户确认的成果语义',
  effectivePreconditions: ['项目环境已准备', '测试环境可用'],
  supervisorNotes: ['异常结果必须如实上报'],
  stopWhen: [...contract.stopWhen],
  validation: [...contract.validation],
  stageAcceptanceCoverage: [...(contract.stageAcceptanceCoverage || [])],
  taskWorkMode: 'single-thread',
};

describe('current project governance', () => {
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
    expect(briefing).toContain('[执行模式] 多线程');
    expect(briefing).toContain('本批成果使用主线程和必要的内部子线程或子代理并行处理');
    expect(briefing).not.toContain('允许范围：');
    expect(briefing).not.toMatch(/项目 ID|工作项|监督 AI|普通监督链|裁决|lane|budget/iu);
    expect(briefing).not.toContain('阶段成果已验收');
    expect(briefing).not.toContain('stageAcceptanceCoverage');
    expect(projectTaskInstructionDisclosureError('assignmentVersion=3')).toContain('内部编排身份或路由信息');
    expect(projectTaskInstructionDisclosureError('awaitingSupervisor=true')).toContain('内部编排身份或路由信息');
    expect(projectTaskInstructionDisclosureError('goalId=goal-1')).toContain('内部编排身份或路由信息');
    expect(projectTaskInstructionDisclosureError('executionProtocolVersion=4')).toContain('内部编排身份或路由信息');
    expect(projectTaskInstructionDisclosureError('surfaceId=terminal-1')).toContain('内部编排身份或路由信息');
    expect(projectTaskInstructionDisclosureError('形成用户可见的工程成果')).toBeNull();
  });

  it('requires a concise outcome title instead of an internal id or contract body', () => {
    expect(projectWorkItemOutcomeTitleError('', 'task-auth')).toContain('必须提供');
    expect(projectWorkItemOutcomeTitleError('task-auth', 'task-auth')).toContain('内部 task ID');
    expect(projectWorkItemOutcomeTitleError('修改 src/auth.ts；运行 npm test', 'task-auth')).toContain('2-24 个字符');
    expect(projectWorkItemOutcomeTitleError('认证闭环：修改登录入口', 'task-auth')).toContain('简短成果名称');
    expect(projectWorkItemOutcomeTitleError('交付认证业务闭环', 'task-auth')).toBeNull();
  });

  it('prepares the repository only before a new or restored project task has started', () => {
    expect(projectRepositoryBootstrapRequired(undefined)).toBe(false);
    expect(projectRepositoryBootstrapRequired({ repositoryBootstrapPending: true })).toBe(true);
    expect(projectRepositoryBootstrapRequired({ repositoryBootstrapPending: false })).toBe(false);

    const batch = {
      kind: 'task' as const,
      coverage: 'bounded-batch' as const,
      outcome: '形成当前可验收成果',
      completionDefinition: ['成果完成'],
      evidenceExpectations: [],
      unmetCompletionItems: [],
      knownFacts: [],
      constraints: [],
      nonGoals: [],
    };
    const initialOrRestoredBriefing = renderProjectTaskBatch(contract, batch, 'single-thread', {
      initializeRepository: true,
    });
    const laterBriefing = renderProjectTaskBatch(contract, batch);

    const independentBootstrap = renderProjectRepositoryBootstrapTask();

    expect(initialOrRestoredBriefing).toContain('[仓库基础治理｜仅新建或恢复后执行一次]');
    expect(independentBootstrap).toContain('这是独立的仓库前置任务');
    expect(independentBootstrap).toContain('不继续或重复任何历史业务任务');
    expect(initialOrRestoredBriefing).toContain('先检查项目根目录是否已有 AGENTS.md');
    expect(initialOrRestoredBriefing).toContain('若已存在，保持原文件不变');
    expect(initialOrRestoredBriefing).toContain('若不存在，基于仓库内可验证事实创建精简的基础 AGENTS.md');
    expect(initialOrRestoredBriefing).toContain('不要写当前任务、进度、日期、临时状态');
    expect(initialOrRestoredBriefing).toContain('若未处于任何 Git 工作树，在项目根执行 git init');
    expect(initialOrRestoredBriefing).toContain('不得创建嵌套仓库');
    expect(initialOrRestoredBriefing).toContain('只在仓库事实证明需要时创建或局部追加 .gitignore');
    expect(initialOrRestoredBriefing).toContain('git rev-parse --git-path info/exclude');
    expect(initialOrRestoredBriefing).toContain('不修改 Git 全局配置或全局忽略文件');
    expect(initialOrRestoredBriefing).toContain('不忽略已跟踪源码、正式配置、示例配置、AGENTS.md 或项目证据');
    expect(initialOrRestoredBriefing).toContain('项目后续出现新的稳定边界时再按需细化');
    expect(independentBootstrap).toContain('完成后如实报告 AGENTS.md、Git 仓库和忽略规则');
    expect(laterBriefing).not.toContain('[仓库基础治理');
  });

  it('recognizes a delivered work item after runtime recovery clears startedAt', () => {
    expect(projectWorkItemHistoricallyDelivered({ startedAt: 1, executionHistory: [] })).toBe(true);
    expect(projectWorkItemHistoricallyDelivered({
      startedAt: undefined,
      executionHistory: [{
        ts: 1,
        actionSignature: 'action', commandSignature: 'command', errorSignature: '',
        progressSignature: 'progress', workspaceVersion: 'workspace', consumedDecision: true,
      }],
    })).toBe(true);
    expect(projectWorkItemHistoricallyDelivered({
      startedAt: undefined,
      executionHistory: [{
        ts: 1,
        actionSignature: 'action', commandSignature: 'command', errorSignature: '',
        progressSignature: 'progress', workspaceVersion: 'workspace', consumedDecision: false,
      }],
    })).toBe(false);
  });

  it('keeps the supervisor outcome-oriented and read-only', () => {
    const briefing = buildProjectSupervisorBriefing(supervisorAssignment);
    expect(briefing).toContain('项目目标：交付当前用户目标');
    expect(briefing).toContain('阶段成果：形成阶段成果');
    expect(briefing).toContain('有效前置条件：项目环境已准备；测试环境可用');
    expect(briefing).toContain('验证要求：按项目规范验证');
    expect(briefing).toContain('阶段成果已验收 ← 按项目规范验证');
    expect(briefing).toContain('验收结果允许成功、失败或当前无法取得');
    expect(briefing).toContain('超出工作项时上报项目 AI');
    expect(briefing).toContain('项目 AI 必须先依据总计划、当前进度和既有授权决策');
    expect(briefing).toContain('只有仍无法决定');
    expect(briefing).not.toContain('--task-file');
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

  it('does not mention the removed baseline handshake in current briefings', () => {
    const briefing = buildProjectSupervisorBriefing(supervisorAssignment);
    expect(briefing).not.toMatch(/项目基线|baseline|selectedRoute|expectedPaths/iu);
  });
});
