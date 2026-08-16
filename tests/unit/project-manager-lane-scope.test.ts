import { describe, expect, it } from 'vitest';
import type { ProjectManagerSession } from '../../src/shared/project-manager';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';
import { projectSupervisorLaneIds } from '../../src/renderer/project-manager/lane-scope';

function session(id: string, laneId?: string): Pick<ProjectManagerSession, 'id' | 'workItems'> {
  return {
    id,
    workItems: laneId ? [{ supervisorLaneId: laneId } as ProjectManagerSession['workItems'][number]] : [],
  };
}

describe('project manager lane scope', () => {
  it('selects only lanes owned by the paused project', () => {
    const lanes = [
      { id: 'lane-a', projectManagerProjectId: 'pm-a', projectWorkItemId: 'main' },
      { id: 'lane-b', projectManagerProjectId: 'pm-b', projectWorkItemId: 'main' },
    ] as SupervisorLane[];

    expect(projectSupervisorLaneIds(session('pm-a'), lanes)).toEqual(['lane-a']);
  });

  it('matches a legacy lane only through its persisted lane ID', () => {
    const lanes = [
      { id: 'legacy-a', projectWorkItemId: 'main' },
      { id: 'legacy-b', projectWorkItemId: 'main' },
    ] as SupervisorLane[];

    expect(projectSupervisorLaneIds(session('pm-a', 'legacy-a'), lanes)).toEqual(['legacy-a']);
  });
});
