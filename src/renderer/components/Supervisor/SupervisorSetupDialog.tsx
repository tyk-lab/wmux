import { useMemo, useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { SurfaceId, WorkspaceId, PaneId, SplitNode } from '../../../shared/types';
import type {
  StopWhenKind,
  SupervisorLane,
  SupervisorStep,
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
  buildSupervisorBriefing,
  stopWhenKindHint,
  stopWhenKindLabel,
  SUPERVISOR_TAB_TITLE,
  SUPERVISOR_WORKSPACE_TITLE,
  supervisorTabTitle,
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

function reasoningOptionsFor(launcher: SupervisorLauncherKind): Array<{ value: string; label: string }> {
  if (launcher === 'codex') return REASONING_EFFORT_OPTIONS;
  if (launcher === 'kimi') return KIMI_THINKING_OPTIONS;
  if (launcher === 'pi') return PI_THINKING_OPTIONS;
  return [];
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
  const stopSupervisor = useStore((s) => s.stopSupervisor);
  const addSurface = useStore((s) => s.addSurface);
  const closeSurface = useStore((s) => s.closeSurface);
  const createWorkspace = useStore((s) => s.createWorkspace);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const dialogRef = useRef<HTMLDivElement>(null);
  const sessionRetained = supervisor.active || supervisor.paused;
  let primaryActionLabel = '启动 AI 监督';
  if (supervisor.active) primaryActionLabel = '应用并继续监督';
  else if (supervisor.paused) primaryActionLabel = '返回监督会话';

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
      supervisor.lanes.map((lane) => lane.supervisorSurfaceId).filter(Boolean),
    );
    for (const ws of workspaces) {
      const surfaces: Array<{ surfaceId: SurfaceId; paneId: PaneId; title: string; projectDir?: string }> = [];
      collectTerminals(ws.splitTree, surfaces);
      for (const s of surfaces) {
        if (supervisorSurfaceIds.has(s.surfaceId)) continue;
        if (s.title.startsWith(SUPERVISOR_TAB_TITLE) || s.title === 'AI Supervisor') continue;
        const meta = agentMeta.get(s.surfaceId);
        const st = agentStates[s.surfaceId]?.state || 'unknown';
        const existingLane = supervisor.lanes.find((lane) => lane.surfaceId === s.surfaceId);
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

  const [taskGoal, setTaskGoal] = useState(supervisor.taskGoal || '');
  const [taskDescription, setTaskDescription] = useState(supervisor.taskDescription || '');
  const [preconditions, setPreconditions] = useState(supervisor.preconditions || '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [taskGoalOverrides, setTaskGoalOverrides] = useState<Record<string, string>>({});
  const [stopWhenOverrides, setStopWhenOverrides] = useState<Record<string, string>>({});
  const [stopWhen, setStopWhen] = useState(supervisor.stopWhen);
  const [stopWhenKind, setStopWhenKind] = useState<StopWhenKind>(
    supervisor.stopWhenKind || 'concrete',
  );
  const [planFilePath, setPlanFilePath] = useState(supervisor.planFilePath);
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
  const [workScope, setWorkScope] = useState<SupervisorWorkScope>(
    supervisor.workScope || DEFAULT_SUPERVISOR_WORK_SCOPE,
  );
  const [forbiddenActions, setForbiddenActions] = useState<SupervisorForbiddenAction[]>(
    supervisor.forbiddenActions || [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS],
  );

  useEffect(() => {
    if (!setupOpen) return;
    setTaskGoal(supervisor.taskGoal || '');
    setTaskDescription(supervisor.taskDescription || '');
    setPreconditions(supervisor.preconditions || '');
    setStopWhen(supervisor.stopWhen || '');
    setStopWhenKind(supervisor.stopWhenKind || 'concrete');
    setPlanFilePath(supervisor.planFilePath || '');
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
    setSelected(new Set(supervisor.lanes.filter((l) => l.enabled).map((l) => l.surfaceId)));
    setTaskGoalOverrides(Object.fromEntries(
      supervisor.lanes.flatMap((lane) => lane.taskGoalOverride ? [[lane.surfaceId, lane.taskGoalOverride]] : []),
    ));
    setStopWhenOverrides(Object.fromEntries(
      supervisor.lanes.flatMap((lane) => lane.stopWhenOverride ? [[lane.surfaceId, lane.stopWhenOverride]] : []),
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
    if (!setupOpen || sessionRetained) return;
    setAutonomous(false);
    if (supervisor.autonomous) patchSupervisor({ autonomous: false });
  }, [setupOpen, sessionRetained, supervisor.autonomous, patchSupervisor]);

  const launcherKind = useMemo(() => detectSupervisorLauncher(
    launchChoice === CUSTOM_OPTION ? launchCmd : launchChoice,
  ), [launchChoice, launchCmd]);
  const launcherModelOptions = modelOptionsFor(launcherKind);

  const changeLauncher = (choice: string) => {
    setLaunchChoice(choice);
    if (choice === CUSTOM_OPTION) return;
    setLaunchCmd(choice);
    const nextLauncher = detectSupervisorLauncher(choice);
    setSupervisorModel('');
    setModelChoice(DEFAULT_MODEL_OPTION);
    const reasoningOptions = reasoningOptionsFor(nextLauncher);
    setReasoningEffort(reasoningOptions.some((option) => option.value === reasoningEffort) ? reasoningEffort : '');
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
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(surfaceId)) next.delete(surfaceId);
      else next.add(surfaceId);
      return next;
    });
  };

  const choosePlanFile = async () => {
    try {
      const result = await (window as any).wmux?.markdown?.openFile?.();
      if (!result || result.canceled) return;
      if (result.error || !result.filePath) {
        window.alert(result.error || '无法读取计划文件。');
        return;
      }
      setPlanFilePath(result.filePath);
    } catch (err: any) {
      window.alert(`选择计划文件失败：${String(err?.message || err)}`);
    }
  };

  const configFileData = () => ({
    taskGoal,
    taskDescription,
    preconditions,
    stopWhen,
    stopWhenKind,
    planFilePath,
    supervisorLaunchCmd: launchCmd,
    supervisorModel,
    supervisorReasoningEffort: reasoningEffort,
    maxAutoDecisions: normalizeMaxAutoDecisions(maxAutoDecisions),
    autonomyPermissions,
    workScope,
    forbiddenActions,
  });

  const configFileDefaultPath = () => {
    const selectedTerminal = candidates.find((candidate) => selected.has(candidate.surfaceId) && candidate.projectDir)
      || supervisor.lanes.find((lane) => lane.enabled && lane.projectDir);
    if (!selectedTerminal?.projectDir) return undefined;
    const projectDir = selectedTerminal.projectDir.replace(/[\\/]+$/, '');
    return `${projectDir}\\.wmux\\ai-supervisor.wmux-supervisor.json`;
  };

  const saveConfigFile = async () => {
    const result = await (window as any).wmux?.supervisor?.saveConfig?.(
      configFileData(),
      configFileDefaultPath(),
    );
    if (!result || result.canceled) return;
    if (result.error) {
      window.alert(`保存监督配置失败：${result.error}`);
      return;
    }
    window.alert(`已保存监督配置：${result.filePath}`);
  };

  const loadConfigFile = async () => {
    const result = await (window as any).wmux?.supervisor?.loadConfig?.(configFileDefaultPath());
    if (!result || result.canceled) return;
    if (result.error || !result.config) {
      window.alert(`加载监督配置失败：${result.error || '文件内容无效'}`);
      return;
    }
    const config = result.config;
    const loadedLaunchCommand = config.supervisorLaunchCmd ?? 'pi';
    const loadedLauncherKind = detectSupervisorLauncher(loadedLaunchCommand);
    const loadedPlanFilePath = config.planFilePath || '';
    const loadedWorkScope = normalizeSupervisorWorkScope(config.workScope);
    setTaskGoal(config.taskGoal || '');
    setTaskDescription(config.taskDescription || '');
    setPreconditions(config.preconditions || '');
    setStopWhen(config.stopWhen || '');
    setStopWhenKind(config.stopWhenKind === 'direction' ? 'direction' : 'concrete');
    setPlanFilePath(loadedPlanFilePath);
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
  };

  const buildLanes = (preserveCurrentContext: boolean): SupervisorLane[] => {
    const lanes: SupervisorLane[] = [];
    for (const c of candidates) {
      if (!selected.has(c.surfaceId)) continue;
      const prev = supervisor.lanes.find((l) => l.surfaceId === c.surfaceId);
      const selectedSourceId = restoreSources[c.surfaceId];
      const selectedSource = restoreAuditHistory
        ? restoreCandidates[c.surfaceId]?.find((candidate) => candidate.surfaceId === selectedSourceId)
        : undefined;
      const keepsRestoredContext = !!selectedSource
        && prev?.restoreSource?.surfaceId === selectedSource.surfaceId;
      const keepsCurrentContext = preserveCurrentContext || keepsRestoredContext;
      const taskGoalOverride = taskGoalOverrides[c.surfaceId]?.trim();
      const stopWhenOverride = stopWhenOverrides[c.surfaceId]?.trim();
      const steps: SupervisorStep[] = [];
      lanes.push({
        id: prev?.id || `lane-${c.surfaceId}`,
        label: c.label,
        surfaceId: c.surfaceId,
        supervisorSurfaceId: prev?.supervisorSurfaceId || null,
        paneId: c.paneId,
        workspaceId: c.workspaceId,
        workspaceTitle: c.workspaceTitle,
        remoteSshControl: c.remoteSshControl,
        projectDir: c.projectDir,
        scopeRoot: sessionRetained ? prev?.scopeRoot || c.projectDir : c.projectDir,
        enabled: true,
        steps,
        maxAutoSteps: 0,
        autoStepsUsed: 0,
        awaitingStopCheck: false,
        stopConfirmed: false,
        awaitingReview: false,
        autoDecisionLimitReached: false,
        autoDecisionsUsed: 0,
        pendingSupervisorDeliveries: prev?.pendingSupervisorDeliveries || [],
        currentTask: keepsCurrentContext ? prev?.currentTask || '' : '',
        decisions: keepsCurrentContext ? prev?.decisions || [] : [],
        ...(taskGoalOverride ? { taskGoalOverride } : {}),
        ...(stopWhenOverride ? { stopWhenOverride } : {}),
        ...(selectedSource ? {
          restoreSource: {
            surfaceId: selectedSource.surfaceId,
            label: selectedSource.label,
            sessionId: selectedSource.sessionId,
          },
        } : {}),
        ...(keepsRestoredContext && prev?.restoredHistory ? { restoredHistory: prev.restoredHistory } : {}),
        ...(keepsRestoredContext && prev?.restoredFromSessionId ? { restoredFromSessionId: prev.restoredFromSessionId } : {}),
      });
    }
    return lanes;
  };

  const persistFields = (grantSessionAutonomy: boolean) => {
    patchSupervisor({
      mode: 'unified',
      directInstructions: '',
      goal: '',
      allowPaths: '',
      denyNotes: '',
      doneWhen: '',
      taskGoal,
      taskDescription,
      preconditions,
      stopWhen,
      stopWhenKind,
      planFilePath,
      planFileContent: '',
      restoreAuditHistory,
      supervisorLaunchCmd: launchCmd,
      supervisorModel: launcherKind === 'other' ? '' : supervisorModel,
      supervisorReasoningEffort: launcherKind === 'codex' || launcherKind === 'kimi' || launcherKind === 'pi'
        ? reasoningEffort
        : '',
      maxAutoSteps: 0,
      maxAutoDecisions: autonomous ? null : normalizeMaxAutoDecisions(maxAutoDecisions),
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
      const existingLocation = lane.supervisorSurfaceId
        ? terminalLocations.get(lane.supervisorSurfaceId)
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

  const sendDedicatedBriefings = () => {
    window.setTimeout(() => void (async () => {
      try {
        let session = useStore.getState().supervisor;
        if (session.restoreAuditHistory) {
          for (const lane of session.lanes) {
            if (!lane.restoreSource || lane.restoredFromSessionId || (lane.decisions?.length ?? 0) > 0) continue;
            const restored = await restoreSelectedLaneHistory(lane, lane.restoreSource);
            if (restored) useStore.getState().updateLane(lane.id, restored);
          }
          session = useStore.getState().supervisor;
        }
        const states = (window as any).__wmux_getAgentStates?.() || {};
        for (const lane of session.lanes) {
          if (!lane.supervisorSurfaceId) continue;
          const text = buildSupervisorBriefing(session, {
            lane,
            state: String(states[lane.surfaceId]?.state || 'unknown'),
          });
          sendToSurface(lane.supervisorSurfaceId, text, true);
        }
      } catch (err) {
        console.warn('[supervisor] briefing inject failed', err);
      }
    })(), SUPERVISOR_TUI_READY_DELAY_MS);
  };

  const applyConfig = (andStart: boolean) => {
    const lanes = buildLanes(!andStart || sessionRetained);
    if (lanes.length === 0) {
      window.alert('请至少选择一个要监控的终端。');
      return;
    }
    if (!stopWhen.trim()) {
      window.alert('请填写停止条件（方向型或具体条件型），供监督 AI 核对。');
      return;
    }
    if (andStart && !launchCmd.trim()) {
      window.alert('请选择可启动的监督 AI；“不自动启动”不能接收监督 briefing。');
      return;
    }

    if (andStart) {
      const result = ensureDedicatedSupervisors(lanes, true);
      if (!result.ok) {
        window.alert('无法为所有选中终端创建专属监督 AI；监督尚未启动，请重试。');
        return;
      }
      persistFields(true);
      setSupervisorLanes(result.lanes);
      startSupervisor();
      const workspaceId = useStore.getState().supervisor.supervisorWorkspaceId;
      if (workspaceId) selectWorkspace(workspaceId);
      sendDedicatedBriefings();
    } else {
      persistFields(false);
      setSupervisorLanes(lanes);
      closeSupervisorSetup();
    }
  };

  const openAiSession = () => {
    const lanes = buildLanes(sessionRetained);
    if (lanes.length === 0) {
      window.alert('请先至少选择一个要监控的终端。');
      return;
    }
    if (!stopWhen.trim()) {
      window.alert('请先填写停止条件。');
      return;
    }
    if (!launchCmd.trim()) {
      window.alert('请选择可启动的监督 AI；“不自动启动”不能接收监督 briefing。');
      return;
    }
    const result = ensureDedicatedSupervisors(lanes, true);
    if (!result.ok) {
      window.alert('无法为所有选中终端创建专属监督 AI，请重试。');
      return;
    }
    persistFields(false);
    setSupervisorLanes(result.lanes);
    closeSupervisorSetup();
    const workspaceId = useStore.getState().supervisor.supervisorWorkspaceId;
    if (workspaceId) selectWorkspace(workspaceId);
    sendDedicatedBriefings();
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
    && !taskGoalOverrides[candidate.surfaceId]?.trim()
    && !taskGoal.trim()
    && !planFilePath.trim()
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
                <div className="supervisor-dialog__group-description">选择工作终端，并按需为单个终端覆盖共享目标或停止条件。</div>
              </div>
              <span className="supervisor-dialog__count">已选 {selectedCandidates.length} 个</span>
            </div>
            <div className="supervisor-dialog__list">
              {candidates.length === 0 && (
                <div className="supervisor-dialog__empty">当前没有打开的终端。</div>
              )}
              {candidates.map((candidate) => {
                const isSelected = selected.has(candidate.surfaceId);
                return (
                  <div key={candidate.key} className="supervisor-dialog__terminal" data-selected={isSelected}>
                    <label className="supervisor-dialog__row">
                      <input
                        type="checkbox"
                        checked={isSelected}
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
                      <details className="supervisor-dialog__lane-settings">
                        <summary>单独设置此终端</summary>
                        <div className="supervisor-dialog__section">
                          <div className="supervisor-dialog__label">任务目标覆盖（可选）</div>
                          <textarea
                            className="supervisor-dialog__textarea"
                            aria-label={`${candidate.label} 的任务目标覆盖`}
                            rows={2}
                            value={taskGoalOverrides[candidate.surfaceId] || ''}
                            onChange={(event) => setTaskGoalOverrides((current) => ({
                              ...current,
                              [candidate.surfaceId]: event.target.value,
                            }))}
                            placeholder="留空则使用共享任务目标、当前任务事件或计划文件"
                          />
                        </div>
                        <div className="supervisor-dialog__section">
                          <div className="supervisor-dialog__label">停止条件覆盖（可选）</div>
                          <textarea
                            className="supervisor-dialog__textarea"
                            aria-label={`${candidate.label} 的停止条件覆盖`}
                            rows={2}
                            value={stopWhenOverrides[candidate.surfaceId] || ''}
                            onChange={(event) => setStopWhenOverrides((current) => ({
                              ...current,
                              [candidate.surfaceId]: event.target.value,
                            }))}
                            placeholder="留空则使用下方共享停止条件"
                          />
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
            {insufficientCandidates.length > 0 && (
              <div className="supervisor-dialog__warning" role="status">
                {insufficientCandidates.map((candidate) => candidate.label).join('、')}：可停止裁决，但自主推进依据不足。请填写任务目标、终端覆盖目标或选择计划文件。
              </div>
            )}
          </section>

          <section className="supervisor-dialog__group">
            <div className="supervisor-dialog__group-title">2. 停止裁决</div>
            <div className="supervisor-dialog__group-description">这是监督 AI 判断继续、返工、完成或交给人工的核心依据。</div>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">停止条件类型</div>
              <div className="supervisor-dialog__freedom">
                {(['concrete', 'direction'] as StopWhenKind[]).map((kind) => (
                  <label key={kind} className="supervisor-dialog__radio" data-active={stopWhenKind === kind}>
                    <input
                      type="radio"
                      name="stopWhenKind"
                      checked={stopWhenKind === kind}
                      onChange={() => setStopWhenKind(kind)}
                    />
                    <span>{stopWhenKindLabel(kind)}{kind === 'concrete' ? ' — 可核对事实' : ' — 期望终态/方向'}</span>
                  </label>
                ))}
              </div>
              <div className="supervisor-dialog__hint">{stopWhenKindHint(stopWhenKind)}</div>
            </section>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label supervisor-dialog__label--required">
                停止条件参考 <span className="supervisor-dialog__required" aria-hidden="true">*</span>
                {' '}· {stopWhenKindLabel(stopWhenKind)}
              </div>
              <textarea
                className="supervisor-dialog__textarea"
                aria-label="停止条件参考"
                rows={2}
                value={stopWhen}
                onChange={(event) => setStopWhen(event.target.value)}
                placeholder={stopWhenKind === 'direction'
                  ? '例如：登录流程可用，错误提示合理，不要大范围重构'
                  : '例如：npm test 全绿 / 终端出现 BUILD SUCCESS'}
                required
              />
              <div className="supervisor-dialog__hint">终端本轮结束后，监督 AI 会先核对当前证据，不会把“任务结束”直接视为条件已满足。</div>
            </section>
          </section>

          <section className="supervisor-dialog__group">
            <div className="supervisor-dialog__group-title">3. 补充依据</div>
            <div className="supervisor-dialog__group-description">用于补足监督 AI 的任务目标、验收依据与已确认事实。</div>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">共享任务目标（可选）</div>
              <textarea
                className="supervisor-dialog__textarea"
                aria-label="共享任务目标"
                rows={2}
                value={taskGoal}
                onChange={(event) => setTaskGoal(event.target.value)}
                placeholder="例如：修复登录流程并保持现有对外行为"
              />
              <div className="supervisor-dialog__hint">当终端还没有任务事件、也未选择计划文件时，建议填写；不会直接注入工作终端。</div>
            </section>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">停止条件补充说明（可选）</div>
              <textarea
                className="supervisor-dialog__textarea"
                aria-label="停止条件补充说明"
                rows={2}
                value={taskDescription}
                onChange={(event) => setTaskDescription(event.target.value)}
                placeholder="例如：认证修复完成后保持现有对外行为，以登录可用和测试通过作为结束参考"
              />
              <div className="supervisor-dialog__hint">仅补充停止条件的背景和验收语境，不会注入工作终端。</div>
            </section>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">计划文件（可选 · Markdown/文本）</div>
              <div className="supervisor-dialog__plan-actions">
                <input
                  className="supervisor-dialog__input"
                  aria-label="计划文件"
                  value={planFilePath}
                  readOnly
                  title={planFilePath}
                  placeholder="未选择；选择后仅把路径提供给监督 AI"
                />
                <button type="button" className="confirm-dialog__btn" onClick={() => void choosePlanFile()}>
                  选择文件
                </button>
                {planFilePath && (
                  <button
                    type="button"
                    className="confirm-dialog__btn"
                    onClick={() => {
                      setPlanFilePath('');
                      if (workScope === 'plan-defined') setWorkScope('task-files');
                    }}
                  >
                    清除
                  </button>
                )}
              </div>
              <div className="supervisor-dialog__hint">监督 AI 首次使用或发现文件更新时才重新读取，并结合最新范围、验收与约束裁决。</div>
            </section>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">前置条件 / 已确认环境信息（可选）</div>
              <textarea
                className="supervisor-dialog__textarea"
                aria-label="前置条件和已确认环境信息"
                rows={2}
                value={preconditions}
                onChange={(event) => setPreconditions(event.target.value)}
                placeholder="例如：设备已上电；测试台安全状态已确认；必要账号已登录"
              />
              <div className="supervisor-dialog__hint">本次监督会话内视为已确认；证据显示条件变化或失效时才再次交给人工。</div>
            </section>
          </section>

          <section className="supervisor-dialog__group">
            <div className="supervisor-dialog__group-title">4. 自主权限与边界</div>
            <div className="supervisor-dialog__group-description">明确监督 AI 可以自主处理的动作，以及本次任务额外禁止的变化。</div>
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
                    const disabled = scope === 'plan-defined' && !planFilePath;
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
                disabled={autonomous}
              />
              <div className="supervisor-dialog__hint">
                {autonomous
                  ? '全自动监督已启用：本会话不使用自动判断次数上限。'
                  : '每个终端独立计数；留空表示不限制，填写 1–20 后达到上限会等待人工审阅。'}
              </div>
            </section>
          </section>

          <details className="supervisor-dialog__advanced">
            <summary>5. 高级设置</summary>
            <div className="supervisor-dialog__advanced-content">
              <section className="supervisor-dialog__section">
                <div className="supervisor-dialog__label">监督 AI 启动器</div>
                <select
                  className="supervisor-dialog__input"
                  value={launchChoice}
                  onChange={(event) => changeLauncher(event.target.value)}
                >
                  {SUPERVISOR_LAUNCH_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                  <option value={CUSTOM_OPTION}>自定义命令</option>
                </select>
                {launchChoice === CUSTOM_OPTION && (
                  <input
                    className="supervisor-dialog__input supervisor-dialog__stacked-input"
                    value={launchCmd}
                    onChange={(event) => setLaunchCmd(event.target.value)}
                    placeholder="例如：&quot;C:\\Tools\\codex.exe&quot;"
                  />
                )}
                <div className="supervisor-dialog__hint">每个工作终端独立启动一个监督上下文。</div>
              </section>
              {(launcherModelOptions.length > 0 || launcherKind === 'pi') && (
                <section className="supervisor-dialog__section">
                  <div className="supervisor-dialog__label">{supervisorLauncherDisplayName(launcherKind)} 监督模型</div>
                  <select
                    className="supervisor-dialog__input"
                    value={modelChoice}
                    onChange={(event) => {
                      const choice = event.target.value;
                      setModelChoice(choice);
                      if (choice === DEFAULT_MODEL_OPTION) setSupervisorModel('');
                      else if (choice !== CUSTOM_OPTION) setSupervisorModel(choice);
                    }}
                  >
                    <option value={DEFAULT_MODEL_OPTION}>使用 {supervisorLauncherDisplayName(launcherKind)} 默认模型</option>
                    {launcherModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                    <option value={CUSTOM_OPTION}>{customModelOptionLabel(launcherKind)}</option>
                  </select>
                  {modelChoice === CUSTOM_OPTION && (
                    <input
                      className="supervisor-dialog__input supervisor-dialog__stacked-input"
                      value={supervisorModel}
                      onChange={(event) => setSupervisorModel(event.target.value)}
                      placeholder={customModelPlaceholder(launcherKind)}
                    />
                  )}
                </section>
              )}
              {launcherKind === 'codex' && (
                <section className="supervisor-dialog__section">
                  <div className="supervisor-dialog__label">Codex 推理程度</div>
                  <select
                    className="supervisor-dialog__input"
                    value={reasoningEffort}
                    onChange={(event) => setReasoningEffort(event.target.value)}
                  >
                    <option value="">使用 Codex 默认推理程度</option>
                    {REASONING_EFFORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </section>
              )}
              {launcherKind === 'kimi' && (
                <section className="supervisor-dialog__section">
                  <div className="supervisor-dialog__label">Kimi Thinking</div>
                  <select
                    className="supervisor-dialog__input"
                    value={reasoningEffort}
                    onChange={(event) => setReasoningEffort(event.target.value)}
                  >
                    {KIMI_THINKING_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </section>
              )}
              {launcherKind === 'pi' && (
                <section className="supervisor-dialog__section">
                  <div className="supervisor-dialog__label">Pi Thinking</div>
                  <select
                    className="supervisor-dialog__input"
                    value={reasoningEffort}
                    onChange={(event) => setReasoningEffort(event.target.value)}
                  >
                    <option value="">使用 Pi 默认 Thinking 设置</option>
                    {PI_THINKING_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
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
                    导入配置…
                  </button>
                  <button type="button" className="confirm-dialog__btn" onClick={() => void saveConfigFile()}>
                    导出配置…
                  </button>
                </div>
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
            onClick={supervisor.paused ? closeSupervisorSetup : () => applyConfig(true)}
          >
            {primaryActionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
