import fs from 'fs';
import path from 'path';
import {
  MAX_PROJECT_PLAN_FILE_BYTES,
  MAX_PROJECT_PLAN_FILES,
  type ProjectPlanFileSnapshot,
} from '../shared/project-manager';

const PLAN_FILE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml']);

export const PROJECT_PLAN_FILE_DIALOG_EXTENSIONS = ['md', 'txt', 'json', 'yaml', 'yml'];

export type CaptureProjectPlanFilesResult =
  | { ok: true; files: ProjectPlanFileSnapshot[] }
  | { ok: false; error: string };

export function captureProjectPlanFiles(filePaths: unknown): CaptureProjectPlanFilesResult {
  if (!Array.isArray(filePaths)) return { ok: false, error: '计划文件路径必须是数组' };
  const uniquePaths = new Map<string, string>();
  for (const value of filePaths) {
    const filePath = String(value || '').trim();
    const key = path.normalize(filePath).toLowerCase();
    if (filePath && !uniquePaths.has(key)) uniquePaths.set(key, filePath);
  }
  const paths = [...uniquePaths.values()];
  if (paths.length > MAX_PROJECT_PLAN_FILES) {
    return { ok: false, error: `计划文件最多 ${MAX_PROJECT_PLAN_FILES} 个` };
  }
  const files: ProjectPlanFileSnapshot[] = [];
  try {
    for (const filePath of paths) {
      if (!path.isAbsolute(filePath)) throw new Error(`计划文件必须使用绝对路径：${filePath}`);
      if (!PLAN_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        throw new Error(`不支持的计划文件格式：${path.basename(filePath)}`);
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error(`计划文件不存在或不是普通文件：${filePath}`);
      if (stat.size > MAX_PROJECT_PLAN_FILE_BYTES) {
        throw new Error(`计划文件超过 1 MB：${path.basename(filePath)}`);
      }
      const bytes = fs.readFileSync(filePath);
      if (bytes.includes(0)) throw new Error(`计划文件不是纯文本：${path.basename(filePath)}`);
      let content = '';
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`计划文件必须使用 UTF-8 编码：${path.basename(filePath)}`);
      }
      files.push({
        path: filePath,
        name: path.basename(filePath),
        content,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        capturedAt: Date.now(),
      });
    }
    return { ok: true, files };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || error) };
  }
}
