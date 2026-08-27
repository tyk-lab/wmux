import { describe, expect, it } from 'vitest';
import {
  classifyProjectWatchdogScenario,
  projectWatchdogMayInterveneForRole,
} from '../../src/renderer/project-manager/watchdog-policy';
import {
  CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
  type ProjectManagerSession,
} from '../../src/shared/project-manager';

function session(overrides: Partial<ProjectManagerSession> = {}): ProjectManagerSession {
  return {
    id: 'project-watchdog',
    projectDir: 'E:\\repo',
    goal: '完成项目',
    preconditions: [],
    planFiles: [],
    doneWhen: ['结果可验收'],
    executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
    status: 'active',
    workItems: [],
    events: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('project manager watchdog policy', () => {
  it.each([
    ['completed', session({ status: 'completed' }), 'terminal'],
    ['paused', session({ status: 'paused' }), 'explicit-pause'],
    ['safe exit', session({
      safeExit: {
        status: 'saved', requestedAt: 1, updatedAt: 2, reason: '用户要求安全退出', terminalCheckpoints: [],
      },
    }), 'safe-exit'],
    ['runtime choice', session({
      status: 'waiting',
      agentIssue: {
        kind: 'provider-limit', role: 'manager', detail: '等待用户选择运行时', createdAt: 1,
      },
    }), 'runtime-choice'],
    ['passive wait', session({ status: 'waiting' }), 'passive-wait'],
  ] as const)('keeps %s outside automatic recovery', (_label, project, scenario) => {
    expect(classifyProjectWatchdogScenario(project)).toEqual(expect.objectContaining({
      scenario,
      recoverManagerRuntime: false,
      inspectDeadlock: false,
    }));
  });

  it('keeps a pending user question under user ownership', () => {
    expect(classifyProjectWatchdogScenario(session({
      status: 'waiting',
      pendingUserQuestion: {
        id: 'manual-verification-feedback',
        reasonCode: 'manual-verification-feedback',
        question: '请完成人工验收并反馈结果',
        context: '等待用户实际操作',
        options: [{ id: 'complete', label: '验收完成', description: '提交实际结果' }],
        previousStatus: 'active',
        createdAt: 1,
      },
    }))).toMatchObject({
      scenario: 'user-wait',
      owner: 'user',
      recoverManagerRuntime: false,
      inspectDeadlock: false,
    });
  });

  it.each([
    ['task-ai', 'task-execution'],
    ['supervisor-ai', 'supervisor-execution'],
  ] as const)('observes %s execution without rebuilding the manager', (owner, scenario) => {
    expect(classifyProjectWatchdogScenario(session({
      executionResponsibility: {
        id: owner,
        owner,
        action: 'continue-execution',
        state: 'working',
        assignedAt: 1,
        lastProgressAt: 1,
        attempt: 0,
        incidentKey: owner,
      },
    }))).toMatchObject({ scenario, recoverManagerRuntime: false, inspectDeadlock: false });
  });

  it('recovers a missing manager only for project-owned obligations', () => {
    expect(classifyProjectWatchdogScenario(session({
      executionResponsibility: {
        id: 'project-ai',
        owner: 'project-ai',
        action: 'resolve-decision',
        state: 'awaiting-result',
        assignedAt: 1,
        lastProgressAt: 1,
        deadlineAt: 2,
        attempt: 0,
        incidentKey: 'project-ai',
      },
    }))).toMatchObject({
      scenario: 'project-ai-obligation',
      recoverManagerRuntime: true,
      inspectDeadlock: true,
    });
  });

  it('rebuilds a missing manager for durable delivery but does not duplicate deadlock recovery', () => {
    expect(classifyProjectWatchdogScenario(session(), { hasPendingManagerDelivery: true })).toMatchObject({
      scenario: 'manager-delivery',
      recoverManagerRuntime: true,
      inspectDeadlock: false,
    });
  });

  it.each([
    ['user-wait', 'manager', false],
    ['project-ai-obligation', 'manager', true],
    ['project-ai-obligation', 'task', false],
    ['supervisor-execution', 'supervisor', true],
    ['supervisor-execution', 'manager', false],
    ['task-execution', 'task', true],
    ['task-execution', 'supervisor', false],
  ] as const)('allows only the owner role in %s', (scenario, role, expected) => {
    expect(projectWatchdogMayInterveneForRole({
      scenario,
      recoverManagerRuntime: scenario === 'project-ai-obligation',
      inspectDeadlock: scenario === 'project-ai-obligation',
    }, role)).toBe(expected);
  });
});
