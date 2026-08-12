import { describe, expect, it } from 'vitest';
import {
  buildAdoptedPlanBriefing,
  supervisorDecisionOptions,
} from '../../src/renderer/supervisor/decision-options';

describe('supervisor decision options', () => {
  it('extracts semicolon-separated A/B alternatives into radio choices', () => {
    expect(supervisorDecisionOptions(
      'A) 保持当前路线并补充验证；B) 切换到备选实现并重新测试',
      '建议采用方案 A',
    )).toEqual([
      {
        value: '方案 A',
        title: '方案 A',
        detail: '保持当前路线并补充验证',
      },
      {
        value: '方案 B',
        title: '方案 B',
        detail: '切换到备选实现并重新测试',
      },
    ]);
  });

  it('extracts alternatives from the recommendation when no separate field exists', () => {
    expect(supervisorDecisionOptions(
      undefined,
      '方案 A：先修复测试\n方案 B：先调整实现',
    ).map((option) => option.detail)).toEqual([
      '先修复测试',
      '先调整实现',
    ]);
  });

  it('offers the current recommendation when AI provides no structured alternatives', () => {
    expect(supervisorDecisionOptions(undefined, '继续当前路线')).toEqual([{
      value: '采用 AI 当前建议',
      title: '采用 AI 当前建议',
      detail: '继续当前路线',
    }]);
  });

  it('briefs the AI supervisor to re-read the terminal and organize the selected plan', () => {
    const briefing = buildAdoptedPlanBriefing({
      surfaceId: 'surface-worker',
      selection: {
        value: '方案 B',
        title: '方案 B',
        detail: '切换到备选实现',
      },
      recommendation: 'AI 推荐方案 A',
      reason: '现有路线受阻',
      impact: '可能增加改动范围',
      alternatives: 'A) 保持当前路线；B) 切换到备选实现',
    });

    expect(briefing).toContain('[用户选择] 方案 B：切换到备选实现');
    expect(briefing).toContain('请先 read-screen 获取任务终端最新状态');
    expect(briefing).toContain('wmux supervisor decide --surface surface-worker');
    expect(briefing).toContain('不要把本消息原样转发');
  });
});
