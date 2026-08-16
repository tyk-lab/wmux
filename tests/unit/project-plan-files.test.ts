import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureProjectPlanFiles } from '../../src/main/project-plan-files';
import { MAX_PROJECT_PLAN_FILE_BYTES } from '../../src/shared/project-manager';

const roots: string[] = [];

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-plan-files-'));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('project plan file snapshots', () => {
  it('captures supported UTF-8 text files and removes case-insensitive duplicate paths', () => {
    const directory = root();
    const planPath = path.join(directory, 'PLAN.md');
    fs.writeFileSync(planPath, '# 计划\n完成远程控制', 'utf8');

    const result = captureProjectPlanFiles([planPath, planPath.toLowerCase()]);

    expect(result).toMatchObject({ ok: true, files: [{ path: planPath, name: 'PLAN.md' }] });
    if (result.ok) {
      expect(result.files).toHaveLength(1);
      expect(result.files[0].content).toContain('完成远程控制');
      expect(result.files[0].sizeBytes).toBeGreaterThan(0);
    }
  });

  it('rejects unsupported, binary, oversized, and more than three files', () => {
    const directory = root();
    const binaryPath = path.join(directory, 'binary.txt');
    const unsupportedPath = path.join(directory, 'plan.docx');
    const oversizedPath = path.join(directory, 'large.md');
    fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2]));
    fs.writeFileSync(unsupportedPath, '计划', 'utf8');
    fs.writeFileSync(oversizedPath, Buffer.alloc(MAX_PROJECT_PLAN_FILE_BYTES + 1, 65));

    expect(captureProjectPlanFiles([unsupportedPath])).toMatchObject({ ok: false, error: expect.stringContaining('不支持') });
    expect(captureProjectPlanFiles([binaryPath])).toMatchObject({ ok: false, error: expect.stringContaining('纯文本') });
    expect(captureProjectPlanFiles([oversizedPath])).toMatchObject({ ok: false, error: expect.stringContaining('1 MB') });
    expect(captureProjectPlanFiles(['C:\\a.md', 'C:\\b.md', 'C:\\c.md', 'C:\\d.md'])).toMatchObject({
      ok: false,
      error: expect.stringContaining('最多 3 个'),
    });
  });
});
