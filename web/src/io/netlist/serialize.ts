import { defFor } from '../../model/registry';
import type { CircuitElement, SimSettings } from '../../model/types';
import type { NetlistLine, ScopeConfig } from './types';
import { escapeToken } from './tokens';
import { isElementLine } from './parse';

/**
 * Rebuilds the `$` line rather than echoing the parsed one, so edits to the
 * settings are saved. The tokens this build does not model are written back
 * from `settings` when the file supplied them, and default to what a fresh
 * circuit has always written when it did not.
 */
function headerLine(settings: SimSettings): string {
  // Bits 1 (show current), 2 (small grid), 4 (voltage off), 8 (power on), 16
  // (show values), 64 (adaptive timestep) and 128 (DC operating point) are
  // modelled, so each is recomputed from its setting; every other loaded bit
  // is passed straight back. The two colour modes are mutually exclusive, so
  // at most one of bits 4 and 8 is set, the shape upstream's own writer
  // produces (dumpOptions).
  const flags =
    (settings.showCurrent ? 1 : 0) |
    (settings.smallGrid ? 2 : 0) |
    (settings.showVoltageColor ? 0 : 4) |
    (settings.showPowerColor ? 8 : 0) |
    (settings.showValues ? 0 : 16) |
    ((settings.headerFlags ?? 0) & ~(1 | 2 | 4 | 8 | 16 | 64 | 128)) |
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

/** One element line, or null for a kind this build cannot write. */
function elementLine(e: CircuitElement): string | null {
  const def = defFor(e.kind);
  if (!def) return null;
  const extra = (def.dump?.(e) ?? []).map((v) =>
    typeof v === 'string' && !def.rawTokens ? escapeToken(v) : String(v),
  );
  return [def.dumpCode, e.x1, e.y1, e.x2, e.y2, def.dumpFlags?.(e) ?? e.flags, ...extra].join(' ');
}

/**
 * One `o` line. The index token is recomputed from where the target element
 * ended up in the written file, so deleting an element ahead of a scope does
 * not silently repoint it. A scope whose target this build could not read
 * keeps the index the file gave it: nothing better is knowable, and the common
 * load-then-save case leaves it exactly right.
 */
function scopeLineFor(s: ScopeConfig, ordinalById: Map<number, number>): string {
  const index =
    s.elementId === undefined ? s.elementIndex : (ordinalById.get(s.elementId) ?? -1);
  return ['o', index, ...s.raw].join(' ');
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
): string {
  const header = headerLine(settings);
  const rendered: { id: number; line: string }[] = [];
  for (const e of elements) {
    const line = elementLine(e);
    if (line !== null) rendered.push({ id: e.id, line });
  }
  const ordinalById = new Map<number, number>();

  // An empty order is "no file was loaded", not "the file was empty", so it
  // takes the default layout rather than dropping the passthrough lines.
  if (!order || order.length === 0) {
    rendered.forEach((r, i) => ordinalById.set(r.id, i));
    const body = rendered.map((r) => r.line);
    const traces = scopes.map((s) => scopeLineFor(s, ordinalById));
    return [header, ...body, ...traces, ...passthrough].join('\n') + '\n';
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

  const lines: string[] = [];
  const usedElements = new Set<number>();
  const usedScopes = new Set<number>();
  // Scope lines are written last: their index token depends on where every
  // element landed, which is only known once the whole walk is done.
  const deferred: { at: number; slot: number }[] = [];
  let fileIndex = 0;
  let sawHeader = false;
  for (const entry of order) {
    if (entry.kind === 'header') {
      lines.push(header);
      sawHeader = true;
    } else if (entry.kind === 'other') {
      lines.push(entry.line);
      if (isElementLine(entry.line)) fileIndex += 1;
    } else if (entry.kind === 'element') {
      // A deleted element vacates its slot; the lines around it do not move.
      const slot = (slotById.get(entry.id) ?? []).find((i) => !usedElements.has(i));
      if (slot !== undefined) {
        usedElements.add(slot);
        ordinalById.set(entry.id, fileIndex++);
        lines.push(rendered[slot].line);
      }
    } else {
      const slot = scopeSlots.get(entry.id);
      if (slot !== undefined && !usedScopes.has(slot)) {
        usedScopes.add(slot);
        deferred.push({ at: lines.length, slot });
        lines.push('');
      }
    }
  }
  // A headerless file that holds a circuit still has to save its settings. One
  // that holds no elements is left exactly as it came in: that is the XML
  // `<cir>` form, which this build only passes through, and prefixing it with
  // a `$` line would stop upstream recognising it as XML at all
  // (CircuitLoader.java:73-80).
  if (!sawHeader && rendered.length + scopes.length > 0) {
    lines.unshift(header);
    for (const d of deferred) d.at += 1;
  }
  rendered.forEach((r, i) => {
    if (usedElements.has(i)) return;
    ordinalById.set(r.id, fileIndex++);
    lines.push(r.line);
  });
  scopes.forEach((s, i) => {
    if (!usedScopes.has(i)) lines.push(scopeLineFor(s, ordinalById));
  });
  for (const d of deferred) lines[d.at] = scopeLineFor(scopes[d.slot], ordinalById);

  return lines.join('\n') + '\n';
}
