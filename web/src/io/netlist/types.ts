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
 * A diode model loaded from a `34` line (`34 <escaped name> <flags>
 * <saturationCurrent> <seriesResistance> <emissionCoefficient>
 * <breakdownVoltage> [<forwardCurrent>]`, DiodeModel.dump,
 * DiodeModel.java:338-341). Keyed by the unescaped name; a repeated name
 * overwrites, matching upstream's single modelMap entry
 * (DiodeModel.java:53-59). Built-in models have no `34` line, so only
 * non-built-in names appear here.
 */
export interface DiodeModel {
  saturationCurrent: number;
  seriesResistance: number;
  emissionCoefficient: number;
  breakdownVoltage: number;
  /** Optional, read under a try upstream (DiodeModel.java:243-245). */
  forwardCurrent?: number;
}

/**
 * A transistor model loaded from a `32` line (`32 <escaped name> <flags>
 * <satCur> ... <betaR>`, TransistorModel.undump, TransistorModel.java:234-248).
 * Keyed by the unescaped name, like the diode models. The port's Ebers-Moll
 * consumes only satCur and betaR; the rest of the table (early voltage,
 * high-current roll-off, junction leakage) stays on the line but is not
 * resolved into params.
 */
export interface TransistorModel {
  saturationCurrent: number;
  betaReverse: number;
}

/**
 * A custom-logic model loaded from a `!` line (`! <escaped name> <flags>
 * <escaped inputs> <escaped outputs> <escaped infoText> <escaped rules>`,
 * CustomLogicModel.undump, CustomLogicModel.java:82-95). Keyed by the
 * unescaped name like the diode and transistor models. `inputs` and `outputs`
 * are comma-separated pin-name lists; `rules` is a series of `left=right`
 * pairs separated by newlines. The line itself stays in passthrough so a save
 * re-emits it in place; only its parameters are interpreted, into the library
 * the 208 resolution reads.
 */
export interface CustomLogicModel {
  /** The model name, the `!` line's first token. */
  name: string;
  /** The model's flag word, kept for round-tripping and future use
   *  (FLAG_SCHMITT is not ported). */
  flags: number;
  /** The input pin names, west side, in order. */
  inputs: string[];
  /** The output pin names, east side, in order. */
  outputs: string[];
  /** The tooltip/info line, currently display-only. */
  infoText: string;
  /** The raw rules string exactly as the `!` line carried it, preserved for a
   *  future model editor. */
  rules: string;
  /**
   * The rule table split into left and right strings by `parseRules`
   * (CustomLogicModel.java:185-245): each line lowercased, trimmed, split on
   * `=`, validated against the pin counts, and pattern letters de-duplicated
   * (a second occurrence of a letter becomes its uppercase compare form). This
   * is the form the engine evaluates, so the engine never re-parses rules.
   */
  rulesLeft: string[];
  rulesRight: string[];
  /** True when any right side contains a `_`, which needs the per-output
   *  internal-node resistor path (CustomLogicModel.java:240-241). */
  triState: boolean;
}

/** One external pin of a subcircuit model, the ext-list entry of a `.` line
 *  (ExtListEntry, CustomCompositeModel.java:18-25). The `node` is the pin's
 *  id in the model's own node numbering, which is what the composite's post
 *  order maps to. `pos` and `side` describe the pin's place on the chip
 *  symbol when the subcircuit is drawn (ChipElm.java:603-606: side 0 north,
 *  1 south, 2 west, 3 east). */
export interface SubcircuitPin {
  /** The pin's display name, the escaped ext token unescaped. */
  name: string;
  /** The model node id this pin exposes. */
  node: number;
  /** Position along the chip side, an index into the side's pin list. */
  pos: number;
  /** Chip side: 0 north, 1 south, 2 west, 3 east (ChipElm.java:603-606). */
  side: number;
}

/**
 * A subcircuit model parsed from a `.` line
 * (`. <escaped name> <flags> <sizeX> <sizeY> <extCount> <name node pos side>...
 * <escaped nodeList> <escaped elmDump>`, CustomCompositeModel.undump,
 * CustomCompositeModel.java:208-225). `nodeList` is the `\r`-separated child
 * model lines (`ClassName n1 n2 ...`) and `elmDump` the space-separated
 * escaped child dumps, exactly the two strings the composite element rebuilds
 * its children from (CompositeElm.loadComposite). The line rides through in
 * passthrough so a save re-emits it in place; only its parameters are
 * interpreted, into the library the Subcircuit Manager reads.
 */
export interface CompositeModel {
  /** The model's name, the `.` line's first token. */
  name: string;
  /** The model's flag word (FLAG_SHOW_LABEL = 1), kept for round-tripping. */
  flags: number;
  /** Chip symbol width in grid cells. */
  sizeX: number;
  /** Chip symbol height in grid cells. */
  sizeY: number;
  /** The external pins, in the order the composite's posts are numbered. */
  extList: SubcircuitPin[];
  /** The `\r`-separated child model lines, e.g. `ResistorElm 1 2\rResistorElm 2 3`. */
  nodeList: string;
  /** The space-separated escaped child dumps, one per child model line. */
  elmDump: string;
}

/**
 * A slider (`38` line, upstream's Adjustable) as stored in the file:
 * `38 <e> [F<flags>] <editItem> <minValue> <maxValue> [<sharedIndex>]
 * <sliderText> [<sliderStep>]` (Adjustable.java:47-76). Not an element, so it
 * takes no scope index; `e` is a position in the element list that counts the
 * element lines this build cannot read.
 */
export interface SliderConfig {
  /** Session-unique handle, so a save can put the line back where it was. */
  id: number;
  /** The element that `e` resolves to, or undefined when it lands on an
   *  element line this build could not read (or is out of range). Such a
   *  slider renders nothing but still round-trips. */
  elementId?: number;
  /** Index into the element's edit list, kept for the resolution fallback. */
  editItem: number;
  min: number;
  max: number;
  /** Optional trailing token; 0 means continuous (Adjustable.java:70-72). */
  step: number;
  /** The caption, one escaped token, unescaped on load. */
  text: string;
  /** FLAG_LOG (bit 2): use a logarithmic value/position conversion. */
  logarithmic: boolean;
  /** The `ano` token under FLAG_SHARED (bit 1): an index into the file's
   *  sliders of the one this shares, `-1` meaning none, or null when the line
   *  carries no shared index at all. Shared sliders render independently for
   *  now. */
  shared: number | null;
  /** Every token after `38`, kept so the line round-trips exactly. Only the
   *  `e` token is rewritten, from where the element lands in the file. */
  raw: string[];
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
  | { kind: 'slider'; id: number }
  | { kind: 'other'; line: string };

export interface ParsedCircuit {
  elements: CircuitElement[];
  settings: Partial<SimSettings>;
  scopes: ScopeConfig[];
  /** Sliders (`38` lines) parsed into bindable state. */
  sliders: SliderConfig[];
  /** Lines this build does not interpret, re-emitted on save. */
  passthrough: string[];
  /** The subcircuit models this file's `.` lines define, in file order. The
   *  lines themselves still ride in passthrough; this is the interpreted copy.
   *  Handing them back rather than registering them keeps `parseCircuit` pure:
   *  only a caller that commits the text (a load, a paste) puts them in the
   *  library. */
  compositeModels: CompositeModel[];
  /** Types present in the file that this build cannot draw or simulate. */
  unsupported: string[];
  /** Every line of the file, for a save that reproduces its arrangement. */
  order: NetlistLine[];
}
