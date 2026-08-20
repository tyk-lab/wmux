import type { SupervisorDecisionOption } from '../../shared/supervisor-decision-options';

export {
  supervisorDecisionOptions,
  type SupervisorDecisionOption,
} from '../../shared/supervisor-decision-options';

export function buildAdoptedPlanBriefing(options: {
  surfaceId: string;
  selection?: SupervisorDecisionOption;
  userGuidance?: string;
  recommendation: string;
  reason?: string;
  impact?: string;
  alternatives?: string;
  clarification?: boolean;
}): string {
  const userGuidance = options.userGuidance?.trim() || '';
  if (options.clarification) {
    return [
      '[需求对齐答复] 用户已集中回答普通监督提出的实质歧义问题。',
      userGuidance ? `[用户集中答复] ${userGuidance}` : '',
      options.reason?.trim() ? `[原对齐问题] ${options.reason.trim()}` : '',
      options.impact?.trim() ? `[答案影响] ${options.impact.trim()}` : '',
      options.alternatives?.trim() ? `[AI 推荐默认答案] ${options.alternatives.trim()}` : '',
      '',
      '先根据整组答复完成需求对齐；不得重复询问已经回答的内容。仍有会实质改变方向、范围或验收的歧义时，才可再提出一批必要问题。',
      `对齐充分后，创建 .wmux/tmp/ 下的阶段计划 JSON，并使用 wmux supervisor decide --surface ${options.surfaceId} --outcome continue 或 rework --stage-plan-file <文件> 携带第一条 --next；计划形成前不得向任务 AI 投递。`,
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
  }
  return [
    options.selection
      ? '[人工决定] 用户已选择 AI 监督提出的方案，请结合用户补充信息重新判断并处理。'
      : '[人工决定] 用户未指定固定方案，请根据补充信息和任务终端最新状态判断并处理。',
    options.selection
      ? `[用户选择] ${options.selection.value}：${options.selection.detail}`
      : '[用户选择] 未指定固定方案，由 AI 监督判断。',
    userGuidance ? `[用户补充信息] ${userGuidance}` : '',
    options.recommendation.trim() ? `[AI 原建议] ${options.recommendation.trim()}` : '',
    options.reason?.trim() ? `[待决事项] ${options.reason.trim()}` : '',
    options.impact?.trim() ? `[决策原因] ${options.impact.trim()}` : '',
    options.alternatives?.trim() ? `[AI 备选方案] ${options.alternatives.trim()}` : '',
    '',
    '用户补充信息是决策依据，不是可原样发送到任务终端的命令。请先 read-screen 获取任务终端最新状态，再基于用户选择、用户补充信息、当前任务、计划约束和终端证据，判断并整理成完整、明确、可执行的下一步。',
    `整理完成后，使用 wmux supervisor decide --surface ${options.surfaceId} --outcome continue 或 rework 提交最终指令到任务终端；短文本使用 --next，长文本或多行文本写入当前项目 .wmux/tmp/<唯一文件名>.txt 后使用 --next-file，禁止在项目根目录创建监督草稿。不要把本消息原样转发，也不要使用通用 wmux send/send-key。`,
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
}
