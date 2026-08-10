import { defForDumpCode } from '../../model/registry';
import type { CircuitElement, SimSettings } from '../../model/types';
import type { ScopeValue } from '../../engine/simulator';
import type {
  CompositeModel,
  CustomLogicModel,
  DiodeModel,
  NetlistLine,
  ParsedCircuit,
  ScopeConfig,
  ScopePlotConfig,
  SliderConfig,
  TransistorModel,
} from './types';
import { unescapeToken } from './tokens';
import { parseCompositeModelLine } from '../subcircuits';

/** Thermal voltage the diode model's forward-drop derivation uses
 *  (DiodeModel.java:32). */
const VT = 0.025865;

/** Kinds that resolve a `modelName` against the `34` model library. All three
 *  share the diode model machinery upstream (VaractorElm and ZenerElm extend
 *  DiodeElm), so one lookup serves them all. */
const MODEL_KINDS = new Set(['diode', 'zener', 'varactor']);

/**
 * Splits a custom-logic `rules` string into the left/right table the engine
 * evaluates, mirroring `parseRules` (CustomLogicModel.java:185-245). Each
 * non-empty, non-comment line is lowercased and trimmed, split on `=` into
 * exactly two parts, and validated against the pin counts; a letter used twice
 * on the left becomes its uppercase compare form so `aA` means "pin 1 equals
 * pin 0". Upstream aborts the whole table on the first bad line on the undump
 * path (it `return`s with the fresh empty vectors), so this mirrors that too:
 * one malformed line means the model matches no rules at all. `triState`
 * turns on the moment any right side contains a `_`.
 */
function parseCustomLogicRules(
  inputs: string[],
  outputs: string[],
  rules: string,
): { rulesLeft: string[]; rulesRight: string[]; triState: boolean } {
  const none = { rulesLeft: [] as string[], rulesRight: [] as string[], triState: false };
  const rulesLeft: string[] = [];
  const rulesRight: string[] = [];
  let triState = false;
  for (const rawLine of rules.split('\n')) {
    const s = rawLine.toLowerCase().trim();
    if (s.length === 0 || s.startsWith('#')) continue;
    const parts = s.replaceAll(' ', '').split('=');
    if (parts.length !== 2) return none;
    if (parts[0].length < inputs.length) return none;
    if (parts[0].length > inputs.length + outputs.length) return none;
    if (parts[1].length !== outputs.length) return none;
    const used = new Array(26).fill(false);
    let rl = '';
    for (const x of parts[0]) {
      if (x === '?' || x === '+' || x === '-' || x === '0' || x === '1') {
        rl += x;
        continue;
      }
      if (x < 'a' || x > 'z') return none;
      const i = x.charCodeAt(0) - 97;
      if (used[i]) rl += String.fromCharCode(65 + i);  // A..Z: compare form
      else {
        used[i] = true;
        rl += x;
      }
    }
    const rr = parts[1];
    if (rr.includes('_')) triState = true;
    rulesLeft.push(rl);
    rulesRight.push(rr);
  }
  return { rulesLeft, rulesRight, triState };
}

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
    case 0:
      return 'voltage';
    case 7:
      return 'power';
    case 1:
      return kind === 'transistor' ? null : 'power';  // legacy power id, or VAL_IB
    case 3:
      return kind === 'transistor' ? null : 'current';  // VAL_CURRENT, or VAL_IE
    case 2:
      return kind === 'lamp' || kind === 'transistor' ? null : 'voltage';  // VAL_R, or VAL_IC
    case 8:
      return kind === 'capacitor' || kind === 'polarizedCapacitor' ? null : 'voltage';  // VAL_CHARGE
    default:
      return kind === 'transistor' ? null : 'voltage';  // VBE/VBC/VCE on a transistor
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
  '150',
  '151',
  '152',
  '153',
  '154',
  '169',
  '174',
  '176',
  '178',
  '180',
  '181',
  '182',
  '183',
  '186',
  '188',
  '189',
  '194',
  '195',
  '196',
  '197',
  '200',
  '201',
  '207',
  '209',
  '210',
  '216',
  '350',
  '368',
  '374',
  '401',
  '404',
  '406',
  '407',
  '408',
  '409',
  '410',
  '411',
  '412',
  '413',
  '414',
  '415',
  '416',
  '420',
  '421',
  '422',
  '424',
  '425',
  '426',
  '429',
  '431',
  '432',
  '433',
  '436',
  'I',
  'O',
  'R',
  'S',
  'T',
  'a',
  'c',
  'd',
  'f',
  'g',
  'i',
  'l',
  'p',
  'r',
  's',
  't',
  'v',
  'w',
  'x',
  'z',
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
  const sliders: SliderConfig[] = [];
  const passthrough: string[] = [];
  const unsupported: string[] = [];
  const order: NetlistLine[] = [];
  const compositeModels: CompositeModel[] = [];
  const diodeModels = new Map<string, DiodeModel>();
  const transistorModels = new Map<string, TransistorModel>();
  const customLogicModels = new Map<string, CustomLogicModel>();

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
      // The > 0 guard mirrors the powerBar's 1-100 range upstream, so a
      // nonsense token falls back to the default instead of zeroing the ramp.
      if (Number.isFinite(powerRange) && powerRange > 0) settings.powerRange = powerRange;
      if (Number.isFinite(minTimeStep) && minTimeStep > 0) settings.minTimeStep = minTimeStep;
      // Bit 1 shows the current dots, bit 4 switches voltage colouring off,
      // bit 8 turns power colouring on, bit 16 suppresses value labels, bit 64
      // enables the adaptive timestep, bit 128 enables the DC operating point
      // on reset (CirSim.java:437-444, readCircuitFlags). Bits 2 (upstream's
      // small grid) and 32 (linear scale in the afilter) are kept verbatim,
      // not modelled here: the port has no grid-spacing or filter option, but
      // a save must not clear a file bit upstream wrote.
      const flags = Number(tokens[1]) || 0;
      settings.headerFlags = flags;
      settings.showCurrent = (flags & 1) !== 0;
      // "Voltage off" is bit 4; a power-mode file sets bit 8 as well, and the
      // power flag wins when both arrive (readCircuitFlags,
      // CircuitLoader.java:274-277).
      settings.showVoltageColor = (flags & 4) === 0 && (flags & 8) === 0;
      settings.showPowerColor = (flags & 8) === 8;
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

    if (head === '34') {
      // Diode-model library line (DiodeModel.dump, DiodeModel.java:338-341):
      // `34 <escaped name> <flags> <saturationCurrent> <seriesResistance>
      // <emissionCoefficient> <breakdownVoltage> [<forwardCurrent>]`. The line
      // itself rides through in passthrough so a save re-emits it in place;
      // only its parameters are interpreted, into the library the model-name
      // resolution below reads. It is not an element line upstream either, so
      // it takes no scope index and is not reported unsupported.
      // A bare `34` with no name token must not throw: it degrades to
      // preserved-but-unresolvable like any other partial line.
      const name = tokens[1] === undefined ? '' : unescapeToken(tokens[1]);
      const num = (i: number): number | undefined => {
        const v = Number(tokens[i]);
        return tokens[i] !== undefined && Number.isFinite(v) ? v : undefined;
      };
      const saturationCurrent = num(3);
      const seriesResistance = num(4);
      const emissionCoefficient = num(5);
      const breakdownVoltage = num(6);
      // The same skip-non-finite guard readParams uses
      // (registry/shared.ts:43-48), so a truncated or hand-edited line
      // degrades field by field instead of stamping NaN. Only a line that
      // carries all four core parameters becomes a resolvable model; a
      // partial line is still preserved. The saturation current and emission
      // coefficient must be positive too: the derived forward drop is
      // ln(1/Is + 1), which a non-positive Is would make Infinity.
      if (
        name !== '' &&
        saturationCurrent !== undefined &&
        saturationCurrent > 0 &&
        seriesResistance !== undefined &&
        emissionCoefficient !== undefined &&
        emissionCoefficient > 0 &&
        breakdownVoltage !== undefined
      ) {
        const model: DiodeModel = {
          saturationCurrent,
          seriesResistance,
          emissionCoefficient,
          breakdownVoltage,
        };
        const forwardCurrent = num(7);
        if (forwardCurrent !== undefined) model.forwardCurrent = forwardCurrent;
        diodeModels.set(name, model);
      }
      passthrough.push(lineText);
      order.push({ kind: 'other', line: rawLine });
      continue;
    }

    if (head === '32') {
      // Transistor-model library line (TransistorModel.undump,
      // TransistorModel.java:234-248): `32 <escaped name> <flags> <satCur>
      // <invRollOffF> <BEleakCur> <leakBEemissionCoeff> <invRollOffR>
      // <BCleakCur> <leakBCemissionCoeff> <emissionCoeffF> <emissionCoeffR>
      // <invEarlyVoltF> <invEarlyVoltR> <betaR> [junction/transit-time
      // tokens]`. The port's Ebers-Moll consumes only satCur (index 3) and
      // betaR (index 14); the rest of the table stays on the line but is not
      // resolved into params. Like the `34` line it rides through in
      // passthrough so a save re-emits it in place, and it is not an element
      // line upstream either, so it takes no scope index and is not reported
      // unsupported.
      // The same skip-non-finite guard readParams uses, so a truncated or
      // hand-edited line degrades field by field instead of stamping NaN. A
      // line missing the full table, or with a non-positive satCur/betaR, is
      // still preserved but never becomes a resolvable model.
      const name = tokens[1] === undefined ? '' : unescapeToken(tokens[1]);
      const num = (i: number): number | undefined => {
        const v = Number(tokens[i]);
        return tokens[i] !== undefined && Number.isFinite(v) ? v : undefined;
      };
      const saturationCurrent = num(3);
      const betaReverse = num(14);
      if (
        name !== '' &&
        saturationCurrent !== undefined &&
        saturationCurrent > 0 &&
        betaReverse !== undefined &&
        betaReverse > 0
      ) {
        transistorModels.set(name, { saturationCurrent, betaReverse });
      }
      passthrough.push(lineText);
      order.push({ kind: 'other', line: rawLine });
      continue;
    }

    if (head === '!') {
      // Custom-logic model library line (CustomLogicModel.undump,
      // CustomLogicModel.java:82-95): `! <escaped name> <flags> <escaped
      // inputs> <escaped outputs> <escaped infoText> <escaped rules>`.
      // `inputs`/`outputs` are comma-separated escaped pin-name lists and
      // `rules` is a series of `left=right` pairs separated by newlines, the
      // `\q` and `\n` escapes decoding to `=` and a newline
      // (CustomLogicModel.java:259-264). Like the `34`/`32` lines it rides
      // through in passthrough so a save re-emits it in place, and it is not
      // an element line upstream either, so it takes no scope index and is not
      // reported unsupported. Only a line carrying the name and the pin lists
      // and rules becomes a resolvable model; a partial line is preserved but
      // never resolves, degrading like any other truncated model line.
      const name = tokens[1] === undefined ? '' : unescapeToken(tokens[1]);
      const flags = Number(tokens[2]) || 0;
      const inputs = tokens[3] === undefined ? [] : unescapeToken(tokens[3]).split(',');
      const outputs = tokens[4] === undefined ? [] : unescapeToken(tokens[4]).split(',');
      const infoText = tokens[5] === undefined ? '' : unescapeToken(tokens[5]);
      const rules = tokens[6] === undefined ? '' : unescapeToken(tokens[6]);
      if (name !== '' && tokens[3] !== undefined && tokens[4] !== undefined && tokens[6] !== undefined) {
        const parsed = parseCustomLogicRules(inputs, outputs, rules);
        customLogicModels.set(name, {
          name,
          flags,
          inputs,
          outputs,
          infoText,
          rules,
          rulesLeft: parsed.rulesLeft,
          rulesRight: parsed.rulesRight,
          triState: parsed.triState,
        });
      }
      passthrough.push(lineText);
      order.push({ kind: 'other', line: rawLine });
      continue;
    }

    if (head === '.') {
      // Subcircuit-model library line (CustomCompositeModel.undump,
      // CustomCompositeModel.java:208-225): `.<escaped name> <flags> <sizeX>
      // <sizeY> <extCount> <name node pos side>... <escaped nodeList>
      // <escaped elmDump>`. Like the `34`/`32`/`!` lines it rides through in
      // passthrough so a save re-emits it in place, and it is not an element
      // line upstream either, so it takes no scope index and is not reported
      // unsupported. Its parameters are interpreted and handed back in
      // `compositeModels`; registering them in the library is the committing
      // caller's job, so a preview or a clipboard sniff cannot introduce a
      // model. A partial line is preserved but never resolves, degrading like
      // any other truncated model line.
      const model = parseCompositeModelLine(lineText);
      if (model !== null) compositeModels.push(model);
      passthrough.push(lineText);
      order.push({ kind: 'other', line: rawLine });
      continue;
    }

    if (head === '38') {
      // Slider (Adjustable) line: `38 <e> [F<flags>] <editItem> <minValue>
      // <maxValue> [<sharedIndex>] <sliderText> [<sliderStep>]`
      // (Adjustable.java:47-76). It is not an element line upstream either
      // (CircuitLoader.java:183-188), so it takes no scope index and is not
      // reported unsupported. The slider gets its own order slot (like a
      // scope), so the `e` token can be rewritten from where the element
      // lands and a dropped slider's line stops serialising; a line with no
      // element to bind rides through in passthrough like any other.
      const e = Number(tokens[1]);
      // `e == -1` means "no element": the reader returns without creating an
      // Adjustable (Adjustable.java:49-50), so the line stays inert. A missing
      // or non-numeric `e` gets the same treatment. Treating any negative `e`
      // as unbound is a deliberate superset of upstream's exact `-1` check: a
      // hand-edited index below zero is just as dead, and the line rides
      // through passthrough either way.
      if (Number.isFinite(e) && e >= 0) {
        // The same skip-non-finite guard readParams uses
        // (registry/shared.ts:43-48), so a truncated or hand-edited line
        // degrades field by field instead of stamping NaN.
        const num = (i: number): number | undefined => {
          const v = Number(tokens[i]);
          return tokens[i] !== undefined && Number.isFinite(v) ? v : undefined;
        };
        // The F-prefixed token is a backward-compatibility marker: flags are
        // the integer after it and the editItem is the next token, else the
        // token IS the editItem and flags default to 0
        // (Adjustable.java:54-58). Bit 1 = FLAG_SHARED, bit 2 = FLAG_LOG.
        let flags = 0;
        let cursor = 2;
        if (tokens[2] !== undefined && tokens[2].startsWith('F')) {
          flags = Number(tokens[2].slice(1)) || 0;
          cursor = 3;
        }
        const editItem = num(cursor) ?? 0;
        // The other constructor's defaults (Adjustable.java:34-35).
        const min = num(cursor + 1) ?? 1;
        const max = num(cursor + 2) ?? 1000;
        let shared: number | null = null;
        let textCursor = cursor + 3;
        if ((flags & 1) !== 0) {
          // FLAG_SHARED inserts the shared index between max and the text.
          const ano = num(cursor + 3);
          if (ano !== undefined) shared = ano;
          textCursor = cursor + 4;
        }
        const text = tokens[textCursor] === undefined ? '' : unescapeToken(tokens[textCursor]);
        // The step token is optional, read under a try upstream
        // (Adjustable.java:70-72); 0 means continuous.
        const stepToken = tokens[textCursor + 1];
        const step =
          stepToken !== undefined && Number.isFinite(Number(stepToken)) ? Number(stepToken) : 0;
        const id = allocateId();
        sliders.push({
          id,
          elementId: idByFileIndex.get(e),
          editItem,
          min,
          max,
          step,
          text,
          logarithmic: (flags & 2) !== 0,
          shared,
          raw: tokens.slice(1),
        });
        order.push({ kind: 'slider', id });
      } else {
        passthrough.push(lineText);
        order.push({ kind: 'other', line: rawLine });
      }
      continue;
    }

    const def = defForDumpCode(head);
    if (!def) {
      // Hints (`h`) and anything newer than this build. Keep the line so a
      // save round-trips.
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

  // Model names resolve after the whole file is read too, for the same
  // reason: a `34` line can sit below the element that names it. The library
  // entry wins over the element defaults, matching upstream's
  // `getModelWithNameOrCopy` (DiodeModel.java:62-76); an unknown name leaves
  // the element on its defaults. The transistor resolves its own `32` table
  // into satCur and betaR, the only Ebers-Moll params the port models. A
  // custom-logic `208` element carries its model name in `text` (the Model
  // Name field), so it resolves against the `!` library into the structured
  // model the engine is handed; a miss leaves it on the defaults, exactly like
  // upstream's `getModelWithNameOrCopy` returning the copied fallback.
  for (const e of elements) {
    if (e.kind === 'transistor') {
      if (e.modelName === undefined) continue;
      const model = transistorModels.get(e.modelName);
      if (model === undefined) continue;
      e.params.saturationCurrent = model.saturationCurrent;
      e.params.betaReverse = model.betaReverse;
      continue;
    }
    if (e.kind === 'customLogic') {
      const model = e.text === undefined ? undefined : customLogicModels.get(e.text);
      if (model !== undefined) e.model = model;
      continue;
    }
    if (!MODEL_KINDS.has(e.kind) || e.modelName === undefined) continue;
    const model = diodeModels.get(e.modelName);
    if (model === undefined) continue;
    e.params.saturationCurrent = model.saturationCurrent;
    e.params.seriesResistance = model.seriesResistance;
    e.params.emissionCoefficient = model.emissionCoefficient;
    e.params.breakdownVoltage = model.breakdownVoltage;
    // The forward drop is derived from the saturation current, upstream's
    // `updateModel` (DiodeModel.java:332-336). Deriving it matters: if the
    // name is later dropped by an edit, the value-form dump writes the real
    // drop instead of the 0.805904783 default.
    e.params.forwardVoltage =
      model.emissionCoefficient * VT * Math.log(1 / model.saturationCurrent + 1);
  }

  return {
    elements,
    settings,
    scopes,
    sliders,
    passthrough,
    compositeModels,
    unsupported,
    order,
  };
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
