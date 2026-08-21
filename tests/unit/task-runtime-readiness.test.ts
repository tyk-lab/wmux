import { describe, expect, it } from 'vitest';
import {
  ordinaryTaskDeliveryBlockReason,
  taskTerminalRuntimeKind,
} from '../../src/renderer/supervisor/task-runtime-readiness';

describe('ordinary task runtime readiness', () => {
  it('accepts authoritative Agent state or recognizable idle Agent screens', () => {
    expect(taskTerminalRuntimeKind({ agentState: 'idle', screenText: '' })).toBe('agent');
    expect(taskTerminalRuntimeKind({
      agentState: 'unknown',
      screenText: '✦ Kimi Code\nNo session yet — send your first message\ncontext: 0',
    })).toBe('agent');
    expect(taskTerminalRuntimeKind({ agentState: 'unknown', screenText: 'OpenCode\nAsk anything' })).toBe('agent');
  });

  it('rejects a plain PowerShell prompt before natural-language delivery', () => {
    const evidence = {
      agentState: 'unknown',
      runtimeState: 'ready',
      screenText: 'No session yet — send your first message\nParserError:\nPS E:\\repo> ',
    };
    expect(taskTerminalRuntimeKind(evidence)).toBe('shell');
    expect(ordinaryTaskDeliveryBlockReason(evidence)).toContain('普通 shell');
    expect(ordinaryTaskDeliveryBlockReason(evidence)).toContain('禁止把任务正文发送给 PowerShell');
  });

  it('lets a current shell prompt override stale idle state', () => {
    expect(taskTerminalRuntimeKind({ agentState: 'idle', screenText: 'PS E:\\repo> ' })).toBe('shell');
  });

  it('fails closed when neither Agent nor shell evidence is available', () => {
    expect(taskTerminalRuntimeKind({ agentState: 'unknown', screenText: '' })).toBe('unknown');
    expect(ordinaryTaskDeliveryBlockReason({ agentState: 'unknown' })).toContain('尚无可信 Agent 就绪证据');
  });
});
