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
} from '../../supervisor/protocol';
import '../../styles/supervisor.css';

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
  const setSupervisorSurface = useStore((s) => s.setSupervisorSurface);
  const addSurface = useStore((s) => s.addSurface);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);

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
    const skipId = supervisor.supervisorSurfaceId;
    for (const ws of workspaces) {
      const surfaces: Array<{ surfaceId: SurfaceId; paneId: PaneId; title: string; projectDir?: string }> = [];
      collectTerminals(ws.splitTree, surfaces);
      for (const s of surfaces) {
        if (skipId && s.surfaceId === skipId) continue;
        if (s.title === SUPERVISOR_TAB_TITLE || s.title === 'AI Supervisor') continue;
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
  }, [workspaces, agentMeta, agentStates, supervisor.supervisorSurfaceId]);

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
  const [launchCmd, setLaunchCmd] = useState(supervisor.supervisorLaunchCmd);
  const [maxAuto, setMaxAuto] = useState(supervisor.maxAutoSteps || 8);

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
    setLaunchCmd(supervisor.supervisorLaunchCmd || '');
    setMaxAuto(supervisor.maxAutoSteps || 8);
    setSelected(new Set(supervisor.lanes.filter((l) => l.enabled).map((l) => l.surfaceId)));
  }, [setupOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!setupOpen) return null;

  const toggle = (surfaceId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(surfaceId)) next.delete(surfaceId);
      else next.add(surfaceId);
      return next;
    });
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
      supervisorLaunchCmd: launchCmd,
      maxAutoSteps: maxAuto,
    });
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
    setSupervisorLanes(lanes);
    if (andStart) startSupervisor();
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
    setSupervisorLanes(lanes);

    const wsId = activeWorkspaceId || workspaces[0]?.id;
    if (!wsId) return;
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;

    const panes: PaneId[] = [];
    const walk = (n: SplitNode) => {
      if (n.type === 'leaf') panes.push(n.paneId);
      else {
        walk(n.children[0]);
        walk(n.children[1]);
      }
    };
    walk(ws.splitTree);
    const paneId = panes[0];
    if (!paneId) return;

    const startupCommands = launchCmd.trim() ? [launchCmd.trim()] : undefined;
    const surfaceId = addSurface(wsId, paneId, 'terminal', {
      customTitle: SUPERVISOR_TAB_TITLE,
      startupCommands,
    });
    if (!surfaceId) return;
    setSupervisorSurface(surfaceId);
    closeSupervisorSetup();

    window.setTimeout(() => {
      try {
        const session = useStore.getState().supervisor;
        const states = (window as any).__wmux_getAgentStates?.() || {};
        const text = buildSupervisorBriefing(
          session,
          session.lanes.map((l) => ({
            lane: l,
            state: String(states[l.surfaceId]?.state || 'unknown'),
          })),
        );
        (window as any).wmux?.pty?.write?.(surfaceId, text + '\n');
      } catch (err) {
        console.warn('[supervisor] briefing inject failed', err);
      }
    }, 1200);
  };

  return (
    <div className="confirm-dialog__overlay" onClick={closeSupervisorSetup}>
      <div
        className="supervisor-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="AI 监督"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="supervisor-dialog__title">AI 监督</div>
        <div className="supervisor-dialog__sub">
          两种模式二选一。调度默认关闭，确认后再启动。
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
              <div className="supervisor-dialog__label">停止条件类型（监督 AI 按此方式判断）</div>
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
                停止条件（必填 · {stopWhenKindLabel(stopWhenKind)}）
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
                不注入工作终端。指令跑完后由监督 AI 判断是否达标；你在侧栏最终点「已达停止条件」才停止注入。
              </div>
            </section>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">监督 AI 启动命令（可选，用于观察终端是否达标）</div>
              <input
                className="supervisor-dialog__input"
                value={launchCmd}
                onChange={(e) => setLaunchCmd(e.target.value)}
                placeholder="claude  或  codex  或留空"
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
              <div className="supervisor-dialog__label">完成/停止条件类型（监督 AI 按此判断）</div>
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
                完成/停止条件（必填 · {stopWhenKindLabel(stopWhenKind)}）
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
                与直接注入相同：监督 AI 判断是否达标；侧栏「已达停止条件」后才停自动决策。
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
                每通道最大自动决策步数
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={maxAuto}
                  onChange={(e) => setMaxAuto(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>
            </section>
            <section className="supervisor-dialog__section">
              <div className="supervisor-dialog__label">监督 AI 启动命令（可选）</div>
              <input
                className="supervisor-dialog__input"
                value={launchCmd}
                onChange={(e) => setLaunchCmd(e.target.value)}
                placeholder="claude  或  codex  或留空"
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
            打开 AI 监督会话
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
