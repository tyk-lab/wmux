import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  activeProjectManagerAttentionEvent,
  activeProjectGoal,
  activeProjectSubgoals,
  MAX_PROJECT_PLAN_FILES,
  projectDisplayName,
  type ProjectPlanFileSnapshot,
} from '../../../shared/project-manager';
import {
  DEFAULT_PROJECT_MANAGEMENT_AGENT_CONFIG,
  normalizeProjectManagementAgentConfig,
  projectAgentDefaultReasoningEffort,
  type ProjectManagementAgentConfig,
} from '../../../shared/project-manager-terminal';
import type { SplitNode } from '../../../shared/types';
import { projectDefinitionLines as conditionLines } from '../../project-manager/definition-lines';
import { openProjectManagerConsole } from '../../project-manager/console-surface';
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
  transitioning: '切换规划中',
  achieved: '已达成',
  superseded: '已被新目标替代',
  abandoned: '已放弃',
  blocked: '阻塞中',
  obsolete: '已取消',
};

function taskWorkModeLabel(mode: string | undefined): string {
  if (mode === 'multi-thread') return '固定多线程';
  if (mode === 'adaptive') return '自适应线程（按调查结果）';
  return '固定单线程';
}

type ProjectManagerConsoleView = 'conversation' | 'execution' | 'requirements';
type ProjectWorkItemIntervention = 'skip' | 'close';

const PROJECT_ALERT_LABELS: Record<string, string> = {
  'manager-runtime-failed': '项目管理 AI 运行时故障',
  'supervisor-runtime-failed': '项目专属监督故障',
  'task-runtime-failed': '任务终端 AI 故障',
  'manager-delivery-failed': '项目管理消息投递失败',
  'requirements-quiesce-failed': '需求变更停机确认失败',
  'guard-triggered': '项目执行护栏已停止推进',
  'project-paused': '项目 AI 主动暂停',
};

function projectActivityLabel(session: {
  status: string;
  activeGoalId?: string;
  workItems: Array<{ goalId?: string; status: string; workerSurfaceId?: string; supervisorLaneId?: string; latestBlocker?: string }>;
}): string {
  if (session.status !== 'active') return STATUS_LABELS[session.status] || session.status;
  const workItems = session.workItems.filter((item) => (
    !session.activeGoalId || !item.goalId || item.goalId === session.activeGoalId
  ));
  const current = workItems.find((item) => item.latestBlocker || item.status === 'waiting-decision' || item.status === 'failed')
    || workItems.find((item) => item.status === 'running' || item.status === 'validating')
    || workItems.find((item) => item.workerSurfaceId && !item.supervisorLaneId)
    || workItems.find((item) => item.status === 'planned');
  if (!current) return '规划中';
  if (current.latestBlocker || current.status === 'waiting-decision' || current.status === 'failed') return '阻塞中';
  if (current.status === 'running' || current.status === 'validating') return '监督中';
  if (current.workerSurfaceId) return '派遣中';
  return '规划中';
}

const PROJECT_AGENT_ROWS = [
  {
    key: 'manager',
    title: '项目 AI',
    hint: '每个项目使用独立运行时；切换 Agent 时分别安全重启并恢复各自的结构化上下文。',
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
    { value: '', label: '由 Kimi 模型或 Agent 配置决定' },
  ];
  if (agent === 'grok') return [
    { value: '', label: '使用 Grok 默认 Thinking' },
    { value: 'low', label: '低（更快）' },
    { value: 'medium', label: '中（均衡）' },
    { value: 'high', label: '高（更深入）' },
  ];
  return [];
}

function ProjectAgentConfigFields({
  value,
  onChange,
}: {
  value: ProjectManagementAgentConfig;
  onChange: (next: ProjectManagementAgentConfig) => void;
}) {
  return (
    <div className="project-manager-dialog__agent-grid">
      {PROJECT_AGENT_ROWS.map((row) => {
        const selection = value[row.key];
        const models = modelOptionsFor(selection.agent);
        const reasoningOptions = projectReasoningOptions(selection.agent);
        return (
          <article key={row.key}>
            <strong>{row.title}</strong>
            <label>
              <span>Agent</span>
              <select value={selection.agent} onChange={(event) => {
                const agent = event.target.value;
                onChange(normalizeProjectManagementAgentConfig({
                  ...value,
                  [row.key]: { agent, model: '', reasoningEffort: projectAgentDefaultReasoningEffort(agent) },
                } as Partial<ProjectManagementAgentConfig>));
              }}>
                {row.agents.map(([agent, label]) => <option key={agent} value={agent}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>模型</span>
              <select value={selection.model} onChange={(event) => {
                onChange(normalizeProjectManagementAgentConfig({
                  ...value,
                  [row.key]: { ...value[row.key], model: event.target.value },
                }));
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
              <select value={selection.reasoningEffort} onChange={(event) => {
                onChange(normalizeProjectManagementAgentConfig({
                  ...value,
                  [row.key]: { ...value[row.key], reasoningEffort: event.target.value },
                }));
              }}>
                {reasoningOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <p>{row.hint}</p>
          </article>
        );
      })}
    </div>
  );
}

interface ProjectRecoveryCandidate {
  id: string;
  projectDir: string;
  projectName?: string;
  goal: string;
  status: string;
  workItemCount: number;
  executionProtocolVersion: number;
  requiresProtocolMigration: boolean;
  updatedAt: number;
}

interface ProjectManagerDialogProps {
  embeddedProjectId?: string;
}

export default function ProjectManagerDialog({ embeddedProjectId }: ProjectManagerDialogProps = {}) {
  const dialogOpen = useStore((state) => state.projectManagerDialogOpen);
  const dialogView = useStore((state) => state.projectManagerDialogView);
  const embedded = !!embeddedProjectId;
  const open = embedded || dialogOpen;
  const session = useStore((state) => embeddedProjectId
    ? state.projectManagers.find((candidate) => candidate.id === embeddedProjectId) || null
    : state.projectManager);
  const sessions = useStore((state) => state.projectManagers);
  const supervisor = useStore((state) => state.supervisor);
  const workspaces = useStore((state) => state.workspaces);
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId);
  const close = useStore((state) => state.closeProjectManagerDialog);
  const selectProjectManager = useStore((state) => state.selectProjectManager);
  const workspacePrefs = useStore((state) => state.workspacePrefs);
  const setWorkspacePrefs = useStore((state) => state.setWorkspacePrefs);
  const [projectDir, setProjectDir] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectScope, setProjectScope] = useState('');
  const [goal, setGoal] = useState('');
  const [preconditions, setPreconditions] = useState('');
  const [supervisorNotes, setSupervisorNotes] = useState('');
  const [planFiles, setPlanFiles] = useState<ProjectPlanFileSnapshot[]>([]);
  const [planFilePath, setPlanFilePath] = useState('');
  const [definitionGoalDraft, setDefinitionGoalDraft] = useState('');
  const [definitionDoneWhenDraft, setDefinitionDoneWhenDraft] = useState('');
  const [definitionPlanFiles, setDefinitionPlanFiles] = useState<ProjectPlanFileSnapshot[]>([]);
  const [definitionPlanFilePath, setDefinitionPlanFilePath] = useState('');
  const [goalChangeMode, setGoalChangeMode] = useState<'refine' | 'pivot'>('refine');
  const [preconditionsDraft, setPreconditionsDraft] = useState('');
  const [supervisorNotesDraft, setSupervisorNotesDraft] = useState('');
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
  const [recoveryDeleteCandidate, setRecoveryDeleteCandidate] = useState<ProjectRecoveryCandidate | null>(null);
  const [clarificationOptionId, setClarificationOptionId] = useState('');
  const [clarificationAnswer, setClarificationAnswer] = useState('');
  const [workItemInterventionId, setWorkItemInterventionId] = useState('');
  const [workItemIntervention, setWorkItemIntervention] = useState<ProjectWorkItemIntervention>('skip');
  const [workItemInterventionReason, setWorkItemInterventionReason] = useState('');
  const [workItemInterventionNotice, setWorkItemInterventionNotice] = useState('');
  const [activeView, setActiveView] = useState<ProjectManagerConsoleView>('conversation');
  const goalRef = useRef<HTMLTextAreaElement | null>(null);
  const recoveryDeleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const clarificationRef = useRef<HTMLElement | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const conversation = useMemo(() => session?.events.filter((event) => (
    event.kind === 'user-message' || event.kind === 'manager-reply'
  )).slice(-50) || [], [session?.events]);
  const definitionUpdates = useMemo(() => session?.events.filter((event) => (
    event.kind === 'project-definition-updated'
  )).slice(-20).reverse() || [], [session?.events]);
  const currentGoal = useMemo(() => session ? activeProjectGoal(session) : null, [session]);
  const currentWorkItems = useMemo(() => session?.workItems.filter((item) => (
    !session.activeGoalId || !item.goalId || item.goalId === session.activeGoalId
  )) || [], [session]);
  const intervenableWorkItems = useMemo(() => (
    !session || ['completed', 'stopped'].includes(session.status)
      ? []
      : currentWorkItems.filter((item) => !['completed', 'stopped'].includes(item.status))
  ), [currentWorkItems, session]);
  const selectedInterventionWorkItem = useMemo(() => intervenableWorkItems.find((item) => (
    item.id === workItemInterventionId
  )) || null, [intervenableWorkItems, workItemInterventionId]);
  const currentSubgoals = useMemo(() => session ? activeProjectSubgoals(session) : [], [session]);
  const goalHistory = useMemo(() => [...(session?.goals || [])].sort((left, right) => right.sequence - left.sequence), [session?.goals]);
  const activeAlert = useMemo(() => {
    if (!session) return null;
    return activeProjectManagerAttentionEvent(session.events) || null;
  }, [session]);
  const message = session ? messageDrafts[session.id] || '' : '';
  const lastConversationEvent = conversation.at(-1);
  const sessionDefinitionFingerprint = session ? JSON.stringify([
    session.goal,
    session.projectName,
    session.projectScope,
    session.activeGoalId,
    session.preconditions,
    session.supervisorNotes,
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
    if (open) setActiveView('conversation');
  }, [open, session?.id]);

  useEffect(() => {
    if (embedded || !dialogOpen) return;
    setCreating(dialogView === 'create' || sessions.length === 0);
    if (dialogView === 'create') setNotice('');
  }, [dialogOpen, dialogView, embedded, sessions.length]);

  useEffect(() => {
    setWorkItemInterventionId('');
    setWorkItemIntervention('skip');
    setWorkItemInterventionReason('');
    setWorkItemInterventionNotice('');
  }, [session?.activeGoalId, session?.id]);

  useEffect(() => {
    if (!open) setRecoveryDeleteCandidate(null);
  }, [open]);

  useEffect(() => {
    if (!recoveryDeleteCandidate) return undefined;
    recoveryDeleteCancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setRecoveryDeleteCandidate(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recoveryDeleteCandidate]);

  useEffect(() => {
    if (!open) return;
    setDefinitionGoalDraft(session?.goal || '');
    setPreconditionsDraft((session?.preconditions || []).join('\n'));
    setSupervisorNotesDraft((session?.supervisorNotes || []).join('\n'));
    setDefinitionDoneWhenDraft((session?.doneWhen || []).join('\n'));
    setDefinitionPlanFiles(session?.planFiles || []);
    setDefinitionPlanFilePath('');
    setGoalChangeMode('refine');
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
    if (!open || activeView !== 'conversation' || conversation.length === 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const target = conversationRef.current;
      target?.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, conversation.length, lastConversationEvent?.id, open, session?.id]);

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
      setSelectedRecoveryIds(candidates.map((candidate: ProjectRecoveryCandidate) => candidate.id));
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
        ...(restore ? {
          projectIds: selectedRecoveryIds,
          agentConfig: normalizeProjectManagementAgentConfig(agentDraft),
        } : {}),
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
        : [...current, projectId]
    ));
    setNotice('');
  };

  const deleteRecoveryCandidate = async (candidate: ProjectRecoveryCandidate) => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    setConfigNotice('');
    try {
      const result = await invoke({ action: 'delete-recovery-project', projectId: candidate.id });
      const remaining = recoveryCandidates.filter((item) => item.id !== candidate.id);
      setRecoveryCandidates(remaining);
      setSelectedRecoveryIds((current) => current.filter((id) => id !== candidate.id));
      if (remaining.length === 0) {
        setRecoveryStatus('done');
        window.requestAnimationFrame(() => goalRef.current?.focus({ preventScroll: true }));
      }
      setConfigNotice(result.message || '历史项目管理记录已删除。');
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setRecoveryDeleteCandidate(null);
      setBusy(false);
    }
  };

  const start = async () => {
    const projectPreconditions = conditionLines(preconditions);
    const projectSupervisorNotes = conditionLines(supervisorNotes);
    const conditions = conditionLines(doneWhen);
    if (!projectDir.trim() || !goal.trim()) {
      setNotice('请填写项目目录和当前主目标。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const result = await invoke({
        action: 'start',
        projectDir: projectDir.trim(),
        projectName: projectName.trim(),
        projectScope: projectScope.trim(),
        goal: goal.trim(),
        preconditions: projectPreconditions,
        supervisorNotes: projectSupervisorNotes,
        planFiles,
        doneWhen: conditions,
      });
      setCreating(false);
      setProjectName('');
      setProjectScope('');
      setGoal('');
      setPreconditions('');
      setSupervisorNotes('');
      setPlanFiles([]);
      setPlanFilePath('');
      setDoneWhen('');
      setProjectDir('');
      const projectId = String(result.session?.id || '');
      if (projectId) {
        close();
        openProjectManagerConsole(projectId);
      }
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
    const projectSupervisorNotes = conditionLines(supervisorNotesDraft);
    const projectDoneWhen = conditionLines(definitionDoneWhenDraft);
    if (!definitionGoalDraft.trim() || projectPreconditions.length === 0 || projectDoneWhen.length === 0) {
      setNotice('请填写项目目标、至少一个前置条件和至少一个可验证的完成条件。没有额外条件时请明确填写“无额外物理前置条件”。');
      return;
    }
    setBusy(true);
    setNotice('');
    setConstraintNotice('');
    try {
      const result = await invoke({
        action: 'update-definition',
        projectId: session.id,
        goal: definitionGoalDraft.trim(),
        preconditions: projectPreconditions,
        supervisorNotes: projectSupervisorNotes,
        planFiles: definitionPlanFiles,
        doneWhen: projectDoneWhen,
        mode: goalChangeMode,
        reason: goalChangeMode === 'pivot'
          ? '用户在稳定项目内切换新的主目标'
          : '用户在项目中心调整当前主目标或需求',
      });
      setGoalChangeMode('refine');
      setConstraintNotice(result.message || '主目标变更已记录。');
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const discardProjectDefinitionChanges = () => {
    if (!session || busy) return;
    setDefinitionGoalDraft(session.goal);
    setPreconditionsDraft(session.preconditions.join('\n'));
    setSupervisorNotesDraft((session.supervisorNotes || []).join('\n'));
    setDefinitionDoneWhenDraft(session.doneWhen.join('\n'));
    setDefinitionPlanFiles(session.planFiles || []);
    setDefinitionPlanFilePath('');
    setGoalChangeMode('refine');
    setNotice('');
    setConstraintNotice('未确认变更已取消，当前项目目标和需求没有改变。');
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
      await invoke({ action, projectId: session?.id, reason: action === 'pause' ? '用户在项目中心暂停项目' : '用户在项目中心恢复项目' });
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
          ? '用户在项目中心暂停全部项目'
          : '用户在项目中心恢复全部项目',
      });
    } catch (error) {
      setNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelectedProject = async () => {
    if (!session || busy) return;
    if (!window.confirm(`将删除“${projectDisplayName(session)}”的项目管理记录，并关闭该项目已绑定的监督 AI 和任务终端。项目目录及业务文件不会删除。是否继续？`)) return;
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
    goalChangeMode === 'pivot'
    || definitionGoalDraft.trim() !== session.goal
    || conditionLines(preconditionsDraft).join('\n') !== session.preconditions.join('\n')
    || conditionLines(supervisorNotesDraft).join('\n') !== (session.supervisorNotes || []).join('\n')
    || conditionLines(definitionDoneWhenDraft).join('\n') !== session.doneWhen.join('\n')
    || JSON.stringify(definitionPlanFiles) !== JSON.stringify(session.planFiles || [])
  );
  const projectDefinitionDraftDirty = projectDefinitionChanged || !!definitionPlanFilePath.trim();
  const closeDialog = () => {
    if (embedded) return;
    if (busy) return;
    if (!creating && session && projectDefinitionDraftDirty) discardProjectDefinitionChanges();
    close();
  };

  const interveneWorkItem = async () => {
    if (!session || !selectedInterventionWorkItem || busy) {
      if (!selectedInterventionWorkItem) setWorkItemInterventionNotice('请先选择一个尚未结束的工作项。');
      return;
    }
    setBusy(true);
    setNotice('');
    setWorkItemInterventionNotice('');
    try {
      const result = await invoke({
        action: 'intervene-work-item',
        projectId: session.id,
        workItemId: selectedInterventionWorkItem.id,
        intervention: workItemIntervention,
        reason: workItemInterventionReason.trim(),
      });
      setWorkItemInterventionId('');
      setWorkItemIntervention('skip');
      setWorkItemInterventionReason('');
      setWorkItemInterventionNotice(result.message || '工作项干预已提交给项目 AI。');
    } catch (error) {
      setWorkItemInterventionNotice(String((error as Error)?.message || error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={embedded ? 'project-manager-session-pane__frame' : 'confirm-dialog__overlay supervisor-dialog__overlay'} onMouseDown={(event) => {
      if (!embedded && event.target === event.currentTarget) closeDialog();
    }}>
      <div className={`supervisor-dialog project-manager-dialog${embedded ? ' project-manager-dialog--embedded' : ''}`} role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : true} aria-label={embedded ? '项目管理控制台' : '项目中心'}>
        <header className="supervisor-dialog__header project-manager-dialog__header">
          <div className="project-manager-dialog__header-row">
            <div className="supervisor-dialog__title">{embedded ? '项目管理' : '项目 AI 中心'}</div>
            {session && !creating && (
              <span className="project-manager-dialog__header-status" data-status={session.status}>
                {projectActivityLabel(session)} · 专属监督 {activeManagedLanes.length}
              </span>
            )}
          </div>
          <div className="supervisor-dialog__sub" title={session?.goal}>
            {session && !creating
              ? `${projectDisplayName(session)} · G${currentGoal?.sequence || 1} ${session.goal}`
              : '项目是稳定容器；每个项目由独立项目 AI 围绕当前主目标推进'}
          </div>
        </header>

        <div className="supervisor-dialog__body">
          {!embedded && (!session || creating || awaitingRecovery) && <div className="project-manager-dialog__architecture" aria-label="项目中心调度架构">
            <span>用户 / 飞书</span><b>↔</b><span data-primary="true">项目中心</span><b>→</b><span>每项目独立会话</span><b>→</b><span>项目 AI + 监督 AI + 任务 AI</span>
          </div>}

          {!embedded && awaitingRecovery && (
            <section className="supervisor-dialog__group project-manager-dialog__recovery">
              <div className="supervisor-dialog__group-title">{recoveryStatus === 'checking' ? '正在检查历史项目…' : '选择历史项目继续管理'}</div>
              {recoveryStatus === 'prompt' && (
                <>
                  <div className="supervisor-dialog__hint">项目中心只恢复你勾选的项目，并为每个项目创建独立的新 AI 会话继续推进。未选择的历史记录会保留。</div>
                  <div className="project-manager-dialog__recovery-summary">已选择 {selectedRecoveryIds.length} 个项目</div>
                  <details open className="supervisor-dialog__advanced project-manager-dialog__agent-config">
                    <summary>本次恢复使用的 Agent 配置 <span>可在恢复前重新选择</span></summary>
                    <div className="supervisor-dialog__hint">所选项目共用这组项目模式配置；项目 AI 会立即按此启动，后续新监督和新任务终端也使用对应 Agent、模型及 Thinking。</div>
                    <ProjectAgentConfigFields value={agentDraft} onChange={(next) => {
                      setAgentDraft(next);
                      setConfigNotice('');
                    }} />
                  </details>
                  <div className="project-manager-dialog__recovery-list">
                    {recoveryCandidates.map((candidate) => (
                      <div key={candidate.id} className="project-manager-dialog__recovery-item">
                        <label data-selected={selectedRecoveryIds.includes(candidate.id) ? '1' : '0'}>
                          <input
                            type="checkbox"
                            checked={selectedRecoveryIds.includes(candidate.id)}
                            onChange={() => toggleRecoveryCandidate(candidate.id)}
                          />
                          <span>
                            <strong>{candidate.projectName || candidate.goal}</strong>
                            {candidate.projectName && <small>当前主目标：{candidate.goal}</small>}
                            <small>{candidate.projectDir}</small>
                            <em>
                              {STATUS_LABELS[candidate.status] || candidate.status} · {candidate.workItemCount} 个工作项
                              {candidate.requiresProtocolMigration ? ' · 恢复时升级到最新执行协议' : ''}
                              {' · '}最后更新 {new Date(candidate.updatedAt).toLocaleString('zh-CN', { hour12: false })}
                            </em>
                          </span>
                        </label>
                        <button
                          type="button"
                          className="confirm-dialog__btn confirm-dialog__btn--danger project-manager-dialog__recovery-delete"
                          disabled={busy}
                          aria-label={`删除历史项目记录：${candidate.projectName || candidate.goal}`}
                          onClick={() => setRecoveryDeleteCandidate(candidate)}
                        >删除记录</button>
                      </div>
                    ))}
                  </div>
                  <div className="project-manager-dialog__recovery-actions">
                    <button type="button" className="confirm-dialog__btn confirm-dialog__btn--danger" disabled={busy || selectedRecoveryIds.length === 0} onClick={() => void chooseRecovery(true)}>{busy ? '正在恢复…' : `恢复所选项目（${selectedRecoveryIds.length}）`}</button>
                    <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void chooseRecovery(false, true)}>添加新项目</button>
                    <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void chooseRecovery(false)}>暂不恢复</button>
                  </div>
                  <div className="supervisor-dialog__hint">恢复后仍可继续添加项目，不限制活动项目数量。旧项目 AI、监督 AI 和任务 AI 对话不会直接复活，将通过恢复包建立新链路。</div>
                </>
              )}
            </section>
          )}

          {embedded && session?.progressSync?.status === 'review-required' && !creating && (
            <section className="supervisor-dialog__group project-manager-dialog__clarification" role="status" aria-label="项目进度等待项目 AI 同步">
              <div className="supervisor-dialog__group-title">检测到项目目录有新进度</div>
              <div className="supervisor-dialog__warning">项目 AI 正在把其他 AI、人工操作或中断前未汇报的变化同步进当前安排；同步完成前不会沿用旧任务继续派发。</div>
              <details>
                <summary>查看同步摘要</summary>
                <pre className="project-manager-dialog__pre">{session.progressSync.summary}</pre>
              </details>
              <div className="supervisor-dialog__hint">这是项目 AI 的内部复核，不需要用户逐步确认；只有出现业务选择、权限或高风险冲突时才会单独询问。</div>
            </section>
          )}

          {embedded && session?.orientation?.status === 'required' && !creating && (
            <section className="supervisor-dialog__group project-manager-dialog__clarification" role="status" aria-label="项目 AI 正在复核项目现状">
              <div className="supervisor-dialog__group-title">项目 AI 正在建立当前认知基线</div>
              <div className="supervisor-dialog__warning">在确认当前目标、权限边界、目录进度和每个未停止工作项之前，控制层不会允许项目 AI 规划、恢复或派发任务。</div>
              <details>
                <summary>查看触发原因和绑定版本</summary>
                <div className="supervisor-dialog__hint">{session.orientation.reason}</div>
                <div className="supervisor-dialog__hint">需求 R{session.orientation.requirementsVersion} · 授权 A{session.orientation.authorizationVersion} · 快照 {session.orientation.snapshotFingerprint}</div>
              </details>
              <div className="supervisor-dialog__hint">这是项目 AI 的内部复核，不需要用户逐步确认；只有发现真实业务冲突、越权或人工前置条件时才会单独询问。</div>
            </section>
          )}

          {embedded && !!session?.pendingSupervisorTransitions?.length && !creating && (
            <section className="supervisor-dialog__group project-manager-dialog__clarification" role="status" aria-label="项目 AI 正在处理监督状态交接">
              <div className="supervisor-dialog__group-title">项目 AI 正在处理监督状态交接</div>
              <div className="supervisor-dialog__warning">监督 AI 已主动上报完成、待续、暂停或异常状态；项目 AI 会据此更新任务方向，不需要用户确认。</div>
              <details>
                <summary>查看待处理交接（{session.pendingSupervisorTransitions.length}）</summary>
                <div className="project-manager-dialog__decision-list">
                  {session.pendingSupervisorTransitions.slice(-5).reverse().map((transition) => (
                    <div key={transition.id} className="project-manager-dialog__decision-item">
                      <strong>{transition.kind} · {transition.workItemId || '未绑定任务'}</strong>
                      <span>{transition.summary}</span>
                    </div>
                  ))}
                </div>
              </details>
              <div className="supervisor-dialog__hint">交接在项目 AI 回写处理结果前会持久保留；定时看门狗只负责丢事件补投，不再反复询问监督进度。</div>
            </section>
          )}

          {embedded && session?.pendingUserQuestion && !creating && (
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

          {!embedded && !awaitingRecovery && <details className="supervisor-dialog__advanced project-manager-dialog__agent-config">
            <summary>项目模式 Agent 配置 <span>项目 AI / 专属监督 / 任务终端</span></summary>
            <div className="project-manager-dialog__section-head">
              <div>
                <div className="supervisor-dialog__hint">仅作用于项目模式：每个项目的项目 AI、监督 AI、任务 AI 三层分别选择 Agent、模型和思考程度。</div>
              </div>
              <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void saveAgentConfig()}>保存配置</button>
            </div>
            <ProjectAgentConfigFields value={agentDraft} onChange={(next) => {
              setAgentDraft(next);
              setConfigNotice('');
            }} />
            {configNotice && <div className="supervisor-dialog__notice" data-kind="success" role="status">{configNotice}</div>}
          </details>}

          <div
            className="project-manager-dialog__workspace"
            data-console={embedded && session && !creating && !awaitingRecovery ? '1' : '0'}
            data-has-projects={sessions.length > 0 ? '1' : '0'}
          >
          {!embedded && sessions.length > 0 && (
            <section className="supervisor-dialog__group project-manager-dialog__portfolio">
              <div className="project-manager-dialog__section-head">
                <div>
                  <div className="supervisor-dialog__group-title">项目（{activeSessionCount} 个活动）</div>
                  <div className="supervisor-dialog__hint">项目数量不受限制；同一目录也可按不同稳定范围建立独立项目。每个项目使用独立会话，内部始终只有一个项目 AI 和一条监督链。</div>
                </div>
                <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => {
                  setCreating(true);
                  setProjectDir('');
                  setProjectName('');
                  setProjectScope('');
                  setNotice('');
                }}>添加项目</button>
              </div>
              <div className="project-manager-dialog__project-list">
                {sessions.map((candidate) => (
                  <article key={candidate.id} data-selected={candidate.id === session?.id ? '1' : '0'}>
                    <button type="button" className="project-manager-dialog__project-select" onClick={() => {
                      selectProjectManager(candidate.id);
                      setCreating(false);
                      setNotice('');
                    }}>
                      <strong>{projectDisplayName(candidate)}</strong>
                      <span>G{activeProjectGoal(candidate).sequence} · {candidate.goal}</span>
                      <span>{candidate.projectDir}</span>
                      <em>{projectActivityLabel(candidate)}</em>
                    </button>
                    <button type="button" className="confirm-dialog__btn project-manager-dialog__project-open" onClick={() => {
                      close();
                      openProjectManagerConsole(candidate.id);
                    }}>打开控制台</button>
                  </article>
                ))}
              </div>
              <div className="project-manager-dialog__portfolio-actions">
                {canPausePortfolio && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void controlPortfolio('pause-all-projects')}>全部暂停</button>}
                {canResumePortfolio && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void controlPortfolio('resume-all-projects')}>全部恢复</button>}
                {session && <button type="button" className="confirm-dialog__btn confirm-dialog__btn--danger" disabled={busy} onClick={() => void deleteSelectedProject()}>删除选中项目</button>}
              </div>
            </section>
          )}

          {(embedded || creating || sessions.length === 0) && <main className="project-manager-dialog__main">
          {embedded && session && !creating && !awaitingRecovery && (
            <nav className="project-manager-dialog__tabs" aria-label="项目控制台视图">
              <button type="button" data-active={activeView === 'conversation' ? '1' : '0'} onClick={() => setActiveView('conversation')}>对话与进度</button>
              <button type="button" data-active={activeView === 'execution' ? '1' : '0'} onClick={() => setActiveView('execution')}>
                执行链{activeAlert ? ' · 告警' : ''}
              </button>
              <button type="button" data-active={activeView === 'requirements' ? '1' : '0'} onClick={() => setActiveView('requirements')}>目标与需求</button>
            </nav>
          )}

          {!awaitingRecovery && (
            creating || !session ? <section className="supervisor-dialog__group">
              <div className="supervisor-dialog__group-title">添加项目</div>
              <div className="supervisor-dialog__hint">先定义长期稳定的项目身份，再说明当前要完成的主目标。创建后，专属项目 AI 会提出 3-7 个阶段目标并自主拆分执行任务。</div>
              <div className="supervisor-dialog__label">项目名称（可选）</div>
              <input className="supervisor-dialog__input" value={projectName} onChange={(event) => {
                setProjectName(event.target.value);
                setNotice('');
              }} placeholder="留空则使用项目目录名称，例如：TMC6460 调试与验证" />
              <div className="supervisor-dialog__label supervisor-dialog__label--required">项目目录</div>
              <div className="project-manager-dialog__directory-row">
                <input className="supervisor-dialog__input" value={projectDir} onChange={(event) => {
                  setProjectDir(event.target.value);
                  setNotice('');
                }} placeholder={'E:\\project'} />
                <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void pickProjectDirectory()}>选择目录</button>
              </div>
              <div className="supervisor-dialog__label">项目稳定范围（可选）</div>
              <textarea className="supervisor-dialog__textarea" rows={2} value={projectScope} onChange={(event) => {
                setProjectScope(event.target.value);
                setNotice('');
              }} placeholder="留空则默认仅处理项目目录内与当前项目直接相关的工作" />
              <div className="supervisor-dialog__label supervisor-dialog__label--required">当前主目标</div>
              <textarea ref={goalRef} className="supervisor-dialog__textarea" rows={3} value={goal} onChange={(event) => {
                setGoal(event.target.value);
                setNotice('');
              }} placeholder="描述用户当前希望项目最终达到的结果；同一项目以后可以切换新的主目标" />
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
              <div className="project-manager-dialog__section-head">
                <div className="supervisor-dialog__label">项目前置条件（可选，每行一项）</div>
                <button type="button" className="confirm-dialog__btn" disabled={busy || preconditions.trim() === '无额外物理前置条件'} onClick={() => {
                  setPreconditions('无额外物理前置条件');
                  setNotice('');
                }}>无额外前置条件</button>
              </div>
              <textarea className="supervisor-dialog__textarea" rows={4} value={preconditions} onChange={(event) => {
                setPreconditions(event.target.value);
                setNotice('');
              }} placeholder={'树莓派已接通受控电源并可安全断电\n局域网访问权限已获得\n目标设备、接口和安全限值已经人工确认'} />
              <div className="supervisor-dialog__hint">这里填写的内容视为当前需求版本中用户已确认的事实；其中明确写出的授权会持续有效。可留空让项目 AI 判断并起草；只有硬件、环境、权限或安全差异会实质改变方案时才会向你确认。</div>
              <div className="supervisor-dialog__label">监督 AI 注意事项（可选，每行一项）</div>
              <textarea className="supervisor-dialog__textarea" rows={3} value={supervisorNotes} onChange={(event) => {
                setSupervisorNotes(event.target.value);
                setNotice('');
              }} placeholder={'完成一个有意义的阶段后，让任务 AI 同步相关文档\n形成可回滚成果后提交本地 Git commit'} />
              <div className="supervisor-dialog__hint">项目 AI 会把适用事项交给各阶段监督 AI，并可补充阶段专属事项；它们只决定检查点提醒，不扩大范围、权限或推送/发布授权。</div>
              <div className="supervisor-dialog__label">当前主目标完成条件（可选，每行一项）</div>
              <textarea className="supervisor-dialog__textarea" rows={4} value={doneWhen} onChange={(event) => {
                setDoneWhen(event.target.value);
                setNotice('');
              }} placeholder={'相关功能实现并验证\n关键测试通过\n高风险或未验证项已明确报告'} />
              <div className="supervisor-dialog__hint">可留空让项目 AI 起草可验证的完成条件；只有不同合理标准会实质改变范围或验收时才会向你确认。阶段目标、执行任务、技术路线与普通重试由项目 AI 和专属监督自主决策。</div>
            </section> : (
            <>
              {activeView === 'execution' && <section className="project-manager-dialog__summary">
                <div><span>状态</span><strong>{currentGoal?.status === 'achieved' ? '等待下一主目标' : projectActivityLabel(session)}</strong></div>
                <div><span>当前目标工作项</span><strong>{currentWorkItems.length}</strong></div>
                <div><span>正在管理的监督 AI</span><strong>{activeManagedLanes.length}</strong></div>
                <div><span>待决策</span><strong>{currentWorkItems.filter((item) => item.status === 'waiting-decision').length}</strong></div>
              </section>}
              {activeAlert && (
                <section className="project-manager-dialog__alert" role="alert">
                  <div className="project-manager-dialog__alert-icon">!</div>
                  <div>
                    <strong>{PROJECT_ALERT_LABELS[activeAlert.kind] || '项目运行告警'}</strong>
                    <p>{activeAlert.summary}</p>
                    <small>{new Date(activeAlert.ts).toLocaleString('zh-CN', { hour12: false })} · 项目与对应执行链会保持暂停，处理后再恢复。</small>
                  </div>
                  <button type="button" className="confirm-dialog__btn" onClick={() => setActiveView('execution')}>查看执行链</button>
                </section>
              )}
              {activeView === 'requirements' && <section className="supervisor-dialog__group project-manager-dialog__preconditions">
                <div className="project-manager-dialog__section-head">
                  <div>
                    <div className="supervisor-dialog__group-title">项目身份与当前主目标</div>
                    <div className="supervisor-dialog__hint">项目名称、目录和稳定范围属于长期身份；这里调整的是 G{currentGoal?.sequence || 1}，或在同一项目内切换新的主目标。变更后由项目 AI 自主评估复用、停止和重绑。</div>
                  </div>
                  <span
                    className="project-manager-dialog__definition-state"
                    data-dirty={projectDefinitionDraftDirty ? '1' : '0'}
                    role="status"
                  >{projectDefinitionDraftDirty ? '有未确认变更 · 尚未生效' : '当前内容已生效'}</span>
                </div>
                <div className="supervisor-dialog__label">项目名称</div>
                <div className="project-manager-dialog__path">{projectDisplayName(session)}</div>
                <div className="supervisor-dialog__label">项目目录（不可变）</div>
                <div className="project-manager-dialog__path">{session.projectDir}</div>
                <div className="supervisor-dialog__label">稳定项目范围</div>
                <div className="project-manager-dialog__path">{session.projectScope}</div>
                <div className="supervisor-dialog__label supervisor-dialog__label--required">当前主目标 G{currentGoal?.sequence || 1}</div>
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
                }} placeholder="每行填写一项已确认条件或授权；例如：硬件已上电，允许直接运行本项目测试" />
                <div className="supervisor-dialog__label">监督 AI 注意事项（可选，每行一项）</div>
                <textarea className="supervisor-dialog__textarea" rows={3} value={supervisorNotesDraft} onChange={(event) => {
                  setSupervisorNotesDraft(event.target.value);
                  setConstraintNotice('');
                }} placeholder={'完成一个有意义的阶段后，让任务 AI 同步相关文档\n形成可回滚成果后提交本地 Git commit'} />
                <div className="supervisor-dialog__hint">适用于后续阶段监督；项目 AI 可在工作项合同中补充更具体的注意事项。</div>
                <div className="supervisor-dialog__label supervisor-dialog__label--required">当前主目标完成条件（每行一项）</div>
                <textarea className="supervisor-dialog__textarea" rows={4} value={definitionDoneWhenDraft} onChange={(event) => {
                  setDefinitionDoneWhenDraft(event.target.value);
                  setConstraintNotice('');
                }} placeholder={'相关功能实现并验证\n关键测试通过\n未验证条件已经明确报告'} />
                <div className="supervisor-dialog__label supervisor-dialog__label--required">本次变更类型</div>
                <div className="project-manager-dialog__clarification-options">
                  <label data-selected={goalChangeMode === 'refine' ? '1' : '0'}>
                    <input type="radio" name="project-goal-change-mode" checked={goalChangeMode === 'refine'} onChange={() => setGoalChangeMode('refine')} />
                    <span><strong>调整当前主目标</strong><small>最终结果没有改变；项目 AI 复核受影响任务，兼容任务显式重绑后继续。</small></span>
                  </label>
                  <label data-selected={goalChangeMode === 'pivot' ? '1' : '0'}>
                    <input type="radio" name="project-goal-change-mode" checked={goalChangeMode === 'pivot'} onChange={() => setGoalChangeMode('pivot')} />
                    <span><strong>切换新的主目标</strong><small>仍属于同一稳定项目；旧目标进入历史，未完成旧任务停止，新建阶段计划和执行链。</small></span>
                  </label>
                </div>
                {session.pendingUserQuestion && <div className="supervisor-dialog__warning">请先完成当前需求确认，再保存新的项目配置。</div>}
                {constraintNotice && <div className="supervisor-dialog__notice" data-kind="success" role="status">{constraintNotice}</div>}
              </section>}
              {activeView === 'requirements' && <section className="supervisor-dialog__group">
                <div className="supervisor-dialog__group-title">当前主目标的阶段计划</div>
                <div className="supervisor-dialog__hint">阶段目标由项目 AI 维护，只描述粗粒度成果、依赖和验收；具体终端任务由项目 AI 和专属监督继续拆分。</div>
                <div className="project-manager-dialog__work-items">
                  {currentSubgoals.length === 0 && <div className="supervisor-dialog__empty">项目 AI 尚未提交阶段计划，当前主目标不能启动新的监督任务。</div>}
                  {currentSubgoals.map((subgoal) => (
                    <details key={subgoal.id} open={subgoal.status === 'active' || subgoal.status === 'blocked'}>
                      <summary><strong>S{subgoal.order} · {subgoal.title}</strong><span>{STATUS_LABELS[subgoal.status] || subgoal.status}</span></summary>
                      <dl>
                        <dt>预期成果</dt><dd>{subgoal.outcome}</dd>
                        <dt>验收依据</dt><dd>{subgoal.acceptance.join('\n')}</dd>
                        <dt>依赖阶段</dt><dd>{subgoal.dependencies.length > 0 ? subgoal.dependencies.join('、') : '无'}</dd>
                      </dl>
                    </details>
                  ))}
                </div>
              </section>}
              {activeView === 'requirements' && <section className="supervisor-dialog__group">
                <div className="supervisor-dialog__group-title">主目标历史</div>
                <div className="project-manager-dialog__work-items">
                  {goalHistory.map((goalEntry, index) => (
                    <details key={goalEntry.id} open={index === 0}>
                      <summary><strong>G{goalEntry.sequence} · {goalEntry.statement}</strong><span>{STATUS_LABELS[goalEntry.status] || goalEntry.status}</span></summary>
                      <dl>
                        <dt>完成条件</dt><dd>{goalEntry.doneWhen.join('\n')}</dd>
                        <dt>需求版本</dt><dd>v{goalEntry.requirementsVersion}</dd>
                        {goalEntry.changeReason && <><dt>切换说明</dt><dd>{goalEntry.changeReason}</dd></>}
                      </dl>
                    </details>
                  ))}
                </div>
              </section>}
              {activeView === 'requirements' && <section className="supervisor-dialog__group">
                <div className="supervisor-dialog__group-title">详细变更记录</div>
                <div className="project-manager-dialog__work-items">
                  {definitionUpdates.length === 0 && <div className="supervisor-dialog__empty">尚未调整项目目标或需求。</div>}
                  {definitionUpdates.map((event) => {
                    const previous = event.payload?.previous as Record<string, unknown> | undefined;
                    const next = event.payload?.next as Record<string, unknown> | undefined;
                    const mode = event.payload?.mode === 'pivot' ? '切换新的主目标' : '调整当前主目标';
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
                          <dt>新监督注意事项</dt><dd>{lines(next?.supervisorNotes)}</dd>
                          <dt>新完成条件</dt><dd>{lines(next?.doneWhen)}</dd>
                        </dl>
                      </details>
                    );
                  })}
                </div>
              </section>}
              {activeView === 'execution' && <section className="supervisor-dialog__group">
                <div className="project-manager-dialog__section-head">
                  <div>
                    <div className="supervisor-dialog__group-title">项目 AI 当前目标规划</div>
                    <div className="supervisor-dialog__hint">这里展示项目 AI 维护的阶段成果与依赖；每个监督 AI 的具体执行路线请在对应监督通道中查看。</div>
                  </div>
                  <span className="project-manager-dialog__work-item-count">{currentSubgoals.length} 个阶段</span>
                </div>
                <div className="project-manager-dialog__work-items">
                  {currentSubgoals.length === 0 && <div className="supervisor-dialog__empty">项目 AI 尚未提交当前目标的阶段规划。</div>}
                  {currentSubgoals.map((subgoal) => {
                    const stageWorkItems = currentWorkItems.filter((item) => item.subgoalId === subgoal.id);
                    return (
                      <details key={subgoal.id} open={subgoal.status === 'active' || subgoal.status === 'blocked'}>
                        <summary><strong>S{subgoal.order} · {subgoal.title}</strong><span>{STATUS_LABELS[subgoal.status] || subgoal.status}</span></summary>
                        <dl>
                          <dt>预期成果</dt><dd>{subgoal.outcome}</dd>
                          <dt>验收依据</dt><dd>{subgoal.acceptance.join('\n')}</dd>
                          <dt>依赖阶段</dt><dd>{subgoal.dependencies.length > 0 ? subgoal.dependencies.join('、') : '无'}</dd>
                          <dt>工作项安排</dt><dd>{stageWorkItems.length > 0 ? stageWorkItems.map((item) => `${item.title}（${STATUS_LABELS[item.status] || item.status}）`).join('\n') : '尚未拆分工作项'}</dd>
                        </dl>
                      </details>
                    );
                  })}
                </div>
              </section>}
              {activeView === 'execution' && <section className="supervisor-dialog__group">
                <div className="project-manager-dialog__section-head">
                  <div>
                    <div className="supervisor-dialog__group-title">项目 AI 工作项安排</div>
                    <div className="supervisor-dialog__hint">以下工作项由项目 AI 按阶段规划拆分；选择左侧圆点可进行用户干预，已结束的工作项只保留为审计记录。</div>
                  </div>
                  <span className="project-manager-dialog__work-item-count">{currentWorkItems.length} 项</span>
                </div>
                <div className="project-manager-dialog__work-items project-manager-dialog__work-item-decisions">
                  {currentWorkItems.length === 0 && <div className="supervisor-dialog__empty">项目 AI 尚未为当前主目标拆分工作项。</div>}
                  {currentWorkItems.map((item) => {
                    const execution = item.contract.execution;
                    const decisions = session.events.filter((event) => event.workItemId === item.id);
                    const latestIntervention = [...decisions].reverse().find((event) => (
                      event.kind === 'user-work-item-intervention'
                    ));
                    const intervention = latestIntervention?.payload?.intervention;
                    const statusLabel = item.status === 'stopped' && intervention === 'skip'
                      ? '已跳过'
                      : item.status === 'stopped' && intervention === 'close'
                        ? '已关闭'
                        : STATUS_LABELS[item.status] || item.status;
                    const canIntervene = !['completed', 'stopped'].includes(session.status)
                      && !['completed', 'stopped'].includes(item.status);
                    return (
                      <details key={item.id} data-selected={workItemInterventionId === item.id ? '1' : '0'}>
                        <summary>
                          <input
                            type="radio"
                            name={`work-item-intervention-${session.id}`}
                            checked={workItemInterventionId === item.id}
                            disabled={busy || !canIntervene}
                            aria-label={`选择工作项：${item.title}`}
                            title={canIntervene ? '选择此工作项进行干预' : '该工作项已经结束'}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => {
                              setWorkItemInterventionId(item.id);
                              setWorkItemInterventionNotice('');
                            }}
                          />
                          <strong>{item.title}</strong><span>{statusLabel}</span>
                        </summary>
                        <dl>
                          <dt>执行模式</dt><dd>{taskWorkModeLabel(execution?.taskWorkMode)}{execution?.modeReason ? `：${execution.modeReason}` : ''}</dd>
                          {execution?.taskWorkMode === 'adaptive' && <><dt>自适应边界</dt><dd>最多 {execution.maxChildThreads} 个内部子线程；可并行：{execution.parallelizableOperations?.join('；')}；必须串行：{execution.serializedOperations?.join('；')}</dd></>}
                          <dt>项目基线</dt><dd>{item.baseline?.status === 'approved' ? `已审核：${item.baseline.workspaceVersion || '工作区快照已记录'}` : item.baseline?.status === 'investigating' ? '只读调查已下达，等待任务 AI 报告和监督 AI 审核' : '待任务 AI 只读调查并由监督 AI 审核；审核前禁止写入和测试'}</dd>
                          <dt>阶段预算</dt><dd>裁决 {item.decisionsUsed}/{item.contract.budget.maxDecisions}；连续窗口 {item.contract.budget.maxContinuousMinutes} 分钟；任务重试 {item.attempts}/{item.contract.budget.maxTaskRetries}</dd>
                          <dt>阶段监督注意事项</dt><dd>{item.contract.supervisorNotes?.join('\n') || '沿用项目级注意事项'}</dd>
                          <dt>执行证据</dt><dd>{item.latestEvidence || '暂无'}</dd>
                          <dt>上下文总结</dt><dd>{item.latestContextSummary || '暂无'}</dd>
                          <dt>阻塞原因</dt><dd>{item.latestBlocker || '无'}</dd>
                          <dt>决策历史</dt><dd>{decisions.length === 0 ? '暂无' : decisions.slice(-12).map((event) => `${event.kind}：${event.summary}`).join('\n')}</dd>
                        </dl>
                      </details>
                    );
                  })}
                </div>
                {selectedInterventionWorkItem && (
                  <div className="project-manager-dialog__work-item-intervention" role="group" aria-label="干预选中的工作项">
                    <div className="project-manager-dialog__work-item-intervention-head">
                      <div><strong>干预：{selectedInterventionWorkItem.title}</strong><span>只处理此工作项，不会暂停整个项目。</span></div>
                      <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => {
                        setWorkItemInterventionId('');
                        setWorkItemInterventionReason('');
                        setWorkItemInterventionNotice('');
                      }}>取消选择</button>
                    </div>
                    <div className="project-manager-dialog__work-item-actions">
                      <label data-selected={workItemIntervention === 'skip' ? '1' : '0'}>
                        <input type="radio" name="work-item-intervention-action" value="skip" checked={workItemIntervention === 'skip'} disabled={busy} onChange={() => setWorkItemIntervention('skip')} />
                        <span><strong>跳过此项</strong><small>本轮不执行，由项目 AI 自主重排或建立替代项。</small></span>
                      </label>
                      <label data-selected={workItemIntervention === 'close' ? '1' : '0'}>
                        <input type="radio" name="work-item-intervention-action" value="close" checked={workItemIntervention === 'close'} disabled={busy} onChange={() => setWorkItemIntervention('close')} />
                        <span><strong>关闭此项</strong><small>明确从当前计划移除，项目 AI 不得自行恢复或等价重建。</small></span>
                      </label>
                    </div>
                    <textarea
                      className="supervisor-dialog__textarea"
                      rows={2}
                      maxLength={1200}
                      value={workItemInterventionReason}
                      disabled={busy}
                      onChange={(event) => setWorkItemInterventionReason(event.target.value)}
                      placeholder="可选：说明跳过或关闭的理由、已知事实，供项目 AI 重排时采用"
                    />
                    <div className="project-manager-dialog__work-item-intervention-submit">
                      <span>{workItemIntervention === 'skip' ? '原工作项会停止，后续依赖交由项目 AI 评估。' : '原工作项及其专属监督/任务 AI 会停止。'}</span>
                      <button type="button" className="confirm-dialog__btn project-manager-dialog__apply-btn" disabled={busy} onClick={() => void interveneWorkItem()}>
                        {busy ? '正在提交…' : `确认${workItemIntervention === 'skip' ? '跳过' : '关闭'}`}
                      </button>
                    </div>
                  </div>
                )}
                {workItemInterventionNotice && <div className="supervisor-dialog__notice" role="status">{workItemInterventionNotice}</div>}
              </section>}
              {activeView === 'conversation' && <section className="supervisor-dialog__group project-manager-dialog__chat">
                <div className="project-manager-dialog__section-head">
                  <div>
                    <div className="supervisor-dialog__group-title">与当前项目 AI 对话</div>
                    <div className="supervisor-dialog__hint">当前项目：{session.goal}。该项目 AI 只管理这个项目；确认的新目标、范围和验收细节会写回项目配置并触发重规划。</div>
                  </div>
                  <span className="project-manager-dialog__chat-project">{session.projectDir}</span>
                </div>
                <div ref={conversationRef} className="project-manager-dialog__conversation">
                  {conversation.length === 0 && <div className="supervisor-dialog__empty">会话已建立，可直接讨论需求、确认细节、调整方向、暂停或改线。</div>}
                  {conversation.map((event) => (
                    <div
                      key={event.id}
                      className="project-manager-dialog__message"
                      data-role={event.kind === 'manager-reply' ? 'manager' : 'user'}
                      aria-label={event.kind === 'manager-reply' ? '项目 AI 回复' : '用户询问'}
                    >
                      <header>
                        <strong>{event.kind === 'manager-reply' ? '项目 AI · 回复' : '你 · 询问'}</strong>
                        <time dateTime={new Date(event.ts).toISOString()}>{new Date(event.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
                      </header>
                      <p>{event.summary}</p>
                    </div>
                  ))}
                  {waitingForManagerReply && (
                    <div className="project-manager-dialog__reply-pending" role="status">
                      <i />当前项目 AI 正在处理并将回复到此项目会话
                    </div>
                  )}
                </div>
                <div className="project-manager-dialog__composer">
                  <textarea
                    className="supervisor-dialog__textarea"
                    rows={2}
                    value={message}
                    onChange={(event) => setMessageDrafts((current) => ({ ...current, [session.id]: event.target.value }))}
                    placeholder="向当前项目补充要求、询问进度或调整优先级"
                    aria-label={`向“${session.goal}”的项目 AI 发送消息`}
                  />
                  <button type="button" className="confirm-dialog__btn project-manager-dialog__composer-send" disabled={busy || !message.trim()} onClick={() => void sendMessage()}>发送给项目 AI</button>
                </div>
              </section>}
              {activeView === 'execution' && <details className="supervisor-dialog__advanced project-manager-dialog__logs" open>
                <summary>查看当前项目 AI 处理日志（{session.events.length}）</summary>
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
              </details>}
            </>
            )
          )}
          </main>}

          {embedded && session && !creating && !awaitingRecovery && (
            <aside className="project-manager-dialog__inspector" aria-label="当前项目状态">
              <div className="project-manager-dialog__inspector-heading">
                <strong>项目状态</strong>
                <span data-status={session.status}>{projectActivityLabel(session)}</span>
              </div>
              <section className="project-manager-dialog__inspector-goal">
                <span>当前主目标 G{currentGoal?.sequence || 1}</span>
                <strong>{session.goal}</strong>
              </section>
              <dl className="project-manager-dialog__inspector-metrics">
                <div><dt>当前工作项</dt><dd>{currentWorkItems.length}</dd></div>
                <div><dt>专属监督</dt><dd>{activeManagedLanes.length}</dd></div>
                <div><dt>待决策</dt><dd>{currentWorkItems.filter((item) => item.status === 'waiting-decision').length}</dd></div>
                <div><dt>项目总数</dt><dd>{sessions.length}</dd></div>
              </dl>
              {activeAlert && (
                <button type="button" className="project-manager-dialog__inspector-alert" onClick={() => setActiveView('execution')}>
                  <span>需要处理</span>
                  <strong>{PROJECT_ALERT_LABELS[activeAlert.kind] || '项目运行告警'}</strong>
                </button>
              )}
              <div className="project-manager-dialog__inspector-actions">
                {session.status === 'active' && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void control('pause')}>暂停项目</button>}
                {(session.status === 'paused' || session.status === 'waiting') && currentGoal?.status !== 'achieved' && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => void control('resume')}>恢复项目</button>}
                {session.status === 'waiting' && currentGoal?.status === 'achieved' && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => {
                  setGoalChangeMode('pivot');
                  setActiveView('requirements');
                }}>设置下一主目标</button>}
              </div>
              <div className="project-manager-dialog__inspector-path" title={session.projectDir}>{session.projectDir}</div>
            </aside>
          )}
          </div>
        </div>

        {notice && <div className="supervisor-dialog__notice" data-kind="error" role="alert">{notice}</div>}
        <div className="supervisor-dialog__actions">
          {creating && session && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={() => { setCreating(false); setNotice(''); }}>取消添加</button>}
          {embedded && !creating && session && activeView === 'requirements' && (
            <span
              className="project-manager-dialog__definition-state project-manager-dialog__definition-state--footer"
              data-dirty={projectDefinitionDraftDirty ? '1' : '0'}
              aria-live="polite"
            >{projectDefinitionDraftDirty ? '未确认变更尚未生效' : '目标与需求已生效'}</span>
          )}
          <span className="supervisor-dialog__actions-spacer" />
          {embedded && !creating && session && activeView === 'requirements' && <>
            <button
              type="button"
              className="confirm-dialog__btn"
              disabled={busy || !projectDefinitionDraftDirty}
              onClick={discardProjectDefinitionChanges}
            >取消变更</button>
            <button
              type="button"
              className="confirm-dialog__btn project-manager-dialog__apply-btn"
              disabled={busy || !!session.pendingUserQuestion || !projectDefinitionChanged}
              title={session.pendingUserQuestion ? '请先完成当前需求确认' : undefined}
              onClick={() => void updateProjectDefinition()}
            >{busy ? '正在应用…' : '确认生效'}</button>
          </>}
          {!embedded && <button type="button" className="confirm-dialog__btn" disabled={busy} onClick={closeDialog}>{projectDefinitionDraftDirty ? '关闭（取消变更）' : '关闭'}</button>}
          {!awaitingRecovery && (creating || !session) && <button type="button" className="confirm-dialog__btn confirm-dialog__btn--danger" disabled={busy} onClick={() => void start()}>{busy ? '正在添加…' : '添加项目'}</button>}
        </div>

        {recoveryDeleteCandidate && (
          <div className="confirm-dialog__overlay project-manager-dialog__delete-confirm-overlay" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setRecoveryDeleteCandidate(null);
          }}>
            <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="确认删除历史项目记录">
              <div className="confirm-dialog__title">确认删除历史项目记录？</div>
              <div className="confirm-dialog__message project-manager-dialog__delete-confirm-message">
                <div>将永久删除“{recoveryDeleteCandidate.projectName || recoveryDeleteCandidate.goal}”的历史项目管理记录和管理日志。</div>
                <div>项目目录标识：{recoveryDeleteCandidate.projectDir}</div>
                <div>项目目录、代码和业务文件不会删除；删除后无法从此页面恢复。</div>
              </div>
              <div className="confirm-dialog__actions">
                <button
                  ref={recoveryDeleteCancelRef}
                  type="button"
                  className="confirm-dialog__btn"
                  disabled={busy}
                  onClick={() => setRecoveryDeleteCandidate(null)}
                >取消</button>
                <button
                  type="button"
                  className="confirm-dialog__btn confirm-dialog__btn--danger"
                  disabled={busy}
                  onClick={() => void deleteRecoveryCandidate(recoveryDeleteCandidate)}
                >{busy ? '正在删除…' : '确认删除'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
