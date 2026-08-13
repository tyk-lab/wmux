export const SUPERVISOR_DECIDE_USAGE = 'Usage: wmux supervisor decide --surface <id> --outcome <continue|rework|complete|needs-human> [--reason <text>] [--next <text>] [--proposal-kind <route-adjustment|route-change|important|context-recovery>] [--impact <text>] [--alternatives <text>] [--permission-command <text> --permission-response <y|yes|allow|approve>] [--verbose]';

export function isSupervisorDecideHelp(args: string[]): boolean {
  return args[1] === 'decide' && (args.includes('--help') || args.includes('-h'));
}
