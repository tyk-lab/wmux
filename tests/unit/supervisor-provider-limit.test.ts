import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSupervisorProviderLimitAlert,
  detectSupervisorProviderLimit,
  reportSupervisorProviderLimit,
  resetSupervisorProviderLimitAlerts,
} from '../../src/renderer/supervisor/provider-limit';
import { useStore } from '../../src/renderer/store';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';

const lane = (): SupervisorLane => ({
  id: 'lane-limit',
  label: '代码审查',
  surfaceId: 'worker-limit' as any,
  supervisorSurfaceId: 'supervisor-limit' as any,
  projectDir: 'E:\\repo',
  enabled: true,
  steps: [],
  maxAutoSteps: 0,
  autoStepsUsed: 0,
  awaitingStopCheck: false,
  stopConfirmed: false,
  awaitingReview: true,
  autoDecisionsUsed: 0,
  decisions: [],
});

describe('AI supervisor provider limit detection', () => {
  beforeEach(() => {
    resetSupervisorProviderLimitAlerts();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        wmux: {
          supervisor: { appendRecord: vi.fn(async () => undefined) },
          notification: { fire: vi.fn() },
        },
      },
    });
    const store = useStore.getState();
    store.resetSupervisorSession();
    store.setSupervisorLanes([lane()]);
    store.patchSupervisor({ supervisorModel: 'gpt-limited' });
    store.startSupervisor();
  });

  afterEach(() => {
    useStore.getState().resetSupervisorSession();
    resetSupervisorProviderLimitAlerts();
    Reflect.deleteProperty(globalThis, 'window');
  });

  it.each([
    ['Error: request failed with status code 429', 'rate-limit'],
    ['Too many requests. Rate limit exceeded for tokens per minute.', 'rate-limit'],
    ["You've hit your usage limit. Try again later.", 'quota-limit'],
    ['insufficient_quota: monthly quota exceeded', 'quota-limit'],
    ['模型配额已用尽，请稍后重试', 'quota-limit'],
  ])('recognizes provider failure %s', (message, category) => {
    expect(detectSupervisorProviderLimit(message)).toMatchObject({ category, summary: message });
  });

  it.each([
    '请为 HTTP 429 添加重试测试',
    '实现 rate limit 的退避策略',
    '请实现请求速率限制',
    '请处理模型配额已用尽的提示页面',
    '测试正常完成，没有服务错误',
  ])('does not treat task text as a provider failure: %s', (message) => {
    expect(detectSupervisorProviderLimit(message)).toBeNull();
  });

  it('records and notifies one Feishu event for repeated output in the same failed turn', () => {
    const session = useStore.getState().supervisor;
    const currentLane = session.lanes[0];

    expect(reportSupervisorProviderLimit(session, currentLane, 'Error: request failed with status code 429')).toBe(true);
    expect(reportSupervisorProviderLimit(session, currentLane, 'Error: request failed with status code 429')).toBe(false);

    const appendRecord = (globalThis.window as any).wmux.supervisor.appendRecord;
    expect(appendRecord).toHaveBeenCalledTimes(1);
    expect(appendRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'supervisor.provider-limit',
      payload: expect.objectContaining({
        category: 'rate-limit',
        summary: 'Error: request failed with status code 429',
        supervisorModel: 'gpt-limited',
      }),
    }));
    expect((globalThis.window as any).wmux.notification.fire).toHaveBeenCalledWith(expect.objectContaining({
      title: 'AI 监督模型受限',
      text: expect.stringContaining('代码审查'),
    }));
  });

  it('redacts common credentials before publishing the error summary', () => {
    const detected = detectSupervisorProviderLimit('Error 429: api_key=sk-secret_value_123456 rate limit exceeded');

    expect(detected?.summary).toContain('已隐藏凭据');
    expect(detected?.summary).not.toContain('sk-secret_value_123456');
  });

  it('allows the same provider limit to alert again after a new supervisor turn starts', () => {
    const session = useStore.getState().supervisor;
    const currentLane = session.lanes[0];

    expect(reportSupervisorProviderLimit(session, currentLane, 'Error: status code 429')).toBe(true);
    clearSupervisorProviderLimitAlert(session, currentLane);
    expect(reportSupervisorProviderLimit(session, currentLane, 'Error: status code 429')).toBe(true);
    expect((globalThis.window as any).wmux.supervisor.appendRecord).toHaveBeenCalledTimes(2);
  });
});
