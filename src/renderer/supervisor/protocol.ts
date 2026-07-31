import type {
  StopWhenKind,
  SupervisorLane,
  SupervisorMode,
  SupervisorSession,
  SupervisorStep,
} from '../store/supervisor-slice';

export function modeLabel(mode: SupervisorMode): string {
  if (mode === 'unified') return '统一监督';
  return mode === 'direct' ? '直接注入（旧会话）' : '目标追逐（旧会话）';
}

export function modeDescription(mode: SupervisorMode): string {
  if (mode === 'unified') {
    return '工作终端由用户自行接收任务；监督 AI 只读取证据并裁决，不会自动注入下一步。';
  }
  if (mode === 'direct') {
    return '指令原样注入。每轮任务结束后，监督 AI 读取终端证据，并把「停止条件」作为参考作出后续裁决。';
  }
  return '按目标自行决策续跑；每轮任务结束后，监督 AI 结合终端证据和完成/停止条件参考决定后续动作。';
}

export function stopWhenKindLabel(kind: StopWhenKind): string {
  return kind === 'direction' ? '方向型' : '具体条件型';
}

export function stopWhenKindHint(kind: StopWhenKind): string {
  if (kind === 'direction') {
    return '描述期望终态/方向，例如「用户能登录且错误提示正确」。它是监督 AI 结合终端证据作出裁决的参考，不是机械开关。';
  }
  return '描述可核对的事实，例如「npm test 全绿」或「出现 BUILD SUCCESS」。它是监督 AI 结合终端输出/状态作出裁决的参考。';
}

/** Rubric text for the supervisor AI. */
export function stopWhenJudgmentGuide(kind: StopWhenKind, stopWhen: string): string {
  const cond = stopWhen.trim() || '（未填写）';
  if (kind === 'direction') {
    return [
      `停止条件类型: 方向型`,
      `方向描述: ${cond}`,
      '这是裁决参考；工作终端本轮结束后，先查看当前证据，再决定 continue / rework / complete / needs-human。',
      '判断方法:',
      '- 不要只看「指令是否跑完」。',
      '- 结合终端输出、当前代码/任务进展，判断是否已朝该方向落到可交付的一小步闭环。',
      '- 若仍明显偏题、半成品、关键验收点未动到 → 判定未达到，说明差什么。',
      '- 若核心方向已落地、剩余仅是琐碎收尾且人类未要求继续 → 可判定达到。',
      '- 证据不足但可在原路线内通过低风险检查、补测或查看日志核对 → 使用 continue 或 rework，并说明缺口。',
      '- 仅当没有明确、低风险的补证路径，或下一步需要用户授权、取舍或承担风险 → 使用 needs-human。',
    ].join('\n');
  }
  return [
    `停止条件类型: 具体条件型`,
    `具体条件: ${cond}`,
    '这是裁决参考；工作终端本轮结束后，先查看当前证据，再决定 continue / rework / complete / needs-human。',
    '判断方法:',
    '- 在终端输出/状态中寻找可核对证据（测试结果、构建日志、明确成功标记等）。',
    '- 有明确证据满足条件 → 判定达到。',
    '- 证据不足、失败、未跑到相关步骤 → 判定未达到；若可补测、查看日志或作同路线低风险验证，使用 continue 或 rework 并指出缺口。',
    '- 条件本身模糊且没有低风险的补证路径 → 向人类说明，不要假装已满足。',
  ].join('\n');
}

/** Tab title for the dedicated supervisor terminal. */
export const SUPERVISOR_TAB_TITLE = 'AI 监督';
/** Pinned workspace where the full supervisor session is expanded. */
export const SUPERVISOR_WORKSPACE_TITLE = 'AI 监督';

export function supervisorTabTitle(laneLabel: string): string {
  return `${SUPERVISOR_TAB_TITLE} · ${laneLabel}`;
}

/** Rules that make user approval the hard boundary for changing a task's route. */
export function humanDecisionBoundary(): string[] {
  return [
    '监督建议边界：只可评价当前终端任务、停止条件补充说明、计划文件和既有技术路线内的工作结果；计划文件属于停止裁决参考，但不能自动向工作终端推进任务。',
    '只有改任务方向/扩范围/换方案或依赖、不可逆或高影响操作（安全、权限、关键数据、生产或对外提交）、需求冲突，或缺少用户独有信息/授权时，才使用 needs-human。',
    '证据不足、测试失败或普通返工本身不是人工升级理由；能在原路线内通过低风险检查、补测或查看日志推进时，应使用 continue 或 rework。',
    '使用 needs-human 时附 --proposal-kind route-change 或 important；--reason 写清问题与判断依据，--next 写建议的下一步，并附 --impact、--alternatives。',
    '用户未在监督会话中批准前，工作终端会暂停；不要自行发送该建议。',
  ];
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
  const planFilePath = session.planFilePath.trim();
  const planBlock = session.planFilePath.trim()
    ? [
        '## 计划文件（停止裁决参考 · 可更新）',
        `路径: ${planFilePath}`,
        '',
        '此文件是判断停止条件的重要参考。每次裁决前先检查文件是否更新（例如修改时间）；首次使用或发现更新时才重新读取正文，未更新可沿用已读取内容。启动 briefing 不会附带或粘贴文件正文。综合计划中的范围、验收与约束、停止条件补充说明、已确认条件和当前终端证据裁决；人工明确指令优先，且不要因计划文件自动向工作终端推进任务。',
        '',
      ]
    : [];
  const preconditionsBlock = session.preconditions.trim()
    ? [
        '## 已确认的前置条件 / 环境信息',
        session.preconditions.trim(),
        '',
        '这些信息是用户已确认、在本次监督会话内有效的环境与安全前提；不要仅因历史审计、任务日志出现“下次确认”“再次确认”等泛化提醒而重复要求人工确认。',
        '仅当当前终端证据明确表明条件已变化、缺失、失效，或任务进入未被这些前置条件覆盖的新危险操作时，说明具体冲突并交给人类确认。它们不是任务或停止条件。',
        '',
      ]
    : [];
  const restoredHistoryBlock = lane.restoredHistory?.trim()
    ? [
        '## 已恢复的本终端审计摘要',
        `来源会话: ${lane.restoredFromSessionId || '最近会话'}`,
        lane.restoredHistory.trim(),
        '',
        '这只是历史背景。先读取当前终端屏幕确认现状；不要把它当作当前状态，也不要据此读取或裁决其他终端。',
        '',
      ]
    : [];
  const decisionReadStep = planFilePath
    ? `1. 先检查计划文件（${planFilePath}）是否更新；首次使用或更新时重新读取，再 read-screen --surface ${lane.surfaceId} 查看当前证据。`
    : `1. 先 read-screen --surface ${lane.surfaceId} 查看当前证据。`;
  const decisionEvidence = planFilePath
    ? '综合当前版本计划文件、停止条件补充说明、已确认前置条件和终端证据，提交 continue / rework / complete / needs-human。'
    : '综合停止条件补充说明、已确认前置条件和终端证据，提交 continue / rework / complete / needs-human。';
  const stopContextBlock = session.taskDescription.trim()
    ? [
        '## 停止条件补充说明（可选）',
        session.taskDescription.trim(),
        '',
      ]
    : [];

  if (session.mode === 'unified') {
    const kind = session.stopWhenKind || 'concrete';
    return [
      '# AI 监督 · 统一监督',
      '',
      '工作终端由用户自行接收任务。你只观察和裁决，绝不向工作终端自动注入任务或使用 --next 推进。',
      '',
      ...stopContextBlock,
      ...preconditionsBlock,
      ...planBlock,
      ...restoredHistoryBlock,
      '## 停止条件参考（用于裁决，不是机械开关）',
      stopWhenJudgmentGuide(kind, session.stopWhen),
      '',
      '## 自动判断上限',
      session.maxAutoDecisions
        ? `本终端每 ${session.maxAutoDecisions} 次 AI 裁决后必须等待人工审阅；达到上限时不要再调用裁决命令，等待用户确认后再继续。`
        : '本终端未设置自动判断次数上限；仅在路线变更、高影响风险、需求取舍或确无低风险补证路径时提交 needs-human。',
      '',
      '## 监控终端',
      worker,
      '',
      '## 本轮裁决流程',
      decisionReadStep,
      `2. 条件仅作参考；${decisionEvidence}`,
      '3. continue / rework 仅记录裁决，不得携带 --next；由用户决定是否另行向工作终端发送任务。',
      '',
      '## 规则',
      `1. 只监督此终端（${lane.surfaceId}），不要读取、总结或裁决其他终端。`,
      '2. 终端本轮结束不等于停止条件满足；先验证当前证据。',
      '3. 证据足以收尾可提交 complete；证据不足时优先用 continue / rework 补证或返工，只有无低风险路径时才 needs-human。',
      ...humanDecisionBoundary().map((line, index) => `${index + 4}. ${line}`),
      `8. 每轮结束先 read-screen --surface ${lane.surfaceId}，再用 wmux supervisor decide 记录裁决；该命令成功时静默。`,
      '9. CLI: wmux agent-state / wmux read-screen / wmux send --surface <id> "..."',
      '',
    ].join('\n');
  }

  if (session.mode === 'direct') {
    const kind = session.stopWhenKind || 'concrete';
    return [
      '# AI 监督 · 直接注入',
      '',
      '工作终端由调度器**原样注入**用户指令。每轮终端任务结束后，你必须先观察证据，再决定继续、返工、完成或交给人工。',
      '',
      '## 停止条件参考（用于裁决，不是机械开关）',
      stopWhenJudgmentGuide(kind, session.stopWhen),
      '',
      ...stopContextBlock,
      ...preconditionsBlock,
      ...planBlock,
      ...restoredHistoryBlock,
      '## 用户指令队列（已/将注入，勿改写内容）',
      session.directInstructions.trim() || '（见各通道步骤）',
      '',
      '## 监控终端',
      worker,
      '',
      '## 本轮裁决流程',
      decisionReadStep,
      `2. 条件仅作参考；${decisionEvidence}`,
      '3. 通过 CLI 裁决后，简短说明依据和下一步；不要把说明当成状态变更。',
      '',
      '## 规则',
      '1. 指令跑完 ≠ 停止条件满足。',
      '2. 终端任务结束后先 read-screen，再根据证据和参考条件提交 continue / rework / complete / needs-human。',
      '3. 仍需推进时，continue / rework 的 --next 只能是同路线的低风险下一步。',
      ...humanDecisionBoundary().map((line, index) => `${index + 4}. ${line}`),
      `8. 你只监督此终端。每轮结束先 read-screen --surface ${lane.surfaceId}，再用 wmux supervisor decide 记录 continue/rework/complete/needs-human；该命令成功时静默。`,
      '9. CLI: wmux agent-state / wmux read-screen / wmux send --surface <id> "..."',
      '',
    ].join('\n');
  }

  const kind = session.stopWhenKind || 'concrete';
  return [
    '# AI 监督 · 目标追逐',
    '',
    '你只负责管理下列一个工作终端：每轮终端任务结束后，先读取证据，再结合目标和完成参考决定继续、返工、完成或交给人工。',
    '',
    '## 目标',
    session.goal.trim() || '（未设置）',
    '',
    ...stopContextBlock,
    ...preconditionsBlock,
    ...planBlock,
    ...restoredHistoryBlock,
    '## 完成/停止条件参考（用于裁决，不是机械开关）',
    stopWhenJudgmentGuide(kind, session.doneWhen),
    '',
    '## 约束',
    `允许: ${session.allowPaths.trim() || '（尽量最小改动）'}`,
    `禁止: ${session.denyNotes.trim() || '（无）'}`,
    '',
    '## 监控终端',
    worker,
    '',
    '## 本轮裁决流程',
    decisionReadStep,
    `2. 条件仅作参考；${decisionEvidence}`,
    '3. 通过 CLI 裁决后，简短说明依据和下一步；不要把说明当成状态变更。',
    '',
    '## 规则',
    `1. 只管理 ${lane.surfaceId}，不要读取、总结或裁决其他终端。`,
    '2. 要权限、需用户独有信息或存在需求取舍/高影响风险 → 说明卡点并 needs-human；不要瞎猜。',
    '3. 证据足以收尾 → 提交 complete；证据不足时优先在原路线内 continue / rework 补证，只有无低风险路径才 needs-human。',
    ...humanDecisionBoundary().map((line, index) => `${index + 4}. ${line}`),
    '8. 可用: wmux agent-state / wmux read-screen / wmux send --surface <id> "..."',
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
  return [
    `[空闲裁决] ${opts.lane.label} (${opts.lane.surfaceId}) state=${opts.state}`,
    `完成参考: ${opts.doneWhen.trim() || '（未设置）'}`,
    '请 read-screen 后提交 continue / rework / complete / needs-human；路线变更或重要建议必须 needs-human，等待用户批准。',
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
  const mode = opts.mode || 'unified';
  const title =
    mode === 'unified'
      ? '[请结合停止参考作出裁决 · 统一监督]'
      : mode === 'goal-chase' ? '[请结合完成参考作出裁决 · 目标追逐]' : '[请结合停止参考作出裁决 · 直接注入]';
  const reference = opts.stopWhen;
  const action = mode === 'unified'
    ? '可收尾用 complete；continue / rework 只记录裁决，不得携带 --next；路线变更或重要建议用 needs-human。'
    : mode === 'goal-chase'
    ? '可收尾用 complete；同路线低风险推进才用 continue / rework；路线变更或重要建议用 needs-human。'
    : '可收尾用 complete；队列已空但仍需推进时，只有同路线低风险步骤可用 continue / rework 加 --next；其他建议用 needs-human。';

  return [
    `${title} 通道=${opts.lane.label} (${opts.lane.surfaceId}) agentState=${opts.state}`,
    `条件参考: ${reference.trim() || '（未设置）'}`,
    '请先 read-screen；根据当前证据调用 wmux supervisor decide 提交裁决。',
    action,
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
  if (opts.mode === 'unified' && opts.stopWhen?.trim()) {
    parts.push(`停止条件参考: ${opts.stopWhen.trim()}`);
  }
  if (opts.mode === 'goal-chase' && opts.doneWhen?.trim()) {
    parts.push(`完成条件参考: ${opts.doneWhen.trim()}`);
  }
  parts.push('请你处理。');
  return parts.filter(Boolean).join('\n');
}
