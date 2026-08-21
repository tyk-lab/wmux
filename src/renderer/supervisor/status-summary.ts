import type {
  SupervisorDecision,
  SupervisorLaneControlState,
} from '../store/supervisor-slice';
import type { ProjectSupervisorStagePlan } from '../../shared/project-manager';
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

/** One display model for project-managed and ordinary supervisor consoles. */
export function buildSupervisorPlanView(options: {
  source: 'project-ai' | 'user';
  task: string;
  plan?: ProjectSupervisorStagePlan;
  latestDecision?: SupervisorDecision;
  baselineStatus?: 'required' | 'investigating' | 'approved';
}): SupervisorPlanView {
  const plan = options.plan || options.latestDecision?.plan;
  const task = options.task.trim() || '当前任务';
  if (plan) {
    const steps = plan.milestones.map((milestone) => ({ ...milestone }));
    const mode = steps.length > 1 ? 'staged' as const : 'direct' as const;
    const activeStep = steps.find((step) => step.status === 'active')
      || steps.find((step) => step.status === 'planned');
    return {
      sourceLabel: options.source === 'project-ai' ? '项目 AI 工作项' : '用户任务',
      mode,
      modeLabel: mode === 'staged' ? '分阶段监督执行' : '直接监督执行',
      route: plan.selectedRoute,
      nextInstruction: options.latestDecision?.next.trim()
        || activeStep?.outcome
        || plan.remainingWork[0]
        || '等待任务 AI 返回结果后复核',
      steps,
      completedSteps: steps.filter((step) => step.status === 'completed').length,
    };
  }

  const next = options.latestDecision?.next.trim();
  const baselineRoute = options.baselineStatus === 'investigating'
    ? '只读调查当前项目基线，形成可信执行依据'
    : options.baselineStatus === 'required'
      ? '等待任务 AI 调查并建立项目基线'
      : '';
  const route = options.latestDecision?.reason.trim()
    || baselineRoute
    || `尚未形成正式路线；上级任务：${task}`;
  const awaitingClarification = options.latestDecision?.proposalKind === 'clarification';
  return {
    sourceLabel: options.source === 'project-ai' ? '项目 AI 工作项' : '用户任务',
    mode: 'forming',
    modeLabel: awaitingClarification
      ? '等待需求对齐'
      : options.baselineStatus && options.baselineStatus !== 'approved'
      ? '建立基线中'
      : options.latestDecision
        ? '形成正式路线中'
        : '等待首次规划',
    route,
    nextInstruction: awaitingClarification
      ? '等待用户集中答复后形成正式计划'
      : next || (options.baselineStatus === 'investigating'
      ? '等待基线报告，再由监督 AI 审核并形成正式路线'
      : '等待监督 AI 提交第一条可执行指令'),
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
    const detail = decision.next.trim() || decision.reason.trim() || '监督 AI 未附具体下一步';
    return {
      label: labels[decision.outcome],
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
