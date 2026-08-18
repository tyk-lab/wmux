import { useStore } from '../store';
import { findLeaf, getAllPaneIds } from '../store/split-utils';
import type { SupervisorSession } from '../store/supervisor-slice';

export interface SupervisorGenericInputGuardResult {
  supervisedCaller: boolean;
  blocked: boolean;
  reason?: string;
}

/**
 * Project managers and dedicated supervisors may write through their bounded
 * protocols only. Generic cross-surface input would bypass the decision chain.
 */
export function evaluateSupervisorGenericInput(
  session: Pick<SupervisorSession, 'lanes'>,
  callerSurfaceId: string,
  targetSurfaceId: string,
  projectManagerSurfaceIds: ReadonlySet<string> = new Set(),
  projectTaskSurfaceIds: ReadonlySet<string> = new Set(),
): SupervisorGenericInputGuardResult {
  if (!callerSurfaceId) {
    return { supervisedCaller: false, blocked: false };
  }

  const projectManagerCaller = projectManagerSurfaceIds.has(callerSurfaceId);
  if (projectManagerCaller) {
    if (!targetSurfaceId || targetSurfaceId === callerSurfaceId) {
      return { supervisedCaller: true, blocked: false };
    }
    return {
      supervisedCaller: true,
      blocked: true,
      reason: '项目管理 AI 不能使用通用 send/send-key 向其他终端输入；请通过项目协议启动或指挥 AI 监督',
    };
  }

  const projectTaskCaller = projectTaskSurfaceIds.has(callerSurfaceId);
  if (projectTaskCaller) {
    if (!targetSurfaceId || targetSurfaceId === callerSurfaceId) {
      return { supervisedCaller: true, blocked: false };
    }
    return {
      supervisedCaller: true,
      blocked: true,
      reason: '项目任务 AI 不能使用通用 send/send-key 操作其他终端；请在当前任务终端内工作并由 AI 监督裁决后续输入',
    };
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
  ) => {
    const state = useStore.getState();
    const projectManagerSurfaceIds = new Set<string>();
    const projectTaskSurfaceIds = new Set<string>();
    for (const workspace of state.workspaces) {
      for (const paneId of getAllPaneIds(workspace.splitTree)) {
        for (const surface of findLeaf(workspace.splitTree, paneId)?.surfaces || []) {
          if (surface.projectManagerTerminal) projectManagerSurfaceIds.add(surface.id);
          if (surface.projectManagerProjectId) projectTaskSurfaceIds.add(surface.id);
        }
      }
    }
    return evaluateSupervisorGenericInput(
      state.supervisor,
      String(callerSurfaceId || ''),
      String(targetSurfaceId || ''),
      projectManagerSurfaceIds,
      projectTaskSurfaceIds,
    );
  };

  return () => {
    delete w.__wmux_guardSupervisorGenericInput;
  };
}
