import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
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

  it('renders the clear planning and execution hierarchy only for ordinary supervision', () => {
    expect(panelSource).toContain('className="sup-panel__summary"');
    expect(panelSource).toContain('<span>下一步规划</span>');
    expect(panelSource).toContain('<span>任务执行</span>');
    expect(panelSource).toContain('className="sup-panel__session-config"');
    expect(panelSource).toContain('className="sup-panel__lane-config"');
    expect(panelSource).toContain('const visibleChannelCount = scopedProjectId ? enabled.length : visibleBoundLanes.length;');
    expect(panelSource).toContain('{visibleChannelCount} 通道');
    expect(panelSource).toMatch(/\{!laneProjectManaged && \(\s*<>\s*<div className="sup-panel__lane-status-grid"/);
  });

  it('shows only each project supervisor lane and its own execution plan', () => {
    expect(panelSource).toContain('const scopedProjectWorkItems');
    expect(panelSource).toContain('className="sup-panel__project-plan"');
    expect(panelSource).toContain('监督 AI 执行规划');
    expect(panelSource).toContain('visibleLanes.map((lane)');
    expect(panelSource).toContain('scopedProjectWorkItems.find((candidate) => candidate.id === lane.projectWorkItemId)');
    expect(panelSource).toContain('item.workerSurfaceId');
    expect(panelSource).toContain('item.supervisorPlan?.milestones');
    expect(panelSource).toContain('item.supervisorPlan.selectedRoute');
    expect(panelSource).toContain('item.supervisorPlan.remainingWork');
    expect(panelSource).toContain('item.supervisorPlan.targetedValidation');
    expect(panelSource).toContain('item.supervisorPlan.serializedBoundaries');
    expect(panelSource).toContain('item.latestBlocker');
    expect(panelSource).toContain('item.latestEvidence');
    expect(panelSource).toContain("? '已结束'");
    expect(panelSource).toContain(": '已停止';");
    expect(panelSource).toContain('工作项已完成，执行证据已归档');
    expect(panelSource).toContain('打开项目管理');
    expect(panelSource).toContain('{!scopedProjectId && visibleLogs.length > 0 && (');
  });

  it('shows the current route and recent planning trail for ordinary supervision', () => {
    expect(panelSource).toContain('SUPERVISOR_DECISION_OUTCOME_LABELS');
    expect(panelSource).toContain('SUPERVISOR_PROPOSAL_KIND_LABELS');
    expect(panelSource).toContain('className="sup-panel__ordinary-plan"');
    expect(panelSource).toContain('当前路线 / 方案');
    expect(panelSource).toContain('下一步安排');
    expect(panelSource).toContain('监督决策链');
    expect(panelSource).toContain('负责任务：');
    expect(panelSource).toContain('决策依据：');
    expect(panelSource).toContain('→ 指示任务 AI');
    expect(panelSource).toContain('(lane.decisions || []).length > 0');
    expect(panelSource).toContain('.slice(0, 6)');
    expect(panelSource).toContain('等待首次规划');
    expect(panelSource).toContain('监督 AI 提交首次正式裁决后');
    expect(supervisorCssSource).toContain('.sup-panel__ordinary-plan-grid');
    expect(supervisorCssSource).toContain('.sup-panel__ordinary-plan-history');
    expect(supervisorCssSource).toContain('max-height: 280px');
  });
});
