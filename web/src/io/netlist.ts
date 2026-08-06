/**
 * Reader and writer for the original CircuitJS text format, so circuits and
 * shared links move between this app and upstream unchanged.
 *
 * The format is line-oriented and whitespace-separated:
 *
 * ```text
 * $ flags timeStep iterCount currentSpeed voltageRange powerRange minTimeStep
 * r 176 80 384 80 0 10
 * o 4 64 0 4099 20 0.05 0 2 4 3
 * ```
 *
 * Element lines are `<type> x1 y1 x2 y2 flags <type-specific tokens...>`.
 * Anything this build does not model is preserved verbatim and put back where
 * it was, down to blank lines, `#` comments and the header fields nothing here
 * reads, so loading and saving a circuit never silently drops data.
 */

import { defFor, defForDumpCode } from '../model/registry';
import type { CircuitElement, SimSettings } from '../model/types';

/** A scope trace as stored in the file. */
export interface ScopeConfig {
  /** Session-unique handle, so a save can put the line back where it was. */
  id: number;
  /**
   * The index token exactly as the file wrote it: a position in upstream's
   * element list, which counts the element lines this build cannot read. It is
   * not an index into `ParsedCircuit.elements`.
   */
  elementIndex: number;
  /** The element that index resolves to, or undefined when it lands on an
   *  element line this build could not read. */
  elementId?: number;
  value: 'voltage' | 'current' | 'power';
  /** Every token after the index, kept so the line round-trips exactly. The
   *  display fields in here are not interpreted yet. */
  raw: string[];
}

/**
 * One line of the file, in the order it appeared. Replaying this on save is
 * what keeps blank lines, comments and unmodelled lines where the author put
 * them instead of sweeping them to the end.
 *
 * Elements and scopes are referenced by id rather than by position, so a
 * deleted element simply vacates its slot and the rest of the file stays put.
 */
export type NetlistLine =
  | { kind: 'header' }
  | { kind: 'element'; id: number }
  | { kind: 'scope'; id: number }
  | { kind: 'other'; line: string };

export interface ParsedCircuit {
  elements: CircuitElement[];
  settings: Partial<SimSettings>;
  scopes: ScopeConfig[];
  /** Lines this build does not interpret, re-emitted on save. */
  passthrough: string[];
  /** Types present in the file that this build cannot draw or simulate. */
  unsupported: string[];
  /** Every line of the file, for a save that reproduces its arrangement. */
  order: NetlistLine[];
}

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

let nextId = 1;
/** Ids only need to be unique within a session; the file format has none. */
export function allocateId(): number {
  return nextId++;
}

export function resetIds(): void {
  nextId = 1;
}

/** Line types upstream dispatches on by their first character alone, so
 *  `.foo` counts as a `.` line: `!` custom-logic model, `%`/`?` afilter noise,
 *  `.` subcircuit definition (CircuitLoader.java:163-191). */
const NON_ELEMENT_HEADS = '!%?.';

/** Whole first tokens that are not element codes either: the header, a scope,
 *  a hint, afilter's `B`, and the diode, transistor and slider definitions
 *  (CircuitLoader.java:150-191). */
const NON_ELEMENT_CODES = new Set(['$', 'o', 'h', 'B', '32', '34', '38']);

/**
 * Does this line take a slot in the element list a scope `o` index counts
 * against? Upstream dispatches every other line type before it ever tries to
 * build a component, so only element lines advance `elmList`. The lines this
 * build cannot read still advance it, which is why the index a scope carries
 * is not an index into `ParsedCircuit.elements`.
 */
export function isElementLine(line: string): boolean {
  const head = line.trim().split(/\s+/)[0] ?? '';
  if (head === '' || head.startsWith('#')) return false;
  return !NON_ELEMENT_CODES.has(head) && !NON_ELEMENT_HEADS.includes(head[0]);
}

export function parseCircuit(text: string): ParsedCircuit {
  const elements: CircuitElement[] = [];
  const settings: Partial<SimSettings> = {};
  const scopes: ScopeConfig[] = [];
  const passthrough: string[] = [];
  const unsupported: string[] = [];
  const order: NetlistLine[] = [];

  /**
   * Upstream's reader breaks a line on `\n` or `\r`, so a classic-Mac file of
   * bare CRs is a whole circuit and not one garbage line
   * (CircuitLoader.java:133-140).
   *
   * Three normalisations are deliberate, and bound what "byte-for-byte" means
   * here: CRLF and lone CR both come back as LF, a file with no trailing
   * newline gains one, and a second `$` line re-emits the same header values
   * as the first because only one set of settings is kept.
   */
  const rawLines = text.split(/\r\n|\r|\n/);
  // A trailing newline terminates the last line rather than opening an empty
  // one. The writer appends it again, so keeping it here would add a blank
  // line to the file on every save.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  // Upstream's `elmList` position, which the `o` lines index into.
  let fileIndex = 0;
  const idByFileIndex = new Map<number, number>();

  for (const rawLine of rawLines) {
    const lineText = rawLine.trim();
    if (!lineText || lineText.startsWith('#')) {
      // Blank lines and comments carry nothing this build models, but dropping
      // them rewrites the author's file, so they ride through untrimmed.
      order.push({ kind: 'other', line: rawLine });
      continue;
    }
    const tokens = lineText.split(/\s+/);
    const head = tokens[0];

    if (head === '$') {
      // Header: `$ flags timeStep iterCount currentSpeed voltageRange
      // powerRange minTimeStep` (CirSim.java:436-449).
      const timeStep = Number(tokens[2]);
      const iterCount = Number(tokens[3]);
      const currentSpeed = Number(tokens[4]);
      const voltageRange = Number(tokens[5]);
      const powerRange = Number(tokens[6]);
      const minTimeStep = Number(tokens[7]);
      if (Number.isFinite(timeStep) && timeStep > 0) settings.timeStep = timeStep;
      if (Number.isFinite(currentSpeed)) settings.currentSpeed = currentSpeed;
      if (Number.isFinite(voltageRange) && voltageRange > 0) settings.voltageRange = voltageRange;
      // Nothing here reads these three, but a save must write back what the
      // file said rather than a made-up default. Old files stop after
      // voltageRange, which upstream tolerates (CircuitLoader.java:263-266).
      if (Number.isFinite(iterCount)) settings.iterCount = iterCount;
      if (Number.isFinite(powerRange)) settings.powerRange = powerRange;
      if (Number.isFinite(minTimeStep)) settings.minTimeStep = minTimeStep;
      // Bit 16 suppresses value labels (CirSim.java:440). Bits 1, 2, 4, 8, 32,
      // 64 and 128 are dots, small grid, volts, power, linear scale,
      // adjustTimeStep and autoDC: kept verbatim, none of them modelled here.
      const flags = Number(tokens[1]) || 0;
      settings.headerFlags = flags;
      settings.showValues = (flags & 16) === 0;
      order.push({ kind: 'header' });
      continue;
    }

    if (head === 'o') {
      // Scope. Only the attachment is interpreted; the rest is preserved.
      const elementIndex = Number(tokens[1]);
      const id = allocateId();
      scopes.push({
        id,
        elementIndex: Number.isFinite(elementIndex) ? elementIndex : -1,
        value: 'voltage',
        raw: tokens.slice(2),
      });
      order.push({ kind: 'scope', id });
      continue;
    }

    const def = defForDumpCode(head);
    if (!def) {
      // Sliders (`38`), hints (`h`), models and anything newer than this
      // build. Keep the line so a save round-trips.
      passthrough.push(lineText);
      order.push({ kind: 'other', line: rawLine });
      if (/^[0-9]+$/.test(head) || /^[a-zA-Z]$/.test(head)) unsupported.push(head);
      else if (NON_ELEMENT_HEADS.includes(head[0])) unsupported.push(head[0]);
      // An element line this build cannot read is still an element to
      // upstream, so it takes its slot and shifts every later scope index.
      if (isElementLine(lineText)) fileIndex += 1;
      continue;
    }

    const element: CircuitElement = {
      id: allocateId(),
      kind: def.kind,
      x1: Number(tokens[1]) || 0,
      y1: Number(tokens[2]) || 0,
      x2: Number(tokens[3]) || 0,
      y2: Number(tokens[4]) || 0,
      flags: Number(tokens[5]) || 0,
      params: { ...(def.defaults ?? {}) },
    };
    const tail = tokens.slice(6);
    def.parse?.(def.rawTokens ? tail : tail.map(unescapeToken), element);
    elements.push(element);
    order.push({ kind: 'element', id: element.id });
    idByFileIndex.set(fileIndex++, element.id);
  }

  // Resolved after the whole file is read, so an `o` line placed above the
  // elements still finds its target.
  for (const scope of scopes) scope.elementId = idByFileIndex.get(scope.elementIndex);

  return { elements, settings, scopes, passthrough, unsupported, order };
}

/**
 * Rebuilds the `$` line rather than echoing the parsed one, so edits to the
 * settings are saved. The tokens this build does not model are written back
 * from `settings` when the file supplied them, and default to what a fresh
 * circuit has always written when it did not.
 */
function headerLine(settings: SimSettings): string {
  // Only bit 16 is modelled; every other loaded bit is passed straight back.
  const flags = (settings.showValues ? 0 : 16) | ((settings.headerFlags ?? 0) & ~16);
  return [
    '$',
    flags,
    settings.timeStep,
    settings.iterCount ?? 10,
    settings.currentSpeed,
    settings.voltageRange,
    settings.powerRange ?? 50,
    // Upstream's own default, set on every clear (CircuitLoader.java:50). The
    // port used to write timeStep/100, which is both a different number and,
    // in binary floating point, a long one.
    settings.minTimeStep ?? 50e-12,
  ].join(' ');
}

/** One element line, or null for a kind this build cannot write. */
function elementLine(e: CircuitElement): string | null {
  const def = defFor(e.kind);
  if (!def) return null;
  const extra = (def.dump?.(e) ?? []).map((v) =>
    typeof v === 'string' && !def.rawTokens ? escapeToken(v) : String(v),
  );
  return [def.dumpCode, e.x1, e.y1, e.x2, e.y2, def.dumpFlags?.(e) ?? e.flags, ...extra].join(' ');
}

/**
 * One `o` line. The index token is recomputed from where the target element
 * ended up in the written file, so deleting an element ahead of a scope does
 * not silently repoint it. A scope whose target this build could not read
 * keeps the index the file gave it: nothing better is knowable, and the common
 * load-then-save case leaves it exactly right.
 */
function scopeLineFor(s: ScopeConfig, ordinalById: Map<number, number>): string {
  const index =
    s.elementId === undefined ? s.elementIndex : (ordinalById.get(s.elementId) ?? -1);
  return ['o', index, ...s.raw].join(' ');
}

/**
 * Serialises a circuit back to the original format.
 *
 * With an `order` from `parseCircuit`, the file's arrangement is reproduced:
 * comments, blank lines and unmodelled lines stay between the same neighbours
 * they were loaded between, and anything created since the load appends at the
 * end. Without one (the copy/paste subset path) the layout is header,
 * elements, scopes, then passthrough. `order` supersedes `passthrough`, whose
 * lines it already carries.
 */
export function serializeCircuit(
  elements: CircuitElement[],
  settings: SimSettings,
  scopes: ScopeConfig[] = [],
  passthrough: string[] = [],
  order?: NetlistLine[],
): string {
  const header = headerLine(settings);
  const rendered: { id: number; line: string }[] = [];
  for (const e of elements) {
    const line = elementLine(e);
    if (line !== null) rendered.push({ id: e.id, line });
  }
  const ordinalById = new Map<number, number>();

  // An empty order is "no file was loaded", not "the file was empty", so it
  // takes the default layout rather than dropping the passthrough lines.
  if (!order || order.length === 0) {
    rendered.forEach((r, i) => ordinalById.set(r.id, i));
    const body = rendered.map((r) => r.line);
    const traces = scopes.map((s) => scopeLineFor(s, ordinalById));
    return [header, ...body, ...traces, ...passthrough].join('\n') + '\n';
  }

  // Slots are array positions, not ids, so two elements that somehow share an
  // id (the format has no concept of one) both still reach the file.
  const slotById = new Map<number, number[]>();
  rendered.forEach((r, i) => {
    const slots = slotById.get(r.id);
    if (slots) slots.push(i);
    else slotById.set(r.id, [i]);
  });
  const scopeSlots = new Map<number, number>();
  scopes.forEach((s, i) => scopeSlots.set(s.id, i));

  const lines: string[] = [];
  const usedElements = new Set<number>();
  const usedScopes = new Set<number>();
  // Scope lines are written last: their index token depends on where every
  // element landed, which is only known once the whole walk is done.
  const deferred: { at: number; slot: number }[] = [];
  let fileIndex = 0;
  let sawHeader = false;
  for (const entry of order) {
    if (entry.kind === 'header') {
      lines.push(header);
      sawHeader = true;
    } else if (entry.kind === 'other') {
      lines.push(entry.line);
      if (isElementLine(entry.line)) fileIndex += 1;
    } else if (entry.kind === 'element') {
      // A deleted element vacates its slot; the lines around it do not move.
      const slot = (slotById.get(entry.id) ?? []).find((i) => !usedElements.has(i));
      if (slot !== undefined) {
        usedElements.add(slot);
        ordinalById.set(entry.id, fileIndex++);
        lines.push(rendered[slot].line);
      }
    } else {
      const slot = scopeSlots.get(entry.id);
      if (slot !== undefined && !usedScopes.has(slot)) {
        usedScopes.add(slot);
        deferred.push({ at: lines.length, slot });
        lines.push('');
      }
    }
  }
  // A headerless file that holds a circuit still has to save its settings. One
  // that holds no elements is left exactly as it came in: that is the XML
  // `<cir>` form, which this build only passes through, and prefixing it with
  // a `$` line would stop upstream recognising it as XML at all
  // (CircuitLoader.java:73-80).
  if (!sawHeader && rendered.length + scopes.length > 0) {
    lines.unshift(header);
    for (const d of deferred) d.at += 1;
  }
  rendered.forEach((r, i) => {
    if (usedElements.has(i)) return;
    ordinalById.set(r.id, fileIndex++);
    lines.push(r.line);
  });
  scopes.forEach((s, i) => {
    if (!usedScopes.has(i)) lines.push(scopeLineFor(s, ordinalById));
  });
  for (const d of deferred) lines[d.at] = scopeLineFor(scopes[d.slot], ordinalById);

  return lines.join('\n') + '\n';
}
