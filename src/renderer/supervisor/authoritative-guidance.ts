const AUTHORISED_EXECUTION = /(?:可以|允许|已授权|可直接|无需|不必).{0,32}(?:上机|上电|实机|物理|硬件|设备|运行|测试|验证)|(?:上机|上电|实机|物理|硬件|设备|运行|测试|验证).{0,32}(?:可以|允许|已授权|可直接|无需|不必)/iu;
const CONFIRMED_READY_STATE = /(?:已上电|保持上电|急停.{0,12}(?:解除|释放|就绪)|安全.{0,12}(?:已确认|满足|就绪)|(?:设备|硬件|板卡|环境|接线|联锁).{0,12}(?:已确认|可用|就绪|正常|满足))/iu;
const PHYSICAL_RECONFIRMATION = /(?:是否|请.{0,12}确认|需要.{0,12}确认|仍需.{0,12}确认|确认后|待.{0,12}确认|再次确认|重新确认).{0,48}(?:上机|上电|断电|实机|物理|硬件|设备|板卡|电机|急停|联锁|接线|安全|环境|测试|验证)|(?:上机|上电|断电|实机|物理|硬件|设备|板卡|电机|急停|联锁|接线|安全|环境|测试|验证).{0,48}(?:是否|请.{0,12}确认|需要.{0,12}确认|仍需.{0,12}确认|确认后|待.{0,12}确认|再次确认|重新确认)/iu;
const USER_GUIDANCE_CHANGE = /(?:(?:前置条件|注意事项|授权|安全条件|环境条件).{0,20}(?:变更|变化|失效|撤销|取消|不再满足))|(?:(?:硬件|设备|板卡|仪器|电源|急停|联锁|环境|接线).{0,20}(?:断电|掉电|未上电|按下|未释放|断开|不可用|更换|失效|变化))|(?:(?:撤销|取消|收回).{0,12}(?:授权|许可|上机|实测))/iu;
const USER_GUIDANCE_UNCHANGED = /(?:没有|并未|未|无).{0,6}(?:变更|变化|失效)|(?:保持|仍按|继续按).{0,16}(?:原|现有|当前).{0,8}(?:条件|授权|注意事项)/iu;

export interface AuthoritativeGuidanceCheck {
  preconditions: string;
  supervisorNotes?: string;
  escalationText: string;
  latestUserGuidance?: string;
}

/**
 * Current configured prerequisites and supervisor notes are user-owned facts.
 * Worker output and historical evidence cannot turn them back into questions.
 */
export function redundantAuthoritativeGuidanceConfirmation(
  input: AuthoritativeGuidanceCheck,
): string | null {
  const authority = [input.preconditions, input.supervisorNotes || '']
    .map((item) => item.trim())
    .filter(Boolean)
    .join('\n');
  const request = input.escalationText.trim();
  if (!authority || !request) return null;
  if (input.latestUserGuidance
    && USER_GUIDANCE_CHANGE.test(input.latestUserGuidance)
    && !USER_GUIDANCE_UNCHANGED.test(input.latestUserGuidance)) return null;
  if (!PHYSICAL_RECONFIRMATION.test(request)) return null;
  if (!AUTHORISED_EXECUTION.test(authority) && !CONFIRMED_READY_STATE.test(authority)) return null;
  return '当前配置中的前置条件和监督注意事项是用户最新确认的权威状态；任务日志、旧审计、普通执行失败或任务 AI 自述不能把它们重新变成待确认条件。请继承现有条件，通过 continue/rework 推进任务；只有用户直接说明条件变化，或配置界面已更新时，才能再次请求确认。';
}
