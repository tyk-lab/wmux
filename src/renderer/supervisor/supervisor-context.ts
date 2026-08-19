import type { ProjectSupervisorAuthority } from '../../shared/project-manager';
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

export interface SupervisorProjectContext {
  projectId: string;
  goalId?: string;
  workItemId: string;
  requirementsVersion?: number;
  authorizationVersion?: number;
  authority?: ProjectSupervisorAuthority;
  decisionsUsed?: number;
  maxDecisions?: number;
  attempts?: number;
  maxTaskRetries?: number;
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
    projectId?: string;
    goalId?: string;
    workItemId?: string;
    requirementsVersion?: number;
    authorizationVersion?: number;
  };
  state: {
    lane: string;
    task: string;
    autonomous: boolean;
  };
  permissions: {
    autonomy: SupervisorAutonomyPermission[];
    workScope: SupervisorWorkScope;
    forbiddenActions: SupervisorForbiddenAction[];
    projectAuthority?: ProjectSupervisorAuthority;
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
    projectDecisionsUsed?: number;
    projectDecisionsRemaining?: number;
    projectAttempts?: number;
    projectRetriesRemaining?: number;
  };
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
  options: { taskState?: string; project?: SupervisorProjectContext } = {},
): SupervisorRuntimeContext {
  const permissions = effectivePermissions(session, lane);
  const projectManaged = !!lane.projectManagerProjectId;
  const targetSurfaceId = lane.surfaceId;
  const laneState = supervisorLaneControlState(lane);
  const laneActive = laneState === 'active';
  const autoDecisionsUsed = Math.max(0, lane.autoDecisionsUsed || 0);
  const maxAutoDecisions = session.maxAutoDecisions;
  const project = options.project;
  const sameRouteAvailable = laneActive && permissions.includes('same-route-next');
  const permissionConfirmationAvailable = laneActive
    && permissions.includes('permission-confirm')
    && (!project?.authority || project.authority.permissionConfirm === true);
  const decisionOutcomes: SupervisorRuntimeContext['commands']['decisionOutcomes'] = laneActive
    ? [
        ...(sameRouteAvailable ? ['continue', 'rework'] as const : []),
        'complete',
        'needs-human',
      ]
    : [];
  const conditional: SupervisorConditionalCommand[] = [
    {
      command: `wmux supervisor decide --surface ${targetSurfaceId} --outcome continue|rework --next <指令>`,
      available: sameRouteAvailable,
      condition: '仅限原目标内明确、低风险、可逆且可验证的下一步',
    },
    {
      command: `wmux supervisor decide --surface ${targetSurfaceId} --permission-command <命令> --permission-response y`,
      available: permissionConfirmationAvailable,
      condition: projectManaged
        ? '还必须命中当前任务合同的定向测试或 allowedCommandPrefixes，且不得触及硬性禁止项'
        : '仅限已核对的低风险、可逆权限请求，且不得触及硬性禁止项',
    },
    {
      command: `wmux project task-terminal-start --project ${lane.projectManagerProjectId || '<项目ID>'} --task ${lane.projectWorkItemId || '<工作项ID>'}`,
      available: laneActive && projectManaged && lane.projectTaskStartupPending === true,
      condition: '仅在项目监督启动阶段、真实任务终端尚未创建时执行一次',
    },
    {
      command: `wmux project task-terminal-rotate --project ${lane.projectManagerProjectId || '<项目ID>'} --task ${lane.projectWorkItemId || '<工作项ID>'}`,
      available: laneActive && projectManaged && lane.projectTaskRotationPending === true,
      condition: '仅在项目 AI 已登记当前工作项的上下文轮换请求后执行',
    },
    {
      command: `wmux project task-terminal-control --project ${lane.projectManagerProjectId || '<项目ID>'} --task ${lane.projectWorkItemId || '<工作项ID>'} --key <escape|interrupt> --reason <证据>`,
      available: laneActive
        && projectManaged
        && lane.projectTaskStartupPending !== true
        && options.taskState === 'working',
      condition: '仅按项目执行链活性检查规则处理持续无语义输出的 working 任务',
    },
  ];

  return {
    ok: true,
    role: projectManaged ? 'project-supervisor' : 'supervisor',
    identity: {
      supervisorSurfaceId: lane.supervisorSurfaceId || '',
      targetSurfaceId,
      laneId: lane.id,
      ...(lane.projectManagerProjectId ? { projectId: lane.projectManagerProjectId } : {}),
      ...(project?.goalId ? { goalId: project.goalId } : {}),
      ...(lane.projectWorkItemId ? { workItemId: lane.projectWorkItemId } : {}),
      ...(project?.requirementsVersion !== undefined
        ? { requirementsVersion: project.requirementsVersion }
        : {}),
      ...(project?.authorizationVersion !== undefined
        ? { authorizationVersion: project.authorizationVersion }
        : {}),
    },
    state: {
      lane: laneState,
      task: options.taskState || 'unknown',
      autonomous: typeof lane.autonomousOverride === 'boolean'
        ? lane.autonomousOverride
        : session.autonomous === true,
    },
    permissions: {
      autonomy: permissions,
      workScope: lane.workScopeOverride || session.workScope || DEFAULT_SUPERVISOR_WORK_SCOPE,
      forbiddenActions: effectiveForbiddenActions(session, lane),
      ...(project?.authority ? {
        projectAuthority: {
          ...project.authority,
          allowedCommandPrefixes: [...(project.authority.allowedCommandPrefixes || [])],
          authorizedDevices: [...(project.authority.authorizedDevices || [])],
          authorizedEnvironments: [...(project.authority.authorizedEnvironments || [])],
          authorizedOperations: [...(project.authority.authorizedOperations || [])],
        },
      } : {}),
    },
    commands: {
      available: [
        'wmux supervisor context',
        `wmux read-screen --surface ${targetSurfaceId}`,
        `wmux agent-state --surface ${targetSurfaceId}`,
        'wmux supervisor decide --help',
        ...(laneActive
          ? [`wmux supervisor decide --surface ${targetSurfaceId} --outcome <结果>`]
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
      ...(project?.decisionsUsed !== undefined ? {
        projectDecisionsUsed: project.decisionsUsed,
        projectDecisionsRemaining: project.maxDecisions === undefined
          ? undefined
          : Math.max(0, project.maxDecisions - project.decisionsUsed),
      } : {}),
      ...(project?.attempts !== undefined ? {
        projectAttempts: project.attempts,
        projectRetriesRemaining: project.maxTaskRetries === undefined
          ? undefined
          : Math.max(0, project.maxTaskRetries - project.attempts),
      } : {}),
    },
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
    context.identity.projectId
      ? `项目绑定: ${context.identity.projectId} / ${context.identity.goalId || '（目标待绑定）'} / ${context.identity.workItemId || '（工作项待绑定）'}`
      : '项目绑定: 无（普通监督模式）',
    `自主权限: ${context.permissions.autonomy.join('、') || '无'}`,
    `可用裁决: ${context.commands.decisionOutcomes.join('、')}`,
    `核心命令: ${context.commands.available.join('；')}`,
    enabledConditional.length > 0 ? `当前条件命令: ${enabledConditional.join('；')}` : '当前条件命令: 无',
    '实时查询: 每次唤醒先运行 wmux supervisor context；其返回值由当前终端 capability 绑定，不接受手工指定或伪造身份。',
    '以上信息只说明当前允许提交的监督动作，不授予直接实现、测试、跨终端输入或其他项目管理权限。',
    '',
  ];
}
