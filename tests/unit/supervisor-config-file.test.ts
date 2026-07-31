import { describe, expect, it } from 'vitest';
import {
  parseSupervisorConfig,
  serializeSupervisorConfig,
} from '../../src/main/supervisor-config-file';

describe('supervisor config file', () => {
  it('round-trips reusable supervision fields without terminal runtime state', () => {
    const config = {
      taskDescription: '监督速度测试',
      preconditions: '设备已上电，现场安全已确认',
      stopWhen: '测试记录完整',
      stopWhenKind: 'direction',
      planFilePath: 'D:\\plans\\speed.md',
      supervisorLaunchCmd: 'codex',
      supervisorModel: 'gpt-5.6-sol',
      supervisorReasoningEffort: 'high',
      maxAutoDecisions: 5,
      lanes: [{ surfaceId: 'must-not-be-saved' }],
      decisions: [{ outcome: 'complete' }],
    };

    expect(parseSupervisorConfig(serializeSupervisorConfig(config))).toEqual({
      taskDescription: '监督速度测试',
      preconditions: '设备已上电，现场安全已确认',
      stopWhen: '测试记录完整',
      stopWhenKind: 'direction',
      planFilePath: 'D:\\plans\\speed.md',
      supervisorLaunchCmd: 'codex',
      supervisorModel: 'gpt-5.6-sol',
      supervisorReasoningEffort: 'high',
      maxAutoDecisions: 5,
    });
  });

  it('rejects unrelated JSON files and clamps imported limits', () => {
    expect(parseSupervisorConfig('{"version":1}')).toEqual({ error: '不是受支持的 AI 监督配置文件' });
    expect(parseSupervisorConfig(serializeSupervisorConfig({ maxAutoDecisions: 99 })))
      .toMatchObject({ maxAutoDecisions: 20, supervisorLaunchCmd: 'codex' });
    expect(parseSupervisorConfig(serializeSupervisorConfig({ maxAutoDecisions: '' })))
      .toMatchObject({ maxAutoDecisions: null });
  });
});
