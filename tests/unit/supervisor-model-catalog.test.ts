import { describe, expect, it } from 'vitest';
import {
  addCustomSupervisorModel,
  hiddenBuiltinModelOptions,
  modelOptionsFor,
  removeSupervisorModel,
  restoreBuiltinSupervisorModel,
  supervisorModelCatalogScope,
} from '../../src/renderer/supervisor/model-catalog';

describe('supervisor model catalog', () => {
  it('offers every supported Codex model to project-mode Agent selectors', () => {
    expect(modelOptionsFor('codex').map((option) => option.value)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-codex-spark',
    ]);
  });

  it('adds a custom model after validation without duplicating IDs', () => {
    const catalog = addCustomSupervisorModel({}, 'pi', ' vendor/new-model ');
    const next = addCustomSupervisorModel(catalog, 'pi', 'VENDOR/NEW-MODEL');

    expect(modelOptionsFor('pi', next).filter((option) => option.custom)).toEqual([
      { value: 'vendor/new-model', label: 'vendor/new-model', custom: true },
    ]);
  });

  it('hides and restores a built-in model while preserving compatibility data', () => {
    const hidden = removeSupervisorModel({}, 'pi', 'xai/grok-4.5');

    expect(modelOptionsFor('pi', hidden).map((option) => option.value)).not.toContain('xai/grok-4.5');
    expect(hiddenBuiltinModelOptions('pi', hidden).map((option) => option.value)).toContain('xai/grok-4.5');

    const restored = restoreBuiltinSupervisorModel(hidden, 'pi', 'xai/grok-4.5');
    expect(modelOptionsFor('pi', restored).map((option) => option.value)).toContain('xai/grok-4.5');
  });

  it('removes custom models instead of adding them to the hidden built-in list', () => {
    const added = addCustomSupervisorModel({}, 'codex', 'gpt-next');
    const removed = removeSupervisorModel(added, 'codex', 'gpt-next');

    expect(modelOptionsFor('codex', removed).map((option) => option.value)).not.toContain('gpt-next');
    expect(hiddenBuiltinModelOptions('codex', removed)).toEqual([]);
  });

  it('scopes catalogs by normalized workspace directory', () => {
    expect(supervisorModelCatalogScope('D:\\Repo\\Project\\', 'ws-a'))
      .toBe(supervisorModelCatalogScope('d:/repo/project', 'ws-b'));
    expect(supervisorModelCatalogScope(undefined, 'ws-a')).toBe('workspace:ws-a');
  });
});
