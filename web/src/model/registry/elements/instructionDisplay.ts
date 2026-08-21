/**
 * The instruction display (InstructionDisplayElm.java, XML type "ins", port
 * dump 434): a bus of `busWidth` inputs that forms an integer from the per-bit
 * logic levels (a post above `threshold` sets its bit), then maps that integer
 * through a lookup table to a drawn string. Pure readout: it adds no matrix
 * unknown (getVoltageSourceCount() == 0).
 *
 * Upstream's text dump code is effectively 0 (it never overrides
 * getDumpType), so the port uses 434, the smallest unused code in the modern
 * XML-era block. The lookup table rides in `e.text`, written as one escaped
 * token. See feature/instruction-display.md for the geometry deviation
 * (upstream stacks every bus post on one (x,y) point and relies on the post
 * index for node identity; the port spreads them vertically so each bit is a
 * distinct node).
 */

import { canvasFont, limbColor, line } from '../../../render/draw';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The default lookup table upstream seeds the element with. */
export const DEFAULT_LOOKUP = '0=text0\n1=text1\n0x2-0xF=other ({a})\n';

/** The bus width, clamped like the engine: truncated and capped to 1..32. */
export function instructionDisplayBits(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  if (value > 32) return 32;
  return Math.round(value);
}

function busWidth(e: CircuitElement): number {
  return instructionDisplayBits(e.params.busWidth ?? 4);
}

/** The integer formed from the bus posts (InstructionDisplayElm.readInputValue). */
export function instructionDisplayValue(
  voltages: (number | undefined)[],
  busWidth: number,
  threshold: number,
): number {
  let value = 0;
  for (let i = 0; i < busWidth; i++) {
    if ((voltages[i] ?? 0) > threshold) value |= 1 << i;
  }
  return value;
}

/** Parses one lookup key, handling decimal and 0x/0b prefixes. */
function parseKey(s: string): number {
  const t = s.trim();
  const prefixed = t.startsWith('0x') || t.startsWith('0X') || t.startsWith('0b') || t.startsWith('0B');
  if (prefixed) {
    const rest = t.slice(2).trim();
    const radix = t[1] === 'b' || t[1] === 'B' ? 2 : 16;
    const n = parseInt(rest, radix);
    return Number.isFinite(n) ? n : 0;
  }
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
}

interface LookupEntry {
  lo: number;
  hi: number;
  template: string;
}

/** Splits the multi-line lookup text into rows; a line without `=` is skipped. */
function parseLookup(lookup: string): LookupEntry[] {
  const entries: LookupEntry[] = [];
  for (const rawLine of lookup.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const template = line.slice(eq + 1);
    const start = key.startsWith('0x') || key.startsWith('0X') || key.startsWith('0b') || key.startsWith('0B') ? 2 : 0;
    const dash = key.slice(start).indexOf('-');
    if (dash >= 0) {
      const d = dash + start;
      entries.push({ lo: parseKey(key.slice(0, d)), hi: parseKey(key.slice(d + 1)), template });
    } else {
      const k = parseKey(key);
      entries.push({ lo: k, hi: k, template });
    }
  }
  return entries;
}

/** Renders a template, substituting `{expr}` with the result (variable `a`). */
function renderTemplate(template: string, value: number): string {
  let out = '';
  let pos = 0;
  while (pos < template.length) {
    const open = template.indexOf('{', pos);
    if (open < 0) {
      out += template.slice(pos);
      break;
    }
    out += template.slice(pos, open);
    const close = template.indexOf('}', open);
    if (close < 0) {
      out += template.slice(open);
      break;
    }
    const exprStr = template.slice(open + 1, close);
    try {
      // The only variable the format supports is `a`, the input value.
      // A minimal safe evaluator: numbers, `a`, + - * / and parentheses.
      const result = evalLookupExpr(exprStr, value);
      out += result;
    } catch {
      out += `{${exprStr}}`;
    }
    pos = close + 1;
  }
  return out;
}

/** A tiny arithmetic evaluator for `{a}` expressions: numbers, `a`, and
 *  `+ - * / %` with parentheses. Enough for the lookup templates. */
function evalLookupExpr(expr: string, a: number): string {
  const chars = expr.replace(/\s+/g, '');
  let i = 0;
  const parseExpr = (): number => {
    let v = parseTerm();
    while (i < chars.length && (chars[i] === '+' || chars[i] === '-')) {
      const op = chars[i++];
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    while (i < chars.length && (chars[i] === '*' || chars[i] === '/' || chars[i] === '%')) {
      const op = chars[i++];
      const r = parseFactor();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const parseFactor = (): number => {
    if (chars[i] === '(') {
      i++;
      const v = parseExpr();
      if (chars[i] === ')') i++;
      return v;
    }
    if (chars[i] === 'a' || chars[i] === 'A') {
      i++;
      return a;
    }
    let num = '';
    while (i < chars.length && /[0-9.]/.test(chars[i])) num += chars[i++];
    return num.length > 0 ? parseFloat(num) : 0;
  };
  if (chars.length === 0) return `{${expr}}`;
  const v = parseExpr();
  if (i < chars.length || !Number.isFinite(v)) return `{${expr}}`;
  if (Number.isInteger(v)) return String(v);
  return String(v);
}

/**
 * Maps `value` through `lookup` to the string to draw, the port of upstream's
 * getDisplayText. No entry matches -> the decimal value.
 */
export function instructionDisplayText(value: number, lookup: string): string {
  const entries = parseLookup(lookup);
  for (const e of entries) {
    if (value >= e.lo && value <= e.hi) {
      return renderTemplate(e.template, value);
    }
  }
  return String(value);
}

/** The bus posts: a vertical stack centred on the anchor (x1, y1), one node
 *  per bit so wires connect to individual bits. */
export function instructionDisplayPosts(e: CircuitElement): Point[] {
  const n = busWidth(e);
  const grid = 16;
  const top = e.y1 - ((n - 1) * grid) / 2;
  const posts: Point[] = [];
  for (let i = 0; i < n; i++) {
    posts.push({ x: e.x1, y: Math.round(top + i * grid) });
  }
  return posts;
}

function drawInstructionDisplay(g: DrawContext, e: CircuitElement): void {
  const n = busWidth(e);
  const threshold = e.params.threshold ?? 2.5;
  const value = instructionDisplayValue(g.voltages, n, threshold);
  const text = instructionDisplayText(value, e.text ?? DEFAULT_LOOKUP);

  // A short stem from the bus anchor to the text, faint.
  line(g, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, limbColor(g, g.theme.text), 2);

  // The instruction string, centred at the text anchor (x2, y2).
  g.ctx.fillStyle = limbColor(g, g.theme.text);
  g.ctx.font = `bold ${canvasFont(14)}`;
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText(text, e.x2, e.y2);
}

export const INSTRUCTION_DISPLAY_DEF: ElementDef = {
  kind: 'instructionDisplay',
  label: 'Instruction display',
  category: 'Other',
  dumpCode: '434',
  postCount: 4, // the busWidth(4) default, for the fresh-part fallback
  postCountOf: (e) => busWidth(e),
  posts: instructionDisplayPosts,
  noDiagonal: true,
  defaultLength: 4,
  defaults: { busWidth: 4, threshold: 2.5 },
  parse: (t, e) => {
    const bw = Math.round(Number(t[0]));
    if (Number.isFinite(bw)) e.params.busWidth = instructionDisplayBits(bw);
    const th = Number(t[1]);
    if (Number.isFinite(th)) e.params.threshold = th;
    e.text = t[2] ?? DEFAULT_LOOKUP;
  },
  dump: (e) => [busWidth(e), e.params.threshold ?? 2.5, e.text ?? DEFAULT_LOOKUP],
  fields: [
    { name: 'busWidth', label: 'Bus Width', min: 1, max: 32, integer: true },
    { name: 'threshold', label: 'Threshold Voltage', unit: 'V' },
    { name: 'lookup', label: 'Lookup Table', type: 'text', target: 'text' },
  ],
  draw: drawInstructionDisplay,
};
