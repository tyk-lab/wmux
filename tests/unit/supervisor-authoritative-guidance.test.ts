import { describe, expect, it } from 'vitest';
import { redundantAuthoritativeGuidanceConfirmation } from '../../src/renderer/supervisor/authoritative-guidance';

describe('supervisor authoritative guidance', () => {
  it('rejects repeated physical confirmation when current prerequisites already authorize direct testing', () => {
    expect(redundantAuthoritativeGuidanceConfirmation({
      preconditions: '当前设备和接线已就绪，允许直接上机、上电并运行本项目测试。',
      supervisorNotes: '现有参数范围内持续推进实测。',
      escalationText: [
        '仍需补充两项安全确认。',
        '本次上电是否是在最近一次控制面失败后完成物理断电并重新上电后取得的？',
        '急停是否已确认就绪？确认后才能执行下一次控制面的恢复。',
      ].join('\n'),
    })).toContain('用户最新确认的权威状态');
  });

  it('also treats current supervisor notes as authoritative', () => {
    expect(redundantAuthoritativeGuidanceConfirmation({
      preconditions: '',
      supervisorNotes: '急停已释放，设备保持上电，测试环境可用。',
      escalationText: '请再次确认急停是否释放、设备是否仍然上电。',
    })).toContain('用户最新确认的权威状态');
  });

  it('allows a new confirmation request after the user directly reports a condition change', () => {
    expect(redundantAuthoritativeGuidanceConfirmation({
      preconditions: '允许直接上机测试。',
      escalationText: '急停是否已确认就绪？',
      latestUserGuidance: '刚刚设备掉电，急停状态也发生变化，请重新检查。',
    })).toBeNull();
  });

  it('does not mistake an explicit unchanged statement for a condition change', () => {
    expect(redundantAuthoritativeGuidanceConfirmation({
      preconditions: '允许直接上机测试。',
      escalationText: '急停是否已确认就绪？',
      latestUserGuidance: '前置条件没有变化，继续按现有授权直接测试。',
    })).toContain('用户最新确认的权威状态');
  });

  it('does not infer authorization from an empty or unrelated prerequisite', () => {
    expect(redundantAuthoritativeGuidanceConfirmation({
      preconditions: '测试数据已备份。',
      escalationText: '是否允许直接上电并运行电机测试？',
    })).toBeNull();
  });
});
