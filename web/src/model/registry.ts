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

/** Perpendicular half-separation of op-amp inputs, from the original. */
const OPAMP_HEIGHT = 8;
const OPAMP_WIDTH = 13;
/** Perpendicular offset of switch throws and transistor collector/emitter. */
const OPEN_HS = 16;

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
  const dn = elementLength(e);
  const ww = Math.min(OPAMP_WIDTH, dn / 2);
  const f = (dn - ww * 2) / (2 * dn);
  const lead1 = interp(p1, p2, f);
  const lead2 = interp(p1, p2, 1 - f);
  const posts = opAmpPosts(e);

  // Input leads.
  line(g, posts[0], interp(lead1, lead2, 0, OPAMP_HEIGHT), voltageColor(g, g.voltages[0]));
  line(g, posts[1], interp(lead1, lead2, 0, -OPAMP_HEIGHT), voltageColor(g, g.voltages[1]));
  line(g, lead2, p2, voltageColor(g, g.voltages[2]));

  const [t1, t2] = interp2(lead1, lead2, 0, OPAMP_HEIGHT * 2);
  triangle(g, t1, t2, lead2, g.theme.panel);
  polyline(g, [t1, t2, lead2, t1], g.theme.wire, 2);

  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(10);
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  const m = interp(lead1, lead2, 0.28, OPAMP_HEIGHT);
  const p = interp(lead1, lead2, 0.28, -OPAMP_HEIGHT);
  g.ctx.fillText('−', m.x, m.y);
  g.ctx.fillText('+', p.x, p.y);
  currentDots(g, lead2, p2, g.current);
}

function drawTransistorBody(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const posts = transistorPosts(e);
  const pnp = (e.params.pnp ?? 0) !== 0;
  const baseColor = voltageColor(g, g.voltages[0]);

  // Base lead up to the vertical bar.
  const barCentre = interp(p1, p2, 0.72);
  line(g, p1, barCentre, baseColor);
  const [b1, b2] = interp2(p1, p2, 0.72, OPEN_HS * 0.6);
  line(g, b1, b2, baseColor, 3);

  // Collector and emitter leads from the bar out to their posts.
  const [c1, e1] = interp2(p1, p2, 0.72, OPEN_HS * 0.6);
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

function opAmpPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const flip = (e.flags & 1) !== 0;
  const hs = flip ? -OPAMP_HEIGHT : OPAMP_HEIGHT;
  const [inverting, nonInverting] = interp2(p1, p2, 0, hs);
  return [inverting, nonInverting, p2];
}

function transistorPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const pnp = (e.params.pnp ?? 0) !== 0 ? -1 : 1;
  const [coll, emit] = interp2(p1, p2, 1, OPEN_HS * pnp);
  return [p1, coll, emit];
}

function potPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const wiper = interp(p1, p2, 0.5, -OPEN_HS);
  return [p1, p2, wiper];
}

function switch2Posts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const throws = Math.max(2, e.params.throwCount ?? 2);
  const posts: Point[] = [p1];
  for (let i = 0; i < throws; i++) {
    const hs = i === 0 && throws === 2 ? OPEN_HS : -OPEN_HS * (i - (throws - 1) / 2);
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
    defaultLength: 2,
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
    defaults: { capacitance: 1e-5 },
    // The stored voltage is part of the format but is state, not a setting.
    parse: (t, e) =>
      readParams(t, e, ['capacitance', 'voltDiff', 'initialVoltage', 'seriesResistance']),
    dump: writeParams(['capacitance', 'voltDiff', 'initialVoltage', 'seriesResistance']),
    fields: [
      { name: 'capacitance', label: 'Capacitance', unit: 'F' },
      { name: 'initialVoltage', label: 'Initial voltage', unit: 'V' },
    ],
    draw: drawCapacitorBody,
  },
  {
    kind: 'inductor',
    label: 'Inductor',
    category: 'Basics',
    dumpCode: 'l',
    postCount: 2,
    posts: twoPosts,
    defaults: { inductance: 1e-3 },
    parse: (t, e) =>
      readParams(t, e, ['inductance', 'currentState', 'initialCurrent', 'saturationCurrent']),
    dump: writeParams(['inductance', 'currentState', 'initialCurrent', 'saturationCurrent']),
    fields: [{ name: 'inductance', label: 'Inductance', unit: 'H' }],
    draw: drawInductorBody,
  },
  {
    kind: 'potentiometer',
    label: 'Potentiometer',
    category: 'Basics',
    dumpCode: '174',
    postCount: 3,
    posts: potPosts,
    defaults: { maxResistance: 1000, position: 0.5 },
    parse: (t, e) => readParams(t, e, ['maxResistance', 'position']),
    dump: (e) => [e.params.maxResistance ?? 1000, e.params.position ?? 0.5, e.text ?? 'Resistance'],
    fields: [
      { name: 'maxResistance', label: 'Max resistance', unit: 'Ω' },
      { name: 'position', label: 'Wiper position', min: 0, max: 1 },
    ],
    draw: drawPotBody,
  },
  {
    kind: 'voltage',
    label: 'Voltage source',
    category: 'Sources',
    dumpCode: 'v',
    postCount: 2,
    posts: twoPosts,
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
    defaults: { forwardVoltage: 0.805 },
    fields: [{ name: 'forwardVoltage', label: 'Forward drop', unit: 'V' }],
    draw: (g, e) => drawDiodeBody(g, e, false),
  },
  {
    kind: 'zener',
    label: 'Zener diode',
    category: 'Semiconductors',
    dumpCode: 'z',
    postCount: 2,
    posts: twoPosts,
    defaults: { forwardVoltage: 0.805, breakdownVoltage: 5.6 },
    parse: (t, e) => readParams(t, e, ['breakdownVoltage']),
    dump: writeParams(['breakdownVoltage']),
    fields: [{ name: 'breakdownVoltage', label: 'Zener voltage', unit: 'V' }],
    draw: (g, e) => drawDiodeBody(g, e, true),
  },
  {
    kind: 'transistor',
    label: 'Transistor (BJT)',
    category: 'Semiconductors',
    dumpCode: 't',
    postCount: 3,
    posts: transistorPosts,
    defaults: { pnp: 0, beta: 100 },
    parse: (t, e) => readParams(t, e, ['pnp', 'lastVbe', 'lastVbc', 'beta']),
    dump: writeParams(['pnp', 'lastVbe', 'lastVbc', 'beta']),
    fields: [
      {
        name: 'pnp',
        label: 'Type',
        type: 'choice',
        choices: [
          { value: 0, label: 'NPN' },
          { value: 1, label: 'PNP' },
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
      e.state = e.params.position;
    },
    // The format writes the momentary flag as a literal `true`/`false`.
    dump: (e) => [
      e.state ?? e.params.position ?? 0,
      (e.params.momentary ?? 0) !== 0 ? 'true' : 'false',
    ],
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
    defaults: { position: 0, throwCount: 2 },
    parse: (t, e) => {
      const p = t[0];
      e.params.position = p === 'true' ? 1 : p === 'false' ? 0 : Number(p) || 0;
      e.params.momentary = t[1] === 'true' ? 1 : 0;
      e.params.link = Number(t[2]) || 0;
      e.params.throwCount = Number(t[3]) || 2;
      e.state = e.params.position;
    },
    dump: (e) => [
      e.state ?? e.params.position ?? 0,
      (e.params.momentary ?? 0) !== 0 ? 'true' : 'false',
      e.params.link ?? 0,
      e.params.throwCount ?? 2,
    ],
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
      line(g, lead1, posts[sel], voltageColor(g, g.voltages[0]));
      currentDots(g, p1, posts[sel], g.current);
    },
  },
  {
    kind: 'opamp',
    label: 'Op-amp',
    category: 'Active',
    dumpCode: 'a',
    postCount: 3,
    posts: opAmpPosts,
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
      e.text = t.join(' ');
    },
    dump: (e) => [e.text ?? ''],
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
    fields: [
      { name: 'text', label: 'Text', type: 'text', target: 'text' },
      { name: 'size', label: 'Size', unit: 'px' },
    ],
    parse: (t, e) => {
      e.params.size = Number(t[0]) || 12;
      e.text = t.slice(1).join(' ');
    },
    dump: (e) => [e.params.size ?? 12, e.text ?? ''],
    draw(g, e) {
      g.ctx.fillStyle = g.selected ? g.theme.selection : g.theme.text;
      // A zero or negative size would make an invalid font string and blank
      // the whole frame's drawing, so clamp at one pixel.
      g.ctx.font = canvasFont(Math.max(1, e.params.size ?? 12));
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
