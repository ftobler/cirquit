/**
 * Make-before-break switch (MBBSwitchElm.java, dump 416): a three-post switch
 * with four positions, 0 = pole A only, 1 = both, 2 = pole B only, 3 = both.
 * The common post sits at the first dragged point; the two throws hang off
 * the far end at ±16 perpendicular (MBBSwitchElm.java:63-81, :127-129). The
 * lever draws to both throws whenever `both` is true, the make-before-break
 * symbol.
 *
 * The token layout is the SwitchElm base (`position momentary [label]`) then
 * `link`, the numeric switch group (MBBSwitchElm.java:44-49). Toggling one
 * MBB with a nonzero link sets every MBB with the same link to the same
 * position, the propagation upstream runs in `toggle()` over its whole
 * element list (MBBSwitchElm.java:182-195).
 */

import { calcLeads, currentDots, endpoints, interp, lead, line, voltageColor } from '../../../render/draw';
import { SWITCH_LABEL } from '../flags';
import { CONTACT_STROKE_WIDTH, OPEN_HS, rectOfPoints } from '../shared';
import { labelFlags, switchTokens } from './switch';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Every point the symbol needs, recomputed once per draw
 *  (MBBSwitchElm.setPoints, :63-81). The pole is the common post at `point1`;
 *  the throws fan out at ±16 perpendicular of the far end, and the lever
 *  poles ride the same offsets on the lead frame. */
function mbbGeometry(e: CircuitElement) {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = calcLeads(e, 32);
  const swpoles: Point[] = [];
  const swposts: Point[] = [];
  for (let i = 0; i < 2; i++) {
    // The first throw is the special case: the formula's `-openhs*(i-0)`
    // would put throw 0 on the axis, so it is pinned to +openhs instead
    // (MBBSwitchElm.java:71-74).
    const hs = i === 0 ? OPEN_HS : -OPEN_HS;
    swpoles.push(interp(lead1, lead2, 1, hs));
    swposts.push(interp(p1, p2, 1, hs));
  }
  return { p1, lead1, swpoles, swposts };
}

function drawMbbSwitch(g: DrawContext, e: CircuitElement): void {
  const geo = mbbGeometry(e);
  const position = (e.state ?? e.params.position ?? 0) % 4;
  const both = position === 1 || position === 3;

  // The common lead, then one lead per throw (MBBSwitchElm.java:88-97).
  lead(g, geo.p1, geo.lead1, voltageColor(g, g.voltages[0]));
  for (let i = 0; i < 2; i++) {
    lead(g, geo.swpoles[i], geo.swposts[i], voltageColor(g, g.voltages[i + 1]));
  }

  // The lever reaches the first throw when it conducts, the second when that
  // does, and both at once in the make-before-break positions
  // (MBBSwitchElm.java:99-105).
  if (both || position === 0) {
    line(g, geo.lead1, geo.swpoles[0], g.theme.whiteColor, CONTACT_STROKE_WIDTH);
  }
  if (both || position === 2) {
    line(g, geo.lead1, geo.swpoles[1], g.theme.whiteColor, CONTACT_STROKE_WIDTH);
  }

  // Current dots on each conducting throw and the common run
  // (MBBSwitchElm.java:107-113). The common run carries both pole currents,
  // matching the engine's `base.current`.
  for (let i = 0; i < 2; i++) {
    if (both || position === i * 2) {
      currentDots(g, geo.swpoles[i], geo.swposts[i], g.current);
    }
  }
  currentDots(g, geo.p1, geo.lead1, g.current);
}

export const MBB_SWITCH_DEF: ElementDef = {
  kind: 'mbbSwitch',
  label: 'Make-before-break switch',
  category: 'Basics',
  dumpCode: '416',
  postCount: 3,
  posts: (e) => {
    const [p1, p2] = endpoints(e);
    const posts: Point[] = [p1];
    for (let i = 0; i < 2; i++) {
      const hs = i === 0 ? OPEN_HS : -OPEN_HS;
      posts.push(interp(p1, p2, 1, hs));
    }
    return posts;
  },
  interactive: true,
  // The clickable region spans the lever fan: the pivot lead and both throw
  // poles (MBBSwitchElm.java:123-125), grown by one contact stroke width.
  switchRect: (e) => {
    const geo = mbbGeometry(e);
    const rect = rectOfPoints([geo.lead1, geo.swpoles[0], geo.swpoles[1]]);
    const m = CONTACT_STROKE_WIDTH;
    return { x: rect.x - m, y: rect.y - m, w: rect.w + 2 * m, h: rect.h + 2 * m };
  },
  noDiagonal: true, // MBBSwitchElm.java:38
  defaults: { position: 0, momentary: 0, link: 0, resistance: 0 },
  // The token layout is SwitchElm's base then the link (MBBSwitchElm.java:
  // 44-49); the label, when present, shifts the link one token along.
  parse: (t, e) => {
    const p = t[0];
    e.params.position = p === 'true' ? 1 : p === 'false' ? 0 : Number(p) || 0;
    e.params.momentary = t[1] === 'true' ? 1 : 0;
    let i = 2;
    if ((e.flags & SWITCH_LABEL) !== 0 && t[i] !== undefined) e.text = t[i++];
    e.params.link = Number(t[i]) || 0;
    e.state = e.params.position;
  },
  dump: (e) => [...switchTokens(e), e.params.link ?? 0],
  dumpFlags: labelFlags,
  fields: [
    { name: 'link', label: 'Switch Group' },
    { name: 'resistance', label: 'On Resistance', unit: 'Ω' },
    { name: 'keyShortcut', label: 'Keyboard Shortcut', type: 'text', target: 'keyShortcut' },
  ],
  draw: drawMbbSwitch,
};
