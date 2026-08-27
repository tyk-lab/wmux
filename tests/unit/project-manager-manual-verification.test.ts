import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dialogSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/ProjectManager/ProjectManagerDialog.tsx'),
  'utf8',
);
const stylesSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/styles/supervisor.css'),
  'utf8',
);

describe('project manager manual verification flow', () => {
  it('renders a dedicated feedback step after the user chooses manual verification', () => {
    expect(dialogSource).toContain("option.id === 'manual-verify-complete'");
    expect(dialogSource).toContain("option.id === 'manual-verify-defer'");
    expect(dialogSource).toContain('人工验收等待，需要你反馈');
    expect(dialogSource).toContain('进入人工验收步骤');
    expect(dialogSource).toContain('确认完成人工验收');
    expect(dialogSource).toContain('确认暂缓并保持暂停');
    expect(dialogSource).toContain('可选：逐项填写实际结果');
    expect(dialogSource).toContain('不会重新执行自动 GUI 验证');
  });

  it('keeps result text optional when the user declares verification complete', () => {
    expect(dialogSource).not.toContain('manualVerificationCompletionSelected && !clarificationAnswer.trim()');
    expect(dialogSource).toContain('留空表示确认已按说明完成且未补充异常');
    expect(dialogSource).toContain('manualVerificationDeferredSelected');
    expect(stylesSource).toContain('.project-manager-dialog__manual-verification-guide');
    expect(stylesSource).toContain('white-space: pre-wrap');
  });
});
