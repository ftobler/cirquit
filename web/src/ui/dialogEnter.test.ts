/** The shared Enter-commit guard for dialog fields: an IME composition's
 *  confirmation keystroke also reports key 'Enter', and committing
 *  mid-composition saves half-converted text. Upstream's keyCode-based check
 *  skipped these events incidentally (keyCode 229, UIManager.java:1084); the
 *  port has to ask explicitly. */

import { describe, expect, it } from 'vitest';
import { isCommitEnter } from './dialogEnter';

const enter = (isComposing?: boolean) => ({ key: 'Enter', nativeEvent: { isComposing } });

describe('isCommitEnter', () => {
  it('accepts a plain Enter, with or without the flag', () => {
    expect(isCommitEnter({ key: 'Enter', nativeEvent: {} })).toBe(true);
    expect(isCommitEnter(enter(false))).toBe(true);
  });

  it('rejects the Enter that confirms an IME conversion', () => {
    expect(isCommitEnter(enter(true))).toBe(false);
  });

  it('rejects every other key', () => {
    expect(isCommitEnter({ key: 'a', nativeEvent: {} })).toBe(false);
    expect(isCommitEnter({ key: 'Escape', nativeEvent: {} })).toBe(false);
    expect(isCommitEnter({ key: 'Shift', nativeEvent: {} })).toBe(false);
  });
});
