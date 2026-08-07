import { defForDumpCode } from '../../model/registry';
import type { CircuitElement, SimSettings } from '../../model/types';
import type { NetlistLine, ParsedCircuit, ScopeConfig } from './types';
import { unescapeToken } from './tokens';

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
      // A save must write back what the file said rather than a made-up
      // default. Old files stop after voltageRange, which upstream tolerates
      // (CircuitLoader.java:263-266).
      if (Number.isFinite(iterCount) && iterCount > 0) settings.iterCount = iterCount;
      if (Number.isFinite(powerRange)) settings.powerRange = powerRange;
      if (Number.isFinite(minTimeStep) && minTimeStep > 0) settings.minTimeStep = minTimeStep;
      // Bit 16 suppresses value labels, bit 64 enables the adaptive timestep,
      // bit 128 enables the DC operating point on reset (CirSim.java:440-444).
      // Bits 1, 2, 4, 8 and 32 are dots, small grid, volts, power and linear
      // scale: kept verbatim, none of them modelled here.
      const flags = Number(tokens[1]) || 0;
      settings.headerFlags = flags;
      settings.showValues = (flags & 16) === 0;
      settings.adaptiveTimeStep = (flags & 64) !== 0;
      settings.autoDC = (flags & 128) !== 0;
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
      // Upstream files are integral, but a hand-edited file can carry
      // fractions that would fail the engine's `[i32; 2]` post type exactly
      // like a dragged element. Round so the store invariant survives loads.
      x1: Math.round(Number(tokens[1]) || 0),
      y1: Math.round(Number(tokens[2]) || 0),
      x2: Math.round(Number(tokens[3]) || 0),
      y2: Math.round(Number(tokens[4]) || 0),
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
