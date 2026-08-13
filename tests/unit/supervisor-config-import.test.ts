import { describe, expect, it } from 'vitest';
import {
  matchExistingSupervisorTerminalConfigs,
  planSupervisorTerminalConfigImport,
} from '../../src/renderer/supervisor/config-file';

describe('supervisor terminal config import', () => {
  it('matches existing terminals and skips configs for terminals that no longer exist', () => {
    const result = matchExistingSupervisorTerminalConfigs([
      { surfaceId: 'surf-existing', taskGoal: '保留' },
      { surfaceId: 'surf-missing', taskGoal: '跳过' },
    ], ['surf-existing', 'surf-other']);

    expect(result).toEqual({
      configs: [{ surfaceId: 'surf-existing', taskGoal: '保留' }],
      skipped: 1,
    });
  });

  it('keeps retained supervision lanes selected without overwriting them from the import', () => {
    const result = planSupervisorTerminalConfigImport([
      { surfaceId: 'surf-new', taskGoal: '新增监督终端' },
      { surfaceId: 'surf-missing', taskGoal: '应跳过' },
    ], ['surf-retained', 'surf-new'], ['surf-retained']);

    expect(result).toEqual({
      configs: [{ surfaceId: 'surf-new', taskGoal: '新增监督终端' }],
      skipped: 1,
      selectedSurfaceIds: ['surf-retained', 'surf-new'],
    });
  });

  it('reports no import targets when every saved terminal is missing', () => {
    const result = planSupervisorTerminalConfigImport([
      { surfaceId: 'surf-missing' },
    ], ['surf-retained'], ['surf-retained']);

    expect(result).toEqual({
      configs: [],
      skipped: 1,
      selectedSurfaceIds: ['surf-retained'],
    });
  });
});
