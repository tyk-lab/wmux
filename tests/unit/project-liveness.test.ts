import { describe, expect, it } from 'vitest';
import {
  MANAGED_AGENT_ESCAPE_GRACE_MS,
  MANAGED_AGENT_INTERRUPT_GRACE_MS,
  MANAGED_AGENT_NO_LIVENESS_GRACE_MS,
  beginManagedAgentTurn,
  evaluateManagedAgentDeadline,
  managedAgentDeadlinePolicy,
  managedCommandHardBudgetMs,
  looksLikeManagedShellPrompt,
  normalizeProjectActivityFingerprintText,
  noteManagedAgentCommand,
  noteManagedAgentOutput,
  noteManagedAgentSemanticProgress,
  pauseManagedAgentWatchdog,
  resumeManagedAgentWatchdog,
  shiftManagedAgentDeadlineForSuspend,
} from '../../src/renderer/project-manager/liveness';

describe('normalizeProjectActivityFingerprintText', () => {
  it('忽略长思考期间变化的计时、动画和相对时间', () => {
    const first = normalizeProjectActivityFingerprintText('⠋ Working (1m 20s • esc to interrupt)\n10 seconds ago\n正在分析');
    const second = normalizeProjectActivityFingerprintText('⠙ Working (28m 40s • esc to interrupt)\n99 seconds ago\n正在分析');

    expect(first).toBe(second);
  });

  it('保留真正的新语义输出', () => {
    const before = normalizeProjectActivityFingerprintText('Thinking (10s)\n正在分析');
    const after = normalizeProjectActivityFingerprintText('Thinking (20s)\n已经找到失败原因');

    expect(after).not.toBe(before);
    expect(normalizeProjectActivityFingerprintText('Working (10 files modified)')).toContain('10 files modified');
  });

  it('distinguishes a plain shell prompt from Agent UI output', () => {
    expect(looksLikeManagedShellPrompt('Agent stopped\r\nPS C:\\repo> ')).toBe(true);
    expect(looksLikeManagedShellPrompt('root@host:/repo$ ')).toBe(true);
    expect(looksLikeManagedShellPrompt('Working\n已经恢复任务分析')).toBe(false);
  });
});

describe('managed project agent deadline policy', () => {
  it('uses conservative role and reasoning defaults', () => {
    expect(managedAgentDeadlinePolicy({ role: 'manager', reasoningEffort: 'medium' }))
      .toMatchObject({ softMs: 30 * 60_000, hardMs: 90 * 60_000 });
    expect(managedAgentDeadlinePolicy({ role: 'manager', reasoningEffort: 'high' }))
      .toMatchObject({ softMs: 45 * 60_000, hardMs: 120 * 60_000 });
    expect(managedAgentDeadlinePolicy({ role: 'supervisor', reasoningEffort: 'medium' }))
      .toMatchObject({ softMs: 20 * 60_000, hardMs: 60 * 60_000 });
    expect(managedAgentDeadlinePolicy({ role: 'task', reasoningEffort: 'medium' }))
      .toMatchObject({ softMs: 25 * 60_000, hardMs: 75 * 60_000 });
  });

  it('only lets sufficient successful history lengthen deadlines', () => {
    const shortHistory = Array.from({ length: 19 }, () => 80 * 60_000);
    const matureHistory = [...shortHistory, 80 * 60_000];
    expect(managedAgentDeadlinePolicy({ role: 'supervisor', successfulDurationsMs: shortHistory }).softMs)
      .toBe(20 * 60_000);
    expect(managedAgentDeadlinePolicy({ role: 'supervisor', successfulDurationsMs: matureHistory }).softMs)
      .toBe(90 * 60_000);
  });

  it('never lets history shorten an explicit task contract budget', () => {
    const policy = managedAgentDeadlinePolicy({
      role: 'task',
      reasoningEffort: 'medium',
      taskBudgetMinutes: 240,
      successfulDurationsMs: Array.from({ length: 20 }, () => 10 * 60_000),
    });
    expect(policy.hardMs).toBe(240 * 60_000);
  });

  it('gives install and test commands an explicit hard budget', () => {
    expect(managedCommandHardBudgetMs('npm ci')).toBe(180 * 60_000);
    expect(managedCommandHardBudgetMs('npm test')).toBe(120 * 60_000);
    expect(managedCommandHardBudgetMs('rg -n TODO src')).toBe(90 * 60_000);
  });
});

describe('managed project agent one-shot watchdog', () => {
  const policy = managedAgentDeadlinePolicy({ role: 'supervisor', reasoningEffort: 'medium' });

  function turn(now = 1_000) {
    return beginManagedAgentTurn({
      surfaceId: 'supervisor-a',
      role: 'supervisor',
      generation: 1,
      now,
      policy,
    });
  }

  it('does not interrupt a live long-thinking spinner at the soft deadline', () => {
    const initial = turn();
    const alive = noteManagedAgentOutput(initial, initial.softDeadlineAt - 1, 'thinking');
    const decision = evaluateManagedAgentDeadline({
      runtime: alive,
      now: initial.softDeadlineAt,
      policy,
    });

    expect(decision.action).toBe('none');
    expect(decision.runtime.nextDeadlineAt).toBe(initial.hardDeadlineAt);
  });

  it('gives a silent turn one local grace, then Esc, Ctrl+C, and recovery', () => {
    const initial = turn();
    const suspected = evaluateManagedAgentDeadline({ runtime: initial, now: initial.softDeadlineAt, policy });
    expect(suspected).toMatchObject({ action: 'none', runtime: { phase: 'soft-grace' } });
    expect(suspected.runtime.nextDeadlineAt).toBe(initial.softDeadlineAt + MANAGED_AGENT_NO_LIVENESS_GRACE_MS);

    const escaped = evaluateManagedAgentDeadline({
      runtime: suspected.runtime,
      now: suspected.runtime.nextDeadlineAt,
      policy,
    });
    expect(escaped).toMatchObject({ action: 'escape', runtime: { phase: 'escape-sent' } });
    expect(escaped.runtime.nextDeadlineAt).toBe(escaped.runtime.escapeSentAt! + MANAGED_AGENT_ESCAPE_GRACE_MS);

    const interrupted = evaluateManagedAgentDeadline({
      runtime: escaped.runtime,
      now: escaped.runtime.nextDeadlineAt,
      policy,
    });
    expect(interrupted).toMatchObject({ action: 'interrupt', runtime: { phase: 'interrupt-sent' } });
    expect(interrupted.runtime.nextDeadlineAt)
      .toBe(interrupted.runtime.interruptSentAt! + MANAGED_AGENT_INTERRUPT_GRACE_MS);

    expect(evaluateManagedAgentDeadline({
      runtime: interrupted.runtime,
      now: interrupted.runtime.nextDeadlineAt,
      policy,
    }).action).toBe('recover');
  });

  it('eventually interrupts an infinite spinner at the absolute hard deadline', () => {
    const initial = turn();
    const alive = noteManagedAgentOutput(initial, initial.hardDeadlineAt - 1, 'thinking');
    expect(evaluateManagedAgentDeadline({
      runtime: alive,
      now: initial.hardDeadlineAt,
      policy,
    }).action).toBe('escape');
  });

  it('resets a segment on semantic Hook progress and extends registered commands', () => {
    const initial = turn();
    const progressedAt = initial.softDeadlineAt - 1;
    const progressed = noteManagedAgentSemanticProgress(initial, progressedAt, policy);
    expect(progressed.softDeadlineAt).toBe(progressedAt + policy.softMs);
    expect(progressed.hardDeadlineAt).toBe(progressedAt + policy.hardMs);

    const command = noteManagedAgentCommand(progressed, progressedAt + 1, 'npm ci');
    expect(command.hardDeadlineAt).toBe(progressedAt + 1 + 180 * 60_000);
    expect(command.softDeadlineAt).toBe(progressedAt + 1 + 90 * 60_000);
  });

  it('pauses user/permission waits and excludes sleep from elapsed time', () => {
    const initial = turn();
    const paused = pauseManagedAgentWatchdog(initial, 5_000);
    expect(paused.phase).toBe('paused');
    expect(evaluateManagedAgentDeadline({ runtime: paused, now: initial.hardDeadlineAt * 2, policy }).action)
      .toBe('none');

    const resumed = resumeManagedAgentWatchdog(paused, 65_000);
    expect(resumed.hardDeadlineAt).toBe(initial.hardDeadlineAt + 60_000);

    const shifted = shiftManagedAgentDeadlineForSuspend(resumed, 10 * 60_000);
    expect(shifted.hardDeadlineAt)
      .toBe(resumed.hardDeadlineAt + 10 * 60_000 + MANAGED_AGENT_NO_LIVENESS_GRACE_MS);
  });
});
