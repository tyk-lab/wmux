import { useStore } from '../store';
import type { SupervisorLane, SupervisorSession } from '../store/supervisor-slice';
import { appendSupervisorRecord } from './recording';

export interface SupervisorProviderLimitError {
  category: 'rate-limit' | 'quota-limit';
  summary: string;
}

const recentAlerts = new Set<string>();
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

function cleanProviderError(value: string): string {
  return value
    .replace(ANSI_ESCAPE, '')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"']+/g, '本地路径已隐藏')
    .replace(/\b(?:sk-|ghp_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/g, '已隐藏凭据')
    .replace(/\b(?:secret|token|password|api[_ -]?key)\s*[:=]\s*\S+/ig, '$1: 已隐藏凭据')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/** Recognize provider limit failures without treating a task that merely mentions HTTP 429 as an error. */
export function detectSupervisorProviderLimit(text: string): SupervisorProviderLimitError | null {
  const lines = String(text || '')
    .split(/\r?\n/u)
    .map((line) => cleanProviderError(line))
    .filter(Boolean)
    .slice(-24);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const summary = lines[index];
    const normalized = summary.toLocaleLowerCase();
    const explicit429 = /(?:error|failed|failure|status(?:\s+code)?|response|returned|received|请求失败|错误|失败|响应)[^\n]{0,80}\b429\b|\b429\b[^\n]{0,80}(?:error|failed|failure|too many requests|错误|失败|请求过多)/iu.test(summary);
    const rateLimit = /too many requests|rate[_ -]?limit(?:ed)?[_ -]?(?:reached|exceeded)|\brate[_ -]?limited\b|(?:error|failed|failure).{0,60}rate limit|rate limit.{0,60}(?:error|failed|failure)|请求(?:过多|频率过高|被限流)|(?:错误|失败|达到|触发|超过).{0,20}速率限制|速率限制.{0,20}(?:错误|失败|已达|触发|超过)/iu.test(normalized);
    const quotaLimit = /insufficient[_ -]?quota|quota (?:exceeded|reached|exhausted)|resource[_ -]?exhausted|you(?:'ve| have) hit your (?:usage|rate) limit|usage limit (?:reached|exceeded)|(?:额度|配额).{0,16}(?:用尽|耗尽|不足|超限|已达上限).{0,30}(?:重试|错误|失败|购买|升级|等待)/iu.test(normalized);
    if (quotaLimit) return { category: 'quota-limit', summary };
    if (explicit429 || rateLimit) return { category: 'rate-limit', summary };
  }
  return null;
}

/** Persist and deliver one alert per lane/category until the next supervisor turn. */
export function reportSupervisorProviderLimit(
  session: SupervisorSession,
  lane: SupervisorLane,
  text: string,
): boolean {
  const error = detectSupervisorProviderLimit(text);
  if (!error) return false;

  const key = `${lane.managementSessionId || session.sessionId}:${lane.id}:${error.category}`;
  if (recentAlerts.has(key)) return false;
  recentAlerts.add(key);
  if (recentAlerts.size > 128) recentAlerts.delete(recentAlerts.keys().next().value as string);

  appendSupervisorRecord(session, lane, 'supervisor.provider-limit', {
    category: error.category,
    summary: error.summary,
    supervisorModel: session.supervisorModel || 'Agent 默认模型',
  });
  const store = useStore.getState();
  store.updateLane(lane.id, {
    supervisorProblem: {
      kind: 'provider-limit',
      detail: error.summary,
      detectedAt: Date.now(),
    },
  });
  store.appendSupervisorLog(lane.id, '监督模型受限', error.summary);
  const notificationText = `AI 监督通道“${lane.label}”的模型请求受限：${error.summary}`;
  const workspaceId = lane.workspaceId || store.activeWorkspaceId;
  if (workspaceId) store.addNotification({ surfaceId: lane.surfaceId, workspaceId, text: notificationText });
  window.wmux?.notification?.fire({
    surfaceId: lane.surfaceId,
    title: 'AI 监督模型受限',
    text: notificationText,
  });
  return true;
}

/** A new supervisor turn may legitimately encounter the same provider limit again. */
export function clearSupervisorProviderLimitAlert(session: SupervisorSession, lane: SupervisorLane): void {
  const prefix = `${lane.managementSessionId || session.sessionId}:${lane.id}:`;
  for (const key of recentAlerts.keys()) {
    if (key.startsWith(prefix)) recentAlerts.delete(key);
  }
  const current = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id);
  if (current?.supervisorProblem?.kind === 'provider-limit') {
    useStore.getState().updateLane(lane.id, { supervisorProblem: undefined });
  }
}

export function resetSupervisorProviderLimitAlerts(): void {
  recentAlerts.clear();
}
