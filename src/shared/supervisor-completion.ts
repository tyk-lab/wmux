const COMPLETION_ROOT_FIELDS = ['remainingWork', 'stopWhen', 'validation'] as const;
const COMPLETION_ITEM_FIELDS = [
  'index', 'status', 'result', 'method', 'evidence', 'evidenceRefs',
] as const;

export const SUPERVISOR_COMPLETION_FILE_EXAMPLE = {
  remainingWork: [],
  stopWhen: [{
    index: 1,
    status: 'satisfied',
    result: 'passed',
    method: 'runtime-test',
    evidence: 'Build and launch completed successfully.',
    evidenceRefs: ['runs/stage-1/build-launch-report.json'],
  }],
  validation: [{
    index: 1,
    status: 'satisfied',
    result: 'passed',
    method: 'evidence-review',
    evidence: 'The recorded evidence covers the validation requirement.',
    evidenceRefs: ['runs/stage-1/build-launch-report.json'],
  }],
} as const;

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Validate the context-free completion-file shape before any capability or evidence lookup. */
export function supervisorCompletionFileShapeError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '--completion-file must contain one JSON object';
  }
  const raw = value as Record<string, unknown>;
  const unknownRootFields = Object.keys(raw).filter((field) => (
    !(COMPLETION_ROOT_FIELDS as readonly string[]).includes(field)
  ));
  if (unknownRootFields.length > 0) {
    return `--completion-file root fields are only remainingWork, stopWhen, validation; unsupported: ${unknownRootFields.join(', ')}. Copy the schema from --help.`;
  }
  if (!stringArray(raw.remainingWork)) {
    return '--completion-file remainingWork must be a string array; use [] when no work remains, not "none"';
  }
  for (const group of ['stopWhen', 'validation'] as const) {
    const entries = raw[group];
    if (!Array.isArray(entries)) {
      return `--completion-file ${group} must be an array of per-condition objects`;
    }
    for (let offset = 0; offset < entries.length; offset += 1) {
      const candidate = entries[offset];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return `--completion-file ${group}[${offset}] must be one per-condition object`;
      }
      const item = candidate as Record<string, unknown>;
      const unknownItemFields = Object.keys(item).filter((field) => (
        !(COMPLETION_ITEM_FIELDS as readonly string[]).includes(field)
      ));
      if (unknownItemFields.length > 0) {
        return `--completion-file ${group}[${offset}] contains unsupported fields: ${unknownItemFields.join(', ')}`;
      }
      if (!Number.isInteger(item.index) || Number(item.index) < 1) {
        return `--completion-file ${group}[${offset}].index must be a positive integer`;
      }
      if (!['satisfied', 'unsatisfied', 'unverified'].includes(String(item.status || ''))) {
        return `--completion-file ${group}[${offset}].status must be satisfied|unsatisfied|unverified`;
      }
      if (!['passed', 'failed', 'inconclusive', 'not-run'].includes(String(item.result || ''))) {
        return `--completion-file ${group}[${offset}].result must be passed|failed|inconclusive|not-run`;
      }
      if (!['runtime-test', 'static-check', 'evidence-review'].includes(String(item.method || ''))) {
        return `--completion-file ${group}[${offset}].method must be runtime-test|static-check|evidence-review`;
      }
      if (typeof item.evidence !== 'string' || !item.evidence.trim()) {
        return `--completion-file ${group}[${offset}].evidence must be a non-empty string`;
      }
      if (item.evidenceRefs !== undefined && (
        !stringArray(item.evidenceRefs)
        || item.evidenceRefs.length === 0
        || item.evidenceRefs.some((entry) => !entry.trim())
      )) {
        return `--completion-file ${group}[${offset}].evidenceRefs must be a non-empty string array when provided`;
      }
    }
  }
  return null;
}

export function supervisorCompletionEvidenceRefs(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const raw = value as Record<string, unknown>;
  return [...new Set(['stopWhen', 'validation'].flatMap((group) => (
    Array.isArray(raw[group])
      ? (raw[group] as Array<Record<string, unknown>>).flatMap((item) => (
          Array.isArray(item?.evidenceRefs) ? item.evidenceRefs.map(String) : []
        ))
      : []
  )))];
}
