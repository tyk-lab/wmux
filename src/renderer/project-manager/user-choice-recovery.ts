import type {
  ProjectManagerSession,
  ProjectManagerUserQuestion,
} from '../../shared/project-manager';

export type InterruptedUserChoiceTransition = {
  transitionId: string;
  question: ProjectManagerUserQuestion;
  optionId?: string;
  answer: string;
  answerInput: string;
  answeredBy: 'desktop' | 'feishu';
  requirementsVersion?: number;
  authorizationVersion?: number;
  goalId?: string;
};

export function projectUserChoiceReplayMayRepeatSideEffect(
  question: Pick<ProjectManagerUserQuestion, 'reasonCode'>,
): boolean {
  return [
    'physical-action',
    'credentials',
    'access-grant',
    'destructive-action',
    'production-action',
  ].includes(question.reasonCode || '');
}

function interruptedUserChoiceTransitionFromEvent(
  event: ProjectManagerSession['events'][number],
): InterruptedUserChoiceTransition | undefined {
  const question = event.payload?.question as ProjectManagerUserQuestion | undefined;
  const answer = typeof event.payload?.answer === 'string' ? event.payload.answer.trim() : '';
  const answerInput = typeof event.payload?.answerInput === 'string'
    ? event.payload.answerInput.trim()
    : answer;
  const answeredBy = event.payload?.answeredBy === 'feishu' ? 'feishu' : 'desktop';
  if (!question?.id || !question.question || !Array.isArray(question.options) || !answer) return undefined;
  return {
    transitionId: event.id,
    question,
    optionId: typeof event.payload?.optionId === 'string' ? event.payload.optionId : undefined,
    answer,
    answerInput,
    answeredBy,
    requirementsVersion: Number.isFinite(event.payload?.requirementsVersion)
      ? Number(event.payload?.requirementsVersion)
      : undefined,
    authorizationVersion: Number.isFinite(event.payload?.authorizationVersion)
      ? Number(event.payload?.authorizationVersion)
      : undefined,
    goalId: typeof event.payload?.goalId === 'string' ? event.payload.goalId : undefined,
  };
}

/** Return every durable user choice whose control-plane side effect never completed. */
export function interruptedUserChoiceTransitions(
  session: Pick<ProjectManagerSession, 'events'>,
): InterruptedUserChoiceTransition[] {
  const unresolved = new Map<string, InterruptedUserChoiceTransition>();
  for (const event of session.events) {
    if (event.kind === 'project-runtime-reset') {
      unresolved.clear();
      continue;
    }
    if (event.kind === 'user-choice-transition-completed'
      && typeof event.payload?.transitionId === 'string') {
      unresolved.delete(event.payload.transitionId);
      continue;
    }
    if (event.kind === 'user-choice-transition-started'
      && typeof event.payload?.retryOfTransitionId === 'string') {
      unresolved.delete(event.payload.retryOfTransitionId);
    }
    if (event.kind !== 'user-choice-transition-started') continue;
    const transition = interruptedUserChoiceTransitionFromEvent(event);
    if (transition) unresolved.set(event.id, transition);
  }
  return [...unresolved.values()];
}

/** Return the newest durable user choice whose control-plane side effect never completed. */
export function interruptedUserChoiceTransition(
  session: Pick<ProjectManagerSession, 'events'>,
): InterruptedUserChoiceTransition | undefined {
  return interruptedUserChoiceTransitions(session).at(-1);
}
