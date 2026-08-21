import { describe, expect, it } from 'vitest';
import {
  createProjectWorkerGroup,
  normalizeProjectWorkerAssignments,
  normalizeProjectParallelismSelection,
  projectResourceLeaseViolation,
  projectWorkerAssignmentsViolation,
  projectWorkerDependencyViolation,
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
    expect(projectWorkerAssignmentsViolation([
      { ...assignments[0], dependencies: [] },
      { ...assignments[1], dependencies: ['worker-main'] },
    ])).toContain('最终汇聚点');
    const canonicalized = normalizeProjectWorkerAssignments([
      assignments[0],
      { ...assignments[1], writeClaims: ['./src/integration/generated/'] },
    ]);
    expect(projectWorkerAssignmentsViolation(canonicalized)).toContain('重叠');
    expect(projectWorkerAssignmentsViolation([
      assignments[0],
      { ...assignments[1], writeClaims: ['../outside'] },
    ])).toContain('规范相对路径');
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
    expect(projectResourceLeaseViolation([lease], {
      resourceId: 'device-a', mode: 'snapshot-read', ownerWorkerId: 'worker-tests',
    })).toContain('shared-read');
    expect(projectResourceLeaseViolation([{ ...lease, resourceId: 'COM3', status: 'quarantined' }], {
      resourceId: 'com3', mode: 'shared-read', ownerWorkerId: 'worker-tests',
    })).toContain('隔离状态');
  });

  it('waits for the current dependency candidate disposition instead of worker status alone', () => {
    const decision = resolveProjectParallelismDecision({
      execution: {
        taskWorkMode: 'single-thread', parallelismSelection: 'worker-group', modeReason: '固定',
        mainThreadResponsibility: '集成', childThreadResponsibilities: [],
      },
      stagePlan: { workerAssignments: assignments },
      requirementsVersion: 1,
    });
    const workerGroup = createProjectWorkerGroup({ decision, assignments });
    workerGroup.workers = workerGroup.workers.map((worker) => ({ ...worker, status: 'completed' }));
    const integrator = workerGroup.workers.find((worker) => worker.workerId === 'worker-main')!;
    const item: Pick<ProjectWorkItem, 'workerGroup' | 'mergeCandidates'> = { workerGroup, mergeCandidates: [] };
    expect(projectWorkerDependencyViolation(item, integrator)).toContain('候选尚未应用或明确拒绝');
    item.mergeCandidates.push({
      candidateId: 'candidate-tests', workerId: 'worker-tests', assignmentVersion: 1,
      directiveEpoch: 0, baselineCommit: 'abc', patchHash: 'hash', changedFiles: [], evidence: [],
      status: 'rejected', createdAt: 1, updatedAt: 1,
    });
    expect(projectWorkerDependencyViolation(item, integrator)).toBeNull();
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
    item.workerGroup!.workers = item.workerGroup!.workers.map((worker) => ({
      ...worker,
      status: 'completed',
      directiveEpoch: worker.workerId === 'worker-tests' ? 1 : worker.directiveEpoch,
    }));
    expect(projectWorkerGroupCompletionViolation(item)).toContain('尚无已应用或明确拒绝');
    item.mergeCandidates = [{
      candidateId: 'candidate-tests',
      workerId: 'worker-tests',
      assignmentVersion: 1,
      directiveEpoch: 1,
      baselineCommit: 'abc123',
      patchHash: 'hash',
      changedFiles: ['tests/unit/example.test.ts'],
      evidence: ['passed'],
      status: 'applied',
      createdAt: 1,
      updatedAt: 1,
    }];
    expect(projectWorkerGroupCompletionViolation(item)).toContain('最终应用');
    item.finalApplyBlocked = false;
    expect(projectWorkerGroupCompletionViolation(item)).toBeNull();
  });
});
