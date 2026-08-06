/**
 * The element registry.
 *
 * Each entry owns everything the TypeScript side knows about a type: where its
 * terminals are, how it is drawn, which properties are editable, and how it
 * maps to the original file format. The Rust engine holds the matching
 * simulation model, keyed by the same `kind` string.
 *
 * To add an element: write the model in `engine/core/src/elements`, register
 * its kind there, then add a definition here.
 */

import {
  arrowHead,
  bodyRect,
  calcLeads,
  canvasFont,
  circle,
  COIL_LOOPS,
  coilPoints,
  currentDots,
  dsign,
  drawLeads,
  elementLength,
  endpoints,
  formatValue,
  interp,
  interp2,
  label,
  line,
  polyline,
  triangle,
  voltageColor,
} from '../render/draw';
import type { CircuitElement, DrawContext, ElementDef, Point } from './types';
import { GRID_SIZE } from './types';

/** Perpendicular offset of switch throws and transistor collector/emitter. */
const OPEN_HS = 16;
/**
 * File-format flag bit shared by the asymmetric parts: for the op-amp it swaps
 * the two input leads ("Swap Inputs" upstream), for the transistor it swaps
 * which side of the base-to-output axis the collector and emitter hang off
 * ("Swap E/C" upstream). Same bit, meaning per type. transform.ts flips it on
 * rotate/mirror.
 */
export const FLAG_SWAP = 1;
const OPAMP_SWAP = FLAG_SWAP;   // OpAmpElm.java:28
const OPAMP_SMALL = 2;          // OpAmpElm.java:29
const OPAMP_GAIN = 8;           // OpAmpElm.java:31
const TRANSISTOR_FLIP = FLAG_SWAP; // TransistorElm.java:44
const POT_SHOW_VALUES = 1;      // PotElm.java:32
const POT_FLIP = 2;             // PotElm.java:33
const POT_FLIP_OFFSET = 4;      // PotElm.java:34
const SWITCH2_CENTER_OFF = 1;   // Switch2Elm.java:30
const SWITCH_LABEL = 4;         // SwitchElm.java:33, inherited by Switch2Elm
const VOLTAGE_SHOW_VOLTAGE = 16; // VoltageElm.java:32
const PROBE_SHOW_VOLTAGE = 1;   // ProbeElm.java:30
const PROBE_CIRCLE = 2;         // ProbeElm.java:31
const CAP_BACK_EULER = 2;       // CapacitorElm.java:32
const IND_BACK_EULER = 2;       // Inductor.java:23, same bit as the capacitor's flag
const CAP_RESISTANCE = 4;       // CapacitorElm.java:33
/** Marks free text as one escaped token rather than the old space-joined
 *  form. Same bit and same meaning on both text-bearing types
 *  (TextElm.java:38, LabeledNodeElm.java:30); their writers always set it. */
const FLAG_ESCAPE = 4;

const twoPosts = (e: CircuitElement): Point[] => [
  { x: e.x1, y: e.y1 },
  { x: e.x2, y: e.y2 },
];

const onePost = (e: CircuitElement): Point[] => [{ x: e.x1, y: e.y1 }];

/** Reads numeric tokens into named params, skipping absent ones. */
function readParams(tokens: string[], e: CircuitElement, names: string[]): void {
  names.forEach((name, i) => {
    const v = Number(tokens[i]);
    if (tokens[i] !== undefined && Number.isFinite(v)) e.params[name] = v;
  });
}

const writeParams =
  (names: string[]) =>
  (e: CircuitElement): (string | number)[] =>
    names.map((n) => e.params[n] ?? 0);

/**
 * The leading tokens both capacitor types share (CapacitorElm.java:43-52):
 * `capacitance` and `voltDiff` always, then `initialVoltage`, which is
 * optional and falls back to the 1e-3 default. Always three token slots, so
 * the callers below know where the series resistance would start.
 */
function capacitorHead(tokens: string[], e: CircuitElement): number {
  readParams(tokens, e, ['capacitance', 'voltDiff', 'initialVoltage']);
  return 3;
}

/**
 * A plain `c` line, whose fourth token can only ever be the series
 * resistance, so it is read whether or not FLAG_RESISTANCE is set.
 *
 * Upstream reads it only under the flag (CapacitorElm.java:59-60), but the
 * flag is there to keep the stream position unambiguous for `PolarCapacitorElm`,
 * which reads more state after it; nothing follows on a plain `c`. Honouring
 * the flag here would silently drop a real value: `cappar.txt` carries
 * `c 192 192 192 288 0 2e-4 0.925 0.001 0.1` with the bit clear, and that 0.1
 * is not noise. It is what upstream's own `validate()` wrote back
 * (CapacitorElm.java:274-291) after finding the ideal-capacitor loop that
 * capacitor sits in, and the next save would overwrite it with a zero.
 */
const capacitorParse = (tokens: string[], e: CircuitElement): void => {
  const n = capacitorHead(tokens, e);
  readParams(tokens.slice(n), e, ['seriesResistance']);
};

/**
 * A `209` line, where the flag genuinely disambiguates: `PolarCapacitorElm`
 * reads `maxNegativeVoltage` off the same token stream its superclass left
 * (PolarCapacitorElm.java:13-17), so without FLAG_RESISTANCE the rating is the
 * fourth token, not the fifth.
 */
const polarCapacitorParse = (tokens: string[], e: CircuitElement): void => {
  let n = capacitorHead(tokens, e);
  if ((e.flags & CAP_RESISTANCE) !== 0) {
    readParams(tokens.slice(n), e, ['seriesResistance']);
    n += 1;
  }
  readParams(tokens.slice(n), e, ['maxNegativeVoltage']);
};

/** Upstream's `dump()` sets FLAG_RESISTANCE unconditionally and always writes
 *  the ESR token (CapacitorElm.java:69-72), which is what tells the reader the
 *  token is there at all. Both capacitor types share the writer. */
const capacitorFlags = (e: CircuitElement): number => e.flags | CAP_RESISTANCE;

/** The SPST tokens, which the SPDT writes first and then extends. The label
 *  only appears when there is one, matching the flag `labelFlags` writes. */
function switchTokens(e: CircuitElement): (string | number)[] {
  const tokens: (string | number)[] = [
    e.state ?? e.params.position ?? 0,
    (e.params.momentary ?? 0) !== 0 ? 'true' : 'false',
  ];
  if (e.text) tokens.push(e.text);
  return tokens;
}

/** Clearing FLAG_LABEL when the label goes empty keeps the token count and the
 *  flag in step, as upstream's editor does (SwitchElm.java:258-265). */
function labelFlags(e: CircuitElement): number {
  return e.text ? e.flags | SWITCH_LABEL : e.flags & ~SWITCH_LABEL;
}

/** Text and labeled nodes always save the new-style single escaped token. */
function escapeFlags(e: CircuitElement): number {
  return e.flags | FLAG_ESCAPE;  // TextElm.java:83, LabeledNodeElm.java:52
}

// ---------------------------------------------------------------------------
// Symbol drawing
// ---------------------------------------------------------------------------

function drawResistorBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  drawLeads(g, e, lead1, lead2);
  const color = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  bodyRect(g, lead1, lead2, 6, color);  // IEC rectangle, 32 x 12 as upstream
  currentDots(g, lead1, lead2, g.current);
  label(g, e, formatValue(e.params.resistance ?? 0, 'Ω'));
}

function drawCapacitorBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 6);
  drawLeads(g, e, lead1, lead2);
  const [a1, a2] = interp2(lead1, lead2, 0, 9);
  const [b1, b2] = interp2(lead1, lead2, 1, 9);
  line(g, a1, a2, voltageColor(g, g.voltages[0]), 2.5);
  line(g, b1, b2, voltageColor(g, g.voltages[1]), 2.5);
  label(g, e, formatValue(e.params.capacitance ?? 0, 'F'));
}

/** The plain capacitor plus the polarity marker PolarCapacitorElm draws next
 *  to its first plate (PolarCapacitorElm.java:36-49). */
function drawPolarCapacitorBody(g: DrawContext, e: CircuitElement): void {
  drawCapacitorBody(g, e);
  const [p1, p2] = endpoints(e);
  // f = (dn/2-4)/dn - 8/dn = 0.5 - 12/dn: a constant 12px offset from the
  // segment midpoint toward point1, independent of length `dn`
  // (PolarCapacitorElm.java:38,47).
  const dn = elementLength(e);
  const f = dn === 0 ? 0.5 : 0.5 - 12 / dn;
  const plus = interp(p1, p2, f, -10 * dsign(p1, p2));
  // Upstream's pixel-snap nudge for near-vertical/diagonal segments
  // (PolarCapacitorElm.java:48-51).
  if (p2.y > p1.y) plus.y += 4;
  if (p1.y > p2.y) plus.y += 3;
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(11);
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText('+', plus.x, plus.y);
}

/** Body length upstream's `setPoints` uses for the default (non-IEC) symbol
 *  (FuseElm.java:76-80). The IEC-symbol variant isn't wired up here (see
 *  `drawFuseBody`), so this is the only length used. */
const FUSE_BODY_LENGTH = 16;

/**
 * A wavy "melting wire" while intact, matching upstream's un-blown,
 * non-IEC-symbol draw path: 16 segments of a sine wave across the body
 * (FuseElm.java:107-140). Upstream also tints the body by accumulated heat
 * (`getTempColor`); that needs the engine to report heat back per frame,
 * which nothing else here does yet (only voltages and currents round-trip),
 * so this uses the same voltage colouring every other two-terminal body
 * does instead. A blown fuse draws no body at all, just the leads — the open
 * gap upstream leaves behind.
 */
function drawFuseBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, FUSE_BODY_LENGTH);
  drawLeads(g, e, lead1, lead2);
  if ((e.params.blown ?? 0) === 0) {
    const segments = 16;
    const color = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
    const pts: Point[] = [];
    for (let i = 0; i <= segments; i++) {
      pts.push(interp(lead1, lead2, i / segments, 6 * Math.sin((i * Math.PI * 2) / segments)));
    }
    polyline(g, pts, color, 3);
  }
  currentDots(g, lead1, lead2, g.current);
}

/** Lead gap, filament diagonal offset and bulb radius for the non-IEC lamp
 *  symbol (LampElm.java's `setPoints`: `llen` at :88, `filament_len` at :85,
 *  `bulbR` at :92). */
const LAMP_LEAD_GAP = 16;
const LAMP_FILAMENT_OFFSET = 24;
const LAMP_BULB_RADIUS = 20;

/**
 * Two lead-to-filament diagonals crossing inside a circular bulb outline
 * (LampElm.java:123-155). Upstream tints the bulb fill by filament
 * temperature (`getTempColor`, keyed off the same `temp` state
 * `startIteration` evolves); the engine doesn't report that state back per
 * frame — only voltages and currents round-trip — which is the same gap
 * `drawFuseBody` above works around for accumulated heat, so this uses the
 * same voltage colouring every other two-terminal body does instead.
 */
function drawLampBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, LAMP_LEAD_GAP);
  drawLeads(g, e, lead1, lead2);
  const filament0 = interp(lead1, lead2, 0, LAMP_FILAMENT_OFFSET);
  const filament1 = interp(lead1, lead2, 1, LAMP_FILAMENT_OFFSET);
  const bulb = interp(filament0, filament1, 0.5);
  const midColor = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  circle(g, bulb, LAMP_BULB_RADIUS, midColor, true);
  circle(g, bulb, LAMP_BULB_RADIUS, g.theme.wire, false, 2);
  line(g, lead1, filament0, voltageColor(g, g.voltages[0]), 3);
  line(g, lead2, filament1, voltageColor(g, g.voltages[1]), 3);
  line(g, filament0, filament1, midColor, 3);
  currentDots(g, lead1, filament0, g.current);
  currentDots(g, filament0, filament1, g.current);
  currentDots(g, filament1, lead2, g.current);
}

/** Half-height of the thermistor's resistor box, same as the plain resistor
 *  (ThermistorNTCElm.java:134's `hs`). */
const THERMISTOR_HS = 6;

/** `calcB25100`/`temprFromSliderPos`/`calcResistance`
 *  (ThermistorNTCElm.java:247-262), ported so the drawn label matches the
 *  same formula the engine stamps with rather than a hand-rounded guess. No
 *  engine state round-trips for this — unlike Fuse's heat or Lamp's
 *  temperature, there is none: resistance here is a pure function of the
 *  editable fields, so recomputing it in TypeScript for the label is exact,
 *  not an approximation. */
function thermistorTemperature(e: CircuitElement): number {
  const min = e.params.minTempr ?? -40;
  const max = e.params.maxTempr ?? 150;
  const position = e.params.position ?? 0.34;
  return Math.round(position * (max - min) + min);
}

function thermistorResistance(e: CircuitElement): number {
  const r25 = e.params.r25 ?? 10000;
  const r50 = e.params.r50 ?? 3605;
  const t0 = 273.15;
  const b25100 = (Math.log(r25) - Math.log(r50)) / (1 / (t0 + 25) - 1 / (t0 + 50));
  const temp = thermistorTemperature(e);
  return Math.round(r25 * Math.exp(b25100 * (1 / (temp + t0) - 1 / (t0 + 25))));
}

/**
 * A resistor box (this port's IEC-only convention, same as `drawResistorBody`
 * and `drawPotBody`) plus the diagonal accent line upstream adds to mark it
 * temperature-sensitive, drawn in the same voltage-gradient stroke and 3px
 * width as the box outline (ThermistorNTCElm.java:130-169). Upstream's local
 * coordinates run from `0` at `lead1` to `len` at `lead2` along the axis and
 * `hs` perpendicular to it; `interp`'s fraction/offset pair is that same local
 * frame, except `interp`'s `+g` is upstream's `-hs` (this port's perpendicular
 * unit vector is the negation of upstream's), so the offsets below are negated
 * relative to upstream's literal `moveTo`/`lineTo` triple to land on the same
 * pixels.
 */
function drawThermistorBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  drawLeads(g, e, lead1, lead2);
  const color = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  bodyRect(g, lead1, lead2, THERMISTOR_HS, color);
  const len = Math.hypot(lead2.x - lead1.x, lead2.y - lead1.y);
  if (len > 0) {
    const hs = THERMISTOR_HS;
    const accent = [
      interp(lead1, lead2, -hs / len, -hs * 2),
      interp(lead1, lead2, hs / len, -hs * 2),
      interp(lead1, lead2, 1, hs * 2),
    ];
    polyline(g, accent, color, 3);
  }
  currentDots(g, lead1, lead2, g.current);
  label(g, e, `${thermistorTemperature(e)}°C = ${formatValue(thermistorResistance(e), 'Ω')}`);
}

/** Half-height of the LDR's resistor box, same as the plain resistor and
 *  thermistor (LDRElm.java:106's `hs`). */
const LDR_HS = 6;

/** `LuxFromSliderPos()`/`calcResistance()` (LDRElm.java:219-222, :206-218),
 *  ported so the drawn label matches the same formula the engine stamps
 *  with rather than a hand-rounded guess. Like the thermistor, resistance
 *  here is a pure function of the editable `position` field alone (`minLux`
 *  and `maxLux` are upstream constants, never edited or saved), so
 *  recomputing it in TypeScript for the label is exact, not an
 *  approximation. */
function ldrResistance(e: CircuitElement): number {
  const position = e.params.position ?? 0.34;
  const minLux = 0.1;
  const maxLux = 10000;
  const lux = maxLux * position + minLux;
  return Math.round((maxLux - lux + 1) * 10);
}

/**
 * A resistor box (this port's IEC-only convention, same as `drawResistorBody`
 * and `drawThermistorBody`) plus the two arrow-and-arrowhead accents upstream
 * draws to mark it light-sensitive (LDRElm.java:134-147), in the same
 * voltage-gradient stroke and 3px width as `drawThermistorBody`'s accent.
 * Upstream's local coordinates run from `0` at `lead1` along the axis, in
 * pixels rather than a fraction of `len`, and a perpendicular pixel offset
 * from the axis; `interp`'s fraction/offset pair uses that same local frame
 * with the fraction argument as `x/len`, except its `+g` is upstream's `-y`
 * (this port's perpendicular unit vector is the negation of upstream's, the
 * same sign flip `drawThermistorBody` above documents) — verified against a
 * concrete horizontal lead1=(0,0)/lead2=(100,0) example: upstream's local
 * (8,12) is 8px right of lead1 and 12px below it (canvas y grows downward),
 * and `interp(lead1, lead2, 8/100, -12)` lands on that same (8,12).
 */
function drawLdrBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  drawLeads(g, e, lead1, lead2);
  const color = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  bodyRect(g, lead1, lead2, LDR_HS, color);
  const len = Math.hypot(lead2.x - lead1.x, lead2.y - lead1.y);
  if (len > 0) {
    const pt = (x: number, y: number): Point => interp(lead1, lead2, x / len, -y);
    polyline(g, [pt(-8, 26), pt(8, 12)], color, 3);
    polyline(g, [pt(2, 12), pt(8, 12), pt(8, 18)], color, 3);
    polyline(g, [pt(12, 26), pt(26, 12)], color, 3);
    polyline(g, [pt(20, 12), pt(26, 12), pt(26, 18)], color, 3);
  }
  currentDots(g, lead1, lead2, g.current);
  label(g, e, formatValue(ldrResistance(e), 'Ω'));
}

function drawInductorBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  drawLeads(g, e, lead1, lead2);
  const color = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  polyline(g, coilPoints(lead1, lead2, COIL_LOOPS), color);
  currentDots(g, lead1, lead2, g.current);
  label(g, e, formatValue(e.params.inductance ?? 0, 'H'));
}

function drawSourceCircle(g: DrawContext, e: CircuitElement, radius: number): [Point, Point] {
  const [lead1, lead2] = calcLeads(e, radius * 2);
  drawLeads(g, e, lead1, lead2);
  const mid = interp(lead1, lead2, 0.5);
  circle(g, mid, radius, voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2));
  return [lead1, lead2];
}

/** Waveform glyph inside a source symbol. */
function drawWaveformGlyph(g: DrawContext, centre: Point, waveform: number, r: number): void {
  const color = g.theme.text;
  if (waveform === 0) {
    // DC: a plus toward the positive terminal and a minus toward the other.
    g.ctx.fillStyle = color;
    g.ctx.font = canvasFont(11);
    g.ctx.textAlign = 'center';
    g.ctx.textBaseline = 'middle';
    g.ctx.fillText('+', centre.x, centre.y - r * 0.45);
    g.ctx.fillText('−', centre.x, centre.y + r * 0.45);
    return;
  }
  const pts: Point[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const x = centre.x - r * 0.6 + f * r * 1.2;
    let s: number;
    switch (waveform) {
      case 2: // square
        s = f < 0.5 ? 1 : -1;
        break;
      case 3: // triangle
        s = f < 0.5 ? -1 + 4 * f : 3 - 4 * f;
        break;
      case 4: // sawtooth
        s = 2 * f - 1;
        break;
      case 5: // pulse
        s = f < 0.5 ? 1 : 0;
        break;
      default: // sine
        s = Math.sin(f * Math.PI * 2);
    }
    pts.push({ x, y: centre.y - s * r * 0.4 });
  }
  g.ctx.strokeStyle = color;
  g.ctx.lineWidth = 1.2;
  g.ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? g.ctx.moveTo(p.x, p.y) : g.ctx.lineTo(p.x, p.y)));
  g.ctx.stroke();
}

function drawDiodeBody(g: DrawContext, e: CircuitElement, zener: boolean): void {
  const [lead1, lead2] = calcLeads(e, 16);
  drawLeads(g, e, lead1, lead2);
  const color = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  const [t1, t2] = interp2(lead1, lead2, 0, 7);
  triangle(g, t1, t2, lead2, color);
  const [b1, b2] = interp2(lead1, lead2, 1, 7);
  if (zener) {
    // Cathode bar with the characteristic swept ends.
    polyline(
      g,
      [interp(lead1, lead2, 1, 7), b1, b2, interp(lead1, lead2, 1.35, -7)],
      color,
      2,
    );
    const [z1, z2] = interp2(lead1, lead2, 1, 7);
    line(g, interp(lead1, lead2, -0.35, 7), z1, color, 2);
    void z2;
  } else {
    line(g, b1, b2, color, 2.5);
  }
  currentDots(g, lead1, lead2, g.current);
}

/**
 * The diode body plus a second capacitor plate: a thick bar just short of
 * the cathode bar, coloured by the anode's voltage. Upstream draws its own
 * cathode bar a second time at the same spot as `plate2`
 * (VaractorElm.java:57-68/78-90); that duplicate is skipped here since it
 * paints nothing a plain diode body has not already drawn.
 */
function drawVaractorBody(g: DrawContext, e: CircuitElement): void {
  drawDiodeBody(g, e, false);
  const [lead1, lead2] = calcLeads(e, 16);
  const [p1, p2] = interp2(lead1, lead2, 0.6, 7);
  line(g, p1, p2, voltageColor(g, g.voltages[0]), 2.5);
}

function drawGroundSymbol(g: DrawContext, e: CircuitElement): void {
  const p = { x: e.x1, y: e.y1 };
  const color = voltageColor(g, 0);
  line(g, p, { x: p.x, y: p.y + 6 }, color);
  for (let i = 0; i < 3; i++) {
    const w = 10 - i * 3;
    const y = p.y + 6 + i * 4;
    line(g, { x: p.x - w, y }, { x: p.x + w, y }, color, 2);
  }
}

/**
 * Free end of a switch lever: at the contact when closed, lifted when open.
 *
 * The lever pivots at lead1; open, it lifts away from the contact. Positive
 * perpendicular is up on screen (canvas y grows downward), matching upstream
 * and the SPDT throw offsets.
 */
export function switchLeverTip(lead1: Point, lead2: Point, closed: boolean): Point {
  return closed ? lead2 : interp(lead1, lead2, 1, OPEN_HS);
}

function drawSwitchBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  drawLeads(g, e, lead1, lead2);
  const closed = (e.state ?? e.params.position ?? 0) === 0;
  // The lever is always at the pivot's potential; it is connected to lead1
  // whether it is closed or not.
  const color = voltageColor(g, g.voltages[0]);
  circle(g, lead1, 2.5, color, true, 1);
  circle(g, lead2, 2.5, voltageColor(g, g.voltages[1]), true, 1);
  const tip = switchLeverTip(lead1, lead2, closed);
  line(g, lead1, tip, color);
  if (closed) currentDots(g, lead1, lead2, g.current);
}

function drawOpAmpBody(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = opAmpBodyLeads(e);
  const posts = opAmpPosts(e);
  const hs = opampInputSign(e, p1, p2);

  // Input leads run from the posts to the triangle base, so they never cross a
  // swapped body: the anchors carry the same flag-derived side as the posts.
  line(g, posts[0], interp(lead1, lead2, 0, hs), voltageColor(g, g.voltages[0]));
  line(g, posts[1], interp(lead1, lead2, 0, -hs), voltageColor(g, g.voltages[1]));
  line(g, lead2, p2, voltageColor(g, g.voltages[2]));

  const [t1, t2] = interp2(lead1, lead2, 0, hs * 2);
  triangle(g, t1, t2, lead2, g.theme.panel);
  polyline(g, [t1, t2, lead2, t1], g.theme.wire, 2);

  // The minus glyph sits on the inverting input, the plus on the other.
  const minus = interp(lead1, lead2, 0.28, hs);
  const plus = interp(lead1, lead2, 0.28, -hs);
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(opampSize(e) === 2 ? 14 : 10);  // OpAmpElm.java:139
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText('−', minus.x, minus.y);
  g.ctx.fillText('+', plus.x, plus.y);
  currentDots(g, lead2, p2, g.current);
}

function drawTransistorBody(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const posts = transistorPosts(e);
  const pnp = (e.params.pnp ?? 1) === -1;
  const baseColor = voltageColor(g, g.voltages[0]);

  // Base lead up to the vertical bar.
  const barCentre = interp(p1, p2, 0.72);
  line(g, p1, barCentre, baseColor);
  // The bar straddles the axis; the sign only picks which endpoint is which.
  const [barTop, barBottom] = interp2(p1, p2, 0.72, OPEN_HS * 0.6);
  line(g, barTop, barBottom, baseColor, 3);

  // Collector and emitter leads leave the bar on their posts' side, so a
  // flipped or mirrored body's leads do not cross over the symbol.
  const [c1, e1] = transistorBarContacts(e);
  line(g, c1, posts[1], voltageColor(g, g.voltages[1]));
  line(g, e1, posts[2], voltageColor(g, g.voltages[2]));
  // The arrow sits on the emitter and points the way conventional current
  // flows, which is what distinguishes NPN from PNP.
  if (pnp) arrowHead(g, posts[2], e1, 8, voltageColor(g, g.voltages[2]));
  else arrowHead(g, e1, posts[2], 8, voltageColor(g, g.voltages[2]));

  currentDots(g, posts[1], c1, g.current);
}

function drawPotBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  const [p1, p2] = endpoints(e);
  const color = voltageColor(g, (g.voltages[0] + g.voltages[1]) / 2);
  line(g, p1, lead1, voltageColor(g, g.voltages[0]));
  line(g, lead2, p2, voltageColor(g, g.voltages[1]));
  bodyRect(g, lead1, lead2, 6, color);  // IEC rectangle, 32 x 12 as upstream

  const wiper = potPosts(e)[2];
  const contact = interp(lead1, lead2, e.params.position ?? 0.5, 0);
  line(g, wiper, contact, voltageColor(g, g.voltages[2]));
  arrowHead(g, wiper, contact, 8, voltageColor(g, g.voltages[2]));
  label(g, e, formatValue(e.params.maxResistance ?? 0, 'Ω'), 20);
}

// ---------------------------------------------------------------------------
// Multi-terminal geometry
// ---------------------------------------------------------------------------

/** Default op-amp geometry is size 2 (16/26); FLAG_SMALL selects the 8/13
 *  small variant (OpAmpElm.java:113-118). */
function opampSize(e: CircuitElement): number {
  return (e.flags & OPAMP_SMALL) !== 0 ? 1 : 2;
}

function opampHeight(e: CircuitElement): number {
  return 8 * opampSize(e);
}

function opampWidth(e: CircuitElement): number {
  return 13 * opampSize(e);
}

/** The op-amp body's two lead stubs, base and apex of the triangle. */
function opAmpBodyLeads(e: CircuitElement): [Point, Point] {
  const [p1, p2] = endpoints(e);
  const dn = elementLength(e);
  const ww = Math.min(opampWidth(e), dn / 2);
  const f = (dn - ww * 2) / (2 * dn);
  return [interp(p1, p2, f), interp(p1, p2, 1 - f)];
}

/** Signed perpendicular offset of the inverting input: the size-scaled half
 *  separation, oriented by `dsign`, then negated by FLAG_SWAP. Shared by the
 *  posts and the drawing so leads and labels track a swapped body
 *  (OpAmpElm.java:127-129). */
export function opampInputSign(e: CircuitElement, p1: Point, p2: Point): number {
  let hs = opampHeight(e) * dsign(p1, p2);
  if ((e.flags & OPAMP_SWAP) !== 0) hs = -hs;
  return hs;
}

/** Body points where the op-amp's input leads attach, inverting first, ordered
 *  like `opAmpPosts`. */
export function opAmpInputAnchors(e: CircuitElement): [Point, Point] {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = opAmpBodyLeads(e);
  const hs = opampInputSign(e, p1, p2);
  return [interp(lead1, lead2, 0, hs), interp(lead1, lead2, 0, -hs)];
}

/** Centres of the minus and plus glyphs, inverting and non-inverting sides. */
export function opAmpLabelAnchors(e: CircuitElement): [Point, Point] {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = opAmpBodyLeads(e);
  const hs = opampInputSign(e, p1, p2);
  return [interp(lead1, lead2, 0.28, hs), interp(lead1, lead2, 0.28, -hs)];
}

function opAmpPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const [inverting, nonInverting] = interp2(p1, p2, 0, opampInputSign(e, p1, p2));
  return [inverting, nonInverting, p2];
}

/** Signed side factor for the transistor's collector and emitter, combining
 *  the pnp sign, `dsign` and FLAG_FLIP exactly as the original does
 *  (TransistorElm.java:218-220, `hs2 = hs*dsign*pnp`). */
export function transistorSideFactor(e: CircuitElement): number {
  const [p1, p2] = endpoints(e);
  let d = dsign(p1, p2);
  if ((e.flags & TRANSISTOR_FLIP) !== 0) d = -d;
  const pnp = (e.params.pnp ?? 1) === -1 ? -1 : 1;
  return d * pnp;
}

/** Points on the base bar where the collector and emitter leads attach,
 *  ordered like `transistorPosts`. */
export function transistorBarContacts(e: CircuitElement): [Point, Point] {
  const [p1, p2] = endpoints(e);
  return interp2(p1, p2, 0.72, OPEN_HS * 0.6 * transistorSideFactor(e));
}

function transistorPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  let d = dsign(p1, p2);
  if ((e.flags & TRANSISTOR_FLIP) !== 0) d = -d;
  const pnp = (e.params.pnp ?? 1) === -1 ? -1 : 1;
  const [coll, emit] = interp2(p1, p2, 1, OPEN_HS * d * pnp);
  return [p1, coll, emit];
}

/**
 * Replicates `PotElm.setPoints` (PotElm.java:184-209): the far post snaps to
 * the dominant axis and, on a drag, the wiper offset comes from the perpendicular
 * drag delta instead of a fixed side. The file stores the dragged x2,y2 while
 * the posts use the normalized endpoint, exactly like upstream.
 */
function potPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  let end = p2;
  let offset = 0;
  if (Math.abs(dx) > Math.abs(dy) !== ((e.flags & POT_FLIP) !== 0)) {
    const myLen = 2 * GRID_SIZE * Math.sign(dx) * Math.ceil(Math.abs(dx) / (2 * GRID_SIZE));
    end = { x: p1.x + myLen, y: p1.y };  // PotElm.java:190-192
    offset = dx < 0 ? dy : -dy;          // PotElm.java:191
  } else {
    const myLen = 2 * GRID_SIZE * Math.sign(dy) * Math.ceil(Math.abs(dy) / (2 * GRID_SIZE));
    if (dy !== 0) {
      end = { x: p1.x, y: p1.y + myLen };  // PotElm.java:196-197
      offset = dy > 0 ? dx : -dx;          // PotElm.java:197
    }
  }
  if (offset === 0)
    offset = (e.flags & POT_FLIP_OFFSET) !== 0 ? -GRID_SIZE : GRID_SIZE;  // PotElm.java:201-202
  return [p1, end, interp(p1, end, 0.5, offset)];  // post3, PotElm.java:209
}

function switch2Posts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const throws = Math.max(2, e.params.throwCount ?? 2);
  const posts: Point[] = [p1];
  // Upstream uses Java integer division here (Switch2Elm.java:76), so the
  // spacing stays grid-aligned for every even throw count.
  for (let i = 0; i < throws; i++) {
    const hs = i === 0 && throws === 2 ? OPEN_HS : -OPEN_HS * (i - Math.floor((throws - 1) / 2));
    posts.push(interp(p1, p2, 1, hs));
  }
  return posts;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const ELEMENT_DEFS: ElementDef[] = [
  {
    kind: 'wire',
    label: 'Wire',
    category: 'Basics',
    dumpCode: 'w',
    postCount: 2,
    posts: twoPosts,
    defaultLength: 4,  // 64 px, upstream's default getDragLength()
    draw(g, e) {
      const [p1, p2] = endpoints(e);
      line(g, p1, p2, voltageColor(g, g.voltages[0]));
      currentDots(g, p1, p2, g.current);
    },
  },
  {
    kind: 'ground',
    label: 'Ground',
    category: 'Basics',
    dumpCode: 'g',
    postCount: 1,
    posts: onePost,
    vertical: true,   // GroundElm.java:36, always placed vertically
    defaultLength: 2, // 32 px, GroundElm.java:140
    parse: (t, e) => readParams(t, e, ['symbolType']),
    dump: writeParams(['symbolType']),
    draw: drawGroundSymbol,
  },
  {
    kind: 'resistor',
    label: 'Resistor',
    category: 'Basics',
    dumpCode: 'r',
    postCount: 2,
    posts: twoPosts,
    defaults: { resistance: 1000 },
    parse: (t, e) => readParams(t, e, ['resistance']),
    dump: writeParams(['resistance']),
    fields: [{ name: 'resistance', label: 'Resistance', unit: 'Ω' }],
    draw: drawResistorBody,
  },
  {
    kind: 'capacitor',
    label: 'Capacitor',
    category: 'Basics',
    dumpCode: 'c',
    postCount: 2,
    posts: twoPosts,
    // 1e-3, not 0: upstream's constructor puts a small charge on every fresh
    // capacitor so an LC tank self-starts (CapacitorElm.java:38).
    defaults: { capacitance: 1e-5, initialVoltage: 1e-3, seriesResistance: 0 },
    // The stored voltage is part of the format but is state, not a setting.
    parse: capacitorParse,
    dump: writeParams(['capacitance', 'voltDiff', 'initialVoltage', 'seriesResistance']),
    dumpFlags: capacitorFlags,
    fields: [
      { name: 'capacitance', label: 'Capacitance', unit: 'F' },
      { name: 'seriesResistance', label: 'Series resistance', unit: 'Ω' },
      { name: 'initialVoltage', label: 'Initial voltage (on reset)', unit: 'V' },
      // Upstream labels this "Trapezoidal Approximation" and ticks it when the
      // flag is *clear* (CapacitorElm.java:238-241, :253-258); naming it after
      // the flag is the same control with the label the right way up.
      { name: 'backEuler', label: 'Backward Euler', type: 'bool', flag: CAP_BACK_EULER },
    ],
    draw: drawCapacitorBody,
  },
  {
    kind: 'polarizedCapacitor',
    label: 'Polarized Capacitor',
    category: 'Basics',
    dumpCode: '209',
    postCount: 2,
    posts: twoPosts,
    defaults: {
      capacitance: 1e-5,
      initialVoltage: 1e-3,
      seriesResistance: 0,
      maxNegativeVoltage: 1,
    },
    // Same trailing tokens as the plain capacitor, plus maxNegativeVoltage
    // (PolarCapacitorElm.java: dump() appends it after CapacitorElm.dump()).
    parse: polarCapacitorParse,
    dump: writeParams([
      'capacitance',
      'voltDiff',
      'initialVoltage',
      'seriesResistance',
      'maxNegativeVoltage',
    ]),
    dumpFlags: capacitorFlags,
    fields: [
      { name: 'capacitance', label: 'Capacitance', unit: 'F' },
      { name: 'seriesResistance', label: 'Series resistance', unit: 'Ω' },
      { name: 'initialVoltage', label: 'Initial voltage (on reset)', unit: 'V' },
      { name: 'maxNegativeVoltage', label: 'Max reverse voltage', unit: 'V', min: 0 },
      { name: 'backEuler', label: 'Backward Euler', type: 'bool', flag: CAP_BACK_EULER },
    ],
    draw: drawPolarCapacitorBody,
  },
  {
    kind: 'inductor',
    label: 'Inductor',
    category: 'Basics',
    dumpCode: 'l',
    postCount: 2,
    posts: twoPosts,
    // The second token is the running state the file was saved with
    // (InductorElm.java:42), kept so a mid-transient save reloads where it
    // left off; a zero here is indistinguishable from no saved state.
    defaults: { inductance: 1e-3, current: 0, initialCurrent: 0, saturationCurrent: 0 },
    parse: (t, e) =>
      readParams(t, e, ['inductance', 'current', 'initialCurrent', 'saturationCurrent']),
    dump: writeParams(['inductance', 'current', 'initialCurrent', 'saturationCurrent']),
    fields: [
      { name: 'inductance', label: 'Inductance', unit: 'H' },
      { name: 'initialCurrent', label: 'Initial current (on reset)', unit: 'A' },
      { name: 'saturationCurrent', label: 'Saturation current (0 = none)', unit: 'A' },
      // Same flag and same semantics as the capacitor's checkbox; upstream
      // labels it "Trapezoidal Approximation" and ticks it when the flag is
      // *clear* (InductorElm.java:133-137), so naming it after the flag is the
      // same control with the label the right way up.
      { name: 'backEuler', label: 'Backward Euler', type: 'bool', flag: IND_BACK_EULER },
    ],
    draw: drawInductorBody,
  },
  {
    kind: 'fuse',
    label: 'Fuse',
    category: 'Basics',
    // getDumpType() returns the int 404, not a char (FuseElm.java:67).
    dumpCode: '404',
    postCount: 2,
    posts: twoPosts,
    // FuseElm.java's no-args constructor: a Littelfuse 218-series rating
    // (FuseElm.java:34-39).
    defaults: { resistance: 0.0613, i2t: 6.73 },
    // dump()/the token constructor both go resistance, i2t, heat, blown
    // (FuseElm.java:43-49); blown is a literal `true`/`false` token like a
    // switch's momentary flag, not a number.
    parse: (t, e) => {
      readParams(t, e, ['resistance', 'i2t', 'heat']);
      e.params.blown = t[3] === 'true' ? 1 : 0;
    },
    dump: (e) => [
      e.params.resistance ?? 0.0613,
      e.params.i2t ?? 6.73,
      e.params.heat ?? 0,
      (e.params.blown ?? 0) !== 0 ? 'true' : 'false',
    ],
    fields: [
      { name: 'resistance', label: 'Resistance', unit: 'Ω' },
      { name: 'i2t', label: 'I²t rating', unit: 'A²s' },
    ],
    draw: drawFuseBody,
  },
  {
    kind: 'lamp',
    label: 'Lamp',
    category: 'Basics',
    // getDumpType() returns the int 181, not a char (LampElm.java:74).
    dumpCode: '181',
    postCount: 2,
    posts: twoPosts,
    // LampElm.java's no-args constructor: room temperature, a 100 W bulb
    // rated at 120 V, with 0.4 s warm-up and cool-down time constants
    // (LampElm.java:31-39).
    defaults: { temp: 300, nomPower: 100, nomVoltage: 120, warmTime: 0.4, coolTime: 0.4 },
    // dump()/the token constructor both go temp, nom_pow, nom_v, warmTime,
    // coolTime, in that order (LampElm.java:43-54).
    parse: (t, e) =>
      readParams(t, e, ['temp', 'nomPower', 'nomVoltage', 'warmTime', 'coolTime']),
    dump: writeParams(['temp', 'nomPower', 'nomVoltage', 'warmTime', 'coolTime']),
    // getEditInfo's four fields, in order (LampElm.java:195-206); `temp` is
    // simulation state like the fuse's `heat`, not something to edit.
    fields: [
      { name: 'nomPower', label: 'Nominal Power', unit: 'W', min: 0 },
      { name: 'nomVoltage', label: 'Nominal Voltage', unit: 'V', min: 0 },
      { name: 'warmTime', label: 'Warmup Time', unit: 's', min: 0 },
      { name: 'coolTime', label: 'Cooldown Time', unit: 's', min: 0 },
    ],
    draw: drawLampBody,
  },
  {
    kind: 'thermistor',
    label: 'Thermistor',
    category: 'Basics',
    // getDumpType() returns the int 350 (ThermistorNTCElm.java:75).
    dumpCode: '350',
    postCount: 2,
    posts: twoPosts,
    // ThermistorNTCElm.java's no-args constructor: a Vishay NTCLE100E3010
    // 10k thermistor, slider spanning -40..150 C and starting at 25 C
    // (ThermistorNTCElm.java:42-46).
    defaults: { r25: 10000, r50: 3605, minTempr: -40, maxTempr: 150, position: 0.34 },
    // The token constructor reads r25, r50, minTempr, maxTempr, position,
    // then sliderText as one escaped token (ThermistorNTCElm.java:60-70).
    // Upstream itself never overrides `dump()` — CircuitElm's base
    // implementation writes only the common x/y/flags fields, so a
    // text-format save from current upstream would actually drop these six
    // tokens entirely (its own save path is XML; see undumpXml at :86-99 for
    // the fields that matter there instead). This port writes them anyway,
    // like every other type here, so round-tripping through this app never
    // loses the thermistor's own state.
    parse: (t, e) => {
      readParams(t, e, ['r25', 'r50', 'minTempr', 'maxTempr', 'position']);
      if (t[5] !== undefined) e.text = t[5];
    },
    dump: (e) => [
      e.params.r25 ?? 10000,
      e.params.r50 ?? 3605,
      e.params.minTempr ?? -40,
      e.params.maxTempr ?? 150,
      e.params.position ?? 0.34,
      e.text?.trim() ? e.text : 'Temperature',  // ThermistorNTCElm.java:52
    ],
    // getEditInfo's five fields (ThermistorNTCElm.java:199-215); `position`
    // isn't one of them upstream — it's only reachable through the slider
    // widget — but sliders aren't wired up here yet (see OVERVIEW.md), so
    // it's exposed directly, the same simplification `potentiometer` already
    // makes for its own wiper.
    fields: [
      { name: 'r25', label: 'R at 25°C', unit: 'Ω', min: 0 },
      { name: 'r50', label: 'R at 50°C', unit: 'Ω', min: 0 },
      { name: 'minTempr', label: 'Slider min temp', unit: '°C' },
      { name: 'maxTempr', label: 'Slider max temp', unit: '°C' },
      { name: 'position', label: 'Slider position', min: 0, max: 1 },
      { name: 'text', label: 'Slider Text', type: 'text', target: 'text' },
    ],
    draw: drawThermistorBody,
  },
  {
    kind: 'potentiometer',
    label: 'Potentiometer',
    category: 'Basics',
    dumpCode: '174',
    postCount: 3,
    posts: potPosts,
    canMirror: true,
    defaultFlags: POT_SHOW_VALUES,  // PotElm.java:51
    defaults: { maxResistance: 1000, position: 0.5 },
    // Upstream joins every remaining token into the slider caption with single
    // spaces and never escapes it (PotElm.java:58-62), so the tokens stay raw
    // in both directions. Its own writer dropped these three tokens when the
    // save path moved to XML; its reader still requires them.
    rawTokens: true,
    parse: (t, e) => {
      readParams(t, e, ['maxResistance', 'position']);
      if (t.length > 2) e.text = t.slice(2).join(' ');
    },
    dump: (e) => {
      // An empty caption would write a trailing empty token and shift nothing
      // into `sliderText`, so fall back to the constructor's default.
      const text = e.text?.trim() ? e.text.trim() : 'Resistance';  // PotElm.java:50
      return [e.params.maxResistance ?? 1000, e.params.position ?? 0.5, ...text.split(/\s+/)];
    },
    fields: [
      { name: 'maxResistance', label: 'Max resistance', unit: 'Ω' },
      { name: 'position', label: 'Wiper position', min: 0, max: 1 },
    ],
    draw: drawPotBody,
  },
  {
    kind: 'ldr',
    label: 'LDR (photoresistor)',
    category: 'Basics',
    // getDumpType() returns the int 374 (LDRElm.java's "//LDR" comment).
    dumpCode: '374',
    postCount: 2,
    posts: twoPosts,
    // LDRElm.java's no-args constructor: slider position 0.34, the same
    // default the thermistor's slider uses (LDRElm.java:30). `minLux`/
    // `maxLux` are hardcoded there too (0.1/10000) but never read from a
    // file or exposed via `getEditInfo`, so they aren't params here.
    defaults: { position: 0.34 },
    // The token constructor reads position, then sliderText as one escaped
    // token (LDRElm.java's file constructor). Upstream itself never
    // overrides `dump()` here either — CircuitElm's base implementation
    // writes only the common x/y/flags fields, the same real quirk the
    // thermistor's `350` row documents (its own save path is XML; see
    // `dumpXml`/`undumpXml` for the fields that matter there instead). This
    // port writes both tokens anyway, like every other type here, so
    // round-tripping through this app never loses the LDR's own state.
    parse: (t, e) => {
      readParams(t, e, ['position']);
      if (t[1] !== undefined) e.text = t[1];
    },
    dump: (e) => [
      e.params.position ?? 0.34,
      e.text?.trim() ? e.text : 'Light Brightness', // LDRElm.java's constructor default
    ],
    // getEditInfo's one field (LDRElm.java's `getEditInfo`); `position` isn't
    // one of them upstream — it's only reachable through the slider widget —
    // but sliders aren't wired up here yet (see OVERVIEW.md), so it's exposed
    // directly, the same simplification `thermistor` and `potentiometer`
    // already make for their own sliders/wipers.
    fields: [
      { name: 'position', label: 'Slider position (light level)', min: 0, max: 1 },
      { name: 'text', label: 'Slider Text', type: 'text', target: 'text' },
    ],
    draw: drawLdrBody,
  },
  {
    kind: 'voltage',
    label: 'Voltage source',
    category: 'Sources',
    dumpCode: 'v',
    postCount: 2,
    posts: twoPosts,
    vertical: true,       // VoltageElm.java:93
    defaultLength: 4,     // 64 px, default getDragLength()
    defaultFlags: VOLTAGE_SHOW_VOLTAGE,
    defaults: { waveform: 0, frequency: 40, maxVoltage: 5, bias: 0, phaseShift: 0, dutyCycle: 0.5 },
    parse: (t, e) =>
      readParams(t, e, ['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
    dump: writeParams(['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
    fields: [
      {
        name: 'waveform',
        label: 'Waveform',
        type: 'choice',
        choices: [
          { value: 0, label: 'DC' },
          { value: 1, label: 'Sine' },
          { value: 2, label: 'Square' },
          { value: 3, label: 'Triangle' },
          { value: 4, label: 'Sawtooth' },
          { value: 5, label: 'Pulse' },
          { value: 6, label: 'Noise' },
        ],
      },
      { name: 'maxVoltage', label: 'Amplitude', unit: 'V' },
      { name: 'frequency', label: 'Frequency', unit: 'Hz' },
      { name: 'bias', label: 'DC offset', unit: 'V' },
      { name: 'dutyCycle', label: 'Duty cycle', min: 0, max: 1 },
    ],
    draw(g, e) {
      const [lead1, lead2] = drawSourceCircle(g, e, 12);
      drawWaveformGlyph(g, interp(lead1, lead2, 0.5), e.params.waveform ?? 0, 12);
      label(g, e, formatValue(e.params.maxVoltage ?? 0, 'V'), 20);
    },
  },
  {
    kind: 'rail',
    label: 'Voltage rail',
    category: 'Sources',
    dumpCode: 'R',
    postCount: 1,
    posts: onePost,
    defaultFlags: VOLTAGE_SHOW_VOLTAGE,  // RailElm.java:23-24, inherits the voltage source flag
    defaults: { waveform: 0, frequency: 40, maxVoltage: 5, bias: 0, phaseShift: 0, dutyCycle: 0.5 },
    parse: (t, e) =>
      readParams(t, e, ['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
    dump: writeParams(['waveform', 'frequency', 'maxVoltage', 'bias', 'phaseShift', 'dutyCycle']),
    fields: [
      { name: 'maxVoltage', label: 'Voltage', unit: 'V' },
      { name: 'frequency', label: 'Frequency', unit: 'Hz' },
    ],
    draw(g, e) {
      const [p1, p2] = endpoints(e);
      const color = voltageColor(g, g.voltages[0]);
      const stem = interp(p1, p2, 0.6);
      line(g, p1, stem, color);
      const [a, b] = interp2(p1, p2, 0.6, 10);
      line(g, a, b, color, 3);
      g.ctx.fillStyle = g.theme.text;
      g.ctx.font = canvasFont(10);
      g.ctx.textAlign = 'center';
      g.ctx.textBaseline = 'bottom';
      const t = interp(p1, p2, 1.0);
      g.ctx.fillText(formatValue(e.params.maxVoltage ?? 0, 'V'), t.x, t.y);
    },
  },
  {
    kind: 'current',
    label: 'Current source',
    category: 'Sources',
    dumpCode: 'i',
    postCount: 2,
    posts: twoPosts,
    defaults: { current: 0.01 },
    parse: (t, e) => readParams(t, e, ['current', 'maxVoltage']),
    dump: writeParams(['current', 'maxVoltage']),
    fields: [{ name: 'current', label: 'Current', unit: 'A' }],
    draw(g, e) {
      const [lead1, lead2] = drawSourceCircle(g, e, 12);
      const a = interp(lead1, lead2, 0.5 - 0.28);
      const b = interp(lead1, lead2, 0.5 + 0.28);
      line(g, a, b, g.theme.text, 1.5);
      arrowHead(g, a, b, 7, g.theme.text);
      label(g, e, formatValue(e.params.current ?? 0, 'A'), 20);
    },
  },
  {
    kind: 'diode',
    label: 'Diode',
    category: 'Semiconductors',
    dumpCode: 'd',
    postCount: 2,
    posts: twoPosts,
    // The default matches upstream's "default" model (DiodeModel.java:83):
    // fwdrop 0.805904783, n = 2, series resistance 0. Is is derived from the
    // forward drop, so it is not a UI field.
    defaults: { forwardVoltage: 0.805904783, seriesResistance: 0, emissionCoefficient: 2 },
    // FLAG_MODEL (bit 2) carries an escaped model name; FLAG_FWDROP (bit 1)
    // carries the forward drop the model was derived from.
    parse: (t, e) => {
      if ((e.flags & 2) !== 0) e.modelName = t[0];
      else if ((e.flags & 1) !== 0) e.params.forwardVoltage = Number(t[0]);
    },
    dump: (e) =>
      // Upstream's value form is the single fwdrop token, from which the model
      // derives everything else; seriesResistance and emissionCoefficient are
      // engine params that a named model would encode, so they intentionally do
      // not survive a save in the value form.
      e.modelName != null
        ? [e.modelName]
        : [e.params.forwardVoltage ?? 0.805904783],
    // The value form must carry exactly FLAG_FWDROP: with bit 2 (FLAG_MODEL)
    // left over from a loaded name, a reload would read the fwdrop token as a
    // bogus model name and silently lose the edit.
    dumpFlags: (e) => (e.modelName != null ? e.flags | 2 : (e.flags & ~2) | 1),
    fields: [
      { name: 'forwardVoltage', label: 'Forward drop', unit: 'V' },
      { name: 'seriesResistance', label: 'Series resistance', unit: 'Ω' },
      { name: 'emissionCoefficient', label: 'Emission coefficient' },
    ],
    draw: (g, e) => drawDiodeBody(g, e, false),
  },
  {
    kind: 'zener',
    label: 'Zener diode',
    category: 'Semiconductors',
    dumpCode: 'z',
    postCount: 2,
    posts: twoPosts,
    // The defaults are upstream's "default-zener" model (DiodeModel.java:84),
    // so a preserved `default-zener` name happens to simulate exactly.
    defaults: {
      forwardVoltage: 0.805904783,
      breakdownVoltage: 5.6,
      seriesResistance: 0,
      emissionCoefficient: 2,
    },
    // ZenerElm inherits DiodeElm's dump, then appends its own token, so the
    // trailing fields depend on the flags (ZenerElm.java:32-42): FLAG_MODEL
    // (bit 2) is an escaped model name on its own; otherwise FLAG_FWDROP
    // (bit 1) contributes a forward drop and the zener voltage always follows.
    parse: (t, e) => {
      if ((e.flags & 2) !== 0) {
        e.modelName = t[0];
        return;
      }
      // The zener voltage is last either way, so the field list is just the
      // fwdrop token prepended when its flag is set. Going through readParams
      // keeps the "skip non-finite tokens" guard, so a truncated line falls
      // back to the default-zener values instead of stamping NaN.
      const names =
        (e.flags & 1) !== 0 ? ['forwardVoltage', 'breakdownVoltage'] : ['breakdownVoltage'];
      readParams(t, e, names);
    },
    // The value form always writes both tokens: a bare zvoltage line would
    // lose the forward drop, and upstream throws on a `z` line that carries a
    // fwdrop with no zvoltage after it, dropping the element on load.
    dump: (e) =>
      e.modelName != null
        ? [e.modelName]
        : [e.params.forwardVoltage ?? 0.805904783, e.params.breakdownVoltage ?? 5.6],
    // The value form must carry exactly FLAG_FWDROP: with bit 2 (FLAG_MODEL)
    // left over from a loaded name, a reload would read the fwdrop token as a
    // bogus model name and silently lose the zener voltage.
    dumpFlags: (e) => (e.modelName != null ? e.flags | 2 : (e.flags & ~2) | 1),
    fields: [{ name: 'breakdownVoltage', label: 'Zener voltage', unit: 'V' }],
    draw: (g, e) => drawDiodeBody(g, e, true),
  },
  {
    kind: 'varactor',
    label: 'Varactor',
    category: 'Semiconductors',
    // getDumpType() returns the int 176, not a char (VaractorElm.java:19).
    dumpCode: '176',
    postCount: 2,
    posts: twoPosts,
    // VaractorElm extends DiodeElm and simulates the same "default" model
    // (forwardVoltage 0.805904783, series resistance 0, n = 2), plus its own
    // capacitance at 0 V (VaractorElm.java:9-12).
    defaults: {
      forwardVoltage: 0.805904783,
      seriesResistance: 0,
      emissionCoefficient: 2,
      baseCapacitance: 4e-12,
    },
    // VaractorElm's own constructor calls DiodeElm's token constructor first
    // (so the leading tokens are the diode's: an escaped model name under
    // FLAG_MODEL, else a forward drop under FLAG_FWDROP), then
    // unconditionally reads two more tokens of its own: capvoltdiff (the
    // persisted junction voltage) and baseCapacitance
    // (VaractorElm.java:13-18).
    parse: (t, e) => {
      if ((e.flags & 2) !== 0) {
        e.modelName = t[0];
        readParams(t.slice(1), e, ['capVoltDiff', 'baseCapacitance']);
        return;
      }
      const names =
        (e.flags & 1) !== 0
          ? ['forwardVoltage', 'capVoltDiff', 'baseCapacitance']
          : ['capVoltDiff', 'baseCapacitance'];
      readParams(t, e, names);
    },
    // Upstream's own dump() is inherited straight from DiodeElm and never
    // appends capvoltdiff or baseCapacitance at all, even though its own
    // token constructor above always expects them: a save-then-reload loses
    // both in the original app. The bundled corpus (varactor.txt,
    // varactorvco.txt) shows the tokens really are there in practice
    // (`176 x1 y1 x2 y2 1 0.805904783 <capvoltdiff> 4e-12`), so this port
    // writes them too, the same fix already applied to the thermistor and
    // LDR rows for their own real dump() quirks (see OVERVIEW.md section 6).
    dump: (e) => {
      const tail = [e.params.capVoltDiff ?? 0, e.params.baseCapacitance ?? 4e-12];
      return e.modelName != null
        ? [e.modelName, ...tail]
        : [e.params.forwardVoltage ?? 0.805904783, ...tail];
    },
    // The value form must carry exactly FLAG_FWDROP: with bit 2 (FLAG_MODEL)
    // left over from a loaded name, a reload would read the fwdrop token as a
    // bogus model name and misparse everything after it.
    dumpFlags: (e) => (e.modelName != null ? e.flags | 2 : (e.flags & ~2) | 1),
    fields: [
      { name: 'baseCapacitance', label: 'Capacitance @ 0V', unit: 'F' },
      { name: 'forwardVoltage', label: 'Forward drop', unit: 'V' },
      { name: 'seriesResistance', label: 'Series resistance', unit: 'Ω' },
      { name: 'emissionCoefficient', label: 'Emission coefficient' },
    ],
    draw: drawVaractorBody,
  },
  {
    kind: 'transistor',
    label: 'Transistor (BJT)',
    category: 'Semiconductors',
    dumpCode: 't',
    postCount: 3,
    posts: transistorPosts,
    canMirror: true,
    noDiagonal: true,  // TransistorElm.java:80
    defaults: { pnp: 1, beta: 100 },
    // The file sign is the type: +1 is NPN, -1 is PNP, and the optional 5th
    // token is the model name. A non-negative pnp (including the legacy 0
    // saved by older builds) normalises to NPN.
    parse: (t, e) => {
      const raw = Number(t[0]);
      e.params.pnp = Number.isFinite(raw) ? (raw < 0 ? -1 : 1) : 1;
      // Non-finite tokens are skipped, matching readParams, so a malformed
      // line keeps its defaults instead of poisoning the engine with NaN.
      if (t[1] !== undefined && Number.isFinite(Number(t[1]))) e.params.lastVbe = Number(t[1]);
      if (t[2] !== undefined && Number.isFinite(Number(t[2]))) e.params.lastVbc = Number(t[2]);
      if (t[3] !== undefined && Number.isFinite(Number(t[3]))) e.params.beta = Number(t[3]);
      if (t[4] !== undefined) e.text = t[4];
    },
    // The model name is re-emitted only when it was present on load, so a line
    // that arrived with 4 tokens stays 4 tokens.
    dump: (e) => [
      (e.params.pnp ?? 1) === -1 ? -1 : 1,
      e.params.lastVbe ?? 0,
      e.params.lastVbc ?? 0,
      e.params.beta ?? 100,
      ...(e.text !== undefined ? [e.text] : []),
    ],
    fields: [
      {
        name: 'pnp',
        label: 'Type',
        type: 'choice',
        choices: [
          { value: 1, label: 'NPN' },
          { value: -1, label: 'PNP' },
        ],
      },
      { name: 'beta', label: 'Current gain (β)' },
    ],
    draw: drawTransistorBody,
  },
  {
    kind: 'switch',
    label: 'Switch',
    category: 'Basics',
    dumpCode: 's',
    postCount: 2,
    posts: twoPosts,
    interactive: true,
    defaults: { position: 0, momentary: 0 },
    parse: (t, e) => {
      // The position token is written as `true`/`false` by some versions.
      const p = t[0];
      e.params.position = p === 'true' ? 1 : p === 'false' ? 0 : Number(p) || 0;
      e.params.momentary = t[1] === 'true' ? 1 : 0;
      // The label token only exists under FLAG_LABEL (SwitchElm.java:66-67).
      if ((e.flags & SWITCH_LABEL) !== 0 && t[2] !== undefined) e.text = t[2];
      e.state = e.params.position;
    },
    // The format writes the momentary flag as a literal `true`/`false`.
    dump: switchTokens,
    dumpFlags: labelFlags,
    draw: drawSwitchBody,
  },
  {
    kind: 'switch2',
    label: 'SPDT switch',
    category: 'Basics',
    dumpCode: 'S',
    postCount: 3,
    posts: switch2Posts,
    interactive: true,
    noDiagonal: true,  // Switch2Elm.java:35,51
    defaults: { position: 0, throwCount: 2 },
    parse: (t, e) => {
      const p = t[0];
      e.params.position = p === 'true' ? 1 : p === 'false' ? 0 : Number(p) || 0;
      e.params.momentary = t[1] === 'true' ? 1 : 0;
      // Upstream reads the label in `super(...)` before link and throwCount
      // (Switch2Elm.java:44-50), so a label shifts both of them one token on.
      let i = 2;
      if ((e.flags & SWITCH_LABEL) !== 0 && t[i] !== undefined) e.text = t[i++];
      e.params.link = Number(t[i++]) || 0;
      e.params.throwCount = Number(t[i]) || 2;
      e.state = e.params.position;
    },
    dump: (e) => [...switchTokens(e), e.params.link ?? 0, e.params.throwCount ?? 2],
    dumpFlags: labelFlags,
    draw(g, e) {
      const posts = switch2Posts(e);
      const [p1, p2] = endpoints(e);
      const lead1 = interp(p1, p2, 0.25);
      line(g, p1, lead1, voltageColor(g, g.voltages[0]));
      const sel = (e.state ?? 0) + 1;
      posts.slice(1).forEach((p, i) => {
        line(g, interp(p1, p2, 0.75, 0), p, voltageColor(g, g.voltages[i + 1]));
        circle(g, interp(p1, p2, 0.75, 0), 2, g.theme.wire, true, 1);
      });
      // Center-off is the open middle position: the lever rests on the pole
      // where the throws fan out rather than on a throw, so `posts[sel]`
      // would be out of range (Switch2Elm.java:82,108-109).
      const centerOff =
        (e.flags & SWITCH2_CENTER_OFF) !== 0 &&
        (e.params.throwCount ?? 2) === 2 &&
        (e.state ?? 0) === 2;
      const tip = centerOff ? interp(p1, p2, 0.75) : posts[Math.min(sel, posts.length - 1)];
      line(g, lead1, tip, voltageColor(g, g.voltages[0]));
      if (!centerOff) currentDots(g, p1, tip, g.current);
    },
  },
  {
    kind: 'opamp',
    label: 'Op-amp',
    category: 'Active',
    dumpCode: 'a',
    postCount: 3,
    posts: opAmpPosts,
    canMirror: true,
    noDiagonal: true,  // OpAmpElm.java:34
    defaultFlags: OPAMP_GAIN,  // OpAmpElm.java:38,40
    defaults: { maxOut: 15, minOut: -15, gain: 100000 },
    parse: (t, e) => readParams(t, e, ['maxOut', 'minOut', 'gbw', 'volts0', 'volts1', 'gain']),
    dump: (e) => [
      e.params.maxOut ?? 15,
      e.params.minOut ?? -15,
      e.params.gbw ?? 1e6,
      e.params.volts0 ?? 0,
      e.params.volts1 ?? 0,
      e.params.gain ?? 100000,
    ],
    fields: [
      { name: 'maxOut', label: 'Max output', unit: 'V' },
      { name: 'minOut', label: 'Min output', unit: 'V' },
      { name: 'gain', label: 'Open-loop gain' },
    ],
    draw: drawOpAmpBody,
  },
  {
    kind: 'labeledNode',
    label: 'Labeled node',
    category: 'Other',
    dumpCode: '207',
    postCount: 1,
    posts: onePost,
    fields: [{ name: 'text', label: 'Text', type: 'text', target: 'text' }],
    parse: (t, e) => {
      // Both upstream readers end up with the same string: the new-style one
      // unescapes a single token (done by the netlist layer), the old-style
      // one joins the rest with spaces (LabeledNodeElm.java:41-49).
      e.text = t.join(' ');
    },
    dump: (e) => [e.text ?? ''],
    dumpFlags: escapeFlags,
    draw(g, e) {
      const p = { x: e.x1, y: e.y1 };
      const text = e.text ?? '';
      g.ctx.font = canvasFont(11);
      const w = g.ctx.measureText(text).width + 10;
      g.ctx.fillStyle = g.theme.panel;
      g.ctx.strokeStyle = g.selected ? g.theme.selection : voltageColor(g, g.voltages[0]);
      g.ctx.lineWidth = 1.5;
      g.ctx.beginPath();
      g.ctx.rect(p.x, p.y - 8, w, 16);
      g.ctx.fill();
      g.ctx.stroke();
      g.ctx.fillStyle = g.theme.text;
      g.ctx.textAlign = 'center';
      g.ctx.textBaseline = 'middle';
      g.ctx.fillText(text, p.x + w / 2, p.y);
    },
  },
  {
    kind: 'output',
    label: 'Voltage readout',
    category: 'Other',
    dumpCode: 'O',
    postCount: 1,
    posts: onePost,
    parse: (t, e) => readParams(t, e, ['scale']),
    dump: writeParams(['scale']),
    draw(g, e) {
      const p = { x: e.x1, y: e.y1 };
      circle(g, p, 4, voltageColor(g, g.voltages[0]), false, 2);
      g.ctx.fillStyle = g.theme.text;
      g.ctx.font = canvasFont(11);
      g.ctx.textAlign = 'left';
      g.ctx.textBaseline = 'middle';
      g.ctx.fillText(formatValue(g.voltages[0] ?? 0, 'V'), p.x + 8, p.y);
    },
  },
  {
    kind: 'probe',
    label: 'Voltmeter',
    category: 'Other',
    dumpCode: 'p',
    postCount: 2,
    posts: twoPosts,
    defaultFlags: PROBE_SHOW_VOLTAGE | PROBE_CIRCLE,  // ProbeElm.java:52
    parse: (t, e) => readParams(t, e, ['meter', 'scale', 'resistance']),
    dump: writeParams(['meter', 'scale', 'resistance']),
    draw(g, e) {
      const [lead1, lead2] = calcLeads(e, 16);
      line(g, { x: e.x1, y: e.y1 }, lead1, voltageColor(g, g.voltages[0]));
      line(g, lead2, { x: e.x2, y: e.y2 }, voltageColor(g, g.voltages[1]));
      const mid = interp(lead1, lead2, 0.5);
      circle(g, mid, 9, g.theme.wire, false, 1.5);
      g.ctx.fillStyle = g.theme.text;
      g.ctx.font = canvasFont(9);
      g.ctx.textAlign = 'center';
      g.ctx.textBaseline = 'middle';
      g.ctx.fillText('V', mid.x, mid.y);
      label(g, e, formatValue(g.voltage, 'V'), 18);
    },
  },
  {
    kind: 'decoration',
    label: 'Text',
    category: 'Other',
    dumpCode: 'x',
    postCount: 1,
    posts: onePost,
    defaults: { size: 24 },  // TextElm.java:44
    fields: [
      { name: 'text', label: 'Text', type: 'text', target: 'text' },
      { name: 'size', label: 'Size', unit: 'px' },
    ],
    parse: (t, e) => {
      e.params.size = Number(t[0]) || 24;
      let text = t.slice(1).join(' ');
      // Dumps older than the escape scheme URL-encoded the plus sign, because
      // upstream's tokenizer treats `+` as a separator (TextElm.java:55).
      if ((e.flags & FLAG_ESCAPE) === 0) text = text.replace(/%2[bB]/g, '+');
      e.text = text;
    },
    dump: (e) => [e.params.size ?? 24, e.text ?? ''],
    dumpFlags: escapeFlags,
    draw(g, e) {
      g.ctx.fillStyle = g.selected ? g.theme.selection : g.theme.text;
      // A zero or negative size would make an invalid font string and blank
      // the whole frame's drawing, so clamp at one pixel.
      g.ctx.font = canvasFont(Math.max(1, e.params.size ?? 24));
      g.ctx.textAlign = 'left';
      g.ctx.textBaseline = 'middle';
      g.ctx.fillText(e.text ?? '', e.x1, e.y1);
    },
  },
];

const BY_KIND = new Map(ELEMENT_DEFS.map((d) => [d.kind, d]));
const BY_DUMP_CODE = new Map(ELEMENT_DEFS.map((d) => [d.dumpCode, d]));

export function defFor(kind: string): ElementDef | undefined {
  return BY_KIND.get(kind);
}

export function defForDumpCode(code: string): ElementDef | undefined {
  return BY_DUMP_CODE.get(code);
}

/** Terminal coordinates for an element, or an empty list for unknown types. */
export function postsOf(e: CircuitElement): Point[] {
  return defFor(e.kind)?.posts(e) ?? [];
}

/** Toolbox groupings, in display order. */
export const CATEGORIES = ['Basics', 'Sources', 'Semiconductors', 'Active', 'Other'];
