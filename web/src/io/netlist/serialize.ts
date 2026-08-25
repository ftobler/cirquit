import { defFor } from '../../model/registry';
import {
  diodeModelLine,
  modelFamilyFor,
  regenerateDiodeLine,
  regenerateTransistorLine,
  sameDiodeModelBody,
  sameTransistorModelBody,
  transistorModelLine,
  userModel,
  type ModelFamily,
  type UserDiodeEntry,
  type UserTransistorEntry,
} from '../../model/deviceModels';
import type { CircuitElement, SimSettings } from '../../model/types';
import type { DiodeModel, NetlistLine, ScopeConfig, ScopePlotConfig, SliderConfig, TransistorModel } from './types';
import { escapeToken } from './tokens';
import {
  FLAG_DIVISIONS,
  FLAG_PERPLOTFLAGS,
  FLAG_PERPLOT_MAN_SCALE,
  FLAG_PLOTS,
  dumpCodeOfLine,
  importDecOrHex,
  isElementLine,
  kindOfDumpCode,
  parseDiodeModelLine,
  parseTransistorModelLine,
  unitsOf,
} from './parse';

/**
 * Rebuilds the `$` line rather than echoing the parsed one, so edits to the
 * settings are saved. The tokens this build does not model are written back
 * from `settings` when the file supplied them, and default to what a fresh
 * circuit has always written when it did not.
 */
function headerLine(settings: SimSettings): string {
  // Bits 1 (show current), 4 (voltage off), 8 (power on), 16 (show values), 64
  // (adaptive timestep) and 128 (DC operating point) are modelled, so each is
  // recomputed from its setting; every other loaded bit is passed straight
  // back. Bit 2 is upstream's small grid, an option this port removed: the bit
  // is deliberately kept in the passthrough set rather than dropped on save,
  // so the byte upstream wrote is the byte the port writes. It rides the
  // `headerFlags` field like bits 32 and above, an inert value nothing reads.
  // The two colour modes are mutually exclusive, so at most one of bits 4 and
  // 8 is set, the shape upstream's own writer produces (dumpOptions).
  const flags =
    (settings.showCurrent ? 1 : 0) |
    (settings.showVoltageColor ? 0 : 4) |
    (settings.showPowerColor ? 8 : 0) |
    (settings.showValues ? 0 : 16) |
    ((settings.headerFlags ?? 0) & ~(1 | 4 | 8 | 16 | 64 | 128)) |
    (settings.adaptiveTimeStep ? 64 : 0) |
    (settings.autoDC ? 128 : 0);
  return [
    '$',
    flags,
    settings.timeStep,
    settings.iterCount ?? 10,
    settings.currentSpeed,
    settings.voltageRange,
    settings.powerRange ?? 50,
    // Upstream's own default, set on every clear (CircuitLoader.java:50). The
    // port used to write timeStep/100, which is both a different number and,
    // in binary floating point, a long one.
    settings.minTimeStep ?? 50e-12,
  ].join(' ');
}

/** One element line, or null for a kind this build cannot write. A routed
 *  wire's `route` is session drawing state and deliberately absent here: the
 *  text format has no place for it (upstream's RoutedWireElm has no text dump
 *  type), so a save degrades routed wires to plain two-endpoint `w` lines.
 *  Copy, paste, duplicate and Save As all go through this writer, so the route
 *  never survives any of them; that is the policy, not a bug to "fix". */
function elementLine(e: CircuitElement): string | null {
  const def = defFor(e.kind);
  if (!def) return null;
  const extra = (def.dump?.(e) ?? []).map((v) =>
    typeof v === 'string' && !def.rawTokens ? escapeToken(v) : String(v),
  );
  return [def.dumpCode, e.x1, e.y1, e.x2, e.y2, def.dumpFlags?.(e) ?? e.flags, ...extra].join(' ');
}

/**
 * Renumbers the `ne` token every plot after the first carries inside `raw`,
 * walking the same new-style plot list `parseScopeLine`/`decodeScopeLine`
 * read (parse.ts, ../scopeLine.ts), so the cursor lands on the same tokens
 * those readers do. Plot 0's index lives in the leading `e` token ahead of
 * `raw`, already recomputed by `scopeLineFor`; this only rewrites what `raw`
 * itself carries for plot 1 and beyond. A plot whose target this build could
 * not read keeps the token the file gave it, the same "nothing better is
 * knowable" rule `scopeLineFor` uses for plot 0.
 */
function renumberPlotIndices(
  raw: string[],
  plots: ScopePlotConfig[],
  ordinalById: Map<number, number>,
  kindOf: (plot: ScopePlotConfig) => string | null,
): string[] {
  if (plots.length < 2) return raw;
  const valueToken = Number(raw[1]);
  const flags = importDecOrHex(raw[2] ?? '0');
  if ((flags & FLAG_PLOTS) === 0) return raw;

  const out = raw.slice();
  let cursor = 5;  // raw[0]=speed [1]=value [2]=flags [3]=scaleV [4]=scaleA
  const next = (): number => Number(out[cursor++]);
  const position = next();
  const sz = next();
  if (!Number.isFinite(position) || !Number.isFinite(sz)) return raw;

  if ((flags & FLAG_DIVISIONS) !== 0) cursor += 1;
  // Plot 0's units can carry an extra scale token before the per-plot tokens
  // (ScopeSerializer.java:221-223).
  if (unitsOf(valueToken, kindOf(plots[0])) > 1 && cursor < out.length) cursor += 1;
  for (let i = 0; i < sz && i < plots.length; i++) {
    if ((flags & FLAG_PERPLOTFLAGS) !== 0 && cursor < out.length) cursor += 1;
    if (i !== 0) {
      const neSlot = cursor;
      const ne = Number(out[cursor++]);
      const val = Number(out[cursor++]);
      if (!Number.isFinite(ne) || !Number.isFinite(val)) break;
      const plot = plots[i];
      if (plot.elementId !== undefined) {
        out[neSlot] = String(ordinalById.get(plot.elementId) ?? -1);
      }
      if (unitsOf(val, kindOf(plot)) > 1 && cursor < out.length) cursor += 1;
    }
    if ((flags & FLAG_PERPLOT_MAN_SCALE) !== 0) cursor += 2;
  }
  return out;
}

/**
 * One `o` line. The index token is recomputed from where the target element
 * ended up in the written file, so deleting an element ahead of a scope does
 * not silently repoint it. A scope whose target this build could not read
 * keeps the index the file gave it: nothing better is knowable, and the common
 * load-then-save case leaves it exactly right. Every plot after the first
 * carries its own `ne` token inside `raw`; those are renumbered the same way,
 * not just the leading token, so a two-plot scope with distinct targets
 * survives a delete ahead of it (see `renumberPlotIndices`).
 */
function scopeLineFor(
  s: ScopeConfig,
  ordinalById: Map<number, number>,
  kindOf: (plot: ScopePlotConfig) => string | null,
): string {
  const index =
    s.elementId === undefined ? s.elementIndex : (ordinalById.get(s.elementId) ?? -1);
  const raw = renumberPlotIndices(s.raw, s.plots, ordinalById, kindOf);
  return ['o', index, ...raw].join(' ');
}

/**
 * One `38` slider line. The `e` token is recomputed from where the target
 * element landed, like the scope writer, so deleting or reordering an element
 * ahead of the slider does not silently repoint it. A deleted element writes
 * the upstream `-1` sentinel (Adjustable.java:49-50); an element line this
 * build could not read keeps the index the file gave it, the same rule scopes
 * use. Every other token is kept exactly as loaded. A slider with no loaded
 * tokens (created in the UI, a later stage) writes the `e F<flags> editItem
 * min max [ano] text step` form, the `ano` token present, and FLAG_SHARED
 * (bit 1) set, only when `shared` is non-null. Upstream's own dump()
 * (Adjustable.java:183-196) writes `ano` unconditionally while its reader
 * only consumes it under FLAG_SHARED (:54-58), so a current-format upstream
 * save of a non-shared slider misreads its own caption and step; gating the
 * token on the flag here keeps this port's writer and reader in agreement
 * instead of reproducing that mismatch. The reader path is shared, only the
 * token form differs.
 */
function sliderLineFor(s: SliderConfig, ordinalById: Map<number, number>): string {
  const index =
    s.elementId === undefined ? Number(s.raw[0] ?? -1) : (ordinalById.get(s.elementId) ?? -1);
  if (s.raw.length === 0) {
    const shared = s.shared !== null;
    const flags = (shared ? 1 : 0) | (s.logarithmic ? 2 : 0);
    return [
      '38',
      index,
      `F${flags}`,
      s.editItem,
      s.min,
      s.max,
      ...(shared ? [s.shared] : []),
      escapeToken(s.text),
      s.step,
    ].join(' ');
  }
  return ['38', index, ...s.raw.slice(1)].join(' ');
}

/** The writable-model work an element names, or null for one that names none:
 *  value-form diodes carry no modelName, built-in and unknown names resolve to
 *  no writable entry, and mosfet/jfet models never take a text line at all. */
function writableModelOf(e: CircuitElement): { family: ModelFamily; name: string } | null {
  if (e.modelName === undefined) return null;
  const family = modelFamilyFor(e.kind);
  if (family !== 'diode' && family !== 'transistor') return null;
  return { family, name: e.modelName };
}

/** The `34`/`32` line a writable entry serializes as, or null when the name
 *  does not resolve to one: built-ins take no line, and mosfet/jfet have no
 *  text line at all. */
function modelLineFor(family: ModelFamily, name: string): string | null {
  const entry = userModel(family, name);
  if (entry === undefined) return null;
  if (family === 'diode') return diodeModelLine(entry as UserDiodeEntry);
  if (family === 'transistor') return transistorModelLine(entry as UserTransistorEntry);
  return null;
}

/**
 * Serialises a circuit back to the original format.
 *
 * With an `order` from `parseCircuit`, the file's arrangement is reproduced:
 * comments, blank lines and unmodelled lines stay between the same neighbours
 * they were loaded between, and anything created since the load appends at the
 * end. Without one (the copy/paste subset path) the layout is header,
 * elements, scopes, then passthrough. `order` supersedes `passthrough`, whose
 * lines it already carries.
 */
export function serializeCircuit(
  elements: CircuitElement[],
  settings: SimSettings,
  scopes: ScopeConfig[] = [],
  passthrough: string[] = [],
  order?: NetlistLine[],
  sliders: SliderConfig[] = [],
): string {
  const header = headerLine(settings);
  const rendered: { id: number; line: string }[] = [];
  for (const e of elements) {
    const line = elementLine(e);
    if (line !== null) rendered.push({ id: e.id, line });
  }
  const ordinalById = new Map<number, number>();
  // A plot's own kind, keyed by its element id: renumbering a non-first plot's
  // `ne` token has to skip the same per-unit scale tokens the parser skipped
  // reading it, and that decision is kind-dependent (see `unitsOf`). A plot
  // whose target this build could not read has no element id; the order-walk
  // below records that slot's raw dump code instead, so `kindOf` can fall
  // back to the same kind guess `parseScopeLine` used on load
  // (`kindOfDumpCode`), keeping the two walks in agreement.
  const kindById = new Map(elements.map((e) => [e.id, e.kind]));
  const dumpCodeByFileIndex = new Map<number, string>();
  const kindOf = (plot: ScopePlotConfig): string | null => {
    if (plot.elementId !== undefined) return kindById.get(plot.elementId) ?? null;
    const code = dumpCodeByFileIndex.get(plot.elementIndex);
    return code === undefined ? null : kindOfDumpCode(code);
  };

  // An empty order is "no file was loaded", not "the file was empty", so it
  // takes the default layout rather than dropping the passthrough lines.
  if (!order || order.length === 0) {
    rendered.forEach((r, i) => ordinalById.set(r.id, i));
    const elementById = new Map(elements.map((e) => [e.id, e]));
    // No file was loaded, so every referenced writable model is session-only:
    // emit its `34`/`32` line once, ahead of the first element that names it,
    // so a save (and a copy or duplicate, which take this same path) carries
    // the model a reload needs. A fresh circuit's passthrough holds no model
    // lines, so there is nothing to compare against here.
    const body: string[] = [];
    const emitted = new Set<string>();
    for (const r of rendered) {
      const e = elementById.get(r.id);
      const m = e === undefined ? null : writableModelOf(e);
      if (m !== null && !emitted.has(`${m.family}:${m.name}`)) {
        const line = modelLineFor(m.family, m.name);
        if (line !== null) {
          emitted.add(`${m.family}:${m.name}`);
          body.push(line);
        }
      }
      body.push(r.line);
    }
    const traces = scopes.map((s) => scopeLineFor(s, ordinalById, kindOf));
    const sliderLines = sliders.map((s) => sliderLineFor(s, ordinalById));
    return [header, ...body, ...traces, ...sliderLines, ...passthrough].join('\n') + '\n';
  }

  // Slots are array positions, not ids, so two elements that somehow share an
  // id (the format has no concept of one) both still reach the file.
  const slotById = new Map<number, number[]>();
  rendered.forEach((r, i) => {
    const slots = slotById.get(r.id);
    if (slots) slots.push(i);
    else slotById.set(r.id, [i]);
  });
  const scopeSlots = new Map<number, number>();
  scopes.forEach((s, i) => scopeSlots.set(s.id, i));
  const sliderSlots = new Map<number, number>();
  sliders.forEach((s, i) => sliderSlots.set(s.id, i));

  // Pre-pass over the preserved lines: collect the file's `34`/`32` model
  // lines, keyed by name with the last one winning, the same last-wins rule
  // the load's map uses. The walk below keeps an untouched line's bytes and
  // regenerates an edited one at its own slot.
  const fileDiodeLines = new Map<string, { raw: string; body: DiodeModel; at: number }>();
  const fileTransistorLines = new Map<string, { raw: string; body: TransistorModel; at: number }>();
  order.forEach((entry, at) => {
    if (entry.kind !== 'other') return;
    const parsedDiode = parseDiodeModelLine(entry.line);
    if (parsedDiode !== null) {
      fileDiodeLines.set(parsedDiode.name, { raw: entry.line, body: parsedDiode.model, at });
      return;
    }
    const parsedTransistor = parseTransistorModelLine(entry.line);
    if (parsedTransistor !== null) {
      fileTransistorLines.set(parsedTransistor.name, { raw: entry.line, body: parsedTransistor.model, at });
    }
  });
  const elementById = new Map(elements.map((e) => [e.id, e]));
  // File lines to rewrite, keyed by their slot in the order walk. Decided in
  // its own pass ahead of the walk: a file's `34`/`32` line can sit above the
  // first element that names it, so by the time the walk reaches that element
  // the line would already have been written verbatim. Every live element is
  // consulted, order-tracked or not: an element placed or pasted after the
  // load has no order slot, yet it is the reason a shared file model's edit
  // must still reach the file.
  const regenerateAt = new Map<number, string>();
  for (const e of elements) {
    const m = writableModelOf(e);
    if (m === null) continue;
    const fileLine =
      m.family === 'diode' ? fileDiodeLines.get(m.name) : fileTransistorLines.get(m.name);
    const writable = userModel(m.family, m.name);
    if (fileLine === undefined || writable === undefined) continue;
    const edited =
      m.family === 'diode'
        ? !sameDiodeModelBody(fileLine.body as DiodeModel, writable as UserDiodeEntry)
        : !sameTransistorModelBody(
            fileLine.body as TransistorModel,
            writable as UserTransistorEntry,
          );
    if (edited) {
      regenerateAt.set(
        fileLine.at,
        m.family === 'diode'
          ? regenerateDiodeLine(fileLine.raw, writable as UserDiodeEntry)
          : regenerateTransistorLine(fileLine.raw, writable as UserTransistorEntry),
      );
    }
  }
  // Session-only models already written ahead of a naming element.
  const emittedFresh = new Set<string>();

  const lines: string[] = [];
  const usedElements = new Set<number>();
  const usedScopes = new Set<number>();
  const usedSliders = new Set<number>();
  // Scope and slider lines are written last: their index tokens depend on
  // where every element landed, which is only known once the whole walk is
  // done.
  const deferred: { at: number; kind: 'scope' | 'slider'; slot: number }[] = [];
  let fileIndex = 0;
  let sawHeader = false;
  order.forEach((entry, i) => {
    if (entry.kind === 'header') {
      lines.push(header);
      sawHeader = true;
    } else if (entry.kind === 'other') {
      lines.push(regenerateAt.get(i) ?? entry.line);
      // An unmodelled element line still takes its slot (see `parseCircuit`);
      // its raw dump code is recorded so a plot targeting it can still resolve
      // a kind for `unitsOf`, the same fallback the reader uses.
      if (isElementLine(entry.line)) {
        dumpCodeByFileIndex.set(fileIndex, dumpCodeOfLine(entry.line));
        fileIndex += 1;
      }
    } else if (entry.kind === 'element') {
      // A deleted element vacates its slot; the lines around it do not move.
      const slot = (slotById.get(entry.id) ?? []).find((x) => !usedElements.has(x));
      if (slot !== undefined) {
        usedElements.add(slot);
        ordinalById.set(entry.id, fileIndex++);
        // A session-only writable model (one the file's lines do not define) is
        // emitted here, once, ahead of the first element that names it. File
        // models were already handled by the regeneration pass above.
        const e = elementById.get(entry.id);
        const m = e === undefined ? null : writableModelOf(e);
        const fileLine =
          m === null
            ? undefined
            : m.family === 'diode'
              ? fileDiodeLines.get(m.name)
              : fileTransistorLines.get(m.name);
        if (m !== null && fileLine === undefined) {
          if (!emittedFresh.has(`${m.family}:${m.name}`)) {
            const line = modelLineFor(m.family, m.name);
            if (line !== null) {
              emittedFresh.add(`${m.family}:${m.name}`);
              lines.push(line);
            }
          }
        }
        lines.push(rendered[slot].line);
      }
    } else if (entry.kind === 'slider') {
      const slot = sliderSlots.get(entry.id);
      if (slot !== undefined && !usedSliders.has(slot)) {
        usedSliders.add(slot);
        deferred.push({ at: lines.length, kind: 'slider', slot });
        lines.push('');
      }
    } else {
      const slot = scopeSlots.get(entry.id);
      if (slot !== undefined && !usedScopes.has(slot)) {
        usedScopes.add(slot);
        deferred.push({ at: lines.length, kind: 'scope', slot });
        lines.push('');
      }
    }
  });
  // A headerless file that holds a circuit still has to save its settings.
  // The XML converter runs inside parseCircuit, so a `<cir>` document arrives
  // here already as real text lines and takes the `$` header like any other
  // file: a converted circuit saves as migrated text, not as XML. Only a
  // document that yields no lines at all stays headerless.
  if (!sawHeader && rendered.length + scopes.length + sliders.length > 0) {
    lines.unshift(header);
    for (const d of deferred) d.at += 1;
  }
  rendered.forEach((r, i) => {
    if (usedElements.has(i)) return;
    ordinalById.set(r.id, fileIndex++);
    // An element with no order slot (placed or pasted after the load) still
    // needs its session-only model's line: the walk above only visits the
    // file's own element slots, so without this a model created for a fresh
    // element would never reach the saved file and a reload would drop it.
    const e = elementById.get(r.id);
    const m = e === undefined ? null : writableModelOf(e);
    const fileLine =
      m === null
        ? undefined
        : m.family === 'diode'
          ? fileDiodeLines.get(m.name)
          : fileTransistorLines.get(m.name);
    if (m !== null && fileLine === undefined && !emittedFresh.has(`${m.family}:${m.name}`)) {
      const line = modelLineFor(m.family, m.name);
      if (line !== null) {
        emittedFresh.add(`${m.family}:${m.name}`);
        lines.push(line);
      }
    }
    lines.push(r.line);
  });
  scopes.forEach((s, i) => {
    if (!usedScopes.has(i)) lines.push(scopeLineFor(s, ordinalById, kindOf));
  });
  sliders.forEach((s, i) => {
    if (!usedSliders.has(i)) lines.push(sliderLineFor(s, ordinalById));
  });
  for (const d of deferred) {
    lines[d.at] =
      d.kind === 'scope'
        ? scopeLineFor(scopes[d.slot], ordinalById, kindOf)
        : sliderLineFor(sliders[d.slot], ordinalById);
  }

  return lines.join('\n') + '\n';
}
