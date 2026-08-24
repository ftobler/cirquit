import { describe, expect, it } from 'vitest';
import { fromTrustedSender } from './protocol';

describe('the undocked child transport guard', () => {
  const opener = {};  // stand-in window handle, compared by identity

  it('accepts a message from the opener at this page origin', () => {
    expect(
      fromTrustedSender(
        { source: opener, origin: 'https://app.test' },
        opener,
        'https://app.test',
      ),
    ).toBe(true);
  });

  it('ignores a foreign origin even when the sender is the opener', () => {
    // A compromised or sandboxed frame re-hosted under another origin posts
    // with that origin; it must be dropped before its payload is inspected.
    expect(
      fromTrustedSender(
        { source: opener, origin: 'https://elsewhere.test' },
        opener,
        'https://app.test',
      ),
    ).toBe(false);
  });

  it('ignores another tab even at this page origin', () => {
    const stranger = {};
    expect(
      fromTrustedSender(
        { source: stranger, origin: 'https://app.test' },
        opener,
        'https://app.test',
      ),
    ).toBe(false);
  });
});
