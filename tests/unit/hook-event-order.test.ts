import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = fs.readFileSync(path.resolve(__dirname, '../../src/main/index.ts'), 'utf8');
const appSource = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/App.tsx'), 'utf8');
const hookSource = fs.readFileSync(path.resolve(__dirname, '../../src/cli/wmux-hook.ts'), 'utf8');

describe('hook event ordering', () => {
  it('commits agent state before broadcasting a lifecycle event to the renderer', () => {
    const handler = mainSource.match(/function handleHookEvent\(params: any\): void \{[\s\S]*?^\}/m)?.[0] || '';
    expect(handler.indexOf('applyHookToAgentState(')).toBeGreaterThanOrEqual(0);
    expect(handler.indexOf('webContents.send(IPC_CHANNELS.HOOK_EVENT')).toBeGreaterThan(
      handler.indexOf('applyHookToAgentState('),
    );
  });

  it('updates the synchronous renderer state snapshot before waking delivery', () => {
    const listener = appSource.match(/window\.wmux\.agentState\.onUpdate[\s\S]*?return unsub;/)?.[0] || '';
    expect(listener).toContain('agentStatesRef.current = next;');
    expect(listener.indexOf('signalSupervisorDeliveryReady()')).toBeGreaterThan(
      listener.indexOf('agentStatesRef.current = next;'),
    );
    expect(appSource).toContain('不得据此否定本事件或等待第二次结束 hook');
  });

  it('waits for the pipe response instead of treating a socket write as acceptance', () => {
    expect(hookSource).toContain("client.on('data'");
    expect(hookSource).toContain('stableWmuxHookId({');
    expect(hookSource).toContain('}) || randomUUID();');
    expect(hookSource).toContain("const reply = JSON.parse(response.trim())");
    expect(hookSource).not.toContain('client.write(wireMessage, () =>');
    expect(hookSource).toContain('if (attempt >= MAX_PIPE_ATTEMPTS)');
    expect(hookSource).toContain('process.exitCode = 1;');
  });

  it('records every task start but wakes supervision only for confirmed user-direct work', () => {
    const handler = appSource.match(/function handleSupervisorHookEvent\(event: any\): void \{[\s\S]*?^\}/m)?.[0] || '';
    expect(handler).toContain("lifecycle === 'UserPromptSubmit'");
    expect(handler).toContain('confirmSupervisorUserSubmitFromHook');
    expect(handler).toContain('userDirectTaskTurnId: confirmedUserSubmit ? nextWorkerTurnId : undefined');
    expect(handler).toContain('userDirectTaskTurnId: undefined');
    expect(handler).toContain('if (confirmedUserSubmit)');
    expect(handler).toContain("'user-task'");
    expect(handler).not.toContain("'task-start'");
    expect(handler.indexOf('workerTurnId: nextWorkerTurnId')).toBeLessThan(handler.indexOf("'user-task'"));
    expect(handler.indexOf('confirmSupervisorUserSubmitFromHook')).toBeLessThan(handler.indexOf("'user-task'"));
  });
});
