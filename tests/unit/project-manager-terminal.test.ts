import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_MANAGER_PROTOCOL_REVISION,
  projectManagerStartupInput,
} from '../../src/shared/project-manager-terminal';

describe('project manager runtime startup protocol', () => {
  it('uses isolated AGENTS.md and a short capability-bound startup message', () => {
    const input = projectManagerStartupInput('pm-test-project');
    const agents = fs.readFileSync(
      path.join(process.cwd(), 'resources', 'agents', 'project-ai', 'ROLE_AGENTS.md'),
      'utf8',
    );

    expect(input).toContain('当前隔离目录 AGENTS.md');
    expect(input).toContain(`protocol=${PROJECT_MANAGER_PROTOCOL_REVISION}`);
    expect(input).toContain('wmux context');
    expect(input).toContain(`wmux role-ready --protocol ${PROJECT_MANAGER_PROTOCOL_REVISION}`);
    expect(input).toContain('成功前不得规划、提问、创建工作项或派发任务');
    expect(input).not.toContain('$manage-project');
    expect(input).not.toContain('/manage-project');
    expect(input).not.toContain('wmux project ask');
    expect(input.length).toBeLessThan(600);

    expect(agents).toContain('首次需求摘要必须通过结构化 `wmux project ask`');
    expect(agents).toContain('任务 AI 是唯一项目执行者和最终技术决策者');
    expect(agents).toContain('监督 AI无法在工作项合同内决策时才上报项目 AI');
    expect(agents).toContain('验证通过、失败或当前无法取得都必须如实返回');
    expect(agents).toContain('辅助 AI默认关闭');
  });
});
