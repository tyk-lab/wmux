import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dialogSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/ProjectManager/ProjectManagerDialog.tsx'),
  'utf8',
);
const commandSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/cli/project-command.ts'),
  'utf8',
);
const roleSource = fs.readFileSync(
  path.resolve(__dirname, '../../resources/agents/project-ai/ROLE_AGENTS.md'),
  'utf8',
);

describe('project verification policy presentation', () => {
  it('allows policies to be selected at creation and changed during execution', () => {
    expect(dialogSource).toContain('用户最终验收策略');
    expect(dialogSource).toContain('完成条件验证要求');
    expect(dialogSource).toContain('userAcceptancePolicy: definitionUserAcceptancePolicy');
    expect(dialogSource).toContain('verificationPolicies: submittedVerificationPolicies');
    expect(dialogSource).toContain('effectiveDefinitionVerificationPolicies.map((policy)');
    expect(dialogSource).toContain('setDefinitionVerificationRequirement(verificationRequirementSummary(nextPolicies))');
    expect(dialogSource).toContain('用户为该完成条件单独切换验证要求');
    expect(dialogSource).toContain('保护性条件（始终必验）');
    expect(dialogSource).toContain('普通成果（可调整验证）');
    expect(dialogSource).toContain('仅调整同一完成条件的验收/验证策略会立即生效');
    expect(dialogSource).toContain('其他运行中变更仍会生成新的需求版本');
    expect(dialogSource).toContain('历史验证结果和已知失败不会被改写');
  });

  it('documents the structured update fields and safe switching semantics', () => {
    expect(commandSource).toContain('"userAcceptancePolicy": "always|on-gap|not-required"');
    expect(commandSource).toContain('"required|best-effort|not-applicable"');
    expect(commandSource).toContain('"riskClass":"protected|standard"');
    expect(commandSource).toContain('A runtime policy change creates a new requirements version');
    expect(roleSource).toContain('用户是在目标定义层面调整今后适用的全部或一类验证策略时');
    expect(roleSource).toContain('当前决策中选择跳过普通验证');
    expect(roleSource).toContain('两种路径都不得改写旧 completion');
    expect(roleSource).toContain('不得降级为 `best-effort` 或 `not-applicable`');
  });
});
