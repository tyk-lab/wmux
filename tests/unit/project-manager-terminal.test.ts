import { describe, expect, it } from 'vitest';
import {
  PROJECT_MANAGER_ALIGNMENT_GATE,
  projectManagerStartupInput,
  type ProjectManagerRuntimeAgent,
} from '../../src/shared/project-manager-terminal';

describe('project manager runtime startup protocol', () => {
  it.each<ProjectManagerRuntimeAgent>(['codex', 'kimi', 'grok'])(
    'forces %s to use the structured user-alignment channel',
    (agent) => {
      const input = projectManagerStartupInput(agent, 'E:\\runtime\\manage-project\\SKILL.md', 'pm-test-project');

      expect(input).toContain(PROJECT_MANAGER_ALIGNMENT_GATE);
      expect(input).toContain('wmux project ask');
      expect(input).toContain('category=clarification');
      expect(input).toContain('禁止只在项目管理终端输出问题后等待');
      expect(input).toContain('recommendedOptionId');
      expect(input).toContain('下一轮结构化提问');
      expect(input).toContain('category=manual-intervention');
      expect(input).toContain('wmux project status --project pm-test-project');
      expect(input).toContain('只能管理这一个项目');
      expect(input).toContain('无决策权的项目中心');
      expect(input).toContain('当前需求版本内持续有效');
      expect(input).toContain('不得让项目 AI、监督 AI 或任务 AI 逐步重复确认');
      expect(input).toContain('wmux project goal-plan');
      expect(input).toContain('mode=refine');
      expect(input).toContain('mode=pivot');
      expect(input).toContain('旧 goalId 任务不得在新目标下复活');
    },
  );
});
