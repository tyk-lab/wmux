import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { PipeServer } from '../../src/main/pipe-server';

// Each test gets a unique pipe name to avoid reuse conflicts on Windows
let testCounter = 0;
function uniquePipe(): string {
  return `\\\\.\\pipe\\wmux-test-${process.pid}-${++testCounter}`;
}

function connectAndSend(pipePath: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ path: pipePath }, () => {
      client.write(message + '\n');
    });
    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        client.end();
        resolve(data.trim());
      }
    });
    client.on('error', reject);
    setTimeout(() => { client.end(); reject(new Error('timeout')); }, 3000);
  });
}

describe('PipeServer', () => {
  let server: PipeServer;

  afterEach(() => {
    server?.stop();
  });

  it('responds to V1 ping', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe);
    server.start();
    await new Promise(r => setTimeout(r, 200)); // wait for server to start

    const response = await connectAndSend(pipe, 'ping');
    expect(response).toBe('pong');
  });

  it('parses authenticated V1 commands', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'test-token');
    const commands: any[] = [];
    server.on('v1', (cmd) => commands.push(cmd));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, 'auth test-token report_pwd surf-123 C:\\Users\\test');
    expect(response).toBe('ok');
    expect(commands.length).toBe(1);
    expect(commands[0].command).toBe('report_pwd');
    expect(commands[0].surfaceId).toBe('surf-123');
    expect(commands[0].args).toEqual(['C:\\Users\\test']);
  });

  it('rejects V1 state updates without a token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    const commands: any[] = [];
    server.on('v1', (cmd) => commands.push(cmd));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, 'notify surf-123 agent needs your password');
    expect(response).toBe('unauthorized');
    expect(commands.length).toBe(0);
  });

  it('rejects V1 state updates with a wrong token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    const commands: any[] = [];
    server.on('v1', (cmd) => commands.push(cmd));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, 'auth wrong report_pwd surf-123 C:\\evil');
    expect(response).toBe('unauthorized');
    expect(commands.length).toBe(0);
  });

  it('handles V2 JSON-RPC', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'test-token');
    server.on('v2', (req, respond) => {
      if (req.method === 'workspace.list') {
        respond({ workspaces: [] });
      }
    });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'workspace.list',
      params: {},
      id: 1,
      token: 'test-token',
    }));
    const parsed = JSON.parse(response);
    expect(parsed.result.workspaces).toEqual([]);
    expect(parsed.id).toBe(1);
  });

  it('returns error for unknown V2 method', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'test-token');
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'unknown.method',
      params: {},
      id: 2,
      token: 'test-token',
    }));
    const parsed = JSON.parse(response);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe(-32601);
  });

  it('rejects privileged V2 methods without a token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    let handlerCalled = false;
    server.on('v2', (req, respond) => { handlerCalled = true; respond({ ok: true }); });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'agent.spawn',
      params: { cmd: 'calc.exe' },
      id: 3,
    }));
    const parsed = JSON.parse(response);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe(-32001);
    expect(handlerCalled).toBe(false);
  });

  it('rejects privileged V2 methods with a wrong token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.on('v2', (req, respond) => respond({ ok: true }));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'browser.eval',
      params: { js: '1+1' },
      id: 4,
      token: 'wrong',
    }));
    const parsed = JSON.parse(response);
    expect(parsed.error.code).toBe(-32001);
  });

  it('allows privileged V2 methods with the correct token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.on('v2', (req, respond) => respond({ ok: true }));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'agent.spawn',
      params: { cmd: 'echo hi' },
      id: 5,
      token: 'secret',
    }));
    const parsed = JSON.parse(response);
    expect(parsed.result).toEqual({ ok: true });
  });

  it('allows public V2 methods without a token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.on('v2', (req, respond) => {
      if (req.method === 'system.identify') respond({ name: 'wmux' });
    });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'system.identify',
      params: {},
      id: 6,
    }));
    const parsed = JSON.parse(response);
    expect(parsed.result.name).toBe('wmux');
  });

  it('still accepts unauthenticated V1 ping', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, 'ping');
    expect(response).toBe('pong');
  });

  it('rejects hook.event and agent.activity without a token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    let handlerCalled = false;
    server.on('v2', (req, respond) => { handlerCalled = true; respond({ ok: true }); });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    for (const method of ['hook.event', 'agent.activity']) {
      const response = await connectAndSend(pipe, JSON.stringify({
        method,
        params: { surfaceId: 'surf-victim', done: true, tool: 'Edit' },
        id: 7,
      }));
      const parsed = JSON.parse(response);
      expect(parsed.error?.code).toBe(-32001);
    }
    expect(handlerCalled).toBe(false);
  });

  it('allows hook.event and agent.activity with the correct token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.on('v2', (req, respond) => respond({ ok: true }));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    for (const method of ['hook.event', 'agent.activity']) {
      const response = await connectAndSend(pipe, JSON.stringify({
        method,
        params: { surfaceId: 'surf-1', tool: 'Edit' },
        id: 8,
        token: 'secret',
      }));
      const parsed = JSON.parse(response);
      expect(parsed.result).toEqual({ ok: true });
    }
  });

  it('binds a surface capability to its real caller identity', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(
      pipe,
      'instance-secret',
      (token) => token === 'surface-secret' ? 'surf-manager' : undefined,
    );
    let received: any;
    server.on('v2', (req, respond) => {
      received = req;
      respond({ ok: true });
    });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'project.status',
      params: { callerSurfaceId: 'surf-forged' },
      id: 9,
      token: 'surface-secret',
    }));
    expect(JSON.parse(response).result).toEqual({ ok: true });
    expect(received.params.callerSurfaceId).toBe('surf-manager');
  });

  it('does not let the instance-wide token impersonate a project AI surface', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(
      pipe,
      'instance-secret',
      (token) => token === 'surface-secret' ? 'surf-manager' : undefined,
    );
    let handlerCalled = false;
    server.on('v2', (_req, respond) => {
      handlerCalled = true;
      respond({ ok: true });
    });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'project.status',
      params: { callerSurfaceId: 'surf-manager' },
      id: 10,
      token: 'instance-secret',
    }));
    expect(JSON.parse(response).error?.code).toBe(-32001);
    expect(handlerCalled).toBe(false);
  });

  it('requires a live surface capability for supervisor context and binds its caller', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(
      pipe,
      'instance-secret',
      (token) => token === 'supervisor-secret' ? 'surf-supervisor' : undefined,
    );
    let received: any;
    server.on('v2', (req, respond) => {
      received = req;
      respond({ ok: true });
    });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const rejected = await connectAndSend(pipe, JSON.stringify({
      method: 'supervisor.context',
      params: { callerSurfaceId: 'surf-forged' },
      id: 11,
      token: 'instance-secret',
    }));
    expect(JSON.parse(rejected).error?.code).toBe(-32001);

    const accepted = await connectAndSend(pipe, JSON.stringify({
      method: 'supervisor.context',
      params: { callerSurfaceId: 'surf-forged' },
      id: 12,
      token: 'supervisor-secret',
    }));
    expect(JSON.parse(accepted).result).toEqual({ ok: true });
    expect(received.params.callerSurfaceId).toBe('surf-supervisor');
  });

  it('rejects V1 spoofing with another surface capability', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(
      pipe,
      'instance-secret',
      (token) => token === 'surface-secret' ? 'surf-owner' : undefined,
    );
    const commands: any[] = [];
    server.on('v1', (cmd) => commands.push(cmd));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    expect(await connectAndSend(
      pipe,
      'auth surface-secret report_pwd surf-other C:\\forged',
    )).toBe('unauthorized');
    expect(commands).toEqual([]);
    expect(await connectAndSend(
      pipe,
      'auth surface-secret report_pwd surf-owner C:\\valid',
    )).toBe('ok');
    expect(commands[0]).toMatchObject({ surfaceId: 'surf-owner', args: ['C:\\valid'] });
  });
});
