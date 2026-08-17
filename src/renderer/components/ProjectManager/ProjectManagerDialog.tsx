import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_ACTIVE_PROJECTS,
  MAX_PROJECT_PLAN_FILES,
  type ProjectPlanFileSnapshot,
} from '../../../shared/project-manager';
import {
  DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
  normalizeProjectManagementAgentConfig,
  projectAgentDefaultReasoningEffort,
  type ProjectManagementAgentConfig,
} from '../../../shared/project-manager-terminal';
import type { SplitNode } from '../../../shared/types';
import { useStore } from '../../store';
import { supervisorLaneControlState } from '../../store/supervisor-slice';
import { modelOptionsFor } from '../../supervisor/model-catalog';
import '../../styles/supervisor.css';

function firstTerminalDirectory(tree: SplitNode): string {
  if (tree.type === 'leaf') {
    const terminal = tree.surfaces.find((surface) => surface.type === 'terminal');
    return terminal?.currentCwd || terminal?.cwd || '';
  }
  return firstTerminalDirectory(tree.children[0]) || firstTerminalDirectory(tree.children[1]);
}

const STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  planned: '规划中',
  'waiting-dependencies': '阻塞：等待依赖',
  running: '监督中',
  validating: '验证中',
  'waiting-decision': '阻塞：等待决策',
  failed: '阻塞：执行失败',
  paused: '已暂停',
  waiting: '等待决策',
  completed: '已完成',
  stopped: '已停止',
};

function projectActivityLabel(session: { status: string; workItems: Array<{ status: string; workerSurfaceId?: string; supervisorLaneId?: string; latestBlocker?: string }> }): string {
  if (session.status !== 'active') return STATUS_LABELS[session.status] || session.status;
  const current = session.workItems.find((item) => item.latestBlocker || item.status === 'waiting-decision' || item.status === 'failed')
    || session.workItems.find((item) => item.status === 'running' || item.status === 'validating')
    || session.workItems.find((item) => item.workerSurfaceId && !item.supervisorLaneId)
    || session.workItems.find((item) => item.status === 'planned');
  if (!current) return '规划中';
  if (current.latestBlocker || current.status === 'waiting-decision' || current.status === 'failed') return '阻塞中';
  if (current.status === 'running' || current.status === 'validating') return '监督中';
  if (current.workerSurfaceId) return '派遣中';
  return '规划中';
}

function conditionLines(value: string): string[] {
  return value.split(/\r?\n|；/u).map((item) => item.trim()).filter(Boolean);
}

const PROJECT_AGENT_ROWS = [
  {
    key: 'manager',
    title: '项目管理 AI',
    hint: '独立管理项目组合；切换 Agent 时安全重启并恢复结构化上下文。',
    agents: [['codex', 'Codex'], ['kimi', 'Kimi Code'], ['grok', 'Grok Build']],
  },
  {
    key: 'supervisor',
    title: 'AI 监督',
    hint: '用于项目管理模式派遣的新监督链，不读取“AI 监督模式”的默认设置。',
    agents: [['pi', 'Pi Agent'], ['codex', 'Codex'], ['kimi', 'Kimi Code'], ['grok', 'Grok Build']],
  },
  {
    key: 'task',
    title: '任务终端',
    hint: '用于新建或轮换任务终端；既有终端不会被强制重启。',
    agents: [['codex', 'Codex'], ['kimi', 'Kimi Code'], ['grok', 'Grok Build']],
  },
] as const;

function projectReasoningOptions(agent: string): Array<{ value: string; label: string }> {
  if (agent === 'codex') return [
    { value: '', label: '使用 Codex 默认推理程度' },
    { value: 'low', label: '低（更快）' },
    { value: 'medium', label: '中（均衡）' },
    { value: 'high', label: '高（更深入）' },
    { value: 'xhigh', label: '超高（最深入）' },
  ];
  if (agent === 'pi') return [
    { value: '', label: '使用 Pi 默认 Thinking' },
    { value: 'minimal', label: '最小' },
    { value: 'low', label: '低（更快）' },
    { value: 'medium', label: '中（均衡）' },
    { value: 'high', label: '高（更深入）' },
    { value: 'xhigh', label: '超高' },
    { value: 'max', label: '最大' },
    { value: 'off', label: '关闭' },
  ];
  if (agent === 'kimi') return [
    { value: '', label: '使用 Kimi 默认 Thinking' },
    { value: 'on', label: '开启 Thinking' },
  ];
  return [{ value: '', label: '通过会话内 /effort 调整' }];
}

interface ProjectRecoveryCandidate {
  id: string;
  projectDir: string;
  goal: string;
  status: string;
  workItemCount: number;
  updatedAt: number;
}

export default function ProjectManagerDialog() {
  const open = useStore((state) => state.projectManagerDialogOpen);
  const session = useStore((state) => state.projectManager);
  const sessions = useStore((state) => state.projectManagers);
  const supervisor = useStore((state) => state.supervisor);
  const workspaces = useStore((state) => state.workspaces);
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId);
  const close = useStore((state) => state.closeProjectManagerDialog);
  const selectProjectManager = useStore((state) => state.selectProjectManager);
  const workspacePrefs = useStore((state) => state.workspacePrefs);
  const setWorkspacePrefs = useStore((state) => state.setWorkspacePrefs);
  const [projectDir, setProjectDir] = useState('');
  const [goal, setGoal] = useState('');
  const [preconditions, setPreconditions] = useState('');
  const [planFiles, setPlanFiles] = useState<ProjectPlanFileSnapshot[]>([]);
  const [planFilePath, setPlanFilePath] = useState('');
  const [definitionGoalDraft, setDefinitionGoalDraft] = useState('');
  const [definitionDoneWhenDraft, setDefinitionDoneWhenDraft] = useState('');
  const [definitionPlanFiles, setDefinitionPlanFiles] = useState<ProjectPlanFileSnapshot[]>([]);
  const [definitionPlanFilePath, setDefinitionPlanFilePath] = useState('');
  const [replaceProjectDirection, setReplaceProjectDirection] = useState(false);
  const [preconditionsDraft, setPreconditionsDraft] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [configNotice, setConfigNotice] = useState('');
  const [constraintNotice, setConstraintNotice] = useState('');
  const [agentDraft, setAgentDraft] = useState<ProjectManagementAgentConfig>(() => (
    normalizeProjectManagementAgentConfig(DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG)
  ));
  const [creating, setCreating] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState<'unchecked' | 'checking' | 'prompt' | 'done'>('unchecked');
  const [recoveryCandidates, setRecoveryCandidates] = useState<ProjectRecoveryCandidate[]>([]);
  const [selectedRecoveryIds, setSelectedRecoveryIds] = useState<string[]>([]);
  const [clarificationOptionId, setClarificationOptionId] = useState('');
  const [clarificationAnswer, setClarificationAnswer] = useState('');
  const clarificationRef = useRef<HTMLElement | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const conversation = useMemo(() => session?.events.filter((event) => (
    event.kind === 'user-message' || event.kind === 'manager-reply'
  )).slice(-50) || [], [session?.events]);
  const definitionUpdates = useMemo(() => session?.events.filter((event) => (
    event.kind === 'project-definition-updated'
  )).slice(-20).reverse() || [], [session?.events]);
  const message = session ? messageDrafts[session.id] || '' : '';
  const lastConversationEvent = conversation.at(-1);
  const sessionDefinitionFingerprint = session ? JSON.stringify([
    session.goal,
    session.preconditions,
    session.doneWhen,
    session.planFiles.map((file) => [file.path, file.sizeBytes, file.mtimeMs, file.capturedAt]),
  ]) : '';
  const waitingForManagerReply = conversation.some((event) => (
    event.kind === 'user-message'
    && !!event.correlationId
    && !conversation.some((candidate) => (
      candidate.kind === 'manager-reply'
      && candidate.correlationId === event.correlationId
      && candidate.ts >= event.ts
    ))
  ));

  const defaultProjectDir = useMemo(() => {
    const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
    if (!active) return '';
    return active.cwd || firstTerminalDirectory(active.splitTree);
  }, [activeWorkspaceId, workspaces]);

  useEffect(() => {
    if (!open || (!creating && session) || projectDir) return;
    setProjectDir(defaultProjectDir);
  }, [creating, defaultProjectDir, open, projectDir, session]);

  useEffect(() => {
    if (!open) return;
    setAgentDraft(normalizeProjectManagementAgentConfig(workspacePrefs.projectManagementAgents));
    setConfigNotice('');
  }, [open, workspacePrefs.projectManagementAgents]);

  useEffect(() => {
    if (!open) return;
    setDefinitionGoalDraft(session?.goal || '');
    setPreconditionsDraft((session?.preconditions || []).join('\n'));
    setDefinitionDoneWhenDraft((session?.doneWhen || []).join('\n'));
    setDefinitionPlanFiles(session?.planFiles || []);
    setDefinitionPlanFilePath('');
    setReplaceProjectDirection(false);
    setConstraintNotice('');
  }, [open, session?.id, sessionDefinitionFingerprint]);

  useEffect(() => {
    setClarificationOptionId('');
    setClarificationAnswer('');
    if (!session?.pendingUserQuestion) return undefined;
    const frame = window.requestAnimationFrame(() => {
      clarificationRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      clarificationRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [session?.pendingUserQuestion?.id]);

  useEffect(() => {
    if (!open || conversation.length === 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      conversationEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversation.length, lastConversationEvent?.id, open, session?.id]);

  useEffect(() => {
    if (!open || sessions.length > 0 || recoveryStatus !== 'unchecked') return;
    const control = (window as any).__wmux_projectManagerRemoteControl;
    if (typeof control !== 'function') {
      setNotice('项目调度控制层尚未就绪');
      setRecoveryStatus('done');
      return;
    }
    setRecoveryStatus('checking');
    void Promise.resolve(control({ action: 'recovery-candidates' })).then((result) => {
      if (!result?.ok) throw new Error(result?.error || '无法检查上次项目');
      if (useStore.getState().projectManagers.length > 0) {
        setRecoveryCandidates([]);
        setRecoveryStatus('done');
        return;
      }
      const candidates = Array.isArray(result.candidates) ? result.candidates : [];
      setRecoveryCandidates(candidates);
      setSelectedRecoveryIds(candidates.slice(0, MAX_ACTIVE_PROJECTS).map((candidate: ProjectRecoveryCandidate) => candidate.id));
      setRecoveryStatus(candidates.length > 0 ? 'prompt' : 'done');
    }).catch((error) => {
      setNotice(String((error as Error)?.message || error));
      setRecoveryStatus('done');
    });
  }, [open, recoveryStatus, sessions.length]);

  if (!open) return null;

  const invoke = async (params: Record<string, unknown>) => {
    const control = (window as any).__wmux_projectManagerRemoteControl;
    if (typeof control !== 'function') throw new Error('项目调度控制层尚未就绪');
    const result = await control(params);
    if (!result?.ok) throw new Error(result?.error || '项目管理 AI 操作失败');
    return result;
  };

  const saveAgentConfig = async () => {
    if (busy) return;
    const previous = normalizeProjectManagementAgentConfig(workspacePrefs.projectManagementAgents);
    const next = normalizeProjectManagementAgentConfig(agentDraft);
    const restartManager = previous.manager.agent !== next.manager.agent
      || previous.manager.model !== next.manager.model
      || previous.manager.reasoningEffort !== next.manager.reasoningEffort;
    setBusy(true);
    setNotice('');
    setConfigNotice('');
    setWorkspacePrefs({ projectManagementAgents: next });
    try {
      const result = await invoke({ action: 'configure-agents', restartManager });
      setConfigNotice(result.message || '项目管理模式 Agent 配置已保存。');
    } catch (error) {
      setWorkspacePrefs({ projectManagementAgents: previous });
      setAgentDraft(previous);
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const chooseRecovery = async (restore: boolean, addNewProject = false) => {
    if (busy) return;
    if (restore && selectedRecoveryIds.length === 0) {
      setNotice('请至少选择一个要继续推进的历史项目。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const result = await invoke({
        action: restore ? 'restore-projects' : 'skip-project-recovery',
        ...(restore ? { projectIds: selectedRecoveryIds } : {}),
      });
      setRecoveryCandidates([]);
      setSelectedRecoveryIds([]);
      setRecoveryStatus('done');
      setCreating(addNewProject);
      if (addNewProject) setProjectDir('');
      setConfigNotice(result.message || (restore ? '所选历史项目已恢复。' : '本次不恢复历史项目。'));
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const toggleRecoveryCandidate = (projectId: string) => {
    setSelectedRecoveryIds((current) => (
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : current.length < MAX_ACTIVE_PROJECTS ? [...current, projectId] : current
    ));
    setNotice('');
  };

  const start = async () => {
    const projectPreconditions = conditionLines(preconditions);
    const conditions = conditionLines(doneWhen);
    if (!projectDir.trim() || !goal.trim() || projectPreconditions.length === 0 || conditions.length === 0) {
      setNotice('请填写项目目录、项目目标、至少一个前置条件和至少一个可验证的完成条件。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      await invoke({
        action: 'start',
        projectDir: projectDir.trim(),
        goal: goal.trim(),
        preconditions: projectPreconditions,
        planFiles,
        doneWhen: conditions,
      });
      setCreating(false);
      setGoal('');
      setPreconditions('');
      setPlanFiles([]);
      setPlanFilePath('');
      setDoneWhen('');
      setProjectDir('');
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const mergePlanFiles = (incoming: ProjectPlanFileSnapshot[]) => {
    const byPath = new Map(planFiles.map((file) => [file.path.toLowerCase(), file]));
    for (const file of incoming) byPath.set(file.path.toLowerCase(), file);
    const merged = [...byPath.values()];
    if (merged.length > MAX_PROJECT_PLAN_FILES) {
      setNotice(`计划文件最多 ${MAX_PROJECT_PLAN_FILES} 个。`);
      return;
    }
    setPlanFiles(merged);
    setNotice('');
  };

  const pickPlanFiles = async () => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await window.wmux?.projectManager?.pickPlanFiles?.();
      if (result?.canceled) return;
      if (!result?.ok) throw new Error(result?.error || '无法读取计划文件');
      mergePlanFiles(Array.isArray(result.files) ? result.files : []);
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const addPlanFilePath = async () => {
    const paths = planFilePath.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (paths.length === 0 || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await window.wmux?.projectManager?.readPlanFiles?.(paths);
      if (!result?.ok) throw new Error(result?.error || '无法读取计划文件');
      mergePlanFiles(Array.isArray(result.files) ? result.files : []);
      setPlanFilePath('');
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const mergeDefinitionPlanFiles = (incoming: ProjectPlanFileSnapshot[]) => {
    const byPath = new Map(definitionPlanFiles.map((file) => [file.path.toLowerCase(), file]));
    for (const file of incoming) byPath.set(file.path.toLowerCase(), file);
    const merged = [...byPath.values()];
    if (merged.length > MAX_PROJECT_PLAN_FILES) {
      setNotice(`计划文件最多 ${MAX_PROJECT_PLAN_FILES} 个。`);
      return;
    }
    setDefinitionPlanFiles(merged);
    setNotice('');
  };

  const pickDefinitionPlanFiles = async () => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await window.wmux?.projectManager?.pickPlanFiles?.();
      if (result?.canceled) return;
      if (!result?.ok) throw new Error(result?.error || '无法读取计划文件');
      mergeDefinitionPlanFiles(Array.isArray(result.files) ? result.files : []);
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const addDefinitionPlanFilePath = async () => {
    const paths = definitionPlanFilePath.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (paths.length === 0 || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await window.wmux?.projectManager?.readPlanFiles?.(paths);
      if (!result?.ok) throw new Error(result?.error || '无法读取计划文件');
      mergeDefinitionPlanFiles(Array.isArray(result.files) ? result.files : []);
      setDefinitionPlanFilePath('');
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const answerClarification = async () => {
    const pending = session?.pendingUserQuestion;
    if (!pending || busy) return;
    const selected = pending.options.find((option) => option.id === clarificationOptionId);
    if (!selected && !clarificationAnswer.trim()) {
      setNotice('请选择一个答复选项，或填写自定义答复。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const result = await invoke({
        action: 'answer-question',
        projectId: session.id,
        questionId: pending.id,
        optionId: selected?.id,
        answer: clarificationAnswer.trim() || selected?.label || '',
        source: 'desktop',
      });
      setClarificationOptionId('');
      setClarificationAnswer('');
      setConfigNotice(result.message || '答复已提交给项目管理 AI。');
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const updateProjectDefinition = async () => {
    if (!session || busy) return;
    const projectPreconditions = conditionLines(preconditionsDraft);
    const projectDoneWhen = conditionLines(definitionDoneWhenDraft);
    if (!definitionGoalDraft.trim() || projectPreconditions.length === 0 || projectDoneWhen.length === 0) {
      setNotice('请填写项目目标、至少一个前置条件和至少一个可验证的完成条件。没有额外条件时请明确填写“无额外物理前置条件”。');
      return;
    }
    if (replaceProjectDirection && !window.confirm('将以新目标取代旧目标，并停止所有尚未完成的旧工作项。旧记录会保留，但后续不再按旧目标推进。是否继续？')) return;
    setBusy(true);
    setNotice('');
    setConstraintNotice('');
    try {
      const result = await invoke({
        action: 'update-definition',
        projectId: session.id,
        goal: definitionGoalDraft.trim(),
        preconditions: projectPreconditions,
        planFiles: definitionPlanFiles,
        doneWhen: projectDoneWhen,
        mode: replaceProjectDirection ? 'replace' : 'revise',
        reason: replaceProjectDirection
          ? '用户在项目管理 AI 控制台替换旧目标并要求按新方向重新规划'
          : '用户在项目管理 AI 控制台更新目标或需求',
      });
      setReplaceProjectDirection(false);
      setConstraintNotice(result.message || '项目目标和需求已更新。');
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async () => {
    const text = message.trim();
    if (!text || busy || !session) return;
    const projectId = session.id;
    setBusy(true);
    setNotice('');
    try {
      await invoke({
        action: 'message',
        projectId,
        message: text,
        messageId: `desktop-${projectId}-${Date.now()}`,
        source: 'desktop',
      });
      setMessageDrafts((current) => ({ ...current, [projectId]: '' }));
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

  const controlPortfolio = async (action: 'pause-all-projects' | 'resume-all-projects') => {
    setBusy(true);
    setNotice('');
    try {
      await invoke({
        action,
        reason: action === 'pause-all-projects'
          ? '用户在项目管理 AI 控制台暂停全部项目'
          : '用户在项目管理 AI 控制台恢复全部项目',
      });
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelectedProject = async () => {
    if (!session || busy) return;
    if (!window.confirm(`将删除“${session.goal}”的项目管理记录，并关闭该项目已绑定的监督 AI 和任务终端。项目目录及业务文件不会删除。是否继续？`)) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await invoke({ action: 'delete-project', projectId: session.id });
      setConfigNotice(result.message || '项目已删除。');
      setCreating(false);
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

  const managedLanes = session
    ? supervisor.lanes.filter((lane) => lane.projectManagerProjectId === session.id)
    : [];
  const activeManagedLanes = managedLanes.filter((lane) => supervisorLaneControlState(lane) !== 'stopped');
  const activeSessionCount = sessions.filter((candidate) => !['completed', 'stopped'].includes(candidate.status)).length;
  const canPausePortfolio = sessions.some((candidate) => candidate.status === 'active' || candidate.status === 'waiting');
  const canResumePortfolio = sessions.some((candidate) => candidate.status === 'paused' && candidate.pausedByPortfolio === true);
  const awaitingRecovery = sessions.length === 0 && recoveryStatus !== 'done';
  const projectDefinitionChanged = !!session && (
    definitionGoalDraft.trim() !== session.goal
    || conditionLines(preconditionsDraft).join('\n') !== session.preconditions.join('\n')
    || conditionLines(definitionDoneWhenDraft).join('\n') !== session.doneWhen.join('\n')
    || JSON.stringify(definitionPlanFiles) !== JSON.stringify(session.planFiles || [])
  );

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

          {awaitingRecovery && (
            <section className="supervisor-dialog__group project-manager-dialog__recovery">
              <div className="supervisor-dialog__group-title">{recoveryStatus === 'checking' ? '正在检查历史项目…' : '选择历史项目继续管理'}</div>
              {recoveryStatus === 'prompt' && (
                <>
                  <div className="supervisor-dialog__hint">项目管理 AI 只恢复你勾选的项目，并基于结构化记录创建新的 AI 会话继续推进。未选择的历史记录会保留。</div>
                  <div className="project-manager-dialog__recovery-summary">已选择 {selectedRecoveryIds.length}/{MAX_ACTIVE_PROJECTS} 个项目</div>
                  <div className="project-manager-dialog__recovery-list">
                    {recoveryCandidates.map((candidate) => (
                      <label key={candidate.id} data-selected={selectedRecoveryIds.includes(candidate.id) ? '1' : '0'}>
                        <input
                          type="checkbox"
                          checked={selectedRecoveryIds.includes(candidate.id)}
                          onChange={() => toggleRecoveryCandidate(candidate.id)}
                        />
                        <span>
                          <strong>{candidate.goal}</strong>
                          <small>{candidate.projectDir}</small>
                          <em>{STATUS_LABELS[candidate.status] || candidate.status} · {candidate.workItemCount} 个工作项 · 最后更新 {new Date(candidate.updatedAt).toLocaleString('zh-CN', { hour12: false })}</em>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="project-manager-dialog__recovery-actions">
                    <button type="button" className="confirm-dialog__btn confirm-dialog__btn--danger" disabled={busy || selectedRecoveryIds.length === 0} onClick={() => void chooseRecovery(true)}>{busy ? '正在恢复…' : `恢复所选项目（${selectedRecoveryIds.length}）`}</button>
                    <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void chooseRecovery(false, true)}>添加新项目</button>
                    <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void chooseRecovery(false)}>暂不恢复</button>
                  </div>
                  <div className="supervisor-dialog__hint">恢复后仍可添加新项目，活动项目总数最多 {MAX_ACTIVE_PROJECTS} 个。旧监督 AI 和任务终端对话不会直接复活，将通过恢复包建立新链路。</div>
                </>
              )}
            </section>
          )}

          {session?.pendingUserQuestion && !creating && (
            <section ref={clarificationRef} tabIndex={-1} className="supervisor-dialog__group project-manager-dialog__clarification" role="alertdialog" aria-label={session.pendingUserQuestion.category === 'manual-intervention' ? '项目管理 AI 需要用户指示' : '项目管理 AI 与用户对齐需求'}>
              <div className="supervisor-dialog__group-title">{session.pendingUserQuestion.category === 'manual-intervention' ? '项目阻塞，需要你指示' : '项目管理 AI 邀请你对齐需求'}</div>
              <div className="project-manager-dialog__clarification-question">{session.pendingUserQuestion.question}</div>
              {session.pendingUserQuestion.context && <div className="supervisor-dialog__hint">{session.pendingUserQuestion.context}</div>}
              <div className="project-manager-dialog__clarification-options">
                {session.pendingUserQuestion.options.map((option) => (
                  <label key={option.id} data-selected={clarificationOptionId === option.id ? '1' : '0'}>
                    <input type="radio" name="project-manager-clarification" checked={clarificationOptionId === option.id} onChange={() => setClarificationOptionId(option.id)} />
                    <span><strong>{option.label}</strong>{option.id === session.pendingUserQuestion?.recommendedOptionId && <em>推荐</em>}{option.description && <small>{option.description}</small>}</span>
                  </label>
                ))}
              </div>
              <textarea className="supervisor-dialog__textarea" rows={3} value={clarificationAnswer} onChange={(event) => setClarificationAnswer(event.target.value)} placeholder="可补充说明，或不选上述选项直接填写自定义答复" />
              <button type="button" className="confirm-dialog__btn confirm-dialog__btn--danger" disabled={busy || (!clarificationOptionId && !clarificationAnswer.trim())} onClick={() => void answerClarification()}>{busy ? '正在提交…' : '确认并交给项目管理 AI'}</button>
              <div className="supervisor-dialog__hint">该项目在收到答复前保持等待；其他项目继续运行。桌面或飞书任一端先回答即生效；若仍有关键歧义，项目管理 AI 会在同一项目对话中继续下一轮确认。</div>
            </section>
          )}

          <section className="supervisor-dialog__group project-manager-dialog__agent-config">
            <div className="project-manager-dialog__section-head">
              <div>
                <div className="supervisor-dialog__group-title">项目管理模式 Agent 配置</div>
                <div className="supervisor-dialog__hint">仅作用于项目管理模式：项目管理 AI、监督 AI、任务终端三层分别选择 Agent、模型和思考程度。</div>
              </div>
              <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void saveAgentConfig()}>保存配置</button>
            </div>
            <div className="project-manager-dialog__agent-grid">
              {PROJECT_AGENT_ROWS.map((row) => {
                const selection = agentDraft[row.key];
                const models = modelOptionsFor(selection.agent);
                const reasoningOptions = projectReasoningOptions(selection.agent);
                return (
                  <article key={row.key}>
                    <strong>{row.title}</strong>
                    <label>
                      <span>Agent</span>
                      <select value={selection.agent} onChange={(event) => {
                        const agent = event.target.value;
                        setAgentDraft((current) => normalizeProjectManagementAgentConfig({
                          ...current,
                          [row.key]: { agent, model: '', reasoningEffort: projectAgentDefaultReasoningEffort(agent) },
                        } as Partial<ProjectManagementAgentConfig>));
                        setConfigNotice('');
                      }}>
                        {row.agents.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>模型</span>
                      <select value={selection.model} onChange={(event) => {
                        const model = event.target.value;
                        setAgentDraft((current) => normalizeProjectManagementAgentConfig({
                          ...current,
                          [row.key]: { ...current[row.key], model },
                        }));
                        setConfigNotice('');
                      }}>
                        <option value="">使用 Agent 默认模型</option>
                        {selection.model && !models.some((option) => option.value === selection.model) && (
                          <option value={selection.model}>{selection.model}</option>
                        )}
                        {models.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>{selection.agent === 'codex' ? '推理程度' : 'Thinking'}</span>
                      <select
                        value={selection.reasoningEffort}
                        disabled={selection.agent === 'grok'}
                        onChange={(event) => {
                          const reasoningEffort = event.target.value;
                          setAgentDraft((current) => normalizeProjectManagementAgentConfig({
                            ...current,
                            [row.key]: { ...current[row.key], reasoningEffort },
                          }));
                          setConfigNotice('');
                        }}
                      >
                        {reasoningOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <p>{row.hint}</p>
                  </article>
                );
              })}
            </div>
            {configNotice && <div className="supervisor-dialog__notice" data-kind="success" role="status">{configNotice}</div>}
          </section>

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
                {session && <button type="button" className="confirm-dialog__btn confirm-dialog__btn--danger" disabled={busy} onClick={() => void deleteSelectedProject()}>删除选中项目</button>}
                {canPausePortfolio && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void controlPortfolio('pause-all-projects')}>暂停全部项目</button>}
                {canResumePortfolio && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void controlPortfolio('resume-all-projects')}>恢复全部项目</button>}
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
                    <em>{projectActivityLabel(candidate)}</em>
                  </button>
                ))}
              </div>
            </section>
          )}

          {!awaitingRecovery && (
            creating || !session ? <section className="supervisor-dialog__group">
              <div className="supervisor-dialog__group-title">添加项目</div>
              <div className="supervisor-dialog__label supervisor-dialog__label--required">项目目录</div>
              <div className="project-manager-dialog__directory-row">
                <input className="supervisor-dialog__input" value={projectDir} onChange={(event) => {
                  setProjectDir(event.target.value);
                  setNotice('');
                }} placeholder={'E:\\project'} />
                <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void pickProjectDirectory()}>选择目录</button>
              </div>
              <div className="supervisor-dialog__label supervisor-dialog__label--required">项目目标</div>
              <textarea className="supervisor-dialog__textarea" rows={3} value={goal} onChange={(event) => {
                setGoal(event.target.value);
                setNotice('');
              }} placeholder="描述项目管理 AI 要追逐的上层目标" />
              <div className="supervisor-dialog__label">计划文件（可选，最多 {MAX_PROJECT_PLAN_FILES} 个）</div>
              <div className="project-manager-dialog__directory-row">
                <input className="supervisor-dialog__input" value={planFilePath} onChange={(event) => setPlanFilePath(event.target.value)} placeholder={'C:\\project\\PLAN.md'} />
                <button type="button" className="confirm-dialog__btn" disabled={busy || !planFilePath.trim()} onClick={() => void addPlanFilePath()}>添加路径</button>
                <button type="button" className="confirm-dialog__btn" disabled={busy || planFiles.length >= MAX_PROJECT_PLAN_FILES} onClick={() => void pickPlanFiles()}>选择计划文件</button>
              </div>
              {planFiles.length > 0 && <div className="project-manager-dialog__plan-files">
                {planFiles.map((file) => <article key={file.path}>
                  <div><strong>{file.name}</strong><button type="button" className="confirm-dialog__btn" onClick={() => setPlanFiles((current) => current.filter((candidate) => candidate.path !== file.path))}>移除</button></div>
                  <span>{file.path}</span><em>{Math.max(1, Math.ceil(file.sizeBytes / 1024))} KB · 已保存内容快照</em>
                </article>)}
              </div>}
              <div className="supervisor-dialog__hint">支持 Markdown、TXT、JSON、YAML；单个不超过 1 MB。快照只补充需求，不扩大任务终端对项目目录之外的访问权限。</div>
              <div className="supervisor-dialog__label supervisor-dialog__label--required">项目前置条件（每行一项）</div>
              <textarea className="supervisor-dialog__textarea" rows={4} value={preconditions} onChange={(event) => {
                setPreconditions(event.target.value);
                setNotice('');
              }} placeholder={'树莓派已接通受控电源并可安全断电\n局域网访问权限已获得\n目标设备、接口和安全限值已经人工确认'} />
              <div className="supervisor-dialog__hint">物理设备、环境、权限、资源或人工确认条件未取得证据前，项目管理 AI 不得假定已经具备。无额外条件时请明确填写。</div>
              <div className="supervisor-dialog__label supervisor-dialog__label--required">完成条件（每行一项）</div>
              <textarea className="supervisor-dialog__textarea" rows={4} value={doneWhen} onChange={(event) => {
                setDoneWhen(event.target.value);
                setNotice('');
              }} placeholder={'相关功能实现并验证\n关键测试通过\n高风险或未验证项已明确报告'} />
              <div className="supervisor-dialog__hint">项目管理 AI 会选择单/多线程模式，明确各线程职责、任务边界、决策权、停止条件和防死循环预算。</div>
            </section> : (
            <>
              <section className="project-manager-dialog__summary">
                <div><span>状态</span><strong>{projectActivityLabel(session)}</strong></div>
                <div><span>工作项</span><strong>{session.workItems.length}</strong></div>
                <div><span>正在管理的监督 AI</span><strong>{activeManagedLanes.length}</strong></div>
                <div><span>待决策</span><strong>{session.workItems.filter((item) => item.status === 'waiting-decision').length}</strong></div>
              </section>
              <section className="supervisor-dialog__group project-manager-dialog__preconditions">
                <div className="project-manager-dialog__section-head">
                  <div>
                    <div className="supervisor-dialog__group-title">项目目标与需求</div>
                    <div className="supervisor-dialog__hint">项目目录保持不变；目标、计划文件、前置条件和完成条件可在推进中调整。保存后会暂停当前监督链，由项目管理 AI 评估影响并重规划。</div>
                  </div>
                  <button
                    type="button"
                    className="confirm-dialog__btn"
                    disabled={busy || !!session.pendingUserQuestion || !projectDefinitionChanged}
                    onClick={() => void updateProjectDefinition()}
                  >保存需求变更</button>
                </div>
                <div className="supervisor-dialog__label">项目目录（不可变）</div>
                <div className="project-manager-dialog__path">{session.projectDir}</div>
                <div className="supervisor-dialog__label supervisor-dialog__label--required">项目目标</div>
                <textarea className="supervisor-dialog__textarea" rows={3} value={definitionGoalDraft} onChange={(event) => {
                  setDefinitionGoalDraft(event.target.value);
                  setConstraintNotice('');
                }} placeholder="描述项目管理 AI 当前要追逐的上层目标" />
                <div className="supervisor-dialog__label">计划文件（可选，最多 {MAX_PROJECT_PLAN_FILES} 个）</div>
                <div className="project-manager-dialog__directory-row">
                  <input className="supervisor-dialog__input" value={definitionPlanFilePath} onChange={(event) => setDefinitionPlanFilePath(event.target.value)} placeholder={'C:\\project\\PLAN.md'} />
                  <button type="button" className="confirm-dialog__btn" disabled={busy || !definitionPlanFilePath.trim()} onClick={() => void addDefinitionPlanFilePath()}>添加路径</button>
                  <button type="button" className="confirm-dialog__btn" disabled={busy || definitionPlanFiles.length >= MAX_PROJECT_PLAN_FILES} onClick={() => void pickDefinitionPlanFiles()}>选择计划文件</button>
                </div>
                {definitionPlanFiles.length > 0 && <div className="project-manager-dialog__plan-files">
                  {definitionPlanFiles.map((file) => <article key={file.path}>
                    <div><strong>{file.name}</strong><button type="button" className="confirm-dialog__btn" onClick={() => setDefinitionPlanFiles((current) => current.filter((candidate) => candidate.path !== file.path))}>移除</button></div>
                    <span>{file.path}</span><em>{Math.max(1, Math.ceil(file.sizeBytes / 1024))} KB · 已保存内容快照</em>
                  </article>)}
                </div>}
                <div className="supervisor-dialog__label supervisor-dialog__label--required">项目前置条件（每行一项）</div>
                <textarea className="supervisor-dialog__textarea" rows={4} value={preconditionsDraft} onChange={(event) => {
                  setPreconditionsDraft(event.target.value);
                  setConstraintNotice('');
                }} placeholder="每行填写一项必须先满足的物理、环境、权限或资源条件" />
                <div className="supervisor-dialog__label supervisor-dialog__label--required">完成条件（每行一项）</div>
                <textarea className="supervisor-dialog__textarea" rows={4} value={definitionDoneWhenDraft} onChange={(event) => {
                  setDefinitionDoneWhenDraft(event.target.value);
                  setConstraintNotice('');
                }} placeholder={'相关功能实现并验证\n关键测试通过\n未验证条件已经明确报告'} />
                <label className="project-manager-dialog__replace-goal">
                  <input type="checkbox" checked={replaceProjectDirection} onChange={(event) => setReplaceProjectDirection(event.target.checked)} />
                  <span><strong>清除旧目标的当前约束，按新方向重新规划</strong><small>未完成的旧工作项将停止并保留历史记录；项目管理 AI 会从新目标重新拆分任务。</small></span>
                </label>
                {session.pendingUserQuestion && <div className="supervisor-dialog__warning">请先完成当前需求确认，再保存新的项目配置。</div>}
                {constraintNotice && <div className="supervisor-dialog__notice" data-kind="success" role="status">{constraintNotice}</div>}
              </section>
              <section className="supervisor-dialog__group">
                <div className="supervisor-dialog__group-title">需求变更历史</div>
                <div className="project-manager-dialog__work-items">
                  {definitionUpdates.length === 0 && <div className="supervisor-dialog__empty">尚未调整项目目标或需求。</div>}
                  {definitionUpdates.map((event) => {
                    const previous = event.payload?.previous as Record<string, unknown> | undefined;
                    const next = event.payload?.next as Record<string, unknown> | undefined;
                    const mode = event.payload?.mode === 'replace' ? '替换旧目标' : '修订现有需求';
                    const lines = (value: unknown) => Array.isArray(value)
                      ? value.map((item) => String(item)).join('\n')
                      : '无';
                    return (
                      <details key={event.id}>
                        <summary><strong>{mode}</strong><span>{new Date(event.ts).toLocaleString('zh-CN', { hour12: false })}</span></summary>
                        <dl>
                          <dt>变更说明</dt><dd>{event.summary}</dd>
                          <dt>旧目标</dt><dd>{String(previous?.goal || '无')}</dd>
                          <dt>新目标</dt><dd>{String(next?.goal || '无')}</dd>
                          <dt>新前置条件</dt><dd>{lines(next?.preconditions)}</dd>
                          <dt>新完成条件</dt><dd>{lines(next?.doneWhen)}</dd>
                        </dl>
                      </details>
                    );
                  })}
                </div>
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
              <section className="supervisor-dialog__group project-manager-dialog__chat">
                <div className="project-manager-dialog__section-head">
                  <div>
                    <div className="supervisor-dialog__group-title">与项目管理 AI 对话</div>
                    <div className="supervisor-dialog__hint">当前项目：{session.goal}。对话会持续记录；其中确认的新目标、范围和验收细节会由项目管理 AI 写回项目配置并触发重规划。</div>
                  </div>
                  <span className="project-manager-dialog__chat-project">{session.projectDir}</span>
                </div>
                <div className="project-manager-dialog__conversation">
                  {conversation.length === 0 && <div className="supervisor-dialog__empty">会话已建立，可直接讨论需求、确认细节、调整方向、暂停或改线。</div>}
                  {conversation.map((event) => (
                    <div
                      key={event.id}
                      className="project-manager-dialog__message"
                      data-role={event.kind === 'manager-reply' ? 'manager' : 'user'}
                      aria-label={event.kind === 'manager-reply' ? '项目管理 AI 回复' : '用户询问'}
                    >
                      <header>
                        <strong>{event.kind === 'manager-reply' ? '项目管理 AI · 回复' : '你 · 询问'}</strong>
                        <time dateTime={new Date(event.ts).toISOString()}>{new Date(event.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
                      </header>
                      <p>{event.summary}</p>
                    </div>
                  ))}
                  {waitingForManagerReply && (
                    <div className="project-manager-dialog__reply-pending" role="status">
                      <i />项目管理 AI 正在处理并将回复到此项目会话
                    </div>
                  )}
                  <div ref={conversationEndRef} aria-hidden="true" />
                </div>
                <textarea
                  className="supervisor-dialog__textarea"
                  rows={3}
                  value={message}
                  onChange={(event) => setMessageDrafts((current) => ({ ...current, [session.id]: event.target.value }))}
                  placeholder="向当前项目提问，或讨论需求、优先级、暂停、改线和处理依据"
                  aria-label={`向“${session.goal}”的项目管理 AI 发送消息`}
                />
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
            )
          )}
        </div>

        {notice && <div className="supervisor-dialog__notice" data-kind="error" role="alert">{notice}</div>}
        <div className="supervisor-dialog__actions">
          {!creating && session?.status === 'active' && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void control('pause')}>暂停项目</button>}
          {!creating && (session?.status === 'paused' || session?.status === 'waiting') && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void control('resume')}>恢复项目</button>}
          {creating && session && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => { setCreating(false); setNotice(''); }}>取消添加</button>}
          <span className="supervisor-dialog__actions-spacer" />
          <button type="button" className="confirm-dialog__btn" onClick={close}>关闭</button>
          {!awaitingRecovery && (creating || !session) && <button type="button" className="confirm-dialog__btn confirm-dialog__btn--danger" disabled={busy} onClick={() => void start()}>{busy ? '正在添加…' : '添加项目'}</button>}
        </div>
      </div>
    </div>
  );
}
