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
      expect(input).toContain('decisionScope');
      expect(input).toContain('confirmationScope');
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
      expect(input).toContain('用户提供的主目标是权威输入');
      expect(input).toContain('项目 AI 不得自行替换成另一个目标');
      expect(input).toContain('补全必要前置条件、可验证完成条件、阶段计划和工作项合同');
      expect(input).toContain('首要活性义务是推进当前主目标');
      expect(input).toContain('内部合同、基线同步、证据路径和普通技术失败');
      expect(input).toContain('不得把参数调整、技术路线、候选选择、普通失败后的重新资格包装成 business-choice');
      expect(input).toContain('扩大设备、环境、参数安全上限、接线、固件、控制环和风险授权');
      expect(input).toContain('项目内部的实现路线、优先级、候选方案、资源分配');
      expect(input).toContain('任务 AI 权限提示由监督 AI 处理');
      expect(input).toContain('创建任务时只定义成果、验收、依赖和用户安全边界');
      expect(input).toContain('外部访问、凭据、提权、发布、生产和真实硬件高风险授权才可询问用户');
      expect(input).toContain('不再用 allowPaths/denyPaths 充当任务 AI 文件权限');
      expect(input).toContain('任务 AI 必须优先核对适用的 AGENTS、项目技能、产物目录和命名规则');
    },
  );
});
