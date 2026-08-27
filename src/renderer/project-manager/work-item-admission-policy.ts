import {
  projectCompletionCriteriaError,
  projectCriterionIdentity,
  projectSubgoalCompletionResult,
  normalizeProjectStageAcceptanceCoverage,
  type ProjectManagerSession,
  type ProjectWorkItem,
} from '../../shared/project-manager';

const CLOSED_WORK_ITEM_STATUSES = new Set(['completed', 'stopped']);

/** Keep one stage outcome open and require a successor to cover every remaining acceptance item. */
export function projectWorkItemCreationError(
  session: Pick<ProjectManagerSession, 'subgoals' | 'workItems'>,
  candidate: ProjectWorkItem,
): string | null {
  const subgoal = (session.subgoals || []).find((item) => (
    item.id === candidate.subgoalId && item.goalId === candidate.goalId
  ));
  if (!subgoal) return null;

  const openItem = session.workItems.find((item) => (
    item.id !== candidate.id
    && item.goalId === candidate.goalId
    && item.subgoalId === candidate.subgoalId
    && !CLOSED_WORK_ITEM_STATUSES.has(item.status)
  ));
  if (openItem) {
    return `阶段“${subgoal.title}”已有开放成果工作项 ${openItem.id}（${openItem.status}）；必须先完成、停止或更新该工作项，不能创建同阶段并行或同义后继任务`;
  }

  const acceptance = subgoal.acceptance
    .map((criterion) => ({ criterion, identity: projectCriterionIdentity(criterion) }))
    .filter((entry) => !!entry.identity);
  if (acceptance.length === 0) return null;
  const completedItems = session.workItems.filter((item) => (
    item.goalId === candidate.goalId
    && item.subgoalId === candidate.subgoalId
    && item.status === 'completed'
  ));
  const stageCompletion = projectSubgoalCompletionResult({
    id: subgoal.id,
    goalId: subgoal.goalId,
    status: 'achieved',
    updatedAt: subgoal.updatedAt,
    completion: undefined,
  }, completedItems, {
    requirementsVersion: candidate.requirementsVersion,
    authorizationVersion: candidate.authorizationVersion,
  });
  const remaining = acceptance.filter((entry) => projectCompletionCriteriaError(
    [entry.criterion],
    stageCompletion,
    '阶段验收',
    { allowExtra: true, requireArtifacts: true },
  ));
  if (remaining.length === 0) {
    return `阶段“${subgoal.title}”的验收已被历史 completion 完整覆盖；必须先用 goal-plan 将阶段更新为 achieved，不能创建同义工作项`;
  }

  const candidateCoverage = new Set(normalizeProjectStageAcceptanceCoverage(
    candidate.contract.stageAcceptanceCoverage,
  ).map((mapping) => projectCriterionIdentity(mapping.stageCriterion)));
  const uncovered = remaining.find((entry) => !candidateCoverage.has(entry.identity));
  return uncovered
    ? `阶段“${subgoal.title}”已有历史成果；新工作项必须一次覆盖全部剩余验收，当前缺少：${uncovered.criterion}`
    : null;
}
