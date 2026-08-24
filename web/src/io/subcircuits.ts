/** The subcircuit model library behind the `.` netlist line and the File menu's
 *  Create Subcircuit row.
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
 *  (CustomCompositeModel.java:29-30): an in-memory session map holds the models
 *  the open file's `.` lines introduced, and a `subcircuit:<name>` key per
 *  model in the (injectable) storage persists the ones the user saved. The
 *  session map wins on a name collision, exactly as the local model map beats
 *  the global one upstream.
 *
 *  The session map is scoped to one load. The store clears it and re-registers
 *  the parse result on every `loadNetlist`, so closing a file takes its models
 *  with it; `parseCircuit` itself registers nothing, or an import preview or a
 *  clipboard sniff would silently grow the library.
 *
 *  Because a session model is the file's, renaming one is half a document edit:
 *  this module re-keys the map (`renameModel`) and offers the line rewrite
 *  (`renameCompositeModelLine`) and the undo-time resync (`syncSessionModels`),
 *  but the store owns the circuit and is what actually applies them.
 */

import { escapeToken, unescapeToken } from './netlist/tokens';
import type { CompositeEngineSpec, CompositeModel, SubcircuitPin } from './netlist/types';
import { defFor, postsOf } from '../model/registry';
import { LABELED_NODE_INTERNAL } from '../model/registry/flags';
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
  // Guarded like every storage module: with site data blocked the property
  // access itself throws SecurityError, and this runs under a default
  // argument where no body-level try/catch could cover it.
  try {
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
  } catch {
    // Storage denied: run without persistence rather than crash.
    return undefined;
  }
}

/** Models the loaded circuit introduced: the interpreted `.` lines of the file
 *  currently open, plus anything created this session that storage could not
 *  take. Scoped to one load, so it is cleared and rebuilt by the store on every
 *  `loadNetlist`; without that, a model from a file the user already closed
 *  would keep haunting the Subcircuit Manager. */
const sessionModels = new Map<string, CompositeModel>();

/** Drops every session model, leaving only what storage holds. The store calls
 *  this at the start of each load, so the file's `.` lines are the only
 *  session entries: upstream keeps the same split between a per-circuit local
 *  map and the persisted global one (CustomCompositeModel.java:29-30). */
export function clearSessionModels(): void {
  sessionModels.clear();
}

/** Registers a model parsed from a `.` line into the session map. The line
 *  itself stays in passthrough, so the save re-emits it; the library entry is
 *  what a future `410` element resolves its model name against. Only a caller
 *  that commits the text calls this: `parseCircuit` merely returns the models
 *  it read. */
export function registerSessionModel(model: CompositeModel): void {
  sessionModels.set(model.name, model);
}

/** Every model the given lines define, keyed by name. Only `.` lines that
 *  parse contribute, so a truncated one is ignored here exactly as it is on
 *  load. */
function modelsInLines(lines: string[]): Map<string, CompositeModel> {
  const out = new Map<string, CompositeModel>();
  for (const line of lines) {
    if (!line.trim().startsWith('.')) continue;
    const model = parseCompositeModelLine(line.trim());
    if (model !== null) out.set(model.name, model);
  }
  return out;
}

/** Moves the session map from one set of document lines to another, for undo
 *  and redo of a subcircuit rename: the `.` lines come back, so the library
 *  entries they stand for have to come back with them, or the Manager would
 *  list the new name while the file says the old one.
 *
 *  The loops touch every name one of the two line sets alone defines,
 *  whatever put its library entry there. The delete loop drops a name only the
 *  before-lines carry, so a paste model whose name sits on a `.` line that
 *  undo retracts goes with it; the `now` loop registers each model the
 *  after-lines define, so the file's copy wins on a collision and a `.` line
 *  coming back on undo overwrites any paste model sharing its name. Only a
 *  name in neither set is provably left alone: a session model no `.` line
 *  introduced (one storage refused, one a paste brought in) keeps its entry
 *  exactly when no line in either set collides with it. A name both sets carry
 *  is left alone too, and keeps whatever the library currently says about it:
 *  it may since have been saved, and re-registering the file's copy would
 *  resurrect a shadow the user's own save had cleared. This is deliberately
 *  not the wholesale `clearSessionModels`-and-re-register a load performs,
 *  because an undo is not a load and must not take those models with it. */
export function syncSessionModels(before: string[], after: string[]): void {
  const was = modelsInLines(before);
  const now = modelsInLines(after);
  for (const name of was.keys()) {
    if (!now.has(name)) sessionModels.delete(name);
  }
  for (const [name, model] of now) {
    if (!was.has(name)) sessionModels.set(name, model);
  }
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

/** The same `.` line with the model renamed, or null when the line is not this
 *  model's. Only the name token is rewritten, so every other field, the
 *  escaping of the two opaque tokens and whatever spacing the file arrived
 *  with all survive byte for byte: re-emitting the line through
 *  `compositeModelLine` would instead normalise a hand-written one. A line that
 *  does not parse never matches, so a truncated `.` line is preserved
 *  untouched, as it is everywhere else. */
export function renameCompositeModelLine(
  line: string,
  oldName: string,
  newName: string,
): string | null {
  if (parseCompositeModelLine(line.trim())?.name !== oldName) return null;
  // Group 1 is `.` with the whitespace around it, group 2 the name token, so
  // only the name is replaced and the rest of the line is carried over.
  const parts = /^(\s*\.\s+)(\S+)(.*)$/.exec(line);
  if (parts === null) return null;
  return parts[1] + escapeToken(newName) + parts[3];
}

/** Whether two models are the same model: same name and same body (flags,
 *  size, pins, node list and child dumps). The store's rename writes a
 *  document `.` line back only when this holds against the model about to
 *  move, so a same-named saved model or paste cannot edit a line that is a
 *  different model, while a model the file introduced under one name is still
 *  matched however its entry reached storage. */
export function sameCompositeModel(a: CompositeModel, b: CompositeModel): boolean {
  if (
    a.name !== b.name ||
    a.flags !== b.flags ||
    a.sizeX !== b.sizeX ||
    a.sizeY !== b.sizeY ||
    a.nodeList !== b.nodeList ||
    a.elmDump !== b.elmDump ||
    a.extList.length !== b.extList.length
  ) {
    return false;
  }
  return a.extList.every(
    (p, i) =>
      p.name === b.extList[i].name &&
      p.node === b.extList[i].node &&
      p.pos === b.extList[i].pos &&
      p.side === b.extList[i].side,
  );
}

/**
 * The engine's `spec.model` JSON for a composite element built from this
 * model: the raw model lines, the external node ids in post order, and the
 * child dump tokens `_`-joined the way the 402 line and the engine's
 * `apply_dump` expect. The `.` line's elmDump children are space-separated
 * escaped dumps; the engine wants `flags_field1_field2`, so each is split and
 * re-joined (CompositeElm.loadComposite's token walk over the escaped dump).
 * `childDumpToken` already escaped `_` and space inside field values, so the
 * space split here separates fields, never a value.
 */
export function modelToEngineSpec(model: CompositeModel): CompositeEngineSpec {
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

/** One storage key, or null when there is no storage or the read throws (a
 *  disabled localStorage raises on access rather than returning null). */
function readItem(storage: SubcircuitStorage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** Every stored and session model, session entries winning on a name
 *  collision (upstream's local-map-beats-global rule). Sorted by name so the
 *  Manager and the menu list them in a stable order. */
export function listModels(storage: SubcircuitStorage | undefined = defaultStorage()): CompositeModel[] {
  const byName = new Map<string, CompositeModel>();
  if (storage) {
    for (const key of storage.listSubcircuitKeys()) {
      const raw = readItem(storage, key);
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
  const raw = readItem(storage, SUB_CIRCUIT_PREFIX + name);
  return raw === null ? undefined : (parseCompositeModelLine(raw.trim()) ?? undefined);
}

/** Persists a model under its `subcircuit:<name>` key so it survives a reload
 *  (upstream's `setSaved(true)`, CustomCompositeModel.java:279-292). A stored
 *  model supersedes any session entry of that name, which is upstream moving a
 *  model out of the local map and into the global one once storage owns it
 *  (CustomCompositeModel.java:99-102). That single origin per name is what
 *  lets `removeModel` know which store a Delete should clear. Only when the
 *  write did not land (no storage, or a full or disabled one, which
 *  `defaultStorage` swallows) does the model stay in the session map, so it is
 *  at least usable until the next load. The read-back compares the value, not
 *  merely the key's presence: overwriting an older model of the same name on a
 *  storage that then refuses the write would otherwise read the *old* line
 *  back, look like a success and drop the session copy of the model the user
 *  had just built. Returns whether storage took it, which `renameModel` needs
 *  before it dares delete the original. */
export function saveModel(
  model: CompositeModel,
  storage: SubcircuitStorage | undefined = defaultStorage(),
): boolean {
  const key = SUB_CIRCUIT_PREFIX + model.name;
  const line = compositeModelLine(model);
  if (storage) {
    try {
      storage.setItem(key, line);
    } catch {
      // Reading the key back is the real test of whether the write landed.
    }
  }
  if (readItem(storage, key) === line) {
    sessionModels.delete(model.name);
    return true;
  }
  sessionModels.set(model.name, model);
  return false;
}

/** True when a model already holds this name, in either store. The rename and
 *  the Create dialog both ask before clobbering one. Asked through `getModel`
 *  on purpose: the answer then covers exactly what a later lookup will find,
 *  session map first and storage behind it, so a name that reports free cannot
 *  turn out to be occupied by the time it is written. */
export function nameTaken(name: string, storage: SubcircuitStorage | undefined = defaultStorage()): boolean {
  return getModel(name, storage) !== undefined;
}

/** Which store a delete actually emptied. `session` means the open file's copy
 *  went and a saved model of that name may still be there, uncovered rather
 *  than destroyed. `refused` and `none` both removed nothing, but they are not
 *  the same event and the Manager says different things about them: `refused`
 *  is a model that is still there because storage would not drop the key,
 *  `none` is a name nothing held, so the row the user clicked was stale. */
export type RemoveOutcome = 'session' | 'stored' | 'refused' | 'none';

/** Deletes a model, upstream's `remove` (CustomCompositeModel.java:513-518),
 *  but only from the store the listed model actually came from. A session
 *  entry is a `.` line out of the open file, not something the user saved:
 *  clearing the `subcircuit:<name>` key for it would destroy a persisted model
 *  that merely shares the name, which is the one the shadowed row uncovers
 *  once the file's copy is gone. A row with no session entry came from
 *  storage, so that is what gets removed. */
export function removeModel(
  name: string,
  storage: SubcircuitStorage | undefined = defaultStorage(),
): RemoveOutcome {
  if (sessionModels.delete(name)) return 'session';
  const key = SUB_CIRCUIT_PREFIX + name;
  if (readItem(storage, key) === null) return 'none';
  try {
    storage?.removeItem(key);
  } catch {
    // Reading the key back is the real test of whether the delete landed, the
    // same way `saveModel` checks its write.
  }
  return readItem(storage, key) === null ? 'stored' : 'refused';
}

/** How a rename ended. `taken`, `missing` and `refused` are refusals the caller
 *  has to report; `blank` and `unchanged` are the library being asked to do
 *  nothing. `uncovered` is a rename that succeeded while leaving the old name
 *  still listed, see `renameModel`. The Subcircuit Manager's edit row speaks
 *  this same union, so its commit is a pass-through rather than a
 *  translation. */
export type RenameOutcome =
  | 'renamed'
  | 'uncovered'
  | 'taken'
  | 'missing'
  | 'refused'
  | 'blank'
  | 'unchanged';

/**
 * Renames a model, the Manager's Edit action. Refuses a name another model
 * already holds instead of clobbering it: the rename is a copy under the new
 * name and a delete of the old, so without the check renaming `divider` onto
 * `amp` would delete `amp` and write `divider`'s body under its name, silently.
 *
 * Only the copy the listed row came from moves, and it moves within the store
 * it came from, the same two-store rule `removeModel` follows. A model the open
 * file's `.` line introduced is re-keyed in the session map and written nowhere
 * else: persisting it under the new name instead would promote a file-local
 * model into the user's saved library while the file's line kept saying the old
 * name, so the next load of that file listed both, one rename and two models.
 * The `.` line is the other half of such a rename and belongs to the document,
 * not to this module: the store's `renameSubcircuit` rewrites it, under
 * `commit()` so it undoes.
 *
 * For a saved model the copy is written first and the original only dropped
 * once storage has taken it. `nameTaken` has just proved the new name is free,
 * so writing first can clobber nothing, while deleting first loses the model
 * outright when the write that follows is refused: it would live on in the
 * session map alone, which the next load clears. A refusal therefore leaves
 * everything exactly where it was and answers `refused`.
 *
 * Renaming a row that shadows a saved model of the same name (the open file's
 * `.` line over the user's own saved subcircuit) leaves that saved model behind
 * under the old name and the list grows a second row. That is the only
 * non-destructive rule available: the two are different models that happen to
 * share a name, and moving the saved one too would have to overwrite it with
 * the file's body. The old name still resolving afterwards is what `uncovered`
 * reports, which also covers a delete storage refused: either way a model of
 * the old name is still listed and the Manager has to account for the extra
 * row.
 */
export function renameModel(
  oldName: string,
  newName: string,
  storage: SubcircuitStorage | undefined = defaultStorage(),
): RenameOutcome {
  const model = getModel(oldName, storage);
  if (model === undefined) return 'missing';
  if (newName === '') return 'blank';
  if (newName === oldName) return 'unchanged';
  if (nameTaken(newName, storage)) return 'taken';
  if (sessionModels.has(oldName)) {
    // The open file's own model: re-keyed in place, so storage neither gains
    // the new name nor loses the old. Nothing can refuse an in-memory move,
    // which is why this branch has no `refused` answer.
    sessionModels.delete(oldName);
    sessionModels.set(newName, { ...model, name: newName });
    return nameTaken(oldName, storage) ? 'uncovered' : 'renamed';
  }
  if (!saveModel({ ...model, name: newName }, storage)) {
    // Storage refused the copy of a model it is holding. Undo the session-map
    // fallback `saveModel` left behind, or the library would list the model
    // twice until the next load and then lose the new name.
    sessionModels.delete(newName);
    return 'refused';
  }
  // Only the saved copy moves: the session map cannot hold this name, or the
  // branch above would have taken it.
  removeModel(oldName, storage);
  return nameTaken(oldName, storage) ? 'uncovered' : 'renamed';
}

// ─── building a model from a selection ───

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
