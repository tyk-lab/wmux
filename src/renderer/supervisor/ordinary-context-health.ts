import type {
  OrdinaryContextHealthState,
  OrdinaryContextSymptom,
  OrdinarySupervisorPlan,
  OrdinaryTaskDispatch,
  SupervisorLaneConfig,
} from '../store/supervisor-slice';

export const ORDINARY_CONTEXT_SYMPTOMS = [
  'instruction-drift',
  'repeated-mistake',
  'forgotten-plan',
  'contradiction',
  'no-progress',
  'irrelevant-context',
] as const satisfies readonly OrdinaryContextSymptom[];

const ORDINARY_CONTEXT_SYMPTOM_SET = new Set<string>(ORDINARY_CONTEXT_SYMPTOMS);

export function normalizeOrdinaryContextSymptoms(value: unknown): OrdinaryContextSymptom[] {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，;；]/u);
  return [...new Set(source
    .map((item) => String(item).trim())
    .filter((item): item is OrdinaryContextSymptom => ORDINARY_CONTEXT_SYMPTOM_SET.has(item)))];
}

export function nextOrdinaryContextHealthState(options: {
  previous?: OrdinaryContextHealthState;
  symptoms: OrdinaryContextSymptom[];
  signal: string;
  evidenceFingerprint: string;
  reviewId?: string;
  workerTurnId?: number;
  now?: number;
}): OrdinaryContextHealthState {
  const fingerprint = [...options.symptoms].sort().join('|');
  const sameIssue = options.previous?.fingerprint === fingerprint
    && options.previous.evidenceFingerprint === options.evidenceFingerprint;
  const distinctReview = options.previous?.reviewId !== options.reviewId
    || options.previous?.workerTurnId !== options.workerTurnId;
  return {
    fingerprint,
    symptoms: [...options.symptoms],
    signal: options.signal.trim().slice(0, 4_000),
    evidenceFingerprint: options.evidenceFingerprint,
    occurrences: sameIssue
      ? distinctReview ? options.previous!.occurrences + 1 : options.previous!.occurrences
      : 1,
    reviewId: options.reviewId,
    workerTurnId: options.workerTurnId,
    updatedAt: options.now ?? Date.now(),
  };
}

export function ordinaryContextClearCommand(agent: string): string | null {
  return ['codex', 'kimi', 'grok', 'pi', 'opencode'].includes(agent) ? '/new' : null;
}

export function buildOrdinaryContextRecoveryTask(options: {
  config: SupervisorLaneConfig;
  plan?: OrdinarySupervisorPlan;
  dispatch: OrdinaryTaskDispatch;
}): string {
  const completed = (options.plan?.milestones || [])
    .filter((milestone) => milestone.status === 'completed' && milestone.evidence?.trim())
    .slice(-8)
    .map((milestone) => [
      `- ${milestone.title}：${milestone.outcome}`,
      milestone.evidence ? `；已核验证据：${milestone.evidence}` : '',
    ].join(''));
  const objective = options.plan?.objective || options.config.taskGoal.trim()
    || (options.config.planFilePath.trim() ? `遵循计划文件 ${options.config.planFilePath.trim()}` : '完成用户规划');
  return [
    '[上下文已清空｜可信任务恢复]',
    `用户规划版本：r${options.dispatch.sourceRevision}`,
    `用户目标：${objective}`,
    `停止条件：${options.config.stopWhen.trim()}`,
    completed.length > 0 ? `已验证成果：\n${completed.join('\n')}` : '已验证成果：暂无可继承成果；请以项目事实重新核对。',
    '当前成果任务：',
    `成果：${options.dispatch.outcome}`,
    options.dispatch.constraints.length > 0
      ? `约束：\n${options.dispatch.constraints.map((item) => `- ${item}`).join('\n')}`
      : '',
    `验收缺口：\n${options.dispatch.acceptanceGap.map((item) => `- ${item}`).join('\n')}`,
    options.dispatch.evidenceContext.length > 0
      ? `必要现状：\n${options.dispatch.evidenceContext.map((item) => `- ${item}`).join('\n')}`
      : '',
    options.config.taskWorkMode && options.config.taskWorkMode !== 'single-thread'
      ? '原主线程及其内部子线程的对话上下文均已失效；不要等待或恢复旧子线程。新主会话根据剩余成果自行判断是否重新建立内部线程。'
      : '',
    '旧会话上下文已经清空。不要尝试恢复旧对话、旧实现路线或旧命令；先读取当前项目事实，并自行加载和遵循目标项目适用的 AGENTS、技能与仓库规范。你是唯一项目执行者，自主选择实现、测试和内部组织方式。',
  ].filter(Boolean).join('\n\n').slice(0, 12_000);
}
