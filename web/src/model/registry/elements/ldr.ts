import {
  calcLeads,
  currentDotsPath,
  drawLeads,
  endpoints,
  formatValueShort,
  gradientPolyline,
  interp,
  label,
  rectCorners,
  zigzagPoints,
} from '../../../render/draw';
import { bodyBox, readParams, twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Half-height of the LDR's resistor body, both the euro box and the
 *  American zigzag peaks: upstream uses the single `hs = 6` for both
 *  (LDRElm.java:106). */
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
 * draws to mark it light-sensitive, all shading along the voltage drop like
 * the plain resistor (LDRElm.java:134-147, whose gradient is this shape's
 * model). The arrows are sub-shapes of the body, so they sample the ramp at
 * their own position along the `lead1`-`lead2` axis, which is why the axis
 * must be passed explicitly: each arrow's own chord is offset from, not on,
 * the body axis. Upstream's local coordinates run from `0` at `lead1` along
 * the axis, in pixels rather than a fraction of `len`, and a perpendicular
 * pixel offset from the axis; `interp`'s fraction/offset pair uses that same
 * local frame with the fraction argument as `x/len`, except its `+g` is
 * upstream's `-y` (this port's perpendicular unit vector is the negation of
 * upstream's, the same sign flip `drawThermistorBody` above documents):
 * verified against a concrete horizontal lead1=(0,0)/lead2=(100,0) example:
 * upstream's local (8,12) is 8px right of lead1 and 12px below it (canvas y
 * grows downward), and `interp(lead1, lead2, 8/100, -12)` lands on that same
 * (8,12).
 */
function drawLdrBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  drawLeads(g, e, lead1, lead2);
  // Deliberate divergence from upstream: LDRElm.java:116 sets its gradient
  // unconditionally, no volts-check guard and no power `else`, so the body
  // draws white under Show-Voltage-off. Here `axisColor` falls back to the
  // flat power colour instead, matching `elementColor` everywhere else and
  // the resistor's own upstream else branch. Do not "fix" it upstreamward.
  if (g.euroResistors) {
    // The box axis must be given explicitly: a closed path's last point
    // repeats the first, so its own chord is zero.
    const corners = rectCorners(lead1, lead2, LDR_HS);
    gradientPolyline(g, [corners[0], corners[1], corners[2], corners[3], corners[0]], {
      axis: [lead1, lead2],
    });
  } else {
    // The zigzag uses the same `hs` as the box, upstream's single hs=6
    // (LDRElm.java:106).
    gradientPolyline(g, zigzagPoints(lead1, lead2, LDR_HS));
  }
  const len = Math.hypot(lead2.x - lead1.x, lead2.y - lead1.y);
  if (len > 0) {
    const pt = (x: number, y: number): Point => interp(lead1, lead2, x / len, -y);
    // The two light arrows, thick like the body (LDRElm.java:114).
    gradientPolyline(g, [pt(-8, 26), pt(8, 12)], { axis: [lead1, lead2] });
    gradientPolyline(g, [pt(2, 12), pt(8, 12), pt(8, 18)], { axis: [lead1, lead2] });
    gradientPolyline(g, [pt(12, 26), pt(26, 12)], { axis: [lead1, lead2] });
    gradientPolyline(g, [pt(20, 12), pt(26, 12), pt(26, 18)], { axis: [lead1, lead2] });
  }
  const [p1, p2] = endpoints(e);
  currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
  label(g, e, formatValueShort(ldrResistance(e), 'Ω', g.valueDigits));
}

export const LDR_DEF: ElementDef = {
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
  // overrides `dump()` here either: CircuitElm's base implementation
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
  // one of them upstream, where it is reachable only through the slider
  // widget. That slider is wired up here too: model/sliders.ts maps this
  // caption to `position`; the direct field sits beside it, like
  // `thermistor`'s and `potentiometer`'s.
  fields: [
    { name: 'position', label: 'Slider position (light level)', min: 0, max: 1 },
    { name: 'text', label: 'Slider Text', type: 'text', target: 'text' },
  ],
  // The resistor box plus the two light arrows that reach 26 units off the
  // axis (LDRElm.java:79-82), so the box covers the whole symbol.
  bodyRect: (e) => bodyBox(e, 32, 26),
  draw: drawLdrBody,
};
