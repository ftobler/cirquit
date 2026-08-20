/**
 * The element registry.
 *
 * Each entry owns everything the TypeScript side knows about a type: where its
 * terminals are, how it is drawn, which properties are editable, and how it
 * maps to the original file format. The Rust engine holds the matching
 * simulation model, keyed by the same `kind` string.
 *
 * To add an element: write the model in `engine/core/src/elements`, register
 * its kind there, then add a definition here in `elements/`.
 */

import { FLAG_SWAP, MOSFET_FLIP, MOSFET_PNP, OPAMP_SWAP, TRANSFORMER_FLIP, TRANSFORMER_VERTICAL, TAPPED_FLIP, TRIODE_DSIGN_FIX, TRIODE_FLIP, TRI_STATE_FLIP } from './flags';
import { switchLever, switchLeverTip, switchIecPoints, groundBars } from './shared';
import { WIRE_DEF } from './elements/wire';
import { ADC_DEF } from './elements/adc';
import { GROUND_DEF } from './elements/ground';
import { RESISTOR_DEF } from './elements/resistor';
import { CAPACITOR_DEF } from './elements/capacitor';
import { POLARIZED_CAPACITOR_DEF } from './elements/polarizedCapacitor';
import { INDUCTOR_DEF } from './elements/inductor';
import { FUSE_DEF } from './elements/fuse';
import { LAMP_DEF } from './elements/lamp';
import { THERMISTOR_DEF } from './elements/thermistor';
import { POTENTIOMETER_DEF } from './elements/potentiometer';
import { LDR_DEF } from './elements/ldr';
import { MEMRISTOR_DEF } from './elements/memristor';
import { MOTOR_PROTECTION_SWITCH_DEF } from './elements/motorProtectionSwitch';
import { THREE_PHASE_MOTOR_DEF } from './elements/threePhaseMotor';
import { DC_MOTOR_DEF } from './elements/dcMotor';
import { TIME_DELAY_RELAY_DEF } from './elements/timeDelayRelay';
import { MBB_SWITCH_DEF } from './elements/mbbSwitch';
import { DPDT_SWITCH_DEF } from './elements/dpdtSwitch';
import { VOLTAGE_DEF } from './elements/voltage';
import { RAIL_DEF } from './elements/rail';
import { VAR_RAIL_DEF } from './elements/varRail';
import { EXT_VOLTAGE_DEF } from './elements/extVoltage';
import { SWEEP_DEF } from './elements/sweep';
import { AUDIO_OUTPUT_DEF } from './elements/audioOutput';
import { AUDIO_INPUT_DEF } from './elements/audioInput';
import { DATA_INPUT_DEF } from './elements/dataInput';
import { DELAY_BUFFER_DEF } from './elements/delayBuffer';
import { AMMETER_DEF } from './elements/ammeter';
import { ANTENNA_DEF } from './elements/antenna';
import { AM_DEF } from './elements/am';
import { FM_DEF } from './elements/fm';
import { BOX_DEF } from './elements/box';
import { LINE_DEF } from './elements/line';
import { SCOPE_DEF } from './elements/scope';
import { VCO_DEF } from './elements/vco';
import { CURRENT_DEF } from './elements/current';
import { DIODE_DEF } from './elements/diode';
import { ZENER_DEF } from './elements/zener';
import { VARACTOR_DEF } from './elements/varactor';
import { LED_DEF } from './elements/led';
import { TRANSISTOR_DEF } from './elements/transistor';
import { DARLINGTON_DEF } from './elements/darlington';
import { DIAC_DEF } from './elements/diac';
import { TUNNEL_DIODE_DEF } from './elements/tunnelDiode';
import { TRIAC_DEF } from './elements/triac';
import { TRIODE_DEF } from './elements/triode';
import { JFET_DEF } from './elements/jfet';
import { MOSFET_DEF } from './elements/mosfet';
import { LED_ARRAY_DEF } from './elements/ledArray';
import { MULTIPLEXER_DEF } from './elements/multiplexer';
import { NOISE_DEF } from './elements/noise';
import { SWITCH_DEF } from './elements/switch';
import { SWITCH2_DEF } from './elements/switch2';
import { CROSS_SWITCH_DEF } from './elements/crossSwitch';
import { ANALOG_SWITCH_DEF } from './elements/analogSwitch';
import { ANALOG_SWITCH2_DEF } from './elements/analogSwitch2';
import { ANALOG_MUX_DEF } from './elements/analogMux';
import { BUS_SPLITTER_DEF } from './elements/busSplitter';
import { TRANSFORMER_DEF, TAPPED_TRANSFORMER_DEF, CUSTOM_TRANSFORMER_DEF } from './elements/transformer';
import { TRANSMISSION_LINE_DEF } from './elements/transmissionLine';
import { TIMER_DEF } from './elements/timer';
import { RELAY_DEF, RELAY_COIL_DEF, RELAY_CONTACT_DEF } from './elements/relay';
import { OPAMP_DEF } from './elements/opamp';
import { OPAMP_REAL_DEF } from './elements/opampReal';
import { OTA_DEF } from './elements/ota';
import { COMPARATOR_DEF } from './elements/comparator';
import { OPTOCOUPLER_DEF } from './elements/optocoupler';
import { CRYSTAL_DEF } from './elements/crystal';
import { PHASE_COMP_DEF } from './elements/phaseComp';
import { AND_GATE_DEF, NAND_GATE_DEF, OR_GATE_DEF, NOR_GATE_DEF, XOR_GATE_DEF, XNOR_GATE_DEF } from './elements/gate';
import { DFLIPFLOP_DEF } from './elements/dFlipFlop';
import { DAC_DEF } from './elements/dac';
import { DECIMAL_DISPLAY_DEF } from './elements/decimalDisplay';
import { DEMULTIPLEXER_DEF } from './elements/deMultiplexer';
import { JKFLIPFLOP_DEF } from './elements/jkFlipFlop';
import { TFLIPFLOP_DEF } from './elements/tFlipFlop';
import { LATCH_DEF } from './elements/latch';
import { RING_COUNTER_DEF } from './elements/ringCounter';
import { COUNTER_DEF } from './elements/counter';
import { COUNTER2_DEF } from './elements/counter2';
import { HALF_ADDER_DEF } from './elements/halfAdder';
import { FULL_ADDER_DEF } from './elements/fullAdder';
import { PISO_SHIFT_DEF } from './elements/pisoShift';
import { SIPO_SHIFT_DEF } from './elements/sipoShift';
import { SEQ_GEN_DEF } from './elements/seqGen';
import { MONOSTABLE_DEF } from './elements/monostable';
import { INVERTER_DEF } from './elements/inverter';
import { LOGIC_INPUT_DEF } from './elements/logicInput';
import { SCHMITT_DEF, INVERTING_SCHMITT_DEF } from './elements/schmitt';
import { SEVEN_SEG_DEF } from './elements/sevenSeg';
import { SEVEN_SEG_DECODER_DEF } from './elements/sevenSegDecoder';
import { SRAM_DEF } from './elements/sram';
import { ROM_DEF } from './elements/rom';
import { SCR_DEF } from './elements/scr';
import { CC2_DEF } from './elements/cc2';
import { VCVS_DEF } from './elements/vcvs';
import { VCCS_DEF } from './elements/vccs';
import { CCVS_DEF } from './elements/ccvs';
import { CCCS_DEF } from './elements/cccs';
import { UNIJUNCTION_DEF } from './elements/unijunction';
import { CUSTOM_LOGIC_DEF } from './elements/customLogic';
import { CUSTOM_COMPOSITE_DEF } from './elements/customComposite';
import { SPARK_GAP_DEF } from './elements/sparkGap';
import { TRI_STATE_DEF } from './elements/triState';
import { LABELED_NODE_DEF } from './elements/labeledNode';
import { INSTRUCTION_DISPLAY_DEF } from './elements/instructionDisplay';
import { OUTPUT_DEF } from './elements/output';
import { LOGIC_OUTPUT_DEF } from './elements/logicOutput';
import { PROBE_DEF } from './elements/probe';
import { OHMMETER_DEF } from './elements/ohmmeter';
import { TEST_POINT_DEF } from './elements/testPoint';
import { WATTMETER_DEF } from './elements/wattmeter';
import { DATA_RECORDER_DEF } from './elements/dataRecorder';
import { STOP_TRIGGER_DEF } from './elements/stopTrigger';
import { DECORATION_DEF } from './elements/decoration';
import type { CircuitElement, ElementDef, Point } from '../types';

export { FLAG_SWAP, MOSFET_FLIP, MOSFET_PNP, TRANSFORMER_FLIP, TRANSFORMER_VERTICAL, TAPPED_FLIP, TRIODE_DSIGN_FIX, TRIODE_FLIP, TRI_STATE_FLIP };
export { switchLever, switchLeverTip, switchIecPoints, groundBars };
export { opampInputSign, opAmpInputAnchors, opAmpLabelAnchors } from './elements/opamp';
export { otaGeometry } from './elements/ota';
export { transistorSideFactor, transistorBarContacts, transistorArrowTip } from './elements/transistor';
export { switch2Poles } from './elements/switch2';
export { zenerMarks } from './elements/diode';
export { potWiperGeometry } from './elements/potentiometer';
export { railLead, railText, railLabelAnchor, railValueText, railValueAnchor, RAIL_CIRCLE } from './elements/rail';
export { gateInverting, gateInputCount, gatePosts } from './elements/gate';
export { UJT_FLIP } from './elements/unijunction';

export const ELEMENT_DEFS: ElementDef[] = [
  WIRE_DEF,
  GROUND_DEF,
  RESISTOR_DEF,
  CAPACITOR_DEF,
  POLARIZED_CAPACITOR_DEF,
  INDUCTOR_DEF,
  FUSE_DEF,
  LAMP_DEF,
  THERMISTOR_DEF,
  POTENTIOMETER_DEF,
  LDR_DEF,
  MEMRISTOR_DEF,
  THREE_PHASE_MOTOR_DEF,
  MOTOR_PROTECTION_SWITCH_DEF,
  DC_MOTOR_DEF,
  TIME_DELAY_RELAY_DEF,
  SWITCH_DEF,
  SWITCH2_DEF,
  CROSS_SWITCH_DEF,
  MBB_SWITCH_DEF,
  DPDT_SWITCH_DEF,
  ANALOG_SWITCH_DEF,
  ANALOG_SWITCH2_DEF,
  ANALOG_MUX_DEF,
  BUS_SPLITTER_DEF,
  TRANSFORMER_DEF,
  TAPPED_TRANSFORMER_DEF,
  CUSTOM_TRANSFORMER_DEF,
  TRANSMISSION_LINE_DEF,
  TIMER_DEF,
  RELAY_DEF,
  RELAY_COIL_DEF,
  RELAY_CONTACT_DEF,
  VOLTAGE_DEF,
  RAIL_DEF,
  NOISE_DEF,
  ANTENNA_DEF,
  AM_DEF,
  FM_DEF,
  VAR_RAIL_DEF,
  EXT_VOLTAGE_DEF,
  SWEEP_DEF,
  AUDIO_OUTPUT_DEF,
  AUDIO_INPUT_DEF,
  DATA_INPUT_DEF,
  VCO_DEF,
  DAC_DEF,
  ADC_DEF,
  CURRENT_DEF,
  DARLINGTON_DEF,
  DIODE_DEF,
  ZENER_DEF,
  VARACTOR_DEF,
  LED_DEF,
  LED_ARRAY_DEF,
  TUNNEL_DIODE_DEF,
  DIAC_DEF,
  TRANSISTOR_DEF,
  JFET_DEF,
  MOSFET_DEF,
  TRIODE_DEF,
  MULTIPLEXER_DEF,
  OPAMP_DEF,
  OTA_DEF,
  COMPARATOR_DEF,
  OPAMP_REAL_DEF,
  OPTOCOUPLER_DEF,
  CRYSTAL_DEF,
  PHASE_COMP_DEF,
  AND_GATE_DEF,
  NAND_GATE_DEF,
  OR_GATE_DEF,
  NOR_GATE_DEF,
  XOR_GATE_DEF,
  XNOR_GATE_DEF,
  DFLIPFLOP_DEF,
  DECIMAL_DISPLAY_DEF,
  DEMULTIPLEXER_DEF,
  JKFLIPFLOP_DEF,
  TFLIPFLOP_DEF,
  LATCH_DEF,
  RING_COUNTER_DEF,
  COUNTER_DEF,
  COUNTER2_DEF,
  HALF_ADDER_DEF,
  FULL_ADDER_DEF,
  PISO_SHIFT_DEF,
  SIPO_SHIFT_DEF,
  SEQ_GEN_DEF,
  MONOSTABLE_DEF,
  INVERTER_DEF,
  DELAY_BUFFER_DEF,
  LOGIC_INPUT_DEF,
  SCHMITT_DEF,
  INVERTING_SCHMITT_DEF,
  SEVEN_SEG_DEF,
  SEVEN_SEG_DECODER_DEF,
  SRAM_DEF,
  ROM_DEF,
  SCR_DEF,
  CC2_DEF,
  VCVS_DEF,
  VCCS_DEF,
  CCVS_DEF,
  CCCS_DEF,
  UNIJUNCTION_DEF,
  CUSTOM_LOGIC_DEF,
  CUSTOM_COMPOSITE_DEF,
  TRIAC_DEF,
  SPARK_GAP_DEF,
  TRI_STATE_DEF,
  LABELED_NODE_DEF,
  OUTPUT_DEF,
  LOGIC_OUTPUT_DEF,
  INSTRUCTION_DISPLAY_DEF,
  PROBE_DEF,
  AMMETER_DEF,
  OHMMETER_DEF,
  TEST_POINT_DEF,
  WATTMETER_DEF,
  DATA_RECORDER_DEF,
  STOP_TRIGGER_DEF,
  DECORATION_DEF,
  BOX_DEF,
  LINE_DEF,
  SCOPE_DEF,
];

const BY_KIND = new Map(ELEMENT_DEFS.map((d) => [d.kind, d]));
const BY_DUMP_CODE = new Map(ELEMENT_DEFS.map((d) => [d.dumpCode, d]));

export function defFor(kind: string): ElementDef | undefined {
  return BY_KIND.get(kind);
}

export function defForDumpCode(code: string): ElementDef | undefined {
  return BY_DUMP_CODE.get(code);
}

/** Terminal coordinates for an element, or an empty list for unknown types. */
export function postsOf(e: CircuitElement): Point[] {
  return defFor(e.kind)?.posts(e) ?? [];
}

/** The terminal count a def actually has. Only the custom composite defines
 *  `postCountOf`, because its post count is set by the resolved model rather
 *  than by the def; every other def's static `postCount` is exact and is the
 *  fallback. The rotate, drag-post and collapsed-axis gates read this so a
 *  resolved composite is treated as the part it is instead of as its fallback
 *  stub. */
export function postCountOf(e: CircuitElement): number {
  return defFor(e.kind)?.postCountOf?.(e) ?? defFor(e.kind)?.postCount ?? 0;
}

/** True when an element must always sit on its dominant axis: it either
 *  carries upstream's `noDiagonal` flag (CircuitElm.java:99) or has more than
 *  two connectable terminals, the owner's rule. The OR keeps upstream's
 *  two-post noDiagonal parts (inverter, Schmitt trigger) constrained without
 *  declaring the flag on the multi-post parts upstream leaves unmarked, so
 *  the def files stay truthful to upstream. */
export function axisConstrained(e: CircuitElement): boolean {
  const def = defFor(e.kind);
  return (def?.noDiagonal ?? false) || postCountOf(e) > 2;
}

/** Snap a placement drag's far endpoint to the dominant axis: the stronger of
 *  the drag's x and y deltas wins, so the element cannot land diagonal
 *  (CircuitElm.java:560-566). */
export function dominantAxisSnap(start: Point, x2: number, y2: number): Point {
  if (Math.abs(x2 - start.x) < Math.abs(y2 - start.y)) return { x: start.x, y: y2 };
  return { x: x2, y: start.y };
}

/** Constrain a single-endpoint drag so an axis-locked element can only stretch
 *  along its existing axis: a horizontal body keeps the dragged post on its
 *  row, a vertical one on its column (upstream's movePoint, CircuitElm.java:
 *  661-666). Without this a post drag could rotate the element off the grid. */
export function constrainPostDrag(e: CircuitElement, post: 1 | 2, x: number, y: number): Point {
  if (e.x1 === e.x2) return { x: post === 1 ? e.x1 : e.x2, y };
  return { x, y: post === 1 ? e.y1 : e.y2 };
}

/** Toolbox groupings, in display order. */
export const CATEGORIES = ['Basics', 'Sources', 'Semiconductors', 'Active', 'Logic', 'Other'];

/**
 * One pickable tool. Most kinds appear once, mirroring their `ElementDef`;
 * the transistor and mosfet each appear twice so the N and P flavours are
 * separate menu items, as they are upstream. Repeating a kind is only legal
 * here because `makeToolElement` merges `defaults` over the def's own, so the
 * engine and the file format still see one kind.
 */
export interface ToolboxEntry {
  /** Stored in `state.tool` while this tool is armed. Usually the kind. */
  id: string;
  kind: string;
  label: string;
  category: string;
  /** Params merged over the def's defaults when a part is placed. */
  defaults?: Record<string, number>;
  /** Upstream placement char for the split N/P flavours, which one `kind`
   *  cannot carry (`shortcut` on the def would leave the second char out).
   *  Only the four split semiconductors have it: NPN/PNP and N-/P-channel
   *  each need their own key, so the char lives where the flavour does. */
  shortcut?: string;
  /** Flag bits set on every placed part, on top of the def's `defaultFlags`:
   *  the swapped op-amp reuses the `opamp` kind and dump code `a` but is placed
   *  with `OPAMP_SWAP` already on, upstream's `OpAmpSwapElm` (OpAmpSwapElm.java).
   *  Params cannot carry a flag, so a flag-only variant needs its own slot. */
  flags?: number;
}

const SPLIT_SEMICONDUCTORS: ToolboxEntry[] = [
  {
    id: 'npn',
    kind: 'transistor',
    label: 'NPN',
    category: 'Semiconductors',
    shortcut: 'n',  // NTransistorElm.java
    defaults: { pnp: 1, beta: 100 },
  },
  {
    id: 'pnp',
    kind: 'transistor',
    label: 'PNP',
    category: 'Semiconductors',
    shortcut: 'p',  // PTransistorElm.java
    defaults: { pnp: -1, beta: 100 },
  },
  {
    id: 'nmos',
    kind: 'mosfet',
    label: 'N-MOSFET',
    category: 'Semiconductors',
    shortcut: 'N',  // NMosfetElm.java
    defaults: { pnp: 1, beta: 0.02, threshold: 1.5 },
  },
  {
    id: 'pmos',
    kind: 'mosfet',
    label: 'P-MOSFET',
    category: 'Semiconductors',
    shortcut: 'P',  // PMosfetElm.java
    defaults: { pnp: -1, beta: 0.02, threshold: 1.5 },
  },
  {
    id: 'njfet',
    kind: 'jfet',
    label: 'N-JFET',
    category: 'Semiconductors',
    defaults: { pnp: 1, beta: 0.00125, threshold: -4 },
  },
  {
    id: 'pjfet',
    kind: 'jfet',
    label: 'P-JFET',
    category: 'Semiconductors',
    defaults: { pnp: -1, beta: 0.00125, threshold: -4 },
  },
  {
    id: 'npndarlington',
    kind: 'darlington',
    label: 'NPN Darlington',
    category: 'Semiconductors',
    defaults: { pnp: 1 },
  },
  {
    id: 'pnpdarlington',
    kind: 'darlington',
    label: 'PNP Darlington',
    category: 'Semiconductors',
    defaults: { pnp: -1 },
  },
];

/** The swapped op-amp reuses the `opamp` kind and dump code `a`; the only
 *  difference from the plain op-amp is `FLAG_SWAP` set on placement, upstream's
 *  `OpAmpSwapElm` (OpAmpSwapElm.java). One kind, two menu tools, and both dump
 *  as `a`, so a file written by either reloads as the right one via the flag. */
const SWAPPED_OPAMPS: ToolboxEntry[] = [
  {
    id: 'opampSwap',
    kind: 'opamp',
    label: 'Swapped Op-Amp',
    category: 'Active',
    shortcut: 'A',  // OpAmpSwapElm.java getShortcut
    flags: OPAMP_SWAP,
  },
];

/** Every pickable tool, in display order within each category. */
export const TOOLBOX: ToolboxEntry[] = [
  ...ELEMENT_DEFS.filter((d) => d.kind !== 'transistor' && d.kind !== 'mosfet' && d.kind !== 'jfet' && d.kind !== 'darlington').map((d) => ({
    id: d.kind,
    kind: d.kind,
    label: d.label,
    category: d.category,
  })),
  ...SPLIT_SEMICONDUCTORS,
  ...SWAPPED_OPAMPS,
];

const TOOLBOX_BY_ID = new Map(TOOLBOX.map((t) => [t.id, t]));

/** The toolbox entry backing a tool id, falling back to the kind itself. */
export function toolboxEntry(tool: string): ToolboxEntry {
  return TOOLBOX_BY_ID.get(tool) ?? { id: tool, kind: tool, label: tool, category: 'Other' };
}

/** The element definition behind a tool id, for defaults and geometry. */
export function toolDef(tool: string): ElementDef | undefined {
  return defFor(toolboxEntry(tool).kind);
}

/**
 * The placement-shortcut map: upstream's `getShortcut()` char to the tool or
 * kind it arms, keyed by the exact char because case is significant ('p' and
 * 'P' are different elements, UIManager.java:1397-1406's registration loop).
 * Scanned from the defs and the split toolbox entries, so a shortcut lives
 * next to the element that declares it and cannot drift from it.
 */
export const PLACEMENT_BY_CHAR: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const d of ELEMENT_DEFS) {
    if (d.shortcut !== undefined) m.set(d.shortcut, d.kind);
  }
  for (const t of TOOLBOX) {
    if (t.shortcut !== undefined) m.set(t.shortcut, t.id);
  }
  return m;
})();
