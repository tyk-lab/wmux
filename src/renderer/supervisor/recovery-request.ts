import type { SurfaceId } from '../../shared/types';

export const SUPERVISOR_SNAPSHOT_SAVE_EVENT = 'wmux:supervisor-snapshot-save';

export interface SupervisorSnapshotSaveResult {
  ok: boolean;
  snapshotId?: string;
  savedAt?: number;
  error?: string;
}

export interface SupervisorSnapshotSaveRequest {
  surfaceId: SurfaceId;
  resolve: (result: SupervisorSnapshotSaveResult) => void;
}

const SUPERVISOR_SNAPSHOT_SAVE_TIMEOUT_MS = 60_000;

/** Ask the mounted supervision controller to capture the lane with its live terminal state. */
export function requestSupervisorSnapshotSave(surfaceId: SurfaceId): Promise<SupervisorSnapshotSaveResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SupervisorSnapshotSaveResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };
    const timer = window.setTimeout(() => finish({
      ok: false,
      error: '监督进度保存请求超时；请确认侧栏监督控制器仍在运行',
    }), SUPERVISOR_SNAPSHOT_SAVE_TIMEOUT_MS);
    window.dispatchEvent(new CustomEvent<SupervisorSnapshotSaveRequest>(SUPERVISOR_SNAPSHOT_SAVE_EVENT, {
      detail: { surfaceId, resolve: finish },
    }));
  });
}
