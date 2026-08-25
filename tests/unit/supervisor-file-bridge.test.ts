import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PipeServer } from '../../src/main/pipe-server';
import { SupervisorFileBridge } from '../../src/main/supervisor-file-bridge';
import { sendFileBridgeRequest } from '../../src/cli/file-bridge';

describe('SupervisorFileBridge', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('relays an authenticated supervisor request through the existing surface capability guard', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-file-bridge-'));
    roots.push(runtimeRoot);
    const bridgeRoot = path.join(runtimeRoot, 'lane-a', 'bridge');
    const requestDir = path.join(bridgeRoot, 'requests');
    const responseDir = path.join(bridgeRoot, 'responses');
    fs.mkdirSync(requestDir, { recursive: true });
    const id = '12345678-1234-1234-1234-123456789abc';
    fs.writeFileSync(path.join(requestDir, `${id}.json`), JSON.stringify({
      method: 'supervisor.context',
      params: {},
      id,
      token: 'surface-token',
    }), 'utf8');

    const pipeServer = new PipeServer(
      '\\\\.\\pipe\\unused-file-bridge-test',
      'instance-token',
      (token) => token === 'surface-token' ? 'supervisor-surface' : undefined,
      async (surfaceId, method) => ({
        allowed: surfaceId === 'supervisor-surface' && method === 'supervisor.context',
      }),
    );
    pipeServer.on('v2', (request, respond) => respond({
      callerSurfaceId: request.params.callerSurfaceId,
      method: request.method,
    }));
    const bridge = new SupervisorFileBridge(
      runtimeRoot,
      (request, respond, respondError) => pipeServer.dispatchV2(request, respond, respondError),
    );

    await bridge.scanOnce();

    const response = JSON.parse(fs.readFileSync(path.join(responseDir, `${id}.json`), 'utf8'));
    expect(response.result).toEqual({
      callerSurfaceId: 'supervisor-surface',
      method: 'supervisor.context',
    });
    expect(fs.existsSync(path.join(requestDir, `${id}.json.processing`))).toBe(false);
  });

  it('rejects a file request without the live supervisor surface token', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-file-bridge-auth-'));
    roots.push(runtimeRoot);
    const bridgeRoot = path.join(runtimeRoot, 'lane-a', 'bridge');
    const requestDir = path.join(bridgeRoot, 'requests');
    fs.mkdirSync(requestDir, { recursive: true });
    const id = '87654321-4321-4321-4321-cba987654321';
    fs.writeFileSync(path.join(requestDir, `${id}.json`), JSON.stringify({
      method: 'supervisor.decide',
      params: { outcome: 'continue' },
      id,
      token: 'wrong-token',
    }), 'utf8');
    const pipeServer = new PipeServer('\\\\.\\pipe\\unused-file-bridge-auth', 'instance-token');
    const bridge = new SupervisorFileBridge(
      runtimeRoot,
      (request, respond, respondError) => pipeServer.dispatchV2(request, respond, respondError),
    );

    await bridge.scanOnce();

    const response = JSON.parse(fs.readFileSync(path.join(bridgeRoot, 'responses', `${id}.json`), 'utf8'));
    expect(response.error.code).toBe(-32001);
  });

  it('rejects the instance-wide token on the supervisor file bridge', async () => {
    const pipeServer = new PipeServer('\\\\.\\pipe\\unused-instance-token-test', 'instance-token');
    let result: unknown;
    let error: { code: number; message: string } | undefined;

    await pipeServer.dispatchV2(
      { method: 'agent.spawn', params: { cmd: 'calc.exe' }, token: 'instance-token' },
      (value) => { result = value; },
      (code, message) => { error = { code, message }; },
      { requireSurfaceToken: true },
    );

    expect(result).toBeUndefined();
    expect(error).toEqual({
      code: -32001,
      message: 'Unauthorized: file bridge requires a live surface capability',
    });
  });

  it('completes the CLI-side request and response lifecycle without opening a named pipe', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-file-bridge-roundtrip-'));
    roots.push(runtimeRoot);
    const bridgeRoot = path.join(runtimeRoot, 'lane-a', 'bridge');
    const pipeServer = new PipeServer(
      '\\\\.\\pipe\\unused-file-bridge-roundtrip',
      'instance-token',
      (token) => token === 'surface-token' ? 'supervisor-surface' : undefined,
    );
    pipeServer.on('v2', (request, respond) => respond({ method: request.method, ok: true }));
    const bridge = new SupervisorFileBridge(
      runtimeRoot,
      (request, respond, respondError) => pipeServer.dispatchV2(request, respond, respondError),
    );
    bridge.start();
    try {
      await expect(sendFileBridgeRequest(bridgeRoot, {
        method: 'supervisor.context',
        params: {},
        token: 'surface-token',
      }, 2_000)).resolves.toEqual({ method: 'supervisor.context', ok: true });
      expect(fs.readdirSync(path.join(bridgeRoot, 'requests'))).toEqual([]);
      expect(fs.readdirSync(path.join(bridgeRoot, 'responses'))).toEqual([]);
    } finally {
      bridge.stop();
    }
  });
});
