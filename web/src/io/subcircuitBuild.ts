/** Building a subcircuit model from the current selection, upstream's
 *  SimulationManager.getCircuitAsComposite
 *  (SimulationManager.java:1567-1611): the buildable kinds become child model
 *  lines and the selected labeled nodes become the external pins. The File
 *  menu's Create Subcircuit row and the drill-in document reconstruction both
 *  start from here.
 *
 *  This deliberately lives apart from `./subcircuits`, the model library
 *  (upstream's CustomCompositeModel): the library resolves models for the
 *  element defs, including the custom composite's own def, so it must sit
 *  below `model/registry` or the registry index and the composite def close a
 *  load-time cycle through it. Building from a selection is the one half that
 *  genuinely needs `defFor`/`postsOf`, because it walks live elements, so it
 *  is the half that moves above the registry while the library stays a leaf.
 */

import { escapeToken } from './netlist/tokens';
import type { CompositeModel, SubcircuitPin } from './netlist/types';
import { defFor, postsOf } from '../model/registry';
import { LABELED_NODE_INTERNAL } from '../model/registry/flags';
import type { CircuitElement, Point } from '../model/types';

/** The composite child kinds the engine can build, keyed by the port's kind
 *  (composite.rs `child_kind`/`dump_fields`). A selection holding anything
 *  else is refused rather than built without it; widening the set belongs with
 *  `child_kind`/`dump_fields` in the engine. The asymmetric parts map the
 *  polarity param onto the polarity-named Java class, the same split the
 *  engine's `child_kind` defaults express. */
const KIND_TO_CLASS: Record<string, (e: CircuitElement) => string> = {
  rail: () => 'RailElm',
  voltage: () => 'VoltageElm',
  resistor: () => 'ResistorElm',
  capacitor: () => 'CapacitorElm',
  inductor: () => 'InductorElm',
  diode: () => 'DiodeElm',
  zener: () => 'ZenerElm',
  led: () => 'LEDElm',
  current: () => 'CurrentElm',
  switch: () => 'SwitchElm',
  transistor: (e) => ((e.params.pnp ?? 1) < 0 ? 'PTransistorElm' : 'NTransistorElm'),
  jfet: (e) => ((e.params.pnp ?? 1) < 0 ? 'PJfetElm' : 'NJfetElm'),
  mosfet: (e) => ((e.params.pnp ?? 1) < 0 ? 'PMosfetElm' : 'NMosfetElm'),
  // The logic children. A gate's model line names one node per input plus the
  // output, and its dump carries the input count, so a wide gate survives the
  // round trip; the engine reads the same three fields the registry dumps.
  andGate: () => 'AndGateElm',
  nandGate: () => 'NandGateElm',
  orGate: () => 'OrGateElm',
  norGate: () => 'NorGateElm',
  xorGate: () => 'XorGateElm',
  xnorGate: () => 'XnorGateElm',
  inverter: () => 'InverterElm',
};

/** Kinds that are not child model lines and are not gaps in the model either.
 *  Wires collapse into shared nodes, labeled nodes are the pins and grounds are
 *  node 0; the rest are upstream's `extraList` exemptions
 *  (SimulationManager.java:1622-1627), which carry no electrical behaviour, so
 *  a text annotation or a scope in the circuit must not refuse the build. */
const SKIPPED_KINDS = new Set([
  'wire',
  'labeledNode',
  'ground',
  // ScopeElm, then the three GraphicElms: TextElm, BoxElm and LineElm.
  'scope',
  'decoration',
  'box',
  'line',
]);

/** A wire shorts its endpoints, so every post it joins is one net. The port's
 *  composite has no wire child kind, so the frontend collapses wires into
 *  shared node ids instead of carrying a `WireElm` line. */
function wireNets(elements: CircuitElement[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const e of elements) {
    if (e.kind !== 'wire') continue;
    union(`${e.x1},${e.y1}`, `${e.x2},${e.y2}`);
  }
  return parent;
}

/** The post of an element, snapped to integer coordinates so a fractional
 *  geometry cannot mint a phantom node. */
function coordOf(p: Point): string {
  return `${Math.round(p.x)},${Math.round(p.y)}`;
}

/** The chip side a labeled node points at, upstream's four comparisons on the
 *  element's own `dx`/`dy` (SimulationManager.java:1581-1584). The direction
 *  the user dragged the label is the direction its pin leaves the chip, so two
 *  labels on the same edge of the selection can still face opposite ways.
 *  `SIDE_W` is the default, which is what a zero-length label gets. Side codes
 *  are `ChipElm`'s: 0 N, 1 S, 2 W, 3 E. */
function labelSide(e: CircuitElement): number {
  const dx = e.x2 - e.x1;
  const dy = e.y2 - e.y1;
  let side = 2;
  if (Math.abs(dx) >= Math.abs(dy) && dx > 0) side = 3;
  if (Math.abs(dx) <= Math.abs(dy) && dy < 0) side = 0;
  if (Math.abs(dx) <= Math.abs(dy) && dy > 0) side = 1;
  return side;
}

/** What a build attempt produced. A kind the composite cannot carry is
 *  reported rather than dropped, so a model missing half the selection cannot
 *  pass for a whole one. Cutting an unlabeled net in two by selecting only part
 *  of a circuit is still silent, as it is upstream: that net simply becomes
 *  internal, and a subnetwork left floating by it can go singular when the
 *  model is instantiated. */
export interface BuildResult {
  model: CompositeModel | null;
  /** Kinds present in the selection the composite cannot represent, unique
   *  and in registry-label form, for the caller's message. */
  unsupported: string[];
  /** Why no model came out, when `model` is null. */
  reason?: string;
}

/** The alert text for a failed build: the unsupported kinds when that is what
 *  stopped it, else the refusal reason, else the generic prompt for a
 *  selection with nothing to build from. */
export function describeBuildFailure(result: BuildResult): string {
  if (result.unsupported.length > 0) {
    return (
      `Cannot build a subcircuit from this selection: it contains ` +
      `${result.unsupported.join(', ')}, which the subcircuit engine cannot represent yet.`
    );
  }
  return result.reason ?? 'There is nothing here to turn into a subcircuit.';
}

/**
 * Builds a `CompositeModel` from the selection: the buildable kinds become
 * child model lines and the selected labeled nodes become the external pins,
 * exactly as upstream derives them (SimulationManager.getCircuitAsComposite,
 * SimulationManager.java:1567-1611). With nothing selected the whole circuit
 * is the subcircuit, upstream's `sel = app.isSelection()` fallback. Wires join
 * the nets they connect, so a label behind a wire chain still names the
 * component's net.
 *
 * A kind the composite cannot represent is reported in `unsupported` and
 * refuses the build; a label on the ground net, a label whose net no child
 * touches, and a selection with no labels at all each refuse with a `reason`.
 */
export function buildModelFromSelection(
  elements: CircuitElement[],
  selectedIds: number[],
): BuildResult {
  const selectedSet = new Set(selectedIds);
  // Upstream builds from the whole circuit when there is no selection, so the
  // documented flow (draw it, label the ends, Create Subcircuit) works without
  // selecting anything.
  const selected =
    selectedIds.length === 0 ? elements : elements.filter((e) => selectedSet.has(e.id));
  if (selected.length === 0) return { model: null, unsupported: [] };

  const parent = wireNets(selected);
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };

  const nodeByRoot = new Map<string, number>();
  // A ground symbol is not a child line; its net is model node 0, the id
  // `composite.rs` maps to GROUND (composite.rs:210). Claimed before the walk
  // that hands out ids from 1, or the grounded net would get an ordinary node
  // and the model would go singular the moment it is instantiated.
  for (const e of selected) {
    if (e.kind !== 'ground') continue;
    for (const p of postsOf(e)) nodeByRoot.set(find(coordOf(p)), 0);
  }

  let nextNode = 1;
  const lines: string[] = [];
  const dumps: string[] = [];
  const unsupported: string[] = [];
  const unsupportedKinds = new Set<string>();

  for (const e of selected) {
    if (SKIPPED_KINDS.has(e.kind)) continue;
    const toClass = KIND_TO_CLASS[e.kind];
    if (!toClass) {
      if (!unsupportedKinds.has(e.kind)) {
        unsupportedKinds.add(e.kind);
        unsupported.push(defFor(e.kind)?.label ?? e.kind);
      }
      continue;
    }
    const posts = postsOf(e);
    if (posts.length === 0) continue;
    const nodeIds = posts.map((p) => {
      const root = find(coordOf(p));
      let n = nodeByRoot.get(root);
      if (n === undefined) {
        n = nextNode++;
        nodeByRoot.set(root, n);
      }
      return n;
    });
    lines.push(`${toClass(e)} ${nodeIds.join(' ')}`);
    dumps.push(childDumpToken(e));
  }

  // A partial model is the failure being fixed here: refuse instead, so the
  // user learns which kinds the engine cannot carry yet.
  if (unsupported.length > 0) return { model: null, unsupported };
  if (lines.length === 0) return { model: null, unsupported: [] };

  // External pins come from the labeled nodes and nothing else, upstream's
  // rule. Their own direction gives the side, so the geometry the user drew is
  // the layout they get.
  const pins: { name: string; node: number; side: number; x: number; y: number }[] = [];
  const claimed = new Set<string>();
  for (const e of selected) {
    if (e.kind !== 'labeledNode') continue;
    // A node the user marked internal names a private net, not a pin
    // (upstream's `lne.isInternal()` skip, SimulationManager.java:1575-1576,
    // LabeledNodeElm.java:31, :76). The flag rides through a load, so an
    // upstream circuit using internal nodes would otherwise grow a spurious
    // pin per node, and one of them on the ground net would refuse the build.
    if ((e.flags & LABELED_NODE_INTERNAL) !== 0) continue;
    const text = e.text ?? '';
    if (text.length === 0) continue;
    const posts = postsOf(e);
    if (posts.length === 0) continue;
    const root = find(coordOf(posts[0]));
    // Upstream's `extnodes` check: a net already carrying a pin keeps the
    // first label, so a second name for the same net is not a second pin.
    if (claimed.has(root)) continue;
    claimed.add(root);
    const node = nodeByRoot.get(root);
    if (node === 0) {
      return {
        model: null,
        unsupported: [],
        reason: `Node "${text}" can't be connected to ground`,
      };
    }
    if (node === undefined) {
      // Upstream's `used[]` check: a pin on a net no child touches would be a
      // post with nothing behind it (SimulationManager.java:1663-1668).
      return { model: null, unsupported: [], reason: `Node "${text}" is not used!` };
    }
    pins.push({ name: text, node, side: labelSide(e), x: e.x1, y: e.y1 });
  }

  if (pins.length === 0) {
    return {
      model: null,
      unsupported: [],
      reason: 'Device has no external inputs/outputs: mark the subcircuit pins with labeled nodes.',
    };
  }

  const sideCounts = [0, 0, 0, 0];
  for (const p of pins) sideCounts[p.side] += 1;
  // The west pin column reserves grid column 0, so north/south pins sit one
  // column in whenever the west side is occupied, and the chip is wide enough
  // for the pin count plus the two columns (EditCompositeModelDialog.java:
  // 97-104).
  const xOffsetLeft = sideCounts[2] > 0 ? 1 : 0;
  const xOffsetRight = sideCounts[3] > 0 ? 1 : 0;
  const extList: SubcircuitPin[] = [];
  for (const side of [0, 1, 2, 3]) {
    // West and east run down the chip, north and south run across it, so each
    // side sorts on the axis it is laid out along (SimulationManager.java:
    // 1596-1599).
    const onSide = pins
      .filter((p) => p.side === side)
      .sort((a, b) => (side < 2 ? a.x - b.x : a.y - b.y));
    onSide.forEach((p, i) =>
      extList.push({
        name: p.name,
        node: p.node,
        // North/south positions skip the reserved west column.
        pos: side < 2 ? i + xOffsetLeft : i,
        side,
      }),
    );
  }

  // The `.` line's pin order is the post order both halves consume, so match
  // upstream's alphabetical ext list (EditCompositeModelDialog.java:76-80:
  // `a.name.toLowerCase().compareTo(b.name.toLowerCase())`). The sort is stable,
  // so same-letter ties keep the side-major order above, as Java's stable
  // `Collections.sort` does. The code-unit comparison mirrors `String.compareTo`
  // rather than a locale's collation, so the order matches upstream character
  // for character.
  extList.sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  // Chip footprint: wide enough for the north/south pins with a column spare
  // each side when the west/east sides are occupied, tall enough for the
  // west/east pins (the same sizing EditCompositeModelDialog.createModel
  // computes, EditCompositeModelDialog.java:97-111).
  const minHeight = sideCounts[0] > 0 && sideCounts[1] > 0 ? 2 : 1;
  const pinsNS = Math.max(sideCounts[0], sideCounts[1]);
  const pinsWE = Math.max(sideCounts[2], sideCounts[3]);
  const sizeX = Math.max(2, pinsNS + xOffsetLeft + xOffsetRight);
  const sizeY = Math.max(minHeight, pinsWE);

  return {
    model: {
      name: '',
      flags: 0,
      sizeX,
      sizeY,
      extList,
      nodeList: lines.join('\r'),
      // The `_` separators `childDumpToken` joined become spaces (escaped to
      // `\s`); field values never carry a literal `_` or space, so the join
      // only ever splits on field boundaries.
      elmDump: dumps.map((t) => escapeToken(t.replaceAll('_', ' '))).join(' '),
    },
    unsupported: [],
  };
}

/** Escapes one child dump field for the `_`-joined token: a value's own `_`
 *  would read as another field separator, and a space would read as one on
 *  the loader's space split (`modelToEngineSpec`), so each is encoded (`_`
 *  -> `\u`, space -> `\s`) and a backslash first, which keeps an already
 *  escaped sequence from being misread. The common case, a numeric field,
 *  contains none of the three characters and passes through unchanged, which
 *  is what keeps existing `.` lines loadable. */
export function escapeChildField(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/_/g, '\\u').replace(/ /g, '\\s');
}

/** The inverse of `escapeChildField`, decoding one field back out of a child
 *  dump token. The `\\`/`\u`/`\s` codes the encoder writes are the only
 *  sequences touched, and `\\` is matched first, so a value that merely
 *  contains `\u` as two characters survives. */
export function unescapeChildField(s: string): string {
  return s.replace(/\\(u|s|\\)/g, (_, c: string) => (c === 'u' ? '_' : c === 's' ? ' ' : '\\'));
}

/** The `_`-joined child dump token for a buildable element: its file flags
 *  then its dump fields, the shape the engine's `apply_dump` splits
 *  (composite.rs). The field order is the registry's own dump, so the token
 *  matches what the element's own line would save. Fields are escaped before
 *  the join, so the only `_` in the token are the separators; the writer
 *  (`buildModelFromSelection`) and the loader (`modelToEngineSpec`) can then
 *  round-trip a field that itself contains `_` or a space. */
function childDumpToken(e: CircuitElement): string {
  const def = defFor(e.kind);
  const flags = def?.dumpFlags?.(e) ?? e.flags;
  const fields = def?.dump?.(e) ?? [];
  return [String(flags), ...fields.map((f) => escapeChildField(String(f)))].join('_');
}
