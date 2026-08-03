import { useStore } from '../store';
import type { SupervisorSession } from '../store/supervisor-slice';

export interface SupervisorGenericInputGuardResult {
  supervisedCaller: boolean;
  blocked: boolean;
  reason?: string;
}

/**
 * Dedicated supervisors may write through supervisor.decide only. Generic
 * cross-surface input would otherwise bypass the configured decision policy.
 */
export function evaluateSupervisorGenericInput(
  session: Pick<SupervisorSession, 'lanes'>,
  callerSurfaceId: string,
  targetSurfaceId: string,
): SupervisorGenericInputGuardResult {
  if (!callerSurfaceId) {
    return { supervisedCaller: false, blocked: false };
  }

  const lane = session.lanes.find(
    (item) => item.supervisorSurfaceId === callerSurfaceId,
  );
  if (!lane) return { supervisedCaller: false, blocked: false };
  if (!targetSurfaceId || targetSurfaceId === callerSurfaceId) {
    return { supervisedCaller: true, blocked: false };
  }

  return {
    supervisedCaller: true,
    blocked: true,
    reason: '专用 AI 监督终端不能使用通用 send/send-key 向其他终端输入；请通过 wmux supervisor decide 提交裁决',
  };
}

/** Expose the current-session guard to main-process V2 terminal I/O handlers. */
export function initSupervisorGenericInputGuard(): () => void {
  const w = window as any;
  w.__wmux_guardSupervisorGenericInput = (
    callerSurfaceId: string,
    targetSurfaceId: string,
  ) => evaluateSupervisorGenericInput(
    useStore.getState().supervisor,
    String(callerSurfaceId || ''),
    String(targetSurfaceId || ''),
  );

  return () => {
    delete w.__wmux_guardSupervisorGenericInput;
  };
}
