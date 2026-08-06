import { describe, expect, it } from 'vitest';
import { escapeToken, unescapeToken } from './tokens';

describe('token escaping', () => {
  it('round-trips text containing spaces', () => {
    const text = 'a label with spaces';
    expect(unescapeToken(escapeToken(text))).toBe(text);
    expect(escapeToken(text)).not.toContain(' ');
  });

  it('covers the whole upstream escape set in one round trip', () => {
    // Every character CustomLogicModel.java:259-263 rewrites: a literal
    // backslash, a space, a newline, `+`, `=`, `#`, `&` and a carriage return.
    const text = 'a\\b c\nd+e=f#g&h\rtail';
    expect(escapeToken(text)).toBe('a\\\\b\\sc\\nd\\pe\\qf\\hg\\ah\\rtail');
    expect(unescapeToken(escapeToken(text))).toBe(text);
  });

  it('maps the empty string to the whole-token \\0 and back', () => {
    expect(escapeToken('')).toBe('\\0');
    expect(unescapeToken('\\0')).toBe('');
    // Only the whole token means empty; embedded, the backslash of an unknown
    // escape is simply dropped (CustomLogicModel.java:287-288).
    expect(unescapeToken('a\\0b')).toBe('a0b');
  });
});
