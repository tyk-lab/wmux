/** Agent-reported per-surface activity for sidebar display. */

import { BrowserWindow } from 'electron';
import { IPC_CHANNELS, SurfaceId } from '../shared/types';

export interface AgentActivityItem {
  name: string;
  toolUses: number;
  tokens: string;
  done: boolean;
}

export interface SurfaceAgentActivity {
  agents: AgentActivityItem[];
  activeSkill: string | null;
  lastTool: string | null;
  lastUpdate: number;
  isDone: boolean;
}

const activities = new Map<SurfaceId, SurfaceAgentActivity>();
const MAX_TRACKED_AGENTS = 32;

function getOrCreate(surfaceId: SurfaceId): SurfaceAgentActivity {
  let activity = activities.get(surfaceId);
  if (!activity) {
    activity = { agents: [], activeSkill: null, lastTool: null, lastUpdate: Date.now(), isDone: false };
    activities.set(surfaceId, activity);
  }
  return activity;
}

export function getActivity(surfaceId: SurfaceId): SurfaceAgentActivity | undefined {
  return activities.get(surfaceId);
}

export function clearActivity(surfaceId: SurfaceId): void {
  activities.delete(surfaceId);
}

/** Mark the most recently reported running subagent as done. */
export function markSubagentStop(surfaceId: SurfaceId): void {
  const activity = activities.get(surfaceId);
  if (!activity) return;
  for (let i = activity.agents.length - 1; i >= 0; i--) {
    if (!activity.agents[i].done) {
      activity.agents[i].done = true;
      activity.lastUpdate = Date.now();
      broadcast(surfaceId, activity);
      return;
    }
  }
}

/** A terminal Stop event ends all reported subagent work on that surface. */
export function markAllAgentsDone(surfaceId: SurfaceId): void {
  const activity = activities.get(surfaceId);
  if (!activity) return;
  activity.agents.forEach((agent) => { agent.done = true; });
  activity.isDone = true;
  activity.lastTool = null;
  activity.lastUpdate = Date.now();
  broadcast(surfaceId, activity);
}

/** Merge activity explicitly pushed by an agent or integration. */
export function applyExternalActivity(
  surfaceId: SurfaceId,
  partial: Partial<SurfaceAgentActivity>,
): void {
  const activity = getOrCreate(surfaceId);
  if (partial.lastTool !== undefined) activity.lastTool = partial.lastTool;
  if (partial.activeSkill !== undefined) activity.activeSkill = partial.activeSkill;
  if (partial.isDone !== undefined) activity.isDone = partial.isDone;
  if (partial.agents !== undefined) activity.agents = partial.agents.slice(-MAX_TRACKED_AGENTS);
  activity.lastUpdate = Date.now();
  broadcast(surfaceId, activity);
}

function broadcast(surfaceId: SurfaceId, activity: SurfaceAgentActivity): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.AGENT_ACTIVITY_UPDATE, { surfaceId, activity });
    }
  });
}
