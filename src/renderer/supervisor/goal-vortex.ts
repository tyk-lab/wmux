import type { GoalVortexKind, GoalVortexState } from '../store/supervisor-slice';

export const GOAL_VORTEX_KINDS = [
  'offline-overanalysis',
  'repeated-validation',
  'missing-real-test',
  'single-condition-fixation',
  'constraint-dead-end',
  'evidence-free-deliberation',
] as const satisfies readonly GoalVortexKind[];

const GOAL_VORTEX_KIND_SET = new Set<string>(GOAL_VORTEX_KINDS);

export function normalizeGoalVortexKind(value: unknown): GoalVortexKind | undefined {
  const normalized = String(value || '').trim();
  return GOAL_VORTEX_KIND_SET.has(normalized) ? normalized as GoalVortexKind : undefined;
}

export function normalizeExperimentConditions(value: unknown): string[] {
  return [...new Set(String(value || '')
    .split(/[;；\n]/u)
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, 4);
}

function signature(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, ' ').slice(0, 1_000);
}

export function nextGoalVortexState(options: {
  previous?: GoalVortexState;
  kind: GoalVortexKind;
  signal: string;
  wastedEffort: string;
  missingEvidence: string;
  decisiveNextStep: string;
  authorizationBoundary: 'within-current' | 'requires-expansion';
  experimentConditions: string[];
  correctionTask: string;
  evidenceFingerprint?: string;
  reviewId?: string;
  workerTurnId?: number;
  now?: number;
}): GoalVortexState {
  const fingerprint = [
    options.kind,
    options.authorizationBoundary,
  ].join('|');
  const sameIssue = options.previous?.fingerprint === fingerprint;
  const distinctReview = options.previous?.reviewId !== options.reviewId
    || options.previous?.workerTurnId !== options.workerTurnId;
  return {
    fingerprint,
    evidenceFingerprint: options.evidenceFingerprint || 'no-new-evidence',
    kind: options.kind,
    signal: options.signal.trim().slice(0, 4_000),
    wastedEffort: options.wastedEffort.trim().slice(0, 4_000),
    missingEvidence: options.missingEvidence.trim().slice(0, 4_000),
    decisiveNextStep: options.decisiveNextStep.trim().slice(0, 4_000),
    authorizationBoundary: options.authorizationBoundary,
    experimentConditions: [...options.experimentConditions],
    correctionTask: options.correctionTask.trim().slice(0, 8_000),
    occurrences: sameIssue
      ? distinctReview ? options.previous!.occurrences + 1 : options.previous!.occurrences
      : 1,
    reviewId: options.reviewId,
    workerTurnId: options.workerTurnId,
    updatedAt: options.now ?? Date.now(),
  };
}

export function sameGoalVortexCorrection(left: string, right: string): boolean {
  return !!signature(left) && signature(left) === signature(right);
}
