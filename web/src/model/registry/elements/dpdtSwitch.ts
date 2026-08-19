/**
 * DPDT switch (DPDTSwitchElm.java, dump 429): `poleCount` poles (default 2,
 * clamped 2..=10) of double-throw switches sharing one ganged lever. Per
 * pole, the pole post sits at the first endpoint offset `-i*48` and the two
 * throws at the far end `-48` and `+48` from the pole
 * (DPDTSwitchElm.java:78-102, :166-172). Position 0 ties every pole to its
 * first throw, position 1 to its second; the drawing shows the ganged lever
 * line and the thrown lever per pole.
 *
 * The token layout is the SwitchElm base (`position momentary [label]`) then
 * `poleCount` (DPDTSwitchElm.java:38-45). `poleCount` is a post count, so it
 * normalizes to the engine's integer 2..=10 clamp on load and on edit.
 */

import {
  calcLeads,
  currentDots,
  endpoints,
  interp,
  lead,
  line,
  voltageColor,
} from '../../../render/draw';
import { SWITCH_IEC, SWITCH_LABEL } from '../flags';
import { OPEN_HS, rectOfPoints } from '../shared';
import { labelFlags, switchTokens } from './switch';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** The integer pole count the engine's `(x as usize)` cast derives from a
 *  value, clamped to the engine's 2..=10 range (dpdt_switch.rs): non-finite
 *  values and negatives saturate to 2, a fraction truncates toward zero. The
 *  store's setParam, the parsers and the geometry all normalise to this, so a
 *  fractional edit never draws a post list the engine's build rejects. */
export function normalizePoleCount(value: number): number {
  if (!Number.isFinite(value)) return 2;
  const n = Math.trunc(value);
  if (n < 2) return 2;
  if (n > 10) return 10;
  return n;
}

/** Perpendicular throw spacing between the poles (DPDTSwitchElm.java:89). */
const POLE_GAP = OPEN_HS * 3;

function dpdtPoles(e: CircuitElement): number {
  return normalizePoleCount(e.params.poleCount ?? 2);
}

/** Every point the symbol needs, recomputed once per draw
 *  (DPDTSwitchElm.setPoints, :78-102). Per pole the pole and its lead sit on
 *  the first endpoint at `-i*48`, the two throws at `-48` and `+48` from the
 *  pole on the far end; the lever tips are the position-0 throw lead and the
 *  position-1 throw lead. */
function dpdtGeometry(e: CircuitElement) {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = calcLeads(e, 32);
  const poles = dpdtPoles(e);
  const iec = (e.flags & SWITCH_IEC) !== 0;
  const polePosts: Point[] = [];
  const poleLeads: Point[] = [];
  const throwPosts: Point[] = [];
  const throwLeads: Point[] = [];
  for (let i = 0; i < poles; i++) {
    const offset = -i * POLE_GAP;
    polePosts.push(interp(p1, p2, 0, offset));
    poleLeads.push(interp(lead1, lead2, 0, offset));
    throwPosts.push(interp(p1, p2, 1, offset - OPEN_HS), interp(p1, p2, 1, offset + OPEN_HS));
    throwLeads.push(
      interp(lead1, lead2, 1, offset - OPEN_HS),
      interp(lead1, lead2, 1, offset + OPEN_HS),
      interp(lead1, lead2, 1, offset + OPEN_HS / 3),
      iec
        ? interp(lead1, lead2, 1.2, offset - OPEN_HS / 3)
        : interp(lead1, lead2, 1, offset - OPEN_HS),
    );
  }
  return { p1, p2, iec, poles, polePosts, poleLeads, throwPosts, throwLeads };
}

function drawDpdtSwitch(g: DrawContext, e: CircuitElement): void {
  const geo = dpdtGeometry(e);
  const position = (e.state ?? e.params.position ?? 0) === 1 ? 1 : 0;

  for (let i = 0; i < geo.poles; i++) {
    // Terminal leads per pole: the pole's own lead and the two throw leads
    // (DPDTSwitchElm.java:109-118).
    lead(g, geo.polePosts[i], geo.poleLeads[i], voltageColor(g, g.voltages[3 * i]));
    lead(
      g,
      geo.throwPosts[2 * i],
      geo.throwLeads[i * 4],
      voltageColor(g, g.voltages[3 * i + 1]),
    );
    if (geo.iec) {
      lead(
        g,
        geo.throwLeads[i * 4],
        geo.throwLeads[i * 4 + 2],
        voltageColor(g, g.voltages[3 * i + 1]),
      );
    }
    lead(
      g,
      geo.throwPosts[2 * i + 1],
      geo.throwLeads[i * 4 + 1],
      voltageColor(g, g.voltages[3 * i + 2]),
    );

    // The ganged lever line between adjacent poles, sliding with the throw
    // (DPDTSwitchElm.java:123-130), a plain drawLine so it stays fine.
    if (i < geo.poles - 1) {
      const offset = -i * POLE_GAP;
      const l0 = interp(
        geo.p1,
        geo.p2,
        0.5,
        offset - OPEN_HS * (0.5 - position) - 4 * position,
      );
      const l1 = interp(
        geo.p1,
        geo.p2,
        0.5,
        offset - OPEN_HS * 3 - OPEN_HS * (0.5 - position) + 3 + 8 * (1 - position),
      );
      g.ctx.setLineDash([4, 4]);
      line(g, l0, l1, g.theme.text, 1);
      g.ctx.setLineDash([]);
    }

    // The lever, thrown to the position's throw tip (DPDTSwitchElm.java:135),
    // in the mechanical-part white rather than the pole's voltage colour.
    line(g, geo.poleLeads[i], geo.throwLeads[i * 4 + 3 - position * 2], g.theme.whiteColor);

    // Current dots along the active throw (DPDTSwitchElm.java:138-140).
    currentDots(g, geo.polePosts[i], geo.poleLeads[i], g.current);
    currentDots(g, geo.throwLeads[i * 4 + position], geo.throwPosts[2 * i + position], g.current);
  }
}

export const DPDT_SWITCH_DEF: ElementDef = {
  kind: 'dpdtSwitch',
  label: 'DPDT switch',
  category: 'Basics',
  dumpCode: '429',
  postCountOf: (e) => 3 * dpdtPoles(e),
  postCount: 6, // the 2-pole default, for the fresh-part fallback
  posts: (e) => {
    const [p1, p2] = endpoints(e);
    const posts: Point[] = [];
    for (let i = 0; i < dpdtPoles(e); i++) {
      const offset = -i * POLE_GAP;
      posts.push(interp(p1, p2, 0, offset));
      posts.push(interp(p1, p2, 1, offset - OPEN_HS), interp(p1, p2, 1, offset + OPEN_HS));
    }
    return posts;
  },
  interactive: true,
  // The DPDT overrides flipX/flipY/flipXY (DPDTSwitchElm.java:256-277), so
  // Mirror is offered; the transform arm flips the throw position and shifts
  // the pole fan.
  canMirror: true,
  // The clickable bank spans the levers: the first pole's lead and the
  // extreme throws of the fan (DPDTSwitchElm.java:162-164). The box is the
  // tight union of the lever centrelines, no growth: the picker's 8-pixel
  // reach still covers the drawn stroke, so a margin would only grab clicks
  // the user aimed past the lever.
  switchRect: (e) => {
    const geo = dpdtGeometry(e);
    const last = geo.poles * 4 - 4;
    return rectOfPoints([geo.poleLeads[0], geo.throwLeads[1], geo.throwLeads[last]]);
  },
  noDiagonal: true, // every DPDTSwitchElm constructor sets it
  defaults: { position: 0, momentary: 0, poleCount: 2, resistance: 0 },
  // The token layout is SwitchElm's base then the poleCount
  // (DPDTSwitchElm.java:38-45); the label, when present, shifts the count one
  // token along.
  parse: (t, e) => {
    const p = t[0];
    e.params.position = p === 'true' ? 1 : p === 'false' ? 0 : Number(p) || 0;
    e.params.momentary = t[1] === 'true' ? 1 : 0;
    let i = 2;
    if ((e.flags & SWITCH_LABEL) !== 0 && t[i] !== undefined) e.text = t[i++];
    const pc = Number(t[i]);
    e.params.poleCount = Number.isFinite(pc) ? normalizePoleCount(pc) : 2;
    e.state = e.params.position;
  },
  dump: (e) => [...switchTokens(e), e.params.poleCount ?? 2],
  dumpFlags: labelFlags,
  fields: [
    { name: 'poleCount', label: '# of Poles' },
    { name: 'iec', label: 'IEC Symbol', type: 'bool', flag: SWITCH_IEC },
    { name: 'resistance', label: 'On Resistance', unit: 'Ω' },
    { name: 'keyShortcut', label: 'Keyboard Shortcut', type: 'text', target: 'keyShortcut' },
  ],
  draw: drawDpdtSwitch,
};
