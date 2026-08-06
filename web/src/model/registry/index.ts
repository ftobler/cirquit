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

import { FLAG_SWAP } from './flags';
import { switchLeverTip } from './shared';
import { WIRE_DEF } from './elements/wire';
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
import { VOLTAGE_DEF } from './elements/voltage';
import { RAIL_DEF } from './elements/rail';
import { CURRENT_DEF } from './elements/current';
import { DIODE_DEF } from './elements/diode';
import { ZENER_DEF } from './elements/zener';
import { VARACTOR_DEF } from './elements/varactor';
import { TRANSISTOR_DEF } from './elements/transistor';
import { SWITCH_DEF } from './elements/switch';
import { SWITCH2_DEF } from './elements/switch2';
import { OPAMP_DEF } from './elements/opamp';
import { LABELED_NODE_DEF } from './elements/labeledNode';
import { OUTPUT_DEF } from './elements/output';
import { PROBE_DEF } from './elements/probe';
import { DECORATION_DEF } from './elements/decoration';
import type { CircuitElement, ElementDef, Point } from '../types';

export { FLAG_SWAP };
export { switchLeverTip };
export { opampInputSign, opAmpInputAnchors, opAmpLabelAnchors } from './elements/opamp';
export { transistorSideFactor, transistorBarContacts } from './elements/transistor';

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
  SWITCH_DEF,
  SWITCH2_DEF,
  VOLTAGE_DEF,
  RAIL_DEF,
  CURRENT_DEF,
  DIODE_DEF,
  ZENER_DEF,
  VARACTOR_DEF,
  TRANSISTOR_DEF,
  OPAMP_DEF,
  LABELED_NODE_DEF,
  OUTPUT_DEF,
  PROBE_DEF,
  DECORATION_DEF,
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
export const CATEGORIES = ['Basics', 'Sources', 'Semiconductors', 'Active', 'Other'];
