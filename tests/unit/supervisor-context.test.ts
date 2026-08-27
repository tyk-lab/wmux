import { describe, expect, it } from 'vitest';
import {
  createDefaultSupervisorSession,
  type SupervisorLane,
} from '../../src/renderer/store/supervisor-slice';
import {
  buildSupervisorCapabilityCard,
  buildSupervisorRuntimeContext,
} from '../../src/renderer/supervisor/supervisor-context';

function lane(partial: Partial<SupervisorLane> = {}): SupervisorLane {
  return {
    id: 'lane-a',
    label: '任务 A',
    surfaceId: 'task-a' as any,
    supervisorSurfaceId: 'supervisor-a' as any,
    controlState: 'active',
    awaitingStopCheck: false,
    stopConfirmed: false,
    ...partial,
  };
}

describe('supervisor runtime context', () => {  it('keeps project decisions available at a renewable health-window boundary', () => {
    const session = createDefaultSupervisorSession();
    session.active = true;
    const context = buildSupervisorRuntimeContext(session, lane({
      awaitingReview: true,
      projectManagerProjectId: 'project-a',
      projectWorkItemId: 'work-a',
      autonomyPermissionsOverride: ['same-route-next'],
    }), {
      taskState: 'idle',
      project: {
        projectId: 'project-a', goalId: 'goal-a', workItemId: 'work-a',
        requirementsVersion: 1, authorizationVersion: 1,
        attempts: 0, maxTaskRetries: 3,
        bindingCurrent: true,
      },
    });

    expect(context.commands.decisionOutcomes).toEqual(['continue', 'rework', 'complete', 'needs-human']);
  });

  it('returns the canonical project assignment after a supervisor runtime refresh', () => {
    const session = createDefaultSupervisorSession();
    session.active = true;
    const context = buildSupervisorRuntimeContext(session, lane({
      projectManagerProjectId: 'project-a',
      projectWorkItemId: 'work-a',
    }), {
      taskState: 'idle',
      project: {
        projectId: 'project-a', goalId: 'goal-a', workItemId: 'work-a', bindingCurrent: true,
        assignment: {
          projectGoal: '交付用户目标',
          stage: {
            id: 'stage-a', title: '验收阶段', outcome: '形成可验收成果',
            acceptance: ['真实交互可验证'],
          },
          workItemId: 'work-a', title: '交互成果', objective: '形成交互成果',
          description: '覆盖正常与异常路径',
          effectivePreconditions: ['测试环境可用', '真实设备操作需用户授权'],
          supervisorNotes: ['验证失败也要如实上报'],
          stopWhen: ['成果形成'], validation: ['真实交互已验证'],
          stageAcceptanceCoverage: [{
            stageCriterion: '真实交互可验证', verificationCriterion: '真实交互已验证',
          }],
          taskWorkMode: 'single-thread',
        },
      },
    });

    expect(context.assignment).toMatchObject({
      projectGoal: '交付用户目标',
      workItemTitle: '交互成果',
      taskDescription: '覆盖正常与异常路径',
      effectivePreconditions: ['测试环境可用', '真实设备操作需用户授权'],
      stopWhenItems: ['成果形成'],
      validation: ['真实交互已验证'],
      stageAcceptanceCoverage: [{
        stageCriterion: '真实交互可验证', verificationCriterion: '真实交互已验证',
      }],
    });
  });

  it('includes the active review id in every advertised decision command', () => {
    const session = createDefaultSupervisorSession();
    session.active = true;
    const context = buildSupervisorRuntimeContext(session, lane({
      awaitingReview: true,
      activeReviewId: 'review-current',
    }), { taskState: 'idle', permissionBlocked: true });

    expect(context.identity.reviewId).toBe('review-current');
    expect(context.commands.available.find((command) => command.includes('supervisor decide') && command.includes('--outcome')))
      .toContain('--review-id review-current');
    expect(context.commands.conditional
      .filter((item) => item.command.includes('supervisor decide'))
      .every((item) => item.command.includes('--review-id review-current'))).toBe(true);
    expect(buildSupervisorCapabilityCard(context).join('\n')).toContain('当前复核 ID: review-current');
  });

  it('removes decision commands while the lane is paused', () => {
    const session = createDefaultSupervisorSession();
    session.active = true;
    const context = buildSupervisorRuntimeContext(session, lane({ controlState: 'paused' }), {
      taskState: 'idle',
    });

    expect(context.state.lane).toBe('paused');
    expect(context.commands.decisionOutcomes).toEqual([]);
    expect(context.commands.available).not.toContain(
      'wmux supervisor decide --surface task-a --outcome <结果>',
    );
    expect(context.commands.available).not.toContain('wmux supervisor context');
    expect(context.commands.available).toContain(
      'wmux supervisor evidence --review-id <本轮ID> --file（优先）',
    );
  });it('renders a compact capability card with the live context command', () => {
    const session = createDefaultSupervisorSession();
    session.active = true;
    const context = buildSupervisorRuntimeContext(session, lane({ awaitingReview: true }), { taskState: 'idle' });
    const card = buildSupervisorCapabilityCard(context).join('\n');

    expect(card).toContain('监督身份与能力快照');
    expect(card).toContain('唯一任务终端: task-a');
    expect(card).not.toContain('wmux supervisor context');
    expect(card).toContain('普通监督职责');
    expect(card).toContain('--task-file');
    expect(card).toContain('不向任务 AI 注入 wmux 角色协议');
    expect(card).toContain('不授予直接实现、测试、跨终端输入');
  });

  it('keeps an unassigned project supervisor in a valid idle context', () => {
    const session = createDefaultSupervisorSession();
    session.active = true;
    const context = buildSupervisorRuntimeContext(session, lane({
      projectManagerProjectId: 'project-a',
      autonomousOverride: true,
      autonomyPermissionsOverride: ['same-route-next'],
    }), {
      taskState: 'idle',
      project: { projectId: 'project-a', projectStatus: 'active' },
    });

    expect(context.role).toBe('project-supervisor');
    expect(context.identity.projectId).toBe('project-a');
    expect(context.identity).not.toHaveProperty('workItemId');
    expect(context.state.decisionBlockers).not.toContain('项目、目标、工作项或合同版本绑定已失效');
    expect(context.commands.decisionOutcomes).toEqual([]);
  });  it('does not advertise decisions when the session, review, approval, or project binding blocks them', () => {
    const inactive = createDefaultSupervisorSession();
    const inactiveContext = buildSupervisorRuntimeContext(inactive, lane({ awaitingReview: true }), {
      taskState: 'idle',
    });
    expect(inactiveContext.commands.decisionOutcomes).toEqual([]);
    expect(inactiveContext.state.decisionBlockers).toContain('监督会话未启动');

    const pending = createDefaultSupervisorSession();
    pending.active = true;
    pending.pendingApprovals = [{ id: 'approval-a', laneId: 'lane-a' }] as any;
    const pendingContext = buildSupervisorRuntimeContext(pending, lane({ awaitingReview: true }), {
      taskState: 'idle',
    });
    expect(pendingContext.commands.decisionOutcomes).toEqual([]);
    expect(pendingContext.state.decisionBlockers).toContain('当前通道已有待决审批');
  });
});
