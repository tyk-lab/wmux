import type { SupervisorDecisionOption } from '../../shared/supervisor-decision-options';

export {
  supervisorDecisionOptions,
  type SupervisorDecisionOption,
} from '../../shared/supervisor-decision-options';

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
