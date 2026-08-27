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

export function summarizeProjectCompletionCriteria(completion: ProjectCompletionResult): string {
  const criteria = completion.criteria || [];
  if (criteria.length === 0) return '无结构化逐项核验记录';
  const count = (field: 'status' | 'result', value: string): number => (
    criteria.filter((criterion) => criterion[field] === value).length
  );
  const statusParts = [
    ['满足', count('status', 'satisfied')],
    ['未满足', count('status', 'unsatisfied')],
    ['未核验', count('status', 'unverified')],
  ].filter(([, value]) => Number(value) > 0).map(([label, value]) => `${value} ${label}`);
  const resultParts = [
    ['通过', count('result', 'passed')],
    ['明确失败', count('result', 'failed')],
    ['无结论', count('result', 'inconclusive')],
    ['未执行', count('result', 'not-run')],
  ].filter(([, value]) => Number(value) > 0).map(([label, value]) => `${value} ${label}`);
  return `完成定义：${statusParts.join('，')}；验证结果：${resultParts.join('，')}`;
}

export function formatProjectCompletionAuditDetails(
  completion: ProjectCompletionResult,
  evidenceFallback?: string,
): string {
  const evidence = completion.evidence?.trim() || evidenceFallback?.trim();
  return [
    completion.validation.length > 0 ? `完成验证：\n${completion.validation.join('\n')}` : '',
    evidence ? `阶段证据摘要：\n${evidence}` : '',
    completion.criteria?.length ? `逐项核验与实际证据：\n${formatProjectCompletionCriteria(completion)}` : '',
  ].filter(Boolean).join('\n\n');
}
