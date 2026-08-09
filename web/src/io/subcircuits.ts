/** The subcircuit model library behind the `.` netlist line and the Tools menu.
 *
 *  A `.` line (CustomCompositeModel.undump, CustomCompositeModel.java:208-225)
 *  is `. <escaped name> <flags> <sizeX> <sizeY> <extCount> <name node pos
 *  side>... <escaped nodeList> <escaped elmDump>`. The two trailing tokens are
 *  opaque escaped strings: `nodeList` is the `\r`-separated child model lines
 *  and `elmDump` the space-separated escaped child dumps, the exact input
 *  `CompositeElm.loadComposite` rebuilds its children from. This module parses
 *  a `.` line into a `CompositeModel`, serialises one back, converts it to the
 *  engine's `spec.model` JSON carrier, builds one from the current selection,
 *  and keeps the model library the Subcircuit Manager lists, persists and
 *  deletes.
 *
 *  Two stores back the library, mirroring upstream's global/local split
 *  (CustomCompositeModel.java:29-30): an in-memory session map holds models a
 *  loaded file's `.` lines introduced and models created this session, and a
 *  `subcircuit:<name>` key per model in the (injectable) storage persists
 *  across reloads. The session map wins on a name collision, exactly as the
 *  local model map beats the global one upstream.
 */

import { escapeToken, unescapeToken } from './netlist/tokens';
import type { CompositeModel, SubcircuitPin } from './netlist/types';
import { defFor, postsOf } from '../model/registry';
import type { CircuitElement, Point } from '../model/types';

/** The localStorage key prefix upstream uses for saved subcircuits
 *  (CustomCompositeModel.java:82, 276-291). */
export const SUB_CIRCUIT_PREFIX = 'subcircuit:';

/** The storage a `subcircuit:<name>` key round-trips through, injectable so
 *  tests can substitute a plain object for the DOM localStorage. */
export interface SubcircuitStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Every storage key carrying the `subcircuit:` prefix, in any order. */
  listSubcircuitKeys(): string[];
}

function defaultStorage(): SubcircuitStorage | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) return undefined;
  return {
    getItem: (key) => {
      try {
        return ls.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        ls.setItem(key, value);
      } catch {
        // A full or disabled localStorage must not take the app down; the
        // model stays in the session map either way.
      }
    },
    removeItem: (key) => {
      try {
        ls.removeItem(key);
      } catch {
        // Swallow, like the writer above.
      }
    },
    listSubcircuitKeys: () => {
      const out: string[] = [];
      try {
        for (let i = 0; i < ls.length; i++) {
          const key = ls.key(i);
          if (key !== null && key.startsWith(SUB_CIRCUIT_PREFIX)) out.push(key);
        }
      } catch {
        // Swallow.
      }
      return out;
    },
  };
}

/** Models introduced by this session: parsed `.` lines and created models.
 *  Module state like the parse-time id counter, so tests reset it. */
const sessionModels = new Map<string, CompositeModel>();

/** Drops every session model, leaving only what storage holds. Test seam. */
export function resetSubcircuitSession(): void {
  sessionModels.clear();
}

/** Registers a model parsed from a `.` line into the session map. The line
 *  itself stays in passthrough, so the save re-emits it; the library entry is
 *  what a future `410` element resolves its model name against. */
export function registerSessionModel(model: CompositeModel): void {
  sessionModels.set(model.name, model);
}

// ─── `.` line parsing and serialising ───

/** Parses a `.` line into a model. Returns null for a line whose fields do not
 *  decode (a truncated or hand-edited line degrades field by field, matching
 *  how the `34`/`32`/`!` model lines degrade). A partial line is still
 *  preserved by the caller, exactly like the other model lines. */
export function parseCompositeModelLine(line: string): CompositeModel | null {
  const tokens = line.split(/\s+/);
  if (tokens[0] !== '.') return null;
  const name = tokens[1] === undefined ? '' : unescapeToken(tokens[1]);
  const num = (i: number): number | undefined => {
    const v = Number(tokens[i]);
    return tokens[i] !== undefined && Number.isFinite(v) ? v : undefined;
  };
  const flags = num(2);
  const sizeX = num(3);
  const sizeY = num(4);
  const extCount = num(5);
  if (
    name === '' ||
    flags === undefined ||
    sizeX === undefined ||
    sizeY === undefined ||
    extCount === undefined ||
    extCount < 0
  ) {
    return null;
  }
  const extList: SubcircuitPin[] = [];
  let cursor = 6;
  for (let i = 0; i < extCount; i++) {
    const pinName = tokens[cursor] === undefined ? '' : unescapeToken(tokens[cursor]);
    const node = num(cursor + 1);
    const pos = num(cursor + 2);
    const side = num(cursor + 3);
    if (node === undefined || pos === undefined || side === undefined) return null;
    extList.push({ name: pinName, node, pos, side });
    cursor += 4;
  }
  const nodeListToken = tokens[cursor];
  if (nodeListToken === undefined) return null;
  const nodeList = unescapeToken(nodeListToken);
  const elmDump = tokens[cursor + 1] === undefined ? '' : unescapeToken(tokens[cursor + 1]);
  return { name, flags, sizeX, sizeY, extList, nodeList, elmDump };
}

/** Serialises a model back to a `.` line, the inverse of
 *  `parseCompositeModelLine`. The two opaque tokens are re-escaped, so
 *  `parse(serialise(m))` recovers the same fields. */
export function compositeModelLine(model: CompositeModel): string {
  const ext = model.extList
    .map((p) => [escapeToken(p.name), p.node, p.pos, p.side].join(' '))
    .join(' ');
  return [
    '.',
    escapeToken(model.name),
    model.flags,
    model.sizeX,
    model.sizeY,
    model.extList.length,
    ext,
    escapeToken(model.nodeList),
    escapeToken(model.elmDump),
  ].join(' ');
}

/**
 * The engine's `spec.model` JSON for a composite element built from this
 * model: the raw model lines, the external node ids in post order, and the
 * child dump tokens `_`-joined the way the 402 line and the engine's
 * `apply_dump` expect. The `.` line's elmDump children are space-separated
 * escaped dumps; the engine wants `flags_field1_field2`, so each is split and
 * re-joined (CompositeElm.loadComposite's token walk over the escaped dump).
 */
export function modelToEngineSpec(model: CompositeModel): {
  model: string;
  external: number[];
  dumps: string[];
} {
  return {
    model: model.nodeList,
    external: model.extList.map((p) => p.node),
    dumps: model.elmDump
      .split(' ')
      .filter((t) => t.length > 0)
      .map((t) => unescapeToken(t).split(' ').join('_')),
  };
}

// ─── the model library ───

/** Every stored and session model, session entries winning on a name
 *  collision (upstream's local-map-beats-global rule). Sorted by name so the
 *  Manager and the menu list them in a stable order. */
export function listModels(storage: SubcircuitStorage | undefined = defaultStorage()): CompositeModel[] {
  const byName = new Map<string, CompositeModel>();
  if (storage) {
    for (const key of storage.listSubcircuitKeys()) {
      let raw: string | null = null;
      try {
        raw = storage.getItem(key);
      } catch {
        raw = null;
      }
      if (raw === null) continue;
      const model = parseCompositeModelLine(raw.trim());
      if (model !== null) byName.set(model.name, model);
    }
  }
  for (const [name, model] of sessionModels) byName.set(name, model);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The model with this name, or undefined when neither storage nor the
 *  session map has it. */
export function getModel(name: string, storage: SubcircuitStorage | undefined = defaultStorage()): CompositeModel | undefined {
  const session = sessionModels.get(name);
  if (session !== undefined) return session;
  if (!storage) return undefined;
  let raw: string | null = null;
  try {
    raw = storage.getItem(SUB_CIRCUIT_PREFIX + name);
  } catch {
    raw = null;
  }
  return raw === null ? undefined : (parseCompositeModelLine(raw.trim()) ?? undefined);
}

/** Stores a model in the session map and, when storage is present, under its
 *  `subcircuit:<name>` key so it survives a reload (upstream's `setSaved(true)`,
 *  CustomCompositeModel.java:279-292). */
export function saveModel(model: CompositeModel, storage: SubcircuitStorage | undefined = defaultStorage()): void {
  sessionModels.set(model.name, model);
  if (storage) {
    try {
      storage.setItem(SUB_CIRCUIT_PREFIX + model.name, compositeModelLine(model));
    } catch {
      // A storage failure is swallowed; the session copy survives.
    }
  }
}

/** Deletes a model from both the session map and storage (upstream's `remove`,
 *  CustomCompositeModel.java:513-518). */
export function removeModel(name: string, storage: SubcircuitStorage | undefined = defaultStorage()): void {
  sessionModels.delete(name);
  if (storage) {
    try {
      storage.removeItem(SUB_CIRCUIT_PREFIX + name);
    } catch {
      // Swallow.
    }
  }
}

/** Renames a stored model, the Manager's Edit action. Returns false for a
 *  blank or unchanged name, or when no such model exists. */
export function renameModel(
  oldName: string,
  newName: string,
  storage: SubcircuitStorage | undefined = defaultStorage(),
): boolean {
  const model = getModel(oldName, storage);
  if (model === undefined || newName === '' || newName === oldName) return false;
  removeModel(oldName, storage);
  saveModel({ ...model, name: newName }, storage);
  return true;
}

// ─── building a model from a selection ───

/** The composite child kinds the engine can build, keyed by the port's kind
 *  (composite.rs `child_kind`). A selection's other elements are skipped: the
 *  landed composite machinery simulates exactly rail, voltage, resistor and
 *  transistor children, so carrying anything else would produce a model whose
 *  placed instance silently omits parts. */
const KIND_TO_CLASS: Record<string, (e: CircuitElement) => string> = {
  rail: () => 'RailElm',
  voltage: () => 'VoltageElm',
  resistor: () => 'ResistorElm',
  transistor: (e) => ((e.params.pnp ?? 1) < 0 ? 'PTransistorElm' : 'NTransistorElm'),
};

/** A wire shorts its endpoints, so every post it joins is one net. The port's
 *  composite has no wire child kind, so the frontend collapses wires into
 *  shared node ids instead of carrying a `WireElm` line. */
function wireNets(elements: CircuitElement[], selectedSet: Set<number>): Map<string, string> {
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
    if (!selectedSet.has(e.id) || e.kind !== 'wire') continue;
    union(`${e.x1},${e.y1}`, `${e.x2},${e.y2}`);
  }
  return parent;
}

/** The post of an element, snapped to integer coordinates so a fractional
 *  geometry cannot mint a phantom node. */
function coordOf(p: Point): string {
  return `${Math.round(p.x)},${Math.round(p.y)}`;
}

/**
 * Builds a `CompositeModel` from the selected elements: the buildable kinds
 * become child model lines, and a post is an external pin exactly when an
 * element outside the selection touches its net. Wires join the nets they
 * connect, so a rail behind a wire chain is one external pin, and a labeled
 * node's text names the pin it labels. Returns null when the selection is
 * empty or contains nothing the composite can build.
 */
export function buildModelFromSelection(
  elements: CircuitElement[],
  selectedIds: number[],
): CompositeModel | null {
  const selectedSet = new Set(selectedIds);
  const selected = elements.filter((e) => selectedSet.has(e.id));
  if (selected.length === 0) return null;

  const parent = wireNets(elements, selectedSet);
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };

  // Coordinates any unselected element touches: a selected post on one of
  // these is an external pin.
  const externalCoords = new Set<string>();
  for (const e of elements) {
    if (selectedSet.has(e.id)) continue;
    for (const p of postsOf(e)) externalCoords.add(coordOf(p));
  }

  // A labeled node is not a child; its text names the net it is on.
  const labelByRoot = new Map<string, string>();
  for (const e of selected) {
    if (e.kind !== 'labeledNode' || e.text === undefined || e.text.length === 0) continue;
    for (const p of postsOf(e)) {
      const root = find(coordOf(p));
      if (!labelByRoot.has(root)) labelByRoot.set(root, e.text);
    }
  }

  const nodeByRoot = new Map<string, number>();
  // Members of each net: every selected post and wire endpoint keyed by its
  // root, so a wire's far end can mark the whole net external.
  const members = new Map<string, string[]>();
  const addCoord = (c: string) => {
    const root = find(c);
    let list = members.get(root);
    if (list === undefined) {
      list = [];
      members.set(root, list);
    }
    list.push(c);
  };
  for (const e of selected) {
    if (e.kind === 'wire') {
      addCoord(`${e.x1},${e.y1}`);
      addCoord(`${e.x2},${e.y2}`);
      continue;
    }
    for (const p of postsOf(e)) addCoord(coordOf(p));
  }

  let nextNode = 1;
  const lines: string[] = [];
  const dumps: string[] = [];

  for (const e of selected) {
    if (e.kind === 'wire' || e.kind === 'labeledNode') continue;
    const toClass = KIND_TO_CLASS[e.kind];
    if (!toClass) continue;
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

  if (lines.length === 0) return null;

  // External pins: the nets with a member coordinate an unselected element
  // touches. The pin's chip side and position follow from its post's place in
  // the selection bounding box, north/south for a vertical offset and
  // west/east for a horizontal one (the same rule upstream uses to place
  // labeled nodes, SimulationManager.java:1581-1584).
  const external: { node: number; name: string; x: number; y: number }[] = [];
  for (const [root, coords] of members) {
    const extCoord = coords.find((c) => externalCoords.has(c));
    if (extCoord === undefined) continue;
    const node = nodeByRoot.get(root);
    if (node === undefined) continue;
    const [x, y] = extCoord.split(',').map(Number);
    const name = labelByRoot.get(root) ?? `p${external.length}`;
    external.push({ node, name, x, y });
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const e of selected) {
    minX = Math.min(minX, e.x1, e.x2);
    maxX = Math.max(maxX, e.x1, e.x2);
    minY = Math.min(minY, e.y1, e.y2);
    maxY = Math.max(maxY, e.y1, e.y2);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const sideOf = (x: number, y: number): number => {
    const dx = x - cx;
    const dy = y - cy;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 3 : 2;  // east / west
    return dy < 0 ? 0 : 1;  // north / south
  };

  const extList: SubcircuitPin[] = [];
  const sideCounts = [0, 0, 0, 0];
  const positioned = external.map((pin) => {
    const side = sideOf(pin.x, pin.y);
    sideCounts[side] += 1;
    return { ...pin, side };
  });
  // The west pin column reserves grid column 0, so north/south pins sit one
  // column in whenever the west side is occupied, and the chip is wide enough
  // for the pin count plus the two columns (EditCompositeModelDialog.java:
  // 97-104).
  const xOffsetLeft = sideCounts[2] > 0 ? 1 : 0;
  const xOffsetRight = sideCounts[3] > 0 ? 1 : 0;
  for (const side of [0, 1, 2, 3]) {
    const onSide = positioned
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
    name: '',
    flags: 0,
    sizeX,
    sizeY,
    extList,
    nodeList: lines.join('\r'),
    elmDump: dumps.map((t) => escapeToken(t.replaceAll('_', ' '))).join(' '),
  };
}

/** The `_`-joined child dump token for a buildable element: its file flags
 *  then its dump fields, the shape the engine's `apply_dump` splits
 *  (composite.rs). The field order is the registry's own dump, so the token
 *  matches what the element's own line would save. */
function childDumpToken(e: CircuitElement): string {
  const def = defFor(e.kind);
  const flags = def?.dumpFlags?.(e) ?? e.flags;
  const fields = def?.dump?.(e) ?? [];
  return [String(flags), ...fields.map((f) => String(f))].join('_');
}
