import { describe, expect, it } from 'vitest';
import {
  attachAutomatedTerminalSubmitTimer,
  beginAutomatedTerminalSubmit,
  consumeAutomatedTerminalSubmit,
  isTerminalUserSubmit,
  prepareForUserTerminalInput,
  resetTerminalUserInputTracking,
  trackTerminalUserInput,
} from '../../src/renderer/utils/terminal-user-submit';

describe('terminal user submit detection', () => {
  it('recognizes only a bare submit key', () => {
    expect(isTerminalUserSubmit('\r')).toBe(true);
    expect(isTerminalUserSubmit('\n')).toBe(true);
    expect(isTerminalUserSubmit('\x1b\r')).toBe(false);
    expect(isTerminalUserSubmit('\x1b[200~line 1\nline 2\x1b[201~')).toBe(false);
    expect(isTerminalUserSubmit('text')).toBe(false);
  });

  it('requires actual text before a submit and consumes the draft once', () => {
    resetTerminalUserInputTracking();
    expect(trackTerminalUserInput('worker-a', '\r')).toBe(false);
    expect(trackTerminalUserInput('worker-a', '审核意见')).toBe(false);
    expect(trackTerminalUserInput('worker-a', '\r')).toBe(true);
    expect(trackTerminalUserInput('worker-a', '\r')).toBe(false);
  });

  it('returns the exact submitted launcher text and applies backspace edits', () => {
    resetTerminalUserInputTracking();
    expect(prepareForUserTerminalInput('worker-a', 'kimii').shouldSubmit).toBe(false);
    expect(prepareForUserTerminalInput('worker-a', '\x7f').shouldSubmit).toBe(false);
    expect(prepareForUserTerminalInput('worker-a', '\r')).toEqual({
      shouldSubmit: true,
      clearAutomatedDraft: false,
      submittedText: 'kimi',
    });
  });

  it('never exposes arbitrary terminal text such as credentials', () => {
    resetTerminalUserInputTracking();
    expect(prepareForUserTerminalInput('worker-a', 'sk-secret-value').shouldSubmit).toBe(false);
    expect(prepareForUserTerminalInput('worker-a', '\r')).toEqual({
      shouldSubmit: true,
      clearAutomatedDraft: false,
    });
    expect(prepareForUserTerminalInput('worker-a', 'kimi --api-key sk-secret-value').shouldSubmit).toBe(false);
    expect(prepareForUserTerminalInput('worker-a', '\r')).toEqual({
      shouldSubmit: true,
      clearAutomatedDraft: false,
      submittedText: 'kimi',
    });
  });

  it('keeps Shift+Enter as draft content and lets Ctrl+C clear it', () => {
    resetTerminalUserInputTracking();
    expect(trackTerminalUserInput('worker-a', '\x1b\r')).toBe(false);
    expect(trackTerminalUserInput('worker-a', '\r')).toBe(true);
    expect(trackTerminalUserInput('worker-a', 'cancel me')).toBe(false);
    expect(trackTerminalUserInput('worker-a', '\x03')).toBe(false);
    expect(trackTerminalUserInput('worker-a', '\r')).toBe(false);
  });

  it('cancels a delayed AI submit and clears its draft before user text', () => {
    resetTerminalUserInputTracking();
    const clearDraft = () => cleared += 1;
    let cleared = 0;
    const token = beginAutomatedTerminalSubmit('worker-a', clearDraft);
    attachAutomatedTerminalSubmitTimer(token, 123);

    expect(prepareForUserTerminalInput('worker-a', '用户意见')).toMatchObject({
      shouldSubmit: false,
      clearAutomatedDraft: false,
    });
    expect(cleared).toBe(1);
    expect(consumeAutomatedTerminalSubmit(token)).toBe(false);
    expect(prepareForUserTerminalInput('worker-a', '\r').shouldSubmit).toBe(true);
  });

  it('defers automated draft clearing to the main process for remote input', () => {
    resetTerminalUserInputTracking();
    let cleared = 0;
    beginAutomatedTerminalSubmit('worker-a', () => cleared += 1);

    expect(prepareForUserTerminalInput('worker-a', '远程用户意见', false)).toEqual({
      shouldSubmit: false,
      clearAutomatedDraft: true,
    });
    expect(cleared).toBe(0);
  });
});
