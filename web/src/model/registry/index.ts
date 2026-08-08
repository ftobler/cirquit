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

import { FLAG_SWAP, MOSFET_FLIP, MOSFET_PNP, TRANSFORMER_FLIP, TRANSFORMER_VERTICAL, TAPPED_FLIP, TRI_STATE_FLIP } from './flags';
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
import { VOLTAGE_DEF } from './elements/voltage';
import { RAIL_DEF } from './elements/rail';
import { VAR_RAIL_DEF } from './elements/varRail';
import { EXT_VOLTAGE_DEF } from './elements/extVoltage';
import { SWEEP_DEF } from './elements/sweep';
import { AUDIO_OUTPUT_DEF } from './elements/audioOutput';
import { AMMETER_DEF } from './elements/ammeter';
import { ANTENNA_DEF } from './elements/antenna';
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
import { TUNNEL_DIODE_DEF } from './elements/tunnelDiode';
import { JFET_DEF } from './elements/jfet';
import { MOSFET_DEF } from './elements/mosfet';
import { MULTIPLEXER_DEF } from './elements/multiplexer';
import { NOISE_DEF } from './elements/noise';
import { SWITCH_DEF } from './elements/switch';
import { SWITCH2_DEF } from './elements/switch2';
import { ANALOG_SWITCH_DEF } from './elements/analogSwitch';
import { ANALOG_SWITCH2_DEF } from './elements/analogSwitch2';
import { TRANSFORMER_DEF, TAPPED_TRANSFORMER_DEF, CUSTOM_TRANSFORMER_DEF } from './elements/transformer';
import { TRANSMISSION_LINE_DEF } from './elements/transmissionLine';
import { TIMER_DEF } from './elements/timer';
import { RELAY_DEF, RELAY_COIL_DEF, RELAY_CONTACT_DEF } from './elements/relay';
import { OPAMP_DEF } from './elements/opamp';
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
import { INVERTER_DEF } from './elements/inverter';
import { LOGIC_INPUT_DEF } from './elements/logicInput';
import { SCHMITT_DEF, INVERTING_SCHMITT_DEF } from './elements/schmitt';
import { SEVEN_SEG_DEF } from './elements/sevenSeg';
import { SCR_DEF } from './elements/scr';
import { SPARK_GAP_DEF } from './elements/sparkGap';
import { TRI_STATE_DEF } from './elements/triState';
import { LABELED_NODE_DEF } from './elements/labeledNode';
import { OUTPUT_DEF } from './elements/output';
import { LOGIC_OUTPUT_DEF } from './elements/logicOutput';
import { PROBE_DEF } from './elements/probe';
import { DECORATION_DEF } from './elements/decoration';
import type { CircuitElement, ElementDef, Point } from '../types';

export { FLAG_SWAP, MOSFET_FLIP, MOSFET_PNP, TRANSFORMER_FLIP, TRANSFORMER_VERTICAL, TAPPED_FLIP, TRI_STATE_FLIP };
export { switchLever, switchLeverTip, switchIecPoints, groundBars };
export { opampInputSign, opAmpInputAnchors, opAmpLabelAnchors } from './elements/opamp';
export { transistorSideFactor, transistorBarContacts, transistorArrowTip } from './elements/transistor';
export { switch2Poles } from './elements/switch2';
export { zenerMarks } from './elements/diode';
export { potWiperGeometry } from './elements/potentiometer';
export { railLead, railText, railLabelAnchor, railValueText, railValueAnchor, RAIL_CIRCLE } from './elements/rail';
export { gateInverting, gateInputCount, gatePosts } from './elements/gate';

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
  SWITCH_DEF,
  SWITCH2_DEF,
  ANALOG_SWITCH_DEF,
  ANALOG_SWITCH2_DEF,
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
  VAR_RAIL_DEF,
  EXT_VOLTAGE_DEF,
  SWEEP_DEF,
  AUDIO_OUTPUT_DEF,
  VCO_DEF,
  DAC_DEF,
  ADC_DEF,
  CURRENT_DEF,
  DIODE_DEF,
  ZENER_DEF,
  VARACTOR_DEF,
  LED_DEF,
  TUNNEL_DIODE_DEF,
  TRANSISTOR_DEF,
  JFET_DEF,
  MOSFET_DEF,
  MULTIPLEXER_DEF,
  OPAMP_DEF,
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
  INVERTER_DEF,
  LOGIC_INPUT_DEF,
  SCHMITT_DEF,
  INVERTING_SCHMITT_DEF,
  SEVEN_SEG_DEF,
  SCR_DEF,
  SPARK_GAP_DEF,
  TRI_STATE_DEF,
  LABELED_NODE_DEF,
  OUTPUT_DEF,
  LOGIC_OUTPUT_DEF,
  PROBE_DEF,
  AMMETER_DEF,
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
}

const SPLIT_SEMICONDUCTORS: ToolboxEntry[] = [
  {
    id: 'npn',
    kind: 'transistor',
    label: 'NPN',
    category: 'Semiconductors',
    defaults: { pnp: 1, beta: 100 },
  },
  {
    id: 'pnp',
    kind: 'transistor',
    label: 'PNP',
    category: 'Semiconductors',
    defaults: { pnp: -1, beta: 100 },
  },
  {
    id: 'nmos',
    kind: 'mosfet',
    label: 'N-MOSFET',
    category: 'Semiconductors',
    defaults: { pnp: 1, beta: 0.02, threshold: 1.5 },
  },
  {
    id: 'pmos',
    kind: 'mosfet',
    label: 'P-MOSFET',
    category: 'Semiconductors',
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
];

/** Every pickable tool, in display order within each category. */
export const TOOLBOX: ToolboxEntry[] = [
  ...ELEMENT_DEFS.filter((d) => d.kind !== 'transistor' && d.kind !== 'mosfet' && d.kind !== 'jfet').map((d) => ({
    id: d.kind,
    kind: d.kind,
    label: d.label,
    category: d.category,
  })),
  ...SPLIT_SEMICONDUCTORS,
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
