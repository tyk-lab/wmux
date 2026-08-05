import { describe, expect, it } from 'vitest';
import { isSupervisorDecideHelp, SUPERVISOR_DECIDE_USAGE } from '../../src/cli/supervisor-command';

describe('supervisor decide command', () => {
  it('recognizes help before validating required decision arguments', () => {
    expect(isSupervisorDecideHelp(['supervisor', 'decide', '--help'])).toBe(true);
    expect(isSupervisorDecideHelp(['supervisor', 'decide', '-h'])).toBe(true);
    expect(isSupervisorDecideHelp(['supervisor', 'decide'])).toBe(false);
  });

  it('documents the required decision arguments', () => {
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--surface <id>');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--outcome <continue|rework|complete|needs-human>');
  });
});
