import { describe, expect, it } from 'vitest';
import {
  buildProjectSupervisorBriefing,
  projectContractViolation,
  projectCompletionState,
  projectDependencyError,
  readyProjectWorkItems,
} from '../../src/renderer/project-manager/engine';
import {
  DEFAULT_PROJECT_EXECUTION_BUDGET,
  type ProjectManagerSession,
  type ProjectWorkItem,
} from '../../src/shared/project-manager';

function item(id: string, status: ProjectWorkItem['status'], dependencies: string[] = []): ProjectWorkItem {
  return {
    id,
    title: id,
    status,
    dependencies,
    attempts: 0,
    decisionsUsed: 0,
    updatedAt: 1,
    executionHistory: [],
    contract: {
      objective: `完成 ${id}`,
      description: '',
      preconditions: [],
      scope: { root: 'E:\\repo', allowPaths: ['src/auth'], denyPaths: ['src/payments'], forbiddenActions: ['git push'] },
      authority: { technicalChoices: true, lowRiskRetries: true, targetedTests: true, internalThreads: false },
      stopWhen: ['认证测试通过'],
      validation: ['npm test -- auth'],
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
    },
  };
}

function session(workItems: ProjectWorkItem[], status: ProjectManagerSession['status'] = 'active'): ProjectManagerSession {
  return {
    id: 'pm-1', projectDir: 'E:\\repo', goal: '完成项目', doneWhen: ['全部测试通过'], status,
    workItems, events: [], createdAt: 1, updatedAt: 1,
  };
}

describe('project-manager engine', () => {
  it('rejects missing and cyclic dependencies', () => {
    expect(projectDependencyError([item('a', 'planned', ['missing'])])).toContain('不存在');
    expect(projectDependencyError([item('a', 'planned', ['b']), item('b', 'planned', ['a'])])).toContain('循环');
  });

  it('returns independent ready work for parallel scheduling', () => {
    const base = item('base', 'completed');
    const ui = item('ui', 'waiting-dependencies', ['base']);
    const api = item('api', 'planned', ['base']);
    expect(readyProjectWorkItems(session([base, ui, api])).map((entry) => entry.id)).toEqual(['ui', 'api']);
  });

  it('requires project-level validation after all work completes', () => {
    expect(projectCompletionState(session([item('a', 'completed')]))).toBe('ready-for-validation');
  });

  it('builds a bounded supervisor briefing with anti-loop instructions', () => {
    const text = buildProjectSupervisorBriefing({ workItemId: 'auth', contract: item('auth', 'planned').contract });
    expect(text).toContain('允许范围：src/auth');
    expect(text).toContain('禁止动作：git push');
    expect(text).toContain('不得原样重复命令或测试');
    expect(text).toContain('最多 6 次连续决策');
  });

  it('passes a multi-thread plan and explicit thread responsibilities to the supervisor', () => {
    const contract = item('auth', 'planned').contract;
    contract.authority.internalThreads = true;
    contract.execution = {
      taskWorkMode: 'multi-thread',
      modeReason: 'UI 与协议验证可以独立取证',
      mainThreadResponsibility: '整合实现并负责最终验证',
      childThreadResponsibilities: ['检查 UI 状态', '检查协议和恢复行为'],
    };
    const text = buildProjectSupervisorBriefing({ workItemId: 'auth', contract });
    expect(text).toContain('任务终端工作模式：多线程');
    expect(text).toContain('主线程职责：整合实现并负责最终验证');
    expect(text).toContain('子线程 1 职责：检查 UI 状态');
    expect(text).toContain('必须把以上线程职责清晰传达给任务终端');
  });

  it('rejects forbidden actions, out-of-scope files, ungranted tests and retries', () => {
    const contract = item('auth', 'planned').contract;
    expect(projectContractViolation(contract, { command: 'git push origin main' })).toContain('禁止动作');
    expect(projectContractViolation(contract, { changedFiles: ['src/payments/card.ts'] })).toContain('禁止路径');
    expect(projectContractViolation(contract, { changedFiles: ['src/profile/view.ts'] })).toContain('允许范围');
    expect(projectContractViolation({
      ...contract,
      authority: { ...contract.authority, targetedTests: false, lowRiskRetries: false },
    }, { testCommand: 'npm test -- auth', retry: true })).toContain('运行测试');
  });
});
