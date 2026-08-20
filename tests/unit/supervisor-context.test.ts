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

describe('supervisor runtime context', () => {
  it('reports the capability-bound project identity, contract authority, and budget', () => {
    const session = createDefaultSupervisorSession();
    session.active = true;
    const projectLane = lane({
      projectManagerProjectId: 'project-a',
      projectWorkItemId: 'work-a',
      projectTaskStartupPending: true,
      autonomyPermissionsOverride: ['same-route-next', 'permission-confirm'],
    });

    const context = buildSupervisorRuntimeContext(session, projectLane, {
      taskState: 'unknown',
      project: {
        projectId: 'project-a',
        goalId: 'goal-a',
        workItemId: 'work-a',
        requirementsVersion: 3,
        authorizationVersion: 4,
        authority: {
          technicalChoices: true,
          lowRiskRetries: true,
          targetedTests: true,
          internalThreads: false,
          permissionConfirm: true,
          allowedCommandPrefixes: ['npm test'],
        },
        decisionsUsed: 2,
        maxDecisions: 12,
        attempts: 1,
        maxTaskRetries: 3,
        bindingCurrent: true,
      },
    });

    expect(context.role).toBe('project-supervisor');
    expect(context.identity).toMatchObject({
      supervisorSurfaceId: 'supervisor-a',
      targetSurfaceId: 'task-a',
      projectId: 'project-a',
      goalId: 'goal-a',
      workItemId: 'work-a',
      requirementsVersion: 3,
      authorizationVersion: 4,
    });
    expect(context.permissions.projectAuthority?.allowedCommandPrefixes).toEqual(['npm test']);
    expect(context.budget).toMatchObject({
      projectDecisionsUsed: 2,
      projectDecisionsRemaining: 10,
      projectAttempts: 1,
      projectRetriesRemaining: 2,
    });
    expect(context.commands.conditional.find((item) => (
      item.command.includes('task-terminal-start')
    ))?.available).toBe(true);
  });

  it('does not advertise continue, rework, or permission confirmation without grants', () => {
    const session = createDefaultSupervisorSession();
    session.active = true;
    session.autonomyPermissions = [];
    session.maxAutoDecisions = 5;
    const context = buildSupervisorRuntimeContext(session, lane({ autoDecisionsUsed: 2, awaitingReview: true }), {
      taskState: 'idle',
    });

    expect(context.role).toBe('supervisor');
    expect(context.commands.decisionOutcomes).toEqual(['complete', 'needs-human']);
    expect(context.commands.conditional.find((item) => (
      item.command.includes('--permission-command')
    ))?.available).toBe(false);
    expect(context.budget.autoDecisionsRemaining).toBe(3);
  });

  it('includes the active review id in every advertised decision command', () => {
    const session = createDefaultSupervisorSession();
    session.active = true;
    const context = buildSupervisorRuntimeContext(session, lane({
      awaitingReview: true,
      activeReviewId: 'review-current',
    }), { taskState: 'idle', permissionBlocked: true });

    expect(context.identity.reviewId).toBe('review-current');
    expect(context.commands.available.find((command) => command.includes('supervisor decide')))
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
    expect(context.commands.available).toContain('wmux supervisor context');
  });

  it('does not advertise project permission confirmation when the contract denies it', () => {
    const session = createDefaultSupervisorSession();
    session.active = true;
    const context = buildSupervisorRuntimeContext(session, lane({
      projectManagerProjectId: 'project-a',
      projectWorkItemId: 'work-a',
      autonomyPermissionsOverride: ['permission-confirm'],
    }), {
      taskState: 'blocked',
      project: {
        projectId: 'project-a',
        workItemId: 'work-a',
        authority: {
          technicalChoices: true,
          lowRiskRetries: true,
          targetedTests: false,
          internalThreads: false,
          permissionConfirm: false,
        },
        bindingCurrent: true,
      },
    });

    expect(context.commands.conditional.find((item) => (
      item.command.includes('--permission-command')
    ))?.available).toBe(false);
  });

  it('advertises permission confirmation only for a real permission-blocked state', () => {
    const session = createDefaultSupervisorSession();
    session.active = true;
    session.autonomyPermissions = ['permission-confirm'];
    const context = buildSupervisorRuntimeContext(
      session,
      lane({ awaitingReview: true }),
      { taskState: 'blocked', permissionBlocked: true },
    );

    expect(context.commands.conditional.find((item) => (
      item.command.includes('--permission-command')
    ))?.available).toBe(true);
  });

  it('renders a compact capability card with the live context command', () => {
    const session = createDefaultSupervisorSession();
    session.active = true;
    const context = buildSupervisorRuntimeContext(session, lane({ awaitingReview: true }), { taskState: 'idle' });
    const card = buildSupervisorCapabilityCard(context).join('\n');

    expect(card).toContain('监督身份与能力快照');
    expect(card).toContain('唯一任务终端: task-a');
    expect(card).toContain('wmux supervisor context');
    expect(card).toContain('不授予直接实现、测试、跨终端输入');
  });

  it('does not advertise decisions when the session, review, approval, or project binding blocks them', () => {
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
