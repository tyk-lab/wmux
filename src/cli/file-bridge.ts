import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface FileBridgeRequest {
  method: string;
  params: Record<string, any>;
  id: string;
  token: string;
}

interface FileBridgeResponse {
  result?: any;
  error?: { code: number; message: string };
  id?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Send one authenticated V2 request through the app-owned supervisor runtime directory. */
export async function sendFileBridgeRequest(
  bridgeRoot: string,
  request: Omit<FileBridgeRequest, 'id'>,
  timeoutMs: number,
): Promise<any> {
  const resolvedRoot = path.resolve(bridgeRoot);
  if (!path.isAbsolute(resolvedRoot)) throw new Error('监督文件桥接目录必须是绝对路径');
  const requestDir = path.join(resolvedRoot, 'requests');
  const responseDir = path.join(resolvedRoot, 'responses');
  fs.mkdirSync(requestDir, { recursive: true });
  fs.mkdirSync(responseDir, { recursive: true });

  const id = crypto.randomUUID();
  const requestPath = path.join(requestDir, `${id}.json`);
  const temporaryPath = path.join(requestDir, `${id}.tmp`);
  const responsePath = path.join(responseDir, `${id}.json`);
  const serialized = JSON.stringify({ ...request, id });
  if (Buffer.byteLength(serialized, 'utf8') > 1_000_000) throw new Error('监督文件桥接请求过大');
  fs.writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.renameSync(temporaryPath, requestPath);

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      try {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf8')) as FileBridgeResponse;
        if (response.error) throw new Error(response.error.message);
        return response.result;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await delay(50);
    }
    throw new Error('timeout');
  } finally {
    try { fs.rmSync(responsePath, { force: true }); } catch { /* main process also cleans stale files */ }
    try { fs.rmSync(requestPath, { force: true }); } catch { /* request may already be claimed */ }
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort after partial write */ }
  }
}
