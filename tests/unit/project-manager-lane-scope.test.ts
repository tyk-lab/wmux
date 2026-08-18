import { describe, expect, it } from 'vitest';
import type { ProjectManagerSession } from '../../src/shared/project-manager';
import type { SupervisorLane } from '../../src/renderer/store/supervisor-slice';
import { projectSupervisorLaneIds } from '../../src/renderer/project-manager/lane-scope';

function session(id: string): Pick<ProjectManagerSession, 'id'> {
  return { id };
}

describe('project manager lane scope', () => {
  it('selects only lanes owned by the paused project', () => {
    const lanes = [
      { id: 'lane-a', projectManagerProjectId: 'pm-a', projectWorkItemId: 'main' },
      { id: 'lane-b', projectManagerProjectId: 'pm-b', projectWorkItemId: 'main' },
    ] as SupervisorLane[];

    expect(projectSupervisorLaneIds(session('pm-a'), lanes)).toEqual(['lane-a']);
  });

  it('does not revive a legacy lane that lacks explicit project ownership', () => {
    const lanes = [
      { id: 'legacy-a', projectWorkItemId: 'main' },
      { id: 'legacy-b', projectWorkItemId: 'main' },
    ] as SupervisorLane[];

    expect(projectSupervisorLaneIds(session('pm-a'), lanes)).toEqual([]);
  });
});
