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

/** Return the newest durable user choice whose control-plane side effect never completed. */
export function interruptedUserChoiceTransition(
  session: Pick<ProjectManagerSession, 'events'>,
): InterruptedUserChoiceTransition | undefined {
  const resolved = new Set<string>();
  for (const event of session.events) {
    if (event.kind === 'user-choice-transition-completed'
      && typeof event.payload?.transitionId === 'string') {
      resolved.add(event.payload.transitionId);
    }
    if (event.kind === 'user-choice-transition-started'
      && typeof event.payload?.retryOfTransitionId === 'string') {
      resolved.add(event.payload.retryOfTransitionId);
    }
  }
  for (const event of [...session.events].reverse()) {
    if (event.kind !== 'user-choice-transition-started' || resolved.has(event.id)) continue;
    const question = event.payload?.question as ProjectManagerUserQuestion | undefined;
    const answer = typeof event.payload?.answer === 'string' ? event.payload.answer.trim() : '';
    const answerInput = typeof event.payload?.answerInput === 'string'
      ? event.payload.answerInput.trim()
      : answer;
    const answeredBy = event.payload?.answeredBy === 'feishu' ? 'feishu' : 'desktop';
    if (!question?.id || !question.question || !Array.isArray(question.options) || !answer) continue;
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
  return undefined;
}
