import {
  calcLeads,
  circle,
  currentDotsFrom,
  dotPhaseAfter,
  drawLeads,
  endpoints,
  interp,
  interpPrecise,
  interp2Precise,
  line,
  triangle,
} from '../../../render/draw';
import { elementColor, readParams, twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** Body length between the leads and ring radius of the LED symbol, upstream's
 *  `cr = 12` and the `12/dn` lead inset (LEDElm.java:74-77). */
const LED_BODY = 24;
const LED_RING = 12;

/** Brightness of the LED glow, 0..255, from the current relative to
 *  `maxBrightnessCurrent` (LEDElm.java:94-101). At the rated current the term
 *  is 255; the 0.2 log factor lifts a faint glow off black well before a
 *  linear ramp would, and the whole curve clamps at both ends. */
function ledBrightness(g: DrawContext, e: CircuitElement): number {
  const mbc = e.params.maxBrightnessCurrent ?? 0.01;
  if (mbc <= 0) return 0;
  const ratio = g.current / mbc;
  let w = ratio > 0 ? 255 * (1 + 0.2 * Math.log(ratio)) : 0;
  if (w > 255) w = 255;
  if (w < 0) w = 0;
  return w;
}

/** The glow fill colour, the element's RGB channels scaled by the brightness. */
function ledGlow(g: DrawContext, e: CircuitElement): string {
  const w = ledBrightness(g, e);
  const r = Math.round((e.params.colorR ?? 1) * w);
  const gr = Math.round((e.params.colorG ?? 0) * w);
  const b = Math.round((e.params.colorB ?? 0) * w);
  return `rgb(${r},${gr},${b})`;
}

function drawLedBody(g: DrawContext, e: CircuitElement): void {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = calcLeads(e, LED_BODY);
  drawLeads(g, e, lead1, lead2);
  const centre = interp(p1, p2, 0.5);

  // The ring is the LED's static outline and the disc inside carries the
  // colour, the classic diode-inside-a-circle symbol (LEDElm.java:90-104).
  // Upstream strokes the ring with drawThickCircle (LEDElm.java:92), so it is
  // the 3-unit body weight.
  circle(g, centre, LED_RING, g.theme.wire, false);
  circle(g, centre, LED_RING - 4, ledGlow(g, e), true);

  // The diode arrow on top keeps the part reading as an LED even when the
  // current is zero and the glow is black. LEDElm.draw only draws this arrow
  // in its highlighted or creating fallback, but this port keeps it visible;
  // the triangle is scaled to sit inside the ring instead of spanning the
  // whole body like the plain diode's.
  const color = elementColor(g, (g.voltages[0] + g.voltages[1]) / 2, g.power);
  // The diode arrow is body geometry, so it is drawn without the grid rounding
  // `interp` applies to posts, keeping the triangle square to the body.
  const [t1, t2] = interp2Precise(lead1, lead2, 0.25, 6);
  const tip = interpPrecise(lead1, lead2, 0.75);
  triangle(g, t1, t2, tip, color);
  const [b1, b2] = interp2Precise(lead1, lead2, 0.75, 6);
  // The cathode bar is a drawThickLine stroke upstream (DiodeElm.java:163),
  // the 3-unit weight.
  line(g, b1, b2, color);

  // Upstream draws the dots only on the two leads, never across the glowing
  // body (LEDElm.java:107-108), so each run gets its own phase.
  const leadLen = Math.hypot(lead1.x - p1.x, lead1.y - p1.y);
  currentDotsFrom(g, p1, lead1, g.current, g.dotPhase);
  currentDotsFrom(g, lead2, p2, g.current, dotPhaseAfter(g.dotPhase, leadLen));
}

export const LED_DEF: ElementDef = {
  kind: 'led',
  label: 'LED',
  category: 'Semiconductors',
  // getDumpType() returns the int 162, not a char (LEDElm.java:55).
  dumpCode: '162',
  postCount: 2,
  posts: twoPosts,
  // The same three engine params as the diode (a named model would encode the
  // first two), but with the LED's own forward drop: 2.1024259 V is the drop
  // a flagless `162` line falls back to (LEDElm.java:41), and the saturation
  // current is derived from it the same way the diode's default is. The
  // colour and brightness fields only affect the glow, never the simulation.
  defaults: {
    forwardVoltage: 2.1024259,
    seriesResistance: 0,
    emissionCoefficient: 2,
    colorR: 1,
    colorG: 0,
    colorB: 0,
    maxBrightnessCurrent: 0.01,
  },
  // LEDElm's token constructor reads the diode's leading tokens first (an
  // escaped model name under FLAG_MODEL, else a forward drop under
  // FLAG_FWDROP), then colorR/G/B and an optional maxBrightnessCurrent
  // (LEDElm.java:37-53). With neither flag the line is the flagless form and
  // the drop is the 2.1024259 default, so the remaining tokens start at
  // colorR.
  parse: (t, e) => {
    let rest: string[];
    if ((e.flags & 2) !== 0) {
      e.modelName = t[0];
      rest = t.slice(1);
    } else if ((e.flags & 1) !== 0) {
      e.params.forwardVoltage = Number(t[0]);
      rest = t.slice(1);
    } else {
      e.params.forwardVoltage = 2.1024259;
      rest = t;
    }
    readParams(rest, e, ['colorR', 'colorG', 'colorB', 'maxBrightnessCurrent']);
  },
  // Upstream's LEDElm never overrides dump(), so its text save inherits
  // DiodeElm's and drops the colour tokens on the floor. The bundled corpus
  // and the token constructor agree the tokens are part of the format, so
  // this port writes them, the same fix already applied to the varactor's
  // capvoltdiff pair.
  dump: (e) => {
    const tail = [
      e.params.colorR ?? 1,
      e.params.colorG ?? 0,
      e.params.colorB ?? 0,
      e.params.maxBrightnessCurrent ?? 0.01,
    ];
    return e.modelName != null
      ? [e.modelName, ...tail]
      : [e.params.forwardVoltage ?? 2.1024259, ...tail];
  },
  // The value form must carry exactly FLAG_FWDROP: with bit 2 (FLAG_MODEL)
  // left over from a loaded name, a reload would read the fwdrop token as a
  // bogus model name and misparse every token after it.
  dumpFlags: (e) => (e.modelName != null ? e.flags | 2 : (e.flags & ~2) | 1),
  // The LED's own edit fields come first (getEditInfo n = 0..3), then the
  // diode model fields (n - 4, LEDElm.java:121-134).
  fields: [
    { name: 'colorR', label: 'Red (0-1)', min: 0, max: 1 },
    { name: 'colorG', label: 'Green (0-1)', min: 0, max: 1 },
    { name: 'colorB', label: 'Blue (0-1)', min: 0, max: 1 },
    { name: 'maxBrightnessCurrent', label: 'Max brightness current', unit: 'A', min: 0 },
    { name: 'forwardVoltage', label: 'Forward drop', unit: 'V' },
    { name: 'seriesResistance', label: 'Series resistance', unit: 'Ω' },
    { name: 'emissionCoefficient', label: 'Emission coefficient' },
  ],
  draw: drawLedBody,
};
