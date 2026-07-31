import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendSupervisorRecord,
  readLatestSupervisorHistory,
  readSupervisorAuditTrail,
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
    expect(fs.readFileSync(path.join(project, '.gitignore'), 'utf8')).toContain('.wmux/supervisor/');
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
});
