import { describe, expect, it } from 'vitest';
import {
  parseSupervisorConfig,
  serializeSupervisorConfig,
} from '../../src/main/supervisor-config-file';

function currentConfig(config: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    terminals: [{ surfaceId: 'surf-current', label: 'Current terminal' }],
    ...config,
  };
}

describe('supervisor config file', () => {
  it('round-trips reusable supervision fields without terminal runtime state', () => {
    const config = currentConfig({
      taskGoal: '完成速度传感器校准',
      taskDescription: '监督速度测试',
      preconditions: '设备已上电，现场安全已确认',
      stopWhen: '测试记录完整',
      stopWhenKind: 'direction',
      planFilePath: 'D:\\plans\\speed.md',
      taskWorkMode: 'multi-thread',
      mainThreadResponsibility: '统筹实现并整合结果',
      childThreadResponsibilities: ['实现驱动', '补充测试'],
      restoreTaskContext: true,
      supervisorLaunchCmd: 'codex',
      supervisorModel: 'gpt-5.6-sol',
      supervisorReasoningEffort: 'high',
      maxAutoDecisions: 5,
      autonomyPermissions: ['same-route-next', 'route-adjustment'],
      workScope: 'task-files',
      forbiddenActions: ['new-dependencies', 'external-network'],
      lanes: [{ surfaceId: 'must-not-be-saved' }],
      decisions: [{ outcome: 'complete' }],
    });

    const parsed = parseSupervisorConfig(serializeSupervisorConfig(config));
    expect(parsed).toMatchObject({
      taskGoal: '完成速度传感器校准',
      taskDescription: '监督速度测试',
      preconditions: '设备已上电，现场安全已确认',
      stopWhen: '测试记录完整',
      stopWhenKind: 'direction',
      planFilePath: 'D:\\plans\\speed.md',
      taskWorkMode: 'multi-thread',
      mainThreadResponsibility: '统筹实现并整合结果',
      childThreadResponsibilities: ['实现驱动', '补充测试'],
      restoreTaskContext: true,
      supervisorLaunchCmd: 'codex',
      supervisorModel: 'gpt-5.6-sol',
      supervisorReasoningEffort: 'high',
      maxAutoDecisions: 5,
      autonomyPermissions: ['same-route-next', 'route-adjustment'],
      workScope: 'task-files',
      forbiddenActions: ['new-dependencies', 'external-network'],
      terminals: [{ surfaceId: 'surf-current', label: 'Current terminal' }],
    });
    expect(parsed).not.toHaveProperty('lanes');
    expect(parsed).not.toHaveProperty('decisions');
  });

  it('round-trips each selected terminal config independently', () => {
    const parsed = parseSupervisorConfig(serializeSupervisorConfig(currentConfig({
      supervisorLaunchCmd: 'codex',
      terminals: [
        {
          surfaceId: 'surf-auth',
          label: 'Auth worker',
          taskGoal: '修复登录',
          stopWhen: '认证测试通过',
          stopWhenKind: 'concrete',
          waitForNextDirection: true,
          taskWorkMode: 'single-thread',
          restoreTaskContext: true,
          autonomyPermissionsOverride: ['same-route-next'],
          autonomousOverride: true,
          forbiddenActionsOverride: ['external-network'],
        },
        {
          surfaceId: 'surf-tests',
          label: 'Test worker',
          taskGoal: '补充回归测试',
          stopWhen: '测试覆盖完成',
          stopWhenKind: 'direction',
          taskWorkMode: 'multi-thread',
          mainThreadResponsibility: '统筹测试',
          childThreadResponsibilities: ['认证回归', '异常路径'],
        },
      ],
    })));

    expect(parsed).not.toHaveProperty('error');
    expect(parsed).toMatchObject({
      supervisorLaunchCmd: 'codex',
      terminals: [
        {
          surfaceId: 'surf-auth',
          label: 'Auth worker',
          taskGoal: '修复登录',
          stopWhen: '认证测试通过',
          waitForNextDirection: true,
          restoreTaskContext: true,
          autonomyPermissionsOverride: ['same-route-next'],
          autonomousOverride: true,
          forbiddenActionsOverride: ['external-network'],
        },
        {
          surfaceId: 'surf-tests',
          label: 'Test worker',
          taskGoal: '补充回归测试',
          stopWhen: '测试覆盖完成',
          stopWhenKind: 'direction',
          waitForNextDirection: false,
          taskWorkMode: 'multi-thread',
          mainThreadResponsibility: '统筹测试',
          childThreadResponsibilities: ['认证回归', '异常路径'],
          restoreTaskContext: false,
        },
      ],
    });
  });

  it('rejects unrelated JSON files and clamps imported limits', () => {
    expect(parseSupervisorConfig('{"version":1}')).toEqual({ error: '不是受支持的 AI 监督配置文件' });
    expect(parseSupervisorConfig(serializeSupervisorConfig(currentConfig({ maxAutoDecisions: 99 }))))
      .toMatchObject({ maxAutoDecisions: 20, supervisorLaunchCmd: 'pi' });
    expect(parseSupervisorConfig(serializeSupervisorConfig(currentConfig({ maxAutoDecisions: null }))))
      .toMatchObject({ maxAutoDecisions: null });
    expect(parseSupervisorConfig(serializeSupervisorConfig(currentConfig({ maxAutoDecisions: 0 }))))
      .toMatchObject({ maxAutoDecisions: 1 });
  });

  it('keeps adaptive thread approval exclusive to project task contracts', () => {
    const parsed = parseSupervisorConfig(serializeSupervisorConfig(currentConfig({
      taskWorkMode: 'adaptive',
      terminals: [{ surfaceId: 'surf-current', taskWorkMode: 'adaptive' }],
    })));

    expect(parsed).toMatchObject({
      taskWorkMode: 'single-thread',
      terminals: [{ surfaceId: 'surf-current', taskWorkMode: 'single-thread' }],
    });
  });

  it('rejects V4 files and exports without at least one valid terminal', () => {
    const invalidConfigs = [
      {},
      { terminals: [] },
      { terminals: [{}] },
      { terminals: [{ surfaceId: '   ', label: 'invalid' }] },
    ];
    for (const config of invalidConfigs) {
      expect(parseSupervisorConfig(JSON.stringify({
        kind: 'wmux-ai-supervisor-config',
        version: 4,
        config,
      }))).toMatchObject({ error: expect.stringContaining('至少需要包含一个有效终端') });
    }
    expect(() => serializeSupervisorConfig({})).toThrow('至少需要包含一个有效终端');
  });

  it('limits imported task-thread assignments to three bounded text entries', () => {
    expect(parseSupervisorConfig(serializeSupervisorConfig(currentConfig({
      taskWorkMode: 'multi-thread',
      mainThreadResponsibility: 123,
      childThreadResponsibilities: ['实现', '测试', '审查', '不得保留'],
    })))).toMatchObject({
      taskWorkMode: 'multi-thread',
      mainThreadResponsibility: '',
      childThreadResponsibilities: ['实现', '测试', '审查'],
      restoreTaskContext: false,
    });
  });

  it('uses fail-closed defaults for the current version and filters unknown selections', () => {
    expect(parseSupervisorConfig(serializeSupervisorConfig(currentConfig()))).toMatchObject({
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

    expect(parseSupervisorConfig(serializeSupervisorConfig(currentConfig({
      autonomyPermissions: ['same-route-next', 'unknown', 'same-route-next'],
      workScope: 'outside-project',
      forbiddenActions: ['external-network', 'unknown'],
    })))).toMatchObject({
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

    expect(parseSupervisorConfig(serializeSupervisorConfig(currentConfig({
      autonomyPermissions: 'all',
      forbiddenActions: 'none',
    })))).toMatchObject({
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

    expect(parseSupervisorConfig(serializeSupervisorConfig(currentConfig({
      autonomyPermissions: null,
      workScope: null,
      forbiddenActions: null,
    })))).toMatchObject({
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

  it('imports legacy files with a single-thread default while exporting version 4', () => {
    const legacy = JSON.stringify({
      kind: 'wmux-ai-supervisor-config',
      version: 1,
      config: { stopWhen: '旧版停止条件', supervisorLaunchCmd: 'codex' },
    });

    expect(parseSupervisorConfig(legacy)).toMatchObject({
      stopWhen: '旧版停止条件',
      taskWorkMode: 'single-thread',
      mainThreadResponsibility: '',
      childThreadResponsibilities: [],
      restoreTaskContext: false,
      autonomyPermissions: [
        'same-route-next',
        'technical-choice',
        'route-adjustment',
        'permission-confirm',
      ],
      workScope: 'project',
    });
    expect(JSON.parse(serializeSupervisorConfig(currentConfig()))).toMatchObject({ version: 4 });

    expect(parseSupervisorConfig(JSON.stringify({
      kind: 'wmux-ai-supervisor-config',
      version: 2,
      config: { stopWhen: '旧版 V2 停止条件' },
    }))).toMatchObject({
      stopWhen: '旧版 V2 停止条件',
      taskWorkMode: 'single-thread',
      childThreadResponsibilities: [],
      restoreTaskContext: false,
    });

    expect(parseSupervisorConfig(JSON.stringify({
      kind: 'wmux-ai-supervisor-config',
      version: 3,
      config: {
        stopWhen: '旧版 V3 停止条件',
        terminals: [{ surfaceId: 'surf-injected', label: '不得按 V4 导入' }],
      },
    }))).toMatchObject({
      stopWhen: '旧版 V3 停止条件',
      terminals: [],
    });
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
