import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSupervisorPlanView,
  compactProjectAlertSummary,
  isProjectSupervisorAssignmentPending,
  summarizeProjectManagedStatus,
  summarizeProjectSubgoalStatus,
  summarizeSupervisorPlan,
  summarizeTaskExecution,
} from '../../src/renderer/supervisor/status-summary';

const panelSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/Sidebar/SupervisorPanel.tsx'),
  'utf8',
);
const supervisorCssSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/styles/supervisor.css'),
  'utf8',
);

describe('supervisor status summary', () => {
  it('shows the latest supervisor decision as the next-step plan', () => {
    const summary = summarizeSupervisorPlan({
      latestDecision: {
        ts: 1,
        task: '实现功能',
        outcome: 'continue',
        reason: '核心实现已完成',
        next: '补充失败分支测试并运行针对性验证',
      },
    });

    expect(summary).toMatchObject({
      label: '按当前路线继续',
      detail: '补充失败分支测试并运行针对性验证',
    });
    expect(summary.title).toContain('核心实现已完成');
  });

  it('falls back from a plan file to the current task', () => {
    expect(summarizeSupervisorPlan({ planFileName: 'PLAN.md', currentTask: '实现功能' })).toMatchObject({
      label: '按计划文件推进', detail: 'PLAN.md',
    });
    expect(summarizeSupervisorPlan({ currentTask: '实现功能' })).toMatchObject({
      label: '执行当前任务', detail: '实现功能',
    });
  });

  it('shows an evidence-backed context correction as a distinct supervisor state', () => {
    expect(summarizeSupervisorPlan({
      latestDecision: {
        ts: 2, task: '继续任务', outcome: 'rework', reason: '上下文退化', next: '重新核对规划',
        contextHealth: 'degraded', contextSymptoms: ['forgotten-plan'],
        contextSignal: '任务 AI 遗忘了用户规划',
      },
    })).toMatchObject({ label: '上下文纠偏中', detail: '重新核对规划' });
    expect(panelSource).toContain('正在清空任务 AI 上下文');
    expect(panelSource).toContain('已发现任务 AI 上下文退化迹象');
  });

  it('prefers the live task Agent state and falls back to the lane state', () => {
    const active = { controlState: 'active' as const, currentTask: '实现功能' };
    expect(summarizeTaskExecution(active, { state: 'working' })).toMatchObject({
      label: '执行中', detail: '实现功能',
    });
    expect(summarizeTaskExecution(active, {
      state: 'blocked',
      blockedReason: '等待选择目标接口',
    })).toMatchObject({
      label: '已阻塞', detail: '等待选择目标接口',
    });
    expect(summarizeTaskExecution({ ...active, awaitingReview: true }, {
      state: 'blocked',
      blockedReason: 'Waiting for your next prompt',
    })).toMatchObject({
      label: '等待监督复核', detail: '任务回合已结束，监督 AI 正在复核',
    });
    expect(summarizeTaskExecution({ controlState: 'paused' }, { state: 'unknown' }).label).toBe('已暂停');
  });

  it('does not let a stale live Agent state override a terminal lane state', () => {
    expect(summarizeTaskExecution({ controlState: 'waiting' }, { state: 'working' })).toMatchObject({
      label: '等待下一步', detail: '当前任务已结束，等待新的方向',
    });
    expect(summarizeTaskExecution({ controlState: 'stopped' }, {
      state: 'blocked', blockedReason: '旧的阻塞原因',
    })).toMatchObject({
      label: '已停止', detail: '监督通道已结束',
    });
    expect(summarizeTaskExecution({ controlState: 'active', stopConfirmed: true }, { state: 'working' }).label)
      .toBe('等待下一步');
  });

  it('uses one milestone as direct execution without mechanical task splitting', () => {
    const view = buildSupervisorPlanView({
      source: 'user',
      task: '修复配置缺失崩溃',
      ordinaryPlan: {
        sourceRevision: 1,
        revision: 1,
        objective: '完成聚焦修复并运行定向测试',
        milestones: [{
          id: 'fix_and_test', title: '修复并验证', outcome: '形成修复和测试证据', acceptance: ['定向测试通过'], status: 'active',
        }],
        remainingWork: ['完成修复'], updatedAt: 1,
      },
    });

    expect(view).toMatchObject({
      sourceLabel: '用户任务', mode: 'direct', modeLabel: '直接监督执行',
      route: '完成聚焦修复并运行定向测试', completedSteps: 0,
    });
    expect(view.steps).toHaveLength(1);
  });

  it('renders an ordinary outcome plan without an implementation route', () => {
    const view = buildSupervisorPlanView({
      source: 'user',
      task: '完成认证修复',
      ordinaryPlan: {
        sourceRevision: 2,
        revision: 3,
        objective: '认证行为满足用户规划',
        milestones: [{
          id: 'acceptance', title: '完成验收', outcome: '认证行为可验证',
          acceptance: ['认证测试通过'], status: 'active',
        }],
        remainingWork: ['完成认证验收'],
        updatedAt: 1,
      },
    });

    expect(view).toMatchObject({
      sourceLabel: '用户任务',
      route: '认证行为满足用户规划',
      nextInstruction: '认证行为可验证',
    });
  });

  it('shows project work from the latest supervisor decision without a legacy stage plan', () => {
    const view = buildSupervisorPlanView({
      source: 'project-ai',
      task: '建立控制台程序基础',
      latestDecision: {
        ts: 2, task: '建立控制台程序基础', outcome: 'continue', reason: '骨架已完成',
        next: '补齐启动流程并报告结果',
      },
    });

    expect(view).toMatchObject({
      sourceLabel: '项目 AI 工作项', mode: 'forming', modeLabel: '形成正式路线中',
      route: '骨架已完成', nextInstruction: '补齐启动流程并报告结果', completedSteps: 0,
    });
    expect(view.steps).toHaveLength(1);
  });

  it('uses the structured project batch instead of repeating the rendered task prompt', () => {
    const renderedPrompt = '[成果任务]\n\n成果方向：形成 Windows GUI。\n\n完成定义：\n- 程序可运行';
    const view = buildSupervisorPlanView({
      source: 'project-ai',
      task: '建立 GUI 基础',
      projectTaskBatch: {
        kind: 'task',
        coverage: 'whole-item',
        outcome: '形成可构建并启动的 Windows GUI 基础程序',
        completionDefinition: ['程序可构建并运行'],
        evidenceExpectations: ['返回构建与启动证据'],
        unmetCompletionItems: [],
        knownFacts: [],
        constraints: ['使用现有项目依赖'],
        nonGoals: ['不扩展完整业务功能'],
      },
      latestDecision: {
        ts: 5,
        task: '建立 GUI 基础',
        outcome: 'continue',
        reason: '',
        next: renderedPrompt,
      },
    });

    expect(view).toMatchObject({
      sourceLabel: '项目 AI 工作项',
      mode: 'direct',
      modeLabel: '单成果批次执行',
      route: '建立 GUI 基础',
      nextInstruction: '形成可构建并启动的 Windows GUI 基础程序',
      steps: [],
    });
    expect(JSON.stringify(view)).not.toContain(renderedPrompt);
  });

  it('does not let a retained project batch hide a newer human decision', () => {
    const view = buildSupervisorPlanView({
      source: 'project-ai',
      task: '建立 GUI 基础',
      projectTaskBatch: {
        kind: 'task',
        coverage: 'whole-item',
        outcome: '旧的执行批次',
        completionDefinition: ['程序可运行'],
        evidenceExpectations: [],
        unmetCompletionItems: [],
        knownFacts: [],
        constraints: [],
        nonGoals: [],
      },
      latestDecision: {
        ts: 6,
        task: '建立 GUI 基础',
        outcome: 'needs-human',
        proposalKind: 'clarification',
        reason: '需要用户选择目标界面风格',
        next: '',
      },
    });

    expect(view).toMatchObject({
      mode: 'forming',
      modeLabel: '等待需求对齐',
      route: '需要用户选择目标界面风格',
      nextInstruction: '等待用户集中答复后形成正式计划',
      steps: [],
    });
  });

  it('uses a pending project transition instead of a stale lane decision', () => {
    const view = buildSupervisorPlanView({
      source: 'project-ai',
      task: '实现用户管理操作',
      projectTaskBatch: {
        kind: 'rework', coverage: 'bounded-batch', outcome: '旧的返工批次',
        completionDefinition: [], evidenceExpectations: [], unmetCompletionItems: [],
        knownFacts: [], constraints: [], nonGoals: [],
      },
      latestDecision: {
        ts: 5, task: '实现用户管理操作', outcome: 'rework', reason: '旧裁决', next: '继续返工',
      },
      pendingTransition: {
        kind: 'decision-required',
        summary: '缺少可信的 GUI 交互验收证据',
      },
    });

    expect(view).toMatchObject({
      mode: 'forming',
      modeLabel: '等待项目 AI 处理',
      route: '缺少可信的 GUI 交互验收证据',
      nextInstruction: '项目 AI 正在处理监督交接，尚未下发新的执行批次',
    });
    expect(JSON.stringify(view)).not.toContain('旧裁决');
  });

  it('keeps waiting-decision visible after the transition has been dequeued', () => {
    const view = buildSupervisorPlanView({
      source: 'project-ai',
      task: '实现用户管理操作',
      workItemStatus: 'waiting-decision',
      latestBlocker: '缺少可信的 GUI 交互验收证据',
      latestDecision: {
        ts: 4, task: '实现用户管理操作', outcome: 'rework', reason: '旧裁决', next: '继续返工',
      },
    });

    expect(view).toMatchObject({
      modeLabel: '等待项目 AI 处理',
      route: '缺少可信的 GUI 交互验收证据',
      nextInstruction: '项目 AI 尚未下发新的执行批次',
    });
    expect(JSON.stringify(view)).not.toContain('旧裁决');
  });

  it('separates project work-item lifecycle from supervisor channel activity', () => {
    expect(summarizeProjectManagedStatus({
      workItemStatus: 'waiting-decision',
      laneControlState: 'active',
      pendingTransition: { kind: 'decision-required', summary: '需要项目 AI 选择验证路线' },
    })).toMatchObject({
      workItemLabel: '等待项目 AI 处理',
      supervisorLabel: '决策问题已交接',
      attention: true,
    });
    expect(summarizeProjectManagedStatus({
      workItemStatus: 'running',
      laneControlState: 'active',
    })).toMatchObject({
      workItemLabel: '任务执行中',
      supervisorLabel: '监督已连接',
      attention: false,
    });
    expect(summarizeProjectManagedStatus({
      workItemStatus: 'waiting-decision',
      laneControlState: 'paused',
      latestBlocker: '监督协议错误，通道已暂停',
    })).toMatchObject({
      workItemLabel: '已暂停 · 等待项目 AI 处理',
      supervisorLabel: '监督已暂停',
      detail: '监督协议错误，通道已暂停',
      attention: true,
    });
  });

  it('treats a newly assigned work item as waiting for supervisor instead of project AI', () => {
    const supervisorAssignmentPending = isProjectSupervisorAssignmentPending({
      workItemStatus: 'waiting-decision',
      workItemLaneId: 'lane-a',
      workItemAssignmentVersion: 6,
      laneId: 'lane-a',
      laneAssignmentVersion: 6,
      laneControlState: 'active',
      laneAwaitingReview: true,
      latestBlocker: '等待专属监督首次派发中性成果包',
    });

    expect(supervisorAssignmentPending).toBe(true);
    expect(summarizeProjectManagedStatus({
      workItemStatus: 'waiting-decision',
      laneControlState: 'active',
      latestBlocker: '等待专属监督首次派发中性成果包',
      supervisorAssignmentPending,
    })).toMatchObject({
      workItemLabel: '等待监督 AI 处理',
      supervisorLabel: '任务已交接',
      attention: false,
    });
    expect(buildSupervisorPlanView({
      source: 'project-ai',
      task: '恢复用户管理任务',
      workItemStatus: 'waiting-decision',
      latestBlocker: '等待专属监督首次派发中性成果包',
      supervisorAssignmentPending,
    })).toMatchObject({
      modeLabel: '等待监督 AI 处理',
      nextInstruction: expect.stringContaining('专属监督确认后'),
    });
  });

  it('does not surface a cleared planned item as a stale paused-lane warning', () => {
    expect(summarizeProjectManagedStatus({
      workItemStatus: 'planned',
      laneControlState: 'paused',
    })).toMatchObject({
      workItemLabel: '等待派发',
      supervisorLabel: '监督待分配',
      attention: false,
    });
  });

  it('shows stage closure drift instead of reporting completed work as planning', () => {
    expect(summarizeProjectSubgoalStatus({
      status: 'planned',
      workItemStatuses: ['completed'],
    })).toMatchObject({ label: '待阶段闭合', attention: true });
    expect(summarizeProjectSubgoalStatus({
      status: 'planned',
      workItemStatuses: ['waiting-decision'],
    })).toMatchObject({ label: '工作项待处理', attention: true });
    expect(summarizeProjectSubgoalStatus({
      status: 'achieved',
      workItemStatuses: ['completed'],
    })).toMatchObject({ label: '已达成', attention: false });
    expect(summarizeProjectSubgoalStatus({
      status: 'blocked',
      workItemStatuses: ['completed'],
    })).toMatchObject({ label: '阻塞中', attention: true });
    expect(summarizeProjectSubgoalStatus({
      status: 'planned',
      workItemStatuses: ['paused'],
    })).toMatchObject({ label: '工作项已暂停', attention: true });
  });

  it('keeps long runtime alerts readable while preserving a useful summary', () => {
    const detail = `项目认知基线尚未确认。${'必须先读取状态与协议字段。'.repeat(30)}`;
    const summary = compactProjectAlertSummary(detail);

    expect(summary.length).toBeLessThanOrEqual(181);
    expect(summary).toContain('项目认知基线尚未确认');
    expect(summary.endsWith('…')).toBe(true);
  });

  it('shows the latest supervisor decision while a formal route is still forming', () => {
    expect(buildSupervisorPlanView({
      source: 'user',
      task: '调查问题',
      latestDecision: {
        ts: 3, task: '调查问题', outcome: 'continue', reason: '先核对当前实现', next: '只读检查入口和测试约定',
      },
    })).toMatchObject({
      mode: 'forming', modeLabel: '形成正式路线中', route: '先核对当前实现',
      nextInstruction: '只读检查入口和测试约定',
    });
  });

  it('shows material ambiguity as waiting for batched user alignment', () => {
    expect(buildSupervisorPlanView({
      source: 'user',
      task: '做好登录功能',
      latestDecision: {
        ts: 4,
        task: '做好登录功能',
        outcome: 'needs-human',
        proposalKind: 'clarification',
        reason: '1. 修复现有登录还是新增登录？\n2. 是否包含失败分支测试？',
        next: '',
      },
    })).toMatchObject({
      mode: 'forming',
      modeLabel: '等待需求对齐',
      nextInstruction: '等待用户集中答复后形成正式计划',
      steps: [],
    });
  });

  it('renders the clear planning and execution hierarchy only for ordinary supervision', () => {
    expect(panelSource).toContain('className="sup-panel__summary"');
    expect(panelSource).toContain('上级任务 · {planView.sourceLabel}');
    expect(panelSource).toContain('<span>任务 AI 执行摘要</span>');
    expect(panelSource).toContain('className="sup-panel__session-config"');
    expect(panelSource).toContain('className="sup-panel__lane-config"');
    expect(panelSource).toContain('const visibleChannelCount = scopedProjectId ? enabled.length : visibleBoundLanes.length;');
    expect(panelSource).toContain('{visibleChannelCount} 通道');
    expect(panelSource).toMatch(/\{!laneProjectManaged && \(\s*<>\s*<div className="sup-panel__lane-status-grid"/);
  });

  it('shows one action-first project supervisor card without a duplicate route overview', () => {
    expect(panelSource).toContain('const scopedProjectWorkItems');
    expect(panelSource).toContain('className="sup-panel__project-scope-summary"');
    expect(panelSource).toContain('className="sup-panel__managed-compact-summary"');
    expect(panelSource).toContain('className="sup-panel__managed-status-line"');
    expect(panelSource).toContain('className="sup-panel__managed-summary-row"');
    expect(panelSource).toContain('className="sup-panel__managed-lane-details"');
    expect(panelSource).toContain('查看成果、监督与合同详情');
    expect(panelSource).toContain('className="sup-panel__managed-action-grid"');
    expect(panelSource).toContain("managedCompletion ? '当前结果' : '当前成果'");
    expect(panelSource).toContain('<span>任务 AI 状态</span>');
    expect(panelSource).toContain('<span>监督正在做</span>');
    expect(panelSource).toContain('<span>下一步</span>');
    expect(panelSource).toContain('projectTaskBatch: lane.projectTaskBatch');
    expect(panelSource).toContain('{executionStatus.label}');
    expect(panelSource).toContain('scopedProjectWorkItems.find((item) => item.id === lane.projectWorkItemId)');
    expect(panelSource).toContain('{planView.route}');
    expect(panelSource).not.toContain('item.supervisorPlan');
    expect(panelSource).toContain('className="sup-panel__managed-lane-attention"');
    expect(panelSource).toContain('className="sup-panel__managed-lane-decision"');
    expect(panelSource).toContain('className="sup-panel__managed-lane-audit"');
    expect(panelSource).toContain('查看合同、权限与运行标识');
    expect(panelSource).not.toContain('监督通道执行路线');
    expect(panelSource).not.toContain('className="sup-panel__project-plan"');
    expect(panelSource).toContain('打开项目管理');
    expect(panelSource).toContain('{!scopedProjectId && visibleLogs.length > 0 && (');
    expect(supervisorCssSource).toMatch(
      /\.sup-panel__managed-summary-row strong\s*\{[\s\S]*?-webkit-line-clamp:\s*2;/,
    );
    expect(supervisorCssSource).toMatch(
      /\.sup-panel__managed-lane-details-body\s*\{[\s\S]*?max-height:\s*min\(52vh, 520px\);[\s\S]*?overflow-y:\s*auto;/,
    );
  });

  it('shows the current route and recent planning trail for ordinary supervision', () => {
    expect(panelSource).toContain('SUPERVISOR_DECISION_OUTCOME_LABELS');
    expect(panelSource).toContain('className="sup-panel__ordinary-plan"');
    expect(panelSource).toContain('监督 AI 当前规划');
    expect(panelSource).toContain('当前路线');
    expect(panelSource).toContain('下一步给任务 AI');
    expect(panelSource).toContain("latestDecision?.outcome === 'complete'");
    expect(panelSource).toContain('completion.summary');
    expect(panelSource).toContain('completion.validation.join');
    expect(panelSource).toContain('laneDetailsCollapsed && completion');
    expect(panelSource).toContain('完成结果：{completion.summary}');
    expect(panelSource).toContain("planView.mode === 'staged'");
    expect(panelSource).toContain('具体任务不做机械拆分');
    expect(panelSource).toContain('监督决策链');
    expect(panelSource).toContain('负责任务：');
    expect(panelSource).toContain('决策依据：');
    expect(panelSource).toContain('→ 下发成果');
    expect(panelSource).toContain('目标旋涡纠偏');
    expect(panelSource).toContain('(lane.decisions || []).slice(0, 6)');
    expect(panelSource).toContain('.slice(0, 6)');
    expect(panelSource).toContain('等待监督 AI 首次正式裁决');
    expect(panelSource).toContain('首次 continue/rework 后');
    expect(supervisorCssSource).toContain('.sup-panel__ordinary-plan-grid');
    expect(supervisorCssSource).toContain('.sup-panel__ordinary-plan-history');
    expect(supervisorCssSource).toContain('max-height: 280px');
  });
});
