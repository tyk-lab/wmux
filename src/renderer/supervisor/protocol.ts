import type {
  StopWhenKind,
  SupervisorLane,
  SupervisorMode,
  SupervisorSession,
  SupervisorStep,
} from '../store/supervisor-slice';

export function modeLabel(mode: SupervisorMode): string {
  return mode === 'direct' ? '直接注入' : '目标追逐';
}

export function modeDescription(mode: SupervisorMode): string {
  if (mode === 'direct') {
    return '指令原样注入。监督 AI 对照「停止条件」判断是否达标（可以是方向，也可以是具体条件）；只有确认达标才停止注入。';
  }
  return '按目标自行决策续跑；完成/停止条件同样分「方向型 / 具体条件型」，由监督 AI 判断是否达标后再停。';
}

export function stopWhenKindLabel(kind: StopWhenKind): string {
  return kind === 'direction' ? '方向型' : '具体条件型';
}

export function stopWhenKindHint(kind: StopWhenKind): string {
  if (kind === 'direction') {
    return '描述期望终态/方向，例如「用户能登录且错误提示正确」。监督 AI 综合终端进展判断是否已足够接近该方向。';
  }
  return '描述可核对的事实，例如「npm test 全绿」或「出现 BUILD SUCCESS」。监督 AI 根据终端输出/状态判断是否已满足。';
}

/** Rubric text for the supervisor AI. */
export function stopWhenJudgmentGuide(kind: StopWhenKind, stopWhen: string): string {
  const cond = stopWhen.trim() || '（未填写）';
  if (kind === 'direction') {
    return [
      `停止条件类型: 方向型`,
      `方向描述: ${cond}`,
      '判断方法:',
      '- 不要只看「指令是否跑完」。',
      '- 结合终端输出、当前代码/任务进展，判断是否已朝该方向落到可交付的一小步闭环。',
      '- 若仍明显偏题、半成品、关键验收点未动到 → 判定未达到，说明差什么。',
      '- 若核心方向已落地、剩余仅是琐碎收尾且人类未要求继续 → 可判定达到。',
      '- 拿不准 → 说明证据与疑点，让人类最终点确认。',
    ].join('\n');
  }
  return [
    `停止条件类型: 具体条件型`,
    `具体条件: ${cond}`,
    '判断方法:',
    '- 在终端输出/状态中寻找可核对证据（测试结果、构建日志、明确成功标记等）。',
    '- 有明确证据满足条件 → 判定达到。',
    '- 证据不足、失败、未跑到相关步骤 → 判定未达到，指出缺哪条证据。',
    '- 条件本身模糊无法核对 → 向人类说明，不要假装已满足。',
  ].join('\n');
}

/** Tab title for the dedicated supervisor terminal. */
export const SUPERVISOR_TAB_TITLE = 'AI 监督';

export function supervisorTabTitle(laneLabel: string): string {
  return `${SUPERVISOR_TAB_TITLE} · ${laneLabel}`;
}

/**
 * Build text injected into a worker terminal.
 * direct → verbatim step.prompt only.
 * goal-chase → short decision prompt tied to goal (not a wall of protocol).
 */
export function buildInjectedPrompt(opts: {
  session: Pick<
    SupervisorSession,
    'mode' | 'goal' | 'allowPaths' | 'denyNotes' | 'doneWhen' | 'stopWhen'
  >;
  lane: Pick<SupervisorLane, 'id' | 'label' | 'surfaceId'>;
  step: Pick<SupervisorStep, 'id' | 'title' | 'prompt'>;
  stepIndex: number;
  stepCount: number;
}): string {
  const { session, step } = opts;
  const body = (step.prompt || '').trim();

  if (session.mode === 'direct') {
    // Verbatim — no frame, no stop-condition spam (stopWhen is for the scheduler + human notify).
    return body;
  }

  // goal-chase: compact decision packet
  const lines = [
    body || '请根据下列目标，自行决策并推进最小下一步；若无法决策，明确说明卡点并停止等待人工。',
  ];
  if (session.goal.trim()) lines.unshift(`目标: ${session.goal.trim()}`);
  if (session.allowPaths.trim()) lines.push(`允许: ${session.allowPaths.trim()}`);
  if (session.denyNotes.trim()) lines.push(`禁止: ${session.denyNotes.trim()}`);
  if (session.doneWhen.trim()) lines.push(`完成条件: ${session.doneWhen.trim()}`);
  lines.push('做完本决策步即停；需要人类决策时说明原因并等待。');
  return lines.join('\n');
}

/** Briefing for the AI supervisor terminal (both modes). */
export function buildSupervisorBriefing(
  session: SupervisorSession,
  laneState: { lane: SupervisorLane; state: string },
): string {
  const { lane, state } = laneState;
  const worker = `${lane.label} | ${lane.surfaceId} | 状态=${state}`;
  const planBlock = session.planFileContent.trim()
    ? [
        '## 计划文件（最高任务方向与约束）',
        `文件: ${session.planFilePath || '（未命名计划）'}`,
        session.planFileContent.trim(),
        '',
        '计划文件与表单中的目标、允许范围或禁止项冲突时，以计划文件为准；但不得绕过安全边界或人类明确指令。',
        '',
      ]
    : [];

  if (session.mode === 'direct') {
    const kind = session.stopWhenKind || 'concrete';
    return [
      '# AI 监督 · 直接注入',
      '',
      '工作终端由调度器**原样注入**用户指令。你的核心职责：观察终端，**判断停止条件是否满足**。',
      '',
      '## 停止条件（由你判断；只有满足才应停止注入）',
      stopWhenJudgmentGuide(kind, session.stopWhen),
      '',
      ...planBlock,
      '## 用户指令队列（已/将注入，勿改写内容）',
      session.directInstructions.trim() || '（见各通道步骤）',
      '',
      '## 监控终端',
      worker,
      '',
      '## 判定输出格式（每次核对请按此简短回答）',
      '结论: 达到 | 未达到 | 不确定',
      '依据: （引用终端里的关键证据，1～3 条）',
      '建议: （若未达到，下一条原样指令建议写什么；若达到，请人类侧栏点「已达停止条件」）',
      '',
      '## 规则',
      '1. 指令跑完 ≠ 停止条件满足。',
      '2. 达到 → 明确写出「结论: 达到」，并请人类在侧栏点「已达停止条件」停止注入。',
      '3. 未达到 → 「结论: 未达到」+ 差什么 + 可选补充指令建议。',
      '4. 阻塞/要权限 → 通知人类，不要绕过。',
      `5. 你只监督此终端。每轮结束先 read-screen --surface ${lane.surfaceId}，再用 wmux supervisor decide 记录 continue/rework/complete/needs-human；该命令成功时静默。`,
      '6. CLI: wmux agent-state / wmux read-screen / wmux send --surface <id> "..."',
      '',
    ].join('\n');
  }

  const kind = session.stopWhenKind || 'concrete';
  return [
    '# AI 监督 · 目标追逐',
    '',
    '你只负责管理下列一个工作终端：在目标范围内自行决策推进；并判断「完成/停止条件」是否满足。',
    '',
    '## 目标',
    session.goal.trim() || '（未设置）',
    '',
    ...planBlock,
    '## 完成/停止条件（由你判断；满足后应停止对该通道的自动决策）',
    stopWhenJudgmentGuide(kind, session.doneWhen),
    '',
    '## 约束',
    `允许: ${session.allowPaths.trim() || '（尽量最小改动）'}`,
    `禁止: ${session.denyNotes.trim() || '（无）'}`,
    '',
    '## 监控终端',
    worker,
    '',
    '## 判定输出格式（核对完成条件时）',
    '结论: 达到 | 未达到 | 不确定',
    '依据: （终端证据 1～3 条）',
    '建议: （未达到则下一步决策要点；达到则请人类侧栏点「已达停止条件」）',
    '每轮结束先 read-screen，再用 wmux supervisor decide 记录 continue/rework/complete/needs-human；该命令成功时静默。',
    '',
    '## 规则',
    `1. 只管理 ${lane.surfaceId}，不要读取、总结或裁决其他终端。`,
    '2. 决策不了 / 要权限 / 信息不足 → 说明卡点并停，不要瞎猜。',
    '3. 完成条件满足 → 「结论: 达到」，请人类点「已达停止条件」。',
    '4. 可用: wmux agent-state / wmux read-screen / wmux send --surface <id> "..."',
    '',
  ].join('\n');
}

/** Idle packet for supervisor AI terminal (goal-chase). */
export function buildIdleHint(opts: {
  lane: SupervisorLane;
  state: string;
  goal: string;
  doneWhen: string;
  stopWhenKind?: StopWhenKind;
}): string {
  const kind = opts.stopWhenKind || 'concrete';
  return [
    `[空闲] ${opts.lane.label} (${opts.lane.surfaceId}) state=${opts.state}`,
    opts.goal.trim() ? `目标: ${opts.goal.trim()}` : '',
    '',
    '先判断完成/停止条件是否已满足：',
    stopWhenJudgmentGuide(kind, opts.doneWhen),
    '',
    '若「达到」→ 请人类侧栏点「已达停止条件」，不要再开新决策。',
    '若「未达到」→ 决策最小下一步并推进；无法决策则说明原因等人工。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Ask supervisor AI to judge stop/done condition.
 * Used by direct (stopWhen) and goal-chase (doneWhen).
 */
export function buildStopCheckHint(opts: {
  lane: SupervisorLane;
  stopWhen: string;
  stopWhenKind: StopWhenKind;
  state: string;
  /** direct | goal-chase wording */
  mode?: SupervisorMode;
}): string {
  const kind = opts.stopWhenKind || 'concrete';
  const mode = opts.mode || 'direct';
  const title =
    mode === 'goal-chase' ? '[请判断完成/停止条件 · 目标追逐]' : '[请判断停止条件 · 直接注入]';
  const trigger =
    mode === 'goal-chase'
      ? '本轮决策步已告一段落 — 先判断是否该停，再考虑是否继续决策。'
      : '指令队列已暂时跑完 — 这只是触发核对，不是自动完成。';
  const actionMet =
    mode === 'goal-chase'
      ? '若结论为「达到」→ 请人类在侧栏点「已达停止条件」以停止自动决策。'
      : '若结论为「达到」→ 请人类在侧栏点「已达停止条件」以停止注入。';
  const actionNot =
    mode === 'goal-chase'
      ? '若「未达到」→ 侧栏点「未达到」后将继续自动决策；也可说明下一步决策要点。'
      : '若「未达到」→ 侧栏点「未达到」，并补充下一条原样指令。';

  return [
    `${title} 通道=${opts.lane.label} (${opts.lane.surfaceId}) agentState=${opts.state}`,
    trigger,
    '',
    stopWhenJudgmentGuide(kind, opts.stopWhen),
    '',
    '请观察该工作终端（wmux read-screen / agent-state），然后按格式回复：',
    '结论: 达到 | 未达到 | 不确定',
    '依据: …',
    '建议: …',
    '',
    actionMet,
    actionNot,
    '',
  ].join('\n');
}

/** Human-facing stop notification body. */
export function buildUserNotifyText(opts: {
  mode: SupervisorMode;
  reason: string;
  laneLabel?: string;
  stopWhen?: string;
  doneWhen?: string;
  detail?: string;
}): string {
  const parts = [
    `AI 监督 · ${modeLabel(opts.mode)}`,
    opts.laneLabel ? `通道: ${opts.laneLabel}` : '',
    `原因: ${opts.reason}`,
    opts.detail || '',
  ];
  if (opts.mode === 'direct' && opts.stopWhen?.trim()) {
    parts.push(`请确认停止条件是否满足: ${opts.stopWhen.trim()}`);
  }
  if (opts.mode === 'goal-chase' && opts.doneWhen?.trim()) {
    parts.push(`完成条件参考: ${opts.doneWhen.trim()}`);
  }
  parts.push('请你处理。');
  return parts.filter(Boolean).join('\n');
}
