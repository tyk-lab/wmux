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
    expect(agents).toContain('将该阶段状态更新为 `achieved`');
    expect(agents).toContain('同一证据与拓扑状态下最多回执一次 `replanned`');
    expect(agents).toContain('`reasonCode=verification-limited`');
    expect(agents).toContain('明确豁免当前普通验证且不再补验');
    expect(agents).toContain('条件具备后必须由用户恢复原工作项');
    expect(agents).toContain('当前验证工作项进入 `stopped`');
    expect(agents).toContain('跳过剩余普通验证并接受完成');
    expect(agents).toContain('`update-definition mode=refine`');
    expect(agents).toContain('`mode=pivot`');
    expect(agents).toContain('不得将对应标准写为 `satisfied`');
    expect(agents).toContain('缺少自动化通道改写成同义任务反复派发');
    expect(agents).toContain('恢复耗尽并准备暂停时才可用 `runtime-recovery`');
    expect(agents).toContain('不得只弹警告');

    expect(agents).toContain('首次需求摘要必须通过结构化 `wmux project ask`');
    expect(agents).toContain('任务 AI 是唯一项目执行者和最终技术决策者');
    expect(agents).toContain('不得向它披露项目 AI、监督 AI、项目/工作项 ID、lane、路由、预算、内部协议或角色关系');
    expect(agents).toContain('一个工作项对应一个可独立验收的完整成果');
    expect(agents).toContain('不得为每条验收、每次监督交接或每次补证创建同义后继任务');
    expect(agents).toContain('`task-create` 必须在 `contract.stageAcceptanceCoverage` 中显式提交');
    expect(agents).toContain('只对原工作项执行 `task-update` 补充 `contract.stageAcceptanceCoverage`');
    expect(agents).toContain('监督 AI无法在工作项合同内决策时才上报项目 AI');
    expect(agents).toContain('每次 `project ask` 都必须形成完整用户决策包');
    expect(agents).toContain('`recommendedOptionId` 明确推荐其中一项');
    expect(agents).toContain('验证通过、失败或当前无法取得都必须如实返回');
    expect(agents).toContain('辅助 AI默认关闭');
  });
});
