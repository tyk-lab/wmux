import { useMemo, useState, useEffect } from 'react';
import { useStore } from '../../store';
import { SurfaceId, WorkspaceId, PaneId, SplitNode } from '../../../shared/types';
import type {
  StopWhenKind,
  SupervisorLane,
  SupervisorMode,
  SupervisorStep,
} from '../../store/supervisor-slice';
import {
  buildSupervisorBriefing,
  modeDescription,
  modeLabel,
  stopWhenKindHint,
  stopWhenKindLabel,
  SUPERVISOR_TAB_TITLE,
  SUPERVISOR_WORKSPACE_TITLE,
  supervisorTabTitle,
} from '../../supervisor/protocol';
import { restoreLatestLaneHistory } from '../../supervisor/recording';
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

function parseInstructionLines(text: string): SupervisorStep[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => ({
      id: `s${i + 1}`,
      title: line.slice(0, 48),
      prompt: line,
      status: 'pending' as const,
    }));
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

  const [mode, setMode] = useState<SupervisorMode>(supervisor.mode || 'direct');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [directInstructions, setDirectInstructions] = useState(supervisor.directInstructions);
  const [stopWhen, setStopWhen] = useState(supervisor.stopWhen);
  const [stopWhenKind, setStopWhenKind] = useState<StopWhenKind>(
    supervisor.stopWhenKind || 'concrete',
  );
  const [goal, setGoal] = useState(supervisor.goal);
  const [allowPaths, setAllowPaths] = useState(supervisor.allowPaths);
  const [denyNotes, setDenyNotes] = useState(supervisor.denyNotes);
  const [doneWhen, setDoneWhen] = useState(supervisor.doneWhen);
  const [planFilePath, setPlanFilePath] = useState(supervisor.planFilePath);
  const [planFileContent, setPlanFileContent] = useState(supervisor.planFileContent);
  const [restoreAuditHistory, setRestoreAuditHistory] = useState(supervisor.restoreAuditHistory);
  const [launchCmd, setLaunchCmd] = useState(supervisor.supervisorLaunchCmd);
  const [maxAuto, setMaxAuto] = useState(supervisor.maxAutoSteps ?? 3);

  useEffect(() => {
    if (!setupOpen) return;
    setMode(supervisor.mode || 'direct');
    setDirectInstructions(supervisor.directInstructions || '');
    setStopWhen(supervisor.stopWhen || '');
    setStopWhenKind(supervisor.stopWhenKind || 'concrete');
    setGoal(supervisor.goal || '');
    setAllowPaths(supervisor.allowPaths || '');
    setDenyNotes(supervisor.denyNotes || '');
    setDoneWhen(supervisor.doneWhen || '');
    setPlanFilePath(supervisor.planFilePath || '');
    setPlanFileContent(supervisor.planFileContent || '');
    setRestoreAuditHistory(supervisor.restoreAuditHistory === true);
    setLaunchCmd(supervisor.supervisorLaunchCmd || '');
    setMaxAuto(supervisor.maxAutoSteps ?? 3);
    setSelected(new Set(supervisor.lanes.filter((l) => l.enabled).map((l) => l.surfaceId)));
  }, [setupOpen]);

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
    const directSteps = parseInstructionLines(directInstructions);
    const lanes: SupervisorLane[] = [];
    let i = 0;
    for (const c of candidates) {
      if (!selected.has(c.surfaceId)) continue;
      i += 1;
      const prev = supervisor.lanes.find((l) => l.surfaceId === c.surfaceId);
      let steps: SupervisorStep[];
      if (mode === 'direct') {
        steps = directSteps.map((s) => ({ ...s }));
      } else {
        // goal-chase: empty queue — engine synthesizes decision steps
        steps = [];
      }
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
        maxAutoSteps: maxAuto,
        autoStepsUsed: 0,
        awaitingStopCheck: false,
        stopConfirmed: false,
        awaitingReview: false,
        currentTask: prev?.currentTask || '',
        decisions: prev?.decisions || [],
        restoredHistory: prev?.restoredHistory,
        restoredFromSessionId: prev?.restoredFromSessionId,
      });
    }
    return lanes;
  };

  const persistFields = () => {
    patchSupervisor({
      mode,
      directInstructions,
      stopWhen,
      stopWhenKind,
      goal,
      allowPaths,
      denyNotes,
      doneWhen,
      planFilePath,
      planFileContent,
      restoreAuditHistory,
      supervisorLaunchCmd: launchCmd,
      maxAutoSteps: maxAuto,
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
            if (lane.restoredFromSessionId || (lane.decisions?.length ?? 0) > 0) continue;
            const restored = await restoreLatestLaneHistory(lane);
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
    if (mode === 'direct') {
      if (!directInstructions.trim()) {
        window.alert('直接注入模式：请填写要原样注入的指令（每行一步）。');
        return;
      }
      if (!stopWhen.trim()) {
        window.alert(
          '直接注入模式必须填写停止条件。\n指令跑完后不会自动收工，只有确认达到停止条件才停止注入。',
        );
        return;
      }
    } else {
      if (!goal.trim()) {
        window.alert('目标追逐模式：请填写目标。');
        return;
      }
      if (!doneWhen.trim()) {
        window.alert(
          '目标追逐模式请填写完成/停止条件（方向型或具体条件型），供监督 AI 判断是否该停。',
        );
        return;
      }
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
    if (mode === 'direct') {
      if (!directInstructions.trim()) {
        window.alert('请先填写要注入的指令。');
        return;
      }
      if (!stopWhen.trim()) {
        window.alert('直接注入模式请填写停止条件，供监督 AI 核对是否结束。');
        return;
      }
    } else {
      if (!goal.trim()) {
        window.alert('请先填写目标。');
        return;
      }
      if (!doneWhen.trim()) {
        window.alert('请先填写完成/停止条件。');
        return;
      }
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
          两种模式二选一；每个选中的终端会创建独立、可见的监督 AI 上下文。
        </div>

        <div className="supervisor-dialog__mode-tabs">
          {(['direct', 'goal-chase'] as SupervisorMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className="supervisor-dialog__mode-tab"
              data-active={mode === m}
              onClick={() => setMode(m)}
            >
              {modeLabel(m)}
            </button>
          ))}
        </div>
        <div className="supervisor-dialog__hint">{modeDescription(mode)}</div>

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
            仅供专属监督 AI 读取；与表单目标/约束冲突时，以计划文件为准，不会注入工作终端。
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
              <span className="supervisor-dialog__row-label">恢复最近审计上下文</span>
              <span className="supervisor-dialog__row-meta">
                默认关闭：只恢复同项目的同一终端；若终端 ID 已改变，仅在终端标签没有歧义时恢复。
              </span>
            </span>
          </label>
          <div className="supervisor-dialog__hint">
            恢复内容仅含任务、终端事件和监督裁决摘要；“重头再来”会阻止旧上下文再次恢复，计划文件需重新选择。
          </div>
        </section>

        {mode === 'direct' ? (
          <>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">指令（每行一步，原样注入，无附加废话）</div>
              <textarea
                className="supervisor-dialog__textarea"
                rows={5}
                value={directInstructions}
                onChange={(e) => setDirectInstructions(e.target.value)}
                placeholder={'实现登录错误分支，不要改 API\n补一条该分支的单测'}
              />
            </section>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">停止条件类型（监督 AI 裁决参考）</div>
              <div className="supervisor-dialog__freedom">
                {(['concrete', 'direction'] as StopWhenKind[]).map((k) => (
                  <label
                    key={k}
                    className="supervisor-dialog__radio"
                    data-active={stopWhenKind === k}
                  >
                    <input
                      type="radio"
                      name="stopWhenKind"
                      checked={stopWhenKind === k}
                      onChange={() => setStopWhenKind(k)}
                    />
                    <span>
                      {stopWhenKindLabel(k)}
                      {k === 'concrete' ? ' — 可核对事实' : ' — 期望终态/方向'}
                    </span>
                  </label>
                ))}
              </div>
              <div className="supervisor-dialog__hint">{stopWhenKindHint(stopWhenKind)}</div>
            </section>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">
                停止条件参考（必填 · {stopWhenKindLabel(stopWhenKind)}）
              </div>
              <textarea
                className="supervisor-dialog__textarea"
                rows={2}
                value={stopWhen}
                onChange={(e) => setStopWhen(e.target.value)}
                placeholder={
                  stopWhenKind === 'direction'
                    ? '例如：登录流程可用，错误提示合理，不要大范围重构'
                    : '例如：npm test 全绿 / 终端出现 BUILD SUCCESS'
                }
              />
              <div className="supervisor-dialog__hint">
                不注入工作终端。每轮结束后，监督 AI 先查看终端证据，再把它作为参考决定继续、返工、完成或交给人工。
              </div>
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
          </>
        ) : (
          <>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">目标</div>
              <textarea
                className="supervisor-dialog__textarea"
                rows={2}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="远程 agent 正在做的任务要达成什么"
              />
            </section>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">完成/停止条件类型（监督 AI 裁决参考）</div>
              <div className="supervisor-dialog__freedom">
                {(['concrete', 'direction'] as StopWhenKind[]).map((k) => (
                  <label
                    key={k}
                    className="supervisor-dialog__radio"
                    data-active={stopWhenKind === k}
                  >
                    <input
                      type="radio"
                      name="doneWhenKind"
                      checked={stopWhenKind === k}
                      onChange={() => setStopWhenKind(k)}
                    />
                    <span>
                      {stopWhenKindLabel(k)}
                      {k === 'concrete' ? ' — 可核对事实' : ' — 期望终态/方向'}
                    </span>
                  </label>
                ))}
              </div>
              <div className="supervisor-dialog__hint">{stopWhenKindHint(stopWhenKind)}</div>
            </section>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">
                完成/停止条件参考（必填 · {stopWhenKindLabel(stopWhenKind)}）
              </div>
              <textarea
                className="supervisor-dialog__textarea"
                rows={2}
                value={doneWhen}
                onChange={(e) => setDoneWhen(e.target.value)}
                placeholder={
                  stopWhenKind === 'direction'
                    ? '例如：认证链路可演示、错误路径说得清'
                    : '例如：相关测试全绿 / CI 通过'
                }
              />
              <div className="supervisor-dialog__hint">
                与直接注入相同：终端任务结束后，监督 AI 结合证据与此参考决定下一步；`complete` 或侧栏确认才停止自动决策。
              </div>
            </section>
            <div className="supervisor-dialog__grid">
              <section className="supervisor-dialog__section">
                <div className="supervisor-dialog__label">允许范围</div>
                <textarea
                  className="supervisor-dialog__textarea"
                  rows={2}
                  value={allowPaths}
                  onChange={(e) => setAllowPaths(e.target.value)}
                  placeholder="src/auth/**"
                />
              </section>
              <section className="supervisor-dialog__section">
                <div className="supervisor-dialog__label">禁止</div>
                <textarea
                  className="supervisor-dialog__textarea"
                  rows={2}
                  value={denyNotes}
                  onChange={(e) => setDenyNotes(e.target.value)}
                  placeholder="不加依赖、不改无关模块"
                />
              </section>
            </div>
            <section className="supervisor-dialog__section">
              <label className="supervisor-dialog__inline">
                每通道最大自动决策步数（默认 3）
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={maxAuto}
                  onChange={(e) => setMaxAuto(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>
              <div className="supervisor-dialog__hint">每次自动决策都必须等工作终端本轮结束并完成监督裁决后才会继续。</div>
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
          </>
        )}

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
