import type {
  SupervisorDecision,
  OrdinarySupervisorPlan,
  SupervisorLaneControlState,
} from '../store/supervisor-slice';
import type {
  ProjectSubgoalStatus,
  ProjectSupervisorTransition,
  ProjectTaskBatch,
  ProjectWorkItemStatus,
} from '../../shared/project-manager';
import { isAgentPromptReadyState } from '../agent-state-semantics';

export interface SupervisorTaskAgentState {
  state?: string;
  blockedReason?: string | null;
}

export interface SupervisorStatusSummary {
  label: string;
  detail: string;
  title: string;
}

export interface SupervisorPlanViewStep {
  id: string;
  title: string;
  outcome: string;
  status: 'planned' | 'active' | 'completed';
  evidence?: string;
}

export interface SupervisorPlanView {
  sourceLabel: '项目 AI 工作项' | '用户任务';
  mode: 'forming' | 'direct' | 'staged';
  modeLabel: string;
  route: string;
  nextInstruction: string;
  steps: SupervisorPlanViewStep[];
  completedSteps: number;
}

export interface ProjectManagedStatusSummary {
  workItemLabel: string;
  supervisorLabel: string;
  detail: string;
  attention: boolean;
}

export function isProjectSupervisorAssignmentPending(options: {
  workItemStatus: ProjectWorkItemStatus;
  workItemLaneId?: string;
  workItemAssignmentVersion?: number;
  laneId?: string;
  laneAssignmentVersion?: number;
  laneControlState: SupervisorLaneControlState;
  laneAwaitingReview?: boolean;
  taskContractPending?: boolean;
  latestBlocker?: string;
}): boolean {
  return options.workItemStatus === 'waiting-decision'
    && options.laneControlState === 'active'
    && !!options.workItemLaneId
    && options.workItemLaneId === options.laneId
    && typeof options.workItemAssignmentVersion === 'number'
    && options.workItemAssignmentVersion === options.laneAssignmentVersion
    && (
      options.laneAwaitingReview === true
      || options.taskContractPending === true
      || options.latestBlocker?.trim().startsWith('等待专属监督') === true
    );
}

export function compactProjectAlertSummary(value: string, maxLength = 180): string {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (normalized.length <= maxLength) return normalized;
  const candidate = normalized.slice(0, maxLength);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf('。'),
    candidate.lastIndexOf('！'),
    candidate.lastIndexOf('？'),
    candidate.lastIndexOf('；'),
  );
  const end = sentenceEnd >= Math.floor(maxLength * 0.55) ? sentenceEnd + 1 : maxLength;
  return `${candidate.slice(0, end).trimEnd()}…`;
}

const PROJECT_TRANSITION_LABELS: Record<ProjectSupervisorTransition['kind'], {
  workItemLabel: string;
  supervisorLabel: string;
  planLabel: string;
  nextInstruction: string;
}> = {
  'stage-complete': {
    workItemLabel: '等待项目 AI 验收',
    supervisorLabel: '完成结果已交接',
    planLabel: '等待项目 AI 验收',
    nextInstruction: '项目 AI 正在核验完成结果并推进阶段',
  },
  'direction-needed': {
    workItemLabel: '等待项目 AI 重规划',
    supervisorLabel: '方向问题已交接',
    planLabel: '等待项目 AI 重规划',
    nextInstruction: '项目 AI 正在调整任务方向，尚未下发新的执行批次',
  },
  'decision-required': {
    workItemLabel: '等待项目 AI 处理',
    supervisorLabel: '决策问题已交接',
    planLabel: '等待项目 AI 处理',
    nextInstruction: '项目 AI 正在处理监督交接，尚未下发新的执行批次',
  },
  'supervisor-unavailable': {
    workItemLabel: '等待监督恢复',
    supervisorLabel: '监督不可用',
    planLabel: '等待监督恢复',
    nextInstruction: '项目 AI 正在恢复或重新分配监督通道',
  },
  'supervisor-idle': {
    workItemLabel: '等待项目 AI 续接',
    supervisorLabel: '监督已空闲',
    planLabel: '等待项目 AI 续接',
    nextInstruction: '项目 AI 正在确认下一批任务或结束当前工作项',
  },
  'project-action-required': {
    workItemLabel: '等待项目 AI 操作',
    supervisorLabel: '项目操作待处理',
    planLabel: '等待项目 AI 操作',
    nextInstruction: '项目 AI 正在处理控制面操作，暂未下发新的执行批次',
  },
};

export function projectSupervisorTransitionLabel(kind: ProjectSupervisorTransition['kind']): string {
  return PROJECT_TRANSITION_LABELS[kind].workItemLabel;
}

/** Project work-item state is authoritative; lane state only describes the bound supervisor channel. */
export function summarizeProjectManagedStatus(options: {
  workItemStatus: ProjectWorkItemStatus;
  laneControlState: SupervisorLaneControlState;
  pendingTransition?: Pick<ProjectSupervisorTransition, 'kind' | 'summary'>;
  latestBlocker?: string;
  supervisorAssignmentPending?: boolean;
}): ProjectManagedStatusSummary {
  if (options.workItemStatus === 'completed') {
    return { workItemLabel: '已完成', supervisorLabel: '已结束', detail: '工作项已由项目 AI 验收', attention: false };
  }
  if (options.workItemStatus === 'stopped') {
    return { workItemLabel: '已关闭', supervisorLabel: '已结束', detail: '工作项已停止并保留审计记录', attention: false };
  }
  if (options.pendingTransition) {
    const presentation = PROJECT_TRANSITION_LABELS[options.pendingTransition.kind];
    return {
      workItemLabel: presentation.workItemLabel,
      supervisorLabel: presentation.supervisorLabel,
      detail: options.pendingTransition.summary.trim() || presentation.nextInstruction,
      attention: true,
    };
  }
  if (options.supervisorAssignmentPending) {
    return {
      workItemLabel: '等待监督 AI 处理',
      supervisorLabel: '任务已交接',
      detail: options.latestBlocker?.trim() || '项目 AI 已完成派发，正在等待专属监督确认并形成下一步裁决',
      attention: false,
    };
  }
  if (options.workItemStatus === 'planned' && !options.latestBlocker?.trim()) {
    return {
      workItemLabel: '等待派发',
      supervisorLabel: '监督待分配',
      detail: '项目 AI 已清除原阻塞，等待建立新的监督任务绑定',
      attention: false,
    };
  }
  if (options.laneControlState === 'paused') {
    return {
      workItemLabel: options.workItemStatus === 'waiting-decision' ? '已暂停 · 等待项目 AI 处理' : '已暂停',
      supervisorLabel: '监督已暂停',
      detail: options.latestBlocker?.trim() || '监督通道已暂停，任务上下文保留，等待项目 AI 处理后恢复',
      attention: true,
    };
  }
  if (options.workItemStatus === 'waiting-decision') {
    return {
      workItemLabel: '等待项目 AI 处理',
      supervisorLabel: '等待交接回执',
      detail: options.latestBlocker?.trim() || '监督结果已返回，等待项目 AI 重规划、验收或升级为明确的用户问题',
      attention: true,
    };
  }
  if (options.workItemStatus === 'failed') {
    return {
      workItemLabel: '执行失败',
      supervisorLabel: '等待项目 AI 处理',
      detail: options.latestBlocker?.trim() || '工作项执行失败，等待项目 AI 选择恢复路线',
      attention: true,
    };
  }
  if (options.workItemStatus === 'waiting-dependencies') {
    return { workItemLabel: '等待依赖', supervisorLabel: '监督已连接', detail: '前置阶段或工作项尚未闭合', attention: false };
  }
  if (options.workItemStatus === 'paused') {
    return { workItemLabel: '已暂停', supervisorLabel: '已暂停', detail: '任务上下文和监督通道已保留', attention: true };
  }
  if (options.workItemStatus === 'validating') {
    return { workItemLabel: '验收中', supervisorLabel: '正在复核', detail: '监督 AI 正在核验结果和证据', attention: false };
  }
  if (options.workItemStatus === 'running') {
    return {
      workItemLabel: '任务执行中',
      supervisorLabel: options.laneControlState === 'active' ? '监督已连接' : '监督通道待恢复',
      detail: '任务 AI 正在执行当前成果批次',
      attention: options.laneControlState !== 'active',
    };
  }
  return {
    workItemLabel: '待派遣',
    supervisorLabel: options.laneControlState === 'active' ? '监督已连接' : '等待监督通道',
    detail: '项目 AI 尚未启动当前工作项',
    attention: false,
  };
}

export interface ProjectSubgoalStatusSummary {
  label: string;
  detail: string;
  attention: boolean;
}

const PROJECT_SUBGOAL_STATUS_LABELS: Record<ProjectSubgoalStatus, string> = {
  planned: '规划中',
  active: '进行中',
  blocked: '阻塞中',
  achieved: '已达成',
  obsolete: '已取消',
};

/** Make stage drift visible without claiming a stage is achieved before the control plane records it. */
export function summarizeProjectSubgoalStatus(options: {
  status: ProjectSubgoalStatus;
  workItemStatuses: readonly ProjectWorkItemStatus[];
}): ProjectSubgoalStatusSummary {
  const statuses = options.workItemStatuses;
  if (options.status === 'achieved' || options.status === 'obsolete') {
    return { label: PROJECT_SUBGOAL_STATUS_LABELS[options.status], detail: '', attention: false };
  }
  if (options.status === 'blocked') {
    return { label: '阻塞中', detail: '阶段已被项目 AI 明确标记为阻塞', attention: true };
  }
  const waitingForProjectAi = statuses.some((status) => status === 'waiting-decision' || status === 'failed');
  if (waitingForProjectAi) {
    return { label: '工作项待处理', detail: '阶段内有工作项等待项目 AI 处理', attention: true };
  }
  const executing = statuses.some((status) => status === 'running' || status === 'validating');
  if (executing) {
    return { label: '工作项执行中', detail: '阶段内已有工作项进入执行或验收', attention: false };
  }
  if (statuses.some((status) => status === 'paused')) {
    return { label: '工作项已暂停', detail: '阶段内有工作项暂停，等待恢复', attention: true };
  }
  if (statuses.length > 0 && statuses.every((status) => status === 'waiting-dependencies')) {
    return { label: '等待阶段依赖', detail: '阶段内工作项仍在等待前置依赖', attention: false };
  }
  if (statuses.length > 0 && statuses.every((status) => status === 'completed')) {
    return { label: '待阶段闭合', detail: '工作项已经完成，但项目 AI 尚未将阶段标记为已达成', attention: true };
  }
  if (statuses.some((status) => status === 'completed' || status === 'stopped')) {
    return { label: '部分工作已结束', detail: '项目 AI 仍需评估阶段剩余工作', attention: false };
  }
  return { label: PROJECT_SUBGOAL_STATUS_LABELS[options.status], detail: '', attention: false };
}

/** One display model for project-managed and ordinary supervisor consoles. */
export function buildSupervisorPlanView(options: {
  source: 'project-ai' | 'user';
  task: string;
  ordinaryPlan?: OrdinarySupervisorPlan;
  projectTaskBatch?: ProjectTaskBatch;
  latestDecision?: SupervisorDecision;
  pendingTransition?: Pick<ProjectSupervisorTransition, 'kind' | 'summary'>;
  workItemStatus?: ProjectWorkItemStatus;
  latestBlocker?: string;
  supervisorAssignmentPending?: boolean;
}): SupervisorPlanView {
  const ordinaryPlan = options.ordinaryPlan || options.latestDecision?.ordinaryPlan;
  const task = options.task.trim() || '当前任务';
  if (options.source === 'project-ai' && options.pendingTransition) {
    const presentation = PROJECT_TRANSITION_LABELS[options.pendingTransition.kind];
    return {
      sourceLabel: '项目 AI 工作项',
      mode: 'forming',
      modeLabel: presentation.planLabel,
      route: options.pendingTransition.summary.trim() || presentation.workItemLabel,
      nextInstruction: presentation.nextInstruction,
      steps: [],
      completedSteps: 0,
    };
  }
  if (options.source === 'project-ai' && options.supervisorAssignmentPending) {
    return {
      sourceLabel: '项目 AI 工作项',
      mode: 'forming',
      modeLabel: '等待监督 AI 处理',
      route: options.latestBlocker?.trim() || '项目 AI 已完成派发，专属监督正在接收任务合同',
      nextInstruction: '专属监督确认后将核对现状并决定首次派发、继续、返工或完成',
      steps: [],
      completedSteps: 0,
    };
  }
  if (options.source === 'project-ai' && options.workItemStatus === 'waiting-decision') {
    return {
      sourceLabel: '项目 AI 工作项',
      mode: 'forming',
      modeLabel: '等待项目 AI 处理',
      route: options.latestBlocker?.trim() || '监督结果已返回，等待项目 AI 完成当前交接',
      nextInstruction: '项目 AI 尚未下发新的执行批次',
      steps: [],
      completedSteps: 0,
    };
  }
  const activeProjectTaskBatch = options.source === 'project-ai'
    && (!options.latestDecision || ['continue', 'rework'].includes(options.latestDecision.outcome))
    ? options.projectTaskBatch
    : undefined;
  if (activeProjectTaskBatch) {
    return {
      sourceLabel: '项目 AI 工作项',
      mode: 'direct',
      modeLabel: '单成果批次执行',
      route: options.latestDecision?.reason.trim() || task,
      nextInstruction: activeProjectTaskBatch.outcome,
      steps: [],
      completedSteps: 0,
    };
  }
  if (ordinaryPlan) {
    const steps = ordinaryPlan.milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      outcome: milestone.outcome,
      status: milestone.status,
      ...(milestone.evidence ? { evidence: milestone.evidence } : {}),
    }));
    const mode = steps.length > 1 ? 'staged' as const : 'direct' as const;
    const activeStep = steps.find((step) => step.status === 'active')
      || steps.find((step) => step.status === 'planned');
    return {
      sourceLabel: '用户任务',
      mode,
      modeLabel: mode === 'staged' ? '分阶段监督执行' : '直接监督执行',
      route: ordinaryPlan.objective,
      nextInstruction: options.latestDecision?.taskDispatch?.outcome
        || activeStep?.outcome
        || ordinaryPlan.remainingWork[0]
        || '等待任务 AI 返回结果后复核',
      steps,
      completedSteps: steps.filter((step) => step.status === 'completed').length,
    };
  }
  const next = options.latestDecision?.next.trim();
  const route = options.latestDecision?.reason.trim()
    || `尚未形成正式路线；上级任务：${task}`;
  const awaitingClarification = options.latestDecision?.proposalKind === 'clarification';
  return {
    sourceLabel: options.source === 'project-ai' ? '项目 AI 工作项' : '用户任务',
    mode: 'forming',
    modeLabel: awaitingClarification
      ? '等待需求对齐'
      : options.latestDecision
        ? '形成正式路线中'
        : '等待首次规划',
    route,
    nextInstruction: awaitingClarification
      ? '等待用户集中答复后形成正式计划'
      : next || '等待监督 AI 提交第一条可执行指令',
    steps: next && !awaitingClarification ? [{
      id: `decision-${options.latestDecision?.ts || 0}`,
      title: '当前执行项',
      outcome: next,
      status: 'active',
    }] : [],
    completedSteps: 0,
  };
}

export function summarizeSupervisorPlan(options: {
  latestDecision?: SupervisorDecision;
  currentTask?: string;
  taskGoal?: string;
  planFileName?: string;
}): SupervisorStatusSummary {
  const decision = options.latestDecision;
  if (decision) {
    const labels: Record<SupervisorDecision['outcome'], string> = {
      continue: '按当前路线继续',
      rework: '正在调整方案',
      complete: '本轮规划已完成',
      'needs-human': '等待人工决策',
    };
    const detail = decision.taskDispatch?.outcome.trim()
      || decision.next.trim()
      || decision.reason.trim()
      || '监督 AI 未附具体下一步';
    return {
      label: decision.contextHealth === 'degraded' ? '上下文纠偏中' : labels[decision.outcome],
      detail,
      title: [`裁决：${decision.outcome}`, decision.reason ? `原因：${decision.reason}` : '', `下一步：${detail}`]
        .filter(Boolean).join('\n'),
    };
  }
  if (options.planFileName) {
    return {
      label: '按计划文件推进',
      detail: options.planFileName,
      title: `当前监督配置绑定计划文件：${options.planFileName}`,
    };
  }
  const task = options.currentTask?.trim() || options.taskGoal?.trim();
  if (task) {
    return {
      label: options.currentTask?.trim() ? '执行当前任务' : '围绕目标规划',
      detail: task,
      title: task,
    };
  }
  return {
    label: '等待任务上报',
    detail: '收到任务后由监督 AI 给出下一步',
    title: '当前通道尚未收到可展示的任务或监督裁决。',
  };
}

export function summarizeTaskExecution(
  options: {
    controlState: SupervisorLaneControlState;
    currentTask?: string;
    awaitingReview?: boolean;
    stopConfirmed?: boolean;
  },
  agentState: SupervisorTaskAgentState | undefined,
): SupervisorStatusSummary {
  if (options.controlState === 'stopped') {
    return { label: '已停止', detail: '监督通道已结束', title: '监督通道已停止。' };
  }
  if (options.stopConfirmed || options.controlState === 'waiting') {
    return { label: '等待下一步', detail: '当前任务已结束，等待新的方向', title: '监督通道处于待续状态。' };
  }
  if (agentState?.state === 'working') {
    return {
      label: '执行中',
      detail: options.currentTask?.trim() || '任务 AI 正在处理当前任务',
      title: '实时 Agent 状态：working',
    };
  }
  if (agentState?.state === 'blocked' && !isAgentPromptReadyState(agentState)) {
    const reason = agentState.blockedReason?.trim() || '等待输入、权限或外部条件';
    return {
      label: '已阻塞',
      detail: reason,
      title: `实时 Agent 状态：blocked\n${reason}`,
    };
  }
  if (isAgentPromptReadyState(agentState)) {
    return {
      label: options.awaitingReview ? '等待监督复核' : '空闲待命',
      detail: options.awaitingReview
        ? '任务回合已结束，监督 AI 正在复核'
        : '任务 AI 当前没有执行动作',
      title: '实时 Agent 状态：idle',
    };
  }
  const fallback: Record<SupervisorLaneControlState, SupervisorStatusSummary> = {
    active: {
      label: options.awaitingReview ? '等待监督复核' : '状态待上报',
      detail: options.awaitingReview ? '任务回合已结束，监督 AI 正在复核' : '尚未收到可信的任务 Agent 状态',
      title: '实时 Agent 状态：unknown',
    },
    paused: { label: '已暂停', detail: '任务上下文已保留', title: '监督通道已暂停。' },
    waiting: { label: '等待下一步', detail: '当前任务已结束，等待新的方向', title: '监督通道处于待续状态。' },
    stopped: { label: '已停止', detail: '监督通道已结束', title: '监督通道已停止。' },
  };
  return fallback[options.controlState];
}
