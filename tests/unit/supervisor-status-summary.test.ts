import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSupervisorPlanView,
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
      plan: {
        revision: 1,
        selectedRoute: '完成聚焦修复并运行定向测试',
        milestones: [{
          id: 'fix_and_test', title: '修复并验证', outcome: '形成修复和测试证据', status: 'active',
        }],
        expectedPaths: [], targetedValidation: [], serializedBoundaries: [],
        remainingWork: ['完成修复'], updatedAt: 1,
      },
    });

    expect(view).toMatchObject({
      sourceLabel: '用户任务', mode: 'direct', modeLabel: '直接监督执行',
      route: '完成聚焦修复并运行定向测试', completedSteps: 0,
    });
    expect(view.steps).toHaveLength(1);
  });

  it('uses multiple milestones as staged execution for a project AI work item', () => {
    const view = buildSupervisorPlanView({
      source: 'project-ai',
      task: '建立控制台程序基础',
      plan: {
        revision: 2,
        selectedRoute: '先建骨架，再补启动流程和验证',
        milestones: [
          { id: 'skeleton', title: '建立骨架', outcome: '工程可构建', status: 'completed' },
          { id: 'startup', title: '补启动流程', outcome: '程序可启动', status: 'active' },
          { id: 'verify', title: '定向验证', outcome: '形成验证证据', status: 'planned' },
        ],
        expectedPaths: [], targetedValidation: [], serializedBoundaries: [],
        remainingWork: ['完成启动流程', '执行验证'], updatedAt: 2,
      },
      latestDecision: {
        ts: 2, task: '建立控制台程序基础', outcome: 'continue', reason: '骨架已完成',
        next: '补齐启动流程并报告结果',
      },
    });

    expect(view).toMatchObject({
      sourceLabel: '项目 AI 工作项', mode: 'staged', modeLabel: '分阶段监督执行',
      nextInstruction: '补齐启动流程并报告结果', completedSteps: 1,
    });
    expect(view.steps).toHaveLength(3);
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
    expect(panelSource).toMatch(/\{!laneProjectManaged && lane\.goalConstruction\?\.status !== 'drafting' && \(\s*<>\s*<div className="sup-panel__lane-status-grid"/);
  });

  it('shows only each project supervisor lane and its own execution plan', () => {
    expect(panelSource).toContain('const scopedProjectWorkItems');
    expect(panelSource).toContain('className="sup-panel__project-plan"');
    expect(panelSource).toContain('监督通道执行路线');
    expect(panelSource).toContain('工作项由项目 AI 下发，具体路线由各监督 AI 维护');
    expect(panelSource).toContain('上级任务：{planView.sourceLabel}');
    expect(panelSource).toContain('监督 AI 当前规划');
    expect(panelSource).toContain('下一步给任务 AI');
    expect(panelSource).toContain('任务 AI 执行摘要：{taskExecution.label}');
    expect(panelSource).not.toContain('监督 AI 执行规划');
    expect(panelSource).toContain('visibleLanes.map((lane)');
    expect(panelSource).toContain('scopedProjectWorkItems.find((candidate) => candidate.id === lane.projectWorkItemId)');
    expect(panelSource).toContain('item.workerSurfaceId');
    expect(panelSource).toContain('planView.steps.map');
    expect(panelSource).toContain('{planView.route}');
    expect(panelSource).toContain('item.supervisorPlan.remainingWork');
    expect(panelSource).toContain('item.supervisorPlan.targetedValidation');
    expect(panelSource).toContain('item.supervisorPlan.serializedBoundaries');
    expect(panelSource).toContain('item.latestBlocker');
    expect(panelSource).toContain('item.latestEvidence');
    expect(panelSource).toContain("? '已结束'");
    expect(panelSource).toContain(": '已停止';");
    expect(panelSource).toContain('item.latestEvidence || item.latestContextSummary || taskExecution.detail');
    expect(panelSource).toContain('打开项目管理');
    expect(panelSource).toContain('{!scopedProjectId && visibleLogs.length > 0 && (');
  });

  it('shows the current route and recent planning trail for ordinary supervision', () => {
    expect(panelSource).toContain('SUPERVISOR_DECISION_OUTCOME_LABELS');
    expect(panelSource).toContain('className="sup-panel__ordinary-plan"');
    expect(panelSource).toContain('监督 AI 当前规划');
    expect(panelSource).toContain('当前路线');
    expect(panelSource).toContain('下一步给任务 AI');
    expect(panelSource).toContain("planView.mode === 'staged'");
    expect(panelSource).toContain('具体任务不做机械拆分');
    expect(panelSource).toContain('监督决策链');
    expect(panelSource).toContain('负责任务：');
    expect(panelSource).toContain('决策依据：');
    expect(panelSource).toContain('→ 指示任务 AI');
    expect(panelSource).toContain('(lane.decisions || []).slice(0, 6)');
    expect(panelSource).toContain('.slice(0, 6)');
    expect(panelSource).toContain('等待监督 AI 首次正式裁决');
    expect(panelSource).toContain('首次 continue/rework 后');
    expect(supervisorCssSource).toContain('.sup-panel__ordinary-plan-grid');
    expect(supervisorCssSource).toContain('.sup-panel__ordinary-plan-history');
    expect(supervisorCssSource).toContain('max-height: 280px');
  });
});
