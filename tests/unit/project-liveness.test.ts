import { describe, expect, it } from 'vitest';
import {
  PROJECT_LIVENESS_CONTROL_GRACE_MS,
  PROJECT_LIVENESS_IDLE_PROBE_MS,
  PROJECT_LIVENESS_PROBE_REPORT_MS,
  PROJECT_LIVENESS_SUPERVISOR_WORKING_GRACE_MS,
  evaluateProjectLiveness,
} from '../../src/renderer/project-manager/liveness';

describe('project execution-chain liveness', () => {
  const initial = evaluateProjectLiveness({
    fingerprint: 'v1', now: 1_000, supervisorState: 'working', workerState: 'working',
    pendingSupervisorDeliveries: 0,
  }).runtime;

  it('does not inject progress prompts while a supervisor is legitimately thinking', () => {
    const decision = evaluateProjectLiveness({
      runtime: initial,
      fingerprint: 'v1',
      now: 1_000 + PROJECT_LIVENESS_SUPERVISOR_WORKING_GRACE_MS - 1,
      supervisorState: 'working', workerState: 'working', pendingSupervisorDeliveries: 0,
    });
    expect(decision.action).toBe('none');
    expect(decision.runtime.probeQueuedAt).toBeUndefined();
  });

  it('escalates a semantically silent working supervisor through Esc, Ctrl+C, then one report', () => {
    const escaped = evaluateProjectLiveness({
      runtime: initial, fingerprint: 'v1',
      now: 1_000 + PROJECT_LIVENESS_SUPERVISOR_WORKING_GRACE_MS,
      supervisorState: 'working', workerState: 'working', pendingSupervisorDeliveries: 0,
    });
    expect(escaped.action).toBe('escape-supervisor');

    const interrupted = evaluateProjectLiveness({
      runtime: escaped.runtime, fingerprint: 'v1',
      now: escaped.runtime.escapeSentAt! + PROJECT_LIVENESS_CONTROL_GRACE_MS,
      supervisorState: 'working', workerState: 'working', pendingSupervisorDeliveries: 1,
    });
    expect(interrupted.action).toBe('interrupt-supervisor');

    const reported = evaluateProjectLiveness({
      runtime: interrupted.runtime, fingerprint: 'v1',
      now: interrupted.runtime.interruptSentAt! + PROJECT_LIVENESS_CONTROL_GRACE_MS,
      supervisorState: 'working', workerState: 'working', pendingSupervisorDeliveries: 1,
    });
    expect(reported.action).toBe('report-supervisor-stuck');
    expect(evaluateProjectLiveness({
      runtime: reported.runtime, fingerprint: 'v1', now: reported.runtime.attentionReportedAt! + 60_000,
      supervisorState: 'working', workerState: 'working', pendingSupervisorDeliveries: 1,
    }).action).toBe('none');
  });

  it('queues one probe for an idle chain and reports only if the probe remains unanswered', () => {
    const idle = evaluateProjectLiveness({
      fingerprint: 'idle-v1', now: 5_000, supervisorState: 'idle', workerState: 'idle',
      pendingSupervisorDeliveries: 0,
    }).runtime;
    const probed = evaluateProjectLiveness({
      runtime: idle, fingerprint: 'idle-v1', now: 5_000 + PROJECT_LIVENESS_IDLE_PROBE_MS,
      supervisorState: 'idle', workerState: 'idle', pendingSupervisorDeliveries: 0,
    });
    expect(probed.action).toBe('probe-supervisor');
    expect(evaluateProjectLiveness({
      runtime: probed.runtime, fingerprint: 'idle-v1',
      now: probed.runtime.probeQueuedAt! + PROJECT_LIVENESS_PROBE_REPORT_MS - 1,
      supervisorState: 'idle', workerState: 'idle', pendingSupervisorDeliveries: 0,
    }).action).toBe('none');
    expect(evaluateProjectLiveness({
      runtime: probed.runtime, fingerprint: 'idle-v1',
      now: probed.runtime.probeQueuedAt! + PROJECT_LIVENESS_PROBE_REPORT_MS,
      supervisorState: 'idle', workerState: 'idle', pendingSupervisorDeliveries: 0,
    }).action).toBe('report-supervisor-stuck');
  });

  it('wakes queued work when the supervisor becomes deliverable and resets on real progress', () => {
    expect(evaluateProjectLiveness({
      runtime: initial, fingerprint: 'v2', now: 9_000,
      supervisorState: 'idle', workerState: 'working', pendingSupervisorDeliveries: 1,
    })).toMatchObject({ action: 'wake-supervisor', silentForMs: 0 });
  });
});
