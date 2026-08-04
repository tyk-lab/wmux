import { describe, it, expect, vi } from 'vitest';
import {
  SHIFT_ENTER_SEQUENCE,
  handleShiftEnter,
  isShiftEnter,
  isTerminalCtrlC,
  shouldBroadcastTerminalInput,
  type TerminalKeyEvent,
} from '../../src/renderer/hooks/terminal-keys';

function keyEvent(over: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    type: 'keydown',
    key: 'Enter',
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    ...over,
  } as any;
}

describe('Ctrl+C terminal semantics', () => {
  it('reserves bare Ctrl+C for the terminal regardless of key casing', () => {
    expect(isTerminalCtrlC(keyEvent({ key: 'c', ctrlKey: true, shiftKey: false }))).toBe(true);
    expect(isTerminalCtrlC(keyEvent({ key: 'C', ctrlKey: true, shiftKey: false }))).toBe(true);
  });

  it('does not reserve modified or non-keydown variants', () => {
    expect(isTerminalCtrlC(keyEvent({ key: 'c', ctrlKey: true }))).toBe(false);
    expect(isTerminalCtrlC(keyEvent({ key: 'c', ctrlKey: true, shiftKey: false, altKey: true }))).toBe(false);
    expect(isTerminalCtrlC(keyEvent({ key: 'c', ctrlKey: true, shiftKey: false, metaKey: true }))).toBe(false);
    expect(isTerminalCtrlC(keyEvent({ type: 'keyup', key: 'c', ctrlKey: true, shiftKey: false }))).toBe(false);
  });
});

describe('Shift+Enter (issue #119)', () => {
  it('matches a plain Shift+Enter keydown', () => {
    expect(isShiftEnter(keyEvent())).toBe(true);
  });

  it('ignores keypress/keyup — xterm calls the handler for all three', () => {
    expect(isShiftEnter(keyEvent({ type: 'keypress' }))).toBe(false);
    expect(isShiftEnter(keyEvent({ type: 'keyup' }))).toBe(false);
  });

  it('leaves Enter, Ctrl+Shift+Enter and Alt+Shift+Enter alone', () => {
    expect(isShiftEnter(keyEvent({ shiftKey: false }))).toBe(false);
    // Ctrl+Shift+Enter is the zoom-pane shortcut and must reach the global handler.
    expect(isShiftEnter(keyEvent({ ctrlKey: true }))).toBe(false);
    expect(isShiftEnter(keyEvent({ altKey: true }))).toBe(false);
    expect(isShiftEnter(keyEvent({ metaKey: true }))).toBe(false);
    expect(isShiftEnter(keyEvent({ key: 'a' }))).toBe(false);
  });

  it('emits ESC+CR exactly once', () => {
    const emit = vi.fn();
    handleShiftEnter(keyEvent(), emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('\x1b\r');
    expect(SHIFT_ENTER_SEQUENCE).toBe('\x1b\r');
  });

  // The regression itself. Returning false makes xterm's _keyDown bail but does
  // NOT cancel the DOM event, so the browser still fires `keypress` and xterm's
  // _keyPress sends Enter's charCode 13 as a second, plain \r — the blank line
  // users saw after every Shift+Enter. Only preventDefault suppresses it.
  it('cancels the keydown so no keypress produces a second newline', () => {
    const event = keyEvent();
    handleShiftEnter(event, vi.fn());
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('tells xterm not to handle the key as well', () => {
    expect(handleShiftEnter(keyEvent(), vi.fn())).toBe(false);
  });
});

describe('broadcast-input interrupt isolation', () => {
  it('never broadcasts Ctrl+C, including when normal input sync is enabled', () => {
    expect(shouldBroadcastTerminalInput('\x03', false)).toBe(false);
    expect(shouldBroadcastTerminalInput('\x03', true)).toBe(false);
  });

  it('continues to synchronize ordinary input only when broadcast mode is enabled', () => {
    expect(shouldBroadcastTerminalInput('a', false)).toBe(false);
    expect(shouldBroadcastTerminalInput('a', true)).toBe(true);
  });
});
