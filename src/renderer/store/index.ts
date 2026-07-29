import { create } from 'zustand';
import { WorkspaceSlice, createWorkspaceSlice } from './workspace-slice';
import { SettingsSlice, createSettingsSlice } from './settings-slice';
import { NotificationSlice, createNotificationSlice } from './notification-slice';
import { SurfaceSlice, createSurfaceSlice } from './surface-slice';
import { AgentSlice, createAgentSlice } from './agent-slice';
import { OrchestrationSlice, createOrchestrationSlice } from './orchestration-slice';
import { ProgressSlice, createProgressSlice } from './progress-slice';
import { ShellActivitySlice, createShellActivitySlice } from './shell-activity-slice';

export type WmuxStore = WorkspaceSlice & SettingsSlice & NotificationSlice & SurfaceSlice & AgentSlice & OrchestrationSlice & ProgressSlice & ShellActivitySlice;

export const useStore = create<WmuxStore>()((...args) => ({
  ...createWorkspaceSlice(...args),
  ...createSettingsSlice(...args),
  ...createNotificationSlice(...args),
  ...createSurfaceSlice(...args),
  ...createAgentSlice(...args),
  ...createOrchestrationSlice(...args),
  ...createProgressSlice(...args),
  ...createShellActivitySlice(...args),
}));
