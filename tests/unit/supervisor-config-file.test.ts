import { describe, expect, it } from 'vitest';
import {
  parseSupervisorConfig,
  serializeSupervisorConfig,
} from '../../src/main/supervisor-config-file';

describe('supervisor config file', () => {
  it('round-trips reusable supervision fields without terminal runtime state', () => {
    const config = {
      taskGoal: '完成速度传感器校准',
      taskDescription: '监督速度测试',
      preconditions: '设备已上电，现场安全已确认',
      stopWhen: '测试记录完整',
      stopWhenKind: 'direction',
      planFilePath: 'D:\\plans\\speed.md',
      supervisorLaunchCmd: 'codex',
      supervisorModel: 'gpt-5.6-sol',
      supervisorReasoningEffort: 'high',
      maxAutoDecisions: 5,
      autonomyPermissions: ['same-route-next', 'route-adjustment'],
      workScope: 'task-files',
      forbiddenActions: ['new-dependencies', 'external-network'],
      lanes: [{ surfaceId: 'must-not-be-saved' }],
      decisions: [{ outcome: 'complete' }],
    };

    expect(parseSupervisorConfig(serializeSupervisorConfig(config))).toEqual({
      taskGoal: '完成速度传感器校准',
      taskDescription: '监督速度测试',
      preconditions: '设备已上电，现场安全已确认',
      stopWhen: '测试记录完整',
      stopWhenKind: 'direction',
      planFilePath: 'D:\\plans\\speed.md',
      supervisorLaunchCmd: 'codex',
      supervisorModel: 'gpt-5.6-sol',
      supervisorReasoningEffort: 'high',
      maxAutoDecisions: 5,
      autonomyPermissions: ['same-route-next', 'route-adjustment'],
      workScope: 'task-files',
      forbiddenActions: ['new-dependencies', 'external-network'],
    });
  });

  it('rejects unrelated JSON files and clamps imported limits', () => {
    expect(parseSupervisorConfig('{"version":1}')).toEqual({ error: '不是受支持的 AI 监督配置文件' });
    expect(parseSupervisorConfig(serializeSupervisorConfig({ maxAutoDecisions: 99 })))
      .toMatchObject({ maxAutoDecisions: 20, supervisorLaunchCmd: 'pi' });
    expect(parseSupervisorConfig(serializeSupervisorConfig({ maxAutoDecisions: null })))
      .toMatchObject({ maxAutoDecisions: null });
    expect(parseSupervisorConfig(serializeSupervisorConfig({ maxAutoDecisions: 0 })))
      .toMatchObject({ maxAutoDecisions: 1 });
  });

  it('uses fail-closed defaults for version 2 and filters unknown selections', () => {
    expect(parseSupervisorConfig(serializeSupervisorConfig({}))).toMatchObject({
      autonomyPermissions: [],
      workScope: 'task-files',
      forbiddenActions: [
        'new-dependencies',
        'public-api-change',
        'large-refactor',
        'weaken-tests',
        'build-release-config',
        'external-network',
      ],
      maxAutoDecisions: 1,
    });

    expect(parseSupervisorConfig(serializeSupervisorConfig({
      autonomyPermissions: ['same-route-next', 'unknown', 'same-route-next'],
      workScope: 'outside-project',
      forbiddenActions: ['external-network', 'unknown'],
    }))).toMatchObject({
      autonomyPermissions: ['same-route-next'],
      workScope: 'task-files',
      forbiddenActions: [
        'new-dependencies',
        'public-api-change',
        'large-refactor',
        'weaken-tests',
        'build-release-config',
        'external-network',
      ],
    });

    expect(parseSupervisorConfig(serializeSupervisorConfig({
      autonomyPermissions: 'all',
      forbiddenActions: 'none',
    }))).toMatchObject({
      autonomyPermissions: [],
      forbiddenActions: [
        'new-dependencies',
        'public-api-change',
        'large-refactor',
        'weaken-tests',
        'build-release-config',
        'external-network',
      ],
    });

    expect(parseSupervisorConfig(serializeSupervisorConfig({
      autonomyPermissions: null,
      workScope: null,
      forbiddenActions: null,
    }))).toMatchObject({
      autonomyPermissions: [],
      workScope: 'task-files',
      forbiddenActions: [
        'new-dependencies',
        'public-api-change',
        'large-refactor',
        'weaken-tests',
        'build-release-config',
        'external-network',
      ],
    });
  });

  it('imports version 1 files with safe defaults while exporting version 2', () => {
    const legacy = JSON.stringify({
      kind: 'wmux-ai-supervisor-config',
      version: 1,
      config: { stopWhen: '旧版停止条件', supervisorLaunchCmd: 'codex' },
    });

    expect(parseSupervisorConfig(legacy)).toMatchObject({
      stopWhen: '旧版停止条件',
      autonomyPermissions: [
        'same-route-next',
        'technical-choice',
        'route-adjustment',
        'permission-confirm',
      ],
      workScope: 'project',
    });
    expect(JSON.parse(serializeSupervisorConfig({}))).toMatchObject({ version: 2 });
  });

  it('rejects null v2 config and keeps missing v2 policy fields restrictive', () => {
    expect(parseSupervisorConfig(JSON.stringify({
      kind: 'wmux-ai-supervisor-config',
      version: 2,
      config: null,
    }))).toMatchObject({ error: expect.stringContaining('config') });
    expect(parseSupervisorConfig(JSON.stringify({
      kind: 'wmux-ai-supervisor-config',
      version: 2,
      config: { stopWhen: '完成' },
    }))).toMatchObject({
      autonomyPermissions: [],
      workScope: 'task-files',
      forbiddenActions: [
        'new-dependencies',
        'public-api-change',
        'large-refactor',
        'weaken-tests',
        'build-release-config',
        'external-network',
      ],
      maxAutoDecisions: 1,
    });
  });
});
