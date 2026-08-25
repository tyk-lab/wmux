const PROJECT_PLANS_ROOT = '.project-plans/';
const PROJECT_PLAN_DIRECTORIES = new Set(['plans', 'debug', 'experiments', 'archive']);

function normalizeProjectPath(value: string): string {
  return value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '').toLowerCase();
}

function runtimeArtifactName(name: string): boolean {
  const runtimeDataFile = /\.(?:json|txt|log|csv|tsv|xml|trx|jsonl|ndjson)$/u.test(name);
  return /\.(?:log|csv|tsv|xml|trx|jsonl|ndjson)$/u.test(name)
    || /\.(?:stdout|stderr|output)\.(?:json|txt)$/u.test(name)
    || /\.(?:dry-run|validate)(?:\.(?:stdout|stderr|output))?\.json$/u.test(name)
    || (runtimeDataFile && /(?:^|[-_.])(?:results?|outcomes?|outputs?|metrics?|measurements?|observations?|validations?|offline-validation|dry[-_]?run|closures?|evidence|summaries?|reports?|telemetry|failures?|manifests?|safe[-_]?stop|pytest|unittest|junit|experiments?|logs?)(?:[-_.]|$)/u.test(name));
}

function reusableTemplateInputName(name: string): boolean {
  if (!/\.(?:json|ya?ml|toml|ini|txt|md)$/u.test(name)) return false;
  const runtimeOutput = /(?:^|[-_.])(?:results?|outcomes?|outputs?|metrics?|measurements?|observations?|validations?|offline-validation|dry[-_]?run|closures?|evidence|summaries?|reports?|telemetry|failures?|manifests?|safe[-_]?stop|pytest|unittest|junit|logs?)(?:[-_.]|$)/u.test(name);
  return /(?:^|[-_.])(?:candidate|identity|plan|batch|template|index|profile|config|contract|schema|instructions?|inputs?|fixture|parent)(?:[-_.]|$)/u.test(name)
    && !runtimeOutput;
}

/** Deterministic project artifact placement policy shared by renderer and main process. */
export function projectArtifactLocationViolation(value: string): string | null {
  const normalized = normalizeProjectPath(value);
  if (!normalized) return null;
  const name = normalized.split('/').pop() || '';

  if (normalized.startsWith(PROJECT_PLANS_ROOT)) {
    const suffix = normalized.slice(PROJECT_PLANS_ROOT.length);
    const parts = suffix.split('/').filter(Boolean);
    if (parts.length === 1) {
      return parts[0] === 'progress.md'
        ? null
        : `.project-plans 根目录只允许 PROGRESS.md；请按用途写入 plans/、debug/、experiments/ 或 archive/：${value}`;
    }
    if (!PROJECT_PLAN_DIRECTORIES.has(parts[0])) {
      return `.project-plans 下不允许自建混合目录；请使用 plans/、debug/、experiments/ 或 archive/：${value}`;
    }
    if (parts[0] !== 'archive' && runtimeArtifactName(name)) {
      return `项目计划、调试和实验方法目录不能保存实际运行事实；请写入 runs/YYYY-MM-DD/<运行批次>/：${value}`;
    }
    return null;
  }

  const inTemplateDirectory = /(?:^|\/)run[-_]templates(?:\/|$)/u.test(normalized);
  if (inTemplateDirectory && !reusableTemplateInputName(name)) {
    return `模板目录只能保存可复用的预执行输入；运行、验证、日志、结论或结果产物必须写入 runs/YYYY-MM-DD/<运行批次>/：${value}`;
  }
  if (!runtimeArtifactName(name)) return null;
  const runsSuffix = normalized.match(/(?:^|\/)runs\/(.+)$/u)?.[1];
  if (runsSuffix && !runsSuffix.startsWith('run_templates/')) {
    const parts = runsSuffix.split('/').filter(Boolean);
    if (parts.length >= 3 && /^\d{4}-\d{2}-\d{2}$/u.test(parts[0])) return null;
    return `实际运行、验证、日志或结果产物必须写入 runs/YYYY-MM-DD/<运行批次>/：${value}`;
  }
  if (/(?:^|\/)(?:tests?|src)(?:\/|$)/u.test(normalized)) {
    return `源码和测试目录不能保存运行日志或验证结果：${value}`;
  }
  return `运行、验证、日志或结果产物必须写入 runs/YYYY-MM-DD/<运行批次>/：${value}`;
}

/** Bounded structural guard for the dynamic handoff document. */
export function projectProgressDocumentViolation(content: string): string | null {
  if (content.includes('\r')) return 'PROGRESS.md 必须使用 LF 换行';
  if (content.length > 15_000) return 'PROGRESS.md 超过 15000 字符上限，应归档历史内容';
  const lines = content.split('\n');
  if (lines.length > 120) return 'PROGRESS.md 超过 120 行上限，应归档历史内容';
  const longLine = lines.findIndex((line) => line.length > 500);
  if (longLine >= 0) return `PROGRESS.md 第 ${longLine + 1} 行超过 500 字符`;
  if (lines.filter((line) => /^#\s+/u.test(line)).length !== 1) {
    return 'PROGRESS.md 必须且只能包含一个一级标题';
  }
  if (!lines.some((line) => /^##\s+当前任务\s*$/u.test(line))) {
    return 'PROGRESS.md 缺少“## 当前任务”章节';
  }
  if (lines.some((line) => /^##\s+.*(?:追加|补充)/u.test(line))) {
    return 'PROGRESS.md 禁止用追加/补充章节堆积历史状态，应合并到固定模板或归档';
  }
  const currentTaskStart = lines.findIndex((line) => /^##\s+当前任务\s*$/u.test(line));
  const currentTaskEnd = lines.findIndex((line, index) => index > currentTaskStart && /^##\s+/u.test(line));
  const taskLines = lines.slice(currentTaskStart + 1, currentTaskEnd < 0 ? lines.length : currentTaskEnd)
    .filter((line) => /^[-*]\s+/u.test(line));
  return taskLines.length > 8 ? 'PROGRESS.md 当前任务条目不能超过 8 项' : null;
}
