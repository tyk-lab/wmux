import {
  DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS,
  DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS,
  DEFAULT_SUPERVISOR_WORK_SCOPE,
  type SupervisorAutonomyPermission,
  type SupervisorForbiddenAction,
  type SupervisorWorkScope,
} from '../../shared/supervisor-policy';
import {
  supervisorLaneControlState,
  type SupervisorLane,
  type SupervisorSession,
} from '../store/supervisor-slice';
import { detectSupervisorLauncher } from './launch-command';

export interface SupervisorProjectContext {
  projectId: string;
  goalId?: string;
  workItemId?: string;
  requirementsVersion?: number;
  authorizationVersion?: number;
  attempts?: number;
  maxTaskRetries?: number;
  projectStatus?: string;
  workItemStatus?: string;
  bindingCurrent?: boolean;
  dependencyError?: string;
}

export interface SupervisorConditionalCommand {
  command: string;
  available: boolean;
  condition: string;
}

export interface SupervisorRuntimeContext {
  ok: true;
  role: 'supervisor' | 'project-supervisor';
  identity: {
    supervisorSurfaceId: string;
    targetSurfaceId: string;
    laneId: string;
    reviewId?: string;
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
    lane: string;
    task: string;
    autonomous: boolean;
    decision: 'ready' | 'not-awaiting-review' | 'blocked';
    decisionBlockers: string[];
  };
  permissions: {
    autonomy: SupervisorAutonomyPermission[];
    workScope: SupervisorWorkScope;
    forbiddenActions: SupervisorForbiddenAction[];
  };
  commands: {
    available: string[];
    decisionOutcomes: Array<'continue' | 'rework' | 'complete' | 'needs-human'>;
    conditional: SupervisorConditionalCommand[];
    forbidden: string[];
  };
  budget: {
    autoDecisionsUsed: number;
    maxAutoDecisions: number | null;
    autoDecisionsRemaining: number | null;
    projectAttempts?: number;
    projectRetriesRemaining?: number;
  };
  plan?: {
    revision: number;
    objective?: string;
    milestones: Array<{ id: string; status: string; outcome: string }>;
    remainingWork: string[];
  };
}

export interface SupervisorDecisionPreflight {
  blockers: string[];
  baseReady: boolean;
  reviewReady: boolean;
  proactiveProjectReady: boolean;
  decisionReady: boolean;
}

/** Shared global preflight; action text, evidence and scope still receive deeper guards at execution. */
export function evaluateSupervisorDecisionPreflight(
  session: SupervisorSession,
  lane: SupervisorLane,
  options: {
    taskState?: string;
    project?: SupervisorProjectContext;
    outcome?: 'continue' | 'rework' | 'complete' | 'needs-human';
    hasNext?: boolean;
    permissionRequested?: boolean;
  } = {},
): SupervisorDecisionPreflight {
  const projectManaged = !!lane.projectManagerProjectId;
  const laneState = supervisorLaneControlState(lane);
  const autonomous = typeof lane.autonomousOverride === 'boolean'
    ? lane.autonomousOverride
    : session.autonomous === true;
  const pendingApproval = session.pendingApprovals.some((approval) => approval.laneId === lane.id);
  const blockers = [
    !session.active ? '监督会话未启动' : '',
    session.paused ? '监督会话已暂停' : '',
    laneState !== 'active' ? `监督通道为 ${laneState}` : '',
    projectManaged && options.project?.workItemId && options.project.bindingCurrent !== true
      ? options.project?.dependencyError || '项目、目标、工作项或合同版本绑定已失效'
      : '',
    pendingApproval && (!options.outcome || options.outcome !== 'needs-human')
      ? '当前通道已有待决审批'
      : '',
    lane.autoDecisionLimitReached && !autonomous ? '已达到自动裁决上限' : '',
  ].filter(Boolean);
  const baseReady = blockers.length === 0;
  const reviewReady = baseReady && lane.awaitingReview === true;
  const proactiveProjectReady = baseReady
    && projectManaged
    && !!options.project?.workItemId
    && autonomous;
  const decisionReady = !options.outcome
    ? reviewReady || proactiveProjectReady
    : options.outcome === 'continue' || options.outcome === 'rework'
      ? reviewReady || (proactiveProjectReady && options.hasNext === true && !options.permissionRequested)
      : reviewReady;
  return { blockers, baseReady, reviewReady, proactiveProjectReady, decisionReady };
}

function effectivePermissions(
  session: SupervisorSession,
  lane: SupervisorLane,
): SupervisorAutonomyPermission[] {
  if (Array.isArray(lane.autonomyPermissionsOverride)) {
    return [...lane.autonomyPermissionsOverride];
  }
  return Array.isArray(session.autonomyPermissions)
    ? [...session.autonomyPermissions]
    : [...DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS];
}

function effectiveForbiddenActions(
  session: SupervisorSession,
  lane: SupervisorLane,
): SupervisorForbiddenAction[] {
  if (Array.isArray(lane.forbiddenActionsOverride)) {
    return [...lane.forbiddenActionsOverride];
  }
  return Array.isArray(session.forbiddenActions)
    ? [...session.forbiddenActions]
    : [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS];
}

export function buildSupervisorRuntimeContext(
  session: SupervisorSession,
  lane: SupervisorLane,
  options: {
    taskState?: string;
    permissionBlocked?: boolean;
    project?: SupervisorProjectContext;
  } = {},
): SupervisorRuntimeContext {
  const permissions = effectivePermissions(session, lane);
  const projectManaged = !!lane.projectManagerProjectId;
  const targetSurfaceId = lane.surfaceId;
  const laneState = supervisorLaneControlState(lane);
  const laneActive = laneState === 'active';
  const autoDecisionsUsed = Math.max(0, lane.autoDecisionsUsed || 0);
  const maxAutoDecisions = session.maxAutoDecisions;
  const project = options.project;
  const autonomous = typeof lane.autonomousOverride === 'boolean'
    ? lane.autonomousOverride
    : session.autonomous === true;
  const preflight = evaluateSupervisorDecisionPreflight(session, lane, options);
  const decisionBlockers = preflight.blockers;
  const baseDecisionReady = preflight.baseReady;
  const reviewReady = preflight.reviewReady;
  const proactiveProjectReady = preflight.proactiveProjectReady;
  const sameRouteAvailable = (reviewReady || proactiveProjectReady)
    && options.taskState !== 'working'
    && permissions.includes('same-route-next');
  const permissionConfirmationAvailable = reviewReady
    && !projectManaged
    && options.permissionBlocked === true
    && lane.remoteSshControl !== true
    && permissions.includes('permission-confirm');
  const terminalOutcomeAvailable = reviewReady && options.taskState !== 'working';
  const reviewFlag = lane.activeReviewId ? ` --review-id ${lane.activeReviewId}` : '';
  const decisionOutcomes: SupervisorRuntimeContext['commands']['decisionOutcomes'] = laneActive
    ? [
        ...(sameRouteAvailable ? ['continue', 'rework'] as const : []),
        ...(terminalOutcomeAvailable ? ['complete'] as const : []),
        ...(terminalOutcomeAvailable ? ['needs-human'] as const : []),
      ]
    : [];
  const conditional: SupervisorConditionalCommand[] = [
    {
      command: projectManaged
        ? `wmux supervisor decide --surface ${targetSurfaceId}${reviewFlag} --outcome continue|rework --next <成果与验收缺口>`
        : `wmux supervisor decide --surface ${targetSurfaceId}${reviewFlag} --outcome continue|rework --task-file <.wmux/tmp/成果任务.json>`,
      available: sameRouteAvailable,
      condition: projectManaged
        ? '仅限原目标内明确、低风险、可逆且可验证的下一步'
        : '结构化任务只包含当前成果、约束、验收缺口和必要现状',
    },
    {
      command: `wmux supervisor decide --surface ${targetSurfaceId}${reviewFlag} --permission-command <命令> --permission-response y`,
      available: permissionConfirmationAvailable,
      condition: projectManaged
        ? '还必须命中当前任务合同的定向测试或 allowedCommandPrefixes，且不得触及硬性禁止项'
        : '仅限已核对的低风险、可逆权限请求，且不得触及硬性禁止项',
    },
  ];
  const supervisorLauncher = detectSupervisorLauncher(session.supervisorLaunchCmd);
  const currentOrdinaryPlan = !projectManaged
    ? lane.decisions?.find((decision) => decision.ordinaryPlan)?.ordinaryPlan
    : undefined;

  return {
    ok: true,
    role: projectManaged ? 'project-supervisor' : 'supervisor',
    identity: {
      supervisorSurfaceId: lane.supervisorSurfaceId || '',
      targetSurfaceId,
      laneId: lane.id,
      ...(lane.activeReviewId ? { reviewId: lane.activeReviewId } : {}),
      ...(lane.projectManagerProjectId ? { projectId: lane.projectManagerProjectId } : {}),
      ...(project?.goalId ? { goalId: project.goalId } : {}),
      ...(lane.projectWorkItemId ? { workItemId: lane.projectWorkItemId } : {}),
      ...(project?.requirementsVersion !== undefined
        ? { requirementsVersion: project.requirementsVersion }
        : {}),
      ...(project?.authorizationVersion !== undefined
        ? { authorizationVersion: project.authorizationVersion }
        : {}),
      ...(session.supervisorLaunchCmd.trim() ? {
        agent: supervisorLauncher === 'other'
          ? session.supervisorLaunchCmd.trim()
          : supervisorLauncher,
      } : {}),
      ...(session.supervisorModel.trim() ? { model: session.supervisorModel.trim() } : {}),
      ...(session.supervisorReasoningEffort.trim()
        ? { reasoningEffort: session.supervisorReasoningEffort.trim() }
        : {}),
    },
    state: {
      lane: laneState,
      task: options.taskState || 'unknown',
      autonomous,
      decision: baseDecisionReady
        ? decisionOutcomes.length > 0
          ? 'ready'
          : 'not-awaiting-review'
        : 'blocked',
      decisionBlockers,
    },
    permissions: {
      autonomy: permissions,
      workScope: lane.workScopeOverride || session.workScope || DEFAULT_SUPERVISOR_WORK_SCOPE,
      forbiddenActions: effectiveForbiddenActions(session, lane),
    },
    commands: {
      available: [
        'wmux context',
        'wmux supervisor evidence --review-id <本轮ID> --file（优先）',
        'wmux supervisor evidence --review-id <本轮ID> [--page N] [--page-lines N]（文件不可用时兜底）',
        `wmux read-screen --surface ${targetSurfaceId}`,
        `wmux agent-state --surface ${targetSurfaceId}`,
        'wmux supervisor decide --help',
        ...(decisionOutcomes.length > 0
          ? [`wmux supervisor decide --surface ${targetSurfaceId}${reviewFlag} --outcome <结果>`]
          : []),
      ],
      decisionOutcomes,
      conditional,
      forbidden: [
        'wmux send/send-key 向其他终端输入',
        '直接修改项目交付文件或代替任务 AI 执行实现/测试',
        '创建子代理或额外 wmux 任务终端',
        '调用未在 available/conditional 中列出的项目管理命令',
      ],
    },
    budget: {
      autoDecisionsUsed,
      maxAutoDecisions,
      autoDecisionsRemaining: maxAutoDecisions === null
        ? null
        : Math.max(0, maxAutoDecisions - autoDecisionsUsed),
      ...(project?.attempts !== undefined ? {
        projectAttempts: project.attempts,
        projectRetriesRemaining: project.maxTaskRetries === undefined
          ? undefined
          : Math.max(0, project.maxTaskRetries - project.attempts),
      } : {}),
    },
    ...(currentOrdinaryPlan ? {
      plan: {
        revision: currentOrdinaryPlan.revision,
        objective: currentOrdinaryPlan.objective,
        milestones: currentOrdinaryPlan.milestones.map((milestone) => ({
          id: milestone.id,
          status: milestone.status,
          outcome: milestone.outcome,
        })),
        remainingWork: [...currentOrdinaryPlan.remainingWork],
      },
    } : {}),
  };
}

export function buildSupervisorCapabilityCard(context: SupervisorRuntimeContext): string[] {
  const enabledConditional = context.commands.conditional
    .filter((item) => item.available)
    .map((item) => item.command);
  return [
    '## 监督身份与能力快照（控制层）',
    `身份: ${context.role}`,
    `监督终端: ${context.identity.supervisorSurfaceId || '（启动中）'}`,
    `唯一任务终端: ${context.identity.targetSurfaceId}`,
    context.identity.reviewId ? `当前复核 ID: ${context.identity.reviewId}` : '当前复核 ID: 无',
    context.identity.projectId
      ? `项目绑定: ${context.identity.projectId} / ${context.identity.goalId || '（目标待绑定）'} / ${context.identity.workItemId || '（工作项待绑定）'}`
      : '项目绑定: 无（普通监督模式）',
    `自主权限: ${context.permissions.autonomy.join('、') || '无'}`,
    `裁决状态: ${context.state.decision}${context.state.decisionBlockers.length > 0
      ? `（${context.state.decisionBlockers.join('；')}）`
      : ''}`,
    `可用裁决: ${context.commands.decisionOutcomes.join('、')}`,
    context.plan
      ? `监督成果计划: r${context.plan.revision}；目标=${context.plan.objective || '（未设置）'}；剩余=${context.plan.remainingWork.join('、') || '无'}`
      : context.role === 'project-supervisor'
        ? '监督成果计划: 只维护阶段成果、验收缺口、检查点和剩余成果，不维护实现路线、写入路径或命令'
        : '监督成果计划: 根据用户规划用 --stage-plan-file 建立；只记录 objective、成果、验收和剩余工作',
    context.role === 'supervisor'
      ? '普通监督职责: 只通过 --task-file 下发当前成果、约束和验收缺口；不向任务 AI 注入 wmux 角色协议、完整规划、实现路线、文件、命令或技能。'
      : '项目监督职责: 只编排阶段成果、检查规范和证据，不规定任务 AI 的实现路线、文件、命令或技能。任务 AI 完整遵循目标项目 AGENTS、技能和产物规范；发现违规时阻断检查点并由原任务 AI 返工。',
    `核心命令: ${context.commands.available.join('；')}`,
    enabledConditional.length > 0 ? `当前条件命令: ${enabledConditional.join('；')}` : '当前条件命令: 无',
    '实时查询: 每次唤醒先运行 wmux context。返回值由当前终端 capability 绑定，不接受手工指定或伪造身份。',
    '以上信息只说明当前允许提交的监督动作，不授予直接实现、测试、跨终端输入或其他项目管理权限。',
    '',
  ];
}
