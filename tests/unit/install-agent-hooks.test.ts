import { describe, it, expect } from 'vitest';
import { formatInstallAgentHooksReport, type AgentHookInstallResult } from '../../src/main/install-agent-hooks';

describe('formatInstallAgentHooksReport', () => {
  it('prints ok/fail rows and notes', () => {
    const results: AgentHookInstallResult[] = [
      { id: 'claude', label: 'Claude Code', ok: true, path: '/x/settings.json', detail: 'updated' },
      { id: 'codex', label: 'Codex CLI', ok: false, path: '/x/hooks.json', detail: 'boom' },
    ];
    const text = formatInstallAgentHooksReport(results);
    expect(text).toContain('[OK] Claude Code');
    expect(text).toContain('[FAIL] Codex CLI');
    expect(text).toContain('/hooks');
    expect(text).toContain('Restart each agent');
  });
});
