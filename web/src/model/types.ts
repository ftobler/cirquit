/** Core data model. Geometry and presentation live here; the Rust engine only
 *  ever sees terminal coordinates and parameters. */

export interface Point {
  x: number;
  y: number;
}

/** One placed element. Coordinates are in circuit space, which is what the
 *  original file format stores, so they round-trip unchanged. */
export interface CircuitElement {
  id: number;
  /** Registry key, matching the Rust engine's element kind. */
  kind: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Bit flags carried straight through from the file format. */
  flags: number;
  params: Record<string, number>;
  /** Free text: node labels, annotations, slider captions. */
  text?: string;
  /** Named device-model reference, carried through from the file format. */
  modelName?: string;
  /** Interactive state, such as a switch position. */
  state?: number;
}

/** An editable property, surfaced in the options panel. */
export interface FieldDef {
  name: string;
  label: string;
  /** Unit suffix, formatted with engineering prefixes. */
  unit?: string;
  type?: 'number' | 'choice' | 'bool' | 'text';
  choices?: { value: number; label: string }[];
  min?: number;
  max?: number;
  /** Bit of `e.flags` this field toggles, rather than a `params` entry. Only
   *  meaningful for `bool`. A flag edit goes through `updateElement`, so the
   *  engine rebuilds: file flags are read at build time and can change the
   *  stamp or the node count, which the live `set_param` path cannot. */
  flag?: number;
  /** Reads `e.text` rather than `e.params[name]`. Only meaningful for `text`. */
  target?: 'param' | 'text';
}

/** Everything the app needs to know about an element type. */
export interface ElementDef {
  kind: string;
  /** Display name in the toolbox and options panel. */
  label: string;
  /** Toolbox grouping. */
  category: string;
  /**
   * Token used by the original file format. Single characters and numeric
   * codes both occur; it is stored as a string either way.
   */
  dumpCode: string;
  postCount: number;
  /** How many stored endpoints (`x1,y1`, `x2,y2`) the user can drag
   *  independently. Differs from `postCount` only for parts whose free end is
   *  a control point rather than a terminal: a ground hangs its symbol off
   *  `x2, y2`, which is not connectable. Defaults to `postCount`. */
  draggablePosts?: number;
  /** Terminal coordinates, in the order the engine expects them. */
  posts(e: CircuitElement): Point[];
  /** Reads the tokens that follow `flags` on a netlist line. */
  parse?(tokens: string[], e: CircuitElement): void;
  /** Writes the tokens that follow `flags` on a netlist line. */
  dump?(e: CircuitElement): (string | number)[];
  /** Replaces `e.flags` in the saved line, for formats whose token layout is
   *  conditional on a flag bit the parse already consumed (e.g. a diode's
   *  FLAG_MODEL). Absent means the element's own flags are written. */
  dumpFlags?(e: CircuitElement): number;
  /** This type's trailing tokens are raw on both sides: they are not run
   *  through `unescapeToken` on load nor `escapeToken` on save. Only the
   *  potentiometer needs it, whose slider text upstream joins from plain
   *  tokens without escaping (PotElm.java:58-62). */
  rawTokens?: boolean;
  draw(g: DrawContext, e: CircuitElement): void;
  fields?: FieldDef[];
  defaults?: Record<string, number>;
  /** Elements the engine cannot solve yet are drawn but flagged in the UI. */
  simulated?: boolean;
  /** Clicking the element in run mode toggles it (switches). */
  interactive?: boolean;
  /** Default length in grid units when dragged out from the toolbox. */
  defaultLength?: number;
  /** Elements upstream forces vertical on toolbar placement (ground, voltage). */
  vertical?: boolean;
  /** Elements whose placement drag snaps to the dominant axis, so a
   *  transistor, op-amp or SPDT can never be drawn diagonal. */
  noDiagonal?: boolean;
  /** File-format flags a freshly created element saves, matching the upstream
   *  constructor defaults (e.g. `FLAG_SHOW_VOLTAGE` on a new voltage source).
   *  Absent means 0. */
  defaultFlags?: number;
  /** Whether Mirror is offered. Default false: most bodies are symmetric, and
   *  a two-post part mirrored about its own centre is just a swap, which has
   *  its own command. Rotation needs no flag, being defined for every element
   *  with two or more posts. */
  canMirror?: boolean;
}

export interface Theme {
  background: string;
  grid: string;
  wire: string;
  text: string;
  selection: string;
  highlight: string;
  /** Colour at the most negative displayed voltage. */
  negative: string;
  /** A wire endpoint that would not connect (upstream's red bad-connection dot). */
  noConnect: string;
  /** Colour at zero volts. */
  neutral: string;
  /** Colour at the most positive displayed voltage. */
  positive: string;
  currentDot: string;
  /** Dot colour in electron-flow mode (conventional motion off). */
  currentDotElectron: string;
  panel: string;
  border: string;
}

/** Per-frame drawing state handed to each element's `draw`. */
export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  theme: Theme;
  /** Voltage at each terminal, indexed like `posts()`. */
  voltages: number[];
  /** Current through the element, in amps. */
  current: number;
  /** Voltage across the element. */
  voltage: number;
  /** Power dissipated by the element this frame, in watts: the terminal
   *  voltage times the element current, so positive reads dissipated and
   *  negative generated, the sign upstream's `getPower()` uses. */
  power: number;
  /** Instrument reading: a probe's selected meter mode, every other element's
   *  voltage difference, so the readout and a voltage scope agree. */
  value: number;
  /** Advances each animation frame; drives the current-flow animation. */
  dotPhase: number;
  showCurrent: boolean;
  showValues: boolean;
  showVoltageColor: boolean;
  /** Colour element bodies by power instead of voltage; mutually exclusive
   *  with `showVoltageColor` (Menus.java:190-197). */
  showPowerColor: boolean;
  /** Conventional-current motion; off reverses the dots and turns them cyan. */
  conventional: boolean;
  selected: boolean;
  /** The element under the pointer; colours its stroke and fill with
   *  `theme.highlight` like the shift-highlighted net below. */
  hovered: boolean;
  /** Any terminal sits on the shift-highlighted net (state.highlightedNode);
   *  colours with `theme.highlight` (CircuitElm.isOnHighlightedNet). */
  onHighlightedNet: boolean;
  /** Full-scale voltage for the colour ramp. */
  voltageRange: number;
  /** Power brightness (the file's token 6, upstream's powerBar): scales the
   *  power ramp via `powerMult = exp(powerRange/4.762 - 7)`. */
  powerRange: number;
  /** Zoom factor, for keeping line weights and text readable. */
  scale: number;
  /** Fraction digits for element value labels (upstream's short format). */
  valueDigits: number;
  /** Pixel size for value labels (upstream's valueFontSize, CircuitElm.java:53). */
  valueFontSize: number;
}

/** The five user-settable colours, the keys `makeTheme` overlays onto a theme.
 *  `null` means the theme's own default (upstream's localStorage colours,
 *  EditOptions.java:63-72). */
export type ThemeColors = Pick<
  SimSettings,
  'positiveColor' | 'negativeColor' | 'neutralColor' | 'selectionColor' | 'currentColor'
>;

/** Simulation and display settings that live outside any single element. */
export interface SimSettings {
  /** Seconds per solver timestep. */
  timeStep: number;
  /** Timesteps attempted per animation frame. */
  stepsPerFrame: number;
  /** Full-scale voltage for colouring. */
  voltageRange: number;
  /** Power brightness (header token 6, upstream's powerBar): scales the power
   *  ramp via `powerMult = exp(powerRange/4.762 - 7)`. */
  powerRange: number;
  /** Scales the current-dot animation speed. */
  currentSpeed: number;
  /** Floor for adaptive shrinking, seconds. */
  minTimeStep: number;
  /** Header speed token; preserved verbatim for round-trip fidelity. */
  iterCount: number;
  /** Header flag bit 64: adapt the timestep. */
  adaptiveTimeStep: boolean;
  /** Header flag bit 128: run a DC operating point before the first timestep
   *  and on every reset. Defaults off, matching upstream's `autoDCOnReset`
   *  (CircuitLoader.java:56): a fresh circuit keeps its charging transients
   *  and an LC tank its self-start seed, while a loaded file carries its own
   *  bit and still gets the pre-charging solve when set. */
  autoDC: boolean;
  showCurrent: boolean;
  showValues: boolean;
  showVoltageColor: boolean;
  /** Colour element bodies by dissipated power V*I instead of voltage.
   *  Mutually exclusive with `showVoltageColor`, mirroring upstream's menus
   *  (Menus.java:190-197). */
  showPowerColor: boolean;
  showGrid: boolean;
  /** Dot direction and colour; a per-frame render argument like `currentSpeed`. */
  conventional: boolean;
  /** Read-only gate, upstream's `noEditing` (UIManager.java:116). UI-only:
   *  not a header token, so it never bumps the engine revision. */
  editable: boolean;
  /** Header flag bit 2: 8-unit grid and snap instead of 16
   *  (UIManager.java:988-992). A circuit setting, so it lives in the file. */
  smallGrid: boolean;
  /** Drawn grid-snapped crosshair guide lines under the pointer. An app pref,
   *  stored like upstream's `crossHair` key (UIManager.java:219). */
  showCrosshair: boolean;
  /** Overrides for the five theme colours; null means the theme default. */
  positiveColor: string | null;
  negativeColor: string | null;
  neutralColor: string | null;
  selectionColor: string | null;
  currentColor: string | null;
  /** Pixel size for element value labels (CircuitElm.java:53). */
  valueFontSize: number;
  /** Fraction digits for element value labels (upstream `shortDecimalDigits`,
   *  CircuitElm.java:138-139). */
  shortDecimalDigits: number;
  /** Fraction digits for readouts (upstream `decimalDigits`, CircuitElm.java:
   *  138-139). */
  decimalDigits: number;
  /** Scales the per-notch wheel zoom (MouseManager.java:84); 1 is unchanged. */
  wheelSensitivity: number;

  // ─── Header fields carried through but not modelled ───
  // Loading a file must not invent new values for the `$` tokens this build
  // ignores, so they are parked here and written back unchanged. Undefined
  // means the file had no such token and the writer falls back to a default.
  /** Token 1 as loaded. Bits 1 (show current), 2 (small grid), 4 (volts off),
   *  8 (power on), 16 (show values), 64 (adaptive timestep) and 128 (DC
   *  operating point) are modelled; the rest are re-emitted so a save does not
   *  silently clear the user's settings. */
  headerFlags?: number;
}

/**
 * Cleared on every load: a `$` token this build does not model must not leak
 * into the next file. The header-modelled fields (`minTimeStep`, `iterCount`,
 * `adaptiveTimeStep`, `autoDC`, `powerRange`) are reset to their defaults in
 * the store instead, matching upstream's clear-on-load (CircuitLoader.java:50).
 */
export const UNMODELLED_HEADER: Partial<SimSettings> = {
  headerFlags: undefined,
};

export const DEFAULT_SETTINGS: SimSettings = {
  timeStep: 5e-6,
  stepsPerFrame: 160,
  voltageRange: 5,
  powerRange: 50,
  currentSpeed: 50,
  minTimeStep: 50e-12,
  iterCount: 10,
  adaptiveTimeStep: false,
  autoDC: false,
  showCurrent: true,
  showValues: true,
  showVoltageColor: true,
  showPowerColor: false,
  showGrid: true,
  conventional: true,
  editable: true,
  smallGrid: false,
  showCrosshair: false,
  positiveColor: null,
  negativeColor: null,
  neutralColor: null,
  selectionColor: null,
  currentColor: null,
  valueFontSize: 12,
  shortDecimalDigits: 1,
  decimalDigits: 3,
  wheelSensitivity: 1,
};

/** Circuit-space units per grid square, matching the original. */
export const GRID_SIZE = 16;
