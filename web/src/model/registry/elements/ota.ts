/**
 * Operational transconductance amplifier (OTAElm.java, dump 402): an
 * LM13700-style OTA built as a composite of two supply rails and sixteen
 * transistors. The engine owns the child network; the frontend only draws the
 * symbol and carries the file tokens.
 *
 * Token layout after the common fields is one `_`-joined dump token per
 * composite child (CompositeElm.dump): two rails then sixteen transistors,
 * each carrying its saved flags, polarity, junction state and beta. The tokens
 * are opaque to the frontend and raw on both sides, like the darlington's, so
 * a load/save round-trip stays byte-for-byte. They reach the engine as a JSON
 * array in `spec.model` (the string carrier the custom-logic element uses);
 * the engine splits each token on `_` and applies the fields to the matching
 * child spec (ota.rs).
 *
 * The `posVolt`/`negVolt` supply fields default to the LM13700's +/-9 V and
 * are sent to the engine as ordinary params, which override the two rail
 * children's `maxVoltage`. They are deliberately not read from the file: the
 * composite dump has no dedicated supply tokens, the rails carry their
 * voltages inside the first two child dumps, and the engine applies the params
 * to those rails itself, so parsing them here would duplicate that work. They
 * are written back, though, whenever there are no carried tokens to re-emit
 * (otaChildTokens below), so a freshly placed OTA saves its real supplies.
 */

import {
  arrowHead,
  canvasFont,
  circle,
  closedPolyline,
  currentDots,
  dsign,
  elementLength,
  endpoints,
  interp,
  interp2,
  lead,
  line,
  powerColor,
  voltageColor,
} from '../../../render/draw';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';
import { bodyBox } from '../shared';

/** Symbol geometry constants, OTAElm.java:17-20. */
const OPHEIGHT = 32;
const OPWIDTH = 32;
const CIRC_DIAM = 19;
const CIRC_OVERLAP = 8;

/** The symbol's fixed total span: two opwidth bodies, two circles, less the
 *  circle overlap (OTAElm.java:97). */
const WTOT = OPWIDTH * 2 + 2 * CIRC_DIAM - CIRC_OVERLAP;

/** The points one of the two Iabc arrows spans, a third and two thirds of the
 *  way from the in3 lead to the input base (OTAElm.java:135-137). */
function arrowSpan(a: Point, b: Point): [Point, Point] {
  return [interp(a, b, 0.3333), interp(a, b, 0.6666)];
}

/** Body geometry, mirroring OTAElm.setPoints (OTAElm.java:94-149). The lead
 *  pair arrays are `[post, body]` in post order. */
export interface OtaGeometry {
  lead1: Point;
  lead2: Point;
  /** The output terminal: the far endpoint for a long part, else the
   *  extrapolated body end (OTAElm.java:100-107). */
  point2bis: Point;
  /** Post 0, the non-inverting input, and its triangle-base end. */
  in1: [Point, Point];
  /** Post 1, the inverting input, and its triangle-base end. */
  in2: [Point, Point];
  /** Post 2, the collector load on the west axis, and the body end. */
  in3: [Point, Point];
  /** Post 3, the Iabc bias pin, and its body end. */
  in4: [Point, Point];
  /** Centres of the plus and minus glyphs, inverting and non-inverting sides. */
  textp: [Point, Point];
  /** The triangle corners: base top, base bottom, apex (OTAElm.java:128-131). */
  triangle: [Point, Point, Point];
  /** Centres of the two output circles (OTAElm.java:132-133). */
  circCent: [Point, Point];
  /** The two arrow base bars, each `[one end, other]` (OTAElm.java:138). */
  bar1: [Point, Point];
  bar2: [Point, Point];
}

/** Body geometry for a part, shared by the posts and the drawing so the leads
 *  and the arrows track the same body. */
export function otaGeometry(e: CircuitElement): OtaGeometry {
  const [p1, p2] = endpoints(e);
  const dn = elementLength(e);
  // A short part leaves the body hanging past its far post; the leads and
  // posts still land on the axis they were dragged along (OTAElm.java:99-107).
  const lead1 = dn > WTOT ? interp(p1, p2, 1 - WTOT / dn, 0) : p1;
  const lead2 = dn > WTOT ? p2 : interp(p1, p2, WTOT / dn, 0);
  const point2bis = dn > WTOT ? p2 : lead2;
  const hs = OPHEIGHT * dsign(p1, p2);
  const in1: [Point, Point] = [interp(p1, point2bis, 0, hs), interp(lead1, lead2, 0, hs)];
  const in2: [Point, Point] = [interp(p1, point2bis, 0, -hs), interp(lead1, lead2, 0, -hs)];
  return {
    lead1,
    lead2,
    point2bis,
    in1,
    in2,
    in3: [p1, lead1],
    in4: [interp(lead1, lead2, 1 - 16 / WTOT, 32), interp(lead1, lead2, 1 - 16 / WTOT, 8)],
    textp: [interp(lead1, lead2, 0.1, hs), interp(lead1, lead2, 0.1, -hs)],
    triangle: [
      interp(lead1, lead2, 0, (3 * hs) / 2),
      interp(lead1, lead2, 0, -(3 * hs) / 2),
      interp(lead1, lead2, (2 * OPWIDTH) / WTOT, 0),
    ],
    circCent: [
      interp(lead1, lead2, 1 - CIRC_DIAM / (2 * WTOT), 0),
      interp(lead1, lead2, 1 - (3 * CIRC_DIAM - 2 * CIRC_OVERLAP) / (2 * WTOT), 0),
    ],
    // Each arrow's base bar sits at the arrow tip, a 4-unit perpendicular
    // straddle (OTAElm.java:138, :142). The arrow spans from the in3 body end
    // (lead1) to the matching input's triangle base (:135-137).
    bar1: interp2(...arrowSpan(lead1, in1[1]), 1, 4),
    bar2: interp2(...arrowSpan(lead1, in2[1]), 1, 4),
  };
}

/** The LM13700 supply defaults (OTAElm.java:29-30), also the `defaults` below. */
const DEF_POS_VOLT = 9;
const DEF_NEG_VOLT = -9;

/** The eighteen child dumps a freshly constructed upstream OTA would hold, in
 *  `modelString` order (OTAElm.java:8): two rails, then five N, six P and five
 *  more N transistors. `CompositeElm.loadComposite` calls `st.nextToken()`
 *  once per child (CompositeElm.java:85-91), so a 402 line that stops after
 *  the flags makes upstream throw and drop the element.
 *
 *  The two rails are the only tokens that are not constant: upstream reads
 *  negVolt back off child 0 and posVolt off child 1 (OTAElm.java:41-42), so
 *  they are re-derived from the params on every save, the crystal's pattern,
 *  and an edited supply voltage reaches the file. Rail token shape is
 *  `flags_waveform_frequency_maxVoltage_bias_phaseShift_dutyCycle`
 *  (VoltageElm.java:69-75); like OpAmpElm, VoltageElm has no text `dump()` in
 *  the current upstream checkout, but its reader takes all six fields in one
 *  `try` and the long form is what the real corpus lines carry
 *  (public/circuits/ota-gain.txt:2).
 *
 *  Transistor token shape is `flags_pnp_lastvbe_lastvbc_beta`
 *  (TransistorElm.java:58-68); junction state is zero on a fresh part and beta
 *  is 100, so the N children are `0_1_0_0_100` and the P children
 *  `0_-1_0_0_100`. */
const FRESH_N_TRANSISTOR = '0_1_0_0_100';
const FRESH_P_TRANSISTOR = '0_-1_0_0_100';

function railToken(v: number | undefined, fallback: number): string {
  // A param edited to NaN or wiped out of the file must not write `NaN` into
  // the token: upstream would parse it as a NaN supply and the rail would
  // never settle.
  const volts = v !== undefined && Number.isFinite(v) ? v : fallback;
  return `0_0_40_${volts}_0_0_0.5`;
}

function otaChildTokens(e: CircuitElement): string[] {
  return [
    railToken(e.params.negVolt, DEF_NEG_VOLT),
    railToken(e.params.posVolt, DEF_POS_VOLT),
    ...Array<string>(5).fill(FRESH_N_TRANSISTOR),
    ...Array<string>(6).fill(FRESH_P_TRANSISTOR),
    ...Array<string>(5).fill(FRESH_N_TRANSISTOR),
  ];
}

function otaPosts(e: CircuitElement): Point[] {
  const g = otaGeometry(e);
  return [g.in1[0], g.in2[0], g.in3[0], g.in4[0], g.point2bis];
}

function drawOta(g: DrawContext, e: CircuitElement): void {
  const geo = otaGeometry(e);
  // The body colour is a fixed neutral upstream, power-tinted when power mode
  // is on (OTAElm.java:69-70); `powerColor` degrades to the wire colour.
  const body = powerColor(g, g.power);

  // The four leads, post to body, each voltage-coloured (OTAElm.java:61-68).
  lead(g, geo.in1[0], geo.in1[1], voltageColor(g, g.voltages[0]));
  lead(g, geo.in2[0], geo.in2[1], voltageColor(g, g.voltages[1]));
  lead(g, geo.in3[0], geo.in3[1], voltageColor(g, g.voltages[2]));
  lead(g, geo.in4[0], geo.in4[1], voltageColor(g, g.voltages[3]));

  // The triangle outline, the two filled arrows and their base bars, then the
  // two output circles (OTAElm.java:71-77), all thick upstream.
  closedPolyline(g, [geo.triangle[0], geo.triangle[1], geo.triangle[2], geo.triangle[0]], body);
  const [a1, a2] = arrowSpan(geo.in3[1], geo.in1[1]);
  arrowHead(g, a1, a2, 8, body);
  line(g, geo.bar1[0], geo.bar1[1], body);
  const [b1, b2] = arrowSpan(geo.in3[1], geo.in2[1]);
  arrowHead(g, b1, b2, 8, body);
  line(g, geo.bar2[0], geo.bar2[1], body);
  circle(g, geo.circCent[0], CIRC_DIAM / 2, body, false);
  circle(g, geo.circCent[1], CIRC_DIAM / 2, body, false);

  // The plus rides the non-inverting side two pixels above its anchor, the
  // minus exactly on the inverting one (OTAElm.java:79-80).
  g.ctx.fillStyle = g.theme.text;
  g.ctx.font = canvasFont(14);  // plusFont, OTAElm.java:143
  g.ctx.textAlign = 'center';
  g.ctx.textBaseline = 'middle';
  g.ctx.fillText('+', geo.textp[0].x, geo.textp[0].y - 2);
  g.ctx.fillText('−', geo.textp[1].x, geo.textp[1].y);

  currentDots(g, geo.in1[0], geo.in1[1], g.current);
  currentDots(g, geo.in2[0], geo.in2[1], g.current);
  currentDots(g, geo.in3[0], geo.in3[1], g.current);
  currentDots(g, geo.in4[0], geo.in4[1], g.current);
}

export const OTA_DEF: ElementDef = {
  kind: 'ota',
  label: 'OTA',
  category: 'Active',
  dumpCode: '402',
  postCount: 5,
  posts: otaPosts,
  noDiagonal: true,  // OTAElm.java:34
  defaults: { posVolt: DEF_POS_VOLT, negVolt: DEF_NEG_VOLT },
  // The line is `... flags <child dump token>...`, one `_`-joined token per
  // composite child (CompositeElm.dump + dumpElements). The tokens are raw on
  // both sides, like the darlington's: upstream escapes them with the
  // composite FLAG_ESCAPE bit when it saves and the legacy corpus form joins
  // them with `_`, so running them through the netlist escape scheme would
  // corrupt either shape.
  rawTokens: true,
  parse: (t, e) => {
    // Every trailing token is one composite child's opaque dump, carried
    // verbatim into the engine's `spec.model` string carrier. The engine
    // parses them itself; the frontend stores the list and nothing else.
    e.model = t;
  },
  // A carried token list always wins, so a loaded file round-trips
  // byte-for-byte. The fallback is keyed on an empty list rather than on "is
  // this element fresh" so that a bare, already-broken `402 ... flags` line
  // gets repaired on the next save instead of staying unloadable upstream.
  dump: (e) => (Array.isArray(e.model) && e.model.length > 0 ? e.model : otaChildTokens(e)),
  fields: [
    { name: 'posVolt', label: 'Positive Supply Voltage', unit: 'V' },
    { name: 'negVolt', label: 'Negative Supply Voltage', unit: 'V' },
  ],
  // The triangle and the two output circles span the fixed body length at a
  // 3*opheight/2 = 48 half width, upstream's setBbox (OTAElm.java:60).
  bodyRect: (e) => bodyBox(e, WTOT, (3 * OPHEIGHT) / 2),
  draw: drawOta,
};
