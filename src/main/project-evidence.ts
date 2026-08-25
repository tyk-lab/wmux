import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { projectArtifactLocationViolation } from '../shared/project-artifact-policy';

const MAX_EVIDENCE_REFS = 50;
const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 32 * 1024 * 1024;

export interface VerifiedProjectEvidenceRef {
  ref: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

export interface VerifyProjectEvidenceRefsResult {
  ok: boolean;
  entries?: VerifiedProjectEvidenceRef[];
  error?: string;
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !!relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/** Resolve and hash bounded evidence files without following a path outside the managed project. */
export function verifyProjectEvidenceRefs(
  projectDirValue: unknown,
  refsValue: unknown,
): VerifyProjectEvidenceRefsResult {
  const projectDir = String(projectDirValue || '').trim();
  const refs = [...new Set((Array.isArray(refsValue) ? refsValue : [])
    .map((value) => String(value || '').trim().replace(/\\/g, '/'))
    .filter(Boolean))];
  if (!path.isAbsolute(projectDir)) return { ok: false, error: '项目证据根目录必须是绝对路径' };
  if (refs.length === 0 || refs.length > MAX_EVIDENCE_REFS) {
    return { ok: false, error: `实际证据引用必须包含 1-${MAX_EVIDENCE_REFS} 个项目内文件` };
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(projectDir);
  } catch {
    return { ok: false, error: '项目证据根目录不存在或不可读' };
  }
  const entries: VerifiedProjectEvidenceRef[] = [];
  let totalBytes = 0;
  for (const ref of refs) {
    const placementViolation = projectArtifactLocationViolation(ref);
    if (placementViolation) return { ok: false, error: `证据产物落位不合规：${placementViolation}` };
    if (path.isAbsolute(ref) || ref.split('/').some((part) => part === '..' || part === '')) {
      return { ok: false, error: `证据引用必须是项目内规范相对文件路径：${ref}` };
    }
    const requested = path.resolve(realRoot, ...ref.split('/'));
    let realFile: string;
    let stat: fs.Stats;
    try {
      realFile = fs.realpathSync(requested);
      stat = fs.statSync(realFile);
    } catch {
      return { ok: false, error: `证据文件不存在或不可读：${ref}` };
    }
    if (!insideRoot(realRoot, realFile)) return { ok: false, error: `证据文件越出项目目录：${ref}` };
    if (!stat.isFile()) return { ok: false, error: `证据引用必须指向普通文件，不能只引用目录：${ref}` };
    if (stat.size <= 0) return { ok: false, error: `证据文件为空：${ref}` };
    if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
      return { ok: false, error: `证据文件超过 ${MAX_EVIDENCE_FILE_BYTES} 字节；请引用有界结构化结果或摘要：${ref}` };
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_EVIDENCE_BYTES) {
      return { ok: false, error: `实际证据总量超过 ${MAX_TOTAL_EVIDENCE_BYTES} 字节；请减少为最小充分结果文件` };
    }
    entries.push({
      ref,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(realFile)).digest('hex'),
    });
  }
  return { ok: true, entries };
}
