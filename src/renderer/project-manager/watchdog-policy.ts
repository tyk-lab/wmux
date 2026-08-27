import {
  activeProjectGoal,
  type ProjectExecutionResponsibilityOwner,
  type ProjectManagerSession,
} from '../../shared/project-manager';

export type ProjectWatchdogScenario =
  | 'terminal'
  | 'user-wait'
  | 'explicit-pause'
  | 'safe-exit'
  | 'runtime-choice'
  | 'completed-goal-wait'
  | 'manager-delivery'
  | 'task-execution'
  | 'supervisor-execution'
  | 'project-ai-obligation'
  | 'control-plane-recovery'
  | 'passive-wait';

export interface ProjectWatchdogDisposition {
  scenario: ProjectWatchdogScenario;
  owner?: ProjectExecutionResponsibilityOwner;
  recoverManagerRuntime: boolean;
  inspectDeadlock: boolean;
}

export type ProjectWatchdogAgentRole = 'manager' | 'supervisor' | 'task';

/** Enforce the same single owner for per-Agent deadline watchdogs. */
export function projectWatchdogMayInterveneForRole(
  disposition: ProjectWatchdogDisposition,
  role: ProjectWatchdogAgentRole,
): boolean {
  if (disposition.scenario === 'manager-delivery'
    || disposition.scenario === 'project-ai-obligation'
    || disposition.scenario === 'control-plane-recovery') {
    return role === 'manager';
  }
  if (disposition.scenario === 'supervisor-execution') return role === 'supervisor';
  if (disposition.scenario === 'task-execution') return role === 'task';
  return false;
}

/**
 * Decide whether the generic project watchdog may intervene. User-owned holds
 * and healthy downstream execution must never be mistaken for a missing
 * project-AI runtime or a project deadlock.
 */
export function classifyProjectWatchdogScenario(
  session: ProjectManagerSession,
  options: { hasPendingManagerDelivery?: boolean } = {},
): ProjectWatchdogDisposition {
  if (['completed', 'stopped'].includes(session.status)) {
    return { scenario: 'terminal', recoverManagerRuntime: false, inspectDeadlock: false };
  }
  if (session.pendingUserQuestion || session.executionResponsibility?.owner === 'user') {
    return {
      scenario: 'user-wait',
      owner: 'user',
      recoverManagerRuntime: false,
      inspectDeadlock: false,
    };
  }
  if (session.status === 'paused') {
    return { scenario: 'explicit-pause', recoverManagerRuntime: false, inspectDeadlock: false };
  }
  if (session.safeExit) {
    return { scenario: 'safe-exit', recoverManagerRuntime: false, inspectDeadlock: false };
  }
  if (session.agentIssue) {
    return {
      scenario: 'runtime-choice',
      owner: 'user',
      recoverManagerRuntime: false,
      inspectDeadlock: false,
    };
  }
  if (session.status === 'waiting' && activeProjectGoal(session).status === 'achieved') {
    return {
      scenario: 'completed-goal-wait',
      owner: 'user',
      recoverManagerRuntime: false,
      inspectDeadlock: false,
    };
  }
  const owner = session.executionResponsibility?.owner;
  if (owner === 'task-ai') {
    return { scenario: 'task-execution', owner, recoverManagerRuntime: false, inspectDeadlock: false };
  }
  if (owner === 'supervisor-ai') {
    return {
      scenario: 'supervisor-execution',
      owner,
      recoverManagerRuntime: false,
      inspectDeadlock: false,
    };
  }
  if (options.hasPendingManagerDelivery) {
    return {
      scenario: 'manager-delivery',
      owner: 'project-ai',
      recoverManagerRuntime: true,
      inspectDeadlock: false,
    };
  }
  if (owner === 'project-ai') {
    return {
      scenario: 'project-ai-obligation',
      owner,
      recoverManagerRuntime: true,
      inspectDeadlock: true,
    };
  }
  if (owner === 'control-plane' || session.status === 'active') {
    return {
      scenario: 'control-plane-recovery',
      owner: owner || 'control-plane',
      recoverManagerRuntime: true,
      inspectDeadlock: true,
    };
  }
  return { scenario: 'passive-wait', recoverManagerRuntime: false, inspectDeadlock: false };
}
