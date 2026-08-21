import { describe, expect, it } from 'vitest';
import {
  createProjectWorkerGroup,
  normalizeProjectParallelismSelection,
  projectResourceLeaseViolation,
  projectWorkerAssignmentsViolation,
  projectWorkerGroupCompletionViolation,
  resolveProjectParallelismDecision,
  type ProjectResourceLease,
  type ProjectWorkerAssignment,
  type ProjectWorkItem,
} from '../../src/shared/project-manager';

const assignments: ProjectWorkerAssignment[] = [
  {
    workerId: 'worker-main',
    role: 'integrator',
    outcome: '集成接口并完成最终验证',
    dependencies: ['worker-tests'],
    writeClaims: ['src/integration'],
    resourceClaims: ['device-a'],
    validation: ['npm test'],
  },
  {
    workerId: 'worker-tests',
    role: 'worker',
    outcome: '补齐独立测试',
    dependencies: [],
    writeClaims: ['tests/unit'],
    resourceClaims: [],
    validation: ['npm test -- tests/unit'],
  },
];

describe('project parallelism control plane', () => {
  it('migrates legacy modes into one mutually exclusive project selection', () => {
    expect(normalizeProjectParallelismSelection(undefined, 'single-thread')).toBe('single-worker');
    expect(normalizeProjectParallelismSelection(undefined, 'multi-thread')).toBe('internal-threads');
    expect(normalizeProjectParallelismSelection(undefined, 'adaptive')).toBe('auto');
  });

  it('resolves auto to a worker group only with a valid isolated assignment graph', () => {
    const decision = resolveProjectParallelismDecision({
      execution: {
        taskWorkMode: 'adaptive',
        parallelismSelection: 'auto',
        modeReason: '按基线选择',
        mainThreadResponsibility: '集成',
        childThreadResponsibilities: [],
        parallelizableOperations: ['测试与实现可独立交付'],
      },
      stagePlan: { workerAssignments: assignments },
      requirementsVersion: 4,
      previousEpoch: 2,
      now: 100,
    });
    expect(decision).toMatchObject({
      requestedMode: 'auto',
      resolvedMode: 'worker-group',
      requirementsVersion: 4,
      executionEpoch: 3,
      resolvedAt: 100,
    });
  });

  it('falls back to one internal-thread session when no safe worker write split exists', () => {
    const decision = resolveProjectParallelismDecision({
      execution: {
        taskWorkMode: 'adaptive',
        parallelismSelection: 'auto',
        modeReason: '只需要并行分析',
        mainThreadResponsibility: '统一写入',
        childThreadResponsibilities: [],
        parallelizableOperations: ['分析调用链', '分析测试'],
      },
      requirementsVersion: 1,
    });
    expect(decision.resolvedMode).toBe('internal-threads');
  });

  it('rejects prefix-overlapping write claims and cyclic worker dependencies', () => {
    expect(projectWorkerAssignmentsViolation([
      assignments[0],
      { ...assignments[1], writeClaims: ['src/integration/generated'] },
    ])).toContain('重叠');
    expect(projectWorkerAssignmentsViolation([
      { ...assignments[0], dependencies: ['worker-tests'] },
      { ...assignments[1], dependencies: ['worker-main'] },
    ])).toContain('循环');
  });

  it('creates one integrator and bounded isolated worker runtimes', () => {
    const decision = resolveProjectParallelismDecision({
      execution: {
        taskWorkMode: 'single-thread',
        parallelismSelection: 'worker-group',
        modeReason: '固定隔离执行',
        mainThreadResponsibility: '集成',
        childThreadResponsibilities: [],
      },
      stagePlan: { workerAssignments: assignments },
      requirementsVersion: 2,
      now: 10,
    });
    const group = createProjectWorkerGroup({
      decision,
      assignments,
      mergeOrder: ['worker-tests', 'worker-main'],
      worktrees: [
        { workerId: 'worker-main', worktreePath: 'C:/runtime/main' },
        { workerId: 'worker-tests', worktreePath: 'C:/runtime/tests' },
      ],
      baselineCommit: 'abc123',
      now: 20,
    });
    expect(group.integratorWorkerId).toBe('worker-main');
    expect(group.workers).toHaveLength(2);
    expect(group.workers.every((worker) => worker.status === 'starting')).toBe(true);
    expect(group.mergeOrder).toEqual(['worker-tests', 'worker-main']);
  });

  it('serializes exclusive resources without blocking compatible shared reads', () => {
    const lease: ProjectResourceLease = {
      leaseId: 'lease-1',
      resourceId: 'device-a',
      mode: 'shared-read',
      ownerWorkerId: 'worker-main',
      operationId: 'read-1',
      status: 'in-use',
      idempotent: true,
      grantedAt: 1,
      updatedAt: 1,
    };
    expect(projectResourceLeaseViolation([lease], {
      resourceId: 'device-a', mode: 'shared-read', ownerWorkerId: 'worker-tests',
    })).toBeNull();
    expect(projectResourceLeaseViolation([lease], {
      resourceId: 'device-a', mode: 'exclusive-write', ownerWorkerId: 'worker-tests',
    })).toContain('占用');
  });

  it('blocks completion on pending direct input, leases, worker state, merge state, and final apply', () => {
    const decision = resolveProjectParallelismDecision({
      execution: {
        taskWorkMode: 'single-thread', parallelismSelection: 'worker-group', modeReason: '固定',
        mainThreadResponsibility: '集成', childThreadResponsibilities: [],
      },
      stagePlan: { workerAssignments: assignments },
      requirementsVersion: 1,
    });
    const workerGroup = createProjectWorkerGroup({ decision, assignments });
    const item = {
      workerGroup,
      userDirectives: [{
        directiveId: 'directive-1', workerId: 'worker-tests', directiveEpoch: 1, assignmentVersion: 1,
        exactTextAvailable: true, classification: 'pending', reconciliationStatus: 'pending', receivedAt: 1,
      }],
      resourceLeases: [],
      mergeCandidates: [],
      finalApplyBlocked: true,
    } as Pick<ProjectWorkItem, 'workerGroup' | 'userDirectives' | 'resourceLeases' | 'mergeCandidates' | 'finalApplyBlocked'>;
    expect(projectWorkerGroupCompletionViolation(item)).toContain('用户直发指令');
    item.userDirectives![0].reconciliationStatus = 'reconciled';
    expect(projectWorkerGroupCompletionViolation(item)).toContain('尚未完成');
    item.workerGroup!.workers = item.workerGroup!.workers.map((worker) => ({ ...worker, status: 'completed' }));
    expect(projectWorkerGroupCompletionViolation(item)).toContain('最终应用');
    item.finalApplyBlocked = false;
    expect(projectWorkerGroupCompletionViolation(item)).toBeNull();
  });
});
