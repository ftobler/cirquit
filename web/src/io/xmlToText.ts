/**
 * Converts upstream's `<cir>` XML documents to this port's text format.
 *
 * This is the migration path the owner chose over implementing the XML format:
 * the port never writes XML, it only reads it, once, at load. A converted file
 * is ordinary text from then on, so a save degrades it to the format every
 * `.txt` file uses. Conversion happens inside `parseCircuit`, so load, paste,
 * the corpus and every other entry point see the text.
 *
 * The attribute-to-token mapping mirrors upstream's `dumpXml`/`undumpXml`
 * pair for each class (see `reference/circuitjs1`), with the port's own text
 * token order as the target. Attribute strings pass through verbatim: they are
 * already Java `Double.toString` output, which JS `String()` reproduces for
 * the same value. Fields the port does not model have no text token and are
 * dropped, exactly as if upstream had saved a text file. The XML-only element
 * classes that still have no port model (Gyrator, NortonAmp,
 * CustomCompositeChip) become `#` comment lines so nothing is lost; a routed
 * wire's path is electrically identical to straight `w` segments, so those
 * convert to real wires. A clock needs no special case: ClockElm dumps as its
 * parent RailElm, so its `<R>` tag runs through the ordinary voltage-token
 * writer and lands as a real clock-flagged rail line. Where an element
 * converts but an attribute it
 * carries would change what upstream builds (a multiplexer's bus input
 * modes, a chip bit order this build does not lay out), the line keeps its
 * slot and a visible `#` trace comment rides under it, so no converted file
 * loses semantics silently.
 *
 * The bus classes convert for real now: a `bli`
 * becomes the port's 435 line and a `bt` its 437 line, each carrying its
 * width token, and an `rw` whose `bw` attribute exceeds one appends it to
 * every segment it becomes. Plain wires without a token need none: the
 * engine-side width pass re-derives their width from the wide pins they
 * touch, exactly as upstream's detectBusWidths does. The instruction display
 * (`ins`) converts to a real 434 line carrying its lookup table, and the
 * battery (`Battery`) to a real 438 line carrying its SOC table. The counter
 * bit orders honoured end to end are ctr2/FullAdder/ROM/SRAM
 * (`bo="2"` into the port's chip flag bit).
 *
 * The remaining plain chip tags map for real too: `dmux`, `ctr`, `Latch`,
 * `TFlipFlop` and `JKFlipFlop` emit their dump-code lines, each consuming
 * exactly the attribute set upstream's own writer produces. What sits beyond
 * that set keeps the trace path: the demultiplexer's bus output modes
 * (`om`/`dw`) and a nonzero bit order on any chip this build does not lay
 * out as a bus.
 *
 * The analog ICs convert for real as well: Timer, Comparator, OTA, OpAmpReal,
 * DAC, AnalogMux and DelayBuffer plus the `as`/`as2` switch pair emit their
 * dump-code lines from the same per-class attribute sets. The comparator and
 * OTA rebuild their child dumps fresh, the OTA deriving its rail supplies from
 * pv/nv and splicing live transistor junction state out of the element's child
 * elements; a DAC bit order this build does not lay out stays behind a trace
 * comment like every other chip's.
 *
 * The nine remaining modelled tags convert for real too: `tt`, `sw`, `tl`,
 * `ts`, `dar`, `dpdt`, `pt`, `ain` and `aout` emit their registry dump-code
 * lines, each consuming exactly the attribute set upstream's own writer
 * produces. A source's `ir` and `riseTime` have no text-format home and
 * degrade loudly under a value-gated trace; a tag the port models but has no
 * writer yet (the relay, the custom-logic gate and a tail of upstream's
 * default-named classes) keeps its preserving comment plus one marker line,
 * neither taking a slot, so scope ordinals hold.
 */

import { parseXml, type XmlNode } from './xml';
import { escapeToken } from './netlist/tokens';
import { encodeScopeLine, scopeFieldsFromFlags } from './scopeLine';
import { importDecOrHex, scopeValueFromToken, unitsOf } from './netlist/valueTokens';
import { attr, compositeModel, diodeModel, transistorModel } from './xmlModelLines';
import { FLAG_ESCAPE, VOLTAGE_PULSE_DUTY } from '../model/registry/flags';
import type { PlotMeasurements, Scope, ScopeValue } from '../engine/scopeModel';

import { CHIP_BIT_ORDER_BUS } from '../model/registry/elements/dFlipFlop';
import { DEFAULT_Q_STATE } from '../model/registry/elements/darlington';
import { normalizePoleCount } from '../model/registry/elements/dpdtSwitch';
import { boolToken } from '../model/registry/elements/switch';
import { defFor, defForDumpCode } from '../model/registry';
import { batteryTypeTables } from '../model/registry/elements/battery';
import { FRESH_CHILDREN as comparatorChildren } from '../model/registry/elements/comparator';
import { otaFreshChildren } from '../model/registry/elements/ota';

const FLAG_MODEL = 2;         // DiodeElm.java:22, shared by the LED
const FLAG_FWDROP = 1;        // DiodeElm.java:21
const CAP_RESISTANCE = 4;     // CapacitorElm.java:33
const CHIP_CUSTOM_VOLTAGE = 1 << 13;  // ChipElm.java:34
const FULL_ADDER_BITS = 2;    // FullAdderElm.java:25
const SRAM_HEX_DISPLAY = 4;   // SRAMElm.java:30
const SWITCH_LABEL = 4;       // SwitchElm.java:33

/** The `x` attribute: always `x1 y1 x2 y2`, the two endpoints every element's
 *  `setPoints` derives its other posts from (`setPositionFromXml` reads only
 *  these four, CircuitElm.java:602-610). */
function coords(node: XmlNode): string {
  const xs = (node.attrs.x ?? '').split(' ').filter((s) => s !== '');
  if (xs.length !== 4) throw new Error(`xml: ${node.tag} x attribute is not four integers`);
  for (const v of xs) {
    if (!Number.isFinite(Number(v))) {
      throw new Error(`xml: ${node.tag} x attribute is not four integers: ${node.attrs.x}`);
    }
  }
  return xs.join(' ');
}

interface ConvertContext {
  /** The mosfet models (`mm` tags), resolved by name for the `f` elements
   *  that reference them. */
  mosfetModels: Map<string, { threshold: number; beta: number }>;
  /** The emitted file slot of each XML element ordinal, in document order
   *  among the direct element children of `<cir>`. -1 marks a dropped
   *  element. Scope and slider lines use it to rewrite their index tokens. */
  slots: number[];
  /** The port kind of each XML element ordinal, for scope value decoding. */
  kinds: (string | null)[];
}

/** The trailing tokens each element tag carries, in the port's text order. */
type Writer = (node: XmlNode, ctx: ConvertContext) => (string | number)[] | null;

const WRITERS: Record<string, Writer> = {
  w: () => [],
  g: (n) => [attr(n, 'sy', 0)],
  r: (n) => [attr(n, 'r', 1000)],
  c: (n) => [attr(n, 'c', 1e-5), attr(n, 'vd', 0), attr(n, 'iv', 1e-3), attr(n, 'sr', 0)],
  pc: (n) => [
    attr(n, 'c', 1e-5),
    attr(n, 'vd', 0),
    attr(n, 'iv', 1e-3),
    attr(n, 'sr', 0),
    attr(n, 'mv', 0),
  ],
  l: (n) => [attr(n, 'l', 1e-3), attr(n, 'i', 0), attr(n, 'ic', 0), attr(n, 'isat', 0)],
  R: voltageTokens,
  v: voltageTokens,
  i: (n) => [attr(n, 'cu', 0.01), attr(n, 'mv', 0)],
  d: (n) => [n.attrs.mo ?? 'default'],
  t: (n) => [
    attr(n, 'pn', 1),
    attr(n, 'vbe', 0),
    attr(n, 'vbc', 0),
    attr(n, 'be', 100),
    ...(n.attrs.mo !== undefined ? [n.attrs.mo] : []),
  ],
  f: (n, ctx) => {
    const model = n.attrs.mo !== undefined ? ctx.mosfetModels.get(n.attrs.mo) : undefined;
    return [attr(n, 'vt', model?.threshold ?? 1.5), attr(n, 'be', model?.beta ?? 0.02)];
  },
  I: (n) => [attr(n, 'sl', 0.5), attr(n, 'hi', 5)],
  a: (n) => [attr(n, 'ma', 15), attr(n, 'mi', -15), 1e6, 0, 0, attr(n, 'ga', 100000)],
  O: (n) => [attr(n, 'sc', 0)],
  L: (n) => {
    const tokens: (string | number)[] = [
      attr(n, 'p', 0),
      // The mm attribute rides the same Boolean reader as the text format's
      // token (SwitchElm.java:63), so any case of the word means on.
      boolToken(n.attrs.mm) ? 'true' : 'false',
    ];
    if (n.attrs.lab !== undefined) tokens.push(n.attrs.lab);
    tokens.push(attr(n, 'hi', 5), attr(n, 'lo', 0));
    return tokens;
  },
  M: (n) => [attr(n, 'th', 2.5)],
  p: (n) => [attr(n, 'me', 0), attr(n, 'sc', 0), attr(n, 're', 1e7)],
  Line: () => [],
  x: (n) => [attr(n, 'si', 24), n.attrs.te ?? ''],
  LED: (n) => {
    const tail = [attr(n, 'cr', 1), attr(n, 'cg', 0), attr(n, 'cb', 0), attr(n, 'mbc', 0.01)];
    return n.attrs.mo !== undefined ? [n.attrs.mo, ...tail] : [2.1024259, ...tail];
  },
  ln: (n) => [n.attrs.te ?? ''],
  bs: (n) => chipTail(n, true, []),
  bli: (n) => [
    // The port's 435 stream: width, word, then the two levels. hiV/loV are
    // written unconditionally so the line is self-describing (the stop-trigger
    // precedent of carrying what upstream's text format would have dropped).
    attr(n, 'bw', 4),
    attr(n, 'va', 0),
    attr(n, 'hi', 5),
    attr(n, 'lo', 0),
  ],
  Battery: (n) => {
    // The port's 438 stream: r0, r1, c1, capacityAh, initialSocPercent,
    // batteryType, then the table as one token. Upstream writes the table as a
    // body text node for a custom battery only (BatteryElm.java:109-110); a
    // preset line takes the registry's table for its type so the line is
    // self-describing like the 435 row's rationale. The XML `isoc` is already
    // a 0..1 fraction, converted to the file's percent here (BatteryElm.java:
    // 107, :123).
    const bt = attr(n, 'bt', 1);
    const table =
      bt === -1
        ? n.text || batteryTypeTables[1]
        : batteryTypeTables[bt >= 0 && bt < batteryTypeTables.length ? bt : 1];
    return [
      attr(n, 'r0', 0.01),
      attr(n, 'r1', 0.02),
      attr(n, 'c1', 2000),
      attr(n, 'cap', 2),
      attr(n, 'isoc', 1) * 100,
      bt,
      table,
    ];
  },
  bt: (n) =>
    // The port's 437 stream: the needsBits bit count (the XML attribute is
    // `db`) plus the optional high voltage.
    chipTail(n, true, []).map((tok, i) => (i === 0 ? attr(n, 'db', 4) : tok)),
  And: gateTokens,
  Nand: gateTokens,
  Or: gateTokens,
  Nor: gateTokens,
  Xor: gateTokens,
  DFlipFlop: (n) => chipTail(n, false, [attr(n, 'v1', 0)]),
  PhaseComp: (n) => chipTail(n, false, []),
  VCO: (n) => chipTail(n, false, []),
  ADC: (n) => chipTail(n, true, []),
  FullAdder: (n) => chipTail(n, true, []),
  SevenSegDecoder: (n) => chipTail(n, false, [attr(n, 'sgt', 0)]),
  ssd: (n) => chipTail(n, false, [attr(n, 'ba', 7), attr(n, 'ex', 0), attr(n, 'di', 0)]),
  mux: (n) => {
    // The standard chip tail carries the select-bit count (`se`). In bus/bus
    // input mode (im="2") upstream's bus-in/bus-out layout is modelled, so the
    // text line also carries inputMode=2 and dataBusWidth=dw
    // (MultiplexerElm.java:69-72); the td4 family's ROM-to-data-bus wiring
    // then routes instead of degrading to single-bit. Mode 1 stays deferred.
    const tail = chipTail(n, false, [attr(n, 'se', 2)]);
    if (attr(n, 'im', 0) === 2) {
      tail.push(2);
      tail.push(attr(n, 'dw', 4));
    }
    return tail;
  },
  ins: (n) => [
    // The port's 434 stream: width, threshold, then the lookup table as one
    // escaped token (the body text upstream writes verbatim,
    // InstructionDisplayElm.java:38-45).
    attr(n, 'bw', 4),
    attr(n, 'th', 2.5),
    n.text ?? '',
  ],
  ctr2: (n) => {
    const bits = attr(n, 'bi', 4);
    const state: (string | number)[] = [];
    for (let i = 0; i < bits; i++) state.push(attr(n, `v${i}`, 0));
    return chipTail(n, true, [...state, attr(n, 'mo', 0)]);
  },
  dd: (n) => chipTail(n, false, [attr(n, 'bc', 4), attr(n, 'dm', 0)]),
  dmux: (n) =>
    // The demultiplexer writes only se beyond the base; needsBits is false,
    // so no bits token precedes it (DeMultiplexerElm.java:63-71). Its bus
    // output modes ride om/dw and stay behind a trace comment.
    chipTail(n, false, [attr(n, 'se', 2)]),
  ctr: (n) => {
    // CounterElm writes in (a Boolean string) and mo always, plus each saved
    // Q level as v{i} on pins 2..bits+1 (CounterElm.java:52-57). The port's
    // text order interleaves those levels between the high voltage and the
    // polarity pair. Lowercasing in mirrors Boolean.parseBoolean, which
    // accepts any case. The seed is false, upstream's invertreset field
    // default (CounterElm.java:28): parseBooleanAttr("in", ...) hands a
    // missing attribute back that default (CounterElm.java:60), an
    // active-HIGH reset.
    const bits = attr(n, 'bi', 4);
    const state: (string | number)[] = [];
    for (let i = 0; i < bits; i++) state.push(attr(n, `v${i + 2}`, 0));
    const invert = (n.attrs.in ?? 'false').toLowerCase();
    return chipTail(n, true, [...state, invert, attr(n, 'mo', 0)]);
  },
  TFlipFlop: (n) =>
    // Nothing beyond the base but the saved level of pin 1, the only state
    // pin (TFlipFlopElm.setupPins).
    chipTail(n, false, [attr(n, 'v1', 0)]),
  JKFlipFlop: (n) =>
    // Pin 3 (Q) is the only state pin (JKFlipFlopElm.setupPins).
    chipTail(n, false, [attr(n, 'v3', 0)]),
  Latch: (n) => {
    // The latch adds nothing of its own; its O outputs at pins
    // bits..2*bits-1 hold the state (makeBitPins, LatchElm.java:76-77),
    // which map onto voltage{bits+i} tokens.
    const bits = attr(n, 'bi', 4);
    const state: (string | number)[] = [];
    for (let i = 0; i < bits; i++) state.push(attr(n, `v${bits + i}`, 0));
    return chipTail(n, true, state);
  },
  ROM: romTokens,
  // The SRAM is the ROM's writer twin: same ab/db attrs and the same
  // body-run format (SRAMElm.dumpXmlModel shares ROMElm's contents text).
  SRAM: romTokens,
  cc: (n) => [n.attrs.mo ?? ''],
  cr: (n) => [
    `4_${attr(n, 'pc', 2.87e-11)}_0_0.001_0`,
    `4_${attr(n, 'sc', 1e-13)}_0_0.001_0`,
    `0_${attr(n, 'in', 0.0025)}_0_0_0`,
    `0_${attr(n, 'r', 6.4)}`,
  ],
  VCCS: (n) => [attr(n, 'ic', 2), n.attrs.ex ?? ''],
  VCVS: (n) => [attr(n, 'ic', 2), n.attrs.ex ?? ''],
  CCVS: (n) => [attr(n, 'ic', 2), n.attrs.ex ?? ''],
  Timer: (n) =>
    // The chip tail without a bits token (needsBits false): optional high
    // voltage, then the saved OUT level, pin 5 being the timer's only state
    // pin (TimerElm.java:55).
    chipTail(n, false, [attr(n, 'v5', 0)]),
  Comparator: () =>
    // ComparatorElm carries no fields of its own beyond the flags word, and
    // none of its three children saves state into the XML, so the line gets
    // exactly the child dumps a freshly built comparator holds.
    comparatorChildren,
  OTA: otaTokens,
  OpAmpReal: (n) => [
    // The port's four-token order (OpAmpRealElm.java:79-86); vd is the
    // compensation capacitor's saved charge, which upstream restores onto the
    // rebuilt model's capacitor (OpAmpRealElm.java:171-175).
    attr(n, 'slr', 0.6),
    attr(n, 'vd', 0),
    attr(n, 'cl', 0.0231),
    attr(n, 'mt', 0),
  ],
  DAC: (n) => chipTail(n, true, []),
  AnalogMux: (n) =>
    // AnalogMuxElm.dump appends selectBitCount r_on r_off threshold after the
    // base (:63-65); the class has needsBits false and no state pins.
    chipTail(n, false, [
      attr(n, 'sb', 2),
      attr(n, 'ron', 20),
      attr(n, 'rof', 1e10),
      attr(n, 'thr', 2.5),
    ]),
  DelayBuffer: (n) => [
    // delay threshold highVoltage, the reader's own order
    // (DelayBufferElm.java:39-45). A fresh part's delay field stays 0.
    attr(n, 'dl', 0),
    attr(n, 'th', 2.5),
    attr(n, 'hv', 5),
  ],
  as: analogSwitchTokens,
  as2: analogSwitchTokens,
  tt: (n) =>
    // TappedTransformerElm writes in/ra/co (TappedTransformerElm.java:74-76)
    // plus the coil currents as c0/c1/c2 state (:80-82); the text stream is
    // inductance ratio current0 current1 current2 couplingCoef (:67-70), so
    // every attribute has a home and the currents ride it too.
    [
      attr(n, 'in', 4),
      attr(n, 'ra', 1),
      attr(n, 'c0', 0),
      attr(n, 'c1', 0),
      attr(n, 'c2', 0),
      attr(n, 'co', 0.99),
    ],
  sw: (n) =>
    // SweepElm writes mi/ma/mv/sw (SweepElm.java:53-56), the minF maxF maxV
    // sweepTime order the registry's parse reads (sweep.ts:23-27).
    [attr(n, 'mi', 20), attr(n, 'ma', 4000), attr(n, 'mv', 5), attr(n, 'sw', 0.1)],
  tl: (n) =>
    // TransLineElm writes de/im/wi (TransLineElm.java:60-62). The trailing 0
    // is the series-resistance slot its own text dump always appends
    // (:54-56), unimplemented in both builds, so the converted line is
    // self-describing like the registry's own output.
    [attr(n, 'de', 0.005), attr(n, 'im', 75), attr(n, 'wi', 32), 0],
  ts: (n) =>
    // TriStateElm writes ron/roff/rog/hi (TriStateElm.java:75-78), the port's
    // r_on r_off r_off_ground highVoltage order. Missing attributes seed at
    // the registry's documented fresh defaults; rog deliberately seeds at the
    // file-first 0, not fresh placement's 1e8 pulldown (triState.ts).
    [attr(n, 'ron', 0.1), attr(n, 'roff', 1e10), attr(n, 'rog', 0), attr(n, 'hi', 5)],
  dar: (n) => {
    // DarlingtonElm carries only pnp in its XML (DarlingtonElm.java:54); the
    // two composite transistor state tokens stay fresh, which is exactly what
    // the registry's own dump writes for a part of either polarity, then the
    // sign token that drives the post layout (:46-48).
    const pnp = attr(n, 'pnp', 1);
    return [DEFAULT_Q_STATE, DEFAULT_Q_STATE, pnp < 0 ? -1 : 1];
  },
  dpdt: (n) => {
    // The SwitchElm base writes p/mm/lab/key/r (SwitchElm.java:71-83) and
    // DPDTSwitchElm adds po (:54); the port's stream is position, momentary,
    // the label under its flag bit, then the pole count
    // (DPDTSwitchElm.java:38-45). The keyboard shortcut is session-only in
    // both builds. The base on-resistance has no token on this stream.
    const momentary = (n.attrs.mm ?? 'false').toLowerCase() === 'true';
    // A hand-authored document may carry mm without p; upstream's
    // SwitchElm(xx, yy, mm) constructor pairs the two, so a momentary switch
    // is born pressed (:33-35). An explicit p always wins over the seed.
    const position = n.attrs.p !== undefined ? attr(n, 'p', 0) : momentary ? 1 : 0;
    const tokens: (string | number)[] = [position, momentary ? 'true' : 'false'];
    if (n.attrs.lab !== undefined) tokens.push(n.attrs.lab);
    tokens.push(attr(n, 'po', 2));
    return tokens;
  },
  pt: (n) => {
    // PotElm writes ma/po/sl (PotElm.java:79-81) onto the port's
    // maxResistance position caption stream. The caption splits on whitespace
    // exactly as the registry's own dump does, because upstream joins the
    // remaining tokens back with single spaces (PotElm.java:58-62); an absent
    // or empty caption takes the constructor default (:50).
    const caption = (n.attrs.sl ?? '').trim();
    return [
      attr(n, 'ma', 1000),
      attr(n, 'po', 0.5),
      ...(caption !== '' ? caption.split(/\s+/) : ['Resistance']),
    ];
  },
  ain: (n) =>
    // AudioInputElm writes ma/st/fi (AudioInputElm.java:98-101): the port's
    // short three-token form (audioInput.ts:56-66). The rail's six source
    // tokens stay implicit; the parse pins the waveform to AC regardless.
    [attr(n, 'ma', 5), attr(n, 'st', 0), attr(n, 'fi', 0)],
  aout: (n) =>
    // AudioOutputElm writes du/sa/la (AudioOutputElm.java:53-55), the same
    // duration samplingRate labelNum order its token constructor reads
    // (:39-46). sa seeds at the session-start sample rate, 8000
    // (AudioOutputElm.java:27).
    [attr(n, 'du', 1), attr(n, 'sa', 8000), attr(n, 'la', 0)],
};

/** r_on r_off threshold, the triple both analog switch classes carry in text
 *  (AnalogSwitchElm.java:58-60) and write as ron/roff/th in XML (:62-67). */
function analogSwitchTokens(n: XmlNode): (string | number)[] {
  return [attr(n, 'ron', 20), attr(n, 'roff', 1e10), attr(n, 'th', 2.5)];
}

/** The OTA's eighteen child dumps: fresh transistors behind rails re-derived
 *  from the pv/nv supplies, then any live junction state spliced in from the
 *  child elements CompositeElm.dumpXmlState appends once the circuit has run.
 *  Every state child is tagged "t": both transistor subclasses share the
 *  printable dump type 't', so getXmlDumpType answers "t" for either
 *  (CircuitElm.java:113-118, TransistorElm.java:101) and the tag says nothing
 *  about polarity. The child index alone picks the slot, whose fresh token
 *  already holds the right sign and beta, so only vbe/vbc move across
 *  (TransistorElm.java:112-115 writes exactly those). An index outside the
 *  sixteen transistor slots means the tags and positions disagree, which
 *  upstream itself refuses (CompositeElm.java:300-307). */
function otaTokens(node: XmlNode): (string | number)[] {
  const tokens = otaFreshChildren(attr(node, 'pv', 9), attr(node, 'nv', -9));
  for (const child of node.children) {
    if (child.tag !== 't') continue;
    const i = Math.trunc(attr(child, 'ix', -1));
    if (i < 2 || i >= tokens.length) {
      throw new Error(`xml: OTA child index out of range: ${child.attrs.ix}`);
    }
    const fields = tokens[i].split('_');
    fields[2] = String(attr(child, 'vbe', 0));
    fields[3] = String(attr(child, 'vbc', 0));
    tokens[i] = fields.join('_');
  }
  return tokens;
}

/** The `R`/`v` six-token stream (VoltageElm.java:45-56). The missing-fr seed
 *  is 60, not the text-format constructor's 40: upstream never writes fr for
 *  DC sources, so its XML reader meets a fresh element whose constructor set
 *  frequency = 60 (VoltageElm.java:57), and the port seeds fresh parts at 60
 *  too. */
function voltageTokens(n: XmlNode): (string | number)[] {
  return [
    attr(n, 'wf', 0),
    attr(n, 'fr', 60),
    attr(n, 'maxv', 5),
    attr(n, 'bias', 0),
    attr(n, 'phaseShift', 0),
    attr(n, 'dutyCycle', 0.5),
  ];
}

/** The gates' `inputCount lastOutputVoltage highVoltage` stream, the `o`
 *  attribute being the saved output level (GateElm.java:78-107). */
function gateTokens(n: XmlNode): (string | number)[] {
  return [attr(n, 'in', 2), attr(n, 'o', 0), attr(n, 'hi', 5)];
}

/** The common chip tail: a bits token when the type carries one, an optional
 *  high-voltage token (only under CHIP_CUSTOM_VOLTAGE, whose bit `flagsFor`
 *  sets), then the type's own tokens (ChipElm.java:48-56). */
function chipTail(node: XmlNode, hasBits: boolean, own: (string | number)[]): (string | number)[] {
  const hv = node.attrs.hv;
  const tail: (string | number)[] = [];
  if (hasBits) tail.push(attr(node, 'bi', 4));
  if (hv !== undefined && Number(hv) !== 5) tail.push(hv);
  tail.push(...own);
  return tail;
}

/** The ROM's contents: the XML body's `addr: val ...` lines become the port's
 *  run tokens (`startAddr vals... -1`, closed by `-2`). Values are hex when
 *  FLAG_HEX_DISPLAY (bit 4) is set, matching SRAMElm.parseNumber. */
function romTokens(node: XmlNode, _ctx: ConvertContext): (string | number)[] {
  const hex = (attr(node, 'f', 0) & SRAM_HEX_DISPLAY) !== 0;
  const parseNum = (s: string): number => {
    const t = s.trim();
    if (t.startsWith('0x')) return parseInt(t.slice(2), 16);
    if (hex) return parseInt(t, 16);
    if (t.startsWith('0b')) return parseInt(t.slice(2), 2);
    return parseInt(t, 10);
  };
  const pairs: [number, number][] = [];
  for (const line of node.text.split('\n')) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    let addr = parseNum(m[1]);
    for (const v of m[2].trim().split(/\s+/)) {
      if (v === '') continue;
      pairs.push([addr++, parseNum(v)]);
    }
  }
  const tail = chipTail(node, false, [attr(node, 'ab', 4), attr(node, 'db', 4)]);
  let i = 0;
  while (i < pairs.length) {
    tail.push(pairs[i][0]);
    let expect = pairs[i][0];
    while (i < pairs.length && pairs[i][0] === expect) {
      tail.push(pairs[i][1]);
      expect += 1;
      i += 1;
    }
    tail.push(-1);
  }
  if (pairs.length > 0) tail.push(-2);
  return tail;
}

/** The dump code each element tag maps to, upstream's `getDumpType`. */
const DUMP_CODES: Record<string, string> = {
  w: 'w', g: 'g', r: 'r', c: 'c', pc: '209', l: 'l',
  R: 'R', v: 'v', i: 'i', d: 'd', t: 't', f: 'f', I: 'I', a: 'a', O: 'O',
  L: 'L', M: 'M', p: 'p', x: 'x', LED: '162', ln: '207', bs: '433',
  bli: '435', bt: '437', Battery: '438',
  Line: '423',
  And: '150', Nand: '151', Or: '152', Nor: '153', Xor: '154',
  DFlipFlop: '155', PhaseComp: '161', VCO: '158', ADC: '167',
  FullAdder: '196', SevenSegDecoder: '197', ssd: '157', mux: '184',
  ctr2: '421', dd: '419', ROM: '436', cc: '410', cr: '412',
  VCCS: '213', VCVS: '212', CCVS: '214',
  ins: '434', SRAM: '413',
  dmux: '185', ctr: '164', TFlipFlop: '193', JKFlipFlop: '156', Latch: '168',
  Timer: '165', Comparator: '401', OTA: '402', OpAmpReal: '409', DAC: '166',
  AnalogMux: '432', DelayBuffer: '422', as: '159', as2: '160',
  tt: '169', sw: '170', tl: '171', pt: '174', ts: '180', dar: '400',
  aout: '211', ain: '411', dpdt: '429',
};

/** The tags upstream writes whose classes this port models but whose writers
 *  do not exist yet. Each degrades to its preserving comment plus one marker
 *  line naming the registry code the kind models it as. Data-driven on
 *  purpose: landing a writer means moving the tag into WRITERS,
 *  DUMP_CODES and KIND_BY_TAG, and this map shrinks with it instead of going
 *  stale like a hand list. Exported so the test suite can sweep every kind
 *  through the registry and catch a typo before a document does.
 *  Gyrator, NortonAmp (`nor`) and the composite chip stay plain comments
 *  because no port model sits behind them at all; marking their silence is
 *  out of scope by decision. PushSwitch is absent because its inherited dump
 *  type is `s`, so upstream's own tag map resolves the class-name form onto
 *  SwitchElm and it can never reach a document. */
export const UNCONVERTED_TAG_KINDS: Record<string, string> = {
  rl: 'relay',
  cl: 'customLogic',
  T: 'transformer',
  s: 'switch',
  S: 'switch2',
  A: 'antenna',
  b: 'box',
  m: 'memristor',
  Triac: 'triac',
  Diac: 'diac',
  SparkGap: 'sparkGap',
  TunnelDiode: 'tunnelDiode',
  Schmitt: 'schmitt',
  Monostable: 'monostable',
  HalfAdder: 'halfAdder',
  AM: 'am',
  FM: 'fm',
  VarRail: 'varRail',
  Triode: 'triode',
  CC2: 'cc2',
  CCCS: 'cccs',
  RingCounter: 'ringCounter',
  SeqGen: 'seqGen',
  DataRecorder: 'dataRecorder',
  OhmMeter: 'ohmmeter',
  TestPoint: 'testPoint',
  Ammeter: 'ammeter',
  LEDArray: 'ledArray',
  Optocoupler: 'optocoupler',
  StopTrigger: 'stopTrigger',
  Unijunction: 'unijunction',
  ExtVoltage: 'extVoltage',
  Wattmeter: 'wattmeter',
  DataInput: 'dataInput',
  TimeDelayRelay: 'timeDelayRelay',
  DCMotor: 'dcMotor',
  ThreePhaseMotor: 'threePhaseMotor',
  CrossSwitch: 'crossSwitch',
  MotorProtectionSwitch: 'motorProtectionSwitch',
  MBBSwitch: 'mbbSwitch',
};

/** The port kind each element tag maps to, for scope value decoding. The
 *  unconverted tags spread in first so an explicit entry always wins once a
 *  tag gains a writer. */
const KIND_BY_TAG: Record<string, string> = {
  ...UNCONVERTED_TAG_KINDS,
  w: 'wire', g: 'ground', r: 'resistor', c: 'capacitor', pc: 'polarizedCapacitor',
  l: 'inductor', R: 'rail', v: 'voltage', i: 'current', d: 'diode', t: 'transistor',
  f: 'mosfet', I: 'inverter', a: 'opamp', O: 'output',   L: 'logicInput', M: 'logicOutput', p: 'probe',
  Line: 'line',
  x: 'decoration', LED: 'led', ln: 'labeledNode', bs: 'busSplitter',
  bli: 'busLogicInput', bt: 'busTransceiver', Battery: 'battery',
  And: 'andGate', Nand: 'nandGate', Or: 'orGate', Nor: 'norGate', Xor: 'xorGate',
  DFlipFlop: 'dFlipFlop', PhaseComp: 'phaseComp', VCO: 'vco', ADC: 'adc',
  FullAdder: 'fullAdder', SevenSegDecoder: 'sevenSegDecoder', ssd: 'sevenSeg',
  mux: 'multiplexer', ctr2: 'counter2', dd: 'decimalDisplay', ROM: 'rom',
  cc: 'customComposite', cr: 'crystal', VCCS: 'vccs', VCVS: 'vcvs', CCVS: 'ccvs',
  ins: 'instructionDisplay', SRAM: 'sram',
  dmux: 'deMultiplexer', ctr: 'counter', TFlipFlop: 'tFlipFlop',
  JKFlipFlop: 'jkFlipFlop', Latch: 'latch',
  Timer: 'timer', Comparator: 'comparator', OTA: 'ota', OpAmpReal: 'opampReal',
  DAC: 'dac', AnalogMux: 'analogMux', DelayBuffer: 'delayBuffer',
  as: 'analogSwitch', as2: 'analogSwitch2',
  tt: 'tappedTransformer', sw: 'sweep', tl: 'transmissionLine', pt: 'potentiometer',
  ts: 'triState', dar: 'darlington', dpdt: 'dpdtSwitch', ain: 'audioInput',
  aout: 'audioOutput',
};

/** The flags an element line carries: the XML `f` plus the bits the port's own
 *  writer sets, so a converted file parses back to the same state and the next
 *  save does not change it. */
function flagsFor(node: XmlNode): number {
  let f = attr(node, 'f', 0);
  const tag = node.tag;
  if (tag === 'c' || tag === 'pc') f |= CAP_RESISTANCE;
  if (tag === 'R' || tag === 'v') {
    if (attr(node, 'wf', 0) === 5) f |= VOLTAGE_PULSE_DUTY;
  }
  if (tag === 'd') f |= FLAG_MODEL;
  if (tag === 'LED') f |= node.attrs.mo !== undefined ? FLAG_MODEL : FLAG_FWDROP;
  if (tag === 'x' || tag === 'ln') f |= FLAG_ESCAPE;
  if (tag === 'L' && node.attrs.lab !== undefined) f |= SWITCH_LABEL;
  // The DPDT's label rides the same SwitchElm flag bit as the SPST's
  // (SwitchElm.java:77-78 dump, :89 read); without it the parse would read
  // the label token as the pole count.
  if (tag === 'dpdt' && node.attrs.lab !== undefined) f |= SWITCH_LABEL;
  if (tag === 'FullAdder') f |= FULL_ADDER_BITS;
  const hv = node.attrs.hv;
  if (
    (tag === 'DFlipFlop' || tag === 'PhaseComp' || tag === 'VCO' || tag === 'ADC' ||
      tag === 'FullAdder' || tag === 'SevenSegDecoder' || tag === 'ssd' || tag === 'mux' ||
      tag === 'ctr2' || tag === 'dd' || tag === 'ROM' || tag === 'bs' || tag === 'bt' ||
      tag === 'dmux' || tag === 'ctr' || tag === 'TFlipFlop' || tag === 'JKFlipFlop' ||
      tag === 'Latch' || tag === 'Timer' || tag === 'DAC' || tag === 'AnalogMux') &&
    hv !== undefined &&
    Number(hv) !== 5
  ) {
    f |= CHIP_CUSTOM_VOLTAGE;
  }
  // The chip bit order has no text-format home: upstream carries it as the
  // XML attribute `bo` (ChipElm.java:381-405), and bo="2" is BIT_ORDER_BUS,
  // under which every bit-pin group collapses onto one tagged coordinate.
  // Dropping it would rebuild the chips three rows taller with the pins spread
  // out, and every wire, ground and rail drawn against the real geometry would
  // land on the wrong pin, which is exactly how the td4 family went singular.
  // The port parks the state in its free chip flag bit instead. Only the
  // kinds whose bus layout exists end to end honour it (see BO_HONOURED);
  // the rest get a visible trace comment from droppedTraces.
  if (
    BO_HONOURED.has(tag) &&
    attr(node, 'bo', 0) === 2
  ) {
    f |= CHIP_BIT_ORDER_BUS;
  }
  return f;
}

/** The tags whose bus bit order this build honours: counter2, fullAdder,
 *  SRAM and ROM have bus-mode pin layouts in the registry and per-post bit
 *  tags in the engine. */
const BO_HONOURED = new Set(['ctr2', 'FullAdder', 'ROM', 'SRAM']);

/** Every ChipElm-subclass tag upstream writes a `bo` attribute onto when its
 *  bit order is not MSB first (allowBus, ChipElm.java:484): the honoured four
 *  plus ADC, DAC, Counter, Latch, DecimalDisplay, the seven-segment decoders
 *  and the bus transceiver. A nonzero bo on any of these outside
 *  [`BO_HONOURED`] changes the pin layout upstream builds, so it must never
 *  vanish quietly. */
const BO_TAGS = new Set([
  ...BO_HONOURED,
  'ADC',
  'DAC',
  // CounterElm's getXmlDumpType is "ctr" (CounterElm.java:175), so the class
  // name never appears as a tag; the tag string is what reaches a document.
  'ctr',
  'Latch',
  'dd',
  // SevenSegElm's getXmlDumpType returns "ssd" (SevenSegElm.java:337), so
  // ssd is the live seven-segment-display tag and allowBus whenever
  // diodeDirection is 0 (SevenSegElm.java:82). BusTransceiverElm has no
  // override, so its tag defaults to the class name. The dead forms SevenSeg
  // and bt never appear in a document, so bo can never ride them.
  'SevenSegDecoder',
  'ssd',
  'BusTransceiver',
]);

/** Visible trace comments for attributes a converted line cannot carry.
 *  Everything here keeps semantics upstream would have built; losing them
 *  silently would make a loaded circuit look right and behave wrong. */
function droppedTraces(node: XmlNode): string[] {
  const traces: string[] = [];
  const tag = node.tag;
  // Sources carry two XML attributes the six-token stream has no home for:
  // ir is a series resistor upstream builds onto an internal third node when
  // nonzero (VoltageElm.java:148-157) and riseTime ramps a pulse or square's
  // edges (:179-180). Gate on value against the defaults, never on presence,
  // matching the om/dw rule below.
  if (tag === 'R' || tag === 'v') {
    if (attr(node, 'ir', 0) !== 0) {
      traces.push(
        `# ${tag} ir="${node.attrs.ir}" not modelled: converted as an ideal source without internal resistance`,
      );
    }
    if (attr(node, 'riseTime', 0) !== 0) {
      traces.push(
        `# ${tag} riseTime="${node.attrs.riseTime}" not modelled: pulse edges step instantly`,
      );
    }
  }
  if (tag === 'mux') {
    // MultiplexerElm.java:32-37: inputMode 1 (bus in / single out, the bit
    // selector) has no text-format home and no corpus user, so it stays
    // deferred and converts to the single-bit shape. Mode 2 (bus in / bus out)
    // is modelled, so it carries inputMode/dataBusWidth tokens instead of a
    // trace comment.
    if (attr(node, 'im', 0) === 1) {
      traces.push(
        `# mux im="1" not modelled: converted as individual inputs with one output`,
      );
    }
  }
  // Gate on value, not presence: a hand-written om="0" or dw="4" is the
  // modelled default and deserves no "not modelled" note.
  if (tag === 'dmux' && (attr(node, 'om', 0) !== 0 || attr(node, 'dw', 4) !== 4)) {
    // DeMultiplexerElm.java:31-36: output modes 1 and 2 route buses, which
    // the port models only for the multiplexer. The line keeps the
    // individual-output shape under a visible trace.
    traces.push(
      `# dmux om="${node.attrs.om ?? 0}" dw="${node.attrs.dw ?? 4}" not modelled: converted as individual outputs`,
    );
  }
  if (tag === 'ts' && attr(node, 'bw', 1) !== 1) {
    // TriStateElm.java:79-80 writes busWidth only when it exceeds one, and
    // this build models single-bit tri-states only.
    traces.push(`# ts bw="${node.attrs.bw}" not modelled: converted as single-bit`);
  }
  if (tag === 'dpdt') {
    // Fresh DPDT parts are two-pole in both builds; any other count converts
    // with its pole token but stays visible, normalised the way the port's
    // own load clamps it.
    const po = attr(node, 'po', 2);
    if (po !== 2) {
      const poles = normalizePoleCount(po);
      traces.push(`# dpdt po="${node.attrs.po}" not default: converted as a ${poles}-pole switch`);
    }
  }
  if (tag === 'pt' && attr(node, 'li', 0) !== 0) {
    // PotElm.java:82-83 writes the link only when nonzero; shared sliders
    // parse but never link in this port.
    traces.push(`# pt li="${node.attrs.li}" not modelled: converted without its slider link`);
  }
  if (BO_TAGS.has(tag) && attr(node, 'bo', 0) !== 0) {
    if (!BO_HONOURED.has(tag)) {
      traces.push(`# ${tag} bo="${node.attrs.bo}" not modelled: converted as non-bus pin rows`);
    } else if (attr(node, 'bo', 0) !== 2) {
      // Only BIT_ORDER_BUS is carried; LSB first would flip row order within
      // every pin group, which the registry defs do not lay out.
      traces.push(`# ${tag} bo="${node.attrs.bo}" not modelled: bit order stays MSB first`);
    }
  }
  return traces;
}

/** Escapes one string token like the serializer does; numeric tokens pass
 *  through (serialize.ts:62-67). */
function token(value: string | number): string {
  return typeof value === 'string' ? escapeToken(value) : String(value);
}

/** One element line, or several for a routed wire's segments, or null when the
 *  tag has no port model. */
function elementLines(node: XmlNode, ctx: ConvertContext): string[] | null {
  const tag = node.tag;
  if (tag === 'rw') {
    // A routed wire is electrically identical to straight segments; emit one
    // `w` per consecutive point pair so the circuit actually connects. A bus
    // routed wire (bw > 1) carries its width on every segment it becomes; a
    // tokenless one needs none, because the width pass re-derives it from the
    // wide pins the segments touch.
    const points = node.text
      .split(';')
      .map((p) => p.split(','))
      .filter((p) => p.length === 2 && p.every((v) => Number.isFinite(Number(v))));
    if (points.length < 2) return null;
    const bw = attr(node, 'bw', 1);
    const lines: string[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const head = ['w', ...points[i], ...points[i + 1], attr(node, 'f', 0)];
      lines.push((bw > 1 ? [...head, bw] : head).join(' '));
    }
    return lines;
  }
  const writer = WRITERS[tag];
  if (writer === undefined) return null;
  const tail = writer(node, ctx);
  if (tail === null) return null;
  // Raw-token kinds read their tails verbatim (parse.ts hands rawTokens defs
  // the un-unescaped tokens), so their strings must not be escaped here or a
  // reload would corrupt exactly what the registry's own dump writes back.
  const raw = defForDumpCode(DUMP_CODES[tag])?.rawTokens ?? false;
  return [basic(node, DUMP_CODES[tag], tail.map(raw ? String : token))];
}

function basic(node: XmlNode, code: string, tail: string[]): string {
  return [code, coords(node), flagsFor(node), ...tail].join(' ');
}

/** Serialises an XML element node as a `#` comment, preserving every attribute
 *  and the body text so a save round-trips it. Newlines in the body are escaped
 *  so the comment stays one line: the text format is line-oriented, and a
 *  multi-line comment's continuation lines would read as garbage element
 *  lines. */
function commentLine(node: XmlNode): string {
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  const text = node.text.replace(/\r\n|\r|\n/g, '\\n');
  const body = text !== '' || node.children.length > 0 ? `>${text}</${node.tag}>` : '/>';
  return `# ${node.tag} ${attrs}${body}`;
}

/** The `<o>` scope element to a text `o` line. The index tokens are rewritten
 *  to the converted file's ordinals; a scope whose target was dropped writes
 *  -1. */
function scopeLine(node: XmlNode, ctx: ConvertContext): string {
  const flags = importDecOrHex(node.attrs.f ?? '0');
  const decoded = scopeFieldsFromFlags(flags);
  const en = attr(node, 'en', -1);
  const slotOf = (index: number): number | undefined => ctx.slots[index];

  const plots: {
    value: ScopeValue | null;
    elementId: number | null;
    acCoupled: boolean;
    measurements: PlotMeasurements | null;
    manScale: number | null;
    manVPosition: number;
  }[] = [];
  // Plot kinds in plot order, the list the encoder decides scale tokens
  // against exactly as the decoders do.
  const kinds: (string | null)[] = [];
  let scaleV = 20;
  let scaleA = 0.05;
  let sawScaleV = false;
  let sawScaleA = false;
  for (const p of node.children) {
    if (p.tag !== 'p') continue;
    const e = p.attrs.e !== undefined ? attr(p, 'e', en) : en;
    const v = p.attrs.v !== undefined ? attr(p, 'v', -1) : -1;
    const kind = ctx.kinds[e] ?? null;
    const value = scopeValueFromToken(v, kind);
    const plotFlags = p.attrs.f !== undefined ? parseInt(p.attrs.f, 16) : 0;
    const sc = p.attrs.sc !== undefined ? attr(p, 'sc', -1) : -1;
    const units = unitsOf(v, kind);
    if (sc >= 0) {
      if (units <= 0 && !sawScaleV) {
        scaleV = sc;
        sawScaleV = true;
      } else if (units === 1 && !sawScaleA) {
        scaleA = sc;
        sawScaleA = true;
      }
    }
    const ms = p.attrs.ms !== undefined ? attr(p, 'ms', -1) : -1;
    plots.push({
      value,
      elementId: e >= 0 ? e : null,
      acCoupled: (plotFlags & 1) !== 0,
      // An XML attribute word never carries the port's measurement bits, so a
      // converted plot always inherits the scope word.
      measurements: null,
      manScale: ms >= 0 ? ms : null,
      manVPosition: p.attrs.mp !== undefined ? attr(p, 'mp', 0) : 0,
    });
    kinds.push(kind);
  }
  const scope = {
    ...decoded,
    speed: attr(node, 'sp', 64),
    position: attr(node, 'p', 0),
    manDivisions: attr(node, 'md', 8),
    label: node.attrs.x ?? '',
    scaleV,
    scaleA,
    plots,
  } as unknown as Scope;
  const raw = encodeScopeLine(scope, (id) => slotOf(id), kinds);
  return ['o', slotOf(en) ?? -1, ...raw].join(' ');
}

/** The `<adj>` slider to a `38` line, the port's own new-slider form
 *  (serialize.ts:159-176): `e F<flags> editItem min max [shared] text step`. */
function sliderLine(node: XmlNode, ctx: ConvertContext): string {
  const e = attr(node, 'e', -1);
  const shared = node.attrs.ss !== undefined ? attr(node, 'ss', -1) : null;
  const flags = (shared !== null && shared >= 0 ? 1 : 0) | (attr(node, 'log', 0) !== 0 ? 2 : 0);
  const tokens: (string | number)[] = [
    '38',
    ctx.slots[e] ?? -1,
    `F${flags}`,
    attr(node, 'ei', 0),
    attr(node, 'mn', 1),
    attr(node, 'mx', 1000),
  ];
  if (shared !== null && shared >= 0) tokens.push(shared);
  tokens.push(escapeToken(node.attrs.st ?? ''));
  tokens.push(node.attrs.stp !== undefined ? attr(node, 'stp', 0) : 0);
  return tokens.join(' ');
}

/** The `mm` mosfet model: no text line of its own (mosfet models have none),
 *  but its `vt`/`be` feed the `f` elements that name it. */
function mosfetModel(node: XmlNode, ctx: ConvertContext): void {
  const name = node.attrs.nm;
  if (name !== undefined) {
    ctx.mosfetModels.set(name, {
      threshold: attr(node, 'vt', 1.5),
      beta: attr(node, 'be', 0.02),
    });
  }
}

/** The tags that are model definitions or directives, never element lines. */
const MODEL_TAGS = new Set(['mm', 'dm', 'tm', 'ccm', 'rlm', 'clm']);

/** Converts a `<cir>` document to the text format. Throws on malformed XML or
 *  a malformed attribute; the caller lets the error surface as a load error. */
export function xmlToText(source: string): string {
  const root = parseXml(source);
  const cir = root.children.find((c) => c.tag === 'cir');
  if (cir === undefined) throw new Error('xml: no <cir> root element');

  const ctx: ConvertContext = { mosfetModels: new Map(), slots: [], kinds: [] };
  const header = [
    '$',
    attr(cir, 'f', 0),
    attr(cir, 'ts', 0.000005),
    attr(cir, 'ic', 10),
    attr(cir, 'cb', 50),
    attr(cir, 'vr', 5),
    attr(cir, 'pb', 50),
    attr(cir, 'mts', 50e-12),
  ].join(' ');

  const elementLinesOut: string[] = [];
  const modelLines: string[] = [];
  const scopeLinesOut: string[] = [];
  const sliderLinesOut: string[] = [];
  const passthrough: string[] = [];

  // A first pass classifies the element ordinals the scopes and sliders count
  // against, so the index rewriting below is correct regardless of where the
  // `o`/`adj` lines sit in the document.
  const xmlElements = cir.children.filter(
    (c) => c.tag !== 'o' && c.tag !== 'adj' && c.tag !== 'h' && !MODEL_TAGS.has(c.tag),
  );
  ctx.kinds = xmlElements.map((c) => (c.tag === 'rw' ? 'wire' : (KIND_BY_TAG[c.tag] ?? null)));

  let slot = 0;
  for (const node of cir.children) {
    const tag = node.tag;
    if (tag === 'o') {
      scopeLinesOut.push(scopeLine(node, ctx));
      continue;
    }
    if (tag === 'adj') {
      sliderLinesOut.push(sliderLine(node, ctx));
      continue;
    }
    if (tag === 'h') {
      passthrough.push(`h ${attr(node, 't', -1)} ${attr(node, 'i1', 0)} ${attr(node, 'i2', 0)}`);
      continue;
    }
    if (tag === 'mm') {
      mosfetModel(node, ctx);
      continue;
    }
    if (tag === 'dm') {
      modelLines.push(diodeModel(node));
      continue;
    }
    if (tag === 'tm') {
      modelLines.push(transistorModel(node));
      continue;
    }
    if (tag === 'ccm') {
      modelLines.push(compositeModel(node));
      continue;
    }
    if (tag === 'rlm' || tag === 'clm' || tag === 'scopedata' || tag === 'switchevent' || tag === 'test') {
      passthrough.push(commentLine(node));
      continue;
    }
    // `ext` only appears inside a `ccm` (an external pin); at the `<cir>`
    // level a `p` is a ProbeElm element, handled by the writers.
    if (tag === 'ext') continue;

    const lines = elementLines(node, ctx);
    if (lines === null) {
      ctx.slots.push(-1);
      passthrough.push(commentLine(node));
      // A tag the port models but cannot convert yet gains one marker line
      // directly under its comment. Both ride passthrough, so neither takes
      // a file slot: scope and slider ordinals hold, and a plot aimed at the
      // degraded element itself keeps writing -1.
      const kind = UNCONVERTED_TAG_KINDS[tag];
      if (kind !== undefined) {
        passthrough.push(
          `# ${tag} not converted: this build models it as code ${defFor(kind)?.dumpCode}`,
        );
      }
    } else {
      // A trace comment rides directly under the line it describes but must
      // not take a file slot: only real element lines shift the ordinals the
      // scope and slider lines count against.
      elementLinesOut.push(...lines, ...droppedTraces(node));
      ctx.slots.push(slot);
      slot += lines.length;
    }
  }

  return [header, ...modelLines, ...elementLinesOut, ...scopeLinesOut, ...sliderLinesOut, ...passthrough].join('\n') + '\n';
}
