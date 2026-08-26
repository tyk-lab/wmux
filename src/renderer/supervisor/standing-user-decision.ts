import type {
  StandingUserDecision,
  SupervisorLane,
} from '../store/supervisor-slice';

const MAX_STANDING_USER_DECISIONS = 12;

export function standingUserDecisionFingerprint(subject: string): string {
  return subject
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 1_000);
}

function normalizedStandingDecision(
  decision: StandingUserDecision | undefined,
): StandingUserDecision | undefined {
  if (!decision?.decision?.trim() || !decision.subject?.trim()) return undefined;
  return {
    ...decision,
    subjectFingerprint: decision.subjectFingerprint
      || standingUserDecisionFingerprint(decision.subject),
  };
}

export function activeStandingUserDecisions(
  lane: Pick<SupervisorLane, 'standingUserDecision' | 'standingUserDecisions'>,
  planRevision: number,
): StandingUserDecision[] {
  const source = [
    ...(lane.standingUserDecisions || []),
    ...(lane.standingUserDecision ? [lane.standingUserDecision] : []),
  ];
  const seen = new Set<string>();
  const decisions: StandingUserDecision[] = [];
  for (const rawDecision of source) {
    const decision = normalizedStandingDecision(rawDecision);
    if (!decision || decision.planRevision !== planRevision) continue;
    const key = decision.subjectFingerprint || decision.sourceApprovalId;
    if (seen.has(key)) continue;
    seen.add(key);
    decisions.push(decision);
    if (decisions.length >= MAX_STANDING_USER_DECISIONS) break;
  }
  return decisions;
}

export function upsertStandingUserDecision(
  existing: readonly StandingUserDecision[] | undefined,
  decision: StandingUserDecision,
): StandingUserDecision[] {
  const normalized = normalizedStandingDecision(decision)!;
  return [
    normalized,
    ...(existing || []).filter((candidate) => (
      (candidate.subjectFingerprint || standingUserDecisionFingerprint(candidate.subject))
      !== normalized.subjectFingerprint
    )),
  ].slice(0, MAX_STANDING_USER_DECISIONS);
}

const MATERIAL_DECISION_CHANGE = /(?:新增|变化|变更|不同|扩大|撤销|失效|不再适用|新风险|更高风险)|\b(?:new|changed|different|expanded|revoked|invalid)\b/iu;

/** Reject only high-confidence repeats; materially changed questions still reach the user. */
export function repeatedStandingUserDecisionError(
  decisions: readonly StandingUserDecision[],
  request: string,
): string | null {
  if (!request.trim() || MATERIAL_DECISION_CHANGE.test(request)) return null;
  const requestFingerprint = standingUserDecisionFingerprint(request);
  if (requestFingerprint.length < 8) return null;
  const repeated = decisions.find((decision) => {
    const subjectFingerprint = decision.subjectFingerprint
      || standingUserDecisionFingerprint(decision.subject);
    if (subjectFingerprint.length < 8) return false;
    return requestFingerprint.includes(subjectFingerprint)
      || subjectFingerprint.includes(requestFingerprint);
  });
  return repeated
    ? `该问题已由用户持续决策 ${repeated.sourceApprovalId} 覆盖；请沿用“${repeated.decision.slice(0, 240)}”，不要重复询问。只有范围、前提、风险或验收发生实质变化时，才能说明差异后重新请求用户决定。`
    : null;
}
