import {
  activeProjectGoal,
  activeProjectSubgoals,
  CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
  projectAuthorizationVersion,
  projectOrientationReady,
  projectRequirementsAlignmentPhase,
  projectRequirementsVersion,
  projectTaskBaselineApproved,
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

export const ORDINARY_TASK_ROLE_ANCHOR = [
  '[任务 AI 角色锚点｜控制层]',
  '先运行 wmux context 获取当前 capability 绑定的任务终端、监督通道、状态和可用 wmux 命令；不得自行指定或操作其他终端。',
  'wmux context 描述的是 wmux 编排权限；Agent 原生工具仍受当前 Agent 和沙箱配置约束。',
  '每轮结束必须以“[本轮结果]”结构化交接：完成事项、修改文件、验证命令与结果、关键错误、剩余工作、建议下一步。长命令输出写入项目内日志或证据文件并报告路径，不得只依赖终端滚屏。',
].join('\n');
export const ORDINARY_TASK_PROTOCOL_REVISION = '2';

export function buildOrdinaryTaskEventEnvelope(surfaceId: string): string {
  const target = surfaceId.trim() || '（未指定）';
  return [
    `[任务事件｜控制层｜surface=${target}｜protocol=${ORDINARY_TASK_PROTOCOL_REVISION}]`,
    '当前任务终端与监督绑定继续有效；无需重新运行 wmux context、重新确认角色或复述协议。若控制层返回绑定或权限错误，停止沿用旧状态并报告监督 AI。',
  ].join('\n');
}

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
    allowPaths: string[];
    denyPaths: string[];
    preconditions: string[];
    stopWhen: string[];
    validation: string[];
    forbiddenActions: string[];
    supervisorConfirmableCommandPrefixes: string[];
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

const PROJECT_SUPERVISOR_METHODS = new Set([
  'project.task-terminal.start',
  'project.task-terminal.rotate',
  'project.task-terminal.control',
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
  'project.task.supervise',
  'project.progress.sync',
  'project.supervisor.transition.ack',
  'project.goal.plan',
  'project.supervisor.inspect',
  'project.supervisor.decide',
  'project.user.question',
  'project.terminal.rotate',
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
    if (requested === binding.callerSurfaceId
      || (supervisorTarget && requested === supervisorTarget
        && (method === 'surface.read_text' || method === 'pane.agent_state'))) {
      return { allowed: true };
    }
    return { allowed: false, reason: '当前 AI 角色无权通过通用 V2 接口访问其他终端' };
  }

  if ((binding.role === 'supervisor' || binding.role === 'project-supervisor')
    && (method === 'supervisor.context' || method === 'supervisor.decide')) {
    return { allowed: true };
  }

  if (binding.role === 'project-ai' && PROJECT_AI_METHODS.has(method)) {
    const requestedProjectId = String(params.projectId || params.project || '').trim();
    return !requestedProjectId || requestedProjectId === binding.projectId
      ? { allowed: true }
      : { allowed: false, reason: '项目 AI 只能访问 capability 绑定的当前项目' };
  }

  if (binding.role === 'project-supervisor' && PROJECT_SUPERVISOR_METHODS.has(method)) {
    const requestedProjectId = String(params.projectId || params.project || '').trim();
    const requestedWorkItemId = String(params.workItemId || params.task || '').trim();
    if ((!requestedProjectId || requestedProjectId === binding.projectId)
      && (!requestedWorkItemId || requestedWorkItemId === binding.workItemId)) {
      return { allowed: true };
    }
    return { allowed: false, reason: '项目监督只能控制 capability 绑定的当前项目任务终端' };
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
          condition: '存在当前目标下依赖已满足的工作项，且没有冲突监督链',
        },
        {
          command: `wmux project task-update --project ${projectId} --json-file <.wmux/tmp/文件>`,
          available: mutableProject && session.workItems.length > 0,
          condition: executionProtocolMigrationRequired
            ? `旧项目存在过期工作项；逐项提交完整 contract 以迁移到执行协议 v${CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION}，不能只修改状态或版本号`
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
          command: `wmux project terminal-rotate --project ${projectId} --json-file <.wmux/tmp/文件>`,
          available: projectActive && session.workItems.some((item) => !!item.workerSurfaceId),
          condition: '任务上下文确实过长，且已保存恢复摘要并满足安全轮换条件',
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
      ],
      forbidden: [
        '读取、比较或操作其他项目',
        '使用通用 wmux send/send-key 直接控制监督 AI 或任务 AI',
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
  const projectManaged = !!project && !!workItem;
  const supervisionState = lane ? supervisorLaneControlState(lane) : 'unbound';
  const config = lane ? effectiveSupervisorLaneConfig(lane) : undefined;
  const authority = workItem?.contract.authority;
  const contractVersionCurrent = !!project && !!workItem
    && project.status === 'active'
    && projectRequirementsAlignmentPhase(project) === 'accepted'
    && workItem.goalId === activeProjectGoal(project).id
    && workItem.requirementsVersion === projectRequirementsVersion(project)
    && workItem.authorizationVersion === projectAuthorizationVersion(project)
    && (project.executionProtocolVersion || 0) >= CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION
    && (workItem.executionProtocolVersion || 0) >= CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION;
  const inactiveWorkItem = !!workItem && [
    'completed', 'stopped', 'failed', 'paused', 'waiting-decision',
  ].includes(workItem.status);
  const dependencyBlocked = !!project && !!workItem
    && (!projectWorkItemReady(workItem, project.workItems)
      || !!projectWorkItemSubgoalDependencyError(project, workItem));
  const contractCurrent = contractVersionCurrent && !inactiveWorkItem;
  const baselineApproved = workItem ? contractCurrent && projectTaskBaselineApproved(workItem) : undefined;
  const projectExecutionAvailable = contractCurrent
    && !dependencyBlocked
    && supervisionState === 'active'
    && baselineApproved === true;
  const allowedActions = projectManaged
    ? !contractVersionCurrent
      ? ['当前项目状态或任务合同版本已经失效；停止执行并等待监督 AI/项目 AI 重新绑定合同']
      : inactiveWorkItem
        ? [`当前工作项状态为 ${workItem?.status || 'unknown'}；合同不再允许继续执行，等待控制层重新派发`]
      : dependencyBlocked
        ? ['当前工作项依赖或阶段目标尚未就绪；停止执行并等待项目 AI 重新调度']
      : supervisionState !== 'active'
        ? [supervisionState === 'waiting'
            ? '当前阶段已经进入待续；不得自行开始下一阶段，等待监督 AI/项目 AI 明确续接'
            : '当前监督通道未处于活动状态；停止执行并等待控制层恢复监督']
      : baselineApproved
      ? [
          '在合同 scope.allowPaths 与当前目标范围内完成实现',
          authority?.technicalChoices ? '在合同边界内自主选择技术实现' : '',
          authority?.lowRiskRetries ? '基于新证据进行合同预算内的低风险重试' : '',
          authority?.targetedTests ? '运行合同要求的最小相关测试' : '',
          authority?.internalThreads ? '按 execution 约定组织任务 AI 自己的内部线程' : '',
          authority?.continuousExecution ? '连续推进完整工作流直到停止条件或真实边界' : '',
        ].filter(Boolean)
      : ['仅执行监督 AI 下达的有界只读项目基线调查，并提交基线报告后停止']
    : supervisionState === 'active'
      ? ['按当前任务目标工作；具体本地工具权限由底层 Agent 及其沙箱决定']
      : [supervisionState === 'waiting'
          ? '当前监督阶段已经进入待续；等待监督 AI 或用户明确续接'
          : '当前监督通道未处于活动状态；停止执行并等待控制层恢复监督'];
  const conditionalActions = projectManaged && projectExecutionAvailable ? [
    authority?.permissionConfirm
      ? '遇到权限提示时等待监督 AI 按合同白名单确认；任务 AI 不自行扩大权限'
      : '任何权限提示都交回监督 AI；当前合同未授权监督自动确认',
    authority?.internalThreads
      ? '只有 execution 模式允许时才能建立内部线程；共享资源和最终集成保持串行'
      : '不得创建内部线程',
  ] : [];
  const contract = workItem?.contract;

  return {
    ok: true,
    role: projectManaged ? 'project-task' : 'task',
    identity: {
      taskSurfaceId: callerSurfaceId,
      ...(lane?.supervisorSurfaceId ? { supervisorSurfaceId: lane.supervisorSurfaceId } : {}),
      ...(lane ? { laneId: lane.id } : {}),
      ...(project ? { projectId: project.id } : {}),
      ...(workItem?.goalId ? { goalId: workItem.goalId } : {}),
      ...(workItem ? { workItemId: workItem.id } : {}),
      ...(workItem?.requirementsVersion !== undefined
        ? { requirementsVersion: workItem.requirementsVersion }
        : {}),
      ...(workItem?.authorizationVersion !== undefined
        ? { authorizationVersion: workItem.authorizationVersion }
        : {}),
      ...(options.runtime?.agent ? { agent: options.runtime.agent } : {}),
      ...(options.runtime?.model ? { model: options.runtime.model } : {}),
      ...(options.runtime?.reasoningEffort
        ? { reasoningEffort: options.runtime.reasoningEffort }
        : {}),
    },
    state: {
      task: options.taskState || 'unknown',
      supervision: supervisionState,
      ...(workItem?.baseline ? { baseline: workItem.baseline.status } : {}),
      ...(projectManaged ? {
        contract: !contractVersionCurrent
          ? 'stale' as const
          : inactiveWorkItem || dependencyBlocked
            ? 'inactive' as const
            : 'current' as const,
      } : {}),
    },
    contract: {
      objective: contract?.objective || config?.taskGoal || lane?.currentTask || '',
      ...(contract?.scope.root ? { projectRoot: contract.scope.root } : {}),
      allowPaths: [...(contract?.scope.allowPaths || [])],
      denyPaths: [...(contract?.scope.denyPaths || [])],
      preconditions: [...new Set([
        ...(project?.preconditions || []),
        ...(contract?.preconditions || (config?.preconditions ? [config.preconditions] : [])),
      ])],
      stopWhen: [...(contract?.stopWhen || (config?.stopWhen ? [config.stopWhen] : []))],
      validation: [...(contract?.validation || [])],
      forbiddenActions: [...(contract?.scope.forbiddenActions || [])],
      supervisorConfirmableCommandPrefixes: [...(authority?.allowedCommandPrefixes || [])],
      ...(workItem?.supervisorPlan ? {
        supervisorPlan: {
          revision: workItem.supervisorPlan.revision,
          selectedRoute: workItem.supervisorPlan.selectedRoute,
          milestones: workItem.supervisorPlan.milestones.map((milestone) => ({
            id: milestone.id,
            status: milestone.status,
            outcome: milestone.outcome,
          })),
          remainingWork: [...workItem.supervisorPlan.remainingWork],
        },
      } : {}),
    },
    actions: {
      available: allowedActions,
      conditional: conditionalActions,
      forbidden: [
        '越出任务目标、项目根目录、允许路径或当前需求/授权版本',
        '自行确认权限、修改凭据或扩大 allowedCommandPrefixes',
        '使用 wmux 操作其他终端、其他工作项或其他项目',
        '绕过监督裁决桥直接请求项目 AI 或用户推进普通技术步骤',
      ],
      nativeToolNotice: '这里列出的是 wmux 任务合同权限；Codex、Kimi、Grok 等 Agent 原生工具仍由当前 Agent 及其沙箱配置决定。',
    },
    commands: {
      available: [
        'wmux context',
        `wmux agent-state --surface ${callerSurfaceId}`,
      ],
      forbidden: [
        'wmux supervisor decide',
        'wmux project 管理命令',
        'wmux send/send-key 操作其他终端',
      ],
    },
    ...(workItem ? {
      budget: {
        decisionsUsed: workItem.decisionsUsed,
        decisionsRemaining: Math.max(0, workItem.contract.budget.maxDecisions - workItem.decisionsUsed),
        attempts: workItem.attempts,
        retriesRemaining: Math.max(0, workItem.contract.budget.maxTaskRetries - workItem.attempts),
      },
    } : {}),
  };
}
