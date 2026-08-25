import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyProjectEvidenceRefs } from '../../src/main/project-evidence';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function projectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-project-evidence-'));
  roots.push(root);
  return root;
}

describe('project evidence refs', () => {
  it('reads and hashes an actual bounded project evidence file', () => {
    const root = projectRoot();
    const evidenceDir = path.join(root, 'runs', '2026-08-25', 'run-1');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'result.json'), '{"outcome":"fail"}\n', 'utf8');

    expect(verifyProjectEvidenceRefs(root, ['runs/2026-08-25/run-1/result.json'])).toMatchObject({
      ok: true,
      entries: [{
        ref: 'runs/2026-08-25/run-1/result.json',
        sizeBytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }],
    });
  });

  it('rejects missing, directory-only, and traversal references', () => {
    const root = projectRoot();
    fs.mkdirSync(path.join(root, 'runs'), { recursive: true });

    expect(verifyProjectEvidenceRefs(root, ['runs/missing.json'])).toMatchObject({
      ok: false, error: expect.stringContaining('不存在'),
    });
    expect(verifyProjectEvidenceRefs(root, ['runs'])).toMatchObject({
      ok: false, error: expect.stringContaining('普通文件'),
    });
    expect(verifyProjectEvidenceRefs(root, ['../outside.json'])).toMatchObject({
      ok: false, error: expect.stringContaining('规范相对'),
    });
  });
});
