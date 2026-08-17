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
      const input = projectManagerStartupInput(agent, 'E:\\runtime\\manage-project\\SKILL.md');

      expect(input).toContain(PROJECT_MANAGER_ALIGNMENT_GATE);
      expect(input).toContain('wmux project ask');
      expect(input).toContain('category=clarification');
      expect(input).toContain('禁止只在项目管理终端输出问题后等待');
      expect(input).toContain('recommendedOptionId');
      expect(input).toContain('下一轮结构化提问');
      expect(input).toContain('category=manual-intervention');
    },
  );
});
