import {
  calcLeads,
  currentDotsPath,
  drawLeads,
  endpoints,
  formatValue,
  gradientPolyline,
  interp,
  label,
  rectCorners,
  zigzagPoints,
} from '../../../render/draw';
import { readParams, twoPosts } from '../shared';
import type { CircuitElement, DrawContext, ElementDef } from '../../types';

/** Half-height of the thermistor's resistor body, both the euro box and the
 *  American zigzag peaks: upstream uses the single `hs = 6` for both
 *  (ThermistorNTCElm.java:134). */
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
 * temperature-sensitive, both shading along the voltage drop like the plain
 * resistor (ThermistorNTCElm.java:130-169, whose gradient is this shape's
 * model). The accent is a sub-shape of the body, so it samples the ramp at its
 * own position along the `lead1`-`lead2` axis, which is also why the axis must
 * be passed explicitly: the accent's own chord is parallel to, not on, the
 * body axis. Upstream's local coordinates run from `0` at `lead1` to `len` at
 * `lead2` along the axis and `hs` perpendicular to it; `interp`'s
 * fraction/offset pair is that same local frame, except `interp`'s `+g` is
 * upstream's `-hs` (this port's perpendicular unit vector is the negation of
 * upstream's), so the offsets below are negated relative to upstream's literal
 * `moveTo`/`lineTo` triple to land on the same pixels.
 */
function drawThermistorBody(g: DrawContext, e: CircuitElement): void {
  const [lead1, lead2] = calcLeads(e, 32);
  drawLeads(g, e, lead1, lead2);
  // Deliberate divergence from upstream: ThermistorNTCElm.java:144 sets its
  // gradient unconditionally, no volts-check guard and no power `else`, so
  // the body draws white under Show-Voltage-off. Here `axisColor` falls back
  // to the flat power colour instead, matching `elementColor` everywhere else
  // and the resistor's own upstream else branch. Do not "fix" it upstreamward.
  if (g.euroResistors) {
    // The box axis must be given explicitly: a closed path's last point
    // repeats the first, so its own chord is zero.
    const corners = rectCorners(lead1, lead2, THERMISTOR_HS);
    gradientPolyline(g, [corners[0], corners[1], corners[2], corners[3], corners[0]], {
      axis: [lead1, lead2],
    });
  } else {
    // The zigzag uses the same `hs` as the box, upstream's single hs=6
    // (ThermistorNTCElm.java:134).
    gradientPolyline(g, zigzagPoints(lead1, lead2, THERMISTOR_HS));
  }
  const len = Math.hypot(lead2.x - lead1.x, lead2.y - lead1.y);
  if (len > 0) {
    const hs = THERMISTOR_HS;
    const accent = [
      interp(lead1, lead2, -hs / len, -hs * 2),
      interp(lead1, lead2, hs / len, -hs * 2),
      interp(lead1, lead2, 1, hs * 2),
    ];
    // The temperature accent, thick like the body (ThermistorNTCElm.java:142).
    gradientPolyline(g, accent, { axis: [lead1, lead2] });
  }
  const [p1, p2] = endpoints(e);
  currentDotsPath(g, [p1, lead1, lead2, p2], g.current);
  label(
    g,
    e,
    `${thermistorTemperature(e)}°C = ${formatValue(thermistorResistance(e), 'Ω', g.valueDigits)}`,
  );
}

export const THERMISTOR_DEF: ElementDef = {
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
};
