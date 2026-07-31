import type { PaneId, WorkspaceId } from '../../../shared/types';
import SupervisorPanel from '../Sidebar/SupervisorPanel';

interface SupervisorSessionPaneProps {
  workspaceId: WorkspaceId;
  paneId: PaneId;
}

/** Full-width, pinned session view; the sidebar keeps only its compact launcher. */
export default function SupervisorSessionPane({ workspaceId, paneId }: SupervisorSessionPaneProps) {
  return (
    <main className="supervisor-session-pane">
      <SupervisorPanel expanded workspaceId={workspaceId} paneId={paneId} />
    </main>
  );
}
