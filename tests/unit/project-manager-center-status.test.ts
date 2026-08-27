import { describe, expect, it } from 'vitest';
import type { ProjectManagerSession } from '../../src/shared/project-manager';
import {
  projectCenterStatusLabel,
  projectCenterVisualState,
} from '../../src/renderer/project-manager/center-status';

function session(
  patch: Partial<ProjectManagerSession> = {},
): ProjectManagerSession {
  return {
    id: 'project-a',
    projectDir: 'C:\\project-a',
    goal: '完成项目',
    preconditions: [],
    planFiles: [],
    doneWhen: [],
    executionProtocolVersion: 1,
    status: 'active',
    workItems: [],
    events: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe('project AI center status colors', () => {
  it('maps healthy, waiting, paused, human, error, and stopped states to shared center colors', () => {
    expect(projectCenterVisualState(session())).toBe('active');
    expect(projectCenterVisualState(session({ status: 'waiting' }))).toBe('waiting');
    expect(projectCenterVisualState(session({ status: 'paused' }))).toBe('paused');
    expect(projectCenterVisualState(session({
      pendingUserQuestion: {
        id: 'question-a',
        category: 'clarification',
        question: '请选择下一步',
        options: [],
        askedAt: 1,
      },
    }))).toBe('human');
    expect(projectCenterVisualState(session({
      agentIssue: {
        role: 'manager',
        category: 'rate-limit',
        summary: '额度受限',
        detectedAt: 1,
      },
    }))).toBe('error');
    expect(projectCenterVisualState(session({ status: 'completed' }))).toBe('stopped');
    expect(projectCenterVisualState(session({ status: 'stopped' }))).toBe('stopped');
  });

  it('shows only concise status labels in the center', () => {
    const needsHuman = session({
      pendingUserQuestion: {
        id: 'question-a',
        category: 'clarification',
        question: '包含不应出现在中心的详细问题',
        options: [],
        askedAt: 1,
      },
    });
    const error = session({
      agentIssue: {
        role: 'manager',
        category: 'quota-limit',
        summary: '包含不应出现在中心的异常详情',
        detectedAt: 1,
      },
    });

    expect(projectCenterStatusLabel(needsHuman, '监督中')).toBe('等待人工处理');
    expect(projectCenterStatusLabel(error, '监督中')).toBe('监督异常');
  });
});
