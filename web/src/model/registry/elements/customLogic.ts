/**
 * Custom logic (CustomLogicElm.java, dump 208): a chip whose pin table and
 * behaviour come from a named model defined by a `!` netlist line. The model
 * names its west inputs and east outputs; the engine evaluates the model's
 * rule table every step. The pin count is therefore model-derived, with a
 * 4-input / 2-output fallback while the model is unresolvable or the part is
 * freshly placed.
 *
 * Token layout after the common fields is the model name as one escaped token
 * then one output-voltage token per output pin (CustomLogicElm.java:24-36),
 * restoring each output's saved level. Unlike the other chips there is no
 * `bits` and no high-voltage token: the model fixes the post count and the
 * high logic level is the chip default of 5 V.
 *
 * The resolved model rides to the engine in `e.model`, which the netlist
 * second pass fills from the `!` library. `e.text` is the model name, so the
 * Model Name field is a plain text field targeting it, and a rename forces a
 * reload because it can change the post count.
 */

import { chipBodyRect, chipPosts, drawChip, type ChipPinDef } from './dFlipFlop';
import type { CustomLogicModel } from '../../../io/netlist/types';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** Model name written for a part with none, matching upstream's fresh-model
 *  name (CustomLogicElm.java:16). */
const DEFAULT_MODEL_NAME = 'default';

/** The fallback pin counts while the model is unresolvable (the plan's
 *  default, wider than upstream's 2/2 default model). */
const FALLBACK_INPUTS = 4;
const FALLBACK_OUTPUTS = 2;

/** The resolved model, or undefined while none is bound. The `model` carrier
 *  is shared with the OTA's raw child-dump array, the composite's engine spec
 *  and the battery's plain table string (none of which ever appear on a
 *  custom-logic element), so a string, an array or a spec-bearing object is
 *  treated as absent. */
function customLogicModel(e: CircuitElement): CustomLogicModel | undefined {
  if (typeof e.model === 'string') return undefined;
  return e.model !== undefined && !Array.isArray(e.model) && !('external' in e.model)
    ? e.model
    : undefined;
}

/** The input pin count, from the resolved model or the fallback. */
export function customLogicInputs(e: CircuitElement): number {
  return customLogicModel(e)?.inputs.length ?? FALLBACK_INPUTS;
}

/** The output pin count, from the resolved model or the fallback. */
export function customLogicOutputs(e: CircuitElement): number {
  return customLogicModel(e)?.outputs.length ?? FALLBACK_OUTPUTS;
}

/** The chip's cell height, `sizeY` from setupPins (CustomLogicElm.java:69-71):
 *  the larger side, never fewer than 1 row. */
function customLogicSizeY(e: CircuitElement): number {
  return Math.max(customLogicInputs(e), customLogicOutputs(e), 1);
}

/** A pin's label: the model's name for the position when it has one, else the
 *  A.. letters upstream's default model uses (CustomLogicModel.java:65-66). */
function customLogicPinText(name: string | undefined, i: number): string {
  if (name !== undefined) return name;
  return String.fromCharCode(65 + i);
}

/** The pin table, from `setupPins` (CustomLogicElm.java:75-88): the inputs on
 *  the west rows 0.. and the outputs on the east rows 0.., both from the top. */
export function customLogicPins(e: CircuitElement): ChipPinDef[] {
  const inputs = customLogicInputs(e);
  const outputs = customLogicOutputs(e);
  const pins: ChipPinDef[] = [];
  for (let i = 0; i < inputs; i++) {
    pins.push({ side: 'W', pos: i, text: customLogicPinText(customLogicModel(e)?.inputs[i], i) });
  }
  for (let i = 0; i < outputs; i++) {
    pins.push({
      side: 'E',
      pos: i,
      text: customLogicPinText(customLogicModel(e)?.outputs[i], inputs + i),
    });
  }
  return pins;
}

function drawCustomLogic(g: DrawContext, e: CircuitElement): void {
  drawChip(g, e, 2, customLogicSizeY(e), customLogicPins(e));
}

export const CUSTOM_LOGIC_DEF: ElementDef = {
  kind: 'customLogic',
  label: 'Custom Logic',
  category: 'Logic',
  dumpCode: '208',
  postCount: FALLBACK_INPUTS + FALLBACK_OUTPUTS, // 6 at the fallback width
  posts: (e) => chipPosts(e, 2, customLogicSizeY(e), customLogicPins(e)),
  bodyRect: (e) => chipBodyRect(e, 2, customLogicSizeY(e)),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 6, // the chip spans (sizeX + 1) * 32
  parse: (t, e) => {
    // `<modelName> <outputVoltage...>`: the escaped model name then one
    // voltage per output pin (CustomLogicElm.java:24-36). The output count is
    // only known once the model resolves, so every trailing token is read
    // into `voltage{k}` keyed by output ordinal, the same keys the engine's
    // own state restore reads.
    if (t[0] !== undefined) e.text = t[0];
    t.slice(1).forEach((v, k) => {
      const n = Number(v);
      if (Number.isFinite(n)) e.params[`voltage${k}`] = n;
    });
  },
  dump: (e) => [
    e.text ?? DEFAULT_MODEL_NAME,
    ...Array.from({ length: customLogicOutputs(e) }, (_, k) => e.params[`voltage${k}`] ?? 0),
  ],
  fields: [{ name: 'modelName', label: 'Model Name', type: 'text', target: 'text' }],
  draw: drawCustomLogic,
};
