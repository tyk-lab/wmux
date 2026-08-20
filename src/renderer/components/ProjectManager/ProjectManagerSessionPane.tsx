import ProjectManagerDialog from './ProjectManagerDialog';

interface ProjectManagerSessionPaneProps {
  projectId: string;
}

export default function ProjectManagerSessionPane({ projectId }: ProjectManagerSessionPaneProps) {
  return (
    <main className="project-manager-session-pane">
      <ProjectManagerDialog embeddedProjectId={projectId} />
    </main>
  );
}
