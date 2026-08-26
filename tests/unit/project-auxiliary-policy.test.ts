import { describe, expect, it } from 'vitest';
import { normalizeProjectManagementAgentConfig } from '../../src/shared/project-manager-terminal';
import { projectAuxiliaryWritablePathAllowed } from '../../src/renderer/project-manager/auxiliary-policy';

describe('project auxiliary task AI policy', () => {
  it.each([
    'README.md',
    'docs/architecture.md',
    '.project-handbook/PROJECT_HANDBOOK.md',
    '.project-plans/PROGRESS.md',
    '.project-plans/plans/current.md',
    '.project-plans/debug/hook.md',
    'runs/2026-08-25/aux-doc-sync/result.json',
  ])('allows classified auxiliary documentation path %s', (path) => {
    expect(projectAuxiliaryWritablePathAllowed(path)).toBe(true);
  });

  it.each([
    'src/main/index.ts',
    'tests/unit/task.test.ts',
    'package.json',
    '.project-plans/random-report.md',
    '.project-plans/experiments/result.json',
    '../outside.md',
  ])('rejects implementation or unclassified path %s', (path) => {
    expect(projectAuxiliaryWritablePathAllowed(path)).toBe(false);
  });

  it('keeps auxiliary AI off by default and enables it only from explicit user configuration', () => {
    expect(normalizeProjectManagementAgentConfig(undefined).auxiliary)
      .toMatchObject({ enabled: false, allowProjectMaintenance: false });
    expect(normalizeProjectManagementAgentConfig({
      auxiliary: {
        enabled: false,
        allowProjectMaintenance: true,
        agent: 'codex',
        model: '',
        reasoningEffort: '',
      },
    }).auxiliary).toMatchObject({ enabled: false, allowProjectMaintenance: false, agent: 'codex' });
    expect(normalizeProjectManagementAgentConfig({
      auxiliary: {
        enabled: true,
        allowProjectMaintenance: true,
        agent: 'grok',
        model: 'grok-4.6',
        reasoningEffort: 'high',
      },
    }).auxiliary).toMatchObject({
      enabled: true,
      allowProjectMaintenance: true,
      agent: 'grok',
      model: 'grok-4.6',
      reasoningEffort: 'high',
    });
  });
});
