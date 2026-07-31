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
import { sendToSurface } from '../../supervisor/supervisor-engine';
import { createLeaf, getAllPaneIds } from '../../store/split-utils';
import '../../styles/supervisor.css';

const MAX_PLAN_CHARS = 30_000;

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stopWhen, setStopWhen] = useState(supervisor.stopWhen);
  const [stopWhenKind, setStopWhenKind] = useState<StopWhenKind>(
    supervisor.stopWhenKind || 'concrete',
  );
  const [planFilePath, setPlanFilePath] = useState(supervisor.planFilePath);
  const [planFileContent, setPlanFileContent] = useState(supervisor.planFileContent);
  const [restoreAuditHistory, setRestoreAuditHistory] = useState(supervisor.restoreAuditHistory);
  const [restoreCandidates, setRestoreCandidates] = useState<Record<string, SupervisorRestoreCandidate[]>>({});
  const [restoreSources, setRestoreSources] = useState<Record<string, string>>({});
  const [launchCmd, setLaunchCmd] = useState(supervisor.supervisorLaunchCmd);

  useEffect(() => {
    if (!setupOpen) return;
    setTaskDescription(supervisor.taskDescription || '');
    setStopWhen(supervisor.stopWhen || '');
    setStopWhenKind(supervisor.stopWhenKind || 'concrete');
    setPlanFilePath(supervisor.planFilePath || '');
    setPlanFileContent(supervisor.planFileContent || '');
    setRestoreAuditHistory(supervisor.restoreAuditHistory === true);
    setRestoreSources(Object.fromEntries(
      supervisor.lanes.flatMap((lane) => lane.restoreSource ? [[lane.surfaceId, lane.restoreSource.surfaceId]] : []),
    ));
    setLaunchCmd(supervisor.supervisorLaunchCmd || '');
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
      if (result.error || typeof result.content !== 'string' || !result.filePath) {
        window.alert(result.error || '无法读取计划文件。');
        return;
      }
      if (result.content.length > MAX_PLAN_CHARS) {
        window.alert(`计划文件超过 ${MAX_PLAN_CHARS.toLocaleString()} 字符，无法安全注入监督 AI 上下文。`);
        return;
      }
      setPlanFilePath(result.filePath);
      setPlanFileContent(result.content);
    } catch (err: any) {
      window.alert(`选择计划文件失败：${String(err?.message || err)}`);
    }
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
      stopWhen,
      stopWhenKind,
      planFilePath,
      planFileContent,
      restoreAuditHistory,
      supervisorLaunchCmd: launchCmd,
      maxAutoSteps: 0,
    });
  };

  const ensureDedicatedSupervisors = (lanes: SupervisorLane[]): SupervisorLane[] => {
    const startupCommands = launchCmd.trim() ? [launchCmd.trim()] : undefined;
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
          <div className="supervisor-dialog__label">计划文件（可选 · Markdown/文本）</div>
          <div className="supervisor-dialog__plan-actions">
            <input
              className="supervisor-dialog__input"
              value={planFilePath}
              readOnly
              placeholder="未选择；选择后作为监督 AI 的方向与约束"
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
                  setPlanFileContent('');
                }}
              >
                清除
              </button>
            )}
          </div>
          <div className="supervisor-dialog__hint">
            仅供专属监督 AI 读取；与任务说明冲突时，以计划文件为准，不会注入工作终端。
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
          <div className="supervisor-dialog__label">监督 AI 启动命令（每个终端独立启动，默认 codex）</div>
          <input
            className="supervisor-dialog__input"
            value={launchCmd}
            onChange={(e) => setLaunchCmd(e.target.value)}
            placeholder="codex（可改为 claude 或留空）"
          />
        </section>

        <div className="supervisor-dialog__actions">
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
