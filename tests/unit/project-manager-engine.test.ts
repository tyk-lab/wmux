import { describe, expect, it } from 'vitest';
import {
  PROJECT_TASK_EXECUTION_ENVELOPE_MARKER,
  buildProjectTaskExecutionEnvelope,
  buildProjectSupervisorBriefing,
  projectPermissionAuthorizationError,
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
      authority: {
        technicalChoices: true,
        lowRiskRetries: true,
        targetedTests: true,
        internalThreads: false,
        continuousExecution: true,
        permissionConfirm: true,
        allowedCommandPrefixes: ['npm test -- auth'],
        authorizedDevices: [],
        authorizedEnvironments: ['本地工作区'],
        authorizedOperations: ['实现认证接口', '运行认证测试'],
      },
      stopWhen: ['认证测试通过'],
      validation: ['npm test -- auth'],
      budget: DEFAULT_PROJECT_EXECUTION_BUDGET,
    },
  };
}

function session(workItems: ProjectWorkItem[], status: ProjectManagerSession['status'] = 'active'): ProjectManagerSession {
  return {
    id: 'pm-1', projectDir: 'E:\\repo', goal: '完成项目', preconditions: ['环境已准备'], planFiles: [], doneWhen: ['全部测试通过'], status,
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
    expect(text).toContain('当前需求版本内由监督 AI 和任务 AI 持续继承');
    expect(text).toContain('不得把同一条件拆成逐步确认');
    expect(text).toContain(PROJECT_TASK_EXECUTION_ENVELOPE_MARKER);
    expect(text).toContain('不得只发送第一个微步骤');
  });

  it('builds one continuous execution envelope instead of a micro-step', () => {
    const contract = item('auth', 'planned').contract;
    const text = buildProjectTaskExecutionEnvelope(contract);
    expect(text).toContain(PROJECT_TASK_EXECUTION_ENVELOPE_MARKER);
    expect(text).toContain('目标：完成 auth');
    expect(text).toContain('停止条件：认证测试通过');
    expect(text).toContain('验证要求：npm test -- auth');
    expect(text).toContain('连续工作流推进到停止条件');
  });

  it('requires explicit permission grant and narrows tests with command prefixes', () => {
    const contract = item('auth', 'planned').contract;
    expect(projectPermissionAuthorizationError(contract, 'npm test -- auth')).toBeNull();
    expect(projectPermissionAuthorizationError(contract, 'npm test -- payments')).toContain('allowedCommandPrefixes');
    expect(projectPermissionAuthorizationError(
      contract,
      'npm test -- auth && npm publish',
    )).toContain('allowedCommandPrefixes');
    expect(projectPermissionAuthorizationError({
      ...contract,
      authority: { ...contract.authority, permissionConfirm: false },
    }, 'npm test -- auth')).toContain('未授权');
    const broadTestContract = {
      ...contract,
      authority: { ...contract.authority, allowedCommandPrefixes: [] },
    };
    expect(projectPermissionAuthorizationError(broadTestContract, 'npm test -- auth')).toBeNull();
    expect(projectPermissionAuthorizationError(
      broadTestContract,
      'echo unrelated-command && npm test -- auth',
    )).toContain('allowedCommandPrefixes');
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

  it('briefs adaptive tasks with bounded proposal approval and serialized hardware work', () => {
    const contract = item('auth', 'planned').contract;
    contract.authority.internalThreads = true;
    contract.execution = {
      taskWorkMode: 'adaptive',
      modeReason: '需要先确认实现与测试的写入边界',
      mainThreadResponsibility: '完成探测、集成和最终验证',
      childThreadResponsibilities: [],
      maxChildThreads: 2,
      supervisorMayApproveThreads: true,
      parallelizableOperations: ['只读分析实现', '只读分析测试'],
      serializedOperations: ['设备重上电', '最终集成验证'],
    };

    const briefing = buildProjectSupervisorBriefing({ workItemId: 'auth', contract });
    const envelope = buildProjectTaskExecutionEnvelope(contract);

    expect(briefing).toContain('任务终端工作模式：自适应线程');
    expect(briefing).toContain('允许的内部子线程上限：2');
    expect(briefing).toContain('[批准内部线程方案 childThreads=N]');
    expect(briefing).toContain('设备上电/重上电');
    expect(envelope).toContain('先进行一次有界、只读的结构探测');
    expect(envelope).toContain('带有明确 childThreads 数字的批准标记前不得创建内部子线程');
    expect(envelope).toContain('必须串行：设备重上电；最终集成验证');
    expect(envelope).toContain('不得新建 wmux 任务终端');
    expect(projectContractViolation(contract, {
      instruction: '[批准内部线程方案 childThreads=3] 并行处理三个任务',
    })).toContain('超出任务契约上限 2');
    expect(projectContractViolation(contract, {
      instruction: '[批准内部线程方案 childThreads=2] 按互斥文件所有权执行',
    })).toBeNull();
    expect(projectContractViolation(contract, {
      instruction: '[批准内部线程方案] 缺少结构化数量',
    })).toContain('必须使用');
  });

  it('rejects forbidden actions, out-of-scope files, ungranted tests and retries', () => {
    const contract = item('auth', 'planned').contract;
    expect(projectContractViolation(contract, { command: 'git push origin main' })).toContain('禁止动作');
    expect(projectContractViolation(contract, {
      instruction: '[批准内部线程方案 childThreads=1]',
    })).toContain('未授权');
    expect(projectContractViolation(contract, { changedFiles: ['src/payments/card.ts'] })).toContain('禁止路径');
    expect(projectContractViolation(contract, { changedFiles: ['src/profile/view.ts'] })).toContain('允许范围');
    expect(projectContractViolation({
      ...contract,
      authority: { ...contract.authority, targetedTests: false, lowRiskRetries: false },
    }, { testCommand: 'npm test -- auth', retry: true })).toContain('运行测试');
  });
});
