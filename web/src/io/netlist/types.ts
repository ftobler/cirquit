import type { ScopeValue } from '../../engine/simulator';
import type { CircuitElement, SimSettings } from '../../model/types';

/** One trace on a scope `o` line, exactly as the file wrote it. */
export interface ScopePlotConfig {
  /** Session-unique handle; the store Scope plot carries the same id, so the
   *  UI and engine key on it. */
  id: number;
  /**
   * The element index token exactly as the file wrote it: `e` for the first
   * plot, `ne` for every plot after it. A position in upstream's element list,
   * which counts the element lines this build cannot read. It is not an index
   * into `ParsedCircuit.elements`.
   */
  elementIndex: number;
  /** The store element id that index resolves to, or undefined when it lands
   *  on an element line this build could not read. */
  elementId?: number;
  /** The interpreted quantity, or null when the value token has no engine
   *  meaning for this element (a transistor's VAL_IB). A null plot is
   *  preserved through the raw line only and is never registered as a trace. */
  value: ScopeValue | null;
}

/** A scope trace as stored in the file. */
export interface ScopeConfig {
  /** Session-unique handle, so a save can put the line back where it was. */
  id: number;
  /**
   * The first plot's element index token, exactly as the file wrote it: a
   * position in upstream's element list, which counts the element lines this
   * build cannot read. It is not an index into `ParsedCircuit.elements`.
   */
  elementIndex: number;
  /** The element that index resolves to, or undefined when it lands on an
   *  element line this build could not read. */
  elementId?: number;
  /** Every token after the element index, kept so the line round-trips
   *  exactly. The display fields in here are not interpreted yet. */
  raw: string[];
  /** The traces the line carries: one for a plain scope, two for a
   *  voltage-plus-current line. Plot 0 is the line's `e` element. */
  plots: ScopePlotConfig[];
}

/**
 * One line of the file, in the order it appeared. Replaying this on save is
 * what keeps blank lines, comments and unmodelled lines where the author put
 * them instead of sweeping them to the end.
 *
 * Elements and scopes are referenced by id rather than by position, so a
 * deleted element simply vacates its slot and the rest of the file stays put.
 */
export type NetlistLine =
  | { kind: 'header' }
  | { kind: 'element'; id: number }
  | { kind: 'scope'; id: number }
  | { kind: 'other'; line: string };

export interface ParsedCircuit {
  elements: CircuitElement[];
  settings: Partial<SimSettings>;
  scopes: ScopeConfig[];
  /** Lines this build does not interpret, re-emitted on save. */
  passthrough: string[];
  /** Types present in the file that this build cannot draw or simulate. */
  unsupported: string[];
  /** Every line of the file, for a save that reproduces its arrangement. */
  order: NetlistLine[];
}
