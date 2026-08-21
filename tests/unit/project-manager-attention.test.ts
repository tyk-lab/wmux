import { describe, expect, it } from 'vitest';
import {
  activeProjectManagerAttentionEvent,
  projectManagerEventNeedsUserAttention,
} from '../../src/shared/project-manager';

describe('project manager attention events', () => {
  it('alerts for every failure suffix and explicit terminal blockers only', () => {
    expect(projectManagerEventNeedsUserAttention({ kind: 'manager-runtime-failed' })).toBe(true);
    expect(projectManagerEventNeedsUserAttention({ kind: 'future-control-failed' })).toBe(true);
    expect(projectManagerEventNeedsUserAttention({
      kind: 'guard-triggered', payload: { decision: 'pause', attentionRequired: true },
    })).toBe(true);
    expect(projectManagerEventNeedsUserAttention({
      kind: 'guard-triggered', payload: { decision: 'replan' },
    })).toBe(false);
    expect(projectManagerEventNeedsUserAttention({
      kind: 'project-goal-completed', payload: { attentionRequired: true },
    })).toBe(true);
    expect(projectManagerEventNeedsUserAttention({
      kind: 'project-stopped', payload: { attentionRequired: true },
    })).toBe(true);
  });

  it('clears an active alert after a recovery event', () => {
    const alert = { kind: 'requirements-quiesce-failed' as const, ts: 1 };
    expect(activeProjectManagerAttentionEvent([alert])).toBe(alert);
    expect(activeProjectManagerAttentionEvent([
      alert,
      { kind: 'manager-runtime-restarted' as const, ts: 2 },
    ])).toBe(alert);
    expect(activeProjectManagerAttentionEvent([
      alert,
      { kind: 'requirements-quiesced' as const, ts: 2 },
    ])).toBeUndefined();
    const deliveryAlert = { kind: 'manager-delivery-failed' as const, ts: 3 };
    expect(activeProjectManagerAttentionEvent([
      deliveryAlert,
      { kind: 'manager-delivery-restored' as const, ts: 4 },
    ])).toBeUndefined();
    const watchdogAlert = {
      kind: 'guard-triggered' as const, ts: 5, payload: { attentionRequired: true },
    };
    expect(activeProjectManagerAttentionEvent([
      watchdogAlert,
      {
        kind: 'recovery-restored' as const,
        ts: 6,
        payload: { resolvedAttentionKinds: ['guard-triggered'] },
      },
    ])).toBeUndefined();
    const completedGoalAlert = {
      kind: 'project-goal-completed' as const,
      ts: 7,
      payload: { attentionRequired: true },
    };
    expect(activeProjectManagerAttentionEvent([completedGoalAlert])).toBe(completedGoalAlert);
    expect(activeProjectManagerAttentionEvent([
      completedGoalAlert,
      { kind: 'project-resumed' as const, ts: 8 },
    ])).toBeUndefined();
  });
});
