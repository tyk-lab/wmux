import { describe, it, expect } from 'vitest';
import {
  REG_ROOTS,
  verbKeyFor,
  commandFor,
  iconFor,
  directoryFromArgv,
  setPendingLaunchDirectory,
  consumePendingLaunchDirectory,
} from '../../src/main/shell-context-menu';

// The registry writes themselves are execFileSync('reg.exe') and are not worth
// mocking; what IS worth pinning is the two things that silently produce a
// context-menu entry that does nothing when they are wrong — the command string
// and the argv parsing on the receiving end.

describe('registry shape', () => {
  it('covers folder, folder-background and drive', () => {
    expect(REG_ROOTS).toContain('Directory');
    expect(REG_ROOTS).toContain('Directory\\Background');
    expect(REG_ROOTS).toContain('Drive');
  });

  it('registers under HKCU so no elevation is needed', () => {
    for (const root of REG_ROOTS) {
      expect(verbKeyFor(root)).toMatch(/^HKCU\\Software\\Classes\\/);
    }
  });
});

describe('command string', () => {
  const EXE = 'C:\\Users\\a\\OneDrive - Pulsa\\Bureau\\wmux\\wmux.exe';
  const ELECTRON = 'C:\\proj\\node_modules\\electron\\dist\\electron.exe';
  const APP = 'C:\\proj\\wmux';

  it('quotes an exe path containing spaces (packaged)', () => {
    expect(commandFor(EXE)).toBe(`"${EXE}" "%V"`);
  });

  // Dev must pass the app path; otherwise Electron treats %V as the app.
  it('includes the app path in dev form', () => {
    expect(commandFor(ELECTRON, APP)).toBe(`"${ELECTRON}" "${APP}" "%V"`);
  });

  // %1 is EMPTY for Directory\Background — the right-click-empty-space gesture.
  it('passes %V, not %1', () => {
    expect(commandFor(EXE)).toContain('"%V"');
    expect(commandFor(EXE)).not.toContain('%1');
  });

  it('points the icon at the exe resources', () => {
    expect(iconFor(EXE)).toBe(`"${EXE}",0`);
  });
});

describe('directoryFromArgv', () => {
  const isDir = (p: string) =>
    p === 'C:\\work\\proj'
    || p === 'C:\\Program Files\\x'
    || p === 'C:\\src\\wmux';

  it('finds the folder Explorer passed (packaged)', () => {
    expect(directoryFromArgv(['wmux.exe', 'C:\\work\\proj'], isDir)).toBe('C:\\work\\proj');
  });

  // Dev: electron.exe <appRoot> <folder> — last directory is the Explorer target.
  it('prefers the last directory when app path and folder both appear', () => {
    expect(
      directoryFromArgv(
        ['electron.exe', 'C:\\src\\wmux', 'C:\\work\\proj'],
        isDir,
      ),
    ).toBe('C:\\work\\proj');
  });

  it('handles a path with spaces', () => {
    expect(directoryFromArgv(['wmux.exe', 'C:\\Program Files\\x'], isDir)).toBe('C:\\Program Files\\x');
  });

  it('ignores Chromium/Electron switches', () => {
    expect(
      directoryFromArgv(['wmux.exe', '--no-sandbox', '--user-data-dir=C:\\x'], isDir),
    ).toBeNull();
  });

  it('ignores a path that is not a directory', () => {
    expect(directoryFromArgv(['wmux.exe', 'C:\\work\\file.txt'], isDir)).toBeNull();
  });

  it('ignores the dev entry script and the packed app', () => {
    expect(directoryFromArgv(['electron.exe', '.', 'C:\\work\\proj'], isDir)).toBe('C:\\work\\proj');
    expect(directoryFromArgv(['wmux.exe', 'C:\\app\\resources\\app.asar'], isDir)).toBeNull();
  });

  it('never returns the exe itself', () => {
    expect(directoryFromArgv(['C:\\work\\proj'], isDir)).toBeNull();
  });

  it('ignores relative paths', () => {
    expect(directoryFromArgv(['wmux.exe', 'proj'], () => true)).toBeNull();
  });

  it('survives a throwing stat', () => {
    expect(directoryFromArgv(['wmux.exe', 'C:\\denied'], () => { throw new Error('EACCES'); }))
      .toBeNull();
  });
});

describe('pending launch directory', () => {
  it('is one-shot: second consume returns null', () => {
    setPendingLaunchDirectory('C:\\work\\proj');
    expect(consumePendingLaunchDirectory()).toBe('C:\\work\\proj');
    expect(consumePendingLaunchDirectory()).toBeNull();
  });
});
