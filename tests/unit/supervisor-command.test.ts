import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupSupervisorNextInput, isSupervisorDecideHelp, resolveSupervisorNextInput, SUPERVISOR_DECIDE_USAGE } from '../../src/cli/supervisor-command';

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
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--outcome <continue|rework|complete|needs-human>');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('--next-file <.wmux/tmp/file>');
    expect(SUPERVISOR_DECIDE_USAGE).toContain('context-recovery');
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
