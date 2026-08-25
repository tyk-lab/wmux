import fs from 'fs';
import path from 'path';
import type { V2Request, V2Response } from './pipe-server';

type DispatchV2 = (
  request: V2Request,
  respond: (result: any) => void,
  respondError: (code: number, message: string) => void,
) => void | Promise<void>;

const REQUEST_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/iu;
const MAX_REQUEST_BYTES = 1_000_000;

/** Host-side relay for sandboxed supervisor Agents that cannot open Windows named pipes. */
export class SupervisorFileBridge {
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(
    private readonly runtimeRoot: string,
    private readonly dispatch: DispatchV2,
  ) {}

  start(): void {
    if (this.timer) return;
    fs.mkdirSync(this.runtimeRoot, { recursive: true });
    void this.scanOnce();
    this.timer = setInterval(() => void this.scanOnce(), 100);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scanOnce(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    const pending: Promise<void>[] = [];
    try {
      const runtimeEntries = fs.readdirSync(this.runtimeRoot, { withFileTypes: true });
      for (const runtimeEntry of runtimeEntries) {
        if (!runtimeEntry.isDirectory()) continue;
        const bridgeRoot = path.join(this.runtimeRoot, runtimeEntry.name, 'bridge');
        const requestDir = path.join(bridgeRoot, 'requests');
        let requestEntries: fs.Dirent[];
        try {
          requestEntries = fs.readdirSync(requestDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const requestEntry of requestEntries) {
          const match = requestEntry.isFile() ? REQUEST_NAME.exec(requestEntry.name) : null;
          if (!match) continue;
          const requestPath = path.join(requestDir, requestEntry.name);
          const claimedPath = `${requestPath}.processing`;
          try {
            fs.renameSync(requestPath, claimedPath);
          } catch {
            continue;
          }
          pending.push(this.processClaimedRequest(bridgeRoot, claimedPath, match[1]));
        }
      }
    } finally {
      this.scanning = false;
    }
    await Promise.all(pending);
  }

  private async processClaimedRequest(bridgeRoot: string, claimedPath: string, id: string): Promise<void> {
    const responseDir = path.join(bridgeRoot, 'responses');
    const responsePath = path.join(responseDir, `${id}.json`);
    const temporaryResponsePath = `${responsePath}.tmp`;
    const writeResponse = (response: V2Response) => {
      fs.mkdirSync(responseDir, { recursive: true });
      const serialized = JSON.stringify(response);
      fs.writeFileSync(temporaryResponsePath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporaryResponsePath, responsePath);
    };

    try {
      const stat = fs.statSync(claimedPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_REQUEST_BYTES) {
        writeResponse({ error: { code: -32600, message: 'Invalid file bridge request size' }, id });
        return;
      }
      const request = JSON.parse(fs.readFileSync(claimedPath, 'utf8')) as V2Request;
      request.id = id;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (response: V2Response) => {
          if (settled) return;
          settled = true;
          try { writeResponse(response); } finally { resolve(); }
        };
        const timer = setTimeout(() => finish({
          error: { code: -32000, message: 'File bridge request timed out' },
          id,
        }), 30_000);
        const settle = (response: V2Response) => {
          clearTimeout(timer);
          finish(response);
        };
        Promise.resolve(this.dispatch(
          request,
          (result) => settle({ result, id }),
          (code, message) => settle({ error: { code, message }, id }),
        )).catch((error) => settle({
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          id,
        }));
      });
    } catch (error) {
      try {
        writeResponse({
          error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
          id,
        });
      } catch { /* the client will time out if its response directory is unavailable */ }
    } finally {
      try { fs.rmSync(claimedPath, { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(temporaryResponsePath, { force: true }); } catch { /* best effort */ }
    }
  }
}
