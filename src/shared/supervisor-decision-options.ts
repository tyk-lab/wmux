export interface SupervisorDecisionOption {
  value: string;
  title: string;
  detail: string;
}

export const SUPERVISOR_NO_DECISION_OPTION = '__wmux_no_decision_option__';

interface DecisionMarker {
  index: number;
  end: number;
  value: string;
  title: string;
}

function markedOptions(
  source: string,
  pattern: RegExp,
  label: (match: RegExpMatchArray) => string,
): SupervisorDecisionOption[] {
  const markers = [...source.matchAll(pattern)].slice(0, 6).map((match): DecisionMarker => {
    const title = label(match);
    return {
      index: match.index || 0,
      end: (match.index || 0) + match[0].length,
      value: title,
      title,
    };
  });
  if (markers.length < 2) return [];
  return markers.map((marker, index) => ({
    value: marker.value,
    title: marker.title,
    detail: source.slice(marker.end, markers[index + 1]?.index ?? source.length)
      .replace(/[；;\s]+$/u, '')
      .trim() || '未提供方案说明',
  }));
}

/** Extract stable user choices from either A/B proposals or Markdown-style numbered lists. */
export function supervisorDecisionOptions(
  alternatives: string | undefined,
  recommendation: string,
): SupervisorDecisionOption[] {
  const source = alternatives?.trim() || recommendation.trim();
  const letterOptions = markedOptions(
    source,
    /(?:^|[；;\n])\s*(?:方案\s*)?([A-F])\s*(?:[）):：、.]|\s+-)\s*/giu,
    (match) => `方案 ${match[1].toUpperCase()}`,
  );
  if (letterOptions.length >= 2) return letterOptions;

  const bareLetterOptions = markedOptions(
    source,
    /(?:^|[；;\n])\s*(?:方案\s*)?([A-F])(?=\s*(?:[；;\n]|$))\s*/giu,
    (match) => `方案 ${match[1].toUpperCase()}`,
  );
  if (bareLetterOptions.length >= 2) return bareLetterOptions;

  const firstNumberedIndex = source.search(/(?:^|[；;\n])\s*[1-9]\d?\s*[.)）:：、]\s*/u);
  const numberedChoiceContext = !!alternatives?.trim()
    || firstNumberedIndex >= 0
      && /(?:请[^\n]{0,20}选|选择|选项|备选|方案|下一步)/u.test(source.slice(0, firstNumberedIndex));
  if (numberedChoiceContext) {
    const numberedOptions = markedOptions(
      source,
      /(?:^|[；;\n])\s*([1-9]\d?)\s*[.)）:：、]\s*/gu,
      (match) => `选项 ${match[1]}`,
    );
    if (numberedOptions.length >= 2) return numberedOptions;
  }

  return [{
    value: '采用 AI 当前建议',
    title: '采用 AI 当前建议',
    detail: recommendation.trim() || 'AI 未提供具体下一步，请选择后由 AI 监督结合终端状态整理。',
  }];
}
