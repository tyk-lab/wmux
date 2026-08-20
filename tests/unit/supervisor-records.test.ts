import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendSupervisorRecord,
  listSupervisorRestoreCandidates,
  readSupervisorEvidence,
  readLatestSupervisorHistory,
  readSupervisorAuditTrail,
  saveSupervisorEvidence,
} from '../../src/main/supervisor-records';

const tempDirs: string[] = [];

function projectDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-supervisor-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('supervisor records', () => {
  it('persists paged evidence and rejects a different task terminal binding', () => {
    const project = projectDir();
    const snapshot = {
      version: 1 as const,
      sessionId: 'sup-evidence',
      reviewId: 'review-123',
      laneId: 'lane-a',
      surfaceId: 'surf-a',
      isolationScope: 'project' as const,
      task: '验证证据读取',
      capturedAt: 100,
      bufferType: 'normal' as const,
      bufferLines: 4,
      capturedLines: 4,
      truncated: false,
      summary: '摘要',
      text: ['第一行', '第二行', '第三行', '第四行'].join('\n'),
    };
    const saved = saveSupervisorEvidence({ projectDir: project, snapshot });

    expect(saved.path).toBe(path.join(
      fs.realpathSync(project),
      '.wmux',
      'supervisor',
      'sup-evidence',
      'evidence',
      'project',
      'review-123.json',
    ));
    expect(readSupervisorEvidence({
      projectDir: project,
      sessionId: 'sup-evidence',
      reviewId: 'review-123',
      surfaceId: 'surf-a',
      isolationScope: 'project',
      page: 2,
      pageLines: 2,
    })).toMatchObject({
      ok: true,
      page: 2,
      totalPages: 2,
      text: '第三行\n第四行',
    });
    expect(readSupervisorEvidence({
      projectDir: project,
      sessionId: 'sup-evidence',
      reviewId: 'review-123',
      surfaceId: 'surf-b',
      isolationScope: 'project',
    })).toEqual({ ok: false, error: 'supervisor evidence binding mismatch' });
  });

  it('bounds durable evidence retention per supervision scope', () => {
    const project = projectDir();
    for (let index = 0; index < 52; index += 1) {
      saveSupervisorEvidence({
        projectDir: project,
        snapshot: {
          version: 1,
          sessionId: 'sup-retention',
          reviewId: `review-${index}`,
          laneId: 'lane-a',
          surfaceId: 'surf-a',
          isolationScope: 'ordinary',
          task: '保留最近证据',
          capturedAt: index,
          bufferType: 'normal',
          bufferLines: 1,
          capturedLines: 1,
          truncated: false,
          summary: `摘要 ${index}`,
          text: `证据 ${index}`,
        },
      });
    }

    const evidenceDirectory = path.join(
      fs.realpathSync(project),
      '.wmux',
      'supervisor',
      'sup-retention',
      'evidence',
      'ordinary',
    );
    expect(fs.readdirSync(evidenceDirectory)).toHaveLength(50);
  });

  it('keeps duplicate terminal labels distinct by surface id and ignores the audit directory', () => {
    const project = projectDir();
    const shared = {
      sessionId: 'sup-123',
      projectDir: project,
      type: 'worker.lifecycle',
      payload: { event: 'Stop' },
    };

    appendSupervisorRecord({ ...shared, terminal: { surfaceId: 'surf-a', label: 'Codex' } });
    appendSupervisorRecord({ ...shared, terminal: { surfaceId: 'surf-b', label: 'Codex' } });

    const records = fs.readFileSync(path.join(project, '.wmux', 'supervisor', 'sup-123', 'events.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.terminal.surfaceId)).toEqual(['surf-a', 'surf-b']);
    const gitIgnore = fs.readFileSync(path.join(project, '.gitignore'), 'utf8');
    expect(gitIgnore).toContain('.wmux/supervisor/');
    expect(gitIgnore).toContain('.wmux/tmp/');
    expect(fs.existsSync(path.join(project, '.wmux', 'tmp'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.wmux', 'supervisor', 'sup-123', 'session.json'))).toBe(true);
  });

  it('restores only the exact terminal, or a uniquely identified replacement terminal', () => {
    const project = projectDir();
    appendSupervisorRecord({
      sessionId: 'sup-old', projectDir: project, type: 'worker.task', ts: 100,
      terminal: { surfaceId: 'surf-old', label: 'Codex' }, payload: { task: '修复登录' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-other', projectDir: project, type: 'worker.task', ts: 200,
      terminal: { surfaceId: 'surf-other', label: 'Codex' }, payload: { task: '不要混入' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-unique', projectDir: project, type: 'worker.task', ts: 300,
      terminal: { surfaceId: 'surf-unique-old', label: '唯一任务' }, payload: { task: '可恢复' },
    });

    const exact = readLatestSupervisorHistory(project, { surfaceId: 'surf-old', label: 'Codex' });
    expect(exact.sessionId).toBe('sup-old');
    expect(exact.events.map((event) => event.terminal.surfaceId)).toEqual(['surf-old']);

    const ambiguous = readLatestSupervisorHistory(project, { surfaceId: 'surf-new', label: 'Codex' });
    expect(ambiguous).toEqual({ sessionId: null, events: [] });

    const replacement = readLatestSupervisorHistory(project, { surfaceId: 'surf-unique-new', label: '唯一任务' });
    expect(replacement.sessionId).toBe('sup-unique');
    expect(replacement.events[0].payload.task).toBe('可恢复');
  });

  it('does not restore context after the user starts over', () => {
    const project = projectDir();
    const terminal = { surfaceId: 'surf-a', label: 'Codex' };
    appendSupervisorRecord({
      sessionId: 'sup-reset', projectDir: project, type: 'worker.task', ts: 100,
      terminal, payload: { task: '旧任务' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-reset', projectDir: project, type: 'session.abandoned', ts: 110,
      terminal, payload: { reason: '用户选择重头再来' },
    });

    expect(readLatestSupervisorHistory(project, { surfaceId: 'surf-new', label: 'Codex' }))
      .toEqual({ sessionId: null, events: [] });
  });

  it('lists and restores new context recorded after the latest start-over boundary', () => {
    const project = projectDir();
    const terminal = { surfaceId: 'surf-a', label: 'Codex' };
    appendSupervisorRecord({
      sessionId: 'sup-old', projectDir: project, type: 'worker.task', ts: 100,
      terminal, payload: { task: '废除前任务' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-reset', projectDir: project, type: 'session.abandoned', ts: 200,
      terminal, payload: { reason: '用户选择重头再来' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-new', projectDir: project, type: 'worker.task', ts: 300,
      terminal, payload: { task: '废除后新任务' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-new', projectDir: project, type: 'supervisor.decision', ts: 310,
      terminal, payload: { outcome: 'continue', reason: '继续新任务' },
    });

    expect(listSupervisorRestoreCandidates(project)).toEqual([{
      surfaceId: 'surf-a',
      label: 'Codex',
      sessionId: 'sup-new',
      lastEventAt: 310,
      currentTask: '废除后新任务',
      lastDecision: 'continue',
    }]);
    const restored = readLatestSupervisorHistory(project, terminal);
    expect(restored.sessionId).toBe('sup-new');
    expect(restored.events.map((event) => event.payload.task).filter(Boolean)).toEqual(['废除后新任务']);
  });

  it('restores only events after a start-over marker within the same audit session', () => {
    const project = projectDir();
    const terminal = { surfaceId: 'surf-a', label: 'Codex' };
    appendSupervisorRecord({
      sessionId: 'sup-reused', projectDir: project, type: 'worker.task', ts: 100,
      terminal, payload: { task: '旧任务' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-reused', projectDir: project, type: 'session.abandoned', ts: 200,
      terminal, payload: {},
    });
    appendSupervisorRecord({
      sessionId: 'sup-reused', projectDir: project, type: 'worker.task', ts: 300,
      terminal, payload: { task: '新任务' },
    });

    const restored = readLatestSupervisorHistory(project, terminal);
    expect(restored.sessionId).toBe('sup-reused');
    expect(restored.events.map((event) => event.payload.task).filter(Boolean)).toEqual(['新任务']);
  });

  it('lists every matching audit session without mixing terminals that share a label', () => {
    const project = projectDir();
    appendSupervisorRecord({
      sessionId: 'sup-first', projectDir: project, type: 'worker.task', ts: 100,
      terminal: { surfaceId: 'surf-a', label: 'Codex' }, payload: { task: '第一个任务' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-second', projectDir: project, type: 'supervisor.decision', ts: 200,
      terminal: { surfaceId: 'surf-a', label: 'Codex' }, payload: { outcome: 'complete', reason: '已完成' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-other', projectDir: project, type: 'worker.task', ts: 300,
      terminal: { surfaceId: 'surf-b', label: 'Codex' }, payload: { task: '不得混入' },
    });

    const trail = readSupervisorAuditTrail(project, { surfaceId: 'surf-a', label: 'Codex' });
    expect(trail.sessions.map((session) => session.sessionId)).toEqual(['sup-second', 'sup-first']);
    expect(trail.sessions.flatMap((session) => session.events.map((event) => event.terminal.surfaceId)))
      .toEqual(['surf-a', 'surf-a']);
  });

  it('keeps reset markers visible in the audit trail while blocking ambiguous fallback', () => {
    const project = projectDir();
    const terminal = { surfaceId: 'surf-a', label: 'Codex' };
    appendSupervisorRecord({
      sessionId: 'sup-reset', projectDir: project, type: 'worker.task', ts: 100,
      terminal, payload: { task: '旧任务' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-reset', projectDir: project, type: 'session.abandoned', ts: 110,
      terminal, payload: { reason: '用户选择重头再来' },
    });

    const trail = readSupervisorAuditTrail(project, terminal);
    expect(trail.sessions[0].events.map((event) => event.type))
      .toEqual(['worker.task', 'session.abandoned']);
    expect(readSupervisorAuditTrail(project, { surfaceId: 'surf-new', label: 'Codex' }))
      .toEqual({ sessions: [{ sessionId: 'sup-reset', createdAt: 100, events: trail.sessions[0].events }] });
  });

  it('lists explicit restore sources without comparing them to a newly selected terminal id', () => {
    const project = projectDir();
    appendSupervisorRecord({
      sessionId: 'sup-auth', projectDir: project, type: 'worker.task', ts: 100,
      terminal: { surfaceId: 'surf-auth-old', label: '认证任务' }, payload: { task: '修复登录' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-auth', projectDir: project, type: 'supervisor.decision', ts: 110,
      terminal: { surfaceId: 'surf-auth-old', label: '认证任务' }, payload: { outcome: 'rework' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-reset', projectDir: project, type: 'worker.task', ts: 120,
      terminal: { surfaceId: 'surf-discarded', label: '废除任务' }, payload: { task: '旧内容' },
    });
    appendSupervisorRecord({
      sessionId: 'sup-reset', projectDir: project, type: 'session.abandoned', ts: 130,
      terminal: { surfaceId: 'surf-discarded', label: '废除任务' }, payload: {},
    });

    expect(listSupervisorRestoreCandidates(project)).toEqual([{
      surfaceId: 'surf-auth-old',
      label: '认证任务',
      sessionId: 'sup-auth',
      lastEventAt: 110,
      currentTask: '修复登录',
      lastDecision: 'rework',
    }]);
  });
});
