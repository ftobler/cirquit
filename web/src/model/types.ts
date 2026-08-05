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
  /** Colour at zero volts. */
  neutral: string;
  /** Colour at the most positive displayed voltage. */
  positive: string;
  currentDot: string;
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
  /** Advances each animation frame; drives the current-flow animation. */
  dotPhase: number;
  showCurrent: boolean;
  showValues: boolean;
  showVoltageColor: boolean;
  selected: boolean;
  /** Full-scale voltage for the colour ramp. */
  voltageRange: number;
  /** Zoom factor, for keeping line weights and text readable. */
  scale: number;
}

/** Simulation and display settings that live outside any single element. */
export interface SimSettings {
  /** Seconds per solver timestep. */
  timeStep: number;
  /** Timesteps attempted per animation frame. */
  stepsPerFrame: number;
  /** Full-scale voltage for colouring. */
  voltageRange: number;
  /** Scales the current-dot animation speed. */
  currentSpeed: number;
  showCurrent: boolean;
  showValues: boolean;
  showVoltageColor: boolean;
  showGrid: boolean;
}

export const DEFAULT_SETTINGS: SimSettings = {
  timeStep: 5e-6,
  stepsPerFrame: 160,
  voltageRange: 5,
  currentSpeed: 50,
  showCurrent: true,
  showValues: true,
  showVoltageColor: true,
  showGrid: true,
};

/** Circuit-space units per grid square, matching the original. */
export const GRID_SIZE = 16;
