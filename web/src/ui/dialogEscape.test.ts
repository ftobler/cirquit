import { describe, expect, it } from 'vitest';
import { claimEscape, ownsEscape, releaseEscape, escapeClaimCount } from './dialogEscape';

describe('dialogEscape', () => {
  it('the newest claim owns escape and a release promotes the one below', () => {
    // Properties plus the Device Model Editor mount together; only the
    // editor, mounted last, may answer the press.
    const bottom = claimEscape(() => {});
    const top = claimEscape(() => {});
    expect(ownsEscape(bottom)).toBe(false);
    expect(ownsEscape(top)).toBe(true);
    releaseEscape(top);
    // The next press then closes the properties dialog instead of both at
    // once, which is exactly the stacked-dialog defect.
    expect(ownsEscape(bottom)).toBe(true);
    releaseEscape(bottom);
    expect(escapeClaimCount()).toBe(0);
  });

  it('a released claim loses ownership even if still referenced', () => {
    const first = claimEscape(() => {});
    releaseEscape(first);
    const second = claimEscape(() => {});
    // A stale handle kept by a late cleanup must never act on a press.
    expect(ownsEscape(first)).toBe(false);
    releaseEscape(second);
    expect(escapeClaimCount()).toBe(0);
  });

  it('double release is inert', () => {
    const claim = claimEscape(() => {});
    releaseEscape(claim);
    releaseEscape(claim);
    // The stack must be none the worse: later claims claim and own normally.
    const next = claimEscape(() => {});
    expect(ownsEscape(next)).toBe(true);
    releaseEscape(next);
    expect(escapeClaimCount()).toBe(0);
  });

  it('interleaved claim and release leave a consistent top', () => {
    const a = claimEscape(() => {});
    const b = claimEscape(() => {});
    const c = claimEscape(() => {});
    // An out-of-order unmount (the middle one) releases only its own token;
    // the one below stays buried under the one above.
    releaseEscape(b);
    expect(ownsEscape(c)).toBe(true);
    expect(ownsEscape(a)).toBe(false);
    releaseEscape(c);
    expect(ownsEscape(a)).toBe(true);
    const d = claimEscape(() => {});
    expect(ownsEscape(d)).toBe(true);
    expect(ownsEscape(a)).toBe(false);
    releaseEscape(d);
    releaseEscape(a);
    expect(escapeClaimCount()).toBe(0);
  });
});
