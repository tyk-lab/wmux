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
  isProjectManagedSupervisorLane,
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
  buildSupervisorGoalConstructionBriefing,
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
  planSupervisorTerminalConfigImport,
  supervisorWaitingConfigAction,
} from '../../supervisor/config-file';
import {
  buildSupervisorLaunchCommand,
  detectSupervisorLauncher,
  supervisorLauncherDisplayName,
  type SupervisorLauncherKind,
} from '../../supervisor/launch-command';
import {
  addCustomSupervisorModel,
  hiddenBuiltinModelOptions,
  modelOptionsFor,
  removeSupervisorModel,
  restoreBuiltinSupervisorModel,
  supervisorModelCatalogScope,
  type SupervisorModelCatalog,
} from '../../supervisor/model-catalog';
import { sendToSurface, SUPERVISOR_TUI_READY_DELAY_MS } from '../../supervisor/supervisor-engine';
import { readTerminalScreen } from '../../pipe-bridge';
import {
  markTerminalRuntimeFailed,
  waitForTerminalRuntimeReady,
} from '../../terminal-runtime-lifecycle';
import {
  interactiveAgentInputReady,
  interactiveAgentShellPromptFailureDetail,
} from '../../utils/interactive-agent-runtime';
import { createLeaf, getAllPaneIds } from '../../store/split-utils';
import '../../styles/supervisor.css';

const SUPERVISOR_LAUNCH_OPTIONS = [
  { value: 'pi', label: 'Pi Agent（推荐）' },
  { value: 'codex', label: 'Codex' },
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
const PI_THINKING_OPTIONS = [
  { value: 'medium', label: '中（均衡）' },
  { value: 'low', label: '低（更快）' },
  { value: 'high', label: '高（更深入）' },
  { value: 'xhigh', label: '超高' },
  { value: 'max', label: '最大' },
  { value: 'minimal', label: '最小' },
  { value: 'off', label: '关闭' },
];
const GROK_THINKING_OPTIONS = [
  { value: '', label: '使用 Grok 默认 Thinking 设置' },
  { value: 'low', label: '低（更快）' },
  { value: 'medium', label: '中（均衡）' },
  { value: 'high', label: '高（更深入）' },
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

function modelChoiceFor(
  launcher: SupervisorLauncherKind,
  model: string,
  catalog?: SupervisorModelCatalog,
): string {
  const options = modelOptionsFor(launcher, catalog);
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

type TerminalConfigSection = 'basic' | 'execution' | 'context' | 'supervision';

const TERMINAL_CONFIG_SECTIONS: Array<{
  id: TerminalConfigSection;
  label: string;
}> = [
  { id: 'basic', label: '基础配置' },
  { id: 'execution', label: '执行方式' },
  { id: 'context', label: '上下文与资料' },
  { id: 'supervision', label: '监督与权限' },
];

function emptyLaneConfig(): SupervisorLaneConfig {
  return {
    taskGoal: '',
    taskDescription: '',
    preconditions: '',
    supervisorNotes: '',
    stopWhen: '',
    stopWhenKind: 'concrete',
    waitForNextDirection: true,
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
  out: Array<{
    surfaceId: SurfaceId;
    paneId: PaneId;
    title: string;
    projectDir?: string;
    projectManagerTerminal?: boolean;
    projectManagerProjectId?: string;
    projectManagerWorkItemId?: string;
  }>,
): void {
  if (tree.type === 'leaf') {
    for (const s of tree.surfaces) {
      if (s.type === 'terminal') {
        out.push({
          surfaceId: s.id,
          paneId: tree.paneId,
          title: s.customTitle?.trim() || s.shell || 'terminal',
          projectDir: s.currentCwd || s.cwd,
          projectManagerTerminal: s.projectManagerTerminal,
          projectManagerProjectId: s.projectManagerProjectId,
          projectManagerWorkItemId: s.projectManagerWorkItemId,
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
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const agentMeta = useStore((s) => s.agentMeta);
  const closeSupervisorSetup = useStore((s) => s.closeSupervisorSetup);
  const patchSupervisor = useStore((s) => s.patchSupervisor);
  const setOrdinarySupervisorLanes = useStore((s) => s.setOrdinarySupervisorLanes);
  const startOrdinarySupervisor = useStore((s) => s.startOrdinarySupervisor);
  const defaultSupervisorAgent = useStore((s) => s.workspacePrefs.defaultSupervisorAgent);
  const defaultSupervisorModels = useStore((s) => s.workspacePrefs.defaultSupervisorModels);
  const defaultSupervisorReasoningEfforts = useStore(
    (s) => s.workspacePrefs.defaultSupervisorReasoningEfforts,
  );
  const supervisorModelCatalogs = useStore((s) => s.workspacePrefs.supervisorModelCatalogs);
  const setWorkspacePrefs = useStore((s) => s.setWorkspacePrefs);
  const stopOrdinarySupervisor = useStore((s) => s.stopOrdinarySupervisor);
  const addSurface = useStore((s) => s.addSurface);
  const closeSurface = useStore((s) => s.closeSurface);
  const createWorkspace = useStore((s) => s.createWorkspace);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocusedFieldRef = useRef<HTMLElement | null>(null);
  const modelValidationRequestRef = useRef(0);
  const modelDiscoveryRequestRef = useRef(0);
  const ordinarySupervisorLanes = useMemo(
    () => supervisor.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane)),
    [supervisor.lanes],
  );
  const sessionRetained = ordinarySupervisorLanes.some(isSupervisorLaneBound);
  const ordinaryActive = ordinarySupervisorLanes.some((lane) => {
    const state = supervisorLaneControlState(lane);
    return state === 'active' || state === 'waiting';
  });
  const ordinaryPaused = ordinarySupervisorLanes.some(
    (lane) => supervisorLaneControlState(lane) === 'paused',
  );
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  const modelCatalogScope = supervisorModelCatalogScope(activeWorkspace?.cwd, activeWorkspaceId || undefined);
  const modelCatalog = supervisorModelCatalogs[modelCatalogScope] || {};
  let primaryActionLabel = '启动 AI 监督';
  const [creationMode, setCreationMode] = useState<'direct' | 'terminal'>('direct');
  if (ordinaryActive) primaryActionLabel = '应用并继续普通监督';
  else if (ordinaryPaused) primaryActionLabel = '应用并返回普通监督会话';
  else if (creationMode === 'terminal') primaryActionLabel = '基于终端创建监督 AI';

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
      const surfaces: Array<{
        surfaceId: SurfaceId;
        paneId: PaneId;
        title: string;
        projectDir?: string;
        projectManagerTerminal?: boolean;
        projectManagerProjectId?: string;
        projectManagerWorkItemId?: string;
      }> = [];
      collectTerminals(ws.splitTree, surfaces);
      for (const s of surfaces) {
        if (s.projectManagerTerminal) continue;
        if (s.projectManagerProjectId || s.projectManagerWorkItemId) continue;
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
  const [setupSection, setSetupSection] = useState<'targets' | 'permissions' | 'agent'>('targets');
  const [terminalConfigExpansion, setTerminalConfigExpansion] = useState<Record<string, boolean>>({});
  const [terminalConfigSections, setTerminalConfigSections] = useState<Record<string, TerminalConfigSection>>({});
  const [dirtyTerminalConfigIds, setDirtyTerminalConfigIds] = useState<Set<string>>(new Set());
  const [dialogNotice, setDialogNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [laneConfigs, setLaneConfigs] = useState<Record<string, SupervisorLaneConfig>>({});
  const [lanePermissionOverrides, setLanePermissionOverrides] = useState<
    Record<string, SupervisorAutonomyPermission[]>
  >({});
  const [restoreEnabled, setRestoreEnabled] = useState<Set<string>>(new Set());
  const [restoreCandidates, setRestoreCandidates] = useState<Record<string, SupervisorRestoreCandidate[]>>({});
  const [restoreCandidatesLoaded, setRestoreCandidatesLoaded] = useState<Set<string>>(new Set());
  const [restoreSources, setRestoreSources] = useState<Record<string, string>>({});
  const [launchCmd, setLaunchCmd] = useState(supervisor.supervisorLaunchCmd);
  const [supervisorModel, setSupervisorModel] = useState(supervisor.supervisorModel || '');
  const [launchChoice, setLaunchChoice] = useState(
    knownOptionValue(supervisor.supervisorLaunchCmd, SUPERVISOR_LAUNCH_OPTIONS),
  );
  const [modelChoice, setModelChoice] = useState(
    modelChoiceFor(
      detectSupervisorLauncher(supervisor.supervisorLaunchCmd),
      supervisor.supervisorModel,
      modelCatalog,
    ),
  );
  const [modelManagerOpen, setModelManagerOpen] = useState(false);
  const [newModelId, setNewModelId] = useState('');
  const [modelValidation, setModelValidation] = useState<{
    state: 'idle' | 'validating' | 'success' | 'error';
    model: string;
    message: string;
  }>({ state: 'idle', model: '', message: '' });
  const [modelDiscovery, setModelDiscovery] = useState<{
    state: 'idle' | 'loading' | 'success' | 'error';
    models: string[];
    source: string;
    limited: boolean;
    message: string;
  }>({ state: 'idle', models: [], source: '', limited: false, message: '' });
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
    if (!sessionRetained) setCreationMode('direct');
    setSetupSection('targets');
    setDialogNotice(null);
    setRestoreEnabled(new Set(
      ordinarySupervisorLanes.flatMap((lane) => lane.restoreSource ? [lane.surfaceId] : []),
    ));
    setRestoreSources(Object.fromEntries(
      ordinarySupervisorLanes.flatMap((lane) => lane.restoreSource ? [[lane.surfaceId, lane.restoreSource.surfaceId]] : []),
    ));
    setLaunchCmd(supervisor.supervisorLaunchCmd || '');
    setSupervisorModel(supervisor.supervisorModel || '');
    setLaunchChoice(knownOptionValue(supervisor.supervisorLaunchCmd, SUPERVISOR_LAUNCH_OPTIONS));
    setModelChoice(modelChoiceFor(
      detectSupervisorLauncher(supervisor.supervisorLaunchCmd),
      supervisor.supervisorModel,
      modelCatalog,
    ));
    setModelManagerOpen(false);
    setNewModelId('');
    modelValidationRequestRef.current += 1;
    modelDiscoveryRequestRef.current += 1;
    setModelValidation({ state: 'idle', model: '', message: '' });
    setModelDiscovery({ state: 'idle', models: [], source: '', limited: false, message: '' });
    setReasoningEffort(supervisor.supervisorReasoningEffort || '');
    setMaxAutoDecisions(supervisor.maxAutoDecisions ? String(supervisor.maxAutoDecisions) : '');
    setAutonomous(supervisor.autonomous === true);
    setAutonomyPermissions(normalizeSupervisorAutonomyPermissions(supervisor.autonomyPermissions));
    setWorkScope(normalizeSupervisorWorkScope(supervisor.workScope));
    setForbiddenActions(normalizeSupervisorForbiddenActions(supervisor.forbiddenActions));
    const boundSurfaceIds = ordinarySupervisorLanes.filter(isSupervisorLaneBound).map((lane) => lane.surfaceId);
    setSelected(new Set(boundSurfaceIds));
    setTerminalConfigExpansion({});
    setTerminalConfigSections({});
    setDirtyTerminalConfigIds(new Set());
    setLaneConfigs(Object.fromEntries(
      ordinarySupervisorLanes.map((lane) => [lane.surfaceId, effectiveSupervisorLaneConfig(lane)]),
    ));
    setLanePermissionOverrides(Object.fromEntries(
      ordinarySupervisorLanes.flatMap((lane) => Array.isArray(lane.autonomyPermissionsOverride)
        ? [[lane.surfaceId, [...lane.autonomyPermissionsOverride]]]
        : []),
    ));
    setLaneAutonomousOverrides(Object.fromEntries(
      ordinarySupervisorLanes.flatMap((lane) => typeof lane.autonomousOverride === 'boolean'
        ? [[lane.surfaceId, lane.autonomousOverride]]
        : []),
    ));
    setLaneForbiddenActionOverrides(Object.fromEntries(
      ordinarySupervisorLanes.flatMap((lane) => Array.isArray(lane.forbiddenActionsOverride)
        ? [[lane.surfaceId, [...lane.forbiddenActionsOverride]]]
        : []),
    ));
  }, [setupOpen]);

  useEffect(() => {
    if (!setupOpen) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const expandedSurfaceId = Object.entries(terminalConfigExpansion).find(([, expanded]) => expanded)?.[0];
      if (expandedSurfaceId) {
        event.preventDefault();
        event.stopPropagation();
        setTerminalConfigExpansion((current) => ({ ...current, [expandedSurfaceId]: false }));
        return;
      }
      closeSupervisorSetup();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [setupOpen, closeSupervisorSetup, terminalConfigExpansion]);

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
  const launcherModelOptions = modelOptionsFor(launcherKind, modelCatalog);
  const hiddenModelOptions = hiddenBuiltinModelOptions(launcherKind, modelCatalog);
  const modelValidationPending = modelValidation.state === 'validating';
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

  const saveModelCatalog = (nextCatalog: SupervisorModelCatalog) => {
    setWorkspacePrefs({
      supervisorModelCatalogs: {
        ...supervisorModelCatalogs,
        [modelCatalogScope]: nextCatalog,
      },
    });
  };

  const discoverModels = async () => {
    if (launcherKind === 'other') return;
    const requestId = ++modelDiscoveryRequestRef.current;
    setModelDiscovery({ state: 'loading', models: [], source: '', limited: false, message: '正在获取模型目录…' });
    try {
      const result = await window.wmux.supervisor.listModels({
        launcher: launcherKind,
        cwd: activeWorkspace?.cwd,
      });
      if (requestId !== modelDiscoveryRequestRef.current) return;
      if (!result?.ok || !Array.isArray(result.models) || result.models.length === 0) {
        setModelDiscovery({
          state: 'error', models: [], source: '', limited: false,
          message: result?.error || '没有获取到支持的模型。',
        });
        return;
      }
      setModelDiscovery({
        state: 'success',
        models: result.models,
        source: result.source || 'Agent 模型目录',
        limited: result.limited === true,
        message: '',
      });
      setNewModelId(result.models.find((model: string) => (
        !launcherModelOptions.some((option) => option.value === model)
      )) || result.models[0]);
    } catch (error: any) {
      if (requestId !== modelDiscoveryRequestRef.current) return;
      setModelDiscovery({
        state: 'error', models: [], source: '', limited: false,
        message: error?.message || '获取模型目录失败。',
      });
    }
  };

  const validateModel = async (model: string): Promise<boolean> => {
    if (launcherKind === 'other') {
      setModelValidation({ state: 'error', model, message: '该启动器暂不支持自动验证。' });
      return false;
    }
    const requestId = ++modelValidationRequestRef.current;
    const displayModel = model.trim() || `${supervisorLauncherDisplayName(launcherKind)} 默认模型`;
    setModelValidation({ state: 'validating', model, message: `正在验证 ${displayModel}…` });
    try {
      const result = await window.wmux.supervisor.validateModel({
        launcher: launcherKind,
        model: model.trim(),
        cwd: activeWorkspace?.cwd,
      });
      if (requestId !== modelValidationRequestRef.current) return false;
      if (result?.ok) {
        setModelValidation({ state: 'success', model, message: `${displayModel} 验证通过。` });
        return true;
      }
      setModelValidation({ state: 'error', model, message: result?.error || '模型验证失败。' });
      return false;
    } catch (error: any) {
      if (requestId !== modelValidationRequestRef.current) return false;
      setModelValidation({ state: 'error', model, message: error?.message || '模型验证失败。' });
      return false;
    }
  };

  const addModelDirectly = () => {
    const model = newModelId.trim();
    if (!model) {
      setModelValidation({ state: 'error', model: '', message: '请先填写模型 ID。' });
      return;
    }
    if (launcherKind === 'other') return;
    saveModelCatalog(addCustomSupervisorModel(modelCatalog, launcherKind, model));
    setNewModelId('');
    setSupervisorModel(model);
    setModelChoice(model);
    setModelValidation({ state: 'success', model, message: `${model} 已直接添加（未验证）。` });
  };

  const removeModel = (model: string) => {
    if (launcherKind === 'other') return;
    saveModelCatalog(removeSupervisorModel(modelCatalog, launcherKind, model));
    if (selectedDefaultAgent && defaultSupervisorModels[selectedDefaultAgent] === model) {
      setWorkspacePrefs({
        defaultSupervisorModels: { ...defaultSupervisorModels, [selectedDefaultAgent]: '' },
      });
    }
    if (!sessionRetained && supervisorModel === model) {
      setSupervisorModel('');
      setModelChoice(DEFAULT_MODEL_OPTION);
    }
    setModelValidation({ state: 'idle', model: '', message: '' });
  };

  const restoreModel = (model: string) => {
    if (launcherKind === 'other') return;
    saveModelCatalog(restoreBuiltinSupervisorModel(modelCatalog, launcherKind, model));
  };

  const changeLauncher = (choice: string) => {
    modelValidationRequestRef.current += 1;
    modelDiscoveryRequestRef.current += 1;
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
    setModelChoice(modelChoiceFor(nextLauncher, nextModel, modelCatalog));
    setReasoningEffort(nextDefaults?.supervisorReasoningEffort || '');
    setModelManagerOpen(false);
    setNewModelId('');
    setModelValidation({ state: 'idle', model: '', message: '' });
    setModelDiscovery({ state: 'idle', models: [], source: '', limited: false, message: '' });
  };

  useEffect(() => {
    if (!setupOpen) {
      setRestoreCandidates({});
      setRestoreCandidatesLoaded(new Set());
      return;
    }
    let cancelled = false;
    const selectedCandidates = candidates.filter((candidate) => selected.has(candidate.surfaceId));
    void Promise.all(selectedCandidates.map(async (candidate) => [
      candidate.surfaceId,
      candidate.projectDir ? await listSupervisorRestoreCandidates(candidate.projectDir) : [],
    ] as const)).then((entries) => {
      if (cancelled) return;
      setRestoreCandidates(Object.fromEntries(entries));
      setRestoreCandidatesLoaded(new Set(entries.map(([surfaceId]) => surfaceId)));
    });
    return () => { cancelled = true; };
  }, [setupOpen, selected, candidates]);

  useEffect(() => {
    setRestoreSources((current) => {
      const next = { ...current };
      let changed = false;
      for (const surfaceId of Object.keys(next)) {
        if (restoreEnabled.has(surfaceId)) continue;
        delete next[surfaceId];
        changed = true;
      }
      for (const surfaceId of restoreEnabled) {
        const options = restoreCandidates[surfaceId] || [];
        const currentStillExists = options.some((candidate) => candidate.surfaceId === next[surfaceId]);
        const latestSurfaceId = options[0]?.surfaceId;
        if (!currentStillExists && latestSurfaceId && next[surfaceId] !== latestSurfaceId) {
          next[surfaceId] = latestSurfaceId;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [restoreEnabled, restoreCandidates]);

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
        : { ...current, [surfaceId]: false });
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(surfaceId)) next.delete(surfaceId);
      else next.add(surfaceId);
      return next;
    });
  };

  const setTerminalConfigExpanded = (surfaceId: string, expanded: boolean) => {
    setTerminalConfigExpansion((current) => {
      if (!expanded) return current[surfaceId] === false ? current : { ...current, [surfaceId]: false };
      return Object.fromEntries([
        ...Object.keys(current).map((key) => [key, false] as const),
        [surfaceId, true] as const,
      ]);
    });
  };

  const markTerminalConfigDirty = (surfaceId: string) => {
    setDirtyTerminalConfigIds((current) => {
      if (current.has(surfaceId)) return current;
      const next = new Set(current);
      next.add(surfaceId);
      return next;
    });
  };

  const markTerminalConfigSaved = (surfaceId: string) => {
    setDirtyTerminalConfigIds((current) => {
      if (!current.has(surfaceId)) return current;
      const next = new Set(current);
      next.delete(surfaceId);
      return next;
    });
  };

  const showTerminalConfigSection = (
    surfaceId: string,
    section: TerminalConfigSection,
    fieldAriaLabel?: string,
  ) => {
    setSetupSection('targets');
    setTerminalConfigExpanded(surfaceId, true);
    setTerminalConfigSections((current) => ({ ...current, [surfaceId]: section }));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const drawer = Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-config-surface]'))
        .find((element) => element.dataset.terminalConfigSurface === surfaceId);
      if (!drawer) return;
      const field = fieldAriaLabel
        ? Array.from(drawer.querySelectorAll<HTMLElement>('[aria-label]'))
          .find((element) => element.getAttribute('aria-label') === fieldAriaLabel)
        : undefined;
      (field || drawer).focus({ preventScroll: false });
      (field || drawer).scrollIntoView({ block: 'nearest' });
    }));
  };

  const toggleRestoreContext = (surfaceId: string, enabled: boolean) => {
    setDialogNotice(null);
    markTerminalConfigDirty(surfaceId);
    setRestoreEnabled((current) => {
      const next = new Set(current);
      if (enabled) next.add(surfaceId);
      else next.delete(surfaceId);
      return next;
    });
  };

  const restoreSourceIdFor = (surfaceId: string): string => (
    restoreSources[surfaceId] || restoreCandidates[surfaceId]?.[0]?.surfaceId || ''
  );

  const selectRestoreSource = (surfaceId: string, restoreSurfaceId: string) => {
    setDialogNotice(null);
    markTerminalConfigDirty(surfaceId);
    setRestoreSources((current) => ({ ...current, [surfaceId]: restoreSurfaceId }));
  };

  const updateLaneConfig = (surfaceId: string, patch: Partial<SupervisorLaneConfig>) => {
    setDialogNotice(null);
    markTerminalConfigDirty(surfaceId);
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
    return {
      supervisorLaunchCmd: launchCmd,
      supervisorModel,
      supervisorReasoningEffort: reasoningEffort,
      maxAutoDecisions: normalizeMaxAutoDecisions(maxAutoDecisions),
      autonomyPermissions,
      workScope,
      forbiddenActions,
      terminals: candidates.filter((candidate) => selected.has(candidate.surfaceId)).map((candidate) => {
        const surfaceId = candidate.surfaceId;
        const previousLane = supervisor.lanes.find((lane) => lane.surfaceId === surfaceId);
        const laneConfig = laneConfigs[surfaceId]
          || (previousLane ? effectiveSupervisorLaneConfig(previousLane) : emptyLaneConfig());
        return {
          surfaceId,
          label: candidate.label,
          ...laneConfig,
          restoreTaskContext: restoreEnabled.has(surfaceId),
          ...(Array.isArray(lanePermissionOverrides[surfaceId])
            ? { autonomyPermissionsOverride: lanePermissionOverrides[surfaceId] }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(laneAutonomousOverrides, surfaceId)
            ? { autonomousOverride: laneAutonomousOverrides[surfaceId] }
            : {}),
          ...(Array.isArray(laneForbiddenActionOverrides[surfaceId])
            ? { forbiddenActionsOverride: laneForbiddenActionOverrides[surfaceId] }
            : {}),
        };
      }),
    };
  };

  const configFileDefaultPath = () => {
    const selectedTerminal = candidates.find((candidate) => selected.has(candidate.surfaceId) && candidate.projectDir)
      || ordinarySupervisorLanes.find((lane) => supervisorLaneControlState(lane) !== 'stopped' && lane.projectDir);
    if (!selectedTerminal?.projectDir) return undefined;
    const projectDir = selectedTerminal.projectDir.replace(/[\\/]+$/, '');
    return `${projectDir}\\.wmux\\ai-supervisor.wmux-supervisor.json`;
  };

  const saveConfigFile = async () => {
    const config = configFileData();
    if (config.terminals.length === 0) {
      setDialogNotice({ kind: 'error', message: '请先选择要导出的终端。' });
      return;
    }
    const result = await (window as any).wmux?.supervisor?.saveConfig?.(
      config,
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
    const importedTerminals = Array.isArray(config.terminals) ? config.terminals : [];
    const retainedSurfaceIds = sessionRetained
      ? ordinarySupervisorLanes.filter(isSupervisorLaneBound).map((lane) => lane.surfaceId)
      : [];
    const importPlan = planSupervisorTerminalConfigImport(
      importedTerminals,
      candidates.map((candidate) => candidate.surfaceId),
      retainedSurfaceIds,
    );
    const isMultiTerminalConfig = importedTerminals.length > 0;
    const importedSurfaceIds = isMultiTerminalConfig
      ? importPlan.configs.map((terminal) => terminal.surfaceId)
      : Array.from(selected);
    if (importedSurfaceIds.length === 0) {
      setDialogNotice({
        kind: 'error',
        message: isMultiTerminalConfig
          ? `配置中的 ${importPlan.skipped} 个终端均已不存在，未导入终端配置。`
          : '请先选择要应用配置的终端。',
      });
      return;
    }
    const configBySurfaceId = new Map(
      importPlan.configs.map((terminal) => [terminal.surfaceId, terminal]),
    );
    if (isMultiTerminalConfig) {
      setSelected(new Set(importPlan.selectedSurfaceIds));
      setTerminalConfigExpansion((current) => ({
        ...current,
        ...Object.fromEntries(importedSurfaceIds.map((surfaceId) => [surfaceId, false])),
      }));
    }
    const loadedLaunchCommand = config.supervisorLaunchCmd ?? 'pi';
    const loadedLauncherKind = detectSupervisorLauncher(loadedLaunchCommand);
    const loadedWorkScope = normalizeSupervisorWorkScope(config.workScope);
    setRestoreEnabled((current) => {
      const next = new Set(current);
      for (const surfaceId of importedSurfaceIds) {
        const terminalConfig = configBySurfaceId.get(surfaceId) || config;
        if (terminalConfig.restoreTaskContext) next.add(surfaceId);
        else next.delete(surfaceId);
      }
      return next;
    });
    setLaneConfigs((current) => {
      const next = { ...current };
      for (const surfaceId of importedSurfaceIds) {
        const terminalConfig = configBySurfaceId.get(surfaceId) || config;
        next[surfaceId] = {
          taskGoal: terminalConfig.taskGoal || '',
          taskDescription: terminalConfig.taskDescription || '',
          preconditions: terminalConfig.preconditions || '',
          supervisorNotes: terminalConfig.supervisorNotes || '',
          stopWhen: terminalConfig.stopWhen || '',
          stopWhenKind: terminalConfig.stopWhenKind === 'direction' ? 'direction' : 'concrete',
          waitForNextDirection: terminalConfig.waitForNextDirection === true,
          planFilePath: terminalConfig.planFilePath || '',
          taskWorkMode: normalizeTaskWorkMode(terminalConfig.taskWorkMode),
          mainThreadResponsibility: normalizeTaskThreadResponsibility(terminalConfig.mainThreadResponsibility),
          childThreadResponsibilities: normalizeTaskChildThreadResponsibilities(
            terminalConfig.childThreadResponsibilities,
          ),
        };
      }
      return next;
    });
    setLanePermissionOverrides((current) => {
      const next = { ...current };
      for (const surfaceId of importedSurfaceIds) {
        const terminalConfig = configBySurfaceId.get(surfaceId);
        if (Array.isArray(terminalConfig?.autonomyPermissionsOverride)) {
          next[surfaceId] = normalizeSupervisorAutonomyPermissions(
            terminalConfig.autonomyPermissionsOverride,
          );
        } else if (isMultiTerminalConfig) delete next[surfaceId];
      }
      return next;
    });
    setLaneAutonomousOverrides((current) => {
      const next = { ...current };
      for (const surfaceId of importedSurfaceIds) {
        const terminalConfig = configBySurfaceId.get(surfaceId);
        if (typeof terminalConfig?.autonomousOverride === 'boolean') {
          next[surfaceId] = terminalConfig.autonomousOverride;
        } else if (isMultiTerminalConfig) delete next[surfaceId];
      }
      return next;
    });
    setLaneForbiddenActionOverrides((current) => {
      const next = { ...current };
      for (const surfaceId of importedSurfaceIds) {
        const terminalConfig = configBySurfaceId.get(surfaceId);
        if (Array.isArray(terminalConfig?.forbiddenActionsOverride)) {
          next[surfaceId] = normalizeSupervisorForbiddenActions(
            terminalConfig.forbiddenActionsOverride,
          );
        } else if (isMultiTerminalConfig) delete next[surfaceId];
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
      const missingPlanFile = importedSurfaceIds.some((surfaceId) => !(
        configBySurfaceId.get(surfaceId)?.planFilePath || config.planFilePath || ''
      ));
      setWorkScope(loadedWorkScope === 'plan-defined' && missingPlanFile
        ? 'task-files'
        : loadedWorkScope);
      setForbiddenActions(normalizeSupervisorForbiddenActions(config.forbiddenActions));
    }
    const skippedNotice = isMultiTerminalConfig && importPlan.skipped > 0
      ? `，跳过 ${importPlan.skipped} 个已不存在的终端`
      : '';
    setDialogNotice({
      kind: 'success',
      message: `已导入 ${importedSurfaceIds.length} 个终端配置${skippedNotice}。`,
    });
  };

  const buildLanes = (preserveCurrentContext: boolean): SupervisorLane[] => {
    const lanes: SupervisorLane[] = [];
    for (const c of candidates) {
      if (!selected.has(c.surfaceId)) continue;
      const prev = ordinarySupervisorLanes.find((l) => (
        l.surfaceId === c.surfaceId && isSupervisorLaneBound(l)
      ));
      const selectedSourceId = restoreSourceIdFor(c.surfaceId);
      const selectedSource = restoreEnabled.has(c.surfaceId)
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
        : undefined;
      const contextRecoveryStatus = restoreSource
        ? keepsRestoredContext && prev?.contextRecoveryStatus
          ? prev.contextRecoveryStatus
          : 'draft-pending' as const
        : undefined;
      const config = laneConfigs[c.surfaceId]
        || (prev ? effectiveSupervisorLaneConfig(prev) : emptyLaneConfig());
      const finalizesWaiting = supervisorWaitingConfigAction(
        prev ? supervisorLaneControlState(prev) : undefined,
        config.waitForNextDirection === true,
        false,
      ) === 'finalize';
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
        controlState: finalizesWaiting
          ? 'stopped'
          : keepsCurrentContext && prev
            ? supervisorLaneControlState(prev)
            : 'active',
        awaitingStopCheck: keepsCurrentContext ? prev?.awaitingStopCheck || false : false,
        stopConfirmed: keepsCurrentContext ? prev?.stopConfirmed || false : false,
        awaitingReview: keepsCurrentContext ? prev?.awaitingReview || false : false,
        activeReviewId: keepsCurrentContext ? prev?.activeReviewId : undefined,
        reviewWorkerTurnId: keepsCurrentContext ? prev?.reviewWorkerTurnId : undefined,
        reviewOpenedAt: keepsCurrentContext ? prev?.reviewOpenedAt : undefined,
        reviewDeliveryConfirmedAt: keepsCurrentContext ? prev?.reviewDeliveryConfirmedAt : undefined,
        reviewWatchdogState: keepsCurrentContext ? prev?.reviewWatchdogState : undefined,
        supervisorProblem: keepsCurrentContext ? prev?.supervisorProblem : undefined,
        resumeAfterCancelledDecision: keepsCurrentContext ? prev?.resumeAfterCancelledDecision : false,
        lastBlockedResponseVersion: keepsCurrentContext ? prev?.lastBlockedResponseVersion : undefined,
        lastBlockedResponseId: keepsCurrentContext ? prev?.lastBlockedResponseId : undefined,
        autoDecisionLimitReached: keepsCurrentContext ? prev?.autoDecisionLimitReached || false : false,
        autoDecisionsUsed: keepsCurrentContext ? prev?.autoDecisionsUsed || 0 : 0,
        pendingSupervisorDeliveries: keepsCurrentContext ? prev?.pendingSupervisorDeliveries || [] : [],
        currentTask: keepsCurrentContext ? prev?.currentTask || '' : '',
        decisions: keepsCurrentContext ? prev?.decisions || [] : [],
        ordinaryPlanRequired: keepsCurrentContext ? prev?.ordinaryPlanRequired : true,
        ...(!keepsCurrentContext && creationMode === 'terminal' ? {
          goalConstruction: {
            status: 'drafting' as const,
            initialIdea: config.taskGoal.trim() || `基于“${c.label}”终端已有对话和项目进度继续监督`,
            draft: {
              taskGoal: config.taskGoal.trim(),
              taskDescription: config.taskDescription.trim(),
              preconditions: config.preconditions.trim(),
              stopWhen: config.stopWhen.trim(),
              stopWhenKind: config.stopWhenKind === 'direction' ? 'direction' as const : 'concrete' as const,
            },
            messages: [],
            startedAt: Date.now(),
          },
        } : {}),
        config: {
          taskGoal: config.taskGoal.trim(),
          taskDescription: config.taskDescription.trim(),
          preconditions: config.preconditions.trim(),
          supervisorNotes: config.supervisorNotes?.trim() || '',
          stopWhen: config.stopWhen.trim(),
          stopWhenKind: config.stopWhenKind === 'direction' ? 'direction' : 'concrete',
          waitForNextDirection: config.waitForNextDirection === true,
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
        ...(!finalizesWaiting && Object.prototype.hasOwnProperty.call(laneAutonomousOverrides, c.surfaceId)
          ? { autonomousOverride: laneAutonomousOverrides[c.surfaceId] }
          : {}),
        ...(Array.isArray(laneForbiddenActionOverrides[c.surfaceId])
          ? { forbiddenActionsOverride: [...laneForbiddenActionOverrides[c.surfaceId]] }
          : {}),
        ...(restoreSource ? { restoreSource } : {}),
        ...(contextRecoveryStatus ? { contextRecoveryStatus } : {}),
        ...(keepsRestoredContext && prev?.restoredHistory ? { restoredHistory: prev.restoredHistory } : {}),
        ...(keepsRestoredContext && prev?.restoredFromSessionId ? { restoredFromSessionId: prev.restoredFromSessionId } : {}),
      });
    }
    return lanes;
  };

  const persistFields = (grantSessionAutonomy: boolean) => {
    patchSupervisor({
      supervisorLaunchCmd: launchCmd,
      supervisorModel: launcherKind === 'other' ? '' : supervisorModel,
      supervisorReasoningEffort: launcherKind === 'codex' || launcherKind === 'kimi' || launcherKind === 'pi'
        ? reasoningEffort
        : '',
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
      const launchCommand = buildSupervisorLaunchCommand(
        launchCmd,
        supervisorModel,
        reasoningEffort,
        { isolateSupervisor: true, projectDir: lane.projectDir, isolationKey: lane.id },
      );
      const supervisorSurfaceId = addSurface(supervisorWorkspace.id, targetPaneId, 'terminal', {
        customTitle: supervisorTabTitle(lane.label),
        shell: 'pwsh.exe',
        cwd: lane.projectDir,
        startupCommands: launchCommand ? [launchCommand] : undefined,
        transientSupervisor: true,
        supervisorRuntimeIsolationKey: lane.id,
      });
      if (supervisorSurfaceId) createdSurfaceIds.push(supervisorSurfaceId);
      return {
        ...lane,
        supervisorSurfaceId,
        ...(replaceExisting ? {
          supervisorProblem: undefined,
          reviewWatchdogState: lane.activeReviewId ? 'pending' as const : undefined,
          reviewDeliveryConfirmedAt: undefined,
          unreportedIdleRecoveryAttempts: 0,
        } : {}),
      };
    });

    if (configuredLanes.some((lane) => !lane.supervisorSurfaceId)) {
      for (const surfaceId of createdSurfaceIds) {
        closeSurface(supervisorWorkspace.id, targetPaneId, surfaceId);
      }
      return { ok: false, lanes };
    }
    if (replaceExisting) {
      for (const oldLane of ordinarySupervisorLanes) {
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
        for (const lane of session.lanes) {
          if (!laneIds.has(lane.id)) continue;
          if (!lane.restoreSource || lane.restoredFromSessionId || (lane.decisions?.length ?? 0) > 0) continue;
          const restored = await restoreSelectedLaneHistory(lane, lane.restoreSource);
          if (restored) useStore.getState().updateLane(lane.id, restored);
        }
        session = useStore.getState().supervisor;
        const states = (window as any).__wmux_getAgentStates?.() || {};
        for (const lane of session.lanes) {
          if (!laneIds.has(lane.id)) continue;
          const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
          if (!supervisorSurfaceId) continue;
          const ready = await waitForTerminalRuntimeReady(supervisorSurfaceId);
          const screen = readTerminalScreen(supervisorSurfaceId, 80).text || '';
          if (!ready.ok || !interactiveAgentInputReady(screen)) {
            const detail = ready.error
              || interactiveAgentShellPromptFailureDetail(screen)
              || '未检测到可接收监督任务的 Agent 输入界面；已禁止向未知终端发送监督协议';
            markTerminalRuntimeFailed(supervisorSurfaceId, detail);
            const store = useStore.getState();
            store.updateLane(lane.id, {
              supervisorProblem: { kind: 'runtime-failed', detail, detectedAt: Date.now() },
            });
            store.pauseSupervisorLane(lane.id, detail);
            store.appendSupervisorLog(lane.id, '监督 Agent 未就绪', detail);
            continue;
          }
          session = useStore.getState().supervisor;
          const currentLane = session.lanes.find((candidate) => candidate.id === lane.id);
          if (!session.active || !currentLane || supervisorLaneControlState(currentLane) !== 'active') continue;
          const text = buildSupervisorBriefing(session, {
            lane: currentLane,
            state: String(states[currentLane.surfaceId]?.state || 'unknown'),
          });
          const briefing = currentLane.goalConstruction?.status === 'drafting'
            ? buildSupervisorGoalConstructionBriefing(currentLane)
            : text;
          sendToSurface(supervisorSurfaceId, briefing, true, 'ordinary');
        }
      } catch (err) {
        console.warn('[supervisor] briefing inject failed', err);
      }
    })(), SUPERVISOR_TUI_READY_DELAY_MS);
  };

  const applyConfig = (andStart: boolean) => {
    setDialogNotice(null);
    const missingRestoreSource = candidates.filter((candidate) => (
      selected.has(candidate.surfaceId)
      && restoreEnabled.has(candidate.surfaceId)
      && !restoreSourceIdFor(candidate.surfaceId)
    ));
    if (missingRestoreSource.length > 0) {
      const firstCandidate = missingRestoreSource[0];
      showTerminalConfigSection(
        firstCandidate.surfaceId,
        'context',
        `${firstCandidate.label} 的恢复上下文`,
      );
      setDialogNotice({
        kind: 'error',
        message: `以下终端没有可恢复的审计上下文：${missingRestoreSource.map((candidate) => candidate.label).join('、')}`,
      });
      return;
    }
    const lanes = buildLanes(!andStart || sessionRetained);
    if (lanes.length === 0) {
      setDialogNotice({ kind: 'error', message: '请至少选择一个要监控的终端。' });
      return;
    }
    const missingStopWhen = creationMode === 'terminal' && !sessionRetained
      ? []
      : lanes.filter((lane) => !lane.config?.stopWhen.trim());
    if (missingStopWhen.length > 0) {
      const firstLane = missingStopWhen[0];
      showTerminalConfigSection(firstLane.surfaceId, 'basic', `${firstLane.label} 的停止条件`);
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
      const firstLane = incompleteThreadAssignments[0];
      showTerminalConfigSection(firstLane.surfaceId, 'execution', `${firstLane.label} 的主线程职责`);
      setDialogNotice({
        kind: 'error',
        message: `请完整填写以下终端的主线程和已启用子线程职责：${incompleteThreadAssignments.map((lane) => lane.label).join('、')}`,
      });
      return;
    }
    const missingPlanFile = workScope === 'plan-defined'
      ? lanes.find((lane) => !lane.config?.planFilePath.trim())
      : undefined;
    if (missingPlanFile) {
      showTerminalConfigSection(
        missingPlanFile.surfaceId,
        'context',
        `${missingPlanFile.label} 的计划文件`,
      );
      setDialogNotice({ kind: 'error', message: '工作范围选择“按计划文件定义”时，每个被监督终端都必须选择自己的计划文件。' });
      return;
    }
    if (andStart && !launchCmd.trim()) {
      setDialogNotice({ kind: 'error', message: '请选择可启动的监督 AI；“不自动启动”不能接收监督 briefing。' });
      return;
    }

    if (andStart || sessionRetained) {
      const result = ensureDedicatedSupervisors(lanes, !sessionRetained);
      if (!result.ok) {
        setDialogNotice({ kind: 'error', message: '无法为所有选中终端创建专属监督 AI；监督尚未启动，请重试。' });
        return;
      }
      persistFields(true);
      setOrdinarySupervisorLanes(result.lanes);
      if (!sessionRetained) startOrdinarySupervisor();
      else closeSupervisorSetup();
      const nextSession = useStore.getState().supervisor;
      const previousBySurfaceId = new Map(ordinarySupervisorLanes.map((lane) => [lane.surfaceId, lane]));
      const changedLanes = nextSession.lanes
        .filter((lane) => !isProjectManagedSupervisorLane(lane))
        .filter((lane) => supervisorLaneBriefingChanged(
          supervisor,
          previousBySurfaceId.get(lane.surfaceId),
          nextSession,
          lane,
        ));
      for (const lane of changedLanes) {
        const previousLane = previousBySurfaceId.get(lane.surfaceId);
        if (!previousLane || supervisorWaitingConfigAction(
          supervisorLaneControlState(previousLane),
          lane.config?.waitForNextDirection === true,
          true,
        ) !== 'resume') continue;
        useStore.getState().updateLane(lane.id, {
          controlState: 'active',
          awaitingStopCheck: false,
          stopConfirmed: false,
          awaitingReview: true,
          awaitingDirectionAfterWaitingResume: true,
          autoDecisionLimitReached: false,
          autoDecisionsUsed: 0,
          pendingSupervisorDeliveries: [],
          lastBlockedResponseVersion: undefined,
          lastBlockedResponseId: undefined,
        });
        useStore.getState().appendSupervisorLog(
          lane.id,
          '配置更新，待续恢复',
          '任务配置或监督边界已更新；完成标记和自动裁决计数已重置，继续监督',
        );
      }
      const appliedSession = useStore.getState().supervisor;
      const hasRetainedLane = appliedSession.lanes.some(
        (lane) => !isProjectManagedSupervisorLane(lane)
          && supervisorLaneControlState(lane) !== 'stopped',
      );
      if (sessionRetained && !hasRetainedLane) {
        stopOrdinarySupervisor('所有普通待续通道均已取消“完成后待续”，本轮正式完成');
      }
      const briefingLaneIds = new Set(changedLanes
        .filter((lane) => supervisorLaneControlState(
          useStore.getState().supervisor.lanes.find((item) => item.id === lane.id) || lane,
        ) !== 'stopped')
        .map((lane) => lane.id));
      if (andStart) {
        const workspaceId = useStore.getState().supervisor.supervisorWorkspaceId;
        if (workspaceId) selectWorkspace(workspaceId);
      }
      sendDedicatedBriefings(briefingLaneIds);
    } else {
      persistFields(false);
      setOrdinarySupervisorLanes(lanes);
      closeSupervisorSetup();
    }
  };

  const openAiSession = () => {
    setDialogNotice(null);
    const missingRestoreSource = candidates.filter((candidate) => (
      selected.has(candidate.surfaceId)
      && restoreEnabled.has(candidate.surfaceId)
      && !restoreSourceIdFor(candidate.surfaceId)
    ));
    if (missingRestoreSource.length > 0) {
      const firstCandidate = missingRestoreSource[0];
      showTerminalConfigSection(
        firstCandidate.surfaceId,
        'context',
        `${firstCandidate.label} 的恢复上下文`,
      );
      setDialogNotice({
        kind: 'error',
        message: `以下终端没有可恢复的审计上下文：${missingRestoreSource.map((candidate) => candidate.label).join('、')}`,
      });
      return;
    }
    const lanes = buildLanes(sessionRetained);
    if (lanes.length === 0) {
      setDialogNotice({ kind: 'error', message: '请先至少选择一个要监控的终端。' });
      return;
    }
    const missingStopWhen = lanes.filter((lane) => !lane.config?.stopWhen.trim());
    if (missingStopWhen.length > 0) {
      const firstLane = missingStopWhen[0];
      showTerminalConfigSection(firstLane.surfaceId, 'basic', `${firstLane.label} 的停止条件`);
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
      const firstLane = incompleteThreadAssignments[0];
      showTerminalConfigSection(firstLane.surfaceId, 'execution', `${firstLane.label} 的主线程职责`);
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
    persistFields(false);
    setOrdinarySupervisorLanes(result.lanes);
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
        aria-label="AI 工作模式"
        tabIndex={-1}
        onFocusCapture={(event) => {
          const target = event.target;
          if (target instanceof HTMLElement && target.matches('input, textarea, select, [contenteditable="true"]')) {
            lastFocusedFieldRef.current = target;
          }
        }}
      >
        <header className="supervisor-dialog__header">
          <div className="supervisor-dialog__title">普通 AI 监督</div>
          <div className="supervisor-dialog__sub">
            {creationMode === 'terminal' && !sessionRetained
              ? '从已有任务终端的 Agent 对话和项目进度提取上下文；信息充分时直接开始监督，不足时再向用户询问。'
              : '配置直接监督已打开任务终端的独立监督会话。'}
          </div>
        </header>

        <div className="supervisor-dialog__body">
          {!sessionRetained && (
            <section className="supervisor-dialog__group" aria-label="普通监督创建方式">
              <div className="supervisor-dialog__group-title">创建方式</div>
              <div className="supervisor-dialog__freedom">
                <label className="supervisor-dialog__radio" data-active={creationMode === 'direct'}>
                  <input type="radio" name="ordinary-supervisor-creation-mode" checked={creationMode === 'direct'} onChange={() => setCreationMode('direct')} />
                  <span>直接配置并启动 — 已明确目标和停止条件</span>
                </label>
                <label className="supervisor-dialog__radio" data-active={creationMode === 'terminal'}>
                  <input type="radio" name="ordinary-supervisor-creation-mode" checked={creationMode === 'terminal'} onChange={() => setCreationMode('terminal')} />
                  <span>从已有终端创建 — 自动汇总 Agent 对话与项目进度（推荐）</span>
                </label>
              </div>
              {creationMode === 'terminal' && (
                <div className="supervisor-dialog__hint">可选择一个或多个已有任务终端。每个监督 AI 只读汇总对应终端的可见对话和目录进度；能可靠还原目标与停止条件时直接开始，存在关键歧义时才显示补全问题。</div>
              )}
            </section>
          )}
          <div className="supervisor-dialog__setup-layout">
            <nav className="supervisor-dialog__setup-nav" aria-label="AI 监督配置步骤">
              <button
                type="button"
                data-active={setupSection === 'targets' ? 'true' : 'false'}
                onClick={() => setSetupSection('targets')}
              >
                <span><b>1</b>监督对象</span>
                <small>{selectedCandidates.length > 0 ? `已选 ${selectedCandidates.length} 个终端` : '选择要监督的终端'}</small>
              </button>
              <button
                type="button"
                data-active={setupSection === 'permissions' ? 'true' : 'false'}
                onClick={() => setSetupSection('permissions')}
              >
                <span><b>2</b>权限边界</span>
                <small>{autonomous ? '全自动监督' : `${autonomyPermissions.length} 项自主权限`}</small>
              </button>
              <button
                type="button"
                data-active={setupSection === 'agent' ? 'true' : 'false'}
                onClick={() => setSetupSection('agent')}
              >
                <span><b>3</b>Agent 设置</span>
                <small>{supervisorLauncherDisplayName(launcherKind)}</small>
              </button>
            </nav>

            <main className="supervisor-dialog__setup-content">
          {setupSection === 'targets' && (
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
                const existingLane = sessionRetained
                  ? supervisor.lanes.find((lane) => (
                    lane.surfaceId === candidate.surfaceId && isSupervisorLaneBound(lane)
                  ))
                  : undefined;
                const isExistingLane = !!existingLane;
                const laneWaitingForDirection = existingLane
                  ? supervisorLaneControlState(existingLane) === 'waiting'
                  : false;
                const isConfigExpanded = terminalConfigExpansion[candidate.surfaceId] ?? false;
                const activeConfigSection = terminalConfigSections[candidate.surfaceId] || 'basic';
                const terminalConfigDirty = dirtyTerminalConfigIds.has(candidate.surfaceId);
                const taskWorkMode = normalizeTaskWorkMode(laneConfig.taskWorkMode);
                const configuredChildThreadResponsibilities = normalizeTaskChildThreadResponsibilities(
                  laneConfig.childThreadResponsibilities,
                );
                const childThreadResponsibilities = taskWorkMode === 'multi-thread'
                  && configuredChildThreadResponsibilities.length === 0
                  ? ['']
                  : configuredChildThreadResponsibilities;
                const restoreContextEnabled = restoreEnabled.has(candidate.surfaceId);
                const restoreOptions = restoreCandidates[candidate.surfaceId] || [];
                const selectedRestoreSource = restoreOptions.find((option) => (
                  option.surfaceId === restoreSources[candidate.surfaceId]
                )) || restoreOptions[0];
                const restoreCandidatesReady = restoreCandidatesLoaded.has(candidate.surfaceId);
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
                        {isSelected && (
                          <span className="supervisor-dialog__terminal-config-summary" aria-label={`${candidate.label} 的配置摘要`}>
                            <span>{taskWorkMode === 'multi-thread' ? '多线程' : '单线程'}</span>
                            <span>{laneConfig.stopWhenKind === 'direction' ? '方向型条件' : '具体条件'}</span>
                            <span data-warning={laneConfig.stopWhen.trim() ? '0' : '1'}>
                              {laneConfig.stopWhen.trim() || '缺少停止条件'}
                            </span>
                            <span>{restoreContextEnabled ? '恢复上下文' : '不恢复上下文'}</span>
                            <span>{lanePolicyOverride ? '单独权限' : '继承默认权限'}</span>
                          </span>
                        )}
                      </span>
                    </label>
                    {isSelected && (
                      <details
                        className="supervisor-dialog__lane-settings"
                        aria-label={`${candidate.label} 的监督配置详情`}
                        data-terminal-config-surface={candidate.surfaceId}
                        tabIndex={-1}
                        open={isConfigExpanded}
                        onToggle={(event) => setTerminalConfigExpanded(
                          candidate.surfaceId,
                          event.currentTarget.open,
                        )}
                      >
                        <summary>
                          <span className="supervisor-dialog__drawer-title" data-expanded={isConfigExpanded ? '1' : '0'}>
                            {isConfigExpanded && <small>任务终端监督配置</small>}
                            <strong>
                              {isConfigExpanded
                                ? candidate.label
                                : isExistingLane
                                  ? '查看当前独立监督配置'
                                  : '配置详情'}
                            </strong>
                          </span>
                          <span className="supervisor-dialog__toggle-hint">
                            {isConfigExpanded ? '关闭' : '打开'}
                          </span>
                        </summary>
                        {isConfigExpanded && (
                          <>
                            <div className="supervisor-dialog__drawer-overview">
                              <div>
                                <span>当前任务</span>
                                <strong>{candidate.currentTask?.trim() || '尚未收到终端任务事件'}</strong>
                              </div>
                              <div className="supervisor-dialog__drawer-meta">
                                <span>{candidate.workspaceTitle}</span>
                                <span>状态 {candidate.state}</span>
                                {candidate.remoteSshControl && <span>SSH 远程控制</span>}
                                <span>{candidate.surfaceId.slice(0, 16)}…</span>
                              </div>
                            </div>

                            <div className="supervisor-dialog__config-tabs" role="tablist" aria-label={`${candidate.label} 的配置分组`}>
                              {TERMINAL_CONFIG_SECTIONS.map((section) => (
                                <button
                                  key={section.id}
                                  type="button"
                                  role="tab"
                                  aria-selected={activeConfigSection === section.id}
                                  aria-controls={`terminal-config-${candidate.surfaceId}-${section.id}`}
                                  data-invalid={
                                    section.id === 'basic'
                                      ? (creationMode === 'direct' && !laneConfig.stopWhen.trim() ? '1' : '0')
                                      : section.id === 'execution'
                                        ? (hasIncompleteMultiThreadAssignment(laneConfig) ? '1' : '0')
                                        : section.id === 'context'
                                          ? (workScope === 'plan-defined' && !laneConfig.planFilePath.trim() ? '1' : '0')
                                          : '0'
                                  }
                                  onClick={() => setTerminalConfigSections((current) => ({
                                    ...current,
                                    [candidate.surfaceId]: section.id,
                                  }))}
                                >
                                  {section.label}
                                </button>
                              ))}
                            </div>

                            {dialogNotice && (
                              <div className="supervisor-dialog__drawer-notice" data-kind={dialogNotice.kind}>
                                {dialogNotice.message}
                              </div>
                            )}

                            <div className="supervisor-dialog__lane-settings-content">
                              {activeConfigSection === 'basic' && (
                                <div id={`terminal-config-${candidate.surfaceId}-basic`} role="tabpanel" className="supervisor-dialog__config-panel">
                                  <div className="supervisor-dialog__section">
                                    <div className="supervisor-dialog__label">
                                      {creationMode === 'terminal' && !sessionRetained ? '任务目标（可选补充）' : '任务目标（可选）'}
                                    </div>
                                    <textarea
                                      className="supervisor-dialog__textarea"
                                      aria-label={`${candidate.label} 的任务目标`}
                                      rows={2}
                                      value={laneConfig.taskGoal}
                                      onChange={(event) => updateLaneConfig(candidate.surfaceId, { taskGoal: event.target.value })}
                                      placeholder={creationMode === 'terminal' && !sessionRetained
                                        ? '留空则由监督 AI 根据该终端已有对话和目录进度归纳'
                                        : '例如：修复此终端负责的认证模块并保持现有行为'}
                                    />
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
                                    <div className={creationMode === 'terminal' && !sessionRetained
                                      ? 'supervisor-dialog__label'
                                      : 'supervisor-dialog__label supervisor-dialog__label--required'}>
                                      停止条件{creationMode === 'terminal' && !sessionRetained ? '（可由终端上下文归纳）' : <><span> </span><span className="supervisor-dialog__required" aria-hidden="true">*</span></>}
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
                                    <label className="supervisor-dialog__row">
                                      <input
                                        type="checkbox"
                                        aria-label={`${candidate.label} 完成后待续`}
                                        checked={laneConfig.waitForNextDirection === true}
                                        onChange={(event) => updateLaneConfig(candidate.surfaceId, {
                                          waitForNextDirection: event.target.checked,
                                        })}
                                      />
                                      <span className="supervisor-dialog__row-main">
                                        <span className="supervisor-dialog__row-label">完成后待续（可选）</span>
                                        <span className="supervisor-dialog__row-meta">
                                          {laneWaitingForDirection
                                            ? '当前通道正在待续；取消勾选并应用后，本轮将正式完成并停止。'
                                            : '达到停止条件后保留监督通道与上下文，等待你提供下一步指示或方向。'}
                                        </span>
                                      </span>
                                    </label>
                                  </div>
                                </div>
                              )}

                              {activeConfigSection === 'execution' && (
                                <div id={`terminal-config-${candidate.surfaceId}-execution`} role="tabpanel" className="supervisor-dialog__config-panel">
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
                                </div>
                              )}

                              {activeConfigSection === 'context' && (
                                <div id={`terminal-config-${candidate.surfaceId}-context`} role="tabpanel" className="supervisor-dialog__config-panel">
                                  <div className="supervisor-dialog__section">
                                    <label className="supervisor-dialog__row">
                                      <input
                                        type="checkbox"
                                        checked={restoreContextEnabled}
                                        disabled={isExistingLane}
                                        onChange={(event) => toggleRestoreContext(candidate.surfaceId, event.target.checked)}
                                      />
                                      <span className="supervisor-dialog__row-main">
                                        <span className="supervisor-dialog__row-label">恢复任务终端上下文</span>
                                        <span className="supervisor-dialog__row-meta">
                                          {isExistingLane
                                            ? '运行中的监督会话不能切换恢复来源；停止后重新配置即可更改。'
                                            : '勾选后自动恢复最新审计历史；监督 AI 拟定恢复指令，需你确认后才发送。'}
                                        </span>
                                      </span>
                                    </label>
                                    {restoreContextEnabled && (
                                      <div className="supervisor-dialog__restore-row">
                                        <div className="supervisor-dialog__row-label">恢复上下文（默认最新）</div>
                                        {!restoreCandidatesReady ? (
                                          <div className="supervisor-dialog__hint">正在查找此工程的监督历史…</div>
                                        ) : selectedRestoreSource ? (
                                          <>
                                            <select
                                              className="supervisor-dialog__input"
                                              aria-label={`${candidate.label} 的恢复上下文`}
                                              value={restoreSourceIdFor(candidate.surfaceId)}
                                              disabled={isExistingLane}
                                              onChange={(event) => selectRestoreSource(candidate.surfaceId, event.target.value)}
                                            >
                                              {restoreOptions.map((option, index) => (
                                                <option key={`${option.surfaceId}-${option.sessionId}`} value={option.surfaceId}>
                                                  {index === 0 ? '（最新）' : ''}{option.label} · {new Date(option.lastEventAt).toLocaleString('zh-CN', { hour12: false })}
                                                  {option.currentTask ? ` · ${option.currentTask.slice(0, 50)}` : ''}
                                                </option>
                                              ))}
                                            </select>
                                            <div className="supervisor-dialog__hint">
                                              {selectedRestoreSource.currentTask ? `当前任务：${selectedRestoreSource.currentTask.slice(0, 80)}` : '当前任务：未记录'}
                                              {selectedRestoreSource.lastDecision ? ` · 最近裁决 ${selectedRestoreSource.lastDecision}` : ''}
                                            </div>
                                          </>
                                        ) : (
                                          <div className="supervisor-dialog__warning">此工程没有可恢复的监督历史，无法启用上下文恢复。</div>
                                        )}
                                      </div>
                                    )}
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
                                </div>
                              )}

                              {activeConfigSection === 'supervision' && (
                                <div id={`terminal-config-${candidate.surfaceId}-supervision`} role="tabpanel" className="supervisor-dialog__config-panel">
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
                                    <div className="supervisor-dialog__label">注意事项（可选）</div>
                                    <textarea
                                      className="supervisor-dialog__textarea"
                                      aria-label={`${candidate.label} 的监督注意事项`}
                                      rows={3}
                                      value={laneConfig.supervisorNotes || ''}
                                      onChange={(event) => updateLaneConfig(candidate.surfaceId, { supervisorNotes: event.target.value })}
                                      placeholder="例如：完成一个有意义的阶段后，让任务 AI 同步相关文档；形成可回滚成果后提交本地 Git commit"
                                    />
                                    <div className="supervisor-dialog__hint">仅提醒监督 AI 在合适检查点安排，不会扩大任务范围、权限或允许推送/发布等高风险动作。</div>
                                  </div>
                                  <div className="supervisor-dialog__section">
                                    <label className="supervisor-dialog__row">
                                      <input
                                        type="checkbox"
                                        checked={lanePolicyOverride}
                                        onChange={(event) => {
                                          const checked = event.target.checked;
                                          markTerminalConfigDirty(candidate.surfaceId);
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
                                            onChange={(event) => {
                                              markTerminalConfigDirty(candidate.surfaceId);
                                              setLaneAutonomousOverrides((current) => ({
                                                ...current,
                                                [candidate.surfaceId]: event.target.checked,
                                              }));
                                            }}
                                          />
                                          <span>全自动监督（仅此终端）</span>
                                        </label>
                                        <div className="supervisor-dialog__label">允许自主处理</div>
                                        {SUPERVISOR_AUTONOMY_PERMISSION_VALUES.map((permission) => (
                                          <label key={permission} className="supervisor-dialog__option">
                                            <input
                                              type="checkbox"
                                              checked={lanePermissionOverride.includes(permission)}
                                              onChange={() => {
                                                markTerminalConfigDirty(candidate.surfaceId);
                                                setLanePermissionOverrides((current) => {
                                                  const selectedPermissions = current[candidate.surfaceId] || [];
                                                  return {
                                                    ...current,
                                                    [candidate.surfaceId]: selectedPermissions.includes(permission)
                                                      ? selectedPermissions.filter((item) => item !== permission)
                                                      : [...selectedPermissions, permission],
                                                  };
                                                });
                                              }}
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
                                              onChange={() => {
                                                markTerminalConfigDirty(candidate.surfaceId);
                                                setLaneForbiddenActionOverrides((current) => {
                                                  const selectedActions = current[candidate.surfaceId] || [];
                                                  return {
                                                    ...current,
                                                    [candidate.surfaceId]: selectedActions.includes(action)
                                                      ? selectedActions.filter((item) => item !== action)
                                                      : [...selectedActions, action],
                                                  };
                                                });
                                              }}
                                            />
                                            <span>{FORBIDDEN_ACTION_LABELS[action]}</span>
                                          </label>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>

                            <div className="supervisor-dialog__drawer-actions">
                              <span data-dirty={terminalConfigDirty ? '1' : '0'}>
                                {terminalConfigDirty ? '已修改，尚未保存' : '当前配置未修改'}
                              </span>
                              <button
                                type="button"
                                className="confirm-dialog__btn"
                                onClick={() => setTerminalConfigExpanded(candidate.surfaceId, false)}
                              >
                                关闭详情
                              </button>
                              <button
                                type="button"
                                className="confirm-dialog__btn supervisor-dialog__drawer-save"
                                onClick={() => {
                                  markTerminalConfigSaved(candidate.surfaceId);
                                  setTerminalConfigExpanded(candidate.surfaceId, false);
                                }}
                              >
                                保存全部设置
                              </button>
                            </div>
                          </>
                        )}
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
          )}

          {setupSection === 'permissions' && (
          <section className="supervisor-dialog__group">
            <div className="supervisor-dialog__group-title">权限边界</div>
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
          )}

          {setupSection === 'agent' && (
          <section className="supervisor-dialog__group supervisor-dialog__agent-settings">
            <div className="supervisor-dialog__group-title">Agent 设置</div>
            <div className="supervisor-dialog__group-description">配置监督 AI 的启动器、模型、思考程度以及终端配置文件。</div>
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
              {launcherKind !== 'other' && (
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
                        setModelValidation({ state: 'idle', model: '', message: '' });
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
                          && modelChoiceFor(launcherKind, selectedAgentDefaults.supervisorModel, modelCatalog) === CUSTOM_OPTION
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
                  <div className="supervisor-dialog__model-actions">
                    <button
                      type="button"
                      className="confirm-dialog__btn"
                      disabled={modelValidationPending}
                      onClick={() => void validateModel(supervisorModel)}
                    >
                      {modelValidationPending && modelValidation.model === supervisorModel ? '验证中…' : '验证当前模型'}
                    </button>
                    <button
                      type="button"
                      className="confirm-dialog__btn"
                      onClick={() => setModelManagerOpen((open) => !open)}
                    >
                      {modelManagerOpen ? '收起模型管理' : '管理模型列表'}
                    </button>
                  </div>
                  {modelValidation.message && (
                    <div
                      className="supervisor-dialog__model-validation"
                      data-kind={modelValidation.state}
                    >
                      {modelValidation.message}
                    </div>
                  )}
                  {modelManagerOpen && (
                    <div className="supervisor-dialog__model-manager">
                      <div className="supervisor-dialog__model-discovery">
                        <button
                          type="button"
                          className="confirm-dialog__btn"
                          disabled={modelDiscovery.state === 'loading' || modelValidationPending}
                          onClick={() => void discoverModels()}
                        >
                          {modelDiscovery.state === 'loading' ? '获取中…' : '获取支持模型'}
                        </button>
                        {modelDiscovery.state === 'success' && (
                          <span>
                            {modelDiscovery.source} · {modelDiscovery.models.length} 个
                            {modelDiscovery.limited ? '（仅本地配置）' : ''}
                          </span>
                        )}
                      </div>
                      {modelDiscovery.state === 'success' && (
                        <select
                          className="supervisor-dialog__input supervisor-dialog__model-discovery-select"
                          value={modelDiscovery.models.includes(newModelId) ? newModelId : ''}
                          onChange={(event) => setNewModelId(event.target.value)}
                        >
                          <option value="">选择要添加的模型</option>
                          {modelDiscovery.models.map((model) => {
                            const alreadyAdded = launcherModelOptions.some((option) => option.value === model);
                            return (
                              <option key={model} value={model} disabled={alreadyAdded}>
                                {model}{alreadyAdded ? '（已在列表）' : ''}
                              </option>
                            );
                          })}
                        </select>
                      )}
                      {modelDiscovery.state === 'error' && (
                        <div className="supervisor-dialog__model-validation" data-kind="error">
                          {modelDiscovery.message}
                        </div>
                      )}
                      <div className="supervisor-dialog__model-add">
                        <input
                          className="supervisor-dialog__input"
                          value={newModelId}
                          maxLength={200}
                          onChange={(event) => setNewModelId(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              addModelDirectly();
                            }
                          }}
                          placeholder={customModelPlaceholder(launcherKind)}
                        />
                        <button
                          type="button"
                          className="confirm-dialog__btn"
                          disabled={!newModelId.trim()}
                          onClick={addModelDirectly}
                        >
                          直接添加
                        </button>
                      </div>
                      <div className="supervisor-dialog__hint">
                        直接添加不会发起验证请求；请确认模型 ID 可用。
                      </div>
                      <div className="supervisor-dialog__model-list">
                        {launcherModelOptions.map((option) => (
                          <div className="supervisor-dialog__model-row" key={option.value}>
                            <span title={option.value}>{option.label}</span>
                            <button
                              type="button"
                              className="confirm-dialog__btn"
                              disabled={modelValidationPending}
                              onClick={() => void validateModel(option.value)}
                            >
                              验证
                            </button>
                            <button
                              type="button"
                              className="confirm-dialog__btn"
                              onClick={() => removeModel(option.value)}
                            >
                              移除
                            </button>
                          </div>
                        ))}
                        {hiddenModelOptions.map((option) => (
                          <div className="supervisor-dialog__model-row supervisor-dialog__model-row--hidden" key={option.value}>
                            <span title={option.value}>{option.label}（已移除）</span>
                            <button
                              type="button"
                              className="confirm-dialog__btn"
                              onClick={() => restoreModel(option.value)}
                            >
                              恢复
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
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
                  <div className="supervisor-dialog__label">Kimi 推理设置</div>
                  <p>由当前 Kimi 模型或 Agent 配置决定；启动命令不再附加不受支持的参数。</p>
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
                  <div className="supervisor-dialog__label">Grok Thinking</div>
                  <div className="supervisor-dialog__default-agent-row">
                    <select
                      className="supervisor-dialog__input"
                      value={reasoningEffort}
                      disabled={sessionRetained}
                      onChange={(event) => setReasoningEffort(event.target.value)}
                    >
                      {GROK_THINKING_OPTIONS.map((option) => (
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
                      title="将当前 Thinking 设置用作 Grok 以后新建监督会话的默认选择"
                    >
                      {reasoningIsDefault ? '已为默认' : '设为默认'}
                    </button>
                  </div>
                </section>
              )}

              {creationMode === 'direct' && <>
              <section className="supervisor-dialog__section supervisor-dialog__advanced-divider">
                <div className="supervisor-dialog__label">配置文件</div>
                <div className="supervisor-dialog__config-actions">
                  <button type="button" className="confirm-dialog__btn" onClick={() => void loadConfigFile()}>
                    导入终端配置…
                  </button>
                  <button type="button" className="confirm-dialog__btn" onClick={() => void saveConfigFile()}>
                    导出当前终端配置…
                  </button>
                </div>
                <div className="supervisor-dialog__hint">导出包含当前选中的全部终端配置；导入按终端恢复，原终端已不存在时自动跳过。旧版单终端配置仍会应用到当前已选终端。</div>
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
              </>}
            </div>
          </section>
          )}
            </main>
          </div>
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
                stopOrdinarySupervisor();
              }}
            >
              停止监督
            </button>
          )}
          <span className="supervisor-dialog__selection-summary">
            已选 {selectedCandidates.length} 个终端 · {creationMode === 'terminal' && !sessionRetained ? '终端上下文启动' : autonomous ? '全自动监督' : '受控自主'}
          </span>
          <span className="supervisor-dialog__actions-spacer" />
          <button type="button" className="confirm-dialog__btn" onClick={closeSupervisorSetup}>
            取消
          </button>
          {!sessionRetained && creationMode === 'direct' && (
            <button
              type="button"
              className="confirm-dialog__btn"
              onClick={() => applyConfig(false)}
            >
              保存设置
            </button>
          )}
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
