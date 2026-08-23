/** The drill-in bridge between a `.` line's opaque model and an editable
 *  netlist document (feature/subcircuit-drill-in.md).
 *
 *  A `CompositeModel` carries the circuit as two opaque escaped strings:
 *  `nodeList`, the `\r`-separated child model lines (`ResistorElm 1 2\r...`),
 *  and `elmDump`, the space-separated escaped child dumps, one per child in
 *  the same order. Together they hold every child's class, node wiring and
 *  state tokens, but nothing a canvas needs: no coordinates, and the labeled
 *  nodes that define the external pins live only in `extList`. The dumps carry
 *  no x/y either (upstream's do; this build's create-subcircuit path writes
 *  none), so the reconstruction lays every child out fresh.
 *
 *  `documentFromComposite` places the children one row each and wires every
 *  post that shares a model node into one net, so the result is a real
 *  connected circuit the user can edit. The pin labels come back as real
 *  `207` labeled nodes on a fresh row below the body, named after their pins
 *  and pointing the way their chip side runs: keeping them as labeled nodes
 *  means the create-subcircuit extraction (which keys external pins off
 *  labeled nodes) runs unchanged when the inner document names its own nets.
 *
 *  `compositeFromDocument` is the inverse: it runs the exact same
 *  `buildModelFromSelection` the store's Create Subcircuit uses, so the two
 *  halves can never disagree about what a model is, and its refusals say the
 *  same things the create path's do.
 */

import { defFor, postsOf } from '../model/registry';
import type { Point } from '../model/types';
import { isElementLine, parseCircuit, type ParsedCircuit } from './netlist';
import { escapeToken, unescapeToken } from './netlist/tokens';
import type { CompositeModel, SubcircuitPin } from './netlist/types';
import {
  buildModelFromSelection,
  describeBuildFailure,
  unescapeChildField,
} from './subcircuits';

/** The grid spacing the reconstruction lays coordinates out on. Coordinates
 *  only have to be distinct per net and integral, but staying on the grid
 *  keeps the drawn circuit aligned with what the editor produces. */
const GRID = 16;

/** Vertical gap between two child rows, tall enough that a multi-post child's
 *  derived posts (a gate's inputs sit up to ~30 px off its axis) never collide
 *  with the neighbouring row's. */
const ROW_SPACING = 4 * GRID;

/** The `207` labeled node's flags: FLAG_ESCAPE, which every save writes. */
const LABELED_NODE_FLAGS = 4;

/** The netlist header the reconstructed document opens with. The exact values
 *  are irrelevant: a load only reads the flags and the stepping defaults back
 *  out of them. */
const HEADER = '$ 1 0.000005 10 50 5 50 5e-11';

/** A child's pin direction drawn from its chip side: `x2,y2` relative to the
 *  label's `x1,y1`, the same four comparisons `labelSide` reads back
 *  (subcircuits.ts). */
const SIDE_VECTORS: Readonly<Record<number, readonly [number, number]>> = {
  0: [0, -GRID], // north: the label points up
  1: [0, GRID], // south
  2: [-GRID, 0], // west
  3: [GRID, 0], // east
};

/** The composite child classes the port can build, the inverse of the
 *  `KIND_TO_CLASS` map create-subcircuit builds a model with. A class that is
 *  absent here is a child this build cannot draw or simulate, and entering the
 *  model must refuse rather than half-load. */
const CLASS_TO_KIND: Record<string, string> = {
  RailElm: 'rail',
  VoltageElm: 'voltage',
  ResistorElm: 'resistor',
  CapacitorElm: 'capacitor',
  InductorElm: 'inductor',
  DiodeElm: 'diode',
  ZenerElm: 'zener',
  LEDElm: 'led',
  CurrentElm: 'current',
  SwitchElm: 'switch',
  NTransistorElm: 'transistor',
  PTransistorElm: 'transistor',
  NJfetElm: 'jfet',
  PJfetElm: 'jfet',
  NMosfetElm: 'mosfet',
  PMosfetElm: 'mosfet',
  AndGateElm: 'andGate',
  NandGateElm: 'nandGate',
  OrGateElm: 'orGate',
  NorGateElm: 'norGate',
  XorGateElm: 'xorGate',
  XnorGateElm: 'xnorGate',
  InverterElm: 'inverter',
};

/** The `ParsedCircuit.unsupported` heads this build must actually refuse on:
 *  an element line (a known code this build lacks a model for) or an all-digit
 *  head (a newer upstream code). Everything else it collects (a `.` line head,
 *  an `h` hint) rides through untouched, exactly as the load banner treats it.
 *  Mirrors the store's `isMissingComponent`. */
function isMissingComponent(type: string): boolean {
  return isElementLine(type) || /^\d+$/.test(type);
}

/** The missing-component banner text for a parse result, or null when nothing
 *  in it is a component this build lacks. The same wording the store's load
 *  banner uses, so entering a model with an unrepresentable child reports the
 *  identical message the load path would. */
export function describeMissingComponents(unsupported: string[]): string | null {
  const missing = [...new Set(unsupported)].filter(isMissingComponent);
  if (missing.length === 0) return null;
  return (
    `${missing.length} element type(s) (${missing.join(', ')}) are not implemented yet, ` +
    'so those components are missing from the drawing and the simulation.'
  );
}

/** The child model lines of a `.` line, split into class and node ids. A line
 *  missing its node ids degrades to an empty node list rather than throwing,
 *  the same field-by-field tolerance the `.` line parser has. */
function childLines(model: CompositeModel): { className: string; nodes: number[] }[] {
  return model.nodeList
    .split('\r')
    .filter((line) => line.length > 0)
    .map((line) => {
      const tokens = line.split(/\s+/);
      return {
        className: tokens[0] ?? '',
        nodes: tokens
          .slice(1)
          .map(Number)
          .filter((n) => Number.isFinite(n)),
      };
    });
}

/** Whether a model's children include a subcircuit (a 410 element). Drilling
 *  into such a model would open another model inside the editing context, which
 *  this build does not support yet, so `enterSubcircuit` refuses it with a
 *  specific message rather than half-loading. The test is the child line's
 *  class, the exact token `compositeFromDocument` would turn back into a
 *  `CustomCompositeElm` child on the way out. */
export function modelHasNestedSubcircuit(model: CompositeModel): boolean {
  return model.nodeList
    .split('\r')
    .some((line) => (line.split(/\s+/)[0] ?? '') === 'CustomCompositeElm');
}

/** One element line reconstructed from a child's dump token. A `.` line's
 *  `elmDump` token is an escaped, space-separated field list (the shape
 *  `buildModelFromSelection` writes and `modelToEngineSpec` reads), so the
 *  fields come out of `unescapeToken(dump).split(' ')`: the first is the flags
 *  and the rest the state tokens, each still carrying its `escapeChildField`
 *  escapes until `unescapeChildField` decodes them. The token is then
 *  re-encoded for the element line, whose reader unescapes every token. A
 *  truncated token degrades to flags 0 and no fields, so the child still
 *  parses to its defaults. */
function elementLine(
  kind: string,
  dump: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string | null {
  const def = defFor(kind);
  if (def === undefined) return null;
  const [flagsToken, ...fieldTokens] = unescapeToken(dump).split(' ');
  const fields = fieldTokens
    .filter((f) => f.length > 0)
    .map((f) => escapeToken(unescapeChildField(f)));
  return [def.dumpCode, x1, y1, x2, y2, Number(flagsToken) || 0, ...fields].join(' ');
}

/** Records one post coordinate against a model node id, de-duplicated per
 *  coordinate so a chain wire never doubles back on itself. */
function pushPost(postsByNode: Map<number, Point[]>, node: number, p: Point): void {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  const list = postsByNode.get(node);
  if (list === undefined) postsByNode.set(node, [{ x, y }]);
  else if (!list.some((q) => q.x === x && q.y === y)) list.push({ x, y });
}

function rowOf(i: number): number {
  return i * ROW_SPACING;
}

/**
 * Reconstructs an editable netlist document from a subcircuit model: one
 * element line per child, laid out one row each with every post that shares a
 * model node chained into one net by wires, then one labeled node per external
 * pin on a fresh row below the body. The output is a normal circuit text a
 * file load accepts, so the store's drill-in is just a load and the inner
 * session behaves like any other circuit.
 *
 * The round-trip guarantee: entering and immediately leaving reproduces the
 * model byte-for-byte except for the pin labels' positions, which are new by
 * construction. Re-extraction keys nets off shared coordinates (wires union
 * them), and the layout gives every model node one net, discovered in the same
 * order the original model numbered them, so the node list comes back intact.
 */
export function documentFromComposite(model: CompositeModel): string {
  const children = childLines(model);
  const dumps = model.elmDump.split(' ').filter((t) => t.length > 0);

  // One element line per child, in nodeList order. A class the port cannot
  // build emits a placeholder element line headed by the all-digit `0`, which
  // `parseCircuit` reports as unsupported, so the caller can refuse entering
  // with the load banner rather than half-loading.
  const ordered: { line: string; kind: string | null }[] = [];
  children.forEach((child, i) => {
    const kind = CLASS_TO_KIND[child.className];
    if (kind === undefined) {
      ordered.push({
        line: `0 ${rowOf(i)} 0 0 ${rowOf(i)} 0 ${child.nodes.join(' ')}`,
        kind: null,
      });
      return;
    }
    const line = elementLine(kind, dumps[i] ?? '', 0, rowOf(i), 2 * GRID, rowOf(i));
    ordered.push({ line: line ?? `0 ${rowOf(i)} 0 0 ${rowOf(i)} 0`, kind });
  });

  const labelRow = children.length * ROW_SPACING;
  const labelLines: string[] = [];
  for (const pin of model.extList) {
    const [dx, dy] = SIDE_VECTORS[pin.side] ?? SIDE_VECTORS[2];
    const x = pin.node * GRID;
    labelLines.push(
      `207 ${x} ${labelRow} ${x + dx} ${labelRow + dy} ${LABELED_NODE_FLAGS} ${escapeToken(pin.name)}`,
    );
  }

  // The provisional body (children plus labels, no wires yet) is parsed to
  // learn each child's real post coordinates, which multi-post kinds derive
  // from their x/y/flags rather than storing. Parsed elements come back in
  // document order: the known children first, then the labels.
  const provisional = [
    HEADER,
    ...ordered.filter((o) => o.kind !== null).map((o) => o.line),
    ...labelLines,
  ].join('\n');
  const parsed = parseCircuit(provisional);
  const postsByNode = collectPosts(parsed, ordered, children, model.extList);

  // Chain the posts of each model node into one net. Node 0 is ground, so one
  // ground symbol at its first post claims the whole net for it, the same way
  // `buildModelFromSelection` maps a ground symbol's net to model node 0.
  const tailLines: string[] = [];
  for (const [node, posts] of postsByNode) {
    if (node === 0 && posts.length > 0) {
      tailLines.push(`g ${posts[0].x} ${posts[0].y} ${posts[0].x} ${posts[0].y + GRID} 0`);
    }
    if (posts.length < 2) continue;
    let prev = posts[0];
    for (let i = 1; i < posts.length; i++) {
      tailLines.push(`w ${prev.x} ${prev.y} ${posts[i].x} ${posts[i].y} 0`);
      prev = posts[i];
    }
  }

  return [HEADER, ...ordered.map((o) => o.line), ...labelLines, ...tailLines].join('\n') + '\n';
}

/** Maps every reconstructed child's and label's posts to their model node
 *  ids, using the provisional parse's element objects so multi-post kinds
 *  report their derived coordinates. Children that could not be built (the
 *  placeholder lines) have no element object and contribute no posts; their
 *  nets therefore stay empty, which is exactly the half-loaded state the
 *  caller refuses. */
function collectPosts(
  parsed: ParsedCircuit,
  ordered: { line: string; kind: string | null }[],
  children: { className: string; nodes: number[] }[],
  extList: SubcircuitPin[],
): Map<number, Point[]> {
  const postsByNode = new Map<number, Point[]>();
  let elementIndex = 0;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].kind === null) continue;
    const element = parsed.elements[elementIndex++];
    if (element === undefined) continue;
    const posts = postsOf(element);
    children[i].nodes.forEach((node, j) => {
      if (j < posts.length) pushPost(postsByNode, node, posts[j]);
    });
  }
  parsed.elements.slice(elementIndex).forEach((element, k) => {
    const pin = extList[k];
    if (pin === undefined) return;
    const posts = postsOf(element);
    if (posts.length > 0) pushPost(postsByNode, pin.node, posts[0]);
  });
  return postsByNode;
}

/** Extracts an edited inner document back into a model, the inverse of
 *  `documentFromComposite`: the whole document is run through the same
 *  create-subcircuit extraction the store's Create Subcircuit uses, so the
 *  node list, child dumps, pins and chip footprint all derive exactly the way
 *  a freshly built model's would. `previous` supplies the name and the model's
 *  flag word (which the extraction always rebuilds as 0); everything else is
 *  the document's own.
 *
 *  Refusals mirror the create path's: an element this build cannot parse is
 *  reported through `ParsedCircuit.unsupported`, a build that finds no
 *  external pins or a labeled node on the ground or on an unused net says so
 *  with the same wording `describeBuildFailure` uses. On error the caller
 *  stays inside with the message shown. */
export function compositeFromDocument(
  name: string,
  text: string,
  previous: CompositeModel,
): { model: CompositeModel | null; error: string | null } {
  let parsed: ParsedCircuit;
  try {
    parsed = parseCircuit(text);
  } catch (e) {
    return {
      model: null,
      error: `The edited model could not be read back: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const missing = describeMissingComponents(parsed.unsupported);
  if (missing !== null) return { model: null, error: missing };
  const built = buildModelFromSelection(parsed.elements, []);
  if (built.model === null) return { model: null, error: describeBuildFailure(built) };
  return {
    model: { ...built.model, name, flags: previous.flags },
    error: null,
  };
}