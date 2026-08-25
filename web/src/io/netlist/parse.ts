import { defForDumpCode } from '../../model/registry';
import { modelFamilyFor, resolveModelParams } from '../../model/deviceModels';
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
import { modelToEngineSpec, parseCompositeModelLine } from '../subcircuits';
import { isXml } from '../xml';
import { xmlToText } from '../xmlToText';
import { decodeEmbeddedScope } from '../embeddedScope';

/** Kinds that resolve a `modelName` against the diode model library. All four
 *  share the diode model machinery upstream (VaractorElm, ZenerElm and LEDElm
 *  extend DiodeElm), so one lookup serves them all. */
const MODEL_KINDS = new Set(['diode', 'zener', 'varactor', 'led']);

/**
 * Parses one `34` diode-model library line into its interpreted model, or null
 * for a line that does not carry a resolvable model (a partial or hand-edited
 * line is still preserved by the caller, it just never resolves). The token
 * layout is `34 <escaped name> <flags> <saturationCurrent> <seriesResistance>
 * <emissionCoefficient> <breakdownVoltage> [<forwardCurrent>]` (DiodeModel.dump,
 * DiodeModel.java:338-341). The saturation current and emission coefficient
 * must be positive: the derived forward drop is ln(1/Is + 1), which a
 * non-positive Is would make Infinity. Shared by `parseCircuit` and the save
 * path, which re-parses a stored line to compare its body against the current
 * writable entry before deciding whether to regenerate it.
 */
export function parseDiodeModelLine(line: string): { name: string; model: DiodeModel } | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== '34') return null;
  const name = tokens[1] === undefined ? '' : unescapeToken(tokens[1]);
  const num = (i: number): number | undefined => {
    const v = Number(tokens[i]);
    return tokens[i] !== undefined && Number.isFinite(v) ? v : undefined;
  };
  const saturationCurrent = num(3);
  const seriesResistance = num(4);
  const emissionCoefficient = num(5);
  const breakdownVoltage = num(6);
  if (
    name === '' ||
    saturationCurrent === undefined ||
    saturationCurrent <= 0 ||
    seriesResistance === undefined ||
    emissionCoefficient === undefined ||
    emissionCoefficient <= 0 ||
    breakdownVoltage === undefined
  ) {
    return null;
  }
  const model: DiodeModel = {
    saturationCurrent,
    seriesResistance,
    emissionCoefficient,
    breakdownVoltage,
    flags: Number(tokens[2]) || 0,
  };
  const forwardCurrent = num(7);
  if (forwardCurrent !== undefined) model.forwardCurrent = forwardCurrent;
  return { name, model };
}

/**
 * Parses one `32` transistor-model library line into its interpreted model, or
 * null for a line without a resolvable table. The port's Ebers-Moll consumes
 * only satCur (token 3) and betaR (token 14); the rest of the table stays on
 * the line but is not resolved (TransistorModel.undump,
 * TransistorModel.java:234-248). A non-positive satCur or betaR is not a
 * resolvable model. Shared with the save path like `parseDiodeModelLine`.
 */
export function parseTransistorModelLine(line: string): { name: string; model: TransistorModel } | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== '32') return null;
  const name = tokens[1] === undefined ? '' : unescapeToken(tokens[1]);
  const num = (i: number): number | undefined => {
    const v = Number(tokens[i]);
    return tokens[i] !== undefined && Number.isFinite(v) ? v : undefined;
  };
  const saturationCurrent = num(3);
  const betaReverse = num(14);
  if (
    name === '' ||
    saturationCurrent === undefined ||
    saturationCurrent <= 0 ||
    betaReverse === undefined ||
    betaReverse <= 0
  ) {
    return null;
  }
  return { name, model: { saturationCurrent, betaReverse } };
}

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
 *  (ScopeSerializer.java:13-19). Shared with the scope-line decoder, whose
 *  token walk must advance exactly as this one does. */
export const FLAG_PLOTS = 4096;
export const FLAG_PERPLOTFLAGS = 1 << 18;
export const FLAG_PERPLOT_MAN_SCALE = 1 << 19;
export const FLAG_DIVISIONS = 1 << 21;

/** Upstream's `importDecOrHex`: an `x` prefix means the rest is hex
 *  (ScopeSerializer.java:327-332). Shared with the scope-line decoder. */
export function importDecOrHex(token: string): number {
  if (token.startsWith('x')) return Number.parseInt(token.slice(1), 16);
  return Number(token);
}

/**
 * The `value`/`val` token to a trace quantity. Token 1 is the legacy power id
 * upstream rewrites to power for anything but a transistor
 * (ScopeSerializer.java:197-199); each element family answers the tokens its
 * own `getScopeValue` table owns (TransistorElm.java:582-593): a
 * transistor's IB/IC/IE/VBE/VBC/VCE and the VAL_R of a lamp, memristor or
 * ohmmeter (LampElm.java:218-219, MemristorElm.java:143-146,
 * OhmMeterElm.java:38-42) now map to engine-sampled values instead of null
 * plots. On a transistor, voltage (0)
 * and charge (8) deliberately still fall through to a plain voltage
 * difference, which is friendlier than upstream's flat zero for the same
 * token; only a truly unmodelled token above 8 maps to null, because drawing
 * a wrong waveform would be worse than preserving the line raw. Every other
 * kind falls through to a voltage difference (CircuitElm.java:1270-1273).
 */
export function scopeValueFromToken(token: number, kind: string | null): ScopeValue | null {
  if (kind === 'transistor') {
    switch (token) {
      case 0:
        return 'voltage';
      case 1:
        return 'ib';  // VAL_IB
      case 2:
        return 'ic';  // VAL_IC
      case 3:
        return 'ie';  // VAL_IE
      case 4:
        return 'vbe';  // VAL_VBE
      case 5:
        return 'vbc';  // VAL_VBC
      case 6:
        return 'vce';  // VAL_VCE
      case 7:
        return 'power';
      case 8:
        return 'voltage';
      default:
        return null;
    }
  }
  switch (token) {
    case 0:
      return 'voltage';
    case 2:
      // VAL_R: a lamp, memristor and ohmmeter answer getScopeValue for it
      // (LampElm.java:218-219, MemristorElm.java:143-146, OhmMeterElm.java:
      // 38-42); everything else reads it as its voltage like upstream's
      // default.
      return kind === 'lamp' || kind === 'memristor' || kind === 'ohmmeter'
        ? 'resistance'
        : 'voltage';
    case 7:
      return 'power';
    case 1:
      return 'power';  // legacy power id becomes power
    case 3:
      return 'current';
    case 8:
      // VAL_CHARGE: a capacitor plots C*Vplate, upstream's getScopeValue
      // (CapacitorElm.java:225-229); any other element falls through to its
      // voltage like the default below.
      return kind === 'capacitor' || kind === 'polarizedCapacitor' ? 'charge' : 'voltage';
    default:
      return 'voltage';
  }
}

/** The `value`/`val` token a trace quantity serializes as, the inverse of
 *  `scopeValueFromToken`. Shared with the scope-line encoder. The per-element
 *  names are unambiguous without the kind: only a lamp, memristor or ohmmeter
 *  ever carries a `resistance` plot and only a transistor an `ib`..`vce`
 *  one. */
export function valueTokenOf(value: ScopeValue | null): number {
  switch (value) {
    case 'current':
      return 3;
    case 'power':
      return 7;
    case 'charge':
      return 8;
    case 'resistance':
      return 2;  // VAL_R
    case 'ib':
      return 1;  // VAL_IB
    case 'ic':
      return 2;  // VAL_IC
    case 'ie':
      return 3;  // VAL_IE
    case 'vbe':
      return 4;  // VAL_VBE
    case 'vbc':
      return 5;  // VAL_VBC
    case 'vce':
      return 6;  // VAL_VCE
    default:
      return 0;
  }
}

/** The units index a value token plots in, mirroring `getScopeUnits`
 *  (CircuitElm.java:1274-1277, TransistorElm.java:595-602, LampElm.java:221-222,
 *  MemristorElm.java:145-147, OhmMeterElm.java:40-42, CapacitorElm.java:230-231).
 *  Only W and higher carry an extra scale token on the line, so this decides
 *  how far the plot walk advances (ScopeSerializer.java:221-223, 236-238). A
 *  lamp's VAL_R plots in ohms and a capacitor's VAL_CHARGE in coulombs, both >
 *  UNITS_A; skipping their scale token would read the next plot's `ne` one
 *  token early. Shared with the scope-line decoder, whose walk must agree
 *  token-for-token. */
export function unitsOf(token: number, kind: string | null): number {
  if (
    (kind === 'lamp' || kind === 'memristor' || kind === 'ohmmeter') &&
    token === 2
  ) {
    return 3;  // resistance: Ω
  }
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

/** The dump-code token a raw line starts with, upstream's dispatch key
 *  before it ever tries `createCe` (CircuitLoader.java's whitespace split).
 *  Shared by `isElementLine` and anything else that needs a line's head
 *  without parsing the rest of it. */
export function dumpCodeOfLine(line: string): string {
  return line.trim().split(/\s+/)[0] ?? '';
}

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
  const head = dumpCodeOfLine(line);
  if (head === '' || head.startsWith('#')) return false;
  return defForDumpCode(head) !== undefined || UPSTREAM_ELEMENT_CODES.has(head);
}

/**
 * The upstream dump codes for the element kinds `unitsOf`/`scopeValueFromToken`
 * special-case (LampElm.java:74, CapacitorElm.java:67, PolarCapacitorElm.java:18,
 * TransistorElm.java:101). An `o`-line plot can target an element line this
 * build cannot construct (its head is in `UPSTREAM_ELEMENT_CODES` but not the
 * registry, or a future upstream code neither build has caught up with yet);
 * the plot walk still has to know whether *that* element's real kind carries a
 * units-scale token, and every other kind is handled by `unitsOf`'s
 * token-only branches regardless of kind, so this is the only kind
 * information an unreadable line's raw head needs to supply.
 */
const KIND_BY_DUMP_CODE: Record<string, string> = {
  '181': 'lamp',
  c: 'capacitor',
  '209': 'polarizedCapacitor',
  t: 'transistor',
  m: 'memristor',
  '216': 'ohmmeter',
};

/**
 * The kind an unreadable element line's raw dump code implies, for `unitsOf`
 * purposes only: never a substitute for the registry on a line this build can
 * actually construct. Returns null for any code outside the small set above,
 * which is exactly right because `unitsOf` has no other kind-specific branch.
 */
export function kindOfDumpCode(code: string): string | null {
  return KIND_BY_DUMP_CODE[code] ?? null;
}

export function parseCircuit(text: string): ParsedCircuit {
  // Upstream's XML `<cir>` documents are migrated to the text format on load:
  // the port never writes XML, it only reads it, once. Conversion is the
  // owner's chosen migration path (feature/xml-to-text.md), so a converted
  // file saves as ordinary text from then on.
  if (isXml(text)) {
    try {
      text = xmlToText(text);
    } catch (e) {
      throw new Error(`xml to text conversion failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const elements: CircuitElement[] = [];
  const settings: Partial<SimSettings> = {};
  const scopes: ScopeConfig[] = [];
  const sliders: SliderConfig[] = [];
  const passthrough: string[] = [];
  const unsupported: string[] = [];
  const warnings: string[] = [];
  const order: NetlistLine[] = [];
  const compositeModels: CompositeModel[] = [];
  // A `.` line repeated under the same name shadows its predecessors in the
  // library, so the by-name map keeps the last one; the 410 resolution below
  // must agree with the session map the store registers from this array.
  const compositeModelsByName = new Map<string, CompositeModel>();
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
  // Only set for a slot this build could not construct: the raw head is all
  // a later scope-plot walk can use to guess that element's real kind.
  const dumpCodeByFileIndex = new Map<number, string>();
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
      // Diode-model library line (DiodeModel.dump, DiodeModel.java:338-341).
      // The line itself rides through in passthrough so a save re-emits it in
      // place; only its parameters are interpreted, into the library the
      // model-name resolution below reads. It is not an element line upstream
      // either, so it takes no scope index and is not reported unsupported.
      // A bare `34` with no name token must not throw: it degrades to
      // preserved-but-unresolvable like any other partial line.
      const parsed = parseDiodeModelLine(lineText);
      if (parsed !== null) diodeModels.set(parsed.name, parsed.model);
      passthrough.push(lineText);
      order.push({ kind: 'other', line: rawLine });
      continue;
    }

    if (head === '32') {
      // Transistor-model library line (TransistorModel.undump,
      // TransistorModel.java:234-248). The port's Ebers-Moll consumes only
      // satCur (index 3) and betaR (index 14); the rest of the table stays on
      // the line but is not resolved into params. Like the `34` line it rides
      // through in passthrough so a save re-emits it in place, and it is not
      // an element line upstream either, so it takes no scope index and is not
      // reported unsupported.
      const parsed = parseTransistorModelLine(lineText);
      if (parsed !== null) transistorModels.set(parsed.name, parsed.model);
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
      if (model !== null) {
        compositeModels.push(model);
        compositeModelsByName.set(model.name, model);
      }
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
      if (isElementLine(lineText)) {
        dumpCodeByFileIndex.set(fileIndex, head);
        fileIndex += 1;
      }
      continue;
    }

    // The five leading numeric tokens decide readability, mirroring upstream,
    // which reads coordinates and flags with Integer.parseInt inside the
    // per-line try (CircuitLoader.java:186-190): an absent or non-finite token
    // throws there and the catch skips the whole line (:207-211). Loading such
    // a line at (0,0) here would weld posts that never touched, so it degrades
    // like any other unmodelled element line instead. Fractions stay accepted
    // and rounded below, a deliberate accommodation for dragged geometry.
    const coord = (i: number): number | null => {
      const v = Number(tokens[i]);
      return tokens[i] !== undefined && Number.isFinite(v) ? v : null;
    };
    const cx1 = coord(1);
    const cy1 = coord(2);
    const cx2 = coord(3);
    const cy2 = coord(4);
    const cflags = coord(5);
    if (cx1 === null || cy1 === null || cx2 === null || cy2 === null || cflags === null) {
      passthrough.push(lineText);
      order.push({ kind: 'other', line: rawLine });
      warnings.push(
        `${def.label} line with unreadable coordinates or flags was kept as an unrecognised line`,
      );
      // The head is in the registry, so the skipped line still takes its slot
      // in the scope index space, recorded by raw code like any unmodelled
      // element line so a plot targeting it resolves its units the same way.
      dumpCodeByFileIndex.set(fileIndex, head);
      fileIndex += 1;
      continue;
    }

    const element: CircuitElement = {
      id: allocateId(),
      kind: def.kind,
      // Upstream files are integral, but a hand-edited file can carry
      // fractions that would fail the engine's `[i32; 2]` post type exactly
      // like a dragged element. Round so the store invariant survives loads.
      // Number also accepts exponent (`1e2`) and hexadecimal (`0x10`)
      // coordinate forms that Integer.parseInt rejects; those load by choice
      // too, under the same accommodation.
      x1: Math.round(cx1),
      y1: Math.round(cy1),
      x2: Math.round(cx2),
      y2: Math.round(cy2),
      flags: Number(tokens[5]),
      params: { ...(def.defaults ?? {}) },
    };
    const tail = tokens.slice(6);
    // A clamp-on-load warning (an out-of-range token the engine normalises)
    // is collected here so it rides the load-time banner alongside the
    // unsupported-lines message and survives the first engine rebuild.
    def.parse?.(
      def.rawTokens ? tail : tail.map(unescapeToken),
      element,
      (message) => warnings.push(message),
    );
    elements.push(element);
    order.push({ kind: 'element', id: element.id });
    idByFileIndex.set(fileIndex++, element.id);
  }

  // Resolved after the whole file is read, so an `o` line placed above the
  // elements still finds its targets, and the plot walk knows each plot's
  // element kind, which decides whether a scale token follows its value.
  // The kind resolver is shared with the embedded-scope decode below, whose
  // config token indexes into the same element list.
  const kindOfFileIndex = (index: number): string | null => {
    const elementId = idByFileIndex.get(index);
    if (elementId !== undefined) return elements.find((e) => e.id === elementId)?.kind ?? null;
    const code = dumpCodeByFileIndex.get(index);
    return code === undefined ? null : kindOfDumpCode(code);
  };
  for (const { id, tokens } of pendingScopes) {
    scopes.push(parseScopeLine(id, tokens, idByFileIndex, kindOfFileIndex));
  }

  // The embedded scopes (403 rows) interpret their `_`-joined config token
  // through the same walk and the same element indexes. The raw token stays
  // in `text` untouched; this attaches the display-only interpretation the
  // renderer and the trace registration read.
  for (const e of elements) {
    if (e.kind !== 'scope' || e.text === undefined) continue;
    const decoded = decodeEmbeddedScope(e.text, kindOfFileIndex);
    if (decoded === null) continue;
    e.embedded = {
      tokens: decoded.tokens,
      display: decoded.display,
      plots: decoded.plots.map((p) => ({
        id: allocateId(),
        elementId: idByFileIndex.get(p.elementIndex) ?? null,
        value: p.value,
      })),
    };
  }

  // Model names resolve after the whole file is read too, for the same
  // reason: a `34`/`32` line can sit below the element that names it. The
  // library entry wins over the element defaults, then the built-in table by
  // exact name, then defaults, matching upstream's `getModelWithNameOrCopy`
  // (DiodeModel.java:62-76); an unknown name leaves the element on its
  // defaults. The transistor resolves its own `32` table into satCur and
  // betaR, the only Ebers-Moll params the port models. A custom-logic `208`
  // element carries its model name in `text` (the Model Name field), so it
  // resolves against the `!` library into the structured model the engine is
  // handed; a miss leaves it on the defaults, exactly like upstream's
  // `getModelWithNameOrCopy` returning the copied fallback. A custom-composite
  // `410` element resolves its `text` the same way, against the file's own
  // `.` lines: on a hit `e.model` becomes the `CompositeEngineSpec`
  // (`{model, external, dumps}`) the engine's `Composite::from_spec` parses,
  // and a miss leaves it unset so the part draws the fallback body while the
  // name still round-trips. Storage/session models are deliberately not
  // resolved here: parseCircuit is pure, so the library resolves at placement
  // time instead (helpers.ts). A name both the file and storage hold resolves
  // to the file's copy, matching upstream's local-map-wins rule and the
  // session map the load registers.
  for (const e of elements) {
    if (e.kind === 'transistor') {
      if (e.modelName === undefined) continue;
      const params = resolveModelParams(
        'transistor',
        e.modelName,
        transistorModels.get(e.modelName),
      );
      if (params === undefined) continue;
      Object.assign(e.params, params);
      continue;
    }
    if (e.kind === 'customLogic') {
      const model = e.text === undefined ? undefined : customLogicModels.get(e.text);
      if (model !== undefined) e.model = model;
      continue;
    }
    if (e.kind === 'customComposite') {
      // The array is in file order and a repeated name shadows its
      // predecessors, so the last line wins, matching the session map the
      // store builds from the same array.
      const model = e.text === undefined ? undefined : compositeModelsByName.get(e.text);
      if (model !== undefined) e.model = modelToEngineSpec(model);
      continue;
    }
    if (!MODEL_KINDS.has(e.kind) || e.modelName === undefined) continue;
    const family = modelFamilyFor(e.kind);
    if (family === undefined) continue;
    const params = resolveModelParams(family, e.modelName, diodeModels.get(e.modelName));
    if (params === undefined) continue;
    // The forward drop is derived from the saturation current, upstream's
    // `updateModel` (DiodeModel.java:332-336), inside the shared resolution.
    // Deriving it matters: if the name is later dropped by an edit, the
    // value-form dump writes the real drop instead of the 0.805904783 default.
    Object.assign(e.params, params);
  }

  return {
    elements,
    settings,
    scopes,
    sliders,
    passthrough,
    compositeModels,
    diodeFileModels: diodeModels,
    transistorFileModels: transistorModels,
    unsupported,
    warnings,
    order,
  };
}

/**
 * Interpret one `o` line's tokens, following upstream's undump token walk
 * (ScopeSerializer.java:188-289). The raw tokens are kept for the round trip;
 * the walk exists to find the per-plot `ne val` pairs without mistaking the
 * optional manDivisions, per-plot flags and per-plot scale tokens for them.
 * Everything the walk does not consume is scope text, preserved in raw.
 * `kindOf` resolves a file element index to its kind, shared with the
 * embedded-scope decode so both walks read the file identically.
 */
function parseScopeLine(
  id: number,
  tokens: string[],
  idByFileIndex: Map<number, number>,
  kindOf: (index: number) => string | null,
): ScopeConfig {
  const rawIndex = Number(tokens[1]);
  const elementIndex = Number.isFinite(rawIndex) ? rawIndex : -1;
  const valueToken = Number(tokens[3]);
  const flags = importDecOrHex(tokens[4] ?? '0');

  const plots: ScopePlotConfig[] = [];
  const plotOf = (index: number, token: number): ScopePlotConfig => ({
    id: allocateId(),
    elementIndex: index,
    elementId: idByFileIndex.get(index),
    // A garbage token is stored as -1, never NaN: a re-emitted val of -1
    // reads back as unattached, while "NaN" on the line would not parse.
    valueToken: Number.isFinite(token) ? token : -1,
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
