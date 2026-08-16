import React, { useEffect, useMemo, useState } from 'react';
import { MAX_ACTIVE_PROJECTS } from '../../../shared/project-manager';
import type { SplitNode } from '../../../shared/types';
import { useStore } from '../../store';
import { supervisorLaneControlState } from '../../store/supervisor-slice';
import '../../styles/supervisor.css';

function firstTerminalDirectory(tree: SplitNode): string {
  if (tree.type === 'leaf') {
    const terminal = tree.surfaces.find((surface) => surface.type === 'terminal');
    return terminal?.currentCwd || terminal?.cwd || '';
  }
  return firstTerminalDirectory(tree.children[0]) || firstTerminalDirectory(tree.children[1]);
}

const STATUS_LABELS: Record<string, string> = {
  active: '运行中',
  paused: '已暂停',
  waiting: '等待决策',
  completed: '已完成',
  stopped: '已停止',
};

export default function ProjectManagerDialog() {
  const open = useStore((state) => state.projectManagerDialogOpen);
  const session = useStore((state) => state.projectManager);
  const sessions = useStore((state) => state.projectManagers);
  const supervisor = useStore((state) => state.supervisor);
  const workspaces = useStore((state) => state.workspaces);
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId);
  const close = useStore((state) => state.closeProjectManagerDialog);
  const selectProjectManager = useStore((state) => state.selectProjectManager);
  const [projectDir, setProjectDir] = useState('');
  const [goal, setGoal] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);

  const defaultProjectDir = useMemo(() => {
    const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
    if (!active) return '';
    return active.cwd || firstTerminalDirectory(active.splitTree);
  }, [activeWorkspaceId, workspaces]);

  useEffect(() => {
    if (!open || (!creating && session) || projectDir) return;
    setProjectDir(defaultProjectDir);
  }, [creating, defaultProjectDir, open, projectDir, session]);

  if (!open) return null;

  const invoke = async (params: Record<string, unknown>) => {
    const control = (window as any).__wmux_projectManagerRemoteControl;
    if (typeof control !== 'function') throw new Error('项目调度控制层尚未就绪');
    const result = await control(params);
    if (!result?.ok) throw new Error(result?.error || '项目管理 AI 操作失败');
    return result;
  };

  const start = async () => {
    const conditions = doneWhen.split(/\r?\n|；/u).map((item) => item.trim()).filter(Boolean);
    if (!projectDir.trim() || !goal.trim() || conditions.length === 0) {
      setNotice('请填写项目目录、项目目标和至少一个可验证的完成条件。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      await invoke({ action: 'start', projectDir: projectDir.trim(), goal: goal.trim(), doneWhen: conditions });
      setCreating(false);
      setGoal('');
      setDoneWhen('');
      setProjectDir('');
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async () => {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true);
    setNotice('');
    try {
      await invoke({ action: 'message', projectId: session?.id, message: text, messageId: `desktop-${Date.now()}` });
      setMessage('');
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const control = async (action: 'pause' | 'resume') => {
    setBusy(true);
    setNotice('');
    try {
      await invoke({ action, projectId: session?.id, reason: action === 'pause' ? '用户在项目管理 AI 控制台暂停项目' : '用户在项目管理 AI 控制台恢复项目' });
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const pickProjectDirectory = async () => {
    try {
      const result = await window.wmux?.system?.pickFolder?.();
      if (result?.path) setProjectDir(String(result.path));
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    }
  };

  const conversation = session?.events.filter((event) => (
    event.kind === 'user-message' || event.kind === 'manager-reply'
  )).slice(-30) || [];
  const managedLanes = session
    ? supervisor.lanes.filter((lane) => lane.projectManagerProjectId === session.id)
    : [];
  const activeManagedLanes = managedLanes.filter((lane) => supervisorLaneControlState(lane) !== 'stopped');
  const activeSessionCount = sessions.filter((candidate) => !['completed', 'stopped'].includes(candidate.status)).length;

  return (
    <div className="confirm-dialog__overlay supervisor-dialog__overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <div className="supervisor-dialog project-manager-dialog" role="dialog" aria-modal="true" aria-label="项目管理 AI 控制台">
        <header className="supervisor-dialog__header">
          <div className="supervisor-dialog__title">项目管理 AI 控制台</div>
          <div className="supervisor-dialog__sub">一个项目管理 AI 最多管理 3 个不同目录；每个项目严格对应一个监督 AI 和一个任务终端。</div>
        </header>

        <div className="supervisor-dialog__body">
          <div className="project-manager-dialog__architecture" aria-label="项目管理 AI 调度架构">
            <span>用户 / 飞书</span><b>↔</b><span data-primary="true">项目管理 AI</span><b>↔</b><span>最多 3 个项目</span><b>→</b><span>每项目 1 个监督 AI</span><b>→</b><span>1 个任务终端</span>
          </div>

          {sessions.length > 0 && (
            <section className="supervisor-dialog__group project-manager-dialog__portfolio">
              <div className="project-manager-dialog__section-head">
                <div>
                  <div className="supervisor-dialog__group-title">项目组合（{activeSessionCount}/{MAX_ACTIVE_PROJECTS} 个活动项目）</div>
                  <div className="supervisor-dialog__hint">目录必须不同；各项目可并行推进，项目内部始终只有一条监督链。</div>
                </div>
                <button type="button" className="confirm-dialog__btn" disabled={busy || activeSessionCount >= MAX_ACTIVE_PROJECTS} onClick={() => {
                  setCreating(true);
                  setProjectDir('');
                  setNotice('');
                }}>添加项目</button>
              </div>
              <div className="project-manager-dialog__project-list">
                {sessions.map((candidate) => (
                  <button key={candidate.id} type="button" data-selected={candidate.id === session?.id ? '1' : '0'} onClick={() => {
                    selectProjectManager(candidate.id);
                    setCreating(false);
                    setNotice('');
                  }}>
                    <strong>{candidate.goal}</strong>
                    <span>{candidate.projectDir}</span>
                    <em>{STATUS_LABELS[candidate.status] || candidate.status}</em>
                  </button>
                ))}
              </div>
            </section>
          )}

          {creating || !session ? (
            <section className="supervisor-dialog__group">
              <div className="supervisor-dialog__group-title">添加项目</div>
              <div className="supervisor-dialog__label supervisor-dialog__label--required">项目目录</div>
              <div className="project-manager-dialog__directory-row">
                <input className="supervisor-dialog__input" value={projectDir} onChange={(event) => setProjectDir(event.target.value)} placeholder={'E:\\project'} />
                <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void pickProjectDirectory()}>选择目录</button>
              </div>
              <div className="supervisor-dialog__label supervisor-dialog__label--required">项目目标</div>
              <textarea className="supervisor-dialog__textarea" rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="描述项目管理 AI 要追逐的上层目标" />
              <div className="supervisor-dialog__label supervisor-dialog__label--required">完成条件（每行一项）</div>
              <textarea className="supervisor-dialog__textarea" rows={4} value={doneWhen} onChange={(event) => setDoneWhen(event.target.value)} placeholder={'相关功能实现并验证\n关键测试通过\n高风险或未验证项已明确报告'} />
              <div className="supervisor-dialog__hint">项目管理 AI 会选择单/多线程模式，明确各线程职责、任务边界、决策权、停止条件和防死循环预算。</div>
            </section>
          ) : (
            <>
              <section className="project-manager-dialog__summary">
                <div><span>状态</span><strong>{STATUS_LABELS[session.status] || session.status}</strong></div>
                <div><span>工作项</span><strong>{session.workItems.length}</strong></div>
                <div><span>正在管理的监督 AI</span><strong>{activeManagedLanes.length}</strong></div>
                <div><span>待决策</span><strong>{session.workItems.filter((item) => item.status === 'waiting-decision').length}</strong></div>
              </section>
              <section className="supervisor-dialog__group">
                <div className="supervisor-dialog__group-title">项目目标</div>
                <div className="project-manager-dialog__goal">{session.goal}</div>
                <div className="project-manager-dialog__path">{session.projectDir}</div>
              </section>
              <section className="supervisor-dialog__group">
                <div className="supervisor-dialog__group-title">正在管理的监督 AI</div>
                <div className="project-manager-dialog__managed-list">
                  {activeManagedLanes.length === 0 && <div className="supervisor-dialog__empty">尚未派遣监督 AI。</div>}
                  {activeManagedLanes.map((lane) => {
                    const item = session.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
                    const execution = item?.contract.execution;
                    return (
                      <article key={lane.id}>
                        <div><strong>{lane.label}</strong><em>{STATUS_LABELS[supervisorLaneControlState(lane)] || supervisorLaneControlState(lane)}</em></div>
                        <p>监督终端：{lane.supervisorSurfaceId || '恢复中'} · 任务终端：{lane.surfaceId}</p>
                        <p>工作项：{item?.title || lane.projectWorkItemId || '未绑定'} · {execution?.taskWorkMode === 'multi-thread' ? '多线程' : '单线程'}</p>
                        {execution?.modeReason && <p>模式理由：{execution.modeReason}</p>}
                        {execution?.taskWorkMode === 'multi-thread' && (
                          <p>主线程：{execution.mainThreadResponsibility}；子线程：{execution.childThreadResponsibilities.join('；')}</p>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
              <section className="supervisor-dialog__group">
                <div className="supervisor-dialog__group-title">工作项决策记录</div>
                <div className="project-manager-dialog__work-items">
                  {session.workItems.length === 0 && <div className="supervisor-dialog__empty">项目管理 AI 尚未拆分工作项。</div>}
                  {session.workItems.map((item) => {
                    const execution = item.contract.execution;
                    const decisions = session.events.filter((event) => event.workItemId === item.id);
                    return (
                      <details key={item.id}>
                        <summary><strong>{item.title}</strong><span>{STATUS_LABELS[item.status] || item.status}</span></summary>
                        <dl>
                          <dt>执行模式</dt><dd>{execution?.taskWorkMode === 'multi-thread' ? '多线程' : '单线程'}{execution?.modeReason ? `：${execution.modeReason}` : ''}</dd>
                          <dt>决策预算</dt><dd>{item.decisionsUsed}/{item.contract.budget.maxDecisions}；重试 {item.attempts}/{item.contract.budget.maxTaskRetries}</dd>
                          <dt>执行证据</dt><dd>{item.latestEvidence || '暂无'}</dd>
                          <dt>上下文总结</dt><dd>{item.latestContextSummary || '暂无'}</dd>
                          <dt>阻塞原因</dt><dd>{item.latestBlocker || '无'}</dd>
                          <dt>决策历史</dt><dd>{decisions.length === 0 ? '暂无' : decisions.slice(-12).map((event) => `${event.kind}：${event.summary}`).join('\n')}</dd>
                        </dl>
                      </details>
                    );
                  })}
                </div>
              </section>
              <section className="supervisor-dialog__group">
                <div className="supervisor-dialog__group-title">与项目管理 AI 对话</div>
                <div className="project-manager-dialog__conversation">
                  {conversation.length === 0 && <div className="supervisor-dialog__empty">会话已建立，可直接讨论拆分、暂停、改线或上层决策。</div>}
                  {conversation.map((event) => (
                    <div key={event.id} className="project-manager-dialog__message" data-role={event.kind === 'manager-reply' ? 'manager' : 'user'}>
                      <span>{event.kind === 'manager-reply' ? '项目管理 AI' : '你'}</span>
                      <p>{event.summary}</p>
                    </div>
                  ))}
                </div>
                <textarea className="supervisor-dialog__textarea" rows={3} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="讨论需求、调整优先级、暂停、改线或询问处理依据" />
                <button type="button" className="confirm-dialog__btn" disabled={busy || !message.trim()} onClick={() => void sendMessage()}>发送给项目管理 AI</button>
              </section>
              <details className="supervisor-dialog__advanced project-manager-dialog__logs">
                <summary>查看项目管理 AI 处理日志（{session.events.length}）</summary>
                <div className="project-manager-dialog__event-list">
                  {session.events.length === 0 && <div className="supervisor-dialog__empty">暂无处理记录。</div>}
                  {session.events.slice(-50).reverse().map((event) => (
                    <div key={event.id} className="project-manager-dialog__event">
                      <span>{new Date(event.ts).toLocaleString('zh-CN', { hour12: false })}</span>
                      <strong>{event.kind}</strong>
                      <p>{event.summary}</p>
                    </div>
                  ))}
                </div>
              </details>
            </>
          )}
        </div>

        {notice && <div className="supervisor-dialog__notice" data-kind="error" role="alert">{notice}</div>}
        <div className="supervisor-dialog__actions">
          {!creating && session?.status === 'active' && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void control('pause')}>暂停项目</button>}
          {!creating && (session?.status === 'paused' || session?.status === 'waiting') && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void control('resume')}>恢复项目</button>}
          {creating && session && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => { setCreating(false); setNotice(''); }}>取消添加</button>}
          <span className="supervisor-dialog__actions-spacer" />
          <button type="button" className="confirm-dialog__btn" onClick={close}>关闭</button>
          {(creating || !session) && <button type="button" className="confirm-dialog__btn confirm-dialog__btn--danger" disabled={busy} onClick={() => void start()}>{busy ? '正在添加…' : '添加项目'}</button>}
        </div>
      </div>
    </div>
  );
}
