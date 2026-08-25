/** Built-in device-model tables, the port of DiodeModel.java:82-116,
 *  TransistorModel.java:114-145 and MosfetModel.java:110-135. A named model
 *  with no `34`/`32` file line resolves against these tables at load, so a
 *  `d ... 2 1N4148` line simulates as a 1N4148 exactly like upstream's global
 *  modelMap (getModelWithNameOrCopy, DiodeModel.java:62-76).
 *
 *  The values are copied from the upstream table constructors (the read-only
 *  reference checkout); the port writes original code around them. `internal`
 *  marks the models upstream hides from the UI picker (getModelList,
 *  DiodeModel.java:185-200): they still resolve if a file names them, exactly
 *  like a map lookup. */

import type { DiodeModel, TransistorModel } from '../io/netlist/types';
import { escapeToken } from '../io/netlist/tokens';

/** Thermal voltage the forward-drop derivation uses (DiodeModel.java:32). */
const VT = 0.025865;

/** The device families a model name can name. The mosfet and jfet share one
 *  table upstream (MosfetModel, distinguished by the jfet flag); the diode
 *  family (diode/zener/varactor/led) all resolve through the diode table. */
export type ModelFamily = 'diode' | 'transistor' | 'mosfet' | 'jfet';

/** A built-in diode table row: the same four core params a `34` line carries,
 *  plus the picker visibility flag. */
export interface DiodeTableEntry extends DiodeModel {
  /** Hidden from the UI picker (DiodeModel.java:191-192); still resolves. */
  internal?: boolean;
}

/** A built-in transistor table row. The port's Ebers-Moll consumes only satCur
 *  and betaR; the rest of an upstream row stays unused, exactly as the `32`
 *  resolution treats it. */
export interface TransistorTableEntry extends TransistorModel {
  internal?: boolean;
}

/** A built-in mosfet/jfet table row. The structural flags (showBulk,
 *  bodyDiode, bodyTerminal, digitalSymbol) are deliberately not modelled: the
 *  port's engine has no expressible params for them, so `default-nodiode`,
 *  `default-body` and `default-digital` simulate identically to `default`.
 *  Only `threshold` and `beta` resolve. */
export interface MosfetTableEntry {
  threshold: number;
  beta: number;
  /** A JFET entry shows only in a JFET's picker (MosfetModel.java:212). */
  jfet: boolean;
  internal?: boolean;
}

/** The diode table (DiodeModel.java:82-116). The `~` internal models are
 *  loaded through loadInternalModel upstream and carry no forward description;
 *  they still resolve when a file names them, so they stay in the map. */
export const DIODE_MODELS: Readonly<Record<string, DiodeTableEntry>> = {
  'spice-default': { saturationCurrent: 1e-14, seriesResistance: 0, emissionCoefficient: 1, breakdownVoltage: 0 },
  default: { saturationCurrent: 1.7143528192808883e-7, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 0 },
  'default-zener': { saturationCurrent: 1.7143528192808883e-7, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 5.6 },
  // The old default LED's saturation current is far too small, which causes
  // numerical errors; kept only for files that already name it
  // (DiodeModel.java:87).
  'old-default-led': { saturationCurrent: 2.2349907006671927e-18, seriesResistance: 0, emissionCoefficient: 2, breakdownVoltage: 0, internal: true },
  // The default for newly created LEDs (DiodeModel.java:90).
  'default-led': { saturationCurrent: 93.2e-12, seriesResistance: 0.042, emissionCoefficient: 3.73, breakdownVoltage: 0 },
  'default-optocoupler-led': { saturationCurrent: 1.714e-7, seriesResistance: 0, emissionCoefficient: 4.077, breakdownVoltage: 0 },
  '1N5711': { saturationCurrent: 315e-9, seriesResistance: 2.8, emissionCoefficient: 2.03, breakdownVoltage: 70 },
  '1N5712': { saturationCurrent: 680e-12, seriesResistance: 12, emissionCoefficient: 1.003, breakdownVoltage: 20 },
  BAT85: { saturationCurrent: 2.076e-7, seriesResistance: 2.326, emissionCoefficient: 1.023, breakdownVoltage: 33 },
  // The model is inaccurate (DiodeModel.java:102), so upstream marks it
  // internal; a file that names it still resolves.
  '1N34': { saturationCurrent: 200e-12, seriesResistance: 84e-3, emissionCoefficient: 2.19, breakdownVoltage: 60, internal: true },
  '1N4004': { saturationCurrent: 18.8e-9, seriesResistance: 28.6e-3, emissionCoefficient: 2, breakdownVoltage: 400 },
  '1N4148': { saturationCurrent: 4.352e-9, seriesResistance: 0.6458, emissionCoefficient: 1.906, breakdownVoltage: 75 },
  'x2n2646-emitter': { saturationCurrent: 2.13e-11, seriesResistance: 0, emissionCoefficient: 1.8, breakdownVoltage: 0, internal: true },
  '~tl431ed-d_ed': { saturationCurrent: 1e-14, seriesResistance: 5, emissionCoefficient: 1, breakdownVoltage: 0, internal: true },
  '~lm317-dz': { saturationCurrent: 1e-14, seriesResistance: 0, emissionCoefficient: 1, breakdownVoltage: 6.3, internal: true },
};

/** The transistor table (TransistorModel.java:114-145). Only the two
 *  user-selectable models are shown; the internal entries exist for composite
 *  elements this port does not have (LM324v2, TL431, LM317), ported for map
 *  fidelity so a file that names one resolves. The port's Ebers-Moll consumes
 *  only satCur and betaR, exactly as the `32` resolution does; the rest of
 *  each upstream row stays unused. */
export const TRANSISTOR_MODELS: Readonly<Record<string, TransistorTableEntry>> = {
  default: { saturationCurrent: 1e-13, betaReverse: 1 },
  'spice-default': { saturationCurrent: 1e-16, betaReverse: 1 },
  'xlm324v2-qpi': { saturationCurrent: 1.01e-16, betaReverse: 1, internal: true },
  'xlm324v2-qpa': { saturationCurrent: 1.01e-16, betaReverse: 1, internal: true },
  'xlm324v2-qnq': { saturationCurrent: 1e-16, betaReverse: 1, internal: true },
  'xlm324v2-qpq': { saturationCurrent: 1e-16, betaReverse: 1, internal: true },
  '~tl431ed-qn_ed': { saturationCurrent: 1e-16, betaReverse: 1, internal: true },
  '~tl431ed-qn_ed-A1.2': { saturationCurrent: 1.2e-16, betaReverse: 1, internal: true },
  '~tl431ed-qn_ed-A2.2': { saturationCurrent: 2.2000000000000002e-16, betaReverse: 1, internal: true },
  '~tl431ed-qn_ed-A0.5': { saturationCurrent: 5e-17, betaReverse: 1, internal: true },
  '~tl431ed-qp_ed': { saturationCurrent: 1e-16, betaReverse: 1, internal: true },
  '~tl431ed-qn_ed-A5': { saturationCurrent: 5e-16, betaReverse: 1, internal: true },
  '~lm317-qpl-A0.1': { saturationCurrent: 1e-17, betaReverse: 1, internal: true },
  '~lm317-qnl-A0.2': { saturationCurrent: 2e-17, betaReverse: 1, internal: true },
  '~lm317-qpl-A0.2': { saturationCurrent: 2e-17, betaReverse: 1, internal: true },
  '~lm317-qnl-A2': { saturationCurrent: 2e-16, betaReverse: 1, internal: true },
  '~lm317-qpl-A2': { saturationCurrent: 2e-16, betaReverse: 1, internal: true },
  '~lm317-qnl-A5': { saturationCurrent: 5e-16, betaReverse: 1, internal: true },
  '~lm317-qnl-A50': { saturationCurrent: 5e-15, betaReverse: 1, internal: true },
};

/** The mosfet/jfet table (MosfetModel.java:110-135). All user-selectable, so
 *  no `internal` entry; the selector filters by the jfet flag instead. */
export const MOSFET_MODELS: Readonly<Record<string, MosfetTableEntry>> = {
  default: { threshold: 1.5, beta: 0.02, jfet: false },
  'default-nodiode': { threshold: 1.5, beta: 0.02, jfet: false },
  'default-body': { threshold: 1.5, beta: 0.02, jfet: false },
  'default-digital': { threshold: 1.5, beta: 0.02, jfet: false },
  // Values taken from Hayes+Horowitz p155 (MosfetModel.java:132-134). These
  // are exactly the port's jfet engine defaults (jfet.rs:38-39), so resolving
  // this entry is identity for the engine.
  'default-jfet': { threshold: -4, beta: 0.00125, jfet: true },
};

/** The device family an element kind's model name resolves against, or
 *  undefined for an element that cannot name a model. */
export function modelFamilyFor(kind: string): ModelFamily | undefined {
  switch (kind) {
    case 'diode':
    case 'zener':
    case 'varactor':
    case 'led':
      // All four share the diode model machinery upstream (VaractorElm,
      // ZenerElm and LEDElm extend DiodeElm), so one family serves them.
      return 'diode';
    case 'transistor':
      return 'transistor';
    case 'mosfet':
      return 'mosfet';
    case 'jfet':
      return 'jfet';
    default:
      return undefined;
  }
}

/** A writable model entry: either the open document's own `34`/`32` line copy
 *  or a model the user created this session. `builtIn` is false on both, which
 *  is what marks an entry editable rather than a read-only table row. */
export interface UserDiodeEntry extends DiodeTableEntry {
  /** The model's name, the key of the `34` line and of this map. */
  name: string;
  /** False on every writable entry; the built-in rows carry no `builtIn` at
   *  all, so a caller can tell the two apart. */
  builtIn: false;
  /** The `34` line's flags token: bit 0 FLAGS_SIMPLE marks a simple-mode model
   *  (DiodeModel.java:29), which is what makes a reloaded model reopen in the
   *  simple editor with the forward-voltage rows. */
  flags?: number;
  /** The simple mode's forward drop at the entry's forward current, UI-only
   *  like upstream's `forwardVoltage` (DiodeModel.java:22, "used for UI
   *  code"): the dialog edits it and `pickName` names a model `fwdrop=` from
   *  it, but the `34` line never carries it (the emission coefficient encodes
   *  the same curve). */
  forwardVoltage?: number;
}

/** A writable transistor model. The port's Ebers-Moll consumes only satCur and
 *  betaR; the rest of an upstream row stays on the file line untouched. */
export interface UserTransistorEntry extends TransistorTableEntry {
  name: string;
  builtIn: false;
}

/** A writable mosfet/jfet model. These have no text line at all, so an entry
 *  here is session-only and a save emits nothing for it. */
export interface UserMosfetEntry extends MosfetTableEntry {
  name: string;
  builtIn: false;
}

export type UserModelEntry = UserDiodeEntry | UserTransistorEntry | UserMosfetEntry;

/** The families in the fixed order `allModels` and the store walk them. */
export const MODEL_FAMILIES: readonly ModelFamily[] = ['diode', 'transistor', 'mosfet', 'jfet'];

/**
 * The writable model store, per family a `Map<string, UserEntry>`. Module
 * state, deliberately not a zustand store field: the models belong to the
 * document like parsed file models do, so an undo of an element edit must not
 * roll a created model back. That is a divergence from upstream, whose undo
 * snapshots carry model definition nodes and genuinely roll model edits back;
 * the port compensates only the stack crossings (delete tombstones, pruned
 * model restores on undo/redo, session-library re-syncs from `.` lines), and
 * dialog edits stay session-persistent across them. The store clears this at
 * the start of each load and of New (the document-counter reset), then commits
 * the new file's `34`/`32` lines through `registerFileModels`, exactly how the
 * subcircuit library rebuilds its session half per load.
 */
const userModels: Record<ModelFamily, Map<string, UserModelEntry>> = {
  diode: new Map(),
  transistor: new Map(),
  mosfet: new Map(),
  jfet: new Map(),
};

/** Models `pruneUnreferencedModels` removed because their last referencing
 *  element was deleted, kept so an undo that brings that element back can
 *  restore the model with it. The delete is not final until the document
 *  moves on: without the tombstone, delete-then-undo would leave the element
 *  referencing a model the store no longer holds, and a save would drop the
 *  `34`/`32` line and a reload silently revert the model. Cleared with the
 *  live store on load and New. */
const prunedModels: Record<ModelFamily, Map<string, UserModelEntry>> = {
  diode: new Map(),
  transistor: new Map(),
  mosfet: new Map(),
  jfet: new Map(),
};

function mapFor(family: ModelFamily): Map<string, UserModelEntry> {
  return userModels[family];
}

function prunedFor(family: ModelFamily): Map<string, UserModelEntry> {
  return prunedModels[family];
}

/** The writable entry of this name, or undefined when the name names a
 *  built-in row or nothing at all. */
export function userModel(family: ModelFamily, name: string): UserModelEntry | undefined {
  return mapFor(family).get(name);
}

/** Puts or replaces the writable entry of its name. A put shadows a built-in
 *  of the same name, matching upstream's modelMap.put, and the save path then
 *  writes a `34`/`32` line for it. */
export function putUserModel(family: ModelFamily, entry: UserModelEntry): void {
  mapFor(family).set(entry.name, entry);
}

/** Removes the writable entry of this name, moving it to the delete tombstone
 *  so an undo of whatever removed it (a model rename in the dialog) can put it
 *  back; a no-op for a name nothing holds. */
export function deleteUserModel(family: ModelFamily, name: string): void {
  const entry = mapFor(family).get(name);
  if (entry === undefined) return;
  prunedFor(family).set(name, entry);
  mapFor(family).delete(name);
}

/** Drops every writable entry and every delete tombstone, whatever introduced
 *  them. The store calls this at the start of each load and of New, so the file
 *  being opened (or the empty new circuit) defines the only model namespace; a
 *  saved circuit re-enters its models through its own `34`/`32` lines, which
 *  the load commits next. */
export function clearUserModels(): void {
  for (const family of MODEL_FAMILIES) {
    mapFor(family).clear();
    prunedFor(family).clear();
  }
}

/** A point-in-time copy of both module maps. The Maps are shallow copies: an
 *  entry object is replaced wholesale on edit, never mutated, so sharing
 *  entries between a snapshot and the live maps loses nothing. */
export interface UserModelSnapshot {
  live: Record<ModelFamily, Map<string, UserModelEntry>>;
  pruned: Record<ModelFamily, Map<string, UserModelEntry>>;
}

function copyMaps(
  source: Record<ModelFamily, Map<string, UserModelEntry>>,
): Record<ModelFamily, Map<string, UserModelEntry>> {
  const out = {} as Record<ModelFamily, Map<string, UserModelEntry>>;
  for (const family of MODEL_FAMILIES) out[family] = new Map(source[family]);
  return out;
}

/** Freezes the writable namespace and its delete tombstones, taken by the
 *  subcircuit drill-in on enter so its exit can undo the load pipeline's
 *  clear. */
export function snapshotUserModels(): UserModelSnapshot {
  return { live: copyMaps(userModels), pruned: copyMaps(prunedModels) };
}

/** Puts both maps back to the snapshot's contents, dropping models created or
 *  edited since it was taken. */
export function restoreUserModels(snapshot: UserModelSnapshot): void {
  const live = copyMaps(snapshot.live);
  const pruned = copyMaps(snapshot.pruned);
  for (const family of MODEL_FAMILIES) {
    userModels[family] = live[family];
    prunedModels[family] = pruned[family];
  }
}

/** Commits the file's own `34`/`32` lines into the writable store, the load
 *  path's analogue of `registerSessionModel` for `.` lines (io/subcircuits.ts).
 *  The entries are writable like any other, so the editor can tune them, and
 *  the save path regenerates a file's line only when its body has been edited
 *  since the load. */
export function registerFileModels(
  diodeModels: Map<string, DiodeModel>,
  transistorModels: Map<string, TransistorModel>,
): void {
  for (const [name, model] of diodeModels) {
    putUserModel('diode', { ...model, name, builtIn: false });
  }
  for (const [name, model] of transistorModels) {
    putUserModel('transistor', { ...model, name, builtIn: false });
  }
}

/** One entry of the merged model list `allModels` returns: a built-in table
 *  row carrying its name and `builtIn: true`, or a writable entry. */
export type ModelListEntry =
  | UserModelEntry
  | (DiodeTableEntry & { name: string; builtIn: true })
  | (TransistorTableEntry & { name: string; builtIn: true })
  | (MosfetTableEntry & { name: string; builtIn: true });

function builtinListEntries(family: ModelFamily): ModelListEntry[] {
  const out: ModelListEntry[] = [];
  const table =
    family === 'transistor'
      ? TRANSISTOR_MODELS
      : family === 'mosfet' || family === 'jfet'
        ? MOSFET_MODELS
        : DIODE_MODELS;
  for (const [name, entry] of Object.entries(table)) {
    if (entry.internal) continue;
    // The mosfet and jfet share one table, split by the jfet flag the way
    // upstream's getModelList(isJfet) splits it (MosfetModel.java:212).
    if (family === 'mosfet' || family === 'jfet') {
      const m = entry as MosfetTableEntry;
      if (m.jfet !== (family === 'jfet')) continue;
    }
    out.push({ ...entry, name, builtIn: true } as ModelListEntry);
  }
  return out;
}

/** Every model name the picker or the editor can see for a family: the
 *  built-in table rows first (sorted), then the writable entries (sorted), the
 *  same shape upstream's getModelList produces over its single modelMap with
 *  the built-ins added first. A writable entry whose name a built-in row also
 *  holds (a legal file shape: a `34` line naming `1N4148`) shadows the built-in
 *  exactly as the load-time resolution does, so it takes the built-in's place
 *  in the list rather than appearing twice. The zener breakdown filter is
 *  applied by `selectableModels`, not here. */
export function allModels(family: ModelFamily): ModelListEntry[] {
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const users = [...mapFor(family).values()];
  const shadowed = new Set(users.map((e) => e.name));
  const builtins = builtinListEntries(family).filter((e) => !shadowed.has(e.name));
  return [...builtins.sort(byName), ...users.sort(byName)];
}

/** The picker option names for a family, sorted like upstream's getModelList
 *  (Collections.sort). Built-in and writable entries both appear; `internal`
 *  entries and the mosfet/jfet split are already excluded by `allModels`, and
 *  `requireBreakdown` (the zener's picker, getModelList DiodeModel.java:193-194)
 *  drops the diode rows whose breakdownVoltage is 0, a created zener included. */
export function selectableModels(family: ModelFamily, requireBreakdown = false): string[] {
  return allModels(family)
    .filter(
      (e) =>
        !requireBreakdown ||
        family !== 'diode' ||
        (e as UserDiodeEntry | (DiodeTableEntry & { builtIn: true })).breakdownVoltage !== 0,
    )
    .map((e) => e.name);
}

/** The forward drop a model implies, upstream's updateModel
 *  (DiodeModel.java:332-336). Deriving it matters: if the name is later
 *  dropped by an edit, the value-form dump writes the real drop, not the
 *  0.805904783 default. */
export function forwardVoltageFor(saturationCurrent: number, emissionCoefficient: number): number {
  return emissionCoefficient * VT * Math.log(1 / saturationCurrent + 1);
}

/** The saturation current a given forward drop at the given emission
 *  coefficient implies, the inverse of `forwardVoltageFor`: Is = 1/(e^(V/nvt)-1).
 *  Used to seed a create dialog from a value-form diode, whose element only
 *  carries the drop, and to round-trip the derivation in the tests. */
export function saturationCurrentFor(forwardVoltage: number, emissionCoefficient: number): number {
  return 1 / (Math.exp(forwardVoltage / (emissionCoefficient * VT)) - 1);
}

function paramsFor(
  family: ModelFamily,
  model: DiodeTableEntry | TransistorTableEntry | MosfetTableEntry,
): Record<string, number> {
  if (family === 'diode') {
    const d = model as DiodeTableEntry;
    return {
      saturationCurrent: d.saturationCurrent,
      seriesResistance: d.seriesResistance,
      emissionCoefficient: d.emissionCoefficient,
      breakdownVoltage: d.breakdownVoltage,
      forwardVoltage: forwardVoltageFor(d.saturationCurrent, d.emissionCoefficient),
    };
  }
  if (family === 'transistor') {
    const t = model as TransistorTableEntry;
    return { saturationCurrent: t.saturationCurrent, betaReverse: t.betaReverse };
  }
  const m = model as MosfetTableEntry;
  return { threshold: m.threshold, beta: m.beta };
}

function builtinEntry(
  family: ModelFamily,
  name: string,
): DiodeTableEntry | TransistorTableEntry | MosfetTableEntry | undefined {
  if (family === 'transistor') return TRANSISTOR_MODELS[name];
  if (family === 'mosfet' || family === 'jfet') return MOSFET_MODELS[name];
  return DIODE_MODELS[name];
}

/**
 * Resolve a named model to the params the engine reads, mirroring upstream's
 * `getModelWithNameOrCopy` (DiodeModel.java:62-76, TransistorModel.java:99-112,
 * MosfetModel.java:95-108):
 *
 * 1. The file's own `34`/`32` line wins when `fileModel` is present.
 * 2. On a file miss the writable store is consulted, so a model created or
 *    edited this session (a loaded file model included, once the store has
 *    committed it) resolves before the built-in table. This is what lets an
 *    in-place model edit refresh every referencing element: the store re-runs
 *    this resolution after `putUserModel`.
 * 3. The built-in table is consulted next, by exact case-sensitive name.
 * 4. A miss returns undefined so the caller keeps the element on its defaults,
 *    and the name round-trips. It never throws.
 *
 * The returned params are exactly what the `34`/`32` load-time resolution
 * writes: the diode family carries the derived forward drop, the transistor
 * carries satCur and betaR, the mosfet/jfet carries threshold and beta.
 */
export function resolveModelParams(
  family: ModelFamily,
  name: string,
  fileModel: DiodeModel | TransistorModel | null | undefined,
): Record<string, number> | undefined {
  if (fileModel !== null && fileModel !== undefined) {
    return paramsFor(family, fileModel as DiodeTableEntry | TransistorTableEntry);
  }
  const user = userModel(family, name);
  if (user !== undefined) return paramsFor(family, user);
  const entry = builtinEntry(family, name);
  if (entry !== undefined) return paramsFor(family, entry);
  return undefined;
}

// ─── the editor dialog's model math ───

/** A copy of the element's current model to start a create dialog from,
 *  upstream's `new DiodeModel(model)` copy (DiodeElm.java:246): the new model
 *  inherits the current one's parameters under an empty name, so the dialog
 *  starts from a real curve and pickName names the result on OK. A value-form
 *  diode carries no model object, so its saturation current is recovered from
 *  the forward drop the element stores. */
export function seedModelEntry(
  family: ModelFamily,
  params: Record<string, number>,
  source: UserModelEntry | undefined,
  action: 'create-simple' | 'create-advanced' | 'create',
): UserModelEntry | undefined {
  if (family === 'transistor') {
    const src = source as UserTransistorEntry | undefined;
    return {
      name: '',
      builtIn: false,
      saturationCurrent: src?.saturationCurrent ?? params.saturationCurrent ?? 1e-13,
      betaReverse: src?.betaReverse ?? params.betaReverse ?? 1,
    };
  }
  if (family === 'mosfet' || family === 'jfet') {
    const src = source as UserMosfetEntry | undefined;
    return {
      name: '',
      builtIn: false,
      threshold: src?.threshold ?? params.threshold ?? 1.5,
      beta: src?.beta ?? params.beta ?? 0.02,
      jfet: family === 'jfet',
    };
  }
  const src = source as UserDiodeEntry | undefined;
  let saturationCurrent = src?.saturationCurrent ?? params.saturationCurrent;
  if (saturationCurrent === undefined || !(saturationCurrent > 0) || !Number.isFinite(saturationCurrent)) {
    saturationCurrent = saturationCurrentFor(params.forwardVoltage ?? 0.805904783, params.emissionCoefficient ?? 2);
  }
  const base = {
    saturationCurrent,
    seriesResistance: src?.seriesResistance ?? params.seriesResistance ?? 0,
    emissionCoefficient: src?.emissionCoefficient ?? params.emissionCoefficient ?? 2,
    breakdownVoltage: src?.breakdownVoltage ?? params.breakdownVoltage ?? 0,
  };
  if (action === 'create-simple') {
    const fwd = simpleForwardSeed(base.saturationCurrent, base.emissionCoefficient, src?.forwardCurrent);
    return {
      name: '',
      builtIn: false,
      flags: 1,
      ...base,
      forwardCurrent: fwd.forwardCurrent,
      forwardVoltage: fwd.forwardVoltage,
    };
  }
  return { name: '', builtIn: false, flags: 0, ...base };
}

/** The emission coefficient a simple-mode diode model derives from its forward
 *  voltage and current, upstream's setEmissionCoefficient
 *  (DiodeModel.java:319-321): n = (V / ln(I/Is + 1)) / vt. The inverse of
 *  `forwardVoltageFor`, which is how the two directions round-trip. */
export function emissionCoefficientFor(
  forwardVoltage: number,
  forwardCurrent: number,
  saturationCurrent: number,
): number {
  return forwardVoltage / Math.log(forwardCurrent / saturationCurrent + 1) / VT;
}

/** The forward drop at a given forward current, the general form of
 *  `forwardVoltageFor` (which assumes 1 A): V = n*vt*ln(I/Is + 1). The dialog
 *  uses it to show the Forward Voltage field of a loaded simple model, whose
 *  `34` line carries only the current. */
export function forwardVoltageAt(
  saturationCurrent: number,
  emissionCoefficient: number,
  forwardCurrent: number,
): number {
  return emissionCoefficient * VT * Math.log(forwardCurrent / saturationCurrent + 1);
}

/** The forward-current and forward-voltage a fresh simple-mode diode model is
 *  seeded with, upstream's setForwardVoltage (DiodeModel.java:326-330): the
 *  copy carries the source model's forward current, defaulting to 1 A when it
 *  has none, and the forward voltage is derived at that current. */
export function simpleForwardSeed(
  saturationCurrent: number,
  emissionCoefficient: number,
  sourceForwardCurrent: number | undefined,
): { forwardCurrent: number; forwardVoltage: number } {
  const forwardCurrent = sourceForwardCurrent ?? 1;
  return {
    forwardCurrent,
    forwardVoltage: forwardVoltageAt(saturationCurrent, emissionCoefficient, forwardCurrent),
  };
}

/** The entry a simple-mode dialog OK writes, built from the entry the dialog
 *  opened on and the field values. When no simple-mode field actually changed,
 *  the file's stored emission coefficient is kept verbatim instead of being
 *  re-derived: deriving n from the forward drop does not round-trip bit
 *  exactly (a stored 1.906 derives back as 1.9060000000000001), and an
 *  untouched model must keep its `34` line's bytes. Only an edit to the
 *  forward voltage, forward current or saturation current re-derives n,
 *  upstream's setEmissionCoefficient (DiodeModel.java:319-321). */
export function simpleDiodeEntry(
  initial: UserDiodeEntry,
  fields: {
    name: string;
    saturationCurrent: number;
    forwardVoltage: number;
    forwardCurrent: number;
    breakdownVoltage: number;
  },
): UserDiodeEntry {
  const initialForwardVoltage =
    initial.forwardVoltage ??
    forwardVoltageAt(
      initial.saturationCurrent,
      initial.emissionCoefficient,
      initial.forwardCurrent ?? 1,
    );
  const unchanged =
    fields.saturationCurrent === initial.saturationCurrent &&
    fields.forwardVoltage === initialForwardVoltage &&
    fields.forwardCurrent === (initial.forwardCurrent ?? 1);
  return {
    name: fields.name,
    builtIn: false,
    flags: 1,
    saturationCurrent: fields.saturationCurrent,
    seriesResistance: 0,
    emissionCoefficient: unchanged
      ? initial.emissionCoefficient
      : emissionCoefficientFor(fields.forwardVoltage, fields.forwardCurrent, fields.saturationCurrent),
    breakdownVoltage: Math.abs(fields.breakdownVoltage),
    forwardCurrent: fields.forwardCurrent,
    forwardVoltage: fields.forwardVoltage,
  };
}

/** The number format upstream's pickName uses, `####.` plus one `#` per
 *  decimal digit (CircuitElm.showFormat, CircuitElm.java:165-174): up to three
 *  decimals with the trailing zeros dropped, and at least one decimal digit so
 *  an integral voltage reads `5.0`, not `5`. */
function showFormat(v: number): string {
  const s = v.toFixed(3).replace(/\.?0+$/, '');
  return s.includes('.') ? s : `${s}.0`;
}

/** The family's fallback model word, upstream's pickName for the non-zener,
 *  non-simple cases (DiodeModel.java:365-371, TransistorModel.java:340,
 *  MosfetModel.java:374). */
function familyWord(family: ModelFamily): string {
  switch (family) {
    case 'transistor':
      return 'transistormodel';
    case 'mosfet':
      return 'mosfetmodel';
    case 'jfet':
      return 'jfetmodel';
    default:
      return 'diodemodel';
  }
}

/** Whether a name of this family is taken, by a built-in row or by a writable
 *  entry, other than the model being applied. `selfName` is the name the edit
 *  started from, or undefined for a create: an in-place edit that keeps its
 *  name does not collide with itself, while a file model that shadows a
 *  built-in of the same name still keeps that name. */
function familyNameTaken(family: ModelFamily, name: string, selfName?: string): boolean {
  if (name === selfName) return false;
  if (builtinEntry(family, name) !== undefined) return true;
  return userModel(family, name) !== undefined;
}

/**
 * The name an OK applies when the dialog's name field is empty, upstream's
 * pickName (DiodeModel.java:365-382, TransistorModel.java:339-352,
 * MosfetModel.java:373-385): a zener whose breakdown is between 0 and 20 V
 * becomes `zener-<V>`, a simple diode `fwdrop=<V>`, and everything else takes
 * the family word, with `-2`, `-3`, ... suffixed on a collision against any
 * other model of the family. An explicit name is left alone, exactly as
 * upstream only runs pickName on the empty field; the collision suffix is
 * still applied to an explicit name that another model already holds, which
 * keeps a user model from silently shadowing a built-in row.
 */
export function synthesizeModelName(family: ModelFamily, entry: UserModelEntry, selfName?: string): string {
  let name = entry.name;
  if (name === '') {
    if (family === 'diode') {
      const d = entry as UserDiodeEntry;
      if (d.breakdownVoltage > 0 && d.breakdownVoltage < 20) {
        name = `zener-${showFormat(d.breakdownVoltage)}`;
      } else if ((d.flags ?? 0) & 1) {
        name = `fwdrop=${showFormat(d.forwardVoltage ?? 0)}`;
      } else {
        name = familyWord(family);
      }
    } else {
      name = familyWord(family);
    }
  }
  if (familyNameTaken(family, name, selfName)) {
    let num = 2;
    while (familyNameTaken(family, `${name}-${num}`, selfName)) num += 1;
    return `${name}-${num}`;
  }
  return name;
}

/** Removes every writable model no element references, the deletion rule for a
 *  dropped element: when the last referencing element goes, the model it used
 *  leaves the session namespace with it. The removed entry goes to the delete
 *  tombstone rather than being forgotten, so an undo that restores a
 *  referencing element can put it back (see `restorePrunedModels`). A file
 *  model's `34`/`32` line is not touched by this, so it survives in passthrough
 *  and re-registers on the next load; the data-preservation rule lives in the
 *  store, which never edits those lines. */
export function pruneUnreferencedModels(elements: readonly { kind: string; modelName?: string }[]): void {
  const used = new Map<ModelFamily, Set<string>>();
  for (const e of elements) {
    if (e.modelName === undefined) continue;
    const family = modelFamilyFor(e.kind);
    if (family === undefined) continue;
    let names = used.get(family);
    if (names === undefined) {
      names = new Set();
      used.set(family, names);
    }
    names.add(e.modelName);
  }
  for (const family of MODEL_FAMILIES) {
    const names = used.get(family);
    const map = mapFor(family);
    for (const [name, entry] of [...map]) {
      if (names === undefined || !names.has(name)) {
        prunedFor(family).set(name, entry);
        map.delete(name);
      }
    }
  }
}

/** Puts back every tombstoned model the given elements reference, the
 *  undo/redo half of the delete-prune pair. A Ctrl+Z that restores a deleted
 *  element also has to bring back the model that element names, or a save
 *  would drop its `34`/`32` line and a reload would silently revert it. Only a
 *  name the live store does not already hold is restored, so a model the user
 *  recreated since the delete wins over the tombstone. */
export function restorePrunedModels(elements: readonly { kind: string; modelName?: string }[]): void {
  const used = new Map<ModelFamily, Set<string>>();
  for (const e of elements) {
    if (e.modelName === undefined) continue;
    const family = modelFamilyFor(e.kind);
    if (family === undefined) continue;
    let names = used.get(family);
    if (names === undefined) {
      names = new Set();
      used.set(family, names);
    }
    names.add(e.modelName);
  }
  for (const family of MODEL_FAMILIES) {
    const names = used.get(family);
    if (names === undefined) continue;
    const map = mapFor(family);
    for (const name of names) {
      if (map.has(name)) continue;
      const entry = prunedFor(family).get(name);
      if (entry === undefined) continue;
      prunedFor(family).delete(name);
      map.set(name, entry);
    }
  }
}

// ─── the `34`/`32` line writers ───

/** One `34` diode-model line for a writable entry, the token order
 *  `parseDiodeModelLine` reads: `34 <escaped name> <flags> <satCur> <rs> <n>
 *  <bv> [<forwardCurrent>]` (DiodeModel.dump, DiodeModel.java:338-341). The
 *  forward current is written only when the entry carries one, which the
 *  simple-mode editor does. */
export function diodeModelLine(entry: UserDiodeEntry): string {
  const tokens = [
    '34',
    escapeToken(entry.name),
    entry.flags ?? 0,
    entry.saturationCurrent,
    entry.seriesResistance,
    entry.emissionCoefficient,
    entry.breakdownVoltage,
  ];
  if (entry.forwardCurrent !== undefined) tokens.push(String(entry.forwardCurrent));
  return tokens.join(' ');
}

/** The defaults upstream's TransistorModel constructor fills a fresh model
 *  with (TransistorModel.java:70-86), for the tokens the port does not model:
 *  the `32` line still has to carry the full table `parseTransistorModelLine`
 *  and upstream's undump walk, even though only satCur and betaR resolve. */
const TRANSISTOR_LINE_DEFAULTS = [0, 0, 1.5, 0, 0, 2, 1, 1, 0, 0];

/** One `32` transistor-model line for a fresh writable entry. The tokens the
 *  port does not model ride the upstream constructor defaults, in the order
 *  `parseTransistorModelLine` reads: `32 <escaped name> <flags> <satCur>
 *  <invRollOffF> <BEleakCur> <leakBEemissionCoeff> <invRollOffR> <BCleakCur>
 *  <leakBCemissionCoeff> <emissionCoeffF> <emissionCoeffR> <invEarlyVoltF>
 *  <invEarlyVoltR> <betaR>`. */
export function transistorModelLine(entry: UserTransistorEntry): string {
  return ['32', escapeToken(entry.name), 0, entry.saturationCurrent, ...TRANSISTOR_LINE_DEFAULTS, entry.betaReverse].join(' ');
}

/** The same `32` line with the two modelled tokens rewritten and every other
 *  token carried over byte for byte. Editing a file's transistor model must not
 *  drop the table rows the port does not model, so the write-back edits the
 *  stored line in place rather than regenerating it from the two known fields.
 *  Only used on a line the file introduced, which `parseTransistorModelLine`
 *  has already proved carries the full table. An unchanged token keeps its
 *  original spelling: the file may write 1 as `1.0` or `1e0`, and rewriting
 *  it would break byte fidelity for an edit that only touched the other
 *  parameter. */
export function regenerateTransistorLine(rawLine: string, entry: UserTransistorEntry): string {
  // Keep whatever indentation the author wrote: the order walk's raw line can
  // carry leading whitespace, which a bare split on `\s+` would turn into an
  // empty first token and shift every index by one.
  const leading = /^\s*/.exec(rawLine)?.[0] ?? '';
  const tokens = rawLine.trim().split(/\s+/);
  if (Number(tokens[3]) !== entry.saturationCurrent) tokens[3] = String(entry.saturationCurrent);
  if (Number(tokens[14]) !== entry.betaReverse) tokens[14] = String(entry.betaReverse);
  return leading + tokens.join(' ');
}

/** The same `34` line with the file line's leading whitespace preserved, so an
 *  edited file model's regeneration does not re-indent an indented line while
 *  `regenerateTransistorLine` keeps its own indentation. The tokens themselves
 *  are the canonical `diodeModelLine` form, which the transistor writer cannot
 *  use because it does not model every token. */
export function regenerateDiodeLine(rawLine: string, entry: UserDiodeEntry): string {
  const leading = /^\s*/.exec(rawLine)?.[0] ?? '';
  return leading + diodeModelLine(entry);
}

/** Whether two diode models are the same body, the comparison the save path
 *  makes before regenerating a file's `34` line: an untouched file model keeps
 *  its bytes, an edited one is rewritten. Only the params the editor and the
 *  engine read are compared, never the token layout. */
export function sameDiodeModelBody(a: DiodeModel, b: DiodeModel): boolean {
  return (
    a.saturationCurrent === b.saturationCurrent &&
    a.seriesResistance === b.seriesResistance &&
    a.emissionCoefficient === b.emissionCoefficient &&
    a.breakdownVoltage === b.breakdownVoltage &&
    (a.forwardCurrent ?? 0) === (b.forwardCurrent ?? 0)
  );
}

/** Whether two transistor models are the same body, the same comparison for
 *  the `32` line. */
export function sameTransistorModelBody(a: TransistorModel, b: TransistorModel): boolean {
  return a.saturationCurrent === b.saturationCurrent && a.betaReverse === b.betaReverse;
}
