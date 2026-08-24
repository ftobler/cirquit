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
 * classes that still have no port model (Clock, Gyrator, NortonAmp,
 * CustomCompositeChip) become `#` comment lines so nothing is lost; a routed
 * wire's path is electrically identical to straight `w` segments, so those
 * convert to real wires. Where an element converts but an attribute it
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
 */

import { parseXml, type XmlNode } from './xml';
import { escapeToken } from './netlist/tokens';
import { encodeScopeLine, scopeFieldsFromFlags } from './scopeLine';
import { importDecOrHex, scopeValueFromToken } from './netlist/parse';
import { FLAG_ESCAPE, VOLTAGE_PULSE_DUTY } from '../model/registry/flags';
import type { PlotMeasurements, Scope, ScopeValue } from '../engine/simulator';

import { CHIP_BIT_ORDER_BUS } from '../model/registry/elements/dFlipFlop';
import { batteryTypeTables } from '../model/registry/elements/battery';

const FLAG_MODEL = 2;         // DiodeElm.java:22, shared by the LED
const FLAG_FWDROP = 1;        // DiodeElm.java:21
const CAP_RESISTANCE = 4;     // CapacitorElm.java:33
const CHIP_CUSTOM_VOLTAGE = 1 << 13;  // ChipElm.java:34
const FULL_ADDER_BITS = 2;    // FullAdderElm.java:25
const SRAM_HEX_DISPLAY = 4;   // SRAMElm.java:30
const SWITCH_LABEL = 4;       // SwitchElm.java:33

/** Reads an attribute as a number, falling back on absence and throwing on
 *  garbage so a broken file fails loudly instead of producing a wrong line. */
function attr(node: XmlNode, name: string, fallback: number): number {
  const v = node.attrs[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`xml: ${node.tag} attribute ${name} is not a number: ${v}`);
  return n;
}

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
      n.attrs.mm === 'true' ? 'true' : 'false',
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
    // polarity pair.
    const bits = attr(n, 'bi', 4);
    const state: (string | number)[] = [];
    for (let i = 0; i < bits; i++) state.push(attr(n, `v${i + 2}`, 0));
    return chipTail(n, true, [...state, n.attrs.in ?? 'true', attr(n, 'mo', 0)]);
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
};

/** The `R`/`v` six-token stream (VoltageElm.java:45-56). */
function voltageTokens(n: XmlNode): (string | number)[] {
  return [
    attr(n, 'wf', 0),
    attr(n, 'fr', 40),
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
 *  high-voltage token (only under FLAG_CUSTOM_VOLTAGE, whose bit `flagsFor`
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
};

/** The port kind each element tag maps to, for scope value decoding. */
const KIND_BY_TAG: Record<string, string> = {
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
  if (tag === 'FullAdder') f |= FULL_ADDER_BITS;
  const hv = node.attrs.hv;
  if (
    (tag === 'DFlipFlop' || tag === 'PhaseComp' || tag === 'VCO' || tag === 'ADC' ||
      tag === 'FullAdder' || tag === 'SevenSegDecoder' || tag === 'ssd' || tag === 'mux' ||
      tag === 'ctr2' || tag === 'dd' || tag === 'ROM' || tag === 'bs' || tag === 'bt' ||
      tag === 'dmux' || tag === 'ctr' || tag === 'TFlipFlop' || tag === 'JKFlipFlop' ||
      tag === 'Latch') &&
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
  'SevenSegDecoder',
  'SevenSeg',
  'ssd',
  'bt',
  'BusTransceiver',
]);

/** Visible trace comments for attributes a converted line cannot carry.
 *  Everything here keeps semantics upstream would have built; losing them
 *  silently would make a loaded circuit look right and behave wrong. */
function droppedTraces(node: XmlNode): string[] {
  const traces: string[] = [];
  const tag = node.tag;
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
  if (tag === 'dmux' && (node.attrs.om !== undefined || node.attrs.dw !== undefined)) {
    // DeMultiplexerElm.java:29-33: output modes 1 and 2 route buses, which
    // the port models only for the multiplexer. The line keeps the
    // individual-output shape under a visible trace.
    traces.push(
      `# dmux om="${node.attrs.om ?? 0}" dw="${node.attrs.dw ?? 4}" not modelled: converted as individual outputs`,
    );
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
  return [basic(node, DUMP_CODES[tag], tail.map(token))];
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
    const units = unitsOfToken(v, kind);
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

/** The units index a plot's value token plots in, mirroring `unitsOf`
 *  (parse.ts:156-168). */
function unitsOfToken(tok: number, kind: string | null): number {
  if (kind === 'lamp' && tok === 2) return 3;
  if ((kind === 'capacitor' || kind === 'polarizedCapacitor') && tok === 8) return 4;
  if (kind === 'transistor') {
    if (tok === 1 || tok === 2 || tok === 3) return 1;
    if (tok === 7) return 2;
    return 0;
  }
  if (tok === 1) return 2;
  if (tok === 3) return 1;
  if (tok === 7) return 2;
  return 0;
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

/** The `dm` diode model to a `34` line (DiodeModel.dump, DiodeModel.java:277-286). */
function diodeModel(node: XmlNode): string {
  return [
    '34',
    escapeToken(node.attrs.nm ?? ''),
    attr(node, 'f', 0),
    attr(node, 'is', 1e-14),
    attr(node, 'rs', 0),
    attr(node, 'n', 1),
    attr(node, 'bv', 0),
    attr(node, 'fi', 0),
  ].join(' ');
}

/** The `tm` transistor model to a `32` line (TransistorModel.dump,
 *  TransistorModel.java:205-234). */
function transistorModel(node: XmlNode): string {
  const tail: (string | number)[] = [
    '32',
    escapeToken(node.attrs.nm ?? ''),
    attr(node, 'f', 0),
    attr(node, 'is', 5e-13),
    attr(node, 'ikf', 0),
    attr(node, 'ise', 0),
    attr(node, 'ne', 1.5),
    attr(node, 'ikr', 0),
    attr(node, 'isc', 0),
    attr(node, 'nc', 2),
    attr(node, 'nf', 1),
    attr(node, 'nr', 1),
    attr(node, 'vaf', 0),
    attr(node, 'var', 0),
    attr(node, 'br', 3),
  ];
  for (const a of ['cje', 'vje', 'mje', 'cjc', 'vjc', 'mjc', 'tf', 'tr']) {
    if (node.attrs[a] !== undefined) tail.push(attr(node, a, 0));
  }
  return tail.join(' ');
}

/** One `ccm` custom-composite model to a `.` line: the size, the external
 *  pins (bus entries expanded under `bcs`), and the escaped child model lines
 *  and dump tokens (CustomCompositeModel.buildXmlElement). The engine builds
 *  only the child kinds it has composite models for; the rest ride the line
 *  and round-trip. */
function compositeModel(node: XmlNode): string {
  const bcs = attr(node, 'bcs', 0) !== 0;
  const ext: (string | number)[] = [];
  let count = 0;
  const lines: string[] = [];
  const dumps: string[] = [];
  for (const child of node.children) {
    if (child.tag === 'ext') {
      const bw = attr(child, 'bw', 1);
      const name = child.attrs.nm ?? '';
      const nd = attr(child, 'nd', 0);
      const ps = attr(child, 'ps', 0);
      const sd = attr(child, 'sd', 0);
      if (bcs && bw > 1) {
        for (let j = 0; j < bw; j++) {
          ext.push(escapeToken(name), nd + j, ps, sd);
          count += 1;
        }
      } else {
        ext.push(escapeToken(name), nd, ps, sd);
        count += 1;
      }
      continue;
    }
    const className = CHILD_CLASS[child.tag];
    if (className !== undefined && child.attrs.nn !== undefined) {
      const nodes = child.attrs.nn.split(' ').map((v) => Number(v));
      lines.push(`${className} ${nodes.join(' ')}`);
      // The engine indexes the dump tokens by model-line position
      // (composite.rs, `dumps.get(i)`), so the two lists have to stay in step:
      // a child that contributes no line contributes no dump either, and one
      // whose tag carries no fields still contributes its flags.
      dumps.push(escapeChildField(childDumpToken(child) ?? String(attr(child, 'f', 0))));
    }
  }
  return [
    '.',
    escapeToken(node.attrs.nm ?? ''),
    attr(node, 'f', 0),
    attr(node, 'sx', 1),
    attr(node, 'sy', 1),
    count,
    ext.join(' '),
    escapeToken(lines.join('\r')),
    escapeToken(dumps.join(' ')),
  ].join(' ');
}

/** The upstream class name a ccm child's model line starts with. */
const CHILD_CLASS: Record<string, string> = {
  And: 'AndGateElm',
  Or: 'OrGateElm',
  Nand: 'NandGateElm',
  Nor: 'NorGateElm',
  Xor: 'XorGateElm',
  I: 'InverterElm',
  d: 'DiodeElm',
  w: 'WireElm',
  rw: 'RoutedWireElm',
  ln: 'LabeledNodeElm',
  cc: 'CustomCompositeElm',
};

/** One ccm child's `_`-joined dump token: its flags then its fields, the shape
 *  `composite.rs`'s `apply_dump` splits. Gates carry inputCount/output/high
 *  voltage; wires and labeled nodes carry nothing. */
function childDumpToken(node: XmlNode): string | null {
  const tag = node.tag;
  const f = attr(node, 'f', 0);
  if (tag === 'And' || tag === 'Or' || tag === 'Nand' || tag === 'Nor' || tag === 'Xor') {
    return [f, attr(node, 'in', 2), attr(node, 'o', 0), attr(node, 'hi', 5)].join('_');
  }
  if (tag === 'I') return [f, attr(node, 'sl', 0.5), attr(node, 'hi', 5)].join('_');
  if (tag === 'd') return [f, node.attrs.mo ?? 'default'].join('_');
  if (tag === 'cc') return [f, node.attrs.mo ?? ''].join('_');
  if (tag === 'w' || tag === 'rw' || tag === 'ln') return String(f);
  return null;
}

/** Escapes one field of a `_`-joined dump token (`_`, space and backslash), so
 *  the join's separators stay unambiguous (subcircuits.ts:806-815). */
function escapeChildField(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/_/g, '\\u').replace(/ /g, '\\s');
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
