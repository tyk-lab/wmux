import { useMemo, useState, useEffect } from 'react';
import { useStore } from '../../store';
import { SurfaceId, WorkspaceId, PaneId, SplitNode } from '../../../shared/types';
import type {
  StopWhenKind,
  SupervisorLane,
  SupervisorStep,
} from '../../store/supervisor-slice';
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
import { buildSupervisorLaunchCommand } from '../../supervisor/launch-command';
import { sendToSurface } from '../../supervisor/supervisor-engine';
import { createLeaf, getAllPaneIds } from '../../store/split-utils';
import '../../styles/supervisor.css';

const CODEX_MODEL_OPTIONS = [
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol（复杂监督）' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra（均衡）' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna（快速、重复性监督）' },
];
const SUPERVISOR_LAUNCH_OPTIONS = [
  { value: 'codex', label: 'Codex（推荐）' },
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
const CUSTOM_OPTION = '__custom__';

function knownOptionValue(value: string, options: Array<{ value: string }>, fallback = CUSTOM_OPTION): string {
  return options.some((option) => option.value === value.trim()) ? value.trim() : fallback;
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
  const createWorkspace = useStore((s) => s.createWorkspace);
  const selectWorkspace = useStore((s) => s.selectWorkspace);

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
        list.push({
          key: s.surfaceId,
          surfaceId: s.surfaceId,
          workspaceId: ws.id,
          paneId: s.paneId,
          workspaceTitle: ws.title,
          projectDir: ws.cwd || s.projectDir,
          label: meta?.label || s.title,
          state: String(st),
        });
      }
    }
    return list;
  }, [workspaces, agentMeta, agentStates, supervisor.lanes]);

  const [taskDescription, setTaskDescription] = useState(supervisor.taskDescription || '');
  const [preconditions, setPreconditions] = useState(supervisor.preconditions || '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
    supervisor.supervisorModel
      ? knownOptionValue(supervisor.supervisorModel, CODEX_MODEL_OPTIONS)
      : '__default__',
  );
  const [reasoningEffort, setReasoningEffort] = useState(supervisor.supervisorReasoningEffort || '');
  const [maxAutoDecisions, setMaxAutoDecisions] = useState(
    supervisor.maxAutoDecisions ? String(supervisor.maxAutoDecisions) : '',
  );

  useEffect(() => {
    if (!setupOpen) return;
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
    setModelChoice(supervisor.supervisorModel
      ? knownOptionValue(supervisor.supervisorModel, CODEX_MODEL_OPTIONS)
      : '__default__');
    setReasoningEffort(supervisor.supervisorReasoningEffort || '');
    setMaxAutoDecisions(supervisor.maxAutoDecisions ? String(supervisor.maxAutoDecisions) : '');
    setSelected(new Set(supervisor.lanes.filter((l) => l.enabled).map((l) => l.surfaceId)));
  }, [setupOpen]);

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
    taskDescription,
    preconditions,
    stopWhen,
    stopWhenKind,
    planFilePath,
    supervisorLaunchCmd: launchCmd,
    supervisorModel,
    supervisorReasoningEffort: reasoningEffort,
    maxAutoDecisions: normalizeMaxAutoDecisions(maxAutoDecisions),
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
    setTaskDescription(config.taskDescription || '');
    setPreconditions(config.preconditions || '');
    setStopWhen(config.stopWhen || '');
    setStopWhenKind(config.stopWhenKind === 'direction' ? 'direction' : 'concrete');
    setPlanFilePath(config.planFilePath || '');
    setLaunchCmd(config.supervisorLaunchCmd || 'codex');
    setLaunchChoice(knownOptionValue(config.supervisorLaunchCmd || 'codex', SUPERVISOR_LAUNCH_OPTIONS));
    setSupervisorModel(config.supervisorModel || '');
    setModelChoice(config.supervisorModel
      ? knownOptionValue(config.supervisorModel, CODEX_MODEL_OPTIONS)
      : '__default__');
    setReasoningEffort(config.supervisorReasoningEffort || '');
    setMaxAutoDecisions(config.maxAutoDecisions ? String(config.maxAutoDecisions) : '');
  };

  const buildLanes = (): SupervisorLane[] => {
    const lanes: SupervisorLane[] = [];
    let i = 0;
    for (const c of candidates) {
      if (!selected.has(c.surfaceId)) continue;
      i += 1;
      const prev = supervisor.lanes.find((l) => l.surfaceId === c.surfaceId);
      const selectedSourceId = restoreSources[c.surfaceId];
      const selectedSource = restoreAuditHistory
        ? restoreCandidates[c.surfaceId]?.find((candidate) => candidate.surfaceId === selectedSourceId)
        : undefined;
      const keepsRestoredContext = prev?.restoreSource?.surfaceId === selectedSource?.surfaceId;
      const steps: SupervisorStep[] = [];
      lanes.push({
        id: prev?.id || `lane-${i}`,
        label: c.label,
        surfaceId: c.surfaceId,
        supervisorSurfaceId: prev?.supervisorSurfaceId || null,
        paneId: c.paneId,
        workspaceId: c.workspaceId,
        workspaceTitle: c.workspaceTitle,
        projectDir: c.projectDir,
        enabled: true,
        steps,
        maxAutoSteps: 0,
        autoStepsUsed: 0,
        awaitingStopCheck: false,
        stopConfirmed: false,
        awaitingReview: false,
        autoDecisionLimitReached: false,
        autoDecisionsUsed: 0,
        currentTask: keepsRestoredContext ? prev?.currentTask || '' : '',
        decisions: keepsRestoredContext ? prev?.decisions || [] : [],
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

  const persistFields = () => {
    patchSupervisor({
      mode: 'unified',
      taskDescription,
      preconditions,
      stopWhen,
      stopWhenKind,
      planFilePath,
      planFileContent: '',
      restoreAuditHistory,
      supervisorLaunchCmd: launchCmd,
      supervisorModel,
      supervisorReasoningEffort: reasoningEffort,
      maxAutoSteps: 0,
      maxAutoDecisions: normalizeMaxAutoDecisions(maxAutoDecisions),
    });
  };

  const ensureDedicatedSupervisors = (lanes: SupervisorLane[]): SupervisorLane[] => {
    const launchCommand = buildSupervisorLaunchCommand(launchCmd, supervisorModel, reasoningEffort);
    const startupCommands = launchCommand ? [launchCommand] : undefined;
    const existingTerminalIds = new Set<SurfaceId>();
    for (const workspace of workspaces) {
      const terminals: Array<{ surfaceId: SurfaceId; paneId: PaneId; title: string; projectDir?: string }> = [];
      collectTerminals(workspace.splitTree, terminals);
      for (const terminal of terminals) existingTerminalIds.add(terminal.surfaceId);
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
    if (!supervisorWorkspace || !targetPaneId) return lanes;

    return lanes.map((lane) => {
      if (
        (lane.supervisorSurfaceId && existingTerminalIds.has(lane.supervisorSurfaceId))
      ) {
        return lane;
      }
      const supervisorSurfaceId = addSurface(supervisorWorkspace.id, targetPaneId, 'terminal', {
        customTitle: supervisorTabTitle(lane.label),
        cwd: lane.projectDir,
        startupCommands,
      });
      return { ...lane, supervisorSurfaceId };
    });
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
    })(), 1200);
  };

  const applyConfig = (andStart: boolean) => {
    const lanes = buildLanes();
    if (lanes.length === 0) {
      window.alert('请至少选择一个要监控的终端。');
      return;
    }
    if (!taskDescription.trim()) {
      window.alert('请填写任务说明，供监督 AI 理解要监督的工作。');
      return;
    }
    if (!stopWhen.trim()) {
      window.alert('请填写停止条件（方向型或具体条件型），供监督 AI 核对。');
      return;
    }

    persistFields();
    const configuredLanes = andStart ? ensureDedicatedSupervisors(lanes) : lanes;
    setSupervisorLanes(configuredLanes);
    if (andStart && configuredLanes.some((lane) => !lane.supervisorSurfaceId)) {
      window.alert('无法为所有选中终端创建专属监督 AI；调度尚未启动，请重试。');
      return;
    }
    if (andStart) {
      startSupervisor();
      const workspaceId = useStore.getState().supervisor.supervisorWorkspaceId;
      if (workspaceId) selectWorkspace(workspaceId);
      sendDedicatedBriefings();
    }
    else closeSupervisorSetup();
  };

  const openAiSession = () => {
    const lanes = buildLanes();
    if (lanes.length === 0) {
      window.alert('请先至少选择一个要监控的终端。');
      return;
    }
    if (!taskDescription.trim()) {
      window.alert('请先填写任务说明。');
      return;
    }
    if (!stopWhen.trim()) {
      window.alert('请先填写停止条件。');
      return;
    }
    persistFields();
    const isolatedLanes = ensureDedicatedSupervisors(lanes);
    setSupervisorLanes(isolatedLanes);
    if (isolatedLanes.some((lane) => !lane.supervisorSurfaceId)) {
      window.alert('无法为所有选中终端创建专属监督 AI，请重试。');
      return;
    }
    closeSupervisorSetup();
    const workspaceId = useStore.getState().supervisor.supervisorWorkspaceId;
    if (workspaceId) selectWorkspace(workspaceId);
    sendDedicatedBriefings();
  };

  return (
    <div className="confirm-dialog__overlay supervisor-dialog__overlay">
      <div
        className="supervisor-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="AI 监督"
      >
        <div className="supervisor-dialog__title">AI 监督</div>
        <div className="supervisor-dialog__sub">
          统一监督：工作终端仍由你正常下达任务；每个选中的终端会创建独立、可见的监督 AI 上下文。
        </div>

        <section className="supervisor-dialog__section">
          <div className="supervisor-dialog__label">监控终端</div>
          <div className="supervisor-dialog__list">
            {candidates.length === 0 && (
              <div className="supervisor-dialog__empty">当前没有打开的终端。</div>
            )}
            {candidates.map((c) => (
              <label key={c.key} className="supervisor-dialog__row">
                <input
                  type="checkbox"
                  checked={selected.has(c.surfaceId)}
                  onChange={() => toggle(c.surfaceId)}
                />
                <span className="supervisor-dialog__row-main">
                  <span className="supervisor-dialog__row-label">{c.label}</span>
                  <span className="supervisor-dialog__row-meta">
                    {c.workspaceTitle} · {c.state} · {c.surfaceId.slice(0, 12)}…
                  </span>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="supervisor-dialog__section">
          <div className="supervisor-dialog__label">计划文件（可选 · 任务背景参考 · Markdown/文本）</div>
          <div className="supervisor-dialog__plan-actions">
            <input
              className="supervisor-dialog__input"
              value={planFilePath}
              readOnly
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
                }}
              >
                清除
              </button>
            )}
          </div>
          <div className="supervisor-dialog__hint">
            仅把文件路径提供给专属监督 AI；它需要时可自行读取，文件正文不会粘贴进启动输入。不是停止条件或硬约束，不会注入工作终端，也不会覆盖任务说明、终端证据或人工决定。
          </div>
        </section>

        <section className="supervisor-dialog__section">
          <label className="supervisor-dialog__row">
            <input
              type="checkbox"
              checked={restoreAuditHistory}
              onChange={(event) => setRestoreAuditHistory(event.target.checked)}
            />
            <span className="supervisor-dialog__row-main">
              <span className="supervisor-dialog__row-label">恢复审计上下文（手动选择来源）</span>
              <span className="supervisor-dialog__row-meta">
                默认关闭：从同项目的历史终端中手动选择来源，不比较当前终端 ID。
              </span>
            </span>
          </label>
          <div className="supervisor-dialog__hint">
            为每个已选终端手动选择历史来源；不会比较当前终端 ID。恢复内容仅含任务、终端事件和监督裁决摘要；“重头再来”废除的历史不会列出，计划文件需重新选择。
          </div>
          {restoreAuditHistory && candidates.filter((candidate) => selected.has(candidate.surfaceId)).map((candidate) => {
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

        <section className="supervisor-dialog__section">
          <div className="supervisor-dialog__label supervisor-dialog__label--required">
            任务说明 <span className="supervisor-dialog__required" aria-hidden="true">*</span>
          </div>
          <textarea
            className="supervisor-dialog__textarea"
            rows={3}
            value={taskDescription}
            onChange={(e) => setTaskDescription(e.target.value)}
            placeholder="例如：监督认证模块修复与验证，保持现有对外行为"
            required
          />
          <div className="supervisor-dialog__hint">仅提供给该终端的监督 AI，用于理解正在审查的工作；不会注入工作终端。</div>
        </section>
        <section className="supervisor-dialog__section">
          <div className="supervisor-dialog__label">前置条件 / 已确认环境信息（可选）</div>
          <textarea
            className="supervisor-dialog__textarea"
            rows={2}
            value={preconditions}
            onChange={(e) => setPreconditions(e.target.value)}
            placeholder={'例如：设备已上电；急停和防护措施已确认；测试台处于安全状态'}
          />
          <div className="supervisor-dialog__hint">本次监督内视为你已确认的环境与安全前提，不会因历史“下次确认”提示而重复打扰；仅在终端证据显示条件变化、缺失或出现新的危险操作时才会交给你确认。不是任务或停止条件。</div>
        </section>
        <section className="supervisor-dialog__section">
          <div className="supervisor-dialog__label">停止条件类型（监督 AI 裁决参考）</div>
          <div className="supervisor-dialog__freedom">
            {(['concrete', 'direction'] as StopWhenKind[]).map((k) => (
              <label key={k} className="supervisor-dialog__radio" data-active={stopWhenKind === k}>
                <input type="radio" name="stopWhenKind" checked={stopWhenKind === k} onChange={() => setStopWhenKind(k)} />
                <span>{stopWhenKindLabel(k)}{k === 'concrete' ? ' — 可核对事实' : ' — 期望终态/方向'}</span>
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
            rows={2}
            value={stopWhen}
            onChange={(e) => setStopWhen(e.target.value)}
            placeholder={stopWhenKind === 'direction'
              ? '例如：登录流程可用，错误提示合理，不要大范围重构'
              : '例如：npm test 全绿 / 终端出现 BUILD SUCCESS'}
            required
          />
          <div className="supervisor-dialog__hint">工作终端结束本轮后，监督 AI 先查看证据，再据此提出继续、返工、完成或交给人工的裁决。</div>
        </section>
        <section className="supervisor-dialog__section">
          <div className="supervisor-dialog__label">监督 AI 启动器</div>
          <select
            className="supervisor-dialog__input"
            value={launchChoice}
            onChange={(e) => {
              const choice = e.target.value;
              setLaunchChoice(choice);
              if (choice !== CUSTOM_OPTION) setLaunchCmd(choice);
            }}
          >
            {SUPERVISOR_LAUNCH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
            <option value={CUSTOM_OPTION}>自定义命令</option>
          </select>
          {launchChoice === CUSTOM_OPTION && (
            <input
              className="supervisor-dialog__input"
              value={launchCmd}
              onChange={(e) => setLaunchCmd(e.target.value)}
              placeholder="例如：&quot;C:\\Tools\\codex.exe&quot;"
            />
          )}
          <div className="supervisor-dialog__hint">每个终端独立启动。自定义命令可用于已安装的兼容 AI 启动器。</div>
        </section>
        <section className="supervisor-dialog__section">
          <div className="supervisor-dialog__label">Codex 监督模型</div>
          <select
            className="supervisor-dialog__input"
            value={modelChoice}
            onChange={(e) => {
              const choice = e.target.value;
              setModelChoice(choice);
              if (choice === '__default__') setSupervisorModel('');
              else if (choice !== CUSTOM_OPTION) setSupervisorModel(choice);
            }}
          >
            <option value="__default__">使用 Codex 默认模型</option>
            {CODEX_MODEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
            <option value={CUSTOM_OPTION}>自定义模型 ID</option>
          </select>
          {modelChoice === CUSTOM_OPTION && (
            <input
              className="supervisor-dialog__input"
              value={supervisorModel}
              onChange={(e) => setSupervisorModel(e.target.value)}
              placeholder="输入账户可用的模型 ID"
            />
          )}
          <div className="supervisor-dialog__hint">仅对 Codex 生效；选择后以 `--model` 传入。其他启动器请在自定义命令中指定模型。</div>
        </section>
        <section className="supervisor-dialog__section">
          <div className="supervisor-dialog__label">Codex 推理程度</div>
          <select
            className="supervisor-dialog__input"
            value={reasoningEffort}
            onChange={(e) => setReasoningEffort(e.target.value)}
          >
            <option value="">使用 Codex 默认推理程度</option>
            {REASONING_EFFORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <div className="supervisor-dialog__hint">仅对 Codex 生效；选择后以 `--config model_reasoning_effort=…` 传入，推理越高响应越慢、消耗越多。</div>
        </section>
        <section className="supervisor-dialog__section">
          <div className="supervisor-dialog__label">最大自动判断次数</div>
          <input
            className="supervisor-dialog__input"
            type="number"
            min={1}
            max={20}
            step={1}
            placeholder="不限制"
            value={maxAutoDecisions}
            onChange={(e) => setMaxAutoDecisions(e.target.value)}
          />
          <div className="supervisor-dialog__hint">每个监控终端独立计数。留空表示不限制；填写 1–20 后，达到次数会暂停 AI 自动裁决，须经你人工审阅才会继续。</div>
        </section>

        <div className="supervisor-dialog__actions">
          <button type="button" className="confirm-dialog__btn" onClick={() => void loadConfigFile()}>
            加载配置
          </button>
          <button type="button" className="confirm-dialog__btn" onClick={() => void saveConfigFile()}>
            保存配置
          </button>
          <button type="button" className="confirm-dialog__btn" onClick={closeSupervisorSetup}>
            取消
          </button>
          {supervisor.active && (
            <button type="button" className="confirm-dialog__btn" onClick={() => stopSupervisor()}>
              停止调度
            </button>
          )}
          <button type="button" className="confirm-dialog__btn" onClick={() => applyConfig(false)}>
            仅保存
          </button>
          <button
            type="button"
            className="confirm-dialog__btn supervisor-dialog__btn-ai"
            onClick={openAiSession}
          >
            创建专属监督 AI
          </button>
          <button
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--danger"
            onClick={() => applyConfig(true)}
          >
            {supervisor.active ? '应用并继续运行' : '启动'}
          </button>
        </div>
      </div>
    </div>
  );
}
