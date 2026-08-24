import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupSupervisorNextInput,
  cleanupSupervisorCompletionInput,
  cleanupSupervisorStagePlanInput,
  isSupervisorDecideHelp,
  resolveSupervisorNextInput,
  resolveSupervisorCompletionInput,
  resolveSupervisorStagePlanInput,
  SUPERVISOR_DECIDE_USAGE,
} from '../../src/cli/supervisor-command';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function projectDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-supervisor-command-'));
  tempDirs.push(directory);
  return directory;
}

describe('supervisor decide command', () => {
  it('recognizes help before validating required decision arguments', () => {
    expect(isSupervisorDecideHelp(['supervisor', 'decide', '--help'])).toBe(true);
    expect(isSupervisorDecideHelp(['supervisor', 'decide', '-h'])).toBe(true);
    expect(isSupervisorDecideHelp(['supervisor', 'decide'])).toBe(false);
  });

  it('documents the required decision arguments', () => {
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--surface <id>');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--review-id <id>');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--outcome <continue|rework|complete|needs-human>');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--next-file <.wmux/tmp/file>');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--stage-plan-file <.wmux/tmp/file>');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--completion-file <.wmux/tmp/file>');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('context-recovery');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('direction-needed');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--completion-stop-when <1,2,...>');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--remaining-work <none|text>');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--retry-kind <task-failure|command-correction|runtime-recovery|execution-window>');
  });

  it('reads and cleans structured completion evidence from .wmux/tmp', () => {
    const project = projectDir();
    const tempDirectory = path.join(project, '.wmux', 'tmp');
    const draftPath = path.join(tempDirectory, 'completion.json');
    fs.mkdirSync(tempDirectory, { recursive: true });
    fs.writeFileSync(draftPath, JSON.stringify({
      stopWhen: [{
        index: 1, status: 'satisfied', result: 'failed', method: 'runtime-test',
        evidence: '已执行并形成明确失败结论', evidenceRefs: ['runs/run-1/result.json'],
      }],
      validation: [{
        index: 1, status: 'satisfied', result: 'passed', method: 'evidence-review',
        evidence: '验证证据已复核', evidenceRefs: ['runs/run-1/result.json'],
      }],
      remainingWork: [],
    }), 'utf8');

    const input = resolveSupervisorCompletionInput([
      'supervisor', 'decide', '--completion-file', '.wmux/tmp/completion.json',
    ], project);

    expect(input.value).toMatchObject({ remainingWork: [] });
    expect(input.fileReference).toBe('.wmux/tmp/completion.json');
    cleanupSupervisorCompletionInput(input, true);
    expect(fs.existsSync(draftPath)).toBe(false);
  });

  it('reads and cleans a structured supervisor stage plan from .wmux/tmp', () => {
    const project = projectDir();
    const tempDirectory = path.join(project, '.wmux', 'tmp');
    const draftPath = path.join(tempDirectory, 'stage-plan.json');
    fs.mkdirSync(tempDirectory, { recursive: true });
    fs.writeFileSync(draftPath, JSON.stringify({
      selectedRoute: '保持当前路线',
      milestones: [{ id: 'verify', title: '验证', outcome: '验证通过', status: 'active' }],
    }), 'utf8');

    const input = resolveSupervisorStagePlanInput([
      'supervisor', 'decide', '--stage-plan-file', '.wmux/tmp/stage-plan.json',
    ], project);

    expect(input.value).toMatchObject({ selectedRoute: '保持当前路线' });
    expect(input.fileReference).toBe('.wmux/tmp/stage-plan.json');
    cleanupSupervisorStagePlanInput(input, true);
    expect(fs.existsSync(draftPath)).toBe(false);
  });

  it('reads long next text only from .wmux/tmp and removes it through the cleanup callback', () => {
    const project = projectDir();
    const tempDirectory = path.join(project, '.wmux', 'tmp');
    const draftPath = path.join(tempDirectory, 'context-recovery-1.txt');
    fs.mkdirSync(tempDirectory, { recursive: true });
    fs.writeFileSync(draftPath, '第一行\n第二行', 'utf8');

    const input = resolveSupervisorNextInput([
      'supervisor', 'decide', '--next-file', '.wmux/tmp/context-recovery-1.txt',
    ], project);

    expect(input.text).toBe('第一行\n第二行');
    expect(input.fileReference).toBe('.wmux/tmp/context-recovery-1.txt');
    expect(fs.existsSync(draftPath)).toBe(true);
    cleanupSupervisorNextInput(input, false);
    expect(fs.existsSync(draftPath)).toBe(true);
    cleanupSupervisorNextInput(input, true);
    expect(fs.existsSync(draftPath)).toBe(false);
  });

  it('rejects root-level drafts and ambiguous next sources', () => {
    const project = projectDir();
    const rootDraft = path.join(project, '.tmp-supervisor-next.txt');
    fs.writeFileSync(rootDraft, '不得读取', 'utf8');

    expect(() => resolveSupervisorNextInput([
      'supervisor', 'decide', '--next-file', '.tmp-supervisor-next.txt',
    ], project)).toThrow('.wmux/tmp/');
    expect(() => resolveSupervisorNextInput([
      'supervisor', 'decide', '--next', '短文本', '--next-file', '.wmux/tmp/next.txt',
    ], project)).toThrow('cannot be used together');
  });
});
