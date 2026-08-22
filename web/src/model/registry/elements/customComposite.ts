/**
 * Custom composite (CustomCompositeElm.java, dump 410): a chip whose pin table,
 * body size and behaviour come from a named subcircuit model defined by a `.`
 * netlist line, or held in the subcircuit library (session map or storage).
 * The chip geometry is exactly what a CustomCompositeChipElm draws: the
 * model's `extList` pins on its sides and the model's `sizeX`/`sizeY` body.
 *
 * Token layout after the common fields is the model name as one escaped token
 * (CustomCompositeElm.java:48). Upstream's own text dump omits the name
 * entirely and reads its first child-dump token back as one, so the port's
 * form is the corrected one: the `.` line (or the library) holds the child
 * dumps, and the `410` line needs only the name to resolve them.
 *
 * The resolved model reaches the engine in `e.model` as a
 * `CompositeEngineSpec` (the `spec.model` JSON `Composite::from_spec` parses),
 * set by the netlist second pass from the file's `.` lines and by the
 * placement path from the merged library. `e.text` is the model name, so the
 * Model Name field is a plain text field targeting it, and a rename forces a
 * reload because it can change the post count. The geometry reads the library
 * model itself (not the payload), so it tracks renames and freshly placed
 * parts alike; the fallback below draws while the name is unresolvable.
 */

import { CHIP_SMALL, chipBodyRect, chipPosts, drawChip, type ChipPinDef } from './dFlipFlop';
import { getModel } from '../../../io/subcircuits';
import type { CompositeModel } from '../../../io/netlist/types';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** Model name written for a part with none, matching upstream's fresh-model
 *  name and its builtin default stub (CustomCompositeElm.java:28). */
const DEFAULT_MODEL_NAME = 'default';

/** The small-grid flag. CustomCompositeElm.FLAG_SMALL is bit 1 (value 2):
 *  bit 0 belongs to CompositeElm's FLAG_ESCAPE, and the two must not collide
 *  (CustomCompositeElm.java:21). */
const COMPOSITE_SMALL = 2;

/** Chip-side codes are ChipElm's integers (ChipElm.java:603-606); the shared
 *  chip helpers use the letter form. */
const SIDE_TO_DIR: Readonly<Record<number, ChipPinDef['side']>> = {
  0: 'N',
  1: 'S',
  2: 'W',
  3: 'E',
};

/** The fallback body while the model is unresolvable or freshly placed: the
 *  builtin default stub upstream always resolves, a one-pin ground on a 1x1
 *  body (CustomCompositeModel.java:62-66). */
const FALLBACK_SIZE_X = 1;
const FALLBACK_SIZE_Y = 1;
const FALLBACK_PINS: ChipPinDef[] = [{ side: 'W', pos: 0, text: 'gnd' }];

/** The referenced model from the merged library, or undefined while the part
 *  has not resolved one. The engine payload is the resolution signal: parse
 *  and placement both set `e.model`, so its absence (a freshly placed part
 *  with an unresolvable name, or a loaded file referencing a storage-only
 *  model, which `parseCircuit` deliberately does not look up) keeps the part
 *  on the fallback stub, matching the engine, which has no payload to build
 *  either. A part that did resolve reads its geometry from the library the
 *  same way the resolution did, so a rename the `setText` path re-resolves
 *  redraws immediately. */
function compositeModelOf(e: CircuitElement): CompositeModel | undefined {
  if (e.model === undefined || typeof e.model === 'string' || Array.isArray(e.model) || !('external' in e.model)) {
    return undefined;
  }
  return e.text === undefined ? undefined : getModel(e.text);
}

/** The chip body size, from the model or the fallback. */
function compositeSize(e: CircuitElement): [number, number] {
  const model = compositeModelOf(e);
  return model === undefined ? [FALLBACK_SIZE_X, FALLBACK_SIZE_Y] : [model.sizeX, model.sizeY];
}

/** The pin table, from the model's `extList`: each pin keeps its side and
 *  position on the chip, exactly as `setPoints` lays them out
 *  (CustomCompositeElm.java:105-110). The names come unescaped off the `.`
 *  line. */
export function customCompositePins(e: CircuitElement): ChipPinDef[] {
  const model = compositeModelOf(e);
  if (model === undefined) return FALLBACK_PINS;
  return model.extList.map((p) => ({
    side: SIDE_TO_DIR[p.side] ?? 'W',
    pos: p.pos,
    text: p.name,
  }));
}

/** The element with the composite's small flag on the bit the shared chip
 *  geometry reads. The composite's own FLAG_SMALL is bit 1 (see above), while
 *  `chipCspc`, the flip handling and the body all read ChipElm's bit 0
 *  (dFlipFlop.ts:27, :59-61), so the two are bridged here and the original
 *  flag word is left untouched for the file. */
function chipElement(e: CircuitElement): CircuitElement {
  const small = (e.flags & COMPOSITE_SMALL) !== 0;
  return { ...e, flags: small ? e.flags | CHIP_SMALL : e.flags & ~CHIP_SMALL };
}

function drawCustomComposite(g: DrawContext, e: CircuitElement): void {
  const [sizeX, sizeY] = compositeSize(e);
  drawChip(g, chipElement(e), sizeX, sizeY, customCompositePins(e));
}

export const CUSTOM_COMPOSITE_DEF: ElementDef = {
  kind: 'customComposite',
  label: 'Custom Composite',
  category: 'Other',
  dumpCode: '410',
  postCount: FALLBACK_PINS.length, // the fallback stub count
  postCountOf: (e) => customCompositePins(e).length, // the resolved model's pin count
  posts: (e) => chipPosts(chipElement(e), ...compositeSize(e), customCompositePins(e)),
  bodyRect: (e) => chipBodyRect(chipElement(e), ...compositeSize(e)),
  noDiagonal: true, // ChipElm.java:44
  defaultLength: 6, // the chip spans (sizeX + 1) * 32
  defaultText: DEFAULT_MODEL_NAME,
  defaultFlags: 1, // CompositeElm's FLAG_ESCAPE, which upstream always sets
  parse: (t, e) => {
    // `<modelName>`: the one escaped token after the flags
    // (CustomCompositeElm.java:48). The payload is filled by the netlist
    // second pass and the placement path, not here.
    if (t[0] !== undefined) e.text = t[0];
  },
  dump: (e) => [e.text ?? DEFAULT_MODEL_NAME],
  fields: [{ name: 'modelName', label: 'Model Name', type: 'text', target: 'text' }],
  draw: drawCustomComposite,
};
