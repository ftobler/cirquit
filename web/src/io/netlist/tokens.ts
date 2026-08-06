/** Undoes the token escaping used for text that may contain spaces. */
export function unescapeToken(s: string): string {
  // The exact token `\0` is the empty string, matching upstream; a literal
  // `\0` inside a longer name is just a backslash dropped and the `0` kept.
  if (s === '\\0') return '';
  // `\s`, `\n`, `\r` decode to whitespace, `\p`/`\q`/`\h`/`\a` to their
  // punctuation, and any other `\x` drops the backslash and keeps the letter.
  return s.replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case 's':
        return ' ';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 'p':
        return '+';
      case 'q':
        return '=';
      case 'h':
        return '#';
      case 'a':
        return '&';
      default:
        return c;
    }
  });
}

export function escapeToken(s: string): string {
  // The full upstream escape set (CustomLogicModel.java:259-263): backslash,
  // space, newline, CR, `+`, `=`, `#`, `&`, and the empty string as `\0`.
  if (s.length === 0) return '\\0';
  return s
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '\\s')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\+/g, '\\p')
    .replace(/=/g, '\\q')
    .replace(/#/g, '\\h')
    .replace(/&/g, '\\a');
}
