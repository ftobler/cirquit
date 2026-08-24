/**
 * The memory-contents text codec: the SRAM/ROM contents editor's format
 * (SRAMElm.java contentsToString, :169-197, parseContentsString, :199-224).
 * Pure and DOM-free so it is testable headlessly; the element glue that feeds
 * it lives in ui/elementFields.ts and the store owns the params.
 *
 * Upstream keeps the map keyed by address, so the writer walks every address
 * in range and the parser's map.put overwrites. This port holds the flat pair
 * list instead; sorting by address on write reproduces the walk, and the
 * engine's last-wins insert over the pairs matches map.put (sram.rs:36-45).
 */

export interface ContentsTextOptions {
  /** Write addresses and values in hex (FLAG_HEX_DISPLAY). Display-only: the
   *  stored pairs are radix-independent numbers either way. */
  hex: boolean;
  /** Value width in bits. Values mask to `2^dataBits - 1` on write, upstream's
   *  `toHex` mask (SRAMElm.java:193-197), and a parsed value past that ceiling
   *  is reported as an error rather than silently wrapped. */
  dataBits: number;
}

export interface ContentsParseResult {
  /** The parsed pairs in text order. The caller chooses to store or ignore
   *  them when `error` is set. */
  pairs: [number, number][];
  /** The first malformed line's message, or null when every line parsed. */
  error: string | null;
}

/** Formats a run's starting address: bare hex with no prefix in hex mode,
 *  decimal otherwise (SRAMElm.java:177). Never masked or padded. */
function fmtAddr(addr: number, hex: boolean): string {
  return hex ? addr.toString(16).toUpperCase() : String(addr);
}

/** Formats one value, masked to the data width and zero-padded to two digits
 *  in hex mode (SRAMElm.java:193-197). The raw value decides run membership,
 *  so a stored value above the mask still writes, as upstream's does. */
function fmtValue(val: number, hex: boolean, mask: number): string {
  if (!hex) return String(val);
  const h = (val & mask).toString(16).toUpperCase();
  return h.length < 2 ? '0' + h : h;
}

/** The rendered contents text, upstream's contentsToString: one run of
 *  consecutive addresses per line, at most 8 values each, a zero value or a
 *  gap ending the run. An empty map renders the empty string. */
export function contentsToText(
  pairs: [number, number][],
  opts: ContentsTextOptions,
): string {
  const { hex, dataBits } = opts;
  const mask = (1 << dataBits) - 1;
  // Upstream walks every address in range and starts a new line on a gap or a
  // zero (SRAMElm.java:173-189); the sorted pair list reproduces that walk.
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const lines: string[] = [];
  let line: string[] = [];
  let lastAddr = -1;
  for (const [addr, val] of sorted) {
    if (val === 0) {
      if (line.length > 0) lines.push(line.join(' '));
      line = [];
      lastAddr = -1;
      continue;
    }
    // line.length >= 9 means the label plus 8 values, upstream's ct cap.
    if (line.length === 0) {
      line = [`${fmtAddr(addr, hex)}:`];
    } else if (addr !== lastAddr + 1 || line.length >= 9) {
      lines.push(line.join(' '));
      line = [`${fmtAddr(addr, hex)}:`];
    }
    line.push(fmtValue(val, hex, mask));
    lastAddr = addr;
  }
  if (line.length > 0) lines.push(line.join(' '));
  // Upstream appends a newline after every line, including the last.
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

const HEX_DIGITS = /^[0-9a-fA-F]+$/;
const DEC_DIGITS = /^[0-9]+$/;
const BIN_DIGITS = /^[01]+$/;

/** The loaded-binary form upstream injects into the contents editor
 *  (SRAMLoadFile.java:31-48): the `0x0:` label then every byte as a
 *  zero-padded uppercase hex value behind an `0x` prefix, one run starting at
 *  address 0. The prefixes make the text parse identically in either display
 *  radix, so it rides the textarea's commit untouched. Bytes are folded to
 *  `mask` (the element's data width) before formatting, so a file loads at
 *  any width instead of refusing wholesale. */
export function bytesToHexRun(bytes: ArrayLike<number>, mask = 0xff): string {
  let text = '0x0:';
  for (let i = 0; i < bytes.length; i++) {
    text += ' 0x' + (bytes[i] & mask).toString(16).toUpperCase().padStart(2, '0');
  }
  return text;
}

/** Upstream's parseNumber (SRAMElm.java:216-224, prefix order per 902f965):
 *  an `0x` prefix always, then the bare radix digits, then an `0b` binary
 *  prefix, else decimal. Hex mode comes before the `0b` check so a hex token
 *  like `0b` (eleven) still parses; strict where parseInt would accept
 *  trailing junk: the whole token must be the number.
 *  Null means the token is not a number at all. */
function parseNumber(token: string, hex: boolean): number | null {
  if (token.startsWith('0x')) {
    const digits = token.slice(2);
    return HEX_DIGITS.test(digits) ? parseInt(digits, 16) : null;
  }
  if ((hex ? HEX_DIGITS : DEC_DIGITS).test(token)) {
    return parseInt(token, hex ? 16 : 10);
  }
  if (token.startsWith('0b')) {
    const digits = token.slice(2);
    return BIN_DIGITS.test(digits) ? parseInt(digits, 2) : null;
  }
  return null;
}

/** Parses the editor's text into address/value pairs, upstream's
 *  parseContentsString with the silent-skip behaviour replaced by an error
 *  naming the first bad line. A line is `addr: val val ...` (split on
 *  `": *"`), the address auto-increments across the values, and a blank line
 *  is skipped. The pairs parsed before the error are still returned, so a
 *  caller that shows the error and keeps the dialog open loses nothing. */
export function parseContentsText(
  text: string,
  opts: ContentsTextOptions,
): ContentsParseResult {
  const { hex, dataBits } = opts;
  const mask = (1 << dataBits) - 1;
  const pairs: [number, number][] = [];
  const lines = text.split(/\r*\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const lineError = (message: string) => `Line ${i + 1}: ${message}`;
    const parts = line.split(/: */);
    if (parts.length < 2) {
      return { pairs, error: lineError("expected 'addr: val val ...' with a ':' separator") };
    }
    const addrToken = parts[0].trim();
    const addr = parseNumber(addrToken, hex);
    if (addr === null) {
      return { pairs, error: lineError(`invalid address '${addrToken}'`) };
    }
    let address = addr;
    const values = parts[1].trim().split(/\s+/);
    for (const token of values) {
      if (token === '') continue;
      const val = parseNumber(token, hex);
      if (val === null) {
        return { pairs, error: lineError(`invalid value '${token}'`) };
      }
      if (val > mask) {
        return {
          pairs,
          error: lineError(`value ${val} does not fit in ${dataBits} bits`),
        };
      }
      pairs.push([address, val]);
      address += 1;
    }
  }
  return { pairs, error: null };
}