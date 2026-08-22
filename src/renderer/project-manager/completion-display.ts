import type { ProjectCompletionResult } from '../../shared/project-manager';

const STATUS_LABELS: Record<string, string> = {
  satisfied: '条件已满足',
  unsatisfied: '条件未满足',
  unverified: '尚未核验',
};

const RESULT_LABELS: Record<string, string> = {
  passed: '结果通过',
  failed: '结果明确失败',
  inconclusive: '结果无结论',
  'not-run': '未执行',
};

const METHOD_LABELS: Record<string, string> = {
  'runtime-test': '实际运行/实机测试',
  'static-check': '静态检查',
  'evidence-review': '既有证据复核',
};

export function formatProjectCompletionCriteria(completion: ProjectCompletionResult): string {
  return (completion.criteria || []).map((criterion, index) => {
    const artifacts = (criterion.evidenceArtifacts || []).map((artifact) => (
      `${artifact.ref} [sha256:${artifact.sha256.slice(0, 12)}…]`
    ));
    return [
      `${index + 1}. ${criterion.criterion}`,
      `${STATUS_LABELS[criterion.status] || criterion.status}；${RESULT_LABELS[criterion.result] || criterion.result}；${METHOD_LABELS[criterion.method] || criterion.method}`,
      `结论：${criterion.evidence}`,
      `实际证据：${artifacts.length > 0 ? artifacts.join('；') : criterion.evidenceRefs.join('；')}`,
    ].join('\n');
  }).join('\n\n');
}
