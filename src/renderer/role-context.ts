import {
  activeProjectGoal,
  activeProjectSubgoals,
  CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
  projectAuthorizationVersion,
  projectOrientationReady,
  projectRequirementsAlignmentPhase,
  projectRequirementsVersion,
  projectWorkItemReady,
  type ProjectManagerSession,
  type ProjectWorkItem,
} from '../shared/project-manager';
import { projectWorkItemSubgoalDependencyError } from './project-manager/engine';
import { effectiveSupervisorLaneConfig } from './supervisor/protocol';
import {
  supervisorLaneControlState,
  type SupervisorLane,
} from './store/supervisor-slice';

export interface RoleContextConditionalAction {
  command: string;
  available: boolean;
  condition: string;
}

export interface ProjectAiRuntimeContext {
  ok: true;
  role: 'project-ai';
  identity: {
    managerSurfaceId: string;
    projectId: string;
    goalId: string;
    requirementsVersion: number;
    authorizationVersion: number;
    agent?: string;
    model?: string;
    reasoningEffort?: string;
  };
  state: {
    project: string;
    requirementsAlignment:
      | 'required'
      | 'confirmed-awaiting-plan-or-resume'
      | 'accepted'
      | 'needs-definition-update';
    orientation: 'ready' | 'required';
    progressSync: 'ready' | 'review-required';
    executionProtocol: 'current' | 'migration-required';
  };
  scope: {
    projectDir: string;
    projectName: string;
    projectScope: string;
    currentGoal: string;
    preconditions: string[];
    doneWhen: string[];
  };
  pending: {
    userQuestion: boolean;
    supervisorTransitions: number;
    supervisorApprovals: number;
    workItems: number;
    readyWorkItems: number;
  };
  commands: {
    available: string[];
    conditional: RoleContextConditionalAction[];
    forbidden: string[];
  };
}

export interface TaskAiRuntimeContext {
  ok: true;
  role: 'project-task' | 'task';
  identity: {
    taskSurfaceId: string;
    supervisorSurfaceId?: string;
    laneId?: string;
    projectId?: string;
    goalId?: string;
    workItemId?: string;
    workerId?: string;
    workerRole?: string;
    executionEpoch?: number;
    assignmentVersion?: number;
    directiveEpoch?: number;
    requirementsVersion?: number;
    authorizationVersion?: number;
    agent?: string;
    model?: string;
    reasoningEffort?: string;
  };
  state: {
    task: string;
    supervision: string;
    baseline?: string;
    contract?: 'current' | 'stale' | 'inactive';
  };
  contract: {
    objective: string;
    projectRoot?: string;
    executionAuthority: 'full-project' | 'task-scoped';
    preconditions: string[];
    stopWhen: string[];
    validation: string[];
    safetyBoundaries: string[];
    supervisorPlan?: {
      revision: number;
      selectedRoute: string;
      milestones: Array<{ id: string; status: string; outcome: string }>;
      remainingWork: string[];
    };
  };
  actions: {
    available: string[];
    conditional: string[];
    forbidden: string[];
    nativeToolNotice: string;
  };
  commands: {
    available: string[];
    forbidden: string[];
  };
  budget?: {
    decisionsUsed: number;
    decisionsRemaining: number;
    attempts: number;
    retriesRemaining: number;
  };
}

export type ManagedAiRole = 'project-ai' | 'supervisor' | 'project-supervisor' | 'task' | 'project-task';

export interface ManagedRoleBinding {
  role: ManagedAiRole;
  callerSurfaceId: string;
  targetSurfaceId?: string;
  targetSurfaceIds?: string[];
  projectId?: string;
  workItemId?: string;
}

export interface ManagedRoleAuthorization {
  allowed: boolean;
  reason?: string;
}

const SELF_SCOPED_V2_METHODS = new Set([
  'hook.event',
  'agent.activity',
  'pane.report_agent',
  'pane.report_metadata',
  'pane.report_agent_session',
  'pane.release_agent',
  'pane.agent_state',
  'surface.read_text',
  'surface.send_text',
  'surface.send_key',
]);

const PROJECT_AI_METHODS = new Set([
  'project.status',
  'project.update',
  'project.alignment.confirm',
  'project.orientation.confirm',
  'project.logs',
  'project.terminals',
  'project.task.create',
  'project.task.update',
  'project.supervisor.assign',
  'project.auxiliary.dispatch',
  'project.auxiliary.status',
  'project.progress.sync',
  'project.supervisor.transition.ack',
  'project.goal.plan',
  'project.supervisor.inspect',
  'project.supervisor.decide',
  'project.user.question',
  'project.execution.record',
  'project.pause',
  'project.resume',
  'project.stop',
  'project.complete',
  'project.reply',
]);

function requestedSurfaceId(params: Record<string, any>): string {
  return String(params.surfaceId || params.id || params.targetSurfaceId || '').trim();
}

/** A deny-by-default V2 policy for terminals that currently own an AI role. */
export function authorizeManagedRoleV2(
  binding: ManagedRoleBinding,
  method: string,
  params: Record<string, any> = {},
): ManagedRoleAuthorization {
  if (method === 'role.context') return { allowed: true };

  if (SELF_SCOPED_V2_METHODS.has(method)) {
    const requested = requestedSurfaceId(params) || binding.callerSurfaceId;
    const supervisorTarget = binding.role === 'supervisor' || binding.role === 'project-supervisor'
      ? binding.targetSurfaceId
      : undefined;
    const supervisorTargets = new Set([
      ...(supervisorTarget ? [supervisorTarget] : []),
      ...(binding.targetSurfaceIds || []),
    ]);
    if (requested === binding.callerSurfaceId
      || (supervisorTargets.has(requested)
        && (method === 'surface.read_text' || method === 'pane.agent_state'))) {
      return { allowed: true };
    }
    return { allowed: false, reason: '当前 AI 角色无权通过通用 V2 接口访问其他终端' };
  }

  if ((binding.role === 'supervisor' || binding.role === 'project-supervisor')
    && (method === 'supervisor.context'
      || method === 'supervisor.evidence'
      || method === 'supervisor.completion.verify'
      || method === 'supervisor.decide'
      || (binding.role === 'supervisor' && method === 'supervisor.goal.draft')
      || (binding.role === 'supervisor' && method === 'supervisor.reply'))) {
    return { allowed: true };
  }

  if (binding.role === 'project-supervisor'
    && (method === 'project.auxiliary.dispatch' || method === 'project.auxiliary.status')) {
    const requestedProjectId = String(params.projectId || params.project || '').trim();
    return !requestedProjectId || requestedProjectId === binding.projectId
      ? { allowed: true }
      : { allowed: false, reason: '项目监督 AI 只能调度当前项目的辅助任务 AI' };
  }

  if (binding.role === 'project-ai' && PROJECT_AI_METHODS.has(method)) {
    const requestedProjectId = String(params.projectId || params.project || '').trim();
    return !requestedProjectId || requestedProjectId === binding.projectId
      ? { allowed: true }
      : { allowed: false, reason: '项目 AI 只能访问 capability 绑定的当前项目' };
  }

  return {
    allowed: false,
    reason: `当前 ${binding.role} 角色未获授权调用 ${method}`,
  };
}

export function buildProjectAiRuntimeContext(
  session: ProjectManagerSession,
  options: {
    pendingSupervisorApprovals?: number;
    runtime?: { agent?: string; model?: string; reasoningEffort?: string };
  } = {},
): ProjectAiRuntimeContext {
  const projectId = session.id;
  const requirementsVersion = projectRequirementsVersion(session);
  const authorizationVersion = projectAuthorizationVersion(session);
  const alignmentPhase = projectRequirementsAlignmentPhase(session);
  const alignmentConfirmed = alignmentPhase === 'accepted'
    || alignmentPhase === 'confirmed-awaiting-plan-or-resume';
  const executionVersionAccepted = alignmentPhase === 'accepted';
  const orientationReady = projectOrientationReady(session);
  const progressReady = session.progressSync?.status !== 'review-required';
  const goal = activeProjectGoal(session);
  const subgoals = activeProjectSubgoals(session);
  const executionProtocolMigrationRequired = session.workItems.some((item) => (
    !['completed', 'stopped'].includes(item.status)
    && (item.executionProtocolVersion || 0) < CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION
  ));
  const readyWorkItems = session.workItems.filter((item) => (
    item.goalId === goal.id
    && item.requirementsVersion === requirementsVersion
    && item.authorizationVersion === authorizationVersion
    && (item.executionProtocolVersion || 0) >= CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION
    && projectWorkItemReady(item, session.workItems)
    && !projectWorkItemSubgoalDependencyError(session, item)
  ));
  const projectActive = session.status === 'active';
  const mutableProject = !['completed', 'stopped'].includes(session.status);
  const planningReady = alignmentConfirmed && orientationReady && progressReady;
  const executionReady = executionVersionAccepted && planningReady;
  const runnableWorkItem = readyWorkItems.some((item) => item.goalId === goal.id);
  const goalWorkItems = session.workItems.filter((item) => item.goalId === goal.id && item.status !== 'stopped');
  const goalComplete = goalWorkItems.length > 0
    && goalWorkItems.every((item) => item.status === 'completed');

  return {
    ok: true,
    role: 'project-ai',
    identity: {
      managerSurfaceId: session.managerSurfaceId || '',
      projectId,
      goalId: goal.id,
      requirementsVersion,
      authorizationVersion,
      ...(options.runtime?.agent ? { agent: options.runtime.agent } : {}),
      ...(options.runtime?.model ? { model: options.runtime.model } : {}),
      ...(options.runtime?.reasoningEffort
        ? { reasoningEffort: options.runtime.reasoningEffort }
        : {}),
    },
    state: {
      project: session.status,
      requirementsAlignment: alignmentPhase,
      orientation: orientationReady ? 'ready' : 'required',
      progressSync: progressReady ? 'ready' : 'review-required',
      executionProtocol: executionProtocolMigrationRequired ? 'migration-required' : 'current',
    },
    scope: {
      projectDir: session.projectDir,
      projectName: session.projectName || '',
      projectScope: session.projectScope || '',
      currentGoal: session.goal,
      preconditions: [...session.preconditions],
      doneWhen: [...session.doneWhen],
    },
    pending: {
      userQuestion: !!session.pendingUserQuestion,
      supervisorTransitions: session.pendingSupervisorTransitions?.length || 0,
      supervisorApprovals: Math.max(0, options.pendingSupervisorApprovals || 0),
      workItems: session.workItems.filter((item) => !['completed', 'stopped'].includes(item.status)).length,
      readyWorkItems: readyWorkItems.length,
    },
    commands: {
      available: [
        'wmux context',
        `wmux project status --project ${projectId}`,
        `wmux project logs --project ${projectId}`,
        `wmux project terminals --project ${projectId}`,
        `wmux project reply --project ${projectId} --message <回复>`,
      ],
      conditional: [
        {
          command: `wmux project update --project ${projectId} --json-file <.wmux/tmp/文件>`,
          available: mutableProject,
          condition: '收到用户需求、范围、前置条件或验收变化时写回结构化定义',
        },
        {
          command: `wmux project alignment-confirm --project ${projectId} --json-file <.wmux/tmp/文件>`,
          available: alignmentPhase === 'required' && !session.pendingUserQuestion,
          condition: '需求充分性检查完成且当前需求版本尚未确认',
        },
        {
          command: `wmux project orientation-confirm --project ${projectId} --json-file <.wmux/tmp/文件>`,
          available: mutableProject && alignmentConfirmed && !orientationReady && progressReady,
          condition: '需求已确认、进度同步完成且当前认知基线待提交',
        },
        {
          command: `wmux project progress-sync --project ${projectId} --ack --summary <影响摘要>`,
          available: mutableProject && !progressReady,
          condition: '目录存在尚未复核的外部进度变化',
        },
        {
          command: `wmux project goal-plan --project ${projectId} --json-file <.wmux/tmp/文件>`,
          available: mutableProject && planningReady && !session.pendingUserQuestion,
          condition: '需求、认知基线和进度同步均已就绪；保存当前目标的阶段计划',
        },
        {
          command: `wmux project task-create --project ${projectId} --json-file <.wmux/tmp/文件>`,
          available: projectActive && executionReady && subgoals.length > 0,
          condition: '项目运行中、阶段计划存在且所有门禁就绪',
        },
        {
          command: `wmux project supervise --project ${projectId} --task <工作项ID>`,
          available: projectActive && executionReady && runnableWorkItem,
          condition: '把依赖已满足的工作项交给专属监督；项目 AI 不会写入主任务终端',
        },
        {
          command: `wmux project task-update --project ${projectId} --json-file <.wmux/tmp/文件>`,
          available: mutableProject && session.workItems.length > 0,
          condition: executionProtocolMigrationRequired
            ? `旧项目存在过期工作项；控制层会冻结其预算与审计并建立执行协议 v${CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION} 后继，只能更新返回的后继工作项`
            : '持久化工作项状态、证据、上下文或阻塞',
        },
        {
          command: `wmux project record --project ${projectId} --json-file <.wmux/tmp/文件>`,
          available: mutableProject && session.workItems.length > 0,
          condition: '记录当前工作项的结构化执行证据；不能替代 task-update 状态同步',
        },
        {
          command: `wmux project transition-ack --project ${projectId} --transition <ID> --resolution <结果> --summary <摘要>`,
          available: mutableProject && (session.pendingSupervisorTransitions?.length || 0) > 0,
          condition: '存在尚未回执的监督状态交接',
        },
        {
          command: `wmux project decide --project ${projectId} --approval <ID> --decision <决定>`,
          available: mutableProject && (options.pendingSupervisorApprovals || 0) > 0,
          condition: '当前项目存在等待项目 AI 处理的监督待决项',
        },
        {
          command: `wmux project inspect --project ${projectId} --reason <原因>`,
          available: projectActive && session.workItems.some((item) => !!item.supervisorLaneId),
          condition: '需要监督 AI 基于当前终端证据处理项目级待决或恢复核查',
        },
        {
          command: `wmux project pause --project ${projectId} --reason <原因>`,
          available: projectActive,
          condition: '项目需要暂停且已记录具体原因',
        },
        {
          command: `wmux project resume --project ${projectId} --reason <原因>`,
          available: ['paused', 'waiting'].includes(session.status)
            && planningReady
            && !session.pendingUserQuestion,
          condition: '项目已暂停或等待、全部门禁就绪且没有待用户答复问题',
        },
        {
          command: `wmux project complete --project ${projectId} --evidence <证据>`,
          available: projectActive && executionReady && goalComplete,
          condition: '当前目标所有工作项完成，并有覆盖完成条件的可复核证据',
        },
        {
          command: `wmux project stop --project ${projectId} --reason <原因>`,
          available: false,
          condition: '仅在用户明确终止项目或不可恢复的高风险边界下使用；普通阻塞应暂停或重规划',
        },
        {
          command: `wmux project ask --project ${projectId} --json-file <.wmux/tmp/文件>`,
          available: mutableProject && !session.pendingUserQuestion,
          condition: '存在真实业务歧义、用户专属信息或必须人工处理的边界',
        },
        {
          command: `wmux project auxiliary-dispatch --project ${projectId} --json-file <.wmux/tmp/文件>`,
          available: mutableProject && session.agentConfig?.auxiliary?.enabled === true,
          condition: '需要资料调查、受控文档/进度维护或用户已授权的辅助 Git commit',
        },
        {
          command: `wmux project auxiliary-status --project ${projectId}`,
          available: session.agentConfig?.auxiliary?.enabled === true,
          condition: '查看辅助任务 AI 当前任务、终端状态和结果',
        },
      ],
      forbidden: [
        '读取、比较或操作其他项目',
        '使用通用 wmux send/send-key 直接控制监督 AI 或任务 AI',
        '向主任务 AI 暴露辅助任务 AI，或让辅助 AI 修改业务源码、测试、构建配置与依赖',
        '代替任务 AI 修改项目交付文件、执行实现或运行测试',
        '绕过需求、认知基线、进度同步和阶段计划门禁派发任务',
      ],
    },
  };
}

export function buildTaskAiRuntimeContext(options: {
  callerSurfaceId: string;
  taskState?: string;
  lane?: SupervisorLane;
  project?: ProjectManagerSession;
  workItem?: ProjectWorkItem;
  runtime?: { agent?: string; model?: string; reasoningEffort?: string };
}): TaskAiRuntimeContext {
  const { callerSurfaceId, lane, project, workItem } = options;
  const projectManaged = !!project;
  const config = lane ? effectiveSupervisorLaneConfig(lane) : undefined;
  const contract = workItem?.contract;
  const runtimeIdentity = {
    taskSurfaceId: callerSurfaceId,
    ...(options.runtime?.agent ? { agent: options.runtime.agent } : {}),
    ...(options.runtime?.model ? { model: options.runtime.model } : {}),
    ...(options.runtime?.reasoningEffort ? { reasoningEffort: options.runtime.reasoningEffort } : {}),
  };
  return {
    ok: true,
    role: 'task',
    identity: projectManaged
      ? runtimeIdentity
      : {
          ...runtimeIdentity,
          ...(lane?.supervisorSurfaceId ? { supervisorSurfaceId: lane.supervisorSurfaceId } : {}),
          ...(lane ? { laneId: lane.id } : {}),
        },
    state: {
      task: options.taskState || 'unknown',
      supervision: projectManaged ? 'unbound' : lane ? supervisorLaneControlState(lane) : 'unbound',
    },
    contract: {
      objective: contract?.objective || config?.taskGoal || lane?.currentTask || '',
      ...(contract?.scope.root ? { projectRoot: contract.scope.root } : {}),
      executionAuthority: projectManaged ? 'full-project' : 'task-scoped',
      preconditions: [...new Set([
        ...(project?.preconditions || []),
        ...(contract?.preconditions || (config?.preconditions ? [config.preconditions] : [])),
      ])],
      stopWhen: [...(contract?.stopWhen || (config?.stopWhen ? [config.stopWhen] : []))],
      validation: [...(contract?.validation || [])],
      safetyBoundaries: ['破坏性覆盖', '外部访问', '凭据', '提权', '发布', '生产环境', '真实硬件高风险操作'],
    },
    actions: {
      available: projectManaged
        ? [
            '读取并遵循当前目录适用的 AGENTS、技能和项目规范',
            '自主选择实现、测试、命令和内部组织方式',
            '持续推进到可验证成果或真实授权边界',
          ]
        : ['按当前任务目标工作；具体本地工具权限由底层 Agent 及其沙箱决定'],
      conditional: projectManaged
        ? ['遵守成果包指定的单线程或多线程模式；多线程内部子线程上限为 3，共享写入、共享资源和最终集成保持串行']
        : [],
      forbidden: [
        '越出当前任务目标或工作目录',
        '绕过用户专属的高风险、安全、凭据、发布或真实硬件授权边界',
        '使用 wmux 操作其他终端',
      ],
      nativeToolNotice: projectManaged
        ? '目标项目 AGENTS、技能和规范始终优先；wmux 不向任务 AI 暴露内部编排身份。'
        : 'wmux 能力不扩大原生 Agent 权限；具体本地工具仍由当前 Agent 及其沙箱配置决定。',
    },
    commands: {
      available: [
        'wmux context',
        'wmux agent-state --surface ' + callerSurfaceId,
      ],
      forbidden: [
        'wmux supervisor decide',
        'wmux project 管理命令',
        'wmux send/send-key 操作其他终端',
      ],
    },
  };
}
