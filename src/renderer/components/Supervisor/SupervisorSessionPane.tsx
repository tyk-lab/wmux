import type { PaneId, SurfaceId, WorkspaceId } from '../../../shared/types';
import SupervisorPanel from '../Sidebar/SupervisorPanel';

interface SupervisorSessionPaneProps {
  workspaceId: WorkspaceId;
  paneId: PaneId;
  surfaceId: SurfaceId;
}

/** Full-width, pinned session view; the sidebar keeps only its compact launcher. */
export default function SupervisorSessionPane({ workspaceId, paneId, surfaceId }: SupervisorSessionPaneProps) {
  return (
    <main className="supervisor-session-pane">
      <SupervisorPanel expanded workspaceId={workspaceId} paneId={paneId} surfaceId={surfaceId} />
    </main>
  );
}
