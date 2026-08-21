export interface AgentStateSemanticsView {
  state?: unknown;
  blockedReason?: unknown;
}

const AWAITING_NEXT_PROMPT_REASON = /^\s*(?:(?:wait(?:ing)?|await(?:ing)?)\s+(?:for\s+)?(?:(?:your|the)\s+)?(?:next|another|new)\s+(?:prompt|instruction|message|task|input)|等待(?:(?:你的?|您的?|用户的?)\s*)?(?:下一(?:条|个)?|新的?)\s*(?:提示|指令|消息|任务|输入))\s*[.!。！…]*\s*$/iu;

/** An idle Agent nudge reported through Notification is prompt-ready, not a decision blocker. */
export function isAwaitingNextPromptState(agentState: unknown): boolean {
  if (!agentState || typeof agentState !== 'object') return false;
  const state = agentState as AgentStateSemanticsView;
  return state.state === 'blocked'
    && typeof state.blockedReason === 'string'
    && AWAITING_NEXT_PROMPT_REASON.test(state.blockedReason);
}

/** Both native idle and the safe idle-notification variant can accept a new Agent prompt. */
export function isAgentPromptReadyState(agentState: unknown): boolean {
  if (agentState === 'idle') return true;
  if (!agentState || typeof agentState !== 'object') return false;
  return (agentState as AgentStateSemanticsView).state === 'idle'
    || isAwaitingNextPromptState(agentState);
}
