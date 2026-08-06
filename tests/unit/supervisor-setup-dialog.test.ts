import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dialogSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/components/Supervisor/SupervisorSetupDialog.tsx'),
  'utf8',
);

describe('supervisor setup dialog feedback', () => {
  it('uses non-blocking inline notices instead of native alerts', () => {
    expect(dialogSource).not.toContain('window.alert');
    expect(dialogSource).toContain('className="supervisor-dialog__notice"');
    expect(dialogSource).toContain("role={dialogNotice.kind === 'error' ? 'alert' : 'status'}");
  });

  it('closes the setup dialog after applying changes to a retained session', () => {
    expect(dialogSource).toMatch(
      /if \(!sessionRetained\) startSupervisor\(\);\s*else closeSupervisorSetup\(\);/,
    );
  });
});
