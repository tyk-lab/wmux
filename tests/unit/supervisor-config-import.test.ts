import { describe, expect, it } from 'vitest';
import {
  matchExistingSupervisorTerminalConfigs,
  planSupervisorTerminalConfigImport,
  supervisorWaitingConfigAction,
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

  it('applies imported configs to every selected terminal and reuses the first template when unmatched', () => {
    const result = planSupervisorTerminalConfigImport([
      { surfaceId: 'surf-new', taskGoal: '新增监督终端' },
      { surfaceId: 'surf-missing', taskGoal: '应跳过' },
    ], ['surf-retained', 'surf-new']);

    expect(result).toEqual({
      configs: [
        { surfaceId: 'surf-retained', taskGoal: '新增监督终端' },
        { surfaceId: 'surf-new', taskGoal: '新增监督终端' },
      ],
      selectedSurfaceIds: ['surf-retained', 'surf-new'],
      templateApplications: 1,
    });
  });

  it('rebinds a saved terminal config to a selected replacement terminal', () => {
    const result = planSupervisorTerminalConfigImport([
      { surfaceId: 'surf-missing', taskGoal: '复用配置' },
    ], ['surf-retained']);

    expect(result).toEqual({
      configs: [{ surfaceId: 'surf-retained', taskGoal: '复用配置' }],
      selectedSurfaceIds: ['surf-retained'],
      templateApplications: 1,
    });
  });
});

describe('supervisor waiting config action', () => {
  it('finalizes a waiting completion when the option is unchecked', () => {
    expect(supervisorWaitingConfigAction('waiting', false, true)).toBe('finalize');
  });

  it('resumes a waiting lane when retained config changes', () => {
    expect(supervisorWaitingConfigAction('waiting', true, true)).toBe('resume');
  });

  it('keeps non-completed and unchanged waiting lanes in their current state', () => {
    expect(supervisorWaitingConfigAction('active', false, true)).toBe('retain');
    expect(supervisorWaitingConfigAction('paused', false, true)).toBe('retain');
    expect(supervisorWaitingConfigAction('waiting', true, false)).toBe('retain');
  });
});
