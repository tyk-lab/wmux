export interface SupervisorDecisionOption {
  value: string;
  title: string;
  detail: string;
}

/** Extract A/B-style AI alternatives into stable choices for desktop decisions. */
export function supervisorDecisionOptions(
  alternatives: string | undefined,
  recommendation: string,
): SupervisorDecisionOption[] {
  const source = alternatives?.trim() || recommendation.trim();
  const matches = [...source.matchAll(/(?:^|[；;\n])\s*(?:方案\s*)?([A-F])\s*(?:[）):：、.]|\s+-)\s*/giu)];
  if (matches.length >= 2) {
    return matches.slice(0, 6).map((match, index) => {
      const key = match[1].toUpperCase();
      const start = (match.index || 0) + match[0].length;
      const end = matches[index + 1]?.index ?? source.length;
      return {
        value: `方案 ${key}`,
        title: `方案 ${key}`,
        detail: source.slice(start, end).replace(/[；;\s]+$/u, '').trim() || '未提供方案说明',
      };
    });
  }
  return [{
    value: '采用 AI 当前建议',
    title: '采用 AI 当前建议',
    detail: recommendation.trim() || 'AI 未提供具体下一步，请选择后由 AI 监督结合终端状态整理。',
  }];
}

export function buildAdoptedPlanBriefing(options: {
  surfaceId: string;
  selection: SupervisorDecisionOption;
  recommendation: string;
  reason?: string;
  impact?: string;
  alternatives?: string;
}): string {
  return [
    '[人工决定] 用户已选择采用 AI 监督提出的方案。',
    `[用户选择] ${options.selection.value}：${options.selection.detail}`,
    options.recommendation.trim() ? `[AI 原建议] ${options.recommendation.trim()}` : '',
    options.reason?.trim() ? `[待决事项] ${options.reason.trim()}` : '',
    options.impact?.trim() ? `[决策原因] ${options.impact.trim()}` : '',
    options.alternatives?.trim() ? `[AI 备选方案] ${options.alternatives.trim()}` : '',
    '',
    '请先 read-screen 获取任务终端最新状态，再基于用户选择、当前任务、计划约束和终端证据，整理成完整、明确、可执行的下一步。',
    `整理完成后，使用 wmux supervisor decide --surface ${options.surfaceId} --outcome continue 或 rework，并通过 --next 提交最终指令到任务终端；不要把本消息原样转发，也不要使用通用 wmux send/send-key。`,
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
}
