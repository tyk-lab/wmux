import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteSupervisedTerminalSnapshot,
  listSupervisedTerminalSnapshots,
  readSupervisedTerminalSnapshot,
  saveSupervisedTerminalSnapshot,
} from '../../src/main/supervisor-recovery';
import type { SupervisedTerminalSnapshot } from '../../src/shared/supervisor-recovery';

const temporaryDirectories: string[] = [];

function snapshot(projectDir: string, currentTask = '完成登录功能'): SupervisedTerminalSnapshot {
  return {
    version: 1,
    snapshotId: 'snapshot-terminal-a',
    savedAt: 1,
    terminal: {
      surfaceId: 'surface-a', workspaceId: 'workspace-a', paneId: 'pane-a',
      workspaceTitle: '登录项目', label: '任务 AI', projectDir, cwd: projectDir,
      shell: 'pwsh.exe', startupCommands: ['codex'], agent: 'Codex', agentState: 'idle',
      screenTail: '登录接口已经完成，仍需联调界面',
    },
    supervisor: {
      surfaceId: 'supervisor-a', launchCmd: 'pi', model: '', reasoningEffort: 'medium',
      config: {
        taskGoal: '交付登录功能', taskDescription: '', preconditions: '', stopWhen: '测试通过',
        stopWhenKind: 'concrete', planFilePath: '', planRevision: 2,
      },
      autonomous: false,
      autonomyPermissions: ['same-route-next'], forbiddenActions: ['new-dependencies'], workScope: 'project',
      state: {
        controlState: 'active', currentTask, workerTurnId: 3,
        decisions: [{ outcome: 'rework' }, { outcome: 'continue' }],
        standingUserDecision: {
          decision: '同类接口问题保持现有 API',
          subject: '是否改变现有 API',
          proposalKind: 'route-change',
          sourceApprovalId: 'approval-standing',
          updatedAt: 3,
          planRevision: 2,
        },
        latestEvidence: ['接口测试通过'], acceptanceGaps: ['完成界面联调'],
      },
    },
    projectContext: {
      capturedAt: 2, planFilePaths: [],
      progressSnapshot: {
        version: 1, capturedAt: 2, mode: 'filesystem', fingerprint: 'progress-a', entries: [], truncated: false,
      },
      currentTask, verifiedEvidence: ['接口测试通过'], acceptanceGaps: ['完成界面联调'],
      terminalScreenTail: '登录接口已经完成，仍需联调界面',
    },
    consistency: {
      laneId: 'lane-a', taskSurfaceId: 'surface-a', supervisorSurfaceId: 'supervisor-a',
      workerTurnId: 3, planRevision: 2, decisionCount: 0,
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('supervised terminal recovery snapshots', () => {
  it('atomically refreshes one latest snapshot per terminal and lists its effective config', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-supervisor-recovery-'));
    temporaryDirectories.push(projectDir);

    const first = saveSupervisedTerminalSnapshot(snapshot(projectDir));
    const refreshed = saveSupervisedTerminalSnapshot(snapshot(projectDir, '完成界面联调'));

    expect(first.ok).toBe(true);
    expect(refreshed.snapshot.savedAt).toBeGreaterThan(1);
    expect(listSupervisedTerminalSnapshots(projectDir)).toEqual([expect.objectContaining({
      snapshotId: 'snapshot-terminal-a', currentTask: '完成界面联调',
      supervisorAgent: 'pi', supervisorReasoningEffort: 'medium',
      lastDecision: 'rework',
      config: expect.objectContaining({ taskGoal: '交付登录功能', planRevision: 2 }),
    })]);
    expect(readSupervisedTerminalSnapshot(projectDir, 'snapshot-terminal-a')).toMatchObject({
      ok: true,
      snapshot: {
        supervisor: {
          state: {
            currentTask: '完成界面联调',
            standingUserDecision: {
              decision: '同类接口问题保持现有 API',
              sourceApprovalId: 'approval-standing',
              planRevision: 2,
            },
          },
        },
      },
    });
  });

  it('reuses the existing archive id when a fresh lane saves the same terminal', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-supervisor-recovery-'));
    temporaryDirectories.push(projectDir);
    const first = snapshot(projectDir);
    first.snapshotId = 'snapshot-terminal-a-old';
    saveSupervisedTerminalSnapshot(first);
    const freshLane = snapshot(projectDir, '从新监督通道继续');
    freshLane.snapshotId = 'snapshot-terminal-a-new';
    freshLane.consistency.laneId = 'lane-new';

    const refreshed = saveSupervisedTerminalSnapshot(freshLane).snapshot;

    expect(refreshed.snapshotId).toBe('snapshot-terminal-a-old');
    expect(listSupervisedTerminalSnapshots(projectDir)).toEqual([
      expect.objectContaining({ snapshotId: 'snapshot-terminal-a-old', currentTask: '从新监督通道继续' }),
    ]);
  });

  it('deletes only the selected terminal snapshot', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-supervisor-recovery-'));
    temporaryDirectories.push(projectDir);
    saveSupervisedTerminalSnapshot(snapshot(projectDir));

    expect(deleteSupervisedTerminalSnapshot(projectDir, 'snapshot-terminal-a')).toEqual({ ok: true });
    expect(listSupervisedTerminalSnapshots(projectDir)).toEqual([]);
    expect(readSupervisedTerminalSnapshot(projectDir, 'snapshot-terminal-a')).toMatchObject({ ok: false });
  });

  it('rejects a terminal snapshot whose saved content no longer matches its checksum', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-supervisor-recovery-'));
    temporaryDirectories.push(projectDir);
    saveSupervisedTerminalSnapshot(snapshot(projectDir));
    const filePath = path.join(projectDir, '.wmux', 'supervisor', 'recovery', 'snapshot-terminal-a.json');
    const tampered = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    tampered.supervisor.state.currentTask = '被外部改写的任务';
    fs.writeFileSync(filePath, `${JSON.stringify(tampered)}\n`, 'utf8');

    expect(readSupervisedTerminalSnapshot(projectDir, 'snapshot-terminal-a'))
      .toMatchObject({ ok: false, error: expect.stringContaining('校验失败') });
  });
});
