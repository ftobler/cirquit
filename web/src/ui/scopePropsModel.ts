/**
 * What the scope properties dialog shows, kept out of the component so it is
 * testable without a DOM (AGENTS.md): the section list, one row per channel,
 * the parsing of its text fields, and which target the Readouts section edits.
 * ScopeProperties.tsx only lays these out and wires the store actions.
 */

import type { Scope, ScopePlot, ScopeValue } from '../engine/scopeModel';
import { plotOverridesScope } from '../engine/scopeModel';
import { UNIT } from '../scope/units';
import { canRemovePlot } from './scopePlotRows';
import { parseUnits } from '../model/units';

/** The dialog's sections, in rail order. Each groups the controls a user
 *  reaches for together, instead of one long page of fieldsets. */
export const SCOPE_PROPS_SECTIONS = [
  { id: 'traces', label: 'Traces' },
  { id: 'vertical', label: 'Vertical' },
  { id: 'timebase', label: 'Timebase' },
  { id: 'readouts', label: 'Readouts' },
  { id: 'display', label: 'Display' },
] as const;

export type ScopePropsSection = (typeof SCOPE_PROPS_SECTIONS)[number]['id'];

/** The short letter a channel chip carries for its quantity. */
export function channelLetter(value: ScopeValue | null): string {
  switch (value) {
    case null:
      return '?';
    case 'voltage':
      return 'V';
    case 'current':
      return 'I';
    case 'power':
      return 'P';
    case 'charge':
      return 'Q';
    case 'resistance':
      return 'R';
    default:
      // The transistor pin plots read as their own names: Ib, Vce, ...
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

export interface ChannelRow {
  plot: ScopePlot;
  /** "CH 1", numbered in drawing order like the trace colours. */
  name: string;
  letter: string;
  /** The unit the channel's scale and readouts are in. */
  unit: string;
  /** The element the channel probes, by its palette label. */
  source: string;
  color: string;
  /** AC coupling is a DC-blocking filter on voltage samples only. */
  acAllowed: boolean;
  /** Removing is refused for the last plot and for raw-only plots. */
  removable: boolean;
  /** The channel carries its own readout mask that differs from the scope's. */
  overrides: boolean;
}

/**
 * One row per channel the canvas draws, in the same order, so the numbering
 * and the colour dots match the trace. `labelOf` names a plot's element (null
 * when it never resolved); `colorOf` is the frame's trace colour map.
 */
export function channelRows(
  scope: Scope,
  visible: ScopePlot[],
  labelOf: (elementId: number | null) => string | null,
  colorOf: (plotId: number) => string | undefined,
  fallbackColor: string,
): ChannelRow[] {
  return visible.map((plot, i) => ({
    plot,
    name: `CH ${i + 1}`,
    letter: channelLetter(plot.value),
    unit: plot.value === null ? '?' : UNIT[plot.value],
    source: labelOf(plot.elementId) ?? 'missing element',
    color: colorOf(plot.id) ?? fallbackColor,
    acAllowed: plot.value === 'voltage',
    removable: canRemovePlot(scope.plots, plot.id),
    overrides: plotOverridesScope(scope, plot),
  }));
}

/** The dialog's title: the scope's own label, or the "Scope N" name the
 *  element context menu and the stack tabs use. */
export function scopeDisplayName(scopes: Scope[], scope: Scope): string {
  const label = scope.label.trim();
  return label !== '' ? label : `Scope ${scopes.indexOf(scope) + 1}`;
}

/** A value as typed into one of the dialog's fields: any finite number, with
 *  the edit dialog's suffixes and shorthand ("10m", "2k2", "5e-3"). Null for
 *  anything else, which leaves the setting unchanged. */
export function parseValue(text: string): number | null {
  if (text.trim() === '') return null;
  const v = parseUnits(text);
  return Number.isFinite(v) ? v : null;
}

/** Most manual divisions the grid can still draw legibly. */
export const MAX_DIVISIONS = 40;

/** A divisions count as typed: a whole number in 1..MAX_DIVISIONS, or null
 *  for anything else, which leaves the scope unchanged. */
export function parseDivisions(text: string): number | null {
  const v = parseValue(text);
  if (v === null) return null;
  const n = Math.round(v);
  return n >= 1 && n <= MAX_DIVISIONS ? n : null;
}

/** A manual scale per division as typed: strictly positive, or null. */
export function parseManScale(text: string): number | null {
  const v = parseValue(text);
  return v !== null && v > 0 ? v : null;
}

/** Which readout word the Readouts section edits: every trace (the scope
 *  word they inherit) or one channel's own mask. */
export type ReadoutTarget = 'all' | number;

/**
 * Where the Readouts section starts: on the first channel that carries its
 * own mask, so a reopened dialog shows what is actually overridden rather
 * than the scope word hiding it; on all traces otherwise, and always for a
 * single-channel scope, which has nothing to tell apart.
 */
export function initialReadoutTarget(scope: Scope, visible: ScopePlot[]): ReadoutTarget {
  if (visible.length < 2) return 'all';
  const first = visible.find((p) => plotOverridesScope(scope, p));
  return first ? first.id : 'all';
}

/** The target actually in force: a channel target that no longer names a
 *  visible channel (removed, hidden) falls back to all traces. */
export function effectiveReadoutTarget(target: ReadoutTarget, visible: ScopePlot[]): ReadoutTarget {
  if (target === 'all' || visible.length < 2) return 'all';
  return visible.some((p) => p.id === target) ? target : 'all';
}

/** How much of the dialog must stay on screen sideways, and of its header
 *  downwards, so it can always be dragged back. */
const KEEP_W = 120;
const KEEP_H = 40;

/**
 * The dialog's offset from its centred home after a header drag of (dx, dy).
 * `start` is the offset when the drag began and `rect` the dialog's screen
 * box at that moment; the result keeps the header inside the viewport and a
 * grabbable slice of the dialog on screen sideways.
 */
export function clampDialogOffset(
  start: { x: number; y: number },
  rect: { left: number; top: number; width: number },
  dx: number,
  dy: number,
  view: { w: number; h: number },
): { x: number; y: number } {
  const left = Math.min(Math.max(rect.left + dx, KEEP_W - rect.width), view.w - KEEP_W);
  const top = Math.min(Math.max(rect.top + dy, 0), view.h - KEEP_H);
  return { x: start.x + (left - rect.left), y: start.y + (top - rect.top) };
}

/** Whether a field's draft should be written to the store: it changed and
 *  it parses. A refused draft is kept on screen (marked invalid) until the
 *  field loses focus, then the stored value comes back. */
export function shouldCommit(draft: string, value: string, parse: (t: string) => unknown): boolean {
  return draft !== value && parse(draft) !== null;
}

/**
 * Where arrow keys move inside a segmented group: the next enabled option in
 * `dir` (+1 right, -1 left), wrapping, or `from` when nothing else is
 * enabled. Radio semantics: moving also selects.
 */
export function nextEnabledIndex(disabled: readonly boolean[], from: number, dir: 1 | -1): number {
  const n = disabled.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (!disabled[i]) return i;
  }
  return from;
}
