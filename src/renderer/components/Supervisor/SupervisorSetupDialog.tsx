import { useMemo, useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { SurfaceId, WorkspaceId, PaneId, SplitNode, type DefaultSupervisorAgent } from '../../../shared/types';
import type {
  StopWhenKind,
  SupervisorLane,
  SupervisorLaneConfig,
} from '../../store/supervisor-slice';
import {
  dedicatedSupervisorSurfaceId,
  isSupervisorLaneBound,
  supervisorDefaultsForAgent,
  supervisorLaneControlState,
} from '../../store/supervisor-slice';
import {
  DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS,
  DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS,
  DEFAULT_SUPERVISOR_WORK_SCOPE,
  SUPERVISOR_AUTONOMY_PERMISSION_VALUES,
  SUPERVISOR_FORBIDDEN_ACTION_VALUES,
  SUPERVISOR_WORK_SCOPE_VALUES,
  normalizeSupervisorAutonomyPermissions,
  normalizeSupervisorForbiddenActions,
  normalizeSupervisorWorkScope,
  type SupervisorAutonomyPermission,
  type SupervisorForbiddenAction,
  type SupervisorWorkScope,
} from '../../../shared/supervisor-policy';
import {
  MAX_TASK_THREAD_RESPONSIBILITY_LENGTH,
  normalizeTaskChildThreadResponsibilities,
  normalizeTaskThreadResponsibility,
  normalizeTaskWorkMode,
  type TaskWorkMode,
} from '../../../shared/supervisor-work-mode';
import {
  buildSupervisorBriefing,
  effectiveSupervisorLaneConfig,
  stopWhenKindHint,
  stopWhenKindLabel,
  SUPERVISOR_TAB_TITLE,
  SUPERVISOR_WORKSPACE_TITLE,
  supervisorTabTitle,
  supervisorLaneBriefingChanged,
} from '../../supervisor/protocol';
import {
  listSupervisorRestoreCandidates,
  restoreSelectedLaneHistory,
  type SupervisorRestoreCandidate,
} from '../../supervisor/recording';
import {
  buildSupervisorLaunchCommand,
  detectSupervisorLauncher,
  supervisorLauncherDisplayName,
  type SupervisorLauncherKind,
} from '../../supervisor/launch-command';
import { sendToSurface, SUPERVISOR_TUI_READY_DELAY_MS } from '../../supervisor/supervisor-engine';
import { createLeaf, getAllPaneIds } from '../../store/split-utils';
import '../../styles/supervisor.css';

const CODEX_MODEL_OPTIONS = [
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol（复杂监督）' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra（均衡）' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna（快速、重复性监督）' },
];
const KIMI_MODEL_OPTIONS = [
  { value: 'k3', label: 'Kimi K3（长上下文）' },
  { value: 'k3-256k', label: 'Kimi K3 · 256k' },
  { value: 'kimi-for-coding', label: 'Kimi K2.7 Code' },
  { value: 'kimi-for-coding-highspeed', label: 'Kimi K2.7 Code 高速版' },
];
const GROK_MODEL_OPTIONS = [
  { value: 'grok-build', label: 'Grok Build（推荐）' },
  { value: 'grok-4.5', label: 'Grok 4.5' },
];
const PI_MODEL_OPTIONS = [
  { value: 'openai-codex/gpt-5.6-terra', label: 'GPT-5.6 Terra（均衡）' },
  { value: 'openai-codex/gpt-5.6-sol', label: 'GPT-5.6 Sol（复杂监督）' },
  { value: 'openai-codex/gpt-5.6-luna', label: 'GPT-5.6 Luna（快速、重复性监督）' },
  { value: 'kimi-coding/k3', label: 'Kimi K3（长上下文）' },
  { value: 'kimi-coding/k3-256k', label: 'Kimi K3 · 256k' },
  { value: 'kimi-coding/kimi-for-coding', label: 'Kimi K2.7 Code' },
  { value: 'kimi-coding/kimi-for-coding-highspeed', label: 'Kimi K2.7 Code 高速版' },
  { value: 'xai/grok-4.3', label: 'Grok 4.3' },
  { value: 'xai/grok-4.5', label: 'Grok 4.5' },
  { value: 'xai/grok-build-0.1', label: 'Grok Build 0.1' },
];
const SUPERVISOR_LAUNCH_OPTIONS = [
  { value: 'pi', label: 'Pi Agent（推荐）' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'kimi', label: 'Kimi Code' },
  { value: 'grok', label: 'Grok Build' },
  { value: 'opencode', label: 'OpenCode' },
  { value: '', label: '不自动启动' },
];
const REASONING_EFFORT_OPTIONS = [
  { value: 'low', label: '低（更快）' },
  { value: 'medium', label: '中（均衡）' },
  { value: 'high', label: '高（更深入）' },
  { value: 'xhigh', label: '超高（最深入）' },
];
const KIMI_THINKING_OPTIONS = [
  { value: '', label: '使用 Kimi 默认 Thinking 设置' },
  { value: 'on', label: '开启 Thinking' },
];
const PI_THINKING_OPTIONS = [
  { value: 'medium', label: '中（均衡）' },
  { value: 'low', label: '低（更快）' },
  { value: 'high', label: '高（更深入）' },
  { value: 'xhigh', label: '超高' },
  { value: 'max', label: '最大' },
  { value: 'minimal', label: '最小' },
  { value: 'off', label: '关闭' },
];
const CUSTOM_OPTION = '__custom__';
const DEFAULT_MODEL_OPTION = '__default__';

const AUTONOMY_PERMISSION_LABELS: Record<SupervisorAutonomyPermission, string> = {
  'same-route-next': '同一路线继续、返工与低风险补证',
  'technical-choice': '在等价技术方案中自主选择',
  'route-adjustment': '执行小范围、可逆的路线调整',
  'permission-confirm': '确认明确、低风险的终端权限请求',
};

const WORK_SCOPE_LABELS: Record<SupervisorWorkScope, string> = {
  project: '当前工程文件夹（默认）',
  'task-files': '仅当前任务相关文件',
  'plan-defined': '按计划文件定义的范围',
};

const FORBIDDEN_ACTION_LABELS: Record<SupervisorForbiddenAction, string> = {
  'new-dependencies': '新增第三方依赖',
  'public-api-change': '修改公共 API 或对外行为',
  'large-refactor': '进行大范围重构',
  'weaken-tests': '删除、跳过或削弱测试',
  'build-release-config': '修改构建或发布配置',
  'external-network': '访问外部网络或服务',
};

function knownOptionValue(value: string, options: Array<{ value: string }>, fallback = CUSTOM_OPTION): string {
  return options.some((option) => option.value === value.trim()) ? value.trim() : fallback;
}

function modelOptionsFor(launcher: SupervisorLauncherKind): Array<{ value: string; label: string }> {
  if (launcher === 'codex') return CODEX_MODEL_OPTIONS;
  if (launcher === 'kimi') return KIMI_MODEL_OPTIONS;
  if (launcher === 'grok') return GROK_MODEL_OPTIONS;
  if (launcher === 'pi') return PI_MODEL_OPTIONS;
  return [];
}

function modelChoiceFor(launcher: SupervisorLauncherKind, model: string): string {
  const options = modelOptionsFor(launcher);
  return model ? knownOptionValue(model, options) : DEFAULT_MODEL_OPTION;
}

function customModelOptionLabel(launcher: SupervisorLauncherKind): string {
  if (launcher === 'grok') return '自定义模型别名';
  if (launcher === 'pi') return '自定义模型（provider/model）';
  return '自定义模型 ID';
}

function customModelPlaceholder(launcher: SupervisorLauncherKind): string {
  if (launcher === 'grok') return '输入 ~/.grok/config.toml 中的模型别名';
  if (launcher === 'pi') return '例如：openai-codex/gpt-5.5';
  return '输入账户可用的模型 ID';
}

function normalizeMaxAutoDecisions(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(20, parsed) : null;
}

interface TerminalCandidate {
  key: string;
  surfaceId: SurfaceId;
  workspaceId: WorkspaceId;
  paneId: PaneId;
  workspaceTitle: string;
  projectDir?: string;
  label: string;
  state: string;
  currentTask?: string;
  remoteSshControl: boolean;
}

function emptyLaneConfig(): SupervisorLaneConfig {
  return {
    taskGoal: '',
    taskDescription: '',
    preconditions: '',
    stopWhen: '',
    stopWhenKind: 'concrete',
    planFilePath: '',
    taskWorkMode: 'single-thread',
    mainThreadResponsibility: '',
    childThreadResponsibilities: [],
  };
}

function hasIncompleteMultiThreadAssignment(config: SupervisorLaneConfig | undefined): boolean {
  if (!config || normalizeTaskWorkMode(config.taskWorkMode) !== 'multi-thread') return false;
  const childResponsibilities = normalizeTaskChildThreadResponsibilities(
    config.childThreadResponsibilities,
  );
  return !normalizeTaskThreadResponsibility(config.mainThreadResponsibility).trim()
    || childResponsibilities.length === 0
    || childResponsibilities.some((responsibility) => !responsibility.trim());
}

function collectTerminals(
  tree: SplitNode,
  out: Array<{ surfaceId: SurfaceId; paneId: PaneId; title: string; projectDir?: string }>,
): void {
  if (tree.type === 'leaf') {
    for (const s of tree.surfaces) {
      if (s.type === 'terminal') {
        out.push({
          surfaceId: s.id,
          paneId: tree.paneId,
          title: s.customTitle?.trim() || s.shell || 'terminal',
          projectDir: s.currentCwd || s.cwd,
        });
      }
    }
    return;
  }
  collectTerminals(tree.children[0], out);
  collectTerminals(tree.children[1], out);
}

export default function SupervisorSetupDialog() {
  const setupOpen = useStore((s) => s.supervisor.setupOpen);
  const supervisor = useStore((s) => s.supervisor);
  const workspaces = useStore((s) => s.workspaces);
  const agentMeta = useStore((s) => s.agentMeta);
  const closeSupervisorSetup = useStore((s) => s.closeSupervisorSetup);
  const patchSupervisor = useStore((s) => s.patchSupervisor);
  const setSupervisorLanes = useStore((s) => s.setSupervisorLanes);
  const startSupervisor = useStore((s) => s.startSupervisor);
  const defaultSupervisorAgent = useStore((s) => s.workspacePrefs.defaultSupervisorAgent);
  const defaultSupervisorModels = useStore((s) => s.workspacePrefs.defaultSupervisorModels);
  const defaultSupervisorReasoningEfforts = useStore(
    (s) => s.workspacePrefs.defaultSupervisorReasoningEfforts,
  );
  const setWorkspacePrefs = useStore((s) => s.setWorkspacePrefs);
  const stopSupervisor = useStore((s) => s.stopSupervisor);
  const addSurface = useStore((s) => s.addSurface);
  const closeSurface = useStore((s) => s.closeSurface);
  const createWorkspace = useStore((s) => s.createWorkspace);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocusedFieldRef = useRef<HTMLElement | null>(null);
  const sessionRetained = supervisor.active || supervisor.paused;
  let primaryActionLabel = '启动 AI 监督';
  if (supervisor.active) primaryActionLabel = '应用并继续监督';
  else if (supervisor.paused) primaryActionLabel = '应用并返回监督会话';

  const [agentStates, setAgentStates] = useState<Record<string, any>>({});
  useEffect(() => {
    if (!setupOpen) return;
    const w = window as any;
    if (w.__wmux_getAgentStates) setAgentStates(w.__wmux_getAgentStates() || {});
    const t = window.setInterval(() => {
      if (w.__wmux_getAgentStates) setAgentStates(w.__wmux_getAgentStates() || {});
    }, 2000);
    return () => clearInterval(t);
  }, [setupOpen]);

  const candidates = useMemo((): TerminalCandidate[] => {
    const list: TerminalCandidate[] = [];
    const supervisorSurfaceIds = new Set(
      supervisor.lanes.map(dedicatedSupervisorSurfaceId).filter(Boolean),
    );
    for (const ws of workspaces) {
      const surfaces: Array<{ surfaceId: SurfaceId; paneId: PaneId; title: string; projectDir?: string }> = [];
      collectTerminals(ws.splitTree, surfaces);
      for (const s of surfaces) {
        if (supervisorSurfaceIds.has(s.surfaceId)) continue;
        if (s.title.startsWith(SUPERVISOR_TAB_TITLE) || s.title === 'AI Supervisor') continue;
        const meta = agentMeta.get(s.surfaceId);
        const st = agentStates[s.surfaceId]?.state || 'unknown';
        const existingLane = supervisor.lanes.find((lane) => (
          lane.surfaceId === s.surfaceId && isSupervisorLaneBound(lane)
        ));
        list.push({
          key: s.surfaceId,
          surfaceId: s.surfaceId,
          workspaceId: ws.id,
          paneId: s.paneId,
          workspaceTitle: ws.title,
          projectDir: ws.cwd || s.projectDir,
          label: meta?.label || s.title,
          state: String(st),
          currentTask: sessionRetained ? existingLane?.currentTask : undefined,
          remoteSshControl: !!ws.sshProfileId,
        });
      }
    }
    return list;
  }, [workspaces, agentMeta, agentStates, sessionRetained, supervisor.lanes]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [terminalConfigExpansion, setTerminalConfigExpansion] = useState<Record<string, boolean>>({});
  const [dialogNotice, setDialogNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [laneConfigs, setLaneConfigs] = useState<Record<string, SupervisorLaneConfig>>({});
  const [lanePermissionOverrides, setLanePermissionOverrides] = useState<
    Record<string, SupervisorAutonomyPermission[]>
  >({});
  const [restoreAuditHistory, setRestoreAuditHistory] = useState(supervisor.restoreAuditHistory);
  const [restoreCandidates, setRestoreCandidates] = useState<Record<string, SupervisorRestoreCandidate[]>>({});
  const [restoreSources, setRestoreSources] = useState<Record<string, string>>({});
  const [launchCmd, setLaunchCmd] = useState(supervisor.supervisorLaunchCmd);
  const [supervisorModel, setSupervisorModel] = useState(supervisor.supervisorModel || '');
  const [launchChoice, setLaunchChoice] = useState(
    knownOptionValue(supervisor.supervisorLaunchCmd, SUPERVISOR_LAUNCH_OPTIONS),
  );
  const [modelChoice, setModelChoice] = useState(
    modelChoiceFor(detectSupervisorLauncher(supervisor.supervisorLaunchCmd), supervisor.supervisorModel),
  );
  const [reasoningEffort, setReasoningEffort] = useState(supervisor.supervisorReasoningEffort || '');
  const [maxAutoDecisions, setMaxAutoDecisions] = useState(
    supervisor.maxAutoDecisions ? String(supervisor.maxAutoDecisions) : '',
  );
  const [autonomous, setAutonomous] = useState(supervisor.autonomous === true);
  const [autonomyPermissions, setAutonomyPermissions] = useState<SupervisorAutonomyPermission[]>(
    supervisor.autonomyPermissions || [...DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS],
  );
  const [laneAutonomousOverrides, setLaneAutonomousOverrides] = useState<Record<string, boolean>>({});
  const [laneForbiddenActionOverrides, setLaneForbiddenActionOverrides] = useState<Record<string, SupervisorForbiddenAction[]>>({});
  const [workScope, setWorkScope] = useState<SupervisorWorkScope>(
    supervisor.workScope || DEFAULT_SUPERVISOR_WORK_SCOPE,
  );
  const [forbiddenActions, setForbiddenActions] = useState<SupervisorForbiddenAction[]>(
    supervisor.forbiddenActions || [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS],
  );

  useEffect(() => {
    if (!setupOpen) return;
    setDialogNotice(null);
    setRestoreAuditHistory(supervisor.restoreAuditHistory === true);
    setRestoreSources(Object.fromEntries(
      supervisor.lanes.flatMap((lane) => lane.restoreSource ? [[lane.surfaceId, lane.restoreSource.surfaceId]] : []),
    ));
    setLaunchCmd(supervisor.supervisorLaunchCmd || '');
    setSupervisorModel(supervisor.supervisorModel || '');
    setLaunchChoice(knownOptionValue(supervisor.supervisorLaunchCmd, SUPERVISOR_LAUNCH_OPTIONS));
    setModelChoice(modelChoiceFor(
      detectSupervisorLauncher(supervisor.supervisorLaunchCmd),
      supervisor.supervisorModel,
    ));
    setReasoningEffort(supervisor.supervisorReasoningEffort || '');
    setMaxAutoDecisions(supervisor.maxAutoDecisions ? String(supervisor.maxAutoDecisions) : '');
    setAutonomous(supervisor.autonomous === true);
    setAutonomyPermissions(normalizeSupervisorAutonomyPermissions(supervisor.autonomyPermissions));
    setWorkScope(normalizeSupervisorWorkScope(supervisor.workScope));
    setForbiddenActions(normalizeSupervisorForbiddenActions(supervisor.forbiddenActions));
    const boundSurfaceIds = supervisor.lanes.filter(isSupervisorLaneBound).map((lane) => lane.surfaceId);
    setSelected(new Set(boundSurfaceIds));
    setTerminalConfigExpansion((current) => {
      const next = { ...current };
      let changed = false;
      for (const surfaceId of boundSurfaceIds) {
        if (typeof next[surfaceId] === 'boolean') continue;
        next[surfaceId] = true;
        changed = true;
      }
      return changed ? next : current;
    });
    setLaneConfigs(Object.fromEntries(
      supervisor.lanes.map((lane) => [lane.surfaceId, effectiveSupervisorLaneConfig(supervisor, lane)]),
    ));
    setLanePermissionOverrides(Object.fromEntries(
      supervisor.lanes.flatMap((lane) => Array.isArray(lane.autonomyPermissionsOverride)
        ? [[lane.surfaceId, [...lane.autonomyPermissionsOverride]]]
        : []),
    ));
    setLaneAutonomousOverrides(Object.fromEntries(
      supervisor.lanes.flatMap((lane) => typeof lane.autonomousOverride === 'boolean'
        ? [[lane.surfaceId, lane.autonomousOverride]]
        : []),
    ));
    setLaneForbiddenActionOverrides(Object.fromEntries(
      supervisor.lanes.flatMap((lane) => Array.isArray(lane.forbiddenActionsOverride)
        ? [[lane.surfaceId, [...lane.forbiddenActionsOverride]]]
        : []),
    ));
  }, [setupOpen]);

  useEffect(() => {
    if (!setupOpen) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSupervisorSetup();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [setupOpen, closeSupervisorSetup]);

  useEffect(() => {
    if (!setupOpen) return;
    const restoreDialogFocus = () => {
      requestAnimationFrame(() => {
        const dialog = dialogRef.current;
        if (!dialog || dialog.contains(document.activeElement)) return;
        const field = lastFocusedFieldRef.current;
        if (field?.isConnected && dialog.contains(field)) field.focus();
        else dialog.focus();
      });
    };
    window.addEventListener('focus', restoreDialogFocus);
    return () => window.removeEventListener('focus', restoreDialogFocus);
  }, [setupOpen]);

  useEffect(() => {
    if (!setupOpen || sessionRetained) return;
    setAutonomous(false);
    if (supervisor.autonomous) patchSupervisor({ autonomous: false });
  }, [setupOpen, sessionRetained, supervisor.autonomous, patchSupervisor]);

  const launcherKind = useMemo(() => detectSupervisorLauncher(
    launchChoice === CUSTOM_OPTION ? launchCmd : launchChoice,
  ), [launchChoice, launchCmd]);
  const launcherModelOptions = modelOptionsFor(launcherKind);
  const selectedDefaultAgent = launchChoice === ''
    ? 'none'
    : SUPERVISOR_LAUNCH_OPTIONS.some((option) => option.value === launchChoice)
      ? launchChoice as DefaultSupervisorAgent
      : null;
  const selectedAgentDefaults = selectedDefaultAgent
    ? supervisorDefaultsForAgent(selectedDefaultAgent, {
        defaultSupervisorModels,
        defaultSupervisorReasoningEfforts,
      })
    : null;
  const modelIsDefault = !!selectedAgentDefaults
    && supervisorModel === selectedAgentDefaults.supervisorModel;
  const reasoningIsDefault = !!selectedAgentDefaults
    && reasoningEffort === selectedAgentDefaults.supervisorReasoningEffort;

  const saveCurrentModelAsDefault = () => {
    if (!selectedDefaultAgent) return;
    setWorkspacePrefs({
      defaultSupervisorModels: {
        ...defaultSupervisorModels,
        [selectedDefaultAgent]: supervisorModel,
      },
    });
  };

  const saveCurrentReasoningAsDefault = () => {
    if (!selectedDefaultAgent) return;
    setWorkspacePrefs({
      defaultSupervisorReasoningEfforts: {
        ...defaultSupervisorReasoningEfforts,
        [selectedDefaultAgent]: reasoningEffort,
      },
    });
  };

  const changeLauncher = (choice: string) => {
    setLaunchChoice(choice);
    if (choice === CUSTOM_OPTION) return;
    setLaunchCmd(choice);
    const nextLauncher = detectSupervisorLauncher(choice);
    const nextAgent = choice === ''
      ? 'none'
      : SUPERVISOR_LAUNCH_OPTIONS.some((option) => option.value === choice)
        ? choice as DefaultSupervisorAgent
        : null;
    const nextDefaults = nextAgent
      ? supervisorDefaultsForAgent(nextAgent, {
          defaultSupervisorModels,
          defaultSupervisorReasoningEfforts,
        })
      : null;
    const nextModel = nextDefaults?.supervisorModel || '';
    setSupervisorModel(nextModel);
    setModelChoice(modelChoiceFor(nextLauncher, nextModel));
    setReasoningEffort(nextDefaults?.supervisorReasoningEffort || '');
  };

  useEffect(() => {
    if (!setupOpen || !restoreAuditHistory) {
      setRestoreCandidates({});
      return;
    }
    let cancelled = false;
    const selectedCandidates = candidates.filter((candidate) => selected.has(candidate.surfaceId));
    void Promise.all(selectedCandidates.map(async (candidate) => [
      candidate.surfaceId,
      candidate.projectDir ? await listSupervisorRestoreCandidates(candidate.projectDir) : [],
    ] as const)).then((entries) => {
      if (!cancelled) setRestoreCandidates(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [setupOpen, restoreAuditHistory, selected, candidates]);

  if (!setupOpen) return null;

  const toggle = (surfaceId: string) => {
    if (sessionRetained && supervisor.lanes.some((lane) => (
      lane.surfaceId === surfaceId && isSupervisorLaneBound(lane)
    ))) return;
    setDialogNotice(null);
    if (!selected.has(surfaceId)) {
      setLaneConfigs((current) => current[surfaceId]
        ? current
        : { ...current, [surfaceId]: emptyLaneConfig() });
    }
    if (!selected.has(surfaceId)) {
      setTerminalConfigExpansion((current) => typeof current[surfaceId] === 'boolean'
        ? current
        : { ...current, [surfaceId]: true });
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(surfaceId)) next.delete(surfaceId);
      else next.add(surfaceId);
      return next;
    });
  };

  const setTerminalConfigExpanded = (surfaceId: string, expanded: boolean) => {
    setTerminalConfigExpansion((current) => current[surfaceId] === expanded
      ? current
      : { ...current, [surfaceId]: expanded });
  };

  const updateLaneConfig = (surfaceId: string, patch: Partial<SupervisorLaneConfig>) => {
    setDialogNotice(null);
    setLaneConfigs((current) => ({
      ...current,
      [surfaceId]: { ...(current[surfaceId] || emptyLaneConfig()), ...patch },
    }));
  };

  const choosePlanFile = async (surfaceId: string) => {
    try {
      const result = await (window as any).wmux?.markdown?.openFile?.();
      if (!result || result.canceled) return;
      if (result.error || !result.filePath) {
        setDialogNotice({ kind: 'error', message: result.error || '无法读取计划文件。' });
        return;
      }
      updateLaneConfig(surfaceId, { planFilePath: result.filePath });
    } catch (err: any) {
      setDialogNotice({ kind: 'error', message: `选择计划文件失败：${String(err?.message || err)}` });
    }
  };

  const configFileData = () => {
    const surfaceId = Array.from(selected)[0];
    const laneConfig = laneConfigs[surfaceId] || emptyLaneConfig();
    return {
      ...laneConfig,
      supervisorLaunchCmd: launchCmd,
      supervisorModel,
      supervisorReasoningEffort: reasoningEffort,
      maxAutoDecisions: normalizeMaxAutoDecisions(maxAutoDecisions),
      autonomyPermissions,
      workScope,
      forbiddenActions,
    };
  };

  const configFileDefaultPath = () => {
    const selectedTerminal = candidates.find((candidate) => selected.has(candidate.surfaceId) && candidate.projectDir)
      || supervisor.lanes.find((lane) => supervisorLaneControlState(lane) !== 'stopped' && lane.projectDir);
    if (!selectedTerminal?.projectDir) return undefined;
    const projectDir = selectedTerminal.projectDir.replace(/[\\/]+$/, '');
    return `${projectDir}\\.wmux\\ai-supervisor.wmux-supervisor.json`;
  };

  const saveConfigFile = async () => {
    if (selected.size !== 1) {
      setDialogNotice({ kind: 'error', message: '导出任务配置时请只选择一个终端。' });
      return;
    }
    const result = await (window as any).wmux?.supervisor?.saveConfig?.(
      configFileData(),
      configFileDefaultPath(),
    );
    if (!result || result.canceled) return;
    if (result.error) {
      setDialogNotice({ kind: 'error', message: `保存监督配置失败：${result.error}` });
      return;
    }
    setDialogNotice({ kind: 'success', message: `已保存监督配置：${result.filePath}` });
  };

  const loadConfigFile = async () => {
    const result = await (window as any).wmux?.supervisor?.loadConfig?.(configFileDefaultPath());
    if (!result || result.canceled) return;
    if (result.error || !result.config) {
      setDialogNotice({ kind: 'error', message: `加载监督配置失败：${result.error || '文件内容无效'}` });
      return;
    }
    const config = result.config;
    const selectedSurfaceIds = Array.from(selected);
    if (selectedSurfaceIds.length === 0) {
      setDialogNotice({ kind: 'error', message: '请先选择要应用配置的终端。' });
      return;
    }
    const loadedLaunchCommand = config.supervisorLaunchCmd ?? 'pi';
    const loadedLauncherKind = detectSupervisorLauncher(loadedLaunchCommand);
    const loadedPlanFilePath = config.planFilePath || '';
    const loadedWorkScope = normalizeSupervisorWorkScope(config.workScope);
    setLaneConfigs((current) => {
      const next = { ...current };
      for (const surfaceId of selectedSurfaceIds) {
        next[surfaceId] = {
          taskGoal: config.taskGoal || '',
          taskDescription: config.taskDescription || '',
          preconditions: config.preconditions || '',
          stopWhen: config.stopWhen || '',
          stopWhenKind: config.stopWhenKind === 'direction' ? 'direction' : 'concrete',
          planFilePath: loadedPlanFilePath,
          taskWorkMode: normalizeTaskWorkMode(config.taskWorkMode),
          mainThreadResponsibility: normalizeTaskThreadResponsibility(config.mainThreadResponsibility),
          childThreadResponsibilities: normalizeTaskChildThreadResponsibilities(
            config.childThreadResponsibilities,
          ),
        };
      }
      return next;
    });
    if (!sessionRetained) {
      setLaunchCmd(loadedLaunchCommand);
      setLaunchChoice(knownOptionValue(loadedLaunchCommand, SUPERVISOR_LAUNCH_OPTIONS));
      setSupervisorModel(config.supervisorModel || '');
      setModelChoice(config.supervisorModel
        ? knownOptionValue(config.supervisorModel, modelOptionsFor(loadedLauncherKind))
        : '__default__');
      setReasoningEffort(config.supervisorReasoningEffort || '');
      setMaxAutoDecisions(config.maxAutoDecisions ? String(config.maxAutoDecisions) : '');
      setAutonomyPermissions(normalizeSupervisorAutonomyPermissions(config.autonomyPermissions));
      setWorkScope(loadedWorkScope === 'plan-defined' && !loadedPlanFilePath
        ? 'task-files'
        : loadedWorkScope);
      setForbiddenActions(normalizeSupervisorForbiddenActions(config.forbiddenActions));
    }
    setDialogNotice({ kind: 'success', message: `已将配置导入 ${selectedSurfaceIds.length} 个终端。` });
  };

  const buildLanes = (preserveCurrentContext: boolean): SupervisorLane[] => {
    const lanes: SupervisorLane[] = [];
    for (const c of candidates) {
      if (!selected.has(c.surfaceId)) continue;
      const prev = supervisor.lanes.find((l) => (
        l.surfaceId === c.surfaceId && isSupervisorLaneBound(l)
      ));
      const selectedSourceId = restoreSources[c.surfaceId];
      const selectedSource = restoreAuditHistory
        ? restoreCandidates[c.surfaceId]?.find((candidate) => candidate.surfaceId === selectedSourceId)
        : undefined;
      const keepsRestoredContext = !!selectedSource
        && prev?.restoreSource?.surfaceId === selectedSource.surfaceId;
      const keepsCurrentContext = preserveCurrentContext || keepsRestoredContext;
      const restoreSource = selectedSource
        ? {
            surfaceId: selectedSource.surfaceId,
            label: selectedSource.label,
            sessionId: selectedSource.sessionId,
          }
        : keepsCurrentContext ? prev?.restoreSource : undefined;
      const config = laneConfigs[c.surfaceId]
        || (prev ? effectiveSupervisorLaneConfig(supervisor, prev) : emptyLaneConfig());
      lanes.push({
        id: prev?.id || `lane-${c.surfaceId}`,
        managementSessionId: prev?.managementSessionId
          || `sup-lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        label: c.label,
        surfaceId: c.surfaceId,
        supervisorSurfaceId: prev ? dedicatedSupervisorSurfaceId(prev) : null,
        paneId: c.paneId,
        workspaceId: c.workspaceId,
        workspaceTitle: c.workspaceTitle,
        remoteSshControl: c.remoteSshControl,
        projectDir: c.projectDir,
        scopeRoot: sessionRetained ? prev?.scopeRoot || c.projectDir : c.projectDir,
        enabled: keepsCurrentContext ? prev?.enabled ?? true : true,
        controlState: keepsCurrentContext && prev
          ? supervisorLaneControlState(prev)
          : 'active',
        steps: keepsCurrentContext ? prev?.steps || [] : [],
        maxAutoSteps: keepsCurrentContext ? prev?.maxAutoSteps || 0 : 0,
        autoStepsUsed: keepsCurrentContext ? prev?.autoStepsUsed || 0 : 0,
        awaitingStopCheck: keepsCurrentContext ? prev?.awaitingStopCheck || false : false,
        stopConfirmed: keepsCurrentContext ? prev?.stopConfirmed || false : false,
        awaitingReview: keepsCurrentContext ? prev?.awaitingReview || false : false,
        resumeAfterCancelledDecision: keepsCurrentContext ? prev?.resumeAfterCancelledDecision : false,
        lastBlockedResponseVersion: keepsCurrentContext ? prev?.lastBlockedResponseVersion : undefined,
        lastBlockedResponseId: keepsCurrentContext ? prev?.lastBlockedResponseId : undefined,
        autoDecisionLimitReached: keepsCurrentContext ? prev?.autoDecisionLimitReached || false : false,
        autoDecisionsUsed: keepsCurrentContext ? prev?.autoDecisionsUsed || 0 : 0,
        pendingSupervisorDeliveries: keepsCurrentContext ? prev?.pendingSupervisorDeliveries || [] : [],
        currentTask: keepsCurrentContext ? prev?.currentTask || '' : '',
        decisions: keepsCurrentContext ? prev?.decisions || [] : [],
        config: {
          taskGoal: config.taskGoal.trim(),
          taskDescription: config.taskDescription.trim(),
          preconditions: config.preconditions.trim(),
          stopWhen: config.stopWhen.trim(),
          stopWhenKind: config.stopWhenKind === 'direction' ? 'direction' : 'concrete',
          planFilePath: config.planFilePath.trim(),
          taskWorkMode: normalizeTaskWorkMode(config.taskWorkMode),
          mainThreadResponsibility: normalizeTaskThreadResponsibility(
            config.mainThreadResponsibility,
          ).trim(),
          childThreadResponsibilities: normalizeTaskChildThreadResponsibilities(
            config.childThreadResponsibilities,
          ).map((responsibility) => responsibility.trim()),
        },
        ...(Array.isArray(lanePermissionOverrides[c.surfaceId])
          ? { autonomyPermissionsOverride: [...lanePermissionOverrides[c.surfaceId]] }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(laneAutonomousOverrides, c.surfaceId)
          ? { autonomousOverride: laneAutonomousOverrides[c.surfaceId] }
          : {}),
        ...(Array.isArray(laneForbiddenActionOverrides[c.surfaceId])
          ? { forbiddenActionsOverride: [...laneForbiddenActionOverrides[c.surfaceId]] }
          : {}),
        ...(restoreSource ? { restoreSource } : {}),
        ...(keepsCurrentContext && prev?.restoredHistory ? { restoredHistory: prev.restoredHistory } : {}),
        ...(keepsCurrentContext && prev?.restoredFromSessionId ? { restoredFromSessionId: prev.restoredFromSessionId } : {}),
      });
    }
    return lanes;
  };

  const persistFields = (lanes: SupervisorLane[], grantSessionAutonomy: boolean) => {
    const legacyConfig = lanes[0]?.config || emptyLaneConfig();
    patchSupervisor({
      mode: 'unified',
      directInstructions: '',
      goal: '',
      allowPaths: '',
      denyNotes: '',
      doneWhen: '',
      // Compatibility mirror for old saved sessions and remote integrations.
      // Runtime decisions always read the owning lane.config first.
      taskGoal: legacyConfig.taskGoal,
      taskDescription: legacyConfig.taskDescription,
      preconditions: legacyConfig.preconditions,
      stopWhen: legacyConfig.stopWhen,
      stopWhenKind: legacyConfig.stopWhenKind,
      planFilePath: legacyConfig.planFilePath,
      planFileContent: '',
      restoreAuditHistory,
      supervisorLaunchCmd: launchCmd,
      supervisorModel: launcherKind === 'other' ? '' : supervisorModel,
      supervisorReasoningEffort: launcherKind === 'codex' || launcherKind === 'kimi' || launcherKind === 'pi'
        ? reasoningEffort
        : '',
      maxAutoSteps: 0,
      maxAutoDecisions: normalizeMaxAutoDecisions(maxAutoDecisions),
      autonomous: grantSessionAutonomy ? autonomous : false,
      autonomyPermissions,
      workScope,
      forbiddenActions,
    });
  };

  const ensureDedicatedSupervisors = (
    lanes: SupervisorLane[],
    replaceExisting = false,
  ): { ok: boolean; lanes: SupervisorLane[] } => {
    const launchCommand = buildSupervisorLaunchCommand(launchCmd, supervisorModel, reasoningEffort);
    const startupCommands = launchCommand ? [launchCommand] : undefined;
    const terminalLocations = new Map<SurfaceId, { workspaceId: WorkspaceId; paneId: PaneId }>();
    for (const workspace of workspaces) {
      const terminals: Array<{ surfaceId: SurfaceId; paneId: PaneId; title: string; projectDir?: string }> = [];
      collectTerminals(workspace.splitTree, terminals);
      for (const terminal of terminals) {
        terminalLocations.set(terminal.surfaceId, {
          workspaceId: workspace.id,
          paneId: terminal.paneId,
        });
      }
    }

    let supervisorWorkspace = workspaces.find((workspace) => workspace.id === supervisor.supervisorWorkspaceId);
    if (!supervisorWorkspace) {
      const workspaceId = createWorkspace({
        title: SUPERVISOR_WORKSPACE_TITLE,
        pinned: true,
        transientSupervisorWorkspace: true,
        splitTree: createLeaf(undefined, 'supervisor'),
      });
      patchSupervisor({ supervisorWorkspaceId: workspaceId });
      supervisorWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === workspaceId);
    }
    const targetPaneId = supervisorWorkspace
      ? getAllPaneIds(supervisorWorkspace.splitTree)[0]
      : undefined;
    if (!supervisorWorkspace || !targetPaneId) return { ok: false, lanes };

    const createdSurfaceIds: SurfaceId[] = [];
    const surfacesToClose = new Map<SurfaceId, {
      surfaceId: SurfaceId;
      workspaceId: WorkspaceId;
      paneId: PaneId;
    }>();
    const configuredLanes = lanes.map((lane) => {
      const existingSupervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
      const existingLocation = existingSupervisorSurfaceId
        ? terminalLocations.get(existingSupervisorSurfaceId)
        : undefined;
      if (existingLocation && !replaceExisting) {
        return lane;
      }
      const supervisorSurfaceId = addSurface(supervisorWorkspace.id, targetPaneId, 'terminal', {
        customTitle: supervisorTabTitle(lane.label),
        shell: 'pwsh.exe',
        cwd: lane.projectDir,
        startupCommands,
        transientSupervisor: true,
      });
      if (supervisorSurfaceId) createdSurfaceIds.push(supervisorSurfaceId);
      return { ...lane, supervisorSurfaceId };
    });

    if (configuredLanes.some((lane) => !lane.supervisorSurfaceId)) {
      for (const surfaceId of createdSurfaceIds) {
        closeSurface(supervisorWorkspace.id, targetPaneId, surfaceId);
      }
      return { ok: false, lanes };
    }
    if (replaceExisting) {
      for (const oldLane of supervisor.lanes) {
        if (!oldLane.supervisorSurfaceId) continue;
        const location = terminalLocations.get(oldLane.supervisorSurfaceId);
        if (!location) continue;
        surfacesToClose.set(oldLane.supervisorSurfaceId, {
          surfaceId: oldLane.supervisorSurfaceId,
          ...location,
        });
      }
    }
    for (const oldSurface of surfacesToClose.values()) {
      closeSurface(oldSurface.workspaceId, oldSurface.paneId, oldSurface.surfaceId);
    }
    return { ok: true, lanes: configuredLanes };
  };

  const sendDedicatedBriefings = (laneIds: ReadonlySet<string>) => {
    if (laneIds.size === 0) return;
    window.setTimeout(() => void (async () => {
      try {
        let session = useStore.getState().supervisor;
        if (session.restoreAuditHistory) {
          for (const lane of session.lanes) {
            if (!laneIds.has(lane.id)) continue;
            if (!lane.restoreSource || lane.restoredFromSessionId || (lane.decisions?.length ?? 0) > 0) continue;
            const restored = await restoreSelectedLaneHistory(lane, lane.restoreSource);
            if (restored) useStore.getState().updateLane(lane.id, restored);
          }
          session = useStore.getState().supervisor;
        }
        const states = (window as any).__wmux_getAgentStates?.() || {};
        for (const lane of session.lanes) {
          if (!laneIds.has(lane.id)) continue;
          const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
          if (!supervisorSurfaceId) continue;
          const text = buildSupervisorBriefing(session, {
            lane,
            state: String(states[lane.surfaceId]?.state || 'unknown'),
          });
          sendToSurface(supervisorSurfaceId, text, true);
        }
      } catch (err) {
        console.warn('[supervisor] briefing inject failed', err);
      }
    })(), SUPERVISOR_TUI_READY_DELAY_MS);
  };

  const applyConfig = (andStart: boolean) => {
    setDialogNotice(null);
    const lanes = buildLanes(!andStart || sessionRetained);
    if (lanes.length === 0) {
      setDialogNotice({ kind: 'error', message: '请至少选择一个要监控的终端。' });
      return;
    }
    const missingStopWhen = lanes.filter((lane) => !lane.config?.stopWhen.trim());
    if (missingStopWhen.length > 0) {
      setDialogNotice({
        kind: 'error',
        message: `请为以下终端填写停止条件：${missingStopWhen.map((lane) => lane.label).join('、')}`,
      });
      return;
    }
    const incompleteThreadAssignments = lanes.filter((lane) => (
      hasIncompleteMultiThreadAssignment(lane.config)
    ));
    if (incompleteThreadAssignments.length > 0) {
      setDialogNotice({
        kind: 'error',
        message: `请完整填写以下终端的主线程和已启用子线程职责：${incompleteThreadAssignments.map((lane) => lane.label).join('、')}`,
      });
      return;
    }
    if (workScope === 'plan-defined' && lanes.some((lane) => !lane.config?.planFilePath.trim())) {
      setDialogNotice({ kind: 'error', message: '工作范围选择“按计划文件定义”时，每个被监督终端都必须选择自己的计划文件。' });
      return;
    }
    if (andStart && !launchCmd.trim()) {
      setDialogNotice({ kind: 'error', message: '请选择可启动的监督 AI；“不自动启动”不能接收监督 briefing。' });
      return;
    }

    if (andStart) {
      const result = ensureDedicatedSupervisors(lanes, !sessionRetained);
      if (!result.ok) {
        setDialogNotice({ kind: 'error', message: '无法为所有选中终端创建专属监督 AI；监督尚未启动，请重试。' });
        return;
      }
      persistFields(result.lanes, true);
      setSupervisorLanes(result.lanes);
      if (!sessionRetained) startSupervisor();
      else closeSupervisorSetup();
      const nextSession = useStore.getState().supervisor;
      const previousBySurfaceId = new Map(supervisor.lanes.map((lane) => [lane.surfaceId, lane]));
      const briefingLaneIds = new Set(nextSession.lanes
        .filter((lane) => supervisorLaneBriefingChanged(
          supervisor,
          previousBySurfaceId.get(lane.surfaceId),
          nextSession,
          lane,
        ))
        .map((lane) => lane.id));
      const workspaceId = useStore.getState().supervisor.supervisorWorkspaceId;
      if (workspaceId) selectWorkspace(workspaceId);
      sendDedicatedBriefings(briefingLaneIds);
    } else {
      persistFields(lanes, false);
      setSupervisorLanes(lanes);
      closeSupervisorSetup();
    }
  };

  const openAiSession = () => {
    setDialogNotice(null);
    const lanes = buildLanes(sessionRetained);
    if (lanes.length === 0) {
      setDialogNotice({ kind: 'error', message: '请先至少选择一个要监控的终端。' });
      return;
    }
    const missingStopWhen = lanes.filter((lane) => !lane.config?.stopWhen.trim());
    if (missingStopWhen.length > 0) {
      setDialogNotice({
        kind: 'error',
        message: `请为以下终端填写停止条件：${missingStopWhen.map((lane) => lane.label).join('、')}`,
      });
      return;
    }
    const incompleteThreadAssignments = lanes.filter((lane) => (
      hasIncompleteMultiThreadAssignment(lane.config)
    ));
    if (incompleteThreadAssignments.length > 0) {
      setDialogNotice({
        kind: 'error',
        message: `请完整填写以下终端的主线程和已启用子线程职责：${incompleteThreadAssignments.map((lane) => lane.label).join('、')}`,
      });
      return;
    }
    if (!launchCmd.trim()) {
      setDialogNotice({ kind: 'error', message: '请选择可启动的监督 AI；“不自动启动”不能接收监督 briefing。' });
      return;
    }
    const result = ensureDedicatedSupervisors(lanes, true);
    if (!result.ok) {
      setDialogNotice({ kind: 'error', message: '无法为所有选中终端创建专属监督 AI，请重试。' });
      return;
    }
    persistFields(result.lanes, false);
    setSupervisorLanes(result.lanes);
    closeSupervisorSetup();
    const workspaceId = useStore.getState().supervisor.supervisorWorkspaceId;
    if (workspaceId) selectWorkspace(workspaceId);
    sendDedicatedBriefings(new Set(result.lanes.map((lane) => lane.id)));
  };

  const toggleAutonomyPermission = (permission: SupervisorAutonomyPermission) => {
    setAutonomyPermissions((current) => current.includes(permission)
      ? current.filter((item) => item !== permission)
      : [...current, permission]);
  };

  const toggleForbiddenAction = (action: SupervisorForbiddenAction) => {
    setForbiddenActions((current) => current.includes(action)
      ? current.filter((item) => item !== action)
      : [...current, action]);
  };

  const selectedCandidates = candidates.filter((candidate) => selected.has(candidate.surfaceId));
  const insufficientCandidates = selectedCandidates.filter((candidate) => (
    !candidate.currentTask?.trim()
    && !laneConfigs[candidate.surfaceId]?.taskGoal.trim()
    && !laneConfigs[candidate.surfaceId]?.planFilePath.trim()
  ));

  return (
    <div className="confirm-dialog__overlay supervisor-dialog__overlay">
      <div
        ref={dialogRef}
        className="supervisor-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="AI 监督"
        tabIndex={-1}
        onFocusCapture={(event) => {
          const target = event.target;
          if (target instanceof HTMLElement && target.matches('input, textarea, select, [contenteditable="true"]')) {
            lastFocusedFieldRef.current = target;
          }
        }}
      >
        <header className="supervisor-dialog__header">
          <div className="supervisor-dialog__title">AI 监督配置</div>
          <div className="supervisor-dialog__sub">
            工作终端仍由你正常下达任务；每个选中的终端使用独立、可见的监督 AI 上下文。
          </div>
        </header>

        <div className="supervisor-dialog__body">
          <section className="supervisor-dialog__group">
            <div className="supervisor-dialog__group-heading">
              <div>
                <div className="supervisor-dialog__group-title">1. 监督对象</div>
                <div className="supervisor-dialog__group-description">每个终端分别配置任务依据，并由自己的专属监督 AI 管理。</div>
              </div>
              <span className="supervisor-dialog__count">已选 {selectedCandidates.length} 个</span>
            </div>
            <div className="supervisor-dialog__list">
              {candidates.length === 0 && (
                <div className="supervisor-dialog__empty">当前没有打开的终端。</div>
              )}
              {candidates.map((candidate) => {
                const isSelected = selected.has(candidate.surfaceId);
                const laneConfig = laneConfigs[candidate.surfaceId] || emptyLaneConfig();
                const lanePermissionOverride = lanePermissionOverrides[candidate.surfaceId];
                const lanePolicyOverride = Array.isArray(lanePermissionOverride)
                  || Object.prototype.hasOwnProperty.call(laneAutonomousOverrides, candidate.surfaceId)
                  || Array.isArray(laneForbiddenActionOverrides[candidate.surfaceId]);
                const laneAutonomous = laneAutonomousOverrides[candidate.surfaceId] ?? autonomous;
                const laneForbiddenActions = laneForbiddenActionOverrides[candidate.surfaceId] || forbiddenActions;
                const isExistingLane = sessionRetained
                  && supervisor.lanes.some((lane) => (
                    lane.surfaceId === candidate.surfaceId && isSupervisorLaneBound(lane)
                  ));
                const isConfigExpanded = terminalConfigExpansion[candidate.surfaceId] ?? true;
                const taskWorkMode = normalizeTaskWorkMode(laneConfig.taskWorkMode);
                const configuredChildThreadResponsibilities = normalizeTaskChildThreadResponsibilities(
                  laneConfig.childThreadResponsibilities,
                );
                const childThreadResponsibilities = taskWorkMode === 'multi-thread'
                  && configuredChildThreadResponsibilities.length === 0
                  ? ['']
                  : configuredChildThreadResponsibilities;
                return (
                  <div key={candidate.key} className="supervisor-dialog__terminal" data-selected={isSelected}>
                    <label className="supervisor-dialog__row">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={isExistingLane}
                        onChange={() => toggle(candidate.surfaceId)}
                      />
                      <span className="supervisor-dialog__row-main">
                        <span className="supervisor-dialog__row-label">{candidate.label}</span>
                        <span className="supervisor-dialog__row-meta">
                          {candidate.workspaceTitle} · 状态 {candidate.state}
                          {candidate.remoteSshControl ? ' · SSH 远程控制' : ''}
                          {' · '}{candidate.surfaceId.slice(0, 12)}…
                        </span>
                        <span className="supervisor-dialog__current-task" title={candidate.currentTask || ''}>
                          当前任务：{candidate.currentTask?.trim() || '尚未收到终端任务事件'}
                        </span>
                      </span>
                    </label>
                    {isSelected && (
                      <details
                        className="supervisor-dialog__lane-settings"
                        open={isConfigExpanded}
                        onToggle={(event) => setTerminalConfigExpanded(
                          candidate.surfaceId,
                          event.currentTarget.open,
                        )}
                      >
                        <summary>
                          {isExistingLane ? '当前独立监督配置（会保留原管理会话）' : '配置此终端的独立监督任务'}
                          <span className="supervisor-dialog__toggle-hint">
                            {isConfigExpanded ? '折叠' : '展开'}
                          </span>
                        </summary>
                        <div className="supervisor-dialog__section">
                          <div className="supervisor-dialog__label">任务目标（可选）</div>
                          <textarea
                            className="supervisor-dialog__textarea"
                            aria-label={`${candidate.label} 的任务目标`}
                            rows={2}
                            value={laneConfig.taskGoal}
                            onChange={(event) => updateLaneConfig(candidate.surfaceId, { taskGoal: event.target.value })}
                            placeholder="例如：修复此终端负责的认证模块并保持现有行为"
                          />
                        </div>
                        <div className="supervisor-dialog__section">
                          <div className="supervisor-dialog__label">任务终端 AI 工作模式</div>
                          <div className="supervisor-dialog__freedom">
                            {([
                              ['single-thread', '单线程工作', '任务终端 AI 在一个执行线程内完成任务'],
                              ['multi-thread', '多线程工程', '任务终端 AI 按约定自行拆分主线程和子线程'],
                            ] as Array<[TaskWorkMode, string, string]>).map(([mode, label, description]) => (
                              <label key={mode} className="supervisor-dialog__radio" data-active={taskWorkMode === mode}>
                                <input
                                  type="radio"
                                  name={`taskWorkMode-${candidate.surfaceId}`}
                                  checked={taskWorkMode === mode}
                                  onChange={() => updateLaneConfig(candidate.surfaceId, {
                                    taskWorkMode: mode,
                                    ...(mode === 'multi-thread' && childThreadResponsibilities.length === 0
                                      ? { childThreadResponsibilities: [''] }
                                      : {}),
                                  })}
                                />
                                <span><strong>{label}</strong> — {description}</span>
                              </label>
                            ))}
                          </div>
                          <div className="supervisor-dialog__hint">
                            这里约定的是任务终端里的 AI，不是监督 AI；wmux 记录并传达分工，不创建额外终端。
                          </div>
                          {taskWorkMode === 'multi-thread' && (
                            <div className="supervisor-dialog__thread-config">
                              <label className="supervisor-dialog__thread-count">
                                <span>子线程数量</span>
                                <select
                                  className="supervisor-dialog__input"
                                  aria-label={`${candidate.label} 的子线程数量`}
                                  value={Math.max(1, childThreadResponsibilities.length)}
                                  onChange={(event) => {
                                    const count = Number(event.target.value);
                                    updateLaneConfig(candidate.surfaceId, {
                                      childThreadResponsibilities: Array.from(
                                        { length: count },
                                        (_, index) => childThreadResponsibilities[index] || '',
                                      ),
                                    });
                                  }}
                                >
                                  <option value={1}>1 个</option>
                                  <option value={2}>2 个</option>
                                  <option value={3}>3 个</option>
                                </select>
                              </label>
                              <label className="supervisor-dialog__thread-role">
                                <span>主线程职责 <span className="supervisor-dialog__required" aria-hidden="true">*</span></span>
                                <textarea
                                  className="supervisor-dialog__textarea"
                                  aria-label={`${candidate.label} 的主线程职责`}
                                  rows={2}
                                  maxLength={MAX_TASK_THREAD_RESPONSIBILITY_LENGTH}
                                  value={normalizeTaskThreadResponsibility(laneConfig.mainThreadResponsibility)}
                                  onChange={(event) => updateLaneConfig(candidate.surfaceId, {
                                    mainThreadResponsibility: event.target.value,
                                  })}
                                  placeholder="例如：统筹任务、整合子线程结果、执行最终验证"
                                />
                              </label>
                              {childThreadResponsibilities.map((responsibility, index) => (
                                <label key={index} className="supervisor-dialog__thread-role">
                                  <span>子线程 {index + 1} 职责 <span className="supervisor-dialog__required" aria-hidden="true">*</span></span>
                                  <textarea
                                    className="supervisor-dialog__textarea"
                                    aria-label={`${candidate.label} 的子线程 ${index + 1} 职责`}
                                    rows={2}
                                    maxLength={MAX_TASK_THREAD_RESPONSIBILITY_LENGTH}
                                    value={responsibility}
                                    onChange={(event) => {
                                      const nextResponsibilities = [...childThreadResponsibilities];
                                      nextResponsibilities[index] = event.target.value;
                                      updateLaneConfig(candidate.surfaceId, {
                                        childThreadResponsibilities: nextResponsibilities,
                                      });
                                    }}
                                    placeholder={`例如：负责${index === 0 ? '代码实现' : index === 1 ? '测试与验证' : '独立审查与风险检查'}`}
                                  />
                                </label>
                              ))}
                              <div className="supervisor-dialog__hint">
                                保存后立即更新对应监督 AI，从下一次裁决开始传达；不会打断任务终端当前工作。
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="supervisor-dialog__section">
                          <div className="supervisor-dialog__label">停止条件类型</div>
                          <div className="supervisor-dialog__freedom">
                            {(['concrete', 'direction'] as StopWhenKind[]).map((kind) => (
                              <label key={kind} className="supervisor-dialog__radio" data-active={laneConfig.stopWhenKind === kind}>
                                <input
                                  type="radio"
                                  name={`stopWhenKind-${candidate.surfaceId}`}
                                  checked={laneConfig.stopWhenKind === kind}
                                  onChange={() => updateLaneConfig(candidate.surfaceId, { stopWhenKind: kind })}
                                />
                                <span>{stopWhenKindLabel(kind)}{kind === 'concrete' ? ' — 可核对事实' : ' — 期望终态/方向'}</span>
                              </label>
                            ))}
                          </div>
                          <div className="supervisor-dialog__hint">{stopWhenKindHint(laneConfig.stopWhenKind)}</div>
                        </div>
                        <div className="supervisor-dialog__section">
                          <div className="supervisor-dialog__label supervisor-dialog__label--required">
                            停止条件 <span className="supervisor-dialog__required" aria-hidden="true">*</span>
                          </div>
                          <textarea
                            className="supervisor-dialog__textarea"
                            aria-label={`${candidate.label} 的停止条件`}
                            rows={2}
                            value={laneConfig.stopWhen}
                            onChange={(event) => updateLaneConfig(candidate.surfaceId, { stopWhen: event.target.value })}
                            placeholder={laneConfig.stopWhenKind === 'direction'
                              ? '例如：此终端负责的登录流程可用，错误提示合理'
                              : '例如：认证模块单测全部通过'}
                          />
                          <div className="supervisor-dialog__hint">只用于此终端的继续、返工、完成或人工接管裁决。</div>
                        </div>
                        <div className="supervisor-dialog__section">
                          <div className="supervisor-dialog__label">停止条件补充说明（可选）</div>
                          <textarea
                            className="supervisor-dialog__textarea"
                            aria-label={`${candidate.label} 的停止条件补充说明`}
                            rows={2}
                            value={laneConfig.taskDescription}
                            onChange={(event) => updateLaneConfig(candidate.surfaceId, { taskDescription: event.target.value })}
                            placeholder="补充此终端的验收语境和边界"
                          />
                        </div>
                        <div className="supervisor-dialog__section">
                          <div className="supervisor-dialog__label">计划文件（可选 · Markdown/文本）</div>
                          <div className="supervisor-dialog__plan-actions">
                            <input
                              className="supervisor-dialog__input"
                              aria-label={`${candidate.label} 的计划文件`}
                              value={laneConfig.planFilePath}
                              readOnly
                              title={laneConfig.planFilePath}
                              placeholder="未选择；仅提供给此终端的监督 AI"
                            />
                            <button type="button" className="confirm-dialog__btn" onClick={() => void choosePlanFile(candidate.surfaceId)}>
                              选择文件
                            </button>
                            {laneConfig.planFilePath && (
                              <button
                                type="button"
                                className="confirm-dialog__btn"
                                onClick={() => updateLaneConfig(candidate.surfaceId, { planFilePath: '' })}
                              >
                                清除
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="supervisor-dialog__section">
                          <div className="supervisor-dialog__label">前置条件 / 已确认环境信息（可选）</div>
                          <textarea
                            className="supervisor-dialog__textarea"
                            aria-label={`${candidate.label} 的前置条件`}
                            rows={2}
                            value={laneConfig.preconditions}
                            onChange={(event) => updateLaneConfig(candidate.surfaceId, { preconditions: event.target.value })}
                            placeholder="例如：此终端对应的测试环境已准备好"
                          />
                        </div>
                        <div className="supervisor-dialog__section">
                          <label className="supervisor-dialog__row">
                            <input
                              type="checkbox"
                              checked={lanePolicyOverride}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                setLanePermissionOverrides((current) => {
                                  if (checked) return { ...current, [candidate.surfaceId]: [...autonomyPermissions] };
                                  const next = { ...current };
                                  delete next[candidate.surfaceId];
                                  return next;
                                });
                                setLaneAutonomousOverrides((current) => {
                                  if (checked) return { ...current, [candidate.surfaceId]: autonomous };
                                  const next = { ...current };
                                  delete next[candidate.surfaceId];
                                  return next;
                                });
                                setLaneForbiddenActionOverrides((current) => {
                                  if (checked) return { ...current, [candidate.surfaceId]: [...forbiddenActions] };
                                  const next = { ...current };
                                  delete next[candidate.surfaceId];
                                  return next;
                                });
                              }}
                            />
                            <span className="supervisor-dialog__row-main">
                              <span className="supervisor-dialog__row-label">为此终端单独设置监督权限</span>
                              <span className="supervisor-dialog__row-meta">可覆盖全自动、允许自主处理和禁止事项；关闭时继承会话默认。</span>
                            </span>
                          </label>
                          {lanePolicyOverride && Array.isArray(lanePermissionOverride) && (
                            <div className="supervisor-dialog__option-list">
                              <label className="supervisor-dialog__option">
                                <input
                                  type="checkbox"
                                  checked={laneAutonomous}
                                  onChange={(event) => setLaneAutonomousOverrides((current) => ({
                                    ...current,
                                    [candidate.surfaceId]: event.target.checked,
                                  }))}
                                />
                                <span>全自动监督（仅此终端）</span>
                              </label>
                              <div className="supervisor-dialog__label">允许自主处理</div>
                              {SUPERVISOR_AUTONOMY_PERMISSION_VALUES.map((permission) => (
                                <label key={permission} className="supervisor-dialog__option">
                                  <input
                                    type="checkbox"
                                    checked={lanePermissionOverride.includes(permission)}
                                    onChange={() => setLanePermissionOverrides((current) => {
                                      const selectedPermissions = current[candidate.surfaceId] || [];
                                      return {
                                        ...current,
                                        [candidate.surfaceId]: selectedPermissions.includes(permission)
                                          ? selectedPermissions.filter((item) => item !== permission)
                                          : [...selectedPermissions, permission],
                                      };
                                    })}
                                  />
                                  <span>{AUTONOMY_PERMISSION_LABELS[permission]}</span>
                                </label>
                              ))}
                              <div className="supervisor-dialog__label">此终端额外禁止事项</div>
                              {SUPERVISOR_FORBIDDEN_ACTION_VALUES.map((action) => (
                                <label key={action} className="supervisor-dialog__option">
                                  <input
                                    type="checkbox"
                                    checked={laneForbiddenActions.includes(action)}
                                    onChange={() => setLaneForbiddenActionOverrides((current) => {
                                      const selectedActions = current[candidate.surfaceId] || [];
                                      return {
                                        ...current,
                                        [candidate.surfaceId]: selectedActions.includes(action)
                                          ? selectedActions.filter((item) => item !== action)
                                          : [...selectedActions, action],
                                      };
                                    })}
                                  />
                                  <span>{FORBIDDEN_ACTION_LABELS[action]}</span>
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
            {insufficientCandidates.length > 0 && (
              <div className="supervisor-dialog__warning" role="status">
                {insufficientCandidates.map((candidate) => candidate.label).join('、')}：可停止裁决，但自主推进依据不足。请为对应终端填写任务目标或选择计划文件。
              </div>
            )}
          </section>

          <section className="supervisor-dialog__group">
            <div className="supervisor-dialog__group-title">2. 会话默认的自主权限与边界</div>
            <div className="supervisor-dialog__group-description">所有终端默认使用这些权限；在终端配置中可单独覆盖全自动、允许自主处理和禁止事项。</div>
            <label className="supervisor-dialog__row supervisor-dialog__autonomous-row">
              <input
                type="checkbox"
                checked={autonomous}
                onChange={(event) => setAutonomous(event.target.checked)}
              />
              <span className="supervisor-dialog__row-main">
                <span className="supervisor-dialog__row-label">全自动监督（仅本次会话）</span>
                <span className="supervisor-dialog__row-meta">
                  开启后在下列权限和安全边界内持续自主推进，不受自动判断次数上限。
                </span>
              </span>
            </label>
            <div className="supervisor-dialog__grid">
              <section className="supervisor-dialog__section">
                <div className="supervisor-dialog__label">允许自主处理</div>
                <div className="supervisor-dialog__option-list">
                  {SUPERVISOR_AUTONOMY_PERMISSION_VALUES.map((permission) => (
                    <label key={permission} className="supervisor-dialog__option">
                      <input
                        type="checkbox"
                        checked={autonomyPermissions.includes(permission)}
                        onChange={() => toggleAutonomyPermission(permission)}
                      />
                      <span>{AUTONOMY_PERMISSION_LABELS[permission]}</span>
                    </label>
                  ))}
                </div>
                {selectedCandidates.some((candidate) => candidate.remoteSshControl) && (
                  <div className="supervisor-dialog__hint">
                    SSH 远程控制终端会忽略“低风险权限确认”；删除/覆盖、发送中断信号、安装升级、服务进程及系统操作始终转人工。
                  </div>
                )}
              </section>
              <section className="supervisor-dialog__section">
                <div className="supervisor-dialog__label">工作范围</div>
                <div className="supervisor-dialog__option-list">
                  {SUPERVISOR_WORK_SCOPE_VALUES.map((scope) => {
                    const disabled = scope === 'plan-defined' && (
                      selectedCandidates.length === 0
                      || selectedCandidates.some((candidate) => !laneConfigs[candidate.surfaceId]?.planFilePath.trim())
                    );
                    return (
                      <label
                        key={scope}
                        className="supervisor-dialog__radio"
                        data-active={workScope === scope}
                        data-disabled={disabled}
                      >
                        <input
                          type="radio"
                          name="workScope"
                          checked={workScope === scope}
                          disabled={disabled}
                          onChange={() => setWorkScope(scope)}
                        />
                        <span>{WORK_SCOPE_LABELS[scope]}</span>
                      </label>
                    );
                  })}
                </div>
              </section>
            </div>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">本次额外禁止事项</div>
              <div className="supervisor-dialog__option-list supervisor-dialog__option-list--two-columns">
                {SUPERVISOR_FORBIDDEN_ACTION_VALUES.map((action) => (
                  <label key={action} className="supervisor-dialog__option">
                    <input
                      type="checkbox"
                      checked={forbiddenActions.includes(action)}
                      onChange={() => toggleForbiddenAction(action)}
                    />
                    <span>{FORBIDDEN_ACTION_LABELS[action]}</span>
                  </label>
                ))}
              </div>
            </section>
            <div className="supervisor-dialog__hard-risk">
              删除或覆盖重要数据、Git 推送或重写历史、发布部署、生产或云端变更、凭据及系统权限等硬风险始终交给人工，不能在这里授权绕过。
            </div>
            <section className="supervisor-dialog__section supervisor-dialog__decision-limit">
              <div className="supervisor-dialog__label">最大自动判断次数</div>
              <input
                className="supervisor-dialog__input"
                type="number"
                min={1}
                max={20}
                step={1}
                placeholder="不限制"
                value={maxAutoDecisions}
                onChange={(event) => setMaxAutoDecisions(event.target.value)}
              />
              <div className="supervisor-dialog__hint">
                {autonomous
                  ? '会话默认为全自动，但单独关闭全自动的终端仍使用此上限。'
                  : '每个终端独立计数；留空表示不限制，填写 1–20 后达到上限会等待人工审阅。'}
              </div>
            </section>
          </section>

          <details className="supervisor-dialog__advanced">
            <summary>3. 会话高级设置</summary>
            <div className="supervisor-dialog__advanced-content">
              <section className="supervisor-dialog__section">
                <div className="supervisor-dialog__label">监督 AI 启动器</div>
                <div className="supervisor-dialog__default-agent-row">
                  <select
                    className="supervisor-dialog__input"
                    value={launchChoice}
                    disabled={sessionRetained}
                    onChange={(event) => changeLauncher(event.target.value)}
                  >
                    {SUPERVISOR_LAUNCH_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}{selectedDefaultAgent === option.value && defaultSupervisorAgent === selectedDefaultAgent ? '（当前默认）' : ''}
                      </option>
                    ))}
                    <option value={CUSTOM_OPTION}>自定义命令</option>
                  </select>
                  <button
                    type="button"
                    className="confirm-dialog__btn"
                    disabled={sessionRetained || !selectedDefaultAgent || selectedDefaultAgent === defaultSupervisorAgent}
                    onClick={() => {
                      if (selectedDefaultAgent) setWorkspacePrefs({ defaultSupervisorAgent: selectedDefaultAgent });
                    }}
                    title={selectedDefaultAgent ? '将当前 Agent 用作以后新建 AI 监督的默认选择' : '自定义命令不能保存为默认 Agent'}
                  >
                    {selectedDefaultAgent === defaultSupervisorAgent ? '已为默认' : '设为默认'}
                  </button>
                </div>
                {launchChoice === CUSTOM_OPTION && (
                  <input
                    className="supervisor-dialog__input supervisor-dialog__stacked-input"
                    value={launchCmd}
                    disabled={sessionRetained}
                    onChange={(event) => setLaunchCmd(event.target.value)}
                    placeholder="例如：&quot;C:\\Tools\\codex.exe&quot;"
                  />
                )}
                <div className="supervisor-dialog__hint">
                  {sessionRetained
                    ? '现有管理会话会被保留；启动器、模型和 Thinking 需在停止监督并启动新会话后更改。'
                    : '每个工作终端独立启动一个监督上下文；默认设置仅影响以后新建的监督。'}
                </div>
              </section>
              {(launcherModelOptions.length > 0 || launcherKind === 'pi') && (
                <section className="supervisor-dialog__section">
                  <div className="supervisor-dialog__label">{supervisorLauncherDisplayName(launcherKind)} 监督模型</div>
                  <div className="supervisor-dialog__default-agent-row">
                    <select
                      className="supervisor-dialog__input"
                      value={modelChoice}
                      disabled={sessionRetained}
                      onChange={(event) => {
                        const choice = event.target.value;
                        setModelChoice(choice);
                        if (choice === DEFAULT_MODEL_OPTION) setSupervisorModel('');
                        else if (choice !== CUSTOM_OPTION) setSupervisorModel(choice);
                      }}
                    >
                      <option value={DEFAULT_MODEL_OPTION}>
                        使用 {supervisorLauncherDisplayName(launcherKind)} 默认模型
                        {selectedAgentDefaults?.supervisorModel === '' ? '（当前默认）' : ''}
                      </option>
                      {launcherModelOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}{selectedAgentDefaults?.supervisorModel === option.value ? '（当前默认）' : ''}
                        </option>
                      ))}
                      <option value={CUSTOM_OPTION}>
                        {customModelOptionLabel(launcherKind)}
                        {selectedAgentDefaults
                          && modelChoiceFor(launcherKind, selectedAgentDefaults.supervisorModel) === CUSTOM_OPTION
                          ? '（当前默认）'
                          : ''}
                      </option>
                    </select>
                    <button
                      type="button"
                      className="confirm-dialog__btn"
                      disabled={sessionRetained || !selectedDefaultAgent || modelIsDefault}
                      onClick={saveCurrentModelAsDefault}
                      title="将当前模型用作此监督 Agent 以后新建会话的默认选择"
                    >
                      {modelIsDefault ? '已为默认' : '设为默认'}
                    </button>
                  </div>
                  {modelChoice === CUSTOM_OPTION && (
                    <input
                      className="supervisor-dialog__input supervisor-dialog__stacked-input"
                      value={supervisorModel}
                      disabled={sessionRetained}
                      onChange={(event) => setSupervisorModel(event.target.value)}
                      placeholder={customModelPlaceholder(launcherKind)}
                    />
                  )}
                </section>
              )}
              {launcherKind === 'codex' && (
                <section className="supervisor-dialog__section">
                  <div className="supervisor-dialog__label">Codex 推理程度</div>
                  <div className="supervisor-dialog__default-agent-row">
                    <select
                      className="supervisor-dialog__input"
                      value={reasoningEffort}
                      disabled={sessionRetained}
                      onChange={(event) => setReasoningEffort(event.target.value)}
                    >
                      <option value="">
                        使用 Codex 默认推理程度
                        {selectedAgentDefaults?.supervisorReasoningEffort === '' ? '（当前默认）' : ''}
                      </option>
                      {REASONING_EFFORT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}{selectedAgentDefaults?.supervisorReasoningEffort === option.value ? '（当前默认）' : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="confirm-dialog__btn"
                      disabled={sessionRetained || !selectedDefaultAgent || reasoningIsDefault}
                      onClick={saveCurrentReasoningAsDefault}
                      title="将当前推理程度用作 Codex 以后新建监督会话的默认选择"
                    >
                      {reasoningIsDefault ? '已为默认' : '设为默认'}
                    </button>
                  </div>
                </section>
              )}
              {launcherKind === 'kimi' && (
                <section className="supervisor-dialog__section">
                  <div className="supervisor-dialog__label">Kimi Thinking</div>
                  <div className="supervisor-dialog__default-agent-row">
                    <select
                      className="supervisor-dialog__input"
                      value={reasoningEffort}
                      disabled={sessionRetained}
                      onChange={(event) => setReasoningEffort(event.target.value)}
                    >
                      {KIMI_THINKING_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}{selectedAgentDefaults?.supervisorReasoningEffort === option.value ? '（当前默认）' : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="confirm-dialog__btn"
                      disabled={sessionRetained || !selectedDefaultAgent || reasoningIsDefault}
                      onClick={saveCurrentReasoningAsDefault}
                      title="将当前 Thinking 设置用作 Kimi 以后新建监督会话的默认选择"
                    >
                      {reasoningIsDefault ? '已为默认' : '设为默认'}
                    </button>
                  </div>
                </section>
              )}
              {launcherKind === 'pi' && (
                <section className="supervisor-dialog__section">
                  <div className="supervisor-dialog__label">Pi Thinking</div>
                  <div className="supervisor-dialog__default-agent-row">
                    <select
                      className="supervisor-dialog__input"
                      value={reasoningEffort}
                      disabled={sessionRetained}
                      onChange={(event) => setReasoningEffort(event.target.value)}
                    >
                      <option value="">
                        使用 Pi 默认 Thinking 设置
                        {selectedAgentDefaults?.supervisorReasoningEffort === '' ? '（当前默认）' : ''}
                      </option>
                      {PI_THINKING_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}{selectedAgentDefaults?.supervisorReasoningEffort === option.value ? '（当前默认）' : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="confirm-dialog__btn"
                      disabled={sessionRetained || !selectedDefaultAgent || reasoningIsDefault}
                      onClick={saveCurrentReasoningAsDefault}
                      title="将当前 Thinking 设置用作 Pi 以后新建监督会话的默认选择"
                    >
                      {reasoningIsDefault ? '已为默认' : '设为默认'}
                    </button>
                  </div>
                </section>
              )}
              {launcherKind === 'grok' && (
                <section className="supervisor-dialog__section">
                  <div className="supervisor-dialog__label">Grok Build 推理设置</div>
                  <div className="supervisor-dialog__hint">推理强度由会话内 `/effort` 设置，不传入其他启动器的参数。</div>
                </section>
              )}

              <section className="supervisor-dialog__section supervisor-dialog__advanced-divider">
                <label className="supervisor-dialog__row">
                  <input
                    type="checkbox"
                    checked={restoreAuditHistory}
                    onChange={(event) => setRestoreAuditHistory(event.target.checked)}
                  />
                  <span className="supervisor-dialog__row-main">
                    <span className="supervisor-dialog__row-label">恢复审计上下文（手动选择来源）</span>
                    <span className="supervisor-dialog__row-meta">默认关闭；只恢复任务、终端事件和监督裁决摘要。</span>
                  </span>
                </label>
                {restoreAuditHistory && selectedCandidates.map((candidate) => {
                  const options = restoreCandidates[candidate.surfaceId] || [];
                  return (
                    <div key={candidate.surfaceId} className="supervisor-dialog__restore-row">
                      <div className="supervisor-dialog__row-label">恢复到：{candidate.label}</div>
                      <select
                        className="supervisor-dialog__input"
                        value={restoreSources[candidate.surfaceId] || ''}
                        onChange={(event) => setRestoreSources((current) => ({
                          ...current,
                          [candidate.surfaceId]: event.target.value,
                        }))}
                      >
                        <option value="">不恢复上下文</option>
                        {options.map((option) => (
                          <option key={option.surfaceId} value={option.surfaceId}>
                            {option.label} · {new Date(option.lastEventAt).toLocaleString('zh-CN', { hour12: false })}
                            {option.currentTask ? ` · ${option.currentTask.slice(0, 36)}` : ''}
                            {option.lastDecision ? ` · ${option.lastDecision}` : ''}
                          </option>
                        ))}
                      </select>
                      {options.length === 0 && (
                        <div className="supervisor-dialog__hint">此项目没有可恢复的历史终端。</div>
                      )}
                    </div>
                  );
                })}
              </section>

              <section className="supervisor-dialog__section supervisor-dialog__advanced-divider">
                <div className="supervisor-dialog__label">配置文件</div>
                <div className="supervisor-dialog__config-actions">
                  <button type="button" className="confirm-dialog__btn" onClick={() => void loadConfigFile()}>
                    导入到已选终端…
                  </button>
                  <button type="button" className="confirm-dialog__btn" onClick={() => void saveConfigFile()}>
                    导出单个终端配置…
                  </button>
                </div>
                <div className="supervisor-dialog__hint">导入会把任务字段复制到当前已选终端，之后仍分别保存；导出时请只选择一个终端。</div>
              </section>

              <section className="supervisor-dialog__section supervisor-dialog__advanced-divider">
                <button
                  type="button"
                  className="confirm-dialog__btn supervisor-dialog__btn-ai"
                  onClick={openAiSession}
                  disabled={sessionRetained}
                >
                  仅打开监督终端（不启动）
                </button>
                <div className="supervisor-dialog__hint">用于预览专属监督上下文；不会开始调度或监听任务事件。</div>
              </section>
            </div>
          </details>
        </div>

        {dialogNotice && (
          <div
            className="supervisor-dialog__notice"
            data-kind={dialogNotice.kind}
            role={dialogNotice.kind === 'error' ? 'alert' : 'status'}
          >
            {dialogNotice.message}
          </div>
        )}

        <div className="supervisor-dialog__actions">
          {sessionRetained && (
            <button
              type="button"
              className="confirm-dialog__btn"
              onClick={() => {
                setAutonomous(false);
                stopSupervisor();
              }}
            >
              停止监督
            </button>
          )}
          <span className="supervisor-dialog__actions-spacer" />
          <button type="button" className="confirm-dialog__btn" onClick={closeSupervisorSetup}>
            取消
          </button>
          <button
            type="button"
            className="confirm-dialog__btn"
            onClick={() => applyConfig(false)}
            disabled={sessionRetained}
            title={sessionRetained ? '当前会话仍在保留；请先继续或停止该会话。' : undefined}
          >
            保存设置
          </button>
          <button
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--danger"
            onClick={() => applyConfig(true)}
          >
            {primaryActionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
