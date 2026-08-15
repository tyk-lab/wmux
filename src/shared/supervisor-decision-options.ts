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

const MARKER_PREFIX = '(?:^|[；;\\n])\\s*(?:>\\s*)?(?:(?:[-*+•·]|#{1,6})\\s*)*(?:(?:\\*\\*|__|`)\\s*)?';
const MARKER_SUFFIX = '\\s*(?:[（(]\\s*(?:推荐|首选|建议|recommended|preferred)\\s*[）)])?\\s*(?:(?:\\*\\*|__|`)\\s*)?';
const MARKER_SEPARATOR = '(?:[）)\\]]\\s*(?:[:：、.．]|\\s*[-—–]\\s*)?|[:：、.．]|\\s*[-—–]\\s*)\\s*';

function markerPattern(body: string, separator = MARKER_SEPARATOR, flags = 'giu'): RegExp {
  return new RegExp(`${MARKER_PREFIX}${body}${MARKER_SUFFIX}${separator}`, flags);
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

function markdownTableOptions(source: string, explicitChoiceContext: boolean): SupervisorDecisionOption[] {
  const firstTableIndex = source.search(/^\s*\|/mu);
  const hasChoiceHeader = /^\s*\|\s*(?:方案|选项|option|plan)\s*\|/imu.test(source);
  const hasChoiceIntroduction = firstTableIndex >= 0
    && /(?:请[^\n]{0,20}选|选择|选项|备选|方案|下一步)/u.test(source.slice(0, firstTableIndex));
  if (!explicitChoiceContext && !hasChoiceHeader && !hasChoiceIntroduction) return [];
  const options = source.split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
    const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
    if (cells.length < 2 || cells.every((cell) => /^:?-{2,}:?$/u.test(cell))) return [];
    const rawMarker = cells[0].replace(/^(?:\*\*|__|`)|(?:\*\*|__|`)$/gu, '').trim();
    const match = rawMarker.match(/^(?:(?:方案|选项|option|plan)\s*)?([A-F]|[1-9]\d?)$/iu);
    if (!match) return [];
    const token = match[1].toUpperCase();
    const title = /^[A-F]$/u.test(token) ? `方案 ${token}` : `选项 ${token}`;
    const detail = cells.slice(1).filter(Boolean).join('；') || '未提供方案说明';
    return [{ value: title, title, detail }];
  });
  const unique = options.filter((option, index) => (
    options.findIndex((candidate) => candidate.value === option.value) === index
  ));
  return unique.length >= 2 ? unique.slice(0, 6) : [];
}

const CIRCLED_NUMBER_VALUES: Record<string, string> = {
  '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5',
  '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9', '⑩': '10',
};

/** Extract stable user choices from common Agent proposal and Markdown formats. */
export function supervisorDecisionOptions(
  alternatives: string | undefined,
  recommendation: string,
): SupervisorDecisionOption[] {
  const source = alternatives?.trim() || recommendation.trim();
  const letterOptions = markedOptions(
    source,
    markerPattern('(?:(?:方案|选项|路径|路线|option|plan)\\s*)?[（(\\[]?([A-F])'),
    (match) => `方案 ${match[1].toUpperCase()}`,
  );
  if (letterOptions.length >= 2) return letterOptions;

  const bareLetterOptions = markedOptions(
    source,
    markerPattern(
      '(?:(?:方案|选项|路径|路线|option|plan)\\s*)?[（(\\[]?([A-F])',
      '(?=\\s*(?:[；;\\n]|$))\\s*',
    ),
    (match) => `方案 ${match[1].toUpperCase()}`,
  );
  if (bareLetterOptions.length >= 2) return bareLetterOptions;

  const chineseNumberOptions = markedOptions(
    source,
    markerPattern('(?:方案|选项|路径|路线)\\s*([一二三四五六])'),
    (match) => `方案${match[1]}`,
  );
  if (chineseNumberOptions.length >= 2) return chineseNumberOptions;

  const tableOptions = markdownTableOptions(source, !!alternatives?.trim());
  if (tableOptions.length >= 2) return tableOptions;

  const numberedPattern = markerPattern('(?:(?:方案|选项|option|plan)\\s*)?([1-9]\\d?)');
  const firstNumberedIndex = source.search(numberedPattern);
  const numberedChoiceContext = !!alternatives?.trim()
    || firstNumberedIndex >= 0
      && /(?:请[^\n]{0,20}选|选择|选项|备选|方案|下一步)/u.test(source.slice(0, firstNumberedIndex));
  if (numberedChoiceContext) {
    const numberedOptions = markedOptions(
      source,
      numberedPattern,
      (match) => `选项 ${match[1]}`,
    );
    if (numberedOptions.length >= 2) return numberedOptions;
  }

  const circledPattern = markerPattern('([①②③④⑤⑥⑦⑧⑨⑩])', '(?:[:：、.．]|\\s+)\\s*', 'gu');
  const firstCircledIndex = source.search(circledPattern);
  const circledChoiceContext = !!alternatives?.trim()
    || firstCircledIndex >= 0
      && /(?:请[^\n]{0,20}选|选择|选项|备选|方案|下一步)/u.test(source.slice(0, firstCircledIndex));
  if (circledChoiceContext) {
    const circledOptions = markedOptions(
      source,
      circledPattern,
      (match) => `选项 ${CIRCLED_NUMBER_VALUES[match[1]]}`,
    );
    if (circledOptions.length >= 2) return circledOptions;
  }

  const firstBulletIndex = source.search(/(?:^|\n)[ \t]{0,1}[-*+•]\s+/u);
  const bulletChoiceContext = !!alternatives?.trim()
    || firstBulletIndex >= 0
      && /(?:请[^\n]{0,20}选|选择|选项|备选|可选方案|以下方案|下一步)\s*[:：]?\s*$/mu.test(
        source.slice(0, firstBulletIndex),
      );
  if (bulletChoiceContext) {
    const bulletOptions = markedOptions(
      source,
      /(?:^|\n)[ \t]{0,1}[-*+•]\s+/gu,
      (_match) => '',
    ).map((option, index) => ({
      ...option,
      value: `选项 ${index + 1}`,
      title: `选项 ${index + 1}`,
    }));
    const containsMetadataBullets = bulletOptions.some((option) => (
      /^(?:优点|缺点|风险|影响|注意事项?|步骤|验证|原因|说明)\s*[:：]/u.test(option.detail)
    ));
    if (bulletOptions.length >= 2 && !containsMetadataBullets) return bulletOptions;
  }

  return [{
    value: '采用 AI 当前建议',
    title: '采用 AI 当前建议',
    detail: recommendation.trim() || 'AI 未提供具体下一步，请选择后由 AI 监督结合终端状态整理。',
  }];
}
