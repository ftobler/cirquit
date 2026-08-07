import { defForDumpCode } from '../../model/registry';
import type { CircuitElement, SimSettings } from '../../model/types';
import type { ScopeValue } from '../../engine/simulator';
import type { NetlistLine, ParsedCircuit, ScopeConfig, ScopePlotConfig } from './types';
import { unescapeToken } from './tokens';

let nextId = 1;
/** Ids only need to be unique within a session; the file format has none. */
export function allocateId(): number {
  return nextId++;
}

export function resetIds(): void {
  nextId = 1;
}

/** Scope `flags` bits that change how the `o` line's plot list is laid out
 *  (ScopeSerializer.java:13-19). */
const FLAG_PLOTS = 4096;
const FLAG_PERPLOTFLAGS = 1 << 18;
const FLAG_PERPLOT_MAN_SCALE = 1 << 19;
const FLAG_DIVISIONS = 1 << 21;

/** Upstream's `importDecOrHex`: an `x` prefix means the rest is hex
 *  (ScopeSerializer.java:327-332). */
function importDecOrHex(token: string): number {
  if (token.startsWith('x')) return Number.parseInt(token.slice(1), 16);
  return Number(token);
}

/**
 * The `value`/`val` token to a trace quantity. Token 1 is the legacy power id
 * upstream rewrites to power for anything but a transistor
 * (ScopeSerializer.java:197-199); on a transistor it is VAL_IB. A transistor's
 * own ids (IB/IC/IE/VBE/VBC/VCE) and the lamp's VAL_R and capacitor's
 * VAL_CHARGE are element-specific values the engine cannot sample, so they map
 * to null and the trace is preserved via raw only instead of drawing a wrong
 * voltage waveform. Every other token falls through to a voltage difference
 * (CircuitElm.java:1270-1273).
 */
export function scopeValueFromToken(token: number, kind: string | null): ScopeValue | null {
  switch (token) {
    case 0: return 'voltage';
    case 7: return 'power';
    case 1: return kind === 'transistor' ? null : 'power';  // legacy power id, or VAL_IB
    case 3: return kind === 'transistor' ? null : 'current';  // VAL_CURRENT, or VAL_IE
    case 2: return kind === 'lamp' || kind === 'transistor' ? null : 'voltage';  // VAL_R, or VAL_IC
    case 8: return kind === 'capacitor' || kind === 'polarizedCapacitor' ? null : 'voltage';  // VAL_CHARGE
    default: return kind === 'transistor' ? null : 'voltage';  // VBE/VBC/VCE on a transistor
  }
}

/** The units index a value token plots in, mirroring `getScopeUnits`
 *  (CircuitElm.java:1274-1277, TransistorElm.java:595-602, LampElm.java:221-222,
 *  CapacitorElm.java:230-231). Only W and higher carry an extra scale token on
 *  the line, so this decides how far the plot walk advances
 *  (ScopeSerializer.java:221-223, 236-238). A lamp's VAL_R plots in ohms and a
 *  capacitor's VAL_CHARGE in coulombs, both > UNITS_A; skipping their scale
 *  token would read the next plot's `ne` one token early. */
function unitsOf(token: number, kind: string | null): number {
  if (kind === 'lamp' && token === 2) return 3;  // resistance: Ω
  if ((kind === 'capacitor' || kind === 'polarizedCapacitor') && token === 8) return 4;  // charge: C
  if (kind === 'transistor') {
    if (token === 1 || token === 2 || token === 3) return 1;  // IB/IC/IE: A
    if (token === 7) return 2;  // power: W
    return 0;  // VBE/VBC/VCE: V
  }
  if (token === 1) return 2;  // legacy power id becomes power
  if (token === 3) return 1;  // current: A
  if (token === 7) return 2;  // power: W
  return 0;  // everything else: V
}

/** Line types upstream dispatches on by their first character alone, so
 *  `.foo` counts as a `.` line: `!` custom-logic model, `%`/`?` afilter noise,
 *  `.` subcircuit definition (CircuitLoader.java:163-191). */
const NON_ELEMENT_HEADS = '!%?.';

/**
 * The dump codes upstream's `createCe` accepts that this build does not parse
 * itself. A line with one of these heads is an element upstream constructs,
 * so it takes a slot in the element list a scope `o` index counts against even
 * though this build passes the line through. Everything else, including codes
 * neither build knows (`999`), is skipped by upstream without an index
 * (CircuitLoader.java:201-204). Taken from the `getDumpType()` returns in
 * `reference/circuitjs1`; the codes the port parses are covered by the registry
 * and are not repeated here.
 */
const UPSTREAM_ELEMENT_CODES = new Set([
  '150', '151', '152', '153', '154', '155', '156', '157', '158', '159',
  '160', '161', '162', '163', '164', '165', '166', '167', '168', '169',
  '170', '171', '172', '173', '174', '175', '176', '177', '178', '179',
  '180', '181', '182', '183', '184', '185', '186', '187', '188', '189',
  '193', '194', '195', '196', '197',
  '200', '201', '203',
  '206', '207', '208', '209', '210', '211', '212', '213', '214', '215', '216',
  '350', '368', '370', '374',
  '400', '401', '402', '403', '404', '405', '406', '407', '408', '409',
  '410', '411', '412', '413', '414', '415', '416', '417', '418', '419',
  '420', '421', '422', '423', '424', '425', '426', '427', '428', '429',
  '430', '431', '432', '433', '436',
  'A', 'I', 'L', 'M', 'O', 'R', 'S', 'T', 'a', 'b', 'c', 'd', 'f', 'g',
  'i', 'j', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'x', 'z',
]);

/**
 * Does this line take a slot in the element list a scope `o` index counts
 * against? Upstream dispatches every other line type before it ever tries to
 * build a component, and only advances `elmList` when `createCe` accepts the
 * code, so a line is an element exactly when its head is one upstream can
 * construct: either this build's own registry or the passthrough set above.
 * An unrecognized code is skipped without an index, which is why the index a
 * scope carries is not an index into `ParsedCircuit.elements`.
 */
export function isElementLine(line: string): boolean {
  const head = line.trim().split(/\s+/)[0] ?? '';
  if (head === '' || head.startsWith('#')) return false;
  return defForDumpCode(head) !== undefined || UPSTREAM_ELEMENT_CODES.has(head);
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
  const pendingScopes: { id: number; tokens: string[] }[] = [];

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
      // Scope. The plots need the fully parsed element list to resolve their
      // indices and kinds (an `o` line can sit above the elements it names),
      // so the raw line is stashed here and interpreted after the whole file
      // is read.
      const id = allocateId();
      pendingScopes.push({ id, tokens });
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
  // elements still finds its targets, and the plot walk knows each plot's
  // element kind, which decides whether a scale token follows its value.
  for (const { id, tokens } of pendingScopes) {
    scopes.push(parseScopeLine(id, tokens, idByFileIndex, elements));
  }

  return { elements, settings, scopes, passthrough, unsupported, order };
}

/**
 * Interpret one `o` line's tokens, following upstream's undump token walk
 * (ScopeSerializer.java:188-289). The raw tokens are kept for the round trip;
 * the walk exists to find the per-plot `ne val` pairs without mistaking the
 * optional manDivisions, per-plot flags and per-plot scale tokens for them.
 * Everything the walk does not consume is scope text, preserved in raw.
 */
function parseScopeLine(
  id: number,
  tokens: string[],
  idByFileIndex: Map<number, number>,
  elements: CircuitElement[],
): ScopeConfig {
  const rawIndex = Number(tokens[1]);
  const elementIndex = Number.isFinite(rawIndex) ? rawIndex : -1;
  const valueToken = Number(tokens[3]);
  const flags = importDecOrHex(tokens[4] ?? '0');

  // The element kind a file index resolves to, or null when the index lands on
  // an element line this build could not read (or before any element).
  const kindOf = (index: number): string | null => {
    const elementId = idByFileIndex.get(index);
    if (elementId === undefined) return null;
    return elements.find((e) => e.id === elementId)?.kind ?? null;
  };

  const plots: ScopePlotConfig[] = [];
  const plotOf = (index: number, token: number): ScopePlotConfig => ({
    id: allocateId(),
    elementIndex: index,
    elementId: idByFileIndex.get(index),
    value: scopeValueFromToken(token, kindOf(index)),
  });

  plots.push(plotOf(elementIndex, valueToken));

  if ((flags & FLAG_PLOTS) !== 0) {
    // New-style dump. Position and plot count sit after the fixed
    // `e speed value flags scaleV scaleA` fields; the rest is optional and
    // varies by `flags`, so it is walked with a cursor rather than read at
    // fixed indices.
    let cursor = 7;  // tokens[0]=o [1]=e [2]=speed [3]=value [4]=flags [5]=scaleV [6]=scaleA
    const next = (): number => Number(tokens[cursor++]);
    const position = next();
    const sz = next();
    if (Number.isFinite(position) && Number.isFinite(sz)) {
      if ((flags & FLAG_DIVISIONS) !== 0) cursor += 1;
      // Plot 0's units can carry an extra scale token before the per-plot
      // tokens (ScopeSerializer.java:221-223).
      if (unitsOf(valueToken, kindOf(elementIndex)) > 1 && cursor < tokens.length) cursor += 1;
      for (let i = 0; i < sz; i++) {
        if ((flags & FLAG_PERPLOTFLAGS) !== 0 && cursor < tokens.length) cursor += 1;
        if (i !== 0) {
          const ne = next();
          const val = next();
          if (!Number.isFinite(ne) || !Number.isFinite(val)) break;
          plots.push(plotOf(ne, val));
          if (unitsOf(val, kindOf(ne)) > 1 && cursor < tokens.length) cursor += 1;
        }
        if ((flags & FLAG_PERPLOT_MAN_SCALE) !== 0) cursor += 2;
      }
    }
  }
  // Old-style dumps (no FLAG_PLOTS) carry no plot list: everything past the
  // fixed fields is position, an optional yElm and scope text, all preserved
  // in raw. Plot 0 is the line's element with the `value` token.

  const first = plots[0];
  return {
    id,
    elementIndex: first.elementIndex,
    elementId: first.elementId,
    raw: tokens.slice(2),
    plots,
  };
}
