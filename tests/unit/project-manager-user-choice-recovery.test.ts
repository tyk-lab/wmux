import { describe, expect, it } from 'vitest';
import {
  interruptedUserChoiceTransition,
  projectUserChoiceReplayMayRepeatSideEffect,
} from '../../src/renderer/project-manager/user-choice-recovery';
import type { ProjectManagerEvent, ProjectManagerUserQuestion } from '../../src/shared/project-manager';

const question: ProjectManagerUserQuestion = {
  id: 'question-runtime',
  category: 'manual-intervention',
  reasonCode: 'runtime-recovery',
  workItemId: 'task-a',
  question: '如何处理异常运行时？',
  context: '任务 AI 已退出。',
  options: [
    { id: 'rebuild-task-runtime', label: '重建任务 AI' },
    { id: 'keep-paused', label: '保持暂停' },
  ],
  previousStatus: 'active',
  createdAt: 1,
};

function event(
  id: string,
  kind: ProjectManagerEvent['kind'],
  payload: Record<string, unknown>,
  ts: number,
): ProjectManagerEvent {
  return { id, sessionId: 'pm-choice-recovery', kind, summary: id, payload, ts };
}

describe('project manager interrupted user choice recovery', () => {
  it('returns a choice persisted before its control-plane side effect completed', () => {
    expect(interruptedUserChoiceTransition({
      events: [event('transition-a', 'user-choice-transition-started', {
        question,
        optionId: 'rebuild-task-runtime',
        answer: '重建任务 AI',
        answerInput: '',
        answeredBy: 'desktop',
      }, 1)],
    })).toMatchObject({
      transitionId: 'transition-a',
      question: { id: question.id },
      optionId: 'rebuild-task-runtime',
    });
  });

  it('ignores completed choices and treats a retry as superseding the old transition', () => {
    expect(interruptedUserChoiceTransition({
      events: [
        event('transition-a', 'user-choice-transition-started', { question, answer: '重建任务 AI' }, 1),
        event('transition-b', 'user-choice-transition-started', {
          question,
          answer: '重建任务 AI',
          retryOfTransitionId: 'transition-a',
        }, 2),
        event('completed-b', 'user-choice-transition-completed', { transitionId: 'transition-b' }, 3),
      ],
    })).toBeUndefined();
  });

  it('returns the newest unresolved transition when completion events are interleaved', () => {
    const anotherQuestion = { ...question, id: 'question-later', question: '稍后的用户选择？' };
    expect(interruptedUserChoiceTransition({
      events: [
        event('transition-a', 'user-choice-transition-started', { question, answer: '保持暂停' }, 1),
        event('transition-b', 'user-choice-transition-started', {
          question: anotherQuestion,
          answer: '继续处理',
          answeredBy: 'feishu',
        }, 2),
        event('completed-a', 'user-choice-transition-completed', { transitionId: 'transition-a' }, 3),
      ],
    })).toMatchObject({
      transitionId: 'transition-b',
      question: { id: 'question-later' },
      answeredBy: 'feishu',
    });
  });

  it('ignores malformed transition evidence instead of fabricating a recovery action', () => {
    expect(interruptedUserChoiceTransition({
      events: [event('malformed', 'user-choice-transition-started', {
        question: { id: 'missing-options', question: '不完整' },
        answer: '',
      }, 1)],
    })).toBeUndefined();
  });

  it.each([
    'physical-action',
    'credentials',
    'access-grant',
    'destructive-action',
    'production-action',
  ] as const)('does not recommend blind replay for %s choices', (reasonCode) => {
    expect(projectUserChoiceReplayMayRepeatSideEffect({ reasonCode })).toBe(true);
  });

  it.each([
    'task-input-conflict',
    'verification-limited',
    'final-acceptance',
    'runtime-recovery',
    'recovery-fallback',
  ] as const)('allows an explicit replay recommendation for idempotent %s choices', (reasonCode) => {
    expect(projectUserChoiceReplayMayRepeatSideEffect({ reasonCode })).toBe(false);
  });
});
