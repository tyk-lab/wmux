import { describe, expect, it } from 'vitest';
import { projectDefinitionLines } from '../../src/renderer/project-manager/definition-lines';

describe('projectDefinitionLines', () => {
  it('keeps Chinese semicolons inside a single condition', () => {
    expect(projectDefinitionLines([
      '硬件已上电；允许测试',
      '断电后资格失效；必须重新恢复',
    ].join('\n'))).toEqual([
      '硬件已上电；允许测试',
      '断电后资格失效；必须重新恢复',
    ]);
  });

  it('uses non-empty trimmed lines as condition items', () => {
    expect(projectDefinitionLines('  第一项  \r\n\r\n 第二项 ')).toEqual(['第一项', '第二项']);
  });
});
