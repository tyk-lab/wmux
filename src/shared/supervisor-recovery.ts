import type { ProjectProgressSnapshot } from './project-manager';
import type {
  SupervisorAutonomyPermission,
  SupervisorForbiddenAction,
  SupervisorWorkScope,
} from './supervisor-policy';
import type { TaskWorkMode } from './supervisor-work-mode';

export const SUPERVISED_TERMINAL_SNAPSHOT_VERSION = 1;

export interface SupervisedTerminalSnapshotLaneConfig {
  taskGoal: string;
  taskDescription: string;
  preconditions: string;
  supervisorNotes?: string;
  stopWhen: string;
  stopWhenKind: 'direction' | 'concrete';
  waitForNextDirection?: boolean;
  planFilePath: string;
  taskWorkMode?: TaskWorkMode;
  mainThreadResponsibility?: string;
  childThreadResponsibilities?: string[];
  maxChildThreads?: number;
  supervisorMayApproveThreads?: boolean;
  parallelizableOperations?: string[];
  serializedOperations?: string[];
  planRevision?: number;
}

export interface SupervisedTerminalSnapshotSummary {
  snapshotId: string;
  savedAt: number;
  projectDir: string;
  surfaceId: string;
  label: string;
  workspaceTitle?: string;
  currentTask: string;
  lastDecision: string;
  supervisorAgent: string;
  supervisorModel: string;
  supervisorReasoningEffort: string;
  config: SupervisedTerminalSnapshotLaneConfig;
  autonomous: boolean;
  autonomyPermissions: SupervisorAutonomyPermission[];
  forbiddenActions: SupervisorForbiddenAction[];
  workScope: SupervisorWorkScope;
  controlState: 'active' | 'paused' | 'waiting';
}

export interface SupervisedTerminalSnapshot {
  version: typeof SUPERVISED_TERMINAL_SNAPSHOT_VERSION;
  snapshotId: string;
  savedAt: number;
  terminal: {
    surfaceId: string;
    workspaceId?: string;
    paneId?: string;
    workspaceTitle?: string;
    label: string;
    projectDir: string;
    cwd: string;
    shell: string;
    customTitle?: string;
    startupCommands?: string[];
    startupInput?: string;
    agent?: string;
    agentState?: string;
    screenTail: string;
  };
  supervisor: {
    surfaceId?: string;
    launchCmd: string;
    model: string;
    reasoningEffort: string;
    config: SupervisedTerminalSnapshotLaneConfig;
    autonomous: boolean;
    autonomyPermissions: SupervisorAutonomyPermission[];
    forbiddenActions: SupervisorForbiddenAction[];
    workScope: SupervisorWorkScope;
    state: {
      controlState: 'active' | 'paused' | 'waiting';
      currentTask: string;
      workerTurnId: number;
      decisions: unknown[];
      ordinaryPlan?: unknown;
      ordinaryContextHealth?: unknown;
      goalVortex?: unknown;
      latestSupervisorUserGuidance?: unknown;
      latestEvidence: string[];
      acceptanceGaps: string[];
    };
  };
  projectContext: {
    capturedAt: number;
    planFilePaths: string[];
    progressSnapshot: ProjectProgressSnapshot;
    currentTask: string;
    verifiedEvidence: string[];
    acceptanceGaps: string[];
    terminalScreenTail: string;
  };
  consistency: {
    laneId: string;
    managementSessionId?: string;
    taskSurfaceId: string;
    supervisorSurfaceId?: string;
    workerTurnId: number;
    planRevision: number;
    decisionCount: number;
  };
  checksum?: string;
}

export interface CaptureSupervisedTerminalProjectContextRequest {
  projectDir: string;
  planFilePaths: string[];
  currentTask: string;
  verifiedEvidence: string[];
  acceptanceGaps: string[];
  terminalScreenTail: string;
}
