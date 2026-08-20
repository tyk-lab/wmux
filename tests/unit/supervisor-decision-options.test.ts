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

  it('keeps compatibility with bare semicolon-separated proposal labels', () => {
    expect(supervisorDecisionOptions('方案 A；方案 B', '建议选择其一').map((option) => option.value)).toEqual([
      '方案 A',
      '方案 B',
    ]);
  });

  it('extracts Markdown numbered recommendations into stable choices', () => {
    expect(supervisorDecisionOptions(
      undefined,
      '请你选下一步\n1. 收官（推荐）：整理结果\n2. 试宽量级：继续测试\n3. 换策略：调整算法',
    )).toEqual([
      { value: '选项 1', title: '选项 1', detail: '收官（推荐）：整理结果' },
      { value: '选项 2', title: '选项 2', detail: '试宽量级：继续测试' },
      { value: '选项 3', title: '选项 3', detail: '换策略：调整算法' },
    ]);
  });

  it('extracts bold Markdown headings and recommendation annotations', () => {
    expect(supervisorDecisionOptions(
      '- **方案 A（推荐）**：保持现有实现并补测试\n- **方案 B**：切换到新实现',
      '推荐方案 A',
    )).toEqual([
      { value: '方案 A', title: '方案 A', detail: '保持现有实现并补测试' },
      { value: '方案 B', title: '方案 B', detail: '切换到新实现' },
    ]);
  });

  it('extracts Chinese-numbered and English-labelled proposals', () => {
    expect(supervisorDecisionOptions(
      '### 方案一：保守修复\n### 方案二：完整迁移',
      '',
    ).map((option) => option.value)).toEqual(['方案一', '方案二']);
    expect(supervisorDecisionOptions(
      'Option 1: Keep compatibility\nPlan 2: Replace the API',
      '',
    ).map((option) => option.value)).toEqual(['选项 1', '选项 2']);
  });

  it('extracts circled and plain bullet choices in explicit choice contexts', () => {
    expect(supervisorDecisionOptions(
      undefined,
      '请选择下一步：\n① 保持当前路线\n② 切换实现',
    ).map((option) => option.value)).toEqual(['选项 1', '选项 2']);
    expect(supervisorDecisionOptions(
      '- 保持当前路线\n- 切换到兼容层',
      '',
    ).map((option) => option.detail)).toEqual(['保持当前路线', '切换到兼容层']);
  });

  it('extracts options from a Markdown comparison table', () => {
    expect(supervisorDecisionOptions(
      '| 方案 | 说明 | 风险 |\n| --- | --- | --- |\n| A | 保持接口 | 低 |\n| B | 重写接口 | 高 |',
      '',
    )).toEqual([
      { value: '方案 A', title: '方案 A', detail: '保持接口；低' },
      { value: '方案 B', title: '方案 B', detail: '重写接口；高' },
    ]);
  });

  it('does not treat generic tables or plan metadata bullets as choices', () => {
    expect(supervisorDecisionOptions(
      undefined,
      '| 序号 | 测试结果 |\n| --- | --- |\n| 1 | 通过 |\n| 2 | 失败 |',
    )).toHaveLength(1);
    expect(supervisorDecisionOptions(
      '当前方案：\n- 优点：改动较小\n- 风险：仍需回归测试',
      '继续采用当前方案',
    )).toHaveLength(1);
  });

  it('does not treat an ordinary numbered procedure as user choices', () => {
    expect(supervisorDecisionOptions(
      undefined,
      '继续当前路线：\n1. 更新实现\n2. 运行测试\n3. 整理结果',
    )).toEqual([{
      value: '采用 AI 当前建议',
      title: '采用 AI 当前建议',
      detail: '继续当前路线：\n1. 更新实现\n2. 运行测试\n3. 整理结果',
    }]);
    expect(supervisorDecisionOptions(
      undefined,
      '执行步骤：\n- 更新实现\n- 运行测试\n- 整理结果',
    )).toHaveLength(1);
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
      userGuidance: '保留现有 API，并先补充回归测试',
      recommendation: 'AI 推荐方案 A',
      reason: '现有路线受阻',
      impact: '可能增加改动范围',
      alternatives: 'A) 保持当前路线；B) 切换到备选实现',
    });

    expect(briefing).toContain('[用户选择] 方案 B：切换到备选实现');
    expect(briefing).toContain('[用户补充信息] 保留现有 API，并先补充回归测试');
    expect(briefing).toContain('用户补充信息是决策依据，不是可原样发送到任务终端的命令');
    expect(briefing).toContain('请先 read-screen 获取任务终端最新状态');
    expect(briefing).toContain('wmux supervisor decide --surface surface-worker');
    expect(briefing).toContain('.wmux/tmp/<唯一文件名>.txt');
    expect(briefing).toContain('--next-file');
    expect(briefing).toContain('禁止在项目根目录创建监督草稿');
    expect(briefing).toContain('不要把本消息原样转发');
  });

  it('lets the AI supervisor decide from user guidance when no plan is selected', () => {
    const briefing = buildAdoptedPlanBriefing({
      surfaceId: 'surface-worker',
      userGuidance: '先确认失败是否来自环境配置，再决定修复路线',
      recommendation: '',
    });

    expect(briefing).toContain('[人工决定] 用户未指定固定方案');
    expect(briefing).toContain('[用户选择] 未指定固定方案，由 AI 监督判断');
    expect(briefing).toContain('[用户补充信息] 先确认失败是否来自环境配置，再决定修复路线');
    expect(briefing).toContain('wmux supervisor decide --surface surface-worker');
    expect(briefing).toContain('不要把本消息原样转发');
  });
});
