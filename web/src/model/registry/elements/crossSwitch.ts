/**
 * Cross switch (CrossSwitchElm.java, dump 430): a double-pole switch whose
 * two levers cross when thrown. Straight through at position 0 the posts pair
 * (0,1) and (2,3); crossed at position 1 they pair (0,3) and (2,1). The
 * terminal geometry comes from upstream's setPoints: both poles hang off the
 * first dragged point, 48 units apart, and the throws sit 16 and 64 units off
 * the axis past the far end, where the cross network turns them into the X.
 */

import {
  calcLeads,
  circle,
  currentDots,
  currentDotsPath,
  elementLength,
  endpoints,
  interp,
  lead,
  line,
  voltageColor,
} from '../../../render/draw';
import { SWITCH_IEC, SWITCH_LABEL } from '../flags';
import { rectOfPoints } from '../shared';
import { switchTokens, labelFlags, momentaryParam } from './switch';
import type { CircuitElement, DrawContext, ElementDef, Point } from '../../types';

/** Perpendicular offset of a throw, upstream's `openhs` (CrossSwitchElm.java:40). */
const OPEN_HS = 16;
/** The 3*openhs spacing between the two pole pairs (CrossSwitchElm.java:69). */
const POLE_GAP = 48;

/** The four circuit posts, in upstream's `getPost` order
 *  (CrossSwitchElm.java:178-184): the two poles at the first endpoint, the
 *  throws at `1 + 3*16/dn` of the span, just past the far end. */
function crossSwitchPosts(e: CircuitElement): Point[] {
  const [p1, p2] = endpoints(e);
  const dn = elementLength(e);
  const dp = dn > 0 ? OPEN_HS / dn : 0;
  return [
    interp(p1, p2, 0, 0),
    interp(p1, p2, 1 + 3 * dp, OPEN_HS),
    interp(p1, p2, 0, -POLE_GAP),
    interp(p1, p2, 1 + 3 * dp, -OPEN_HS * 4),
  ];
}

/** Every point the symbol needs, recomputed once per draw
 *  (CrossSwitchElm.setPoints, :57-89). */
function crossSwitchGeometry(e: CircuitElement) {
  const [p1, p2] = endpoints(e);
  const [lead1, lead2] = calcLeads(e, 32);
  const dn = elementLength(e);
  const dp = dn > 0 ? OPEN_HS / dn : 0;
  const iec = (e.flags & SWITCH_IEC) !== 0;

  const polePosts: Point[] = [];
  const poleLeads: Point[] = [];
  const throwPosts: Point[] = [];
  const throwLeads: Point[] = [];
  // The lever tip for each pole, indexed by position: the straight throw's
  // lead at position 0, the crossed throw's at position 1
  // (CrossSwitchElm.java:134). The position-0 tip extends to fraction 1.2 of
  // the leads under the IEC symbol.
  const leverTips: [Point, Point][] = [];
  for (let i = 0; i < 2; i++) {
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
    leverTips.push([throwLeads[i * 4 + 3], throwLeads[i * 4 + 1]]);
  }
  // The cross network past the far end (CrossSwitchElm.java:82-88): a
  // diagonal whose two ends are posts 1 and 3.
  const cross = [
    interp(p1, p2, 1 + dp, OPEN_HS),
    interp(p1, p2, 1 + 2 * dp, OPEN_HS),
    interp(p1, p2, 1 + 3 * dp, OPEN_HS),
    interp(p1, p2, 1 + 2 * dp, -OPEN_HS),
    interp(p1, p2, 1 + dp, -OPEN_HS * 4),
    interp(p1, p2, 1 + 3 * dp, -OPEN_HS * 4),
  ];

  const position = (e.state ?? e.params.position ?? 0) === 1 ? 1 : 0;
  // The dashed mechanical link between the two levers, sliding with the lever
  // (CrossSwitchElm.java:121-129).
  const linePoints = [
    interp(p1, p2, 0.5, -8 + 13 * position),
    interp(p1, p2, 0.5, -49 + 13 * position),
  ];

  return { p1, p2, iec, polePosts, poleLeads, throwPosts, throwLeads, leverTips, cross, linePoints };
}

function drawCrossSwitch(g: DrawContext, e: CircuitElement): void {
  const geo = crossSwitchGeometry(e);
  const position = (e.state ?? e.params.position ?? 0) === 1 ? 1 : 0;

  // Post 1's network: the top-right post's lead runs down the right diagonal
  // to the pole-0 throw (CrossSwitchElm.java:97-101).
  const v1 = voltageColor(g, g.voltages[1]);
  lead(g, geo.cross[1], geo.cross[2], v1);
  lead(g, geo.cross[1], geo.cross[3], v1);
  lead(g, geo.cross[3], geo.throwPosts[0], v1);
  lead(g, geo.throwPosts[0], geo.throwPosts[3], v1);

  // Post 3's network: the bottom-right post's lead up to the pole-1 throw
  // (CrossSwitchElm.java:102-105).
  const v3 = voltageColor(g, g.voltages[3]);
  lead(g, geo.throwPosts[2], geo.cross[5], v3);
  lead(g, geo.throwPosts[1], geo.cross[0], v3);
  lead(g, geo.cross[0], geo.cross[4], v3);

  for (let i = 0; i < 2; i++) {
    // The terminal leads, each in its own terminal's voltage colour.
    lead(g, geo.polePosts[i], geo.poleLeads[i], voltageColor(g, g.voltages[2 * i]));
    lead(g, geo.throwPosts[2 * i], geo.throwLeads[i * 4], voltageColor(g, g.voltages[2 * i + 1]));
    lead(
      g,
      geo.throwPosts[2 * i + 1],
      geo.throwLeads[i * 4 + 1],
      voltageColor(g, g.voltages[3 - 2 * i]),
    );
    if (geo.iec) {
      lead(g, geo.throwLeads[i * 4], geo.throwLeads[i * 4 + 2], voltageColor(g, g.voltages[2 * i + 1]));
    }

    // The dashed link between the levers, drawn once with the first pole
    // (CrossSwitchElm.java:121-129). Upstream strokes it with a plain
    // `g.drawLine`, so it stays at fine width 1 while the levers draw thick.
    if (i === 0) {
      g.ctx.setLineDash([4, 4]);
      line(g, geo.linePoints[0], geo.linePoints[1], g.theme.text, 1);
      g.ctx.setLineDash([]);
    }

    // The lever, at the straight throw in position 0 and the crossed throw in
    // position 1 (CrossSwitchElm.java:134), in the mechanical-part white
    // (CrossSwitchElm.java:131-134) rather than the pole's voltage colour.
    line(g, geo.poleLeads[i], geo.leverTips[i][position], g.theme.whiteColor);

    // Current dots along the active throw (CrossSwitchElm.java:137-139).
    currentDotsPath(
      g,
      [geo.polePosts[i], geo.poleLeads[i], geo.throwLeads[i * 4 + position], geo.throwPosts[i * 2 + position]],
      g.current,
    );
  }

  // The crossing network's runs, only on the route the position conducts
  // (CrossSwitchElm.java:140-151).
  if (position === 1) {
    currentDotsPath(g, [geo.throwPosts[1], geo.cross[0], geo.cross[4], geo.cross[5]], g.current);
    currentDots(g, geo.throwPosts[3], geo.throwPosts[0], g.current);
  } else {
    currentDots(g, geo.throwPosts[2], geo.cross[5], g.current);
  }
  currentDotsPath(g, [geo.throwPosts[0], geo.cross[3], geo.cross[1], geo.cross[2]], g.current);

  // The two interior junction dots upstream draws with drawPost
  // (CrossSwitchElm.java:155-156), which the central junction pass does not
  // know about because they are not circuit posts.
  circle(g, geo.throwPosts[0], 3.5, g.theme.wire, true);
  circle(g, geo.cross[4], 3.5, g.theme.wire, true);
}

export const CROSS_SWITCH_DEF: ElementDef = {
  kind: 'crossSwitch',
  label: 'Cross switch',
  category: 'Basics',
  dumpCode: '430',
  postCount: 4,
  posts: crossSwitchPosts,
  interactive: true,
  // The clickable bank spans both levers: each pole's lead plus both its lever
  // tips, so the second lever's pivot and throws read as clickable. Upstream's
  // union of pole 0's lead and the extreme throws (CrossSwitchElm.java:
  // 174-176) already spans the second lever's envelope, but the IEC symbol's
  // position-0 tips reach fraction 1.2, past the throws, so the lever tips
  // widen the box where it genuinely missed.
  switchRect: (e) => {
    const geo = crossSwitchGeometry(e);
    return rectOfPoints([
      geo.poleLeads[0],
      geo.poleLeads[1],
      geo.leverTips[0][0],
      geo.leverTips[0][1],
      geo.leverTips[1][0],
      geo.leverTips[1][1],
    ]);
  },
  noDiagonal: true, // every CrossSwitchElm constructor sets it
  defaults: { position: 0, momentary: 0 },
  // The token layout is SwitchElm's: position (an int or a literal
  // `true`/`false`), momentary as a literal `true`/`false`, then the label
  // under FLAG_LABEL (SwitchElm.java:53-68).
  parse: (t, e) => {
    const p = t[0];
    e.params.position = p === 'true' ? 1 : p === 'false' ? 0 : Number(p) || 0;
    e.params.momentary = momentaryParam(t[1]);
    if ((e.flags & SWITCH_LABEL) !== 0 && t[2] !== undefined) e.text = t[2];
    e.state = e.params.position;
  },
  dump: switchTokens,
  dumpFlags: labelFlags,
  // The keyboard shortcut is session-only: it never appears in the netlist,
  // only in the Options panel and the keydown matcher.
  fields: [{ name: 'keyShortcut', label: 'Keyboard Shortcut', type: 'text', target: 'keyShortcut' }],
  draw: drawCrossSwitch,
};
