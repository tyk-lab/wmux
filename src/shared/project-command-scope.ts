const PROJECT_SCOPED_COMMANDS = new Set([
  'update',
  'update-definition',
  'alignment-confirm',
  'goal-plan',
  'logs',
  'terminals',
  'terminal-rotate',
  'task-create',
  'task-update',
  'record',
  'record-execution',
  'supervise',
  'task-supervise',
  'progress-sync',
  'transition-ack',
  'task-terminal-start',
  'task-terminal-rotate',
  'inspect',
  'supervisor-inspect',
  'decide',
  'supervisor-decide',
  'ask',
  'user-question',
  'pause',
  'resume',
  'stop',
  'complete',
  'reply',
]);

/** Prevent a project runtime from resolving an ambiguous project by UI selection state. */
export function projectCommandNeedsExplicitId(
  command: string,
  projectId: string,
  projects: readonly unknown[],
): boolean {
  return !projectId.trim()
    && PROJECT_SCOPED_COMMANDS.has(command.trim())
    && projects.length > 1;
}
