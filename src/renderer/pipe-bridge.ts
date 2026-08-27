/**
 * pipe-bridge.ts — Exposes Zustand store operations as window.__wmux_* globals
 * so the main process can call them via executeJavaScript from V2 pipe handlers.
 */
import { useStore } from './store';
import projectAiAgentsSource from '../../resources/agents/project-ai/ROLE_AGENTS.md?raw';
import supervisorAiAgentsSource from '../../resources/agents/supervisor-ai/ROLE_AGENTS.md?raw';
import { splitNode, getAllPaneIds, findLeaf, buildGridLayout, createLeaf } from './store/split-utils';
import { surfaceTerminalRegistry } from './hooks/useTerminal';
import { PaneId, SurfaceId, WorkspaceId, SurfaceType, SplitNode, SurfaceRef } from '../shared/types';
import {
  DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS,
  DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS,
  DEFAULT_SUPERVISOR_WORK_SCOPE,
  type SupervisorAutonomyPermission,
  type SupervisorForbiddenAction,
  type SupervisorWorkScope,
} from '../shared/supervisor-policy';
import { v4 as uuid } from 'uuid';
import {
  isTaskTerminalInputBusyError,
  sendPermissionResponseReliably,
  sendTaskToSurface,
  sendTaskToSurfaceReliably,
  sendToSurface,
  supervisorLaneInputIsolationScope,
  SUPERVISOR_TUI_READY_DELAY_MS,
} from './supervisor/supervisor-engine';
import { hasPendingTerminalInput } from './supervisor/pending-input-guard';
import {
  markTerminalRuntimeFailed,
  markTerminalRuntimeExited,
  markTerminalRuntimeReady,
  markTerminalRuntimeStarting,
  terminalRuntimeStatus,
  waitForTerminalRuntimeReady,
} from './terminal-runtime-lifecycle';
import {
  handleSupervisorUserSubmit,
  hasPendingTaskUserSubmit,
  resumeWaitingLaneFromSupervisorInput,
} from './supervisor/user-input-precedence';
import {
  cancelPendingAutomatedTerminalSubmit,
  prepareForUserTerminalInput,
} from './utils/terminal-user-submit';
import {
  PROJECT_MANAGER_PROTOCOL_REVISION,
  PROJECT_MANAGER_RUNTIME_PATH_SUFFIX,
  PROJECT_MANAGER_TERMINAL_NAME,
  normalizeProjectManagementAgentConfig,
  projectManagerStartupInput,
  withProjectManagerEventEnvelope,
} from '../shared/project-manager-terminal';
import { roleProtocolFingerprint } from '../shared/role-protocol';
import {
  USER_RECORDS_TERMINAL_AGENT,
  USER_RECORDS_TERMINAL_DIRECTORY,
  USER_RECORDS_TERMINAL_NAME,
  USER_RECORDS_TERMINAL_STARTUP_INPUT,
} from '../shared/user-records-terminal';
import {
  SUPERVISOR_NO_DECISION_OPTION,
  supervisorDecisionOptions,
  supervisorRecommendedOptionValue,
} from '../shared/supervisor-decision-options';
import {
  compactSupervisorEvidenceSummary,
  SUPERVISOR_EVIDENCE_SUMMARY_MAX_CHARS,
} from '../shared/supervisor-evidence';
import { appendSupervisorRecord } from './supervisor/recording';
import {
  cachedSupervisorEvidencePage,
  cachedSupervisorEvidenceSnapshot,
  persistSupervisorEvidence,
  readPersistedSupervisorEvidenceFile,
  readPersistedSupervisorEvidencePage,
} from './supervisor/evidence';
import {
  clearSupervisorLaneContext,
  dedicatedSupervisorSurfaceId,
  isProjectManagedSupervisorLane,
  isSupervisorLaneBound,
  ORDINARY_SUPERVISION_PROTOCOL_VERSION,
  ORDINARY_VERIFICATION_FEASIBILITY_VALUES,
  supervisorLaneControlState,
  type OrdinaryContextHealthState,
  type GoalVortexState,
  type OrdinarySupervisorPlan,
  type OrdinaryTaskDispatch,
  type SupervisorDecision,
  type SupervisorDelivery,
  type SupervisorLane,
  type SupervisorSession,
} from './store/supervisor-slice';
import {
  buildOrdinaryContextRecoveryTask,
  nextOrdinaryContextHealthState,
  normalizeOrdinaryContextSymptoms,
  ordinaryContextClearCommand,
} from './supervisor/ordinary-context-health';
import {
  nextGoalVortexState,
  normalizeExperimentConditions,
  normalizeGoalVortexKind,
  sameGoalVortexCorrection,
} from './supervisor/goal-vortex';
import { redundantAuthoritativeGuidanceConfirmation } from './supervisor/authoritative-guidance';
import {
  buildSupervisorWakeEventEnvelope,
  buildUnacknowledgedSupervisorIdlePrompt,
  effectiveSupervisorAutonomyPermissions,
  effectiveSupervisorAutonomous,
  effectiveSupervisorForbiddenActions,
  effectiveSupervisorLaneConfig,
  effectiveSupervisorTaskGoal,
  effectiveSupervisorWorkScope,
  PROJECT_SUPERVISOR_WORKSPACE_TITLE,
  SUPERVISOR_PROTOCOL_REVISION,
  SUPERVISOR_TAB_TITLE,
  SUPERVISOR_WORKSPACE_TITLE,
  projectManagerWorkspaceTitle,
  supervisorTabTitle,
} from './supervisor/protocol';
import { buildSupervisorLaunchCommand, supervisorLaunchIsolationError } from './supervisor/launch-command';
import {
  buildSupervisorRuntimeContext,
  evaluateSupervisorDecisionPreflight,
} from './supervisor/supervisor-context';
import {
  authorizeManagedRoleV2,
  buildProjectAiRuntimeContext,
  buildTaskAiRuntimeContext,
} from './role-context';
import { buildInteractiveAgentLaunch, type InteractiveAgent } from './utils/interactive-agent-launch';
import {
  interactiveAgentInputReady,
  interactiveAgentPromptReady,
  interactiveAgentShellPromptFailureDetail,
} from './utils/interactive-agent-runtime';
import { AGENT_WORKING_TRUST_MS } from '../shared/agent-state-policy';
import {
  canStartManagedProjectRuntimeRecovery,
  managedProjectRuntimeRecoveryKey,
} from './project-manager/runtime-recovery';
import { openProjectManagerAttentionSurface } from './project-manager/console-surface';
import { fireDesktopNotification, notificationDedupeKey, notificationMetadata } from './notification-policy';
import { announceSupervisorWaitingForDirection } from './supervisor/waiting-notification';
import {
  activeProjectManagerAttentionEvent,
  activeProjectGoal,
  activeProjectSubgoals,
  CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
  MAX_PROJECT_PLAN_FILE_BYTES,
  MAX_PROJECT_PLAN_FILES,
  PROJECT_RETRY_KINDS,
  PROJECT_USER_ACCEPTANCE_POLICIES,
  PROJECT_USER_ACCEPTANCE_REQUIRED_ERROR,
  PROJECT_VERIFICATION_REQUIREMENTS,
  PROJECT_VERIFICATION_RISK_CLASSES,
  PROJECT_MANAGER_MANUAL_INTERVENTION_REASON_CODES,
  PROJECT_ORIENTATION_DISPOSITIONS,
  diffProjectProgressSnapshots,
  normalizeProjectManagerSession,
  normalizeProjectUserAcceptancePolicy,
  normalizeProjectVerificationPolicies,
  normalizeProjectCompletionResult,
  normalizeProjectExecutionBudget,
  normalizeProjectStageAcceptanceCoverage,
  normalizeProjectTaskComplexityAssessment,
  projectCompletionCriteriaError,
  projectCriterionIdentity,
  projectCriterionVerificationCannotBeRelaxed,
  projectCriterionRequiresPassingResult,
  projectCriterionRequiresRuntimeTest,
  projectFinalAcceptanceEligibilityError,
  projectFinalAcceptanceScope,
  projectGoalUserAcceptancePolicy,
  projectGoalVerificationPolicies,
  projectAuthorizationVersion,
  projectDisplayName,
  projectManagerDestructiveDecisionScopeMatches,
  projectManagerEventNeedsUserAttention,
  projectManagerGoalChangeHasUserBasis,
  projectManagerQuestionAllowsReusableDecision,
  projectManagerQuestionConfirmationScope,
  projectManagerQuestionDecisionKey,
  projectManagerQuestionSemanticFingerprint,
  projectPlanningConfirmationDigest,
  projectOrientationReady,
  projectPlanningConfirmationError,
  projectAcceptedRequirementsVersion,
  projectRequirementsAlignmentPhase,
  projectRequirementsVersion,
  projectSubgoalCompletionResult,
  projectDirectoryIdentity,
  projectTaskContextResetFingerprint,
  requiredProjectOrientation,
  type ProjectManagerQuestionOption,
  type ProjectManagerEvent,
  type ProjectManagerEventKind,
  type ProjectManagerPendingDelivery,
  type ProjectEscalationBoundary,
  type ProjectSupervisorTransition,
  type ProjectSupervisorTransitionKind,
  type ProjectProgressDiff,
  type ProjectProgressSnapshot,
  type ProjectOrientationDisposition,
  type ProjectOrientationWorkItemReview,
  type ProjectManagerSession,
  type ProjectAgentRole,
  type ProjectSafeExitTerminalCheckpoint,
  type ProjectManagerUserQuestion,
  type ProjectExecutionRecord,
  type ProjectExecutionResponsibility,
  type ProjectCompletionResult,
  type ProjectCriterionVerificationPolicy,
  type ProjectCriterionVerification,
  type ProjectEvidenceArtifact,
  type ProjectPlanFileSnapshot,
  type ProjectSubgoal,
  type ProjectSupervisorContract,
  type ProjectTaskBatch,
  type ProjectVerificationLimitation,
  type ProjectUserAcceptancePolicy,
  type ProjectRetryKind,
  type ProjectWorkItem,
} from '../shared/project-manager';
import { projectCommandNeedsExplicitId } from '../shared/project-command-scope';
import {
  supervisorCompletionEvidenceRefs,
  supervisorCompletionFileShapeError,
} from '../shared/supervisor-completion';
import {
  MAX_TASK_CHILD_THREADS,
  normalizeTaskChildThreadResponsibilities,
  normalizeTaskMaxChildThreads,
  normalizeTaskOperationBoundaries,
  normalizeTaskThreadResponsibility,
  normalizeTaskWorkMode,
  type TaskWorkMode,
} from '../shared/supervisor-work-mode';
import {
  evaluateProjectExecutionGuard,
  projectBudgetExhaustionSummary,
  projectRetryConsumesTaskBudget,
  projectRetryKindEvidenceError,
} from './project-manager/anti-loop';
import {
  buildProjectSupervisorAssignment,
  buildProjectSupervisorBriefing,
  isCurrentProjectTaskBatch,
  isProjectTargetedTestCommand,
  normalizeProjectTaskBatch,
  projectTaskImplementationDirectiveError,
  projectTaskContractDisclosureError,
  projectTaskInstructionDisclosureError,
  projectWorkItemOutcomeTitleError,
  projectContractViolation,
  projectArtifactCommandViolation,
  projectArtifactLocationViolation,
  projectRepositoryBootstrapRequired,
  projectWorkItemHistoricallyDelivered,
  projectPermissionAuthorizationError,
  projectHasRunnableGoalPlan,
  projectProgressObligation,
  projectEffectiveWorkItemPreconditions,
  renderProjectRepositoryBootstrapTask,
  renderProjectTaskBatch,
  TASK_VALIDATION_REPORTING_POLICY,
  type ProjectProgressObligation,
  projectWorkItemSubgoalDependencyError,
} from './project-manager/engine';
import {
  projectSupervisorDefaults,
  projectManagerRuntimeDefaults,
  projectTaskTerminalAgent,
  projectTaskTerminalDefaults,
  projectAuxiliaryTaskTerminalDefaults,
} from './project-manager/agent-defaults';
import { projectAuxiliaryWritablePathAllowed } from './project-manager/auxiliary-policy';
import { projectSupervisorLaneIds as scopedProjectSupervisorLaneIds } from './project-manager/lane-scope';
import { shouldRestartProjectManagerRuntime } from './project-manager/runtime-recovery-policy';
import {
  classifyProjectWatchdogScenario,
  projectWatchdogMayInterveneForRole,
} from './project-manager/watchdog-policy';
import {
  buildProjectInternalRecoveryScopeKey,
  projectGoalClosurePauseWasMisclassified,
  projectInternalRecoveryAttempts,
} from './project-manager/semantic-recovery-policy';
import { projectTransitionResolutionError as projectTransitionPolicyError } from './project-manager/transition-policy';
import { projectWorkItemCreationError } from './project-manager/work-item-admission-policy';
import {
  beginManagedAgentTurn,
  evaluateManagedAgentDeadline,
  looksLikeManagedShellPrompt,
  managedAgentDeadlinePolicy,
  noteManagedAgentCommand,
  noteManagedAgentOutput,
  noteManagedAgentSemanticProgress,
  normalizeProjectActivityFingerprintText,
  pauseManagedAgentWatchdog,
  resumeManagedAgentWatchdog,
  shiftManagedAgentDeadlineForSuspend,
  type ManagedAgentDeadlinePolicy,
  type ManagedAgentWatchdogRuntime,
  type ManagedProjectAgentRole,
} from './project-manager/liveness';

export { projectInternalRecoveryAttempts } from './project-manager/semantic-recovery-policy';
import {
  canDeliverProjectManagerMessage,
  compactProjectManagerPendingDeliveries,
  MAX_PROJECT_MANAGER_DELIVERY_RETRY_ATTEMPTS,
  nextProjectManagerDeliveryRetryAttempt,
  resetProjectManagerDeliveryAcknowledgements,
} from './project-manager/delivery-mailbox';
import {
  blockingSupervisorDecisionDeliveries,
  enqueueSupervisorDelivery,
  signalSupervisorDeliveryReady,
} from './supervisor/delivery';
import { detectSupervisorProviderLimit } from './supervisor/provider-limit';
import { isAwaitingNextPromptState } from './agent-state-semantics';
import { ordinaryTaskDeliveryBlockReason } from './supervisor/task-runtime-readiness';
import {
  activeStandingUserDecisions,
  repeatedStandingUserDecisionError,
} from './supervisor/standing-user-decision';
import {
  ordinaryWorkerWatchdogCandidate,
  ordinaryWorkerWatchdogPolicy,
} from './supervisor/ordinary-worker-watchdog';
import {
  ensureOrdinarySupervisorStatusSurface,
  removeOrdinarySupervisorStatusSurfaceForTask,
} from './supervisor/status-surface';

type ManagedRoleProtocol = 'project-ai' | 'supervisor-ai';

interface ManagedRoleProtocolReadyState {
  role: ManagedRoleProtocol;
  protocolRevision: string;
  protocolFingerprint: string;
  confirmedAt: number;
}

const managedRoleProtocolReady = new Map<string, ManagedRoleProtocolReadyState>();
const PROJECT_AI_PROTOCOL_FINGERPRINT = roleProtocolFingerprint(projectAiAgentsSource);
const SUPERVISOR_AI_PROTOCOL_FINGERPRINT = roleProtocolFingerprint(supervisorAiAgentsSource);

export function isSupervisorDecisionAuthorised(
  lane: Pick<SupervisorLane, 'surfaceId' | 'supervisorSurfaceId'>,
  supervisorSurfaceId: string,
): boolean {
  return !!supervisorSurfaceId && dedicatedSupervisorSurfaceId(lane) === supervisorSurfaceId;
}

function projectSupervisorRuntimeDecisionBoundary(
  lanes: readonly SupervisorLane[],
  taskSurfaceId: string,
  supervisorSurfaceId: string,
): Record<string, unknown> | null {
  if (!taskSurfaceId || !supervisorSurfaceId) return null;
  const candidate = lanes.find((lane) => (
    lane.surfaceId === taskSurfaceId
    && lane.projectRuntimeHandover?.state === 'candidate'
  ));
  if (candidate) {
    const replaced = lanes.find((lane) => lane.id === candidate.projectRuntimeHandover?.replacesLaneId);
    if (candidate.supervisorSurfaceId === supervisorSurfaceId
      || replaced?.supervisorSurfaceId === supervisorSurfaceId) {
      return {
        ok: false,
        code: 'lane-replacing',
        retryable: true,
        error: '项目专属监督运行时正在进行两阶段切换；本回合请结束并等待新运行时接管，禁止立即重试或重复提交裁决',
      };
    }
  }
  const now = Date.now();
  for (const [surfaceId, retired] of retiredProjectSupervisorRuntimes) {
    if (now - retired.retiredAt > PROJECT_SUPERVISOR_RETIRED_RUNTIME_TTL_MS) {
      retiredProjectSupervisorRuntimes.delete(surfaceId);
    }
  }
  const retired = retiredProjectSupervisorRuntimes.get(supervisorSurfaceId);
  if (retired?.taskSurfaceId === taskSurfaceId) {
    return {
      ok: false,
      code: 'stale-supervisor-generation',
      retryable: false,
      generation: retired.generation,
      error: '该裁决来自已经退役的监督运行时 generation；控制层已保留新 lane，本次迟到裁决未生效',
    };
  }
  return null;
}

export function shouldDeferProjectEscalationWhileTaskRuns(input: {
  projectManaged: boolean;
  outcome: string;
  escalationBoundary?: ProjectEscalationBoundary;
  taskState?: string;
}): boolean {
  return input.projectManaged
    && input.outcome === 'needs-human'
    && input.escalationBoundary === 'external-blocker'
    && input.taskState === 'working';
}

export function isTransientRunningTaskApproval(input: {
  text?: string;
  reason?: string;
  impact?: string;
}): boolean {
  const text = [input.text, input.reason, input.impact].filter(Boolean).join('\n');
  return /(?:任务(?:终端|\s*AI).{0,40}(?:仍在|正在).{0,20}(?:执行|运行)|(?:仍在|正在).{0,20}(?:执行|运行).{0,40}任务(?:终端|\s*AI)|可裁决检查点|向运行终端注入|等待.{0,30}(?:任务|终端).{0,20}(?:结束|完成))/iu.test(text);
}

const FEISHU_TERMINAL_SCREEN_MAX_CHARS = 1_500;
const FEISHU_TERMINAL_SCREEN_MAX_LINES = 18;
const FEISHU_TERMINAL_QUESTION_MAX_CHARS = 1_000;
const FEISHU_TERMINAL_ANSWER_MAX_CHARS = 4_000;

function sanitizeTerminalTextLine(line: string): string {
  return Array.from(line, (character) => {
    const codePoint = character.codePointAt(0) || 0;
    const isControl = codePoint <= 0x08
      || (codePoint >= 0x0b && codePoint <= 0x0c)
      || (codePoint >= 0x0e && codePoint <= 0x1f)
      || (codePoint >= 0x7f && codePoint <= 0x9f);
    const isTerminalGlyph = (codePoint >= 0x2580 && codePoint <= 0x259f)
      || (codePoint >= 0x25a0 && codePoint <= 0x25a3)
      || codePoint === 0x25ae
      || codePoint === 0x25af
      || codePoint === 0xfffc
      || codePoint === 0xfffd
      || (codePoint >= 0xe000 && codePoint <= 0xf8ff);
    return isControl || isTerminalGlyph ? ' ' : character;
  }).join('');
}

export interface TerminalScreenReadResult {
  text?: string;
  lines?: number;
  surfaceId?: string;
  bufferType?: 'normal' | 'alternate';
  bufferLines?: number;
  truncated?: boolean;
  error?: string;
}

export function readTerminalScreen(surfaceId: string, lines = 50): TerminalScreenReadResult {
  const terminal = surfaceTerminalRegistry.get(surfaceId);
  if (!terminal) {
    return { error: `no terminal for surface ${surfaceId} (markdown/browser pane, another window, or closed)` };
  }
  const buffer = terminal.buffer.active;
  const count = Math.min(Math.max(Math.floor(lines), 1), 10000);
  const output: string[] = [];
  // Alternate-screen TUIs use the entire viewport as one repaint frame. Taking
  // only its bottom N rows drops the conversation at the top and keeps mostly
  // the composer/footer (notably in Grok). Normal shells still use the newest
  // requested scrollback rows.
  const start = buffer.type === 'alternate' ? 0 : Math.max(0, buffer.length - count);
  for (let i = start; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    const text = line?.translateToString(true) ?? '';
    if (line?.isWrapped && output.length > 0) output[output.length - 1] += text;
    else output.push(text);
  }
  while (output.length && output[output.length - 1] === '') output.pop();
  return {
    text: output.join('\n'),
    lines: output.length,
    surfaceId,
    bufferType: buffer.type,
    bufferLines: buffer.length,
    truncated: buffer.type === 'alternate' || start > 0,
  };
}

function isTerminalTuiChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[\s\u2500-\u259f_=~-]+$/u.test(trimmed)) return true;
  if (/^[\s│┃╎╏┆┇┊┋`'|\\]*[>❯›〉][\s│┃╎╏┆┇┊┋`'|\\]*$/u.test(trimmed)) return true;
  if (/^[\s│┃╎╏┆┇┊┋`'|\\]+$/u.test(trimmed)) return true;
  if (/\bShift\+Tab\s*:\s*mode\b/i.test(trimmed)
    && /\b(?:Esc\s*:\s*cancel|Ctrl\+X\s*:\s*shortcuts)\b/i.test(trimmed)) return true;
  if (/\bCtrl\+E\s*:\s*expand thinking\b/i.test(trimmed)
    && /\b(?:Space\s*:\s*prompt|Ctrl\+X\s*:\s*shortcuts)\b/i.test(trimmed)) return true;
  if (/\bGrok\s+\d+(?:\.\d+)+(?:\s*\([^)]*\))?.*\b(?:always|auto)[- ]approve\b/i.test(trimmed)) return true;
  return false;
}

export function terminalScreenExcerpt(text: string, maxChars = FEISHU_TERMINAL_SCREEN_MAX_CHARS): string {
  const normalizedLines = text.replace(/\r\n?/g, '\n').split('\n').map(sanitizeTerminalTextLine);
  const compacted: string[] = [];
  for (const line of normalizedLines) {
    if (isTerminalTuiChromeLine(line)) continue;
    if (!line.trim()) {
      if (compacted.length > 0 && compacted[compacted.length - 1] !== '') compacted.push('');
      continue;
    }
    if (line === compacted[compacted.length - 1]) continue;
    compacted.push(line);
  }
  while (compacted[compacted.length - 1] === '') compacted.pop();

  // Full-screen TUIs can leave two or more identical repaint frames in the
  // scrollback. Keep only the newest repeated suffix frame.
  for (let size = Math.floor(compacted.length / 2); size >= 3; size--) {
    const latest = compacted.slice(-size);
    const previous = compacted.slice(-(size * 2), -size);
    if (latest.every((line, index) => line === previous[index])) {
      compacted.splice(-(size * 2), size);
      break;
    }
  }

  const limitedLines = compacted.slice(-FEISHU_TERMINAL_SCREEN_MAX_LINES);
  let normalized = limitedLines.join('\n');
  if (compacted.length > limitedLines.length) normalized = `…\n${normalized}`;
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 1) return '…'.slice(0, maxChars);
  return `…\n${normalized.slice(-(maxChars - 2))}`;
}

export interface TerminalConversationExcerpt {
  question?: string;
  answer?: string;
  answerPending?: boolean;
  text: string;
}

type TerminalConversationAgent = 'codex' | 'kimi' | 'grok' | 'pi' | 'opencode' | 'generic';

function terminalConversationAgent(label: string, text: string): TerminalConversationAgent {
  const normalized = label.toLowerCase();
  if (/\bopencode\b/iu.test(normalized)) return 'opencode';
  if (/\bpi(?:\s+agent)?\b/iu.test(normalized)) return 'pi';
  if (normalized.includes('grok')) return 'grok';
  if (normalized.includes('kimi')) return 'kimi';
  if (normalized.includes('codex')) return 'codex';
  if (/\bHelp improve Grok\b/iu.test(text)
    || (/^\s*[◆◇◈◊]\s*user_prompt_submit\b/imu.test(text)
      && /(?:Thought for\b|Worked for\b)/iu.test(text))
    || (/\bWorked for\s+\d/iu.test(text) && /\bstop\s+\[hooks:/iu.test(text))) return 'grok';
  if (/^\s*[✦✧✨]\s+\S/mu.test(text)
    && /(?:^|\n)\s*(?:auto\b.*\bK\d|yolo\b|\/compact\b|context:\s*\d|K\d+-\d+k\b)/iu.test(text)) return 'kimi';
  if (/\(kimi-coding\).*\bkimi-for-coding\b/iu.test(text)) return 'kimi';
  if (/\bOpenAI Codex\b/iu.test(text)
    || (/^\s*[>❯›]\s+\S/mu.test(text) && /(?:^|\n)\s*gpt-[\w.-]+\b/iu.test(text))) return 'codex';
  if (/\bOpenCode\b/iu.test(text)) return 'opencode';
  if (/\bPi Agent\b/iu.test(text)
    || /(?:^|\n)\s*pi\s+v\d[\w.-]*[\s\S]{0,500}(?:ctrl\+c\/ctrl\+d clear\/exit|\/ commands)/iu.test(text)) return 'pi';
  return 'generic';
}

const REMOTE_TERMINAL_AGENT_LABELS: Record<Exclude<TerminalConversationAgent, 'generic'>, string> = {
  codex: 'Codex',
  kimi: 'Kimi',
  grok: 'Grok',
  pi: 'Pi',
  opencode: 'OpenCode',
};

function remoteTerminalLabel(surface: SurfaceRef): string {
  const customTitle = surface.customTitle?.trim();
  if (customTitle) return customTitle;

  const agentLabel = useStore.getState().agentMeta.get(surface.id)?.label?.trim();
  if (agentLabel) return agentLabel;

  const screen = readTerminalScreen(surface.id, 40).text || '';
  const agent = terminalConversationAgent(surface.shell || '', screen);
  if (agent !== 'generic') return REMOTE_TERMINAL_AGENT_LABELS[agent];

  return surface.shell || 'terminal';
}

function isCodexComposerSuggestion(question: string): boolean {
  return /^Ask Codex\b/iu.test(question)
    || /^(?:Find and fix a bug in|Improve documentation in)\s+@filename$/iu.test(question)
    || /^Run \/review on my current changes$/iu.test(question)
    || /^Implement\s+\{[^{}]+\}$/u.test(question);
}

function isGrokComposerSuggestion(question: string): boolean {
  return /^(?:Build anything|Ask Grok\b.*)$/iu.test(question);
}

function lastMatchingLineIndex(lines: string[], pattern: RegExp): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (pattern.test(lines[index].trim())) return index;
  }
  return -1;
}

function grokQuestionSearchEnd(lines: string[]): number {
  const submittedIndex = lastMatchingLineIndex(lines, /^[◆◇◈◊]\s*user_prompt_submit\b/iu);
  if (submittedIndex >= 0) return submittedIndex;
  const completionIndex = lastMatchingLineIndex(lines, /^(?:Worked for\b|stop\s+\[hooks:)/iu);
  if (completionIndex >= 0) return completionIndex;
  const respondingIndex = lastMatchingLineIndex(lines, /^(?:[∷⋮:]\s*)?Responding\b/iu);
  return respondingIndex >= 0 ? respondingIndex : lines.length;
}

function terminalQuestionText(line: string, agent: TerminalConversationAgent): string | null {
  const trimmed = line.trim();
  const match = agent === 'kimi'
    ? /^[✦✧✨]\s*(.+)$/u.exec(trimmed)
    : /^(?:[│┃]\s*)?[>❯›〉]\s+(.+)$/u.exec(trimmed);
  if (!match?.[1]) return null;
  const question = match[1].replace(/\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*$/iu, '').trim();
  if (!question || (agent === 'kimi' && /^Use Kimi\b/iu.test(question))) return null;
  if (/^[\s│┃╎╏┆┇┊┋`'|\\]+$/u.test(question) || isTerminalTuiChromeLine(question)) return null;
  if (agent === 'codex' && isCodexComposerSuggestion(question)) return null;
  if (agent === 'grok' && isGrokComposerSuggestion(question)) return null;
  return question;
}

function isKimiRuntimeFooter(line: string): boolean {
  const trimmed = line.trim();
  return /^(?:(?:auto|yolo)\b.*\bK\d|\/compact\b|context:\s*\d|K\d+-\d+k\b)/iu.test(trimmed)
    || /\bK\d(?:\.\d+)?\s+Coding\s+thinking\b.*\bcontext:\s*\d/iu.test(trimmed)
    || /\(kimi-coding\).*\bkimi-for-coding\b/iu.test(trimmed);
}

function isTerminalConversationFooter(line: string, agent: TerminalConversationAgent): boolean {
  const trimmed = line.trim();
  if (agent === 'grok' && /^(?:Help improve Grok|Off by default\.|Change anytime via settings\.|Read Terms and Privacy Policy\.)/iu.test(trimmed)) return true;
  if (agent === 'kimi' && isKimiRuntimeFooter(line)) return true;
  if (agent === 'codex' && /^(?:gpt-[\w.-]+\b|model:|directory:|permissions:|Tip:|MCP startup interrupted)/iu.test(trimmed)) return true;
  return false;
}

function isTerminalConversationNoise(line: string, agent: TerminalConversationAgent): boolean {
  const trimmed = line.trim();
  if (!trimmed || isTerminalTuiChromeLine(line)) return true;
  if (/^\d{1,2}:\d{2}\s*(?:AM|PM)$/iu.test(trimmed)) return true;
  if (/^[◆◇]\s*(?:user_prompt_submit|Thought\b)/iu.test(trimmed)) return true;
  if (/^(?:Worked for\b|stop\s+\[hooks:)/iu.test(trimmed)) return true;
  if (agent === 'grok' && /^(?:[∷⋮:]\s*)?Responding\b.*$/iu.test(trimmed)) return true;
  if (agent === 'grok' && /^\d+(?:\.\d+)?s\s+.*\[stop\]\s*$/iu.test(trimmed)) return true;
  if (agent === 'grok' && /^(?:\[Opt out\]|\[Opt in\])/iu.test(trimmed)) return true;
  if (agent === 'kimi' && /^(?:Run \/model\b|No session yet\b)/iu.test(trimmed)) return true;
  return false;
}

function limitConversationText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const headLength = Math.floor((maxChars - 3) * 0.6);
  return `${value.slice(0, headLength)}\n…\n${value.slice(-(maxChars - headLength - 3))}`;
}

function isCodexActivityBlock(value: string): boolean {
  return /^(?:Ran|Running|Read|Explored|Searched?|Searching|Working|Called|Viewed|Edited|Updated|Added|Deleted|Reconnecting)\b/iu.test(value)
    || /^You have\s+\d+/iu.test(value);
}

function codexFinalAnswer(lines: string[]): string {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^\s*[>❯›]\s+/u.test(line)) {
      current = null;
      continue;
    }
    const bullet = /^\s*[•●]\s+(.+)$/u.exec(line);
    if (bullet) {
      current = [bullet[1].trimEnd()];
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\s*[└╰]/u.test(line) || isTerminalTuiChromeLine(line)) continue;
    current.push(line.trimEnd());
  }
  const candidate = [...blocks].reverse().find((block) => !isCodexActivityBlock(block[0] || ''));
  if (!candidate) return '';
  while (candidate[candidate.length - 1] === '') candidate.pop();
  return candidate.join('\n').trim();
}

function isSupervisorCoreActivity(value: string): boolean {
  const normalized = value.replace(/^\s*[•●◆◇◈◊◦]\s*/u, '').trim();
  return isCodexActivityBlock(normalized)
    || /^(?:Bash|Read|Edit|Write|Glob|Grep|Search|Task|WebFetch|WebSearch|TodoWrite)\s*\(/iu.test(normalized)
    || /^(?:Thought\b|Responding\b|Worked for\b|stop\s+\[hooks:)/iu.test(normalized)
    || /^(?:\+|…\s*\+?)\d+\s+lines?\b/iu.test(normalized)
    || /^\$\s+\S/u.test(normalized)
    || /^(?:PS\s+[A-Za-z]:[\\/][^>]*>|[A-Za-z]:[\\/][^>]*>)\s*\S*/iu.test(normalized)
    || /^(?:\(no output\)|Took\s+\d+(?:\.\d+)?s|(?:已|被)?成功提交[。.]*?)$/iu.test(normalized);
}

function isSupervisorCoreChrome(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed
    || isTerminalTuiChromeLine(value)
    || /^\s*(?:[>❯›〉]|[✦✧✨])\s+\S/u.test(value)
    || /^\s*[└╰⎿]\s*/u.test(value)
    || /^(?:gpt-[\w.-]+\b|model:|directory:|permissions:|Tip:|MCP startup interrupted)/iu.test(trimmed)
    || isKimiRuntimeFooter(value)
    || /^[A-Za-z]:[\\/][^\r\n]*$/u.test(trimmed)
    || /\bR\d+(?:\.\d+)?k?\b.*\bCH\d+(?:\.\d+)?%/iu.test(trimmed)
    || /^(?:Help improve Grok|Off by default\.|Change anytime via settings\.|Read Terms and Privacy Policy\.)/iu.test(trimmed)
    || /^\d+(?:\.\d+)?s\s+.*\[stop\]\s*$/iu.test(trimmed)
    || /^(?:\[Opt out\]|\[Opt in\])/iu.test(trimmed);
}

function supervisorVisibleCoreInformation(lines: string[]): string {
  const candidates: string[][] = [];
  let current: string[] | null = null;
  let skippingActivity = false;
  const finishCurrent = (): void => {
    if (!current) return;
    while (current[current.length - 1] === '') current.pop();
    if (current.some((line) => /[\p{L}\p{N}]/u.test(line))) candidates.push(current);
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current && current[current.length - 1] !== '') current.push('');
      skippingActivity = false;
      continue;
    }
    if (isSupervisorCoreActivity(line)) {
      finishCurrent();
      skippingActivity = true;
      continue;
    }
    if (isSupervisorCoreChrome(line)) {
      finishCurrent();
      continue;
    }

    const bullet = /^\s*[•●]\s+(.+)$/u.exec(line);
    if (bullet?.[1]) {
      finishCurrent();
      skippingActivity = false;
      current = [bullet[1].trimEnd()];
      continue;
    }
    if (skippingActivity) continue;
    if (!current) current = [];
    current.push(line.trimEnd());
  }
  finishCurrent();

  const candidate = candidates[candidates.length - 1];
  return candidate ? candidate.join('\n').trim() : '';
}

function kimiVisibleCoreInformation(lines: string[]): string {
  const footerIndex = lines.findIndex(isKimiRuntimeFooter);
  let visibleLines = footerIndex >= 0 ? lines.slice(0, footerIndex) : lines;
  const finalAnswerStart = visibleLines.reduce((latest, line, index) => (
    /^\s*●\s+\S/u.test(line) ? index : latest
  ), -1);
  if (finalAnswerStart >= 0) visibleLines = visibleLines.slice(finalAnswerStart);

  const candidates: string[][] = [];
  let current: string[] = [];
  let skippingActivity = false;
  const finishCurrent = (): void => {
    while (current[current.length - 1] === '') current.pop();
    if (current.some((line) => /[\p{L}\p{N}]/u.test(line))) candidates.push(current);
    current = [];
  };

  for (const line of visibleLines) {
    if (!line.trim()) {
      if (current.length > 0 && current[current.length - 1] !== '') current.push('');
      skippingActivity = false;
      continue;
    }
    if (isSupervisorCoreActivity(line)) {
      finishCurrent();
      skippingActivity = true;
      continue;
    }
    const isTableBorder = /^[\s\u2500-\u257f]*[┌┐└┘├┤┬┴┼╭╮╰╯][\s\u2500-\u257f]*$/u.test(line);
    if (!isTableBorder && isSupervisorCoreChrome(line)) {
      finishCurrent();
      skippingActivity = false;
      continue;
    }
    if (skippingActivity || (!isTableBorder && isTerminalConversationNoise(line, 'kimi'))) continue;
    current.push(line.trimEnd());
  }
  finishCurrent();

  const candidate = candidates[candidates.length - 1];
  if (!candidate) return '';
  candidate[0] = candidate[0].replace(
    candidate.length === 1 ? /^\s*[●•]\s+/u : /^\s*●\s+/u,
    '',
  );
  return candidate.join('\n').trim();
}

/** Preserve useful supervisor prose when a long-running TUI has scrolled its original prompt away. */
export function terminalSupervisorCoreExcerpt(
  text: string,
  terminalLabel: string,
  activityState: RemoteTerminalActivityState = 'unknown',
): TerminalConversationExcerpt {
  const conversation = terminalConversationExcerpt(text, terminalLabel, activityState);
  if (conversation.answer) return conversation;

  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(sanitizeTerminalTextLine);
  const agent = terminalConversationAgent(terminalLabel, text);
  const coreInformation = agent === 'codex'
    ? codexFinalAnswer(lines) || supervisorVisibleCoreInformation(lines)
    : agent === 'kimi'
      ? kimiVisibleCoreInformation(lines)
      : supervisorVisibleCoreInformation(lines);
  return {
    ...(coreInformation ? { answer: limitConversationText(coreInformation, FEISHU_TERMINAL_ANSWER_MAX_CHARS) } : {}),
    ...(activityState === 'working' ? { answerPending: true } : {}),
    text: conversation.text,
  };
}

function codexConversationQuestion(
  lines: string[],
  activityState: RemoteTerminalActivityState,
): { index: number; question: string } | null {
  const rawPromptIndexes = lines.flatMap((line, index) => (
    /^\s*[>❯›〉]\s+\S/u.test(line) ? [index] : []
  ));
  const candidates = rawPromptIndexes.flatMap((index) => {
    const question = terminalQuestionText(lines[index], 'codex');
    return question ? [{ index, question }] : [];
  });
  for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex--) {
    const candidate = candidates[candidateIndex];
    const nextPromptIndex = rawPromptIndexes.find((index) => index > candidate.index) ?? lines.length;
    const turnLines = lines.slice(candidate.index + 1, nextPromptIndex);
    const bulletTexts = turnLines.flatMap((line) => {
      const bullet = /^\s*[•●]\s+(.+)$/u.exec(line);
      return bullet?.[1] ? [bullet[1]] : [];
    });
    const hasPendingActivity = bulletTexts.some((bullet) => /^Working\b/iu.test(bullet))
      || (activityState === 'working' && bulletTexts.some(isCodexActivityBlock));
    if (hasPendingActivity || codexFinalAnswer(turnLines)) return candidate;
  }
  return candidates[0] || null;
}

/** Extract the newest submitted user prompt and final agent response from supported AI TUIs. */
export function terminalConversationExcerpt(
  text: string,
  terminalLabel: string,
  activityState: RemoteTerminalActivityState = 'unknown',
): TerminalConversationExcerpt {
  const fallback = terminalScreenExcerpt(text);
  const agent = terminalConversationAgent(terminalLabel, text);
  if (agent === 'generic') return { text: fallback };
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(sanitizeTerminalTextLine);
  let questionIndex = -1;
  let question = '';
  if (agent === 'codex') {
    const candidate = codexConversationQuestion(lines, activityState);
    if (candidate) {
      questionIndex = candidate.index;
      question = candidate.question;
    }
  } else {
    const questionSearchEnd = agent === 'grok' ? grokQuestionSearchEnd(lines) : lines.length;
    for (let index = 0; index < questionSearchEnd; index++) {
      const candidate = terminalQuestionText(lines[index], agent);
      if (!candidate) continue;
      questionIndex = index;
      question = candidate;
    }
  }
  if (questionIndex < 0) return { text: fallback };

  let answerLines = lines.slice(questionIndex + 1);
  const footerIndex = answerLines.findIndex((line) => isTerminalConversationFooter(line, agent));
  if (footerIndex >= 0) answerLines = answerLines.slice(0, footerIndex);
  if (agent === 'codex') {
    const latestBullet = [...answerLines].reverse().map((line) => /^\s*[•●]\s+(.+)$/u.exec(line)?.[1] || '').find(Boolean) || '';
    const answerPending = activityState === 'working'
      || /^Working\b/iu.test(latestBullet);
    const answer = codexFinalAnswer(answerLines);
    return {
      question: limitConversationText(question, FEISHU_TERMINAL_QUESTION_MAX_CHARS),
      ...(answer ? { answer: limitConversationText(answer, FEISHU_TERMINAL_ANSWER_MAX_CHARS) } : {}),
      ...(answerPending ? { answerPending: true } : {}),
      text: fallback,
    };
  }
  if (agent === 'grok') {
    const completionIndex = answerLines.findIndex((line) => /^(?:Worked for\b|stop\s+\[hooks:)/iu.test(line.trim()));
    if (completionIndex >= 0) answerLines = answerLines.slice(0, completionIndex);
    const respondingIndex = answerLines.findIndex((line) => /^(?:[∷⋮:]\s*)?Responding\b/iu.test(line.trim()));
    if (respondingIndex >= 0) answerLines = answerLines.slice(0, respondingIndex);
    const latestActivity = answerLines.reduce((latest, line, index) => (
      /^\s*[◆◇◈◊]\s*\S/u.test(line) ? index : latest
    ), -1);
    if (latestActivity >= 0) answerLines = answerLines.slice(latestActivity + 1);
  }
  if (agent === 'kimi') {
    const answerStart = answerLines.reduce((latest, line, index) => /^\s*●\s+\S/u.test(line) ? index : latest, -1);
    answerLines = answerStart >= 0 ? answerLines.slice(answerStart) : [];
  }
  const cleanedAnswerLines: string[] = [];
  for (const line of answerLines) {
    if (!line.trim()) {
      if (cleanedAnswerLines.length > 0 && cleanedAnswerLines[cleanedAnswerLines.length - 1] !== '') cleanedAnswerLines.push('');
      continue;
    }
    if (isTerminalConversationNoise(line, agent)) continue;
    cleanedAnswerLines.push(line.trimEnd());
  }
  while (cleanedAnswerLines[cleanedAnswerLines.length - 1] === '') cleanedAnswerLines.pop();
  if (agent === 'kimi' && cleanedAnswerLines.length > 0) {
    cleanedAnswerLines[0] = cleanedAnswerLines[0].replace(/^\s*[●•]\s+/u, '');
  }
  const answer = cleanedAnswerLines.join('\n').trim();
  const answerPending = activityState === 'working';
  return {
    question: limitConversationText(question, FEISHU_TERMINAL_QUESTION_MAX_CHARS),
    ...(answer ? { answer: limitConversationText(answer, FEISHU_TERMINAL_ANSWER_MAX_CHARS) } : {}),
    ...(answerPending ? { answerPending: true } : {}),
    text: fallback,
  };
}

export function isRemoteSshControlledLane(
  lane: Pick<SupervisorLane, 'remoteSshControl' | 'workspaceId'>,
  workspaces: ReadonlyArray<{ id: WorkspaceId; sshProfileId?: string }>,
): boolean {
  if (lane.remoteSshControl) return true;
  return !!lane.workspaceId
    && !!workspaces.find((workspace) => workspace.id === lane.workspaceId)?.sshProfileId;
}

/** Small reversible adjustments are autonomous; material proposals remain human-gated. */
export function isSupervisorProposalAllowed(outcome: string, proposalKind: string): boolean {
  if (!proposalKind) return true;
  if (proposalKind === 'route-adjustment') return outcome === 'continue' || outcome === 'rework';
  return (proposalKind === 'route-change'
    || proposalKind === 'important'
    || proposalKind === 'context-recovery'
    || proposalKind === 'direction-needed'
    || proposalKind === 'clarification') && outcome === 'needs-human';
}

const TERMINAL_BOOTSTRAP_CONTEXT_MAX_CHARS = 20_000;
const TERMINAL_BOOTSTRAP_CONTEXT_MAX_LINES = 240;

/** Bounded, prompt-ready evidence from an existing Agent terminal. */
export function terminalBootstrapContext(
  text: string,
  terminalLabel: string,
  activityState: RemoteTerminalActivityState = 'unknown',
): string {
  const core = terminalSupervisorCoreExcerpt(text, terminalLabel, activityState);
  const compacted: string[] = [];
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = sanitizeTerminalTextLine(rawLine).trimEnd();
    if (isTerminalTuiChromeLine(line)) continue;
    if (!line.trim()) {
      if (compacted.length > 0 && compacted[compacted.length - 1] !== '') compacted.push('');
      continue;
    }
    if (line === compacted[compacted.length - 1]) continue;
    compacted.push(line);
  }
  while (compacted[compacted.length - 1] === '') compacted.pop();
  const recent = compacted.slice(-TERMINAL_BOOTSTRAP_CONTEXT_MAX_LINES).join('\n').trim();
  const evidence = limitConversationText(recent, TERMINAL_BOOTSTRAP_CONTEXT_MAX_CHARS);
  return [
    `来源终端：${terminalLabel || 'terminal'}`,
    `终端活动状态：${activityState}`,
    core.question ? `最近用户请求：\n${core.question}` : '',
    core.answer ? `最近 Agent 结论：\n${core.answer}` : '',
    core.answerPending ? '最近一轮 Agent 仍可能在处理中。' : '',
    evidence ? `最近对话与操作证据：\n${evidence}` : '未读取到可用的终端对话。',
  ].filter(Boolean).join('\n\n');
}

/** Extract the batch of material-alignment questions from an ordinary supervisor proposal. */
export function ordinaryClarificationQuestions(value: string): string[] {
  return (value.match(/[^?？\r\n]{3,}[?？]/gu) || [])
    .map((question) => question.trim())
    .filter(Boolean);
}

/** A supervisor may advance work only from a continuation/rework or a human proposal. */
export function isSupervisorNextAllowed(
  outcome: string,
  next: string,
): boolean {
  return !next || outcome === 'continue' || outcome === 'rework' || outcome === 'needs-human';
}

const AUTONOMOUS_BLOCKED_ACTIONS: Array<[RegExp, string]> = [
  [/(?:^|[\s;&|("'`])(?:rm|rmdir|del|erase|rd|ri|remove-item|clear-content|set-content|out-file)\b|删除(?:.{0,8}(?:文件|目录)|\s+(?:[a-zA-Z]:|\\\\|\/|\.\.?[\\/]|[^\s]+\.[a-z0-9]{1,12}))|(?:覆盖|覆写)(?:.{0,8}(?:文件|数据)|\s+(?:[a-zA-Z]:|\\\\|\/|\.\.?[\\/]|[^\s]+\.[a-z0-9]{1,12}))/i, '删除或覆盖文件'],
  [/\bgit\b[^;；&|\r\n]{0,200}\b(?:push|reset\s+--hard|clean|remote\s+(?:add|remove|set-url))\b/i, '推送或重写 Git 历史'],
  [/\b(?:npm|pnpm|yarn|bun|cargo|twine)\s+(?:publish|release)\b/i, '发布软件包'],
  [/\bgh\s+(?:pr\s+(?:create|merge|close)|release\s+create)\b/i, '对外提交或发布'],
  [/\b(?:curl|invoke-restmethod|invoke-webrequest|irm|iwr)\b[^\r\n]{0,300}(?:-x|--request|-method)\s*(?:delete|post|put|patch)\b/i, '外部写操作'],
  [/\b(?:deploy|release|publish)\b|部署|发布|对外提交/i, '部署、发布或对外提交'],
  [/\b(?:kubectl|helm|terraform|pulumi|aws|az|gcloud)\b/i, '云端或生产环境操作'],
  [/\b(?:production|prod)\b|生产环境|线上环境/i, '生产环境操作'],
  [/(?:\b(?:read|show|print|export|write|modify|change|update|delete|rotate|reset)\b|读取|显示|打印|导出|写入|修改|更改|更新|删除|轮换|重置).{0,24}(?:\b(?:credential|secret|token|password|api[ _-]?key)\b|凭据|密钥|令牌|密码)|(?:\b(?:credential|secret|token|password|api[ _-]?key)\b|凭据|密钥|令牌|密码).{0,24}(?:\b(?:value|content|change|update|delete|rotate|reset)\b|值|内容|变更|更新|删除|轮换|重置)/i, '凭据或权限变更'],
  [/(?:^|\s)(?:sudo|runas)\b|\bstart-process\b[^\n]*\s-verb\s+runas\b|\b(?:set-executionpolicy|takeown|icacls|set-acl|new-localuser|add-localgroupmember)\b|管理员权限|系统权限/i, '管理员权限或系统权限变更'],
];

/** Returns why an AI-proposed action must remain a human decision. */
export function autonomousActionBlockReason(action: string): string | null {
  const text = action.trim();
  if (!text) return null;
  for (const [pattern, reason] of AUTONOMOUS_BLOCKED_ACTIONS) {
    const matches = text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
    for (const match of matches) {
      const actionOffset = Math.max(0, match[0].search(/[a-zA-Z\u3400-\u9fff]/u));
      if (!isNegatedMatch(text, (match.index ?? 0) + actionOffset)) return reason;
    }
  }
  return null;
}

const REMOTE_SSH_HUMAN_ACTIONS: Array<[RegExp, string]> = [
  [
    /(?:^|[\s;&|])(?:unlink|shred)\b|\bfind\b[^\r\n]{0,240}\s-delete\b|\brsync\b[^\r\n]{0,240}\s--delete\b|\btruncate\b[^\r\n]{0,120}\s-s\s*0\b|\bgit\b[^\r\n]{0,160}\brestore\b|\bgit\b[^\r\n]{0,160}\bcheckout\s+--(?:\s|$)|\b(?:cp|mv)\b[^\r\n]{0,160}\s-f\b|\b(?:move-item|copy-item)\b[^\r\n]{0,160}\s-force\b|清理.{0,20}(?:文件|目录|日志|缓存|数据)/i,
    '删除或破坏性覆盖远程文件',
  ],
  [
    /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade|remove|uninstall)\b|\b(?:pip|pip3|uv)\s+(?:install|uninstall|sync|add|remove|upgrade)\b|\bcargo\s+(?:install|uninstall|add|remove|update)\b|\bgo\s+(?:get|install)\b|\bdotnet\s+(?:add|remove)(?:\s+\S+)?\s+package\b|\b(?:apt(?:-get)?|yum|dnf|pacman|zypper|apk|brew|choco|winget|scoop)\s+(?:install|remove|uninstall|update|upgrade|add)\b|(?:安装|卸载|升级|更新).{0,12}(?:软件包|系统包|依赖)/i,
    '安装、卸载或升级软件包',
  ],
  [
    /\b(?:systemctl|service)\s+(?:start|stop|restart|reload|enable|disable|mask|unmask)\b|\bsc(?:\.exe)?\s+(?:start|stop|config|create|delete|failure)\b|\b(?:start-service|stop-service|restart-service|set-service|new-service|kill|pkill|killall|taskkill|stop-process|start-process)\b|\b(?:reboot|shutdown|halt|poweroff|restart-computer|stop-computer)\b|\b(?:docker|podman)\s+(?:stop|kill|restart|rm|rmi|system\s+prune)\b|\b(?:docker|podman)\s+compose\s+(?:down|stop|restart|rm)\b|\b(?:pm2|supervisorctl)\s+(?:start|stop|restart|reload|delete)\b|(?:启动|停止|重启|重载|启用|禁用).{0,10}(?:服务|进程|守护进程)|(?:终止|杀死).{0,10}(?:进程|任务)/i,
    '服务、进程或主机状态变更',
  ],
  [
    /\bwmux\b[^\r\n]{0,240}\bsend-key\s+c\b[^\r\n]{0,120}\s--ctrl\b/i,
    '向 SSH 任务终端发送中断信号',
  ],
  [
    /(?:\b(?:approve|allow|confirm)\b|确认|批准|允许|授权).{0,32}(?:\b(?:permission|privilege|elevation)\b|权限|提权)|(?:\b(?:permission|privilege|elevation)\b|权限|提权).{0,32}(?:\b(?:approve|allow|confirm)\b|确认|批准|允许|授权)/i,
    'SSH 远端权限批准',
  ],
  [
    /\b(?:chmod|chown|chgrp|setfacl|setcap|usermod|useradd|userdel|groupadd|groupdel|passwd|visudo|mount|umount|mkfs(?:\.\w+)?|fdisk|parted|iptables|nft|ufw|firewall-cmd|semanage|setenforce|sysctl)\b|\b(?:icacls|set-acl|takeown|netsh|bcdedit|diskpart)\b|(?:修改|变更|调整).{0,10}(?:权限|所有者|用户组|防火墙|系统配置)|(?:挂载|卸载|格式化).{0,10}(?:磁盘|文件系统|分区)/i,
    '权限、账户、网络或系统配置变更',
  ],
  [
    /\b(?:drop|truncate)\s+(?:database|schema|table)\b|\bdelete\s+from\b|\balter\s+(?:database|schema|table)\b|(?:删除|清空).{0,10}(?:数据库|数据表|远程数据)/i,
    '远程数据库破坏性变更',
  ],
];

/** Returns why an SSH-controlling worker must hand an otherwise allowed action to a human. */
export function remoteSshActionBlockReason(action: string): string | null {
  const text = action.trim();
  if (!text) return null;
  const generalBlockReason = autonomousActionBlockReason(text);
  if (generalBlockReason) return generalBlockReason;
  for (const [pattern, reason] of REMOTE_SSH_HUMAN_ACTIONS) {
    const matches = text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
    for (const match of matches) {
      const actionOffset = Math.max(0, match[0].search(/[a-zA-Z\u3400-\u9fff]/u));
      if (!isNegatedMatch(text, (match.index ?? 0) + actionOffset)) return reason;
    }
  }
  return null;
}

const CONFIGURED_FORBIDDEN_ACTIONS: Record<SupervisorForbiddenAction, [RegExp, string]> = {
  'new-dependencies': [
    /\bnpm\s+(?:i|install|update)\b|\b(?:pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade)\b|\b(?:cargo|pip|uv)\s+(?:install|add|update|upgrade)\b|\bgo\s+get\b|\bdotnet\s+add(?:\s+\S+)?\s+package\b|\bcomposer\s+require\b|新增.{0,12}依赖|升级.{0,12}依赖/i,
    '新增或升级第三方依赖',
  ],
  'public-api-change': [
    /\b(?:breaking\s+change|public\s+api)\b|改变.{0,16}(?:对外|公共).{0,8}(?:API|接口|协议)|破坏.{0,8}兼容/i,
    '改变对外 API、协议或兼容行为',
  ],
  'large-refactor': [
    /大范围.{0,8}重构|跨模块.{0,8}(?:重构|改写)|目录迁移|全量重写|rewrite\s+(?:all|entire)/i,
    '大范围重构或目录迁移',
  ],
  'weaken-tests': [
    /删除.{0,12}测试|跳过.{0,12}测试|弱化.{0,12}(?:测试|验收)|\b(?:disable|skip|remove)\b.{0,24}\btests?\b/i,
    '删除、跳过或弱化测试',
  ],
  'build-release-config': [
    /(?:修改|编辑|调整|更新|改动|重写).{0,16}(?:构建|发布|部署).{0,8}配置|\b(?:modify|edit|update|change)\b.{0,24}\b(?:electron-builder|dockerfile|\.github[\\/]workflows)\b/i,
    '修改构建、发布或部署配置',
  ],
  'external-network': [
    /\b(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|web[_-]?search)\b|访问外部网络|调用外部服务/i,
    '访问外部网络或调用外部服务',
  ],
};

function isNegatedMatch(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 64), index);
  const boundary = /[，。；;！？!?\n]|(?:但(?:是)?|不过|然而|而是|改为|然后|随后|接着|\bthen\b|\bbut\b|\binstead\b)/gi;
  let clauseStart = 0;
  for (const match of prefix.matchAll(boundary)) {
    clauseStart = (match.index ?? 0) + match[0].length;
  }
  const clausePrefix = prefix.slice(clauseStart);
  return /(?:不要|不得|禁止|严禁|避免|不可|不能|不允许|绝不|无需|无须)[^，。；;！？!?\n]{0,28}$/i.test(clausePrefix)
    || /不$/u.test(clausePrefix)
    || /\b(?:do\s+not|don't|must\s+not|never)\b[^,.;!?\n]{0,28}$/i.test(clausePrefix);
}

export function shouldAllowHistoricalRecoveryEvidenceBatch(input: {
  projectTaskContractPending?: boolean;
  hasCurrentTaskBatch: boolean;
  guardDecision: string;
  replanTrigger?: string;
  batch?: ProjectTaskBatch;
}): boolean {
  return input.projectTaskContractPending === false
    && !input.hasCurrentTaskBatch
    && input.guardDecision === 'replan'
    && input.replanTrigger === 'no-progress'
    && input.batch?.coverage === 'bounded-batch'
    && ['diagnostic', 'rework'].includes(input.batch.kind)
    && input.batch.evidenceExpectations.length > 0;
}

/** Returns a selected project restriction that matches the proposed action text. */
export function configuredActionBlockReason(
  action: string,
  forbiddenActions: readonly SupervisorForbiddenAction[],
): string | null {
  const text = action.trim();
  if (!text) return null;
  for (const forbidden of forbiddenActions) {
    const rule = CONFIGURED_FORBIDDEN_ACTIONS[forbidden];
    if (!rule) continue;
    const [pattern, reason] = rule;
    const matches = text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
    for (const match of matches) {
      const actionOffset = Math.max(0, match[0].search(/[a-zA-Z\u3400-\u9fff]/u));
      if (!isNegatedMatch(text, (match.index ?? 0) + actionOffset)) return reason;
    }
  }
  return null;
}

function normalizeAbsolutePath(value: string): string | null {
  const normalized = value.trim().replace(/[),;!?]+$/, '').replace(/\\/g, '/');
  let prefix: string;
  let rest: string;

  const drive = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (drive) {
    prefix = `${drive[1].toLowerCase()}:`;
    rest = drive[2];
  } else if (normalized.startsWith('//')) {
    const parts = normalized.slice(2).split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    prefix = `//${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
    rest = parts.slice(2).join('/');
  } else if (normalized.startsWith('/')) {
    prefix = '';
    rest = normalized.slice(1);
  } else {
    return null;
  }

  const caseInsensitive = !!prefix;
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(caseInsensitive ? segment.toLowerCase() : segment);
  }
  const suffix = segments.join('/');
  if (!prefix) return `/${suffix}`;
  return suffix ? `${prefix}/${suffix}` : `${prefix}/`;
}

type ScopePathStyle = 'windows' | 'posix';

function absolutePathStyle(value: string): ScopePathStyle | null {
  const normalized = value.trim().replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')) return 'windows';
  return normalized.startsWith('/') ? 'posix' : null;
}

function pathMatches(action: string, pattern: RegExp): string[] {
  return [...action.matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}

function extractPathReferences(action: string, style: ScopePathStyle): { absolute: string[]; relative: string[] } {
  // URI paths are network destinations, not local filesystem references. They
  // are governed separately by the external-network restriction.
  const quotedAbsolute: string[] = [];
  const withoutStandaloneQuotedPaths = action.replace(/(["'])(.*?)\1/g, (whole, _quote: string, value: string) => {
    if (absolutePathStyle(value) === style) {
      quotedAbsolute.push(value);
      return ' ';
    }
    return whole;
  });
  const text = withoutStandaloneQuotedPaths.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>|]+/gi, ' ');
  const boundary = '(?:^|[\\s(\\x22\\x27\\x60=,:])';
  const absolute = style === 'windows'
    ? [
        ...quotedAbsolute,
        ...pathMatches(text, new RegExp(`${boundary}([a-zA-Z]:[\\\\/][^\\s\\x22\\x27\\x60<>|]*)`, 'g')),
        ...pathMatches(text, new RegExp(`${boundary}((?:\\\\\\\\|//)[^\\\\/\\s\\x22\\x27\\x60<>|]+[\\\\/][^\\s\\x22\\x27\\x60<>|]*)`, 'g')),
        ...pathMatches(text, new RegExp('(?:^|[\\s(\\x22\\x27\\x60=,])(\\\\(?!\\\\)[^\\s\\x22\\x27\\x60<>|]+)', 'g')),
      ]
    : [
        ...quotedAbsolute,
        ...pathMatches(text, new RegExp(`${boundary}(/[^\\s\\x22\\x27\\x60<>|]*)`, 'g')),
      ];
  const relative = text
    .split(/[\s"'`=,:()]+/)
    .map((candidate) => candidate.replace(/[),;；!?！？]+$/, ''))
    .filter((candidate) => candidate.split(/[\\/]/).includes('..'));
  return { absolute, relative };
}

function resolveRelativePath(root: string, relative: string): string | null {
  return normalizeAbsolutePath(`${root.replace(/\/$/, '')}/${relative}`);
}

/** Explicit absolute paths outside the selected lane's immutable project root are never autonomous. */
export function workScopeBlockReason(
  action: string,
  workScope: SupervisorWorkScope,
  projectDir?: string,
): string | null {
  const root = projectDir?.trim();
  if (!root) return action.trim() ? '当前终端未上报工程文件夹' : null;
  const normalizedRoot = normalizeAbsolutePath(root);
  if (!normalizedRoot) return action.trim() ? '当前终端工程文件夹不是可校验的绝对路径' : null;
  const style = absolutePathStyle(root);
  if (!style) return action.trim() ? '当前终端工程文件夹不是可校验的绝对路径' : null;
  if (/\$(?:env:)?[a-z_][\w]*[\\/]|%[a-z_][\w]*%[\\/]|(?:^|\s)~[\\/]/i.test(action)) {
    return '使用了无法静态校验的工程外路径变量';
  }
  const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  const references = extractPathReferences(action, style);
  const outside = references.absolute.find((candidate) => {
    const normalized = normalizeAbsolutePath(candidate);
    return !!normalized && normalized !== normalizedRoot && !normalized.startsWith(rootPrefix);
  });
  if (outside) return '引用了当前工程文件夹之外的绝对路径';
  const traversesOutside = references.relative.some((candidate) => {
    const normalized = resolveRelativePath(normalizedRoot, candidate);
    return !!normalized && normalized !== normalizedRoot && !normalized.startsWith(rootPrefix);
  });
  if (traversesOutside) return '通过相对路径引用了当前工程文件夹之外的位置';
  if (workScope !== 'project' && /(?:全仓|整个工程|所有文件|无关文件|顺手(?:清理|修改|重构)|\b(?:entire|whole)\s+(?:repo|project)\b)/i.test(action)) {
    return workScope === 'plan-defined' ? '动作超出了计划文件限定范围' : '动作超出了当前任务直接涉及的文件范围';
  }
  return null;
}

export function isAutonomousPermissionResponseAllowed(response: string): boolean {
  return /^(?:y|yes|allow|approve)$/i.test(response.trim());
}

interface SupervisorAgentStateView {
  state?: string;
  blockedReason?: string | null;
  blockedVersion?: number;
  blockedRequestId?: string | null;
  sessionId?: string | null;
  updatedAt?: number;
}

function isPermissionBlockedState(
  state: SupervisorAgentStateView | undefined,
): state is SupervisorAgentStateView & { state: 'blocked' } {
  return state?.state === 'blocked'
    && /\b(?:permission|approval|allowance)\b|权限|授权/i.test(state.blockedReason || '');
}

function isQuestionBlockedState(
  state: SupervisorAgentStateView | undefined,
): state is SupervisorAgentStateView & { state: 'blocked' } {
  return state?.state === 'blocked'
    && !isAwaitingNextPromptState(state)
    && /question|input|choice|choose|select|prompt|询问|选择|输入|问题|决定/i.test(state.blockedReason || '');
}

const USER_ONLY_DECISION = /\b(?:terms?|billing|payment|purchase|subscription|account|login|credential|secret|token|password|privacy|licen[cs]e|shipping|delivery|address|order)\b|条款|付费|支付|购买|账单|套餐|订阅|账号|账户|登录|凭据|密钥|令牌|密码|隐私|许可|收货|配送|地址|订单|业务取舍|用户偏好/i;
const TECHNICAL_DECISION = /\b(?:technical|implementation|code|test|build|compile|type|interface|adapter|algorithm|module|file|path)\b|技术|实现|代码|测试|构建|编译|类型|接口|适配|算法|模块|文件|路径/i;

function isLowRiskTechnicalQuestion(
  state: SupervisorAgentStateView | undefined,
  proposedAnswer: string,
): boolean {
  if (!isQuestionBlockedState(state)) return false;
  const blockedReason = state.blockedReason || '';
  return !USER_ONLY_DECISION.test(`${blockedReason}\n${proposedAnswer}`)
    && TECHNICAL_DECISION.test(`${blockedReason}\n${proposedAnswer}`);
}

function blockedRequestAlreadyAnswered(lane: SupervisorLane, state: SupervisorAgentStateView): boolean {
  if (state.blockedRequestId) return lane.lastBlockedResponseId === state.blockedRequestId;
  return typeof state.blockedVersion === 'number'
    && lane.lastBlockedResponseVersion === state.blockedVersion;
}

function selectedAutonomyPermissions(value: unknown): readonly SupervisorAutonomyPermission[] {
  if (value === undefined) return DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS;
  return Array.isArray(value)
    ? value.filter((item): item is SupervisorAutonomyPermission =>
      (DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS as readonly unknown[]).includes(item))
    : [];
}

function inferredNextPermissions(next: string): SupervisorAutonomyPermission[] {
  const permissions: SupervisorAutonomyPermission[] = [];
  if (/选择.{0,12}方案|采用.{0,12}方案|方案\s*[A-Z]\b|\b(?:choose|select|adopt)\b.{0,20}\b(?:option|approach|solution)\b/i.test(next)) {
    permissions.push('technical-choice');
  }
  if (/改用|切换到|调整.{0,8}(?:路线|方案|实现)|替代方案|放弃.{0,16}(?:实现|方案|路线)|从头(?:重做|实现)|重新(?:设计|实现)|推翻|迁移到|全面重写|\b(?:switch|replace|alternative|discard|redesign|migrate|rewrite|start\s+over)\b/i.test(next)) {
    permissions.push('route-adjustment');
  }
  return permissions;
}

function requiredAutonomyPermissions(opts: {
  outcome: string;
  next: string;
  proposalKind: string;
  permissionCommand: string;
  permissionResponse: string;
  agentState?: SupervisorAgentStateView;
}): SupervisorAutonomyPermission[] {
  if (opts.outcome === 'needs-human') return [];
  if (opts.permissionCommand || opts.permissionResponse) return ['permission-confirm'];
  if (!opts.next) return [];
  const required = inferredNextPermissions(opts.next);
  if (opts.proposalKind === 'route-adjustment') required.push('route-adjustment');
  if (isLowRiskTechnicalQuestion(opts.agentState, opts.next)) required.push('technical-choice');
  if (required.length === 0) required.push('same-route-next');
  return [...new Set(required)];
}


function terminalScreenTail(surfaceId: string, lines = 24): string {
  return readTerminalScreen(surfaceId, lines).text?.trim() || '';
}

interface SupervisorDeliveryObservation {
  confirmed: boolean;
  agentState: string;
  screenChanged: boolean;
  acknowledgement?: 'UserPromptSubmit';
}

const supervisorDeliveriesInFlight = new Set<string>();
const pendingTaskPromptAcknowledgements = new Map<string, {
  finish: (confirmed: boolean) => void;
}>();
const TASK_INPUT_RECOVERY_POLL_MS = 300;
const TASK_INPUT_RECOVERY_MAX_POLL_MS = 2_000;
const TASK_INPUT_RECOVERY_STABLE_SAMPLES = 2;
interface TaskInputRecoveryWatch {
  surfaceId: string;
  supervisorSurfaceId: string;
  reviewId?: string;
  stableEmptySamples: number;
  pollDelayMs: number;
  timer?: ReturnType<typeof setTimeout>;
}
const taskInputRecoveryWatches = new Map<string, TaskInputRecoveryWatch>();

/** Wait for the Agent hook that proves a submitted task became a new turn. */
function beginTaskPromptAcknowledgement(
  surfaceId: string,
  beforeScreen: string,
  timeoutMs = 15_000,
): { promise: Promise<SupervisorDeliveryObservation>; cancel: () => void } {
  pendingTaskPromptAcknowledgements.get(surfaceId)?.finish(false);
  let settled = false;
  let resolvePromise: (observation: SupervisorDeliveryObservation) => void = () => undefined;
  const observation = (confirmed: boolean): SupervisorDeliveryObservation => ({
    confirmed,
    agentState: String(((window as any).__wmux_getAgentStates?.() || {})[surfaceId]?.state || 'unknown'),
    screenChanged: terminalScreenTail(surfaceId) !== beforeScreen,
    ...(confirmed ? { acknowledgement: 'UserPromptSubmit' as const } : {}),
  });
  const promise = new Promise<SupervisorDeliveryObservation>((resolve) => {
    resolvePromise = resolve;
  });
  const timer = globalThis.setTimeout(() => finish(false), Math.max(1, timeoutMs));
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  function finish(confirmed: boolean): void {
    if (settled) return;
    settled = true;
    globalThis.clearTimeout(timer);
    if (pendingTaskPromptAcknowledgements.get(surfaceId)?.finish === finish) {
      pendingTaskPromptAcknowledgements.delete(surfaceId);
    }
    resolvePromise(observation(confirmed));
  }
  pendingTaskPromptAcknowledgements.set(surfaceId, { finish });
  return { promise, cancel: () => finish(false) };
}

function acknowledgeTaskPromptDelivery(surfaceId: string): boolean {
  const pending = pendingTaskPromptAcknowledgements.get(surfaceId);
  if (!pending) return false;
  pending.finish(true);
  return true;
}

async function observeSupervisorDelivery(
  surfaceId: string,
  beforeScreen: string,
  beforeAgentState: SupervisorAgentStateView | undefined,
  timeoutMs = 2_000,
): Promise<SupervisorDeliveryObservation> {
  let agentState = 'unknown';
  let screenChanged = false;
  const attempts = Math.max(1, Math.ceil(timeoutMs / 100));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const currentState = ((window as any).__wmux_getAgentStates?.() || {})[surfaceId] as SupervisorAgentStateView | undefined;
    agentState = String(currentState?.state || 'unknown');
    screenChanged = terminalScreenTail(surfaceId) !== beforeScreen;
    const blockedStateChanged = agentState === 'blocked' && (
      beforeAgentState?.state !== 'blocked'
      || currentState?.blockedVersion !== beforeAgentState.blockedVersion
      || currentState?.blockedRequestId !== beforeAgentState.blockedRequestId
    );
    // Screen repaint alone is not an acknowledgement: delayed body echo and
    // unrelated terminal output can both change it before the task is accepted.
    if (agentState === 'working' || blockedStateChanged) {
      return { confirmed: true, agentState, screenChanged };
    }
    if (attempt + 1 < attempts) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
  }
  return { confirmed: false, agentState, screenChanged };
}

function normalizedEvidenceText(value: string): string {
  return value.toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();
}

export function permissionCommandMatchesEvidence(command: string, evidence: string): boolean {
  const normalizedCommand = normalizedEvidenceText(command);
  const activePrompt = evidence
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join('\n');
  const normalizedEvidence = normalizedEvidenceText(activePrompt);
  if (normalizedCommand.length < 3 || !normalizedEvidence) return false;
  if (/^(?:permission|approval|allowance|command|request|权限|授权|批准|命令|请求)(?:\s+required)?$/i.test(normalizedCommand)) {
    return false;
  }
  const hasActivePromptMarker = /\b(?:permission|approval|approve|allow|authorize|confirm|continue)\b|\[(?:y\/n|yes\/no)\]|权限|授权|批准|确认|是否继续/i.test(activePrompt);
  return hasActivePromptMarker && normalizedEvidence.includes(normalizedCommand);
}

function permissionCommandSignature(command: string): string {
  const text = normalizedEvidenceText(command);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function supervisorDecisionTextSignature(value: unknown): string {
  const text = String(value || '').trim().toLowerCase().replace(/\s+/gu, ' ');
  let fnvHash = 0x811c9dc5;
  let djbHash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    fnvHash ^= code;
    fnvHash = Math.imul(fnvHash, 0x01000193);
    djbHash = Math.imul(djbHash, 33) ^ code;
  }
  return `${text.length}:${(fnvHash >>> 0).toString(36)}:${(djbHash >>> 0).toString(36)}`;
}

function supervisorDecisionBlockerCategory(value: unknown): string {
  const text = String(value || '').trim();
  if (/当前通道仍有待项目管理 AI 处理的决策项/iu.test(text)) {
    return 'project-owner-decision-pending';
  }
  return `exact:${supervisorDecisionTextSignature(text)}`;
}

function stableSupervisorDecisionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSupervisorDecisionValue);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.trim() : value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableSupervisorDecisionValue(entry)]));
}

function supervisorDecisionInputSignature(params: any): string {
  const materialInput = {
    outcome: params?.outcome,
    next: params?.next,
    nextFile: params?.nextFile,
    stagePlan: params?.stagePlan,
    stagePlanFile: params?.stagePlanFile,
    proposalKind: params?.proposalKind,
    escalationBoundary: params?.escalationBoundary,
    reason: params?.reason,
    impact: params?.impact,
    alternatives: params?.alternatives,
    permissionCommand: params?.permissionCommand,
    permissionResponse: params?.permissionResponse,
    executionAction: params?.executionAction,
    command: params?.command,
    error: params?.error,
    workspaceVersion: params?.workspaceVersion,
    testCommand: params?.testCommand,
    testResult: params?.testResult,
    changedFiles: params?.changedFiles,
    diffSummary: params?.diffSummary,
    evidence: params?.evidence,
    contextSummary: params?.contextSummary,
    completionChecklist: params?.completionChecklist,
    fullSuite: params?.fullSuite === true,
    retry: params?.retry === true,
    retryKind: params?.retryKind,
  };
  return supervisorDecisionTextSignature(JSON.stringify(stableSupervisorDecisionValue(materialInput)));
}

export function permissionConfirmationLoopReason(
  lane: Pick<SupervisorLane, 'permissionConfirmations'>,
  command: string,
): string | null {
  const signature = permissionCommandSignature(command);
  let consecutive = 0;
  for (let index = (lane.permissionConfirmations || []).length - 1; index >= 0; index -= 1) {
    if (lane.permissionConfirmations![index].commandSignature !== signature) break;
    consecutive += 1;
  }
  return consecutive >= 2
    ? '同一权限命令已连续自动确认 2 次仍再次阻塞；必须改变执行路径或交回上级判断'
    : null;
}

const AUTONOMY_PERMISSION_LABELS: Record<SupervisorAutonomyPermission, string> = {
  'same-route-next': '继续原路线的低风险下一步',
  'technical-choice': '回答低风险技术问题或方案选择',
  'route-adjustment': '小范围可逆路线调整',
  'permission-confirm': '确认低风险权限请求',
};

interface RemoteSupervisorStart {
  action: 'start';
  terminals: string[];
  stopWhen: string;
  stopWhenKind: 'concrete' | 'direction';
  taskGoal?: string;
  taskDescription?: string;
  preconditions?: string;
  supervisorNotes?: string;
  planFile?: string;
  autonomous: boolean;
  supervisorLaunchCmd?: string;
  supervisorModel?: string;
  supervisorReasoningEffort?: string;
  autonomyPermissions?: SupervisorAutonomyPermission[];
  actor?: string;
  projectWorkItemId?: string;
  projectManagerProjectId?: string;
  taskWorkMode?: TaskWorkMode;
  mainThreadResponsibility?: string;
  childThreadResponsibilities?: string[];
  maxChildThreads?: number;
  supervisorMayApproveThreads?: boolean;
  parallelizableOperations?: string[];
  serializedOperations?: string[];
  waitForNextDirection?: boolean;
  recoverySnapshotId?: string;
}

export function shouldSupersedeStoppedSupervisorLane(
  lane: SupervisorLane,
  selectedIds: ReadonlySet<string>,
  recoverySnapshotId = '',
): boolean {
  if (isSupervisorLaneBound(lane)) return false;
  return selectedIds.has(lane.surfaceId)
    || (!!recoverySnapshotId && lane.recoverySnapshotId === recoverySnapshotId);
}

interface RemoteTerminalTask {
  action: 'send';
  terminal: string;
  task: string;
  actor?: string;
  force?: boolean;
  mode?: 'project';
}

interface RemoteTerminalEscape {
  action: 'terminal-escape';
  terminal: string;
  actor?: string;
  mode?: 'project';
}

interface RemoteTerminalInterrupt {
  action: 'terminal-interrupt';
  terminal: string;
  actor?: string;
  mode?: 'project';
}

interface RemoteSupervisorMessage {
  action: 'send-supervisor-message';
  terminal: string;
  message: string;
  actor?: string;
}

interface RemoteWaitingDecision {
  action: 'waiting-decision';
  terminal: string;
  decision: 'keep' | 'resume' | 'submit' | 'stop';
  message?: string;
  actor?: string;
}

interface RemoteDirectTerminalTask {
  action: 'create-task';
  name: string;
  task: string;
  agent?: 'codex' | 'kimi' | 'grok';
  model?: string;
  reasoningEffort?: string;
  preset?: 'project-manager' | 'user-records';
  replaceProjectManager?: boolean;
  cwd: string;
  displayPath?: string;
  anchorWorkspace?: string;
  anchorTerminal?: string;
  projectManagerProjectId?: string;
  projectManagerWorkItemId?: string;
  projectAuxiliaryTask?: boolean;
  projectRuntimeWorkspace?: boolean;
  actor?: string;
}

interface RemoteTaskTerminalLocation {
  surfaceId: SurfaceId;
  paneId: PaneId;
  workspaceId: WorkspaceId;
  workspaceTitle: string;
  projectDir?: string;
  cwd?: string;
  label: string;
  remoteSshControl: boolean;
  surface: SurfaceRef;
}

type RemoteProjectTerminalRole = 'project-ai' | 'supervisor-ai' | 'task-ai' | 'auxiliary-task-ai';

interface RemoteProjectTerminalLocation extends RemoteTaskTerminalLocation {
  role: RemoteProjectTerminalRole;
  projectId: string;
  projectName: string;
  workItemId?: string;
  workItemTitle?: string;
}

interface RemoteOrdinaryMonitoringTerminal extends RemoteTaskTerminalLocation {
  role: 'supervisor-ai' | 'task-ai';
  lane?: SupervisorLane;
}

export type RemoteTerminalActivityState = 'idle' | 'working' | 'blocked' | 'unknown';

interface RemoteTerminalTaskResult {
  ok: boolean;
  message: string;
  error?: string;
  code?: 'terminal_busy';
  terminal?: {
    surfaceId: SurfaceId;
    label: string;
    workspace: string;
    activityState: RemoteTerminalActivityState;
    activityUpdatedAt: number | null;
  };
}

function publicDecisionTaskGoal(session: SupervisorSession, lane: SupervisorLane): string {
  const configuredGoal = effectiveSupervisorTaskGoal(lane);
  if (configuredGoal) return configuredGoal.slice(0, 800);
  const currentTask = lane.currentTask?.trim() || '';
  const privatePlanningMarker = /(?:^|[\n。；;])\s*(?:下一步|方案\s*[A-Za-z0-9一二三四五六七八九十]+|AI\s*建议|推荐方案)\s*[：:]?/u;
  const markerIndex = currentTask.search(privatePlanningMarker);
  const publicSummary = markerIndex > 0 ? currentTask.slice(0, markerIndex).trim() : currentTask;
  if (!publicSummary || /方案\s*[A-Za-z0-9一二三四五六七八九十]+/u.test(publicSummary)) {
    return `完成 ${lane.label} 当前任务（未单独设置任务目标）`;
  }
  return publicSummary.slice(0, 800);
}

const REMOTE_WORKING_STATE_MAX_AGE_MS = 15 * 60 * 1000;

function remoteTerminalActivity(surfaceId: SurfaceId, preserveStaleWorking = false): {
  activityState: RemoteTerminalActivityState;
  activityUpdatedAt: number | null;
} {
  const record = (window as any).__wmux_getAgentStates?.()?.[surfaceId];
  const updatedAt = Number.isFinite(record?.updatedAt) ? Number(record.updatedAt) : null;
  const state = isAwaitingNextPromptState(record)
    ? 'idle'
    : ['idle', 'working', 'blocked', 'unknown'].includes(String(record?.state))
    ? record.state as RemoteTerminalActivityState
    : 'unknown';
  if (!preserveStaleWorking && state === 'working' && (!updatedAt || Date.now() - updatedAt > REMOTE_WORKING_STATE_MAX_AGE_MS)) {
    return { activityState: 'unknown', activityUpdatedAt: updatedAt };
  }
  return { activityState: state, activityUpdatedAt: updatedAt };
}

function nestedAgentShellFailureDetail(surfaceId: SurfaceId): string | null {
  const screen = readTerminalScreen(surfaceId, 80).text || '';
  return interactiveAgentShellPromptFailureDetail(screen);
}

function remoteTaskTerminalLocation(
  surface: SurfaceRef,
  paneId: PaneId,
  workspace: { id: WorkspaceId; title: string; cwd?: string; sshProfileId?: string },
): RemoteTaskTerminalLocation {
  return {
    surfaceId: surface.id,
    paneId,
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
    projectDir: workspace.cwd || surface.currentCwd || surface.cwd,
    cwd: surface.currentCwd || surface.cwd || workspace.cwd,
    label: remoteTerminalLabel(surface),
    remoteSshControl: !!workspace.sshProfileId,
    surface,
  };
}

function collectRemoteTerminals(tree: SplitNode, workspace: { id: WorkspaceId; title: string; cwd?: string; sshProfileId?: string }, out: RemoteTaskTerminalLocation[]): void {
  if (tree.type !== 'leaf') {
    collectRemoteTerminals(tree.children[0], workspace, out);
    collectRemoteTerminals(tree.children[1], workspace, out);
    return;
  }
  for (const surface of tree.surfaces) {
    if (surface.type !== 'terminal') continue;
    const label = remoteTerminalLabel(surface);
    if (label.startsWith(SUPERVISOR_TAB_TITLE) || label === 'AI Supervisor') continue;
    out.push(remoteTaskTerminalLocation(surface, tree.paneId, workspace));
  }
}

function remoteTerminalList(): RemoteTaskTerminalLocation[] {
  const store = useStore.getState();
  const terminals: ReturnType<typeof remoteTerminalList> = [];
  for (const workspace of store.workspaces) {
    const projectRuntimeWorkspace = getAllPaneIds(workspace.splitTree).some((paneId) => (
      findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
        !!surface.projectManagerTerminal
        || !!surface.projectSupervisorProjectId
        || !!surface.projectManagerProjectId
      ))
    ));
    const dedicatedSupervisorWorkspace = (workspace.transientSupervisorWorkspace === true && !projectRuntimeWorkspace)
      || workspace.title.replace(/\s+/gu, '') === SUPERVISOR_WORKSPACE_TITLE.replace(/\s+/gu, '');
    if (dedicatedSupervisorWorkspace) continue;
    collectRemoteTerminals(workspace.splitTree, workspace, terminals);
  }
  const supervisorIds = new Set(store.supervisor.lanes.map(dedicatedSupervisorSurfaceId).filter(Boolean));
  return terminals.filter((terminal) => (
    !supervisorIds.has(terminal.surfaceId) && terminal.surface.projectManagerTerminal !== true
  ));
}

function locateRemoteTaskTerminal(surfaceId: string): { terminal?: RemoteTaskTerminalLocation; error?: string } {
  if (!surfaceId) return { error: '缺少任务终端 ID。' };
  const terminal = remoteTerminalList().find((item) => item.surfaceId === surfaceId);
  if (terminal) return { terminal };

  const store = useStore.getState();
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const surface = findLeaf(workspace.splitTree, paneId)?.surfaces.find((item) => item.id === surfaceId);
      if (!surface) continue;
      if (surface.type !== 'terminal') return { error: '目标不是任务终端。' };
      return { error: '目标是专属监督 AI 终端，不能通过任务终端控制入口操作。' };
    }
  }
  return { error: '目标任务终端不存在、已关闭或属于其他窗口；请刷新终端列表。' };
}

function locateRemoteSupervisorTerminal(identifier: string): {
  lane?: SupervisorLane;
  supervisorSurfaceId?: SurfaceId;
  workspaceTitle?: string;
  error?: string;
} {
  if (!identifier) return { error: '缺少 AI 监督终端 ID。' };
  const store = useStore.getState();
  const lane = store.supervisor.lanes.find((item) => (
    item.surfaceId === identifier
    || item.managementSessionId === identifier
    || dedicatedSupervisorSurfaceId(item) === identifier
  ));
  if (!lane) return { error: '没有找到对应的 AI 监督通道；请刷新监督终端列表。' };
  const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
  if (!supervisorSurfaceId) return { error: `${lane.label} 没有可查看的专属监督 AI 终端。` };

  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const surface = findLeaf(workspace.splitTree, paneId)?.surfaces.find((item) => item.id === supervisorSurfaceId);
      if (surface?.type === 'terminal') {
        return { lane, supervisorSurfaceId, workspaceTitle: workspace.title };
      }
    }
  }
  return { error: `${lane.label} 的 AI 监督终端（管家）已缺失；请在 wmux 中重新配置。` };
}

function locateRemoteTaskSession(
  params: Pick<RemoteDirectTerminalTask, 'anchorWorkspace' | 'anchorTerminal' | 'projectManagerProjectId'>,
  allowProjectManagedAnchor = false,
): { terminal?: RemoteTaskTerminalLocation; error?: string } {
  const eligibleTerminals = remoteTerminalList().filter((terminal) => (
    allowProjectManagedAnchor
      ? !params.projectManagerProjectId
        || terminal.surface.projectManagerProjectId === params.projectManagerProjectId
      : !terminal.surface.projectManagerProjectId && !terminal.surface.projectManagerWorkItemId
  ));
  if (params.anchorWorkspace) {
    const terminal = eligibleTerminals.find((item) => item.workspaceId === params.anchorWorkspace);
    if (terminal) return { terminal };
    if (allowProjectManagedAnchor && params.projectManagerProjectId) {
      const workspace = useStore.getState().workspaces.find((item) => item.id === params.anchorWorkspace);
      if (workspace?.transientSupervisorWorkspace === true) {
        for (const paneId of getAllPaneIds(workspace.splitTree)) {
          const projectSurface = findLeaf(workspace.splitTree, paneId)?.surfaces.find((surface) => (
            surface.type === 'terminal'
            && (
              surface.projectSupervisorProjectId === params.projectManagerProjectId
              || surface.projectManagerProjectId === params.projectManagerProjectId
            )
          ));
          if (projectSurface) {
            return { terminal: remoteTaskTerminalLocation(projectSurface, paneId, workspace) };
          }
        }
      }
    }
    return { error: '目标会话不存在、已关闭或当前没有可用任务终端。' };
  }
  const terminalId = String(params.anchorTerminal || '');
  if (!terminalId) return { error: '缺少任务终端 ID。' };
  const terminal = eligibleTerminals.find((item) => item.surfaceId === terminalId);
  return terminal
    ? { terminal }
    : { error: '目标任务终端不存在、已关闭或属于项目管理模式。' };
}

/** Project runtimes are deliberately absent from ordinary terminal controls. */
function remoteProjectTerminalList(): RemoteProjectTerminalLocation[] {
  const store = useStore.getState();
  const terminals: RemoteProjectTerminalLocation[] = [];
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      for (const surface of findLeaf(workspace.splitTree, paneId)?.surfaces || []) {
        if (surface.type !== 'terminal') continue;
        const role: RemoteProjectTerminalRole | undefined = surface.projectManagerTerminal
          ? 'project-ai'
          : surface.projectSupervisorProjectId
            ? 'supervisor-ai'
            : surface.projectAuxiliaryTask && surface.projectManagerProjectId
              ? 'auxiliary-task-ai'
            : surface.projectManagerProjectId
              ? 'task-ai'
              : undefined;
        const projectId = role === 'supervisor-ai'
          ? surface.projectSupervisorProjectId
          : surface.projectManagerProjectId;
        if (!role || !projectId) continue;
        const project = store.projectManagers.find((candidate) => candidate.id === projectId);
        const lane = store.supervisor.lanes.find((candidate) => (
          candidate.projectManagerProjectId === projectId
          && (candidate.surfaceId === surface.id || candidate.supervisorSurfaceId === surface.id)
        ));
        const workItemId = surface.projectManagerWorkItemId || lane?.projectWorkItemId;
        const workItem = project?.workItems.find((candidate) => candidate.id === workItemId);
        terminals.push({
          ...remoteTaskTerminalLocation(surface, paneId, workspace),
          role,
          projectId,
          projectName: project ? projectDisplayName(project) : projectId,
          workItemId,
          workItemTitle: workItem?.title || lane?.label,
        });
      }
    }
  }
  return terminals;
}

function remoteSurfaceTerminalLocation(surfaceId: string): RemoteTaskTerminalLocation | undefined {
  const store = useStore.getState();
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const surface = findLeaf(workspace.splitTree, paneId)?.surfaces.find((candidate) => (
        candidate.id === surfaceId && candidate.type === 'terminal'
      ));
      if (surface) return remoteTaskTerminalLocation(surface, paneId, workspace);
    }
  }
  return undefined;
}

/** The ordinary-mode monitor includes both worker Agents and their dedicated supervisors. */
function remoteOrdinaryMonitoringTerminalList(): RemoteOrdinaryMonitoringTerminal[] {
  const state = useStore.getState().supervisor;
  const ordinaryLanes = state.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane));
  const laneByTaskSurface = new Map(ordinaryLanes.map((lane) => [lane.surfaceId, lane]));
  const taskTerminals: RemoteOrdinaryMonitoringTerminal[] = remoteTerminalList()
    .filter((terminal) => (
      !terminal.surface.projectManagerProjectId
      && !terminal.surface.projectManagerWorkItemId
    ))
    .map((terminal) => ({
      ...terminal,
      role: 'task-ai',
      lane: laneByTaskSurface.get(terminal.surfaceId),
    }));
  const supervisorTerminals = ordinaryLanes.flatMap((lane): RemoteOrdinaryMonitoringTerminal[] => {
    const surfaceId = dedicatedSupervisorSurfaceId(lane);
    if (!surfaceId) return [];
    const terminal = remoteSurfaceTerminalLocation(surfaceId);
    return terminal ? [{ ...terminal, role: 'supervisor-ai', lane }] : [];
  });
  return [...taskTerminals, ...supervisorTerminals];
}

function locateRemoteProjectTerminal(surfaceId: string): {
  terminal?: RemoteProjectTerminalLocation;
  error?: string;
} {
  if (!surfaceId) return { error: '缺少项目模式终端 ID。' };
  const terminal = remoteProjectTerminalList().find((candidate) => candidate.surfaceId === surfaceId);
  return terminal
    ? { terminal }
    : { error: '目标不属于项目 AI 模式、已经关闭或已被新运行时替代；请刷新终端列表。' };
}

function currentUserRecordsTerminal(): RemoteTaskTerminalLocation | undefined {
  return remoteTerminalList().find((terminal) => terminal.surface.userRecordsTerminal === true);
}

function focusRemoteTerminal(terminal: RemoteTaskTerminalLocation): void {
  const store = useStore.getState();
  store.selectWorkspace(terminal.workspaceId);
  const workspace = useStore.getState().workspaces.find((item) => item.id === terminal.workspaceId);
  const leaf = workspace && findLeaf(workspace.splitTree, terminal.paneId);
  const index = leaf?.surfaces.findIndex((surface) => surface.id === terminal.surfaceId) ?? -1;
  if (index >= 0) store.selectSurface(terminal.workspaceId, terminal.paneId, index);
}

function createRemoteDirectTerminalTask(
  params: RemoteDirectTerminalTask,
  allowProjectManagedCreate = false,
): { ok: boolean; message: string; error?: string; surfaceId?: string } {
  const name = String(params.name || '').trim();
  const task = String(params.task || '').trim();
  const cwd = String(params.cwd || '').trim();
  const requestedAgent = String(params.agent || 'codex').trim().toLowerCase();
  const model = String(params.model || '').trim();
  const reasoningEffort = String(params.reasoningEffort || '').trim();
  const projectManager = params.preset === 'project-manager';
  const userRecordsTerminal = params.preset === 'user-records';
  const agent = userRecordsTerminal
    ? USER_RECORDS_TERMINAL_AGENT
    : projectTaskTerminalAgent(params.agent);
  const requestsProjectManagedCreate = !!(
    projectManager || params.projectManagerProjectId || params.projectManagerWorkItemId
  );
  if (requestsProjectManagedCreate && !allowProjectManagedCreate) {
    return { ok: false, error: '项目管理终端只能由项目管理模式创建。', message: '' };
  }
  if (!name || !task) return { ok: false, error: '任务名称和首条任务都不能为空。', message: '' };
  if (!['codex', 'kimi', 'grok'].includes(requestedAgent)) return { ok: false, error: 'AI 终端类型仅允许 Codex、Kimi 或 Grok。', message: '' };
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd)) return { ok: false, error: '任务目录必须是 Windows 绝对路径。', message: '' };

  if (userRecordsTerminal) {
    const valid = name === USER_RECORDS_TERMINAL_NAME
      && task === USER_RECORDS_TERMINAL_STARTUP_INPUT
      && requestedAgent === USER_RECORDS_TERMINAL_AGENT
      && normalizeAbsolutePath(cwd) === normalizeAbsolutePath(USER_RECORDS_TERMINAL_DIRECTORY)
      && !model
      && !reasoningEffort
      && !params.anchorWorkspace
      && !params.anchorTerminal
      && !params.projectManagerProjectId
      && !params.projectManagerWorkItemId;
    if (!valid) return { ok: false, error: '用户记录终端配置无效。', message: '' };

    const existing = currentUserRecordsTerminal();
    if (existing) {
      const runtime = terminalRuntimeStatus(existing.surfaceId);
      if (runtime?.state !== 'failed' && runtime?.state !== 'exited') {
        focusRemoteTerminal(existing);
        return {
          ok: true,
          surfaceId: existing.surfaceId,
          message: runtime?.state === 'ready'
            ? '用户记录终端已存在，已切换到该终端。'
            : '用户记录终端已存在，正在等待运行时就绪。',
        };
      }
      useStore.getState().closeSurface(existing.workspaceId, existing.paneId, existing.surfaceId);
    }

    const launch = buildInteractiveAgentLaunch(USER_RECORDS_TERMINAL_AGENT, task);
    const tree = createLeaf(undefined, 'terminal', USER_RECORDS_TERMINAL_DIRECTORY);
    const surface = tree.surfaces[0];
    tree.surfaces[0] = {
      ...surface,
      customTitle: USER_RECORDS_TERMINAL_NAME,
      shell: 'pwsh.exe',
      cwd: USER_RECORDS_TERMINAL_DIRECTORY,
      userRecordsTerminal: true,
      ...launch,
    };
    markTerminalRuntimeStarting(surface.id);
    useStore.getState().createWorkspace({
      title: USER_RECORDS_TERMINAL_NAME,
      cwd: USER_RECORDS_TERMINAL_DIRECTORY,
      splitTree: tree,
    });
    return {
      ok: true,
      surfaceId: surface.id,
      message: `已创建${USER_RECORDS_TERMINAL_NAME}，正在启动 Codex 并加载默认技能 ${USER_RECORDS_TERMINAL_STARTUP_INPUT}。`,
    };
  }

  if (projectManager) {
    const projectId = String(params.projectManagerProjectId || '').trim();
    const runtimeSegments = cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).slice(-2);
    if (
      name !== PROJECT_MANAGER_TERMINAL_NAME
      || !projectId
      || runtimeSegments.length !== PROJECT_MANAGER_RUNTIME_PATH_SUFFIX.length
      || runtimeSegments.some((segment, index) => (
        segment.toLocaleLowerCase() !== PROJECT_MANAGER_RUNTIME_PATH_SUFFIX[index]
      ))
    ) {
      return { ok: false, error: '项目管理 AI 运行时配置无效。', message: '' };
    }
    const store = useStore.getState();
    const project = store.projectManagers.find((candidate) => candidate.id === projectId);
    if (!project) return { ok: false, error: '项目管理 AI 缺少有效的项目归属。', message: '' };
    const existing = projectManagerTerminal({ projectId });
    const taskWorkspace = project.taskTerminalSurfaceId
      ? store.workspaces.find((workspace) => (
          getAllPaneIds(workspace.splitTree).some((paneId) => (
            findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
              surface.id === project.taskTerminalSurfaceId
            ))
          ))
        ))
      : undefined;
    const managerWorkspaceSplit = !!existing
      && !!taskWorkspace
      && existing.workspaceId !== taskWorkspace.id;
    if (existing && !params.replaceProjectManager && !managerWorkspaceSplit) {
      useStore.getState().updateSurface(existing.workspaceId, existing.paneId, existing.surfaceId, {
        projectManagerTerminal: true,
        projectManagerProjectId: projectId,
        projectManagerAgent: agent,
        projectManagerModel: model,
        projectManagerReasoningEffort: reasoningEffort,
      });
      return { ok: true, surfaceId: existing.surfaceId, message: '项目管理 AI 运行时已就绪。' };
    }

    const previousWorkspaceId = store.activeWorkspaceId;
    let controlWorkspace = taskWorkspace || store.workspaces.find((workspace) => (
      workspace.transientSupervisorWorkspace === true
      && getAllPaneIds(workspace.splitTree).some((paneId) => (
        findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
          (surface.projectManagerTerminal === true && surface.projectManagerProjectId === projectId)
          || surface.projectSupervisorProjectId === projectId
        ))
      ))
    ));
    if (!controlWorkspace) {
      const workspaceId = store.createWorkspace({
        title: projectManagerWorkspaceTitle(projectDisplayName(project), project.id),
        cwd: project.projectDir,
        pinned: true,
        transientSupervisorWorkspace: true,
        splitTree: createLeaf(undefined, 'supervisor'),
      });
      if (previousWorkspaceId) store.selectWorkspace(previousWorkspaceId);
      controlWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === workspaceId);
    }
    const targetPaneId = controlWorkspace ? getAllPaneIds(controlWorkspace.splitTree)[0] : undefined;
    if (!controlWorkspace || !targetPaneId) return { ok: false, error: '无法创建项目调度控制层运行时。', message: '' };
    const placeholderSurfaceId = findLeaf(controlWorkspace.splitTree, targetPaneId)?.surfaces
      .find((surface) => surface.type === 'supervisor')?.id;
    const launch = buildInteractiveAgentLaunch(agent, task, model, reasoningEffort, {
      suppressCodexHistory: true,
    });
    const surfaceId = store.addSurface(controlWorkspace.id, targetPaneId, 'terminal', {
      customTitle: PROJECT_MANAGER_TERMINAL_NAME,
      shell: 'pwsh.exe',
      cwd,
      projectManagerTerminal: true,
      projectManagerProjectId: projectId,
      projectManagerAgent: agent,
      projectManagerModel: model,
      projectManagerReasoningEffort: reasoningEffort,
      ...launch,
    });
    if (!surfaceId) return { ok: false, error: '无法创建项目管理 AI 运行时。', message: '' };
    if (placeholderSurfaceId) {
      store.closeSurface(controlWorkspace.id, targetPaneId, placeholderSurfaceId);
    }
    markTerminalRuntimeStarting(surfaceId);
    return {
      ok: true,
      surfaceId,
      message: '项目管理 AI 运行时已创建，正在等待启动就绪。',
    };
  }

  const agentLabel = agent === 'kimi' ? 'Kimi' : agent === 'grok' ? 'Grok' : 'Codex';
  const launch = buildInteractiveAgentLaunch(agent as InteractiveAgent, task, model, reasoningEffort);
  const surfaceOptions = {
    customTitle: params.projectManagerProjectId
      ? params.projectAuxiliaryTask ? '辅助 AI' : '任务 AI'
      : `${agentLabel}直连 · ${name}`,
    shell: 'pwsh.exe',
    cwd,
    ...(params.projectManagerProjectId ? { projectManagerProjectId: params.projectManagerProjectId } : {}),
    ...(params.projectManagerWorkItemId ? { projectManagerWorkItemId: params.projectManagerWorkItemId } : {}),
    ...(params.projectAuxiliaryTask ? { projectAuxiliaryTask: true } : {}),
    ...launch,
  };

  if (params.anchorWorkspace || params.anchorTerminal) {
    const anchor = locateRemoteTaskSession(params, allowProjectManagedCreate);
    if (!anchor.terminal) return { ok: false, error: `无法定位目标会话：${anchor.error}`, message: '' };
    const surfaceId = useStore.getState().addSurface(
      anchor.terminal.workspaceId,
      anchor.terminal.paneId,
      'terminal',
      surfaceOptions,
    );
    if (!surfaceId) return { ok: false, error: '无法在所选会话创建任务终端。', message: '' };
    markTerminalRuntimeStarting(surfaceId);
    const created = locateRemoteTaskTerminal(surfaceId);
    if (created.terminal) focusRemoteTerminal(created.terminal);
    return {
      ok: true,
      surfaceId,
      message: `已在会话“${anchor.terminal.workspaceTitle}”添加 ${agentLabel} 直连终端“${name}”；首条任务将在终端就绪后自动发送。目录：${params.displayPath || cwd}`,
    };
  }

  if (params.projectRuntimeWorkspace && params.projectManagerProjectId) {
    const runtimeStore = useStore.getState();
    const workspaceId = projectRuntimeWorkspaceId(params.projectManagerProjectId);
    const workspace = runtimeStore.workspaces.find((candidate) => candidate.id === workspaceId);
    const paneId = workspace && getAllPaneIds(workspace.splitTree).find((candidatePaneId) => (
      findLeaf(workspace.splitTree, candidatePaneId)?.surfaces.some((candidate) => (
        candidate.projectManagerProjectId === params.projectManagerProjectId
        || candidate.projectSupervisorProjectId === params.projectManagerProjectId
      ))
    ));
    if (workspace && paneId) {
      const surfaceId = runtimeStore.addSurface(workspace.id, paneId, 'terminal', surfaceOptions);
      if (!surfaceId) return { ok: false, error: '无法在项目执行会话创建任务终端。', message: '' };
      markTerminalRuntimeStarting(surfaceId);
      return {
        ok: true,
        surfaceId,
        message: `已在项目会话“${workspace.title}”添加 ${agentLabel} 任务终端“${name}”；首条任务将在终端就绪后自动发送。目录：${params.displayPath || cwd}`,
      };
    }
  }

  const tree = createLeaf(undefined, 'terminal', cwd);
  const surface = tree.surfaces[0];
  tree.surfaces[0] = {
    ...surface,
    ...surfaceOptions,
  };
  markTerminalRuntimeStarting(surface.id);
  const project = params.projectRuntimeWorkspace && params.projectManagerProjectId
    ? useStore.getState().projectManagers.find((candidate) => candidate.id === params.projectManagerProjectId)
    : undefined;
  useStore.getState().createWorkspace({
    title: project
      ? projectManagerWorkspaceTitle(projectDisplayName(project), project.id)
      : name,
    cwd,
    splitTree: tree,
    ...(params.projectRuntimeWorkspace ? {
      pinned: true,
      transientSupervisorWorkspace: true,
    } : {}),
  });
  return {
    ok: true,
    surfaceId: surface.id,
    message: `已创建 ${agentLabel} 直连终端“${name}”；首条任务将在终端就绪后自动发送。目录：${params.displayPath || cwd}`,
  };
}

function remoteAudit(session: ReturnType<typeof useStore.getState>['supervisor'], lane: SupervisorLane | undefined, type: string, payload: Record<string, unknown>): void {
  if (lane) appendSupervisorRecord(session, lane, type, payload);
}

function hasLiveSurface(surfaceId: SurfaceId): boolean {
  return useStore.getState().workspaces.some((workspace) => getAllPaneIds(workspace.splitTree).some((paneId) =>
    findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => surface.id === surfaceId),
  ));
}

/** A stopped session must not leave its dedicated AI tabs attached to a replacement session. */
function closeStoppedSupervisorSurfaces(lanes: SupervisorLane[]): void {
  for (const lane of lanes) {
    const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
    if (!supervisorSurfaceId) continue;
    let location: { workspaceId: WorkspaceId; paneId: PaneId } | undefined;
    for (const workspace of useStore.getState().workspaces) {
      for (const paneId of getAllPaneIds(workspace.splitTree)) {
        const pane = findLeaf(workspace.splitTree, paneId);
        if (pane?.surfaces.some((surface) => surface.id === supervisorSurfaceId)) {
          location = { workspaceId: workspace.id, paneId };
          break;
        }
      }
      if (location) break;
    }
    if (location) useStore.getState().closeSurface(location.workspaceId, location.paneId, supervisorSurfaceId);
  }
}

function supervisorStartupInput(lane: SupervisorLane): string {
  return [
    '[监督 AI 启动｜控制层]',
    `角色协议：当前隔离目录 AGENTS.md（protocol=${SUPERVISOR_PROTOCOL_REVISION}）`,
    `当前 capability 预期绑定唯一任务终端：${lane.surfaceId}`,
    'AGENTS.md 只含稳定角色规则；不要等待控制层重复发送协议正文。',
    '先运行 wmux context 获取实时 lane、工作项、权限、预算、复核状态和可用命令。',
    `随后运行 wmux role-ready --protocol ${SUPERVISOR_PROTOCOL_REVISION}；成功前不得提交 supervisor decide。`,
  ].join('\n');
}

function waitForControlPlaneDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

const ORDINARY_CONTEXT_CLEAR_READY_TIMEOUT_MS = 20_000;

async function waitForOrdinaryContextClearReady(options: {
  surfaceId: SurfaceId;
  validate: () => string | null;
  timeoutMs?: number;
}): Promise<string | null> {
  const deadline = Date.now() + (options.timeoutMs || ORDINARY_CONTEXT_CLEAR_READY_TIMEOUT_MS);
  let stableReadyFingerprint = '';
  let stableReadySamples = 0;
  while (Date.now() < deadline) {
    const stateError = options.validate();
    if (stateError) return stateError;
    const runtime = terminalRuntimeStatus(options.surfaceId);
    if (runtime?.state === 'failed' || runtime?.state === 'exited') {
      return `任务 AI 执行 /new 后运行时已${runtime.state === 'failed' ? '失败' : '退出'}`;
    }
    const screen = terminalScreenTail(options.surfaceId, 80);
    const shellError = interactiveAgentShellPromptFailureDetail(screen);
    if (shellError) return `任务 AI 执行 /new 后落入普通 shell：${shellError}`;
    const buffer = surfaceTerminalRegistry.get(options.surfaceId)?.buffer.active;
    const agentState = ((window as any).__wmux_getAgentStates?.() || {})[options.surfaceId];
    const declaredIdle = agentState?.state === 'idle' || isAwaitingNextPromptState(agentState);
    const noNestedRun = Number(agentState?.runDepth || 0) <= 0;
    const inputReady = interactiveAgentPromptReady(screen) || interactiveAgentInputReady(screen);
    const noPendingInput = !buffer || !hasPendingTerminalInput(buffer);
    if (declaredIdle && noNestedRun && inputReady && noPendingInput) {
      const fingerprint = normalizeProjectActivityFingerprintText(screen).slice(-2_000);
      if (fingerprint && fingerprint === stableReadyFingerprint) {
        stableReadySamples += 1;
      } else {
        stableReadyFingerprint = fingerprint;
        stableReadySamples = fingerprint ? 1 : 0;
      }
      if (stableReadySamples >= 2) return null;
    } else {
      stableReadyFingerprint = '';
      stableReadySamples = 0;
    }
    await waitForControlPlaneDelay(100);
  }
  return `任务 AI 执行 /new 后 ${Math.round((options.timeoutMs || ORDINARY_CONTEXT_CLEAR_READY_TIMEOUT_MS) / 1000)} 秒内没有回到可安全接收任务的 Agent 输入态`;
}

async function deliverSupervisorStartupBriefing(laneId: string): Promise<void> {
  const initial = useStore.getState().supervisor.lanes.find((lane) => lane.id === laneId);
  if (!initial?.supervisorSurfaceId) return;
  const ready = await waitForTerminalRuntimeReady(initial.supervisorSurfaceId);
  if (!ready.ok) {
    const failedLane = useStore.getState().supervisor.lanes.find((lane) => lane.id === laneId);
    if (!failedLane || failedLane.supervisorSurfaceId !== initial.supervisorSurfaceId) return;
    const detail = `AI 监督运行时启动失败：${ready.error || '未知错误'}`;
    if (terminalRuntimeStatus(initial.supervisorSurfaceId)?.state === 'starting') {
      markTerminalRuntimeFailed(initial.supervisorSurfaceId, detail);
    }
    if (failedLane.projectRuntimeHandover?.state === 'candidate') {
      useStore.getState().updateLane(laneId, {
        supervisorBriefingStatus: 'failed',
        supervisorProblem: { kind: 'runtime-failed', detail, detectedAt: Date.now() },
      });
      return;
    }
    useStore.getState().pauseSupervisorLane(laneId, detail);
    queueProjectSupervisorRecovery(failedLane, detail);
    return;
  }
  await waitForControlPlaneDelay(SUPERVISOR_TUI_READY_DELAY_MS);
  const current = useStore.getState().supervisor;
  const lane = current.lanes.find((candidate) => candidate.id === laneId);
  if (!lane?.supervisorSurfaceId || supervisorLaneControlState(lane) !== 'active') return;
  if (managedRoleProtocolIsReady(lane.supervisorSurfaceId)) return;
  const screenResult = readTerminalScreen(lane.supervisorSurfaceId, 80);
  const screen = screenResult.text || '';
  // Unit/non-Electron harnesses intentionally omit both xterm and pty.has.
  // Production must always fail closed when the mounted terminal cannot prove
  // that a supported Agent input UI is present.
  const nonElectronHarness = !!screenResult.error && !(window as any).wmux?.pty?.has;
  if (!nonElectronHarness && !interactiveAgentInputReady(screen)) {
    const detail = interactiveAgentShellPromptFailureDetail(screen)
      || 'AI 监督运行时启动失败：未检测到 Codex、Kimi、Grok 或 Pi 的可输入界面；已禁止向未知终端发送监督协议';
    markTerminalRuntimeFailed(lane.supervisorSurfaceId, detail);
    useStore.getState().updateLane(lane.id, {
      ...(lane.projectRuntimeHandover?.state === 'candidate'
        ? { supervisorBriefingStatus: 'failed' as const }
        : {}),
      supervisorProblem: { kind: 'runtime-failed', detail, detectedAt: Date.now() },
    });
    if (lane.projectRuntimeHandover?.state === 'candidate') return;
    useStore.getState().pauseSupervisorLane(lane.id, detail);
    appendSupervisorRecord(current, lane, 'supervisor.runtime-failed', {
      detail,
      startupGuard: true,
    });
    queueProjectSupervisorRecovery(lane, detail);
    return;
  }
  useStore.getState().updateLane(lane.id, {
    supervisorBriefingStatus: 'queued',
    supervisorBriefingConfirmedAt: undefined,
  });
  const delivery = queueSupervisorControlMessage(
    lane,
    supervisorStartupInput(lane),
    undefined,
    true,
  );
  appendSupervisorRecord(current, lane, 'supervisor.briefing-queued', {
    deliveryId: delivery.id,
    bootstrapOnRuntimeReady: true,
  });
}

async function waitForProjectSupervisorBriefing(laneId: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === laneId);
    if (!lane || supervisorLaneControlState(lane) === 'stopped') return false;
    if (lane.supervisorBriefingStatus === 'confirmed') return true;
    if (lane.supervisorBriefingStatus === 'failed') return false;
    await waitForControlPlaneDelay(100);
  }
  return false;
}

function startRemoteSupervisor(
  params: RemoteSupervisorStart,
  allowProjectManagedStart = false,
): { ok: boolean; message: string; error?: string } {
  const store = useStore.getState();
  const retainedSession = store.supervisor.active || store.supervisor.paused;
  const requestsProjectManagedStart = !!(
    params.projectManagerProjectId || params.projectWorkItemId
  );
  const projectManagedStart = !!params.projectManagerProjectId;
  if (requestsProjectManagedStart && !allowProjectManagedStart) {
    return { ok: false, error: '项目监督只能由对应的项目管理 AI 启动。', message: '' };
  }
  if (allowProjectManagedStart && !params.projectManagerProjectId) {
    return { ok: false, error: '项目监督缺少项目归属。', message: '' };
  }
  const previousLanes = store.supervisor.lanes;
  const selectedIds = new Set(params.terminals);
  const displacedOrdinaryLanes = projectManagedStart
    ? previousLanes.filter((lane) => (
        !isProjectManagedSupervisorLane(lane)
        && selectedIds.has(lane.surfaceId)
        && isSupervisorLaneBound(lane)
      ))
    : [];
  const displacedOrdinaryLaneIds = new Set(displacedOrdinaryLanes.map((lane) => lane.id));
  const boundSurfaceIds = new Set(retainedSession
    ? previousLanes
      .filter((lane) => isSupervisorLaneBound(lane) && !displacedOrdinaryLaneIds.has(lane.id))
      .map((lane) => lane.surfaceId)
    : []);
  const candidates: RemoteTaskTerminalLocation[] = remoteTerminalList().filter((terminal) => {
        if (!selectedIds.has(terminal.surfaceId) || boundSurfaceIds.has(terminal.surfaceId)) return false;
        if (terminal.surface.projectManagerTerminal) return false;
        return projectManagedStart
          ? terminal.surface.projectManagerProjectId === params.projectManagerProjectId
          : !terminal.surface.projectManagerProjectId && !terminal.surface.projectManagerWorkItemId;
      });
  if (candidates.length !== selectedIds.size) return { ok: false, error: '包含不存在或不可监督的终端 ID；先执行 LIST 获取最新终端。', message: '' };
  if (!params.stopWhen.trim()) return { ok: false, error: '停止条件不能为空。', message: '' };
  if (!projectManagedStart && !String(params.taskGoal || '').trim() && !String(params.planFile || '').trim()) {
    return { ok: false, error: '普通监督必须明确提供任务目标或计划文件，不能从任务终端旧对话自动推断用户规划。', message: '' };
  }
  if (candidates.some((candidate) => !candidate.projectDir)) return { ok: false, error: '所选终端缺少项目目录，无法写入审计记录。', message: '' };
  if (!projectManagedStart && params.planFile && candidates.some((candidate) => (
    !!workScopeBlockReason(`读取 "${params.planFile}"`, 'project', candidate.projectDir)
  ))) {
    return { ok: false, error: '普通监督计划文件必须位于每个任务终端对应的目标项目目录内。', message: '' };
  }

  const previousActiveWorkspaceId = store.activeWorkspaceId;
  const workspaceHasProjectRuntime = (workspace: typeof store.workspaces[number], projectId?: string): boolean => (
    getAllPaneIds(workspace.splitTree).some((paneId) => (
      findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
        projectId
          ? surface.projectManagerProjectId === projectId
            || surface.projectSupervisorProjectId === projectId
          : !!surface.projectManagerTerminal || !!surface.projectSupervisorProjectId
      ))
    ))
  );
  const projectRuntimeCandidate = projectManagedStart ? candidates[0] : undefined;
  const supervisorWorkspace = projectRuntimeCandidate
    ? store.workspaces.find((workspace) => (
        workspace.id === projectRuntimeCandidate.workspaceId
        && workspaceHasProjectRuntime(workspace, params.projectManagerProjectId)
      ))
    : undefined;
  const targetPaneId = projectRuntimeCandidate?.paneId;
  if (
    projectManagedStart
    && (
      !supervisorWorkspace
      || !targetPaneId
      || !findLeaf(supervisorWorkspace.splitTree, targetPaneId)
    )
  ) {
    return {
      ok: false,
      error: '项目任务 AI 不在有效的项目执行会话中，不能创建独立监督工作区。',
      message: '',
    };
  }
  let projectControlSurfaceId = projectManagedStart
    ? findLeaf(supervisorWorkspace!.splitTree, targetPaneId!)?.surfaces.find((surface) => (
        surface.type === 'supervisor'
        && surface.projectSupervisorProjectId === params.projectManagerProjectId
      ))?.id
    : undefined;
  if (projectManagedStart && !projectControlSurfaceId) {
    projectControlSurfaceId = store.addSurface(supervisorWorkspace!.id, targetPaneId!, 'supervisor', {
      customTitle: PROJECT_SUPERVISOR_WORKSPACE_TITLE,
      projectSupervisorProjectId: params.projectManagerProjectId,
    }) || undefined;
  }
  if (projectManagedStart && projectControlSurfaceId) {
    store.updateSurface(supervisorWorkspace!.id, targetPaneId!, projectControlSurfaceId, {
      customTitle: PROJECT_SUPERVISOR_WORKSPACE_TITLE,
    });
  }

  const launchCmd = params.supervisorLaunchCmd !== undefined
    ? params.supervisorLaunchCmd
    : store.supervisor.supervisorLaunchCmd || 'pi';
  const supervisorModel = params.supervisorModel !== undefined
    ? params.supervisorModel
    : retainedSession ? store.supervisor.supervisorModel : '';
  const supervisorReasoningEffort = params.supervisorReasoningEffort !== undefined
    ? params.supervisorReasoningEffort
    : retainedSession ? store.supervisor.supervisorReasoningEffort : '';
  const isolationError = supervisorLaunchIsolationError(launchCmd);
  if (isolationError) return { ok: false, error: isolationError, message: '' };
  const createdOrdinaryStatusSurfaces: Array<{
    surfaceId: SurfaceId;
    workspaceId: WorkspaceId;
    paneId: PaneId;
  }> = [];
  const lanes: SupervisorLane[] = candidates.map((candidate) => {
    const pairedWorkspace = projectManagedStart
      ? supervisorWorkspace
      : store.workspaces.find((workspace) => workspace.id === candidate.workspaceId);
    const pairedPaneId = projectManagedStart ? targetPaneId : candidate.paneId;
    if (!projectManagedStart && pairedWorkspace && pairedPaneId) {
      const statusSurface = ensureOrdinarySupervisorStatusSurface(pairedWorkspace.id, pairedPaneId);
      if (statusSurface?.created) {
        createdOrdinaryStatusSurfaces.push({
          surfaceId: statusSurface.surfaceId,
          workspaceId: pairedWorkspace.id,
          paneId: pairedPaneId,
        });
      }
    }
    const launch = buildSupervisorLaunchCommand(
      launchCmd,
      supervisorModel,
      supervisorReasoningEffort,
      {
        isolateSupervisor: true,
        projectDir: candidate.projectDir,
        isolationKey: candidate.surfaceId,
      },
    );
    const supervisorSurfaceId = pairedWorkspace && pairedPaneId
      ? store.addSurface(pairedWorkspace.id, pairedPaneId, 'terminal', {
      customTitle: projectManagedStart ? '监督 AI' : supervisorTabTitle(candidate.label),
      shell: 'pwsh.exe',
      cwd: candidate.projectDir,
      startupCommands: launch ? [launch] : undefined,
      transientSupervisor: true,
      supervisorRuntimeIsolationKey: candidate.surfaceId,
      ...(projectManagedStart ? {
        projectSupervisorProjectId: params.projectManagerProjectId,
      } : {}),
      })
      : null;
    if (supervisorSurfaceId) markTerminalRuntimeStarting(supervisorSurfaceId);
    if (supervisorSurfaceId) managedRoleProtocolReady.delete(supervisorSurfaceId);
    const lane = clearSupervisorLaneContext({
      id: `lane-${uuid()}`,
      projectWorkItemId: params.projectWorkItemId,
      projectManagerProjectId: params.projectManagerProjectId,
      ...(projectManagedStart ? {
        projectRuntimeGeneration: Math.max(0, ...previousLanes.filter((lane) => (
          lane.projectManagerProjectId === params.projectManagerProjectId
          && lane.surfaceId === candidate.surfaceId
        )).map((lane) => Math.max(0, Math.trunc(lane.projectRuntimeGeneration || 0)))) + 1,
      } : {}),
      label: candidate.label,
      surfaceId: candidate.surfaceId,
      supervisorSurfaceId,
      ...(projectManagedStart ? { supervisorBriefingStatus: 'pending' as const } : {}),
      paneId: candidate.paneId,
      workspaceId: candidate.workspaceId,
      workspaceTitle: candidate.workspaceTitle,
      remoteSshControl: candidate.remoteSshControl,
      projectDir: candidate.projectDir,
      scopeRoot: candidate.projectDir,
      config: {
        taskGoal: params.taskGoal || '',
        taskDescription: params.taskDescription || '',
        preconditions: params.preconditions || '',
        supervisorNotes: params.supervisorNotes || '',
        stopWhen: params.stopWhen,
        stopWhenKind: params.stopWhenKind,
        planFilePath: params.planFile || '',
        waitForNextDirection: params.waitForNextDirection === true,
        taskWorkMode: normalizeTaskWorkMode(params.taskWorkMode),
        mainThreadResponsibility: normalizeTaskThreadResponsibility(params.mainThreadResponsibility),
        childThreadResponsibilities: normalizeTaskChildThreadResponsibilities(params.childThreadResponsibilities),
        maxChildThreads: normalizeTaskMaxChildThreads(params.maxChildThreads),
        supervisorMayApproveThreads: params.supervisorMayApproveThreads === true,
        parallelizableOperations: normalizeTaskOperationBoundaries(params.parallelizableOperations),
        serializedOperations: normalizeTaskOperationBoundaries(params.serializedOperations),
        planRevision: 1,
      },
      supervisorLaunchCmdOverride: launchCmd,
      supervisorModelOverride: supervisorModel,
      supervisorReasoningEffortOverride: supervisorReasoningEffort,
      ...(projectManagedStart ? { submitEnterOverride: true } : {}),
      autonomousOverride: retainedSession || projectManagedStart ? params.autonomous : undefined,
      ...(projectManagedStart ? {
        autonomyPermissionsOverride: [...selectedAutonomyPermissions(params.autonomyPermissions)],
        workScopeOverride: DEFAULT_SUPERVISOR_WORK_SCOPE,
        forbiddenActionsOverride: [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS],
      } : {}),
      controlState: 'active',
      awaitingStopCheck: false, stopConfirmed: false,
      awaitingReview: false, autoDecisionLimitReached: false, autoDecisionsUsed: 0,
      pendingSupervisorDeliveries: [], currentTask: '', decisions: [],
      ...(!projectManagedStart ? {
        pendingInitialReview: remoteTerminalActivity(candidate.surfaceId, true).activityState === 'working',
      } : {}),
      ordinaryPlanRequired: !projectManagedStart,
    }, supervisorSurfaceId);
    return retainedSession || projectManagedStart
      ? {
          ...lane,
          awaitingReview: projectManagedStart
            ? !!lane.projectWorkItemId
            : lane.pendingInitialReview === true ? false : true,
        }
      : lane;
  });
  if (lanes.some((lane) => !lane.supervisorSurfaceId)) {
    for (const lane of lanes) {
      if (!lane.supervisorSurfaceId) continue;
      const location = remoteTerminalList().find((terminal) => terminal.surfaceId === lane.supervisorSurfaceId);
      if (location) store.closeSurface(location.workspaceId, location.paneId, lane.supervisorSurfaceId);
    }
    for (const statusSurface of createdOrdinaryStatusSurfaces) {
      store.closeSurface(statusSurface.workspaceId, statusSurface.paneId, statusSurface.surfaceId);
    }
    return { ok: false, error: '无法为所有终端创建专属监督 AI。', message: '' };
  }
  if (projectManagedStart && displacedOrdinaryLanes.length > 0) {
    for (const lane of displacedOrdinaryLanes) {
      remoteAudit(store.supervisor, lane, 'session.abandoned', {
        reason: '任务终端已由项目模式接管，普通监督绑定自动释放',
        actor: params.actor || 'project-control-plane',
      });
      removeOrdinarySupervisorStatusSurfaceForTask(lane.surfaceId);
    }
    closeStoppedSupervisorSurfaces(displacedOrdinaryLanes);
  }
  if (projectManagedStart && projectControlSurfaceId) {
    const refreshedWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === supervisorWorkspace!.id);
    const controlIndex = refreshedWorkspace
      ? findLeaf(refreshedWorkspace.splitTree, targetPaneId!)?.surfaces.findIndex((surface) => surface.id === projectControlSurfaceId) ?? -1
      : -1;
    if (controlIndex >= 0) store.selectSurface(supervisorWorkspace!.id, targetPaneId!, controlIndex);
    if (previousActiveWorkspaceId && previousActiveWorkspaceId !== supervisorWorkspace!.id) {
      store.selectWorkspace(previousActiveWorkspaceId);
    }
  }
  if (!retainedSession && previousLanes.length > 0) {
    for (const lane of previousLanes) {
      remoteAudit(store.supervisor, lane, 'session.abandoned', { reason: '飞书启动新的监督会话', actor: params.actor || 'unknown' });
    }
    closeStoppedSupervisorSurfaces(previousLanes);
  }
  if (retainedSession) {
    const recoverySnapshotId = params.actor === 'desktop-snapshot-restore'
      ? String(params.recoverySnapshotId || '').trim()
      : '';
    const supersededStoppedLanes = previousLanes.filter((lane) => (
      shouldSupersedeStoppedSupervisorLane(lane, selectedIds, recoverySnapshotId)
    ));
    for (const lane of supersededStoppedLanes) {
      remoteAudit(store.supervisor, lane, 'session.abandoned', {
        reason: '飞书在当前会话中重新添加此终端', actor: params.actor || 'unknown',
      });
    }
    closeStoppedSupervisorSurfaces(supersededStoppedLanes);
    const retainedLanes = previousLanes.filter((lane) => !supersededStoppedLanes.includes(lane));
    if (projectManagedStart) {
      store.setProjectSupervisorLanes([
        ...retainedLanes.filter(isProjectManagedSupervisorLane),
        ...lanes,
      ]);
    } else {
      store.setOrdinarySupervisorLanes([
        ...retainedLanes.filter((lane) => !isProjectManagedSupervisorLane(lane)),
        ...lanes,
      ]);
    }
    const session = useStore.getState().supervisor;
    for (const lane of lanes) {
      remoteAudit(session, lane, 'supervisor.remote-command', {
        action: 'add', terminals: [lane.surfaceId], autonomous: params.autonomous, actor: params.actor || 'unknown',
      });
    }
    for (const lane of lanes) void deliverSupervisorStartupBriefing(lane.id);
    return { ok: true, message: `已添加 AI 监督终端，正在等待运行时就绪：${lanes.map((lane) => `${lane.label} (${lane.surfaceId})`).join('、')}` };
  }
  if (!projectManagedStart) {
    store.patchSupervisor({
      supervisorLaunchCmd: launchCmd, supervisorModel, supervisorReasoningEffort,
      maxAutoDecisions: params.autonomous ? null : store.supervisor.maxAutoDecisions, autonomous: params.autonomous,
      autonomyPermissions: [...DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS],
      workScope: DEFAULT_SUPERVISOR_WORK_SCOPE,
      forbiddenActions: [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS],
    });
  }
  if (projectManagedStart) {
    store.setProjectSupervisorLanes(lanes);
    store.startProjectSupervisor(lanes.map((lane) => lane.id));
  } else {
    store.setOrdinarySupervisorLanes(lanes);
    store.startOrdinarySupervisor();
  }
  const session = useStore.getState().supervisor;
  for (const lane of lanes) remoteAudit(session, lane, 'supervisor.remote-command', { action: previousLanes.length > 0 ? 'restart' : 'start', terminals: params.terminals, autonomous: params.autonomous, actor: params.actor || 'unknown' });
  for (const lane of lanes) void deliverSupervisorStartupBriefing(lane.id);
  return { ok: true, message: `已创建 AI 监督，正在等待运行时就绪：${lanes.map((lane) => `${lane.label} (${lane.surfaceId})`).join('、')}` };
}

function sendRemoteTerminalTask(params: RemoteTerminalTask): RemoteTerminalTaskResult {
  const projectMode = params.mode === 'project';
  if (params.mode !== undefined && !projectMode) {
    return { ok: false, error: '终端发送模式无效。', message: '' };
  }
  const located = projectMode
    ? locateRemoteProjectTerminal(params.terminal)
    : locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可发送任务。', message: '' };
  if (!projectMode && (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId)) {
    return { ok: false, error: '项目任务终端只能由对应的项目监督 AI 投递任务。', message: '' };
  }
  const task = params.task.trim();
  if (!task) return { ok: false, error: '任务内容不能为空。', message: '' };

  const activity = remoteTerminalActivity(terminal.surfaceId);
  if (activity.activityState === 'working' && params.force !== true) {
    return {
      ok: false,
      error: `${terminal.label} 正在执行任务，需要确认后才能继续发送。`,
      message: '',
      code: 'terminal_busy',
      terminal: {
        surfaceId: terminal.surfaceId,
        label: terminal.label,
        workspace: terminal.workspaceTitle,
        ...activity,
      },
    };
  }

  try {
    sendTaskToSurface(terminal.surfaceId, task, true, projectMode ? 'project' : 'ordinary');
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err), message: '' };
  }
  handleSupervisorUserSubmit(terminal.surfaceId, task);
  const session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => (
    item.surfaceId === terminal.surfaceId
    || (projectMode && dedicatedSupervisorSurfaceId(item) === terminal.surfaceId)
  ));
  remoteAudit(session, lane, 'supervisor.remote-command', {
    action: projectMode ? 'send-project-terminal-content' : 'send-task',
    terminal: terminal.surfaceId,
    actor: params.actor || 'unknown',
    task,
  });
  const projectTaskDirect = projectMode
    && 'role' in terminal
    && terminal.role === 'task-ai'
    && !!lane
    && isProjectManagedSupervisorLane(lane);
  return { ok: true, message: projectTaskDirect
    ? `已向 ${terminal.label} 提交用户任务；任务 Agent 确认接收后将同步专属监督 AI。`
    : `已向 ${terminal.label} 提交任务；等待任务 Agent 生命周期确认。` };
}

function sendRemoteTerminalEscape(params: RemoteTerminalEscape): { ok: boolean; message: string; error?: string } {
  const projectMode = params.mode === 'project';
  if (params.mode !== undefined && !projectMode) {
    return { ok: false, error: '终端中断模式无效。', message: '' };
  }
  const located = projectMode
    ? locateRemoteProjectTerminal(params.terminal)
    : locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可中断。', message: '' };
  if (!projectMode && (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId)) {
    return { ok: false, error: '项目任务终端只能由项目管理模式处理中断。', message: '' };
  }
  try {
    sendToSurface(terminal.surfaceId, '\x1b', false, projectMode ? 'project' : 'ordinary');
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err), message: '' };
  }
  const session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => (
    item.surfaceId === terminal.surfaceId
    || (projectMode && dedicatedSupervisorSurfaceId(item) === terminal.surfaceId)
  ));
  remoteAudit(session, lane, 'supervisor.remote-command', {
    action: projectMode ? 'send-project-terminal-escape' : 'send-escape',
    terminal: terminal.surfaceId,
    actor: params.actor || 'unknown',
  });
  return { ok: true, message: `已向 ${terminal.label} 发送 Esc 中断请求。` };
}

function sendRemoteTerminalInterrupt(params: RemoteTerminalInterrupt): { ok: boolean; message: string; error?: string } {
  const projectMode = params.mode === 'project';
  if (params.mode !== undefined && !projectMode) {
    return { ok: false, error: '终端中断模式无效。', message: '' };
  }
  const located = projectMode
    ? locateRemoteProjectTerminal(params.terminal)
    : locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可中断。', message: '' };
  if (!projectMode && (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId)) {
    return { ok: false, error: '项目任务终端只能由项目管理模式处理中断。', message: '' };
  }
  try {
    sendToSurface(terminal.surfaceId, '\x03', false, projectMode ? 'project' : 'ordinary');
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err), message: '' };
  }
  const session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => (
    item.surfaceId === terminal.surfaceId
    || (projectMode && dedicatedSupervisorSurfaceId(item) === terminal.surfaceId)
  ));
  remoteAudit(session, lane, 'supervisor.remote-command', {
    action: projectMode ? 'send-project-terminal-ctrl-c' : 'send-ctrl-c',
    terminal: terminal.surfaceId,
    actor: params.actor || 'unknown',
  });
  return { ok: true, message: `已向 ${terminal.label} 发送 Ctrl+C 中断请求。` };
}

function closeRemoteTerminal(params: { terminal: string; actor?: string }): { ok: boolean; message: string; error?: string } {
  const located = locateRemoteTaskTerminal(params.terminal);
  const terminal = located.terminal;
  if (!terminal) return { ok: false, error: located.error || '终端不存在或不可关闭。', message: '' };
  if (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId) {
    return { ok: false, error: '项目任务终端只能由项目管理模式关闭。', message: '' };
  }

  const store = useStore.getState();
  const session = store.supervisor;
  const lane = session.lanes.find((item) => item.surfaceId === terminal.surfaceId);
  const laneWasSupervised = !!lane && supervisorLaneControlState(lane) !== 'stopped';
  if (lane) {
    remoteAudit(session, lane, 'supervisor.remote-command', {
      action: 'close-terminal',
      terminal: terminal.surfaceId,
      actor: params.actor || 'unknown',
    });
    if (laneWasSupervised) {
      store.stopSupervisorLane(lane.id, `由飞书关闭任务终端 ${lane.label} 并解除监督绑定`);
    } else {
      store.setOrdinarySupervisorLanes(
        store.supervisor.lanes.filter((item) => !isProjectManagedSupervisorLane(item) && item.id !== lane.id),
      );
    }
    closeStoppedSupervisorSurfaces([lane]);
  }

  // Reuse the store's PTY reaping and last-tab workspace cleanup path.
  store.closeSurface(terminal.workspaceId, terminal.paneId, terminal.surfaceId);
  return {
    ok: true,
    message: laneWasSupervised
      ? `已关闭 ${terminal.label}，并停止对应 AI 监督通道。任务目录和审计记录均已保留。`
      : `已关闭 ${terminal.label}。任务目录和审计记录均已保留。`,
  };
}

function sendRemoteSupervisorMessage(params: RemoteSupervisorMessage): { ok: boolean; message: string; error?: string } {
  let session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => item.surfaceId === params.terminal || item.managementSessionId === params.terminal);
  if (lane && isProjectManagedSupervisorLane(lane)) {
    return { ok: false, error: '该通道属于项目管理模式，只能由对应的项目管理 AI 调整方向。', message: '' };
  }
  if (!session.active || !lane || (supervisorLaneControlState(lane) !== 'active'
    && supervisorLaneControlState(lane) !== 'waiting')) {
    return { ok: false, error: '目标 AI 监督终端（管家）当前未运行；请先启动或恢复该监督。', message: '' };
  }
  const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
  if (!supervisorSurfaceId || !hasLiveSurface(supervisorSurfaceId)) {
    return { ok: false, error: `${lane.label} 的 AI 监督终端（管家）已缺失；请在 wmux 中重新配置。`, message: '' };
  }
  const message = params.message.trim();
  if (!message) return { ok: false, error: '监督方向信息不能为空。', message: '' };
  try {
    sendTaskToSurface(
      supervisorSurfaceId,
      `[用户调整监督方向]\n${message}`,
      true,
      'ordinary',
    );
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err), message: '' };
  }
  if (supervisorLaneControlState(lane) === 'waiting') {
    resumeWaitingLaneFromSupervisorInput(session, lane, 'remote-supervisor-message');
    session = useStore.getState().supervisor;
  }
  remoteAudit(session, lane, 'supervisor.remote-command', {
    action: 'send-supervisor-message',
    actor: params.actor || 'unknown',
    message,
  });
  useStore.getState().appendSupervisorLog(
    lane.id,
    '用户调整监督方向',
    message,
  );
  return {
    ok: true,
    message: `已向 AI 监督终端（管家）“${lane.label}”发送监督方向信息。`,
  };
}

function decideRemoteWaiting(params: RemoteWaitingDecision): { ok: boolean; message: string; error?: string } {
  const session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => item.surfaceId === params.terminal || item.managementSessionId === params.terminal);
  if (lane && isProjectManagedSupervisorLane(lane)) {
    return { ok: false, error: '该通道属于项目管理模式，只能由对应的项目管理 AI 处理待续。', message: '' };
  }
  if (!lane || supervisorLaneControlState(lane) !== 'waiting') {
    return { ok: false, error: '该 AI 监督通道已不处于待续状态，请刷新后查看当前状态。', message: '' };
  }
  if (params.decision === 'keep') {
    return { ok: true, message: `${lane.label} 保持待续；之后仍可从原卡片提交新方案或恢复监督。` };
  }
  if (params.decision === 'stop') {
    remoteAudit(session, lane, 'supervisor.remote-command', {
      action: 'waiting-stop',
      actor: params.actor || 'unknown',
    });
    closeStoppedSupervisorSurfaces([lane]);
    useStore.getState().stopSupervisorLane(lane.id, `由飞书停止待续通道 ${lane.label} 并解除终端绑定`);
    return { ok: true, message: `已停止 ${lane.label} 的 AI 监督并解除终端绑定；其他通道不受影响。` };
  }
  if (!session.active) {
    return {
      ok: false,
      error: session.paused
        ? '当前监督会话处于全局暂停；请先继续全部监督，再恢复此待续通道。'
        : '当前监督会话已停止，不能恢复该待续通道。',
      message: '',
    };
  }
  const message = params.decision === 'resume'
    ? '按原任务目标和既有停止条件继续监督；先读取任务终端最新状态，再继续推进。'
    : String(params.message || '').trim();
  if (!message) return { ok: false, error: '新方案或下一步方向不能为空。', message: '' };
  const result = sendRemoteSupervisorMessage({
    action: 'send-supervisor-message',
    terminal: params.terminal,
    message,
    actor: params.actor,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    message: params.decision === 'resume'
      ? `已按原目标恢复 ${lane.label} 的 AI 监督。`
      : `已将新方案发送给 ${lane.label} 的 AI 监督终端，并恢复监督。`,
  };
}

function decideRemoteSupervisor(
  approvalId: string,
  decision: 'approve' | 'direct' | 'pause' | 'stop',
  selection?: string,
  task?: string,
  actor?: string,
): { ok: boolean; message: string; error?: string } {
  const store = useStore.getState();
  const session = store.supervisor;
  const approval = session.pendingApprovals.find((item) => item.id === approvalId);
  if (!approval) return { ok: false, error: '该待决项不存在、已过期或已处理。', message: '' };
  if (approval.source !== 'supervisor-route' && approval.source !== 'supervisor-important') {
    store.cancelPending(approvalId, '待决项协议无效');
    return { ok: false, error: '待决项协议无效，已取消且不会投递。', message: '' };
  }
  const approvalLane = session.lanes.find((item) => item.id === approval.laneId);
  if (approvalLane && isProjectManagedSupervisorLane(approvalLane)) {
    return { ok: false, error: '项目监督不使用普通待决项；请由项目 AI 处理结构化监督交接。', message: '' };
  }
  const decisionOwnerLabel = '用户';
  let ownerDecisionQueued = false;
  if (Date.now() - approval.createdAt > 24 * 60 * 60 * 1000) {
    store.cancelPending(approvalId, '待决项超过 24 小时，已解除旧等待状态');
    if (approvalLane) {
      store.updateLane(approvalLane.id, {
        awaitingReview: false,
        autoDecisionLimitReached: false,
        resumeAfterCancelledDecision: false,
      });
      const supervisorSurfaceId = dedicatedSupervisorSurfaceId(approvalLane);
      if (supervisorSurfaceId) {
        queueSupervisorControlMessage(approvalLane, [
          '[待决项已过期｜重新核对]',
          `原待决 ID：${approvalId}`,
          '旧待决项已解除。请重新读取任务终端当前状态和最新项目约束；能够在既有授权内继续时提交新的 continue/rework，需要上级决定时重新提交 needs-human。不得继续等待旧待决项。',
        ].join('\n'));
      }
    }
    return {
      ok: false,
      error: '该待决项已超过 24 小时，旧等待状态已解除；专属监督必须按最新证据重新提案。',
      message: '',
    };
  }
  if (decision === 'pause') {
    if (!session.active) return { ok: false, error: '当前监督会话已停止，不能暂停旧待决项。', message: '' };
    const lane = session.lanes.find((item) => item.id === approval.laneId);
    if (!lane) return { ok: false, error: '待决项对应的监督通道不存在。', message: '' };
    if (supervisorLaneControlState(lane) === 'paused') return { ok: true, message: `${lane.label} 已经暂停，待决项仍保留。` };
    store.pauseSupervisorLane(lane.id, `${decisionOwnerLabel}暂停待决项：${approval.laneLabel}；该通道决策内容已保留`);
    remoteAudit(session, lane, 'supervisor.remote-decision', { approvalId, decision, actor: actor || 'unknown' });
    return { ok: true, message: `${decisionOwnerLabel}已暂停 ${lane.label} 的 AI 监督；其他监督通道继续运行。` };
  }
  const lane = session.lanes.find((item) => item.id === approval.laneId);
  if (decision === 'stop') {
    if (!session.active && !session.paused) return { ok: false, error: '当前监督会话已停止，不能处理旧待决项。', message: '' };
    store.rejectPending(approvalId);
    remoteAudit(session, lane, 'supervisor.remote-decision', { approvalId, decision, actor: actor || 'unknown' });
    if (lane) {
      closeStoppedSupervisorSurfaces([lane]);
      store.stopSupervisorLane(lane.id, `${decisionOwnerLabel}停止 ${lane.label} 并解除终端绑定`);
    }
    return { ok: true, message: lane
      ? `已停止 ${lane.label} 的 AI 监督并解除终端绑定；可重新选择该终端启动监督，其他通道不受影响。`
      : '待决项对应通道不存在，已移除该待决项。' };
  }
  if (session.paused) return { ok: false, error: '当前监督会话已暂停；请先在 wmux 中继续会话。', message: '' };
  if (!session.active) return { ok: false, error: '当前监督会话已停止，不能处理旧待决项。', message: '' };
  if (!lane) return { ok: false, error: '待决项对应的监督通道不存在。', message: '' };
  let laneState = supervisorLaneControlState(lane);
  if (laneState !== 'active') {
    const stateLabel = laneState === 'paused' ? '已暂停' : laneState === 'waiting' ? '正在待续' : '已停止';
    return {
      ok: false,
      error: `目标监督通道${stateLabel}；请先恢复该项目的专属监督，再处理待决项。`,
      message: '',
    };
  }
  const decisionInput = task?.trim().slice(0, 4000) || '';
  const clarification = approval.proposalKind === 'clarification';
  if (clarification && decision === 'approve' && !decisionInput) {
    return { ok: false, error: '请按问题编号集中填写需求对齐答复；如果明确接受全部推荐，可以填写“全部按推荐答案”，控制层不会因留空而自动采用默认值。', message: '' };
  }
  if (decision === 'direct') {
    const directTask = decisionInput;
    if (!directTask) return { ok: false, error: '请填写要交给 AI 监督整理的用户决策信息。', message: '' };
  }
  const laneSupervisorSurfaceId = lane ? dedicatedSupervisorSurfaceId(lane) : null;
  if (!laneSupervisorSurfaceId) {
    return { ok: false, error: '待决项对应的 AI 监督已不存在，无法整理所选方案。', message: '' };
  }
  const rawSelection = selection?.trim().replace(/^用户选择\s*/u, '').slice(0, 200) || '';
  const selectedNone = rawSelection === SUPERVISOR_NO_DECISION_OPTION;
  const selectedOption = selectedNone ? '' : rawSelection;
  const parsedOptions = supervisorDecisionOptions(approval.alternatives, approval.text);
  const offeredOptions = new Set(parsedOptions.length >= 2
    ? parsedOptions.map((option) => option.value)
    : []);
  const recommendedOptionValue = approval.recommendedOption
    || supervisorRecommendedOptionValue(parsedOptions, approval.text);
  const recommendedOption = parsedOptions.find((option) => option.value === recommendedOptionValue);
  const requiresOptionSelection = decision === 'approve' && !clarification;
  // “采用 AI 推荐”本身就是明确选择；只有用户改选其他方案时才要求 option value。
  if (requiresOptionSelection
    && offeredOptions.size >= 2
    && !selectedOption
    && !selectedNone
    && !recommendedOption) {
    return { ok: false, error: 'AI 监督提供了多个方案但没有可识别的推荐项，请先选择其中一个方案。', message: '' };
  }
  if (requiresOptionSelection && selectedNone && !decisionInput) {
    return { ok: false, error: '选择“无”时，请填写用户决策或补充信息。', message: '' };
  }
  if (requiresOptionSelection && selectedOption && !offeredOptions.has(selectedOption)) {
    return { ok: false, error: '所选方案不属于 AI 监督当前提供的备选项，请刷新决策卡后重试。', message: '' };
  }
  if (decision === 'approve' || decision === 'direct') {
    const adoptedRecommendation = decision === 'approve'
      && !selectedNone
      && !!recommendedOption
      && (!selectedOption || selectedOption === recommendedOption.value);
    const chosenPlan = decision === 'approve'
      ? selectedNone
        ? ''
        : selectedOption
          || (recommendedOption ? `${recommendedOption.value}：${recommendedOption.detail}` : approval.text.trim())
      : '';
    const originalSuggestion = approval.text.trim();
    const briefing = [
      clarification
        ? '[需求对齐答复] 用户已集中回答普通监督提出的实质歧义问题。'
        : decisionInput
          ? chosenPlan
            ? '[人工决定] 用户已采用 AI 监督提出的方案，并提供了补充决策信息。'
            : '[人工决定] 用户提供了人工决策信息，请由 AI 监督整理处理。'
          : '[人工决定] 用户已选择采用 AI 监督提出的方案。',
      chosenPlan ? `[${decisionOwnerLabel}选择] ${chosenPlan}` : '',
      decisionInput ? `[${decisionOwnerLabel}补充信息] ${decisionInput}` : '',
      originalSuggestion && originalSuggestion !== chosenPlan && !adoptedRecommendation
        ? `[AI 原建议] ${originalSuggestion}`
        : '',
      approval.reason?.trim() ? `[原判断依据] ${approval.reason.trim()}` : '',
      approval.impact?.trim() ? `[影响] ${approval.impact.trim()}` : '',
      approval.alternatives?.trim() ? `[AI 备选方案] ${approval.alternatives.trim()}` : '',
      '',
      clarification
        ? '先根据整组答复完成需求对齐；仍有会实质改变方向、范围或验收的歧义时，可再提出一批必要问题，但不得重复询问已经回答的内容。'
        : `请先 read-screen 获取任务终端最新状态，再基于${decisionOwnerLabel}决定、当前任务、计划约束和终端证据，整理成完整、明确、可执行的下一步。`,
      clarification
        ? `对齐充分后，创建成果计划 JSON 和第一项成果任务 JSON，并使用 wmux supervisor decide --surface ${approval.surfaceId} --outcome continue 或 rework --stage-plan-file <计划文件> --task-file <任务文件>；计划形成前不得向任务 AI 投递。`
        : `整理完成后，把当前成果、约束、本次任务级验收和必要现状写入 .wmux/tmp/<唯一文件名>.json，并使用 wmux supervisor decide --surface ${approval.surfaceId} --outcome continue 或 rework --task-file <文件>。不得把完整用户规划、用户总停止条件、本消息、实现路线、指定文件、命令或技能发送到任务终端。`,
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
    const delivery: SupervisorDelivery = {
      id: `owner-decision-${approvalId}`,
      kind: 'owner-decision',
      task: lane.currentTask || approval.task || lane.label,
      text: briefing,
      createdAt: Date.now(),
      turnId: lane.workerTurnId,
      correlationId: approvalId,
      stage: 'pending',
    };
    store.updateLane(lane.id, {
      pendingSupervisorDeliveries: enqueueSupervisorDelivery(
        lane.pendingSupervisorDeliveries,
        delivery,
      ),
    });
    appendSupervisorRecord(session, lane, 'supervisor.delivery.queued', {
      kind: delivery.kind,
      task: delivery.task,
      approvalId,
    });
    ownerDecisionQueued = true;
  }
  store.approvePending(approvalId);
  if (lane && (
    approval.source === 'supervisor-route'
    || approval.source === 'supervisor-important'
  )) {
    store.updateLane(lane.id, {
      awaitingReview: true,
      autoDecisionLimitReached: false,
      autoDecisionsUsed: 0,
    });
    remoteAudit(session, lane, 'supervisor.proposal.resolved', {
      approvalId,
      resolution: 'approved',
      proposalKind: approval.proposalKind || 'important',
      text: selectedNone
        ? `${decisionOwnerLabel}未采用 AI 方案，已提供补充决策信息`
        : selectedOption || approval.text || (decisionInput ? `${decisionOwnerLabel}提供补充决策信息` : '采用 AI 监督当前建议'),
    });
  }
  remoteAudit(session, lane, 'supervisor.remote-decision', {
    approvalId,
    decision,
    actor: actor || 'unknown',
    selection: selectedOption || undefined,
    inputLength: decision === 'approve' || decision === 'direct' ? decisionInput.length || undefined : undefined,
  });
  if (ownerDecisionQueued) signalSupervisorDeliveryReady();
  const hasUserInput = (decision === 'approve' || decision === 'direct') && !!decisionInput;
  return { ok: true, message: selectedOption
    ? `已选择 ${selectedOption}${hasUserInput ? '并附加用户补充信息' : ''}；AI 监督将整理后发送到任务终端。`
    : hasUserInput
      ? '已将用户决策信息交给 AI 监督；AI 监督将整理后发送到任务终端。'
      : '已采用 AI 监督当前方案；AI 监督将整理后发送到任务终端。' };
}

function acknowledgeDeliveredOwnerDecisionTransitions(
  projectId: string,
  lane: SupervisorLane,
  delivery: SupervisorDelivery,
): ProjectSupervisorTransition[] {
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === projectId);
  if (!current) return [];
  const acknowledged = (current.pendingSupervisorTransitions || []).filter((transition) => (
    transition.kind === 'decision-required'
    && transition.laneId === lane.id
    && transition.workItemId === lane.projectWorkItemId
    && transition.createdAt <= delivery.createdAt
  ));
  if (acknowledged.length === 0) return [];
  const ids = new Set(acknowledged.map((transition) => transition.id));
  for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
    const pending = pendingProjectManagerDeliveries[index];
    if (pending.sessionId === projectId && pending.transitionId && ids.has(pending.transitionId)) {
      pendingProjectManagerDeliveries.splice(index, 1);
    }
  }
  replaceProjectManagerSession({
    ...current,
    pendingSupervisorTransitions: (current.pendingSupervisorTransitions || [])
      .filter((transition) => !ids.has(transition.id)),
    pendingManagerDeliveries: (current.pendingManagerDeliveries || [])
      .filter((pending) => !pending.transitionId || !ids.has(pending.transitionId)),
    updatedAt: Date.now(),
  });
  return acknowledged;
}

function reconcileSatisfiedProjectBindingRecoveryTransitions(
  projectId: string,
  options: { persist?: boolean } = {},
): ProjectManagerSession | undefined {
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === projectId);
  if (!current) return undefined;
  const resolved: Array<{
    transition: ProjectSupervisorTransition;
    laneId: string;
    assignmentVersion: number;
  }> = [];
  for (const transition of current.pendingSupervisorTransitions || []) {
    if (transition.kind !== 'project-action-required'
      || transition.eventType !== 'supervisor.project-binding-recovery'
      || !transition.workItemId) continue;
    const item = current.workItems.find((candidate) => candidate.id === transition.workItemId);
    if (!item || typeof item.assignmentVersion !== 'number' || !item.supervisorLaneId) continue;
    const assignment = [...current.events].reverse().find((event) => (
      event.kind === 'supervisor-status'
      && event.workItemId === transition.workItemId
      && event.ts > transition.createdAt
      && event.payload?.laneId === item.supervisorLaneId
      && event.payload?.assignmentVersion === item.assignmentVersion
    ));
    if (!assignment) continue;
    resolved.push({
      transition,
      laneId: item.supervisorLaneId,
      assignmentVersion: item.assignmentVersion,
    });
  }
  if (resolved.length === 0) return current;

  const resolvedIds = new Set(resolved.map(({ transition }) => transition.id));
  for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
    const pending = pendingProjectManagerDeliveries[index];
    if (pending.sessionId === projectId && pending.transitionId && resolvedIds.has(pending.transitionId)) {
      pendingProjectManagerDeliveries.splice(index, 1);
    }
  }
  replaceProjectManagerSession({
    ...current,
    pendingSupervisorTransitions: (current.pendingSupervisorTransitions || [])
      .filter((transition) => !resolvedIds.has(transition.id)),
    pendingManagerDeliveries: (current.pendingManagerDeliveries || [])
      .filter((pending) => !pending.transitionId || !resolvedIds.has(pending.transitionId)),
    updatedAt: Date.now(),
  });
  const store = useStore.getState();
  for (const { transition, laneId, assignmentVersion } of resolved) {
    store.appendProjectManagerEvent({
      kind: 'supervisor-transition-acknowledged',
      workItemId: transition.workItemId,
      summary: '新的专属监督绑定已建立；控制层自动关闭对应恢复交接',
      payload: {
        transitionId: transition.id,
        laneId,
        transitionKind: transition.kind,
        resolution: 'recovered',
        automatic: true,
        assignmentVersion,
      },
    }, projectId);
  }
  if (options.persist) saveProjectManagerSnapshot(projectId);
  return useStore.getState().projectManagers.find((candidate) => candidate.id === projectId);
}

function finalizeProjectRuntimeRecoveryAfterAssignment(
  projectId: string,
  reason: string,
): ProjectManagerSession | undefined {
  const store = useStore.getState();
  const current = store.projectManagers.find((candidate) => candidate.id === projectId);
  if (!current
    || (current.recoveryState !== 'checking' && current.safeExit?.status !== 'restoring')
    || current.progressSync?.status !== 'ready'
    || !projectOrientationReady(current)) return current;
  const item = current.workItems.find((candidate) => candidate.id === current.activeWorkItemId);
  const lane = item?.supervisorLaneId
    ? store.supervisor.lanes.find((candidate) => (
        candidate.id === item.supervisorLaneId
        && candidate.projectManagerProjectId === current.id
        && candidate.projectWorkItemId === item.id
        && supervisorLaneControlState(candidate) === 'active'
      ))
    : undefined;
  if (!item?.workerSurfaceId
    || !['running', 'waiting-decision', 'validating'].includes(item.status)
    || typeof item.assignmentVersion !== 'number'
    || !lane
    || lane.surfaceId !== item.workerSurfaceId
    || lane.projectAssignmentVersion !== item.assignmentVersion) return current;
  const now = Date.now();
  replaceProjectManagerSession({
    ...current,
    recoveryState: 'ready',
    safeExit: current.safeExit?.status === 'restoring' ? undefined : current.safeExit,
    updatedAt: now,
  });
  store.appendProjectManagerEvent({
    kind: 'recovery-restored',
    workItemId: item.id,
    summary: '项目运行链已恢复并重新建立有效的项目 AI、监督 AI 与任务 AI 责任绑定',
    payload: {
      recoverySource: 'active-assignment',
      phase: 'runtime-chain-ready',
      reason,
      laneId: lane.id,
      surfaceId: lane.surfaceId,
      assignmentVersion: item.assignmentVersion,
      attentionRequired: false,
    },
  }, current.id);
  saveProjectManagerSnapshot(current.id);
  return useStore.getState().projectManagers.find((candidate) => candidate.id === current.id);
}

const PROJECT_RESPONSIBILITY_DEADLINE_MS = 2 * 60_000;

function projectResponsibilityIdentity(
  session: ProjectManagerSession,
  owner: ProjectExecutionResponsibility['owner'],
  action: string,
  workItemId?: string,
  transitionId?: string,
): string {
  return [
    session.id,
    projectRequirementsVersion(session),
    projectAuthorizationVersion(session),
    owner,
    action,
    workItemId || 'project',
    transitionId || 'none',
  ].join(':');
}

function deriveProjectExecutionResponsibility(
  session: ProjectManagerSession,
  now = Date.now(),
): ProjectExecutionResponsibility | undefined {
  if (['completed', 'stopped'].includes(session.status)) return undefined;
  if (session.pendingUserQuestion) {
    const action = 'answer-user-question';
    const id = projectResponsibilityIdentity(
      session,
      'user',
      action,
      session.pendingUserQuestion.workItemId,
      session.pendingUserQuestion.id,
    );
    return {
      id,
      owner: 'user',
      action,
      state: 'blocked',
      ...(session.pendingUserQuestion.workItemId ? { workItemId: session.pendingUserQuestion.workItemId } : {}),
      transitionId: session.pendingUserQuestion.id,
      assignedAt: session.pendingUserQuestion.createdAt,
      lastProgressAt: session.pendingUserQuestion.createdAt,
      attempt: 0,
      incidentKey: id,
    };
  }
  if (session.status === 'paused') return undefined;

  const transition = nextProjectSupervisorTransition(session);
  if (transition) {
    const action = 'handle-supervisor-transition';
    const id = projectResponsibilityIdentity(
      session,
      'project-ai',
      action,
      transition.workItemId,
      transition.id,
    );
    const linkedDelivery = (session.pendingManagerDeliveries || []).some((delivery) => (
      delivery.transitionId === transition.id
    )) || pendingProjectManagerDeliveries.some((delivery) => (
      delivery.sessionId === session.id && delivery.transitionId === transition.id
    ));
    const manager = projectManagerTerminal({ surfaceId: session.managerSurfaceId, projectId: session.id });
    const managerActivity = manager ? remoteTerminalActivity(manager.surfaceId, true).activityState : 'unknown';
    return {
      id,
      owner: 'project-ai',
      action,
      state: linkedDelivery ? 'queued' : managerActivity === 'working' ? 'working' : 'delivered',
      ...(transition.workItemId ? { workItemId: transition.workItemId } : {}),
      transitionId: transition.id,
      assignedAt: transition.createdAt,
      lastProgressAt: transition.notifiedAt,
      deadlineAt: transition.notifiedAt + PROJECT_RESPONSIBILITY_DEADLINE_MS,
      attempt: Math.max(0, transition.notificationCount - 1),
      incidentKey: id,
    };
  }

  const item = session.workItems.find((candidate) => candidate.id === session.activeWorkItemId);
  const lane = item?.supervisorLaneId
    ? useStore.getState().supervisor.lanes.find((candidate) => (
        candidate.id === item.supervisorLaneId
        && candidate.projectManagerProjectId === session.id
        && candidate.projectWorkItemId === item.id
        && supervisorLaneControlState(candidate) !== 'stopped'
      ))
    : undefined;
  if (lane) {
    const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
    const supervisorActivity = supervisorSurfaceId
      ? remoteTerminalActivity(supervisorSurfaceId, true).activityState
      : 'unknown';
    const taskActivity = remoteTerminalActivity(lane.surfaceId, true).activityState;
    if (taskActivity === 'working') {
      const action = 'execute-work-item';
      const id = projectResponsibilityIdentity(session, 'task-ai', action, item?.id);
      return {
        id, owner: 'task-ai', action, state: 'working', workItemId: item?.id,
        assignedAt: item?.startedAt || item?.updatedAt || now,
        lastProgressAt: item?.updatedAt || now,
        attempt: item?.attempts || 0,
        incidentKey: id,
      };
    }
    if (supervisorActivity === 'working' || (lane.pendingSupervisorDeliveries || []).length > 0) {
      const action = 'review-or-dispatch-work-item';
      const id = projectResponsibilityIdentity(session, 'supervisor-ai', action, item?.id);
      return {
        id, owner: 'supervisor-ai', action,
        state: supervisorActivity === 'working' ? 'working' : 'queued',
        workItemId: item?.id,
        assignedAt: item?.updatedAt || now,
        lastProgressAt: item?.updatedAt || now,
        attempt: 0,
        incidentKey: id,
      };
    }
  }

  const obligation = projectProgressObligation(session);
  if (obligation) {
    const owner = 'project-ai' as const;
    const id = projectResponsibilityIdentity(
      session,
      owner,
      obligation.kind,
      obligation.workItemId,
      obligation.transitionId,
    );
    const previous = session.executionResponsibility?.id === id
      ? session.executionResponsibility
      : undefined;
    const assignedAt = previous && previous.assignedAt <= now
      ? previous.assignedAt
      : now;
    const lastProgressAt = previous && previous.lastProgressAt <= now
      ? previous.lastProgressAt
      : assignedAt;
    return {
      id,
      owner,
      action: obligation.kind,
      state: 'awaiting-result',
      ...(obligation.workItemId ? { workItemId: obligation.workItemId } : {}),
      ...(obligation.transitionId ? { transitionId: obligation.transitionId } : {}),
      assignedAt,
      lastProgressAt,
      deadlineAt: assignedAt + PROJECT_RESPONSIBILITY_DEADLINE_MS,
      attempt: previous?.attempt || 0,
      incidentKey: id,
    };
  }

  if (session.status === 'active') {
    const action = 'recover-missing-responsibility';
    const id = projectResponsibilityIdentity(session, 'control-plane', action, item?.id);
    return {
      id,
      owner: 'control-plane',
      action,
      state: 'blocked',
      ...(item?.id ? { workItemId: item.id } : {}),
      assignedAt: session.executionResponsibility?.id === id
        ? session.executionResponsibility.assignedAt
        : now,
      lastProgressAt: session.executionResponsibility?.id === id
        ? session.executionResponsibility.lastProgressAt
        : now,
      deadlineAt: now,
      attempt: session.executionResponsibility?.id === id
        ? session.executionResponsibility.attempt
        : 0,
      incidentKey: id,
    };
  }
  return undefined;
}

function reconcileProjectExecutionResponsibility(
  sessionId: string,
  now = Date.now(),
  progressOwner?: ProjectExecutionResponsibility['owner'],
): ProjectManagerSession | undefined {
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!current) return undefined;
  const derived = deriveProjectExecutionResponsibility(current, now);
  const next = derived && progressOwner === derived.owner
    ? {
        ...derived,
        state: 'working' as const,
        lastProgressAt: now,
        ...(typeof derived.deadlineAt === 'number'
          ? { deadlineAt: now + PROJECT_RESPONSIBILITY_DEADLINE_MS }
          : {}),
      }
    : derived;
  const previous = current.executionResponsibility;
  const unchanged = JSON.stringify(previous || null) === JSON.stringify(next || null);
  if (unchanged) return current;
  replaceProjectManagerSession({
    ...current,
    executionResponsibility: next,
    updatedAt: now,
  });
  saveProjectManagerSnapshot(current.id);
  return useStore.getState().projectManagers.find((candidate) => candidate.id === current.id);
}

function managedRoleResponsibilityOwner(
  role: ManagedProjectAgentRole,
): ProjectExecutionResponsibility['owner'] {
  if (role === 'manager') return 'project-ai';
  if (role === 'supervisor') return 'supervisor-ai';
  return 'task-ai';
}

/** Commit project progress only after the dedicated supervisor Agent accepts the queued direction. */
export function acknowledgeSupervisorDelivery(laneId: string, delivery: SupervisorDelivery): void {
  if (delivery.projectAssignmentVersion !== undefined) {
    const lane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === laneId);
    if (lane?.projectAssignmentVersion === delivery.projectAssignmentVersion) {
      useStore.getState().updateLane(laneId, {
        projectAssignmentConfirmedVersion: delivery.projectAssignmentVersion,
      });
    }
  }
  if (delivery.kind !== 'owner-decision') return;
  const store = useStore.getState();
  const lane = store.supervisor.lanes.find((candidate) => candidate.id === laneId);
  if (!lane?.projectManagerProjectId || !lane.projectWorkItemId) return;
  const project = store.projectManagers.find((candidate) => candidate.id === lane.projectManagerProjectId);
  const item = project?.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
  if (!project || !item || ['completed', 'stopped'].includes(item.status)) return;
  // A delayed acknowledgement from a lane's previous work item must not start
  // whichever item happens to own that terminal now.
  const updated = store.applyProjectManagerAction({
    type: 'update-work-item',
    workItemId: item.id,
    patch: {
      status: 'running',
      latestBlocker: undefined,
    },
  }, project.id);
  if (!updated.ok) return;
  const acknowledgedTransitions = acknowledgeDeliveredOwnerDecisionTransitions(project.id, lane, delivery);
  store.appendProjectManagerEvent({
    kind: 'supervisor-direction',
    workItemId: item.id,
    summary: '专属 AI 监督已确认接收项目管理决定',
    payload: {
      laneId: lane.id,
      approvalId: delivery.correlationId,
      deliveryId: delivery.id,
      acknowledgedTransitionIds: acknowledgedTransitions.map((transition) => transition.id),
    },
  }, project.id);
  for (const transition of acknowledgedTransitions) {
    store.appendProjectManagerEvent({
      kind: 'supervisor-transition-acknowledged',
      workItemId: transition.workItemId,
      summary: '项目管理决定已由专属监督确认接收；控制层自动关闭对应待决交接',
      payload: {
        transitionId: transition.id,
        laneId: transition.laneId,
        transitionKind: transition.kind,
        resolution: 'continued',
        automatic: true,
        deliveryId: delivery.id,
      },
    }, project.id);
  }
  saveProjectManagerSnapshot(project.id);
  scheduleProjectProgressCheck(project.id);
}

function queueSupervisorControlMessage(
  lane: SupervisorLane,
  text: string,
  task = lane.currentTask || lane.projectWorkItemId || lane.label,
  bootstrapOnRuntimeReady = false,
  correlationId?: string,
  projectAssignmentVersion?: number,
): SupervisorDelivery {
  const store = useStore.getState();
  const current = store.supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane;
  const delivery: SupervisorDelivery = {
    id: `supervisor-control-${uuid()}`,
    kind: 'control-message',
    task,
    text,
    createdAt: Date.now(),
    turnId: current.workerTurnId,
    ...(correlationId ? { correlationId } : {}),
    ...(projectAssignmentVersion !== undefined ? { projectAssignmentVersion } : {}),
    ...(bootstrapOnRuntimeReady ? { bootstrapOnRuntimeReady: true } : {}),
    stage: 'pending',
  };
  store.updateLane(current.id, {
    pendingSupervisorDeliveries: enqueueSupervisorDelivery(
      current.pendingSupervisorDeliveries,
      delivery,
    ),
  });
  appendSupervisorRecord(store.supervisor, current, 'supervisor.delivery.queued', {
    kind: delivery.kind,
    task: delivery.task,
    deliveryId: delivery.id,
  });
  signalSupervisorDeliveryReady();
  return delivery;
}

function stopTaskInputRecoveryWatch(laneId: string, watch: TaskInputRecoveryWatch): void {
  if (taskInputRecoveryWatches.get(laneId) !== watch) return;
  if (watch.timer) globalThis.clearTimeout(watch.timer);
  taskInputRecoveryWatches.delete(laneId);
}

function clearTaskInputRecoveryWatches(): void {
  for (const [laneId, watch] of taskInputRecoveryWatches) {
    stopTaskInputRecoveryWatch(laneId, watch);
  }
}

function scheduleTaskInputRecoveryWatch(lane: SupervisorLane): void {
  const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
  if (!supervisorSurfaceId) return;
  const existing = taskInputRecoveryWatches.get(lane.id);
  if (existing
    && existing.surfaceId === lane.surfaceId
    && existing.supervisorSurfaceId === supervisorSurfaceId
    && existing.reviewId === lane.activeReviewId) {
    return;
  }
  if (existing) stopTaskInputRecoveryWatch(lane.id, existing);

  const watch: TaskInputRecoveryWatch = {
    surfaceId: lane.surfaceId,
    supervisorSurfaceId,
    reviewId: lane.activeReviewId,
    stableEmptySamples: 0,
    pollDelayMs: TASK_INPUT_RECOVERY_POLL_MS,
  };
  taskInputRecoveryWatches.set(lane.id, watch);

  const store = useStore.getState();
  const notificationText = '任务终端存在未提交输入；监督指令没有发送。提交或清空输入后，控制层会自动通知监督 AI 重新裁决。';
  const workspaceId = lane.workspaceId || store.activeWorkspaceId;
  const project = lane.projectManagerProjectId
    ? store.projectManagers.find((candidate) => candidate.id === lane.projectManagerProjectId)
    : undefined;
  const notificationTitle = project ? '项目需要你的处理' : 'AI 监督等待任务终端输入区';
  if (workspaceId) {
    store.addNotification({
      surfaceId: lane.surfaceId,
      workspaceId,
      title: notificationTitle,
      text: notificationText,
      ...notificationMetadata(project
        ? {
            owner: 'project',
            entityId: project.id,
            kind: `task-input:${lane.id}`,
            action: 'open-surface',
            projectId: project.id,
            laneId: lane.id,
            sourceLabel: projectDisplayName(project),
          }
        : {
            owner: 'supervisor',
            entityId: lane.id,
            kind: 'task-input',
            laneId: lane.id,
            sourceLabel: lane.label,
          }),
    });
  }
  fireDesktopNotification({
    surfaceId: lane.surfaceId,
    title: notificationTitle,
    text: notificationText,
  });

  const poll = () => {
    watch.timer = undefined;
    if (taskInputRecoveryWatches.get(lane.id) !== watch) return;
    const currentStore = useStore.getState();
    const currentLane = currentStore.supervisor.lanes.find((candidate) => candidate.id === lane.id);
    if (!currentLane
      || currentLane.surfaceId !== watch.surfaceId
      || dedicatedSupervisorSurfaceId(currentLane) !== watch.supervisorSurfaceId
      || supervisorLaneControlState(currentLane) !== 'active'
      || !currentLane.awaitingReview
      || currentLane.activeReviewId !== watch.reviewId) {
      stopTaskInputRecoveryWatch(lane.id, watch);
      return;
    }
    const buffer = surfaceTerminalRegistry.get(watch.surfaceId)?.buffer.active;
    if (!buffer || hasPendingTerminalInput(buffer)) {
      watch.stableEmptySamples = 0;
      watch.pollDelayMs = Math.min(
        TASK_INPUT_RECOVERY_MAX_POLL_MS,
        Math.ceil(watch.pollDelayMs * 1.5),
      );
    } else {
      watch.stableEmptySamples += 1;
      watch.pollDelayMs = TASK_INPUT_RECOVERY_POLL_MS;
    }
    if (watch.stableEmptySamples < TASK_INPUT_RECOVERY_STABLE_SAMPLES) {
      watch.timer = globalThis.setTimeout(poll, watch.pollDelayMs);
      (watch.timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      return;
    }

    stopTaskInputRecoveryWatch(lane.id, watch);
    appendSupervisorRecord(currentStore.supervisor, currentLane, 'supervisor.delivery.retry-ready', {
      kind: 'next',
      reason: 'task-terminal-input-cleared',
    });
    currentStore.appendSupervisorLog(currentLane.id, '任务终端输入区已恢复', '此前延期的监督裁决可以安全重试');
    queueSupervisorControlMessage(currentLane, [
      '[任务终端输入区已恢复为空｜重新裁决]',
      '上一条裁决中的成果任务因检测到未提交输入而没有发送；不得假设任务 AI 已经收到。',
      buildSupervisorWakeEventEnvelope(
        currentLane.surfaceId,
        currentLane.activeReviewId,
        isProjectManagedSupervisorLane(currentLane),
      ),
      '先核对任务终端最新输出。若原下一步仍然适用，重新提交一次 continue/rework；若任务已经完成或状态变化，按当前证据重新裁决。',
    ].join('\n\n'));
  };

  watch.timer = globalThis.setTimeout(poll, TASK_INPUT_RECOVERY_POLL_MS);
  (watch.timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

export function normalizedMaxAutoDecisions(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(20, parsed) : null;
}

export function reachesAutoDecisionLimit(
  lane: Pick<SupervisorLane, 'autoDecisionsUsed'>,
  maxAutoDecisions: unknown,
): boolean {
  const limit = normalizedMaxAutoDecisions(maxAutoDecisions);
  return limit !== null && (lane.autoDecisionsUsed ?? 0) + 1 >= limit;
}

/** Permission acknowledgements are audited but do not consume a judgment slot. */
export function nextSupervisorDecisionCount(current: number | undefined, permissionResponse: string): number {
  return (current ?? 0) + (permissionResponse ? 0 : 1);
}

const PROJECT_WORK_ITEM_ID = /^[A-Za-z0-9_-]{1,80}$/;
const PROJECT_WORK_ITEM_STATUSES = new Set([
  'planned', 'waiting-dependencies', 'running', 'validating', 'waiting-decision',
  'paused', 'completed', 'failed', 'stopped',
]);
const PROJECT_ESCALATION_BOUNDARIES = new Set<ProjectEscalationBoundary>([
  'contract-change', 'cross-item-coordination', 'external-blocker',
  'user-only-information', 'high-risk-action', 'budget-exhausted',
]);

export function projectContractAutonomyPermissions(
  contract: ProjectSupervisorContract,
): SupervisorAutonomyPermission[] {
  return [
    'same-route-next',
    ...(contract.authority.technicalChoices !== false ? ['technical-choice' as const] : []),
    ...(contract.authority.routeAdjustments !== false ? ['route-adjustment' as const] : []),
    ...(contract.authority.permissionConfirm !== false ? ['permission-confirm' as const] : []),
  ];
}

function projectStringArray(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[;,；]/u)
      : [];
  return entries.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100);
}

function safeProjectRelativePath(value: string): boolean {
  return !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value)
    && !/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value);
}

function projectExecutionDirectionSignature(value: unknown): string {
  const text = String(value || '').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
  if (!text) return '';
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function projectStructuredCompletionChecklist(
  workItem: ProjectWorkItem,
  value: unknown,
  verifiedEvidence?: ReadonlyMap<string, ProjectEvidenceArtifact>,
): { criteria?: ProjectCriterionVerification[]; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '当前执行协议要求通过 --completion-file 提交逐项完成核验 JSON' };
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.remainingWork)) {
    return { error: '--completion-file 必须包含 remainingWork 数组；没有剩余工作时使用 []' };
  }
  const remaining = projectStringArray(raw.remainingWork);
  if (remaining.length > 0) {
    return { error: `阶段仍有剩余工作：${remaining.join('；')}；必须继续推进或交回项目 AI 重规划` };
  }
  const criteria = new Map<string, ProjectCriterionVerification>();
  const checkGroup = (
    label: string,
    expected: readonly string[],
    input: unknown,
  ): string | null => {
    if (!Array.isArray(input) || input.length !== expected.length) {
      return `${label}必须逐项覆盖 1-${expected.length}，不得只提交编号或汇总声明`;
    }
    const seen = new Set<number>();
    for (const candidate of input) {
      const item = candidate as Record<string, unknown> | null;
      const index = Number(item?.index);
      const status = String(item?.status || '').trim();
      const result = String(item?.result || '').trim();
      const method = String(item?.method || '').trim();
      const evidence = String(item?.evidence || '').trim().slice(0, 12_000);
      const evidenceRefs = projectStringArray(item?.evidenceRefs)
        .map((entry) => entry.replace(/\\/g, '/'));
      if (!Number.isInteger(index) || index < 1 || index > expected.length || seen.has(index)) {
        return `${label}包含无效或重复编号：${String(item?.index ?? '')}`;
      }
      if (!['satisfied', 'unsatisfied', 'unverified'].includes(status)) {
        return `${label}第 ${index} 项必须声明 status=satisfied|unsatisfied|unverified`;
      }
      if (!['passed', 'failed', 'inconclusive', 'not-run'].includes(result)) {
        return `${label}第 ${index} 项必须声明 result=passed|failed|inconclusive|not-run`;
      }
      if (!['runtime-test', 'static-check', 'evidence-review'].includes(method)) {
        return `${label}第 ${index} 项必须声明 method=runtime-test|static-check|evidence-review`;
      }
      if (!evidence) return `${label}第 ${index} 项缺少独立证据`;
      if (evidenceRefs.length === 0 || evidenceRefs.some((entry) => !safeProjectRelativePath(entry))) {
        return `${label}第 ${index} 项必须引用至少一个项目内实际证据文件 evidenceRefs`;
      }
      if (!verifiedEvidence || evidenceRefs.some((entry) => !verifiedEvidence.has(entry))) {
        return `${label}第 ${index} 项的 evidenceRefs 尚未由控制层读取、校验并计算内容哈希`;
      }
      if (status !== 'satisfied') {
        return `${label}第 ${index} 项尚未满足（status=${status}, result=${result}, method=${method}）：${expected[index - 1]}；${evidence}`;
      }
      if (result === 'not-run' || result === 'inconclusive') {
        return `${label}第 ${index} 项尚无可收敛结论（result=${result}, method=${method}）：${expected[index - 1]}；${evidence}`;
      }
      const criterion = expected[index - 1];
      if (projectCriterionRequiresRuntimeTest(criterion) && method !== 'runtime-test') {
        return `${label}第 ${index} 项要求实际运行/实机证据，${method} 不能代替：${criterion}`;
      }
      if (result === 'failed' && projectCriterionRequiresPassingResult(criterion)) {
        return `${label}第 ${index} 项明确要求通过/达标，失败结果不能标记 satisfied：${criterion}`;
      }
      if (method === 'runtime-test' && !evidenceRefs.some((ref) => (
        /(?:^|\/)runs?\/.+(?:result|report|telemetry|manifest|safe-stop|failure|recovery)[^/]*\.(?:json|jsonl|log|txt|xml|trx|csv)$/iu.test(ref)
        || /(?:^|\/)(?:test-results?|artifacts?|logs?)\/.+\.(?:json|jsonl|log|txt|xml|trx|csv)$/iu.test(ref)
        || /(?:result|report|telemetry|junit|test|log)[^/]*\.(?:json|jsonl|log|txt|xml|trx|csv)$/iu.test(ref)
      ))) {
        return `${label}第 ${index} 项声明 runtime-test，但没有引用实际 run、测试结果或日志文件`;
      }
      seen.add(index);
      const identity = projectCriterionIdentity(criterion);
      const previous = criteria.get(identity);
      criteria.set(identity, {
        criterion,
        status: 'satisfied',
        result: result as ProjectCriterionVerification['result'],
        method: method as ProjectCriterionVerification['method'],
        evidence: previous ? `${previous.evidence}\n${evidence}`.slice(0, 12_000) : evidence,
        evidenceRefs: [...new Set([...(previous?.evidenceRefs || []), ...evidenceRefs])].slice(0, 20),
        evidenceArtifacts: evidenceRefs.map((ref) => verifiedEvidence.get(ref)!),
      });
    }
    return null;
  };
  const stopError = checkGroup('停止条件', workItem.contract.stopWhen, raw.stopWhen);
  if (stopError) return { error: stopError };
  const validationError = checkGroup('验证要求', workItem.contract.validation, raw.validation);
  if (validationError) return { error: validationError };
  return { criteria: [...criteria.values()] };
}

function projectStageCompletionError(
  workItem: ProjectWorkItem,
  params: Record<string, unknown>,
): string | null {
  return projectStructuredCompletionChecklist(
    workItem,
    params.completionChecklist,
    new Map((Array.isArray(params.verifiedEvidenceArtifacts) ? params.verifiedEvidenceArtifacts : [])
      .map((artifact: ProjectEvidenceArtifact) => [artifact.ref, artifact])),
  ).error || null;
}

function normalizeOrdinarySupervisorPlan(
  raw: unknown,
  sourceRevision: number,
  previousPlan?: OrdinarySupervisorPlan,
): { plan?: OrdinarySupervisorPlan; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: '普通监督成果计划必须是 JSON 对象' };
  }
  const input = raw as Record<string, unknown>;
  const forbiddenFields = [
    'selectedRoute', 'expectedPaths', 'targetedValidation', 'serializedBoundaries',
    'workerAssignments', 'mergeOrder', 'commands', 'skills',
  ].filter((field) => input[field] !== undefined);
  if (forbiddenFields.length > 0) {
    return { error: `普通监督成果计划不能包含实现路线、路径、命令或技能字段：${forbiddenFields.join('、')}` };
  }
  const objective = String(input.objective || '').trim().slice(0, 4_000);
  const rawMilestones = Array.isArray(input.milestones) ? input.milestones : [];
  if (!objective || rawMilestones.length < 1 || rawMilestones.length > 12) {
    return { error: '普通监督成果计划必须包含 objective 和 1-12 个 milestones' };
  }
  const milestones: OrdinarySupervisorPlan['milestones'] = [];
  const milestoneIds = new Set<string>();
  for (let index = 0; index < rawMilestones.length; index += 1) {
    const rawMilestone = rawMilestones[index] as Record<string, unknown> | null;
    const id = String(rawMilestone?.id || '').trim();
    const title = String(rawMilestone?.title || '').trim().slice(0, 200);
    const outcome = String(rawMilestone?.outcome || '').trim().slice(0, 2_000);
    const status = String(rawMilestone?.status || 'planned').trim();
    const acceptance = projectStringArray(rawMilestone?.acceptance).slice(0, 20);
    if (!PROJECT_WORK_ITEM_ID.test(id) || milestoneIds.has(id)) {
      return { error: `普通监督里程碑 ${index + 1} 的 id 无效或重复` };
    }
    if (!title || !outcome || acceptance.length === 0) {
      return { error: `普通监督里程碑 ${index + 1} 必须包含 title、outcome 和非空 acceptance` };
    }
    if (!['planned', 'active', 'completed'].includes(status)) {
      return { error: `普通监督里程碑 ${index + 1} 的 status 必须是 planned、active 或 completed` };
    }
    milestoneIds.add(id);
    milestones.push({
      id,
      title,
      outcome,
      acceptance,
      status: status as OrdinarySupervisorPlan['milestones'][number]['status'],
      ...(String(rawMilestone?.evidence || '').trim()
        ? { evidence: String(rawMilestone?.evidence || '').trim().slice(0, 4_000) }
        : {}),
    });
  }
  if (milestones.filter((milestone) => milestone.status === 'active').length > 1) {
    return { error: '普通监督成果计划同时只能有一个 active 里程碑' };
  }
  const planningText = [
    objective,
    ...milestones.flatMap((milestone) => [
      milestone.title,
      milestone.outcome,
      ...milestone.acceptance,
    ]),
    ...projectStringArray(input.remainingWork),
  ].join('\n');
  const unresolvedPlanningQuestion = /(?:(?:用户|需求|目标|范围|优先级|偏好|验收|完成条件|规划|计划|方案).{0,32}(?:待确认|待补充|待选择|未明确|不明确|不确定|有疑问|未知|待定|默认假设))|(?:(?:待|需要).{0,12}(?:用户|人工).{0,12}(?:确认|补充|选择|决定|明确))/iu.test(planningText);
  if (unresolvedPlanningQuestion) {
    return {
      error: '普通监督成果计划仍包含未补全的用户规划、范围、偏好或验收疑问；禁止默认忽略或按推荐值执行。请先使用 needs-human --proposal-kind clarification 集中提出 2-5 个关键问题，等待用户答复后再提交无未决项的计划',
    };
  }
  return {
    plan: {
      sourceRevision,
      revision: (previousPlan?.revision || 0) + 1,
      objective,
      milestones,
      remainingWork: projectStringArray(input.remainingWork),
      updatedAt: Date.now(),
    },
  };
}

function normalizeOrdinaryTaskDispatch(raw: unknown): { dispatch?: OrdinaryTaskDispatch; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: '普通监督任务派发必须是 JSON 对象' };
  }
  const input = raw as Record<string, unknown>;
  const allowedFields = new Set([
    'kind', 'sourceRevision', 'milestoneId', 'outcome', 'constraints', 'acceptanceGap', 'evidenceContext',
    'verification', 'returnWhen',
  ]);
  const unknownFields = Object.keys(input).filter((field) => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    return { error: `普通监督任务派发包含未授权字段：${unknownFields.join('、')}` };
  }
  const kind = String(input.kind || '').trim();
  const sourceRevision = Number(input.sourceRevision);
  const milestoneId = String(input.milestoneId || '').trim();
  const outcome = String(input.outcome || '').trim().slice(0, 4_000);
  const constraints = projectStringArray(input.constraints).slice(0, 30);
  const acceptanceGap = projectStringArray(input.acceptanceGap).slice(0, 30);
  const evidenceContext = projectStringArray(input.evidenceContext).slice(0, 30);
  const returnWhen = projectStringArray(input.returnWhen).slice(0, 20);
  if (!['task', 'diagnostic', 'rework'].includes(kind)) {
    return { error: '普通监督任务派发 kind 必须是 task、diagnostic 或 rework' };
  }
  if (!Number.isInteger(sourceRevision) || sourceRevision < 1) {
    return { error: '普通监督任务派发缺少有效 sourceRevision' };
  }
  if (!PROJECT_WORK_ITEM_ID.test(milestoneId) || !outcome || acceptanceGap.length === 0) {
    return { error: '普通监督任务派发必须包含有效 milestoneId、outcome 和非空 acceptanceGap' };
  }
  let verification: OrdinaryTaskDispatch['verification'];
  if (input.verification === undefined && input.returnWhen !== undefined) {
    return { error: '普通监督任务提供 returnWhen 时必须同时提供 verification' };
  }
  if (input.verification !== undefined) {
    if (!input.verification || typeof input.verification !== 'object' || Array.isArray(input.verification)) {
      return { error: '普通监督任务 verification 必须是对象' };
    }
    const verificationInput = input.verification as Record<string, unknown>;
    const verificationUnknownFields = Object.keys(verificationInput).filter((field) => ![
      'feasibility', 'expectedEvidence', 'fallbackWhenUnavailable',
    ].includes(field));
    if (verificationUnknownFields.length > 0) {
      return { error: `普通监督任务 verification 包含未授权字段：${verificationUnknownFields.join('、')}` };
    }
    const feasibility = String(verificationInput.feasibility || '').trim();
    const expectedEvidence = projectStringArray(verificationInput.expectedEvidence).slice(0, 30);
    const fallbackWhenUnavailable = projectStringArray(verificationInput.fallbackWhenUnavailable).slice(0, 20);
    if (!(ORDINARY_VERIFICATION_FEASIBILITY_VALUES as readonly string[]).includes(feasibility)) {
      return { error: '普通监督任务 verification.feasibility 必须是 direct、partial、blocked 或 not-applicable' };
    }
    if (['direct', 'partial'].includes(feasibility) && expectedEvidence.length === 0) {
      return { error: `${feasibility} 验证必须提供非空 expectedEvidence` };
    }
    if (['partial', 'blocked', 'not-applicable'].includes(feasibility)
      && fallbackWhenUnavailable.length === 0) {
      return { error: `${feasibility} 验证必须说明 fallbackWhenUnavailable` };
    }
    if (returnWhen.length === 0) {
      return { error: '带 verification 的普通监督任务必须提供非空 returnWhen' };
    }
    verification = {
      feasibility: feasibility as NonNullable<OrdinaryTaskDispatch['verification']>['feasibility'],
      expectedEvidence,
      fallbackWhenUnavailable,
    };
  }
  const verificationText = verification
    ? [
        ...verification.expectedEvidence,
        ...verification.fallbackWhenUnavailable,
        ...returnWhen,
      ]
    : [];
  const taskEnvelope = [
    outcome,
    ...constraints,
    ...acceptanceGap,
    ...evidenceContext,
    ...verificationText,
  ];
  const disclosureError = projectTaskInstructionDisclosureError(taskEnvelope.join('\n'));
  if (disclosureError) {
    return { error: `普通监督任务必须保持中性，不能暴露监督或内部编排身份：${disclosureError}` };
  }
  const empiricalTask = /(?:上机|上电|实机|实验|测量|采样|采集|台架|硬件)/iu.test(taskEnvelope.join('\n'));
  const forcedEmpiricalResult = [outcome, ...constraints, ...acceptanceGap, ...verificationText].find((item) => (
    /(?:\bPASS\b)|(?:(?:实验|测试|测量|上机|上电|实测).{0,12}(?:结果|结论).{0,8}(?:通过|成功|达标))|(?:(?:实验|测试|测量|上机|上电|实测|结果).{0,16}(?:必须|需要|要求|应当|应|需|须|达到).{0,8}(?:通过|成功|达标))|(?:(?:必须|需要|要求|取得|达到|确保|保证).{0,16}(?:实验|测试|测量|上机|上电|实测|结果).{0,16}(?:通过|成功|达标))/iu.test(item)
    && !/(?:FAIL|失败|未通过|未成功|无论|如实|实际结果|真实结果)/iu.test(item)
  ));
  if (empiricalTask && forcedEmpiricalResult) {
    return {
      error: `实验/上机任务的本次验收不能预设必须 PASS、通过或成功：${forcedEmpiricalResult}。请改为“实际执行完成并如实记录 PASS/FAIL、原始结果和证据”，最终是否满足用户条件由监督 AI 在任务返回后裁决`,
    };
  }
  const implementationDirectiveError = projectTaskImplementationDirectiveError(
    [outcome, ...constraints, ...acceptanceGap, ...verificationText].join('\n'),
  );
  if (implementationDirectiveError) return { error: `普通监督${implementationDirectiveError}` };
  return {
    dispatch: {
      kind: kind as OrdinaryTaskDispatch['kind'],
      sourceRevision,
      milestoneId,
      outcome,
      constraints,
      acceptanceGap,
      evidenceContext,
      ...(verification ? { verification, returnWhen } : {}),
    },
  };
}

function projectVerificationPoliciesInput(
  value: unknown,
  doneWhen: readonly string[],
  fallback?: readonly ProjectCriterionVerificationPolicy[],
): { policies?: ProjectCriterionVerificationPolicy[]; error?: string } {
  if (value === undefined) {
    return { policies: normalizeProjectVerificationPolicies(doneWhen, fallback) };
  }
  if (!Array.isArray(value)) return { error: 'verificationPolicies 必须是数组' };
  const criteriaByIdentity = new Map(doneWhen.map((criterion) => [projectCriterionIdentity(criterion), criterion]));
  const seen = new Set<string>();
  const parsed: ProjectCriterionVerificationPolicy[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'verificationPolicies 每项必须是对象' };
    }
    const candidate = entry as Record<string, unknown>;
    const unknownFields = Object.keys(candidate).filter((field) => !['criterion', 'requirement', 'riskClass', 'reason'].includes(field));
    if (unknownFields.length > 0) {
      return { error: `verificationPolicies 包含未授权字段：${unknownFields.join('、')}` };
    }
    const criterionInput = String(candidate.criterion || '').trim();
    const identity = projectCriterionIdentity(criterionInput);
    const criterion = criteriaByIdentity.get(identity);
    const requirement = String(candidate.requirement || '') as ProjectCriterionVerificationPolicy['requirement'];
    const riskClass = String(candidate.riskClass || 'protected') as NonNullable<ProjectCriterionVerificationPolicy['riskClass']>;
    if (!criterion) return { error: `verificationPolicies 引用了不存在的完成条件：${criterionInput || '（空）'}` };
    if (seen.has(identity)) return { error: `verificationPolicies 重复配置完成条件：${criterion}` };
    if (!PROJECT_VERIFICATION_REQUIREMENTS.includes(requirement)) {
      return { error: `verificationPolicies.requirement 无效：${String(candidate.requirement || '')}` };
    }
    if (!PROJECT_VERIFICATION_RISK_CLASSES.includes(riskClass)) {
      return { error: `verificationPolicies.riskClass 无效：${String(candidate.riskClass || '')}` };
    }
    if (requirement !== 'required' && riskClass !== 'standard') {
      return { error: `完成条件只有显式分类为 riskClass=standard 后才能降低验证要求：${criterion}` };
    }
    if (riskClass === 'standard' && projectCriterionVerificationCannotBeRelaxed(criterion)) {
      return { error: `安全、权限、生产或数据完整性验收不能降级：${criterion}` };
    }
    seen.add(identity);
    const reason = String(candidate.reason || '').trim().slice(0, 4000);
    parsed.push({ criterion, requirement, riskClass, ...(reason ? { reason } : {}) });
  }
  return { policies: normalizeProjectVerificationPolicies(doneWhen, parsed) };
}

function renderOrdinaryTaskDispatch(dispatch: OrdinaryTaskDispatch): string {
  const verificationLabels: Record<NonNullable<OrdinaryTaskDispatch['verification']>['feasibility'], string> = {
    direct: '可直接验证',
    partial: '只能部分验证',
    blocked: '当前验证受阻',
    'not-applicable': '本任务不适用直接验证',
  };
  const verification = dispatch.verification;
  const returnWhen = dispatch.returnWhen?.length
    ? dispatch.returnWhen
    : ['完成本次任务验收；若验证受限，则准确报告已完成部分、未验证项、受限原因和剩余不确定性'];
  return [
    '[任务]',
    `成果：${dispatch.outcome}`,
    dispatch.constraints.length > 0 ? `约束：\n${dispatch.constraints.map((item) => `- ${item}`).join('\n')}` : '',
    `本次任务验收（完成定义）：\n${dispatch.acceptanceGap.map((item) => `- ${item}`).join('\n')}`,
    verification ? `验证可行性：${verificationLabels[verification.feasibility]}` : '验证可行性：未单独声明；按项目规范选择与风险相称的最低成本验证',
    verification?.expectedEvidence.length
      ? `期望证据：\n${verification.expectedEvidence.map((item) => `- ${item}`).join('\n')}`
      : '',
    verification?.fallbackWhenUnavailable.length
      ? `验证受限时：\n${verification.fallbackWhenUnavailable.map((item) => `- ${item}`).join('\n')}`
      : '',
    `返回条件：\n${returnWhen.map((item) => `- ${item}`).join('\n')}`,
    dispatch.evidenceContext.length > 0
      ? `已知现状：\n${dispatch.evidenceContext.map((item) => `- ${item}`).join('\n')}`
      : '',
    `请自主读取并遵循目标项目适用的规范与技能，自主选择实现和验证方式。验收定义说明本轮要交付什么，不代表验证必须成功；验证失败、只能部分验证、当前受阻或不适用都可以作为真实结果返回。${TASK_VALIDATION_REPORTING_POLICY}不得反复死磕或扩大范围。完成后简要报告成果、已执行验证及结果、未验证项、受限原因、剩余不确定性、剩余工作和真实阻塞。`,
  ].filter(Boolean).join('\n\n');
}

function ordinaryCompletionChecklistError(
  value: unknown,
  stopWhenText: string,
  acceptance: readonly string[],
): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '当前普通监督协议要求通过 --completion-file 提交结构化完成核验';
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.remainingWork) || projectStringArray(input.remainingWork).length > 0) {
    return '普通监督完成核验的 remainingWork 必须是空数组';
  }
  const expectedStopWhen = stopWhenText.split(/\r?\n|[;；]/u).map((item) => item.trim()).filter(Boolean);
  const expectedValidation = [...new Set(acceptance.map((item) => item.trim()).filter(Boolean))];
  const checkGroup = (label: string, rawGroup: unknown, expected: readonly string[]): string | null => {
    const group = Array.isArray(rawGroup) ? rawGroup : [];
    if (group.length !== expected.length) {
      return `普通监督完成核验必须逐项覆盖全部${label}（期望 ${expected.length} 项，实际 ${group.length} 项）`;
    }
    const seen = new Set<number>();
    for (const [index, rawItem] of group.entries()) {
      const item = rawItem as Record<string, unknown> | null;
      const itemIndex = Number(item?.index);
      const status = String(item?.status || '').trim();
      const result = String(item?.result || '').trim();
      const method = String(item?.method || '').trim();
      const evidence = String(item?.evidence || '').trim();
      if (!Number.isInteger(itemIndex) || itemIndex < 1 || itemIndex > expected.length || seen.has(itemIndex)) {
        return `普通监督完成核验${label}第 ${index + 1} 项的 index 无效或重复`;
      }
      seen.add(itemIndex);
      if (status !== 'satisfied' || !['passed', 'failed'].includes(result)
        || !['runtime-test', 'static-check', 'evidence-review'].includes(method) || !evidence) {
        return `普通监督完成核验${label}第 ${index + 1} 项必须具有 satisfied、确定结果、核验方法和非空证据`;
      }
      const criterion = expected[itemIndex - 1];
      if (projectCriterionRequiresRuntimeTest(criterion) && method !== 'runtime-test') {
        return `普通监督完成核验${label}第 ${itemIndex} 项要求实际运行或实机证据，${method} 不能代替：${criterion}`;
      }
      if (result === 'failed' && projectCriterionRequiresPassingResult(criterion)) {
        return `普通监督完成核验${label}第 ${itemIndex} 项明确要求通过或达标，失败结果不能标记 satisfied：${criterion}`;
      }
    }
    return null;
  };
  return checkGroup('停止条件', input.stopWhen, expectedStopWhen)
    || checkGroup('成果验收', input.validation, expectedValidation);
}

function normalizeProjectSubgoalsInput(
  raw: unknown,
  session: ProjectManagerSession,
): { subgoals?: ProjectSubgoal[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
    return { error: '阶段目标必须是包含 1-20 项的数组，通常保持 3-7 项' };
  }
  const activeGoal = activeProjectGoal(session);
  const existing = new Map((session.subgoals || [])
    .filter((subgoal) => subgoal.goalId === activeGoal.id)
    .map((subgoal) => [subgoal.id, subgoal]));
  const now = Date.now();
  const subgoals: ProjectSubgoal[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const candidate = raw[index] as Record<string, unknown> | null;
    const id = String(candidate?.id || '').trim();
    const title = String(candidate?.title || '').trim().slice(0, 200);
    const outcome = String(candidate?.outcome || '').trim().slice(0, 4000);
    const acceptance = projectStringArray(candidate?.acceptance);
    const dependencies = projectStringArray(candidate?.dependencies);
    const status = String(candidate?.status || 'planned');
    if (!PROJECT_WORK_ITEM_ID.test(id)) return { error: `阶段目标 ${index + 1} 的 ID 格式无效` };
    if (!title || !outcome || acceptance.length === 0) {
      return { error: `阶段目标 ${id} 必须包含 title、outcome 和至少一项 acceptance` };
    }
    if (!['planned', 'active', 'blocked', 'achieved', 'obsolete'].includes(status)) {
      return { error: `阶段目标 ${id} 的状态无效：${status}` };
    }
    const previous = existing.get(id);
    let completion: ProjectCompletionResult | undefined;
    if (status === 'achieved') {
      if (previous?.status === 'achieved') {
        completion = normalizeProjectCompletionResult(previous.completion);
      } else {
        if (candidate?.completion !== undefined) {
          return { error: `阶段目标 ${id} 的完成证据只能由控制层从监督工作项聚合，项目 AI 不能自行提交` };
        }
        completion = projectSubgoalCompletionResult({
          id,
          goalId: activeGoal.id,
          status: 'achieved',
          updatedAt: now,
          completion: undefined,
        }, session.workItems, {
          requirementsVersion: projectRequirementsVersion(session),
          authorizationVersion: projectAuthorizationVersion(session),
        });
        const completionError = projectCompletionCriteriaError(
          acceptance,
          completion,
          `阶段目标 ${id} 的 acceptance`,
          { allowExtra: true, requireArtifacts: true },
        );
        if (completionError) {
          const completedWithCriteria = session.workItems.some((item) => (
            item.subgoalId === id
            && item.status === 'completed'
            && (normalizeProjectCompletionResult(item.completion)?.criteria?.length || 0) > 0
          ));
          return {
            error: completedWithCriteria
              ? `stage-closure-evidence-mapping-missing：${completionError}`
              : completionError,
          };
        }
      }
    }
    subgoals.push({
      id,
      goalId: activeGoal.id,
      title,
      outcome,
      acceptance,
      dependencies,
      status: status as ProjectSubgoal['status'],
      order: index + 1,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      completion,
    });
  }
  const incomingAcceptance = new Set(subgoals
    .filter((subgoal) => subgoal.status !== 'obsolete')
    .flatMap((subgoal) => subgoal.acceptance)
    .map(projectCriterionIdentity));
  const invalidGoalCoverage = activeGoal.doneWhen.map((criterion) => ({
    criterion,
    count: subgoals
      .filter((subgoal) => subgoal.status !== 'obsolete')
      .flatMap((subgoal) => subgoal.acceptance)
      .filter((acceptance) => projectCriterionIdentity(acceptance) === projectCriterionIdentity(criterion)).length,
  })).find((entry) => entry.count !== 1);
  if (invalidGoalCoverage) {
    return {
      error: `主目标完成条件必须由且仅由一个非 obsolete 阶段 acceptance 原文覆盖：${invalidGoalCoverage.criterion}（当前 ${invalidGoalCoverage.count} 处）`,
    };
  }
  for (const previous of existing.values()) {
    if (['achieved', 'obsolete'].includes(previous.status)) continue;
    const lost = previous.acceptance.find((criterion) => (
      !incomingAcceptance.has(projectCriterionIdentity(criterion))
    ));
    if (lost) {
      return {
        error: `不能通过废止或改写阶段缩减尚未满足的验收范围：${previous.title} · ${lost}；请在新阶段保留该 acceptance，或由用户正式调整主目标`,
      };
    }
  }
  const unfinished = subgoals.filter((subgoal) => !['achieved', 'obsolete'].includes(subgoal.status));
  if (unfinished.length > 7) {
    return { error: '当前主目标同时只能保留 1-7 个未完成阶段；请合并微小步骤或将已结束阶段标记为 achieved/obsolete' };
  }
  return { subgoals };
}

function normalizeProjectWorkItemInput(
  raw: any,
  projectDir: string,
  previous: ProjectWorkItem | undefined,
  session: ProjectManagerSession,
): { workItem?: ProjectWorkItem; error?: string } {
  const id = String(raw?.id || previous?.id || '').trim();
  if (!PROJECT_WORK_ITEM_ID.test(id)) return { error: '任务 ID 仅允许 1-80 位字母、数字、下划线或短横线' };
  const title = String(raw?.title ?? previous?.title ?? '').trim();
  if (!previous || raw?.title !== undefined) {
    const titleError = projectWorkItemOutcomeTitleError(title, id);
    if (titleError) return { error: titleError };
  }
  const contractRaw = raw?.contract || previous?.contract || {};
  const objective = String(contractRaw.objective || '').trim();
  const description = String(contractRaw.description || '').trim().slice(0, 4000);
  const contractPreconditions = projectStringArray(contractRaw.preconditions);
  const stopWhen = projectStringArray(contractRaw.stopWhen);
  const validation = projectStringArray(contractRaw.validation);
  const rawStageAcceptanceCoverage = contractRaw.stageAcceptanceCoverage;
  let stageAcceptanceCoverage = normalizeProjectStageAcceptanceCoverage(rawStageAcceptanceCoverage);
  if (!objective || stopWhen.length === 0 || validation.length === 0) {
    return { error: '任务必须包含 objective、stopWhen 和 validation' };
  }
  const normalizedProjectDir = normalizeAbsolutePath(projectDir);
  const root = String(contractRaw.scope?.root || projectDir).trim();
  if (!normalizedProjectDir || normalizeAbsolutePath(root) !== normalizedProjectDir) {
    return { error: '任务工作根目录必须与项目管理会话目录一致' };
  }
  const allowPaths = projectStringArray(contractRaw.scope?.allowPaths);
  const denyPaths = projectStringArray(contractRaw.scope?.denyPaths);
  if (![...allowPaths, ...denyPaths].every(safeProjectRelativePath)) {
    return { error: '任务路径范围必须是项目内相对路径，不能包含 .. 或绝对路径' };
  }
  const status = String(raw?.status || previous?.status || 'planned');
  if (!PROJECT_WORK_ITEM_STATUSES.has(status)) return { error: `无效任务状态：${status}` };
  const complexityAssessment = normalizeProjectTaskComplexityAssessment(
    previous?.complexityAssessment || raw?.complexityAssessment,
    Date.now(),
  );
  if (!previous && !complexityAssessment) {
    return {
      error: 'task-create 必须包含 complexityAssessment，说明任务复杂度、拆分判断、判断信号和理由',
    };
  }
  if (!previous && complexityAssessment?.decision === 'split-before-dispatch') {
    return {
      error: '复杂度评估结论要求先拆分；请为每个独立可验收成果分别创建 single-task 工作项，不能直接派发复合任务',
    };
  }
  const rawTaskWorkMode = String(raw?.taskWorkMode ?? previous?.taskWorkMode ?? '').trim();
  if (!['single-thread', 'multi-thread'].includes(rawTaskWorkMode)) {
    return { error: 'task-create 必须包含 taskWorkMode=single-thread|multi-thread，由项目 AI 根据任务复杂度选择初始执行模式' };
  }
  const taskWorkMode = rawTaskWorkMode as 'single-thread' | 'multi-thread';
  if (contractRaw.execution !== undefined) {
    return { error: '线程模式必须使用工作项顶层 taskWorkMode，不能写入 contract.execution' };
  }
  const continuationBoundary = String(contractRaw.authority?.continuationBoundary || '').trim();
  const validContinuationBoundaries = new Set([
    'project-owned-decision', 'external-prerequisite', 'high-risk-boundary',
  ]);
  if (contractRaw.authority?.continuousExecution === false
    && !validContinuationBoundaries.has(continuationBoundary)) {
    return { error: '禁用 continuousExecution 时必须通过 continuationBoundary 说明真实停止边界，不能退化为逐步授权' };
  }
  if (contractRaw.authority?.continuousExecution === true && continuationBoundary) {
    return { error: '启用 continuousExecution 时不能同时设置 continuationBoundary' };
  }
  const allowedCommandPrefixes = projectStringArray(contractRaw.authority?.allowedCommandPrefixes)
    .map((item) => item.slice(0, 240));
  const permissionConfirm = contractRaw.authority?.permissionConfirm !== false;
  const targetedTests = contractRaw.authority?.targetedTests !== false;
  if (permissionConfirm
    && !targetedTests
    && allowedCommandPrefixes.length === 0) {
    return { error: '启用 permissionConfirm 时必须授权 targetedTests 或提供 allowedCommandPrefixes' };
  }
  if (!permissionConfirm && allowedCommandPrefixes.length > 0) {
    return { error: '未启用 permissionConfirm 时不能提供 allowedCommandPrefixes' };
  }
  // Runtime bindings are control-plane owned. Project AI defines the contract;
  // the dedicated supervisor creates and binds the task terminal afterwards.
  const workerSurfaceId = String(previous?.workerSurfaceId || '').trim() || undefined;
  if (workerSurfaceId) {
    const worker = remoteTerminalList().find((terminal) => terminal.surfaceId === workerSurfaceId);
    if (!worker) return { error: `任务终端不存在：${workerSurfaceId}` };
    const workerDirectory = normalizeAbsolutePath(worker.projectDir || worker.cwd || '');
    if (!workerDirectory || (
      workerDirectory !== normalizedProjectDir && !workerDirectory.startsWith(`${normalizedProjectDir}/`)
    )) {
      return { error: '任务终端必须位于该项目目录内，不能跨项目绑定' };
    }
  }
  const now = Date.now();
  const activeGoal = activeProjectGoal(session);
  const goalId = String(previous?.goalId || raw?.goalId || activeGoal.id).trim();
  const availableSubgoals = activeProjectSubgoals(session).filter((candidate) => (
    !['achieved', 'obsolete'].includes(candidate.status)
  ));
  const subgoalId = String(
    raw?.subgoalId !== undefined
      ? raw.subgoalId
      : previous?.subgoalId || (availableSubgoals.length === 1 ? availableSubgoals[0].id : ''),
  ).trim();
  if (!previous) {
    if (!goalId || goalId !== activeGoal.id) return { error: '新任务必须归属于当前主目标' };
    if (!subgoalId) return { error: '新任务必须指定当前主目标下的 subgoalId' };
    const subgoal = availableSubgoals.find((candidate) => candidate.id === subgoalId);
    if (!subgoal || ['achieved', 'obsolete'].includes(subgoal.status)) {
      return { error: `阶段目标不存在或已经结束：${subgoalId}` };
    }
  }
  if (previous?.goalId && previous.goalId !== activeGoal.id) {
    return { error: '旧主目标任务已经失效，不能重新绑定到当前主目标' };
  }
  if (previous && subgoalId !== previous.subgoalId) {
    const subgoal = availableSubgoals.find((candidate) => candidate.id === subgoalId);
    if (!subgoal) return { error: `任务只能重分配到当前主目标下的有效阶段：${subgoalId || '未指定'}` };
  }
  const subgoal = activeProjectSubgoals(session).find((candidate) => candidate.id === subgoalId);
  const legacyGoalCriteria = new Set(activeProjectGoal(session).doneWhen.map(projectCriterionIdentity));
  const legacyStageCriteria = new Set(subgoal?.acceptance
    .map(projectCriterionIdentity)
    .filter((criterion) => legacyGoalCriteria.has(criterion)) || []);
  const migratedStopWhen = previous && previous.stopWhenScopeVersion !== 1
    ? stopWhen.filter((criterion) => !legacyStageCriteria.has(projectCriterionIdentity(criterion)))
    : stopWhen;
  const scopedStopWhen = migratedStopWhen.length > 0 ? migratedStopWhen : stopWhen;
  const stageScopeError = projectWorkItemStageScopeError(session, subgoalId, [
    ...scopedStopWhen,
    ...validation,
  ]);
  if (stageScopeError) return { error: stageScopeError };
  if (!previous && stageAcceptanceCoverage.length === 0) {
    return {
      error: 'task-create 必须通过 contract.stageAcceptanceCoverage 显式声明本成果覆盖的阶段 acceptance，不能依靠相似文案推断',
    };
  }
  if (rawStageAcceptanceCoverage !== undefined) {
    if (!Array.isArray(rawStageAcceptanceCoverage)
      || stageAcceptanceCoverage.length === 0
      || stageAcceptanceCoverage.length !== rawStageAcceptanceCoverage.length) {
      return { error: 'contract.stageAcceptanceCoverage 必须是非空 stageCriterion/verificationCriterion 对象数组' };
    }
    const stageCriteria = new Map((subgoal?.acceptance || []).map((criterion) => [criterion, criterion]));
    const verificationCriteria = new Map([...scopedStopWhen, ...validation].map((criterion) => [criterion, criterion]));
    const seenStageCriteria = new Set<string>();
    const seenVerificationCriteria = new Set<string>();
    for (const mapping of stageAcceptanceCoverage) {
      if (!stageCriteria.has(mapping.stageCriterion)) {
        return { error: `stage-closure-evidence-mapping-missing：阶段 acceptance 不存在：${mapping.stageCriterion}` };
      }
      if (!verificationCriteria.has(mapping.verificationCriterion)) {
        return { error: `stage-closure-evidence-mapping-missing：工作项核验条目不存在：${mapping.verificationCriterion}` };
      }
      if (seenStageCriteria.has(mapping.stageCriterion)
        || seenVerificationCriteria.has(mapping.verificationCriterion)) {
        return { error: 'contract.stageAcceptanceCoverage 不能重复映射阶段 acceptance 或工作项核验条目' };
      }
      seenStageCriteria.add(mapping.stageCriterion);
      seenVerificationCriteria.add(mapping.verificationCriterion);
    }
    stageAcceptanceCoverage = stageAcceptanceCoverage.map((mapping) => ({
      stageCriterion: stageCriteria.get(mapping.stageCriterion)!,
      verificationCriterion: verificationCriteria.get(mapping.verificationCriterion)!,
    }));
    if (previous?.status === 'completed') {
      const previousCoverage = normalizeProjectStageAcceptanceCoverage(
        previous.contract.stageAcceptanceCoverage,
      );
      const removedMapping = previousCoverage.find((existing) => !stageAcceptanceCoverage.some((mapping) => (
        mapping.stageCriterion === existing.stageCriterion
        && mapping.verificationCriterion === existing.verificationCriterion
      )));
      if (removedMapping) {
        return {
          error: `completed 历史工作项的阶段验收映射只能追加，不能删除或改写：${removedMapping.stageCriterion}`,
        };
      }
      const completedCriteria = new Map((normalizeProjectCompletionResult(previous.completion)?.criteria || [])
        .map((criterion) => [criterion.criterion, criterion]));
      const missingCompletedCriterion = stageAcceptanceCoverage.find((mapping) => {
        const criterion = completedCriteria.get(mapping.verificationCriterion);
        return !criterion
          || criterion.status !== 'satisfied'
          || ['not-run', 'inconclusive'].includes(criterion.result)
          || criterion.evidenceRefs.some((ref) => !criterion.evidenceArtifacts?.some((artifact) => artifact.ref === ref));
      });
      if (missingCompletedCriterion) {
        return {
          error: `stage-closure-evidence-mapping-missing：历史完成项缺少可映射且已哈希的核验证据：${missingCompletedCriterion.verificationCriterion}`,
        };
      }
    }
  }
  const taskContractDisclosureError = projectTaskContractDisclosureError({
    objective,
    description,
    preconditions: contractPreconditions,
    stopWhen: scopedStopWhen,
    validation,
  });
  if (taskContractDisclosureError) return { error: taskContractDisclosureError };
  const taskContractImplementationDirectiveError = projectTaskImplementationDirectiveError([
    objective,
    ...contractPreconditions,
    ...scopedStopWhen,
    ...validation,
  ].join('\n'));
  if (taskContractImplementationDirectiveError) {
    return { error: `任务合同${taskContractImplementationDirectiveError}` };
  }
  const rebindCurrentRequirements = raw?.rebindCurrentRequirements === true;
  const requirementsVersion = previous && !rebindCurrentRequirements
    ? previous.requirementsVersion
    : projectRequirementsVersion(session);
  return {
    workItem: {
      id,
      goalId,
      subgoalId,
      requirementsVersion,
      authorizationVersion: previous && !rebindCurrentRequirements
        ? previous.authorizationVersion
        : projectAuthorizationVersion(session),
      executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
      stopWhenScopeVersion: 1,
      complexityAssessment: complexityAssessment!,
      taskWorkMode,
      contextReset: previous?.contextReset,
      title: title || previous?.title || id,
      contract: {
        objective,
        description,
        preconditions: contractPreconditions,
        supervisorNotes: projectStringArray(contractRaw.supervisorNotes)
          .slice(0, 20).map((note) => note.slice(0, 4000)),
        scope: {
          root: projectDir,
          allowPaths,
          denyPaths,
          forbiddenActions: projectStringArray(contractRaw.scope?.forbiddenActions),
        },
        authority: {
          technicalChoices: contractRaw.authority?.technicalChoices !== false,
          lowRiskRetries: contractRaw.authority?.lowRiskRetries !== false,
          routeAdjustments: contractRaw.authority?.routeAdjustments !== false,
          targetedTests,
          internalThreads: contractRaw.authority?.internalThreads !== false,
          continuousExecution: contractRaw.authority?.continuousExecution !== false,
          ...(continuationBoundary ? {
            continuationBoundary: continuationBoundary as ProjectSupervisorContract['authority']['continuationBoundary'],
          } : {}),
          permissionConfirm,
          allowedCommandPrefixes,
          authorizedDevices: projectStringArray(contractRaw.authority?.authorizedDevices),
          authorizedEnvironments: projectStringArray(contractRaw.authority?.authorizedEnvironments),
          authorizedOperations: projectStringArray(contractRaw.authority?.authorizedOperations),
        },
        stopWhen: scopedStopWhen,
        validation,
        ...(stageAcceptanceCoverage.length > 0 ? { stageAcceptanceCoverage } : {}),
        budget: normalizeProjectExecutionBudget(contractRaw.budget),
      },
      status: status as ProjectWorkItem['status'],
      dependencies: projectStringArray(raw?.dependencies ?? previous?.dependencies),
      supervisorLaneId: String(previous?.supervisorLaneId || '').trim() || undefined,
      workerSurfaceId,
      // These counters are owned by the control layer. Accepting them from task-create/task-update
      // would let the project-management AI reset anti-loop accounting.
      attempts: previous?.attempts ?? 0,
      totalDecisionsUsed: previous?.totalDecisionsUsed ?? 0,
      startedAt: previous?.startedAt,
      updatedAt: now,
      completedAt: status === 'completed' ? previous?.completedAt || now : undefined,
      completion: ['validating', 'completed'].includes(status) ? previous?.completion : undefined,
      executionHistory: previous?.executionHistory || [],
      latestEvidence: String(raw?.latestEvidence ?? previous?.latestEvidence ?? '').trim() || undefined,
      latestContextSummary: String(raw?.latestContextSummary ?? previous?.latestContextSummary ?? '').trim() || undefined,
      latestBlocker: String(
        raw?.latestBlocker ?? previous?.latestBlocker ?? '',
      ).trim() || undefined,
    },
  };
}

/** Merge the public partial task-update shape onto the persisted contract before validation. */
function projectWorkItemUpdateInput(raw: any, previous: ProjectWorkItem): any {
  const source = raw?.workItem || raw || {};
  const contractPatch = source.contract && typeof source.contract === 'object'
    ? source.contract
    : {};
  const topLevelContractPatch = {
    ...(source.objective !== undefined ? { objective: source.objective } : {}),
    ...(source.description !== undefined ? { description: source.description } : {}),
    ...(source.preconditions !== undefined ? { preconditions: source.preconditions } : {}),
    ...(source.supervisorNotes !== undefined ? { supervisorNotes: source.supervisorNotes } : {}),
    ...(source.stopWhen !== undefined ? { stopWhen: source.stopWhen } : {}),
    ...(source.validation !== undefined ? { validation: source.validation } : {}),
    ...(source.stageAcceptanceCoverage !== undefined
      ? { stageAcceptanceCoverage: source.stageAcceptanceCoverage }
      : {}),
  };
  return {
    ...source,
    id: previous.id,
    contract: {
      ...previous.contract,
      ...contractPatch,
      ...topLevelContractPatch,
      scope: {
        ...previous.contract.scope,
        ...(contractPatch.scope && typeof contractPatch.scope === 'object' ? contractPatch.scope : {}),
      },
      authority: {
        ...previous.contract.authority,
        ...(contractPatch.authority && typeof contractPatch.authority === 'object' ? contractPatch.authority : {}),
      },
      budget: {
        ...previous.contract.budget,
        ...(contractPatch.budget && typeof contractPatch.budget === 'object' ? contractPatch.budget : {}),
      },
    },
  };
}

function projectWorkItemBudgetExhaustionSummary(
  item: ProjectWorkItem,
  now = Date.now(),
): string {
  return projectBudgetExhaustionSummary({
    budget: item.contract.budget,
    attempts: item.attempts,
    startedAt: item.startedAt,
    aggregateWorkerMinutes: 0,
    now,
  });
}

function referencedProjectRuntimeSurfaceIds(sessionId: string): Set<string> {
  const state = useStore.getState();
  const session = state.projectManagers.find((candidate) => candidate.id === sessionId);
  const referenced = new Set<string>();
  if (!session) return referenced;
  if (session.managerSurfaceId) referenced.add(session.managerSurfaceId);
  if (session.taskTerminalSurfaceId) referenced.add(session.taskTerminalSurfaceId);
  if (session.auxiliaryTaskTerminalSurfaceId) referenced.add(session.auxiliaryTaskTerminalSurfaceId);
  for (const lane of state.supervisor.lanes.filter((candidate) => (
    candidate.projectManagerProjectId === sessionId
    && supervisorLaneControlState(candidate) !== 'stopped'
  ))) {
    referenced.add(lane.surfaceId);
    const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
    if (supervisorSurfaceId) referenced.add(supervisorSurfaceId);
  }
  for (const item of session.workItems.filter((candidate) => !['completed', 'stopped'].includes(candidate.status))) {
    if (item.workerSurfaceId) referenced.add(item.workerSurfaceId);
  }
  return referenced;
}

function orphanedProjectRuntimeSurfaceIds(sessionId: string): string[] {
  const state = useStore.getState();
  const session = state.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session) return [];
  if (projectManagerRuntimeEnsureRuns.has(sessionId)) return [];
  const boundManager = session.managerSurfaceId
    ? projectManagerTerminal({ surfaceId: session.managerSurfaceId, projectId: sessionId })
    : undefined;
  const staleManagerSurfaceIds = boundManager
    ? projectManagerTerminals(sessionId)
      .filter((terminal) => terminal.surfaceId !== boundManager.surfaceId)
      .map((terminal) => terminal.surfaceId)
    : [];
  const projectLanes = state.supervisor.lanes.filter((candidate) => (
    candidate.projectManagerProjectId === sessionId
    && supervisorLaneControlState(candidate) !== 'stopped'
  ));
  const laneIds = new Set(projectLanes.map((lane) => lane.id));
  const missingPersistedLane = session.workItems.some((item) => (
    !['completed', 'stopped'].includes(item.status)
    && !!item.supervisorLaneId
    && !laneIds.has(item.supervisorLaneId)
  ));
  if (missingPersistedLane) return staleManagerSurfaceIds;

  const referenced = referencedProjectRuntimeSurfaceIds(sessionId);
  const staleExecutionSurfaceIds = state.workspaces.flatMap((workspace) => (
    getAllPaneIds(workspace.splitTree).flatMap((paneId) => (
      (findLeaf(workspace.splitTree, paneId)?.surfaces || []).filter((surface) => {
        if (surface.projectManagerTerminal || referenced.has(surface.id)) return false;
        return surface.projectSupervisorProjectId === sessionId
          || (surface.projectManagerProjectId === sessionId && !!surface.projectManagerWorkItemId);
      }).map((surface) => surface.id)
    ))
  ));
  return [...new Set([...staleManagerSurfaceIds, ...staleExecutionSurfaceIds])];
}

function projectRuntimeSurfaceSafeToClose(_sessionId: string, surfaceId: string): boolean {
  const runtimeState = terminalRuntimeStatus(surfaceId)?.state;
  if (runtimeState === 'failed' || runtimeState === 'exited'
    || nestedAgentShellFailureDetail(surfaceId as SurfaceId)) return true;
  if (runtimeState === 'starting') return false;
  if (remoteTerminalActivity(surfaceId as SurfaceId, true).activityState !== 'idle') return false;
  const buffer = surfaceTerminalRegistry.get(surfaceId as SurfaceId)?.buffer.active;
  return !!buffer && !hasPendingTerminalInput(buffer);
}

/** Close only unowned project terminals whose Agent turn and pending input have both drained. */
export function cleanupOrphanedProjectRuntimeSurfaces(sessionId: string): string[] {
  const orphaned = orphanedProjectRuntimeSurfaceIds(sessionId);
  const cleaned: string[] = [];
  for (const surfaceId of orphaned) {
    if (!projectRuntimeSurfaceSafeToClose(sessionId, surfaceId)) continue;
    if (closeLiveSurfaceById(surfaceId as SurfaceId)) cleaned.push(surfaceId);
  }
  return cleaned;
}

function scheduleProjectRuntimeOrphanCleanup(
  sessionId: string,
  reason: string,
  attempt = 0,
): void {
  const existing = projectRuntimeOrphanCleanupTimers.get(sessionId);
  if (existing) globalThis.clearTimeout(existing);
  const timer = globalThis.setTimeout(() => {
    projectRuntimeOrphanCleanupTimers.delete(sessionId);
    const cleanedSurfaceIds = cleanupOrphanedProjectRuntimeSurfaces(sessionId);
    const remainingSurfaceIds = orphanedProjectRuntimeSurfaceIds(sessionId);
    const store = useStore.getState();
    if (cleanedSurfaceIds.length > 0) {
      store.appendProjectManagerEvent({
        kind: 'supervisor-status',
        summary: `已安全回收 ${cleanedSurfaceIds.length} 个不再绑定当前执行链的项目 AI 终端`,
        payload: {
          action: 'cleanup-orphaned-project-runtime-surfaces',
          reason,
          cleanedSurfaceIds,
        },
      }, sessionId);
      saveProjectManagerSnapshot(sessionId);
    }
    if (remainingSurfaceIds.length > 0 && attempt < 12) {
      scheduleProjectRuntimeOrphanCleanup(sessionId, reason, attempt + 1);
    } else if (remainingSurfaceIds.length > 0) {
      store.appendProjectManagerEvent({
        kind: 'supervisor-status',
        summary: `${remainingSurfaceIds.length} 个旧项目 AI 终端仍在工作或状态未知，已停止自动关闭并保留待后续恢复处理`,
        payload: {
          action: 'project-runtime-retirement-deferred',
          reason,
          remainingSurfaceIds,
          attentionRequired: false,
        },
      }, sessionId);
      saveProjectManagerSnapshot(sessionId);
    }
  }, attempt === 0 ? 1_500 : 5_000);
  projectRuntimeOrphanCleanupTimers.set(sessionId, timer);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

function projectManagerCallerAllowed(
  callerSurfaceId: string,
  session: ProjectManagerSession | null,
): boolean {
  if (!callerSurfaceId || !session || session.managerSurfaceId !== callerSurfaceId) return false;
  return projectManagerTerminal({ surfaceId: callerSurfaceId, projectId: session.id })?.surfaceId === callerSurfaceId;
}

function projectAuxiliaryCallerAllowed(
  callerSurfaceId: string,
  session: ProjectManagerSession | null,
): boolean {
  if (projectManagerCallerAllowed(callerSurfaceId, session)) return true;
  if (!callerSurfaceId || !session) return false;
  return useStore.getState().supervisor.lanes.some((lane) => (
    lane.projectManagerProjectId === session.id
    && dedicatedSupervisorSurfaceId(lane) === callerSurfaceId
    && supervisorLaneControlState(lane) !== 'stopped'
  ));
}

function expectedManagedRoleProtocol(surfaceId: string): {
  role: ManagedRoleProtocol;
  protocolRevision: string;
  protocolFingerprint: string;
  lane?: SupervisorLane;
} | null {
  const state = useStore.getState();
  const project = state.projectManagers.find((candidate) => candidate.managerSurfaceId === surfaceId);
  if (project && projectManagerTerminal({ surfaceId, projectId: project.id })) {
    return {
      role: 'project-ai',
      protocolRevision: PROJECT_MANAGER_PROTOCOL_REVISION,
      protocolFingerprint: PROJECT_AI_PROTOCOL_FINGERPRINT,
    };
  }
  const lane = state.supervisor.lanes.find((candidate) => (
    dedicatedSupervisorSurfaceId(candidate) === surfaceId
    && supervisorLaneControlState(candidate) !== 'stopped'
  ));
  return lane ? {
    role: 'supervisor-ai',
    protocolRevision: SUPERVISOR_PROTOCOL_REVISION,
    protocolFingerprint: SUPERVISOR_AI_PROTOCOL_FINGERPRINT,
    lane,
  } : null;
}

function managedRoleProtocolIsReady(surfaceId: string): boolean {
  const expected = expectedManagedRoleProtocol(surfaceId);
  const confirmed = managedRoleProtocolReady.get(surfaceId);
  return !!expected
    && confirmed?.role === expected.role
    && confirmed.protocolRevision === expected.protocolRevision
    && confirmed.protocolFingerprint === expected.protocolFingerprint;
}

function handleProjectAuxiliaryHookEvent(event: any): boolean {
  const surfaceId = String(event?.surfaceId || '').trim();
  const session = useStore.getState().projectManagers.find((candidate) => (
    candidate.auxiliaryTaskTerminalSurfaceId === surfaceId
  ));
  if (!session) return false;
  const lifecycle = String(event?.event || '');
  if (!['Stop', 'StopFailure', 'Interrupt'].includes(lifecycle) || session.auxiliaryTask?.status !== 'running') {
    return true;
  }
  const failed = lifecycle !== 'Stop';
  const output = (readTerminalScreen(surfaceId, 200).text || String(event?.message || '')).slice(-12_000);
  const auxiliaryTask = {
    ...session.auxiliaryTask,
    status: failed ? 'failed' as const : 'completed' as const,
    completedAt: Date.now(),
    summary: output || (failed ? '辅助任务异常结束，未取得可读结果' : '辅助任务已结束'),
  };
  const updated = { ...session, auxiliaryTask, updatedAt: Date.now() };
  replaceProjectManagerSession(updated);
  void appendRecordedProjectEvent(updated, {
    kind: 'supervisor-status',
    summary: `${failed ? '辅助任务 AI 异常结束' : '辅助任务 AI 已完成'}：${auxiliaryTask.task.slice(0, 160)}`,
    payload: { auxiliaryTaskId: auxiliaryTask.id, requesterRole: auxiliaryTask.requesterRole, failed },
  });
  const message = [
    failed ? '[辅助任务 AI 失败]' : '[辅助任务 AI 结果]',
    `任务：${auxiliaryTask.task}`,
    `类型：${auxiliaryTask.kind}`,
    `允许路径：${auxiliaryTask.allowedPaths.join('；') || '只读'}`,
    output || '未提取到可读输出，请使用 wmux project auxiliary-status 查看终端。',
    '该结果只提供给项目 AI/监督 AI；主任务 AI 未收到此消息。',
  ].join('\n');
  if (auxiliaryTask.requesterRole === 'supervisor-ai' && auxiliaryTask.requesterLaneId) {
    const lane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === auxiliaryTask.requesterLaneId);
    if (lane) queueSupervisorControlMessage(lane, message, lane.label, true);
  } else {
    deliverProjectManagerMessage(message, false, session.id);
  }
  void processProjectAgentReconfiguration(session.id, surfaceId);
  return true;
}

export type ProjectMessageChangeSignal = 'prerequisite-change' | 'requirements-change';

/** Only high-confidence user statements revoke the current project contract automatically. */
export function projectMessageChangeSignal(message: string): ProjectMessageChangeSignal | null {
  const text = message.trim();
  if (!text) return null;
  const hypotheticalOnly = /(?:如果|假如|假设|是否|会不会|怎么办|怎样处理)/u.test(text)
    && !/(?:已|现在|当前|刚刚|确认|实际)/u.test(text);
  if (hypotheticalOnly) return null;
  if (
    /(?:(?:硬件|设备|板卡|仪器|电源|环境|连接|网络).{0,16}(?:断电|掉电|未上电|离线|断开|不可用|更换|失效|不再满足))|(?:(?:已|现在|当前|刚刚).{0,8}(?:断电|掉电|停止上电|断开连接))|(?:(?:撤销|取消|收回).{0,12}(?:授权|许可|上机|实测))|(?:(?:前置条件|安全条件|环境条件).{0,16}(?:变化|变更|不再满足|失效))/u.test(text)
  ) {
    return 'prerequisite-change';
  }
  if (
    /(?:(?:需求|目标|范围|完成条件|验收标准|优先级).{0,12}(?:变更|变化|修改|调整|改为|取消|新增|删除))|(?:不再需要|不要再做|改做|换成).{0,40}/u.test(text)
  ) {
    return 'requirements-change';
  }
  return null;
}

function projectPlanningActionConfirmationError(
  session: ProjectManagerSession,
  action: string,
  params: any,
): string | null {
  const updatesDefinition = action === 'update' || action === 'update-definition';
  const input = action === 'task-create' || action === 'task-update'
    ? params?.workItem || params || {}
    : params?.definition || params || {};
  const supplements = projectStringArray(input?.planningSupplements ?? input?.supplements);
  let changesUserPlan = false;
  const inputDoneWhen = updatesDefinition && Object.prototype.hasOwnProperty.call(input, 'doneWhen')
    ? projectStringArray(input.doneWhen)
    : session.doneWhen;
  const verificationInput = updatesDefinition
    ? projectVerificationPoliciesInput(
        input.verificationPolicies,
        inputDoneWhen,
        projectGoalVerificationPolicies(activeProjectGoal(session)),
      )
    : {};
  if (verificationInput.error) return verificationInput.error;
  const nextUserAcceptancePolicy = updatesDefinition && Object.prototype.hasOwnProperty.call(input, 'userAcceptancePolicy')
    ? normalizeProjectUserAcceptancePolicy(input.userAcceptancePolicy)
    : projectGoalUserAcceptancePolicy(activeProjectGoal(session));
  if (updatesDefinition) {
    const owns = (field: string) => Object.prototype.hasOwnProperty.call(input, field);
    changesUserPlan = (owns('goal') && String(input.goal || '').trim() !== session.goal.trim())
      || (owns('projectScope') && String(input.projectScope || '').trim() !== String(session.projectScope || '').trim())
      || (owns('preconditions')
        && JSON.stringify(projectStringArray(input.preconditions)) !== JSON.stringify(session.preconditions))
      || (owns('doneWhen')
        && JSON.stringify(projectStringArray(input.doneWhen)) !== JSON.stringify(session.doneWhen))
      || (owns('userAcceptancePolicy')
        && nextUserAcceptancePolicy !== projectGoalUserAcceptancePolicy(activeProjectGoal(session)))
      || (owns('verificationPolicies')
        && JSON.stringify(verificationInput.policies) !== JSON.stringify(projectGoalVerificationPolicies(activeProjectGoal(session))))
      || owns('planFiles');
  }
  if (!['update', 'update-definition', 'goal-plan', 'task-create', 'task-update'].includes(action)) return null;
  const confirmationScope = [
    ...(updatesDefinition && Object.prototype.hasOwnProperty.call(input, 'goal')
      && String(input.goal || '').trim() !== session.goal.trim()
      ? [`goal: ${String(input.goal || '').trim()}`] : []),
    ...(updatesDefinition && Object.prototype.hasOwnProperty.call(input, 'projectScope')
      && String(input.projectScope || '').trim() !== String(session.projectScope || '').trim()
      ? [`projectScope: ${String(input.projectScope || '').trim() || '（空）'}`] : []),
    ...(updatesDefinition && Object.prototype.hasOwnProperty.call(input, 'preconditions')
      && JSON.stringify(projectStringArray(input.preconditions)) !== JSON.stringify(session.preconditions)
      ? [`preconditions: ${projectStringArray(input.preconditions).join('；') || '（空）'}`] : []),
    ...(updatesDefinition && Object.prototype.hasOwnProperty.call(input, 'doneWhen')
      && JSON.stringify(projectStringArray(input.doneWhen)) !== JSON.stringify(session.doneWhen)
      ? [`doneWhen: ${projectStringArray(input.doneWhen).join('；') || '（空）'}`] : []),
    ...(updatesDefinition && Object.prototype.hasOwnProperty.call(input, 'userAcceptancePolicy')
      && nextUserAcceptancePolicy !== projectGoalUserAcceptancePolicy(activeProjectGoal(session))
      ? [`userAcceptancePolicy: ${nextUserAcceptancePolicy}`] : []),
    ...(updatesDefinition && Object.prototype.hasOwnProperty.call(input, 'verificationPolicies')
      && JSON.stringify(verificationInput.policies) !== JSON.stringify(projectGoalVerificationPolicies(activeProjectGoal(session)))
      ? [`verificationPolicies: ${(verificationInput.policies || []).map((policy) => `${policy.criterion}=${policy.riskClass || 'protected'}/${policy.requirement}${policy.reason ? `（${policy.reason}）` : ''}`).join('；')}`] : []),
    ...(updatesDefinition && Object.prototype.hasOwnProperty.call(input, 'planFiles')
      ? [`planFiles: ${(Array.isArray(input.planFiles) ? input.planFiles : []).map((file: any) => String(file?.path || file?.name || '')).filter(Boolean).join('；') || '（空）'}`] : []),
    ...supplements.map((supplement) => `supplement: ${supplement}`),
  ];
  return projectPlanningConfirmationError(session, {
    changesUserPlan,
    supplements,
    confirmationScope,
    userConfirmationEventId: String(
      input?.userConfirmationEventId ?? params?.userConfirmationEventId ?? '',
    ),
  });
}

function closeLiveSurfaceById(surfaceId: SurfaceId): boolean {
  const store = useStore.getState();
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      if (!findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => surface.id === surfaceId)) continue;
      store.closeSurface(workspace.id, paneId, surfaceId);
      return true;
    }
  }
  return false;
}

function projectSupervisorLaneIds(session: Pick<ProjectManagerSession, 'id'>): string[] {
  return scopedProjectSupervisorLaneIds(session, useStore.getState().supervisor.lanes);
}

function projectSupervisorDecisionGuardMatchesWorkItem(
  session: ProjectManagerSession,
  item: ProjectManagerSession['workItems'][number],
  lane: SupervisorLane,
): boolean {
  const guard = lane.supervisorDecisionErrorGuard;
  if (!guard?.blocked) return false;
  return guard.workItemId === item.id
    && guard.requirementsVersion === (item.requirementsVersion ?? projectRequirementsVersion(session))
    && guard.authorizationVersion === (item.authorizationVersion ?? projectAuthorizationVersion(session))
    && guard.contractSignature === supervisorDecisionTextSignature(JSON.stringify(
      stableSupervisorDecisionValue(item.contract),
  ));
}

function releaseProjectWorkItemAssignmentForReuse(
  session: ProjectManagerSession,
  workItemId: string,
  reason: string,
): SupervisorLane[] {
  const store = useStore.getState();
  const retained: SupervisorLane[] = [];
  const candidates = store.supervisor.lanes.filter((lane) => (
    lane.projectManagerProjectId === session.id
    && lane.projectWorkItemId === workItemId
    && supervisorLaneControlState(lane) !== 'stopped'
  ));
  for (const candidate of candidates) {
    const lane = useStore.getState().supervisor.lanes.find((item) => item.id === candidate.id);
    if (!lane || lane.projectWorkItemId !== workItemId) continue;
    const taskTerminal = remoteSurfaceTerminalLocation(lane.surfaceId);
    if (taskTerminal?.surface.projectManagerWorkItemId === workItemId) {
      store.updateSurface(taskTerminal.workspaceId, taskTerminal.paneId, taskTerminal.surfaceId, {
        projectManagerWorkItemId: undefined,
        customTitle: '任务 AI',
      });
    }
    store.updateLane(lane.id, {
      projectWorkItemId: undefined,
      projectAssignmentVersion: undefined,
      projectAssignmentConfirmedVersion: undefined,
      projectTaskContractPending: false,
      projectTaskBatch: undefined,
      projectTaskRotationPending: false,
      projectTaskRotationSummary: undefined,
      projectTaskRotationRequestedAt: undefined,
      currentTask: '',
      awaitingReview: false,
      awaitingStopCheck: false,
      awaitingDirectionAfterWaitingResume: false,
      stopConfirmed: false,
      activeReviewId: undefined,
      reviewWorkerTurnId: undefined,
      reviewOpenedAt: undefined,
      reviewDeliveryConfirmedAt: undefined,
      reviewWatchdogState: undefined,
      autoDecisionLimitReached: false,
      supervisorDecisionErrorGuard: undefined,
      pendingSupervisorDeliveries: (lane.pendingSupervisorDeliveries || [])
        .filter((delivery) => delivery.bootstrapOnRuntimeReady),
      controlState: session.status === 'active' ? 'active' : 'paused',
      config: {
        ...effectiveSupervisorLaneConfig(lane),
        taskGoal: session.goal,
        taskDescription: '当前没有活动工作项，等待项目 AI 交付下一项成果任务。',
        waitForNextDirection: true,
      },
    });
    store.appendSupervisorLog(lane.id, '工作项解绑，保留项目运行时', reason);
    const current = useStore.getState().supervisor.lanes.find((item) => item.id === lane.id);
    if (current) retained.push(current);
  }
  return retained;
}

function resumeEligibleProjectSupervisorLanes(sessionId: string, reason: string): void {
  const state = useStore.getState();
  const session = state.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session) return;
  const activeGoalId = activeProjectGoal(session).id;
  for (const lane of state.supervisor.lanes.filter((candidate) => (
    candidate.projectManagerProjectId === sessionId && supervisorLaneControlState(candidate) !== 'stopped'
  ))) {
    const item = session.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
    const eligible = !!item
      && item.goalId === activeGoalId
      && !['completed', 'stopped'].includes(item.status)
      && item.requirementsVersion === projectRequirementsVersion(session)
      && item.authorizationVersion === projectAuthorizationVersion(session)
      && (!item.subgoalId || !projectWorkItemSubgoalDependencyError(session, item));
    const correctionGuardMatches = !!item && projectSupervisorDecisionGuardMatchesWorkItem(session, item, lane);
    if (eligible && !correctionGuardMatches) {
      if (lane.supervisorDecisionErrorGuard?.blocked) {
        state.updateLane(lane.id, { supervisorDecisionErrorGuard: undefined });
      }
      state.resumeSupervisorLane(lane.id, reason);
    } else {
      state.pauseSupervisorLane(
        lane.id,
        correctionGuardMatches
          ? '监督裁决仍处于同一协议纠错范围；必须先由项目 AI 实质更新工作项合同或版本'
          : '监督链尚未绑定当前主目标的可执行任务，保持暂停直到项目 AI 重新派发',
      );
    }
  }
}

/** A lane flag alone is not proof of liveness; only running bound work owns execution. */
function projectSupervisorLaneProvidesActiveExecution(
  session: ProjectManagerSession,
  lane: SupervisorLane,
): boolean {
  if (lane.projectManagerProjectId !== session.id
    || lane.projectRuntimeHandover?.state === 'candidate'
    || supervisorLaneControlState(lane) !== 'active') return false;
  const item = session.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
  return !!item
    && item.status === 'running'
    && item.goalId === activeProjectGoal(session).id
    && item.requirementsVersion === projectRequirementsVersion(session)
    && item.authorizationVersion === projectAuthorizationVersion(session);
}

function pauseProjectSupervisorLanesForWorkItem(
  session: ProjectManagerSession,
  workItemId: string,
  reason: string,
): string[] {
  const store = useStore.getState();
  const pausedLaneIds: string[] = [];
  for (const lane of store.supervisor.lanes.filter((candidate) => (
    candidate.projectManagerProjectId === session.id
    && candidate.projectWorkItemId === workItemId
    && supervisorLaneControlState(candidate) === 'active'
  ))) {
    store.pauseSupervisorLane(lane.id, reason);
    pausedLaneIds.push(lane.id);
  }
  return pausedLaneIds;
}

async function recoverPausedWorkItemActiveLaneConflict(
  session: ProjectManagerSession,
): Promise<ProjectManagerSession | undefined> {
  if (session.status !== 'active' || session.pendingUserQuestion) return undefined;
  const pausedItems = session.workItems.filter((item) => item.status === 'paused');
  const reconciled = pausedItems.flatMap((item) => pauseProjectSupervisorLanesForWorkItem(
    session,
    item.id,
    '控制层恢复时发现工作项已暂停；同步暂停伪活动监督通道并交回项目 AI 续作',
  ).map((laneId) => ({ laneId, workItemId: item.id })));
  if (reconciled.length === 0) return undefined;
  await appendRecordedProjectEvent(session, {
    kind: 'work-item-updated',
    workItemId: reconciled[0].workItemId,
    summary: '控制层已修复“暂停工作项仍保留 active 监督通道”的持久化状态冲突',
    payload: {
      reason: 'paused-work-item-active-lane-reconciled',
      reconciled,
      attentionRequired: false,
    },
  });
  return useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
}

function projectExecutionWorkspaceId(lane: SupervisorLane): WorkspaceId | undefined {
  if (!lane.supervisorSurfaceId || !lane.projectManagerProjectId) return undefined;
  for (const workspace of useStore.getState().workspaces) {
    if (workspace.transientSupervisorWorkspace !== true) continue;
    const ownsSupervisor = getAllPaneIds(workspace.splitTree).some((paneId) => (
      findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
        surface.id === lane.supervisorSurfaceId
        && surface.type === 'terminal'
        && surface.projectSupervisorProjectId === lane.projectManagerProjectId
      ))
    ));
    if (ownsSupervisor) return workspace.id;
  }
  return undefined;
}

function projectSafeExitContinuityVerified(session: ProjectManagerSession): boolean {
  const fingerprint = session.safeExit?.progressFingerprint?.trim();
  return !!fingerprint
    && (session.safeExit?.status === 'saved' || session.safeExit?.status === 'restoring')
    && session.progressSnapshot?.fingerprint === fingerprint
    && session.progressSync?.status === 'ready'
    && session.progressSync.snapshotFingerprint === fingerprint
    && projectOrientationReady(session);
}

function replaceProjectManagerSession(session: ProjectManagerSession): void {
  const state = useStore.getState();
  state.restoreProjectManagers(
    state.projectManagers.map((candidate) => candidate.id === session.id ? session : candidate),
    state.selectedProjectManagerId || undefined,
  );
}

function projectProgressSummary(
  diff: ProjectProgressDiff,
  current: ProjectProgressSnapshot,
  previous?: ProjectProgressSnapshot,
): string {
  const changedPaths = [...new Set([...diff.added, ...diff.modified, ...diff.removed])];
  const currentWorkspaceEntries = current.entries.filter((entry) => entry.source === 'workspace');
  const currentPlanEntries = current.entries.filter((entry) => entry.source === 'plan');
  return [
    diff.baselineMissing
      ? '缺少恢复前可信工作区指纹；本次现状必须由项目 AI 复核后才能继续派发。'
      : diff.changed
        ? '项目目录与上次已知进度不一致，可能包含其他 AI、人工操作或中断前尚未汇报的工作。'
        : '项目目录与上次已知进度一致。',
    `采集方式：${current.mode === 'git' ? 'Git 工作区' : '有界文件系统快照'}；当前指纹：${current.fingerprint.slice(0, 16)}`,
    diff.headChanged ? `Git HEAD：${previous?.head?.slice(0, 12) || '无'} → ${current.head?.slice(0, 12) || '无'}` : '',
    diff.headChanged && current.headSummary ? `当前提交：${current.headSummary}` : '',
    diff.branchChanged ? `Git 分支：${previous?.branch || '无'} → ${current.branch || '无'}` : '',
    `差异统计：新增记录 ${diff.added.length}、内容/状态变化 ${diff.modified.length}、不再出现 ${diff.removed.length}。`,
    current.mode === 'git'
      ? `当前未提交/未跟踪文件记录：${currentWorkspaceEntries.length}`
      : `当前纳入快照的项目文件：${currentWorkspaceEntries.length}`,
    currentPlanEntries.length > 0 ? `计划文件快照：${currentPlanEntries.length} 个。` : '',
    changedPaths.length > 0
      ? `主要变化：\n${changedPaths.slice(0, 40).map((filePath) => `- ${filePath}`).join('\n')}`
      : '',
    changedPaths.length > 40 ? `另有 ${changedPaths.length - 40} 项变化未展开。` : '',
    current.truncated ? '快照已达到 500 项上限；项目 AI 必须结合 git/status 做补充只读核对。' : '',
  ].filter(Boolean).join('\n').slice(0, 12_000);
}

async function captureProjectProgressSnapshot(
  session: ProjectManagerSession,
): Promise<{ snapshot?: ProjectProgressSnapshot; error?: string }> {
  const capture = (window as any).wmux?.projectManager?.captureProgress;
  if (typeof capture !== 'function') return { error: '项目进度同步接口尚未就绪，请重启 wmux' };
  try {
    const result = await capture(session.projectDir, (session.planFiles || []).map((file) => file.path));
    if (!result?.ok || !result.snapshot) return { error: String(result?.error || '无法采集项目目录现状') };
    return { snapshot: result.snapshot as ProjectProgressSnapshot };
  } catch (error) {
    return { error: String((error as Error)?.message || error) };
  }
}

function progressSyncFailureSession(session: ProjectManagerSession, reason: string): ProjectManagerSession {
  const failed: ProjectManagerSession = {
    ...session,
    progressSync: {
      status: 'review-required',
      checkedAt: Date.now(),
      snapshotFingerprint: session.progressSnapshot?.fingerprint || 'capture-unavailable',
      summary: `项目目录现状采集失败：${reason}`,
      changeCount: 0,
      reason,
    },
    updatedAt: Date.now(),
  };
  return {
    ...failed,
    orientation: requiredProjectOrientation(failed, `项目目录现状采集失败：${reason}`),
  };
}

async function scanProjectProgressForReview(
  sessionId: string,
  reason: string,
  notifyManager = true,
): Promise<{ ok: boolean; reviewRequired: boolean; summary: string; error?: string }> {
  const initial = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!initial) return { ok: false, reviewRequired: true, summary: '', error: '项目不存在' };
  const captured = await captureProjectProgressSnapshot(initial);
  if (!captured.snapshot) {
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
    const failed = progressSyncFailureSession(current, captured.error || '未知错误');
    replaceProjectManagerSession(failed);
    useStore.getState().appendProjectManagerEvent({
      kind: 'progress-sync-required',
      summary: failed.progressSync!.summary,
      payload: { reason, captureFailed: true },
    }, sessionId);
    saveProjectManagerSnapshot(sessionId);
    if (notifyManager) queueProjectManagerDelivery([
      '[项目进度同步失败｜禁止沿用旧安排]',
      `项目：${sessionId} · ${initial.projectDir}`,
      failed.progressSync!.summary,
      '请检查项目目录可访问性；恢复同步前不得创建或派发旧任务。',
    ].join('\n'), sessionId);
    return { ok: false, reviewRequired: true, summary: failed.progressSync!.summary, error: captured.error };
  }
  const latest = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
  const current = captured.snapshot;
  const diff = diffProjectProgressSnapshots(latest.progressSnapshot, current);
  const pendingReview = latest.progressSync?.status === 'review-required';
  const reviewRequired = diff.changed || pendingReview;
  const incrementalSummary = projectProgressSummary(diff, current, latest.progressSnapshot);
  const summary = !diff.changed && pendingReview && latest.progressSync?.summary
    ? latest.progressSync.summary
    : diff.changed && pendingReview && latest.progressSync?.summary
      ? [
          latest.progressSync.summary,
          '',
          '[项目 AI 复核期间工作区再次变化]',
          incrementalSummary,
        ].join('\n').slice(0, 12_000)
      : incrementalSummary;
  const changeCount = diff.changed && pendingReview
    ? (latest.progressSync?.changeCount || 0) + diff.changeCount
    : diff.changeCount;
  const stateChanged = diff.changed
    || !latest.progressSync
    || latest.progressSync.snapshotFingerprint !== current.fingerprint;
  const next: ProjectManagerSession = {
    ...latest,
    progressSnapshot: current,
    progressSync: {
      status: reviewRequired ? 'review-required' : 'ready',
      checkedAt: Date.now(),
      snapshotFingerprint: current.fingerprint,
      summary,
      changeCount,
      reason,
      ...(!reviewRequired ? { acknowledgedAt: Date.now(), acknowledgement: '控制层确认工作区未变化' } : {}),
    },
    workItems: diff.changed
      ? latest.workItems.map((item) => ['completed', 'stopped'].includes(item.status)
        ? item
        : { ...item, updatedAt: Date.now() })
      : latest.workItems,
    updatedAt: Date.now(),
  };
  if (diff.changed || !latest.orientation || latest.orientation.status === 'required') {
    next.orientation = requiredProjectOrientation(
      next,
      diff.changed
        ? `项目目录出现外部进度变化：${reason}`
        : latest.orientation?.reason || '项目尚未建立认知基线',
      latest.orientation?.status === 'required' ? latest.orientation.requestedAt : Date.now(),
    );
  } else {
    next.orientation = { ...latest.orientation, snapshotFingerprint: current.fingerprint };
  }
  replaceProjectManagerSession(next);
  if (stateChanged) {
    useStore.getState().appendProjectManagerEvent({
      kind: reviewRequired ? 'progress-sync-required' : 'progress-snapshot',
      summary: reviewRequired ? '检测到恢复期间的项目进度变化，等待项目 AI 复核' : '项目进度快照与已知状态一致',
      payload: {
        reason,
        fingerprint: current.fingerprint,
        mode: current.mode,
        changeCount,
        baselineMissing: diff.baselineMissing,
        summary,
      },
    }, sessionId);
    if (next.orientation.status === 'required') {
      useStore.getState().appendProjectManagerEvent({
        kind: 'project-orientation-required',
        summary: next.orientation.reason,
        payload: {
          reason,
          fingerprint: current.fingerprint,
          requirementsVersion: next.orientation.requirementsVersion,
          authorizationVersion: next.orientation.authorizationVersion,
        },
      }, sessionId);
    }
  }
  saveProjectManagerSnapshot(sessionId);
  if (reviewRequired && stateChanged && notifyManager) {
    queueProjectManagerDelivery([
      '[项目进度同步｜继续前必须由项目 AI 复核]',
      `项目：${sessionId} · ${latest.projectDir}`,
      `触发原因：${reason}`,
      summary,
      '',
      '把当前目录事实视为权威：先结合这里列出的提交/路径变化与持久化证据调整工作项和阶段安排。哈希与路径只证明“发生了变化”，不证明语义正确或已经完成；无法从现有证据判断的部分保持未完成，并交给恢复后的监督/任务 AI 通过强制新基线做只读核对。不要覆盖、回滚或从头重做未知来源的已有工作。',
      `更新安排后执行 wmux project progress-sync --project ${sessionId} --ack --summary "<已知变化、未知项和下一步核对安排>"。该确认只表示后续调度已改用当前快照，不代表代码正确或验收完成。确认前控制层拒绝 resume、task-create 和 dispatch；这不需要询问用户，除非变化引出了真正的业务选择或高风险冲突。`,
    ].join('\n'), sessionId);
  }
  return { ok: true, reviewRequired, summary };
}

async function checkpointProjectProgress(sessionId: string, reason: string): Promise<boolean> {
  const initial = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!initial) return false;
  if (initial.progressSync?.status === 'review-required') return false;
  const captured = await captureProjectProgressSnapshot(initial);
  if (!captured.snapshot) {
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
    const failed = progressSyncFailureSession(current, captured.error || '未知错误');
    replaceProjectManagerSession(failed);
    useStore.getState().appendProjectManagerEvent({
      kind: 'progress-sync-required',
      summary: failed.progressSync!.summary,
      payload: { reason, captureFailed: true },
    }, sessionId);
    saveProjectManagerSnapshot(sessionId);
    queueProjectManagerDelivery([
      '[项目进度检查点保存失败｜继续前必须复核]',
      `项目：${sessionId} · ${initial.projectDir}`,
      failed.progressSync!.summary,
      '项目 AI 必须先恢复目录访问并重新执行 progress-sync；不得按旧工作区信息继续派发。',
    ].join('\n'), sessionId);
    return false;
  }
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
  const next: ProjectManagerSession = {
    ...current,
    progressSnapshot: captured.snapshot,
    progressSync: {
      status: 'ready',
      checkedAt: Date.now(),
      snapshotFingerprint: captured.snapshot.fingerprint,
      summary: `已记录可信项目进度检查点：${reason}`,
      changeCount: 0,
      reason,
      acknowledgedAt: Date.now(),
      acknowledgement: reason,
    },
    updatedAt: Date.now(),
  };
  next.orientation = current.orientation?.status === 'ready'
    ? { ...current.orientation, snapshotFingerprint: captured.snapshot.fingerprint }
    : requiredProjectOrientation(
        next,
        current.orientation?.reason || reason,
        current.orientation?.requestedAt || Date.now(),
      );
  replaceProjectManagerSession(next);
  useStore.getState().appendProjectManagerEvent({
    kind: 'progress-snapshot',
    summary: `已记录项目进度检查点：${reason}`,
    payload: { fingerprint: captured.snapshot.fingerprint, mode: captured.snapshot.mode },
  }, sessionId);
  saveProjectManagerSnapshot(sessionId);
  return true;
}

async function acknowledgeProjectProgress(
  sessionId: string,
  acknowledgement: string,
): Promise<{ ok: boolean; error?: string; summary?: string }> {
  const initial = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!initial) return { ok: false, error: '项目不存在' };
  const detail = acknowledgement.trim().slice(0, 4000);
  if (!detail) return { ok: false, error: '确认项目进度同步必须提供 --summary，说明变化影响和后续安排' };
  const captured = await captureProjectProgressSnapshot(initial);
  if (!captured.snapshot) return { ok: false, error: captured.error || '无法复核项目目录现状' };
  const latest = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
  if (!latest.progressSnapshot || captured.snapshot.fingerprint !== latest.progressSnapshot.fingerprint) {
    await scanProjectProgressForReview(sessionId, '项目 AI 复核期间工作区再次变化');
    return { ok: false, error: '项目 AI 复核期间工作区再次变化，已刷新同步摘要；请按最新现状重新复核' };
  }
  if (latest.progressSync?.status !== 'review-required') {
    return { ok: true, summary: latest.progressSync?.summary || '项目进度已经同步，无需重复确认' };
  }
  const now = Date.now();
  const next: ProjectManagerSession = {
    ...latest,
    progressSnapshot: captured.snapshot,
    progressSync: {
      ...latest.progressSync,
      status: 'ready',
      checkedAt: now,
      snapshotFingerprint: captured.snapshot.fingerprint,
      acknowledgedAt: now,
      acknowledgement: detail,
    },
    updatedAt: now,
  };
  replaceProjectManagerSession(next);
  useStore.getState().appendProjectManagerEvent({
    kind: 'progress-sync-acknowledged',
    summary: `项目 AI 已复核外部进度：${detail}`,
    payload: { fingerprint: captured.snapshot.fingerprint, acknowledgement: detail },
  }, sessionId);
  saveProjectManagerSnapshot(sessionId);
  return { ok: true, summary: next.progressSync!.summary };
}

function projectProgressReviewError(session: ProjectManagerSession): string | null {
  if (session.progressSync?.status !== 'review-required') return null;
  return `项目目录存在尚未复核的进度变化，禁止沿用旧合同。先检查 project status 中的 progressSync.summary，再执行 wmux project progress-sync --project ${session.id} --ack --summary "<影响判断和安排>"`;
}

function projectOrientationReviewError(session: ProjectManagerSession): string | null {
  if (projectOrientationReady(session)) return null;
  return `项目认知基线尚未确认，禁止规划或派发。先读取 project status 的目标、前置条件、progressSync、orientation、工作项和最近事件，在 JSON 中原样携带 orientation 的 requirementsVersion、authorizationVersion、snapshotFingerprint、requestedAt，再执行 wmux project orientation-confirm --project ${session.id} --json-file <项目目录内的 .wmux/tmp/文件>。JSON 不能作为位置参数；project inspect 只读，不能解除本门禁`;
}

async function acknowledgeProjectOrientation(
  sessionId: string,
  value: any,
): Promise<{ ok: boolean; error?: string; orientation?: ProjectManagerSession['orientation']; message?: string }> {
  const initial = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!initial) return { ok: false, error: '项目不存在' };
  const progressError = projectProgressReviewError(initial);
  if (progressError) return { ok: false, error: progressError };
  if (projectOrientationReady(initial)) {
    return { ok: true, orientation: initial.orientation };
  }
  if (!initial.progressSnapshot) {
    return { ok: false, error: '项目还没有可信目录快照；请先执行 project progress-sync' };
  }
  const captured = await captureProjectProgressSnapshot(initial);
  if (!captured.snapshot) return { ok: false, error: captured.error || '无法复核项目目录现状' };
  const latest = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
  if (!latest.progressSnapshot || captured.snapshot.fingerprint !== latest.progressSnapshot.fingerprint) {
    await scanProjectProgressForReview(sessionId, '项目认知基线确认期间工作区再次变化');
    return { ok: false, error: '认知基线确认期间工作区再次变化，已刷新进度摘要；请按最新状态重新确认' };
  }
  const expected = latest.orientation?.status === 'required' ? latest.orientation : undefined;
  if (!expected) {
    const orientation = requiredProjectOrientation(latest, '项目认知基线状态缺失，需要刷新后重新确认');
    replaceProjectManagerSession({ ...latest, orientation, updatedAt: Date.now() });
    saveProjectManagerSnapshot(sessionId);
    return { ok: false, error: '项目认知基线版本已刷新；请重新读取 project status 后提交' };
  }
  if (Number(value?.requirementsVersion) !== expected.requirementsVersion
    || Number(value?.authorizationVersion) !== expected.authorizationVersion
    || String(value?.snapshotFingerprint || '') !== expected.snapshotFingerprint
    || Number(value?.requestedAt) !== expected.requestedAt) {
    return {
      ok: false,
      error: '项目目标、授权、目录快照或认知请求版本已变化；请重新读取 project status，不能提交旧认知结果',
    };
  }
  if (projectRequirementsAlignmentPending(latest)) {
    return { ok: false, error: '首次需求充分性检测尚未完成；请先提交 alignment-confirm，再确认项目认知基线' };
  }
  const summary = String(value?.summary || '').trim().slice(0, 12_000);
  const normalizeFacts = (input: unknown, label: string): { values?: string[]; error?: string } => {
    if (!Array.isArray(input) || input.length > 100 || input.some((entry) => typeof entry !== 'string')) {
      return { error: `${label} 必须是最多 100 项的字符串数组` };
    }
    return { values: input.map((entry) => entry.trim().slice(0, 4000)).filter(Boolean) };
  };
  const knownFacts = normalizeFacts(value?.knownFacts, 'knownFacts');
  const unknowns = normalizeFacts(value?.unknowns, 'unknowns');
  if (!summary) return { ok: false, error: '项目认知基线必须提供 summary，说明当前目标、进度和下一步方向' };
  if (knownFacts.error || !knownFacts.values?.length) {
    return { ok: false, error: knownFacts.error || 'knownFacts 至少需要一项有证据支持的已知事实' };
  }
  if (unknowns.error) return { ok: false, error: unknowns.error };
  if (!Array.isArray(value?.workItems)) {
    return { ok: false, error: 'workItems 必须逐项覆盖当前所有未停止工作项；没有工作项时传空数组' };
  }
  const requiredItems = latest.workItems.filter((item) => item.status !== 'stopped');
  const reviews: ProjectOrientationWorkItemReview[] = [];
  const seen = new Set<string>();
  for (const raw of value.workItems as any[]) {
    const workItemId = String(raw?.workItemId || '').trim().slice(0, 200);
    const disposition = String(raw?.disposition || '') as ProjectOrientationDisposition;
    const basis = String(raw?.basis || '').trim().slice(0, 4000);
    const nextAction = String(raw?.nextAction || '').trim().slice(0, 4000);
    if (!workItemId || seen.has(workItemId)) {
      return { ok: false, error: `工作项认知记录缺少 ID 或重复：${workItemId || '空 ID'}` };
    }
    if (!PROJECT_ORIENTATION_DISPOSITIONS.includes(disposition)) {
      return { ok: false, error: `工作项 ${workItemId} 的 disposition 无效` };
    }
    if (!basis || !nextAction) return { ok: false, error: `工作项 ${workItemId} 必须同时提供 basis 和 nextAction` };
    seen.add(workItemId);
    reviews.push({ workItemId, disposition, basis, nextAction });
  }
  const expectedIds = new Set(requiredItems.map((item) => item.id));
  const unknownReview = reviews.find((review) => !expectedIds.has(review.workItemId));
  const missingItem = requiredItems.find((item) => !seen.has(item.id));
  if (unknownReview || missingItem || reviews.length !== requiredItems.length) {
    return {
      ok: false,
      error: unknownReview
        ? `认知记录包含不存在或已停止的工作项：${unknownReview.workItemId}`
        : `认知记录未覆盖工作项：${missingItem?.id || '数量不一致'}`,
    };
  }
  const activeGoal = activeProjectGoal(latest);
  for (const review of reviews) {
    const item = requiredItems.find((candidate) => candidate.id === review.workItemId)!;
    if (item.status === 'completed' && review.disposition !== 'retain-completed') {
      return { ok: false, error: `已完成工作项 ${item.id} 只能选择 retain-completed，保留为证据` };
    }
    if (item.status !== 'completed' && review.disposition === 'retain-completed') {
      return { ok: false, error: `未完成工作项 ${item.id} 不能选择 retain-completed` };
    }
    if (['continue', 'verify'].includes(review.disposition) && (
      item.goalId !== activeGoal.id
      || item.requirementsVersion !== projectRequirementsVersion(latest)
      || item.authorizationVersion !== projectAuthorizationVersion(latest)
    )) {
      return { ok: false, error: `工作项 ${item.id} 属于旧目标、旧需求或旧授权版本，只能 pause 或 stop，不能继续执行` };
    }
  }
  const now = Date.now();
  const reviewById = new Map(reviews.map((review) => [review.workItemId, review]));
  const workItems = latest.workItems.map((item) => {
    const review = reviewById.get(item.id);
    if (!review || review.disposition === 'retain-completed') return item;
    if (review.disposition === 'stop') {
      return {
        ...item,
        status: 'stopped' as const,
        workerSurfaceId: undefined,
        supervisorLaneId: undefined,
        latestBlocker: undefined,
        updatedAt: now,
      };
    }
    if (review.disposition === 'pause') {
      return { ...item, status: 'paused' as const, latestBlocker: review.basis, updatedAt: now };
    }
    return {
      ...item,
      status: ['waiting-decision', 'paused', 'failed', 'running', 'validating'].includes(item.status)
        ? 'planned' as const
        : item.status,
      latestBlocker: undefined,
      updatedAt: now,
    };
  });
  const orientation: NonNullable<ProjectManagerSession['orientation']> = {
    status: 'ready',
    requirementsVersion: projectRequirementsVersion(latest),
    authorizationVersion: projectAuthorizationVersion(latest),
    snapshotFingerprint: captured.snapshot.fingerprint,
    reason: latest.orientation?.reason || '项目 AI 主动建立项目认知基线',
    requestedAt: latest.orientation?.requestedAt || now,
    summary,
    knownFacts: knownFacts.values,
    unknowns: unknowns.values || [],
    workItems: reviews,
    acknowledgedAt: now,
  };
  replaceProjectManagerSession({ ...latest, progressSnapshot: captured.snapshot, orientation, workItems, updatedAt: now });
  useStore.getState().appendProjectManagerEvent({
    kind: 'project-orientation-confirmed',
    summary: `项目 AI 已建立当前认知基线：${summary}`,
    payload: {
      requirementsVersion: orientation.requirementsVersion,
      authorizationVersion: orientation.authorizationVersion,
      snapshotFingerprint: orientation.snapshotFingerprint,
      reviewedWorkItems: reviews.length,
    },
  }, sessionId);
  saveProjectManagerSnapshot(sessionId);
  return {
    ok: true,
    orientation,
    message: '项目认知基线已确认；下一步处理旧版本工作项并保存当前目标阶段计划，完成后显式恢复项目。',
  };
}function restoredProjectManagerSession(
  session: ProjectManagerSession,
  managerSurfaceId?: string,
  recoverySource: 'restart' | 'safe-exit' = 'restart',
): ProjectManagerSession {
  const now = Date.now();
  const recoveryLabel = recoverySource === 'safe-exit' ? '安全退出' : '应用重启';
  const normalized = normalizeProjectManagerSession(session);
  const checkpointFingerprint = normalized.safeExit?.progressFingerprint?.trim();
  const checkpointMatchesPersistedProgress = !!checkpointFingerprint
    && normalized.progressSnapshot?.fingerprint === checkpointFingerprint;
  const savedSafeExitCheckpoint = normalized.safeExit?.status === 'saved'
    || normalized.safeExit?.status === 'restoring';
  const preserveSafeExitCheckpoint = checkpointMatchesPersistedProgress
    && (recoverySource === 'safe-exit' || savedSafeExitCheckpoint);
  const interruptedSafeExit = recoverySource === 'restart'
    && normalized.safeExit?.status === 'saving';
  const interruptedSafeExitEvent = interruptedSafeExit ? {
    id: uuid(),
    sessionId: normalized.id,
    ts: now,
    kind: 'project-safe-exit-failed' as const,
    summary: '软件在安全退出完成前关闭；该记录按异常重启恢复，不能宣称已保存断点',
    payload: {
      attentionRequired: true,
      phase: 'application-closed-before-safe-exit-completed',
    },
  } : undefined;
  const restoreMisclassifiedGoalClosure = projectGoalClosurePauseWasMisclassified(normalized);
  const goalClosureRecoveryEvent = restoreMisclassifiedGoalClosure ? {
    id: uuid(),
    sessionId: normalized.id,
    ts: now,
    kind: 'recovery-restored' as const,
    summary: '已恢复被旧版通用死锁逻辑误暂停的目标收口，继续执行目标级验收',
    payload: {
      recoverySource: 'goal-closure-state-migration',
      resolvedAttentionKinds: ['guard-triggered', 'project-execution-stalled', 'project-paused'],
    },
  } : undefined;
  const recoveryEvents = [
    ...normalized.events,
    ...(interruptedSafeExitEvent ? [interruptedSafeExitEvent] : []),
    ...(goalClosureRecoveryEvent ? [goalClosureRecoveryEvent] : []),
  ].slice(-500);
  const restored: ProjectManagerSession = {
    ...normalized,
    status: restoreMisclassifiedGoalClosure ? 'active' : normalized.status,
    preconditions: projectStringArray(normalized.preconditions),
    planFiles: Array.isArray(normalized.planFiles) ? normalized.planFiles : [],
    requirementsVersion: projectRequirementsVersion(normalized),
    authorizationVersion: projectAuthorizationVersion(normalized),
    acceptedRequirementsVersion: projectAcceptedRequirementsVersion(normalized),
    executionProtocolVersion: CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION,
    managerSurfaceId,
    taskTerminalSurfaceId: undefined,
    recoveryState: 'checking' as const,
    repositoryBootstrapPending: true,
    safeExit: recoverySource === 'restart' && normalized.safeExit
      ? {
          ...normalized.safeExit,
          status: 'restoring' as const,
          updatedAt: now,
          error: undefined,
        }
      : normalized.safeExit,
    pendingManagerDeliveries: resetProjectManagerDeliveryAcknowledgements(
      compactProjectManagerPendingDeliveries(
        normalized.pendingManagerDeliveries,
        new Set((normalized.pendingSupervisorTransitions || []).map((transition) => transition.id)),
      ),
    ),
    events: recoveryEvents,
    updatedAt: now,
    workItems: normalized.workItems.map((item: ProjectWorkItem) => {
      const interrupted = ['running', 'validating'].includes(item.status);
      const hadRuntimeBinding = !!item.workerSurfaceId || !!item.supervisorLaneId;
      const needsRecovery = hadRuntimeBinding && !['completed', 'stopped'].includes(item.status);
      return {
        ...item,
        workerSurfaceId: undefined,
        supervisorLaneId: undefined,
        startedAt: undefined,
        executionProtocolVersion: item.executionProtocolVersion || 0,
        status: preserveSafeExitCheckpoint
          ? item.status
          : interrupted ? 'waiting-decision' : item.status,
        latestBlocker: preserveSafeExitCheckpoint
          ? item.latestBlocker
          : needsRecovery
              ? [
                  `${recoveryLabel}后原 AI 监督和任务终端对话已失效；项目管理 AI 必须基于恢复包建立新链路`,
                  item.latestBlocker ? `重启前阻塞：${item.latestBlocker}` : '',
                ].filter(Boolean).join('；')
              : item.latestBlocker,
        updatedAt: needsRecovery || interrupted
          ? now
          : item.updatedAt,
      };
    }),
  };
  return {
    ...restored,
    orientation: preserveSafeExitCheckpoint && restored.orientation
      ? restored.orientation
      : requiredProjectOrientation(
          restored,
          recoverySource === 'safe-exit'
            ? '项目安全退出后，需要根据持久记录、终端检查点和当前目录重新建立项目认知基线'
            : '软件重启恢复后，需要根据持久记录和当前目录重新建立项目认知基线',
          now,
        ),
  };
}

/** No persisted project owns a reusable Agent process after application recovery. */
function discardRestoredProjectRuntime(): void {
  const store = useStore.getState();
  const staleLanes = store.supervisor.lanes.filter((lane) => !!lane.projectManagerProjectId);
  closeStoppedSupervisorSurfaces(staleLanes);
  for (const lane of staleLanes) {
    if (lane.supervisorSurfaceId) clearManagedAgentWatchdog(lane.supervisorSurfaceId);
    clearManagedAgentWatchdog(lane.surfaceId);
    closeLiveSurfaceById(lane.surfaceId);
    useStore.getState().stopSupervisorLane(lane.id, '恢复历史项目时废弃旧监督与任务运行时，等待创建全新执行链');
  }
}

function projectPlanFileSnapshots(value: unknown): ProjectPlanFileSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PROJECT_PLAN_FILES).filter((file): file is ProjectPlanFileSnapshot => (
    !!file && typeof file === 'object'
    && typeof file.path === 'string' && !!normalizeAbsolutePath(file.path)
    && typeof file.name === 'string' && file.name.trim().length > 0
    && typeof file.content === 'string'
    && new TextEncoder().encode(file.content).byteLength <= MAX_PROJECT_PLAN_FILE_BYTES
    && Number.isFinite(file.sizeBytes) && file.sizeBytes >= 0 && file.sizeBytes <= MAX_PROJECT_PLAN_FILE_BYTES
    && Number.isFinite(file.mtimeMs) && Number.isFinite(file.capturedAt)
  )).map((file) => ({
    path: file.path,
    name: file.name.trim(),
    content: file.content,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    capturedAt: file.capturedAt,
  }));
}

function normalizeProjectManagerUserQuestion(
  value: any,
  previousStatus: ProjectManagerSession['status'],
): { question?: ProjectManagerUserQuestion; error?: string } {
  const question = String(value?.question || '').trim().slice(0, 2000);
  const context = String(value?.context || '').trim().slice(0, 5000);
  const category = value?.category === 'manual-intervention' ? 'manual-intervention' : 'clarification';
  if (!question) return { error: '用户澄清问题不能为空' };
  const rawOptions = Array.isArray(value?.options) ? value.options : [];
  const maxOptions = value?.reasonCode === 'verification-limited' ? 5 : 4;
  if (rawOptions.length < 2 || rawOptions.length > maxOptions) {
    return { error: `用户澄清问题必须提供 2-${maxOptions} 个互斥选项` };
  }
  const normalizeScope = (input: unknown, label: string): { scope?: string[]; error?: string } => {
    if (input === undefined) return { scope: undefined };
    if (!Array.isArray(input)) return { error: `${label} 必须是字符串数组` };
    const scope = input.slice(0, 20).map((entry) => String(entry || '').trim().slice(0, 1000));
    if (scope.some((entry) => !entry)) return { error: `${label} 不能包含空变更项` };
    return { scope };
  };
  const normalizedOptionScopes: Array<{ scope?: string[]; error?: string }> = rawOptions.map((option: any, index: number) => (
    normalizeScope(option?.confirmationScope, `选项 ${index + 1} 的 confirmationScope`)
  ));
  const optionScopeError = normalizedOptionScopes.find((result) => result.error)?.error;
  if (optionScopeError) return { error: optionScopeError };
  const options: ProjectManagerQuestionOption[] = rawOptions.map((option: any, index: number) => ({
    id: String(option?.id || `option-${index + 1}`).trim().slice(0, 80),
    label: String(option?.label || '').trim().slice(0, 300),
    description: String(option?.description || '').trim().slice(0, 1000) || undefined,
    ...(normalizedOptionScopes[index].scope !== undefined
      ? { confirmationScope: normalizedOptionScopes[index].scope }
      : {}),
  }));
  if (options.some((option) => !option.id || !option.label) || new Set(options.map((option) => option.id)).size !== options.length) {
    return { error: '用户澄清选项必须具有唯一 id 和非空 label' };
  }
  if (options.some((option) => !option.description)) {
    return { error: '每个用户澄清选项都必须提供 description，说明方案范围、收益、代价或约束' };
  }
  const recommendedOptionId = String(value?.recommendedOptionId || '').trim() || undefined;
  if (!recommendedOptionId) {
    return { error: '用户澄清问题必须设置 recommendedOptionId，明确项目管理 AI 的推荐方案' };
  }
  if (recommendedOptionId && !options.some((option) => option.id === recommendedOptionId)) {
    return { error: 'recommendedOptionId 必须指向现有选项' };
  }
  const rawDecisionKey = String(value?.decisionKey || '').trim().toLocaleLowerCase();
  if (rawDecisionKey && !/^[\p{L}\p{N}][\p{L}\p{N}._:/-]{0,119}$/u.test(rawDecisionKey)) {
    return { error: 'decisionKey 必须是 1-120 个字母、数字、点、下划线、冒号、斜杠或连字符' };
  }
  const decisionScope = String(value?.decisionScope || '').trim().slice(0, 1000);
  if (rawDecisionKey && !decisionScope) {
    return { error: 'decisionScope 必须明确说明用户授权复用的同类决定含义' };
  }
  const normalizedQuestionScope = normalizeScope(value?.confirmationScope, 'confirmationScope');
  if (normalizedQuestionScope.error) return { error: normalizedQuestionScope.error };
  const confirmationScope = normalizedQuestionScope.scope || [];
  const planningFields = new Set([
    'goal', 'projectscope', 'preconditions', 'donewhen',
    'useracceptancepolicy', 'verificationpolicies', 'planfiles', 'supplement',
  ]);
  const specialManualScopes = new Set(['manualoperationauthorization', 'acceptance', 'finalacceptance']);
  const normalizedVisibleText = (text: string): string => (
    text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  );
  const scopeVisibilityError = (
    scope: readonly string[],
    visibleText: string,
    label: string,
  ): string | undefined => {
    const normalizedVisible = normalizedVisibleText(visibleText);
    for (const entry of scope) {
      const separator = entry.indexOf(':');
      if (separator <= 0) {
        const special = normalizedVisibleText(entry);
        if (category === 'manual-intervention' && specialManualScopes.has(special)) continue;
        return `${label} 必须使用 goal|projectScope|preconditions|doneWhen|userAcceptancePolicy|verificationPolicies|planFiles|supplement: <精确值>`;
      }
      const field = normalizedVisibleText(entry.slice(0, separator));
      if (!planningFields.has(field)) return `${label} 包含不支持的规划字段：${entry.slice(0, separator).trim()}`;
      const values = entry.slice(separator + 1).split(/[；;\n]/u)
        .map(normalizedVisibleText)
        .filter(Boolean);
      if (values.length === 0 || values.some((candidate) => !normalizedVisible.includes(candidate))) {
        return `${label} 必须逐项填写稍后实际写入且已在问题、上下文或该选项说明中展示的精确值：${entry}`;
      }
    }
    return undefined;
  };
  if (confirmationScope.some((entry) => entry.includes(':'))) {
    return { error: '规划变更 confirmationScope 必须放到具体 options[].confirmationScope，避免选择不同方案却获得相同写入授权' };
  }
  const questionScopeError = scopeVisibilityError(confirmationScope, [question, context].join('\n'), 'confirmationScope');
  if (questionScopeError) return { error: questionScopeError };
  for (const option of options) {
    const optionError = scopeVisibilityError(
      option.confirmationScope || [],
      [question, context, option.label, option.description || ''].join('\n'),
      `选项 ${option.label} 的 confirmationScope`,
    );
    if (optionError) return { error: optionError };
  }
  if (!context) {
    return { error: '用户决策包必须提供 context，说明当前任务、进展、已有证据和影响' };
  }
  return {
    question: {
      id: `pm-question-${uuid()}`,
      category,
      workItemId: String(value?.workItemId || '').trim().slice(0, 120) || undefined,
      blocker: String(value?.blocker || '').trim().slice(0, 4000) || undefined,
      reasonCode: PROJECT_MANAGER_MANUAL_INTERVENTION_REASON_CODES.includes(value?.reasonCode)
        ? value.reasonCode
        : undefined,
      ...(rawDecisionKey ? { decisionKey: rawDecisionKey } : {}),
      ...(decisionScope ? { decisionScope } : {}),
      ...(confirmationScope.length ? { confirmationScope } : {}),
      question,
      context,
      options,
      recommendedOptionId,
      previousStatus,
      createdAt: Date.now(),
    },
  };
}

interface ProjectAuthorizedTechnicalRoute {
  optionId: string;
  label: string;
  description: string;
  workItem: ProjectWorkItem;
}

interface ProjectSupervisorOwnedPermissionPrompt {
  workItem: ProjectWorkItem;
  contractChangeRequired: boolean;
}

function projectSupervisorOwnedPermissionPrompt(
  session: ProjectManagerSession,
  question: ProjectManagerUserQuestion,
): ProjectSupervisorOwnedPermissionPrompt | undefined {
  if (question.category !== 'manual-intervention'
    || !question.workItemId
    || !['access-grant', 'business-choice'].includes(question.reasonCode || '')) return undefined;
  const workItem = session.workItems.find((candidate) => candidate.id === question.workItemId);
  if (!workItem) return undefined;
  const text = [
    question.question,
    question.context,
    question.blocker,
    ...question.options.flatMap((option) => [option.label, option.description || '']),
  ].filter(Boolean).join('\n');
  const localTaskPermission = /(?:(?:任务\s*AI|任务终端|本地|工具|命令|脚本|测试).{0,48}(?:权限|授权|批准|确认|permission|approval))|(?:(?:允许|批准|确认).{0,32}(?:运行|执行).{0,80}(?:命令|脚本|测试|npm|pnpm|yarn|vitest|pytest|cargo|dotnet))/iu.test(text);
  if (!localTaskPermission) return undefined;
  const userOwnedOrHighRisk = /(?:凭据|密码|口令|token|密钥|账号|登录|外部访问|网络访问|访问授予|角色授予|管理员|提权|sudo|云端|生产|发布|部署|设备|接线|固件|上电|烧录|删除|覆盖|重写历史|git\s+push|权限变更|新增.{0,8}(?:依赖|包)|安装.{0,8}(?:新|第三方).{0,8}(?:依赖|包)|(?:npm|pnpm|yarn|pip|cargo)\s+(?:add|install)\s+\S+|提高.{0,12}(?:安全|电流|电压|速度).{0,8}上限)/iu.test(text);
  if (userOwnedOrHighRisk) return undefined;
  const permissionConfirmReady = workItem.contract.authority.permissionConfirm === true && (
    workItem.contract.authority.targetedTests === true
    || (workItem.contract.authority.allowedCommandPrefixes || []).length > 0
  );
  return { workItem, contractChangeRequired: !permissionConfirmReady };
}

function projectAuthorizedTechnicalRoute(
  session: ProjectManagerSession,
  question: ProjectManagerUserQuestion,
): ProjectAuthorizedTechnicalRoute | undefined {
  if (question.category !== 'manual-intervention'
    || question.reasonCode !== 'business-choice'
    || !question.workItemId
    || !question.recommendedOptionId) return undefined;
  const workItem = session.workItems.find((candidate) => candidate.id === question.workItemId);
  const recommended = question.options.find((option) => option.id === question.recommendedOptionId);
  if (!workItem || !recommended
    || workItem.contract.authority.technicalChoices !== true
    || workItem.contract.authority.routeAdjustments !== true) return undefined;
  const routeText = `${recommended.label}\n${recommended.description || ''}`.trim();
  const blockerText = `${question.question}\n${question.blocker || ''}\n${question.context || ''}`;
  const technicalRoute = /(?:调整|优化|整定|修复|重构|补测|重试|重新(?:验证|资格)|新(?:的)?候选|替代技术路线|参数探索)/iu.test(routeText);
  if (!technicalRoute) return undefined;
  const userOwnedChoice = /(?:用户偏好|产品定位|商业(?:模式|取舍)|预算取舍|交付期限|外观偏好|接受失败为成功|以不可用结论收口)/iu.test(`${blockerText}\n${routeText}`);
  const riskRouteText = routeText
    .replace(/不(?:进入|扩大到|涉及)(?:速度环|位置环|多工况)/giu, '')
    .replace(/不(?:新增|更换|改接|切换)(?:设备|接线|固件|控制面)/giu, '');
  const riskExpansion = /(?:(?:新增|更换|改接|切换)(?:设备|接线|固件|控制面))|(?:(?:进入|扩大到)(?:速度环|位置环|多工况))|(?:(?:提高|扩大|突破).{0,12}(?:安全上限|电流上限|电压上限|速度上限|风险层级))|(?:(?:放宽|降低|取消).{0,12}(?:验收|性能|门槛|标准))|(?:生产|发布|部署|删除历史|覆盖历史|git push)/iu.test(riskRouteText);
  if (userOwnedChoice || riskExpansion) return undefined;

  const authorizedText = [
    session.goal,
    ...session.doneWhen,
    ...session.preconditions,
    ...(session.supervisorNotes || []),
    workItem.contract.objective,
    workItem.contract.description,
    ...workItem.contract.preconditions,
    ...workItem.contract.stopWhen,
    ...workItem.contract.validation,
  ].join('\n').toLowerCase();
  const normalizedRoute = routeText.toLowerCase();
  const routeDomains = [
    'pi', '参数', '优化', '整定', '候选', '算法', '实现', '修复', '重构', '补测', '资格', '验证',
  ].filter((term) => normalizedRoute.includes(term));
  if (routeDomains.length === 0 || !routeDomains.some((term) => authorizedText.includes(term))) return undefined;
  return {
    optionId: recommended.id,
    label: recommended.label,
    description: recommended.description || '',
    workItem,
  };
}

type ProjectRequirementAlignmentState = 'sufficient' | 'needs-question' | 'needs-definition-update';

function projectRequirementDefinitionAppearsSufficient(session: ProjectManagerSession): boolean {
  const goal = session.goal.trim();
  const doneWhen = session.doneWhen.map((item) => item.trim()).filter(Boolean);
  const onlyCriterion = doneWhen.length === 1 ? doneWhen[0] : '';
  const genericGoal = goal.length <= 12 && /^(测试(相关)?功能|测试项目|完成项目|继续项目|开发项目|实现(相关)?功能|做(个|一个).+)$/u.test(goal);
  const hasVerifiableCriterion = doneWhen.some((criterion) => (
    /(测试|验证|验收|通过|可复现|可运行|可用|覆盖|成功|错误处理|文档|保存|生成|显示|返回)/u.test(criterion)
  ));
  const requestAsCriterion = /^(做|开发|实现|创建|搭建)(个|一个)?/u.test(onlyCriterion)
    && !hasVerifiableCriterion;
  const goalSpecific = !genericGoal && goal.length >= 8;
  const criteriaSpecific = hasVerifiableCriterion
    || (doneWhen.length >= 2 && doneWhen.every((criterion) => criterion.length >= 6));
  const planText = (session.planFiles || []).map((file) => file.content).join('\n');
  const planDefinesBoundaries = planText.length >= 120
    && /(目标|范围|需求|功能)/u.test(planText)
    && /(验收|完成条件|测试|验证)/u.test(planText);
  return doneWhen.length > 0 && (
    (goalSpecific && criteriaSpecific && !requestAsCriterion)
    || planDefinesBoundaries
  );
}

function projectRequirementsAlignmentPending(session: ProjectManagerSession): boolean {
  if (projectRequirementsAlignmentPhase(session) === 'needs-definition-update') return true;
  const latestRequiredIndex = session.events.reduce((latest, event, index) => (
    event.kind === 'requirements-alignment-required' ? index : latest
  ), -1);
  if (latestRequiredIndex < 0) return false;
  const latestConfirmedIndex = session.events.reduce((latest, event, index) => (
    event.kind === 'requirements-alignment-confirmed' ? index : latest
  ), -1);
  return latestRequiredIndex > latestConfirmedIndex;
}

function projectRequirementAlignmentState(session: ProjectManagerSession): ProjectRequirementAlignmentState {
  const latestDefinitionIndex = session.events.reduce((latest, event, index) => (
    event.kind === 'project-definition-updated' ? index : latest
  ), -1);
  const latestChangeMessageIndex = session.events.reduce((latest, event, index) => (
    event.kind === 'user-message' && typeof event.payload?.changeSignal === 'string' ? index : latest
  ), -1);
  if (latestChangeMessageIndex > latestDefinitionIndex) return 'needs-definition-update';
  if (session.pendingUserQuestion) return 'needs-definition-update';
  const latestRequiredIndex = session.events.reduce((latest, event, index) => (
    event.kind === 'requirements-alignment-required' ? index : latest
  ), -1);
  const latestAnswerIndex = session.events.reduce((latest, event, index) => (
    event.kind === 'user-clarification-answered'
      && event.payload?.category !== 'manual-intervention'
      && !event.workItemId
      ? index
      : latest
  ), -1);
  if (projectRequirementConfirmationCoversCurrentDefinition(
    session,
    latestAnswerIndex,
    latestRequiredIndex,
    latestDefinitionIndex,
  )) return 'sufficient';
  if (latestAnswerIndex <= Math.max(latestRequiredIndex, latestDefinitionIndex)) return 'needs-question';
  return 'needs-definition-update';
}

function projectWorkItemStageScopeError(
  session: ProjectManagerSession,
  subgoalId: string,
  criteria: readonly string[],
): string | null {
  if (!subgoalId) return null;
  const criterionIds = new Set(criteria.map(projectCriterionIdentity).filter(Boolean));
  const crossedStage = activeProjectSubgoals(session).find((subgoal) => (
    subgoal.id !== subgoalId
    && !['achieved', 'obsolete'].includes(subgoal.status)
    && subgoal.acceptance.some((criterion) => criterionIds.has(projectCriterionIdentity(criterion)))
  ));
  if (!crossedStage) return null;
  const crossedCriterion = crossedStage.acceptance.find((criterion) => (
    criterionIds.has(projectCriterionIdentity(criterion))
  ));
  return `工作项绑定 ${subgoalId}，但合同包含其他未完成阶段 ${crossedStage.id} 的验收项：${crossedCriterion}；请按阶段创建聚焦工作项，不能用 single-task 复杂度声明合并跨阶段成果`;
}

function projectRequirementConfirmationCoversCurrentDefinition(
  session: ProjectManagerSession,
  confirmationIndex: number,
  latestRequiredIndex: number,
  latestDefinitionIndex: number,
): boolean {
  const confirmation = confirmationIndex >= 0 ? session.events[confirmationIndex] : undefined;
  if (!confirmation || confirmation.kind !== 'user-clarification-answered' || confirmation.workItemId) return false;
  const latestRootAnswerIndex = session.events.reduce((latest, event, index) => (
    event.kind === 'user-clarification-answered' && !event.workItemId ? index : latest
  ), -1);
  if (confirmationIndex !== latestRootAnswerIndex) return false;
  const directlyConfirmed = confirmation.payload?.category !== 'manual-intervention'
    && confirmation.payload?.optionId === 'confirm-requirements'
    && confirmationIndex > Math.max(latestRequiredIndex, latestDefinitionIndex);
  if (directlyConfirmed) return true;
  const latestDefinition = latestDefinitionIndex >= 0 ? session.events[latestDefinitionIndex] : undefined;
  const latestRequired = latestRequiredIndex >= 0 ? session.events[latestRequiredIndex] : undefined;
  const explicitlyLinked = latestDefinitionIndex > confirmationIndex
    && latestDefinition?.payload?.userConfirmationEventId === confirmation.id
    && (
      latestRequiredIndex < latestDefinitionIndex
      || latestRequired?.payload?.userConfirmationEventId === confirmation.id
    );
  if (explicitlyLinked) return true;
  const previous = latestDefinition?.payload?.previous as Record<string, unknown> | undefined;
  const next = latestDefinition?.payload?.next as Record<string, unknown> | undefined;
  const changesUserPlan = !previous || !next || [
    'goal', 'preconditions', 'planFiles', 'doneWhen', 'userAcceptancePolicy', 'verificationPolicies',
  ].some((key) => (
    JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null)
  ));
  return latestDefinitionIndex > confirmationIndex
    && latestRequiredIndex === latestDefinitionIndex + 1
    && !latestDefinition?.payload?.userConfirmationEventId
    && !changesUserPlan;
}

function projectAlignmentQuestionInput(session: ProjectManagerSession): Record<string, unknown> {
  if (projectRequirementDefinitionAppearsSufficient(session)) {
    return {
      category: 'clarification',
      question: `是否确认按当前需求推进“${session.goal}”？`,
      context: [
        `目标：${session.goal}`,
        session.projectScope ? `范围：${session.projectScope}` : '',
        session.preconditions.length > 0 ? `前置条件：${session.preconditions.join('；')}` : '前置条件：无额外条件',
        `验收标准：${session.doneWhen.join('；')}`,
        '计划文件不是必需项；确认后项目 AI 才会生成阶段计划并把成果工作交给专属监督。',
      ].filter(Boolean).join('\n'),
      options: [
        {
          id: 'confirm-requirements',
          label: '确认需求',
          description: '目标、范围、前置条件和验收标准准确，可以据此规划和执行。',
        },
        {
          id: 'revise-requirements',
          label: '补充调整',
          description: '需求仍需补充或修改；项目 AI 应等待补充并重新展示完整需求。',
        },
      ],
      recommendedOptionId: 'confirm-requirements',
    };
  }
  const combined = [session.goal, ...session.doneWhen].join(' ');
  const managementSystem = /(图书|library|管理系统|管理平台|后台系统)/iu.test(combined);
  const subjectCandidate = session.doneWhen.find((item) => /^(做|开发|实现|创建|搭建)(个|一个)?/u.test(item)) || session.goal;
  const subject = subjectCandidate.replace(/^(做|开发|实现|创建|搭建)(个|一个)?/u, '').trim() || session.goal;
  if (managementSystem) {
    return {
      category: 'clarification',
      question: `你希望先按哪种产品形态实现“${subject}”？`,
      context: `当前项目目标为“${session.goal}”，完成条件为“${session.doneWhen.join('；')}”。这些信息还不能确定界面形态、首版范围和验收方式。项目管理 AI 推荐先做本地网页版本，选定后还会继续确认核心功能边界。`,
      options: [
        {
          id: 'local-web',
          label: '本地网页系统',
          description: '推荐方案。首版完成标准：本地网页可运行；核心数据管理、查询和主要业务流程可验证；基础异常处理有明确结果。暂不包含复杂多人权限和公网发布。',
          confirmationScope: [
            'doneWhen: 本地网页可运行；核心数据管理、查询和主要业务流程可验证；基础异常处理有明确结果',
          ],
        },
        {
          id: 'desktop-app',
          label: '桌面单机应用',
          description: '首版完成标准：桌面单机应用可运行；核心数据管理与查询流程可验证；本地数据可保存并重新加载。适合固定电脑离线使用。',
          confirmationScope: [
            'doneWhen: 桌面单机应用可运行；核心数据管理与查询流程可验证；本地数据可保存并重新加载',
          ],
        },
        {
          id: 'command-line',
          label: '命令行原型',
          description: '首版完成标准：命令行原型可运行；数据模型与核心业务逻辑可重复验证；输入错误有明确结果。不提供图形界面。',
          confirmationScope: [
            'doneWhen: 命令行原型可运行；数据模型与核心业务逻辑可重复验证；输入错误有明确结果',
          ],
        },
      ],
      recommendedOptionId: 'local-web',
    };
  }
  return {
    category: 'clarification',
    question: `你希望以哪种交付深度推进“${subject}”？`,
    context: `当前项目目标为“${session.goal}”，完成条件为“${session.doneWhen.join('；')}”，尚不足以唯一确定功能范围与验收边界。项目管理 AI 先给出三种可执行方向，选择后可继续在项目对话中补充细节。`,
    options: [
      {
        id: 'minimal-prototype',
        label: '最小可验证原型',
        description: '推荐方案。完成标准：最关键业务链可运行；结果可重复验证；非核心功能明确列为后续工作。',
        confirmationScope: [
          'doneWhen: 最关键业务链可运行；结果可重复验证；非核心功能明确列为后续工作',
        ],
      },
      {
        id: 'standard-solution',
        label: '标准完整版本',
        description: '完成标准：常用功能可运行；基础异常处理可验证；使用说明与实际行为一致。交付更完整，但实现和验证时间更长。',
        confirmationScope: [
          'doneWhen: 常用功能可运行；基础异常处理可验证；使用说明与实际行为一致',
        ],
      },
      {
        id: 'plan-first',
        label: '先产出实施计划',
        description: '完成标准：架构边界已说明；任务拆分和依赖明确；风险与验收方案可供后续确认。暂不修改业务代码。',
        confirmationScope: [
          'doneWhen: 架构边界已说明；任务拆分和依赖明确；风险与验收方案可供后续确认',
        ],
      },
    ],
    recommendedOptionId: 'minimal-prototype',
  };
}

const deletingProjectManagerSessions = new Set<string>();
const savingProjectManagerSessions = new Set<string>();
let projectManagerRecoveryChoice: 'pending' | 'restore' | 'skip' = 'pending';
let projectManagerRecoveryMutationInFlight = false;

function projectSessionForParams(params: any): ProjectManagerSession | null {
  const state = useStore.getState();
  const projectId = String(params?.projectId || '').trim();
  const correlationId = String(params?.correlationId || '').trim();
  const callerSurfaceId = String(params?.callerSurfaceId || '').trim();
  const callerSession = !projectId && callerSurfaceId
    ? state.projectManagers.find((candidate) => candidate.managerSurfaceId === callerSurfaceId) || null
    : null;
  const correlatedSession = !projectId && correlationId
    ? state.projectManagers.find((candidate) => candidate.events.some((event) => (
      event.kind === 'user-message' && event.correlationId === correlationId
    ))) || null
    : null;
  const session = projectId
    ? state.projectManagers.find((candidate) => candidate.id === projectId) || null
    : correlatedSession || callerSession || state.projectManager;
  return session && !deletingProjectManagerSessions.has(session.id) ? session : null;
}

function projectManagerSessionView(session: ProjectManagerSession): ProjectManagerSession & {
  managedSupervisors: Array<Record<string, unknown>>;
  attentionKind?: ProjectManagerEventKind;
  attentionReason?: string;
  pauseReason?: string;
  pauseAttentionRequired?: boolean;
} {
  const supervisor = useStore.getState().supervisor;
  const lanes = supervisor.lanes.filter((lane) => (
    lane.projectManagerProjectId === session.id && supervisorLaneControlState(lane) !== 'stopped'
  ));
  const latestPause = [...session.events].reverse().find((event) => event.kind === 'project-paused');
  const activeAttention = activeProjectManagerAttentionEvent(session.events);
  return {
    ...session,
    ...(activeAttention ? {
      attentionKind: activeAttention.kind,
      attentionReason: activeAttention.summary,
    } : {}),
    ...(session.status === 'paused' && latestPause ? {
      pauseReason: latestPause.summary,
      pauseAttentionRequired: projectManagerEventNeedsUserAttention(latestPause),
    } : {}),
    managedSupervisors: lanes.map((lane) => {
      const item = session.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
      const config = effectiveSupervisorLaneConfig(lane);
      const pendingDecisions = supervisor.pendingApprovals.filter((approval) => approval.laneId === lane.id);
      return {
        laneId: lane.id,
        label: lane.label,
        workItemId: lane.projectWorkItemId,
        supervisorSurfaceId: lane.supervisorSurfaceId,
        terminalSurfaceId: lane.surfaceId,
        workerSurfaceId: lane.surfaceId,
        terminalLabel: lane.label,
        status: supervisorLaneControlState(lane),
        terminal: remoteTerminalActivity(lane.surfaceId),
        taskWorkMode: normalizeTaskWorkMode(config.taskWorkMode),
        mainThreadResponsibility: config.mainThreadResponsibility || '',
        childThreadResponsibilities: config.childThreadResponsibilities || [],
        maxChildThreads: config.maxChildThreads,
        supervisorMayApproveThreads: config.supervisorMayApproveThreads,
        parallelizableOperations: config.parallelizableOperations || [],
        serializedOperations: config.serializedOperations || [],
        pendingDecisionCount: pendingDecisions.length,
        pendingOwnerDecisionDeliveryCount: (lane.pendingSupervisorDeliveries || [])
          .filter((delivery) => delivery.kind === 'owner-decision').length,
        pendingControlDeliveryCount: (lane.pendingSupervisorDeliveries || [])
          .filter((delivery) => (
            delivery.kind === 'owner-decision' || delivery.kind === 'control-message'
          )).length,
        pendingDecisions: pendingDecisions.map((approval) => ({
          approvalId: approval.id,
          proposalKind: approval.proposalKind,
          recommendation: approval.text,
          reason: approval.reason,
          impact: approval.impact,
          alternatives: approval.alternatives,
          createdAt: approval.createdAt,
        })),
        decisions: lane.decisions?.slice(-20) || [],
        budget: item ? {
          retries: { used: item.attempts, limit: item.contract.budget.maxTaskRetries },
          sameTests: { limit: item.contract.budget.maxSameTestRuns },
          fullSuites: { limit: item.contract.budget.maxFullSuiteRunsPerVersion },
        } : undefined,
      };
    }),
  };
}

interface PendingProjectManagerDelivery extends ProjectManagerPendingDelivery {
  sessionId?: string;
  attempts: number;
  alerted: boolean;
}

function notifyProjectManagerAttention(
  session: ProjectManagerSession,
  event: { kind: string; summary: string; payload?: Record<string, unknown> },
): void {
  const store = useStore.getState();
  const current = store.projectManagers.find((candidate) => candidate.id === session.id) || session;
  const manager = projectManagerTerminal({ surfaceId: current.managerSurfaceId, projectId: current.id });
  const workspaceId = manager?.workspaceId || projectRuntimeWorkspaceId(current.id);
  const surfaceId = manager?.surfaceId || current.managerSurfaceId || current.taskTerminalSurfaceId || '';
  const title = event.kind === 'project-paused' && event.payload?.source === 'runtime'
    ? '项目运行异常，已安全暂停'
    : event.kind === 'project-execution-stalled'
      ? '项目执行异常，已安全暂停'
    : event.kind === 'project-goal-completed'
      ? '主目标已完成，请查看'
    : event.kind === 'project-stopped'
      ? '项目已停止，请查看'
      : event.kind === 'project-paused'
        ? '项目需要处理'
        : event.kind === 'guard-triggered'
          ? '项目执行护栏需要处理'
          : '项目运行异常';
  const text = event.kind === 'project-goal-completed'
    ? `项目“${projectDisplayName(current)}”的${event.summary}`
    : `项目“${projectDisplayName(current)}”需要处理：${event.summary}`;
  if (workspaceId) {
    store.addNotification({
      surfaceId: surfaceId as SurfaceId,
      workspaceId,
      title,
      text,
      ...notificationMetadata({
        owner: 'project',
        entityId: current.id,
        kind: event.kind,
        severity: event.kind === 'project-goal-completed' ? 'success' : 'error',
        projectId: current.id,
        sourceLabel: projectDisplayName(current),
      }),
    });
  }
  openProjectManagerAttentionSurface(current.id);
  fireDesktopNotification({ surfaceId, title, text });
}

function notifyProjectManagerUserQuestion(
  session: ProjectManagerSession,
  question: ProjectManagerUserQuestion,
): void {
  const store = useStore.getState();
  const manager = projectManagerTerminal({ surfaceId: session.managerSurfaceId, projectId: session.id });
  const workspaceId = manager?.workspaceId || projectRuntimeWorkspaceId(session.id);
  const surfaceId = manager?.surfaceId || session.taskTerminalSurfaceId || session.managerSurfaceId || '';
  const title = question.category === 'manual-intervention'
    ? '项目需要你的处理'
    : '项目需要需求确认';
  const text = `${session.goal}：${question.question}`;
  if (workspaceId) {
    store.addNotification({
      surfaceId: surfaceId as SurfaceId,
      workspaceId,
      title,
      text,
      ...notificationMetadata({
        owner: 'project',
        entityId: session.id,
        kind: `question:${question.category}`,
        projectId: session.id,
        sourceLabel: projectDisplayName(session),
      }),
    });
  }
  openProjectManagerAttentionSurface(session.id);
  fireDesktopNotification({ surfaceId, title, text });
}

function projectPauseIsVerificationLimited(reason: string): boolean {
  return /(?:(?:\b(?:win32|gui|ui)\b|桌面).{0,60}(?:自动化|交互|验证|核验|证据|通道).{0,40}(?:不可用|无法|缺少|受限|限制|不能)|(?:自动化|交互).{0,40}(?:不可用|无法|缺少|受限|限制|不能)|(?:无法|不能|缺少).{0,40}(?:自动化|\b(?:win32|gui|ui)\b|桌面交互)|(?:需要|等待|只能).{0,12}(?:人工验收|手动测试)|(?:人工验收|手动测试).{0,20}(?:待完成|尚未完成|需要用户|无法自动))/iu.test(reason);
}

function currentProjectVerificationLimitation(
  session: ProjectManagerSession,
  workItem: ProjectWorkItem | undefined,
): ProjectVerificationLimitation | undefined {
  const limitation = workItem?.verificationLimitation;
  return limitation
    && limitation.requirementsVersion === projectRequirementsVersion(session)
    && limitation.authorizationVersion === projectAuthorizationVersion(session)
    ? limitation
    : undefined;
}

function projectVerificationLimitationFromDecision(
  session: ProjectManagerSession,
  workItem: ProjectWorkItem,
  values: Array<unknown>,
  missingEvidence: string[],
): ProjectVerificationLimitation | undefined {
  const text = values.map((value) => String(value || '').trim()).filter(Boolean).join('\n');
  if (!projectPauseIsVerificationLimited(text)) return undefined;
  const missing = [...new Set(missingEvidence.map((item) => item.trim()).filter(Boolean))].slice(0, 30);
  return {
    kind: 'gui-automation-unavailable',
    detail: text.slice(0, 12_000),
    missingEvidence: missing.length > 0 ? missing : ['GUI 核心交互缺少可复核的自动化证据'],
    affectedAcceptance: [...new Set([
      ...workItem.contract.stopWhen,
      ...workItem.contract.validation,
    ].map((item) => item.trim()).filter(Boolean))].slice(0, 30),
    requirementsVersion: projectRequirementsVersion(session),
    authorizationVersion: projectAuthorizationVersion(session),
    detectedAt: Date.now(),
  };
}

function projectPauseWorkItem(
  session: ProjectManagerSession,
): ProjectWorkItem | undefined {
  return session.workItems.find((item) => (
    item.id === session.activeWorkItemId
    && !['completed', 'stopped'].includes(item.status)
  ))
    || session.workItems.find((item) => (
      ['waiting-decision', 'paused', 'failed', 'running', 'validating'].includes(item.status)
    ));
}

function projectVerificationLimitationForPause(
  session: ProjectManagerSession,
  workItem: ProjectWorkItem | undefined,
  reason: string,
): ProjectVerificationLimitation | undefined {
  if (!workItem) return undefined;
  const existing = currentProjectVerificationLimitation(session, workItem);

  if (projectPauseIsVerificationLimited(reason)) {
    return existing || projectVerificationLimitationFromDecision(
      session,
      workItem,
      [reason, workItem.latestBlocker, workItem.latestEvidence, workItem.latestContextSummary],
      [workItem.latestEvidence, workItem.latestBlocker, reason]
        .map((item) => String(item || '').trim())
      .filter(Boolean),
    );
  }
  const genericEvidenceRecovery = /(?:内部恢复|重复派发|相同证据|没有新的|无新|缺少|未形成).{0,80}(?:证据|stopWhen|validation|complete)|(?:证据|stopWhen|validation).{0,80}(?:没有新的|无新|缺少|未形成|无法满足)/iu.test(reason);
  if (!genericEvidenceRecovery) return undefined;
  if (existing) return existing;

  const relatedWorkItemIds = new Set(session.workItems
    .filter((item) => item.goalId === workItem.goalId && item.subgoalId === workItem.subgoalId)
    .map((item) => item.id));
  const history = session.events
    .filter((event) => (
      !!event.workItemId
      && relatedWorkItemIds.has(event.workItemId)
      && projectPauseIsVerificationLimited(event.summary)
    ))
    .slice(-12)
    .map((event) => event.summary);
  const scopedLimitation = projectVerificationLimitationFromDecision(
    session,
    workItem,
    [
      reason,
      workItem.latestBlocker,
      workItem.latestEvidence,
      workItem.latestContextSummary,
      ...history,
    ],
    [workItem.latestEvidence, workItem.latestBlocker, ...history]
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  return scopedLimitation || existing;
}

function projectTaskBatchRepeatsUnavailableVerification(batch: ProjectTaskBatch): boolean {
  const requested = [
    batch.outcome,
    ...batch.completionDefinition,
    ...batch.evidenceExpectations,
    ...batch.unmetCompletionItems,
  ].join('\n');
  const explicitlyAlternative = /(?:静态|源码复核|逻辑测试|单元测试|数据层|数据文件|消息模拟|替代验证|基础测试|非\s*GUI|无需\s*GUI)/iu.test(requested);
  const requestsUnavailableRoute = /(?:(?:\b(?:win32|gui|ui)\b|界面|窗口).{0,60}(?:黑盒|点击|输入|交互).{0,60}(?:证据|验证|结果)|(?:逐项|核心操作).{0,30}(?:\b(?:gui|ui)\b|黑盒|点击|输入|运行).{0,40}(?:证据|验证|结果))/iu.test(requested);
  return requestsUnavailableRoute && !explicitlyAlternative;
}

function projectPauseUserQuestion(
  session: ProjectManagerSession,
  reason: string,
  options: { forceRuntimeRecovery?: boolean } = {},
): ProjectManagerUserQuestion | undefined {
  const workItem = projectPauseWorkItem(session);
  const verificationLimitation = options.forceRuntimeRecovery
    ? undefined
    : projectVerificationLimitationForPause(session, workItem, reason);
  const verificationLimited = !!verificationLimitation;
  const alternativeAttempted = verificationLimited
    && workItem?.verificationDecision?.action === 'alternative-validation'
    && workItem.verificationDecision.requirementsVersion === projectRequirementsVersion(session)
    && workItem.verificationDecision.authorizationVersion === projectAuthorizationVersion(session);
  const verificationOptions = [
    {
      id: 'manual-verify',
      label: '人工验收并反馈',
      description: '操作当前未验证的 GUI 核心流程，并在补充框填写成功项、失败项或异常现象。',
    },
    ...(!alternativeAttempted ? [{
      id: 'alternative-validation',
      label: '换一种方式验证',
      description: '推荐：只安排一轮与失败路线不同的基础测试、逻辑测试或静态证据；不得重复原自动化路径。',
    }] : []),
    {
      id: 'defer-verification',
      label: '暂缓验证并继续',
      description: '暂时搁置当前验证并继续后续工作；保留原工作项，条件具备后可以回来补验。',
    },
    {
      id: 'skip-verification',
      label: '跳过当前验证，后续重排',
      description: '停止当前验证工作项并继续其他成果；项目 AI 必须在后续新计划中重新承接该验收缺口。',
    },
    {
      id: 'keep-paused',
      label: '保持暂停',
      description: '保留当前成果、证据和未验证项，暂不继续执行。',
    },
  ];
  const normalized = normalizeProjectManagerUserQuestion({
    category: 'manual-intervention',
    ...(workItem ? { workItemId: workItem.id } : {}),
    blocker: reason,
    reasonCode: verificationLimited ? 'verification-limited' : 'runtime-recovery',
    question: verificationLimited
      ? '当前成果无法通过可靠的 GUI 自动化完成核心交互验收，你希望如何继续？'
      : '项目 AI 已无法自行恢复当前监督或运行异常，请选择下一步处理方式。',
    context: [
      `当前原因：${reason}`,
      workItem ? `当前工作项：${workItem.title}` : '',
      workItem?.latestContextSummary ? `当前进展：${workItem.latestContextSummary}` : '',
      workItem?.latestEvidence ? `已有证据：${workItem.latestEvidence}` : '',
      verificationLimitation ? `验证能力限制：${verificationLimitation.detail}` : '',
      verificationLimitation?.missingEvidence.length
        ? `尚缺证据：${verificationLimitation.missingEvidence.join('；')}`
        : '',
      verificationLimited
        ? alternativeAttempted
          ? '这属于验证能力受限，不代表实现失败。不同的替代验证已经尝试过一次，不能再派发同义验证；请选择人工验收、暂缓后补、跳过并后续重排或保持暂停。'
          : '这属于验证能力受限，不代表实现失败。可先安排一轮不同路线的替代验证，也可以人工验收、暂缓后补，或跳过当前工作项并由后续新计划重新承接；未验证项不会被写成通过。'
        : '推荐保留现有成果与证据，按最新角色协议重建监督绑定；控制层不会回退或重复派发旧任务。',
      verificationLimited
        ? '当前要做什么：决定是改用不同验证方式、人工验收、暂缓后补、跳过并后续重排，还是保持暂停。'
        : '当前要做什么：决定是按最新协议恢复、保持暂停，还是停止当前工作项并重新规划。',
    ].filter(Boolean).join('\n'),
    options: verificationLimited ? verificationOptions : [
      {
        id: 'recover-latest-protocol',
        label: '按最新协议恢复',
        description: '推荐：保留现有成果与证据，由项目 AI 重建监督绑定并从当前工作项继续。',
      },
      {
        id: 'keep-paused',
        label: '保持暂停',
        description: '保留当前上下文，等待后续再处理。',
      },
      {
        id: 'stop-work-item',
        label: '停止并重新规划',
        description: '停止当前异常工作项，由项目 AI 根据剩余目标建立新的聚焦工作项。',
      },
    ],
    recommendedOptionId: verificationLimited
      ? alternativeAttempted ? 'manual-verify' : 'alternative-validation'
      : 'recover-latest-protocol',
  }, session.status);
  return normalized.question;
}

async function requestProjectPauseUserDecision(
  sessionId: string,
  reason: string,
  options: { forceRuntimeRecovery?: boolean } = {},
): Promise<{ ok: boolean; error?: string; question?: ProjectManagerUserQuestion }> {
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session) return { ok: false, error: '项目不存在' };
  const question = projectPauseUserQuestion(session, reason, options);
  if (!question) return { ok: false, error: '无法为项目暂停生成用户处理方案' };
  const workItem = projectPauseWorkItem(session);
  const verificationLimitation = question.reasonCode === 'verification-limited'
    ? projectVerificationLimitationForPause(session, workItem, reason)
    : undefined;
  if (session.pendingUserQuestion) {
    if (session.pendingUserQuestion.reasonCode !== 'runtime-recovery'
      || question.reasonCode !== 'verification-limited') {
      return { ok: true, question: session.pendingUserQuestion };
    }
    const latest = store.projectManagers.find((candidate) => candidate.id === session.id) || session;
    replaceProjectManagerSession({
      ...latest,
      workItems: workItem && verificationLimitation
        ? latest.workItems.map((item) => item.id === workItem.id
            ? { ...item, verificationLimitation, updatedAt: Date.now() }
            : item)
        : latest.workItems,
      pendingUserQuestion: undefined,
      updatedAt: Date.now(),
    });
    await appendRecordedProjectEvent(latest, {
      kind: 'user-clarification-invalidated',
      workItemId: session.pendingUserQuestion.workItemId,
      summary: '已根据持久验证限制将运行异常问题重分类，不再要求用户恢复内部协议',
      payload: {
        questionId: session.pendingUserQuestion.id,
        reason: 'runtime-recovery-reclassified-as-verification-limited',
        attentionRequired: false,
      },
    }, { persistSession: false });
  } else if (workItem && verificationLimitation) {
    store.applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: workItem.id,
      patch: { verificationLimitation },
    }, session.id);
  }
  const result = store.applyProjectManagerAction({
    type: 'request-user-clarification',
    question,
  }, session.id);
  if (!result.ok) return result;
  for (const laneId of projectSupervisorLaneIds(session)) {
    store.pauseSupervisorLane(laneId, '项目等待用户选择恢复、替代验证、暂缓、跳过或保持暂停');
  }
  const timer = projectProgressTimers.get(session.id);
  if (timer) globalThis.clearTimeout(timer);
  projectProgressTimers.delete(session.id);
  notifyProjectManagerUserQuestion(session, question);
  await persistProjectManagerMutation(result, session.id);
  return { ok: true, question };
}

function projectFinalAcceptanceQuestion(
  session: ProjectManagerSession,
  mode: 'required' | 'gap' = 'gap',
): ProjectManagerUserQuestion | undefined {
  if (mode === 'gap' && projectFinalAcceptanceEligibilityError(session)) return undefined;
  const goal = activeProjectGoal(session);
  const requirementsVersion = projectRequirementsVersion(session);
  const authorizationVersion = projectAuthorizationVersion(session);
  const gaps = session.workItems.filter((item) => (
    item.goalId === goal.id
    && item.requirementsVersion === requirementsVersion
    && item.authorizationVersion === authorizationVersion
    && ((item.verificationLimitation?.requirementsVersion === requirementsVersion
      && item.verificationLimitation.authorizationVersion === authorizationVersion)
      || (['defer-verification', 'skip-verification'].includes(item.verificationDecision?.action || '')
        && item.verificationDecision?.requirementsVersion === requirementsVersion
        && item.verificationDecision.authorizationVersion === authorizationVersion))
  ));
  const normalized = normalizeProjectManagerUserQuestion({
    category: 'manual-intervention',
    reasonCode: 'final-acceptance',
    decisionScope: projectFinalAcceptanceScope(session),
    blocker: mode === 'required'
      ? '项目实现与验证门禁已经满足，当前目标策略要求用户进行最终验收。'
      : '项目实现工作已经全部结束，但中途仍有长期缺少证据、暂缓或跳过的验证项。',
    question: mode === 'required'
      ? '项目实现与验证已经完成。你是否确认最终效果并完成本次主目标？'
      : '项目实现工作已全部完成，但仍保留中途暂缓、跳过或长期无法完成的验证项。你是否接受当前效果并完成本次主目标？',
    context: [
      `当前主目标：${goal.statement}`,
      mode === 'required'
        ? '实现状态：全部当前版本工作项、阶段和目标完成条件已经通过控制层门禁；本次询问只执行用户要求的最终验收。'
        : '实现状态：除验证能力缺口外，当前版本没有未完成、运行中或已知失败的实现工作。',
      mode === 'required' ? '' : `尚未由普通验证闭合的目标条件：${goal.doneWhen.join('；')}`,
      mode === 'required' ? '' : `未闭合验证：${gaps.map((item) => `${item.title}：${item.latestBlocker || item.verificationLimitation?.detail || '验证未完成'}`).join('；')}`,
      mode === 'required'
        ? '确认只代表最终效果验收，不会替代或改写已经形成的验证证据。'
        : '接受只表示用户认可当前最终效果；不会把缺失验证伪装成自动测试通过。已知失败、安全问题、未完成实现或没有任何成果时不能使用此路径。',
    ].filter(Boolean).join('\n'),
    options: [
      {
        id: 'accept-current-result',
        label: '接受项目已完成',
        description: '确认项目实现效果可以接受并完成当前主目标；保留中途暂缓、跳过和缺失验证的记录。',
        confirmationScope: ['finalAcceptance'],
      },
      {
        id: 'continue-validation',
        label: mode === 'required' ? '暂不完成项目' : '继续补充验证',
        description: mode === 'required'
          ? '保留当前成果和验证记录，项目保持等待，稍后再决定是否最终验收。'
          : '不接受当前收口，继续为未验证项建立补验工作。',
        confirmationScope: [],
      },
    ],
    recommendedOptionId: 'accept-current-result',
  }, session.status);
  return normalized.question;
}

async function requestProjectFinalAcceptance(
  session: ProjectManagerSession,
  mode: 'required' | 'gap' = 'gap',
): Promise<ProjectManagerUserQuestion | undefined> {
  if (session.pendingUserQuestion) return session.pendingUserQuestion;
  const question = projectFinalAcceptanceQuestion(session, mode);
  if (!question) return undefined;
  const store = useStore.getState();
  const result = store.applyProjectManagerAction({
    type: 'request-user-clarification',
    question,
  }, session.id);
  if (!result.ok) return undefined;
  for (const laneId of projectSupervisorLaneIds(session)) {
    store.pauseSupervisorLane(laneId, '项目等待用户决定是否接受当前最终效果');
  }
  notifyProjectManagerUserQuestion(session, question);
  await persistProjectManagerMutation(result, session.id);
  return question;
}

async function pauseProjectForExecutionStall(
  sessionId: string,
  summary: string,
  incidentKey: string,
  workItemId?: string,
): Promise<void> {
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session || ['completed', 'stopped'].includes(session.status)) return;
  for (const laneId of projectSupervisorLaneIds(session)) {
    store.pauseSupervisorLane(laneId, '项目执行责任连续恢复失败，控制层已自动安全暂停');
  }
  const paused = store.applyProjectManagerAction({
    type: 'pause-project',
    reason: '项目执行链异常，已自动安全暂停；当前成果、证据和未完成责任均已保留',
    source: 'runtime',
    attentionRequired: false,
  }, session.id);
  if (paused.ok) await persistProjectManagerMutation(paused, session.id);
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
  let existingIncident: ProjectManagerEvent | undefined;
  for (const event of [...current.events].reverse()) {
    if (event.kind === 'project-resumed' || event.kind === 'recovery-restored') break;
    if (event.kind === 'project-execution-stalled' && event.payload?.incidentKey === incidentKey) {
      existingIncident = event;
      break;
    }
  }
  if (!existingIncident) {
    await appendRecordedProjectEvent(current, {
      kind: 'project-execution-stalled',
      workItemId,
      summary,
      payload: {
        incidentKey,
        attentionRequired: true,
        automaticPause: true,
        resolvedAttentionKinds: ['guard-triggered'],
      },
    });
  }
  reconcileProjectExecutionResponsibility(session.id);
}

async function reportProjectRuntimeFailureForUserDecision(
  sessionId: string,
  kind: Extract<ProjectManagerEventKind, 'manager-runtime-failed' | 'supervisor-runtime-failed' | 'task-runtime-failed'>,
  summary: string,
  workItemId?: string,
): Promise<void> {
  const session = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session || ['completed', 'stopped'].includes(session.status)) return;
  await appendRecordedProjectEvent(session, {
    kind,
    summary,
    workItemId,
    payload: { attentionRequired: false },
  });
  await pauseProjectForExecutionStall(
    session.id,
    `项目运行时自动重建失败：${summary}`,
    `runtime-failure:${session.id}:${workItemId || 'project'}:${kind}`,
    workItemId,
  );
}

function reconcileInheritedGoalAcceptanceFromOpenWorkItems(
  sessionId: string,
): ProjectManagerSession | undefined {
  const store = useStore.getState();
  let session = store.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session) return undefined;
  const goalCriteria = new Set(activeProjectGoal(session).doneWhen.map(projectCriterionIdentity));

  for (const item of session.workItems) {
    if (item.stopWhenScopeVersion === 1
      || ['completed', 'stopped'].includes(item.status)
      || item.completion) continue;
    const subgoal = activeProjectSubgoals(session).find((candidate) => candidate.id === item.subgoalId);
    if (!subgoal) continue;
    const inheritedGoalCriteria = new Set(subgoal.acceptance
      .map(projectCriterionIdentity)
      .filter((criterion) => goalCriteria.has(criterion)));
    if (inheritedGoalCriteria.size === 0) continue;
    const narrowedStopWhen = item.contract.stopWhen.filter((criterion) => (
      !inheritedGoalCriteria.has(projectCriterionIdentity(criterion))
    ));
    if (narrowedStopWhen.length === 0 || narrowedStopWhen.length === item.contract.stopWhen.length) continue;
    const result = store.applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: item.id,
      patch: {
        contract: { ...item.contract, stopWhen: narrowedStopWhen },
        stopWhenScopeVersion: 1,
        verificationLimitation: undefined,
      },
    }, session.id);
    if (!result.ok) continue;
    session = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || session;
  }
  saveProjectManagerSnapshot(session.id);
  return session;
}

function unresolvedProjectPauseForUserDecision(
  session: ProjectManagerSession,
): { summary: string } | undefined {
  if (session.status !== 'paused' || session.pendingUserQuestion) return undefined;
  const event = activeProjectManagerAttentionEvent(session.events);
  if (event?.kind !== 'project-paused'
    || !['manager', 'runtime', 'system'].includes(String(event.payload?.source || ''))) return undefined;
  const workItem = projectPauseWorkItem(session);
  return projectVerificationLimitationForPause(session, workItem, event.summary)
    ? { summary: event.summary }
    : undefined;
}

function isProjectTaskInputDraftBlocker(...values: Array<unknown>): boolean {
  const text = values.map((value) => String(value || '').trim()).filter(Boolean).join('\n');
  return /(?:任务(?: AI)?终端|任务终端输入框).{0,80}(?:未提交(?:用户)?(?:草稿|内容|文字|输入)|输入框.{0,24}(?:已有|存在|仍有)未提交|不能安全(?:接收|覆盖|追加).{0,16}(?:项目)?指令)/u.test(text);
}

function projectTaskInputDraftStillPending(lane: SupervisorLane): boolean {
  const buffer = surfaceTerminalRegistry.get(lane.surfaceId)?.buffer.active;
  return !buffer || hasPendingTerminalInput(buffer);
}

function projectTaskInputTransitionStillBlocked(
  transition: ProjectSupervisorTransition,
): boolean {
  if (!transition.workItemId
    || !isProjectTaskInputDraftBlocker(transition.summary, transition.contextSummary)) return false;
  const lane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === transition.laneId);
  return !!lane && projectTaskInputDraftStillPending(lane);
}

function escalateProjectTaskInputDraft(
  sessionId: string,
  laneId: string,
  workItemId: string,
  detail: string,
): ProjectManagerUserQuestion | undefined {
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === sessionId);
  const lane = store.supervisor.lanes.find((candidate) => candidate.id === laneId);
  const workItem = session?.workItems.find((candidate) => candidate.id === workItemId);
  if (!session || !lane || !workItem || ['completed', 'stopped'].includes(session.status)) return undefined;
  if (session.pendingUserQuestion) return session.pendingUserQuestion;
  if (!projectTaskInputDraftStillPending(lane)) return undefined;

  const blocker = `任务终端 ${lane.surfaceId} 的输入框存在未提交内容；控制层不能覆盖、代替用户提交或把新指令追加到原草稿。`;
  const normalized = normalizeProjectManagerUserQuestion({
    category: 'manual-intervention',
    workItemId: workItem.id,
    blocker,
    reasonCode: 'task-input-conflict',
    question: `任务“${workItem.title}”的终端输入框存在未提交内容，执行链无法安全继续。请先查看任务终端并选择处理方式。`,
    context: [
      `任务终端：${lane.surfaceId}`,
      `监督报告：${detail}`,
      '为避免误提交用户草稿或触发未经确认的命令、测试及设备操作，控制层已暂停本项目的监督链。',
    ].join('\n'),
    options: [
      {
        id: 'draft-handled',
        label: '已处理输入框',
        description: '我已检查并提交或清空原输入；项目 AI 可重新核对终端为空后恢复同一执行链。',
      },
      {
        id: 'keep-paused',
        label: '保持暂停',
        description: '保留草稿和当前项目证据，不再自动投递，等待稍后人工处理。',
      },
      {
        id: 'stop-work-item',
        label: '停止该工作项',
        description: '停止当前工作项并保留审计记录，由项目 AI 重新评估剩余目标。',
      },
    ],
    recommendedOptionId: 'draft-handled',
  }, session.status);
  if (!normalized.question) return undefined;

  const staleTransitionIds = new Set((session.pendingSupervisorTransitions || [])
    .filter((transition) => (
      (transition.laneId === lane.id || transition.workItemId === workItem.id)
      && isProjectTaskInputDraftBlocker(transition.summary, transition.contextSummary)
    ))
    .map((transition) => transition.id));
  for (const approval of store.supervisor.pendingApprovals.filter((candidate) => candidate.laneId === lane.id)) {
    store.cancelPending(approval.id, '任务终端草稿需要用户处理，内部待决项已升级为项目用户问题');
  }
  const watch = taskInputRecoveryWatches.get(lane.id);
  if (watch) stopTaskInputRecoveryWatch(lane.id, watch);
  for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
    const delivery = pendingProjectManagerDeliveries[index];
    if (delivery.sessionId === session.id && delivery.transitionId && staleTransitionIds.has(delivery.transitionId)) {
      pendingProjectManagerDeliveries.splice(index, 1);
    }
  }
  store.updateLane(lane.id, {
    pendingSupervisorDeliveries: (lane.pendingSupervisorDeliveries || [])
      .filter((delivery) => delivery.kind !== 'owner-decision'),
  });
  replaceProjectManagerSession({
    ...session,
    pendingSupervisorTransitions: (session.pendingSupervisorTransitions || [])
      .filter((transition) => !staleTransitionIds.has(transition.id)),
    pendingManagerDeliveries: (session.pendingManagerDeliveries || [])
      .filter((delivery) => !delivery.transitionId || !staleTransitionIds.has(delivery.transitionId)),
    workItems: session.workItems.map((candidate) => candidate.id === workItem.id
      ? { ...candidate, status: 'waiting-decision', latestBlocker: blocker, updatedAt: Date.now() }
      : candidate),
    updatedAt: Date.now(),
  });

  const result = useStore.getState().applyProjectManagerAction({
    type: 'request-user-clarification',
    question: normalized.question,
  }, session.id);
  if (!result.ok) return undefined;
  for (const projectLaneId of projectSupervisorLaneIds(session)) {
    useStore.getState().pauseSupervisorLane(projectLaneId, '任务终端存在未提交内容，等待用户处理');
  }
  const timer = projectProgressTimers.get(session.id);
  if (timer) globalThis.clearTimeout(timer);
  projectProgressTimers.delete(session.id);
  useStore.getState().appendProjectManagerEvent({
    kind: 'guard-triggered',
    workItemId: workItem.id,
    summary: '任务终端未提交草稿阻断全部执行者，已升级为项目异常并请求用户处理',
    payload: {
      decision: 'pause',
      attentionRequired: true,
      reason: 'task-terminal-input-blocked',
      laneId: lane.id,
      surfaceId: lane.surfaceId,
      resolvedAttentionKinds: ['supervisor-decision-request'],
    },
  }, session.id);
  notifyProjectManagerUserQuestion(session, normalized.question);
  void persistProjectManagerMutation(result, session.id).catch((error) => {
    console.warn('[project-manager] failed to persist task-input user intervention', error);
  });
  return normalized.question;
}

async function reconcileRecoveredProjectQuestion(
  sessionId: string,
  recoverySource: 'application-restart' | 'safe-exit',
): Promise<ProjectManagerSession | undefined> {
  const current = reconcileInheritedGoalAcceptanceFromOpenWorkItems(sessionId)
    || useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  let question = current?.pendingUserQuestion;
  if (!current || !question) return current;
  let reclassified = false;

  if (question.reasonCode === 'verification-limited') {
    const questionWorkItemId = question.workItemId;
    const workItem = questionWorkItemId
      ? current.workItems.find((candidate) => candidate.id === questionWorkItemId)
      : undefined;
    const scopedLimitation = projectVerificationLimitationForPause(
      current,
      workItem,
      question.blocker || question.context || question.question,
    );
    if (!scopedLimitation) {
      const latest = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || current;
      replaceProjectManagerSession({
        ...latest,
        pendingUserQuestion: undefined,
        workItems: latest.workItems.map((item) => item.id === question?.workItemId
          ? { ...item, verificationLimitation: undefined, updatedAt: Date.now() }
          : item),
        updatedAt: Date.now(),
      });
      await appendRecordedProjectEvent(latest, {
        kind: 'user-clarification-invalidated',
        workItemId: question.workItemId,
        summary: '恢复时发现验证限制来自其他阶段，已撤销错误的 GUI 验证提示',
        payload: {
          questionId: question.id,
          reason: 'cross-stage-verification-limitation-invalidated',
          attentionRequired: false,
        },
      }, { persistSession: false });
      const reconciled = await requestProjectPauseUserDecision(
        current.id,
        question.blocker || question.context || question.question,
        { forceRuntimeRecovery: true },
      );
      if (reconciled.question) question = reconciled.question;
      reclassified = true;
    }
  } else if (question.reasonCode === 'runtime-recovery') {
    const questionWorkItemId = question?.workItemId;
    const workItem = questionWorkItemId
      ? current.workItems.find((candidate) => candidate.id === questionWorkItemId)
      : undefined;
    const scopedLimitation = projectVerificationLimitationForPause(
      current,
      workItem,
      question.blocker || question.context || question.question,
    );
    if (scopedLimitation) {
      const previousQuestionId = question.id;
      const reconciled = await requestProjectPauseUserDecision(
        current.id,
        question.blocker || question.context || question.question,
      );
      if (reconciled.question) question = reconciled.question;
      reclassified = question.id !== previousQuestionId;
    } else {
      const latest = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || current;
      const resumeStatus = question.previousStatus === 'paused' && recoverySource !== 'safe-exit'
        ? 'paused' as const
        : 'active' as const;
      replaceProjectManagerSession({
        ...latest,
        status: resumeStatus,
        pendingUserQuestion: undefined,
        updatedAt: Date.now(),
      });
      await appendRecordedProjectEvent(latest, {
        kind: 'user-clarification-invalidated',
        workItemId: question.workItemId,
        summary: '恢复时已撤销历史内部运行故障问题，由控制层按当前协议自动重建执行链',
        payload: {
          questionId: question.id,
          reason: 'runtime-recovery-auto-retry-on-restore',
          recoverySource,
          attentionRequired: false,
        },
      });
      return useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
    }
  }

  if (!reclassified) notifyProjectManagerUserQuestion(current, question);
  await appendRecordedProjectEvent(current, {
    kind: 'user-clarification-restored',
    workItemId: question.workItemId,
    summary: `恢复后仍需用户处理：${question.question}`,
    payload: {
      question,
      questionId: question.id,
      recoverySource,
      attentionRequired: false,
    },
  });
  return useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
}

const pendingProjectManagerDeliveries: PendingProjectManagerDelivery[] = [];
interface ProjectAgentReconfigurationResult {
  ok: boolean;
  pendingRoles: ProjectAgentRole[];
  completedRoles: ProjectAgentRole[];
  errors: string[];
}
const projectAgentReconfigurationRuns = new Map<string, Promise<ProjectAgentReconfigurationResult>>();
type ProjectRuntimeEnsureRun<T> = {
  intentMask: number;
  promise: Promise<T>;
};
const PROJECT_RUNTIME_FORCE_RESTART_INTENT = 1;
const PROJECT_MANAGER_RECOVERED_AFTER_RESTART_INTENT = 2;
const projectTaskRuntimeEnsureRuns = new Map<string, ProjectRuntimeEnsureRun<ProjectTaskRuntimeEnsureResult>>();
const projectAuxiliaryRuntimeEnsureRuns = new Map<string, ProjectRuntimeEnsureRun<ProjectAuxiliaryRuntimeEnsureResult>>();
const projectSupervisorRuntimeEnsureRuns = new Map<string, ProjectRuntimeEnsureRun<ProjectSupervisorRuntimeEnsureResult>>();
const projectManagerRuntimeEnsureRuns = new Map<string, ProjectRuntimeEnsureRun<ProjectManagerRuntimeEnsureResult>>();
interface RetiredProjectSupervisorRuntime {
  projectId: string;
  taskSurfaceId: string;
  laneId: string;
  generation: number;
  retiredAt: number;
}
const retiredProjectSupervisorRuntimes = new Map<string, RetiredProjectSupervisorRuntime>();
const PROJECT_SUPERVISOR_RETIRED_RUNTIME_TTL_MS = 10 * 60_000;
let projectManagerDeliveryScheduled = false;
let projectManagerDeliveryTimerArming = false;
let projectManagerDeliveryGeneration = 0;
const projectManagerDeliverySurfacesInFlight = new Set<string>();
const PROJECT_MANAGER_IDLE_SETTLE_MS = 750;
const PROJECT_MANAGER_DELIVERY_ACK_TIMEOUT_MS = 20_000;
const PROJECT_SUPERVISOR_TRANSITION_REDELIVERY_DELAYS_MS = [
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
] as const;
const MAX_PROJECT_SUPERVISOR_TRANSITION_NOTIFICATIONS = 2;
const PROJECT_ALIGNMENT_FALLBACK_DELAY_MS = 45_000;
const PROJECT_LIVENESS_WATCHDOG_INTERVAL_MS = 30_000;
const PROJECT_LIVENESS_WATCHDOG_TRIGGER = '控制层活性看门狗发现项目执行链持续空闲';
const projectProgressTimers = new Map<string, ReturnType<typeof setTimeout>>();
const projectDeadlockRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const projectAlignmentTimers = new Map<string, ReturnType<typeof setTimeout>>();
const projectRuntimeOrphanCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const projectDeadlockEscalations = new Set<string>();
const projectManagerRuntimeRecoveries = new Set<string>();
const managedAgentWatchdogs = new Map<string, ManagedAgentWatchdogRuntime>();
const managedAgentWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();
const managedAgentDurationHistory = new Map<string, number[]>();
const managedAgentOutputTails = new Map<string, string>();
const managedAgentRecoveries = new Set<string>();
const managedAgentRecoveryFailures = new Set<string>();
const ordinaryAgentWatchdogs = new Map<string, ManagedAgentWatchdogRuntime>();
const ordinaryAgentWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();
const ordinaryAgentOutputTails = new Map<string, string>();
let projectLivenessWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
let managedAgentWatchdogGeneration = 0;
let ordinaryAgentWatchdogGeneration = 0;

function runProjectRuntimeEnsure<T>(
  runs: Map<string, ProjectRuntimeEnsureRun<T>>,
  sessionId: string,
  intentMask: number,
  operation: () => Promise<T>,
): Promise<T> {
  const current = runs.get(sessionId);
  if (current) {
    if ((current.intentMask & intentMask) === intentMask) return current.promise;
    const retryAfterCurrent = () => runProjectRuntimeEnsure(runs, sessionId, intentMask, operation);
    return current.promise.then(retryAfterCurrent, retryAfterCurrent);
  }
  const promise = Promise.resolve().then(operation).finally(() => {
    if (runs.get(sessionId)?.promise === promise) runs.delete(sessionId);
  });
  runs.set(sessionId, { intentMask, promise });
  return promise;
}

function projectManagerTerminals(projectId?: string): RemoteTaskTerminalLocation[] {
  const terminals: RemoteTaskTerminalLocation[] = [];
  for (const workspace of useStore.getState().workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const surfaces = findLeaf(workspace.splitTree, paneId)?.surfaces.filter((candidate) => (
        candidate.type === 'terminal'
        && candidate.projectManagerTerminal === true
        && (!projectId || candidate.projectManagerProjectId === projectId)
      )) || [];
      for (const surface of surfaces) {
        terminals.push({
          surfaceId: surface.id,
          paneId,
          workspaceId: workspace.id,
          workspaceTitle: workspace.title,
          projectDir: surface.currentCwd || surface.cwd || workspace.cwd,
          cwd: surface.currentCwd || surface.cwd || workspace.cwd,
          label: remoteTerminalLabel(surface),
          remoteSshControl: false,
          surface,
        });
      }
    }
  }
  return terminals;
}

function projectManagerTerminal(options: { surfaceId?: string; projectId?: string } = {}): RemoteTaskTerminalLocation | undefined {
  const terminals = projectManagerTerminals(options.projectId);
  if (options.surfaceId) return terminals.find((terminal) => terminal.surfaceId === options.surfaceId);
  if (options.projectId) {
    const boundSurfaceId = useStore.getState().projectManagers
      .find((session) => session.id === options.projectId)?.managerSurfaceId;
    const bound = terminals.find((terminal) => terminal.surfaceId === boundSurfaceId);
    if (bound) return bound;
  }
  return terminals[0];
}

interface ManagedProjectAgentTarget {
  surfaceId: string;
  role: ManagedProjectAgentRole;
  session: ProjectManagerSession;
  lane?: SupervisorLane;
  reasoningEffort: string;
  taskBudgetMinutes?: number;
}

function effectiveProjectAgentConfig(session: ProjectManagerSession) {
  return normalizeProjectManagementAgentConfig(
    session.agentConfig ?? useStore.getState().workspacePrefs.projectManagementAgents,
  );
}

function ordinarySupervisorTaskLane(surfaceId: string): SupervisorLane | undefined {
  const lane = useStore.getState().supervisor.lanes.find((candidate) => candidate.surfaceId === surfaceId);
  return ordinaryWorkerWatchdogCandidate(lane, surfaceId) ? lane : undefined;
}

function clearOrdinaryAgentWatchdog(surfaceId: string): ManagedAgentWatchdogRuntime | undefined {
  const timer = ordinaryAgentWatchdogTimers.get(surfaceId);
  if (timer) globalThis.clearTimeout(timer);
  ordinaryAgentWatchdogTimers.delete(surfaceId);
  const runtime = ordinaryAgentWatchdogs.get(surfaceId);
  ordinaryAgentWatchdogs.delete(surfaceId);
  ordinaryAgentOutputTails.delete(surfaceId);
  return runtime;
}

function reportOrdinaryAgentWatchdogFailure(
  lane: SupervisorLane,
  runtime: ManagedAgentWatchdogRuntime,
  detail: string,
): void {
  clearOrdinaryAgentWatchdog(runtime.surfaceId);
  const store = useStore.getState();
  const currentLane = store.supervisor.lanes.find((candidate) => candidate.id === lane.id);
  if (!currentLane || isProjectManagedSupervisorLane(currentLane)) return;
  store.updateLane(currentLane.id, {
    supervisorProblem: { kind: 'task-stalled', detail, detectedAt: Date.now() },
  });
  store.pauseSupervisorLane(currentLane.id, detail);
  appendSupervisorRecord(store.supervisor, currentLane, 'supervisor.review.watchdog-failed', {
    workerTurnId: currentLane.workerTurnId,
    reason: detail,
    source: 'ordinary-task-watchdog',
  });
  store.appendSupervisorLog(currentLane.id, '任务 AI 长回合恢复失败', detail);
  const workspaceId = currentLane.workspaceId || store.activeWorkspaceId;
  const notificationSurfaceId = dedicatedSupervisorSurfaceId(currentLane) || currentLane.surfaceId;
  if (workspaceId) store.addNotification({
    surfaceId: notificationSurfaceId,
    workspaceId,
    title: '普通 AI 监督需要你的处理',
    text: detail,
    ...notificationMetadata({
      owner: 'supervisor', entityId: currentLane.id, kind: 'task-watchdog-failed',
      laneId: currentLane.id, sourceLabel: currentLane.label, severity: 'error',
    }),
  });
  fireDesktopNotification({
    surfaceId: notificationSurfaceId,
    title: '普通 AI 监督需要你的处理',
    text: detail,
  });
}

function queueOrdinaryAgentWatchdogReview(
  lane: SupervisorLane,
  runtime: ManagedAgentWatchdogRuntime,
): void {
  clearOrdinaryAgentWatchdog(runtime.surfaceId);
  const store = useStore.getState();
  const currentLane = store.supervisor.lanes.find((candidate) => candidate.id === lane.id);
  if (!currentLane
    || isProjectManagedSupervisorLane(currentLane)
    || supervisorLaneControlState(currentLane) !== 'active'
    || currentLane.awaitingReview) return;
  const reviewId = `ordinary-watchdog-review-${uuid()}`;
  const screenTail = terminalScreenTail(currentLane.surfaceId, 100).slice(-8_000);
  const delivery: SupervisorDelivery = {
    id: `ordinary-watchdog-${uuid()}`,
    kind: 'task-interrupted',
    task: currentLane.currentTask || currentLane.config?.taskGoal || '当前普通任务',
    text: [
      `[普通任务 AI 长回合已中断] ${currentLane.label} (${currentLane.surfaceId})`,
      '控制层检测到当前回合长期没有可确认的语义进展，已依次发送 Esc 和 Ctrl+C；任务终端现在已回到空闲检查点。',
      '本次只保留并复用原任务终端，不调用项目 AI，也不执行项目运行时重建。',
      runtime.sourceTask ? `原任务摘要：${runtime.sourceTask}` : '',
      screenTail ? `中断后终端摘要：\n${screenTail}` : '',
      '先只读核对任务终端、工作树和最近证据，再通过 rework 派发一个改变假设、条件或执行路径的中性成果任务。不得盲目重放可能已有副作用的旧命令；无法闭合时使用 needs-human 上报用户。',
      buildSupervisorWakeEventEnvelope(currentLane.surfaceId, reviewId, false, 'on-demand'),
    ].filter(Boolean).join('\n'),
    createdAt: Date.now(),
    turnId: currentLane.workerTurnId,
    reviewId,
    stage: 'pending',
  };
  store.updateLane(currentLane.id, {
    awaitingReview: true,
    activeReviewId: reviewId,
    reviewWorkerTurnId: currentLane.workerTurnId,
    reviewOpenedAt: Date.now(),
    reviewDeliveryConfirmedAt: undefined,
    reviewWatchdogState: 'pending',
    pendingSupervisorDeliveries: enqueueSupervisorDelivery(
      currentLane.pendingSupervisorDeliveries,
      delivery,
    ),
  });
  appendSupervisorRecord(store.supervisor, currentLane, 'supervisor.review.opened', {
    reviewId,
    workerTurnId: currentLane.workerTurnId,
    source: 'ordinary-task-watchdog',
  });
  store.appendSupervisorLog(currentLane.id, '任务 AI 长回合已中断', '已进入专属监督复核，不重建任务终端');
  signalSupervisorDeliveryReady();
}

function armOrdinaryAgentWatchdog(surfaceId: string): void {
  const existing = ordinaryAgentWatchdogTimers.get(surfaceId);
  if (existing) globalThis.clearTimeout(existing);
  ordinaryAgentWatchdogTimers.delete(surfaceId);
  const runtime = ordinaryAgentWatchdogs.get(surfaceId);
  if (!runtime || runtime.phase === 'paused' || !Number.isFinite(runtime.nextDeadlineAt)) return;
  const expectedAt = runtime.nextDeadlineAt;
  const generation = runtime.generation;
  const timer = globalThis.setTimeout(() => {
    ordinaryAgentWatchdogTimers.delete(surfaceId);
    const current = ordinaryAgentWatchdogs.get(surfaceId);
    const lane = ordinarySupervisorTaskLane(surfaceId);
    if (!current || current.generation !== generation || !lane) {
      clearOrdinaryAgentWatchdog(surfaceId);
      return;
    }
    const now = Date.now();
    const adjusted = shiftManagedAgentDeadlineForSuspend(current, Math.max(0, now - expectedAt));
    if (adjusted !== current) {
      ordinaryAgentWatchdogs.set(surfaceId, adjusted);
      armOrdinaryAgentWatchdog(surfaceId);
      return;
    }
    const activity = remoteTerminalActivity(surfaceId as SurfaceId, true).activityState;
    if (activity === 'blocked') {
      ordinaryAgentWatchdogs.set(surfaceId, pauseManagedAgentWatchdog(current, now));
      return;
    }
    if (activity === 'idle') {
      clearOrdinaryAgentWatchdog(surfaceId);
      if (current.escapeSentAt || current.interruptSentAt) queueOrdinaryAgentWatchdogReview(lane, current);
      return;
    }
    const decision = evaluateManagedAgentDeadline({
      runtime: current,
      now,
      policy: ordinaryWorkerWatchdogPolicy(),
    });
    ordinaryAgentWatchdogs.set(surfaceId, decision.runtime);
    if (decision.action === 'escape' || decision.action === 'interrupt') {
      void writeProjectSupervisorControl(
        surfaceId as SurfaceId,
        decision.action === 'escape' ? '\x1b' : '\x03',
      ).then((accepted) => {
        const fresh = ordinaryAgentWatchdogs.get(surfaceId);
        if (!accepted && fresh?.generation === generation) {
          reportOrdinaryAgentWatchdogFailure(
            lane,
            fresh,
            `任务 AI 长回合无进展，且控制层无法发送${decision.action === 'escape' ? '安全退出键' : '中断键'}；监督已暂停`,
          );
        }
      });
    } else if (decision.action === 'recover') {
      reportOrdinaryAgentWatchdogFailure(
        lane,
        decision.runtime,
        '任务 AI 在 Esc、Ctrl+C 和有界等待后仍未回到空闲检查点；监督已暂停并上报用户',
      );
      return;
    }
    armOrdinaryAgentWatchdog(surfaceId);
  }, Math.max(0, expectedAt - Date.now()));
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  ordinaryAgentWatchdogTimers.set(surfaceId, timer);
}

function handleOrdinaryAgentWatchdogHook(event: any): void {
  const surfaceId = String(event?.surfaceId || '').trim();
  const lifecycle = String(event?.event || '').trim();
  const lane = surfaceId ? ordinarySupervisorTaskLane(surfaceId) : undefined;
  if (!lane) return;
  const now = Date.now();
  if (lifecycle === 'UserPromptSubmit') {
    const runtime = beginManagedAgentTurn({
      surfaceId,
      role: 'task',
      generation: ++ordinaryAgentWatchdogGeneration,
      now,
      policy: ordinaryWorkerWatchdogPolicy(),
      sourceTask: String(event?.task || ''),
    });
    clearOrdinaryAgentWatchdog(surfaceId);
    ordinaryAgentWatchdogs.set(surfaceId, runtime);
    armOrdinaryAgentWatchdog(surfaceId);
    return;
  }
  const runtime = ordinaryAgentWatchdogs.get(surfaceId);
  if (!runtime) return;
  if (lifecycle === 'PermissionRequest') {
    ordinaryAgentWatchdogs.set(surfaceId, pauseManagedAgentWatchdog(runtime, now));
    return;
  }
  if (lifecycle === 'Notification') return;
  if (lifecycle === 'PermissionResult') {
    ordinaryAgentWatchdogs.set(surfaceId, resumeManagedAgentWatchdog(runtime, now));
    armOrdinaryAgentWatchdog(surfaceId);
    return;
  }
  if (lifecycle === 'PreToolUse') {
    const command = String(event?.command || '').trim();
    const active = resumeManagedAgentWatchdog(runtime, now);
    ordinaryAgentWatchdogs.set(
      surfaceId,
      command
        ? noteManagedAgentCommand(active, now, command)
        : noteManagedAgentSemanticProgress(active, now, ordinaryWorkerWatchdogPolicy()),
    );
    armOrdinaryAgentWatchdog(surfaceId);
    return;
  }
  if (lifecycle === 'PostToolUse' || lifecycle === 'SubagentStop') {
    ordinaryAgentWatchdogs.set(
      surfaceId,
      noteManagedAgentSemanticProgress(
        resumeManagedAgentWatchdog(runtime, now),
        now,
        ordinaryWorkerWatchdogPolicy(),
      ),
    );
    armOrdinaryAgentWatchdog(surfaceId);
    return;
  }
  if (lifecycle === 'Stop' || lifecycle === 'StopFailure' || lifecycle === 'Interrupt') {
    clearOrdinaryAgentWatchdog(surfaceId);
  }
}

function handleOrdinaryAgentWatchdogOutput(surfaceId: string, data: string): void {
  const runtime = ordinaryAgentWatchdogs.get(surfaceId);
  const lane = ordinarySupervisorTaskLane(surfaceId);
  if (!runtime || runtime.phase === 'paused' || !lane) return;
  const tail = `${ordinaryAgentOutputTails.get(surfaceId) || ''}${data}`.slice(-6_000);
  ordinaryAgentOutputTails.set(surfaceId, tail);
  const fingerprint = normalizeProjectActivityFingerprintText(tail).slice(-2_000);
  const next = noteManagedAgentOutput(runtime, Date.now(), fingerprint);
  ordinaryAgentWatchdogs.set(surfaceId, next);
  if ((runtime.phase === 'escape-sent' || runtime.phase === 'interrupt-sent')
    && fingerprint !== runtime.outputFingerprint
    && looksLikeManagedShellPrompt(tail)) {
    reportOrdinaryAgentWatchdogFailure(
      lane,
      next,
      '任务 AI 长回合中断后已退出到普通 shell；无法继续自动投递，监督已暂停并上报用户',
    );
    return;
  }
  if (next.nextDeadlineAt !== runtime.nextDeadlineAt || next.phase !== runtime.phase) {
    armOrdinaryAgentWatchdog(surfaceId);
  }
}

function managedProjectAgentTarget(surfaceId: string): ManagedProjectAgentTarget | undefined {
  const store = useStore.getState();
  const manager = projectManagerTerminal({ surfaceId });
  if (manager?.surface.projectManagerTerminal && manager.surface.projectManagerProjectId) {
    const session = store.projectManagers.find((candidate) => (
      candidate.id === manager.surface.projectManagerProjectId
      && !['completed', 'stopped'].includes(candidate.status)
    ));
    if (session) {
      return {
        surfaceId,
        role: 'manager',
        session,
        reasoningEffort: manager.surface.projectManagerReasoningEffort || 'medium',
      };
    }
  }
  const lane = store.supervisor.lanes.find((candidate) => (
    candidate.projectManagerProjectId
    && supervisorLaneControlState(candidate) !== 'stopped'
    && (candidate.supervisorSurfaceId === surfaceId || candidate.surfaceId === surfaceId)
  ));
  if (!lane?.projectManagerProjectId) return undefined;
  const session = store.projectManagers.find((candidate) => (
    candidate.id === lane.projectManagerProjectId
    && candidate.status === 'active'
  ));
  if (!session) return undefined;
  if (supervisorLaneControlState(lane) !== 'active' && !session.agentIssue && !session.agentReconfiguration) {
    return undefined;
  }
  if (lane.supervisorSurfaceId === surfaceId) {
    return {
      surfaceId,
      role: 'supervisor',
      session,
      lane,
      reasoningEffort: projectSupervisorDefaults(effectiveProjectAgentConfig(session)).supervisorReasoningEffort
        || store.supervisor.supervisorReasoningEffort
        || 'medium',
    };
  }
  const taskTerminal = locateRemoteTaskTerminal(surfaceId).terminal;
  const item = session.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
  return {
    surfaceId,
    role: 'task',
    session,
    lane,
    reasoningEffort: taskTerminal?.surface.projectManagerReasoningEffort || 'medium',
    taskBudgetMinutes: item?.contract.budget.maxContinuousMinutes,
  };
}

function managedAgentHistoryKey(target: ManagedProjectAgentTarget): string {
  return `${target.role}:${target.reasoningEffort || 'medium'}`;
}

function managedAgentPolicy(target: ManagedProjectAgentTarget): ManagedAgentDeadlinePolicy {
  return managedAgentDeadlinePolicy({
    role: target.role,
    reasoningEffort: target.reasoningEffort,
    taskBudgetMinutes: target.taskBudgetMinutes,
    successfulDurationsMs: managedAgentDurationHistory.get(managedAgentHistoryKey(target)),
  });
}

function clearManagedAgentWatchdog(surfaceId: string): ManagedAgentWatchdogRuntime | undefined {
  const timer = managedAgentWatchdogTimers.get(surfaceId);
  if (timer) globalThis.clearTimeout(timer);
  managedAgentWatchdogTimers.delete(surfaceId);
  const runtime = managedAgentWatchdogs.get(surfaceId);
  managedAgentWatchdogs.delete(surfaceId);
  managedAgentOutputTails.delete(surfaceId);
  return runtime;
}

function rememberManagedAgentDuration(target: ManagedProjectAgentTarget, runtime: ManagedAgentWatchdogRuntime): void {
  const duration = Math.max(0, Date.now() - runtime.turnStartedAt);
  if (!duration || runtime.escapeSentAt || runtime.interruptSentAt) return;
  const key = managedAgentHistoryKey(target);
  managedAgentDurationHistory.set(key, [...(managedAgentDurationHistory.get(key) || []), duration].slice(-100));
}

function queueInterruptedAgentRecovery(
  target: ManagedProjectAgentTarget,
  runtime: ManagedAgentWatchdogRuntime,
): void {
  const recoveryId = `watchdog-${runtime.surfaceId}-${runtime.generation}`;
  const source = runtime.sourceTask ? `\n原回合摘要：${runtime.sourceTask}` : '';
  if (target.role === 'manager') {
    queueProjectManagerDelivery([
      `[项目 AI 中断恢复｜${recoveryId}]`,
      `项目：${target.session.id} · ${target.session.projectDir}`,
      '控制层因超过活性截止时间中断了上一回合；Agent 仍在当前会话中。',
      `${source}`,
      `先运行 wmux project status --project ${target.session.id}，核对持久状态、工作树和最近事件，再继续尚未完成的部分。`,
      '不要盲目重放可能产生副作用的命令；已生效的修改、提交、消息或外部动作必须先只读确认。',
    ].filter(Boolean).join('\n'), target.session.id, { priority: true });
    return;
  }
  if (!target.lane) return;
  const task = target.lane.currentTask || target.lane.projectWorkItemId || '当前项目任务';
  const text = target.role === 'supervisor'
    ? [
        `[专属监督中断恢复｜${recoveryId}]`,
        `项目：${target.session.id}；任务：${target.lane.projectWorkItemId || '未绑定'}`,
        '控制层因超过活性截止时间中断了你的上一回合；当前 Agent 会话仍可用。',
        source,
        '先只读核对任务终端、持久记录与工作树，再继续未完成的监督裁决。不得盲目重放可能产生副作用的动作。',
      ].filter(Boolean).join('\n')
    : [
        `[任务 AI 中断恢复｜${recoveryId}]`,
        `项目：${target.session.id}；任务：${target.lane.projectWorkItemId || '未绑定'}`,
        '控制层已中断长期无响应的任务 AI 回合；请由专属监督只读核对任务终端、工作树和最近证据。',
        source,
        '若任务 AI 已回到可接收指令的 Agent 界面，发送一条带当前上下文的恢复指令；若已落入普通 shell 或运行时退出，停止投递并等待控制层重建。不要盲目重放副作用动作。',
      ].filter(Boolean).join('\n');
  const delivery: SupervisorDelivery = {
    id: recoveryId,
    kind: target.role === 'task' ? 'task-interrupted' : 'agent-recovery',
    task,
    text,
    createdAt: Date.now(),
    turnId: target.lane.workerTurnId,
    stage: 'pending' as const,
  };
  const pending = enqueueSupervisorDelivery(target.lane.pendingSupervisorDeliveries, delivery);
  if (pending === target.lane.pendingSupervisorDeliveries) return;
  const store = useStore.getState();
  store.updateLane(target.lane.id, { pendingSupervisorDeliveries: pending });
  appendSupervisorRecord(store.supervisor, target.lane, 'supervisor.delivery.queued', {
    kind: delivery.kind,
    task,
    recoveryId,
  });
  signalSupervisorDeliveryReady();
}

async function forceRecoverManagedAgent(
  target: ManagedProjectAgentTarget,
  runtime: ManagedAgentWatchdogRuntime,
): Promise<void> {
  reconcileProjectExecutionResponsibility(target.session.id);
  const currentSession = useStore.getState().projectManagers
    .find((candidate) => candidate.id === target.session.id);
  const disposition = currentSession ? classifyProjectWatchdogScenario(currentSession, {
    hasPendingManagerDelivery: (currentSession.pendingManagerDeliveries || []).length > 0
      || pendingProjectManagerDeliveries.some((delivery) => delivery.sessionId === currentSession.id),
  }) : undefined;
  if (!disposition || !projectWatchdogMayInterveneForRole(disposition, target.role)) return;
  const recoveryKey = managedProjectRuntimeRecoveryKey({
    projectId: target.session.id,
    role: target.role,
    workItemId: target.lane?.projectWorkItemId,
  });
  if (!canStartManagedProjectRuntimeRecovery(
    recoveryKey,
    managedAgentRecoveries,
    managedAgentRecoveryFailures,
  )) return;
  managedAgentRecoveries.add(recoveryKey);
  try {
    const output = normalizeProjectActivityFingerprintText(
      managedAgentOutputTails.get(runtime.surfaceId) || runtime.outputFingerprint,
    ).slice(-1200);
    const roleLabel = target.role === 'manager'
      ? '项目 AI'
      : target.role === 'supervisor'
        ? '专属监督 AI'
        : '任务 AI';
    const detail = runtime.escapeSentAt || runtime.interruptSentAt
      ? `${roleLabel}在 Esc、Ctrl+C 后仍未恢复，控制层正在重建运行时`
      : `${roleLabel}运行时已退出或不可用，控制层正在重建运行时`;
    const store = useStore.getState();
    if (target.lane?.projectWorkItemId) {
      const item = target.session.workItems.find((candidate) => candidate.id === target.lane!.projectWorkItemId);
      const context = [
        item?.latestContextSummary || '',
        runtime.sourceTask ? `被中断回合：${runtime.sourceTask}` : '',
        output ? `中断前终端摘要：${output}` : '',
      ].filter(Boolean).join('\n').slice(-4000);
      store.applyProjectManagerAction({
        type: 'update-work-item',
        workItemId: target.lane.projectWorkItemId,
        patch: { latestContextSummary: context || item?.latestContextSummary, latestBlocker: detail },
      }, target.session.id);
    }
    await appendRecordedProjectEvent(target.session, {
      kind: 'guard-triggered',
      workItemId: target.lane?.projectWorkItemId,
      summary: detail,
      payload: {
        action: `watchdog-rebuild-${target.role}`,
        attentionRequired: false,
        recoveryKey,
        surfaceId: runtime.surfaceId,
        generation: runtime.generation,
        laneId: target.lane?.id,
      },
    });

    markTerminalRuntimeExited(runtime.surfaceId, detail);
    if (target.role === 'manager') {
      (window as any).__wmux_queueProjectManagerRuntimeRecovery?.({
        projectId: target.session.id,
        role: 'manager',
        detail,
        watchdogRecovery: true,
        recoveryKey,
      });
      return;
    }
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === target.session.id);
    if (!current || current.status !== 'active' || !target.lane?.projectWorkItemId) return;
    let result: Record<string, unknown>;
    if (target.role === 'task') {
      const recoveryLane = useStore.getState().supervisor.lanes.find((candidate) => (
        candidate.id === target.lane?.id
        && candidate.projectManagerProjectId === current.id
        && supervisorLaneControlState(candidate) === 'active'
      ));
      if (!recoveryLane) return;
      const currentItem = current.workItems.find((candidate) => candidate.id === recoveryLane.projectWorkItemId);
      const recoverySummary = [
        currentItem?.latestContextSummary || '',
        runtime.sourceTask ? `被中断回合：${runtime.sourceTask}` : '',
        output ? `中断前终端摘要：${output}` : '',
        '任务 AI 运行时已不可用；新任务 AI 必须先只读核对工作树和持久记录，再继续未完成部分。',
      ].filter(Boolean).join('\n').slice(-4000);
      useStore.getState().updateLane(recoveryLane.id, {
        projectTaskRotationPending: true,
        projectTaskRotationSummary: recoverySummary,
        projectTaskRotationRequestedAt: Date.now(),
      });
      const preparedLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === recoveryLane.id);
      result = preparedLane
        ? await rotateProjectTaskTerminalFromSupervisor(current, preparedLane)
        : { ok: false, error: '任务 AI 恢复前监督通道已不存在' };
    } else {
      result = await ensureProjectSupervisorRuntime(current.id, { forceRestart: true });
    }
    if (result?.ok) {
      managedAgentRecoveryFailures.delete(recoveryKey);
      if (target.role === 'task') {
        useStore.getState().applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: target.lane.projectWorkItemId,
          patch: { status: 'running', latestBlocker: undefined },
        }, current.id);
      }
      await appendRecordedProjectEvent(current, {
        kind: 'recovery-restored',
        workItemId: target.lane.projectWorkItemId,
        summary: `${roleLabel}运行时已自动重建并恢复受控执行链`,
        payload: {
          role: target.role,
          recoveryKey,
          resolvedAttentionKinds: ['guard-triggered'],
        },
      });
    }
    if (!result?.ok) {
      managedAgentRecoveryFailures.add(recoveryKey);
      await appendRecordedProjectEvent(current, {
        kind: target.role === 'task' ? 'task-runtime-failed' : 'supervisor-runtime-failed',
        workItemId: target.lane.projectWorkItemId,
        summary: `${roleLabel}自动重建失败：${String(result?.error || '未知错误')}`,
        payload: { role: target.role, recoveryKey, attentionRequired: true },
      });
      queueProjectManagerDelivery([
        '[项目运行链自动重建失败]',
        `项目：${current.id}；任务：${target.lane.projectWorkItemId}`,
        `原因：${String(result?.error || '未知错误')}`,
        '控制层已保留中断前上下文；请读取 project status 后决定恢复或暂缓，不要向旧终端继续投递。',
      ].join('\n'), current.id, { priority: true, dedupeKey: `runtime-recovery:${recoveryKey}` });
    }
  } catch (error) {
    managedAgentRecoveryFailures.add(recoveryKey);
    const reason = error instanceof Error ? error.message : String(error);
    console.warn('[managed-agent-watchdog] runtime recovery failed', {
      projectId: target.session.id,
      role: target.role,
      surfaceId: runtime.surfaceId,
      reason,
    });
    await appendRecordedProjectEvent(target.session, {
      kind: target.role === 'manager'
        ? 'manager-runtime-failed'
        : target.role === 'task'
          ? 'task-runtime-failed'
          : 'supervisor-runtime-failed',
      workItemId: target.lane?.projectWorkItemId,
      summary: `${target.role} 自动重建异常：${reason}`,
      payload: { role: target.role, recoveryKey, attentionRequired: true },
    });
    queueProjectManagerDelivery([
      '[项目运行链自动重建异常]',
      `项目：${target.session.id}${target.lane?.projectWorkItemId ? `；任务：${target.lane.projectWorkItemId}` : ''}`,
      `角色：${target.role}；原因：${reason}`,
      '控制层已停止向旧终端投递；请读取 project status 后人工决定恢复或暂缓。',
    ].join('\n'), target.session.id, { priority: true, dedupeKey: `runtime-recovery:${recoveryKey}` });
  } finally {
    managedAgentRecoveries.delete(recoveryKey);
  }
}

function armManagedAgentWatchdog(surfaceId: string): void {
  const existing = managedAgentWatchdogTimers.get(surfaceId);
  if (existing) globalThis.clearTimeout(existing);
  managedAgentWatchdogTimers.delete(surfaceId);
  const runtime = managedAgentWatchdogs.get(surfaceId);
  if (!runtime || runtime.phase === 'paused' || !Number.isFinite(runtime.nextDeadlineAt)) return;
  const expectedAt = runtime.nextDeadlineAt;
  const generation = runtime.generation;
  const timer = globalThis.setTimeout(() => {
    managedAgentWatchdogTimers.delete(surfaceId);
    const current = managedAgentWatchdogs.get(surfaceId);
    const target = managedProjectAgentTarget(surfaceId);
    if (!current || current.generation !== generation || !target) {
      clearManagedAgentWatchdog(surfaceId);
      return;
    }
    reconcileProjectExecutionResponsibility(target.session.id);
    const currentSession = useStore.getState().projectManagers
      .find((candidate) => candidate.id === target.session.id);
    const disposition = currentSession ? classifyProjectWatchdogScenario(currentSession, {
      hasPendingManagerDelivery: (currentSession.pendingManagerDeliveries || []).length > 0
        || pendingProjectManagerDeliveries.some((delivery) => delivery.sessionId === currentSession.id),
    }) : undefined;
    if (!disposition || !projectWatchdogMayInterveneForRole(disposition, target.role)) {
      clearManagedAgentWatchdog(surfaceId);
      return;
    }
    const now = Date.now();
    const delayedByMs = Math.max(0, now - expectedAt);
    const adjusted = shiftManagedAgentDeadlineForSuspend(current, delayedByMs);
    if (adjusted !== current) {
      managedAgentWatchdogs.set(surfaceId, adjusted);
      armManagedAgentWatchdog(surfaceId);
      return;
    }
    const activity = remoteTerminalActivity(surfaceId as SurfaceId, true).activityState;
    if (activity === 'blocked') {
      managedAgentWatchdogs.set(surfaceId, pauseManagedAgentWatchdog(current, now));
      return;
    }
    if (activity === 'idle') {
      clearManagedAgentWatchdog(surfaceId);
      if (current.escapeSentAt || current.interruptSentAt) queueInterruptedAgentRecovery(target, current);
      else rememberManagedAgentDuration(target, current);
      return;
    }
    const decision = evaluateManagedAgentDeadline({ runtime: current, now, policy: managedAgentPolicy(target) });
    managedAgentWatchdogs.set(surfaceId, decision.runtime);
    if (decision.action === 'escape' || decision.action === 'interrupt') {
      void writeProjectSupervisorControl(surfaceId as SurfaceId, decision.action === 'escape' ? '\x1b' : '\x03')
        .then((accepted) => {
          const fresh = managedAgentWatchdogs.get(surfaceId);
          if (!accepted && fresh?.generation === generation) {
            clearManagedAgentWatchdog(surfaceId);
            void forceRecoverManagedAgent(target, fresh);
          }
        });
    } else if (decision.action === 'recover') {
      clearManagedAgentWatchdog(surfaceId);
      void forceRecoverManagedAgent(target, decision.runtime);
      return;
    }
    armManagedAgentWatchdog(surfaceId);
  }, Math.max(0, expectedAt - Date.now()));
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  managedAgentWatchdogTimers.set(surfaceId, timer);
}

function handleManagedAgentHookEvent(event: any): void {
  if (handleProjectAuxiliaryHookEvent(event)) return;
  handleOrdinaryAgentWatchdogHook(event);
  const surfaceId = String(event?.surfaceId || '').trim();
  const lifecycle = String(event?.event || '').trim();
  let taskPromptAcknowledged = false;
  if (surfaceId && lifecycle === 'UserPromptSubmit') {
    markTerminalRuntimeReady(surfaceId);
    taskPromptAcknowledged = acknowledgeTaskPromptDelivery(surfaceId);
  }
  const target = surfaceId ? managedProjectAgentTarget(surfaceId) : undefined;
  if (!target) return;
  if (taskPromptAcknowledged
    && target.role === 'task'
    && target.lane?.projectWorkItemId) {
    const currentItem = target.session.workItems.find((candidate) => (
      candidate.id === target.lane?.projectWorkItemId
    ));
    if (currentItem && !['completed', 'stopped'].includes(currentItem.status)) {
      useStore.getState().applyProjectManagerAction({
        type: 'update-work-item',
        workItemId: currentItem.id,
        patch: { status: 'running', latestBlocker: undefined },
      }, target.session.id);
      useStore.getState().updateLane(target.lane.id, {
        projectTaskContractPending: false,
      });
      saveProjectManagerSnapshot(target.session.id);
    }
  }
  const confirmsSubmittedPrompt = [
    'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop', 'StopFailure', 'Interrupt',
  ].includes(lifecycle);
  if (target.role === 'manager' && confirmsSubmittedPrompt) {
    acknowledgeProjectManagerDelivery(surfaceId, lifecycle);
  }
  const now = Date.now();
  if (lifecycle === 'UserPromptSubmit') {
    managedAgentRecoveryFailures.delete(managedProjectRuntimeRecoveryKey({
      projectId: target.session.id,
      role: target.role,
      workItemId: target.lane?.projectWorkItemId,
    }));
    const runtime = beginManagedAgentTurn({
      surfaceId,
      role: target.role,
      generation: ++managedAgentWatchdogGeneration,
      now,
      policy: managedAgentPolicy(target),
      sourceTask: String(event?.task || ''),
    });
    clearManagedAgentWatchdog(surfaceId);
    managedAgentWatchdogs.set(surfaceId, runtime);
    armManagedAgentWatchdog(surfaceId);
    reconcileProjectExecutionResponsibility(
      target.session.id,
      now,
      managedRoleResponsibilityOwner(target.role),
    );
    return;
  }
  const runtime = managedAgentWatchdogs.get(surfaceId);
  if (!runtime) {
    if (['PreToolUse', 'PostToolUse', 'SubagentStop'].includes(lifecycle)) {
      reconcileProjectExecutionResponsibility(
        target.session.id,
        now,
        managedRoleResponsibilityOwner(target.role),
      );
    }
    if (['Stop', 'StopFailure', 'Interrupt'].includes(lifecycle)) {
      reconcileProjectExecutionResponsibility(target.session.id, now);
      queueMicrotask(() => {
        void processProjectAgentReconfiguration(target.session.id, surfaceId)
          .catch((error) => console.warn('[project-manager] pending agent switch failed', error));
        if (target.role === 'manager') {
          flushProjectManagerDeliveries();
          void ensureProjectDeadlockRecovery(
            target.session.id,
            `项目 AI 回合以 ${lifecycle} 结束后仍无活动执行链`,
          ).catch((error) => console.warn('[project-manager] deadlock escalation failed', error));
        }
      });
    }
    return;
  }
  if (lifecycle === 'Notification' || lifecycle === 'PermissionRequest') {
    managedAgentWatchdogs.set(surfaceId, pauseManagedAgentWatchdog(runtime, now));
    armManagedAgentWatchdog(surfaceId);
    return;
  }
  if (lifecycle === 'PermissionResult') {
    managedAgentWatchdogs.set(surfaceId, resumeManagedAgentWatchdog(runtime, now));
    armManagedAgentWatchdog(surfaceId);
    return;
  }
  if (lifecycle === 'PreToolUse') {
    const command = String(event?.command || '').trim();
    const activeRuntime = resumeManagedAgentWatchdog(runtime, now);
    const next = command
      ? noteManagedAgentCommand(activeRuntime, now, command)
      : noteManagedAgentSemanticProgress(activeRuntime, now, managedAgentPolicy(target));
    managedAgentWatchdogs.set(surfaceId, next);
    armManagedAgentWatchdog(surfaceId);
    reconcileProjectExecutionResponsibility(
      target.session.id,
      now,
      managedRoleResponsibilityOwner(target.role),
    );
    return;
  }
  if (lifecycle === 'PostToolUse' || lifecycle === 'SubagentStop') {
    const activeRuntime = resumeManagedAgentWatchdog(runtime, now);
    managedAgentWatchdogs.set(
      surfaceId,
      noteManagedAgentSemanticProgress(activeRuntime, now, managedAgentPolicy(target)),
    );
    armManagedAgentWatchdog(surfaceId);
    reconcileProjectExecutionResponsibility(
      target.session.id,
      now,
      managedRoleResponsibilityOwner(target.role),
    );
    return;
  }
  if (lifecycle === 'Stop' || lifecycle === 'StopFailure' || lifecycle === 'Interrupt') {
    clearManagedAgentWatchdog(surfaceId);
    reconcileProjectExecutionResponsibility(target.session.id, now);
    if (runtime.escapeSentAt || runtime.interruptSentAt) queueInterruptedAgentRecovery(target, runtime);
    else rememberManagedAgentDuration(target, runtime);
    if (target.role === 'manager') {
      queueMicrotask(() => {
        flushProjectManagerDeliveries();
        void processProjectAgentReconfiguration(target.session.id, surfaceId)
          .catch((error) => console.warn('[project-manager] pending agent switch failed', error));
        void ensureProjectDeadlockRecovery(
          target.session.id,
          `项目 AI 回合以 ${lifecycle} 结束后仍无活动执行链`,
        ).catch((error) => console.warn('[project-manager] deadlock escalation failed', error));
      });
    } else {
      queueMicrotask(() => {
        void processProjectAgentReconfiguration(target.session.id, surfaceId)
          .catch((error) => console.warn('[project-manager] pending agent switch failed', error));
      });
    }
  }
}

function reportProjectAgentProviderLimit(target: ManagedProjectAgentTarget, text: string): boolean {
  const error = detectSupervisorProviderLimit(text);
  if (!error) return false;
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === target.session.id);
  if (!current || (
    current.agentIssue?.role === target.role
    && current.agentIssue?.category === error.category
    && current.agentIssue?.surfaceId === target.surfaceId
  )) return false;
  patchProjectAgentSession(current.id, {
    agentIssue: {
      role: target.role,
      category: error.category,
      summary: error.summary,
      detectedAt: Date.now(),
      surfaceId: target.surfaceId,
      laneId: target.lane?.id,
      workItemId: target.lane?.projectWorkItemId,
    },
  });
  if (target.lane) {
    useStore.getState().pauseSupervisorLane(target.lane.id, 'Agent 模型额度或速率受限，等待用户重新配置');
    if (target.role === 'supervisor') {
      useStore.getState().updateLane(target.lane.id, {
        supervisorProblem: { kind: 'provider-limit', detail: error.summary, detectedAt: Date.now() },
      });
    }
    if (target.role === 'task' && target.lane.projectWorkItemId) {
      useStore.getState().applyProjectManagerAction({
        type: 'update-work-item',
        workItemId: target.lane.projectWorkItemId,
        patch: { latestBlocker: `任务 AI 模型受限：${error.summary}` },
      }, current.id);
    }
  }
  const roleLabel = target.role === 'manager' ? '项目 AI' : target.role === 'supervisor' ? '专属监督 AI' : '任务 AI';
  void appendRecordedProjectEvent(current, {
    kind: 'project-agent-limit-detected',
    workItemId: target.lane?.projectWorkItemId,
    summary: `${roleLabel}额度或速率受限：${error.summary}`,
    payload: {
      role: target.role,
      category: error.category,
      laneId: target.lane?.id,
      surfaceId: target.surfaceId,
      attentionRequired: true,
    },
  }).catch((appendError) => console.warn('[project-manager] failed to record provider limit', appendError));
  return true;
}

function handleManagedAgentOutput(surfaceId: string, data: string): void {
  handleOrdinaryAgentWatchdogOutput(surfaceId, data);
  const runtime = managedAgentWatchdogs.get(surfaceId);
  const target = managedProjectAgentTarget(surfaceId);
  if (!runtime || runtime.phase === 'paused' || !target) return;
  const tail = `${managedAgentOutputTails.get(surfaceId) || ''}${data}`.slice(-6000);
  managedAgentOutputTails.set(surfaceId, tail);
  if (reportProjectAgentProviderLimit(target, tail)) {
    managedAgentWatchdogs.set(surfaceId, pauseManagedAgentWatchdog(runtime, Date.now()));
    return;
  }
  const fingerprint = normalizeProjectActivityFingerprintText(tail).slice(-2000);
  const now = Date.now();
  const next = noteManagedAgentOutput(runtime, now, fingerprint);
  if (
    (runtime.phase === 'escape-sent' || runtime.phase === 'interrupt-sent')
    && fingerprint
    && fingerprint !== runtime.outputFingerprint
  ) {
    const target = managedProjectAgentTarget(surfaceId);
    if (target && looksLikeManagedShellPrompt(tail)) {
      clearManagedAgentWatchdog(surfaceId);
      void forceRecoverManagedAgent(target, next);
      return;
    }
    // Esc/Ctrl+C can redraw a TUI (for example Codex Transcript) without any
    // Agent progress. Only a lifecycle hook may cancel the bounded escalation.
  }
  managedAgentWatchdogs.set(surfaceId, next);
  if (next.nextDeadlineAt !== runtime.nextDeadlineAt || next.phase !== runtime.phase) {
    armManagedAgentWatchdog(surfaceId);
  }
}

function projectRuntimeWorkspaceId(projectId: string): WorkspaceId | undefined {
  return useStore.getState().workspaces.find((workspace) => (
    getAllPaneIds(workspace.splitTree).some((paneId) => (
      findLeaf(workspace.splitTree, paneId)?.surfaces.some((surface) => (
        surface.projectManagerProjectId === projectId
        || surface.projectSupervisorProjectId === projectId
      ))
    ))
  ))?.id;
}

function projectOwnedRuntimeSurfaceIds(projectId: string, seed: readonly string[] = []): string[] {
  const surfaceIds = new Set(seed.filter(Boolean));
  for (const workspace of useStore.getState().workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      for (const surface of findLeaf(workspace.splitTree, paneId)?.surfaces || []) {
        if (surface.type === 'terminal'
          && (surface.projectManagerProjectId === projectId || surface.projectSupervisorProjectId === projectId)) {
          surfaceIds.add(surface.id);
        }
      }
    }
  }
  return [...surfaceIds];
}

function projectOwnedSurfaceIds(projectId: string): string[] {
  const surfaceIds = new Set<string>();
  for (const workspace of useStore.getState().workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      for (const surface of findLeaf(workspace.splitTree, paneId)?.surfaces || []) {
        if (surface.projectManagerProjectId === projectId || surface.projectSupervisorProjectId === projectId) {
          surfaceIds.add(surface.id);
        }
      }
    }
  }
  return [...surfaceIds];
}

function projectKnownRuntimeSurfaceIds(session: ProjectManagerSession): string[] {
  const lanes = useStore.getState().supervisor.lanes.filter((lane) => lane.projectManagerProjectId === session.id);
  return [...new Set([
    session.managerSurfaceId,
    session.taskTerminalSurfaceId,
    session.auxiliaryTaskTerminalSurfaceId,
    ...lanes.flatMap((lane) => [lane.supervisorSurfaceId, lane.surfaceId]),
    ...session.workItems.flatMap((item) => [
      item.workerSurfaceId,
    ]),
    ...(session.safeExit?.terminalCheckpoints.map((checkpoint) => checkpoint.surfaceId) || []),
    ...(session.safeExit?.blockedTerminalIds || []),
  ].filter((surfaceId): surfaceId is string => !!surfaceId))];
}

function teardownManagedProject(session: ProjectManagerSession, reason = '项目已删除并解除监督绑定'): void {
  const store = useStore.getState();
  const ownedSurfaceIds = projectOwnedSurfaceIds(session.id);
  for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
    if (pendingProjectManagerDeliveries[index].sessionId === session.id) {
      pendingProjectManagerDeliveries.splice(index, 1);
    }
  }
  const lanes = store.supervisor.lanes.filter((lane) => lane.projectManagerProjectId === session.id);

  for (const lane of lanes) store.stopSupervisorLane(lane.id, reason);
  for (const surfaceId of ownedSurfaceIds) closeLiveSurfaceById(surfaceId as SurfaceId);

  const timer = projectProgressTimers.get(session.id);
  if (timer) globalThis.clearTimeout(timer);
  projectProgressTimers.delete(session.id);
  for (const surfaceId of [
    session.managerSurfaceId,
    ...lanes.flatMap((lane) => [lane.supervisorSurfaceId, lane.surfaceId]),
  ].filter(Boolean) as string[]) {
    clearManagedAgentWatchdog(surfaceId);
  }
  const alignmentTimer = projectAlignmentTimers.get(session.id);
  if (alignmentTimer) globalThis.clearTimeout(alignmentTimer);
  projectAlignmentTimers.delete(session.id);
}

async function stopManagedProjectRuntime(session: ProjectManagerSession, reason: string): Promise<void> {
  const surfaceIds = projectOwnedRuntimeSurfaceIds(session.id);
  await Promise.all(surfaceIds.map(async (surfaceId) => {
    if (!hasLiveSurface(surfaceId as SurfaceId)) return;
    if (remoteTerminalActivity(surfaceId as SurfaceId, true).activityState === 'working') {
      await writeProjectSupervisorControl(surfaceId as SurfaceId, '\x03');
    }
  }));
  teardownManagedProject(session, reason);
}

export function redactProjectSafeExitExcerpt(value: string): string {
  return value
    .replace(/\b(?:sk-|ghp_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/gu, '已隐藏凭据')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, 'Bearer 已隐藏凭据')
    .replace(/\b(secret|token|password|api[_ -]?key)\s*[:=]\s*\S+/giu, '$1: 已隐藏凭据')
    .slice(-1200);
}

/** A stale lifecycle claim is safe only when the terminal positively shows a non-running Agent UI. */
export function projectSafeExitEffectiveActivity(options: {
  activityState: RemoteTerminalActivityState;
  activityUpdatedAt: number | null;
  inputState: ProjectSafeExitTerminalCheckpoint['inputState'];
  screen: string;
  now?: number;
}): RemoteTerminalActivityState {
  if (!['working', 'unknown'].includes(options.activityState)
    || options.inputState !== 'empty'
    || !options.activityUpdatedAt
    || (options.now ?? Date.now()) - options.activityUpdatedAt <= AGENT_WORKING_TRUST_MS) {
    return options.activityState;
  }
  const stoppedUi = interactiveAgentPromptReady(options.screen)
    || !!interactiveAgentShellPromptFailureDetail(options.screen);
  return stoppedUi ? 'idle' : options.activityState;
}

function projectSafeExitTerminalCheckpoints(
  session: ProjectManagerSession,
  includeExcerpt: boolean,
): ProjectSafeExitTerminalCheckpoint[] {
  const state = useStore.getState();
  const checkpoints = new Map<string, ProjectSafeExitTerminalCheckpoint>();
  const add = (
    surfaceId: string | null | undefined,
    role: ProjectSafeExitTerminalCheckpoint['role'],
    label: string,
    workItemId?: string,
  ) => {
    if (!surfaceId || !hasLiveSurface(surfaceId as SurfaceId) || checkpoints.has(surfaceId)) return;
    const activity = remoteTerminalActivity(surfaceId as SurfaceId, true);
    const buffer = surfaceTerminalRegistry.get(surfaceId)?.buffer.active;
    const inputState = !buffer ? 'unknown' : hasPendingTerminalInput(buffer) ? 'pending' : 'empty';
    const rawScreen = readTerminalScreen(surfaceId as SurfaceId, 80).text || '';
    const activityState = projectSafeExitEffectiveActivity({
      activityState: activity.activityState,
      activityUpdatedAt: activity.activityUpdatedAt,
      inputState,
      screen: rawScreen,
    });
    checkpoints.set(surfaceId, {
      surfaceId,
      role,
      label,
      ...(workItemId ? { workItemId } : {}),
      activityState,
      ...(activity.activityUpdatedAt ? { activityUpdatedAt: activity.activityUpdatedAt } : {}),
      inputState,
      ...(includeExcerpt ? {
        excerpt: redactProjectSafeExitExcerpt(
          projectStableTerminalScreen(surfaceId, label, activity.activityState),
        ),
      } : {}),
    });
  };

  add(session.managerSurfaceId, 'project-ai', '项目 AI');
  add(session.taskTerminalSurfaceId, 'task-ai', '项目预留任务 AI');
  for (const lane of state.supervisor.lanes.filter((candidate) => (
    candidate.projectManagerProjectId === session.id && supervisorLaneControlState(candidate) !== 'stopped'
  ))) {
    add(lane.supervisorSurfaceId, 'supervisor-ai', `${lane.label} · 监督 AI`, lane.projectWorkItemId);
    add(lane.surfaceId, 'task-ai', `${lane.label} · 任务 AI`, lane.projectWorkItemId);
  }
  for (const item of session.workItems) {
    add(item.workerSurfaceId, 'task-ai', `${item.title} · 任务 AI`, item.id);
  }
  for (const workspace of state.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      for (const surface of findLeaf(workspace.splitTree, paneId)?.surfaces || []) {
        if (surface.type !== 'terminal'
          || (surface.projectManagerProjectId !== session.id && surface.projectSupervisorProjectId !== session.id)) {
          continue;
        }
        const role: ProjectSafeExitTerminalCheckpoint['role'] = surface.projectManagerTerminal
          ? 'project-ai'
          : surface.projectSupervisorProjectId === session.id
            ? 'supervisor-ai'
            : 'task-ai';
        add(
          surface.id,
          role,
          surface.customTitle || (role === 'project-ai' ? '项目 AI' : role === 'supervisor-ai' ? '监督 AI' : '任务 AI'),
          surface.projectManagerWorkItemId,
        );
      }
    }
  }
  for (const checkpoint of session.safeExit?.terminalCheckpoints || []) {
    add(checkpoint.surfaceId, checkpoint.role, checkpoint.label, checkpoint.workItemId);
  }
  return [...checkpoints.values()];
}

async function waitForProjectSafeExitCheckpoints(
  sessionId: string,
  timeoutMs = 4_000,
): Promise<ProjectSafeExitTerminalCheckpoint[]> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const session = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
    if (!session) return [];
    const checkpoints = projectSafeExitTerminalCheckpoints(session, false);
    if (checkpoints.some((checkpoint) => checkpoint.inputState === 'pending')) {
      return projectSafeExitTerminalCheckpoints(session, true);
    }
    if (checkpoints.every((checkpoint) => (
      (checkpoint.activityState === 'idle' || checkpoint.activityState === 'blocked')
      && checkpoint.inputState === 'empty'
    ))) {
      return projectSafeExitTerminalCheckpoints(session, true);
    }
    if (Date.now() >= deadline) return projectSafeExitTerminalCheckpoints(session, true);
    await waitForControlPlaneDelay(200);
  }
}

async function closeProjectRuntimeAfterSafeExit(projectId: string, checkpointSurfaceIds: readonly string[]): Promise<string[]> {
  const store = useStore.getState();
  const surfaceIds = projectOwnedRuntimeSurfaceIds(projectId, checkpointSurfaceIds);
  const unsafe = surfaceIds.filter((surfaceId) => {
    if (!hasLiveSurface(surfaceId as SurfaceId)) return false;
    const activity = remoteTerminalActivity(surfaceId as SurfaceId, true);
    const buffer = surfaceTerminalRegistry.get(surfaceId)?.buffer.active;
    const inputState = !buffer ? 'unknown' : hasPendingTerminalInput(buffer) ? 'pending' : 'empty';
    const activityState = projectSafeExitEffectiveActivity({
      activityState: activity.activityState,
      activityUpdatedAt: activity.activityUpdatedAt,
      inputState,
      screen: readTerminalScreen(surfaceId as SurfaceId, 80).text || '',
    });
    return (activityState !== 'idle' && activityState !== 'blocked')
      || !buffer
      || hasPendingTerminalInput(buffer);
  });
  if (unsafe.length > 0) return unsafe;
  const lanes = store.supervisor.lanes.filter((lane) => lane.projectManagerProjectId === projectId);
  for (const lane of lanes) store.stopSupervisorLane(lane.id, '项目进度已保存，旧运行时已安全退出');
  for (const surfaceId of new Set(surfaceIds)) {
    cancelPendingAutomatedTerminalSubmit(surfaceId as SurfaceId, true);
    closeLiveSurfaceById(surfaceId as SurfaceId);
    window.wmux?.pty?.kill?.(surfaceId as SurfaceId);
    clearManagedAgentWatchdog(surfaceId);
  }
  const progressTimer = projectProgressTimers.get(projectId);
  if (progressTimer) globalThis.clearTimeout(progressTimer);
  projectProgressTimers.delete(projectId);
  const alignmentTimer = projectAlignmentTimers.get(projectId);
  if (alignmentTimer) globalThis.clearTimeout(alignmentTimer);
  projectAlignmentTimers.delete(projectId);
  const orphanCleanupTimer = projectRuntimeOrphanCleanupTimers.get(projectId);
  if (orphanCleanupTimer) globalThis.clearTimeout(orphanCleanupTimer);
  projectRuntimeOrphanCleanupTimers.delete(projectId);
  const ptyHas = (window as any).wmux?.pty?.has as ((surfaceId: string) => Promise<boolean>) | undefined;
  if (!ptyHas && surfaceIds.length > 0) return surfaceIds;
  const deadline = Date.now() + 2_000;
  while (true) {
    const remaining: string[] = [];
    for (const surfaceId of surfaceIds) {
      if (hasLiveSurface(surfaceId as SurfaceId)) {
        remaining.push(surfaceId);
        continue;
      }
      if (!ptyHas) continue;
      try {
        if (await ptyHas(surfaceId)) remaining.push(surfaceId);
      } catch {
        remaining.push(surfaceId);
      }
    }
    if (remaining.length === 0 || Date.now() >= deadline) return remaining;
    await waitForControlPlaneDelay(100);
  }
}

async function saveProjectProgressAndExitRuntime(
  sessionId: string,
  reason: string,
): Promise<Record<string, unknown>> {
  if (savingProjectManagerSessions.has(sessionId)) {
    return { ok: false, error: '项目正在保存进度，请等待当前操作完成' };
  }
  const initial = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!initial) return { ok: false, error: '当前项目不存在' };
  if (['completed', 'stopped'].includes(initial.status)) {
    return { ok: false, error: '已完成或停止的项目没有需要保存的运行时' };
  }
  if (initial.safeExit?.status === 'saved') {
    const savedSurfaceIds = projectOwnedRuntimeSurfaceIds(initial.id, projectKnownRuntimeSurfaceIds(initial));
    const ptyHas = (window as any).wmux?.pty?.has as ((surfaceId: string) => Promise<boolean>) | undefined;
    let confirmedAbsent = savedSurfaceIds.length === 0;
    if (savedSurfaceIds.length > 0 && ptyHas) {
      confirmedAbsent = true;
      for (const surfaceId of savedSurfaceIds) {
        if (hasLiveSurface(surfaceId as SurfaceId)) {
          confirmedAbsent = false;
          break;
        }
        try {
          if (await ptyHas(surfaceId)) {
            confirmedAbsent = false;
            break;
          }
        } catch {
          confirmedAbsent = false;
          break;
        }
      }
    }
    if (confirmedAbsent) {
      return { ok: true, safeExited: true, message: '项目进度已经保存，运行时已确认退出。' };
    }
  }

  savingProjectManagerSessions.add(sessionId);
  let runtimeCloseConfirmed = false;
  try {
    const requestedAt = initial.safeExit?.requestedAt || Date.now();
    const initiallyKnownRuntimeSurfaceIds = projectKnownRuntimeSurfaceIds(initial);
    if (initial.status !== 'paused') {
      const paused = useStore.getState().applyProjectManagerAction({
        type: 'pause-project',
        reason: '用户请求保存项目进度并安全退出',
        source: 'user',
      }, sessionId);
      if (!paused.ok) return { ok: false, error: paused.error || '无法暂停项目以保存进度' };
    }
    const pausedSession = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initial;
    for (const laneId of projectSupervisorLaneIds(pausedSession)) {
      useStore.getState().pauseSupervisorLane(laneId, '正在等待安全检查点，停止派发新任务');
    }
    for (const checkpoint of projectSafeExitTerminalCheckpoints(pausedSession, false)) {
      cancelPendingAutomatedTerminalSubmit(checkpoint.surfaceId as SurfaceId, true);
    }
    const progressTimer = projectProgressTimers.get(sessionId);
    if (progressTimer) globalThis.clearTimeout(progressTimer);
    projectProgressTimers.delete(sessionId);
    replaceProjectManagerSession({
      ...pausedSession,
      safeExit: {
        status: 'saving',
        requestedAt,
        updatedAt: Date.now(),
        reason,
        terminalCheckpoints: [],
      },
      updatedAt: Date.now(),
    });
    const savingSession = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId)!;
    await appendRecordedProjectEvent(savingSession, {
      kind: 'project-safe-exit-requested',
      summary: '用户请求保存当前项目进度并安全退出运行时',
      payload: { reason },
    });

    const checkpoints = await waitForProjectSafeExitCheckpoints(sessionId);
    const blocked = checkpoints.filter((checkpoint) => (
      (checkpoint.activityState !== 'idle' && checkpoint.activityState !== 'blocked')
      || checkpoint.inputState !== 'empty'
    ));
    if (blocked.length > 0) {
      const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId)!;
      const pendingInput = blocked.filter((checkpoint) => checkpoint.inputState === 'pending');
      const unknownInput = blocked.filter((checkpoint) => checkpoint.inputState === 'unknown');
      const error = pendingInput.length > 0
        ? `仍有 ${pendingInput.length} 个终端存在未提交输入：${pendingInput.map((item) => item.label).join('、')}`
        : unknownInput.length > 0
          ? `仍有 ${unknownInput.length} 个终端无法确认输入框状态：${unknownInput.map((item) => item.label).join('、')}`
          : `仍有 ${blocked.length} 个终端未到达安全检查点：${blocked.map((item) => item.label).join('、')}`;
      replaceProjectManagerSession({
        ...current,
        safeExit: {
          status: 'blocked',
          requestedAt,
          updatedAt: Date.now(),
          reason,
          terminalCheckpoints: checkpoints,
          blockedTerminalIds: blocked.map((item) => item.surfaceId),
          error,
        },
        updatedAt: Date.now(),
      });
      const blockedSession = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId)!;
      await appendRecordedProjectEvent(blockedSession, {
        kind: 'project-safe-exit-failed',
        summary: error,
        payload: {
          attentionRequired: true,
          blockedTerminals: blocked.map((item) => ({ id: item.surfaceId, label: item.label, state: item.activityState })),
        },
      });
      return {
        ok: true,
        safeExited: false,
        blockedTerminals: blocked.map((item) => item.label),
        message: `${error}。项目保持暂停；可稍后重试，不会强制关闭。`,
      };
    }

    const beforeCheckpoint = useStore.getState().projectManagers
      .find((candidate) => candidate.id === sessionId)!;
    const progressCheckpointed = beforeCheckpoint.progressSync?.status === 'review-required'
      ? (await scanProjectProgressForReview(sessionId, '用户安全退出前保存项目进度', false)).ok
      : await checkpointProjectProgress(sessionId, '用户安全退出前保存项目进度');
    if (!progressCheckpointed) {
      const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId)!;
      const error = current.progressSync?.summary || '项目目录快照保存失败';
      replaceProjectManagerSession({
        ...current,
        safeExit: {
          status: 'blocked',
          requestedAt,
          updatedAt: Date.now(),
          reason,
          terminalCheckpoints: checkpoints,
          error,
        },
        updatedAt: Date.now(),
      });
      const failedSession = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId)!;
      await appendRecordedProjectEvent(failedSession, {
        kind: 'project-safe-exit-failed',
        summary: `项目进度保存失败：${error}`,
        payload: { attentionRequired: true, phase: 'progress-snapshot' },
      });
      return { ok: true, safeExited: false, message: `项目进度保存失败：${error}。运行时保持暂停且未关闭。` };
    }

    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId)!;
    const finalCheckpoints = projectSafeExitTerminalCheckpoints(current, true);
    const finalBlocked = finalCheckpoints.filter((checkpoint) => (
      (checkpoint.activityState !== 'idle' && checkpoint.activityState !== 'blocked')
      || checkpoint.inputState !== 'empty'
    ));
    if (finalBlocked.length > 0) {
      const finalPendingInput = finalBlocked.filter((checkpoint) => checkpoint.inputState === 'pending');
      const finalUnknownInput = finalBlocked.filter((checkpoint) => checkpoint.inputState === 'unknown');
      const error = finalPendingInput.length > 0
        ? `保存快照期间有 ${finalPendingInput.length} 个终端出现未提交输入：${finalPendingInput.map((item) => item.label).join('、')}`
        : finalUnknownInput.length > 0
          ? `保存快照期间有 ${finalUnknownInput.length} 个终端无法确认输入框状态：${finalUnknownInput.map((item) => item.label).join('、')}`
          : `保存快照期间有 ${finalBlocked.length} 个终端重新进入活动状态：${finalBlocked.map((item) => item.label).join('、')}`;
      replaceProjectManagerSession({
        ...current,
        safeExit: {
          status: 'blocked',
          requestedAt,
          updatedAt: Date.now(),
          reason,
          terminalCheckpoints: finalCheckpoints,
          blockedTerminalIds: finalBlocked.map((item) => item.surfaceId),
          error,
        },
        updatedAt: Date.now(),
      });
      const failedSession = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId)!;
      await appendRecordedProjectEvent(failedSession, {
        kind: 'project-safe-exit-failed',
        summary: error,
        payload: { attentionRequired: true, phase: 'final-quiescence-check' },
      });
      return { ok: true, safeExited: false, message: `${error}。项目保持暂停且未关闭，可稍后重试。` };
    }
    const runtimeSurfaceIds = [...new Set([
      ...initiallyKnownRuntimeSurfaceIds,
      ...projectKnownRuntimeSurfaceIds(current),
    ])];
    const checkpointSurfaceIds = new Set(finalCheckpoints.map((checkpoint) => checkpoint.surfaceId));
    const durableCheckpoints = [
      ...finalCheckpoints,
      ...(initial.safeExit?.terminalCheckpoints || []).filter((checkpoint) => {
        if (checkpointSurfaceIds.has(checkpoint.surfaceId)) return false;
        checkpointSurfaceIds.add(checkpoint.surfaceId);
        return true;
      }),
    ].slice(0, 100);
    const checkpointedAt = Date.now();
    const checkpointed = restoredProjectManagerSession({
      ...current,
      safeExit: {
        status: 'saving',
        requestedAt,
        updatedAt: checkpointedAt,
        reason,
        progressFingerprint: current.progressSnapshot?.fingerprint,
        terminalCheckpoints: durableCheckpoints,
      },
      updatedAt: checkpointedAt,
    }, undefined, 'safe-exit');
    replaceProjectManagerSession(checkpointed);
    await (window as any).wmux?.projectManager?.saveSession?.(checkpointed);

    const stillLive = await closeProjectRuntimeAfterSafeExit(sessionId, [
      ...runtimeSurfaceIds,
      ...durableCheckpoints.map((item) => item.surfaceId),
    ]);
    if (stillLive.length > 0) {
      const latest = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId)!;
      const error = `以下终端未能关闭：${stillLive.join('、')}`;
      replaceProjectManagerSession({
        ...latest,
        safeExit: {
          ...latest.safeExit!,
          status: 'blocked',
          updatedAt: Date.now(),
          blockedTerminalIds: stillLive,
          error,
        },
        updatedAt: Date.now(),
      });
      const failedSession = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId)!;
      await appendRecordedProjectEvent(failedSession, {
        kind: 'project-safe-exit-failed',
        summary: error,
        payload: { attentionRequired: true, phase: 'runtime-close' },
      });
      return { ok: true, safeExited: false, message: `${error}。项目保持暂停，可重试关闭。` };
    }
    runtimeCloseConfirmed = true;
    const completedAt = Date.now();
    const saved: ProjectManagerSession = {
      ...(useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || checkpointed),
      safeExit: {
        ...checkpointed.safeExit!,
        status: 'saved',
        updatedAt: completedAt,
        completedAt,
        blockedTerminalIds: undefined,
        error: undefined,
      },
      updatedAt: completedAt,
    };
    replaceProjectManagerSession(saved);
    await appendRecordedProjectEvent(saved, {
      kind: 'project-safe-exit-completed',
      summary: `项目进度已保存，${durableCheckpoints.length} 个运行终端已形成恢复检查点且已确认退出`,
      payload: {
        terminalCount: durableCheckpoints.length,
        progressFingerprint: saved.progressSnapshot?.fingerprint,
        resolvedAttentionKinds: ['project-safe-exit-failed'],
      },
    });
    return {
      ok: true,
      safeExited: true,
      message: '项目进度和恢复摘要已保存，项目 AI、监督 AI 与任务 AI 运行时已安全退出。',
    };
  } catch (error) {
    const message = String((error as Error)?.message || error || '未知错误');
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
    if (current) {
      const failureSummary = runtimeCloseConfirmed
        ? `运行时已退出，但安全退出完成状态持久化失败：${message}`
        : `保存项目进度失败：${message}`;
      const failed: ProjectManagerSession = {
        ...current,
        safeExit: {
          status: 'blocked',
          requestedAt: current.safeExit?.requestedAt || Date.now(),
          updatedAt: Date.now(),
          reason,
          terminalCheckpoints: current.safeExit?.terminalCheckpoints || [],
          blockedTerminalIds: current.safeExit?.blockedTerminalIds,
          error: failureSummary,
        },
        updatedAt: Date.now(),
      };
      replaceProjectManagerSession(failed);
      try {
        await appendRecordedProjectEvent(failed, {
          kind: 'project-safe-exit-failed',
          summary: failureSummary,
          payload: {
            attentionRequired: true,
            phase: runtimeCloseConfirmed ? 'completion-persistence' : 'unexpected-error',
          },
        });
      } catch {
        const latest = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || failed;
        try {
          await (window as any).wmux?.projectManager?.saveSession?.(latest);
        } catch {
          /* The returned error remains authoritative when even fallback persistence is unavailable. */
        }
      }
    }
    return {
      ok: false,
      error: runtimeCloseConfirmed
        ? `项目进度已保存且运行时已退出，但完成状态记录失败：${message}。可从已保存检查点恢复。`
        : `保存项目进度失败：${message}。项目保持暂停，运行时未被强制关闭，可重试保存。`,
    };
  } finally {
    savingProjectManagerSessions.delete(sessionId);
  }
}function failProjectManagerDelivery(
  delivery: PendingProjectManagerDelivery,
  detail?: string,
): void {
  delivery.stage = 'failed';
  delivery.attempts = MAX_PROJECT_MANAGER_DELIVERY_RETRY_ATTEMPTS;
  if (delivery.sessionId) {
    updatePersistedProjectManagerDeliveries(delivery.sessionId, (deliveries) => deliveries.map((candidate) => (
      candidate.id === delivery.id
        ? { ...candidate, stage: 'failed' as const, submittedAt: delivery.submittedAt }
        : candidate
    )));
  }
  if (delivery.alerted) return;
  delivery.alerted = true;
  notifyProjectManagerDeliveryUnavailable(delivery, detail);
}

function flushProjectManagerDeliveries(): void {
  if (projectManagerDeliveryScheduled || pendingProjectManagerDeliveries.length === 0) return;
  for (let index = 0; index < pendingProjectManagerDeliveries.length; index += 1) {
    const delivery = pendingProjectManagerDeliveries[index];
    const session = delivery.sessionId
      ? useStore.getState().projectManagers.find((candidate) => candidate.id === delivery.sessionId)
      : undefined;
    if (session?.safeExit && ['saving', 'blocked', 'saved'].includes(session.safeExit.status)) continue;
    if (session && projectManagerRuntimeEnsureRuns.has(session.id)) continue;
    const manager = session
      ? projectManagerTerminal({ surfaceId: session.managerSurfaceId, projectId: session.id })
      : undefined;
    const managerRuntime = manager ? terminalRuntimeStatus(manager.surfaceId) : undefined;
    const managerActivity = manager ? remoteTerminalActivity(manager.surfaceId) : undefined;
    const managerAgentState = manager
      ? ((window as any).__wmux_getAgentStates?.() || {})[manager.surfaceId]
      : undefined;
    const managerPromptReady = !!manager && (
      canDeliverProjectManagerMessage(managerAgentState)
      || interactiveAgentPromptReady(readTerminalScreen(manager.surfaceId, 80).text || '')
    );
    const managerShellFailure = manager
      ? nestedAgentShellFailureDetail(manager.surfaceId)
      : null;
    const currentContinuationObligation = session && ['active', 'waiting'].includes(session.status)
      ? projectProgressObligation(session)
      : null;
    const continuationStillCurrent = !delivery.continuationKey || !!(
      session
      && currentContinuationObligation
      && delivery.continuationKey === projectWaitingGateContinuationKey(session, currentContinuationObligation)
    );
    const transitionStillPending = !delivery.transitionId || !!session?.pendingSupervisorTransitions?.some(
      (transition) => transition.id === delivery.transitionId,
    );
    if (!transitionStillPending || !continuationStillCurrent) {
      pendingProjectManagerDeliveries.splice(index, 1);
      if (session) removePersistedProjectManagerDelivery(session.id, delivery.id);
      index -= 1;
      continue;
    }
    const hasUnacknowledgedDelivery = pendingProjectManagerDeliveries.some((candidate) => (
      candidate.sessionId === delivery.sessionId
      && (candidate.stage === 'submitting'
        || candidate.stage === 'submitted'
        || candidate.stage === 'failed')
    ));
    if (hasUnacknowledgedDelivery
      && delivery.stage !== 'submitting'
      && delivery.stage !== 'submitted'
      && delivery.stage !== 'failed') continue;
    if (delivery.stage === 'submitting' || delivery.stage === 'submitted' || delivery.stage === 'failed') continue;
    if (!manager) {
      // Runtime creation/restoration is event-driven. Keep the durable outbox
      // quiet until a terminal event can make this delivery actionable.
      continue;
    } else if (managerShellFailure) {
      markTerminalRuntimeFailed(manager.surfaceId, managerShellFailure);
      failProjectManagerDelivery(delivery, managerShellFailure);
      (window as any).__wmux_queueProjectManagerRuntimeRecovery?.({
        projectId: session?.id,
        role: 'manager',
        surfaceId: manager.surfaceId,
        detail: managerShellFailure,
      });
      continue;
    } else if (managerRuntime?.state === 'failed' || managerRuntime?.state === 'exited') {
      failProjectManagerDelivery(delivery, managerRuntime.detail);
      (window as any).__wmux_queueProjectManagerRuntimeRecovery?.({
        projectId: session?.id,
        role: 'manager',
        surfaceId: manager.surfaceId,
        detail: managerRuntime.detail || '项目管理 AI 运行时不可用',
      });
      continue;
    } else if (projectManagerDeliverySurfacesInFlight.has(manager.surfaceId)) {
      continue;
    } else if (!managerPromptReady) {
      // Unknown, blocked and long-running states are not prompt-ready. A stale
      // lifecycle claim may only be overridden by positive Agent-composer
      // evidence from the current terminal screen.
      continue;
    } else {
      if (
        managerActivity?.activityState === 'idle'
        && managerActivity.activityUpdatedAt
        && Date.now() - managerActivity.activityUpdatedAt < PROJECT_MANAGER_IDLE_SETTLE_MS
      ) {
        // Stop means "turn ended", not "the nested Agent is healthy". Give the
        // terminal output a brief chance to report a Codex exit before writing.
        scheduleProjectManagerDeliveryFlush();
        continue;
      }
      try {
        const deliveryGeneration = projectManagerDeliveryGeneration;
        delivery.stage = 'submitting';
        delivery.submittedAt = Date.now();
        updatePersistedProjectManagerDeliveries(session!.id, (deliveries) => deliveries.map((candidate) => (
          candidate.id === delivery.id
            ? { ...candidate, stage: 'submitting', submittedAt: delivery.submittedAt }
            : candidate
        )));
        const pending = sendTaskToSurfaceReliably(manager.surfaceId, delivery.text, true, 'project');
        projectManagerDeliverySurfacesInFlight.add(manager.surfaceId);
        void Promise.resolve(pending).then(() => {
          if (deliveryGeneration !== projectManagerDeliveryGeneration) return;
          const currentManager = useStore.getState().projectManagers
            .find((candidate) => candidate.id === session!.id)?.managerSurfaceId;
          if (currentManager !== manager.surfaceId) return;
          const submitted = pendingProjectManagerDeliveries.find((candidate) => candidate.id === delivery.id);
          if (!submitted) return;
          submitted.stage = 'submitted';
          updatePersistedProjectManagerDeliveries(session!.id, (deliveries) => deliveries.map((candidate) => (
            candidate.id === delivery.id
              ? { ...candidate, stage: 'submitted', submittedAt: submitted.submittedAt }
              : candidate
          )));
          const submittedAt = submitted.submittedAt || Date.now();
          globalThis.setTimeout(() => {
            handleProjectManagerDeliveryAcknowledgementTimeout(session!.id, submitted.id, submittedAt);
          }, PROJECT_MANAGER_DELIVERY_ACK_TIMEOUT_MS);
        }).catch(() => {
          if (deliveryGeneration !== projectManagerDeliveryGeneration) return;
          const currentManager = useStore.getState().projectManagers
            .find((candidate) => candidate.id === session!.id)?.managerSurfaceId;
          if (currentManager !== manager.surfaceId) return;
          delivery.stage = 'pending';
          delivery.submittedAt = undefined;
          delivery.attempts = nextProjectManagerDeliveryRetryAttempt(delivery.attempts)
            ?? MAX_PROJECT_MANAGER_DELIVERY_RETRY_ATTEMPTS;
          updatePersistedProjectManagerDeliveries(session!.id, (deliveries) => deliveries.map((candidate) => (
            candidate.id === delivery.id
              ? {
                  ...candidate,
                  stage: 'pending',
                  submittedAt: undefined,
                }
              : candidate
          )));
          if (delivery.attempts >= MAX_PROJECT_MANAGER_DELIVERY_RETRY_ATTEMPTS && !delivery.alerted) {
            failProjectManagerDelivery(delivery);
          } else if (delivery.attempts < MAX_PROJECT_MANAGER_DELIVERY_RETRY_ATTEMPTS) {
            scheduleProjectManagerDeliveryFlush();
          }
        }).finally(() => {
          if (deliveryGeneration !== projectManagerDeliveryGeneration) return;
          projectManagerDeliverySurfacesInFlight.delete(manager.surfaceId);
        });
        // Keep scanning other projects while this surface waits for its PTY
        // acknowledgement; only deliveries for the same surface are locked.
        return;
      } catch {
        delivery.stage = 'pending';
        delivery.submittedAt = undefined;
        delivery.attempts = nextProjectManagerDeliveryRetryAttempt(delivery.attempts)
          ?? MAX_PROJECT_MANAGER_DELIVERY_RETRY_ATTEMPTS;
        if (session) updatePersistedProjectManagerDeliveries(session.id, (deliveries) => deliveries.map((candidate) => (
          candidate.id === delivery.id
            ? {
                ...candidate,
                stage: 'pending',
                submittedAt: undefined,
              }
            : candidate
        )));
        if (delivery.attempts < MAX_PROJECT_MANAGER_DELIVERY_RETRY_ATTEMPTS) {
          scheduleProjectManagerDeliveryFlush();
        }
      }
    }
    if (delivery.attempts >= MAX_PROJECT_MANAGER_DELIVERY_RETRY_ATTEMPTS && !delivery.alerted) {
      failProjectManagerDelivery(delivery);
    }
  }
}

function scheduleProjectManagerDeliveryFlush(): void {
  if (projectManagerDeliveryScheduled || pendingProjectManagerDeliveries.length === 0) return;
  projectManagerDeliveryScheduled = true;
  let firedSynchronously = false;
  projectManagerDeliveryTimerArming = true;
  window.setTimeout(() => {
    if (projectManagerDeliveryTimerArming) {
      firedSynchronously = true;
      return;
    }
    projectManagerDeliveryScheduled = false;
    flushProjectManagerDeliveries();
  }, 1_200);
  projectManagerDeliveryTimerArming = false;
  // Some hosts/tests provide a synchronous timer shim. Do not recurse on the
  // same stack; a later delivery/activity event can safely trigger another try.
  if (firedSynchronously) projectManagerDeliveryScheduled = false;
}

function updatePersistedProjectManagerDeliveries(
  sessionId: string,
  update: (deliveries: ProjectManagerPendingDelivery[]) => ProjectManagerPendingDelivery[],
): void {
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session) return;
  const next = { ...session, pendingManagerDeliveries: update(session.pendingManagerDeliveries || []) };
  store.restoreProjectManagers(
    store.projectManagers.map((candidate) => candidate.id === sessionId ? next : candidate),
    store.selectedProjectManagerId || undefined,
  );
  saveProjectManagerSnapshot(sessionId);
}

function removePersistedProjectManagerDelivery(sessionId: string, deliveryId: string): void {
  updatePersistedProjectManagerDeliveries(
    sessionId,
    (deliveries) => deliveries.filter((delivery) => delivery.id !== deliveryId),
  );
}

function acknowledgeProjectManagerDelivery(surfaceId: string, acknowledgement = 'UserPromptSubmit'): void {
  const session = useStore.getState().projectManagers.find((candidate) => candidate.managerSurfaceId === surfaceId);
  if (!session) return;
  const index = pendingProjectManagerDeliveries.findIndex((delivery) => (
    delivery.sessionId === session.id
    && (delivery.stage === 'submitting'
      || delivery.stage === 'submitted'
      || delivery.stage === 'failed')
  ));
  if (index < 0) return;
  const [delivery] = pendingProjectManagerDeliveries.splice(index, 1);
  removePersistedProjectManagerDelivery(session.id, delivery.id);
  if (delivery.alerted) {
    useStore.getState().resolveNotification(
      notificationDedupeKey('project', session.id, 'manager-delivery-failed'),
    );
    useStore.getState().appendProjectManagerEvent({
      kind: 'manager-delivery-restored',
      summary: '项目管理 AI 已确认接收积压消息',
      payload: { deliveryId: delivery.id, attempts: delivery.attempts, acknowledgement },
    }, session.id);
    saveProjectManagerSnapshot(session.id);
  }
  reconcileProjectExecutionResponsibility(session.id);
}

function notifyProjectManagerDeliveryUnavailable(
  delivery: PendingProjectManagerDelivery,
  detail?: string,
): void {
  const store = useStore.getState();
  const session = delivery.sessionId
    ? store.projectManagers.find((candidate) => candidate.id === delivery.sessionId)
    : undefined;
  const manager = session
    ? projectManagerTerminal({ surfaceId: session.managerSurfaceId, projectId: session.id })
    : undefined;
  const workspaceId = manager?.workspaceId || (session ? projectRuntimeWorkspaceId(session.id) : undefined);
  const surfaceId = manager?.surfaceId || session?.taskTerminalSurfaceId || session?.managerSurfaceId || '';
  const text = detail || (session
    ? `项目“${session.goal}”有消息等待交给项目管理 AI，但运行时当前不可用；消息已保留，将在下一次明确的 Agent 生命周期或恢复事件后重试。`
    : '有消息等待交给项目管理 AI，但运行时当前不可用；消息已保留，将在下一次明确的 Agent 生命周期或恢复事件后重试。');
  if (workspaceId) store.addNotification({
    surfaceId: surfaceId as SurfaceId,
    workspaceId,
    text,
    title: '项目管理 AI 暂不可用',
    ...(session
      ? notificationMetadata({
          owner: 'project',
          entityId: session.id,
          kind: 'manager-delivery-failed',
          severity: 'error',
          projectId: session.id,
          sourceLabel: projectDisplayName(session),
        })
      : notificationMetadata({
          owner: 'agent',
          entityId: surfaceId || 'project-manager',
          kind: 'manager-delivery-failed',
          severity: 'error',
        })),
  });
  fireDesktopNotification({ surfaceId, title: '项目管理 AI 暂不可用', text });
  if (session) {
    const event = store.appendProjectManagerEvent({
      kind: 'manager-delivery-failed',
      summary: text,
      payload: { deliveryId: delivery.id, attempts: delivery.attempts },
    }, session.id);
    saveProjectManagerSnapshot(session.id);
    if (event) {
      void (window as any).wmux?.projectManager?.appendRecord?.({
        sessionId: session.id,
        projectDir: session.projectDir,
        type: event.kind,
        payload: { message: event.summary, deliveryId: delivery.id, attempts: delivery.attempts },
      });
    }
  }
}

function hydrateProjectManagerDeliveries(sessions: readonly ProjectManagerSession[]): void {
  const queued = new Set(pendingProjectManagerDeliveries.map((delivery) => delivery.id));
  for (const session of sessions) {
    const validTransitionIds = new Set((session.pendingSupervisorTransitions || []).map((transition) => transition.id));
    const compacted = compactProjectManagerPendingDeliveries(
      session.pendingManagerDeliveries,
      validTransitionIds,
    );
    if (compacted !== session.pendingManagerDeliveries) {
      updatePersistedProjectManagerDeliveries(session.id, () => compacted);
    }
    for (const delivery of compacted) {
      if (queued.has(delivery.id)) continue;
      queued.add(delivery.id);
      const restoredDelivery: PendingProjectManagerDelivery = {
        ...delivery,
        text: withProjectManagerEventEnvelope(delivery.text, session.id),
        sessionId: session.id,
        attempts: delivery.stage === 'failed' ? MAX_PROJECT_MANAGER_DELIVERY_RETRY_ATTEMPTS : 0,
        alerted: delivery.stage === 'failed',
      };
      pendingProjectManagerDeliveries.push(restoredDelivery);
      if (restoredDelivery.stage === 'submitted' && restoredDelivery.submittedAt) {
        const delay = Math.max(
          0,
          restoredDelivery.submittedAt + PROJECT_MANAGER_DELIVERY_ACK_TIMEOUT_MS - Date.now(),
        );
        globalThis.setTimeout(() => {
          handleProjectManagerDeliveryAcknowledgementTimeout(
            session.id,
            restoredDelivery.id,
            restoredDelivery.submittedAt!,
          );
        }, delay);
      }
    }
  }
  flushProjectManagerDeliveries();
}

function queueProjectManagerDelivery(
  text: string,
  sessionId: string,
  options: { priority?: boolean; transitionId?: string; continuationKey?: string; dedupeKey?: string } = {},
): void {
  const delivery: PendingProjectManagerDelivery = {
    id: `pm-delivery-${uuid()}`,
    text: withProjectManagerEventEnvelope(text, sessionId),
    createdAt: Date.now(),
    ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
    ...(options.transitionId ? { transitionId: options.transitionId } : {}),
    ...(options.continuationKey ? { continuationKey: options.continuationKey } : {}),
    ...(options.priority ? { priority: true } : {}),
    sessionId,
    attempts: 0,
    alerted: false,
    stage: 'pending',
  };
  if (delivery.transitionId || delivery.dedupeKey) {
    for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
      const candidate = pendingProjectManagerDeliveries[index];
      if (candidate.sessionId === sessionId
        && ((delivery.transitionId && candidate.transitionId === delivery.transitionId)
          || (delivery.dedupeKey && candidate.dedupeKey === delivery.dedupeKey))
        && candidate.stage !== 'submitting'
        && candidate.stage !== 'submitted'
        && candidate.stage !== 'failed') {
        pendingProjectManagerDeliveries.splice(index, 1);
      }
    }
  }
  if (options.priority) pendingProjectManagerDeliveries.unshift(delivery);
  else pendingProjectManagerDeliveries.push(delivery);
  if (sessionId) {
    updatePersistedProjectManagerDeliveries(sessionId, (deliveries) => {
      const persisted = {
        id: delivery.id,
        text: delivery.text,
        createdAt: delivery.createdAt,
        ...(delivery.dedupeKey ? { dedupeKey: delivery.dedupeKey } : {}),
        ...(delivery.transitionId ? { transitionId: delivery.transitionId } : {}),
        ...(delivery.continuationKey ? { continuationKey: delivery.continuationKey } : {}),
        ...(delivery.priority ? { priority: true } : {}),
        stage: 'pending' as const,
      };
      const existing = deliveries.filter((candidate) => {
        if (candidate.id === delivery.id) return false;
        const sameScope = (delivery.transitionId && candidate.transitionId === delivery.transitionId)
          || (delivery.dedupeKey && candidate.dedupeKey === delivery.dedupeKey);
        return !sameScope
          || candidate.stage === 'submitting'
          || candidate.stage === 'submitted'
          || candidate.stage === 'failed';
      });
      return compactProjectManagerPendingDeliveries(
        options.priority ? [persisted, ...existing] : [...existing, persisted],
      );
    });
    reconcileProjectExecutionResponsibility(sessionId);
  }
  flushProjectManagerDeliveries();
}

function projectSupervisorTransitionText(
  session: ProjectManagerSession,
  transition: ProjectSupervisorTransition,
  instruction = '',
): string {
  const compactMarker = '\n…（内联已压缩，完整内容见项目状态）\n';
  const summary = compactSupervisorEvidenceSummary(
    transition.summary,
    SUPERVISOR_EVIDENCE_SUMMARY_MAX_CHARS,
    compactMarker,
  );
  const evidence = transition.evidence
    ? compactSupervisorEvidenceSummary(
        transition.evidence,
        SUPERVISOR_EVIDENCE_SUMMARY_MAX_CHARS,
        compactMarker,
      )
    : '';
  const contextSummary = transition.contextSummary
    ? compactSupervisorEvidenceSummary(transition.contextSummary, 800, compactMarker)
    : '';
  const compacted = summary !== transition.summary
    || evidence !== (transition.evidence || '')
    || contextSummary !== (transition.contextSummary || '');
  return [
    '[项目专属监督状态交接｜事件驱动｜必须处理并回执]',
    `项目：${session.id} · ${session.projectDir}`,
    `交接 ID：${transition.id}`,
    `任务：${transition.workItemId || '未绑定'}`,
    `监督状态：${transition.kind}`,
    `摘要：${summary}`,
    evidence ? `证据摘要：${evidence}` : '',
    contextSummary ? `上下文摘要：${contextSummary}` : '',
    compacted
      ? `完整交接已保留：运行 wmux project status --project ${session.id}，读取 pendingSupervisorTransitions 中 ID=${transition.id} 的结构化记录。`
      : '',
    '',
    instruction || '请依据结构化项目状态决定继续、验收、重规划、暂停或恢复；不要绕过专属监督直接指挥任务 AI。',
    `完成相应的 task-update、dispatch、项目状态更新或结构化 project ask 后，执行 wmux project transition-ack --project ${session.id} --transition ${transition.id} --resolution <continued|accepted|replanned|paused|escalated|recovered> --summary "<处理结果和新方向>"。`,
    '该回执是项目 AI 的内部状态同步，不需要用户确认。',
    '未回执前该交接会保留在项目状态中；控制层最多延迟补投一次，不会持续轮询或重复询问监督进度。',
  ].filter(Boolean).join('\n');
}

export function projectSupervisorTransitionRedeliveryMs(notificationCount: number): number {
  const normalizedCount = Number.isFinite(notificationCount)
    ? Math.max(1, Math.trunc(notificationCount))
    : 1;
  const index = Math.min(
    PROJECT_SUPERVISOR_TRANSITION_REDELIVERY_DELAYS_MS.length - 1,
    normalizedCount - 1,
  );
  return PROJECT_SUPERVISOR_TRANSITION_REDELIVERY_DELAYS_MS[index];
}

export function shouldScheduleProjectSupervisorTransitionReminder(notificationCount: number): boolean {
  const normalizedCount = Number.isFinite(notificationCount)
    ? Math.max(1, Math.trunc(notificationCount))
    : 1;
  return normalizedCount < MAX_PROJECT_SUPERVISOR_TRANSITION_NOTIFICATIONS;
}

function projectTransitionPriority(kind: ProjectSupervisorTransitionKind): number {
  if (kind === 'supervisor-unavailable') return 0;
  if (kind === 'decision-required') return 1;
  if (kind === 'stage-complete') return 2;
  if (kind === 'project-action-required') return 3;
  if (kind === 'direction-needed') return 4;
  return 5;
}

function nextProjectSupervisorTransition(
  session: ProjectManagerSession,
): ProjectSupervisorTransition | undefined {
  return [...(session.pendingSupervisorTransitions || [])].sort((left, right) => (
    projectTransitionPriority(left.kind) - projectTransitionPriority(right.kind)
      || left.createdAt - right.createdAt
  ))[0];
}

function projectTransitionReplanBaselineFingerprint(
  session: ProjectManagerSession,
  workItemId: string | undefined,
): string {
  const item = workItemId
    ? session.workItems.find((candidate) => candidate.id === workItemId)
    : undefined;
  const stage = item
    ? (session.subgoals || []).find((candidate) => candidate.id === item.subgoalId)
    : undefined;
  const record = item?.executionHistory.at(-1);
  return supervisorDecisionTextSignature(JSON.stringify([
    session.activeGoalId || '',
    session.requirementsVersion,
    session.authorizationVersion,
    item?.id || '',
    item?.subgoalId || '',
    [...(item?.dependencies || [])].sort(),
    stage?.status || '',
    [...(stage?.dependencies || [])].sort(),
    record?.progressSignature || '',
    record?.evidenceProgressSignature || '',
    record?.workspaceVersion || '',
    record?.errorSignature || '',
    record?.testResult || '',
  ]));
}

function queueProjectSupervisorTransition(options: {
  sessionId: string;
  laneId: string;
  workItemId?: string;
  kind: ProjectSupervisorTransitionKind;
  eventType: string;
  summary: string;
  evidence?: string;
  contextSummary?: string;
  instruction?: string;
}): ProjectSupervisorTransition | undefined {
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === options.sessionId);
  if (!session || ['completed', 'stopped'].includes(session.status)) return undefined;
  const replanBaselineFingerprint = projectTransitionReplanBaselineFingerprint(
    session,
    options.workItemId,
  );
  const originalPending = session.pendingSupervisorTransitions || [];
  const sameScope = (transition: ProjectSupervisorTransition) => (
    transition.workItemId === options.workItemId
    && (
      transition.laneId === options.laneId
      || (transition.kind === 'supervisor-unavailable' && options.kind === 'supervisor-unavailable')
    )
  );
  // An idle-without-handoff event is only a recovery hint. If a real state
  // handoff for the same supervisor arrived concurrently, that newer fact is
  // authoritative and the stale idle hint must never trigger a later rebuild.
  const scopedPending = originalPending.filter(sameScope);
  if (options.kind === 'supervisor-idle' && scopedPending.length > 0) {
    return scopedPending.at(-1);
  }
  const sameKindMatches = originalPending.filter((transition) => (
    sameScope(transition) && transition.kind === options.kind
  ));
  const retainedSameKind = sameKindMatches.at(-1);
  const supersededIds = new Set([
    ...originalPending
    .filter((transition) => sameScope(transition) && transition.kind === 'supervisor-idle')
      .map((transition) => transition.id),
    ...sameKindMatches
      .filter((transition) => transition.id !== retainedSameKind?.id)
      .map((transition) => transition.id),
  ]);
  if (supersededIds.size > 0) {
    for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
      const delivery = pendingProjectManagerDeliveries[index];
      if (delivery.sessionId === session.id && delivery.transitionId
        && supersededIds.has(delivery.transitionId)) {
        pendingProjectManagerDeliveries.splice(index, 1);
      }
    }
  }
  const pending = originalPending.filter((transition) => !supersededIds.has(transition.id));
  const currentSession = supersededIds.size > 0
    ? {
        ...session,
        pendingSupervisorTransitions: pending,
        pendingManagerDeliveries: (session.pendingManagerDeliveries || [])
          .filter((delivery) => !delivery.transitionId || !supersededIds.has(delivery.transitionId)),
      }
    : session;
  const existing = pending.find((transition) => sameScope(transition) && transition.kind === options.kind);
  if (existing) {
    const nextSummary = options.summary.trim().slice(0, 4000) || existing.summary;
    const nextEvidence = options.evidence?.trim().slice(0, 12_000);
    const nextContextSummary = options.contextSummary?.trim().slice(0, 12_000);
    const unchanged = existing.laneId === options.laneId
      && existing.eventType === options.eventType
      && existing.summary === nextSummary
      && (!nextEvidence || existing.evidence === nextEvidence)
      && (!nextContextSummary || existing.contextSummary === nextContextSummary)
      && existing.replanBaselineFingerprint === replanBaselineFingerprint;
    if (unchanged) return existing;
    const now = Date.now();
    const eventTypeChanged = existing.eventType !== options.eventType;
    const updated = {
      ...existing,
      laneId: options.laneId,
      eventType: options.eventType,
      summary: nextSummary,
      ...(nextEvidence ? { evidence: nextEvidence } : {}),
      ...(nextContextSummary ? { contextSummary: nextContextSummary } : {}),
      replanBaselineFingerprint,
      ...(eventTypeChanged ? {
        notifiedAt: now,
        notificationCount: existing.notificationCount + 1,
      } : {}),
    };
    const updatedText = withProjectManagerEventEnvelope(
      projectSupervisorTransitionText(currentSession, updated, options.instruction),
      session.id,
    );
    if (!eventTypeChanged) {
      for (const delivery of pendingProjectManagerDeliveries) {
        if (delivery.sessionId === session.id && delivery.transitionId === existing.id) {
          delivery.text = updatedText;
        }
      }
      replaceProjectManagerSession({
        ...currentSession,
        pendingSupervisorTransitions: pending.map((transition) => (
          transition.id === existing.id ? updated : transition
        )),
        pendingManagerDeliveries: (currentSession.pendingManagerDeliveries || []).map((delivery) => (
          delivery.transitionId === existing.id ? { ...delivery, text: updatedText } : delivery
        )),
        updatedAt: now,
      });
      saveProjectManagerSnapshot(session.id);
      return updated;
    }
    for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
      const delivery = pendingProjectManagerDeliveries[index];
      if (delivery.sessionId === session.id && delivery.transitionId === existing.id) {
        pendingProjectManagerDeliveries.splice(index, 1);
      }
    }
    replaceProjectManagerSession({
      ...currentSession,
      pendingSupervisorTransitions: pending.map((transition) => transition.id === existing.id ? updated : transition),
      pendingManagerDeliveries: (currentSession.pendingManagerDeliveries || [])
        .filter((delivery) => delivery.transitionId !== existing.id),
      updatedAt: now,
    });
    saveProjectManagerSnapshot(session.id);
    queueProjectManagerDelivery(
      projectSupervisorTransitionText(currentSession, updated, options.instruction),
      session.id,
      { priority: true, transitionId: updated.id },
    );
    return updated;
  }
  const now = Date.now();
  const transition: ProjectSupervisorTransition = {
    id: `pm-transition-${uuid()}`,
    laneId: options.laneId,
    ...(options.workItemId ? { workItemId: options.workItemId } : {}),
    kind: options.kind,
    eventType: options.eventType,
    summary: options.summary.trim().slice(0, 4000) || options.eventType,
    ...(options.evidence?.trim() ? { evidence: options.evidence.trim().slice(0, 12_000) } : {}),
    ...(options.contextSummary?.trim()
      ? { contextSummary: options.contextSummary.trim().slice(0, 12_000) }
      : {}),
    replanBaselineFingerprint,
    createdAt: now,
    notifiedAt: now,
    notificationCount: 1,
  };
  replaceProjectManagerSession({
    ...currentSession,
    pendingSupervisorTransitions: [...pending, transition].slice(-50),
    updatedAt: now,
  });
  store.appendProjectManagerEvent({
    kind: 'supervisor-transition',
    workItemId: transition.workItemId,
    summary: transition.summary,
    payload: {
      transitionId: transition.id,
      laneId: transition.laneId,
      transitionKind: transition.kind,
      eventType: transition.eventType,
    },
  }, session.id);
  saveProjectManagerSnapshot(session.id);
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
  queueProjectManagerDelivery(
    projectSupervisorTransitionText(current, transition, options.instruction),
    session.id,
    { priority: true, transitionId: transition.id },
  );
  reconcileProjectExecutionResponsibility(session.id);
  return transition;
}

function queueProjectSupervisorAnomaly(
  session: ProjectManagerSession,
  lane: SupervisorLane,
  workItem: ProjectWorkItem,
  eventType: string,
  summary: string,
  options: { evidence?: string; contextSummary?: string } = {},
): void {
  queueProjectSupervisorTransition({
    sessionId: session.id,
    laneId: lane.id,
    workItemId: workItem.id,
    kind: 'project-action-required',
    eventType,
    summary,
    evidence: options.evidence,
    contextSummary: options.contextSummary,
    instruction: [
      '这是阶段内异常交接，不是普通进度汇报。先在项目既有权限内调整合同、执行路线或恢复监督链，再续接同一任务；不得通过修改预算计数或创建同义后继绕过护栏。',
      '只有确需人工操作、用户专属信息、业务取舍、凭据/访问授权、破坏性或生产动作时，才升级为结构化用户问题。',
    ].join('\n'),
  });
}

function maintainProjectSupervisorTransition(
  session: ProjectManagerSession,
  now: number,
  options: { forceReminder?: boolean } = {},
): boolean {
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
  const transition = nextProjectSupervisorTransition(current);
  if (!transition) return false;
  if (projectTaskInputTransitionStillBlocked(transition)) {
    const question = transition.workItemId
      ? escalateProjectTaskInputDraft(current.id, transition.laneId, transition.workItemId, transition.summary)
      : undefined;
    if (question) return true;
  }
  const linkedDelivery = (current.pendingManagerDeliveries || []).some((delivery) => (
    delivery.transitionId === transition.id
  )) || pendingProjectManagerDeliveries.some((delivery) => (
    delivery.sessionId === current.id && delivery.transitionId === transition.id
  ));
  if (linkedDelivery) return true;
  if (!shouldScheduleProjectSupervisorTransitionReminder(transition.notificationCount)) return true;
  if (!options.forceReminder
    && now - transition.notifiedAt < projectSupervisorTransitionRedeliveryMs(transition.notificationCount)) {
    return true;
  }
  const refreshed = {
    ...transition,
    notifiedAt: now,
    notificationCount: transition.notificationCount + 1,
  };
  replaceProjectManagerSession({
    ...current,
    pendingSupervisorTransitions: (current.pendingSupervisorTransitions || [])
      .map((candidate) => candidate.id === transition.id ? refreshed : candidate),
    updatedAt: now,
  });
  saveProjectManagerSnapshot(current.id);
  queueProjectManagerDelivery(
    projectSupervisorTransitionText(current, refreshed, '该交接尚未收到项目 AI 回执。请先处理这一个高价值状态，不要发起新的进度询问。'),
    current.id,
    { priority: true, transitionId: refreshed.id },
  );
  return true;
}

function projectTransitionResolutionError(
  session: ProjectManagerSession,
  transition: ProjectSupervisorTransition,
  resolution: string,
): string | null {
  const store = useStore.getState();
  const item = transition.workItemId
    ? session.workItems.find((candidate) => candidate.id === transition.workItemId)
    : undefined;
  const activeLane = store.supervisor.lanes.find((lane) => (
    lane.projectManagerProjectId === session.id
    && (!transition.workItemId || lane.projectWorkItemId === transition.workItemId)
    && supervisorLaneControlState(lane) === 'active'
  ));
  return projectTransitionPolicyError({
    transition,
    resolution,
    sessionStatus: session.status,
    activeGoalAchieved: activeProjectGoal(session).status === 'achieved',
    events: session.events,
    workItem: item,
    activeBinding: activeLane ? {
      laneId: activeLane.id,
      taskSurfaceId: activeLane.surfaceId,
      assignmentVersion: activeLane.projectAssignmentVersion,
    } : undefined,
    userQuestionPending: !!session.pendingUserQuestion,
  });
}

function queueProjectSupervisorRecovery(lane: SupervisorLane, detail: string): void {
  const projectId = lane.projectManagerProjectId;
  if (!projectId) return;
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === projectId);
  if (!session || ['completed', 'stopped'].includes(session.status)) return;
  if (lane.projectWorkItemId) {
    store.applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: lane.projectWorkItemId,
      patch: { status: 'waiting-decision', latestBlocker: detail },
    }, session.id);
  }
  store.appendProjectManagerEvent({
    kind: 'supervisor-status',
    workItemId: lane.projectWorkItemId,
    summary: detail,
    payload: { laneId: lane.id, supervisorSurfaceId: lane.supervisorSurfaceId, recoveryRequired: true },
  }, session.id);
  saveProjectManagerSnapshot(session.id);
  queueProjectSupervisorTransition({
    sessionId: session.id,
    laneId: lane.id,
    workItemId: lane.projectWorkItemId,
    kind: 'supervisor-unavailable',
    eventType: 'supervisor.runtime-unavailable',
    summary: detail,
    instruction: [
      session.status === 'active'
        ? '项目仍处于 active；核对失败原因后重新执行 dispatch，恢复暂停通道或重建已经失效的专属监督。'
        : `项目当前为 ${session.status}；条件未变化时先恢复项目，再重新执行 dispatch。`,
      '不得继续等待旧监督自行恢复，也不得绕过监督直接向任务终端发送指令。',
    ].join('\n'),
  });
}

function projectStableTerminalScreen(
  surfaceId: string,
  label: string,
  activityState: RemoteTerminalActivityState,
): string {
  const rawScreen = readTerminalScreen(surfaceId, 30).text || '';
  const excerpt = terminalSupervisorCoreExcerpt(rawScreen, label, activityState);
  return normalizeProjectActivityFingerprintText(excerpt.answer || excerpt.text).slice(-1200);
}

async function writeProjectSupervisorControl(surfaceId: SurfaceId, data: '\x1b' | '\x03'): Promise<boolean> {
  const pty = (window as any).wmux?.pty;
  try {
    if (pty?.has && !await pty.has(surfaceId)) return false;
    cancelPendingAutomatedTerminalSubmit(surfaceId, true);
    if (pty?.writeReliable) return await pty.writeReliable(surfaceId, data);
    if (!pty?.write) return false;
    pty.write(surfaceId, data);
    return true;
  } catch {
    return false;
  }
}

function handleProjectManagerDeliveryAcknowledgementTimeout(
  sessionId: string,
  deliveryId: string,
  submittedAt: number,
): void {
  const delivery = pendingProjectManagerDeliveries.find((candidate) => (
    candidate.sessionId === sessionId
    && candidate.id === deliveryId
    && candidate.stage === 'submitted'
    && candidate.submittedAt === submittedAt
  ));
  if (!delivery || delivery.alerted) return;
  const session = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (session) openProjectManagerAttentionSurface(session.id);
  failProjectManagerDelivery(
    delivery,
    session
      ? `项目“${projectDisplayName(session)}”的消息已写入项目 AI 终端，但 ${Math.round(PROJECT_MANAGER_DELIVERY_ACK_TIMEOUT_MS / 1000)} 秒内没有收到任何 Agent 生命周期确认。控制层无法判断消息是否已执行，已停止后续自动投递；请查看项目控制台并决定重建项目 AI、保持暂停或停止当前工作。`
      : '项目 AI 消息已提交但没有收到 Agent 生命周期确认；控制层已停止后续自动投递，请人工核对。',
  );
}

function unresolvedProjectUserAnswer(session: ProjectManagerSession): ProjectManagerSession['events'][number] | undefined {
  const resolvesAnswer = (
    answer: ProjectManagerSession['events'][number],
    candidate: ProjectManagerSession['events'][number],
  ): boolean => {
    if (['project-resumed', 'project-paused', 'project-stopped'].includes(candidate.kind)) return true;
    if (candidate.kind === 'user-clarification-requested') return true;
    const answerQuestionId = String(answer.payload?.questionId || answer.correlationId || '').trim();
    if (candidate.payload?.userConfirmationEventId === answer.id
      || candidate.payload?.planningAnswerEventId === answer.id
      || (!!answerQuestionId && candidate.payload?.sourceQuestionId === answerQuestionId)
      || (!!answerQuestionId && candidate.payload?.questionId === answerQuestionId)) {
      return true;
    }
    const workItemResolutionKinds = new Set([
      'work-item-created',
      'work-item-updated',
      'user-work-item-intervention',
      'supervisor-transition-acknowledged',
      'supervisor-direction',
    ]);
    return !!answer.workItemId
      && candidate.workItemId === answer.workItemId
      && workItemResolutionKinds.has(candidate.kind);
  };
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event.kind !== 'user-clarification-answered') continue;
    return session.events.slice(index + 1).some((candidate) => resolvesAnswer(event, candidate))
      ? undefined
      : event;
  }
  return undefined;
}

export function projectInternalRecoveryScopeKey(
  session: ProjectManagerSession,
  workItemId?: string,
): string {
  return buildProjectInternalRecoveryScopeKey({
    protocolRevision: PROJECT_MANAGER_PROTOCOL_REVISION,
    sessionId: session.id,
    workItemId,
    baselineFingerprint: projectTransitionReplanBaselineFingerprint(session, workItemId),
  });
}

const PROJECT_WAITING_GATE_CONTINUATION_ACTION = 'project-waiting-gate-continuation';
const MAX_PROJECT_WAITING_GATE_CONTINUATIONS = 1;
const PROJECT_ACTIVE_OBLIGATION_CONTINUATION_ACTION = 'project-active-obligation-continuation';
const MAX_PROJECT_ACTIVE_OBLIGATION_CONTINUATIONS = 1;
const PROJECT_SUPERVISOR_HANDOFF_GRACE_MS = 30_000;
const PROJECT_IDLE_TRANSITION_REDELIVERY_MS = 2 * 60_000;

function projectWaitingGateContinuationKey(
  session: ProjectManagerSession,
  obligation: ProjectProgressObligation,
): string {
  const obligationState = obligation.kind === 'reconcile-stale-work'
    ? session.workItems
        .filter((item) => item.goalId === activeProjectGoal(session).id && !['completed', 'stopped'].includes(item.status))
        .map((item) => `${item.id}@${item.status}:R${item.requirementsVersion || 0}:A${item.authorizationVersion || 0}:${item.updatedAt}`)
        .sort()
        .join(',')
    : obligation.kind === 'plan-work'
      ? activeProjectSubgoals(session)
          .map((subgoal) => `${subgoal.id}@${subgoal.status}:${subgoal.updatedAt}`)
          .join(',')
      : '';
  return [
    activeProjectGoal(session).id,
    projectRequirementsVersion(session),
    projectAuthorizationVersion(session),
    session.orientation?.requestedAt || 0,
    obligation.kind,
    obligationState,
  ].join(':');
}

function projectWaitingGateContinuationAttempts(session: ProjectManagerSession, key: string): number {
  return session.events.filter((event) => (
    event.kind === 'guard-triggered'
    && event.payload?.action === PROJECT_WAITING_GATE_CONTINUATION_ACTION
    && event.payload?.continuationKey === key
  )).length;
}

function projectWaitingGateContinuationText(
  session: ProjectManagerSession,
  obligation: ProjectProgressObligation,
): string {
  const command = obligation.kind === 'align-requirements'
    ? `把确认 JSON 写入项目 .wmux/tmp/，提交 wmux project alignment-confirm --project ${session.id} --json-file <file>`
    : obligation.kind === 'sync-progress'
      ? `读取最新项目状态并完成 wmux project progress-sync --project ${session.id} --ack --summary "<影响判断和安排>"`
      : obligation.kind === 'orient-project'
        ? `从 project status 原样读取 orientation 版本和快照字段，把完整 JSON 写入项目 .wmux/tmp/orientation-${session.orientation?.requestedAt || 'current'}.json，再提交 wmux project orientation-confirm --project ${session.id} --json-file .wmux/tmp/orientation-${session.orientation?.requestedAt || 'current'}.json`
        : obligation.kind === 'reconcile-stale-work'
          ? `逐项停止旧 goalId 工作，或把更新 JSON 写入项目 .wmux/tmp/ 后用 wmux project task-update --project ${session.id} --json-file <file> 显式重绑当前需求与授权版本`
          : obligation.kind === 'plan-work'
            ? `把阶段计划 JSON 写入项目 .wmux/tmp/，提交 wmux project goal-plan --project ${session.id} --json-file <file>，保存当前主目标的阶段计划`
            : obligation.kind === 'resume-project'
              ? `提交 wmux project resume --project ${session.id}，再继续创建或派发当前目标任务`
              : `处理当前项目义务：${obligation.summary}`;
  return [
    '[控制层续作｜目标变更后的内部门禁尚未完成]',
    `项目：${session.id} · ${session.projectDir}`,
    `当前主目标：${activeProjectGoal(session).id}`,
    `当前版本：R${projectRequirementsVersion(session)}/A${projectAuthorizationVersion(session)}`,
    `下一义务：${obligation.kind} · ${obligation.summary}`,
    `立即执行：${command}。`,
    '结构化 JSON 不能作为位置参数。命令返回 Error 或 ok=false 时状态没有变化：立即运行同一子命令的 --help，修正参数后重试原命令；project inspect/status 只读，不能代替 alignment-confirm、orientation-confirm、goal-plan 或 task-update。',
    '用户已经确认的目标与需求是当前权威定义；不得仅为复述、补格式或重复确认而再次 update-definition 或 ask。只有发现会实质改变目标、范围、权限、硬前置条件、安全边界或验收标准的新事实时，才允许向用户提出新的结构化问题。',
    '本步骤完成后继续读取 project status，按控制层返回的下一义务推进，直至阶段计划已保存且项目显式恢复；不得只回复“下一步会处理”后结束回合。',
  ].join('\n');
}

function projectActiveObligationContinuationAttempts(
  session: ProjectManagerSession,
  key: string,
): number {
  return session.events.filter((event) => (
    event.kind === 'guard-triggered'
    && event.payload?.action === PROJECT_ACTIVE_OBLIGATION_CONTINUATION_ACTION
    && event.payload?.continuationKey === key
  )).length;
}

function projectActiveObligationContinuationText(
  session: ProjectManagerSession,
  obligation: ProjectProgressObligation,
): string {
  if (obligation.kind === 'complete-goal') {
    return [
      '[控制层续作｜主目标成果已完成｜只做目标收口]',
      `项目：${session.id} · ${session.projectDir}`,
      `当前主目标：${activeProjectGoal(session).id} · ${session.goal}`,
      `目标完成条件：${activeProjectGoal(session).doneWhen.join('；')}`,
      '当前版本工作项和阶段均已完成。不得创建新工作项、重复实现、重复测试或重新规划。',
      '重新读取 project status，聚合当前版本 completed 工作项经 stageAcceptanceCoverage 映射后的监督证据；把目标级完成 JSON 写入项目 .wmux/tmp/，其中 criteria 必须逐项使用目标 doneWhen 原文，并只引用已由监督核验且带内容哈希的 evidenceRefs。',
      `执行 wmux project complete --project ${session.id} --json-file <file>。命令返回 ok=false 时运行 wmux project complete --help，按错误修正同一份目标级声明后重试；不得用只读 status 代替完成状态迁移。`,
    ].join('\n');
  }
  if (obligation.kind === 'map-stage-acceptance') {
    const workItem = obligation.workItemId
      ? session.workItems.find((candidate) => candidate.id === obligation.workItemId)
      : undefined;
    const completedStageItems = session.workItems.filter((candidate) => (
      candidate.goalId === workItem?.goalId
      && candidate.subgoalId === workItem?.subgoalId
      && candidate.status === 'completed'
      && (normalizeProjectCompletionResult(candidate.completion)?.criteria?.length || 0) > 0
    ));
    const availableCriteria = completedStageItems.map((candidate) => (
      `- ${candidate.id}：${normalizeProjectCompletionResult(candidate.completion)?.criteria
        ?.map((criterion) => criterion.criterion).join('；') || '没有可映射条目'}`
    ));
    return [
      '[控制层续作｜阶段证据映射缺失｜禁止重复创建收口任务]',
      `项目：${session.id} · ${session.projectDir}`,
      `阶段内历史完成工作项：${completedStageItems.length} 项`,
      `缺少 canonical acceptance：${(obligation.missingCriteria || []).join('；') || obligation.summary}`,
      `可用核验条目：\n${availableCriteria.join('\n') || '没有可映射条目'}`,
      '重新读取 project status。逐项确认现有核验条目和已哈希 evidenceArtifacts 是否真实覆盖对应阶段 acceptance；不得使用字符串相似度猜测，也不得把较弱结论映射为更强验收。',
      '若存在真实一一对应，对实际持有该核验证据的原 completed 工作项分别执行 task-update，在各自 contract.stageAcceptanceCoverage 中补充 [{"stageCriterion":"<阶段 acceptance 原文>","verificationCriterion":"<该工作项现有完成核验条目原文>"}]；不得把不同工作项的证据挂到同一项，不得改写 completion、证据、状态或验收正文。',
      `执行 wmux project task-update --project ${session.id} --json-file <file>；全部映射成功后再用 goal-plan 将已覆盖阶段更新为 achieved，并继续派发下一成果。`,
      '如果不存在可证明的一一对应，保留具体缺失项并报告 stage-closure-evidence-mapping-missing；不得创建同义复核任务、不得重复实现、不得把该内部映射问题升级成用户业务决策。',
    ].join('\n');
  }
  if (obligation.kind === 'close-stage') {
    const workItem = obligation.workItemId
      ? session.workItems.find((candidate) => candidate.id === obligation.workItemId)
      : undefined;
    const subgoal = activeProjectSubgoals(session).find((candidate) => (
      candidate.id === workItem?.subgoalId
    ));
    return [
      '[控制层续作｜阶段验收已覆盖｜只关闭阶段]',
      `项目：${session.id} · ${session.projectDir}`,
      `待关闭阶段：${subgoal?.id || workItem?.subgoalId || '未定位'} · ${subgoal?.title || '未定位'}`,
      '该阶段 canonical acceptance 已由 completed 工作项的结构化证据覆盖。不得创建新工作项、不得重复验证或重做实现。',
      `重新读取 project status，把现有阶段计划 JSON 写入项目 .wmux/tmp/，仅将 ${subgoal?.id || '<subgoalId>'} 更新为 achieved，执行 wmux project goal-plan --project ${session.id} --json-file <file>。`,
      '成功后重新读取 project status，并继续派发下一项已满足阶段依赖的成果。',
    ].join('\n');
  }
  const unfinishedSubgoals = activeProjectSubgoals(session).filter((subgoal) => (
    !['achieved', 'obsolete'].includes(subgoal.status)
  ));
  const stageSummary = unfinishedSubgoals.length > 0
    ? unfinishedSubgoals.map((subgoal) => `${subgoal.id}（${subgoal.title}，${subgoal.status}）`).join('、')
    : '当前目标尚未建立可执行阶段';
  const nextAction = unfinishedSubgoals.length > 0
    ? [
        '已有阶段计划时，先聚合该阶段全部 completed 工作项的结构化 completion：若已覆盖阶段 acceptance，立即用 goal-plan 将阶段更新为 achieved；只有仍有未满足验收且没有开放工作项时，才创建一个绑定当前 goalId、subgoalId、需求版本、授权版本和当前协议、覆盖全部剩余验收的完整成果工作项。不得重复覆盖 goal-plan。',
        `将工作项 JSON 写入项目内 .wmux/tmp/ 后，执行 wmux project task-create --project ${session.id} --json-file <file>，成功后继续 dispatch。`,
      ]
    : [
        `当前没有阶段计划；先提交 wmux project goal-plan --project ${session.id} --json-file <file> 保存覆盖目标完成条件的阶段计划，再重新读取 project status，为最早可执行阶段提交 task-create 并继续 dispatch。`,
      ];
  return [
    '[控制层续作｜活动目标仍有项目内规划义务]',
    `项目：${session.id} · ${session.projectDir}`,
    `当前主目标：${activeProjectGoal(session).id}`,
    `当前版本：R${projectRequirementsVersion(session)}/A${projectAuthorizationVersion(session)}/P${CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION}`,
    `下一义务：${obligation.kind} · ${obligation.summary}`,
    `未完成阶段：${stageSummary}`,
    '立即重新读取 project status。',
    ...nextAction,
    '历史 completed 工作项保留为阶段验收的结构化证据；证据已覆盖的 acceptance 不得再次创建实现、编译、测试或补证工作项。',
    '确有剩余缺口时，把全部剩余验收合并进一个成果工作项，由监督 AI 在该工作项内编排实现、验证和证据收口批次；不得为每条验收、每次交接或每次补证创建同义后继任务。不得重放已有一次性身份或无证据声称完成。完成阶段更新，或完成唯一剩余成果的创建和派发后，再结束本回合。',
  ].join('\n');
}

function projectInternalBlockedObligationContinuationText(
  session: ProjectManagerSession,
  obligation: ProjectProgressObligation,
  workItem?: ProjectWorkItem,
): string {
  return [
    '[控制层续作｜主目标仍有可内部消解的执行义务]',
    `项目：${session.id} · ${session.projectDir}`,
    `当前主目标：${activeProjectGoal(session).id} · ${session.goal}`,
    `下一义务：${obligation.kind} · ${obligation.summary}`,
    workItem ? `工作项：${workItem.id} · ${workItem.title} · ${workItem.status}` : '',
    workItem?.latestBlocker ? `当前阻塞：${workItem.latestBlocker}` : '',
    '这是项目 AI 的主目标推进义务，不是用户审批。立即读取 project status，选择并执行一种真实状态迁移：修正/重绑合同、处理监督待决、恢复同一监督链、派发不依赖工作项，或在证据要求下停止无效工作项并重规划。不得只回复分析、重复暂停或再次创建同义交接。',
    '监督 AI 负责当前工作项的技术路线、证据和合同内执行；项目 AI 负责合同、依赖、跨阶段路线和执行链续接。不得绕过监督直接指挥任务 AI。',
    '只有业务取舍、用户独有信息/凭据、真实人工操作、新设备/参数/风险授权、破坏性或生产动作才可 ask 用户；普通失败、内部状态同步和已有授权内的后续验证必须在项目内消解。',
    `完成处理后执行 wmux project status --project ${session.id} 确认至少一个主目标责任者已进入 active/running/validating，或存在真实结构化用户问题。`,
  ].filter(Boolean).join('\n');
}

async function ensureProjectDeadlockRecovery(
  sessionId: string,
  trigger: string,
): Promise<boolean> {
  if (projectDeadlockEscalations.has(sessionId)) return false;
  projectDeadlockEscalations.add(sessionId);
  try {
    reconcileProjectExecutionResponsibility(sessionId);
    const store = useStore.getState();
    const session = store.projectManagers.find((candidate) => candidate.id === sessionId);
    if (!session) return false;
    const watchdogDisposition = classifyProjectWatchdogScenario(session, {
      hasPendingManagerDelivery: (session.pendingManagerDeliveries || []).length > 0
        || pendingProjectManagerDeliveries.some((delivery) => delivery.sessionId === session.id),
    });
    if (!watchdogDisposition.inspectDeadlock) return false;
    const manager = projectManagerTerminal({ surfaceId: session.managerSurfaceId, projectId: session.id });
    const preserveStaleWorking = !trigger.startsWith(PROJECT_LIVENESS_WATCHDOG_TRIGGER);
    const managerActivity = manager
      ? remoteTerminalActivity(manager.surfaceId, preserveStaleWorking).activityState
      : 'unknown';
    const managerTurnEnded = trigger.startsWith('项目 AI 回合以 ');
    const currentObligation = projectProgressObligation(session);
    const urgentInternalObligation = session.status === 'active'
      && !!currentObligation
      && ['resume-paused', 'resolve-decision'].includes(currentObligation.kind);
    // A durable continuation can safely wait in the manager outbox. Do not let
    // the manager's current turn hide a just-created paused/decision deadlock.
    if (managerActivity === 'working' && !managerTurnEnded && !urgentInternalObligation) {
      return false;
    }
    const controlPlaneKnownIdleManager = (
      trigger.startsWith('控制层初始化时')
      || trigger.startsWith(PROJECT_LIVENESS_WATCHDOG_TRIGGER)
    ) && managerActivity !== 'working';
    const responsibilityDeadline = session.executionResponsibility?.deadlineAt;
    if (controlPlaneKnownIdleManager
      && !managerTurnEnded
      && typeof responsibilityDeadline === 'number'
      && Date.now() < responsibilityDeadline) {
      scheduleProjectDeadlockCheck(
        session.id,
        responsibilityDeadline,
        `${PROJECT_LIVENESS_WATCHDOG_TRIGGER}；执行责任租约到期后复核`,
      );
      return false;
    }
    const pendingTransition = nextProjectSupervisorTransition(session);
    const expeditePendingTransition = !!pendingTransition
      && shouldScheduleProjectSupervisorTransitionReminder(pendingTransition.notificationCount)
      && (
        managerTurnEnded
        || (controlPlaneKnownIdleManager
          && Date.now() - pendingTransition.notifiedAt >= PROJECT_IDLE_TRANSITION_REDELIVERY_MS)
      );
    if (expeditePendingTransition) {
      maintainProjectSupervisorTransition(session, Date.now(), { forceReminder: true });
      const progressTimer = projectProgressTimers.get(session.id);
      if (progressTimer) globalThis.clearTimeout(progressTimer);
      projectProgressTimers.delete(session.id);
      scheduleProjectDeadlockCheck(
        session.id,
        Date.now() + PROJECT_MANAGER_DELIVERY_ACK_TIMEOUT_MS + 5_000,
        '项目 AI 空闲且未回执监督交接，快速补投后复核执行链',
      );
      return true;
    }
    const exhaustedTransition = (session.pendingSupervisorTransitions || []).find((transition) => (
      !shouldScheduleProjectSupervisorTransitionReminder(transition.notificationCount)
    ));
    const unanswered = session.status === 'waiting' ? unresolvedProjectUserAnswer(session) : undefined;
    const waitingObligation = session.status === 'waiting' ? currentObligation : null;

    let workItem: ProjectWorkItem | undefined;
    let blocker = '';
    let evidenceSummary = '';
    let incidentReason = 'project-execution-deadlock';
    let obligationKind: string | undefined;

    if (exhaustedTransition) {
      if (!managerTurnEnded && !controlPlaneKnownIdleManager) return false;
      workItem = exhaustedTransition.workItemId
        ? session.workItems.find((candidate) => candidate.id === exhaustedTransition.workItemId)
        : undefined;
      blocker = `项目 AI 连续收到监督交接但未提交处理回执：${exhaustedTransition.summary}`;
      evidenceSummary = `交接 ${exhaustedTransition.id} 已通知 ${exhaustedTransition.notificationCount} 次，仍未处理。`;
      incidentReason = 'project-transition-unhandled';
    } else if (unanswered) {
      if (!managerTurnEnded && !controlPlaneKnownIdleManager) return false;
      workItem = unanswered.workItemId
        ? session.workItems.find((candidate) => candidate.id === unanswered.workItemId)
        : undefined;
      blocker = `项目 AI 已收到用户答复，但本回合结束时没有落实恢复、改线、暂停或停止决定：${unanswered.summary}`;
      evidenceSummary = `用户答复事件：${unanswered.id}`;
      incidentReason = 'project-user-answer-unhandled';
    } else if (waitingObligation) {
      if (!managerTurnEnded && !controlPlaneKnownIdleManager) return false;
      const projectLanes = store.supervisor.lanes.filter((lane) => (
        lane.projectManagerProjectId === session.id
        && supervisorLaneControlState(lane) !== 'stopped'
      ));
      const executingRuntime = projectLanes.some((lane) => (
        remoteTerminalActivity(lane.surfaceId, preserveStaleWorking).activityState === 'working'
        || (!!dedicatedSupervisorSurfaceId(lane)
          && remoteTerminalActivity(
            dedicatedSupervisorSurfaceId(lane) as SurfaceId,
            preserveStaleWorking,
          ).activityState === 'working')
      ));
      if (executingRuntime) return false;
      obligationKind = waitingObligation.kind;
      const continuationKey = projectWaitingGateContinuationKey(session, waitingObligation);
      const attempts = projectWaitingGateContinuationAttempts(session, continuationKey);
      if (attempts < MAX_PROJECT_WAITING_GATE_CONTINUATIONS) {
        try {
          await appendRecordedProjectEvent(session, {
            kind: 'guard-triggered',
            summary: `目标变更后的内部门禁停滞，控制层自动续作：${waitingObligation.summary}`,
            payload: {
              decision: 'continue',
              attentionRequired: false,
              action: PROJECT_WAITING_GATE_CONTINUATION_ACTION,
              continuationKey,
              attempt: attempts + 1,
              obligation: waitingObligation.kind,
            },
          });
        } catch (error) {
          console.warn('[project-manager] failed to persist waiting gate continuation', error);
        }
        queueProjectManagerDelivery(
          projectWaitingGateContinuationText(session, waitingObligation),
          session.id,
          { priority: true, continuationKey },
        );
        return true;
      }
      blocker = `项目 AI 已收到目标变更后的自动续作，但仍未完成内部门禁：${waitingObligation.summary}`;
      evidenceSummary = `续作义务 ${waitingObligation.kind} 已自动投递 ${attempts} 次，项目状态和版本仍未推进。`;
      incidentReason = 'project-waiting-gate-unhandled';
    } else {
      if (session.status !== 'active' || (session.pendingSupervisorTransitions || []).length > 0) return false;
      const projectLanes = store.supervisor.lanes.filter((lane) => (
        lane.projectManagerProjectId === session.id
        && supervisorLaneControlState(lane) !== 'stopped'
      ));
      const executingRuntime = projectLanes.some((lane) => (
        remoteTerminalActivity(lane.surfaceId, preserveStaleWorking).activityState === 'working'
        || (!!dedicatedSupervisorSurfaceId(lane)
          && remoteTerminalActivity(
            dedicatedSupervisorSurfaceId(lane) as SurfaceId,
            preserveStaleWorking,
          ).activityState === 'working')
      ));
      if (executingRuntime) return false;
      const oldestPendingSupervisorDelivery = projectLanes
        .flatMap((lane) => lane.pendingSupervisorDeliveries || [])
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (oldestPendingSupervisorDelivery) {
        const handoffDeadline = oldestPendingSupervisorDelivery.createdAt + PROJECT_SUPERVISOR_HANDOFF_GRACE_MS;
        if (Date.now() < handoffDeadline) {
          scheduleProjectDeadlockCheck(
            session.id,
            handoffDeadline,
            '专属监督控制消息超过确认宽限期后复核执行链',
          );
          return false;
        }
      }
      const obligation = currentObligation;
      if (!obligation) return false;
      obligationKind = obligation.kind;
      const internallyRecoverableDeadlock = ['resume-paused', 'resolve-decision', 'recover-work']
        .includes(obligation.kind);
      if (internallyRecoverableDeadlock) {
        const continuationKey = projectWaitingGateContinuationKey(session, obligation);
        const attempts = projectActiveObligationContinuationAttempts(session, continuationKey);
        if (attempts < MAX_PROJECT_ACTIVE_OBLIGATION_CONTINUATIONS) {
          workItem = obligation.workItemId
            ? session.workItems.find((candidate) => candidate.id === obligation.workItemId)
            : session.workItems.find((candidate) => (
              candidate.goalId === activeProjectGoal(session).id
              && !['completed', 'stopped'].includes(candidate.status)
            ));
          try {
            await appendRecordedProjectEvent(session, {
              kind: 'guard-triggered',
              workItemId: workItem?.id,
              summary: `主目标执行链出现内部暂停/待决，控制层先要求项目 AI 自主消解：${obligation.summary}`,
              payload: {
                decision: 'continue',
                attentionRequired: false,
                action: PROJECT_ACTIVE_OBLIGATION_CONTINUATION_ACTION,
                continuationKey,
                attempt: attempts + 1,
                obligation: obligation.kind,
              },
            });
          } catch (error) {
            console.warn('[project-manager] failed to persist internal obligation continuation', error);
          }
          queueProjectManagerDelivery(
            projectInternalBlockedObligationContinuationText(session, obligation, workItem),
            session.id,
            { priority: true, continuationKey },
          );
          scheduleProjectDeadlockCheck(
            session.id,
            Date.now() + PROJECT_MANAGER_DELIVERY_ACK_TIMEOUT_MS + 5_000,
            `项目 AI 内部续作投递后仍未形成活动执行链：${obligation.kind}`,
          );
          return true;
        }
        incidentReason = 'project-active-obligation-unhandled';
      }
      if (['plan-work', 'map-stage-acceptance', 'close-stage', 'complete-goal'].includes(obligation.kind)
        && (managerTurnEnded || controlPlaneKnownIdleManager)) {
        const continuationKey = projectWaitingGateContinuationKey(session, obligation);
        const attempts = projectActiveObligationContinuationAttempts(session, continuationKey);
        if (attempts < MAX_PROJECT_ACTIVE_OBLIGATION_CONTINUATIONS) {
          try {
            await appendRecordedProjectEvent(session, {
              kind: 'guard-triggered',
              summary: obligation.kind === 'complete-goal'
                ? `主目标成果已经完成，控制层自动要求项目 AI 执行目标级验收收口：${obligation.summary}`
                : `活动目标仍有未完成阶段，控制层自动要求项目 AI 建立当前协议工作项：${obligation.summary}`,
              payload: {
                decision: 'continue',
                attentionRequired: false,
                action: PROJECT_ACTIVE_OBLIGATION_CONTINUATION_ACTION,
                continuationKey,
                attempt: attempts + 1,
                obligation: obligation.kind,
              },
            });
          } catch (error) {
            console.warn('[project-manager] failed to persist active obligation continuation', error);
          }
          queueProjectManagerDelivery(
            projectActiveObligationContinuationText(session, obligation),
            session.id,
            { priority: true, continuationKey },
          );
          return true;
        }
        if (obligation.kind === 'map-stage-acceptance') {
          const alreadyReported = session.events.some((event) => (
            event.kind === 'guard-triggered'
            && event.payload?.reason === 'stage-closure-evidence-mapping-missing'
            && event.payload?.continuationKey === continuationKey
          ));
          if (!alreadyReported) {
            try {
              await appendRecordedProjectEvent(session, {
                kind: 'guard-triggered',
                workItemId: obligation.workItemId,
                summary: `阶段已有完成证据但验收映射仍缺失；保持项目状态并停止自动重试：${obligation.summary}`,
                payload: {
                  decision: 'wait',
                  attentionRequired: true,
                  reason: 'stage-closure-evidence-mapping-missing',
                  continuationKey,
                  obligation: obligation.kind,
                  missingCriteria: obligation.missingCriteria || [],
                },
              });
            } catch (error) {
              console.warn('[project-manager] failed to persist stage coverage mapping alert', error);
            }
          }
          return true;
        }
        if (obligation.kind === 'complete-goal') {
          const alreadyReported = session.events.some((event) => (
            event.kind === 'guard-triggered'
            && event.payload?.reason === 'project-goal-closure-pending'
            && event.payload?.continuationKey === continuationKey
          ));
          if (!alreadyReported) {
            try {
              await appendRecordedProjectEvent(session, {
                kind: 'guard-triggered',
                summary: `主目标成果已经完成，但项目 AI 尚未提交可通过门禁的目标级完成声明：${obligation.summary}`,
                payload: {
                  decision: 'wait',
                  attentionRequired: true,
                  reason: 'project-goal-closure-pending',
                  continuationKey,
                  obligation: obligation.kind,
                },
              });
            } catch (error) {
              console.warn('[project-manager] failed to persist goal closure pending alert', error);
            }
          }
          return true;
        }
      }
      if (!managerTurnEnded && !controlPlaneKnownIdleManager && !internallyRecoverableDeadlock) return false;
      workItem = obligation.workItemId
        ? session.workItems.find((candidate) => candidate.id === obligation.workItemId)
        : session.workItems.find((candidate) => (
          candidate.goalId === activeProjectGoal(session).id
          && !['completed', 'stopped'].includes(candidate.status)
        ));
      blocker = workItem?.latestBlocker?.trim() || obligation.summary;
      evidenceSummary = obligation.summary;
    }

    const recoveryKey = [
      'project-internal-recovery',
      `role-${PROJECT_MANAGER_PROTOCOL_REVISION}`,
      session.id,
      workItem?.id || 'project',
      incidentReason,
      obligationKind || 'none',
    ].join(':');
    const recoveryScopeKey = projectInternalRecoveryScopeKey(session, workItem?.id);
    const recoveryPending = (session.pendingManagerDeliveries || []).some((delivery) => (
      (delivery.dedupeKey === recoveryKey || delivery.dedupeKey === recoveryScopeKey)
      && delivery.stage !== 'failed'
    )) || pendingProjectManagerDeliveries.some((delivery) => (
      delivery.sessionId === session.id
      && (delivery.dedupeKey === recoveryKey || delivery.dedupeKey === recoveryScopeKey)
      && delivery.stage !== 'failed'
    ));
    if (recoveryPending) return true;
    const recoveryAttempts = Math.max(
      projectInternalRecoveryAttempts(session.events, recoveryKey),
      projectInternalRecoveryAttempts(session.events, recoveryScopeKey),
    );
    if (recoveryAttempts >= 2) {
      for (const laneId of projectSupervisorLaneIds(session)) {
        store.pauseSupervisorLane(laneId, '项目内部恢复已达上限');
      }
      await appendRecordedProjectEvent(session, {
        kind: 'guard-triggered',
        workItemId: workItem?.id,
        summary: '项目内部恢复连续失败，已停止自动推进并安全暂停',
        payload: {
          decision: 'pause',
          attentionRequired: false,
          reason: 'project-internal-recovery-exhausted',
          recoveryKey,
          recoveryScopeKey,
          attempts: recoveryAttempts,
          ...(obligationKind ? { obligation: obligationKind } : {}),
        },
      });
      await pauseProjectForExecutionStall(
        session.id,
        `内部恢复连续失败：${blocker || evidenceSummary || incidentReason}`,
        recoveryKey,
        workItem?.id,
      );
      return true;
    }

    const managerRuntimeState = manager
      ? terminalRuntimeStatus(manager.surfaceId)?.state
      : undefined;
    const managerShellFailure = manager
      ? nestedAgentShellFailureDetail(manager.surfaceId)
      : null;
    let managerRuntimeUnavailable = shouldRestartProjectManagerRuntime({
      managerPresent: !!manager,
      runtimeState: managerRuntimeState,
      shellFailure: !!managerShellFailure,
    });
    if (!managerRuntimeUnavailable && manager && (window as any).wmux?.pty?.has) {
      try {
        managerRuntimeUnavailable = shouldRestartProjectManagerRuntime({
          managerPresent: true,
          runtimeState: managerRuntimeState,
          shellFailure: !!managerShellFailure,
          ptyPresent: await (window as any).wmux.pty.has(manager.surfaceId),
        });
      } catch {
        // A transient probe failure is not proof that the runtime disappeared.
      }
    }
    let runtimeRestarted = false;
    if (managerRuntimeUnavailable) {
      const runtime = await ensureProjectManagerRuntime(session.id, { forceRestart: true });
      if (!runtime.ok) {
        for (const laneId of projectSupervisorLaneIds(session)) {
          store.pauseSupervisorLane(laneId, '项目 AI 运行时内部恢复失败');
        }
        await appendRecordedProjectEvent(session, {
          kind: 'guard-triggered',
          workItemId: workItem?.id,
          summary: '项目 AI 运行时内部恢复失败，已停止自动推进并安全暂停',
          payload: {
            decision: 'pause',
            attentionRequired: false,
            reason: 'project-internal-runtime-recovery-failed',
            recoveryKey,
            recoveryScopeKey,
          },
        });
        await pauseProjectForExecutionStall(
          session.id,
          runtime.error || '项目 AI 运行时内部恢复失败',
          recoveryKey,
          workItem?.id,
        );
        return true;
      }
      runtimeRestarted = true;
    }
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
    await appendRecordedProjectEvent(current, {
      kind: 'project-recovery-requested',
      workItemId: workItem?.id,
      summary: runtimeRestarted
        ? '控制层重建不可用的项目 AI 运行时并续接内部执行义务'
        : '控制层保留项目 AI 当前会话并续接内部执行义务',
      payload: {
        recoveryKey,
        recoveryScopeKey,
        attempt: recoveryAttempts + 1,
        reason: incidentReason,
        attentionRequired: false,
        runtimeRestarted,
        ...(obligationKind ? { obligation: obligationKind } : {}),
      },
    });
    queueProjectManagerDelivery([
      runtimeRestarted
        ? '[控制层内部恢复｜运行时已重建｜不得询问用户]'
        : '[控制层内部恢复｜保留当前会话｜不得询问用户]',
      `项目：${session.id} · ${session.projectDir}`,
      workItem ? `工作项：${workItem.id} · ${workItem.title}` : '',
      `内部故障：${blocker || incidentReason}`,
      evidenceSummary ? `检测依据：${evidenceSummary}` : '',
      `触发位置：${trigger}`,
      runtimeRestarted
        ? '原项目 AI 运行时不可用，控制层已创建新会话；只从持久项目状态恢复事实。'
        : '当前项目 AI 运行时仍健康；这是同一会话内的语义纠错，不得使用 /new、重启角色或丢弃现有上下文。',
      '所有结构化项目命令都必须显式使用 --json 或 --json-file；优先写入项目 .wmux/tmp/ 并使用 --json-file。若命令返回 Error 或 ok=false，运行该子命令 --help 后重试，不得用只读 inspect/status 冒充状态迁移。',
      '先运行 wmux context 和 project status，按当前协议完成一个真实状态迁移：恢复或重建监督链、处理监督交接、落实已收到的用户答复、重绑当前工作项，或停止无效工作项并重规划。不得为内部故障创建用户问题。',
      '只有业务取舍、用户独有信息/凭据、真实人工操作、新设备/参数/风险授权、破坏性或生产动作才可 project ask。',
      `处理后再次运行 wmux project status --project ${session.id}，确认存在活动责任者或真实用户边界。`,
    ].filter(Boolean).join('\n'), current.id, {
      priority: true,
      dedupeKey: recoveryScopeKey,
    });
    scheduleProjectDeadlockCheck(
      session.id,
      Date.now() + PROJECT_MANAGER_DELIVERY_ACK_TIMEOUT_MS + 5_000,
      `项目 AI 内部恢复后仍未形成活动执行链：${incidentReason}`,
    );
    return true;
  } finally {
    projectDeadlockEscalations.delete(sessionId);
  }
}

function scheduleProjectProgressCheck(sessionId: string, notBeforeAt = 0): void {
  const existing = projectProgressTimers.get(sessionId);
  if (existing) globalThis.clearTimeout(existing);
  projectProgressTimers.delete(sessionId);
  const session = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  const transition = session ? nextProjectSupervisorTransition(session) : undefined;
  if (!session || session.status !== 'active' || !transition) return;
  const taskInputBlocked = projectTaskInputTransitionStillBlocked(transition);
  if (!taskInputBlocked && !shouldScheduleProjectSupervisorTransitionReminder(transition.notificationCount)) return;
  const generation = projectManagerDeliveryGeneration;
  const deadlineAt = Math.max(
    notBeforeAt,
    taskInputBlocked
      ? Date.now()
      : transition.notifiedAt + projectSupervisorTransitionRedeliveryMs(transition.notificationCount),
  );
  const timer = globalThis.setTimeout(() => {
    if (generation !== projectManagerDeliveryGeneration) return;
    projectProgressTimers.delete(sessionId);
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
    if (!current || current.status !== 'active') return;
    maintainProjectSupervisorTransition(current, Date.now());
  }, Math.max(0, deadlineAt - Date.now()));
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  projectProgressTimers.set(sessionId, timer);
}

function scheduleProjectDeadlockCheck(sessionId: string, deadlineAt: number, trigger: string): void {
  const existing = projectDeadlockRetryTimers.get(sessionId);
  if (existing) globalThis.clearTimeout(existing);
  const generation = projectManagerDeliveryGeneration;
  const timer = globalThis.setTimeout(() => {
    projectDeadlockRetryTimers.delete(sessionId);
    if (generation !== projectManagerDeliveryGeneration) return;
    void ensureProjectDeadlockRecovery(sessionId, trigger);
  }, Math.max(0, deadlineAt - Date.now()));
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  projectDeadlockRetryTimers.set(sessionId, timer);
}

export async function auditProjectLiveness(): Promise<void> {
  // Delivery readiness and Agent lifecycle events can both be lost. The
  // control plane must therefore make progress without waiting for an Agent
  // to emit the next event.
  const candidateSessions = useStore.getState().projectManagers
    .filter((session) => ['active', 'waiting'].includes(session.status));
  candidateSessions.forEach((session) => reconcileProjectExecutionResponsibility(session.id));
  const activeSessions = useStore.getState().projectManagers
    .filter((session) => ['active', 'waiting'].includes(session.status));
  const deadlockCandidates: ProjectManagerSession[] = [];
  for (const session of activeSessions) {
    const disposition = classifyProjectWatchdogScenario(session, {
      hasPendingManagerDelivery: (session.pendingManagerDeliveries || []).length > 0
        || pendingProjectManagerDeliveries.some((delivery) => delivery.sessionId === session.id),
    });
    if (disposition.inspectDeadlock) deadlockCandidates.push(session);
    if (!disposition.recoverManagerRuntime) continue;
    if (projectManagerTerminal({ surfaceId: session.managerSurfaceId, projectId: session.id })) continue;
    (window as any).__wmux_queueProjectManagerRuntimeRecovery?.({
      projectId: session.id,
      role: 'manager',
      detail: '控制层活性看门狗发现项目 AI 运行时缺失',
      watchdogRecovery: true,
      recoveryKey: `project-liveness:${session.id}`,
    });
  }
  flushProjectManagerDeliveries();
  await Promise.allSettled(deadlockCandidates.map((session) => (
    ensureProjectDeadlockRecovery(session.id, PROJECT_LIVENESS_WATCHDOG_TRIGGER)
  )));
}

function scheduleProjectLivenessWatchdog(): void {
  if (projectLivenessWatchdogTimer) globalThis.clearTimeout(projectLivenessWatchdogTimer);
  const generation = projectManagerDeliveryGeneration;
  const timer = globalThis.setTimeout(() => {
    if (projectLivenessWatchdogTimer === timer) projectLivenessWatchdogTimer = undefined;
    if (generation !== projectManagerDeliveryGeneration) return;
    void auditProjectLiveness().finally(() => {
      if (generation === projectManagerDeliveryGeneration) scheduleProjectLivenessWatchdog();
    });
  }, PROJECT_LIVENESS_WATCHDOG_INTERVAL_MS);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  projectLivenessWatchdogTimer = timer;
}

type ProjectTaskRuntimeEnsureResult = {
  ok: boolean;
  error?: string;
  terminal?: RemoteTaskTerminalLocation;
  created?: boolean;
  repositoryBootstrapDispatched?: boolean;
};

function ensureProjectTaskRuntime(sessionId: string): Promise<ProjectTaskRuntimeEnsureResult> {
  return runProjectRuntimeEnsure(
    projectTaskRuntimeEnsureRuns,
    sessionId,
    0,
    async () => {
      const runtime = await ensureProjectTaskRuntimeNow(sessionId);
      if (!runtime.ok || !runtime.terminal || runtime.repositoryBootstrapDispatched) return runtime;
      const bootstrap = await deliverProjectRepositoryBootstrap(sessionId, runtime.terminal);
      return bootstrap.ok
        ? { ...runtime, repositoryBootstrapDispatched: bootstrap.dispatched }
        : { ...runtime, ok: false, error: bootstrap.error };
    },
  );
}

function markProjectRepositoryBootstrapDispatched(
  sessionId: string,
  surfaceId: SurfaceId,
  delivery: 'startup-task' | 'existing-runtime',
): void {
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!current || !projectRepositoryBootstrapRequired(current)) return;
  replaceProjectManagerSession({
    ...current,
    repositoryBootstrapPending: false,
    updatedAt: Date.now(),
  });
  useStore.getState().appendProjectManagerEvent({
    kind: 'supervisor-status',
    summary: '仓库基础治理任务已投递给任务 AI',
    payload: { repositoryBootstrap: true, surfaceId, delivery },
  }, sessionId);
  saveProjectManagerSnapshot(sessionId);
}

async function deliverProjectRepositoryBootstrap(
  sessionId: string,
  terminal: RemoteTaskTerminalLocation,
): Promise<{ ok: boolean; dispatched?: boolean; error?: string }> {
  const session = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!projectRepositoryBootstrapRequired(session)) return { ok: true, dispatched: false };
  const agentState = (window as any).__wmux_getAgentStates?.()?.[terminal.surfaceId];
  if (Number(agentState?.runDepth || 0) > 0) {
    return { ok: false, error: '任务 AI 仍有内部线程运行，仓库基础治理将在运行结束后重试' };
  }
  if (remoteTerminalActivity(terminal.surfaceId, true).activityState === 'working') {
    return { ok: false, error: '任务 AI 仍在工作，仓库基础治理将在本轮结束后重试' };
  }
  const buffer = surfaceTerminalRegistry.get(terminal.surfaceId)?.buffer.active;
  if (buffer && hasPendingTerminalInput(buffer)) {
    return { ok: false, error: '任务 AI 输入区已有未提交内容，不能覆盖以投递仓库基础治理' };
  }
  try {
    let acknowledgement: ReturnType<typeof beginTaskPromptAcknowledgement> | undefined;
    await Promise.resolve(sendTaskToSurfaceReliably(
      terminal.surfaceId,
      renderProjectRepositoryBootstrapTask(),
      true,
      'project',
      () => terminalScreenTail(terminal.surfaceId),
      () => {
        acknowledgement = beginTaskPromptAcknowledgement(
          terminal.surfaceId,
          terminalScreenTail(terminal.surfaceId),
        );
      },
    ));
    if (!acknowledgement) {
      return { ok: false, error: '仓库基础治理输入已发送，但没有建立任务提交确认' };
    }
    const delivery = await acknowledgement.promise;
    if (!delivery.confirmed) {
      return {
        ok: false,
        error: `仓库基础治理输入已发送，但 15 秒内未收到 UserPromptSubmit 确认（当前 ${delivery.agentState}）`,
      };
    }
  } catch (error) {
    return { ok: false, error: `仓库基础治理投递失败：${String((error as Error)?.message || error)}` };
  }
  markProjectRepositoryBootstrapDispatched(sessionId, terminal.surfaceId, 'existing-runtime');
  return { ok: true, dispatched: true };
}

async function ensureProjectTaskRuntimeNow(sessionId: string): Promise<ProjectTaskRuntimeEnsureResult> {
  const session = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session) return { ok: false, error: '项目中心没有找到对应项目' };
  const projectTaskTerminals = remoteProjectTerminalList().filter((terminal) => (
    terminal.role === 'task-ai'
    && terminal.projectId === session.id
  ));
  if (projectTaskTerminals.length > 1) {
    return { ok: false, error: '检测到同一项目存在多个任务 AI 终端；已停止自动创建，请先处理异常运行时' };
  }
  const existing = projectTaskTerminals.find((terminal) => terminal.surfaceId === session.taskTerminalSurfaceId)
    || projectTaskTerminals[0];
  if (existing) {
    const failure = nestedAgentShellFailureDetail(existing.surfaceId);
    const runtime = terminalRuntimeStatus(existing.surfaceId)?.state;
    if (!failure && runtime !== 'failed' && runtime !== 'exited') {
      if (session.taskTerminalSurfaceId !== existing.surfaceId) {
        const updated = { ...session, taskTerminalSurfaceId: existing.surfaceId, updatedAt: Date.now() };
        replaceProjectManagerSession(updated);
        await (window as any).wmux?.projectManager?.saveSession?.(updated);
      }
      return { ok: true, terminal: existing, created: false };
    }
    closeLiveSurfaceById(existing.surfaceId);
  }

  const defaults = projectTaskTerminalDefaults(effectiveProjectAgentConfig(session));
  const repositoryBootstrapPending = projectRepositoryBootstrapRequired(session);
  const launched = createRemoteDirectTerminalTask({
    action: 'create-task',
    name: `${projectDisplayName(session)} · 任务 AI`,
    task: repositoryBootstrapPending
      ? renderProjectRepositoryBootstrapTask()
      : '当前没有已派发的成果任务。保持空闲，不要修改文件、运行命令或执行测试；收到下一条任务后再开始工作。',
    agent: defaults.agent,
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    cwd: session.projectDir,
    projectManagerProjectId: session.id,
    projectRuntimeWorkspace: true,
    actor: 'project-control-plane',
  }, true);
  if (!launched.ok || !launched.surfaceId) {
    return { ok: false, error: launched.error || '无法创建任务 AI 运行时' };
  }
  const terminal = remoteProjectTerminalList().find((candidate) => (
    candidate.role === 'task-ai'
    && candidate.projectId === session.id
    && candidate.surfaceId === launched.surfaceId
  ));
  if (!terminal) {
    closeLiveSurfaceById(launched.surfaceId as SurfaceId);
    return { ok: false, error: '任务 AI 已创建但未注册为项目任务终端' };
  }
  const ready = await waitForTerminalRuntimeReady(terminal.surfaceId);
  const failure = ready.ok
    ? nestedAgentShellFailureDetail(terminal.surfaceId)
    : ready.error || '未知错误';
  if (failure) {
    markTerminalRuntimeFailed(terminal.surfaceId, failure);
    closeLiveSurfaceById(terminal.surfaceId);
    return { ok: false, error: `任务 AI 运行时未就绪：${failure}` };
  }
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
  const updated = { ...current, taskTerminalSurfaceId: terminal.surfaceId, updatedAt: Date.now() };
  replaceProjectManagerSession(updated);
  await (window as any).wmux?.projectManager?.saveSession?.(updated);
  if (repositoryBootstrapPending) {
    markProjectRepositoryBootstrapDispatched(session.id, terminal.surfaceId, 'startup-task');
  }
  return {
    ok: true,
    terminal,
    created: true,
    repositoryBootstrapDispatched: repositoryBootstrapPending,
  };
}

type ProjectAuxiliaryRuntimeEnsureResult = {
  ok: boolean;
  error?: string;
  terminal?: RemoteTaskTerminalLocation;
  created?: boolean;
  disabled?: boolean;
};

function ensureProjectAuxiliaryRuntime(sessionId: string, options: {
  forceRestart?: boolean;
} = {}): Promise<ProjectAuxiliaryRuntimeEnsureResult> {
  return runProjectRuntimeEnsure(
    projectAuxiliaryRuntimeEnsureRuns,
    sessionId,
    options.forceRestart === true ? PROJECT_RUNTIME_FORCE_RESTART_INTENT : 0,
    () => ensureProjectAuxiliaryRuntimeNow(sessionId, options),
  );
}

async function ensureProjectAuxiliaryRuntimeNow(sessionId: string, options: {
  forceRestart?: boolean;
} = {}): Promise<ProjectAuxiliaryRuntimeEnsureResult> {
  const session = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session) return { ok: false, error: '项目中心没有找到对应项目' };
  const selection = projectAuxiliaryTaskTerminalDefaults(effectiveProjectAgentConfig(session));
  const existingTerminals = remoteProjectTerminalList().filter((terminal) => (
    terminal.role === 'auxiliary-task-ai' && terminal.projectId === session.id
  ));
  if (!selection.enabled) {
    existingTerminals.forEach((terminal) => closeLiveSurfaceById(terminal.surfaceId));
    if (session.auxiliaryTaskTerminalSurfaceId || session.auxiliaryTask?.status === 'running') {
      const updated = {
        ...session,
        auxiliaryTaskTerminalSurfaceId: undefined,
        auxiliaryTask: session.auxiliaryTask?.status === 'running'
          ? { ...session.auxiliaryTask, status: 'failed' as const, completedAt: Date.now(), summary: '用户已关闭辅助任务 AI' }
          : session.auxiliaryTask,
        updatedAt: Date.now(),
      };
      replaceProjectManagerSession(updated);
      await (window as any).wmux?.projectManager?.saveSession?.(updated);
    }
    return { ok: true, disabled: true, created: false };
  }
  if (existingTerminals.length > 1) {
    return { ok: false, error: '检测到同一项目存在多个辅助任务 AI；项目任务 AI 总数不能超过两个' };
  }
  const existing = existingTerminals.find((terminal) => terminal.surfaceId === session.auxiliaryTaskTerminalSurfaceId)
    || existingTerminals[0];
  if (existing && !options.forceRestart) {
    const failure = nestedAgentShellFailureDetail(existing.surfaceId);
    const runtime = terminalRuntimeStatus(existing.surfaceId)?.state;
    if (!failure && runtime !== 'failed' && runtime !== 'exited') {
      if (session.auxiliaryTaskTerminalSurfaceId !== existing.surfaceId) {
        const updated = { ...session, auxiliaryTaskTerminalSurfaceId: existing.surfaceId, updatedAt: Date.now() };
        replaceProjectManagerSession(updated);
        await (window as any).wmux?.projectManager?.saveSession?.(updated);
      }
      return { ok: true, terminal: existing, created: false };
    }
  }
  if (existing) closeLiveSurfaceById(existing.surfaceId);

  const main = remoteProjectTerminalList().find((terminal) => (
    terminal.role === 'task-ai'
    && terminal.projectId === session.id
    && terminal.surfaceId === session.taskTerminalSurfaceId
  ));
  if (!main) return { ok: false, error: '主任务 AI 尚未就绪，不能创建辅助任务 AI' };
  const launched = createRemoteDirectTerminalTask({
    action: 'create-task',
    name: `${projectDisplayName(session)} · 辅助任务 AI`,
    task: [
      '你是隔离的项目辅助任务 AI，不是主任务执行者。保持空闲，直到项目 AI 或监督 AI 通过控制层派发辅助任务。',
      '你知道项目 AI 和监督 AI 是任务请求方，但交互只限接收单项杂务并向原请求方回报；不得参与编排、审批、项目决策或主任务技术路线。',
      '只允许执行资料调查、项目进度保存、受控文档维护，以及用户已明确授权且仅包含任务自有文档的 Git commit。',
      '不得修改业务源码、测试、构建配置或依赖，不得运行项目实现/测试，不得 push、发布、改写 Git 历史，也不得寻找、联系或控制主任务 AI。',
    ].join(' '),
    agent: selection.agent,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    cwd: session.projectDir,
    anchorWorkspace: main.workspaceId,
    anchorTerminal: main.surfaceId,
    projectManagerProjectId: session.id,
    projectAuxiliaryTask: true,
    actor: 'project-control-plane',
  }, true);
  if (!launched.ok || !launched.surfaceId) {
    return { ok: false, error: launched.error || '无法创建辅助任务 AI 运行时' };
  }
  const terminal = remoteProjectTerminalList().find((candidate) => (
    candidate.role === 'auxiliary-task-ai'
    && candidate.projectId === session.id
    && candidate.surfaceId === launched.surfaceId
  ));
  if (!terminal) {
    closeLiveSurfaceById(launched.surfaceId as SurfaceId);
    return { ok: false, error: '辅助任务 AI 已创建但未注册为隔离辅助终端' };
  }
  const ready = await waitForTerminalRuntimeReady(terminal.surfaceId);
  const failure = ready.ok ? nestedAgentShellFailureDetail(terminal.surfaceId) : ready.error || '未知错误';
  if (failure) {
    markTerminalRuntimeFailed(terminal.surfaceId, failure);
    closeLiveSurfaceById(terminal.surfaceId);
    return { ok: false, error: `辅助任务 AI 运行时未就绪：${failure}` };
  }
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
  const updated = { ...current, auxiliaryTaskTerminalSurfaceId: terminal.surfaceId, updatedAt: Date.now() };
  replaceProjectManagerSession(updated);
  await (window as any).wmux?.projectManager?.saveSession?.(updated);
  return { ok: true, terminal, created: true };
}

function reconcileProjectSupervisorSurfaces(projectId: string, activeSupervisorSurfaceId: SurfaceId): void {
  const store = useStore.getState();
  for (const workspace of store.workspaces) {
    for (const paneId of getAllPaneIds(workspace.splitTree)) {
      const leaf = findLeaf(workspace.splitTree, paneId);
      for (const surface of [...(leaf?.surfaces || [])]) {
        if (surface.projectSupervisorProjectId !== projectId) continue;
        if (surface.type === 'supervisor') {
          store.updateSurface(workspace.id, paneId, surface.id, { customTitle: PROJECT_SUPERVISOR_WORKSPACE_TITLE });
        } else if (surface.id === activeSupervisorSurfaceId) {
          store.updateSurface(workspace.id, paneId, surface.id, { customTitle: '监督 AI' });
        } else {
          closeLiveSurfaceById(surface.id);
        }
      }
    }
  }
}

function projectSupervisorRuntimeCandidate(
  projectId: string,
  replacesLaneId: string,
): SupervisorLane | undefined {
  return useStore.getState().supervisor.lanes.find((lane) => (
    lane.projectManagerProjectId === projectId
    && lane.projectRuntimeHandover?.state === 'candidate'
    && lane.projectRuntimeHandover.replacesLaneId === replacesLaneId
  ));
}

function discardProjectSupervisorRuntimeCandidate(
  candidate: SupervisorLane,
  detail: string,
): void {
  const store = useStore.getState();
  const candidateSurfaceId = dedicatedSupervisorSurfaceId(candidate);
  store.setProjectSupervisorLanes(store.supervisor.lanes.filter((lane) => (
    isProjectManagedSupervisorLane(lane) && lane.id !== candidate.id
  )));
  if (candidateSurfaceId) {
    managedRoleProtocolReady.delete(candidateSurfaceId);
    closeLiveSurfaceById(candidateSurfaceId);
  }
  store.appendSupervisorLog(candidate.id, '候选监督运行时已回滚', detail);
}

/** Renderer reloads roll back an uncommitted candidate to the last authoritative lane. */
function rollbackInterruptedProjectSupervisorRuntimeHandovers(): void {
  const candidates = useStore.getState().supervisor.lanes.filter((lane) => (
    lane.projectRuntimeHandover?.state === 'candidate'
  ));
  for (const candidate of candidates) {
    discardProjectSupervisorRuntimeCandidate(candidate, '控制层重载时回滚未提交的监督运行时切换');
  }
}

async function replaceProjectSupervisorRuntimeTwoPhase(
  session: ProjectManagerSession,
  taskTerminal: RemoteTaskTerminalLocation,
  existing: SupervisorLane,
  reason: string,
): Promise<ProjectSupervisorRuntimeEnsureResult> {
  const store = useStore.getState();
  const previousSupervisorSurfaceId = dedicatedSupervisorSurfaceId(existing);
  const duplicateCandidate = projectSupervisorRuntimeCandidate(session.id, existing.id);
  if (duplicateCandidate) {
    return { ok: false, error: '项目监督运行时已经在切换中' };
  }
  const workspace = store.workspaces.find((candidate) => candidate.id === taskTerminal.workspaceId);
  const pane = workspace ? findLeaf(workspace.splitTree, taskTerminal.paneId) : null;
  if (!workspace || !pane) {
    return { ok: false, error: '项目任务 AI 已离开有效执行会话，不能准备候选监督运行时' };
  }
  const defaults = projectSupervisorDefaults(effectiveProjectAgentConfig(session));
  const isolationError = supervisorLaunchIsolationError(defaults.supervisorLaunchCmd);
  if (isolationError) return { ok: false, error: isolationError };
  const generation = Math.max(1, Math.trunc(existing.projectRuntimeGeneration || 1)) + 1;
  const launch = buildSupervisorLaunchCommand(
    defaults.supervisorLaunchCmd,
    defaults.supervisorModel,
    defaults.supervisorReasoningEffort,
    {
      isolateSupervisor: true,
      projectDir: taskTerminal.projectDir,
      isolationKey: `${taskTerminal.surfaceId}-g${generation}`,
    },
  );
  const candidateSurfaceId = store.addSurface(workspace.id, taskTerminal.paneId, 'terminal', {
    customTitle: '监督 AI（准备中）',
    shell: 'pwsh.exe',
    cwd: taskTerminal.projectDir,
    startupCommands: launch ? [launch] : undefined,
    transientSupervisor: true,
    supervisorRuntimeIsolationKey: `${taskTerminal.surfaceId}-g${generation}`,
    projectSupervisorProjectId: session.id,
  }) || undefined;
  if (!candidateSurfaceId) return { ok: false, error: '无法创建候选项目监督 AI' };
  markTerminalRuntimeStarting(candidateSurfaceId);
  managedRoleProtocolReady.delete(candidateSurfaceId);

  const candidateLane: SupervisorLane = {
    ...existing,
    id: `lane-${uuid()}`,
    managementSessionId: `sup-lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    supervisorSurfaceId: candidateSurfaceId,
    projectRuntimeGeneration: generation,
    projectRuntimeHandover: {
      state: 'candidate',
      replacesLaneId: existing.id,
      ...(previousSupervisorSurfaceId ? { previousSupervisorSurfaceId } : {}),
      startedAt: Date.now(),
    },
    supervisorBriefingStatus: 'pending',
    supervisorBriefingConfirmedAt: undefined,
    supervisorProblem: undefined,
    pendingSupervisorDeliveries: [],
    supervisorLaunchCmdOverride: defaults.supervisorLaunchCmd,
    supervisorModelOverride: defaults.supervisorModel,
    supervisorReasoningEffortOverride: defaults.supervisorReasoningEffort,
    controlState: 'active',
  };
  store.setProjectSupervisorLanes([
    ...store.supervisor.lanes.filter(isProjectManagedSupervisorLane),
    candidateLane,
  ]);
  void deliverSupervisorStartupBriefing(candidateLane.id);

  const ready = await waitForTerminalRuntimeReady(candidateSurfaceId);
  if (!ready.ok) {
    const currentCandidate = useStore.getState().supervisor.lanes
      .find((lane) => lane.id === candidateLane.id) || candidateLane;
    discardProjectSupervisorRuntimeCandidate(
      currentCandidate,
      `候选监督运行时未就绪：${ready.error || '未知错误'}`,
    );
    return { ok: false, error: `候选项目监督 AI 未就绪：${ready.error || '未知错误'}` };
  }
  const liveRuntime = !!(window as any).wmux?.pty?.has;
  if (liveRuntime && !await waitForProjectSupervisorBriefing(candidateLane.id)) {
    const currentCandidate = useStore.getState().supervisor.lanes
      .find((lane) => lane.id === candidateLane.id) || candidateLane;
    discardProjectSupervisorRuntimeCandidate(
      currentCandidate,
      '候选监督 AI 未确认当前 AGENTS.md 协议',
    );
    return { ok: false, error: '候选项目监督 AI 未确认当前 AGENTS.md 协议；旧监督运行时已保留' };
  }

  const currentStore = useStore.getState();
  const currentSession = currentStore.projectManagers.find((candidate) => candidate.id === session.id);
  const currentOldLane = currentStore.supervisor.lanes.find((lane) => lane.id === existing.id);
  const currentCandidate = currentStore.supervisor.lanes.find((lane) => lane.id === candidateLane.id);
  const currentTaskTerminal = remoteProjectTerminalList().find((terminal) => (
    terminal.role === 'task-ai'
    && terminal.projectId === session.id
    && terminal.surfaceId === taskTerminal.surfaceId
  ));
  const candidateRuntimeState = terminalRuntimeStatus(candidateSurfaceId)?.state;
  const candidateRuntimeFailure = nestedAgentShellFailureDetail(candidateSurfaceId);
  if (!currentSession
    || ['completed', 'stopped'].includes(currentSession.status)
    || currentSession.taskTerminalSurfaceId !== taskTerminal.surfaceId
    || !currentOldLane
    || supervisorLaneControlState(currentOldLane) === 'stopped'
    || currentOldLane.surfaceId !== taskTerminal.surfaceId
    || dedicatedSupervisorSurfaceId(currentOldLane) !== previousSupervisorSurfaceId
    || !currentCandidate
    || currentCandidate.projectWorkItemId !== currentOldLane.projectWorkItemId
    || currentCandidate.projectAssignmentVersion !== currentOldLane.projectAssignmentVersion
    || !currentTaskTerminal
    || candidateRuntimeState === 'failed'
    || candidateRuntimeState === 'exited'
    || !!candidateRuntimeFailure) {
    discardProjectSupervisorRuntimeCandidate(
      currentCandidate || candidateLane,
      candidateRuntimeFailure
        ? `候选监督就绪后运行时失效：${candidateRuntimeFailure}`
        : '候选监督就绪前项目、旧 lane、任务终端或候选运行时状态已经变化',
    );
    return { ok: false, error: '候选监督就绪前项目执行绑定已经变化；旧监督运行时已保留' };
  }

  const promotedLane: SupervisorLane = {
    ...currentOldLane,
    supervisorSurfaceId: candidateSurfaceId,
    projectRuntimeGeneration: generation,
    projectRuntimeHandover: undefined,
    supervisorBriefingStatus: 'confirmed',
    supervisorBriefingConfirmedAt: currentCandidate.supervisorBriefingConfirmedAt || Date.now(),
    supervisorProblem: undefined,
    pendingSupervisorDeliveries: (currentOldLane.pendingSupervisorDeliveries || []).map((delivery) => (
      delivery.stage === 'pasted' || delivery.stage === 'submitted'
        ? { ...delivery, stage: 'pending' as const, submittedAt: undefined }
        : delivery
    )),
    supervisorLaunchCmdOverride: defaults.supervisorLaunchCmd,
    supervisorModelOverride: defaults.supervisorModel,
    supervisorReasoningEffortOverride: defaults.supervisorReasoningEffort,
  };
  currentStore.setProjectSupervisorLanes(currentStore.supervisor.lanes
    .filter((lane) => isProjectManagedSupervisorLane(lane) && lane.id !== candidateLane.id)
    .map((lane) => lane.id === existing.id ? promotedLane : lane));
  if (previousSupervisorSurfaceId) {
    retiredProjectSupervisorRuntimes.set(previousSupervisorSurfaceId, {
      projectId: session.id,
      taskSurfaceId: taskTerminal.surfaceId,
      laneId: existing.id,
      generation: Math.max(1, Math.trunc(existing.projectRuntimeGeneration || 1)),
      retiredAt: Date.now(),
    });
  }
  reconcileProjectSupervisorSurfaces(session.id, candidateSurfaceId);
  signalSupervisorDeliveryReady();
  currentStore.appendSupervisorLog(
    existing.id,
    '项目监督运行时已原子切换',
    `${reason}；generation ${generation - 1} → ${generation}`,
  );
  return { ok: true, lane: promotedLane, created: true };
}

type ProjectSupervisorRuntimeEnsureResult = {
  ok: boolean;
  error?: string;
  lane?: SupervisorLane;
  created?: boolean;
};

export function ensureProjectSupervisorRuntime(sessionId: string, options: {
  forceRestart?: boolean;
} = {}): Promise<ProjectSupervisorRuntimeEnsureResult> {
  return runProjectRuntimeEnsure(
    projectSupervisorRuntimeEnsureRuns,
    sessionId,
    options.forceRestart === true ? PROJECT_RUNTIME_FORCE_RESTART_INTENT : 0,
    () => ensureProjectSupervisorRuntimeNow(sessionId, options),
  );
}

async function ensureProjectSupervisorRuntimeNow(sessionId: string, options: {
  forceRestart?: boolean;
} = {}): Promise<ProjectSupervisorRuntimeEnsureResult> {
  for (const candidate of useStore.getState().supervisor.lanes.filter((lane) => (
    lane.projectManagerProjectId === sessionId
    && lane.projectRuntimeHandover?.state === 'candidate'
  ))) {
    discardProjectSupervisorRuntimeCandidate(candidate, '开始新的监督运行时确保流程前回滚未提交候选');
  }
  const state = useStore.getState();
  const session = state.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session?.taskTerminalSurfaceId) return { ok: false, error: '项目任务 AI 尚未就绪' };
  const taskTerminal = remoteProjectTerminalList().find((terminal) => (
    terminal.role === 'task-ai'
    && terminal.projectId === session.id
    && terminal.surfaceId === session.taskTerminalSurfaceId
  ));
  if (!taskTerminal) return { ok: false, error: '项目任务 AI 已丢失，不能建立监督通道' };
  const activeItem = session.workItems.find((item) => item.id === session.activeWorkItemId)
    || session.workItems.find((item) => ['running', 'validating', 'waiting-decision'].includes(item.status));

  let existing = state.supervisor.lanes.find((lane) => (
    lane.projectManagerProjectId === session.id
    && supervisorLaneControlState(lane) !== 'stopped'
  ));
  const existingSupervisorLocation = existing?.supervisorSurfaceId
    ? remoteSurfaceTerminalLocation(existing.supervisorSurfaceId)
    : undefined;
  // A pane is only a presentation layout. Users and the renderer may split or
  // reorder project tabs between work items without changing either runtime's
  // project authority. Requiring the exact pane here unnecessarily killed a
  // healthy supervisor before the next assignment.
  const existingSharesProjectSession = existingSupervisorLocation?.workspaceId === taskTerminal.workspaceId;
  const existingSupervisorState = existing?.supervisorSurfaceId
    ? terminalRuntimeStatus(existing.supervisorSurfaceId)?.state
    : undefined;
  const existingSupervisorFailure = existing?.supervisorSurfaceId
    ? nestedAgentShellFailureDetail(existing.supervisorSurfaceId)
    : null;
  let replacementReason = '';
  if (!options.forceRestart
    && existing?.surfaceId === taskTerminal.surfaceId
    && existing.supervisorSurfaceId
    && existingSharesProjectSession
    && existingSupervisorState !== 'failed'
    && existingSupervisorState !== 'exited'
    && !existingSupervisorFailure) {
    const liveRuntime = !!(window as any).wmux?.pty?.has;
    const briefingReady = !liveRuntime
      || existing.supervisorBriefingStatus === 'confirmed'
      || (['pending', 'queued'].includes(existing.supervisorBriefingStatus || '')
        && await waitForProjectSupervisorBriefing(existing.id));
    if (briefingReady) {
      reconcileProjectSupervisorSurfaces(session.id, existing.supervisorSurfaceId);
      return { ok: true, lane: existing, created: false };
    }
    state.updateLane(existing.id, { supervisorBriefingStatus: 'failed' });
    replacementReason = '旧项目监督未确认当前 AGENTS.md 协议，原地重建后再派发工作项';
  }
  if (existing) {
    const reason = replacementReason
      || (options.forceRestart
        ? '控制层明确要求重建项目监督运行时'
        : existing.surfaceId !== taskTerminal.surfaceId
          ? '项目任务终端已变化，废弃旧监督绑定'
          : !existing.supervisorSurfaceId || !existingSupervisorLocation
            ? '项目监督终端已丢失，重建监督绑定'
            : !existingSharesProjectSession
              ? '项目监督终端已离开当前项目执行会话，重建监督绑定'
              : existingSupervisorState === 'failed' || existingSupervisorState === 'exited'
              ? '项目监督运行时已退出或失败，重建监督绑定'
              : existingSupervisorFailure || '项目监督运行时无法安全复用，重建监督绑定');
    return replaceProjectSupervisorRuntimeTwoPhase(session, taskTerminal, existing, reason);
  }

  const defaults = projectSupervisorDefaults(effectiveProjectAgentConfig(session));
  const activeAssignment = activeItem
    ? buildProjectSupervisorAssignment(session, activeItem)
    : undefined;
  const started = startRemoteSupervisor({
    action: 'start',
    terminals: [taskTerminal.surfaceId],
    taskGoal: activeAssignment?.objective || session.goal,
    taskDescription: activeAssignment?.description
      || '监督当前项目唯一任务 AI；没有活动工作项时保持空闲，等待项目 AI 交付工作项。',
    preconditions: (activeAssignment?.effectivePreconditions || session.preconditions).join('；'),
    supervisorNotes: (activeAssignment?.supervisorNotes || session.supervisorNotes || []).join('；'),
    stopWhen: activeItem
      ? [...activeItem.contract.stopWhen, ...activeItem.contract.validation].join('；')
      : session.doneWhen.join('；') || '当前派发工作项的验收条件全部满足',
    stopWhenKind: 'concrete',
    autonomous: true,
    supervisorLaunchCmd: defaults.supervisorLaunchCmd,
    supervisorModel: defaults.supervisorModel,
    supervisorReasoningEffort: defaults.supervisorReasoningEffort,
    projectManagerProjectId: session.id,
    projectWorkItemId: activeItem?.id,
    waitForNextDirection: true,
    actor: 'project-control-plane',
  }, true);
  if (!started.ok) return { ok: false, error: started.error || '无法创建项目监督 AI' };
  let lane = useStore.getState().supervisor.lanes.find((candidate) => (
    candidate.projectManagerProjectId === session.id
    && candidate.surfaceId === taskTerminal.surfaceId
    && supervisorLaneControlState(candidate) !== 'stopped'
  ));
  if (!lane?.supervisorSurfaceId) return { ok: false, error: '项目监督 AI 已创建但未完成通道绑定' };
  const ready = await waitForTerminalRuntimeReady(lane.supervisorSurfaceId);
  const failure = ready.ok
    ? nestedAgentShellFailureDetail(lane.supervisorSurfaceId)
    : ready.error || '未知错误';
  if (failure) {
    markTerminalRuntimeFailed(lane.supervisorSurfaceId, failure);
    useStore.getState().stopSupervisorLane(lane.id, `项目监督 AI 启动失败：${failure}`);
    closeLiveSurfaceById(lane.supervisorSurfaceId);
    return { ok: false, error: `项目监督 AI 运行时未就绪：${failure}` };
  }
  if ((window as any).wmux?.pty?.has && !await waitForProjectSupervisorBriefing(lane.id)) {
    useStore.getState().updateLane(lane.id, { supervisorBriefingStatus: 'failed' });
    useStore.getState().stopSupervisorLane(lane.id, '项目监督 AI 未确认当前 AGENTS.md 协议，禁止接收工作项');
    closeLiveSurfaceById(lane.supervisorSurfaceId);
    return { ok: false, error: '项目监督 AI 未确认当前 AGENTS.md 协议；已阻止任务派发' };
  }
  lane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane!.id) || lane;
  reconcileProjectSupervisorSurfaces(session.id, lane.supervisorSurfaceId!);
  if (activeItem && activeItem.supervisorLaneId !== lane.id) {
    useStore.getState().applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: activeItem.id,
      patch: { supervisorLaneId: lane.id, workerSurfaceId: taskTerminal.surfaceId },
    }, session.id);
    await (window as any).wmux?.projectManager?.saveSession?.(
      useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
    );
  }
  return { ok: true, lane, created: true };
}

type ProjectManagerRuntimeEnsureResult = {
  ok: boolean;
  error?: string;
  manager?: RemoteTaskTerminalLocation;
  created?: boolean;
};

function ensureProjectManagerRuntime(sessionId: string, options: {
  forceRestart?: boolean;
  recoveredAfterRestart?: boolean;
} = {}): Promise<ProjectManagerRuntimeEnsureResult> {
  const result = runProjectRuntimeEnsure(
    projectManagerRuntimeEnsureRuns,
    sessionId,
    (options.forceRestart === true ? PROJECT_RUNTIME_FORCE_RESTART_INTENT : 0)
      | (options.recoveredAfterRestart === true ? PROJECT_MANAGER_RECOVERED_AFTER_RESTART_INTENT : 0),
    () => ensureProjectManagerRuntimeNow(sessionId, options),
  );
  void result.then(flushProjectManagerDeliveries, flushProjectManagerDeliveries);
  return result;
}

async function ensureProjectManagerRuntimeNow(sessionId: string, options: {
  forceRestart?: boolean;
  recoveredAfterRestart?: boolean;
} = {}): Promise<ProjectManagerRuntimeEnsureResult> {
  const initialSession = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!initialSession) return { ok: false, error: '项目中心没有找到对应项目' };
  const safeExitContinuity = projectSafeExitContinuityVerified(initialSession);
  const previousManagers = projectManagerTerminals(sessionId);
  const previousManager = previousManagers.find((terminal) => terminal.surfaceId === initialSession.managerSurfaceId)
    || previousManagers[0];
  const selection = projectManagerRuntimeDefaults(effectiveProjectAgentConfig(initialSession));
  const matchesSelection = previousManager?.surface.projectManagerAgent === selection.agent
    && String(previousManager.surface.projectManagerModel || '') === selection.model
    && String(previousManager.surface.projectManagerReasoningEffort || '') === selection.reasoningEffort;
  const previousShellFailure = previousManager
    ? nestedAgentShellFailureDetail(previousManager.surfaceId)
    : null;
  if (previousManager && previousShellFailure) {
    markTerminalRuntimeFailed(previousManager.surfaceId, previousShellFailure);
  }
  const previousRuntimeState = previousManager
    ? terminalRuntimeStatus(previousManager.surfaceId)?.state
    : undefined;
  const replaceRuntime = !!previousManager && (
    options.forceRestart === true
    || !matchesSelection
    || previousRuntimeState === 'failed'
    || previousRuntimeState === 'exited'
  );
  const activeExecution = useStore.getState().supervisor.lanes.some((lane) => (
    projectSupervisorLaneProvidesActiveExecution(initialSession, lane)
  ));
  if ((!previousManager || replaceRuntime) && !options.recoveredAfterRestart && !activeExecution) {
    await scanProjectProgressForReview(sessionId, '项目 AI 运行时重建前检查项目现状');
  }
  if (replaceRuntime) {
    await (window as any).wmux?.projectManager?.saveSession?.(
      useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId) || initialSession,
    );
  }
  const roleRuntime = await (window as any).wmux?.projectManager?.ensureRuntime?.();
  if (!roleRuntime?.ok) return { ok: false, error: roleRuntime?.error || '无法准备项目 AI AGENTS.md' };
  const runtimeDir = String(roleRuntime.runtimeDir || '').trim();
  if (!normalizeAbsolutePath(runtimeDir)) return { ok: false, error: '项目管理 AI 运行目录无效' };
  const launched = createRemoteDirectTerminalTask({
    action: 'create-task',
    name: PROJECT_MANAGER_TERMINAL_NAME,
    task: projectManagerStartupInput(initialSession.id),
    agent: selection.agent,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    preset: 'project-manager',
    replaceProjectManager: replaceRuntime,
    cwd: runtimeDir,
    projectManagerProjectId: initialSession.id,
    actor: 'project-management-control-plane',
  }, true);
  if (!launched.ok) return { ok: false, error: launched.error || '无法启动项目管理 AI 运行时' };
  const manager = projectManagerTerminal({ surfaceId: launched.surfaceId, projectId: initialSession.id });
  if (!manager) return { ok: false, error: '项目管理 AI 运行时未注册' };
  const managerReady = await waitForTerminalRuntimeReady(manager.surfaceId);
  const managerFailure = managerReady.ok
    ? nestedAgentShellFailureDetail(manager.surfaceId)
    : managerReady.error || '未知错误';
  if (managerFailure) {
    markTerminalRuntimeFailed(manager.surfaceId, managerFailure);
    if (!previousManager || previousManager.surfaceId !== manager.surfaceId) {
      useStore.getState().closeSurface(manager.workspaceId, manager.paneId, manager.surfaceId);
    }
    return { ok: false, error: `项目管理 AI 运行时未就绪：${managerFailure}` };
  }
  for (const previous of previousManagers) {
    if (previous.surfaceId === manager.surfaceId) continue;
    useStore.getState().closeSurface(previous.workspaceId, previous.paneId, previous.surfaceId);
  }
  const stateBeforeBinding = useStore.getState();
  const runtimeChanged = replaceRuntime || initialSession.managerSurfaceId !== manager.surfaceId;
  if (runtimeChanged) managedRoleProtocolReady.delete(manager.surfaceId);
  const rebound = stateBeforeBinding.projectManagers.map((session) => {
    if (session.id !== initialSession.id) return session;
    return {
      ...session,
      managerSurfaceId: manager.surfaceId,
      pendingManagerDeliveries: runtimeChanged
        ? resetProjectManagerDeliveryAcknowledgements(session.pendingManagerDeliveries)
        : session.pendingManagerDeliveries,
      updatedAt: session.managerSurfaceId === manager.surfaceId ? session.updatedAt : Date.now(),
    };
  });
  stateBeforeBinding.restoreProjectManagers(rebound, stateBeforeBinding.selectedProjectManagerId || undefined);
  if (runtimeChanged) {
    for (const delivery of pendingProjectManagerDeliveries) {
      if (delivery.sessionId !== initialSession.id) continue;
      delivery.stage = 'pending';
      delivery.submittedAt = undefined;
      delivery.attempts = 0;
      delivery.alerted = false;
    }
    const compactedRuntimeDeliveries = compactProjectManagerPendingDeliveries(
      pendingProjectManagerDeliveries.filter((delivery) => delivery.sessionId === initialSession.id),
    );
    const retainedRuntimeDeliveryIds = new Set(compactedRuntimeDeliveries.map((delivery) => delivery.id));
    for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
      const delivery = pendingProjectManagerDeliveries[index];
      if (delivery.sessionId === initialSession.id && !retainedRuntimeDeliveryIds.has(delivery.id)) {
        pendingProjectManagerDeliveries.splice(index, 1);
      }
    }
  }
  if (previousManager && previousManager.surfaceId !== manager.surfaceId) {
    useStore.getState().appendProjectManagerEvent({
      kind: 'manager-runtime-restarted',
      summary: `本项目的项目 AI 已按配置安全换代为 ${selection.agent}${selection.model ? ` / ${selection.model}` : ''}，并恢复结构化项目上下文`,
      payload: {
        previousSurfaceId: previousManager.surfaceId,
        managerSurfaceId: manager.surfaceId,
        agent: selection.agent,
        model: selection.model,
      },
    }, initialSession.id);
    try {
      await (window as any).wmux?.projectManager?.saveSession?.(
        useStore.getState().projectManagers.find((candidate) => candidate.id === initialSession.id),
      );
    } catch (error) {
      console.warn('[project-manager] failed to persist runtime-restart audit event', error);
    }
  }
  let current = useStore.getState().projectManagers.find((candidate) => candidate.id === initialSession.id)!;
  hydrateProjectManagerDeliveries([current]);
  if (options.recoveredAfterRestart) {
    useStore.getState().appendProjectManagerEvent({
      kind: 'recovery-restored',
      summary: safeExitContinuity
        ? '已从安全退出检查点恢复当前项目事实；旧 AI 进程已失效，但证据、预算和下一动作继续有效'
        : '已从持久记录恢复本项目；旧项目 AI、监督 AI 和任务 AI 会话均已失效',
      payload: { recoverySource: safeExitContinuity ? 'safe-exit-checkpoint' : 'application-restart' },
    }, current.id);
    const hasPersistedAlignmentDecision = current.events.some((event) => (
      event.kind === 'requirements-alignment-confirmed'
    )) || projectAcceptedRequirementsVersion(current) >= projectRequirementsVersion(current);
    const recoveredDefinitionNeedsAlignment = !hasPersistedAlignmentDecision
      && projectRequirementAlignmentState(current) !== 'sufficient';
    if (projectRequirementsAlignmentPending(current) || recoveredDefinitionNeedsAlignment) {
      await requireProjectRequirementsAlignment(
        current.id,
        hasPersistedAlignmentDecision
          ? '继续首次启动时尚未完成的需求充分性检测'
          : '旧项目的目标或验收定义在当前协议下仍不充分，恢复前必须重新核对',
        !previousManager || previousManager.surfaceId !== manager.surfaceId,
      );
    }
    current = useStore.getState().projectManagers.find((candidate) => candidate.id === initialSession.id)!;
    await (window as any).wmux?.projectManager?.saveSession?.(current);
    const recoverableWorkItems = current.workItems.filter((item) => item.status !== 'stopped');
    const recoverySituation = [...current.events].reverse().find((event) => (
      event.kind === 'user-message'
      && event.payload?.source === 'desktop-recovery'
      && typeof event.payload.currentSituation === 'string'
    ))?.payload?.currentSituation as string | undefined;
    const recoverySituationBriefing = recoverySituation
      ? `[用户恢复时设置的当前情况｜优先核对]\n${recoverySituation}`
      : '';
    deliverProjectManagerMessage([
      '[本项目恢复｜创建全新项目运行链]',
      `项目：${current.id} · ${current.projectDir}`,
      `状态：${current.status}`,
      `目标：${current.goal}`,
      `前置条件：${current.preconditions.length > 0 ? current.preconditions.join('；') : '待核实'}`,
      recoverySituationBriefing,
      `[恢复需求异常门禁｜先核对再继续]\n把持久化目标、范围、前置条件、权限边界和完成条件，与用户恢复说明、当前目录快照及最近事件逐项比较。若存在会实质改变目标、范围、权限、前置条件或验收标准的缺口或冲突，必须先用 wmux project ask --project ${current.id} --json-file <项目目录内的 .wmux/tmp/文件> 发起 category=clarification 的结构化问题并给出推荐项；用户答复并写回项目定义前，不得 progress-sync --ack、orientation-confirm、goal-plan、resume、task-create 或 dispatch。没有实质歧义时不要机械提问，继续内部恢复核对。`,
      current.progressSync
        ? `[恢复时项目进度同步｜${current.progressSync.status === 'review-required' ? '必须先复核' : '已确认一致'}]\n${current.progressSync.summary}`
        : '[恢复时项目进度同步] 未取得可信快照，禁止直接沿用旧安排。',
      current.pendingSupervisorTransitions?.length
        ? `[待处理监督状态交接｜${current.pendingSupervisorTransitions.length} 项]\n${current.pendingSupervisorTransitions.map((transition) => (
          `${transition.id} · ${transition.kind} · ${transition.summary}`
        )).join('\n')}\n这些交接仍未被项目 AI 回执，必须优先处理并执行 transition-ack；不得把它们当成已经完成。`
        : '没有遗留的未回执监督状态交接。',
      recoverableWorkItems.length > 0
        ? `[全部未停止工作项｜${recoverableWorkItems.length} 项]\n${recoverableWorkItems.slice(0, 50).map((item) => (
            `${item.id} · ${item.title} · ${item.status} · G=${item.goalId || '未知'} · R${item.requirementsVersion || 0}/A${item.authorizationVersion || 0}/P${item.executionProtocolVersion || 0}${item.latestEvidence ? `；证据：${item.latestEvidence}` : ''}${item.latestBlocker ? `；阻塞：${item.latestBlocker}` : ''}`
          )).join('\n')}${recoverableWorkItems.length > 50 ? `\n另有 ${recoverableWorkItems.length - 50} 项，请从 project status 完整读取。` : ''}`
        : '当前没有未停止工作项。',
      safeExitContinuity
        ? '安全退出断点已通过目录指纹核对：只重建项目 AI、监督 AI 和任务 AI 进程，不重置工作项事实。保留证据、预算、失败计数和下一动作；对当前工作项执行 dispatch 建立新进程后直接从断点继续。不得重复已有测试、身份消费或设备操作。'
        : '先恢复项目环境，再恢复项目执行：旧项目 AI、监督 AI、任务 AI 及其 surfaceId 都已失效，不得恢复、读取、投递或重新绑定。恢复必须在进度同步、认知核对和需求版本门禁满足后创建一套全新的专属监督链；控制层会按恢复优先级为首个依赖已满足的工作项自动创建。不要重做已有证据支持的工作。',
      current.progressSync?.status === 'review-required'
        ? `先依据进度同步摘要和持久化证据更新受影响的工作项/阶段；摘要不能证明的语义与验证保持未知，并安排最小只读核对。然后执行 wmux project progress-sync --project ${current.id} --ack --summary "<已知变化、未知项和后续核对安排>"。确认前不得 resume、task-create 或 dispatch，也不要把内部同步交给用户确认。`
        : '恢复快照与上次已知进度一致，可继续按当前结构化状态规划。',
      safeExitContinuity
        ? `[执行协议｜P${CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION}｜安全退出断点] 未完成工作项使用当前协议且目录指纹未变化；仅重建监督/任务进程并保留执行进度。`
        : `[执行协议｜P${CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION}] 只接受当前协议持久记录；不迁移旧项目协议数据。`,
      `[项目认知基线｜继续前必须提交]\n在进度同步与需求对齐完成后，逐项判断上述所有未停止工作项，执行 wmux project orientation-confirm --project ${current.id} --json-file <项目目录内的 .wmux/tmp/文件>。JSON 必须原样携带 project status 中 orientation 的 requirementsVersion、authorizationVersion、snapshotFingerprint、requestedAt，并包含 summary、knownFacts、unknowns、workItems；每个工作项提供 workItemId、disposition（continue/verify/pause/stop/retain-completed）、basis 和 nextAction。未完成的旧目标/旧版本工作项只能 pause 或 stop。确认前不得 goal-plan、resume、task-create 或 dispatch。`,
      '你只管理本项目；不得读取或决定项目中心中的其他项目。',
    ].join('\n'), true, current.id);
    if (projectRequirementsAlignmentPending(current)) {
      await ensureProjectRequirementAlignment(
        current.id,
        '项目恢复时检测到目标、范围、前置条件或验收定义异常',
        true,
      );
    }
  }
  current = useStore.getState().projectManagers.find((candidate) => candidate.id === initialSession.id)!;
  if (current.status === 'active') {
    scheduleProjectProgressCheck(current.id);
  }
  return { ok: true, manager, created: !previousManager || previousManager.surfaceId !== manager.surfaceId };
}

function deliverProjectManagerMessage(text: string, runtimeCreated: boolean, sessionId: string): void {
  if (!runtimeCreated) {
    queueProjectManagerDelivery(text, sessionId);
    return;
  }
  window.setTimeout(() => queueProjectManagerDelivery(text, sessionId), SUPERVISOR_TUI_READY_DELAY_MS);
}

async function persistProjectManagerMutation<T extends { event?: { kind: string; summary: string; correlationId?: string; payload?: Record<string, unknown> } }>(
  result: T,
  sessionId?: string,
): Promise<T> {
  const state = useStore.getState();
  const session = sessionId
    ? state.projectManagers.find((candidate) => candidate.id === sessionId)
    : state.projectManager;
  if (!session) return result;
  if (result.event && projectManagerEventNeedsUserAttention(result.event)) {
    notifyProjectManagerAttention(session, result.event);
  }
  const api = (window as any).wmux?.projectManager;
  await api?.saveSession?.(session);
  if (result.event) {
    await api?.appendRecord?.({
      sessionId: session.id,
      projectDir: session.projectDir,
      type: result.event.kind,
      payload: {
        ...(result.event.payload || {}),
        message: result.event.summary,
        correlationId: result.event.correlationId,
      },
    });
  }
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  if (current?.status === 'active') scheduleProjectProgressCheck(current.id);
  return result;
}

function scheduleProjectAlignmentFallback(sessionId: string, runtimeCreated = false): void {
  const existing = projectAlignmentTimers.get(sessionId);
  if (existing) globalThis.clearTimeout(existing);
  const timer = globalThis.setTimeout(() => {
    projectAlignmentTimers.delete(sessionId);
    void ensureProjectRequirementAlignment(
      sessionId,
      '项目管理 AI 在规定时间内未提交需求充分性结论，控制层再次提醒其提交结构化判定',
      runtimeCreated,
      false,
    ).catch((error) => console.warn('[project-manager] alignment fallback failed', error));
  }, PROJECT_ALIGNMENT_FALLBACK_DELAY_MS);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  projectAlignmentTimers.set(sessionId, timer);
}

function changedProjectAgentRoles(
  previous: ReturnType<typeof normalizeProjectManagementAgentConfig>,
  next: ReturnType<typeof normalizeProjectManagementAgentConfig>,
): ProjectAgentRole[] {
  const roles = (['manager', 'supervisor', 'task', 'auxiliary'] as const).filter((role) => (
    previous[role].agent !== next[role].agent
    || previous[role].model !== next[role].model
    || previous[role].reasoningEffort !== next[role].reasoningEffort
  ));
  if (previous.auxiliary.enabled !== next.auxiliary.enabled) {
    if (!roles.includes('auxiliary')) roles.push('auxiliary');
  }
  return roles;
}

function patchProjectAgentSession(
  sessionId: string,
  patch: Partial<Pick<ProjectManagerSession, 'agentConfig' | 'agentIssue' | 'agentReconfiguration'>>,
): ProjectManagerSession | undefined {
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
  if (!current) return undefined;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  replaceProjectManagerSession(next);
  saveProjectManagerSnapshot(sessionId);
  return next;
}

function projectRoleSurfaceNeedsSafePoint(surfaceId: SurfaceId | null | undefined): boolean {
  if (!surfaceId) return false;
  const shellFailure = nestedAgentShellFailureDetail(surfaceId);
  if (shellFailure) {
    markTerminalRuntimeFailed(surfaceId, shellFailure);
    return false;
  }
  const runtime = terminalRuntimeStatus(surfaceId)?.state;
  if (runtime === 'failed' || runtime === 'exited') return false;
  return remoteTerminalActivity(surfaceId, true).activityState !== 'idle';
}

async function switchProjectSupervisorRuntime(
  session: ProjectManagerSession,
  lane: SupervisorLane,
): Promise<Record<string, unknown>> {
  if (!lane.projectWorkItemId) return { ok: true, skipped: true };
  return ensureProjectSupervisorRuntime(session.id, { forceRestart: true });
}

function projectSupervisorNoticeEventType(boundary: ProjectEscalationBoundary | undefined): string {
  if (boundary === 'contract-change') return 'supervisor.project-contract-review';
  if (boundary === 'cross-item-coordination') return 'supervisor.project-coordination';
  if (boundary === 'external-blocker') return 'supervisor.project-blocker';
  if (boundary === 'user-only-information') return 'supervisor.user-information-required';
  if (boundary === 'high-risk-action') return 'supervisor.high-risk-authorization-required';
  return 'supervisor.project-action-required';
}

function projectSupervisorNoticeInstruction(
  session: ProjectManagerSession,
  workItem: ProjectWorkItem,
  boundary: ProjectEscalationBoundary | undefined,
): string {
  const common = [
    '这是项目模式专用状态通知，不是普通监督 pendingApproval 请求；项目 AI 必须根据总计划、工作项和证据直接决策，禁止把通知原样退回监督。',
    '必须在本回合留下真实且立即可执行的下一责任者：在既有权限内调整工作项/阶段路线并 dispatch，同工作项内部重规划，暂缓当前项并推进不依赖项，或对真实用户边界执行结构化 project ask。不得回复“继续等待控制层恢复事件”。',
  ];
  if (boundary === 'contract-change') {
    common.push('先判断现有需求/授权版本、依赖和合同是否已经覆盖建议动作：已覆盖就直接续接；确有合同变化时更新工作项并重新派发。');
  } else if (boundary === 'cross-item-coordination') {
    common.push('由项目 AI 调整依赖、优先级、worker 分工或工作项状态；监督不得承担跨工作项调度。');
  } else if (boundary === 'external-blocker') {
    common.push('先区分项目内部运行时/投递故障与真实外部条件；内部故障应恢复监督链，只有用户控制且无法内部消解的外部条件才 project ask。');
  } else if (boundary === 'user-only-information' || boundary === 'high-risk-action') {
    common.push(`若当前项目定义尚未包含所需信息或授权，使用 wmux project ask --project ${session.id} 创建一个聚焦的结构化用户问题；不得建立普通监督待决卡。`);
  }
  common.push(`处理后用 wmux project transition-ack --project ${session.id} 回执工作项 ${workItem.id} 的本通知。`);
  return common.join('\n');
}

function queueProjectSupervisorNotice(options: {
  session: ProjectManagerSession;
  lane: SupervisorLane;
  workItem: ProjectWorkItem;
  boundary?: ProjectEscalationBoundary;
  reason: string;
  impact?: string;
  alternatives?: string;
  evidence?: string;
  contextSummary?: string;
}): { transition?: ProjectSupervisorTransition; duplicate: boolean } {
  const current = useStore.getState().projectManagers.find((candidate) => candidate.id === options.session.id)
    || options.session;
  const eventType = projectSupervisorNoticeEventType(options.boundary);
  const existing = (current.pendingSupervisorTransitions || []).find((transition) => (
    transition.laneId === options.lane.id
    && transition.workItemId === options.workItem.id
    && transition.kind === 'project-action-required'
    && transition.eventType === eventType
  ));
  const transition = queueProjectSupervisorTransition({
    sessionId: current.id,
    laneId: options.lane.id,
    workItemId: options.workItem.id,
    kind: 'project-action-required',
    eventType,
    summary: [options.reason, options.impact ? `影响：${options.impact}` : ''].filter(Boolean).join('；'),
    evidence: options.evidence,
    contextSummary: [options.contextSummary, options.alternatives ? `监督建议：${options.alternatives}` : '']
      .filter(Boolean).join('\n'),
    instruction: projectSupervisorNoticeInstruction(current, options.workItem, options.boundary),
  });
  return {
    transition,
    duplicate: !!existing && existing.id === transition?.id,
  };
}async function switchProjectTaskRuntime(
  session: ProjectManagerSession,
  lane: SupervisorLane,
): Promise<Record<string, unknown>> {
  if (!lane.projectWorkItemId) return { ok: true, skipped: true };
  const item = session.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
  if (!item) return { ok: false, error: '项目工作项已经不存在' };
  if (supervisorLaneControlState(lane) === 'paused' && (
    lane.supervisorProblem?.kind === 'provider-limit'
    || (session.agentIssue?.role === 'task' && session.agentIssue.laneId === lane.id)
  )) {
    useStore.getState().resumeSupervisorLane(lane.id, '用户已重新配置任务 Agent，准备安全轮换任务终端');
  }
  const currentLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane;
  useStore.getState().updateLane(currentLane.id, {
    projectTaskRotationPending: true,
    projectTaskRotationSummary: [
      item.latestContextSummary || '',
      '用户更新了当前项目的任务 Agent 配置；新任务 AI 必须先只读核对工作树、持久事件和已有证据，再继续未完成部分。',
    ].filter(Boolean).join('\n').slice(-12_000),
    projectTaskRotationRequestedAt: Date.now(),
  });
  const prepared = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id);
  return prepared
    ? rotateProjectTaskTerminalFromSupervisor(session, prepared)
    : { ok: false, error: '任务终端轮换前监督通道已经不存在' };
}

async function processProjectAgentReconfigurationNow(
  projectId: string,
  safeSurfaceId?: string,
): Promise<ProjectAgentReconfigurationResult> {
  const initial = useStore.getState().projectManagers.find((candidate) => candidate.id === projectId);
  const reconfiguration = initial?.agentReconfiguration;
  if (!initial || !reconfiguration) return { ok: true, pendingRoles: [], completedRoles: [], errors: [] };
  const pendingRoles: ProjectAgentRole[] = [];
  const completedRoles = [...reconfiguration.completedRoles];
  const errors: string[] = [];
  for (const role of reconfiguration.pendingRoles) {
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === projectId);
    if (!current || ['completed', 'stopped'].includes(current.status)) continue;
    if (role === 'auxiliary') {
      const auxiliarySurfaceId = current.auxiliaryTaskTerminalSurfaceId as SurfaceId | undefined;
      if (auxiliarySurfaceId !== safeSurfaceId && projectRoleSurfaceNeedsSafePoint(auxiliarySurfaceId)) {
        pendingRoles.push(role);
        continue;
      }
      const result = await ensureProjectAuxiliaryRuntime(projectId, { forceRestart: true });
      if (!result.ok) errors.push(`辅助任务 AI：${result.error || '换代失败'}`);
      else completedRoles.push(role);
      continue;
    }
    if (role === 'manager') {
      const result = await ensureProjectManagerRuntime(projectId, { forceRestart: true });
      if (!result.ok) errors.push(`项目 AI：${result.error || '换代失败'}`);
      else completedRoles.push(role);
      continue;
    }
    const lanes = useStore.getState().supervisor.lanes.filter((lane) => (
      lane.projectManagerProjectId === projectId && supervisorLaneControlState(lane) !== 'stopped'
    ));
    if (lanes.length === 0) {
      completedRoles.push(role);
      continue;
    }
    const waitingForSafePoint = lanes.some((lane) => role === 'supervisor'
      ? lane.supervisorSurfaceId !== safeSurfaceId && projectRoleSurfaceNeedsSafePoint(lane.supervisorSurfaceId)
      : (lane.surfaceId !== safeSurfaceId && projectRoleSurfaceNeedsSafePoint(lane.surfaceId))
        || (lane.supervisorSurfaceId !== safeSurfaceId && projectRoleSurfaceNeedsSafePoint(lane.supervisorSurfaceId)));
    const laneControlBlocked = lanes.some((lane) => (
      supervisorLaneControlState(lane) !== 'active'
      && !(current.agentIssue?.role === role && current.agentIssue.laneId === lane.id)
    ));
    if (current.status !== 'active' || waitingForSafePoint || laneControlBlocked) {
      pendingRoles.push(role);
      continue;
    }
    const results = [];
    for (const lane of lanes) {
      results.push(role === 'supervisor'
        ? await switchProjectSupervisorRuntime(current, lane)
        : await switchProjectTaskRuntime(current, lane));
    }
    const failed = results.find((result) => result?.ok !== true);
    if (failed) errors.push(`${role === 'supervisor' ? '专属监督 AI' : '任务 AI'}：${String(failed.error || '换代失败')}`);
    else {
      completedRoles.push(role);
      for (const lane of useStore.getState().supervisor.lanes.filter((candidate) => candidate.projectManagerProjectId === projectId)) {
        if (lane.supervisorProblem?.kind === 'provider-limit') {
          useStore.getState().updateLane(lane.id, { supervisorProblem: undefined });
        }
        if (role === 'task' && lane.projectWorkItemId) {
          useStore.getState().applyProjectManagerAction({
            type: 'update-work-item', workItemId: lane.projectWorkItemId,
            patch: { status: 'running', latestBlocker: undefined },
          }, projectId);
        }
      }
    }
  }
  const uniqueCompleted = [...new Set(completedRoles)];
  const uniquePending = [...new Set(pendingRoles)];
  const issueResolved = initial.agentIssue && uniqueCompleted.includes(initial.agentIssue.role)
    && !uniquePending.includes(initial.agentIssue.role);
  const next = patchProjectAgentSession(projectId, {
    ...(issueResolved ? { agentIssue: undefined } : {}),
    agentReconfiguration: errors.length > 0
      ? {
          ...reconfiguration,
          status: 'failed',
          pendingRoles: uniquePending,
          completedRoles: uniqueCompleted,
          error: errors.join('；'),
        }
      : uniquePending.length > 0
        ? {
            ...reconfiguration,
            status: 'pending-safe-point',
            pendingRoles: uniquePending,
            completedRoles: uniqueCompleted,
            error: undefined,
          }
        : undefined,
  });
  if (uniqueCompleted.length > reconfiguration.completedRoles.length && next) {
    await appendRecordedProjectEvent(next, {
      kind: 'project-agent-runtime-switched',
      summary: `项目运行时已按新配置完成安全换代：${uniqueCompleted.join('、')}`,
      payload: {
        roles: uniqueCompleted,
        pendingRoles: uniquePending,
        resolvedAttentionKinds: ['project-agent-limit-detected'],
      },
    });
  }
  return { ok: errors.length === 0, pendingRoles: uniquePending, completedRoles: uniqueCompleted, errors };
}

function processProjectAgentReconfiguration(
  projectId: string,
  safeSurfaceId?: string,
): Promise<ProjectAgentReconfigurationResult> {
  const existing = projectAgentReconfigurationRuns.get(projectId);
  if (existing) {
    return existing.then(() => processProjectAgentReconfiguration(projectId, safeSurfaceId));
  }
  const run = processProjectAgentReconfigurationNow(projectId, safeSurfaceId).finally(() => {
    if (projectAgentReconfigurationRuns.get(projectId) === run) {
      projectAgentReconfigurationRuns.delete(projectId);
    }
  });
  projectAgentReconfigurationRuns.set(projectId, run);
  return run;
}

async function requireProjectRequirementsAlignment(
  sessionId: string,
  reason: string,
  runtimeCreated = false,
  forceNewRequirement = false,
): Promise<ProjectManagerSession | undefined> {
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session || ['completed', 'stopped'].includes(session.status)) return session;
  if (forceNewRequirement || !projectRequirementsAlignmentPending(session)) {
    const result = store.applyProjectManagerAction({ type: 'require-requirements-alignment', reason }, session.id);
    if (!result.ok) return session;
    for (const laneId of projectSupervisorLaneIds(session)) {
      store.pauseSupervisorLane(laneId, '项目启动或恢复后必须重新核对需求充分性');
    }
    await persistProjectManagerMutation(result, session.id);
  }
  scheduleProjectAlignmentFallback(session.id, runtimeCreated);
  return useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
}

async function ensureProjectRequirementAlignment(
  sessionId: string,
  trigger: string,
  runtimeCreated = false,
  forceQuestion = false,
): Promise<{ triggered: boolean; alignmentRequired?: boolean; awaitingDefinitionUpdate?: boolean; session?: ProjectManagerSession; question?: ProjectManagerUserQuestion; error?: string }> {
  const store = useStore.getState();
  const session = store.projectManagers.find((candidate) => candidate.id === sessionId);
  if (!session || ['completed', 'stopped'].includes(session.status)) return { triggered: false, session };
  const alignmentRequired = projectRequirementsAlignmentPending(session);
  const alignmentState = projectRequirementAlignmentState(session);
  if ((!alignmentRequired && !forceQuestion) || session.pendingUserQuestion) {
    return { triggered: false, session };
  }
  if (alignmentState === 'needs-definition-update') {
    deliverProjectManagerMessage([
      '[需求对齐门禁｜用户已答复但项目定义尚未更新]',
      `项目：${session.id} · ${session.projectDir}`,
      `禁止直接恢复。请先根据用户答复执行 wmux project update --project ${session.id}，补全目标、范围和可验证完成条件；仍有关键歧义时再发起下一轮结构化提问。`,
    ].join('\n'), runtimeCreated, session.id);
    return { triggered: false, awaitingDefinitionUpdate: true, session };
  }
  if (alignmentRequired && alignmentState === 'sufficient' && !forceQuestion) {
    deliverProjectManagerMessage([
      '[强制需求充分性判定]',
      `项目：${session.id} · ${session.projectDir}`,
      `用户已经结构化确认当前目标、范围、前置条件和验收标准。请从 project status 读取这次 user-clarification-answered 事件 ID，并执行 wmux project alignment-confirm --project ${session.id}，携带 userConfirmationEventId、目标理解、范围、验收标准和理由。未提交结论前控制层不会创建工作项、派遣监督或恢复项目。`,
    ].join('\n'), runtimeCreated, session.id);
    return { triggered: false, alignmentRequired: true, session };
  }
  const normalized = normalizeProjectManagerUserQuestion(
    projectAlignmentQuestionInput(session),
    session.status,
  );
  if (!normalized.question) return { triggered: false, session, error: normalized.error };
  const result = store.applyProjectManagerAction({
    type: 'request-user-clarification',
    question: normalized.question,
  }, session.id);
  if (!result.ok) return { triggered: false, session, error: result.error };
  for (const laneId of projectSupervisorLaneIds(session)) {
    store.pauseSupervisorLane(laneId, '项目需求尚未充分对齐，等待用户选择推荐方案');
  }
  const timer = projectProgressTimers.get(session.id);
  if (timer) globalThis.clearTimeout(timer);
  projectProgressTimers.delete(session.id);
  const alignmentTimer = projectAlignmentTimers.get(session.id);
  if (alignmentTimer) globalThis.clearTimeout(alignmentTimer);
  projectAlignmentTimers.delete(session.id);
  notifyProjectManagerUserQuestion(session, normalized.question);
  await persistProjectManagerMutation(result, session.id);
  const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  deliverProjectManagerMessage([
    '[需求对齐门禁已由控制层执行]',
    `项目：${session.id} · ${session.projectDir}`,
    `触发原因：${trigger}`,
    `已向桌面项目对话和飞书发送带推荐项的问题：${normalized.question.question}`,
    '用户答复前不得恢复、创建工作项或派遣监督 AI。收到答复后先写回项目定义；仍有关键歧义时继续下一轮结构化提问。',
  ].join('\n'), runtimeCreated, session.id);
  return { triggered: true, session: updated, question: normalized.question };
}

async function appendRecordedProjectEvent(
  session: ProjectManagerSession,
  event: {
    kind: ProjectManagerEventKind;
    summary: string;
    workItemId?: string;
    payload?: Record<string, unknown>;
  },
  options: { persistSession?: boolean } = {},
): Promise<void> {
  const created = useStore.getState().appendProjectManagerEvent(event, session.id);
  const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  if (created && projectManagerEventNeedsUserAttention(created)) {
    notifyProjectManagerAttention(updated || session, created);
  }
  if (options.persistSession !== false) {
    await (window as any).wmux?.projectManager?.saveSession?.(updated);
  }
  if (created) {
    await (window as any).wmux?.projectManager?.appendRecord?.({
      sessionId: session.id,
      projectDir: session.projectDir,
      type: created.kind,
      payload: { message: created.summary, ...(created.payload || {}) },
    });
  }
}

async function quiesceProjectRuntimeLanes(
  session: ProjectManagerSession,
  reason: string,
): Promise<{ confirmed: string[]; failed: string[] }> {
  const store = useStore.getState();
  const lanes = store.supervisor.lanes.filter((lane) => (
    lane.projectManagerProjectId === session.id
    && supervisorLaneControlState(lane) !== 'stopped'
  ));
  const confirmed: string[] = [];
  const failed: string[] = [];
  for (const lane of lanes) {
    // A requirement or prerequisite change revokes any delayed automatic Enter
    // before the control plane interrupts the old task.
    cancelPendingAutomatedTerminalSubmit(lane.surfaceId, true);
    store.pauseSupervisorLane(lane.id, reason);
    const terminal = locateRemoteTaskTerminal(lane.surfaceId).terminal;
    if (!terminal) {
      failed.push(lane.id);
      await appendRecordedProjectEvent(session, {
        kind: 'requirements-quiesce-failed',
        workItemId: lane.projectWorkItemId,
        summary: `需求变更时无法定位任务终端，未能确认旧任务已停止：${lane.label}`,
        payload: { laneId: lane.id, surfaceId: lane.surfaceId, reason },
      });
      continue;
    }
    const activityBeforeInterrupt = remoteTerminalActivity(lane.surfaceId).activityState;
    if (activityBeforeInterrupt === 'idle' || activityBeforeInterrupt === 'blocked') {
      confirmed.push(lane.id);
      await appendRecordedProjectEvent(session, {
        kind: 'requirements-quiesced',
        workItemId: lane.projectWorkItemId,
        summary: `需求变更时任务终端已处于非运行状态，未发送 Ctrl+C：${lane.label}`,
        payload: { laneId: lane.id, surfaceId: lane.surfaceId, reason, activity: activityBeforeInterrupt },
      });
      continue;
    }
    if (activityBeforeInterrupt !== 'working') {
      failed.push(lane.id);
      await appendRecordedProjectEvent(session, {
        kind: 'requirements-quiesce-failed',
        workItemId: lane.projectWorkItemId,
        summary: `任务终端运行状态不明，为避免退出 Agent 未盲发 Ctrl+C：${lane.label}`,
        payload: { laneId: lane.id, surfaceId: lane.surfaceId, reason, activity: activityBeforeInterrupt },
      });
      continue;
    }
    const pty = (window as any).wmux?.pty;
    let accepted = false;
    try {
      if (pty?.has && !await pty.has(lane.surfaceId)) {
        accepted = false;
      } else if (pty?.writeReliable) {
        accepted = await pty.writeReliable(lane.surfaceId, '\x03');
      } else if (pty?.write) {
        pty.write(lane.surfaceId, '\x03');
        accepted = true;
      }
    } catch {
      accepted = false;
    }
    if (accepted) {
      let activity = remoteTerminalActivity(lane.surfaceId).activityState;
      if (activity === 'working') {
        for (let attempt = 0; attempt < 20 && activity === 'working'; attempt += 1) {
          await waitForControlPlaneDelay(100);
          activity = remoteTerminalActivity(lane.surfaceId).activityState;
        }
      }
      // A reliable Ctrl+C write proves delivery, not quiescence. Unknown or
      // stale activity must keep the project paused for user intervention.
      accepted = activity === 'idle' || activity === 'blocked';
    }
    if (accepted) {
      confirmed.push(lane.id);
      await appendRecordedProjectEvent(session, {
        kind: 'requirements-quiesced',
        workItemId: lane.projectWorkItemId,
        summary: `已暂停监督并确认中断旧任务：${lane.label}`,
        payload: { laneId: lane.id, surfaceId: lane.surfaceId, reason },
      });
    } else {
      failed.push(lane.id);
      await appendRecordedProjectEvent(session, {
        kind: 'requirements-quiesce-failed',
        workItemId: lane.projectWorkItemId,
        summary: `任务终端未确认中断，项目保持暂停：${lane.label}`,
        payload: { laneId: lane.id, surfaceId: lane.surfaceId, reason },
      });
    }
  }
  return { confirmed, failed };
}

async function updateProjectDefinition(
  session: ProjectManagerSession,
  params: any,
  source: 'user' | 'manager',
): Promise<any> {
  if (['completed', 'stopped'].includes(session.status)) {
    return { ok: false, error: '已完成或停止的项目不能修改目标和需求' };
  }
  if (session.pendingUserQuestion && source === 'manager') {
    return { ok: false, error: '项目仍有待答问题，请先在桌面或飞书完成当前需求确认' };
  }
  if (params?.mode !== undefined && !['refine', 'pivot'].includes(params.mode)) {
    return { ok: false, error: '主目标变更模式必须是 refine（调整当前目标）或 pivot（切换新目标）' };
  }
  const mode = params?.mode === 'pivot' ? 'pivot' : 'refine';
  const goal = params?.goal === undefined ? session.goal : String(params.goal || '').trim();
  const userGoalDraft = source === 'user' && (mode === 'pivot' || goal !== session.goal);
  const preconditions = params?.preconditions === undefined
    ? session.preconditions
    : projectStringArray(params.preconditions);
  const supervisorNotes = params?.supervisorNotes === undefined
    ? session.supervisorNotes || []
    : projectStringArray(params.supervisorNotes).slice(0, 20).map((note) => note.slice(0, 4000));
  const doneWhen = params?.doneWhen === undefined
    ? userGoalDraft ? [] : session.doneWhen
    : projectStringArray(params.doneWhen);
  if (params?.userAcceptancePolicy !== undefined
    && !PROJECT_USER_ACCEPTANCE_POLICIES.includes(String(params.userAcceptancePolicy) as ProjectUserAcceptancePolicy)) {
    return { ok: false, error: 'userAcceptancePolicy 必须是 always、on-gap 或 not-required' };
  }
  const activeGoal = activeProjectGoal(session);
  const userAcceptancePolicy = params?.userAcceptancePolicy === undefined
    ? mode === 'pivot' ? 'on-gap' : projectGoalUserAcceptancePolicy(activeGoal)
    : normalizeProjectUserAcceptancePolicy(params.userAcceptancePolicy);
  const verificationInput = projectVerificationPoliciesInput(
    params?.verificationPolicies,
    doneWhen,
    mode === 'pivot' ? [] : projectGoalVerificationPolicies(activeGoal),
  );
  if (!verificationInput.policies) return { ok: false, error: verificationInput.error || '验证策略无效' };
  const verificationPolicies = verificationInput.policies;
  const planFiles = params?.planFiles === undefined
    ? session.planFiles
    : projectPlanFileSnapshots(params.planFiles);
  if (params?.planFiles !== undefined && (
    !Array.isArray(params.planFiles) || planFiles.length !== params.planFiles.length
  )) {
    return { ok: false, error: `计划文件格式无效、不可访问或超过 ${MAX_PROJECT_PLAN_FILES} 个` };
  }
  if (!goal) return { ok: false, error: '项目目标不能为空' };
  if (source === 'manager' && !projectManagerGoalChangeHasUserBasis(session, goal)) {
    return { ok: false, error: '当前主目标由用户提供；没有新的用户目标变更或澄清答复时，项目 AI 只能补全前置条件、完成条件和阶段计划，不能改写主目标' };
  }
  if (doneWhen.length === 0 && !userGoalDraft) return { ok: false, error: '项目完成条件不能为空' };
  const unchanged = goal === session.goal
    && JSON.stringify(preconditions) === JSON.stringify(session.preconditions)
    && JSON.stringify(supervisorNotes) === JSON.stringify(session.supervisorNotes || [])
    && JSON.stringify(doneWhen) === JSON.stringify(session.doneWhen)
    && userAcceptancePolicy === projectGoalUserAcceptancePolicy(activeGoal)
    && JSON.stringify(verificationPolicies) === JSON.stringify(projectGoalVerificationPolicies(activeGoal))
    && JSON.stringify(planFiles) === JSON.stringify(session.planFiles);
  if (unchanged && mode === 'refine') return { ok: false, error: '当前主目标和需求没有发生变化' };

  const reason = String(params?.reason || '').trim().slice(0, 2000)
    || `${source === 'user' ? '用户通过项目配置' : '项目 AI 根据用户对话'}${mode === 'pivot' ? '切换新的主目标' : '调整当前主目标'}`;
  const userConfirmationEventId = String(params?.userConfirmationEventId || '').trim();
  const store = useStore.getState();
  const quiesce = await quiesceProjectRuntimeLanes(
    session,
    mode === 'pivot'
      ? '用户切换新的主目标，撤销旧目标运行授权并等待项目 AI 建立新阶段计划'
      : '当前主目标要求已调整，暂停当前执行链并等待项目 AI 评估影响',
  );
  const result = store.applyProjectManagerAction({
    type: 'update-project-definition',
    goal,
    preconditions,
    supervisorNotes,
    planFiles,
    doneWhen,
    userAcceptancePolicy,
    verificationPolicies,
    reason,
    ...(userConfirmationEventId ? { userConfirmationEventId } : {}),
    source,
    mode,
  }, session.id);
  if (!result.ok) return result;
  const alignmentResult = store.applyProjectManagerAction({
    type: 'require-requirements-alignment',
    reason: mode === 'pivot'
      ? '主目标已切换，需要按新目标重新确认需求、范围和验收充分性'
      : '目标或需求已调整，需要按新版本重新确认需求、范围和验收充分性',
    ...(userConfirmationEventId ? { userConfirmationEventId } : {}),
  }, session.id);
  if (!alignmentResult.ok) return alignmentResult;
  for (const laneId of projectSupervisorLaneIds(session)) {
    store.pauseSupervisorLane(laneId, mode === 'pivot'
      ? '旧主目标已被替代，等待项目 AI 建立新目标执行链'
      : '当前主目标要求已调整，等待项目 AI 重新绑定任务版本');
  }
  const timer = projectProgressTimers.get(session.id);
  if (timer) globalThis.clearTimeout(timer);
  projectProgressTimers.delete(session.id);
  await persistProjectManagerMutation(result, session.id);
  const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  if (source === 'user') {
    queueProjectManagerDelivery([
      `[用户${mode === 'pivot' ? '切换新的主目标' : '调整当前主目标'}｜必须完成影响评估后回复用户]`,
      `项目：${session.id} · ${session.projectDir}`,
      `稳定项目范围：${session.projectScope || '仅当前项目目录'}`,
      `原主目标 ID：${activeProjectGoal(session).id}`,
      `原目标：${session.goal}`,
      `新目标：${goal}`,
      '用户提供的新主目标是当前权威目标。项目 AI 不得另换目标；主要职责是根据目标、项目目录事实和用户已确认约束，补全必要前置条件、可验证完成条件、阶段计划与工作项合同。',
      `变更模式：${mode === 'pivot' ? '切换新的主目标；旧目标进入历史且禁止继续派发' : '调整当前主目标；只允许显式复核后重绑任务版本'}`,
      `新前置条件：${preconditions.length > 0 ? preconditions.join('；') : '未填写；由项目 AI 判断并起草，存在实质歧义时再询问用户'}`,
      `监督注意事项：${supervisorNotes.length > 0 ? supervisorNotes.join('；') : '无'}`,
      `新完成条件：${doneWhen.length > 0 ? doneWhen.join('；') : '未填写；由项目 AI 起草具体、可验证的完成条件'}`,
      `用户最终验收策略：${userAcceptancePolicy}`,
      `逐项验证策略：${verificationPolicies.map((policy) => `${policy.criterion}=${policy.riskClass || 'protected'}/${policy.requirement}`).join('；') || '无'}`,
      `计划文件：${planFiles.length > 0 ? planFiles.map((file) => file.name).join('、') : '无'}`,
      `用户说明：${reason}`,
      preconditions.length === 0 || doneWhen.length === 0
        ? `当前目标定义仍有待补全项。先基于用户主目标起草条件并执行 wmux project update --project ${session.id} 写回；定义完整前不得提交 alignment-confirm。只有实质歧义才向用户提问。`
        : '用户已提供条件仍需做一致性检查，但不得为了改写措辞而改变用户主目标或反复询问。',
      '',
      mode === 'pivot'
        ? `旧目标未完成任务已经停止，完成成果仍保留为证据。先重新提交 alignment-confirm 和 orientation-confirm，再执行 wmux project goal-plan --project ${session.id} 建立新目标的 3-7 个阶段目标；不得把旧任务跨 goalId 复活。`
        : `检查现有任务与调整后的目标是否兼容；继续使用的任务必须通过 task-update 设置 rebindCurrentRequirements=true，过期任务应停止。重新提交 alignment-confirm 和 orientation-confirm 后，阶段计划变化时再执行 wmux project goal-plan --project ${session.id}。`,
      `完成影响评估和阶段计划后，执行 wmux project reply --project ${session.id} --message "<变更影响和新计划>" 回复用户，再显式执行 wmux project resume --project ${session.id}。除用户业务选择、越界或硬风险外，不得逐项向用户申请确认。`,
    ].join('\n'), session.id);
  }
  return {
    ok: true,
    event: result.event,
    session: updated,
    message: source === 'user'
      ? quiesce.failed.length > 0
        ? '主目标变更已记录；监督链保持暂停，但部分任务终端未确认中断，已通知用户处理。'
        : '主目标变更已记录；旧运行已中断，项目 AI 将补全必要条件并完成影响评估和阶段规划。'
      : quiesce.failed.length > 0
        ? '主目标要求已写入；部分旧任务未确认中断，项目保持暂停并已上报用户。'
        : '主目标要求已写入且旧运行已中断；请完成阶段规划和任务重绑后显式恢复。',
  };
}

function manualVerificationFeedbackQuestion(
  session: ProjectManagerSession,
  pending: ProjectManagerUserQuestion,
): { question?: ProjectManagerUserQuestion; error?: string } {
  const workItem = pending.workItemId
    ? session.workItems.find((item) => item.id === pending.workItemId)
    : undefined;
  const limitation = workItem ? currentProjectVerificationLimitation(session, workItem) : undefined;
  const missingEvidence = limitation?.missingEvidence.length
    ? limitation.missingEvidence.slice(0, 6)
    : [pending.blocker || workItem?.latestBlocker || '当前 GUI 核心交互仍缺少人工验收结果'];
  const affectedAcceptance = limitation?.affectedAcceptance.slice(0, 8) || [];
  return normalizeProjectManagerUserQuestion({
    category: 'manual-intervention',
    workItemId: pending.workItemId,
    blocker: pending.blocker || workItem?.latestBlocker,
    reasonCode: 'verification-limited',
    question: [
      '请在项目 GUI 中完成一次人工验收并反馈结果。',
      `需要核验：${missingEvidence.join('；')}`,
    ].join(' '),
    context: [
      `当前任务：${workItem?.title || pending.workItemId || '当前验证工作项'}`,
      workItem?.latestContextSummary ? `当前进展：${workItem.latestContextSummary}` : '',
      workItem?.latestEvidence ? `已有证据：${workItem.latestEvidence}` : '',
      affectedAcceptance.length > 0 ? `受影响验收：${affectedAcceptance.join('；')}` : '',
      '人工验收操作说明：',
      '1. 启动或保持当前 GUI，先确认窗口、已有数据和初始状态与预期一致。',
      '2. 按“需要核验”逐项执行真实操作；涉及编辑时记录修改前后值，涉及删除时确认界面与数据状态都已移除。',
      '3. 涉及保存、Reload 或重启时，完成操作后重新加载或重新启动，并核对最终持久化结果。',
      '4. 在补充框逐项填写“成功 / 失败 / 未执行”，失败时附实际现象；不要只填写“已验证”或选项名称。',
      '提交人工结果前项目、监督 AI 和任务 AI 都保持等待，不会重新执行自动 GUI 验证。',
    ].filter(Boolean).join('\n'),
    options: [
      {
        id: 'manual-verify-complete',
        label: '完成人工验收',
        description: '完成上述操作后，在补充框逐项填写实际成功项、失败项或异常现象；项目 AI 只依据你提交的结果继续判断。',
      },
      {
        id: 'manual-verify-defer',
        label: '暂缓人工验收',
        description: '保留所有未验证项，当前阶段不判定完成；项目保持暂停，后续再由用户安排人工验收。',
      },
    ],
    recommendedOptionId: 'manual-verify-complete',
  }, 'waiting');
}

async function answerProjectManagerUserQuestion(params: any): Promise<any> {
  const session = projectSessionForParams(params);
  const pending = session?.pendingUserQuestion;
  if (!session || !pending) return { ok: false, error: '当前项目没有待用户确认的问题' };
  const questionId = String(params?.questionId || '').trim();
  if (questionId && questionId !== pending.id) return { ok: false, error: '该问题已经失效，请刷新项目状态' };
  const optionId = String(params?.optionId || '').trim() || undefined;
  const option = optionId ? pending.options.find((candidate) => candidate.id === optionId) : undefined;
  if (optionId && !option) return { ok: false, error: '所选答复选项不存在' };
  const detail = String(params?.answer || '').trim().slice(0, 5000);
  const optionLabelOnly = !!option && (!detail || detail === option.label);
  const answeredBy = params?.source === 'feishu' || params?.answeredBy === 'feishu' ? 'feishu' : 'desktop';
  if (pending.category === 'manual-intervention'
    && pending.reasonCode === 'verification-limited'
    && optionId === 'manual-verify') {
    const followUp = manualVerificationFeedbackQuestion(session, pending);
    if (!followUp.question) {
      return { ok: false, error: followUp.error || '无法生成人工验收反馈问题' };
    }
    const refined = useStore.getState().applyProjectManagerAction({
      type: 'refine-user-clarification',
      questionId: pending.id,
      question: followUp.question,
      selectedOptionId: optionId,
    }, session.id);
    if (!refined.ok) return refined;
    await persistProjectManagerMutation(refined, session.id);
    const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
    return {
      ok: true,
      event: refined.event,
      session: updated,
      question: followUp.question,
      message: '项目已进入人工验收等待；提交实际结果或选择暂缓前，不会恢复监督或任务 AI。',
    };
  }
  if (pending.category === 'manual-intervention'
    && pending.reasonCode === 'verification-limited'
    && optionId === 'manual-verify-complete'
    && optionLabelOnly) {
    return { ok: false, error: '确认完成人工验收前，请在补充框逐项填写实际成功项、失败项或异常现象' };
  }
  const answer = option
    ? detail && detail !== option.label ? `${option.label}：${detail}` : option.label
    : detail;
  if (!answer) return { ok: false, error: '请选择一个选项或填写答复' };
  const reuseForSimilar = params?.reuseForSimilar === true;
  if (
    optionId === 'draft-handled'
    && pending.category === 'manual-intervention'
    && pending.reasonCode === 'task-input-conflict'
    && pending.workItemId
  ) {
    const lane = useStore.getState().supervisor.lanes.find((candidate) => (
      candidate.projectManagerProjectId === session.id
      && candidate.projectWorkItemId === pending.workItemId
      && supervisorLaneControlState(candidate) !== 'stopped'
    ));
    if (lane && projectTaskInputDraftStillPending(lane)) {
      return { ok: false, error: '任务终端输入框仍有未提交内容；请先提交或清空原草稿，再确认已处理' };
    }
  }
  const store = useStore.getState();
  const result = store.applyProjectManagerAction({
    type: 'answer-user-clarification',
    questionId: pending.id,
    answer,
    optionId,
    answeredBy,
    reuseForSimilar,
  }, session.id);
  if (!result.ok) return result;
  let updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  const manualVerificationDeferredBeforePersist = pending.category === 'manual-intervention'
    && pending.reasonCode === 'verification-limited'
    && optionId === 'manual-verify-defer';
  if (manualVerificationDeferredBeforePersist && updated) {
    for (const laneId of projectSupervisorLaneIds(updated)) {
      store.pauseSupervisorLane(laneId, '用户选择暂缓人工验收');
    }
    const progressTimer = projectProgressTimers.get(session.id);
    if (progressTimer) globalThis.clearTimeout(progressTimer);
    projectProgressTimers.delete(session.id);
    const deadlockTimer = projectDeadlockRetryTimers.get(session.id);
    if (deadlockTimer) globalThis.clearTimeout(deadlockTimer);
    projectDeadlockRetryTimers.delete(session.id);
  }
  await persistProjectManagerMutation(result, session.id);
  let choiceMessage = '';
  const taskInputConflictChoice = pending.category === 'manual-intervention'
    && pending.reasonCode === 'task-input-conflict';
  const runtimeRecoveryChoice = pending.category === 'manual-intervention'
    && pending.reasonCode === 'runtime-recovery';
  const verificationLimitedChoice = pending.category === 'manual-intervention'
    && pending.reasonCode === 'verification-limited'
    && [
      'manual-verify',
      'manual-verify-complete',
      'manual-verify-defer',
      'alternative-validation',
      'defer-verification',
      'skip-verification',
      'keep-paused',
    ].includes(optionId || '');
  const finalAcceptanceChoice = pending.category === 'manual-intervention'
    && pending.reasonCode === 'final-acceptance';
  if ((taskInputConflictChoice || runtimeRecoveryChoice || verificationLimitedChoice)
    && ['keep-paused', 'manual-verify-defer'].includes(optionId || '') && updated) {
    const manualVerificationDeferred = optionId === 'manual-verify-defer';
    if (manualVerificationDeferred && updated.status === 'paused') {
      choiceMessage = '人工验收已暂缓，项目保持 paused；控制层不会恢复监督或任务 AI。';
    } else {
      const paused = store.applyProjectManagerAction({
        type: 'pause-project',
        reason: '用户选择保持当前项目暂停',
        source: 'system',
        attentionRequired: false,
      }, session.id);
      if (paused.ok) {
        for (const laneId of projectSupervisorLaneIds(updated)) {
          store.pauseSupervisorLane(laneId, '用户选择保持项目暂停');
        }
        await persistProjectManagerMutation(paused, session.id);
        updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
        choiceMessage = '项目已进入 paused，控制层不会继续自动恢复或重复询问。';
      }
    }
  } else if ((taskInputConflictChoice || runtimeRecoveryChoice)
    && optionId === 'stop-work-item' && pending.workItemId && updated) {
    const workItem = updated.workItems.find((candidate) => candidate.id === pending.workItemId);
    const targetLanes = useStore.getState().supervisor.lanes.filter((lane) => (
      lane.projectManagerProjectId === session.id && lane.projectWorkItemId === pending.workItemId
    ));
    const workerSurfaceIds = new Set<string>(targetLanes.map((lane) => lane.surfaceId).filter(Boolean));
    if (workItem?.workerSurfaceId) workerSurfaceIds.add(workItem.workerSurfaceId);
    const intervened = store.applyProjectManagerAction({
      type: 'intervene-work-item',
      workItemId: pending.workItemId,
      intervention: 'close',
      reason: '用户在项目异常恢复问题中选择停止该工作项',
    }, session.id);
    if (intervened.ok) {
      closeStoppedSupervisorSurfaces(targetLanes);
      for (const lane of targetLanes) store.stopSupervisorLane(lane.id, '用户选择停止当前工作项');
      for (const surfaceId of workerSurfaceIds) closeLiveSurfaceById(surfaceId as SurfaceId);
      await persistProjectManagerMutation(intervened, session.id);
      updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
      queueProjectManagerDelivery([
        '[用户已停止异常工作项｜项目 AI 重新规划剩余目标]',
        `项目：${session.id}；工作项：${pending.workItemId}`,
        '原工作项和监督/任务绑定已停止，不得以同一工作项 ID 恢复。立即读取 project status，重排依赖并为仍需完成的阶段建立新的聚焦工作项；只有主目标因此无法达成时才再次询问用户。',
      ].join('\n'), session.id, { priority: true, dedupeKey: `user-stopped-work-item:${session.id}:${pending.workItemId}` });
      choiceMessage = '该工作项及其监督/任务绑定已停止，项目 AI 将重新规划剩余目标。';
    }
  } else if (runtimeRecoveryChoice && optionId === 'recover-latest-protocol' && updated) {
    const runtimePromise = ensureProjectManagerRuntime(session.id, { forceRestart: true });
    queueProjectManagerDelivery([
      '[用户已选择按最新协议恢复｜先核对再继续]',
      `项目：${session.id}${pending.workItemId ? `；工作项：${pending.workItemId}` : ''}`,
      `原异常：${pending.blocker || pending.context || pending.question}`,
      '项目 AI 运行时将由控制层重建。立即读取 project status 和当前证据，重建必要监督绑定；只有确认当前工作项仍有效时才显式恢复，不得重复已完成工作或回退旧协议。',
    ].join('\n'), session.id, {
      priority: true,
      dedupeKey: `user-runtime-recovery:${session.id}:${pending.id}`,
    });
    const runtime = await runtimePromise;
    if (!runtime.ok) {
      const reason = runtime.error || '项目 AI 运行时仍无法按最新协议重建';
      await reportProjectRuntimeFailureForUserDecision(
        session.id,
        'manager-runtime-failed',
        reason,
        pending.workItemId,
      );
      updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || updated;
      choiceMessage = '项目 AI 运行时再次重建失败，已保留当前成果并重新显示处理选项。';
    } else {
      choiceMessage = '项目 AI 运行时已重建，恢复指令已持久排队；项目保持等待，待项目 AI 核对后继续。';
    }
  } else if (verificationLimitedChoice && optionId === 'alternative-validation' && updated) {
    queueProjectManagerDelivery([
      '[用户选择替代验证｜只允许一次不同路线]',
      `项目：${session.id}${pending.workItemId ? `；工作项：${pending.workItemId}` : ''}`,
      `受限原因：${pending.blocker || pending.context || pending.question}`,
      '保留当前实现与未验证结论，只安排一轮明显不同于失败路线的基础测试、逻辑测试、静态检查或最小可复核证据。不得再次调用原 GUI 自动化路径；若仍不能形成新证据，必须重新询问用户人工验收、暂缓验证、跳过当前验证并后续重排，或保持暂停。',
    ].join('\n'), session.id, {
      priority: true,
      dedupeKey: `user-alternative-validation:${session.id}:${pending.id}`,
    });
    choiceMessage = '替代验证已授权一次并交给项目 AI；项目保持等待，核对新路线后再继续。';
  } else if (verificationLimitedChoice && optionId === 'defer-verification' && updated) {
    queueProjectManagerDelivery([
      '[用户明确授权暂缓验证｜继续后续工作]',
      `项目：${session.id}${pending.workItemId ? `；工作项：${pending.workItemId}` : ''}`,
      `未验证原因：${pending.blocker || pending.context || pending.question}`,
      '用户只授权暂缓当前验证环节。不得把未验证项标记 satisfied、不得将对应阶段标记 achieved，也不得据此完成主目标；停止恢复或重派同一验证工作项，保留缺口并创建下一个不同成果的工作项。最终完成前仍需补验，或由用户另行调整验收要求。',
    ].join('\n'), session.id, {
      priority: true,
      dedupeKey: `user-deferred-verification:${session.id}:${pending.id}`,
    });
    choiceMessage = '已记录用户对当前验证的暂缓授权；项目 AI 可规划后续不同成果，但未验证项仍会阻止阶段和项目完成。';
  } else if (verificationLimitedChoice && optionId === 'skip-verification'
    && pending.workItemId && updated) {
    const skippedWorkItem = session.workItems.find((candidate) => candidate.id === pending.workItemId);
    const retainedLanes = releaseProjectWorkItemAssignmentForReuse(
      updated,
      pending.workItemId,
      '用户选择跳过当前验证工作项；旧 assignment 已解除，项目任务 AI 与监督 AI 保留供后续工作项复用',
    );
    await appendRecordedProjectEvent(updated, {
      kind: 'user-work-item-intervention',
      workItemId: pending.workItemId,
      summary: `用户跳过工作项：${pending.workItemId}；理由：当前验证后续由新计划重新承接`,
      payload: {
        intervention: 'skip',
        reason: '用户选择跳过当前验证工作项，后续由新计划重新承接未验证项',
        previousStatus: skippedWorkItem?.status,
        title: skippedWorkItem?.title,
        retainedLaneIds: retainedLanes.map((lane) => lane.id),
        runtimeRetained: retainedLanes.length > 0,
        attentionRequired: false,
      },
    });
    updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
    queueProjectManagerDelivery([
      '[用户已跳过当前验证｜后续计划必须重新承接]',
      `项目：${session.id}；工作项：${pending.workItemId}`,
      `保留的未验证项：${pending.blocker || pending.context || pending.question}`,
      '当前验证工作项已停止，旧 assignment 已解除；项目任务 AI 与监督 AI 运行时仍保留。不得恢复原工作项或把缺口写成 satisfied。立即继续其他可执行成果；在最终完成前，为原阶段验收创建新的聚焦验证工作项并取得证据，或由用户正式修改验收要求。',
    ].join('\n'), session.id, {
      priority: true,
      dedupeKey: `user-skipped-verification:${session.id}:${pending.id}`,
    });
    choiceMessage = '已跳过当前验证工作项并保留验收缺口；项目常驻任务与监督运行时已保留，项目 AI 将继续其他成果并在后续新计划中补验。';
  } else if (finalAcceptanceChoice && optionId === 'accept-current-result' && updated) {
    const requiresFinalUserAcceptance = projectGoalUserAcceptancePolicy(activeProjectGoal(updated)) === 'always';
    queueProjectManagerDelivery([
      requiresFinalUserAcceptance
        ? '[用户完成最终验收｜允许完成主目标]'
        : '[用户最终接受当前效果｜允许带验证缺口完成主目标]',
      `项目：${session.id}；用户答复事件：${result.event?.id || '缺失'}`,
      `用户答复：${answer}`,
      requiresFinalUserAcceptance
        ? '用户已经完成当前策略要求的最终验收；仍须保持既有实现与验证证据不变。'
        : '用户只接受当前最终效果；不得把缺失验证改写成自动测试通过，也不得覆盖已知失败、安全问题或未完成实现。',
      requiresFinalUserAcceptance
        ? `立即沿用已经通过门禁的完整完成 JSON，并加入 userAcceptanceEventId="${result.event?.id || ''}"，再次执行 wmux project complete --project ${session.id} --json-file <file>；不得省略或改写既有逐项验证声明。`
        : `立即将完成 JSON 写入项目 .wmux/tmp/，执行 wmux project complete --project ${session.id} --json-file <file>；JSON 必须包含 userAcceptanceEventId="${result.event?.id || ''}"，可省略原本无法形成的逐项自动验证声明。`,
    ].join('\n'), session.id, {
      priority: true,
      dedupeKey: `user-final-acceptance:${session.id}:${result.event?.id || pending.id}`,
    });
    choiceMessage = requiresFinalUserAcceptance
      ? '已记录用户最终验收；项目 AI 可以提交当前主目标完成。'
      : '已记录你对当前最终效果的接受；项目 AI 可保留验证缺口并完成当前主目标。';
  } else if (finalAcceptanceChoice && optionId === 'continue-validation' && updated) {
    const requiresFinalUserAcceptance = projectGoalUserAcceptancePolicy(activeProjectGoal(updated)) === 'always';
    if (requiresFinalUserAcceptance) {
      const paused = store.applyProjectManagerAction({
        type: 'pause-project',
        reason: '用户暂不进行当前主目标的最终验收',
        source: 'system',
        attentionRequired: false,
      }, session.id);
      if (paused.ok) {
        await persistProjectManagerMutation(paused, session.id);
        updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || updated;
      }
    }
    queueProjectManagerDelivery([
      requiresFinalUserAcceptance
        ? '[用户暂不进行最终验收｜项目保持等待]'
        : '[用户要求继续补验｜不得以当前效果直接完成]',
      `项目：${session.id}`,
      requiresFinalUserAcceptance
        ? '保留全部实现与验证证据，不得重复派发已经完成的工作；项目保持等待，直到用户再次决定是否最终验收。'
        : '保留当前成果和全部验证缺口，读取 project status，为未验证项恢复或创建聚焦补验工作项；不得重复已经确认不可用的同一验证路线。',
    ].join('\n'), session.id, { priority: true, dedupeKey: `user-continue-validation:${session.id}:${pending.id}` });
    choiceMessage = requiresFinalUserAcceptance
      ? '已保留当前成果和验证记录；项目等待用户以后进行最终验收。'
      : '已保留当前成果并要求继续补验；项目尚未完成。';
  } else if (taskInputConflictChoice && optionId === 'draft-handled' && updated) {
    const canResumeOriginalChain = pending.previousStatus === 'active'
      && updated.status === 'waiting'
      && updated.pausedByPortfolio !== true
      && projectAcceptedRequirementsVersion(updated) === projectRequirementsVersion(updated)
      && projectOrientationReady(updated)
      && updated.progressSync?.status !== 'review-required';
    if (canResumeOriginalChain) {
      const resumed = store.applyProjectManagerAction({
        type: 'resume-project',
        reason: '用户已处理任务终端输入框，恢复原项目执行链',
        source: 'project',
      }, session.id);
      if (resumed.ok) {
        resumeEligibleProjectSupervisorLanes(session.id, '用户已处理任务终端输入框');
        await persistProjectManagerMutation(resumed, session.id);
        updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
        queueProjectManagerDelivery([
          '[用户已处理任务终端草稿｜重新核对后恢复同一执行链]',
          `项目：${session.id}；工作项：${pending.workItemId || '未绑定'}`,
          '控制层已确认任务输入区不再被原草稿占用并恢复项目。读取 project status 和任务终端现状，只重投尚未确认接收的当前成果，不得重复已完成步骤。',
        ].join('\n'), session.id, { priority: true, dedupeKey: `task-draft-handled:${session.id}:${pending.workItemId || pending.id}` });
        choiceMessage = '任务终端草稿阻塞已解除，原执行链已恢复。';
      }
    } else {
      await appendRecordedProjectEvent(updated, {
        kind: 'project-recovery-requested',
        workItemId: pending.workItemId,
        summary: '任务终端草稿阻塞已解除，但项目存在更新后的暂停或治理门禁，保持当前状态',
        payload: {
          sourceQuestionId: pending.id,
          action: 'draft-handled',
          keptPaused: updated.status === 'paused' || updated.pausedByPortfolio === true,
          attentionRequired: false,
        },
      });
      updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || updated;
      choiceMessage = updated.status === 'paused'
        ? '任务终端草稿阻塞已解除；项目仍按后来施加的暂停决定保持暂停。'
        : '任务终端草稿阻塞已解除；项目仍受需求、认知基线或进度门禁约束，未自动恢复。';
    }
  }
  const handledTaskInputChoiceIds = new Set(['keep-paused', 'stop-work-item', 'draft-handled']);
  if (taskInputConflictChoice && optionId && handledTaskInputChoiceIds.has(optionId) && !choiceMessage) {
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || updated || session;
    await appendRecordedProjectEvent(current, {
      kind: 'project-recovery-requested',
      workItemId: pending.workItemId,
      summary: `用户选择“${option?.label || optionId}”后的直接状态迁移未能完成，已转为项目 AI 内部恢复义务`,
      payload: {
        sourceQuestionId: pending.id,
        action: optionId,
        transitionDeferred: true,
        attentionRequired: false,
        resolvedAttentionKinds: ['guard-triggered'],
      },
    });
    updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || current;
    queueProjectManagerDelivery([
      '[用户异常处理选择已记录｜不得重复询问]',
      `项目：${session.id}；选择：${option?.label || optionId}`,
      pending.workItemId ? `工作项：${pending.workItemId}` : '',
      '直接状态迁移因当前状态已经变化而未完成。读取 project status，忠实执行用户选择或确认它已被等价的新状态满足；不得重新创建同一用户问题。',
    ].filter(Boolean).join('\n'), session.id, {
      priority: true,
      dedupeKey: `deferred-user-recovery-choice:${session.id}:${pending.id}:${optionId}`,
    });
    choiceMessage = '用户选择已记录为项目内部恢复义务；控制层不会重复询问同一问题。';
  }
  if (!choiceMessage) {
    deliverProjectManagerMessage([
      '[用户澄清答复]',
      `项目：${session.id}`,
      `问题 ID：${pending.id}`,
      `问题：${pending.question}`,
      `答复：${answer}`,
      `渠道：${answeredBy === 'feishu' ? '飞书' : '桌面端'}`,
      reuseForSimilar
        ? '用户已授权：当前需求与授权版本内，decisionKey 相同的同类问题沿用本答复，由项目 AI 或监督 AI 自行决策，不再重复提问。'
        : '',
      `项目和监督仍保持等待。请先依据答复决定恢复、改线、继续等待或结束；只有选择继续时才执行 wmux project resume --project ${session.id}。不得扩张原项目范围。`,
    ].join('\n'), false, session.id);
  }
  return {
    ok: true,
    event: result.event,
    session: updated,
    message: choiceMessage || (reuseForSimilar
      ? '用户答复已提交并授权同类问题沿用；项目仍暂停等待项目 AI 决策。'
      : '用户答复已提交给项目管理 AI；项目仍暂停等待其决策。'),
  };
}

async function setProjectPortfolioPaused(paused: boolean, reason: string): Promise<{
  ok: true;
  affectedProjects: string[];
  blockedProjects: string[];
  message: string;
}> {
  const state = useStore.getState();
  const portfolioPaused = state.projectManagers.filter((session) => (
    session.status === 'paused' && session.pausedByPortfolio === true
  ));
  const definitionBlocked = paused ? [] : portfolioPaused.filter((session) => (
    !!session.pendingUserQuestion
    || projectRequirementsAlignmentPending(session)
    || projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)
  ));
  const progressBlocked: ProjectManagerSession[] = [];
  if (!paused) {
    const definitionBlockedIds = new Set(definitionBlocked.map((session) => session.id));
    for (const candidate of portfolioPaused.filter((session) => !definitionBlockedIds.has(session.id))) {
      const progress = await scanProjectProgressForReview(candidate.id, '项目组合恢复前检查项目现状');
      const refreshed = useStore.getState().projectManagers.find((session) => session.id === candidate.id) || candidate;
      if (!progress.ok || projectProgressReviewError(refreshed)) progressBlocked.push(refreshed);
    }
  }
  const blocked = [...definitionBlocked, ...progressBlocked];
  const blockedIds = new Set(blocked.map((session) => session.id));
  const targets = paused
    ? state.projectManagers.filter((session) => session.status === 'active')
    : portfolioPaused.filter((session) => !blockedIds.has(session.id));
  for (const session of targets) {
    const store = useStore.getState();
    const action = paused
      ? { type: 'pause-project' as const, reason, source: 'portfolio' as const }
      : { type: 'resume-project' as const, reason, source: 'portfolio' as const };
    const result = store.applyProjectManagerAction(action, session.id);
    if (paused) {
      for (const laneId of projectSupervisorLaneIds(session)) {
        store.pauseSupervisorLane(laneId, '项目组合已全局暂停');
      }
    } else {
      resumeEligibleProjectSupervisorLanes(session.id, '项目组合已全局恢复');
    }
    if (paused) {
      const timer = projectProgressTimers.get(session.id);
      if (timer) globalThis.clearTimeout(timer);
      projectProgressTimers.delete(session.id);
    } else {
      scheduleProjectProgressCheck(session.id);
    }
    await persistProjectManagerMutation(result, session.id);
    queueProjectManagerDelivery([
      '[项目中心状态通知]',
      `项目：${session.id}`,
      paused
        ? `用户通过项目中心暂停了本项目。原因：${reason}`
        : `用户通过项目中心恢复了本项目。原因：${reason}`,
      paused
        ? '停止派发新工作，并保留当前证据与待办。'
        : '先核对当前项目状态和需求版本，再继续项目内决策。',
    ].join('\n'), session.id);
  }
  return {
    ok: true,
    affectedProjects: targets.map((session) => session.id),
    blockedProjects: blocked.map((session) => session.id),
    message: targets.length > 0
      ? `已${paused ? '暂停' : '恢复'} ${targets.length} 个项目；${blocked.length > 0 ? `${blocked.length} 个项目仍受需求或用户答复门禁约束。` : '此前单独暂停或等待中的项目保持不变。'}`
      : paused
        ? '当前没有可暂停的运行中项目。'
        : blocked.length > 0
          ? `${blocked.length} 个项目仍受需求或用户答复门禁约束，未执行全局恢复。`
          : '当前没有由全局操作暂停的项目。',
  };
}

function saveProjectManagerSnapshot(sessionId?: string): void {
  const state = useStore.getState();
  const session = sessionId
    ? state.projectManagers.find((candidate) => candidate.id === sessionId)
    : state.projectManager;
  if (!session) return;
  void (window as any).wmux?.projectManager?.saveSession?.(session)
    ?.catch?.((error: unknown) => console.warn('[project-manager] snapshot save failed', error));
}

async function resetProjectTaskContextInPlace(
  session: ProjectManagerSession,
  lane: SupervisorLane,
  item: ProjectWorkItem,
  input: { reason: string; evidence: string; cleanContext: string },
): Promise<Record<string, unknown>> {
  const store = useStore.getState();
  const fingerprint = projectTaskContextResetFingerprint(item.id, input.reason, input.evidence);
  const previousReset = item.contextReset;
  if ((previousReset?.count || 0) >= 1) {
    store.applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: item.id,
      patch: {
        status: 'waiting-decision',
        latestBlocker: '同一工作项已经执行过一次上下文清空；必须由项目 AI 缩小成果、拆分工作项或调整任务拓扑',
      },
    }, session.id);
    queueProjectSupervisorAnomaly(
      session,
      lane,
      item,
      'supervisor.context-reset-limit',
      '同一工作项再次出现严重上下文污染，禁止重复清空上下文',
      { evidence: input.evidence, contextSummary: input.cleanContext },
    );
    saveProjectManagerSnapshot(session.id);
    return {
      ok: true,
      outcome: 'rework',
      projectDecisionRequired: true,
      contextResetBlocked: true,
      message: '已交回项目 AI 做宏观拆分或重规划；控制层未再次清空任务上下文',
    };
  }
  const disclosureError = projectTaskInstructionDisclosureError(input.cleanContext)
    || projectTaskContractDisclosureError(item.contract);
  if (disclosureError) {
    return { ok: false, error: `上下文恢复摘要不能污染任务 AI：${disclosureError}` };
  }
  const taskTerminal = locateRemoteTaskTerminal(lane.surfaceId).terminal;
  if (!taskTerminal || taskTerminal.surfaceId !== item.workerSurfaceId) {
    return { ok: false, error: '当前任务终端与工作项绑定不一致，不能清空上下文' };
  }
  const taskAgentState = ((window as any).__wmux_getAgentStates?.() || {})[taskTerminal.surfaceId];
  if (Number(taskAgentState?.runDepth || 0) > 0) {
    return {
      ok: false,
      error: '任务 AI 主线程或内部子线程仍在运行；多线程模式必须等全部线程结束后才能发送 /new',
    };
  }
  const activity = remoteTerminalActivity(taskTerminal.surfaceId, true);
  const buffer = surfaceTerminalRegistry.get(taskTerminal.surfaceId)?.buffer.active;
  if (activity.activityState !== 'idle' || (buffer && hasPendingTerminalInput(buffer))) {
    return { ok: false, error: '任务 AI 仍在工作或输入框存在待提交内容；只能在监督检查点清空上下文' };
  }
  const requestedAt = Date.now();
  const requestedReset = {
    generation: (previousReset?.generation || 1) + 1,
    count: (previousReset?.count || 0) + 1,
    status: 'requested' as const,
    fingerprint,
    reason: input.reason,
    evidence: input.evidence,
    cleanContext: input.cleanContext,
    requestedAt,
  };
  const requested = store.applyProjectManagerAction({
    type: 'update-work-item',
    workItemId: item.id,
    patch: {
      contextReset: requestedReset,
      latestBlocker: '监督 AI 已确认严重上下文污染，控制层正在原终端清空上下文',
    },
  }, session.id);
  if (!requested.ok) return { ok: false, error: requested.error || '上下文清空状态写入失败' };
  try {
    await (window as any).wmux?.projectManager?.saveSession?.(
      useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
    );
  } catch (error) {
    return { ok: false, error: `上下文清空请求持久化失败，未向任务 AI 发送 /new：${String((error as Error)?.message || error)}` };
  }

  const failReset = async (error: string): Promise<Record<string, unknown>> => {
    store.applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: item.id,
      patch: {
        status: 'waiting-decision',
        contextReset: { ...requestedReset, status: 'failed', completedAt: Date.now(), error },
        latestBlocker: error,
      },
    }, session.id);
    queueProjectSupervisorAnomaly(
      session,
      lane,
      item,
      'supervisor.context-reset-failed',
      error,
      { evidence: input.evidence, contextSummary: input.cleanContext },
    );
    saveProjectManagerSnapshot(session.id);
    return { ok: false, error, projectDecisionRequired: true };
  };

  const clearCommand = ordinaryContextClearCommand(
    taskTerminal.surface.projectManagerAgent
      || terminalConversationAgent(
        taskTerminal.label,
        readTerminalScreen(taskTerminal.surfaceId, 80).text || '',
      ),
  );
  if (!clearCommand) {
    return failReset('无法确认任务终端是支持自动清空上下文的 Codex、Kimi、Grok、Pi 或 OpenCode；已交回项目 AI');
  }

  try {
    await Promise.resolve(sendTaskToSurfaceReliably(
      taskTerminal.surfaceId,
      clearCommand,
      true,
      'project',
    ));
  } catch (error) {
    return failReset(`任务 AI 未接受 ${clearCommand}：${String((error as Error)?.message || error)}`);
  }
  await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
  const currentLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id);
  const currentTerminal = currentLane ? locateRemoteTaskTerminal(currentLane.surfaceId).terminal : undefined;
  if (!currentLane
    || currentLane.surfaceId !== taskTerminal.surfaceId
    || !currentTerminal
    || remoteTerminalActivity(taskTerminal.surfaceId, true).activityState !== 'idle'
    || !interactiveAgentInputReady(readTerminalScreen(taskTerminal.surfaceId, 80).text || '')) {
    return failReset(`任务 AI 执行 ${clearCommand} 后没有回到可接收任务的空白输入态；已停止自动重发并交回项目 AI`);
  }
  store.applyProjectManagerAction({
    type: 'update-work-item',
    workItemId: item.id,
    patch: { contextReset: { ...requestedReset, status: 'cleared' } },
  }, session.id);
  const currentTaskBatch = isCurrentProjectTaskBatch(lane.projectTaskBatch)
    ? lane.projectTaskBatch
    : undefined;
  const recoveryBatch: ProjectTaskBatch = currentTaskBatch
    ? {
        ...currentTaskBatch,
        kind: 'rework',
        knownFacts: [...new Set([
          ...currentTaskBatch.knownFacts,
          `上下文已经清空；不要恢复或猜测旧对话。已核对事实：${input.cleanContext}`,
        ])],
      }
    : {
        kind: 'rework',
        coverage: 'bounded-batch',
        outcome: lane.currentTask || item.contract.objective,
        completionDefinition: item.contract.stopWhen.slice(0, 3),
        evidenceExpectations: [],
        unmetCompletionItems: [],
        knownFacts: [`上下文已经清空；不要恢复或猜测旧对话。已核对事实：${input.cleanContext}`],
        constraints: ['遵循当前目录适用的项目规则和技能规范'],
        nonGoals: [],
      };
  const cleanPacket = renderProjectTaskBatch(
    item.contract,
    recoveryBatch,
    item.taskWorkMode || 'single-thread',
    { effectivePreconditions: projectEffectiveWorkItemPreconditions(session, item) },
  );
  try {
    let recoveryAcknowledgement: ReturnType<typeof beginTaskPromptAcknowledgement> | undefined;
    await Promise.resolve(sendTaskToSurfaceReliably(
      taskTerminal.surfaceId,
      cleanPacket,
      true,
      'project',
      () => terminalScreenTail(taskTerminal.surfaceId),
      () => {
        recoveryAcknowledgement = beginTaskPromptAcknowledgement(
          taskTerminal.surfaceId,
          terminalScreenTail(taskTerminal.surfaceId),
        );
      },
    ));
    const delivery = await recoveryAcknowledgement!.promise;
    if (!delivery.confirmed) {
      return failReset(
        `上下文已清空，但 15 秒内未收到干净任务包的 UserPromptSubmit 确认（当前 ${delivery.agentState}）`,
      );
    }
  } catch (error) {
    return failReset(`上下文已清空，但干净任务包重新发布失败：${String((error as Error)?.message || error)}`);
  }
  const completedAt = Date.now();
  store.applyProjectManagerAction({
    type: 'update-work-item',
    workItemId: item.id,
    patch: {
      status: 'running',
      contextReset: { ...requestedReset, status: 'republished', completedAt },
      latestContextSummary: input.cleanContext,
      latestBlocker: undefined,
    },
  }, session.id);
  store.updateLane(lane.id, {
    awaitingReview: false,
    currentTask: recoveryBatch.outcome,
    projectTaskBatch: recoveryBatch,
    projectTaskContractPending: false,
    permissionConfirmations: [],
  });
  const event = store.appendProjectManagerEvent({
    kind: 'task-context-reset',
    workItemId: item.id,
    summary: `监督 AI 已在原任务终端执行 ${clearCommand} 并重新发布同一工作项`,
    payload: {
      laneId: lane.id,
      surfaceId: taskTerminal.surfaceId,
      generation: requestedReset.generation,
      fingerprint,
    },
  }, session.id);
  const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  await (window as any).wmux?.projectManager?.saveSession?.(updated);
  if (event) {
    await (window as any).wmux?.projectManager?.appendRecord?.({
      sessionId: session.id,
      projectDir: session.projectDir,
      type: event.kind,
      payload: { message: event.summary, ...(event.payload || {}) },
    });
  }
  queueSupervisorControlMessage(lane, [
    '[任务 AI 上下文已原地清空并重发布]',
    `任务终端保持不变：${taskTerminal.surfaceId}`,
    '继续监督同一工作项；若再次出现严重污染，禁止重复清空，必须请求项目 AI 拆分或重规划。',
  ].join('\n'));
  return {
    ok: true,
    outcome: 'rework',
    contextReset: true,
    surfaceId: taskTerminal.surfaceId,
    generation: requestedReset.generation,
    message: '任务 AI 已在原终端清空上下文并收到干净任务包',
  };
}

async function rotateProjectTaskTerminalFromSupervisor(
  session: ProjectManagerSession,
  lane: SupervisorLane,
): Promise<Record<string, unknown>> {
  const failRotation = (error: string): Record<string, unknown> => {
    useStore.getState().updateLane(lane.id, {
      projectTaskRotationPending: false,
      projectTaskRotationSummary: undefined,
      projectTaskRotationRequestedAt: undefined,
    });
    return { ok: false, error };
  };
  const summary = String(lane.projectTaskRotationSummary || '').trim();
  if (!summary) return failRotation('当前没有待执行的任务终端轮换请求');
  const oldTerminal = locateRemoteTaskTerminal(lane.surfaceId).terminal;
  if (!oldTerminal) return failRotation('原任务终端已经不存在，不能执行安全轮换');
  const item = lane.projectWorkItemId
    ? session.workItems.find((candidate) => candidate.id === lane.projectWorkItemId)
    : undefined;
  if (!item || item.supervisorLaneId !== lane.id) {
    return failRotation('工作项与当前 AI 监督绑定不一致，不能轮换任务终端');
  }
  if (session.status !== 'active'
    || projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)) {
    return failRotation('项目处于暂停、等待或需求未接受状态，不能轮换任务终端');
  }
  const oldRuntimeState = terminalRuntimeStatus(oldTerminal.surfaceId)?.state;
  const oldRuntimeUnavailable = oldRuntimeState === 'failed' || oldRuntimeState === 'exited'
    || !!nestedAgentShellFailureDetail(oldTerminal.surfaceId);
  const oldBuffer = surfaceTerminalRegistry.get(oldTerminal.surfaceId)?.buffer.active;
  if (!oldRuntimeUnavailable && (
    remoteTerminalActivity(oldTerminal.surfaceId, true).activityState !== 'idle'
    || (oldBuffer && hasPendingTerminalInput(oldBuffer))
  )) {
    return failRotation('原任务终端仍在工作或有待消费输入；必须等待当前回合结束后再安全轮换');
  }
  const rotationRequirementsVersion = projectRequirementsVersion(session);

  const store = useStore.getState();
  const taskDefaults = projectTaskTerminalDefaults(effectiveProjectAgentConfig(session));
  const executionWorkspaceId = projectExecutionWorkspaceId(lane);
  if (!executionWorkspaceId) {
    return failRotation('项目专属监督不在有效的项目执行会话中，不能轮换任务终端');
  }
  const created = createRemoteDirectTerminalTask({
    action: 'create-task',
    name: `${item.title || '项目任务'} · 续作`,
    task: [
      '[项目任务上下文恢复]',
      `项目目标：${session.goal}`,
      `当前任务：${item.contract.objective || lane.currentTask || '继续项目任务'}`,
      '以下总结由原 AI 监督提供；先核对工作区现状，再继续执行，不要从头重复已经完成的步骤。',
      summary,
    ].join('\n'),
    agent: taskDefaults.agent,
    model: taskDefaults.model,
    reasoningEffort: taskDefaults.reasoningEffort,
    cwd: oldTerminal.cwd || session.projectDir,
    anchorWorkspace: executionWorkspaceId,
    projectManagerProjectId: session.id,
    projectManagerWorkItemId: item.id,
    actor: `project-supervisor:${lane.id}`,
  }, true);
  if (!created.ok || !created.surfaceId) {
    return failRotation(String(created.error || '新任务终端创建失败'));
  }
  const replacement = locateRemoteTaskTerminal(created.surfaceId).terminal;
  if (!replacement) {
    closeLiveSurfaceById(created.surfaceId as SurfaceId);
    return failRotation('新任务终端已创建但无法完成绑定；原任务终端保持不变');
  }
  const runtimeReady = await waitForTerminalRuntimeReady(replacement.surfaceId);
  const replacementFailure = runtimeReady.ok
    ? nestedAgentShellFailureDetail(replacement.surfaceId)
    : runtimeReady.error || '未知错误';
  if (replacementFailure) {
    markTerminalRuntimeFailed(replacement.surfaceId, replacementFailure);
    closeLiveSurfaceById(replacement.surfaceId);
    return failRotation(`新任务终端未就绪，原任务终端保持不变：${replacementFailure}`);
  }
  const currentRotationLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id);
  const currentRotationProject = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  const currentRotationItem = currentRotationProject?.workItems.find((candidate) => candidate.id === item.id);
  if (
    !currentRotationLane?.projectTaskRotationPending
    || currentRotationLane.surfaceId !== oldTerminal.surfaceId
    || currentRotationLane.supervisorSurfaceId !== lane.supervisorSurfaceId
    || supervisorLaneControlState(currentRotationLane) !== 'active'
    || currentRotationProject?.status !== 'active'
    || projectRequirementsVersion(currentRotationProject) !== rotationRequirementsVersion
    || projectAcceptedRequirementsVersion(currentRotationProject) !== rotationRequirementsVersion
    || currentRotationItem?.supervisorLaneId !== lane.id
  ) {
    closeLiveSurfaceById(replacement.surfaceId);
    return failRotation('轮换期间项目状态、需求版本或监督绑定已变化；新终端已关闭，原终端保持不变');
  }

  const previousLane = currentRotationLane;
  const previousSession = currentRotationProject;
  store.updateLane(lane.id, {
    surfaceId: replacement.surfaceId,
    label: replacement.label,
    paneId: replacement.paneId,
    workspaceId: replacement.workspaceId,
    workspaceTitle: replacement.workspaceTitle,
    projectDir: replacement.projectDir,
    scopeRoot: session.projectDir,
    currentTask: item.contract.objective || lane.currentTask,
    projectTaskContractPending: true,
    unreportedIdleRecoveryAttempts: 0,
    permissionConfirmations: [],
    projectTaskRotationPending: false,
    projectTaskRotationSummary: undefined,
    projectTaskRotationRequestedAt: undefined,
  });
  store.applyProjectManagerAction({
    type: 'update-work-item',
    workItemId: item.id,
    patch: { workerSurfaceId: replacement.surfaceId, latestContextSummary: summary },
  }, session.id);
  const latestSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
  store.restoreProjectManager({
    ...latestSession,
    taskTerminalSurfaceId: replacement.surfaceId,
    updatedAt: Date.now(),
  });
  const event = store.appendProjectManagerEvent({
    kind: 'terminal-rotated',
    workItemId: item.id,
    summary: `AI 监督已安全轮换任务终端：${oldTerminal.surfaceId} → ${replacement.surfaceId}`,
    payload: { oldSurfaceId: oldTerminal.surfaceId, newSurfaceId: replacement.surfaceId, summary },
  }, session.id);
  const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
  try {
    await (window as any).wmux?.projectManager?.saveSession?.(updated);
  } catch (error) {
    replaceProjectManagerSession(previousSession);
    store.updateLane(lane.id, {
      surfaceId: previousLane.surfaceId,
      label: previousLane.label,
      paneId: previousLane.paneId,
      workspaceId: previousLane.workspaceId,
      workspaceTitle: previousLane.workspaceTitle,
      projectDir: previousLane.projectDir,
      scopeRoot: previousLane.scopeRoot,
      currentTask: previousLane.currentTask,
      projectTaskContractPending: previousLane.projectTaskContractPending,
      unreportedIdleRecoveryAttempts: previousLane.unreportedIdleRecoveryAttempts,
      permissionConfirmations: previousLane.permissionConfirmations,
      projectTaskRotationPending: previousLane.projectTaskRotationPending,
      projectTaskRotationSummary: previousLane.projectTaskRotationSummary,
      projectTaskRotationRequestedAt: previousLane.projectTaskRotationRequestedAt,
    });
    closeLiveSurfaceById(replacement.surfaceId);
    return {
      ok: false,
      error: `新任务终端已就绪，但交接状态持久化失败；已恢复原任务终端：${String((error as Error)?.message || error)}`,
    };
  }
  store.closeSurface(oldTerminal.workspaceId, oldTerminal.paneId, oldTerminal.surfaceId);
  if (event) {
    try {
      await (window as any).wmux?.projectManager?.appendRecord?.({
        sessionId: session.id,
        projectDir: session.projectDir,
        type: event.kind,
        payload: { message: event.summary, ...(event.payload || {}) },
      });
    } catch (error) {
      console.warn('[project-manager] task terminal rotation audit append failed after durable handoff', error);
    }
  }
  if (lane.supervisorSurfaceId) {
    queueSupervisorControlMessage(lane, [
      '[任务终端已轮换]',
      `新任务终端：${replacement.surfaceId}`,
      '你继续担任该项目的 AI 监督。先核对新终端已收到恢复总结，再按原任务契约继续监督。',
    ].join('\n'));
  }
  return {
    ok: true,
    oldSurfaceId: oldTerminal.surfaceId,
    surfaceId: replacement.surfaceId,
    message: '任务终端已安全轮换；监督通知已持久排队并等待 Agent 空闲确认',
  };
}

function projectSupervisorLaneOwnsWorkItem(lane: SupervisorLane, item: ProjectWorkItem): boolean {
  return item.supervisorLaneId === lane.id
    && item.workerSurfaceId === lane.surfaceId
    && (item.assignmentVersion === undefined || lane.projectAssignmentVersion === item.assignmentVersion);
}

async function handleProjectManagerRequest(params: any): Promise<any> {
  const action = String(params?.action || '');
  let store = useStore.getState();
  let session = projectSessionForParams(params);
  const callerSurfaceId = String(params?.callerSurfaceId || '');
  const auxiliaryAction = action === 'auxiliary-dispatch' || action === 'auxiliary-status';
  if (!(auxiliaryAction
    ? projectAuxiliaryCallerAllowed(callerSurfaceId, session)
    : projectManagerCallerAllowed(callerSurfaceId, session))) {
    return { ok: false, error: '项目管理命令只能由项目管理 AI 运行时执行' };
  }
  if ((window as any).wmux?.pty?.has && !managedRoleProtocolIsReady(callerSurfaceId)) {
    return {
      ok: false,
      error: '当前管理角色尚未通过 AGENTS.md 协议确认；请先运行 wmux context，再执行启动消息指定的 wmux role-ready',
    };
  }
  const correlationId = String(params?.correlationId || '').trim();
  const correlatedProjects = action === 'reply' && correlationId
    ? store.projectManagers.filter((project) => project.events.some((event) => (
        event.kind === 'user-message' && event.correlationId === correlationId
      )))
    : [];
  const uniquelyCorrelatedReply = action === 'reply'
    && !String(params?.projectId || '').trim()
    && correlatedProjects.length === 1
    && correlatedProjects[0].id === session?.id;
  if (projectCommandNeedsExplicitId(
    action,
    String(params?.projectId || ''),
    store.projectManagers,
  ) && !uniquelyCorrelatedReply) {
    return { ok: false, error: '存在多个项目，该项目动作必须显式指定 --project <id>' };
  }
  if (action === 'status') {
    if (session) reconcileProjectExecutionResponsibility(session.id);
    session = projectSessionForParams(params);
    return {
      ok: true,
      session: session ? projectManagerSessionView(session) : null,
      projects: session ? [projectManagerSessionView(session)] : [],
    };
  }
  if (action === 'logs') return { ok: true, events: session?.events.slice(-100).reverse() || [] };
  if (action === 'pause-all' || action === 'resume-all') {
    return { ok: false, error: '批量暂停或恢复属于无决策权的项目中心，单项目 AI 无权控制其他项目' };
  }

  store = useStore.getState();
  session = projectSessionForParams(params);
  if (!session) return { ok: false, error: '当前没有项目管理会话' };
  if (action === 'auxiliary-status') {
    const config = effectiveProjectAgentConfig(session).auxiliary;
    const terminal = session.auxiliaryTaskTerminalSurfaceId
      ? remoteProjectTerminalList().find((candidate) => (
          candidate.surfaceId === session!.auxiliaryTaskTerminalSurfaceId
          && candidate.role === 'auxiliary-task-ai'
        ))
      : undefined;
    return {
      ok: true,
      enabled: config.enabled,
      allowProjectMaintenance: config.allowProjectMaintenance,
      terminal: terminal ? {
        surfaceId: terminal.surfaceId,
        activityState: remoteTerminalActivity(terminal.surfaceId, true).activityState,
      } : null,
      task: session.auxiliaryTask || null,
      output: terminal ? (readTerminalScreen(terminal.surfaceId, 160).text || '').slice(-12_000) : '',
    };
  }
  if (action === 'auxiliary-dispatch') {
    const config = effectiveProjectAgentConfig(session).auxiliary;
    if (!config.enabled) return { ok: false, error: '当前项目未启用辅助任务 AI' };
    const rawKind = String(params?.kind || 'research').trim();
    if (!['research', 'documentation', 'progress', 'git-commit'].includes(rawKind)) {
      return { ok: false, error: '辅助任务 kind 仅允许 research、documentation、progress 或 git-commit' };
    }
    const kind = rawKind as 'research' | 'documentation' | 'progress' | 'git-commit';
    const task = String(params?.task || '').trim().slice(0, 12_000);
    if (!task) return { ok: false, error: '辅助任务不能为空' };
    const allowedPaths = projectStringArray(params?.allowedPaths).map((path) => path.replace(/\\/gu, '/'));
    if (kind === 'research' && allowedPaths.length > 0) {
      return { ok: false, error: 'research 辅助任务必须保持只读，不能声明写入路径' };
    }
    if (kind !== 'research' && allowedPaths.length === 0) {
      return { ok: false, error: '文档、进度或 Git 提交辅助任务必须显式声明 allowedPaths' };
    }
    if (!allowedPaths.every(projectAuxiliaryWritablePathAllowed)) {
      return { ok: false, error: '辅助 AI 只允许写入受控文档、项目进度和运行事实路径；禁止业务源码、测试、配置与依赖' };
    }
    if (kind !== 'research' && !config.allowProjectMaintenance) {
      return { ok: false, error: '用户尚未授权辅助 AI 更新项目进度、相关文档或提交受控变更' };
    }
    if (kind !== 'research' && session.taskTerminalSurfaceId
      && remoteTerminalActivity(session.taskTerminalSurfaceId as SurfaceId, true).activityState === 'working') {
      return { ok: false, error: '主任务 AI 正在工作；辅助文档、进度和 Git 写任务必须串行，当前只能派发只读 research' };
    }
    const runtime = await ensureProjectAuxiliaryRuntime(session.id);
    if (!runtime.ok || !runtime.terminal) return { ok: false, error: runtime.error || '辅助任务 AI 未就绪' };
    if (session.auxiliaryTask?.status === 'running'
      || remoteTerminalActivity(runtime.terminal.surfaceId, true).activityState === 'working') {
      return { ok: false, error: '辅助任务 AI 正在执行上一项任务；一个项目最多同时运行一个辅助任务' };
    }
    const buffer = surfaceTerminalRegistry.get(runtime.terminal.surfaceId)?.buffer.active;
    if (buffer && hasPendingTerminalInput(buffer)) {
      return { ok: false, error: '辅助任务 AI 输入区已有未提交内容，不能覆盖或追加派发' };
    }
    const requesterLane = useStore.getState().supervisor.lanes.find((lane) => (
      lane.projectManagerProjectId === session!.id
      && dedicatedSupervisorSurfaceId(lane) === callerSurfaceId
      && supervisorLaneControlState(lane) !== 'stopped'
    ));
    const packet = [
      '[辅助成果任务]',
      `类型：${kind}`,
      `目标：${task}`,
      allowedPaths.length > 0 ? `唯一允许写入/暂存的路径：${allowedPaths.join('；')}` : '只读调查：禁止修改任何项目文件。',
      '开始前读取并严格遵循当前目录适用的 AGENTS、项目技能和文档/进度落位规范。',
      '你与项目 AI/监督 AI 的交互仅限接收本任务并向原请求方报告结果；不得参与编排、审批、项目决策或主任务技术路线。',
      '禁止修改业务源码、测试、构建配置、依赖和主任务 AI 产物；禁止运行项目实现或测试；禁止寻找、通知或控制主任务 AI。',
      kind === 'git-commit'
        ? '用户已授权本次 Git commit。必须使用项目 commit-gatekeeper 规则，只暂存上述路径并使用中文提交信息；不得暂存其他改动，不得 push、发布或改写历史。'
        : kind === 'research'
          ? '本任务仅授权只读调查，不得修改文件、Git commit、push、发布或改写历史。'
          : '用户已授权本次受控项目维护；只可更新上述项目进度或相关文档，不得 Git commit、push、发布或改写历史。',
      '完成后报告实际读取/修改/提交的路径、证据、commit hash（如有）和剩余问题。',
    ].join('\n');
    const delivery = sendRemoteTerminalTask({
      action: 'send',
      terminal: runtime.terminal.surfaceId,
      task: packet,
      actor: requesterLane ? `project-supervisor:${requesterLane.id}` : `project-manager:${session.id}`,
      mode: 'project',
    });
    if (!delivery.ok) return delivery;
    const auxiliaryTask = {
      id: `aux-${Date.now().toString(36)}`,
      requesterRole: requesterLane ? 'supervisor-ai' as const : 'project-ai' as const,
      requesterSurfaceId: callerSurfaceId,
      ...(requesterLane ? { requesterLaneId: requesterLane.id } : {}),
      kind,
      task,
      allowedPaths,
      status: 'running' as const,
      startedAt: Date.now(),
    };
    const updated = { ...session, auxiliaryTask, updatedAt: Date.now() };
    replaceProjectManagerSession(updated);
    await appendRecordedProjectEvent(updated, {
      kind: 'supervisor-status',
      summary: `辅助任务 AI 已接收 ${kind} 任务：${task.slice(0, 160)}`,
      payload: { auxiliaryTaskId: auxiliaryTask.id, requesterRole: auxiliaryTask.requesterRole, allowedPaths },
    });
    return { ok: true, auxiliaryTaskId: auxiliaryTask.id, surfaceId: runtime.terminal.surfaceId, delivery };
  }
  const planningConfirmationError = projectPlanningActionConfirmationError(session, action, params);
  if (planningConfirmationError) return { ok: false, error: planningConfirmationError };
  if (action === 'progress-sync') {
    if (params?.acknowledge === true) {
      return acknowledgeProjectProgress(session.id, String(params?.summary || ''));
    }
    const result = await scanProjectProgressForReview(session.id, '项目 AI 主动刷新项目进度');
    return {
      ok: result.ok,
      reviewRequired: result.reviewRequired,
      summary: result.summary,
      ...(result.error ? { error: result.error } : {}),
    };
  }
  if (action === 'transition-ack') {
    const sessionId = session.id;
    const transitionId = String(params?.transitionId || params?.transition || '').trim();
    const resolution = String(params?.resolution || '').trim();
    const summary = String(params?.summary || '').trim().slice(0, 4000);
    const allowedResolutions = new Set(['continued', 'accepted', 'replanned', 'paused', 'escalated', 'recovered']);
    if (!transitionId) return { ok: false, error: '监督状态交接回执必须指定 --transition' };
    if (!allowedResolutions.has(resolution)) {
      return { ok: false, error: '无效 resolution；可用值：continued、accepted、replanned、paused、escalated、recovered' };
    }
    if (!summary) return { ok: false, error: '监督状态交接回执必须用 --summary 说明处理结果和新方向' };
    const transition = (session.pendingSupervisorTransitions || [])
      .find((candidate) => candidate.id === transitionId);
    if (!transition) return { ok: false, error: '该监督状态交接已处理或不存在；请刷新 project status' };
    const resolutionError = projectTransitionResolutionError(session, transition, resolution);
    if (resolutionError) return { ok: false, error: resolutionError };
    const closesCurrentExecutionWindow = ['replanned', 'paused', 'escalated', 'accepted'].includes(resolution);
    if (transition.workItemId && transition.kind !== 'stage-complete' && closesCurrentExecutionWindow) {
      const checkpointed = await checkpointProjectProgress(
        sessionId,
        `项目 AI 回执监督交接：${transition.id}`,
      );
      if (!checkpointed) {
        return { ok: false, error: '监督交接处理结果未丢失，但受管项目进度快照保存失败；请先修复进度同步后重试同一 transition-ack' };
      }
      store = useStore.getState();
      session = store.projectManagers.find((candidate) => candidate.id === sessionId) || session;
    }
    if (resolution === 'paused' && transition.workItemId) {
      pauseProjectSupervisorLanesForWorkItem(
        session,
        transition.workItemId,
        '项目 AI 已回执暂停；同步暂停监督通道，禁止伪 active 状态掩盖后续责任交接',
      );
    }
    for (let index = pendingProjectManagerDeliveries.length - 1; index >= 0; index -= 1) {
      const delivery = pendingProjectManagerDeliveries[index];
      if (delivery.sessionId === session.id && delivery.transitionId === transition.id) {
        pendingProjectManagerDeliveries.splice(index, 1);
      }
    }
    replaceProjectManagerSession({
      ...session,
      pendingSupervisorTransitions: (session.pendingSupervisorTransitions || [])
        .filter((candidate) => candidate.id !== transition.id),
      pendingManagerDeliveries: (session.pendingManagerDeliveries || [])
        .filter((delivery) => delivery.transitionId !== transition.id),
      updatedAt: Date.now(),
    });
    store.appendProjectManagerEvent({
      kind: 'supervisor-transition-acknowledged',
      workItemId: transition.workItemId,
      summary: `项目 AI 已处理监督状态交接：${summary}`,
      payload: {
        transitionId: transition.id,
        laneId: transition.laneId,
        transitionKind: transition.kind,
        resolution,
        replanBaselineFingerprint: transition.replanBaselineFingerprint,
      },
    }, sessionId);
    saveProjectManagerSnapshot(sessionId);
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === sessionId);
    const recoveryQueued = current?.status === 'active'
      ? await ensureProjectDeadlockRecovery(
          sessionId,
          `项目 AI 已用 ${resolution} 回执监督交接 ${transition.id}`,
        )
      : undefined;
    if (!recoveryQueued && current?.status === 'active') scheduleProjectProgressCheck(sessionId);
    return {
      ok: true,
      transitionId: transition.id,
      resolution,
      ...(recoveryQueued ? { internalRecoveryQueued: true } : {}),
    };
  }
  if (!callerSurfaceId || callerSurfaceId !== session.managerSurfaceId) {
    return { ok: false, error: '该动作只能由当前项目管理 AI 执行' };
  }
  if (action === 'user-question') {
    if (['completed', 'stopped'].includes(session.status)) {
      return { ok: false, error: `项目管理会话已${session.status === 'completed' ? '完成' : '停止'}，不能再向用户提问` };
    }
    const normalized = normalizeProjectManagerUserQuestion(params, session.status);
    if (!normalized.question) return { ok: false, error: normalized.error };
    if (normalized.question.reasonCode === 'final-acceptance') {
      return { ok: false, error: 'final-acceptance 只能由控制层在已有成果且仅剩验证缺口时生成，项目 AI 不能自行发起' };
    }
    const reusableDecision = !session.pendingUserQuestion
      && projectManagerQuestionAllowsReusableDecision(normalized.question)
      ? [...(session.reusableUserDecisions || [])].reverse().find((decision) => (
          decision.decisionKey === projectManagerQuestionDecisionKey(normalized.question!)
          && decision.semanticFingerprint === projectManagerQuestionSemanticFingerprint(normalized.question!)
          && decision.requirementsVersion === projectRequirementsVersion(session)
          && decision.authorizationVersion === projectAuthorizationVersion(session)
          && (decision.reasonCode !== 'destructive-action' || (
            decision.projectId === session.id
            && decision.workItemId === normalized.question?.workItemId
            && projectManagerDestructiveDecisionScopeMatches(
              normalized.question?.decisionScope,
              session.id,
              normalized.question?.workItemId,
            )
          ))
        ))
      : undefined;
    if (reusableDecision) {
      const confirmationScope = projectManagerQuestionConfirmationScope(
        normalized.question,
        reusableDecision.optionId,
      );
      await appendRecordedProjectEvent(session, {
        kind: 'user-clarification-answered',
        workItemId: normalized.question.workItemId,
        summary: `自动沿用用户已授权的同类答复：${reusableDecision.answer}`,
        payload: {
          questionId: normalized.question.id,
          decisionKey: reusableDecision.decisionKey,
          answer: reusableDecision.answer,
          optionId: reusableDecision.optionId,
          category: normalized.question.category,
          autoReused: true,
          sourceDecisionId: reusableDecision.id,
          semanticFingerprint: reusableDecision.semanticFingerprint,
          ...(confirmationScope.length ? {
            confirmationScope,
            confirmationDigest: projectPlanningConfirmationDigest(confirmationScope),
          } : {}),
        },
      });
      queueProjectManagerDelivery([
        '[用户已授权复用同类决定｜不得再次提问]',
        `问题：${normalized.question.question}`,
        `沿用答复：${reusableDecision.answer}`,
        `decisionKey：${reusableDecision.decisionKey}`,
        '请把该答复视为当前需求与授权版本内的权威用户指导，自行决定恢复、改线、继续等待或结束。',
      ].join('\n'), session.id, { priority: true });
      return {
        ok: true,
        autoAnswered: true,
        answer: reusableDecision.answer,
        optionId: reusableDecision.optionId,
        decisionKey: reusableDecision.decisionKey,
        message: '已沿用用户授权的同类决定；未暂停项目，也未重复通知用户。',
      };
    }
    if (!projectRequirementsAlignmentPending(session) && normalized.question.category !== 'manual-intervention') {
      return { ok: false, error: '项目执行中仅在无法由项目管理 AI 处理、需要人工操作或越权授权时才能提问；请使用 category=manual-intervention' };
    }
    if (!projectRequirementsAlignmentPending(session) && (
      !normalized.question.workItemId
      || !normalized.question.blocker
      || !normalized.question.reasonCode
    )) {
      return {
        ok: false,
        error: '执行阶段的人工介入必须提供 workItemId、blocker 和有效 reasonCode，不能把普通技术问题转交用户',
      };
    }
    if (normalized.question.workItemId && !session.workItems.some((item) => item.id === normalized.question?.workItemId)) {
      return { ok: false, error: `任务不存在：${normalized.question.workItemId}` };
    }
    const owningWorkItem = normalized.question.workItemId
      ? session.workItems.find((item) => item.id === normalized.question?.workItemId)
      : undefined;
    if (owningWorkItem && ['completed', 'stopped'].includes(owningWorkItem.status)) {
      return { ok: false, error: '已完成或停止的任务不能再发起人工介入' };
    }
    if (normalized.question.reasonCode === 'verification-limited'
      && (!owningWorkItem || !currentProjectVerificationLimitation(session, owningWorkItem))) {
      return {
        ok: false,
        error: 'verification-limited 只能引用控制层已记录且属于当前工作项、需求和授权版本的验证能力限制',
      };
    }
    if (normalized.question.reasonCode === 'runtime-recovery') {
      const recoveryProven = [...session.events].reverse().some((event) => {
        if (event.workItemId && event.workItemId !== owningWorkItem?.id) return false;
        if (['manager-runtime-failed', 'supervisor-runtime-failed', 'task-runtime-failed'].includes(event.kind)) {
          return true;
        }
        return event.kind === 'guard-triggered' && [
          'project-internal-recovery-exhausted',
          'project-internal-runtime-recovery-failed',
        ].includes(String(event.payload?.reason || ''));
      });
      if (!recoveryProven) {
        return {
          ok: false,
          error: 'runtime-recovery 只能在控制层已记录运行时故障或内部恢复耗尽后使用',
        };
      }
    }
    const authorizedTechnicalRoute = projectAuthorizedTechnicalRoute(session, normalized.question);
    if (authorizedTechnicalRoute) {
      await appendRecordedProjectEvent(session, {
        kind: 'guard-triggered',
        workItemId: authorizedTechnicalRoute.workItem.id,
        summary: `项目 AI 试图把主目标内技术路线“${authorizedTechnicalRoute.label}”转交用户；控制层已拒绝并要求自主重规划`,
        payload: {
          decision: 'continue',
          attentionRequired: false,
          reason: 'authorized-technical-route-owned-by-project-ai',
          recommendedOptionId: authorizedTechnicalRoute.optionId,
        },
      });
      return {
        ok: false,
        internalDecisionRequired: true,
        recommendedOptionId: authorizedTechnicalRoute.optionId,
        error: `推荐路线“${authorizedTechnicalRoute.label}”已被当前主目标、工作项技术权限和既有授权覆盖，属于项目 AI 的内部重规划责任，不能作为 business-choice 询问用户。请保留现有证据，更新阶段计划/工作项合同并 dispatch 下一技术路线。`,
      };
    }
    const supervisorOwnedPermission = projectSupervisorOwnedPermissionPrompt(session, normalized.question);
    if (supervisorOwnedPermission) {
      await appendRecordedProjectEvent(session, {
        kind: 'guard-triggered',
        workItemId: supervisorOwnedPermission.workItem.id,
        summary: '项目 AI 试图把任务 AI 的普通本地权限提示转交用户；控制层已拒绝并要求交由监督链处理',
        payload: {
          decision: 'continue',
          attentionRequired: false,
          reason: 'task-permission-owned-by-supervisor-ai',
          contractChangeRequired: supervisorOwnedPermission.contractChangeRequired,
        },
      });
      return {
        ok: false,
        internalDecisionRequired: true,
        supervisorOwnedPermission: true,
        contractChangeRequired: supervisorOwnedPermission.contractChangeRequired,
        error: supervisorOwnedPermission.contractChangeRequired
          ? '这是任务 AI 的普通本地权限提示，不是用户问题。请由项目 AI 判断其是否属于主目标内低风险动作；若是，更新合同为最小 allowedCommandPrefixes 并启用 permissionConfirm，再由专属监督结合实时终端证据逐次确认。只有新增外部访问、凭据、提权、生产/云端权限或更高风险授权才能询问用户。'
          : '这是任务 AI 的普通本地权限提示，当前合同已授权 permissionConfirm，应由专属监督结合真实阻塞状态、命令证据、范围、风险和重复确认护栏逐次处理，不能询问用户或由项目 AI 逐次批准。',
      };
    }
    if (normalized.question.reasonCode === 'task-input-conflict') {
      const workItemId = normalized.question.workItemId;
      const lane = store.supervisor.lanes.find((candidate) => (
        candidate.projectManagerProjectId === session.id
        && candidate.projectWorkItemId === workItemId
        && supervisorLaneControlState(candidate) !== 'stopped'
      ));
      if (!lane || !projectTaskInputDraftStillPending(lane)) {
        return {
          ok: false,
          error: 'task-input-conflict 仅用于控制层已确认任务终端存在用户未提交草稿的情况',
        };
      }
    }
    const result = store.applyProjectManagerAction({
      type: 'request-user-clarification',
      question: normalized.question,
    }, session.id);
    if (!result.ok) return result;
    for (const laneId of projectSupervisorLaneIds(session)) {
      store.pauseSupervisorLane(laneId, '项目等待用户澄清关键需求');
    }
    const timer = projectProgressTimers.get(session.id);
    if (timer) globalThis.clearTimeout(timer);
    projectProgressTimers.delete(session.id);
    notifyProjectManagerUserQuestion(session, normalized.question);
    await persistProjectManagerMutation(result, session.id);
    return {
      ok: true,
      question: normalized.question,
      message: '已暂停该项目并向用户发送澄清问题；其他项目继续运行。',
    };
  }
  if (['completed', 'stopped'].includes(session.status) && !['reply'].includes(action)) {
    return { ok: false, error: `项目管理会话已${session.status === 'completed' ? '完成' : '停止'}，不能再执行该动作` };
  }
  if (session.pendingUserQuestion && !['reply'].includes(action)) {
    return { ok: false, error: `项目正在等待用户答复：${session.pendingUserQuestion.question}` };
  }
  if (action === 'orientation-confirm') {
    const result = await acknowledgeProjectOrientation(session.id, params?.orientation || params);
    return result;
  }
  if (action === 'alignment-confirm') {
    if (!projectRequirementsAlignmentPending(session)) {
      return { ok: false, error: '该项目当前没有待完成的首次需求充分性检测' };
    }
    if (projectRequirementAlignmentState(session) === 'needs-definition-update') {
      return { ok: false, error: `用户变更尚未写回项目定义；请先执行 wmux project update --project ${session.id}` };
    }
    if (session.doneWhen.length === 0) {
      return {
        ok: false,
        error: `项目定义仍缺少可验证完成条件；请先起草验收标准并执行 wmux project update --project ${session.id} 写回，再向用户展示完整需求摘要。没有额外前置条件时可以保留为空。`,
      };
    }
    const assessment = params?.assessment || params;
    const confirmationEventId = String(assessment?.userConfirmationEventId || '').trim();
    const confirmationIndex = session.events.findIndex((event) => event.id === confirmationEventId);
    const latestRequiredIndex = session.events.reduce((latest, event, index) => (
      event.kind === 'requirements-alignment-required' ? index : latest
    ), -1);
    const latestDefinitionIndex = session.events.reduce((latest, event, index) => (
      event.kind === 'project-definition-updated' ? index : latest
    ), -1);
    if (!projectRequirementConfirmationCoversCurrentDefinition(
      session,
      confirmationIndex,
      latestRequiredIndex,
      latestDefinitionIndex,
    )) {
      return {
        ok: false,
        error: '首次需求对齐必须引用最新的完整需求确认，或引用已由本次定义更新明确采用的结构化用户答复；只有仍有未覆盖的目标、范围、前置条件或验收变化时才再次提问',
      };
    }
    const result = store.applyProjectManagerAction({
      type: 'confirm-requirements-alignment',
      goalUnderstanding: String(assessment?.goalUnderstanding || ''),
      scopeSummary: String(assessment?.scopeSummary || ''),
      acceptanceSummary: String(assessment?.acceptanceSummary || ''),
      reason: String(assessment?.reason || ''),
      userConfirmationEventId: confirmationEventId,
    }, session.id);
    if (!result.ok) return result;
    const timer = projectAlignmentTimers.get(session.id);
    if (timer) globalThis.clearTimeout(timer);
    projectAlignmentTimers.delete(session.id);
    await persistProjectManagerMutation(result, session.id);
    return {
      ok: true,
      event: result.event,
      message: '需求充分性检测已记录；下一步必须读取最新 project status 并提交 orientation-confirm，不能跳过认知基线直接恢复或再次询问同一需求。',
    };
  }
  if (['goal-plan', 'task-create', 'task-update', 'supervisor-assign', 'complete'].includes(action)) {
    const alignment = await ensureProjectRequirementAlignment(session.id, `项目管理 AI 尝试在需求未充分对齐时执行 ${action}`);
    if (alignment.triggered || alignment.alignmentRequired || alignment.awaitingDefinitionUpdate) {
      return {
        ok: false,
        error: alignment.awaitingDefinitionUpdate
          ? `用户答复尚未写回项目定义；请先执行 wmux project update --project ${session.id}`
          : alignment.alignmentRequired
            ? `项目尚未提交首次需求充分性结论；请先执行 wmux project alignment-confirm --project ${session.id}，需求不足则执行 wmux project ask --project ${session.id}`
            : '项目需求尚未充分对齐；控制层已向桌面和飞书发送带推荐项的问题',
        question: alignment.question,
      };
    }
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
    const orientationError = projectOrientationReviewError(current);
    if (orientationError) return { ok: false, error: orientationError };
  }

  if (action === 'update-definition') {
    return updateProjectDefinition(session, params, 'manager');
  }

  if (action === 'goal-plan') {
    const normalized = normalizeProjectSubgoalsInput(params?.subgoals, session);
    if (!normalized.subgoals) {
      return {
        ok: false,
        error: normalized.error,
        ...(normalized.error?.startsWith('stage-closure-evidence-mapping-missing')
          ? { reasonCode: 'stage-closure-evidence-mapping-missing' }
          : {}),
      };
    }
    const result = await persistProjectManagerMutation(store.applyProjectManagerAction({
      type: 'set-project-subgoals',
      subgoals: normalized.subgoals,
      reason: String(params?.reason || '').trim().slice(0, 2000),
      source: 'manager',
      userConfirmationEventId: String(params?.userConfirmationEventId || '').trim() || undefined,
    }, session.id), session.id);
    const response = result.ok
      ? { ...result, message: '阶段计划已保存；处理完旧版本工作项后必须显式 resume，再继续创建或派发当前目标任务。' }
      : result;
    return response;
  }

  if (action === 'terminals') {
    return {
      ok: true,
      terminals: remoteTerminalList()
        .filter((terminal) => terminal.surface.projectManagerProjectId === session.id)
        .map((terminal) => ({
          surfaceId: terminal.surfaceId,
          label: terminal.label,
          workspaceId: terminal.workspaceId,
          workspace: terminal.workspaceTitle,
          cwd: terminal.cwd,
          ...remoteTerminalActivity(terminal.surfaceId),
        })),
    };
  }
  if (action === 'supervisor-inspect') {
    const lane = useStore.getState().supervisor.lanes.find((candidate) => (
      candidate.projectManagerProjectId === session.id && supervisorLaneControlState(candidate) !== 'stopped'
    ));
    if (!lane?.supervisorSurfaceId) return { ok: false, error: '该项目当前没有可检查的 AI 监督' };
    const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane)!;
    const supervisorActivity = remoteTerminalActivity(supervisorSurfaceId, true);
    const activity = remoteTerminalActivity(lane.surfaceId, true);
    const watchdog = managedAgentWatchdogs.get(supervisorSurfaceId);
    return {
      ok: true,
      laneId: lane.id,
      terminal: activity,
      supervisor: supervisorActivity,
      watchdog: watchdog ? {
        phase: watchdog.phase,
        turnStartedAt: watchdog.turnStartedAt,
        lastLivenessAt: watchdog.lastLivenessAt,
        lastSemanticProgressAt: watchdog.lastSemanticProgressAt,
        softDeadlineAt: watchdog.softDeadlineAt,
        hardDeadlineAt: watchdog.hardDeadlineAt,
      } : null,
      message: '已只读返回监督与任务终端状态；未向任何 Agent 发送活性探测消息。',
    };
  }
  if (action === 'task-create' || action === 'task-update' || action === 'supervisor-assign' || action === 'complete') {
    const projectId = session.id;
    const activeExecution = useStore.getState().supervisor.lanes.some((lane) => (
      lane.projectManagerProjectId === projectId
      && projectSupervisorLaneProvidesActiveExecution(session, lane)
    ));
    // An active owned chain is expected to mutate the worktree. Its changes are
    // checkpointed at stage handoff; treating them as external here would
    // misclassify normal task progress merely because the manager retried a command.
    if (!activeExecution) {
      const progress = await scanProjectProgressForReview(
        projectId,
        action === 'task-create' || action === 'task-update'
          ? '创建阶段工作项前检查项目现状'
          : action === 'complete'
            ? '主目标验收前检查项目现状'
            : '派发或续接监督前检查项目现状',
      );
      const progressSession = useStore.getState().projectManagers.find((candidate) => candidate.id === projectId) || session;
      const reviewError = projectProgressReviewError(progressSession);
      if (!progress.ok || reviewError) {
        return { ok: false, error: reviewError || progress.error || '项目进度同步失败，不能派发旧任务' };
      }
    }
  }
  if (action === 'task-create') {
    const currentSession = useStore.getState().projectManagers
      .find((candidate) => candidate.id === session.id) || session;
    if ((params?.workItem || params)?.baseline !== undefined
      || (params?.workItem || params)?.supervisorPlan !== undefined
      || (params?.workItem || params)?.executionProtocolVersion !== undefined
      || (params?.workItem || params)?.predecessorWorkItemId !== undefined
      || (params?.workItem || params)?.supersededByWorkItemId !== undefined
      || (params?.workItem || params)?.successionReason !== undefined
      || (params?.workItem || params)?.verificationLimitation !== undefined
      || (params?.workItem || params)?.verificationDecision !== undefined) {
      return { ok: false, error: '检测到已删除或控制层专属字段；当前工作项不能提供执行协议版本、前驱/后继关系、项目基线、监督阶段计划或用户验证决策' };
    }
    const normalized = normalizeProjectWorkItemInput(
      params?.workItem || params,
      currentSession.projectDir,
      undefined,
      currentSession,
    );
    if (!normalized.workItem) return { ok: false, error: normalized.error };
    const creationError = projectWorkItemCreationError(currentSession, normalized.workItem);
    if (creationError) return { ok: false, error: creationError };
    if (['validating', 'completed'].includes(normalized.workItem.status)) {
      return { ok: false, error: '新任务必须先经过监督执行，不能直接创建为验证中或已完成' };
    }
    if (
      String((params?.workItem || params)?.workerSurfaceId || '').trim()
      || String((params?.workItem || params)?.supervisorLaneId || '').trim()
    ) {
      return { ok: false, error: '项目工作项不能指定现有终端或监督通道；运行时绑定只能由控制层创建' };
    }
    const result = await persistProjectManagerMutation(
      store.applyProjectManagerAction({ type: 'create-work-item', workItem: normalized.workItem }, session.id),
      session.id,
    );
    return result;
  }
  if (action === 'task-update') {
    const source = params?.workItem || params || {};
    const workItemId = String(source.workItemId || source.id || '').trim();
    const previous = session.workItems.find((candidate) => candidate.id === workItemId);
    if (!previous) return { ok: false, error: `任务不存在：${workItemId || '未指定'}` };
    if (previous.status === 'completed') {
      const allowedFields = new Set([
        'action', 'callerSurfaceId', 'callerRole', 'roleCapability', 'projectId',
        'workItemId', 'id', 'stageAcceptanceCoverage', 'contract',
      ]);
      const unexpectedField = Object.keys(source).find((field) => !allowedFields.has(field));
      const contractPatch = source.contract && typeof source.contract === 'object'
        ? source.contract as Record<string, unknown>
        : {};
      const unexpectedContractField = Object.keys(contractPatch)
        .find((field) => field !== 'stageAcceptanceCoverage');
      if (unexpectedField || unexpectedContractField) {
        return {
          ok: false,
          error: `completed 历史工作项只能补充 contract.stageAcceptanceCoverage，不能改写状态、completion、证据或合同正文：${unexpectedField || `contract.${unexpectedContractField}`}`,
        };
      }
      const coverageInput = source.stageAcceptanceCoverage ?? contractPatch.stageAcceptanceCoverage;
      if (coverageInput === undefined) {
        return { ok: false, error: 'completed 历史工作项更新必须提供 contract.stageAcceptanceCoverage' };
      }
      const normalized = normalizeProjectWorkItemInput(
        projectWorkItemUpdateInput({ stageAcceptanceCoverage: coverageInput }, previous),
        session.projectDir,
        previous,
        session,
      );
      if (!normalized.workItem) return { ok: false, error: normalized.error };
      const result = await persistProjectManagerMutation(store.applyProjectManagerAction({
        type: 'update-work-item',
        workItemId: previous.id,
        patch: {
          contract: {
            ...previous.contract,
            stageAcceptanceCoverage: normalized.workItem.contract.stageAcceptanceCoverage,
          },
        },
      }, session.id), session.id);
      return result.ok
        ? { ...result, message: '历史完成项的阶段验收映射已补充；状态、completion、证据和合同正文保持不变' }
        : result;
    }
    const controlOwnedFields = [
      'workerSurfaceId', 'supervisorLaneId', 'executionProtocolVersion', 'assignmentVersion',
      'attempts', 'decisionsUsed', 'totalDecisionsUsed', 'executionHistory', 'startedAt',
      'completedAt', 'completion', 'contextReset', 'baseline', 'supervisorPlan',
      'predecessorWorkItemId', 'supersededByWorkItemId', 'successionReason',
      'verificationLimitation', 'verificationDecision',
    ];
    const suppliedControlField = controlOwnedFields.find((field) => (
      Object.prototype.hasOwnProperty.call(source, field)
    ));
    if (suppliedControlField) {
      return { ok: false, error: `字段 ${suppliedControlField} 由控制层或专属监督维护，项目 AI 不能通过 task-update 修改` };
    }
    if (source.status === 'running' || source.status === 'validating') {
      return {
        ok: false,
        error: 'running/validating 是专属监督拥有的执行状态；重规划请更新为 planned，再执行 project dispatch',
      };
    }
    const normalized = normalizeProjectWorkItemInput(
      projectWorkItemUpdateInput(source, previous),
      session.projectDir,
      previous,
      session,
    );
    if (!normalized.workItem) return { ok: false, error: normalized.error };
    const { id: _id, ...patch } = normalized.workItem;
    const result = await persistProjectManagerMutation(store.applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: previous.id,
      patch,
    }, session.id), session.id);
    if (!result.ok) return result;
    if (normalized.workItem.status === 'paused') {
      pauseProjectSupervisorLanesForWorkItem(
        session,
        previous.id,
        '项目 AI 已暂停当前工作项；等待重规划或用户边界处理',
      );
    }
    return {
      ...result,
      workItem: useStore.getState().projectManagers
        .find((candidate) => candidate.id === session.id)?.workItems
        .find((candidate) => candidate.id === previous.id),
      message: '工作项已更新；若要恢复执行，请使用 project dispatch 交给专属监督',
    };
  }
  if (action === 'supervisor-assign') {
    const workItemId = String(params?.workItemId || params?.task || '').trim();
    const item = session.workItems.find((candidate) => candidate.id === workItemId);
    if (!item) return { ok: false, error: `任务不存在：${workItemId}` };
    if (session.status !== 'active') return { ok: false, error: '项目未处于活动状态，不能派发任务' };
    if (session.activeWorkItemId && session.activeWorkItemId !== item.id) {
      return { ok: false, error: `当前已有活动工作项 ${session.activeWorkItemId}；一个项目同一时刻只能派发一个任务` };
    }
    const conflictingItem = session.workItems.find((candidate) => (
      candidate.id !== item.id && ['running', 'validating'].includes(candidate.status)
    ));
    if (conflictingItem) return { ok: false, error: `工作项 ${conflictingItem.id} 仍在执行，不能并行派发另一个任务 AI` };
    if (!['planned', 'waiting-dependencies', 'waiting-decision', 'paused', 'failed'].includes(item.status)) {
      return { ok: false, error: `工作项 ${item.id} 当前状态 ${item.status} 不允许派发` };
    }
    const dependenciesReady = item.dependencies.every((dependency) => (
      session.workItems.find((candidate) => candidate.id === dependency)?.status === 'completed'
    ));
    if (!dependenciesReady) {
      return { ok: false, error: '工作项依赖尚未全部完成，不能派发' };
    }
    const stageDependencyError = projectWorkItemSubgoalDependencyError(session, item);
    if (stageDependencyError) return { ok: false, error: stageDependencyError };
    if (item.requirementsVersion !== projectRequirementsVersion(session)
      || item.authorizationVersion !== projectAuthorizationVersion(session)
      || item.executionProtocolVersion !== CURRENT_PROJECT_EXECUTION_PROTOCOL_VERSION) {
      return { ok: false, error: '工作项不是当前需求、授权或执行协议版本，必须重新创建后再派发' };
    }
    if (!item.complexityAssessment) return { ok: false, error: '工作项缺少派发前复杂度评估' };
    if (normalizeProjectStageAcceptanceCoverage(item.contract.stageAcceptanceCoverage).length === 0) {
      return {
        ok: false,
        error: 'stage-closure-evidence-mapping-missing：工作项缺少阶段验收映射；请先用 task-update 补充 contract.stageAcceptanceCoverage，禁止通过重复收口任务绕过',
      };
    }
    if (item.complexityAssessment.decision !== 'single-task') {
      return { ok: false, error: '该工作项必须先拆成更聚焦的顺序任务，不能直接派发' };
    }
    const stageScopeError = projectWorkItemStageScopeError(session, item.subgoalId, [
      ...item.contract.stopWhen,
      ...item.contract.validation,
    ]);
    if (stageScopeError) return { ok: false, error: stageScopeError };

    const taskRuntime = await ensureProjectTaskRuntime(session.id);
    if (!taskRuntime.ok || !taskRuntime.terminal) return { ok: false, error: taskRuntime.error || '任务 AI 未就绪' };
    const supervisorRuntime = await ensureProjectSupervisorRuntime(session.id);
    if (!supervisorRuntime.ok || !supervisorRuntime.lane) return { ok: false, error: supervisorRuntime.error || '监督 AI 未就绪' };
    const taskTerminal = taskRuntime.terminal;
    const lane = supervisorRuntime.lane;
    if (projectSupervisorDecisionGuardMatchesWorkItem(session, item, lane)) {
      return {
        ok: false,
        error: '当前专属监督仍处于同一工作项、需求、授权和合同的协议纠错暂停；必须先实质更新工作项合同或版本，不能仅重复派发',
      };
    }
    const agentState = (window as any).__wmux_getAgentStates?.()?.[taskTerminal.surfaceId];
    if (Number(agentState?.runDepth || 0) > 0) {
      return { ok: false, error: '任务 AI 仍有内部线程运行；必须等待 runDepth=0 后再切换工作项' };
    }
    const activity = remoteTerminalActivity(taskTerminal.surfaceId, true).activityState;
    if (activity === 'working') return { ok: false, error: '任务 AI 仍在工作，不能重复派发或切换工作项' };
    const buffer = surfaceTerminalRegistry.get(taskTerminal.surfaceId)?.buffer.active;
    if (buffer && hasPendingTerminalInput(buffer)) {
      return { ok: false, error: '任务 AI 输入区已有未提交内容，不能覆盖或追加派发' };
    }

    const previousLane = lane;
    const alreadyAssigned = item.status === 'waiting-decision'
      && item.supervisorLaneId === lane.id
      && item.workerSurfaceId === taskTerminal.surfaceId
      && typeof item.assignmentVersion === 'number'
      && lane.projectAssignmentVersion === item.assignmentVersion
      && supervisorLaneControlState(lane) === 'active'
      && lane.currentTask === item.contract.objective;
    if (alreadyAssigned) {
      finalizeProjectRuntimeRecoveryAfterAssignment(
        session.id,
        '项目 AI 复用已确认的活动监督绑定',
      );
      reconcileProjectExecutionResponsibility(session.id);
      return {
        ok: true,
        alreadyAssigned: true,
        workItemId: item.id,
        laneId: lane.id,
        surfaceId: taskTerminal.surfaceId,
        awaitingSupervisor: true,
      };
    }
    const assignmentVersion = (item.assignmentVersion || 0) + 1;
    const historicallyDelivered = projectWorkItemHistoricallyDelivered(item);
    const supervisorAssignment = buildProjectSupervisorAssignment(session, item);
    store.updateSurface(taskTerminal.workspaceId, taskTerminal.paneId, taskTerminal.surfaceId, {
      projectManagerProjectId: session.id,
      projectManagerWorkItemId: item.id,
      customTitle: '任务 AI',
    });
    store.updateLane(lane.id, {
      projectWorkItemId: item.id,
      projectAssignmentVersion: assignmentVersion,
      projectAssignmentConfirmedVersion: undefined,
      label: item.title,
      currentTask: item.contract.objective,
      ...(lane.supervisorDecisionErrorGuard?.blocked ? { supervisorDecisionErrorGuard: undefined } : {}),
      projectTaskContractPending: !historicallyDelivered,
      projectTaskBatch: undefined,
      awaitingReview: true,
      autoDecisionLimitReached: false,
      config: {
        ...effectiveSupervisorLaneConfig(lane),
        taskGoal: supervisorAssignment.objective,
        taskDescription: supervisorAssignment.description,
        preconditions: supervisorAssignment.effectivePreconditions.join('；'),
        supervisorNotes: supervisorAssignment.supervisorNotes.join('；'),
        stopWhen: [...item.contract.stopWhen, ...item.contract.validation].join('；'),
        stopWhenKind: 'concrete',
        waitForNextDirection: true,
        taskWorkMode: item.taskWorkMode || 'single-thread',
        maxChildThreads: MAX_TASK_CHILD_THREADS,
        supervisorMayApproveThreads: true,
        parallelizableOperations: [],
        serializedOperations: [],
        planRevision: (effectiveSupervisorLaneConfig(lane).planRevision || 0) + 1,
      },
    });
    const mutation = store.applyProjectManagerAction({
      type: 'update-work-item',
      workItemId: item.id,
      patch: {
        status: 'waiting-decision',
        supervisorLaneId: lane.id,
        workerSurfaceId: taskTerminal.surfaceId,
        assignmentVersion,
        latestBlocker: historicallyDelivered
          ? '等待专属监督核对历史执行证据；禁止自动重发主任务'
          : '等待专属监督首次派发中性成果包',
      },
    }, session.id);
    if (!mutation.ok) {
      store.updateLane(lane.id, previousLane);
      store.updateSurface(taskTerminal.workspaceId, taskTerminal.paneId, taskTerminal.surfaceId, {
        projectManagerWorkItemId: taskTerminal.surface.projectManagerWorkItemId,
        customTitle: taskTerminal.surface.customTitle,
      });
      return mutation;
    }
    store.resumeSupervisorLane(lane.id, `项目 AI 已交付工作项 ${item.id}，恢复专属监督处理首次派发`);
    const currentSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
    const activeSession = { ...currentSession, activeWorkItemId: item.id, updatedAt: Date.now() };
    replaceProjectManagerSession(activeSession);
    useStore.getState().appendProjectManagerEvent({
      kind: 'supervisor-status',
      workItemId: item.id,
      summary: `工作项已交给专属监督，等待监督处理主任务：${item.title}`,
      payload: {
        laneId: lane.id,
        surfaceId: taskTerminal.surfaceId,
        assignmentVersion,
        historicallyDelivered,
      },
    }, session.id);
    reconcileSatisfiedProjectBindingRecoveryTransitions(session.id);
    finalizeProjectRuntimeRecoveryAfterAssignment(
      session.id,
      '项目 AI 已重新派发工作项并建立活动监督绑定',
    );
    reconcileProjectExecutionResponsibility(session.id);
    await (window as any).wmux?.projectManager?.saveSession?.(
      useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || activeSession,
    );
    const currentLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane;
    queueSupervisorControlMessage(currentLane, [
      historicallyDelivered
        ? '[项目 AI 已交付历史工作项｜等待监督恢复裁决]'
        : '[项目 AI 已交付工作项｜等待监督首次派发]',
      historicallyDelivered
        ? '[角色链硬边界] 历史事件表明主任务 AI 已收到过该合同。禁止自动重发完整主任务；先读取主任务当前状态与证据。证据不足但所需检查仍在当前项目和授权内时，不得 needs-human，也不得要求项目 AI 重建同一 assignment；应提交 coverage=bounded-batch、带明确 evidenceExpectations 的 diagnostic/rework 批次，让任务 AI 只补最小证据缺口。只有真实外部条件、用户信息或高风险授权缺失时才 needs-human。'
        : '[角色链硬边界] 主任务 AI 尚未收到当前成果合同。项目 AI 无权写入主任务；只有你提交首次 continue 后，控制层才会发送中性成果包。',
      '你不是执行者，禁止创建或修改实现文件、编写代码、编译、运行实现/测试，禁止在监督隔离目录复制实现。',
      buildProjectSupervisorBriefing(supervisorAssignment),
      `当前并行边界：${item.taskWorkMode === 'multi-thread' ? '允许内部并行' : '要求串行'}。如任务复杂度、共享资源或运行证据变化，可在 continue/rework 时用 --task-work-mode multi-thread 开放并行或用 single-thread 恢复串行；任务 AI 自行决定是否并行和内部如何分工。`,
      historicallyDelivered
        ? '先运行 wmux context 并只读核对主任务终端；不得把恢复动作当成首次派发。'
        : `先运行 wmux context；确认合同与任务状态后，把中性单成果批次 JSON 写入当前监督隔离目录的 .wmux/tmp/<唯一文件名>.json，再使用 wmux supervisor decide --surface ${taskTerminal.surfaceId} --outcome continue --task-file <文件> --task-work-mode ${item.taskWorkMode || 'single-thread'} 首次派发。`,
      '同一任务 AI 和监督通道将跨工作项复用。你负责 continue、rework、complete 或 needs-human；只有需要改变总计划或触及用户边界时才交回项目 AI。',
      '任务 AI 只收到中性成果包，不知道项目 AI 或监督 AI；除控制层生成的执行模式外，不得向任务端注入角色、路由、预算或工作项 ID。',
    ].filter(Boolean).join('\n'), item.title, false, `project-assignment:${assignmentVersion}`, assignmentVersion);
    return {
      ok: true,
      workItemId: item.id,
      laneId: lane.id,
      surfaceId: taskTerminal.surfaceId,
      assignmentVersion,
      awaitingSupervisor: true,
      contractPending: !historicallyDelivered,
    };
  }
  if (action === 'record-execution') {
    const workItemId = String(params?.workItemId || '').trim();
    const item = session.workItems.find((candidate) => candidate.id === workItemId);
    if (!item) return { ok: false, error: `任务不存在：${workItemId}` };
    const proposal = params?.proposal || params;
    const contractViolation = projectContractViolation(item.contract, {
      instruction: String(proposal.action || ''),
      command: String(proposal.command || ''),
      changedFiles: projectStringArray(proposal.changedFiles),
      testCommand: String(proposal.testCommand || '') || undefined,
      retry: proposal.retry === true,
    });
    if (contractViolation) return { ok: false, guard: 'reject', error: contractViolation };
    const guard = evaluateProjectExecutionGuard({
      history: item.executionHistory,
      proposal: {
        action: String(proposal.action || ''),
        command: String(proposal.command || ''),
        error: String(proposal.error || '') || undefined,
        changedFiles: projectStringArray(proposal.changedFiles),
        diffSummary: String(proposal.diffSummary || ''),
        evidence: String(proposal.evidence || ''),
        workspaceVersion: String(proposal.workspaceVersion || ''),
        testCommand: String(proposal.testCommand || '') || undefined,
        testResult: String(proposal.testResult || '') || undefined,
        fullSuite: proposal.fullSuite === true,
        now: Date.now(),
      },
      budget: item.contract.budget,
      startedAt: item.startedAt,
    });
    store.applyProjectManagerAction({ type: 'record-execution', workItemId, record: guard.record }, session.id);
    if (guard.decision !== 'allow') {
      store.applyProjectManagerAction({
        type: 'update-work-item',
        workItemId,
        patch: {
          status: guard.decision === 'pause' ? 'paused' : 'waiting-decision',
          latestBlocker: guard.reason,
        },
      }, session.id);
      const guardEvent = {
        kind: 'guard-triggered' as const,
        workItemId,
        summary: guard.reason || '执行护栏已触发',
        payload: {
          decision: guard.decision,
          attentionRequired: guard.decision === 'pause',
        },
      };
      if (guard.decision === 'pause') await appendRecordedProjectEvent(session, guardEvent);
      else store.appendProjectManagerEvent(guardEvent, session.id);
    }
    await (window as any).wmux?.projectManager?.saveSession?.(
      useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
    );
    return { ok: guard.decision === 'allow', guard: guard.decision, error: guard.reason, record: guard.record };
  }
  if (action === 'pause') {
    if (session.status !== 'active' && session.status !== 'waiting') return { ok: false, error: '项目当前状态不能暂停' };
    const reason = String(params?.reason || '由项目管理 AI 暂停');
    const userDecision = await requestProjectPauseUserDecision(session.id, reason);
    return userDecision.ok
      ? {
          ok: true,
          userActionRequired: true,
          question: userDecision.question,
          message: '项目已停止自动推进，并向用户展示带推荐方案的处理框。',
        }
      : userDecision;
  }
  if (action === 'resume') {
    if (session.status !== 'paused' && session.status !== 'waiting') return { ok: false, error: '只有暂停或等待中的项目可以恢复' };
    const progress = await scanProjectProgressForReview(session.id, '项目恢复执行前检查项目现状');
    const progressSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
    const reviewError = projectProgressReviewError(progressSession);
    if (!progress.ok || reviewError) {
      return { ok: false, error: reviewError || progress.error || '项目进度同步失败，不能恢复旧合同' };
    }
    const alignment = await ensureProjectRequirementAlignment(session.id, '项目管理 AI 尝试在需求未充分对齐时恢复项目');
    if (alignment.triggered || alignment.alignmentRequired || alignment.awaitingDefinitionUpdate) {
      return {
        ok: false,
        error: alignment.awaitingDefinitionUpdate
          ? `用户答复尚未写回项目定义；请先执行 wmux project update --project ${session.id}，不能直接恢复`
          : alignment.alignmentRequired
            ? `项目尚未提交首次需求充分性结论；需求充分时先执行 wmux project alignment-confirm --project ${session.id}，需求不足时执行 wmux project ask --project ${session.id}`
            : '项目需求尚未充分对齐；已向桌面和飞书发送带推荐项的问题，用户答复前不能恢复',
        question: alignment.question,
      };
    }
    const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
    const orientationError = projectOrientationReviewError(current);
    if (orientationError) return { ok: false, error: orientationError };
    const activeGoal = activeProjectGoal(current);
    if (activeGoal.status === 'achieved') {
      return { ok: false, error: '当前主目标已经完成，请先通过 mode=pivot 切换新的主目标' };
    }
    if (!projectHasRunnableGoalPlan(current)) {
      return {
        ok: false,
        error: `当前主目标尚未建立阶段计划；请先执行 wmux project goal-plan --project ${session.id}，再恢复执行`,
      };
    }
    const staleTask = current.workItems.find((item) => (
      item.goalId === activeGoal.id
      && !['completed', 'stopped'].includes(item.status)
      && (item.requirementsVersion !== projectRequirementsVersion(current)
        || item.authorizationVersion !== projectAuthorizationVersion(current))
    ));
    if (staleTask) {
      return {
        ok: false,
        error: `任务 ${staleTask.id} 仍绑定旧需求或授权版本；请先用 task-update 显式重绑（rebindCurrentRequirements=true）或停止该任务`,
      };
    }
    const result = store.applyProjectManagerAction({
      type: 'resume-project',
      reason: String(params?.reason || '由项目管理 AI 恢复'),
      acceptRequirementsVersion: true,
    }, session.id);
    for (const recoveryKey of [...managedAgentRecoveryFailures]) {
      if (recoveryKey.startsWith(`${session.id}:`)) managedAgentRecoveryFailures.delete(recoveryKey);
    }
    resumeEligibleProjectSupervisorLanes(session.id, '项目管理会话已恢复');
    scheduleProjectProgressCheck(session.id);
    const persisted = await persistProjectManagerMutation(result, session.id);
    await processProjectAgentReconfiguration(session.id);
    return persisted;
  }
  if (action === 'complete') {
    const userAcceptanceEventId = String(params?.userAcceptanceEventId || '').trim();
    const userAcceptanceEvent = userAcceptanceEventId
      ? session.events.find((event) => event.id === userAcceptanceEventId)
      : undefined;
    const evidence = String(params?.evidence || '').trim()
      || (userAcceptanceEvent
        ? `用户最终接受当前效果：${String(userAcceptanceEvent.payload?.answer || userAcceptanceEvent.summary)}`
        : '');
    const activeGoal = activeProjectGoal(session);
    const completion = normalizeProjectCompletionResult({
      summary: String(params?.summary || evidence || '').trim(),
      validation: activeGoal.doneWhen,
      evidence,
      criteria: Array.isArray(params?.criteria) ? params.criteria : undefined,
      completedAt: Date.now(),
    } as ProjectCompletionResult);
    const completionResult = store.applyProjectManagerAction({
      type: 'complete-current-goal',
      evidence,
      completion,
      ...(userAcceptanceEventId ? { userAcceptanceEventId } : {}),
    }, session.id);
    const acceptancePolicy = projectGoalUserAcceptancePolicy(activeGoal);
    const requiredAcceptanceReady = acceptancePolicy === 'always'
      && completionResult.error === PROJECT_USER_ACCEPTANCE_REQUIRED_ERROR;
    const gapAcceptanceReady = acceptancePolicy === 'on-gap'
      && !projectFinalAcceptanceEligibilityError(session);
    if (!completionResult.ok && !userAcceptanceEventId
      && (requiredAcceptanceReady || gapAcceptanceReady)) {
      const question = await requestProjectFinalAcceptance(
        session,
        requiredAcceptanceReady ? 'required' : 'gap',
      );
      if (question) {
        return {
          ok: true,
          userActionRequired: true,
          question,
          message: requiredAcceptanceReady
            ? '项目实现与验证门禁已经满足；按当前策略进入用户最终验收。'
            : '项目实现工作已经全部结束，但仍有中途暂缓、跳过或长期缺失的验证；已进入最终完成确认。',
        };
      }
    }
    const persisted = await persistProjectManagerMutation(completionResult, session.id);
    if (completionResult.ok && userAcceptanceEventId) {
      const targetLanes = useStore.getState().supervisor.lanes.filter((lane) => (
        lane.projectManagerProjectId === session.id
      ));
      const workerSurfaceIds = new Set<string>([
        ...targetLanes.map((lane) => lane.surfaceId).filter(Boolean),
        ...session.workItems.map((item) => item.workerSurfaceId).filter((surfaceId): surfaceId is string => !!surfaceId),
      ]);
      closeStoppedSupervisorSurfaces(targetLanes);
      for (const lane of targetLanes) store.stopSupervisorLane(lane.id, '用户接受当前最终效果，当前主目标已结束');
      for (const surfaceId of workerSurfaceIds) closeLiveSurfaceById(surfaceId as SurfaceId);
    }
    return persisted;
  }
  if (action === 'stop') {
    const emergency = params?.emergency === true;
    if (emergency) {
      return { ok: false, error: '紧急停止只能由用户在专用项目管理对话中明确确认后执行' };
    }
    const result = store.applyProjectManagerAction({ type: 'stop-project', reason: String(params?.reason || '由项目管理 AI 停止'), emergency }, session.id);
    try {
      return await persistProjectManagerMutation(result, session.id);
    } finally {
      if (result.ok) await stopManagedProjectRuntime(session, '项目管理会话已停止');
    }
  }
  if (action === 'reply') {
    const message = String(params?.message || '').trim();
    if (!message) return { ok: false, error: '回复内容不能为空' };
    return persistProjectManagerMutation(store.applyProjectManagerAction({
      type: 'reply',
      correlationId: String(params?.correlationId || '') || undefined,
      message,
    }, session.id), session.id);
  }
  return { ok: false, error: `不支持的项目管理动作：${action}` };
}

export function initPipeBridge(): void {
  const w = window as any;
  projectManagerDeliveryGeneration += 1;
  managedAgentWatchdogGeneration += 1;
  clearTaskInputRecoveryWatches();
  w.__wmux_noteManagedAgentHook = (event: any) => handleManagedAgentHookEvent(event);
  w.__wmux_noteManagedAgentOutput = (surfaceId: string, data: string) => {
    handleManagedAgentOutput(String(surfaceId || ''), String(data || ''));
  };
  w.__wmux_reportProjectAgentLimit = (surfaceId: string, text: string) => {
    const target = managedProjectAgentTarget(String(surfaceId || ''));
    return target ? reportProjectAgentProviderLimit(target, String(text || '')) : false;
  };
  w.__wmux_clearManagedAgentWatchdog = (surfaceId: string) => {
    clearManagedAgentWatchdog(String(surfaceId || ''));
  };

  w.__wmux_queueProjectManagerRuntimeRecovery = (params: any) => {
    const projectId = String(params?.projectId || '').trim();
    let session = useStore.getState().projectManagers.find((candidate) => candidate.id === projectId);
    if (!session || ['completed', 'stopped'].includes(session.status)) return false;
    if (params?.role === 'supervisor' || params?.role === 'task') {
      const laneId = String(params?.laneId || '').trim();
      const lane = useStore.getState().supervisor.lanes.find((candidate) => (
        candidate.id === laneId
        && candidate.projectManagerProjectId === projectId
        && supervisorLaneControlState(candidate) === 'active'
      ));
      const surfaceId = String(params?.surfaceId || (
        params.role === 'supervisor' ? lane?.supervisorSurfaceId : lane?.surfaceId
      ) || '').trim();
      const target = surfaceId ? managedProjectAgentTarget(surfaceId) : undefined;
      if (!target || target.lane?.id !== lane?.id) return false;
      const runtime = clearManagedAgentWatchdog(surfaceId) || beginManagedAgentTurn({
        surfaceId,
        role: params.role,
        generation: ++managedAgentWatchdogGeneration,
        now: Date.now(),
        policy: managedAgentPolicy(target),
        sourceTask: String(params?.detail || ''),
      });
      void forceRecoverManagedAgent(target, runtime);
      return true;
    }
    if (params?.role === 'manager') {
      if (params?.watchdogRecovery === true) {
        reconcileProjectExecutionResponsibility(projectId);
        session = useStore.getState().projectManagers.find((candidate) => candidate.id === projectId);
        if (!session || !classifyProjectWatchdogScenario(session, {
          hasPendingManagerDelivery: (session.pendingManagerDeliveries || []).length > 0
            || pendingProjectManagerDeliveries.some((delivery) => delivery.sessionId === session?.id),
        }).recoverManagerRuntime) return false;
      }
      if (projectManagerRuntimeRecoveries.has(projectId)) return true;
      projectManagerRuntimeRecoveries.add(projectId);
      void (async () => {
        const recoverySession = useStore.getState().projectManagers
          .find((candidate) => candidate.id === projectId);
        if (!recoverySession || (params?.watchdogRecovery === true
          && !classifyProjectWatchdogScenario(recoverySession, {
            hasPendingManagerDelivery: (recoverySession.pendingManagerDeliveries || []).length > 0
              || pendingProjectManagerDeliveries.some((delivery) => delivery.sessionId === recoverySession.id),
          }).recoverManagerRuntime)) return;
        queueProjectManagerDelivery([
          '[项目 AI 故障恢复上下文｜新会话优先读取]',
          `项目：${recoverySession.id} · ${recoverySession.projectDir}`,
          `故障原因：${String(params?.detail || '原项目 AI 已退出')}`,
          `当前状态：${recoverySession.status}`,
          '控制层正在重建全新的项目 AI 会话；不得将原 PowerShell 终端当作 Agent 继续投递。',
          `新会话收到本消息后，先运行 wmux project status --project ${recoverySession.id} 读取持久状态和最近事件；核对故障影响后，再决定恢复原监督链或重建监督与任务 AI。`,
          recoverySession.status === 'paused'
            ? '项目在故障处理完成前保持暂停，不要绕过持久化项目状态盲目继续。'
            : '现有监督链按持久状态继续；核对完成前不要新增、改派或绕过监督链直接投递任务。',
        ].join('\n'), recoverySession.id, { priority: true });
        const runtime = await ensureProjectManagerRuntime(projectId, { forceRestart: true });
        if (!runtime.ok) {
          console.warn('[project-manager] failed to rebuild exited manager runtime', runtime.error);
          await reportProjectRuntimeFailureForUserDecision(
            session.id,
            'manager-runtime-failed',
            runtime.error || '项目 AI 运行时重建失败',
          );
          return;
        }
        const current = useStore.getState().projectManagers.find((candidate) => candidate.id === projectId);
        if (!current || ['completed', 'stopped'].includes(current.status)) return;
        if (params?.watchdogRecovery === true) {
          await appendRecordedProjectEvent(current, {
            kind: 'recovery-restored',
            summary: '项目 AI 运行时已自动重建并恢复结构化项目上下文',
            payload: {
              role: 'manager',
              recoveryKey: String(params?.recoveryKey || ''),
              resolvedAttentionKinds: ['guard-triggered'],
            },
          });
        }
      })().catch((error) => {
        console.warn('[project-manager] manager runtime recovery failed', error);
      }).finally(() => {
        projectManagerRuntimeRecoveries.delete(projectId);
      });
      return true;
    }
    return false;
  };

  pendingProjectManagerDeliveries.splice(0);
  for (const acknowledgement of [...pendingTaskPromptAcknowledgements.values()]) {
    acknowledgement.finish(false);
  }
  pendingTaskPromptAcknowledgements.clear();
  supervisorDeliveriesInFlight.clear();
  projectManagerDeliveryScheduled = false;
  projectManagerDeliverySurfacesInFlight.clear();
  projectManagerRuntimeRecoveries.clear();
  projectAgentReconfigurationRuns.clear();
  projectTaskRuntimeEnsureRuns.clear();
  projectAuxiliaryRuntimeEnsureRuns.clear();
  projectSupervisorRuntimeEnsureRuns.clear();
  projectManagerRuntimeEnsureRuns.clear();
  retiredProjectSupervisorRuntimes.clear();
  rollbackInterruptedProjectSupervisorRuntimeHandovers();
  managedAgentRecoveries.clear();
  managedAgentRecoveryFailures.clear();
  deletingProjectManagerSessions.clear();
  projectManagerRecoveryChoice = 'pending';
  projectManagerRecoveryMutationInFlight = false;
  for (const timer of projectProgressTimers.values()) globalThis.clearTimeout(timer);
  projectProgressTimers.clear();
  for (const timer of projectDeadlockRetryTimers.values()) globalThis.clearTimeout(timer);
  projectDeadlockRetryTimers.clear();
  if (projectLivenessWatchdogTimer) globalThis.clearTimeout(projectLivenessWatchdogTimer);
  projectLivenessWatchdogTimer = undefined;
  for (const timer of managedAgentWatchdogTimers.values()) globalThis.clearTimeout(timer);
  managedAgentWatchdogTimers.clear();
  managedAgentWatchdogs.clear();
  managedAgentOutputTails.clear();
  savingProjectManagerSessions.clear();
  projectDeadlockEscalations.clear();
  for (const timer of projectAlignmentTimers.values()) globalThis.clearTimeout(timer);
  projectAlignmentTimers.clear();
  for (const timer of projectRuntimeOrphanCleanupTimers.values()) globalThis.clearTimeout(timer);
  projectRuntimeOrphanCleanupTimers.clear();
  hydrateProjectManagerDeliveries(useStore.getState().projectManagers);
  for (const restoredSession of useStore.getState().projectManagers) {
    const session = reconcileSatisfiedProjectBindingRecoveryTransitions(
      restoredSession.id,
      { persist: true },
    ) || restoredSession;
    const restoredAttention = activeProjectManagerAttentionEvent(session.events);
    const unresolvedPause = unresolvedProjectPauseForUserDecision(session);
    if (restoredAttention && !unresolvedPause) notifyProjectManagerAttention(session, restoredAttention);
    scheduleProjectProgressCheck(session.id);
    queueMicrotask(() => {
      void (async () => {
        if (['runtime-recovery', 'verification-limited'].includes(
          session.pendingUserQuestion?.reasonCode || '',
        )) {
          await reconcileRecoveredProjectQuestion(session.id, 'application-restart');
        } else if (unresolvedPause) {
          await requestProjectPauseUserDecision(session.id, unresolvedPause.summary);
        }
        const afterQuestionRecovery = useStore.getState().projectManagers
          .find((candidate) => candidate.id === session.id) || session;
        const pausedLaneReconciled = await recoverPausedWorkItemActiveLaneConflict(afterQuestionRecovery);
        const current = pausedLaneReconciled
          || useStore.getState().projectManagers.find((candidate) => candidate.id === session.id)
          || afterQuestionRecovery;
        finalizeProjectRuntimeRecoveryAfterAssignment(
          current.id,
          '控制层初始化时确认恢复后的活动监督绑定仍然有效',
        );
        reconcileProjectExecutionResponsibility(current.id);
        await processProjectAgentReconfiguration(current.id);
        await ensureProjectDeadlockRecovery(
          current.id,
          '控制层初始化时发现活动项目没有可继续的执行链',
        );
        scheduleProjectRuntimeOrphanCleanup(
          current.id,
          '控制层初始化时回收未被当前工作项或监督 lane 引用的历史项目终端',
        );
      })().catch((error) => console.warn('[project-manager] restored project continuation failed', error));
    });
  }
  scheduleProjectLivenessWatchdog();
  w.__wmux_projectManagerRequest = (params: any) => handleProjectManagerRequest(params);
  w.__wmux_flushProjectManagerDeliveries = () => flushProjectManagerDeliveries();
  w.__wmux_projectManagerRemoteControl = async (params: any) => {
    const action = String(params?.action || '');
    let store = useStore.getState();
    if (action === 'status') {
      for (const session of store.projectManagers) {
        reconcileProjectExecutionResponsibility(session.id);
      }
      store = useStore.getState();
      const selected = projectSessionForParams(params);
      return {
        ok: true,
        session: selected ? projectManagerSessionView(selected) : null,
        projects: store.projectManagers.map(projectManagerSessionView),
        recoveryChoice: projectManagerRecoveryChoice,
      };
    }
    if (action === 'recovery-candidates') {
      const runtimeRecovery = params?.mode === 'runtime';
      if (!runtimeRecovery && (store.projectManagers.length > 0 || projectManagerRecoveryChoice !== 'pending')) {
        return {
          ok: true,
          candidates: [],
          recoveryChoice: store.projectManagers.length > 0 ? 'active' : projectManagerRecoveryChoice,
        };
      }
      const listActiveSessions = (window as any).wmux?.projectManager?.listActiveSessions;
      if (typeof listActiveSessions !== 'function') {
        return { ok: false, error: '项目恢复接口尚未就绪，请重启 wmux 后再试' };
      }
      const persisted = await listActiveSessions();
      const activeProjectIds = new Set(store.projectManagers.map((session) => session.id));
      const activeProjectDirectories = new Set(store.projectManagers
        .filter((session) => ['active', 'paused', 'waiting'].includes(session.status))
        .map((session) => projectDirectoryIdentity(session.projectDir)));
      const candidates = (Array.isArray(persisted) ? persisted : []).filter((session: ProjectManagerSession) => (
        !runtimeRecovery
        || (!activeProjectIds.has(session.id)
          && !activeProjectDirectories.has(projectDirectoryIdentity(session.projectDir)))
      ));
      return {
        ok: true,
        recoveryChoice: runtimeRecovery ? 'runtime' : 'pending',
        candidates: candidates.map((session: ProjectManagerSession) => ({
          id: session.id,
          projectDir: session.projectDir,
          projectName: projectDisplayName(session),
          goal: session.goal,
          status: session.status,
          workItemCount: session.workItems.length,
          executionProtocolVersion: session.executionProtocolVersion || 0,
          updatedAt: session.updatedAt,
        })),
      };
    }
    if (action === 'restore-projects') {
      if (projectManagerRecoveryMutationInFlight) {
        return { ok: false, error: '历史项目记录正在恢复或删除，请等待当前操作完成' };
      }
      projectManagerRecoveryMutationInFlight = true;
      try {
        const runtimeRecovery = params?.mode === 'runtime';
        if (!runtimeRecovery && store.projectManagers.length > 0) {
          projectManagerRecoveryChoice = 'restore';
          return {
            ok: true,
            restored: true,
            projects: store.projectManagers.map(projectManagerSessionView),
            message: '当前项目组合已经恢复。',
          };
        }
        const listActiveSessions = (window as any).wmux?.projectManager?.listActiveSessions;
        if (typeof listActiveSessions !== 'function') {
          return { ok: false, error: '项目恢复接口尚未就绪，请重启 wmux 后再试' };
        }
        const persisted = await listActiveSessions();
        const available = Array.isArray(persisted) ? persisted : [];
        const existingSessions = useStore.getState().projectManagers;
        const existingProjectIds = new Set(existingSessions.map((session) => session.id));
        const existingLiveDirectories = new Set(existingSessions
          .filter((session) => ['active', 'paused', 'waiting'].includes(session.status))
          .map((session) => projectDirectoryIdentity(session.projectDir)));
        const requestedIds = Array.isArray(params?.projectIds)
          ? [...new Set(params.projectIds.map((value: unknown) => String(value).trim()).filter(Boolean))]
          : [];
        const candidates = requestedIds.length > 0
          ? available.filter((session: ProjectManagerSession) => requestedIds.includes(session.id))
          : available;
        if (requestedIds.length > 0 && candidates.length !== requestedIds.length) {
          return { ok: false, error: '部分所选历史项目已失效，请刷新恢复列表后重试。' };
        }
        if (runtimeRecovery) {
          const conflict = candidates.find((session: ProjectManagerSession) => (
            existingProjectIds.has(session.id)
            || existingLiveDirectories.has(projectDirectoryIdentity(session.projectDir))
          ));
          if (conflict) {
            return {
              ok: false,
              error: `历史项目“${projectDisplayName(conflict)}”已在当前项目列表中，或其目录已有活动项目。请刷新恢复列表后重试。`,
            };
          }
        }
        if (candidates.length === 0) {
          if (!runtimeRecovery) projectManagerRecoveryChoice = 'skip';
          return {
            ok: true,
            restored: false,
            projects: existingSessions.map(projectManagerSessionView),
            message: '没有可恢复的项目。',
          };
        }
        const hasExplicitRecoveryAgentConfig = !!params?.agentConfig
          && typeof params.agentConfig === 'object'
          && !Array.isArray(params.agentConfig);
        const recoveryAgentConfig = normalizeProjectManagementAgentConfig(
          hasExplicitRecoveryAgentConfig
            ? params.agentConfig
            : useStore.getState().workspacePrefs.projectManagementAgents,
        );
        const rawCurrentSituations = params?.currentSituations && typeof params.currentSituations === 'object'
          ? params.currentSituations as Record<string, unknown>
          : {};
        const currentSituations = new Map<string, string>();
        for (const session of candidates) {
          const situation = String(rawCurrentSituations[session.id] || '').trim().slice(0, 12_000);
          if (situation) currentSituations.set(session.id, situation);
        }
        if (!runtimeRecovery) {
          projectManagerRecoveryChoice = 'restore';
          discardRestoredProjectRuntime();
        }
        const persistedEventIds = new Map(candidates.map((session: ProjectManagerSession) => (
          [session.id, new Set(session.events.map((event) => event.id))] as const
        )));
        const recoveredSessions = candidates.map((session: ProjectManagerSession) => ({
          ...restoredProjectManagerSession(session),
          // An explicit recovery choice replaces the old runtime configuration;
          // callers that omit it retain the project's persisted selection.
          agentConfig: hasExplicitRecoveryAgentConfig
            ? recoveryAgentConfig
            : normalizeProjectManagementAgentConfig(session.agentConfig ?? recoveryAgentConfig),
        }));
        const sessionsAtRestore = runtimeRecovery
          ? useStore.getState().projectManagers
          : [];
        const lateConflict = runtimeRecovery
          ? recoveredSessions.find((session) => (
              sessionsAtRestore.some((current) => current.id === session.id)
              || sessionsAtRestore.some((current) => (
                ['active', 'paused', 'waiting'].includes(current.status)
                && projectDirectoryIdentity(current.projectDir) === projectDirectoryIdentity(session.projectDir)
              ))
            ))
          : undefined;
        if (lateConflict) {
          return {
            ok: false,
            error: `恢复期间项目列表发生变化，“${projectDisplayName(lateConflict)}”已加载或目录已被活动项目占用。请刷新恢复列表后重试。`,
          };
        }
        useStore.getState().setWorkspacePrefs({ projectManagementAgents: recoveryAgentConfig });
        useStore.getState().restoreProjectManagers(
          runtimeRecovery ? [...sessionsAtRestore, ...recoveredSessions] : recoveredSessions,
          recoveredSessions[0]?.id,
        );
        const finishRecoveredProjects = async (): Promise<string[]> => {
          for (const session of recoveredSessions) {
            for (const event of session.events.filter((candidate) => (
              !persistedEventIds.get(session.id)?.has(candidate.id)
            ))) {
              try {
                await (window as any).wmux?.projectManager?.appendRecord?.({
                  sessionId: session.id,
                  projectDir: session.projectDir,
                  type: event.kind,
                  payload: { message: event.summary, workItemId: event.workItemId, ...(event.payload || {}) },
                });
              } catch (error) {
                console.warn('[project-manager] restored succession audit append failed', error);
              }
            }
            const unresolvedPause = unresolvedProjectPauseForUserDecision(
              useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session,
            );
            const pauseQuestionCreated = unresolvedPause
              ? (await requestProjectPauseUserDecision(session.id, unresolvedPause.summary)).ok
              : false;
            if (!pauseQuestionCreated) {
              await reconcileRecoveredProjectQuestion(session.id, 'application-restart');
            }
            const currentSituation = currentSituations.get(session.id);
            if (currentSituation) {
              const changeSignal = projectMessageChangeSignal(currentSituation);
              await appendRecordedProjectEvent(session, {
                kind: 'user-message',
                summary: currentSituation,
                payload: {
                  source: 'desktop-recovery',
                  currentSituation,
                  ...(changeSignal ? { changeSignal } : {}),
                },
              });
              if (changeSignal) {
                await requireProjectRequirementsAlignment(
                  session.id,
                  changeSignal === 'prerequisite-change'
                    ? '恢复说明表明项目级前置条件可能已变化，必须重新确认需求与权限边界'
                    : '恢复说明表明项目需求可能已变化，必须重新确认目标、范围和验收标准',
                  false,
                  true,
                );
              }
            }
            await scanProjectProgressForReview(session.id, '软件重启后恢复项目', false);
            await (window as any).wmux?.projectManager?.saveSession?.(
              useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
            );
          }
          const failures: string[] = [];
          for (const session of recoveredSessions) {
            const taskRuntime = await ensureProjectTaskRuntime(session.id);
            const auxiliaryRuntime = taskRuntime.ok
              ? await ensureProjectAuxiliaryRuntime(session.id)
              : { ok: false, error: taskRuntime.error };
            const runtime = auxiliaryRuntime.ok
              ? await ensureProjectManagerRuntime(session.id, { recoveredAfterRestart: true })
              : { ok: false, error: auxiliaryRuntime.error };
            const supervisorRuntime = runtime.ok
              ? await ensureProjectSupervisorRuntime(session.id)
              : { ok: false, error: runtime.error };
            if (supervisorRuntime.ok) continue;
            failures.push(`${session.goal}：${supervisorRuntime.error || '项目运行链启动失败'}`);
            await reportProjectRuntimeFailureForUserDecision(
              session.id,
              'manager-runtime-failed',
              supervisorRuntime.error || '项目运行链启动失败',
            );
          }
          return failures;
        };
        if (params?.backgroundRuntimeStart === true) {
          void finishRecoveredProjects().catch(async (error) => {
            const detail = String((error as Error)?.message || error || '项目恢复后台启动失败');
            for (const session of recoveredSessions) {
              try {
                await reportProjectRuntimeFailureForUserDecision(
                  session.id,
                  'manager-runtime-failed',
                  detail,
                );
              } catch (recordError) {
                console.warn('[project-manager] background recovery failure record failed', recordError);
              }
            }
          });
          store = useStore.getState();
          return {
            ok: true,
            restored: recoveredSessions.length > 0,
            projects: store.projectManagers.map(projectManagerSessionView),
            agentConfig: recoveryAgentConfig,
            runtimeStarting: true,
            message: `已恢复 ${recoveredSessions.length} 个项目，任务 AI、项目 AI 和监督 AI 正在后台启动。`,
          };
        }
        const failures = await finishRecoveredProjects();
        store = useStore.getState();
        return {
          ok: true,
          restored: recoveredSessions.length > 0,
          projects: store.projectManagers.map(projectManagerSessionView),
          agentConfig: recoveryAgentConfig,
          message: failures.length > 0
            ? `已恢复 ${recoveredSessions.length} 个项目；${failures.length} 个项目的专属项目 AI 启动失败并已暂停。`
            : `已恢复 ${recoveredSessions.length} 个项目，并分别启动专属项目 AI。`,
          ...(failures.length > 0 ? { warnings: failures } : {}),
        };
      } finally {
        projectManagerRecoveryMutationInFlight = false;
      }
    }
    if (action === 'delete-recovery-project') {
      const projectId = String(params?.projectId || '').trim();
      const runtimeRecovery = params?.mode === 'runtime';
      if (!projectId) return { ok: false, error: '必须指定要删除的历史项目记录' };
      if (!runtimeRecovery && (store.projectManagers.length > 0 || projectManagerRecoveryChoice !== 'pending')) {
        return { ok: false, error: '历史项目恢复阶段已经结束，不能从候选列表删除记录' };
      }
      if (projectManagerRecoveryMutationInFlight || deletingProjectManagerSessions.has(projectId)) {
        return { ok: false, error: '历史项目记录正在恢复或删除，请等待当前操作完成' };
      }
      const listActiveSessions = (window as any).wmux?.projectManager?.listActiveSessions;
      const deleteSession = (window as any).wmux?.projectManager?.deleteSession;
      if (typeof listActiveSessions !== 'function' || typeof deleteSession !== 'function') {
        return { ok: false, error: '项目记录删除接口尚未就绪，请重启 wmux 后再试' };
      }
      projectManagerRecoveryMutationInFlight = true;
      deletingProjectManagerSessions.add(projectId);
      try {
        const persisted = await listActiveSessions();
        const candidate = Array.isArray(persisted)
          ? persisted.find((session: ProjectManagerSession) => session.id === projectId)
          : undefined;
        if (!candidate) return { ok: false, error: '该历史项目记录已经不存在，请刷新恢复列表' };
        const currentProjects = useStore.getState().projectManagers;
        const candidateLoaded = currentProjects.some((session) => session.id === candidate.id);
        const candidateDirectoryActive = currentProjects.some((session) => (
          ['active', 'paused', 'waiting'].includes(session.status)
          && projectDirectoryIdentity(session.projectDir) === projectDirectoryIdentity(candidate.projectDir)
        ));
        if (runtimeRecovery && (candidateLoaded || candidateDirectoryActive)) {
          return { ok: false, error: '该历史项目已加载，或其目录已有活动项目，不能从恢复列表删除' };
        }
        if (!runtimeRecovery && (currentProjects.length > 0 || projectManagerRecoveryChoice !== 'pending')) {
          return { ok: false, error: '历史项目恢复状态已经变化，已取消删除' };
        }
        await deleteSession(projectId);
        return {
          ok: true,
          deletedProjectId: projectId,
          message: '历史项目管理记录已删除；项目目录、代码和业务文件未删除。',
        };
      } finally {
        deletingProjectManagerSessions.delete(projectId);
        projectManagerRecoveryMutationInFlight = false;
      }
    }
    if (action === 'skip-project-recovery') {
      if (projectManagerRecoveryMutationInFlight) {
        return { ok: false, error: '历史项目记录正在恢复或删除，请等待当前操作完成' };
      }
      projectManagerRecoveryChoice = 'skip';
      return {
        ok: true,
        recoveryChoice: projectManagerRecoveryChoice,
        message: '本次运行不恢复上次项目；历史记录仍保留，下次启动时可再次选择。',
      };
    }
    if (action === 'configure-agents') {
      const projectId = String(params?.projectId || '').trim();
      const nextConfig = normalizeProjectManagementAgentConfig(
        params?.agentConfig ?? store.workspacePrefs.projectManagementAgents,
      );
      if (!projectId || params?.setAsDefault === true) {
        useStore.getState().setWorkspacePrefs({ projectManagementAgents: nextConfig });
      }
      const projects = store.projectManagers.filter((session) => (
        !['completed', 'stopped'].includes(session.status) && (!projectId || session.id === projectId)
      ));
      if (projectId && projects.length === 0) return { ok: false, error: '当前项目不存在或已经结束' };
      if (projects.length === 0) return { ok: true, restarted: false, message: '项目管理模式 Agent 默认配置已保存。' };
      let restartedCount = 0;
      const allPendingRoles = new Set<ProjectAgentRole>();
      const failures: string[] = [];
      for (const project of projects) {
        const previousConfig = effectiveProjectAgentConfig(project);
        const roles = changedProjectAgentRoles(previousConfig, nextConfig);
        if (params?.restartManager === true && !roles.includes('manager')) roles.push('manager');
        if (project.agentIssue && !roles.includes(project.agentIssue.role)) roles.push(project.agentIssue.role);
        const requestedAt = Date.now();
        const configured = patchProjectAgentSession(project.id, {
          agentConfig: nextConfig,
          agentReconfiguration: roles.length > 0
            ? {
                status: 'applying',
                requestedAt,
                roles,
                pendingRoles: roles,
                completedRoles: [],
              }
            : undefined,
        });
        if (!configured) continue;
        await appendRecordedProjectEvent(configured, {
          kind: 'project-agent-config-updated',
          summary: roles.length > 0
            ? `项目 Agent 配置已更新，准备安全换代：${roles.join('、')}`
            : '项目 Agent 配置已保存，当前运行时无需换代',
          payload: { roles, setAsDefault: params?.setAsDefault === true },
        });
        if (roles.length === 0) continue;
        const result = await processProjectAgentReconfiguration(project.id);
        result.pendingRoles.forEach((role) => allPendingRoles.add(role));
        restartedCount += result.completedRoles.length;
        if (!result.ok) failures.push(`${project.goal}：${result.errors.join('；')}`);
      }
      if (failures.length > 0) {
        return {
          ok: true,
          failed: true,
          warnings: failures,
          pendingRoles: [...allPendingRoles],
          message: `配置已保存，但部分运行时安全换代失败：${failures.join('；')}。项目保持当前状态，请调整配置后重试。`,
        };
      }
      return {
        ok: true,
        restarted: restartedCount > 0,
        restartedCount,
        pendingRoles: [...allPendingRoles],
        message: allPendingRoles.size > 0
          ? `配置已保存；${[...allPendingRoles].join('、')} 正在执行，已安排在当前回合结束后安全换代。`
          : restartedCount > 0
            ? `配置已保存，并完成 ${restartedCount} 个项目运行时角色的安全换代。`
            : '项目 Agent 配置已保存，当前运行时无需换代。',
      };
    }
    if (action === 'save-and-exit') {
      const selected = projectSessionForParams(params);
      if (!selected) return { ok: false, error: '当前没有可保存的项目' };
      return saveProjectProgressAndExitRuntime(
        selected.id,
        String(params?.reason || '用户准备关闭项目，保存当前进度以便后续恢复').trim(),
      );
    }
    if (action === 'delete-project') {
      const projectId = String(params?.projectId || '').trim();
      const selected = projectId
        ? useStore.getState().projectManagers.find((session) => session.id === projectId) || null
        : useStore.getState().projectManager;
      if (!selected) return { ok: false, error: '当前没有可删除的项目' };
      if (deletingProjectManagerSessions.has(selected.id)) return { ok: false, error: '项目正在删除，请勿重复操作' };
      const deleteSession = (window as any).wmux?.projectManager?.deleteSession;
      if (typeof deleteSession !== 'function') {
        return { ok: false, error: '项目删除接口尚未就绪，请重启 wmux 后再试' };
      }
      deletingProjectManagerSessions.add(selected.id);
      try {
        await deleteSession(selected.id);
        teardownManagedProject(selected);
        useStore.getState().removeProjectManager(selected.id);
      } finally {
        deletingProjectManagerSessions.delete(selected.id);
      }
      return {
        ok: true,
        deletedProjectId: selected.id,
        selectedProjectId: useStore.getState().selectedProjectManagerId,
        message: '项目已从项目组合中删除；项目目录和业务文件未删除。',
      };
    }
    if (action === 'logs') {
      const selected = projectSessionForParams(params);
      return { ok: true, events: selected?.events.slice(-50).reverse() || [] };
    }
    if (action === 'answer-question') {
      return answerProjectManagerUserQuestion(params);
    }
    if (action === 'pause-all-projects' || action === 'resume-all-projects') {
      return setProjectPortfolioPaused(
        action === 'pause-all-projects',
        String(params?.reason || (action === 'pause-all-projects' ? '用户全局暂停项目组合' : '用户全局恢复项目组合')),
      );
    }
    if (action === 'start') {
      const projectDir = String(params?.projectDir || '').trim();
      const projectName = String(params?.projectName || '').trim()
        || projectDir.replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean).at(-1)
        || '未命名项目';
      const projectScope = String(params?.projectScope || '').trim()
        || `仅限项目目录 ${projectDir} 内与当前项目直接相关的工作`;
      const goal = String(params?.goal || '').trim();
      const preconditions = projectStringArray(params?.preconditions);
      const supervisorNotes = projectStringArray(params?.supervisorNotes)
        .slice(0, 20).map((note) => note.slice(0, 4000));
      const planFiles = projectPlanFileSnapshots(params?.planFiles);
      const doneWhen = projectStringArray(params?.doneWhen);
      if (params?.userAcceptancePolicy !== undefined
        && !PROJECT_USER_ACCEPTANCE_POLICIES.includes(String(params.userAcceptancePolicy) as ProjectUserAcceptancePolicy)) {
        return { ok: false, error: 'userAcceptancePolicy 必须是 always、on-gap 或 not-required' };
      }
      const userAcceptancePolicy = normalizeProjectUserAcceptancePolicy(params?.userAcceptancePolicy);
      const verificationInput = projectVerificationPoliciesInput(params?.verificationPolicies, doneWhen);
      if (!verificationInput.policies) return { ok: false, error: verificationInput.error || '验证策略无效' };
      const sourceTerminalId = String(params?.sourceTerminalId || '').trim();
      let sourceTerminalContext: {
        surfaceId: string;
        label: string;
        cwd: string;
        text: string;
      } | null = null;
      if (sourceTerminalId) {
        const sourceTerminal = remoteTerminalList().find((terminal) => terminal.surfaceId === sourceTerminalId);
        if (!sourceTerminal) return { ok: false, error: '所选上下文终端已关闭或不在当前窗口，请重新选择' };
        const screen = readTerminalScreen(sourceTerminalId, 1_000);
        if (screen.error) return { ok: false, error: `无法读取所选终端对话：${screen.error}` };
        const activity = remoteTerminalActivity(sourceTerminal.surfaceId);
        sourceTerminalContext = {
          surfaceId: sourceTerminalId,
          label: sourceTerminal.label,
          cwd: sourceTerminal.cwd || '',
          text: terminalBootstrapContext(screen.text || '', sourceTerminal.label, activity.activityState),
        };
      }
      if (!projectDir && store.projectManagers.length > 0) {
        const current = projectSessionForParams(params) || store.projectManagers[0];
        if (current) {
          const taskRuntime = await ensureProjectTaskRuntime(current.id);
          if (!taskRuntime.ok) return { ok: false, error: taskRuntime.error };
          const auxiliaryRuntime = await ensureProjectAuxiliaryRuntime(current.id);
          if (!auxiliaryRuntime.ok) return { ok: false, error: auxiliaryRuntime.error };
          const runtime = await ensureProjectManagerRuntime(current.id);
          if (!runtime.ok) return { ok: false, error: runtime.error };
          const supervisorRuntime = await ensureProjectSupervisorRuntime(current.id);
          if (!supervisorRuntime.ok) return { ok: false, error: supervisorRuntime.error };
          store = useStore.getState();
          store.selectProjectManager(current.id);
          const refreshed = store.projectManagers.find((candidate) => candidate.id === current.id) || current;
          return { ok: true, restored: true, session: projectManagerSessionView(refreshed), projects: store.projectManagers.map(projectManagerSessionView) };
        }
      }
      if (!normalizeAbsolutePath(projectDir) || !goal) {
        return { ok: false, error: 'projectDir 必须是绝对路径，goal 不能为空' };
      }
      const directoryIdentity = projectDirectoryIdentity(projectDir);
      const existingProject = store.projectManagers.find((candidate) => (
        ['active', 'paused', 'waiting'].includes(candidate.status)
        && projectDirectoryIdentity(candidate.projectDir) === directoryIdentity
      ));
      if (existingProject) {
        return {
          ok: false,
          error: `该目录已绑定项目 AI“${projectDisplayName(existingProject)}”（${existingProject.id}），请进入现有项目，不要重复创建。`,
        };
      }
      if (projectManagerRecoveryChoice === 'pending') projectManagerRecoveryChoice = 'skip';
      const session = store.startProjectManager({
        projectDir, projectName, projectScope, goal, preconditions, supervisorNotes, planFiles, doneWhen,
        userAcceptancePolicy,
        verificationPolicies: verificationInput.policies,
        agentConfig: normalizeProjectManagementAgentConfig(store.workspacePrefs.projectManagementAgents),
      });
      if (sourceTerminalContext) {
        await appendRecordedProjectEvent(session, {
          kind: 'user-message',
          summary: `创建项目时导入只读终端上下文：${sourceTerminalContext.label}`,
          payload: {
            sourceSurfaceId: sourceTerminalContext.surfaceId,
            sourceLabel: sourceTerminalContext.label,
            sourceCwd: sourceTerminalContext.cwd,
            sourceContext: sourceTerminalContext.text,
            authority: 'read-only-evidence',
          },
        });
      }
      await (window as any).wmux?.projectManager?.saveSession?.(
        useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session,
      );
      await checkpointProjectProgress(session.id, '项目首次创建');
      await (window as any).wmux?.projectManager?.saveSession?.(
        useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session,
      );
      const startProjectRuntimeChain = async () => {
      const taskRuntime = await ensureProjectTaskRuntime(session.id);
      if (!taskRuntime.ok || !taskRuntime.terminal) {
        await reportProjectRuntimeFailureForUserDecision(
          session.id,
          'task-runtime-failed',
          taskRuntime.error || '任务 AI 启动失败',
        );
        return { ok: false, error: taskRuntime.error || '任务 AI 尚未就绪' };
      }
      const auxiliaryRuntime = await ensureProjectAuxiliaryRuntime(session.id);
      if (!auxiliaryRuntime.ok) {
        await reportProjectRuntimeFailureForUserDecision(
          session.id,
          'task-runtime-failed',
          auxiliaryRuntime.error || '辅助任务 AI 启动失败',
        );
        return { ok: false, error: auxiliaryRuntime.error || '辅助任务 AI 尚未就绪' };
      }
      const runtime = await ensureProjectManagerRuntime(session.id);
      if (!runtime.ok || !runtime.manager) {
        await reportProjectRuntimeFailureForUserDecision(
          session.id,
          'manager-runtime-failed',
          runtime.error || '项目 AI 启动失败',
        );
        return { ok: false, error: runtime.error || '项目 AI 尚未就绪' };
      }
      const supervisorRuntime = await ensureProjectSupervisorRuntime(session.id);
      if (!supervisorRuntime.ok || !supervisorRuntime.lane) {
        await reportProjectRuntimeFailureForUserDecision(
          session.id,
          'supervisor-runtime-failed',
          supervisorRuntime.error || '监督 AI 启动失败',
        );
        return { ok: false, error: supervisorRuntime.error || '监督 AI 尚未就绪' };
      }
      await requireProjectRequirementsAlignment(session.id, '项目首次启动，必须先完成需求充分性检测', runtime.created === true);
      const activeSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
      return { ok: true, restored: false, session: activeSession };
      };
      if (params?.backgroundRuntimeStart === true) {
        const queuedSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
        void startProjectRuntimeChain().catch(async (error) => {
          const detail = String((error as Error)?.message || error || '项目运行链后台启动失败');
          try {
            await reportProjectRuntimeFailureForUserDecision(
              queuedSession.id,
              'manager-runtime-failed',
              detail,
            );
          } catch (recordError) {
            console.warn('[project-manager] background startup failure record failed', recordError);
          }
        });
        return {
          ok: true,
          restored: false,
          session: queuedSession,
          runtimeStarting: true,
          message: '项目已添加，任务 AI、项目 AI 和监督 AI 正在后台启动。',
        };
      }
      return startProjectRuntimeChain();
    }
    if (action === 'message') {
      const selectedProject = projectSessionForParams(params);
      if (!selectedProject) return { ok: false, error: '请先在项目中心选择消息所属项目' };
      const message = String(params?.message || '').trim();
      if (!message) return { ok: false, error: '项目管理消息不能为空' };
      const changeSignal = projectMessageChangeSignal(message);
      const messageSource = String(params?.source || '').trim() === 'desktop'
        ? '桌面'
        : String(params?.chatId || '').trim()
          ? '飞书'
          : '桌面';
      let quiesce: { confirmed: string[]; failed: string[] } | undefined;
      const revokedOldRun = !!changeSignal && !['completed', 'stopped'].includes(selectedProject.status);
      if (revokedOldRun) {
        quiesce = await quiesceProjectRuntimeLanes(
          selectedProject,
          changeSignal === 'prerequisite-change'
            ? '用户消息表明项目级前置条件可能已变化，立即撤销旧版本运行授权'
            : '用户消息表明项目需求可能已变化，立即停止旧版本任务',
        );
        store = useStore.getState();
        store.applyProjectManagerAction({
          type: 'require-requirements-alignment',
          reason: changeSignal === 'prerequisite-change'
            ? '用户声明前置条件变化，项目定义写回后必须重新完成需求与权限对齐'
            : '用户声明需求变化，项目定义写回后必须重新完成需求对齐',
        }, selectedProject.id);
        if (selectedProject.status !== 'paused') {
          store.applyProjectManagerAction({
            type: 'pause-project',
            reason: changeSignal === 'prerequisite-change'
              ? '检测到用户声明前置条件变化，等待项目 AI 写回并重新对齐'
              : '检测到用户声明需求变化，等待项目 AI 写回并重新对齐',
          }, selectedProject.id);
        }
      }
      store = useStore.getState();
      const currentProject = store.projectManagers.find((candidate) => candidate.id === selectedProject.id) || selectedProject;
      store.restoreProjectManager({
        ...currentProject,
        feishuChatId: String(params?.chatId || currentProject.feishuChatId || '') || undefined,
        ...(revokedOldRun ? {
          orientation: requiredProjectOrientation(
            currentProject,
            changeSignal === 'prerequisite-change'
              ? '用户声明前置条件变化，需要按新权限边界重新建立项目认知基线'
              : '用户声明需求变化，需要按新目标与约束重新建立项目认知基线',
          ),
        } : {}),
        updatedAt: Date.now(),
      });
      store.appendProjectManagerEvent({
        kind: 'user-message',
        correlationId: String(params?.messageId || '') || undefined,
        summary: message,
        ...(changeSignal ? {
          payload: {
            changeSignal,
            quiescedLanes: quiesce?.confirmed || [],
            unconfirmedLanes: quiesce?.failed || [],
          },
        } : {}),
      }, selectedProject.id);
      await (window as any).wmux?.projectManager?.saveSession?.(
        useStore.getState().projectManagers.find((candidate) => candidate.id === selectedProject.id),
      );
      const runtime = await ensureProjectManagerRuntime(selectedProject.id);
      const manager = runtime.manager;
      if (!runtime.ok || !manager) {
        return {
          ok: false,
          error: `${runtime.error || '项目管理 AI 尚未就绪'}${revokedOldRun ? '；变更消息已记录，旧任务已保持暂停' : ''}`,
        };
      }
      deliverProjectManagerMessage([
        `[${messageSource}项目管理消息｜必须回复到对应项目会话${revokedOldRun ? '｜控制层已撤销旧运行授权' : ''}]`,
        `消息 ID：${String(params?.messageId || 'unknown')}`,
        `当前项目 ID：${selectedProject?.id || '未选择'}`,
        `当前项目目录：${selectedProject?.projectDir || '未选择'}`,
        message,
        '',
        revokedOldRun
          ? `控制层已将项目暂停并中断旧任务。该消息被识别为${changeSignal === 'prerequisite-change' ? '前置条件变化' : '需求变化'}；必须先执行 wmux project update --project ${selectedProject.id} 写回结构化定义并重新对齐，禁止直接恢复旧合同。${quiesce?.failed.length ? `以下通道未确认停止，必须通知用户处理：${quiesce.failed.join('、')}。` : ''}`
          : '',
        `请作为本项目的专属项目 AI 直接回复用户。需要执行管理动作时使用 wmux project；若消息只调整当前主目标的约束或验收，执行 wmux project update --project ${selectedProject.id} 并使用 mode=refine；若用户在同一稳定项目内切换新的最终结果，使用 mode=pivot，新建主目标版本并重新执行 goal-plan。项目范围改变时应提议另建项目，不能擅自并入。随后自主评估任务的复用、停止和重绑，不要逐项要求用户确认。最终必须执行 wmux project reply --project ${selectedProject.id} --correlation "${String(params?.messageId || 'unknown')}" --message "<回复内容>"，让回复进入该项目自己的桌面/飞书会话。`,
      ].filter(Boolean).join('\n'), runtime.created === true, selectedProject.id);
      return {
        ok: true,
        message: revokedOldRun
          ? '已记录变更并立即暂停旧任务，消息已交给项目管理 AI 重新对齐'
          : '消息已交给项目管理 AI',
      };
    }
    if (action === 'event') {
      store = useStore.getState();
      const session = projectSessionForParams(params);
      if (!session) return { ok: false, error: '当前没有项目管理会话' };
      const workItemId = String(params?.workItemId || '').trim();
      const summary = String(params?.summary || params?.eventType || '').trim().slice(0, 4000);
      const eventType = String(params?.eventType || '');
      const stageHandoff = eventType === 'supervisor.waiting-for-direction'
        && params?.payload?.handoffKind === 'stage-complete';
      const decisionRequest = eventType === 'supervisor.approval.requested'
        || (eventType === 'supervisor.waiting-for-direction' && !stageHandoff)
        || eventType === 'worker.blocked';
      store.appendProjectManagerEvent({
        kind: stageHandoff
          ? 'supervisor-handoff'
          : decisionRequest
            ? 'supervisor-decision-request'
            : 'supervisor-decision',
        workItemId: workItemId || undefined,
        summary,
        payload: { eventType, ...(params?.payload || {}) },
      }, session.id);
      const contextSummary = String(
        params?.payload?.contextSummary || (!decisionRequest ? summary : ''),
      ).trim().slice(0, 12000);
      const evidence = String(params?.payload?.evidence || '').trim().slice(0, 12000);
      const blocker = String(params?.payload?.blocker || '').trim().slice(0, 12000);
      if (workItemId && (decisionRequest || contextSummary || evidence || blocker)) {
        store.applyProjectManagerAction({
          type: 'update-work-item', workItemId,
          patch: {
            ...(stageHandoff
              ? { status: 'validating' as const, latestBlocker: undefined }
              : decisionRequest
                ? { status: 'waiting-decision' as const }
                : {}),
            ...(contextSummary ? { latestContextSummary: contextSummary } : {}),
            ...(evidence ? { latestEvidence: evidence } : {}),
            ...(!stageHandoff && (blocker || decisionRequest) ? { latestBlocker: blocker || summary } : {}),
          },
        }, session.id);
      }
      const currentProject = useStore.getState().projectManagers
        .find((candidate) => candidate.id === session.id);
      const currentWorkItem = currentProject?.workItems
        .find((candidate) => candidate.id === workItemId);
      const stage = currentWorkItem?.subgoalId
        ? activeProjectSubgoals(currentProject || session)
          .find((candidate) => candidate.id === currentWorkItem.subgoalId)
        : undefined;
      const transitionKind: ProjectSupervisorTransitionKind = stageHandoff
        ? 'stage-complete'
        : eventType === 'supervisor.waiting-for-direction'
          ? 'direction-needed'
          : eventType === 'supervisor.idle-unreported'
            ? 'supervisor-idle'
            : eventType === 'supervisor.provider-limit' || eventType === 'supervisor.delivery.failed'
              ? 'supervisor-unavailable'
              : 'decision-required';
      const transition = queueProjectSupervisorTransition({
        sessionId: session.id,
        laneId: String(params?.payload?.laneId || params?.laneId || '').trim() || `work-item:${workItemId || 'unknown'}`,
        workItemId: workItemId || undefined,
        kind: transitionKind,
        eventType,
        summary: [stage ? `${stage.title} · ${stage.outcome}` : '', summary].filter(Boolean).join('：'),
        evidence: evidence || currentWorkItem?.latestEvidence,
        contextSummary,
        instruction: stageHandoff
          ? [
              '这不是阻塞，也不需要用户确认。专属监督和任务终端保留在同一项目会话中，等待项目级验收和下一阶段续接。',
              `证据不足时把 ${workItemId || '<任务ID>'} 保持为 waiting-decision，写明待补结果并再次交给专属监督；证据充分时标记 completed，再创建覆盖完整下一阶段成果的工作项。`,
              '普通阶段续作不轮换任务终端；没有后续阶段时按目标级证据完成当前主目标。',
            ].join('\n')
          : decisionRequest
            ? `在项目既有前置条件和授权内自主裁决并更新任务方向。只有发现条件变化、超范围或高风险事项时才询问用户；存在 latestBlocker 时不得标记完成。`
            : '更新项目任务状态并决定继续、重规划、暂停或恢复；普通执行过程不要发送给用户。',
      });
      try {
        await (window as any).wmux?.projectManager?.saveSession?.(
          useStore.getState().projectManagers.find((candidate) => candidate.id === session.id),
        );
      } catch (error) {
        console.warn('[project-manager] failed to persist supervisor transition', error);
      }
      if (stageHandoff) {
        await checkpointProjectProgress(session.id, `监督完成阶段交接：${workItemId || '未知工作项'}`);
      }
      scheduleProjectProgressCheck(session.id);
      return { ok: true, transitionId: transition?.id };
    }
    store = useStore.getState();
    const session = projectSessionForParams(params);
    if (!session) return { ok: false, error: '当前没有项目管理会话' };
    if (action === 'intervene-work-item') {
      const workItemId = String(params?.workItemId || '').trim();
      const intervention = String(params?.intervention || '').trim();
      const reason = String(params?.reason || '').trim().slice(0, 1200);
      if (!workItemId) return { ok: false, error: '必须选择要干预的工作项' };
      if (intervention !== 'skip' && intervention !== 'close') {
        return { ok: false, error: '工作项干预方式必须是跳过或关闭' };
      }
      const workItem = session.workItems.find((item) => item.id === workItemId);
      if (!workItem) return { ok: false, error: `任务不存在：${workItemId}` };
      const result = store.applyProjectManagerAction({
        type: 'intervene-work-item',
        workItemId,
        intervention,
        reason,
      }, session.id);
      if (!result.ok) return result;

      const updatedSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id)
        || session;
      releaseProjectWorkItemAssignmentForReuse(
        updatedSession,
        workItemId,
        `用户${intervention === 'skip' ? '跳过' : '关闭'}工作项 ${workItem.title}；旧 assignment 已解除，项目运行时保留`,
      );

      await persistProjectManagerMutation(result, session.id);
      const runtime = await ensureProjectManagerRuntime(session.id);
      const interventionLabel = intervention === 'skip' ? '跳过' : '关闭';
      deliverProjectManagerMessage([
        `[用户干预工作项｜${interventionLabel}]`,
        `项目：${session.id} · ${session.projectDir}`,
        `当前主目标：${session.goal}`,
        `工作项：${workItem.id} · ${workItem.title}`,
        `用户理由：${reason || '未填写；仅按用户选择的干预方式处理'}`,
        '控制层已把该工作项标记为停止并解除旧 assignment；项目常驻监督与任务 AI 保留供后续工作项复用，其他工作项没有被全局暂停。',
        '',
        intervention === 'skip'
          ? '“跳过”表示本轮计划不再执行原工作项。请立即复核其依赖项和主目标完成条件，在现有授权内自主重排、调整阶段或创建必要的替代工作项；不得恢复原工作项 ID，也不要为普通重排再次询问用户。只有主目标因此无法达成且没有授权范围内的可行替代方案时，才携带事实、依据和推荐方案向用户提案。'
          : '“关闭”表示用户明确从当前计划中移除该工作项。未经用户新的明确指示，不得恢复原工作项或以等价工作项绕过此决定；请自主重排受影响的依赖项。若关闭后主目标无法达成，携带事实、影响和推荐方案向用户提案。',
        `处理完后请使用 wmux project reply --project ${session.id} --message "<已如何调整计划的摘要>"，把结果写回当前项目会话。`,
      ].join('\n'), runtime.created === true, session.id);
      return {
        ...result,
        message: runtime.ok
          ? `已${interventionLabel}“${workItem.title}”，并通知项目 AI 重排后续计划。`
          : `已${interventionLabel}“${workItem.title}”；项目 AI 当前不可用，干预通知已持久排队并会自动重试。`,
      };
    }
    if (action === 'update-definition') {
      return updateProjectDefinition(session, params, 'user');
    }
    if (action === 'update-preconditions') {
      if (['completed', 'stopped'].includes(session.status)) {
        return { ok: false, error: '已完成或停止的项目不能再修改前置条件' };
      }
      const preconditions = projectStringArray(params?.preconditions);
      const quiesce = await quiesceProjectRuntimeLanes(
        session,
        '项目前置条件已更新，停止旧假设下的任务并等待重新核对',
      );
      const result = store.applyProjectManagerAction({
        type: 'update-project-preconditions',
        preconditions,
        reason: `用户更新项目前置条件：${preconditions.join('；')}`,
      }, session.id);
      if (!result.ok) return result;
      const alignmentResult = store.applyProjectManagerAction({
        type: 'require-requirements-alignment',
        reason: '项目前置条件和授权边界已更新，需要按新版本重新完成需求充分性检测',
      }, session.id);
      if (!alignmentResult.ok) return alignmentResult;
      const progressTimer = projectProgressTimers.get(session.id);
      if (progressTimer) {
        clearTimeout(progressTimer);
        projectProgressTimers.delete(session.id);
      }
      const updated = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id);
      await (window as any).wmux?.projectManager?.saveSession?.(updated);
      try {
        await (window as any).wmux?.projectManager?.appendRecord?.({
          sessionId: session.id,
          projectDir: session.projectDir,
          type: result.event?.kind || 'project-preconditions-updated',
          payload: { message: result.event?.summary, preconditions },
        });
      } catch (error) {
        console.warn('[project-manager] failed to append prerequisite audit record', error);
      }
      const constraintNotice = [
        '[用户更新项目级前置条件｜立即重新核对]',
        `项目：${session.id} · ${session.projectDir}`,
        ...preconditions.map((condition) => `- ${condition}`),
        '这些条件是用户拥有的硬约束。不得假定已经满足；请重新检查当前规划和进行中的任务。任何依赖未满足条件的操作必须暂停，取得证据后才可继续。',
      ].join('\n');
      queueProjectManagerDelivery(constraintNotice, session.id);
      const latestStore = useStore.getState();
      for (const lane of latestStore.supervisor.lanes.filter((candidate) => (
        candidate.projectManagerProjectId === session.id && supervisorLaneControlState(candidate) !== 'stopped'
      ))) {
        const workItem = updated?.workItems.find((item) => item.id === lane.projectWorkItemId);
        latestStore.updateLane(lane.id, {
          config: {
            ...effectiveSupervisorLaneConfig(lane),
            preconditions: [...preconditions, ...(workItem?.contract.preconditions || [])].join('；'),
          },
        });
        latestStore.pauseSupervisorLane(lane.id, '项目前置条件已更新，等待项目管理 AI 按新版本重新规划');
        if (lane.supervisorSurfaceId) {
          queueSupervisorControlMessage(lane, constraintNotice);
        }
      }
      return {
        ok: true,
        event: result.event,
        session: updated,
        message: quiesce.failed.length > 0
          ? '项目前置条件已更新；监督链保持暂停，但部分任务终端未确认中断，已通知用户处理。'
          : '项目前置条件已更新；项目 AI 与监督 AI 通知均已持久排队，等待对应 Agent 空闲后确认。',
      };
    }
    if (action === 'pause' || action === 'resume' || action === 'stop') {
      const reason = String(params?.reason || `由飞书${action}`).trim();
      if (action === 'resume'
        && session.safeExit?.status === 'restoring'
        && session.status !== 'paused'
        && session.status !== 'waiting') {
        return { ok: true, restoring: true, message: '项目恢复链已经启动，正在重建认知基线和执行链。' };
      }
      if (action === 'resume' && session.safeExit?.status === 'saved') {
        const reconciled = await reconcileRecoveredProjectQuestion(session.id, 'safe-exit') || session;
        const restoring = {
          ...reconciled,
          safeExit: {
            ...reconciled.safeExit!,
            status: 'restoring' as const,
            updatedAt: Date.now(),
            error: undefined,
          },
          updatedAt: Date.now(),
        };
        replaceProjectManagerSession(restoring);
        await (window as any).wmux?.projectManager?.saveSession?.(restoring);
        const progress = await scanProjectProgressForReview(
          session.id,
          '恢复安全退出断点前核对项目目录',
          false,
        );
        if (!progress.ok) {
          const latest = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id)
            || restoring;
          const failed = {
            ...latest,
            safeExit: {
              ...reconciled.safeExit!,
              status: 'saved' as const,
              updatedAt: Date.now(),
              error: progress.error || '恢复前项目目录快照核对失败',
            },
            updatedAt: Date.now(),
          };
          replaceProjectManagerSession(failed);
          await (window as any).wmux?.projectManager?.saveSession?.(failed);
          return { ok: false, error: failed.safeExit.error };
        }
        const taskRuntime = await ensureProjectTaskRuntime(session.id);
        const auxiliaryRuntime = taskRuntime.ok
          ? await ensureProjectAuxiliaryRuntime(session.id)
          : { ok: false, error: taskRuntime.error };
        const runtime = auxiliaryRuntime.ok
          ? await ensureProjectManagerRuntime(session.id, { recoveredAfterRestart: true })
          : { ok: false, error: auxiliaryRuntime.error };
        const supervisorRuntime = runtime.ok
          ? await ensureProjectSupervisorRuntime(session.id)
          : { ok: false, error: runtime.error };
        if (!supervisorRuntime.ok) {
          const latest = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || restoring;
          const failed = {
            ...latest,
            safeExit: {
              ...reconciled.safeExit!,
              status: 'saved' as const,
              updatedAt: Date.now(),
              error: supervisorRuntime.error || '项目恢复运行时启动失败',
            },
            updatedAt: Date.now(),
          };
          replaceProjectManagerSession(failed);
          await (window as any).wmux?.projectManager?.saveSession?.(failed);
          return { ok: false, error: supervisorRuntime.error || '项目恢复运行时启动失败；安全退出记录仍已保留' };
        }
        return {
          ok: true,
          restoring: true,
          message: '项目运行时已重建，项目 AI 正在依据保存的检查点核对当前目录；核对完成后会恢复执行。',
        };
      }
      if (action === 'pause' && session.status !== 'active' && session.status !== 'waiting') {
        return { ok: false, error: '项目当前状态不能暂停' };
      }
      if (action === 'resume' && session.status !== 'paused' && session.status !== 'waiting') {
        return { ok: false, error: '只有暂停或等待中的项目可以恢复' };
      }
      if (action === 'resume' && session.pendingUserQuestion) {
        return { ok: false, error: '项目仍在等待用户答复，不能绕过澄清直接恢复' };
      }
      const confirmedRestorationSnapshot = action === 'resume'
        && session.safeExit?.status === 'restoring'
        && session.recoveryState === 'checking'
        && session.progressSync?.status === 'ready'
        && session.progressSnapshot?.fingerprint === session.progressSync.snapshotFingerprint
        && projectOrientationReady(session);
      if (action === 'resume' && !confirmedRestorationSnapshot) {
        const progress = await scanProjectProgressForReview(session.id, '用户从飞书恢复项目前检查项目现状');
        const progressSession = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
        const reviewError = projectProgressReviewError(progressSession);
        if (!progress.ok || reviewError) {
          return {
            ok: false,
            error: reviewError || progress.error || '项目进度同步失败；已交给项目 AI 复核，不能直接恢复旧合同',
          };
        }
      }
      if (
        action === 'resume'
        && projectAcceptedRequirementsVersion(session) !== projectRequirementsVersion(session)
      ) {
        return { ok: false, error: '需求或前置条件已经更新；必须先由项目管理 AI 重新规划并接受最新版本，用户恢复不能绕过该门禁' };
      }
      if (action === 'resume') {
        const alignment = await ensureProjectRequirementAlignment(session.id, '用户尝试在需求未充分对齐时恢复项目');
        if (alignment.triggered || alignment.alignmentRequired || alignment.awaitingDefinitionUpdate) {
          return {
            ok: false,
            error: alignment.awaitingDefinitionUpdate
              ? '用户答复尚未写回项目定义；请先让项目管理 AI 更新目标、范围和完成条件'
              : alignment.alignmentRequired
                ? '项目尚未提交首次需求充分性结论；请先由项目管理 AI 完成检测'
                : '项目需求尚未充分对齐；已向桌面和飞书发送带推荐项的问题，请先答复',
            question: alignment.question,
          };
        }
        const current = useStore.getState().projectManagers.find((candidate) => candidate.id === session.id) || session;
        const orientationError = projectOrientationReviewError(current);
        if (orientationError) return { ok: false, error: orientationError };
        const activeGoal = activeProjectGoal(current);
        if (activeGoal.status === 'achieved') {
          return { ok: false, error: '当前主目标已经完成，请先与项目 AI 对话并切换新的主目标' };
        }
        if (!projectHasRunnableGoalPlan(current)) {
          return { ok: false, error: '当前主目标还没有阶段计划，请先由项目 AI 完成规划' };
        }
        const staleTask = current.workItems.find((item) => (
          item.goalId === activeGoal.id
          && !['completed', 'stopped'].includes(item.status)
          && (item.requirementsVersion !== projectRequirementsVersion(current)
            || item.authorizationVersion !== projectAuthorizationVersion(current))
        ));
        if (staleTask) {
          return { ok: false, error: `任务 ${staleTask.id} 尚未由项目 AI 重绑当前需求和授权版本，不能直接恢复` };
        }
      }
      const result = action === 'pause'
        ? store.applyProjectManagerAction({ type: 'pause-project', reason }, session.id)
        : action === 'resume'
          ? store.applyProjectManagerAction({ type: 'resume-project', reason }, session.id)
          : store.applyProjectManagerAction({ type: 'stop-project', reason, emergency: params?.emergency === true }, session.id);
      if (action === 'pause') {
        for (const laneId of projectSupervisorLaneIds(session)) store.pauseSupervisorLane(laneId, '由飞书暂停项目管理会话');
      }
      if (action === 'resume') {
        resumeEligibleProjectSupervisorLanes(session.id, '由飞书恢复项目管理会话');
      }
      if (action === 'pause' || action === 'stop') {
        const timer = projectProgressTimers.get(session.id);
        if (timer) globalThis.clearTimeout(timer);
        projectProgressTimers.delete(session.id);
      } else {
        scheduleProjectProgressCheck(session.id);
      }
      try {
        await persistProjectManagerMutation(result, session.id);
      } finally {
        if (action === 'stop' && result.ok) {
          await stopManagedProjectRuntime(session, '由飞书停止项目管理会话');
        }
      }
      if (action === 'resume' && result.ok) {
        queueProjectManagerDelivery([
          '[用户已恢复项目｜立即继续执行链]',
          `项目：${session.id} · ${session.projectDir}`,
          `原因：${reason}`,
          '项目已通过当前进度、需求版本、认知基线和阶段计划门禁并切回 active。立即读取 project status，优先续接当前目标中最早可执行的未完成工作项。',
          '若工作项尚无专属监督，执行 dispatch 重建监督/任务链；恢复期先做当前工作树的有界只读现状核对，复用持久证据，禁止复跑已消费身份或重复实机操作。',
        ].join('\n'), session.id, {
          priority: true,
          dedupeKey: `project-user-resume:${session.id}`,
        });
        await processProjectAgentReconfiguration(session.id);
        return {
          ...result,
          message: '项目已恢复，项目 AI 已收到继续执行通知。',
        };
      }
      return result;
    }
    return { ok: false, error: `不支持的项目管理远程动作：${action}` };
  };

  // ─── Workspace ──────────────────────────────────────────────────────────────

  w.__wmux_createWorkspace = (params?: { title?: string; shell?: string; cwd?: string }) => {
    const store = useStore.getState();
    const id = store.createWorkspace({
      title: params?.title,
      shell: params?.shell,
      cwd: params?.cwd,
    });
    return { workspaceId: id };
  };

  w.__wmux_closeWorkspace = (id: string) => {
    useStore.getState().closeWorkspace(id as WorkspaceId);
  };

  w.__wmux_selectWorkspace = (id: string) => {
    useStore.getState().selectWorkspace(id as WorkspaceId);
  };

  w.__wmux_renameWorkspace = (id: string, title: string) => {
    useStore.getState().renameWorkspace(id as WorkspaceId, title);
  };

  w.__wmux_listWorkspaces = () => {
    const store = useStore.getState();
    return store.workspaces.map(ws => ({
      id: ws.id,
      title: ws.title,
      isActive: ws.id === store.activeWorkspaceId,
      cwd: ws.cwd,
      shell: ws.shell,
    }));
  };

  // Which workspace owns a given surface? Used by main to route browser commands
  // to a browser pane in the *caller agent's* workspace (issue #62). Returns the
  // active workspace id as a fallback when the surface isn't found.
  w.__wmux_getWorkspaceIdForSurface = (surfaceId: string) => {
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const leaf = findLeaf(ws.splitTree, paneId);
        if (leaf?.surfaces?.some(s => s.id === surfaceId)) return ws.id;
      }
    }
    return store.activeWorkspaceId ?? null;
  };

  // All browser surface ids in a workspace. Main adopts an unbound one for a
  // caller (or creates a fresh pane) so each agent gets its own browser (#62).
  w.__wmux_listBrowserSurfaces = (workspaceId: string) => {
    const store = useStore.getState();
    const ws = store.workspaces.find(x => x.id === workspaceId);
    if (!ws) return [];
    const ids: string[] = [];
    for (const paneId of getAllPaneIds(ws.splitTree)) {
      const leaf = findLeaf(ws.splitTree, paneId);
      for (const s of leaf?.surfaces ?? []) {
        if (s.type === 'browser') ids.push(s.id);
      }
    }
    return ids;
  };

  // ─── Pane ───────────────────────────────────────────────────────────────────

  w.__wmux_splitPane = (params?: { direction?: string; type?: string; workspaceId?: string; colorScheme?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;

    const paneIds = getAllPaneIds(ws.splitTree);
    const targetPaneId = paneIds[0];
    if (!targetPaneId) return null;

    const newPaneId = `pane-${uuid()}` as PaneId;
    const surfaceType = (params?.type || 'terminal') as SurfaceType;
    const direction = params?.direction === 'down' || params?.direction === 'vertical'
      ? 'vertical' : 'horizontal';

    const newTree = splitNode(ws.splitTree, targetPaneId, newPaneId, surfaceType, direction);
    store.updateSplitTree(wsId, newTree);

    const newLeaf = findLeaf(newTree, newPaneId);
    const surfaceId = newLeaf?.surfaces?.[0]?.id || null;

    // Apply a per-pane color scheme override to the freshly-created surface
    // so `wmux split --color-scheme prod` takes effect immediately.
    if (params?.colorScheme && surfaceId && newLeaf) {
      store.updateSurface(wsId, newPaneId, surfaceId as SurfaceId, { colorScheme: params.colorScheme });
    }

    return { paneId: newPaneId, surfaceId };
  };

  w.__wmux_closePane = (paneId: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return;

    // Reaping + tree surgery live in the store action (issue #65 fixed the
    // missing reap here; the last-pane case was still wrong in all three copies).
    store.closePane(wsId, paneId as PaneId);
  };

  w.__wmux_layoutGrid = (params: { count: number; type?: string; anchorSurfaceId?: string; anchorPaneId?: string; workspaceId?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;

    const count = Math.max(1, Math.floor(params.count || 1));
    if (count < 2) return { newPaneIds: [], newPanes: [] };

    // Resolve the anchor pane: explicit paneId > surface lookup > first pane
    const paneIds = getAllPaneIds(ws.splitTree);
    let anchorPaneId: PaneId | undefined;

    if (params.anchorPaneId) {
      anchorPaneId = params.anchorPaneId as PaneId;
    } else if (params.anchorSurfaceId) {
      for (const pid of paneIds) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces?.some(s => s.id === params.anchorSurfaceId)) {
          anchorPaneId = pid;
          break;
        }
      }
    }
    if (!anchorPaneId) anchorPaneId = paneIds[0];
    if (!anchorPaneId) return null;

    const surfaceType = (params.type || 'terminal') as SurfaceType;
    const { tree: newTree, newPaneIds } = buildGridLayout(ws.splitTree, anchorPaneId, count, surfaceType);
    store.updateSplitTree(wsId, newTree);

    // Resolve surface IDs for the newly-created panes so callers can target them directly.
    const newPanes = newPaneIds.map(pid => {
      const leaf = findLeaf(newTree, pid);
      return {
        paneId: pid,
        surfaceId: leaf?.surfaces?.[0]?.id || null,
      };
    });

    return { newPaneIds, newPanes, anchorPaneId, cols: Math.ceil(Math.sqrt(count)), rows: Math.ceil(count / Math.ceil(Math.sqrt(count))) };
  };

  w.__wmux_listPanes = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return [];

    const paneIds = getAllPaneIds(ws.splitTree);
    return paneIds.map(pid => {
      const leaf = findLeaf(ws.splitTree, pid);
      return {
        paneId: pid,
        surfaces: leaf?.surfaces?.map(s => ({ id: s.id, type: s.type })) || [],
        tabCount: leaf?.surfaces?.length || 0,
        activeSurfaceIndex: leaf?.activeSurfaceIndex ?? 0,
      };
    });
  };

  // ─── Surface ────────────────────────────────────────────────────────────────

  w.__wmux_createSurface = (params?: { type?: string; paneId?: string; workspaceId?: string; colorScheme?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;

    let paneId = params?.paneId as PaneId | undefined;
    if (!paneId) {
      const ws = store.workspaces.find(w => w.id === wsId);
      if (!ws) return null;
      const paneIds = getAllPaneIds(ws.splitTree);
      paneId = paneIds[0];
    }
    if (!paneId) return null;

    const type = (params?.type || 'terminal') as SurfaceType;
    const surfaceId = store.addSurface(wsId, paneId, type, { colorScheme: params?.colorScheme });
    if (!surfaceId) return null;
    return { surfaceId, paneId };
  };

  /**
   * Update an existing surface's color scheme. Lets users switch a running
   * pane to "prod" mid-session via `wmux surface set-color-scheme <id> prod`.
   */
  w.__wmux_setSurfaceColorScheme = (surfaceId: string, colorScheme: string | null) => {
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      const paneIds = getAllPaneIds(ws.splitTree);
      for (const pid of paneIds) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
          store.updateSurface(ws.id, pid, surfaceId as SurfaceId, {
            colorScheme: colorScheme || undefined,
          });
          return { ok: true };
        }
      }
    }
    return { ok: false, error: 'Surface not found' };
  };

  w.__wmux_closeSurface = (surfaceId: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return;
    const paneIds = getAllPaneIds(ws.splitTree);
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
        store.closeSurface(wsId, pid, surfaceId as SurfaceId);
        return;
      }
    }
  };

  w.__wmux_renameSurface = (surfaceId: string, title: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return { ok: false, error: 'No active workspace' };
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return { ok: false, error: 'Workspace not found' };
    const paneIds = getAllPaneIds(ws.splitTree);
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
        store.renameSurface(wsId, pid, surfaceId as SurfaceId, title ?? '');
        return { ok: true };
      }
    }
    return { ok: false, error: 'Surface not found' };
  };

  w.__wmux_focusSurface = (surfaceId: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return;
    const paneIds = getAllPaneIds(ws.splitTree);
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces) {
        const idx = leaf.surfaces.findIndex(s => s.id === surfaceId);
        if (idx >= 0) {
          store.selectSurface(wsId, pid, idx);
          return;
        }
      }
    }
  };

  w.__wmux_listSurfaces = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return [];

    const paneIds = getAllPaneIds(ws.splitTree);
    const surfaces: Array<{ id: string; type: string; paneId: string; isActive: boolean }> = [];
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces) {
        leaf.surfaces.forEach((s, idx) => {
          surfaces.push({
            id: s.id,
            type: s.type,
            paneId: pid,
            isActive: idx === leaf.activeSurfaceIndex,
          });
        });
      }
    }
    return surfaces;
  };

  w.__wmux_getActiveSurfaceId = () => {
    const store = useStore.getState();
    const wsId = store.activeWorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;
    const paneIds = getAllPaneIds(ws.splitTree);
    if (paneIds.length === 0) return null;
    const leaf = findLeaf(ws.splitTree, paneIds[0]);
    if (!leaf?.surfaces?.length) return null;
    const idx = leaf.activeSurfaceIndex ?? 0;
    return leaf.surfaces[idx]?.id || null;
  };

  // Main-process send/send-key callers feed the same draft tracker as local
  // xterm input. Only Enter after real text can displace an AI decision.
  w.__wmux_handleTerminalUserInput = (surfaceId: string, data: string) => {
    const id = String(surfaceId || '');
    if (!surfaceTerminalRegistry.has(id)) {
      return { handled: false, clearAutomatedDraft: false };
    }
    const preparation = prepareForUserTerminalInput(id, String(data || ''), false);
    return {
      handled: preparation.shouldSubmit
        ? handleSupervisorUserSubmit(id, preparation.submittedText)
        : false,
      clearAutomatedDraft: preparation.clearAutomatedDraft,
    };
  };

  // Read a terminal's screen as plain text (surface.read_text / read-screen).
  // Reads the ACTIVE xterm buffer — alt buffer included, so a full-screen TUI
  // returns what is actually visible. `lines` counts back from the bottom of
  // the buffer (scrollback included); trailing blank lines are trimmed.
  w.__wmux_readScreen = (surfaceId?: string, lines?: number) => {
    const id = surfaceId || w.__wmux_getActiveSurfaceId?.();
    if (!id) return { error: 'No active surface' };
    return readTerminalScreen(id, lines ?? 50);
  };

  const surfaceInCurrentWindow = (surfaceId: string) => {
    const state = useStore.getState();
    for (const workspace of state.workspaces) {
      for (const paneId of getAllPaneIds(workspace.splitTree)) {
        const surface = findLeaf(workspace.splitTree, paneId)?.surfaces
          .find((candidate) => candidate.id === surfaceId);
        if (surface) return surface;
      }
    }
    return undefined;
  };

  w.__wmux_resolveSshEditTarget = (params: any) => {
    const callerSurfaceId = String(params?.callerSurfaceId || '').trim();
    const targetSurfaceId = String(params?.targetSurfaceId || params?.surfaceId || '').trim();
    const caller = surfaceInCurrentWindow(callerSurfaceId);
    if (!caller?.sshControllerTargetSurfaceId) {
      return { ok: false, error: '当前 surface 不是 SSH companion Agent' };
    }
    if (caller.sshControllerTargetSurfaceId !== targetSurfaceId) {
      return { ok: false, error: 'SSH companion 只能编辑其绑定的远端终端' };
    }
    const state = useStore.getState();
    for (const workspace of state.workspaces) {
      for (const paneId of getAllPaneIds(workspace.splitTree)) {
        const target = findLeaf(workspace.splitTree, paneId)?.surfaces
          .find((candidate) => candidate.id === targetSurfaceId);
        if (!target) continue;
        if (!target.sshRemote || !target.sshProfileId || workspace.sshConnectionState !== 'connected') {
          return { ok: false, error: '绑定的 SSH 终端当前没有可用的 SFTP 连接' };
        }
        return { ok: true, workspaceId: workspace.id, targetSurfaceId };
      }
    }
    return { ok: false, error: '绑定的 SSH 终端不存在' };
  };

  w.__wmux_hasSurface = (surfaceId: string) => !!surfaceInCurrentWindow(String(surfaceId || ''));

  w.__wmux_authorizeSurfaceCapability = (request: any) => {
    const callerSurfaceId = String(request?.callerSurfaceId || '').trim();
    const surface = surfaceInCurrentWindow(callerSurfaceId);
    if (!surface) return { knownSurface: false };
    if (String(request?.method || '').startsWith('ssh-file.')) {
      const targetSurfaceId = String(request?.params?.targetSurfaceId || request?.params?.surfaceId || '').trim();
      const checkoutTargetAllowed = request.method !== 'ssh-file.checkout'
        || (!!targetSurfaceId && surface.sshControllerTargetSurfaceId === targetSurfaceId);
      return {
        knownSurface: true,
        managed: true,
        allowed: !!surface.sshControllerTargetSurfaceId && checkoutTargetAllowed,
        ...(!surface.sshControllerTargetSurfaceId
          ? { reason: '只有 SSH companion Agent 可以使用 ssh-file' }
          : !checkoutTargetAllowed
            ? { reason: 'SSH companion 只能编辑其绑定的远端终端' }
            : {}),
      };
    }
    const state = useStore.getState();
    const supervisorLanes = state.supervisor.lanes.filter(
      (lane) => lane.supervisorSurfaceId === callerSurfaceId,
    );
    const supervisorLane = supervisorLanes[0];
    const managerProject = state.projectManagers.find((project) => (
      project.managerSurfaceId === callerSurfaceId
      && surface.projectManagerTerminal === true
      && surface.projectManagerProjectId === project.id
    ));
    const projectTask = surface.projectManagerProjectId
      ? state.projectManagers.find((project) => project.id === surface.projectManagerProjectId)
      : undefined;
    const projectWorkItem = projectTask?.workItems.find((item) => (
      item.id === surface.projectManagerWorkItemId && item.workerSurfaceId === callerSurfaceId
    ));
    const binding = supervisorLane || surface.transientSupervisor || surface.projectSupervisorProjectId ? {
      role: supervisorLane?.projectManagerProjectId || surface.projectSupervisorProjectId
        ? 'project-supervisor' as const
        : 'supervisor' as const,
      callerSurfaceId,
      targetSurfaceId: supervisorLane?.surfaceId,
      targetSurfaceIds: supervisorLanes.map((lane) => lane.surfaceId),
      projectId: supervisorLane?.projectManagerProjectId || surface.projectSupervisorProjectId,
      workItemId: supervisorLane?.projectWorkItemId,
    } : managerProject || surface.projectManagerTerminal ? {
      role: 'project-ai' as const,
      callerSurfaceId,
      projectId: managerProject?.id || surface.projectManagerProjectId,
    } : projectWorkItem || surface.projectManagerProjectId ? {
      role: 'project-task' as const,
      callerSurfaceId,
      targetSurfaceId: callerSurfaceId,
      projectId: projectTask?.id || surface.projectManagerProjectId,
      workItemId: projectWorkItem?.id || surface.projectManagerWorkItemId,
    } : null;
    if (!binding) return { knownSurface: true, managed: false, allowed: true };
    return {
      knownSurface: true,
      managed: true,
      ...authorizeManagedRoleV2(binding, String(request?.method || ''), request?.params || {}),
    };
  };

  const supervisorContextForCaller = (callerSurfaceId: string) => {
    const state = useStore.getState();
    const matchingLanes = state.supervisor.lanes.filter((item) => (
      item.supervisorSurfaceId === callerSurfaceId
      && supervisorLaneControlState(item) !== 'stopped'
    ));
    const lane = matchingLanes[0];
    if (!callerSurfaceId || !lane) {
      return { ok: false, error: '当前终端不是活动监督 lane 绑定的监督 AI，无法读取监督上下文' };
    }
    const project = lane.projectManagerProjectId
      ? state.projectManagers.find((item) => item.id === lane.projectManagerProjectId)
      : undefined;
    const workItem = project?.workItems.find((item) => item.id === lane.projectWorkItemId);
    if (lane.projectManagerProjectId && (
      !project
      || (workItem && !projectSupervisorLaneOwnsWorkItem(lane, workItem))
    )) {
      return { ok: false, error: '项目监督绑定不完整、已过期或与工作项不一致，无法生成可执行能力清单' };
    }
    const taskAgentState = (w.__wmux_getAgentStates?.()?.[lane.surfaceId] || undefined) as SupervisorAgentStateView | undefined;
    const taskState = String(taskAgentState?.state || 'unknown');
    const context = buildSupervisorRuntimeContext(state.supervisor, lane, {
      taskState,
      permissionBlocked: isPermissionBlockedState(taskAgentState),
      ...(project ? {
        project: {
          projectId: project.id,
          projectStatus: project.status,
          ...(workItem ? {
            goalId: workItem.goalId,
            workItemId: workItem.id,
            requirementsVersion: workItem.requirementsVersion ?? projectRequirementsVersion(project),
            authorizationVersion: workItem.authorizationVersion ?? projectAuthorizationVersion(project),
            attempts: workItem.attempts,
            maxTaskRetries: workItem.contract.budget.maxTaskRetries,
            workItemStatus: workItem.status,
            bindingCurrent: project.status === 'active'
              && projectAcceptedRequirementsVersion(project) === projectRequirementsVersion(project)
              && workItem.goalId === activeProjectGoal(project).id
              && !['completed', 'stopped'].includes(workItem.status)
              && workItem.requirementsVersion === projectRequirementsVersion(project)
              && workItem.authorizationVersion === projectAuthorizationVersion(project)
              && !projectWorkItemSubgoalDependencyError(project, workItem)
              && projectSupervisorLaneOwnsWorkItem(lane, workItem),
            dependencyError: projectWorkItemSubgoalDependencyError(project, workItem) || undefined,
            assignment: buildProjectSupervisorAssignment(project, workItem),
          } : {}),
        },
      } : {}),
    });
    return context;
  };

  const roleContextForCaller = (callerSurfaceId: string) => {
    if (!callerSurfaceId) {
      return { ok: false, error: 'wmux context 只能在带有实时 surface capability 的 wmux 终端中运行' };
    }
    const state = useStore.getState();
    const supervisorLanes = state.supervisor.lanes.filter((item) => (
      item.supervisorSurfaceId === callerSurfaceId
      && supervisorLaneControlState(item) !== 'stopped'
    ));
    const supervisorLane = supervisorLanes[0];
    if (supervisorLane) return supervisorContextForCaller(callerSurfaceId);

    const managerProject = state.projectManagers.find((item) => item.managerSurfaceId === callerSurfaceId);
    const managerTerminal = managerProject
      ? projectManagerTerminal({ surfaceId: callerSurfaceId, projectId: managerProject.id })
      : null;
    if (managerProject && managerTerminal) {
      const pendingSupervisorApprovals = state.supervisor.pendingApprovals.filter((approval) => {
        const lane = state.supervisor.lanes.find((item) => item.id === approval.laneId);
        return lane?.projectManagerProjectId === managerProject.id;
      }).length;
      return buildProjectAiRuntimeContext(managerProject, {
        pendingSupervisorApprovals,
        runtime: {
          agent: managerTerminal.surface.projectManagerAgent,
          model: managerTerminal.surface.projectManagerModel,
          reasoningEffort: managerTerminal.surface.projectManagerReasoningEffort,
        },
      });
    }

    const taskTerminal = locateRemoteTaskTerminal(callerSurfaceId).terminal;
    if (!taskTerminal) {
      return { ok: false, error: '当前 surface 不是可识别的受管终端' };
    }
    const taskLane = state.supervisor.lanes.find((item) => (
      item.surfaceId === callerSurfaceId
      && supervisorLaneControlState(item) !== 'stopped'
    ));
    const projectId = taskLane?.projectManagerProjectId
      || taskTerminal.surface.projectManagerProjectId;
    if (taskLane?.projectManagerProjectId
      && taskTerminal.surface.projectManagerProjectId
      && taskLane.projectManagerProjectId !== taskTerminal.surface.projectManagerProjectId) {
      return { ok: false, error: '当前任务上下文绑定不一致，无法生成运行上下文' };
    }
    const project = projectId
      ? state.projectManagers.find((item) => item.id === projectId)
      : undefined;
    const workItemId = taskLane?.projectWorkItemId
      || taskTerminal.surface.projectManagerWorkItemId;
    if (taskLane?.projectWorkItemId
      && taskTerminal.surface.projectManagerWorkItemId
      && taskLane.projectWorkItemId !== taskTerminal.surface.projectManagerWorkItemId) {
      return { ok: false, error: '当前任务上下文绑定不一致，无法生成运行上下文' };
    }
    const workItem = project?.workItems.find((item) => item.id === workItemId);
    if (projectId && (
      !project
      || !workItem
      || !taskLane
      || !projectSupervisorLaneOwnsWorkItem(taskLane, workItem)
    )) {
      return { ok: false, error: '当前任务上下文绑定无效或已过期，无法生成运行上下文' };
    }
    const taskState = String(w.__wmux_getAgentStates?.()?.[callerSurfaceId]?.state || 'unknown');
    if (project && workItem) {
      return buildTaskAiRuntimeContext({
        callerSurfaceId,
        taskState,
        lane: taskLane,
        project,
        workItem,
        runtime: {
          agent: taskTerminal.surface.projectManagerAgent,
          model: taskTerminal.surface.projectManagerModel,
          reasoningEffort: taskTerminal.surface.projectManagerReasoningEffort,
        },
      });
    }
    if (taskLane) {
      return { ok: false, error: '当前终端不承载 wmux 管理角色；请直接遵循目标项目规范和当前成果任务' };
    }
    return { ok: false, error: '当前终端没有有效任务上下文' };
  };

  w.__wmux_roleReady = (params: any) => {
    const callerSurfaceId = String(params?.callerSurfaceId || '').trim();
    const protocolRevision = String(params?.protocolRevision || '').trim();
    const protocolFingerprint = String(params?.protocolFingerprint || '').trim();
    const expected = expectedManagedRoleProtocol(callerSurfaceId);
    if (!expected) return { ok: false, error: '当前终端不是活动项目 AI 或监督 AI 运行时' };
    if (protocolRevision !== expected.protocolRevision
      || protocolFingerprint !== expected.protocolFingerprint) {
      managedRoleProtocolReady.delete(callerSurfaceId);
      if (expected.lane) {
        useStore.getState().updateLane(expected.lane.id, { supervisorBriefingStatus: 'failed' });
      }
      return {
        ok: false,
        error: `AGENTS.md 协议版本或指纹不匹配；期望 protocol=${expected.protocolRevision}，请重启该角色运行时以重新部署协议`,
      };
    }
    const confirmedAt = Date.now();
    managedRoleProtocolReady.set(callerSurfaceId, {
      role: expected.role,
      protocolRevision,
      protocolFingerprint,
      confirmedAt,
    });
    if (expected.lane) {
      const pendingSupervisorDeliveries = (expected.lane.pendingSupervisorDeliveries || [])
        .filter((delivery) => !delivery.bootstrapOnRuntimeReady);
      useStore.getState().updateLane(expected.lane.id, {
        supervisorBriefingStatus: 'confirmed',
        supervisorBriefingConfirmedAt: confirmedAt,
        pendingSupervisorDeliveries,
      });
      appendSupervisorRecord(useStore.getState().supervisor, expected.lane, 'supervisor.protocol-ready', {
        protocolRevision,
        protocolFingerprint,
      });
      signalSupervisorDeliveryReady();
    }
    return { ok: true, role: expected.role, protocolRevision, protocolFingerprint };
  };

  w.__wmux_roleContext = (params: any) => (
    roleContextForCaller(String(params?.callerSurfaceId || '').trim())
  );

  w.__wmux_supervisorEvidence = async (params: any) => {
    const callerSurfaceId = String(params?.callerSurfaceId || '').trim();
    const reviewId = String(params?.reviewId || '').trim();
    if (!callerSurfaceId || !reviewId) {
      return { ok: false, error: '监督证据读取需要调用方终端和 reviewId' };
    }
    const state = useStore.getState().supervisor;
    const lane = state.lanes.find((candidate) => (
      dedicatedSupervisorSurfaceId(candidate) === callerSurfaceId
      && isSupervisorLaneBound(candidate)
    ));
    if (!lane) return { ok: false, error: '当前终端不是活动监督 lane 绑定的监督 AI' };
    const sessionId = lane.managementSessionId || state.sessionId || '';
    if (!sessionId || !lane.projectDir) {
      return { ok: false, error: '当前监督 lane 缺少证据会话或项目目录绑定' };
    }
    const page = Number(params?.page);
    const pageLines = Number(params?.pageLines);
    const isolationScope = supervisorLaneInputIsolationScope(lane);
    const fileRequested = params?.file === true || params?.accessMode === 'file';
    if (fileRequested) {
      const cachedSnapshot = cachedSupervisorEvidenceSnapshot(
        sessionId,
        reviewId,
        lane.surfaceId,
        isolationScope,
      );
      if (cachedSnapshot) {
        try {
          await persistSupervisorEvidence(lane.projectDir, cachedSnapshot);
        } catch {
          // The immutable in-memory snapshot can still serve the page fallback below.
        }
      }
      const fileReference = await readPersistedSupervisorEvidenceFile({
        projectDir: lane.projectDir,
        sessionId,
        reviewId,
        surfaceId: lane.surfaceId,
        isolationScope,
      });
      if (fileReference) return fileReference;
    }
    const cached = cachedSupervisorEvidencePage(
      sessionId,
      reviewId,
      lane.surfaceId,
      isolationScope,
      page,
      pageLines,
    );
    if (cached) return fileRequested
      ? { ...cached, accessMode: 'page-fallback', fallbackReason: '只读证据文件不可用' }
      : cached;
    const persisted = await readPersistedSupervisorEvidencePage({
      projectDir: lane.projectDir,
      sessionId,
      reviewId,
      surfaceId: lane.surfaceId,
      isolationScope,
      page,
      pageLines,
    });
    if (persisted) return fileRequested
      ? { ...persisted, accessMode: 'page-fallback', fallbackReason: '只读证据文件不可用' }
      : persisted;
    return { ok: false, error: '未找到与当前监督 lane 匹配的冻结证据' };
  };


  const completionEvidenceGrants = new Map<string, {
    laneId: string;
    projectId: string;
    workItemId: string;
    refs: string[];
    entries: ProjectEvidenceArtifact[];
    expiresAt: number;
  }>();

  w.__wmux_supervisorVerifyCompletionEvidence = async (params: any) => {
    const store = useStore.getState();
    const surfaceId = String(params?.surfaceId || '').trim();
    const supervisorSurfaceId = String(params?.supervisorSurfaceId || '').trim();
    const lane = store.supervisor.lanes.find((candidate) => candidate.surfaceId === surfaceId);
    if (!lane?.projectManagerProjectId
      || !lane.projectWorkItemId
      || !isSupervisorDecisionAuthorised(lane, supervisorSurfaceId)) {
      return { ok: false, error: '只有当前工作项绑定的专属监督可以核验项目证据' };
    }
    const refs = [...new Set(projectStringArray(params?.refs).map((entry) => entry.replace(/\\/g, '/')))];
    if (refs.length === 0 || refs.length > 50 || refs.some((entry) => !safeProjectRelativePath(entry))) {
      return { ok: false, error: '项目证据必须引用 1-50 个项目内规范相对文件路径' };
    }
    const project = store.projectManagers.find((candidate) => candidate.id === lane.projectManagerProjectId);
    const workItem = project?.workItems.find((candidate) => candidate.id === lane.projectWorkItemId);
    if (!project || !workItem) return { ok: false, error: '项目证据对应的工作项已经失效' };
    const scopeError = projectContractViolation(workItem.contract, {
      changedFiles: refs,
      artifactAccess: 'read',
    });
    if (scopeError) return { ok: false, error: `项目证据引用越出工作项合同范围：${scopeError}` };
    const verifier = (window as any).wmux?.projectManager?.verifyEvidenceRefs;
    if (typeof verifier !== 'function') return { ok: false, error: '项目实际证据核验接口尚未就绪，请重启 wmux' };
    const result = await verifier({
      projectId: lane.projectManagerProjectId,
      workItemId: lane.projectWorkItemId,
      refs,
    });
    if (!result?.ok || !Array.isArray(result.entries)) {
      return { ok: false, error: String(result?.error || '实际证据文件核验失败') };
    }
    const verifiedRefs = result.entries.map((entry: any) => String(entry?.ref || '').replace(/\\/g, '/'));
    if (verifiedRefs.length !== refs.length || refs.some((ref) => !verifiedRefs.includes(ref))) {
      return { ok: false, error: '实际证据核验结果与请求引用不一致' };
    }
    const now = Date.now();
    for (const [token, grant] of completionEvidenceGrants) {
      if (grant.expiresAt <= now) completionEvidenceGrants.delete(token);
    }
    const token = uuid();
    completionEvidenceGrants.set(token, {
      laneId: lane.id,
      projectId: lane.projectManagerProjectId,
      workItemId: lane.projectWorkItemId,
      refs,
      entries: result.entries as ProjectEvidenceArtifact[],
      expiresAt: now + 60_000,
    });
    return { ok: true, token, entries: result.entries };
  };

  // The dedicated supervisor terminal records its judgment through a silent CLI
  // call. Routing by surfaceId, not display label, keeps duplicate tab names
  // distinct inside the same workspace/session.
  const decideSupervisor = (params: any) => {
    const store = useStore.getState();
    const session = store.supervisor;
    const surfaceId = String(params?.surfaceId || '');
    const supervisorSurfaceId = String(params?.supervisorSurfaceId || '');
    const outcome = String(params?.outcome || '') as SupervisorDecision['outcome'];
    const reason = String(params?.reason || '').trim().slice(0, 1200);
    const rawTaskWorkMode = String(params?.taskWorkMode || '').trim();
    const requestedTaskWorkMode = ['single-thread', 'multi-thread'].includes(rawTaskWorkMode)
      ? rawTaskWorkMode as 'single-thread' | 'multi-thread'
      : undefined;
    let next = String(params?.next || '').trim();
    const rawNextFile = String(params?.nextFile || '').trim().replace(/\\/g, '/');
    const nextFile = /^\.wmux\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(rawNextFile)
      ? rawNextFile
      : '';
    const rawStagePlanFile = String(params?.stagePlanFile || '').trim().replace(/\\/g, '/');
    const stagePlanFile = /^\.wmux\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(rawStagePlanFile)
      ? rawStagePlanFile
      : '';
    const rawTaskFile = String(params?.taskFile || '').trim().replace(/\\/g, '/');
    const taskFile = /^\.wmux\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(rawTaskFile)
      ? rawTaskFile
      : '';
    const rawCompletionFile = String(params?.completionFile || '').trim().replace(/\\/g, '/');
    const completionFile = /^\.wmux\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(rawCompletionFile)
      ? rawCompletionFile
      : '';
    const rawEvidenceProgressFile = String(params?.evidenceProgressFile || '').trim().replace(/\\/g, '/');
    const evidenceProgressFile = /^\.wmux\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(rawEvidenceProgressFile)
      ? rawEvidenceProgressFile
      : '';
    const proposalKind = String(params?.proposalKind || '').trim();
    const rawEscalationBoundary = String(params?.escalationBoundary || '').trim();
    const escalationBoundary = PROJECT_ESCALATION_BOUNDARIES.has(rawEscalationBoundary as ProjectEscalationBoundary)
      ? rawEscalationBoundary as ProjectEscalationBoundary
      : undefined;
    const impact = String(params?.impact || '').trim().slice(0, 1200);
    const alternatives = String(params?.alternatives || '').trim().slice(0, 1200);
    const permissionCommand = String(params?.permissionCommand || '').trim().slice(0, 2000);
    const permissionResponse = String(params?.permissionResponse || '').trim().slice(0, 16);
    const executionError = String(params?.error || '').trim();
    const changedFiles = projectStringArray(params?.changedFiles);
    const testCommand = String(params?.testCommand || '').trim();
    const artifactPathError = changedFiles
      .map(projectArtifactLocationViolation)
      .find((error): error is string => !!error)
      || projectArtifactCommandViolation(
        `${String(params?.command || '')}\n${testCommand}`,
      );
    if (artifactPathError) return { ok: false, error: artifactPathError };
    const testResult = String(params?.testResult || '').trim();
    const diffSummary = String(params?.diffSummary || '').trim();
    const evidence = String(params?.evidence || '').trim();
    const contextSummary = String(params?.contextSummary || '').trim();
    const rawContextHealth = String(params?.contextHealth || '').trim();
    const contextSymptoms = normalizeOrdinaryContextSymptoms(params?.contextSymptoms);
    const contextSignal = String(params?.contextSignal || '').trim().slice(0, 4_000);
    const rawProgressHealth = String(params?.progressHealth || '').trim();
    const goalVortexKind = normalizeGoalVortexKind(params?.stallKind);
    const stallSignal = String(params?.stallSignal || '').trim().slice(0, 4_000);
    const wastedEffort = String(params?.wastedEffort || '').trim().slice(0, 4_000);
    const missingEvidence = String(params?.missingEvidence || '').trim().slice(0, 4_000);
    const decisiveNextStep = String(params?.decisiveNextStep || '').trim().slice(0, 4_000);
    const rawAuthorizationBoundary = String(params?.authorizationBoundary || '').trim();
    const authorizationBoundary = ['within-current', 'requires-expansion'].includes(rawAuthorizationBoundary)
      ? rawAuthorizationBoundary as 'within-current' | 'requires-expansion'
      : undefined;
    const experimentConditions = normalizeExperimentConditions(params?.experimentConditions);
    const reviewId = String(params?.reviewId || '').trim().slice(0, 200);
    const progressEvidenceFingerprint = projectExecutionDirectionSignature([
      evidence,
      diffSummary,
      testResult,
      changedFiles.join('|'),
    ].join('\n')) || 'no-new-evidence';
    const rawRetryKind = String(params?.retryKind || '').trim();
    const retryKind = PROJECT_RETRY_KINDS.includes(rawRetryKind as ProjectRetryKind)
      ? rawRetryKind as ProjectRetryKind
      : undefined;
    const retryRequested = params?.retry === true
      || ((outcome === 'continue' || outcome === 'rework') && !!executionError);
    const valid = new Set(['continue', 'rework', 'complete', 'needs-human']);
    const proposalKinds = new Set(['route-change', 'important', 'context-recovery', 'clarification']);
    const foundLane = session.lanes.find((item) => item.surfaceId === surfaceId);
    if (!session.active || !foundLane || !isSupervisorDecisionAuthorised(foundLane, supervisorSurfaceId) || !valid.has(outcome)) return null;
    const lane: SupervisorLane = foundLane;
    if ((window as any).wmux?.pty?.has && !managedRoleProtocolIsReady(supervisorSurfaceId)) {
      return {
        ok: false,
        error: '监督角色尚未通过 AGENTS.md 协议确认；请先运行 wmux context，再执行启动消息指定的 wmux role-ready',
      };
    }
    if (hasPendingTaskUserSubmit(lane.id, session.sessionId)) {
      return {
        ok: false,
        error: '用户输入已提交到任务终端，正在等待 UserPromptSubmit 生命周期确认；禁止旧监督回合抢先注入指令',
      };
    }
    if (lane.userDirectTaskTurnId !== undefined && lane.userDirectTaskTurnId === lane.workerTurnId) {
      return {
        ok: false,
        error: '用户直发任务已经由任务 Agent 确认接收；禁止旧监督回合提交裁决或注入替代指令，请等待本回合结束、阻塞或中断事件',
      };
    }
    if (lane.pendingSupervisorDeliveries?.some((delivery) => delivery.kind === 'user-task')) {
      return {
        ok: false,
        error: '用户直发任务已经先行生效；当前通知只供监督知情，禁止旧监督回合提交裁决或向任务终端注入替代指令。请等待任务结束、阻塞或中断事件后再裁决',
      };
    }
    if (rawNextFile && !nextFile) {
      return { ok: false, error: '--next-file 必须是当前监督隔离目录 .wmux/tmp/ 下的单个安全文件名' };
    }
    if (rawStagePlanFile && !stagePlanFile) {
      return { ok: false, error: '--stage-plan-file 必须是当前监督隔离目录 .wmux/tmp/ 下的单个安全 JSON 文件名' };
    }
    if (params?.stagePlan !== undefined && !stagePlanFile) {
      return { ok: false, error: '监督阶段计划只能通过 --stage-plan-file 提交，不能绕过受控临时文件边界' };
    }
    if (rawTaskFile && !taskFile) {
      return { ok: false, error: '--task-file 必须是当前监督隔离目录 .wmux/tmp/ 下的单个安全 JSON 文件名' };
    }
    if (params?.taskDispatch !== undefined && !taskFile) {
      return { ok: false, error: '监督成果任务只能通过 --task-file 提交，不能绕过受控临时文件边界' };
    }
    if (rawCompletionFile && !completionFile) {
      return { ok: false, error: '--completion-file 必须是当前监督隔离目录 .wmux/tmp/ 下的单个安全 JSON 文件名' };
    }
    if (rawEvidenceProgressFile && !evidenceProgressFile) {
      return { ok: false, error: '--evidence-progress-file 必须是当前监督隔离目录 .wmux/tmp/ 下的单个安全 JSON 文件名' };
    }
    if (completionFile && evidenceProgressFile) {
      return { ok: false, error: '--completion-file 与 --evidence-progress-file 不能同时提交' };
    }
    if (params?.completionChecklist !== undefined && !completionFile) {
      return { ok: false, error: '监督完成核验只能通过 --completion-file 提交，不能绕过受控临时文件边界' };
    }
    if (params?.completionChecklist !== undefined && outcome !== 'complete') {
      return { ok: false, error: '--completion-file 只能用于 complete 裁决' };
    }
    if (rawEscalationBoundary && !escalationBoundary) {
      return { ok: false, error: '无效 escalation-boundary；必须使用控制层定义的项目升级边界' };
    }
    if (next.length > 64_000) return { ok: false, error: '任务指令文件不得超过 64000 字符' };
    if (!nextFile && next.length > 4_000) {
      return { ok: false, error: '内联 --next 不得超过 4000 字符；请改用 .wmux/tmp/ 下的 --next-file' };
    }
    const laneState = supervisorLaneControlState(lane);
    if (laneState !== 'active') return { ok: false, error: laneState === 'paused' ? '当前监督通道已暂停' : '当前监督通道已停止' };
    const decisionDeliveryContext = {
      activeReviewId: lane.activeReviewId,
      reviewOpenedAt: lane.reviewOpenedAt,
      projectAssignmentVersion: lane.projectAssignmentVersion,
      projectAssignmentConfirmedVersion: lane.projectAssignmentConfirmedVersion,
      projectTaskContractPending: lane.projectTaskContractPending,
    };
    const actionableSupervisorDeliveries = lane.pendingSupervisorDeliveries || [];
    const awaitingOwnerDecisionDelivery = blockingSupervisorDecisionDeliveries(
      actionableSupervisorDeliveries,
      decisionDeliveryContext,
    ).length > 0;
    if (awaitingOwnerDecisionDelivery) {
      store.appendSupervisorLog(lane.id, '监督裁决暂缓', '上一条控制消息仍在等待监督 Agent 确认接收');
      if (outcome === 'needs-human') {
        return { ok: true, outcome, duplicate: true, awaitingOwnerDecisionDelivery: true };
      }
      return {
        ok: false,
        awaitingOwnerDecisionDelivery: true,
        error: '上一条控制消息尚未由当前监督 Agent 确认接收；请结束本回合并等待空闲投递，禁止继续裁决或新建待决项',
      };
    }
    const projectManagedLane = isProjectManagedSupervisorLane(lane);
    const submitTaskEnter = lane.submitEnterOverride ?? session.submitEnter;
    if (rawTaskWorkMode && !requestedTaskWorkMode) {
      return { ok: false, error: '--task-work-mode 必须是 single-thread 或 multi-thread' };
    }
    if (requestedTaskWorkMode && !projectManagedLane) {
      return { ok: false, error: '--task-work-mode 仅用于项目模式的任务 AI' };
    }
    if (requestedTaskWorkMode && !['continue', 'rework'].includes(outcome)) {
      return { ok: false, error: '--task-work-mode 只能用于 continue 或 rework 裁决' };
    }
    if (!projectManagedLane && lane.activeReviewId && reviewId !== lane.activeReviewId) {
      return {
        ok: false,
        error: reviewId
          ? 'reviewId 已过期或不属于当前任务回合；请重新运行 wmux context 获取当前复核 ID'
          : `当前复核必须附 --review-id ${lane.activeReviewId}，避免迟到裁决覆盖新任务回合`,
      };
    }
    if (!projectManagedLane && !lane.activeReviewId && reviewId) {
      return { ok: false, error: '当前没有与该 reviewId 对应的待裁决轮次；请等待新的监督事件' };
    }
    const projectSession = lane.projectManagerProjectId
      ? store.projectManagers.find((candidate) => candidate.id === lane.projectManagerProjectId)
      : undefined;
    const projectWorkItem = lane.projectWorkItemId
      ? projectSession?.workItems.find((item) => item.id === lane.projectWorkItemId)
      : undefined;
    if (outcome === 'needs-human') {
      const authoritativeLaneConfig = effectiveSupervisorLaneConfig(lane);
      const latestSupervisorUserGuidance = lane.latestSupervisorUserGuidance;
      const guidanceMatchesCurrentAuthority = !!latestSupervisorUserGuidance
        && latestSupervisorUserGuidance.planRevision === (authoritativeLaneConfig.planRevision || 1)
        && latestSupervisorUserGuidance.requirementsVersion === projectSession?.requirementsVersion;
      const standingUserDecisions = projectManagedLane
        ? []
        : activeStandingUserDecisions(
            lane,
            authoritativeLaneConfig.planRevision || 1,
          );
      const escalationText = [reason, impact, alternatives, next].filter(Boolean).join('\n');
      const redundantConfirmationError = redundantAuthoritativeGuidanceConfirmation({
        preconditions: [
          authoritativeLaneConfig.preconditions,
          ...standingUserDecisions.map((decision) => decision.decision),
          ...(projectSession?.preconditions || []),
          ...(projectWorkItem?.contract.preconditions || []),
        ].filter(Boolean).join('\n'),
        supervisorNotes: [
          authoritativeLaneConfig.supervisorNotes || '',
          ...(projectSession?.supervisorNotes || []),
          ...(projectWorkItem?.contract.supervisorNotes || []),
        ].filter(Boolean).join('\n'),
        escalationText,
        latestUserGuidance: guidanceMatchesCurrentAuthority
          ? latestSupervisorUserGuidance.text
          : undefined,
      });
      if (redundantConfirmationError) {
        return { ok: false, error: redundantConfirmationError };
      }
      const repeatedStandingDecisionError = repeatedStandingUserDecisionError(
        standingUserDecisions,
        escalationText,
      );
      if (repeatedStandingDecisionError) {
        return { ok: false, error: repeatedStandingDecisionError };
      }
    }
    if (projectManagedLane && proposalKind === 'context-recovery') {
      if (!projectSession || !projectWorkItem) {
        return { ok: false, error: '上下文清空请求缺少当前项目和工作项绑定' };
      }
      if (outcome !== 'rework') {
        return { ok: false, error: '项目任务上下文清空必须使用 rework 裁决' };
      }
      if (next) {
        return { ok: false, error: '上下文清空不得携带 --next；请通过 --context-summary 提交只含权威事实的干净任务摘要' };
      }
    if (!reason || !evidence || !contextSummary) {
      return { ok: false, error: '上下文清空必须同时提供 --reason、--evidence 和 --context-summary' };
    }
    if ((projectWorkItem.contextReset?.count || 0) < 1) {
      const recoveryDisclosureError = projectTaskInstructionDisclosureError(contextSummary)
        || projectTaskContractDisclosureError(projectWorkItem.contract);
      if (recoveryDisclosureError) {
        return { ok: false, error: `上下文恢复摘要不能污染任务 AI：${recoveryDisclosureError}` };
      }
    }
    return resetProjectTaskContextInPlace(projectSession, lane, projectWorkItem, {
        reason,
        evidence,
        cleanContext: contextSummary,
      });
    }
    const currentOrdinaryProtocol = !projectManagedLane
      && lane.ordinaryProtocolVersion === ORDINARY_SUPERVISION_PROTOCOL_VERSION;
    let ordinaryTaskDispatch: OrdinaryTaskDispatch | undefined;
    let projectTaskBatch: ProjectTaskBatch | undefined;
    let detectedVerificationLimitation: ProjectVerificationLimitation | undefined;
    let ordinaryContextHealthReported = false;
    let proposedOrdinaryContextHealth: OrdinaryContextHealthState | undefined;
    let ordinaryContextResetRequired = false;
    let progressHealthReported = false;
    let proposedGoalVortex: GoalVortexState | undefined;
    let goalVortexReplanRequired = false;
    if (currentOrdinaryProtocol && params?.taskDispatch !== undefined) {
      const normalizedDispatch = normalizeOrdinaryTaskDispatch(params.taskDispatch);
      if (!normalizedDispatch.dispatch) return { ok: false, error: normalizedDispatch.error };
      ordinaryTaskDispatch = normalizedDispatch.dispatch;
      const expectedRevision = effectiveSupervisorLaneConfig(lane).planRevision || 1;
      if (ordinaryTaskDispatch.sourceRevision !== expectedRevision) {
        return { ok: false, error: `用户规划已更新为 r${expectedRevision}；拒绝投递旧规划 r${ordinaryTaskDispatch.sourceRevision} 的任务` };
      }
      next = renderOrdinaryTaskDispatch(ordinaryTaskDispatch);
    }
    if (currentOrdinaryProtocol && ordinaryTaskDispatch
      && outcome !== 'continue' && outcome !== 'rework') {
      return { ok: false, error: '--task-file 仅用于普通监督的 continue 或 rework 裁决' };
    }
    if (currentOrdinaryProtocol && (outcome === 'continue' || outcome === 'rework') && !permissionResponse) {
      if (!ordinaryTaskDispatch) {
        return { ok: false, error: '当前普通监督协议要求通过 --task-file 提交成果型任务；禁止使用任意 --next 指令' };
      }
      if (rawNextFile || String(params?.next || '').trim()) {
        return { ok: false, error: '当前普通监督协议不能把 --task-file 与 --next/--next-file 混用' };
      }
    }
    if (projectManagedLane && projectWorkItem && params?.taskDispatch !== undefined) {
      const normalizedBatch = normalizeProjectTaskBatch(params.taskDispatch, projectWorkItem, {
        allowUnmetCompletionItems: (lane.workerTurnId || 0) > 0,
      });
      if (!normalizedBatch.batch) return { ok: false, error: normalizedBatch.error };
      projectTaskBatch = normalizedBatch.batch;
      if (projectSession) {
        detectedVerificationLimitation = projectVerificationLimitationFromDecision(
          projectSession,
          projectWorkItem,
          [
            ...projectTaskBatch.knownFacts,
            ...projectTaskBatch.unmetCompletionItems,
            ...projectTaskBatch.evidenceExpectations,
            projectTaskBatch.outcome,
          ],
          [...projectTaskBatch.unmetCompletionItems, ...projectTaskBatch.evidenceExpectations],
        );
      }
      next = renderProjectTaskBatch(
        projectWorkItem.contract,
        projectTaskBatch,
        requestedTaskWorkMode || projectWorkItem.taskWorkMode || 'single-thread',
        {
          initializeRepository: projectRepositoryBootstrapRequired(projectSession),
          effectivePreconditions: projectSession
            ? projectEffectiveWorkItemPreconditions(projectSession, projectWorkItem)
            : projectWorkItem.contract.preconditions,
        },
      );
    }
    if (projectManagedLane && projectTaskBatch
      && outcome !== 'continue' && outcome !== 'rework') {
      return { ok: false, error: '--task-file 仅用于项目监督的 continue 或 rework 裁决' };
    }
    if (projectManagedLane && projectTaskBatch && !requestedTaskWorkMode) {
      return {
        ok: false,
        error: '项目监督每次派发成果批次都必须通过 --task-work-mode single-thread|multi-thread 明确本批执行模式',
      };
    }
    if (projectManagedLane && projectWorkItem
      && (outcome === 'continue' || outcome === 'rework') && !permissionResponse) {
      if (!projectTaskBatch) {
        return { ok: false, error: '项目监督必须通过 --task-file 提交单成果批次；禁止使用任意 --next 指令' };
      }
      if (rawNextFile || String(params?.next || '').trim()) {
        return { ok: false, error: '项目监督不能把 --task-file 与 --next/--next-file 混用' };
      }
    }
    if (rawContextHealth && !currentOrdinaryProtocol) {
      return { ok: false, error: '--context-health 仅用于当前普通监督协议' };
    }
    if (currentOrdinaryProtocol && rawContextHealth) {
      if (!['healthy', 'degraded'].includes(rawContextHealth)) {
        return { ok: false, error: '--context-health 必须是 healthy 或 degraded' };
      }
      ordinaryContextHealthReported = true;
      if (rawContextHealth === 'healthy' && lane.ordinaryContextHealth) {
        const previous = lane.ordinaryContextHealth;
        const distinctReview = previous.reviewId !== lane.activeReviewId
          || previous.workerTurnId !== lane.workerTurnId;
        if (!distinctReview
          || progressEvidenceFingerprint === 'no-new-evidence'
          || progressEvidenceFingerprint === previous.evidenceFingerprint) {
          return {
            ok: false,
            error: '上下文恢复健康必须来自新的任务回合或复核，并提供不同于退化记录的新进展证据；不能用空白或旧证据清除退化计数',
          };
        }
      }
      if (rawContextHealth === 'degraded') {
        if (outcome !== 'rework' || !ordinaryTaskDispatch
          || !['diagnostic', 'rework'].includes(ordinaryTaskDispatch.kind)) {
          return { ok: false, error: '上下文退化必须使用 rework，并通过 --task-file 派发 diagnostic 或 rework 成果任务' };
        }
        if (contextSymptoms.length === 0 || !contextSignal) {
          return { ok: false, error: '上下文退化必须提供有效 --context-symptoms 和事实化 --context-signal' };
        }
        proposedOrdinaryContextHealth = nextOrdinaryContextHealthState({
          previous: lane.ordinaryContextHealth,
          symptoms: contextSymptoms,
          signal: contextSignal,
          evidenceFingerprint: progressEvidenceFingerprint,
          reviewId: lane.activeReviewId,
          workerTurnId: lane.workerTurnId,
        });
        ordinaryContextResetRequired = proposedOrdinaryContextHealth.occurrences >= 2;
        const planRevision = effectiveSupervisorLaneConfig(lane).planRevision || 1;
        if (ordinaryContextResetRequired && lane.ordinaryContextReset?.status === 'failed') {
          return { ok: false, error: '上一轮上下文清空或恢复已经失败；禁止自动重试，请使用 needs-human 上报用户' };
        }
        if (ordinaryContextResetRequired
          && lane.ordinaryContextResetPlanRevision === planRevision
          && (lane.ordinaryContextResetCount || 0) >= 1) {
          return { ok: false, error: '当前用户规划版本已经自动清空过一次任务上下文；再次退化必须使用 needs-human 上报用户' };
        }
      }
    }
    if (rawProgressHealth) {
      if (!['healthy', 'stalled'].includes(rawProgressHealth)) {
        return { ok: false, error: '--progress-health 必须是 healthy 或 stalled' };
      }
      progressHealthReported = true;
      if (rawProgressHealth === 'healthy' && lane.goalVortex) {
        const previous = lane.goalVortex;
        const distinctReview = previous.reviewId !== lane.activeReviewId
          || previous.workerTurnId !== lane.workerTurnId;
        if (!distinctReview
          || progressEvidenceFingerprint === 'no-new-evidence'
          || progressEvidenceFingerprint === (previous.evidenceFingerprint || 'no-new-evidence')) {
          return {
            ok: false,
            error: '推进恢复健康必须来自新的任务回合或复核，并提供不同于目标旋涡记录的新进展证据；不能用空白或旧证据重置连续空耗计数',
          };
        }
      }
      if (rawProgressHealth === 'stalled') {
        if (!goalVortexKind || !stallSignal || !wastedEffort || !missingEvidence
          || !decisiveNextStep || !authorizationBoundary) {
          return {
            ok: false,
            error: '目标旋涡必须完整提供 --stall-kind、--stall-signal、--wasted-effort、--missing-evidence、--decisive-next-step 和 --authorization-boundary',
          };
        }
        const needsExperimentMatrix = goalVortexKind === 'single-condition-fixation'
          || goalVortexKind === 'constraint-dead-end';
        if (needsExperimentMatrix && authorizationBoundary === 'within-current'
          && experimentConditions.length < 2) {
          return { ok: false, error: '单条件死磕或受限条件死路必须通过 --experiment-conditions 提供 2-4 个授权范围内的判别实验条件' };
        }
        if (authorizationBoundary === 'within-current') {
          if (outcome !== 'rework' || !next) {
            return { ok: false, error: '已有授权范围内的目标旋涡必须立即使用 rework 派发纠偏任务，不能继续空转或上报用户' };
          }
        } else if (outcome !== 'needs-human'
          || !['contract-change', 'high-risk-action', 'external-blocker'].includes(rawEscalationBoundary)) {
          return { ok: false, error: '需要扩大安全或测试边界时必须使用 needs-human，并提供 contract-change、high-risk-action 或 external-blocker 升级边界' };
        }
        proposedGoalVortex = nextGoalVortexState({
          previous: lane.goalVortex,
          kind: goalVortexKind,
          signal: stallSignal,
          wastedEffort,
          missingEvidence,
          decisiveNextStep,
          authorizationBoundary,
          experimentConditions,
          correctionTask: authorizationBoundary === 'within-current' ? next : '',
          evidenceFingerprint: progressEvidenceFingerprint,
          reviewId: lane.activeReviewId,
          workerTurnId: lane.workerTurnId,
        });
        goalVortexReplanRequired = proposedGoalVortex.occurrences >= 2;
        if (goalVortexReplanRequired && lane.goalVortex
          && sameGoalVortexCorrection(lane.goalVortex.correctionTask, proposedGoalVortex.correctionTask)) {
          appendSupervisorRecord(session, lane, 'supervisor.goal-vortex.rejected-repeat', {
            occurrence: proposedGoalVortex.occurrences,
            kind: proposedGoalVortex.kind,
            signal: proposedGoalVortex.signal,
            wastedEffort: proposedGoalVortex.wastedEffort,
            missingEvidence: proposedGoalVortex.missingEvidence,
            decisiveNextStep: proposedGoalVortex.decisiveNextStep,
            authorizationBoundary: proposedGoalVortex.authorizationBoundary,
            experimentConditions: proposedGoalVortex.experimentConditions,
            previousCorrectionTask: lane.goalVortex.correctionTask,
            correctionTask: proposedGoalVortex.correctionTask,
            reviewId: proposedGoalVortex.reviewId,
            workerTurnId: proposedGoalVortex.workerTurnId,
          });
          store.appendSupervisorLog(
            lane.id,
            '目标旋涡：重复纠偏被拒绝',
            [
              `连续出现=${proposedGoalVortex.occurrences}`,
              `类型=${proposedGoalVortex.kind}`,
              `触发现象=${proposedGoalVortex.signal}`,
              `空耗=${proposedGoalVortex.wastedEffort}`,
              `缺失证据=${proposedGoalVortex.missingEvidence}`,
              `上轮纠偏=${lane.goalVortex.correctionTask}`,
              `被拒绝纠偏=${proposedGoalVortex.correctionTask}`,
              `必须改变=${proposedGoalVortex.decisiveNextStep}`,
            ].join('｜'),
          );
          return { ok: false, error: '相同目标旋涡已连续两轮出现；禁止重复同一纠偏任务，必须改变假设、实验条件或推进路径' };
        }
      }
    }
    if (rawRetryKind && !retryKind) {
      return {
        ok: false,
        error: `无效 retry-kind；必须使用 ${PROJECT_RETRY_KINDS.join('|')}`,
      };
    }
    if (projectManagedLane && retryRequested && !retryKind) {
      return {
        ok: false,
        error: '项目重试必须通过 --retry-kind 明确分类；只有底层实现/验证/实机动作本身失败的 task-failure 消耗真实任务失败预算，证据闭合、命令纠错、运行时恢复和执行窗口续接不得冒充任务失败',
      };
    }
    if (retryKind && !retryRequested) {
      return { ok: false, error: '--retry-kind 只能与 --retry 或携带 --error 的 continue/rework 裁决一起使用' };
    }
    if (retryKind) {
      const retryKindError = projectRetryKindEvidenceError({
        retryKind,
        outcome,
        changedFiles,
        testCommand,
        testResult,
        executionError,
      });
      if (retryKindError) return { ok: false, error: retryKindError };
    }
    const consumeProjectTaskRetry = projectManagedLane
      && retryRequested
      && projectRetryConsumesTaskBudget(retryKind);
    const decisionAt = Date.now();
    const completionEvidenceToken = String(params?.completionEvidenceToken || '').trim();
    const evidenceProgressToken = String(params?.evidenceProgressToken || '').trim();
    const evidenceProgressConclusion = String(params?.evidenceProgressConclusion || '').trim();
    const completionEvidenceGrant = completionEvidenceToken
      ? completionEvidenceGrants.get(completionEvidenceToken)
      : undefined;
    const evidenceProgressGrant = evidenceProgressToken
      ? completionEvidenceGrants.get(evidenceProgressToken)
      : undefined;
    if (evidenceProgressFile && (
      outcome === 'complete'
      || !['confirmed-success', 'confirmed-not-executed', 'inconclusive'].includes(evidenceProgressConclusion)
      || !evidenceProgressGrant
      || evidenceProgressGrant.expiresAt <= decisionAt
      || evidenceProgressGrant.laneId !== lane.id
      || evidenceProgressGrant.projectId !== projectSession?.id
      || evidenceProgressGrant.workItemId !== projectWorkItem?.id
    )) {
      return {
        ok: false,
        error: '只读证据进展尚未由控制层读取实际文件并核验内容哈希，或结论类型无效；必须通过 CLI 的 --evidence-progress-file 提交',
      };
    }
    if ((evidenceProgressToken || evidenceProgressConclusion) && !evidenceProgressFile) {
      return { ok: false, error: '证据进展令牌和结论只能通过 --evidence-progress-file 提交' };
    }
    const evidenceProgressSignature = evidenceProgressGrant
      ? projectExecutionDirectionSignature(
          [...evidenceProgressGrant.entries]
            .sort((left, right) => left.ref.localeCompare(right.ref))
            .map((artifact) => `${artifact.ref}:${artifact.sha256}`)
            .join('|'),
        ) || undefined
      : undefined;
    const currentProtocolCompletion = outcome === 'complete' && !!projectWorkItem;
    const currentOrdinaryCompletion = outcome === 'complete' && currentOrdinaryProtocol;
    const completionShapeError = outcome === 'complete' && params?.completionChecklist !== undefined
      ? supervisorCompletionFileShapeError(params.completionChecklist)
      : null;
    if (completionShapeError) return { ok: false, error: completionShapeError };
    const declaredCompletionEvidenceRefs = supervisorCompletionEvidenceRefs(params?.completionChecklist);
    if (currentProtocolCompletion
      && params?.completionChecklist !== undefined
      && declaredCompletionEvidenceRefs.length === 0) {
      return {
        ok: false,
        error: '项目 --completion-file 必须在每个 stopWhen/validation 条件中使用 evidenceRefs 引用项目内实际证据文件；自然语言哈希或汇总说明不能替代受控文件核验',
      };
    }
    if (currentProtocolCompletion && (
      !completionEvidenceGrant
      || completionEvidenceGrant.expiresAt <= decisionAt
      || completionEvidenceGrant.laneId !== lane.id
      || completionEvidenceGrant.projectId !== projectSession?.id
      || completionEvidenceGrant.workItemId !== projectWorkItem?.id
    )) {
      return {
        ok: false,
        error: '完成证据尚未由控制层读取实际文件并核验内容哈希；请通过 CLI 的 --completion-file 提交，不能伪造或复用核验令牌',
      };
    }
    if (currentOrdinaryCompletion) {
      if (!completionFile) {
        return { ok: false, error: '当前普通监督协议完成裁决必须通过 --completion-file 提交结构化核验' };
      }
    }
    const verifiedCompletionEvidence = new Map((completionEvidenceGrant?.entries || [])
      .map((artifact) => [artifact.ref, artifact]));
    const completionCriteria = outcome === 'complete' && projectWorkItem
      ? projectStructuredCompletionChecklist(
          projectWorkItem,
          params?.completionChecklist,
          verifiedCompletionEvidence,
        ).criteria
      : undefined;
    const completionResult = outcome === 'complete'
      ? normalizeProjectCompletionResult({
        summary: contextSummary || diffSummary || reason || evidence || '监督 AI 已确认达到停止条件',
        validation: projectWorkItem?.contract.validation.length
          ? projectWorkItem.contract.validation
          : [testResult || effectiveSupervisorLaneConfig(lane).stopWhen].filter(Boolean),
        evidence: evidence || undefined,
        criteria: completionCriteria,
        completedAt: decisionAt,
      })
      : undefined;
    let pendingProjectExecutionRecord: ProjectExecutionRecord | undefined;
    let proposedOrdinaryPlan: OrdinarySupervisorPlan | undefined;
    const recordProjectExecution = (consumeDecision: boolean) => {
      if (!projectSession || !projectWorkItem || !pendingProjectExecutionRecord) return;
      store.applyProjectManagerAction({
        type: 'record-execution',
        workItemId: projectWorkItem.id,
        record: pendingProjectExecutionRecord,
        consumeDecision,
      }, projectSession.id);
      if (consumeDecision && evidenceProgressToken) {
        completionEvidenceGrants.delete(evidenceProgressToken);
      }
      pendingProjectExecutionRecord = undefined;
    };
    if (projectManagedLane && (
      !lane.projectManagerProjectId
      || !lane.projectWorkItemId
      || !projectSession
      || !projectWorkItem
      || !projectSupervisorLaneOwnsWorkItem(lane, projectWorkItem)
    )) {
      const bindingError = '项目监督绑定不完整、已过期或与工作项不一致；已暂停该通道，禁止回退到当前选中项目继续裁决';
      if (outcome === 'needs-human' && projectSession) {
        store.updateLane(lane.id, {
          awaitingReview: false,
          activeReviewId: undefined,
          reviewWorkerTurnId: undefined,
          reviewOpenedAt: undefined,
          reviewDeliveryConfirmedAt: undefined,
          reviewWatchdogState: undefined,
          autoDecisionLimitReached: false,
        });
        const transition = queueProjectSupervisorTransition({
          sessionId: projectSession.id,
          laneId: lane.id,
          workItemId: lane.projectWorkItemId,
          kind: 'project-action-required',
          eventType: 'supervisor.project-binding-recovery',
          summary: reason || bindingError,
          evidence,
          contextSummary: [contextSummary || diffSummary || executionError, impact, next || alternatives]
            .filter(Boolean).join('\n'),
          instruction: [
            '这是项目内部绑定或运行时恢复请求，由项目 AI 处理，不是普通用户审批。',
            '先读取项目状态并只读核对任务终端实时屏幕；Hook 状态 unknown 不能单独证明任务 Agent 缺失。',
            '恢复工作项和监督绑定后继续编排。只有确属用户控制的外部条件、用户独有信息或高风险授权时，项目 AI 才能使用 project ask。',
          ].join('\n'),
        });
        saveProjectManagerSnapshot(projectSession.id);
        return {
          ok: true,
          outcome,
          projectNotification: true,
          transitionId: transition?.id,
          message: '项目监督绑定恢复请求已交给项目 AI；未创建普通监督 pendingApproval',
        };
      }
      store.pauseSupervisorLane(lane.id, bindingError);
      store.appendSupervisorLog(lane.id, '项目绑定校验失败', bindingError);
      return { ok: false, error: bindingError };
    }
    if (projectManagedLane && projectSession?.status !== 'active') {
      const statusError = '项目当前未处于 active 状态；已暂停该监督通道，禁止沿用旧任务合同继续裁决';
      store.pauseSupervisorLane(lane.id, statusError);
      store.appendSupervisorLog(lane.id, '项目状态校验失败', statusError);
      return { ok: false, error: statusError };
    }
    const projectTaskBindingError = projectManagedLane && projectSession && projectWorkItem
      ? projectWorkItem.goalId !== activeProjectGoal(projectSession).id
        ? '项目监督绑定的任务不属于当前主目标'
        : ['completed', 'stopped'].includes(projectWorkItem.status)
          ? '项目监督绑定的任务已经结束'
          : projectWorkItem.requirementsVersion !== projectRequirementsVersion(projectSession)
            || projectWorkItem.authorizationVersion !== projectAuthorizationVersion(projectSession)
            ? '项目需求或前置条件已经更新，旧版本授权已经失效'
            : projectWorkItem.subgoalId
              ? projectWorkItemSubgoalDependencyError(projectSession, projectWorkItem)
              : null
      : null;
    if (projectTaskBindingError) {
      const contractError = `${projectTaskBindingError}；已暂停该通道，等待项目 AI 重新派发`;
      store.pauseSupervisorLane(lane.id, contractError);
      store.appendSupervisorLog(lane.id, '项目任务合同校验失败', contractError);
      return { ok: false, error: contractError };
    }
    if (projectManagedLane && projectSession && projectWorkItem) {
      detectedVerificationLimitation ||= projectVerificationLimitationFromDecision(
        projectSession,
        projectWorkItem,
        [reason, impact, alternatives, evidence, contextSummary, diffSummary, executionError],
        [reason, impact, contextSummary, diffSummary].filter(Boolean),
      );
      if (detectedVerificationLimitation) {
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: { verificationLimitation: detectedVerificationLimitation },
        }, projectSession.id);
      }
      if (detectedVerificationLimitation && projectTaskBatch
        && (outcome === 'continue' || outcome === 'rework')
        && projectTaskBatchRepeatsUnavailableVerification(projectTaskBatch)) {
        const blocker = '当前成果受 GUI 自动化能力限制；监督请求仍要求原黑盒点击/输入证据，控制层已阻止重复派发。';
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: {
            status: 'waiting-decision',
            latestBlocker: blocker,
            verificationLimitation: detectedVerificationLimitation,
          },
        }, projectSession.id);
        store.pauseSupervisorLane(lane.id, blocker);
        store.appendProjectManagerEvent({
          kind: 'guard-triggered',
          workItemId: projectWorkItem.id,
          summary: blocker,
          payload: {
            decision: 'pause',
            reason: 'verification-capability-limited',
            attentionRequired: false,
          },
        }, projectSession.id);
        void requestProjectPauseUserDecision(projectSession.id, blocker).catch((error) => {
          console.warn('[project-manager] failed to persist verification-limited user decision', error);
        });
        const question = useStore.getState().projectManagers
          .find((candidate) => candidate.id === projectSession.id)?.pendingUserQuestion;
        return question ? {
          ok: true,
          outcome: 'needs-human',
          userInterventionRequired: true,
          question,
          message: '已阻止重复 GUI 验证路线，并向用户展示替代验证、人工验收、暂缓验证、跳过并后续重排或保持暂停选项。',
        } : { ok: false, error: '无法为验证能力限制生成用户处理问题' };
      }
    }
    const taskRuntimeMinutes = projectWorkItem?.startedAt
      ? Math.max(0, Date.now() - projectWorkItem.startedAt) / 60_000
      : 0;
    if (projectManagedLane && outcome === 'needs-human') {
      if (!escalationBoundary) {
        return { ok: false, error: '项目专属监督升级项目 AI 时必须提供 --escalation-boundary，普通技术选择应由监督 AI 自主处理' };
      }
      if (!reason || !impact) {
        return { ok: false, error: '项目专属监督升级时必须同时提供事实化的 --reason 和边界影响 --impact' };
      }
      if (escalationBoundary === 'budget-exhausted' && projectWorkItem) {
        const budget = projectWorkItem.contract.budget;
        if (projectWorkItem.attempts < budget.maxTaskRetries
          && taskRuntimeMinutes < budget.maxAggregateWorkerMinutes) {
          return { ok: false, error: '当前真实任务失败或执行时长硬预算尚未耗尽，不能使用 budget-exhausted 绕过任务 AI 的自主推进责任' };
        }
      }
    } else if (rawEscalationBoundary) {
      return { ok: false, error: '--escalation-boundary 仅用于项目专属监督的 needs-human 裁决' };
    }
    if (proposalKind === 'clarification') {
      if (projectManagedLane) {
        return { ok: false, error: '监督 AI 不能直接补充用户规划；请使用 needs-human important + contract-change 把细节、影响和推荐方案交给项目 AI，由项目 AI 通过 project ask 取得用户确认' };
      }
      const questions = ordinaryClarificationQuestions(reason);
      if (questions.length < 2 || questions.length > 5) {
        return { ok: false, error: '普通监督需求对齐必须在 --reason 中一次提出 2-5 个明确问题，并分别用问号结尾' };
      }
      if (!impact || !alternatives) {
        return { ok: false, error: '普通监督需求对齐必须附 --impact 说明答案影响，并用 --alternatives 给出整组推荐默认答案' };
      }
      if (next) {
        return { ok: false, error: '需求对齐等待用户集中答复时不得携带 --next 或提前向任务 AI 投递' };
      }
    }
    if (outcome !== 'needs-human' && session.pendingApprovals.some((approval) => approval.laneId === lane.id)) {
      return { ok: false, error: lane.projectManagerProjectId
        ? '当前通道仍有待项目管理 AI 处理的决策项；补充意见只用于更新上下文，不能绕过项目管理 AI 自动继续'
        : '当前通道仍有待用户决策项；补充意见只用于更新上下文，不能绕过用户自动继续' };
    }
    const autonomous = effectiveSupervisorAutonomous(session, lane);
    const remoteSshControl = isRemoteSshControlledLane(lane, store.workspaces);
    const laneConfig = effectiveSupervisorLaneConfig(lane);
    if (lane.autoDecisionLimitReached && !autonomous) {
      return { ok: false, error: '已达到自动判断上限，等待人工审阅后继续' };
    }
    // A supervisor must not smuggle a declared route/important proposal through
    // an auto-continue decision. Such proposals always stop for user consent.
    if (!isSupervisorProposalAllowed(outcome, proposalKind)) {
      return { ok: false, error: '小范围路线调整须使用 route-adjustment 配合 continue/rework；需求对齐、重大路线变更、重要建议或待续方向不足必须使用对应 proposal-kind 配合 needs-human' };
    }
    if (proposalKind === 'direction-needed' && !(
      lane.awaitingDirectionAfterWaitingResume
      && laneConfig.waitForNextDirection
    )) {
      return { ok: false, error: 'direction-needed 仅可用于待续恢复后新方向仍不足的通道' };
    }
    if (!projectManagedLane && proposalKind === 'context-recovery') {
      return { ok: false, error: '当前普通监督协议只把历史审计作为监督证据，不允许向任务 AI 发送旧上下文恢复指令' };
    }
    if (proposalKind === 'route-adjustment' && !next) {
      return { ok: false, error: 'route-adjustment 必须通过 --task-file 携带明确、低风险的结构化成果任务' };
    }
    if (!isSupervisorNextAllowed(outcome, next)) {
      return { ok: false, error: '只有 continue、rework 可以携带成果任务；needs-human 的 --next 仅用于用户决策推荐' };
    }
    let ordinaryRecommendedOption: string | undefined;
    if (currentOrdinaryProtocol && outcome === 'needs-human') {
      const recommendationOptional = proposalKind === 'clarification';
      if (!reason || !impact || !alternatives || (!recommendationOptional && !next)) {
        return {
          ok: false,
          error: '普通监督升级用户必须提供事实化 reason、影响 impact、互斥 alternatives；非澄清升级还必须用 --next 给出推荐项',
        };
      }
      if (proposalKind !== 'clarification') {
        const decisionOptions = supervisorDecisionOptions(alternatives, next);
        if (decisionOptions.length < 2) {
          return {
            ok: false,
            error: '普通监督升级用户时 alternatives 必须提供至少两个可解析的互斥方案，并用 --next 明确推荐其中一项',
          };
        }
        ordinaryRecommendedOption = supervisorRecommendedOptionValue(decisionOptions, next);
        if (!ordinaryRecommendedOption) {
          return {
            ok: false,
            error: '普通监督升级用户时 --next 必须无歧义地指向 alternatives 中的一个推荐项（例如“推荐方案 A：……”）',
          };
        }
      }
      const escalationText = `${reason}\n${impact}\n${alternatives}\n${next}`;
      const immediateUserBoundary = proposalKind === 'clarification'
        || proposalKind === 'direction-needed'
        || proposalKind === 'route-change'
        || ['contract-change', 'external-blocker', 'user-only-information', 'high-risk-action']
          .includes(escalationBoundary || '')
        || USER_ONLY_DECISION.test(escalationText)
        || /用户.{0,12}(?:确认|决定|选择|批准|补充|提供)|人工决定/iu.test(escalationText)
        || /删除|破坏性覆盖|提权|发布|部署|生产环境|真实硬件|人工操作|凭据|密钥|令牌|密码|credential|secret|token|password/iu.test(escalationText);
      if (immediateUserBoundary) {
        store.updateLane(lane.id, { ordinaryBlocker: undefined });
      } else {
        const fingerprint = projectExecutionDirectionSignature(`${reason}\n${impact}`) || 'ordinary-blocker';
        const evidenceFingerprint = projectExecutionDirectionSignature([
          evidence,
          diffSummary,
          testResult,
          changedFiles.join('|'),
          contextSummary,
        ].join('\n')) || 'no-new-evidence';
        const previous = lane.ordinaryBlocker;
        const sameBlocker = previous?.fingerprint === fingerprint
          && previous.evidenceFingerprint === evidenceFingerprint;
        const newReview = previous?.reviewId !== lane.activeReviewId
          || previous?.workerTurnId !== lane.workerTurnId;
        const occurrences = sameBlocker
          ? newReview ? previous.occurrences + 1 : previous.occurrences
          : 1;
        store.updateLane(lane.id, {
          ordinaryBlocker: {
            fingerprint,
            evidenceFingerprint,
            occurrences,
            reviewId: lane.activeReviewId,
            workerTurnId: lane.workerTurnId,
            updatedAt: Date.now(),
          },
        });
        if (occurrences < 2) {
          return {
            ok: false,
            error: '该技术阻塞尚未达到升级条件；请先通过 --task-file 派发一次诊断、返工或低风险替代任务。相同阻塞连续两轮无新证据后才能上报用户',
          };
        }
      }
    }
    if (
      (outcome === 'continue' || outcome === 'rework')
      && !next
      && !permissionCommand
      && !permissionResponse
    ) {
      return { ok: false, error: '统一监督的 continue/rework 必须携带明确成果任务（当前协议使用 --task-file）；无法安全推进时请使用 needs-human' };
    }
    const disclosureError = projectWorkItem && next && (outcome === 'continue' || outcome === 'rework')
      ? projectTaskInstructionDisclosureError(next)
      : null;
    if (disclosureError) return { ok: false, error: disclosureError };
    const contractDisclosureError = projectWorkItem && lane.projectTaskContractPending === true
      ? projectTaskContractDisclosureError(projectWorkItem.contract)
      : null;
    if (contractDisclosureError) return { ok: false, error: contractDisclosureError };
    const guardedNext = next;
    const projectPolicyViolation = projectSession?.progressSnapshot?.entries
      .find((entry) => entry.status === 'POLICY-VIOLATION');
    if (projectWorkItem && projectPolicyViolation && outcome !== 'needs-human') {
      store.updateLane(lane.id, { awaitingReview: true });
      return {
        ok: false,
        error: `项目规则检查阻断当前检查点：${projectPolicyViolation.path}。监督 AI 只能说明违规事实并要求原任务 AI 按项目规范返工`,
      };
    }
    if (params?.stagePlan !== undefined) {
      if (!currentOrdinaryProtocol) {
        return {
          ok: false,
          error: '当前项目监督不维护 selectedRoute、expectedPaths 或命令型阶段计划；只通过 --task-file 下达中性单成果批次和验收缺口。多任务拓扑由项目 AI 创建多个独立工作项决定',
        };
      }
      if (outcome === 'needs-human' || permissionResponse) {
        return { ok: false, error: '--stage-plan-file 仅用于普通监督的 continue/rework/complete 裁决' };
      }
      const previousOrdinaryPlan = lane.decisions
        ?.find((decision) => decision.ordinaryPlan)?.ordinaryPlan;
      const normalizedPlan = normalizeOrdinarySupervisorPlan(
        params.stagePlan,
        effectiveSupervisorLaneConfig(lane).planRevision || 1,
        previousOrdinaryPlan,
      );
      if (!normalizedPlan.plan) return { ok: false, error: normalizedPlan.error };
      proposedOrdinaryPlan = normalizedPlan.plan;
      const planText = [
        proposedOrdinaryPlan.objective,
        ...proposedOrdinaryPlan.milestones.flatMap((milestone) => [
          milestone.outcome,
          ...milestone.acceptance,
        ]),
        ...proposedOrdinaryPlan.remainingWork,
      ].join('\n');
      const planRisk = autonomousActionBlockReason(planText)
        || configuredActionBlockReason(planText, effectiveSupervisorForbiddenActions(session, lane))
        || workScopeBlockReason(
          planText,
          effectiveSupervisorWorkScope(session, lane),
          lane.scopeRoot || lane.projectDir,
        );
      if (planRisk) return { ok: false, error: `普通监督成果计划超出用户规划边界：${planRisk}` };
    }
    const currentOrdinaryPlan = currentOrdinaryProtocol
      ? proposedOrdinaryPlan || lane.decisions
        ?.find((decision) => decision.ordinaryPlan?.sourceRevision
          === (effectiveSupervisorLaneConfig(lane).planRevision || 1))?.ordinaryPlan
      : undefined;
    const ordinaryCompletionPlan = currentOrdinaryPlan;
    if (currentOrdinaryProtocol && ordinaryTaskDispatch) {
      const milestone = currentOrdinaryPlan?.milestones
        .find((candidate) => candidate.id === ordinaryTaskDispatch!.milestoneId);
      if (!milestone || milestone.status === 'completed') {
        return { ok: false, error: '任务派发必须绑定当前成果计划中尚未完成的 milestoneId' };
      }
      const userStopWhen = effectiveSupervisorLaneConfig(lane).stopWhen.trim();
      const userStopCriteria = [...new Set([
        userStopWhen,
        ...userStopWhen.split(/\r?\n|[;；。，,、]/u),
      ].map((item) => projectCriterionIdentity(item)).filter(Boolean))];
      const comparableUserStopCriteria = userStopCriteria.filter((item) => item.length >= 4);
      const dispatchedFields = [
        ordinaryTaskDispatch.outcome,
        ...ordinaryTaskDispatch.constraints,
        ...ordinaryTaskDispatch.acceptanceGap,
        ...ordinaryTaskDispatch.evidenceContext,
        ...(ordinaryTaskDispatch.verification?.expectedEvidence || []),
        ...(ordinaryTaskDispatch.verification?.fallbackWhenUnavailable || []),
        ...(ordinaryTaskDispatch.returnWhen || []),
      ];
      const copiedUserCondition = dispatchedFields.find((item) => {
        const identity = projectCriterionIdentity(item);
        if (!identity) return false;
        if (userStopCriteria.includes(identity)) return true;
        if (identity.length < 4) return false;
        return comparableUserStopCriteria.some((criterion) => {
          const shorter = Math.min(identity.length, criterion.length);
          const longer = Math.max(identity.length, criterion.length);
          if (identity.includes(criterion)) {
            return identity.length - criterion.length <= 12;
          }
          return shorter / longer >= 0.75 && criterion.includes(identity);
        });
      });
      if (copiedUserCondition) {
        return {
          ok: false,
          error: `普通监督任务包不能复制或轻微改写用户总停止条件：${copiedUserCondition}。请由监督 AI 针对本次任务分别给出成果、约束、任务级验收和必要现状；用户总条件只用于成果计划和最终 complete 核验`,
        };
      }
    }
    if (!projectManagedLane
      && lane.ordinaryPlanRequired === true
      && (outcome === 'continue' || outcome === 'rework')
      && !permissionResponse
      && !ordinaryCompletionPlan) {
      return {
        ok: false,
        error: '新普通监督首次执行前必须先完成轻量需求判断：无实质歧义时通过 --stage-plan-file 提交正式计划；有实质歧义时使用 needs-human --proposal-kind clarification 一次提出 2-5 个问题',
      };
    }
    if (currentOrdinaryProtocol && outcome === 'complete' && !ordinaryCompletionPlan) {
      return { ok: false, error: '当前用户规划版本尚无监督成果计划，不能提交 complete' };
    }
    if (outcome === 'complete' && ordinaryCompletionPlan && (
      ordinaryCompletionPlan.milestones.some((milestone) => milestone.status !== 'completed')
      || ordinaryCompletionPlan.remainingWork.length > 0
    )) {
      return {
        ok: false,
        error: '普通监督阶段计划仍有未完成执行项或剩余工作；请继续推进并更新 --stage-plan-file，不能直接提交 complete',
      };
    }
    if (currentOrdinaryCompletion && currentOrdinaryPlan) {
      const checklistError = ordinaryCompletionChecklistError(
        params?.completionChecklist,
        effectiveSupervisorLaneConfig(lane).stopWhen,
        currentOrdinaryPlan.milestones.flatMap((milestone) => milestone.acceptance),
      );
      if (checklistError) return { ok: false, error: checklistError };
    }
    const remoteNextBlockReason = remoteSshControl ? remoteSshActionBlockReason(guardedNext) : null;
    if (outcome !== 'needs-human' && remoteNextBlockReason) {
      return { ok: false, error: `SSH 远程控制终端禁止自动执行${remoteNextBlockReason}；请使用 needs-human 交给人工处理` };
    }
    const nextBlockReason = autonomousActionBlockReason(guardedNext);
    if (outcome !== 'needs-human' && nextBlockReason) {
      return { ok: false, error: `监督 AI 禁止自动执行${nextBlockReason}；请使用 needs-human 交给人工处理` };
    }
    const forbiddenActions = effectiveSupervisorForbiddenActions(session, lane);
    const configuredNextBlockReason = configuredActionBlockReason(guardedNext, forbiddenActions);
    if (outcome !== 'needs-human' && configuredNextBlockReason) {
      return { ok: false, error: `该动作命中用户勾选的禁止事项：${configuredNextBlockReason}；请使用 needs-human` };
    }
    const effectiveWorkScope = effectiveSupervisorWorkScope(session, lane);
    const scopeBlockReason = workScopeBlockReason(
      guardedNext,
      effectiveWorkScope,
      lane.scopeRoot || lane.projectDir,
    );
    if (outcome !== 'needs-human' && scopeBlockReason) {
      return { ok: false, error: `${scopeBlockReason}；超出工作范围的动作必须使用 needs-human` };
    }
    if (
      next
      && outcome !== 'needs-human'
      && effectiveWorkScope === 'plan-defined'
      && !laneConfig.planFilePath.trim()
    ) {
      return { ok: false, error: '工作范围设为“仅计划文件定义范围”，但当前没有计划文件；请补充计划文件或使用 needs-human' };
    }
    const hasTaskContext = !!(
      effectiveSupervisorTaskGoal(lane)
      || lane.currentTask?.trim()
      || laneConfig.planFilePath.trim()
    );
    if (next && outcome !== 'needs-human' && !hasTaskContext) {
      return { ok: false, error: '当前没有任务目标、已捕获任务或计划文件；可继续停止裁决，但自主发送下一步必须交给人工' };
    }
    if (permissionCommand || permissionResponse) {
      if (remoteSshControl) {
        return { ok: false, error: 'SSH 远程控制终端的权限请求必须由人工确认，监督 AI 不得自动发送批准响应' };
      }
      const permissionBlockReason = autonomousActionBlockReason(permissionCommand);
      const configuredPermissionBlockReason = configuredActionBlockReason(permissionCommand, forbiddenActions);
      if (!permissionCommand || !isAutonomousPermissionResponseAllowed(permissionResponse)) {
        return { ok: false, error: '权限确认必须提供命令说明，并且响应只能是 y、yes、allow 或 approve' };
      }
      if (permissionBlockReason) {
        return { ok: false, error: `监督 AI 禁止自动确认${permissionBlockReason}；请交给人工确认` };
      }
      if (configuredPermissionBlockReason) {
        return { ok: false, error: `权限请求命中用户勾选的禁止事项：${configuredPermissionBlockReason}；请交给人工确认` };
      }
      const permissionScopeBlockReason = workScopeBlockReason(
        permissionCommand,
        effectiveWorkScope,
        lane.scopeRoot || lane.projectDir,
      );
      if (permissionScopeBlockReason) {
        return { ok: false, error: `${permissionScopeBlockReason}；该权限请求必须交给人工确认` };
      }
      if (outcome === 'complete' || outcome === 'needs-human') {
        return { ok: false, error: '终端权限确认只能与 continue 或 rework 裁决一起提交' };
      }
      if (next) {
        return { ok: false, error: '终端权限确认后需等待代理恢复；请不要在同一裁决中追加 --task-file 或旧 --next 任务内容' };
      }
    }
    const agentState = ((w.__wmux_getAgentStates?.() || {})[surfaceId] || undefined) as SupervisorAgentStateView | undefined;
    if (shouldDeferProjectEscalationWhileTaskRuns({
      projectManaged: projectManagedLane,
      outcome,
      escalationBoundary,
      taskState: agentState?.state,
    })) {
      store.updateLane(lane.id, {
        awaitingReview: false,
        activeReviewId: undefined,
        reviewWorkerTurnId: undefined,
        reviewOpenedAt: undefined,
        reviewDeliveryConfirmedAt: undefined,
        reviewWatchdogState: undefined,
      });
      appendSupervisorRecord(session, lane, 'supervisor.decision.deferred', {
        outcome,
        escalationBoundary,
        reason,
        impact,
        taskState: agentState?.state,
        waitingFor: 'task-lifecycle-stop',
      });
      store.appendSupervisorLog(lane.id, '监督裁决已延期', '任务 AI 仍在运行；等待本轮结束 hook 后重新审核，不升级项目阻塞');
      return {
        ok: true,
        outcome,
        deferred: true,
        waitingForTaskCompletion: true,
        message: '任务 AI 仍在运行；本轮裁决已延期，结束 hook 到达后控制层会重新唤醒监督审核。',
      };
    }
    if (!projectManagedLane && next) {
      const runtimeBlock = ordinaryTaskDeliveryBlockReason({
        agentState: agentState?.state,
        runtimeState: terminalRuntimeStatus(lane.surfaceId)?.state,
        spawnedAgentStatus: store.agentMeta.get(lane.surfaceId)?.status,
        screenText: terminalScreenTail(surfaceId, 40),
      });
      if (runtimeBlock) {
        store.updateLane(lane.id, { awaitingReview: true });
        appendSupervisorRecord(session, lane, 'supervisor.delivery.blocked', {
          kind: 'next',
          error: runtimeBlock,
          taskRuntimeState: agentState?.state || 'unknown',
        });
        store.appendSupervisorLog(lane.id, '下一步发送已阻止', runtimeBlock);
        return { ok: false, error: runtimeBlock, taskRuntimeBlocked: true };
      }
    }
    const proactiveProjectFollowUp = !lane.awaitingReview
      && !!lane.projectManagerProjectId
      && autonomous
      && (outcome === 'continue' || outcome === 'rework')
      && !!next
      && !permissionCommand
      && !permissionResponse;
    const preflight = evaluateSupervisorDecisionPreflight(session, lane, {
      taskState: agentState?.state || 'unknown',
      ...(projectManagedLane ? { project: { projectId: projectSession!.id, workItemId: projectWorkItem!.id, bindingCurrent: true } } : {}),
      outcome,
      hasNext: !!next,
      permissionRequested: !!permissionCommand || !!permissionResponse,
    });
    if (!preflight.decisionReady) {
      return { ok: false, error: lane.projectManagerProjectId
        ? `${preflight.blockers[0] || '当前没有待裁决轮次'}；项目专属监督仅可在任务终端非运行时，通过 --task-file 携带明确、低风险的中性成果批次主动提交 continue/rework`
        : `${preflight.blockers[0] || '当前没有待裁决轮次'}；请等待工作终端任务结束或权限阻塞通知` };
    }
    const repeatedProjectTaskBatch = !!projectTaskBatch
      && isCurrentProjectTaskBatch(lane.projectTaskBatch)
      && JSON.stringify(lane.projectTaskBatch) === JSON.stringify(projectTaskBatch)
      && lane.decisions?.[0]?.taskWorkMode === requestedTaskWorkMode;
    if (proactiveProjectFollowUp && lane.decisions?.[0]?.outcome === outcome
      && (repeatedProjectTaskBatch || (!projectTaskBatch && lane.decisions[0].next.trim() === next))
      && !retryRequested) {
      return { ok: false, error: '该主动补证指令与上一条裁决完全相同；请等待状态变化，或在有新失败证据时显式标记 retry' };
    }
    const selectedPermissions = selectedAutonomyPermissions(
      effectiveSupervisorAutonomyPermissions(session, lane),
    );
    const requiredPermissions = requiredAutonomyPermissions({
      outcome,
      next: guardedNext,
      proposalKind,
      permissionCommand,
      permissionResponse,
      agentState,
    });
    const missingPermissions = requiredPermissions.filter((permission) => !selectedPermissions.includes(permission));
    if (missingPermissions.length > 0) {
      const labels = missingPermissions.map((permission) => AUTONOMY_PERMISSION_LABELS[permission]).join('、');
      return { ok: false, error: `当前会话未授予“${labels}”；请使用 needs-human 交给人工处理` };
    }
    if (permissionCommand || permissionResponse) {
      if (!isPermissionBlockedState(agentState)) {
        return { ok: false, error: '未检测到可自动确认的真实权限阻塞；状态未知或普通输入必须交给人工' };
      }
      const terminalEvidence = terminalScreenTail(surfaceId);
      if (!terminalEvidence) {
        return { ok: false, error: '无法读取当前终端中的具体权限命令；不能仅凭 Hook 泛化原因自动确认' };
      }
      if (!permissionCommandMatchesEvidence(permissionCommand, terminalEvidence)) {
        return { ok: false, error: '权限命令与当前终端提示中的具体命令不一致；不能自动确认，请交给人工' };
      }
      const permissionEvidence = [agentState.blockedReason || '', terminalEvidence].filter(Boolean).join('\n');
      const evidenceRisk = autonomousActionBlockReason(permissionEvidence);
      if (evidenceRisk) {
        return { ok: false, error: `当前权限提示包含${evidenceRisk}；不能自动确认，请交给人工` };
      }
      const configuredEvidenceRisk = configuredActionBlockReason(permissionEvidence, forbiddenActions);
      if (configuredEvidenceRisk) {
        return { ok: false, error: `当前权限提示命中禁止事项：${configuredEvidenceRisk}；不能自动确认，请交给人工` };
      }
      const evidenceScopeRisk = workScopeBlockReason(
        permissionEvidence,
        effectiveWorkScope,
        lane.scopeRoot || lane.projectDir,
      );
      if (evidenceScopeRisk) {
        return { ok: false, error: `${evidenceScopeRisk}；不能自动确认，请交给人工` };
      }
      if (blockedRequestAlreadyAnswered(lane, agentState)) {
        return { ok: false, error: '该权限阻塞状态已经确认过，禁止重复发送响应' };
      }
      const permissionLoopReason = permissionConfirmationLoopReason(lane, permissionCommand);
      if (permissionLoopReason) {
        return { ok: false, error: permissionLoopReason };
      }
    } else if (agentState?.state === 'blocked'
      && !isAwaitingNextPromptState(agentState)
      && outcome !== 'needs-human' && !next) {
      return { ok: false, error: '工作终端仍在阻塞；请明确回答技术问题、确认低风险权限，或使用 needs-human' };
    } else if (next && outcome !== 'needs-human') {
      if (projectManagedLane && (!agentState?.state || agentState.state === 'unknown')) {
        return {
          ok: false,
          error: '项目任务终端尚未产生可信 Agent 生命周期，禁止投递首条任务契约；请等待冷启动任务的 UserPromptSubmit/Stop hook 后重新读取状态，不要盲目重发',
        };
      }
      if (agentState?.state === 'working') {
        return { ok: false, error: '工作终端仍在运行，不能注入下一步' };
      }
      if (isAwaitingNextPromptState(agentState)) {
        // A completed agent waiting for another prompt is exactly when a supervisor may send the next batch.
      } else if (isPermissionBlockedState(agentState)) {
        return { ok: false, error: '当前是权限阻塞，必须使用权限确认参数，不能发送普通下一步' };
      } else if (agentState?.state === 'blocked' && !isQuestionBlockedState(agentState)) {
        return { ok: false, error: '当前阻塞不是明确的技术问题或方案选择，不能自动输入内容' };
      } else if (isQuestionBlockedState(agentState) && !isLowRiskTechnicalQuestion(agentState, next)) {
        return { ok: false, error: '当前输入涉及用户偏好、业务/账户决定或缺少明确技术证据；请使用 needs-human' };
      } else if (isQuestionBlockedState(agentState) && blockedRequestAlreadyAnswered(lane, agentState)) {
        return { ok: false, error: '该技术问题阻塞状态已经回答过，禁止重复发送响应' };
      }
    }
    if (outcome === 'complete' && agentState?.state === 'working') {
      return { ok: false, error: '工作终端仍在运行，不能判定完成' };
    }

    if (!projectSession && outcome === 'needs-human'
      && session.pendingApprovals.some((approval) => approval.laneId === lane.id)) {
      store.appendSupervisorLog(lane.id, '重复人工决策已忽略', reason || '该终端已有待决项');
      return { ok: true, outcome, duplicate: true };
    }

    if ((next || permissionResponse) && supervisorDeliveriesInFlight.has(lane.id)) {
      return { ok: false, error: '当前通道已有裁决正在投递；请等待本次投递确认后再裁决' };
    }

    if (projectSession && projectWorkItem && permissionResponse) {
      if (projectAcceptedRequirementsVersion(projectSession) !== projectRequirementsVersion(projectSession)) {
        return { ok: false, error: '项目需求或前置条件已经更新；旧版本授权已经失效，必须交回项目管理 AI 重新规划' };
      }
      const permissionTestCommand = isProjectTargetedTestCommand(permissionCommand)
        ? permissionCommand
        : undefined;
      const permissionAuthorizationError = projectPermissionAuthorizationError(
        projectWorkItem.contract,
        permissionCommand,
      );
      if (permissionAuthorizationError) {
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: { status: 'waiting-decision', latestBlocker: permissionAuthorizationError },
        }, projectSession.id);
        store.updateLane(lane.id, { awaitingReview: true });
        queueProjectSupervisorAnomaly(
          projectSession,
          lane,
          projectWorkItem,
          'supervisor.permission-outside-contract',
          permissionAuthorizationError,
          { contextSummary: permissionCommand },
        );
        saveProjectManagerSnapshot(projectSession.id);
        return { ok: false, error: permissionAuthorizationError };
      }
      const contractViolation = projectContractViolation(projectWorkItem.contract, {
        instruction: permissionCommand,
        command: permissionCommand,
        testCommand: permissionTestCommand,
      });
      if (contractViolation) {
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: { status: 'waiting-decision', latestBlocker: contractViolation },
        }, projectSession.id);
        store.updateLane(lane.id, { awaitingReview: true });
        queueProjectSupervisorAnomaly(
          projectSession,
          lane,
          projectWorkItem,
          'supervisor.permission-contract-violation',
          contractViolation,
          { contextSummary: permissionCommand },
        );
        saveProjectManagerSnapshot(projectSession.id);
        return { ok: false, error: contractViolation };
      }
    }
    if (projectSession && projectWorkItem && !permissionResponse) {
      if (projectAcceptedRequirementsVersion(projectSession) !== projectRequirementsVersion(projectSession)) {
        return { ok: false, error: '项目需求或前置条件已经更新；当前监督裁决基于旧版本，必须交回项目管理 AI 重新规划' };
      }
      if (outcome === 'needs-human') {
        if (escalationBoundary !== 'budget-exhausted') {
        const guard = evaluateProjectExecutionGuard({
          history: projectWorkItem.executionHistory,
          proposal: {
            action: `escalate:${escalationBoundary}`,
            command: guardedNext || reason,
            error: executionError || undefined,
            changedFiles,
            diffSummary: diffSummary || undefined,
            evidence,
            evidenceProgressSignature,
            workspaceVersion: String(params?.workspaceVersion || ''),
            testCommand: testCommand || undefined,
            testResult: testResult || undefined,
            fullSuite: params?.fullSuite === true,
            escalationBoundary,
            now: Date.now(),
          },
          budget: projectWorkItem.contract.budget,
          startedAt: projectWorkItem.startedAt,
        });
        pendingProjectExecutionRecord = guard.record;
        if (guard.decision !== 'allow') {
          recordProjectExecution(false);
          const projectDecisionRequired = guard.decision === 'replan';
          const guardEvent = {
            kind: 'guard-triggered',
            workItemId: projectWorkItem.id,
            summary: guard.reason || '升级请求触发执行护栏',
            payload: {
              decision: guard.decision,
              escalationBoundary,
              attentionRequired: guard.decision === 'pause',
            },
          } as const;
          if (guard.decision === 'pause') {
            void appendRecordedProjectEvent(projectSession, guardEvent, { persistSession: false })
              .catch((error) => console.warn('[project-manager] failed to record execution guard alert', error));
          }
          else store.appendProjectManagerEvent(guardEvent, projectSession.id);
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: {
              status: 'waiting-decision',
              latestBlocker: [reason || '监督 AI 提交项目状态通知', guard.reason].filter(Boolean).join('；'),
              ...(evidence ? { latestEvidence: evidence } : {}),
              ...(contextSummary || diffSummary || impact
                ? { latestContextSummary: contextSummary || diffSummary || impact }
                : {}),
            },
          }, projectSession.id);
          // The project transition is the completed handoff for this supervisor
          // turn. Keeping awaitingReview set would make Stop synthesize a false
          // idle-unreported event and immediately repeat the same decision.
          store.updateLane(lane.id, { awaitingReview: false, autoDecisionLimitReached: false });
          if (projectDecisionRequired) {
            queueProjectSupervisorTransition({
              sessionId: projectSession.id,
              laneId: lane.id,
              workItemId: projectWorkItem.id,
              kind: 'decision-required',
              eventType: 'supervisor.decision-required',
              summary: guard.reason || '任务连续未形成新进展，需要项目 AI 调整总计划或任务成果',
              evidence,
              contextSummary: contextSummary || diffSummary || executionError,
              instruction: [
                '任务连续两轮没有形成新的代码、测试、错误或已核验证据；监督已停止重复返工。',
                `项目 AI 应直接更新工作项 ${projectWorkItem.id} 的成果、依赖或优先级，然后使用 dispatch 恢复；若已有独立工作项则先推进独立项。`,
                '只有目标、验收、用户偏好、外部凭据、人工操作或高风险授权不足时才请求用户。',
              ].join('\n'),
            });
          } else {
            queueProjectSupervisorNotice({
              session: projectSession,
              lane,
              workItem: projectWorkItem,
              boundary: escalationBoundary,
              reason: guard.reason || reason || '项目监督状态通知触发执行护栏',
              impact,
              alternatives,
              evidence,
              contextSummary: contextSummary || diffSummary || executionError,
            });
          }
          saveProjectManagerSnapshot(projectSession.id);
          return {
            ok: true,
            outcome,
            projectNotification: true,
            guardDecision: guard.decision,
            projectDecisionRequired,
            workItemId: projectWorkItem.id,
            message: projectDecisionRequired
              ? '重复无进展通知已转为项目 AI 决策请求；未创建旧执行窗口'
              : '执行护栏已转换为项目模式专用状态通知；未创建普通监督待决请求',
          };
        }
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: {
            status: 'waiting-decision',
            latestBlocker: reason || '监督 AI 提交项目状态通知',
            ...(evidence ? { latestEvidence: evidence } : {}),
            ...(contextSummary || diffSummary || impact
              ? { latestContextSummary: contextSummary || diffSummary || impact }
              : {}),
          },
        }, projectSession.id);
        saveProjectManagerSnapshot(projectSession.id);
        }
      } else {
        const contractViolation = projectContractViolation(projectWorkItem.contract, {
          instruction: guardedNext,
          command: String(params?.command || ''),
          changedFiles,
          testCommand: testCommand || undefined,
          retry: retryRequested,
        });
        if (contractViolation) {
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: { status: 'waiting-decision', latestBlocker: contractViolation },
          }, projectSession.id);
          store.updateLane(lane.id, { awaitingReview: true });
          queueProjectSupervisorAnomaly(
            projectSession,
            lane,
            projectWorkItem,
            'supervisor.contract-violation',
            contractViolation,
            { evidence, contextSummary: contextSummary || diffSummary || guardedNext },
          );
          saveProjectManagerSnapshot(projectSession.id);
          return { ok: false, error: contractViolation };
        }
        if (outcome === 'complete' && !evidence) {
          return { ok: false, error: '项目管理任务完成裁决必须通过 --evidence 提供验证证据' };
        }
        if (outcome === 'complete') {
          const completionError = projectStageCompletionError(projectWorkItem, {
            ...(params || {}),
            verifiedEvidenceArtifacts: [...verifiedCompletionEvidence.values()],
          });
          if (completionError) return { ok: false, error: completionError };
        }
        if (consumeProjectTaskRetry
          && projectWorkItem.attempts >= projectWorkItem.contract.budget.maxTaskRetries) {
          store.updateLane(lane.id, { awaitingReview: true });
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: { status: 'waiting-decision', latestBlocker: '已达到任务重试上限' },
          }, projectSession.id);
          store.appendProjectManagerEvent({
            kind: 'guard-triggered',
            workItemId: projectWorkItem.id,
            summary: `已达到任务重试上限 ${projectWorkItem.contract.budget.maxTaskRetries} 次`,
            payload: { decision: 'replan' },
          }, projectSession.id);
          queueProjectSupervisorAnomaly(
            projectSession,
            lane,
            projectWorkItem,
            'supervisor.retry-budget-exhausted',
            `已达到任务重试上限 ${projectWorkItem.contract.budget.maxTaskRetries} 次`,
            { evidence, contextSummary: contextSummary || diffSummary || executionError },
          );
          saveProjectManagerSnapshot(projectSession.id);
          return { ok: false, error: '已达到任务重试上限，必须交回项目管理 AI 重新规划' };
        }
        const guard = evaluateProjectExecutionGuard({
            history: projectWorkItem.executionHistory,
            proposal: {
              action: String(params?.executionAction || guardedNext || outcome),
              command: String(params?.command || guardedNext || ''),
              error: executionError || undefined,
              changedFiles,
              diffSummary: diffSummary || undefined,
              evidence,
              evidenceProgressSignature,
              workspaceVersion: String(params?.workspaceVersion || ''),
              testCommand: testCommand || undefined,
              testResult: testResult || undefined,
              fullSuite: params?.fullSuite === true,
              retryKind,
              completion: outcome === 'complete',
              now: Date.now(),
            },
            budget: projectWorkItem.contract.budget,
            startedAt: projectWorkItem.startedAt,
          });
        pendingProjectExecutionRecord = guard.record;
        const historicalRecoveryEvidenceBatch = shouldAllowHistoricalRecoveryEvidenceBatch({
          projectTaskContractPending: lane.projectTaskContractPending,
          hasCurrentTaskBatch: !!lane.projectTaskBatch,
          guardDecision: guard.decision,
          replanTrigger: guard.replanTrigger,
          batch: projectTaskBatch,
        });
        if (guard.decision !== 'allow' && !historicalRecoveryEvidenceBatch) {
            recordProjectExecution(false);
            const itemStatus = guard.decision === 'pause' ? 'paused' : 'waiting-decision';
            store.applyProjectManagerAction({
              type: 'update-work-item',
              workItemId: projectWorkItem.id,
              patch: {
                status: itemStatus,
                latestBlocker: guard.reason,
              },
            }, projectSession.id);
            const guardEvent = {
              kind: 'guard-triggered' as const,
              workItemId: projectWorkItem.id,
              summary: guard.reason || '执行护栏已触发',
              payload: {
                decision: guard.decision,
                attentionRequired: guard.decision === 'pause',
              },
            };
            if (guard.decision === 'pause') {
              void appendRecordedProjectEvent(projectSession, guardEvent, { persistSession: false })
                .catch((error) => console.warn('[project-manager] failed to record execution guard alert', error));
            }
            else store.appendProjectManagerEvent(guardEvent, projectSession.id);
            if (guard.decision === 'pause') {
              store.pauseSupervisorLane(lane.id, guard.reason);
              queueProjectSupervisorRecovery(
                useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane,
                guard.reason || '执行护栏已暂停专属监督',
              );
            } else {
              store.updateLane(lane.id, { awaitingReview: false });
              if (guard.decision === 'replan') {
                queueProjectSupervisorTransition({
                  sessionId: projectSession.id,
                  laneId: lane.id,
                  workItemId: projectWorkItem.id,
                  kind: 'decision-required',
                  eventType: 'supervisor.decision-required',
                  summary: guard.reason || '任务连续无进展，需要项目 AI 调整总计划或任务成果',
                  evidence,
                  contextSummary: contextSummary || diffSummary || executionError,
                  instruction: [
                    '任务连续两轮没有形成新的代码、测试、错误或已核验证据；监督已停止重复返工。',
                    `项目 AI 应直接更新工作项 ${projectWorkItem.id} 的成果、依赖或优先级，然后使用 dispatch 恢复；若已有独立工作项则先推进独立项。`,
                    '只有用户目标、验收、偏好、外部凭据、人工操作或高风险授权不足时才请求用户。',
                  ].join('\n'),
                });
              } else {
                queueProjectSupervisorAnomaly(
                  projectSession,
                  lane,
                  projectWorkItem,
                  'supervisor.execution-guard',
                  guard.reason || '执行护栏已触发',
                  { evidence, contextSummary: contextSummary || diffSummary || executionError },
                );
              }
            }
            saveProjectManagerSnapshot(projectSession.id);
          return { ok: false, error: `${guard.reason}；已停止自动推进并交回项目管理 AI` };
        }
        if (consumeProjectTaskRetry) {
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: { attempts: projectWorkItem.attempts + 1 },
          }, projectSession.id);
        }
        if (outcome === 'continue' || outcome === 'rework') {
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: {
              ...(evidence ? { latestEvidence: evidence } : {}),
              ...(contextSummary || diffSummary ? { latestContextSummary: contextSummary || diffSummary } : {}),
              ...(executionError ? { latestBlocker: executionError } : {}),
            },
          }, projectSession.id);
        }
        if (outcome === 'complete') {
          store.applyProjectManagerAction({
            type: 'update-work-item',
            workItemId: projectWorkItem.id,
            patch: {
              status: 'completed',
              latestEvidence: evidence,
              completion: completionResult,
              completedAt: Date.now(),
              latestBlocker: undefined,
            },
          }, projectSession.id);
        }
        saveProjectManagerSnapshot(projectSession.id);
      }
    }

    if (requestedTaskWorkMode && projectSession && projectWorkItem) {
      store.applyProjectManagerAction({
        type: 'update-work-item',
        workItemId: projectWorkItem.id,
        patch: { taskWorkMode: requestedTaskWorkMode },
      }, projectSession.id);
    }

    const ordinaryDecisionPlan = proposedOrdinaryPlan
      || (currentOrdinaryProtocol
        ? lane.decisions?.find((decision) => decision.ordinaryPlan)?.ordinaryPlan
        : undefined);
    const userDecisionCurrentState = outcome === 'needs-human'
      ? [contextSummary, diffSummary, executionError, evidence, testResult, lane.currentTask]
          .map((value) => String(value || '').trim())
          .find(Boolean)
          ?.slice(0, 4_000)
          || '当前任务已暂停在用户决策边界，尚无额外进展摘要'
      : undefined;
    const autoDecisionsUsed = nextSupervisorDecisionCount(lane.autoDecisionsUsed, permissionResponse);
    const limitReached = !autonomous && !permissionResponse && reachesAutoDecisionLimit(lane, session.maxAutoDecisions);
    appendSupervisorRecord(session, lane, 'supervisor.decision', {
      outcome,
      reason,
      next,
      proposalKind,
      impact,
      alternatives,
      ...(userDecisionCurrentState ? { currentState: userDecisionCurrentState } : {}),
      ...(ordinaryRecommendedOption ? { recommendedOption: ordinaryRecommendedOption } : {}),
      escalationBoundary,
      ...(ordinaryDecisionPlan ? { ordinaryPlan: ordinaryDecisionPlan } : {}),
      ...(ordinaryTaskDispatch ? { taskDispatch: ordinaryTaskDispatch } : {}),
      ...(projectTaskBatch ? { projectTaskBatch } : {}),
      ...(requestedTaskWorkMode ? { taskWorkMode: requestedTaskWorkMode } : {}),
      ...(ordinaryContextHealthReported ? {
        contextHealth: rawContextHealth,
        contextSymptoms,
        contextSignal,
      } : {}),
      ...(progressHealthReported ? {
        progressHealth: rawProgressHealth,
        goalVortex: proposedGoalVortex,
        goalVortexReplanRequired,
      } : {}),
      ...(completionResult ? { completion: completionResult } : {}),
      ...(outcome === 'complete' ? {
        completionFile,
      } : {}),
      proactiveProjectFollowUp,
      requiresHuman: limitReached && outcome !== 'needs-human',
    });
    store.appendSupervisorLog(lane.id, '监督裁决', `${outcome}${reason ? `：${reason}` : ''}`);
    store.updateLane(lane.id, {
      autoDecisionsUsed,
      unreportedIdleRecoveryAttempts: 0,
      ...(requestedTaskWorkMode ? {
        config: {
          ...effectiveSupervisorLaneConfig(lane),
          taskWorkMode: requestedTaskWorkMode,
          supervisorMayApproveThreads: true,
        },
      } : {}),
      decisions: [
        {
          ts: decisionAt,
          task: lane.currentTask || '（任务未上报）',
          outcome,
          ...(proposalKind ? { proposalKind: proposalKind as SupervisorDecision['proposalKind'] } : {}),
          reason,
          next,
          ...(ordinaryDecisionPlan ? { ordinaryPlan: ordinaryDecisionPlan } : {}),
          ...(ordinaryTaskDispatch ? { taskDispatch: ordinaryTaskDispatch } : {}),
          ...(requestedTaskWorkMode ? { taskWorkMode: requestedTaskWorkMode } : {}),
          ...(ordinaryContextHealthReported ? {
            contextHealth: rawContextHealth as 'healthy' | 'degraded',
            contextSymptoms,
            contextSignal,
          } : {}),
          ...(progressHealthReported ? {
            progressHealth: rawProgressHealth as 'healthy' | 'stalled',
            goalVortex: proposedGoalVortex,
          } : {}),
          ...(completionResult ? { completion: completionResult } : {}),
        },
        ...(lane.decisions || []),
      ].slice(0, 100),
    });
    if (proposedGoalVortex) {
      const recordType = goalVortexReplanRequired
        ? 'supervisor.goal-vortex.replan-required'
        : 'supervisor.goal-vortex.detected';
      appendSupervisorRecord(session, lane, recordType, {
        occurrence: proposedGoalVortex.occurrences,
        kind: proposedGoalVortex.kind,
        signal: proposedGoalVortex.signal,
        wastedEffort: proposedGoalVortex.wastedEffort,
        missingEvidence: proposedGoalVortex.missingEvidence,
        decisiveNextStep: proposedGoalVortex.decisiveNextStep,
        authorizationBoundary: proposedGoalVortex.authorizationBoundary,
        experimentConditions: proposedGoalVortex.experimentConditions,
        correctionTask: proposedGoalVortex.correctionTask,
        forcedReplan: goalVortexReplanRequired,
        reviewId: proposedGoalVortex.reviewId,
        workerTurnId: proposedGoalVortex.workerTurnId,
      });
      store.appendSupervisorLog(
        lane.id,
        goalVortexReplanRequired ? '目标旋涡：强制重规划' : '目标旋涡：立即纠偏',
        [
          `类型=${proposedGoalVortex.kind}`,
          `现象=${proposedGoalVortex.signal}`,
          `空耗=${proposedGoalVortex.wastedEffort}`,
          `缺失证据=${proposedGoalVortex.missingEvidence}`,
          `推进动作=${proposedGoalVortex.decisiveNextStep}`,
          `授权边界=${proposedGoalVortex.authorizationBoundary}`,
          proposedGoalVortex.experimentConditions.length > 0
            ? `实验条件=${proposedGoalVortex.experimentConditions.join('；')}`
            : '',
        ].filter(Boolean).join('｜'),
      );
    }

    if (limitReached && outcome !== 'needs-human') {
      store.updateLane(lane.id, {
        autoDecisionLimitReached: true,
        awaitingReview: true,
        ...(outcome === 'complete' ? { awaitingStopCheck: true } : {}),
      });
      if (!lane.projectManagerProjectId) {
        const text = `已达到 ${normalizedMaxAutoDecisions(session.maxAutoDecisions)} 次自动判断上限；请人工审阅 ${lane.label} 后再继续。`;
        const workspaceId = lane.workspaceId || store.activeWorkspaceId;
        const notificationSurfaceId = dedicatedSupervisorSurfaceId(lane) || lane.surfaceId;
        if (workspaceId) store.addNotification({
          surfaceId: notificationSurfaceId,
          workspaceId,
          title: 'AI 监督需要你的处理',
          text,
          ...notificationMetadata({
            owner: 'supervisor',
            entityId: lane.id,
            kind: 'auto-decision-limit',
            laneId: lane.id,
            sourceLabel: lane.label,
          }),
        });
        fireDesktopNotification({ surfaceId: notificationSurfaceId, title: 'AI 监督', text });
      }
      return { ok: true, outcome, requiresHuman: true };
    }

    if (outcome === 'complete') {
      if (completionEvidenceToken) completionEvidenceGrants.delete(completionEvidenceToken);
      recordProjectExecution(true);
      if (!projectSession || !projectWorkItem) {
        store.updateLane(lane.id, { awaitingDirectionAfterWaitingResume: false });
        store.confirmStopCondition(lane.id);
        announceSupervisorWaitingForDirection(lane, reason || '监督 AI 已确认达到停止条件');
      }
      if (projectSession && projectWorkItem) {
        announceSupervisorWaitingForDirection(lane, reason || '监督 AI 已确认达到停止条件', {
          handoffKind: 'stage-complete',
          evidence,
          contextSummary: [
            contextSummary || reason,
            completionResult?.criteria?.length
              ? `阶段核对：${completionResult.criteria.map((criterion) => `${criterion.criterion}=${criterion.result}`).join('；')}`
              : '',
          ].filter(Boolean).join('\n'),
        });
        const taskTerminal = remoteSurfaceTerminalLocation(lane.surfaceId);
        if (taskTerminal) {
          store.updateSurface(taskTerminal.workspaceId, taskTerminal.paneId, taskTerminal.surfaceId, {
            projectManagerWorkItemId: undefined,
            customTitle: '任务 AI',
          });
        }
        store.updateLane(lane.id, {
          projectWorkItemId: undefined,
          projectAssignmentVersion: undefined,
          projectAssignmentConfirmedVersion: undefined,
          currentTask: '',
          awaitingReview: false,
          awaitingDirectionAfterWaitingResume: false,
          stopConfirmed: false,
          controlState: 'active',
          config: {
            ...effectiveSupervisorLaneConfig(lane),
            taskGoal: projectSession.goal,
            taskDescription: '当前没有活动工作项，等待项目 AI 交付下一项成果任务。',
            waitForNextDirection: true,
          },
        });
        queueProjectManagerDelivery([
          '[工作项已完成｜请继续总计划]',
          `工作项：${projectWorkItem.id} · ${projectWorkItem.title}`,
          `证据：${evidence || completionResult?.summary || reason}`,
          `读取 project status 后，选择下一个依赖已满足的工作项并执行 wmux project dispatch --project ${projectSession.id} --task <工作项ID> 交给专属监督；没有剩余工作时核对项目完成条件。`,
        ].join('\n'), projectSession.id, { priority: true });
        saveProjectManagerSnapshot(projectSession.id);
      }
      return {
        ok: true,
        outcome,
        ...(projectSession ? { waiting: true, handoff: true } : {}),
      };
    }

    const failDelivery = (
      kind: 'next' | 'permission',
      label: string,
      error: string,
      delivery?: SupervisorDeliveryObservation,
    ) => {
      recordProjectExecution(false);
      if (projectSession) saveProjectManagerSnapshot(projectSession.id);
      store.updateLane(lane.id, {
        awaitingReview: true,
        autoDecisionsUsed: lane.autoDecisionsUsed ?? 0,
        decisions: lane.decisions || [],
      });
      appendSupervisorRecord(session, lane, 'supervisor.delivery.failed', {
        kind,
        error,
        ...(delivery ? { delivery } : {}),
      });
      store.appendSupervisorLog(lane.id, `${label}失败`, error);
      return { ok: false, error: `${label}失败：${error}`, ...(delivery ? { delivery } : {}) };
    };

    const deferTaskInputBusyDelivery = (error: unknown) => {
      const detail = String((error as Error)?.message || error);
      store.updateLane(lane.id, {
        awaitingReview: true,
        autoDecisionsUsed: lane.autoDecisionsUsed ?? 0,
        decisions: lane.decisions || [],
      });
      const currentLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane;
      appendSupervisorRecord(useStore.getState().supervisor, currentLane, 'supervisor.delivery.deferred', {
        kind: 'next',
        reason: 'task-terminal-input-busy',
        error: detail,
      });
      store.appendSupervisorLog(lane.id, '下一步发送已延期', detail);
      scheduleTaskInputRecoveryWatch(currentLane);
      return {
        ok: true,
        outcome,
        deliveryDeferred: true,
        message: detail,
      };
    };

    const taskShellFailure = next || permissionResponse
      ? nestedAgentShellFailureDetail(lane.surfaceId)
      : null;
    if (taskShellFailure) {
      markTerminalRuntimeFailed(lane.surfaceId, taskShellFailure);
      if (projectSession) {
        (window as any).__wmux_queueProjectManagerRuntimeRecovery?.({
          projectId: projectSession.id,
          workItemId: lane.projectWorkItemId,
          laneId: lane.id,
          surfaceId: lane.surfaceId,
          role: 'task',
          detail: taskShellFailure,
        });
      } else {
        store.updateLane(lane.id, {
          supervisorProblem: { kind: 'runtime-failed', detail: taskShellFailure, detectedAt: Date.now() },
        });
        store.pauseSupervisorLane(lane.id, taskShellFailure);
      }
      return failDelivery(
        permissionResponse ? 'permission' : 'next',
        permissionResponse ? '权限响应' : '下一步发送',
        taskShellFailure,
      );
    }

    if (permissionResponse) {
      const beforeScreen = terminalScreenTail(lane.surfaceId);
      const expectedBlockedVersion = agentState!.blockedVersion;
      const expectedBlockedRequestId = agentState!.blockedRequestId || '';
      const expectedRequirementsVersion = projectSession
        ? projectRequirementsVersion(projectSession)
        : undefined;
      const validatePermissionBeforeSubmit = (): string | null => {
        const freshStore = useStore.getState();
        const freshSupervisor = freshStore.supervisor;
        const freshLane = freshSupervisor.lanes.find((candidate) => candidate.id === lane.id);
        if (!freshSupervisor.active || !freshLane || supervisorLaneControlState(freshLane) !== 'active') {
          return '权限响应提交前通道已暂停、停止或失效，已取消自动确认';
        }
        if (
          freshLane.surfaceId !== lane.surfaceId
          || !isSupervisorDecisionAuthorised(freshLane, supervisorSurfaceId)
        ) {
          return '权限响应提交前任务终端或专属监督绑定已变化，已取消自动确认';
        }
        if (!effectiveSupervisorAutonomyPermissions(freshSupervisor, freshLane).includes('permission-confirm')) {
          return '权限响应提交前 permission-confirm 授权已撤销，已取消自动确认';
        }
        const freshAgentState = ((w.__wmux_getAgentStates?.() || {})[lane.surfaceId] || undefined) as SupervisorAgentStateView | undefined;
        if (
          !isPermissionBlockedState(freshAgentState)
          || freshAgentState.blockedVersion !== expectedBlockedVersion
          || String(freshAgentState.blockedRequestId || '') !== expectedBlockedRequestId
        ) {
          return '权限响应提交前阻塞轮次已变化或已经解除，已取消自动确认';
        }
        const freshEvidence = terminalScreenTail(lane.surfaceId);
        if (!permissionCommandMatchesEvidence(permissionCommand, freshEvidence)) {
          return '权限响应提交前终端提示已变化，具体命令不再匹配，已取消自动确认';
        }
        const freshForbiddenActions = effectiveSupervisorForbiddenActions(freshSupervisor, freshLane);
        const freshPermissionEvidence = [freshAgentState.blockedReason || '', freshEvidence].filter(Boolean).join('\n');
        const freshRisk = autonomousActionBlockReason(freshPermissionEvidence)
          || configuredActionBlockReason(freshPermissionEvidence, freshForbiddenActions)
          || workScopeBlockReason(
            freshPermissionEvidence,
            effectiveSupervisorWorkScope(freshSupervisor, freshLane),
            freshLane.scopeRoot || freshLane.projectDir,
          );
        if (freshRisk) return `权限响应提交前检测到新的安全或范围风险：${freshRisk}`;
        if (projectSession && projectWorkItem) {
          const freshProject = freshStore.projectManagers.find((candidate) => candidate.id === projectSession.id);
          const freshWorkItem = freshProject?.workItems.find((candidate) => candidate.id === projectWorkItem.id);
          if (
            !freshProject
            || freshProject.status !== 'active'
            || !freshWorkItem
            || freshLane.projectManagerProjectId !== freshProject.id
            || freshLane.projectWorkItemId !== freshWorkItem.id
            || !projectSupervisorLaneOwnsWorkItem(freshLane, freshWorkItem)
            || projectRequirementsVersion(freshProject) !== expectedRequirementsVersion
            || projectAcceptedRequirementsVersion(freshProject) !== expectedRequirementsVersion
          ) {
            return '权限响应提交前项目状态、需求版本或工作项绑定已变化，已取消自动确认';
          }
          const authorizationError = projectPermissionAuthorizationError(freshWorkItem.contract, permissionCommand);
          const contractError = projectContractViolation(freshWorkItem.contract, {
            instruction: permissionCommand,
            command: permissionCommand,
            testCommand: isProjectTargetedTestCommand(permissionCommand) ? permissionCommand : undefined,
          });
          if (authorizationError || contractError) {
            return `权限响应提交前任务合同已不再授权该命令：${authorizationError || contractError}`;
          }
        }
        return null;
      };
      const finishPermission = (delivery?: SupervisorDeliveryObservation) => {
        appendSupervisorRecord(session, lane, 'supervisor.permission-approved', {
          command: permissionCommand,
          response: permissionResponse,
        });
        store.appendSupervisorLog(lane.id, 'AI 自动授权', permissionCommand);
        store.updateLane(lane.id, {
          awaitingReview: false,
          activeReviewId: undefined,
          reviewWorkerTurnId: undefined,
          reviewOpenedAt: undefined,
          reviewDeliveryConfirmedAt: undefined,
          reviewWatchdogState: undefined,
          ...(lane.supervisorProblem?.kind === 'unreported-decision' ? { supervisorProblem: undefined } : {}),
          lastBlockedResponseVersion: agentState!.blockedVersion,
          lastBlockedResponseId: agentState!.blockedRequestId || undefined,
          permissionConfirmations: [
            ...(lane.permissionConfirmations || []),
            {
              ts: Date.now(),
              commandSignature: permissionCommandSignature(permissionCommand),
              ...(agentState!.blockedRequestId ? { blockedRequestId: agentState!.blockedRequestId } : {}),
              ...(projectSession ? { requirementsVersion: projectRequirementsVersion(projectSession) } : {}),
            },
          ].slice(-20),
        });
        return { ok: true, outcome, autoAuthorized: true, ...(delivery ? { delivery } : {}) };
      };
      supervisorDeliveriesInFlight.add(lane.id);
      try {
        const pendingDelivery = sendPermissionResponseReliably(
          lane.surfaceId,
          permissionResponse,
          supervisorLaneInputIsolationScope(lane),
          () => terminalScreenTail(lane.surfaceId),
          validatePermissionBeforeSubmit,
        );
        if (pendingDelivery) {
          return pendingDelivery
            .then((receipt) => observeSupervisorDelivery(
              lane.surfaceId,
              receipt.beforeSubmitScreen ?? beforeScreen,
              agentState,
            ))
            .then((delivery) => delivery.confirmed
              ? finishPermission(delivery)
              : failDelivery(
                'permission',
                '权限响应发送',
                `PTY 已接受输入，但未观察到新的任务状态（当前 ${delivery.agentState}${delivery.screenChanged ? '，仅检测到屏幕变化' : ''}）；请核验权限提示后再重试`,
                delivery,
              ))
            .catch((err) => failDelivery(
              'permission',
              '权限响应发送',
              String((err as Error)?.message || err),
            ))
            .finally(() => supervisorDeliveriesInFlight.delete(lane.id));
        }
        const result = finishPermission();
        supervisorDeliveriesInFlight.delete(lane.id);
        return result;
      } catch (err) {
        supervisorDeliveriesInFlight.delete(lane.id);
        const error = String((err as Error)?.message || err);
        return failDelivery('permission', '权限响应发送', error);
      }
    }

    if (outcome === 'needs-human') {
      recordProjectExecution(true);
      if (projectSession && projectWorkItem && escalationBoundary === 'budget-exhausted') {
        const budget = projectWorkItem.contract.budget;
        const hardTaskBudgetReached = projectWorkItem.attempts >= budget.maxTaskRetries
          || taskRuntimeMinutes >= budget.maxAggregateWorkerMinutes;
        const exhaustionSummary = projectWorkItemBudgetExhaustionSummary(projectWorkItem);
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: {
            status: 'waiting-decision',
            latestBlocker: exhaustionSummary,
          },
        }, projectSession.id);
        store.updateLane(lane.id, { awaitingReview: false, autoDecisionLimitReached: false });
        queueProjectSupervisorTransition({
          sessionId: projectSession.id,
          laneId: lane.id,
          workItemId: projectWorkItem.id,
          kind: 'decision-required',
          eventType: 'supervisor.hard-execution-budget',
          summary: exhaustionSummary,
          evidence,
          contextSummary: contextSummary || diffSummary || executionError,
          instruction: [
                '真实任务失败重试或任务 AI 聚合执行时间达到硬护栏；控制层不会自动创建预算后继，也不会重置失败与资源审计。',
                '项目 AI 应基于证据改变假设、拆分出语义上不同的可验收工作项，或暂缓当前阻塞分支并推进独立工作；只有外部条件、用户独有信息或硬件安全状态未知时才询问用户。',
                '创建新工作项并不等于创建新终端；若原监督和任务终端健康，仍应优先原地复用。',
              ].join('\n'),
        });
        saveProjectManagerSnapshot(projectSession.id);
        return {
          ok: true,
          outcome,
          budgetExhausted: true,
          successorCreated: false,
          projectDecisionRequired: true,
          workItemId: projectWorkItem.id,
          laneId: lane.id,
          taskSurfaceId: lane.surfaceId,
          supervisorSurfaceId: dedicatedSupervisorSurfaceId(lane),
          hardTaskBudgetReached,
          message: '硬执行护栏已交给项目 AI 决策；控制层没有自动创建后继或新终端',
        };
      }
      if (projectSession && projectWorkItem && isProjectTaskInputDraftBlocker(reason, impact, next)) {
        const question = escalateProjectTaskInputDraft(
          projectSession.id,
          lane.id,
          projectWorkItem.id,
          reason || impact || '监督 AI 确认任务终端输入框存在未提交内容',
        );
        if (question) {
          return {
            ok: true,
            outcome,
            userInterventionRequired: true,
            question,
            message: '任务终端草稿已升级为持久用户处理项；控制层没有提交、清空或覆盖原输入。',
          };
        }
      }
      if (proposalKind === 'direction-needed'
        && lane.awaitingDirectionAfterWaitingResume
        && laneConfig.waitForNextDirection) {
        store.updateLane(lane.id, {
          controlState: 'waiting',
          awaitingStopCheck: false,
          stopConfirmed: true,
          awaitingReview: false,
          awaitingDirectionAfterWaitingResume: false,
          autoDecisionLimitReached: false,
          activeReviewId: undefined,
          reviewWorkerTurnId: undefined,
          reviewOpenedAt: undefined,
          reviewDeliveryConfirmedAt: undefined,
          reviewWatchdogState: undefined,
        });
        const waitingReason = reason || '用户提供的新方向信息仍不足，等待补充';
        store.appendSupervisorLog(lane.id, '新方向信息不足，返回待续', waitingReason);
        announceSupervisorWaitingForDirection(lane, waitingReason, { handoffKind: 'direction-needed' });
        return { ok: true, outcome, waiting: true };
      }
      if (projectSession && projectWorkItem) {
        store.updateLane(lane.id, {
          awaitingReview: false,
          activeReviewId: undefined,
          reviewWorkerTurnId: undefined,
          reviewOpenedAt: undefined,
          reviewDeliveryConfirmedAt: undefined,
          reviewWatchdogState: undefined,
          autoDecisionLimitReached: false,
        });
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: {
            status: 'waiting-decision',
            latestBlocker: reason || '专属监督提交项目状态通知',
            ...(evidence ? { latestEvidence: evidence } : {}),
            ...(contextSummary || diffSummary || impact
              ? { latestContextSummary: contextSummary || diffSummary || impact }
              : {}),
          },
        }, projectSession.id);
        const notice = queueProjectSupervisorNotice({
          session: projectSession,
          lane,
          workItem: projectWorkItem,
          boundary: escalationBoundary,
          reason: reason || '专属监督提交项目状态通知',
          impact,
          alternatives: next || alternatives,
          evidence,
          contextSummary: contextSummary || diffSummary || executionError,
        });
        saveProjectManagerSnapshot(projectSession.id);
        return {
          ok: true,
          outcome,
          projectNotification: true,
          transitionId: notice.transition?.id,
          duplicate: notice.duplicate,
          message: notice.duplicate
            ? '相同项目状态通知已经存在；控制层未创建新的待决请求或重复投递'
            : '已创建项目模式专用状态通知；未创建普通监督 pendingApproval，也未直接询问用户',
        };
      }
      if (isProjectManagedSupervisorLane(lane)) {
        store.updateLane(lane.id, {
          awaitingReview: false,
          activeReviewId: undefined,
          reviewWorkerTurnId: undefined,
          reviewOpenedAt: undefined,
          reviewDeliveryConfirmedAt: undefined,
          reviewWatchdogState: undefined,
          autoDecisionLimitReached: false,
        });
        if (projectSession) {
          const transition = queueProjectSupervisorTransition({
            sessionId: projectSession.id,
            laneId: lane.id,
            workItemId: lane.projectWorkItemId,
            kind: 'project-action-required',
            eventType: 'supervisor.project-binding-recovery',
            summary: reason || '监督 AI 无法确认任务运行时或当前工作项绑定',
            evidence,
            contextSummary: [contextSummary || diffSummary || executionError, impact, next || alternatives]
              .filter(Boolean).join('\n'),
            instruction: [
              '这是项目内部运行时或绑定恢复请求，由项目 AI 处理，不是普通用户审批。',
              '先读取项目状态并只读核对任务终端实时屏幕；Hook 状态 unknown 不能单独证明任务 Agent 缺失。',
              '恢复或重建任务/监督绑定后继续编排。只有确属用户控制的外部条件、用户独有信息或高风险授权时，项目 AI 才能使用 project ask。',
            ].join('\n'),
          });
          saveProjectManagerSnapshot(projectSession.id);
          return {
            ok: true,
            outcome,
            projectNotification: true,
            transitionId: transition?.id,
            message: '项目监督请求已交给项目 AI；未创建普通监督 pendingApproval，也未直接询问用户',
          };
        }
        const projectId = lane.projectManagerProjectId;
        const recoveryQueued = projectId ? (window as any).__wmux_queueProjectManagerRuntimeRecovery?.({
          projectId,
          workItemId: lane.projectWorkItemId,
          laneId: lane.id,
          surfaceId: lane.surfaceId,
          role: 'task',
          detail: reason || '项目监督无法恢复项目或工作项绑定',
        }) : false;
        return {
          ok: false,
          projectRuntimeRecovery: !!recoveryQueued,
          error: recoveryQueued
            ? '项目状态绑定暂时缺失；已交给项目运行时恢复器，未向用户创建待决项'
            : '项目状态绑定缺失且无法启动内部恢复；已禁止降级为普通用户审批',
        };
      }
      store.updateLane(lane.id, {
        awaitingReview: true,
        activeReviewId: undefined,
        reviewWorkerTurnId: undefined,
        reviewOpenedAt: undefined,
        reviewDeliveryConfirmedAt: undefined,
        reviewWatchdogState: undefined,
        ...(limitReached ? { autoDecisionLimitReached: true } : {}),
      });
      const kind = proposalKinds.has(proposalKind)
        ? proposalKind as 'route-change' | 'important' | 'clarification'
        : 'important';
      const approval = {
        laneId: lane.id,
        surfaceId: lane.surfaceId,
        laneLabel: lane.label,
        text: next,
        source: kind === 'route-change'
          ? 'supervisor-route' as const
          : 'supervisor-important' as const,
        proposalKind: kind,
        reason: reason || `${lane.label} 需要人工决策`,
        impact,
        alternatives,
        task: lane.currentTask || '（任务未上报）',
        currentState: userDecisionCurrentState,
        recommendedOption: ordinaryRecommendedOption,
      };
      store.enqueueApproval(approval);
      const pending = useStore.getState().supervisor.pendingApprovals.find((item) => item.laneId === lane.id);
      if (pending) {
        appendSupervisorRecord(useStore.getState().supervisor, lane, 'supervisor.approval.requested', {
          approvalId: pending.id,
          taskGoal: publicDecisionTaskGoal(useStore.getState().supervisor, lane),
          reason: approval.reason,
          impact: approval.impact,
          alternatives: approval.alternatives,
          proposalKind: approval.proposalKind,
        });
      }
      const proposalLabel = kind === 'route-change'
        ? '路线变更'
        : kind === 'clarification'
            ? '需求对齐'
            : '重要建议';
      const text = `${proposalLabel}待你决定：${reason || lane.label}`;
      if (!lane.projectManagerProjectId) {
        const workspaceId = lane.workspaceId || store.activeWorkspaceId;
        const notificationSurfaceId = dedicatedSupervisorSurfaceId(lane) || lane.surfaceId;
        if (workspaceId) {
          store.addNotification({
            surfaceId: notificationSurfaceId,
            workspaceId,
            title: 'AI 监督需要你的决定',
            text,
            ...notificationMetadata({
              owner: 'supervisor',
              entityId: lane.id,
              kind: `proposal:${proposalKind || 'important'}`,
              laneId: lane.id,
              sourceLabel: lane.label,
            }),
          });
        }
        fireDesktopNotification({ surfaceId: notificationSurfaceId, title: 'AI 监督', text });
      }
      return { ok: true, outcome };
    }

    const finishDecision = (delivery?: SupervisorDeliveryObservation) => {
      if (projectSession && projectWorkItem && (outcome === 'continue' || outcome === 'rework')) {
        store.applyProjectManagerAction({
          type: 'update-work-item',
          workItemId: projectWorkItem.id,
          patch: {
            status: 'running',
            startedAt: projectWorkItem.startedAt || Date.now(),
            ...(!executionError ? { latestBlocker: undefined } : {}),
          },
        }, projectSession.id);
        const updatedProject = useStore.getState().projectManagers
          .find((candidate) => candidate.id === projectSession.id);
        if (updatedProject?.repositoryBootstrapPending && projectTaskBatch && next) {
          replaceProjectManagerSession({
            ...updatedProject,
            repositoryBootstrapPending: false,
            updatedAt: Date.now(),
          });
        }
        saveProjectManagerSnapshot(projectSession.id);
      }
      recordProjectExecution(true);
      if (projectSession) saveProjectManagerSnapshot(projectSession.id);
      store.updateLane(lane.id, {
        awaitingReview: false,
        activeReviewId: undefined,
        reviewWorkerTurnId: undefined,
        reviewOpenedAt: undefined,
        reviewDeliveryConfirmedAt: undefined,
        reviewWatchdogState: undefined,
        ...(lane.supervisorProblem?.kind === 'unreported-decision' ? { supervisorProblem: undefined } : {}),
        awaitingDirectionAfterWaitingResume: false,
        ...(next ? { currentTask: (projectTaskBatch?.outcome || ordinaryTaskDispatch?.outcome || next).slice(0, 8_000) } : {}),
        ...(next && projectSession && projectWorkItem ? {
          projectTaskContractPending: false,
          ...(projectTaskBatch ? { projectTaskBatch } : {}),
          permissionConfirmations: [],
        } : {}),
        ...(isQuestionBlockedState(agentState) ? {
          lastBlockedResponseVersion: agentState.blockedVersion,
          lastBlockedResponseId: agentState.blockedRequestId || undefined,
        } : {}),
        ...(ordinaryContextHealthReported ? {
          ordinaryContextHealth: ordinaryContextResetRequired
            || rawContextHealth === 'healthy'
            ? undefined
            : proposedOrdinaryContextHealth,
        } : {}),
        ...(ordinaryContextResetRequired ? {
          ordinaryContextReset: undefined,
          ordinaryContextResetCount: (lane.ordinaryContextResetCount || 0) + 1,
          ordinaryContextResetPlanRevision: effectiveSupervisorLaneConfig(lane).planRevision || 1,
        } : {}),
        ...(progressHealthReported ? {
          goalVortex: rawProgressHealth === 'healthy' ? undefined : proposedGoalVortex,
        } : {}),
      });
      if (next) {
        const boundLane = useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane;
        appendSupervisorRecord(useStore.getState().supervisor, boundLane, 'worker.task.bound', {
          task: (projectTaskBatch?.outcome || ordinaryTaskDispatch?.outcome || next).slice(0, 8_000),
          workerTurnId: boundLane.workerTurnId,
          source: delivery?.confirmed ? 'confirmed-supervisor-delivery' : 'supervisor-delivery',
        });
      }
      return {
        ok: true,
        outcome,
        ...(nextFile ? { retainNextFile: true } : {}),
        ...(delivery ? { delivery } : {}),
      };
    };

    if (next && ordinaryContextResetRequired && ordinaryTaskDispatch && proposedOrdinaryContextHealth) {
      if (!session.submitEnter) {
        return { ok: false, error: '自动上下文清空要求任务投递启用提交键；当前会话只能上报用户处理' };
      }
      const currentTaskAgentState = ((window as any).__wmux_getAgentStates?.() || {})[lane.surfaceId];
      if (Number(currentTaskAgentState?.runDepth || 0) > 0) {
        return { ok: false, error: '任务 AI 主线程或内部子线程仍在运行；多线程模式必须等全部线程结束后才能发送 /new' };
      }
      const taskActivity = remoteTerminalActivity(lane.surfaceId, true);
      const taskBuffer = surfaceTerminalRegistry.get(lane.surfaceId)?.buffer.active;
      if (taskActivity.activityState !== 'idle' || (taskBuffer && hasPendingTerminalInput(taskBuffer))) {
        return { ok: false, error: '任务 AI 仍在工作或输入框存在待提交内容；只能在空闲检查点清空上下文' };
      }
      const beforeClearScreen = terminalScreenTail(lane.surfaceId, 80);
      const taskAgent = terminalConversationAgent([
        lane.label,
        store.agentMeta.get(lane.surfaceId)?.label || '',
      ].join(' '), beforeClearScreen);
      const clearCommand = ordinaryContextClearCommand(taskAgent);
      if (!clearCommand) {
        return { ok: false, error: '无法确认任务终端是支持自动 /new 的 Codex、Kimi、Grok、Pi 或 OpenCode；请使用 needs-human 交给用户' };
      }
      const resetId = `ordinary-context-reset-${uuid()}`;
      const resetStartedAt = Date.now();
      const recoveryTask = buildOrdinaryContextRecoveryTask({
        config: effectiveSupervisorLaneConfig(lane),
        plan: currentOrdinaryPlan,
        dispatch: ordinaryTaskDispatch,
      });
      const failOrdinaryContextReset = (error: string, stage: 'clearing' | 'recovering') => {
        const currentStore = useStore.getState();
        const currentLane = currentStore.supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane;
        currentStore.updateLane(lane.id, {
          awaitingReview: true,
          ordinaryContextHealth: proposedOrdinaryContextHealth,
          ordinaryContextReset: {
            id: resetId,
            status: 'failed',
            fingerprint: proposedOrdinaryContextHealth.fingerprint,
            startedAt: resetStartedAt,
            error,
          },
          decisions: lane.decisions || [],
        });
        appendSupervisorRecord(currentStore.supervisor, currentLane, 'supervisor.context-reset.failed', {
          stage,
          error,
          symptoms: proposedOrdinaryContextHealth.symptoms,
          signal: proposedOrdinaryContextHealth.signal,
        });
        currentStore.appendSupervisorLog(lane.id, '任务 AI 上下文清空失败', error);
        const workspaceId = lane.workspaceId || currentStore.activeWorkspaceId;
        const notificationSurfaceId = dedicatedSupervisorSurfaceId(lane) || lane.surfaceId;
        if (workspaceId) currentStore.addNotification({
          surfaceId: notificationSurfaceId,
          workspaceId,
          title: 'AI 监督需要你的处理',
          text: `任务 AI 上下文${stage === 'clearing' ? '清空' : '恢复'}失败：${error}`,
          ...notificationMetadata({
            owner: 'supervisor',
            entityId: lane.id,
            kind: 'context-reset-failed',
            laneId: lane.id,
            sourceLabel: lane.label,
          }),
        });
        fireDesktopNotification({
          surfaceId: notificationSurfaceId,
          title: 'AI 监督需要你的处理',
          text: `任务 AI 上下文${stage === 'clearing' ? '清空' : '恢复'}失败`,
        });
        return { ok: false, error, contextResetFailed: true, requiresHuman: true };
      };

      store.updateLane(lane.id, {
        ordinaryContextHealth: proposedOrdinaryContextHealth,
        ordinaryContextReset: {
          id: resetId,
          status: 'clearing',
          fingerprint: proposedOrdinaryContextHealth.fingerprint,
          startedAt: resetStartedAt,
        },
      });
      const contextResetPreSubmitError = (
        expectedStatus: 'clearing' | 'recovering',
        allowAgentTransition = false,
      ): string | null => {
        const currentStore = useStore.getState();
        const currentSession = currentStore.supervisor;
        const currentLane = currentSession.lanes.find((candidate) => candidate.id === lane.id);
        if (!currentSession.active || !currentLane || supervisorLaneControlState(currentLane) !== 'active') {
          return '上下文清空提交前监督通道已暂停、停止或失效';
        }
        if (!isSupervisorDecisionAuthorised(currentLane, supervisorSurfaceId)
          || currentLane.surfaceId !== lane.surfaceId
          || currentLane.activeReviewId !== lane.activeReviewId
          || currentLane.workerTurnId !== lane.workerTurnId) {
          return '上下文清空提交前任务绑定或复核轮次已经变化';
        }
        if (currentLane.ordinaryContextReset?.id !== resetId
          || currentLane.ordinaryContextReset.status !== expectedStatus) {
          return '上下文清空状态已经被其他处理更新';
        }
        if ((effectiveSupervisorLaneConfig(currentLane).planRevision || 1)
          !== ordinaryTaskDispatch.sourceRevision) {
          return '用户规划版本已变化，禁止提交旧上下文恢复任务';
        }
        if (hasPendingTaskUserSubmit(currentLane.id, currentSession.sessionId)
          || currentLane.userDirectTaskTurnId === currentLane.workerTurnId
          || currentLane.pendingSupervisorDeliveries?.some((delivery) => delivery.kind === 'user-task')) {
          return '用户输入已经先行生效，禁止自动清空或恢复旧任务上下文';
        }
        const currentAgentState = ((window as any).__wmux_getAgentStates?.() || {})[currentLane.surfaceId];
        if (!allowAgentTransition && String(currentAgentState?.state || '') === 'working') {
          return '任务 AI 已开始新的工作回合，禁止自动清空或恢复上下文';
        }
        return null;
      };
      appendSupervisorRecord(session, lane, 'supervisor.context-reset.requested', {
        command: clearCommand,
        symptoms: proposedOrdinaryContextHealth.symptoms,
        signal: proposedOrdinaryContextHealth.signal,
      });
      supervisorDeliveriesInFlight.add(lane.id);
      return (async () => {
        let recoveryAcknowledgement: ReturnType<typeof beginTaskPromptAcknowledgement> | undefined;
        try {
          await Promise.resolve(sendTaskToSurfaceReliably(
            lane.surfaceId,
            clearCommand,
            true,
            supervisorLaneInputIsolationScope(lane),
            undefined,
            undefined,
            () => contextResetPreSubmitError('clearing'),
          ));
          const clearReadyError = await waitForOrdinaryContextClearReady({
            surfaceId: lane.surfaceId,
            validate: () => contextResetPreSubmitError('clearing', true),
          });
          if (clearReadyError) {
            return failOrdinaryContextReset(`${clearReadyError}；已停止自动重试`, 'clearing');
          }
          const currentStore = useStore.getState();
          const currentLane = currentStore.supervisor.lanes.find((candidate) => candidate.id === lane.id)!;
          currentStore.updateLane(lane.id, {
            ordinaryContextReset: {
              id: resetId,
              status: 'recovering',
              fingerprint: proposedOrdinaryContextHealth.fingerprint,
              startedAt: resetStartedAt,
            },
          });
          await Promise.resolve(sendTaskToSurfaceReliably(
            lane.surfaceId,
            recoveryTask,
            true,
            supervisorLaneInputIsolationScope(lane),
            () => terminalScreenTail(lane.surfaceId),
            () => {
              recoveryAcknowledgement = beginTaskPromptAcknowledgement(
                lane.surfaceId,
                terminalScreenTail(lane.surfaceId),
              );
            },
            () => contextResetPreSubmitError('recovering'),
          ));
          const delivery = await recoveryAcknowledgement!.promise;
          if (!delivery.confirmed) {
            return failOrdinaryContextReset(
              `上下文已清空，但 15 秒内未收到恢复任务的 UserPromptSubmit 确认（当前 ${delivery.agentState}）`,
              'recovering',
            );
          }
          appendSupervisorRecord(useStore.getState().supervisor, currentLane, 'supervisor.context-reset.completed', {
            command: clearCommand,
            planRevision: ordinaryTaskDispatch.sourceRevision,
            symptoms: proposedOrdinaryContextHealth.symptoms,
          });
          useStore.getState().appendSupervisorLog(
            lane.id,
            '任务 AI 上下文已清空',
            '已在原终端发送最小可信恢复任务',
          );
          return finishDecision(delivery);
        } catch (error) {
          return failOrdinaryContextReset(
            String((error as Error)?.message || error),
            useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id)
              ?.ordinaryContextReset?.status === 'recovering' ? 'recovering' : 'clearing',
          );
        } finally {
          recoveryAcknowledgement?.cancel();
          supervisorDeliveriesInFlight.delete(lane.id);
        }
      })();
    }

    if (next) {
      const beforeScreen = terminalScreenTail(lane.surfaceId);
      const unanchoredDeliveryText = nextFile
        ? [
            '[wmux 临时任务文件]',
            `请先使用文件读取工具完整读取当前项目内的 ${nextFile}。`,
            '文件内容是本轮完整任务指令；读取完成后直接执行，不要将全文再次粘贴到终端。',
            `确认读取成功后，只删除这一个临时文件：${nextFile}。`,
          ].join('\n')
        : next;
      const deliveryText = unanchoredDeliveryText;
      let taskPromptAcknowledgement: ReturnType<typeof beginTaskPromptAcknowledgement> | undefined;
      supervisorDeliveriesInFlight.add(lane.id);
      try {
        const pendingDelivery = sendTaskToSurfaceReliably(
          lane.surfaceId,
          deliveryText,
          submitTaskEnter,
          supervisorLaneInputIsolationScope(lane),
          () => terminalScreenTail(lane.surfaceId),
          () => {
            taskPromptAcknowledgement = beginTaskPromptAcknowledgement(
              lane.surfaceId,
              terminalScreenTail(lane.surfaceId),
            );
          },
        );
        if (pendingDelivery) {
          return pendingDelivery
            .then(() => submitTaskEnter
              ? taskPromptAcknowledgement!.promise
              : {
                confirmed: true,
                agentState: String(((window as any).__wmux_getAgentStates?.() || {})[lane.surfaceId]?.state || 'unknown'),
                screenChanged: terminalScreenTail(lane.surfaceId) !== beforeScreen,
              })
            .then((delivery) => delivery.confirmed
              ? finishDecision(delivery)
              : failDelivery(
                'next',
                '下一步发送',
                `PTY 已接受输入，但 15 秒内未收到任务 AI 的 UserPromptSubmit 确认（当前 ${delivery.agentState}${delivery.screenChanged ? '，仅检测到屏幕变化' : ''}）；消息可能已经进入终端，请先运行 wmux agent-state --surface ${lane.surfaceId}，必要时再 read-screen，确认未投递后才能重试`,
                delivery,
              ))
            .catch((err) => isTaskTerminalInputBusyError(err)
              ? deferTaskInputBusyDelivery(err)
              : failDelivery(
                  'next',
                  '下一步发送',
                  String((err as Error)?.message || err),
                ))
            .finally(() => {
              taskPromptAcknowledgement?.cancel();
              supervisorDeliveriesInFlight.delete(lane.id);
            });
        }
      } catch (err) {
        taskPromptAcknowledgement?.cancel();
        supervisorDeliveriesInFlight.delete(lane.id);
        if (isTaskTerminalInputBusyError(err)) return deferTaskInputBusyDelivery(err);
        return failDelivery('next', '下一步发送', String((err as Error)?.message || err));
      }
      taskPromptAcknowledgement?.cancel();
      supervisorDeliveriesInFlight.delete(lane.id);
    }
    return finishDecision();
  };

  w.__wmux_supervisorDecide = (params: any) => {
    const initialStore = useStore.getState();
    const surfaceId = String(params?.surfaceId || '');
    const supervisorSurfaceId = String(params?.supervisorSurfaceId || '');
    const runtimeBoundary = projectSupervisorRuntimeDecisionBoundary(
      initialStore.supervisor.lanes,
      surfaceId,
      supervisorSurfaceId,
    );
    if (runtimeBoundary) return runtimeBoundary;
    const initialLane = initialStore.supervisor.lanes.find((candidate) => candidate.surfaceId === surfaceId);
    const initialProject = initialLane?.projectManagerProjectId
      ? initialStore.projectManagers.find((candidate) => candidate.id === initialLane.projectManagerProjectId)
      : undefined;
    const initialWorkItem = initialProject?.workItems.find((candidate) => (
      candidate.id === initialLane?.projectWorkItemId
    ));
    const authorized = initialLane
      && isSupervisorDecisionAuthorised(initialLane, supervisorSurfaceId);
    const validOutcome = ['continue', 'rework', 'complete', 'needs-human']
      .includes(String(params?.outcome || ''));
    if (!initialLane || !initialProject || !initialWorkItem || !authorized || !validOutcome) {
      return decideSupervisor(params);
    }

    const inputSignature = supervisorDecisionInputSignature(params);
    const previousGuard = initialLane.supervisorDecisionErrorGuard;
    const requirementsVersion = initialWorkItem.requirementsVersion
      ?? projectRequirementsVersion(initialProject);
    const authorizationVersion = initialWorkItem.authorizationVersion
      ?? projectAuthorizationVersion(initialProject);
    const contractSignature = supervisorDecisionTextSignature(JSON.stringify(
      stableSupervisorDecisionValue(initialWorkItem.contract),
    ));
    const sameScope = !!previousGuard
      && previousGuard.workItemId === initialWorkItem.id
      && previousGuard.requirementsVersion === requirementsVersion
      && previousGuard.authorizationVersion === authorizationVersion
      && previousGuard.contractSignature === contractSignature;
    if (previousGuard?.blocked && sameScope && previousGuard.inputSignature === inputSignature) {
      return {
        ok: false,
        protocolCorrectionPaused: true,
        error: '相同的监督裁决错误已连续出现两次，当前项目专属监督处于协议纠错暂停；请修改实质输入，或由项目 AI 更新方向/工作项版本后再继续',
      };
    }
    if (previousGuard?.blocked && supervisorLaneControlState(initialLane) === 'paused') {
      initialStore.resumeSupervisorLane(initialLane.id, '监督裁决输入或项目版本已变化，尝试解除协议纠错暂停');
      // Keep the old latch until the revised decision either succeeds or
      // proves that it now fails for a genuinely different reason.
      initialStore.updateLane(initialLane.id, { supervisorDecisionErrorGuard: previousGuard });
    }

    const finishGuardedDecision = (result: any) => {
      const currentStore = useStore.getState();
      const currentLane = currentStore.supervisor.lanes.find((candidate) => candidate.id === initialLane.id);
      if (!currentLane) return result;
      if (result?.awaitingOwnerDecisionDelivery === true) return result;
      if (!result || result.ok !== false || !String(result.error || '').trim()) {
        if (result?.ok === true
          && params?.outcome !== 'needs-human'
          && currentLane.supervisorDecisionErrorGuard) {
          currentStore.updateLane(currentLane.id, { supervisorDecisionErrorGuard: undefined });
        }
        return result;
      }

      const currentProject = currentLane.projectManagerProjectId
        ? currentStore.projectManagers.find((candidate) => candidate.id === currentLane.projectManagerProjectId)
        : undefined;
      const currentWorkItem = currentProject?.workItems.find((candidate) => (
        candidate.id === currentLane.projectWorkItemId
      ));
      if (!currentProject || !currentWorkItem) return result;
      const currentRequirementsVersion = currentWorkItem.requirementsVersion
        ?? projectRequirementsVersion(currentProject);
      const currentAuthorizationVersion = currentWorkItem.authorizationVersion
        ?? projectAuthorizationVersion(currentProject);
      const currentContractSignature = supervisorDecisionTextSignature(JSON.stringify(
        stableSupervisorDecisionValue(currentWorkItem.contract),
      ));
      const errorSignature = supervisorDecisionTextSignature(result.error);
      const blockerCategory = supervisorDecisionBlockerCategory(result.error);
      const previousMatches = !!previousGuard
        && previousGuard.blockerCategory === blockerCategory
        && previousGuard.workItemId === currentWorkItem.id
        && previousGuard.requirementsVersion === currentRequirementsVersion
        && previousGuard.authorizationVersion === currentAuthorizationVersion
        && previousGuard.contractSignature === currentContractSignature;
      const occurrences = previousMatches ? previousGuard!.occurrences + 1 : 1;
      const blocked = previousMatches && (previousGuard!.blocked || occurrences >= 2);
      currentStore.updateLane(currentLane.id, {
        awaitingReview: true,
        supervisorDecisionErrorGuard: {
          errorSignature,
          inputSignature,
          occurrences,
          blocked,
          workItemId: currentWorkItem.id,
          requirementsVersion: currentRequirementsVersion,
          authorizationVersion: currentAuthorizationVersion,
          contractSignature: currentContractSignature,
          ...(currentLane.activeReviewId ? { reviewId: currentLane.activeReviewId } : {}),
          blockerCategory,
          detectedAt: Date.now(),
        },
      });
      if (!blocked) return result;

      if (supervisorLaneControlState(currentLane) === 'active') {
        currentStore.pauseSupervisorLane(currentLane.id, '相同监督裁决错误连续出现两次，已进入协议纠错暂停');
      }
      currentStore.applyProjectManagerAction({
        type: 'update-work-item',
        workItemId: currentWorkItem.id,
        patch: {
          status: 'waiting-decision',
          latestBlocker: `监督裁决协议错误重复：${String(result.error).slice(0, 1200)}`,
        },
      }, currentProject.id);
      if (!previousGuard?.blocked) {
        queueProjectSupervisorAnomaly(
          currentProject,
          currentLane,
          currentWorkItem,
          'supervisor.decision-error-loop',
          '监督 AI 连续两次提交相同的无效裁决，控制层已暂停该监督通道并保留当前任务现场',
          {
            evidence: String(result.error).slice(0, 12_000),
            contextSummary: '请项目 AI 核对错误、任务成果与当前需求版本，更新实质方向后使用同一工作项恢复监督；不要新建重复任务。',
          },
        );
        saveProjectManagerSnapshot(currentProject.id);
      }
      return {
        ...result,
        protocolCorrectionPaused: true,
        error: `${result.error}；相同错误已连续出现两次，当前项目专属监督已进入协议纠错暂停，等待实质输入变化或项目 AI 更新方向`,
      };
    };

    const result: any = decideSupervisor(params);    if (result && typeof result.then === 'function') {
      return result.then((resolved: any) => {
        if (resolved?.ok === true) {
          const latestLane = useStore.getState().supervisor.lanes
            .find((candidate) => candidate.id === initialLane.id);
          if (latestLane?.supervisorDecisionErrorGuard) {
            useStore.getState().updateLane(latestLane.id, { supervisorDecisionErrorGuard: undefined });
          }
        }
        return resolved;
      });
    }
    return finishGuardedDecision(result);
  };

  // The Feishu main-process gateway authenticates the caller; this renderer
  // bridge only accepts its small, explicit set of supervision/task actions.
  w.__wmux_supervisorRemoteControl = (params: any) => {
    const action = String(params?.action || '');
    if (action === 'list') {
      const state = useStore.getState().supervisor;
      const ordinaryLaneIds = new Set(
        state.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane)).map((lane) => lane.id),
      );
      const ordinaryLanes = state.lanes.filter((lane) => ordinaryLaneIds.has(lane.id));
      const ordinaryActive = ordinaryLanes.some((lane) => {
        const laneState = supervisorLaneControlState(lane);
        return laneState === 'active' || laneState === 'waiting';
      });
      const ordinaryPaused = !ordinaryActive
        && ordinaryLanes.some((lane) => supervisorLaneControlState(lane) === 'paused');
      return {
        ok: true,
        message: JSON.stringify({
          active: ordinaryActive,
          paused: ordinaryPaused,
          terminals: remoteTerminalList().filter((terminal) => (
            !terminal.surface.projectManagerProjectId && !terminal.surface.projectManagerWorkItemId
          )).map((terminal) => ({
            ...(() => {
              const lane = state.lanes.find((item) => item.surfaceId === terminal.surfaceId);
              const supervisionState = lane ? supervisorLaneControlState(lane) : 'none';
              return {
                supervised: !!lane && supervisionState !== 'stopped' && (state.active || state.paused),
                restartable: supervisionState === 'stopped',
                supervisionState,
                managementSessionId: lane?.managementSessionId || null,
                autonomous: lane ? effectiveSupervisorAutonomous(state, lane) : null,
                autonomyPermissionCount: lane ? effectiveSupervisorAutonomyPermissions(state, lane).length : null,
                forbiddenActionCount: lane ? effectiveSupervisorForbiddenActions(state, lane).length : null,
                policyOverridden: !!lane && (
                  Array.isArray(lane.autonomyPermissionsOverride)
                  || typeof lane.autonomousOverride === 'boolean'
                  || Array.isArray(lane.forbiddenActionsOverride)
                  || !!lane.workScopeOverride
                ),
              };
            })(),
            surfaceId: terminal.surfaceId,
            label: terminal.label,
            workspaceId: terminal.workspaceId,
            workspace: terminal.workspaceTitle,
            cwd: terminal.cwd,
            ...remoteTerminalActivity(terminal.surfaceId),
          })),
          session: ordinaryActive || ordinaryPaused
            ? { sessionId: state.sessionId, autonomous: state.autonomous }
            : null,
          pendingApprovals: state.pendingApprovals
            .filter((approval) => ordinaryLaneIds.has(approval.laneId))
            .map((approval) => ({ id: approval.id, terminal: approval.laneLabel, reason: approval.reason || '' })),
        }),
      };
    }
    if (action === 'terminal-list') {
      if (!['ordinary', 'project'].includes(String(params?.mode))) {
        return { ok: false, error: '终端列表模式无效。' };
      }
      const projectMode = params.mode === 'project';
      const terminals = projectMode
        ? remoteProjectTerminalList().map((terminal) => {
            const runtime = terminalRuntimeStatus(terminal.surfaceId);
            const activity = remoteTerminalActivity(terminal.surfaceId);
            return {
              surfaceId: terminal.surfaceId,
              label: terminal.label,
              workspaceId: terminal.workspaceId,
              workspace: terminal.workspaceTitle,
              cwd: terminal.cwd,
              supervised: terminal.role !== 'project-ai',
              supervisionState: 'none',
              ...activity,
              terminalMode: 'project',
              agentRole: terminal.role,
              projectId: terminal.projectId,
              projectName: terminal.projectName,
              workItemId: terminal.workItemId,
              workItemTitle: terminal.workItemTitle,
              runtimeState: runtime?.state,
              runtimeDetail: runtime?.detail,
            };
          })
        : remoteOrdinaryMonitoringTerminalList().map((terminal) => {
            const runtime = terminalRuntimeStatus(terminal.surfaceId);
            const activity = remoteTerminalActivity(terminal.surfaceId);
            const laneState = terminal.lane ? supervisorLaneControlState(terminal.lane) : 'none';
            const publicLaneState = laneState === 'waiting' ? 'active' : laneState;
            return {
              surfaceId: terminal.surfaceId,
              label: terminal.role === 'supervisor-ai' ? terminal.lane?.label || terminal.label : terminal.label,
              workspaceId: terminal.workspaceId,
              workspace: terminal.workspaceTitle,
              cwd: terminal.cwd,
              supervised: !!terminal.lane && publicLaneState !== 'stopped',
              restartable: publicLaneState === 'stopped',
              supervisionState: publicLaneState,
              managementSessionId: terminal.lane?.managementSessionId || null,
              ...activity,
              terminalMode: 'ordinary',
              agentRole: terminal.role,
              runtimeState: runtime?.state,
              runtimeDetail: runtime?.detail,
            };
          });
      return {
        ok: true,
        message: JSON.stringify({
          active: false,
          paused: false,
          terminals,
          session: null,
          pendingApprovals: [],
        }),
      };
    }
    if (action === 'logs') {
      const state = useStore.getState().supervisor;
      const ordinaryLanes = state.lanes.filter((lane) => !isProjectManagedSupervisorLane(lane));
      const ordinaryLaneIds = new Set(ordinaryLanes.map((lane) => lane.id));
      const laneLabels = new Map(ordinaryLanes.map((lane) => [lane.id, lane.label]));
      return {
        ok: true,
        message: JSON.stringify({
          active: ordinaryLanes.some((lane) => {
            const laneState = supervisorLaneControlState(lane);
            return laneState === 'active' || laneState === 'waiting';
          }),
          paused: ordinaryLanes.some((lane) => supervisorLaneControlState(lane) === 'paused'),
          sessionId: state.sessionId,
          entries: state.log.filter((entry) => ordinaryLaneIds.has(entry.laneId)).slice(0, 20).map((entry) => ({
            ts: entry.ts,
            laneLabel: entry.laneId === '-' ? '会话' : laneLabels.get(entry.laneId) || '未知通道',
            action: entry.action,
            detail: entry.detail,
          })),
        }),
      };
    }
    if (action === 'terminal-screen') {
      const terminalId = String(params?.terminal || '');
      if (params?.mode === 'project') {
        const located = locateRemoteProjectTerminal(terminalId);
        const terminal = located.terminal;
        if (!terminal) return { ok: false, error: located.error };
        const requestedLines = Number(params?.lines);
        const lines = Number.isFinite(requestedLines)
          ? Math.min(Math.max(Math.floor(requestedLines), 1), 100)
          : 40;
        const screen = readTerminalScreen(terminal.surfaceId, lines);
        if (screen.error) return { ok: false, error: screen.error };
        const activity = remoteTerminalActivity(terminal.surfaceId);
        const conversation = terminalSupervisorCoreExcerpt(screen.text || '', terminal.label, activity.activityState);
        const runtime = terminalRuntimeStatus(terminal.surfaceId);
        return {
          ok: true,
          terminal: {
            surfaceId: terminal.surfaceId,
            label: terminal.label,
            workspace: terminal.workspaceTitle,
            cwd: terminal.cwd,
            terminalMode: 'project',
            agentRole: terminal.role,
            projectId: terminal.projectId,
            projectName: terminal.projectName,
            workItemId: terminal.workItemId,
            workItemTitle: terminal.workItemTitle,
            runtimeState: runtime?.state,
            runtimeDetail: runtime?.detail,
            ...activity,
          },
          ...conversation,
          lines: screen.lines || 0,
          capturedAt: Date.now(),
        };
      }
      if (params?.mode === 'ordinary') {
        const terminal = remoteOrdinaryMonitoringTerminalList()
          .find((candidate) => candidate.surfaceId === terminalId);
        if (!terminal) {
          return { ok: false, error: '目标不属于普通监督模式、已经关闭或已被新运行时替代；请刷新终端列表。' };
        }
        const requestedLines = Number(params?.lines);
        const lines = Number.isFinite(requestedLines)
          ? Math.min(Math.max(Math.floor(requestedLines), 1), 100)
          : 40;
        const screen = readTerminalScreen(terminal.surfaceId, lines);
        if (screen.error) return { ok: false, error: screen.error };
        const activity = remoteTerminalActivity(terminal.surfaceId);
        const label = terminal.role === 'supervisor-ai' ? terminal.lane?.label || terminal.label : terminal.label;
        const conversation = terminalSupervisorCoreExcerpt(screen.text || '', label, activity.activityState);
        const runtime = terminalRuntimeStatus(terminal.surfaceId);
        return {
          ok: true,
          terminal: {
            surfaceId: terminal.role === 'supervisor-ai' ? terminal.lane?.surfaceId || terminal.surfaceId : terminal.surfaceId,
            label,
            workspace: terminal.workspaceTitle,
            cwd: terminal.cwd,
            terminalMode: 'ordinary',
            agentRole: terminal.role,
            runtimeState: runtime?.state,
            runtimeDetail: runtime?.detail,
            ...activity,
          },
          ...conversation,
          lines: screen.lines || 0,
          capturedAt: Date.now(),
        };
      }
      if (params?.mode !== undefined) {
        return { ok: false, error: '终端读取模式无效。' };
      }
      const located = locateRemoteTaskTerminal(terminalId);
      const terminal = located.terminal;
      if (!terminal) {
        return { ok: false, error: located.error };
      }
      if (terminal.surface.projectManagerProjectId || terminal.surface.projectManagerWorkItemId) {
        return { ok: false, error: '项目任务终端不能通过普通 AI 监督入口读取。' };
      }
      const requestedLines = Number(params?.lines);
      const lines = Number.isFinite(requestedLines)
        ? Math.min(Math.max(Math.floor(requestedLines), 1), 100)
        : 40;
      const screen = readTerminalScreen(terminal.surfaceId, lines);
      if (screen.error) return { ok: false, error: screen.error };
      const activity = remoteTerminalActivity(terminal.surfaceId);
      const conversation = terminalSupervisorCoreExcerpt(screen.text || '', terminal.label, activity.activityState);
      return {
        ok: true,
        terminal: {
          surfaceId: terminal.surfaceId,
          label: terminal.label,
          workspace: terminal.workspaceTitle,
          cwd: terminal.cwd,
          ...activity,
        },
        ...conversation,
        lines: screen.lines || 0,
        capturedAt: Date.now(),
      };
    }
    if (action === 'supervisor-screen') {
      const located = locateRemoteSupervisorTerminal(String(params?.terminal || ''));
      if (!located.lane || !located.supervisorSurfaceId) {
        return { ok: false, error: located.error };
      }
      if (isProjectManagedSupervisorLane(located.lane)) {
        return { ok: false, error: '项目监督终端只能通过项目管理模式查看。' };
      }
      const requestedLines = Number(params?.lines);
      const lines = Number.isFinite(requestedLines)
        ? Math.min(Math.max(Math.floor(requestedLines), 1), 100)
        : 40;
      const screen = readTerminalScreen(located.supervisorSurfaceId, lines);
      if (screen.error) return { ok: false, error: screen.error };
      const activity = remoteTerminalActivity(located.supervisorSurfaceId);
      const conversation = terminalSupervisorCoreExcerpt(screen.text || '', located.lane.label, activity.activityState);
      return {
        ok: true,
        terminal: {
          // Keep the public lane terminal ID so refresh/send actions never expose
          // the dedicated supervisor surface through the task-terminal endpoint.
          surfaceId: located.lane.surfaceId,
          label: located.lane.label,
          workspace: located.workspaceTitle || '',
          cwd: located.lane.scopeRoot || located.lane.projectDir,
          ...activity,
        },
        ...conversation,
        lines: screen.lines || 0,
        capturedAt: Date.now(),
      };
    }
    if (action === 'decision-context') {
      const approvalId = String(params?.approvalId || '');
      const terminal = String(params?.terminal || '');
      const approval = useStore.getState().supervisor.pendingApprovals.find((item) => item.id === approvalId);
      if (!approval || approval.surfaceId !== terminal) {
        return { ok: false, error: '该待决项不存在、已过期或与任务终端不匹配。' };
      }
      const lane = useStore.getState().supervisor.lanes.find((item) => item.id === approval.laneId);
      if (lane && isProjectManagedSupervisorLane(lane)) {
        return { ok: false, error: '该待决项属于项目管理模式，只能由对应的项目管理 AI 查看。' };
      }
      const screen = readTerminalScreen(terminal, Number(params?.lines) || 40);
      const activity = remoteTerminalActivity(approval.surfaceId);
      const coreInformation = terminalSupervisorCoreExcerpt(
        screen.text || '',
        approval.laneLabel,
        activity.activityState,
      ).answer || '';
      return {
        ok: true,
        recommendation: approval.text || '',
        recommendedOption: approval.recommendedOption || '',
        terminalScreen: coreInformation,
      };
    }
    if (action === 'start') return startRemoteSupervisor(params as RemoteSupervisorStart);
    if (action === 'create-task') return createRemoteDirectTerminalTask(params as RemoteDirectTerminalTask);
    if (action === 'send') return sendRemoteTerminalTask(params as RemoteTerminalTask);
    if (action === 'terminal-escape') return sendRemoteTerminalEscape(params as RemoteTerminalEscape);
    if (action === 'terminal-interrupt') return sendRemoteTerminalInterrupt(params as RemoteTerminalInterrupt);
    if (action === 'close-terminal') return closeRemoteTerminal(params);
    if (action === 'send-supervisor-message') return sendRemoteSupervisorMessage(params as RemoteSupervisorMessage);
    if (action === 'waiting-decision') return decideRemoteWaiting(params as RemoteWaitingDecision);
    if (action === 'pause-lane' || action === 'resume-lane' || action === 'stop-lane') {
      const session = useStore.getState().supervisor;
      const actor = String(params?.actor || 'unknown');
      const terminal = String(params?.terminal || '');
      const lane = session.lanes.find((item) => item.surfaceId === terminal || item.managementSessionId === terminal);
      if (!lane) return { ok: false, error: '没有找到对应的 AI 监督通道。', message: '' };
      if (isProjectManagedSupervisorLane(lane)) {
        return { ok: false, error: '该通道属于项目管理模式，只能由对应的项目管理 AI 控制。', message: '' };
      }
      const laneState = supervisorLaneControlState(lane);
      if (action === 'pause-lane') {
        if (laneState === 'stopped') return { ok: false, error: `${lane.label} 已停止，不能暂停。`, message: '' };
        if (laneState === 'paused') return { ok: true, message: `${lane.label} 已经暂停。` };
        remoteAudit(session, lane, 'supervisor.remote-command', { action: 'pause-lane', actor });
        useStore.getState().pauseSupervisorLane(lane.id, `由飞书暂停 ${lane.label}`);
        return { ok: true, message: `已暂停 ${lane.label} 的 AI 监督；其他通道继续运行。` };
      }
      if (action === 'resume-lane') {
        if (laneState === 'stopped') return { ok: false, error: `${lane.label} 已停止；请重新配置后启动。`, message: '' };
        if (laneState === 'active') return { ok: true, message: `${lane.label} 已经在监督中。` };
        const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
        if (!supervisorSurfaceId
          || !hasLiveSurface(supervisorSurfaceId)
          || lane.supervisorProblem?.kind === 'runtime-failed') {
          return { ok: false, error: `${lane.label} 的专属监督终端已缺失；请在 wmux 中重新配置。`, message: '' };
        }
        const retriesWatchdog = lane.supervisorProblem?.kind === 'unreported-decision';
        remoteAudit(session, lane, 'supervisor.remote-command', { action: 'resume-lane', actor });
        useStore.getState().resumeSupervisorLane(lane.id, `由飞书继续 ${lane.label}`);
        if (retriesWatchdog) {
          useStore.getState().updateLane(lane.id, {
            reviewWatchdogState: 'retrying',
            reviewDeliveryConfirmedAt: undefined,
            unreportedIdleRecoveryAttempts: 1,
            supervisorProblem: undefined,
          });
        }
        if (session.active && !session.pendingApprovals.some((item) => item.laneId === lane.id)) {
          queueSupervisorControlMessage(
            useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane,
            retriesWatchdog
              ? buildUnacknowledgedSupervisorIdlePrompt(lane)
              : '[通道继续] 用户已通过飞书恢复此监督通道。保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n',
          );
        }
        return { ok: true, message: session.paused
          ? `${lane.label} 已设为继续；当前会话仍处于全局暂停。`
          : `已继续 ${lane.label} 的 AI 监督。` };
      }
      if (laneState === 'stopped') return { ok: true, message: `${lane.label} 已经停止。` };
      remoteAudit(session, lane, 'supervisor.remote-command', { action: 'stop-lane', actor });
      closeStoppedSupervisorSurfaces([lane]);
      useStore.getState().stopSupervisorLane(lane.id, `由飞书停止 ${lane.label} 并解除终端绑定`);
      return { ok: true, message: `已停止 ${lane.label} 的 AI 监督并解除终端绑定；可重新选择该终端启动监督，其他通道不受影响。` };
    }
    if (action === 'pause-all' || action === 'resume-all' || action === 'toggle-pause') {
      const session = useStore.getState().supervisor;
      const actor = String(params?.actor || 'unknown');
      const ordinaryLanes = session.lanes.filter((lane) => (
        !isProjectManagedSupervisorLane(lane) && isSupervisorLaneBound(lane)
      ));
      const ordinaryActive = ordinaryLanes.some((lane) => supervisorLaneControlState(lane) === 'active');
      const ordinaryPaused = ordinaryLanes.some((lane) => supervisorLaneControlState(lane) === 'paused');
      if (ordinaryLanes.length === 0) {
        return { ok: false, error: '当前没有普通 AI 监督；项目监督请由项目管理 AI 控制。', message: '' };
      }
      if (action === 'pause-all' && !ordinaryActive) {
        return { ok: true, message: '当前普通 AI 监督已经暂停或正在待续。' };
      }
      if (action === 'resume-all' && !ordinaryPaused) {
        return { ok: true, message: '当前普通 AI 监督已经在运行或正在待续。' };
      }
      const shouldPause = action === 'pause-all' || (action === 'toggle-pause' && ordinaryActive);
      if (shouldPause && ordinaryActive) {
        useStore.getState().pauseOrdinarySupervisor('由飞书远程暂停普通监督；项目监督状态不变');
        for (const lane of ordinaryLanes) remoteAudit(session, lane, 'supervisor.remote-command', { action: 'pause', actor });
        return { ok: true, message: '已暂停普通 AI 监督；项目监督不受影响。' };
      }
      const shouldResume = action === 'resume-all' || (action === 'toggle-pause' && ordinaryPaused);
      if (shouldResume && ordinaryPaused) {
        const missingLane = ordinaryLanes.find((lane) => {
          const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
          return supervisorLaneControlState(lane) === 'paused'
            && (
              !supervisorSurfaceId
              || !hasLiveSurface(supervisorSurfaceId)
              || lane.supervisorProblem?.kind === 'runtime-failed'
            );
        });
        if (missingLane) return { ok: false, error: `专属监督终端已缺失：${missingLane.label}。请在 wmux 中停止后重新配置。`, message: '' };
        useStore.getState().resumeOrdinarySupervisor();
        const resumed = useStore.getState().supervisor;
        const pendingLaneIds = new Set(resumed.pendingApprovals.map((item) => item.laneId));
        for (const lane of resumed.lanes.filter((candidate) => !isProjectManagedSupervisorLane(candidate))) {
          remoteAudit(resumed, lane, 'supervisor.remote-command', { action: 'resume', actor });
          const supervisorSurfaceId = dedicatedSupervisorSurfaceId(lane);
          if (supervisorLaneControlState(lane) !== 'active'
            || !supervisorSurfaceId
            || pendingLaneIds.has(lane.id)) continue;
          const retriesWatchdog = lane.supervisorProblem?.kind === 'unreported-decision';
          if (retriesWatchdog) {
            useStore.getState().updateLane(lane.id, {
              reviewWatchdogState: 'retrying',
              reviewDeliveryConfirmedAt: undefined,
              unreportedIdleRecoveryAttempts: 1,
              supervisorProblem: undefined,
            });
          }
          queueSupervisorControlMessage(
            useStore.getState().supervisor.lanes.find((candidate) => candidate.id === lane.id) || lane,
            retriesWatchdog
              ? buildUnacknowledgedSupervisorIdlePrompt(lane)
              : '[会话继续] 用户已通过飞书恢复当前监督会话。请保持原任务和模型上下文，先 read-screen 获取最新证据，再继续监督。\n',
          );
        }
        return { ok: true, message: '已继续普通 AI 监督；项目监督不受影响。' };
      }
      return { ok: false, error: '当前没有可暂停或继续的普通 AI 监督。', message: '' };
    }
    if (action === 'stop') {
      const session = useStore.getState().supervisor;
      const ordinaryLanes = session.lanes.filter((lane) => (
        !isProjectManagedSupervisorLane(lane) && isSupervisorLaneBound(lane)
      ));
      if (ordinaryLanes.length === 0) {
        return { ok: false, error: '当前没有普通 AI 监督；项目监督请由项目管理 AI 控制。', message: '' };
      }
      useStore.getState().stopOrdinarySupervisor('由飞书远程停止普通监督；项目监督状态不变');
      for (const lane of ordinaryLanes) {
        remoteAudit(session, lane, 'supervisor.remote-command', { action: 'stop', actor: String(params?.actor || 'unknown') });
      }
      return { ok: true, message: '已停止普通 AI 监督；项目监督不受影响。' };
    }
    if (action === 'decide') {
      const decision = String(params?.decision || '');
      if (!['approve', 'direct', 'pause', 'stop'].includes(decision)) return { ok: false, error: '无效的人工决策。', message: '' };
      return decideRemoteSupervisor(
        String(params?.approvalId || ''),
        decision as 'approve' | 'direct' | 'pause' | 'stop',
        String(params?.selection || ''),
        String(params?.task || ''),
        String(params?.actor || 'unknown'),
      );
    }
    return { ok: false, error: '不支持的监督控制动作。', message: '' };
  };

  // ─── Markdown ───────────────────────────────────────────────────────────────

  w.__wmux_setMarkdownContent = (surfaceId: string, markdown: string, fileName?: string, filePath?: string, mtimeMs?: number) => {
    // Persist into the store so MarkdownPane (re)renders the content. The old
    // `wmux:markdown-update` CustomEvent had no listener, so content never
    // displayed (issue #54). `fileName`, when the content came from a file, is
    // used as the tab label so multiple markdown tabs stay distinguishable;
    // `filePath` makes the surface path-aware (issue #116) so the pane can show
    // the path, copy it, reveal it, and reload from it.
    // `mtimeMs` (F3) records what was on disk at load time so a later save can
    // detect an agent having rewritten the file underneath the pane.
    useStore.getState().setMarkdownContent(surfaceId as SurfaceId, markdown ?? '', { fileName, filePath, mtimeMs });
    return { ok: true };
  };

  // Read a markdown surface's buffer back out (issue #116). Mirrors
  // __wmux_readScreen for terminals — an agent that pushed content has no other
  // way to check what actually landed.
  w.__wmux_getMarkdownContent = (surfaceId: string) => {
    const state = useStore.getState();
    for (const ws of state.workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const surface = findLeaf(ws.splitTree, paneId)?.surfaces.find((s) => s.id === surfaceId);
        if (surface) {
          return {
            surfaceId,
            content: surface.markdownContent ?? '',
            filePath: surface.markdownFilePath ?? null,
            fileName: surface.markdownFileName ?? null,
            dirty: !!surface.markdownDirty,
          };
        }
      }
    }
    return null;
  };

  // ─── Notifications ──────────────────────────────────────────────────────────

  w.__wmux_listNotifications = () => {
    return useStore.getState().notifications || [];
  };

  w.__wmux_clearNotification = (id: string) => {
    useStore.getState().clearNotification(id);
  };

  w.__wmux_clearAllNotifications = () => {
    useStore.getState().clearAll();
  };

  // ─── Tree ───────────────────────────────────────────────────────────────────

  w.__wmux_getTree = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    return ws?.splitTree || null;
  };
}
