import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { captureProjectProgress } from './project-progress-sync';
import {
  SUPERVISED_TERMINAL_SNAPSHOT_VERSION,
  type CaptureSupervisedTerminalProjectContextRequest,
  type SupervisedTerminalSnapshot,
  type SupervisedTerminalSnapshotSummary,
} from '../shared/supervisor-recovery';

const SNAPSHOT_ID = /^snapshot-[A-Za-z0-9_-]{8,100}$/u;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_SCREEN_TAIL_CHARS = 24_000;

function projectRoot(projectDir: string): string {
  if (!path.isAbsolute(projectDir)) throw new Error('恢复档案项目目录必须是绝对路径');
  const resolved = fs.realpathSync(projectDir);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('恢复档案项目目录不可用');
  return resolved;
}

function recoveryDirectory(projectDir: string, create = false): string {
  const root = projectRoot(projectDir);
  const directory = path.join(root, '.wmux', 'supervisor', 'recovery');
  if (create) fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(directory)) return directory;
  const resolved = fs.realpathSync(directory);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('恢复档案目录必须位于项目内部');
  }
  return resolved;
}

function snapshotPath(projectDir: string, snapshotId: string, create = false): string {
  if (!SNAPSHOT_ID.test(snapshotId)) throw new Error('恢复档案 ID 无效');
  return path.join(recoveryDirectory(projectDir, create), `${snapshotId}.json`);
}

function checksumFor(snapshot: SupervisedTerminalSnapshot): string {
  const { checksum: _checksum, ...content } = snapshot;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function normalizeSnapshot(value: unknown, requireChecksum = false): SupervisedTerminalSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('恢复档案格式无效');
  const snapshot = value as SupervisedTerminalSnapshot;
  if (snapshot.version !== SUPERVISED_TERMINAL_SNAPSHOT_VERSION) throw new Error('恢复档案版本不受支持');
  if (!SNAPSHOT_ID.test(String(snapshot.snapshotId || ''))) throw new Error('恢复档案 ID 无效');
  if (!Number.isFinite(snapshot.savedAt) || snapshot.savedAt <= 0) throw new Error('恢复档案保存时间无效');
  if (!snapshot.terminal || !snapshot.supervisor || !snapshot.projectContext || !snapshot.consistency) {
    throw new Error('恢复档案缺少终端、监督或项目上下文');
  }
  if (!path.isAbsolute(String(snapshot.terminal.projectDir || ''))) throw new Error('恢复档案项目目录无效');
  if (!snapshot.terminal.surfaceId || !snapshot.terminal.label || !snapshot.consistency.laneId) {
    throw new Error('恢复档案缺少终端或监督绑定');
  }
  if (String(snapshot.terminal.screenTail || '').length > MAX_SCREEN_TAIL_CHARS
    || String(snapshot.projectContext.terminalScreenTail || '').length > MAX_SCREEN_TAIL_CHARS) {
    throw new Error('恢复档案终端现场过大');
  }
  if (requireChecksum && !snapshot.checksum) throw new Error('恢复档案缺少完整性校验');
  if (snapshot.checksum && snapshot.checksum !== checksumFor(snapshot)) throw new Error('恢复档案校验失败');
  return snapshot;
}

export function captureSupervisedTerminalProjectContext(
  request: CaptureSupervisedTerminalProjectContextRequest,
): { ok: true; projectContext: SupervisedTerminalSnapshot['projectContext'] } | { ok: false; error: string } {
  const projectDir = String(request?.projectDir || '').trim();
  const planFilePaths = Array.isArray(request?.planFilePaths)
    ? request.planFilePaths.map((value) => String(value || '').trim()).filter(path.isAbsolute).slice(0, 3)
    : [];
  const captured = captureProjectProgress(projectDir, planFilePaths);
  if (captured.ok === false) return captured;
  return {
    ok: true,
    projectContext: {
      capturedAt: captured.snapshot.capturedAt,
      planFilePaths,
      progressSnapshot: captured.snapshot,
      currentTask: String(request?.currentTask || '').trim().slice(0, 8_000),
      verifiedEvidence: Array.isArray(request?.verifiedEvidence)
        ? request.verifiedEvidence.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 100)
        : [],
      acceptanceGaps: Array.isArray(request?.acceptanceGaps)
        ? request.acceptanceGaps.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 100)
        : [],
      terminalScreenTail: String(request?.terminalScreenTail || '').slice(-MAX_SCREEN_TAIL_CHARS),
    },
  };
}

export function saveSupervisedTerminalSnapshot(value: unknown): { ok: true; snapshot: SupervisedTerminalSnapshot } {
  const normalized = normalizeSnapshot(value);
  const existing = listSupervisedTerminalSnapshots(normalized.terminal.projectDir)
    .find((snapshot) => snapshot.surfaceId === normalized.terminal.surfaceId);
  const saved: SupervisedTerminalSnapshot = {
    ...normalized,
    snapshotId: existing?.snapshotId || normalized.snapshotId,
    savedAt: Date.now(),
    terminal: {
      ...normalized.terminal,
      screenTail: normalized.terminal.screenTail.slice(-MAX_SCREEN_TAIL_CHARS),
    },
    projectContext: {
      ...normalized.projectContext,
      terminalScreenTail: normalized.projectContext.terminalScreenTail.slice(-MAX_SCREEN_TAIL_CHARS),
    },
    checksum: undefined,
  };
  saved.checksum = checksumFor(saved);
  const serialized = `${JSON.stringify(saved, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error('恢复档案超过 4 MiB');
  const target = snapshotPath(saved.terminal.projectDir, saved.snapshotId, true);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* Best-effort cleanup. */ }
  }
  return { ok: true, snapshot: saved };
}

export function readSupervisedTerminalSnapshot(
  projectDir: string,
  snapshotId: string,
): { ok: true; snapshot: SupervisedTerminalSnapshot } | { ok: false; error: string } {
  try {
    const filePath = snapshotPath(projectDir, snapshotId);
    const stat = fs.lstatSync(filePath);
    const resolvedFile = fs.realpathSync(filePath);
    const directory = recoveryDirectory(projectDir);
    const relativeFile = path.relative(directory, resolvedFile);
    if (!stat.isFile() || relativeFile.startsWith('..') || path.isAbsolute(relativeFile)
      || stat.size > MAX_SNAPSHOT_BYTES) {
      return { ok: false, error: '恢复档案不存在、越界或过大' };
    }
    const snapshot = normalizeSnapshot(JSON.parse(fs.readFileSync(resolvedFile, 'utf8')), true);
    if (path.resolve(snapshot.terminal.projectDir).toLowerCase() !== projectRoot(projectDir).toLowerCase()) {
      return { ok: false, error: '恢复档案项目绑定不匹配' };
    }
    return { ok: true, snapshot };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || error) };
  }
}

export function listSupervisedTerminalSnapshots(projectDir: string): SupervisedTerminalSnapshotSummary[] {
  try {
    const directory = recoveryDirectory(projectDir);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.json')) return [];
      const snapshotId = entry.name.slice(0, -5);
      if (!SNAPSHOT_ID.test(snapshotId)) return [];
      const loaded = readSupervisedTerminalSnapshot(projectDir, snapshotId);
      if (loaded.ok === false) return [];
      const { snapshot } = loaded;
      const decisions = Array.isArray(snapshot.supervisor.state.decisions)
        ? snapshot.supervisor.state.decisions as Array<Record<string, unknown>>
        : [];
      return [{
        snapshotId,
        savedAt: snapshot.savedAt,
        projectDir: snapshot.terminal.projectDir,
        surfaceId: snapshot.terminal.surfaceId,
        label: snapshot.terminal.label,
        workspaceTitle: snapshot.terminal.workspaceTitle,
        currentTask: snapshot.supervisor.state.currentTask,
        lastDecision: String(decisions[0]?.outcome || ''),
        supervisorAgent: snapshot.supervisor.launchCmd,
        supervisorModel: snapshot.supervisor.model,
        supervisorReasoningEffort: snapshot.supervisor.reasoningEffort,
        config: snapshot.supervisor.config,
        autonomous: snapshot.supervisor.autonomous,
        autonomyPermissions: snapshot.supervisor.autonomyPermissions,
        forbiddenActions: snapshot.supervisor.forbiddenActions,
        workScope: snapshot.supervisor.workScope,
        controlState: snapshot.supervisor.state.controlState,
      }];
    }).sort((left, right) => right.savedAt - left.savedAt);
  } catch {
    return [];
  }
}

export function deleteSupervisedTerminalSnapshot(
  projectDir: string,
  snapshotId: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const filePath = snapshotPath(projectDir, snapshotId);
    fs.unlinkSync(filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || error) };
  }
}
