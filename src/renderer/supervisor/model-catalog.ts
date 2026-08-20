import type { SupervisorLauncherKind } from './launch-command';

export type ConfigurableSupervisorLauncher = Exclude<SupervisorLauncherKind, 'other'>;

export interface SupervisorModelOption {
  value: string;
  label: string;
  custom?: boolean;
}

export interface SupervisorModelCatalog {
  customModels?: Partial<Record<ConfigurableSupervisorLauncher, string[]>>;
  hiddenModels?: Partial<Record<ConfigurableSupervisorLauncher, string[]>>;
}

export const BUILTIN_SUPERVISOR_MODEL_OPTIONS: Record<
  ConfigurableSupervisorLauncher,
  SupervisorModelOption[]
> = {
  codex: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol（复杂监督）' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra（均衡）' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna（快速、重复性监督）' },
    { value: 'gpt-5.5', label: 'GPT-5.5（复杂编码与研究）' },
    { value: 'gpt-5.4', label: 'GPT-5.4（日常编码）' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini（轻量、快速）' },
    { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark（超快速编码）' },
  ],
  kimi: [
    { value: 'kimi-code/k3', label: 'Kimi K3（长上下文）' },
    { value: 'kimi-code/k3-256k', label: 'Kimi K3 · 256k' },
    { value: 'kimi-code/kimi-for-coding', label: 'Kimi K2.7 Code' },
    { value: 'kimi-code/kimi-for-coding-highspeed', label: 'Kimi K2.7 Code 高速版' },
  ],
  grok: [
    { value: 'grok-4.6', label: 'Grok 4.6（推荐）' },
    { value: 'grok-4.5', label: 'Grok 4.5' },
  ],
  pi: [
    { value: 'openai-codex/gpt-5.6-terra', label: 'GPT-5.6 Terra（均衡）' },
    { value: 'openai-codex/gpt-5.6-sol', label: 'GPT-5.6 Sol（复杂监督）' },
    { value: 'openai-codex/gpt-5.6-luna', label: 'GPT-5.6 Luna（快速、重复性监督）' },
    { value: 'kimi-coding/k3', label: 'Kimi K3（长上下文）' },
    { value: 'kimi-coding/k3-256k', label: 'Kimi K3 · 256k' },
    { value: 'kimi-coding/kimi-for-coding', label: 'Kimi K2.7 Code' },
    { value: 'kimi-coding/kimi-for-coding-highspeed', label: 'Kimi K2.7 Code 高速版' },
    { value: 'xai/grok-4.6', label: 'Grok 4.6' },
    { value: 'xai/grok-4.5', label: 'Grok 4.5' },
    { value: 'xai/grok-4.3', label: 'Grok 4.3' },
  ],
};

function uniqueModelIds(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values || []) {
    const value = raw.trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function includesModel(values: string[] | undefined, model: string): boolean {
  const key = model.trim().toLocaleLowerCase();
  return uniqueModelIds(values).some((value) => value.toLocaleLowerCase() === key);
}

export function modelOptionsFor(
  launcher: SupervisorLauncherKind,
  catalog?: SupervisorModelCatalog,
): SupervisorModelOption[] {
  if (launcher === 'other') return [];
  const hidden = catalog?.hiddenModels?.[launcher];
  const builtins = BUILTIN_SUPERVISOR_MODEL_OPTIONS[launcher]
    .filter((option) => !includesModel(hidden, option.value));
  const builtinIds = new Set(
    BUILTIN_SUPERVISOR_MODEL_OPTIONS[launcher].map((option) => option.value.toLocaleLowerCase()),
  );
  const custom = uniqueModelIds(catalog?.customModels?.[launcher])
    .filter((value) => !builtinIds.has(value.toLocaleLowerCase()))
    .map((value) => ({ value, label: value, custom: true }));
  return [...builtins, ...custom];
}

export function addCustomSupervisorModel(
  catalog: SupervisorModelCatalog,
  launcher: ConfigurableSupervisorLauncher,
  model: string,
): SupervisorModelCatalog {
  const value = model.trim();
  const builtin = BUILTIN_SUPERVISOR_MODEL_OPTIONS[launcher]
    .some((option) => option.value.toLocaleLowerCase() === value.toLocaleLowerCase());
  const customModels = { ...catalog.customModels };
  const hiddenModels = { ...catalog.hiddenModels };
  hiddenModels[launcher] = uniqueModelIds(hiddenModels[launcher])
    .filter((item) => item.toLocaleLowerCase() !== value.toLocaleLowerCase());
  if (!builtin) customModels[launcher] = uniqueModelIds([...(customModels[launcher] || []), value]);
  return { customModels, hiddenModels };
}

export function removeSupervisorModel(
  catalog: SupervisorModelCatalog,
  launcher: ConfigurableSupervisorLauncher,
  model: string,
): SupervisorModelCatalog {
  const value = model.trim();
  const builtin = BUILTIN_SUPERVISOR_MODEL_OPTIONS[launcher]
    .some((option) => option.value.toLocaleLowerCase() === value.toLocaleLowerCase());
  const customModels = { ...catalog.customModels };
  const hiddenModels = { ...catalog.hiddenModels };
  if (builtin) {
    hiddenModels[launcher] = uniqueModelIds([...(hiddenModels[launcher] || []), value]);
  } else {
    customModels[launcher] = uniqueModelIds(customModels[launcher])
      .filter((item) => item.toLocaleLowerCase() !== value.toLocaleLowerCase());
  }
  return { customModels, hiddenModels };
}

export function restoreBuiltinSupervisorModel(
  catalog: SupervisorModelCatalog,
  launcher: ConfigurableSupervisorLauncher,
  model: string,
): SupervisorModelCatalog {
  const hiddenModels = { ...catalog.hiddenModels };
  hiddenModels[launcher] = uniqueModelIds(hiddenModels[launcher])
    .filter((item) => item.toLocaleLowerCase() !== model.trim().toLocaleLowerCase());
  return { ...catalog, hiddenModels };
}

export function hiddenBuiltinModelOptions(
  launcher: SupervisorLauncherKind,
  catalog?: SupervisorModelCatalog,
): SupervisorModelOption[] {
  if (launcher === 'other') return [];
  return BUILTIN_SUPERVISOR_MODEL_OPTIONS[launcher]
    .filter((option) => includesModel(catalog?.hiddenModels?.[launcher], option.value));
}

export function supervisorModelCatalogScope(cwd?: string, workspaceId?: string): string {
  const normalizedCwd = cwd?.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase();
  if (normalizedCwd) return `cwd:${normalizedCwd}`;
  return workspaceId ? `workspace:${workspaceId}` : 'workspace:default';
}
